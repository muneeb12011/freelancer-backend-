// routes/cron.js — scheduled jobs. One daily entry point (Vercel Cron Hobby allows daily jobs):
//   GET /api/cron/daily   Authorization: Bearer $CRON_SECRET
// Runs: Premium renewal reminders · task-due-tomorrow reminders · newly overdue invoices · Monday digest.
const router  = require('express').Router();
const env     = require('../config/env');
const logger  = require('../utils/logger');
const User    = require('../models/User');
const Task    = require('../models/Task');
const Invoice = require('../models/Invoice');
const email   = require('../services/email');
const { asyncHandler } = require('../utils/http');
const { safeEqual } = require('../utils/tokens');

router.use((req, res, next) => {
  const token = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  if (!env.CRON_SECRET || !safeEqual(token, env.CRON_SECRET)) return res.status(401).json({ error: 'Unauthorized' });
  return next();
});

const wants = (u, key) => (u.notifications || {})[key] !== false;
const usd = (n) => `$${Number(n || 0).toLocaleString('en-US', { maximumFractionDigits: 2 })}`;
const ymd = (d) => d.toISOString().slice(0, 10);

async function renewalReminders() {
  const now = new Date();
  const users = await User.find({ plan: 'premium', planCancelAtPeriodEnd: { $ne: true }, planExpiresAt: { $gt: now, $lte: new Date(Date.now() + 7 * 86400e3) } }).limit(500);
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

async function taskReminders() {
  const start = new Date(); start.setUTCHours(24, 0, 0, 0);
  const end = new Date(start.getTime() + 86400e3);
  const tasks = await Task.find({ completed: false, status: { $ne: 'done' }, deadline: { $gte: start, $lt: end } }).select('user title taskNumber').lean();
  const byUser = tasks.reduce((m, t) => { (m[t.user] = m[t.user] || []).push(t); return m; }, {});
  let sent = 0;
  for (const [uid, list] of Object.entries(byUser)) {
    const u = await User.findById(uid);
    if (!u || !wants(u, 'taskReminders')) continue;
    const items = list.slice(0, 10).map((t) => `• ${email.esc(t.taskNumber || '')} ${email.esc(t.title)}`).join('<br>');
    await email.send({
      to: u.email,
      subject: list.length === 1 ? `Due tomorrow: ${list[0].title}` : `${list.length} tasks are due tomorrow`,
      html: email.layout({ heading: 'Due tomorrow', intro: `Hi ${email.esc(u.name)}, these are due tomorrow:<br><br>${items}`, action: { label: 'Open tasks', url: `${env.CLIENT_URL}/tasks` } }),
    }).then(() => { sent += 1; }).catch(() => {});
  }
  return sent;
}

async function overdueInvoices() {
  const yesterday = ymd(new Date(Date.now() - 86400e3));
  const invoices = await Invoice.find({ status: { $in: ['sent', 'draft'] }, dueDate: yesterday }).select('user invoiceNumber clientName total').lean();
  const byUser = invoices.reduce((m, i) => { (m[i.user] = m[i.user] || []).push(i); return m; }, {});
  let sent = 0;
  for (const [uid, list] of Object.entries(byUser)) {
    const u = await User.findById(uid);
    if (!u || !wants(u, 'overdueAlerts')) continue;
    const items = list.map((i) => `• ${email.esc(i.invoiceNumber)} — ${email.esc(i.clientName)} — ${usd(i.total)}`).join('<br>');
    await email.send({
      to: u.email,
      subject: list.length === 1 ? `${list[0].clientName}’s invoice is now overdue` : `${list.length} invoices became overdue`,
      html: email.layout({ heading: 'Now overdue', intro: `Hi ${email.esc(u.name)}, these invoices passed their due date yesterday:<br><br>${items}<br><br>A short, friendly reminder today usually gets them paid this week.`, action: { label: 'Open invoices', url: `${env.CLIENT_URL}/invoices` } }),
    }).then(() => { sent += 1; }).catch(() => {});
  }
  return sent;
}

async function weeklyDigest() {
  if (new Date().getUTCDay() !== 1) return 0; // Mondays
  const since = new Date(Date.now() - 7 * 86400e3);
  const users = await User.find({ 'notifications.emailDigest': { $ne: false }, lastLoginAt: { $gte: new Date(Date.now() - 60 * 86400e3) } }).limit(2000);
  let sent = 0;
  for (const u of users) {
    const [paid, open, due] = await Promise.all([
      Invoice.find({ user: u._id, status: 'paid', paidAt: { $gte: since } }).select('total').lean(),
      Invoice.find({ user: u._id, status: { $in: ['sent', 'overdue'] } }).select('total').lean(),
      Task.countDocuments({ user: u._id, completed: false, deadline: { $gte: new Date(), $lt: new Date(Date.now() + 7 * 86400e3) } }),
    ]);
    if (!paid.length && !open.length && !due) continue;
    const sum = (rows) => rows.reduce((s, r) => s + (r.total || 0), 0);
    await email.send({
      to: u.email,
      subject: 'Your week in Aurelance',
      html: email.layout({
        heading: 'Your week',
        intro: `Hi ${email.esc(u.name)},<br><br>Collected last 7 days: <strong>${usd(sum(paid))}</strong> (${paid.length} invoice${paid.length === 1 ? '' : 's'})<br>Still owed to you: <strong>${usd(sum(open))}</strong><br>Tasks due this week: <strong>${due}</strong>`,
        action: { label: 'Open dashboard', url: `${env.CLIENT_URL}/dashboard` },
        outro: 'Turn this off in Settings → Notifications.',
      }),
    }).then(() => { sent += 1; }).catch(() => {});
  }
  return sent;
}

router.get(['/daily', '/renewal-reminders'], asyncHandler(async (req, res) => {
  const results = {};
  for (const [name, job] of Object.entries({ renewalReminders, taskReminders, overdueInvoices, weeklyDigest })) {
    try { results[name] = await job(); } catch (err) { results[name] = `error: ${err.message}`; logger.error(`cron ${name} failed: ${err.message}`); }
  }
  res.json({ ok: true, results });
}));

module.exports = router;
