#!/usr/bin/env node
// scripts/smoke.js — check a deployed Aurelance end to end.
//
//   node scripts/smoke.js                          read-only checks against production
//   node scripts/smoke.js --api http://localhost:5050/api --web http://localhost:3000
//   node scripts/smoke.js --handle usman-tariq     also check a public profile link + its preview
//   node scripts/smoke.js --write --email you@gmail.com --password <a-strong-one>
//        also registers two throwaway accounts (you+smoke-a…@gmail.com, you+smoke-b…@gmail.com),
//        messages between them, searches, opens a ticket, then deletes both accounts.
//        Their support ticket stays, unlinked — close it from Admin → Tickets.
//
// Exit code 1 if anything failed, so it can run after each deploy.
/* eslint-disable no-console */
const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(`--${k}`); return i >= 0 ? args[i + 1] : d; };
const flag = (k) => args.includes(`--${k}`);
const API = (opt('api', 'https://freelancer-backend-khaki.vercel.app/api')).replace(/\/$/, '');
const WEB = (opt('web', 'https://freelancers-assistant.vercel.app')).replace(/\/$/, '');

let failed = 0;
const ok = (m) => console.log(`  ✓ ${m}`);
const bad = (m) => { failed += 1; console.log(`  ✗ ${m}`); };
const warn = (m) => console.log(`  ! ${m}`);
async function call(method, path, { token, body, base = API } = {}) {
  const r = await fetch(`${base}${path}`, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const text = await r.text();
  let json = null; try { json = JSON.parse(text); } catch { /* html */ }
  return { status: r.status, json, text, headers: r.headers };
}
const check = async (name, fn) => { try { const m = await fn(); if (m !== false) ok(m || name); } catch (e) { bad(`${name}: ${e.message}`); } };
const expect = (cond, msg) => { if (!cond) throw new Error(msg); };

(async () => {
  console.log(`API ${API}\nWeb ${WEB}\n`);
  console.log('Service');
  let health;
  await check('health', async () => {
    const r = await call('GET', '/health');
    expect(r.status === 200, `HTTP ${r.status}`);
    health = r.json;
    expect(health.db === 'connected', `database is ${health.db}`);
    return `API up, database connected (${health.env})`;
  });
  if (health) {
    const f = health.features || {};
    (f.email ? ok : bad)(f.email ? 'email sending is on' : 'email is OFF — set RESEND_API_KEY and EMAIL_FROM, or nobody gets verification or reset emails');
    (f.identity ? ok : warn)(f.identity ? 'ID/payout vault key set' : 'VERIFICATION_KEY not set — ID checks and payout methods are disabled');
    (f.realtime ? ok : warn)(f.realtime ? 'realtime (Pusher) on' : 'realtime off — the app polls (optional: set the PUSHER_* variables)');
    (health.search === 'ranked' ? ok : warn)(health.search === 'ranked' ? 'job search is ranked (text index built)' : `job search is ${health.search} — run: npm run sync-indexes`);
  }
  await check('help library', async () => { const r = await call('GET', '/support/articles'); expect(r.json?.articles?.length >= 10, 'too few articles'); return `${r.json.articles.length} help articles`; });
  await check('realtime config', async () => { const r = await call('GET', '/realtime/config'); expect(r.status === 200, `HTTP ${r.status}`); expect(!('secret' in (r.json || {})), 'secret exposed!'); return `realtime config served (${r.json.enabled ? 'on' : 'off'})`; });

  console.log('\nWebsite');
  await check('home page', async () => { const r = await call('GET', '/', { base: WEB }); expect(r.status === 200 && /<div id="root">/.test(r.text), `HTTP ${r.status}`); return 'site loads'; });
  await check('deep link', async () => { const r = await call('GET', '/jobs', { base: WEB }); expect(r.status === 200, `HTTP ${r.status} — SPA rewrite missing?`); return 'client-side routes resolve'; });
  const handle = opt('handle');
  if (handle) {
    await check('public profile', async () => {
      const r = await call('GET', `/u/${handle}`, { base: WEB });
      expect(r.status === 200, `HTTP ${r.status}`);
      const pub = await call('GET', `/public/u/${handle}`);
      expect(pub.status === 200, `the API doesn't know @${handle} (HTTP ${pub.status})`);
      const name = pub.json?.profile?.name || pub.json?.user?.name || '';
      const og = (r.text.match(/<meta property="og:title" content="([^"]*)"/) || [])[1] || '';
      expect(name && og.includes(name.split(' ')[0]), `preview title is “${og}” — the /u rewrite isn't reaching the API`);
      return `/u/${handle} previews as “${og}”`;
    });
  }

  if (flag('write')) {
    console.log('\nAccounts (throwaway)');
    const email = opt('email'); const password = opt('password');
    if (!email || !password) { bad('--write needs --email and --password'); process.exit(1); }
    const [user, domain] = email.split('@');
    const stamp = Date.now().toString(36);
    const people = {};
    for (const k of ['a', 'b']) {
      await check(`register ${k}`, async () => {
        const r = await call('POST', '/auth/register', { body: { name: `Smoke Test ${k.toUpperCase()}`, email: `${user}+smoke-${k}-${stamp}@${domain}`, password } });
        expect(r.status === 201, `${r.status} ${r.json?.error || ''}`);
        people[k] = r.json;
        return `registered ${r.json.user.email}`;
      });
    }
    if (people.a && people.b) {
      const A = people.a.token; const B = people.b.token;
      await check('profile', async () => { const r = await call('PATCH', '/profile', { token: A, body: { title: 'Smoke test', skills: ['Shopify'] } }); expect(r.status === 200, r.json?.error); return 'profile saves'; });
      await check('search', async () => { const r = await call('GET', '/jobs?q=shopify%20store', { token: A }); expect(r.status === 200, r.json?.error); return `job search answers (${r.json.total} results, ${r.json.ranked ? 'ranked' : 'basic matching'})`; });
      await check('messages', async () => {
        const c = await call('POST', '/messages/conversations', { token: A, body: { userId: people.b.user._id } });
        expect([200, 201].includes(c.status), c.json?.error);
        const m = await call('POST', `/messages/conversations/${c.json.conversation._id}/messages`, { token: A, body: { text: 'Smoke test message' } });
        expect([200, 201].includes(m.status), m.json?.error);
        const u = await call('GET', '/messages/unread', { token: B });
        expect(u.json?.total >= 1, 'recipient has no unread message');
        return 'message delivered and counted as unread';
      });
      await check('support', async () => {
        const t = await call('POST', '/support/tickets', { token: A, body: { topic: 'other', message: 'Automated smoke test after a deploy — safe to close.' } });
        expect(t.status === 201, t.json?.error);
        const ctx = await call('GET', '/support/context', { token: A });
        expect(ctx.status === 200, ctx.json?.error);
        return `ticket ${t.json.ticketId} created`;
      });
      for (const [k, p] of Object.entries(people)) {
        await check(`delete ${k}`, async () => { const r = await call('DELETE', '/auth/account', { token: p.token, body: { confirm: 'DELETE', password } }); expect(r.status === 200, r.json?.error); return `deleted test account ${k}`; });
      }
    }
  }

  console.log(failed ? `\n${failed} check${failed > 1 ? 's' : ''} failed.` : '\nAll checks passed.');
  process.exit(failed ? 1 : 0);
})();
