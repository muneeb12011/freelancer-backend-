// models/Counter.js — atomic per-user sequences (task numbers, ticket numbers).
const mongoose = require('mongoose');

const CounterSchema = new mongoose.Schema({
  key: { type: String, required: true, unique: true },
  seq: { type: Number, default: 0 },
});

// `seed` (optional async fn) supplies the starting value the first time a key is used,
// so existing data (e.g. tasks numbered before counters existed) keeps counting upward.
CounterSchema.statics.next = async function next(key, seed) {
  if (seed && !(await this.exists({ key }))) {
    const start = Number(await seed()) || 0;
    await this.updateOne({ key }, { $setOnInsert: { seq: start } }, { upsert: true }).catch(() => {});
  }
  const doc = await this.findOneAndUpdate({ key }, { $inc: { seq: 1 } }, { new: true, upsert: true, setDefaultsOnInsert: true });
  return doc.seq;
};

module.exports = mongoose.model('Counter', CounterSchema);
