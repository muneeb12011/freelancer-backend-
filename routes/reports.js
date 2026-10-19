// routes/reports.js — one-tap "report" on jobs, people, messages and squads.
//   POST /api/reports { target: job|user|message|squad, targetId, reason, details }
const router = require('express').Router();
const Report = require('../models/Report');
const Job = require('../models/Job');
const User = require('../models/User');
const Message = require('../models/Message');
const Squad = require('../models/Squad');
const env = require('../config/env');
const email = require('../services/email');
const { protect } = require('../middleware/auth');
const { asyncHandler, badRequest, notFound } = require('../utils/http');
const { isId, str } = require('../utils/sanitize');

router.use(protect);

const REASONS = ['scam', 'off_platform', 'upfront_fee', 'fake', 'abuse', 'spam', 'other'];
// After this many reports from different people, a job is pulled until an admin looks at it.
const AUTO_HOLD_AT = 3;

router.post('/', asyncHandler(async (req, res) => {
  const { target, targetId } = req.body;
  const reason = REASONS.includes(req.body.reason) ? req.body.reason : null;
  if (!['job', 'user', 'message', 'squad'].includes(target) || !isId(targetId)) throw badRequest('What are you reporting?');
  if (!reason) throw badRequest('Choose a reason');

  let subject;
  if (target === 'job') subject = (await Job.findById(targetId).select('postedBy').lean())?.postedBy;
  if (target === 'user') subject = (await User.exists({ _id: targetId })) ? targetId : null;
  if (target === 'message') subject = (await Message.findById(targetId).select('sender').lean())?.sender;
  if (target === 'squad') subject = (await Squad.findById(targetId).select('lead').lean())?.lead;
  if (!subject) throw notFound('That no longer exists');
  if (String(subject) === String(req.user._id)) throw badRequest('You can’t report yourself');

  try {
    await Report.create({ by: req.user._id, target, targetId, subject, reason, details: str(req.body.details, 1500) });
  } catch (err) {
    if (err.code === 11000) return res.json({ message: 'You’ve already reported this. We’re on it.' });
    throw err;
  }

  if (target === 'job') {
    const count = await Report.countDocuments({ target: 'job', targetId, status: 'open' });
    if (count >= AUTO_HOLD_AT) await Job.updateOne({ _id: targetId, status: 'open' }, { $set: { status: 'review', 'safety.verdict': 'held' } });
  }
  // Several established people reporting the same person: pull all their open posts until reviewed.
  const risk = await require('../services/scamShield').posterRisk(subject);
  if (risk.reporters >= AUTO_HOLD_AT) {
    await Job.updateMany({ postedBy: subject, status: 'open', 'safety.reviewedAt': null }, { $set: { status: 'review', 'safety.verdict': 'held' } });
  }
  if (env.ADMIN_EMAILS.length) {
    email.send({ to: env.ADMIN_EMAILS[0], subject: `Report: ${target} (${reason})`, html: email.layout({ heading: 'New report', intro: `${email.esc(req.user.name)} reported a ${target} for “${reason}”.`, action: { label: 'Open the queue', url: `${env.CLIENT_URL}/admin` } }) }).catch(() => {});
  }
  res.status(201).json({ message: 'Thanks — reported. We review every report, usually within a day.' });
}));

module.exports = router;
