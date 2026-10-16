// routes/clients.js — client CRM.
const router  = require('express').Router();
const Client  = require('../models/Client');
const Invoice = require('../models/Invoice');
const Task    = require('../models/Task');
const email   = require('../services/email');
const limits  = require('../middleware/rateLimits');
const { protect } = require('../middleware/auth');
const { asyncHandler, badRequest, notFound } = require('../utils/http');
const { stripProtected, searchRegex, clampInt, str, isEmail } = require('../utils/sanitize');

router.use(protect);

// Computed fields are maintained by the server, never by the client.
const COMPUTED = ['revenue', 'outstanding', 'invoiceCount', 'paidInvoices'];
const clean = (body) => stripProtected(body, COMPUTED);

router.get('/', asyncHandler(async (req, res) => {
  const filter = { user: req.user._id };
  if (req.query.status) filter.status = str(req.query.status, 40);
  if (req.query.search) {
    const re = searchRegex(req.query.search);
    filter.$or = [{ name: re }, { email: re }, { company: re }, { tags: re }];
  }
  const clients = await Client.find(filter).sort({ updatedAt: -1 }).limit(clampInt(req.query.limit, { max: 1000, def: 300 }));
  res.json({ clients });
}));

router.post('/', asyncHandler(async (req, res) => {
  const client = await Client.create({ ...clean(req.body), user: req.user._id, lastActivity: new Date() });
  res.status(201).json({ client });
}));

// Send an email to a client from the app (reply-to goes to the freelancer).
router.post('/email', limits.publicForm, asyncHandler(async (req, res) => {
  const { clientId } = req.body;
  const subject = str(req.body.subject, 200);
  const body = str(req.body.body || req.body.message, 10000);
  if (!subject || !body) throw badRequest('Subject and message are required');
  const client = await Client.findOne({ _id: clientId, user: req.user._id });
  if (!client) throw notFound('Client not found');
  if (!isEmail(client.email || '')) throw badRequest('This client has no valid email address');

  const html = email.layout({
    heading: subject,
    intro: email.esc(body).replace(/\n/g, '<br>'),
    outro: `Sent by ${email.esc(req.user.name)} via Aurelance. Reply to this email to answer ${email.esc(req.user.name.split(' ')[0])} directly.`,
  });
  await email.send({ to: client.email, subject, html, text: body, replyTo: req.user.email });
  client.lastActivity = new Date();
  await client.save();
  res.json({ message: `Email sent to ${client.email}` });
}));

router.get('/:id', asyncHandler(async (req, res) => {
  const client = await Client.findOne({ _id: req.params.id, user: req.user._id });
  if (!client) throw notFound('Client not found');
  res.json({ client });
}));

const update = asyncHandler(async (req, res) => {
  const client = await Client.findOneAndUpdate(
    { _id: req.params.id, user: req.user._id },
    { ...clean(req.body), lastActivity: new Date() },
    { new: true, runValidators: true },
  );
  if (!client) throw notFound('Client not found');
  res.json({ client });
});
router.patch('/:id', update);
router.put('/:id', update);

router.delete('/:id', asyncHandler(async (req, res) => {
  const client = await Client.findOneAndDelete({ _id: req.params.id, user: req.user._id });
  if (!client) throw notFound('Client not found');
  // Keep invoices/tasks (financial history) but unlink them.
  await Promise.all([
    Invoice.updateMany({ user: req.user._id, client: client._id }, { $unset: { client: 1 } }),
    Task.updateMany({ user: req.user._id, client: client._id }, { $unset: { client: 1 } }),
  ]);
  res.json({ message: 'Client deleted' });
}));

module.exports = router;
