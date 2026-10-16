// middleware/rateLimits.js — per-IP limits for abuse-prone endpoints.
// Note: the default store is in-memory per instance. For multi-instance production,
// plug in a shared store (e.g. rate-limit-redis) here — routes don't need to change.
const rateLimit = require('express-rate-limit');

const make = (windowMs, limit, message) => rateLimit({
  windowMs,
  limit,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { error: message, code: 'RATE_LIMITED' },
});

module.exports = {
  api:      make(15 * 60e3, 600, 'Too many requests. Slow down and try again in a few minutes.'),
  auth:     make(15 * 60e3, 30,  'Too many sign-in attempts. Try again in 15 minutes.'),
  sensitive:make(60 * 60e3, 8,   'Too many attempts. Try again in an hour.'),
  publicForm:make(60 * 60e3, 10, 'Too many messages from this network. Try again later.'),
  ai:       make(60e3, 20,       'You are sending AI requests too quickly. Wait a minute.'),
};
