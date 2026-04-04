// routes/proposals.js
const router   = require('express').Router();
const Proposal = require('../models/Proposal');
const { protect } = require('../middleware/auth');

router.use(protect);

// ── GET /api/proposals ─────────────────────────────
router.get('/', async (req, res, next) => {
  try {
    const proposals = await Proposal.find({ user: req.user._id })
      .sort({ createdAt: -1 });
    res.json({ proposals });
  } catch (err) { next(err); }
});

// ── POST /api/proposals ────────────────────────────
router.post('/', async (req, res, next) => {
  try {
    const { title } = req.body;
    if (!title?.trim()) return res.status(400).json({ error: 'Title is required' });

    const proposal = await Proposal.create({ ...req.body, user: req.user._id });
    res.status(201).json({ proposal });
  } catch (err) { next(err); }
});

// ── GET /api/proposals/:id ─────────────────────────
router.get('/:id', async (req, res, next) => {
  try {
    const proposal = await Proposal.findOne({ _id: req.params.id, user: req.user._id });
    if (!proposal) return res.status(404).json({ error: 'Proposal not found' });
    res.json({ proposal });
  } catch (err) { next(err); }
});

// ── PUT /api/proposals/:id ─────────────────────────
router.put('/:id', async (req, res, next) => {
  try {
    const proposal = await Proposal.findOneAndUpdate(
      { _id: req.params.id, user: req.user._id },
      { ...req.body },
      { new: true, runValidators: true }
    );
    if (!proposal) return res.status(404).json({ error: 'Proposal not found' });
    res.json({ proposal });
  } catch (err) { next(err); }
});

// ── PATCH /api/proposals/:id ───────────────────────
router.patch('/:id', async (req, res, next) => {
  try {
    const proposal = await Proposal.findOneAndUpdate(
      { _id: req.params.id, user: req.user._id },
      { ...req.body },
      { new: true }
    );
    if (!proposal) return res.status(404).json({ error: 'Proposal not found' });
    res.json({ proposal });
  } catch (err) { next(err); }
});

// ── DELETE /api/proposals/:id ──────────────────────
router.delete('/:id', async (req, res, next) => {
  try {
    await Proposal.findOneAndDelete({ _id: req.params.id, user: req.user._id });
    res.json({ message: 'Proposal deleted' });
  } catch (err) { next(err); }
});

module.exports = router;
