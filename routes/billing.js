// routes/billing.js — plans, Safepay checkout, return + webhook, history, renewal preference.
const router  = require('express').Router();
const env     = require('../config/env');
const logger  = require('../utils/logger');
const Payment = require('../models/Payment');
const billing = require('../services/billing');
const payments = require('../services/payments');
const limits  = require('../middleware/rateLimits');
const { protect } = require('../middleware/auth');
const { PLANS } = require('../config/plans');
const { asyncHandler, badRequest } = require('../utils/http');

// ── Public: plans with live local price ─────────────────────────────────
router.get('/plans', asyncHandler(async (req, res) => {
  const out = await Promise.all(Object.values(PLANS).map(async (p) => {
    if (p.id === 'free') return { ...p, local: { month: 0, year: 0, currency: env.BILLING_CURRENCY } };
    const [m, y] = await Promise.all([billing.quote(p.id, 'month'), billing.quote(p.id, 'year')]);
    return { ...p, local: { month: m.amount, year: y.amount, currency: m.currency, fxRate: m.fxRate, fxSource: m.fxSource } };
  }));
  res.json({ plans: out, currency: env.BILLING_CURRENCY, paymentsEnabled: env.features.payments, provider: 'Safepay' });
}));

// ── Safepay redirect (browser comes back here after paying) ─────────────
// Safepay may POST a form or GET with query params depending on integration mode.
const handleReturn = asyncHandler(async (req, res) => {
  const p = { ...req.query, ...(req.body || {}) };
  const tracker = p.tracker || p.beacon || p.token;
  const provider = payments.get('safepay');
  if (!tracker) return res.redirect(303, `${env.CLIENT_URL}/billing?checkout=error`);

  if (provider.verifyRedirect({ tracker, sig: p.sig })) {
    await billing.markPaid(tracker, { via: 'redirect', reference: p.reference, order_id: p.order_id });
    return res.redirect(303, `${env.CLIENT_URL}/billing?checkout=success`);
  }
  // Signature missing/invalid: don't activate — the webhook will if the payment is real.
  logger.warn('Safepay return without valid signature', { tracker });
  return res.redirect(303, `${env.CLIENT_URL}/billing?checkout=pending`);
});
router.get('/safepay/return', handleReturn);
router.post('/safepay/return', handleReturn);

// ── Safepay webhook (server to server) ───────────────────────────────────
router.post('/safepay/webhook', asyncHandler(async (req, res) => {
  const provider = payments.get('safepay');
  if (!provider.verifyWebhook(req)) {
    logger.warn('Rejected Safepay webhook: bad signature');
    return res.status(401).json({ error: 'Invalid signature' });
  }
  const { tracker, outcome, state } = provider.parseWebhook(req.body);
  if (!tracker) return res.status(200).json({ ignored: true });
  if (outcome === 'paid') await billing.markPaid(tracker, { via: 'webhook', state });
  else if (outcome === 'failed' || outcome === 'cancelled') await billing.markFailed(tracker, outcome, { via: 'webhook', state });
  return res.json({ received: true });
}));

// ── Everything below needs a signed-in user ─────────────────────────────
router.use(protect);

router.get('/subscription', asyncHandler(async (req, res) => {
  const u = req.user;
  const last = await Payment.findOne({ user: u._id, status: 'paid' }).sort({ paidAt: -1 }).lean();
  res.json({
    plan: u.effectivePlan,
    interval: u.planInterval || null,
    expiresAt: u.effectivePlan === 'premium' ? u.planExpiresAt : null,
    cancelAtPeriodEnd: u.planCancelAtPeriodEnd,
    lastPayment: last ? { amount: last.amount, currency: last.currency, paidAt: last.paidAt, orderId: last.orderId } : null,
  });
}));

router.post('/checkout', limits.sensitive, asyncHandler(async (req, res) => {
  const plan = req.body.plan || req.body.planId || 'premium';
  const interval = req.body.interval || 'month';
  if (plan !== 'premium') throw badRequest('Only Premium can be purchased');
  const { url, orderId } = await billing.startCheckout(req.user, plan, interval);
  res.json({ url, orderId });
}));

router.get('/history', asyncHandler(async (req, res) => {
  const rows = await Payment.find({ user: req.user._id, status: { $in: ['paid', 'failed'] } }).sort({ createdAt: -1 }).limit(100).lean();
  res.json({
    payments: rows.map((r) => ({
      _id: r._id, orderId: r.orderId, plan: r.plan, interval: r.interval, amount: r.amount, currency: r.currency,
      status: r.status, paidAt: r.paidAt, createdAt: r.createdAt, periodStart: r.periodStart, periodEnd: r.periodEnd,
    })),
  });
}));

router.post('/cancel', asyncHandler(async (req, res) => {
  const user = await billing.cancelAtPeriodEnd(req.user);
  res.json({ message: `Premium stays active until ${user.planExpiresAt?.toDateString()}. It won’t renew.`, user: user.toClient() });
}));

router.post('/resume', asyncHandler(async (req, res) => {
  const user = await billing.resume(req.user);
  res.json({ message: 'Renewal reminders are back on.', user: user.toClient() });
}));

module.exports = router;
