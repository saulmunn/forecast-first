// Forecast First — shared engine for all site adapters.
// Runs at document_start in the extension's isolated world.
(() => {
  'use strict';
  const FF = (globalThis.__FF = globalThis.__FF || {});
  if (FF.commonLoaded) return;
  FF.commonLoaded = true;

  FF.VERSION = '0.5.3';
  FF.adapters = [];
  FF.registerAdapter = (adapter) => FF.adapters.push(adapter);

  // ------------------------------------------------------------------ settings & storage
  FF.MAX_REQUIRED = 5; // multi-outcome: never ask for more than this many outcomes
  FF.DEFAULT_SETTINGS = {
    enabled: true,
    maskListings: true,       // blur probabilities on non-question pages (home, search, lists)
    reaskHours: 24,           // after a forecast or reveal, hide and ask again after N hours. 0 = every visit, -1 = stay revealed
    topMassPct: 90,           // multi-outcome: price the fewest likeliest outcomes whose probabilities add up to this much
    defaultResolveDays: 30,   // Fatebook resolveBy fallback when the market has no end date
    fatebookApiKey: '',
    fatebookTags: 'forecast-first',
    fatebookSharePublicly: false,
  };

  FF.getSettings = async () => {
    const [sync, local] = await Promise.all([
      chrome.storage.sync.get(null),
      chrome.storage.local.get(['pausedUntil']),
    ]);
    const s = Object.assign({}, FF.DEFAULT_SETTINGS, sync, { pausedUntil: local.pausedUntil || 0 });
    if (sync.reaskHours == null && sync.skipCooldownHours != null) s.reaskHours = sync.skipCooldownHours; // pre-0.4 setting
    return s;
  };
  FF.getMarketState = async (key) => {
    const k = 'm:' + key;
    return (await chrome.storage.local.get(k))[k] || null;
  };
  FF.setMarketState = (key, state) => chrome.storage.local.set({ ['m:' + key]: state });
  FF.clearMarketState = (key) => chrome.storage.local.remove('m:' + key);
  FF.appendForecast = async (entry) => {
    const { forecasts = [] } = await chrome.storage.local.get('forecasts');
    forecasts.push(entry);
    await chrome.storage.local.set({ forecasts });
  };
  FF.updateForecast = async (id, patch) => {
    const { forecasts = [] } = await chrome.storage.local.get('forecasts');
    const i = forecasts.findIndex((f) => f.id === id);
    if (i < 0) return;
    Object.assign(forecasts[i], patch);
    await chrome.storage.local.set({ forecasts });
  };

  FF.bg = (msg) =>
    new Promise((resolve, reject) => {
      try {
        chrome.runtime.sendMessage(msg, (res) => {
          if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
          if (!res) return reject(new Error('No response from background'));
          if (res.ok === false) return reject(new Error(res.error || 'Unknown error'));
          resolve(res);
        });
      } catch (e) {
        reject(e);
      }
    });
  FF.fetchJson = async (url) => (await FF.bg({ type: 'fetchJson', url })).data;

  // ------------------------------------------------------------------ utilities
  const U = (FF.util = {
    uuid: () => (crypto.randomUUID ? crypto.randomUUID() : Date.now() + '-' + Math.random().toString(16).slice(2)),
    clamp: (n, a, b) => Math.min(b, Math.max(a, n)),
    round1: (n) => Math.round(n * 10) / 10,
    fmtPct(p) {
      if (p == null || Number.isNaN(Number(p))) return '—';
      const r = U.round1(Number(p));
      return (Number.isInteger(r) ? String(r) : r.toFixed(1)) + '%';
    },
    // Full ISO datetime, so Fatebook gets the site's exact resolution time (a bare date would mean 00:00 UTC).
    toDateStr(iso) {
      if (!iso) return null;
      const d = new Date(iso);
      if (Number.isNaN(d.getTime())) return null;
      return d.toISOString();
    },
    todayPlus(days) {
      const d = new Date();
      d.setDate(d.getDate() + Number(days || 0));
      return d.toISOString().slice(0, 10);
    },
    cleanTitle(s) {
      return String(s || '')
        .replace(/\s+/g, ' ')
        .replace(/\s*[|·-]\s*(Polymarket|Kalshi|Metaculus|Manifold).*$/i, '')
        .replace(/\s*(Trading Odds & Predictions|Odds & Predictions).*$/i, '')
        .trim();
    },
    pageTitle() {
      const h1 = document.querySelector('main h1, h1');
      const t = h1 && h1.textContent.trim();
      return U.cleanTitle(t && t.length > 3 ? t : document.title);
    },
    growWhile(el, pred, maxSteps = 8) {
      let cur = el;
      for (let i = 0; i < maxSteps && cur && cur.parentElement && cur.parentElement !== document.body; i++) {
        const p = cur.parentElement;
        if (!pred(p, cur)) break;
        cur = p;
      }
      return cur;
    },
    commonAncestor(a, b) {
      if (!a) return b;
      if (!b) return a;
      const anc = new Set();
      for (let n = a; n; n = n.parentElement) anc.add(n);
      for (let n = b; n; n = n.parentElement) if (anc.has(n)) return n;
      return null;
    },
    // "▲ 8 higher" / "▼ 3.5 lower" / "= same"
    diffLabel(you, actual) {
      const pts = U.round1(you - actual);
      const abs = Math.abs(pts);
      if (abs < 0.5) return { text: '= same', dir: 0 };
      const n = Number.isInteger(abs) ? String(abs) : abs.toFixed(1);
      return { text: (pts > 0 ? '▲ ' : '▼ ') + n + (pts > 0 ? ' higher' : ' lower'), dir: pts > 0 ? 1 : -1 };
    },
  });

  // Small monochrome "eye off" icon (currentColor), used instead of an emoji.
  FF.icon = () => {
    const ns = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(ns, 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('fill', 'none');
    svg.setAttribute('stroke', 'currentColor');
    svg.setAttribute('stroke-width', '2');
    svg.setAttribute('stroke-linecap', 'round');
    svg.setAttribute('stroke-linejoin', 'round');
    svg.setAttribute('class', 'ff-icon');
    svg.setAttribute('aria-hidden', 'true');
    for (const d of ['M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94', 'M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19', 'M14.12 14.12a3 3 0 1 1-4.24-4.24', 'M1 1l22 22']) {
      const p = document.createElementNS(ns, 'path');
      p.setAttribute('d', d);
      svg.appendChild(p);
    }
    return svg;
  };

  // Tiny DOM builder: h('div.cls', {attr}, children...)
  const h = (FF.h = (spec, attrs, ...children) => {
    const [tag, ...classes] = spec.split('.');
    const el = document.createElement(tag || 'div');
    if (classes.length) el.className = classes.join(' ');
    if (attrs && typeof attrs === 'object' && !(attrs instanceof Node) && !Array.isArray(attrs)) {
      for (const [k, v] of Object.entries(attrs)) {
        if (v == null || v === false) continue;
        if (k === 'text') el.textContent = v;
        else if (k === 'style') el.style.cssText = v;
        else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
        else if (k === 'value') el.value = v;
        else el.setAttribute(k, v === true ? '' : v);
      }
    } else if (attrs != null) {
      children.unshift(attrs);
    }
    for (const c of children.flat()) {
      if (c == null || c === false) continue;
      el.appendChild(c instanceof Node ? c : document.createTextNode(String(c)));
    }
    return el;
  });

  // ------------------------------------------------------------------ token masking
  // Masks "17%", "<1%", "84¢" everywhere in the page using the CSS Custom Highlight API,
  // so we never touch the site's DOM text (React-safe). Falls back to marking leaf elements.
  FF.mask = (() => {
    const TOKEN = /(?:<\s*)?\d+(?:[.,]\d+)?\s?[%¢]/g;
    // A node holding only the unit: "%", "¢", or Kalshi's payout "x" (rendered as <span>2.52</span>x).
    const BARE = /^\s*[%¢x×]\s*$/;
    const NUMERIC = /^\s*<?\s*\d+(?:[.,]\d+)?\s*$/;
    // Change badges: "▲ 5", "↓12", "+3%" next to an arrow glyph — they give the day's move away.
    const DELTA = /[▲▼△▽↑↓⬆⬇]\s?[+\-\u2212]?\d+(?:[.,]\d+)?%?|[+\-\u2212]?\d+(?:[.,]\d+)?%?\s?[▲▼△▽↑↓⬆⬇]/g;
    const supported = typeof CSS !== 'undefined' && CSS.highlights && typeof Highlight !== 'undefined';
    let active = false;
    let observer = null;
    let timer = 0;
    let opts = {};
    const marked = new Set();
    const veiled = new Set();

    // Graphics that encode the probability without text: charts, gauges, sparklines, proportional bars.
    const SKIP_ANCESTORS = 'header, nav, footer, button, [role="button"], ff-root';
    const sat = (c) => { const mx = Math.max(c[0], c[1], c[2]), mn = Math.min(c[0], c[1], c[2]); return mx === 0 ? 0 : (mx - mn) / mx; };
    function leakyGraphics() {
      const out = new Set();
      for (const el of document.querySelectorAll('svg, canvas')) {
        if (el.closest(SKIP_ANCESTORS)) continue;
        const r = el.getBoundingClientRect();
        if (r.width >= 48 && r.height >= 30) out.add(el);
      }
      // Thin, saturated, width-styled bars (e.g. a coloured underline whose length is the probability).
      for (const el of document.querySelectorAll('[style*="width"]')) {
        if (el.tagName === 'SVG' || el.closest(SKIP_ANCESTORS)) continue;
        const r = el.getBoundingClientRect();
        if (r.height < 1 || r.height > 8 || r.width < 24 || r.width > 600) continue;
        const bg = FF.theme.parse(getComputedStyle(el).backgroundColor);
        if (bg && bg[3] > 0.5 && sat(bg) > 0.35) out.add(el);
      }
      if (typeof opts.graphics === 'function') {
        try { for (const el of opts.graphics() || []) if (el) out.add(el); } catch (_) {}
      }
      return out;
    }
    function applyVeil() {
      const want = leakyGraphics();
      for (const el of veiled) if (!want.has(el)) { el.removeAttribute('data-ff-veil'); veiled.delete(el); }
      for (const el of want) if (!veiled.has(el)) { el.setAttribute('data-ff-veil', ''); veiled.add(el); }
    }

    const near = (a, b) => {
      const pa = a.parentElement, pb = b.parentElement;
      if (!pa || !pb) return false;
      return pa === pb || pa.parentElement === pb || pb.parentElement === pa || pa.parentElement === pb.parentElement;
    };

    function scan() {
      timer = 0;
      if (!active || !document.body) return;
      const ranges = [];
      const odo = [];
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
        acceptNode(n) {
          const p = n.parentElement;
          if (!p) return NodeFilter.FILTER_REJECT;
          const tag = p.tagName;
          if (tag === 'SCRIPT' || tag === 'STYLE' || tag === 'NOSCRIPT' || tag === 'TEXTAREA' || tag === 'INPUT') return NodeFilter.FILTER_REJECT;
          return /\S/.test(n.data) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP;
        },
      });
      const extra = [DELTA].concat(Array.isArray(opts.patterns) ? opts.patterns : []);
      let prev = null, node;
      while ((node = walker.nextNode())) {
        const d = node.data;
        for (const re of extra) {
          re.lastIndex = 0;
          let m;
          while ((m = re.exec(d))) {
            const r = new Range();
            r.setStart(node, m.index);
            r.setEnd(node, m.index + m[0].length);
            ranges.push(r);
            if (!re.global) break;
          }
        }
        if (/[%¢]/.test(d) || BARE.test(d)) {
          if (BARE.test(d)) {
            const r = new Range();
            if (prev && NUMERIC.test(prev.data) && near(prev, node)) r.setStart(prev, 0);
            else r.setStart(node, 0);
            r.setEnd(node, d.length);
            ranges.push(r);
            // Odometer-style displays (every digit is its own node): blank the whole container instead.
            const par = node.parentElement;
            if (/%/.test(d) && par && par.childNodes.length > 2 && par.textContent.length > 6 && /^[\d.,\s]+%$/.test(par.textContent)) odo.push(par);
          } else {
            TOKEN.lastIndex = 0;
            let m;
            while ((m = TOKEN.exec(d))) {
              const r = new Range();
              r.setStart(node, m.index);
              r.setEnd(node, m.index + m[0].length);
              ranges.push(r);
            }
            if (/^\s*[%¢]/.test(d) && prev && NUMERIC.test(prev.data) && near(prev, node)) {
              const r = new Range();
              r.setStart(prev, 0);
              r.setEnd(node, d.search(/[%¢]/) + 1);
              ranges.push(r);
            }
          }
        }
        prev = node;
      }
      applyVeil();
      if (supported) {
        for (const el of marked) el.removeAttribute('data-ff-mask');
        marked.clear();
        CSS.highlights.set('ff-mask', new Highlight(...ranges));
      } else {
        for (const el of marked) el.removeAttribute('data-ff-mask');
        marked.clear();
        for (const r of ranges) {
          const el = r.startContainer.parentElement;
          if (el && el.textContent.length < 40) { el.setAttribute('data-ff-mask', ''); marked.add(el); }
        }
      }
      // Change badges drawn as an icon plus a number ("<svg arrow/> 12" in a red or green pill): blank the pill.
      const BADGE_NUM = /^\s*[+\-\u2212]?\d+(?:[.,]\d+)?%?\s*$/;
      for (const svg of document.querySelectorAll('svg')) {
        const sr = svg.getBoundingClientRect();
        if (sr.width < 6 || sr.width > 28 || sr.height > 28 || svg.closest(SKIP_ANCESTORS)) continue;
        const chain = [];
        for (let el = svg.parentElement, i = 0; el && i < 3; el = el.parentElement, i++) {
          if (!BADGE_NUM.test(el.textContent)) break;
          if (el.getBoundingClientRect().width > 110) break;
          chain.push(el);
        }
        const box = chain[chain.length - 1];
        if (!box || box.hasAttribute('data-ff-mask')) continue;
        // Red/green anywhere in the pill (text or background) is what marks it as a change, not a count.
        const colored = chain.some((el) => {
          const cs = getComputedStyle(el);
          const fg = FF.theme.parse(cs.color), bg = FF.theme.parse(cs.backgroundColor);
          return (fg && fg[3] > 0.3 && sat(fg) > 0.3) || (bg && bg[3] > 0.2 && sat(bg) > 0.25);
        });
        if (colored) odo.push(box);
      }
      // The page's own price inputs (Kalshi's "Limit price 20 ¢") carry the market value as a value, not text.
      for (const inp of document.querySelectorAll('input[type=text], input[type=number], input:not([type])')) {
        if (!/^\s*\d+(?:[.,]\d+)?\s*$/.test(inp.value || '')) continue;
        const near = ((inp.nextElementSibling && inp.nextElementSibling.textContent) || '') + ((inp.parentElement && inp.parentElement.textContent) || '');
        const label = (inp.getAttribute('aria-label') || '') + ' ' + (inp.placeholder || '') + ' ' + (inp.name || '');
        if (/[¢%]/.test(near) || /price|odds|chance|probab/i.test(label)) odo.push(inp);
      }
      for (const el of odo) if (!marked.has(el)) { el.setAttribute('data-ff-mask', ''); marked.add(el); }
    }
    const schedule = () => { if (active && !timer) timer = setTimeout(scan, 80); };

    return {
      get active() { return active; },
      start(options) {
        opts = options || {};
        if (active) { scan(); return; }
        active = true;
        if (!document.getElementById('ff-mask-style')) {
          const st = document.createElement('style');
          st.id = 'ff-mask-style';
          st.textContent = '::highlight(ff-mask){color:transparent;-webkit-text-fill-color:transparent;background-color:rgba(128,128,128,.35)}[data-ff-veil]{visibility:hidden!important}';
          (document.head || document.documentElement).appendChild(st);
        }
        scan();
        observer = new MutationObserver(schedule);
        observer.observe(document.documentElement, { childList: true, subtree: true, characterData: true });
      },
      stop() {
        if (!active) return;
        active = false;
        if (observer) observer.disconnect();
        observer = null;
        if (timer) clearTimeout(timer);
        timer = 0;
        if (supported) CSS.highlights.delete('ff-mask');
        for (const el of marked) el.removeAttribute('data-ff-mask');
        marked.clear();
        for (const el of veiled) el.removeAttribute('data-ff-veil');
        veiled.clear();
        opts = {};
      },
      rescan: schedule,
    };
  })();

  // ------------------------------------------------------------------ theme sampling
  // Reads the host page's font, colors, button and input styling so our UI looks native.
  FF.theme = (() => {
    let cv = null, cx = null;
    const cache = new Map();
    function parse(str) {
      if (!str) return null;
      if (cache.has(str)) return cache.get(str);
      let out = null;
      try {
        if (!cx) { cv = document.createElement('canvas'); cv.width = cv.height = 1; cx = cv.getContext('2d', { willReadFrequently: true }); }
        cx.fillStyle = 'rgba(0, 0, 0, 0)';
        cx.fillStyle = str;
        if (cx.fillStyle === 'rgba(0, 0, 0, 0)') out = [0, 0, 0, 0];
        else {
          cx.clearRect(0, 0, 1, 1);
          cx.fillRect(0, 0, 1, 1);
          const d = cx.getImageData(0, 0, 1, 1).data;
          out = [d[0], d[1], d[2], d[3] / 255];
        }
      } catch (_) { out = null; }
      cache.set(str, out);
      return out;
    }
    const lum = (c) => {
      const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
      return 0.2126 * f(c[0]) + 0.7152 * f(c[1]) + 0.0722 * f(c[2]);
    };
    const sat = (c) => {
      const r = c[0] / 255, g = c[1] / 255, b = c[2] / 255, max = Math.max(r, g, b), min = Math.min(r, g, b), l = (max + min) / 2;
      if (max === min) return { s: 0, l };
      const d = max - min;
      return { s: l > 0.5 ? d / (2 - max - min) : d / (max + min), l };
    };
    const mix = (a, b, t) => [0, 1, 2].map((i) => Math.round(a[i] + (b[i] - a[i]) * t)).concat([1]);
    const rgb = (c, a) => `rgba(${c[0]}, ${c[1]}, ${c[2]}, ${a == null ? (c[3] == null ? 1 : c[3]) : a})`;
    const visible = (el) => { const r = el.getBoundingClientRect(); return r.width > 30 && r.height > 14; };
    function bgOf(el) {
      for (let n = el; n && n.nodeType === 1; n = n.parentElement) {
        const c = parse(getComputedStyle(n).backgroundColor);
        if (c && c[3] > 0.05) return c;
      }
      return null;
    }
    function saturatedButton() {
      let best = null;
      const cands = document.querySelectorAll('button, a, [role="button"]');
      for (let i = 0; i < cands.length && i < 400; i++) {
        const el = cands[i];
        if (!visible(el)) continue;
        const c = parse(getComputedStyle(el).backgroundColor);
        if (!c || c[3] < 0.9) continue;
        const { s, l } = sat(c);
        if (s < 0.35 || l < 0.2 || l > 0.75) continue;
        const r = el.getBoundingClientRect();
        const score = s * 2 + Math.min(r.width * r.height, 20000) / 20000;
        if (!best || score > best.score) best = { score, el };
      }
      return best && best.el;
    }
    const capPx = (r, max) => { const n = parseFloat(r); return (Number.isFinite(n) ? Math.min(n, max) : max) + 'px'; };

    function sample(adapter, anchor) {
      const hints = (adapter && adapter.theme) || {};
      const bodyCs = getComputedStyle(document.body || document.documentElement);
      const prefersDark = matchMedia('(prefers-color-scheme: dark)').matches;
      let base = bgOf(anchor || document.body) || parse(getComputedStyle(document.documentElement).backgroundColor);
      if (!base || base[3] < 0.05) base = prefersDark ? [17, 17, 17, 1] : [255, 255, 255, 1];
      base = [base[0], base[1], base[2], 1];
      const dark = lum(base) < 0.4;
      let fg = parse(bodyCs.color);
      if (!fg || fg[3] < 0.3) fg = dark ? [255, 255, 255, 1] : [20, 20, 20, 1];
      fg = [fg[0], fg[1], fg[2], 1];

      let btnEl = null;
      try { btnEl = hints.primaryButton ? hints.primaryButton() : null; } catch (_) {}
      if (btnEl && !visible(btnEl)) btnEl = null;
      if (!btnEl) btnEl = saturatedButton();
      const fallbackAccent = parse(hints.accent || '#5b6cff') || [91, 108, 255, 1];
      let btn = { bg: null, fg: null, radius: '10px', weight: '600', size: '14px' };
      if (btnEl) {
        const cs = getComputedStyle(btnEl);
        const bg = parse(cs.backgroundColor);
        if (bg && bg[3] > 0.8) {
          btn = { bg, fg: parse(cs.color), radius: cs.borderRadius, weight: cs.fontWeight, size: cs.fontSize };
        }
      }
      if (!btn.bg) btn.bg = fallbackAccent;
      if (!btn.fg || btn.fg[3] < 0.5) btn.fg = lum(btn.bg) > 0.5 ? [0, 0, 0, 1] : [255, 255, 255, 1];
      const accent = sat(btn.bg).s > 0.3 ? btn.bg : fallbackAccent;

      const inp = { bg: mix(base, fg, dark ? 0.1 : 0.04), border: [fg[0], fg[1], fg[2], 0.16], radius: '10px' };
      const inpEl = [...document.querySelectorAll('input[type="text"], input[type="search"], input[type="number"], input:not([type])')].find(visible);
      if (inpEl) {
        const cs = getComputedStyle(inpEl);
        const bg = parse(cs.backgroundColor), bd = parse(cs.borderColor);
        inp.radius = cs.borderRadius;
        if (bg && bg[3] > 0.03) inp.bg = bg;
        if (bd && bd[3] > 0.05 && cs.borderStyle !== 'none' && parseFloat(cs.borderWidth) > 0) inp.border = bd;
      }

      return {
        dark,
        font: bodyCs.fontFamily || 'system-ui, sans-serif',
        fg: rgb(fg), muted: rgb(fg, 0.62), faint: rgb(fg, 0.38), stripe: rgb(fg, dark ? 0.045 : 0.06),
        base: rgb(base), surface: rgb(mix(base, fg, dark ? 0.06 : 0.025)), surface2: rgb(mix(base, fg, dark ? 0.11 : 0.06)),
        border: rgb(fg, 0.12), accent: rgb(accent), accentSoft: rgb(accent, 0.22),
        btnBg: rgb(btn.bg), btnFg: rgb(btn.fg), btnRadius: capPx(btn.radius, 999), btnWeight: String(btn.weight || 600), btnSize: btn.size || '14px',
        inputBg: rgb(inp.bg), inputBorder: rgb(inp.border), inputRadius: capPx(inp.radius, 999),
        panelRadius: hints.panelRadius || '14px',
        shadow: dark ? '0 12px 36px rgba(0,0,0,.45)' : '0 12px 36px rgba(0,0,0,.14)',
      };
    }
    return { parse, sample };
  })();

  // ------------------------------------------------------------------ overlay UI (shadow DOM)
  const UI_CSS = `
    :host { all: initial; }
    * { box-sizing: border-box; }
    .layer { position: absolute; top: 0; left: 0; width: 0; height: 0; overflow: visible; }
    .ff-cover, .ff-panel, .ff-card, .ff-badge, .ff-chip, .ff-slot {
      font-family: var(--ff-font); font-size: 14px; line-height: 1.4; color: var(--ff-fg);
      pointer-events: auto; -webkit-font-smoothing: antialiased;
    }
    .ff-cover {
      position: absolute; z-index: 1; border-radius: var(--ff-panel-radius);
      background: repeating-linear-gradient(135deg, var(--ff-stripe) 0 6px, transparent 6px 14px), var(--ff-surface);
      border: 1px solid var(--ff-border);
    }
    .ff-cover.small { border-radius: 8px; }
    .ff-slot { position: absolute; z-index: 2; }
    /* opaque, so the striped cover underneath never shows through; the % sits inside the field */
    .ff-slot input[type=number] {
      width: 100%; height: 100%; text-align: right; padding: 2px 24px 2px 8px; font-size: 14px; font-weight: 600;
      background-color: var(--ff-surface); background-image: linear-gradient(var(--ff-input-bg), var(--ff-input-bg));
    }
    .ff-slot .pct { position: absolute; right: 9px; top: 50%; transform: translateY(-50%); color: var(--ff-muted); font-size: 13px; pointer-events: none; }
    .ff-slot.req input[type=number] { border-color: var(--ff-accent); box-shadow: 0 0 0 2px var(--ff-accent-soft); }
    .ff-hint { font-size: 12px; color: var(--ff-muted); white-space: nowrap; }
    .ff-sum { font-size: 12px; color: var(--ff-muted); font-variant-numeric: tabular-nums; white-space: nowrap; }
    .ff-sum.over { color: #f87171; }
    .ff-panel {
      position: absolute; z-index: 2; padding: 10px 12px;
      background: var(--ff-surface); border: 1px solid var(--ff-border); border-radius: var(--ff-panel-radius);
      box-shadow: var(--ff-shadow); max-width: calc(100vw - 24px);
    }
    .ff-panel.fixed { position: fixed; left: 50%; bottom: 18px; transform: translateX(-50%); }
    .ff-panel.fixed .ff-arrow { display: none; }
    .ff-form { display: flex; align-items: center; gap: 10px; }
    .ff-form.multi { flex-direction: column; align-items: stretch; gap: 6px; max-height: min(70vh, 520px); overflow: auto; }
    .ff-form.multi > .ff-foot, .ff-form.multi > .ff-row:first-child { position: sticky; background: var(--ff-surface); z-index: 1; }
    .ff-form.multi > .ff-row:first-child { top: 0; }
    .ff-form.multi > .ff-foot { bottom: 0; padding-top: 4px; }
    .ff-extra { display: flex; flex-direction: column; gap: 6px; margin-top: 4px; }
    .ff-extra .ff-row { justify-content: space-between; }
    .ff-form.multi > .ff-extra { order: -1; margin: 0 0 4px; }
    .ff-form.multi > .ff-ctl { justify-content: flex-end; }
    .ff-form.multi > .ff-ctl .ff-hint { margin-right: auto; }
    .ff-form.multi .ff-row { justify-content: space-between; }
    .ff-form.multi .ff-foot { margin-top: 6px; justify-content: flex-end; }
    [hidden] { display: none !important; }
    .ff-icon { width: 15px; height: 15px; display: block; opacity: .8; }
    .ff-name { color: var(--ff-fg); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 260px; }
    .ff-num { display: flex; align-items: center; gap: 4px; }
    .ff-num input { width: 68px; text-align: right; }
    .ff-num .pct { color: var(--ff-muted); }
    input[type=number], input[type=text], textarea {
      font: inherit; color: var(--ff-fg); background: var(--ff-input-bg);
      border: 1px solid var(--ff-input-border); border-radius: var(--ff-input-radius); padding: 6px 10px; outline: none;
    }
    input:focus, textarea:focus { border-color: var(--ff-accent); box-shadow: 0 0 0 3px var(--ff-accent-soft); }
    input::placeholder, textarea::placeholder { color: var(--ff-faint); }
    input[type=number]::-webkit-inner-spin-button, input[type=number]::-webkit-outer-spin-button { -webkit-appearance: none; margin: 0; }
    input[type=number] { -moz-appearance: textfield; appearance: textfield; }
    input.ff-free { width: 220px; }
    textarea { width: 100%; min-height: 52px; resize: vertical; display: block; border-radius: min(var(--ff-input-radius), 10px); }
    button { font: inherit; cursor: pointer; border: 1px solid transparent; border-radius: var(--ff-btn-radius); padding: 7px 14px; font-weight: var(--ff-btn-weight); }
    button.primary { background: var(--ff-btn-bg); color: var(--ff-btn-fg); }
    button.primary:hover { filter: brightness(1.08); }
    button.primary:disabled { opacity: .5; cursor: default; filter: none; }
    button.link { background: none; color: var(--ff-muted); padding: 6px 6px; font-weight: 500; }
    button.link:hover { color: var(--ff-fg); }
    button.ff-x { position: absolute; top: 6px; right: 6px; background: none; color: var(--ff-muted); font-size: 18px; line-height: 1; padding: 2px 6px; }
    button.ff-x:hover { color: var(--ff-fg); }
    .ff-row { display: flex; align-items: center; gap: 10px; }
    .ff-foot { display: flex; align-items: center; gap: 8px; }
    .ff-status { font-size: 12px; color: var(--ff-muted); }
    .ff-status.err { color: #f87171; }
    .ff-shake { animation: ffshake .25s; }
    @keyframes ffshake { 25% { transform: translateX(-3px); } 75% { transform: translateX(3px); } }
    .ff-card {
      position: fixed; z-index: 3; right: 18px; bottom: 18px; width: 360px; max-width: calc(100vw - 24px);
      max-height: calc(100vh - 36px); overflow: auto; padding: 14px 16px 12px;
      background: var(--ff-surface); border: 1px solid var(--ff-border); border-radius: var(--ff-panel-radius); box-shadow: var(--ff-shadow);
    }
    .ff-cmp { display: flex; align-items: baseline; gap: 16px; padding-right: 18px; }
    .ff-cmp .stat { display: flex; flex-direction: column; }
    .ff-cmp .lbl { font-size: 11px; text-transform: uppercase; letter-spacing: .06em; color: var(--ff-muted); }
    .ff-cmp .val { font-size: 22px; font-weight: 700; color: var(--ff-fg); line-height: 1.15; font-variant-numeric: tabular-nums; }
    .ff-cmp .diff { margin-left: auto; font-weight: 600; color: var(--ff-accent); white-space: nowrap; }
    .ff-cmp .diff.same { color: var(--ff-muted); }
    .ff-outcome { font-size: 12px; color: var(--ff-muted); margin: 8px 0 0; }
    .ff-outcome + .ff-cmp .val { font-size: 18px; }
    .ff-card textarea { margin-top: 10px; }
    .ff-card .ff-foot { margin-top: 8px; }
    .ff-foot .grow { flex: 1; min-width: 0; }
    .ff-fb { font-size: 12px; color: var(--ff-muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .ff-fb a { color: var(--ff-accent); text-decoration: none; }
    .ff-fb .err { color: #f87171; white-space: normal; }
    .ff-badge {
      position: fixed; z-index: 3; left: 14px; bottom: 14px; display: flex; align-items: center; gap: 4px;
      padding: 4px 6px 4px 10px; border-radius: 999px; background: var(--ff-surface); border: 1px solid var(--ff-border);
      box-shadow: var(--ff-shadow); font-size: 12px; color: var(--ff-muted);
    }
    .ff-badge button.link { padding: 2px 8px; font-size: 12px; }
    .ff-badge .ff-icon { margin-right: 2px; }
    /* "Forecast again" chip: sits in the chart region's top-right corner once the question is revealed. */
    .ff-chip { position: absolute; z-index: 2; white-space: nowrap; }
    .ff-chip.fixed { position: fixed; left: 14px; bottom: 14px; top: auto; }
    .ff-chip-inner { display: inline-flex; align-items: stretch; background: var(--ff-surface); border: 1px solid var(--ff-border); border-radius: 999px; box-shadow: 0 1px 4px rgba(0,0,0,.14); overflow: hidden; }
    .ff-chip-inner button { display: inline-flex; align-items: center; gap: 6px; padding: 4px 10px; font-size: 12px; font-weight: 500; color: var(--ff-muted); background: none; border: 0; border-radius: 0; line-height: 1.3; }
    .ff-chip-inner button:hover { color: var(--ff-fg); background: var(--ff-surface2); }
    .ff-chip-inner button + button { border-left: 1px solid var(--ff-border); padding-left: 9px; }
    .ff-chip-inner .ff-icon { width: 14px; height: 14px; }
    .ff-sw { position: relative; width: 22px; height: 12px; border-radius: 999px; background: var(--ff-faint); transition: background .15s; flex: none; }
    .ff-sw .knob { position: absolute; top: 2px; left: 2px; width: 8px; height: 8px; border-radius: 50%; background: #fff; box-shadow: 0 0 1px rgba(0,0,0,.4); transition: left .15s; }
    .ff-daily.on { color: var(--ff-fg); }
    .ff-daily.on .ff-sw { background: var(--ff-accent); }
    .ff-daily.on .ff-sw .knob { left: 12px; }
  `;

  FF.ui = (() => {
    let host = null, shadow = null, layer = null, raf = 0, slow = 0, ro = null;
    const covers = new Map(); // target Element -> cover Element
    const slots = new Map();  // target Element -> { el, input, key, name }
    let panel = null;         // { el, anchor }
    let card = null;
    let badge = null;
    let chip = null;          // { el, anchor, spot, spotAt } — "forecast again" chip on revealed pages
    const resizeListeners = new Set();
    // Sticky/fixed page bars (headers, bottom navs): overlays get clipped where they'd paint over them.
    let bars = [], barsAt = 0;
    function refreshBars() {
      barsAt = performance.now();
      const vw = window.innerWidth, vh = window.innerHeight;
      const next = [];
      for (const el of document.querySelectorAll('header, nav, [class*="sticky" i], [class*="fixed" i], [style*="sticky" i], [style*="fixed" i]')) {
        if (el.tagName === 'FF-ROOT') continue;
        const pos = getComputedStyle(el).position;
        if (pos !== 'fixed' && pos !== 'sticky') continue;
        const r = el.getBoundingClientRect();
        if (r.width < vw * 0.5 || r.height < 8 || r.height > 220) continue;
        if (r.top < 220) next.push({ top: false, edge: r.bottom });
        else if (r.bottom > vh - 220) next.push({ top: true, edge: r.top });
      }
      bars = next;
    }
    function clipTo(el, r) {
      let cutTop = 0, cutBottom = 0;
      for (const b of bars) {
        if (!b.top && b.edge > r.top) cutTop = Math.max(cutTop, b.edge - r.top);
        if (b.top && b.edge < r.bottom) cutBottom = Math.max(cutBottom, r.bottom - b.edge);
      }
      const v = cutTop || cutBottom ? `inset(${Math.min(cutTop, r.height)}px 0 ${Math.min(cutBottom, r.height)}px 0)` : '';
      if (el.style.clipPath !== v) el.style.clipPath = v;
    }

    function ensure() {
      if (!host) {
        host = document.createElement('ff-root');
        host.style.cssText = 'position:absolute;top:0;left:0;width:0;height:0;overflow:visible;z-index:2147483646;pointer-events:none;';
        shadow = host.attachShadow({ mode: 'open' });
        shadow.appendChild(h('style', { text: UI_CSS }));
        layer = h('div.layer');
        shadow.appendChild(layer);
        applyTheme(null);
        window.addEventListener('resize', onResize, { passive: true });
        window.addEventListener('orientationchange', onResize, { passive: true });
      }
      if (!host.isConnected) (document.body || document.documentElement).appendChild(host);
      if (!raf) raf = requestAnimationFrame(tick);
      // rAF pauses in background tabs; keep positions roughly current there too.
      if (!slow) slow = setInterval(() => { if (covers.size || panel || card || badge || chip) tick(); else { clearInterval(slow); slow = 0; } }, 400);
    }
    function onResize() { tick(); for (const fn of resizeListeners) { try { fn(); } catch (_) {} } }
    function applyTheme(t) {
      if (!host) return;
      const T = Object.assign({
        font: 'system-ui, -apple-system, sans-serif', fg: '#e8eaf0', muted: 'rgba(232,234,240,.62)', faint: 'rgba(232,234,240,.38)', stripe: 'rgba(255,255,255,.045)',
        base: '#111', surface: '#1b1d24', surface2: '#242731', border: 'rgba(255,255,255,.12)', accent: '#5b6cff', accentSoft: 'rgba(91,108,255,.22)',
        btnBg: '#5b6cff', btnFg: '#fff', btnRadius: '10px', btnWeight: '600', btnSize: '14px',
        inputBg: 'rgba(255,255,255,.08)', inputBorder: 'rgba(255,255,255,.16)', inputRadius: '10px', panelRadius: '14px', shadow: '0 12px 36px rgba(0,0,0,.45)',
      }, t || {});
      const map = {
        font: 'font', fg: 'fg', muted: 'muted', faint: 'faint', stripe: 'stripe', base: 'base', surface: 'surface', surface2: 'surface2', border: 'border',
        accent: 'accent', accentSoft: 'accent-soft', btnBg: 'btn-bg', btnFg: 'btn-fg', btnRadius: 'btn-radius', btnWeight: 'btn-weight', btnSize: 'btn-size',
        inputBg: 'input-bg', inputBorder: 'input-border', inputRadius: 'input-radius', panelRadius: 'panel-radius', shadow: 'shadow',
      };
      for (const [k, name] of Object.entries(map)) host.style.setProperty('--ff-' + name, String(T[k]));
    }
    // Inputs that replace the numbers of one list share an edge, so "9%" and "20%" don't jitter them:
    // whichever edge the site aligns the numbers on (Kalshi: left) is the edge the inputs keep.
    function alignSlots() {
      const groups = new Map();
      for (const [t, slot] of slots) {
        slot.align = null;
        const g = slot.kind === 'pct' && slot.row && slot.row.parentElement;
        if (!g || !t.isConnected) continue;
        if (!groups.has(g)) groups.set(g, []);
        groups.get(g).push({ slot, r: t.getBoundingClientRect() });
      }
      for (const list of groups.values()) {
        const seen = list.filter((x) => x.r.width >= 2);
        if (seen.length < 2) continue;
        const lefts = seen.map((x) => x.r.left), rights = seen.map((x) => x.r.right);
        const spreadL = Math.max(...lefts) - Math.min(...lefts), spreadR = Math.max(...rights) - Math.min(...rights);
        const align = spreadL <= 2 && spreadL <= spreadR ? 'left' : spreadR <= 2 ? 'right' : null;
        for (const x of list) x.slot.align = align;
      }
    }
    function placeSlot(slot, target, hr) {
      const r = target.getBoundingClientRect();
      if (r.width < 2 || r.height < 2) { slot.el.style.display = 'none'; return; }
      slot.el.style.display = '';
      let w, hgt, left, top;
      if (slot.kind === 'row') {          // no number and no price button in the row: its right edge
        w = 84; hgt = Math.max(30, Math.min(40, r.height - 8));
        left = r.right - w - 8; top = r.top + (r.height - hgt) / 2;
      } else if (slot.kind === 'pill') {  // over the row's first price button, same footprint
        w = Math.max(74, Math.min(140, r.width)); hgt = Math.max(30, Math.min(44, r.height));
        left = r.left + (r.width - w) / 2; top = r.top + (r.height - hgt) / 2;
      } else {                            // over the probability it replaces
        w = Math.max(74, Math.min(120, r.width + 16)); hgt = Math.max(30, Math.min(40, r.height + 4));
        left = r.left + r.width - w; top = r.top + (r.height - hgt) / 2;
        // a number at the left of its row (Manifold) keeps its left edge instead of growing leftwards
        const row = slot.row && slot.row.isConnected ? slot.row.getBoundingClientRect() : null;
        if (slot.align === 'left' || (!slot.align && row && r.left - row.left < row.width * 0.35)) left = r.left;
      }
      slot.el.style.width = w + 'px';
      slot.el.style.height = hgt + 'px';
      slot.el.style.left = left - hr.left + 'px';
      slot.el.style.top = top - hr.top + 'px';
      clipTo(slot.el, slot.el.getBoundingClientRect());
    }
    // Shrinks a region's rect so elements the adapter wants visible (volume, forecaster counts) stay
    // uncovered, when they sit along its top or bottom edge.
    function trimRect(r, keep) {
      if (!keep || !keep.length) return r;
      let top = r.top, bottom = r.bottom;
      for (const k of keep) {
        if (!k.isConnected) continue;
        const kr = k.getBoundingClientRect();
        if (kr.width < 1 || kr.height < 1 || kr.bottom <= top || kr.top >= bottom) continue;
        if ((kr.top + kr.bottom) / 2 > (top + bottom) / 2) bottom = Math.min(bottom, kr.top - 4);
        else top = Math.max(top, kr.bottom + 4);
      }
      return { left: r.left, right: r.right, width: r.width, top, bottom, height: Math.max(0, bottom - top) };
    }
    function placeCover(el, target, hr) {
      const r = trimRect(target.getBoundingClientRect(), el._ffKeep);
      if (r.width < 2 || r.height < 2) { el.style.display = 'none'; return; }
      el.style.display = '';
      el.style.left = r.left - hr.left + 'px';
      el.style.top = r.top - hr.top + 'px';
      el.style.width = r.width + 'px';
      el.style.height = r.height + 'px';
      clipTo(el, r);
    }
    // Center the compact panel inside its anchor region; fall back to a bottom sheet when the region is unusable.
    // The part of the viewport not hidden under sticky headers / fixed bottom bars.
    function visibleBand() {
      let top = 0, bottom = window.innerHeight;
      for (const b of bars) { if (b.top) bottom = Math.min(bottom, b.edge); else top = Math.max(top, b.edge); }
      return { top, bottom };
    }
    function placePanel(el, anchor, hr, keep) {
      const r = trimRect(anchor.getBoundingClientRect(), keep);
      // Dock to the bottom of the viewport when the region is unusable or when the panel's natural spot
      // is hidden (scrolled away, or under a sticky header), so the question stays answerable.
      const ph0 = el.offsetHeight || 56;
      const wantTop = r.top + (ph0 + 16 > r.height ? 8 : (r.height - ph0) / 2);
      const band = visibleBand();
      const hidden = wantTop < band.top + 6 || wantTop + ph0 > band.bottom - 6;
      if (r.width < 200 || r.height < 24 || hidden) {
        el.classList.add('fixed');
        el.style.left = el.style.top = el.style.maxWidth = el.style.clipPath = '';
        el.style.display = '';
        el.style.bottom = (window.innerHeight - band.bottom + 18) + 'px'; // above Kalshi-style bottom navs
        return;
      }
      el.classList.remove('fixed');
      el.style.display = '';
      el.style.bottom = '';
      el.style.maxWidth = Math.min(r.width - 16, window.innerWidth - 24) + 'px';
      const pw = el.offsetWidth, ph = el.offsetHeight;
      const left = r.left + Math.max(8, (r.width - pw) / 2);
      const top = r.top + (ph + 16 > r.height ? 8 : (r.height - ph) / 2);
      el.style.left = left - hr.left + 'px';
      el.style.top = top - hr.top + 'px';
      clipTo(el, el.getBoundingClientRect());
    }
    // Free spot for the chip: the region's top-right corner, nudged left past whatever the page draws
    // there (site watermarks, chart toolbars). Returns offsets from the region's top-right, or null.
    function chipSpot(anchor, w, hgt) {
      const ar = anchor.getBoundingClientRect();
      const inset = 8, gap = 8;
      if (ar.width < w + inset * 2 + 40 || ar.height < hgt + inset * 2) return null;
      // Everything the page draws inside the region, with its box (svg subtrees count as one box).
      const boxes = [];
      (function walk(el, depth) {
        if (depth > 14) return;
        for (const k of el.children) {
          const tag = k.tagName.toLowerCase();
          if (tag === 'ff-root' || tag === 'script' || tag === 'style') continue;
          const r = k.getBoundingClientRect();
          if (r.width < 1 || r.height < 1) continue;
          const leaf = tag === 'svg' || tag === 'img' || tag === 'canvas' || tag === 'video' || tag === 'button' || tag === 'a' || tag === 'input' || tag === 'select';
          const text = !leaf && [...k.childNodes].some((n) => n.nodeType === 3 && n.nodeValue.trim());
          if (leaf || (text && !(r.width > ar.width * 0.9 && r.height > hgt * 3))) boxes.push(r);
          if (!leaf) walk(k, depth + 1);
        }
      })(anchor, 0);
      // Try the top row first, then the rows just below it (Polymarket's legend fills the first row),
      // then the bottom rows (Manifold's chart header is full, its x-axis row is not).
      const offsets = [];
      for (let row = 0; row < 3; row++) offsets.push(inset + row * (hgt + 6));
      for (let row = 0; row < 2; row++) offsets.push(ar.height - inset - hgt - row * (hgt + 6));
      for (const dy of offsets) {
        const top = ar.top + dy, bottom = top + hgt;
        if (dy < inset || bottom > ar.bottom - inset) continue;
        // Only things that really share the band count; a chart that merely touches it does not.
        const blockers = boxes.filter((r) => Math.min(r.bottom, bottom) - Math.max(r.top, top) >= Math.min(8, hgt / 3));
        let right = ar.right - inset;
        for (let i = 0; i < 12; i++) {
          const left = right - w;
          if (left < ar.left + inset) { right = -1; break; }
          const hit = blockers.filter((r) => r.left < right + gap && r.right > left - gap);
          if (!hit.length) break;
          right = Math.min(...hit.map((r) => r.left)) - gap;
        }
        if (right > 0) return { dx: ar.right - right, dy };
      }
      return null;
    }
    function placeChip(c, hr) {
      if (c.anchor && !c.anchor.isConnected) c.anchor = null;
      if (c.anchor && (c.spot === undefined || performance.now() - c.spotAt > 700)) {
        c.spot = chipSpot(c.anchor, c.el.offsetWidth, c.el.offsetHeight);
        c.spotAt = performance.now();
      }
      if (!c.anchor || !c.spot) {
        if (!c.el.classList.contains('fixed')) { c.el.classList.add('fixed'); c.el.style.left = c.el.style.top = c.el.style.clipPath = ''; }
        c.el.style.bottom = (window.innerHeight - visibleBand().bottom + 14) + 'px'; // clear fixed bottom navs
        return;
      }
      c.el.style.bottom = '';
      const ar = c.anchor.getBoundingClientRect();
      c.el.classList.remove('fixed');
      c.el.style.left = ar.right - c.spot.dx - c.el.offsetWidth - hr.left + 'px';
      c.el.style.top = ar.top + c.spot.dy - hr.top + 'px';
      clipTo(c.el, c.el.getBoundingClientRect());
    }
    function tick() {
      if (raf) cancelAnimationFrame(raf);
      raf = 0;
      if (!host) return;
      if (performance.now() - barsAt > 600) refreshBars();
      if (!host.isConnected && (covers.size || panel || card || badge || chip)) (document.body || document.documentElement).appendChild(host);
      const hr = host.getBoundingClientRect();
      for (const [t, el] of covers) {
        if (!t.isConnected) { el.remove(); covers.delete(t); continue; }
        placeCover(el, t, hr);
      }
      alignSlots();
      for (const [t, slot] of slots) {
        if (!t.isConnected) { slot.el.remove(); slots.delete(t); continue; }
        placeSlot(slot, t, hr);
      }
      if (panel) {
        if (panel.anchor && !panel.anchor.isConnected) panel.anchor = null;
        if (panel.anchor) placePanel(panel.el, panel.anchor, hr, panel.keep);
        else { panel.el.classList.add('fixed'); panel.el.style.left = panel.el.style.top = panel.el.style.maxWidth = ''; panel.el.style.display = ''; }
      }
      if (chip) placeChip(chip, hr);
      if (covers.size || slots.size || panel || card || badge || chip) raf = requestAnimationFrame(tick);
    }
    function watch(anchor) {
      if (ro) { ro.disconnect(); ro = null; }
      if (anchor && typeof ResizeObserver !== 'undefined') { ro = new ResizeObserver(() => tick()); ro.observe(anchor); }
    }

    return {
      applyTheme(t) { ensure(); applyTheme(t); },
      onResize(fn) { resizeListeners.add(fn); return () => resizeListeners.delete(fn); },
      addCover(target, small = false, keep = null) {
        if (!target) return;
        ensure();
        let el = covers.get(target);
        if (!el) {
          el = h('div.ff-cover' + (small ? '.small' : ''));
          layer.appendChild(el);
          covers.set(target, el);
        }
        el._ffKeep = keep || null;
      },
      removeCover(target) { const el = covers.get(target); if (el) { el.remove(); covers.delete(target); } },
      coveredTargets: () => [...covers.keys()],
      // Inline input over the page element that shows an outcome's probability.
      // meta: { kind: 'pct' | 'pill' | 'row', row, required }
      setSlot(target, key, name, value, onInput, onEnter, meta = {}) {
        ensure();
        let slot = slots.get(target);
        if (!slot) {
          const input = h('input', { type: 'number', min: 0, max: 100, step: 'any', inputmode: 'decimal', 'aria-label': 'Your probability for ' + name });
          input.addEventListener('input', () => onInput && onInput());
          input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); onEnter && onEnter(); } e.stopPropagation(); });
          input.addEventListener('keyup', (e) => e.stopPropagation());
          input.addEventListener('keypress', (e) => e.stopPropagation());
          const el = h('div.ff-slot', input, h('span.pct', { text: '%' }));
          if (value != null && value !== '') input.value = value;
          layer.appendChild(el);
          slot = { el, input, key, name };
          slots.set(target, slot);
        } else {
          slot.key = key; slot.name = name;
        }
        slot.kind = meta.kind || 'pct';
        slot.row = meta.row || null;
        slot.el.classList.toggle('req', !!meta.required);
        tick();
        return slot.input;
      },
      keepSlots(targets) {
        const keep = new Set(targets);
        for (const [t, slot] of slots) if (!keep.has(t)) { slot.el.remove(); slots.delete(t); }
      },
      slotList: () => [...slots.entries()].map(([target, s]) => ({ target, key: s.key, name: s.name, input: s.input })),
      hasSlots: () => slots.size > 0,
      setPanel(content, anchor, keep) {
        ensure();
        if (panel) panel.el.remove();
        const el = h('div.ff-panel');
        el.appendChild(content);
        layer.appendChild(el);
        panel = { el, anchor: anchor || null, keep: keep || null };
        watch(anchor);
        tick();
        return el;
      },
      setPanelAnchor(anchor, keep) { if (panel) { panel.anchor = anchor || null; panel.keep = keep || null; watch(anchor); tick(); } },
      hasPanel: () => !!panel,
      removePanel() { if (panel) { panel.el.remove(); panel = null; watch(null); } },
      showCard(content) {
        ensure();
        if (card) card.remove();
        card = h('div.ff-card');
        card.appendChild(content);
        layer.appendChild(card);
        return card;
      },
      removeCard() { if (card) { card.remove(); card = null; } },
      showBadge(content) { ensure(); if (badge) badge.remove(); badge = h('div.ff-badge'); badge.appendChild(content); layer.appendChild(badge); return badge; },
      removeBadge() { if (badge) { badge.remove(); badge = null; } },
      showChip(content, anchor) {
        ensure();
        if (chip) chip.el.remove();
        const el = h('div.ff-chip');
        el.appendChild(content);
        layer.appendChild(el);
        chip = { el, anchor: anchor || null, spot: undefined, spotAt: 0 };
        tick();
        return el;
      },
      setChipAnchor(anchor) { if (chip) { chip.anchor = anchor || null; chip.spot = undefined; tick(); } },
      removeChip() { if (chip) { chip.el.remove(); chip = null; } },
      clear() {
        for (const el of covers.values()) el.remove();
        covers.clear();
        for (const slot of slots.values()) slot.el.remove();
        slots.clear();
        this.removePanel(); this.removeCard(); this.removeBadge(); this.removeChip();
      },
    };
  })();

  // ------------------------------------------------------------------ outcome rows on the page
  // Finds, for each outcome, the page element that displays its probability (e.g. "80%"),
  // so an input can be placed right there instead of re-listing the outcomes in a panel.
  const norm = (t) => String(t || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
  // Finds, for each outcome, its row on the page and the element the input should sit on: the row's
  // probability display when there is one (a plain "22%" or an odometer of stacked digits), else the
  // row's first price button, else the row itself (the input goes at its right edge).
  FF.findOutcomeSlots = (outcomes, exclude) => {
    const scope = document.querySelector('main') || document.body;
    if (!scope || !outcomes || outcomes.length < 2) return [];
    const names = outcomes.map((o) => ({ o, n: norm(o.name) })).filter((x) => x.n.length >= 2).sort((a, b) => b.n.length - a.n.length);
    const excluded = (el) => !!(exclude && exclude.some((x) => x && x.contains(el)));
    const visible = (el) => { const r = el.getBoundingClientRect(); return r.width >= 8 && r.height >= 8; };
    const PCTTEXT = /^(?:<\s*)?[\d.,\s]+%$/;
    // 1. elements whose own text is an outcome name (or the name plus a little decoration)
    const nameEls = [];
    const walker = document.createTreeWalker(scope, NodeFilter.SHOW_ELEMENT, {
      acceptNode(el) {
        if (el.tagName === 'FF-ROOT' || el.tagName === 'SCRIPT' || el.tagName === 'STYLE' || el.tagName === 'svg') return NodeFilter.FILTER_REJECT;
        if (excluded(el)) return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      },
    });
    let el;
    while ((el = walker.nextNode())) {
      if (el.children.length > 2) continue;
      const t = el.textContent.trim();
      if (t.length < 2 || t.length > 80) continue;
      const n = norm(t);
      const hit = names.find((x) => n === x.n || (x.n.length >= 4 && n.includes(x.n) && n.length <= x.n.length + 12));
      if (hit && visible(el)) nameEls.push({ el, hit });
    }
    // 2. grow a name into its row: the largest ancestor that stays short and doesn't mention another outcome
    const rowOf = (leaf, own) => {
      let row = leaf;
      for (let i = 0; i < 8; i++) {
        const p = row.parentElement;
        if (!p || p === scope || p === document.body) break;
        if (p.getBoundingClientRect().height > 120) break;
        const text = norm(p.textContent);
        if (names.some((x) => x !== own && x.n.length >= 3 && !own.n.includes(x.n) && text.includes(x.n))) break;
        row = p;
      }
      return row;
    };
    const used = new Set();
    const out = [];
    for (const { el: nameEl, hit } of nameEls) {
      if (used.has(hit.o.key)) continue;
      const row = rowOf(nameEl, hit);
      if (row.getBoundingClientRect().width < 120) continue; // a chip or legend entry, not a row
      let target = null, kind = 'row';
      // sites keep hidden copies of the number for other breakpoints; only visible ones count
      const cands = [...row.querySelectorAll('*')].filter((c) => c.tagName !== 'svg' && !c.contains(nameEl) && !excluded(c) && PCTTEXT.test(c.textContent.trim()) && visible(c));
      const pctEl = cands.find((c) => !cands.some((d) => d !== c && c.contains(d))) || cands[0];
      if (pctEl && parseFloat(getComputedStyle(pctEl).fontSize) >= 12) { target = pctEl; kind = 'pct'; }
      if (!target) {
        const pill = [...row.querySelectorAll('button, [role="button"], [data-testid="price-pill"]')].find((b) => visible(b) && !b.contains(nameEl) && b.getBoundingClientRect().width >= 40);
        if (pill) { target = pill; kind = 'pill'; }
      }
      if (!target) target = row;
      used.add(hit.o.key);
      out.push({ outcome: hit.o, target, kind, row });
    }
    // Outcome rows live in one list. A name that also shows up in a comment or a trade feed makes a
    // row somewhere else on the page, so keep only the biggest group of rows sharing a parent.
    if (out.length > 1) {
      const groups = new Map();
      for (const x of out) { const k = x.row.parentElement; groups.set(k, (groups.get(k) || 0) + 1); }
      const best = [...groups.entries()].sort((a, b) => b[1] - a[1])[0];
      if (best && best[1] >= 2) return out.filter((x) => x.row.parentElement === best[0]);
    }
    return out;
  };

  // ------------------------------------------------------------------ forecast form (compact)
  // ctx: { adapter, data (may be null while loading), onSubmit(values), onSkip() }
  FF.buildForm = (ctx) => {
    const root = h('div.ff-form');
    let rows = [];        // { name, key, input } (inputs living inside the panel)
    let freeText = null;
    let mode = '';        // 'binary' | 'multi' | 'inline' | 'free' | 'closed'
    let inline = [];      // [{ outcome, target, kind, row }] outcomes whose input sits on the page row
    const remembered = new Map(); // outcome key -> typed value, survives re-renders
    let sumEl = null, moreEl = null;

    const numInput = () => h('input', { type: 'number', min: 0, max: 100, step: 'any', inputmode: 'decimal', 'aria-label': 'Your probability', oninput: syncButtons });
    const pct = (input) => h('span.ff-num', input, h('span.pct', { text: '%' }));
    const readNum = (input) => { const v = input.value.trim(); if (v === '') return null; const n = Number(v); return Number.isFinite(n) ? U.clamp(n, 0, 100) : null; };
    const submitBtn = () => h('button.primary.ff-submit', { type: 'button', text: 'Submit', hidden: true, onclick: submit });
    const revealBtn = () => h('button.link', { type: 'button', text: 'Reveal', title: 'Show the page without forecasting', onclick: () => ctx.onSkip() });
    const status = h('span.ff-status');
    const outs = () => (ctx.data && Array.isArray(ctx.data.outcomes) ? ctx.data.outcomes : []);
    const allInputs = () => rows.map((r) => ({ key: r.key, name: r.name, input: r.input })).concat(FF.ui.slotList());

    // The outcomes you have to price: the fewest of the market's likeliest outcomes whose probabilities
    // add up to `topMassPct` — and never more than MAX_REQUIRED, however long the tail.
    let reqCache = null;
    function requiredKeys() {
      if (reqCache && reqCache.data === ctx.data) return reqCache.keys;
      const d = ctx.data, o = outs();
      let keys = [];
      if (d && d.exclusive && o.length > 2) {
        const withP = o.filter((x) => x.prob != null && Number.isFinite(x.prob));
        if (withP.length >= 2) {
          const target = Math.min(100, Math.max(1, Number(ctx.topMassPct) || 90));
          let acc = 0;
          for (const x of [...withP].sort((a, b) => b.prob - a.prob)) {
            keys.push(x.key);
            acc += x.prob;
            if (acc >= target - 1e-9 || keys.length >= FF.MAX_REQUIRED) break;
          }
        }
      }
      reqCache = { data: ctx.data, keys };
      return keys;
    }
    const isRequired = (key) => requiredKeys().includes(key);

    function hasInput() {
      return allInputs().some((r) => r.input.value.trim() !== '') || !!(freeText && freeText.value.trim());
    }
    function syncButtons() {
      const req = requiredKeys();
      const filled = new Set(allInputs().filter((r) => r.input.value.trim() !== '').map((r) => r.key));
      const missing = req.filter((k) => !filled.has(k));
      const show = req.length ? missing.length === 0 : hasInput();
      for (const b of root.querySelectorAll('button.ff-submit')) b.hidden = !show;
      for (const r of allInputs()) remembered.set(r.key, r.input.value);
      if (moreEl) {
        moreEl.hidden = !missing.length;
        moreEl.textContent = '';
        if (missing.length) moreEl.append(`${missing.length} more`, h('span.ff-arrow', { text: ' \u2193' }));
      }
      if (sumEl) {
        const vals = allInputs().map((r) => readNum(r.input)).filter((v) => v != null);
        if (vals.length > 1 && ctx.data && ctx.data.exclusive) {
          const sum = U.round1(vals.reduce((a, b) => a + b, 0));
          sumEl.textContent = '\u03a3 ' + (Number.isInteger(sum) ? sum : sum.toFixed(1)) + '%';
          sumEl.classList.toggle('over', sum > 100.5);
        } else sumEl.textContent = '';
      }
    }

    function modeFor(d) {
      if (d && d.closed) return 'closed';
      const o = outs();
      if (!d) return 'binary';
      if (d.binary === false && o.length === 0) return 'free';
      // Two mutually exclusive outcomes (a game, cut / no cut): one number says it all.
      if (o.length === 2 && d.exclusive) return 'binary';
      if (o.length > 1) {
        const req = requiredKeys();
        const found = new Set(inline.map((x) => x.outcome.key));
        const need = req.length ? req : o.map((x) => x.key);
        const hits = need.filter((k) => found.has(k)).length;
        return hits >= Math.max(1, Math.ceil(need.length * 0.6)) && (req.length > 0 || inline.length >= 2) ? 'inline' : 'multi';
      }
      return 'binary';
    }

    function render() {
      const d = ctx.data;
      const next = modeFor(d);
      const o = outs();
      if (next === 'binary' && mode === 'binary' && rows.length) {
        // keep what the user typed; just refresh the key/name and the outcome label
        if (o[0]) {
          rows[0].name = o[0].name; rows[0].key = o[0].key;
          const label = root.querySelector(':scope > .ff-name');
          if (/^yes$/i.test(o[0].name)) { if (label) label.remove(); }
          else if (label) { label.textContent = label.title = o[0].name; }
          else root.insertBefore(h('span.ff-name', { title: o[0].name, text: o[0].name }), root.firstChild);
        }
        return;
      }
      if (next === 'inline' && mode === 'inline') { syncInline(); syncButtons(); return; }
      mode = next;
      root.textContent = '';
      root.classList.toggle('multi', mode === 'multi');
      rows = [];
      freeText = null;
      sumEl = null; moreEl = null; extraBox = null;
      if (mode !== 'inline') FF.ui.keepSlots([]);
      if (mode === 'inline') {
        moreEl = h('span.ff-hint');
        sumEl = h('span.ff-sum');
        // One control row, so that when required outcomes missing from the page are listed above it
        // (.ff-extra, column layout) the hint, Σ and buttons still sit together on the last line.
        root.append(h('div.ff-row.ff-ctl', moreEl, sumEl, submitBtn(), revealBtn(), status));
        syncInline();
        syncButtons();
        return;
      }
      if (mode === 'closed') {
        root.append(h('span.ff-status', { text: 'Closed' }));
        return;
      }
      if (mode === 'free') {
        freeText = h('input.ff-free', { type: 'text', placeholder: 'Your estimate', 'aria-label': 'Your estimate', oninput: syncButtons });
        root.append(freeText, submitBtn(), revealBtn(), status);
      } else if (mode === 'multi') {
        // rows couldn't be found on the page: list what has to be priced (or everything, when nothing is required)
        const req = requiredKeys();
        const list = req.length ? o.filter((x) => req.includes(x.key)) : o.slice(0, 40);
        sumEl = h('span.ff-sum');
        root.append(h('div.ff-row', h('span.ff-hint', { text: req.length ? 'Your % for the likeliest outcomes' : 'Your % for any outcome' }), sumEl));
        for (const x of list) {
          const input = numInput();
          if (remembered.has(x.key)) input.value = remembered.get(x.key);
          root.appendChild(h('div.ff-row', h('span.ff-name', { title: x.name, text: x.name }), pct(input)));
          rows.push({ name: x.name, key: x.key, input });
        }
        root.appendChild(h('div.ff-foot', status, submitBtn(), revealBtn()));
      } else {
        const x = o[0] || { name: 'Yes', key: 'yes' };
        const input = numInput();
        rows.push({ name: x.name, key: x.key, input });
        if (!/^yes$/i.test(x.name)) root.appendChild(h('span.ff-name', { title: x.name, text: x.name }));
        root.append(pct(input), submitBtn(), revealBtn(), status);
      }
      syncButtons();
      const first = root.querySelector('input');
      if (first) setTimeout(() => first.focus({ preventScroll: true }), 40);
    }

    let extraBox = null;
    function syncInline() {
      const targets = [];
      let first = null;
      for (const { outcome, target, kind, row } of inline) {
        targets.push(target);
        const input = FF.ui.setSlot(target, outcome.key, outcome.name, remembered.get(outcome.key), syncButtons, submit, { kind, row, required: isRequired(outcome.key) });
        if (!first || (isRequired(outcome.key) && !first.required)) { first = input; first.required = isRequired(outcome.key); }
      }
      FF.ui.keepSlots(targets);
      // required outcomes we couldn't find on the page still get a row inside the panel
      const found = new Set(inline.map((x) => x.outcome.key));
      const missing = outs().filter((x) => isRequired(x.key) && !found.has(x.key));
      const keys = missing.map((x) => x.key).join('|');
      if (keys !== (extraBox && extraBox.dataset.keys)) {
        if (extraBox) extraBox.remove();
        rows = [];
        extraBox = null;
        if (missing.length) {
          extraBox = h('div.ff-extra');
          extraBox.dataset.keys = keys;
          for (const x of missing.slice(0, 20)) {
            const input = numInput();
            if (remembered.has(x.key)) input.value = remembered.get(x.key);
            extraBox.appendChild(h('div.ff-row', h('span.ff-name', { title: x.name, text: x.name }), pct(input)));
            rows.push({ name: x.name, key: x.key, input });
          }
          root.appendChild(extraBox);
          root.classList.add('multi');
        } else root.classList.remove('multi');
      }
      if (first && !root.dataset.focused) { root.dataset.focused = '1'; setTimeout(() => first.focus({ preventScroll: true }), 40); }
    }

    let busy = false;
    async function submit() {
      if (busy) return;
      const values = [];
      for (const r of allInputs()) { const p = readNum(r.input); if (p != null) values.push({ name: r.name, key: r.key, personal: p }); }
      const text = freeText ? freeText.value.trim() : '';
      if (!values.length && !text) {
        const first = root.querySelector('input'); if (first) first.focus({ preventScroll: true });
        return;
      }
      const missing = requiredKeys().filter((k) => !values.some((v) => v.key === k));
      if (missing.length) { syncButtons(); const slot = allInputs().find((r) => r.key === missing[0]); if (slot) slot.input.focus({ preventScroll: false }); return; }
      busy = true;
      for (const b of root.querySelectorAll('button.primary')) b.disabled = true;
      try { await ctx.onSubmit({ values, freeText: text }); }
      catch (e) {
        busy = false;
        for (const b of root.querySelectorAll('button.primary')) b.disabled = false;
        status.className = 'ff-status err';
        status.textContent = (e && e.message) || String(e);
      }
    }
    root.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); submit(); }
      e.stopPropagation();
    });
    root.addEventListener('keyup', (e) => e.stopPropagation());
    root.addEventListener('keypress', (e) => e.stopPropagation());

    render();
    return {
      el: root,
      setData(d) { ctx.data = d; reqCache = null; render(); },
      // called repeatedly by the orchestrator with the page rows found for the outcomes
      setInline(list) {
        const same = list.length === inline.length && list.every((x, i) => x.target === inline[i].target && x.outcome.key === inline[i].outcome.key);
        inline = list;
        if (!same) render();
      },
    };
  };

  // ------------------------------------------------------------------ reveal card (after submit)
  // ctx: { adapter, entry, onSave(text) -> Promise, onClose() }
  FF.buildRevealCard = (ctx) => {
    const label = ctx.adapter.consensusShort || 'Market';
    const root = h('div');
    const closeBtn = h('button.ff-x', { type: 'button', title: 'Dismiss', text: '×', onclick: () => ctx.onClose() });
    root.appendChild(closeBtn);
    const stat = (lbl, val) => h('span.stat', h('span.lbl', { text: lbl }), h('span.val', { text: val }));
    let anyGap = false;
    const multi = ctx.entry.outcomes.filter((o) => !o.derived).length > 1;
    for (const o of ctx.entry.outcomes) {
      if (o.derived) continue;
      if (multi || !/^yes$/i.test(o.name)) root.appendChild(h('div.ff-outcome', { text: o.name }));
      const cmp = h('div.ff-cmp', stat(label, U.fmtPct(o.actual)), stat('You', U.fmtPct(o.personal)));
      if (o.actual != null && o.personal != null) {
        const d = U.diffLabel(o.personal, o.actual);
        anyGap = anyGap || d.dir !== 0;
        cmp.appendChild(h('span.diff' + (d.dir === 0 ? '.same' : ''), { text: d.text }));
      }
      root.appendChild(cmp);
    }
    if (ctx.entry.freeText) root.appendChild(h('div.ff-cmp', stat('You', ctx.entry.freeText)));

    const why = h('textarea', { placeholder: anyGap ? 'Why the gap? (optional)' : 'Why? (optional)', 'aria-label': 'Reasoning' });
    const saveBtn = h('button.primary', { type: 'button', text: 'Save' });
    const fb = h('div.ff-fb.grow');
    root.append(why, h('div.ff-foot', saveBtn, fb));

    saveBtn.addEventListener('click', async () => {
      saveBtn.disabled = true;
      try { await ctx.onSave(why.value.trim()); }
      catch (e) { saveBtn.disabled = false; fb.textContent = ''; fb.appendChild(h('span.err', { text: (e && e.message) || String(e) })); }
    });
    root.addEventListener('keydown', (e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) saveBtn.click(); if (e.key === 'Escape') ctx.onClose(); e.stopPropagation(); });
    root.addEventListener('keyup', (e) => e.stopPropagation());
    root.addEventListener('keypress', (e) => e.stopPropagation());
    setTimeout(() => why.focus({ preventScroll: true }), 40);

    return {
      el: root,
      setFatebook(lines) {
        fb.textContent = '';
        fb.classList.remove('err');
        for (const l of lines) {
          if (l.url) fb.appendChild(h('span', '✓ ', h('a', { href: l.url, target: '_blank', rel: 'noopener', text: (l.label ? l.label + ' · ' : '') + (l.updated ? 'Fatebook updated ↗' : 'Fatebook ↗') }), ' '));
          else if (l.error) fb.appendChild(h('span.err', { text: '✗ Fatebook: ' + l.error }));
          else if (l.node) fb.appendChild(l.node);
          else fb.appendChild(h('span', { text: l.text || '' }));
        }
      },
    };
  };

  // ------------------------------------------------------------------ "forecast again" chip (revealed pages)
  // ctx: { label, toggle: boolean, daily: boolean, onAgain(), onToggleDaily(on) -> Promise }
  FF.buildAgainChip = (ctx) => {
    const again = h('button.ff-again', { type: 'button', title: 'Hide the probability and forecast again' }, FF.icon(), h('span', { text: 'Forecast again' }));
    const daily = h('button.ff-daily', { type: 'button', role: 'switch' }, h('span', { text: ctx.label || 'Daily' }), h('span.ff-sw', h('span.knob')));
    const root = h('div.ff-chip-inner', again);
    if (ctx.toggle !== false) root.appendChild(daily);
    let on = !!ctx.daily;
    const render = () => {
      daily.classList.toggle('on', on);
      daily.setAttribute('aria-checked', String(on));
      daily.title = on ? `Hides again (${(ctx.label || 'daily').toLowerCase()}). Click to keep this question revealed.` : 'Stays revealed. Click to hide it again on schedule.';
    };
    render();
    again.addEventListener('click', () => ctx.onAgain());
    daily.addEventListener('click', async () => {
      on = !on; render();
      try { await ctx.onToggleDaily(on); } catch (_) { on = !on; render(); }
    });
    return { el: root, setDaily(v) { on = !!v; render(); } };
  };
})();
