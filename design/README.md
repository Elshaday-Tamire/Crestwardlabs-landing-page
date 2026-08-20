# How this site is built

`index.html` is **generated**. Do not edit it by hand — your changes will be
overwritten the next time anyone re-bakes.

```
design/landing-v2.dc.html   the Claude Design export      ─┐
design/head.html            SEO / analytics / consent      │   node tools/bake.mjs
design/jsonld.html          structured data                ├──────────────────────▶  index.html
design/base.css             trimmed design-system base     │                         assets/app.js
design/overrides.css        deliberate deviations          │
design/app.src.js           page behaviour                ─┘
```

## Why it is baked

The design canvas ships an `<x-dc>` template that `support.js` renders in the
browser after pulling React 18 + ReactDOM UMD from `unpkg.com`. That is roughly
330KB of blocking third-party JavaScript standing between the visitor and the
first pixel. Baking does that render once, at build time.

Measured on a throttled mid-tier mobile profile (4× CPU, ~1.6 Mbps):

|                  | before | after |
| ---------------- | -----: | ----: |
| FCP / LCP        | 2488ms | 844ms |
| load             | 4189ms | 1795ms |
| requests         |     12 |     4 |
| transferred      |  534KB | 196KB |
| third-party hosts|      3 |     0 |

## Pulling a new design revision

The verification tools need Playwright resolvable from the repo root:
`npm i -D playwright && npx playwright install chromium`. Nothing else in this
repo has a build dependency — the shipped site is plain static files.

1. Export the updated `.dc.html` from the Claude Design project
   (`90c93d60-f7da-43ab-9d1d-3fb254ac86be`) over `design/landing-v2.dc.html`,
   and refresh `design/reference/` with the matching `support.js` / `_ds/` files.
2. `node tools/bake.mjs`
3. `node tools/shot.mjs design/reference ref && node tools/shot.mjs . baked`
4. `node tools/diff.mjs shots ref baked` — must print `IDENTICAL`.
5. `node tools/qa.mjs .` — must print `PASS` with no failures.

The diff runs at 390 / 768 / 1024 / 1280 — the design canvas's own width is
1280, and that is the widest viewport where the shipped page is unscaled. Above
it the page scales on purpose (below), so a pixel diff there would be comparing
two different things; `tools/qa.mjs` asserts the scaling behaviour by
measurement instead. The harness serves Archivo locally rather than letting the
reference fetch it from Google, because when that request loses the race the
reference silently comes out 4px shorter.

The bake **fails loudly** rather than shipping something half-translated: any
`<sc-*>` element, `{{ }}` binding, `ref=`, event handler or `style-hover`
attribute it does not recognise, and any duplicate `id`, aborts the build. If a
new design revision introduces a construct, add it to the relevant map in
`tools/bake.mjs` — don't work around it in the output.

## Wide-screen scaling

The design is a fixed 1280px canvas — two containers cap at `max-width: 1280px`
and nearly every `clamp()` has topped out by ~1400px of viewport. Left alone,
the site sits in the middle 67% of a 1920px display at design size, and half of
a 2560px one.

`design/overrides.css` scales the whole canvas rather than widening it, so line
lengths, grid ratios and rhythm stay exactly as designed:

```css
:root { --cw-canvas: 1440px; }                              /* the dial */
:root { --cw-zoom: clamp(1, calc(100vw / var(--cw-canvas)), 2); }
:root { zoom: var(--cw-zoom); }
```

**`--cw-canvas` is the one number to change.** Lower it to make the site bigger,
raise it to make it smaller. It is the reference width the canvas is scaled
against: at 1440px the 1280px frame covers ~89% of the viewport, leaving a
column of air either side instead of running edge to edge.

| viewport | scale | frame covers |
| -------: | ----: | -----------: |
| ≤1280    | 1.00× |         100% |
| 1600     | 1.11× |          89% |
| 1920     | 1.33× |          89% |
| 2560     | 1.78× |          89% |
| 3440     | 2.00× |    74% (cap) |

Floored at 1 so narrow viewports are never scaled down, capped at 2 so an
ultrawide gets a large canvas rather than an absurd one. Stepped media queries
stand behind the `clamp()` for engines that cannot divide a length by a length
in `calc()`. `tools/qa.mjs` asserts every row of that table.

Two things do not come along for free under `zoom`, and both are handled:

- **Viewport units** are still resolved against the real, unzoomed viewport, so
  anything in `vh` has to be divided by the same factor. The hero is the only
  one that binds.
- **Canvas fields** measure themselves to decide how many lines to draw.
  `getBoundingClientRect()` reports the zoomed box while `clientWidth` stays in
  layout px, so `assets/app.js` draws in layout space (keeping the designed
  density) and takes its backing-store scale from the ratio between the two
  (keeping it sharp).

Also worth knowing: in Chromium a `zoom` declaration is never a true no-op —
even `zoom: normal` changes how a form control resolves `line-height: normal`.
That is why `tools/shot.mjs` only injects its zoom-neutralising style into pages
that actually declare the scale.

Because the scale is viewport-proportional, it partly counteracts browser zoom
in the 100–115% range (zooming in shrinks the CSS viewport, which lowers the
factor). Beyond that it tracks normally, and it never works against zooming out.

## What lives where

- **`design/head.html`** — the entire SEO surface: title, description, keywords,
  canonical, Open Graph, Twitter card, `llms.txt` hint, icons, font preload, and
  the consent-gated GA4 loader. It is injected on every bake, so **a redesign
  can never quietly drop it**. This is the file to edit for meta changes.
- **`design/jsonld.html`** — the `FAQPage` and `ProfessionalService` blocks,
  carried over byte-for-byte from the previous site.
- **`design/overrides.css`** — every intentional difference from the canvas, each
  with the reason written next to it. Read this before assuming the bake is
  wrong about something.
- **`design/reference/`** — the original runtime render, kept so the pixel-parity
  check can be reproduced. Not part of the shipped page.
- **`assets/page.css`** — shared styling for `privacy.html` and `404.html`, which
  are hand-written rather than baked.

## Known issue, not fixed here

The chat widget authenticates to `agenthub.smartschema.io` with an API key
embedded in client-side JavaScript (`design/app.src.js`). It is public by
construction — it was already public on the live site and this work carries it
forward unchanged. It should be rotated and moved behind a proxy that holds the
key server-side.
