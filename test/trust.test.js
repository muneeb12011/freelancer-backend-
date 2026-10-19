// test/trust.test.js — the trust check in conversations: what's verified, warnings, call codes,
// verification requests, and work-email confirmation.
process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-that-is-long-enough-for-hs256-signing';
process.env.MONGO_URI = (process.env.MONGO_URI || '').replace(/\/[^/]*$/, '/aurelance_trust_test');

const test = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const mongoose = require('mongoose');
const app = require('../app');
const trust = require('../services/trust');

const api = request(app);
const auth = (t) => ({ Authorization: `Bearer ${t}` });
let C; let F; let convo;
const reg = async (name, email) => {
  const r = await api.post('/api/auth/register').send({ name, email, password: 'correct-horse-9' });
  assert.equal(r.status, 201, r.text);
  return r.body;
};

test.before(async () => {
  await mongoose.connect(process.env.MONGO_URI);
  await mongoose.connection.db.dropDatabase();
  C = await reg('Sara Haider', 'sara@northwind.studio');
  F = await reg('Imran Khan', 'imran@example.org');
  const r = await api.post('/api/messages/conversations').set(auth(F.token)).send({ userId: C.user._id });
  convo = r.body.conversation._id;
});
test.after(async () => { await mongoose.disconnect(); });

test('a fresh account shows nothing verified and a new-account warning', async () => {
  const r = await api.get(`/api/messages/conversations/${convo}/trust`).set(auth(F.token));
  assert.equal(r.status, 200, r.text);
  assert.equal(r.body.trust.user.name, 'Sara Haider');
  assert.equal(r.body.trust.level, 'none');
  assert.ok(r.body.trust.checks.every((c) => !c.ok));
  assert.ok(r.body.trust.warnings.some((w) => w.id === 'new'));
  assert.equal(r.body.firstContact, true);
  const stranger = await reg('Nosy Person', 'nosy@example.org');
  const no = await api.get(`/api/messages/conversations/${convo}/trust`).set(auth(stranger.token));
  assert.equal(no.status, 404, 'only the two people in the chat');
});

test('work email: personal providers refused, code confirms, only the domain is public', async () => {
  const bad = await api.post('/api/verification/work-email').set(auth(C.token)).send({ email: 'sara.haider@gmail.com' });
  assert.equal(bad.status, 400);
  assert.match(bad.body.error, /personal email provider/);
  const sent = await api.post('/api/verification/work-email').set(auth(C.token)).send({ email: 'sara@acme-tiles.pk' });
  assert.equal(sent.status, 200, sent.text);
  assert.ok(sent.body.devCode, 'code is returned only outside production without email');
  const wrong = await api.post('/api/verification/work-email/confirm').set(auth(C.token)).send({ code: '000000' });
  assert.equal(wrong.status, 400);
  const ok = await api.post('/api/verification/work-email/confirm').set(auth(C.token)).send({ code: sent.body.devCode });
  assert.equal(ok.body.domain, 'acme-tiles.pk');

  const t = await api.get(`/api/messages/conversations/${convo}/trust`).set(auth(F.token));
  const work = t.body.trust.checks.find((c) => c.id === 'work');
  assert.equal(work.ok, true);
  assert.match(work.label, /acme-tiles\.pk/);
  assert.ok(!JSON.stringify(t.body).includes('sara@acme-tiles.pk'), 'the address itself stays private');
  const thread = await api.get(`/api/messages/conversations/${convo}`).set(auth(F.token));
  assert.equal(thread.body.conversation.with.badges.work, 'acme-tiles.pk');
});

test('ID + work email = strong; risky messages in the chat turn it into a warning', async () => {
  await mongoose.model('User').updateOne({ _id: C.user._id }, { 'identity.status': 'approved' });
  let t = await api.get(`/api/messages/conversations/${convo}/trust`).set(auth(F.token));
  assert.equal(t.body.trust.level, 'strong');
  await api.post(`/api/messages/conversations/${convo}/messages`).set(auth(C.token)).send({ text: 'Before we start, pay the registration fee first and message me on telegram' });
  t = await api.get(`/api/messages/conversations/${convo}/trust`).set(auth(F.token));
  assert.equal(t.body.trust.level, 'warn');
  assert.ok(t.body.trust.warnings.some((w) => w.id === 'messages' && /upfront fee/.test(w.detail)));
});

test('call codes: same for both people, rotate, and a match is recorded in the chat', async () => {
  const a = await api.get(`/api/messages/conversations/${convo}/call-code`).set(auth(C.token));
  const b = await api.get(`/api/messages/conversations/${convo}/call-code`).set(auth(F.token));
  assert.equal(a.body.code, b.body.code);
  assert.match(a.body.code, /^\d{6}$/);
  assert.notEqual(trust.callCode(convo, Date.now()).code, trust.callCode(convo, Date.now() + 10 * 60e3).code, 'codes rotate');
  assert.notEqual(trust.callCode(convo).code, trust.callCode(String(new mongoose.Types.ObjectId())).code, 'each chat has its own');
  assert.ok(trust.codeMatches(convo, trust.callCode(convo, Date.now() - trust.WINDOW_MS).code), 'the previous code still works while it rolls over');

  const wrong = await api.post(`/api/messages/conversations/${convo}/call-check`).set(auth(F.token)).send({ code: '123456' === a.body.code ? '654321' : '123456' });
  assert.equal(wrong.status, 400);
  const ok = await api.post(`/api/messages/conversations/${convo}/call-check`).set(auth(F.token)).send({ code: a.body.code.replace(/(\d{3})/, '$1 ') });
  assert.equal(ok.status, 200, ok.text);
  const t = await api.get(`/api/messages/conversations/${convo}/trust`).set(auth(F.token));
  assert.ok(t.body.trust.callCheckedAt);
  const theirs = await api.get(`/api/messages/conversations/${convo}/trust`).set(auth(C.token));
  assert.ok(theirs.body.iWasCallChecked, 'the checked person sees it too');
  const msgs = await api.get(`/api/messages/conversations/${convo}/messages`).set(auth(C.token));
  assert.ok(msgs.body.messages.some((m) => m.kind === 'system' && /checked on a call/.test(m.text)));
});

test('asking to verify posts a note, notifies, and is throttled', async () => {
  const r = await api.post(`/api/messages/conversations/${convo}/ask-verify`).set(auth(C.token)).send({ what: 'identity' });
  assert.equal(r.status, 200, r.text);
  const again = await api.post(`/api/messages/conversations/${convo}/ask-verify`).set(auth(C.token)).send({ what: 'payout' });
  assert.equal(again.status, 400);
  const bell = await api.get('/api/notifications').set(auth(F.token));
  assert.ok(bell.body.items.some((n) => n.type === 'trust.ask'));
});

test('domain rules', () => {
  assert.equal(trust.isWorkDomain('gmail.com'), false);
  assert.equal(trust.isWorkDomain('northwind.studio'), true);
  assert.equal(trust.isWorkDomain('localhost'), false);
});
