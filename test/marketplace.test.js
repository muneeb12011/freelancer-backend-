// test/marketplace.test.js — contracts, scope lock, payments record, report cards, no-ghosting,
// scam shield, payouts, squads, trials and talent search.
process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-that-is-long-enough-for-hs256-signing';
process.env.VERIFICATION_KEY = 'b'.repeat(64);
process.env.ADMIN_EMAILS = 'boss@example.com';
process.env.CRON_SECRET = 'cron-secret-for-tests';
process.env.MONGO_URI = (process.env.MONGO_URI || '').replace(/\/[^/]*$/, '/aurelance_market_test');

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const request = require('supertest');
const mongoose = require('mongoose');
const app = require('../app');

const api = request(app);
const auth = (t) => ({ Authorization: `Bearer ${t}` });
const DAY = 86400e3;
let C; let F; let F2; let ADMIN; // client, freelancer, second freelancer, admin
const reg = async (name, email) => {
  const r = await api.post('/api/auth/register').send({ name, email, password: 'correct-horse-9' });
  assert.equal(r.status, 201, r.text);
  await mongoose.model('User').updateOne({ email }, { emailVerified: true });
  return r.body;
};
const img = () => `data:image/jpeg;base64,${crypto.randomBytes(20 * 1024).toString('base64')}`;
const postJob = (tok, extra = {}) => api.post('/api/jobs').set(auth(tok)).send({
  title: 'Shopify store for a ceramics studio', category: 'Development', skills: 'Shopify, Liquid',
  description: 'Set up a Shopify store with 40 products, local delivery zones, and a clean product page template.',
  budgetMin: 300, budgetMax: 600, currency: 'USD', ...extra,
});

test.before(async () => {
  await mongoose.connect(process.env.MONGO_URI);
  await mongoose.connection.db.dropDatabase();
  C = await reg('Client Sana', 'sana@example.com');
  F = await reg('Usman Tariq', 'usman@example.com');
  F2 = await reg('Hira Malik', 'hira@example.com');
  ADMIN = await reg('Boss Admin', 'boss@example.com');
});
test.after(async () => { await mongoose.disconnect(); });

test('contract: sign → scope lock → deliver → revise → approve → paid → received → double-blind reviews → report cards', async () => {
  const job = await postJob(C.token);
  assert.equal(job.status, 201, job.text);
  const jid = job.body.job._id;
  await api.post(`/api/jobs/${jid}/apply`).set(auth(F.token)).send({ coverLetter: 'I set up eleven Shopify stores for craft brands, including delivery zones.', bid: 500 });
  const apps = await api.get(`/api/jobs/${jid}/applications`).set(auth(C.token));
  assert.ok(apps.body.applications[0].viewedAt, 'opening the list marks it viewed');
  const hire = await api.patch(`/api/jobs/applications/${apps.body.applications[0]._id}`).set(auth(C.token)).send({ status: 'hired' });
  const id = hire.body.contract._id;

  // Draft: client splits into two milestones; freelancer signs; client edits again → signatures cleared
  let r = await api.patch(`/api/engagements/${id}`).set(auth(C.token)).send({ milestones: [
    { title: 'Store setup + 40 products', scope: 'Products imported with photos and variants', amount: 300 },
    { title: 'Delivery zones + theme', scope: 'Lahore/Karachi zones, product template', amount: 200, dueDate: new Date(Date.now() + 10 * DAY) },
  ] });
  assert.equal(r.status, 200, r.text);
  assert.equal((await api.post(`/api/engagements/${id}/sign`).set(auth(F.token)).send({ name: 'wrong name' })).status, 400);
  r = await api.post(`/api/engagements/${id}/sign`).set(auth(F.token)).send({ name: 'Usman Tariq' });
  assert.ok(r.body.contract.signatures.freelancer.at);
  r = await api.patch(`/api/engagements/${id}`).set(auth(C.token)).send({ summary: 'Updated summary' });
  assert.equal(r.body.contract.signatures?.freelancer, undefined, 'edit clears signatures');
  await api.post(`/api/engagements/${id}/sign`).set(auth(F.token)).send({ name: 'Usman Tariq' });
  r = await api.post(`/api/engagements/${id}/sign`).set(auth(C.token)).send({ name: 'client sana' });
  assert.equal(r.body.contract.status, 'active');

  // Scope locked
  assert.equal((await api.patch(`/api/engagements/${id}`).set(auth(C.token)).send({ title: 'Something else entirely' })).status, 400);

  // Change request: client asks for extra; freelancer prices it via counter → here freelancer proposes, client accepts
  r = await api.post(`/api/engagements/${id}/changes`).set(auth(F.token)).send({ title: 'Add 20 more products', amount: 80 });
  assert.equal(r.status, 201, r.text);
  const cr = r.body.contract.changeRequests[0]._id;
  assert.equal((await api.post(`/api/engagements/${id}/changes/${cr}/accept`).set(auth(F.token))).status, 403, 'can’t accept own change');
  r = await api.post(`/api/engagements/${id}/changes/${cr}/accept`).set(auth(C.token));
  assert.equal(r.body.contract.milestones.length, 3);
  assert.equal(r.body.contract.milestones[2].source, 'change');

  const [m1, m2, m3] = r.body.contract.milestones.map((m) => m._id);
  const file = await api.post(`/api/engagements/${id}/files`).set(auth(F.token)).send({ name: 'products.csv', type: 'text/plain', data: Buffer.from('sku,name').toString('base64') });
  assert.equal(file.status, 201, file.text);
  r = await api.post(`/api/engagements/${id}/milestones/${m1}/submit`).set(auth(F.token)).send({ note: 'All 40 products are live: https://ceramics.example', files: [file.body.file.id] });
  assert.equal(r.body.contract.milestones[0].status, 'submitted');
  r = await api.post(`/api/engagements/${id}/milestones/${m1}/revise`).set(auth(C.token)).send({ note: 'Two products are missing their variants' });
  assert.equal(r.body.contract.milestones[0].status, 'open');
  await api.post(`/api/engagements/${id}/milestones/${m1}/submit`).set(auth(F.token)).send({ note: 'Variants fixed for both products' });
  assert.equal((await api.post(`/api/engagements/${id}/milestones/${m1}/paid`).set(auth(C.token)).send({ method: 'bank', reference: 'FT123' })).status, 400, 'approve before paying');
  await api.post(`/api/engagements/${id}/milestones/${m1}/approve`).set(auth(C.token));
  r = await api.post(`/api/engagements/${id}/milestones/${m1}/paid`).set(auth(C.token)).send({ method: 'bank', reference: 'FT2610171234' });
  assert.equal(r.body.contract.milestones[0].status, 'paid');
  assert.equal((await api.post(`/api/engagements/${id}/milestones/${m1}/not-received`).set(auth(F.token)).send({ note: 'nothing yet' })).status, 400, 'must wait 2 days');
  r = await api.post(`/api/engagements/${id}/milestones/${m1}/received`).set(auth(F.token));
  assert.equal(r.body.contract.milestones[0].status, 'received');

  for (const m of [m2, m3]) {
    await api.post(`/api/engagements/${id}/milestones/${m}/submit`).set(auth(F.token)).send({ note: 'Done and live on the store' });
    await api.post(`/api/engagements/${id}/milestones/${m}/approve`).set(auth(C.token));
    await api.post(`/api/engagements/${id}/milestones/${m}/paid`).set(auth(C.token)).send({ method: 'payoneer', reference: 'PYN-998877' });
    r = await api.post(`/api/engagements/${id}/milestones/${m}/received`).set(auth(F.token));
  }
  assert.equal(r.body.contract.status, 'completed');
  assert.equal(r.body.contract.totals.received, 580);

  // Double-blind reviews
  r = await api.post(`/api/engagements/${id}/review`).set(auth(F.token)).send({ ratings: { payment: 5, scope: 4, communication: 5, respect: 5 }, comment: 'Paid same day.' });
  assert.equal(r.status, 201, r.text);
  let other = await api.get(`/api/engagements/${id}`).set(auth(C.token));
  assert.equal(other.body.contract.review.theirs, null, 'hidden until both reviewed');
  assert.equal(other.body.contract.review.theirsSubmitted, true);
  let pubReviews = await api.get(`/api/profile/${C.user._id}/reviews`).set(auth(F2.token));
  assert.equal(pubReviews.body.reviews.length, 0);
  await api.post(`/api/engagements/${id}/review`).set(auth(C.token)).send({ ratings: { quality: 5, communication: 4, deadlines: 5 }, comment: 'Great store.' });
  other = await api.get(`/api/engagements/${id}`).set(auth(C.token));
  assert.equal(other.body.contract.review.theirs.comment, 'Paid same day.');
  pubReviews = await api.get(`/api/profile/${C.user._id}/reviews`).set(auth(F2.token));
  assert.equal(pubReviews.body.reviews[0].ratings.payment, 5);

  // Report cards
  const pc = await api.get(`/api/profile/${C.user._id}`).set(auth(F2.token));
  const rc = pc.body.profile.reputation.asClient;
  assert.equal(rc.milestonesPaid, 3);
  assert.equal(rc.paidOnTimeRate, 100);
  assert.equal(rc.payment, 5);
  const pf = await api.get(`/api/profile/${F.user._id}`).set(auth(F2.token));
  assert.equal(pf.body.profile.reputation.asFreelancer.completed, 1);
  assert.equal(pf.body.profile.reputation.asFreelancer.quality, 5);
  const jobNow = await api.get(`/api/jobs/${jid}`).set(auth(C.token));
  assert.equal(jobNow.body.job.status, 'filled');
});

test('scam shield: risky job held, warn job flagged, message caution, card numbers blocked, reports auto-hold', async () => {
  const held = await postJob(C.token, { title: 'Easy data entry job from home', description: 'Pay a refundable registration fee of 2000 first, then contact me on WhatsApp +92 300 1234567 and send your CNIC copy to start.' });
  assert.equal(held.status, 201);
  assert.equal(held.body.job.status, 'review');
  assert.ok(held.body.job.safety.flags.some((f) => f.code === 'upfront_fee'));
  assert.equal((await api.get(`/api/jobs/${held.body.job._id}`).set(auth(F.token))).status, 404, 'hidden from others');
  const browse = await api.get('/api/jobs').set(auth(F.token));
  assert.ok(!browse.body.jobs.some((j) => j._id === held.body.job._id));

  const queue = await api.get('/api/admin/safety').set(auth(ADMIN.token));
  assert.ok(queue.body.jobs.some((j) => j._id === held.body.job._id));
  assert.equal((await api.post(`/api/admin/jobs/${held.body.job._id}/remove`).set(auth(ADMIN.token))).status, 200);

  const warn = await postJob(C.token, { title: 'Landing page for a gym in Lahore', description: 'One landing page with class timetable and a signup form. Reach me at sana.gym@example.com for the brand files.' });
  assert.equal(warn.body.job.status, 'open');
  assert.equal(warn.body.job.safety.verdict, 'warn');

  const convo = await api.post('/api/messages/conversations').set(auth(C.token)).send({ userId: F2.user._id });
  const cid = convo.body.conversation._id;
  const m = await api.post(`/api/messages/conversations/${cid}/messages`).set(auth(C.token)).send({ text: 'Lets move to telegram, and I need your OTP to send payment' });
  assert.ok(m.body.message.flags.length >= 2);
  const card = await api.post(`/api/messages/conversations/${cid}/messages`).set(auth(C.token)).send({ text: 'my card is 4242 4242 4242 4242' });
  assert.equal(card.status, 400);

  // Three different people report a job → pulled for review
  const r1 = await reg('Reporter One', 'r1@example.com'); const r2 = await reg('Reporter Two', 'r2@example.com');
  for (const t of [F.token, r1.token, r2.token]) {
    const rr = await api.post('/api/reports').set(auth(t)).send({ target: 'job', targetId: warn.body.job._id, reason: 'scam' });
    assert.equal(rr.status, 201, rr.text);
  }
  const after = await api.get(`/api/jobs/${warn.body.job._id}`).set(auth(C.token));
  assert.equal(after.body.job.status, 'review');
});

test('no-ghosting: decline-rest notifies, cron warns then auto-closes and counts it', async () => {
  const job = await postJob(C.token, { title: 'Translate a menu to Urdu and Arabic', description: 'Translate a two-page restaurant menu into Urdu and Arabic, keeping dish names in English too.' });
  const jid = job.body.job._id;
  await api.post(`/api/jobs/${jid}/apply`).set(auth(F.token)).send({ coverLetter: 'Native Urdu speaker with restaurant translation work for three Lahore cafés.', bid: 60 });
  await api.post(`/api/jobs/${jid}/apply`).set(auth(F2.token)).send({ coverLetter: 'Arabic and Urdu translator, five years, including food and hospitality.', bid: 70 });

  // Age the applications and the poster's last activity by 15 days, then run the cron.
  const ago = new Date(Date.now() - 15 * DAY);
  await mongoose.model('JobApplication').collection.updateMany({ job: new mongoose.Types.ObjectId(jid) }, { $set: { createdAt: ago } });
  await mongoose.model('Job').collection.updateOne({ _id: new mongoose.Types.ObjectId(jid) }, { $set: { posterActiveAt: ago, createdAt: ago } });
  const cron = await api.get('/api/cron/daily').set({ Authorization: 'Bearer cron-secret-for-tests' });
  assert.equal(cron.status, 200, cron.text);
  assert.ok(cron.body.results.noGhosting.closed >= 1);
  const j = await api.get(`/api/jobs/${jid}`).set(auth(C.token));
  assert.equal(j.body.job.status, 'closed');
  assert.equal(j.body.job.closedReason, 'no_response');
  const mine = await api.get('/api/jobs/applications/mine').set(auth(F2.token));
  assert.equal(mine.body.applications.find((a) => a.job?._id === jid).status, 'closed');
  const prof = await api.get(`/api/profile/${C.user._id}`).set(auth(F.token));
  assert.equal(prof.body.profile.reputation.asClient.ghosted, 2);

  // decline-rest answers everyone at once
  const job2 = await postJob(C.token, { title: 'Bookkeeping cleanup for Q3 accounts', description: 'Reconcile three months of bank statements in Xero and fix miscategorised expenses for a small agency.' });
  await api.post(`/api/jobs/${job2.body.job._id}/apply`).set(auth(F.token)).send({ coverLetter: 'Xero certified, I reconcile agency books monthly for four clients.', bid: 150 });
  const d = await api.post(`/api/jobs/${job2.body.job._id}/decline-rest`).set(auth(C.token)).send({ reason: 'budget' });
  assert.equal(d.body.answered, 1);
  const a2 = await api.get('/api/jobs/applications/mine').set(auth(F.token));
  const ap = a2.body.applications.find((a) => a.job?._id === job2.body.job._id);
  assert.equal(ap.status, 'rejected');
  assert.equal(ap.declineReason, 'budget');
});

test('payouts: IBAN checksum, name must match ID, email code, admin review, share on contract, client sees details', async () => {
  const bad = await api.post('/api/payouts').set(auth(F.token)).send({ type: 'bank', holderName: 'Usman Tariq', bankName: 'Meezan Bank', iban: 'PK36SCBL0000001123456703' });
  assert.equal(bad.status, 400, 'bad checksum');
  const card = await api.post('/api/payouts').set(auth(F.token)).send({ type: 'card', holderName: 'Usman Tariq', brand: 'visa', number: '4242424242424242' });
  assert.equal(card.status, 400, 'full card numbers refused');
  const ok = await api.post('/api/payouts').set(auth(F.token)).send({ type: 'bank', holderName: 'Usman Tariq', bankName: 'Standard Chartered', iban: 'PK36SCBL0000001123456702', swift: 'SCBLPKKX' });
  assert.equal(ok.status, 201, ok.text);
  const raw = await mongoose.model('PayoutMethod').findById(ok.body.method._id).select('+secret').lean();
  assert.ok(!JSON.stringify(raw).includes('PK36SCBL0000001123456702'), 'IBAN encrypted at rest');
  assert.equal(ok.body.method.display, 'Standard Chartered ••••6702');

  // Verify needs identity first
  const proof = img();
  assert.equal((await api.post(`/api/payouts/${ok.body.method._id}/verify`).set(auth(F.token)).send({ proof })).status, 400);
  await api.post('/api/verification/identity').set(auth(F.token)).send({ fullName: 'Usman Tariq', country: 'Pakistan', docType: 'cnic', front: img(), back: img(), selfie: img(), consent: true });
  const q = await api.get('/api/admin/verifications').set(auth(ADMIN.token));
  await api.post(`/api/admin/verifications/${q.body.verifications[0]._id}/approve`).set(auth(ADMIN.token));

  const wrongName = await api.post('/api/payouts').set(auth(F.token)).send({ type: 'payoneer', holderName: 'Someone Else', email: 'usman.pay@example.com' });
  assert.equal((await api.post(`/api/payouts/${wrongName.body.method._id}/verify`).set(auth(F.token)).send({ proof })).status, 400, 'name mismatch');

  const pyn = await api.post('/api/payouts').set(auth(F.token)).send({ type: 'payoneer', holderName: 'Usman Tariq', email: 'usman.pay@example.com' });
  assert.equal((await api.post(`/api/payouts/${pyn.body.method._id}/verify`).set(auth(F.token)).send({ proof })).status, 400, 'email not confirmed');
  const sent = await api.post(`/api/payouts/${pyn.body.method._id}/email-code`).set(auth(F.token));
  assert.equal(sent.status, 200, sent.text);
  // Read the code by brute force over the hash in the DB (test only).
  const doc = await mongoose.model('PayoutMethod').findById(pyn.body.method._id).select('+emailCheck.codeHash').lean();
  let code = null;
  for (let i = 100000; i < 1000000 && !code; i += 1) if (crypto.createHash('sha256').update(String(i)).digest('hex') === doc.emailCheck.codeHash) code = String(i);
  const conf = await api.post(`/api/payouts/${pyn.body.method._id}/email-confirm`).set(auth(F.token)).send({ code });
  assert.equal(conf.status, 200, conf.text);

  for (const m of [ok.body.method._id, pyn.body.method._id]) {
    const v = await api.post(`/api/payouts/${m}/verify`).set(auth(F.token)).send({ proof, proofKind: 'statement' });
    assert.equal(v.status, 200, v.text);
  }
  const pq = await api.get('/api/admin/payouts').set(auth(ADMIN.token));
  assert.equal(pq.body.payouts.length, 2);
  const pd = await api.get(`/api/admin/payouts/${ok.body.method._id}`).set(auth(ADMIN.token));
  assert.equal(pd.body.payout.details.iban, 'PK36SCBL0000001123456702');
  for (const p of pq.body.payouts) await api.post(`/api/admin/payouts/${p._id}/approve`).set(auth(ADMIN.token));
  const after = await mongoose.model('PayoutMethod').findById(ok.body.method._id).select('+proof').lean();
  assert.equal(after.proof, undefined, 'proof purged');

  const pub = await api.get(`/api/profile/${F.user._id}`).set(auth(C.token));
  assert.deepEqual(pub.body.profile.payoutTypes.sort(), ['bank', 'payoneer']);
  assert.equal(pub.body.profile.badges.payout, true);
  assert.ok(!JSON.stringify(pub.body).includes('6702') || !JSON.stringify(pub.body).includes('PK36'), 'no account numbers on profile');

  // Talent search by verified payout
  const t = await api.get('/api/talent?payout=payoneer').set(auth(C.token));
  assert.ok(t.body.people.some((p) => p.name === 'Usman Tariq'));
  assert.ok(!t.body.people.some((p) => p.name === 'Hira Malik'));

  // Share on a contract; only the two parties can read it
  const direct = await api.post('/api/engagements').set(auth(C.token)).send({ freelancer: F.user._id, title: 'Monthly store updates', milestones: [{ title: 'October updates', amount: 120 }] });
  const id = direct.body.contract._id;
  await api.post(`/api/engagements/${id}/sign`).set(auth(F.token)).send({ name: 'Usman Tariq' });
  await api.post(`/api/engagements/${id}/sign`).set(auth(C.token)).send({ name: 'Client Sana' });
  assert.equal((await api.post(`/api/engagements/${id}/share-payout`).set(auth(F.token)).send({ method: wrongName.body.method._id })).status, 400, 'unverified cannot be shared');
  await api.post(`/api/engagements/${id}/share-payout`).set(auth(F.token)).send({ method: ok.body.method._id });
  const seen = await api.get(`/api/engagements/${id}/payout`).set(auth(C.token));
  assert.equal(seen.body.details.iban, 'PK36SCBL0000001123456702');
  assert.equal((await api.get(`/api/engagements/${id}/payout`).set(auth(F2.token))).status, 404, 'outsiders cannot');
  const log = await api.get(`/api/engagements/${id}`).set(auth(F.token));
  assert.ok(log.body.contract.sharedPayout.viewedAt, 'freelancer sees when it was viewed');
});

test('squads + paid trial: invite connection, accept, apply as squad, trial contract', async () => {
  // connect F2 → F
  await api.post('/api/connections/request').set(auth(F2.token)).send({ userId: F.user._id });
  const prof = await api.get(`/api/profile/${F2.user._id}`).set(auth(F.token));
  await api.post(`/api/connections/request/${prof.body.requestId}/accept`).set(auth(F.token));

  const sq = await api.post('/api/squads').set(auth(F2.token)).send({ name: 'Studio Two', tagline: 'Design + Shopify', skills: 'Figma, Shopify', role: 'Design' });
  assert.equal(sq.status, 201, sq.text);
  const sid = sq.body.squad._id;
  assert.equal((await api.post(`/api/squads/${sid}/invite`).set(auth(F2.token)).send({ userId: C.user._id })).status, 400, 'only connections');
  await api.post(`/api/squads/${sid}/invite`).set(auth(F2.token)).send({ userId: F.user._id, role: 'Shopify dev' });
  const mine = await api.get('/api/squads/mine').set(auth(F.token));
  assert.equal(mine.body.invitations.length, 1);
  await api.post(`/api/squads/${sid}/accept`).set(auth(F.token));

  const trialJob = await postJob(C.token, { title: 'Paid trial: redesign one product page', description: 'Redesign our best-selling product page. Paid trial to pick a long-term partner for the whole store.', kind: 'trial', trialSlots: 2, budgetMin: 40, budgetMax: 40 });
  assert.equal(trialJob.status, 201, trialJob.text);
  assert.equal(trialJob.body.job.kind, 'trial');
  const ap = await api.post(`/api/jobs/${trialJob.body.job._id}/apply`).set(auth(F2.token)).send({ coverLetter: 'We are a two-person squad: design plus Shopify build, five stores shipped.', bid: 40, squad: sid });
  assert.equal(ap.status, 201, ap.text);
  const apps = await api.get(`/api/jobs/${trialJob.body.job._id}/applications`).set(auth(C.token));
  assert.equal(apps.body.applications[0].squad.members.length, 2);
  assert.equal((await api.patch(`/api/jobs/applications/${apps.body.applications[0]._id}`).set(auth(C.token)).send({ status: 'hired' })).status, 400, 'trial posts use trials');
  const tr = await api.post(`/api/jobs/applications/${apps.body.applications[0]._id}/trial`).set(auth(C.token)).send({ scope: 'Redesign the product page for the blue glaze mug, mobile first.', days: 3 });
  assert.equal(tr.status, 201, tr.text);
  const contract = await api.get(`/api/engagements/${tr.body.contract._id}`).set(auth(F.token));
  assert.equal(contract.status, 200, contract.text);
  assert.equal(contract.body.contract.kind, 'trial');
  assert.equal(contract.body.contract.milestones[0].amount, 40);
  assert.equal(contract.body.contract.squad.name, 'Studio Two');

  const home = await api.get('/api/home').set(auth(F2.token));
  assert.ok(home.body.todo.some((t) => t.kind === 'sign'));
});
