// config/plans.js — the ONLY place plan prices and limits are defined.
// The frontend reads these through GET /api/billing/plans, so pricing can never drift between pages.

const PLANS = {
  free: {
    id: 'free',
    name: 'Free',
    tagline: 'Find work and hire with the full safety net.',
    prices: { month: 0, year: 0 },
    limits: { aiPerDay: 15, applicationsPerMonth: 15, openJobs: 3 },
    features: [
      '15 job applications a month — no paid bidding credits',
      '3 open job posts, including paid trials',
      'Signed milestone contracts with scope lock and change requests',
      'Client report cards, no-ghosting rule and scam shield',
      'Squads, verified payouts, ID verification',
      '15 AI drafts a day (job posts, applications, milestone plans)',
    ],
  },
  premium: {
    id: 'premium',
    name: 'Premium',
    tagline: 'For people who apply or hire every week.',
    prices: { month: 19, year: 190 }, // USD
    limits: { aiPerDay: 250, applicationsPerMonth: Infinity, openJobs: 25 },
    features: [
      'Everything in Free',
      'Unlimited job applications',
      'Up to 25 open job posts',
      'Priority review for ID and payout checks',
      'AI profile review',
      '250 AI drafts a day',
    ],
  },
};

const INTERVAL_DAYS = { month: 30, year: 365 };

// Features that require Premium — used by both API middleware and the frontend lock chips.
const PREMIUM_FEATURES = ['ai:profile-review'];

module.exports = { PLANS, INTERVAL_DAYS, PREMIUM_FEATURES };
