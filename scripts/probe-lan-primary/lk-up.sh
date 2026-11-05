#!/bin/zsh
# 探针①的前半:在这台 Mac 上起一台「本机房间」(livekit-server),按设计稿定的端口与绑法。
# 不碰 ~/.dsh、不碰正在跑的 8791 / 工人 / 云房间;钥匙是这次现生成的一对,只落在 OUT 目录。
#
# 用法:scripts/probe-lan-primary/lk-up.sh [OUT 目录]
#   LK_PORT=7890 换一组口(信令 LK_PORT、ICE/TCP LK_PORT+1、UDP LK_PORT+2;缺省 7880):本机已有别的房间占着 7880 时用
#   OUT 缺省 $TMPDIR/wb-lan-probe;里面会有 livekit.yaml、keys.env(0600)、lk.log、lk.pid、up.json
# 停:kill $(cat OUT/lk.pid)
set -eu
OUT=${1:-${TMPDIR:-/tmp}/wb-lan-probe}
mkdir -p "$OUT"
LK=${LIVEKIT_SERVER:-$(command -v livekit-server)}
IFACE=$(route -n get default 2>/dev/null | awk '/interface:/{print $2}')
LAN_IP=$(ipconfig getifaddr "${IFACE:-en0}")
PORT=${LK_PORT:-7880}

if [[ -f "$OUT/lk.pid" ]] && kill -0 "$(cat "$OUT/lk.pid")" 2>/dev/null; then
  echo "本机房间已经在跑(pid $(cat "$OUT/lk.pid"))"; exit 0
fi

# 现生成一对钥匙(探针专用,不是任何人的密钥;不打印 secret)
if [[ ! -f "$OUT/keys.env" ]]; then
  KEYS=$("$LK" generate-keys)
  KEY=$(print -r -- "$KEYS" | awk -F': *' '/API Key/{print $2}')
  SECRET=$(print -r -- "$KEYS" | awk -F': *' '/API Secret/{print $2}')
  umask 077
  print -r -- "LK_KEY=$KEY" > "$OUT/keys.env"
  print -r -- "LK_SECRET=$SECRET" >> "$OUT/keys.env"
fi
source "$OUT/keys.env"

# 端口:7880 信令(HTTP/WS)、7881 ICE/TCP 兜底、7882 单个 UDP 口(媒体)。
# 单 UDP 口而不是 50000-60000:防火墙只放三个口,路由器/系统弹窗也只问一次。
cat > "$OUT/livekit.yaml" <<EOF
port: $PORT
bind_addresses: ["0.0.0.0"]
rtc:
  tcp_port: $((PORT+1))
  udp_port: $((PORT+2))
  use_external_ip: false
  node_ip: $LAN_IP
keys:
  $LK_KEY: $LK_SECRET
logging:
  level: info
room:
  empty_timeout: 300
EOF
chmod 600 "$OUT/livekit.yaml"

T0=$(perl -MTime::HiRes=time -e 'printf "%d", time*1000')
"$LK" --config "$OUT/livekit.yaml" > "$OUT/lk.log" 2>&1 &
echo $! > "$OUT/lk.pid"
for i in $(seq 1 200); do
  if curl -s -m 1 -o /dev/null "http://127.0.0.1:$PORT"; then break; fi
  sleep 0.05
done
T1=$(perl -MTime::HiRes=time -e 'printf "%d", time*1000')
PID=$(cat "$OUT/lk.pid")
sleep 1
RSS_KB=$(ps -o rss= -p "$PID" | tr -d ' ')
SIZE=$(stat -f %z "$(readlink -f "$LK")")
GZ=$(gzip -c "$(readlink -f "$LK")" | wc -c | tr -d ' ')
VER=$("$LK" --version | awk '{print $NF}')
cat > "$OUT/up.json" <<EOF
{"lan_ip":"$LAN_IP","iface":"$IFACE","pid":$PID,"startup_ms":$((T1-T0)),"rss_mb":$((RSS_KB/1024)),"binary_bytes":$SIZE,"binary_gzip_bytes":$GZ,"version":"$VER","signal":"ws://$LAN_IP:$PORT","tcp":$((PORT+1)),"udp":$((PORT+2))}
EOF
cat "$OUT/up.json"
