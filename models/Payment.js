// models/Payment.js — every checkout attempt. Activation is idempotent on `tracker`.
const mongoose = require('mongoose');

const PaymentSchema = new mongoose.Schema({
  user:      { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  provider:  { type: String, default: 'safepay' },
  orderId:   { type: String, required: true, unique: true },
  tracker:   { type: String, index: true, sparse: true },
  plan:      { type: String, enum: ['premium'], required: true },
  interval:  { type: String, enum: ['month', 'year'], required: true },
  amount:    { type: Number, required: true },     // charged amount in `currency`
  currency:  { type: String, required: true },
  amountUsd: { type: Number, required: true },     // list price
  fxRate:    { type: Number, default: 1 },
  status:    { type: String, enum: ['pending', 'paid', 'failed', 'cancelled'], default: 'pending', index: true },
  paidAt:    { type: Date },
  periodStart: { type: Date },
  periodEnd:   { type: Date },
  raw:       { type: mongoose.Schema.Types.Mixed, select: false },
}, { timestamps: true });

module.exports = mongoose.model('Payment', PaymentSchema);
