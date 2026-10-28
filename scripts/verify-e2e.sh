#!/bin/sh
# End-to-end UI acceptance: seed a real host from the frozen fixture, boot the
# web profile with the plugin, and walk the five views in a real browser.
set -u
PLUGIN=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
# Output dirs default to the plugin; override with WB_WORKSPACE if you keep one.
ROOT=$PLUGIN
WB_WS_OVERRIDE=$(printenv WB_WORKSPACE 2>/dev/null || true)
if [ -n "$WB_WS_OVERRIDE" ]; then ROOT=$WB_WS_OVERRIDE; fi
OUT=$(CDPATH= cd -- "${1:-$ROOT/docs/loop/phase2}" 2>/dev/null && pwd) || { mkdir -p "$ROOT/docs/loop/phase2"; OUT="$ROOT/docs/loop/phase2"; }
HOME_DIR=$(mktemp -d /tmp/wb-e2e-XXXXXX)
LOG="$HOME_DIR/boot.log"
FAIL=0
pass() { printf 'PASS  %s\n' "$1"; }
fail() { printf 'FAIL  %s\n' "$1"; FAIL=1; }

cd "$ROOT" || exit 1
DSH_HOME="$HOME_DIR" "$PLUGIN"/tools/dsh-cli.sh --profile e2e --from-default-profile web --dump-config >/dev/null 2>/dev/null \
  && pass "profile created (web template)" || fail "profile init failed"
DSH_HOME="$HOME_DIR" "$PLUGIN"/tools/dsh-cli.sh plugin --profile e2e add --offline "file:$PLUGIN" >/dev/null 2>&1 \
  && pass "plugin installed" || fail "plugin install failed"

node --input-type=module -e "
import { loadSeed } from 'file://$PLUGIN/tests/fixtures/expected.mjs';
const info = await loadSeed(process.argv[1]);
console.log('seeded ' + JSON.stringify(info));
" "$HOME_DIR" && pass "fixture seeded into the host home" || fail "seed load failed"

env -u DSH_PROFILE -u DSH_PROFILE_DIR WORKBENCH_TEST_SEAMS=1 DSH_HOME="$HOME_DIR" \
  "$PLUGIN"/tools/dsh-cli.sh --profile e2e --port 0 --no-open >"$LOG" 2>&1 &
PID=$!
trap 'kill "$PID" 2>/dev/null' EXIT INT TERM
i=0; URL=''
while [ "$i" -lt 45 ]; do URL=$(grep -o 'http://127\.[0-9.]*:[0-9]*/[^ ]*token=[^ ]*' "$LOG" 2>/dev/null | head -1); [ -n "$URL" ] && break; sleep 1; i=$((i+1)); done
[ -n "$URL" ] && pass "web host served: $(echo "$URL" | cut -d'?' -f1)" || { fail "no web host URL"; tail -20 "$LOG"; }

if [ -n "$URL" ]; then
  node "$PLUGIN/scripts/verify-e2e.mjs" "$URL" "$OUT" && pass "browser walked all five views on seeded data" || fail "e2e browser walk failed"
fi
kill "$PID" 2>/dev/null; wait "$PID" 2>/dev/null; trap - EXIT
[ -s "$LOG" ] && { echo '--- host log tail ---'; tail -4 "$LOG"; }
echo '---'
[ "$FAIL" -eq 0 ] && echo "E2E ACCEPTANCE: OK" || echo "E2E ACCEPTANCE: BROKEN"
rm -rf "$HOME_DIR"
exit "$FAIL"
