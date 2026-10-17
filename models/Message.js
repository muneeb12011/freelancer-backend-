// models/Message.js — messages inside a Conversation.
const mongoose = require('mongoose');

const MessageSchema = new mongoose.Schema({
  conversation: { type: mongoose.Schema.Types.ObjectId, ref: 'Conversation', required: true },
  sender:       { type: mongoose.Schema.Types.ObjectId, ref: 'User' }, // null = system message
  kind:         { type: String, enum: ['text', 'system'], default: 'text' },
  text:         { type: String, default: '', maxlength: 5000 },
  attachment:   {
    id:   { type: mongoose.Schema.Types.ObjectId, ref: 'Attachment' },
    name: String, type: { type: String }, size: Number,
  },
  // Scam shield: shown to the recipient as a caution under the message.
  flags:     [{ code: String, label: String, tip: String, _id: false }],
  readAt:    { type: Date },
  deletedAt: { type: Date },
}, { timestamps: true });

MessageSchema.index({ conversation: 1, createdAt: -1 });

module.exports = mongoose.model('Message', MessageSchema);
