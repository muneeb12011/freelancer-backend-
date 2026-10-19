// routes/disputes.js — disagreements on a contract, decided by a person, recorded for both sides.
//   POST /api/disputes                    { engagement, milestone?, kind, statement, evidence[] }
//   GET  /api/disputes/:id
//   POST /api/disputes/:id/respond        { text, evidence[] }   the other side, within 7 days
//   POST /api/disputes/:id/withdraw       the person who opened it
const router = require('express').Router();
const Dispute = require('../models/Dispute');
const Engagement = require('../models/Engagement');
const Attachment = require('../models/Attachment');
const User = require('../models/User');
const env = require('../config/env');
const email = require('../services/email');
const notify = require('../services/notify');
const contracts = require('../services/contracts');
const { protect } = require('../middleware/auth');
const { asyncHandler, badRequest, notFound, forbidden } = require('../utils/http');
const { isId, str } = require('../utils/sanitize');

router.use(protect);

const KINDS = {
  payment_not_received: 'Payment not received',
  work_not_delivered: 'Work not delivered',
  work_not_as_agreed: 'Work not as agreed',
  scope: 'Work outside the signed scope',
  other: 'Something else',
};
const RESPOND_DAYS = 7;

async function evidenceOf(contract, ids) {
  const list = (Array.isArray(ids) ? ids : []).filter(isId).slice(0, 8);
  if (!list.length) return [];
  return (await Attachment.find({ _id: { $in: list }, conversation: contract.conversation }).select('_id').lean()).map((a) => a._id);
}

async function load(req) {
  if (!isId(req.params.id)) throw notFound('Dispute not found');
  const d = await Dispute.findById(req.params.id);
  if (!d) throw notFound('Dispute not found');
  const isParty = [String(d.openedBy), String(d.against)].includes(String(req.user._id));
  if (!isParty && !req.user.toClient().isAdmin) throw notFound('Dispute not found');
  return d;
}

router.post('/', asyncHandler(async (req, res) => {
  const { engagement: eid, milestone } = req.body;
  if (!isId(eid)) throw badRequest('Which contract is this about?');
  const c = await Engagement.findById(eid);
  if (!c) throw notFound('Contract not found');
  const role = c.roleOf(req.user._id);
  if (!role) throw notFound('Contract not found');
  if (c.status === 'draft') throw badRequest('Nothing has started yet. Edit or decline the draft instead.');
  if (!KINDS[req.body.kind]) throw badRequest('Choose what the dispute is about');
  const statement = str(req.body.statement, 4000);
  if (statement.length < 40) throw badRequest('Explain what happened in at least a few sentences — dates, amounts, what was agreed');
  if (milestone && !(isId(milestone) && c.milestones.id(milestone))) throw badRequest('That milestone isn’t on this contract');
  if (await Dispute.exists({ engagement: c._id, status: { $in: ['open', 'responded'] } })) throw badRequest('There’s already an open dispute on this contract');

  const against = role === 'client' ? c.freelancer : c.client;
  const d = await Dispute.create({
    engagement: c._id, milestone: milestone || undefined, openedBy: req.user._id, against, kind: req.body.kind, statement,
    evidence: await evidenceOf(c, req.body.evidence), respondBy: new Date(Date.now() + RESPOND_DAYS * 86400e3),
  });
  c.log(req.user._id, `${req.user.name} opened a dispute: ${KINDS[d.kind]}`);
  await c.save();
  await contracts.announce(c, `${req.user.name} asked Aurelance to review this contract (${KINDS[d.kind].toLowerCase()}). The other side has ${RESPOND_DAYS} days to respond.`);
  notify.push(against, { type: 'dispute.opened', actor: req.user._id, link: `/contracts/${c._id}`, title: `${req.user.name} opened a dispute on “${c.title}”`, body: `${KINDS[d.kind]}. Respond within ${RESPOND_DAYS} days.` });
  if (env.ADMIN_EMAILS.length) {
    email.send({ to: env.ADMIN_EMAILS[0], subject: `Dispute opened: ${c.title}`, html: email.layout({ heading: 'New dispute', intro: `${email.esc(req.user.name)} opened a dispute (${email.esc(KINDS[d.kind])}) on “${email.esc(c.title)}”.`, action: { label: 'Open the queue', url: `${env.CLIENT_URL}/admin` } }) }).catch(() => {});
  }
  res.status(201).json({ dispute: d });
}));

router.get('/:id', asyncHandler(async (req, res) => {
  res.json({ dispute: await load(req) });
}));

router.post('/:id/respond', asyncHandler(async (req, res) => {
  const d = await load(req);
  if (String(d.against) !== String(req.user._id)) throw forbidden('Only the other side of the contract can respond');
  if (d.status !== 'open') throw badRequest('This dispute isn’t waiting for a response');
  const text = str(req.body.text, 4000);
  if (text.length < 40) throw badRequest('Give your side in at least a few sentences');
  const c = await Engagement.findById(d.engagement);
  d.response = { text, evidence: await evidenceOf(c, req.body.evidence), at: new Date() };
  d.status = 'responded';
  await d.save();
  c.log(req.user._id, `${req.user.name} responded to the dispute`);
  await c.save();
  notify.push(d.openedBy, { type: 'dispute.responded', actor: req.user._id, link: `/contracts/${c._id}`, title: `${req.user.name} responded to your dispute`, body: 'An Aurelance reviewer will now decide.' });
  res.json({ dispute: d });
}));

router.post('/:id/withdraw', asyncHandler(async (req, res) => {
  const d = await load(req);
  if (String(d.openedBy) !== String(req.user._id)) throw forbidden('Only the person who opened it can withdraw it');
  if (!['open', 'responded'].includes(d.status)) throw badRequest('This dispute is already closed');
  d.status = 'withdrawn';
  await d.save();
  const c = await Engagement.findById(d.engagement);
  c.log(req.user._id, `${req.user.name} withdrew the dispute`);
  await c.save();
  notify.push(d.against, { type: 'dispute.withdrawn', actor: req.user._id, link: `/contracts/${c._id}`, title: `${req.user.name} withdrew the dispute on “${c.title}”` });
  res.json({ dispute: d });
}));

router.KINDS = KINDS;
module.exports = router;
