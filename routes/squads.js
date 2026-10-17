// routes/squads.js — small teams of freelancers who apply together.
//   GET    /api/squads/mine                 squads I lead or belong to, plus invitations
//   GET    /api/squads?q=&skills=           browse
//   POST   /api/squads                      { name, tagline, about, skills, hourlyRate, role }
//   GET    /api/squads/:id
//   PATCH  /api/squads/:id                  lead only
//   POST   /api/squads/:id/invite           { userId, role }   lead only, people you're connected with
//   POST   /api/squads/:id/accept · /decline (invitee) · /leave (member)
//   DELETE /api/squads/:id/members/:userId  lead removes a member
//   DELETE /api/squads/:id                  lead disbands (only without active contracts)
const router = require('express').Router();
const Squad = require('../models/Squad');
const User = require('../models/User');
const Connection = require('../models/Connection');
const Engagement = require('../models/Engagement');
const messaging = require('../services/messaging');
const { protect } = require('../middleware/auth');
const { asyncHandler, badRequest, notFound, forbidden } = require('../utils/http');
const { isId, str, searchRegex, clampInt } = require('../utils/sanitize');
const { PUBLIC_USER_FIELDS, publicUser } = require('../utils/publicUser');

router.use(protect);

const cleanSkills = (v) => (Array.isArray(v) ? v : String(v || '').split(',')).map((s) => str(s, 40)).filter(Boolean).slice(0, 15);

async function shape(squads, me) {
  const list = Array.isArray(squads) ? squads : [squads];
  const ids = [...new Set(list.flatMap((s) => s.members.map((m) => String(m.user)).concat(String(s.lead))))];
  const users = await User.find({ _id: { $in: ids } }).select(PUBLIC_USER_FIELDS).lean();
  const byId = Object.fromEntries(users.map((u) => [String(u._id), publicUser(u)]));
  const out = list.map((s) => {
    const mine = s.members.find((m) => String(m.user) === String(me._id));
    const active = s.members.filter((m) => m.status === 'active');
    const reps = active.map((m) => byId[String(m.user)]?.reputation?.asFreelancer).filter(Boolean);
    return {
      _id: s._id, name: s.name, tagline: s.tagline, about: s.about, skills: s.skills, hourlyRate: s.hourlyRate, availability: s.availability, createdAt: s.createdAt,
      lead: byId[String(s.lead)] || null,
      isLead: String(s.lead) === String(me._id),
      myStatus: mine?.status || null,
      members: s.members
        .filter((m) => m.status === 'active' || String(s.lead) === String(me._id) || String(m.user) === String(me._id))
        .map((m) => ({ user: byId[String(m.user)] || null, role: m.role, status: m.status, joinedAt: m.joinedAt })).filter((m) => m.user),
      stats: {
        members: active.length,
        completed: reps.reduce((n, r) => n + (r.completed || 0), 0),
        verified: active.filter((m) => byId[String(m.user)]?.badges?.identity).length,
      },
    };
  });
  return Array.isArray(squads) ? out : out[0];
}

async function load(req, { lead = false } = {}) {
  if (!isId(req.params.id)) throw notFound('Squad not found');
  const s = await Squad.findById(req.params.id);
  if (!s) throw notFound('Squad not found');
  if (lead && String(s.lead) !== String(req.user._id)) throw forbidden('Only the squad lead can do this');
  return s;
}

router.get('/mine', asyncHandler(async (req, res) => {
  const rows = await Squad.find({ 'members.user': req.user._id }).sort({ updatedAt: -1 }).lean();
  const shaped = await shape(rows, req.user);
  res.json({ squads: shaped.filter((s) => s.myStatus === 'active'), invitations: shaped.filter((s) => s.myStatus === 'invited') });
}));

router.get('/', asyncHandler(async (req, res) => {
  const f = {};
  if (req.query.q) { const re = searchRegex(req.query.q); f.$or = [{ name: re }, { tagline: re }, { skills: re }]; }
  if (req.query.skills) f.skills = { $in: String(req.query.skills).split(',').map((s) => new RegExp(`^${s.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i')).slice(0, 10) };
  const limit = clampInt(req.query.limit, { max: 50, def: 24 });
  const rows = await Squad.find(f).sort({ updatedAt: -1 }).limit(limit).lean();
  const shaped = await shape(rows, req.user);
  res.json({ squads: shaped.filter((s) => s.stats.members >= 2) });
}));

router.post('/', asyncHandler(async (req, res) => {
  if (await Squad.countDocuments({ lead: req.user._id }) >= 3) throw badRequest('You can lead up to 3 squads');
  const name = str(req.body.name, 60);
  if (name.length < 3) throw badRequest('Give the squad a name (at least 3 characters)');
  const s = await Squad.create({
    name, tagline: str(req.body.tagline, 140), about: str(req.body.about, 2000), skills: cleanSkills(req.body.skills),
    hourlyRate: Math.max(0, Number(req.body.hourlyRate) || 0), lead: req.user._id,
    members: [{ user: req.user._id, role: str(req.body.role, 60) || 'Lead', status: 'active', joinedAt: new Date() }],
  });
  res.status(201).json({ squad: await shape(s.toObject(), req.user) });
}));

router.get('/:id', asyncHandler(async (req, res) => {
  const s = await load(req);
  res.json({ squad: await shape(s.toObject(), req.user) });
}));

router.patch('/:id', asyncHandler(async (req, res) => {
  const s = await load(req, { lead: true });
  if (req.body.name !== undefined) { const n = str(req.body.name, 60); if (n.length < 3) throw badRequest('Name is too short'); s.name = n; }
  if (req.body.tagline !== undefined) s.tagline = str(req.body.tagline, 140);
  if (req.body.about !== undefined) s.about = str(req.body.about, 2000);
  if (req.body.skills !== undefined) s.skills = cleanSkills(req.body.skills);
  if (req.body.hourlyRate !== undefined) s.hourlyRate = Math.max(0, Number(req.body.hourlyRate) || 0);
  if (['available', 'busy'].includes(req.body.availability)) s.availability = req.body.availability;
  if (Array.isArray(req.body.roles)) {
    req.body.roles.forEach((r) => { const m = s.members.find((x) => String(x.user) === String(r.user)); if (m) m.role = str(r.role, 60); });
  }
  await s.save();
  res.json({ squad: await shape(s.toObject(), req.user) });
}));

router.post('/:id/invite', asyncHandler(async (req, res) => {
  const s = await load(req, { lead: true });
  const { userId } = req.body;
  if (!isId(userId) || String(userId) === String(req.user._id)) throw badRequest('Choose someone to invite');
  if (s.members.some((m) => String(m.user) === String(userId))) throw badRequest('They’re already in the squad or invited');
  if (s.members.length >= Squad.MAX_MEMBERS) throw badRequest(`A squad can have up to ${Squad.MAX_MEMBERS} people`);
  const connected = await Connection.exists({ user: req.user._id, linkedUser: userId });
  if (!connected) throw badRequest('You can only invite people you’re connected with');
  const invitee = await User.findById(userId).select('name');
  if (!invitee) throw notFound('That person doesn’t exist any more');
  s.members.push({ user: invitee._id, role: str(req.body.role, 60), status: 'invited', invitedBy: req.user._id });
  await s.save();
  const convo = await messaging.findOrCreate(req.user._id, invitee._id);
  await messaging.post(convo, { kind: 'system', text: `${req.user.name} invited ${invitee.name} to join the squad “${s.name}”${req.body.role ? ` as ${str(req.body.role, 60)}` : ''}. Accept it under Talent → Squads.` });
  res.json({ squad: await shape(s.toObject(), req.user) });
}));

router.post('/:id/:action(accept|decline|leave)', asyncHandler(async (req, res) => {
  const s = await load(req);
  const m = s.members.find((x) => String(x.user) === String(req.user._id));
  const { action } = req.params;
  if (!m) throw notFound('You’re not in this squad');
  if (action === 'accept') {
    if (m.status !== 'invited') throw badRequest('You’re already a member');
    m.status = 'active'; m.joinedAt = new Date();
  } else {
    if (action === 'leave' && String(s.lead) === String(req.user._id)) throw badRequest('The lead can’t leave. Disband the squad instead.');
    if (action === 'leave' && await Engagement.exists({ squad: s._id, status: 'active' })) throw badRequest('The squad has an active contract. Finish it before leaving.');
    s.members = s.members.filter((x) => String(x.user) !== String(req.user._id));
  }
  await s.save();
  res.json({ squad: action === 'accept' ? await shape(s.toObject(), req.user) : null });
}));

router.delete('/:id/members/:userId', asyncHandler(async (req, res) => {
  const s = await load(req, { lead: true });
  if (String(req.params.userId) === String(s.lead)) throw badRequest('The lead can’t be removed');
  s.members = s.members.filter((x) => String(x.user) !== String(req.params.userId));
  await s.save();
  res.json({ squad: await shape(s.toObject(), req.user) });
}));

router.delete('/:id', asyncHandler(async (req, res) => {
  const s = await load(req, { lead: true });
  if (await Engagement.exists({ squad: s._id, status: { $in: ['draft', 'active'] } })) throw badRequest('Finish the squad’s open contracts first');
  await Squad.deleteOne({ _id: s._id });
  res.json({ message: 'Squad disbanded' });
}));

module.exports = router;
