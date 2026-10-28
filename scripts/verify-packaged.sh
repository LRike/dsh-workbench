#!/bin/sh
# Release-integrity gate: install the SHIPPED tarball (not the workspace dir) into a
# throwaway profile and run the full UI acceptance against it. This catches
# packaging mistakes that a workspace-dir install can never reveal.
set -u
PLUGIN=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
# Output dirs default to the plugin; override with WB_WORKSPACE if you keep one.
ROOT=$PLUGIN
WB_WS_OVERRIDE=$(printenv WB_WORKSPACE 2>/dev/null || true)
if [ -n "$WB_WS_OVERRIDE" ]; then ROOT=$WB_WS_OVERRIDE; fi
FAIL=0
pass() { printf 'PASS  %s\n' "$1"; }
fail() { printf 'FAIL  %s\n' "$1"; FAIL=1; }

TGZ=$(ls -1t "$PLUGIN"/dist/local-dsh-workbench-*.tgz 2>/dev/null | head -1)
[ -n "$TGZ" ] && pass "found shipped artifact: $(basename "$TGZ")" || { fail "no dist tarball"; exit 1; }

# 1) required runtime files must be inside the artifact
LIST=$(tar -tzf "$TGZ")
for f in package.json index.js client.js cordis.patch.yml host/service/workbench.js host/service/commands-core.js host/store/repository.js locale/zh.json; do
  case "$LIST" in *"package/$f"*) ;; *) fail "artifact is missing $f" ;; esac
done
[ "$FAIL" -eq 0 ] && pass "artifact contains every required runtime file"

# 2) install exactly like a user would (from the tgz) and boot it
HOME_DIR=$(mktemp -d /tmp/wb-pkg-XXXXXX)
DSH_HOME="$HOME_DIR" "$ROOT/"$PLUGIN"/tools/dsh-cli.sh" --profile pkg --from-default-profile web --dump-config >/dev/null 2>&1 || fail "profile init"
DSH_HOME="$HOME_DIR" "$ROOT/"$PLUGIN"/tools/dsh-cli.sh" plugin --profile pkg add --offline "file:$TGZ" >/dev/null 2>&1 \
  && pass "installed the shipped tarball" || fail "install from tarball failed"

INSTALLED=$(find "$HOME_DIR" -type d -path "*node_modules/@local/dsh-workbench" 2>/dev/null | head -1)
if [ -n "$INSTALLED" ] && [ -f "$INSTALLED/client.js" ]; then
  if shasum -a 256 "$INSTALLED/client.js" | cut -d" " -f1 | grep -qx "$(shasum -a 256 "$PLUGIN/client.js" | cut -d" " -f1)"; then
    pass "installed client.js is byte-identical to the built one"
  else fail "installed client.js differs from the build"; fi
else fail "installed package layout not found"; fi

node --input-type=module -e "import { loadSeed } from 'file://$PLUGIN/tests/fixtures/expected.mjs'; await loadSeed(process.argv[1]);" "$HOME_DIR" >/dev/null 2>&1 || fail "seed"
env -u DSH_PROFILE -u DSH_PROFILE_DIR WORKBENCH_TEST_SEAMS=1 DSH_HOME="$HOME_DIR" "$ROOT/"$PLUGIN"/tools/dsh-cli.sh" --profile pkg --port 0 --no-open > "$HOME_DIR/boot.log" 2>&1 &
PID=$!
i=0; URL=''
while [ "$i" -lt 45 ]; do
  URL=$(grep -o 'http://127\.[0-9.]*:[0-9]*/[^ ]*token=[^ ]*' "$HOME_DIR/boot.log" 2>/dev/null | head -1)
  [ -n "$URL" ] && break
  sleep 1; i=$((i+1))
done
if [ -n "$URL" ]; then
  pass "host booted from the installed artifact"
  node "$PLUGIN/scripts/verify-ui-strict.mjs" "$URL" "$ROOT/docs/loop/phase5" > "$HOME_DIR/strict.log" 2>&1 \
    && pass "UI strict gate against the shipped build" || { fail "UI strict gate against the shipped build"; tail -8 "$HOME_DIR/strict.log"; }
  node "$PLUGIN/scripts/verify-ui-flows.mjs" "$URL" "$ROOT/docs/loop/phase5" > "$HOME_DIR/flows.log" 2>&1 \
    && pass "UI flow gate against the shipped build" || { fail "UI flow gate against the shipped build"; tail -8 "$HOME_DIR/flows.log"; }
  node "$PLUGIN/scripts/verify-ui-claim.mjs" "$URL" "$ROOT/docs/loop/phase5" > "$HOME_DIR/claim.log" 2>&1 \
    && pass "claim dock gate against the shipped build" || { fail "claim dock gate against the shipped build"; tail -8 "$HOME_DIR/claim.log"; }
  node "$PLUGIN/scripts/verify-ui-defects.mjs" "$URL" "$ROOT/docs/loop/phase5" > "$HOME_DIR/defects.log" 2>&1 \
    && pass "defect regression gate against the shipped build" || { fail "defect regression gate against the shipped build"; tail -8 "$HOME_DIR/defects.log"; }
else
  fail "host did not boot from the installed artifact"; tail -20 "$HOME_DIR/boot.log"
fi
kill "$PID" 2>/dev/null; wait "$PID" 2>/dev/null; rm -rf "$HOME_DIR"

echo
if [ "$FAIL" -eq 0 ]; then echo "PACKAGED ARTIFACT ACCEPTANCE: OK"; else echo "PACKAGED ARTIFACT ACCEPTANCE: BROKEN"; fi
exit "$FAIL"
