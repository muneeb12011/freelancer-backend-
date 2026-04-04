// models/Task.js — Complete production schema
const mongoose = require('mongoose');
const { Schema } = mongoose;

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
TaskSchema.pre('save', async function (next) {
  if (!this.taskNumber) {
    const last = await mongoose.model('Task')
      .findOne({ user: this.user })
      .sort({ createdAt: -1 })
      .select('taskNumber')
      .lean();
    const lastNum = last?.taskNumber?.match(/(\d+)$/)?.[1];
    this.taskNumber = 'TK-' + String((parseInt(lastNum || 0) + 1)).padStart(4, '0');
  }
  // Track when status changed (for aging)
  if (this.isModified('status')) {
    this.stateChangedAt = new Date();
  }
  next();
});

module.exports = mongoose.model('Task', TaskSchema);