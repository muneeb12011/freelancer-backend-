// models/Contract.js
const mongoose = require('mongoose');

const ContractSchema = new mongoose.Schema({
  user:      { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  title:     { type: String, required: true, trim: true },
  content:   { type: String, default: '' },
  status:    { type: String, enum: ['draft','sent','signed','expired'], default: 'draft' },
  signed:    { type: Boolean, default: false },
  signedAt:  { type: Date },
  client:    { type: String, default: '' },
}, { timestamps: true });

ContractSchema.index({ user: 1 });

module.exports = mongoose.model('Contract', ContractSchema);
