#!/usr/bin/env bash
# 全息屏立牌本地部署：启/停一个局域网可访问的服务器，专供 holo.html 投屏展示。
#
#   scripts/holo.sh start    # 启动（后台常驻，局域网设备可访问）
#   scripts/holo.sh stop     # 关闭
#   scripts/holo.sh status   # 查看状态
#
# 说明：用 vite dev server 绑 0.0.0.0，同一 Wi-Fi 下任意设备打开打印出的地址即可。
set -euo pipefail

PORT=4190
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PID_FILE="$ROOT/.holo-server.pid"
LOG_FILE="$ROOT/.holo-server.log"

lan_ip() {
  ipconfig getifaddr en0 2>/dev/null \
    || ipconfig getifaddr en1 2>/dev/null \
    || echo "127.0.0.1"
}

is_running() {
  [[ -f "$PID_FILE" ]] && kill -0 "$(cat "$PID_FILE")" 2>/dev/null
}

start() {
  if is_running; then
    echo "已在运行 (PID $(cat "$PID_FILE"))。地址见下方。"
  else
    cd "$ROOT"
    # 直接跑 vite 二进制（非 npx），$! 即真正的 node 进程，stop 才杀得干净。
    nohup "$ROOT/node_modules/.bin/vite" --host 0.0.0.0 --port "$PORT" --strictPort >"$LOG_FILE" 2>&1 &
    echo $! >"$PID_FILE"
    # 等 vite 起来（最多 ~10s）
    for _ in $(seq 1 20); do
      if grep -q "ready in" "$LOG_FILE" 2>/dev/null; then break; fi
      sleep 0.5
    done
  fi
  local ip; ip="$(lan_ip)"
  echo "───────────────────────────────────────────────"
  echo "全息屏已启动 ✅  (PID $(cat "$PID_FILE"))"
  echo "  本机:     http://localhost:$PORT/holo.html"
  echo "  局域网:   http://$ip:$PORT/holo.html"
  echo "  指定服务器: http://$ip:$PORT/holo.html?server=http://your-aiboo-host:3456"
  echo "  指定角色:   http://$ip:$PORT/holo.html?avatar=shuangsheng"
  echo "  关闭:     scripts/holo.sh stop"
  echo "───────────────────────────────────────────────"
}

stop() {
  local had=0
  if is_running; then
    kill "$(cat "$PID_FILE")" 2>/dev/null || true
    had=1
  fi
  rm -f "$PID_FILE"
  # 补一刀：清掉任何仍占用该端口的残留进程（防 npx/子进程遗漏）。
  local strays; strays="$(lsof -ti tcp:"$PORT" 2>/dev/null || true)"
  if [[ -n "$strays" ]]; then
    echo "$strays" | xargs kill -9 2>/dev/null || true
    had=1
  fi
  if [[ "$had" == "1" ]]; then echo "全息屏已关闭 🛑"; else echo "未在运行。"; fi
}

status() {
  if is_running; then
    echo "运行中 (PID $(cat "$PID_FILE"))  →  http://$(lan_ip):$PORT/holo.html"
  else
    echo "未运行。"
  fi
}

case "${1:-}" in
  start) start ;;
  stop) stop ;;
  restart) stop; sleep 1; start ;;
  status) status ;;
  *) echo "用法: scripts/holo.sh {start|stop|restart|status}"; exit 1 ;;
esac
