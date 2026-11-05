#!/usr/bin/env bash
# 在 Ben 的阿里云主机上装 LiveKit 服务端(工作台通道层的碰头点)。
# 用法(在 Mac 上跑,会通过 SSH 在服务器上执行;**域名必须给**,我们那台的在 deploy/release-endpoints.env):
#   ssh aiboo-server 'LIVEKIT_DOMAIN=lk.aibooo.cn bash -s' < deploy/aliyun-livekit-setup.sh
# 前提:/usr/local/bin/livekit-server 已装;Caddy 在跑;DNS lk.aibooo.cn → 本机;安全组放行 TCP 7881、UDP 50000-50200。
# 密钥在服务器上生成,只落在 /opt/livekit/(0600),不打印到终端。
set -euo pipefail
# 域名必须给:ssh 主机 'LIVEKIT_DOMAIN=lk.example.com bash -s' < deploy/aliyun-livekit-setup.sh
# 不带缺省(2026-10-21,局域网 M7):漏给就停,不猜一个域名。
DOMAIN="${LIVEKIT_DOMAIN:-}"
if [ -z "$DOMAIN" ]; then
  echo "要给房间服务的域名:ssh 主机 'LIVEKIT_DOMAIN=你的域名 bash -s' < deploy/aliyun-livekit-setup.sh" >&2
  exit 2
fi
mkdir -p /opt/livekit && cd /opt/livekit

if [ ! -f livekit.yaml ]; then
  livekit-server generate-keys > keys.txt
  chmod 600 keys.txt
  K=$(grep -i 'api key' keys.txt | awk '{print $NF}')
  SEC=$(grep -i 'api secret' keys.txt | awk '{print $NF}')
  rm -f keys.txt
  cat > livekit.yaml <<YML
port: 7880
bind_addresses: ["127.0.0.1"]
rtc:
  tcp_port: 7881
  port_range_start: 50000
  port_range_end: 50200
  use_external_ip: true
keys:
  ${K}: ${SEC}
logging:
  level: info
YML
  chmod 600 livekit.yaml
  printf '{"api_key":"%s","api_secret":"%s","url":"wss://%s"}\n' "$K" "$SEC" "$DOMAIN" > channel.json
  chmod 600 channel.json
  echo "已生成密钥与 /opt/livekit/livekit.yaml、/opt/livekit/channel.json"
else
  echo "livekit.yaml 已存在,密钥不动"
fi

cat > /etc/systemd/system/livekit.service <<UNIT
[Unit]
Description=LiveKit server (workbench channel)
After=network.target

[Service]
ExecStart=/usr/local/bin/livekit-server --config /opt/livekit/livekit.yaml
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
UNIT
systemctl daemon-reload
systemctl enable --now livekit
sleep 2
systemctl is-active livekit && echo "livekit 服务已启动"

cp -n /etc/caddy/Caddyfile /etc/caddy/Caddyfile.bak-livekit-20260917 || true
if ! grep -q "$DOMAIN" /etc/caddy/Caddyfile; then
  printf '\n%s {\n\treverse_proxy 127.0.0.1:7880\n}\n' "$DOMAIN" >> /etc/caddy/Caddyfile
fi
caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile
systemctl reload caddy
echo "Caddy 已加 $DOMAIN → 127.0.0.1:7880(证书自动申请,首次访问约需几十秒)"
echo "完成。下一步在 Mac 上跑:"
echo "  mkdir -p ~/.dsh/workbench && ssh aiboo-server cat /opt/livekit/channel.json > ~/.dsh/workbench/channel.json && chmod 600 ~/.dsh/workbench/channel.json"
