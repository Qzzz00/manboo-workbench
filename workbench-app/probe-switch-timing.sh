#!/bin/zsh
# 「点标签切换经常卡住」的实测工具(2026-09-21)。**诊断用,不发版、不装进 /Applications。**
#
# 干的事:把 Sources/SwitchBudget.swift + Tools/switch-timing.swift 编成一个**临时 app 包**
# (mktemp 目录里),用**同一份 Info.plist**(bundle id 还是 ai.ben.workbench)和
# deploy/codesign-identity.sh 那张自签证书签名 —— 辅助功能授权(TCC)认的是签名里那条
# designated requirement,所以系统认得这还是工作台,不用重点授权。
#
# **刻意只编这两个文件**(沿用 probe-send-text.sh 的做法):没有 AppDelegate、没有窗口、
# 不注册登录项、退出时不写 app.json、不连 8791 的 /helper,也不碰 /Applications/工作台.app。
#
# 改前 / 改后在**同一份二进制**里跑:--timeout off = 改动之前(AX 无时限),
# --timeout on = 改动之后(每个元素 1 秒)。同一台机器、同一批进程、同一秒的负载才可比。
#
# 跑法:
#   ./probe-switch-timing.sh com.anthropic.claudefordesktop --rounds 10 --timeout off
#   ./probe-switch-timing.sh com.anthropic.claudefordesktop --rounds 10 --timeout on
set -euo pipefail
cd "$(dirname "$0")"

# 编一次可以跑很多次:PROBE_APP 指着已经编好的那份包就跳过编译与签名。
if [[ -n "${PROBE_APP:-}" && -x "${PROBE_APP}/Contents/MacOS/workbench" ]]; then
  BUILD="$PROBE_APP"
else
BUILD="${PROBE_APP:-$(mktemp -d)/工作台.app}"
mkdir -p "$BUILD/Contents/MacOS"
cp Info.plist "$BUILD/Contents/"

swiftc -O Sources/SwitchBudget.swift Tools/switch-timing.swift \
  -o "$BUILD/Contents/MacOS/workbench" \
  -framework AppKit -framework ApplicationServices

IDENTITY="$(bash ../deploy/codesign-identity.sh --resolve)"
if [[ "$IDENTITY" == "-" ]]; then
  echo "! 没有自签证书(ad-hoc)—— 这份二进制拿不到辅助功能授权,测出来的一定是一张假表。先跑 deploy/codesign-identity.sh。" >&2
  exit 1
fi
codesign --force --sign "$IDENTITY" "$BUILD" >/dev/null 2>&1
codesign -d -r - "$BUILD" 2>/dev/null | grep 'designated' >&2 || true
echo "built: $BUILD" >&2
fi

# 授权按「负责进程」算:从终端直接 exec 这个二进制,系统把授权算在终端头上
# (实测 AXIsProcessTrusted()=false,哪怕 designated requirement 一字不差)。
# 必须让 LaunchServices 拉起它(-n 强制新实例,别去激活 /Applications 里那份正在跑的壳)。
OUT="$(mktemp -t probe-switch-timing).json"
open -n -a "$BUILD" --args "$@" --out "$OUT"
for _ in $(seq 1 200); do
  [ -s "$OUT" ] && break
  sleep 0.2
done
cat "$OUT"
