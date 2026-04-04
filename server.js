// server.js — Freelancer Assistant API entry point
require('dotenv').config();

// ── Debug: confirm .env is loading ────────────────
console.log('🔍 ENV CHECK:');
console.log('   MONGO_URI:', process.env.MONGO_URI ? '✅ found' : '❌ undefined');
console.log('   MONGODB_URI:', process.env.MONGODB_URI ? '✅ found' : '❌ undefined');
console.log('   JWT_SECRET:', process.env.JWT_SECRET ? '✅ found' : '❌ undefined');

const express     = require('express');
const cors        = require('cors');
const helmet      = require('helmet');
const morgan      = require('morgan');
const rateLimit   = require('express-rate-limit');
const connectDB   = require('./config/db');
const errorHandler= require('./middleware/errorHandler');

const app = express();

// ── Connect to MongoDB ─────────────────────────────
connectDB();

// ── Security middleware ────────────────────────────
app.use(helmet());

app.use(cors({
  origin: process.env.CLIENT_URL || 'http://localhost:3000',
  credentials: true,
  methods: ['GET','POST','PUT','PATCH','DELETE','OPTIONS'],
  allowedHeaders: ['Content-Type','Authorization'],
}));

// ── Rate limiting ──────────────────────────────────
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 200,
  message: { error: 'Too many requests, please try again later.' },
});
app.use('/api', limiter);

// ── Auth limiter ───────────────────────────────────
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  message: { error: 'Too many auth attempts, please try again later.' },
});

// ── Body parsing ───────────────────────────────────
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

// ── Logging ────────────────────────────────────────
if (process.env.NODE_ENV === 'development') app.use(morgan('dev'));

// ── Health check ───────────────────────────────────
app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    env: process.env.NODE_ENV,
    time: new Date().toISOString()
  });
});

// ── Routes ─────────────────────────────────────────
app.use('/api/auth',        authLimiter, require('./routes/auth'));
app.use('/api/clients',     require('./routes/clients'));
app.use('/api/connections', require('./routes/connections'));
app.use('/api/invoices',    require('./routes/invoices'));
app.use('/api/tasks',       require('./routes/tasks'));
app.use('/api/notes',       require('./routes/notes'));
app.use('/api/earnings',    require('./routes/earnings'));
app.use('/api/contracts',   require('./routes/contracts'));
app.use('/api/proposals',   require('./routes/proposals'));
app.use('/api/dashboard',   require('./routes/dashboard'));
app.use('/api/activity',    require('./routes/activity'));
app.use('/api/deadlines',   require('./routes/deadlines'));
app.use('/api/support',     require('./routes/support'));
app.use('/api/profile',     require('./routes/profile'));
app.use('/api/settings',    require('./routes/settings'));
app.use('/api/contact',     require('./routes/contact'));
app.use('/api/newsletter',  require('./routes/contact'));

// ── 404 handler ────────────────────────────────────
app.use((req, res) => {
  res.status(404).json({
    error: `Route ${req.method} ${req.path} not found`
  });
});

// ── Global error handler ───────────────────────────
app.use(errorHandler);

// ✅ IMPORTANT: DO NOT use app.listen() for Vercel

module.exports = app;