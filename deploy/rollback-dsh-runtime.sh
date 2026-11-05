#!/usr/bin/env bash
#
# 把 DSH 运行环境换回上一版(2026-09-25,卡 U1;升 0.1.7 的回滚路,评估第五节)。
#
#     bash deploy/rollback-dsh-runtime.sh            # 先看它打算做什么(不动手)
#     bash deploy/rollback-dsh-runtime.sh --yes      # 真换
#
# ## 它做什么
#
# 热更新换运行环境时是**换名、不删**:新的装进 `runtime-next`,核过版本之后
# `runtime` → `runtime-prev`、`runtime-next` → `runtime`。所以上一版原样躺在
# `~/.dsh/runtime-prev` 里 —— 回滚就是把这两个再换回来,一秒钟的事,不用联网重装。
#
# 顺序(与 setup/install.ts 的 swapRuntime 正好相反):
#   1. 停 DSH(launchctl bootout;没有 launchd 项就跳过)
#   2. `runtime` → `runtime-failed-<时刻>`(**留着**,不删 —— 要拿它去看为什么崩)
#   3. `runtime-prev` → `runtime`
#   4. profile 的 cordis.patch.yml:有 `.rollback-bak` 就换回去(可选,见 --with-profile)
#   5. 起 DSH(launchctl kickstart),打印日志尾巴
#
# ## 这个脚本一个文件都不删
#
# 每一步都是 `mv`。留下来的那几个目录(`runtime-failed-*`)要占几百兆,
# 确认新版本没问题之后由**人**去清 —— 自动删东西不是这个脚本该干的事
# (2026-09-04 家目录被删事故之后的规矩)。
#
# ## 会话文件回不去(**升级前一定要读这一段**)
#
# 0.1.7 打开一条老会话时会在同目录**另外发布**一份 `session.v4.jsonl.zstd`;
# 老文件(`session.jsonl.zstd`)逐字节不动,等于自带备份。但是:
#
#   - **0.1.2 读不了 v4 文件**(它会说"由更新的 harness 写出,请升级"),上游没有降级工具;
#   - 所以回滚之后,**升级期间新写进 v4 文件里的那些会话内容,旧版本看不见**。
#
# 这个脚本**不碰 `sessions/`** —— 要连会话一起回到升级前,得从升级前那份整目录备份恢复,
# 那是一次有损操作(会丢掉升级期间的新会话),只能由人决定。`--print-sessions-help`
# 打印那几步给人照做。
#
# ## 参数
#
#   --yes                 真动手(不给就只打印计划)
#   --dsh-home <路径>     缺省 ${DSH_HOME:-$HOME/.dsh}。**演练时指到 mktemp 出来的沙箱**。
#   --label <名字>        launchd 项的 Label,缺省 ai.deepseek.dsh
#   --with-profile        顺带把 profile 的 cordis.patch.yml 换回 .rollback-bak
#   --no-launchd          不碰 launchd(演练、或这台机器不是用 launchd 起的)
#   --print-sessions-help 打印"会话也要回到升级前"的步骤,然后退出

set -euo pipefail

DSH_HOME_ARG=""
LABEL="ai.deepseek.dsh"
DO=0
WITH_PROFILE=0
USE_LAUNCHD=1

while [ $# -gt 0 ]; do
  case "$1" in
    --yes) DO=1 ;;
    --dsh-home) shift; DSH_HOME_ARG="${1:-}" ;;
    --label) shift; LABEL="${1:-}" ;;
    --with-profile) WITH_PROFILE=1 ;;
    --no-launchd) USE_LAUNCHD=0 ;;
    --print-sessions-help) SESSIONS_HELP=1 ;;
    --help|-h) sed -n "2,$(($(awk '/^set -euo/{print NR; exit}' "${BASH_SOURCE[0]}") - 1))p" "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "不认识的参数:$1(--help 看能用的)" >&2; exit 1 ;;
  esac
  shift
done

say() { printf '\n▸ %s\n' "$1"; }
info() { printf '  %s\n' "$1"; }
die() { printf '\n×  %s\n' "$1" >&2; exit 1; }

DSH="${DSH_HOME_ARG:-${DSH_HOME:-$HOME/.dsh}}"
DSH="${DSH%/}"

if [ "${SESSIONS_HELP:-0}" = "1" ]; then
  cat <<EOF

会话也要回到升级前(有损,想清楚再做):

  0.1.7 打开老会话时会另发一份 session.v4.jsonl.zstd,老文件一个字节不动;
  但 0.1.2 读不了 v4,所以升级期间写进 v4 的内容回滚之后就看不见了。

  1. 先把**现在**这份再备一次(免得连升级期间那几条一起丢):
       cp -R "$DSH/sessions" ~/工作台重置备份-回滚前-\$(date +%m%d-%H%M)/sessions
  2. 从升级前那份整目录备份恢复:
       mv "$DSH/sessions" "$DSH/sessions-升级后-\$(date +%m%d-%H%M)"
       cp -R <升级前备份>/sessions "$DSH/sessions"
  3. 别动 session.lock;DSH 停着的时候做这几步。

EOF
  exit 0
fi

[ -d "$DSH" ] || die "$DSH 不存在。--dsh-home 指对了吗?"

RUNTIME="$DSH/runtime"
PREV="$DSH/runtime-prev"
STAMP="$(date +%Y%m%d-%H%M%S)"
FAILED="$DSH/runtime-failed-$STAMP"
PATCH="$DSH/profiles/web/cordis.patch.yml"
PATCH_BAK="$PATCH.rollback-bak"

say "要回滚的是"
info "DSH_HOME       $DSH"
[ -d "$RUNTIME" ] && info "现在这一份     $RUNTIME($(node -p "try{require('$RUNTIME/node_modules/@deepseek-ai/dsh/package.json').version}catch(e){'读不出版本'}" 2>/dev/null || echo '读不出版本'))"
[ -d "$RUNTIME" ] || info "现在这一份     $RUNTIME(不在)"
[ -d "$PREV" ] || die "$PREV 不在 —— 没有可换回去的上一版。
     这台机器多半还没走过「先装 runtime-next、核过版本再换名」那条路
     (0.1.7 之前的热更新压根没有「换运行环境」这一步)。
     这种情形只能重新装一遍旧版本:把仓库里的锁定清单改回旧那一份,再在登录台点「运行环境」。"
info "要换回去的     $PREV($(node -p "try{require('$PREV/node_modules/@deepseek-ai/dsh/package.json').version}catch(e){'读不出版本'}" 2>/dev/null || echo '读不出版本'))"

say "打算做这几步"
[ "$USE_LAUNCHD" = "1" ] && info "1. launchctl bootout gui/\$(id -u)/$LABEL(停 DSH)"
[ -d "$RUNTIME" ] && info "2. mv $RUNTIME → $FAILED(留着,不删)"
info "3. mv $PREV → $RUNTIME"
if [ "$WITH_PROFILE" = "1" ]; then
  if [ -f "$PATCH_BAK" ]; then info "4. mv $PATCH → $PATCH.failed-$STAMP;mv $PATCH_BAK → $PATCH"
  else info "4. (跳过)没有 $PATCH_BAK"; fi
fi
[ "$USE_LAUNCHD" = "1" ] && info "5. launchctl kickstart -k gui/\$(id -u)/$LABEL(起 DSH)"
info "会话文件一个字节不碰(--print-sessions-help 看为什么、以及要连会话一起回去该怎么做)"

if [ "$DO" != "1" ]; then
  printf '\n(只是看看。真要做,加 --yes)\n\n'
  exit 0
fi

if [ "$USE_LAUNCHD" = "1" ]; then
  say "停 DSH"
  launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || info "(它本来就没在跑)"
  sleep 1
fi

say "换回上一版"
if [ -d "$RUNTIME" ]; then
  mv "$RUNTIME" "$FAILED"
  info "现在这一份留在 $FAILED(确认新版没问题之后,由你自己删)"
fi
mv "$PREV" "$RUNTIME"
info "已换回:$PREV → $RUNTIME"
info "换回来的是 dsh $(node -p "try{require('$RUNTIME/node_modules/@deepseek-ai/dsh/package.json').version}catch(e){'读不出版本'}" 2>/dev/null || echo '读不出版本')"

if [ "$WITH_PROFILE" = "1" ] && [ -f "$PATCH_BAK" ]; then
  mv "$PATCH" "$PATCH.failed-$STAMP"
  mv "$PATCH_BAK" "$PATCH"
  info "profile 补丁层也换回去了(现在这份留在 $PATCH.failed-$STAMP)"
fi

if [ "$USE_LAUNCHD" = "1" ]; then
  say "起 DSH"
  launchctl kickstart -k "gui/$(id -u)/$LABEL"
  sleep 4
  LOG="$DSH/logs/web.stdout.log"
  if [ -f "$LOG" ]; then
    info "日志尾巴($LOG):"
    tail -5 "$LOG" | sed 's/^/    /'
  fi
  info "看到 `dsh web: http://127.0.0.1:3080/?token=…` 那一行就是起来了。"
fi

printf '\n✓  回滚完了。\n'
printf '   留在磁盘上没删的:%s\n' "$FAILED"
printf '   会话文件一个字节没碰;升级期间写进 v4 文件的内容旧版本看不见(--print-sessions-help)。\n\n'
