// scripts/sync-indexes.js — build/refresh MongoDB indexes and backfill derived fields.
// Run once per deploy in production, where autoIndex is off to keep cold starts fast:
//   npm run sync-indexes
const fs = require('fs');
const path = require('path');
const mongoose = require('mongoose');
const env = require('../config/env');

/* eslint-disable no-console */
(async () => {
  await mongoose.connect(env.MONGO_URI);
  const dir = path.join(__dirname, '..', 'models');
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.js'))) {
    const model = require(path.join(dir, f));
    if (model?.syncIndexes) {
      await model.syncIndexes();
      console.log(`✓ indexes ${model.modelName}`);
    }
  }

  // Backfill: lowercase skill keys and poster trust signals on jobs saved before they existed.
  const Job = require('../models/Job');
  const User = require('../models/User');
  let n = 0;
  for await (const j of Job.find({ $or: [{ skillsKey: { $exists: false } }, { skillsKey: { $size: 0 }, 'skills.0': { $exists: true } }] }).select('skills').lean().cursor()) {
    const key = [...new Set((j.skills || []).map((s) => String(s).trim().toLowerCase()).filter(Boolean))];
    await Job.updateOne({ _id: j._id }, { $set: { skillsKey: key } });
    n += 1;
  }
  console.log(`✓ skill keys on ${n} jobs`);
  const posters = await Job.distinct('postedBy', { status: { $in: ['open', 'review'] } });
  for (const id of posters) {
    const u = await User.findById(id).select('identity.status reputation').lean();
    if (u) await Job.updateMany({ postedBy: id, status: { $in: ['open', 'review'] } }, { $set: { posterSignals: Job.signalsFor(u) } });
  }
  console.log(`✓ trust signals for ${posters.length} posters`);
  await mongoose.disconnect();
})().catch((e) => { console.error(e); process.exit(1); });
