// models/PayoutMethod.js — how a freelancer gets paid. Account details are encrypted with the vault
// key (AES-256-GCM) and only ever decrypted for the owner, or for one client on one contract the
// owner chose to share it with. Full card numbers are never sent to or stored by Aurelance —
// for cards we keep the brand and last four digits only.
//
// Verification: requires an approved identity check; the account holder name must match it.
// Banks: IBAN checksum (ISO 13616 mod-97) + proof reviewed by an admin.
// Payoneer / Wise: a code sent to the account email + proof reviewed by an admin.
// Cards: a photo of the card with the middle digits covered, reviewed by an admin.
// Proof images are encrypted too and deleted as soon as the review is done.
const mongoose = require('mongoose');

const { Schema } = mongoose;

const Blob = new Schema({ iv: Buffer, tag: Buffer, data: Buffer, type: { type: String } }, { _id: false });

const PayoutMethodSchema = new Schema({
  user:   { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  type:   { type: String, enum: ['bank', 'payoneer', 'wise', 'card'], required: true },
  holderName: { type: String, trim: true, maxlength: 120, required: true },
  country:  { type: String, trim: true, maxlength: 60, default: '' },
  currency: { type: String, trim: true, maxlength: 3, default: 'USD' },

  // Safe to show the owner and in lists: "Meezan Bank ••••4821", "Payoneer · m•••@gmail.com", "Visa ••••4242"
  display:  { type: String, maxlength: 160, required: true },
  brand:    { type: String, maxlength: 30, default: '' },  // bank name, or card brand
  last4:    { type: String, maxlength: 4, default: '' },

  // Encrypted JSON of the full details (IBAN/account number, SWIFT, branch, account email...). Not used for cards.
  secret:   { type: Blob, select: false },

  emailCheck: {
    codeHash: { type: String, select: false },
    expires:  { type: Date, select: false },
    attempts: { type: Number, default: 0, select: false },
    confirmedAt: { type: Date },
  },

  status:   { type: String, enum: ['unverified', 'pending', 'verified', 'rejected'], default: 'unverified', index: true },
  proof:    { type: Blob, select: false },
  proofKind:{ type: String, maxlength: 60, default: '' },
  submittedAt: { type: Date },
  reviewedAt:  { type: Date },
  reviewNote:  { type: String, maxlength: 400, default: '' },
  nameMatches: { type: Boolean, default: false },
  isDefault:   { type: Boolean, default: false },
}, { timestamps: true });

module.exports = mongoose.model('PayoutMethod', PayoutMethodSchema);
