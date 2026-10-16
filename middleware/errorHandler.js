// middleware/errorHandler.js — consistent JSON errors, no internals leaked in production.
const env    = require('../config/env');
const logger = require('../utils/logger');

const notFoundHandler = (req, res) => {
  res.status(404).json({ error: `Route ${req.method} ${req.originalUrl.split('?')[0]} not found`, requestId: req.id });
};

// eslint-disable-next-line no-unused-vars
const errorHandler = (err, req, res, next) => {
  let status  = err.statusCode || err.status || 500;
  let message = err.message || 'Internal server error';
  let details = err.details;

  if (err.name === 'ValidationError') {
    status = 400;
    details = Object.fromEntries(Object.entries(err.errors).map(([k, e]) => [k, e.message]));
    message = Object.values(details).join('. ');
  } else if (err.code === 11000) {
    status = 409;
    const field = Object.keys(err.keyValue || {})[0] || 'value';
    message = `${field} is already in use`;
  } else if (err.name === 'CastError') {
    status = 400;
    message = `Invalid ${err.path || 'id'}`;
  } else if (err.type === 'entity.too.large') {
    status = 413;
    message = 'Request body is too large';
  } else if (err.type === 'entity.parse.failed') {
    status = 400;
    message = 'Malformed JSON body';
  } else if (err.message && err.message.startsWith('CORS')) {
    status = 403;
  }

  if (status >= 500) {
    logger.error(message, { requestId: req.id, path: req.originalUrl, stack: env.isProd ? undefined : err.stack });
    if (env.isProd && !err.statusCode) message = 'Something went wrong on our side. Please try again.';
  }

  res.status(status).json({ error: message, ...(details ? { details } : {}), requestId: req.id });
};

module.exports = errorHandler;
module.exports.errorHandler = errorHandler;
module.exports.notFoundHandler = notFoundHandler;
