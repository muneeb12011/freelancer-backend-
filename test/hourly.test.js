// test/hourly.test.js — hourly contracts: offer, sign, log time within the weekly limit,
// submit a week as a timesheet, send it back, resubmit, get paid, auto-submit, and close.
process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-that-is-long-enough-for-hs256-signing';
process.env.CRON_SECRET = 'cron-hourly';
process.env.MONGO_URI = (process.env.MONGO_URI || '').replace(/\/[^/]*$/, '/aurelance_hourly_test');

const test = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const mongoose = require('mongoose');
const app = require('../app');
const ts = require('../services/timesheets');

const api = request(app);
const auth = (t) => ({ Authorization: `Bearer ${t}` });
const DAY = 86400e3;
let C; let F; let id;
const reg = async (name, email) => {
  const r = await api.post('/api/auth/register').send({ name, email, password: 'correct-horse-9' });
  assert.equal(r.status, 201, r.text);
  await mongoose.model('User').updateOne({ email }, { emailVerified: true });
  return r.body;
};
const day = (offset) => new Date(Date.now() + offset * DAY).toISOString().slice(0, 10);
const thisWeek = ts.weekOf(new Date());
const lastWeek = ts.weekOf(new Date(Date.now() - 7 * DAY));

test.before(async () => {
  await mongoose.connect(process.env.MONGO_URI);
  await mongoose.connection.db.dropDatabase();
  C = await reg('Sadia Anwar', 'sadia@example.com');
  F = await reg('Bilal Shah', 'bilal@example.com');
});
test.after(async () => { await mongoose.disconnect(); });

test('week helpers: Monday-based weeks, validated days', () => {
  assert.equal(ts.weekOf('2026-10-18'), '2026-10-12'); // Sunday → Monday before
  assert.equal(ts.weekOf('2026-10-19'), '2026-10-19'); // Monday
  assert.equal(ts.parseDay('2026-02-30'), null);
  assert.equal(ts.fmtHours(150), '2 h 30 min');
});

test('offer and sign an hourly contract', async () => {
  const bad = await api.post('/api/engagements').set(auth(C.token)).send({ freelancer: F.user._id, title: 'Support for a Shopify store', billing: 'hourly', hourly: { rate: 0, weeklyCap: 10 } });
  assert.equal(bad.status, 400);
  const r = await api.post('/api/engagements').set(auth(C.token)).send({ freelancer: F.user._id, title: 'Support for a Shopify store', billing: 'hourly', currency: 'USD', hourly: { rate: 18, weeklyCap: 10 } });
  assert.equal(r.status, 201, r.text);
  id = r.body.contract._id;
  assert.equal(r.body.contract.billing, 'hourly');
  assert.equal(r.body.contract.milestones.length, 0);
  const early = await api.post(`/api/engagements/${id}/time`).set(auth(F.token)).send({ date: day(0), minutes: 60, note: 'Theme fixes' });
  assert.equal(early.status, 400, 'no time before signing');
  // Freelancer negotiates the cap on the draft, then both sign.
  const ed = await api.patch(`/api/engagements/${id}`).set(auth(F.token)).send({ weeklyCap: 12 });
  assert.equal(ed.body.contract.hourly.weeklyCap, 12);
  await api.post(`/api/engagements/${id}/sign`).set(auth(F.token)).send({ name: 'Bilal Shah' });
  const s = await api.post(`/api/engagements/${id}/sign`).set(auth(C.token)).send({ name: 'Sadia Anwar' });
  assert.equal(s.body.contract.status, 'active');
  // Backdate the signature so last week counts as inside the contract.
  await mongoose.model('Engagement').updateOne({ _id: id }, { signedAt: new Date(Date.now() - 14 * DAY) });
});

test('logging time: notes required, future days refused, weekly limit enforced', async () => {
  const noNote = await api.post(`/api/engagements/${id}/time`).set(auth(F.token)).send({ date: day(0), minutes: 60, note: '' });
  assert.equal(noNote.status, 400);
  const future = await api.post(`/api/engagements/${id}/time`).set(auth(F.token)).send({ date: day(3), minutes: 60, note: 'Planning' });
  assert.equal(future.status, 400);
  const client = await api.post(`/api/engagements/${id}/time`).set(auth(C.token)).send({ date: day(0), minutes: 60, note: 'x' });
  assert.equal(client.status, 403, 'only the freelancer logs time');

  const mon = ts.weekDays(lastWeek);
  for (const [d, h, n] of [[mon[0], 4, 'Fixed cart drawer on mobile'], [mon[2], 5, 'Product filter by size'], [mon[4], 2.5, 'Checkout copy and testing']]) {
    const r = await api.post(`/api/engagements/${id}/time`).set(auth(F.token)).send({ date: d, hours: h, note: n });
    assert.equal(r.status, 201, r.text);
  }
  const over = await api.post(`/api/engagements/${id}/time`).set(auth(F.token)).send({ date: mon[5], hours: 1, note: 'More testing' });
  assert.equal(over.status, 400);
  assert.match(over.body.error, /12 h weekly limit/);
  assert.match(over.body.error, /30 min left/);
  const wk = await api.get(`/api/engagements/${id}/time?week=${lastWeek}`).set(auth(C.token));
  assert.equal(wk.body.minutes, 690);
  assert.equal(wk.body.entries.length, 3);
  assert.equal(wk.body.open, true);
});

test('submit a week → timesheet milestone; sent back → editable → resubmitted → paid', async () => {
  const sub = await api.post(`/api/engagements/${id}/timesheets`).set(auth(F.token)).send({ week: lastWeek });
  assert.equal(sub.status, 200, sub.text);
  const m = sub.body.contract.milestones[0];
  assert.equal(m.source, 'timesheet');
  assert.equal(m.minutes, 690);
  assert.equal(m.amount, 207); // 11.5 h × 18
  assert.match(m.title, /11 h 30 min/);
  assert.match(m.delivery.note, /Fixed cart drawer/);

  const entries = (await api.get(`/api/engagements/${id}/time?week=${lastWeek}`).set(auth(F.token))).body.entries;
  const locked = await api.patch(`/api/engagements/${id}/time/${entries[2]._id}`).set(auth(F.token)).send({ hours: 2 });
  assert.equal(locked.status, 400, 'submitted weeks are locked');
  const viaMilestone = await api.post(`/api/engagements/${id}/milestones/${m._id}/submit`).set(auth(F.token)).send({ note: 'trying the other door' });
  assert.equal(viaMilestone.status, 400);

  await api.post(`/api/engagements/${id}/milestones/${m._id}/revise`).set(auth(C.token)).send({ note: 'Wednesday looks high — was that the size filter only?' });
  const fix = await api.patch(`/api/engagements/${id}/time/${entries[1]._id}`).set(auth(F.token)).send({ hours: 4 });
  assert.equal(fix.status, 200, fix.text);
  const re = await api.post(`/api/engagements/${id}/timesheets`).set(auth(F.token)).send({ week: lastWeek });
  const m2 = re.body.contract.milestones[0];
  assert.equal(re.body.contract.milestones.length, 1, 'same milestone, updated');
  assert.equal(m2.amount, 189); // 10.5 h × 18
  assert.equal(m2.status, 'submitted');

  await api.post(`/api/engagements/${id}/milestones/${m2._id}/approve`).set(auth(C.token));
  await api.post(`/api/engagements/${id}/milestones/${m2._id}/paid`).set(auth(C.token)).send({ method: 'bank', reference: 'IBFT-1029' });
  const got = await api.post(`/api/engagements/${id}/milestones/${m2._id}/received`).set(auth(F.token));
  assert.equal(got.body.contract.status, 'active', 'hourly contracts don’t auto-complete when a week is paid');
});

test('client changes the weekly limit; the cron submits ended weeks; closing bills the rest', async () => {
  const cap = await api.patch(`/api/engagements/${id}/hourly`).set(auth(C.token)).send({ weeklyCap: 5 });
  assert.equal(cap.body.contract.hourly.weeklyCap, 5);
  const nope = await api.patch(`/api/engagements/${id}/hourly`).set(auth(F.token)).send({ weeklyCap: 40 });
  assert.equal(nope.status, 403);

  // An entry in the week before last that was never submitted → the daily job submits it.
  const older = ts.weekOf(new Date(Date.now() - 14 * DAY));
  await mongoose.model('TimeEntry').create({ engagement: id, freelancer: F.user._id, date: ts.weekDays(older)[1], week: older, minutes: 90, note: 'Call and setup' });
  const cron = await api.get('/api/cron/daily').set('Authorization', 'Bearer cron-hourly');
  assert.equal(cron.body.results.weeklyTimesheets.submitted, 1, JSON.stringify(cron.body.results.weeklyTimesheets));

  const today = await api.post(`/api/engagements/${id}/time`).set(auth(F.token)).send({ date: day(0), minutes: 45, note: 'Handover notes' });
  assert.equal(today.status, 201, today.text);
  const end = await api.post(`/api/engagements/${id}/end`).set(auth(C.token)).send({ reason: 'Store launched, support no longer needed' });
  assert.equal(end.body.contract.status, 'completed');
  const weeks = end.body.contract.milestones.map((x) => x.week).sort();
  assert.deepEqual(weeks, [older, lastWeek, thisWeek].sort(), 'this week’s time was billed on close');
  assert.ok(end.body.contract.time.weeks.every((w) => w.sheet));
});
