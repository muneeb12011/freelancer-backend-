// models/User.js
const mongoose = require('mongoose');
const bcrypt   = require('bcryptjs');

const { Schema } = mongoose;

// Flexible profile list items (projects, services, experience, education).
// strict:false keeps the UI free to add fields; size is bounded in the profile route.
const ListItem = new Schema({}, { strict: false, _id: true });

const lower = (v) => (typeof v === 'string' ? v.toLowerCase() : v);

const DEFAULT_NOTIFICATIONS = {
  emailDigest: true, taskReminders: true, invoiceAlerts: true, connectionReqs: true,
  clientMessages: true, jobAlerts: true, marketingEmails: false, paymentReceived: true, overdueAlerts: true,
};

const UserSchema = new Schema({
  name:         { type: String, required: true, trim: true, maxlength: 80 },
  email:        { type: String, required: true, unique: true, lowercase: true, trim: true, maxlength: 254 },
  password:     { type: String, minlength: 8, select: false }, // optional for OAuth users
  emailVerified:{ type: Boolean, default: false },

  // OAuth
  googleId:     { type: String, default: '', index: true },
  githubId:     { type: String, default: '', index: true },
  authProvider: { type: String, enum: ['local', 'google', 'github'], default: 'local' },

  // Bumped on password change/reset → invalidates every issued session.
  tokenVersion: { type: Number, default: 0 },

  // Profile
  avatar:       { type: String, default: '' },
  title:        { type: String, default: '', maxlength: 120 },
  bio:          { type: String, default: '', maxlength: 2000 },
  phone:        { type: String, default: '', maxlength: 40 },
  location:     { type: String, default: '', maxlength: 120 },
  website:      { type: String, default: '', maxlength: 300 },
  linkedin:     { type: String, default: '', maxlength: 300 },
  github:       { type: String, default: '', maxlength: 300 },
  twitter:      { type: String, default: '', maxlength: 300 },
  socialLinks:  { type: Schema.Types.Mixed, default: {} },
  projects:     [ListItem],
  services:     [ListItem],
  experience:   [ListItem],
  education:    [ListItem],

  // Work
  hourlyRate:   { type: Number, default: 0, min: 0 },
  minProject:   { type: Number, default: 0, min: 0 },
  availability: { type: String, default: 'available', set: lower, maxlength: 20 },
  skills:       [{ type: String, trim: true, maxlength: 40 }],
  languages:    [{ type: String, trim: true, maxlength: 40 }],
  discoverable: { type: Boolean, default: true }, // shows up in network search / suggestions
  // Public profile at /u/:handle — lowercase letters, digits and dashes.
  handle:       { type: String, lowercase: true, trim: true, maxlength: 30, index: { unique: true, sparse: true } },
  hoursPerWeek: { type: Number, min: 0, max: 80, default: 0 },
  intent:       { type: String, enum: ['work', 'hire', 'both'], default: 'both' }, // what they came for; shapes Home
  workingHours: { start: { type: String, default: '' }, end: { type: String, default: '' } }, // "09:00" in their own timezone
  langs:        [{ name: { type: String, maxlength: 40 }, level: { type: String, enum: ['Basic', 'Conversational', 'Fluent', 'Native'], default: 'Fluent' }, _id: false }],
  intro:        { type: String, default: '', maxlength: 300 }, // link to a short intro video (YouTube / Loom)
  // Who can see email + phone on the public profile. Default: only people with a signed contract.
  contactVisibility: { type: String, enum: ['nobody', 'contracts', 'connections'], default: 'contracts' },

  // Plan — `plan` is only ever written by the billing service, never by user input.
  plan:          { type: String, enum: ['free', 'premium'], default: 'free' },
  planInterval:  { type: String, enum: ['month', 'year', ''], default: '' },
  planExpiresAt: { type: Date },
  planCancelAtPeriodEnd: { type: Boolean, default: false },
  planReminderFor: { type: Date }, // planExpiresAt value we last sent a renewal reminder for

  // Password reset (hashed token)
  resetPasswordToken:  { type: String, select: false },
  resetPasswordExpiry: { type: Date,   select: false },

  // Email change (hashed token)
  pendingEmail:        { type: String, select: false },
  emailChangeToken:    { type: String, select: false },
  emailChangeExpiry:   { type: Date,   select: false },

  // Email verification (hashed token)
  verifyToken:         { type: String, select: false },
  verifyExpiry:        { type: Date,   select: false },

  // Two-factor (email one-time code)
  twoFactor: {
    enabled:  { type: Boolean, default: false },
    codeHash: { type: String, select: false },
    expires:  { type: Date, select: false },
    attempts: { type: Number, default: 0, select: false },
  },
  loginAlerts: { type: Boolean, default: true },

  // Preferences
  notifications: { type: Schema.Types.Mixed, default: () => ({ ...DEFAULT_NOTIFICATIONS }) },
  preferences: {
    language:   { type: String, default: 'en' },
    timezone:   { type: String, default: 'UTC' },
    currency:   { type: String, default: 'USD' },
    dateFormat: { type: String, default: 'MM/DD/YYYY' },
  },

  // AI quota
  aiUsage: { day: { type: String, default: '' }, count: { type: Number, default: 0 } },

  referredBy:  { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  blockedUsers: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
  savedJobs:    [{ type: mongoose.Schema.Types.ObjectId, ref: 'Job' }],
  // Identity verification (documents live in IdentityVerification, encrypted, and are purged after review)
  identity: {
    status:      { type: String, enum: ['none', 'pending', 'approved', 'rejected'], default: 'none' },
    submittedAt: { type: Date },
    reviewedAt:  { type: Date },
    note:        { type: String, default: '' },
  },
  // Usage counters for plan limits
  usage: {
    month:        { type: String, default: '' }, // YYYY-MM
    applications: { type: Number, default: 0 },
  },
  lastLoginAt: { type: Date },
  // Report cards — recomputed by services/reputation.js whenever something that feeds them changes.
  reputation: { type: mongoose.Schema.Types.Mixed, default: {} },
  payoutTypes: [{ type: String }], // verified payout types, e.g. ['bank','payoneer'] — public, no details
  // Work email: proves someone can read mail at a company domain (gmail & co. don't count).
  // Only the domain is ever shown to others; the address stays private.
  workEmail: {
    address:    { type: String, lowercase: true, trim: true, default: '' },
    domain:     { type: String, lowercase: true, default: '' },
    verifiedAt: { type: Date },
    pending:    { type: String, lowercase: true, trim: true, default: '', select: false },
    codeHash:   { type: String, select: false },
    expires:    { type: Date, select: false },
    attempts:   { type: Number, default: 0, select: false },
  },
}, { timestamps: true });

UserSchema.index({ discoverable: 1, skills: 1 });

// Effective plan — premium lapses automatically when the paid period ends.
UserSchema.virtual('effectivePlan').get(function effectivePlan() {
  if (this.plan !== 'premium') return 'free';
  if (this.planExpiresAt && this.planExpiresAt.getTime() < Date.now()) return 'free';
  return 'premium';
});

UserSchema.pre('save', async function hashPassword() {
  if (!this.isModified('password') || !this.password) return;
  this.password = await bcrypt.hash(this.password, 12);
});

/** Public trust signals shown next to a name. */
UserSchema.methods.badges = function badges() {
  return {
    email: Boolean(this.emailVerified),
    identity: this.identity?.status === 'approved',
    linked: Boolean(this.googleId || this.githubId),
    premium: this.effectivePlan === 'premium',
    payout: (this.payoutTypes || []).length > 0,
    work: this.workEmail?.verifiedAt ? this.workEmail.domain : '',
  };
};

UserSchema.methods.matchPassword = async function matchPassword(plain) {
  if (!this.password || !plain) return false;
  return bcrypt.compare(String(plain), this.password);
};

/** The user object the frontend receives. Never includes secrets. */
UserSchema.methods.toClient = function toClient() {
  return {
    _id: this._id,
    name: this.name,
    email: this.email,
    emailVerified: this.emailVerified,
    authProvider: this.authProvider,
    avatar: this.avatar,
    title: this.title,
    bio: this.bio,
    phone: this.phone,
    location: this.location,
    website: this.website,
    linkedin: this.linkedin,
    github: this.github,
    twitter: this.twitter,
    socialLinks: this.socialLinks || {},
    projects: this.projects,
    services: this.services,
    experience: this.experience,
    education: this.education,
    hourlyRate: this.hourlyRate,
    minProject: this.minProject,
    availability: this.availability,
    skills: this.skills,
    languages: this.languages,
    discoverable: this.discoverable,
    contactVisibility: this.contactVisibility || 'contracts',
    handle: this.handle || '',
    intent: this.intent || 'both',
    hoursPerWeek: this.hoursPerWeek || 0,
    workingHours: this.workingHours || {},
    langs: this.langs || [],
    intro: this.intro || '',
    timezone: this.preferences?.timezone || 'UTC',
    plan: this.effectivePlan,
    planInterval: this.planInterval,
    planExpiresAt: this.planExpiresAt,
    planCancelAtPeriodEnd: this.planCancelAtPeriodEnd,
    twoFactorEnabled: Boolean(this.twoFactor?.enabled),
    loginAlerts: this.loginAlerts,
    notifications: { ...DEFAULT_NOTIFICATIONS, ...(this.notifications || {}) },
    preferences: this.preferences,
    badges: this.badges(),
    identity: { status: this.identity?.status || 'none', submittedAt: this.identity?.submittedAt, reviewedAt: this.identity?.reviewedAt, note: this.identity?.note || '' },
    savedJobs: this.savedJobs || [],
    reputation: this.reputation || {},
    payoutTypes: this.payoutTypes || [],
    isAdmin: require('../config/env').ADMIN_EMAILS.includes(String(this.email).toLowerCase()),
    createdAt: this.createdAt,
  };
};

/** What other users can see (network search, public profile). */
UserSchema.methods.toPublic = function toPublic() {
  return {
    _id: this._id,
    name: this.name,
    photo: this.avatar,
    avatar: this.avatar,
    title: this.title,
    role: this.title,
    bio: this.bio,
    location: this.location,
    website: this.website,
    socialLinks: this.socialLinks || {},
    projects: this.projects,
    services: this.services,
    experience: this.experience,
    education: this.education,
    hourlyRate: this.hourlyRate,
    availability: this.availability,
    skills: this.skills,
    languages: this.languages,
    badges: this.badges(),
    reputation: this.reputation || {},
    payoutTypes: this.payoutTypes || [],
    handle: this.handle || '',
    hoursPerWeek: this.hoursPerWeek || 0,
    workingHours: this.workingHours || {},
    langs: this.langs || [],
    intro: this.intro || '',
    timezone: this.preferences?.timezone || 'UTC',
    lastActiveAt: this.lastLoginAt,
    createdAt: this.createdAt,
  };
};

UserSchema.statics.DEFAULT_NOTIFICATIONS = DEFAULT_NOTIFICATIONS;

module.exports = mongoose.model('User', UserSchema);
