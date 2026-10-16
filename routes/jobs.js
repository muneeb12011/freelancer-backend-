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
//   PATCH  /api/jobs/applications/:appId   { status, note } (owner) — hire creates CRM client + thread
const router = require('express').Router();
const Job = require('../models/Job');
const JobApplication = require('../models/JobApplication');
const User = require('../models/User');
const Client = require('../models/Client');
const env = require('../config/env');
const email = require('../services/email');
const messaging = require('../services/messaging');
const { PLANS } = require('../config/plans');
const { protect } = require('../middleware/auth');
const { asyncHandler, badRequest, notFound, forbidden, HttpError } = require('../utils/http');
const { isId, str, clampInt, searchRegex, pick } = require('../utils/sanitize');
const { PUBLIC_USER_FIELDS, publicUser } = require('../utils/publicUser');

router.use(protect);

const EDITABLE = ['title', 'description', 'category', 'skills', 'budgetType', 'budgetMin', 'budgetMax', 'currency', 'duration', 'experience', 'locationType', 'location', 'applyBy'];
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
  return j;
}

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
  const job = await Job.create({ ...data, postedBy: req.user._id });
  res.status(201).json({ job: (await withPosters([job.toObject()], req.user))[0] });
}));

router.get('/:id', asyncHandler(async (req, res) => {
  const job = await loadJob(req.params.id);
  const mine = String(job.postedBy) === String(req.user._id);
  if (!mine) await Job.updateOne({ _id: job._id }, { $inc: { views: 1 } });
  const [shaped] = await withPosters([job.toObject()], req.user);
  const application = mine ? null : await JobApplication.findOne({ job: job._id, applicant: req.user._id }).lean();
  res.json({ job: shaped, application });
}));

router.patch('/:id', asyncHandler(async (req, res) => {
  const job = await loadJob(req.params.id);
  if (String(job.postedBy) !== String(req.user._id)) throw forbidden('Only the poster can edit this job');
  Object.assign(job, cleanJob(req.body));
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
  job.status = status;
  await job.save();
  res.json({ job: (await withPosters([job.toObject()], req.user))[0] });
}));

router.delete('/:id', asyncHandler(async (req, res) => {
  const job = await loadJob(req.params.id);
  if (String(job.postedBy) !== String(req.user._id)) throw forbidden('Only the poster can delete this job');
  if (job.hired?.length) throw badRequest('You’ve hired someone for this job, so it can only be closed, not deleted.');
  await Promise.all([Job.deleteOne({ _id: job._id }), JobApplication.deleteMany({ job: job._id }), User.updateMany({ savedJobs: job._id }, { $pull: { savedJobs: job._id } })]);
  res.json({ message: 'Job deleted' });
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

  const data = {
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
        intro: `${email.esc(req.user.name)}${req.user.title ? `, ${email.esc(req.user.title)},` : ''} applied to <strong>${email.esc(job.title)}</strong> at ${email.esc(job.currency)} ${bid}${job.budgetType === 'hourly' ? '/hr' : ''}.`,
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
  const apps = await JobApplication.find({ job: job._id, status: { $ne: 'withdrawn' } }).select('+posterNote').sort({ createdAt: -1 }).lean();
  const users = await User.find({ _id: { $in: apps.map((a) => a.applicant) } }).select(`${PUBLIC_USER_FIELDS} bio`).lean();
  const byId = Object.fromEntries(users.map((u) => [String(u._id), { ...publicUser(u), bio: u.bio || '' }]));
  res.json({ applications: apps.map((a) => ({ ...a, applicant: byId[String(a.applicant)] || null })).filter((a) => a.applicant) });
}));

router.patch('/applications/:appId', asyncHandler(async (req, res) => {
  if (!isId(req.params.appId)) throw notFound('Application not found');
  const app = await JobApplication.findOne({ _id: req.params.appId, poster: req.user._id }).select('+posterNote');
  if (!app) throw notFound('Application not found');
  const job = await Job.findById(app.job);
  if (!job) throw notFound('Job not found');

  if (req.body.note !== undefined) app.posterNote = str(req.body.note, 1000);
  const { status } = req.body;
  if (status) {
    if (!['submitted', 'shortlisted', 'rejected', 'hired'].includes(status)) throw badRequest('Unknown status');
    if (app.status === 'withdrawn') throw badRequest('The applicant withdrew this application');
    app.status = status;
  }

  const applicant = await User.findById(app.applicant);
  if (status === 'hired' && applicant) {
    // Thread between the two, with a system note.
    const convo = await messaging.findOrCreate(req.user._id, applicant._id, { job: job._id });
    app.conversation = convo._id;
    await messaging.post(convo, { kind: 'system', text: `${req.user.name} hired ${applicant.name} for “${job.title}”.` });
    // The poster becomes a client in the freelancer's CRM.
    await Client.findOneAndUpdate(
      { user: applicant._id, email: req.user.email },
      {
        $setOnInsert: {
          user: applicant._id, name: req.user.name, email: req.user.email, company: req.user.title || '',
          status: 'Active', source: 'Aurelance Jobs', projectBudget: app.bid,
          hourlyRate: job.budgetType === 'hourly' ? app.bid : 0, tags: ['Jobs board'],
          notes: `Hired for “${job.title}” on ${new Date().toDateString()}.`,
        },
        $set: { lastActivity: new Date() },
      },
      { upsert: true, new: true },
    );
    await Job.updateOne({ _id: job._id }, { $addToSet: { hired: applicant._id } });
  }
  await app.save();

  if (status && applicant && applicant.notifications?.jobAlerts !== false && ['shortlisted', 'rejected', 'hired'].includes(status)) {
    const copy = {
      shortlisted: ['You’re on the shortlist', `${email.esc(req.user.name)} shortlisted your application for <strong>${email.esc(job.title)}</strong>.`],
      rejected: ['Application update', `${email.esc(req.user.name)} went with someone else for <strong>${email.esc(job.title)}</strong>. Thanks for applying — there are new jobs every day.`],
      hired: ['You’re hired', `${email.esc(req.user.name)} hired you for <strong>${email.esc(job.title)}</strong>. They’re now in your Clients list and a conversation is open.`],
    }[status];
    email.send({ to: applicant.email, subject: `${copy[0]}: ${job.title}`, html: email.layout({ heading: copy[0], intro: copy[1], action: { label: status === 'hired' ? 'Open the conversation' : 'View your applications', url: status === 'hired' ? `${env.CLIENT_URL}/messages/${app.conversation}` : `${env.CLIENT_URL}/jobs?tab=applications` } }) }).catch(() => {});
  }
  res.json({ application: app });
}));

module.exports = router;
