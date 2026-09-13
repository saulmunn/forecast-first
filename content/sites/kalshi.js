// Forecast First — Kalshi adapter (kalshi.com)
(() => {
  'use strict';
  const FF = globalThis.__FF;
  const U = FF.util;
  const API = 'https://api.elections.kalshi.com/trade-api/v2';

  const dollars = (v) => (v == null || v === '' ? null : Number(v));
  const cents = (v) => (v == null ? null : Number(v) / 100);
  const marketProb = (m) => {
    const bid = dollars(m.yes_bid_dollars) ?? cents(m.yes_bid);
    const ask = dollars(m.yes_ask_dollars) ?? cents(m.yes_ask);
    const last = dollars(m.last_price_dollars) ?? cents(m.last_price);
    let p = null;
    if (bid != null && ask != null && ask > 0) p = (bid + ask) / 2;
    else if (ask != null && ask > 0) p = ask;
    else if (last != null) p = last;
    return p == null ? null : p * 100;
  };
  const isOpen = (m) => !m.status || /^(active|open|initialized)$/i.test(m.status);
  const visible = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };

  FF.registerAdapter({
    id: 'kalshi',
    name: 'Kalshi',
    consensusLabel: 'the market',
    consensusShort: 'Market',
    theme: {
      accent: '#28cc95',
      panelRadius: '16px',
      primaryButton: () => [...document.querySelectorAll('button, a')].find((b) => /^(sign up|deposit|trade)$/i.test(b.textContent.trim()) && b.getBoundingClientRect().width > 0),
    },
    matches: (host) => /(^|\.)kalshi\.com$/.test(host),

    parse(loc) {
      let m = loc.pathname.match(/^\/markets\/([^/?#]+)\/([^/?#]+)\/([^/?#]+)(?:\/([^/?#]+))?/);
      if (m) {
        const ticker = (m[4] || m[3]).toUpperCase();
        return { kind: 'market', key: 'kalshi:' + ticker, ticker, seriesTicker: m[1].toUpperCase(), eventTicker: m[3].toUpperCase(), marketTicker: m[4] ? m[4].toUpperCase() : null };
      }
      // /markets/{series}/{slug} shows the series' current event with the same chart + prices.
      m = loc.pathname.match(/^\/markets\/([^/?#]+)\/([^/?#]+)\/?$/);
      if (m) return { kind: 'market', key: 'kalshi:series:' + m[1].toUpperCase(), ticker: null, seriesTicker: m[1].toUpperCase() };
      return { kind: 'listing' };
    },

    // Kalshi can display prices as decimal payouts ("2.09x") or American odds ("+120"); mask those too.
    maskPatterns: [/\b\d+(?:\.\d+)?x\b/g, /(?<![\w.$])[+\-\u2212]\d{3,4}(?![\d.%])/g],
    leakyGraphics() {
      return [...document.querySelectorAll('svg[data-dd-excluded-activity-mutations], a[href^="/markets/"] svg, [class*="chart" i] svg, [class*="chart" i] canvas')]
        .filter((el) => el.getBoundingClientRect().width >= 30);
    },

    title() {
      const h1 = document.querySelector('main h1, h1');
      return U.cleanTitle((h1 && h1.textContent) || document.title);
    },

    findRegions() {
      const covers = [];
      // Headline "77.8% chance ▼7.9" — the number is an animated digit odometer.
      let header = null;
      for (const s of document.querySelectorAll('span')) {
        if (/^chance$/i.test(s.textContent.trim()) && visible(s)) {
          const block = U.growWhile(s, (p) => { const r = p.getBoundingClientRect(); return r.height <= 48 && r.width <= 520; }, 6);
          // Skip the "Chance" column header on multi-market pages: the real headline has digits next to it.
          if (block && /\d/.test(block.textContent)) { header = block; break; }
        }
      }
      // Price history chart: the largest SVG on the page, grown to include its axes.
      let chart = null;
      let best = null, bestArea = 0;
      for (const svg of document.querySelectorAll('svg')) {
        const r = svg.getBoundingClientRect();
        if (r.width > 240 && r.height > 120 && r.width * r.height > bestArea) { best = svg; bestArea = r.width * r.height; }
      }
      if (best) {
        const sr = best.getBoundingClientRect();
        chart = U.growWhile(best, (p) => { const r = p.getBoundingClientRect(); return r.height <= sr.height + 110 && r.width <= sr.width + 80; }, 8);
      }
      let anchor = chart || header;
      if (header && chart && !chart.contains(header)) covers.push({ el: header, label: 'chance hidden', small: true });

      for (const pill of document.querySelectorAll('[data-testid="price-pill"]')) {
        if (visible(pill) && !(anchor && anchor.contains(pill))) covers.push({ el: pill, label: '···', small: true });
      }
      // Order book section
      for (const el of document.querySelectorAll('h2, h3, h4, span, p, div')) {
        if (el.children.length > 1) continue;
        if (/^order ?book$/i.test(el.textContent.trim()) && visible(el)) {
          const box = U.growWhile(el, (p) => p.getBoundingClientRect().height < 520, 5);
          if (box && box !== anchor && !(anchor && anchor.contains(box)) && !box.contains(anchor)) covers.push({ el: box, label: 'order book hidden', small: true });
          break;
        }
      }
      // "$196,791 vol" inside the chart block stays visible.
      const keep = [];
      if (anchor) {
        for (const el of anchor.querySelectorAll('span, div, p')) {
          if (el.children.length > 1) continue;
          const t = el.textContent.trim();
          if (/^\$[\d,.]+\s*[kKmM]?\s*vol(ume)?\.?$/i.test(t) && el.getBoundingClientRect().height < 40) {
            keep.push(U.growWhile(el, (p) => { const r = p.getBoundingClientRect(); return r.height < 40 && !/%|¢/.test(p.textContent); }, 3));
            break;
          }
        }
      }
      return { anchor, covers, keep };
    },

    async fetchData(parsed) {
      let markets = [], title = null, exclusive = false;
      if (!parsed.ticker) {
        // Series page: use the series' first open event.
        const { events } = await FF.fetchJson(`${API}/events?series_ticker=${encodeURIComponent(parsed.seriesTicker)}&status=open&limit=1&with_nested_markets=true`);
        const event = events && events[0];
        if (!event) throw new Error('No open event for this Kalshi series');
        title = event.title;
        exclusive = !!event.mutually_exclusive;
        markets = event.markets || [];
      } else {
        try {
          const { event } = await FF.fetchJson(`${API}/events/${encodeURIComponent(parsed.ticker)}?with_nested_markets=true`);
          if (!event) throw new Error('no event');
          title = event.title;
          exclusive = !!event.mutually_exclusive;
          markets = event.markets || [];
        } catch (_) {
          const { market } = await FF.fetchJson(`${API}/markets/${encodeURIComponent(parsed.ticker)}`);
          if (!market) throw new Error('Market not found in Kalshi API');
          title = market.title;
          markets = [market];
        }
      }
      const open = markets.filter(isOpen);
      const closed = markets.length > 0 && open.length === 0;
      const use = open.length ? open : markets;
      let outcomes, binary;
      if (use.length === 1) {
        const m = use[0];
        outcomes = [{ name: 'Yes', key: m.ticker, prob: marketProb(m) }];
        binary = true;
      } else {
        outcomes = use
          .map((m) => ({ name: m.yes_sub_title || m.subtitle || m.title, key: m.ticker, prob: marketProb(m) }))
          .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
        binary = false;
      }
      // Resolution date = when the market is expected to settle (not when trading closes).
      const closeIso = use.map((m) => m.expected_expiration_time || m.expiration_time || m.close_time).filter(Boolean).sort()[0] || null;
      return { title: U.cleanTitle(title), outcomes, binary, closed, closeDate: U.toDateStr(closeIso), exclusive };
    },

    // The headline number is an odometer of stacked digits; not scrapeable reliably.
    scrapeActual() { return null; },
  });
})();
