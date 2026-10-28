#!/bin/sh
# Desktop-config verification: reproduce the desktop profile's bundle list in an
# isolated DSH_HOME, boot the web surface, and run the same end-to-end walk.
# This verifies the desktop COMPOSITION, not the Electron shell (the GUI's own
# process is left untouched).
set -u
PLUGIN=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
# Output dirs default to the plugin; override with WB_WORKSPACE if you keep one.
ROOT=$PLUGIN
WB_WS_OVERRIDE=$(printenv WB_WORKSPACE 2>/dev/null || true)
if [ -n "$WB_WS_OVERRIDE" ]; then ROOT=$WB_WS_OVERRIDE; fi
OUT=$(CDPATH= cd -- "${1:-$ROOT/docs/loop/phase2}" 2>/dev/null && pwd) || { mkdir -p "$ROOT/docs/loop/phase2"; OUT="$ROOT/docs/loop/phase2"; }
HOME_DIR=$(mktemp -d /tmp/wb-desk-XXXXXX)
LOG="$HOME_DIR/boot.log"
FAIL=0
pass() { printf 'PASS  %s\n' "$1"; }
fail() { printf 'FAIL  %s\n' "$1"; FAIL=1; }

cd "$ROOT" || exit 1
node --input-type=module -e "
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
const home = process.argv[1];
const desktop = JSON.parse(readFileSync(join(process.env.HOME, '.dsh/profiles/desktop/package.json'), 'utf8'));
const bundles = desktop.dsh.profile.bundles.filter((name) => name !== '@local/dsh-model-scope');
const dir = join(home, 'profiles', 'desk');
mkdirSync(dir, { recursive: true });
writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'dsh-profile-desk', private: true, dependencies: {}, dsh: { profile: { bundles } } }, null, 2));
writeFileSync(join(dir, 'cordis.patch.yml'), '[]\n');
writeFileSync(join(dir, 'pnpm-workspace.yaml'), 'packages:\n  - .\n\nnodeLinker: hoisted\nautoInstallPeers: false\n');
console.log('desktop bundles: ' + bundles.length);
" "$HOME_DIR" && pass "desktop composition profile written" || fail "could not write desktop profile"

DSH_HOME="$HOME_DIR" "$PLUGIN"/tools/dsh-cli.sh plugin --profile desk add --offline "file:$PLUGIN" >/dev/null 2>&1 \
  && pass "plugin installed into the desktop composition" || fail "plugin install failed"
DSH_HOME="$HOME_DIR" "$PLUGIN"/tools/dsh-cli.sh --profile desk --dump-config 2>/dev/null | grep -q 'workbench' \
  && pass "composed desktop config contains the workbench row" || fail "workbench row missing"

node --input-type=module -e "
import { loadSeed } from 'file://$PLUGIN/tests/fixtures/expected.mjs';
await loadSeed(process.argv[1]);
" "$HOME_DIR" && pass "fixture seeded" || fail "seed failed"

env -u DSH_PROFILE -u DSH_PROFILE_DIR WORKBENCH_TEST_SEAMS=1 DSH_HOME="$HOME_DIR" \
  "$PLUGIN"/tools/dsh-cli.sh --profile desk --port 0 --no-open >"$LOG" 2>&1 &
PID=$!
trap 'kill "$PID" 2>/dev/null' EXIT INT TERM
i=0; URL=''
while [ "$i" -lt 50 ]; do URL=$(grep -o 'http://127\.[0-9.]*:[0-9]*/[^ ]*token=[^ ]*' "$LOG" 2>/dev/null | head -1); [ -n "$URL" ] && break; sleep 1; i=$((i+1)); done
[ -n "$URL" ] && pass "desktop-composition host served: $(echo "$URL" | cut -d'?' -f1)" || { fail "no host URL"; tail -25 "$LOG"; }

if [ -n "$URL" ]; then
  node "$PLUGIN/scripts/verify-e2e.mjs" "$URL" "$OUT" && pass "browser walked all five views under the desktop composition" || fail "desktop-composition e2e failed"
  node "$PLUGIN/scripts/verify-ui-strict.mjs" "$URL" "$OUT" && pass "UI strict gate (69 assertions) under the desktop composition" || fail "desktop-composition UI strict gate failed"
  node "$PLUGIN/scripts/verify-ui-flows.mjs" "$URL" "$OUT" && pass "UI flow gate under the desktop composition" || fail "desktop-composition UI flow gate failed"
  node "$PLUGIN/scripts/verify-ui-claim.mjs" "$URL" "$OUT" && pass "claim dock gate under the desktop composition" || fail "desktop-composition claim gate failed"
  node "$PLUGIN/scripts/verify-ui-defects.mjs" "$URL" "$OUT" && pass "defect regression gate under the desktop composition" || fail "desktop-composition defect gate failed"
  BASE=$(echo "$URL" | cut -d'?' -f1 | sed 's:/*$::')
  curl -s -c "$HOME_DIR/jar" -o /dev/null "$URL"
  DIAG=$(curl -s -b "$HOME_DIR/jar" -X POST -H 'content-type: application/json' -H "Origin: $BASE" -H 'Sec-Fetch-Site: same-origin' --data '{"type":"test.diagnostics"}' "$BASE/workbench/api/command")
  case "$DIAG" in
    *'"toolsRegistered":true'*) pass "8 AI tools registered under the desktop composition" ;;
    *) fail "tools not registered: $(printf '%s' "$DIAG" | head -c 200)" ;;
  esac
fi
kill "$PID" 2>/dev/null; wait "$PID" 2>/dev/null; trap - EXIT
[ -s "$LOG" ] && { echo '--- host log tail ---'; tail -4 "$LOG"; }
echo '---'
[ "$FAIL" -eq 0 ] && echo "DESKTOP-COMPOSITION ACCEPTANCE: OK" || echo "DESKTOP-COMPOSITION ACCEPTANCE: BROKEN"
rm -rf "$HOME_DIR"
exit "$FAIL"
