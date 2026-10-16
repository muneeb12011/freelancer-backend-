// models/IdentityVerification.js — one submission per attempt. Images are AES-256-GCM encrypted
// and wiped (`purgedAt`) as soon as an admin approves or rejects, leaving only the decision.
const mongoose = require('mongoose');

const Blob = new mongoose.Schema({
  iv: Buffer, tag: Buffer, data: Buffer, type: { type: String },
}, { _id: false });

const IdentityVerificationSchema = new mongoose.Schema({
  user:      { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  fullName:  { type: String, required: true, maxlength: 120 },
  country:   { type: String, required: true, maxlength: 60 },
  docType:   { type: String, enum: ['cnic', 'passport', 'driving_license', 'national_id'], required: true },
  front:     { type: Blob, select: false },
  back:      { type: Blob, select: false },
  selfie:    { type: Blob, select: false },
  status:    { type: String, enum: ['pending', 'approved', 'rejected'], default: 'pending', index: true },
  reviewer:  { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  reviewedAt:{ type: Date },
  reason:    { type: String, maxlength: 500, default: '' },
  purgedAt:  { type: Date },
}, { timestamps: true });

module.exports = mongoose.model('IdentityVerification', IdentityVerificationSchema);
