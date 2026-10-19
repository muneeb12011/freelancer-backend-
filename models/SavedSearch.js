// models/SavedSearch.js — a job search someone wants to hear about. The daily cron emails new matches.
const mongoose = require('mongoose');

const SavedSearchSchema = new mongoose.Schema({
  user:   { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  name:   { type: String, trim: true, maxlength: 80, required: true },
  q:      { type: String, trim: true, maxlength: 120, default: '' },
  category:   { type: String, maxlength: 40, default: '' },
  skills:     [{ type: String, trim: true, maxlength: 40 }],
  budgetType: { type: String, enum: ['', 'fixed', 'hourly'], default: '' },
  minBudget:  { type: Number, min: 0, default: 0 },
  kind:       { type: String, enum: ['', 'standard', 'trial'], default: '' },
  reliable:   { type: Boolean, default: false },
  email:      { type: Boolean, default: true },
  lastRunAt:  { type: Date, default: Date.now },
  lastCount:  { type: Number, default: 0 },
}, { timestamps: true });

module.exports = mongoose.model('SavedSearch', SavedSearchSchema);
