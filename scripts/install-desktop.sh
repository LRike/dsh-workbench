#!/bin/sh
# Install/upgrade the workbench plugin into the local DSH Desktop profile.
# DSH Desktop owns that profile, so the app must be fully quit first.
set -u
PLUGIN=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
# Output dirs default to the plugin; override with WB_WORKSPACE if you keep one.
ROOT=$PLUGIN
WB_WS_OVERRIDE=$(printenv WB_WORKSPACE 2>/dev/null || true)
if [ -n "$WB_WS_OVERRIDE" ]; then ROOT=$WB_WS_OVERRIDE; fi
TGZ=$(ls -1 "$PLUGIN"/dist/local-dsh-workbench-*.tgz 2>/dev/null | sort | tail -1)
[ -n "$TGZ" ] || { echo "no tarball in $PLUGIN/dist — run scripts/pack.sh first"; exit 2; }
echo "package: $TGZ"
echo "installing into profile: desktop"
DSH_HOME="$HOME" "$ROOT/"$PLUGIN"/tools/dsh-cli.sh" plugin --profile desktop add --offline "file:$TGZ"
STATUS=$?
if [ "$STATUS" -ne 0 ]; then
  cat <<'MSG'

如果上面报 “profile is managed exclusively by the Electron application”：
  1. 完全退出 DSH Desktop（Cmd+Q，不是关窗口）
  2. 重新执行本脚本
  3. 重新打开 DSH Desktop，侧栏「工作台」即为新版本
MSG
  exit "$STATUS"
fi
echo
echo "installed. 重启 DSH Desktop 后生效。"
node -e 'const p=require(process.env.HOME+"/.dsh/profiles/desktop/node_modules/@local/dsh-workbench/package.json");console.log("installed version: "+p.version)' 2>/dev/null || true
