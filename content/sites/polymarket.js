// Forecast First — Polymarket adapter (polymarket.com, polymarket.us)
(() => {
  'use strict';
  const FF = globalThis.__FF;
  const U = FF.util;
  const GAMMA = 'https://gamma-api.polymarket.com';

  const parsePrices = (m) => {
    try { return JSON.parse(m.outcomePrices || '[]').map(Number); } catch (_) { return []; }
  };
  // Polymarket displays the midpoint rounded to a whole percent (1 decimal under 1%).
  const displayPct = (p) => (p == null || Number.isNaN(p) ? null : p * 100 < 1 ? Math.round(p * 1000) / 10 : Math.round(p * 100));
  const parseOutcomes = (m) => {
    try { return JSON.parse(m.outcomes || '[]'); } catch (_) { return []; }
  };

  FF.registerAdapter({
    id: 'polymarket',
    name: 'Polymarket',
    consensusLabel: 'the market',
    consensusShort: 'Market',
    theme: {
      accent: '#2f5cff',
      panelRadius: '12px',
      primaryButton: () => [...document.querySelectorAll('#trade-widget button')].find((b) => /^(trade|buy|log in|sign up)$/i.test(b.textContent.trim()))
        || document.querySelector('.trading-button[data-color="green"]'),
    },
    matches: (host) => /(^|\.)polymarket\.(com|us)$/.test(host),

    parse(loc) {
      const path = loc.pathname;
      let m = path.match(/^\/event\/([^/?#]+)(?:\/([^/?#]+))?/);
      if (m) return { kind: 'market', key: 'polymarket:event:' + m[1], eventSlug: m[1], marketSlug: m[2] || null };
      m = path.match(/^\/market\/([^/?#]+)/);
      if (m) return { kind: 'market', key: 'polymarket:market:' + m[1], marketSlug: m[1] };
      return { kind: 'listing' };
    },

    // Card gauges/donuts next to a market link.
    leakyGraphics() {
      const out = [];
      for (const a of document.querySelectorAll('a[href^="/event/"], a[href^="/market/"]')) {
        let card = a;
        for (let i = 0; i < 3 && card.parentElement; i++) card = card.parentElement;
        for (const g of card.querySelectorAll('svg, canvas')) {
          const r = g.getBoundingClientRect();
          if (r.width >= 24 && r.height >= 12 && !g.closest('button, [role="button"]')) out.push(g);
        }
      }
      return out;
    },

    title() {
      const h1 = document.querySelector('#event-detail-container h1, main h1, h1');
      return U.cleanTitle((h1 && h1.textContent) || document.title);
    },

    findRegions() {
      const covers = [];
      const chart = document.getElementById('group-chart-container');
      // The chart's parent also holds the "17% chance" headline / outcome legend.
      const anchor = chart ? chart.parentElement || chart : null;

      const buttons = document.getElementById('outcome-buttons');
      if (buttons) covers.push({ el: buttons, label: 'prices hidden', small: true });

      // FAQ accordion leaks "What does a price of 17¢ mean" / "current frontrunner is …".
      for (const sec of document.querySelectorAll('section')) {
        if (/frequently asked questions/i.test(sec.textContent.slice(0, 200))) covers.push({ el: sec, label: 'FAQ hidden (mentions the price)', small: true });
      }
      // Order book / positions widgets, if present as labelled sections.
      for (const el of document.querySelectorAll('h2, h3, [role="tab"], button')) {
        const t = el.textContent.trim();
        if (/^order book$/i.test(t) && el.getBoundingClientRect().height > 0) {
          const box = U.growWhile(el, (p) => p.getBoundingClientRect().height < 400 && p.id !== 'event-detail-container', 4);
          if (box && box !== anchor && !(anchor && anchor.contains(box))) covers.push({ el: box, label: 'order book hidden', small: true });
        }
      }
      // The chart's footer row (volume, end date, time-range buttons) carries no probability.
      const keep = anchor ? [...anchor.children].filter((k) => /\bvol\b/i.test(k.textContent) && !/%/.test(k.textContent)) : [];
      return { anchor, covers, keep };
    },

    async fetchData(parsed) {
      let markets = [], title = null, endDate = null, closedAll = false, exclusive = false;
      if (parsed.eventSlug) {
        const events = await FF.fetchJson(`${GAMMA}/events?slug=${encodeURIComponent(parsed.eventSlug)}`);
        const e = Array.isArray(events) ? events[0] : null;
        if (!e) throw new Error('Event not found in Gamma API');
        title = e.title;
        endDate = e.endDate;
        exclusive = !!(e.negRisk || e.enableNegRisk);
        const all = e.markets || [];
        markets = all.filter((m) => !m.closed && m.active !== false);
        closedAll = all.length > 0 && markets.length === 0;
        if (e.closed) closedAll = true;
      } else {
        const ms = await FF.fetchJson(`${GAMMA}/markets?slug=${encodeURIComponent(parsed.marketSlug)}`);
        const m = Array.isArray(ms) ? ms[0] : null;
        if (!m) throw new Error('Market not found in Gamma API');
        title = m.question;
        endDate = m.endDate;
        markets = [m];
        closedAll = !!m.closed;
      }

      let outcomes = [];
      let binary = true;
      if (markets.length === 1) {
        const m = markets[0];
        const names = parseOutcomes(m), prices = parsePrices(m);
        if (names.length === 2 && /^yes$/i.test(names[0])) {
          outcomes = [{ name: 'Yes', key: String(m.id), prob: displayPct(prices[0]) }];
        } else {
          // Two named outcomes (e.g. team A vs team B): ask about the first one.
          outcomes = names.map((n, i) => ({ name: n, key: String(m.id) + ':' + i, prob: displayPct(prices[i]) }));
          binary = outcomes.length === 1;
        }
      } else if (markets.length > 1) {
        outcomes = markets
          .map((m) => ({ name: m.groupItemTitle || m.question, key: String(m.id), prob: displayPct(parsePrices(m)[0]) }))
          // Sort alphabetically so the ordering itself doesn't leak the ranking.
          .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
        binary = false;
      }
      return { title: U.cleanTitle(title), outcomes, binary, closed: closedAll, closeDate: U.toDateStr(endDate), exclusive };
    },

    // Fallback: read "17% chance" from the (hidden) DOM.
    scrapeActual() {
      const root = document.getElementById('event-detail-container') || document.body;
      if (!root) return null;
      const m = root.innerText.match(/(<?\d+(?:\.\d+)?)%\s*chance/i);
      if (!m) return null;
      const n = Number(m[1].replace('<', ''));
      return Number.isFinite(n) ? { __single: n } : null;
    },
  });
})();
