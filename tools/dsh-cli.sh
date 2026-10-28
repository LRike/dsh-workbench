#!/bin/sh
# Probe helper: run the DSH CLI bundled inside the Desktop app (approval-free).
# Usage: probe/tools/dsh-cli.sh [--profile <name>] <app-args...>
set -eu
export ELECTRON_RUN_AS_NODE=1
BIN='/Applications/DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness'
CLI='/Applications/DeepSeek Harness.app/Contents/Resources/app.asar/dsh/node_modules/@deepseek-ai/dsh-desktop-host/lib/cli.js'
exec "$BIN" "$CLI" "$@"
