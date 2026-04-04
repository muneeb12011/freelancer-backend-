// models/User.js
const mongoose = require('mongoose');
const bcrypt   = require('bcryptjs');

const UserSchema = new mongoose.Schema({
  name:         { type: String, required: true, trim: true },
  email:        { type: String, required: true, unique: true, lowercase: true, trim: true },
  password:     { type: String, required: true, minlength: 6, select: false },

  // Profile
  avatar:       { type: String, default: '' },
  title:        { type: String, default: '' },
  bio:          { type: String, default: '' },
  phone:        { type: String, default: '' },
  location:     { type: String, default: '' },
  website:      { type: String, default: '' },
  linkedin:     { type: String, default: '' },
  github:       { type: String, default: '' },
  twitter:      { type: String, default: '' },

  // Work
  hourlyRate:   { type: Number, default: 0 },
  minProject:   { type: Number, default: 0 },
  availability: { type: String, enum: ['Available','Busy','Away'], default: 'Available' },
  skills:       [{ type: String, trim: true }],
  languages:    [{ type: String, trim: true }],

  // Plan
  plan:         { type: String, enum: ['free','premium'], default: 'free' },

  // Password reset
  resetPasswordToken:  { type: String, select: false },
  resetPasswordExpiry: { type: Date,   select: false },

  // Notifications
  notifications: {
    emailNewMessage:  { type: Boolean, default: true },
    emailInvoicePaid: { type: Boolean, default: true },
    emailNewTask:     { type: Boolean, default: false },
    inAppAll:         { type: Boolean, default: true },
  },
}, { timestamps: true });

// Hash password before save
UserSchema.pre('save', async function (next) {
  if (!this.isModified('password')) return next();
  this.password = await bcrypt.hash(this.password, 12);
  next();
});

// Compare password
UserSchema.methods.matchPassword = async function (plain) {
  return bcrypt.compare(plain, this.password);
};

module.exports = mongoose.model('User', UserSchema);