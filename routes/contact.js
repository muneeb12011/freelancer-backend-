// routes/contact.js — Contact form + newsletter
const router = require('express').Router();

// ── POST /api/contact ──────────────────────────────────────
// Receives form submission, logs it (add email service here)
router.post('/', async (req, res, next) => {
  try {
    const { name, email, subject, message } = req.body;

    if (!name?.trim())    return res.status(400).json({ error: 'Name is required' });
    if (!email?.trim())   return res.status(400).json({ error: 'Email is required' });
    if (!subject?.trim()) return res.status(400).json({ error: 'Subject is required' });
    if (!message?.trim()) return res.status(400).json({ error: 'Message is required' });
    if (message.trim().length < 20) return res.status(400).json({ error: 'Message must be at least 20 characters' });

    // Log to console (replace with SendGrid/Resend/Nodemailer to forward to email)
    console.log(`\n📩 CONTACT FORM SUBMISSION`);
    console.log(`   From:    ${name} <${email}>`);
    console.log(`   Subject: ${subject}`);
    console.log(`   Message: ${message.trim().slice(0, 120)}…\n`);

    // TODO: Send email via Nodemailer/SendGrid/Resend
    // Example with Nodemailer:
    // await transporter.sendMail({
    //   from: `"Aurelance Contact" <noreply@aurelance.app>`,
    //   to: 'aurelance454@gmail.com',
    //   replyTo: email,
    //   subject: `[Contact] ${subject} — from ${name}`,
    //   text: message,
    // });

    res.json({ success: true, message: 'Message received. We\'ll reply within 24 hours.' });
  } catch (err) { next(err); }
});

// ── POST /api/newsletter ───────────────────────────────────
router.post('/newsletter', async (req, res, next) => {
  try {
    const { email } = req.body;
    if (!email?.trim() || !/\S+@\S+\.\S+/.test(email))
      return res.status(400).json({ error: 'Valid email required' });

    // TODO: Add to Mailchimp / ConvertKit / etc.
    console.log(`📧 Newsletter signup: ${email}`);

    res.json({ success: true });
  } catch (err) { next(err); }
});

module.exports = router;