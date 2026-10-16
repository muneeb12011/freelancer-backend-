// routes/invoices.js
const router  = require('express').Router();
const Invoice = require('../models/Invoice');
const Client  = require('../models/Client');
const Counter = require('../models/Counter');
const { protect } = require('../middleware/auth');
const { refreshClientStats } = require('../services/clientStats');
const { asyncHandler, badRequest, notFound } = require('../utils/http');
const { stripProtected, clampInt, isId, str } = require('../utils/sanitize');

router.use(protect);

const STATUSES = ['draft', 'sent', 'paid', 'overdue', 'cancelled'];
const today = () => new Date().toISOString().slice(0, 10);
const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

/** Server-side totals — the client's numbers are never trusted. */
function computeTotals(body, prev = {}) {
  const items = (Array.isArray(body.items) ? body.items : prev.items || []).slice(0, 200).map((i) => {
    const quantity = Math.max(0, parseFloat(i.quantity ?? i.qty) || 1);
    const rate = Math.max(0, parseFloat(i.rate) || 0);
    return { description: str(i.description, 500) || 'Item', quantity, rate, total: round2(quantity * rate) };
  });
  const subtotal  = round2(items.reduce((s, i) => s + i.total, 0));
  const taxRate   = Math.min(100, Math.max(0, parseFloat(body.taxRate ?? prev.taxRate) || 0));
  const taxAmount = round2(subtotal * (taxRate / 100));
  const discount  = Math.max(0, parseFloat(body.discount ?? prev.discount) || 0);
  return { items, subtotal, taxRate, taxAmount, discount, total: round2(Math.max(0, subtotal + taxAmount - discount)) };
}

async function resolveClient(userId, body) {
  const cid = body.client || body.clientId;
  if (!cid || !isId(cid)) return {};
  const c = await Client.findOne({ _id: cid, user: userId }).select('name email');
  if (!c) return {};
  return { client: c._id, clientName: body.clientName || c.name, clientEmail: body.clientEmail || c.email };
}

// Overdue is derived: anything sent/draft past its due date reads as overdue.
function withDerivedStatus(inv) {
  const o = inv.toObject ? inv.toObject() : inv;
  if (['sent', 'draft'].includes(o.status) && o.dueDate && o.dueDate < today()) o.status = 'overdue';
  return o;
}

router.get('/', asyncHandler(async (req, res) => {
  const filter = { user: req.user._id };
  const { clientId, status } = req.query;
  if (status === 'overdue') {
    filter.$or = [{ status: 'overdue' }, { status: { $in: ['sent', 'draft'] }, dueDate: { $lt: today(), $ne: '' } }];
  } else if (status && STATUSES.includes(status)) filter.status = status;
  if (clientId && isId(clientId)) filter.client = clientId;

  const sortField = String(req.query.sort || '-createdAt');
  const sort = { [sortField.replace(/^-/, '')]: sortField.startsWith('-') ? -1 : 1 };
  if (!['createdAt', 'paidAt', 'issueDate', 'dueDate', 'total'].includes(Object.keys(sort)[0])) { delete sort[Object.keys(sort)[0]]; sort.createdAt = -1; }

  const invoices = await Invoice.find(filter).sort(sort).limit(clampInt(req.query.limit, { max: 1000, def: 100 }));
  res.json({ invoices: invoices.map(withDerivedStatus) });
}));

async function nextInvoiceNumber(userId) {
  const seq = await Counter.next(`invoice:${userId}`, () => Invoice.countDocuments({ user: userId }));
  return `INV-${String(seq).padStart(4, '0')}`;
}

router.post('/', asyncHandler(async (req, res) => {
  const body = stripProtected(req.body, ['paidAt']);
  const clientFields = await resolveClient(req.user._id, body);
  const clientName = str(clientFields.clientName || body.clientName, 200);
  if (!clientName) throw badRequest('Choose a client or enter a client name');
  const status = STATUSES.includes(body.status) ? body.status : 'draft';

  const invoice = await Invoice.create({
    ...body,
    ...clientFields,
    clientName,
    ...computeTotals(body),
    invoiceNumber: str(body.invoiceNumber, 40) || await nextInvoiceNumber(req.user._id),
    issueDate: str(body.issueDate, 10) || today(),
    status,
    paidAt: status === 'paid' ? new Date() : undefined,
    user: req.user._id,
  });
  await refreshClientStats(req.user._id, invoice.client);
  res.status(201).json({ invoice: withDerivedStatus(invoice) });
}));

router.get('/:id', asyncHandler(async (req, res) => {
  const invoice = await Invoice.findOne({ _id: req.params.id, user: req.user._id });
  if (!invoice) throw notFound('Invoice not found');
  res.json({ invoice: withDerivedStatus(invoice) });
}));

const updateInvoice = asyncHandler(async (req, res) => {
  const prev = await Invoice.findOne({ _id: req.params.id, user: req.user._id });
  if (!prev) throw notFound('Invoice not found');

  const body = stripProtected(req.body, ['paidAt', 'subtotal', 'taxAmount', 'total']);
  if (body.status && !STATUSES.includes(body.status)) throw badRequest('Unknown invoice status');
  const clientFields = (body.client || body.clientId) ? await resolveClient(req.user._id, body) : {};

  const oldClient = prev.client ? String(prev.client) : null;
  Object.assign(prev, body, clientFields);
  if (body.items || body.taxRate !== undefined || body.discount !== undefined) Object.assign(prev, computeTotals(body, prev));
  if (body.status === 'paid' && !prev.paidAt) prev.paidAt = new Date();
  if (body.status && body.status !== 'paid') prev.paidAt = undefined;
  await prev.save();

  await refreshClientStats(req.user._id, prev.client);
  if (oldClient && oldClient !== String(prev.client || '')) await refreshClientStats(req.user._id, oldClient);
  res.json({ invoice: withDerivedStatus(prev) });
});
router.put('/:id', updateInvoice);
router.patch('/:id', updateInvoice);

router.delete('/:id', asyncHandler(async (req, res) => {
  const invoice = await Invoice.findOneAndDelete({ _id: req.params.id, user: req.user._id });
  if (!invoice) throw notFound('Invoice not found');
  await refreshClientStats(req.user._id, invoice.client);
  res.json({ message: 'Invoice deleted' });
}));

module.exports = router;
