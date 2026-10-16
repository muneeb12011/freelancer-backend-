// test/social.test.js — messaging, jobs board and verification.
process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-that-is-long-enough-for-hs256-signing';
process.env.VERIFICATION_KEY = 'a'.repeat(64);
process.env.ADMIN_EMAILS = 'admin@example.com';
process.env.MONGO_URI = (process.env.MONGO_URI || '').replace(/\/[^/]*$/, '/aurelance_social_test');

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const request = require('supertest');
const mongoose = require('mongoose');
const app = require('../app');

const api = request(app);
const auth = (t) => ({ Authorization: `Bearer ${t}` });
let P; let F; let ADMIN; // poster, freelancer, admin
const reg = async (name, email) => {
  const r = await api.post('/api/auth/register').send({ name, email, password: 'correct-horse-9' });
  assert.equal(r.status, 201, r.text);
  await mongoose.model('User').updateOne({ email }, { emailVerified: true });
  return r.body;
};

test.before(async () => {
  await mongoose.connect(process.env.MONGO_URI);
  await mongoose.connection.db.dropDatabase();
  P = await reg('Poster Person', 'poster@example.com');
  F = await reg('Freelance Fatima', 'fatima@example.com');
  ADMIN = await reg('Admin', 'admin@example.com');
});
test.after(async () => { await mongoose.disconnect(); });

test('messaging: open thread, send, unread, read, attachment, block', async () => {
  const open = await api.post('/api/messages/conversations').set(auth(P.token)).send({ userId: F.user._id });
  assert.equal(open.status, 201, open.text);
  const cid = open.body.conversation._id;
  const again = await api.post('/api/messages/conversations').set(auth(F.token)).send({ userId: P.user._id });
  assert.equal(again.body.conversation._id, cid, 'one thread per pair');

  const s = await api.post(`/api/messages/conversations/${cid}/messages`).set(auth(P.token)).send({ text: 'Hi Fatima!' });
  assert.equal(s.status, 201, s.text);
  assert.equal((await api.get('/api/messages/unread').set(auth(F.token))).body.total, 1);
  const inbox = await api.get('/api/messages/conversations').set(auth(F.token));
  assert.equal(inbox.body.conversations[0].with.name, 'Poster Person');
  assert.equal(inbox.body.conversations[0].unread, 1);
  const thread = await api.get(`/api/messages/conversations/${cid}/messages`).set(auth(F.token));
  assert.equal(thread.body.messages[0].text, 'Hi Fatima!');
  assert.equal((await api.get('/api/messages/unread').set(auth(F.token))).body.total, 0);

  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=', 'base64');
  const att = await api.post(`/api/messages/conversations/${cid}/messages`).set(auth(F.token)).send({ attachment: { name: 'dot.png', type: 'image/png', data: png.toString('base64') } });
  assert.equal(att.status, 201, att.text);
  const file = await api.get(`/api/messages/attachments/${att.body.message.attachment.id}`).set(auth(P.token));
  assert.equal(file.status, 200);
  assert.equal(file.headers['content-type'], 'image/png');
  const outsider = await reg('Outsider', 'out@example.com');
  assert.equal((await api.get(`/api/messages/attachments/${att.body.message.attachment.id}`).set(auth(outsider.token))).status, 404);
  assert.equal((await api.get(`/api/messages/conversations/${cid}/messages`).set(auth(outsider.token))).status, 404);

  await api.post(`/api/messages/block/${P.user._id}`).set(auth(F.token));
  assert.equal((await api.post(`/api/messages/conversations/${cid}/messages`).set(auth(P.token)).send({ text: 'hello?' })).status, 403);
  await api.delete(`/api/messages/block/${P.user._id}`).set(auth(F.token));
  assert.equal((await api.post(`/api/messages/conversations/${cid}/messages`).set(auth(P.token)).send({ text: 'back' })).status, 201);
});

test('jobs: post, browse, apply (limit), shortlist, hire → client + thread', async () => {
  const bad = await api.post('/api/jobs').set(auth(P.token)).send({ title: 'Short', description: 'too short' });
  assert.equal(bad.status, 400);
  const job = await api.post('/api/jobs').set(auth(P.token)).send({
    title: 'Build a booking site for a dental clinic', category: 'Development', skills: 'React, Node.js',
    description: 'We need a simple booking site with appointment slots, reminders by SMS and an admin view for staff.',
    budgetType: 'fixed', budgetMin: 400, budgetMax: 800, currency: 'USD', locationType: 'remote',
  });
  assert.equal(job.status, 201, job.text);
  const jid = job.body.job._id;

  const browse = await api.get('/api/jobs?q=dental&skills=react').set(auth(F.token));
  assert.equal(browse.body.total, 1);
  assert.equal(browse.body.jobs[0].poster.name, 'Poster Person');

  assert.equal((await api.post(`/api/jobs/${jid}/save`).set(auth(F.token))).status, 200);
  assert.equal((await api.get('/api/jobs/saved').set(auth(F.token))).body.jobs.length, 1);

  assert.equal((await api.post(`/api/jobs/${jid}/apply`).set(auth(P.token)).send({ coverLetter: 'x'.repeat(60), bid: 500 })).status, 400, 'no self-apply');
  const ap = await api.post(`/api/jobs/${jid}/apply`).set(auth(F.token)).send({ coverLetter: 'I have built three clinic booking systems in React and Node with Twilio reminders.', bid: 650, timeline: '3 weeks' });
  assert.equal(ap.status, 201, ap.text);
  assert.equal((await api.post(`/api/jobs/${jid}/apply`).set(auth(F.token)).send({ coverLetter: 'x'.repeat(60), bid: 1 })).status, 400, 'no duplicate');

  assert.equal((await api.get(`/api/jobs/${jid}/applications`).set(auth(F.token))).status, 403);
  const apps = await api.get(`/api/jobs/${jid}/applications`).set(auth(P.token));
  assert.equal(apps.body.applications.length, 1);
  assert.equal(apps.body.applications[0].applicant.name, 'Freelance Fatima');

  const appId = apps.body.applications[0]._id;
  await api.patch(`/api/jobs/applications/${appId}`).set(auth(P.token)).send({ status: 'shortlisted' });
  const hire = await api.patch(`/api/jobs/applications/${appId}`).set(auth(P.token)).send({ status: 'hired' });
  assert.equal(hire.status, 200, hire.text);
  const clients = await api.get('/api/clients').set(auth(F.token));
  assert.ok(clients.body.clients.some((c) => c.name === 'Poster Person' && c.source === 'Aurelance Jobs'));
  const mine = await api.get('/api/jobs/applications/mine').set(auth(F.token));
  assert.equal(mine.body.applications[0].status, 'hired');
  const thread = await api.get(`/api/messages/conversations/${hire.body.application.conversation}/messages`).set(auth(F.token));
  assert.ok(thread.body.messages.some((m) => m.kind === 'system' && /hired/.test(m.text)));
  assert.equal((await api.delete(`/api/jobs/${jid}`).set(auth(P.token))).status, 400, 'cannot delete after hire');
});

test('jobs: free plan monthly application limit', async () => {
  const User = mongoose.model('User');
  await User.updateOne({ _id: F.user._id }, { 'usage.month': new Date().toISOString().slice(0, 7), 'usage.applications': 15 });
  const j = await api.post('/api/jobs').set(auth(P.token)).send({ title: 'Logo for a bakery in Lahore', description: 'A warm, simple logo for a family bakery — wordmark plus a small icon for the sign.', budgetMin: 50, budgetMax: 120 });
  const r = await api.post(`/api/jobs/${j.body.job._id}/apply`).set(auth(F.token)).send({ coverLetter: 'Lots of bakery branding experience, portfolio linked in my profile.', bid: 100 });
  assert.equal(r.status, 402);
});

test('verification: submit encrypted ID, admin approves, images purged, badge shown', async () => {
  const img = `data:image/jpeg;base64,${crypto.randomBytes(20 * 1024).toString('base64')}`;
  const sub = await api.post('/api/verification/identity').set(auth(F.token)).send({ fullName: 'Fatima Khan', country: 'Pakistan', docType: 'cnic', front: img, back: img, selfie: img, consent: true });
  assert.equal(sub.status, 201, sub.text);
  const IV = mongoose.model('IdentityVerification');
  const raw = await IV.findOne({ user: F.user._id }).select('+front').lean();
  assert.ok(raw.front.data && !Buffer.from(raw.front.data.buffer).equals(Buffer.from(img.split(',')[1], 'base64')), 'stored encrypted');

  assert.equal((await api.get('/api/admin/verifications').set(auth(F.token))).status, 403);
  const q = await api.get('/api/admin/verifications').set(auth(ADMIN.token));
  assert.equal(q.body.verifications.length, 1);
  const detail = await api.get(`/api/admin/verifications/${q.body.verifications[0]._id}`).set(auth(ADMIN.token));
  assert.equal(detail.body.verification.front, img, 'admin sees decrypted image');
  assert.equal((await api.post(`/api/admin/verifications/${q.body.verifications[0]._id}/approve`).set(auth(ADMIN.token))).status, 200);
  const after = await IV.findById(q.body.verifications[0]._id).select('+front').lean();
  assert.equal(after.front, undefined, 'images purged');
  const me = await api.get('/api/auth/me').set(auth(F.token));
  assert.equal(me.body.user.badges.identity, true);
  const pub = await api.get(`/api/profile/${F.user._id}`).set(auth(P.token));
  assert.equal(pub.body.profile.badges.identity, true);
});

test('connections: accept opens a conversation, contacts list, contact details only for connections', async () => {
  const A = await reg('Ali Network', 'ali@example.com');
  const B = await reg('Bina Network', 'bina@example.com');
  await api.patch('/api/profile').set(auth(B.token)).send({ phone: '+92 300 0000000' });
  const before = await api.get(`/api/profile/${B.user._id}`).set(auth(A.token));
  assert.equal(before.body.profile.email, undefined, 'email hidden before connecting');

  await api.post('/api/connections/request').set(auth(A.token)).send({ userId: B.user._id, message: 'Loved your portfolio!' });
  const pending = await api.get(`/api/profile/${A.user._id}`).set(auth(B.token));
  assert.equal(pending.body.requestReceived, true);
  const acc = await api.post(`/api/connections/request/${pending.body.requestId}/accept`).set(auth(B.token));
  assert.ok(acc.body.conversationId);

  const inboxA = await api.get('/api/messages/conversations').set(auth(A.token));
  const thread = inboxA.body.conversations.find((c) => c.with.name === 'Bina Network');
  assert.ok(thread, 'conversation appears automatically');
  const msgs = await api.get(`/api/messages/conversations/${thread._id}/messages`).set(auth(B.token));
  assert.ok(msgs.body.messages.some((m) => m.kind === 'system' && /now connected/.test(m.text)));
  assert.ok(msgs.body.messages.some((m) => m.text === 'Loved your portfolio!'));

  const contacts = await api.get('/api/messages/contacts').set(auth(A.token));
  assert.equal(contacts.body.contacts[0].name, 'Bina Network');
  const after = await api.get(`/api/profile/${B.user._id}`).set(auth(A.token));
  assert.equal(after.body.profile.email, 'bina@example.com');
  assert.equal(after.body.profile.phone, '+92 300 0000000');
  assert.equal(after.body.isConnected, true);

  const conns = await api.get('/api/connections').set(auth(A.token));
  await api.delete(`/api/connections/${conns.body.connections.find((c) => c.name === 'Bina Network')._id}`).set(auth(A.token));
  const bConns = await api.get('/api/connections').set(auth(B.token));
  assert.ok(!bConns.body.connections.some((c) => c.name === 'Ali Network'), 'disconnect is mutual');
});
