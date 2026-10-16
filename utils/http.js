// utils/http.js — error type + async wrapper so routes don't need try/catch everywhere.
class HttpError extends Error {
  constructor(statusCode, message, details) {
    super(message);
    this.statusCode = statusCode;
    if (details) this.details = details;
  }
}

const asyncHandler = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

const badRequest   = (m, d) => new HttpError(400, m, d);
const unauthorized = (m = 'Not authorised') => new HttpError(401, m);
const forbidden    = (m = 'Forbidden') => new HttpError(403, m);
const notFound     = (m = 'Not found') => new HttpError(404, m);

module.exports = { HttpError, asyncHandler, badRequest, unauthorized, forbidden, notFound };
