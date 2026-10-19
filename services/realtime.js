// services/realtime.js — instant updates through Pusher Channels, when it's configured.
// Vercel's serverless functions can't hold WebSockets, so the server sends events to Pusher over
// its signed HTTP API and browsers keep the socket open with Pusher instead.
//
// Privacy: events only say *that* something changed ("notification", "message in conversation X");
// the browser then fetches the content from our API with its own token. Message text and
// notification bodies never pass through Pusher.
//
// Not configured (no PUSHER_* env vars) → every call here is a no-op and the app keeps polling.
const crypto = require('crypto');
const https = require('https');
const env = require('../config/env');
const logger = require('../utils/logger');

const cfg = () => ({
  appId: process.env.PUSHER_APP_ID || env.PUSHER_APP_ID || '',
  key: process.env.PUSHER_KEY || env.PUSHER_KEY || '',
  secret: process.env.PUSHER_SECRET || env.PUSHER_SECRET || '',
  cluster: process.env.PUSHER_CLUSTER || env.PUSHER_CLUSTER || '',
});
const enabled = () => { const c = cfg(); return Boolean(c.appId && c.key && c.secret && c.cluster); };
const userChannel = (userId) => `private-user-${userId}`;

const hmac = (secret, s) => crypto.createHmac('sha256', secret).update(s).digest('hex');

/** Signed query string for Pusher's REST API (auth_version 1.0). */
function signedQuery(method, path, body, { key, secret }, now = Math.floor(Date.now() / 1000)) {
  const params = { auth_key: key, auth_timestamp: String(now), auth_version: '1.0' };
  if (body) params.body_md5 = crypto.createHash('md5').update(body).digest('hex');
  const qs = Object.keys(params).sort().map((k) => `${k}=${params[k]}`).join('&');
  return `${qs}&auth_signature=${hmac(secret, `${method}\n${path}\n${qs}`)}`;
}

/** Send one event to up to 100 channels. Never throws; resolves false if it didn't go out. */
function trigger(channels, event, data = {}) {
  if (!enabled()) return Promise.resolve(false);
  return require('../utils/background').keepAlive(send(channels, event, data));
}

function send(channels, event, data) {
  const list = [...new Set((Array.isArray(channels) ? channels : [channels]).filter(Boolean))].slice(0, 100);
  if (!list.length) return Promise.resolve(false);
  const c = cfg();
  const path = `/apps/${c.appId}/events`;
  const body = JSON.stringify({ name: event, channels: list, data: JSON.stringify(data) });
  const query = signedQuery('POST', path, body, c);
  return new Promise((resolve) => {
    const req = https.request({
      host: `api-${c.cluster}.pusher.com`, path: `${path}?${query}`, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }, timeout: 3000,
    }, (res) => {
      res.resume();
      if (res.statusCode >= 300) logger.warn(`realtime: Pusher answered ${res.statusCode} for ${event}`);
      resolve(res.statusCode < 300);
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', (err) => { logger.warn(`realtime: ${err.message}`); resolve(false); });
    req.end(body);
  });
}

/** Tell these users something changed. */
const toUsers = (userIds, event, data) => trigger((userIds || []).map((id) => userChannel(String(id))), event, data);

/** Signature for a private channel subscription; only your own user channel is allowed. */
function authorize(userId, socketId, channelName) {
  if (!enabled()) return null;
  if (!/^\d+\.\d+$/.test(String(socketId || ''))) return null;
  if (channelName !== userChannel(String(userId))) return null;
  const { key, secret } = cfg();
  return { auth: `${key}:${hmac(secret, `${socketId}:${channelName}`)}` };
}

const publicConfig = () => (enabled() ? { enabled: true, key: cfg().key, cluster: cfg().cluster } : { enabled: false });

module.exports = { enabled, trigger, toUsers, authorize, publicConfig, userChannel, signedQuery, sign: hmac };
