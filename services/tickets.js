// services/tickets.js — create a support ticket, notify the support inbox and confirm to the sender.
const env     = require('../config/env');
const Ticket  = require('../models/Ticket');
const Counter = require('../models/Counter');
const email   = require('./email');

async function createTicket({ user, name, email: from, subject, message, category, priority, source, topic, engagement }) {
  const seq = await Counter.next('ticket');
  const ticket = await Ticket.create({
    user: user?._id, number: `TKT-${String(seq).padStart(5, '0')}`,
    name, email: from, subject, message, category: category || 'General',
    priority: ['low', 'normal', 'high', 'urgent'].includes(priority) ? priority : 'normal', source,
    topic: topic || 'other', engagement: engagement || undefined,
  });
  await Promise.allSettled([
    email.send({ to: env.SUPPORT_INBOX, replyTo: from, ...email.templates.ticketToSupport(ticket) }),
    email.send({ to: from, ...email.templates.ticketConfirmation(ticket) }),
  ]);
  return ticket;
}

module.exports = { createTicket };
