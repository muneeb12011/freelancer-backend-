// services/fx.js — live USD→PKR rate with a 6-hour cache and an env fallback.
const env    = require('../config/env');
const logger = require('../utils/logger');

let cache = { rate: null, at: 0, source: 'fallback' };
const TTL = 6 * 3600e3;

async function usdToPkr() {
  if (cache.rate && Date.now() - cache.at < TTL) return cache;
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 4000);
    const r = await fetch('https://open.er-api.com/v6/latest/USD', { signal: ctrl.signal });
    clearTimeout(t);
    const d = await r.json();
    const rate = Number(d?.rates?.PKR);
    if (rate > 100 && rate < 1000) {
      cache = { rate, at: Date.now(), source: 'open.er-api.com' };
      return cache;
    }
    throw new Error('rate out of range');
  } catch (err) {
    logger.warn(`FX lookup failed, using fallback: ${err.message}`);
    return { rate: cache.rate || env.FX_USD_PKR_FALLBACK, at: Date.now(), source: cache.rate ? 'stale-cache' : 'fallback' };
  }
}

module.exports = { usdToPkr };
