// models/Engagement.js — a contract between a client and a freelancer (shown as "Contract" in the app).
//
// Lifecycle
//   draft     → both sides shape the milestones; any edit clears both signatures.
//   active    → both signed. The scope is locked: milestones can't be edited, only added
//               through an accepted change request.
//   completed → every milestone was paid and confirmed (or the client closed it with nothing owed).
//   ended     → ended early by either side, with a reason.
//
// Milestone flow: open → submitted → approved → paid (client says it paid) → received (freelancer confirms).
// A freelancer can answer "paid" with "not received", which raises a payment dispute on the record.
// Money moves directly between the two; Aurelance keeps the record and builds report cards from it.
const mongoose = require('mongoose');

const { Schema } = mongoose;
const Id = Schema.Types.ObjectId;

const PaymentSchema = new Schema({
  markedAt:    { type: Date },
  method:      { type: String, maxlength: 40, default: '' },   // bank | payoneer | wise | card | other
  reference:   { type: String, maxlength: 120, default: '' },  // transaction / reference number
  proof:       { type: Id, ref: 'Attachment' },
  confirmedAt: { type: Date },
  disputedAt:  { type: Date },
  disputeNote: { type: String, maxlength: 600, default: '' },
}, { _id: false });

const MilestoneSchema = new Schema({
  title:   { type: String, required: true, trim: true, maxlength: 120 },
  scope:   { type: String, trim: true, maxlength: 3000, default: '' }, // what "done" means
  amount:  { type: Number, required: true, min: 0 },
  dueDate: { type: Date },
  status:  { type: String, enum: ['open', 'submitted', 'approved', 'paid', 'received'], default: 'open' },
  source:  { type: String, enum: ['original', 'change'], default: 'original' },
  delivery: {
    note:  { type: String, maxlength: 3000, default: '' },
    files: [{ type: Id, ref: 'Attachment' }],
    at:    { type: Date },
  },
  revisions:  [{ note: { type: String, maxlength: 1500 }, at: Date, _id: false }],
  approvedAt: { type: Date },
  payment:    { type: PaymentSchema, default: () => ({}) },
}, { _id: true });

const ChangeRequestSchema = new Schema({
  by:          { type: Id, ref: 'User', required: true },
  title:       { type: String, required: true, trim: true, maxlength: 120 },
  description: { type: String, trim: true, maxlength: 3000, default: '' },
  amount:      { type: Number, min: 0, required: true },
  dueDate:     { type: Date },
  status:      { type: String, enum: ['pending', 'accepted', 'declined', 'withdrawn'], default: 'pending' },
  decidedAt:   { type: Date },
  milestone:   { type: Id }, // milestone created when accepted
}, { _id: true, timestamps: true });

const SignatureSchema = new Schema({ at: Date, name: { type: String, maxlength: 120 } }, { _id: false });

const EngagementSchema = new Schema({
  client:      { type: Id, ref: 'User', required: true, index: true },
  freelancer:  { type: Id, ref: 'User', required: true, index: true },
  squad:       { type: Id, ref: 'Squad' },
  job:         { type: Id, ref: 'Job' },
  application: { type: Id, ref: 'JobApplication' },
  conversation:{ type: Id, ref: 'Conversation' },

  kind:     { type: String, enum: ['standard', 'trial'], default: 'standard' },
  title:    { type: String, required: true, trim: true, maxlength: 140 },
  summary:  { type: String, trim: true, maxlength: 4000, default: '' },
  currency: { type: String, enum: ['USD', 'PKR', 'EUR', 'GBP', 'AED'], default: 'USD' },

  status:     { type: String, enum: ['draft', 'active', 'completed', 'ended'], default: 'draft', index: true },
  milestones: [MilestoneSchema],
  signatures: { client: SignatureSchema, freelancer: SignatureSchema },
  signedAt:   { type: Date },
  termsVersion: { type: Number, default: 1 },

  changeRequests: [ChangeRequestSchema],

  // Payout method the freelancer chose to show this client (details decrypted only for the two of them).
  sharedPayout: { method: { type: Id, ref: 'PayoutMethod' }, at: Date, viewedAt: Date },

  completedAt: { type: Date },
  endedAt:     { type: Date },
  endedBy:     { type: Id, ref: 'User' },
  endReason:   { type: String, maxlength: 600, default: '' },

  // Reviews open when the contract finishes; both are revealed together (or when the window closes).
  reviewWindowEndsAt: { type: Date },

  events: [{ at: { type: Date, default: Date.now }, by: { type: Id, ref: 'User' }, text: { type: String, maxlength: 300 }, _id: false }],
  lastReminderAt: { type: Date },
}, { timestamps: true });

EngagementSchema.index({ client: 1, status: 1, updatedAt: -1 });
EngagementSchema.index({ freelancer: 1, status: 1, updatedAt: -1 });

EngagementSchema.methods.log = function log(by, text) {
  this.events.push({ by, text: String(text).slice(0, 300), at: new Date() });
  if (this.events.length > 200) this.events = this.events.slice(-200);
};

EngagementSchema.methods.roleOf = function roleOf(userId) {
  const id = String(userId);
  if (String(this.client) === id) return 'client';
  if (String(this.freelancer) === id) return 'freelancer';
  return null;
};

EngagementSchema.virtual('total').get(function total() {
  return (this.milestones || []).reduce((s, m) => s + (m.amount || 0), 0);
});

module.exports = mongoose.model('Engagement', EngagementSchema);
