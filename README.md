# Forecast First

A Chrome extension that makes you guess before you look.

On **Polymarket**, **Kalshi**, **Metaculus** and **Manifold** it hides the market price / community forecast (the big percentage, the price chart, the Yes/No price buttons, the order book) until you've written down your own number. After you submit, the page is revealed and a card tells you whether you were higher or lower than the market, and lets you jot down why. Every forecast is also logged to **Fatebook** through its API.

## Install (unpacked)

1. Get the code: `git clone https://github.com/saulmunn/forecast-first.git` (or download the ZIP from GitHub and unpack it).
2. Open `chrome://extensions` and turn on **Developer mode** (top right).
3. Click **Load unpacked** and pick the `forecast-first` folder.
4. Click the extension's icon → **History & settings**, and paste your Fatebook API key from <https://fatebook.io/api-setup>.

After editing any file, hit the ↻ reload button on the extension card in `chrome://extensions`.

## How it works

- **On a question page** (`polymarket.com/event/…`, `kalshi.com/markets/…/…/…`, `metaculus.com/questions/…`, `manifold.markets/<user>/<slug>`) the price/forecast regions (headline percentage, price chart, Yes/No price buttons, order book) are blanked before first paint. A small panel styled to match the site sits over the chart: `[    ]%  Submit · Reveal`. Type your probability and press ⏎ or **Submit** (the button only appears once you've typed something); **Reveal** just shows the page without recording anything.
- **After revealing**, a compact card shows `Market 17% · You 25% · ▲ 8 higher` (Metaculus says "Community") with a single box: *Why the gap?* The Fatebook question is created the moment you submit; whatever you write in the box is saved to your history and patched into the question's notes when you press **Save**. Cmd/Ctrl-⏎ saves, Esc dismisses.
- **Forecast again**: once a question is revealed, a small pill sits in the corner of the chart area — `◌ Forecast again · Daily ●`. *Forecast again* hides the probability right away and asks for a fresh number; the *Daily* switch controls whether this particular question hides itself again on schedule (see below). Repeat forecasts go to the *same* Fatebook question as new forecasts (with your new reasoning as a comment) rather than creating duplicates.
- **Multi-outcome markets** ("Who will win?", Kalshi ranges, Metaculus and Manifold multiple choice): an input sits *in the site's own outcome list*, on each row — over the row's percentage, or over its price button when the row shows none. You only have to price the **likeliest outcomes**: the ones that together make up the top 95% of the market's probability (a setting; the long tail under 5% is never required). Those inputs glow in the site's accent colour and the panel counts them down (`3 more ↓`); everything else is optional, and Σ shows your running total. Whatever you leave blank goes to Fatebook as a single "Other". If the rows can't be found on the page, the panel lists just the required outcomes. A market with exactly two mutually exclusive outcomes (a game, "cut / no cut") is asked as a single number for the first one, e.g. `Ohio St. [    ]%`.
- The panel **docks to the bottom of the window** whenever its natural spot is out of view — scrolled away or hidden under a sticky header — so Submit stays in reach (⏎ in any box also submits). It sits above fixed bottom bars like Kalshi's tab bar.
- **Volume and forecaster counts are never hidden**: the "$139M Vol." row under a Polymarket chart, Kalshi's "$30M vol", Metaculus's "13 forecasters" stay visible inside the blanked regions.
- **Numeric / date questions** on Metaculus can't be a single probability, so you're asked for a free-text estimate instead (not sent to Fatebook, which is yes/no only).
- **While browsing** (home page, categories, search) every `17%` / `84¢` token is masked (on Kalshi also `2.52x` payouts — even when the site renders the `x` as a separate element — and `+120` American odds), and graphics that encode the probability — card gauges and their needles, sparklines, charts, proportional colour bars — are blanked. A small pill in the corner shows everything for 5 minutes. Turn this off in settings if you find it annoying.
- **Looks native**: the panel samples the host page's font, background, text colour, primary button and input styling (colours are read through a canvas so `lab()`/`oklch()` values work), so it inherits Polymarket's blue Inter look, Kalshi's green pills, and Metaculus's light pills — including their light/dark themes.
- **Resizing** the window re-measures the covered regions every frame and re-detects them when the site swaps layouts at a breakpoint; if the chart region gets too small the panel becomes a bottom sheet.
- **Ask again on a schedule**: after you forecast or reveal a question it stays visible for a day (default; *Ask again* in settings can make it every visit, hourly, weekly or never), then hides again and asks for a new forecast. The *Daily* switch on the in-page pill turns this off for one question; **Forecast again** on the pill, or **Ask me again here** in the popup, re-blinds it immediately; **Forget answered questions** in settings resets everything.

## Where the numbers come from

Reading the exact market value straight from the page is fragile (Kalshi animates its digits), so the extension uses each site's public API to read the current price at the moment you submit:

- Polymarket: `gamma-api.polymarket.com` (event / market by slug)
- Kalshi: `api.elections.kalshi.com/trade-api/v2` (event / market by ticker from the URL)
- Metaculus: `metaculus.com/api/posts/<id>/` with your logged-in session; if you're logged out it falls back to reading the hidden "N% chance" gauge on the page.

- Manifold: `api.manifold.markets/v0/slug/<slug>` (binary probability, or the answers of a multiple-choice market)

Fatebook: a yes/no market becomes a binary question via `GET https://fatebook.io/api/v0/createQuestion` with your API key, title, resolve-by (the question's own resolution time — Polymarket's end date, Kalshi's expected expiration, Metaculus's scheduled resolve time, Manifold's close time — as a full ISO timestamp), your probability, tags, and notes containing the market's value at the time and the source URL. A multi-outcome market becomes **one multiple-choice question** with an option per outcome you priced (plus "Other" for the remainder of a mutually exclusive market). Fatebook's public API can't create those, so the extension uses the same endpoint the Fatebook web app uses, with your fatebook.io login — if you aren't logged in to fatebook.io in this browser it falls back to one yes/no question per outcome. The question is created as soon as you submit; saving a reason afterwards calls `PATCH /api/v0/editQuestion` to put it in the notes. A later forecast on the same market calls `POST /api/v0/addForecast` on the existing question (per option, for multiple choice) instead of creating another one, and immediately comments on it with your new number and what the market or community said at that moment (`Updated forecast: 40% (market was 55%)`); a reason written afterwards is posted as a further comment. Anything that failed on a flaky network is retried on the next page load.

## Data & privacy

Everything is stored in your browser (`chrome.storage`). Settings sync with your Chrome profile; the forecast history stays local. The only outbound requests are the three market APIs above and Fatebook (only if you set a key). Export your history as CSV/JSON from the settings page.

## Files

```
manifest.json           MV3 manifest
background.js           service worker: market API + Fatebook fetches
content/blind.css       hides marked regions before paint; masks %/¢ tokens (CSS Highlight API)
content/common.js       storage, token masking, theme sampling, overlay/panel UI, forms
content/sites/*.js      per-site adapters (Polymarket, Kalshi, Metaculus, Manifold): URL parsing, what to hide, API lookups
content/main.js         orchestration: blind → form → submit/reveal → card + "Forecast again" pill → re-ask schedule
content/nav-main.js     page-world hook so SPA navigations re-run the flow instantly
popup/                  toolbar popup (enable, pause, reveal/ask-again for the current tab)
options/                settings + history table + CSV/JSON export
scripts/                console-injectable test bundle (the icons were rendered from a canvas)
```

## Known limitations

- Site markup changes can break region detection. The token masking and the API lookups are independent of markup, so at worst the chart shows and the numbers are still masked.
- Comments that mention a probability in prose are masked token-by-token, but a comment saying "obviously this will happen" still leaks.
- Kalshi's headline "chance" is a bid/ask midpoint; the site itself may display a slightly different smoothed number.
- Metaculus group questions and conditionals aren't broken out; you get a single free-text estimate for the whole post.
- Manifold numeric, poll and bounty markets get a free-text estimate; outcomes hidden behind "Show more answers" only get an input once you expand them (they are optional anyway).

## License

MIT — see [LICENSE](LICENSE).
