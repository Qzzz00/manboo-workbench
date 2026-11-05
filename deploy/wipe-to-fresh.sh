#!/usr/bin/env bash
#
# 把这台 Mac 上的工作台清空回初始状态(2026-09-30)。
# 维护者原话:「想要让 air 上所有东西清空,回到初始状态,对应的手机和座机记录也要清空」。
#
#     bash deploy/wipe-to-fresh.sh              # 默认只列不删(空跑),看它打算做什么
#     bash deploy/wipe-to-fresh.sh --do         # 真跑:每一步先打印、再等你敲 y
#     bash deploy/wipe-to-fresh.sh --do --yes   # 真跑,不问(自动化/演练用)
#
# 清完重装:`bash deploy/bootstrap.sh`(登录页输**原来那个账号密码**,不是重新注册)。
#
# ## 它按什么删
#
# 权威清单是 `docs/验收-从零重装清单-2026-09-17.md`:第一节备份、第二节安装件、
# 第八~十节用户态。**只删清单里点了名的那些具体路径**,不递归删清单之外任何东西
# (2026-09-04 家目录被删事故之后的规矩:先备份、先列、逐项删、每个 rm 前 ls 一眼)。
#
# ## 三个阶段
#
#   ① 备份   清单 §一 那几样打成 ~/Desktop/工作台清空前备份-<时刻>.tgz。
#            **打不出来 / 验不过就整个退出,一个字节都不删。**
#   ② 账号下的设备(要趁工作台还在跑)
#            列出账号名下的设备(手机、座机、电脑),逐台撤;**座机放最后、单独再确认一次**。
#            撤完 POST /account/reset —— 这台电脑退出登录(账号本身在服务器上,不动)。
#            工作台没在跑 / 调不通:如实说「账号设备没撤,去手机设置里撤」,不中断后面。
#   ③ 本机   安装件与用户态,逐项删。
#   ④ 收尾   打印只能由人手动做的那几件(系统授权、hooks)与重装命令。
#
# ## 座机那一句提醒(2026-09-30 决策记录)
#
# 09-28 撤座机钥匙造成过死锁:座机连着网 → 老规矩下不开蓝牙;钥匙被拒 → 进不了房 →
# 只会每 20 秒重试,两条路都断。现在座机程序已改成「连不上网**或进不了房**就一直开蓝牙」,
# 但**那台树莓派要拔卡升级过 09-30 那版才生效**。所以撤座机之后:
#   - 已升级:它自己会开蓝牙等你在手机「设置 → 座机」里重新添加;
#   - 没升级:把它连的那个 Wi-Fi 关掉一分钟,它才会开蓝牙。
#
# ## 参数
#
#   --do / --apply     真动手(不给就只列不删)
#   --yes              不逐步问(要配 --do 用)
#   --home <路径>      拿它当 HOME(演练时指到 mktemp 出来的沙箱)。缺省 $HOME
#   --dsh-home <路径>  缺省 <home>/.dsh
#   --app <路径>       壳 App,缺省 /Applications/工作台.app
#   --port <口>        工作台端口,缺省 ${WORKBENCH_PORT:-8791}
#   --label <名字>     launchd 项 Label,缺省 ai.deepseek.dsh
#   --no-launchd       不碰 launchd(演练用)
#   --with-documents   连 <home>/Documents/工作台 一起删(清单里是「待拍板」,缺省不删)
#   --with-updates     连 <dsh-home>/updates 一起删(同上,缺省不删)
#   --skip-devices     跳过阶段 ②(工作台已经停了、或只想清本机)
#
# ## 凭据
#
# 这个脚本不打印任何密钥 / 令牌 / Cookie:只打印**路径名**。备份 tgz 里有凭据文件,
# 它躺在你自己的桌面上 —— 别把它发给任何人。

set -euo pipefail

DO=0
ASSUME_YES=0
HOME_ARG=""
DSH_HOME_ARG=""
APP_PATH="/Applications/工作台.app"
PORT="${WORKBENCH_PORT:-8791}"
LABEL="ai.deepseek.dsh"
USE_LAUNCHD=1
WITH_DOCUMENTS=0
WITH_UPDATES=0
SKIP_DEVICES=0

die() { printf '\n×  %s\n' "$1" >&2; exit 1; }

while [ $# -gt 0 ]; do
  case "$1" in
    --do|--apply) DO=1 ;;
    --dry-run) DO=0 ;;
    --yes) ASSUME_YES=1 ;;
    --home) shift; HOME_ARG="${1:-}" ;;
    --dsh-home) shift; DSH_HOME_ARG="${1:-}" ;;
    --app) shift; APP_PATH="${1:-}" ;;
    --port) shift; PORT="${1:-}" ;;
    --label) shift; LABEL="${1:-}" ;;
    --no-launchd) USE_LAUNCHD=0 ;;
    --with-documents) WITH_DOCUMENTS=1 ;;
    --with-updates) WITH_UPDATES=1 ;;
    --skip-devices) SKIP_DEVICES=1 ;;
    -h|--help) sed -n '2,60p' "$0"; exit 0 ;;
    *) die "不认识的参数:$1" ;;
  esac
  shift
done

H="${HOME_ARG:-$HOME}"
[ -n "$H" ] && [ -d "$H" ] || die "HOME 不存在:$H"
DSH="${DSH_HOME_ARG:-$H/.dsh}"
# ~/.dsh 指到家目录本身 / 根,底下每一条「具体路径」就都变成了家目录级别的东西。当场退,不往下走。
case "$DSH" in
  ""|"/"|"$H"|"$H/") die "--dsh-home 不能是家目录或根($DSH)—— 那样清单里的每一条都会变成家目录级别的路径" ;;
esac
WB="$DSH/workbench"
DESKTOP="$H/Desktop"
STAMP="$(date +%Y%m%d-%H%M%S)"
TGZ="$DESKTOP/工作台清空前备份-$STAMP.tgz"

say()  { printf '%s\n' "$*"; }
step() { printf '\n########## %s ##########\n' "$1"; }
note() { printf '   · %s\n' "$*"; }

# 每一步先打印要做什么,再等 y。空跑不问(什么都不会做);--yes 不问(直接做)。
# 返回 0 = 做,非 0 = 跳过。
confirm() {
  local what="$1"
  if [ "$DO" -eq 0 ]; then return 1; fi
  if [ "$ASSUME_YES" -eq 1 ]; then return 0; fi
  local ans=""
  printf '   ── %s  [y/N] ' "$what"
  if [ -r /dev/tty ]; then read -r ans < /dev/tty || ans=""; else read -r ans || ans=""; fi
  case "$ans" in y|Y|yes|YES) return 0 ;; *) printf '   (跳过)\n'; return 1 ;; esac
}

# 删一个路径。层层把关,只删「在 <home> 底下(或正是那只壳 App)」而且**存在**的东西。
# 通配、递归上层、空变量一律当成事故处理:整个退出。
remove_path() {
  local p="$1" what="${2:-}"
  case "$p" in
    ""|"/"|"$H"|"$H/"|"$DSH"|"$DSH/") die "拒绝删「$p」—— 这是家目录或 ~/.dsh 本身,清单里没有它" ;;
    *'*'*|*'?'*) die "拒绝删带通配的「$p」" ;;
  esac
  case "$p" in
    "$H"/*) : ;;
    "$APP_PATH") : ;;
    *) die "拒绝删「$p」—— 不在 $H 底下,也不是那只壳 App" ;;
  esac
  if [ ! -e "$p" ] && [ ! -L "$p" ]; then note "已经没有:$p"; return 0; fi
  local size; size="$(du -sh "$p" 2>/dev/null | awk '{print $1}')"
  say "   要删:$p  (${size:-?}) ${what:+— $what}"
  if [ "$DO" -eq 0 ]; then note "空跑,没动"; return 0; fi
  if confirm "删掉它?"; then
    rm -rf -- "$p"
    if [ -e "$p" ] || [ -L "$p" ]; then die "删不掉:$p"; fi
    note "删了"
    DELETED_COUNT=$((DELETED_COUNT + 1))
    DELETED_LIST="$DELETED_LIST
  - $p"
  fi
}

DELETED_COUNT=0
DELETED_LIST=""

# JSON 取值用 python3(macOS 自带);没有就退回 node;都没有就只打印原样、不解析。
JSONTOOL=""
if command -v python3 >/dev/null 2>&1; then JSONTOOL="python3"
elif command -v node >/dev/null 2>&1; then JSONTOOL="node"; fi

say "工作台清空 → 初始状态"
say "  HOME        $H"
say "  ~/.dsh      $DSH"
say "  壳 App      $APP_PATH"
say "  工作台端口  127.0.0.1:$PORT"
if [ "$DO" -eq 0 ]; then
  say ""
  say "  ** 空跑(只列不删)。真要清,加 --do。 **"
else
  say ""
  say "  ** 真跑。每一步会问你一次;加了 --yes 就不问。 **"
fi

# ───────────────────────── ① 备份 ─────────────────────────
step "① 备份(清单 §一)→ $TGZ"

BACKUP_ITEMS=(
  "$WB"
  "$DSH/AGENTS.md"
  "$DSH/.env"
  "$DSH/.credentials.yaml"
  "$DSH/settings.yaml"
  "$DSH/sessions"
  "$DSH/storages"
  "$H/.claude/settings.json"
  "$H/.codex/hooks.json"
)
PRESENT_COUNT=0
PRESENT_REL=""   # 一行一条,相对 $H 的路径
for item in "${BACKUP_ITEMS[@]}"; do
  if [ -e "$item" ]; then
    PRESENT_COUNT=$((PRESENT_COUNT + 1))
    PRESENT_REL="$PRESENT_REL${item#"$H"/}
"
    note "要备份:$item"
  else
    note "没有(跳过):$item"
  fi
done
[ "$PRESENT_COUNT" -gt 0 ] || die "一样都不在,这台机器上大概没装过工作台 —— 什么都不做就退出"

if [ "$DO" -eq 0 ]; then
  note "空跑:不真打包。真跑时会打成 $TGZ 并验一遍(列得出文件、大小合理才继续)"
else
  if confirm "把上面这些打成 $TGZ?"; then
    mkdir -p "$DESKTOP" || die "桌面目录建不出来:$DESKTOP —— 什么都没删,原地退出"
    # 用相对路径进包(-C $H,一行一条从 stdin 读),解开时不会盖到别处。
    printf '%s' "$PRESENT_REL" | tar -czf "$TGZ" -C "$H" -T - || die "打包失败 —— 什么都没删,原地退出"
    COUNT="$(tar -tzf "$TGZ" 2>/dev/null | wc -l | tr -d ' ')"
    BYTES="$(wc -c < "$TGZ" | tr -d ' ')"
    [ "${COUNT:-0}" -ge 1 ] || die "备份包列不出文件 —— 什么都没删,原地退出"
    [ "${BYTES:-0}" -ge 1024 ] || die "备份包只有 ${BYTES} 字节,不对劲 —— 什么都没删,原地退出"
    note "备份好了:$TGZ($COUNT 个条目,$(du -sh "$TGZ" | awk '{print $1}'))"
    note "本机 Time Machine 没有备份目标 —— 现在就把这个 tgz 再拷一份到别处(清单 §七)"
  else
    die "没备份就不往下走(规矩:先备份)"
  fi
fi

# ───────────────────────── ② 账号下的设备 ─────────────────────────
step "② 账号下的设备(趁工作台还在跑)"

DEVICES_DONE=0
API="http://127.0.0.1:$PORT"

api_get() { curl -fsS --max-time 8 "$API$1" 2>/dev/null; }
api_post() { curl -fsS --max-time 15 -X POST -H 'content-type: application/json' -d "$2" "$API$1" 2>/dev/null; }

# 把 /account/devices 的回包压成一行一台:<device_id>\t<kind>\t<name>\t<last_seen>
# 回包里本来就没有任何令牌(http.ts 那一段写明了),这里也不打印别的。
parse_devices() {
  case "$JSONTOOL" in
    python3) python3 -c '
import json,sys
try: d=json.load(sys.stdin)
except Exception: sys.exit(3)
for x in (d.get("devices") or []):
    print("\t".join([str(x.get("device_id") or x.get("id") or ""), str(x.get("kind") or "phone"),
                     str(x.get("name") or "(没名字)"), str(x.get("last_seen_at") or ""),
                     "1" if x.get("current") else ""]))
' ;;
    node) node -e '
let s="";process.stdin.on("data",c=>s+=c).on("end",()=>{let d;try{d=JSON.parse(s)}catch{process.exit(3)}
for(const x of d.devices||[])console.log([x.device_id||x.id||"",x.kind||"phone",x.name||"(没名字)",x.last_seen_at||"",x.current?"1":""].join("\t"))})
' ;;
    *) return 3 ;;
  esac
}

devices_unavailable() {
  say "   !! 账号设备没撤,去手机设置里撤(或下次工作台起来之后再跑一遍 --skip-devices 之外的这一步)。"
  say "      原因:$1"
}

if [ "$SKIP_DEVICES" -eq 1 ]; then
  note "--skip-devices:这一步不做"
  devices_unavailable "你自己跳过的"
elif [ -z "$JSONTOOL" ]; then
  devices_unavailable "这台机器上既没有 python3 也没有 node,解不了回包"
elif ! api_get /account >/dev/null 2>&1; then
  devices_unavailable "127.0.0.1:$PORT 上没有在跑的工作台"
else
  RAW="$(api_get /account/devices || true)"
  LIST="$(printf '%s' "$RAW" | parse_devices || true)"
  if [ -z "$RAW" ]; then
    devices_unavailable "/account/devices 没答上来(账号可能还在这台机器上,没有设备列表)"
  elif [ -z "$LIST" ]; then
    note "账号名下一台设备都没有,不用撤"
    DEVICES_DONE=1
  else
    say "   账号名下现在有这几台(先列,后撤;座机放最后):"
    while IFS=$'\t' read -r id kind name seen cur; do
      [ -n "$id" ] || continue
      say "     - [$kind] $name${cur:+(就是这台电脑)}  上次在线 ${seen:-未知}"
    done <<< "$LIST"

    # 先普通设备(手机、电脑),座机单独留到最后。
    while IFS=$'\t' read -r id kind name seen cur; do
      [ -n "$id" ] || continue
      [ "$kind" != "handset" ] || continue
      say "   撤:[$kind] $name"
      if [ "$DO" -eq 0 ]; then note "空跑,没撤"; continue; fi
      if confirm "把「$name」从账号里移除?(它的设备令牌当场失效)"; then
        if api_post /account/devices/revoke "{\"device_id\":\"$id\"}" >/dev/null; then note "撤了"
        else say "   !! 「$name」没撤成(服务器没答应),去手机设置里撤"; fi
      fi
    done <<< "$LIST"

    # 座机:单独一步、单独确认、带那句提醒。
    HANDSETS="$(printf '%s\n' "$LIST" | awk -F'\t' '$2=="handset"')"
    if [ -n "$HANDSETS" ]; then
      say ""
      say "   ==== 座机(单独确认一次)===================================="
      say "   撤了之后那台座机会进不了房。它要**升级过 09-30 那版座机程序**才会自己开蓝牙"
      say "   等你在手机「设置 → 座机」里重新添加;没升级的话,得把它连的那个 Wi-Fi 关掉一分钟"
      say "   才会开蓝牙(09-28 就是在这儿死锁过一次)。上座机升级:拔卡插 Mac →"
      say "   phone-bridge/sdcard-stage.sh /Volumes/bootfs。"
      say "   ==========================================================="
      while IFS=$'\t' read -r id kind name seen cur; do
        [ -n "$id" ] || continue
        say "   撤座机:$name  上次在线 ${seen:-未知}"
        if [ "$DO" -eq 0 ]; then note "空跑,没撤"; continue; fi
        if confirm "确认把座机「$name」也从账号里移除?"; then
          if api_post /account/devices/revoke "{\"device_id\":\"$id\"}" >/dev/null; then note "座机撤了 —— 别忘了上面那段提醒"
          else say "   !! 座机没撤成(服务器没答应),去手机设置里撤"; fi
        fi
      done <<< "$HANDSETS"
    fi
    DEVICES_DONE=1
  fi

  # 本机这份配对表(devices.json)里的设备:/pair/revoke 一台一台解。
  # 这份文件 ③ 里也会删掉,先解一遍是为了让还连着的手机当场失效。
  STATE="$(api_get /state || true)"
  LOCAL="$(printf '%s' "$STATE" | parse_devices || true)"
  if [ -n "$LOCAL" ]; then
    say "   这台电脑本机的配对表里还有:"
    while IFS=$'\t' read -r id kind name seen cur; do
      [ -n "$id" ] || continue
      say "     - [$kind] $name"
      if [ "$DO" -eq 0 ]; then continue; fi
      if confirm "解除本机与「$name」的配对?"; then
        api_post /pair/revoke "{\"id\":\"$id\"}" >/dev/null && note "解了" || note "没解成(③ 里删 devices.json 也能到位)"
      fi
    done <<< "$LOCAL"
  fi

  # 这台电脑退出登录。账号本身在服务器上,一个字不动。
  say "   这台电脑退出登录(POST /account/reset;删的是本机账号记录,记忆/事项/凭据不动)"
  if [ "$DO" -eq 1 ] && confirm "现在就让这台电脑退出登录?"; then
    api_post /account/reset '{}' >/dev/null && note "退了" || note "没退成 —— ③ 里删 account*.json 也能到位"
  fi
fi

# ───────────────────────── ③ 本机 ─────────────────────────
step "③ 本机:安装件与用户状态(清单 §二、§八~§十)"

PLIST="$H/Library/LaunchAgents/$LABEL.plist"
UID_NUM="$(id -u)"

say "   先停在跑的东西,再逐项删。"

# 3.1 launchd
if [ "$USE_LAUNCHD" -eq 1 ] && [ -e "$PLIST" ]; then
  say "   launchctl bootout gui/$UID_NUM/$LABEL"
  if [ "$DO" -eq 1 ] && confirm "停掉开机自启项?"; then
    launchctl bootout "gui/$UID_NUM/$LABEL" 2>/dev/null || note "bootout 说它本来就没载(没关系)"
  fi
else
  note "不碰 launchd($( [ "$USE_LAUNCHD" -eq 0 ] && echo '--no-launchd' || echo '没有那个 plist' ))"
fi

# 3.2 壳 App:先退出再删
if [ -e "$APP_PATH" ]; then
  say "   先退出壳 App,再删 $APP_PATH"
  if [ "$DO" -eq 1 ] && confirm "退出「工作台」这只壳?"; then
    osascript -e 'tell application "工作台" to quit' 2>/dev/null || note "它本来就没开(没关系)"
    pkill -f "$APP_PATH/Contents/MacOS" 2>/dev/null || true
  fi
fi

# 3.3 DSH 拉起的无头 Chrome:不先杀掉,login-profile-kimi_web 会被马上建回来(清单 §十)
if pgrep -f login-profile-kimi_web >/dev/null 2>&1; then
  say "   杀掉 DSH 拉起的那个无头 Chrome(不杀它,login-profile-kimi_web 会被马上建回来)"
  if [ "$DO" -eq 1 ] && confirm "杀掉它?"; then
    pkill -f login-profile-kimi_web 2>/dev/null || true
    note "杀了"
  fi
else
  note "没有在跑的无头 Chrome"
fi

# 3.4 安装件(清单 §二)
say ""
say "   —— 安装件(清单 §二)——"
remove_path "$DSH/node"            "自有 node"
remove_path "$DSH/runtime"         "DSH 运行时"
remove_path "$DSH/profiles"        "profile(含插件安装)"
remove_path "$DSH/packages"        "历次插件 tgz"
remove_path "$DSH/bin"             "启动脚本"
remove_path "$DSH/butler-server"   "语音后端代码副本"
remove_path "$DSH/channel-worker"  "电话工人副本"
remove_path "$DSH/logs"            "日志"
[ "$USE_LAUNCHD" -eq 1 ] || true
remove_path "$PLIST"               "开机自启项"
remove_path "$APP_PATH"            "壳 App"

# 3.5 用户态(清单 §八、§九)
say ""
say "   —— 用户态:账号 / 配对 / 引导 / 凭据(清单 §八、§九)——"
remove_path "$WB/account.json"        "本机账号"
remove_path "$WB/account-session.key" "本机会话密钥"
remove_path "$WB/account-server.json" "服务器账号的会话令牌(不删会直接跳过登录页)"
remove_path "$WB/devices.json"        "手机配对表"
remove_path "$WB/onboarding.json"     "引导进度"
remove_path "$WB/credentials.json"    "各家模型凭据"
remove_path "$WB/model.json"          "模型服务选择"
remove_path "$WB/channel.json"        "通道密钥(09-21 起改由服务器下发,删了不会再建)"
remove_path "$WB/login-profile-kimi_web" "Kimi 网页登录的浏览器档案"
remove_path "$DSH/.env"               "DSH 的 .env(09-21 起整个删)"

# app.json 里的 first_run_done_at:只摘这一个键,别的不动。
APPJSON="$WB/app.json"
if [ -f "$APPJSON" ]; then
  if grep -q first_run_done_at "$APPJSON" 2>/dev/null; then
    say "   摘掉 $APPJSON 里的 first_run_done_at(文件里别的一个字不动)"
    if [ "$DO" -eq 1 ] && confirm "摘掉它?"; then
      if [ "$JSONTOOL" = python3 ]; then
        python3 - "$APPJSON" <<'PY'
import json,sys
p=sys.argv[1]
d=json.load(open(p,encoding="utf-8"))
d.pop("first_run_done_at",None)
json.dump(d,open(p,"w",encoding="utf-8"),ensure_ascii=False,indent=2)
PY
        note "摘了"
      else
        note "没有 python3,这一个键请自己在 $APPJSON 里删掉"
      fi
    fi
  else
    note "app.json 里没有 first_run_done_at"
  fi
fi

# 3.6 壳的网页存储(登录 cookie 在这里,清单 §八)
say ""
say "   —— 壳的网页存储:登录 cookie 在这里,不删会直接跳过登录(清单 §八)——"
remove_path "$H/Library/WebKit/ai.ben.workbench"       "WebKit"
remove_path "$H/Library/HTTPStorages/ai.ben.workbench" "HTTPStorages"
remove_path "$H/Library/Caches/ai.ben.workbench"       "Caches"

# 3.7 清单里写着「待拍板」的两样:默认不删,问一句
say ""
say "   —— 清单 §十 里「待拍板」那两样(缺省不删)——"
for pair in "updates|$DSH/updates|热更新下载缓存|$WITH_UPDATES" "documents|$H/Documents/工作台|事务官工作目录|$WITH_DOCUMENTS"; do
  IFS='|' read -r flag path what on <<< "$pair"
  if [ ! -e "$path" ]; then note "没有:$path"; continue; fi
  if [ "$on" -eq 1 ]; then
    remove_path "$path" "$what(--with-$flag)"
  else
    note "留着:$path($what)。要一起删就加 --with-$flag"
  fi
done

# ───────────────────────── ④ 收尾 ─────────────────────────
step "④ 剩下这几件只能你自己做"
say "   1. 系统设置 → 隐私与安全性(清单 §四):"
say "      · 辅助功能:把「工作台」选中按「−」移除"
say "      · 文件和文件夹:找到 node,取消「文稿文件夹」"
say "      · 日历 / 自动化:找到 DSH 相关进程(名字可能显示成 node),取消"
say "      删完能立刻验的是:重装后这三项会重新弹窗。"
say "   2. hooks(清单 §五):"
say "      · ~/.claude/settings.json 里那四条 agent-hook 与 statusLine"
say "      · ~/.codex/hooks.json 里那三条工作台 hook"
say "      拿备份 tgz 里的同名文件对照着删,**别动文件里别的**(尤其 headroom 那部分)。"
say "      登录台第 4 步会把新的渲染出来让你贴回去。"
say "   3. 备份包再拷一份到别处(本机 Time Machine 没有备份目标):"
if [ "$DO" -eq 1 ]; then say "      $TGZ"; else say "      (真跑时才会生成)"; fi
if [ "$DEVICES_DONE" -eq 0 ]; then
  say "   4. **账号下的设备没撤** —— 去手机「设置 → 账号 → 我的设备」里撤;座机那条见上面的提醒。"
fi
say ""
say "   重装:bash deploy/bootstrap.sh"
say "   登录页输的是**原来那个账号密码**(登录,不是重新注册 —— 账号在服务器上,设备也在)。"

step "结果"
if [ "$DO" -eq 0 ]; then
  say "空跑,什么都没动。真要清:bash deploy/wipe-to-fresh.sh --do"
else
  say "删掉的路径 $DELETED_COUNT 条:$DELETED_LIST"
fi
