#!/usr/bin/env bash
# 构建 holo 前端「自更新包」：holo-assets.zip(dist 除 live2D) + version.json(内容 sha)。
# exe launcher 启动时拉 version.json 比对，变了才下 zip 解压覆盖 web/(Live2D 本地保留)。
# 用法： bash holo-desktop/build-update.sh [--build]   （--build 才重跑 vite，否则复用现有 dist/）
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT="$ROOT/holo-desktop/update-out"
cd "$ROOT"

if [ "${1:-}" = "--build" ]; then
  echo "[1/3] vite build…"
  npm run build
else
  echo "[1/3] 复用现有 dist/（加 --build 可重跑 vite）"
fi

echo "[2/3] 打 holo-assets.zip（排除 live2D）…"
rm -rf "$OUT"; mkdir -p "$OUT"
( cd dist && zip -rq "$OUT/holo-assets.zip" . -x 'live2D/*' )

echo "[3/3] 生成 version.json（内容 sha，改了才变）…"
VER="$(shasum -a 1 "$OUT/holo-assets.zip" | cut -c1-12)"
printf '{"version":"%s"}\n' "$VER" > "$OUT/version.json"

echo "完成。version=$VER"
ls -la "$OUT"
