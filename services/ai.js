// services/ai.js — server-side AI. System prompts live HERE, never in the browser,
// so the endpoint can't be used as an open proxy and the API key never leaves the server.
const env  = require('../config/env');
const User = require('../models/User');

const FEATURES = {
  'support-chat': {
    premium: false, maxTokens: 600, chat: true,
    system: `You are the Aurelance Support assistant. Aurelance is a freelance marketplace built around trust:
- Jobs board: clients post jobs (or paid trial tasks); freelancers apply alone or as a Squad (2–5 people).
- No-ghosting rule: every application shows Viewed / Shortlisted / Declined; a client's response rate shows on their jobs; jobs left unanswered for 14 days close automatically.
- Client report cards: freelancers rate clients on paying on time, respecting scope, communication and respect; plus measured stats (days to pay after approval, disputes).
- Contracts: milestones both sides sign; once signed the scope is locked and extra work goes through priced change requests. Freelancers deliver, clients approve, clients mark paid with a reference, freelancers confirm receipt. Money moves directly (bank, Payoneer, Wise); Aurelance keeps the record.
- Payout methods (Settings → Payouts): bank (IBAN checked), Payoneer, Wise, Visa/Mastercard (last 4 only). Verified after the identity check, with the name matched; details are encrypted and only shared on a contract the freelancer chooses.
- Scam shield: flags posts and messages that ask to move off-platform, pay fees upfront, or share ID/banking secrets; one-tap report.
- Reviews are double-blind: revealed when both are in or after 14 days.
Plans: Free and Premium (Billing page, paid via Safepay).
Keep answers under 150 words, practical and specific. If something needs account access, ask the user to open a support ticket. Never invent prices, features or data.`,
  },
  'job-post': {
    premium: false, maxTokens: 700,
    system: 'You help clients write clear freelance job posts. From the notes given, write: a one-line title on the first line, then a description with sections "What you\'ll do", "What done looks like", "Must have", and "How to apply" (ask applicants one specific question). Plain text, no markdown headings symbols beyond the section names, under 260 words. Never ask for contact details, fees or personal documents.',
  },
  'cover-letter': {
    premium: false, maxTokens: 500,
    system: 'You write short, specific freelance applications. Using the job and the freelancer\'s profile, write 110–170 words: open with the client\'s actual problem, show one relevant piece of past work from the profile (never invent experience), propose a first milestone with what will be delivered, and end with one clarifying question. No greetings like "Dear Hiring Manager", no clichés.',
  },
  'milestone-plan': {
    premium: false, maxTokens: 700, json: true,
    system: 'You split freelance work into fair, checkable milestones. Return ONLY valid JSON: {"milestones":[{"title":"...","scope":"what done means, testable","share":N}]} with 2–5 milestones whose "share" values (percent of the total budget) add up to 100. Front-load nothing: the first milestone should be small enough to build trust.',
  },
  'profile-review': {
    premium: true, maxTokens: 500,
    system: 'You are a senior freelance career coach. Give 4–5 specific, actionable improvements for this freelancer profile as bullet points (•), aimed at winning clients on a marketplace where clients compare report cards, verified payouts and squads. Be direct and concrete. Max 200 words.',
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
