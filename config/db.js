// config/db.js — MongoDB connection, cached across serverless invocations.
const mongoose = require('mongoose');
const env = require('./env');
const logger = require('../utils/logger');

mongoose.set('strictQuery', true);

// Re-use the connection promise between hot invocations on Vercel.
let cached = global.__aurelanceMongo;
if (!cached) cached = global.__aurelanceMongo = { conn: null, promise: null };

async function connectDB() {
  if (cached.conn && mongoose.connection.readyState === 1) return cached.conn;
  if (!env.MONGO_URI) throw Object.assign(new Error('Database is not configured'), { statusCode: 503 });

  if (!cached.promise) {
    cached.promise = mongoose
      .connect(env.MONGO_URI, {
        serverSelectionTimeoutMS: 8000,
        maxPoolSize: 10,
        autoIndex: !env.isProd, // build indexes in dev; run `npm run sync-indexes` for prod
      })
      .then((m) => {
        logger.info(`MongoDB connected: ${m.connection.host}`);
        return m;
      })
      .catch((err) => {
        cached.promise = null; // allow the next request to retry
        logger.error(`MongoDB connection failed: ${err.message}`);
        throw Object.assign(new Error('Database unavailable'), { statusCode: 503 });
      });
  }
  cached.conn = await cached.promise;
  return cached.conn;
}

function dbState() {
  return ['disconnected', 'connected', 'connecting', 'disconnecting'][mongoose.connection.readyState] || 'unknown';
}

module.exports = connectDB;
module.exports.connectDB = connectDB;
module.exports.dbState = dbState;
