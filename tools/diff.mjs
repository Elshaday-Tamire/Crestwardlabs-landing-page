#!/usr/bin/env node
/**
 * diff.mjs — pixel-diff two screenshot sets, using headless Chromium as the
 * PNG decoder so this needs no image library.
 *
 *   node tools/diff.mjs <shotsDir> <labelA> <labelB>
 *
 * Prints, per viewport: differing pixel count, the worst channel delta, and the
 * y-band where differences start — which is what you actually need to find the
 * offending element. Writes <a>-vs-<b>-<width>.png heat maps for anything that
 * is not a clean match.
 */
import { chromium } from 'playwright';
import { readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const [, , dir, labelA, labelB] = process.argv;
// derived from what shot.mjs actually captured, so the two stay in step
const WIDTHS = readdirSync(dir)
  .map((f) => new RegExp(`^${labelA}-(\\d+)\\.png$`).exec(f))
  .filter(Boolean)
  .map((m) => Number(m[1]))
  .sort((a, b) => a - b);
if (!WIDTHS.length) { console.error(`no ${labelA}-*.png in ${dir} — run tools/shot.mjs first`); process.exit(1); }
const TOLERANCE = 8; // per-channel; below this is antialiasing noise, not layout

const browser = await chromium.launch();
const page = await browser.newPage();
let worst = 0;

for (const w of WIDTHS) {
  const pa = join(dir, `${labelA}-${w}.png`);
  const pb = join(dir, `${labelB}-${w}.png`);
  if (!existsSync(pa) || !existsSync(pb)) { console.log(`${w}: missing shots`); continue; }

  const result = await page.evaluate(async ({ a, b, tol }) => {
    const load = (src) => new Promise((res, rej) => {
      const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = src;
    });
    const [ia, ib] = await Promise.all([load(a), load(b)]);
    const W = Math.max(ia.width, ib.width);
    const H = Math.max(ia.height, ib.height);
    const grab = (img) => {
      const c = new OffscreenCanvas(W, H);
      const x = c.getContext('2d', { willReadFrequently: true });
      x.drawImage(img, 0, 0);
      return x.getImageData(0, 0, W, H).data;
    };
    const da = grab(ia), db = grab(ib);
    const out = new OffscreenCanvas(W, H);
    const octx = out.getContext('2d');
    const heat = octx.createImageData(W, H);

    let diff = 0, maxDelta = 0, firstY = -1, lastY = -1;
    const rows = new Map();
    for (let p = 0; p < da.length; p += 4) {
      const d = Math.max(
        Math.abs(da[p] - db[p]), Math.abs(da[p + 1] - db[p + 1]),
        Math.abs(da[p + 2] - db[p + 2]), Math.abs(da[p + 3] - db[p + 3])
      );
      const y = Math.floor(p / 4 / W);
      if (d > maxDelta) maxDelta = d;
      if (d > tol) {
        diff++;
        if (firstY === -1) firstY = y;
        lastY = y;
        rows.set(y, (rows.get(y) || 0) + 1);
        heat.data[p] = 255; heat.data[p + 1] = 0; heat.data[p + 2] = 0; heat.data[p + 3] = 255;
      } else {
        const g = (da[p] + da[p + 1] + da[p + 2]) / 3;
        heat.data[p] = heat.data[p + 1] = heat.data[p + 2] = 30 + g * 0.25;
        heat.data[p + 3] = 255;
      }
    }
    const bands = [...rows.entries()].sort((x, y) => y[1] - x[1]).slice(0, 5)
      .map(([y, n]) => `y=${y}(${n}px)`);
    octx.putImageData(heat, 0, 0);
    const blob = await out.convertToBlob({ type: 'image/png' });
    const buf = new Uint8Array(await blob.arrayBuffer());
    return {
      W, H, diff, maxDelta, firstY, lastY, bands,
      total: W * H,
      sizeA: [ia.width, ia.height], sizeB: [ib.width, ib.height],
      png: diff ? [...buf] : null,
    };
  }, {
    a: 'data:image/png;base64,' + readFileSync(pa).toString('base64'),
    b: 'data:image/png;base64,' + readFileSync(pb).toString('base64'),
    tol: TOLERANCE,
  });

  const pct = ((result.diff / result.total) * 100).toFixed(4);
  const size = result.sizeA.join('x') === result.sizeB.join('x')
    ? result.sizeA.join('x')
    : `${result.sizeA.join('x')} vs ${result.sizeB.join('x')}  <-- SIZE MISMATCH`;
  console.log(`${w}px  ${size}`);
  console.log(`      differing: ${result.diff} px (${pct}%)  maxChannelDelta: ${result.maxDelta}`);
  if (result.diff) {
    console.log(`      first diff at y=${result.firstY}, last at y=${result.lastY}`);
    console.log(`      worst rows: ${result.bands.join(' ')}`);
    const out = join(dir, `${labelA}-vs-${labelB}-${w}.png`);
    writeFileSync(out, Buffer.from(result.png));
    console.log(`      heat map: ${out}`);
  }
  worst = Math.max(worst, result.diff / result.total);
}

await browser.close();
console.log(worst === 0 ? '\nIDENTICAL' : `\nworst viewport differs by ${(worst * 100).toFixed(4)}% of pixels`);
