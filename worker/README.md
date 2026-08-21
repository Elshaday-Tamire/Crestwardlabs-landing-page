# Contact form backend (Cloudflare Worker)

Sends the contact form's mail over SMTP. Runs independently of the static
site on GitHub Pages — nothing about how crestwardlabs.com is currently
hosted changes. This gets its own free `*.workers.dev` URL.

Everything in this folder is safe to commit. The SMTP password is **never**
typed into a file — it goes straight into Cloudflare's encrypted secret store
via the commands below.

## One-time setup

```bash
cd worker
npm install worker-mailer
npm install -D wrangler
npx wrangler login          # opens a browser, creates a free account if needed
```

## Tell it your SMTP details

Run each of these — you'll be prompted to paste the value, so it never lands
in your shell history or any file:

```bash
npx wrangler secret put SMTP_HOST      # e.g. smtp.gmail.com
npx wrangler secret put SMTP_PORT      # 587 (STARTTLS) or 465 (implicit TLS) — 25 is blocked
npx wrangler secret put SMTP_USER      # the mailbox you're authenticating as
npx wrangler secret put SMTP_PASS      # its password (an app password if your provider requires one — see below)
npx wrangler secret put MAIL_TO        # where the inquiry lands — defaults to SMTP_USER if you skip this one
```

**If you're using Gmail**: with 2-factor auth on (recommended), your normal
password won't work over SMTP. Generate an **App Password** instead —
Google Account → Security → 2-Step Verification → App passwords — and use
that as `SMTP_PASS`.

## Create the rate-limit store

The Worker URL becomes public the moment it's in the site's JS (view-source
shows it to anyone) — the `Origin` check and the form's honeypot/timing
checks only filter out bots that either skip spoofing a header or actually
run the page's JS, not a script that reads the URL and posts to it directly.
This per-IP counter is the real backstop: it doesn't stop one crafted fake
submission, but it caps volume abuse at 5 requests per IP per 15 minutes.

```bash
npx wrangler kv namespace create crestward_contact_ratelimit
```

This prints an `id`. Open `wrangler.toml` and paste it in place of
`REPLACE-ME`:

```toml
[[kv_namespaces]]
binding = "RATE_LIMIT_KV"
id = "REPLACE-ME"   # <- paste the printed id here
```

Not a secret — a KV namespace id only names the store, it grants no access —
safe to commit.

## Try it locally before deploying

```bash
npm run dev
```

This runs the Worker on your machine (`http://localhost:8787` by default),
using the real secrets you just set. In another terminal:

```bash
curl -i http://localhost:8787 \
  -H "Content-Type: application/json" \
  -H "Origin: https://crestwardlabs.com" \
  -d '{"name":"Test","email":"you@example.com","topic":"Agentic AI systems","message":"hello","elapsedMs":5000}'
```

You should get `{"ok":true}` back and an email in `MAIL_TO`. Try it again
with `"elapsedMs":100` — that one should say `{"ok":true}` too, but **no**
email should arrive: that's the anti-spam check working correctly (a bot
that gets an error message learns to adapt; one that gets a fake success
doesn't).

Run the same curl command six times in a row and the sixth should come back
`{"ok":false,"error":"too many requests"}` with an HTTP 429 — that's the rate
limit. `wrangler dev` simulates KV locally by default, so this works without
touching the real store.

## Deploy it

```bash
npm run deploy
```

This prints a URL like `https://crestward-contact.<your-subdomain>.workers.dev`.

## Wire it into the site

Open `design/app.src.js`, find the line near the top:

```js
var CONTACT_ENDPOINT = 'https://REPLACE-ME.workers.dev';
```

Paste in the real URL from the deploy output, then from the repo root:

```bash
node tools/bake.mjs
```

That regenerates `index.html` / `assets/app.js` with the real endpoint baked
in. Commit the result. Until this step, the form quietly keeps behaving
exactly as it did before — it checks for the placeholder and falls back to
the old `mailto:` link, so there's no window where the site is half-wired.

## If something goes wrong after deploying

```bash
npx wrangler tail
```

streams live logs from the deployed Worker — run it, then submit the form,
and you'll see the request (and any SMTP error) as it happens.

## Changing the SMTP provider or password later

Same command, it overwrites the existing secret:

```bash
npx wrangler secret put SMTP_PASS
```

No redeploy of the site needed — only the Worker's secret changes.
