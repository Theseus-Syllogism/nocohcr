#!/usr/bin/env bash
# Download bundled lit ESM modules from esm.sh for local self-hosting.
# Shoelace 2.20.1 components import from "lit" as a bare specifier;
# these bundles + an import map in index.html resolve them without a bundler.
#
# KNOWN-BROKEN — DO NOT RELY ON OUTPUT (2026-05-26)
# -------------------------------------------------
# esm.sh's `?bundle` URL pattern no longer returns a single self-contained
# bundle. The files it returns are thin re-export wrappers like:
#     export * from "/lit@3.3.0/es2022/lit.bundle.mjs";
# Those absolute paths resolve against the page origin, so the browser
# 404s on /lit@3.3.0/es2022/... and the directive is effectively missing.
# The app appears to work today because Shoelace components that DON'T
# import a directive load fine, and components that DO import one fail
# silently. Until lit is properly bundled (via npm + esbuild, or a
# different CDN), do not run this script — it will replace the existing
# wrappers with new wrappers of the same broken shape.
set -euo pipefail

cd "$(dirname "$0")"

VERSION="3.3.0"
BASE="https://esm.sh"

declare -A targets
targets=(
  ["index.js"]="${BASE}/lit@${VERSION}?bundle"
  ["decorators.js"]="${BASE}/lit@${VERSION}/decorators.js?bundle"
  ["directive-helpers.js"]="${BASE}/lit@${VERSION}/directive-helpers.js?bundle"
  ["directives/class-map.js"]="${BASE}/lit@${VERSION}/directives/class-map.js?bundle"
  ["directives/if-defined.js"]="${BASE}/lit@${VERSION}/directives/if-defined.js?bundle"
  ["directives/live.js"]="${BASE}/lit@${VERSION}/directives/live.js?bundle"
  ["directives/map.js"]="${BASE}/lit@${VERSION}/directives/map.js?bundle"
  ["directives/range.js"]="${BASE}/lit@${VERSION}/directives/range.js?bundle"
  ["directives/ref.js"]="${BASE}/lit@${VERSION}/directives/ref.js?bundle"
  ["directives/style-map.js"]="${BASE}/lit@${VERSION}/directives/style-map.js?bundle"
  ["directives/unsafe-html.js"]="${BASE}/lit@${VERSION}/directives/unsafe-html.js?bundle"
  ["directives/when.js"]="${BASE}/lit@${VERSION}/directives/when.js?bundle"
  ["static-html.js"]="${BASE}/lit@${VERSION}/static-html.js?bundle"
)

ok=0 fail=0
for file in $(echo "${!targets[@]}" | tr ' ' '\n' | sort); do
  url="${targets[$file]}"
  dir=$(dirname "$file")
  [ "$dir" != "." ] && mkdir -p "$dir"
  printf "%-40s " "$file"
  if curl -fsSL "$url" -o "$file"; then
    sz=$(wc -c < "$file")
    # Verify it's actually bundled (no external esm.sh imports)
    if grep -q 'esm.sh.*lit@' "$file" 2>/dev/null && ! grep -q 'export.*from.*esm.sh' "$file" 2>/dev/null; then
      echo "OK ($sz bytes) — bundled"
    elif grep -q 'export.*from.*esm.sh' "$file" 2>/dev/null; then
      echo "WARN ($sz bytes) — has external imports, may need inlining"
    else
      echo "OK ($sz bytes)"
    fi
    ok=$((ok + 1))
  else
    echo "FAILED"
    fail=$((fail + 1))
  fi
done

echo
echo "Done: $ok ok, $fail failed"
[ "$fail" -eq 0 ]
