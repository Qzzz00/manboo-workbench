#!/usr/bin/env bash
#
# 把这个包里 `源码/` 的改动构建出来、装进你电脑上的工作台(2026-10-02)。
#
#     bash 构建并装上.sh
#
# 它做什么(按顺序):
#   1. 体检(工作台装没装、自带的 node 在不在),第一次用的时候把依赖解开
#   2. 构建插件(与维护者那边发版用的是同一条命令)
#   3. **先把你现在装着的那一份备份下来**,再装新的
#   4. 核一遍装进去的确实是刚构建出来的那一份;对不上、或者哪一步失败,**自动放回上一版**
#   5. 提醒你重启工作台
#
# 它**不碰**:你的凭据、你的记忆与偏好、工作台的数据目录、/Applications 里的那个「工作台」。
# 只动三处:`~/.dsh/packages/plugin.tgz`、`~/.dsh/profiles/web`(插件装在这儿)、以及备份目录。
#
# 装坏了怎么退回去:`bash 回滚.sh`(它会用这一步留下的备份)。
#
# 参数:
#   --target <目录>   装到别的地方去(默认 ~/.dsh)。**只给维护者自测用**,你不用管。

source "$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)/_公共.sh"

if [ -n "${KIT_WANT_HELP:-}" ]; then
  sed -n '2,/^source /p' "${BASH_SOURCE[0]}" | sed '$d' | sed 's/^# \{0,1\}//'
  exit 0
fi

# ───────────────────────── 1. 体检 ─────────────────────────

say "先看一眼手边有什么"
need_node
info "node:$("$NODE" -v)($NODE)"
[ -d "$SRC" ] || die "包里没有源码目录($SRC)—— 这个包是坏的,跟维护者再要一份。"
[ -d "$DSH/profiles/web" ] || die "找不到工作台的 profile($DSH/profiles/web)。
     这台机器上没装过工作台,或者装在别处 —— 先把工作台装好再用这个包。"
DSH_CLI="$DSH/runtime/node_modules/@deepseek-ai/dsh/lib/bin.js"
[ -f "$DSH_CLI" ] || die "找不到工作台的运行环境($DSH_CLI)。先在工作台的设置里跑一遍「体检」。"
VERSION="$("$NODE" -p "require('$SRC/package.json').version")"
info "要装的插件版本:$VERSION(基线 $(kit_field 版本))"

need_deps

# ───────────────────────── 2. 构建 ─────────────────────────

say "构建插件"
# 两步都与仓库里 `pnpm build` 那一条逐字相同(workbench-plugin/package.json 的 build):
#   node scripts/gen-bundled-skills.mjs && tsdown && node scripts/copy-starter-layer.mjs
# 这里直接点名 node 与 node_modules/.bin/tsdown —— 你机器上没有 pnpm,也不需要有。
( cd "$SRC" && PATH="$(kit_path)" "$NODE" scripts/gen-bundled-skills.mjs ) \
  || die "第一步(把技能文档打进插件)没跑成。上面是它的输出。"
# tsdown / vitest / tsc 在 `node_modules/.bin/` 里是 **pnpm 生成的 shell 小壳子**(不是 .js),
# 所以要**直接执行**它、靠 PATH 让它自己找到 node —— `node node_modules/.bin/tsdown` 会当场语法错。
( cd "$SRC" && PATH="$(kit_path)" node_modules/.bin/tsdown ) \
  || die "构建失败。上面是它的输出 —— 一般是源码里有写错的地方,改完再跑一次。"
( cd "$SRC" && PATH="$(kit_path)" "$NODE" scripts/copy-starter-layer.mjs ) \
  || die "最后一步(把起步层拷进插件)没跑成。上面是它的输出。"
for f in lib/index.js lib/client.js; do
  [ -s "$SRC/$f" ] || die "构建跑完了,但没出 $f。把上面的输出发给维护者。"
done
info "构建好了:lib/index.js($(du -h "$SRC/lib/index.js" | cut -f1))、lib/client.js($(du -h "$SRC/lib/client.js" | cut -f1))"

say "打成一个包"
PACK_DIR="$(mktemp -d)"
trap 'rm -rf "$PACK_DIR"' EXIT
# npm pack 平时会印一大段 notice(文件清单、"有新版 npm 了"),对她毫无意义 ——
# 收进日志,**只在失败时**原样印出来。
( cd "$SRC" && PATH="$(kit_path)" "$NPM" pack --pack-destination "$PACK_DIR" >"$PACK_DIR/pack.log" 2>&1 ) \
  || { sed 's/^/    /' "$PACK_DIR/pack.log" >&2; die "打包失败(上面是它的输出)。"; }
TGZ="$(ls "$PACK_DIR"/*.tgz 2>/dev/null | head -1)"
[ -n "$TGZ" ] || die "打包命令跑完了,但没出 .tgz。"
info "$(basename "$TGZ")($(du -h "$TGZ" | cut -f1))"

# ───────────────────── 3. 先备份,再装 ─────────────────────

say "把你现在装着的那一份备份下来"
BK="$(backup_root)/$(date +%Y%m%d-%H%M%S)"
mkdir -p "$BK"
OLD_REAL="$(installed_plugin_real || true)"
if [ -n "$OLD_REAL" ]; then
  ditto "$OLD_REAL" "$BK/已装着的插件"
  printf '%s\n' "$OLD_REAL" > "$BK/插件真实路径.txt"
  OLD_VERSION="$("$NODE" -p "require('$OLD_REAL/package.json').version" 2>/dev/null || echo '(读不出来)')"
  info "现在装着的是 $OLD_VERSION,已复制进 $BK/已装着的插件"
else
  die "profile 里还没有装过工作台插件($DSH/profiles/web/node_modules/@ben/dsh-workbench)。
     这个包是用来**改**一个已经在用的工作台的,不是用来第一次安装的。把这句话发给维护者。"
fi
cp "$DSH/profiles/web/package.json" "$BK/profile-package.json"
if [ -f "$DSH/profiles/web/pnpm-lock.yaml" ]; then cp "$DSH/profiles/web/pnpm-lock.yaml" "$BK/profile-pnpm-lock.yaml"; fi
if [ -f "$DSH/packages/plugin.tgz" ]; then cp "$DSH/packages/plugin.tgz" "$BK/plugin.tgz"; fi
printf '基线版本:%s\n基线提交:%s\n装之前是:%s\n时间:%s\n' \
  "$(kit_field 版本)" "$(kit_field 提交)" "${OLD_VERSION:-}" "$(date '+%Y-%m-%d %H:%M:%S')" > "$BK/记录.txt"
info "备份都在:$BK"

say "装进工作台"
# **装法与工作台自己更新时走的那条路完全一样**(workbench-plugin/src/server/setup/install.ts
# 的 plugin 那一步):把 .tgz 放到 ~/.dsh/packages/plugin.tgz,再让工作台自带的 dsh
# 把它装进 profile。不另发明第二种装法 —— 否则下次热更新与这次装的会打起来。
mkdir -p "$DSH/packages"
cp "$TGZ" "$DSH/packages/plugin.tgz"
info "已放到 $DSH/packages/plugin.tgz"

# 这一步**要联网**:它转手给 pnpm,pnpm 要去 registry 取这个插件的 peer 依赖。
# 官方源不通就换国内镜像再试一次 —— 与 install.ts 里同一个口径。
NPM_MIRROR='https://registry.npmmirror.com'
ADD=("$NODE" "$DSH_CLI" plugin --profile web add "$DSH/packages/plugin.tgz")
info "$ ${ADD[*]}"
if ! ( cd "$DSH/packages" && DSH_HOME="$DSH" PATH="$(kit_path)" "${ADD[@]}" ); then
  info "官方源这一趟没成,换国内镜像再试一次"
  if ! ( cd "$DSH/packages" && DSH_HOME="$DSH" PATH="$(kit_path)" "${ADD[@]}" "--registry=$NPM_MIRROR" ); then
    restore_backup "$BK"
    die "装不进去(官方源与国内镜像都没成)。已经把上一版放回去了,工作台照常能用。
     最常见的原因是这会儿网不通 —— 连上网再跑一次。还不行就把上面的输出发给维护者。"
  fi
fi

# ───────────────── 4. 核一遍,对不上就放回去 ─────────────────

say "核一遍装进去的是不是刚构建出来的那一份"
NEW_REAL="$(installed_plugin_real || true)"
if [ -z "$NEW_REAL" ]; then
  restore_backup "$BK"
  die "装完之后 profile 里找不到插件目录了。已经把上一版放回去了。把上面的输出发给维护者。"
fi
want="$(shasum -a 256 "$SRC/lib/client.js" | awk '{print $1}')"
got="$(shasum -a 256 "$NEW_REAL/lib/client.js" 2>/dev/null | awk '{print $1}')"
if [ "$want" != "$got" ]; then
  restore_backup "$BK"
  die "装进去的那一份与刚构建出来的对不上(client.js 的 sha256 不一样)。已经把上一版放回去了。
     把这句话原样发给维护者:want=$want got=${got:-(读不出来)} real=$NEW_REAL"
fi
info "对上了(client.js sha256 ${want:0:12}…)"
info "装在:$NEW_REAL"

printf '\n✓  装好了:插件 %s\n' "$VERSION"
restart_hint
info "要退回上一版:bash 回滚.sh"
info "改动要发给维护者:bash 导出我的改动.sh"
printf '\n'
