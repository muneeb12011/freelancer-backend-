// routes/support.js — FAQs and support tickets
const router = require('express').Router();
const { protect } = require('../middleware/auth');

// ── GET /api/support/faqs ──────────────────────────
// Public — no auth needed
router.get('/faqs', (req, res) => {
  const faqs = [
    {
      id: 1, category: 'Getting Started',
      question: 'How do I create my first invoice?',
      answer: 'Go to the Invoices page, click "New Invoice", fill in the client details and line items, then click Save. You can download it as a text file or mark it as sent.',
    },
    {
      id: 2, category: 'Getting Started',
      question: 'How do I add a client?',
      answer: 'Go to the Clients page and click "New Client". Fill in the details including name, email, company and status. You can also set hourly rate, project budget and contract details.',
    },
    {
      id: 3, category: 'Billing',
      question: 'What is included in the free plan?',
      answer: 'The free plan includes Quick Notes, Rate Calculator, Time Tracker, Expense Tracker, Brand Kit, Project Estimator, Email Templates, and unlimited tasks and clients.',
    },
    {
      id: 4, category: 'Billing',
      question: 'What does Premium include?',
      answer: 'Premium ($19/month) adds Earnings Analytics, Smart Contracts, Proposal Builder, and Tax Summary Export on top of everything in the free plan.',
    },
    {
      id: 5, category: 'Billing',
      question: 'How do I upgrade to Premium?',
      answer: 'Go to the Atelier page, click the Plans tab, and select Premium. Stripe integration is coming soon — contact support to upgrade manually in the meantime.',
    },
    {
      id: 6, category: 'Account',
      question: 'How do I change my password?',
      answer: 'Go to your Profile page, click the Account tab, and use the Change Password section. You\'ll need your current password to set a new one.',
    },
    {
      id: 7, category: 'Account',
      question: 'How do I update my hourly rate?',
      answer: 'You can update your rate in your Profile page (edit the rate field directly), or use the Rate Calculator in Atelier to calculate the optimal rate and save it to your profile.',
    },
    {
      id: 8, category: 'Tasks',
      question: 'How does the Kanban board work?',
      answer: 'The Tasks page has a Kanban view with columns: To Do, In Progress, Review, and Done. Drag tasks between columns or click a task to update its status.',
    },
    {
      id: 9, category: 'Connections',
      question: 'What are Connections?',
      answer: 'Connections is your freelance network — other freelancers, collaborators, and contacts. You can tag them, chat, send collaboration requests, and track your relationship strength.',
    },
    {
      id: 10, category: 'Technical',
      question: 'My data is not saving — what do I do?',
      answer: 'Make sure you are logged in. If the issue persists, try refreshing the page. If data still does not save, contact support with the error message you see.',
    },
  ];

  res.json({ faqs });
});

// ── POST /api/support/ticket ───────────────────────
router.post('/ticket', protect, async (req, res, next) => {
  try {
    const { subject, message, category = 'General' } = req.body;
    if (!subject || !message)
      return res.status(400).json({ error: 'Subject and message are required' });

    // In production: save to DB or send email via SendGrid/Resend
    console.log(`📩 Support ticket from ${req.user.email}: [${category}] ${subject}`);

    res.json({
      message: 'Ticket received! We\'ll get back to you within 24 hours.',
      ticketId: `TKT-${Date.now().toString().slice(-6)}`,
    });
  } catch (err) { next(err); }
});

module.exports = router;