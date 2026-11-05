#!/usr/bin/env bash
#
# 发版前的本机闸:把这一版的插件装到**这台机器**上,起来了才算过(2026-10-03)。
#
#     bash deploy/local-install-gate.sh --tgz dist/updates/0.4.89/plugin.tgz --version 0.4.89
#
# **为什么现在有这一道**:0.4.87 先推公网再升本机,崩了才知道。
#
# `deploy/publish-update.sh` 在 rsync 之前调它,非 0 退出就一个字节都不推。八下:
#
#   0. **网页端能加载**(2026-10-22):包里的 `lib/client.js` 放进一个没有 process 的 jsdom 页面里执行,
#      主界面那一格要注册上(`workbench-plugin/scripts/client-load-check.ts`)。**装之前就验**:加载不了的包
#      不该先把这台机器上的界面弄坏。0.4.143 第一次打包就是服务起来了、`/state` 200,页面里一片空白。
#   1. 把这台机器上现装的 `~/.dsh/packages/plugin.tgz` 备份到 `~/.dsh/工作台回退备份-<时刻>/`
#   2. 装:`cp` 到 `packages/plugin.tgz` → 自带 node 跑 `dsh plugin --profile web add` → `launchctl kickstart -k`
#      (**与维护者 10-03 手工装那三步同一条**,也与热更新 `setup/install.ts` 的 plugin 那一步同一条)
#   3. 等 `/update/check` 的 `current` 变成要发的那个版本号(最多 90 秒)
#   4. 再等 10 秒读一次 `/state`,必须 200(真机崩的是起来后那一拍)
#   4½. **再盯 2 分钟**(2026-10-22):每 5 秒读一次 `/state` 记用时,前后各读一次 8791 那个进程用掉的 CPU 时间。
#      平均 CPU 超过 50%、`/state` 有一次不是 200、或者慢过 3 秒的不止一次,判不过。
#      0.4.143 修好之前装上后 45 秒就 101% CPU、`/state` 15 秒超时,而第 4 下那一拍照样是 200。
#   5. **本机房间**(2026-10-21,局域网主路卡 M1):`http://127.0.0.1:7880` 要回 200(口按 `~/.dsh/livekit/livekit.yaml`;
#      只看不装 —— 它由 launchd 那一项看着,不随插件重启)。这台机器上还没装本机通话服务就如实跳过并说一句
#      (第一次带上它的那一版,是发完之后「本机也走一遍更新路」那一趟装上的);演练时 `--skip-livekit "<理由>"`
#   6. 过了之后**记一行账**:`~/.dsh/updates/installed.json` 里 `plugin_tgz` 那一行(见下)
#
# 第 0 下不过当场停(还没装,不用回退);第 1–4½ 下哪一下不过就**打印回退命令**然后非 0 退出;第 5 下不过只说本机房间怎么查(插件已经装上、起来了,不用回退)。**不自动回退**:那是在一台已经崩着的机器上
# 再动一次手,该由人看着。这个脚本一个文件都不删(0904 家目录事故之后的规矩)。
#
# ## 为什么装完要记一行账(2026-10-03,审计 B 条)
#
# `~/.dsh/updates/installed.json` 是客户端判「这一样要不要下」的那张备忘(`update/installed.ts`)。
# 闸是条 shell,装完不记的话那一行就一直记着上一版 —— 于是发完版那一遍 `/update/apply`
# 会把**同一份插件再装一遍、再重启一次**(10-03 本机那份还记着 0.4.87)。
# 所以第 4 下过了之后顺手把 `plugin_tgz` 那一行记上(sha256 + 版本 + 时刻),
# **只改这一行**,别的行原样留着;写不进去只打印一句,不算闸没过 —— 它是一张备忘,不是状态机。
#
# ## 只管插件
#
# 崩的就是它,而它也是唯一能在这台机器上装完就当场验的一样。**壳 / 事务官后端 / 电话工人 /
# 手机包不在这道闸里**:壳换一次要对签名身份、要重新授权辅助功能;手机包要一台安卓机;
# 后端与工人是另外两个进程,各自的验收路不在发版这一趟里。
#
# ## 参数
#
#   --tgz <文件>       必填。要装的插件包(发版脚本给的是它刚打出来的那一份)。
#   --version <版本号> 必填。`/update/check` 的 `current` 必须变成它。
#   --dsh-home <路径>  缺省 ${DSH_HOME:-$HOME/.dsh}。**演练时指到 mktemp 出来的沙箱**。
#   --base <地址>      工作台在哪。缺省 http://127.0.0.1:${WORKBENCH_PORT:-8791}
#   --label <名字>     launchd 项的 Label。缺省从 ~/Library/LaunchAgents 里装着的那份 plist 读。
#   --launchctl <命令> 缺省 launchctl。**演练时指到一个只记一行的假脚本** —— 真那一下会把
#                      这台机器上跑着的工作台重启。
#   --wait <秒>        等它起来最多多久。缺省 90。
#   --settle <秒>      起来之后再等多久读 /state。缺省 10。
#   --poll <秒>        每隔多久问一次。缺省 2。
#   --watch <秒>       第 4½ 下盯多久。缺省 120;0 = 不盯(只给用例用)。
#   --watch-poll <秒>  盯的时候多久读一次 /state。缺省 5。
#   --max-cpu <百分比> 盯的那段时间里平均 CPU 的上限。缺省 50(一个核的 50%)。
#   --max-state-ms <毫秒>  一次 /state 多慢算慢。缺省 3000;慢的超过一次就不过(一次毛刺放过)。
#   --no-web-check     不做第 0 下(只给用例用:它们的包是假的,解不出 client.js)。
#   --web-check        做第 0 下(缺省就做;写在 --no-web-check 后面时把它盖回来)。
#   --livekit <地址>   本机房间的信令口。缺省按 `~/.dsh/livekit/livekit.yaml` 里那一行 `port:`(读不到就 7880)。
#   --livekit-wait <秒> 等本机房间回 200 最多多久。缺省 20(它刚被 kickstart 过的话要一两秒)。
#   --skip-livekit <理由>  第 5 下跳过(**理由必填**,原样打出来)。沙箱演练、或者这一趟就是要修本机房间时用。

set -euo pipefail

TGZ=""
VERSION=""
DSH_HOME_ARG=""
BASE="http://127.0.0.1:${WORKBENCH_PORT:-8791}"
LABEL=""
LAUNCHCTL="launchctl"
WAIT=90
SETTLE=10
POLL=2
WATCH=120
WATCH_POLL=5
MAX_CPU=50
# 4¾ 回归门(2026-10-28):回归集报告与线。线没给就只公示不挡。
INTENT_REPORT=""
INTENT_MIN=""
MAX_STATE_MS=3000
WEB_CHECK=1
REPO_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
LIVEKIT_URL=""
LIVEKIT_WAIT=20
SKIP_LIVEKIT_WHY=""

while [ $# -gt 0 ]; do
  case "$1" in
    --tgz) shift; TGZ="${1:-}" ;;
    --version) shift; VERSION="${1:-}" ;;
    --dsh-home) shift; DSH_HOME_ARG="${1:-}" ;;
    --base) shift; BASE="${1:-}" ;;
    --label) shift; LABEL="${1:-}" ;;
    --launchctl) shift; LAUNCHCTL="${1:-}" ;;
    --wait) shift; WAIT="${1:-}" ;;
    --settle) shift; SETTLE="${1:-}" ;;
    --poll) shift; POLL="${1:-}" ;;
    --watch) shift; WATCH="${1:-}" ;;
    --watch-poll) shift; WATCH_POLL="${1:-}" ;;
    --max-cpu) shift; MAX_CPU="${1:-}" ;;
    --intent-report) shift; INTENT_REPORT="${1:-}" ;;
    --intent-min)
      shift; INTENT_MIN="${1:-}"
      case "$INTENT_MIN" in
        ''|*[!0-9]*) echo "--intent-min 要跟 0–100 的整数(回归集通过率的线,百分比)。" >&2; exit 1 ;;
      esac
      [ "$INTENT_MIN" -le 100 ] || { echo "--intent-min 要在 0–100 之间(给的是 $INTENT_MIN)。" >&2; exit 1; } ;;
    --max-state-ms) shift; MAX_STATE_MS="${1:-}" ;;
    --no-web-check) WEB_CHECK=0 ;;
    --web-check) WEB_CHECK=1 ;;
    --livekit) shift; LIVEKIT_URL="${1:-}" ;;
    --livekit-wait) shift; LIVEKIT_WAIT="${1:-}" ;;
    --skip-livekit)
      shift; SKIP_LIVEKIT_WHY="${1:-}"
      case "$SKIP_LIVEKIT_WHY" in
        ''|-*) echo "--skip-livekit 要跟一句**理由**(为什么这一趟不验本机房间)。" >&2; exit 1 ;;
      esac ;;
    --help|-h) sed -n "2,$(($(awk '/^set -euo/{print NR; exit}' "${BASH_SOURCE[0]}") - 1))p" "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "不认识的参数:$1(--help 看能用的)" >&2; exit 1 ;;
  esac
  shift
done

say() { printf '\n▸ %s\n' "$1"; }
info() { printf '  %s\n' "$1"; }
die() { printf '\n×  %s\n' "$1" >&2; exit 1; }

BASE="${BASE%/}"
DSH="${DSH_HOME_ARG:-${DSH_HOME:-$HOME/.dsh}}"
DSH="${DSH%/}"
NODE="$DSH/node/bin/node"
DSH_CLI="$DSH/runtime/node_modules/@deepseek-ai/dsh/lib/bin.js"
PKG="$DSH/packages/plugin.tgz"
# 客户端那张「这台机器上装着的是哪一份」的备忘(update/installed.ts;路径与 paths.ts 的
# installedJson 同一条,有用例按源头比着)。
INSTALLED_JSON="$DSH/updates/installed.json"
# 备份目录带时刻:同一天发两版也各留一份。
BK="$DSH/工作台回退备份-$(date +%Y%m%d-%H%M)"

SKIP_HINT="不在装着工作台的那台机器上发版,就用 publish-update.sh 的 --skip-local-check \"<理由>\"
     —— 那一版会在清单里带一格 local_check_skipped,公网上看得见它没过闸。"

# ───────────────────────── 体检 ─────────────────────────

[ -n "$TGZ" ] || die "要装哪一份?--tgz <插件 tgz>"
[ -f "$TGZ" ] || die "找不到要装的插件包($TGZ)。"
[ -n "$VERSION" ] || die "要发的是哪一版?--version <版本号>(/update/check 的 current 要变成它)"
for tool in curl node date; do
  command -v "$tool" >/dev/null 2>&1 || die "缺 $tool。"
done
[ -x "$NODE" ] || die "找不到工作台自带的 node($NODE)—— 这台机器上没装过工作台?
     $SKIP_HINT"
[ -f "$DSH_CLI" ] || die "找不到 DSH 的入口($DSH_CLI)—— 这台机器上的运行环境不全?
     $SKIP_HINT"

if [ -z "$LABEL" ]; then
  PLIST="$HOME/Library/LaunchAgents/ai.deepseek.dsh.plist"
  if [ -f "$PLIST" ]; then
    LABEL="$(basename "$PLIST" .plist)"
  else
    LABEL="ai.deepseek.dsh"
    info "没有 $PLIST —— Label 按缺省的 $LABEL(这台机器不是 launchd 起的?)"
  fi
fi

say "要装的是"
info "插件包   $TGZ"
info "版本     $VERSION"
info "DSH_HOME $DSH"
info "工作台   $BASE"
info "launchd  gui/$(id -u)/$LABEL"

# 不过的时候打这一段。**只打,不动手**(理由见文件头)。
rollback_hint() {
  printf '\n  回退命令(把备份那一份放回去、再起一次;**这一下该由你看着**):\n'
  if [ -f "$BK/plugin.tgz" ]; then
    cat <<EOF
    cp "$BK/plugin.tgz" "$PKG" \\
      && "$NODE" "$DSH_CLI" plugin --profile web add "$PKG" \\
      && launchctl kickstart -k gui/\$(id -u)/$LABEL
EOF
  else
    printf '    (这台机器上原来没有 %s —— 没有可回退的那一份)\n' "$PKG"
  fi
  printf '  崩了的话日志在 %s/logs/web.stderr.log。\n' "$DSH"
}

# ──────────────── 0. 网页端能加载(装之前就验) ────────────────

if [ "$WEB_CHECK" = "1" ]; then
  say "0. 网页端能加载:包里的 client.js 放进一个没有 process 的页面里执行,主界面那一格要注册上"
  if ! node "$REPO_ROOT/workbench-plugin/scripts/client-load-check.ts" --tgz "$TGZ" | sed 's/^/  /'; then
    die "这一版的网页端在 DSH 页面里加载不了(上面那一行说为什么)。**还没装、一个字节都没推。**"
  fi
else
  say "0. 网页端能加载:跳过(--no-web-check)"
fi

# ──────────────── 1. 先把现装的那一份备份下来 ────────────────

say "1. 先把这台机器上现装的那一份备份下来"
mkdir -p "$BK"
if [ -f "$PKG" ]; then
  cp "$PKG" "$BK/plugin.tgz"
  OLD_VERSION="$( (tar -xzOf "$BK/plugin.tgz" package/package.json 2>/dev/null || true) \
    | node -e 'let s="";process.stdin.on("data",d=>{s+=d}).on("end",()=>{try{const v=JSON.parse(s).version;process.stdout.write(typeof v==="string"?v:"")}catch{}})' 2>/dev/null || true )"
  info "$BK/plugin.tgz(装着的是 ${OLD_VERSION:-(读不出版本)})"
else
  info "! 这台机器上还没有 $PKG —— **没有可回退的那一份**(第一次装?)"
fi

# ──────────────── 2. 装上(与手工装那三步同一条) ────────────────

say "2. 装上"
mkdir -p "$DSH/packages"
cp "$TGZ" "$PKG"
info "已放到 $PKG"
ADD=("$NODE" "$DSH_CLI" plugin --profile web add "$PKG")
info "$ ${ADD[*]}"
# DSH_HOME 显式带一次:--dsh-home 指到沙箱演练时它不能跟着真的 ~/.dsh 走。
if ! ( cd "$DSH/packages" && DSH_HOME="$DSH" "${ADD[@]}" ); then
  rollback_hint
  die "插件装不进去(上面是它的输出)。**一个字节都没推。**"
fi
info "$ $LAUNCHCTL kickstart -k gui/$(id -u)/$LABEL"
if ! "$LAUNCHCTL" kickstart -k "gui/$(id -u)/$LABEL"; then
  rollback_hint
  die "重启工作台这一下没成(上面是它的输出)。**一个字节都没推。**"
fi

# ──────────────── 3. 等它起来、报出这一版 ────────────────

say "3. 等它起来(最多 $WAIT 秒):$BASE/update/check 的 current 要变成 $VERSION"
# /update/check 取不到公网清单也照样回 200 与 current(update/service.ts 的 check 不抛),
# 所以这一条问的就是「这台机器上跑着的是哪一版」。
current_of() {
  node -e 'let s="";process.stdin.on("data",d=>{s+=d}).on("end",()=>{try{const v=JSON.parse(s).current;process.stdout.write(typeof v==="string"?v:"")}catch{}})'
}
DEADLINE=$(( $(date +%s) + WAIT ))
LAST=""
while :; do
  BODY="$(curl -fsS -m 20 "$BASE/update/check" 2>/dev/null || true)"
  CURRENT="$( (printf '%s' "$BODY" | current_of) 2>/dev/null || true )"
  if [ "$CURRENT" = "$VERSION" ]; then
    info "起来了:current=$CURRENT"
    break
  fi
  [ -z "$BODY" ] || LAST="$BODY"
  if [ "$(date +%s)" -ge "$DEADLINE" ]; then
    rollback_hint
    die "等了 $WAIT 秒,$BASE/update/check 还没说 current=${VERSION}。
     最后一次回的是:${LAST:-(没人应答 —— 8791 根本没起来)}
     **一个字节都没推。**"
  fi
  sleep "$POLL"
done

# ──────────────── 4. 再隔一拍读 /state ────────────────

say "4. 再等 $SETTLE 秒读一次 /state(真机崩的是起来之后那一拍)"
sleep "$SETTLE"
CODE="$(curl -s -o /dev/null -w '%{http_code}' -m 20 "$BASE/state" 2>/dev/null || true)"
if [ "$CODE" != "200" ]; then
  rollback_hint
  die "$BASE/state 回的是 ${CODE:-(没人应答)},不是 200 —— 起来之后那一拍崩了。
     **一个字节都没推。**"
fi
info "/state 200"

# ──────────────── 4½. 再盯一会儿:CPU 与 /state 用时 ────────────────

# 理由见文件头第 4½ 下。CPU 按「这段时间里那个进程用掉的 CPU 秒数 ÷ 墙上的秒数」算平均,
# 不读 ps 的瞬时 %cpu(那是个衰减平均,刚起来那一拍不准)。进程按 8791 那个端口上谁在听来找 ——
# 不靠 launchctl(用例里它是假的),也不靠 pid 文件。盯的途中换了进程 = 崩过又被拉起来,同样不过。
if [ "$WATCH" -gt 0 ]; then
  say "4½. 再盯 $WATCH 秒:每 $WATCH_POLL 秒读一次 /state,量 8791 那个进程的 CPU(平均超过 ${MAX_CPU}% 或 /state 慢过 ${MAX_STATE_MS} 毫秒不止一次就不过)"
  PORT="$(printf '%s' "$BASE" | sed -n 's#^[a-z]*://[^:/]*:\([0-9]*\).*#\1#p')"
  pid_of_port() { [ -n "$PORT" ] && lsof -nP -iTCP:"$PORT" -sTCP:LISTEN -t 2>/dev/null | head -1 || true; }
  # ps 的 time 一格:`[[dd-]hh:]mm:ss.cc` → 秒(小数)。读不出来就空。
  cpu_seconds_of() {
    ps -o time= -p "$1" 2>/dev/null | awk '{
      t = $1; d = 0
      if (index(t, "-") > 0) { split(t, a, "-"); d = a[1]; t = a[2] }
      n = split(t, p, ":"); s = 0
      for (i = 1; i <= n; i++) s = s * 60 + p[i]
      printf "%.2f", s + d * 86400
    }'
  }
  PID_START="$(pid_of_port)"
  CPU_START=""
  [ -z "$PID_START" ] || CPU_START="$(cpu_seconds_of "$PID_START")"
  T_START="$(node -p 'Date.now()')"
  SAMPLES=0; SLOW=0; BAD=0; WORST=0; BAD_CODES=""
  DEADLINE=$(( $(date +%s) + WATCH ))
  STATE_TIMEOUT=$(( MAX_STATE_MS / 1000 + 5 ))
  while :; do
    OUT="$(curl -s -o /dev/null -w '%{http_code} %{time_total}' -m "$STATE_TIMEOUT" "$BASE/state" 2>/dev/null || true)"
    S_CODE="${OUT%% *}"
    S_MS="$(printf '%s' "${OUT#* }" | awk '{printf "%d", $1 * 1000}')"
    SAMPLES=$((SAMPLES + 1))
    [ -n "$S_MS" ] || S_MS=0
    [ "$S_MS" -le "$WORST" ] || WORST="$S_MS"
    if [ "$S_CODE" != "200" ]; then BAD=$((BAD + 1)); BAD_CODES="$BAD_CODES ${S_CODE:-000}"; fi
    [ "$S_MS" -le "$MAX_STATE_MS" ] || SLOW=$((SLOW + 1))
    [ "$(date +%s)" -lt "$DEADLINE" ] || break
    sleep "$WATCH_POLL"
  done
  T_END="$(node -p 'Date.now()')"
  PID_END="$(pid_of_port)"
  CPU_LINE="量不到(8791 那个端口上没找到在听的进程)"
  CPU_PCT=""
  if [ -n "$PID_START" ] && [ -n "$CPU_START" ] && [ "$PID_END" = "$PID_START" ]; then
    CPU_END="$(cpu_seconds_of "$PID_END")"
    CPU_PCT="$(awk -v a="$CPU_START" -v b="$CPU_END" -v t0="$T_START" -v t1="$T_END" 'BEGIN { w = (t1 - t0) / 1000; if (w <= 0) w = 1; printf "%d", (b - a) / w * 100 }')"
    CPU_LINE="平均 ${CPU_PCT}%(进程 ${PID_END})"
  fi
  info "CPU:$CPU_LINE"
  info "/state:读了 $SAMPLES 次,最慢 ${WORST} 毫秒,慢过 ${MAX_STATE_MS} 毫秒的 $SLOW 次,不是 200 的 $BAD 次"
  if [ -n "$PID_START" ] && [ -n "$PID_END" ] && [ "$PID_END" != "$PID_START" ]; then
    rollback_hint
    die "盯的这 $WATCH 秒里 8791 换了一个进程($PID_START → $PID_END)—— 崩过一次又被拉起来了。**一个字节都没推。**"
  fi
  if [ "$BAD" -gt 0 ]; then
    rollback_hint
    die "盯的这 $WATCH 秒里 /state 有 $BAD 次不是 200(回的是:$BAD_CODES)。**一个字节都没推。**"
  fi
  if [ "$SLOW" -gt 1 ]; then
    rollback_hint
    die "盯的这 $WATCH 秒里 /state 慢过 ${MAX_STATE_MS} 毫秒的有 $SLOW 次(最慢 ${WORST} 毫秒)—— 它在空转或者卡着。**一个字节都没推。**"
  fi
  if [ -n "$CPU_PCT" ] && [ "$CPU_PCT" -gt "$MAX_CPU" ]; then
    rollback_hint
    die "盯的这 $WATCH 秒里 8791 平均 CPU ${CPU_PCT}%,超过 ${MAX_CPU}% —— 它在空转。**一个字节都没推。**"
  fi
else
  say "4½. 再盯一会儿:跳过(--watch 0)"
fi

# ──────────── 4¾. 回归门:理解中枢回归集的通过率 ────────────
#
# 2026-10-28 维护者拍板(决策记录同日):事务官理解中枢改「模型出命令」,`docs/回归集-事务官真实交代-*.md`
# 整表通过率进本机闸、开源前公示。报告由 `workbench-plugin/dev/intent-regression/run.mjs` 跑真模型写出
# (`report.json`:total / passed / rate / at)。线(--intent-min)由维护者定:没定就只公示不挡;
# 定了线却没有报告 = 这一版没跑回归集,不过 —— 不许拿「没跑」当「全过」。

say "4¾. 回归门:理解中枢回归集的通过率"
if [ -n "$INTENT_REPORT" ] && [ -f "$INTENT_REPORT" ]; then
  INTENT_LINE="$(INTENT_REPORT="$INTENT_REPORT" node -e '
    const fs = require("node:fs");
    try {
      const r = JSON.parse(fs.readFileSync(process.env.INTENT_REPORT, "utf8"));
      const total = Number(r.total) || 0, passed = Number(r.passed) || 0;
      const pct = total > 0 ? Math.floor(passed / total * 100) : 0;
      process.stdout.write([pct, passed, total, typeof r.at === "string" ? r.at : ""].join("\t"));
    } catch { process.stdout.write(""); }
  ' 2>/dev/null || true)"
  if [ -z "$INTENT_LINE" ]; then
    die "回归集报告读不出来:$INTENT_REPORT —— 先重跑 node workbench-plugin/dev/intent-regression/run.mjs。**一个字节都没推。**"
  fi
  INTENT_PCT="$(printf '%s' "$INTENT_LINE" | awk -F'\t' '{print $1}')"
  INTENT_PASSED="$(printf '%s' "$INTENT_LINE" | awk -F'\t' '{print $2}')"
  INTENT_TOTAL="$(printf '%s' "$INTENT_LINE" | awk -F'\t' '{print $3}')"
  INTENT_AT="$(printf '%s' "$INTENT_LINE" | awk -F'\t' '{print $4}')"
  info "通过率 ${INTENT_PCT}%(${INTENT_PASSED}/${INTENT_TOTAL},跑于 ${INTENT_AT:-不详})$([ -n "$INTENT_MIN" ] && printf ',线 %s%%' "$INTENT_MIN")"
  if [ -n "$INTENT_MIN" ] && [ "$INTENT_PCT" -lt "$INTENT_MIN" ]; then
    rollback_hint
    die "回归集通过率 ${INTENT_PCT}%,低于线 ${INTENT_MIN}% —— 事务官听不懂的还太多,不能发。**一个字节都没推。**"
  fi
elif [ -n "$INTENT_MIN" ]; then
  die "定了回归门线 ${INTENT_MIN}%,却没有回归集报告(${INTENT_REPORT:-没给 --intent-report})——
     先跑 node workbench-plugin/dev/intent-regression/run.mjs,它会写出 report.json。**一个字节都没推。**"
else
  info "没有回归集报告,这一版不带通过率(理解中枢的 harness 跑过之后会有;线由维护者用 --intent-min 定)。"
fi

# ──────────── 5. 本机房间:信令口回 200(只看,不装) ────────────

LK_BIN="$DSH/livekit/livekit-server"
if [ -z "$LIVEKIT_URL" ]; then
  LK_PORT="$(sed -n 's/^port: *\([0-9][0-9]*\) *$/\1/p' "$DSH/livekit/livekit.yaml" 2>/dev/null | head -1 || true)"
  LIVEKIT_URL="http://127.0.0.1:${LK_PORT:-7880}"
fi
LIVEKIT_URL="${LIVEKIT_URL%/}"
say "5. 本机房间:$LIVEKIT_URL 要回 200"
if [ -n "$SKIP_LIVEKIT_WHY" ]; then
  info "!! 这一下跳过了。理由:$SKIP_LIVEKIT_WHY"
elif [ ! -x "$LK_BIN" ]; then
  info "这台机器上还没装本机通话服务($LK_BIN 不在)—— 这一下跳过。"
  info "带上它的那一版(publish-update.sh --with livekit)发完之后「本机也走一遍更新路」会装上,下一次发版闸就验它。"
else
  LK_DEADLINE=$(( $(date +%s) + LIVEKIT_WAIT ))
  LK_CODE=""
  while :; do
    LK_CODE="$(curl -s -o /dev/null -w '%{http_code}' -m 3 "$LIVEKIT_URL/" 2>/dev/null || true)"
    [ "$LK_CODE" = "200" ] && break
    if [ "$(date +%s)" -ge "$LK_DEADLINE" ]; then
      die "本机房间没答:$LIVEKIT_URL 回的是 ${LK_CODE:-(没人应答)},不是 200。**一个字节都没推。**
     插件这一版已经装上、起来了(第 3、4 下都过了),不用回退 —— 是本机通话服务那一项没起来:
       launchctl print gui/\$(id -u)/ai.deepseek.livekit | head -30
       tail -30 $DSH/logs/livekit.stderr.log
     修好再来;这一趟就是不验它:publish-update.sh --skip-livekit-check \"<理由>\"。"
    fi
    sleep "$POLL"
  done
  info "本机房间 200"
fi

# ──────────── 6. 记一行:这台机器上装着的插件是这一份 ────────────

# 理由见文件头「为什么装完要记一行账」。**记在最后**:前面哪一下不过都走不到这儿 ——
# 记早了等于把一台没装成的机器说成装好了,而下一次更新就会跳过它。
say "6. 记一行账:${INSTALLED_JSON} 里 plugin_tgz 那一行"
PKG_SHA="$( (shasum -a 256 "$PKG" | awk '{print $1}') 2>/dev/null || true )"
if [ ${#PKG_SHA} -ne 64 ]; then
  info "! 算不出 ${PKG} 的 sha256 —— 这一行不记(代价只是下一次更新多下一趟插件)。"
else
  mkdir -p "$DSH/updates"
  # 形状与 update/installed.ts 的 writeInstalled 一致:assets.<种类> = { sha256, version, at }。
  # **只改 plugin_tgz 那一行**,别的行原样留着(闸只装了插件,别的几样还是上一次装的那份)。
  # 读不懂的旧文件一律当成"一条记录都没有"(客户端读它也是这条规矩),绝不半途抛。
  if FILE="$INSTALLED_JSON" SHA="$PKG_SHA" PKG_VERSION="$VERSION" node -e '
    const fs = require("node:fs");
    const file = process.env.FILE;
    let body = {};
    try {
      const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
      if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) body = parsed;
    }
    catch { /* 文件不在、或者写坏了:当成一条记录都没有 */ }
    const old = body.assets;
    const assets = old !== null && typeof old === "object" && !Array.isArray(old) ? old : {};
    const at = new Date().toISOString();
    assets.plugin_tgz = { sha256: process.env.SHA, version: process.env.PKG_VERSION, at };
    fs.writeFileSync(file, `${JSON.stringify({ ...body, version: process.env.PKG_VERSION, updated_at: at, assets }, null, 2)}\n`);
  '; then
    info "plugin_tgz = ${PKG_SHA}"
    info "于是发完版那一遍「立即更新」只装别的几样(事务官后端 / 通话组件…),不再重装插件、不再多重启一次。"
  else
    info "! 写不进 ${INSTALLED_JSON} —— 这一行没记上(插件已经装上了,闸照样算过)。"
  fi
fi

printf '\n✓  本机闸过了:%s 页面里加载得了、装上了、起来了、盯了 %s 秒 CPU 与 /state 都在线内(本机房间那一下见第 5 下)。\n' "$VERSION" "$WATCH"
printf '   上一版留在 %s(确认没问题之后由你自己删)。\n\n' "$BK"
