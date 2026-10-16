// routes/verification.js — trust badges.
//   GET  /api/verification            → steps + status
//   POST /api/verification/identity   { fullName, country, docType, front, back?, selfie }  (data URLs, JPEG/PNG/WEBP, ≤ 1.2 MB each)
//   DELETE /api/verification/identity → cancel a pending submission
const router = require('express').Router();
const IdentityVerification = require('../models/IdentityVerification');
const vault = require('../services/vault');
const env = require('../config/env');
const email = require('../services/email');
const limits = require('../middleware/rateLimits');
const { protect } = require('../middleware/auth');
const { asyncHandler, badRequest } = require('../utils/http');
const { str } = require('../utils/sanitize');

router.use(protect);

const MAX_IMG = 1.2 * 1024 * 1024;

function parseImage(dataUrl, label, required = true) {
  if (!dataUrl) { if (required) throw badRequest(`Add the ${label}`); return undefined; }
  const m = /^data:(image\/(?:jpeg|png|webp));base64,(.+)$/.exec(String(dataUrl));
  if (!m) throw badRequest(`The ${label} must be a JPG, PNG or WEBP image`);
  const buf = Buffer.from(m[2], 'base64');
  if (buf.length < 10 * 1024) throw badRequest(`The ${label} looks too small to read — use a clearer photo`);
  if (buf.length > MAX_IMG) throw badRequest(`The ${label} must be under 1.2 MB`);
  return { ...vault.encrypt(buf), type: m[1] };
}

router.get('/', asyncHandler(async (req, res) => {
  const u = req.user;
  const last = await IdentityVerification.findOne({ user: u._id }).sort({ createdAt: -1 }).select('status reason createdAt reviewedAt docType').lean();
  res.json({
    badges: u.badges(),
    identityEnabled: vault.enabled(),
    steps: [
      { id: 'email', done: u.emailVerified, label: 'Email confirmed' },
      { id: 'linked', done: Boolean(u.googleId || u.githubId), label: 'Google or GitHub linked', providers: { google: Boolean(u.googleId), github: Boolean(u.githubId) } },
      { id: 'identity', done: u.identity?.status === 'approved', status: u.identity?.status || 'none', label: 'Identity checked', last },
    ],
  });
}));

router.post('/identity', limits.sensitive, asyncHandler(async (req, res) => {
  if (!vault.enabled()) throw Object.assign(new Error('Identity checks aren’t open yet. Try again soon.'), { statusCode: 503 });
  if (req.user.identity?.status === 'approved') throw badRequest('Your identity is already verified');
  if (req.user.identity?.status === 'pending') throw badRequest('Your documents are already being reviewed');
  if (!req.user.emailVerified) throw badRequest('Confirm your email first');

  const fullName = str(req.body.fullName, 120);
  const country = str(req.body.country, 60);
  const docType = req.body.docType;
  if (fullName.length < 3) throw badRequest('Enter your full name exactly as it appears on the document');
  if (!country) throw badRequest('Choose the country that issued the document');
  if (!['cnic', 'passport', 'driving_license', 'national_id'].includes(docType)) throw badRequest('Choose a document type');
  if (req.body.consent !== true) throw badRequest('Agree to the verification terms to continue');

  const doc = await IdentityVerification.create({
    user: req.user._id, fullName, country, docType,
    front: parseImage(req.body.front, 'front of the document'),
    back: parseImage(req.body.back, 'back of the document', docType !== 'passport'),
    selfie: parseImage(req.body.selfie, 'selfie holding the document'),
  });
  req.user.identity = { status: 'pending', submittedAt: new Date(), note: '' };
  await req.user.save();

  if (env.ADMIN_EMAILS.length) {
    email.send({
      to: env.ADMIN_EMAILS[0],
      subject: `ID verification to review: ${req.user.name}`,
      html: email.layout({ heading: 'New verification', intro: `${email.esc(req.user.name)} (${email.esc(req.user.email)}) submitted a ${email.esc(docType)} from ${email.esc(country)}.`, action: { label: 'Open review queue', url: `${env.CLIENT_URL}/admin` } }),
    }).catch(() => {});
  }
  res.status(201).json({ message: 'Submitted. Reviews usually take one business day.', id: doc._id, user: req.user.toClient() });
}));

router.delete('/identity', asyncHandler(async (req, res) => {
  const doc = await IdentityVerification.findOne({ user: req.user._id, status: 'pending' });
  if (doc) await IdentityVerification.deleteOne({ _id: doc._id });
  if (req.user.identity?.status === 'pending') { req.user.identity.status = 'none'; await req.user.save(); }
  res.json({ message: 'Submission cancelled and your documents were deleted.', user: req.user.toClient() });
}));

module.exports = router;
