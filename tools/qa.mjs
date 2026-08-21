import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
const root = process.argv[2];
const MIME={'.html':'text/html','.js':'text/javascript','.css':'text/css','.png':'image/png','.woff2':'font/woff2','.txt':'text/plain','.xml':'application/xml'};
const server=createServer(async(req,res)=>{let p=decodeURIComponent(req.url.split('?')[0]);if(p.endsWith('/'))p+='index.html';
 try{const b=await readFile(join(root,normalize(p)));res.writeHead(200,{'content-type':MIME[extname(p)]||'application/octet-stream'});res.end(b);}catch{res.writeHead(404).end('404');}});
await new Promise(r=>server.listen(8861,r));
const br=await chromium.launch();
const pass=[], fail=[];
const ok=(c,m)=>(c?pass:fail).push(m);

/* ── desktop pass ── */
let ctx=await br.newContext({viewport:{width:1280,height:900}});
let page=await ctx.newPage();
const reqs=[], errs=[];
page.on('request',r=>reqs.push(r.url()));
page.on('pageerror',e=>errs.push(String(e)));
page.on('console',m=>{ if(m.type()==='error') errs.push('console: '+m.text()); });
page.on('requestfailed',r=>{ if(!/googletagmanager|agenthub/.test(r.url())) errs.push('reqfail: '+r.url()); });
await page.goto('http://localhost:8861/',{waitUntil:'networkidle'});
await page.waitForTimeout(1200);

ok(errs.length===0, 'no console/page errors' + (errs.length?': '+errs.slice(0,3).join(' | '):''));
ok(!reqs.some(u=>/unpkg\.com/.test(u)), 'no unpkg requests');
ok(!reqs.some(u=>/react/i.test(u)), 'no React requests');
ok(!reqs.some(u=>/support\.js/.test(u)), 'no support.js request');
ok(!reqs.some(u=>/fonts\.(googleapis|gstatic)/.test(u)), 'no Google Fonts requests');
ok(!reqs.some(u=>/googletagmanager/.test(u)), 'GA NOT loaded before consent');
const third=[...new Set(reqs.filter(u=>!u.startsWith('http://localhost:8861')))];
ok(third.length===0, 'zero third-party requests on load' + (third.length?': '+third.join(', '):''));
ok(await page.evaluate(()=>!!window._loadGA), '_loadGA present');
ok(await page.evaluate(()=>document.querySelectorAll('script[type="application/ld+json"]').length===2), 'both JSON-LD blocks present');
ok(await page.evaluate(()=>document.documentElement.lang==='en'), 'html lang=en');
ok(await page.evaluate(()=>document.querySelectorAll('h1').length===1), 'exactly one h1');
ok(await page.evaluate(()=>document.documentElement.scrollHeight>4000), 'document (not body) is the scroller');

/* cookie banner + GA gating */
const banner=page.locator('text=We use cookies').first();
ok(await banner.isVisible(), 'cookie banner shown on first visit');
await page.locator('button:has-text("Accept")').click();
await page.waitForTimeout(800);
ok(await page.evaluate(()=>localStorage.getItem('cw_cookie_consent'))==='accepted', 'consent stored as accepted');
ok(reqs.some(u=>/googletagmanager/.test(u)), 'GA loaded after Accept');
ok(!(await banner.isVisible()), 'banner dismissed after Accept');

/* chat */
await page.locator('button[aria-label="Open chat"]').click();
await page.waitForTimeout(500);
ok(await page.locator('[role="dialog"][aria-label="Crestward Assistant"]').isVisible(), 'chat panel opens');
ok(await page.locator('[role="dialog"] textarea').isVisible(), 'chat input present');
ok(await page.locator('[role="dialog"] button[aria-label="Dictate message"]').count()===1, 'mic button present (restored)');
ok((await page.locator('[role="dialog"]').innerText()).includes('Crestward Assistant'), 'welcome/header rendered');
await page.locator('[role="dialog"] button[aria-label="Close chat"]').click();
await page.waitForTimeout(400);

/* contact form — honeypot + placeholder-endpoint fallback */
{
  const hp = page.locator('input[name="company"]');
  ok(await hp.count() === 1, 'honeypot field injected into the form');
  const hpStyle = await hp.evaluate((el) => {
    const cs = getComputedStyle(el);
    return { opacity: cs.opacity, position: cs.position, ariaHidden: el.getAttribute('aria-hidden'), tabIndex: el.tabIndex };
  });
  ok(hpStyle.opacity === '0' && hpStyle.position === 'absolute', 'honeypot is visually hidden (opacity 0, positioned off-canvas)');
  ok(hpStyle.tabIndex === -1, 'honeypot is not tabbable');
  ok(hpStyle.ariaHidden === 'true', 'honeypot is aria-hidden');

  const fetchesToWorker = [];
  page.on('request', (r) => { if (r.url().indexOf('workers.dev') !== -1) fetchesToWorker.push(r.url()); });
  await page.fill('#v2-name','Jane'); await page.fill('#v2-email','jane@x.com'); await page.fill('#v2-msg','Hello');
  await page.locator('button[type="submit"]').click();
  await page.waitForTimeout(400);
  ok(fetchesToWorker.length === 0, 'no fetch() attempted while CONTACT_ENDPOINT is still the placeholder');
  ok(await page.locator('#cw-form-sent').isVisible(), 'falls back to the sent state via mailto');
  ok(!(await page.locator('#cw-form-live').isVisible()), 'form hidden after submit');
}
ok(await page.evaluate(()=>document.querySelectorAll('nav .cw-nav-desktop').length===1 && getComputedStyle(document.querySelector('.cw-nav-desktop')).display==='flex'), 'desktop nav links visible at 1280');
ok(await page.evaluate(()=>getComputedStyle(document.querySelector('.cw-nav-burger')).display==='none'), 'burger hidden at 1280');
await ctx.close();

/* ── mobile pass ── */
ctx=await br.newContext({viewport:{width:390,height:844}});
page=await ctx.newPage();
await page.goto('http://localhost:8861/',{waitUntil:'networkidle'});
await page.waitForTimeout(800);
ok(await page.evaluate(()=>getComputedStyle(document.querySelector('.cw-nav-burger')).display==='flex'), 'burger shown at 390');
ok(await page.evaluate(()=>getComputedStyle(document.querySelector('.cw-nav-desktop')).display==='none'), 'desktop links hidden at 390');
ok(!(await page.locator('#cw-nav-menu').isVisible()), 'mobile menu closed initially');
await page.locator('.cw-nav-burger').click();
await page.waitForTimeout(300);
ok(await page.locator('#cw-nav-menu').isVisible(), 'burger opens mobile menu');
await page.locator('#cw-nav-menu a[href="#services"]').click();
await page.waitForTimeout(300);
ok(!(await page.locator('#cw-nav-menu').isVisible()), 'menu closes on link click');
await ctx.close();

/* ── wide-screen scaling ── */
/* The design is a fixed 1280px canvas. Above ~1440px it is scaled against the
   --cw-canvas reference width so it keeps filling the viewport instead of
   sitting in the middle at design size, while still leaving a column of air
   either side rather than running edge to edge. */
for (const [w, expectScale, expectFill] of [
  [1280, 1.00, 1.00],
  [1600, 1.11, 0.89],
  [1920, 1.33, 0.89],
  [2560, 1.78, 0.89],
  [3440, 2.00, 0.74],   // capped, so the fill drops away on an ultrawide
]) {
  const c = await br.newContext({ viewport: { width: w, height: 1080 } });
  const p2 = await c.newPage();
  await p2.goto('http://localhost:8861/', { waitUntil: 'domcontentloaded' });
  await p2.waitForTimeout(400);
  const r = await p2.evaluate(() => {
    const frame = document.querySelector('main#top').parentElement;
    return {
      zoom: parseFloat(getComputedStyle(document.documentElement).zoom),
      fill: frame.getBoundingClientRect().width / window.innerWidth,
      overflow: document.documentElement.scrollWidth > window.innerWidth + 1,
    };
  });
  ok(Math.abs(r.zoom - expectScale) < 0.02, `${w}px scales ${expectScale}x (got ${r.zoom.toFixed(3)})`);
  ok(Math.abs(r.fill - expectFill) < 0.03, `${w}px frame covers ${Math.round(expectFill*100)}% (got ${Math.round(r.fill*100)}%)`);
  ok(!r.overflow, `${w}px has no horizontal overflow`);
  await c.close();
}
/* never scale DOWN on small screens */
for (const w of [360, 768, 1100, 1280]) {
  const c = await br.newContext({ viewport: { width: w, height: 800 } });
  const p2 = await c.newPage();
  await p2.goto('http://localhost:8861/', { waitUntil: 'domcontentloaded' });
  await p2.waitForTimeout(300);
  const z = await p2.evaluate(() => parseFloat(getComputedStyle(document.documentElement).zoom));
  ok(z === 1, `${w}px is not scaled (zoom ${z})`);
  await c.close();
}

await br.close(); server.close();
console.log('PASS ' + pass.length);
pass.forEach(p=>console.log('  ✓ '+p));
if (fail.length) { console.log('FAIL ' + fail.length); fail.forEach(f=>console.log('  ✗ '+f)); process.exitCode=1; }
