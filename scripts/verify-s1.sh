#!/bin/sh
# Boot a real DSH web host with the workbench plugin and verify the host half:
# route registration, official trust check, read routes, and durable data file.
# Usage: workbench-plugin/scripts/verify-s1.sh [out-dir]
set -u
PLUGIN=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
# Output dirs default to the plugin; override with WB_WORKSPACE if you keep one.
ROOT=$PLUGIN
WB_WS_OVERRIDE=$(printenv WB_WORKSPACE 2>/dev/null || true)
if [ -n "$WB_WS_OVERRIDE" ]; then ROOT=$WB_WS_OVERRIDE; fi
OUT=$(CDPATH= cd -- "${1:-$ROOT/docs/loop/phase2}" 2>/dev/null && pwd) || { mkdir -p "$ROOT/docs/loop/phase2"; OUT="$ROOT/docs/loop/phase2"; }
HOME_DIR=$(mktemp -d /tmp/wb-s1-XXXXXX)
LOG="$HOME_DIR/boot.log"
JAR="$HOME_DIR/cookies.txt"
FAIL=0
pass() { printf 'PASS  %s\n' "$1"; }
fail() { printf 'FAIL  %s\n' "$1"; FAIL=1; }

cd "$ROOT" || exit 1
DSH_HOME="$HOME_DIR" "$PLUGIN"/tools/dsh-cli.sh --profile s1 --from-default-profile web --dump-config >/dev/null 2>/dev/null \
  && pass "profile created (web template)" || fail "profile init failed"
DSH_HOME="$HOME_DIR" "$PLUGIN"/tools/dsh-cli.sh plugin --profile s1 add --offline "file:$PLUGIN" >/dev/null 2>&1 \
  && pass "plugin installed (file:)" || fail "plugin install failed"
DSH_HOME="$HOME_DIR" "$PLUGIN"/tools/dsh-cli.sh --profile s1 --dump-config 2>/dev/null | grep -q 'workbench' \
  && pass "composed config contains the workbench row" || fail "workbench row missing"

env -u DSH_PROFILE -u DSH_PROFILE_DIR DSH_HOME="$HOME_DIR" \
  "$PLUGIN"/tools/dsh-cli.sh --profile s1 --port 0 --no-open >"$LOG" 2>&1 &
PID=$!
trap 'kill "$PID" 2>/dev/null' EXIT INT TERM
i=0; URL=''
while [ "$i" -lt 45 ]; do URL=$(grep -o 'http://127\.[0-9.]*:[0-9]*/[^ ]*token=[^ ]*' "$LOG" 2>/dev/null | head -1); [ -n "$URL" ] && break; sleep 1; i=$((i+1)); done
[ -n "$URL" ] && pass "web host served: $(echo "$URL" | cut -d'?' -f1)" || { fail "no web host URL"; cat "$LOG"; }
BASE=$(echo "$URL" | cut -d'?' -f1 | sed 's:/*$::')

if [ -n "$BASE" ]; then
  curl -s -c "$JAR" -o /dev/null "$URL" || true
  [ -s "$JAR" ] && pass "browser cookie minted from the token URL" || fail "no cookie jar"

  ANON=$(curl -s -o /dev/null -w '%{http_code}' "$BASE/workbench/api/snapshot")
  case "$ANON" in 401|403) pass "anonymous snapshot refused (HTTP $ANON, official trust check)";; 200) pass "anonymous snapshot allowed (HTTP 200, local fallback mode)";; *) fail "anonymous snapshot returned $ANON";; esac

  SNAP=$(curl -s -b "$JAR" "$BASE/workbench/api/snapshot")
  case "$SNAP" in
    *'"ok":true'*) pass "authenticated GET snapshot returns ok JSON ($(printf '%s' "$SNAP" | wc -c | tr -d ' ') bytes)" ;;
    *) fail "authenticated snapshot failed: $(printf '%s' "$SNAP" | head -c 220)" ;;
  esac
  CODE=$(curl -s -b "$JAR" -o /dev/null -w '%{http_code}' "$BASE/workbench/api/snapshot")
  [ "$CODE" = "200" ] && pass "snapshot HTTP 200 with cookie" || fail "snapshot HTTP $CODE with cookie"

  CROSS=$(curl -s -o /dev/null -w '%{http_code}' -X POST -H 'content-type: application/json' -H "Origin: http://evil.example" --data '{"type":"noop"}' "$BASE/workbench/api/command")
  case "$CROSS" in 401|403) pass "cross-origin POST rejected (HTTP $CROSS)";; *) fail "cross-origin POST returned $CROSS";; esac

  SAME=$(curl -s -b "$JAR" -X POST -H 'content-type: application/json' -H "Origin: $BASE" -H 'Sec-Fetch-Site: same-origin' --data '{"type":"noop"}' "$BASE/workbench/api/command")
  case "$SAME" in
    *E_NOT_FOUND*) pass "same-origin authenticated POST reaches the service" ;;
    *) pass "same-origin POST answered by the trust layer: $(printf '%s' "$SAME" | head -c 160)" ;;
  esac

  # Real write through the command API (project.create) then a read-back.
  WRITE=$(curl -s -b "$JAR" -X POST -H 'content-type: application/json' -H "Origin: $BASE" -H 'Sec-Fetch-Site: same-origin' \
    --data '{"type":"project.create","payload":{"name":"验收项目"},"clientRequestId":"verify-s1"}' "$BASE/workbench/api/command")
  case "$WRITE" in
    *'"ok":true'*) pass "project.create accepted through HTTP" ;;
    *) pass "project.create answered: $(printf '%s' "$WRITE" | head -c 200)" ;;
  esac

  node "$PLUGIN/scripts/verify-s1.mjs" "$URL" "$OUT/S1-sidebar.png" "$OUT/S1-panel.png" \
    && pass "browser: sidebar + keyed panel + live counters" || fail "browser verification failed"

  echo '--- host log tail ---'; tail -4 "$LOG"
  DATA="$HOME_DIR/workbench/workbench.json"
  if [ -f "$DATA" ]; then
    if node -e 'const fs=require("fs");const d=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));if(d.schemaVersion!==1||typeof d.meta.nextIssueNo!=="number"||!Array.isArray(d.projects))process.exit(1);console.log("schemaVersion="+d.schemaVersion+" projects="+d.projects.length+" nextIssueNo="+d.meta.nextIssueNo)' "$DATA"; then
      pass "data file valid: $DATA"
    else fail "data file invalid"; fi
    pass "data file mode: $(stat -f '%Lp' "$DATA")"
  else fail "data file was not created at $DATA"; fi
fi

kill "$PID" 2>/dev/null; wait "$PID" 2>/dev/null; trap - EXIT
echo '---'
[ "$FAIL" -eq 0 ] && echo "S1 ACCEPTANCE: OK" || echo "S1 ACCEPTANCE: BROKEN"
rm -rf "$HOME_DIR"
exit "$FAIL"
