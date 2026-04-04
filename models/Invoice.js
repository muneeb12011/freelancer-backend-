// models/Invoice.js
const mongoose = require('mongoose');

const LineItemSchema = new mongoose.Schema({
  description: { type: String, required: true },
  quantity:    { type: Number, default: 1 },
  rate:        { type: Number, required: true },
  total:       { type: Number },
}, { _id: false });

LineItemSchema.pre('save', function () {
  this.total = (this.quantity || 1) * (this.rate || 0);
});

const InvoiceSchema = new mongoose.Schema({
  user:          { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  client:        { type: mongoose.Schema.Types.ObjectId, ref: 'Client' },
  clientName:    { type: String, required: true, trim: true },
  clientEmail:   { type: String, trim: true },

  invoiceNumber: { type: String, required: true },
  issueDate:     { type: String, required: true },
  dueDate:       { type: String },

  items:         [LineItemSchema],
  subtotal:      { type: Number, default: 0 },
  taxRate:       { type: Number, default: 0 },
  taxAmount:     { type: Number, default: 0 },
  total:         { type: Number, default: 0 },

  status:        { type: String, enum: ['draft','sent','paid','overdue','cancelled'], default: 'draft' },
  notes:         { type: String, default: '' },
  paidAt:        { type: Date },
}, { timestamps: true });

InvoiceSchema.index({ user: 1, status: 1 });
InvoiceSchema.index({ user: 1, client: 1 });

module.exports = mongoose.model('Invoice', InvoiceSchema);
