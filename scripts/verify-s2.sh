#!/bin/sh
# Boot a real DSH web host with the workbench plugin and walk the S2 surface end
# to end over HTTP: project -> TODO -> triage -> acceptance -> status -> archive.
# Every step asserts both the HTTP envelope and the persisted JSON document.
#
# Usage: workbench-plugin/scripts/verify-s2.sh [out-dir]
# Exits 0 only when every assertion passes; prints the CDP-ready URL at the end.
set -u
PLUGIN=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
# Output dirs default to the plugin; override with WB_WORKSPACE if you keep one.
ROOT=$PLUGIN
WB_WS_OVERRIDE=$(printenv WB_WORKSPACE 2>/dev/null || true)
if [ -n "$WB_WS_OVERRIDE" ]; then ROOT=$WB_WS_OVERRIDE; fi
OUT=$(CDPATH= cd -- "${1:-$ROOT/docs/loop/phase2}" 2>/dev/null && pwd) || { mkdir -p "$ROOT/docs/loop/phase2"; OUT="$ROOT/docs/loop/phase2"; }
HOME_DIR=$(mktemp -d /tmp/wb-s2-XXXXXX)
WS=$(mktemp -d /tmp/wb-s2-ws-XXXXXX)
LOG="$HOME_DIR/boot.log"
JAR="$HOME_DIR/cookies.txt"
DATA="$HOME_DIR/workbench/workbench.json"
TMPD="$HOME_DIR/api"
mkdir -p "$TMPD"
FAIL=0
PASSED=0
pass() { printf 'PASS  %s\n' "$1"; PASSED=$((PASSED+1)); }
fail() { printf 'FAIL  %s\n' "$1"; FAIL=1; }

cd "$ROOT" || exit 1

# 1) isolated home + web-template profile + plugin installed like a user would
DSH_HOME="$HOME_DIR" "$PLUGIN"/tools/dsh-cli.sh --profile s2 --from-default-profile web --dump-config >/dev/null 2>/dev/null \
  && pass "profile created (web template)" || fail "profile init failed"
DSH_HOME="$HOME_DIR" "$PLUGIN"/tools/dsh-cli.sh plugin --profile s2 add --offline "file:$PLUGIN" >/dev/null 2>&1 \
  && pass "plugin installed (file:)" || fail "plugin install failed"
DSH_HOME="$HOME_DIR" "$PLUGIN"/tools/dsh-cli.sh --profile s2 --dump-config 2>/dev/null | grep -q 'workbench' \
  && pass "composed config contains the workbench row" || fail "workbench row missing from composed config"

# 2) boot the web host on an ephemeral port
env -u DSH_PROFILE -u DSH_PROFILE_DIR DSH_HOME="$HOME_DIR" WORKBENCH_TEST_SEAMS=1 \
  "$PLUGIN"/tools/dsh-cli.sh --profile s2 --port 0 --no-open >"$LOG" 2>&1 &
PID=$!
trap 'kill "$PID" 2>/dev/null' EXIT INT TERM
i=0; URL=''
while [ "$i" -lt 45 ]; do
  URL=$(grep -o 'http://127\.[0-9.]*:[0-9]*/[^ ]*token=[^ ]*' "$LOG" 2>/dev/null | head -1)
  [ -n "$URL" ] && break
  sleep 1; i=$((i+1))
done
if [ -z "$URL" ]; then
  fail "no web host URL"; tail -20 "$LOG"; echo "S2 ACCEPTANCE: BROKEN"; kill "$PID" 2>/dev/null; rm -rf "$HOME_DIR" "$WS"; exit 1
fi
BASE=$(echo "$URL" | cut -d'?' -f1 | sed 's:/*$::')
pass "web host served: $BASE"

# 3) token handshake -> session cookie (a browser does exactly this)
curl -s -L -c "$JAR" -b "$JAR" -o /dev/null "$URL" || fail "token handshake failed"
[ -s "$JAR" ] && pass "session cookie captured" || fail "no cookie jar"

snap() { curl -s -b "$JAR" "$BASE/workbench/api/snapshot"; }
# post <type> <payload-json> <out-file>
post() {
  curl -s -b "$JAR" -X POST \
    -H 'content-type: application/json' \
    -H "Origin: $BASE" \
    -H 'Sec-Fetch-Site: same-origin' \
    --data "{\"type\":\"$1\",\"clientRequestId\":\"c_s2_$$_$3\",\"payload\":$2}" \
    "$BASE/workbench/api/command" -o "$TMPD/$3.json"
  cat "$TMPD/$3.json"
}
# field <json-file> <dotted.path>
field() {
  node -e '
const fs = require("fs");
const doc = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
let value = doc;
for (const key of process.argv[2].split(".")) value = value === undefined || value === null ? undefined : value[key];
process.stdout.write(value === undefined || value === null ? "" : String(value));
' "$1" "$2"
}

# 4) snapshot envelope
snap > "$TMPD/snapshot0.json"
[ "$(field "$TMPD/snapshot0.json" ok)" = "true" ] && pass "GET snapshot ok:true" || fail "GET snapshot not ok"
[ -z "$(field "$TMPD/snapshot0.json" data.counters.maxParallel)" ] && pass "snapshot has no maxParallel (R4 retired)" || fail "maxParallel still exposed"

# 5) auth negative: no Origin, cross-site Origin
NOORIGIN=$(curl -s -o /dev/null -w '%{http_code}' -X POST -H 'content-type: application/json' \
  --data '{"type":"project.create","payload":{"name":"nope"}}' "$BASE/workbench/api/command")
case "$NOORIGIN" in 401|403) pass "write without Origin refused ($NOORIGIN)" ;; *) fail "write without Origin returned $NOORIGIN" ;; esac
CROSS=$(curl -s -o /dev/null -w '%{http_code}' -X POST -H 'content-type: application/json' \
  -H 'Origin: http://evil.example' -H 'Sec-Fetch-Site: cross-site' \
  --data '{"type":"project.create","payload":{"name":"nope"}}' "$BASE/workbench/api/command")
case "$CROSS" in 401|403) pass "cross-origin write refused ($CROSS)" ;; *) fail "cross-origin write returned $CROSS" ;; esac

# 6) project.create
post project.create "{\"name\":\"S2 验收项目\",\"defaultWorkspacePath\":\"$WS\"}" p1 >/dev/null
PROJECT_ID=$(field "$TMPD/p1.json" data.result.projectId)
if [ -n "$PROJECT_ID" ]; then pass "project.create -> $PROJECT_ID"; else
  fail "project.create failed: $(cat "$TMPD/p1.json" | head -c 200)"; fi

# 7) todo.create + duplicate hints
post todo.create '{"title":"S2 验收议题：把工作台跑通"}' t1 >/dev/null
ISSUE_ID=$(field "$TMPD/t1.json" data.result.issueId)
[ -n "$ISSUE_ID" ] && pass "todo.create -> $ISSUE_ID" || fail "todo.create failed: $(cat "$TMPD/t1.json" | head -c 200)"
post todo.create '{"title":"S2 验收议题：把工作台跑通"}' t2 >/dev/null
DUP=$(node -e '
const fs = require("fs");
const doc = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
const hints = (doc.data && doc.data.result && doc.data.result.duplicateHints) || [];
process.stdout.write(String(hints.length));
' "$TMPD/t2.json")
[ "${DUP:-0}" -ge 1 ] && pass "duplicate title only warns (hints=$DUP, R3)" || fail "duplicate title did not warn"

# 8) triage validation: no acceptance criteria must fail
post issue.triage "{\"issueId\":\"$ISSUE_ID\",\"projectId\":\"$PROJECT_ID\",\"acceptance\":[]}" tri_bad >/dev/null
CODE=$(field "$TMPD/tri_bad.json" error.code)
[ "$CODE" = "E_ACCEPTANCE" ] && pass "triage without criteria refused (E_ACCEPTANCE)" || fail "triage without criteria returned '$CODE'"

# 9) triage ok
post issue.triage "{\"issueId\":\"$ISSUE_ID\",\"projectId\":\"$PROJECT_ID\",\"workspacePath\":\"$WS\",\"acceptance\":[{\"text\":\"项目/议题/TODO 能建\"},{\"text\":\"立项后能改状态\"}]}" tri >/dev/null
STATUS=$(field "$TMPD/tri.json" data.result.status)
[ "$STATUS" = "todo" ] && pass "triage -> status todo" || fail "triage returned status '$STATUS'"

# 10) acceptance tick + persisted flag
AC_ID=$(node -e '
const fs = require("fs");
const doc = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
const issues = (doc.issues || []).filter((issue) => issue.issueId === process.argv[2]);
process.stdout.write(issues.length ? issues[0].acceptanceCriteria[0].id : "");
' "$DATA" "$ISSUE_ID")
post acceptance.update "{\"issueId\":\"$ISSUE_ID\",\"acceptanceId\":\"$AC_ID\",\"done\":true}" acc >/dev/null
DONE=$(field "$TMPD/acc.json" data.result.criterion.done)
[ "$DONE" = "true" ] && pass "acceptance tick records done:true" || fail "acceptance tick returned '$DONE'"

# 11) status: human statuses work, done is refused
post issue.setStatus "{\"issueId\":\"$ISSUE_ID\",\"status\":\"in_progress\"}" st1 >/dev/null
[ "$(field "$TMPD/st1.json" data.result.status)" = "in_progress" ] && pass "setStatus in_progress" || fail "setStatus in_progress failed"
post issue.setStatus "{\"issueId\":\"$ISSUE_ID\",\"status\":\"in_review\"}" st2 >/dev/null
[ "$(field "$TMPD/st2.json" data.result.status)" = "in_review" ] && pass "setStatus in_review" || fail "setStatus in_review failed"
post issue.setStatus "{\"issueId\":\"$ISSUE_ID\",\"status\":\"done\"}" st_done >/dev/null
[ "$(field "$TMPD/st_done.json" ok)" = "false" ] && pass "setStatus done refused (D30)" || fail "setStatus done was accepted"
post issue.setStatus "{\"issueId\":\"$ISSUE_ID\",\"status\":\"cancelled\"}" st_cancel >/dev/null
[ "$(field "$TMPD/st_cancel.json" data.result.status)" = "cancelled" ] && pass "setStatus cancelled routes through the cancel action" || fail "cancel via setStatus failed"

# 12) archive only closing issues
post issue.setArchived "{\"issueId\":\"$ISSUE_ID\",\"archived\":true}" arch >/dev/null
[ "$(field "$TMPD/arch.json" data.result.archived)" = "true" ] && pass "archive cancelled issue" || fail "archive failed: $(cat "$TMPD/arch.json" | head -c 200)"

# 13) persisted document
if [ -f "$DATA" ]; then
  pass "data file exists: $DATA"
  node -e '
const fs = require("fs");
const doc = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
const project = doc.projects.find((p) => p.projectId === process.argv[2]);
const issue = doc.issues.find((i) => i.issueId === process.argv[3]);
const checks = [
  ["schemaVersion=2", doc.schemaVersion === 2],
  ["project persisted", Boolean(project) && project.defaultWorkspacePath === process.argv[4]],
  ["issue triaged", Boolean(issue) && issue.isTriaged === true],
  ["issue cancelled", Boolean(issue) && issue.status === "cancelled"],
  ["issue archived", Boolean(issue) && Boolean(issue.archivedAt)],
  ["criterion done", Boolean(issue) && issue.acceptanceCriteria[0].done === true],
  ["activity seq ascending", (issue.activities || []).every((a, i, arr) => i === 0 || a.seq > arr[i - 1].seq)],
  ["activity recorded", (issue.activities || []).length >= 4],
];
let bad = 0;
for (const [label, ok] of checks) { console.log((ok ? "PASS  " : "FAIL  ") + "data: " + label); if (!ok) bad++; }
process.exit(bad === 0 ? 0 : 1);
' "$DATA" "$PROJECT_ID" "$ISSUE_ID" "$WS" && PASSED=$((PASSED+8)) || FAIL=1
else
  fail "data file was not created at $DATA"
fi

# 15) 打回一轮：单元作废、议题回「待认领」、单元总数不变
post project.create '{"name":"S2 主流程：打回与异常","defaultWorkspacePath":"'"$WS"'"}' rf_p >/dev/null
RF_PROJECT=$(field "$TMPD/rf_p.json" data.result.projectId)
post todo.create '{"title":"S2 主流程：打回一轮的议题"}' rf_t >/dev/null
RF_ISSUE=$(field "$TMPD/rf_t.json" data.result.issueId)
post issue.triage '{"issueId":"'"$RF_ISSUE"'","projectId":"'"$RF_PROJECT"'","workspacePath":"'"$WS"'","acceptance":[{"text":"标准一"},{"text":"标准二"}]}' rf_tri >/dev/null
post unit.claim '{"issueId":"'"$RF_ISSUE"'","sessionId":"session-s2-reject","cwd":"'"$WS"'","sessionEnded":true}' rf_claim >/dev/null
RF_UNIT=$(field "$TMPD/rf_claim.json" data.result.unitId)
[ -n "$RF_UNIT" ] && pass "claim (ended session) -> $RF_UNIT" || fail "claim failed: $(cat "$TMPD/rf_claim.json" | head -c 200)"
UNITS_BEFORE=$(node -e 'const d=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));process.stdout.write(String(d.units.length))' "$DATA")
post unit.reject '{"unitId":"'"$RF_UNIT"'","reason":"本轮不达标，重开一轮"}' rf_reject >/dev/null
UNITS_AFTER=$(node -e 'const d=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));process.stdout.write(String(d.units.length))' "$DATA")
REJECT_STATUS=$(node -e 'const d=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));const i=d.issues.find(x=>x.issueId===process.argv[2]);process.stdout.write(i?i.status:"?")' "$DATA" "$RF_ISSUE")
[ "$REJECT_STATUS" = "in_progress" ] && pass "reject -> the same unit resumes (D-19), issue back to in_progress" || fail "reject left issue status '$REJECT_STATUS'"
[ "$UNITS_BEFORE" = "$UNITS_AFTER" ] && pass "reject keeps unit count ($UNITS_BEFORE)" || fail "reject changed unit count $UNITS_BEFORE -> $UNITS_AFTER"
RESUMED=$(node -e 'const d=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));process.stdout.write(String(d.units.filter(u=>u.voided!==true && u.execState==="running").length))' "$DATA")
[ "$RESUMED" -ge 1 ] && pass "rejected unit is running again (not voided, D-19)" || fail "no running unit after reject"

# 16) 异常结束：单元 failed、议题 blocked、收件箱出现 unit_abnormal、可改回待认领
post todo.create '{"title":"S2 主流程：异常结束的议题"}' ab_t >/dev/null
AB_ISSUE=$(field "$TMPD/ab_t.json" data.result.issueId)
post issue.triage '{"issueId":"'"$AB_ISSUE"'","projectId":"'"$RF_PROJECT"'","workspacePath":"'"$WS"'","acceptance":[{"text":"异常标准"}]}' ab_tri >/dev/null
post unit.claim '{"issueId":"'"$AB_ISSUE"'","sessionId":"session-s2-abnormal","cwd":"'"$WS"'"}' ab_claim >/dev/null
AB_UNIT=$(field "$TMPD/ab_claim.json" data.result.unitId)
post test.sessionEvent '{"sessionId":"session-s2-abnormal","kind":"turn/end","reason":{"kind":"error"}}' ab_evt >/dev/null
[ "$(field "$TMPD/ab_evt.json" ok)" = "true" ] && pass "test.sessionEvent drives a failed turn (seam)" || fail "sessionEvent failed: $(cat "$TMPD/ab_evt.json" | head -c 200)"
AB_STATE=$(node -e 'const d=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));const u=d.units.find(x=>x.unitId===process.argv[2]);const i=d.issues.find(x=>x.issueId===process.argv[3]);process.stdout.write((u?u.execState:"?")+"|"+(i?i.status:"?"))' "$DATA" "$AB_UNIT" "$AB_ISSUE")
[ "$AB_STATE" = "failed|blocked" ] && pass "abnormal unit -> failed + issue blocked (N3)" || fail "abnormal state was '$AB_STATE' (expected failed|blocked)"
curl -s -b "$JAR" "$BASE/workbench/api/inbox" -o "$TMPD/inbox_ab.json"
AB_DEC=$(node -e 'const d=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));process.stdout.write(String((d.data.decisions||[]).filter(x=>x.kind==="unit_abnormal"&&x.subjectRef===process.argv[2]).length))' "$TMPD/inbox_ab.json" "$AB_UNIT")
[ "$AB_DEC" = "1" ] && pass "inbox shows the unit_abnormal decision" || fail "inbox unit_abnormal count=$AB_DEC"
post decision.backToTodo '{"unitId":"'"$AB_UNIT"'","reason":"改回待认领"}' ab_back >/dev/null
AB_AFTER=$(node -e 'const d=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));const i=d.issues.find(x=>x.issueId===process.argv[2]);process.stdout.write(i?i.status:"?")' "$DATA" "$AB_ISSUE")
[ "$AB_AFTER" = "todo" ] && pass "decision.backToTodo closes the item and returns issue to todo" || fail "backToTodo left status '$AB_AFTER'"

# 17) 终验收：未满足项需二次确认，acknowledge 后写 done 且留痕
post unit.claim '{"issueId":"'"$AB_ISSUE"'","sessionId":"session-s2-final","cwd":"'"$WS"'","sessionEnded":true}' fn_claim >/dev/null
FN_UNIT=$(field "$TMPD/fn_claim.json" data.result.unitId)
post unit.accept '{"unitId":"'"$FN_UNIT"'"}' fn_accept >/dev/null
post issue.finalAccept '{"issueId":"'"$AB_ISSUE"'"}' fn_early >/dev/null
EARLY=$(field "$TMPD/fn_early.json" error.code)
[ "$EARLY" = "E_STATE" ] && pass "finalAccept without acknowledge is refused (E_STATE)" || fail "unmet gate returned '$EARLY'"
post issue.finalAccept '{"issueId":"'"$AB_ISSUE"'","acknowledgeUnmet":true}' fn_ok >/dev/null
FN_STATUS=$(node -e 'const d=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));const i=d.issues.find(x=>x.issueId===process.argv[2]);process.stdout.write(i?i.status:"?")' "$DATA" "$AB_ISSUE")
[ "$FN_STATUS" = "done" ] && pass "finalAccept with acknowledgeUnmet -> done" || fail "finalAccept left status '$FN_STATUS'"
TRACE=$(node -e 'const d=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));const i=d.issues.find(x=>x.issueId===process.argv[2]);process.stdout.write(String((i.activities||[]).filter(x=>/未满足项/.test(x.text)).length))' "$DATA" "$AB_ISSUE")
[ "$TRACE" -ge 1 ] && pass "acknowledged completion leaves an activity trace" || fail "no trace for unmet-acknowledged completion"

# 14) snapshot reflects the work (todo count / project rows)
snap > "$TMPD/snapshot1.json"
node -e '
const fs = require("fs");
const doc = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
const projects = (doc.data && doc.data.projects) || [];
const counters = (doc.data && doc.data.counters) || {};
console.log((Array.isArray(projects) ? "PASS  " : "FAIL  ") + "snapshot projects is an array (" + projects.length + ")");
console.log((typeof counters.todoCount === "number" ? "PASS  " : "FAIL  ") + "snapshot counters.todoCount=" + counters.todoCount);
process.exit(Array.isArray(projects) && typeof counters.todoCount === "number" ? 0 : 1);
' "$TMPD/snapshot1.json" || FAIL=1

kill "$PID" 2>/dev/null; wait "$PID" 2>/dev/null; trap - EXIT

echo '--- artifacts ---'
echo "home:   $HOME_DIR (will be removed; copy it first to inspect boot.log)"
echo "log:    $LOG"
echo "api:    $TMPD"
echo "cdp:    $URL"
echo "----"
echo "S2 assertions passed: $PASSED"
[ "$FAIL" -eq 0 ] && echo "S2 ACCEPTANCE: OK" || echo "S2 ACCEPTANCE: BROKEN"
if [ "$FAIL" -ne 0 ]; then
  echo '--- host log tail ---'; tail -20 "$LOG"
  cp "$LOG" "$OUT/S2-failure-boot.log" 2>/dev/null
  cp "$TMPD"/*.json "$OUT/" 2>/dev/null
fi
rm -rf "$HOME_DIR" "$WS"
exit "$FAIL"
