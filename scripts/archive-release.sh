#!/bin/sh
# Build a shareable release archive for the current (pinned) version:
#   <archive>/install/  the .tgz users install + its sha256
#   <archive>/source/   a source snapshot (no node_modules / dist)
#   <archive>/docs/     the acceptance report + machine-readable results
#   <archive>/MANIFEST.txt  version, commit, checksums, gate summary
set -eu
PLUGIN=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
# Output dirs default to the plugin; override with WB_WORKSPACE if you keep one.
ROOT=$PLUGIN
WB_WS_OVERRIDE=$(printenv WB_WORKSPACE 2>/dev/null || true)
if [ -n "$WB_WS_OVERRIDE" ]; then ROOT=$WB_WS_OVERRIDE; fi
cd "$ROOT"

VERSION=$(node -p "require('$PLUGIN/package.json').version")
COMMIT=$(git rev-parse --short HEAD 2>/dev/null || echo "uncommitted")
STAMP=$(date +%Y%m%d-%H%M)
NAME="dsh-workbench-$VERSION-$STAMP"
OUT="$PLUGIN/dist/archive"
STAGE=$(mktemp -d /tmp/wb-archive-XXXXXX)
ARCHIVE="$STAGE/$NAME"

# 1) install artifact (rebuild so the archive always matches the working tree)
(cd "$PLUGIN" && ./scripts/pack.sh >/dev/null)
mkdir -p "$ARCHIVE/install"
cp "$PLUGIN/dist/local-dsh-workbench-$VERSION.tgz" "$ARCHIVE/install/"
(cd "$ARCHIVE/install" && shasum -a 256 "local-dsh-workbench-$VERSION.tgz" > "local-dsh-workbench-$VERSION.tgz.sha256")

# 2) source snapshot
mkdir -p "$ARCHIVE/source"
tar -czf "$ARCHIVE/source/workbench-plugin-$VERSION-src.tar.gz" \
  --exclude='node_modules' --exclude='dist' --exclude='*.log' --exclude='.DS_Store' \
  -C "$ROOT" workbench-plugin

# 3) documents
mkdir -p "$ARCHIVE/docs"
[ -f "$ROOT/docs/loop/phase4/REPORT.md" ] && cp "$ROOT/docs/loop/phase4/REPORT.md" "$ARCHIVE/docs/REPORT-phase4.md"
for f in ui-strict-results.json ui-flows-results.json ui-claim-results.json; do
  [ -f "$ROOT/docs/loop/phase4/$f" ] && cp "$ROOT/docs/loop/phase4/$f" "$ARCHIVE/docs/"
done
[ -f "$PLUGIN/README.md" ] && cp "$PLUGIN/README.md" "$ARCHIVE/README.md"

# 4) manifest
GATES=""
if [ -f /tmp/wb-gates3.log ]; then
  GATES=$(grep -E 'UI STRICT:|UI FLOWS:|UI CLAIM:|UI ACCEPTANCE:|DESKTOP-COMPOSITION|^# (tests|pass|fail)|tsc:|S2 assertions|S2 ACCEPTANCE|E2E ACCEPTANCE|P3 ' /tmp/wb-gates3.log | sed 's/^/  /')
fi
{
  echo "DSH 个人任务工作台 — 发布归档"
  echo "=================================="
  echo "version      : $VERSION"
  echo "commit       : $COMMIT"
  echo "built at     : $(date '+%Y-%m-%d %H:%M:%S %Z')"
  echo "install pkg  : install/local-dsh-workbench-$VERSION.tgz"
  echo "install sha  : $(cut -d' ' -f1 "$ARCHIVE/install/local-dsh-workbench-$VERSION.tgz.sha256")"
  echo
  echo "安装方式（对方机器）"
  echo "  dsh plugin --profile desktop add --offline \"file:/绝对路径/local-dsh-workbench-$VERSION.tgz\""
  echo "  然后完全退出并重开 DSH Desktop。"
  echo
  echo "内容清单"
  (cd "$ARCHIVE" && find . -type f | sort | sed 's/^/  /')
  echo
  echo "最近一次门禁结果（来自本机 /tmp/wb-gates3.log）"
  echo "${GATES:-  （日志不可用，请重跑 workbench-plugin/scripts/verify-ui-strict.sh）}"
} > "$ARCHIVE/MANIFEST.txt"

# 5) archive + checksum
mkdir -p "$OUT"
tar -czf "$OUT/$NAME.tar.gz" -C "$STAGE" "$NAME"
(cd "$OUT" && shasum -a 256 "$NAME.tar.gz" > "$NAME.tar.gz.sha256")
rm -rf "$STAGE"

echo "archived: $OUT/$NAME.tar.gz"
echo "size    : $(du -h "$OUT/$NAME.tar.gz" | cut -f1)"
echo "sha256  : $(cut -d' ' -f1 "$OUT/$NAME.tar.gz.sha256")"
echo
echo "contents:"
tar -tzf "$OUT/$NAME.tar.gz" | sed 's/^/  /'
