// utils/logger.js — tiny structured logger. JSON lines in production, readable text in dev.
const isProd = process.env.NODE_ENV === 'production';
const silent = process.env.NODE_ENV === 'test';

function write(level, msg, meta) {
  if (silent) return;
  if (isProd) {
    const line = JSON.stringify({ level, msg, time: new Date().toISOString(), ...(meta || {}) });
    (level === 'error' ? console.error : console.log)(line); // eslint-disable-line no-console
  } else {
    const extra = meta && Object.keys(meta).length ? ` ${JSON.stringify(meta)}` : '';
    (level === 'error' ? console.error : console.log)(`[${level}] ${msg}${extra}`); // eslint-disable-line no-console
  }
}

module.exports = {
  info:  (m, meta) => write('info', m, meta),
  warn:  (m, meta) => write('warn', m, meta),
  error: (m, meta) => write('error', m, meta),
};
