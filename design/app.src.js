/**
 * Crestward Labs — page behaviour.
 *
 * A vanilla port of the design canvas's React component. Same canvas fields,
 * same reveal timings, same widgets — minus React, ReactDOM and the dc-runtime,
 * which together cost ~330KB of blocking third-party JS on every page view.
 *
 * Copied into assets/app.js by tools/bake.mjs. Edit this file, not that one.
 */
(function () {
  'use strict';

  var $ = function (id) { return document.getElementById(id); };
  var reduceMotion = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  /* ── canvas fields ───────────────────────────────────────────────────── */

  var raf = null;
  var io = null;
  var resizeTimer = null;

  function paint() {
    /* Under the wide-screen scale (design/overrides.css) these two disagree:
       clientWidth/Height stay in layout px, getBoundingClientRect reports the
       visual, zoomed box. Draw in layout space so the wave and streak fields
       keep the density they were designed at — measuring the visual box would
       pack 192 hairlines into the hero where the design has 128 — and take the
       backing-store scale from the ratio between the two so it stays sharp.
       At zoom 1 the ratio is 1 and this behaves exactly as it always did. */
    var fit = function (c) {
      var r = c.getBoundingClientRect();
      var w = c.clientWidth || r.width;
      var h = c.clientHeight || r.height;
      var dpr = Math.min(window.devicePixelRatio || 1, 1.5);
      var scale = Math.min(dpr * (w ? r.width / w : 1), 3);
      c.width = Math.max(1, Math.round(w * scale));
      c.height = Math.max(1, Math.round(h * scale));
      var ctx = c.getContext('2d');
      ctx.setTransform(scale, 0, 0, scale, 0, 0);
      return { ctx: ctx, w: w, h: h };
    };

    /* wave-line field on the blue panels */
    var waves = function (canvas, opts) {
      if (!canvas) return null;
      var f = fit(canvas), ctx = f.ctx, w = f.w, h = f.h;
      var count = Math.max(40, Math.round(w / (opts.spacing || 9)));
      return function (t) {
        ctx.clearRect(0, 0, w, h);
        ctx.lineWidth = 1;
        var sweep = ((t * 0.00007) % 1.4) - 0.2;
        for (var i = 0; i < count; i++) {
          var x0 = (i / (count - 1)) * w;
          var p = i / count;
          var near = Math.max(0, 1 - Math.abs(p - sweep) / 0.22);
          ctx.beginPath();
          ctx.strokeStyle = 'rgba(255,255,255,' + (0.12 + 0.2 * Math.abs(Math.sin(p * Math.PI * 2 + t * 0.00016)) + 0.5 * near * near) + ')';
          for (var y = -10; y <= h + 10; y += 8) {
            var q = y / h;
            var amp = (opts.amp || 34) * (0.45 + 0.75 * Math.sin(p * Math.PI));
            var x = x0
              + Math.sin(q * 2.6 + p * 5.4 + t * 0.00022) * amp
              + Math.sin(q * 5.1 - p * 2.2 + t * 0.00013) * amp * 0.4;
            if (y <= -10) ctx.moveTo(x, y); else ctx.lineTo(x, y);
          }
          ctx.stroke();
        }
      };
    };

    /* converging streak field for the mid band */
    var flow = function (canvas) {
      if (!canvas) return null;
      var f = fit(canvas), ctx = f.ctx, w = f.w, h = f.h;
      var N = Math.round(Math.min(190, Math.max(70, w / 6)));
      var seeds = [];
      for (var i = 0; i < N; i++) seeds.push({ o: (i / N) * 2 - 1, j: Math.random() * 0.5 + 0.5, s: Math.random() });
      return function (t) {
        ctx.clearRect(0, 0, w, h);
        var cx = w * 0.5, cy = h * 0.5;
        ctx.lineWidth = 1;
        for (var n = 0; n < seeds.length; n++) {
          var sd = seeds[n];
          ctx.beginPath();
          var drift = ((t * 0.00004 * sd.j) + sd.s) % 1;
          for (var k = 0; k <= 36; k++) {
            var u = k / 36;
            var x = u * w;
            var d = Math.abs(x - cx) / cx;
            var spread = Math.pow(d, 1.9);
            var wob = Math.sin(u * 7 + drift * Math.PI * 2 + sd.o * 3) * 6 * spread;
            var y = cy + sd.o * (h * 0.52) * spread + wob;
            if (k === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
          }
          var near = 1 - Math.abs(sd.o);
          ctx.strokeStyle = 'rgba(' + (110 + Math.round(80 * near)) + ',' + (150 + Math.round(80 * near)) + ',255,' + (0.10 + 0.32 * (0.4 + 0.6 * Math.abs(Math.sin(drift * Math.PI * 2)))) + ')';
          ctx.stroke();
        }
      };
    };

    var nodes = [$('cw-canvas-hero'), $('cw-canvas-flow'), $('cw-canvas-foot'), $('cw-canvas-fs')];
    var drawers = [waves(nodes[0], { spacing: 10, amp: 40 }), flow(nodes[1]), waves(nodes[2], { spacing: 8, amp: 26 }), waves(nodes[3], { spacing: 11, amp: 30 })];
    var items = [];
    for (var i = 0; i < drawers.length; i++) {
      if (drawers[i]) items.push({ draw: drawers[i], node: nodes[i], visible: true });
    }

    if (raf) cancelAnimationFrame(raf);
    if (reduceMotion || !items.length) {
      items.forEach(function (it) { it.draw(0); });
      return;
    }

    /* only paint canvases that are actually on screen */
    if (io) io.disconnect();
    if ('IntersectionObserver' in window) {
      io = new IntersectionObserver(function (entries) {
        entries.forEach(function (e) {
          for (var j = 0; j < items.length; j++) {
            if (items[j].node === e.target) items[j].visible = e.isIntersecting;
          }
        });
      }, { rootMargin: '120px' });
      items.forEach(function (it) { io.observe(it.node); });
    }

    var FRAME = 1000 / 30;
    var start = performance.now();
    var last = -FRAME;
    var loop = function (now) {
      raf = requestAnimationFrame(loop);
      if (document.hidden) return;
      if (now - last < FRAME) return;
      last = now;
      var t = now - start;
      for (var j = 0; j < items.length; j++) if (items[j].visible) items[j].draw(t);
    };
    raf = requestAnimationFrame(loop);
  }

  /* ── scroll reveal ───────────────────────────────────────────────────── */

  function mountReveal() {
    var host = document.querySelector('main#top');
    if (!host || !('IntersectionObserver' in window)) return;
    if (reduceMotion) return;
    var targets = Array.prototype.filter.call(
      host.querySelectorAll(':scope > section > div'),
      function (el) { return el.getBoundingClientRect().height > 60; }
    );
    var seen = [];
    var hidden = [];
    var observer = new IntersectionObserver(function (entries) {
      entries.forEach(function (e) {
        if (!e.isIntersecting || seen.indexOf(e.target) !== -1) return;
        seen.push(e.target);
        observer.unobserve(e.target);
        e.target.style.transition = 'opacity 620ms cubic-bezier(0.16,1,0.3,1), transform 620ms cubic-bezier(0.16,1,0.3,1)';
        e.target.style.opacity = '1';
        e.target.style.transform = 'none';
      });
    }, { rootMargin: '0px 0px -8% 0px', threshold: 0.06 });
    targets.forEach(function (el) {
      if (el.getBoundingClientRect().top < window.innerHeight * 0.92) return;
      el.style.opacity = '0';
      el.style.transform = 'translateY(20px)';
      el.style.willChange = 'opacity, transform';
      observer.observe(el);
      hidden.push(el);
    });
    /* safety net: never leave content stuck invisible */
    setTimeout(function () {
      hidden.forEach(function (el) {
        if (el.style.opacity !== '0') return;
        el.style.transition = 'opacity 400ms ease, transform 400ms ease';
        el.style.opacity = '1';
        el.style.transform = 'none';
      });
    }, 6000);
  }

  /* ── nav ─────────────────────────────────────────────────────────────── */

  function mountNav() {
    var menu = $('cw-nav-menu');
    if (!menu) return;
    var close = function () { menu.hidden = true; };
    document.addEventListener('click', function (e) {
      var act = e.target.closest ? e.target.closest('[data-act]') : null;
      if (!act) return;
      if (act.dataset.act === 'toggle-menu') menu.hidden = !menu.hidden;
      if (act.dataset.act === 'close-menu') close();
    });
    /* the desktop/mobile swap itself is a media query; this only makes sure an
       open sheet does not linger when the viewport grows past the breakpoint */
    window.addEventListener('resize', function () {
      if (window.innerWidth >= 1000) close();
    });
  }

  /* ── contact form → mailto ───────────────────────────────────────────── */

  function mountForm() {
    var form = document.querySelector('[data-cw-submit]');
    if (!form) return;
    form.addEventListener('submit', function (e) {
      e.preventDefault();
      var get = function (n) { return form.elements[n] && form.elements[n].value ? form.elements[n].value : ''; };
      var body = 'Name: ' + get('name') + '\nEmail: ' + get('email') + '\nNeed: ' + get('topic') + '\n\n' + get('message');
      window.location.href = 'mailto:hello@crestwardlabs.com?subject='
        + encodeURIComponent('Project inquiry: ' + get('topic'))
        + '&body=' + encodeURIComponent(body);
      var live = $('cw-form-live'), sent = $('cw-form-sent');
      if (live) live.hidden = true;
      if (sent) sent.hidden = false;
    });
  }

  /* ── cookie consent + chat widget ────────────────────────────────────── */

  function mountWidgets() {
    var host = $('cw-widgets');
    if (!host || host.dataset.mounted) return;
    host.dataset.mounted = '1';

    var ACCENT = '#1D5FFA';
    var el = function (tag, css, html) {
      var n = document.createElement(tag);
      if (css) n.style.cssText = css;
      if (html != null) n.innerHTML = html;
      return n;
    };

    /* — cookie banner — */
    var banner = el('div', 'position:fixed;bottom:0;left:0;right:0;z-index:9998;background:#000;color:#fff;border-top:1px solid ' + ACCENT + ';padding:15px clamp(18px,4vw,44px);display:none;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:14px;font-family:Archivo,system-ui,sans-serif;');
    banner.innerHTML = '<p style="margin:0;font-size:12.5px;line-height:1.5;color:rgba(255,255,255,0.6);max-width:62ch;">We use cookies to understand how visitors use this site and improve your experience. <a href="/privacy" style="color:#8fb2ff;text-decoration:underline;">Learn more</a></p>';
    var bActions = el('div', 'display:flex;gap:8px;flex-shrink:0;');
    var decline = el('button', 'font-family:inherit;background:transparent;border:1px solid rgba(255,255,255,0.25);color:rgba(255,255,255,0.7);font-size:10px;font-weight:700;letter-spacing:0.14em;text-transform:uppercase;padding:10px 15px;cursor:pointer;', 'Decline');
    var accept = el('button', 'font-family:inherit;background:' + ACCENT + ';border:1px solid ' + ACCENT + ';color:#fff;font-size:10px;font-weight:700;letter-spacing:0.14em;text-transform:uppercase;padding:10px 17px;cursor:pointer;', 'Accept');
    bActions.appendChild(decline);
    bActions.appendChild(accept);
    banner.appendChild(bActions);
    host.appendChild(banner);

    /* — chat launcher — */
    var btn = el('button', 'position:fixed;bottom:24px;right:24px;z-index:9997;width:54px;height:54px;background:' + ACCENT + ';border:none;color:#fff;cursor:pointer;display:flex;align-items:center;justify-content:center;box-shadow:0 10px 30px rgba(29,95,250,0.45);transition:transform 160ms ease,background 160ms ease;');
    btn.setAttribute('aria-label', 'Open chat');
    btn.innerHTML = '<svg width="23" height="23" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>';
    btn.addEventListener('mouseenter', function () { btn.style.transform = 'translateY(-2px)'; btn.style.background = '#1A4FD0'; });
    btn.addEventListener('mouseleave', function () { btn.style.transform = 'none'; btn.style.background = ACCENT; });
    host.appendChild(btn);

    var narrow = window.innerWidth <= 520;
    var panel = el('div', 'position:fixed;' + (narrow ? 'bottom:0;right:0;left:0;width:100%;height:78vh;' : 'bottom:94px;right:24px;width:372px;height:548px;') + 'z-index:9996;background:#070709;border:1px solid rgba(255,255,255,0.18);display:flex;flex-direction:column;overflow:hidden;box-shadow:0 26px 64px rgba(0,0,0,0.7);opacity:0;transform:translateY(14px);pointer-events:none;transition:opacity 200ms ease,transform 200ms ease;font-family:Archivo,system-ui,sans-serif;');
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-label', 'Crestward Assistant');
    panel.innerHTML =
      '<div style="padding:13px 15px;background:' + ACCENT + ';display:flex;align-items:center;gap:10px;flex-shrink:0;">' +
        '<img src="logo-icon.png" alt="" style="width:26px;height:26px;object-fit:contain;background:#fff;padding:3px;">' +
        '<div style="flex:1;"><div style="font-size:11px;font-weight:700;letter-spacing:0.14em;text-transform:uppercase;color:#fff;">Crestward Assistant</div>' +
        '<div style="font-size:11px;color:rgba(255,255,255,0.78);">Ask anything about our services</div></div>' +
        '<button data-close style="background:transparent;border:none;cursor:pointer;color:rgba(255,255,255,0.85);display:flex;padding:4px;" aria-label="Close chat">' +
        '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg></button>' +
      '</div>' +
      '<div data-messages style="flex:1;overflow-y:auto;padding:16px 14px;display:flex;flex-direction:column;gap:12px;background:#050506;"></div>' +
      '<div style="padding:11px;background:#070709;border-top:1px solid rgba(255,255,255,0.14);display:flex;gap:8px;align-items:flex-end;flex-shrink:0;">' +
        '<textarea data-input rows="1" placeholder="Ask about our services…" aria-label="Message" style="flex:1;font-family:Archivo,system-ui,sans-serif;background:rgba(255,255,255,0.05);border:1px solid rgba(255,255,255,0.16);padding:10px 12px;color:#fff;font-size:13.5px;line-height:1.5;resize:none;outline:none;max-height:104px;"></textarea>' +
        '<button data-mic aria-label="Dictate message" style="width:40px;height:40px;background:transparent;border:1px solid rgba(255,255,255,0.16);color:rgba(255,255,255,0.7);cursor:pointer;display:flex;align-items:center;justify-content:center;flex-shrink:0;transition:background 140ms ease,color 140ms ease,border-color 140ms ease;">' +
        '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><line x1="12" y1="19" x2="12" y2="23"/></svg></button>' +
        '<button data-send aria-label="Send" style="width:40px;height:40px;background:' + ACCENT + ';border:none;cursor:pointer;display:flex;align-items:center;justify-content:center;flex-shrink:0;">' +
        '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg></button>' +
      '</div>' +
      '<div style="text-align:center;padding:7px 0 9px;font-size:9px;font-weight:700;letter-spacing:0.18em;text-transform:uppercase;color:rgba(255,255,255,0.25);background:#070709;">Powered by Crestward Labs</div>';
    host.appendChild(panel);

    var messages = panel.querySelector('[data-messages]');
    var input = panel.querySelector('[data-input]');
    var sendBtn = panel.querySelector('[data-send]');
    var micBtn = panel.querySelector('[data-mic]');

    var API_BASE = 'https://agenthub.smartschema.io/api';
    var API_KEY = 'sk-aJPUyPB7KeBxxA0DW7pv1AQnaHQBfb0IqnwFj0e6RyY';
    var sessionId = null, isStreaming = false, opened = false;

    var md = function (t) {
      return t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
        .replace(/\*(.+?)\*/g, '<em>$1</em>')
        .replace(/`(.+?)`/g, '<code style="background:rgba(29,95,250,0.28);padding:1px 5px;font-size:12px;">$1</code>')
        .replace(/^[-*] (.+)$/gm, '<div style="padding-left:12px;margin:2px 0;">• $1</div>')
        .replace(/\n/g, '<br>');
    };
    var ts = function () { return new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }); };

    function addMsg(role, text) {
      var wrap = el('div', 'display:flex;flex-direction:column;max-width:86%;animation:cw-msg-in 200ms ease both;' + (role === 'user' ? 'align-self:flex-end;align-items:flex-end;' : 'align-self:flex-start;align-items:flex-start;'));
      var bubble = el('div', 'padding:10px 13px;font-size:13.5px;line-height:1.6;white-space:pre-wrap;word-break:break-word;' + (role === 'user' ? 'background:' + ACCENT + ';color:#fff;' : 'background:rgba(255,255,255,0.05);color:rgba(255,255,255,0.9);border:1px solid rgba(255,255,255,0.12);'));
      if (role === 'assistant' && text) bubble.innerHTML = md(text); else bubble.textContent = text;
      var time = el('div', 'font-size:9px;font-weight:700;letter-spacing:0.14em;color:rgba(255,255,255,0.28);margin-top:5px;', ts());
      wrap.appendChild(bubble);
      wrap.appendChild(time);
      messages.appendChild(wrap);
      messages.scrollTop = messages.scrollHeight;
      return bubble;
    }

    function showDots() {
      var d = el('div', 'display:flex;gap:4px;padding:13px;background:rgba(255,255,255,0.05);border:1px solid rgba(255,255,255,0.12);align-self:flex-start;',
        '<span style="width:6px;height:6px;background:' + ACCENT + ';animation:cw-dot 1.2s ease-in-out infinite;"></span>' +
        '<span style="width:6px;height:6px;background:' + ACCENT + ';animation:cw-dot 1.2s ease-in-out 0.2s infinite;"></span>' +
        '<span style="width:6px;height:6px;background:' + ACCENT + ';animation:cw-dot 1.2s ease-in-out 0.4s infinite;"></span>');
      messages.appendChild(d);
      messages.scrollTop = messages.scrollHeight;
      return d;
    }

    async function send(text) {
      if (isStreaming) return;
      isStreaming = true; sendBtn.disabled = true;
      if (!sessionId) {
        try {
          var r = await fetch(API_BASE + '/public/sessions', {
            method: 'POST',
            headers: { 'Authorization': 'Bearer ' + API_KEY, 'Content-Type': 'application/json' },
            body: JSON.stringify({ title: 'Website chat' })
          });
          sessionId = (await r.json()).id;
        } catch (e) {
          addMsg('assistant', 'Connection error. Please email hello@crestwardlabs.com directly.');
          isStreaming = false; sendBtn.disabled = false; return;
        }
      }
      addMsg('user', text);
      var dots = showDots();
      var bubble = null, full = '';
      try {
        var res = await fetch(API_BASE + '/public/sessions/' + sessionId + '/stream', {
          method: 'POST',
          headers: { 'Authorization': 'Bearer ' + API_KEY, 'Content-Type': 'application/json' },
          body: JSON.stringify({ message: text, filter_vars: {} })
        });
        var reader = res.body.getReader();
        var dec = new TextDecoder();
        var buf = '';
        while (true) {
          var chunk = await reader.read();
          if (chunk.done) break;
          buf += dec.decode(chunk.value);
          var lines = buf.split('\n');
          buf = lines.pop() || '';
          for (var i = 0; i < lines.length; i++) {
            var line = lines[i];
            if (line.indexOf('data: ') !== 0) continue;
            var ev;
            try { ev = JSON.parse(line.slice(6)); } catch (err) { continue; }
            if (ev.type === 'delta') {
              if (!bubble) { dots.remove(); bubble = addMsg('assistant', ''); }
              full += ev.content;
              bubble.innerHTML = md(full);
              messages.scrollTop = messages.scrollHeight;
            }
            if (ev.type === 'done' || ev.type === 'error') {
              dots.remove();
              if (ev.type === 'error' && !bubble) addMsg('assistant', 'Something went wrong. Please reach out at hello@crestwardlabs.com');
            }
          }
        }
        dots.remove();
      } catch (e) {
        dots.remove();
        addMsg('assistant', 'Connection lost. Please email hello@crestwardlabs.com directly.');
      }
      isStreaming = false; sendBtn.disabled = false; input.focus();
    }

    var openPanel = function () {
      panel.style.opacity = '1';
      panel.style.transform = 'none';
      panel.style.pointerEvents = 'all';
      btn.style.display = 'none';
      if (!opened) {
        opened = true;
        addMsg('assistant', "Hi! I'm the Crestward Assistant. Ask me anything about **agentic AI systems**, **software engineering**, or **AI workflow automation**.");
      }
      input.focus();
    };
    var closePanel = function () {
      panel.style.opacity = '0';
      panel.style.transform = 'translateY(14px)';
      panel.style.pointerEvents = 'none';
      btn.style.display = 'flex';
    };
    btn.addEventListener('click', openPanel);
    panel.querySelector('[data-close]').addEventListener('click', closePanel);
    sendBtn.addEventListener('click', function () {
      var t = input.value.trim();
      if (!t) return;
      input.value = ''; input.style.height = 'auto';
      send(t);
    });
    input.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendBtn.click(); }
    });
    input.addEventListener('input', function () {
      input.style.height = 'auto';
      input.style.height = Math.min(input.scrollHeight, 104) + 'px';
    });

    /* — speech to text — */
    var SpeechRec = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SpeechRec) {
      micBtn.style.display = 'none';
    } else {
      var recognition = new SpeechRec();
      recognition.lang = 'en-US';
      recognition.continuous = false;
      recognition.interimResults = true;
      var listening = false;
      var savedText = '';
      var sessionTranscript = '';
      var setListening = function (on) {
        micBtn.style.background = on ? ACCENT : 'transparent';
        micBtn.style.borderColor = on ? ACCENT : 'rgba(255,255,255,0.16)';
        micBtn.style.color = on ? '#fff' : 'rgba(255,255,255,0.7)';
      };
      recognition.onstart = function () { sessionTranscript = ''; };
      recognition.onresult = function (e) {
        sessionTranscript = '';
        var interimText = '';
        for (var i = 0; i < e.results.length; i++) {
          if (e.results[i].isFinal) sessionTranscript += e.results[i][0].transcript + ' ';
          else interimText = e.results[i][0].transcript;
        }
        var prefix = savedText ? savedText + ' ' : '';
        input.value = (prefix + sessionTranscript + interimText).trim();
        input.dispatchEvent(new Event('input'));
      };
      recognition.onend = function () {
        if (sessionTranscript) savedText = input.value.trim();
        sessionTranscript = '';
        if (listening) { try { recognition.start(); } catch (err) {} }
        else setListening(false);
      };
      recognition.onerror = function (e) {
        if (e.error === 'no-speech') { if (listening) { try { recognition.start(); } catch (err) {} } return; }
        listening = false;
        setListening(false);
      };
      micBtn.addEventListener('click', function () {
        if (listening) { listening = false; recognition.stop(); }
        else {
          listening = true;
          savedText = input.value.trim();
          setListening(true);
          try { recognition.start(); } catch (err) {}
        }
      });
    }

    /* — consent — */
    var offset = function () {
      var base = window.innerWidth <= 520 ? 16 : 24;
      btn.style.bottom = (banner.style.display === 'flex' ? base + banner.offsetHeight + 8 : base) + 'px';
    };
    var consent = null;
    try { consent = localStorage.getItem('cw_cookie_consent'); } catch (e) { consent = 'declined'; }
    if (!consent) { banner.style.display = 'flex'; setTimeout(offset, 60); }
    window.addEventListener('resize', offset);
    var setConsent = function (v) {
      try { localStorage.setItem('cw_cookie_consent', v); } catch (e) {}
      banner.style.display = 'none';
      offset();
      /* analytics is loaded on acceptance and never before */
      if (v === 'accepted' && typeof window._loadGA === 'function') window._loadGA();
    };
    accept.addEventListener('click', function () { setConsent('accepted'); });
    decline.addEventListener('click', function () { setConsent('declined'); });
  }

  /* ── legacy anchors ──────────────────────────────────────────────────── */

  /* The previous design's section ids. Anything already linking to them — old
     posts, bookmarks, the odd backlink — lands on the closest new section
     instead of at the top of the page with a dead hash. */
  var LEGACY_ANCHORS = { '#orchestration': '#workflows', '#about': '#approach' };

  function redirectLegacyAnchor() {
    var target = LEGACY_ANCHORS[window.location.hash];
    if (!target) return;
    var el = document.querySelector(target);
    if (!el) return;
    history.replaceState(null, '', target);
    el.scrollIntoView();
  }

  /* ── boot ────────────────────────────────────────────────────────────── */

  function boot() {
    redirectLegacyAnchor();
    window.addEventListener('hashchange', redirectLegacyAnchor);
    paint();
    mountReveal();
    mountNav();
    mountForm();
    mountWidgets();
    window.addEventListener('resize', function () {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(paint, 150);
    });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
