// config/passport.js — OAuth strategies. Each one is registered only if its keys exist,
// so a missing GitHub secret disables GitHub sign-in instead of crashing the whole API.
const crypto   = require('crypto');
const passport = require('passport');
const env      = require('./env');
const logger   = require('../utils/logger');
const User     = require('../models/User');

async function findOrCreate({ provider, providerId, email, name, avatar, emailTrusted }) {
  const idField = provider === 'google' ? 'googleId' : 'githubId';
  let user = await User.findOne({ [idField]: providerId });

  if (!user && email && emailTrusted) {
    user = await User.findOne({ email: email.toLowerCase() });
    if (user) {
      user[idField] = providerId;
      if (!user.avatar && avatar) user.avatar = avatar;
      user.emailVerified = true;
      await user.save();
    }
  }

  if (!user) {
    user = await User.create({
      name: (name || 'Freelancer').slice(0, 80),
      email: email || `${provider}_${providerId}@users.noreply.aurelance.app`,
      [idField]: providerId,
      authProvider: provider,
      avatar: avatar || '',
      emailVerified: Boolean(email && emailTrusted),
      password: crypto.randomBytes(32).toString('hex'), // unusable random password
    });
  }
  return user;
}

if (env.features.google) {
  const GoogleStrategy = require('passport-google-oauth20').Strategy;
  passport.use(new GoogleStrategy({
    clientID: env.GOOGLE_CLIENT_ID,
    clientSecret: env.GOOGLE_CLIENT_SECRET,
    callbackURL: `${env.SERVER_URL}/api/auth/google/callback`,
  }, async (accessToken, refreshToken, profile, done) => {
    try {
      const primary = profile.emails?.[0];
      const user = await findOrCreate({
        provider: 'google',
        providerId: profile.id,
        email: primary?.value,
        emailTrusted: primary?.verified !== false, // Google only returns verified emails by default
        name: profile.displayName,
        avatar: profile.photos?.[0]?.value,
      });
      done(null, user);
    } catch (err) { done(err); }
  }));
} else {
  logger.warn('Google OAuth disabled (GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET not set)');
}

if (env.features.github) {
  const GitHubStrategy = require('passport-github2').Strategy;
  passport.use(new GitHubStrategy({
    clientID: env.GITHUB_CLIENT_ID,
    clientSecret: env.GITHUB_CLIENT_SECRET,
    callbackURL: `${env.SERVER_URL}/api/auth/github/callback`,
    scope: ['user:email'],
  }, async (accessToken, refreshToken, profile, done) => {
    try {
      const primary = (profile.emails || []).find((e) => e.primary) || profile.emails?.[0];
      const user = await findOrCreate({
        provider: 'github',
        providerId: profile.id,
        email: primary?.value,
        emailTrusted: Boolean(primary?.value) && primary?.verified !== false,
        name: profile.displayName || profile.username,
        avatar: profile.photos?.[0]?.value,
      });
      done(null, user);
    } catch (err) { done(err); }
  }));
} else {
  logger.warn('GitHub OAuth disabled (GITHUB_CLIENT_ID / GITHUB_CLIENT_SECRET not set)');
}

module.exports = passport;
