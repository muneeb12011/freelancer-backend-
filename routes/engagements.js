// routes/engagements.js — contracts between a client and a freelancer (the app calls them Contracts).
//   GET    /api/engagements                         mine (?role=client|freelancer&status=)
//   POST   /api/engagements                         direct offer { freelancer, title, summary, currency, kind, milestones[] }
//   GET    /api/engagements/:id
//   PATCH  /api/engagements/:id                     draft only — edits clear both signatures
//   POST   /api/engagements/:id/sign                { name } typed full name
//   POST   /api/engagements/:id/decline             freelancer turns down a draft
//   POST   /api/engagements/:id/files               { name, type, data } → attachment id (deliveries, payment proof)
//   POST   /api/engagements/:id/milestones/:mid/submit        { note, files[] }   freelancer
//   POST   /api/engagements/:id/milestones/:mid/revise        { note }            client
//   POST   /api/engagements/:id/milestones/:mid/approve                           client
//   POST   /api/engagements/:id/milestones/:mid/paid          { method, reference, proof? }  client
//   POST   /api/engagements/:id/milestones/:mid/received                          freelancer
//   POST   /api/engagements/:id/milestones/:mid/not-received  { note }            freelancer
//   POST   /api/engagements/:id/changes             { title, description, amount, dueDate }  either side
//   POST   /api/engagements/:id/changes/:cid/accept · /decline · /withdraw
//   POST   /api/engagements/:id/share-payout        { method }   freelancer · DELETE to stop sharing
//   GET    /api/engagements/:id/payout              full details of the shared method (the two parties only)
//   POST   /api/engagements/:id/end                 { reason }
//   POST   /api/engagements/:id/review              { ratings, wouldWorkAgain, comment }
const router = require('express').Router();
const Engagement = require('../models/Engagement');
const Attachment = require('../models/Attachment');
const PayoutMethod = require('../models/PayoutMethod');
const Review = require('../models/Review');
const Squad = require('../models/Squad');
const User = require('../models/User');
const Job = require('../models/Job');
const JobApplication = require('../models/JobApplication');
const messaging = require('../services/messaging');
const contracts = require('../services/contracts');
const reputation = require('../services/reputation');
const payouts = require('../services/payouts');
const { protect } = require('../middleware/auth');
const { asyncHandler, badRequest, notFound, forbidden } = require('../utils/http');
const { isId, str } = require('../utils/sanitize');
const { PUBLIC_USER_FIELDS, publicUser } = require('../utils/publicUser');

router.use(protect);

const DAY = 86400e3;
const REVIEW_WINDOW_DAYS = 14;
const MAX_FILE = 2 * 1024 * 1024;
const FILE_TYPES = /^(image\/(png|jpe?g|webp|gif)|application\/pdf|text\/plain|application\/(zip|msword|vnd\.openxmlformats-officedocument\.(wordprocessingml\.document|spreadsheetml\.sheet|presentationml\.presentation)|vnd\.ms-excel))$/;
const PAY_METHODS = ['bank', 'payoneer', 'wise', 'card', 'other'];

// ── helpers ─────────────────────────────────────────────────────────────
function cleanMilestones(list) {
  if (!Array.isArray(list) || !list.length) throw badRequest('Add at least one milestone');
  if (list.length > 20) throw badRequest('Keep it to 20 milestones or fewer');
  return list.map((m, i) => {
    const title = str(m.title, 120);
    const amount = Number(m.amount);
    if (!title) throw badRequest(`Milestone ${i + 1} needs a title`);
    if (!Number.isFinite(amount) || amount <= 0) throw badRequest(`Milestone ${i + 1} needs an amount above zero`);
    const due = m.dueDate ? new Date(m.dueDate) : undefined;
    if (due && Number.isNaN(due.getTime())) throw badRequest(`Milestone ${i + 1} has an invalid due date`);
    return { title, scope: str(m.scope, 3000), amount: Math.round(amount * 100) / 100, dueDate: due };
  });
}

async function load(req, { write = false } = {}) {
  if (!isId(req.params.id)) throw notFound('Contract not found');
  const c = await Engagement.findById(req.params.id);
  if (!c) throw notFound('Contract not found');
  const role = c.roleOf(req.user._id);
  if (!role) {
    // Squad members can read the contracts their squad works on.
    const sq = !write && c.squad && await Squad.findById(c.squad).select('members').lean();
    const member = sq && sq.members.some((m) => String(m.user) === String(req.user._id) && m.status === 'active');
    if (!member) throw notFound('Contract not found');
    req.role = 'member';
  } else req.role = role;
  return c;
}

function need(req, role) {
  if (req.role !== role) throw forbidden(role === 'client' ? 'Only the client can do this' : 'Only the freelancer can do this');
}

function milestoneOf(c, mid) {
  const m = isId(mid) && c.milestones.id(mid);
  if (!m) throw notFound('Milestone not found');
  return m;
}

const otherParty = (c, role) => (role === 'client' ? c.freelancer : c.client);

async function shape(c, me) {
  const doc = c.toObject ? c.toObject({ virtuals: true }) : c;
  const ids = [doc.client, doc.freelancer];
  let squad = null;
  if (doc.squad) {
    squad = await Squad.findById(doc.squad).lean();
    if (squad) ids.push(...squad.members.filter((m) => m.status === 'active').map((m) => m.user));
  }
  const users = await User.find({ _id: { $in: ids } }).select(PUBLIC_USER_FIELDS).lean();
  const byId = Object.fromEntries(users.map((u) => [String(u._id), publicUser(u)]));
  const role = String(doc.client) === String(me._id) ? 'client' : String(doc.freelancer) === String(me._id) ? 'freelancer' : 'member';

  const reviews = await Review.find({ engagement: doc._id }).lean();
  const mine = reviews.find((r) => String(r.from) === String(me._id));
  const theirs = reviews.find((r) => String(r.from) !== String(me._id));

  let sharedPayout = null;
  if (doc.sharedPayout?.method) {
    const pm = await PayoutMethod.findById(doc.sharedPayout.method).lean();
    if (pm) sharedPayout = { ...payouts.shape(pm), sharedAt: doc.sharedPayout.at, viewedAt: doc.sharedPayout.viewedAt };
  }

  const total = (doc.milestones || []).reduce((s, m) => s + m.amount, 0);
  const sum = (st) => (doc.milestones || []).filter((m) => st.includes(m.status)).reduce((s, m) => s + m.amount, 0);
  return {
    ...doc,
    id: doc._id,
    myRole: role,
    clientUser: byId[String(doc.client)] || null,
    freelancerUser: byId[String(doc.freelancer)] || null,
    squad: squad ? { _id: squad._id, name: squad.name, members: squad.members.filter((m) => m.status === 'active').map((m) => ({ role: m.role, user: byId[String(m.user)] || null })) } : null,
    totals: { total, approved: sum(['approved', 'paid', 'received']), paid: sum(['paid', 'received']), received: sum(['received']) },
    review: {
      open: ['completed', 'ended'].includes(doc.status) && role !== 'member' && (!doc.reviewWindowEndsAt || new Date(doc.reviewWindowEndsAt) > new Date()),
      windowEndsAt: doc.reviewWindowEndsAt,
      mine: mine || null,
      theirs: theirs && theirs.visibleAt ? theirs : null,
      theirsSubmitted: Boolean(theirs),
    },
    sharedPayout,
    events: (doc.events || []).slice(-60).reverse(),
  };
}

async function finishIfDone(c, by) {
  if (c.status !== 'active') return false;
  if (c.milestones.length && c.milestones.every((m) => m.status === 'received')) {
    c.status = 'completed';
    c.completedAt = new Date();
    c.reviewWindowEndsAt = new Date(Date.now() + REVIEW_WINDOW_DAYS * DAY);
    c.log(by, 'All milestones paid and confirmed — contract complete');
    if (c.job) await Job.updateOne({ _id: c.job, kind: 'standard', status: 'open' }, { $set: { status: 'filled', closedReason: 'filled' } });
    return true;
  }
  return false;
}

async function save(c, req, announceText) {
  await c.save();
  if (announceText) await contracts.announce(c, announceText);
  reputation.touch(c.client, c.freelancer);
  return shape(c, req.user);
}

// ── list / create ──────────────────────────────────────────────────────
router.get('/', asyncHandler(async (req, res) => {
  const squads = (await Squad.find({ 'members.user': req.user._id }).select('members').lean())
    .filter((s) => s.members.some((m) => String(m.user) === String(req.user._id) && m.status === 'active'));
  const or = [{ client: req.user._id }, { freelancer: req.user._id }];
  if (squads.length) or.push({ squad: { $in: squads.map((s) => s._id) } });
  const f = { $or: or };
  if (req.query.role === 'client') { delete f.$or; f.client = req.user._id; }
  if (req.query.role === 'freelancer') { delete f.$or; f.freelancer = req.user._id; }
  if (['draft', 'active', 'completed', 'ended'].includes(req.query.status)) f.status = req.query.status;
  const rows = await Engagement.find(f).sort({ updatedAt: -1 }).limit(200).select('-events').lean({ virtuals: true });
  const ids = [...new Set(rows.flatMap((r) => [String(r.client), String(r.freelancer)]))];
  const users = await User.find({ _id: { $in: ids } }).select(PUBLIC_USER_FIELDS).lean();
  const byId = Object.fromEntries(users.map((u) => [String(u._id), publicUser(u)]));
  res.json({
    contracts: rows.map((r) => {
      const total = r.milestones.reduce((s, m) => s + m.amount, 0);
      const next = r.milestones.find((m) => m.status !== 'received');
      return {
        _id: r._id, title: r.title, kind: r.kind, status: r.status, currency: r.currency, updatedAt: r.updatedAt, createdAt: r.createdAt,
        myRole: String(r.client) === String(req.user._id) ? 'client' : String(r.freelancer) === String(req.user._id) ? 'freelancer' : 'member',
        client: byId[String(r.client)] || null, freelancer: byId[String(r.freelancer)] || null,
        total, received: r.milestones.filter((m) => m.status === 'received').reduce((s, m) => s + m.amount, 0),
        milestones: r.milestones.length, done: r.milestones.filter((m) => m.status === 'received').length,
        next: next ? { title: next.title, status: next.status, dueDate: next.dueDate, amount: next.amount } : null,
        needsSignature: r.status === 'draft' && !(String(r.client) === String(req.user._id) ? r.signatures?.client?.at : r.signatures?.freelancer?.at),
        pendingChanges: (r.changeRequests || []).filter((x) => x.status === 'pending' && String(x.by) !== String(req.user._id)).length,
      };
    }),
  });
}));

router.post('/', asyncHandler(async (req, res) => {
  const { freelancer: fid } = req.body;
  if (!isId(fid) || String(fid) === String(req.user._id)) throw badRequest('Choose who you’re hiring');
  const freelancer = await User.findById(fid);
  if (!freelancer) throw notFound('That person doesn’t exist any more');
  if (await messaging.isBlocked(req.user._id, freelancer._id)) throw forbidden('You can’t send this person a contract');
  if (!req.user.emailVerified) throw forbidden('Confirm your email before sending a contract (Settings → Account).');
  const title = str(req.body.title, 140);
  if (title.length < 4) throw badRequest('Give the contract a short title');
  const contract = await contracts.createDraft({
    client: req.user, freelancer,
    kind: req.body.kind === 'trial' ? 'trial' : 'standard',
    title, summary: str(req.body.summary, 4000),
    currency: ['USD', 'PKR', 'EUR', 'GBP', 'AED'].includes(req.body.currency) ? req.body.currency : 'USD',
    milestones: cleanMilestones(req.body.milestones),
  });
  res.status(201).json({ contract: await shape(contract, req.user) });
}));

router.get('/:id', asyncHandler(async (req, res) => {
  const c = await load(req);
  res.json({ contract: await shape(c, req.user) });
}));

// ── draft: edit, sign, decline ─────────────────────────────────────────
router.patch('/:id', asyncHandler(async (req, res) => {
  const c = await load(req, { write: true });
  if (c.status !== 'draft') throw badRequest('The scope is locked once both of you sign. Use a change request instead.');
  if (req.body.title !== undefined) { const t = str(req.body.title, 140); if (t.length < 4) throw badRequest('Give the contract a short title'); c.title = t; }
  if (req.body.summary !== undefined) c.summary = str(req.body.summary, 4000);
  if (req.body.currency && ['USD', 'PKR', 'EUR', 'GBP', 'AED'].includes(req.body.currency)) c.currency = req.body.currency;
  if (req.body.milestones) c.milestones = cleanMilestones(req.body.milestones);
  const hadSignatures = Boolean(c.signatures?.client?.at || c.signatures?.freelancer?.at);
  c.signatures = {};
  c.termsVersion += 1;
  c.log(req.user._id, `${req.user.name} edited the draft${hadSignatures ? ' — signatures cleared' : ''}`);
  res.json({ contract: await save(c, req, hadSignatures ? `${req.user.name} changed the draft contract “${c.title}”. Both of you need to sign again.` : null) });
}));

router.post('/:id/sign', asyncHandler(async (req, res) => {
  const c = await load(req, { write: true });
  if (c.status !== 'draft') throw badRequest('This contract is already signed');
  const typed = str(req.body.name, 120);
  if (typed.toLowerCase().replace(/\s+/g, ' ') !== req.user.name.toLowerCase().replace(/\s+/g, ' ')) throw badRequest(`Type your full name exactly as “${req.user.name}” to sign`);
  if (req.body.termsVersion && Number(req.body.termsVersion) !== c.termsVersion) throw badRequest('The draft changed while you were reading it. Review the new version and sign again.');
  if (c.signatures?.[req.role]?.at) throw badRequest('You’ve already signed');
  c.signatures = { ...(c.signatures?.toObject?.() || c.signatures || {}), [req.role]: { at: new Date(), name: typed } };
  c.log(req.user._id, `${req.user.name} signed`);
  let text = `${req.user.name} signed “${c.title}”.`;
  if (c.signatures.client?.at && c.signatures.freelancer?.at) {
    c.status = 'active';
    c.signedAt = new Date();
    c.log(req.user._id, 'Both signed — scope locked, work can start');
    text = `“${c.title}” is signed by both of you. The scope is now locked — anything extra goes through a change request.`;
    if (c.application) await JobApplication.updateOne({ _id: c.application }, { $set: { engagement: c._id } });
  } else {
    contracts.notifyByEmail(otherParty(c, req.role), `Signed: ${c.title}`, 'Your turn to sign', `${req.user.name} signed <strong>${c.title}</strong>. Review it and sign to start.`, c._id);
  }
  res.json({ contract: await save(c, req, text) });
}));

router.post('/:id/decline', asyncHandler(async (req, res) => {
  const c = await load(req, { write: true });
  if (c.status !== 'draft') throw badRequest('Only an unsigned draft can be declined');
  c.status = 'ended';
  c.endedAt = new Date();
  c.endedBy = req.user._id;
  c.endReason = str(req.body.reason, 600) || (req.role === 'freelancer' ? 'Declined by the freelancer' : 'Withdrawn by the client');
  c.log(req.user._id, req.role === 'freelancer' ? `${req.user.name} declined the offer` : `${req.user.name} withdrew the offer`);
  if (c.application && req.role === 'freelancer') await JobApplication.updateOne({ _id: c.application, status: { $in: ['hired', 'trial'] } }, { $set: { status: 'shortlisted' } });
  res.json({ contract: await save(c, req, `${req.user.name} ${req.role === 'freelancer' ? 'declined' : 'withdrew'} the contract “${c.title}”.`) });
}));

// ── files ──────────────────────────────────────────────────────────────
router.post('/:id/files', asyncHandler(async (req, res) => {
  const c = await load(req, { write: true });
  const { name, type, data } = req.body || {};
  if (!FILE_TYPES.test(String(type || ''))) throw badRequest('Use images, PDFs, Office documents, text or zip files');
  const buf = Buffer.from(String(data || '').replace(/^data:[^;]+;base64,/, ''), 'base64');
  if (!buf.length) throw badRequest('The file is empty');
  if (buf.length > MAX_FILE) throw badRequest('Files can be up to 2 MB. For bigger files, share a link in the note.');
  const file = await Attachment.create({ owner: req.user._id, conversation: c.conversation, name: str(name, 200) || 'file', type, size: buf.length, data: buf });
  res.status(201).json({ file: { id: file._id, name: file.name, type: file.type, size: file.size } });
}));

async function fileList(c, ids) {
  const list = (Array.isArray(ids) ? ids : []).filter(isId).slice(0, 10);
  if (!list.length) return [];
  const found = await Attachment.find({ _id: { $in: list }, conversation: c.conversation }).select('_id').lean();
  return found.map((f) => f._id);
}

// ── milestones ─────────────────────────────────────────────────────────
router.post('/:id/milestones/:mid/submit', asyncHandler(async (req, res) => {
  const c = await load(req, { write: true });
  need(req, 'freelancer');
  if (c.status !== 'active') throw badRequest('The contract isn’t active');
  const m = milestoneOf(c, req.params.mid);
  if (m.status !== 'open') throw badRequest('This milestone has already been submitted');
  const note = str(req.body.note, 3000);
  if (note.length < 10) throw badRequest('Say what you’re delivering (a link, what changed, how to check it)');
  m.status = 'submitted';
  m.delivery = { note, files: await fileList(c, req.body.files), at: new Date() };
  c.log(req.user._id, `Delivered “${m.title}”`);
  contracts.notifyByEmail(c.client, `Work delivered: ${m.title}`, 'Work is ready to review', `${req.user.name} delivered <strong>${m.title}</strong> on “${c.title}”. Approve it or ask for changes.`, c._id);
  res.json({ contract: await save(c, req, `${req.user.name} delivered “${m.title}”. Review it under the contract.`) });
}));

router.post('/:id/milestones/:mid/revise', asyncHandler(async (req, res) => {
  const c = await load(req, { write: true });
  need(req, 'client');
  const m = milestoneOf(c, req.params.mid);
  if (m.status !== 'submitted') throw badRequest('You can only ask for changes on delivered work');
  const note = str(req.body.note, 1500);
  if (note.length < 10) throw badRequest('Say exactly what needs to change, within the agreed scope');
  m.status = 'open';
  m.revisions.push({ note, at: new Date() });
  c.log(req.user._id, `Asked for changes on “${m.title}”`);
  res.json({ contract: await save(c, req, `${req.user.name} asked for changes on “${m.title}”: ${note.slice(0, 200)}`) });
}));

router.post('/:id/milestones/:mid/approve', asyncHandler(async (req, res) => {
  const c = await load(req, { write: true });
  need(req, 'client');
  const m = milestoneOf(c, req.params.mid);
  if (m.status !== 'submitted') throw badRequest('Only delivered work can be approved');
  m.status = 'approved';
  m.approvedAt = new Date();
  c.log(req.user._id, `Approved “${m.title}”`);
  contracts.notifyByEmail(c.freelancer, `Approved: ${m.title}`, 'Your work was approved', `${req.user.name} approved <strong>${m.title}</strong>. They’ll mark it paid once the money is sent.`, c._id);
  res.json({ contract: await save(c, req, `${req.user.name} approved “${m.title}”. Payment of ${contracts.money(c.currency, m.amount)} is now due.`) });
}));

router.post('/:id/milestones/:mid/paid', asyncHandler(async (req, res) => {
  const c = await load(req, { write: true });
  need(req, 'client');
  const m = milestoneOf(c, req.params.mid);
  if (!['approved', 'paid'].includes(m.status)) throw badRequest('Approve the work before marking it paid');
  if (m.status === 'paid' && !m.payment?.disputedAt) throw badRequest('Already marked paid');
  const method = PAY_METHODS.includes(req.body.method) ? req.body.method : '';
  if (!method) throw badRequest('How did you pay?');
  const reference = str(req.body.reference, 120);
  if (reference.length < 3) throw badRequest('Add the transaction or reference number so the freelancer can find the payment');
  const proof = isId(req.body.proof) ? (await fileList(c, [req.body.proof]))[0] : undefined;
  const wasDisputed = Boolean(m.payment?.disputedAt);
  m.status = 'paid';
  m.payment = { ...(m.payment?.toObject?.() || {}), markedAt: m.payment?.markedAt || new Date(), method, reference, proof, disputedAt: m.payment?.disputedAt, disputeNote: m.payment?.disputeNote };
  c.log(req.user._id, `${wasDisputed ? 'Updated payment details for' : 'Marked paid'} “${m.title}” (${method}, ref ${reference})`);
  contracts.notifyByEmail(c.freelancer, `Payment sent: ${m.title}`, 'The client says they paid', `${req.user.name} marked <strong>${m.title}</strong> as paid (${contracts.money(c.currency, m.amount)}, ${method}, ref ${reference}). Confirm once it reaches your account.`, c._id);
  res.json({ contract: await save(c, req, `${req.user.name} marked “${m.title}” paid — ${contracts.money(c.currency, m.amount)} via ${method}, reference ${reference}. Confirm when it arrives.`) });
}));

router.post('/:id/milestones/:mid/received', asyncHandler(async (req, res) => {
  const c = await load(req, { write: true });
  need(req, 'freelancer');
  const m = milestoneOf(c, req.params.mid);
  if (m.status !== 'paid') throw badRequest('The client hasn’t marked this paid yet');
  m.status = 'received';
  m.payment.confirmedAt = new Date();
  c.log(req.user._id, `Confirmed payment for “${m.title}”`);
  const done = await finishIfDone(c, req.user._id);
  if (done && c.application) await JobApplication.updateOne({ _id: c.application }, { $set: { status: 'hired' } });
  res.json({ contract: await save(c, req, done
    ? `${req.user.name} confirmed the last payment. “${c.title}” is complete — you each have ${REVIEW_WINDOW_DAYS} days to leave a review. Reviews are revealed together.`
    : `${req.user.name} confirmed receiving ${contracts.money(c.currency, m.amount)} for “${m.title}”.`) });
}));

router.post('/:id/milestones/:mid/not-received', asyncHandler(async (req, res) => {
  const c = await load(req, { write: true });
  need(req, 'freelancer');
  const m = milestoneOf(c, req.params.mid);
  if (m.status !== 'paid') throw badRequest('Only a milestone marked paid can be disputed');
  const age = Date.now() - new Date(m.payment.markedAt).getTime();
  if (age < 2 * DAY && req.body.force !== true) throw badRequest('International transfers can take 1–3 working days. Wait at least 2 days, or check the reference with your bank first.');
  m.payment.disputedAt = new Date();
  m.payment.disputeNote = str(req.body.note, 600);
  c.log(req.user._id, `Reported payment not received for “${m.title}”`);
  contracts.notifyByEmail(c.client, `Payment not received: ${m.title}`, 'The freelancer hasn’t received the payment', `${req.user.name} says the payment for <strong>${m.title}</strong> hasn’t arrived. Check the transfer and update the reference on the contract.`, c._id);
  res.json({ contract: await save(c, req, `${req.user.name} hasn’t received the payment for “${m.title}” yet. This shows on the contract record until it’s confirmed.`) });
}));

// ── change requests (scope lock) ───────────────────────────────────────
router.post('/:id/changes', asyncHandler(async (req, res) => {
  const c = await load(req, { write: true });
  if (c.status !== 'active') throw badRequest('Change requests are for signed, active contracts');
  if (c.changeRequests.filter((x) => x.status === 'pending').length >= 5) throw badRequest('There are already 5 open change requests. Settle those first.');
  const title = str(req.body.title, 120);
  const amount = Number(req.body.amount);
  if (title.length < 4) throw badRequest('Name the extra work');
  if (!Number.isFinite(amount) || amount < 0) throw badRequest('Price the extra work (0 if it’s free)');
  const due = req.body.dueDate ? new Date(req.body.dueDate) : undefined;
  if (due && Number.isNaN(due.getTime())) throw badRequest('Pick a valid date');
  c.changeRequests.push({ by: req.user._id, title, description: str(req.body.description, 3000), amount, dueDate: due });
  c.log(req.user._id, `Proposed a change: “${title}” (${contracts.money(c.currency, amount)})`);
  res.status(201).json({ contract: await save(c, req, `${req.user.name} proposed extra work: “${title}” for ${contracts.money(c.currency, amount)}. It’s not part of the contract until it’s accepted.`) });
}));

router.post('/:id/changes/:cid/:action(accept|decline|withdraw)', asyncHandler(async (req, res) => {
  const c = await load(req, { write: true });
  const cr = isId(req.params.cid) && c.changeRequests.id(req.params.cid);
  if (!cr) throw notFound('Change request not found');
  if (cr.status !== 'pending') throw badRequest('This change was already settled');
  const mineCr = String(cr.by) === String(req.user._id);
  const { action } = req.params;
  if (action === 'withdraw' && !mineCr) throw forbidden('Only the person who proposed it can withdraw it');
  if (action !== 'withdraw' && mineCr) throw forbidden('The other side has to accept or decline your proposal');
  cr.decidedAt = new Date();
  let text;
  if (action === 'accept') {
    if (c.status !== 'active') throw badRequest('The contract isn’t active');
    cr.status = 'accepted';
    c.milestones.push({ title: cr.title, scope: cr.description, amount: cr.amount, dueDate: cr.dueDate, source: 'change' });
    cr.milestone = c.milestones[c.milestones.length - 1]._id;
    text = `${req.user.name} accepted “${cr.title}”. It’s now a milestone at ${contracts.money(c.currency, cr.amount)}.`;
  } else if (action === 'decline') {
    cr.status = 'declined';
    text = `${req.user.name} declined the change “${cr.title}”. The original scope stands.`;
  } else {
    cr.status = 'withdrawn';
    text = `${req.user.name} withdrew the change “${cr.title}”.`;
  }
  c.log(req.user._id, text);
  res.json({ contract: await save(c, req, text) });
}));

// ── payout sharing ─────────────────────────────────────────────────────
router.post('/:id/share-payout', asyncHandler(async (req, res) => {
  const c = await load(req, { write: true });
  need(req, 'freelancer');
  if (!['active', 'completed'].includes(c.status)) throw badRequest('Share payout details once the contract is signed');
  const pm = isId(req.body.method) && await PayoutMethod.findOne({ _id: req.body.method, user: req.user._id });
  if (!pm) throw notFound('Choose one of your payout methods');
  if (pm.status !== 'verified') throw badRequest('Only verified payout methods can be shared. Verify it under Settings → Payouts.');
  c.sharedPayout = { method: pm._id, at: new Date() };
  c.log(req.user._id, `Shared payout details (${pm.display})`);
  res.json({ contract: await save(c, req, `${req.user.name} shared verified payout details (${pm.display}) on this contract.`) });
}));

router.delete('/:id/share-payout', asyncHandler(async (req, res) => {
  const c = await load(req, { write: true });
  need(req, 'freelancer');
  c.sharedPayout = undefined;
  c.log(req.user._id, 'Stopped sharing payout details');
  res.json({ contract: await save(c, req) });
}));

router.get('/:id/payout', asyncHandler(async (req, res) => {
  const c = await load(req, { write: true });
  if (!c.sharedPayout?.method) throw notFound('No payout details are shared on this contract');
  const pm = await PayoutMethod.findById(c.sharedPayout.method).select('+secret').lean();
  if (!pm || pm.status !== 'verified') throw notFound('That payout method is no longer available');
  if (req.role === 'client') {
    c.sharedPayout.viewedAt = new Date();
    c.log(req.user._id, `${req.user.name} viewed the payout details`);
    await c.save();
  }
  res.setHeader('Cache-Control', 'no-store');
  res.json({
    method: payouts.shape(pm),
    details: pm.type === 'card' ? { note: 'Card details stay private. Only the brand and last four digits are shared.' } : payouts.open(pm.secret),
  });
}));

// ── end + reviews ──────────────────────────────────────────────────────
router.post('/:id/end', asyncHandler(async (req, res) => {
  const c = await load(req, { write: true });
  if (c.status !== 'active') throw badRequest('Only an active contract can be ended');
  const reason = str(req.body.reason, 600);
  if (reason.length < 10) throw badRequest('Give a short reason — it’s kept on the contract record');
  c.status = 'ended';
  c.endedAt = new Date();
  c.endedBy = req.user._id;
  c.endReason = reason;
  c.reviewWindowEndsAt = new Date(Date.now() + REVIEW_WINDOW_DAYS * DAY);
  c.changeRequests.forEach((x) => { if (x.status === 'pending') { x.status = 'withdrawn'; x.decidedAt = new Date(); } });
  const owed = c.milestones.filter((m) => ['approved', 'paid'].includes(m.status));
  c.log(req.user._id, `${req.user.name} ended the contract: ${reason}`);
  res.json({ contract: await save(c, req, `${req.user.name} ended “${c.title}”: ${reason}${owed.length ? ` — ${owed.length} approved milestone${owed.length > 1 ? 's are' : ' is'} still to be settled.` : ''}`) });
}));

router.post('/:id/review', asyncHandler(async (req, res) => {
  const c = await load(req, { write: true });
  if (!['completed', 'ended'].includes(c.status)) throw badRequest('Reviews open when the contract finishes');
  if (c.reviewWindowEndsAt && c.reviewWindowEndsAt < new Date()) throw badRequest('The review window for this contract has closed');
  if (!c.milestones.some((m) => m.delivery?.at)) throw badRequest('Nothing was delivered on this contract, so there’s nothing to review');
  if (await Review.exists({ engagement: c._id, from: req.user._id })) throw badRequest('You’ve already reviewed this contract');

  const r = req.body.ratings || {};
  const n = (k) => { const v = Math.round(Number(r[k])); if (!(v >= 1 && v <= 5)) throw badRequest('Rate every line from 1 to 5'); return v; };
  const direction = req.role === 'client' ? 'of_freelancer' : 'of_client';
  const ratings = direction === 'of_freelancer'
    ? { quality: n('quality'), communication: n('communication'), deadlines: n('deadlines') }
    : { payment: n('payment'), scope: n('scope'), communication: n('communication'), respect: n('respect') };
  const review = await Review.create({
    engagement: c._id, from: req.user._id, to: otherParty(c, req.role), direction, ratings,
    wouldWorkAgain: req.body.wouldWorkAgain !== false, comment: str(req.body.comment, 1500),
  });
  const other = await Review.findOne({ engagement: c._id, from: { $ne: req.user._id } });
  if (other) {
    const now = new Date();
    await Review.updateMany({ engagement: c._id }, { $set: { visibleAt: now } });
    review.visibleAt = now;
  }
  c.log(req.user._id, `${req.user.name} left a review`);
  await c.save();
  await contracts.announce(c, other
    ? 'Both reviews are in — they’re now visible on each other’s report card.'
    : `${req.user.name} left a review. It stays hidden until you leave yours (or the window closes), so neither of you can see the other’s first.`);
  await reputation.touch(c.client, c.freelancer);
  res.status(201).json({ contract: await shape(c, req.user) });
}));

module.exports = router;
