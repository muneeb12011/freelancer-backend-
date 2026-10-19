// test/search.test.js — job search: indexed skill keys, poster trust signals, the ranked $text
// query shape, and the automatic fallback when the database can't run $text.
process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-that-is-long-enough-for-hs256-signing';
process.env.MONGO_URI = (process.env.MONGO_URI || '').replace(/\/[^/]*$/, '/aurelance_search_test');

const test = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const mongoose = require('mongoose');
const app = require('../app');
const Job = require('../models/Job');
const jobSearch = require('../services/jobSearch');

const api = request(app);
const auth = (t) => ({ Authorization: `Bearer ${t}` });
let C; let F;
const reg = async (name, email) => {
  const r = await api.post('/api/auth/register').send({ name, email, password: 'correct-horse-9' });
  assert.equal(r.status, 201, r.text);
  await mongoose.model('User').updateOne({ email }, { emailVerified: true });
  return r.body;
};
const post = (t, body) => api.post('/api/jobs').set(auth(t)).send({ category: 'Development', budgetMin: 200, budgetMax: 600, description: 'A clear description of the work that is long enough to pass validation for the board.', ...body });

test.before(async () => {
  await mongoose.connect(process.env.MONGO_URI);
  await mongoose.connection.db.dropDatabase();
  C = await reg('Rabia Khan', 'rabia@example.com');
  F = await reg('Ali Raza', 'ali@example.com');
  await post(C.token, { title: 'Shopify theme fixes for a skincare brand', skills: ['Shopify', 'Liquid'] });
  await post(C.token, { title: 'React Native delivery app', skills: ['React Native', 'Firebase'] });
  await post(C.token, { title: 'Logo for a bakery', category: 'Design', skills: ['Branding'] });
});
test.after(async () => { await mongoose.disconnect(); });

test('skill keys are lowercase and filter without case-insensitive regex', async () => {
  const j = await Job.findOne({ title: /Shopify theme/ }).lean();
  assert.deepEqual(j.skillsKey, ['shopify', 'liquid']);
  const { filter } = await jobSearch.build({ skills: 'SHOPIFY, liquid' });
  assert.deepEqual(filter.skillsKey, { $in: ['shopify', 'liquid'] });
  const r = await api.get('/api/jobs?skills=shopify').set(auth(F.token));
  assert.equal(r.body.total, 1);
  assert.match(r.body.jobs[0].title, /Shopify/);
});

test('editing skills keeps the key in sync', async () => {
  const j = await Job.findOne({ title: /Logo/ });
  j.skills = ['Branding', 'Illustrator'];
  await j.save();
  assert.deepEqual((await Job.findById(j._id).lean()).skillsKey, ['branding', 'illustrator']);
});

test('"reliable clients only" is a field match that follows the poster’s record', async () => {
  let r = await api.get('/api/jobs?reliable=true').set(auth(F.token));
  assert.equal(r.body.total, 0, 'new, unverified client is not "reliable" yet');
  await mongoose.model('User').updateOne({ _id: C.user._id }, { 'identity.status': 'approved' });
  await require('../services/reputation').refresh(C.user._id);
  r = await api.get('/api/jobs?reliable=true').set(auth(F.token));
  assert.equal(r.body.total, 3);
  const j = await Job.findOne({}).lean();
  assert.equal(j.posterSignals.verified, true);
});

test('keyword search falls back to plain matching when $text is unavailable', async () => {
  jobSearch._reset();
  const r = await api.get('/api/jobs?q=delivery').set(auth(F.token));
  assert.equal(r.status, 200, r.text);
  assert.equal(r.body.total, 1);
  assert.match(r.body.jobs[0].title, /React Native/);
  const bySkill = await api.get('/api/jobs?q=firebase').set(auth(F.token));
  assert.equal(bySkill.body.total, 1, 'a keyword that is only a skill still matches');
});

test('when $text works, the query is ranked by text score', async () => {
  const real = Job.find;
  Job.find = function probeOk(filter, ...rest) {
    if (filter && filter.$text) return { select: () => ({ limit: () => ({ lean: async () => [] }) }) };
    return real.call(this, filter, ...rest);
  };
  try {
    jobSearch._reset();
    const { filter, ranked } = await jobSearch.build({ q: 'shopify theme' });
    assert.equal(ranked, true);
    assert.deepEqual(filter.$text, { $search: 'shopify theme' });
    assert.equal(filter.$or, undefined, 'no regex scan when ranked');
  } finally { Job.find = real; jobSearch._reset(); }
});
