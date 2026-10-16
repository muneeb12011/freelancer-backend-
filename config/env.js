// config/env.js — single place where environment variables are read and validated.
// Every other module imports `env` from here instead of touching process.env directly.
require('dotenv').config();

const list = (v) => (v || '').split(',').map((s) => s.trim().replace(/\/$/, '')).filter(Boolean);
const bool = (v, d = false) => (v === undefined || v === '' ? d : ['1', 'true', 'yes'].includes(String(v).toLowerCase()));
const int  = (v, d) => (Number.isFinite(parseInt(v, 10)) ? parseInt(v, 10) : d);

const NODE_ENV = process.env.NODE_ENV || 'development';
const isProd   = NODE_ENV === 'production';

const CLIENT_URL = (process.env.CLIENT_URL || 'http://localhost:3000').replace(/\/$/, '');

const env = {
  NODE_ENV,
  isProd,
  isTest: NODE_ENV === 'test',
  PORT: int(process.env.PORT, 5000),

  MONGO_URI: process.env.MONGO_URI || process.env.MONGODB_URI || '',

  JWT_SECRET:     process.env.JWT_SECRET || '',
  JWT_EXPIRES_IN: process.env.JWT_EXPIRES_IN || '7d',

  // Public URLs
  CLIENT_URL,
  SERVER_URL: (process.env.SERVER_URL
    || (process.env.VERCEL_PROJECT_PRODUCTION_URL && `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}`)
    || (isProd ? 'https://freelancer-backend-khaki.vercel.app' : `http://localhost:${int(process.env.PORT, 5000)}`)).replace(/\/$/, ''),

  // CORS — CLIENT_URL is always allowed; add extra origins comma-separated.
  // Vercel preview deployments can be allowed with CORS_ALLOW_VERCEL_PREVIEWS=true.
  CORS_ORIGINS: Array.from(new Set([CLIENT_URL, ...list(process.env.CORS_ORIGINS)])),
  CORS_ALLOW_VERCEL_PREVIEWS: bool(process.env.CORS_ALLOW_VERCEL_PREVIEWS, false),
  VERCEL_PROJECT_SLUG: process.env.VERCEL_PROJECT_SLUG || 'freelancers-assistant',

  // OAuth
  GOOGLE_CLIENT_ID:     process.env.GOOGLE_CLIENT_ID || '',
  GOOGLE_CLIENT_SECRET: process.env.GOOGLE_CLIENT_SECRET || '',
  GITHUB_CLIENT_ID:     process.env.GITHUB_CLIENT_ID || '',
  GITHUB_CLIENT_SECRET: process.env.GITHUB_CLIENT_SECRET || '',

  // Email (Resend)
  RESEND_API_KEY: process.env.RESEND_API_KEY || '',
  EMAIL_FROM:     process.env.EMAIL_FROM || 'Aurelance <onboarding@resend.dev>',
  SUPPORT_INBOX:  process.env.SUPPORT_INBOX || 'aurelance454@gmail.com',

  // AI (Anthropic)
  ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY || '',
  ANTHROPIC_MODEL:   process.env.ANTHROPIC_MODEL || 'claude-haiku-5-5',
  AI_DAILY_LIMIT_FREE:    int(process.env.AI_DAILY_LIMIT_FREE, 15),
  AI_DAILY_LIMIT_PREMIUM: int(process.env.AI_DAILY_LIMIT_PREMIUM, 250),

  // Payments (Safepay)
  SAFEPAY_ENV:            process.env.SAFEPAY_ENV || 'sandbox', // sandbox | production
  SAFEPAY_API_KEY:        process.env.SAFEPAY_API_KEY || '',
  SAFEPAY_SECRET_KEY:     process.env.SAFEPAY_SECRET_KEY || '',     // "v1 secret" — signs redirect callbacks
  SAFEPAY_WEBHOOK_SECRET: process.env.SAFEPAY_WEBHOOK_SECRET || '', // signs webhooks
  BILLING_CURRENCY:       (process.env.BILLING_CURRENCY || 'PKR').toUpperCase(), // PKR | USD
  FX_USD_PKR_FALLBACK:    parseFloat(process.env.FX_USD_PKR_FALLBACK) || 280,

  // AES key for identity documents (64 hex chars)
  VERIFICATION_KEY: process.env.VERIFICATION_KEY || '',

  // Vercel Cron sends `Authorization: Bearer $CRON_SECRET`
  CRON_SECRET: process.env.CRON_SECRET || '',

  // Admin — comma-separated emails allowed to call /api/admin/*
  ADMIN_EMAILS: list(process.env.ADMIN_EMAILS).map((e) => e.toLowerCase()),

  LOG_REQUESTS: bool(process.env.LOG_REQUESTS, !isProd),
};

env.features = {
  google:   Boolean(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET),
  github:   Boolean(env.GITHUB_CLIENT_ID && env.GITHUB_CLIENT_SECRET),
  email:    Boolean(env.RESEND_API_KEY),
  ai:       Boolean(env.ANTHROPIC_API_KEY),
  payments: Boolean(env.SAFEPAY_API_KEY && env.SAFEPAY_SECRET_KEY),
  identity: /^[0-9a-f]{64}$/i.test(env.VERIFICATION_KEY),
};

// Hard requirements — fail loudly and early instead of half-working.
const missing = [];
if (!env.MONGO_URI)  missing.push('MONGO_URI');
if (!env.JWT_SECRET) missing.push('JWT_SECRET');
if (missing.length && !env.isTest) {
  // eslint-disable-next-line no-console
  console.error(`[env] Missing required environment variables: ${missing.join(', ')}`);
}
if (env.isProd && env.JWT_SECRET && env.JWT_SECRET.length < 32) {
  // eslint-disable-next-line no-console
  console.warn('[env] JWT_SECRET is shorter than 32 characters — use a long random value in production.');
}
env.missing = missing;

module.exports = env;
