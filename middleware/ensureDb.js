// middleware/ensureDb.js — make sure Mongo is connected before a route touches it.
// On serverless the first request of a cold start waits here instead of failing.
const connectDB = require('../config/db');

module.exports = async function ensureDb(req, res, next) {
  try { await connectDB(); next(); } catch (err) { next(err); }
};
