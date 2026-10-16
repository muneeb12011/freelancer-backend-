// api/index.js — kept for platforms that expect a serverless function in /api.
// vercel.json routes everything to server.js, which exports the same Express app.
module.exports = require('../app');
