// Forecast First — background service worker.
// Does the cross-origin fetches the content scripts can't (market data APIs, Fatebook)
// and creates Fatebook questions for forecasts that are still pending.

const ALLOWED_HOSTS = new Set([
  'gamma-api.polymarket.com',
  'api.elections.kalshi.com',
  'fatebook.io',
]);

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  handle(msg, sender).then(
    (res) => sendResponse(res),
    (err) => sendResponse({ ok: false, error: (err && err.message) || String(err) })
  );
  return true; // keep the channel open for the async response
});
chrome.runtime.onStartup.addListener(() => fatebookFlush({}).catch(() => {}));
chrome.runtime.onInstalled.addListener(() => fatebookFlush({}).catch(() => {}));

async function handle(msg) {
  switch (msg && msg.type) {
    case 'fetchJson': {
      const u = new URL(msg.url);
      if (u.protocol !== 'https:' || !ALLOWED_HOSTS.has(u.host)) throw new Error('Host not allowed: ' + u.host);
      const r = await fetch(u.toString(), { headers: { accept: 'application/json' } });
      if (!r.ok) throw new Error('HTTP ' + r.status + ' from ' + u.host);
      return { ok: true, data: await r.json() };
    }
    case 'fatebookFlush':
      return fatebookFlush(msg);
    case 'fatebookNotes':
      return fatebookNotes(msg);
    case 'openOptions':
      await chrome.runtime.openOptionsPage();
      return { ok: true };
    default:
      throw new Error('Unknown message type');
  }
}

// Fatebook public API: https://fatebook.io/api-setup
// GET /api/v0/createQuestion?apiKey&title&resolveBy&forecast&tags&notes[&sharePublicly]
// Responds 200 with the plain-text URL of the new question.
async function fatebookCreate(settings, { title, resolveBy, forecast, notes, extraTags }) {
  const apiKey = (settings.fatebookApiKey || '').trim();
  if (!apiKey) throw new Error('No Fatebook API key set (open Forecast First options).');
  const u = new URL('https://fatebook.io/api/v0/createQuestion');
  u.searchParams.set('apiKey', apiKey);
  u.searchParams.set('title', title);
  u.searchParams.set('resolveBy', resolveBy);
  // Fatebook rejects exactly 0, so clamp into (0, 1].
  u.searchParams.set('forecast', String(Math.min(1, Math.max(0.001, Number(forecast)))));
  const tags = String(settings.fatebookTags || '')
    .split(',')
    .map((t) => t.trim())
    .filter(Boolean)
    .concat(extraTags || []);
  for (const t of new Set(tags)) u.searchParams.append('tags', t);
  if (notes) u.searchParams.set('notes', notes);
  if (settings.fatebookSharePublicly) u.searchParams.set('sharePublicly', 'true');

  const r = await fetch(u.toString());
  const text = await r.text();
  if (!r.ok) {
    let detail = text;
    try { detail = JSON.parse(text).error || text; } catch (_) {}
    throw new Error(String(detail).replace(/^Error #\d+:\s*/, '').slice(0, 200) + ' (HTTP ' + r.status + ')');
  }
  return text.trim();
}

// PATCH /api/v0/editQuestion — used to attach the reasoning once the user writes it.
async function fatebookEdit(settings, questionId, patch) {
  const apiKey = (settings.fatebookApiKey || '').trim();
  const r = await fetch('https://fatebook.io/api/v0/editQuestion', {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(Object.assign({ apiKey, questionId }, patch)),
  });
  if (!r.ok) {
    const text = await r.text();
    let detail = text;
    try { detail = JSON.parse(text).error || JSON.parse(text).message || text; } catch (_) {}
    throw new Error(String(detail).slice(0, 200) + ' (HTTP ' + r.status + ')');
  }
}
// POST /api/v0/addForecast and /api/v0/addComment — repeat forecasts on a question we already logged.
async function fatebookPost(settings, path, body) {
  const apiKey = (settings.fatebookApiKey || '').trim();
  const r = await fetch('https://fatebook.io/api/v0/' + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(Object.assign({ apiKey }, body)),
  });
  if (!r.ok) {
    const text = await r.text();
    let detail = text;
    try { detail = JSON.parse(text).error || JSON.parse(text).message || text; } catch (_) {}
    throw new Error(String(detail).slice(0, 200) + ' (HTTP ' + r.status + ')');
  }
}
// The Fatebook question already created for this market + outcome by an earlier forecast, if any.
function existingQuestion(forecasts, f, outcomeName) {
  const prior = forecasts.filter((x) => x.id !== f.id && x.marketKey === f.marketKey && (x.at || 0) <= (f.at || 0)).sort((a, b) => (b.at || 0) - (a.at || 0));
  for (const x of prior) {
    const q = (x.fatebook || []).find((y) => y.url && y.name === outcomeName);
    if (q) return { url: q.url, id: q.id || questionIdFromUrl(q.url) };
  }
  return null;
}
const questionIdFromUrl = (url) => { const m = String(url || '').match(/--([a-z0-9]+)\/?$/i); return m ? m[1] : null; };
function notesFor(f, o) {
  const consensus = f.consensusLabel || 'Market';
  return [
    f.reasoning,
    o && o.actual != null ? `${consensus} when I forecast: ${o.actual}%` : '',
    `Source: ${f.url}`,
  ].filter(Boolean).join('\n');
}
function commentFor(f, o) {
  const consensus = f.consensusLabel || 'Market';
  const pct = o && o.personal != null ? `${o.personal}%` : '';
  const mkt = o && o.actual != null ? ` (${consensus.toLowerCase()} ${o.actual}%)` : '';
  return [pct ? `Updated forecast: ${pct}${mkt}` : '', f.reasoning].filter(Boolean).join('\n');
}
async function patchForecasts(results) {
  const fresh = (await chrome.storage.local.get('forecasts')).forecasts || [];
  for (const r of results) {
    const e = fresh.find((x) => x.id === r.id);
    if (e) Object.assign(e, r.patch);
  }
  await chrome.storage.local.set({ forecasts: fresh });
}

// Creates Fatebook questions for every stored forecast still marked fatebookPending
// (optionally just one id). Serialized so concurrent callers can't double-create.
let flushChain = Promise.resolve();
const chained = (run) => { flushChain = flushChain.then(run, run); return flushChain; };
function fatebookFlush({ id } = {}) {
  return chained(async () => {
    const settings = await chrome.storage.sync.get(['fatebookApiKey', 'fatebookTags', 'fatebookSharePublicly']);
    if (!(settings.fatebookApiKey || '').trim()) return { ok: true, results: [], skipped: 'no-key' };
    const { forecasts = [] } = await chrome.storage.local.get('forecasts');
    const targets = forecasts.filter((f) => f.fatebookPending && (!id || f.id === id));
    const results = [];
    for (const f of targets) {
      const done = (f.fatebook || []).filter((x) => x.url);
      for (const o of f.outcomes || []) {
        if (o.personal == null || done.some((x) => x.name === o.name)) continue;
        const title = /^yes$/i.test(o.name) ? f.title : `${f.title} — ${o.name}`;
        const forecast = Math.min(1, Math.max(0.001, o.personal / 100));
        const prev = existingQuestion(forecasts, f, o.name);
        try {
          if (prev && prev.id) {
            // Same question as before: add a forecast to it instead of creating a duplicate.
            try {
              await fatebookPost(settings, 'addForecast', { questionId: prev.id, forecast });
              done.push({ name: o.name, url: prev.url, id: prev.id, updated: true });
              continue;
            } catch (e) {
              if (/HTTP 5\d\d|Failed to fetch|NetworkError/i.test(e.message)) throw e; // transient: retry later, don't duplicate
              // otherwise (deleted / unknown question) fall through and create a fresh one
            }
          }
          const url = await fatebookCreate(settings, { title, resolveBy: f.resolveBy, forecast, notes: notesFor(f, o), extraTags: [f.site] });
          done.push({ name: o.name, url, id: questionIdFromUrl(url) });
        } catch (e) {
          done.push({ name: o.name, error: (e && e.message) || String(e) });
        }
      }
      const failed = done.filter((x) => x.error);
      // Retry later only for network-type failures; API rejections (bad key, bad date) won't fix themselves.
      const retry = failed.some((x) => /Failed to fetch|NetworkError|HTTP 5\d\d/i.test(x.error));
      results.push({ id: f.id, fatebook: done, fatebookPending: retry, patch: { fatebook: done, fatebookPending: retry } });
    }
    if (results.length) await patchForecasts(results);
    return { ok: true, results: results.map(({ id, fatebook, fatebookPending }) => ({ id, fatebook, fatebookPending })) };
  });
}

// Pushes the (possibly updated) reasoning into the notes of the already-created Fatebook question(s).
// If creation is still pending, the create call above will carry the reasoning itself.
function fatebookNotes({ id }) {
  return chained(async () => {
    const settings = await chrome.storage.sync.get(['fatebookApiKey']);
    if (!(settings.fatebookApiKey || '').trim()) return { ok: true, skipped: 'no-key' };
    const { forecasts = [] } = await chrome.storage.local.get('forecasts');
    const f = forecasts.find((x) => x.id === id);
    if (!f) return { ok: true, skipped: 'unknown-id' };
    const out = [];
    for (const q of f.fatebook || []) {
      const qid = q.id || questionIdFromUrl(q.url);
      if (!qid) continue;
      const o = (f.outcomes || []).find((x) => x.name === q.name);
      try {
        // A question we created gets the reasoning in its notes; a question we only added a forecast to gets a comment.
        if (q.updated) {
          if (f.reasoning) await fatebookPost(settings, 'addComment', { questionId: qid, comment: commentFor(f, o) });
        } else await fatebookEdit(settings, qid, { notes: notesFor(f, o) });
        out.push({ name: q.name, ok: true });
      } catch (e) { out.push({ name: q.name, error: (e && e.message) || String(e) }); }
    }
    return { ok: true, results: out };
  });
}
