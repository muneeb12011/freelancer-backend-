// test/profile-alerts.test.js — public profiles, work history, notifications, job alerts,
// statements, disputes, and milestone plans in applications.
process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-that-is-long-enough-for-hs256-signing';
process.env.VERIFICATION_KEY = 'c'.repeat(64);
process.env.ADMIN_EMAILS = 'judge@example.com';
process.env.CRON_SECRET = 'cron-secret-2';
process.env.MONGO_URI = (process.env.MONGO_URI || '').replace(/\/[^/]*$/, '/aurelance_profile_test');

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const request = require('supertest');
const mongoose = require('mongoose');
const app = require('../app');

const api = request(app);
const auth = (t) => ({ Authorization: `Bearer ${t}` });
let C; let F; let J;
const reg = async (name, email) => {
  const r = await api.post('/api/auth/register').send({ name, email, password: 'correct-horse-9' });
  assert.equal(r.status, 201, r.text);
  await mongoose.model('User').updateOne({ email }, { emailVerified: true });
  return r.body;
};
let contractId;

test.before(async () => {
  await mongoose.connect(process.env.MONGO_URI);
  await mongoose.connection.db.dropDatabase();
  C = await reg('Nadia Qureshi', 'nadia@example.com');
  F = await reg('Zain Ahmed', 'zain@example.com');
  J = await reg('Judge Admin', 'judge@example.com');
  await api.patch('/api/profile').set(auth(F.token)).send({ title: 'React Native developer', skills: ['React Native', 'Expo', 'Firebase'], bio: 'x'.repeat(170), hourlyRate: 30, hoursPerWeek: 25, workingHours: { start: '10:00', end: '18:00' }, langs: [{ name: 'English', level: 'Fluent' }, { name: 'Urdu', level: 'Native' }] });
});
test.after(async () => { await mongoose.disconnect(); });

test('handles: auto-created, validated, unique; public profile hides contact details', async () => {
  const me = await api.get('/api/profile').set(auth(F.token));
  assert.equal(me.body.profile.handle, 'zain-ahmed');
  assert.equal((await api.patch('/api/profile').set(auth(F.token)).send({ handle: 'Admin' })).status, 400, 'reserved');
  assert.equal((await api.patch('/api/profile').set(auth(F.token)).send({ handle: 'a--b' })).status, 400, 'bad shape');
  await api.get('/api/profile').set(auth(C.token));
  assert.equal((await api.patch('/api/profile').set(auth(C.token)).send({ handle: 'zain-ahmed' })).status, 400, 'taken');
  assert.equal((await api.patch('/api/profile').set(auth(F.token)).send({ handle: 'zain-builds' })).status, 200);
  const pub = await api.get('/api/public/u/zain-builds');
  assert.equal(pub.status, 200);
  assert.equal(pub.body.profile.name, 'Zain Ahmed');
  assert.equal(pub.body.profile.email, undefined);
  assert.equal(pub.body.profile.phone, undefined);
  assert.equal(pub.body.profile.langs[1].level, 'Native');
  assert.equal(pub.body.profile.hoursPerWeek, 25);
  assert.equal((await api.get('/api/public/u/nobody-here')).status, 404);
  const ins = await api.get('/api/profile/insights').set(auth(F.token));
  assert.equal(ins.body.views.publicMonth, 1, 'signed-out view counted once');
  assert.ok(ins.body.strength.score > 0 && ins.body.strength.next.length > 0);
});

test('portfolio images: upload, attach, served publicly with cache headers', async () => {
  const data = `data:image/jpeg;base64,${crypto.randomBytes(30 * 1024).toString('base64')}`;
  const up = await api.post('/api/profile/images').set(auth(F.token)).send({ data });
  assert.equal(up.status, 201, up.text);
  await api.patch('/api/profile').set(auth(F.token)).send({ projects: [{ title: 'Clinic booking app', description: 'Expo app', images: [up.body.image.id] }] });
  const pub = await api.get('/api/public/u/zain-builds');
  assert.equal(pub.body.profile.projects[0].images[0].url, `/api/public/img/${up.body.image.id}`);
  const img = await api.get(`/api/public/img/${up.body.image.id}`);
  assert.equal(img.status, 200);
  assert.match(img.headers['cache-control'], /immutable/);
});

test('milestone plan in an application becomes the draft; notifications follow every step', async () => {
  const job = await api.post('/api/jobs').set(auth(C.token)).send({ title: 'Mobile app for a home bakery', category: 'Development', skills: ['React Native'], description: 'Order app with menu, cart and cash-on-delivery for a home bakery in Lahore. Admin can mark orders ready.', budgetMin: 400, budgetMax: 900 });
  const forYou = await api.get('/api/jobs/for-you').set(auth(F.token));
  assert.ok(forYou.body.jobs.some((j) => j._id === job.body.job._id), 'matched by skills');
  const ap = await api.post(`/api/jobs/${job.body.job._id}/apply`).set(auth(F.token)).send({ coverLetter: 'Built two Expo ordering apps with COD for Lahore food businesses, both still live.', milestones: [{ title: 'Menu + cart', amount: 300, days: 7 }, { title: 'Checkout + admin', amount: 350, days: 10 }] });
  assert.equal(ap.status, 201, ap.text);
  assert.equal(ap.body.application.bid, 650);
  const bell = await api.get('/api/notifications').set(auth(C.token));
  assert.ok(bell.body.items.some((n) => n.type === 'application.new'));
  assert.ok(bell.body.unread >= 1);
  const apps = await api.get(`/api/jobs/${job.body.job._id}/applications`).set(auth(C.token));
  const hire = await api.patch(`/api/jobs/applications/${apps.body.applications[0]._id}`).set(auth(C.token)).send({ status: 'hired' });
  contractId = hire.body.contract._id;
  const draft = await api.get(`/api/engagements/${contractId}`).set(auth(F.token));
  assert.deepEqual(draft.body.contract.milestones.map((m) => m.amount), [300, 350]);
  assert.ok(draft.body.contract.milestones[1].dueDate);
  const fb = await api.get('/api/notifications').set(auth(F.token));
  assert.ok(fb.body.items.some((n) => n.type === 'contract.offer'));
  await api.post(`/api/engagements/${contractId}/sign`).set(auth(F.token)).send({ name: 'Zain Ahmed' });
  await api.post(`/api/engagements/${contractId}/sign`).set(auth(C.token)).send({ name: 'Nadia Qureshi' });
  const cb = await api.get('/api/notifications').set(auth(C.token));
  assert.ok(cb.body.items.some((n) => n.type === 'contract' && /signed/.test(n.title)));
  const r = await api.post('/api/notifications/read').set(auth(C.token)).send({});
  assert.equal(r.body.unread, 0);
});

test('statement: confirmed payments in range as JSON and CSV', async () => {
  const c = (await api.get(`/api/engagements/${contractId}`).set(auth(C.token))).body.contract;
  const m1 = c.milestones[0]._id;
  await api.post(`/api/engagements/${contractId}/milestones/${m1}/submit`).set(auth(F.token)).send({ note: 'Menu and cart done, build link inside' });
  await api.post(`/api/engagements/${contractId}/milestones/${m1}/approve`).set(auth(C.token));
  await api.post(`/api/engagements/${contractId}/milestones/${m1}/paid`).set(auth(C.token)).send({ method: 'bank', reference: 'RAAST-112233' });
  await api.post(`/api/engagements/${contractId}/milestones/${m1}/received`).set(auth(F.token));
  const today = new Date().toISOString().slice(0, 10);
  const st = await api.get(`/api/engagements/statement?from=${today}&to=${today}`).set(auth(F.token));
  assert.equal(st.status, 200, st.text);
  assert.equal(st.body.rows.length, 1);
  assert.equal(st.body.totals.USD, 300);
  assert.equal(st.body.rows[0].reference, 'RAAST-112233');
  const csv = await api.get(`/api/engagements/statement?from=${today}&to=${today}&format=csv`).set(auth(F.token));
  assert.match(csv.headers['content-type'], /text\/csv/);
  assert.match(csv.text, /RAAST-112233/);
  const asClient = await api.get(`/api/engagements/statement?role=client&from=${today}&to=${today}`).set(auth(C.token));
  assert.equal(asClient.body.rows[0].counterparty, 'Zain Ahmed');
});

test('disputes: open, respond, admin decides, counted on the record; work history after completion', async () => {
  const c = (await api.get(`/api/engagements/${contractId}`).set(auth(F.token))).body.contract;
  const m2 = c.milestones[1]._id;
  await api.post(`/api/engagements/${contractId}/milestones/${m2}/submit`).set(auth(F.token)).send({ note: 'Checkout and admin screens shipped' });
  await api.post(`/api/engagements/${contractId}/milestones/${m2}/approve`).set(auth(C.token));
  await api.post(`/api/engagements/${contractId}/milestones/${m2}/paid`).set(auth(C.token)).send({ method: 'bank', reference: 'RAAST-445566' });
  assert.equal((await api.post('/api/disputes').set(auth(F.token)).send({ engagement: contractId, kind: 'payment_not_received', statement: 'short' })).status, 400);
  const d = await api.post('/api/disputes').set(auth(F.token)).send({ engagement: contractId, milestone: m2, kind: 'payment_not_received', statement: 'The client marked RAAST-445566 as paid on the contract but nothing has arrived in my Meezan account after five working days.' });
  assert.equal(d.status, 201, d.text);
  assert.equal((await api.post('/api/disputes').set(auth(C.token)).send({ engagement: contractId, kind: 'other', statement: 'x'.repeat(50) })).status, 400, 'one open dispute at a time');
  const rsp = await api.post(`/api/disputes/${d.body.dispute._id}/respond`).set(auth(C.token)).send({ text: 'My bank shows the transfer reversed because of a typo in the IBAN. I have resent it today with a new reference.' });
  assert.equal(rsp.body.dispute.status, 'responded');
  const q = await api.get('/api/admin/disputes').set(auth(J.token));
  assert.equal(q.body.disputes.length, 1);
  const res = await api.post(`/api/admin/disputes/${d.body.dispute._id}/resolve`).set(auth(J.token)).send({ outcome: 'for_opener', note: 'The payment did not arrive; the client must resend and the record shows this one.' });
  assert.equal(res.status, 200, res.text);
  await new Promise((r) => setTimeout(r, 300));
  const prof = await api.get(`/api/profile/${C.user._id}`).set(auth(F.token));
  assert.equal(prof.body.profile.reputation.asClient.disputesLost, 1);
  const shaped = await api.get(`/api/engagements/${contractId}`).set(auth(C.token));
  assert.equal(shaped.body.contract.disputes[0].status, 'resolved');

  await api.post(`/api/engagements/${contractId}/milestones/${m2}/received`).set(auth(F.token));
  const pub = await api.get('/api/public/u/zain-builds');
  assert.equal(pub.body.profile.history.length, 1);
  assert.equal(pub.body.profile.history[0].client.name, 'Nadia Q.', 'client name shortened');
  assert.equal(pub.body.profile.history[0].paid, 2);
});

test('job alerts: saved search emails new matches once and updates its cursor', async () => {
  const s = await api.post('/api/jobs/searches').set(auth(F.token)).send({ name: 'Expo work', skills: ['Expo'] });
  assert.equal(s.status, 201, s.text);
  assert.equal((await api.post('/api/jobs/searches').set(auth(F.token)).send({})).status, 400);
  await mongoose.model('SavedSearch').updateOne({ _id: s.body.search._id }, { $set: { lastRunAt: new Date(Date.now() - 2 * 86400e3) } });
  await api.post('/api/jobs').set(auth(C.token)).send({ title: 'Expo app update for a gym', category: 'Development', skills: ['Expo'], description: 'Add class booking and push reminders to our existing Expo app. Repo access provided on day one.', budgetMin: 200, budgetMax: 300 });
  const cron = await api.get('/api/cron/daily').set({ Authorization: 'Bearer cron-secret-2' });
  assert.equal(cron.status, 200, cron.text);
  assert.ok(cron.body.results.jobAlerts.searches >= 1);
  const after = await mongoose.model('SavedSearch').findById(s.body.search._id).lean();
  assert.equal(after.lastCount, 1);
  const bell = await api.get('/api/notifications').set(auth(F.token));
  assert.ok(bell.body.items.some((n) => n.type === 'jobs.alert'));
});
