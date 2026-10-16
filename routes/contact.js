// routes/contact.js — public contact form + newsletter (mounted at /api/contact and /api/newsletter).
const router   = require('express').Router();
const Feedback = require('../models/Feedback');
const limits   = require('../middleware/rateLimits');
const { optionalAuth } = require('../middleware/auth');
const { createTicket } = require('../services/tickets');
const { asyncHandler, badRequest } = require('../utils/http');
const { str, isEmail } = require('../utils/sanitize');

async function subscribe(req, res) {
  const mail = str(req.body.email, 254).toLowerCase();
  if (!isEmail(mail)) throw badRequest('Enter a valid email address');
  await Feedback.updateOne({ kind: 'newsletter', email: mail }, { $setOnInsert: { kind: 'newsletter', email: mail } }, { upsert: true });
  res.json({ success: true, message: 'You’re on the list.' });
}

router.post('/', optionalAuth, limits.publicForm, asyncHandler(async (req, res) => {
  // When mounted at /api/newsletter, POST / is a subscription.
  if (req.baseUrl.endsWith('/newsletter')) return subscribe(req, res);

  const name = str(req.body.name, 100);
  const from = str(req.body.email, 254).toLowerCase();
  const subject = str(req.body.subject, 200);
  const message = str(req.body.message, 5000);
  if (req.body.website) return res.json({ success: true }); // honeypot field — bots fill it
  if (!name) throw badRequest('Enter your name');
  if (!isEmail(from)) throw badRequest('Enter a valid email address');
  if (!subject) throw badRequest('Add a subject');
  if (message.length < 20) throw badRequest('Write at least 20 characters so we can help');

  const ticket = await createTicket({ user: req.user, name, email: from, subject, message, category: str(req.body.category, 60) || 'Contact', source: 'contact' });
  return res.json({ success: true, message: 'Message sent. We reply within one business day.', ticketId: ticket.number });
}));

router.post('/newsletter', limits.publicForm, asyncHandler(subscribe));

module.exports = router;
