// services/email.js — transactional email through Resend.
// Without RESEND_API_KEY (local dev) emails are logged instead of sent, so flows stay testable.
const env    = require('../config/env');
const logger = require('../utils/logger');

let client = null;
function getClient() {
  if (!env.RESEND_API_KEY) return null;
  if (!client) {
    const { Resend } = require('resend');
    client = new Resend(env.RESEND_API_KEY);
  }
  return client;
}

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/** Shared layout: ledger green, gilt rule, one clear action. */
function layout({ heading, intro, action, outro }) {
  const button = action
    ? `<tr><td style="padding:8px 0 24px"><a href="${esc(action.url)}" style="display:inline-block;background:#CFA75A;color:#10201A;font-weight:600;text-decoration:none;padding:12px 22px;border-radius:6px;font-family:Arial,sans-serif;font-size:15px">${esc(action.label)}</a></td></tr>
       <tr><td style="font:13px/1.5 Arial,sans-serif;color:#7c8a80;padding-bottom:16px">Or paste this link into your browser:<br><span style="color:#4d5d53;word-break:break-all">${esc(action.url)}</span></td></tr>`
    : '';
  return `<!doctype html><html><body style="margin:0;background:#EEF0EA;padding:32px 12px">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center">
  <table role="presentation" width="560" cellpadding="0" cellspacing="0" style="max-width:560px;background:#ffffff;border-radius:10px;overflow:hidden">
    <tr><td style="background:#10201A;padding:22px 32px;border-bottom:3px double #CFA75A">
      <span style="font:600 20px Georgia,serif;color:#E9E4D4;letter-spacing:.01em">Aurelance</span>
    </td></tr>
    <tr><td style="padding:32px">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
        <tr><td style="font:400 24px/1.25 Georgia,serif;color:#10201A;padding-bottom:12px">${esc(heading)}</td></tr>
        <tr><td style="font:15px/1.6 Arial,sans-serif;color:#33413a;padding-bottom:20px">${intro}</td></tr>
        ${button}
        ${outro ? `<tr><td style="font:13px/1.6 Arial,sans-serif;color:#7c8a80">${outro}</td></tr>` : ''}
      </table>
    </td></tr>
    <tr><td style="padding:18px 32px;background:#F6F7F3;font:12px/1.5 Arial,sans-serif;color:#8a968e">
      Aurelance · The back office for independent work
    </td></tr>
  </table></td></tr></table></body></html>`;
}

/** Send an email. Registered with keepAlive so un-awaited sends still finish on serverless hosting. */
function send(msg) { return require('../utils/background').keepAlive(deliver(msg)); }

async function deliver({ to, subject, html, text, replyTo }) {
  const c = getClient();
  if (!c) {
    logger.info(`[email:dev] to=${to} subject="${subject}"`, { text: text || html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').slice(0, 400) });
    return { id: 'dev-log', delivered: false };
  }
  const { data, error } = await c.emails.send({ from: env.EMAIL_FROM, to, subject, html, text, ...(replyTo ? { replyTo } : {}) });
  if (error) {
    logger.error(`Email send failed: ${error.message || error.name}`, { to, subject });
    throw Object.assign(new Error('Could not send email right now. Try again in a minute.'), { statusCode: 502 });
  }
  return { id: data?.id, delivered: true };
}

const templates = {
  passwordReset: (name, url) => ({
    subject: 'Reset your Aurelance password',
    html: layout({
      heading: 'Reset your password',
      intro: `Hi ${esc(name)}, someone asked to reset the password on your Aurelance account. The link works for 1 hour and only once.`,
      action: { label: 'Choose a new password', url },
      outro: 'Didn’t ask for this? Ignore this email — your password stays the same.',
    }),
  }),
  verifyEmail: (name, url) => ({
    subject: 'Confirm your email for Aurelance',
    html: layout({
      heading: 'Confirm your email',
      intro: `Hi ${esc(name)}, confirm this address so contract offers, payment updates and password resets reach you.`,
      action: { label: 'Confirm email', url },
    }),
  }),
  emailChange: (name, url, newEmail) => ({
    subject: 'Confirm your new email address',
    html: layout({
      heading: 'Confirm your new email',
      intro: `Hi ${esc(name)}, confirm <strong>${esc(newEmail)}</strong> as the new sign-in email for your Aurelance account.`,
      action: { label: 'Confirm new email', url },
      outro: 'Your current email keeps working until you confirm.',
    }),
  }),
  twoFactorCode: (name, code) => ({
    subject: `${code} is your Aurelance sign-in code`,
    html: layout({
      heading: 'Your sign-in code',
      intro: `Hi ${esc(name)}, enter this code to continue. It expires in 10 minutes.<br><br>
        <span style="font:600 30px/1 'Courier New',monospace;letter-spacing:6px;color:#10201A">${esc(code)}</span>`,
      outro: 'If you weren’t signing in, change your password now.',
    }),
  }),
  newSignIn: (name, device, ip, when) => ({
    subject: 'New sign-in to your Aurelance account',
    html: layout({
      heading: 'New sign-in',
      intro: `Hi ${esc(name)}, your account was just used on <strong>${esc(device)}</strong> (IP ${esc(ip)}) at ${esc(when)}.`,
      outro: 'If this wasn’t you, open Settings → Security, sign out all devices and change your password.',
    }),
  }),
  paymentReceipt: (name, { plan, interval, amount, currency, periodEnd, orderId }) => ({
    subject: 'Your Aurelance Premium receipt',
    html: layout({
      heading: 'Payment received',
      intro: `Hi ${esc(name)}, thanks — ${esc(plan)} (${interval === 'year' ? 'yearly' : 'monthly'}) is active until <strong>${esc(new Date(periodEnd).toDateString())}</strong>.<br><br>
        Amount: <strong>${esc(currency)} ${Number(amount).toLocaleString('en-US', { maximumFractionDigits: 2 })}</strong><br>Reference: ${esc(orderId)}`,
      action: { label: 'Open billing', url: `${env.CLIENT_URL}/billing` },
    }),
  }),
  renewalReminder: (name, expiresAt) => ({
    subject: 'Your Aurelance Premium ends in a week',
    html: layout({
      heading: 'Premium ends soon',
      intro: `Hi ${esc(name)}, your Premium period ends on <strong>${esc(new Date(expiresAt).toDateString())}</strong>. Nothing renews automatically — extend it from the Billing page to keep analytics, contracts and proposals. Your data stays either way.`,
      action: { label: 'Extend Premium', url: `${env.CLIENT_URL}/billing` },
      outro: 'Don’t want these reminders? Choose “Don’t renew” on the Billing page.',
    }),
  }),
  ticketToSupport: (t) => ({
    subject: `[${t.number}] ${t.subject}`,
    html: layout({
      heading: `${t.number} · ${t.category}`,
      intro: `<strong>From:</strong> ${esc(t.name)} &lt;${esc(t.email)}&gt;<br><strong>Source:</strong> ${esc(t.source)} · <strong>Priority:</strong> ${esc(t.priority)}<br><br>${esc(t.message).replace(/\n/g, '<br>')}`,
    }),
  }),
  ticketConfirmation: (t) => ({
    subject: `We got your message — ${t.number}`,
    html: layout({
      heading: 'Message received',
      intro: `Hi ${esc(t.name || 'there')}, thanks for writing in about “${esc(t.subject)}”. We reply within one business day. Your reference is <strong>${esc(t.number)}</strong>.`,
    }),
  }),
  ticketReply: (t, text) => ({
    subject: `Re: [${t.number}] ${t.subject}`,
    html: layout({
      heading: 'Support replied',
      intro: `${esc(text).replace(/\n/g, '<br>')}`,
      action: t.user ? { label: 'Reply or mark it solved', url: `${env.CLIENT_URL}/support?ticket=${t._id}` } : undefined,
      outro: t.user ? `Reference ${esc(t.number)}.` : `Reference ${esc(t.number)}. Reply to this email to continue.`,
    }),
  }),
};

module.exports = { send, templates, layout, esc };
