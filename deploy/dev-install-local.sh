#!/usr/bin/env bash
#
# 本机装新版(开发机自验用;统筹 2026-09-24,维护者授权「装机脚本」)。
# 把主 checkout 当前的代码装进这台 Mac 正在用的工作台,并把手机包装到 USB 连着的手机上。
# 用户机器走安装包与热更新(deploy/build-installer.sh、deploy/publish-update.sh),**不用这个**。
#
#     bash deploy/dev-install-local.sh worker    # 只换通话组件的源码(channel-worker/src),重启工人
#     bash deploy/dev-install-local.sh plugin    # 构建并装插件,重启 DSH(工人随之重启,也会换上新源码)
#     bash deploy/dev-install-local.sh apk       # 构建手机包并装到手机(覆盖安装,保留配对与登录)
#     bash deploy/dev-install-local.sh all       # 以上三样
#     bash deploy/dev-install-local.sh shell     # 构建壳(workbench-app)并换掉 /Applications/工作台.app,重新打开
#                                                #(维护者 09-24 晚「电脑里如果是安装了之前版本的工作台,你可以卸载再安装」)
#
# 纪律(每一条都是为了能原样退回去):
#   - 装之前把要被替换的旧版**复制**进 ~/工作台重置备份-<月日>-装机前/<时刻>/;**不删任何东西**(不 rm、不 --delete)。
#   - 只碰这几处:~/.dsh/channel-worker/src、~/.dsh/packages/ 里这一版的 tgz、~/.dsh/profiles/web(package.json 与依赖)、
#     launchd 里的 ai.deepseek.dsh(重启)、手机上的 ai.ben.butler(覆盖安装)、
#     /Applications/工作台.app(shell 那一档:旧壳整个**挪**进备份目录,不删;签名身份不变,辅助功能授权跟着走)。
#   - 不碰凭据、不碰 onboarding.json 与记忆文件夹、不改 launchd 的 plist 与 ~/.dsh/bin/dsh-start。
#   - 通话组件的依赖(package.json)变了就停:那要整包重装,不是换源码能解决的。
set -euo pipefail

REPO="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
DSH="$HOME/.dsh"
PORT="${WORKBENCH_PORT:-8791}"
STAMP="$(date +%H%M%S)"
BK="$HOME/工作台重置备份-$(date +%m%d)-装机前/$STAMP"
JAVA_HOME_DEFAULT="/opt/homebrew/opt/openjdk@21/libexec/openjdk.jdk/Contents/Home"

say() { printf '[装机] %s\n' "$*"; }
die() { printf '[装机] 停:%s\n' "$*" >&2; exit 1; }

what="${1:-}"
case "$what" in
  worker|plugin|apk|all|shell) ;;
  *) die "用法:bash deploy/dev-install-local.sh worker|plugin|apk|all|shell" ;;
esac

mkdir -p "$BK"
say "旧版复制到 $BK"

wait_8791() {
  local i
  for i in $(seq 1 90); do
    if curl -fsS -m 2 "http://127.0.0.1:$PORT/state" >/dev/null 2>&1; then say "8791 起来了(${i} 秒)"; return 0; fi
    sleep 1
  done
  die "等了 90 秒 8791 还没起来,看 ~/.dsh/logs/web.stderr.log"
}

install_worker_src() {
  local src="$REPO/channel-worker/src" dst="$DSH/channel-worker/src"
  [ -d "$dst" ] || die "没有 $dst(这台机器没装通话组件)"
  cmp -s "$REPO/channel-worker/package.json" "$DSH/channel-worker/package.json" \
    || die "channel-worker/package.json 与装着的不一样(依赖变了),要整包重装,换源码不行"
  cp -Rp "$dst" "$BK/channel-worker-src"
  cp -Rp "$src/." "$dst/"
  say "通话组件源码已换上($(diff -rq "$src" "$dst" >/dev/null && echo 与仓库一致 || echo '与仓库仍有差别,看 diff'))"
}

restart_worker() {
  curl -fsS -m 30 -X POST "http://127.0.0.1:$PORT/channel/stop" >/dev/null || say "停工人没回 200(可能本来就没在跑)"
  sleep 2
  curl -fsS -m 60 -X POST "http://127.0.0.1:$PORT/channel/start" >/dev/null || die "起工人失败,看 ~/.dsh/workbench/logs/channel-worker.log"
  say "工人已重启"
}

install_plugin() {
  local pkg="$REPO/workbench-plugin" profile="$DSH/profiles/web" ver tgz before force=""
  ver="$(node -p "require('$pkg/package.json').version")"
  tgz="$DSH/packages/ben-dsh-workbench-$ver.tgz"
  before="$(node -p "require('$profile/node_modules/@ben/dsh-workbench/package.json').version" 2>/dev/null || echo none)"
  # 同一个版本号重装时 pnpm 会拿缓存里的旧包糊弄(workbench-deploy-layout),只有这时才 --force;换了版本号照常装。
  [ "$before" = "$ver" ] && force="--force"
  say "构建插件 $ver"
  (cd "$pkg" && pnpm build >/dev/null)
  if [ -e "$tgz" ]; then cp -p "$tgz" "$BK/"; fi
  (cd "$pkg" && npm pack --pack-destination "$DSH/packages" >/dev/null)
  [ -e "$tgz" ] || die "没打出 $tgz"
  cp -p "$profile/package.json" "$BK/profiles-web-package.json"
  [ -e "$profile/pnpm-lock.yaml" ] && cp -p "$profile/pnpm-lock.yaml" "$BK/profiles-web-pnpm-lock.yaml"
  node -e '
    const fs = require("fs"); const [file, spec] = process.argv.slice(1);
    const pkg = JSON.parse(fs.readFileSync(file, "utf8"));
    if (!pkg.dependencies || !("@ben/dsh-workbench" in pkg.dependencies)) { console.error("profile 里没有 @ben/dsh-workbench"); process.exit(1); }
    pkg.dependencies["@ben/dsh-workbench"] = spec;
    fs.writeFileSync(file, JSON.stringify(pkg, null, 2) + "\n");
  ' "$profile/package.json" "file:$tgz"
  (cd "$profile" && pnpm install --prefer-offline $force >/dev/null)
  local installed
  installed="$(node -p "require('$profile/node_modules/@ben/dsh-workbench/package.json').version")"
  [ "$installed" = "$ver" ] || die "装进 profile 的是 $installed,不是 $ver"
  say "插件 $ver 已装进 profile,重启 DSH"
  launchctl kickstart -k "gui/$(id -u)/ai.deepseek.dsh"
  wait_8791
}

install_apk() {
  local app="$REPO/butler-app" apk
  apk="$app/android/app/build/outputs/apk/debug/app-debug.apk"
  say "构建手机包"
  (cd "$app" && pnpm build >/dev/null && npx cap sync android >/dev/null)
  (cd "$app/android" && JAVA_HOME="${JAVA_HOME:-$JAVA_HOME_DEFAULT}" ANDROID_HOME="${ANDROID_HOME:-$HOME/Library/Android/sdk}" ./gradlew assembleDebug -q)
  [ -e "$apk" ] || die "没打出 $apk"
  [ "$(adb get-state 2>/dev/null)" = "device" ] || die "手机没连上(adb get-state 不是 device)"
  local old
  # 没装过工作台的手机上 pm path 退出码非 0,pipefail 下会让整个脚本无声停掉(09-24 小米测试机撞到)。
  old="$( { adb shell pm path ai.ben.butler 2>/dev/null || true; } | tr -d '\r' | sed -n 's/^package://p' | head -1)"
  if [ -n "$old" ]; then adb pull "$old" "$BK/ai.ben.butler-装前.apk" >/dev/null && say "手机上原来那版已复制回来"; fi
  # Pixel 上 adb install 流式安装会无故失败(2026-09-22),改走 push + pm install。
  adb push "$apk" /data/local/tmp/wb.apk >/dev/null
  adb shell pm install -r -t /data/local/tmp/wb.apk
  say "手机包已装(覆盖安装,配对与登录保留)"
}

install_shell() {
  local src="$REPO/workbench-app/build/工作台.app" dst="/Applications/工作台.app" pid i
  say "构建壳"
  (cd "$REPO/workbench-app" && nice -n 5 ./build.sh >/dev/null)
  [ -d "$src" ] || die "没打出 $src"
  pid="$(pgrep -f "$dst/Contents/MacOS/workbench" || true)"
  if [ -n "$pid" ]; then
    kill -TERM $pid
    for i in $(seq 1 40); do kill -0 $pid 2>/dev/null || break; sleep 0.25; done
    kill -0 $pid 2>/dev/null && die "旧壳没退出(pid $pid),没换"
  fi
  if [ -d "$dst" ]; then mv "$dst" "$BK/工作台.app" && say "旧壳挪进 $BK/工作台.app"; fi
  ditto "$src" "$dst"
  open "$dst"
  say "壳已换上并重新打开"
}

case "$what" in
  shell) install_shell ;;
  worker) install_worker_src; restart_worker ;;
  plugin) install_worker_src; install_plugin ;;
  apk) install_apk ;;
  all) install_worker_src; install_plugin; install_apk ;;
esac
say "完成。退回旧版:把 $BK 里对应的文件复制回原处,再跑一次重启。"
