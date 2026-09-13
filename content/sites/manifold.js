// Forecast First — Manifold Markets adapter (manifold.markets)
(() => {
  'use strict';
  const FF = globalThis.__FF;
  const U = FF.util;
  const API = 'https://api.manifold.markets/v0';
  // First path segments that are site sections rather than usernames.
  const NOT_USERS = new Set(['browse', 'search', 'questions', 'markets', 'leagues', 'about', 'help', 'notifications', 'profile', 'messages', 'create', 'home', 'prize', 'prize-drawing', 'app', 'predictle', 'sitemap', 'embed', 'charity', 'live', 'dashboard', 'news', 'election', 'ai', 'api', 'signin', 'login', 'group', 'groups', 'topic', 'topics', 'referrals', 'link', 'labs', 'stats', 'privacy', 'terms', 'payments', 'redeem', 'checkout', 'shop', 'explore', 'partner', 'admin', 'og', 'calibration', 'buy-mana', 'ads', 'teams', 'styles', 'tv', 'portfolio', 'trades', 'comments', 'leaderboards', 'newsletter', 'contact', 'careers', 'twitch', 'discord', 'faq', 'welcome', 'onboarding', 'add-funds', 'my-profile', 'legal']);
  const visible = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
  const pct = (p) => (p == null || Number.isNaN(Number(p)) ? null : Number(p) * 100);

  // "21% chance" headline of a binary market (related-market cards repeat it in small print; skip those).
  function chanceBlock() {
    for (const s of document.querySelectorAll('span, div, p')) {
      if (!/^chance$/i.test(s.textContent.trim()) || !visible(s) || s.closest('a, aside')) continue;
      if (s.getBoundingClientRect().height < 18) continue;
      return U.growWhile(s, (p, cur) => cur.getBoundingClientRect().height < 60, 3);
    }
    return null;
  }
  function chartBlock() {
    let best = null, area = 0;
    for (const svg of document.querySelectorAll('svg')) {
      const r = svg.getBoundingClientRect();
      if (r.width > 200 && r.height > 80 && r.width * r.height > area && !svg.closest('a')) { best = svg; area = r.width * r.height; }
    }
    if (!best) return null;
    const sr = best.getBoundingClientRect();
    return U.growWhile(best, (p) => { const r = p.getBoundingClientRect(); return r.height <= sr.height + 120 && r.width <= sr.width + 60; }, 6);
  }

  FF.registerAdapter({
    id: 'manifold',
    name: 'Manifold',
    consensusLabel: 'the market',
    consensusShort: 'Market',
    theme: {
      accent: '#4f46e5',
      panelRadius: '12px',
      primaryButton: () => [...document.querySelectorAll('button, a')].find((b) => /^(sign up|bet yes|trade)/i.test(b.textContent.trim()) && b.getBoundingClientRect().width > 0),
    },
    matches: (host) => /(^|\.)manifold\.markets$/.test(host),
    parse(loc) {
      const m = loc.pathname.match(/^\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_-]+)\/?$/);
      if (m && !NOT_USERS.has(m[1].toLowerCase())) return { kind: 'market', key: 'manifold:' + m[2], slug: m[2], user: m[1] };
      return { kind: 'listing' };
    },
    // Answer rows are filled proportionally to their probability: a plain div with an inline percentage width.
    leakyGraphics() {
      const out = [];
      for (const el of document.querySelectorAll('[style*="width"]')) {
        // inline width like "96%" or "max(8px, 96%)"
        if (el.tagName === 'svg' || el.children.length || !/\d+(?:\.\d+)?%/.test(el.style.width)) continue;
        const r = el.getBoundingClientRect();
        if (r.height >= 12 && r.height <= 80 && r.width >= 2) out.push(el);
      }
      return out;
    },
    title() { return U.cleanTitle(document.title); },

    findRegions() {
      const chance = chanceBlock();
      const chart = chartBlock();
      let anchor = null;
      if (chance && chart) {
        const ca = U.commonAncestor(chance, chart);
        anchor = ca && ca.getBoundingClientRect().height < 520 ? ca : chart;
      } else anchor = chart || chance;
      const covers = [];
      if (anchor && chance && !anchor.contains(chance)) covers.push({ el: chance, label: 'hidden', small: true });
      return { anchor, covers };
    },

    async fetchData(parsed) {
      const m = await FF.fetchJson(`${API}/slug/${encodeURIComponent(parsed.slug)}`);
      if (!m || !m.id) throw new Error('Market not found in Manifold API');
      const title = U.cleanTitle(m.question);
      const closeDate = U.toDateStr(m.resolutionTime || m.closeTime);
      const closed = !!m.isResolved || !!(m.closeTime && m.closeTime < Date.now());
      if (m.outcomeType === 'BINARY') {
        return { title, outcomes: [{ name: 'Yes', key: m.id, prob: pct(m.probability) }], binary: true, closed, closeDate };
      }
      if (m.outcomeType === 'MULTIPLE_CHOICE' && Array.isArray(m.answers)) {
        const outcomes = m.answers
          .map((a) => ({ name: String(a.text), key: a.id, prob: pct(a.probability) }))
          .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
        return { title, outcomes, binary: false, closed, closeDate, exclusive: m.shouldAnswersSumToOne !== false };
      }
      // numeric, poll, bounty… — a single probability doesn't fit
      return { title, outcomes: [], binary: false, closed, closeDate };
    },

    scrapeActual() {
      const c = chanceBlock();
      const t = c && c.textContent.match(/(\d+(?:\.\d+)?)%/);
      return t ? { __single: Number(t[1]) } : null;
    },
  });
})();
