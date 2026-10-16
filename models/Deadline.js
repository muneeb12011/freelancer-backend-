// models/Deadline.js — manual deadlines shown on the dashboard (task deadlines come from Task).
const mongoose = require('mongoose');

const DeadlineSchema = new mongoose.Schema({
  user:      { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  title:     { type: String, required: true, trim: true, maxlength: 200 },
  dueDate:   { type: Date, required: true },
  priority:  { type: String, enum: ['Low', 'Medium', 'High', 'Urgent'], default: 'Medium' },
  completed: { type: Boolean, default: false },
  note:      { type: String, default: '', maxlength: 1000 },
}, { timestamps: true });

DeadlineSchema.index({ user: 1, dueDate: 1 });

module.exports = mongoose.model('Deadline', DeadlineSchema);
