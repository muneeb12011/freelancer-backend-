// middleware/requestContext.js — request id + structured access log.
const crypto = require('crypto');
const env    = require('../config/env');
const logger = require('../utils/logger');

module.exports = function requestContext(req, res, next) {
  req.id = String(req.headers['x-request-id'] || crypto.randomUUID()).slice(0, 64);
  res.setHeader('X-Request-Id', req.id);
  if (!env.LOG_REQUESTS) return next();
  const start = process.hrtime.bigint();
  res.on('finish', () => {
    const ms = Number(process.hrtime.bigint() - start) / 1e6;
    logger.info(`${req.method} ${req.originalUrl.split('?')[0]} ${res.statusCode} ${ms.toFixed(0)}ms`, env.isProd ? { requestId: req.id } : undefined);
  });
  return next();
};
