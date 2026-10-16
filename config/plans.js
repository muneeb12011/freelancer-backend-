// config/plans.js — the ONLY place plan prices and limits are defined.
// The frontend reads these through GET /api/billing/plans, so pricing can never drift between pages.

const PLANS = {
  free: {
    id: 'free',
    name: 'Free',
    tagline: 'Run your freelance business from one place.',
    prices: { month: 0, year: 0 },
    limits: { aiPerDay: 15, applicationsPerMonth: 15, openJobs: 3 },
    features: [
      'Unlimited clients, tasks and invoices',
      'Kanban board with time tracking',
      'Messages, connections and the jobs board',
      '15 job applications a month, 3 open job posts',
      'Atelier: rate calculator, time tracker, expenses, notes, brand kit, estimator, email templates',
      '15 AI requests a day',
    ],
  },
  premium: {
    id: 'premium',
    name: 'Premium',
    tagline: 'For freelancers who bill every month.',
    prices: { month: 19, year: 190 }, // USD
    limits: { aiPerDay: 250, applicationsPerMonth: Infinity, openJobs: 25 },
    features: [
      'Everything in Free',
      'Unlimited job applications, up to 25 open job posts',
      'Earnings analytics and tax summary',
      'Smart contracts and proposal builder',
      'Client insights and business health score',
      'AI profile review',
      '250 AI requests a day',
    ],
  },
};

const INTERVAL_DAYS = { month: 30, year: 365 };

// Features that require Premium — used by both API middleware and the frontend lock chips.
const PREMIUM_FEATURES = [
  'contracts', 'proposals', 'analytics', 'tax',
  'ai:health-score', 'ai:client-insight', 'ai:profile-review',
];

module.exports = { PLANS, INTERVAL_DAYS, PREMIUM_FEATURES };
