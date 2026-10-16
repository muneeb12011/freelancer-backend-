// models/Attachment.js — small files sent in messages (≤ 2 MB). Bytes live here, not in Message,
// so listing a thread never loads file data. Swap for object storage later without touching routes.
const mongoose = require('mongoose');

const AttachmentSchema = new mongoose.Schema({
  owner:        { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  conversation: { type: mongoose.Schema.Types.ObjectId, ref: 'Conversation', required: true },
  name: { type: String, required: true, maxlength: 200 },
  type: { type: String, required: true, maxlength: 100 },
  size: { type: Number, required: true },
  data: { type: Buffer, required: true, select: false },
}, { timestamps: true });

module.exports = mongoose.model('Attachment', AttachmentSchema);
