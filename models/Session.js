// models/Session.js — one row per signed-in device. JWTs carry the session id (sid),
// so a session can be revoked server-side ("sign out other devices").
const mongoose = require('mongoose');

const SessionSchema = new mongoose.Schema({
  user:       { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  userAgent:  { type: String, default: '' },
  device:     { type: String, default: '' },
  ip:         { type: String, default: '' },
  method:     { type: String, default: 'password' }, // password | google | github | 2fa
  lastSeenAt: { type: Date, default: Date.now },
  revokedAt:  { type: Date },
  expiresAt:  { type: Date, required: true },
}, { timestamps: true });

// Mongo deletes expired sessions automatically.
SessionSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

module.exports = mongoose.model('Session', SessionSchema);
