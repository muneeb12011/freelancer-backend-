// services/trust.js — "who am I talking to?" for a conversation.
//
// Each line is something Aurelance actually checked — never something the person typed about
// themselves: ID reviewed by a person, email confirmed, a Google/GitHub account linked, a work
// email at a company domain confirmed by code, a payout method verified against their ID, and
// their report card. Warnings come from reports by established accounts, held job posts, and
// risky messages they sent in this very conversation.
//
// "Verify on a call": both people see the same 6-digit code, derived from the conversation and the
// current 5-minute window with an HMAC under a server secret. If the person on a video call reads
// out the code you see, they can open this conversation — so they control this Aurelance account,
// not just a copy of its name and photo.
const crypto = require('crypto');
const env = require('../config/env');
const User = require('../models/User');
const Engagement = require('../models/Engagement');
const Message = require('../models/Message');

const WINDOW_MS = 5 * 60e3;
const DAY = 86400e3;

// Free and personal mail providers: a work email has to be at a domain someone controls.
const FREE_DOMAINS = new Set(['gmail.com', 'googlemail.com', 'yahoo.com', 'yahoo.co.uk', 'ymail.com', 'hotmail.com', 'outlook.com', 'live.com', 'msn.com', 'icloud.com', 'me.com', 'mac.com', 'aol.com', 'proton.me', 'protonmail.com', 'pm.me', 'gmx.com', 'gmx.net', 'mail.com', 'yandex.com', 'yandex.ru', 'zoho.com', 'tutanota.com', 'tuta.io', 'hey.com', 'fastmail.com', 'rediffmail.com', 'qq.com', '163.com', 'example.com', 'mailinator.com', 'guerrillamail.com', 'tempmail.com', '10minutemail.com']);
const domainOf = (email) => String(email || '').toLowerCase().trim().split('@')[1] || '';
const isWorkDomain = (d) => Boolean(d) && /^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(d) && !FREE_DOMAINS.has(d);

const secret = () => `${env.JWT_SECRET || 'dev'}:call-code`;
function callCode(conversationId, at = Date.now()) {
  const win = Math.floor(at / WINDOW_MS);
  const h = crypto.createHmac('sha256', secret()).update(`${conversationId}:${win}`).digest();
  const n = h.readUInt32BE(0) % 1e6;
  return { code: String(n).padStart(6, '0'), expiresAt: new Date((win + 1) * WINDOW_MS) };
}
/** Accept the current window and the one before (someone reading it out as it rolls over). */
function codeMatches(conversationId, code, at = Date.now()) {
  const c = String(code || '').replace(/\D/g, '');
  if (c.length !== 6) return false;
  return [at, at - WINDOW_MS].some((t) => crypto.timingSafeEqual(Buffer.from(callCode(conversationId, t).code), Buffer.from(c)));
}

const daysSince = (d) => (d ? Math.floor((Date.now() - new Date(d).getTime()) / DAY) : null);
function age(d) {
  const n = daysSince(d);
  if (n === null) return '';
  if (n < 1) return 'joined today';
  if (n < 30) return `joined ${n} day${n === 1 ? '' : 's'} ago`;
  const m = Math.floor(n / 30);
  return m < 12 ? `joined ${m} month${m === 1 ? '' : 's'} ago` : `joined ${Math.floor(m / 12)} year${m >= 24 ? 's' : ''} ago`;
}

/**
 * Trust summary of `otherId`, as seen by `viewer`, inside `convo`.
 * level: 'strong' (ID + one more), 'some', or 'none' — plus warnings that override it.
 */
async function summary(viewer, otherId, convo) {
  const u = await User.findById(otherId).select('name createdAt emailVerified googleId githubId identity.status payoutTypes workEmail.domain workEmail.verifiedAt reputation').lean();
  if (!u) return null;
  const shield = require('./scamShield');
  const [risk, together, theirFlags] = await Promise.all([
    shield.posterRisk(u._id, { cached: true }),
    Engagement.find({ status: { $in: ['active', 'completed', 'ended'] }, $or: [{ client: viewer._id, freelancer: u._id }, { client: u._id, freelancer: viewer._id }] }).select('status').lean(),
    Message.find({ conversation: convo._id, sender: u._id, deletedAt: null }).select('flags').sort({ createdAt: -1 }).limit(300).lean().then((rows) => rows.filter((m) => (m.flags || []).length)),
  ]);
  const rep = u.reputation || {};
  const checks = [
    { id: 'identity', ok: u.identity?.status === 'approved', label: 'ID checked by a person', detail: u.identity?.status === 'approved' ? 'Their ID was reviewed and the name matches this account. The photos were deleted after.' : u.identity?.status === 'pending' ? 'They’ve sent an ID; it’s waiting for review.' : 'Not done yet.' },
    { id: 'work', ok: Boolean(u.workEmail?.verifiedAt), label: u.workEmail?.verifiedAt ? `Work email at ${u.workEmail.domain}` : 'Work email', detail: u.workEmail?.verifiedAt ? `They confirmed a code sent to an address at ${u.workEmail.domain}. Check that’s the company they say they’re from.` : 'No company email confirmed. Normal for freelancers; worth asking a company to do.' },
    { id: 'payout', ok: (u.payoutTypes || []).length > 0, label: 'Payout method verified', detail: (u.payoutTypes || []).length ? `A ${u.payoutTypes.join(' / ')} account in their own name was checked.` : 'None yet.' },
    { id: 'email', ok: Boolean(u.emailVerified), label: 'Email confirmed', detail: u.emailVerified ? 'They clicked a link sent to their sign-in email.' : 'They haven’t confirmed their email.' },
    { id: 'linked', ok: Boolean(u.googleId || u.githubId), label: u.githubId && !u.googleId ? 'GitHub linked' : 'Google linked', detail: u.googleId || u.githubId ? 'Signs in with an existing Google or GitHub account.' : 'No Google or GitHub account linked.' },
  ];
  const warnings = [];
  if (risk.reporters >= 3) warnings.push({ id: 'reported', label: 'Reported by several people', detail: `${risk.reporters} established accounts reported them in the last 60 days. Don’t pay or share documents until you’re sure.` });
  if (risk.priorHeld >= 1) warnings.push({ id: 'held', label: risk.priorHeld > 1 ? `${risk.priorHeld} job posts held as likely scams` : 'A job post held as a likely scam', detail: 'In the last 60 days the scam shield held their post for review.' });
  const flagCodes = [...new Set(theirFlags.flatMap((m) => (m.flags || []).map((f) => f.code)))];
  if (flagCodes.length) warnings.push({ id: 'messages', label: 'Risky messages in this chat', detail: `They’ve sent ${theirFlags.length} message${theirFlags.length === 1 ? '' : 's'} here matching scam patterns (${flagCodes.map((c) => c.replace(/_/g, ' ')).join(', ')}).` });
  if (daysSince(u.createdAt) !== null && daysSince(u.createdAt) < 3 && !checks.some((c) => c.ok && c.id !== 'email')) warnings.push({ id: 'new', label: 'Brand-new account', detail: 'Created in the last 3 days with nothing verified yet.' });

  const strongCount = checks.filter((c) => c.ok && ['identity', 'work', 'payout'].includes(c.id)).length;
  const level = warnings.some((w) => ['reported', 'held', 'messages'].includes(w.id)) ? 'warn' : checks[0].ok && strongCount >= 2 ? 'strong' : strongCount >= 1 ? 'some' : 'none';
  const calls = (convo.callChecks || []).filter((c) => String(c.of) === String(u._id)).sort((a, b) => new Date(b.at) - new Date(a.at));

  return {
    user: { _id: u._id, name: u.name, since: u.createdAt, age: age(u.createdAt) },
    level,
    checks,
    warnings,
    record: {
      asClient: rep.asClient ? { responseRate: rep.asClient.responseRate ?? null, avgPayDays: rep.asClient.avgPayDays ?? null, hires: rep.asClient.hires || 0, disputesLost: rep.asClient.disputesLost || 0 } : null,
      asFreelancer: rep.asFreelancer ? { completed: rep.asFreelancer.completed || 0, onTimeRate: rep.asFreelancer.onTimeRate ?? null, disputesLost: rep.asFreelancer.disputesLost || 0 } : null,
    },
    together: { contracts: together.length, completed: together.filter((c) => c.status === 'completed').length },
    callCheckedAt: calls[0]?.at || null,
    callCheckedBy: calls[0] ? String(calls[0].by) : null,
  };
}

module.exports = { summary, callCode, codeMatches, isWorkDomain, domainOf, FREE_DOMAINS, WINDOW_MS };
