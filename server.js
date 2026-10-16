// server.js — entry point.
//  • Vercel (@vercel/node) imports this file and uses the exported app as the handler.
//  • Anywhere else (local, Koyeb, Render, Docker) it starts an HTTP server.
const env    = require('./config/env');
const app    = require('./app');
const logger = require('./utils/logger');
const { connectDB } = require('./config/db');

const onVercel = Boolean(process.env.VERCEL);

if (!onVercel && require.main === module) {
  connectDB().catch(() => { /* logged in db.js; requests will retry */ });
  const server = app.listen(env.PORT, () => {
    logger.info(`Aurelance API listening on :${env.PORT} [${env.NODE_ENV}]`);
  });

  const shutdown = (signal) => {
    logger.info(`${signal} received — shutting down`);
    server.close(() => {
      require('mongoose').connection.close(false).finally(() => process.exit(0));
    });
    setTimeout(() => process.exit(1), 10000).unref();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('unhandledRejection', (err) => logger.error(`Unhandled rejection: ${err?.message || err}`));
}

module.exports = app;
