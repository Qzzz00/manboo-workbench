#!/usr/bin/env bash
#
# 一条命令出安装包:`dist/工作台安装器-<版本>.dmg`,里面一个「安装工作台.app」。
#
#     bash deploy/build-installer.sh
#
# 它做什么(按顺序):
#   1. 体检要用的几样东西(swiftc / pnpm / node ≥ 24 / rsync / hdiutil)
#   2. 构建插件(pnpm build → npm pack)、事务官后台页面(admin-ui)、壳(工作台.app)
#   3. 把安装器的内核打成一份单文件 JS,把 node 的下载信息从 paths.ts 生成出来;
#      收自带的 pnpm 与本机通话服务(livekit-server,两道 sha256 钉在 paths.ts,同一张证书重签)
#   4. 收资源:**payload 摆成仓库的样子**,于是安装步骤那份代码一个字不用改
#   5. 编「安装工作台.app」,把资源塞进它的 Resources
#   6. hdiutil 打成 dmg
#
# 中转与更新清单地址(2026-10-21,局域网 M7「零服务器是缺省」):源码里不写,构建时由
# `workbench-plugin/scripts/build-endpoints.mjs` 定 —— 环境变量 `WORKBENCH_BUILD_RELAY_URL` / `WORKBENCH_BUILD_UPDATE_URL`
# 压过 `deploy/release-endpoints.env`(我们自己的那一档,只在内部仓)。两样都没有 = 开源档:装出来的机器不连任何中转。
# 插件与安装器内核都注入同一份,打完各核一次(产物里编进去的就是开头打出来的那一行)。
#
# 签名:壳与安装器**用同一张证书**,由 `deploy/codesign-identity.sh --resolve` 解析
# (先认 $WORKBENCH_CODESIGN_IDENTITY,再认登录钥匙串里的「工作台本机签名」,都没有才 ad-hoc)。
# 身份不变 ⇒ designated requirement 不变 ⇒ 用户**更新壳不会掉辅助功能授权**。
# 这个脚本最后会把三条 requirement 打出来给你对(壳、包里的壳、安装器)。
#
# 参数:
#   --no-worker   不打包 channel-worker(手机通话那一块)。dmg 会小一半多 ——
#                 它的 node_modules 里有 onnxruntime,光那一个包就两百多兆。
#                 不打包的话装出来的机器上手机通话用不了,别的都照常。
#   --keep-stage  跑完不删中间目录(想看看收了些什么就给上)。
#   --out <路径>  dmg 出到哪(默认 dist/工作台安装器-<版本>.dmg)。
#
# 产物**不进 git**(dist/ 在 .gitignore 里),这个脚本进 git。

set -euo pipefail

REPO_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
OUT=""
WITH_WORKER=1
KEEP_STAGE=0

while [ $# -gt 0 ]; do
  case "$1" in
    --no-worker) WITH_WORKER=0 ;;
    --keep-stage) KEEP_STAGE=1 ;;
    --out) shift; OUT="${1:-}" ;;
    --help|-h) sed -n '2,35p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "不认识的参数:$1(能用的是 --no-worker / --keep-stage / --out / --help)" >&2; exit 1 ;;
  esac
  shift
done

STARTED=$(date +%s)
say() { printf '\n▸ %s\n' "$1"; }
info() { printf '  %s\n' "$1"; }
die() { printf '\n×  %s\n' "$1" >&2; exit 1; }

# 版本号(2026-09-27,维护者:「在安装包上加版本号吧」—— 新 Air 上打开了旧的那份还以为是新的):
# 文件名、挂出来的盘名、「先读我」第一行、安装窗口标题都带上它。取插件的版本号,与热更新清单同一个数。
VERSION="$(sed -n 's/^ *"version": *"\([^"]*\)".*/\1/p' "$REPO_ROOT/workbench-plugin/package.json" | head -1)"
[ -n "$VERSION" ] || die "读不出版本号(workbench-plugin/package.json)。"
[ -n "$OUT" ] || OUT="$REPO_ROOT/dist/工作台安装器-$VERSION.dmg"

# ───────────────────────── 1. 体检 ─────────────────────────

say "看一眼手边的工具"
for tool in swiftc pnpm npm node rsync hdiutil ditto; do
  command -v "$tool" >/dev/null 2>&1 || die "缺 $tool。swiftc 要 Xcode 命令行工具(xcode-select --install);pnpm 用 npm i -g pnpm;hdiutil / ditto 是系统自带的。"
done
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
[ "$NODE_MAJOR" -ge 24 ] || die "构建要 node ≥ 24(现在是 $NODE_MAJOR)—— 打包内核那一步要它自己剥 TypeScript。"
[ -x "$REPO_ROOT/workbench-plugin/node_modules/.bin/tsdown" ] || die "workbench-plugin 还没装依赖:先 cd workbench-plugin && pnpm install(它的 devDependencies 用 link: 指向同级的 deepseek-harness 仓库)。"
info "都在。node $(node -v)、$(swiftc --version 2>/dev/null | head -1)"

say "这一份带着哪台中转"
ENDPOINTS_LINE="$(cd "$REPO_ROOT/workbench-plugin" && node scripts/build-endpoints.mjs)" || die "中转 / 更新清单地址写错了(上面那句)。"
info "$ENDPOINTS_LINE"

# 早在这里解析一次签名身份(而不是等各自的 build.sh 里去解析):没有证书这件事要在**开头**
# 就说清楚,而不是等两分钟构建完之后在日志里一闪而过。两个 build.sh 各自会再解析一次,
# 走的是同一条逻辑、同一个环境,答案必然相同。
say "看一眼签名身份"
SIGN_ID="$(bash "$REPO_ROOT/deploy/codesign-identity.sh" --resolve)"
if [ "$SIGN_ID" = "-" ]; then
  SIGN_LABEL="ad-hoc(临时签名)"
  info "这次是 ad-hoc:装出去的壳每更新一次,用户的辅助功能授权就掉一次。"
else
  SIGN_LABEL="${WORKBENCH_CODESIGN_IDENTITY:-工作台本机签名}"
  info "$SIGN_LABEL($SIGN_ID)"
fi

# 一条 .app 的 designated requirement —— TCC 认的就是它。
req() { codesign -d -r - "$1" 2>/dev/null | sed -n 's/^#\{0,1\} *designated => //p'; }

STAGE="$(mktemp -d "${TMPDIR:-/tmp}/workbench-installer-stage.XXXXXX")"
PAYLOAD="$STAGE/payload"
cleanup() { [ "$KEEP_STAGE" = "1" ] || rm -rf "$STAGE"; }
trap cleanup EXIT
mkdir -p "$PAYLOAD"/{plugin,app,workbench-plugin/bin,deploy,butler-server/launchd} "$STAGE/kernel"

# ───────────────────────── 2. 构建 ─────────────────────────

say "构建工作台插件(pnpm build → npm pack)"
(cd "$REPO_ROOT/workbench-plugin" && pnpm build >/dev/null && npm pack --pack-destination "$PAYLOAD/plugin" >/dev/null)
(cd "$REPO_ROOT/workbench-plugin" && node scripts/build-endpoints.mjs --check lib/index.js >/dev/null) \
  || die "插件产物里编进去的中转地址与开头那一行对不上(上面那句)。"
TGZ="$(ls "$PAYLOAD/plugin"/*.tgz | head -1)"
[ -n "$TGZ" ] || die "npm pack 没出 .tgz。"
info "$(basename "$TGZ")($(du -h "$TGZ" | cut -f1))"

say "构建事务官后台页面(admin-ui)"
if [ -d "$REPO_ROOT/butler-server/admin-ui" ]; then
  (cd "$REPO_ROOT/butler-server/admin-ui" && pnpm build >/dev/null 2>&1) \
    || info "admin-ui 没构建成 —— 用仓库里已有的 dist/(事务官的形象与音色配置页,少了它只是那一页打不开)"
fi
[ -d "$REPO_ROOT/butler-server/admin-ui/dist" ] || info "警告:butler-server/admin-ui/dist 不在,事务官后台页面这次没打进去。"

say "构建壳(工作台.app)"
(cd "$REPO_ROOT/workbench-app" && ./build.sh) >"$STAGE/build-shell.log" 2>&1 \
  || { sed 's/^/    /' "$STAGE/build-shell.log" >&2; die "壳没构建出来(上面是它的输出)。"; }
[ -d "$REPO_ROOT/workbench-app/build/工作台.app" ] || die "壳没构建出来。"
SHELL_REQ="$(req "$REPO_ROOT/workbench-app/build/工作台.app")"
ditto "$REPO_ROOT/workbench-app/build/工作台.app" "$PAYLOAD/app/工作台.app"
info "工作台.app($(du -sh "$PAYLOAD/app/工作台.app" | cut -f1))"
info "requirement:$SHELL_REQ"

# ───────────────────────── 3. 内核 + node 的下载信息 ─────────────────────────

say "打包安装器内核"
# 打成一份单文件 JS,而不是把 src/ 整棵搬进去:内核那几个模块互相引用,还引到
# setup/ 以外的东西(status.ts → activation.ts / clientScan.ts)。搬源码要连带一大堆,
# 而且要求目标机器的 node 能剥 TypeScript;打成 .mjs 之后就是一份 50KB 的普通 JS。
# 内核单列一份配置(tsdown.kernel.config.ts):它装 DSH 设置要用中转地址,同样构建注入。
(cd "$REPO_ROOT/workbench-plugin" && npx tsdown -c tsdown.kernel.config.ts --out-dir "$STAGE/kernel" >/dev/null 2>&1)
[ -f "$STAGE/kernel/install-from-bundle.mjs" ] || die "内核没打出来。"
(cd "$REPO_ROOT/workbench-plugin" && node scripts/build-endpoints.mjs --check "$STAGE/kernel/install-from-bundle.mjs" --only relay >/dev/null) \
  || die "安装器内核里编进去的中转地址与开头那一行对不上(上面那句)。"
info "kernel/install-from-bundle.mjs($(du -h "$STAGE/kernel/install-from-bundle.mjs" | cut -f1))"

# 内核里带的 DSH 运行时锁定清单必须是仓库里那一份(2026-09-25,升 0.1.7 时加的这一道)。
# 为什么要核:清单是 `import … with { type: 'json' }` 编进这份 .mjs 的,一台新机器上
# DSH 是哪一版**全由它决定**。一次 tsdown 走了缓存、或者有人只改了 LOCKED_DSH_VERSION
# 没重生成那两份清单,出来的 dmg 就会装一个跟仓库说的不是同一版的 DSH —— 而 dmg 上看不出来。
LOCKED_DSH="$(node -e "
  import('$REPO_ROOT/workbench-plugin/src/server/setup/paths.ts')
    .then(m => process.stdout.write(m.LOCKED_DSH_VERSION))
" 2>/dev/null)"
[ -n "$LOCKED_DSH" ] || die "读不出 LOCKED_DSH_VERSION(workbench-plugin/src/server/setup/paths.ts)。"
grep -q "\"@deepseek-ai/dsh\": \"^$LOCKED_DSH\"" "$STAGE/kernel/install-from-bundle.mjs" \
  || die "内核里带的运行时锁定清单不是 dsh ${LOCKED_DSH}。
     多半是改了 LOCKED_DSH_VERSION 却没重生成 workbench-plugin/src/server/setup/dsh-runtime/ 下那两份文件
     (步骤见 workbench-plugin/src/server/setup/dshRuntimeLock.ts 文件头);
     先跑 pnpm vitest run tests/dsh-runtime-lock.test.ts 看它红在哪。"
info "内核里的运行时锁定清单:dsh $LOCKED_DSH ✓"

# ── 自带的 pnpm(2026-09-27,卡 PN) ──
# 为什么非带不可:DSH 0.1.7 的 `dsh plugin add` 转手给 pnpm,找不到就回 127。维护者这台有
# /opt/homebrew/bin/pnpm,一台全新的 Mac 上没有 —— 9/27 新 Air 就死在这一步。版本与 sha256
# 从 paths.ts 读(唯一一处定义),**在这里下、在这里核**:装的那台机器上一条网络请求都不用。
say "收自带的 pnpm"
PNPM_INFO="$(node -e "
  import('$REPO_ROOT/workbench-plugin/src/server/setup/paths.ts').then((m) => {
    process.stdout.write([m.PNPM_TARBALL_NAME, m.PNPM_TARBALL_SHA256, ...m.PNPM_TARBALL_URLS].join('\n'))
  })
" 2>/dev/null)"
PNPM_NAME="$(printf '%s' "$PNPM_INFO" | sed -n 1p)"
PNPM_SHA="$(printf '%s' "$PNPM_INFO" | sed -n 2p)"
[ -n "$PNPM_NAME" ] && [ -n "$PNPM_SHA" ] || die "读不出 pnpm 的版本与 sha256(workbench-plugin/src/server/setup/paths.ts 的 PNPM_TARBALL_*)。"
mkdir -p "$PAYLOAD/pnpm"
PNPM_TGZ="$PAYLOAD/pnpm/$PNPM_NAME"
# 本机缓存一份(dist/ 不进 git):重复出包不用每次下 9MB。
PNPM_CACHE="$REPO_ROOT/dist/.cache/$PNPM_NAME"
mkdir -p "$(dirname "$PNPM_CACHE")"
if [ -f "$PNPM_CACHE" ] && [ "$(shasum -a 256 "$PNPM_CACHE" | awk '{print $1}')" = "$PNPM_SHA" ]; then
  cp "$PNPM_CACHE" "$PNPM_TGZ"
  info "$PNPM_NAME(本机缓存)"
else
  # 第 3 行起是 URL(国内镜像在前、官方在后),一律核同一份 sha256。
  rm -f "$PNPM_TGZ"
  for url in $(printf '%s' "$PNPM_INFO" | tail -n +3); do
    curl -fL --retry 2 --retry-delay 2 --connect-timeout 20 -o "$PNPM_TGZ" "$url" >/dev/null 2>&1 && break
    info "这条源没下成,换下一条:$url"
    rm -f "$PNPM_TGZ"
  done
  [ -f "$PNPM_TGZ" ] || die "pnpm 的包一条源都没下成(出包这台机器要能上 npmmirror 或 npmjs)。"
  GOT_SHA="$(shasum -a 256 "$PNPM_TGZ" | awk '{print $1}')"
  [ "$GOT_SHA" = "$PNPM_SHA" ] || die "下下来的 pnpm 跟 paths.ts 里钉着的 sha256 对不上(算出来 $GOT_SHA,要的是 $PNPM_SHA),不出包。"
  cp "$PNPM_TGZ" "$PNPM_CACHE"
  info "$PNPM_NAME($(du -h "$PNPM_TGZ" | cut -f1),sha256 已核对)"
fi
[ -f "$PNPM_TGZ" ] || die "payload 里没有 pnpm 的包。"

# ── 本机房间服务(livekit-server,2026-10-21,局域网主路卡 M1) ──
# 随包、不首次下载(国内拉 GitHub / ghcr 不稳,首次下载失败等于「装完打不了电话」)。取哪一份、两道 sha256、
# 用同一张证书重签,全在 deploy/fetch-livekit.sh(发热更新 --with livekit 用的也是它)。放到 payload/livekit/。
say "收本机通话服务(livekit-server)"
bash "$REPO_ROOT/deploy/fetch-livekit.sh" --into "$PAYLOAD" --sign "$SIGN_ID" \
  || die "本机通话服务没收进来(上面是它的输出)。出包这台机器要能上 ghcr.io,或者先在 dist/.cache/ 里放一份对得上 sha 的 bottle。"
[ -x "$PAYLOAD/livekit/livekit-server" ] || die "payload 里没有 livekit/livekit-server。"
[ -f "$PAYLOAD/livekit/NOTICE" ] || die "payload 里没有 livekit/NOTICE(Apache-2.0 要求随二进制带上)。"
info "livekit/livekit-server($(du -h "$PAYLOAD/livekit/livekit-server" | cut -f1))"

say "从 paths.ts 生成 node 的下载信息"
node "$REPO_ROOT/deploy/installer/node-source-env.ts" > "$STAGE/node-source.env"
grep -q '^NODE_SHA256=' "$STAGE/node-source.env" || die "node-source.env 生成得不对。"
info "$(grep '^NODE_VERSION=' "$STAGE/node-source.env")"

cp "$REPO_ROOT/deploy/installer/stage0.sh" "$STAGE/stage0.sh"
chmod 755 "$STAGE/stage0.sh"

# ───────────────────────── 4. 收 payload(摆成仓库的样子) ─────────────────────────

say "收资源"
# 启动脚本与 plist 模板:安装步骤里的 scripts / launchd 两步读的就是这几条相对路径。
cp "$REPO_ROOT/workbench-plugin/bin/dsh-start" "$PAYLOAD/workbench-plugin/bin/dsh-start"
cp "$REPO_ROOT/workbench-plugin/bin/butler-start" "$PAYLOAD/workbench-plugin/bin/butler-start"
cp "$REPO_ROOT/deploy/channel-start" "$PAYLOAD/deploy/channel-start"
cp "$REPO_ROOT/deploy/livekit-start" "$PAYLOAD/deploy/livekit-start"
# 手机包(2026-09-18):有就带上,首次流程的二维码从数据目录发;没有就提示,不算失败。
APK_SRC="$REPO_ROOT/butler-app/android/app/build/outputs/apk/debug/app-debug.apk"
if [ -f "$APK_SRC" ]; then
  mkdir -p "$PAYLOAD/butler-app/android/app/build/outputs/apk/debug"
  cp "$APK_SRC" "$PAYLOAD/butler-app/android/app/build/outputs/apk/debug/app-debug.apk"
  info "手机包 app-debug.apk($(du -sh "$APK_SRC" | cut -f1))"
else
  echo "! 没有手机包(butler-app/android/.../app-debug.apk),安装包里不带;要带就先 pnpm android:debug" >&2
fi
cp "$REPO_ROOT/deploy/ai.deepseek.dsh.plist" "$PAYLOAD/deploy/ai.deepseek.dsh.plist"
cp "$REPO_ROOT/butler-server/launchd/ai.deepseek.butler.plist" "$PAYLOAD/butler-server/launchd/ai.deepseek.butler.plist"
cp "$REPO_ROOT/deploy/ai.deepseek.livekit.plist" "$PAYLOAD/deploy/ai.deepseek.livekit.plist"
info "启动脚本 4 份、plist 3 份"

# 事务官后端:照 butler-start 读的结构(server / admin-ui/dist / node_modules / package.json)。
# 先按锁文件把依赖装齐,再 rsync(顺序反了会在干净 worktree 上停在「缺依赖」)。
(cd "$REPO_ROOT/butler-server" && pnpm install --frozen-lockfile --prefer-offline >/dev/null 2>&1 || pnpm install --prefer-offline >/dev/null)
for part in server admin-ui/dist node_modules; do
  if [ -d "$REPO_ROOT/butler-server/$part" ]; then
    mkdir -p "$PAYLOAD/butler-server/$part"
    rsync -a "$REPO_ROOT/butler-server/$part/" "$PAYLOAD/butler-server/$part/"
  fi
done
cp "$REPO_ROOT/butler-server/package.json" "$PAYLOAD/butler-server/package.json"
# 2026-09-18 真机踩坑:仓库的 butler-server/node_modules 没跟上 package.json(少了 ws、iconv-lite),
# 装到用户机器上 8792 起不来、工人跟着崩。打包前先按锁文件装一遍,再逐个核对直接依赖都在。
for dep in $(node -e 'console.log(Object.keys(require(process.argv[1]).dependencies||{}).join(" "))' "$REPO_ROOT/butler-server/package.json"); do
  [ -e "$PAYLOAD/butler-server/node_modules/$dep" ] || die "butler-server 缺依赖 $dep(node_modules 里没有),不出包"
done
info "butler-server 直接依赖齐全"

info "butler-server($(du -sh "$PAYLOAD/butler-server" | cut -f1))"

# 通道层工人:**必须连 node_modules 一起**(Silero VAD 的 onnxruntime 是原生模块)。
# pnpm 的 node_modules 里是指向同目录 .pnpm 的相对符号链接,所以 `rsync -a` 原样搬就成立。
if [ "$WITH_WORKER" = "1" ]; then
  # **跟发版用的是同一段打包逻辑**(deploy/pack-channel-worker.sh):只装生产依赖、
  # 砍掉用不到的原生库、打完在那棵树上真起一次。以前这里和 publish-update.sh 各写一段
  # `--exclude`,改一处漏一处 —— 2026-09-18「工人包瘦身」把它们并成了一处。
  bash "$REPO_ROOT/deploy/pack-channel-worker.sh" --tree "$PAYLOAD" \
    || die "通话组件没打出来(上面是它的输出)。"
  info "channel-worker($(du -sh "$PAYLOAD/channel-worker" | cut -f1))"
else
  info "channel-worker:按 --no-worker 跳过(装出来的机器上手机通话用不了)"
fi

# 出包前统一归一化 pnpm 垫片:butler-server 是整棵 node_modules rsync 过来的,
# channel-worker 是 pack-channel-worker.sh 摆过来的,两边都会带出包机绝对路径。
# 在 payload 收齐之后、编安装器之前做一次,覆盖全部来源(脚本幂等,再跑一次不改字节)。
node "$REPO_ROOT/deploy/normalize-bin-shims.mjs" "$PAYLOAD" \
  || die "垫片归一化没过(包里还留着构建机绝对路径)。"

# pnpm 的记账文件里还写着出包机的家目录
# (`.modules.yaml` 的 "storeDir": "/Users/<谁>/Library/pnpm/store/v10")。
# 用户机器上不跑 pnpm,这些文件一个都用不到;worker 那棵已由 pack-channel-worker.sh 删过,
# butler-server 是整棵 rsync 过来的,在这里统一补掉。顺带删掉 Finder 留下的 .DS_Store。
find "$PAYLOAD" -type f \( -name '.modules.yaml' -o -name '.pnpm-workspace-state-v1.json' -o -path '*/.pnpm/lock.yaml' -o -name '.DS_Store' \) -delete 2>/dev/null || true

info "payload 合计 $(du -sh "$PAYLOAD" | cut -f1)"

# ───────────────────────── 5. 编安装器 ─────────────────────────

say "编「安装工作台.app」"
(cd "$REPO_ROOT/installer-app" && WORKBENCH_VERSION="$VERSION" ./build.sh --resources "$STAGE") >"$STAGE/build-installer-app.log" 2>&1 \
  || { sed 's/^/    /' "$STAGE/build-installer-app.log" >&2; die "安装器没编出来(上面是它的输出)。"; }
APP="$REPO_ROOT/installer-app/build/安装工作台.app"
[ -d "$APP" ] || die "安装器没编出来。"
info "$(du -sh "$APP" | cut -f1)"

# ── 签名核对 ──
# 安装器是 `--deep` 签的,会把 Resources 里那份壳**重签一遍**。同一张证书重签,
# requirement 应当一个字不差 —— 用户装出去的就是包里那一份,所以要对的是"包里的壳"。
say "核对签名"
INSTALLER_REQ="$(req "$APP")"
BUNDLED_SHELL="$APP/Contents/Resources/payload/app/工作台.app"
BUNDLED_REQ="$(req "$BUNDLED_SHELL")"
info "安装器:    $INSTALLER_REQ"
info "壳(刚构建):$SHELL_REQ"
info "壳(包里):  $BUNDLED_REQ"
codesign --verify --deep --strict "$APP" 2>&1 | sed 's/^/    /' || die "安装器签名验不过。"
if [ "$SIGN_ID" = "-" ]; then
  info "ad-hoc:这两条 requirement 是 cdhash,下次构建就变 —— 用户更新后要重新授权。"
elif [ "$SHELL_REQ" = "$BUNDLED_REQ" ]; then
  info "✓ 包里那份壳的 requirement 与刚构建的一致,而且不随构建变。"
else
  die "包里的壳与刚构建的壳 requirement 不一样($SHELL_REQ ≠ $BUNDLED_REQ)—— 装出去会掉授权,别发。"
fi

# ───────────────────────── 6. 打 dmg ─────────────────────────

say "打 dmg"
mkdir -p "$(dirname "$OUT")"
rm -f "$OUT"
DMG_SRC="$(mktemp -d "${TMPDIR:-/tmp}/workbench-installer-dmg.XXXXXX")"
ditto "$APP" "$DMG_SRC/安装工作台.app"
# 一份「先读我」:没有公证的 App 第一次打开会被系统拦下,怎么放行这句话必须在 dmg 里,
# 而不是只写在交接文档里 —— 双击 dmg 的人手边只有 dmg。
# 2026-09-27 维护者在新 Air(macOS 15.7.3)上实测纠正:**右键 → 打开这条路 macOS 15 起已经没了**,
# 只能去 系统设置 → 隐私与安全性 → 拉到最底 →「仍要打开」。
printf '这是工作台 %s 的安装包。\n\n' "$VERSION" > "$DMG_SRC/第一次打开请先读我.txt"
cat >> "$DMG_SRC/第一次打开请先读我.txt" <<'EOF'
第一次打开「安装工作台」时,系统会拦下来,说无法验证开发者。

这是因为这个安装包没有花钱买苹果的开发者证书。放行的办法:

  1. 双击「安装工作台」,系统弹框拦下时,点「完成」把框关掉。
  2. 打开「系统设置」→ 左边点「隐私与安全性」→ 右边一直拉到最底下。
  3. 那里会有一句「已阻止使用"安装工作台"」,旁边点「仍要打开」。
  4. 输入这台电脑的开机密码,再在弹出的框里点「打开」。

只有第一次要这么做。之后双击就行。

装的过程中会有一屏「还差几个授权」,每一样点「去允许」,在系统弹框里点「允许」。
**这几个授权只要点一次。**以后工作台更新,不用再点一遍。
EOF
# UDZO = zlib 压缩。payload 里大头是 node_modules,压下来能省一多半。
hdiutil create -volname "安装工作台 $VERSION" -srcfolder "$DMG_SRC" -ov -format UDZO "$OUT" >/dev/null
rm -rf "$DMG_SRC"

ELAPSED=$(( $(date +%s) - STARTED ))
printf '\n✓  出来了:%s\n   大小:%s   耗时:%d 分 %d 秒\n\n' \
  "$OUT" "$(du -h "$OUT" | cut -f1)" $((ELAPSED / 60)) $((ELAPSED % 60))
printf '   签名:%s\n\n' "$SIGN_LABEL"
cat <<'EOF'
下一步:把它拖到桌面,双击挂载,双击「安装工作台」;被拦下后去 系统设置 → 隐私与安全性 →
拉到最底 →「仍要打开」(第一次要这样,因为没有公证 —— macOS 15 起右键 → 打开已经不管用;
这一条跟签名稳不稳定是两件事,要根治得买 Developer ID 做公证)。
EOF
if [ "$SIGN_ID" = "-" ]; then
  cat <<'EOF'

⚠️  这个包是 ad-hoc 签名的:装它的人每更新一次壳,辅助功能授权就掉一次。
    先在这台机器上跑一遍 `bash deploy/codesign-identity.sh`,再重新打包。
EOF
fi
