// models/Note.js — Atelier Quick Notes
const mongoose = require('mongoose');

const NoteSchema = new mongoose.Schema({
  user:    { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  text:    { type: String, required: true },
  cat:     { type: String, default: 'General' },
  pinned:  { type: Boolean, default: false },
  ts:      { type: String },
}, { timestamps: true });

NoteSchema.index({ user: 1, pinned: -1, createdAt: -1 });

module.exports = mongoose.model('Note', NoteSchema);
