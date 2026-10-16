// routes/support.js — FAQs, tickets, feedback, service status.
const router   = require('express').Router();
const env      = require('../config/env');
const Ticket   = require('../models/Ticket');
const Feedback = require('../models/Feedback');
const limits   = require('../middleware/rateLimits');
const { protect, optionalAuth } = require('../middleware/auth');
const { dbState } = require('../config/db');
const { createTicket } = require('../services/tickets');
const { asyncHandler, badRequest, notFound } = require('../utils/http');
const { str, isEmail } = require('../utils/sanitize');

const FAQS = [
  { id: 1, category: 'Getting Started', question: 'How do I create my first invoice?', answer: 'Open Invoices and choose New invoice. Pick a client (or type a name), add line items, then save it as a draft or mark it sent. Totals and tax are calculated for you, and you can download a PDF.' },
  { id: 2, category: 'Getting Started', question: 'How do I add a client?', answer: 'Open Clients and choose New client. Name is the only required field; add email, company, rate, budget and contract details whenever you have them. Revenue and outstanding amounts update automatically from that client’s invoices.' },
  { id: 3, category: 'Billing', question: 'What is included in the Free plan?', answer: 'Unlimited clients, tasks and invoices, the Kanban board with time tracking, Connections, the core Atelier tools, and 15 AI requests a day.' },
  { id: 4, category: 'Billing', question: 'What does Premium add?', answer: 'Earnings analytics, tax summary, smart contracts, the proposal builder, client insights, the business health score, AI daily focus and profile review, and 250 AI requests a day. Current prices are always on the Billing page.' },
  { id: 5, category: 'Billing', question: 'How do I upgrade to Premium?', answer: 'Open Billing from the sidebar, pick monthly or yearly, and pay through Safepay with a card or wallet. Premium turns on as soon as the payment is confirmed.' },
  { id: 6, category: 'Billing', question: 'How do I cancel?', answer: 'Premium is prepaid, so nothing renews without you paying again. On the Billing page choose “Don’t renew” and you keep Premium until the end of the paid period.' },
  { id: 7, category: 'Account', question: 'How do I change my password?', answer: 'Settings → Security → Change password. Changing it signs out your other devices.' },
  { id: 8, category: 'Account', question: 'I forgot my password', answer: 'On the sign-in page choose “Forgot password?”. We email a link that works for one hour.' },
  { id: 9, category: 'Tasks', question: 'How does the Kanban board work?', answer: 'Tasks has four columns: To do, In progress, Review and Done. Drag a card between columns, or open it to change status, log time, add subtasks and comments.' },
  { id: 10, category: 'Connections', question: 'What are Connections?', answer: 'Your freelance network. Search for other Aurelance users and send a request; once accepted you can chat, propose collaborations and send referrals. You can also keep private contact cards for people who aren’t on Aurelance.' },
  { id: 12, category: 'Jobs', question: 'How do I post a job?', answer: 'Open Jobs and choose Post a job. You need a confirmed email. Free accounts can have 3 open jobs at a time; Premium up to 25. Applicants show up on the job page, where you can shortlist, message and hire.' },
  { id: 13, category: 'Jobs', question: 'What happens when I hire someone?', answer: 'You both get a conversation in Messages with a note about the hire, and you’re added to the freelancer’s Clients list automatically. Agree scope, timeline and payment in writing in that conversation.' },
  { id: 14, category: 'Jobs', question: 'How many jobs can I apply to?', answer: 'Free accounts get 15 applications a month (they reset on the 1st). Premium is unlimited. Withdrawing doesn’t give the application back.' },
  { id: 15, category: 'Messages', question: 'How do I message someone?', answer: 'Use Message on their profile, a job post, an applicant or a search result in Connections. Files up to 2 MB can be attached. Use the … menu in a conversation to archive, block or report.' },
  { id: 16, category: 'Account', question: 'How does verification work?', answer: 'Settings → Verification. Confirm your email, link Google or GitHub, and optionally submit an ID check (CNIC, passport, national ID or licence plus a selfie). A person reviews it within one business day and the photos are deleted right after.' },
  { id: 11, category: 'Technical', question: 'My data is not saving', answer: 'Check that you are still signed in and online. If a save fails you’ll see the reason in a message at the bottom of the screen — send that text with a support ticket and we’ll look it up.' },
];

router.get('/faqs', (req, res) => res.json({ faqs: FAQS }));

router.get('/status', asyncHandler(async (req, res) => {
  const db = dbState();
  const services = [
    { name: 'App & API', status: 'operational' },
    { name: 'Database', status: db === 'connected' ? 'operational' : 'degraded' },
    { name: 'Email delivery', status: env.features.email ? 'operational' : 'maintenance' },
    { name: 'Payments', status: env.features.payments ? 'operational' : 'maintenance' },
    { name: 'AI assistant', status: env.features.ai ? 'operational' : 'maintenance' },
  ];
  const overall = services.some((s) => s.status === 'down') ? 'down' : services.some((s) => s.status !== 'operational') ? 'degraded' : 'operational';
  res.json({ overall, services, checkedAt: new Date().toISOString() });
}));

// Signed-in ticket
router.post(['/ticket', '/tickets'], protect, limits.publicForm, asyncHandler(async (req, res) => {
  const subject = str(req.body.subject, 200);
  const message = str(req.body.message, 5000);
  if (!subject || !message) throw badRequest('Add a subject and describe the problem');
  const ticket = await createTicket({
    user: req.user, name: req.user.name, email: req.user.email, subject, message,
    category: str(req.body.category, 60), priority: req.body.priority, source: 'app',
  });
  res.status(201).json({ message: 'Ticket received. We reply within one business day.', ticketId: ticket.number, ticket });
}));

// Contact form inside Support (works signed in or out)
router.post('/contact', optionalAuth, limits.publicForm, asyncHandler(async (req, res) => {
  const name = str(req.body.name, 100) || req.user?.name || '';
  const from = str(req.body.email, 254).toLowerCase() || req.user?.email || '';
  const subject = str(req.body.subject, 200);
  const message = str(req.body.message, 5000);
  if (!isEmail(from)) throw badRequest('Enter a valid email so we can reply');
  if (!subject || !message) throw badRequest('Add a subject and a message');
  const ticket = await createTicket({ user: req.user, name, email: from, subject, message, category: str(req.body.category, 60), priority: req.body.priority, source: 'contact' });
  res.status(201).json({ success: true, message: 'Message sent. We reply within one business day.', ticketId: ticket.number });
}));

router.get('/tickets', protect, asyncHandler(async (req, res) => {
  const tickets = await Ticket.find({ user: req.user._id }).sort({ createdAt: -1 }).limit(100).lean();
  res.json({ tickets: tickets.map((t) => ({ ...t, ticketId: t.number })) });
}));

router.get('/tickets/:id', protect, asyncHandler(async (req, res) => {
  const ticket = await Ticket.findOne({ _id: req.params.id, user: req.user._id });
  if (!ticket) throw notFound('Ticket not found');
  res.json({ ticket });
}));

router.post('/tickets/:id/reply', protect, asyncHandler(async (req, res) => {
  const text = str(req.body.text || req.body.message, 5000);
  if (!text) throw badRequest('Reply is empty');
  const ticket = await Ticket.findOneAndUpdate(
    { _id: req.params.id, user: req.user._id },
    { $push: { replies: { from: 'user', text } }, status: 'open' },
    { new: true },
  );
  if (!ticket) throw notFound('Ticket not found');
  res.json({ ticket });
}));

router.post('/rate', protect, asyncHandler(async (req, res) => {
  const nps = Number(req.body.nps);
  if (!Number.isInteger(nps) || nps < 0 || nps > 10) throw badRequest('Pick a score from 0 to 10');
  await Feedback.create({ user: req.user._id, kind: 'nps', nps, aspects: req.body.aspectRatings, comment: str(req.body.comment, 2000), category: str(req.body.category, 60) });
  res.json({ message: 'Thanks for the feedback' });
}));

router.post('/faq-feedback', optionalAuth, asyncHandler(async (req, res) => {
  await Feedback.create({ user: req.user?._id, kind: 'faq', faqId: str(req.body.faqId, 20), helpful: Boolean(req.body.helpful) });
  res.json({ ok: true });
}));

module.exports = router;
