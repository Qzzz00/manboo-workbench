#!/usr/bin/env bash
#
# 源码包里三个脚本共用的那几件事(2026-10-02,卡「给用户的源码包」)。
# 它自己不做任何事,由另外三个脚本 `source` 进去。
#
# 为什么要有它:运营同学那台机器上**没有 git、没有 node、没有 pnpm**,
# 唯一能用的 node 是工作台自己带的那一份(`~/.dsh/node/bin/node`)。
# 三个脚本都要先把这件事摆平,摆平的方式只能有一份。

set -euo pipefail

# ── 这个包在哪 ──────────────────────────────────────────────
# 三个脚本都躺在包的最外层,所以包根就是脚本所在的目录。
KIT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
# `源码/` 是**仓库根的样子**(不是直接就是插件目录)—— 插件的构建脚本与测试里有一批
# `../../docs/技能`、`../../deepseek-harness/...` 这样的相对路径,摆成仓库的样子它们才找得到。
REPO="$KIT/源码"
SRC="$REPO/workbench-plugin"

# ── 装到哪(默认真的工作台;自测用 --target 指一个假的) ────
DSH="$HOME/.dsh"
POSITIONAL=()
while [ $# -gt 0 ]; do
  case "$1" in
    --target) shift; DSH="${1:-}" ;;
    --help|-h) KIT_WANT_HELP=1 ;;
    *) POSITIONAL+=("$1") ;;
  esac
  shift
done

say() { printf '\n▸ %s\n' "$1"; }
info() { printf '  %s\n' "$1"; }
die() { printf '\n×  %s\n' "$1" >&2; exit 1; }

NODE="$DSH/node/bin/node"
NPM="$DSH/node/bin/npm"
# 跑在 ~/.dsh 上下文里的命令要的环境,与工作台自己装插件时用的那一份口径相同
# (workbench-plugin/src/server/setup/install.ts 的 `dshEnv`):
# PATH 第一段是自带 node 的 bin —— **自带的 pnpm 那个小脚本也在那儿**,
# `dsh plugin add` 转手给 pnpm 时找到的就是它,与这台机器上有没有 Homebrew 无关。
kit_path() { printf '%s' "$DSH/node/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"; }

# 工作台自带的那条 node 在不在。没有就是「这台机器上没装过工作台」,别往下走。
need_node() {
  [ -x "$NODE" ] || die "找不到工作台自带的 node($NODE)。
     这个脚本不需要你自己装 node —— 它用的就是工作台装好的那一份。
     找不到它说明这台机器上没装过工作台,或者装在别处。把这句话发给维护者。"
}

# 依赖(node_modules)在不在。包里带的是一个 .tgz,第一次用的时候解开 —— 这样
# 她不用联网装依赖(她那台机器装不动),而 zip 里也不必塞一万个小文件。
need_deps() {
  if [ -d "$SRC/node_modules" ]; then return 0; fi
  [ -f "$KIT/node_modules.tgz" ] || die "包里既没有 $SRC/node_modules,也没有 node_modules.tgz —— 这个包是坏的,跟维护者再要一份。"
  say "第一次用:把依赖解开(就这一次,大概一两分钟)"
  tar -xzf "$KIT/node_modules.tgz" -C "$SRC"
  [ -d "$SRC/node_modules" ] || die "依赖没解开(tar 跑完了但 $SRC/node_modules 还是没有)。"
  info "依赖已就位:$SRC/node_modules"
}

# 这个包是从哪一版、哪个提交打出来的(导出改动与统筹那边落地都认这一条)。
kit_info() {
  [ -f "$KIT/包信息.json" ] || die "包里没有 包信息.json —— 这个包是坏的,跟维护者再要一份。"
  printf '%s' "$KIT/包信息.json"
}
kit_field() {
  need_node
  "$NODE" -e '
    const fs = require("node:fs")
    const info = JSON.parse(fs.readFileSync(process.argv[1], "utf8"))
    process.stdout.write(String(info[process.argv[2]] ?? ""))
  ' "$(kit_info)" "$1"
}

# 备份都放在这儿(一次一个时刻目录,**只加不删**)。
backup_root() { printf '%s' "$HOME/工作台源码包备份"; }

# profile 里那个插件目录真正落在哪(它是个指向 .pnpm/… 的符号链接)。
installed_plugin_real() {
  local link="$DSH/profiles/web/node_modules/@ben/dsh-workbench"
  [ -e "$link" ] || return 1
  (cd "$link" && pwd -P)
}

# 把一份备份原样放回去。**完全不联网**:直接把当时那几个文件写回 profile。
#
# 为什么不是「把旧 .tgz 再 add 一遍」:`dsh plugin add` 要联网取 peer 依赖,
# 而回滚这件事恰恰常常发生在装不上的时候(网断了、源不通)。所以回滚走文件级。
restore_backup() {
  local bk="$1"
  [ -d "$bk" ] || die "没有这个备份目录:$bk"
  [ -d "$bk/已装着的插件" ] || die "$bk 里没有「已装着的插件」—— 这份备份不完整,别用它回滚。"

  local real
  real="$(installed_plugin_real || true)"
  if [ -z "$real" ] && [ -f "$bk/插件真实路径.txt" ]; then real="$(cat "$bk/插件真实路径.txt")"; fi
  [ -n "$real" ] || die "找不到 profile 里那个插件目录,回不去。把这句话发给维护者。"
  # 护栏:只许动 profile 的 node_modules 底下那一处。这个函数会 rm -rf,写错一个路径就是真删。
  case "$real" in
    "$DSH/profiles/web/node_modules/"*) ;;
    *) die "插件目录算出来在 $real —— 不在 profile 的 node_modules 底下,不敢动。把这句话发给维护者。" ;;
  esac

  say "把上一版放回去"
  # 先 rm 再写:pnpm 装进来的文件可能与全局仓库是**硬链接**,直接覆盖会改到仓库里那一份。
  rm -rf "$real"
  mkdir -p "$real"
  ditto "$bk/已装着的插件" "$real"
  info "插件已放回:$real"

  if [ -f "$bk/profile-package.json" ]; then
    cp "$bk/profile-package.json" "$DSH/profiles/web/package.json"
    info "profile 的 package.json 已放回"
  fi
  if [ -f "$bk/profile-pnpm-lock.yaml" ]; then
    cp "$bk/profile-pnpm-lock.yaml" "$DSH/profiles/web/pnpm-lock.yaml"
    info "profile 的 pnpm-lock.yaml 已放回"
  fi
  if [ -f "$bk/plugin.tgz" ]; then
    mkdir -p "$DSH/packages"
    cp "$bk/plugin.tgz" "$DSH/packages/plugin.tgz"
    info "~/.dsh/packages/plugin.tgz 已放回"
  fi
}

restart_hint() {
  printf '\n'
  info "最后一步要你自己点:**把工作台重启一下**(设置 → 重启工作台,或者把「工作台」退出再打开)。"
  info "不重启的话,界面上还是旧的那一份。"
}
