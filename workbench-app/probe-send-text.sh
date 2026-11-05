#!/bin/zsh
# 「送话进客户端窗口」的实测工具(2026-09-21)。**诊断用,不发版、不装进 /Applications。**
#
# 干的事:把 Sources/SendTextPolicy.swift + Sources/TextInsert.swift + Tools/main.swift
# 编成一个**临时 app 包**(mktemp 目录里),用**同一份 Info.plist**(bundle id 还是
# ai.ben.workbench)和 deploy/codesign-identity.sh 那张自签证书签名 —— 辅助功能授权(TCC)
# 认的是签名里那条 designated requirement,所以系统认得这还是工作台,不用重点授权。
#
# **刻意不带 AppDelegate**:没有窗口、不注册登录项、退出时不写 app.json、不连 8791 的 /helper。
# (2026-09-21「壳自动重开」那张卡记过:随手起一份完整的临时壳会把 Ben 的桌面搅一遍。)
#
# 跑法:
#   ./probe-send-text.sh list
#   ./probe-send-text.sh find com.anthropic.claudefordesktop
#   ./probe-send-text.sh send com.apple.TextEdit "一句话" --submit
#   ./probe-send-text.sh apps | agent <bundle_id> | agent-read <bundle_id>   (卡 Q:Agent 自动发现的三个只读原语)
#   ./probe-send-text.sh icon-color <bundle_id> ...                       (卡 Q:各家图标的主色,不要授权)
#   ./probe-send-text.sh app-icon <bundle_id> ... [--save <目录>]         (卡 LG:整张图标渲成 PNG,不要授权)
#   ./probe-send-text.sh agent-images <bundle_id> | images <bundle_id>      (卡 T:窗里图片类节点的位置 / AXURL / 说明,只读;前者与壳 op 同一份)
set -euo pipefail
cd "$(dirname "$0")"

# 编一次可以跑很多次:PROBE_APP 指着已经编好的那份包就跳过编译与签名
# (实测表要一家跑五次,每次重编一遍纯属浪费)。
if [[ -n "${PROBE_APP:-}" && -x "${PROBE_APP}/Contents/MacOS/workbench" ]]; then
  BUILD="$PROBE_APP"
else
BUILD="${PROBE_APP:-$(mktemp -d)/工作台.app}"
mkdir -p "$BUILD/Contents/MacOS"
cp Info.plist "$BUILD/Contents/"

swiftc -O Sources/SendTextPolicy.swift Sources/ReadLanes.swift Sources/TextInsert.swift Sources/AgentWindowPolicy.swift Sources/AgentWindow.swift Sources/IconColor.swift Sources/AppIconPolicy.swift Sources/AXWake.swift Tools/ProbeImages.swift Tools/main.swift \
  -o "$BUILD/Contents/MacOS/workbench" \
  -framework AppKit -framework ApplicationServices -framework Carbon

IDENTITY="$(bash ../deploy/codesign-identity.sh --resolve)"
if [[ "$IDENTITY" == "-" ]]; then
  echo "! 没有自签证书(ad-hoc)—— 这份二进制拿不到辅助功能授权,测出来的一定是一张假表。先跑 deploy/codesign-identity.sh。" >&2
  exit 1
fi
codesign --force --sign "$IDENTITY" "$BUILD" >/dev/null 2>&1
# TCC 认的就是这一行,与 /Applications/工作台.app 那份一字不差才算数。
codesign -d -r - "$BUILD" 2>/dev/null | grep 'designated' >&2 || true
echo "built: $BUILD" >&2
fi

# 授权是按「负责进程」算的:从终端直接 exec 这个二进制,系统把授权算在终端头上
# (实测 AXIsProcessTrusted()=false,哪怕 designated requirement 一字不差)。
# 必须让 LaunchServices 拉起它(-n 强制新实例,别去激活 /Applications 里那份正在跑的壳),
# 它才是自己的负责进程。标准输出那时没人接,所以结果落 --out 那个文件再读回来。
OUT="$(mktemp -t probe-send-text).json"
open -n -a "$BUILD" --args "$@" --out "$OUT"
for _ in $(seq 1 100); do
  [ -s "$OUT" ] && break
  sleep 0.2
done
cat "$OUT"
