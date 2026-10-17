// models/Report.js — "this looks like a scam" / abuse reports on jobs, people and messages.
const mongoose = require('mongoose');

const ReportSchema = new mongoose.Schema({
  by:      { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  target:  { type: String, enum: ['job', 'user', 'message', 'squad'], required: true },
  targetId:{ type: mongoose.Schema.Types.ObjectId, required: true },
  subject: { type: mongoose.Schema.Types.ObjectId, ref: 'User' }, // the person behind the target
  reason:  { type: String, enum: ['scam', 'off_platform', 'upfront_fee', 'fake', 'abuse', 'spam', 'other'], required: true },
  details: { type: String, trim: true, maxlength: 1500, default: '' },
  status:  { type: String, enum: ['open', 'actioned', 'dismissed'], default: 'open', index: true },
  resolution: { type: String, maxlength: 400, default: '' },
  resolvedAt: { type: Date },
}, { timestamps: true });

ReportSchema.index({ target: 1, targetId: 1, by: 1 }, { unique: true });

module.exports = mongoose.model('Report', ReportSchema);
