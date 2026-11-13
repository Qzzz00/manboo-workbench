#!/usr/bin/env bash
#
# 把「通话组件」(channel-worker)打成一份**能搬走、还能起得来**的包(2026-09-18,Ben:「好慢」)。
#
#     bash deploy/pack-channel-worker.sh --tar dist/channel-worker.tgz
#     bash deploy/pack-channel-worker.sh --tree /某处          # 摆出 /某处/channel-worker
#
# 发版(deploy/publish-update.sh)与出安装包(deploy/build-installer.sh)**共用这一份**。
# 以前两边各写一段 `rsync --exclude …` / `tar --exclude …`,改一处漏一处 —— 这个文件就是那一处。
#
# ## 为什么要瘦
#
# 0.2.44 那次热更新要下 128MB,其中通话组件 108MB,而服务器出口带宽小。仓库里的
# `channel-worker/node_modules` 有 524MB,里面**绝大部分在用户机器上一秒都用不到**。
#
# ## 砍掉了什么,凭什么敢砍(每一条都有出处)
#
#  1. **只装生产依赖**(`pnpm install --prod`)。typescript(24M)、vitest、vite、
#     livekit-client 这些是开发时的东西;工人在用户机器上是 `node src/main.ts` 直接跑的
#     (Node ≥ 24 原生剥类型),连编译都不做。
#  2. **onnxruntime 只留 darwin/arm64 那一份**。它把 win32(124M)与 linux(52M)的原生库
#     也一起发了,而工作台只支持 macOS + Apple 芯片(README「运行要求」)。
#     实际布局是 `bin/napi-v6/{darwin,linux,win32}/<arch>/`,darwin 底下只有 arm64。
#  3. **typescript 整个去掉**。它在生产树里只有一个来路:`@livekit/throws-transformer` 的
#     peerDependency。而运行时真正被 import 的是它的 `/throws` 与 `/promise` 两个子路径
#     (`dist/index.js` / `dist/throws-promise.js`),这两个文件里一个 typescript 都没有 ——
#     要 typescript 的是 `transformer.js` / `cli.js`,那是**编译期**的东西。
#  4. **`@livekit/local-inference` 的原生二进制去掉(34MB,单件最大)**。
#     2026-09-18 在本机实测过:import `@livekit/agents` + `agents-plugin-silero` 之后
#     (用 `process.dlopen` 钩子记下真被加载的 `.node`),加载的只有三样 ——
#     rtc-node、sharp、onnxruntime,**local-inference 一次都没被打开**。
#     原因在框架里写着:默认的 `InferenceTurnDetector` 取的是 `getJobContext().inferenceExecutor`,
#     而我们的工人是**自己 new AgentSession 进房**的(不走 agents 的 CLI worker / job dispatch),
#     `getJobContext()` 当场抛 —— 于是 executor 永远是 undefined,`LocalTransport` 自己走
#     「no inference executor」那条分支(它源码里写的:`defaulting predictions to 1.0 so turns
#     still commit after minDelay`)。换句话说这 34MB 今天就是**死重**。
#     **JS 那一层照留**(`@livekit/local-inference/index.js`):万一哪天真去 require 它,
#     走的是框架自己接住的那条「native binding not loadable」,不是一个崩。
#     要留着二进制就加 `--with-local-eot`。
#  5. **测试、文档、sourcemap、.d.ts**。`.map` 与 `.d.ts` 在用户机器上一个字节都读不到。
#  6. **`@livekit/agents*` 里随包发的 `src/`**。它们的 `main`/`exports` 全部指向 `dist/`;
#     silero 那个 2.2MB 的 `silero_vad.onnx` 在 dist 与 src 各有一份,dist 那份才是被读的
#     (`dist/onnx_model.js` 里 `new URL('silero_vad.onnx', import.meta.url)`)。
#
# 剩下的大头是**三个真的会被加载的原生库**:onnxruntime 的 dylib、rtc-node、sharp 的 libvips。
# 它们加起来就是这个包的地板,再砍就是砍功能了。实际数字见 docs/交接-0918-热更新增量.md。
#
# ## 打完一定会做一件事:**在解开的那棵树上真起一次**
#
# `node src/main.ts --selfcheck`:真加载 rtc-node、真加载 sharp(agents 一进来就 import 它)、
# 真让 Silero VAD 读一次模型。删多了的表现不是编译错,是几天之后她不出声 —— 所以这一关不能省。
# 出包机器上确实装不了依赖时可以 `--no-verify`,但那就等于没验过,别拿它发版。
#
# ## 参数
#
#   --tar <文件>        打成 .tgz(里面最外层是 `channel-worker/`,解开就是仓库的样子)
#   --tree <目录>       不打包,把瘦身后的树摆到 <目录>/channel-worker(安装包 payload 用)
#   --stage <目录>      暂存目录(默认 dist/worker-pack;**故意固定**,见下面那段注释)
#   --no-verify         跳过那次真起(**不推荐**)
#   --with-local-eot    保留 @livekit/local-inference 的原生二进制(见上面第 4 条)
#
# --tar 与 --tree 至少给一个,也可以两个都给(打一次,两处都要)。

set -euo pipefail

REPO_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
SRC="$REPO_ROOT/channel-worker"
OUT_TAR=""
OUT_TREE=""
STAGE=""
VERIFY=1
WITH_LOCAL_EOT=0

while [ $# -gt 0 ]; do
  case "$1" in
    --tar) shift; OUT_TAR="${1:-}" ;;
    --tree) shift; OUT_TREE="${1:-}" ;;
    --stage) shift; STAGE="${1:-}" ;;
    --no-verify) VERIFY=0 ;;
    --with-local-eot) WITH_LOCAL_EOT=1 ;;
    --help|-h) sed -n '2,70p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "不认识的参数:$1(--help 看能用的)" >&2; exit 1 ;;
  esac
  shift
done

say() { printf '\n▸ %s\n' "$1"; }
info() { printf '  %s\n' "$1"; }
die() { printf '\n×  %s\n' "$1" >&2; exit 1; }

[ -n "$OUT_TAR" ] || [ -n "$OUT_TREE" ] || die "要 --tar <文件> 或 --tree <目录>(--help 看用法)。"
[ -f "$SRC/package.json" ] || die "找不到 $SRC/package.json —— 这个脚本要在仓库里跑。"
for tool in node pnpm tar gzip find; do
  command -v "$tool" >/dev/null 2>&1 || die "缺 $tool。"
done

# 暂存目录。**默认是仓库里 dist/ 下面一条固定的路径,不是 mktemp**——理由有两条:
#
#  1. **可复现**:pnpm 会把暂存目录的绝对路径写进 `node_modules/.modules.yaml`、
#     `.pnpm-workspace-state-v1.json` 与那几个 `.bin/` 垫片。路径每次都变的话,
#     同样的依赖也会打出不同的 sha256 —— 客户端那边「只下变了的」比的就是 sha,
#     等于白做(2026-09-18 实测:mktemp 两趟,84 行 bookkeeping 文件对不上)。
#  2. 顺带快:第二趟的 `pnpm install` 是增量的。
#
# **唯一一处会被 rm -rf 的路径是 `<暂存>/channel-worker`**,而且它由 STAGE 拼出来、
# 不是从参数原样拿来删的(0904 家目录事故之后的规矩)。
STAGE="${STAGE:-/tmp/worker-pack}"
case "$STAGE" in
  /*) ;;
  *) die "--stage 要给绝对路径(现在是 $STAGE)。" ;;
esac
WORK="$STAGE/channel-worker"
rm -rf "$WORK"
mkdir -p "$WORK"

# ───────────────────────── 1. 只把「要发的那几样」抄过去 ─────────────────────────

say "把源码与清单抄进暂存目录"
# **白名单,不是黑名单**:仓库里的 dev/、tests/、.env 之类一样都不该跟着走,
# 而黑名单总有一天会漏掉新出现的东西。
cp "$SRC/package.json" "$SRC/pnpm-lock.yaml" "$SRC/pnpm-workspace.yaml" "$WORK/"
# 第三方声明与许可全文(2026-10-21):包里带着 LGPL 的 FFmpeg 与 libvips,声明要跟着二进制走。
cp "$SRC/THIRD_PARTY_NOTICES.md" "$WORK/"
mkdir -p "$WORK/licenses"
cp "$SRC"/licenses/*.txt "$WORK/licenses/"
mkdir -p "$WORK/src"
(cd "$SRC/src" && tar -cf - .) | (cd "$WORK/src" && tar -xf -)
info "src($(du -sh "$WORK/src" | cut -f1))"

# ───────────────────────── 2. 只装生产依赖 ─────────────────────────

say "装生产依赖(pnpm install --prod)"
# `--frozen-lockfile`:按仓库里那份锁文件装,一个版本都不许飘。
# 原生模块的 postinstall 要跑(pnpm-workspace.yaml 里的 allowBuilds/onlyBuiltDependencies
# 放行了 onnxruntime-node 与 @livekit/local-inference),所以这里**不加 --ignore-scripts**。
(cd "$WORK" && pnpm install --prod --frozen-lockfile --prefer-offline >/dev/null) \
  || die "生产依赖没装上(锁文件跟 package.json 对不上?先在 channel-worker/ 里跑一次 pnpm install)。"
[ -d "$WORK/node_modules/@livekit/rtc-node" ] || die "装完了却没有 @livekit/rtc-node —— 不出包。"
info "装完 $(du -sh "$WORK/node_modules" | cut -f1)"

# ───────────────────────── 3. 瘦身 ─────────────────────────

say "瘦身(每一条的出处见本文件开头)"
NM="$WORK/node_modules"
before_kb="$(du -sk "$NM" | cut -f1)"

# ① onnxruntime:只留 darwin(里面只有 arm64)。
rm -rf "$NM"/.pnpm/onnxruntime-node@*/node_modules/onnxruntime-node/bin/*/linux
rm -rf "$NM"/.pnpm/onnxruntime-node@*/node_modules/onnxruntime-node/bin/*/win32
[ -n "$(find "$NM"/.pnpm/onnxruntime-node@*/node_modules/onnxruntime-node/bin -name '*.node' -print -quit 2>/dev/null)" ] \
  || die "把 onnxruntime 的非 darwin 二进制删完之后,darwin 那份也不见了 —— 上游的目录结构变了,先别发,回来改这个脚本。"

# ② typescript:生产树里没人在运行时 require 它(见开头第 3 条)。
rm -rf "$NM"/.pnpm/typescript@*
# 指过去的那几条软链接会变成悬空的。悬空软链接本身不碍事(没人 require 就没人解析它),
# 但留着只会让下一个人以为"这里有个 typescript"。
find "$NM" -type l -name typescript -delete 2>/dev/null || true

# ③ local-inference 的原生二进制(单件最大的 34MB,而且实测从没被加载过)。
if [ "$WITH_LOCAL_EOT" = "0" ]; then
  find "$NM" -name 'local-inference*.node' -type f -delete
fi

# ④ 随包发的 src/(这几个包的入口全指向 dist/)。
for pkg in agents agents-plugin-silero agents-plugin-openai; do
  rm -rf "$NM"/.pnpm/@livekit+"$pkg"@*/node_modules/@livekit/"$pkg"/src
done

# ⑤ sourcemap / 类型声明 / 用例 —— 在用户机器上一个字节都读不到。
find "$NM" -type f \( \
  -name '*.map' -o -name '*.d.ts' -o -name '*.d.cts' -o -name '*.d.mts' \
  -o -name '*.test.js' -o -name '*.test.cjs' -o -name '*.test.mjs' \
  -o -name '*.test.ts' -o -name '*.test.mts' \
  \) -delete

# ⑥ 文档与示例。LICENSE 一律留着(那是许可,不是文档)。
find "$NM" -type d \( -name test -o -name tests -o -name __tests__ -o -name docs \
  -o -name example -o -name examples -o -name .github \) -prune -exec rm -rf {} + 2>/dev/null || true
# sharp-libvips 没有 LICENSE 文件,它的许可表就写在 README.md 里(THIRD_PARTY_NOTICES.md 指着它),那一份留着。
find "$NM" -type f -name '*.md' ! -iname 'LICENSE*' ! -path '*/@img/sharp-libvips-*/README.md' -delete

# ⑦ pnpm 自己的记账文件。用户机器上**没有人会在那棵树里跑 pnpm**,而这几个文件里
#    写着出包机器的绝对路径,内容还每装一次就换一个顺序 —— 留着的唯一效果就是
#    「内容没变的包每次 sha256 都不一样」,而客户端「只下变了的」比的正是 sha。
rm -f "$NM/.modules.yaml" "$NM/.pnpm-workspace-state-v1.json" "$NM/.pnpm/lock.yaml"

# ⑧ `.bin/` 垫片。pnpm 把**出包机器的绝对路径**写进每个垫片的 NODE_PATH
#    (`export NODE_PATH="/Users/<谁>/…/node_modules/.pnpm/…"`)。公开发布的包
#    (热更新 tgz / 安装包 payload)不该带出包机的用户名与目录结构;而且这些路径
#    装到用户机器上本来就是失效的。归一化成由垫片自身位置推算,见脚本头注释。
node "$REPO_ROOT/deploy/normalize-bin-shims.mjs" "$NM" \
  || die "垫片归一化没过(包里还留着构建机绝对路径)。"

# 声明齐不齐:缺一样不出包(LGPL 的二进制必须带着许可与源码说明走)。
# 两个 LGPL 包在 pnpm 的布局里不提到顶层,在 node_modules/.pnpm/<包@版本>/node_modules/ 底下。
for need in THIRD_PARTY_NOTICES.md licenses/LGPL-2.1.txt licenses/LGPL-3.0.txt licenses/GPL-3.0.txt \
  'node_modules/.pnpm/@livekit+av-darwin-arm64@*/node_modules/@livekit/av-darwin-arm64/NOTICE' \
  'node_modules/.pnpm/@img+sharp-libvips-darwin-arm64@*/node_modules/@img/sharp-libvips-darwin-arm64/README.md'; do
  # shellcheck disable=SC2086 # 故意让通配展开
  found="$(cd "$WORK" && ls -d $need 2>/dev/null | head -1)"
  [ -n "$found" ] && [ -f "$WORK/$found" ] || die "包里缺 $need —— 第三方声明不全,不出包(见 channel-worker/THIRD_PARTY_NOTICES.md)。"
done
info "第三方声明齐了(THIRD_PARTY_NOTICES.md + licenses/ + 两个 LGPL 包自带的说明)"

after_kb="$(du -sk "$NM" | cut -f1)"
info "node_modules $((before_kb / 1024))M → $((after_kb / 1024))M"

# ───────────────────────── 4. 真起一次 ─────────────────────────

if [ "$VERIFY" = "1" ]; then
  say "在这棵瘦下来的树上真起一次(--selfcheck)"
  NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
  [ "$NODE_MAJOR" -ge 24 ] || die "要 node ≥ 24 才能跑工人(现在是 $NODE_MAJOR)。"
  if (cd "$WORK" && node src/main.ts --selfcheck); then
    info "自检过了。"
  else
    die "瘦下来的这棵树起不来(上面是它的输出)。**别发** —— 多半是上一步删多了,回来改砍的那几条。"
  fi
else
  info "按 --no-verify 跳过了那次真起 —— 这一份没验过,别拿它发版。"
fi

# ───────────────────────── 5. 出货 ─────────────────────────

# 打包前**把时间戳与属主抹平**:同样的内容要打出同样的字节,否则"没变"的包每次
# sha256 都不一样,客户端那边「只下变了的」就白做了(它比的就是 sha)。
normalize() {
  # -h:软链接本身的时间,别跟过去改到目标上。
  find "$WORK" -exec touch -h -t 202601010000.00 {} + 2>/dev/null || true
}

if [ -n "$OUT_TAR" ]; then
  say "打包"
  mkdir -p "$(dirname "$OUT_TAR")"
  normalize
  # 文件表排过序 + 属主抹平 + `gzip -n`(不把时间写进 gzip 头):同样的内容 → 同样的 sha256。
  (cd "$STAGE" && find channel-worker | LC_ALL=C sort > "$STAGE/.filelist")
  # `-n`(--no-recursion)不能少:bsdtar 对 `-T` 列表里的**目录**是会再递归一遍的,
  # 而我们的列表里每个目录都在 —— 不给这一条,同一棵树会被打进去三遍(实测 142MB → 361MB)。
  (cd "$STAGE" && tar -cf - -n --uid 0 --gid 0 --uname '' --gname '' -T "$STAGE/.filelist") \
    | gzip -n -9 > "$OUT_TAR"
  rm -f "$STAGE/.filelist"
  info "$OUT_TAR($(du -h "$OUT_TAR" | cut -f1),$(wc -c < "$OUT_TAR" | tr -d ' ') 字节)"
fi

if [ -n "$OUT_TREE" ]; then
  say "摆到 $OUT_TREE/channel-worker"
  mkdir -p "$OUT_TREE"
  rm -rf "$OUT_TREE/channel-worker"
  mkdir -p "$OUT_TREE/channel-worker"
  # pnpm 的 node_modules 里是**指向同目录 .pnpm 的相对软链接**,所以整棵原样搬就成立。
  (cd "$WORK" && tar -cf - .) | (cd "$OUT_TREE/channel-worker" && tar -xf -)
  info "$OUT_TREE/channel-worker($(du -sh "$OUT_TREE/channel-worker" | cut -f1))"
fi

printf '\n✓  通话组件打好了\n'
