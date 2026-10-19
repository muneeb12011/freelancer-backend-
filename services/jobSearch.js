// services/jobSearch.js — one place that turns search options into a Mongo query.
// Used by the jobs board, saved searches and the daily alert email, so they always agree.
//
// Keyword search uses the weighted text index (title > skills > description) and sorts by
// relevance. If the database can't run $text — the index hasn't been built yet after a deploy
// (autoIndex is off in production), or a Mongo-compatible engine without text search — it falls
// back to plain matching and re-checks every 10 minutes, so search never breaks.
const Job = require('../models/Job');
const { searchRegex } = require('../utils/sanitize');
const logger = require('../utils/logger');

const esc = (s) => String(s).trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const RECHECK_MS = 10 * 60e3;
let textOk = null; let checkedAt = 0;

async function textAvailable() {
  if (process.env.JOB_SEARCH_MODE === 'regex') return false;
  if (textOk !== null && Date.now() - checkedAt < RECHECK_MS) return textOk;
  checkedAt = Date.now();
  try {
    await Job.find({ $text: { $search: 'probe' } }).select('_id').limit(1).lean();
    if (textOk === false) logger.info('job search: text index available, using ranked search');
    textOk = true;
  } catch (err) {
    if (textOk !== false) logger.warn(`job search: falling back to plain matching (${err.message}). Run npm run sync-indexes.`);
    textOk = false;
  }
  return textOk;
}

/** Skills from a comma string or array → lowercase, unique, at most 10. */
const skillList = (v) => [...new Set((Array.isArray(v) ? v : String(v || '').split(',')).map((s) => String(s).trim().toLowerCase()).filter(Boolean))].slice(0, 10);

/**
 * Build the filter. Returns { filter, ranked }: ranked is true when the filter uses $text,
 * so the caller can sort by relevance.
 */
async function build(o, me) {
  const f = { status: 'open' };
  let ranked = false;
  const q = String(o.q || '').trim().slice(0, 120);
  if (q) {
    if (await textAvailable()) { f.$text = { $search: q }; ranked = true; } else {
      const re = searchRegex(q);
      f.$or = [{ title: re }, { skillsKey: q.toLowerCase() }, { description: re }];
    }
  }
  if (o.category && Job.CATEGORIES.includes(o.category)) f.category = o.category;
  const sk = skillList(o.skills);
  if (sk.length) f.skillsKey = { $in: sk };
  if (['fixed', 'hourly'].includes(o.budgetType)) f.budgetType = o.budgetType;
  if (['remote', 'onsite', 'hybrid'].includes(o.locationType)) f.locationType = o.locationType;
  if (['Entry', 'Intermediate', 'Expert'].includes(o.experience)) f.experience = o.experience;
  const min = Number(o.min || o.minBudget) || 0;
  if (min > 0) f.budgetMax = { $gte: min };
  if (o.max) f.budgetMin = { $lte: Number(o.max) || 0 };
  if (me && (o.hideMine === 'true' || o.hideMine === true)) f.postedBy = { $ne: me };
  if (['standard', 'trial'].includes(o.kind)) f.kind = o.kind === 'standard' ? { $ne: 'trial' } : 'trial';
  if (o.safeOnly === 'true' || o.safeOnly === true) f['safety.verdict'] = { $ne: 'warn' };
  if (o.reliable === 'true' || o.reliable === true) f['posterSignals.reliable'] = true;
  return { filter: f, ranked };
}

/** Back-compat: just the filter (saved-search previews, alert counts). */
async function buildFilter(o, me) { return (await build(o, me)).filter; }

const SORTS = {
  newest: { createdAt: -1 },
  budget: { budgetMax: -1, createdAt: -1 },
  fewest: { applicationsCount: 1, createdAt: -1 },
};

/** Run a search page. Relevance is the default order when there's a keyword. */
async function search(o, me, { page = 1, limit = 20 } = {}) {
  const { filter, ranked } = await build(o, me);
  const byRelevance = ranked && (!o.sort || o.sort === 'relevance');
  const sort = byRelevance ? { score: { $meta: 'textScore' }, createdAt: -1 } : SORTS[o.sort] || SORTS.newest;
  const find = Job.find(filter, byRelevance ? { score: { $meta: 'textScore' } } : undefined).sort(sort).skip((page - 1) * limit).limit(limit).lean();
  try {
    const [rows, total] = await Promise.all([find, Job.countDocuments(filter)]);
    return { rows, total, ranked: byRelevance };
  } catch (err) {
    if (!ranked) throw err;
    // The text index vanished between the probe and the query: retry once without it.
    textOk = false; checkedAt = Date.now();
    return search(o, me, { page, limit });
  }
}

/** Jobs that fit a person: open, not theirs, not applied to, sharing skills — best overlap first. */
async function forYou(user, JobApplication, limit = 6) {
  const skills = skillList(user.skills || []);
  if (!skills.length) return [];
  const applied = await JobApplication.find({ applicant: user._id }).distinct('job');
  const rows = await Job.find({
    status: 'open', postedBy: { $ne: user._id }, _id: { $nin: applied },
    skillsKey: { $in: skills },
    createdAt: { $gte: new Date(Date.now() - 30 * 86400e3) },
  }).sort({ createdAt: -1 }).limit(60).lean();
  const mine = new Set(skills);
  return rows
    .map((j) => ({ j, overlap: (j.skillsKey?.length ? j.skillsKey : (j.skills || []).map((s) => s.toLowerCase())).filter((s) => mine.has(s)).length }))
    .sort((a, b) => b.overlap - a.overlap || new Date(b.j.createdAt) - new Date(a.j.createdAt))
    .slice(0, limit)
    .map(({ j, overlap }) => ({ ...j, matchedSkills: overlap }));
}

/** Keep poster trust signals on their open jobs current (called after a reputation refresh). */
async function syncPosterSignals(user) {
  if (!user?._id) return;
  const sig = Job.signalsFor(user);
  // Only touch jobs whose signals actually changed — most refreshes change nothing.
  await Job.updateMany({
    postedBy: user._id, status: { $in: ['open', 'review'] },
    $or: [{ 'posterSignals.reliable': { $ne: sig.reliable } }, { 'posterSignals.verified': { $ne: sig.verified } }, { 'posterSignals.responseRate': { $ne: sig.responseRate } }],
  }, { $set: { posterSignals: sig } });
}

module.exports = { build, buildFilter, search, forYou, syncPosterSignals, textAvailable, skillList, _reset: () => { textOk = null; checkedAt = 0; } };
