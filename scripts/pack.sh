#!/bin/sh
# Build the shareable single-file artifact: local-dsh-workbench-<version>.tgz
# Contents are limited by package.json "files" (runtime only, no tests/probe).
set -eu
cd "$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"
# Always rebuild the client from client-src/ first: packing a stale bundle is the
# easiest way to ship a build that does not match the sources.
node scripts/build-client.mjs
rm -f local-dsh-workbench-*.tgz
npm pack --silent
TGZ=$(ls -1 local-dsh-workbench-*.tgz | head -1)
mkdir -p dist
cp "$TGZ" dist/
shasum -a 256 "dist/$TGZ" > "dist/$TGZ.sha256"
echo "packed: dist/$TGZ"
echo "size:   $(du -h "dist/$TGZ" | cut -f1)"
echo "sha256: $(cut -d' ' -f1 "dist/$TGZ.sha256")"
echo
echo "install on another machine:"
echo "  dsh plugin --profile desktop add --offline \"file:$PWD/dist/$TGZ\""
