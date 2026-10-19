// models/ProfileView.js — one row per viewer per profile per day, so owners see real reach, not refresh spam.
const mongoose = require('mongoose');

const ProfileViewSchema = new mongoose.Schema({
  profile: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  viewer:  { type: String, required: true, maxlength: 80 }, // user id, or a hashed IP for signed-out visitors
  day:     { type: String, required: true },                // YYYY-MM-DD
  source:  { type: String, enum: ['app', 'public'], default: 'app' },
}, { timestamps: true });

ProfileViewSchema.index({ profile: 1, viewer: 1, day: 1 }, { unique: true });
ProfileViewSchema.index({ profile: 1, day: 1 });

module.exports = mongoose.model('ProfileView', ProfileViewSchema);
