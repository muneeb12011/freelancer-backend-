// services/account.js — data export and full account deletion (GDPR-style).
const User       = require('../models/User');
const Client     = require('../models/Client');
const Connection = require('../models/Connection');
const ConnectionRequest = require('../models/ConnectionRequest');
const Contract   = require('../models/Contract');
const Deadline   = require('../models/Deadline');
const Earning    = require('../models/Earning');
const Invoice    = require('../models/Invoice');
const Note       = require('../models/Note');
const Payment    = require('../models/Payment');
const Proposal   = require('../models/Proposal');
const Session    = require('../models/Session');
const Task       = require('../models/Task');
const Ticket     = require('../models/Ticket');
const Feedback   = require('../models/Feedback');
const OAuthCode  = require('../models/OAuthCode');
const WorkspaceDoc = require('../models/WorkspaceDoc');
const Conversation = require('../models/Conversation');
const Message = require('../models/Message');
const Attachment = require('../models/Attachment');
const Job = require('../models/Job');
const JobApplication = require('../models/JobApplication');
const IdentityVerification = require('../models/IdentityVerification');

const OWNED = { Client, Connection, Contract, Deadline, Earning, Invoice, Note, Proposal, Task, WorkspaceDoc };

async function exportData(userId) {
  const user = await User.findById(userId);
  const out = { exportedAt: new Date().toISOString(), account: user.toClient() };
  await Promise.all(Object.entries(OWNED).map(async ([name, M]) => {
    out[name.toLowerCase() + 's'] = await M.find({ user: userId }).lean();
  }));
  out.payments = await Payment.find({ user: userId }).select('-raw').lean();
  out.supportTickets = await Ticket.find({ user: userId }).lean();
  out.jobsPosted = await Job.find({ postedBy: userId }).lean();
  out.jobApplications = await JobApplication.find({ applicant: userId }).lean();
  const convos = await Conversation.find({ participants: userId }).select('_id participants').lean();
  out.messages = await Message.find({ conversation: { $in: convos.map((c) => c._id) }, sender: userId }).select('conversation text createdAt').lean();
  return out;
}

async function deleteAccount(userId) {
  await Promise.all([
    ...Object.values(OWNED).map((M) => M.deleteMany({ user: userId })),
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
  ]);
  await User.deleteOne({ _id: userId });
}

module.exports = { exportData, deleteAccount };
