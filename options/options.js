const DEFAULTS = {
  enabled: true, maskListings: true,
  reaskHours: 24, topMassPct: 95, defaultResolveDays: 30, fatebookApiKey: '', fatebookTags: 'forecast-first', fatebookSharePublicly: false,
};
const $ = (id) => document.getElementById(id);
const fields = ['fatebookApiKey', 'fatebookTags', 'fatebookSharePublicly', 'defaultResolveDays', 'maskListings', 'reaskHours', 'topMassPct', 'enabled'];

async function loadSettings() {
  const stored = await chrome.storage.sync.get(null);
  if (stored.reaskHours == null && stored.skipCooldownHours != null) stored.reaskHours = stored.skipCooldownHours; // pre-0.4 name
  const s = Object.assign({}, DEFAULTS, stored);
  for (const f of fields) {
    const el = $(f);
    if (el.type === 'checkbox') el.checked = !!s[f];
    else el.value = s[f];
  }
}
let saveTimer = 0;
function scheduleSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(async () => {
    const out = {};
    for (const f of fields) {
      const el = $(f);
      out[f] = el.type === 'checkbox' ? el.checked : el.type === 'number' ? Number(el.value) : el.value;
    }
    out.fatebookApiKey = out.fatebookApiKey.trim();
    out.reaskHours = Number(out.reaskHours);
    out.topMassPct = Math.min(100, Math.max(1, Number(out.topMassPct) || 95));
    await chrome.storage.sync.set(out);
    $('saved').hidden = false;
    setTimeout(() => ($('saved').hidden = true), 1500);
  }, 250);
}
for (const f of fields) $(f).addEventListener('input', scheduleSave);
for (const f of fields) $(f).addEventListener('change', scheduleSave);
$('showKey').addEventListener('click', () => {
  const k = $('fatebookApiKey');
  k.type = k.type === 'password' ? 'text' : 'password';
  $('showKey').textContent = k.type === 'password' ? 'show' : 'hide';
});

const fmt = (p) => (p == null ? '—' : (Number.isInteger(Math.round(p * 10) / 10) ? Math.round(p) : (Math.round(p * 10) / 10).toFixed(1)) + '%');
const esc = (s) => String(s == null ? '' : s);

function rowsFor(entry) {
  const outs = entry.outcomes && entry.outcomes.length ? entry.outcomes : [{ name: '', personal: null, guess: null, actual: null }];
  return outs.map((o, i) => ({ entry, o, first: i === 0, multi: outs.length > 1 }));
}

async function loadHistory() {
  const { forecasts = [] } = await chrome.storage.local.get('forecasts');
  const tbody = $('hist').querySelector('tbody');
  tbody.textContent = '';
  $('histCount').textContent = forecasts.length;
  $('histEmpty').hidden = forecasts.length > 0;
  const sorted = [...forecasts].sort((a, b) => b.at - a.at);
  for (const entry of sorted) {
    for (const { o, first, multi } of rowsFor(entry)) {
      const tr = document.createElement('tr');
      const td = (cls, content) => { const c = document.createElement('td'); if (cls) c.className = cls; if (content instanceof Node) c.appendChild(content); else c.textContent = content; tr.appendChild(c); return c; };
      td('', first ? new Date(entry.at).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }) : '');
      td('', first ? entry.siteName || entry.site : '');
      const q = document.createElement('div');
      if (first) { const a = document.createElement('a'); a.href = entry.url; a.target = '_blank'; a.rel = 'noopener'; a.textContent = entry.title || entry.url; q.appendChild(a); }
      if (multi || (o.name && o.name !== 'Yes')) { const s = document.createElement('div'); s.className = 'sub'; s.textContent = o.name; q.appendChild(s); }
      if (entry.freeText) { const s = document.createElement('div'); s.className = 'sub'; s.textContent = 'Estimate: ' + entry.freeText; q.appendChild(s); }
      td('q', q);
      td('num', fmt(o.personal));
      td('num', fmt(o.actual));
      const diff = o.personal != null && o.actual != null ? Math.round((o.personal - o.actual) * 10) / 10 : null;
      const dspan = document.createElement('span');
      if (diff != null) { dspan.textContent = (diff > 0 ? '+' : '') + diff; dspan.className = Math.abs(diff) < 0.5 ? 'same' : diff > 0 ? 'up' : 'down'; } else dspan.textContent = '—';
      td('num', dspan);
      td('txt', first ? [entry.reasoning, entry.reflection].filter(Boolean).join('\n') : '');
      const fb = document.createElement('div');
      const links = (entry.fatebook || []).filter((f) => !multi || f.name === o.name);
      for (const f of links) {
        if (f.url) { const a = document.createElement('a'); a.href = f.url; a.target = '_blank'; a.rel = 'noopener'; a.textContent = 'open ↗'; fb.appendChild(a); }
        else if (f.error) { const s = document.createElement('div'); s.className = 'err'; s.textContent = f.error; fb.appendChild(s); }
      }
      if (!links.length && entry.fatebookPending && first) { const s = document.createElement('span'); s.className = 'muted'; s.textContent = 'pending'; fb.appendChild(s); }
      td('', fb);
      tbody.appendChild(tr);
    }
  }
}

function download(name, text, type) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type }));
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}
$('exportJson').addEventListener('click', async () => {
  const { forecasts = [] } = await chrome.storage.local.get('forecasts');
  download('forecast-first.json', JSON.stringify(forecasts, null, 2), 'application/json');
});
$('exportCsv').addEventListener('click', async () => {
  const { forecasts = [] } = await chrome.storage.local.get('forecasts');
  const cell = (v) => '"' + esc(v).replace(/"/g, '""') + '"';
  const lines = [['when', 'site', 'title', 'outcome', 'your_probability', 'market_probability', 'diff', 'your_guess_of_market', 'reasoning', 'reflection', 'estimate_text', 'url', 'fatebook_url', 'resolve_by'].join(',')];
  for (const e of forecasts) {
    for (const { o } of rowsFor(e)) {
      const fb = (e.fatebook || []).find((f) => f.name === o.name || (e.outcomes || []).length === 1) || {};
      const diff = o.personal != null && o.actual != null ? Math.round((o.personal - o.actual) * 10) / 10 : '';
      lines.push([new Date(e.at).toISOString(), e.site, e.title, o.name, o.personal ?? '', o.actual ?? '', diff, o.guess ?? '', e.reasoning, e.reflection, e.freeText, e.url, fb.url || '', e.resolveBy].map(cell).join(','));
    }
  }
  download('forecast-first.csv', lines.join('\n'), 'text/csv');
});
$('clearHistory').addEventListener('click', async () => {
  if (!confirm('Delete all locally stored forecasts? (Fatebook questions are not affected.)')) return;
  await chrome.storage.local.set({ forecasts: [] });
  loadHistory();
});
$('forgetMarkets').addEventListener('click', async () => {
  const all = await chrome.storage.local.get(null);
  const keys = Object.keys(all).filter((k) => k.startsWith('m:'));
  if (!keys.length) return alert('Nothing to forget yet.');
  if (!confirm(`Ask again on ${keys.length} question(s) you've already answered or skipped?`)) return;
  await chrome.storage.local.remove(keys);
  alert('Done — those questions will hide their probabilities again.');
});

loadSettings();
loadHistory();
chrome.storage.onChanged.addListener((changes, area) => { if (area === 'local' && changes.forecasts) loadHistory(); });
