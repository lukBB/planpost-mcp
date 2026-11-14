#!/bin/sh
# Assembles the ZIP for the OpenAI plugin directory (platform.openai.com/plugins).
# Layout follows developers.openai.com/plugins/build/plugins (Agent Plugins
# format): plugin.json and mcp.json at the root, skills/ and assets/ beside them.
# Usage: sh openai-plugin/build.sh [output.zip]
set -eu
here=$(cd "$(dirname "$0")" && pwd)
pkg=$(dirname "$here")
out=${1:-"$pkg/planpost-openai-plugin.zip"}
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
mkdir -p "$tmp/planpost/assets" "$tmp/planpost/skills"
cp "$here/plugin.json" "$here/mcp.json" "$tmp/planpost/"
cp "$pkg/assets/icon-512.png" "$tmp/planpost/assets/"
cp -R "$pkg/skills/planpost" "$tmp/planpost/skills/"
cp "$pkg/LICENSE" "$tmp/planpost/"
rm -f "$out"
(cd "$tmp/planpost" && zip -qr "$out" . -x '.*')
echo "wrote $out"
