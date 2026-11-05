#!/usr/bin/env bash
#
# 打一个**给用户的源码包**(2026-10-02,维护者:「现在她那边需要源码就给她,
# 她电脑上没有 git,不会推送,做完统一我们整理上报」)。
#
#     bash deploy/make-source-kit.sh 0.4.85
#
# 产出 `dist/工作台源码包-<版本>.zip`。给谁、为什么要它:
#
# 运营同学那台 Mac 上有 Codex,**没有 git、没有 node、不会命令行**。10-02 之前她让 Codex
# 直接改安装目录里的构建产物(`~/.dsh/profiles/web/node_modules/@ben/dsh-workbench/lib/*.js`)
# —— 改一次,下一次热更新就原样覆盖掉,而且那份改动谁也合不回来。
# 这个包是那件事的正经做法:她的 Codex 改**源码**,在她机器上构建并装上,
# 再把改动导出成一个 zip 发回来,由统筹在仓库里落地、跑全套、发版。
#
# ## 包里有什么
#
#   源码/                 git archive 当前提交(**不带 .git**),摆成**仓库根的样子**
#                         (插件的构建脚本与测试里有一批 `../../docs/技能`、
#                          `../../deepseek-harness/…` 的相对路径,摆成这样它们才找得到)
#   deepseek-harness/     上游 DSH 的源码子集(node_modules/@deepseek-ai/* 那十个 link: 依赖
#                         指向的就是它;测试解析类型要用)
#   node_modules.tgz      **预装好的依赖**。她那台机器装不动(没网、没 pnpm),而同为
#                         macOS arm64,这边装好的直接能用。第一次跑脚本时自动解开。
#   基线源码.tgz          打包这一刻的源码快照 —— `导出我的改动.sh` 拿它逐文件比
#   包信息.json           版本 / 提交 / 打包时间(统筹那边 apply-user-changes.sh 按它落地)
#   给Codex的说明.md      边界、怎么改、怎么测、怎么交付
#   构建并装上.sh / 跑测试.sh / 导出我的改动.sh / 回滚.sh / _公共.sh
#
# 那几个脚本的源头是 `deploy/source-kit/`(进 git,能 review),这里只是原样拷进包。
#
# ## 不含任何凭据
#
# `源码/` 整个来自 `git archive`(只有 git 跟踪的文件,`.env` / `credentials` 之类
# 本来就在 .gitignore 里);打完还按文件名与内容扫一遍(见「体检」那一段),扫到就不出包。
#
# ## 参数
#
#   <版本>              必填。包名用它(一般就是 workbench-plugin/package.json 的 version)。
#   --out <目录>        默认 <仓库根>/dist
#   --node-modules <目录>  预装依赖从哪拷。默认 <仓库根>/workbench-plugin/node_modules
#   --no-node-modules   不带依赖(只给看源码用;她那边没法构建)
#   --harness <目录>    上游 DSH 的 checkout 在哪。默认按 node_modules/@deepseek-ai/cordis
#                       那个符号链接算出来(那十个 link: 依赖指向的就是它)。
#
# 产物**不进 git**(dist/ 在 .gitignore 里),这个脚本进 git。

set -euo pipefail

REPO_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
VERSION=""
OUT="$REPO_ROOT/dist"
NM_SRC=""
HARNESS_DIR=""
WITH_NM=1

while [ $# -gt 0 ]; do
  case "$1" in
    --out) shift; OUT="${1:-}" ;;
    --node-modules) shift; NM_SRC="${1:-}" ;;
    --harness) shift; HARNESS_DIR="${1:-}" ;;
    --no-node-modules) WITH_NM=0 ;;
    --help|-h) sed -n "2,$(($(awk '/^set -euo/{print NR; exit}' "${BASH_SOURCE[0]}") - 1))p" "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
    -*) echo "不认识的参数:$1(--help 看能用的)" >&2; exit 1 ;;
    *) VERSION="$1" ;;
  esac
  shift
done

say() { printf '\n▸ %s\n' "$1"; }
info() { printf '  %s\n' "$1"; }
die() { printf '\n×  %s\n' "$1" >&2; exit 1; }

# ───────────────────────── 体检 ─────────────────────────

say "看一眼手边的工具"
for tool in git node tar ditto rsync shasum; do
  command -v "$tool" >/dev/null 2>&1 || die "缺 $tool。"
done

[ -n "$VERSION" ] || die "要哪个版本?bash deploy/make-source-kit.sh 0.4.85"
case "$VERSION" in
  [0-9]*) ;;
  *) die "版本号看着不对:$VERSION(要以数字开头)" ;;
esac
PKG_VERSION="$(node -p "require('$REPO_ROOT/workbench-plugin/package.json').version")"
[ "$VERSION" = "$PKG_VERSION" ] || info "! 包名写的是 $VERSION,而 workbench-plugin/package.json 里是 $PKG_VERSION —— 确认一下是有意的。"

COMMIT="$(git -C "$REPO_ROOT" rev-parse HEAD)"
BRANCH="$(git -C "$REPO_ROOT" rev-parse --abbrev-ref HEAD)"
if [ -n "$(git -C "$REPO_ROOT" status --porcelain)" ]; then
  die "工作树不干净 —— 包里的源码来自 \`git archive HEAD\`,没提交的改动不会进包,
     而包信息.json 会说「基线是 ${COMMIT}」,两边对不上。先提交(或者 git stash)再打包。"
fi
info "基线:$COMMIT($BRANCH)"

if [ "$WITH_NM" = "1" ]; then
  [ -n "$NM_SRC" ] || NM_SRC="$REPO_ROOT/workbench-plugin/node_modules"
  [ -d "$NM_SRC" ] || die "找不到预装依赖($NM_SRC)。先 cd workbench-plugin && pnpm install,或者 --no-node-modules。"
  [ -x "$NM_SRC/.bin/tsdown" ] || die "$NM_SRC 里没有 .bin/tsdown —— 依赖没装全,她那边构建不了。先 pnpm install。"
  [ -x "$NM_SRC/.bin/vitest" ] || die "$NM_SRC 里没有 .bin/vitest —— 依赖没装全,她那边跑不了测试。先 pnpm install。"
fi

# ───────────────────── 包里带仓库的哪几样 ─────────────────────
#
# **不是整个仓库**:整个 `git archive HEAD` 是 325MB(展示台与手机端的 Live2D 资源占了大半),
# 而她要改的是插件。所以只带插件 + 插件真的会去读的那几处:
#
#   workbench-plugin            要改的东西
#   user-layer/起步             起步层(2026-10-21 起运营同学那六格在这里);构建时拷进 lib/starter-layer,用例也读它
#   AGENTS.md                   仓库的规矩(写代码之前要读)
#   docs/技能 docs/记忆         `scripts/gen-bundled-skills.mjs` 构建时读它们;她也可能要改技能正文
#   .dsh/skills                 同上(事务官自己的技能)
#   docs/设计-引导流程.md       有用例逐字比对它
#   docs/prototypes/swarm-v4    有用例比对它(0.6MB)
#   channel-worker/src          接缝对照用例要读(agentName.ts 之类)
#   butler-app/src display-client/src   同上
#   deploy butler-server/{server,launchd}  也有用例读它们(发版脚本的形状、事务官后端的接口、
#                               `update-dsh-start-e2e` 要把 launchd 的 plist 拷进假仓库)。
#                               两样都只有几百 KB。**在包里是只读参考** —— 说明里写明别跑 deploy 里的脚本。
#
# **故意不带**的:`docs/prototypes/workbench-visual`(23MB,只有一个用例)、
# `relay/`、`phone-bridge/`、`installer-app/`、`workbench-app/`、
# 展示台与手机端的资源(Live2D 那几百兆)。要改那些走维护者。
KIT_PATHS=(
  AGENTS.md
  README.md
  workbench-plugin
  user-layer/起步
  .dsh/skills
  docs/技能
  docs/记忆
  docs/设计-引导流程.md
  docs/prototypes/swarm-v4
  channel-worker/src
  butler-app/src
  display-client/src
  deploy
  butler-server/server
  butler-server/launchd
  butler-server/package.json
)

# `node_modules/@deepseek-ai/*` 那十个 link: 依赖指向的上游目录(相对 deepseek-harness 根)。
# 包里按**同样的相对位置**摆一份,于是那十个符号链接、vitest.config.ts 里的 alias、
# tsconfig 的解析三处都照原样生效 —— 不用在包里改任何一行配置。
#
# **`vendor` 整个带上**(1.9MB):`vendor/cordis` 的 `lib/index.js` 一上来就
# `import '@deepseek-ai/cosmokit'`,而那条路是 `vendor/cordis/node_modules/@deepseek-ai/cosmokit
# → ../../../cosmokit` —— 只带 `vendor/cordis` 的话这条链接就断了,所有用到 cordis 的用例
# 当场红在「Failed to resolve import @deepseek-ai/cosmokit」(2026-10-02 自测踩过)。
HARNESS_PATHS=(
  vendor
  packages/api/session-controller
  packages/api/workspace-controller
  packages/client/store
  packages/client/ui-layout
  packages/client/ui-renderer
  packages/client/ui-session
  packages/client/ui-sidebar
  packages/client/ui-slots
  packages/client/ui-workspace
)

KIT_NAME="工作台源码包-$VERSION"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
STAGE="$WORK/$KIT_NAME"
mkdir -p "$STAGE/源码"

# ───────────────────── 1. 源码(git archive) ─────────────────────

say "把源码放进去(git archive HEAD,不带 .git)"
git -C "$REPO_ROOT" archive HEAD -- "${KIT_PATHS[@]}" | tar -x -C "$STAGE/源码"
[ -f "$STAGE/源码/workbench-plugin/package.json" ] || die "源码没放进去(没看到 workbench-plugin/package.json)。"
info "源码:$(du -sh "$STAGE/源码" | cut -f1)"

# ───────────────────── 2. 上游子集 ─────────────────────

say "把上游 DSH 的源码子集放进去(只读参考 + 测试解析类型要用)"
# 上游仓库在哪:就按 `node_modules/@deepseek-ai/cordis` 那个符号链接指过去的地方算 ——
# 不写死路径,免得换了机器就不对。
HARNESS_LINK="${NM_SRC:-$REPO_ROOT/workbench-plugin/node_modules}/@deepseek-ai/cordis"
HARNESS="${HARNESS_DIR:-}"
if [ -z "$HARNESS" ] && [ -e "$HARNESS_LINK" ]; then
  # 先 `pwd -P` 拿到链接**真正**指到的地方(`cd 链接/../..` 是按字面退的,退回来还是 node_modules),
  # 再退两级:`vendor/cordis` → 上游仓库根。
  CORDIS_REAL="$(cd "$HARNESS_LINK" && pwd -P)"
  HARNESS="$(dirname "$(dirname "$CORDIS_REAL")")"
fi
if [ -z "$HARNESS" ] || [ ! -d "$HARNESS/packages/client/store" ]; then
  die "找不到上游 DSH 的 checkout(按 $HARNESS_LINK 算出来是 ${HARNESS:-(算不出来)})。
     那十个 link: 依赖都指向它,没有它她那边跑不了测试。先把 workbench-plugin 的依赖装好。"
fi
info "上游:$HARNESS"
for p in "${HARNESS_PATHS[@]}"; do
  [ -d "$HARNESS/$p" ] || die "上游里没有 $p —— 版本对不上?先确认 $HARNESS 是不是锁定的那一版。"
  mkdir -p "$STAGE/deepseek-harness/$(dirname "$p")"
  # **符号链接原样拷**(不加 -L):上游那几个包的 `node_modules/` 里全是相对链接,
  # 包里按同样的相对位置摆着,它们就照原样成立。指进 `node_modules/.pnpm/` 的那几条
  # 下面那一段单独补。`-aL` 会把 .pnpm 那一大片整个拉进来(1.4GB),所以不能用。
  rsync -a --exclude .git "$HARNESS/$p/" "$STAGE/deepseek-harness/$p/"
done
# 上游**根上**那几份配置也要带:它们那几个包的 `tsconfig.json` 里
# `extends: "../../../tsconfig.base.client.json"`,少了它 vite 转译就当场
# 「Tsconfig not found」(2026-10-02 自测踩过)。几 KB。
for f in tsconfig.base.json tsconfig.base.client.json tsconfig.json package.json; do
  if [ -f "$HARNESS/$f" ]; then cp "$HARNESS/$f" "$STAGE/deepseek-harness/$f"; fi
done

# ── 把链接能补的补上、补不动的剪掉 ──
#
# 上游那几个包的 `node_modules/` 里全是符号链接,指到三类地方:
#   ① 上游自己的另一个 workspace 包(`packages/…`)—— **带不动**:上游 packages 整棵
#      源码就 170MB,再加它们的依赖就是上游那 1.4GB 的 node_modules。剪掉。
#   ② `node_modules/.pnpm/<包>/…` 里的第三方包(react、zustand、immer、cosmokit 的那几样)
#      —— **真被链到的只有二十来个**,照链接找过去抄进来,再看抄进来的那几个又链到了谁,
#      直到不再有新的。
#   ③ 包里已经带着的东西(`vendor/…` 之间互相链)—— 原样成立,什么都不用做。
#
# 剪掉 ① 的后果说在明处:**凡是在运行时真去 import 上游 client 包的用例,她那边跑不起来**
# (`跑测试.sh` 与 给Codex的说明.md 都写了这一条)。那不是她改坏的,是这个包带不了
# 整个上游仓库。她只跑自己动过的那部分;全套由统筹在有完整 checkout 的机器上跑。
say "把上游那几条链接补齐(补不动的剪掉)"
PNPM_SRC="$HARNESS/node_modules/.pnpm"
[ -d "$PNPM_SRC" ] || die "上游里没有 node_modules/.pnpm($PNPM_SRC)—— 上游的依赖没装过?"
mkdir -p "$STAGE/deepseek-harness/node_modules/.pnpm"

cat > "$WORK/认链接.mjs" <<'MJS'
// 走一遍包里的上游子集,把每条符号链接分成三类(见上面脚本里的注释),
// 一行一条印出来:`PNPM <.pnpm 里那个目录名>` / `PRUNE <包里的绝对路径>`。
import { readdirSync, readlinkSync, existsSync, realpathSync, lstatSync } from 'node:fs'
import { join, dirname, resolve, sep } from 'node:path'
const [stageHarness, harness] = process.argv.slice(2)
const pnpmRoot = join(harness, 'node_modules', '.pnpm')
const under = (parent, child) => child === parent || child.startsWith(parent + sep)
const links = []
const walk = (dir) => {
  let entries
  try { entries = readdirSync(dir, { withFileTypes: true }) } catch { return }
  for (const e of entries) {
    const full = join(dir, e.name)
    if (e.isSymbolicLink()) { links.push(full); continue }
    if (e.isDirectory()) walk(full)
  }
}
walk(stageHarness)
const pnpm = new Set()
const prune = []
for (const link of links) {
  // 包里**已经成立**的链接(指到包里带着的东西)什么都不用做。
  if (existsSync(link)) continue
  // 断了的:照同一条相对路径在**上游**那边走一遍,看它本来指到哪。
  const rel = link.slice(stageHarness.length + 1)
  const origin = join(harness, rel)
  let real
  try { real = realpathSync(origin) } catch { prune.push(link); continue }
  if (under(pnpmRoot, real)) {
    pnpm.add(real.slice(pnpmRoot.length + 1).split(sep)[0])
    continue
  }
  prune.push(link)
}
for (const one of [...pnpm].sort()) console.log(`PNPM ${one}`)
for (const one of prune.sort()) console.log(`PRUNE ${one}`)
MJS

ROUND=0
while :; do
  ROUND=$((ROUND + 1))
  [ "$ROUND" -le 12 ] || die "补链接补了 12 轮还没收敛 —— 不对,先看看上游的依赖树。"
  node "$WORK/认链接.mjs" "$STAGE/deepseek-harness" "$HARNESS" > "$WORK/链接.txt"
  NEW=0
  while IFS= read -r one; do
    [ -n "$one" ] || continue
    if [ -d "$STAGE/deepseek-harness/node_modules/.pnpm/$one" ]; then continue; fi
    [ -d "$PNPM_SRC/$one" ] || die "上游 .pnpm 里没有 $one —— 上游的依赖树不完整?"
    rsync -a "$PNPM_SRC/$one/" "$STAGE/deepseek-harness/node_modules/.pnpm/$one/"
    NEW=$((NEW + 1))
  done <<EOF
$(sed -n 's/^PNPM //p' "$WORK/链接.txt")
EOF
  [ "$NEW" != "0" ] || break
  info "第 $ROUND 轮抄进来 $NEW 个第三方包"
done

N_PRUNE=0
while IFS= read -r one; do
  [ -n "$one" ] || continue
  rm -f "$one"
  N_PRUNE=$((N_PRUNE + 1))
done <<EOF
$(sed -n 's/^PRUNE //p' "$WORK/链接.txt")
EOF
info "剪掉 $N_PRUNE 条指向上游其它包的链接(带不动,见上面那段注释)"

# 剪完再核一遍:包里**一条断链都不许留** —— 留一条,她那边就是一个
# 「Failed to resolve import …」的假红,而她分不清是包的问题还是自己改坏了。
# (不走 `| head`:`set -o pipefail` 下 head 提前退出会给 find 一个 SIGPIPE,
#  整个脚本就 141 无声退出 —— 2026-10-02 自测在这儿卡了一轮。)
find "$STAGE/deepseek-harness" -type l ! -exec test -e {} \; -print 2>/dev/null > "$WORK/断链.txt" || true
N_BROKEN="$(grep -c . "$WORK/断链.txt" || true)"
if [ "$N_BROKEN" != "0" ]; then
  die "上游子集里还有 $N_BROKEN 条断掉的符号链接,不出包(前 20 条):
$(sed -n '1,20p' "$WORK/断链.txt" | sed "s|$STAGE/||;s|^|  |")"
fi
info "上游子集:$(du -sh "$STAGE/deepseek-harness" | cut -f1)(没有断链)"

# ───────────── 3. 基线快照(导出改动时拿它比) ─────────────

say "存一份基线快照(导出改动时逐文件比的就是它)"
tar -czf "$STAGE/基线源码.tgz" -C "$STAGE" 源码
info "基线源码.tgz($(du -h "$STAGE/基线源码.tgz" | cut -f1))"

# ───────────────────── 4. 预装好的依赖 ─────────────────────

if [ "$WITH_NM" = "1" ]; then
  say "把预装好的依赖打进去"
  NM_STAGE="$WORK/node_modules"
  # ① `--safe-links`:指到**传输范围之外**的符号链接整个丢掉 —— 也就是
  #    `@deepseek-ai/*` 那十个指向上游仓库的。pnpm 自己那一大片 `.pnpm/…` 之间的
  #    链接都在范围之内,原样保留(保留它们是必须的:pnpm 的布局就是靠它们)。
  rsync -a --safe-links "$NM_SRC/" "$NM_STAGE/"
  # ② 那十个重新摆上,**把仓库里那一条链接的字面值原样抄一遍**(不是自己拼一条)。
  #    仓库里写的是 `../../../../deepseek-harness/<路径>`:从
  #    `源码/workbench-plugin/node_modules/@deepseek-ai/` 往上四级正好是包根,
  #    而包里的上游子集就摆在包根的 `deepseek-harness/` 下 —— 于是这十条链接、
  #    `vitest.config.ts` 里的 alias、tsconfig 的解析三处都照原样成立,包里不用改一行配置。
  mkdir -p "$NM_STAGE/@deepseek-ai"
  N_LINK=0
  while IFS= read -r link; do
    [ -n "$link" ] || continue
    name="$(basename "$link")"
    value="$(readlink "$link")"
    case "$value" in
      ../../../../deepseek-harness/*) ;;
      *) die "仓库里 node_modules/@deepseek-ai/$name 指的是「$value」,不是
     ../../../../deepseek-harness/… 的样子 —— 包里的上游子集摆在 deepseek-harness/ 下,
     对不上。先确认上游 checkout 的位置(README「上游仓库」那一节)。" ;;
    esac
    rel="${value#../../../../deepseek-harness/}"
    [ -d "$STAGE/deepseek-harness/$rel" ] || die "包里没带 deepseek-harness/$rel,
     而 @deepseek-ai/$name 指着它 —— 把它加进脚本里 HARNESS_PATHS 那一份清单。"
    rm -rf "$NM_STAGE/@deepseek-ai/$name"
    ln -s "$value" "$NM_STAGE/@deepseek-ai/$name"
    N_LINK=$((N_LINK + 1))
  done <<EOF
$(find "$NM_SRC/@deepseek-ai" -maxdepth 1 -type l 2>/dev/null | sort)
EOF
  [ "$N_LINK" -ge 10 ] || die "只摆上了 $N_LINK 条 @deepseek-ai 链接(该有十条)—— $NM_SRC 的依赖没装全?"
  info "@deepseek-ai 那 $N_LINK 条链接已按仓库里的字面值重摆"
  # ③ 打成 tgz 而不是直接摆进 zip:zip 里那十几万个小文件解压要很久,而且
  #    Finder 的解压工具对符号链接的处理不如 tar 可靠 —— pnpm 的布局全靠符号链接。
  tar -czf "$STAGE/node_modules.tgz" -C "$NM_STAGE/.." node_modules
  info "node_modules.tgz($(du -h "$STAGE/node_modules.tgz" | cut -f1))"
  rm -rf "$NM_STAGE"
else
  info "(按 --no-node-modules,不带依赖 —— 她那边构建不了,只能看源码)"
fi

# ───────────────────── 5. 脚本与说明 ─────────────────────

say "放脚本与说明"
for f in 给Codex的说明.md _公共.sh 构建并装上.sh 跑测试.sh 导出我的改动.sh 回滚.sh; do
  src="$REPO_ROOT/deploy/source-kit/$f"
  [ -f "$src" ] || die "deploy/source-kit/ 里没有 $f。"
  cp "$src" "$STAGE/$f"
  case "$f" in *.sh) chmod 755 "$STAGE/$f" ;; esac
  info "$f"
done

NOW="$(date '+%Y-%m-%d %H:%M:%S')"
node -e '
  const fs = require("node:fs")
  const [out, 版本, 提交, 分支, 打包时间, 源码根] = process.argv.slice(1)
  fs.writeFileSync(out, JSON.stringify({ 版本, 提交, 分支, 打包时间, 源码根 }, null, 2) + "\n")
' "$STAGE/包信息.json" "$VERSION" "$COMMIT" "$BRANCH" "$NOW" "源码"
info "包信息.json(版本 $VERSION,提交 ${COMMIT:0:12},打包于 $NOW)"

# ───────────────── 6. 凭据体检(扫到就不出包) ─────────────────

say "扫一遍有没有凭据混进去"
# 只扫源码与说明(node_modules 是第三方包,它们自己的测试夹具里什么词都有)。
BAD=""
while IFS= read -r f; do
  [ -n "$f" ] || continue
  BAD="$BAD
  $f"
done <<EOF
$(find "$STAGE/源码" "$STAGE/deepseek-harness" \
    \( -name '.env' -o -name '.env.*' -o -name '*.pem' -o -name '*.p12' \
       -o -name 'credentials.json' -o -name 'credentials.yaml' -o -name 'credentials.yml' -o -name '.npmrc' \) \
    -type f 2>/dev/null)
EOF
if [ -n "$(printf '%s' "$BAD" | tr -d '[:space:]')" ]; then
  die "包里有看着像凭据的文件,不出包:$BAD"
fi
# 再按内容扫几个明确的样子(真 key 的形状,不是「key」这个词)。
#
# **跳过 tests/**:脱敏那几条规则自己的用例里本来就塞着一堆**假**钥匙
# (`tests/diag-redact.test.ts`、`tests/server-project-brief.test.ts` 的夹具),
# 那正是它们要测的东西 —— 把它们算成命中,这道扫描就永远是红的、于是没人再看它。
# 真凭据进不来的那道门是另一条:`源码/` 整个来自 `git archive`,只有 git 跟踪的文件。
HITS="$(find "$STAGE/源码" -type f -not -path '*/tests/*' -print0 2>/dev/null \
  | xargs -0 grep -IlE 'sk-[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{16}|_authToken *=|-----BEGIN [A-Z ]*PRIVATE KEY-----' 2>/dev/null || true)"
if [ -n "$HITS" ]; then
  die "源码里有看着像凭据的内容,不出包:
$(printf '%s' "$HITS" | sed 's/^/  /')"
fi
info "没扫到。"

# ───────────────────────── 7. 出包 ─────────────────────────

say "出包"
mkdir -p "$OUT"
ZIP="$OUT/$KIT_NAME.zip"
rm -f "$ZIP"
# ditto 而不是 zip:包里有符号链接与中文文件名,ditto 两样都稳。
# --keepParent 让 zip 解开之后最外层就是「工作台源码包-<版本>」这一个文件夹。
ditto -c -k --sequesterRsrc --keepParent "$STAGE" "$ZIP"

printf '\n✓  打好了:%s(%s)\n' "$ZIP" "$(du -h "$ZIP" | cut -f1)"
info "sha256:$(shasum -a 256 "$ZIP" | awk '{print $1}')"
info "基线:$COMMIT"
printf '\n   发给她:整个 zip 发过去,她解开之后在那个文件夹里跑 `bash 构建并装上.sh`。\n'
printf '   收回来:`bash deploy/apply-user-changes.sh <她发回来的 我的改动-*.zip>`。\n\n'
