#!/bin/bash
# Builds a single JS file that injects blind.css and runs all content scripts with the chrome shim.
set -e
cd "$(dirname "$0")/.."
OUT="${1:-/tmp/ff-bundle.js}"
{
  echo "(() => {"
  echo "const css = $(node -e 'process.stdout.write(JSON.stringify(require("fs").readFileSync("content/blind.css","utf8")))');"
  echo "const st = document.createElement('style'); st.id='ff-test-css'; st.textContent = css; document.documentElement.appendChild(st);"
  echo "})();"
  cat scripts/test-shim.js content/nav-main.js content/common.js content/sites/polymarket.js content/sites/kalshi.js content/sites/metaculus.js content/main.js
} > "$OUT"
node --check "$OUT"
echo "bundle: $OUT ($(wc -c < "$OUT") bytes)"
