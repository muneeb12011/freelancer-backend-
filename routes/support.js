// routes/support.js — the help library, a "what's going on with your account" check, and tickets
// that can point at one of your contracts and get a real reply.
//   GET  /api/support/articles            topics + articles
//   GET  /api/support/faqs                 (old clients) same articles, flat
//   GET  /api/support/context              signed in: situations we can see + contracts to attach
//   GET  /api/support/status               services + measured support reply time
//   POST /api/support/tickets              { topic, engagement?, subject?, message, page? }
//   POST /api/support/contact              signed in or out: { name, email, subject, message }
//   GET  /api/support/tickets              mine
//   GET  /api/support/tickets/:id
//   POST /api/support/tickets/:id/reply    { text }
//   POST /api/support/tickets/:id/solve
//   POST /api/support/rate, /faq-feedback
const router   = require('express').Router();
const mongoose = require('mongoose');
const env      = require('../config/env');
const Ticket   = require('../models/Ticket');
const Feedback = require('../models/Feedback');
const Engagement = require('../models/Engagement');
const limits   = require('../middleware/rateLimits');
const { protect, optionalAuth } = require('../middleware/auth');
const { dbState } = require('../config/db');
const { createTicket } = require('../services/tickets');
const help = require('../services/help');
const { asyncHandler, badRequest, notFound } = require('../utils/http');
const { str, isEmail } = require('../utils/sanitize');

const DAY = 86400e3;
const TOPICS = ['payment', 'contract', 'dispute', 'scam', 'account', 'payout', 'bug', 'other'];
const TOPIC_LABEL = { payment: 'Payment', contract: 'Contract', dispute: 'Disagreement', scam: 'Scam or suspicious', account: 'Account', payout: 'Payout method', bug: 'Something’s broken', other: 'Other' };
const URGENT_TOPICS = new Set(['scam', 'payment', 'dispute']);

router.get('/articles', (req, res) => res.json({ topics: help.TOPICS, articles: help.ARTICLES }));
router.get('/faqs', (req, res) => res.json({
  faqs: help.ARTICLES.map((a) => ({ id: a.slug, category: help.TOPICS.find((t) => t.id === a.topic)?.name, question: a.title, answer: a.body.join('\n\n') })),
}));

const median = (xs) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

router.get('/status', asyncHandler(async (req, res) => {
  const db = dbState();
  const services = [
    { name: 'App & API', status: 'operational' },
    { name: 'Database', status: db === 'connected' ? 'operational' : 'degraded' },
    { name: 'Email delivery', status: env.features.email ? 'operational' : 'maintenance' },
    { name: 'Payments', status: env.features.payments ? 'operational' : 'maintenance' },
    { name: 'AI assistant', status: env.features.ai ? 'operational' : 'maintenance' },
  ];
  const overall = services.some((s) => s.status === 'down') ? 'down' : services.some((s) => s.status !== 'operational') ? 'degraded' : 'operational';
  // Measured, not promised: median hours to first reply over the last 60 days.
  let replyHours = null; let sample = 0;
  if (db === 'connected') {
    const rows = await Ticket.find({ firstResponseAt: { $ne: null }, createdAt: { $gte: new Date(Date.now() - 60 * DAY) } }).select('createdAt firstResponseAt').limit(500).lean();
    sample = rows.length;
    if (sample >= 3) replyHours = Math.round(median(rows.map((t) => (t.firstResponseAt - t.createdAt) / 36e5)) * 10) / 10;
  }
  res.json({ overall, services, support: { replyHours, sample }, checkedAt: new Date().toISOString() });
}));

/** The situations we can see from someone's own contracts and checks, each matched to an article. */
async function situationsFor(user) {
  const me = String(user._id);
  const now = Date.now();
  const Dispute = require('../models/Dispute');
  const PayoutMethod = require('../models/PayoutMethod');
  const Job = require('../models/Job');
  const JobApplication = require('../models/JobApplication');
  const [contracts, disputes, payouts, held, waiting] = await Promise.all([
    Engagement.find({ $or: [{ client: user._id }, { freelancer: user._id }] }).select('-events').sort({ updatedAt: -1 }).limit(60)
      .populate('client', 'name').populate('freelancer', 'name').lean(),
    Dispute.find({ $or: [{ openedBy: user._id }, { against: user._id }], status: { $in: ['open', 'responded'] } }).select('engagement openedBy status respondBy kind').lean(),
    PayoutMethod.find({ user: user._id, status: { $in: ['rejected', 'pending'] } }).select('type status display reviewNote').lean(),
    Job.find({ postedBy: user._id, status: 'review' }).select('title').lean(),
    JobApplication.find({ poster: user._id, status: { $in: ['submitted', 'shortlisted'] }, respondedAt: null, createdAt: { $lte: new Date(now - 10 * DAY) } }).select('job').lean(),
  ]);

  const out = [];
  const add = (s) => out.push({ ...s, article: s.article || help.forSituation(s.kind) });
  const fmt = (c, n) => `${c} ${Number(n || 0).toLocaleString('en-US')}`;

  for (const c of contracts) {
    const iAmClient = String(c.client?._id) === me;
    const other = (iAmClient ? c.freelancer : c.client)?.name || 'the other side';
    for (const m of c.milestones || []) {
      if (!iAmClient && m.status === 'approved' && m.approvedAt && now - new Date(m.approvedAt) > 7 * DAY) {
        add({ kind: 'unpaid', tone: 'late', engagement: c._id, to: `/contracts/${c._id}`, title: `${other} hasn’t paid for “${m.title}”`, detail: `${fmt(c.currency, m.amount)}, approved ${Math.floor((now - new Date(m.approvedAt)) / DAY)} days ago.` });
      }
      if (m.status === 'paid' && m.payment?.disputedAt) {
        add({ kind: 'not_received', tone: 'late', engagement: c._id, to: `/contracts/${c._id}`, title: iAmClient ? `${other} says “${m.title}” hasn’t arrived` : `You flagged “${m.title}” as not received`, detail: `${fmt(c.currency, m.amount)} marked paid${m.payment?.reference ? `, reference ${m.payment.reference}` : ''}.` });
      }
      if (iAmClient && c.status === 'active' && m.status === 'open' && m.dueDate && new Date(m.dueDate).getTime() < now - DAY) {
        add({ kind: 'late', tone: 'warn', engagement: c._id, to: `/contracts/${c._id}`, title: `“${m.title}” is ${Math.floor((now - new Date(m.dueDate)) / DAY)} days late`, detail: `Due from ${other}.` });
      }
    }
  }
  for (const d of disputes) {
    const c = contracts.find((x) => String(x._id) === String(d.engagement));
    const mine = String(d.openedBy) === me;
    const left = d.respondBy ? Math.ceil((new Date(d.respondBy) - now) / DAY) : null;
    add({
      kind: 'dispute', tone: mine ? 'info' : 'warn', engagement: d.engagement, to: `/contracts/${d.engagement}`,
      title: mine ? `Your dispute on “${c?.title || 'a contract'}” is ${d.status === 'responded' ? 'with Aurelance to decide' : 'waiting for a response'}` : `A dispute was opened against you on “${c?.title || 'a contract'}”`,
      detail: !mine && d.status === 'open' && left !== null ? `Respond within ${Math.max(0, left)} day${left === 1 ? '' : 's'}, or it’s decided on their side alone.` : 'A person here reads both sides and the contract record.',
    });
  }
  const idStatus = user.identity?.status;
  if (idStatus === 'rejected') add({ kind: 'identity', tone: 'warn', to: '/settings?tab=verification', title: 'Your ID check was sent back', detail: user.identity?.note || 'Open Verification to see why and send it again.' });
  if (idStatus === 'pending') add({ kind: 'identity', tone: 'info', to: '/settings?tab=verification', title: 'Your ID check is being reviewed', detail: 'Usually decided within one business day.' });
  for (const p of payouts) {
    add({ kind: 'payout', tone: p.status === 'rejected' ? 'warn' : 'info', to: '/settings?tab=payouts', title: p.status === 'rejected' ? `${p.display} wasn’t verified` : `${p.display} is waiting for review`, detail: p.status === 'rejected' ? (p.reviewNote || 'Open Payouts to see why.') : 'A person checks the name matches your ID.' });
  }
  for (const j of held) add({ kind: 'held', tone: 'info', article: 'post-a-job', to: `/jobs/${j._id}`, title: `“${j.title}” is waiting for review`, detail: 'Something in the post matched a scam pattern. A person checks it before it goes live.' });
  const ghostJobs = new Set(waiting.map((a) => String(a.job)));
  if (ghostJobs.size) add({ kind: 'ghosting', tone: 'warn', to: '/jobs?tab=posted', title: `Applicants have waited 10+ days on ${ghostJobs.size} of your posts`, detail: 'Answer them before day 14 or the post closes and it shows on your report card.' });

  const contractList = contracts.slice(0, 30).map((c) => {
    const iAmClient = String(c.client?._id) === me;
    return { _id: c._id, title: c.title, status: c.status, role: iAmClient ? 'client' : 'freelancer', with: (iAmClient ? c.freelancer : c.client)?.name || '' };
  });
  const rank = { late: 0, warn: 1, info: 2 };
  return { situations: out.sort((a, b) => rank[a.tone] - rank[b.tone]).slice(0, 8), contracts: contractList };
}

router.get('/context', protect, asyncHandler(async (req, res) => {
  const [ctx, open] = await Promise.all([
    situationsFor(req.user),
    Ticket.countDocuments({ user: req.user._id, status: { $in: ['open', 'in-progress'] } }),
  ]);
  res.json({ ...ctx, openTickets: open, topics: TOPICS.map((id) => ({ id, label: TOPIC_LABEL[id] })) });
}));

async function ownContract(user, id) {
  if (!id) return null;
  if (!mongoose.isValidObjectId(id)) throw badRequest('Pick one of your contracts');
  const c = await Engagement.findOne({ _id: id, $or: [{ client: user._id }, { freelancer: user._id }] }).select('title').lean();
  if (!c) throw badRequest('Pick one of your contracts');
  return c;
}

// Signed-in ticket
router.post(['/ticket', '/tickets'], protect, limits.publicForm, asyncHandler(async (req, res) => {
  const topic = TOPICS.includes(req.body.topic) ? req.body.topic : 'other';
  const contract = await ownContract(req.user, req.body.engagement);
  const message = str(req.body.message, 5000);
  if (!message || message.length < 10) throw badRequest('Tell us what happened — a sentence or two is enough');
  const subject = str(req.body.subject, 200) || `${TOPIC_LABEL[topic]}${contract ? ` — ${contract.title}` : ''}`.slice(0, 200);
  const page = str(req.body.page, 200);
  const ticket = await createTicket({
    user: req.user, name: req.user.name, email: req.user.email, subject,
    message: page ? `${message}\n\n— sent from ${page}` : message,
    category: TOPIC_LABEL[topic], topic, engagement: contract?._id,
    priority: URGENT_TOPICS.has(topic) ? 'high' : 'normal', source: 'app',
  });
  res.status(201).json({ message: 'Ticket received. We reply within one business day.', ticketId: ticket.number, ticket: shape(ticket.toObject()) });
}));

// Contact form (works signed in or out)
router.post('/contact', optionalAuth, limits.publicForm, asyncHandler(async (req, res) => {
  const name = str(req.body.name, 100) || req.user?.name || '';
  const from = str(req.body.email, 254).toLowerCase() || req.user?.email || '';
  const subject = str(req.body.subject, 200);
  const message = str(req.body.message, 5000);
  if (!isEmail(from)) throw badRequest('Enter a valid email so we can reply');
  if (!subject || !message) throw badRequest('Add a subject and a message');
  const ticket = await createTicket({ user: req.user, name, email: from, subject, message, category: str(req.body.category, 60), priority: req.body.priority, source: 'contact' });
  res.status(201).json({ success: true, message: 'Message sent. We reply within one business day.', ticketId: ticket.number });
}));

const shape = (t) => ({
  _id: t._id, ticketId: t.number, number: t.number, subject: t.subject, message: t.message, topic: t.topic, category: t.category,
  status: t.status, awaiting: t.awaiting, priority: t.priority, createdAt: t.createdAt, updatedAt: t.updatedAt,
  lastActivityAt: t.lastActivityAt || t.updatedAt, firstResponseAt: t.firstResponseAt, solvedBy: t.solvedBy,
  engagement: t.engagement && t.engagement.title ? { _id: t.engagement._id, title: t.engagement.title } : t.engagement || null,
  replies: (t.replies || []).map((r) => ({ _id: r._id, from: r.from, text: r.text, createdAt: r.createdAt })),
});

router.get('/tickets', protect, asyncHandler(async (req, res) => {
  const tickets = await Ticket.find({ user: req.user._id }).sort({ lastActivityAt: -1, createdAt: -1 }).limit(100).populate('engagement', 'title').lean();
  res.json({ tickets: tickets.map(shape) });
}));

router.get('/tickets/:id', protect, asyncHandler(async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) throw notFound('Ticket not found');
  const ticket = await Ticket.findOne({ _id: req.params.id, user: req.user._id }).populate('engagement', 'title').lean();
  if (!ticket) throw notFound('Ticket not found');
  res.json({ ticket: shape(ticket) });
}));

router.post('/tickets/:id/reply', protect, limits.publicForm, asyncHandler(async (req, res) => {
  const text = str(req.body.text || req.body.message, 5000);
  if (!text) throw badRequest('Reply is empty');
  if (!mongoose.isValidObjectId(req.params.id)) throw notFound('Ticket not found');
  const ticket = await Ticket.findOne({ _id: req.params.id, user: req.user._id });
  if (!ticket) throw notFound('Ticket not found');
  if (ticket.status === 'closed') throw badRequest('This ticket is closed. Start a new one and mention its number.');
  ticket.replies.push({ from: 'user', text });
  ticket.status = ticket.status === 'resolved' ? 'open' : ticket.status;
  ticket.awaiting = 'support';
  ticket.solvedBy = '';
  ticket.lastActivityAt = new Date();
  await ticket.save();
  const email = require('../services/email');
  email.send({ to: env.SUPPORT_INBOX, replyTo: ticket.email, subject: `Re: [${ticket.number}] ${ticket.subject}`, html: email.layout({ heading: `${ticket.number} · new reply`, intro: email.esc(text).replace(/\n/g, '<br>') }) }).catch(() => {});
  await ticket.populate('engagement', 'title');
  res.json({ ticket: shape(ticket.toObject()) });
}));

router.post('/tickets/:id/solve', protect, asyncHandler(async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) throw notFound('Ticket not found');
  const ticket = await Ticket.findOneAndUpdate(
    { _id: req.params.id, user: req.user._id, status: { $ne: 'closed' } },
    { status: 'resolved', awaiting: 'none', solvedBy: 'user', lastActivityAt: new Date() },
    { new: true },
  ).populate('engagement', 'title').lean();
  if (!ticket) throw notFound('Ticket not found');
  res.json({ ticket: shape(ticket) });
}));

router.post('/rate', protect, asyncHandler(async (req, res) => {
  const nps = Number(req.body.nps);
  if (!Number.isInteger(nps) || nps < 0 || nps > 10) throw badRequest('Pick a score from 0 to 10');
  await Feedback.create({ user: req.user._id, kind: 'nps', nps, aspects: req.body.aspectRatings, comment: str(req.body.comment, 2000), category: str(req.body.category, 60) });
  res.json({ message: 'Thanks for the feedback' });
}));

router.post('/faq-feedback', optionalAuth, asyncHandler(async (req, res) => {
  await Feedback.create({ user: req.user?._id, kind: 'faq', faqId: str(req.body.faqId, 60), helpful: Boolean(req.body.helpful) });
  res.json({ ok: true });
}));

router.situationsFor = situationsFor;
module.exports = router;
