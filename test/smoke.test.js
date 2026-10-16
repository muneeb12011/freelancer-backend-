// test/smoke.test.js — end-to-end API smoke test.
// Run against a throwaway database:  MONGO_URI=mongodb://127.0.0.1:27017/aurelance_test npm test
process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-that-is-long-enough-for-hs256-signing';
process.env.SAFEPAY_SECRET_KEY = 'sp_secret_test';
process.env.SAFEPAY_WEBHOOK_SECRET = 'sp_webhook_test';
process.env.SAFEPAY_API_KEY = 'sp_key_test';

const test     = require('node:test');
const assert   = require('node:assert/strict');
const crypto   = require('node:crypto');
const request  = require('supertest');
const mongoose = require('mongoose');
const app      = require('../app');

const api = request(app);
let A; let B; // { token, user }

const register = async (name, email) => {
  const r = await api.post('/api/auth/register').send({ name, email, password: 'correct-horse-9' });
  assert.equal(r.status, 201, r.text);
  return r.body;
};
const auth = (t) => ({ Authorization: `Bearer ${t}` });

test.before(async () => {
  await mongoose.connect(process.env.MONGO_URI);
  await mongoose.connection.db.dropDatabase();
});
test.after(async () => { await mongoose.disconnect(); });

test('health', async () => {
  const r = await api.get('/api/health');
  assert.equal(r.status, 200);
  assert.equal(r.body.status, 'ok');
});

test('register + login + me', async () => {
  A = await register('Ayesha Khan', 'ayesha@example.com');
  B = await register('Bilal Ahmed', 'bilal@example.com');
  const dup = await api.post('/api/auth/register').send({ name: 'x', email: 'ayesha@example.com', password: 'correct-horse-9' });
  assert.equal(dup.status, 409);
  const bad = await api.post('/api/auth/login').send({ email: 'ayesha@example.com', password: 'nope-nope-nope' });
  assert.equal(bad.status, 401);
  const inj = await api.post('/api/auth/login').send({ email: { $gt: '' }, password: { $gt: '' } });
  assert.notEqual(inj.status, 200);
  const ok = await api.post('/api/auth/login').send({ email: 'AYESHA@example.com', password: 'correct-horse-9' });
  assert.equal(ok.status, 200, ok.text);
  const me = await api.get('/api/auth/me').set(auth(ok.body.token));
  assert.equal(me.body.user.email, 'ayesha@example.com');
  assert.equal(me.body.user.password, undefined);
});

test('plan cannot be self-upgraded', async () => {
  await api.patch('/api/settings').set(auth(A.token)).send({ plan: 'premium' });
  await api.patch('/api/profile').set(auth(A.token)).send({ plan: 'premium' });
  const me = await api.get('/api/auth/me').set(auth(A.token));
  assert.equal(me.body.user.plan, 'free');
  const c = await api.get('/api/contracts').set(auth(A.token));
  assert.equal(c.status, 402);
});

test('clients + invoices keep stats in sync, ownership enforced', async () => {
  const c = await api.post('/api/clients').set(auth(A.token)).send({ name: 'Acme', email: 'ops@acme.test', revenue: 999999, user: B.user._id });
  assert.equal(c.status, 201, c.text);
  assert.equal(c.body.client.revenue, 0);
  assert.equal(String(c.body.client.user), String(A.user._id));
  const cid = c.body.client._id;

  const inv = await api.post('/api/invoices').set(auth(A.token)).send({ client: cid, items: [{ description: 'Build', quantity: 2, rate: 150 }], taxRate: 10, total: 1 });
  assert.equal(inv.status, 201, inv.text);
  assert.equal(inv.body.invoice.total, 330);
  assert.match(inv.body.invoice.invoiceNumber, /^INV-\d{4}$/);

  await api.patch(`/api/invoices/${inv.body.invoice._id}`).set(auth(A.token)).send({ status: 'paid' });
  const after = await api.get(`/api/clients/${cid}`).set(auth(A.token));
  assert.equal(after.body.client.revenue, 330);
  assert.equal(after.body.client.paidInvoices, 1);

  // B can't see or move A's data
  assert.equal((await api.get(`/api/clients/${cid}`).set(auth(B.token))).status, 404);
  const move = await api.patch(`/api/clients/${cid}`).set(auth(A.token)).send({ user: B.user._id, name: 'Acme Ltd' });
  assert.equal(move.status, 200);
  assert.equal(String(move.body.client.user), String(A.user._id));

  const s = await api.get('/api/clients?search=(a+)+$').set(auth(A.token));
  assert.equal(s.status, 200);
});

test('tasks: numbering, completion toggle, time log', async () => {
  const t1 = await api.post('/api/tasks').set(auth(A.token)).send({ title: 'Wireframes', priority: 'High' });
  const t2 = await api.post('/api/tasks').set(auth(A.token)).send({ title: 'Copy' });
  assert.equal(t1.body.task.taskNumber, 'TK-0001');
  assert.equal(t2.body.task.taskNumber, 'TK-0002');
  const done = await api.patch(`/api/tasks/${t1.body.task._id}`).set(auth(A.token)).send({ completed: true });
  assert.equal(done.body.task.status, 'done');
  assert.ok(done.body.task.completedAt);
  const tl = await api.post(`/api/tasks/${t2.body.task._id}/time`).set(auth(A.token)).send({ minutes: 45, note: 'draft' });
  assert.equal(tl.body.task.trackedMinutes, 45);
  const stats = await api.get('/api/tasks/stats').set(auth(A.token));
  assert.equal(stats.body.counts.done, 1);
});

test('dashboard + deadlines + activity', async () => {
  const d = await api.post('/api/deadlines').set(auth(A.token)).send({ title: 'Tax filing', dueDate: '2030-01-15', priority: 'High' });
  assert.equal(d.status, 201, d.text);
  const list = await api.get('/api/deadlines').set(auth(A.token));
  assert.equal(list.body.deadlines.length, 1);
  const dash = await api.get('/api/dashboard').set(auth(A.token));
  assert.equal(dash.status, 200, dash.text);
  assert.equal(dash.body.totalRevenue, 330);
  const rev = await api.get('/api/dashboard/revenue?months=3').set(auth(A.token));
  assert.equal(rev.body.data.length, 3);
  const act = await api.get('/api/activity').set(auth(A.token));
  assert.ok(act.body.activity.length > 0);
});

test('network: search, request, accept, mirrored chat', async () => {
  await api.patch('/api/profile').set(auth(B.token)).send({ title: 'Brand designer', skills: ['Figma', 'Branding'] });
  const s = await api.get('/api/connections/search?q=bilal').set(auth(A.token));
  assert.equal(s.body.users.length, 1);
  const r = await api.post('/api/connections/request').set(auth(A.token)).send({ userId: B.user._id });
  assert.equal(r.status, 201, r.text);
  const inc = await api.get('/api/connections/requests/incoming').set(auth(B.token));
  assert.equal(inc.body.requests[0].from.name, 'Ayesha Khan');
  const acc = await api.post(`/api/connections/request/${inc.body.requests[0]._id}/accept`).set(auth(B.token));
  assert.equal(acc.status, 200, acc.text);
  const aConns = await api.get('/api/connections').set(auth(A.token));
  const link = aConns.body.connections.find((c) => c.name === 'Bilal Ahmed');
  assert.ok(link);
  await api.post(`/api/connections/chat/${link._id}`).set(auth(A.token)).send({ text: 'Hi Bilal' });
  const bConns = await api.get('/api/connections').set(auth(B.token));
  const back = bConns.body.connections.find((c) => c.name === 'Ayesha Khan');
  const chat = await api.get(`/api/connections/chat/${back._id}`).set(auth(B.token));
  assert.equal(chat.body.messages.at(-1).text, 'Hi Bilal');
  assert.equal(chat.body.messages.at(-1).sender, 'them');
});

test('billing: plans, signed return activates premium idempotently, bad webhook rejected', async () => {
  const plans = await api.get('/api/billing/plans');
  assert.equal(plans.status, 200);
  assert.equal(plans.body.plans.length, 2);

  // Simulate a checkout that the provider created
  const Payment = require('../models/Payment');
  await Payment.create({ user: A.user._id, orderId: 'AUR-TEST', tracker: 'track_123', plan: 'premium', interval: 'month', amount: 5320, currency: 'PKR', amountUsd: 19 });

  const forged = await api.post('/api/billing/safepay/return').type('form').send({ tracker: 'track_123', sig: 'forged' });
  assert.equal(forged.status, 303);
  assert.match(forged.headers.location, /checkout=pending/);
  assert.equal((await api.get('/api/auth/me').set(auth(A.token))).body.user.plan, 'free');

  const sig = crypto.createHmac('sha256', 'sp_secret_test').update('track_123').digest('hex');
  const ok = await api.post('/api/billing/safepay/return').type('form').send({ tracker: 'track_123', sig });
  assert.equal(ok.status, 303, ok.text);
  assert.match(ok.headers.location, /checkout=success/);
  const me = await api.get('/api/auth/me').set(auth(A.token));
  assert.equal(me.body.user.plan, 'premium');
  const exp1 = me.body.user.planExpiresAt;

  // Replaying the same callback must not extend the period again
  await api.post('/api/billing/safepay/return').type('form').send({ tracker: 'track_123', sig });
  assert.equal((await api.get('/api/auth/me').set(auth(A.token))).body.user.planExpiresAt, exp1);

  const wh = await api.post('/api/billing/safepay/webhook').set('x-sfpy-signature', 'nope').send({ data: { tracker: 'track_123' } });
  assert.equal(wh.status, 401);

  assert.equal((await api.get('/api/contracts').set(auth(A.token))).status, 200);
  const hist = await api.get('/api/billing/history').set(auth(A.token));
  assert.equal(hist.body.payments.length, 1);
});

test('sessions: revoke signs the token out', async () => {
  const second = await api.post('/api/auth/login').send({ email: 'bilal@example.com', password: 'correct-horse-9' });
  const list = await api.get('/api/auth/sessions').set(auth(B.token));
  assert.ok(list.body.sessions.length >= 2);
  const other = list.body.sessions.find((s) => !s.current);
  await api.delete(`/api/auth/sessions/${other._id}`).set(auth(B.token));
  const r = await api.get('/api/auth/me').set(auth(second.body.token));
  assert.equal(r.status, 401);
});

test('password reset flow', async () => {
  const User = require('../models/User');
  const r = await api.post('/api/auth/forgot-password').send({ email: 'bilal@example.com' });
  assert.equal(r.status, 200);
  // Token is hashed at rest; generate a known one to exercise the endpoint.
  const raw = 'a'.repeat(64);
  await User.updateOne({ email: 'bilal@example.com' }, { resetPasswordToken: crypto.createHash('sha256').update(raw).digest('hex'), resetPasswordExpiry: new Date(Date.now() + 60000) });
  const reset = await api.post('/api/auth/reset-password').send({ token: raw, password: 'new-password-123' });
  assert.equal(reset.status, 200, reset.text);
  assert.equal((await api.get('/api/auth/me').set(auth(B.token))).status, 401); // old tokens dead
  const login = await api.post('/api/auth/login').send({ email: 'bilal@example.com', password: 'new-password-123' });
  assert.equal(login.status, 200);
});

test('support + contact', async () => {
  const t = await api.post('/api/support/ticket').set(auth(A.token)).send({ subject: 'Invoice PDF', message: 'The PDF cuts the last line.' });
  assert.equal(t.status, 201, t.text);
  assert.match(t.body.ticketId, /^TKT-\d{5}$/);
  const list = await api.get('/api/support/tickets').set(auth(A.token));
  assert.equal(list.body.tickets.length, 1);
  const c = await api.post('/api/contact').send({ name: 'Visitor', email: 'v@example.com', subject: 'Pricing', message: 'Do you offer team plans for agencies?' });
  assert.equal(c.status, 200, c.text);
  const n = await api.post('/api/newsletter').send({ email: 'v@example.com' });
  assert.equal(n.status, 200, n.text);
  const st = await api.get('/api/support/status');
  assert.equal(st.status, 200);
});

test('ai is gated and fails clearly without a key', async () => {
  const r = await api.post('/api/ai/support-chat').set(auth(A.token)).send({ input: 'How do I upgrade?' });
  assert.equal(r.status, 503);
  const C = await register('Free User', 'free@example.com');
  const p = await api.post('/api/ai/health-score').set(auth(C.token)).send({ input: 'x' });
  assert.equal(p.status, 402);
});

test('export + delete account', async () => {
  const ex = await api.get('/api/settings/download-data').set(auth(A.token));
  assert.equal(ex.status, 200);
  assert.equal(ex.body.clients.length, 1);
  const no = await api.delete('/api/auth/account').set(auth(B.token)).send({ confirm: 'DELETE', password: 'wrong' });
  assert.equal(no.status, 401);
  const login = await api.post('/api/auth/login').send({ email: 'bilal@example.com', password: 'new-password-123' });
  const del = await api.delete('/api/auth/account').set(auth(login.body.token)).send({ confirm: 'DELETE', password: 'new-password-123' });
  assert.equal(del.status, 200, del.text);
  assert.equal((await api.post('/api/auth/login').send({ email: 'bilal@example.com', password: 'new-password-123' })).status, 401);
});
