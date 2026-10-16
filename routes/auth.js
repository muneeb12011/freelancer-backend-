// routes/auth.js — registration, sign-in (password, OAuth, email 2FA), sessions,
// password reset, email verification/change, account deletion.
const router   = require('express').Router();
const jwt      = require('jsonwebtoken');
const passport = require('../config/passport');
const env      = require('../config/env');
const User     = require('../models/User');
const Session  = require('../models/Session');
const OAuthCode = require('../models/OAuthCode');
const email    = require('../services/email');
const account  = require('../services/account');
const limits   = require('../middleware/rateLimits');
const { protect } = require('../middleware/auth');
const { asyncHandler, badRequest, unauthorized, notFound } = require('../utils/http');
const { isEmail, str, pick, isId } = require('../utils/sanitize');
const { sha256, randomToken, randomCode, safeEqual, issueSession } = require('../utils/tokens');

const PASSWORD_MIN = 8;
const PROFILE_FIELDS = ['name', 'title', 'bio', 'phone', 'location', 'website', 'linkedin', 'github', 'twitter',
  'hourlyRate', 'minProject', 'availability', 'skills', 'languages', 'avatar', 'socialLinks', 'discoverable'];

const checkPassword = (pw) => {
  if (typeof pw !== 'string' || pw.length < PASSWORD_MIN) throw badRequest(`Password must be at least ${PASSWORD_MIN} characters`);
  if (pw.length > 128) throw badRequest('Password is too long');
};

async function respondWithSession(req, res, user, method, status = 200) {
  const { token } = await issueSession(user, req, method);
  user.lastLoginAt = new Date();
  await user.save();
  res.status(status).json({ token, user: user.toClient() });
}

/** Sets a fresh verification token on `user` (caller saves) and returns the email to send. */
function prepareVerification(user) {
  const raw = randomToken();
  user.verifyToken = sha256(raw);
  user.verifyExpiry = new Date(Date.now() + 48 * 3600e3);
  return { to: user.email, ...email.templates.verifyEmail(user.name, `${env.CLIENT_URL}/verify-email?token=${raw}`) };
}

// ── GET /api/auth/providers — which sign-in methods are live ─────────────
router.get('/providers', (req, res) => {
  res.json({ password: true, google: env.features.google, github: env.features.github });
});

// ── POST /api/auth/register ─────────────────────────────────────────────
router.post('/register', limits.auth, asyncHandler(async (req, res) => {
  const name = str(req.body.name, 80);
  const mail = str(req.body.email, 254).toLowerCase();
  const { password } = req.body;
  if (!name) throw badRequest('Enter your name');
  if (!isEmail(mail)) throw badRequest('Enter a valid email address');
  checkPassword(password);

  if (await User.exists({ email: mail })) throw Object.assign(badRequest('An account with this email already exists. Sign in instead.'), { statusCode: 409 });

  const user = new User({ name, email: mail, password });
  if (isId(req.body.ref) && await User.exists({ _id: req.body.ref })) user.referredBy = req.body.ref;
  const verification = prepareVerification(user);
  await user.save();
  email.send(verification).catch(() => {});
  await respondWithSession(req, res, user, 'password', 201);
}));

// ── POST /api/auth/login ────────────────────────────────────────────────
router.post('/login', limits.auth, asyncHandler(async (req, res) => {
  const mail = str(req.body.email, 254).toLowerCase();
  const { password } = req.body;
  if (!mail || !password) throw badRequest('Enter your email and password');

  const user = await User.findOne({ email: mail }).select('+password +twoFactor.codeHash +twoFactor.expires +twoFactor.attempts');
  if (!user || !(await user.matchPassword(password))) throw unauthorized('Email or password is incorrect');

  if (user.twoFactor?.enabled) {
    const code = randomCode();
    user.twoFactor.codeHash = sha256(code);
    user.twoFactor.expires = new Date(Date.now() + 10 * 60e3);
    user.twoFactor.attempts = 0;
    await user.save();
    await email.send({ to: user.email, ...email.templates.twoFactorCode(user.name, code) });
    const challenge = jwt.sign({ id: String(user._id), purpose: '2fa' }, env.JWT_SECRET, { expiresIn: '10m' });
    return res.json({ twoFactorRequired: true, challenge, email: user.email.replace(/(.{2}).+(@.+)/, '$1•••$2') });
  }

  if (user.loginAlerts && user.lastLoginAt) {
    const ua = String(req.headers['user-agent'] || '');
    const seen = await Session.exists({ user: user._id, userAgent: ua.slice(0, 300) });
    if (!seen) {
      const { describeDevice } = require('../utils/tokens');
      email.send({ to: user.email, ...email.templates.newSignIn(user.name, describeDevice(ua), req.ip, new Date().toUTCString()) }).catch(() => {});
    }
  }
  await respondWithSession(req, res, user, 'password');
}));

// ── POST /api/auth/2fa/login — second step of sign-in ───────────────────
router.post('/2fa/login', limits.auth, asyncHandler(async (req, res) => {
  const { challenge, code } = req.body;
  let decoded;
  try { decoded = jwt.verify(String(challenge || ''), env.JWT_SECRET); } catch { throw unauthorized('Your sign-in code expired. Sign in again.'); }
  if (decoded.purpose !== '2fa') throw unauthorized('Invalid sign-in challenge');

  const user = await User.findById(decoded.id).select('+twoFactor.codeHash +twoFactor.expires +twoFactor.attempts');
  if (!user || !user.twoFactor?.codeHash) throw unauthorized('Sign in again to get a new code');
  if (user.twoFactor.expires < new Date()) throw unauthorized('That code expired. Sign in again to get a new one.');
  if ((user.twoFactor.attempts || 0) >= 5) throw unauthorized('Too many wrong codes. Sign in again to get a new one.');

  if (!safeEqual(sha256(String(code || '').trim()), user.twoFactor.codeHash)) {
    user.twoFactor.attempts = (user.twoFactor.attempts || 0) + 1;
    await user.save();
    throw unauthorized('That code is not right. Check the latest email.');
  }
  user.twoFactor.codeHash = undefined;
  user.twoFactor.expires = undefined;
  user.twoFactor.attempts = 0;
  await respondWithSession(req, res, user, '2fa');
}));

// ── Current user ────────────────────────────────────────────────────────
router.get('/me', protect, (req, res) => res.json({ user: req.user.toClient() }));

const updateMe = asyncHandler(async (req, res) => {
  const updates = pick(req.body, PROFILE_FIELDS);
  if (updates.name !== undefined && !str(updates.name)) throw badRequest('Name cannot be empty');
  Object.assign(req.user, updates);
  await req.user.save();
  res.json({ user: req.user.toClient() });
});
router.patch('/me', protect, updateMe);
router.put('/me', protect, updateMe);

// ── POST /api/auth/verify-password — re-confirm identity before sensitive actions ──
router.post('/verify-password', protect, limits.sensitive, asyncHandler(async (req, res) => {
  const user = await User.findById(req.user._id).select('+password');
  if (user.authProvider !== 'local' && !req.body.password) return res.json({ ok: true }); // OAuth-only accounts
  if (!(await user.matchPassword(req.body.password))) throw unauthorized('Password is incorrect');
  return res.json({ ok: true });
}));

// ── POST /api/auth/logout — revoke this device's session ────────────────
router.post('/logout', protect, asyncHandler(async (req, res) => {
  if (req.session) await Session.updateOne({ _id: req.session._id }, { revokedAt: new Date() });
  res.json({ message: 'Signed out' });
}));

// ── Sessions ────────────────────────────────────────────────────────────
router.get('/sessions', protect, asyncHandler(async (req, res) => {
  const rows = await Session.find({ user: req.user._id, revokedAt: null, expiresAt: { $gt: new Date() } })
    .sort({ lastSeenAt: -1 }).limit(50).lean();
  res.json({
    sessions: rows.map((s) => ({
      _id: s._id, id: s._id, device: s.device, userAgent: s.userAgent, ip: s.ip, method: s.method,
      createdAt: s.createdAt, lastSeenAt: s.lastSeenAt, current: req.session && String(s._id) === String(req.session._id),
    })),
  });
}));

router.delete('/sessions/:id', protect, asyncHandler(async (req, res) => {
  const r = await Session.updateOne({ _id: req.params.id, user: req.user._id, revokedAt: null }, { revokedAt: new Date() });
  if (!r.matchedCount) throw notFound('Session not found');
  res.json({ message: 'Device signed out' });
}));

router.post('/sessions/revoke-others', protect, asyncHandler(async (req, res) => {
  const r = await Session.updateMany(
    { user: req.user._id, revokedAt: null, ...(req.session ? { _id: { $ne: req.session._id } } : {}) },
    { revokedAt: new Date() },
  );
  res.json({ message: `Signed out ${r.modifiedCount} other device${r.modifiedCount === 1 ? '' : 's'}` });
}));

// ── POST /api/auth/change-password ──────────────────────────────────────
router.post('/change-password', protect, limits.sensitive, asyncHandler(async (req, res) => {
  const { currentPassword, newPassword } = req.body;
  checkPassword(newPassword);
  const user = await User.findById(req.user._id).select('+password');
  const isOAuthOnly = user.authProvider !== 'local' && !currentPassword;
  if (!isOAuthOnly && !(await user.matchPassword(currentPassword))) throw unauthorized('Current password is incorrect');
  user.password = newPassword;
  await user.save();
  // Keep this device signed in, sign out every other one.
  await Session.updateMany({ user: user._id, revokedAt: null, ...(req.session ? { _id: { $ne: req.session._id } } : {}) }, { revokedAt: new Date() });
  res.json({ message: 'Password changed. Other devices were signed out.' });
}));

// ── Password reset ──────────────────────────────────────────────────────
router.post('/forgot-password', limits.sensitive, asyncHandler(async (req, res) => {
  const mail = str(req.body.email, 254).toLowerCase();
  if (!isEmail(mail)) throw badRequest('Enter a valid email address');
  const generic = { message: 'If an account exists for that email, a reset link is on its way.' };

  const user = await User.findOne({ email: mail });
  if (!user) return res.json(generic);

  const raw = randomToken();
  user.resetPasswordToken = sha256(raw);
  user.resetPasswordExpiry = new Date(Date.now() + 3600e3);
  await user.save({ validateBeforeSave: false });
  await email.send({ to: user.email, ...email.templates.passwordReset(user.name, `${env.CLIENT_URL}/reset-password?token=${raw}`) });
  return res.json(generic);
}));

router.post('/reset-password', limits.sensitive, asyncHandler(async (req, res) => {
  const { token, password } = req.body;
  if (!token) throw badRequest('Reset link is missing its token');
  checkPassword(password);
  const user = await User.findOne({ resetPasswordToken: sha256(token), resetPasswordExpiry: { $gt: new Date() } });
  if (!user) throw badRequest('This reset link is invalid or has expired. Request a new one.');

  user.password = password;
  user.resetPasswordToken = undefined;
  user.resetPasswordExpiry = undefined;
  user.tokenVersion = (user.tokenVersion || 0) + 1; // invalidates every existing token
  user.emailVerified = true; // they proved inbox access
  await user.save();
  await Session.updateMany({ user: user._id, revokedAt: null }, { revokedAt: new Date() });
  res.json({ message: 'Password updated. Sign in with your new password.' });
}));

// ── Email verification ──────────────────────────────────────────────────
router.post('/verify-email', asyncHandler(async (req, res) => {
  const user = await User.findOne({ verifyToken: sha256(req.body.token || ''), verifyExpiry: { $gt: new Date() } });
  if (!user) throw badRequest('This confirmation link is invalid or has expired.');
  user.emailVerified = true;
  user.verifyToken = undefined;
  user.verifyExpiry = undefined;
  await user.save();
  res.json({ message: 'Email confirmed.' });
}));

router.post('/resend-verification', protect, limits.sensitive, asyncHandler(async (req, res) => {
  if (req.user.emailVerified) return res.json({ message: 'Your email is already confirmed.' });
  const verification = prepareVerification(req.user);
  await req.user.save();
  await email.send(verification);
  return res.json({ message: `Confirmation email sent to ${req.user.email}.` });
}));

// ── Email change (confirmed from the new inbox) ─────────────────────────
router.post('/change-email', protect, limits.sensitive, asyncHandler(async (req, res) => {
  const newEmail = str(req.body.newEmail, 254).toLowerCase();
  if (!isEmail(newEmail)) throw badRequest('Enter a valid email address');
  if (newEmail === req.user.email) throw badRequest('That is already your email');
  const user = await User.findById(req.user._id).select('+password');
  if (user.authProvider === 'local' && !(await user.matchPassword(req.body.password))) throw unauthorized('Password is incorrect');
  if (await User.exists({ email: newEmail })) throw Object.assign(badRequest('Another account already uses that email'), { statusCode: 409 });

  const raw = randomToken();
  user.pendingEmail = newEmail;
  user.emailChangeToken = sha256(raw);
  user.emailChangeExpiry = new Date(Date.now() + 24 * 3600e3);
  await user.save();
  await email.send({ to: newEmail, ...email.templates.emailChange(user.name, `${env.CLIENT_URL}/confirm-email?token=${raw}`, newEmail) });
  res.json({ message: `Check ${newEmail} to confirm the change.` });
}));

router.post('/confirm-email-change', asyncHandler(async (req, res) => {
  const user = await User.findOne({ emailChangeToken: sha256(req.body.token || ''), emailChangeExpiry: { $gt: new Date() } }).select('+pendingEmail');
  if (!user || !user.pendingEmail) throw badRequest('This link is invalid or has expired.');
  if (await User.exists({ email: user.pendingEmail, _id: { $ne: user._id } })) throw badRequest('Another account already uses that email');
  user.email = user.pendingEmail;
  user.emailVerified = true;
  user.pendingEmail = undefined;
  user.emailChangeToken = undefined;
  user.emailChangeExpiry = undefined;
  await user.save();
  res.json({ message: 'Email updated.', email: user.email });
}));

// ── Two-factor (email code) settings ────────────────────────────────────
router.post('/2fa/send', protect, limits.sensitive, asyncHandler(async (req, res) => {
  const user = await User.findById(req.user._id).select('+twoFactor.codeHash +twoFactor.expires +twoFactor.attempts');
  const code = randomCode();
  user.twoFactor.codeHash = sha256(code);
  user.twoFactor.expires = new Date(Date.now() + 10 * 60e3);
  user.twoFactor.attempts = 0;
  await user.save();
  await email.send({ to: user.email, ...email.templates.twoFactorCode(user.name, code) });
  res.json({ message: `Code sent to ${user.email}` });
}));

router.post('/2fa/verify', protect, asyncHandler(async (req, res) => {
  const user = await User.findById(req.user._id).select('+twoFactor.codeHash +twoFactor.expires +twoFactor.attempts');
  if (!user.twoFactor?.codeHash || user.twoFactor.expires < new Date()) throw badRequest('Code expired. Send a new one.');
  if ((user.twoFactor.attempts || 0) >= 5) throw badRequest('Too many attempts. Send a new code.');
  if (!safeEqual(sha256(String(req.body.code || '').trim()), user.twoFactor.codeHash)) {
    user.twoFactor.attempts += 1;
    await user.save();
    throw badRequest('That code is not right');
  }
  user.twoFactor.enabled = true;
  user.twoFactor.codeHash = undefined;
  user.twoFactor.expires = undefined;
  await user.save();
  res.json({ message: 'Two-step sign-in is on', user: user.toClient() });
}));

router.post('/2fa/disable', protect, limits.sensitive, asyncHandler(async (req, res) => {
  const user = await User.findById(req.user._id).select('+password');
  if (user.authProvider === 'local' && !(await user.matchPassword(req.body.password))) throw unauthorized('Password is incorrect');
  user.twoFactor.enabled = false;
  await user.save();
  res.json({ message: 'Two-step sign-in is off', user: user.toClient() });
}));

// ── DELETE /api/auth/account ────────────────────────────────────────────
router.delete('/account', protect, limits.sensitive, asyncHandler(async (req, res) => {
  if (req.body?.confirm !== 'DELETE') throw badRequest('Type DELETE to confirm');
  const user = await User.findById(req.user._id).select('+password');
  if (user.authProvider === 'local' && !(await user.matchPassword(req.body.password))) throw unauthorized('Password is incorrect');
  await account.deleteAccount(user._id);
  res.json({ message: 'Your account and its data were deleted.' });
}));

// ── OAuth ───────────────────────────────────────────────────────────────
const oauthFail = (provider) => `${env.CLIENT_URL}/login?error=${provider}_failed`;

async function oauthSuccess(req, res, provider) {
  try {
    const { token } = await issueSession(req.user, req, provider);
    req.user.lastLoginAt = new Date();
    await req.user.save();
    const code = randomToken(24);
    await OAuthCode.create({ codeHash: sha256(code), token, user: req.user._id, expiresAt: new Date(Date.now() + 2 * 60e3) });
    res.redirect(`${env.CLIENT_URL}/auth/callback?code=${code}`);
  } catch {
    res.redirect(`${env.CLIENT_URL}/login?error=oauth_error`);
  }
}

const providerGuard = (provider) => (req, res, next) => (
  env.features[provider] ? next() : res.redirect(`${env.CLIENT_URL}/login?error=${provider}_unavailable`)
);

router.get('/google', providerGuard('google'), passport.authenticate('google', { scope: ['profile', 'email'], session: false, prompt: 'select_account' }));
router.get('/google/callback', providerGuard('google'),
  passport.authenticate('google', { session: false, failureRedirect: oauthFail('google') }),
  (req, res) => oauthSuccess(req, res, 'google'));

router.get('/github', providerGuard('github'), passport.authenticate('github', { scope: ['user:email'], session: false }));
router.get('/github/callback', providerGuard('github'),
  passport.authenticate('github', { session: false, failureRedirect: oauthFail('github') }),
  (req, res) => oauthSuccess(req, res, 'github'));

// Frontend swaps the one-time code for the real token.
router.post('/oauth/exchange', limits.auth, asyncHandler(async (req, res) => {
  const doc = await OAuthCode.findOneAndDelete({ codeHash: sha256(req.body.code || ''), expiresAt: { $gt: new Date() } });
  if (!doc) throw unauthorized('Sign-in link expired. Try again.');
  const user = await User.findById(doc.user);
  if (!user) throw unauthorized('Account not found');
  res.json({ token: doc.token, user: user.toClient() });
}));

module.exports = router;
