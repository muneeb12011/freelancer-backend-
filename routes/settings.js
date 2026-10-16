// routes/settings.js — notification + preference settings, data export.
// NOTE: `plan` is deliberately NOT editable here — only the billing service changes it.
const router  = require('express').Router();
const account = require('../services/account');
const limits  = require('../middleware/rateLimits');
const { protect } = require('../middleware/auth');
const { asyncHandler, badRequest } = require('../utils/http');

router.use(protect);

const PREF_KEYS = ['language', 'timezone', 'currency', 'dateFormat'];

function settingsPayload(user) {
  const u = user.toClient();
  return {
    name: u.name, email: u.email, plan: u.plan,
    notifications: u.notifications,
    appearance: u.preferences,
    preferences: u.preferences,
    security: { twoFactor: u.twoFactorEnabled, loginAlerts: u.loginAlerts },
    availability: u.availability, hourlyRate: u.hourlyRate, discoverable: u.discoverable,
  };
}

router.get('/', (req, res) => res.json({ settings: settingsPayload(req.user) }));

router.patch('/', asyncHandler(async (req, res) => {
  const { notifications, appearance, preferences, security, availability, hourlyRate, discoverable } = req.body || {};
  const user = req.user;

  if (notifications !== undefined) {
    if (typeof notifications !== 'object') throw badRequest('notifications must be an object');
    const next = { ...(user.notifications || {}) };
    for (const [k, v] of Object.entries(notifications)) if (typeof v === 'boolean' && k.length < 40) next[k] = v;
    user.notifications = next;
    user.markModified('notifications');
  }
  const prefs = appearance || preferences;
  if (prefs) for (const k of PREF_KEYS) if (typeof prefs[k] === 'string') user.preferences[k] = prefs[k].slice(0, 60);
  if (security && typeof security.loginAlerts === 'boolean') user.loginAlerts = security.loginAlerts;
  if (availability !== undefined) user.availability = String(availability).slice(0, 20);
  if (hourlyRate !== undefined) user.hourlyRate = Math.max(0, Number(hourlyRate) || 0);
  if (typeof discoverable === 'boolean') user.discoverable = discoverable;

  await user.save();
  res.json({ settings: settingsPayload(user) });
}));

router.get('/download-data', limits.sensitive, asyncHandler(async (req, res) => {
  const data = await account.exportData(req.user._id);
  res.setHeader('Content-Disposition', `attachment; filename="aurelance-export-${new Date().toISOString().slice(0, 10)}.json"`);
  res.json(data);
}));

// Legacy alias — the frontend now uses DELETE /api/auth/account.
router.delete('/account', (req, res) => res.status(410).json({ error: 'Use DELETE /api/auth/account' }));

module.exports = router;
