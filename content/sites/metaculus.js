// Forecast First — Metaculus adapter (metaculus.com)
(() => {
  'use strict';
  const FF = globalThis.__FF;
  const U = FF.util;
  const visible = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };

  function gaugeBlock() {
    const scope = document.querySelector('main') || document.body;
    if (!scope) return null;
    for (const s of scope.querySelectorAll('span')) {
      // Skip gauges inside related-question cards (they're wrapped in links) and sidebars.
      if (/^chance$/i.test(s.textContent.trim()) && visible(s) && !s.closest('a, aside')) {
        return U.growWhile(s, (p, cur) => cur.getBoundingClientRect().height < 140, 6);
      }
    }
    return null;
  }
  function chartBlock() {
    const vc = [...document.querySelectorAll('.VictoryContainer')].find(visible);
    if (!vc) return null;
    return U.growWhile(vc, (p, cur) => cur.getBoundingClientRect().height < 175, 5);
  }

  FF.registerAdapter({
    id: 'metaculus',
    name: 'Metaculus',
    consensusLabel: 'the community forecast',
    consensusShort: 'Community',
    theme: {
      accent: '#3b82f6',
      panelRadius: '10px',
      primaryButton: () => [...document.querySelectorAll('button, a')].find((b) => /^(predict|sign up|make a prediction)$/i.test(b.textContent.trim()) && b.getBoundingClientRect().width > 0),
    },
    matches: (host) => /(^|\.)metaculus\.com$/.test(host),

    parse(loc) {
      let m = loc.pathname.match(/^\/questions\/(\d+)/) || loc.pathname.match(/^\/c\/[^/]+\/(\d+)/);
      if (m) return { kind: 'market', key: 'metaculus:' + m[1], id: m[1] };
      return { kind: 'listing' };
    },

    // Gauges (arc + needle) and sparklines on question cards and in the sidebar.
    leakyGraphics() {
      const out = [...document.querySelectorAll('.VictoryContainer svg, .VictoryContainer canvas')];
      for (const s of document.querySelectorAll('span')) {
        if (!/^chance$/i.test(s.textContent.trim())) continue;
        let n = s;
        for (let i = 0; i < 4 && n; i++) {
          const svgs = n.querySelectorAll ? n.querySelectorAll('svg') : [];
          if (svgs.length) { out.push(...svgs); break; }
          n = n.parentElement;
        }
      }
      return out;
    },

    title() {
      const h1 = document.querySelector('main h1, h1');
      return U.cleanTitle((h1 && h1.textContent) || document.title);
    },

    findRegions() {
      const gauge = gaugeBlock();
      const chart = chartBlock();
      let anchor = null;
      if (gauge && chart) {
        const ca = U.commonAncestor(gauge, chart);
        anchor = ca && ca.getBoundingClientRect().height < 420 ? ca : chart;
      } else anchor = chart || gauge;
      const covers = [];
      if (anchor && gauge && !anchor.contains(gauge)) covers.push({ el: gauge, label: 'hidden', small: true });
      return { anchor, covers };
    },

    async fetchData(parsed) {
      let post = null;
      try {
        const r = await fetch(`/api/posts/${parsed.id}/?with_cp=true`, { credentials: 'include', headers: { accept: 'application/json' } });
        if (r.ok) post = await r.json();
      } catch (_) { /* fall through to DOM-only mode */ }

      if (!post) {
        // Not logged in (API needs auth): binary if the page has a "% CHANCE" gauge; actual is scraped later.
        const binary = !!gaugeBlock();
        return { title: this.title(), outcomes: binary ? [{ name: 'Yes', key: 'yes', prob: null }] : [], binary, closed: false, closeDate: null, viaDom: true };
      }
      const q = post.question;
      const status = post.status || (q && q.status);
      const closed = !!status && !/^(open|upcoming|approved)$/i.test(status);
      const closeDate = U.toDateStr((q && (q.scheduled_resolve_time || q.scheduled_close_time)) || post.scheduled_resolve_time || post.scheduled_close_time);
      if (!q) return { title: U.cleanTitle(post.title), outcomes: [], binary: false, closed, closeDate };
      const latest = q.aggregations && q.aggregations.recency_weighted && q.aggregations.recency_weighted.latest;
      if (q.type === 'binary') {
        const c = latest && latest.centers && latest.centers[0];
        return { title: U.cleanTitle(post.title || q.title), outcomes: [{ name: 'Yes', key: 'yes', prob: c == null ? null : c * 100 }], binary: true, closed, closeDate };
      }
      if (q.type === 'multiple_choice' && Array.isArray(q.options)) {
        const vals = (latest && (latest.forecast_values || latest.centers)) || [];
        const outcomes = q.options.map((o, i) => ({ name: String(o), key: String(o), prob: vals[i] == null ? null : vals[i] * 100 }));
        return { title: U.cleanTitle(post.title || q.title), outcomes, binary: false, closed, closeDate, exclusive: true };
      }
      return { title: U.cleanTitle(post.title || q.title), outcomes: [], binary: false, closed, closeDate };
    },

    scrapeActual() {
      const g = gaugeBlock();
      const m = g && g.textContent.match(/(<?\d+(?:\.\d+)?)%/);
      if (!m) return null;
      const n = Number(m[1].replace('<', ''));
      return Number.isFinite(n) ? { __single: n } : null;
    },
  });
})();
