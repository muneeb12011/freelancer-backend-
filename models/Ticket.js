// models/Ticket.js — support tickets + messages from the contact form.
const mongoose = require('mongoose');

const ReplySchema = new mongoose.Schema({
  from: { type: String, enum: ['user', 'support'], default: 'user' },
  text: { type: String, required: true, maxlength: 5000 },
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
}, { timestamps: true });

TicketSchema.index({ user: 1, createdAt: -1 });

module.exports = mongoose.model('Ticket', TicketSchema);
