// models/OAuthCode.js — short-lived, single-use code handed to the frontend after OAuth.
// Keeps the JWT out of the browser URL / history / referrer headers.
const mongoose = require('mongoose');

const OAuthCodeSchema = new mongoose.Schema({
  codeHash: { type: String, required: true, unique: true },
  token:    { type: String, required: true },
  user:     { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  expiresAt:{ type: Date, required: true },
});
OAuthCodeSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

module.exports = mongoose.model('OAuthCode', OAuthCodeSchema);
