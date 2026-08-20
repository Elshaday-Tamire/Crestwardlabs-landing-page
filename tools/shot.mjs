// Deterministic full-page screenshots for pixel-parity diffing.
// usage: node shot.mjs <rootDir> <label> [port]
import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { readFile, mkdir } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { extname, join, normalize } from 'node:path';

const [, , root, label, portArg] = process.argv;
const port = Number(portArg || 8791);
const OUT = new URL('../shots/', import.meta.url).pathname;
// Capped at 1280 on purpose: that is the design canvas's own width, and the
// widest viewport at which the shipped page is unscaled. Above it the page
// deliberately scales (design/overrides.css), so a pixel diff against the
// unscaled reference would be comparing two different things. The scaling is
// verified by measurement in tools/qa.mjs instead.
const VIEWPORTS = [[390, 844], [768, 1024], [1024, 900], [1280, 900]];

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
  '.png': 'image/png', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.txt': 'text/plain',
  '.xml': 'application/xml', '.json': 'application/json' };

const server = createServer(async (req, res) => {
  let p = decodeURIComponent(req.url.split('?')[0]);
  if (p.endsWith('/')) p += 'index.html';
  try {
    const body = await readFile(join(root, normalize(p)));
    res.writeHead(200, { 'content-type': MIME[extname(p)] || 'application/octet-stream' });
    res.end(body);
  } catch { res.writeHead(404).end('nope'); }
});
await new Promise(r => server.listen(port, r));

// seeded PRNG so canvas seed arrays are identical across runs/builds
const SEED_RANDOM = `(() => { let s = 0x2F6E2B1; Math.random = () => {
  s ^= s << 13; s ^= s >>> 17; s ^= s << 5; s |= 0; return (s >>> 0) / 4294967296; }; })();`;

// The design-canvas reference pulls Archivo from Google Fonts at render time,
// which makes the comparison depend on the network: when the webfont loses the
// race, form-control metrics shift and the page comes out 4px shorter. Serve
// the identical bytes locally instead — same file Google hands out — so the
// reference is reproducible offline and byte-stable run to run.
const ARCHIVO = readFileSync(new URL('../assets/fonts/archivo-latin.woff2', import.meta.url));
// Google ships nine faces for this family — three subsets x three weights, all
// pointing at the same variable file — and the set matters: Chromium takes a
// form control's `line-height: normal` metrics from the first declared face, so
// serving only `latin` renders the contact <select> 4px shorter than the design
// canvas does. Reproduce all nine, in Google's own order.
const RANGES = {
  vietnamese: 'U+0102-0103, U+0110-0111, U+0128-0129, U+0168-0169, U+01A0-01A1, U+01AF-01B0, U+0300-0301, U+0303-0304, U+0308-0309, U+0323, U+0329, U+1EA0-1EF9, U+20AB',
  'latin-ext': 'U+0100-02BA, U+02BD-02C5, U+02C7-02CC, U+02CE-02D7, U+02DD-02FF, U+0304, U+0308, U+0329, U+1D00-1DBF, U+1E00-1E9F, U+1EF2-1EFF, U+2020, U+20A0-20AB, U+20AD-20C0, U+2113, U+2C60-2C7F, U+A720-A7FF',
  latin: 'U+0000-00FF, U+0131, U+0152-0153, U+02BB-02BC, U+02C6, U+02DA, U+02DC, U+0304, U+0308, U+0329, U+2000-206F, U+20AC, U+2122, U+2191, U+2193, U+2212, U+2215, U+FEFF, U+FFFD',
};
const GOOGLE_CSS = [400, 600, 800]
  .flatMap((w) => Object.entries(RANGES).map(([subset, range]) =>
    `/* ${subset} */@font-face{font-family:'Archivo';font-style:normal;font-weight:${w};font-display:swap;` +
    `src:url(https://fonts.gstatic.com/s/archivo/v25/${subset}.woff2) format('woff2');unicode-range:${range};}`))
  .join('\n');

await mkdir(OUT, { recursive: true });
const browser = await chromium.launch();
for (const [w, h] of VIEWPORTS) {
  const ctx = await browser.newContext({
    viewport: { width: w, height: h },
    deviceScaleFactor: 1,
    // reduced-motion makes paint() draw one static frame at t=0 and disables
    // the scroll-reveal, so every element is visible and deterministic
    reducedMotion: 'reduce',
  });
  await ctx.addInitScript(SEED_RANDOM);
  await ctx.route('https://fonts.googleapis.com/**', (r) => r.fulfill({ contentType: 'text/css', body: GOOGLE_CSS }));
  await ctx.route('https://fonts.gstatic.com/**', (r) => r.fulfill({ contentType: 'font/woff2', body: ARCHIVO }));
  const page = await ctx.newPage();
  await page.goto(`http://localhost:${port}/`, { waitUntil: 'networkidle' });
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(700);
  // drop the fixed-position widgets: cookie banner + chat button are
  // compared separately and would otherwise smear over the full-page shot
  await page.addStyleTag({ content: '[style*="position:fixed"],[style*="position: fixed"]{visibility:hidden!important}' });
  // `overflow-x: hidden` on body makes body the scroll container, which caps
  // documentElement.scrollHeight at the viewport and breaks fullPage capture.
  // `clip` prevents the same horizontal overflow without creating a scroller.
  await page.addStyleTag({ content: 'body{overflow-x:clip!important}' });
  // The four background canvases are seeded with Math.random by design, so they
  // can never be compared pixel-for-pixel, and the SVG ring keyframes settle at
  // sub-frame-dependent values. Hide both: their geometry still participates in
  // the layout being captured, their non-determinism does not.
  await page.addStyleTag({ content: 'canvas{visibility:hidden!important} *{animation:none!important}' });
  // Wide-screen scaling (design/overrides.css) is a deliberate deviation from
  // the canvas, applied on top of the very layout being compared. Neutralise it
  // so the diff still checks the layout itself at every viewport, including the
  // ones where the shipped page is scaled up.
  //
  // Only on pages that actually declare it: in Chromium a `zoom` declaration is
  // never a true no-op, not even `zoom: normal` or `zoom: 1` — its mere presence
  // changes how a form control resolves `line-height: normal`, which moves the
  // contact <select> by 4px. Injecting it into the untouched reference would
  // therefore introduce the very difference this diff exists to catch.
  const scaled = await page.evaluate(() =>
    !!getComputedStyle(document.documentElement).getPropertyValue('--cw-zoom').trim());
  if (scaled) {
    await page.addStyleTag({ content: ':root{zoom:normal!important;--cw-zoom:1!important}' });
  }
  // The workflow diagrams animate their packet dots with SMIL, which runs on
  // its own clock from page load and so lands at a different phase every run.
  // Rewind every SVG timeline to t=0 and freeze it.
  await page.evaluate(() => {
    document.querySelectorAll('svg').forEach((svg) => {
      if (typeof svg.setCurrentTime === 'function') svg.setCurrentTime(0);
      if (typeof svg.pauseAnimations === 'function') svg.pauseAnimations();
    });
  });
  await page.waitForTimeout(150);
  await page.screenshot({ path: join(OUT, `${label}-${w}.png`), fullPage: true });
  const height = await page.evaluate(() => document.documentElement.scrollHeight);
  console.log(`${label} ${w}x${h} -> fullpage height ${height}`);
  await ctx.close();
}
await browser.close();
server.close();
