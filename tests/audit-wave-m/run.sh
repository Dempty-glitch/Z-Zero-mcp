#!/usr/bin/env bash
# Audit wave M tests (docs: README.md next to this file).
#   bash tests/audit-wave-m/run.sh                  # test this tree (build first)
#   ZZ_TARGET=/path/to/old/tree bash tests/audit-wave-m/run.sh   # same tests on another build
#   bash tests/audit-wave-m/run.sh m2_domain_lock   # one file
# Runs inside sandbox-exec with all outbound network denied except loopback, a fake
# HOME, a fake Z-ZERO API and local pages. Real Chromium (Playwright cache).
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
REPO="$(cd "$HERE/../.." && pwd)"
export ZZ_TARGET="$(cd "${ZZ_TARGET:-$REPO}" && pwd)"
NODE="${NODE:-node}"
PROFILE='(version 1)(allow default)(deny network-outbound)(allow network-outbound (remote ip "localhost:*"))(allow network-outbound (remote unix-socket))'
files=()
if [ $# -gt 0 ]; then for f in "$@"; do files+=("$HERE/$f.test.mjs"); done
else files=("$HERE"/*.test.mjs); fi
cd "$REPO"
exec sandbox-exec -p "$PROFILE" "$NODE" \
  --import "$HERE/harness/net-guard.mjs" --import "$HERE/harness/hooks.mjs" \
  --test --test-concurrency=1 "${files[@]}"
