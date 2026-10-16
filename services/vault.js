// services/vault.js — AES-256-GCM encryption for sensitive uploads (identity documents).
// Key: VERIFICATION_KEY = 64 hex chars (32 bytes). Generate with:
//   node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
const crypto = require('crypto');
const env = require('../config/env');

function key() {
  const k = env.VERIFICATION_KEY;
  if (!/^[0-9a-f]{64}$/i.test(k || '')) return null;
  return Buffer.from(k, 'hex');
}

const enabled = () => Boolean(key());

function encrypt(buf) {
  const k = key();
  if (!k) throw Object.assign(new Error('Identity verification is not configured (VERIFICATION_KEY).'), { statusCode: 503 });
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', k, iv);
  const data = Buffer.concat([cipher.update(buf), cipher.final()]);
  return { iv, tag: cipher.getAuthTag(), data };
}

function decrypt({ iv, tag, data }) {
  const decipher = crypto.createDecipheriv('aes-256-gcm', key(), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(data), decipher.final()]);
}

module.exports = { enabled, encrypt, decrypt };
