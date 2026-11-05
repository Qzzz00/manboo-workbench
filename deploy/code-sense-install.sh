#!/usr/bin/env bash
#
# 「看懂代码结构」这件能力的装/卸/查(2026-09-27,卡 SE)。
#
#     bash deploy/code-sense-install.sh install
#     bash deploy/code-sense-install.sh status      # 一行 JSON
#     bash deploy/code-sense-install.sh uninstall
#
# ## 它装的是什么
#
# serena(oraios/serena)—— 一个 MCP 服务器,给写代码的那几家(Claude Code、Codex、事务官)
# 装上「按符号看代码」的眼睛:找定义、找引用、跨文件改名。评估见
# `docs/评估-open-hub与serena-2026-09-26.md`,这一版的设计见
# `docs/设计-看懂代码结构能力-2026-09-27.md`。
#
# ## 三条硬规矩(改这个脚本前先读)
#
# 1. **绝不碰系统环境**。不装 Homebrew、不动系统 Python、不写 PATH、不写 shell 配置文件。
#    uv 自己那一堆默认目录(`~/.local/bin`、`~/.cache/uv`、`~/.local/share/uv`)全部由
#    下面那组 `UV_*` 环境变量改道到 `$ROOT` 里;`UV_NO_MODIFY_PATH` 再兜一层。
#    装完 `rm -rf $ROOT` 就等于没装过 —— `uninstall` 做的就是这件事,加上由工作台把各家
#    配置里那一格摘掉。
# 2. **版本钉死 + sha256 校验**(AGENTS.md「C4 供应链把关」)。uv 的包与 serena 的版本号
#    都写死在下面;uv 的 sha256 钉在这个脚本里(不是跟着包一起下 —— 跟着下的只防传输损坏),
#    与 `setup/paths.ts` 里 node 那一份是同一个做法。serena 的 Python 依赖由 uv 按 PyPI
#    的哈希装。**升级当独立任务评估**,同 C3 对 DSH 的做法。
# 3. **GPL-3.0 边界**。serena 主体是 GPL-3.0-or-later。我们**只作为独立进程经 MCP 调用**,
#    不 import 它的代码、不把它的源码拷进本仓库、不进 `workbench-plugin` 的依赖。
#    这个脚本从 PyPI 下的是它的发行包,装在用户自己的目录里,不随我们的产物分发。
#
# ## 这件能力属于哪一层
#
# **研发闭环**,只装在**有源码仓库的机器**上(AGENTS.md 第一节:「改工作台自己」那条闭环
# 只在有源码仓库的机器上跑,是给维护者的)。所以它在热更新清单里是**可选的一格**
# (`--with code-sense`),不进默认那三样,也不在安装包里预装 —— 见设计文档第三节。
#
# ## 目录长什么样
#
#     ~/.dsh/code-sense/
#       uv/uv                解压出来的 uv(只此一份,不进 PATH)
#       python/              uv 管的 Python 3.13(UV_PYTHON_INSTALL_DIR)
#       tools/               serena 的虚拟环境(UV_TOOL_DIR)
#       bin/                 serena 的可执行入口(UV_TOOL_BIN_DIR)
#       cache/               uv 的下载缓存(UV_CACHE_DIR);装完就删,重装时重新下
#       serena-home/         serena 自己的家(它默认写 ~/.serena,这里改道过来)
#       run-mcp              各家 MCP 配置里唯一要写的那一条命令(下面生成)
#       installed.json       装了什么、哪个版本、什么时候装的。设置页读这一份
#
# 索引不在这里:serena 把每个项目的索引写在**那个项目自己的 `.serena/`** 下。
# 所以 `.gitignore` 要挡住它,见设计文档第六节。

set -euo pipefail

# ---- 钉死的版本(改这里 = 一次独立的升级评估)-------------------------------

UV_VERSION="0.12.19"
UV_TARBALL="uv-aarch64-apple-darwin.tar.gz"
# github.com/astral-sh/uv/releases/download/0.12.19/uv-aarch64-apple-darwin.tar.gz.sha256
# 2026-09-27 取,人工抄进来。换版本时这两行一起改。
UV_SHA256="a9a8df1eedeb192f2e47e40e2faabfb387db4b850209118786d42f89dde3e0ba"
UV_URLS=(
  "https://github.com/astral-sh/uv/releases/download/${UV_VERSION}/${UV_TARBALL}"
)

SERENA_SPEC="serena-agent==1.7.0"
PYTHON_VERSION="3.13"

# ---- 路径 -------------------------------------------------------------------

DSH_HOME="${DSH_HOME:-$HOME/.dsh}"
ROOT="${CODE_SENSE_ROOT:-$DSH_HOME/code-sense}"

UV_BIN="$ROOT/uv/uv"
RUN_MCP="$ROOT/run-mcp"
INSTALLED_JSON="$ROOT/installed.json"

# uv 的每一条默认路径都在这儿改道。少写一条就会往用户家目录里落东西。
uv_env() {
  export UV_CACHE_DIR="$ROOT/cache"
  export UV_PYTHON_INSTALL_DIR="$ROOT/python"
  export UV_TOOL_DIR="$ROOT/tools"
  export UV_TOOL_BIN_DIR="$ROOT/bin"
  # 少了这一条,`uv python install` 会往 `~/.local/bin/python3.13` 放一个软链
  # (2026-09-27 临时 HOME 实测踩到的;`UV_NO_MODIFY_PATH` 管不着它)。
  export UV_PYTHON_BIN_DIR="$ROOT/bin"
  export UV_PYTHON_PREFERENCE="only-managed"
  export UV_NO_MODIFY_PATH="1"
}

say() { printf '%s\n' "$*" >&2; }
die() { printf '%s\n' "$*" >&2; exit 1; }

# ---- install ----------------------------------------------------------------

fetch_uv() {
  mkdir -p "$ROOT/uv" "$ROOT/cache"
  local tgz="$ROOT/cache/$UV_TARBALL"
  if [ ! -f "$tgz" ]; then
    local ok=0 url
    for url in "${UV_URLS[@]}"; do
      say "下 uv $UV_VERSION:$url"
      if curl -fsSL --retry 2 -o "$tgz.part" "$url"; then mv "$tgz.part" "$tgz"; ok=1; break; fi
    done
    [ "$ok" = 1 ] || die "uv 下不下来(上面那几条源都试过了)。"
  fi
  local got
  got="$(shasum -a 256 "$tgz" | awk '{print $1}')"
  if [ "$got" != "$UV_SHA256" ]; then
    rm -f "$tgz"
    die "uv 的校验和对不上:期望 $UV_SHA256,实得 $got。已删掉,没有解压。"
  fi
  tar -xzf "$tgz" -C "$ROOT/uv" --strip-components 1
  [ -x "$UV_BIN" ] || die "解压完没看见 uv:$UV_BIN"
}

write_run_mcp() {
  # 各家 MCP 配置里只写这一条路径,后面跟一个 context 名字。好处:换 serena 版本、换目录结构、
  # 改启动参数,各家配置一个字都不用动。
  #
  # 参数逐条为什么(1.7.0 的 `serena start-mcp-server --help` 与它自带的 context/mode 逐条核过):
  #
  # - `$1` 是 **context**:1.7.0 **没有 `ide-assistant` 这个 context 了**,改成按家分
  #   (`claude-code` / `codex` / `ide` / `agent` …)。写死一个名字会在换版本时静默失效,
  #   所以由调用方给,`agentConfig.ts` 里每一家各自钉一个。
  # - `--add-mode no-memories`:**关掉它自带的记忆**。AGENTS.md「知识落仓库」那条硬规矩说
  #   项目知识只认 `docs/`;serena 的 memory 会往项目里另写一套,两套并存就是 9/4 之后
  #   最不想要的那种「结论不知道在哪」。这个 mode 同时把 onboarding 也关了(它依赖 memory)。
  # - `--enable-web-dashboard False` + `--open-web-dashboard False` + `--enable-gui-log-window False`:
  #   **关掉它那个自动弹的网页面板**(默认端口 24282,默认启动就弹)。工作台是
  #   「弹层让开窗位 + 布局快照」那一套,突然冒一个浏览器窗口会踩布局。
  # - `--project-from-cwd`:它自己写的「给 Claude Code / Codex 这类命令行 agent 用」——
  #   从当前目录往上找最近的 `.serena/project.yml` 或 `.git`;找不到就不激活任何项目。
  #   正好是我们要的:**没有源码仓库的机器上它什么也不做**,不会乱认一个目录。
  cat >"$RUN_MCP" <<RUNMCP
#!/usr/bin/env bash
# 工作台生成,别手改 —— 重装会覆盖。要改参数改 deploy/code-sense-install.sh。
set -euo pipefail
export UV_CACHE_DIR="$ROOT/cache"
export UV_PYTHON_INSTALL_DIR="$ROOT/python"
export UV_TOOL_DIR="$ROOT/tools"
export UV_TOOL_BIN_DIR="$ROOT/bin"
export UV_PYTHON_BIN_DIR="$ROOT/bin"
export UV_PYTHON_PREFERENCE="only-managed"
export UV_NO_MODIFY_PATH="1"
# serena 默认把配置与全局记忆写 ~/.serena。改道到我们自己的目录里,卸载时一起走。
export SERENA_HOME="$ROOT/serena-home"
context="\${1:-ide}"
exec "$ROOT/bin/serena" start-mcp-server \\
  --context "\$context" \\
  --add-mode no-memories \\
  --enable-web-dashboard False \\
  --open-web-dashboard False \\
  --enable-gui-log-window False \\
  --project-from-cwd \\
  --transport stdio
RUNMCP
  chmod +x "$RUN_MCP"
}

write_serena_config() {
  mkdir -p "$ROOT/serena-home"
  # serena 自己的全局配置。这里再钉一遍上面那几条 —— 命令行参数是第一道,配置文件是第二道,
  # 哪天它改了参数名,这一份还在。`record_tool_usage_stats` 关掉:不往外发任何东西。
  cat >"$ROOT/serena-home/serena_config.yml" <<'SERENACFG'
# 工作台生成(deploy/code-sense-install.sh),别手改 —— 重装会覆盖。
# 每一个键都出自 1.7.0 自带的 serena_config.template.yml(2026-09-27 逐条核过)。
# 命令行参数是第一道、这一份是第二道:哪天它改了参数名,这一份还在。
gui_log_window: False
web_dashboard: False
web_dashboard_open_on_launch: False
trace_lsp_communication: False
log_level: 20
# 索引与记忆写在**项目自己的 .serena/ 下**(它的默认)。为什么不挪到 ~/.dsh 里集中放:
# 那样要按目录名拼路径,而 worktree 一多就会重名撞车。代价是每个仓库里多一个目录,
# 由 .gitignore 挡住 —— 理由全文见 docs/设计-看懂代码结构能力-2026-09-27.md 第六节。
project_serena_folder_location: "$projectDir/.serena"
# **关掉它自带的记忆**(AGENTS.md「知识落仓库」:项目知识只认 docs/,两套记忆并存就是
# 9/4 之后最不想要的那种「结论不知道在哪」)。
# 为什么在这里关而不是只靠 `--add-mode no-memories`:mode 只把工具从 agent 的活动集里摘掉,
# **MCP 那一层照样把 23 个工具都报给模型**(2026-09-27 实测 tools/list);全局 excluded_tools
# 才是真的不注册。两道都留着 —— 命令行那道在 run-mcp 里。
excluded_tools:
  - write_memory
  - read_memory
  - delete_memory
  - edit_memory
  - rename_memory
  - list_memories
  - onboarding
# `projects` 这一条缺了它会直接报错(1.7.0 的 serena_config.py 明写),所以留一个空表。
projects: []
SERENACFG
}

write_installed_json() {
  # 只记「装了什么」这件事实。**大小不记在这儿** —— 它会随索引与语言服务变,
  # 记一个会过期的数字就是在骗设置页;`status` 每次现算。
  cat >"$INSTALLED_JSON" <<INSTALLED
{
  "component": "code-sense",
  "serena": "$SERENA_SPEC",
  "uv": "$UV_VERSION",
  "python": "$PYTHON_VERSION",
  "root": "$ROOT",
  "runMcp": "$RUN_MCP",
  "installedAt": "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
}
INSTALLED
}

do_install() {
  uv_env
  mkdir -p "$ROOT"
  [ -x "$UV_BIN" ] || fetch_uv
  say "装 Python $PYTHON_VERSION(只装进 $ROOT/python)…"
  "$UV_BIN" python install --no-bin "$PYTHON_VERSION"
  say "装 $SERENA_SPEC …"
  "$UV_BIN" tool install --force -p "$PYTHON_VERSION" "$SERENA_SPEC"
  write_serena_config
  write_run_mcp
  # 缓存只在装的那一趟有用(实测 100MB 上下)。留着纯占地方,重装时重新下就是。
  rm -rf "$ROOT/cache"
  write_installed_json
  say "装好了:$ROOT"
  do_status
}

# ---- status -----------------------------------------------------------------

do_status() {
  if [ ! -f "$INSTALLED_JSON" ]; then
    printf '{"installed":false,"root":"%s"}\n' "$ROOT"
    return 0
  fi
  # 不借道系统 python3:① 这台机器上有没有 python3 不该是这件事的前提;
  # ② 跑一次 /usr/bin/python3 会在 ~/Library/Caches/com.apple.python 下落东西
  # (2026-09-27 临时 HOME 实测),与「装完 rm -rf 就等于没装过」相冲。
  local bytes
  bytes="$(du -sk "$ROOT" 2>/dev/null | awk '{print $1*1024}')"
  # installed.json 是这个脚本自己写的,最后一行固定是 `}`。在它前面插两格。
  sed -e '$d' "$INSTALLED_JSON" \
    | sed -e '$s/$/,/' \
    && printf '  "bytes": %s,\n  "installed": true\n}\n' "${bytes:-0}"
}

# ---- uninstall --------------------------------------------------------------

do_uninstall() {
  if [ -d "$ROOT" ]; then
    rm -rf "$ROOT"
    say "删干净了:$ROOT"
  else
    say "本来就没装:$ROOT"
  fi
  say "各家配置里那一格由工作台摘(设置 → 看懂代码结构 → 卸载),或手动删名为 code-sense 的那条 MCP。"
}

case "${1:-status}" in
  install) do_install ;;
  status) do_status ;;
  uninstall) do_uninstall ;;
  *) die "用法:$0 install|status|uninstall" ;;
esac
