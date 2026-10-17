// services/reputation.js — report cards built from what actually happened on Aurelance,
// not from self-description. Stored on the user (User.reputation) so job lists and search can show
// them without extra queries, and recomputed whenever something that feeds them changes.
//
// As a client:  how fast they answer applicants, whether they ghost, how quickly they pay after
//               approving work, payment disputes, and what freelancers said about them.
// As a freelancer: contracts finished, deliveries on time, revisions, and what clients said.
const Engagement = require('../models/Engagement');
const JobApplication = require('../models/JobApplication');
const Job = require('../models/Job');
const Review = require('../models/Review');
const User = require('../models/User');
const logger = require('../utils/logger');

const DAY = 86400e3;
const avg = (xs) => (xs.length ? Math.round((xs.reduce((s, x) => s + x, 0) / xs.length) * 10) / 10 : null);
const median = (xs) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const pct = (a, b) => (b ? Math.round((a / b) * 100) : null);

async function clientCard(userId) {
  const now = Date.now();
  const [jobsPosted, apps, contracts, reviews] = await Promise.all([
    Job.countDocuments({ postedBy: userId, status: { $ne: 'review' } }),
    JobApplication.find({ poster: userId, status: { $ne: 'withdrawn' } }).select('createdAt respondedAt status').lean(),
    Engagement.find({ client: userId, status: { $ne: 'draft' } }).select('status milestones.status milestones.approvedAt milestones.payment milestones.amount').lean(),
    Review.find({ to: userId, direction: 'of_client', visibleAt: { $ne: null } }).select('ratings wouldWorkAgain').lean(),
  ]);

  // Response rate: of applications at least 7 days old (or already answered), how many got an answer within 7 days.
  const due = apps.filter((a) => a.respondedAt || now - new Date(a.createdAt).getTime() > 7 * DAY);
  const answered = due.filter((a) => a.respondedAt && new Date(a.respondedAt) - new Date(a.createdAt) <= 7 * DAY);
  const responseHours = apps.filter((a) => a.respondedAt).map((a) => (new Date(a.respondedAt) - new Date(a.createdAt)) / 3600e3);

  const milestones = contracts.flatMap((c) => c.milestones || []);
  const approved = milestones.filter((m) => m.approvedAt);
  const paid = approved.filter((m) => m.payment?.markedAt);
  const payDays = paid.map((m) => Math.max(0, (new Date(m.payment.markedAt) - new Date(m.approvedAt)) / DAY));
  const onTime = payDays.filter((d) => d <= 7).length;
  const overdue = approved.filter((m) => !m.payment?.markedAt && now - new Date(m.approvedAt).getTime() > 14 * DAY).length;
  const disputes = milestones.filter((m) => m.payment?.disputedAt && !m.payment?.confirmedAt).length;

  const r = (k) => avg(reviews.map((x) => x.ratings?.[k]).filter(Boolean));
  return {
    jobsPosted,
    hires: contracts.length,
    applicationsAnswered: answered.length,
    applicationsDue: due.length,
    responseRate: due.length >= 3 ? pct(answered.length, due.length) : null,
    medianResponseHours: responseHours.length ? Math.round(median(responseHours)) : null,
    ghosted: apps.filter((a) => a.status === 'closed').length,
    milestonesPaid: paid.length,
    avgPayDays: payDays.length ? Math.round(avg(payDays) * 10) / 10 : null,
    paidOnTimeRate: paid.length ? pct(onTime, paid.length) : null,
    overduePayments: overdue,
    openDisputes: disputes,
    reviews: reviews.length,
    payment: r('payment'),
    scope: r('scope'),
    communication: r('communication'),
    respect: r('respect'),
    workAgainRate: reviews.length ? pct(reviews.filter((x) => x.wouldWorkAgain).length, reviews.length) : null,
  };
}

async function freelancerCard(userId) {
  const [contracts, reviews] = await Promise.all([
    Engagement.find({ freelancer: userId, status: { $ne: 'draft' } }).select('status kind milestones.status milestones.dueDate milestones.delivery.at milestones.revisions').lean(),
    Review.find({ to: userId, direction: 'of_freelancer', visibleAt: { $ne: null } }).select('ratings wouldWorkAgain').lean(),
  ]);
  const milestones = contracts.flatMap((c) => c.milestones || []);
  const delivered = milestones.filter((m) => m.delivery?.at);
  const withDue = delivered.filter((m) => m.dueDate);
  const onTime = withDue.filter((m) => new Date(m.delivery.at) <= new Date(new Date(m.dueDate).getTime() + DAY)).length;
  const r = (k) => avg(reviews.map((x) => x.ratings?.[k]).filter(Boolean));
  return {
    contracts: contracts.length,
    completed: contracts.filter((c) => c.status === 'completed').length,
    active: contracts.filter((c) => c.status === 'active').length,
    trials: contracts.filter((c) => c.kind === 'trial').length,
    milestonesDelivered: delivered.length,
    onTimeRate: withDue.length ? pct(onTime, withDue.length) : null,
    avgRevisions: delivered.length ? avg(delivered.map((m) => (m.revisions || []).length)) : null,
    reviews: reviews.length,
    quality: r('quality'),
    communication: r('communication'),
    deadlines: r('deadlines'),
    workAgainRate: reviews.length ? pct(reviews.filter((x) => x.wouldWorkAgain).length, reviews.length) : null,
  };
}

async function refresh(userId) {
  if (!userId) return null;
  try {
    const [asClient, asFreelancer] = await Promise.all([clientCard(userId), freelancerCard(userId)]);
    const reputation = { asClient, asFreelancer, updatedAt: new Date() };
    await User.updateOne({ _id: userId }, { $set: { reputation } });
    return reputation;
  } catch (err) {
    logger.warn(`reputation refresh failed for ${userId}: ${err.message}`);
    return null;
  }
}

/** Fire-and-forget refresh for several users. */
function touch(...ids) {
  const unique = [...new Set(ids.filter(Boolean).map(String))];
  return Promise.all(unique.map(refresh));
}

module.exports = { refresh, touch, clientCard, freelancerCard };
