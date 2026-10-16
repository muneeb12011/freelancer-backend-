// models/WorkspaceDoc.js — small per-user JSON documents for tool state
// (brand kit, saved estimates, timer sessions, revenue goal) so it follows the user across devices.
const mongoose = require('mongoose');

const WorkspaceDocSchema = new mongoose.Schema({
  user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  key:  { type: String, required: true },
  data: { type: mongoose.Schema.Types.Mixed, default: null },
}, { timestamps: true, minimize: false });

WorkspaceDocSchema.index({ user: 1, key: 1 }, { unique: true });

module.exports = mongoose.model('WorkspaceDoc', WorkspaceDocSchema);
