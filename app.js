// app.js — Express application (no listen). Imported by server.js and by tests.
const express     = require('express');
const cors        = require('cors');
const helmet      = require('helmet');
const compression = require('compression');
const mongoSanitize = require('express-mongo-sanitize');

const env           = require('./config/env');
const passport      = require('./config/passport');
const { dbState }   = require('./config/db');
const ensureDb      = require('./middleware/ensureDb');
const requestContext = require('./middleware/requestContext');
const limits        = require('./middleware/rateLimits');
const { errorHandler, notFoundHandler } = require('./middleware/errorHandler');

const app = express();

app.set('trust proxy', 1); // Vercel / Koyeb / any reverse proxy → correct req.ip for rate limits
app.disable('x-powered-by');

app.use(requestContext);
app.use(helmet({ crossOriginResourcePolicy: { policy: 'cross-origin' } }));
app.use(compression());

// ── CORS ────────────────────────────────────────────────────────────────
// Exact-match allowlist. Disallowed origins simply get no CORS headers (the browser blocks them);
// we never throw, so server-to-server calls (webhooks, health checks) are unaffected.
const vercelPreview = new RegExp(`^https://${env.VERCEL_PROJECT_SLUG}-[a-z0-9-]+\\.vercel\\.app$`);
const isAllowedOrigin = (origin) => !origin
  || env.CORS_ORIGINS.includes(origin)
  || (env.CORS_ALLOW_VERCEL_PREVIEWS && vercelPreview.test(origin))
  || (!env.isProd && /^http:\/\/(localhost|127\.0\.0\.1):\d+$/.test(origin));

app.use(cors({
  origin: (origin, cb) => cb(null, isAllowedOrigin(origin)),
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Request-Id'],
  exposedHeaders: ['X-Request-Id', 'RateLimit', 'RateLimit-Policy', 'Retry-After'],
  maxAge: 86400,
}));

// ── Body parsing + injection hardening ──────────────────────────────────
app.use(express.json({ limit: '4mb' }));            // 4mb covers a base64 profile photo
app.use(express.urlencoded({ extended: false, limit: '100kb' })); // Safepay return posts a form
app.use(mongoSanitize({ replaceWith: '_' }));       // strips $operators from body/query/params
app.use(passport.initialize());

// ── Health (no DB required, used by uptime monitors) ────────────────────
app.get(['/', '/api', '/api/health'], async (req, res) => {
  // search: 'ranked' once the text index exists (npm run sync-indexes), 'basic' until then.
  let search = 'unknown';
  if (dbState() === 'connected') {
    try { search = (await require('./services/jobSearch').textAvailable()) ? 'ranked' : 'basic'; } catch { /* keep unknown */ }
  }
  res.json({
    status: 'ok',
    service: 'aurelance-api',
    env: env.NODE_ENV,
    db: dbState(),
    features: env.features,
    search,
    time: new Date().toISOString(),
  });
});

// ── API routes ──────────────────────────────────────────────────────────
app.use('/api', limits.api, ensureDb);

app.use('/api/auth',        require('./routes/auth'));
app.use('/api/billing',     require('./routes/billing'));
app.use('/api/ai',          require('./routes/ai'));
app.use('/api/connections', require('./routes/connections'));
app.use('/api/support',     require('./routes/support'));
app.use('/api/profile',     require('./routes/profile'));
app.use('/api/settings',    require('./routes/settings'));
app.use('/api/contact',     require('./routes/contact'));
app.use('/api/newsletter',  require('./routes/contact'));
app.use('/api/messages',    require('./routes/messages'));
app.use('/api/jobs',        require('./routes/jobs'));
app.use('/api/verification',require('./routes/verification'));
app.use('/api/admin',       require('./routes/admin'));
app.use('/api/cron',        require('./routes/cron'));
app.use('/api/home',        require('./routes/home'));
app.use('/api/engagements', require('./routes/engagements'));
app.use('/api/squads',      require('./routes/squads'));
app.use('/api/payouts',     require('./routes/payouts'));
app.use('/api/talent',      require('./routes/talent'));
app.use('/api/reports',     require('./routes/reports'));
app.use('/api/notifications', require('./routes/notifications'));
app.use('/api/disputes',    require('./routes/disputes'));
app.use('/api/public',      require('./routes/public'));
app.use('/api/realtime',    require('./routes/realtime'));

app.use(notFoundHandler);
app.use(errorHandler);

module.exports = app;
