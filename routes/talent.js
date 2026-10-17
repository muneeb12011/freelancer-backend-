// routes/talent.js — find freelancers by what they've actually done, not just what they claim.
//   GET /api/talent?q=&skills=&payout=bank,payoneer&verified=true&minRate=&maxRate=&available=true&sort=
//   sort: best (report card) · rate_low · rate_high · newest
const router = require('express').Router();
const User = require('../models/User');
const { protect } = require('../middleware/auth');
const { asyncHandler } = require('../utils/http');
const { searchRegex, clampInt } = require('../utils/sanitize');
const { PUBLIC_USER_FIELDS, publicUser } = require('../utils/publicUser');

router.use(protect);

const esc = (s) => s.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

router.get('/', asyncHandler(async (req, res) => {
  const f = { discoverable: { $ne: false }, _id: { $ne: req.user._id }, blockedUsers: { $ne: req.user._id } };
  const and = [];
  if (req.query.q) { const re = searchRegex(req.query.q); and.push({ $or: [{ name: re }, { title: re }, { skills: re }, { bio: re }] }); }
  if (req.query.skills) f.skills = { $in: String(req.query.skills).split(',').filter(Boolean).slice(0, 10).map((s) => new RegExp(`^${esc(s)}$`, 'i')) };
  const payout = String(req.query.payout || '').split(',').filter((t) => ['bank', 'payoneer', 'wise', 'card'].includes(t));
  if (payout.length) f.payoutTypes = { $in: payout };
  if (req.query.verified === 'true') f['identity.status'] = 'approved';
  if (req.query.available === 'true') f.availability = 'available';
  const min = Number(req.query.minRate); const max = Number(req.query.maxRate);
  if (min > 0 || max > 0) f.hourlyRate = { ...(min > 0 ? { $gte: min } : {}), ...(max > 0 ? { $lte: max } : {}) };
  if (and.length) f.$and = and;

  const limit = clampInt(req.query.limit, { max: 48, def: 24 });
  const page = clampInt(req.query.page, { min: 1, max: 200, def: 1 });
  const sort = { rate_low: { hourlyRate: 1 }, rate_high: { hourlyRate: -1 }, newest: { createdAt: -1 } }[req.query.sort] || { lastLoginAt: -1 };

  // Pull a wider window, then rank by report card for "best".
  const rows = await User.find(f).select(`${PUBLIC_USER_FIELDS} bio`).sort(sort).skip((page - 1) * limit).limit(req.query.sort ? limit : limit * 3).lean();
  let people = rows.map((u) => ({ ...publicUser(u), bio: (u.bio || '').slice(0, 220) }));
  if (!req.query.sort || req.query.sort === 'best') {
    const score = (p) => {
      const r = p.reputation?.asFreelancer || {};
      return (r.completed || 0) * 3 + (r.quality || 0) * 2 + (r.onTimeRate || 0) / 20 + (p.badges.identity ? 3 : 0) + (p.badges.payout ? 2 : 0) + (p.skills.length ? 1 : 0) + (p.title ? 1 : 0);
    };
    people = people.sort((a, b) => score(b) - score(a)).slice(0, limit);
  }
  const total = await User.countDocuments(f);
  res.json({ people, total, page, pages: Math.ceil(total / limit) });
}));

module.exports = router;
