// routes/cron.js — scheduled jobs. One daily entry point (Vercel Cron Hobby allows daily jobs):
//   GET /api/cron/daily   Authorization: Bearer $CRON_SECRET
// Runs: Premium renewal reminders · no-ghosting auto-close · unpaid-milestone nudges · review reveal.
const router  = require('express').Router();
const env     = require('../config/env');
const logger  = require('../utils/logger');
const User    = require('../models/User');
const Job     = require('../models/Job');
const JobApplication = require('../models/JobApplication');
const Engagement = require('../models/Engagement');
const Review  = require('../models/Review');
const email   = require('../services/email');
const reputation = require('../services/reputation');
const { asyncHandler } = require('../utils/http');
const { safeEqual } = require('../utils/tokens');

router.use((req, res, next) => {
  const token = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  if (!env.CRON_SECRET || !safeEqual(token, env.CRON_SECRET)) return res.status(401).json({ error: 'Unauthorized' });
  return next();
});

const DAY = 86400e3;
const wants = (u, key) => (u.notifications || {})[key] !== false;

async function renewalReminders() {
  const now = new Date();
  const users = await User.find({ plan: 'premium', planCancelAtPeriodEnd: { $ne: true }, planExpiresAt: { $gt: now, $lte: new Date(Date.now() + 7 * DAY) } }).limit(500);
  let sent = 0;
  for (const u of users) {
    if (u.planReminderFor && u.planReminderFor.getTime() === u.planExpiresAt.getTime()) continue;
    try {
      await email.send({ to: u.email, ...email.templates.renewalReminder(u.name, u.planExpiresAt) });
      u.planReminderFor = u.planExpiresAt; await u.save(); sent += 1;
    } catch (err) { logger.warn(`renewal reminder failed ${u._id}: ${err.message}`); }
  }
  return sent;
}

// No-ghosting rule: a job whose oldest unanswered application is 14+ days old, and whose poster
// hasn't touched applicants for 14 days, closes. Every waiting applicant is told, and it counts
// against the poster's response rate. Posters get a warning from day 10.
async function noGhosting(now = Date.now()) {
  let warned = 0; let closed = 0;
  const waiting = await JobApplication.find({ status: { $in: ['submitted', 'shortlisted'] }, respondedAt: null, createdAt: { $lte: new Date(now - 10 * DAY) } }).select('job createdAt').lean();
  const jobIds = [...new Set(waiting.map((a) => String(a.job)))];
  for (const id of jobIds) {
    const job = await Job.findById(id);
    if (!job || job.status !== 'open') continue;
    const oldest = Math.min(...waiting.filter((a) => String(a.job) === id).map((a) => new Date(a.createdAt).getTime()));
    const lastActive = new Date(job.posterActiveAt || job.createdAt).getTime();
    const quiet = now - Math.max(lastActive, oldest);
    const poster = await User.findById(job.postedBy).select('email name').lean();
    if (!poster) continue;
    if (quiet >= 14 * DAY) {
      job.status = 'closed'; job.closedReason = 'no_response'; await job.save();
      const apps = await JobApplication.find({ job: job._id, status: { $in: ['submitted', 'shortlisted'] } });
      for (const a of apps) {
        a.status = 'closed'; await a.save();
        const u = await User.findById(a.applicant).select('email name notifications').lean();
        if (u && wants(u, 'jobAlerts')) {
          email.send({ to: u.email, subject: `Closed without an answer: ${job.title}`, html: email.layout({ heading: 'This job closed', intro: `“${email.esc(job.title)}” closed because the client didn’t answer applicants for 14 days. It’s recorded on their report card so others know.`, action: { label: 'Find more work', url: `${env.CLIENT_URL}/jobs` } }) }).catch(() => {});
        }
      }
      await reputation.touch(poster._id);
      closed += 1;
    } else if (quiet >= 10 * DAY && (!job.reminderSentAt || now - job.reminderSentAt.getTime() > 5 * DAY)) {
      job.reminderSentAt = new Date(now); await job.save();
      email.send({ to: poster.email, subject: `Applicants are waiting: ${job.title}`, html: email.layout({ heading: 'People are waiting to hear back', intro: `Applicants to “${email.esc(job.title)}” haven’t had an answer for over 10 days. If nobody replies within 4 days, the job closes automatically and it shows on your response rate. One tap answers everyone.`, action: { label: 'Answer applicants', url: `${env.CLIENT_URL}/jobs/${job._id}` } }) }).catch(() => {});
      warned += 1;
    }
  }
  return { warned, closed };
}

// Approved work not marked paid after 7 days → nudge the client (at most weekly).
async function paymentNudges(now = Date.now()) {
  // (Matched in code rather than $elemMatch so it runs on every Mongo-compatible store.)
  const rows = await Engagement.find({ status: { $in: ['active', 'ended'] }, 'milestones.status': 'approved' }).limit(1000);
  let sent = 0;
  for (const c of rows) {
    if (!c.milestones.some((m) => m.status === 'approved' && m.approvedAt && m.approvedAt.getTime() <= now - 7 * DAY)) continue;
    if (c.lastReminderAt && now - c.lastReminderAt.getTime() < 7 * DAY) continue;
    const client = await User.findById(c.client).select('email name').lean();
    if (!client) continue;
    const owed = c.milestones.filter((m) => m.status === 'approved');
    c.lastReminderAt = new Date(now); await c.save();
    await email.send({ to: client.email, subject: `Payment due: ${c.title}`, html: email.layout({ heading: 'You approved work that isn’t paid yet', intro: `On “${email.esc(c.title)}” you approved ${owed.length} milestone${owed.length > 1 ? 's' : ''} more than a week ago. Mark them paid once the money is sent — how quickly clients pay shows on their report card.`, action: { label: 'Open the contract', url: `${env.CLIENT_URL}/contracts/${c._id}` } }) }).then(() => { sent += 1; }).catch(() => {});
  }
  return sent;
}

// Review window over → reveal what was written, so nobody can hold a review hostage.
async function revealReviews(now = Date.now()) {
  const ended = await Engagement.find({ reviewWindowEndsAt: { $lte: new Date(now) } }).select('_id client freelancer').limit(2000).lean();
  const hidden = await Review.find({ engagement: { $in: ended.map((c) => c._id) }, visibleAt: null }).select('engagement').lean();
  if (!hidden.length) return 0;
  await Review.updateMany({ _id: { $in: hidden.map((r) => r._id) } }, { $set: { visibleAt: new Date(now) } });
  const touched = ended.filter((c) => hidden.some((h) => String(h.engagement) === String(c._id)));
  await reputation.touch(...touched.flatMap((c) => [c.client, c.freelancer]));
  return hidden.length;
}

const JOBS = { renewalReminders, noGhosting, paymentNudges, revealReviews };

router.get(['/daily', '/renewal-reminders'], asyncHandler(async (req, res) => {
  const results = {};
  for (const [name, job] of Object.entries(JOBS)) {
    try { results[name] = await job(); } catch (err) { results[name] = `error: ${err.message}`; logger.error(`cron ${name} failed: ${err.message}`); }
  }
  res.json({ ok: true, results });
}));

router.jobs = JOBS;
module.exports = router;
