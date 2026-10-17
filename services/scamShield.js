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
    re: /\b(whats\s?app|watsapp|telegram|t\.me\/|signal app|wechat|skype id|imo\b|viber|contact me (?:on|at|via)|text me (?:on|at)|dm me on|add me on)\b/i,
  },
  {
    code: 'contact_details', weight: 2,
    label: 'Contains a phone number or email address',
    tip: 'Contact details in a post are often used to pull people away from the platform.',
    test: (t) => /(\+?\d[\d\s-]{9,}\d)/.test(t.replace(/\b(19|20)\d{2}\b/g, '')) || /[\w.+-]+@[\w-]+\.[\w.]{2,}/.test(t),
  },
  {
    code: 'upfront_fee', weight: 4,
    label: 'Asks you to pay before you start',
    tip: 'Real clients never charge you a registration, training, security or "activation" fee.',
    re: /\b((registration|joining|security|training|activation|processing|admin(?:istration)?|starter|kit)\s+(fee|charges?|deposit)|refundable (fee|deposit|amount)|pay (?:a |the )?(?:small )?(fee|deposit) (?:first|before|to start)|deposit (?:first|before)|buy (?:our|the) (?:kit|course|software) (?:first|to start))\b/i,
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

/**
 * @returns {{ score:number, flags:{code:string,label:string,tip:string}[] }}
 */
function analyze(...parts) {
  const text = parts.filter(Boolean).join('\n').slice(0, 20000);
  const flags = [];
  let score = 0;
  for (const r of RULES) {
    const hit = r.test ? r.test(text) : r.re.test(text);
    if (hit) { flags.push({ code: r.code, label: r.label, tip: r.tip }); score += r.weight; }
  }
  return { score, flags };
}

/** Decide what happens to a job post. */
function verdictForJob(score) {
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

module.exports = { analyze, verdictForJob, containsCardNumber, RULES };
