/**
 * Crestward Labs contact-form Worker.
 *
 * Receives the contact form's POST from crestwardlabs.com, validates it,
 * drops obvious bots silently, and sends the mail over SMTP using credentials
 * that live only in this Worker's encrypted secrets (see README.md) — never
 * in this repo, never in the browser.
 *
 * Local dev: `npm install && wrangler dev` (from worker/).
 * Deploy:    `wrangler deploy`.
 */
import { WorkerMailer } from "worker-mailer";

/* An explicit allow-list, not a wildcard. This endpoint sends real email
   through a real SMTP account — "*" means literally any website anywhere
   could embed a fetch() to this URL and send mail through it, not just
   crestwardlabs.com. Add a local-dev origin back here temporarily if you
   ever need to test locally again (`python3 -m http.server 8000` from the
   repo root -> http://localhost:8000, matching whatever port you serve on),
   then remove it again afterward — same as this one just was. */
/* localhost and 127.0.0.1 are different origins to a browser even though
   they're the same machine — both are here since `python3 -m http.server`
   answers to either depending on what you type in the address bar. Remove
   both once done testing locally, same as before. */
const ALLOWED_ORIGINS = [
  "https://crestwardlabs.com",
  "https://flowstudio-ai.com",
  "http://localhost:8000",
  "http://127.0.0.1:8000",
];

const LIMITS = { name: 100, email: 200, topic: 100, message: 5000 };
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/* A visitor reads the form for at least a couple of seconds; a bot that
   fills and submits a freshly-mounted form doesn't. Below this, and any
   honeypot fill, both look identical to the sender: a normal 200 with no
   mail actually sent — a bot that gets an error learns to adapt, one that
   gets a fake success doesn't. */
const MIN_FILL_MS = 2000;

/* Per-IP cap. Generous enough that a real visitor retrying a typo never
   notices it; tight enough that a script hammering this URL directly runs
   out of budget fast. This is the real backstop against volume abuse — see
   the note below on what the Origin/honeypot/timing checks do and don't
   cover. */
const RATE_LIMIT_MAX = 5;
const RATE_LIMIT_WINDOW_SECONDS = 15 * 60;

async function isRateLimited(env, ip) {
  if (!env.RATE_LIMIT_KV) return false; // KV not bound yet — see README setup step
  const key = "rl:" + ip;
  const count = Number(await env.RATE_LIMIT_KV.get(key)) || 0;
  if (count >= RATE_LIMIT_MAX) return true;
  // Fixed window: TTL restarts from this write, not from the IP's first hit
  // in the window. Simple, and entirely adequate against a flood — a script
  // gaming the reset by pacing itself under 5/15min isn't "abuse" anymore.
  await env.RATE_LIMIT_KV.put(key, String(count + 1), {
    expirationTtl: RATE_LIMIT_WINDOW_SECONDS,
  });
  return false;
}

// Access-Control-Allow-Origin can only ever echo back ONE origin per
// response — there's no way to say "any of these three" in the header
// itself — so the allow-list check happens here, and this reflects back
// whichever one actually matched. `Vary: Origin` tells any cache in front of
// this (there isn't one today, but if that ever changes) that the response
// differs by Origin and must not be served to a different one.
function corsHeaders(origin) {
  const headers = {
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    Vary: "Origin",
  };
  if (ALLOWED_ORIGINS.includes(origin)) headers["Access-Control-Allow-Origin"] = origin;
  return headers;
}

function json(body, status, origin) {
  return new Response(JSON.stringify(body), {
    status: status || 200,
    headers: { "Content-Type": "application/json", ...corsHeaders(origin) },
  });
}

function validate(data) {
  const name = String(data.name || "").trim();
  const email = String(data.email || "").trim();
  const topic = String(data.topic || "").trim();
  const message = String(data.message || "").trim();

  // `name` is optional — FlowStudio's contact form only collects an email
  // and a use-case, unlike Crestward's form which always sends a name.
  if (!email || !message) return "missing required field";
  if (!EMAIL_RE.test(email)) return "invalid email";
  if (name.length > LIMITS.name) return "name too long";
  if (email.length > LIMITS.email) return "email too long";
  if (topic.length > LIMITS.topic) return "topic too long";
  if (message.length > LIMITS.message) return "message too long";
  return null;
}

export default {
  async fetch(request, env) {
    const origin = request.headers.get("Origin");

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders(origin) });
    }

    if (request.method !== "POST") {
      return json({ ok: false, error: "method not allowed" }, 405, origin);
    }

    // NOTE on what this does and doesn't stop: `Origin` is just a request
    // header — anything that isn't a browser (curl, a script that read this
    // Worker's URL straight out of the shipped JS) can set it to whatever it
    // wants and walk straight through. Same limit on the honeypot/timing
    // checks below: they only catch a bot that actually executes the page's
    // JS and fills the visible form. None of these three stop a single
    // deliberately-crafted fake submission. What they, plus the rate limit
    // below, DO stop is volume — a generic scanner, a script hammering this
    // URL, anything that isn't a one-off. For a low-traffic contact form
    // that's the actual threat model; a real per-request challenge
    // (Cloudflare Turnstile) is the upgrade if that ever stops being true.
    if (!ALLOWED_ORIGINS.includes(origin)) {
      return json({ ok: false, error: "forbidden" }, 403, origin);
    }

    const ip = request.headers.get("CF-Connecting-IP") || "unknown";
    if (await isRateLimited(env, ip)) {
      return json({ ok: false, error: "too many requests" }, 429, origin);
    }

    let data;
    try {
      data = await request.json();
    } catch {
      return json({ ok: false, error: "invalid json" }, 400, origin);
    }

    const problem = validate(data);
    if (problem) return json({ ok: false, error: problem }, 400, origin);

    const name = String(data.name || "").trim() || "(not provided)";
    const email = String(data.email).trim();
    const topic = String(data.topic || "General").trim();
    const message = String(data.message).trim();
    const honeypot = String(data.company || "").trim();
    const elapsedMs = Number(data.elapsedMs) || 0;
    // Which site this came in from — only changes the subject/from line so a
    // FlowStudio lead doesn't read as a generic Crestward inquiry in the inbox.
    const isFlowStudio = String(data.source || "").trim().toLowerCase() === "flowstudio";

    // Bot-shaped submission: respond exactly like a real success, send nothing.
    if (honeypot || elapsedMs < MIN_FILL_MS) {
      return json({ ok: true }, 200, origin);
    }

    const port = Number(env.SMTP_PORT) || 587;
    const secure = port === 465; // implicit TLS on 465; everything else negotiates STARTTLS

    try {
      const mailer = await WorkerMailer.connect({
        credentials: { username: env.SMTP_USER, password: env.SMTP_PASS },
        authType: env.SMTP_AUTH_TYPE || "login",
        host: env.SMTP_HOST,
        port,
        secure,
        startTls: !secure,
      });

      await mailer.send({
        // Most SMTP providers reject a From that isn't the authenticated
        // account, so the visitor's address goes in `reply` instead — hit
        // reply in your inbox and it goes straight to them.
        from: { name: isFlowStudio ? "FlowStudio website" : "Crestward Labs website", email: env.SMTP_USER },
        to: { email: env.MAIL_TO || env.SMTP_USER },
        reply: { name, email },
        subject: (isFlowStudio ? "[FlowStudio] " : "") + "Project inquiry: " + topic,
        text:
          "Name: " +
          name +
          "\nEmail: " +
          email +
          "\nTopic: " +
          topic +
          "\n\n" +
          message,
      });
    } catch (err) {
      console.error("contact form send failed:", err);
      return json({ ok: false, error: "send failed" }, 502, origin);
    }

    return json({ ok: true }, 200, origin);
  },
};
