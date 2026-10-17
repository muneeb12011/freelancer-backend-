// routes/payouts.js — a freelancer's payout methods (bank, Payoneer, Wise, Visa/Mastercard).
//   GET    /api/payouts                       my methods (masked) + what's needed to verify
//   POST   /api/payouts                       add  { type, holderName, ... }
//   POST   /api/payouts/:id/reveal            { password } → full details, owner only
//   POST   /api/payouts/:id/email-code        send a code to the Payoneer/Wise account email
//   POST   /api/payouts/:id/email-confirm     { code }
//   POST   /api/payouts/:id/verify            { proof (data URL), proofKind } → admin review
//   POST   /api/payouts/:id/default
//   DELETE /api/payouts/:id
const router = require('express').Router();
const crypto = require('crypto');
const PayoutMethod = require('../models/PayoutMethod');
const IdentityVerification = require('../models/IdentityVerification');
const Engagement = require('../models/Engagement');
const User = require('../models/User');
const vault = require('../services/vault');
const payouts = require('../services/payouts');
const email = require('../services/email');
const env = require('../config/env');
const rateLimit = require('express-rate-limit');

// Payout changes are sensitive but involve several steps (add → email code → confirm → verify),
// so they get their own, roomier per-user budget.
const payoutLimit = rateLimit({
  windowMs: 60 * 60e3, limit: 40, standardHeaders: 'draft-7', legacyHeaders: false,
  keyGenerator: (req) => String(req.user?._id || req.ip),
  message: { error: 'Too many payout changes. Try again in an hour.', code: 'RATE_LIMITED' },
});
const limits = { sensitive: payoutLimit };
const { protect } = require('../middleware/auth');
const { asyncHandler, badRequest, notFound, forbidden } = require('../utils/http');
const { isId, str } = require('../utils/sanitize');

router.use(protect);

const MAX_METHODS = 6;
const MAX_PROOF = 1.5 * 1024 * 1024;

async function identityName(userId) {
  const v = await IdentityVerification.findOne({ user: userId, status: 'approved' }).sort({ reviewedAt: -1 }).select('fullName').lean();
  return v?.fullName || '';
}

async function load(req, extra = '') {
  if (!isId(req.params.id)) throw notFound('Payout method not found');
  const m = await PayoutMethod.findOne({ _id: req.params.id, user: req.user._id }).select(extra);
  if (!m) throw notFound('Payout method not found');
  return m;
}

/** Keep the public list of verified payout types on the user in sync. */
async function syncUserTypes(userId) {
  const types = await PayoutMethod.distinct('type', { user: userId, status: 'verified' });
  await User.updateOne({ _id: userId }, { $set: { payoutTypes: types } });
}

router.get('/', asyncHandler(async (req, res) => {
  const rows = await PayoutMethod.find({ user: req.user._id }).sort({ isDefault: -1, createdAt: 1 }).lean();
  const idName = req.user.identity?.status === 'approved' ? await identityName(req.user._id) : '';
  res.json({
    methods: rows.map(payouts.shape),
    requirements: {
      enabled: vault.enabled(),
      identity: req.user.identity?.status || 'none',
      identityName: idName,
    },
    types: payouts.TYPES.map((t) => ({ id: t, label: payouts.LABEL[t] })),
  });
}));

router.post('/', limits.sensitive, asyncHandler(async (req, res) => {
  if (!vault.enabled()) throw Object.assign(new Error('Payout methods aren’t available yet. Try again soon.'), { statusCode: 503 });
  if (await PayoutMethod.countDocuments({ user: req.user._id }) >= MAX_METHODS) throw badRequest(`You can save up to ${MAX_METHODS} payout methods. Remove one first.`);
  const { doc, secret } = payouts.prepare(req.body);
  const idName = req.user.identity?.status === 'approved' ? await identityName(req.user._id) : '';
  const first = !(await PayoutMethod.exists({ user: req.user._id }));
  const m = await PayoutMethod.create({
    ...doc, user: req.user._id, secret: payouts.seal(secret),
    nameMatches: idName ? payouts.namesMatch(doc.holderName, idName) : false,
    isDefault: first,
  });
  res.status(201).json({ method: payouts.shape(m), message: 'Saved. Verify it to show the verified badge to clients.' });
}));

router.post('/:id/reveal', limits.sensitive, asyncHandler(async (req, res) => {
  const m = await load(req, '+secret');
  const me = await User.findById(req.user._id).select('+password');
  if (me.password && !(await me.matchPassword(req.body.password))) throw forbidden('That password isn’t right');
  res.setHeader('Cache-Control', 'no-store');
  res.json({ details: payouts.open(m.secret) || {} });
}));

router.post('/:id/email-code', limits.sensitive, asyncHandler(async (req, res) => {
  const m = await load(req, '+secret');
  if (!['payoneer', 'wise'].includes(m.type)) throw badRequest('Only Payoneer and Wise accounts are confirmed by email');
  const details = payouts.open(m.secret);
  const code = String(crypto.randomInt(100000, 1000000));
  await PayoutMethod.updateOne({ _id: m._id }, { $set: { 'emailCheck.codeHash': payouts.codeHash(code), 'emailCheck.expires': new Date(Date.now() + 15 * 60e3), 'emailCheck.attempts': 0 } });
  await email.send({
    to: details.email,
    subject: `${code} confirms this ${payouts.LABEL[m.type]} account on Aurelance`,
    html: email.layout({
      heading: `Confirm your ${payouts.LABEL[m.type]} email`,
      intro: `${email.esc(req.user.name)} is adding this ${payouts.LABEL[m.type]} account to receive payments on Aurelance. Enter this code to confirm you own it. It expires in 15 minutes.<br><br><span style="font:600 30px/1 'Courier New',monospace;letter-spacing:6px;color:#10201A">${code}</span><br><br>If this wasn’t you, ignore this email.`,
    }),
  });
  res.json({ message: `We sent a 6-digit code to ${payouts.maskEmail(details.email)}.` });
}));

router.post('/:id/email-confirm', limits.sensitive, asyncHandler(async (req, res) => {
  const m = await load(req, '+emailCheck.codeHash +emailCheck.expires +emailCheck.attempts');
  const ec = m.emailCheck || {};
  if (!ec.codeHash || !ec.expires || ec.expires < new Date()) throw badRequest('That code expired. Send a new one.');
  if ((ec.attempts || 0) >= 5) throw badRequest('Too many wrong codes. Send a new one.');
  if (payouts.codeHash(String(req.body.code || '').trim()) !== ec.codeHash) {
    await PayoutMethod.updateOne({ _id: m._id }, { $inc: { 'emailCheck.attempts': 1 } });
    throw badRequest('That code isn’t right');
  }
  await PayoutMethod.updateOne({ _id: m._id }, { $set: { 'emailCheck.confirmedAt': new Date() }, $unset: { 'emailCheck.codeHash': 1, 'emailCheck.expires': 1 } });
  res.json({ method: payouts.shape(await PayoutMethod.findById(m._id).lean()), message: 'Email confirmed.' });
}));

router.post('/:id/verify', limits.sensitive, asyncHandler(async (req, res) => {
  const m = await load(req);
  if (m.status === 'verified') throw badRequest('This method is already verified');
  if (m.status === 'pending') throw badRequest('This method is already being reviewed');
  if (req.user.identity?.status !== 'approved') throw badRequest('Verify your identity first (Settings → Verification). We match payout names against it.');
  const idName = await identityName(req.user._id);
  const matches = payouts.namesMatch(m.holderName, idName);
  if (!matches) throw badRequest(`The account holder name “${m.holderName}” doesn’t match your verified name “${idName}”. Payouts can only go to an account in your own name.`);
  if (['payoneer', 'wise'].includes(m.type) && !m.emailCheck?.confirmedAt) throw badRequest('Confirm the account email first');

  const proofKind = str(req.body.proofKind, 60);
  const mm = /^data:(image\/(?:jpeg|png|webp)|application\/pdf);base64,(.+)$/.exec(String(req.body.proof || ''));
  if (!mm) throw badRequest('Attach the proof as a JPG, PNG, WEBP or PDF');
  const buf = Buffer.from(mm[2], 'base64');
  if (buf.length < 8 * 1024) throw badRequest('That file looks too small to read');
  if (buf.length > MAX_PROOF) throw badRequest('The proof must be under 1.5 MB');

  m.proof = { ...vault.encrypt(buf), type: mm[1] };
  m.proofKind = proofKind;
  m.status = 'pending';
  m.nameMatches = true;
  m.submittedAt = new Date();
  m.reviewNote = '';
  await m.save();

  if (env.ADMIN_EMAILS.length) {
    email.send({
      to: env.ADMIN_EMAILS[0], subject: `Payout method to review: ${req.user.name}`,
      html: email.layout({ heading: 'New payout method', intro: `${email.esc(req.user.name)} submitted a ${email.esc(payouts.LABEL[m.type])} account for review.`, action: { label: 'Open review queue', url: `${env.CLIENT_URL}/admin` } }),
    }).catch(() => {});
  }
  res.json({ method: payouts.shape(m), message: 'Submitted for review. Usually within one business day.' });
}));

router.post('/:id/default', asyncHandler(async (req, res) => {
  const m = await load(req);
  await PayoutMethod.updateMany({ user: req.user._id }, { $set: { isDefault: false } });
  await PayoutMethod.updateOne({ _id: m._id }, { $set: { isDefault: true } });
  res.json({ ok: true });
}));

router.delete('/:id', asyncHandler(async (req, res) => {
  const m = await load(req);
  await PayoutMethod.deleteOne({ _id: m._id });
  await Engagement.updateMany({ 'sharedPayout.method': m._id }, { $unset: { sharedPayout: 1 } });
  if (m.isDefault) {
    const next = await PayoutMethod.findOne({ user: req.user._id }).sort({ createdAt: 1 });
    if (next) { next.isDefault = true; await next.save(); }
  }
  await syncUserTypes(req.user._id);
  res.json({ message: 'Removed. It’s no longer shared on any contract.' });
}));

router.syncUserTypes = syncUserTypes;
module.exports = router;
