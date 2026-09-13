// Forecast First — runs in the page's MAIN world only to announce SPA navigations
// (history.pushState/replaceState) to the isolated-world content script via a DOM event.
(() => {
  if (window.__ffNavHooked) return;
  window.__ffNavHooked = true;
  const fire = () => { try { window.dispatchEvent(new CustomEvent('ff-navigate')); } catch (_) {} };
  for (const k of ['pushState', 'replaceState']) {
    const orig = history[k];
    if (typeof orig !== 'function') continue;
    history[k] = function () { const r = orig.apply(this, arguments); fire(); return r; };
  }
  window.addEventListener('popstate', fire);
})();
