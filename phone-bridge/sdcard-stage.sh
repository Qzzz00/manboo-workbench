#!/usr/bin/env bash
#
# 把 phone-bridge 这一份代码铺到 **SD 卡的启动分区** 上,给「ssh 走不通」时用。
# **在 Mac 上跑,派不在场;卡已经插在 Mac 上、启动分区已经挂好。**
#
#   ./phone-bridge/sdcard-stage.sh /Volumes/bootfs
#
# ## 为什么要有它
#
# `deploy.sh` 走的是 ssh。2026-09-22 晚那一夜的形状是:派在访客网(`VR_GUEST`)上,
# Mac 在公司的企业网上 —— **两台不同网,ssh 根本到不了**;而且那一版卡里
# `sshd` 压根没在听(`ss -ltn` 里没有 `:22`),就算同网也进不去。
# 那时唯一的通路是**把卡拔下来插 Mac**:启动分区(FAT)在 macOS 上可读可写,
# 里面的 `pi-boot.txt` / `pi-status.txt` 本来就是这条路上的黑匣子。
#
# 于是这个脚本干的事很小:**把代码放到卡上**,再**打印一段 `runcmd`**,
# 由统筹把它追加进 `user-data` —— 派下一次开机时 cloud-init 自己把代码从
# `/boot/firmware/phone-bridge/` 铺到 `/home/ben/phone-bridge/`、装依赖、重启服务、
# 并且**把 ssh 打开**,免得下一次又只能拔卡。
#
# ## 它不做什么(故意的)
#
# - **不删任何东西**。卡上多出来的文件一律留着 —— 这张卡是现在唯一能开机的那张,
#   删错一个文件的代价是派再也起不来。同理:只 `cp`,不 `rsync --delete`。
# - **不碰 `meta-data` 与 `cmdline.txt`**。改 `user-data` 必须同时换那两处的 instance-id
#   (2026-09-22 查明:不换的话 cloud-init 认为还是同一台,**从不重新应用**),
#   但那两处由统筹用自己的工具改 —— 一个脚本同时改三份、其中两份还要生成 UUID,
#   出错时没人说得清是哪一份坏的。
# - **不改 `user-data`**。这个脚本只把该追加的那一段**打印出来**(顺带存一份到卡上),
#   追加由人做。理由同上:`user-data` 是派能不能开机的单点,不值得让脚本去改。
# - **不碰 `network-config`**(Wi-Fi 密码在那儿,这个脚本一个凭据都不读不写)。
#
# ## 幂等
#
# 跑几遍都一样:目标目录 `mkdir -p`,文件逐个覆盖,不留时间戳后缀、不生成第二份。
set -euo pipefail

BOOTFS="${1:?用法:sdcard-stage.sh <bootfs 挂载点>  例:/Volumes/bootfs}"
HERE="$(cd "$(dirname "$0")" && pwd)"
DEST="$BOOTFS/phone-bridge"
PI_USER="${PI_USER:-ben}"
PI_DIR="/home/$PI_USER/phone-bridge"
# 派上启动分区挂在这儿(Debian 的 raspi 镜像;`pi-status.txt` 就是写到这个路径的)。
PI_BOOT="${PI_BOOT:-/boot/firmware}"

# ——— 0. 这真的是一个启动分区吗 ———
# 只认一样东西:`config.txt`。认多了(比如 cmdline.txt)反而会在别人手里误报,
# 认少了(只看目录存在)就可能往某个随便的目录里倒一堆文件。
if [ ! -d "$BOOTFS" ]; then
  echo "✗ $BOOTFS 不是一个目录 —— 卡挂上了吗?(diskutil list / diskutil mount diskNs1)" >&2
  exit 1
fi
if [ ! -f "$BOOTFS/config.txt" ]; then
  echo "✗ $BOOTFS 里没有 config.txt —— 这不像树莓派的启动分区。没动任何东西。" >&2
  exit 1
fi

echo "=== 1/3 要铺哪些文件 ==="
# 派上跑得到的那几份,逐个点名。**不用通配符整目录拷** —— 那样 `dev/`、
# `*_test.py`、`__pycache__` 会一起上卡,而卡只有几百 MB 富余,
# 更要紧的是派上多一份测试代码只会让人分不清跑的是哪一份。
FILES=(
  popphone.py       # 守护进程本体
  phone_state.py    # 状态机(纯函数)
  signals.py        # 叉簧 / 按键那几条信号
  pairing.py        # 配对与领进房凭证
  audio.py          # 录放两根管子 + 两声确认音(没有铃)
  room_link.py      # LiveKit 房间那条路
  provision.py      # 配网:纯逻辑
  provisiond.py     # 配网:bluez / nmcli / 落盘(root 那一半)
  netcfg.py         # 换网:纯逻辑
  filler.py         # 派端缓冲语(2026-09-23,通话延迟那张卡)
  assets/filler.wav # 「我想想」48k/单声道/16 位(卡上铺成 filler.wav,派上装到 /var/lib/phone-bridge/)
  requirements.txt
  phone-bridge.service   # 用户级 unit
  wb-provision.service   # system 级 unit
  README.md
)
missing=0
for f in "${FILES[@]}"; do
  [ -f "$HERE/$f" ] || { echo "  ✗ 少了 $f"; missing=1; }
done
[ "$missing" = 0 ] || { echo "✗ 源目录不全,什么都没写。" >&2; exit 1; }
printf '  %s\n' "${FILES[@]}"

echo "=== 2/3 铺到 $DEST(只写不删) ==="
mkdir -p "$DEST"
for f in "${FILES[@]}"; do
  # 不用 `cp -p`:FAT 上没有属主也没有权限位,`-p` 只会在 macOS 上报一串没用的错。
  # 权限在派那边由 runcmd 的 chown/chmod 定。
  cp -f "$HERE/$f" "$DEST/$(basename "$f")"
done
echo "  写了 ${#FILES[@]} 个文件到 $DEST/"
if [ -d "$DEST/dev" ] || ls "$DEST"/*_test.py >/dev/null 2>&1; then
  echo "  ⚠️ 卡上还留着以前铺的 dev/ 或 *_test.py —— 这个脚本不删东西,要清自己动手。"
fi

# ——— 3. 那一段 runcmd ———
# 写成 here-doc 存一份到卡上(方便改卡的人直接打开抄),同时打印到屏幕上。
SNIPPET="$DEST/runcmd-snippet.yaml"
cat > "$SNIPPET" <<YAML
# ——————————————————————————————————————————————————————————————
# 追加到 user-data 的 runcmd: 末尾(**既有那几条一条都别动**)。
# 由 phone-bridge/sdcard-stage.sh 生成。
#
# ⚠️ 改完 user-data **必须同时换 meta-data 与 cmdline.txt 里的 instance-id**,
#    否则 cloud-init 认为还是同一台,这一段一次都不会跑
#    (2026-09-22 派一整天上不了网的病根)。这个脚本**不碰**那两处。
#
# 这几条的共同点:**没网也跑得完,失败也不阻塞后面的**(该 || true 的都 || true 了)。
# ——————————————————————————————————————————————————————————————

  # ——— 离线部署:把启动分区上那份 phone-bridge 铺进 $PI_USER 的家目录 ———
  - [ install, -d, -m, '0755', -o, $PI_USER, -g, $PI_USER, $PI_DIR ]
  - [ sh, -c, 'cp -f $PI_BOOT/phone-bridge/*.py $PI_BOOT/phone-bridge/*.service $PI_BOOT/phone-bridge/requirements.txt $PI_BOOT/phone-bridge/README.md $PI_DIR/ || true' ]
  - [ sh, -c, 'chmod 0644 $PI_DIR/*.py $PI_DIR/*.service $PI_DIR/requirements.txt || true' ]
  - [ sh, -c, 'install -D -m 0644 -o root -g root $PI_BOOT/phone-bridge/filler.wav /var/lib/phone-bridge/filler.wav || true' ]
  # ——— 派端本地开场句:**不装了,还要把装过的那一份删掉**(2026-09-23 下午)———
  # 维护者 14:20 真机:「音色和最开始听到的『吩咐』二字不一致。」
  # 那份 wav 是用旧音色合的死文件,跟不了音色;工人那句已经预合成、够快了。
  # 两边一起放 = 一通电话里两个嗓子。留下来只会在换完音色之后又冒出上一个人的声音,
  # 所以这里**主动删**:光是不装,上一次铺卡装进去的那一份还在,照放不误。
  # 要在某台机器上再开这个兜底:自己放一份 wav 进去并设 PB_GREETING_WAV=那个路径。
  - [ sh, -c, 'rm -f /var/lib/phone-bridge/greeting.wav || true' ]
  - [ sh, -c, 'chown -R $PI_USER:$PI_USER $PI_DIR || true' ]

  # 依赖**只在真有外网时装**。没网时 pip 会把 cloud-init 拖住好几分钟、
  # 后面这几条全起不来(avahi-daemon 那次踩过,见交接-0922-树莓派上线 六·五节第 6 条)。
  # 判据是能不能真连上 PyPI,不是「wlan0 有地址」—— 要在网页上点同意才放行的网两者不一样。
  # **用 -I(只要响应头)**:\`/simple/\` 那个索引页有 40 多 MB,在 Zero 2W 上真下一遍
  # 要好几分钟,而且 -m 8 会把它掐断、于是永远判成「没网」。2026-09-22 夜在 Mac 上跑出来的。
  - [ sh, -c, 'curl -fsSI -m 8 -o /dev/null https://pypi.org/simple/ && su - $PI_USER -c "cd $PI_DIR && python3 -m venv --system-site-packages venv && venv/bin/pip install --no-cache-dir -r requirements.txt" || echo "[stage] 这一遍没有外网(或 pip 失败),跳过依赖" ' ]

  # 配网服务(root 那一半:bluez / nmcli / 写 keyfile 都要 root)
  - [ sh, -c, 'install -m 0644 -o root -g root $PI_DIR/wb-provision.service /etc/systemd/system/wb-provision.service || true' ]
  - [ sh, -c, 'systemctl daemon-reload || true' ]
  - [ sh, -c, 'systemctl enable --now wb-provision || true' ]
  # **已经在跑的要重启一次**,新铺的 provisiond.py 才生效(enable --now 对在跑的服务什么都不做;
  # 2026-09-30「进不了房就一直开蓝牙」那一版就是靠这一条上去的)。
  - [ sh, -c, 'systemctl restart wb-provision || true' ]

  # 话筒守护进程(用户级)。linger 先开,不然 --user -M 连不上那个 user manager。
  - [ sh, -c, 'install -D -m 0644 -o $PI_USER -g $PI_USER $PI_DIR/phone-bridge.service /home/$PI_USER/.config/systemd/user/phone-bridge.service || true' ]
  - [ sh, -c, 'loginctl enable-linger $PI_USER || true' ]
  - [ sh, -c, 'systemctl --user -M $PI_USER@ daemon-reload && systemctl --user -M $PI_USER@ restart phone-bridge || true' ]

  # **ssh 一定要在听**。2026-09-22 晚进不去派,一半的原因就是 sshd 没在听:
  # 卡上有没有 \`ssh\` 这个空文件是 raspi 镜像的老开关,Debian 的 cloud-init 镜像不认它。
  - [ sh, -c, 'systemctl enable --now ssh || systemctl enable --now sshd || true' ]

  # 黑匣子:**拔卡插 Mac 就能看见这一遍到底做成了什么**。追加不覆盖(一行一次开机)。
  # 和看门狗那份 pi-status.txt 分开写:那份每 20 秒整个重写一遍,留不下开机那一刻的事。
  - [ sh, -c, '{ echo "--- \$(date -Is) cloud-init 这一遍 ---"; echo "sshd: \$(ss -ltn 2>/dev/null | grep :22 || echo 没有在听)"; echo "地址: \$(hostname -I 2>/dev/null)"; echo "wb-provision: \$(systemctl is-active wb-provision 2>&1)"; echo "phone-bridge: \$(systemctl --user -M $PI_USER@ is-active phone-bridge 2>&1)"; } >> $PI_BOOT/pi-deploy.txt 2>&1 || true' ]
YAML

echo "=== 3/3 要追加到 user-data 的那一段(也存了一份到 $SNIPPET) ==="
echo
cat "$SNIPPET"
echo
cat <<TIP
——— 接下来(人做,这个脚本不替你做)———
  1. 打开 $BOOTFS/user-data,把上面那一段**追加到 runcmd: 末尾**(既有的别动)。
  2. **换 instance-id**:$BOOTFS/meta-data 与 $BOOTFS/cmdline.txt 两处一起换新的
     —— 不换的话这一段一次都不会跑。
  3. 弹卡、插回派、上电。开机后拔卡插 Mac,读 $PI_BOOT/pi-deploy.txt
     (在卡上就是 $BOOTFS/pi-deploy.txt)看这一遍做成了什么;
     里头 sshd 那一行说「没有在听」就是 ssh 还是进不去。
TIP
