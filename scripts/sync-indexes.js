// scripts/sync-indexes.js — build/refresh MongoDB indexes (run once per deploy in production,
// where autoIndex is off to keep cold starts fast):  npm run sync-indexes
const fs = require('fs');
const path = require('path');
const mongoose = require('mongoose');
const env = require('../config/env');

(async () => {
  await mongoose.connect(env.MONGO_URI);
  const dir = path.join(__dirname, '..', 'models');
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.js'))) {
    const model = require(path.join(dir, f));
    if (model?.syncIndexes) {
      await model.syncIndexes();
      console.log(`✓ ${model.modelName}`); // eslint-disable-line no-console
    }
  }
  await mongoose.disconnect();
})().catch((e) => { console.error(e); process.exit(1); }); // eslint-disable-line no-console
