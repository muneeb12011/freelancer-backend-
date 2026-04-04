// routes/settings.js
const router = require('express').Router();
const User   = require('../models/User');
const { protect } = require('../middleware/auth');

router.use(protect);

// ── GET /api/settings ──────────────────────────────
router.get('/', async (req, res, next) => {
  try {
    const user = await User.findById(req.user._id)
      .select('name email plan notifications availability hourlyRate');
    res.json({ settings: user });
  } catch (err) { next(err); }
});

// ── PATCH /api/settings ────────────────────────────
router.patch('/', async (req, res, next) => {
  try {
    const allowed = ['notifications','availability','hourlyRate','plan'];
    const updates = {};
    allowed.forEach(f => { if (req.body[f] !== undefined) updates[f] = req.body[f]; });
    const user = await User.findByIdAndUpdate(req.user._id, updates, { new: true });
    res.json({ settings: user });
  } catch (err) { next(err); }
});

// ── DELETE /api/settings/account ──────────────────
router.delete('/account', async (req, res, next) => {
  try {
    await User.findByIdAndDelete(req.user._id);
    res.json({ message: 'Account deleted successfully' });
  } catch (err) { next(err); }
});

module.exports = router;