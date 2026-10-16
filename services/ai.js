// services/ai.js — server-side AI. System prompts live HERE, never in the browser,
// so the endpoint can't be used as an open proxy and the API key never leaves the server.
const env  = require('../config/env');
const User = require('../models/User');

const FEATURES = {
  'support-chat': {
    premium: false, maxTokens: 600, chat: true,
    system: `You are the Aurelance Support assistant. Aurelance is a back office for freelancers: clients (CRM), invoices, a Kanban task board with time tracking, a Connections network with chat, and Atelier (rate calculator, time tracker, expense tracker, quick notes, brand kit, project estimator, email templates, and Premium tools: earnings analytics, smart contracts, proposal builder, tax summary).
Plans: Free and Premium. Premium is bought on the Billing page (sidebar → Billing) and is paid through Safepay.
Keep answers under 150 words, practical and specific. If something needs account access, ask the user to open a support ticket from the Support page. Never invent prices, features, or data.`,
  },
  'advisor-chat': {
    premium: false, maxTokens: 500, chat: true,
    system: 'You are a sharp, direct freelance business advisor inside Aurelance. The first user message contains the freelancer\'s live numbers. Give direct, specific advice in 2–4 sentences, citing their numbers. No filler.',
  },
  'daily-briefing': {
    premium: false, maxTokens: 350,
    system: 'You are a freelance business coach. Write a crisp daily briefing. One greeting sentence, then 3–5 bullet points using • covering: top priority action, biggest financial risk, key deadlines, one growth action. Max 110 words. Use only the numbers provided.',
  },
  'rate-advisor': {
    premium: false, maxTokens: 300,
    system: 'You are a freelance pricing expert. Give a specific hourly rate recommendation. Format: one sentence summary, then "Recommended rate: $X–$Y/hr", then 2–3 bullet points (•) explaining why, citing their numbers. Under 90 words.',
  },
  'daily-focus': {
    premium: true, maxTokens: 200,
    system: 'You are a freelance productivity coach. Give a personalised daily focus in exactly 2 sentences. Be direct and specific and cite the numbers provided. No generic advice.',
  },
  'health-score': {
    premium: true, maxTokens: 300, json: true,
    system: 'You are a freelance business analyst. Score this business across 6 dimensions from 0 to 100. Return ONLY valid JSON, no markdown: {"revenue":N,"clients":N,"productivity":N,"cashflow":N,"growth":N,"risk":N,"summary":"one specific sentence about their biggest opportunity"}',
  },
  'client-insight': {
    premium: true, maxTokens: 600, json: true,
    system: 'You are a senior business consultant analysing a freelancer–client relationship. Return ONLY valid JSON with keys: summary (2 sentences), risks (array of up to 3 short strings), actions (array of up to 3 actionable strings), sentiment ("positive" | "neutral" | "negative"). Be direct and specific.',
  },
  'profile-review': {
    premium: true, maxTokens: 500,
    system: 'You are a senior freelance career coach. Give 4–5 specific, actionable improvements for this freelancer profile as bullet points (•). Be direct and concrete. Max 200 words.',
  },
};

const today = () => new Date().toISOString().slice(0, 10);

/** Atomically count one AI request against today's quota. Returns remaining or throws 429. */
async function consumeQuota(user) {
  const limit = user.effectivePlan === 'premium' ? env.AI_DAILY_LIMIT_PREMIUM : env.AI_DAILY_LIMIT_FREE;
  const day = today();
  // New day → reset to 1. Each updateOne is atomic, so parallel requests can't exceed the limit.
  const reset = await User.updateOne({ _id: user._id, 'aiUsage.day': { $ne: day } }, { $set: { 'aiUsage.day': day, 'aiUsage.count': 1 } });
  if (reset.modifiedCount) return { used: 1, limit };
  const inc = await User.updateOne(
    { _id: user._id, 'aiUsage.day': day, 'aiUsage.count': { $lt: limit } },
    { $inc: { 'aiUsage.count': 1 } },
  );
  if (!inc.modifiedCount) {
    throw Object.assign(new Error(user.effectivePlan === 'premium'
      ? `You've used today's ${limit} AI requests. The limit resets at midnight UTC.`
      : `You've used today's ${limit} free AI requests. Premium raises this to ${env.AI_DAILY_LIMIT_PREMIUM} a day.`), { statusCode: 429, code: 'AI_QUOTA' });
  }
  const fresh = await User.findById(user._id).select('aiUsage').lean();
  return { used: fresh?.aiUsage?.count || 0, limit };
}

function buildMessages(feature, input, history) {
  const msgs = [];
  if (feature.chat && Array.isArray(history)) {
    for (const m of history.slice(-12)) {
      if (!m || !['user', 'assistant'].includes(m.role)) continue;
      const content = String(m.content || '').slice(0, 2000);
      if (content) msgs.push({ role: m.role, content });
    }
  }
  msgs.push({ role: 'user', content: String(input || '').slice(0, 6000) });
  // Anthropic requires alternating roles starting with user.
  while (msgs.length && msgs[0].role !== 'user') msgs.shift();
  const merged = [];
  for (const m of msgs) {
    if (merged.length && merged[merged.length - 1].role === m.role) merged[merged.length - 1].content += `\n\n${m.content}`;
    else merged.push({ ...m });
  }
  return merged;
}

async function complete(featureKey, { input, history, context }) {
  const feature = FEATURES[featureKey];
  if (!feature) throw Object.assign(new Error('Unknown AI feature'), { statusCode: 400 });
  if (!env.features.ai) throw Object.assign(new Error('AI is not configured on the server yet (ANTHROPIC_API_KEY).'), { statusCode: 503, code: 'AI_DISABLED' });

  const system = context ? `${feature.system}\n\nContext about this user's workspace:\n${String(context).slice(0, 3000)}` : feature.system;

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 30000);
  let res;
  try {
    res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({ model: env.ANTHROPIC_MODEL, max_tokens: feature.maxTokens, system, messages: buildMessages(feature, input, history) }),
      signal: ctrl.signal,
    });
  } catch (err) {
    throw Object.assign(new Error(err.name === 'AbortError' ? 'The AI took too long to answer. Try again.' : 'Could not reach the AI service.'), { statusCode: 504 });
  } finally { clearTimeout(timer); }

  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = data?.error?.message || `AI service error (${res.status})`;
    throw Object.assign(new Error(res.status === 429 ? 'The AI service is busy. Try again in a moment.' : msg), { statusCode: res.status === 429 ? 503 : 502 });
  }
  const text = (data.content || []).map((b) => b.text || '').join('').trim();

  if (feature.json) {
    const cleaned = text.replace(/```json|```/g, '').trim();
    const start = cleaned.indexOf('{');
    const end = cleaned.lastIndexOf('}');
    try { return { text: cleaned, json: JSON.parse(cleaned.slice(start, end + 1)) }; } catch { return { text: cleaned, json: null }; }
  }
  return { text };
}

module.exports = { FEATURES, complete, consumeQuota };
