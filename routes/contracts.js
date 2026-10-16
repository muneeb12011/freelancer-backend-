// routes/contracts.js
const router   = require('express').Router();
const Contract = require('../models/Contract');
const { protect, requirePremium } = require('../middleware/auth');
const { stripProtected, clampInt, str } = require('../utils/sanitize');

router.use(protect);
// Premium tool — the API enforces it, not just the UI.
router.use(requirePremium('contracts'));

// ── GET /api/contracts ─────────────────────────────
router.get('/', async (req, res, next) => {
  try {
    const contracts = await Contract.find({ user: req.user._id })
      .sort({ createdAt: -1 });
    res.json({ contracts });
  } catch (err) { next(err); }
});

// ── POST /api/contracts ────────────────────────────
router.post('/', async (req, res, next) => {
  try {
    const { title, content, client, status } = req.body;
    if (!title?.trim()) return res.status(400).json({ error: 'Title is required' });

    const contract = await Contract.create({
      user: req.user._id, title, content: content || '',
      client: client || '', status: status || 'draft',
    });
    res.status(201).json({ contract });
  } catch (err) { next(err); }
});

// ── GET /api/contracts/:id ─────────────────────────
router.get('/:id', async (req, res, next) => {
  try {
    const contract = await Contract.findOne({ _id: req.params.id, user: req.user._id });
    if (!contract) return res.status(404).json({ error: 'Contract not found' });
    res.json({ contract });
  } catch (err) { next(err); }
});

// ── PUT /api/contracts/:id ─────────────────────────
const updateContract = async (req, res, next) => {
  try {
    const updates = stripProtected(req.body);

    // Auto-set signedAt when signing
    if (updates.signed && !updates.signedAt) {
      updates.signedAt = new Date();
      updates.status   = 'signed';
    }

    const contract = await Contract.findOneAndUpdate(
      { _id: req.params.id, user: req.user._id },
      updates,
      { new: true, runValidators: true }
    );
    if (!contract) return res.status(404).json({ error: 'Contract not found' });
    res.json({ contract });
  } catch (err) { next(err); }
};
router.put('/:id', updateContract);
router.patch('/:id', updateContract);

// ── DELETE /api/contracts/:id ──────────────────────
router.delete('/:id', async (req, res, next) => {
  try {
    await Contract.findOneAndDelete({ _id: req.params.id, user: req.user._id });
    res.json({ message: 'Contract deleted' });
  } catch (err) { next(err); }
});

module.exports = router;
