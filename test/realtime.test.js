// test/realtime.test.js — Pusher signing, private-channel rules, and events on real actions.
process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-that-is-long-enough-for-hs256-signing';
process.env.MONGO_URI = (process.env.MONGO_URI || '').replace(/\/[^/]*$/, '/aurelance_realtime_test');

const test = require('node:test');
const assert = require('node:assert/strict');
const https = require('https');
const crypto = require('crypto');
const request = require('supertest');
const mongoose = require('mongoose');
const app = require('../app');
const realtime = require('../services/realtime');

const api = request(app);
const auth = (t) => ({ Authorization: `Bearer ${t}` });
let A; let B;
const reg = async (name, email) => {
  const r = await api.post('/api/auth/register').send({ name, email, password: 'correct-horse-9' });
  assert.equal(r.status, 201, r.text);
  await mongoose.model('User').updateOne({ email }, { emailVerified: true });
  return r.body;
};
const on = () => Object.assign(process.env, { PUSHER_APP_ID: '3', PUSHER_KEY: 'test-key', PUSHER_SECRET: 'test-secret', PUSHER_CLUSTER: 'ap2' });
const off = () => { for (const k of ['PUSHER_APP_ID', 'PUSHER_KEY', 'PUSHER_SECRET', 'PUSHER_CLUSTER']) delete process.env[k]; };

// Capture outgoing Pusher calls instead of sending them.
let sent = [];
const realRequest = https.request;
function capture() {
  sent = [];
  https.request = (opts, cb) => {
    let body = '';
    const req = new (require('events'))();
    req.on = req.addListener.bind(req);
    req.destroy = () => {};
    req.end = (b) => { body = b; sent.push({ opts, body: JSON.parse(b) }); setImmediate(() => cb({ statusCode: 200, resume() {} })); };
    return req;
  };
}

test.before(async () => {
  await mongoose.connect(process.env.MONGO_URI);
  await mongoose.connection.db.dropDatabase();
  A = await reg('Hina Javed', 'hina@example.com');
  B = await reg('Faisal Noor', 'faisal@example.com');
});
test.after(async () => { https.request = realRequest; off(); await mongoose.disconnect(); });

test('HMAC matches Pusher’s published example', () => {
  // From Pusher's "authorizing users" docs.
  assert.equal(realtime.sign('7ad3773142a6692b25b8', '1234.1234:private-foobar'), '58df8b0c36d6982b82c3ecf6b4662e34fe8c25bba48f5369f135bf843651c3a4');
});

test('switched off: config says so, auth refuses, nothing is sent', async () => {
  off();
  const c = await api.get('/api/realtime/config');
  assert.deepEqual(c.body, { enabled: false });
  const a = await api.post('/api/realtime/auth').set(auth(A.token)).send({ socket_id: '1.2', channel_name: `private-user-${A.user._id}` });
  assert.equal(a.status, 403);
  assert.equal(await realtime.toUsers([A.user._id], 'notification', {}), false);
});

test('switched on: only your own channel can be authorised', async () => {
  on();
  const c = await api.get('/api/realtime/config');
  assert.deepEqual(c.body, { enabled: true, key: 'test-key', cluster: 'ap2' });
  assert.ok(!('secret' in c.body));
  const ch = `private-user-${A.user._id}`;
  const ok = await api.post('/api/realtime/auth').set(auth(A.token)).send({ socket_id: '123.456', channel_name: ch });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.auth, `test-key:${crypto.createHmac('sha256', 'test-secret').update(`123.456:${ch}`).digest('hex')}`);
  const theirs = await api.post('/api/realtime/auth').set(auth(B.token)).send({ socket_id: '123.456', channel_name: ch });
  assert.equal(theirs.status, 403, 'can’t listen to someone else');
  const junk = await api.post('/api/realtime/auth').set(auth(A.token)).send({ socket_id: 'x', channel_name: ch });
  assert.equal(junk.status, 403);
  const anon = await api.post('/api/realtime/auth').send({ socket_id: '1.2', channel_name: ch });
  assert.equal(anon.status, 401);
});

test('a message pings both people with ids only; requests are signed', async () => {
  on(); capture();
  const convo = await api.post('/api/messages/conversations').set(auth(A.token)).send({ userId: B.user._id });
  assert.ok([200, 201].includes(convo.status), convo.text);
  const cid = convo.body.conversation._id;
  sent = [];
  const m = await api.post(`/api/messages/conversations/${cid}/messages`).set(auth(A.token)).send({ text: 'The secret recipe is cardamom' });
  assert.ok([200, 201].includes(m.status), m.text);
  await new Promise((r) => setImmediate(r));
  const ev = sent.find((x) => x.body.name === 'message');
  assert.ok(ev, 'message event sent');
  assert.deepEqual(ev.body.channels.sort(), [`private-user-${A.user._id}`, `private-user-${B.user._id}`].sort());
  assert.ok(!ev.body.data.includes('cardamom'), 'message text never goes to Pusher');
  assert.equal(ev.opts.host, 'api-ap2.pusher.com');
  // Re-derive the signature from the request the way Pusher does.
  const [path, qs] = ev.opts.path.split('?');
  const params = Object.fromEntries(new URLSearchParams(qs));
  const { auth_signature: sig, ...rest } = params;
  const toSign = Object.keys(rest).sort().map((k) => `${k}=${rest[k]}`).join('&');
  assert.equal(sig, crypto.createHmac('sha256', 'test-secret').update(`POST\n${path}\n${toSign}`).digest('hex'));
  assert.equal(params.body_md5, crypto.createHash('md5').update(JSON.stringify(ev.body)).digest('hex'));
});

test('a notification pings only its recipient', async () => {
  on(); capture();
  await require('../services/notify').push(B.user._id, { type: 'contract', title: 'Test', actor: A.user._id });
  await new Promise((r) => setImmediate(r));
  const ev = sent.find((x) => x.body.name === 'notification');
  assert.deepEqual(ev.body.channels, [`private-user-${B.user._id}`]);
});
