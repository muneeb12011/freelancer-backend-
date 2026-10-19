// models/TimeEntry.js — time a freelancer logged on an hourly contract.
// Entries for a week are editable until that week's timesheet is submitted; after that they're
// locked unless the client sends the timesheet back for changes.
const mongoose = require('mongoose');

const TimeEntrySchema = new mongoose.Schema({
  engagement: { type: mongoose.Schema.Types.ObjectId, ref: 'Engagement', required: true },
  freelancer: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  date:    { type: String, required: true, match: /^\d{4}-\d{2}-\d{2}$/ },  // the day worked, YYYY-MM-DD
  week:    { type: String, required: true, match: /^\d{4}-\d{2}-\d{2}$/ },  // Monday of that week
  minutes: { type: Number, required: true, min: 1, max: 1440 },
  note:    { type: String, trim: true, maxlength: 300, required: true },
}, { timestamps: true });

TimeEntrySchema.index({ engagement: 1, week: 1, date: 1 });

module.exports = mongoose.model('TimeEntry', TimeEntrySchema);
