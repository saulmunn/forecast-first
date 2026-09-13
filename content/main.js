// Forecast First — orchestrator: decides per URL whether to blind the page,
// mounts the forecast form, handles submit/reveal, re-asking, and Fatebook logging.
(() => {
  'use strict';
  const FF = globalThis.__FF;
  if (!FF || FF.mainLoaded) return;
  FF.mainLoaded = true;
  const U = FF.util, h = FF.h;

  const adapter = FF.adapters.find((a) => a.matches(location.hostname));
  if (!adapter) return;

  const html = document.documentElement;
  let settings = null;
  let current = null;   // active blind session on a question page
  let again = null;     // revealed question page: tracks the chart region for the "Forecast again" chip
  let lastUrl = location.href;
  let routing = null;
  let closeCard = null; // closes the open reveal card (and logs to Fatebook), if any

  // Blind synchronously before first paint if this looks like a question page.
  const first = adapter.parse(location);
  if (first && first.kind === 'market') html.setAttribute('data-ff-blind', '');

  const unblindDom = () => {
    html.removeAttribute('data-ff-blind');
    for (const el of document.querySelectorAll('[data-ff-hidden], [data-ff-keep]')) { el.removeAttribute('data-ff-hidden'); el.removeAttribute('data-ff-keep'); }
  };
  const flushFatebook = (id) => FF.bg({ type: 'fatebookFlush', id }).catch(() => null);

  // ------------------------------------------------------------------ routing
  async function route() {
    if (routing) return routing;
    routing = (async () => {
      settings = await FF.getSettings();
      lastUrl = location.href;
      const parsed = adapter.parse(location);
      const isMarket = parsed && parsed.kind === 'market';
      teardown(isMarket);
      flushFatebook();
      const paused = settings.pausedUntil && settings.pausedUntil > Date.now();
      if (!settings.enabled || paused || !parsed) { unblindDom(); return; }
      if (!isMarket) {
        unblindDom();
        if (settings.maskListings) startListing();
        return;
      }
      const state = await FF.getMarketState(parsed.key);
      if (stillRevealed(state)) { unblindDom(); startAgain(parsed, state); return; }
      startBlind(parsed);
    })().finally(() => { routing = null; });
    return routing;
  }

  // After a forecast or a reveal the question stays visible until the re-ask period has passed —
  // or for good, when the user switched re-asking off for that question.
  function stillRevealed(state) {
    if (!state || (state.status !== 'submitted' && state.status !== 'skipped')) return false;
    if (state.keepRevealed) return true;
    const hrs = Number(settings.reaskHours);
    if (hrs < 0) return true;
    if (hrs === 0) return false;
    return Date.now() - (state.at || 0) < hrs * 3600e3;
  }

  function teardown(keepBlind) {
    if (current) {
      clearInterval(current.regionTimer);
      if (current.observer) current.observer.disconnect();
      if (current.offResize) current.offResize();
      current = null;
    }
    stopAgain();
    closeCard = null;
    FF.ui.clear();
    FF.mask.stop();
    if (!keepBlind) unblindDom();
  }

  // ------------------------------------------------------------------ listing pages
  const maskOptions = () => ({
    patterns: adapter.maskPatterns || [],
    graphics: adapter.leakyGraphics ? () => adapter.leakyGraphics() : null,
  });
  function startListing() {
    FF.mask.start(maskOptions());
    FF.ui.applyTheme(FF.theme.sample(adapter, null));
    FF.ui.showBadge(h('div', { style: 'display:flex;align-items:center;gap:4px', title: 'Probabilities hidden while browsing' },
      FF.icon(),
      h('button.link', { type: 'button', text: 'show 5 min', onclick: () => pause(5) })));
  }
  const pause = (minutes) => chrome.storage.local.set({ pausedUntil: Date.now() + minutes * 60e3 });

  // ------------------------------------------------------------------ question pages
  function startBlind(parsed) {
    html.setAttribute('data-ff-blind', '');
    const c = (current = { parsed, key: parsed.key, data: null, form: null, anchor: null, mounted: false, observer: null, regionTimer: 0, offResize: null, done: false });
    FF.mask.start(maskOptions());

    c.dataPromise = Promise.resolve()
      .then(() => adapter.fetchData(parsed))
      .catch((e) => { console.warn('[Forecast First] market data unavailable:', e); return null; });
    c.dataPromise.then((d) => {
      if (current !== c) return;
      c.data = d;
      if (d && d.closed) { finish(c); return; }
      if (c.form) c.form.setData(d);
    });

    let t = 0;
    const mark = () => { if (current !== c || c.done) return; markRegions(c); };
    // Runs before the next paint, so a chart inserted by the page is hidden before it is ever drawn.
    const throttled = () => { if (!t) t = requestAnimationFrame(() => { t = 0; mark(); }); };
    c.observer = new MutationObserver(throttled);
    c.observer.observe(html, { childList: true, subtree: true });
    c.regionTimer = setInterval(mark, 600);
    c.offResize = FF.ui.onResize(throttled); // sites swap layouts at breakpoints; re-detect regions
    mark();

    whenSafeToMount(() => {
      if (current !== c || c.done) return;
      mountForm(c);
      mark();
    });
  }

  function markRegions(c) {
    let found;
    try { found = adapter.findRegions() || {}; } catch (e) { console.warn('[Forecast First] findRegions failed', e); return; }
    const anchor = found.anchor || null;
    let covers = (found.covers || []).filter((x) => x && (x.el || x).isConnected);
    covers = covers.filter((cv, i) => {
      const el = cv.el || cv;
      if (anchor && anchor !== el && anchor.contains(el)) return false;
      return !covers.some((other, j) => j !== i && (other.el || other) !== el && (other.el || other).contains(el));
    });
    const wanted = new Set();
    if (anchor) wanted.add(anchor);
    for (const cv of covers) wanted.add(cv.el || cv);
    for (const el of wanted) if (!el.hasAttribute('data-ff-hidden')) el.setAttribute('data-ff-hidden', '');
    // Volume / forecaster counts inside a hidden region stay visible and uncovered.
    const keep = (found.keep || []).filter((el) => el && el.isConnected);
    for (const el of keep) if (!el.hasAttribute('data-ff-keep')) el.setAttribute('data-ff-keep', '');
    for (const el of document.querySelectorAll('[data-ff-keep]')) if (!keep.includes(el)) el.removeAttribute('data-ff-keep');
    const keepIn = (region) => keep.filter((el) => region.contains(el));
    const anchorChanged = anchor !== c.anchor;
    c.anchor = anchor;
    if (!c.mounted) return;
    if (anchorChanged) {
      FF.ui.applyTheme(FF.theme.sample(adapter, anchor));
      FF.ui.setPanelAnchor(anchor, anchor ? keepIn(anchor) : null);
    } else if (anchor && FF.ui.hasPanel()) FF.ui.setPanelAnchor(anchor, keepIn(anchor));
    if (anchor) FF.ui.addCover(anchor, false, keepIn(anchor));
    for (const cv of covers) {
      const el = cv.el || cv;
      if (anchor && (el === anchor || anchor.contains(el))) continue;
      FF.ui.addCover(el, cv.small !== false, keepIn(el));
    }
    for (const tgt of FF.ui.coveredTargets()) if (!wanted.has(tgt)) FF.ui.removeCover(tgt);
    // Multi-outcome: put the inputs on the page's own outcome rows when we can find them.
    if (c.form && c.data && Array.isArray(c.data.outcomes) && c.data.outcomes.length > 1) {
      const exclude = [anchor, ...covers.map((cv) => cv.el || cv)];
      c.form.setInline(FF.findOutcomeSlots(c.data.outcomes, exclude));
    }
  }

  // Delay DOM insertion until the page has most likely hydrated (React can otherwise
  // trip over foreign nodes). The CSS blinding is already in effect meanwhile.
  function whenSafeToMount(fn) {
    if (document.readyState === 'complete') return setTimeout(fn, 60);
    let done = false;
    const go = () => { if (!done) { done = true; fn(); } };
    window.addEventListener('load', () => setTimeout(go, 60), { once: true });
    const afterDcl = () => setTimeout(go, 1200);
    if (document.readyState === 'interactive') afterDcl();
    else document.addEventListener('DOMContentLoaded', afterDcl, { once: true });
  }

  function mountForm(c) {
    FF.ui.applyTheme(FF.theme.sample(adapter, c.anchor));
    c.form = FF.buildForm({
      adapter,
      data: c.data,
      topMassPct: Number(settings.topMassPct) || 95,
      onSubmit: (values) => submit(c, values),
      onSkip: () => skip(c),
    });
    FF.ui.setPanel(c.form.el, c.anchor);
    c.mounted = true;
  }

  function actualFor(v, data, scraped, count) {
    if (data && Array.isArray(data.outcomes)) {
      const o = data.outcomes.find((x) => x.key === v.key);
      if (o && o.prob != null && Number.isFinite(o.prob)) return U.round1(o.prob);
    }
    if (scraped) {
      if (scraped[v.key] != null) return U.round1(scraped[v.key]);
      if (scraped.__single != null && count === 1) return U.round1(scraped.__single);
    }
    return null;
  }

  // The per-question "keep revealed" switch survives new forecasts and reveals.
  async function keepFlag(key) {
    const prev = await FF.getMarketState(key);
    return !!(prev && prev.keepRevealed);
  }

  async function submit(c, values) {
    const data = await c.dataPromise;
    let scraped = null;
    try { scraped = adapter.scrapeActual ? adapter.scrapeActual(c.parsed) : null; } catch (_) {}
    const outcomes = values.values.map((v) => ({
      name: v.name, key: v.key, personal: v.personal,
      actual: actualFor(v, data, scraped, values.values.length),
    }));
    // A two-way market is asked as one number; the other side is its complement.
    if (data && data.exclusive && Array.isArray(data.outcomes) && data.outcomes.length === 2 && outcomes.length === 1) {
      const other = data.outcomes.find((o) => o.key !== outcomes[0].key);
      if (other) outcomes.push({ name: other.name, key: other.key, personal: U.round1(100 - outcomes[0].personal), actual: actualFor(other, data, scraped, 2), derived: true });
    }
    const entry = {
      id: U.uuid(),
      at: Date.now(),
      site: adapter.id,
      siteName: adapter.name,
      url: location.href,
      marketKey: c.key,
      title: (data && data.title) || adapter.title() || U.pageTitle(),
      outcomes,
      freeText: values.freeText || '',
      reasoning: '',
      resolveBy: (data && data.closeDate) || U.todayPlus(settings.defaultResolveDays),
      consensusLabel: adapter.consensusShort || 'Market',
      // multi-outcome markets become one multiple-choice question on Fatebook
      multi: !!(data && Array.isArray(data.outcomes) && data.outcomes.length > 1),
      exclusive: !!(data && data.exclusive),
      outcomeCount: data && Array.isArray(data.outcomes) ? data.outcomes.length : 1,
      fatebook: [],
      // Fatebook question is created once the reveal card closes, so the reasoning can go in the notes.
      fatebookPending: !!(settings.fatebookApiKey && outcomes.some((o) => o.personal != null)),
    };
    await FF.appendForecast(entry);
    const state = { status: 'submitted', at: entry.at, forecastId: entry.id, keepRevealed: await keepFlag(c.key) };
    await FF.setMarketState(c.key, state);
    finish(c);
    // Log to Fatebook straight away; the reasoning (if any) is patched into the question's notes on Save.
    showReveal(entry, entry.fatebookPending ? flushFatebook(entry.id) : null);
    startAgain(c.parsed, state);
  }

  async function skip(c) {
    const state = { status: 'skipped', at: Date.now(), keepRevealed: await keepFlag(c.key) };
    await FF.setMarketState(c.key, state);
    finish(c);
    startAgain(c.parsed, state);
  }

  function finish(c) {
    c.done = true;
    clearInterval(c.regionTimer);
    if (c.observer) c.observer.disconnect();
    if (c.offResize) c.offResize();
    FF.ui.clear();
    FF.mask.stop();
    unblindDom();
    if (current === c) current = null;
  }

  const fbLines = (entry, res) => {
    const mine = res && res.results && res.results.find((r) => r.id === entry.id);
    if (!mine) return [{ error: 'could not reach the background worker' }];
    return mine.fatebook.map((f) => (f.url ? { url: f.url, updated: !!f.updated, label: f.kind !== 'mc' && entry.outcomes.filter((o) => !o.derived).length > 1 ? f.name : '' } : { error: f.error }));
  };

  function showReveal(entry, creating) {
    let closed = false;
    const close = () => { if (closed) return; closed = true; FF.ui.removeCard(); closeCard = null; };
    closeCard = close;
    let created = null; // Fatebook result once the questions exist
    const card = FF.buildRevealCard({
      adapter,
      entry,
      onSave: async (text) => {
        await FF.updateForecast(entry.id, { reasoning: text });
        if (!creating) { close(); return; }
        if (!created) created = await creating;           // still being created: wait for it
        const lines = fbLines(entry, created);
        if (text && lines.some((l) => l.url)) {
          card.setFatebook([{ text: 'Adding your reasoning…' }]);
          const res = await FF.bg({ type: 'fatebookNotes', id: entry.id }).catch((e) => ({ results: [{ error: (e && e.message) || String(e) }] }));
          const bad = res && res.results && res.results.find((r) => r.error);
          if (bad) { card.setFatebook([{ error: 'reasoning not saved: ' + bad.error }]); return; }
        } else if (text) {
          await flushFatebook(entry.id); // creation failed earlier; the retry carries the reasoning
        }
        card.setFatebook(lines);
        setTimeout(close, lines.every((l) => l.url) ? 900 : 2500);
      },
      onClose: () => { if (closeCard) closeCard(); },
    });
    FF.ui.showCard(card.el);
    if (creating) {
      card.setFatebook([{ text: 'Sending to Fatebook…' }]);
      creating.then((res) => { created = res; if (!closed) card.setFatebook(fbLines(entry, res)); });
    } else if (!settings.fatebookApiKey) {
      card.setFatebook([{ node: h('span', 'Fatebook: ', h('a', { href: '#', text: 'add API key', onclick: (e) => { e.preventDefault(); FF.bg({ type: 'openOptions' }); } })) }]);
    }
  }

  // ------------------------------------------------------------------ revealed question pages
  // A small chip in the chart region's corner: "Forecast again" re-hides the question now, and a
  // switch controls whether this question hides again by itself on the re-ask schedule.
  function reaskLabel() {
    const hrs = Number(settings.reaskHours);
    if (hrs === 0) return 'Each visit';
    if (hrs === 1) return 'Hourly';
    if (hrs < 24) return `Every ${hrs}h`;
    if (hrs === 24) return 'Daily';
    if (hrs === 168) return 'Weekly';
    return `Every ${Math.round(hrs / 24)}d`;
  }
  function startAgain(parsed, state) {
    stopAgain();
    const a = (again = { parsed, state: state || {}, timer: 0, anchor: null, shown: false, startedAt: Date.now() });
    const chip = FF.buildAgainChip({
      label: reaskLabel(),
      toggle: Number(settings.reaskHours) >= 0,
      daily: !a.state.keepRevealed,
      onAgain: () => askAgain(),
      onToggleDaily: async (on) => {
        const cur = (await FF.getMarketState(parsed.key)) || a.state;
        a.state = Object.assign({}, cur, { keepRevealed: !on });
        await FF.setMarketState(parsed.key, a.state);
      },
    });
    const find = () => {
      if (again !== a) return;
      let found;
      try { found = adapter.findRegions() || {}; } catch (_) { found = {}; }
      const anchor = found.anchor && found.anchor.isConnected ? found.anchor : null;
      // Give the chart region a moment to appear before falling back to the corner pill, so the chip doesn't jump.
      if (!a.shown && !anchor && Date.now() - a.startedAt < 2500) return;
      if (!a.shown) {
        a.shown = true;
        a.anchor = anchor;
        FF.ui.applyTheme(FF.theme.sample(adapter, anchor));
        FF.ui.showChip(chip.el, anchor);
      } else if (anchor !== a.anchor) {
        a.anchor = anchor;
        FF.ui.applyTheme(FF.theme.sample(adapter, anchor));
        FF.ui.setChipAnchor(anchor);
      }
    };
    whenSafeToMount(() => {
      if (again !== a) return;
      find();
      a.timer = setInterval(find, 500);
    });
  }
  function stopAgain() {
    if (again) { clearInterval(again.timer); again = null; }
  }

  async function askAgain() {
    const p = adapter.parse(location);
    if (!p || p.kind !== 'market') return;
    if (closeCard) closeCard();
    const prev = await FF.getMarketState(p.key);
    if (prev && prev.keepRevealed) await FF.setMarketState(p.key, { status: 'asking', at: Date.now(), keepRevealed: true });
    else await FF.clearMarketState(p.key);
    await route();
  }

  // ------------------------------------------------------------------ navigation & messages
  function onNavigate() {
    if (location.href === lastUrl) return;
    const p = adapter.parse(location);
    if (p && p.kind === 'market' && settings && settings.enabled) html.setAttribute('data-ff-blind', '');
    route();
  }
  window.addEventListener('ff-navigate', onNavigate);
  window.addEventListener('popstate', onNavigate);
  setInterval(() => { if (location.href !== lastUrl && !routing) onNavigate(); }, 500);
  window.addEventListener('pagehide', () => { try { chrome.runtime.sendMessage({ type: 'fatebookFlush' }, () => chrome.runtime.lastError); } catch (_) {} });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'sync' || (area === 'local' && changes.pausedUntil)) route();
  });

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (!msg || typeof msg.type !== 'string') return;
    if (msg.type === 'ffGetState') {
      const p = adapter.parse(location);
      sendResponse({ site: adapter.name, kind: p ? p.kind : null, key: p && p.key, blind: !!current, revealed: !!again, title: adapter.title() });
    } else if (msg.type === 'ffReveal') {
      if (current) skip(current).then(() => sendResponse({ ok: true })); else sendResponse({ ok: true });
      return true;
    } else if (msg.type === 'ffAskAgain') {
      askAgain().then(() => sendResponse({ ok: true }));
      return true;
    }
  });

  route();
})();
