#!/bin/sh
# Strict UI acceptance against a real DSH web client with seeded data:
# typing (incl. IME), light+dark contrast, layout bounds, a11y, console.
set -u
PLUGIN=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
# Output dirs default to the plugin; override with WB_WORKSPACE if you keep one.
ROOT=$PLUGIN
WB_WS_OVERRIDE=$(printenv WB_WORKSPACE 2>/dev/null || true)
if [ -n "$WB_WS_OVERRIDE" ]; then ROOT=$WB_WS_OVERRIDE; fi
OUT="$ROOT/docs/loop/phase4"
mkdir -p "$OUT"
HOME_DIR=$(mktemp -d /tmp/wb-ui-XXXXXX)
LOG="$HOME_DIR/boot.log"
FAIL=0
pass() { printf 'PASS  %s\n' "$1"; }
fail() { printf 'FAIL  %s\n' "$1"; FAIL=1; }

cd "$ROOT" || exit 1
DSH_HOME="$HOME_DIR" "$PLUGIN"/tools/dsh-cli.sh --profile ui --from-default-profile web --dump-config >/dev/null 2>&1 \
  && pass "profile created" || fail "profile init failed"
DSH_HOME="$HOME_DIR" "$PLUGIN"/tools/dsh-cli.sh plugin --profile ui add --offline "file:$PLUGIN" >/dev/null 2>&1 \
  && pass "plugin installed" || fail "plugin install failed"
node --input-type=module -e "
import { loadSeed } from 'file://$PLUGIN/tests/fixtures/expected.mjs';
await loadSeed(process.argv[1]);
" "$HOME_DIR" >/dev/null && pass "fixture seeded" || fail "seed failed"

env -u DSH_PROFILE -u DSH_PROFILE_DIR WORKBENCH_TEST_SEAMS=1 DSH_HOME="$HOME_DIR" \
  "$PLUGIN"/tools/dsh-cli.sh --profile ui --port 0 --no-open >"$LOG" 2>&1 &
PID=$!
trap 'kill "$PID" 2>/dev/null' EXIT INT TERM
i=0; URL=''
while [ "$i" -lt 45 ]; do URL=$(grep -o 'http://127\.[0-9.]*:[0-9]*/[^ ]*token=[^ ]*' "$LOG" 2>/dev/null | head -1); [ -n "$URL" ] && break; sleep 1; i=$((i+1)); done
[ -n "$URL" ] && pass "host served: $(echo "$URL" | cut -d'?' -f1)" || { fail "no host URL"; tail -20 "$LOG"; }

if [ -n "$URL" ]; then
  node "$PLUGIN/scripts/verify-ui-strict.mjs" "$URL" "$OUT" || FAIL=1
  echo
  node "$PLUGIN/scripts/verify-ui-flows.mjs" "$URL" "$OUT" || FAIL=1
  echo
  node "$PLUGIN/scripts/verify-ui-claim.mjs" "$URL" "$OUT" || FAIL=1
  echo
  node "$PLUGIN/scripts/verify-ui-defects.mjs" "$URL" "$OUT" || FAIL=1
  echo
  node "$PLUGIN/scripts/verify-ui-detail.mjs" "$URL" "$OUT" || FAIL=1
fi
kill "$PID" 2>/dev/null; wait "$PID" 2>/dev/null; trap - EXIT
echo '---'
[ "$FAIL" -eq 0 ] && echo "UI ACCEPTANCE: OK" || echo "UI ACCEPTANCE: BROKEN"
rm -rf "$HOME_DIR"
exit "$FAIL"
