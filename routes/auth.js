// routes/auth.js
const router  = require('express').Router();
const jwt     = require('jsonwebtoken');
const crypto  = require('crypto');
const User    = require('../models/User');
const { protect } = require('../middleware/auth');

const signToken = (id) =>
  jwt.sign({ id }, process.env.JWT_SECRET, { expiresIn: process.env.JWT_EXPIRES_IN || '7d' });

// ── POST /api/auth/register ────────────────────────
router.post('/register', async (req, res, next) => {
  try {
    const { name, email, password } = req.body;
    if (!name || !email || !password)
      return res.status(400).json({ error: 'Name, email and password are required' });
    if (password.length < 6)
      return res.status(400).json({ error: 'Password must be at least 6 characters' });

    const exists = await User.findOne({ email });
    if (exists) return res.status(400).json({ error: 'Email already registered' });

    const user  = await User.create({ name, email, password });
    const token = signToken(user._id);

    res.status(201).json({
      token,
      user: { _id: user._id, name: user.name, email: user.email, plan: user.plan, avatar: user.avatar },
    });
  } catch (err) { next(err); }
});

// ── POST /api/auth/login ───────────────────────────
router.post('/login', async (req, res, next) => {
  try {
    const { email, password } = req.body;
    if (!email || !password)
      return res.status(400).json({ error: 'Email and password are required' });

    const user = await User.findOne({ email }).select('+password');
    if (!user || !(await user.matchPassword(password)))
      return res.status(401).json({ error: 'Invalid email or password' });

    const token = signToken(user._id);
    res.json({
      token,
      user: { _id: user._id, name: user.name, email: user.email, plan: user.plan, avatar: user.avatar, hourlyRate: user.hourlyRate },
    });
  } catch (err) { next(err); }
});

// ── GET /api/auth/me ───────────────────────────────
router.get('/me', protect, async (req, res, next) => {
  try {
    const user = await User.findById(req.user._id);
    res.json({ user });
  } catch (err) { next(err); }
});

// ── PATCH /api/auth/me ─────────────────────────────
router.patch('/me', protect, async (req, res, next) => {
  try {
    const allowed = ['name','title','bio','phone','location','website','linkedin','github','twitter',
      'hourlyRate','minProject','availability','skills','languages','avatar','notifications'];
    const updates = {};
    allowed.forEach(f => { if (req.body[f] !== undefined) updates[f] = req.body[f]; });
    const user = await User.findByIdAndUpdate(req.user._id, updates, { new: true, runValidators: true });
    res.json({ user });
  } catch (err) { next(err); }
});

// ── PUT /api/auth/me (alias) ───────────────────────
router.put('/me', protect, async (req, res, next) => {
  try {
    const allowed = ['name','title','bio','phone','location','website','linkedin','github','twitter',
      'hourlyRate','minProject','availability','skills','languages','avatar','notifications'];
    const updates = {};
    allowed.forEach(f => { if (req.body[f] !== undefined) updates[f] = req.body[f]; });
    const user = await User.findByIdAndUpdate(req.user._id, updates, { new: true, runValidators: true });
    res.json({ user });
  } catch (err) { next(err); }
});

// ── POST /api/auth/change-password ────────────────
router.post('/change-password', protect, async (req, res, next) => {
  try {
    const { currentPassword, newPassword } = req.body;
    if (!currentPassword || !newPassword)
      return res.status(400).json({ error: 'Both passwords are required' });
    if (newPassword.length < 6)
      return res.status(400).json({ error: 'New password must be at least 6 characters' });

    const user = await User.findById(req.user._id).select('+password');
    if (!(await user.matchPassword(currentPassword)))
      return res.status(401).json({ error: 'Current password is incorrect' });

    user.password = newPassword;
    await user.save();
    res.json({ message: 'Password updated successfully' });
  } catch (err) { next(err); }
});

// ── POST /api/auth/forgot-password ────────────────
router.post('/forgot-password', async (req, res, next) => {
  try {
    const { email } = req.body;
    if (!email) return res.status(400).json({ error: 'Email is required' });

    const user = await User.findOne({ email });
    if (!user) return res.json({ message: 'If that email exists, a reset link has been sent.' });

    const resetToken  = crypto.randomBytes(32).toString('hex');
    const resetExpiry = new Date(Date.now() + 60 * 60 * 1000); // 1 hour

    user.resetPasswordToken  = resetToken;
    user.resetPasswordExpiry = resetExpiry;
    await user.save({ validateBeforeSave: false });

    // TODO: Send email — resetLink = `${process.env.CLIENT_URL}/reset-password?token=${resetToken}`
    console.log(`\n🔑 Password reset token for ${email}:\n   ${resetToken}\n`);

    res.json({ message: 'If that email exists, a reset link has been sent.' });
  } catch (err) { next(err); }
});

// ── POST /api/auth/reset-password ─────────────────
router.post('/reset-password', async (req, res, next) => {
  try {
    const { token, password } = req.body;
    if (!token || !password) return res.status(400).json({ error: 'Token and password required' });
    if (password.length < 6)  return res.status(400).json({ error: 'Password must be at least 6 characters' });

    const user = await User.findOne({
      resetPasswordToken:  token,
      resetPasswordExpiry: { $gt: new Date() },
    });

    if (!user) return res.status(400).json({ error: 'Invalid or expired reset token' });

    user.password            = password;
    user.resetPasswordToken  = undefined;
    user.resetPasswordExpiry = undefined;
    await user.save();

    res.json({ message: 'Password reset successfully. You can now sign in.' });
  } catch (err) { next(err); }
});

// ── POST /api/auth/resend-verification ────────────
router.post('/resend-verification', async (req, res, next) => {
  try {
    const { email } = req.body;
    if (!email) return res.status(400).json({ error: 'Email is required' });
    console.log(`📧 Resend verification email to: ${email}`);
    res.json({ message: 'Verification email sent.' });
  } catch (err) { next(err); }
});

// ── GET /api/auth/sessions ─────────────────────────
router.get('/sessions', protect, async (req, res, next) => {
  try {
    res.json({
      sessions: [{
        id:        'current',
        device:    req.headers['user-agent'] || 'Unknown device',
        ip:        req.ip,
        createdAt: new Date(),
        current:   true,
      }],
    });
  } catch (err) { next(err); }
});

// ── GET /api/auth/google ───────────────────────────
// Placeholder — configure with passport-google-oauth20 when ready
router.get('/google', (req, res) => {
  res.status(501).json({
    error: 'Google OAuth not yet configured',
    setup: 'Install passport-google-oauth20 and add GOOGLE_CLIENT_ID/SECRET to .env',
  });
});

router.get('/google/callback', (req, res) => {
  res.status(501).json({ error: 'Google OAuth callback not yet configured' });
});

// ── GET /api/auth/github ───────────────────────────
// Placeholder — configure with passport-github2 when ready
router.get('/github', (req, res) => {
  res.status(501).json({
    error: 'GitHub OAuth not yet configured',
    setup: 'Install passport-github2 and add GITHUB_CLIENT_ID/SECRET to .env',
  });
});

router.get('/github/callback', (req, res) => {
  res.status(501).json({ error: 'GitHub OAuth callback not yet configured' });
});

module.exports = router;