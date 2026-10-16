// routes/deadlines.js — manual deadlines for the dashboard.
const router   = require('express').Router();
const Deadline = require('../models/Deadline');
const { protect } = require('../middleware/auth');
const { asyncHandler, badRequest, notFound } = require('../utils/http');
const { pick, str, clampInt } = require('../utils/sanitize');

router.use(protect);

const FIELDS = ['title', 'dueDate', 'priority', 'completed', 'note'];

router.get('/', asyncHandler(async (req, res) => {
  const filter = { user: req.user._id };
  if (req.query.completed === 'false') filter.completed = false;
  const deadlines = await Deadline.find(filter).sort({ completed: 1, dueDate: 1 }).limit(clampInt(req.query.limit, { max: 500, def: 200 }));
  res.json({ deadlines });
}));

router.post('/', asyncHandler(async (req, res) => {
  const data = pick(req.body, FIELDS);
  if (!str(data.title)) throw badRequest('Give the deadline a title');
  if (!data.dueDate || Number.isNaN(new Date(data.dueDate).getTime())) throw badRequest('Pick a valid due date');
  const deadline = await Deadline.create({ ...data, user: req.user._id });
  res.status(201).json({ deadline });
}));

const update = asyncHandler(async (req, res) => {
  const deadline = await Deadline.findOneAndUpdate({ _id: req.params.id, user: req.user._id }, pick(req.body, FIELDS), { new: true, runValidators: true });
  if (!deadline) throw notFound('Deadline not found');
  res.json({ deadline });
});
router.patch('/:id', update);
router.put('/:id', update);

router.delete('/:id', asyncHandler(async (req, res) => {
  const r = await Deadline.deleteOne({ _id: req.params.id, user: req.user._id });
  if (!r.deletedCount) throw notFound('Deadline not found');
  res.json({ message: 'Deadline deleted' });
}));

module.exports = router;
