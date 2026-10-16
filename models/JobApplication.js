// models/JobApplication.js — a freelancer's proposal for a Job.
const mongoose = require('mongoose');

const JobApplicationSchema = new mongoose.Schema({
  job:        { type: mongoose.Schema.Types.ObjectId, ref: 'Job', required: true },
  applicant:  { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  poster:     { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  coverLetter:{ type: String, required: true, minlength: 50, maxlength: 5000 },
  bid:        { type: Number, min: 0, required: true },
  timeline:   { type: String, maxlength: 120, default: '' },
  links:      [{ type: String, maxlength: 300 }],
  status:     { type: String, enum: ['submitted', 'shortlisted', 'rejected', 'hired', 'withdrawn'], default: 'submitted' },
  posterNote: { type: String, maxlength: 1000, default: '', select: false }, // private to the poster
  conversation: { type: mongoose.Schema.Types.ObjectId, ref: 'Conversation' },
}, { timestamps: true });

JobApplicationSchema.index({ job: 1, applicant: 1 }, { unique: true });
JobApplicationSchema.index({ applicant: 1, createdAt: -1 });
JobApplicationSchema.index({ poster: 1, status: 1 });

module.exports = mongoose.model('JobApplication', JobApplicationSchema);
