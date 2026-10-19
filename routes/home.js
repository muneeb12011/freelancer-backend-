// routes/home.js — GET /api/home: what needs you today, as a freelancer and as a client.
const router = require('express').Router();
const Job = require('../models/Job');
const JobApplication = require('../models/JobApplication');
const Engagement = require('../models/Engagement');
const Squad = require('../models/Squad');
const PayoutMethod = require('../models/PayoutMethod');
const { protect } = require('../middleware/auth');
const { asyncHandler } = require('../utils/http');

router.use(protect);

const DAY = 86400e3;

const jobSearch = require('../services/jobSearch');
const profiles = require('../services/profiles');

router.get('/', asyncHandler(async (req, res) => {
  profiles.ensureHandle(req.user).catch(() => {});
  const me = req.user._id;
  const now = Date.now();
  const monthStart = new Date(); monthStart.setUTCDate(1); monthStart.setUTCHours(0, 0, 0, 0);

  const [apps, myJobs, waitingApps, contracts, invites, payoutCount] = await Promise.all([
    JobApplication.find({ applicant: me }).select('status viewedAt createdAt job').sort({ createdAt: -1 }).limit(300).populate('job', 'title status').lean(),
    Job.find({ postedBy: me, status: { $in: ['open', 'review'] } }).select('title status applicationsCount createdAt kind safety.verdict').lean(),
    JobApplication.find({ poster: me, status: { $in: ['submitted', 'shortlisted'] }, respondedAt: null }).select('job createdAt').lean(),
    Engagement.find({ $or: [{ client: me }, { freelancer: me }], status: { $in: ['draft', 'active', 'completed', 'ended'] } }).select('-events').sort({ updatedAt: -1 }).limit(200).lean(),
    Squad.find({ 'members.user': me }).select('members').lean()
      .then((rows) => rows.filter((s) => s.members.some((m) => String(m.user) === String(me) && m.status === 'invited')).length),
    PayoutMethod.countDocuments({ user: me }),
  ]);

  const todo = [];
  const push = (t) => todo.push(t);

  // Contracts that need this person
  for (const c of contracts) {
    const role = String(c.client) === String(me) ? 'client' : 'freelancer';
    const base = { contract: c._id, title: c.title, to: `/contracts/${c._id}` };
    if (c.status === 'draft' && !c.signatures?.[role]?.at) push({ ...base, kind: 'sign', text: `Review and sign “${c.title}”` });
    (c.changeRequests || []).filter((x) => x.status === 'pending' && String(x.by) !== String(me)).forEach((x) => push({ ...base, kind: 'change', text: `Answer the change request “${x.title}”` }));
    for (const m of c.milestones || []) {
      if (role === 'client' && m.status === 'submitted') push({ ...base, kind: 'review', text: `Review the delivery “${m.title}”` });
      if (role === 'client' && m.status === 'approved') push({ ...base, kind: 'pay', text: `Pay ${c.currency} ${m.amount} for “${m.title}” and mark it paid`, late: now - new Date(m.approvedAt).getTime() > 7 * DAY });
      if (role === 'client' && m.status === 'paid' && m.payment?.disputedAt) push({ ...base, kind: 'dispute', text: `The freelancer hasn’t received “${m.title}” — check the transfer`, late: true });
      if (role === 'freelancer' && m.status === 'paid' && !m.payment?.disputedAt) push({ ...base, kind: 'confirm', text: `Confirm you received ${c.currency} ${m.amount} for “${m.title}”` });
      if (role === 'freelancer' && c.status === 'active' && m.status === 'open' && m.dueDate && new Date(m.dueDate).getTime() - now < 3 * DAY) push({ ...base, kind: 'deliver', text: `Deliver “${m.title}”`, due: m.dueDate, late: new Date(m.dueDate).getTime() < now });
    }
    if (['completed', 'ended'].includes(c.status) && c.reviewWindowEndsAt && new Date(c.reviewWindowEndsAt).getTime() > now) push({ ...base, kind: 'review-contract', text: `Leave a review for “${c.title}”`, checkReview: true });
  }

  // No-ghosting countdown for my job posts
  const byJob = waitingApps.reduce((m, a) => { (m[a.job] = m[a.job] || []).push(a); return m; }, {});
  const jobs = myJobs.map((j) => {
    const waiting = byJob[j._id] || [];
    const oldest = waiting.length ? Math.min(...waiting.map((a) => new Date(a.createdAt).getTime())) : null;
    const daysLeft = oldest ? Math.max(0, 14 - Math.floor((now - oldest) / DAY)) : null;
    if (waiting.length) push({ kind: 'answer', to: `/jobs/${j._id}`, text: `${waiting.length} applicant${waiting.length > 1 ? 's' : ''} waiting on “${j.title}”`, late: daysLeft !== null && daysLeft <= 4, daysLeft });
    return { _id: j._id, title: j.title, status: j.status, kind: j.kind, applications: j.applicationsCount, waiting: waiting.length, daysLeft, verdict: j.safety?.verdict };
  });

  if (invites) push({ kind: 'squad', to: '/talent?tab=squads', text: `You have ${invites} squad invitation${invites > 1 ? 's' : ''}` });

  // Review prompts: drop the ones already written
  const Review = require('../models/Review');
  const written = new Set((await Review.find({ from: me, engagement: { $in: todo.filter((t) => t.checkReview).map((t) => t.contract) } }).select('engagement').lean()).map((r) => String(r.engagement)));
  const items = todo.filter((t) => !(t.checkReview && written.has(String(t.contract)))).sort((a, b) => Number(Boolean(b.late)) - Number(Boolean(a.late)));

  // Money (received as freelancer / paid as client), grouped by currency
  const sumBy = (rows, pick) => rows.reduce((acc, c) => {
    (c.milestones || []).filter(pick).forEach((m) => { acc[c.currency] = (acc[c.currency] || 0) + m.amount; });
    return acc;
  }, {});
  const asFreelancer = contracts.filter((c) => String(c.freelancer) === String(me));
  const asClient = contracts.filter((c) => String(c.client) === String(me));

  const appCounts = apps.reduce((m, a) => { const k = a.status === 'submitted' && a.viewedAt ? 'viewed' : a.status; m[k] = (m[k] || 0) + 1; return m; }, {});

  const forYou = (await jobSearch.forYou(req.user, JobApplication, 4)).map((j) => ({ _id: j._id, title: j.title, kind: j.kind, budgetMin: j.budgetMin, budgetMax: j.budgetMax, budgetType: j.budgetType, currency: j.currency, matchedSkills: j.matchedSkills, createdAt: j.createdAt, applicationsCount: j.applicationsCount }));
  res.json({
    forYou,
    todo: items.slice(0, 30),
    freelancer: {
      applications: appCounts,
      recentApplications: apps.slice(0, 6).map((a) => ({ _id: a._id, status: a.status, viewed: Boolean(a.viewedAt), createdAt: a.createdAt, job: a.job ? { _id: a.job._id, title: a.job.title, status: a.job.status } : null })),
      activeContracts: asFreelancer.filter((c) => c.status === 'active').length,
      receivedThisMonth: sumBy(asFreelancer, (m) => m.status === 'received' && m.payment?.confirmedAt && new Date(m.payment.confirmedAt) >= monthStart),
      awaitingPayment: sumBy(asFreelancer, (m) => ['approved', 'paid'].includes(m.status)),
      payoutMethods: payoutCount,
    },
    client: {
      jobs,
      activeContracts: asClient.filter((c) => c.status === 'active').length,
      owed: sumBy(asClient, (m) => m.status === 'approved'),
    },
    setup: {
      email: req.user.emailVerified,
      identity: req.user.identity?.status || 'none',
      payout: (req.user.payoutTypes || []).length > 0,
      profile: Boolean(req.user.title && (req.user.skills || []).length && req.user.bio),
      photo: Boolean(req.user.avatar),
    },
    reputation: req.user.reputation || {},
  });
}));

module.exports = router;
