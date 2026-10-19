// models/Dispute.js — when the two sides of a contract disagree about payment, delivery or scope.
// One side opens it with a statement and evidence, the other has 7 days to respond, an admin decides.
// The outcome is recorded on the contract and counts on both report cards.
const mongoose = require('mongoose');

const { Schema } = mongoose;
const Id = Schema.Types.ObjectId;

const DisputeSchema = new Schema({
  engagement: { type: Id, ref: 'Engagement', required: true, index: true },
  milestone:  { type: Id },
  openedBy:   { type: Id, ref: 'User', required: true },
  against:    { type: Id, ref: 'User', required: true },
  kind:       { type: String, enum: ['payment_not_received', 'work_not_delivered', 'work_not_as_agreed', 'scope', 'other'], required: true },
  statement:  { type: String, trim: true, maxlength: 4000, required: true },
  evidence:   [{ type: Id, ref: 'Attachment' }],
  respondBy:  { type: Date },
  response:   { text: { type: String, maxlength: 4000 }, evidence: [{ type: Id, ref: 'Attachment' }], at: Date },
  status:     { type: String, enum: ['open', 'responded', 'resolved', 'withdrawn'], default: 'open', index: true },
  resolution: {
    outcome: { type: String, enum: ['', 'for_opener', 'for_other', 'shared', 'no_fault'], default: '' },
    note:    { type: String, maxlength: 2000, default: '' },
    by:      { type: Id, ref: 'User' },
    at:      { type: Date },
  },
}, { timestamps: true });

module.exports = mongoose.model('Dispute', DisputeSchema);
