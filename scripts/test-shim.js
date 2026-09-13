// Test harness only: fakes the chrome.* APIs so the content scripts can run when
// pasted into a page's console (no extension install needed). Not shipped.
(() => {
  const mem = { sync: { fatebookApiKey: 'TEST-KEY' }, local: {} };
  const listeners = [];
  const mkArea = (name) => ({
    async get(keys) {
      const src = mem[name];
      if (keys == null) return { ...src };
      const ks = typeof keys === 'string' ? [keys] : Array.isArray(keys) ? keys : Object.keys(keys);
      const out = {};
      for (const k of ks) if (k in src) out[k] = src[k];
      return out;
    },
    async set(obj) { const changes = {}; for (const [k, v] of Object.entries(obj)) { changes[k] = { oldValue: mem[name][k], newValue: v }; mem[name][k] = v; } listeners.forEach((l) => l(changes, name)); },
    async remove(keys) { const ks = typeof keys === 'string' ? [keys] : keys; const changes = {}; for (const k of ks) { changes[k] = { oldValue: mem[name][k] }; delete mem[name][k]; } listeners.forEach((l) => l(changes, name)); },
  });
  const msgListeners = [];
  async function background(msg) {
    if (msg.type === 'fetchJson') { const r = await fetch(msg.url); if (!r.ok) throw new Error('HTTP ' + r.status); return { ok: true, data: await r.json() }; }
    if (msg.type === 'fatebookFlush') {
      await new Promise((r) => setTimeout(r, 500));
      const list = mem.local.forecasts || [];
      const results = [];
      for (const f of list) {
        if (!f.fatebookPending || (msg.id && f.id !== msg.id)) continue;
        f.fatebook = f.outcomes.filter((o) => o.personal != null).map((o) => ({ name: o.name, url: 'https://fatebook.io/q/test--' + encodeURIComponent(o.name), id: 'test' + encodeURIComponent(o.name) }));
        f.fatebookPending = false;
        console.log('[FF test] fatebookFlush', JSON.stringify({ title: f.title, reasoning: f.reasoning, outcomes: f.outcomes }));
        results.push({ id: f.id, fatebook: f.fatebook, fatebookPending: false });
      }
      return { ok: true, results };
    }
    if (msg.type === 'fatebookNotes') {
      await new Promise((r) => setTimeout(r, 400));
      const f = (mem.local.forecasts || []).find((x) => x.id === msg.id);
      console.log('[FF test] fatebookNotes', JSON.stringify({ reasoning: f && f.reasoning, fatebook: f && f.fatebook }));
      return { ok: true, results: (f ? f.fatebook : []).map((q) => ({ name: q.name, ok: true })) };
    }
    if (msg.type === 'openOptions') { console.log('[FF test] openOptions'); return { ok: true }; }
    throw new Error('unknown');
  }
  globalThis.chrome = {
    storage: { sync: mkArea('sync'), local: mkArea('local'), onChanged: { addListener: (l) => listeners.push(l) } },
    runtime: {
      lastError: null,
      sendMessage(msg, cb) { background(msg).then((r) => cb && cb(r), (e) => cb && cb({ ok: false, error: e.message })); },
      onMessage: { addListener: (l) => msgListeners.push(l) },
      openOptionsPage() {},
    },
  };
  globalThis.__ffTest = { mem, send: (msg) => new Promise((res) => msgListeners.forEach((l) => l(msg, {}, res))) };
})();
