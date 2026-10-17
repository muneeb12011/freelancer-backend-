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

router.use(protect, requireAdmin);

router.get('/overview', asyncHandler(async (req, res) => {
  const [pendingIds, pendingPayouts, heldJobs, openReports] = await Promise.all([
    IdentityVerification.countDocuments({ status: 'pending' }),
    require('../models/PayoutMethod').countDocuments({ status: 'pending' }),
    require('../models/Job').countDocuments({ status: 'review' }),
    require('../models/Report').countDocuments({ status: 'open' }),
  ]);
  const [users, premium, openTickets, revenue] = await Promise.all([
    User.countDocuments(),
    User.countDocuments({ plan: 'premium', planExpiresAt: { $gt: new Date() } }),
    Ticket.countDocuments({ status: { $in: ['open', 'in-progress'] } }),
    Payment.aggregate([{ $match: { status: 'paid' } }, { $group: { _id: '$currency', total: { $sum: '$amount' }, count: { $sum: 1 } } }]),
  ]);
  res.json({ users, premium, openTickets, revenue, queues: { identity: pendingIds, payouts: pendingPayouts, jobs: heldJobs, reports: openReports } });
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

router.patch('/tickets/:id', asyncHandler(async (req, res) => {
  const { status, reply } = req.body;
  if (status && !['open', 'in-progress', 'resolved', 'closed'].includes(status)) throw badRequest('Unknown status');
  const ticket = await Ticket.findByIdAndUpdate(req.params.id, {
    ...(status ? { status } : {}),
    ...(reply ? { $push: { replies: { from: 'support', text: String(reply).slice(0, 5000) } } } : {}),
  }, { new: true });
  if (!ticket) throw notFound('Ticket not found');
  res.json({ ticket });
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
    await user.save();
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

router.get('/tickets', asyncHandler(async (req, res) => {
  const status = req.query.status || 'open';
  const tickets = await Ticket.find(status === 'all' ? {} : { status }).sort({ createdAt: -1 }).limit(100).lean();
  res.json({ tickets });
}));

module.exports = router;
