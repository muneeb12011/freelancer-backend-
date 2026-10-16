// models/Task.js — Complete production schema
const mongoose = require('mongoose');
const { Schema } = mongoose;
require('./Counter');

// ── Sub-schemas ──────────────────────────────────────────────
const SubtaskSchema = new Schema({
  title:     { type: String, required: true, trim: true },
  done:      { type: Boolean, default: false },
  doneAt:    { type: Date },
  order:     { type: Number, default: 0 },
}, { _id: true, timestamps: false });

const CommentSchema = new Schema({
  text:      { type: String, required: true },
  author:    { type: String, default: 'You' },
}, { timestamps: true });

const ActivitySchema = new Schema({
  text:      { type: String, required: true },
}, { timestamps: true });

const TimeEntrySchema = new Schema({
  minutes:   { type: Number, required: true, min: 1 },
  note:      { type: String, default: '' },
  loggedAt:  { type: Date, default: Date.now },
}, { _id: true });

// ── Main schema ──────────────────────────────────────────────
const TaskSchema = new Schema({
  user:      { type: Schema.Types.ObjectId, ref: 'User', required: true },
  client:    { type: Schema.Types.ObjectId, ref: 'Client' },

  // Identity
  taskNumber: { type: String },           // TK-0001 — set by pre-save hook
  title:      { type: String, required: true, trim: true },
  description:{ type: String, default: '' },

  // Classification
  status:    { type: String, enum: ['todo','in-progress','review','done'], default: 'todo' },
  priority:  { type: String, enum: ['Low','Medium','High','Urgent'], default: 'Medium' },
  category:  { type: String, default: 'General' },
  tags:      [{ type: String, trim: true }],

  // Dates
  deadline:  { type: Date },
  completedAt:{ type: Date },
  completed:  { type: Boolean, default: false },
  stateChangedAt:{ type: Date },          // for aging (days in current status)

  // Sprint / Milestone
  sprint:    { type: String, default: '' },
  milestone: { type: String, default: '' },

  // Recurring
  recurring:      { type: Boolean, default: false },
  recurringFreq:  { type: String, enum: ['daily','weekly','biweekly','monthly',''], default: '' },

  // Dependencies
  blockedBy:  [{ type: Schema.Types.ObjectId, ref: 'Task' }],
  blocks:     [{ type: Schema.Types.ObjectId, ref: 'Task' }],

  // Time tracking
  estimatedHours: { type: Number, default: 0 },
  trackedMinutes: { type: Number, default: 0 },   // total (sum of entries)
  timeEntries:    [TimeEntrySchema],

  // Kanban ordering
  order:     { type: Number, default: 0 },

  // Embedded sub-documents
  subtasks:  [SubtaskSchema],
  comments:  [CommentSchema],
  activity:  [ActivitySchema],
}, { timestamps: true });

// ── Indexes ──────────────────────────────────────────────────
TaskSchema.index({ user: 1, status: 1 });
TaskSchema.index({ user: 1, deadline: 1 });
TaskSchema.index({ user: 1, sprint: 1 });
TaskSchema.index({ user: 1, createdAt: -1 });

// ── Auto-generate taskNumber ──────────────────────────────────
TaskSchema.pre('save', async function () {
  if (!this.taskNumber) {
    const seq = await mongoose.model('Counter').next(`task:${this.user}`, async () => {
      const rows = await mongoose.model('Task').find({ user: this.user, taskNumber: /^TK-\d+$/ }).select('taskNumber').lean();
      return rows.reduce((m, r) => Math.max(m, parseInt(r.taskNumber.slice(3), 10) || 0), 0);
    });
    this.taskNumber = 'TK-' + String(seq).padStart(4, '0');
  }
  // Track when status changed (for aging)
  if (this.isModified('status')) {
    this.stateChangedAt = new Date();
  }
  if (this.isModified('status')) {
    if (this.status === 'done') { this.completed = true; if (!this.completedAt) this.completedAt = new Date(); }
    else if (this.completed) { this.completed = false; this.completedAt = undefined; }
  }
});

module.exports = mongoose.model('Task', TaskSchema);