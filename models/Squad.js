// models/Squad.js — 2 to 5 freelancers who apply to bigger jobs together under one profile.
// The lead applies and signs; every active member is listed on the application and contract.
const mongoose = require('mongoose');

const { Schema } = mongoose;

const MemberSchema = new Schema({
  user:     { type: Schema.Types.ObjectId, ref: 'User', required: true },
  role:     { type: String, trim: true, maxlength: 60, default: '' }, // e.g. "UI design"
  status:   { type: String, enum: ['invited', 'active'], default: 'invited' },
  invitedBy:{ type: Schema.Types.ObjectId, ref: 'User' },
  joinedAt: { type: Date },
}, { _id: false, timestamps: true });

const SquadSchema = new Schema({
  name:    { type: String, required: true, trim: true, minlength: 3, maxlength: 60 },
  tagline: { type: String, trim: true, maxlength: 140, default: '' },
  about:   { type: String, trim: true, maxlength: 2000, default: '' },
  skills:  [{ type: String, trim: true, maxlength: 40 }],
  lead:    { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  members: [MemberSchema],
  hourlyRate: { type: Number, min: 0, default: 0 },
  availability: { type: String, enum: ['available', 'busy'], default: 'available' },
}, { timestamps: true });

SquadSchema.index({ 'members.user': 1 });
SquadSchema.index({ skills: 1 });

SquadSchema.statics.MAX_MEMBERS = 5;

SquadSchema.methods.activeIds = function activeIds() {
  return this.members.filter((m) => m.status === 'active').map((m) => String(m.user));
};

module.exports = mongoose.model('Squad', SquadSchema);
