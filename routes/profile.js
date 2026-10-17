// routes/profile.js — the freelancer's own profile + public profiles of other users.
const router  = require('express').Router();
const User    = require('../models/User');
const ConnectionRequest = require('../models/ConnectionRequest');
const Connection = require('../models/Connection');
const Engagement = require('../models/Engagement');
const Review = require('../models/Review');
const Squad = require('../models/Squad');
const { PUBLIC_USER_FIELDS, publicUser } = require('../utils/publicUser');
const { protect } = require('../middleware/auth');
const { asyncHandler, badRequest, notFound } = require('../utils/http');
const { pick, isId } = require('../utils/sanitize');

router.use(protect);

const FIELDS = ['name', 'title', 'bio', 'phone', 'location', 'website', 'linkedin', 'github', 'twitter',
  'hourlyRate', 'minProject', 'availability', 'skills', 'languages', 'avatar', 'socialLinks',
  'projects', 'services', 'experience', 'education', 'discoverable', 'notifPrefs', 'contactVisibility'];

/** Reviews someone received, newest first — only the ones already revealed (double-blind). */
async function reviewsFor(userId) {
  const rows = await Review.find({ to: userId, visibleAt: { $ne: null } }).sort({ visibleAt: -1 }).limit(50).lean();
  const [users, contracts] = await Promise.all([
    User.find({ _id: { $in: rows.map((r) => r.from) } }).select(PUBLIC_USER_FIELDS).lean(),
    Engagement.find({ _id: { $in: rows.map((r) => r.engagement) } }).select('title kind').lean(),
  ]);
  const u = Object.fromEntries(users.map((x) => [String(x._id), publicUser(x)]));
  const c = Object.fromEntries(contracts.map((x) => [String(x._id), x]));
  return rows.map((r) => ({
    _id: r._id, direction: r.direction, ratings: r.ratings, wouldWorkAgain: r.wouldWorkAgain, comment: r.comment, at: r.visibleAt,
    from: u[String(r.from)] || null, contract: c[String(r.engagement)] ? { title: c[String(r.engagement)].title, kind: c[String(r.engagement)].kind } : null,
  }));
}

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
  if (updates.contactVisibility !== undefined && !['nobody', 'contracts', 'connections'].includes(updates.contactVisibility)) throw badRequest('Choose who can see your contact details');
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

router.get('/reviews', asyncHandler(async (req, res) => res.json({ reviews: await reviewsFor(req.user._id) })));

// Another user's public profile, with the relationship between you two.
router.get('/:id', asyncHandler(async (req, res) => {
  if (!isId(req.params.id)) throw notFound('Profile not found');
  const user = await User.findById(req.params.id);
  if (!user) throw notFound('Profile not found');
  const me = req.user._id;
  const [connected, pending, contract, squads] = await Promise.all([
    Connection.exists({ user: me, linkedUser: user._id }),
    ConnectionRequest.findOne({ status: 'pending', $or: [{ from: me, to: user._id }, { from: user._id, to: me }] }).lean(),
    Engagement.exists({ status: { $in: ['active', 'completed'] }, $or: [{ client: me, freelancer: user._id }, { client: user._id, freelancer: me }] }),
    Squad.find({ 'members.user': user._id }).select('name tagline members').lean()
      .then((rows) => rows.filter((s) => s.members.some((m) => String(m.user) === String(user._id) && m.status === 'active'))),
  ]);
  const relationship = connected ? 'connected' : pending ? (String(pending.from) === String(me) ? 'request-sent' : 'request-received') : 'none';
  const pub = user.toPublic();
  // Contact details stay private unless the person chose to share them:
  //   nobody · contracts (people they have a signed contract with) · connections (also everyone they're connected with)
  const vis = user.contactVisibility || 'contracts';
  const canSee = (vis === 'connections' && (connected || contract)) || (vis === 'contracts' && contract);
  if (canSee) Object.assign(pub, { email: user.email, phone: user.phone });
  pub.contactShared = Boolean(canSee);
  pub.contactVisibility = vis;
  pub.squads = squads.map((s) => ({ _id: s._id, name: s.name, tagline: s.tagline, members: s.members.filter((m) => m.status === 'active').length }));
  res.json({
    user: pub, profile: pub, relationship, requestId: pending?._id,
    isConnected: relationship === 'connected', requestSent: relationship === 'request-sent',
    requestReceived: relationship === 'request-received',
  });
}));

router.get('/:id/reviews', asyncHandler(async (req, res) => {
  if (!isId(req.params.id)) throw notFound('Profile not found');
  res.json({ reviews: await reviewsFor(req.params.id) });
}));

module.exports = router;
