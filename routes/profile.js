// routes/profile.js — the freelancer's own profile + public profiles of other users.
const router  = require('express').Router();
const User    = require('../models/User');
const ConnectionRequest = require('../models/ConnectionRequest');
const Connection = require('../models/Connection');
const { protect } = require('../middleware/auth');
const { asyncHandler, badRequest, notFound } = require('../utils/http');
const { pick, isId } = require('../utils/sanitize');

router.use(protect);

const FIELDS = ['name', 'title', 'bio', 'phone', 'location', 'website', 'linkedin', 'github', 'twitter',
  'hourlyRate', 'minProject', 'availability', 'skills', 'languages', 'avatar', 'socialLinks',
  'projects', 'services', 'experience', 'education', 'discoverable', 'notifPrefs'];

const MAX_LIST = 50;
const MAX_AVATAR = 3.2 * 1024 * 1024; // ~2.4 MB image as base64

function validate(updates) {
  for (const k of ['projects', 'services', 'experience', 'education', 'skills', 'languages']) {
    if (updates[k] === undefined) continue;
    if (!Array.isArray(updates[k])) throw badRequest(`${k} must be a list`);
    if (updates[k].length > MAX_LIST) throw badRequest(`You can add up to ${MAX_LIST} ${k}`);
  }
  if (updates.avatar && (typeof updates.avatar !== 'string' || updates.avatar.length > MAX_AVATAR)) throw badRequest('Photo must be under 2 MB');
  if (updates.avatar && !/^(data:image\/(png|jpe?g|webp|gif);base64,|https:\/\/)/.test(updates.avatar)) throw badRequest('Photo must be a PNG, JPG, WEBP or GIF');
  if (updates.hourlyRate !== undefined) updates.hourlyRate = Math.max(0, Number(updates.hourlyRate) || 0);
  if (updates.minProject !== undefined) updates.minProject = Math.max(0, Number(updates.minProject) || 0);
  if (updates.name !== undefined && !String(updates.name).trim()) throw badRequest('Name cannot be empty');
}

router.get('/', asyncHandler(async (req, res) => {
  const u = req.user.toClient();
  res.json({ user: u, profile: u });
}));

router.patch('/', asyncHandler(async (req, res) => {
  const updates = pick(req.body, FIELDS);
  validate(updates);
  if (updates.notifPrefs) { req.user.notifications = { ...(req.user.notifications || {}), ...updates.notifPrefs }; delete updates.notifPrefs; }
  Object.assign(req.user, updates);
  await req.user.save();
  const u = req.user.toClient();
  res.json({ user: u, profile: u });
}));

router.get('/reviews', (req, res) => res.json({ reviews: [] }));

// Another user's public profile, with the relationship between you two.
router.get('/:id', asyncHandler(async (req, res) => {
  if (!isId(req.params.id)) throw notFound('Profile not found');
  const user = await User.findById(req.params.id);
  if (!user) throw notFound('Profile not found');
  const me = req.user._id;
  const [connected, pending] = await Promise.all([
    Connection.exists({ user: me, linkedUser: user._id }),
    ConnectionRequest.findOne({ status: 'pending', $or: [{ from: me, to: user._id }, { from: user._id, to: me }] }).lean(),
  ]);
  const relationship = connected ? 'connected' : pending ? (String(pending.from) === String(me) ? 'request-sent' : 'request-received') : 'none';
  const pub = user.toPublic();
  // Contact details are shared with connections only.
  if (connected) Object.assign(pub, { email: user.email, phone: user.phone });
  res.json({
    user: pub, profile: pub, relationship, requestId: pending?._id,
    isConnected: relationship === 'connected', requestSent: relationship === 'request-sent',
    requestReceived: relationship === 'request-received',
  });
}));

router.get('/:id/reviews', (req, res) => res.json({ reviews: [] }));

module.exports = router;
