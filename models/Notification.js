// models/Notification.js — the in-app inbox behind the bell. One row per thing that happened to you.
const mongoose = require('mongoose');

const NotificationSchema = new mongoose.Schema({
  user:  { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  type:  { type: String, required: true, maxlength: 40 },   // e.g. application.new, contract.signed, payment.marked
  title: { type: String, required: true, maxlength: 160 },
  body:  { type: String, maxlength: 400, default: '' },
  link:  { type: String, maxlength: 300, default: '' },      // in-app path
  actor: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  readAt:{ type: Date },
}, { timestamps: true });

NotificationSchema.index({ user: 1, createdAt: -1 });
NotificationSchema.index({ user: 1, readAt: 1 });

module.exports = mongoose.model('Notification', NotificationSchema);
