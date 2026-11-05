#!/usr/bin/env bash
# 发布 holo.exe(launcher 本体)：pkg 编译 + rsync 到阿里云(供用户端 exe 自更新拉取) + 出小交付 zip。
# 只有改了 holo-desktop/server.cjs(launcher) 才需要跑；平时前端改动走 publish-update.sh。
# ★跑前先把 server.cjs 里的 EXE_VERSION +1★（用户端据它判断要不要自更新）。
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BUILD="$ROOT/holo-desktop/build"
SSH_HOST="aiboo-server"
REMOTE_DIR="/root/aiboo/admin-ui/dist/holo-up"
BACKEND="http://your-aiboo-host:3456"
cd "$ROOT"

EXE_VER="$(sed -n "s/.*EXE_VERSION = '\([^']*\)'.*/\1/p" holo-desktop/server.cjs | head -1)"
[ -n "$EXE_VER" ] || { echo "读不到 EXE_VERSION"; exit 1; }

# 输出 holo.bin（非 .exe，避开本机沙箱对 .exe 文件的改名）；rsync/zip 时再当 holo.exe。
echo "[1/4] pkg 编译 holo.exe (EXE_VERSION=$EXE_VER) → build/holo.bin…"
mkdir -p "$BUILD"
npx -y @yao-pkg/pkg@latest holo-desktop/server.cjs --targets node22-win-x64 \
  --public --public-packages "*" --output "$BUILD/holo.bin"

echo "[2/4] 生成 exe-version.json…"
printf '{"version":"%s"}\n' "$EXE_VER" > "$BUILD/exe-version.json"

echo "[3/4] rsync 到阿里云 $REMOTE_DIR（供 exe 自更新拉取）…"
ssh -o ConnectTimeout=15 "$SSH_HOST" "mkdir -p $REMOTE_DIR"
rsync -az -e "ssh -o ConnectTimeout=15" "$BUILD/holo.bin" "$SSH_HOST:$REMOTE_DIR/holo.exe"
rsync -az -e "ssh -o ConnectTimeout=15" "$BUILD/exe-version.json" "$SSH_HOST:$REMOTE_DIR/exe-version.json"
curl -s -m 10 "$BACKEND/holo-up/exe-version.json" && echo

echo "[4/4] 出小交付 zip（holo.exe + 启动全息屏.bat + README）——给 Ben 手动上传一次…"
STAGE="$BUILD/exe-delivery"
rm -rf "$STAGE"; mkdir -p "$STAGE"
cp "$BUILD/holo.bin" "$STAGE/holo.exe"
cp "holo-desktop/启动全息屏.bat" "$STAGE/启动全息屏.bat"
cp "holo-desktop/README-使用说明.txt" "$STAGE/README-使用说明.txt"
( cd "$STAGE" && rm -f ../holo-exe-update.zip && zip -rq ../holo-exe-update.zip . )
echo "★交付 zip：$BUILD/holo-exe-update.zip（Ben 上传解压到现有文件夹，覆盖 holo.exe + 加 .bat）"
ls -la "$BUILD/holo-exe-update.zip"
