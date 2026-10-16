// middleware/auth.js — JWT + server-side session verification, plan gating.
const jwt     = require('jsonwebtoken');
const env     = require('../config/env');
const User    = require('../models/User');
const Session = require('../models/Session');
const { PREMIUM_FEATURES } = require('../config/plans');

const TOUCH_EVERY_MS = 5 * 60 * 1000;

function readToken(req) {
  const h = req.headers.authorization || '';
  if (h.startsWith('Bearer ')) return h.slice(7).trim();
  return null;
}

async function resolveUser(token) {
  const decoded = jwt.verify(token, env.JWT_SECRET);
  const user = await User.findById(decoded.id);
  if (!user) return { error: 'Account not found' };
  if ((decoded.v || 0) !== (user.tokenVersion || 0)) return { error: 'Session expired — please sign in again' };

  let session = null;
  if (decoded.sid) {
    session = await Session.findById(decoded.sid);
    if (!session || session.revokedAt || String(session.user) !== String(user._id)) {
      return { error: 'Session was signed out' };
    }
    if (Date.now() - new Date(session.lastSeenAt).getTime() > TOUCH_EVERY_MS) {
      Session.updateOne({ _id: session._id }, { lastSeenAt: new Date() }).catch(() => {});
    }
  }
  return { user, session };
}

const protect = async (req, res, next) => {
  const token = readToken(req);
  if (!token) return res.status(401).json({ error: 'Not signed in', code: 'NO_TOKEN' });
  try {
    const { user, session, error } = await resolveUser(token);
    if (error) return res.status(401).json({ error, code: 'SESSION_INVALID' });
    req.user = user;
    req.session = session;
    req.plan = user.effectivePlan;
    return next();
  } catch (err) {
    if (err.name === 'TokenExpiredError' || err.name === 'JsonWebTokenError') {
      return res.status(401).json({ error: 'Session expired — please sign in again', code: 'TOKEN_INVALID' });
    }
    return next(err);
  }
};

/** Attach the user if a valid token is present, but never reject. */
const optionalAuth = async (req, res, next) => {
  const token = readToken(req);
  if (!token) return next();
  try {
    const { user, session } = await resolveUser(token);
    if (user) { req.user = user; req.session = session; req.plan = user.effectivePlan; }
  } catch { /* ignore */ }
  return next();
};

const requirePremium = (feature) => (req, res, next) => {
  if (req.plan === 'premium') return next();
  return res.status(402).json({
    error: 'This feature is part of Premium.',
    code: 'PREMIUM_REQUIRED',
    feature,
    upgradeUrl: '/billing',
  });
};

const isPremiumFeature = (f) => PREMIUM_FEATURES.includes(f);

const requireAdmin = (req, res, next) => {
  if (req.user && env.ADMIN_EMAILS.includes(String(req.user.email).toLowerCase())) return next();
  return res.status(403).json({ error: 'Admins only' });
};

module.exports = { protect, optionalAuth, requirePremium, requireAdmin, isPremiumFeature };
