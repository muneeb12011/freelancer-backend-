// routes/jobs.js — the jobs board.
//   GET    /api/jobs                       browse (q, category, skills, budgetType, min, max, locationType, experience, sort, page)
//   GET    /api/jobs/meta                  categories + enums + my limits
//   GET    /api/jobs/mine                  jobs I posted
//   GET    /api/jobs/applications/mine     my applications
//   GET    /api/jobs/saved                 my saved jobs
//   POST   /api/jobs                       post a job
//   GET    /api/jobs/:id                   job detail (+ my application, saved state)
//   PATCH  /api/jobs/:id                   edit (owner)
//   POST   /api/jobs/:id/status            { status: open|closed } (owner)
//   DELETE /api/jobs/:id                   delete (owner, only without hires)
//   POST   /api/jobs/:id/save · DELETE /api/jobs/:id/save
//   POST   /api/jobs/:id/apply             apply
//   DELETE /api/jobs/:id/apply             withdraw
//   GET    /api/jobs/:id/applications      applicants (owner)
//   PATCH  /api/jobs/applications/:appId   { status, note, declineReason } (owner) — hire drafts a contract
//   POST   /api/jobs/applications/:appId/trial  { title, scope, amount, days } (owner) — paid trial contract
//   POST   /api/jobs/:id/decline-rest      { reason } (owner) — answer everyone still waiting
//
// No-ghosting: opening the applicant list marks applications "Viewed"; every decision notifies the
// applicant; the poster's response rate is on every job; jobs left unanswered for 14 days auto-close (cron).
// Scam shield: every post is scanned — risky posts carry a warning, the worst wait for admin review.
const router = require('express').Router();
const Job = require('../models/Job');
const JobApplication = require('../models/JobApplication');
const User = require('../models/User');
const Squad = require('../models/Squad');
const scamShield = require('../services/scamShield');
const contracts = require('../services/contracts');
const reputation = require('../services/reputation');
const env = require('../config/env');
const email = require('../services/email');
const messaging = require('../services/messaging');
const { PLANS } = require('../config/plans');
const { protect } = require('../middleware/auth');
const { asyncHandler, badRequest, notFound, forbidden, HttpError } = require('../utils/http');
const { isId, str, clampInt, searchRegex, pick } = require('../utils/sanitize');
const { PUBLIC_USER_FIELDS, publicUser } = require('../utils/publicUser');

router.use(protect);

const EDITABLE = ['title', 'description', 'category', 'skills', 'budgetType', 'budgetMin', 'budgetMax', 'currency', 'duration', 'experience', 'locationType', 'location', 'applyBy', 'kind', 'trialSlots'];
const DECLINE_REASONS = { budget: 'the budget didn’t fit', skills: 'they needed different skills', experience: 'they needed more experience for this one', chose_other: 'they went with another applicant', not_hiring: 'they’re no longer hiring for this', other: '' };
const monthKey = () => new Date().toISOString().slice(0, 7);
const limitsFor = (user) => PLANS[user.effectivePlan]?.limits || PLANS.free.limits;

function cleanJob(body) {
  const j = pick(body, EDITABLE);
  if (j.skills !== undefined) j.skills = (Array.isArray(j.skills) ? j.skills : String(j.skills).split(',')).map((s) => str(s, 40)).filter(Boolean).slice(0, 12);
  for (const k of ['budgetMin', 'budgetMax']) if (j[k] !== undefined) j[k] = Math.max(0, Number(j[k]) || 0);
  if (j.budgetMin && j.budgetMax && j.budgetMin > j.budgetMax) [j.budgetMin, j.budgetMax] = [j.budgetMax, j.budgetMin];
  if (j.applyBy === '' || j.applyBy === null) j.applyBy = undefined;
  if (j.applyBy && Number.isNaN(new Date(j.applyBy).getTime())) throw badRequest('Pick a valid “apply by” date');
  if (j.title !== undefined) j.title = str(j.title, 120);
  if (j.description !== undefined) j.description = str(j.description, 8000);
  if (j.kind !== undefined) j.kind = j.kind === 'trial' ? 'trial' : 'standard';
  if (j.trialSlots !== undefined) j.trialSlots = Math.min(10, Math.max(1, parseInt(j.trialSlots, 10) || 3));
  if (j.kind === 'trial') { j.budgetType = 'fixed'; j.duration = '< 1 week'; }
  return j;
}

/** Run the scam shield and set safety + (for the worst posts) hold the job for review. */
function applySafety(job) {
  const { score, flags } = scamShield.analyze(job.title, job.description);
  const verdict = scamShield.verdictForJob(score);
  job.safety = { score, flags, verdict, reviewedAt: job.safety?.reviewedAt };
  if (verdict === 'held' && !job.safety.reviewedAt && job.status === 'open') job.status = 'review';
  return verdict;
}

async function notifyApplicant(app, job, poster, status) {
  const applicant = await User.findById(app.applicant).select('email name notifications').lean();
  if (!applicant || applicant.notifications?.jobAlerts === false) return;
  const why = DECLINE_REASONS[app.declineReason] ? ` They said ${DECLINE_REASONS[app.declineReason]}.` : '';
  const copy = {
    shortlisted: ['You’re on the shortlist', `${email.esc(poster.name)} shortlisted your application for <strong>${email.esc(job.title)}</strong>.`],
    rejected: ['Application update', `${email.esc(poster.name)} decided not to go ahead with your application for <strong>${email.esc(job.title)}</strong>.${email.esc(why)} At least you know — you can spend your time on the next one.`],
  }[status];
  if (!copy) return;
  email.send({ to: applicant.email, subject: `${copy[0]}: ${job.title}`, html: email.layout({ heading: copy[0], intro: copy[1], action: { label: 'View your applications', url: `${env.CLIENT_URL}/jobs?tab=applications` } }) }).catch(() => {});
}

const markResponded = (app) => { if (!app.respondedAt) app.respondedAt = new Date(); };

async function withPosters(jobs, me) {
  const ids = [...new Set(jobs.map((j) => String(j.postedBy)))];
  const users = await User.find({ _id: { $in: ids } }).select(PUBLIC_USER_FIELDS).lean();
  const byId = Object.fromEntries(users.map((u) => [String(u._id), publicUser(u)]));
  const saved = new Set((me.savedJobs || []).map(String));
  return jobs.map((j) => ({ ...j, poster: byId[String(j.postedBy)] || null, saved: saved.has(String(j._id)), mine: String(j.postedBy) === String(me._id) }));
}

async function loadJob(id) {
  if (!isId(id)) throw notFound('Job not found');
  const job = await Job.findById(id);
  if (!job) throw notFound('Job not found');
  return job;
}

// ── Browse ──────────────────────────────────────────────────────────────
router.get('/', asyncHandler(async (req, res) => {
  const f = { status: 'open' };
  const { q, category, skills, budgetType, locationType, experience } = req.query;
  if (q) { const re = searchRegex(q); f.$or = [{ title: re }, { description: re }, { skills: re }]; }
  if (category && Job.CATEGORIES.includes(category)) f.category = category;
  if (skills) f.skills = { $in: String(skills).split(',').map((s) => new RegExp(`^${s.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i')).slice(0, 10) };
  if (['fixed', 'hourly'].includes(budgetType)) f.budgetType = budgetType;
  if (['remote', 'onsite', 'hybrid'].includes(locationType)) f.locationType = locationType;
  if (['Entry', 'Intermediate', 'Expert'].includes(experience)) f.experience = experience;
  if (req.query.min) f.budgetMax = { $gte: Number(req.query.min) || 0 };
  if (req.query.max) f.budgetMin = { $lte: Number(req.query.max) || 0 };
  if (req.query.hideMine === 'true') f.postedBy = { $ne: req.user._id };
  if (['standard', 'trial'].includes(req.query.kind)) f.kind = req.query.kind === 'standard' ? { $ne: 'trial' } : 'trial';
  if (req.query.safeOnly === 'true') f['safety.verdict'] = { $ne: 'warn' };
  // Reliable clients: answer applicants (response rate ≥ 60%) or have a verified identity.
  if (req.query.reliable === 'true') {
    const good = await User.find({ $or: [{ 'reputation.asClient.responseRate': { $gte: 60 } }, { 'identity.status': 'approved' }] }).select('_id').limit(5000).lean();
    f.postedBy = { ...(f.postedBy || {}), $in: good.map((u) => u._id) };
  }

  const sort = { newest: { createdAt: -1 }, budget: { budgetMax: -1, createdAt: -1 }, fewest: { applicationsCount: 1, createdAt: -1 } }[req.query.sort] || { createdAt: -1 };
  const limit = clampInt(req.query.limit, { max: 50, def: 20 });
  const page = clampInt(req.query.page, { min: 1, max: 500, def: 1 });

  const [rows, total] = await Promise.all([
    Job.find(f).sort(sort).skip((page - 1) * limit).limit(limit).lean(),
    Job.countDocuments(f),
  ]);
  res.json({ jobs: await withPosters(rows, req.user), total, page, pages: Math.ceil(total / limit) });
}));

router.get('/meta', asyncHandler(async (req, res) => {
  const lim = limitsFor(req.user);
  const used = req.user.usage?.month === monthKey() ? req.user.usage.applications : 0;
  const openJobs = await Job.countDocuments({ postedBy: req.user._id, status: 'open' });
  res.json({
    categories: Job.CATEGORIES,
    durations: Job.schema.path('duration').enumValues,
    currencies: Job.schema.path('currency').enumValues,
    limits: {
      applicationsPerMonth: Number.isFinite(lim.applicationsPerMonth) ? lim.applicationsPerMonth : null,
      applicationsUsed: used,
      openJobs: lim.openJobs,
      openJobsUsed: openJobs,
    },
    canPost: Boolean(req.user.emailVerified),
  });
}));

router.get('/mine', asyncHandler(async (req, res) => {
  const rows = await Job.find({ postedBy: req.user._id }).sort({ createdAt: -1 }).limit(200).lean();
  res.json({ jobs: await withPosters(rows, req.user) });
}));

router.get('/saved', asyncHandler(async (req, res) => {
  const rows = await Job.find({ _id: { $in: req.user.savedJobs || [] } }).sort({ createdAt: -1 }).lean();
  res.json({ jobs: await withPosters(rows, req.user) });
}));

router.get('/applications/mine', asyncHandler(async (req, res) => {
  const apps = await JobApplication.find({ applicant: req.user._id }).sort({ createdAt: -1 }).limit(200).populate('job').lean();
  const jobs = await withPosters(apps.map((a) => a.job).filter(Boolean), req.user);
  const jobById = Object.fromEntries(jobs.map((j) => [String(j._id), j]));
  res.json({ applications: apps.map((a) => ({ ...a, job: a.job ? jobById[String(a.job._id)] : null })) });
}));

// ── Post / edit ─────────────────────────────────────────────────────────
router.post('/', asyncHandler(async (req, res) => {
  if (!req.user.emailVerified) throw forbidden('Confirm your email before posting a job (Settings → Account).');
  const lim = limitsFor(req.user);
  const open = await Job.countDocuments({ postedBy: req.user._id, status: 'open' });
  if (open >= lim.openJobs) {
    throw new HttpError(402, req.plan === 'premium'
      ? `You can have ${lim.openJobs} open jobs at once. Close one to post another.`
      : `Free accounts can have ${lim.openJobs} open jobs. Close one, or move to Premium for up to ${PLANS.premium.limits.openJobs}.`);
  }
  const data = cleanJob(req.body);
  if (!data.title || data.title.length < 8) throw badRequest('Give the job a clear title (at least 8 characters)');
  if (!data.description || data.description.length < 50) throw badRequest('Describe the work in at least 50 characters');
  const job = new Job({ ...data, postedBy: req.user._id, posterActiveAt: new Date() });
  const verdict = applySafety(job);
  await job.save();
  if (verdict === 'held' && env.ADMIN_EMAILS.length) {
    email.send({ to: env.ADMIN_EMAILS[0], subject: `Job held for review: ${job.title}`, html: email.layout({ heading: 'Scam shield held a job', intro: `${email.esc(req.user.name)} posted “${email.esc(job.title)}”. Flags: ${job.safety.flags.map((f) => email.esc(f.label)).join(', ')}.`, action: { label: 'Review it', url: `${env.CLIENT_URL}/admin` } }) }).catch(() => {});
  }
  res.status(201).json({
    job: (await withPosters([job.toObject()], req.user))[0],
    message: verdict === 'held'
      ? 'Your post is waiting for a quick review because it mentions things scammers often use (like off-platform contact or upfront fees). Edit those out to publish it straight away.'
      : verdict === 'warn' ? 'Posted. Heads up: applicants will see a caution because the post includes contact details or similar. Edit them out to remove it.' : 'Posted.',
  });
}));

router.get('/:id', asyncHandler(async (req, res) => {
  const job = await loadJob(req.params.id);
  const mine = String(job.postedBy) === String(req.user._id);
  if (!mine && job.status === 'review') throw notFound('Job not found');
  if (!mine) await Job.updateOne({ _id: job._id }, { $inc: { views: 1 } });
  const [shaped] = await withPosters([job.toObject()], req.user);
  const application = mine ? null : await JobApplication.findOne({ job: job._id, applicant: req.user._id }).lean();
  res.json({ job: shaped, application });
}));

router.patch('/:id', asyncHandler(async (req, res) => {
  const job = await loadJob(req.params.id);
  if (String(job.postedBy) !== String(req.user._id)) throw forbidden('Only the poster can edit this job');
  Object.assign(job, cleanJob(req.body));
  const wasHeld = job.status === 'review';
  const verdict = applySafety(job);
  if (wasHeld && verdict !== 'held' && !job.closedReason) job.status = 'open';
  job.posterActiveAt = new Date();
  await job.save();
  res.json({ job: (await withPosters([job.toObject()], req.user))[0] });
}));

router.post('/:id/status', asyncHandler(async (req, res) => {
  const job = await loadJob(req.params.id);
  if (String(job.postedBy) !== String(req.user._id)) throw forbidden('Only the poster can change this job');
  const { status } = req.body;
  if (!['open', 'closed', 'filled'].includes(status)) throw badRequest('Unknown status');
  if (status === 'open' && job.status !== 'open') {
    const open = await Job.countDocuments({ postedBy: req.user._id, status: 'open' });
    if (open >= limitsFor(req.user).openJobs) throw new HttpError(402, 'You’ve reached your limit of open jobs. Close another one first.');
  }
  if (job.status === 'review') throw badRequest('This post is waiting for review. Edit it, or wait for the review to finish.');
  job.status = status;
  job.closedReason = status === 'open' ? '' : status === 'filled' ? 'filled' : 'poster';
  job.posterActiveAt = new Date();
  await job.save();
  let answered = 0;
  if (status !== 'open') answered = await declineWaiting(job, req.user, status === 'filled' ? 'chose_other' : 'not_hiring');
  res.json({ job: (await withPosters([job.toObject()], req.user))[0], answered });
}));

router.delete('/:id', asyncHandler(async (req, res) => {
  const job = await loadJob(req.params.id);
  if (String(job.postedBy) !== String(req.user._id)) throw forbidden('Only the poster can delete this job');
  if (job.hired?.length) throw badRequest('You’ve hired someone for this job, so it can only be closed, not deleted.');
  await Promise.all([Job.deleteOne({ _id: job._id }), JobApplication.deleteMany({ job: job._id }), User.updateMany({ savedJobs: job._id }, { $pull: { savedJobs: job._id } })]);
  res.json({ message: 'Job deleted' });
}));

/** Answer every applicant still waiting with a decline (used when a job closes or by "decline the rest"). */
async function declineWaiting(job, poster, reason) {
  const waiting = await JobApplication.find({ job: job._id, status: { $in: ['submitted', 'shortlisted'] } });
  for (const app of waiting) {
    app.status = 'rejected';
    app.declineReason = reason;
    markResponded(app);
    await app.save();
    notifyApplicant(app, job, poster, 'rejected');
  }
  if (waiting.length) reputation.touch(poster._id);
  return waiting.length;
}

router.post('/:id/decline-rest', asyncHandler(async (req, res) => {
  const job = await loadJob(req.params.id);
  if (String(job.postedBy) !== String(req.user._id)) throw forbidden('Only the poster can do this');
  const reason = Object.keys(DECLINE_REASONS).includes(req.body.reason) ? req.body.reason : 'chose_other';
  const answered = await declineWaiting(job, req.user, reason);
  await Job.updateOne({ _id: job._id }, { $set: { posterActiveAt: new Date() } });
  res.json({ answered, message: answered ? `Let ${answered} applicant${answered > 1 ? 's' : ''} know.` : 'Nobody was waiting.' });
}));

// ── Save ────────────────────────────────────────────────────────────────
router.post('/:id/save', asyncHandler(async (req, res) => {
  const job = await loadJob(req.params.id);
  await User.updateOne({ _id: req.user._id }, { $addToSet: { savedJobs: job._id } });
  res.json({ saved: true });
}));
router.delete('/:id/save', asyncHandler(async (req, res) => {
  if (!isId(req.params.id)) throw notFound('Job not found');
  await User.updateOne({ _id: req.user._id }, { $pull: { savedJobs: req.params.id } });
  res.json({ saved: false });
}));

// ── Apply ───────────────────────────────────────────────────────────────
router.post('/:id/apply', asyncHandler(async (req, res) => {
  const job = await loadJob(req.params.id);
  if (job.status !== 'open') throw badRequest('This job is no longer taking applications');
  if (String(job.postedBy) === String(req.user._id)) throw badRequest('You can’t apply to your own job');
  if (job.applyBy && job.applyBy < new Date()) throw badRequest('The application deadline has passed');
  if (await messaging.isBlocked(req.user._id, job.postedBy)) throw forbidden('You can’t apply to this job');

  const coverLetter = str(req.body.coverLetter, 5000);
  if (coverLetter.length < 50) throw badRequest('Write at least 50 characters about why you’re a good fit');
  const bid = Number(req.body.bid);
  if (!Number.isFinite(bid) || bid <= 0) throw badRequest(`Enter your ${job.budgetType === 'hourly' ? 'hourly rate' : 'price'}`);

  const existing = await JobApplication.findOne({ job: job._id, applicant: req.user._id });
  if (existing && existing.status !== 'withdrawn') throw badRequest('You’ve already applied to this job');

  // Monthly limit (atomic)
  const lim = limitsFor(req.user).applicationsPerMonth;
  const month = monthKey();
  if (Number.isFinite(lim)) {
    await User.updateOne({ _id: req.user._id, 'usage.month': { $ne: month } }, { $set: { 'usage.month': month, 'usage.applications': 0 } });
    const r = await User.updateOne({ _id: req.user._id, 'usage.month': month, 'usage.applications': { $lt: lim } }, { $inc: { 'usage.applications': 1 } });
    if (!r.modifiedCount) throw new HttpError(402, `You’ve used this month’s ${lim} applications. They reset on the 1st, or Premium makes them unlimited.`);
  }

  let squad;
  if (req.body.squad) {
    squad = isId(req.body.squad) && await Squad.findById(req.body.squad);
    if (!squad || String(squad.lead) !== String(req.user._id)) throw forbidden('Only the squad lead can apply for the squad');
    if (squad.activeIds().length < 2) throw badRequest('A squad needs at least two active members to apply together');
  }
  if (job.status === 'review') throw badRequest('This job is no longer taking applications');

  const data = {
    squad: squad?._id,
    coverLetter, bid, timeline: str(req.body.timeline, 120),
    links: (Array.isArray(req.body.links) ? req.body.links : []).map((l) => str(l, 300)).filter((l) => /^https?:\/\//.test(l)).slice(0, 5),
    status: 'submitted', poster: job.postedBy,
  };
  const application = existing
    ? await JobApplication.findByIdAndUpdate(existing._id, data, { new: true })
    : await JobApplication.create({ ...data, job: job._id, applicant: req.user._id });
  await Job.updateOne({ _id: job._id }, { $inc: { applicationsCount: existing ? 0 : 1 } });

  const poster = await User.findById(job.postedBy).select('email name notifications');
  if (poster && poster.notifications?.jobAlerts !== false) {
    email.send({
      to: poster.email,
      subject: `New application: ${job.title}`,
      html: email.layout({
        heading: 'You have a new applicant',
        intro: `${email.esc(req.user.name)}${squad ? ` (with the squad “${email.esc(squad.name)}”)` : ''}${req.user.title ? `, ${email.esc(req.user.title)},` : ''} applied to <strong>${email.esc(job.title)}</strong> at ${email.esc(job.currency)} ${bid}${job.budgetType === 'hourly' ? '/hr' : ''}.`,
        action: { label: 'Review applicants', url: `${env.CLIENT_URL}/jobs/${job._id}` },
      }),
    }).catch(() => {});
  }
  res.status(201).json({ application });
}));

router.delete('/:id/apply', asyncHandler(async (req, res) => {
  if (!isId(req.params.id)) throw notFound('Job not found');
  const r = await JobApplication.updateOne({ job: req.params.id, applicant: req.user._id, status: { $in: ['submitted', 'shortlisted'] } }, { status: 'withdrawn' });
  if (!r.matchedCount) throw notFound('No active application to withdraw');
  res.json({ message: 'Application withdrawn' });
}));

// ── Applicants (poster) ─────────────────────────────────────────────────
router.get('/:id/applications', asyncHandler(async (req, res) => {
  const job = await loadJob(req.params.id);
  if (String(job.postedBy) !== String(req.user._id)) throw forbidden('Only the poster can see applicants');
  const now = new Date();
  await Promise.all([
    JobApplication.updateMany({ job: job._id, viewedAt: null, status: { $ne: 'withdrawn' } }, { $set: { viewedAt: now } }),
    Job.updateOne({ _id: job._id }, { $set: { posterActiveAt: now } }),
  ]);
  const apps = await JobApplication.find({ job: job._id, status: { $ne: 'withdrawn' } }).select('+posterNote').sort({ createdAt: -1 }).lean();
  const users = await User.find({ _id: { $in: apps.map((a) => a.applicant) } }).select(`${PUBLIC_USER_FIELDS} bio`).lean();
  const byId = Object.fromEntries(users.map((u) => [String(u._id), { ...publicUser(u), bio: u.bio || '' }]));
  const squads = await Squad.find({ _id: { $in: apps.map((a) => a.squad).filter(Boolean) } }).lean();
  const memberIds = squads.flatMap((q) => q.members.filter((m) => m.status === 'active').map((m) => m.user));
  const members = await User.find({ _id: { $in: memberIds } }).select(PUBLIC_USER_FIELDS).lean();
  const mById = Object.fromEntries(members.map((u) => [String(u._id), publicUser(u)]));
  const sById = Object.fromEntries(squads.map((q) => [String(q._id), {
    _id: q._id, name: q.name, tagline: q.tagline,
    members: q.members.filter((m) => m.status === 'active').map((m) => ({ role: m.role, user: mById[String(m.user)] || null })).filter((m) => m.user),
  }]));
  const trialsUsed = apps.filter((a) => a.status === 'trial' || (job.kind === 'trial' && a.status === 'hired')).length;
  res.json({
    applications: apps.map((a) => ({ ...a, applicant: byId[String(a.applicant)] || null, squad: a.squad ? sById[String(a.squad)] || null : null })).filter((a) => a.applicant),
    trial: job.kind === 'trial' ? { slots: job.trialSlots, used: trialsUsed } : null,
    declineReasons: Object.keys(DECLINE_REASONS),
  });
}));

router.patch('/applications/:appId', asyncHandler(async (req, res) => {
  if (!isId(req.params.appId)) throw notFound('Application not found');
  const app = await JobApplication.findOne({ _id: req.params.appId, poster: req.user._id }).select('+posterNote');
  if (!app) throw notFound('Application not found');
  const job = await Job.findById(app.job);
  if (!job) throw notFound('Job not found');

  if (req.body.note !== undefined) app.posterNote = str(req.body.note, 1000);
  const { status } = req.body;
  let contract = null;
  if (status) {
    if (!['submitted', 'shortlisted', 'rejected', 'hired'].includes(status)) throw badRequest('Unknown status');
    if (['withdrawn', 'closed'].includes(app.status)) throw badRequest('This application is no longer active');
    if (app.status === 'hired' && status !== 'hired') throw badRequest('You’ve already hired this person — manage it under Contracts');
    if (status === 'hired' && job.kind === 'trial') throw badRequest('This is a paid-trial post. Use “Start paid trial” instead.');
    if (status === 'rejected') app.declineReason = Object.keys(DECLINE_REASONS).includes(req.body.declineReason) ? req.body.declineReason : 'other';
    if (status !== 'submitted') markResponded(app);
    const was = app.status;
    app.status = status;

    if (status === 'hired' && was !== 'hired') {
      const applicant = await User.findById(app.applicant);
      if (!applicant) throw notFound('This person deleted their account');
      const hourly = job.budgetType === 'hourly';
      contract = await contracts.createDraft({
        client: req.user, freelancer: applicant, squad: app.squad, job, application: app,
        title: job.title, summary: job.description.slice(0, 1500), currency: job.currency,
        milestones: [hourly
          ? { title: 'First 10 hours', scope: `Up to 10 hours at ${job.currency} ${app.bid}/hr. Add or split milestones before signing.`, amount: app.bid * 10 }
          : { title: job.title.slice(0, 120), scope: 'Describe exactly what “done” means for this milestone before you both sign.', amount: app.bid }],
      });
      app.engagement = contract._id;
      app.conversation = contract.conversation;
      await Job.updateOne({ _id: job._id }, { $addToSet: { hired: applicant._id } });
    }
  }
  await app.save();
  await Job.updateOne({ _id: job._id }, { $set: { posterActiveAt: new Date() } });
  if (status && ['shortlisted', 'rejected'].includes(status)) notifyApplicant(app, job, req.user, status);
  reputation.touch(req.user._id);
  res.json({ application: app, contract: contract ? { _id: contract._id } : null });
}));

// Paid trial: a small, paid test task as its own contract (one milestone).
router.post('/applications/:appId/trial', asyncHandler(async (req, res) => {
  if (!isId(req.params.appId)) throw notFound('Application not found');
  const app = await JobApplication.findOne({ _id: req.params.appId, poster: req.user._id });
  if (!app) throw notFound('Application not found');
  if (!['submitted', 'shortlisted'].includes(app.status)) throw badRequest('You can start a trial with an applicant who is still under consideration');
  const job = await Job.findById(app.job);
  if (!job) throw notFound('Job not found');
  if (job.kind === 'trial') {
    const used = await JobApplication.countDocuments({ job: job._id, status: 'trial' });
    if (used >= job.trialSlots) throw badRequest(`You set ${job.trialSlots} trial slot${job.trialSlots > 1 ? 's' : ''} for this post and they’re all used`);
  }
  const amount = Number(req.body.amount ?? (job.kind === 'trial' ? job.budgetMax || job.budgetMin : 0));
  if (!Number.isFinite(amount) || amount <= 0) throw badRequest('A trial has to be paid. Set the amount.');
  const days = Math.min(14, Math.max(1, parseInt(req.body.days, 10) || 3));
  const title = str(req.body.title, 120) || `Paid trial: ${job.title}`.slice(0, 120);
  const scope = str(req.body.scope, 3000);
  if (scope.length < 20) throw badRequest('Describe the trial task in a sentence or two, including what you’ll judge');
  const applicant = await User.findById(app.applicant);
  if (!applicant) throw notFound('This person deleted their account');
  const contract = await contracts.createDraft({
    client: req.user, freelancer: applicant, squad: app.squad, job, application: app, kind: 'trial',
    title, summary: `Paid trial for “${job.title}”. If it goes well, the client can hire for the full job.`, currency: job.currency,
    milestones: [{ title, scope, amount, dueDate: new Date(Date.now() + days * 86400e3) }],
  });
  app.status = 'trial';
  markResponded(app);
  app.engagement = contract._id;
  app.conversation = contract.conversation;
  await app.save();
  await Job.updateOne({ _id: job._id }, { $set: { posterActiveAt: new Date() } });
  reputation.touch(req.user._id);
  res.status(201).json({ application: app, contract: { _id: contract._id } });
}));

module.exports = router;
