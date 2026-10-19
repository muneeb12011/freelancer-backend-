// models/Conversation.js — a one-to-one thread between two users.
const mongoose = require('mongoose');

const ConversationSchema = new mongoose.Schema({
  participants: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true }],
  // Sorted "idA:idB" — guarantees one conversation per pair.
  pairKey: { type: String, required: true, unique: true },
  lastMessage: {
    text:   { type: String, default: '' },
    sender: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    at:     { type: Date },
  },
  // userId → unread count (kept per participant)
  unread: { type: Map, of: Number, default: {} },
  // userId → last time that user emailed about this thread (notification throttle)
  notifiedAt: { type: Map, of: Date, default: {} },
  job: { type: mongoose.Schema.Types.ObjectId, ref: 'Job' }, // set when started from a job application
  archivedBy: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
  // "Verify on a call": who confirmed the other person read out the same rotating code, and when.
  callChecks: [{ by: { type: mongoose.Schema.Types.ObjectId, ref: 'User' }, of: { type: mongoose.Schema.Types.ObjectId, ref: 'User' }, at: Date, _id: false }],
  // userId → last time they asked the other person to verify (throttle)
  verifyAskedAt: { type: Map, of: Date, default: {} },
}, { timestamps: true });

ConversationSchema.index({ participants: 1, updatedAt: -1 });

ConversationSchema.statics.keyFor = (a, b) => [String(a), String(b)].sort().join(':');

module.exports = mongoose.model('Conversation', ConversationSchema);
