// models/ConnectionRequest.js — a real request between two Aurelance users.
// Accepting it creates a Connection record in BOTH users' networks.
const mongoose = require('mongoose');

const ConnectionRequestSchema = new mongoose.Schema({
  from:    { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  to:      { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  message: { type: String, default: '', maxlength: 500 },
  status:  { type: String, enum: ['pending', 'accepted', 'rejected', 'cancelled'], default: 'pending' },
  respondedAt: { type: Date },
}, { timestamps: true });

ConnectionRequestSchema.index({ to: 1, status: 1 });
ConnectionRequestSchema.index({ from: 1, status: 1 });
ConnectionRequestSchema.index({ from: 1, to: 1, status: 1 });

module.exports = mongoose.model('ConnectionRequest', ConnectionRequestSchema);
