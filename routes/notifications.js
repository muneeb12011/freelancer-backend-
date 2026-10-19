// routes/notifications.js — the bell.
//   GET  /api/notifications?before=<iso>&limit=   newest first, + unread count
//   GET  /api/notifications/unread                { count }
//   POST /api/notifications/read                  { ids?: [] }  (no ids = all)
const router = require('express').Router();
const Notification = require('../models/Notification');
const User = require('../models/User');
const { protect } = require('../middleware/auth');
const { asyncHandler } = require('../utils/http');
const { isId, clampInt } = require('../utils/sanitize');
const { PUBLIC_USER_FIELDS, publicUser } = require('../utils/publicUser');

router.use(protect);

router.get('/unread', asyncHandler(async (req, res) => {
  res.json({ count: await Notification.countDocuments({ user: req.user._id, readAt: null }) });
}));

router.get('/', asyncHandler(async (req, res) => {
  const f = { user: req.user._id };
  if (req.query.before && !Number.isNaN(new Date(req.query.before).getTime())) f.createdAt = { $lt: new Date(req.query.before) };
  const limit = clampInt(req.query.limit, { max: 50, def: 20 });
  const [rows, unread] = await Promise.all([
    Notification.find(f).sort({ createdAt: -1 }).limit(limit + 1).lean(),
    Notification.countDocuments({ user: req.user._id, readAt: null }),
  ]);
  const actors = await User.find({ _id: { $in: rows.map((r) => r.actor).filter(Boolean) } }).select(PUBLIC_USER_FIELDS).lean();
  const byId = Object.fromEntries(actors.map((u) => [String(u._id), publicUser(u)]));
  res.json({
    items: rows.slice(0, limit).map((r) => ({ ...r, actor: r.actor ? byId[String(r.actor)] || null : null })),
    more: rows.length > limit,
    unread,
  });
}));

router.post('/read', asyncHandler(async (req, res) => {
  const f = { user: req.user._id, readAt: null };
  if (Array.isArray(req.body.ids) && req.body.ids.length) f._id = { $in: req.body.ids.filter(isId).slice(0, 100) };
  await Notification.updateMany(f, { $set: { readAt: new Date() } });
  res.json({ unread: await Notification.countDocuments({ user: req.user._id, readAt: null }) });
}));

module.exports = router;
