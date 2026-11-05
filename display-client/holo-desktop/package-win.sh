#!/usr/bin/env bash
# 一键打包 Aiboo 全息屏 Windows 演示版：vite build → 打 holo.exe → 组装交付文件夹。
# 用法： bash holo-desktop/package-win.sh
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT="$ROOT/holo-desktop/aiboo-holo-win"   # 交付文件夹（拷到 Windows 用）
cd "$ROOT"

echo "[1/4] 构建前端产物 (vite build)…"
npm run build

echo "[2/4] 交叉编译 holo.exe (node22-win-x64)…"
# --public：禁用 V8 字节码。从 Mac 交叉编译 Windows exe 必须加，否则目标机 V8 拒绝
# 执行字节码（Error: [pkg] V8 rejected the bytecode cache … mismatched host/target V8）。
npx -y @yao-pkg/pkg@latest holo-desktop/server.cjs --targets node22-win-x64 \
  --public --public-packages "*" --output holo-desktop/build/holo.exe

echo "[3/4] 组装交付文件夹 $OUT …"
rm -rf "$OUT"
mkdir -p "$OUT"
cp holo-desktop/build/holo.exe "$OUT/holo.exe"
cp "holo-desktop/启动全息屏.bat" "$OUT/启动全息屏.bat"
cp holo-desktop/README-使用说明.txt "$OUT/README-使用说明.txt"
printf 'http://your-aiboo-host:3456\n' > "$OUT/server.txt"
# web/ = 前端产物（含 Live2D 素材）。用 rsync 复制。
rsync -a --delete dist/ "$OUT/web/"

echo "[4/4] 完成。交付文件夹："
du -sh "$OUT"
ls -la "$OUT"
echo
echo "把整个 $OUT 文件夹拷到 Windows，双击 holo.exe 即可。"
