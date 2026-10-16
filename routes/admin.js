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
  const [users, premium, openTickets, revenue] = await Promise.all([
    User.countDocuments(),
    User.countDocuments({ plan: 'premium', planExpiresAt: { $gt: new Date() } }),
    Ticket.countDocuments({ status: { $in: ['open', 'in-progress'] } }),
    Payment.aggregate([{ $match: { status: 'paid' } }, { $group: { _id: '$currency', total: { $sum: '$amount' }, count: { $sum: 1 } } }]),
  ]);
  res.json({ users, premium, openTickets, revenue });
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
  const rows = await IdentityVerification.find({ status }).sort({ createdAt: status === 'pending' ? 1 : -1 }).limit(100).populate('user', 'name email avatar createdAt').lean();
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

router.get('/tickets', asyncHandler(async (req, res) => {
  const status = req.query.status || 'open';
  const tickets = await Ticket.find(status === 'all' ? {} : { status }).sort({ createdAt: -1 }).limit(100).lean();
  res.json({ tickets });
}));

module.exports = router;
