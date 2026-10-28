#!/bin/sh
# Robustness gate: concurrent writes stay consistent, and a corrupt data file is
# quarantined instead of taking the panel down. Both run in isolated profiles.
set -u
PLUGIN=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
# Output dirs default to the plugin; override with WB_WORKSPACE if you keep one.
ROOT=$PLUGIN
WB_WS_OVERRIDE=$(printenv WB_WORKSPACE 2>/dev/null || true)
if [ -n "$WB_WS_OVERRIDE" ]; then ROOT=$WB_WS_OVERRIDE; fi
FAIL=0
pass() { printf 'PASS  %s\n' "$1"; }
fail() { printf 'FAIL  %s\n' "$1"; FAIL=1; }

prepare() {
  HOME_DIR="$1"; PROFILE="$2"
  DSH_HOME="$HOME_DIR" "$ROOT/"$PLUGIN"/tools/dsh-cli.sh" --profile "$PROFILE" --from-default-profile web --dump-config >/dev/null 2>&1 || return 1
  DSH_HOME="$HOME_DIR" "$ROOT/"$PLUGIN"/tools/dsh-cli.sh" plugin --profile "$PROFILE" add --offline "file:$PLUGIN" >/dev/null 2>&1 || return 1
}

seed() {
  node --input-type=module -e "import { loadSeed } from 'file://$PLUGIN/tests/fixtures/expected.mjs'; await loadSeed(process.argv[1]);" "$1" >/dev/null 2>&1
}

boot_host() {
  HOME_DIR="$1"; PROFILE="$2"
  env -u DSH_PROFILE -u DSH_PROFILE_DIR WORKBENCH_TEST_SEAMS=1 DSH_HOME="$HOME_DIR" "$ROOT/"$PLUGIN"/tools/dsh-cli.sh" --profile "$PROFILE" --port 0 --no-open > "$HOME_DIR/boot.log" 2>&1 &
  HOST_PID=$!
  i=0; URL=''
  while [ "$i" -lt 45 ]; do
    URL=$(grep -o 'http://127\.[0-9.]*:[0-9]*/[^ ]*token=[^ ]*' "$HOME_DIR/boot.log" 2>/dev/null | head -1)
    [ -n "$URL" ] && break
    sleep 1; i=$((i+1))
  done
  [ -n "$URL" ] || return 1
  return 0
}

# --- 1) concurrency ---
D1=$(mktemp -d /tmp/wb-rb-cc-XXXXXX)
if prepare "$D1" rbcc && seed "$D1" && boot_host "$D1" rbcc; then
  if node "$PLUGIN/scripts/probe-concurrency.mjs" "$URL" 2>&1 | tail -3 | grep -q "CONCURRENCY: OK"; then pass "concurrent writes stay consistent (12 parallel creates, 5-way claim race -> exactly 1 wins)"; else fail "concurrency probe"; fi
else fail "concurrency setup"; fi
kill "$HOST_PID" 2>/dev/null; wait "$HOST_PID" 2>/dev/null; rm -rf "$D1"

# --- 2) corruption recovery (seed first, then corrupt, then boot) ---
D2=$(mktemp -d /tmp/wb-rb-co-XXXXXX)
if prepare "$D2" rbco && seed "$D2"; then
  printf '{"meta":{"rev":9},"issues":[ THIS IS NOT JSON' > "$D2/workbench/workbench.json"
  if boot_host "$D2" rbco; then
    OUT=$(node "$PLUGIN/scripts/probe-corruption.mjs" "$URL" 2>&1 | tail -2)
    case "$OUT" in *"CORRUPTION-RECOVERY: OK"*)
      if ls "$D2/workbench/"*.corrupt-* >/dev/null 2>&1; then pass "corrupt data file is quarantined and the panel still renders"; else fail "corrupt file was not quarantined"; fi
      ;;
    *) fail "corruption recovery probe: $OUT" ;;
    esac
  else fail "corruption host boot"; fi
  kill "$HOST_PID" 2>/dev/null; wait "$HOST_PID" 2>/dev/null
else fail "corruption setup"; fi
rm -rf "$D2"

echo
if [ "$FAIL" -eq 0 ]; then echo "ROBUSTNESS ACCEPTANCE: OK"; else echo "ROBUSTNESS ACCEPTANCE: BROKEN"; fi
exit "$FAIL"
