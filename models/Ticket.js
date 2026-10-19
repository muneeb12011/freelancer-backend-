// models/Ticket.js — support tickets + messages from the contact form.
const mongoose = require('mongoose');

const ReplySchema = new mongoose.Schema({
  from: { type: String, enum: ['user', 'support'], default: 'user' },
  text: { type: String, required: true, maxlength: 5000 },
  by:   { type: mongoose.Schema.Types.ObjectId, ref: 'User' },  // the admin who answered
}, { timestamps: true });

const TicketSchema = new mongoose.Schema({
  user:     { type: mongoose.Schema.Types.ObjectId, ref: 'User', index: true },
  number:   { type: String, required: true, unique: true },
  name:     { type: String, default: '' },
  email:    { type: String, required: true, lowercase: true, trim: true },
  subject:  { type: String, required: true, maxlength: 200 },
  message:  { type: String, required: true, maxlength: 5000 },
  category: { type: String, default: 'General', maxlength: 60 },
  priority: { type: String, enum: ['low', 'normal', 'high', 'urgent'], default: 'normal' },
  source:   { type: String, enum: ['app', 'contact'], default: 'app' },
  status:   { type: String, enum: ['open', 'in-progress', 'resolved', 'closed'], default: 'open' },
  replies:  [ReplySchema],
  // What it's about: one of the person's contracts, and which situation they picked.
  topic:    { type: String, enum: ['payment', 'contract', 'dispute', 'scam', 'account', 'payout', 'bug', 'other'], default: 'other' },
  engagement: { type: mongoose.Schema.Types.ObjectId, ref: 'Engagement' },
  // Whose turn it is, and when support first answered (for the measured reply time).
  awaiting: { type: String, enum: ['support', 'user', 'none'], default: 'support', index: true },
  firstResponseAt: { type: Date },
  lastActivityAt:  { type: Date, default: Date.now },
  solvedBy: { type: String, enum: ['', 'user', 'support'], default: '' },
}, { timestamps: true });

TicketSchema.index({ status: 1, awaiting: 1, lastActivityAt: -1 });

TicketSchema.index({ user: 1, createdAt: -1 });

module.exports = mongoose.model('Ticket', TicketSchema);
