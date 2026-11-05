#!/usr/bin/env bash
#
# 裸机引导:一台什么都没装的 Mac,从这个仓库一条命令跑到「登录台(初始化页)能打开」。
#
#     bash deploy/bootstrap.sh
#
# 它做到哪儿为止:体检 node → 装六步(自有 node / DSH 运行时 / profile / 工作台插件 /
# 启动脚本 / 开机自启项)→ 起 DSH → 等 8791 起来 → 从日志里取那条带 token 的地址 →
# 在浏览器里打开初始化页。**剩下的(系统授权、密钥、壳 App、手机)全在那一页里做。**
#
# 为什么要这条命令:登录台住在工作台服务里,而工作台服务是 DSH 的插件 —— 登录台自己
# 没法把自己装出来(`docs/验收-从零重装清单-2026-09-17.md` 第六节第 3 条点名要的就是它)。
#
# 安装逻辑**一行都不在这个文件里**:六步全部转交 `workbench-plugin/scripts/bootstrap.ts`,
# 它调的是登录台一键装用的同一个服务(`workbench-plugin/src/server/setup/`)。
# 两处各写一份安装步骤,迟早不一致。
#
# 可以覆盖的环境变量:
#   HOME            装到哪个家目录(默认就是你的)。临时目录里试跑时用它。
#   DSH_HOME        DSH 的家(默认 $HOME/.dsh)。
#   WORKBENCH_PORT  工作台服务的端口(默认 8791),只影响"等它起来"那一步探哪个口。
#
# 可以给的参数:
#   --no-launch   不跑任何 launchctl,也不等端口、不开浏览器。装完就停。
#                 **在临时 HOME 里试跑时必须给** —— 真装载会和正在跑的那台服务抢端口。
#   --no-open     装完、起好、取到地址,但不替你开浏览器(地址打在屏幕上)。
#   --steps a,b   只跑其中几步(调试用)。名字见 --help。
#   --help        看这段说明。
#
# 反复跑没关系:每一步都是幂等的,装好的不会重装。

set -euo pipefail

REPO_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
WORKBENCH_PORT="${WORKBENCH_PORT:-8791}"
NO_LAUNCH=0
NO_OPEN=0
STEPS=""

# 人话进度:每一大步一行,前面带个序号,失败时紧跟着说怎么办。
TOTAL=6
say() { printf '\n[%s/%s] %s\n' "$1" "$TOTAL" "$2"; }
info() { printf '      %s\n' "$1"; }
die() { printf '\n×  %s\n' "$1" >&2; exit 1; }

while [ $# -gt 0 ]; do
  case "$1" in
    --no-launch) NO_LAUNCH=1 ;;
    --no-open) NO_OPEN=1 ;;
    --steps) shift; STEPS="${1:-}" ;;
    --help|-h)
      sed -n '2,40p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *) die "不认识的参数:$1(能用的是 --no-launch / --no-open / --steps / --help)" ;;
  esac
  shift
done

printf '工作台裸机引导\n仓库:%s\n家目录:%s\nDSH 的家:%s\n' "$REPO_ROOT" "$HOME" "${DSH_HOME:-$HOME/.dsh}"
[ "$NO_LAUNCH" = "1" ] && printf '模式:--no-launch(只装,不起服务、不开浏览器)\n'

# ───────────────────────── 1. 体检 node ─────────────────────────

say 1 "看一眼这台机器上的 node"

NODE_BIN="$(command -v node 2>/dev/null || true)"
if [ -z "$NODE_BIN" ]; then
  cat >&2 <<'EOF'

×  这台机器上还没有 node。工作台要 node 24 或更新,照着装一个:

  # 还没有 Homebrew 的话,先装它(官方安装脚本):
  /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
  # 然后装 node 24:
  brew install node@24
  echo 'export PATH="/opt/homebrew/opt/node@24/bin:$PATH"' >> ~/.zprofile
  exec zsh -l   # 让 PATH 生效

装好之后重新跑一次:bash deploy/bootstrap.sh
EOF
  exit 1
fi

NODE_VERSION="$("$NODE_BIN" -v 2>/dev/null || true)"
NODE_MAJOR="${NODE_VERSION#v}"
NODE_MAJOR="${NODE_MAJOR%%.*}"
case "$NODE_MAJOR" in
  ''|*[!0-9]*) die "认不出 node 的版本号(\`node -v\` 给的是「${NODE_VERSION}」)。确认 $NODE_BIN 真的是 node。" ;;
esac
if [ "$NODE_MAJOR" -lt 24 ]; then
  cat >&2 <<EOF

×  这台机器上的 node 是 ${NODE_MAJOR} 版($NODE_BIN),工作台要 24 或更新。
   (低于 24 不是"凑合能跑":通道层要 node 自己剥 TypeScript,而这条 node 还会被原样
    复制成 ~/.dsh/node 长期用下去。)

  brew install node@24
  echo 'export PATH="/opt/homebrew/opt/node@24/bin:\$PATH"' >> ~/.zprofile
  exec zsh -l

装好之后重新跑一次:bash deploy/bootstrap.sh
EOF
  exit 1
fi
info "node ${NODE_VERSION}($NODE_BIN)—— 够用。这一份稍后会被复制成 ~/.dsh/node。"

# ───────────────────────── 2. 装(六步) ─────────────────────────

say 2 "装:自有 node → DSH 运行环境 → profile → 工作台插件 → 启动脚本 → 开机自启项"
# 0925 升 DSH 0.1.7-rc.2:锁定清单里实测 521 个包(0.1.2 那会儿两百来个)。
# 那一步先装进 `runtime-next`、核过关键包版本再换成 `runtime`,所以断在半路也不会留下一个
# 起不来的 runtime,照原样再跑一遍就接着装(下过的包在 npm 缓存里)——见 setup/install.ts。
info "(装的是登录台「一键装」用的同一套步骤;运行环境那步要联网下五百来个包,几分钟很正常)"

BOOTSTRAP_ARGS=(--repo "$REPO_ROOT" --home "$HOME")
[ -n "${DSH_HOME:-}" ] && BOOTSTRAP_ARGS+=(--dsh-home "$DSH_HOME")
[ -n "$STEPS" ] && BOOTSTRAP_ARGS+=(--steps "$STEPS")
[ "$NO_LAUNCH" = "1" ] && BOOTSTRAP_ARGS+=(--no-launch)

if ! "$NODE_BIN" "$REPO_ROOT/workbench-plugin/scripts/bootstrap.ts" "${BOOTSTRAP_ARGS[@]}"; then
  die "装到一半停下了(上面写了是哪一步、为什么)。修完照原样再跑一遍就行 —— 每一步都是幂等的。"
fi

if [ "$NO_LAUNCH" = "1" ]; then
  cat <<EOF

✓  装完了(--no-launch:没起服务)。装出来的东西在:
     ${DSH_HOME:-$HOME/.dsh}/{node,runtime,profiles/web,bin,packages}
     $HOME/Library/LaunchAgents/ai.deepseek.dsh.plist   (写了,但没装载)

去掉 --no-launch 再跑一次,就会把 DSH 起起来并打开初始化页。
EOF
  exit 0
fi

# ───────────────────────── 3. 起 DSH ─────────────────────────

say 3 "起 DSH"
UID_NUM="$(id -u)"
PLIST="$HOME/Library/LaunchAgents/ai.deepseek.dsh.plist"
# 上一步已经 `launchctl bootstrap` 过一次(幂等)。这里再 kickstart 一下,是为了让**重复跑**
# 这条命令时,跑着的那一份确实是刚装进去的插件,而不是上一轮的旧进程。
launchctl bootstrap "gui/$UID_NUM" "$PLIST" 2>/dev/null || true
if ! launchctl kickstart -k "gui/$UID_NUM/ai.deepseek.dsh" 2>/dev/null; then
  die "起不来。看一眼 ${DSH_HOME:-$HOME/.dsh}/logs/web.stderr.log 的最后几行,还有 \`launchctl print gui/$UID_NUM/ai.deepseek.dsh\`。"
fi
info "已经让 launchd 把它拉起来了。"

# ───────────────────────── 4. 等 8791 ─────────────────────────

say 4 "等工作台服务(${WORKBENCH_PORT})起来"
info "冷机第一次要 20 秒以上,最多等 3 分钟。"

UP=0
for _ in $(seq 1 90); do
  CODE="$(curl -s -o /dev/null -m 2 -w '%{http_code}' "http://127.0.0.1:${WORKBENCH_PORT}/state" 2>/dev/null || true)"
  if [ -n "$CODE" ] && [ "$CODE" != "000" ]; then UP=1; break; fi
  sleep 2
done
if [ "$UP" != "1" ]; then
  cat >&2 <<EOF

×  等了 3 分钟,${WORKBENCH_PORT} 还是没起来。按顺序看这三处:

  tail -30 ${DSH_HOME:-$HOME/.dsh}/logs/web.stderr.log
  tail -30 ${DSH_HOME:-$HOME/.dsh}/logs/web.stdout.log
  launchctl print gui/$UID_NUM/ai.deepseek.dsh | head -40

最常见的两种:自有 node 跑不起来(日志里是 dyld 的报错),
或者插件没装进 profile(日志里找不到 "@ben/dsh-workbench")。
EOF
  exit 1
fi
info "起来了。"

# ───────────────────────── 5. 取那条带 token 的地址 ─────────────────────────

say 5 "从日志里取那条带 token 的地址"
info "(DSH 0.1.2-rc.1 起网页要 token 或签名 cookie 才开得了;开一次就会种下 cookie,以后不用再带)"

SETUP_URL=""
for _ in $(seq 1 15); do
  if SETUP_URL="$("$NODE_BIN" "$REPO_ROOT/workbench-plugin/scripts/bootstrap.ts" --repo "$REPO_ROOT" --home "$HOME" ${DSH_HOME:+--dsh-home "$DSH_HOME"} --print-url 2>/dev/null)"; then
    break
  fi
  SETUP_URL=""
  sleep 2
done
if [ -z "$SETUP_URL" ]; then
  "$NODE_BIN" "$REPO_ROOT/workbench-plugin/scripts/bootstrap.ts" --repo "$REPO_ROOT" --home "$HOME" ${DSH_HOME:+--dsh-home "$DSH_HOME"} --print-url >/dev/null || true
  die "日志里还没有那条地址。跑一次 \`launchctl kickstart -k gui/$UID_NUM/ai.deepseek.dsh\`,等 20 秒再重来。"
fi

# ───────────────────────── 6. 打开初始化页 ─────────────────────────

say 6 "打开初始化页"
if [ "$NO_OPEN" = "1" ]; then
  info "(--no-open:不替你开了)"
else
  open "$SETUP_URL" || info "open 没成功,自己把下面这个地址贴进浏览器。"
fi

cat <<EOF

✓  到这儿为止的都装好了,初始化页应该已经开着了。地址(带钥匙,别往外发):

     $SETUP_URL

先做这一件(只做一次,一分钟):

     bash deploy/codesign-identity.sh

  它在你的登录钥匙串里建一张长期的自签代码签名证书「工作台本机签名」,之后每次构建壳
  都用它签。签名身份不变,macOS 就认得这还是同一个 App,**辅助功能授权跨更新保留**。
  不做的话壳只能 ad-hoc 签名,每重建一次授权就掉一次,得去系统设置里关一次再开。

下一步:**在初始化页里装壳并授权辅助功能。**

  壳(工作台.app)故意不在这条命令里装 —— 装完要人去系统设置里点一次辅助功能授权
  (第一次装无论如何都要点),挑个你手边方便的时候,在初始化页第 1 步里点那一颗。

页面上还等着你的几件(程序做不了的):
  · 第 3 步 系统授权:辅助功能 / 文稿文件夹 / 日历
  · 第 4 步 DeepSeek 的 key,以及 Claude 的四个 hook(护栏不让程序动 ~/.claude)
  · 第 8 步 手机端(不想用手机就点"先跳过")
  · 第 9 步 把 Time Machine 打开
EOF
