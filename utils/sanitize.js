// utils/sanitize.js — input hygiene helpers shared by every route.
const mongoose = require('mongoose');

// Fields a client must never be able to set through a generic create/update body.
const PROTECTED = ['_id', 'id', 'user', '__v', 'createdAt', 'updatedAt'];

/** Copy only whitelisted keys from `src`. */
function pick(src, fields) {
  const out = {};
  if (!src || typeof src !== 'object') return out;
  for (const f of fields) if (src[f] !== undefined) out[f] = src[f];
  return out;
}

/** Remove ownership / system fields from a body (for models with many editable fields). */
function stripProtected(src, extra = []) {
  const out = { ...(src || {}) };
  for (const f of [...PROTECTED, ...extra]) delete out[f];
  return out;
}

/** Escape a user string for safe use inside `new RegExp()` (prevents ReDoS / regex injection). */
function escapeRegex(s) {
  return String(s || '').slice(0, 100).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
const searchRegex = (s) => new RegExp(escapeRegex(s), 'i');

/** Bounded integer from a query string. */
function clampInt(v, { min = 1, max = 500, def = 50 } = {}) {
  const n = parseInt(v, 10);
  if (!Number.isFinite(n)) return def;
  return Math.min(max, Math.max(min, n));
}

const isId = (v) => mongoose.isValidObjectId(v);

const isEmail = (v) => typeof v === 'string' && v.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(v.trim());

const str = (v, max = 5000) => (v === undefined || v === null ? '' : String(v).trim().slice(0, max));

module.exports = { pick, stripProtected, escapeRegex, searchRegex, clampInt, isId, isEmail, str, PROTECTED };
