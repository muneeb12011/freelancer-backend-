// test/scam.test.js — scam shield: evasion tricks, held posts stay held after edits,
// repeat offenders get a lower bar, and only established accounts' reports count.
process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-that-is-long-enough-for-hs256-signing';
process.env.MONGO_URI = (process.env.MONGO_URI || '').replace(/\/[^/]*$/, '/aurelance_scam_test');

const test = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const mongoose = require('mongoose');
const app = require('../app');
const shield = require('../services/scamShield');

const api = request(app);
const auth = (t) => ({ Authorization: `Bearer ${t}` });
const reg = async (name, email, { old = true } = {}) => {
  const r = await api.post('/api/auth/register').send({ name, email, password: 'correct-horse-9' });
  assert.equal(r.status, 201, r.text);
  // Raw collection update: Mongoose treats createdAt as immutable.
  await mongoose.connection.db.collection('users').updateOne({ email }, { $set: { emailVerified: true, ...(old ? { createdAt: new Date(Date.now() - 30 * 86400e3) } : {}) } });
  return r.body;
};
const DESC = 'We need help building product pages and a checkout for a small fashion brand in Lahore.';
const post = (t, body) => api.post('/api/jobs').set(auth(t)).send({ category: 'Development', budgetMin: 100, budgetMax: 300, skills: ['Shopify'], description: DESC, ...body });

test.before(async () => {
  await mongoose.connect(process.env.MONGO_URI);
  await mongoose.connection.db.dropDatabase();
});
test.after(async () => { await mongoose.disconnect(); });

test('evasion: spaced letters, symbols, look-alike letters and spelled-out numbers are caught', () => {
  const cases = [
    ['Message me on w h a t s a p p', 'off_platform'],
    ['ping on wh@ts@pp', 'off_platform'],
    ['pay the regіstration fee first', 'upfront_fee'], // Cyrillic і
    ['call zero three zero zero one two three four five six seven', 'contact_details'],
    ['registration fees jama karwani hogi', 'upfront_fee'],
  ];
  for (const [t, code] of cases) {
    const r = shield.analyze(t);
    assert.ok(r.flags.some((f) => f.code === code), `${t} → ${code}`);
  }
  assert.ok(shield.analyze('Message me on w h a t s a p p').flags.some((f) => f.code === 'disguised'), 'disguising is a signal of its own');
  for (const clean of ['Must know C#, .NET 8, AWS S3, Web3, 3D, i18n, B2B SaaS', 'Milestones 1 - 2 - 3 - 4, deadline 15-11-2026', 'U.S. based, e.g. Q.A. testing']) {
    assert.equal(shield.analyze(clean).score, 0, clean);
  }
});

test('a held post stays held when edited into clean text; only an admin puts it live', async () => {
  const S = await reg('Scam Poster', 'scam1@example.com');
  const r = await post(S.token, { title: 'Data entry job, easy work', description: `${DESC} Pay the registration fee first and send your CNIC copy.` });
  assert.equal(r.body.job.status, 'review');
  const edit = await api.patch(`/api/jobs/${r.body.job._id}`).set(auth(S.token)).send({ description: DESC });
  assert.equal(edit.status, 200, edit.text);
  assert.equal(edit.body.job.status, 'review', 'still waiting for a person');
});

test('repeat offenders: two held posts lower the bar so a single warning-level flag is held', async () => {
  const S = await reg('Repeat Poster', 'scam2@example.com');
  for (const n of [1, 2]) await post(S.token, { title: `Typing job number ${n} here`, description: `${DESC} Pay the security deposit first and send your CNIC copy.` });
  const warnOnly = await post(S.token, { title: 'Store setup with checkout', description: `${DESC} Message me on telegram.` });
  assert.equal(warnOnly.body.job.status, 'review');

  const Honest = await reg('Honest Client', 'honest@example.com');
  const same = await post(Honest.token, { title: 'Store setup with checkout', description: `${DESC} Message me on telegram.` });
  assert.equal(same.body.job.status, 'open', 'a first-time warning stays visible with a caution');
});

test('reports: three established reporters pull a person’s open posts; throwaway accounts don’t count', async () => {
  const P = await reg('Busy Client', 'busy@example.com');
  const job = (await post(P.token, { title: 'Landing page for a cafe' })).body.job;
  const fresh = [];
  for (const n of [1, 2, 3]) fresh.push(await reg(`New ${n}`, `new${n}@example.com`, { old: false }));
  for (const u of fresh) await api.post('/api/reports').set(auth(u.token)).send({ target: 'user', targetId: P.user._id, reason: 'scam' });
  assert.equal((await mongoose.model('Job').findById(job._id).lean()).status, 'open', 'brand-new accounts can’t brigade');

  const old = [];
  for (const n of [1, 2, 3]) old.push(await reg(`Old ${n}`, `old${n}@example.com`));
  for (const u of old) await api.post('/api/reports').set(auth(u.token)).send({ target: 'user', targetId: P.user._id, reason: 'scam' });
  assert.equal((await mongoose.model('Job').findById(job._id).lean()).status, 'review');
});
