// routes/activity.js — recent activity feed
const router  = require('express').Router();
const Invoice = require('../models/Invoice');
const Task    = require('../models/Task');
const Client  = require('../models/Client');
const Connection = require('../models/Connection');
const { protect } = require('../middleware/auth');

router.use(protect);

// ── GET /api/activity?limit=12 ─────────────────────
router.get('/', async (req, res, next) => {
  try {
    const uid   = req.user._id;
    const limit = parseInt(req.query.limit) || 12;

    const [recentInvoices, recentTasks, recentClients] = await Promise.all([
      Invoice.find({ user: uid }).sort({ createdAt: -1 }).limit(5).select('invoiceNumber clientName status total createdAt'),
      Task.find({ user: uid }).sort({ updatedAt: -1 }).limit(5).select('title status priority updatedAt'),
      Client.find({ user: uid }).sort({ createdAt: -1 }).limit(5).select('name status createdAt'),
    ]);

    const activity = [
      ...recentInvoices.map(i => ({
        id:      i._id,
        type:    'invoice',
        message: `Invoice #${i.invoiceNumber} — ${i.clientName}`,
        sub:     `$${i.total?.toFixed(2) || '0.00'} · ${i.status}`,
        date:    i.createdAt,
        color:   '#4a90d9',
      })),
      ...recentTasks.map(t => ({
        id:      t._id,
        type:    'task',
        message: t.title,
        sub:     `${t.status} · ${t.priority}`,
        date:    t.updatedAt,
        color:   t.status === 'done' ? '#4caf82' : '#9b72e8',
      })),
      ...recentClients.map(c => ({
        id:      c._id,
        type:    'client',
        message: `Client added: ${c.name}`,
        sub:     c.status,
        date:    c.createdAt,
        color:   '#c9a84c',
      })),
    ]
      .sort((a, b) => new Date(b.date) - new Date(a.date))
      .slice(0, limit);

    res.json({ activity });
  } catch (err) { next(err); }
});

module.exports = router;