// services/payments/safepay.js — Safepay hosted checkout (Pakistan).
// Mirrors the official @sfpy/node-sdk (v3) endpoints and signature rules, without its axios dependency,
// and uses constant-time comparison for signatures.
const crypto = require('crypto');
const env    = require('../../config/env');
const { safeEqual } = require('../../utils/tokens');

const HOSTS = {
  production: { api: 'https://api.getsafepay.com',          checkout: 'https://getsafepay.com/checkout/pay' },
  sandbox:    { api: 'https://sandbox.api.getsafepay.com',  checkout: 'https://sandbox.api.getsafepay.com/checkout/pay' },
  development:{ api: 'https://dev.api.getsafepay.com',      checkout: 'https://dev.api.getsafepay.com/checkout/pay' },
};

const host = () => HOSTS[env.SAFEPAY_ENV] || HOSTS.sandbox;

/** Create a payment tracker and the hosted checkout URL for it. */
async function createCheckout({ orderId, amount, currency, redirectUrl, cancelUrl }) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 10000);
  let res;
  try {
    res = await fetch(`${host().api}/order/v1/init`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ amount, client: env.SAFEPAY_API_KEY, currency, environment: env.SAFEPAY_ENV }),
      signal: ctrl.signal,
    });
  } finally { clearTimeout(t); }

  const body = await res.json().catch(() => ({}));
  const tracker = body?.data?.token;
  if (!res.ok || !tracker) {
    const reason = body?.status?.message || body?.message || `HTTP ${res.status}`;
    throw Object.assign(new Error(`Payment provider rejected the checkout (${reason})`), { statusCode: 502 });
  }

  const params = new URLSearchParams({
    beacon: tracker,
    cancel_url: cancelUrl,
    env: env.SAFEPAY_ENV,
    order_id: orderId,
    redirect_url: redirectUrl,
    source: 'custom',
    webhooks: 'true',
  });
  return { tracker, url: `${host().checkout}?${params.toString()}` };
}

/** Safepay signs the redirect with HMAC-SHA256(tracker, secret). */
function verifyRedirect({ tracker, sig }) {
  if (!tracker || !sig || !env.SAFEPAY_SECRET_KEY) return false;
  const expected = crypto.createHmac('sha256', env.SAFEPAY_SECRET_KEY).update(String(tracker)).digest('hex');
  return safeEqual(expected, sig);
}

/** Webhooks are signed with HMAC-SHA512(JSON(body.data), webhookSecret) in `x-sfpy-signature`. */
function verifyWebhook(req) {
  const signature = req.headers['x-sfpy-signature'];
  if (!signature || !env.SAFEPAY_WEBHOOK_SECRET || !req.body?.data) return false;
  const expected = crypto.createHmac('sha512', env.SAFEPAY_WEBHOOK_SECRET)
    .update(Buffer.from(JSON.stringify(req.body.data))).digest('hex');
  return safeEqual(expected, signature);
}

/** Normalise a webhook payload into { tracker, outcome }. */
function parseWebhook(body) {
  const d = body?.data || {};
  const tracker = d.tracker?.token || d.tracker || d.token || d.beacon || null;
  const state = String(d.state || d.status || d.tracker?.state || body?.type || '').toLowerCase();
  let outcome = 'paid';
  if (/fail|declin|error/.test(state)) outcome = 'failed';
  else if (/cancel|void|expired/.test(state)) outcome = 'cancelled';
  else if (/pending|created_tracker|init/.test(state) && !/payment/.test(state)) outcome = 'pending';
  return { tracker, outcome, state };
}

module.exports = { id: 'safepay', createCheckout, verifyRedirect, verifyWebhook, parseWebhook };
