// services/payouts.js — validation, masking and encryption for payout methods.
const crypto = require('crypto');
const vault = require('./vault');
const { badRequest } = require('../utils/http');
const { str, isEmail } = require('../utils/sanitize');

const TYPES = ['bank', 'payoneer', 'wise', 'card'];
const LABEL = { bank: 'Bank transfer', payoneer: 'Payoneer', wise: 'Wise', card: 'Visa / Mastercard' };

/** ISO 13616 IBAN check: move first 4 chars to the end, letters → numbers, mod 97 must equal 1. */
function ibanValid(raw) {
  const iban = String(raw || '').replace(/\s+/g, '').toUpperCase();
  if (!/^[A-Z]{2}\d{2}[A-Z0-9]{10,30}$/.test(iban)) return false;
  if (iban.startsWith('PK') && iban.length !== 24) return false;
  const moved = iban.slice(4) + iban.slice(0, 4);
  let rem = 0;
  for (const ch of moved) {
    const v = /\d/.test(ch) ? ch : String(ch.charCodeAt(0) - 55);
    for (const d of v) rem = (rem * 10 + Number(d)) % 97;
  }
  return rem === 1;
}

const maskEmail = (e) => {
  const [u, d] = String(e).split('@');
  return `${u.slice(0, 1)}${'•'.repeat(Math.max(2, Math.min(5, u.length - 1)))}@${d}`;
};

/** Normalise a person's name for comparison: lowercase letters only, as a sorted token set. */
const nameTokens = (n) => String(n || '').toLowerCase().normalize('NFKD').replace(/[^a-z\s]/g, ' ').split(/\s+/).filter((t) => t.length > 1 && !['mr', 'mrs', 'ms', 'miss', 'dr', 'muhammad', 'mohammad', 'muhammed', 'syed', 'bin', 'binte'].includes(t));

/** True when one name's meaningful parts are all contained in the other (order-insensitive). */
function namesMatch(a, b) {
  const A = new Set(nameTokens(a));
  const B = new Set(nameTokens(b));
  if (!A.size || !B.size) return false;
  const [small, big] = A.size <= B.size ? [A, B] : [B, A];
  return [...small].every((t) => big.has(t)) && small.size >= Math.min(2, big.size);
}

/**
 * Turn user input into { doc fields, secret object }. Throws a clear 400 on bad input.
 * Cards: the browser sends only brand + last4 + expiry. A full number is rejected outright.
 */
function prepare(body) {
  const type = body.type;
  if (!TYPES.includes(type)) throw badRequest('Choose a payout type');
  const holderName = str(body.holderName, 120);
  if (holderName.length < 3) throw badRequest('Enter the account holder’s full name, exactly as the bank or provider has it');
  const country = str(body.country, 60);
  const currency = (str(body.currency, 3) || 'USD').toUpperCase();

  if (type === 'bank') {
    const bankName = str(body.bankName, 80);
    if (!bankName) throw badRequest('Enter the bank name');
    const iban = str(body.iban, 40).replace(/\s+/g, '').toUpperCase();
    const accountNumber = str(body.accountNumber, 34).replace(/\s+/g, '');
    const swift = str(body.swift, 11).replace(/\s+/g, '').toUpperCase();
    if (!iban && !accountNumber) throw badRequest('Enter the IBAN (or the account number if your country has no IBAN)');
    if (iban && !ibanValid(iban)) throw badRequest('That IBAN doesn’t pass the checksum. Check each character — Pakistani IBANs are 24 characters starting with PK.');
    if (accountNumber && !/^[A-Z0-9-]{6,34}$/i.test(accountNumber)) throw badRequest('The account number should be 6–34 letters or digits');
    if (swift && !/^[A-Z]{6}[A-Z0-9]{2}([A-Z0-9]{3})?$/.test(swift)) throw badRequest('A SWIFT/BIC code is 8 or 11 characters, like MEZNPKKA');
    const ref = iban || accountNumber;
    return {
      doc: { type, holderName, country: country || (iban ? iban.slice(0, 2) : ''), currency, brand: bankName, last4: ref.slice(-4), display: `${bankName} ••••${ref.slice(-4)}` },
      secret: { bankName, iban, accountNumber, swift, branch: str(body.branch, 120) },
    };
  }

  if (type === 'payoneer' || type === 'wise') {
    const email = str(body.email, 254).toLowerCase();
    if (!isEmail(email)) throw badRequest(`Enter the email address of your ${LABEL[type]} account`);
    return {
      doc: { type, holderName, country, currency, brand: LABEL[type], display: `${LABEL[type]} · ${maskEmail(email)}` },
      secret: { email, customerId: str(body.customerId, 40) },
    };
  }

  // card
  if (body.number || body.cardNumber || body.cvv || body.cvc) throw badRequest('Never send a full card number or CVV. Only the brand and last four digits are needed.');
  const brand = String(body.brand || '').toLowerCase();
  if (!['visa', 'mastercard'].includes(brand)) throw badRequest('Choose Visa or Mastercard');
  const last4 = String(body.last4 || '');
  if (!/^\d{4}$/.test(last4)) throw badRequest('Enter the last four digits of the card');
  const m = Number(body.expMonth); const y = Number(body.expYear);
  const now = new Date();
  if (!(m >= 1 && m <= 12) || !(y >= now.getFullYear() && y <= now.getFullYear() + 15) || (y === now.getFullYear() && m < now.getMonth() + 1)) throw badRequest('Enter a valid, unexpired expiry date');
  const B = brand === 'visa' ? 'Visa' : 'Mastercard';
  return {
    doc: { type, holderName, country, currency, brand: B, last4, display: `${B} ••••${last4} · exp ${String(m).padStart(2, '0')}/${String(y).slice(-2)}` },
    secret: null,
  };
}

function seal(obj) { return obj ? vault.encrypt(Buffer.from(JSON.stringify(obj))) : undefined; }

function open(blob) {
  if (!blob?.data) return null;
  // Works for Node Buffers (hydrated docs) and BSON Binary values (lean docs).
  const b = (x) => {
    if (Buffer.isBuffer(x)) return x;
    if (x?.buffer && Buffer.isBuffer(x.buffer)) return x.buffer;
    if (x?.buffer) return Buffer.from(x.buffer);
    return Buffer.from(x);
  };
  return JSON.parse(vault.decrypt({ iv: b(blob.iv), tag: b(blob.tag), data: b(blob.data) }).toString('utf8'));
}

/** The shape everyone except the owner/shared client sees. */
function shape(m) {
  return {
    _id: m._id, type: m.type, label: LABEL[m.type], holderName: m.holderName, country: m.country, currency: m.currency,
    display: m.display, brand: m.brand, last4: m.last4, status: m.status, reviewNote: m.reviewNote,
    emailConfirmed: Boolean(m.emailCheck?.confirmedAt), nameMatches: m.nameMatches, isDefault: m.isDefault,
    submittedAt: m.submittedAt, reviewedAt: m.reviewedAt, createdAt: m.createdAt,
  };
}

const codeHash = (code) => crypto.createHash('sha256').update(String(code)).digest('hex');

module.exports = { TYPES, LABEL, ibanValid, namesMatch, prepare, seal, open, shape, codeHash, maskEmail };
