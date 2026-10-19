// services/profiles.js — everything a profile is built from, shared by the in-app and public views.
const crypto = require('crypto');
const User = require('../models/User');
const Engagement = require('../models/Engagement');
const Review = require('../models/Review');
const Squad = require('../models/Squad');
const ProfileView = require('../models/ProfileView');
const PortfolioImage = require('../models/PortfolioImage');
const { PUBLIC_USER_FIELDS, publicUser } = require('../utils/publicUser');

const RESERVED = new Set(['admin', 'api', 'app', 'support', 'help', 'settings', 'new', 'edit', 'me', 'u', 'jobs', 'talent', 'contracts', 'messages', 'login', 'register', 'billing', 'aurelance', 'about', 'terms', 'privacy']);
const HANDLE_RE = /^[a-z0-9](?:[a-z0-9-]{1,28}[a-z0-9])$/;

const slugify = (s) => String(s || '').toLowerCase().normalize('NFKD').replace(/[^a-z0-9\s-]/g, '').trim().replace(/[\s-]+/g, '-').replace(/^-|-$/g, '').slice(0, 24);

function validHandle(h) {
  return HANDLE_RE.test(h) && !RESERVED.has(h) && !h.includes('--');
}

/** Give a user a handle if they don't have one: "usman-tariq", then "usman-tariq-7f3a" on collision. */
async function ensureHandle(user) {
  if (user.handle) return user.handle;
  let base = slugify(user.name);
  if (base.length < 3 || RESERVED.has(base)) base = `member-${String(user._id).slice(-6)}`;
  let candidate = base;
  for (let i = 0; i < 5; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    if (validHandle(candidate) && !(await User.exists({ handle: candidate }))) break;
    candidate = `${base.slice(0, 24)}-${crypto.randomBytes(2).toString('hex')}`;
  }
  await User.updateOne({ _id: user._id }, { $set: { handle: candidate } });
  user.handle = candidate;
  return candidate;
}

/** Reviews someone received, newest first — only revealed ones (double-blind). */
async function reviewsFor(userId) {
  const rows = await Review.find({ to: userId, visibleAt: { $ne: null } }).sort({ visibleAt: -1 }).limit(50).lean();
  const [users, contracts] = await Promise.all([
    User.find({ _id: { $in: rows.map((r) => r.from) } }).select(`${PUBLIC_USER_FIELDS} handle`).lean(),
    Engagement.find({ _id: { $in: rows.map((r) => r.engagement) } }).select('title kind').lean(),
  ]);
  const u = Object.fromEntries(users.map((x) => [String(x._id), { ...publicUser(x), handle: x.handle }]));
  const c = Object.fromEntries(contracts.map((x) => [String(x._id), x]));
  return rows.map((r) => ({
    _id: r._id, direction: r.direction, ratings: r.ratings, wouldWorkAgain: r.wouldWorkAgain, comment: r.comment, at: r.visibleAt,
    from: u[String(r.from)] || null, contract: c[String(r.engagement)] ? { _id: r.engagement, title: c[String(r.engagement)].title, kind: c[String(r.engagement)].kind } : null,
  }));
}

/**
 * Work history: contracts finished on Aurelance. It can't be typed in by hand — it only exists
 * because a client signed, approved and paid. Amounts stay private; the client's revealed review is attached.
 */
async function workHistory(userId) {
  const rows = await Engagement.find({ freelancer: userId, status: { $in: ['completed', 'ended'] } })
    .select('title kind client squad status signedAt completedAt endedAt milestones.status milestones.delivery.at')
    .sort({ completedAt: -1, endedAt: -1 }).limit(30).lean();
  const delivered = rows.filter((r) => r.milestones.some((m) => m.delivery?.at));
  const [clients, reviews, squads] = await Promise.all([
    User.find({ _id: { $in: delivered.map((r) => r.client) } }).select(`${PUBLIC_USER_FIELDS} handle`).lean(),
    Review.find({ engagement: { $in: delivered.map((r) => r._id) }, direction: 'of_freelancer', visibleAt: { $ne: null } }).lean(),
    Squad.find({ _id: { $in: delivered.map((r) => r.squad).filter(Boolean) } }).select('name').lean(),
  ]);
  const cById = Object.fromEntries(clients.map((x) => [String(x._id), x]));
  const rById = Object.fromEntries(reviews.map((x) => [String(x.engagement), x]));
  const sById = Object.fromEntries(squads.map((x) => [String(x._id), x.name]));
  const short = (name) => { const [f, ...rest] = String(name || 'Client').split(' '); return rest.length ? `${f} ${rest[rest.length - 1][0]}.` : f; };
  return delivered.map((r) => {
    const cl = cById[String(r.client)];
    const rv = rById[String(r._id)];
    return {
      _id: r._id, title: r.title, kind: r.kind, status: r.status,
      from: r.signedAt, to: r.completedAt || r.endedAt,
      milestones: r.milestones.length, paid: r.milestones.filter((m) => m.status === 'received').length,
      squad: r.squad ? sById[String(r.squad)] || null : null,
      client: cl ? { name: short(cl.name), handle: cl.handle || '', badges: publicUser(cl).badges } : { name: 'Former client' },
      review: rv ? { ratings: rv.ratings, comment: rv.comment, wouldWorkAgain: rv.wouldWorkAgain } : null,
    };
  });
}

/** Profile strength: what's done and the next most useful thing to add. */
function strength(u) {
  const projects = Array.isArray(u.projects) ? u.projects : [];
  const checks = [
    ['photo', 'Add a photo', Boolean(u.avatar), 10],
    ['title', 'Say what you do in one line', Boolean(u.title), 10],
    ['bio', 'Write at least 3 sentences about your work', (u.bio || '').length >= 160, 10],
    ['skills', 'List at least 3 skills', (u.skills || []).length >= 3, 10],
    ['portfolio', 'Add a portfolio project with an image', projects.some((p) => (p.images || []).length), 15],
    ['rate', 'Set your hourly rate', u.hourlyRate > 0, 5],
    ['languages', 'Add languages with your level', (u.langs || []).length > 0, 5],
    ['hours', 'Say how many hours a week you’re available', u.hoursPerWeek > 0, 5],
    ['identity', 'Verify your ID', u.identity?.status === 'approved', 15],
    ['payout', 'Verify a payout method', (u.payoutTypes || []).length > 0, 15],
  ];
  const score = checks.reduce((s, [, , done, w]) => s + (done ? w : 0), 0);
  return { score, next: checks.filter(([, , done]) => !done).map(([id, label]) => ({ id, label })) };
}

async function recordView(profileId, viewerKey, source) {
  if (!viewerKey || String(viewerKey) === String(profileId)) return;
  const day = new Date().toISOString().slice(0, 10);
  try { await ProfileView.create({ profile: profileId, viewer: String(viewerKey), day, source }); } catch { /* already counted today */ }
}

async function viewStats(profileId) {
  const since = (n) => new Date(Date.now() - n * 86400e3).toISOString().slice(0, 10);
  const [week, month, publicMonth] = await Promise.all([
    ProfileView.countDocuments({ profile: profileId, day: { $gte: since(7) } }),
    ProfileView.countDocuments({ profile: profileId, day: { $gte: since(30) } }),
    ProfileView.countDocuments({ profile: profileId, day: { $gte: since(30) }, source: 'public' }),
  ]);
  return { week, month, publicMonth };
}

async function activeSquads(userId) {
  const rows = await Squad.find({ 'members.user': userId }).select('name tagline members').lean();
  return rows.filter((s) => s.members.some((m) => String(m.user) === String(userId) && m.status === 'active'))
    .map((s) => ({ _id: s._id, name: s.name, tagline: s.tagline, members: s.members.filter((m) => m.status === 'active').length }));
}

const imageUrl = (id) => `/api/public/img/${id}`;

async function cleanupImages(user) {
  const keep = new Set((user.projects || []).flatMap((p) => (p.images || []).map(String)));
  // Only images older than an hour: a fresh upload may not be attached to a project yet.
  const all = await PortfolioImage.find({ owner: user._id, createdAt: { $lt: new Date(Date.now() - 3600e3) } }).select('_id').lean();
  const orphan = all.filter((i) => !keep.has(String(i._id))).map((i) => i._id);
  if (orphan.length) await PortfolioImage.deleteMany({ _id: { $in: orphan } });
}

module.exports = { ensureHandle, validHandle, slugify, reviewsFor, workHistory, strength, recordView, viewStats, activeSquads, imageUrl, cleanupImages, RESERVED };
