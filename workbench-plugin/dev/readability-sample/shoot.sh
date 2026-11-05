#!/bin/sh
# 样张截图。先在 workbench-plugin 下起两份样张页(各开一个终端):
#   node node_modules/.pnpm/vite@8.2.1_@types+node@22.20.1/node_modules/vite/bin/vite.js --config dev/readability-sample/vite.config.mjs
#   PORT=4197 FIG_REF=<数字格换画法 A 版的提交> node node_modules/.pnpm/vite@8.2.1_@types+node@22.20.1/node_modules/vite/bin/vite.js --config dev/readability-sample/vite.config.mjs
# 再跑:sh dev/readability-sample/shoot.sh <输出目录>
# 先各截一张(整版 1512×945 / 格子全貌),再用 compare.html 把几张拼成并排对照,出:
#   现在-A-light/dark.png、现在-B-light/dark.png(整版)
#   格子-现在-A-light/dark.png(余额 / 额度、消耗数据两格不限高:现在 / A / A 点开计数)
# 本机 Chrome 无头模式、两倍像素、强制「少动」,独立临时配置目录,不碰日常 Chrome。
# (无头截图截不到 iframe 里的内容,所以拼的是图片不是活页面。)
set -eu
out="${1:?输出目录}"
chrome="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
profile="$(mktemp -d)"
parts="$(mktemp -d)"
mkdir -p "$out"
shot() { # 宽 高 输出 地址
  "$chrome" --headless=new --disable-gpu --hide-scrollbars --no-first-run --no-default-browser-check \
    --disable-default-apps --disable-component-update --disable-sync \
    --user-data-dir="$profile" --force-device-scale-factor=2 --window-size="$1,$2" \
    --force-prefers-reduced-motion --virtual-time-budget=6000 \
    --screenshot="$3" "$4" 2>/dev/null
}
q() { python3 -c 'import sys,urllib.parse;print(urllib.parse.quote(sys.argv[1]))' "$1"; }
NOW_T="$(q '现在')"; NOW_S="$(q '线上 0.4.140(main@38c3c746)')"
A_S="$(q '字号四档(15 / 13 / 11 / 大数字 28)· 间距 4 / 8 / 12 / 16 · 可删的提示收起、拿不到数的行收成一行计数;数字格用「数字格换画法」A 版')"
B_S="$(q '同 A,只有数字格的数字照「数字格换画法」A 版不动(总吞吐 57、余额 28.5、会话数 24…)')"
OPEN_T="$(q 'A · 点开计数')"; OPEN_S="$(q '每家「上次几时」还在')"
CELL_A_S="$(q '读不到的四家排到最底、收成一行;没有用量记录的同样一行')"

for theme in light dark; do
  shot 1512 945 "$parts/now-$theme.png" "http://127.0.0.1:4198/?ben-workbench=app&theme=$theme"
  shot 780 1160 "$parts/cells-now-$theme.png" "http://127.0.0.1:4198/cells.html?theme=$theme"
  for v in a b; do
    shot 1512 945 "$parts/$v-$theme.png" "http://127.0.0.1:4197/?ben-workbench=app&v=$v&theme=$theme"
  done
  shot 780 1160 "$parts/cells-a-$theme.png" "http://127.0.0.1:4197/cells.html?v=a&theme=$theme"
  shot 780 1160 "$parts/cells-open-$theme.png" "http://127.0.0.1:4197/cells.html?v=a&open=1&theme=$theme"

  shot 3080 1010 "$out/现在-A-$theme.png" \
    "http://127.0.0.1:4198/compare.html?theme=$theme&i=/@fs$parts/now-$theme.png&t=$NOW_T&s=$NOW_S&i=/@fs$parts/a-$theme.png&t=A&s=$A_S"
  shot 3080 1010 "$out/现在-B-$theme.png" \
    "http://127.0.0.1:4198/compare.html?theme=$theme&i=/@fs$parts/now-$theme.png&t=$NOW_T&s=$NOW_S&i=/@fs$parts/b-$theme.png&t=B&s=$B_S"
  shot 2420 1230 "$out/格子-现在-A-$theme.png" \
    "http://127.0.0.1:4198/compare.html?theme=$theme&i=/@fs$parts/cells-now-$theme.png&t=$NOW_T&s=$NOW_S&i=/@fs$parts/cells-a-$theme.png&t=A&s=$CELL_A_S&i=/@fs$parts/cells-open-$theme.png&t=$OPEN_T&s=$OPEN_S"
done
rm -rf "$profile" "$parts"
ls -la "$out"
