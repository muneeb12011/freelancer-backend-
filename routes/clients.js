// routes/clients.js
const router  = require('express').Router();
const Client  = require('../models/Client');
const { protect } = require('../middleware/auth');

router.use(protect);

// ── GET /api/clients ───────────────────────────────
router.get('/', async (req, res, next) => {
  try {
    const { status, limit = 300, search } = req.query;
    const filter = { user: req.user._id };
    if (status) filter.status = status;
    if (search) {
      const re = new RegExp(search, 'i');
      filter.$or = [{ name: re }, { email: re }, { company: re }, { tags: re }];
    }
    const clients = await Client.find(filter).sort({ updatedAt: -1 }).limit(+limit);
    res.json({ clients });
  } catch (err) { next(err); }
});

// ── POST /api/clients ──────────────────────────────
router.post('/', async (req, res, next) => {
  try {
    const client = await Client.create({ ...req.body, user: req.user._id });
    res.status(201).json({ client });
  } catch (err) { next(err); }
});

// ── GET /api/clients/:id ───────────────────────────
router.get('/:id', async (req, res, next) => {
  try {
    const client = await Client.findOne({ _id: req.params.id, user: req.user._id });
    if (!client) return res.status(404).json({ error: 'Client not found' });
    res.json({ client });
  } catch (err) { next(err); }
});

// ── PATCH /api/clients/:id ─────────────────────────
router.patch('/:id', async (req, res, next) => {
  try {
    const client = await Client.findOneAndUpdate(
      { _id: req.params.id, user: req.user._id },
      { ...req.body, updatedAt: Date.now() },
      { new: true, runValidators: true }
    );
    if (!client) return res.status(404).json({ error: 'Client not found' });
    res.json({ client });
  } catch (err) { next(err); }
});

// ── DELETE /api/clients/:id ────────────────────────
router.delete('/:id', async (req, res, next) => {
  try {
    const client = await Client.findOneAndDelete({ _id: req.params.id, user: req.user._id });
    if (!client) return res.status(404).json({ error: 'Client not found' });
    res.json({ message: 'Client deleted' });
  } catch (err) { next(err); }
});

// ── POST /api/clients/email ────────────────────────
router.post('/email', async (req, res, next) => {
  try {
    // Placeholder — integrate with SendGrid/Mailgun/Resend here
    const { clientId, subject, body } = req.body;
    res.json({ message: 'Email queued (integrate mailer here)', clientId, subject });
  } catch (err) { next(err); }
});

module.exports = router;
