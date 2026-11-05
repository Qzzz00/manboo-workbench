#!/bin/zsh
#
# 编「安装工作台.app」。**照 workbench-app/build.sh 同一套做法**:swiftc 直接编、
# 手摆 .app 目录、ad-hoc 签名。没有 Xcode 工程文件,理由与壳那边一样 —— 这东西只有
# 五个源文件、只链 AppKit,一个工程文件的维护成本抵不上它带来的任何东西。
#
# 资源(payload / kernel / stage0.sh / node-source.env)**不是这个脚本收的**,
# 是 `deploy/build-installer.sh` 收好之后用 --resources 传进来的目录。
# 这么分是因为收资源要构建插件、构建壳、跑 pnpm —— 那是仓库级的事,不是"编一个 app"。
#
#   installer-app/build.sh [--resources <一个已经收好的 Resources 目录>]
#
# 不给 --resources 也能编(出来的 .app 能跑 --dry-run 看界面,但真装会说"安装包是坏的")。

set -euo pipefail
cd "$(dirname "$0")"

RESOURCES_SRC=""
while [ $# -gt 0 ]; do
  case "$1" in
    --resources) shift; RESOURCES_SRC="${1:-}" ;;
    *) echo "不认识的参数:$1" >&2; exit 1 ;;
  esac
  shift
done

APP="build/安装工作台.app"
rm -rf build
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"

# 最低系统(2026-09-27):不写 -target 时 swiftc 按本机系统(macOS 26)编,Info.plist 写着 14.0 也没用,
# 新 Air(macOS 15.7.3)上打开报「这个版本不能与此版本的 macOS 配合使用」。与 Info.plist 的 LSMinimumSystemVersion 同一个数。
MAC_TARGET="${MAC_TARGET:-arm64-apple-macos14.0}"

swiftc -O -target "$MAC_TARGET" Sources/main.swift Sources/AppDelegate.swift Sources/InstallerWindow.swift \
  Sources/Kernel.swift Sources/Screenshot.swift Sources/Grants.swift \
  -o "$APP/Contents/MacOS/installer" \
  -framework AppKit

cp Info.plist "$APP/Contents/"
# 版本号跟着插件走(build-installer.sh 传进来);单独编安装器时没有就保留 Info.plist 里那个。
if [ -n "${WORKBENCH_VERSION:-}" ]; then
  plutil -replace CFBundleShortVersionString -string "$WORKBENCH_VERSION" "$APP/Contents/Info.plist"
fi

# 图标:和壳**共用同一个 icns**(粒子黑洞,2026-09-23 起;没加角标)。
# 为什么不做一版带角标的:安装器是同一件东西的大门,不是另一件东西;而且它一辈子只被打开一次,
# 靠名字「安装工作台」就分得清。真要角标了再在 workbench-app/scripts/render-mac-icon.mjs 里加一档。
if [ -f ../workbench-app/AppIcon.icns ]; then
  cp ../workbench-app/AppIcon.icns "$APP/Contents/Resources/AppIcon.icns"
else
  echo "! 没有 ../workbench-app/AppIcon.icns —— 跑 node workbench-app/scripts/render-mac-icon.mjs 生成;这次先不带图标" >&2
fi

# 欢迎页横幅(粒子黑洞):installer-app/scripts/render-welcome-hero.mjs 画的,进 git。
if [ -f Resources/welcome-hero.png ]; then
  cp Resources/welcome-hero.png "$APP/Contents/Resources/welcome-hero.png"
else
  echo "! 没有 Resources/welcome-hero.png —— 跑 node installer-app/scripts/render-welcome-hero.mjs 生成;这次欢迎页不带横幅" >&2
fi

if [ -n "$RESOURCES_SRC" ]; then
  [ -d "$RESOURCES_SRC" ] || { echo "× --resources 给的不是一个目录:$RESOURCES_SRC" >&2; exit 1; }
  # ditto 而不是 cp -R:要保住 .app 里的符号链接与扩展属性(payload 里有一整个 工作台.app)。
  ditto "$RESOURCES_SRC" "$APP/Contents/Resources"
fi

# 签名。**和壳用同一条解析逻辑、同一张证书**(deploy/codesign-identity.sh --resolve),
# 理由见 workbench-app/build.sh 里那段:签名身份不变,辅助功能授权才不会跟着更新掉。
# --deep:Resources 里塞着一整个「工作台.app」,要连它一起签(同一张证书,所以
# 里外两个 App 的 designated requirement 都稳定)。
#
# 仍然**没有公证**:第一次打开会被拦下,要去 系统设置 → 隐私与安全性 → 拉到最底 →「仍要打开」(macOS 15 起右键 → 打开不管用了)。公证要 Apple Developer ID,
# 见 docs/交接-0918-壳稳定签名.md 第五节。签名稳定与公证是两件事,别混。
IDENTITY="$(bash ../deploy/codesign-identity.sh --resolve)"

codesign --force --deep --sign "$IDENTITY" "$APP"

if [[ "$IDENTITY" == "-" ]]; then
  echo "签名:ad-hoc(临时)—— 装出去的壳更新后要重新授权辅助功能"
else
  echo "签名:${WORKBENCH_CODESIGN_IDENTITY:-工作台本机签名}($IDENTITY)"
fi

codesign --verify --deep --strict "$APP"
codesign -d -r - "$APP" 2>/dev/null | grep 'designated' || true

echo "built: $APP"
