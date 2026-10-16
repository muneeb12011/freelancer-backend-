// utils/tokens.js — JWT + session issuing, and hashing for one-time tokens.
const crypto  = require('crypto');
const jwt     = require('jsonwebtoken');
const env     = require('../config/env');
const Session = require('../models/Session');

const sha256 = (v) => crypto.createHash('sha256').update(String(v)).digest('hex');
const randomToken = (bytes = 32) => crypto.randomBytes(bytes).toString('hex');
const randomCode  = () => String(crypto.randomInt(0, 1000000)).padStart(6, '0');

function safeEqual(a, b) {
  const A = Buffer.from(String(a || ''));
  const B = Buffer.from(String(b || ''));
  return A.length === B.length && crypto.timingSafeEqual(A, B);
}

function parseExpiry(str) {
  const m = /^(\d+)([smhd])$/.exec(str || '7d');
  if (!m) return 7 * 86400e3;
  return Number(m[1]) * { s: 1e3, m: 60e3, h: 3600e3, d: 86400e3 }[m[2]];
}

function describeDevice(ua = '') {
  const browser = /Edg\//.test(ua) ? 'Edge' : /Chrome\//.test(ua) ? 'Chrome' : /Firefox\//.test(ua) ? 'Firefox'
    : /Safari\//.test(ua) ? 'Safari' : 'Browser';
  const os = /Windows/.test(ua) ? 'Windows' : /Android/.test(ua) ? 'Android' : /iPhone|iPad/.test(ua) ? 'iOS'
    : /Mac OS X/.test(ua) ? 'macOS' : /Linux/.test(ua) ? 'Linux' : 'Unknown OS';
  return `${browser} on ${os}`;
}

/** Create a session row and the JWT that points at it. */
async function issueSession(user, req, method = 'password') {
  const ttl = parseExpiry(env.JWT_EXPIRES_IN);
  const ua  = String(req.headers['user-agent'] || '').slice(0, 300);
  const session = await Session.create({
    user: user._id,
    userAgent: ua,
    device: describeDevice(ua),
    ip: req.ip,
    method,
    expiresAt: new Date(Date.now() + ttl),
  });
  const token = jwt.sign(
    { id: String(user._id), sid: String(session._id), v: user.tokenVersion || 0 },
    env.JWT_SECRET,
    { expiresIn: Math.floor(ttl / 1000) },
  );
  return { token, session };
}

module.exports = { sha256, randomToken, randomCode, safeEqual, issueSession, describeDevice };
