// services/clientStats.js — recompute a client's money figures from its invoices.
// Recomputing (instead of $inc on every change) means edits/deletes can never drift the numbers.
const mongoose = require('mongoose');
const Client  = require('../models/Client');
const Invoice = require('../models/Invoice');

async function refreshClientStats(userId, clientId) {
  if (!clientId || !mongoose.isValidObjectId(clientId)) return;
  const rows = await Invoice.find({ user: userId, client: clientId, status: { $ne: 'cancelled' } }).select('status total').lean();
  const stats = rows.reduce((s, i) => {
    s.invoiceCount += 1;
    if (i.status === 'paid') { s.paidInvoices += 1; s.revenue += i.total || 0; }
    if (i.status === 'sent' || i.status === 'overdue') s.outstanding += i.total || 0;
    return s;
  }, { invoiceCount: 0, paidInvoices: 0, revenue: 0, outstanding: 0 });
  stats.revenue = Math.round(stats.revenue * 100) / 100;
  stats.outstanding = Math.round(stats.outstanding * 100) / 100;
  await Client.updateOne({ _id: clientId, user: userId }, { ...stats, lastActivity: new Date() });
}

module.exports = { refreshClientStats };
