// routes/connections.js
const router     = require('express').Router();
const Connection = require('../models/Connection');
const { protect } = require('../middleware/auth');

router.use(protect);

// ── GET /api/connections ───────────────────────────
router.get('/', async (req, res, next) => {
  try {
    const conns = await Connection.find({ user: req.user._id })
      .select('-messages')
      .sort({ pinned: -1, updatedAt: -1 });
    res.json({ connections: conns });
  } catch (err) { next(err); }
});

// ── POST /api/connections ──────────────────────────
router.post('/', async (req, res, next) => {
  try {
    const conn = await Connection.create({ ...req.body, user: req.user._id });
    res.status(201).json({ connection: conn });
  } catch (err) { next(err); }
});

// ── GET /api/connections/suggestions ──────────────
router.get('/suggestions', async (req, res, next) => {
  try {
    // Return connections of connections (simple mock — expand with real logic)
    res.json({ suggestions: [] });
  } catch (err) { next(err); }
});

// ── GET /api/connections/activity ─────────────────
router.get('/activity', async (req, res, next) => {
  try {
    const recent = await Connection.find({ user: req.user._id })
      .select('name role updatedAt')
      .sort({ updatedAt: -1 })
      .limit(20);
    const activity = recent.map(c => ({
      _id: c._id, name: c.name, type: 'connection_updated',
      message: `${c.name} profile updated`, date: c.updatedAt,
    }));
    res.json({ activity });
  } catch (err) { next(err); }
});

// ── GET /api/connections/search ────────────────────
router.get('/search', async (req, res, next) => {
  try {
    const { q } = req.query;
    if (!q) return res.json({ results: [] });
    const re = new RegExp(q, 'i');
    const results = await Connection.find({
      user: req.user._id,
      $or: [{ name: re }, { role: re }, { skills: re }, { location: re }],
    }).select('-messages').limit(20);
    res.json({ results });
  } catch (err) { next(err); }
});

// ── GET /api/connections/requests/incoming ─────────
router.get('/requests/incoming', async (req, res, next) => {
  try {
    res.json({ requests: [] }); // Extend with a Request model if needed
  } catch (err) { next(err); }
});

// ── GET /api/connections/requests/sent ────────────
router.get('/requests/sent', async (req, res, next) => {
  try {
    res.json({ requests: [] });
  } catch (err) { next(err); }
});

// ── POST /api/connections/request ─────────────────
router.post('/request', async (req, res, next) => {
  try {
    res.json({ message: 'Request sent', ...req.body });
  } catch (err) { next(err); }
});

// ── POST /api/connections/invite ───────────────────
router.post('/invite', async (req, res, next) => {
  try {
    const link = `${process.env.CLIENT_URL}/connect/${req.user._id}`;
    res.json({ link });
  } catch (err) { next(err); }
});

// ── POST /api/connections/invite-direct ───────────
router.post('/invite-direct', async (req, res, next) => {
  try {
    const conn = await Connection.create({ ...req.body, user: req.user._id, status: 'pending' });
    res.status(201).json({ connection: conn });
  } catch (err) { next(err); }
});

// ── POST /api/connections/collab ───────────────────
router.post('/collab', async (req, res, next) => {
  try {
    const { connectionId, project, message } = req.body;
    const conn = await Connection.findOneAndUpdate(
      { _id: connectionId, user: req.user._id },
      { collabStatus: 'pending', collabProject: project },
      { new: true }
    );
    res.json({ connection: conn, message: 'Collab request sent' });
  } catch (err) { next(err); }
});

// ── POST /api/connections/referral ─────────────────
router.post('/referral', async (req, res, next) => {
  try {
    res.json({ message: 'Referral recorded', ...req.body });
  } catch (err) { next(err); }
});

// ── POST /api/connections/meeting ─────────────────
router.post('/meeting', async (req, res, next) => {
  try {
    res.json({ message: 'Meeting scheduled', ...req.body });
  } catch (err) { next(err); }
});

// ── GET /api/connections/profile/:id ──────────────
router.get('/profile/:id', async (req, res, next) => {
  try {
    const conn = await Connection.findOne({ _id: req.params.id, user: req.user._id });
    if (!conn) return res.status(404).json({ error: 'Connection not found' });
    res.json({ connection: conn });
  } catch (err) { next(err); }
});

// ── GET /api/connections/chat/:id ─────────────────
router.get('/chat/:id', async (req, res, next) => {
  try {
    const conn = await Connection.findOne({ _id: req.params.id, user: req.user._id }).select('messages name');
    if (!conn) return res.status(404).json({ error: 'Connection not found' });
    res.json({ messages: conn.messages });
  } catch (err) { next(err); }
});

// ── POST /api/connections/chat/:id ────────────────
router.post('/chat/:id', async (req, res, next) => {
  try {
    const { text } = req.body;
    const conn = await Connection.findOneAndUpdate(
      { _id: req.params.id, user: req.user._id },
      { $push: { messages: { sender: 'me', text } }, lastInteraction: Date.now() },
      { new: true }
    );
    if (!conn) return res.status(404).json({ error: 'Connection not found' });
    res.json({ message: conn.messages[conn.messages.length - 1] });
  } catch (err) { next(err); }
});

// ── POST /api/connections/block/:id ───────────────
router.post('/block/:id', async (req, res, next) => {
  try {
    await Connection.findOneAndDelete({ _id: req.params.id, user: req.user._id });
    res.json({ message: 'Connection blocked and removed' });
  } catch (err) { next(err); }
});

// ── POST /api/connections/favorites ───────────────
router.post('/favorites', async (req, res, next) => {
  try {
    const { connectionId } = req.body;
    const conn = await Connection.findOneAndUpdate(
      { _id: connectionId, user: req.user._id },
      { favorite: true },
      { new: true }
    );
    res.json({ connection: conn });
  } catch (err) { next(err); }
});

// ── DELETE /api/connections/favorites/:id ─────────
router.delete('/favorites/:id', async (req, res, next) => {
  try {
    const conn = await Connection.findOneAndUpdate(
      { _id: req.params.id, user: req.user._id },
      { favorite: false },
      { new: true }
    );
    res.json({ connection: conn });
  } catch (err) { next(err); }
});

// ── PATCH /api/connections/:id ─────────────────────
router.patch('/:id', async (req, res, next) => {
  try {
    const conn = await Connection.findOneAndUpdate(
      { _id: req.params.id, user: req.user._id },
      { ...req.body, updatedAt: Date.now() },
      { new: true, runValidators: true }
    );
    if (!conn) return res.status(404).json({ error: 'Connection not found' });
    res.json({ connection: conn });
  } catch (err) { next(err); }
});

// ── DELETE /api/connections/:id ────────────────────
router.delete('/:id', async (req, res, next) => {
  try {
    await Connection.findOneAndDelete({ _id: req.params.id, user: req.user._id });
    res.json({ message: 'Connection removed' });
  } catch (err) { next(err); }
});

// ── DELETE /api/connections/request/:id ───────────
router.delete('/request/:id', async (req, res, next) => {
  try {
    res.json({ message: 'Request cancelled' });
  } catch (err) { next(err); }
});

module.exports = router;
