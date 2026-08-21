#!/usr/bin/env node
/**
 * bake.mjs — compile the Claude Design export into a static index.html.
 *
 *   node tools/bake.mjs
 *
 * The design canvas ships an <x-dc> template that is rendered in the browser by
 * support.js, which first pulls React 18 + ReactDOM UMD off unpkg. That is
 * ~330KB of blocking third-party JS before a single pixel paints. This script
 * does that render once, here, so the browser gets finished HTML.
 *
 * Inputs
 *   design/landing-v2.dc.html  the design export (source of truth for markup)
 *   design/head.html           hand-maintained SEO / analytics / consent head
 *   design/jsonld.html         structured data (FAQPage + ProfessionalService)
 *   design/base.css            trimmed design-system base + @font-face
 *   design/overrides.css       deliberate deviations, documented inline
 *   design/app.src.js          vanilla port of the runtime's behaviour
 *
 * Outputs
 *   index.html                 static, self-contained but for assets/
 *   assets/app.js
 *
 * Re-run this after pulling a new design revision; the SEO layer survives
 * untouched because it lives in design/head.html, not in the export.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(join(ROOT, p), 'utf8');

/* ── 1. Slice the export ────────────────────────────────────────────────── */

const src = read('design/landing-v2.dc.html');

const helmet = slice(src, '<helmet>', '</helmet>', 'helmet');
const pageStyle = slice(helmet, '<style>', '</style>', 'helmet <style>');
const dcScript = slice(src, 'data-dc-script data-props="{}">', '</script>', 'dc script');

// the template is everything between </helmet> and </x-dc>
let tpl = slice(src, '</helmet>', '</x-dc>', 'template');

/* ── 2. Lift the data literals out of renderVals() ──────────────────────── */

// caps / services / crosshairs are static arrays in the component's
// renderVals(). Parse them straight out of the source so a design revision
// that edits the copy flows through without touching this script.
const data = {
  caps: literal(dcScript, 'caps'),
  services: literal(dcScript, 'services'),
  crosshairs: literal(dcScript, 'crosshairs'),
};
for (const [k, v] of Object.entries(data)) {
  if (!Array.isArray(v)) throw new Error(`expected ${k} to be an array`);
}

/* ── 3. Expand <sc-for> ─────────────────────────────────────────────────── */

tpl = expand(tpl, 'sc-for', (attrs, inner) => {
  const listName = mustache(attrs.list);
  const as = attrs.as;
  const list = data[listName];
  if (!list) throw new Error(`sc-for over unknown list "${listName}"`);
  return list
    .map((item) =>
      inner.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (whole, path) => {
        const [head, ...rest] = path.split('.');
        if (head !== as) return whole; // not ours — leave for a later pass
        const value = rest.reduce((o, k) => (o == null ? o : o[k]), item);
        return escapeHtml(String(value ?? ''));
      })
    )
    .join('\n');
});

/* ── 4. Resolve <sc-if> ─────────────────────────────────────────────────── */

// Every branch is kept in the DOM. Which one shows is decided by CSS (the nav)
// or by a `hidden` attribute that assets/app.js toggles (the menu, the form).
// Nothing here waits on JS to render the correct first frame.
const IF_BRANCHES = {
  showLinks: { class: 'cw-nav-desktop' },
  showBurger: { class: 'cw-nav-burger' },
  menuPanelOpen: { id: 'cw-nav-menu', class: 'cw-nav-menu', hidden: true },
  sent: { id: 'cw-form-sent', hidden: true },
  notSent: { id: 'cw-form-live' },
};

tpl = expand(tpl, 'sc-if', (attrs, inner) => {
  const name = mustache(attrs.value);
  const branch = IF_BRANCHES[name];
  if (!branch) throw new Error(`sc-if on unhandled condition "${name}"`);
  return injectAttrs(inner, branch);
});

/* ── 5. Hover / focus attributes → real CSS classes ─────────────────────── */

// The runtime does exactly this: it dedupes identical declarations into shared
// classes and writes them with !important (so they beat the inline style they
// are overriding). Focus maps to :focus, not :focus-visible — matching the
// runtime, which is what the design was reviewed against.
const stateCss = [];
const stateClasses = new Map(); // "hover|<decls>" -> class name

tpl = tpl.replace(/\s+style-(hover|focus)="([^"]*)"/g, (_whole, state, decls) => {
  const key = `${state}|${decls}`;
  let cls = stateClasses.get(key);
  if (!cls) {
    cls = `cw-s${stateClasses.size.toString(36)}`;
    stateClasses.set(key, cls);
    stateCss.push(`.${cls}:${state}{${important(decls)}}`);
  }
  return ` data-cw-state-class="${cls}"`;
});
// fold the marker attribute into the element's real class list
tpl = foldStateClasses(tpl);

/* ── 6. Refs, handlers, editor-only attributes ──────────────────────────── */

const REFS = {
  navRef: 'cw-nav',
  heroCanvasRef: 'cw-canvas-hero',
  fsCanvasRef: 'cw-canvas-fs',
  flowCanvasRef: 'cw-canvas-flow',
  footCanvasRef: 'cw-canvas-foot',
  widgetRef: 'cw-widgets',
};
tpl = tpl.replace(/\s+ref="\{\{\s*(\w+)\s*\}\}"/g, (_w, name) => {
  const id = REFS[name];
  if (!id) throw new Error(`unmapped ref "${name}"`);
  return ` id="${id}"`;
});

const HANDLERS = { toggleMenu: 'toggle-menu', closeMenu: 'close-menu' };
tpl = tpl.replace(/\s+onClick="\{\{\s*(\w+)\s*\}\}"/g, (_w, name) => {
  const act = HANDLERS[name];
  if (!act) throw new Error(`unmapped onClick handler "${name}"`);
  return ` data-act="${act}"`;
});
// the form already carries an id from its sc-if branch, so mark the handler
// with an attribute rather than a second id (two ids on one tag = the first wins)
tpl = tpl.replace(/\s+onSubmit="\{\{\s*onSubmit\s*\}\}"/g, ' data-cw-submit');

// canvas-editor bookkeeping that has no business in the shipped page
tpl = tpl.replace(/\s+hint-placeholder-(?:val|count)="[^"]*"/g, '');
tpl = tpl.replace(/\s+data-comment-anchor="[^"]*"/g, '');

/* ── 7. SEO: promote the three service titles to real headings ──────────── */

// They ship as <span>. The inline declarations below reproduce the span's
// computed values exactly — including line-height, which the design-system's
// h3 rule would otherwise change from 1.55 to 1.12 and shift the card's
// height. Verified by the screenshot diff, not by eye.
tpl = tpl.replace(
  /<span style="font-size: clamp\(16px, 1\.8vw, 21px\); font-weight: 700; letter-spacing: -0\.02em; color: #ffffff;">([^<]+)<\/span>/g,
  (_w, title) =>
    `<h3 style="font-size: clamp(16px, 1.8vw, 21px); font-weight: 700; letter-spacing: -0.02em; color: #ffffff; font-family: inherit; line-height: 1.55; margin: 0;">${title}</h3>`
);

/* ── 8. Anything left unresolved is a bug — fail loudly ─────────────────── */

const ids = [...tpl.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]);
const dupes = ids.filter((id, i) => ids.indexOf(id) !== i);
if (dupes.length) throw new Error(`duplicate id(s) in baked output: ${[...new Set(dupes)].join(', ')}`);
// two id attributes on one tag silently lose the second — catch that too
const doubled = /<[a-z][^>]*\sid="[^"]*"[^>]*\sid="/i.exec(tpl);
if (doubled) throw new Error(`element carries two id attributes near: ${context(tpl, doubled.index)}`);

for (const [pattern, what] of [
  [/<\/?sc-[a-z]+/i, 'unexpanded <sc-*> element'],
  [/\{\{/, 'unresolved {{ }} interpolation'],
  [/\sref="/, 'unmapped ref='],
  [/\son(?:Click|Submit)="/, 'unmapped event handler'],
  [/style-(?:hover|focus)=/, 'unconverted style-state attribute'],
]) {
  const m = pattern.exec(tpl);
  if (m) throw new Error(`${what} survived the bake near: ${context(tpl, m.index)}`);
}

/* ── 9. Assemble ────────────────────────────────────────────────────────── */

const css = [
  '/* design-system base (trimmed) */',
  read('design/base.css'),
  '/* page styles, verbatim from the design export */',
  pageStyle.trim(),
  '/* generated from style-hover / style-focus, mirroring the runtime */',
  stateCss.join('\n'),
  '/* deliberate deviations */',
  read('design/overrides.css'),
].join('\n\n');

const head = read('design/head.html')
  .replace(/<!--[\s\S]*?-->\n/, '') // strip this file's own explanatory header
  .replace('<!--BAKE:CSS-->', () => '\n' + css + '\n')
  .replace('<!--BAKE:JSONLD-->', () => read('design/jsonld.html').trim());

const html = `<!DOCTYPE html>
<html lang="en">
<head>
${head.trim()}
</head>
<body>
${tpl.trim()}
</body>
</html>
`;

writeFileSync(join(ROOT, 'index.html'), html);
writeFileSync(join(ROOT, 'assets/app.js'), read('design/app.src.js'));

const kb = (s) => (Buffer.byteLength(s) / 1024).toFixed(1) + 'KB';
console.log(`baked index.html   ${kb(html)}`);
console.log(`  sc-for expanded  caps=${data.caps.length} services=${data.services.length} crosshairs=${data.crosshairs.length}`);
console.log(`  state classes    ${stateClasses.size} (from ${stateCss.length} unique declarations)`);
console.log(`  inlined css      ${kb(css)}`);
console.log(`assets/app.js      ${kb(read('design/app.src.js'))}`);

/* ── helpers ────────────────────────────────────────────────────────────── */

function slice(text, open, close, what) {
  const a = text.indexOf(open);
  if (a === -1) throw new Error(`could not find ${what} opening (${open})`);
  const b = text.indexOf(close, a + open.length);
  if (b === -1) throw new Error(`could not find ${what} closing (${close})`);
  return text.slice(a + open.length, b);
}

function mustache(value) {
  const m = /\{\{\s*([\w.]+)\s*\}\}/.exec(value || '');
  if (!m) throw new Error(`expected a {{ binding }}, got "${value}"`);
  return m[1];
}

/** Pull `name: [ ... ]` out of the component source and evaluate it. */
function literal(source, name) {
  const start = source.indexOf(`${name}: [`);
  if (start === -1) throw new Error(`no literal named "${name}"`);
  let i = source.indexOf('[', start);
  let depth = 0;
  let inStr = null;
  for (let j = i; j < source.length; j++) {
    const ch = source[j];
    if (inStr) {
      if (ch === '\\') j++;
      else if (ch === inStr) inStr = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') inStr = ch;
    else if (ch === '[') depth++;
    else if (ch === ']' && --depth === 0) {
      return Function(`"use strict"; return (${source.slice(i, j + 1)});`)();
    }
  }
  throw new Error(`unbalanced literal "${name}"`);
}

/** Replace every <tag ...>…</tag>, nesting-aware, via a callback. */
function expand(html, tag, render) {
  const open = new RegExp(`<${tag}\\b([^>]*)>`, 'i');
  for (let guard = 0; guard < 500; guard++) {
    const m = open.exec(html);
    if (!m) return html;
    const innerStart = m.index + m[0].length;
    const end = matchClose(html, tag, innerStart);
    const inner = html.slice(innerStart, end);
    const replaced = render(parseAttrs(m[1]), inner);
    html = html.slice(0, m.index) + replaced + html.slice(end + tag.length + 3);
  }
  throw new Error(`runaway expansion of <${tag}>`);
}

function matchClose(html, tag, from) {
  const scan = new RegExp(`<(/?)${tag}\\b`, 'gi');
  scan.lastIndex = from;
  let depth = 1;
  let m;
  while ((m = scan.exec(html))) {
    depth += m[1] ? -1 : 1;
    if (depth === 0) return m.index;
  }
  throw new Error(`unclosed <${tag}>`);
}

function parseAttrs(str) {
  const out = {};
  for (const m of str.matchAll(/([\w:-]+)="([^"]*)"/g)) out[m[1]] = m[2];
  return out;
}

/** Add id / class / hidden to the first element of a fragment. */
function injectAttrs(fragment, { id, class: cls, hidden }) {
  const m = /<([a-z][\w-]*)((?:\s+[^>]*?)?)(\/?)>/i.exec(fragment);
  if (!m) throw new Error('sc-if branch has no element to annotate');
  let attrs = '';
  if (id) attrs += ` id="${id}"`;
  if (cls) attrs += ` class="${cls}"`;
  if (hidden) attrs += ' hidden';
  const tag = `<${m[1]}${attrs}${m[2]}${m[3]}>`;
  return fragment.slice(0, m.index) + tag + fragment.slice(m.index + m[0].length);
}

/** Merge data-cw-state-class markers into a real class attribute. */
function foldStateClasses(html) {
  return html.replace(/<([a-z][\w-]*)([^>]*?)\/?>/gi, (whole, tag, attrs) => {
    const marks = [...attrs.matchAll(/\s+data-cw-state-class="([^"]+)"/g)].map((m) => m[1]);
    if (!marks.length) return whole;
    let rest = attrs.replace(/\s+data-cw-state-class="[^"]+"/g, '');
    const existing = /\sclass="([^"]*)"/.exec(rest);
    if (existing) {
      rest = rest.replace(existing[0], ` class="${existing[1]} ${marks.join(' ')}"`);
    } else {
      rest = ` class="${marks.join(' ')}"` + rest;
    }
    const selfClosing = whole.endsWith('/>') ? '/' : '';
    return `<${tag}${rest}${selfClosing}>`;
  });
}

/** `a: b; c: d` -> `a: b !important; c: d !important` */
function important(decls) {
  return decls
    .split(';')
    .map((d) => d.trim())
    .filter(Boolean)
    .map((d) => `${d} !important`)
    .join('; ');
}

function escapeHtml(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function context(text, index) {
  return JSON.stringify(text.slice(Math.max(0, index - 60), index + 60));
}
