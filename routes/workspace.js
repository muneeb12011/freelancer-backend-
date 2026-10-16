// routes/workspace.js — GET/PUT /api/workspace/:key for small tool documents.
const router = require('express').Router();
const WorkspaceDoc = require('../models/WorkspaceDoc');
const { protect } = require('../middleware/auth');
const { asyncHandler, badRequest } = require('../utils/http');

router.use(protect);

const KEYS = ['brandKit', 'estimates', 'timeSessions', 'revenueGoal', 'dashboardLayout'];
const MAX_BYTES = 200 * 1024;

const checkKey = (k) => { if (!KEYS.includes(k)) throw badRequest('Unknown workspace key'); };

router.get('/', asyncHandler(async (req, res) => {
  const docs = await WorkspaceDoc.find({ user: req.user._id }).lean();
  res.json({ data: Object.fromEntries(docs.map((d) => [d.key, d.data])) });
}));

router.get('/:key', asyncHandler(async (req, res) => {
  checkKey(req.params.key);
  const doc = await WorkspaceDoc.findOne({ user: req.user._id, key: req.params.key }).lean();
  res.json({ key: req.params.key, data: doc ? doc.data : null, updatedAt: doc?.updatedAt || null });
}));

router.put('/:key', asyncHandler(async (req, res) => {
  checkKey(req.params.key);
  const data = req.body?.data === undefined ? null : req.body.data;
  if (Buffer.byteLength(JSON.stringify(data)) > MAX_BYTES) throw badRequest('That is too much data to save in one place');
  const doc = await WorkspaceDoc.findOneAndUpdate(
    { user: req.user._id, key: req.params.key },
    { $set: { data } },
    { upsert: true, new: true, setDefaultsOnInsert: true },
  );
  res.json({ key: doc.key, data: doc.data, updatedAt: doc.updatedAt });
}));

module.exports = router;
