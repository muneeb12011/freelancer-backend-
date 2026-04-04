// models/Connection.js
const mongoose = require('mongoose');

const MessageSchema = new mongoose.Schema({
  sender:    { type: String, enum: ['me','them'], required: true },
  text:      { type: String, required: true },
  createdAt: { type: Date, default: Date.now },
});

const ConnectionSchema = new mongoose.Schema({
  user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },

  // Identity
  name:         { type: String, required: true, trim: true },
  role:         { type: String, trim: true },
  email:        { type: String, trim: true, lowercase: true },
  phone:        { type: String, trim: true },
  location:     { type: String, trim: true },
  avatar:       { type: String, default: '' },
  bio:          { type: String, default: '' },
  skills:       [{ type: String, trim: true }],
  rate:         { type: Number, default: 0 },

  // CRM
  status:       { type: String, enum: ['connected','pending','declined'], default: 'connected' },
  availability: { type: String, enum: ['Available','Busy','Away'], default: 'Available' },
  tag:          { type: String, enum: ['Hot Lead','Collaborator','Client','Mentor','Partner','Prospect',''], default: '' },
  pinned:       { type: Boolean, default: false },
  favorite:     { type: Boolean, default: false },
  note:         { type: String, default: '' },
  groups:       [{ type: String }],

  // Stats
  rating:           { type: Number, default: 0, min: 0, max: 5 },
  mutualConnections: { type: Number, default: 0 },
  strength:         { type: Number, default: 1, min: 1, max: 5 },
  lastInteraction:  { type: Date },

  // Collab
  collabStatus: { type: String, enum: ['none','pending','accepted','declined'], default: 'none' },
  collabProject:{ type: String, default: '' },

  // Chat
  messages: [MessageSchema],
}, { timestamps: true });

ConnectionSchema.index({ user: 1 });

module.exports = mongoose.model('Connection', ConnectionSchema);
