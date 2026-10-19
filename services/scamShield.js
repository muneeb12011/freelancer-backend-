// services/scamShield.js — spots the patterns behind most freelance scams:
// moving the conversation off-platform, asking for money up front, fishing for documents or
// banking secrets, crypto/cheque tricks, and "easy money" bait.
// Used on job posts (score decides whether a post goes live, gets a warning, or waits for review)
// and on messages (the recipient sees a caution note under a flagged message).

const RULES = [
  {
    code: 'off_platform', weight: 2,
    label: 'Asks to move the conversation off Aurelance',
    tip: 'Keep talks and agreements here. Scammers move you to WhatsApp or Telegram so there is no record.',
    re: /\b(whats\s?app|watsapp|whtsapp|wa\.me\/|telegram|tele gram|t\.me\/|signal app|wechat|skype id|imo\b|viber|contact me (?:on|at|via)|text me (?:on|at)|dm me on|add me on|(?:whatsapp|number) (?:pe|par|py) (?:rabta|contact|msg|message)|apna number (?:do|den|bhejo|send))\b/i,
  },
  {
    code: 'contact_details', weight: 2,
    label: 'Contains a phone number or email address',
    tip: 'Contact details in a post are often used to pull people away from the platform.',
    // A phone number: 10–15 digits in one run, mostly digits (so "1 - 2 - 3 - 4" lists and dates don't count).
    test: (t) => (t.match(/\+?\d[\d\s().-]{8,}\d/g) || []).some((m) => { const d = m.replace(/\D/g, '').length; return d >= 10 && d <= 15 && d / m.replace(/\s/g, '').length >= 0.75 && !/^\d{1,2}[-./]\d{1,2}[-./]\d{2,4}/.test(m.trim()); })
      || /[\w.+-]+@[\w-]+\.[\w.]{2,}/.test(t),
  },
  {
    code: 'upfront_fee', weight: 4,
    label: 'Asks you to pay before you start',
    tip: 'Real clients never charge you a registration, training, security or "activation" fee.',
    re: /\b((registration|joining|security|training|activation|processing|admin(?:istration)?|starter|kit)\s+(fee|charges?|deposit)|refundable (fee|deposit|amount)|pay (?:a |the )?(?:small )?(fee|deposit) (?:first|before|to start)|deposit (?:first|before)|buy (?:our|the) (?:kit|course|software) (?:first|to start)|(?:registration|security) fees? (?:jama|deni|dena|send)|pehle (?:payment|fees?|paise) (?:karo|karen|bhejo|do|den)|fees? jama (?:karwa|kara)(?:ni|en|o))\b/i,
  },
  {
    code: 'personal_data', weight: 3,
    label: 'Asks for ID documents or banking secrets',
    tip: 'Never share your CNIC/passport copy, OTP codes, card CVV, PIN or online-banking password with a client.',
    re: /\b(send (?:me )?(?:your )?(?:cnic|passport|id card|nic) (?:copy|picture|photo|scan)|(?:cnic|passport) copy|\botp\b|one[- ]time (?:code|password)|cvv|cvc|card pin|atm pin|bank(?:ing)? (?:login|password|username)|net ?banking password|verification code you (?:get|receive))\b/i,
  },
  {
    code: 'crypto_cheque', weight: 3,
    label: 'Crypto, gift-card or cheque payment',
    tip: 'Overpaying by cheque and asking for change back, or paying in gift cards or crypto to a "manager", are classic scams.',
    re: /\b(usdt|bitcoin|btc wallet|crypto wallet|binance (?:id|pay)|gift ?cards?|itunes card|send (?:you )?a (?:cheque|check)|deposit (?:the|a) (?:cheque|check)|send (?:back|the) (?:difference|remaining|extra))\b/i,
  },
  {
    code: 'easy_money', weight: 2,
    label: 'Promises easy money',
    tip: 'Guaranteed daily earnings for simple typing, liking or data entry are almost always bait.',
    re: /\b(earn (?:\$|rs\.?|pkr)?\s?\d[\d,]*\s?(?:\+\s?)?(?:per|a|\/) ?(?:day|hour)|guaranteed (?:income|earnings|profit)|no experience (?:needed|required).{0,40}(?:earn|\$|rs)|simple typing job|like and earn|work from home and earn|daily payout guaranteed)\b/i,
  },
];

// ── Evasion-resistant text ────────────────────────────────────────────────
// Scammers dodge keyword filters with "w h a t s a p p", "wh@tsapp", Cyrillic look-alikes,
// zero-width characters and numbers written out as words. Every rule runs against the original
// text and these normalised versions, so one spelling trick doesn't get a post past the shield.
const HOMOGLYPHS = { а: 'a', е: 'e', о: 'o', р: 'p', с: 'c', х: 'x', у: 'y', і: 'i', ј: 'j', ԁ: 'd', ɡ: 'g', ո: 'n', ѕ: 's', ᴡ: 'w', 'ο': 'o', 'α': 'a', 'ε': 'e', 'ν': 'v', 'τ': 't' };
const LEET = { 0: 'o', 1: 'i', 3: 'e', 4: 'a', 5: 's', 7: 't', '@': 'a', $: 's', '!': 'i' };
const NUM_WORDS = { zero: 0, oh: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ek: 1, do: 2, teen: 3, char: 4, panch: 5, chay: 6, saat: 7, aath: 8, nau: 9, sifar: 0 };

function base(text) {
  return String(text || '')
    .normalize('NFKC')
    .replace(/[\u200B-\u200D\u2060\uFEFF\u00AD]/g, '')            // zero-width + soft hyphen
    .replace(/[^\u0000-\u007F]/g, (ch) => HOMOGLYPHS[ch.toLowerCase()] || ch);
}
/** "w h a t s a p p", "w.a.t.s.a.p.p", "t-e-l-e-g-r-a-m" → joined. Only runs of 4+ single letters. */
const squash = (t) => t.replace(/\b(?:[a-z@$0-9][\s._*\-|]{1,3}){3,}[a-z@$0-9]\b/gi, (m) => m.replace(/[\s._*\-|]/g, ''));
const deleet = (t) => t.replace(/[a-z]*[0-9@$!][a-z0-9@$!]*/gi, (w) => (/[a-z]/i.test(w) ? w.replace(/[013457@$!]/g, (c) => LEET[c]) : w));
/** "zero three zero zero one two..." → "0300 12..." so spelled-out phone numbers are caught. */
const wordsToDigits = (t) => t.replace(/\b(?:zero|oh|one|two|three|four|five|six|seven|eight|nine|sifar|ek|teen|char|panch|chay|saat|aath|nau)(?:[\s,-]+(?:zero|oh|one|two|three|four|five|six|seven|eight|nine|sifar|ek|do|teen|char|panch|chay|saat|aath|nau)){6,}\b/gi, (m) => m.split(/[\s,-]+/).map((w) => NUM_WORDS[w.toLowerCase()]).join(''));

function variants(raw) {
  const b = base(raw);
  const sq = squash(b);
  const out = new Set([raw, b, sq, deleet(sq), wordsToDigits(b)]);
  return [...out];
}

/**
 * @returns {{ score:number, flags:{code:string,label:string,tip:string}[], evasion:boolean }}
 */
function analyze(...parts) {
  const raw = parts.filter(Boolean).join('\n').slice(0, 20000);
  const vs = variants(raw);
  const flags = [];
  let score = 0; let evasion = false;
  for (const r of RULES) {
    const test = (t) => (r.test ? r.test(t) : r.re.test(t));
    if (test(raw)) { flags.push({ code: r.code, label: r.label, tip: r.tip }); score += r.weight; continue; }
    if (vs.some(test)) { flags.push({ code: r.code, label: r.label, tip: r.tip }); score += r.weight; evasion = true; }
  }
  // Disguising a phrase is itself a signal: honest posts don't spell "w h a t s a p p".
  if (evasion) { flags.push({ code: 'disguised', label: 'Hides words to get past filters', tip: 'Spacing letters out or swapping in symbols is a common way to sneak contact details or fee requests past checks.' }); score += 2; }
  return { score, flags, evasion };
}

// ── The poster's history ───────────────────────────────────────────────────
// Text rules judge one post. These judge the person: someone whose posts keep getting held, or who
// several different people have reported, gets a lower bar — any flag at all sends their post to review.
const HISTORY_DAYS = 60;
const riskCache = new Map(); // userId → { at, value } — messages check this on every send
async function posterRisk(userId, { cached = false } = {}) {
  if (!userId) return { priorHeld: 0, reporters: 0, risky: false };
  const hit = cached && riskCache.get(String(userId));
  if (hit && Date.now() - hit.at < 5 * 60e3) return hit.value;
  const value = await computeRisk(userId);
  if (riskCache.size > 5000) riskCache.clear();
  riskCache.set(String(userId), { at: Date.now(), value });
  return value;
}
async function computeRisk(userId) {
  const Job = require('../models/Job');
  const Report = require('../models/Report');
  const since = new Date(Date.now() - HISTORY_DAYS * 86400e3);
  const [priorHeld, reporters] = await Promise.all([
    Job.countDocuments({ postedBy: userId, 'safety.verdict': 'held', createdAt: { $gte: since } }),
    // Only reporters with a confirmed email and an account older than 3 days count, so a handful of
    // throwaway accounts can't knock a real client offline.
    Report.distinct('by', { subject: userId, status: { $in: ['open', 'actioned'] }, createdAt: { $gte: since } })
      .then((ids) => (ids.length ? require('../models/User').countDocuments({ _id: { $in: ids }, emailVerified: true, createdAt: { $lte: new Date(Date.now() - 3 * 86400e3) } }) : 0)),
  ]);
  return { priorHeld, reporters, risky: priorHeld >= 2 || reporters >= 3 };
}

/** Decide what happens to a job post. */
function verdictForJob(score, risk) {
  if (risk?.risky && score >= 2) return 'held'; // repeat offender: any real flag goes to review
  if (score >= 5) return 'held';  // waits for an admin before anyone sees it
  if (score >= 2) return 'warn';  // visible, with a warning to applicants
  return 'clear';
}

/** Luhn check — used to stop people pasting full card numbers into chat. */
function containsCardNumber(text) {
  const candidates = String(text || '').match(/\b(?:\d[ -]?){13,19}\b/g) || [];
  return candidates.some((c) => {
    const digits = c.replace(/\D/g, '');
    if (digits.length < 13 || digits.length > 19) return false;
    let sum = 0; let dbl = false;
    for (let i = digits.length - 1; i >= 0; i -= 1) {
      let d = Number(digits[i]);
      if (dbl) { d *= 2; if (d > 9) d -= 9; }
      sum += d; dbl = !dbl;
    }
    return sum % 10 === 0 && /^[3-6]/.test(digits);
  });
}

module.exports = { analyze, verdictForJob, containsCardNumber, posterRisk, variants, RULES };
