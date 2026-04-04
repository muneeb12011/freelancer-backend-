// routes/notes.js — Atelier Quick Notes
const router = require('express').Router();
const Note   = require('../models/Note');
const { protect } = require('../middleware/auth');

router.use(protect);

// ── GET /api/notes ─────────────────────────────────
router.get('/', async (req, res, next) => {
  try {
    const { cat, limit = 100 } = req.query;
    const filter = { user: req.user._id };
    if (cat && cat !== 'All') filter.cat = cat;

    const notes = await Note.find(filter)
      .sort({ pinned: -1, createdAt: -1 })
      .limit(+limit);
    res.json({ notes });
  } catch (err) { next(err); }
});

// ── POST /api/notes ────────────────────────────────
router.post('/', async (req, res, next) => {
  try {
    const { text, cat = 'General', pinned = false } = req.body;
    if (!text?.trim()) return res.status(400).json({ error: 'Note text is required' });

    const note = await Note.create({
      user: req.user._id,
      text: text.trim(),
      cat,
      pinned,
      ts: new Date().toLocaleString(),
    });
    res.status(201).json({ note });
  } catch (err) { next(err); }
});

// ── PATCH /api/notes/:id ───────────────────────────
router.patch('/:id', async (req, res, next) => {
  try {
    const note = await Note.findOneAndUpdate(
      { _id: req.params.id, user: req.user._id },
      { ...req.body },
      { new: true }
    );
    if (!note) return res.status(404).json({ error: 'Note not found' });
    res.json({ note });
  } catch (err) { next(err); }
});

// ── DELETE /api/notes/:id ──────────────────────────
router.delete('/:id', async (req, res, next) => {
  try {
    await Note.findOneAndDelete({ _id: req.params.id, user: req.user._id });
    res.json({ message: 'Note deleted' });
  } catch (err) { next(err); }
});

// ── DELETE /api/notes ─── bulk clear ──────────────
router.delete('/', async (req, res, next) => {
  try {
    await Note.deleteMany({ user: req.user._id });
    res.json({ message: 'All notes cleared' });
  } catch (err) { next(err); }
});

module.exports = router;
