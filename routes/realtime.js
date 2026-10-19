// routes/realtime.js — what the browser needs for instant updates.
//   GET  /api/realtime/config   { enabled, key?, cluster? }  (public key only)
//   POST /api/realtime/auth     { socket_id, channel_name } → { auth }  — your own channel only
const router = require('express').Router();
const realtime = require('../services/realtime');
const { protect } = require('../middleware/auth');
const { asyncHandler, forbidden } = require('../utils/http');

router.get('/config', (req, res) => res.json(realtime.publicConfig()));

router.post('/auth', protect, asyncHandler(async (req, res) => {
  const signed = realtime.authorize(req.user._id, req.body.socket_id, req.body.channel_name);
  if (!signed) throw forbidden('You can only listen to your own updates');
  res.json(signed);
}));

module.exports = router;
