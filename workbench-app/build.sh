#!/bin/zsh
set -euo pipefail
cd "$(dirname "$0")"
APP="build/工作台.app"
rm -rf build
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"

# 最低系统(2026-09-27):不写 -target 时 swiftc 按本机系统(macOS 26)编,Info.plist 写着 14.0 也没用,
# 新 Air(macOS 15.7.3)上打开报「这个版本不能与此版本的 macOS 配合使用」。与 Info.plist 的 LSMinimumSystemVersion 同一个数。
MAC_TARGET="${MAC_TARGET:-arm64-apple-macos14.0}"

swiftc -O -target "$MAC_TARGET" Sources/main.swift Sources/AppDelegate.swift Sources/Config.swift Sources/WindowPlacement.swift \
  Sources/WindowMode.swift Sources/DragSense.swift Sources/ShellRelaunch.swift Sources/SendTextPolicy.swift Sources/SwitchBudget.swift Sources/TextInsert.swift Sources/WindowControl.swift Sources/HelperSocket.swift Sources/HighlightWindow.swift Sources/WebToken.swift Sources/LoadingCover.swift Sources/ShellReadiness.swift Sources/LoadingCoverView.swift Sources/TitleBar.swift Sources/WebPolicy.swift Sources/WebHost.swift Sources/ActivationSense.swift Sources/ActivationWatch.swift Sources/NotifyPolicy.swift Sources/ShellNotifier.swift \
  Sources/AgentWindowPolicy.swift Sources/AgentWindow.swift Sources/IconColor.swift Sources/AppIconPolicy.swift Sources/AXWake.swift \
  Sources/DisplayAwakePolicy.swift Sources/DisplayAwake.swift Sources/SystemAwakePolicy.swift Sources/SystemAwake.swift Sources/GrantMode.swift Sources/GrantRun.swift Sources/AppOpenLog.swift \
  Sources/ScreenLockPolicy.swift Sources/ScreenLock.swift Sources/ReadLanes.swift \
  -o "$APP/Contents/MacOS/workbench" \
  -framework AppKit -framework WebKit -framework ApplicationServices -framework ServiceManagement -framework Carbon -framework UserNotifications -framework IOKit

cp Info.plist "$APP/Contents/"

# 图标:粒子黑洞(2026-09-23 起),和手机 APP、安装器同一个(见 scripts/render-mac-icon.mjs)。
# icns 是**提交进 git 的产物**,构建时只 cp —— 构建不依赖 node,换图标才重跑那个脚本。
# 图标缺了不挡构建(没图标只是难看,不是坏)。
if [ -f AppIcon.icns ]; then
  cp AppIcon.icns "$APP/Contents/Resources/AppIcon.icns"
else
  echo "! 没有 AppIcon.icns —— 跑 node scripts/render-mac-icon.mjs 生成;这次先不带图标" >&2
fi

# ───────────────────────── 签名 ─────────────────────────
#
# macOS 的 TCC(「系统设置 → 隐私与安全性 → 辅助功能」那张表)记的**不是路径,是签名**
# —— 准确说是签名里那条 designated requirement。所以签名身份只要不变,重构建多少次
# 系统都认得这还是同一个 App,**辅助功能授权跨更新保留**。
#
# 身份从哪来:`deploy/codesign-identity.sh --resolve`。它按这个顺序给答案 ——
#   1. $WORKBENCH_CODESIGN_IDENTITY 明着指定的(以后有了 Developer ID 就设它);
#   2. 登录钥匙串里那张「工作台本机签名」自签证书(跑一次 codesign-identity.sh 就有);
#   3. 都没有 → 回 "-"(ad-hoc),并且它自己会打一段大字警告说清代价。
IDENTITY="$(bash ../deploy/codesign-identity.sh --resolve)"

codesign --force --sign "$IDENTITY" "$APP"

if [[ "$IDENTITY" == "-" ]]; then
  echo "签名:ad-hoc(临时)—— 装上去之后辅助功能授权要重新点一次"
else
  echo "签名:${WORKBENCH_CODESIGN_IDENTITY:-工作台本机签名}($IDENTITY)"
fi

# 验一遍,并把 designated requirement 打出来。**这一行就是 TCC 认的那条线**:
# 两次构建打出来一模一样 ⇒ 授权不会掉;不一样(ad-hoc 那种 `cdhash H"…"`)⇒ 一定会掉。
codesign --verify --deep --strict "$APP"
codesign -d -r - "$APP" 2>/dev/null | grep 'designated' || true

echo "built: $APP"
