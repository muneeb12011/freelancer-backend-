// routes/admin.js — minimal operator endpoints (ADMIN_EMAILS only).
const router = require('express').Router();
const User   = require('../models/User');
const Ticket = require('../models/Ticket');
const Payment = require('../models/Payment');
const { protect, requireAdmin } = require('../middleware/auth');
const { asyncHandler, badRequest, notFound } = require('../utils/http');
const { INTERVAL_DAYS } = require('../config/plans');
const IdentityVerification = require('../models/IdentityVerification');
const vault = require('../services/vault');
const email = require('../services/email');
const env = require('../config/env');
const notify = require('../services/notify');

router.use(protect, requireAdmin);

router.get('/overview', asyncHandler(async (req, res) => {
  const [pendingIds, pendingPayouts, heldJobs, openReports] = await Promise.all([
    IdentityVerification.countDocuments({ status: 'pending' }),
    require('../models/PayoutMethod').countDocuments({ status: 'pending' }),
    require('../models/Job').countDocuments({ status: 'review' }),
    require('../models/Report').countDocuments({ status: 'open' }),
  ]);
  const disputes = await require('../models/Dispute').countDocuments({ status: { $in: ['open', 'responded'] } });
  const [users, premium, openTickets, revenue] = await Promise.all([
    User.countDocuments(),
    User.countDocuments({ plan: 'premium', planExpiresAt: { $gt: new Date() } }),
    Ticket.countDocuments({ status: { $in: ['open', 'in-progress'] }, awaiting: { $ne: 'user' } }),
    Payment.aggregate([{ $match: { status: 'paid' } }, { $group: { _id: '$currency', total: { $sum: '$amount' }, count: { $sum: 1 } } }]),
  ]);
  res.json({ users, premium, openTickets, revenue, queues: { identity: pendingIds, payouts: pendingPayouts, jobs: heldJobs, reports: openReports, disputes } });
}));

// Grant/extend Premium manually (e.g. bank transfer, comp account).
router.post('/users/:id/grant-premium', asyncHandler(async (req, res) => {
  const interval = req.body.interval === 'year' ? 'year' : 'month';
  const user = await User.findById(req.params.id);
  if (!user) throw notFound('User not found');
  const base = user.effectivePlan === 'premium' && user.planExpiresAt > new Date() ? user.planExpiresAt.getTime() : Date.now();
  user.plan = 'premium';
  user.planInterval = interval;
  user.planExpiresAt = new Date(base + INTERVAL_DAYS[interval] * 86400e3);
  await user.save();
  res.json({ user: user.toClient() });
}));

// Answer a ticket: the reply is stored, the person is notified in the app and by email,
// and the first answer's time feeds the reply time shown on the Support page.
async function answerTicket(ticket, admin, { reply, status }) {
  if (status && !['open', 'in-progress', 'resolved', 'closed'].includes(status)) throw badRequest('Unknown status');
  const text = reply ? String(reply).trim().slice(0, 5000) : '';
  if (text) {
    ticket.replies.push({ from: 'support', text, by: admin._id });
    if (!ticket.firstResponseAt) ticket.firstResponseAt = new Date();
    ticket.awaiting = 'user';
    if (!status && ticket.status === 'open') ticket.status = 'in-progress';
  }
  if (status) {
    ticket.status = status;
    if (['resolved', 'closed'].includes(status)) { ticket.awaiting = 'none'; if (!ticket.solvedBy) ticket.solvedBy = 'support'; }
  }
  ticket.lastActivityAt = new Date();
  await ticket.save();
  if (text) {
    if (ticket.user) notify.push(ticket.user, { type: 'support.reply', link: `/support?ticket=${ticket._id}`, title: `Support replied on ${ticket.number}`, body: text.slice(0, 160) });
    email.send({ to: ticket.email, ...email.templates.ticketReply(ticket, text) }).catch(() => {});
  }
  return ticket;
}

router.patch('/tickets/:id', asyncHandler(async (req, res) => {
  const ticket = await Ticket.findById(req.params.id);
  if (!ticket) throw notFound('Ticket not found');
  res.json({ ticket: await answerTicket(ticket, req.user, req.body) });
}));

router.post('/tickets/:id/reply', asyncHandler(async (req, res) => {
  if (!String(req.body.reply || '').trim()) throw badRequest('Write a reply');
  const ticket = await Ticket.findById(req.params.id);
  if (!ticket) throw notFound('Ticket not found');
  res.json({ ticket: await answerTicket(ticket, req.user, req.body) });
}));

// One ticket with what support needs to answer it: who sent it, their record, the contract.
router.get('/tickets/:id', asyncHandler(async (req, res) => {
  const ticket = await Ticket.findById(req.params.id).lean();
  if (!ticket) throw notFound('Ticket not found');
  const Engagement = require('../models/Engagement');
  const Dispute = require('../models/Dispute');
  const [sender, contract, disputes, others] = await Promise.all([
    ticket.user ? User.findById(ticket.user).select('name email handle createdAt identity.status reputation emailVerified').lean() : null,
    ticket.engagement ? Engagement.findById(ticket.engagement).select('title status currency milestones client freelancer createdAt').populate('client', 'name handle').populate('freelancer', 'name handle').lean() : null,
    ticket.engagement ? Dispute.find({ engagement: ticket.engagement }).select('kind status resolution createdAt').lean() : [],
    ticket.user ? Ticket.find({ user: ticket.user, _id: { $ne: ticket._id } }).select('number subject status createdAt').sort({ createdAt: -1 }).limit(5).lean() : [],
  ]);
  res.json({
    ticket,
    sender: sender && { _id: sender._id, name: sender.name, email: sender.email, handle: sender.handle, since: sender.createdAt, identity: sender.identity?.status || 'none', emailVerified: sender.emailVerified, reputation: sender.reputation || {} },
    contract: contract && {
      _id: contract._id, title: contract.title, status: contract.status, currency: contract.currency,
      client: contract.client, freelancer: contract.freelancer,
      milestones: (contract.milestones || []).map((m) => ({ title: m.title, amount: m.amount, status: m.status, dueDate: m.dueDate, approvedAt: m.approvedAt, payment: m.payment ? { reference: m.payment.reference, markedAt: m.payment.markedAt, confirmedAt: m.payment.confirmedAt, disputedAt: m.payment.disputedAt } : null })),
    },
    disputes,
    otherTickets: others,
  });
}));

// ── Identity verification queue ─────────────────────────────────────────
router.get('/verifications', asyncHandler(async (req, res) => {
  const status = ['pending', 'approved', 'rejected'].includes(req.query.status) ? req.query.status : 'pending';
  const rows = (await IdentityVerification.find({ status }).sort({ createdAt: status === 'pending' ? 1 : -1 }).limit(100).populate('user', 'name email avatar createdAt plan planExpiresAt').lean())
    .sort((a, b) => (status === 'pending' ? Number(b.user?.plan === 'premium' && new Date(b.user.planExpiresAt) > new Date()) - Number(a.user?.plan === 'premium' && new Date(a.user.planExpiresAt) > new Date()) : 0));
  res.json({ verifications: rows });
}));

router.get('/verifications/:id', asyncHandler(async (req, res) => {
  const v = await IdentityVerification.findById(req.params.id).select('+front +back +selfie').populate('user', 'name email avatar createdAt location').lean();
  if (!v) throw notFound('Submission not found');
  const toUrl = (b) => (b?.data ? `data:${b.type};base64,${vault.decrypt({ iv: b.iv.buffer || b.iv, tag: b.tag.buffer || b.tag, data: b.data.buffer || b.data }).toString('base64')}` : null);
  res.setHeader('Cache-Control', 'no-store');
  res.json({ verification: { ...v, front: toUrl(v.front), back: toUrl(v.back), selfie: toUrl(v.selfie) } });
}));

async function decide(req, res, approved) {
  const v = await IdentityVerification.findOne({ _id: req.params.id, status: 'pending' });
  if (!v) throw notFound('This submission was already reviewed');
  const reason = String(req.body.reason || '').slice(0, 500);
  if (!approved && !reason) throw badRequest('Say why so the person can fix it');
  // Decision recorded, images wiped.
  await IdentityVerification.updateOne({ _id: v._id }, {
    $set: { status: approved ? 'approved' : 'rejected', reviewer: req.user._id, reviewedAt: new Date(), reason, purgedAt: new Date() },
    $unset: { front: 1, back: 1, selfie: 1 },
  });
  const user = await User.findById(v.user);
  if (user) {
    user.identity = { status: approved ? 'approved' : 'rejected', submittedAt: v.createdAt, reviewedAt: new Date(), note: reason };
    notify.push(user._id, { type: `identity.${approved ? 'approved' : 'rejected'}`, link: approved ? '/profile' : '/settings?tab=verification', title: approved ? 'Your ID is verified' : 'Your ID check needs another try', body: approved ? 'The verified badge now shows next to your name.' : reason });
    await user.save();
    require('../services/jobSearch').syncPosterSignals(user).catch(() => {});
    email.send({
      to: user.email,
      subject: approved ? 'Your identity is verified' : 'We couldn’t verify your identity',
      html: email.layout({
        heading: approved ? 'You’re verified' : 'Verification needs another try',
        intro: approved
          ? `Hi ${email.esc(user.name)}, your ID check passed. The verified badge now shows on your profile, job posts and messages. Your document photos have been deleted.`
          : `Hi ${email.esc(user.name)}, we couldn’t approve your ID check: ${email.esc(reason)}<br><br>Your photos have been deleted. You can submit again from Settings → Verification.`,
        action: { label: approved ? 'View your profile' : 'Try again', url: `${env.CLIENT_URL}/${approved ? 'profile' : 'settings?tab=verification'}` },
      }),
    }).catch(() => {});
  }
  res.json({ ok: true });
}
router.post('/verifications/:id/approve', asyncHandler((req, res) => decide(req, res, true)));
router.post('/verifications/:id/reject', asyncHandler((req, res) => decide(req, res, false)));

// ── Payout method queue ─────────────────────────────────────────────────
const PayoutMethod = require('../models/PayoutMethod');
const payoutsSvc = require('../services/payouts');
const Job = require('../models/Job');
const Report = require('../models/Report');

const blobUrl = (b) => (b?.data ? `data:${b.type};base64,${vault.decrypt({ iv: b.iv.buffer || b.iv, tag: b.tag.buffer || b.tag, data: b.data.buffer || b.data }).toString('base64')}` : null);

router.get('/payouts', asyncHandler(async (req, res) => {
  // Premium members are reviewed first (a Premium perk), then oldest first.
  const rows = (await PayoutMethod.find({ status: 'pending' }).sort({ submittedAt: 1 }).limit(200).populate('user', 'name email avatar plan planExpiresAt').lean())
    .sort((a, b) => Number(b.user?.plan === 'premium' && new Date(b.user.planExpiresAt) > new Date()) - Number(a.user?.plan === 'premium' && new Date(a.user.planExpiresAt) > new Date()));
  const ids = rows.map((r) => r.user?._id).filter(Boolean);
  const idv = await IdentityVerification.find({ user: { $in: ids }, status: 'approved' }).select('user fullName country').lean();
  const byUser = Object.fromEntries(idv.map((v) => [String(v.user), v]));
  res.json({ payouts: rows.map((r) => ({ ...payoutsSvc.shape(r), user: r.user, proofKind: r.proofKind, identity: byUser[String(r.user?._id)] || null })) });
}));

router.get('/payouts/:id', asyncHandler(async (req, res) => {
  const m = await PayoutMethod.findById(req.params.id).select('+proof +secret').populate('user', 'name email').lean();
  if (!m) throw notFound('Not found');
  const idv = await IdentityVerification.findOne({ user: m.user._id, status: 'approved' }).select('fullName country').lean();
  res.setHeader('Cache-Control', 'no-store');
  res.json({ payout: { ...payoutsSvc.shape(m), user: m.user, proofKind: m.proofKind, proof: blobUrl(m.proof), details: m.type === 'card' ? null : payoutsSvc.open(m.secret), identity: idv } });
}));

router.post('/payouts/:id/:decision(approve|reject)', asyncHandler(async (req, res) => {
  const approved = req.params.decision === 'approve';
  const m = await PayoutMethod.findOne({ _id: req.params.id, status: 'pending' });
  if (!m) throw notFound('Already reviewed');
  const note = String(req.body.reason || '').slice(0, 400);
  if (!approved && !note) throw badRequest('Say why so the person can fix it');
  await PayoutMethod.updateOne({ _id: m._id }, { $set: { status: approved ? 'verified' : 'rejected', reviewedAt: new Date(), reviewNote: note }, $unset: { proof: 1 } });
  const types = await PayoutMethod.distinct('type', { user: m.user, status: 'verified' });
  await User.updateOne({ _id: m.user }, { $set: { payoutTypes: types } });
  const user = await User.findById(m.user).select('email name').lean();
  notify.push(m.user, { type: `payout.${approved ? 'verified' : 'rejected'}`, link: '/settings?tab=payouts', title: approved ? `${m.display} is verified` : `We couldn’t verify ${m.display}`, body: approved ? 'Clients now see the verified payout badge.' : note });
  if (user) {
    email.send({
      to: user.email,
      subject: approved ? `Verified: ${m.display}` : `We couldn’t verify ${m.display}`,
      html: email.layout({
        heading: approved ? 'Payout method verified' : 'Payout method needs another look',
        intro: approved
          ? `${email.esc(m.display)} is verified. Clients now see the verified payout badge on your profile, and you can share it on contracts. The proof you uploaded has been deleted.`
          : `We couldn’t verify ${email.esc(m.display)}: ${email.esc(note)}<br><br>Your proof has been deleted. You can submit again from Settings → Payouts.`,
        action: { label: 'Open payouts', url: `${env.CLIENT_URL}/settings?tab=payouts` },
      }),
    }).catch(() => {});
  }
  res.json({ ok: true });
}));

// ── Scam shield: held jobs + reports ────────────────────────────────────
router.get('/safety', asyncHandler(async (req, res) => {
  const [jobs, reports] = await Promise.all([
    Job.find({ status: 'review' }).sort({ updatedAt: 1 }).limit(100).populate('postedBy', 'name email identity.status createdAt').lean(),
    Report.find({ status: 'open' }).sort({ createdAt: 1 }).limit(200).populate('by', 'name email').populate('subject', 'name email').lean(),
  ]);
  const jobIds = reports.filter((r) => r.target === 'job').map((r) => r.targetId);
  const reportedJobs = await Job.find({ _id: { $in: jobIds } }).select('title status').lean();
  const jById = Object.fromEntries(reportedJobs.map((j) => [String(j._id), j]));
  res.json({ jobs, reports: reports.map((r) => ({ ...r, job: r.target === 'job' ? jById[String(r.targetId)] || null : null })) });
}));

router.post('/jobs/:id/:decision(publish|remove)', asyncHandler(async (req, res) => {
  const job = await Job.findById(req.params.id);
  if (!job) throw notFound('Job not found');
  const publish = req.params.decision === 'publish';
  job.status = publish ? 'open' : 'closed';
  job.closedReason = publish ? '' : 'removed';
  job.safety = { ...(job.safety?.toObject?.() || job.safety || {}), verdict: publish ? (job.safety?.flags?.length ? 'warn' : 'clear') : 'held', reviewedAt: new Date() };
  await job.save();
  notify.push(job.postedBy, { type: `job.${publish ? 'published' : 'removed'}`, link: `/jobs/${job._id}`, title: publish ? `“${job.title}” passed review and is live` : `“${job.title}” was removed`, body: publish ? '' : 'It broke the rules on fees, personal data or off-platform contact.' });
  if (!publish) await Report.updateMany({ target: 'job', targetId: job._id, status: 'open' }, { $set: { status: 'actioned', resolution: 'Job removed', resolvedAt: new Date() } });
  res.json({ ok: true });
}));

router.post('/reports/:id', asyncHandler(async (req, res) => {
  const status = ['actioned', 'dismissed'].includes(req.body.status) ? req.body.status : null;
  if (!status) throw badRequest('Choose actioned or dismissed');
  const r = await Report.findByIdAndUpdate(req.params.id, { $set: { status, resolution: String(req.body.resolution || '').slice(0, 400), resolvedAt: new Date() } }, { new: true });
  if (!r) throw notFound('Report not found');
  res.json({ report: r });
}));

// ── Disputes ────────────────────────────────────────────────────────────
const Dispute = require('../models/Dispute');
const Engagement = require('../models/Engagement');
const reputation = require('../services/reputation');
const contractsSvc = require('../services/contracts');

router.get('/disputes', asyncHandler(async (req, res) => {
  const rows = await Dispute.find({ status: { $in: ['open', 'responded'] } }).sort({ createdAt: 1 }).limit(100)
    .populate('openedBy', 'name email').populate('against', 'name email').lean();
  const cs = await Engagement.find({ _id: { $in: rows.map((d) => d.engagement) } }).select('title currency milestones client freelancer events conversation').lean();
  const cById = Object.fromEntries(cs.map((c) => [String(c._id), c]));
  res.json({ disputes: rows.map((d) => ({ ...d, contract: cById[String(d.engagement)] || null })) });
}));

router.post('/disputes/:id/resolve', asyncHandler(async (req, res) => {
  const outcome = ['for_opener', 'for_other', 'shared', 'no_fault'].includes(req.body.outcome) ? req.body.outcome : null;
  const note = String(req.body.note || '').slice(0, 2000);
  if (!outcome) throw badRequest('Choose an outcome');
  if (note.length < 20) throw badRequest('Explain the decision — both people will read it');
  const d = await Dispute.findOne({ _id: req.params.id, status: { $in: ['open', 'responded'] } });
  if (!d) throw notFound('Already closed');
  d.status = 'resolved';
  d.resolution = { outcome, note, by: req.user._id, at: new Date() };
  await d.save();
  const c = await Engagement.findById(d.engagement);
  if (c) {
    c.log(req.user._id, `Aurelance decided the dispute: ${note.slice(0, 200)}`);
    await c.save();
    await contractsSvc.announce(c, `Aurelance reviewed the dispute and decided: ${note}`);
  }
  notify.pushMany([d.openedBy, d.against], { type: 'dispute.resolved', link: `/contracts/${d.engagement}`, title: 'Your dispute has a decision', body: note.slice(0, 200) });
  reputation.touch(d.openedBy, d.against);
  res.json({ ok: true });
}));

router.get('/tickets', asyncHandler(async (req, res) => {
  const status = req.query.status || 'open';
  // "open" here means anything not finished; waiting-on-support first, urgent first, oldest first.
  const f = status === 'all' ? {} : status === 'open' ? { status: { $in: ['open', 'in-progress'] } } : { status };
  const rows = await Ticket.find(f).select('-replies.text').sort({ lastActivityAt: 1 }).limit(200).lean();
  const P = { urgent: 0, high: 1, normal: 2, low: 3 };
  rows.sort((a, b) => Number(b.awaiting === 'support') - Number(a.awaiting === 'support') || P[a.priority] - P[b.priority]);
  res.json({ tickets: rows.map((t) => ({ ...t, replyCount: (t.replies || []).length, replies: undefined })) });
}));

module.exports = router;
