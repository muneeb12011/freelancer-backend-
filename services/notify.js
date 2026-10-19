// services/notify.js — writes to the bell. Never throws: a failed notification must not fail the action.
const Notification = require('../models/Notification');
const logger = require('../utils/logger');
const realtime = require('./realtime');

/**
 * push(userId, { type, title, body?, link?, actor? })
 * Skips notifying people about their own actions.
 */
async function push(userId, n) {
  if (!userId || (n.actor && String(n.actor) === String(userId))) return null;
  try {
    const doc = await Notification.create({
      user: userId, type: n.type, title: String(n.title).slice(0, 160), body: String(n.body || '').slice(0, 400), link: n.link || '', actor: n.actor,
    });
    realtime.toUsers([userId], 'notification', { type: n.type });
    return doc;
  } catch (err) {
    logger.warn(`notify failed (${n.type}): ${err.message}`);
    return null;
  }
}

const pushMany = (ids, n) => Promise.all([...new Set((ids || []).map(String))].map((id) => push(id, n)));

module.exports = { push, pushMany };
