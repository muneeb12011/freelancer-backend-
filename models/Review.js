// models/Review.js — written after a contract finishes. Two directions:
//   of_freelancer : the client rates the work           (quality, communication, deadlines)
//   of_client     : the freelancer rates the client     (payment, scope, communication, respect)
// Double-blind: neither side sees the other's review until both are in or the 14-day window ends,
// so nobody can retaliate against an honest review.
const mongoose = require('mongoose');

const { Schema } = mongoose;
const score = { type: Number, min: 1, max: 5, required: true };

const ReviewSchema = new Schema({
  engagement: { type: Schema.Types.ObjectId, ref: 'Engagement', required: true },
  from:       { type: Schema.Types.ObjectId, ref: 'User', required: true },
  to:         { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  direction:  { type: String, enum: ['of_freelancer', 'of_client'], required: true },
  ratings: {
    quality: { type: Number, min: 1, max: 5 },
    deadlines: { type: Number, min: 1, max: 5 },
    payment: { type: Number, min: 1, max: 5 },
    scope: { type: Number, min: 1, max: 5 },
    respect: { type: Number, min: 1, max: 5 },
    communication: score,
  },
  wouldWorkAgain: { type: Boolean, default: true },
  comment:   { type: String, trim: true, maxlength: 1500, default: '' },
  visibleAt: { type: Date, index: true }, // null until revealed
}, { timestamps: true });

ReviewSchema.index({ engagement: 1, from: 1 }, { unique: true });
ReviewSchema.index({ to: 1, direction: 1, visibleAt: 1 });

module.exports = mongoose.model('Review', ReviewSchema);
