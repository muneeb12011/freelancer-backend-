// test/ledger.test.js — the public ledger: figures withheld below the minimum sample, medians right,
// no names / exact amounts / very recent events; scam rules, scam check and handle preview.
process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-that-is-long-enough-for-hs256-signing';
process.env.MONGO_URI = (process.env.MONGO_URI || '').replace(/\/[^/]*$/, '/aurelance_ledger_test');

const test = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const mongoose = require('mongoose');
const app = require('../app');
const ledger = require('../services/ledger');

const api = request(app);
const DAY = 86400e3;
let C; let F;
const reg = async (name, email) => {
  const r = await api.post('/api/auth/register').send({ name, email, password: 'correct-horse-9' });
  assert.equal(r.status, 201, r.text);
  return r.body;
};
const ago = (d) => new Date(Date.now() - d * DAY);

test.before(async () => {
  await mongoose.connect(process.env.MONGO_URI);
  await mongoose.connection.db.dropDatabase();
  C = await reg('Mehwish Akram', 'mehwish@example.com');
  F = await reg('Taimoor Ali', 'taimoor@example.com');
});
test.after(async () => { await mongoose.disconnect(); });

const contractWithPayments = (payDaysList, { confirmedDaysAgo = 3, amount = 240 } = {}) => mongoose.model('Engagement').create({
  client: C.user._id, freelancer: F.user._id, title: 'Secret Project Falcon', status: 'active', currency: 'USD', signedAt: ago(5),
  milestones: payDaysList.map((d, i) => ({ title: `Part ${i}`, amount, status: 'received', approvedAt: ago(10), payment: { markedAt: new Date(ago(10).getTime() + d * DAY), confirmedAt: ago(confirmedDaysAgo), method: 'bank', reference: 'REF-SECRET-99' } })),
});

test('below the minimum sample, a figure is withheld but its sample size is shown', async () => {
  await contractWithPayments([1, 2]);
  ledger._reset();
  const r = await api.get('/api/public/ledger');
  assert.equal(r.status, 200);
  assert.equal(r.body.figures.medianDaysToPay.value, null);
  assert.equal(r.body.figures.medianDaysToPay.n, 2);
  assert.equal(r.body.figures.medianDaysToPay.enough, false);
  assert.equal(r.body.counts.contractsSigned30d, 1);
});

test('with enough cases the median is computed; entries carry no names, references or exact amounts', async () => {
  await contractWithPayments([0, 3, 9]); // all five: 0,1,2,3,9 → median 2
  await mongoose.model('Engagement').create({ client: C.user._id, freelancer: F.user._id, title: 'Too fresh to show', status: 'active', signedAt: new Date(Date.now() - 20 * 60e3), milestones: [] });
  ledger._reset();
  const r = await api.get('/api/public/ledger');
  assert.equal(r.body.figures.medianDaysToPay.value, 2);
  assert.equal(r.body.figures.paidWithinAWeek.value, 80);
  const all = JSON.stringify(r.body.entries);
  for (const secret of ['Mehwish', 'Taimoor', 'Falcon', 'REF-SECRET', '240', 'Too fresh']) assert.ok(!all.includes(secret), `leaked ${secret}`);
  assert.ok(r.body.entries.some((e) => /USD 100–500/.test(e.text)), 'amounts become ranges');
  assert.ok(r.body.entries.every((e) => /^\d{4}-\d{2}-\d{2}$/.test(e.day)), 'times become days');
  assert.equal(r.body.entries.filter((e) => e.kind === 'signed').length, 2, 'the two from 5 days ago show; the one signed 20 minutes ago is held back');
});

test('held scam posts show up as a phrase, never the post', async () => {
  await mongoose.model('Job').create({ postedBy: C.user._id, title: 'Typing work from home daily', description: 'x'.repeat(60), status: 'review', createdAt: ago(1), safety: { score: 7, verdict: 'held', flags: [{ code: 'upfront_fee', label: 'fee' }] } });
  ledger._reset();
  const r = await api.get('/api/public/ledger');
  assert.equal(r.body.counts.scamPostsHeld30d, 1);
  const e = r.body.entries.find((x) => x.kind === 'held');
  assert.match(e.text, /asking applicants for a fee/);
  assert.ok(!e.text.includes('Typing work'));
});

test('ranges for PKR and large amounts', () => {
  assert.equal(ledger.bucket(30000, 'PKR'), '100–500 USD-equivalent, paid in PKR');
  assert.equal(ledger.bucket(2000, 'USD'), 'USD over 1,500');
});

test('scam rules are public without their patterns; the check needs an account', async () => {
  const r = await api.get('/api/public/scam-rules');
  assert.ok(r.body.rules.length >= 6);
  assert.ok(r.body.rules.every((x) => !('re' in x) && !('test' in x)));
  assert.equal(r.body.thresholds.hold, 5);
  const anon = await api.post('/api/public/scam-check').send({ text: 'Pay the registration fee first please' });
  assert.equal(anon.status, 401);
  const c = await api.post('/api/public/scam-check').set('Authorization', `Bearer ${F.token}`).send({ text: 'Pay the registration fee first and send your CNIC copy on w h a t s a p p' });
  assert.equal(c.status, 200);
  assert.equal(c.body.verdict, 'held');
  assert.ok(c.body.flags.some((f) => f.code === 'disguised'));
});

test('handle preview: free, taken, reserved, too short', async () => {
  assert.equal((await api.get('/api/public/handle?name=Zara Sheikh')).body.handle, 'zara-sheikh');
  await api.get('/api/profile').set('Authorization', `Bearer ${C.token}`); // handles are assigned on first visit
  const taken = await api.get('/api/public/handle?name=Mehwish Akram');
  assert.equal(taken.body.taken, true);
  assert.equal((await api.get('/api/public/handle?name=Admin')).body.reason, 'reserved');
  assert.equal((await api.get('/api/public/handle?name=Al')).body.reason, 'short');
});
