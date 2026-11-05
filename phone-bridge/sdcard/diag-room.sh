#!/bin/sh
# 座机「进不了房」的只读诊断(2026-09-27)。ssh 到不了派时,由 cloud-init 的 runcmd 用
# `systemd-run` 拉起,每 60 秒把一份快照写到启动分区的 pi-room.txt,拔卡到 Mac 上看。
#
# 只读:不改 device.json、不重启任何服务、不发任何请求到工作台或中转。
# 不写任何凭据:令牌只报「有没有」,日志里长得像令牌的串一律抹掉。
OUT=/boot/firmware/pi-room.txt
DIR=/home/ben/phone-bridge
LOG="$DIR/popphone.log"

red() {
  sed -E 's/eyJ[A-Za-z0-9._-]{10,}/<jwt>/g; s/wb_[A-Za-z0-9_-]{8,}/<wb令牌>/g'
}

dump() {
  echo "=== 第 $1 轮 $(date) up $(cut -d' ' -f1 /proc/uptime)s ==="
  echo "--- phone-bridge ---"
  systemctl --user -M ben@ is-active phone-bridge 2>&1
  echo "--- device.json(只列字段,令牌只报有没有) ---"
  python3 - "$DIR/device.json" <<'PY' 2>&1
import json, sys, time
try:
    d = json.load(open(sys.argv[1]))
except Exception as err:
    print("读不出:", err); sys.exit(0)
print("字段:", sorted(d.keys()))
for k in ("relay", "device_id", "name", "workbench_http", "identity"):
    if k in d: print(f"{k}: {d[k]}")
for k in ("token", "relay_token"):
    print(f"{k}: {'有' if d.get(k) else '没有'}")
t = d.get("ticket")
if isinstance(t, dict):
    exp = t.get("expires_at") or 0
    left = f"{(exp - time.time()) / 3600:.1f} 小时后到期" if exp else "没给到期时间"
    print(f"ticket: room={t.get('room')} identity={t.get('identity')} url={t.get('url')} {left} token={'有' if t.get('token') else '没有'}")
else:
    print("ticket: 没有")
PY
  echo "--- livekit 装没装上 ---"
  "$DIR/venv/bin/python" -c "import livekit.rtc as r; print('livekit.rtc', getattr(r, '__version__', '?'))" 2>&1 | tail -2
  echo "--- 外网两处 ---"
  echo "中转: $(curl -sI -m 6 https://api.aibooo.cn 2>&1 | head -1)"
  echo "房间: $(curl -sI -m 6 https://lk.aibooo.cn 2>&1 | head -1)"
  echo "--- popphone.log(去掉 [live] 刷屏与 livekit 底层,最后 80 行) ---"
  grep -av '^livekit' "$LOG" 2>/dev/null | grep -av '^\[live\]' | tail -80 | red
  echo "--- 报错(最后 30 行) ---"
  grep -a -E 'Traceback|Error|error|错' "$LOG" 2>/dev/null | grep -av '^\[live\]' | tail -30 | red
  echo "--- livekit 底层(最后 15 行) ---"
  grep -a '^livekit' "$LOG" 2>/dev/null | tail -15 | red
}

i=1
while [ "$i" -le 15 ]; do
  dump "$i" > "$OUT.tmp" 2>&1 && mv "$OUT.tmp" "$OUT"
  sync
  i=$((i + 1))
  sleep 60
done
