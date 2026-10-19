// utils/background.js — keep the function alive for work that finishes after the response.
// On Vercel a function can be frozen as soon as the response is sent, so fire-and-forget work
// (emails, realtime pings) may never complete. Vercel exposes waitUntil() on the request
// context; this is the same lookup @vercel/functions does, without adding the dependency.
// Elsewhere (local, tests, a long-running server) it does nothing and the promise just runs.
const CONTEXT = Symbol.for('@vercel/request-context');

function keepAlive(promise) {
  try {
    const ctx = globalThis[CONTEXT]?.get?.();
    if (ctx?.waitUntil) ctx.waitUntil(Promise.resolve(promise).catch(() => {}));
  } catch { /* not on Vercel */ }
  return promise;
}

module.exports = { keepAlive };
