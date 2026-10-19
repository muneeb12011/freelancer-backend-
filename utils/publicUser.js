// utils/publicUser.js — one shape for "a person" everywhere (messages, jobs, network, applicants).
const PUBLIC_USER_FIELDS = 'name avatar title location hourlyRate availability skills emailVerified googleId githubId identity.status plan planExpiresAt createdAt lastLoginAt reputation payoutTypes handle';

function badgesOf(u) {
  const premium = u.plan === 'premium' && (!u.planExpiresAt || new Date(u.planExpiresAt) > new Date());
  return {
    email: Boolean(u.emailVerified),
    identity: u.identity?.status === 'approved',
    linked: Boolean(u.googleId || u.githubId),
    premium,
    payout: (u.payoutTypes || []).length > 0,
  };
}

function publicUser(u) {
  if (!u) return null;
  return {
    _id: u._id,
    name: u.name,
    photo: u.avatar || '',
    avatar: u.avatar || '',
    title: u.title || '',
    role: u.title || '',
    location: u.location || '',
    hourlyRate: u.hourlyRate || 0,
    availability: u.availability || '',
    skills: u.skills || [],
    badges: badgesOf(u),
    memberSince: u.createdAt,
    lastSeenAt: u.lastLoginAt,
    reputation: u.reputation || {},
    payoutTypes: u.payoutTypes || [],
    handle: u.handle || '',
  };
}

module.exports = { PUBLIC_USER_FIELDS, publicUser, badgesOf };
