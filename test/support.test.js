// test/support.test.js — help library, situation detection, and the full ticket loop
// (person writes → support answers with the contract in view → person replies → solved).
process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-that-is-long-enough-for-hs256-signing';
process.env.VERIFICATION_KEY = 'd'.repeat(64);
process.env.ADMIN_EMAILS = 'desk@example.com';
process.env.MONGO_URI = (process.env.MONGO_URI || '').replace(/\/[^/]*$/, '/aurelance_support_test');

const test = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const mongoose = require('mongoose');
const app = require('../app');

const api = request(app);
const auth = (t) => ({ Authorization: `Bearer ${t}` });
const DAY = 86400e3;
let C; let F; let A; let contract; let stranger;

const reg = async (name, email) => {
  const r = await api.post('/api/auth/register').send({ name, email, password: 'correct-horse-9' });
  assert.equal(r.status, 201, r.text);
  await mongoose.model('User').updateOne({ email }, { emailVerified: true });
  return r.body;
};

test.before(async () => {
  await mongoose.connect(process.env.MONGO_URI);
  await mongoose.connection.db.dropDatabase();
  C = await reg('Ayesha Malik', 'ayesha@example.com');
  F = await reg('Hamza Iqbal', 'hamza@example.com');
  A = await reg('Desk Admin', 'desk@example.com');
  stranger = await reg('Omar Shah', 'omar@example.com');
  const Engagement = mongoose.model('Engagement');
  contract = await Engagement.create({
    client: C.user._id, freelancer: F.user._id, title: 'Logo and packaging for a tea brand', currency: 'USD', status: 'active',
    milestones: [
      { title: 'Logo directions', amount: 200, status: 'approved', approvedAt: new Date(Date.now() - 9 * DAY) },
      { title: 'Packaging', amount: 300, status: 'open', dueDate: new Date(Date.now() - 3 * DAY) },
    ],
  });
});
test.after(async () => { await mongoose.disconnect(); });

test('help library: topics, articles and the old FAQ shape', async () => {
  const r = await api.get('/api/support/articles');
  assert.equal(r.status, 200);
  assert.ok(r.body.topics.length >= 5);
  assert.ok(r.body.articles.some((a) => a.slug === 'client-not-paying'));
  const f = await api.get('/api/support/faqs');
  assert.ok(f.body.faqs.every((x) => x.question && x.answer && x.category));
  assert.ok(!f.body.faqs.some((x) => /invoice|kanban/i.test(x.question)), 'no answers about removed features');
});

test('context: each side sees the situation that applies to them', async () => {
  const fr = await api.get('/api/support/context').set(auth(F.token));
  assert.equal(fr.status, 200);
  const unpaid = fr.body.situations.find((s) => s.kind === 'unpaid');
  assert.ok(unpaid, 'freelancer sees the unpaid milestone');
  assert.match(unpaid.title, /Ayesha Malik hasn’t paid/);
  assert.equal(unpaid.article, 'client-not-paying');
  assert.equal(fr.body.contracts[0].with, 'Ayesha Malik');

  const cl = await api.get('/api/support/context').set(auth(C.token));
  assert.ok(cl.body.situations.some((s) => s.kind === 'late' && /3 days late/.test(s.title)), 'client sees the late delivery');
  assert.ok(!cl.body.situations.some((s) => s.kind === 'unpaid'), 'client is not told they are unpaid');
});

test('tickets: attach only your own contract; urgent topics get high priority', async () => {
  const bad = await api.post('/api/support/tickets').set(auth(stranger.token)).send({ topic: 'payment', engagement: String(contract._id), message: 'Trying to attach someone else’s contract.' });
  assert.equal(bad.status, 400);
  const short = await api.post('/api/support/tickets').set(auth(F.token)).send({ topic: 'payment', message: 'help' });
  assert.equal(short.status, 400);
});

test('full loop: write → support answers with context → reply → solved', async () => {
  const t = await api.post('/api/support/tickets').set(auth(F.token)).send({ topic: 'payment', engagement: String(contract._id), message: 'Logo directions were approved over a week ago and I have not been paid.' });
  assert.equal(t.status, 201, t.text);
  assert.equal(t.body.ticket.awaiting, 'support');
  assert.equal(t.body.ticket.priority, 'high');
  assert.match(t.body.ticket.subject, /Payment — Logo and packaging/);
  const id = t.body.ticket._id;

  const q = await api.get('/api/admin/tickets').set(auth(A.token));
  assert.ok(q.body.tickets.some((x) => x._id === id));
  const d = await api.get(`/api/admin/tickets/${id}`).set(auth(A.token));
  assert.equal(d.body.contract.title, 'Logo and packaging for a tea brand');
  assert.equal(d.body.contract.milestones[0].status, 'approved');
  assert.equal(d.body.sender.name, 'Hamza Iqbal');

  const nope = await api.get(`/api/admin/tickets/${id}`).set(auth(F.token));
  assert.equal(nope.status, 403);
  const other = await api.get(`/api/support/tickets/${id}`).set(auth(C.token));
  assert.equal(other.status, 404, 'the other party cannot read it');

  const ans = await api.post(`/api/admin/tickets/${id}/reply`).set(auth(A.token)).send({ reply: 'We’ve written to Ayesha. If nothing arrives in 3 days, open a dispute from the milestone.' });
  assert.equal(ans.status, 200, ans.text);
  assert.equal(ans.body.ticket.awaiting, 'user');
  assert.equal(ans.body.ticket.status, 'in-progress');
  assert.ok(ans.body.ticket.firstResponseAt);

  const bell = await api.get('/api/notifications').set(auth(F.token));
  assert.ok(bell.body.items.some((n) => n.type === 'support.reply' && n.link === `/support?ticket=${id}`));

  const mine = await api.get(`/api/support/tickets/${id}`).set(auth(F.token));
  assert.equal(mine.body.ticket.replies.length, 1);
  assert.equal(mine.body.ticket.engagement.title, 'Logo and packaging for a tea brand');

  const back = await api.post(`/api/support/tickets/${id}/reply`).set(auth(F.token)).send({ text: 'Thanks — she just paid.' });
  assert.equal(back.body.ticket.awaiting, 'support');
  const solved = await api.post(`/api/support/tickets/${id}/solve`).set(auth(F.token));
  assert.equal(solved.body.ticket.status, 'resolved');
  assert.equal(solved.body.ticket.solvedBy, 'user');

  // Replying reopens a resolved ticket; a closed one stays closed.
  const re = await api.post(`/api/support/tickets/${id}/reply`).set(auth(F.token)).send({ text: 'Actually only half arrived.' });
  assert.equal(re.body.ticket.status, 'open');
  await api.patch(`/api/admin/tickets/${id}`).set(auth(A.token)).send({ status: 'closed' });
  const closed = await api.post(`/api/support/tickets/${id}/reply`).set(auth(F.token)).send({ text: 'One more thing' });
  assert.equal(closed.status, 400);
});

test('status reports a measured reply time once there are enough answered tickets', async () => {
  const s1 = await api.get('/api/support/status');
  assert.equal(s1.body.support.replyHours, null, 'one answer is not enough to claim a figure');
  const Ticket = mongoose.model('Ticket');
  const now = Date.now();
  for (const h of [2, 5, 9]) {
    await Ticket.create({ number: `TKT-T${h}`, email: 'x@example.com', subject: 's', message: 'm', createdAt: new Date(now - 20 * 36e5), firstResponseAt: new Date(now - (20 - h) * 36e5) });
  }
  const s2 = await api.get('/api/support/status');
  assert.ok(s2.body.support.sample >= 3);
  assert.ok(s2.body.support.replyHours > 0 && s2.body.support.replyHours < 24);
});
