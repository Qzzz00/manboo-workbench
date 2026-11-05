#!/usr/bin/env bash
# 发布 holo 前端更新到阿里云：build-update → rsync 到 admin-ui 静态根下的 /holo-up。
# 以后改完前端跑这一条，用户重启 holo.exe 即自动拉最新（不用再传文件）。
# 用法： bash holo-desktop/publish-update.sh [--build]   （--build 才重跑 vite，否则复用现有 dist/）
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SSH_HOST="aiboo-server"                                   # ~/.ssh/config: <your-server-host>
REMOTE_DIR="/root/aiboo/admin-ui/dist/holo-up"            # 后端 express.static(admin-ui/dist) 伺服根 → /holo-up
BACKEND="http://your-aiboo-host:3456"

echo "[1/3] 构建更新包…"
bash "$ROOT/holo-desktop/build-update.sh" "${1:-}"

echo "[2/3] rsync 到阿里云 $REMOTE_DIR …"
ssh -o ConnectTimeout=15 "$SSH_HOST" "mkdir -p $REMOTE_DIR"
rsync -az -e "ssh -o ConnectTimeout=15" \
  "$ROOT/holo-desktop/update-out/version.json" \
  "$ROOT/holo-desktop/update-out/holo-assets.zip" \
  "$SSH_HOST:$REMOTE_DIR/"

echo "[3/3] 验证 HTTP 可达…"
curl -s -m 10 "$BACKEND/holo-up/version.json" && echo
echo "已发布。用户重启 holo.exe 即自动更新（约 15-20s 首拉）。"
