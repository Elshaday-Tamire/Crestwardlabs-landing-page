/**
 * Crestward Labs chat-widget proxy Worker.
 *
 * The chat widget used to call agenthub.smartschema.io directly from the
 * browser with its API key hardcoded in the shipped JS — anyone who viewed
 * source had full use of the AI backend at Crestward Labs' expense. This
 * Worker sits in between: the browser talks to it, it holds the real key as
 * a server-side secret, and it proxies both calls (including the streamed
 * response) through to agenthub.
 *
 * Local dev: `npm install && wrangler dev` (from worker-chat/).
 * Deploy:    `wrangler deploy`.
 *
 * See README.md — rotating the already-exposed key is step 1, before any of
 * this even matters.
 */

const AGENTHUB_BASE = 'https://agenthub.smartschema.io/api';

/* Same reasoning as worker/src/index.js: an explicit allow-list, not "*".
   localhost and 127.0.0.1 are different origins to a browser even though
   they're the same machine — both are here for local testing only, matching
   `python3 -m http.server 8000` from the repo root. Remove both once you're
   done testing locally, same as we did for worker/. */
const ALLOWED_ORIGINS = ['https://crestwardlabs.com', 'http://localhost:8000', 'http://127.0.0.1:8000'];

/* This key was public for a while (view-source), so treat it as already
   compromised regardless of anything below — see README.md. Once rotated,
   these limits are the backstop against a script hammering the new key
   through this proxy. Unlike the contact form there's no honeypot/timing
   signal to lean on here (a chat box has no hidden fields to trip); the
   rate limit is the real defense against volume abuse. Generous enough that
   a real back-and-forth conversation never hits it. */
const SESSION_LIMIT_MAX = 10;
const MESSAGE_LIMIT_MAX = 40;
const RATE_LIMIT_WINDOW_SECONDS = 15 * 60;

const MESSAGE_MAX_LENGTH = 4000;
const SAFE_ID_RE = /^[A-Za-z0-9_-]+$/; // session id is interpolated into the upstream URL — keep it inert

async function checkAndBump(env, kind, ip, max) {
  if (!env.RATE_LIMIT_KV) return false; // KV not bound yet — see README setup step
  const key = kind + ':' + ip;
  const count = Number(await env.RATE_LIMIT_KV.get(key)) || 0;
  if (count >= max) return true;
  await env.RATE_LIMIT_KV.put(key, String(count + 1), { expirationTtl: RATE_LIMIT_WINDOW_SECONDS });
  return false;
}

function corsHeaders(origin) {
  const headers = {
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    Vary: 'Origin',
  };
  if (ALLOWED_ORIGINS.includes(origin)) headers['Access-Control-Allow-Origin'] = origin;
  return headers;
}

function json(body, status, origin) {
  return new Response(JSON.stringify(body), {
    status: status || 200,
    headers: { 'Content-Type': 'application/json', ...corsHeaders(origin) },
  });
}

export default {
  async fetch(request, env) {
    const origin = request.headers.get('Origin');
    const url = new URL(request.url);

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders(origin) });
    }

    if (request.method !== 'POST') {
      return json({ error: 'method not allowed' }, 405, origin);
    }

    // Real protection lives in the rate limit below, not this header — see
    // worker/src/index.js's note on what an Origin check does and doesn't stop.
    if (!ALLOWED_ORIGINS.includes(origin)) {
      return json({ error: 'forbidden' }, 403, origin);
    }

    const ip = request.headers.get('CF-Connecting-IP') || 'unknown';

    // POST /sessions — create a chat session
    if (url.pathname === '/sessions') {
      if (await checkAndBump(env, 'sess', ip, SESSION_LIMIT_MAX)) {
        return json({ error: 'too many requests' }, 429, origin);
      }

      let body;
      try {
        body = await request.json();
      } catch {
        body = {};
      }
      const title = typeof body.title === 'string' && body.title.trim() ? body.title.trim().slice(0, 200) : 'Website chat';

      let upstream;
      try {
        upstream = await fetch(AGENTHUB_BASE + '/public/sessions', {
          method: 'POST',
          headers: { Authorization: 'Bearer ' + env.AGENTHUB_API_KEY, 'Content-Type': 'application/json' },
          body: JSON.stringify({ title }),
        });
      } catch (err) {
        console.error('session create failed:', err);
        return json({ error: 'upstream unreachable' }, 502, origin);
      }

      let data;
      try {
        data = await upstream.json();
      } catch {
        return json({ error: 'bad upstream response' }, 502, origin);
      }
      return json(data, upstream.status, origin);
    }

    // POST /sessions/<id>/stream — send a message, stream the reply back
    const streamMatch = /^\/sessions\/([^/]+)\/stream$/.exec(url.pathname);
    if (streamMatch) {
      const id = streamMatch[1];
      if (!SAFE_ID_RE.test(id)) {
        return json({ error: 'invalid session id' }, 400, origin);
      }
      if (await checkAndBump(env, 'msg', ip, MESSAGE_LIMIT_MAX)) {
        return json({ error: 'too many requests' }, 429, origin);
      }

      let body;
      try {
        body = await request.json();
      } catch {
        return json({ error: 'invalid json' }, 400, origin);
      }
      const message = typeof body.message === 'string' ? body.message.trim() : '';
      if (!message) return json({ error: 'missing message' }, 400, origin);
      if (message.length > MESSAGE_MAX_LENGTH) return json({ error: 'message too long' }, 400, origin);

      let upstream;
      try {
        upstream = await fetch(AGENTHUB_BASE + '/public/sessions/' + id + '/stream', {
          method: 'POST',
          headers: { Authorization: 'Bearer ' + env.AGENTHUB_API_KEY, 'Content-Type': 'application/json' },
          body: JSON.stringify({ message, filter_vars: body.filter_vars || {} }),
        });
      } catch (err) {
        console.error('stream request failed:', err);
        return json({ error: 'upstream unreachable' }, 502, origin);
      }

      // Pass the stream straight through, unbuffered — this is what keeps
      // the token-by-token typing effect working through the proxy.
      return new Response(upstream.body, {
        status: upstream.status,
        headers: {
          ...corsHeaders(origin),
          'Content-Type': upstream.headers.get('Content-Type') || 'text/plain; charset=utf-8',
        },
      });
    }

    return json({ error: 'not found' }, 404, origin);
  },
};
