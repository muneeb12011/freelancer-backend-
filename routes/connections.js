// routes/connections.js — your network.
// A Connection is your private record of a person (CRM-style). When that person is another
// Aurelance user, the record is linked (linkedUser) and created by accepting a ConnectionRequest.
const router     = require('express').Router();
const mongoose   = require('mongoose');
const Connection = require('../models/Connection');
const ConnectionRequest = require('../models/ConnectionRequest');
const User       = require('../models/User');
const email      = require('../services/email');
const messaging  = require('../services/messaging');
const notify     = require('../services/notify');
const env        = require('../config/env');
const { protect } = require('../middleware/auth');
const { asyncHandler, badRequest, notFound } = require('../utils/http');
const { stripProtected, searchRegex, isId, str, isEmail } = require('../utils/sanitize');

router.use(protect);

const SERVER_FIELDS = ['messages', 'linkedUser'];
const clean = (b) => stripProtected(b, SERVER_FIELDS);

const { PUBLIC_USER_FIELDS: PUBLIC_USER, publicUser } = require('../utils/publicUser');

/** Ids of users I'm already linked with or have a pending request with. */
async function excludedUserIds(me) {
  const [linked, reqs] = await Promise.all([
    Connection.find({ user: me, linkedUser: { $ne: null } }).distinct('linkedUser'),
    ConnectionRequest.find({ status: 'pending', $or: [{ from: me }, { to: me }] }).select('from to').lean(),
  ]);
  const ids = new Set([String(me), ...linked.map(String)]);
  reqs.forEach((r) => { ids.add(String(r.from)); ids.add(String(r.to)); });
  return [...ids].map((id) => new mongoose.Types.ObjectId(id));
}

// ── GET /api/connections ────────────────────────────────────────────────
router.get('/', asyncHandler(async (req, res) => {
  const connections = await Connection.find({ user: req.user._id }).select('-messages').sort({ pinned: -1, updatedAt: -1 }).limit(2000);
  res.json({ connections });
}));

// ── POST /api/connections — add a contact manually ──────────────────────
router.post('/', asyncHandler(async (req, res) => {
  if (!str(req.body.name)) throw badRequest('Enter a name');
  const connection = await Connection.create({ ...clean(req.body), user: req.user._id });
  res.status(201).json({ connection });
}));

// ── GET /api/connections/search?q= — find Aurelance users ────────────────
router.get('/search', asyncHandler(async (req, res) => {
  const q = str(req.query.q, 100);
  if (q.length < 2) return res.json({ users: [], results: [] });
  const re = searchRegex(q);
  const exclude = await excludedUserIds(req.user._id);
  const users = await User.find({
    _id: { $nin: exclude }, discoverable: { $ne: false },
    $or: [{ name: re }, { title: re }, { skills: re }, { location: re }],
  }).select(PUBLIC_USER).limit(20).lean();
  const mine = await Connection.find({ user: req.user._id, $or: [{ name: re }, { role: re }, { skills: re }] }).select('-messages').limit(20);
  res.json({ users: users.map(publicUser), results: mine });
}));

// ── GET /api/connections/suggestions — people with overlapping skills ───
router.get('/suggestions', asyncHandler(async (req, res) => {
  const exclude = await excludedUserIds(req.user._id);
  const skills = (req.user.skills || []).slice(0, 20);
  let users = [];
  if (skills.length) {
    users = await User.aggregate([
      { $match: { _id: { $nin: exclude }, discoverable: { $ne: false }, skills: { $in: skills } } },
      { $addFields: { overlap: { $size: { $setIntersection: ['$skills', skills] } } } },
      { $sort: { overlap: -1, updatedAt: -1 } },
      { $limit: 12 },
      { $project: { name: 1, avatar: 1, title: 1, location: 1, hourlyRate: 1, availability: 1, skills: 1, overlap: 1, emailVerified: 1, googleId: 1, githubId: 1, identity: 1, plan: 1, planExpiresAt: 1, createdAt: 1 } },
    ]);
  }
  if (users.length < 6) {
    const more = await User.find({ _id: { $nin: [...exclude, ...users.map((u) => u._id)] }, discoverable: { $ne: false }, title: { $ne: '' } })
      .sort({ lastLoginAt: -1 }).limit(6 - users.length).select(PUBLIC_USER).lean();
    users = users.concat(more);
  }
  res.json({ suggestions: users.map((u) => ({ ...publicUser(u), mutualSkills: u.overlap || 0 })) });
}));

// ── Activity feed ───────────────────────────────────────────────────────
router.get('/activity', asyncHandler(async (req, res) => {
  const [recent, reqs] = await Promise.all([
    Connection.find({ user: req.user._id }).select('name role updatedAt createdAt lastInteraction').sort({ updatedAt: -1 }).limit(15).lean(),
    ConnectionRequest.find({ to: req.user._id }).sort({ createdAt: -1 }).limit(10).populate('from', 'name').lean(),
  ]);
  const activities = [
    ...recent.map((c) => ({
      _id: c._id, name: c.name, type: c.lastInteraction ? 'message' : 'connection_updated',
      message: c.lastInteraction ? `You talked with ${c.name}` : `${c.name} was updated`, date: c.lastInteraction || c.updatedAt,
    })),
    ...reqs.filter((r) => r.from).map((r) => ({
      _id: r._id, name: r.from.name, type: 'request',
      message: r.status === 'accepted' ? `You connected with ${r.from.name}` : `${r.from.name} wants to connect`, date: r.createdAt,
    })),
  ].sort((a, b) => new Date(b.date) - new Date(a.date)).slice(0, 20);
  res.json({ activities, activity: activities });
}));

// ── Requests ────────────────────────────────────────────────────────────
router.get('/requests/incoming', asyncHandler(async (req, res) => {
  const rows = await ConnectionRequest.find({ to: req.user._id, status: 'pending' }).sort({ createdAt: -1 }).populate('from', PUBLIC_USER).lean();
  res.json({ requests: rows.filter((r) => r.from).map((r) => ({ _id: r._id, message: r.message, createdAt: r.createdAt, from: publicUser(r.from) })) });
}));

router.get('/requests/sent', asyncHandler(async (req, res) => {
  const rows = await ConnectionRequest.find({ from: req.user._id, status: 'pending' }).sort({ createdAt: -1 }).populate('to', PUBLIC_USER).lean();
  res.json({ requests: rows.filter((r) => r.to).map((r) => ({ _id: r._id, userId: r.to._id, name: r.to.name, photo: r.to.avatar, createdAt: r.createdAt, to: publicUser(r.to) })) });
}));

router.post('/request', asyncHandler(async (req, res) => {
  const { userId } = req.body;
  if (!isId(userId)) throw badRequest('Choose someone to connect with');
  if (String(userId) === String(req.user._id)) throw badRequest('You can’t connect with yourself');
  const target = await User.findById(userId);
  if (!target) throw notFound('That person no longer has an account');
  if (await Connection.exists({ user: req.user._id, linkedUser: target._id })) throw badRequest(`You’re already connected with ${target.name}`);

  // If they already asked me, connecting is just accepting.
  const reverse = await ConnectionRequest.findOne({ from: target._id, to: req.user._id, status: 'pending' });
  if (reverse) {
    const convo = await acceptRequest(reverse, req.user, target);
    return res.json({ message: `You’re now connected with ${target.name}`, connected: true, conversationId: convo._id });
  }

  const existing = await ConnectionRequest.findOne({ from: req.user._id, to: target._id, status: 'pending' });
  if (existing) return res.json({ message: 'Request already sent', request: existing });

  const request = await ConnectionRequest.create({ from: req.user._id, to: target._id, message: str(req.body.message, 500) });
  notify.push(target._id, { type: 'connection.request', actor: req.user._id, link: '/network?tab=requests', title: `${req.user.name} wants to connect`, body: str(req.body.message, 200) });
  if (target.notifications?.connectionReqs !== false) {
    email.send({
      to: target.email,
      subject: `${req.user.name} wants to connect on Aurelance`,
      html: email.layout({
        heading: `${email.esc(req.user.name)} wants to connect`,
        intro: `${email.esc(req.user.name)}${req.user.title ? `, ${email.esc(req.user.title)},` : ''} sent you a connection request.${request.message ? `<br><br>“${email.esc(request.message)}”` : ''}`,
        action: { label: 'Review request', url: `${env.CLIENT_URL}/connections` },
      }),
    }).catch(() => {});
  }
  return res.status(201).json({ message: 'Request sent', request });
}));

async function acceptRequest(request, me, other) {
  notify.push(String(request.from) === String(me._id) ? other._id : request.from, { type: 'connection.accepted', actor: me._id, link: `/profile/${me._id}`, title: `${me.name} accepted your connection request`, body: 'Your conversation is in Messages.' });
  request.status = 'accepted';
  request.respondedAt = new Date();
  await request.save();
  const card = (u) => ({
    name: u.name, role: u.title, email: u.email, location: u.location, avatar: u.avatar, bio: u.bio,
    skills: u.skills, hourlyRate: u.hourlyRate, availability: u.availability, linkedUser: u._id, status: 'connected',
    lastInteraction: new Date(),
  });
  await Promise.all([
    Connection.findOneAndUpdate({ user: me._id, linkedUser: other._id }, { $setOnInsert: { user: me._id, ...card(other) } }, { upsert: true, new: true }),
    Connection.findOneAndUpdate({ user: other._id, linkedUser: me._id }, { $setOnInsert: { user: other._id, ...card(me) } }, { upsert: true, new: true }),
  ]);
  // The new connection shows up in both inboxes straight away.
  const convo = await messaging.findOrCreate(me._id, other._id);
  await messaging.post(convo, { kind: 'system', text: `${other.name} and ${me.name} are now connected.` });
  if (request.message) {
    await messaging.post(convo, { sender: request.from, text: request.message });
  }
  return convo;
}

router.post('/request/:id/accept', asyncHandler(async (req, res) => {
  const request = await ConnectionRequest.findOne({ _id: req.params.id, to: req.user._id, status: 'pending' });
  if (!request) throw notFound('This request is no longer pending');
  const other = await User.findById(request.from);
  if (!other) { request.status = 'cancelled'; await request.save(); throw notFound('That person deleted their account'); }
  const convo = await acceptRequest(request, req.user, other);
  res.json({ message: `Connected with ${other.name}`, conversationId: convo._id });
}));

router.post('/request/:id/reject', asyncHandler(async (req, res) => {
  const r = await ConnectionRequest.updateOne({ _id: req.params.id, to: req.user._id, status: 'pending' }, { status: 'rejected', respondedAt: new Date() });
  if (!r.matchedCount) throw notFound('This request is no longer pending');
  res.json({ message: 'Request declined' });
}));

// Cancel by target user id (used from a profile page)
router.delete('/request/cancel/:userId', asyncHandler(async (req, res) => {
  await ConnectionRequest.updateMany({ from: req.user._id, to: req.params.userId, status: 'pending' }, { status: 'cancelled' });
  res.json({ message: 'Request cancelled' });
}));

router.delete('/request/:id', asyncHandler(async (req, res) => {
  const r = await ConnectionRequest.updateOne({ _id: req.params.id, from: req.user._id, status: 'pending' }, { status: 'cancelled' });
  if (!r.matchedCount) throw notFound('Request not found');
  res.json({ message: 'Request cancelled' });
}));

// ── Invites ─────────────────────────────────────────────────────────────
router.post('/invite', asyncHandler(async (req, res) => {
  res.json({ link: `${env.CLIENT_URL}/register?ref=${req.user._id}` });
}));

router.post('/invite-direct', asyncHandler(async (req, res) => {
  const to = str(req.body.email, 254).toLowerCase();
  if (!isEmail(to)) throw badRequest('Enter a valid email address');
  const existing = await User.findOne({ email: to }).select('_id name');
  if (existing) return res.json({ message: `${existing.name} is already on Aurelance — send them a connection request.`, userId: existing._id });
  await email.send({
    to,
    subject: `${req.user.name} invited you to Aurelance`,
    html: email.layout({
      heading: `${email.esc(req.user.name)} invited you`,
      intro: `${email.esc(req.user.name)} is on Aurelance, the freelance marketplace that keeps a signed record of every contract, and wants to add you to their network.${req.body.message ? `<br><br>“${email.esc(str(req.body.message, 500))}”` : ''}`,
      action: { label: 'Create your free account', url: `${env.CLIENT_URL}/register?ref=${req.user._id}` },
    }),
    replyTo: req.user.email,
  });
  const connection = await Connection.create({ user: req.user._id, name: str(req.body.name, 80) || to, email: to, status: 'pending' });
  return res.status(201).json({ message: `Invite sent to ${to}`, connection });
}));

// ── Collaboration / referrals / meetings (stored on the connection) ────
router.post('/collab', asyncHandler(async (req, res) => {
  const conn = await Connection.findOneAndUpdate(
    { _id: req.body.connectionId, user: req.user._id },
    { collabStatus: 'pending', collabProject: str(req.body.project, 200), lastInteraction: new Date() },
    { new: true },
  );
  if (!conn) throw notFound('Connection not found');
  if (req.body.message) await Connection.updateOne({ _id: conn._id }, { $push: { messages: { sender: 'me', text: `Collaboration proposal — ${str(req.body.project, 200)}: ${str(req.body.message, 2000)}` } } });
  res.json({ connection: conn, message: 'Collaboration request sent' });
}));

router.post('/referral', asyncHandler(async (req, res) => {
  const { connectionId } = req.body;
  const conn = await Connection.findOne({ _id: connectionId, user: req.user._id });
  if (!conn) throw notFound('Connection not found');
  const note = `Referral${req.body.clientName ? ` for ${str(req.body.clientName, 120)}` : ''}: ${str(req.body.message || req.body.note, 2000)}`;
  conn.messages.push({ sender: 'me', text: note });
  conn.lastInteraction = new Date();
  await conn.save();
  res.json({ message: 'Referral sent' });
}));

router.post('/meeting', asyncHandler(async (req, res) => {
  const { connectionId } = req.body;
  const conn = await Connection.findOne({ _id: connectionId, user: req.user._id });
  if (!conn) throw notFound('Connection not found');
  const when = req.body.date ? `${str(req.body.date, 20)} ${str(req.body.time, 10)}`.trim() : 'a time to be agreed';
  conn.messages.push({ sender: 'me', text: `Meeting request for ${when}${req.body.agenda || req.body.topic ? ` — ${str(req.body.agenda || req.body.topic, 500)}` : ''}` });
  conn.lastInteraction = new Date();
  await conn.save();
  res.json({ message: 'Meeting request sent' });
}));

// ── Profile + chat ──────────────────────────────────────────────────────
router.get('/profile/:id', asyncHandler(async (req, res) => {
  const conn = await Connection.findOne({ _id: req.params.id, user: req.user._id });
  if (!conn) throw notFound('Connection not found');
  res.json({ connection: conn });
}));

router.get('/chat/:id', asyncHandler(async (req, res) => {
  const conn = await Connection.findOne({ _id: req.params.id, user: req.user._id }).select('messages name linkedUser');
  if (!conn) throw notFound('Connection not found');
  res.json({ messages: conn.messages.slice(-200) });
}));

// Messages to a linked Aurelance user are mirrored into their copy of the thread.
router.post('/chat/:id', asyncHandler(async (req, res) => {
  const text = str(req.body.text, 4000);
  if (!text) throw badRequest('Message is empty');
  const conn = await Connection.findOneAndUpdate(
    { _id: req.params.id, user: req.user._id },
    { $push: { messages: { $each: [{ sender: 'me', text }], $slice: -500 } }, lastInteraction: new Date() },
    { new: true },
  );
  if (!conn) throw notFound('Connection not found');
  if (conn.linkedUser) {
    const theirs = await Connection.findOne({ user: conn.linkedUser, linkedUser: req.user._id }).select('lastInteraction');
    await Connection.updateOne(
      { user: conn.linkedUser, linkedUser: req.user._id },
      { $push: { messages: { $each: [{ sender: 'them', text }], $slice: -500 } }, lastInteraction: new Date() },
    );
    // Email the recipient, at most once per 30 minutes per conversation.
    const quiet = !theirs?.lastInteraction || Date.now() - new Date(theirs.lastInteraction).getTime() > 30 * 60e3;
    if (theirs && quiet) {
      const other = await User.findById(conn.linkedUser).select('email name notifications');
      if (other && other.notifications?.clientMessages !== false) {
        email.send({
          to: other.email,
          subject: `New message from ${req.user.name}`,
          html: email.layout({
            heading: `${email.esc(req.user.name)} sent you a message`,
            intro: `“${email.esc(text.slice(0, 400))}${text.length > 400 ? '…' : ''}”`,
            action: { label: 'Reply in Aurelance', url: `${env.CLIENT_URL}/connections` },
          }),
        }).catch(() => {});
      }
    }
  }
  res.json({ message: conn.messages[conn.messages.length - 1] });
}));

router.post('/block/:id', asyncHandler(async (req, res) => {
  const conn = await Connection.findOneAndDelete({ _id: req.params.id, user: req.user._id });
  if (conn?.linkedUser) await ConnectionRequest.updateMany({ from: conn.linkedUser, to: req.user._id, status: 'pending' }, { status: 'rejected' });
  res.json({ message: 'Connection blocked and removed' });
}));

// ── Favourites ──────────────────────────────────────────────────────────
router.post('/favorites', asyncHandler(async (req, res) => {
  const conn = await Connection.findOneAndUpdate({ _id: req.body.connectionId, user: req.user._id }, { favorite: true }, { new: true });
  if (!conn) throw notFound('Connection not found');
  res.json({ connection: conn });
}));

router.delete('/favorites/:id', asyncHandler(async (req, res) => {
  const conn = await Connection.findOneAndUpdate({ _id: req.params.id, user: req.user._id }, { favorite: false }, { new: true });
  if (!conn) throw notFound('Connection not found');
  res.json({ connection: conn });
}));

// ── Update / delete ─────────────────────────────────────────────────────
router.patch('/:id', asyncHandler(async (req, res) => {
  const conn = await Connection.findOneAndUpdate({ _id: req.params.id, user: req.user._id }, clean(req.body), { new: true, runValidators: true });
  if (!conn) throw notFound('Connection not found');
  res.json({ connection: conn });
}));

router.delete('/:id', asyncHandler(async (req, res) => {
  const conn = await Connection.findOneAndDelete({ _id: req.params.id, user: req.user._id });
  if (!conn) throw notFound('Connection not found');
  // Disconnecting is mutual for Aurelance members (the conversation history stays).
  if (conn.linkedUser) await Connection.deleteOne({ user: conn.linkedUser, linkedUser: req.user._id });
  res.json({ message: 'Connection removed' });
}));

module.exports = router;
