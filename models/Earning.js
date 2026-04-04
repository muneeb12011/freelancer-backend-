// models/Earning.js — income + expenses for Atelier
const mongoose = require('mongoose');

const EarningSchema = new mongoose.Schema({
  user:     { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  name:     { type: String, required: true, trim: true },
  amount:   { type: Number, required: true },
  type:     { type: String, enum: ['income','expense'], default: 'income' },
  category: { type: String, default: 'Other' },
  date:     { type: String },
  note:     { type: String, default: '' },
}, { timestamps: true });

EarningSchema.index({ user: 1, type: 1 });

module.exports = mongoose.model('Earning', EarningSchema);
