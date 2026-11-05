#!/bin/zsh
# 壳网页能力的**真 WebKit 引擎**测试(2026-09-25,卡 fix/shell-web-capabilities)。
#
# run-tests.sh 只测纯判断;这里起一个真 WKWebView,装上壳自己的 WebHost(与 AppDelegate 同一份代码),
# 对着 Tests/web/index.html 真点 + 选文件、真往输入框上拖文件、真下载,读网页那一侧实际拿到了什么;
# 还原样复现了维护者看到的「不支持」(DSH 压在下面的对话栏在 document 上截走文件拖放),
# 再装上插件那道守卫(workbench-plugin/src/client/fileDropGuard.ts 去掉类型,测的就是它本身)。
#
# **不碰任何真东西**:
# - 只编 WebPolicy / WebHost / 盖板这几个文件 + Tests/web/main.swift,没有 AppDelegate:
#   不注册登录项、不写 ~/.dsh/workbench/app.json、不连 8791 的 /helper;
# - 裸可执行文件(不是 工作台.app、没有 bundle id),不撞正在跑的壳;窗口摆在屏幕外、不激活;
# - 「真弹框 / 真打开浏览器 / 真的下载文件夹」都换成假的;拖放用私有命名的粘贴板,不动系统剪贴板;
# - 页面由一个只绑 127.0.0.1、端口由系统挑的临时静态服务发(Tests/web/server.py),跑完按 PID 杀掉;
# - 所有测试文件与「下载」都在 mktemp 目录里(不删它:系统会清 $TMPDIR,这里不写任何 rm -rf)。
#
# 要在有图形会话的 Mac 上跑(WKWebView 要连 WindowServer);不需要任何授权。
# 跑法:cd workbench-app && nice -n 15 ./run-web-tests.sh
set -euo pipefail
cd "$(dirname "$0")"

WORK="$(mktemp -d -t wb-web-tests)"
SERVER_PID=""
cleanup() {
  if [[ -n "$SERVER_PID" ]]; then kill "$SERVER_PID" 2>/dev/null || true; fi
}
trap cleanup EXIT

mkdir -p "$WORK/site" "$WORK/files/folder/sub" "$WORK/downloads"
cp Tests/web/index.html Tests/web/second.html "$WORK/site/"

# 插件那道「文件拖放归工作台」:从 TS 源去掉类型,原样当 ES module 发给测试页。
GUARD_TS="../workbench-plugin/src/client/fileDropGuard.ts"
GUARD_FLAG=()
if command -v node >/dev/null 2>&1 && node -e "process.exit(typeof require('node:module').stripTypeScriptTypes === 'function' ? 0 : 1)" 2>/dev/null; then
  node --no-warnings -e "const fs=require('fs');process.stdout.write(require('node:module').stripTypeScriptTypes(fs.readFileSync(process.argv[1],'utf8')))" "$GUARD_TS" > "$WORK/site/guard.js"
else
  echo "! 没有带 stripTypeScriptTypes 的 node(要 22.13+):跳过插件守卫那几条" >&2
  echo "export function installFileDropGuard() { return () => {} }" > "$WORK/site/guard.js"
  GUARD_FLAG=(--no-guard)
fi

# 测试文件:文本、中文名的图片、JSON、带子目录的文件夹。
printf 'hello from a.txt' > "$WORK/files/a.txt"
printf '{"v":4}' > "$WORK/files/preset.json"
printf 'x' > "$WORK/files/folder/x.txt"
printf 'y' > "$WORK/files/folder/sub/y.txt"
echo 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==' | base64 -D > "$WORK/files/图片.png"

python3 Tests/web/server.py "$WORK/site" "$WORK/port" &
SERVER_PID=$!
for _ in $(seq 1 50); do
  [[ -s "$WORK/port" ]] && break
  sleep 0.1
done
[[ -s "$WORK/port" ]] || { echo "临时静态服务没起来" >&2; exit 1; }
PORT="$(cat "$WORK/port")"

swiftc -O Sources/WebPolicy.swift Sources/WebHost.swift Sources/AppOpenLog.swift Sources/LoadingCover.swift Sources/ShellReadiness.swift Sources/LoadingCoverView.swift \
  Tests/web/main.swift -o "$WORK/web-harness" -framework AppKit -framework WebKit

"$WORK/web-harness" --base "http://127.0.0.1:$PORT/" --files "$WORK/files" --downloads "$WORK/downloads" "${GUARD_FLAG[@]}"
