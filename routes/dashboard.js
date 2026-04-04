// routes/dashboard.js — aggregated stats for the Dashboard page
// Covers: /api/dashboard, /api/dashboard/stats, /api/dashboard/revenue, /api/dashboard/productivity
const router  = require('express').Router();
const Client  = require('../models/Client');
const Invoice = require('../models/Invoice');
const Task    = require('../models/Task');
const Connection = require('../models/Connection');
const Earning = require('../models/Earning');
const { protect } = require('../middleware/auth');

router.use(protect);

// ── GET /api/dashboard ─────────────────────────────
// Returns everything the Dashboard page needs in one request
router.get('/', async (req, res, next) => {
  try {
    const uid = req.user._id;
    const now = new Date();
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
    const yearStart  = new Date(now.getFullYear(), 0, 1);

    const [
      clients,
      invoices,
      tasks,
      connections,
      earnings,
    ] = await Promise.all([
      Client.find({ user: uid }).select('status revenue outstanding updatedAt'),
      Invoice.find({ user: uid }).select('status total issueDate dueDate createdAt'),
      Task.find({ user: uid }).select('status priority deadline completed createdAt'),
      Connection.find({ user: uid }).select('status favorite updatedAt').lean(),
      Earning.find({ user: uid }).select('type amount date'),
    ]);

    // ── Client stats ───────────────────────────────
    const totalClients  = clients.length;
    const activeClients = clients.filter(c => c.status === 'Active').length;
    const newClients    = clients.filter(c => new Date(c.createdAt) >= monthStart).length;

    // ── Invoice stats ──────────────────────────────
    const paidInvoices    = invoices.filter(i => i.status === 'paid');
    const pendingInvoices = invoices.filter(i => ['draft','sent'].includes(i.status));
    const overdueInvoices = invoices.filter(i =>
      i.status !== 'paid' && i.dueDate && new Date(i.dueDate) < now
    );

    const totalRevenue    = paidInvoices.reduce((s, i) => s + (i.total || 0), 0);
    const pendingRevenue  = pendingInvoices.reduce((s, i) => s + (i.total || 0), 0);
    const overdueRevenue  = overdueInvoices.reduce((s, i) => s + (i.total || 0), 0);

    // Revenue this month
    const monthRevenue = paidInvoices
      .filter(i => new Date(i.issueDate) >= monthStart)
      .reduce((s, i) => s + (i.total || 0), 0);

    // Monthly revenue for chart (last 6 months)
    const monthlyRevenue = [];
    for (let i = 5; i >= 0; i--) {
      const d     = new Date(now.getFullYear(), now.getMonth() - i, 1);
      const end   = new Date(now.getFullYear(), now.getMonth() - i + 1, 0);
      const label = d.toLocaleString('default', { month: 'short' });
      const total = paidInvoices
        .filter(inv => {
          const d2 = new Date(inv.issueDate);
          return d2 >= d && d2 <= end;
        })
        .reduce((s, inv) => s + (inv.total || 0), 0);
      monthlyRevenue.push({ month: label, revenue: total });
    }

    // ── Task stats ─────────────────────────────────
    const totalTasks    = tasks.length;
    const completedTasks= tasks.filter(t => t.completed || t.status === 'done').length;
    const overdueTasks  = tasks.filter(t =>
      !t.completed && t.deadline && new Date(t.deadline) < now
    ).length;
    const dueSoon = tasks.filter(t => {
      if (t.completed || !t.deadline) return false;
      const diff = (new Date(t.deadline) - now) / 86400000;
      return diff >= 0 && diff <= 7;
    }).length;

    const tasksByStatus = {
      todo:        tasks.filter(t => t.status === 'todo').length,
      'in-progress': tasks.filter(t => t.status === 'in-progress').length,
      review:      tasks.filter(t => t.status === 'review').length,
      done:        tasks.filter(t => t.status === 'done').length,
    };

    // ── Connection stats ───────────────────────────
    const totalConnections = connections.length;
    const favorites        = connections.filter(c => c.favorite).length;

    // ── Expense stats ──────────────────────────────
    const yearExpenses = earnings
      .filter(e => e.type === 'expense' && e.date?.startsWith(String(now.getFullYear())))
      .reduce((s, e) => s + Math.abs(e.amount || 0), 0);

    const netProfit = totalRevenue - yearExpenses;

    // ── Recent activity ────────────────────────────
    const recentInvoices = await Invoice.find({ user: uid })
      .sort({ createdAt: -1 })
      .limit(5)
      .select('invoiceNumber clientName status total issueDate');

    const recentTasks = await Task.find({ user: uid })
      .sort({ createdAt: -1 })
      .limit(5)
      .select('title status priority deadline');

    const upcomingTasks = await Task.find({
      user: uid,
      completed: false,
      deadline: { $gte: now },
    })
      .sort({ deadline: 1 })
      .limit(5)
      .select('title status priority deadline');

    // ── Compose response ───────────────────────────
    res.json({
      // Clients
      totalClients, activeClients, newClients,

      // Revenue
      totalRevenue, pendingRevenue, overdueRevenue,
      monthRevenue, monthlyRevenue,

      // Invoices
      totalInvoices:   invoices.length,
      paidCount:       paidInvoices.length,
      pendingCount:    pendingInvoices.length,
      overdueCount:    overdueInvoices.length,

      // Tasks
      totalTasks, completedTasks, overdueTasks, dueSoon, tasksByStatus,

      // Connections
      totalConnections, favorites,

      // Profit
      yearExpenses, netProfit,

      // Lists
      recentInvoices,
      recentTasks,
      upcomingTasks,
    });
  } catch (err) { next(err); }
});

// ── GET /api/dashboard/stats ───────────────────────
// Lightweight version — just numbers
router.get('/stats', async (req, res, next) => {
  try {
    const uid = req.user._id;
    const [clientCount, invoiceCount, taskCount, connectionCount] = await Promise.all([
      Client.countDocuments({ user: uid }),
      Invoice.countDocuments({ user: uid }),
      Task.countDocuments({ user: uid, completed: false }),
      Connection.countDocuments({ user: uid }),
    ]);
    res.json({ clientCount, invoiceCount, taskCount, connectionCount });
  } catch (err) { next(err); }
});

// ── GET /api/dashboard/revenue?months=6 ───────────
router.get('/revenue', async (req, res, next) => {
  try {
    const uid    = req.user._id;
    const months = parseInt(req.query.months) || 6;
    const now    = new Date();
    const data   = [];

    for (let i = months - 1; i >= 0; i--) {
      const start = new Date(now.getFullYear(), now.getMonth() - i, 1);
      const end   = new Date(now.getFullYear(), now.getMonth() - i + 1, 0);
      const label = start.toLocaleString('default', { month: 'short', year: '2-digit' });

      const invoices = await Invoice.find({
        user: uid, status: 'paid',
        issueDate: { $gte: start.toISOString().split('T')[0], $lte: end.toISOString().split('T')[0] },
      }).select('total');

      const revenue  = invoices.reduce((s, inv) => s + (inv.total || 0), 0);
      const expenses = await Earning.aggregate([
        { $match: { user: uid, type: 'expense', date: { $regex: `^${start.toISOString().slice(0,7)}` } } },
        { $group: { _id: null, total: { $sum: { $abs: '$amount' } } } },
      ]);

      data.push({
        month:    label,
        revenue,
        expenses: expenses[0]?.total || 0,
        profit:   revenue - (expenses[0]?.total || 0),
      });
    }

    res.json({ data });
  } catch (err) { next(err); }
});

// ── GET /api/dashboard/productivity?weeks=5 ────────
router.get('/productivity', async (req, res, next) => {
  try {
    const uid   = req.user._id;
    const weeks = parseInt(req.query.weeks) || 5;
    const now   = new Date();
    const data  = [];

    for (let i = weeks - 1; i >= 0; i--) {
      const start = new Date(now);
      start.setDate(now.getDate() - (i + 1) * 7);
      const end = new Date(now);
      end.setDate(now.getDate() - i * 7);

      const label = `W${weeks - i}`;

      const [completed, created] = await Promise.all([
        Task.countDocuments({ user: uid, completedAt: { $gte: start, $lte: end } }),
        Task.countDocuments({ user: uid, createdAt:   { $gte: start, $lte: end } }),
      ]);

      data.push({ week: label, completed, created });
    }

    res.json({ data });
  } catch (err) { next(err); }
});

// ── GET /api/dashboard/counts ──────────────────────
router.get('/counts', async (req, res, next) => {
  try {
    const uid = req.user._id;
    const now = new Date();

    const [
      totalClients, activeClients,
      totalInvoices, paidInvoices, overdueInvoices,
      totalTasks, completedTasks, overdueTasks,
      totalConnections,
    ] = await Promise.all([
      Client.countDocuments({ user: uid }),
      Client.countDocuments({ user: uid, status: 'Active' }),
      Invoice.countDocuments({ user: uid }),
      Invoice.countDocuments({ user: uid, status: 'paid' }),
      Invoice.countDocuments({ user: uid, status: { $ne: 'paid' }, dueDate: { $lt: now.toISOString().split('T')[0] } }),
      Task.countDocuments({ user: uid }),
      Task.countDocuments({ user: uid, status: 'done' }),
      Task.countDocuments({ user: uid, completed: false, deadline: { $lt: now } }),
      Connection.countDocuments({ user: uid }),
    ]);

    const revenueAgg = await Invoice.aggregate([
      { $match: { user: req.user._id, status: 'paid' } },
      { $group: { _id: null, total: { $sum: '$total' } } },
    ]);

    res.json({
      clients:     { total: totalClients, active: activeClients },
      invoices:    { total: totalInvoices, paid: paidInvoices, overdue: overdueInvoices },
      tasks:       { total: totalTasks, completed: completedTasks, overdue: overdueTasks },
      connections: { total: totalConnections },
      revenue:     revenueAgg[0]?.total || 0,
    });
  } catch (err) { next(err); }
});

module.exports = router;