// services/timesheets.js — hourly contracts: weeks, caps, and turning a week of logged time into
// a timesheet milestone that then follows the normal approve → paid → received flow.
const TimeEntry = require('../models/TimeEntry');
const { badRequest } = require('../utils/http');

const DAY = 86400e3;

/** 'YYYY-MM-DD' → Date at UTC midnight (or null). */
function parseDay(s) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(s || ''))) return null;
  const d = new Date(`${s}T00:00:00Z`);
  return Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== s ? null : d;
}
const dayStr = (d) => new Date(d).toISOString().slice(0, 10);
/** Monday of the week a day falls in (weeks run Monday–Sunday, UTC). */
function weekOf(day) {
  const d = typeof day === 'string' ? parseDay(day) : new Date(Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate()));
  const back = (d.getUTCDay() + 6) % 7;
  return dayStr(d.getTime() - back * DAY);
}
const weekDays = (week) => Array.from({ length: 7 }, (_, i) => dayStr(parseDay(week).getTime() + i * DAY));
const weekLabel = (week) => parseDay(week).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
const hours = (min) => Math.round((min / 60) * 100) / 100;
const fmtHours = (min) => { const h = Math.floor(min / 60); const m = min % 60; return m ? `${h} h ${m} min` : `${h} h`; };

/** The week's timesheet milestone, if one was created. */
const sheetFor = (c, week) => (c.milestones || []).find((m) => m.source === 'timesheet' && m.week === week);
/** A week can be edited while it has no timesheet, or its timesheet was sent back (status open). */
const weekOpen = (c, week) => { const s = sheetFor(c, week); return !s || s.status === 'open'; };

function cleanTerms(body, { partial = false } = {}) {
  const out = {};
  if (!partial || body.rate !== undefined) {
    const rate = Number(body.rate);
    if (!Number.isFinite(rate) || rate <= 0 || rate > 1000) throw badRequest('Set an hourly rate above zero');
    out.rate = Math.round(rate * 100) / 100;
  }
  if (!partial || body.weeklyCap !== undefined) {
    const cap = parseInt(body.weeklyCap, 10);
    if (!Number.isFinite(cap) || cap < 1 || cap > 80) throw badRequest('Set a weekly limit between 1 and 80 hours');
    out.weeklyCap = cap;
  }
  return out;
}

/** Minutes already logged in a week, optionally leaving one entry out (when editing it). */
async function weekMinutes(engagementId, week, exceptId) {
  const rows = await TimeEntry.find({ engagement: engagementId, week, ...(exceptId ? { _id: { $ne: exceptId } } : {}) }).select('minutes').lean();
  return rows.reduce((s, r) => s + r.minutes, 0);
}

/** Validate a new or edited entry against the contract, the day and the weekly limit. */
async function checkEntry(c, { date, minutes, note }, exceptId) {
  const d = parseDay(date);
  if (!d) throw badRequest('Pick the day you worked');
  const today = Date.now();
  if (d.getTime() > today + DAY) throw badRequest('You can’t log time for a day that hasn’t happened yet');
  if (c.signedAt && d.getTime() < new Date(c.signedAt).getTime() - DAY) throw badRequest('That day is before the contract was signed');
  if (today - d.getTime() > 21 * DAY) throw badRequest('Time older than three weeks can’t be added. Ask the client for a change request instead.');
  const min = Math.round(Number(minutes));
  if (!Number.isFinite(min) || min < 1) throw badRequest('Log at least one minute');
  if (min > 16 * 60) throw badRequest('One entry can be at most 16 hours');
  const text = String(note || '').trim().slice(0, 300);
  if (text.length < 3) throw badRequest('Say what you worked on — the client sees this on the timesheet');
  const week = weekOf(date);
  if (!weekOpen(c, week)) throw badRequest('That week’s timesheet is already submitted. The client can send it back if something needs fixing.');
  const dayRows = await TimeEntry.find({ engagement: c._id, date, ...(exceptId ? { _id: { $ne: exceptId } } : {}) }).select('minutes').lean();
  if (dayRows.reduce((s, r) => s + r.minutes, 0) + min > 24 * 60) throw badRequest('That’s more than 24 hours on one day');
  const used = await weekMinutes(c._id, week, exceptId);
  const cap = (c.hourly?.weeklyCap || 0) * 60;
  if (cap && used + min > cap) {
    const left = Math.max(0, cap - used);
    throw badRequest(`That goes over the ${c.hourly.weeklyCap} h weekly limit. ${left ? `${fmtHours(left)} left this week.` : 'The limit is used up this week.'} The client can raise it.`);
  }
  return { date, week, minutes: min, note: text };
}

/**
 * Turn a week's entries into a submitted timesheet milestone (or refresh a sent-back one).
 * Returns the milestone, or null when there's nothing to bill.
 */
async function submitWeek(c, week) {
  if (!parseDay(week) || weekOf(week) !== week) throw badRequest('Pick a week');
  if (!weekOpen(c, week)) throw badRequest('This week is already submitted');
  const rows = await TimeEntry.find({ engagement: c._id, week }).sort({ date: 1, createdAt: 1 }).lean();
  const minutes = rows.reduce((s, r) => s + r.minutes, 0);
  if (!minutes) return null;
  const amount = Math.round(hours(minutes) * c.hourly.rate * 100) / 100;
  const byDay = rows.map((r) => `${parseDay(r.date).toLocaleDateString('en-US', { weekday: 'short', timeZone: 'UTC' })} ${fmtHours(r.minutes)} — ${r.note}`).join('\n');
  const title = `Week of ${weekLabel(week)} · ${fmtHours(minutes)}`;
  let m = sheetFor(c, week);
  if (m) {
    Object.assign(m, { title, amount, minutes, status: 'submitted', delivery: { note: byDay.slice(0, 3000), files: [], at: new Date() } });
  } else {
    c.milestones.push({ title, scope: `${fmtHours(minutes)} at ${c.currency} ${c.hourly.rate}/h, logged ${weekLabel(week)} – ${weekLabel(weekDays(week)[6])}.`, amount, source: 'timesheet', week, minutes, status: 'submitted', delivery: { note: byDay.slice(0, 3000), files: [], at: new Date() } });
    m = c.milestones[c.milestones.length - 1];
  }
  return m;
}

/** Weeks with logged time, newest first, and where each one stands. */
async function weeksSummary(c) {
  const rows = await TimeEntry.aggregate([{ $match: { engagement: c._id } }, { $group: { _id: '$week', minutes: { $sum: '$minutes' }, entries: { $sum: 1 } } }]).catch(async () => {
    // Engines without $group fallback: sum in JS.
    const all = await TimeEntry.find({ engagement: c._id }).select('week minutes').lean();
    const m = {};
    for (const r of all) { m[r.week] = m[r.week] || { _id: r.week, minutes: 0, entries: 0 }; m[r.week].minutes += r.minutes; m[r.week].entries += 1; }
    return Object.values(m);
  });
  const weeks = new Map(rows.map((r) => [r._id, { week: r._id, minutes: r.minutes, entries: r.entries }]));
  for (const ms of c.milestones || []) if (ms.source === 'timesheet' && !weeks.has(ms.week)) weeks.set(ms.week, { week: ms.week, minutes: ms.minutes || 0, entries: 0 });
  return [...weeks.values()].map((w) => {
    const s = sheetFor(c, w.week);
    return { ...w, label: weekLabel(w.week), sheet: s ? { _id: s._id, status: s.status, amount: s.amount } : null };
  }).sort((a, b) => (a.week < b.week ? 1 : -1));
}

module.exports = { parseDay, dayStr, weekOf, weekDays, weekLabel, fmtHours, hours, sheetFor, weekOpen, cleanTerms, checkEntry, submitWeek, weeksSummary, weekMinutes };
