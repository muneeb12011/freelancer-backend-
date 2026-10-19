// models/JobApplication.js — a freelancer's proposal for a Job.
const mongoose = require('mongoose');

const JobApplicationSchema = new mongoose.Schema({
  job:        { type: mongoose.Schema.Types.ObjectId, ref: 'Job', required: true },
  applicant:  { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  poster:     { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  coverLetter:{ type: String, required: true, minlength: 50, maxlength: 5000 },
  bid:        { type: Number, min: 0, required: true },
  // Optional milestone plan proposed by the freelancer — becomes the draft contract on hire.
  milestones: [{ title: { type: String, maxlength: 120 }, amount: { type: Number, min: 0 }, days: { type: Number, min: 0, max: 365 }, _id: false }],
  timeline:   { type: String, maxlength: 120, default: '' },
  links:      [{ type: String, maxlength: 300 }],
  // rejected = "Declined" in the app; closed = the job closed before the poster decided (counts as ghosted)
  status:     { type: String, enum: ['submitted', 'shortlisted', 'rejected', 'trial', 'hired', 'withdrawn', 'closed'], default: 'submitted' },
  squad:      { type: mongoose.Schema.Types.ObjectId, ref: 'Squad' }, // applied as a squad (applicant is the lead)
  viewedAt:   { type: Date },           // poster opened it
  respondedAt:{ type: Date },           // first shortlist / decline / trial / hire
  declineReason: { type: String, enum: ['', 'budget', 'skills', 'experience', 'chose_other', 'not_hiring', 'other'], default: '' },
  engagement: { type: mongoose.Schema.Types.ObjectId, ref: 'Engagement' },
  posterNote: { type: String, maxlength: 1000, default: '', select: false }, // private to the poster
  conversation: { type: mongoose.Schema.Types.ObjectId, ref: 'Conversation' },
}, { timestamps: true });

JobApplicationSchema.index({ job: 1, applicant: 1 }, { unique: true });
JobApplicationSchema.index({ applicant: 1, createdAt: -1 });
JobApplicationSchema.index({ poster: 1, status: 1 });

module.exports = mongoose.model('JobApplication', JobApplicationSchema);
