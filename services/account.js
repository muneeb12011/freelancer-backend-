// services/account.js — data export and full account deletion (GDPR-style).
const mongoose   = require('mongoose');
const User       = require('../models/User');
const Connection = require('../models/Connection');
const ConnectionRequest = require('../models/ConnectionRequest');
const Payment    = require('../models/Payment');
const Session    = require('../models/Session');
const Ticket     = require('../models/Ticket');
const Feedback   = require('../models/Feedback');
const OAuthCode  = require('../models/OAuthCode');
const Conversation = require('../models/Conversation');
const Message = require('../models/Message');
const Attachment = require('../models/Attachment');
const Job = require('../models/Job');
const JobApplication = require('../models/JobApplication');
const IdentityVerification = require('../models/IdentityVerification');
const Engagement = require('../models/Engagement');
const Review = require('../models/Review');
const PayoutMethod = require('../models/PayoutMethod');
const Squad = require('../models/Squad');
const Report = require('../models/Report');

// Data from the old freelancer dashboard (clients, invoices, tasks…). Those features are gone, but
// accounts created before the marketplace may still have rows, so export and deletion reach the raw
// collections directly instead of keeping dead models around.
const LEGACY = ['clients', 'contracts', 'deadlines', 'earnings', 'invoices', 'notes', 'proposals', 'tasks', 'workspacedocs'];
const legacy = (name) => mongoose.connection.db.collection(name);

async function exportData(userId) {
  const user = await User.findById(userId);
  const out = { exportedAt: new Date().toISOString(), account: user.toClient() };
  out.connections = await Connection.find({ user: userId }).lean();
  const old = {};
  await Promise.all(LEGACY.map(async (name) => {
    const rows = await legacy(name).find({ user: user._id }).toArray().catch(() => []);
    if (rows.length) old[name] = rows;
  }));
  if (Object.keys(old).length) out.legacyDashboard = old;
  out.payments = await Payment.find({ user: userId }).select('-raw').lean();
  out.supportTickets = await Ticket.find({ user: userId }).lean();
  out.jobsPosted = await Job.find({ postedBy: userId }).lean();
  out.jobApplications = await JobApplication.find({ applicant: userId }).lean();
  const convos = await Conversation.find({ participants: userId }).select('_id participants').lean();
  out.contracts = await Engagement.find({ $or: [{ client: userId }, { freelancer: userId }] }).lean();
  out.reviewsWritten = await Review.find({ from: userId }).lean();
  out.reviewsReceived = await Review.find({ to: userId, visibleAt: { $ne: null } }).lean();
  out.payoutMethods = (await PayoutMethod.find({ user: userId }).lean()).map((m) => ({ type: m.type, display: m.display, holderName: m.holderName, status: m.status, createdAt: m.createdAt }));
  out.squads = await Squad.find({ 'members.user': userId }).lean();
  out.messages = await Message.find({ conversation: { $in: convos.map((c) => c._id) }, sender: userId }).select('conversation text createdAt').lean();
  return out;
}

async function deleteAccount(userId) {
  await Promise.all([
    Connection.deleteMany({ user: userId }),
    ...LEGACY.map((name) => legacy(name).deleteMany({ user: new mongoose.Types.ObjectId(String(userId)) }).catch(() => null)),
    Session.deleteMany({ user: userId }),
    OAuthCode.deleteMany({ user: userId }),
    Feedback.deleteMany({ user: userId }),
    Ticket.updateMany({ user: userId }, { $unset: { user: 1 } }), // keep the support history, unlinked
    // Paid records are kept for accounting/tax; unfinished checkouts are removed.
    Payment.deleteMany({ user: userId, status: { $ne: 'paid' } }),
    ConnectionRequest.deleteMany({ $or: [{ from: userId }, { to: userId }] }),
    Connection.updateMany({ linkedUser: userId }, { $unset: { linkedUser: 1 } }),
    Attachment.deleteMany({ owner: userId }),
    Message.updateMany({ sender: userId }, { $set: { text: '', deletedAt: new Date() }, $unset: { attachment: 1 } }),
    JobApplication.deleteMany({ applicant: userId }),
    Job.find({ postedBy: userId }).distinct('_id').then((ids) => Promise.all([Job.deleteMany({ _id: { $in: ids } }), JobApplication.deleteMany({ job: { $in: ids } })])),
    IdentityVerification.deleteMany({ user: userId }),
    PayoutMethod.deleteMany({ user: userId }),
    Report.deleteMany({ by: userId }),
    Squad.deleteMany({ lead: userId }),
    Squad.updateMany({ 'members.user': userId }, { $pull: { members: { user: userId } } }),
    // Contracts stay as a record for the other party; reviews the person wrote stay on others' report cards.
  ]);
  await User.deleteOne({ _id: userId });
}

module.exports = { exportData, deleteAccount };
