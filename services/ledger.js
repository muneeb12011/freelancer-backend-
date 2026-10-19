// services/ledger.js — Aurelance's public record of itself.
// The same idea as a report card, pointed at the platform: how often clients answer applicants,
// how long payments take after approval, how many scam posts were stopped, how disputes end.
// Shown on the sign-in, About and How-it-works pages.
//
// Privacy rules, because a small marketplace makes people easy to pick out:
//   • no names, handles or exact amounts; amounts become ranges, times become days
//   • nothing from the last 2 hours, so an event can't be matched to something you just saw
//   • a figure is only shown when it rests on at least MIN_SAMPLE cases; otherwise it says so
const Engagement = require('../models/Engagement');
const JobApplication = require('../models/JobApplication');
const Job = require('../models/Job');
const Dispute = require('../models/Dispute');
const Ticket = require('../models/Ticket');

const DAY = 86400e3;
const MIN_SAMPLE = 5;
const CACHE_MS = 10 * 60e3;
let cache = null;

const median = (xs) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const round1 = (n) => (n === null ? null : Math.round(n * 10) / 10);
const pct = (a, b) => (b ? Math.round((a / b) * 100) : null);
/** A figure with its sample size; the value is withheld below the minimum. */
const fig = (value, n) => ({ value: n >= MIN_SAMPLE ? value : null, n, enough: n >= MIN_SAMPLE });
const dayOf = (d) => new Date(d).toISOString().slice(0, 10);

function bucket(amount, currency) {
  const usdish = currency === 'PKR' ? amount / 280 : amount; // ranges only need the scale right
  const ranges = [[0, 50, 'under 50'], [50, 100, '50–100'], [100, 500, '100–500'], [500, 1500, '500–1,500'], [1500, Infinity, 'over 1,500']];
  const [, , label] = ranges.find(([lo, hi]) => usdish >= lo && usdish < hi);
  return currency === 'PKR' ? `${label} USD-equivalent, paid in PKR` : `${currency} ${label}`;
}
const FLAG_PHRASE = {
  upfront_fee: 'asking applicants for a fee before starting',
  personal_data: 'asking for ID copies or banking details',
  crypto_cheque: 'offering payment by crypto or cheque',
  off_platform: 'pushing people to WhatsApp or Telegram',
  easy_money: 'promising easy daily earnings',
  disguised: 'disguising its words to get past filters',
};
const DISPUTE_KIND = { payment_not_received: 'a payment that didn’t arrive', work_not_delivered: 'work that wasn’t delivered', work_not_as_agreed: 'work that didn’t match the scope', scope: 'what the scope covered', other: 'a contract' };
const OUTCOME = { for_opener: 'decided for the person who raised it', for_other: 'decided for the other side', shared: 'responsibility was shared', no_fault: 'nobody was found at fault' };

async function compute(now = Date.now()) {
  const d30 = new Date(now - 30 * DAY);
  const d90 = new Date(now - 90 * DAY);
  const hold = new Date(now - 2 * 3600e3);
  const [apps, payRows, signed, held, warned, ghosted, disputesOpened, disputesDone, tickets, recentContracts, recentPaid, recentHeld, recentDisputes, recentGhost] = await Promise.all([
    JobApplication.find({ createdAt: { $gte: new Date(now - 37 * DAY), $lte: new Date(now - 7 * DAY) }, status: { $ne: 'withdrawn' } }).select('createdAt respondedAt').lean(),
    Engagement.find({ 'milestones.payment.markedAt': { $gte: d90 } }).select('milestones.approvedAt milestones.payment.markedAt').lean(),
    Engagement.countDocuments({ signedAt: { $gte: d30 } }),
    Job.countDocuments({ 'safety.verdict': 'held', createdAt: { $gte: d30 } }),
    Job.countDocuments({ 'safety.verdict': 'warn', createdAt: { $gte: d30 } }),
    Job.countDocuments({ closedReason: 'no_response', updatedAt: { $gte: d30 } }),
    Dispute.countDocuments({ createdAt: { $gte: d90 } }),
    Dispute.find({ status: 'resolved', 'resolution.at': { $gte: d90 } }).select('createdAt resolution').lean(),
    Ticket.find({ firstResponseAt: { $ne: null }, createdAt: { $gte: d90 } }).select('createdAt firstResponseAt').lean(),
    Engagement.find({ signedAt: { $gte: new Date(now - 14 * DAY), $lte: hold } }).select('signedAt billing kind job').sort({ signedAt: -1 }).limit(8).lean(),
    Engagement.find({ 'milestones.payment.confirmedAt': { $gte: new Date(now - 14 * DAY), $lte: hold } }).select('currency milestones').limit(20).lean(),
    Job.find({ 'safety.verdict': 'held', createdAt: { $gte: new Date(now - 14 * DAY), $lte: hold } }).select('createdAt safety.flags').sort({ createdAt: -1 }).limit(6).lean(),
    Dispute.find({ status: 'resolved', 'resolution.at': { $gte: new Date(now - 30 * DAY), $lte: hold } }).select('kind resolution').limit(6).lean(),
    Job.find({ closedReason: 'no_response', updatedAt: { $gte: new Date(now - 14 * DAY), $lte: hold } }).select('updatedAt').limit(4).lean(),
  ]);

  const answered = apps.filter((a) => a.respondedAt && new Date(a.respondedAt) - new Date(a.createdAt) <= 7 * DAY).length;
  const payDays = payRows.flatMap((c) => c.milestones || [])
    .filter((m) => m.approvedAt && m.payment?.markedAt && new Date(m.payment.markedAt) >= d90)
    .map((m) => Math.max(0, (new Date(m.payment.markedAt) - new Date(m.approvedAt)) / DAY));
  const resolveDays = disputesDone.map((d) => (new Date(d.resolution.at) - new Date(d.createdAt)) / DAY);
  const replyHours = tickets.map((t) => (new Date(t.firstResponseAt) - new Date(t.createdAt)) / 3600e3);

  const categories = {};
  const jobIds = recentContracts.map((c) => c.job).filter(Boolean);
  if (jobIds.length) for (const j of await Job.find({ _id: { $in: jobIds } }).select('category').lean()) categories[String(j._id)] = j.category;

  const entries = [];
  for (const c of recentContracts) {
    const what = c.kind === 'trial' ? 'A paid trial' : c.billing === 'hourly' ? 'An hourly contract' : 'A fixed-price contract';
    const cat = c.job && categories[String(c.job)] ? ` in ${categories[String(c.job)]}` : '';
    entries.push({ day: dayOf(c.signedAt), kind: 'signed', text: `${what}${cat} was signed by both sides` });
  }
  for (const c of recentPaid) {
    for (const m of c.milestones || []) {
      const at = m.payment?.confirmedAt;
      if (!at || new Date(at) < new Date(now - 14 * DAY) || new Date(at) > hold) continue;
      const days = m.approvedAt && m.payment?.markedAt ? Math.max(0, Math.round((new Date(m.payment.markedAt) - new Date(m.approvedAt)) / DAY)) : null;
      entries.push({ day: dayOf(at), kind: 'paid', text: `A payment of ${bucket(m.amount, c.currency)} was confirmed received${days === null ? '' : days === 0 ? ', paid the day it was approved' : `, paid ${days} day${days === 1 ? '' : 's'} after approval`}` });
    }
  }
  for (const j of recentHeld) {
    const f = (j.safety?.flags || []).map((x) => FLAG_PHRASE[x.code]).find(Boolean);
    entries.push({ day: dayOf(j.createdAt), kind: 'held', text: `A job post ${f || 'matching scam patterns'} was held before anyone saw it` });
  }
  for (const d of recentDisputes) entries.push({ day: dayOf(d.resolution.at), kind: 'dispute', text: `A dispute about ${DISPUTE_KIND[d.kind] || 'a contract'} was settled: ${OUTCOME[d.resolution.outcome] || 'decided'}` });
  for (const j of recentGhost) entries.push({ day: dayOf(j.updatedAt), kind: 'ghosted', text: 'A job post closed after 14 days without answering applicants — it’s on that client’s record' });
  entries.sort((a, b) => (a.day < b.day ? 1 : -1));

  return {
    computedAt: new Date(now).toISOString(),
    minSample: MIN_SAMPLE,
    figures: {
      applicationsAnsweredIn7Days: fig(pct(answered, apps.length), apps.length),
      medianDaysToPay: fig(round1(median(payDays)), payDays.length),
      paidWithinAWeek: fig(pct(payDays.filter((d) => d <= 7).length, payDays.length), payDays.length),
      medianDaysToSettleDispute: fig(round1(median(resolveDays)), resolveDays.length),
      supportFirstReplyHours: fig(round1(median(replyHours)), replyHours.length),
    },
    counts: { contractsSigned30d: signed, scamPostsHeld30d: held, postsWithWarning30d: warned, postsClosedUnanswered30d: ghosted, disputesOpened90d: disputesOpened },
    entries: entries.slice(0, 12),
  };
}

async function get() {
  if (cache && Date.now() - cache.at < CACHE_MS) return cache.value;
  const value = await compute();
  cache = { at: Date.now(), value };
  return value;
}

module.exports = { get, compute, bucket, MIN_SAMPLE, _reset: () => { cache = null; } };
