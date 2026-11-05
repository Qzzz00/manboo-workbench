#!/bin/bash
#
# 安装器的**第零段**:弄到一条 node,然后把活交给内核。
#
# 为什么非有这一段不可:内核是一份打包好的 JS(`kernel/install-from-bundle.mjs`),
# 要有 node 才跑得起来 —— 而双击安装包的那台机器上很可能一条 node 都没有。这是个鸡生蛋,
# 只能用每台 Mac 都自带的东西(bash + curl + tar + shasum)把第一条 node 弄进来。
#
# **这里没有任何"安装工作台"的逻辑**,只有"把 node 放到 ~/.dsh/node"这一件事,
# 而且落点、版本、校验和都与 `setup/paths.ts` 的 node 那一步**完全一致** ——
# 版本与 sha256 不是抄在这儿的,是构建安装包时从 paths.ts 生成到 node-source.env 里的
# (`deploy/build-installer.sh`)。所以这两处永远不可能对不上。
#
# 跑完这一段,内核那边的 node 那步会看到"已经有一份 v24,不用换"直接过。
#
# 用法(界面调的就是这条):
#   stage0.sh --resources <.app/Contents/Resources> [--json] [--home <家>] [--dsh-home <DSH 家>]
#
# 除 --json 外的参数原样转交内核。退出码:0 成功;1 参数/环境不对;2 装失败;3 node 弄不到。

set -uo pipefail

HERE="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
RESOURCES="${WORKBENCH_INSTALLER_RESOURCES:-$HERE}"
JSON=0
HOME_DIR="$HOME"
DSH_HOME_ARG=""
PASS_THROUGH=()

while [ $# -gt 0 ]; do
  case "$1" in
    --resources) shift; RESOURCES="${1:-}"; PASS_THROUGH+=(--resources "$RESOURCES") ;;
    --json) JSON=1; PASS_THROUGH+=(--json) ;;
    --home) shift; HOME_DIR="${1:-}"; PASS_THROUGH+=(--home "$HOME_DIR") ;;
    --dsh-home) shift; DSH_HOME_ARG="${1:-}"; PASS_THROUGH+=(--dsh-home "$DSH_HOME_ARG") ;;
    *) PASS_THROUGH+=("$1") ;;
  esac
  shift
done

DSH_HOME="${DSH_HOME_ARG:-${DSH_HOME:-$HOME_DIR/.dsh}}"
NODE_DIR="$DSH_HOME/node"
NODE_BIN="$NODE_DIR/bin/node"
DOWNLOAD_DIR="$DSH_HOME/node.download"

# ───────────────────────── 这一趟的日志写在哪(2026-09-27,卡 PN) ─────────────────────────
#
# **路径在这儿定、传给内核**(`WORKBENCH_INSTALL_LOG`):这一段先跑(下 node 那一截),
# 两边写同一个文件,一趟安装才是一份完整的日志。名字与 `installer.ts` 的
# `installLogPath` 逐字一致 —— 改一处要改两处,所以两边都写了这句话。
export WORKBENCH_INSTALL_LOG="${WORKBENCH_INSTALL_LOG:-$HOME_DIR/Library/Logs/工作台/安装-$(date +%Y%m%d-%H%M%S).log}"
mkdir -p "$(dirname "$WORKBENCH_INSTALL_LOG")" 2>/dev/null || true
# 写日志一律不许让安装失败(磁盘满、目录没权限):`|| true`。
logfile() { printf '%s\n' "$1" >> "$WORKBENCH_INSTALL_LOG" 2>/dev/null || true; }
logfile "=== 安装开始 $(date '+%Y-%m-%d %H:%M:%S') ==="
logfile "stage0:DSH_HOME=$DSH_HOME"

# ───────────────────────── 把话说给界面听 ─────────────────────────
#
# 事件格式与内核那一半**完全一样**(installer.ts 的 InstallerEvent),界面因此只有一个解析器。
# 这里的文本都是写死的中文常量,不含引号和反斜杠,所以手拼 JSON 是安全的
# —— 唯一会变的是 curl 的原始输出,那一路走 `log_line`,里面做了转义。

emit() {  # emit '<已经拼好的 JSON 体>'
  if [ "$JSON" = "1" ]; then printf '%s\n' "$1"; fi
}
say() {  # say <人话>
  logfile "· $1"
  if [ "$JSON" = "1" ]; then printf '{"t":"note","text":"%s"}\n' "$1"
  else printf '      %s\n' "$1"; fi
}
log_line() {  # log_line <原始输出的一行>
  logfile "$1"
  if [ "$JSON" = "1" ]; then
    # 反斜杠、引号、控制字符都得转掉,否则界面那边 JSON 解析会直接崩。
    printf '{"t":"log","text":"%s"}\n' "$(printf '%s' "$1" | LC_ALL=C sed -e 's/\\/\\\\/g' -e 's/"/\\"/g' -e 's/[[:cntrl:]]//g')"
  else printf '      | %s\n' "$1"; fi
}
fail() {  # fail <人话>
  logfile "× $1"
  if [ "$JSON" = "1" ]; then
    printf '{"t":"fail","key":"node","title":"正在准备运行环境…","error":"%s","tail":[],"optional":false}\n' "$1"
  else printf '\n×  %s\n' "$1" >&2; fi
  exit 3
}

# 日志在哪:**第一条事件**就说(界面把它记下来,出错那一屏要能给出这条路径)。
# 路径里没有引号和反斜杠以外的麻烦字符,但用户名是他自己起的,所以照 log_line 那样转一下。
emit "{\"t\":\"logfile\",\"path\":\"$(printf '%s' "$WORKBENCH_INSTALL_LOG" | LC_ALL=C sed -e 's/\\/\\\\/g' -e 's/"/\\"/g')\"}"

# ───────────────────────── 已经有一条够新的了吗 ─────────────────────────

node_major_of() {  # node_major_of <可执行文件> → 打出大版本号,跑不起来就什么都不打
  "$1" -p 'process.versions.node.split(".")[0]' 2>/dev/null
}

ENV_FILE="$RESOURCES/node-source.env"
if [ ! -f "$ENV_FILE" ]; then
  fail "安装包里少了 node-source.env,这份安装包是坏的。重新下一份。"
fi
# shellcheck source=/dev/null
. "$ENV_FILE"   # NODE_VERSION / NODE_TARBALL_NAME / NODE_SHA256 / NODE_URLS / MIN_NODE_MAJOR

MAJOR="$(node_major_of "$NODE_BIN" || true)"
if [ -n "${MAJOR:-}" ] && [ "$MAJOR" -ge "$MIN_NODE_MAJOR" ] 2>/dev/null; then
  say "运行环境已经有了,不用重新下"
  exec "$NODE_BIN" "$RESOURCES/kernel/install-from-bundle.mjs" "${PASS_THROUGH[@]}"
fi

# ───────────────────────── 下一个官方独立包 ─────────────────────────
#
# 为什么不"借用这台机器上已有的 node":`~/.dsh/node` 这一份是要**长期**跑工作台的,
# macOS 的文件夹授权认二进制 —— 借一条会自动更新的 node,等于把授权寿命交给
# 别人的发版节奏(0827 事故)。所以一律下官方独立包,锁死版本。

mkdir -p "$DOWNLOAD_DIR" || fail "建不了 $DOWNLOAD_DIR。磁盘满了,或者这个目录没有写权限。"
TGZ="$DOWNLOAD_DIR/$NODE_TARBALL_NAME"

download_from() {  # download_from <url> → 0 成功
  local url="$1" total="" size=0 pid pct
  say "正在下载运行环境(约 50MB):${url#https://}"
  total="$(curl -sIL --connect-timeout 20 "$url" 2>/dev/null | awk 'tolower($1)=="content-length:"{print $2}' | tr -d '\r' | tail -1)"
  curl -fL --retry 2 --retry-delay 2 --connect-timeout 20 -o "$TGZ" "$url" >/dev/null 2>"$DOWNLOAD_DIR/curl.err" &
  pid=$!
  # 百分比只有在拿得到 Content-Length 时才报。拿不到就不编 —— 界面那边会退回"来回走"的进度条。
  while kill -0 "$pid" 2>/dev/null; do
    if [ -n "$total" ] && [ "$total" -gt 0 ] 2>/dev/null && [ -f "$TGZ" ]; then
      size="$(/usr/bin/stat -f%z "$TGZ" 2>/dev/null || echo 0)"
      pct="$(awk -v a="$size" -v b="$total" 'BEGIN{printf "%.3f", (b>0? a/b : 0)}')"
      emit "{\"t\":\"progress\",\"pct\":$pct}"
    fi
    sleep 1
  done
  wait "$pid"
}

GOT=0
for URL in $NODE_URLS; do
  if download_from "$URL"; then GOT=1; break; fi
  while IFS= read -r line; do [ -n "$line" ] && log_line "$line"; done < "$DOWNLOAD_DIR/curl.err"
  say "这条源没下成,换下一条"
done
[ "$GOT" = "1" ] || fail "运行环境一条源都没下成。多半是这会儿没网,或者网络挡着。连上网之后点重试。"

# ───────────────────────── 核对 sha256 ─────────────────────────
#
# 钉在仓库里的那一份(paths.ts),不是跟着包一起下的那种 —— 跟着下的只防传输损坏。

say "正在核对安装包"
GOT_SHA="$(shasum -a 256 "$TGZ" 2>/dev/null | awk '{print $1}')"
if [ "$GOT_SHA" != "$NODE_SHA256" ]; then
  # 对不上的包一律不留,免得下次误以为已经下好了。**只删这个下载目录**,别处一个字节不动。
  rm -rf "$DOWNLOAD_DIR"
  fail "下下来的运行环境跟安装包里记着的校验和对不上。多半是下到一半断了。点重试会重新下一次。"
fi

say "正在解开运行环境"
mkdir -p "$NODE_DIR" || fail "建不了 $NODE_DIR。"
if ! tar -xzf "$TGZ" -C "$NODE_DIR" --strip-components=1 2>"$DOWNLOAD_DIR/tar.err"; then
  while IFS= read -r line; do [ -n "$line" ] && log_line "$line"; done < "$DOWNLOAD_DIR/tar.err"
  fail "运行环境解不开。磁盘满了?腾点空间再点重试。"
fi
rm -rf "$DOWNLOAD_DIR"

MAJOR="$(node_major_of "$NODE_BIN" || true)"
if [ -z "${MAJOR:-}" ] || [ "$MAJOR" -lt "$MIN_NODE_MAJOR" ] 2>/dev/null; then
  fail "运行环境装进去了,但跑不起来。这台 Mac 可能不是 Apple 芯片的(工作台只支持 Apple 芯片)。"
fi
say "运行环境装好了:v$NODE_VERSION"

exec "$NODE_BIN" "$RESOURCES/kernel/install-from-bundle.mjs" "${PASS_THROUGH[@]}"
