// services/messaging.js — shared by the messages routes and by other features
// (job applications, hiring) that need to open a thread or post a system note.
const Conversation = require('../models/Conversation');
const Message = require('../models/Message');
const User = require('../models/User');
const env = require('../config/env');
const email = require('./email');

async function findOrCreate(a, b, extra = {}) {
  const pairKey = Conversation.keyFor(a, b);
  let convo = await Conversation.findOne({ pairKey });
  if (!convo) {
    try {
      convo = await Conversation.create({ participants: [a, b], pairKey, ...extra });
    } catch (err) {
      if (err.code === 11000) convo = await Conversation.findOne({ pairKey }); // created concurrently
      else throw err;
    }
  }
  return convo;
}

async function isBlocked(senderId, recipientId) {
  const r = await User.exists({ _id: recipientId, blockedUsers: senderId });
  const s = await User.exists({ _id: senderId, blockedUsers: recipientId });
  return Boolean(r || s);
}

/** Post a message and update thread metadata + recipient unread count. */
async function post(convo, { sender = null, text = '', kind = 'text', attachment }) {
  const msg = await Message.create({ conversation: convo._id, sender, kind, text, attachment });
  const others = convo.participants.filter((p) => String(p) !== String(sender));
  const inc = {};
  others.forEach((p) => { inc[`unread.${p}`] = 1; });
  await Conversation.updateOne(
    { _id: convo._id },
    {
      $set: { lastMessage: { text: kind === 'system' ? text : (text || (attachment ? `📎 ${attachment.name}` : '')), sender, at: msg.createdAt } },
      $inc: inc,
      $pull: { archivedBy: { $in: convo.participants } },
    },
  );
  return msg;
}

/** Email the recipient about a new message — at most once per 30 minutes per thread. */
async function notify(convo, senderUser, text) {
  const recipientId = convo.participants.find((p) => String(p) !== String(senderUser._id));
  if (!recipientId) return;
  const last = convo.notifiedAt?.get?.(String(recipientId));
  if (last && Date.now() - new Date(last).getTime() < 30 * 60e3) return;
  const recipient = await User.findById(recipientId).select('email name notifications');
  if (!recipient || recipient.notifications?.clientMessages === false) return;
  await Conversation.updateOne({ _id: convo._id }, { $set: { [`notifiedAt.${recipientId}`]: new Date() } });
  email.send({
    to: recipient.email,
    subject: `New message from ${senderUser.name}`,
    html: email.layout({
      heading: `${email.esc(senderUser.name)} sent you a message`,
      intro: `“${email.esc(String(text || 'Sent an attachment').slice(0, 400))}”`,
      action: { label: 'Reply in Aurelance', url: `${env.CLIENT_URL}/messages/${convo._id}` },
      outro: 'Turn these emails off in Settings → Notifications.',
    }),
  }).catch(() => {});
}

module.exports = { findOrCreate, post, notify, isBlocked };
