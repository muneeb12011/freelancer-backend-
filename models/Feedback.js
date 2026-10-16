// models/Feedback.js — NPS ratings, FAQ votes and newsletter sign-ups.
const mongoose = require('mongoose');

const FeedbackSchema = new mongoose.Schema({
  user:     { type: mongoose.Schema.Types.ObjectId, ref: 'User', index: true },
  kind:     { type: String, enum: ['nps', 'faq', 'newsletter'], required: true, index: true },
  nps:      { type: Number, min: 0, max: 10 },
  aspects:  { type: mongoose.Schema.Types.Mixed },
  comment:  { type: String, maxlength: 2000, default: '' },
  category: { type: String, default: '' },
  faqId:    { type: String },
  helpful:  { type: Boolean },
  email:    { type: String, lowercase: true, trim: true },
}, { timestamps: true });

FeedbackSchema.index({ kind: 1, email: 1 }, { unique: true, partialFilterExpression: { kind: 'newsletter' } });

module.exports = mongoose.model('Feedback', FeedbackSchema);
