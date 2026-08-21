# Chat widget backend (Cloudflare Worker)

Proxies the chat widget's two calls to agenthub.smartschema.io, holding the
real API key server-side. The browser talks to this Worker; this Worker
talks to agenthub with the key attached; the key never ships to a visitor's
browser again.

## Step 1 — rotate the exposed key first, before anything else here

`sk-aJPUyPB7KeBxxA0DW7pv1AQnaHQBfb0IqnwFj0e6RyY` has been sitting in plain
text in the site's shipped JavaScript. Anyone who opened dev tools or viewed
source has had it, for as long as it's been live — assume it's already been
seen by more than just real visitors. Everything below only closes the door
going forward; it does **nothing** about copies of the key already taken.

Wherever agenthub.smartschema.io manages API keys (its own dashboard/CLI —
outside this repo), do both of these:

1. **Generate a new key.** Don't reuse the old one anywhere.
2. **Revoke the old key** (`sk-aJPUyPB7...`) so it stops working immediately,
   regardless of who still has a copy of it.

Use the **new** key below — never the old one.

## One-time setup

```bash
cd worker-chat
npm install -D wrangler
npx wrangler login          # skip if already logged in from the contact-form Worker
```

## Give it the new key

```bash
npx wrangler secret put AGENTHUB_API_KEY
```

Paste the **new** key from Step 1 at the prompt — never written to a file,
never in this repo.

## Create the rate-limit store

Separate from the contact form's KV namespace, so the two Workers' limits
never interact:

```bash
npx wrangler kv namespace create crestward_chat_ratelimit
```

Paste the printed `id` into `wrangler.toml` in place of `REPLACE-ME`:

```toml
[[kv_namespaces]]
binding = "RATE_LIMIT_KV"
id = "REPLACE-ME"   # <- paste the printed id here
```

Not a secret — safe to commit.

## Try it locally before deploying

```bash
npm run dev
```

In another terminal, create a session and send a message through it:

```bash
SESSION=$(curl -s -X POST http://localhost:8787/sessions \
  -H "Content-Type: application/json" -H "Origin: https://crestwardlabs.com" \
  -d '{"title":"test"}' | python3 -c "import sys,json;print(json.load(sys.stdin)['id'])")

curl -N -X POST "http://localhost:8787/sessions/$SESSION/stream" \
  -H "Content-Type: application/json" -H "Origin: https://crestwardlabs.com" \
  -d '{"message":"hello"}'
```

The second command should stream `data: {...}` lines back token by token
(the `-N` disables curl's output buffering so you actually see it arrive
incrementally, the way the chat widget's typing effect depends on).

Send more than 40 messages in the same 15 minutes and you should start
getting `{"error":"too many requests"}` — that's the rate limit working.

## Deploy it

```bash
npm run deploy
```

Prints a URL like `https://crestward-chat.<your-subdomain>.workers.dev`.

## Wire it into the site

Open `design/app.src.js`, find the line near the top:

```js
var CHAT_ENDPOINT = 'https://REPLACE-ME.workers.dev';
```

Paste in the real URL, then from the repo root:

```bash
node tools/bake.mjs
```

Until this step, the widget shows "Chat is temporarily unavailable" the
moment someone tries to send a message, rather than calling a placeholder
URL or — worse — falling back to the old hardcoded key. There is no fallback
to the old direct-to-agenthub path; that key is gone for good once rotated.

## If something goes wrong after deploying

```bash
npx wrangler tail
```

## Changing the key later

```bash
npx wrangler secret put AGENTHUB_API_KEY
```

No redeploy needed — secrets apply immediately.
