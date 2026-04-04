// routes/profile.js
const router  = require('express').Router();
const User    = require('../models/User');
const Invoice = require('../models/Invoice');
const { protect } = require('../middleware/auth');

router.use(protect);

// ── GET /api/profile ───────────────────────────────
router.get('/', async (req, res, next) => {
  try {
    const user = await User.findById(req.user._id);
    res.json({ user });
  } catch (err) { next(err); }
});

// ── PATCH /api/profile ─────────────────────────────
router.patch('/', async (req, res, next) => {
  try {
    const allowed = ['name','title','bio','phone','location','website',
      'linkedin','github','twitter','hourlyRate','minProject',
      'availability','skills','languages','avatar','notifications',
      'contractStatus','contractExpiry','contractValue','source','priority'];
    const updates = {};
    allowed.forEach(f => { if (req.body[f] !== undefined) updates[f] = req.body[f]; });
    const user = await User.findByIdAndUpdate(req.user._id, updates, { new: true });
    res.json({ user });
  } catch (err) { next(err); }
});

// ── GET /api/profile/reviews ───────────────────────
router.get('/reviews', async (req, res, next) => {
  try {
    // Placeholder — extend with a Review model later
    res.json({ reviews: [] });
  } catch (err) { next(err); }
});

// ── GET /api/profile/:id ───────────────────────────
router.get('/:id', async (req, res, next) => {
  try {
    const user = await User.findById(req.params.id)
      .select('-password -notifications');
    if (!user) return res.status(404).json({ error: 'Profile not found' });
    res.json({ user });
  } catch (err) { next(err); }
});

// ── GET /api/profile/:id/reviews ──────────────────
router.get('/:id/reviews', async (req, res, next) => {
  try {
    res.json({ reviews: [] });
  } catch (err) { next(err); }
});

module.exports = router;