// models/Client.js
const mongoose = require('mongoose');

const ClientSchema = new mongoose.Schema({
  user:           { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },

  // Basic info
  name:           { type: String, required: true, trim: true },
  email:          { type: String, trim: true, lowercase: true },
  phone:          { type: String, trim: true },
  company:        { type: String, trim: true },
  website:        { type: String, trim: true },
  address:        { type: String, trim: true },

  // CRM
  status:         { type: String, enum: ['Active','In Progress','Lead','On Hold','Completed'], default: 'Lead' },
  priority:       { type: String, enum: ['High','Normal','Low'], default: 'Normal' },
  source:         { type: String, trim: true },
  tags:           [{ type: String, trim: true }],
  notes:          { type: String, default: '' },
  favorite:       { type: Boolean, default: false },

  // Financial
  hourlyRate:     { type: Number, default: 0 },
  projectBudget:  { type: Number, default: 0 },
  contractValue:  { type: Number, default: 0 },
  contractStatus: { type: String, enum: ['Active','Pending','Expired','None'], default: 'None' },
  contractExpiry: { type: Date },

  // Computed — updated by invoice/task hooks
  revenue:        { type: Number, default: 0 },
  outstanding:    { type: Number, default: 0 },
  invoiceCount:   { type: Number, default: 0 },
  paidInvoices:   { type: Number, default: 0 },
  lastActivity:   { type: Date },
}, { timestamps: true });

// Index for fast user queries
ClientSchema.index({ user: 1, status: 1 });
ClientSchema.index({ user: 1, name: 1 });

module.exports = mongoose.model('Client', ClientSchema);
