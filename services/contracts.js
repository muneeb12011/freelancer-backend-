// services/contracts.js — creating contracts and posting their updates into the shared thread.
const Engagement = require('../models/Engagement');
const messaging = require('./messaging');
const email = require('./email');
const env = require('../config/env');
const User = require('../models/User');
const notify = require('./notify');

const money = (c, n) => `${c} ${Number(n || 0).toLocaleString('en-US', { maximumFractionDigits: 2 })}`;

/** Post a system line in the contract's conversation so both people see it in Messages too. */
async function announce(contract, text) {
  if (!contract.conversation) return;
  const Conversation = require('../models/Conversation');
  const convo = await Conversation.findById(contract.conversation);
  if (convo) await messaging.post(convo, { kind: 'system', text });
}

async function notifyByEmail(userId, subject, heading, intro, contractId) {
  const u = await User.findById(userId).select('email name notifications').lean();
  if (!u || u.notifications?.jobAlerts === false) return;
  email.send({
    to: u.email, subject,
    html: email.layout({ heading, intro, action: { label: 'Open the contract', url: `${env.CLIENT_URL}/contracts/${contractId}` } }),
  }).catch(() => {});
}

/**
 * Draft contract. Milestones come from the caller (job + bid by default).
 * Both people have to sign before work starts — until then either can reshape it.
 */
async function createDraft({ client, freelancer, squad, job, application, kind = 'standard', title, summary = '', currency = 'USD', milestones, billing = 'fixed', hourly }) {
  const convo = await messaging.findOrCreate(client._id, freelancer._id, job ? { job: job._id } : {});
  const contract = await Engagement.create({
    client: client._id, freelancer: freelancer._id, squad, job: job?._id, application: application?._id,
    conversation: convo._id, kind, title, summary, currency, milestones: billing === 'hourly' ? [] : milestones,
    billing, hourly: billing === 'hourly' ? hourly : undefined,
  });
  contract.log(client._id, kind === 'trial' ? 'Paid trial offered' : 'Contract drafted');
  await contract.save();
  await messaging.post(convo, {
    kind: 'system',
    text: kind === 'trial'
      ? `${client.name} offered ${freelancer.name} a paid trial: “${title}” for ${money(currency, contract.total)}. Review and sign it under Contracts.`
      : `${client.name} wants to hire ${freelancer.name} for “${title}”${billing === 'hourly' ? ` at ${money(currency, hourly.rate)}/h, up to ${hourly.weeklyCap} h a week` : ''}. The draft contract is ready to review and sign under Contracts.`,
  });
  notify.push(freelancer._id, {
    type: kind === 'trial' ? 'trial.offer' : 'contract.offer', actor: client._id, link: `/contracts/${contract._id}`,
    title: kind === 'trial' ? `${client.name} offered you a paid trial` : `${client.name} sent you a contract`,
    body: `${title} · ${billing === 'hourly' ? `${money(currency, hourly.rate)}/h, up to ${hourly.weeklyCap} h a week` : money(currency, contract.total)}`,
  });
  notifyByEmail(
    freelancer._id,
    kind === 'trial' ? `Paid trial offer: ${title}` : `Contract offer: ${title}`,
    kind === 'trial' ? 'You’ve been offered a paid trial' : 'You’ve got a contract offer',
    `${email.esc(client.name)} sent you a ${kind === 'trial' ? 'paid trial' : 'contract'} for <strong>${email.esc(title)}</strong> (${email.esc(billing === 'hourly' ? `${money(currency, hourly.rate)}/h, up to ${hourly.weeklyCap} h a week` : money(currency, contract.total))}). Check the terms, then sign to start.`,
    contract._id,
  );
  return contract;
}

module.exports = { createDraft, announce, notifyByEmail, money };
