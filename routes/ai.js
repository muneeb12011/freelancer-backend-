// routes/ai.js — POST /api/ai/:feature  { input, history?, context? }
const router = require('express').Router();
const ai     = require('../services/ai');
const limits = require('../middleware/rateLimits');
const { protect } = require('../middleware/auth');
const { asyncHandler } = require('../utils/http');

router.use(protect);

router.get('/usage', (req, res) => {
  const day = new Date().toISOString().slice(0, 10);
  const used = req.user.aiUsage?.day === day ? req.user.aiUsage.count : 0;
  const env = require('../config/env');
  const limit = req.plan === 'premium' ? env.AI_DAILY_LIMIT_PREMIUM : env.AI_DAILY_LIMIT_FREE;
  res.json({ used, limit, remaining: Math.max(0, limit - used), enabled: env.features.ai });
});

router.post('/:feature', limits.ai, asyncHandler(async (req, res) => {
  const feature = ai.FEATURES[req.params.feature];
  if (!feature) return res.status(404).json({ error: 'Unknown AI feature' });
  if (feature.premium && req.plan !== 'premium') {
    return res.status(402).json({ error: 'This AI feature is part of Premium.', code: 'PREMIUM_REQUIRED', upgradeUrl: '/billing' });
  }
  if (!String(req.body.input || '').trim()) return res.status(400).json({ error: 'Nothing to send to the AI' });
  const quota = await ai.consumeQuota(req.user);
  const result = await ai.complete(req.params.feature, req.body);
  return res.json({ ...result, usage: quota });
}));

module.exports = router;
