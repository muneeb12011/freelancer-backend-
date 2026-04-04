// routes/invoices.js
const router  = require('express').Router();
const Invoice = require('../models/Invoice');
const Client  = require('../models/Client');
const { protect } = require('../middleware/auth');

router.use(protect);

// ── GET /api/invoices ──────────────────────────────
router.get('/', async (req, res, next) => {
  try {
    const { clientId, status, limit = 100 } = req.query;
    const filter = { user: req.user._id };
    if (status)   filter.status = status;
    if (clientId) filter.$or = [{ client: clientId }, { clientId }];

    const invoices = await Invoice.find(filter).sort({ createdAt: -1 }).limit(+limit);
    res.json({ invoices });
  } catch (err) { next(err); }
});

// ── POST /api/invoices ─────────────────────────────
router.post('/', async (req, res, next) => {
  try {
    // Calculate totals
    const items = (req.body.items || []).map(i => ({
      ...i,
      quantity: parseFloat(i.quantity || i.qty) || 1,
      total: (parseFloat(i.quantity || i.qty) || 1) * (parseFloat(i.rate) || 0),
    }));
    const subtotal  = items.reduce((s, i) => s + i.total, 0);
    const taxAmount = subtotal * ((parseFloat(req.body.taxRate) || 0) / 100);
    const discount  = parseFloat(req.body.discount) || 0;
    const total     = Math.max(0, subtotal + taxAmount - discount);

    const invoice = await Invoice.create({
      ...req.body, items, subtotal, taxAmount, total, user: req.user._id,
    });

    // Update client stats
    if (req.body.clientId || req.body.client) {
      const cid = req.body.client || req.body.clientId;
      await Client.findOneAndUpdate(
        { _id: cid, user: req.user._id },
        { $inc: { invoiceCount: 1 }, lastActivity: Date.now() }
      );
    }

    res.status(201).json({ invoice });
  } catch (err) { next(err); }
});

// ── GET /api/invoices/:id ──────────────────────────
router.get('/:id', async (req, res, next) => {
  try {
    const invoice = await Invoice.findOne({ _id: req.params.id, user: req.user._id });
    if (!invoice) return res.status(404).json({ error: 'Invoice not found' });
    res.json({ invoice });
  } catch (err) { next(err); }
});

// ── PUT /PATCH /api/invoices/:id ───────────────────
const updateInvoice = async (req, res, next) => {
  try {
    const prev = await Invoice.findOne({ _id: req.params.id, user: req.user._id });
    if (!prev) return res.status(404).json({ error: 'Invoice not found' });

    const updates = { ...req.body };

    // Recalculate totals if items provided
    if (updates.items) {
      const items = updates.items.map(i => ({
        ...i,
        quantity: parseFloat(i.quantity || i.qty) || 1,
        total: (parseFloat(i.quantity || i.qty) || 1) * (parseFloat(i.rate) || 0),
      }));
      const subtotal  = items.reduce((s, i) => s + i.total, 0);
      const taxAmount = subtotal * ((parseFloat(updates.taxRate) || 0) / 100);
      const discount  = parseFloat(updates.discount) || 0;
      updates.items     = items;
      updates.subtotal  = subtotal;
      updates.taxAmount = taxAmount;
      updates.total     = Math.max(0, subtotal + taxAmount - discount);
    }

    if (updates.status === 'paid' && prev.status !== 'paid') {
      updates.paidAt = new Date();
      if (prev.client) {
        await Client.findOneAndUpdate(
          { _id: prev.client, user: req.user._id },
          { $inc: { revenue: prev.total, paidInvoices: 1 }, lastActivity: Date.now() }
        );
      }
    }

    const invoice = await Invoice.findByIdAndUpdate(req.params.id, updates, { new: true });
    res.json({ invoice });
  } catch (err) { next(err); }
};
router.put('/:id',   updateInvoice);
router.patch('/:id', updateInvoice);

// ── DELETE /api/invoices/:id ───────────────────────
router.delete('/:id', async (req, res, next) => {
  try {
    const invoice = await Invoice.findOneAndDelete({ _id: req.params.id, user: req.user._id });
    if (!invoice) return res.status(404).json({ error: 'Invoice not found' });
    res.json({ message: 'Invoice deleted' });
  } catch (err) { next(err); }
});

module.exports = router;