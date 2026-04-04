// models/Proposal.js
const mongoose = require('mongoose');

const ProposalSchema = new mongoose.Schema({
  user:         { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  title:        { type: String, required: true, trim: true },
  client:       { type: String, default: '' },
  overview:     { type: String, default: '' },
  scope:        { type: String, default: '' },
  deliverables: { type: String, default: '' },
  timeline:     { type: String, default: '' },
  price:        { type: String, default: '' },
  terms:        { type: String, default: '' },
  status:       { type: String, enum: ['draft','sent','accepted','declined'], default: 'draft' },
}, { timestamps: true });

ProposalSchema.index({ user: 1 });

module.exports = mongoose.model('Proposal', ProposalSchema);
