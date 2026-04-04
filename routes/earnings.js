// routes/earnings.js — income + expenses for Atelier
const router  = require('express').Router();
const Earning = require('../models/Earning');
const { protect } = require('../middleware/auth');

router.use(protect);

// ── GET /api/earnings ──────────────────────────────
router.get('/', async (req, res, next) => {
  try {
    const { type, year, limit = 500 } = req.query;
    const filter = { user: req.user._id };
    if (type) filter.type = type;
    if (year) filter.date = { $regex: `^${year}` };

    const earnings = await Earning.find(filter)
      .sort({ date: -1, createdAt: -1 })
      .limit(+limit);
    res.json({ earnings });
  } catch (err) { next(err); }
});

// ── POST /api/earnings ─────────────────────────────
router.post('/', async (req, res, next) => {
  try {
    const { name, amount, type = 'expense', category = 'Other', date, note } = req.body;
    if (!name?.trim()) return res.status(400).json({ error: 'Name is required' });
    if (amount === undefined) return res.status(400).json({ error: 'Amount is required' });

    const earning = await Earning.create({
      user: req.user._id, name, amount, type, category,
      date: date || new Date().toISOString().split('T')[0],
      note: note || '',
    });
    res.status(201).json({ earning });
  } catch (err) { next(err); }
});

// ── PATCH /api/earnings/:id ────────────────────────
router.patch('/:id', async (req, res, next) => {
  try {
    const earning = await Earning.findOneAndUpdate(
      { _id: req.params.id, user: req.user._id },
      { ...req.body },
      { new: true }
    );
    if (!earning) return res.status(404).json({ error: 'Entry not found' });
    res.json({ earning });
  } catch (err) { next(err); }
});

// ── DELETE /api/earnings/:id ───────────────────────
router.delete('/:id', async (req, res, next) => {
  try {
    await Earning.findOneAndDelete({ _id: req.params.id, user: req.user._id });
    res.json({ message: 'Entry deleted' });
  } catch (err) { next(err); }
});

// ── GET /api/earnings/summary ──────────────────────
// Returns totals grouped by type and category
router.get('/summary', async (req, res, next) => {
  try {
    const { year = new Date().getFullYear() } = req.query;

    const [incomeAgg, expenseAgg] = await Promise.all([
      Earning.aggregate([
        { $match: { user: req.user._id, type: 'income', date: { $regex: `^${year}` } } },
        { $group: { _id: null, total: { $sum: '$amount' }, count: { $sum: 1 } } },
      ]),
      Earning.aggregate([
        { $match: { user: req.user._id, type: 'expense', date: { $regex: `^${year}` } } },
        { $group: { _id: '$category', total: { $sum: '$amount' } } },
        { $sort: { total: -1 } },
      ]),
    ]);

    const totalIncome  = incomeAgg[0]?.total  || 0;
    const totalExpense = expenseAgg.reduce((s, e) => s + Math.abs(e.total), 0);

    res.json({
      year,
      totalIncome,
      totalExpense,
      net: totalIncome - totalExpense,
      expenseByCategory: expenseAgg.map(e => ({ category: e._id, total: Math.abs(e.total) })),
    });
  } catch (err) { next(err); }
});

module.exports = router;
