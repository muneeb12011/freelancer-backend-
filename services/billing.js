// services/billing.js — pricing, checkout and plan activation. The only code that writes `user.plan`.
const crypto  = require('crypto');
const env     = require('../config/env');
const logger  = require('../utils/logger');
const User    = require('../models/User');
const Payment = require('../models/Payment');
const { PLANS, INTERVAL_DAYS } = require('../config/plans');
const { usdToPkr } = require('./fx');
const payments = require('./payments');
const email    = require('./email');

async function quote(planId, interval) {
  const plan = PLANS[planId];
  if (!plan || planId === 'free') throw Object.assign(new Error('Unknown plan'), { statusCode: 400 });
  if (!INTERVAL_DAYS[interval]) throw Object.assign(new Error('Interval must be month or year'), { statusCode: 400 });
  const amountUsd = plan.prices[interval];
  if (env.BILLING_CURRENCY === 'USD') return { amountUsd, amount: amountUsd, currency: 'USD', fxRate: 1, fxSource: 'none' };
  const fx = await usdToPkr();
  // Round PKR up to the nearest 10 so prices look intentional.
  const amount = Math.ceil((amountUsd * fx.rate) / 10) * 10;
  return { amountUsd, amount, currency: 'PKR', fxRate: fx.rate, fxSource: fx.source };
}

async function startCheckout(user, planId, interval) {
  if (!env.features.payments) {
    throw Object.assign(new Error('Payments are not configured yet. Add SAFEPAY_API_KEY and SAFEPAY_SECRET_KEY on the server.'), { statusCode: 503 });
  }
  const q = await quote(planId, interval);
  const orderId = `AUR-${Date.now().toString(36).toUpperCase()}-${crypto.randomBytes(3).toString('hex').toUpperCase()}`;
  const provider = payments.get('safepay');

  const { tracker, url } = await provider.createCheckout({
    orderId,
    amount: q.amount,
    currency: q.currency,
    redirectUrl: `${env.SERVER_URL}/api/billing/safepay/return`,
    cancelUrl: `${env.CLIENT_URL}/billing?checkout=cancelled`,
  });

  await Payment.create({
    user: user._id, provider: provider.id, orderId, tracker,
    plan: planId, interval, amount: q.amount, currency: q.currency, amountUsd: q.amountUsd, fxRate: q.fxRate,
  });
  return { url, orderId };
}

/** Idempotent: a tracker only ever activates once, no matter how many times redirect/webhook fire. */
async function markPaid(tracker, raw) {
  // updateOne on {status:'pending'} is the atomic claim — only one caller can flip it.
  const claim = await Payment.updateOne({ tracker, status: 'pending' }, { status: 'paid', paidAt: new Date(), raw });
  const payment = await Payment.findOne({ tracker });
  if (!claim.modifiedCount || !payment) return payment; // already processed (or unknown)

  const user = await User.findById(payment.user);
  if (!user) return payment;

  // Extend from the current paid-through date if still active, so renewing early never loses days.
  const now = Date.now();
  const base = user.effectivePlan === 'premium' && user.planExpiresAt && user.planExpiresAt.getTime() > now
    ? user.planExpiresAt.getTime() : now;
  const periodEnd = new Date(base + INTERVAL_DAYS[payment.interval] * 86400e3);

  user.plan = 'premium';
  user.planInterval = payment.interval;
  user.planExpiresAt = periodEnd;
  user.planCancelAtPeriodEnd = false;
  await user.save();

  payment.periodStart = new Date(base);
  payment.periodEnd = periodEnd;
  await payment.save();

  logger.info('Premium activated', { user: String(user._id), orderId: payment.orderId, until: periodEnd.toISOString() });

  if (user.notifications?.paymentReceived !== false) {
    const t = email.templates.paymentReceipt(user.name, {
      plan: PLANS[payment.plan].name, interval: payment.interval, amount: payment.amount,
      currency: payment.currency, periodEnd, orderId: payment.orderId,
    });
    email.send({ to: user.email, ...t }).catch(() => {});
  }
  return payment;
}

async function markFailed(tracker, status, raw) {
  await Payment.updateOne({ tracker, status: 'pending' }, { status, raw });
  return Payment.findOne({ tracker });
}

/** Premium is prepaid, so "cancel" means: don't nag to renew, and lapse at period end. */
async function cancelAtPeriodEnd(user) {
  if (user.effectivePlan !== 'premium') throw Object.assign(new Error('You are on the Free plan'), { statusCode: 400 });
  user.planCancelAtPeriodEnd = true;
  await user.save();
  return user;
}

async function resume(user) {
  user.planCancelAtPeriodEnd = false;
  await user.save();
  return user;
}

module.exports = { quote, startCheckout, markPaid, markFailed, cancelAtPeriodEnd, resume };
