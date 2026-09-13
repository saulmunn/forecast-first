const $ = (id) => document.getElementById(id);

async function load() {
  const sync = await chrome.storage.sync.get(['enabled', 'fatebookApiKey']);
  const local = await chrome.storage.local.get(['pausedUntil', 'forecasts']);
  const enabled = sync.enabled !== false;
  $('enabled').classList.toggle('on', enabled);
  $('enabled').setAttribute('aria-checked', String(enabled));
  const paused = local.pausedUntil && local.pausedUntil > Date.now();
  $('pauseText').textContent = paused ? 'Paused until ' + new Date(local.pausedUntil).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : 'Temporarily show everything';
  $('pauseBtn').textContent = paused ? 'Resume now' : 'Pause 1 hour';
  $('count').textContent = (local.forecasts || []).length;
  $('fbWarn').hidden = !!(sync.fatebookApiKey && sync.fatebookApiKey.trim());

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || !tab.id) return;
  chrome.tabs.sendMessage(tab.id, { type: 'ffGetState' }, (state) => {
    if (chrome.runtime.lastError || !state) return; // not a supported site
    $('page').hidden = false;
    $('pageSite').textContent = state.site + (state.kind === 'market' ? ' · question page' : ' · browsing');
    $('pageTitle').textContent = state.kind === 'market' ? state.title || '' : 'Probabilities are masked while browsing';
    $('revealBtn').hidden = !state.blind;
    $('againBtn').hidden = !(state.kind === 'market' && !state.blind);
    $('revealBtn').onclick = () => chrome.tabs.sendMessage(tab.id, { type: 'ffReveal' }, () => window.close());
    $('againBtn').onclick = () => chrome.tabs.sendMessage(tab.id, { type: 'ffAskAgain' }, () => window.close());
  });
}

$('enabled').addEventListener('click', async () => {
  const { enabled } = await chrome.storage.sync.get('enabled');
  await chrome.storage.sync.set({ enabled: enabled === false });
  load();
});
$('enabled').addEventListener('keydown', (e) => { if (e.key === ' ' || e.key === 'Enter') $('enabled').click(); });
$('pauseBtn').addEventListener('click', async () => {
  const { pausedUntil } = await chrome.storage.local.get('pausedUntil');
  const paused = pausedUntil && pausedUntil > Date.now();
  await chrome.storage.local.set({ pausedUntil: paused ? 0 : Date.now() + 3600e3 });
  load();
});
$('optionsBtn').addEventListener('click', () => chrome.runtime.openOptionsPage());
load();
