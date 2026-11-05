#!/usr/bin/env bash
#
# 把 phone-bridge 推到派上、装依赖、重启服务。**从 Mac 上跑,不在派上跑。**
#
#   ./phone-bridge/deploy.sh 172.20.10.4
#   ./phone-bridge/deploy.sh 172.20.10.4 --pair 123456   # 顺带配对(码在电脑端设置里生成)
#
# 找派的 IP:热点是 DHCP,会变。`pizero.local` 在 Mac 上解析不了(只能用 IP),
# 找法见 docs/硬件-POP话筒与树莓派桥.md「连接方式」。
#
# ⚠️ **派要连一个有互联网的 2.4G 网**。这一版比以前多一样:`pip install livekit`
# 要去 PyPI 拉一个 10.6MB 的 wheel。iPhone 热点是通外网的,所以照旧连热点就行;
# 但如果哪天把派挪到一个只有局域网的 Wi-Fi 上,这一步会卡住,而卡住的地方看起来
# 像是"ssh 没反应"。**Zero 2W 上这一步要几分钟,别当成死机。**
#
# 不做的事:不 sudo(派上 sudo 要密码,而 Claude 不经手 Ben 的密码);
# 不碰 ALSA 设置;不重启派。
set -euo pipefail

HOST="${1:?用法:deploy.sh <派的IP> [--pair 六位码]}"
shift || true
KEY="${SSH_KEY:-$HOME/.ssh/remarkable_paper_pro}"
USER="${PI_USER:-ben}"
DIR="/home/$USER/phone-bridge"
HERE="$(cd "$(dirname "$0")" && pwd)"
SSH=(ssh -i "$KEY" -o ConnectTimeout=10 "$USER@$HOST")

echo "=== 1/5 探一眼派在不在 ==="
"${SSH[@]}" 'echo "  派:$(hostname) $(uname -m);内存 $(free -m | awk "/Mem:/{print \$2}")MB;温度 $(vcgencmd measure_temp 2>/dev/null || echo n/a)"'

echo "=== 2/5 推代码 ==="
"${SSH[@]}" "mkdir -p $DIR"
scp -q -i "$KEY" \
  "$HERE"/{popphone.py,phone_state.py,signals.py,pairing.py,audio.py,room_link.py,requirements.txt} \
  "$USER@$HOST:$DIR/"
# 配网那一套(2026-09-22)。**只推文件,不装服务** —— 装 system 级 unit 要 sudo,
# 而这个脚本的老规矩是不 sudo。装法见最后那段提示与 docs/交接-0922-座机配网走App.md。
scp -q -i "$KEY" "$HERE"/{provision.py,provisiond.py,netcfg.py,wb-provision.service} "$USER@$HOST:$DIR/"

echo "=== 3/5 装依赖(第一次要几分钟:livekit 那个 wheel 10.6MB) ==="
# --no-cache-dir:32GB 卡不必留一份 pip 缓存,而且缓存过的 wheel 会掩盖"其实没下下来"。
# --system-site-packages:gpiozero/lgpio 用 apt 那份(见 requirements.txt);对已有的 venv 重跑一遍
# 只是改写 pyvenv.cfg,不动装好的包。
"${SSH[@]}" "cd $DIR && python3 -m venv --system-site-packages venv && venv/bin/pip -q install --no-cache-dir -U pip && venv/bin/pip install --no-cache-dir -r requirements.txt"

echo "=== 4/5 自检(**不猜,逐样报**) ==="
"${SSH[@]}" "cd $DIR && venv/bin/python - <<'PY'
import importlib, shutil, subprocess, sys
def say(name, ok, extra=''):
    print(f\"  {'有' if ok else '没有'}  {name}{(' · ' + extra) if extra else ''}\")
for mod in ('livekit.rtc', 'websockets', 'gpiozero'):
    try:
        importlib.import_module(mod); say(mod, True)
    except Exception as err:
        say(mod, False, str(err)[:80])
for tool in ('arecord', 'aplay'):
    say(tool, shutil.which(tool) is not None)
try:
    cards = subprocess.run(['arecord','-l'], capture_output=True, text=True).stdout
    say('POP 话筒(arecord -l 里有 USB Audio)', 'USB' in cards, cards.strip().splitlines()[-1] if cards.strip() else '一个录音设备都没有')
except Exception as err:
    say('arecord -l', False, str(err)[:80])
PY"

echo "--- 配网那一套(BLE,2026-09-22)。**用系统 python3 跑,不进 venv** ---"
# 为什么不在 venv 里查:provisiond 要的 dbus/gi 是 apt 的二进制包,
# venv 即使带 --system-site-packages 也只是"看得见",而它本来就该用 /usr/bin/python3 跑。
"${SSH[@]}" "cd $DIR && /usr/bin/python3 provisiond.py --check" || \
  echo "  ⚠️ 自检没跑完 —— provisiond.py 推上去了吗?"

echo "=== 5/5 装服务并重启 ==="
scp -q -i "$KEY" "$HERE/phone-bridge.service" "$USER@$HOST:/tmp/phone-bridge.service"
"${SSH[@]}" "
  mkdir -p ~/.config/systemd/user &&
  cp /tmp/phone-bridge.service ~/.config/systemd/user/ &&
  loginctl enable-linger $USER &&
  systemctl --user daemon-reload &&
  systemctl --user enable phone-bridge &&
  systemctl --user restart phone-bridge &&
  sleep 3 &&
  systemctl --user is-active phone-bridge"

if [ "${1:-}" = "--pair" ]; then
  echo "=== 配对(码只能用一次,5 分钟有效) ==="
  # 配对要先把服务停掉:两个进程同时写 device.json 会互相盖掉。
  "${SSH[@]}" "systemctl --user stop phone-bridge && cd $DIR && venv/bin/python popphone.py --pair '${2:?配对码呢}' ; systemctl --user start phone-bridge"
fi

echo
echo "=== 日志(最后 20 行) ==="
"${SSH[@]}" "tail -n 20 $DIR/popphone.log 2>/dev/null || echo '  还没有日志'"
echo
echo "内存占用(装了 livekit 之后最该盯的一个数;Mac arm64 上实测推着音轨时 60MB):"
# 服务用 venv/bin/python 起,进程名是 python 不是 python3(2026-09-22 真机:只查 python3 一行都不打)。
"${SSH[@]}" "ps -o rss=,comm= -C python,python3 2>/dev/null | awk '{printf \"  %.1f MB  %s\\n\", \$1/1024, \$2}' || true"

echo
echo "=== 配网服务(要 sudo,这个脚本不替你做) ==="
cat <<'TIP'
  上面自检里「蓝牙适配器 hci0」是「没有」的话,先补包(这两条也都要 sudo):
    sudo apt install -y bluez bluez-firmware-raspi python3-dbus python3-gi
    sudo systemctl enable --now bluetooth
  然后装配网服务:
    sudo cp ~/phone-bridge/wb-provision.service /etc/systemd/system/
    sudo systemctl daemon-reload && sudo systemctl enable --now wb-provision
    journalctl -u wb-provision -f        # 该看到:[boot] 座机配网服务:工作台座机-XXXX
  正常情况下这几步由 cloud-init 在首次开机时做掉了(user-data 那一份),这里只是补装。
TIP
