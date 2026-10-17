// models/Job.js — a job posted on the Aurelance jobs board.
const mongoose = require('mongoose');

const CATEGORIES = ['Development', 'Design', 'Writing', 'Marketing', 'Video & Audio', 'Data & AI', 'Admin & Support', 'Finance', 'Other'];

const JobSchema = new mongoose.Schema({
  postedBy:   { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  title:      { type: String, required: true, trim: true, minlength: 8, maxlength: 120 },
  description:{ type: String, required: true, minlength: 50, maxlength: 8000 },
  category:   { type: String, enum: CATEGORIES, default: 'Other' },
  skills:     [{ type: String, trim: true, maxlength: 40 }],
  budgetType: { type: String, enum: ['fixed', 'hourly'], default: 'fixed' },
  budgetMin:  { type: Number, min: 0, default: 0 },
  budgetMax:  { type: Number, min: 0, default: 0 },
  currency:   { type: String, enum: ['USD', 'PKR', 'EUR', 'GBP', 'AED'], default: 'USD' },
  duration:   { type: String, enum: ['< 1 week', '1–4 weeks', '1–3 months', '3+ months', 'Ongoing'], default: '1–4 weeks' },
  experience: { type: String, enum: ['Entry', 'Intermediate', 'Expert'], default: 'Intermediate' },
  locationType: { type: String, enum: ['remote', 'onsite', 'hybrid'], default: 'remote' },
  location:   { type: String, trim: true, maxlength: 120, default: '' },
  applyBy:    { type: Date },
  status:     { type: String, enum: ['open', 'closed', 'filled', 'review'], default: 'open', index: true },
  // Paid trial: a small, paid test task. The client can start trials with several applicants.
  kind:       { type: String, enum: ['standard', 'trial'], default: 'standard' },
  trialSlots: { type: Number, min: 1, max: 10, default: 3 },
  // Scam shield verdict: clear · warn (shown with a caution) · held (waits for admin review)
  safety: {
    score:  { type: Number, default: 0 },
    flags:  [{ code: String, label: String, tip: String, _id: false }],
    verdict:{ type: String, enum: ['clear', 'warn', 'held'], default: 'clear' },
    reviewedAt: { type: Date },
  },
  // No-ghosting: the last time the poster looked at or answered applicants.
  posterActiveAt: { type: Date },
  closedReason: { type: String, enum: ['', 'poster', 'filled', 'no_response', 'removed'], default: '' },
  reminderSentAt: { type: Date },
  applicationsCount: { type: Number, default: 0 },
  views:      { type: Number, default: 0 },
  hired:      [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
}, { timestamps: true });

JobSchema.index({ status: 1, createdAt: -1 });
JobSchema.index({ status: 1, category: 1, createdAt: -1 });
JobSchema.index({ skills: 1 });

JobSchema.statics.CATEGORIES = CATEGORIES;

module.exports = mongoose.model('Job', JobSchema);
