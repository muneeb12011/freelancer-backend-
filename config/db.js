// config/db.js — MongoDB Atlas connection
const mongoose = require('mongoose');

const connectDB = async () => {
  // Support both MONGO_URI and MONGODB_URI
  const uri = process.env.MONGO_URI || process.env.MONGODB_URI;

  if (!uri) {
    console.error('❌ No MongoDB URI found in .env');
    console.error('   Make sure your .env file has MONGO_URI or MONGODB_URI');
    console.error('   .env must be in the same folder as server.js');
    process.exit(1);
  }

  try {
    const conn = await mongoose.connect(uri, {
      serverSelectionTimeoutMS: 5000,
    });
    console.log(`✅ MongoDB connected: ${conn.connection.host}`);
  } catch (err) {
    console.error(`❌ MongoDB connection failed: ${err.message}`);
    process.exit(1);
  }
};

module.exports = connectDB;