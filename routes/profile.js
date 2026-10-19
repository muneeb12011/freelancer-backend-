// routes/profile.js — the freelancer's own profile + public profiles of other users.
const router  = require('express').Router();
const User    = require('../models/User');
const ConnectionRequest = require('../models/ConnectionRequest');
const Connection = require('../models/Connection');
const Engagement = require('../models/Engagement');
const Review = require('../models/Review');
const Squad = require('../models/Squad');
const PortfolioImage = require('../models/PortfolioImage');
const profiles = require('../services/profiles');
const { str } = require('../utils/sanitize');

const { reviewsFor } = profiles;
const { protect } = require('../middleware/auth');
const { asyncHandler, badRequest, notFound } = require('../utils/http');
const { pick, isId } = require('../utils/sanitize');

router.use(protect);

const FIELDS = ['name', 'title', 'bio', 'phone', 'location', 'website', 'linkedin', 'github', 'twitter',
  'hourlyRate', 'minProject', 'availability', 'skills', 'languages', 'avatar', 'socialLinks',
  'projects', 'services', 'experience', 'education', 'discoverable', 'notifPrefs', 'contactVisibility',
  'handle', 'hoursPerWeek', 'workingHours', 'langs', 'intro', 'intent', 'timezone'];

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
  if (updates.intent !== undefined && !['work', 'hire', 'both'].includes(updates.intent)) throw badRequest('Choose work, hire or both');
  if (updates.hoursPerWeek !== undefined) updates.hoursPerWeek = Math.min(80, Math.max(0, parseInt(updates.hoursPerWeek, 10) || 0));
  if (updates.workingHours !== undefined) {
    const t = (v) => (/^([01]\d|2[0-3]):[0-5]\d$/.test(String(v || '')) ? String(v) : '');
    updates.workingHours = { start: t(updates.workingHours?.start), end: t(updates.workingHours?.end) };
  }
  if (updates.langs !== undefined) {
    if (!Array.isArray(updates.langs)) throw badRequest('Languages must be a list');
    updates.langs = updates.langs.slice(0, 10).map((l) => ({ name: str(l?.name, 40), level: ['Basic', 'Conversational', 'Fluent', 'Native'].includes(l?.level) ? l.level : 'Fluent' })).filter((l) => l.name);
    updates.languages = updates.langs.map((l) => l.name);
  }
  if (updates.intro !== undefined) {
    updates.intro = str(updates.intro, 300);
    if (updates.intro && !/^https:\/\/(www\.)?(youtube\.com|youtu\.be|loom\.com|vimeo\.com)\//.test(updates.intro)) throw badRequest('Intro video must be a YouTube, Loom or Vimeo link');
  }
  for (const k of ['projects']) {
    if (updates[k] === undefined) continue;
    updates[k] = updates[k].map((p) => ({ ...p, images: (Array.isArray(p.images) ? p.images : []).map((x) => (typeof x === 'object' ? x.id : x)).filter(isId).slice(0, 6) }));
  }
  if (updates.contactVisibility !== undefined && !['nobody', 'contracts', 'connections'].includes(updates.contactVisibility)) throw badRequest('Choose who can see your contact details');
}

router.get('/', asyncHandler(async (req, res) => {
  await profiles.ensureHandle(req.user);
  const u = req.user.toClient();
  res.json({ user: u, profile: u });
}));

// Owner-only: reach, profile strength, work history.
router.get('/insights', asyncHandler(async (req, res) => {
  const [views, history, squads] = await Promise.all([profiles.viewStats(req.user._id), profiles.workHistory(req.user._id), profiles.activeSquads(req.user._id)]);
  res.json({ views, strength: profiles.strength(req.user), history, squads });
}));

router.get('/handle-check', asyncHandler(async (req, res) => {
  const h = String(req.query.h || '').toLowerCase();
  if (!profiles.validHandle(h)) return res.json({ ok: false, reason: '3–30 lowercase letters, numbers and single dashes' });
  const taken = await User.exists({ handle: h, _id: { $ne: req.user._id } });
  res.json({ ok: !taken, reason: taken ? 'Taken' : '' });
}));

// Portfolio images — compressed in the browser to ≤ 400 KB, max 24 per person.
router.post('/images', asyncHandler(async (req, res) => {
  const m = /^data:(image\/(?:jpeg|png|webp));base64,(.+)$/.exec(String(req.body.data || ''));
  if (!m) throw badRequest('Use a JPG, PNG or WEBP image');
  const buf = Buffer.from(m[2], 'base64');
  if (buf.length > 400 * 1024) throw badRequest('The image is too large after compression (max 400 KB)');
  if (await PortfolioImage.countDocuments({ owner: req.user._id }) >= 24) throw badRequest('You can keep up to 24 portfolio images');
  const img = await PortfolioImage.create({ owner: req.user._id, type: m[1], size: buf.length, data: buf });
  res.status(201).json({ image: { id: img._id, url: profiles.imageUrl(img._id) } });
}));

router.delete('/images/:id', asyncHandler(async (req, res) => {
  if (!isId(req.params.id)) throw notFound('Image not found');
  await PortfolioImage.deleteOne({ _id: req.params.id, owner: req.user._id });
  res.json({ ok: true });
}));

router.patch('/', asyncHandler(async (req, res) => {
  const updates = pick(req.body, FIELDS);
  validate(updates);
  if (updates.handle !== undefined) {
    const h = String(updates.handle || '').toLowerCase().trim();
    if (!profiles.validHandle(h)) throw badRequest('Your profile address can use 3–30 lowercase letters, numbers and single dashes');
    if (await User.exists({ handle: h, _id: { $ne: req.user._id } })) throw badRequest('That profile address is taken');
    updates.handle = h;
  }
  if (updates.timezone !== undefined) {
    if (/^[A-Za-z_]+(\/[A-Za-z_+-]+)+$|^UTC$/.test(String(updates.timezone))) req.user.preferences = { ...(req.user.preferences?.toObject?.() || req.user.preferences || {}), timezone: String(updates.timezone).slice(0, 60) };
    delete updates.timezone;
  }
  if (updates.notifPrefs) { req.user.notifications = { ...(req.user.notifications || {}), ...updates.notifPrefs }; delete updates.notifPrefs; }
  Object.assign(req.user, updates);
  await req.user.save();
  if (updates.projects) profiles.cleanupImages(req.user).catch(() => {});
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
  pub.history = await profiles.workHistory(user._id);
  pub.projects = (pub.projects || []).map((p) => ({ ...(p.toObject ? p.toObject() : p), images: (p.images || []).map((id) => ({ id, url: profiles.imageUrl(id) })) }));
  profiles.recordView(user._id, String(me), 'app');
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
