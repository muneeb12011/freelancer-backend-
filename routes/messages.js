// routes/messages.js — one-to-one messaging between Aurelance users.
//   GET    /api/messages/unread                     → { total }
//   GET    /api/messages/conversations              → inbox
//   POST   /api/messages/conversations { userId }   → open (or create) a thread
//   GET    /api/messages/conversations/:id          → thread + other participant
//   GET    /api/messages/conversations/:id/messages?before=&after=
//   POST   /api/messages/conversations/:id/messages { text, attachment? {name,type,data(base64)} }
//   POST   /api/messages/conversations/:id/read
//   POST   /api/messages/conversations/:id/archive
//   DELETE /api/messages/:messageId                 → unsend (sender only)
//   GET    /api/messages/attachments/:id            → file download (participants only)
//   POST   /api/messages/block/:userId · DELETE /api/messages/block/:userId · POST /api/messages/report/:userId
const router = require('express').Router();
const mongoose = require('mongoose');
const rateLimit = require('express-rate-limit');
const Conversation = require('../models/Conversation');
const Message = require('../models/Message');
const Attachment = require('../models/Attachment');
const User = require('../models/User');
const messaging = require('../services/messaging');
const { createTicket } = require('../services/tickets');
const { protect } = require('../middleware/auth');
const { asyncHandler, badRequest, notFound, forbidden } = require('../utils/http');
const { isId, str, clampInt } = require('../utils/sanitize');
const { PUBLIC_USER_FIELDS, publicUser } = require('../utils/publicUser');

router.use(protect);

const sendLimit = rateLimit({
  windowMs: 60e3, limit: 40, standardHeaders: 'draft-7', legacyHeaders: false,
  keyGenerator: (req) => String(req.user._id),
  message: { error: 'You’re sending messages very fast. Wait a moment.', code: 'RATE_LIMITED' },
});

const MAX_FILE = 2 * 1024 * 1024;
const ALLOWED_TYPES = /^(image\/(png|jpe?g|webp|gif)|application\/pdf|text\/plain|application\/(zip|msword|vnd\.openxmlformats-officedocument\.(wordprocessingml\.document|spreadsheetml\.sheet|presentationml\.presentation)|vnd\.ms-excel))$/;

async function loadConvo(req) {
  if (!isId(req.params.id)) throw notFound('Conversation not found');
  const convo = await Conversation.findById(req.params.id);
  if (!convo || !convo.participants.some((p) => String(p) === String(req.user._id))) throw notFound('Conversation not found');
  return convo;
}

const otherId = (convo, me) => convo.participants.find((p) => String(p) !== String(me));

function shapeMessage(m, me) {
  return {
    _id: m._id,
    conversation: m.conversation,
    kind: m.kind,
    sender: m.sender,
    mine: m.sender && String(m.sender) === String(me),
    text: m.deletedAt ? '' : m.text,
    deleted: Boolean(m.deletedAt),
    attachment: m.deletedAt || !m.attachment?.id ? null : m.attachment,
    readAt: m.readAt,
    createdAt: m.createdAt,
  };
}

router.get('/unread', asyncHandler(async (req, res) => {
  const me = String(req.user._id);
  const convos = await Conversation.find({ participants: req.user._id, [`unread.${me}`]: { $gt: 0 } }).select('unread').lean();
  const total = convos.reduce((s, c) => s + (c.unread?.[me] || 0), 0);
  res.json({ total, conversations: convos.length });
}));

router.get('/conversations', asyncHandler(async (req, res) => {
  const me = String(req.user._id);
  const filter = { participants: req.user._id, 'lastMessage.at': { $ne: null } };
  if (req.query.archived === 'true') filter.archivedBy = req.user._id; else filter.archivedBy = { $ne: req.user._id };
  const convos = await Conversation.find(filter).sort({ 'lastMessage.at': -1 }).limit(clampInt(req.query.limit, { max: 200, def: 100 })).lean();
  const ids = convos.map((c) => c.participants.find((p) => String(p) !== me)).filter(Boolean);
  const users = await User.find({ _id: { $in: ids } }).select(PUBLIC_USER_FIELDS).lean();
  const byId = Object.fromEntries(users.map((u) => [String(u._id), u]));
  const q = str(req.query.q, 80).toLowerCase();
  const out = convos.map((c) => {
    const other = byId[String(c.participants.find((p) => String(p) !== me))];
    return {
      _id: c._id,
      with: publicUser(other) || { _id: null, name: 'Deleted account', badges: {} },
      lastMessage: c.lastMessage ? { ...c.lastMessage, mine: String(c.lastMessage.sender) === me } : null,
      unread: c.unread?.[me] || 0,
      job: c.job || null,
      updatedAt: c.updatedAt,
    };
  }).filter((c) => !q || c.with.name.toLowerCase().includes(q) || (c.lastMessage?.text || '').toLowerCase().includes(q));
  res.json({ conversations: out, blocked: (req.user.blockedUsers || []).map(String) });
}));

// People you're connected with — so the inbox can offer "start a conversation".
router.get('/contacts', asyncHandler(async (req, res) => {
  const Connection = require('../models/Connection');
  const ids = await Connection.find({ user: req.user._id, linkedUser: { $ne: null } }).distinct('linkedUser');
  const [users, convos] = await Promise.all([
    User.find({ _id: { $in: ids } }).select(PUBLIC_USER_FIELDS).lean(),
    Conversation.find({ participants: req.user._id, 'lastMessage.at': { $ne: null } }).select('participants').lean(),
  ]);
  const talked = new Set(convos.flatMap((c) => c.participants.map(String)));
  res.json({
    contacts: users
      .map((u) => ({ ...publicUser(u), hasConversation: talked.has(String(u._id)) }))
      .sort((a, b) => Number(a.hasConversation) - Number(b.hasConversation) || a.name.localeCompare(b.name)),
  });
}));

router.post('/conversations', asyncHandler(async (req, res) => {
  const { userId } = req.body;
  if (!isId(userId)) throw badRequest('Choose someone to message');
  if (String(userId) === String(req.user._id)) throw badRequest('You can’t message yourself');
  const other = await User.findById(userId).select(PUBLIC_USER_FIELDS).lean();
  if (!other) throw notFound('That person no longer has an account');
  const convo = await messaging.findOrCreate(req.user._id, other._id);
  res.status(201).json({ conversation: { _id: convo._id, with: publicUser(other) } });
}));

router.get('/conversations/:id', asyncHandler(async (req, res) => {
  const convo = await loadConvo(req);
  const other = await User.findById(otherId(convo, req.user._id)).select(PUBLIC_USER_FIELDS).lean();
  const blockedByMe = (req.user.blockedUsers || []).some((b) => String(b) === String(other?._id));
  const blockedMe = other ? await User.exists({ _id: other._id, blockedUsers: req.user._id }) : false;
  res.json({
    conversation: {
      _id: convo._id,
      with: publicUser(other) || { _id: null, name: 'Deleted account', badges: {} },
      job: convo.job || null,
      blockedByMe,
      canSend: Boolean(other) && !blockedByMe && !blockedMe,
    },
  });
}));

router.get('/conversations/:id/messages', asyncHandler(async (req, res) => {
  const convo = await loadConvo(req);
  const filter = { conversation: convo._id };
  if (req.query.before && !Number.isNaN(Date.parse(req.query.before))) filter.createdAt = { $lt: new Date(req.query.before) };
  if (req.query.after && !Number.isNaN(Date.parse(req.query.after))) filter.createdAt = { ...(filter.createdAt || {}), $gt: new Date(req.query.after) };
  const limit = clampInt(req.query.limit, { max: 100, def: 50 });
  const rows = await Message.find(filter).sort({ createdAt: -1 }).limit(limit).lean();
  // Messages the other person sent that I've now seen — mark read.
  const me = req.user._id;
  await Promise.all([
    Message.updateMany({ conversation: convo._id, sender: { $ne: me }, readAt: null }, { readAt: new Date() }),
    Conversation.updateOne({ _id: convo._id }, { $set: { [`unread.${me}`]: 0 } }),
  ]);
  res.json({ messages: rows.reverse().map((m) => shapeMessage(m, me)), hasMore: rows.length === limit });
}));

router.post('/conversations/:id/messages', sendLimit, asyncHandler(async (req, res) => {
  const convo = await loadConvo(req);
  const recipient = otherId(convo, req.user._id);
  if (!recipient || !(await User.exists({ _id: recipient }))) throw badRequest('This person deleted their account');
  if (await messaging.isBlocked(req.user._id, recipient)) throw forbidden('You can’t message this person');

  const text = str(req.body.text, 5000);
  let attachment;
  if (req.body.attachment) {
    const { name, type, data } = req.body.attachment;
    if (!ALLOWED_TYPES.test(String(type || ''))) throw badRequest('That file type isn’t supported. Send images, PDFs, Office documents, text or zip files.');
    const buf = Buffer.from(String(data || '').replace(/^data:[^;]+;base64,/, ''), 'base64');
    if (!buf.length) throw badRequest('The file is empty');
    if (buf.length > MAX_FILE) throw badRequest('Files can be up to 2 MB');
    const file = await Attachment.create({ owner: req.user._id, conversation: convo._id, name: str(name, 200) || 'file', type, size: buf.length, data: buf });
    attachment = { id: file._id, name: file.name, type: file.type, size: file.size };
  }
  if (!text && !attachment) throw badRequest('Message is empty');

  const msg = await messaging.post(convo, { sender: req.user._id, text, attachment });
  messaging.notify(convo, req.user, text).catch(() => {});
  res.status(201).json({ message: shapeMessage(msg.toObject(), req.user._id) });
}));

router.post('/conversations/:id/read', asyncHandler(async (req, res) => {
  const convo = await loadConvo(req);
  await Promise.all([
    Message.updateMany({ conversation: convo._id, sender: { $ne: req.user._id }, readAt: null }, { readAt: new Date() }),
    Conversation.updateOne({ _id: convo._id }, { $set: { [`unread.${req.user._id}`]: 0 } }),
  ]);
  res.json({ ok: true });
}));

router.post('/conversations/:id/archive', asyncHandler(async (req, res) => {
  const convo = await loadConvo(req);
  const archive = req.body.archive !== false;
  await Conversation.updateOne({ _id: convo._id }, archive ? { $addToSet: { archivedBy: req.user._id } } : { $pull: { archivedBy: req.user._id } });
  res.json({ ok: true, archived: archive });
}));

router.delete('/:messageId', asyncHandler(async (req, res) => {
  if (!isId(req.params.messageId)) throw notFound('Message not found');
  const msg = await Message.findOne({ _id: req.params.messageId, sender: req.user._id });
  if (!msg) throw notFound('Message not found');
  msg.deletedAt = new Date();
  await msg.save();
  if (msg.attachment?.id) await Attachment.deleteOne({ _id: msg.attachment.id });
  res.json({ ok: true });
}));

router.get('/attachments/:id', asyncHandler(async (req, res) => {
  if (!isId(req.params.id)) throw notFound('File not found');
  const file = await Attachment.findById(req.params.id).select('+data');
  if (!file) throw notFound('File not found');
  const convo = await Conversation.findById(file.conversation).select('participants').lean();
  if (!convo || !convo.participants.some((p) => String(p) === String(req.user._id))) throw notFound('File not found');
  res.setHeader('Content-Type', file.type);
  res.setHeader('Content-Length', file.size);
  res.setHeader('Content-Disposition', `${/^image\//.test(file.type) && req.query.download !== '1' ? 'inline' : 'attachment'}; filename="${encodeURIComponent(file.name)}"`);
  res.setHeader('Cache-Control', 'private, max-age=86400');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.end(file.data);
}));

// ── Safety ──────────────────────────────────────────────────────────────
router.post('/block/:userId', asyncHandler(async (req, res) => {
  if (!isId(req.params.userId) || String(req.params.userId) === String(req.user._id)) throw badRequest('Invalid user');
  await User.updateOne({ _id: req.user._id }, { $addToSet: { blockedUsers: new mongoose.Types.ObjectId(req.params.userId) } });
  res.json({ ok: true, message: 'Blocked. They can’t message you any more.' });
}));

router.delete('/block/:userId', asyncHandler(async (req, res) => {
  if (!isId(req.params.userId)) throw badRequest('Invalid user');
  await User.updateOne({ _id: req.user._id }, { $pull: { blockedUsers: new mongoose.Types.ObjectId(req.params.userId) } });
  res.json({ ok: true, message: 'Unblocked.' });
}));

router.post('/report/:userId', asyncHandler(async (req, res) => {
  if (!isId(req.params.userId)) throw badRequest('Invalid user');
  const target = await User.findById(req.params.userId).select('name email').lean();
  if (!target) throw notFound('User not found');
  const reason = str(req.body.reason, 2000) || 'No details given';
  const ticket = await createTicket({
    user: req.user, name: req.user.name, email: req.user.email,
    subject: `Report: ${target.name}`,
    message: `Reported user: ${target.name} <${target.email}> (${target._id})\nConversation: ${str(req.body.conversationId, 40) || '—'}\n\n${reason}`,
    category: 'Safety', priority: 'high', source: 'app',
  });
  res.json({ ok: true, message: `Thanks — we’ll review this (${ticket.number}).` });
}));

module.exports = router;
