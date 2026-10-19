// routes/public.js — what anyone can see without an account.
//   GET /api/public/u/:handle          public profile (no contact details, ever)
//   GET /api/public/img/:id            portfolio image
//   GET /api/public/share/u/:handle    the app's index.html with this person's title/description/OG tags,
//                                      so links pasted into WhatsApp, LinkedIn or X show a real preview.
//                                      The frontend rewrites /u/:handle here (see vercel.json).
const router = require('express').Router();
const crypto = require('crypto');
const rateLimit = require('express-rate-limit');
const User = require('../models/User');
const PortfolioImage = require('../models/PortfolioImage');
const env = require('../config/env');
const profiles = require('../services/profiles');
const { optionalAuth } = require('../middleware/auth');
const { asyncHandler, notFound } = require('../utils/http');
const { isId } = require('../utils/sanitize');

const publicLimit = rateLimit({ windowMs: 60e3, limit: 120, standardHeaders: 'draft-7', legacyHeaders: false, message: { error: 'Slow down a little.' } });
router.use(publicLimit);

const visitorKey = (req) => (req.user ? String(req.user._id) : `ip:${crypto.createHash('sha256').update(`${req.ip}|${env.JWT_SECRET}`).digest('hex').slice(0, 24)}`);

async function findByHandle(handle) {
  const h = String(handle || '').toLowerCase();
  if (!/^[a-z0-9-]{3,30}$/.test(h)) return null;
  return User.findOne({ handle: h, discoverable: { $ne: false } });
}

async function publicProfile(user) {
  const [reviews, history, squads] = await Promise.all([
    profiles.reviewsFor(user._id), profiles.workHistory(user._id), profiles.activeSquads(user._id),
  ]);
  const pub = user.toPublic();
  delete pub.email; delete pub.phone;
  return {
    ...pub,
    projects: (pub.projects || []).map((p) => ({ ...(p.toObject ? p.toObject() : p), images: (p.images || []).map((id) => ({ id, url: profiles.imageUrl(id) })) })),
    reviews, history, squads,
    strength: profiles.strength(user).score,
  };
}

router.get('/u/:handle', optionalAuth, asyncHandler(async (req, res) => {
  const user = await findByHandle(req.params.handle);
  if (!user) throw notFound('No public profile at this address');
  profiles.recordView(user._id, visitorKey(req), req.user ? 'app' : 'public');
  res.setHeader('Cache-Control', 'private, max-age=60');
  res.json({ profile: await publicProfile(user), viewerId: req.user?._id || null });
}));

router.get('/img/:id', asyncHandler(async (req, res) => {
  if (!isId(req.params.id)) throw notFound('Image not found');
  const img = await PortfolioImage.findById(req.params.id).select('+data').lean();
  if (!img) throw notFound('Image not found');
  const data = Buffer.isBuffer(img.data) ? img.data : Buffer.from(img.data.buffer || img.data);
  res.setHeader('Content-Type', img.type);
  res.setHeader('Content-Length', data.length);
  res.setHeader('Cache-Control', 'public, max-age=2592000, immutable');
  res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.end(data);
}));

// ── Share previews ─────────────────────────────────────────────────────
let shell = { html: '', at: 0 };
async function appShell() {
  if (shell.html && Date.now() - shell.at < 10 * 60e3) return shell.html;
  const r = await fetch(`${env.CLIENT_URL}/index.html`, { headers: { 'User-Agent': 'aurelance-share' } });
  if (!r.ok) throw new Error(`index.html ${r.status}`);
  shell = { html: await r.text(), at: Date.now() };
  return shell.html;
}
const esc = (s) => String(s || '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
function setMeta(html, attr, key, value) {
  const re = new RegExp(`<meta\\s+${attr}="${key}"[^>]*>`, 'i');
  const tag = `<meta ${attr}="${key}" content="${esc(value)}" />`;
  return re.test(html) ? html.replace(re, tag) : html.replace('</head>', `${tag}</head>`);
}

router.get('/share/u/:handle', asyncHandler(async (req, res) => {
  const user = await findByHandle(req.params.handle);
  const url = `${env.CLIENT_URL}/u/${encodeURIComponent(req.params.handle)}`;
  let html;
  try { html = await appShell(); } catch { return res.redirect(302, url); }
  if (user) {
    const f = user.reputation?.asFreelancer || {};
    const facts = [
      user.identity?.status === 'approved' ? 'ID verified' : '',
      f.completed ? `${f.completed} contract${f.completed > 1 ? 's' : ''} finished` : '',
      f.onTimeRate !== null && f.onTimeRate !== undefined ? `${f.onTimeRate}% on time` : '',
      f.quality ? `${f.quality}/5 from clients` : '',
      user.location || '',
    ].filter(Boolean).join(' · ');
    const title = `${user.name}${user.title ? ` — ${user.title}` : ''} · Aurelance`;
    const desc = `${facts || 'Freelancer on Aurelance'}. ${String(user.bio || '').slice(0, 140)}`.trim();
    html = html.replace(/<title>[^<]*<\/title>/i, `<title>${esc(title)}</title>`);
    html = setMeta(html, 'name', 'description', desc);
    html = setMeta(html, 'property', 'og:title', title);
    html = setMeta(html, 'property', 'og:description', desc);
    html = setMeta(html, 'property', 'og:url', url);
    html = setMeta(html, 'property', 'og:type', 'profile');
    html = setMeta(html, 'name', 'twitter:title', title);
    html = setMeta(html, 'name', 'twitter:description', desc);
    html = html.replace(/<link rel="canonical"[^>]*>/i, `<link rel="canonical" href="${esc(url)}" />`);
  }
  // Relative asset paths in the shell must resolve against the app, not the API.
  if (!/<base /i.test(html)) html = html.replace('<head>', `<head><base href="${esc(env.CLIENT_URL)}/" />`);
  // This page is the app itself (shown on the app's domain through a rewrite), so the API's strict
  // security headers would break it. Drop them for this one response.
  ['Content-Security-Policy', 'Cross-Origin-Embedder-Policy', 'Cross-Origin-Opener-Policy', 'Cross-Origin-Resource-Policy', 'Origin-Agent-Cluster'].forEach((h) => res.removeHeader(h));
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Cache-Control', 'public, max-age=300');
  res.send(html);
}));

module.exports = router;
