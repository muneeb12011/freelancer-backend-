# Aurelance API

Node 20+ · Express 4 · MongoDB (Mongoose 8). Deploys to Vercel (`vercel.json`) or any Node host (`npm start`).

## Run locally
```bash
npm install
cp .env.example .env      # fill MONGO_URI + JWT_SECRET at minimum
npm run dev
```
Optional features switch on when their keys exist — check `GET /api/health → features`.

| Feature | Env vars |
|---|---|
| Google / GitHub sign-in | `GOOGLE_CLIENT_ID/SECRET`, `GITHUB_CLIENT_ID/SECRET` (callback: `$SERVER_URL/api/auth/<provider>/callback`) |
| Email (reset, 2FA, receipts, tickets) | `RESEND_API_KEY`, `EMAIL_FROM` (verified domain) |
| AI features | `ANTHROPIC_API_KEY`, `ANTHROPIC_MODEL` |
| Premium payments | `SAFEPAY_API_KEY`, `SAFEPAY_SECRET_KEY`, `SAFEPAY_WEBHOOK_SECRET`, `SAFEPAY_ENV` |
| Daily jobs (reminders, digest) | `CRON_SECRET` — Vercel Cron calls `GET /api/cron/daily` |
| ID verification | `VERIFICATION_KEY` (64 hex chars, AES-256-GCM) + `ADMIN_EMAILS` for reviewers (`/admin` in the app) |

## Safepay setup
1. Safepay dashboard → API keys → copy the **public key** (`SAFEPAY_API_KEY`) and **secret key** (`SAFEPAY_SECRET_KEY`).
2. Webhooks → endpoint `https://<api>/api/billing/safepay/webhook`, copy the webhook secret (`SAFEPAY_WEBHOOK_SECRET`).
3. Test with `SAFEPAY_ENV=sandbox`, then switch to `production`.
Activation happens on the signed redirect **or** the signed webhook, idempotently per tracker.

## Structure
```
app.js              Express app (security, CORS, routes)
server.js           entry (Vercel export / local listen + graceful shutdown)
config/             env validation, db (serverless-cached), passport, plans (single price source)
middleware/         auth (JWT + revocable sessions, premium/admin gates), rate limits, errors, request ids
services/           billing, payments/safepay, email (Resend), ai, fx, account export/delete, tickets
routes/             one file per resource
test/smoke.test.js  end-to-end API test
```

## Social features
- **Messages** (`/api/messages`): one thread per pair of users, unread counts, read receipts, attachments ≤ 2 MB (stored in `attachments`; move to object storage when volume grows), block/report, email notification throttled to once per 30 min per thread.
- **Jobs** (`/api/jobs`): post/browse/save/apply/withdraw, poster shortlists/rejects/hires. Hiring opens a thread and adds the poster as a client in the freelancer's CRM. Plan limits in `config/plans.js`.
- **Verification** (`/api/verification`, `/api/admin/verifications`): email, linked OAuth, and encrypted ID review; images are deleted at decision time.

## Security notes
- `plan` can only be changed by the billing service (or `/api/admin` for `ADMIN_EMAILS`).
- Every update strips `user/_id/__v/timestamps` and server-computed fields; regex search input is escaped; `$` operators are stripped from input.
- JWTs point at a server-side session: devices can be signed out; password reset invalidates all tokens.
- Reset/verify/email-change tokens are stored hashed; OAuth hands the browser a one-time code instead of a JWT in the URL.

## Tests
```bash
MONGO_URI=mongodb://127.0.0.1:27017/aurelance_test npm test
```
Use a throwaway database — the suite drops it.

## Production checklist
- `NODE_ENV=production`, long random `JWT_SECRET`, `SERVER_URL`, `CLIENT_URL`
- `npm run sync-indexes` once after deploying (autoIndex is off in production)
- Rate limits use in-memory storage per instance; add a Redis store in `middleware/rateLimits.js` if you scale out.
