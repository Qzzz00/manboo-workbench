#!/usr/bin/env bash
#
# 发一版热更新(2026-09-18,Ben:「能加热更新的按钮吗,更新完之后重启」)。
#
#     bash deploy/publish-update.sh --notes "这一版修了窗口落屏。"                    # 热修(缺省)
#     bash deploy/publish-update.sh --channel stable --with installer --notes "…"   # 每周一次的稳定版
#
# 它做什么(按顺序):
#   1. 体检要用的几样东西,并确认要发的版本号比服务器上那一版新
#   2. 构建要发的那几样产物(默认只有插件与启动脚本 —— 见下面「默认只发小的那两样」)
#   3. 逐个算 sha256,写出这条通道的清单(热修 beta.json;稳定版 latest.json + beta.json)
#   3½. **稳定版先在隔离的新机器上演练一遍**(`pnpm rehearse`),红了就不发(见下面「两条通道」)
#   4. **本机闸**:把这一版装到这台机器上、等它起来(见下面那一节),不过就一个字节都不推
#   5. rsync 到 aiboo-server:/var/lib/relay/updates/(**先推产物,后推清单**)
#   6. **本机也走一遍真正的更新路**:按一次「立即更新」,把闸没装的那几样装上(见下面那一节)
#   7. 顺手打一个给运营同学的源码包(不上传)
#
# ## 两条通道:体验的人只收稳定版(2026-10-21,内测发版底座)
#
# 服务器上 `updates/` 里两份清单:**`latest.json` 是稳定版**(从第一天起就是它,老客户端只认它),
# **`beta.json` 是热修**。客户端按本机设置里「收哪条更新」读其中一份(缺省稳定版;维护者与统筹
# 自己切到热修,见 `workbench-plugin/src/server/update/channel.ts`)。
#
#   --channel hotfix(缺省)  只写 beta.json。latest.json 一个字节不动 —— 10-14 一天四版那种节奏
#                             只到维护者与统筹手上。
#   --channel stable          写 latest.json,**同时把 beta.json 也换成同一份**:稳定版一定不落后于热修,
#                             收热修的机器不会因为一次稳定版发布被晾在旧版上。
#                             发之前先跑新机器演练(`cd workbench-plugin && pnpm rehearse --version <版本>`:
#                             隔离 home 里从安装包装一遍 → 体检 → 报告),**红了就不发**。
#                             实在要跳过:`--skip-rehearse "<理由>"`(理由必填,写进清单 `rehearse_skipped`)。
#
# 版本号要**比服务器上两份清单里较新的那一版还新**:热修 0.4.145 发过之后,稳定版就从 0.4.146 起。
# 没重打的那几样照**较新的那一份**清单原样带上(见下面「没重打的那几样」)。
# 回滚照旧是「把上一份清单再推一次」(旧包从不删),只是要推回对应通道的那个文件名。
#
# ## 本机闸:先装到这台机器上,起来了才许推(2026-10-03)
#
# **0.4.87 先推公网再升本机,崩了才知道**(用例全绿,装上就启动即崩,公网清单指着它近一小时)。
# 所以 rsync 之前先走一遍 `deploy/local-install-gate.sh`:装上 → 等 `8791/update/check` 回这个
# 版本号 → 隔 10 秒 `/state` 要 200。不过就一个字节都不推,并打印回退命令。
#
# **只管插件**(崩的就是它,也只有它能在这台机器上装完当场验);壳 / 事务官后端 / 电话工人 /
# 手机包不在闸里,理由见那个脚本的文件头。`--no-upload` 那一趟不过闸 —— 它本来就不推。
# 这台机器上没装工作台(或者就是不想装这一版)时用 `--skip-local-check "<理由>"`:理由必填,
# 会原样写进清单的 `local_check_skipped` 一格,公网上看得见这一版没过闸。
#
# ## 手机包必须是这会儿这份源码打出来的(2026-10-03,审计 C 条)
#
# **0928 连发四版,手机包每次都是同一份旧的**。apk 是在 `butler-app/` 里手工打的,而这个脚本
# 原来只看"文件在不在" —— 于是四版的清单都指着同一份旧包,手机上点「检查更新」拿到的还是旧的。
#
# 所以 `--with apk` 这一趟多一道:从包里读它**自己记的那行指纹**(`butler-app` 构建时写的
# `public/build.json`,包内路径 `assets/public/build.json`,形状
# `{"butler_app_tree":"<40 位十六进制>","built_at":"<ISO>","dirty":false,"version":"0.4.91","version_code":40091}`,
# 主人是 `butler-app/scripts/write-build-stamp.mjs`,见 `docs/交接-1003-手机包指纹.md`
# 与 `docs/交接-1003-手机应用内更新.md`),跟这会儿仓库里那棵树(`git rev-parse HEAD:butler-app`)
# 与这一版的版本号比。**四种都 die,一个字节都不推**:
#
#   ① 包里压根没有那一份(10-03 之前打的旧包)—— 读不出来不等于没问题;
#   ② 指纹对不上(那就是 0928 那四版的样子);
#   ③ `dirty: true` —— 打包那会儿 `butler-app/` 底下有没提交的改动:tree id 与 HEAD 一致、
#      ① ② 两道都过,而包里的字节并不是那个 tree 的字节;
#   ④ `version` 与这一版的版本号不相等(2026-10-03,卡 claude/phone-in-app-update)——
#      手机端的「有没有新版」就是拿包里那个 `versionName`(与 `version` 同一个数)跟清单里
#      apk 那一格的版本比。butler-app 两版之间一个字没改时那棵树的 id 是一样的,拿 0.4.90 打的包
#      发 0.4.91 ① ② ③ 全过,而手机装上去还是 0.4.90 → **永远显示「有新版 0.4.91」的死循环**。
#
# 实在要跳过:`--skip-apk-check "<理由>"`(理由必填,会写进清单的 `apk_check_skipped` 一格,
# 公网上看得见这一版没核过)。
#
# ## 发完之后本机也走一遍真正的更新路(2026-10-03)
#
# **闸只装插件**,而一次发版里真正会变的往往是另外几样。0.4.89 发完那十分钟就是这样:
# 闸把插件装上了,`8791/update/check` 回的是 `current == latest == 0.4.89`,设置里写着
# 「没有更新」—— 而事务官后端(没有语气代码)与电话工人(没有中文打断)**都还是旧的**,
# 亲手按一次「立即更新」回的是「已经是最新的了」。
#
# 判法已经改了(`update/service.ts` 的第 ③ 档:版本号一样也认「还有组件没装到本机」),
# 这一段就是在发版那一趟顺手把它走掉:`POST 8791/update/apply` → 盯着 `/update/job/<id>`
# → 等它装完重启起来 → 再 `update/check` 核一遍「一样都不差了」。
#
# **这一趟失败只打印,不算发版失败**:公网已经对了(第 5 段推完了),这一条是"顺手",
# 不是"前提"。`--no-local-apply` 关掉它。
#
# **跳过本机闸的那一趟也不走这一段**(两个开关一起):`--skip-local-check` 的两个用处都要它 ——
# 不在装着工作台的机器上发版时根本没有 8791 可按;而自改闭环(`/feature/ship` 第 ⑥ 步)
# 跑在工作台自己的进程里,这里按下去那一下重启会把它杀在决策记录落盘之前
# (它自己的第 ⑧ 步会在记录之后按,见 `server/selfUpdate.ts` 的 `SELF_SHIP_SKIP_LOCAL_CHECK`)。
#
# ## 每一版顺手打一个源码包(2026-10-03)
#
# 发完之后跑一遍 `deploy/make-source-kit.sh <版本>`,出 `dist/工作台源码包-<版本>.zip`,**不上传**
# (先微信给运营同学;放进更新清单让工作台自己下是另一张卡)。它的基线是打包那一刻的提交,
# 所以每版重打一次,她手上那份才不会越落后越难合。`--no-kit` 跳过。
# 它**不是 `--with` 的一格**:那一格是"要推上去的产物",而源码包不上传。
#
# ## 默认只发小的那三样
#
# 插件 tgz(约 1MB)+ 启动脚本(几 KB)+ DSH 运行环境的锁定清单(几十 KB)。绝大多数发版只动
# 网页与插件,而事务官后端(41M)与通话组件(349M)极少变 —— 让每次更新都拖着 390MB 走一趟,
# 等于把"更新"变成一件用户不愿意点的事。要发它们就显式点名:
#
#     bash deploy/publish-update.sh --with butler,worker --notes "…"
#     bash deploy/publish-update.sh --with all --notes "…"
#
# 能点名的:plugin、scripts、runtime(这三样**必带**)、shell、butler、worker、livekit、apk、installer、all。
#
# ## 本机通话服务(livekit)那一格(2026-10-21,局域网主路卡 M1)
#
# `--with livekit` 出 `livekit.tgz`(17MB 上下),清单里记成 `livekit_tgz`:`livekit/livekit-server`(由
# `deploy/fetch-livekit.sh` 取 Homebrew bottle、核两道 sha256、用同一张证书重签)+ LICENSE / NOTICE + 它自己的
# 启动脚本与开机自启模板(启动脚本那一份没变、不下的机器上,装它的那一步也补得上 launchd 项)。
# 没重打就照上一版原样带上(carry)。**第一次带上它的那一版**,发版机自己的本机房间是发完之后那一趟「本机也走一遍更新路」装上的
# (闸只看不装:还没装就跳过那一下并说一句)。本机房间这一下不想验:`--skip-livekit-check "<理由>"`。
#
# ## 电脑安装包(installer)那一格(2026-09-26,卡 SM)
#
# `--with installer` 把 `dist/工作台安装器-<版本>.dmg` 一起推上去,清单里记成 `installer_dmg` 一格
# (url / sha256 / size)。为什么要它:安装包本来只有一个**手工拷来的、带版本号的地址**,
# 网页上的「下载地址」每发一版都要有人去改一行,改漏了就指着一版旧的。清单本来就是
# 「这一版的东西都在哪」的唯一出处,所以 latest.json 就是那个稳定入口。
#
# **已经装好的机器不下载它**(同 apk):它只出现在设置 → 更新那一格的一个链接里,
# 给**另一台**机器装用。它也进 carry(没重打就照上一版原样带上)—— 安装包几分钟才打一次,
# 而每一版的清单都该答得出「安装包在哪」。
#
# `all` 里**不含 installer**:`--with all` 是"把能打的都打一遍",而安装包由
# `deploy/build-installer.sh` 另外打(100MB 上下),不该被一个 all 顺手带上。
#
# **启动脚本每一版都带**(2026-09-25,卡 R 补):原来 `--with butler` 会把默认那份清单整个换掉,
# scripts 就悄悄不带了 —— 那一版里改过的 dsh-start(比如去掉某台机器的代理那一行)就到不了用户那边,
# 而他跳着升级时只看最新那一份清单。它只有几 KB,客户端按 sha256 比,没变就不装;
# 变了就由更新那一趟换进 ~/.dsh/bin/,更新最后那一下重启(launchctl kickstart)就用上新的。
#
# **运行环境清单也每一版都带**(2026-09-25,卡 U1,升 DSH 0.1.7):同样的道理,而且更硬 ——
# 这是**已经装过的机器换 DSH 版本的唯一通道**。在这之前热更新压根没有"换运行环境"这一步,
# 已装用户只能重新下 dmg 才能换 DSH。它几十 KB,客户端按 sha256 比,没变就不下不装。
#
# ## 没重打的那几样,照上一版清单原样带上(2026-09-26,卡 U8)
#
# 0.4.1 用 `--with shell` 发,清单里就**没有 apk 那一格**了 —— 这台 Mac 设置里的「手机包」随之变空,
# Pixel 下不了。根因:清单是每次从零写的,只写这一趟真打出来的几样;而客户端与手机看的只有
# **最新那一份清单**,上一版的清单没人再看。所以:
#
#   没重打的那几样(apk、通话组件、事务官后端、壳),从服务器上现有的 latest.json 里
#   **原样抄过来**(同一个 url、同一个 sha256、同一个 size),并记一句 `from_version`
#   说明这一格出自哪一版。
#
# 抄过来是安全的:① 旧版本的目录**从不删**(下面 rsync 那一段不带 `--delete`),所以那个 url 一直下得到;
# ② 客户端认的是 sha256,与他机器上装着的那份一样就不下不装(update/installed.ts);
# ③ 同源校验照过(同一台服务器、只是版本目录不同,manifest.ts 的第 2 条)。
#
# `from_version` 还管一件事:**「有新的手机包」不许乱报**。抄过来的 apk 一个字节没变,
# 报一句「手机包有新的了」等于骗他去重下一份一样的 —— 所以那一格只在这一版真重打了 apk 时才给,
# 抄过来的只出现在「电脑上那份清单里的手机包 · 重新下载手机包」那一格(它本来就与版本无关)。
#
# 读不到上一版清单(第一次发、这会儿没网)时不抄,并在输出里**大声说一句** —— 那一版的清单
# 就只有这一趟打的几样,和 0.4.1 一样的坑。要故意丢掉某一格(某件产物不再发了)用 `--no-carry`。
#
# ## 壳(shell)那一样要想清楚再发
#
# 用户那边只有在**签名身份与他现在装的那份逐字相同**时才会换壳,否则会跳过并说一句
# 「换了要重新授权辅助功能」。所以发壳之前先确认这台机器上有那张长期证书
# (`bash deploy/codesign-identity.sh --resolve` 不回 `-`),否则发上去等于白发。
#
# ## 参数
#
#   --notes <一段话>     这一版改了什么。**给不懂代码的人看的人话**,会原样显示在设置里。
#   --notes-file <文件>  同上,从文件读(多行)。
#   --version <版本号>   默认取 workbench-plugin/package.json 里的 version。
#   --with <清单>        逗号分隔,见上。
#   --min-installer <v>  低于这个版本的机器升不过来,要重新下 dmg。默认不写这一条。
#   --base-url <地址>    产物在公网上的前缀。默认 https://api.aibooo.cn/updates
#                        (插件里编进去的更新清单地址见下一节「构建注入」:真推的那一趟两边必须对得上)
#   --host <ssh 名>      默认 aiboo-server。
#   --remote-dir <路径>  默认 /var/lib/relay/updates
#   --out <目录>         本地暂存目录。默认 dist/updates
#   --channel <通道>     stable 或 hotfix(缺省 hotfix)。见上面「两条通道」。
#   --dry-run            干跑:构建、写清单、(稳定版)演练照做,然后把「要推什么、推到哪个文件名」打出来就停 ——
#                        **不过本机闸、不 rsync、不在本机按更新、不打源码包**。
#   --skip-rehearse <理由>  稳定版跳过新机器演练。**理由必填**,写进清单的 rehearse_skipped 一格。
#   --no-upload          只在本地产出产物与清单,**不 rsync**(验收用)。闸、本机更新路与源码包都不走。
#   --intent-min <0-100>      回归门的线(2026-10-28):本机闸第 4¾ 下读 workbench-plugin/dev/intent-regression/report.json 的通过率,
#                             低于线不推。缺省 100(维护者 10-28 定:一行不对就不推公网);环境 INTENT_GATE_MIN 设成空串 = 不定线,只把通过率写进清单的 intent_regression 一格,不挡。
#   --skip-local-check <理由>  跳过本机闸(**连本机更新路一起跳**)。**理由必填**,会写进清单的 local_check_skipped 一格。
#   --gate-settle <秒>   本机闸「起来之后再等多久读 /state」(缺省 10)。机器负载高时(几张卡并行跑用例)
#                        起来后那一拍 /state 要算整份状态,20 秒内回不来会被当成「崩了」—— 0.4.114 第一趟就是这样,
#                        那会儿负载 75;给它多等一会儿,不是跳过闸。
#   --skip-apk-check <理由>    跳过「手机包是不是这份源码打的」那道核对。**理由必填**,写进清单的 apk_check_skipped 一格。
#   --skip-livekit-check <理由> 本机闸里「本机房间回 200」那一下跳过(**理由必填**,原样递给闸)。插件那几下照验。
#   --no-local-apply     发完之后不在本机按「立即更新」(闸装的插件照旧装)。
#   --local-base <地址>  本机工作台在哪。缺省 http://127.0.0.1:${WORKBENCH_PORT:-8791}
#   --no-kit             这一趟不打源码包。
#   --no-carry           这一趟没打的那几样**不**从上一版清单抄(某件产物不再发了才用)。
#   --installer <文件>   安装包在哪(默认 dist/工作台安装器-<版本>.dmg)。只跟 --with installer 一起用。
#
# ## 构建注入(2026-10-21,局域网 M7「零服务器是缺省」)
#
# 插件源码里不写中转与更新清单地址,构建时由 `workbench-plugin/scripts/build-endpoints.mjs` 定
# (环境变量 `WORKBENCH_BUILD_RELAY_URL` / `WORKBENCH_BUILD_UPDATE_URL` 压过 `deploy/release-endpoints.env`)。
# 这一趟打完会核产物;**真推的那一趟**(没有 --no-upload)还要求:两样都带着、更新清单地址正是 `<--base-url>/latest.json` ——
# 推一份不带中转的插件上去,装上它的每台机器从此不再查更新。
#
# 产物**不进 git**(dist/ 在 .gitignore 里),这个脚本进 git。

set -euo pipefail

REPO_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
VERSION=""
NOTES=""
# 回归门(2026-10-28,第 4¾ 下):回归集报告由 harness 写在这里;线缺省 100(维护者 10-28 16:5x 定:回归集一行不对就不推公网,
# 本机照装),环境 INTENT_GATE_MIN 或 --intent-min 可临时盖(设成空串 = 不定线只公示)。
INTENT_MIN="${INTENT_GATE_MIN-100}"
INTENT_REPORT="$REPO_ROOT/workbench-plugin/dev/intent-regression/report.json"
WITH="plugin,scripts,runtime"
MIN_INSTALLER=""
BASE_URL="https://api.aibooo.cn/updates"
SSH_HOST="aiboo-server"
REMOTE_DIR="/var/lib/relay/updates"
OUT="$REPO_ROOT/dist/updates"
UPLOAD=1
CARRY=1
# 两条通道(文件头「两条通道」)。两个文件名与客户端 update/types.ts 的 UPDATE_CHANNEL_MANIFEST 逐字相同(有用例比对)。
CHANNEL="hotfix"
STABLE_MANIFEST_NAME="latest.json"
HOTFIX_MANIFEST_NAME="beta.json"
DRY_RUN=0
# 稳定版跳过新机器演练的理由(空 = 要演练)。
SKIP_REHEARSE_WHY=""
# 本机闸跳过的理由(空 = 要过闸)。见文件头「本机闸」那一节。
SKIP_WHY=""
# 「手机包是不是这份源码打的」那道核对跳过的理由(空 = 要核)。见文件头那一节。
SKIP_APK_WHY=""
# 本机闸里「本机房间回 200」那一下跳过的理由(空 = 要验)。
SKIP_LIVEKIT_WHY=""
# 发完之后在本机按一次「立即更新」(闸只装插件,别的几样靠这一趟)。见文件头那一节。
LOCAL_APPLY=1
LOCAL_BASE="http://127.0.0.1:${WORKBENCH_PORT:-8791}"
# 盯那条更新作业最多多久:通话组件 349MB,慢网上半小时并不夸张(同 apply.ts 的下载上限口径)。
LOCAL_APPLY_WAIT=1800
# 多久问一次。
LOCAL_APPLY_POLL=5
# 装完那一下会重启工作台,等一拍再去问「还差几样」—— 不等的话问到的可能是正要死掉的那个进程。
LOCAL_APPLY_SETTLE=15
# 重启之后等它回来最多多久。
LOCAL_APPLY_BACK=120
# 顺手打源码包(卡「发版闸 + 每版自动打源码包」,维护者 10-03 拍板 ②)。
KIT=1
# 安装包(dmg)在哪。`deploy/build-installer.sh` 就打在这儿。
INSTALLER_DMG=""
INSTALLER_NAME=""

while [ $# -gt 0 ]; do
  case "$1" in
    --notes) shift; NOTES="${1:-}" ;;
    --notes-file) shift; NOTES="$(cat "${1:-/dev/null}")" ;;
    --version) shift; VERSION="${1:-}" ;;
    --with) shift; WITH="plugin,scripts,runtime,${1:-}" ;;
    --gate-settle) shift; GATE_SETTLE="${1:-}" ;;
    --intent-min) shift; INTENT_MIN="${1:-}" ;;
    --min-installer) shift; MIN_INSTALLER="${1:-}" ;;
    --base-url) shift; BASE_URL="${1:-}" ;;
    --host) shift; SSH_HOST="${1:-}" ;;
    --remote-dir) shift; REMOTE_DIR="${1:-}" ;;
    --out) shift; OUT="${1:-}" ;;
    --no-upload) UPLOAD=0 ;;
    --dry-run) DRY_RUN=1; UPLOAD=0 ;;
    --channel)
      shift; CHANNEL="${1:-}"
      case "$CHANNEL" in
        stable|hotfix) ;;
        *) echo "--channel 只认 stable 或 hotfix(给的是「${CHANNEL}」)。" >&2; exit 1 ;;
      esac ;;
    --skip-rehearse)
      shift; SKIP_REHEARSE_WHY="${1:-}"
      case "$SKIP_REHEARSE_WHY" in
        ''|-*) echo "--skip-rehearse 要跟一句**理由**(为什么这一版稳定版不在新机器上演练)。
     它会原样写进公网清单的 rehearse_skipped 一格,所以写「skip」这种等于没写。" >&2; exit 1 ;;
      esac ;;
    --no-carry) CARRY=0 ;;
    # 理由必填:没理由的跳过等于把这道闸悄悄关掉(say/die 还没定义,这里自己退)。
    --skip-local-check)
      shift; SKIP_WHY="${1:-}"
      case "$SKIP_WHY" in
        ''|-*) echo "--skip-local-check 要跟一句**理由**(为什么这一版不在本机验)。
     它会原样写进公网清单的 local_check_skipped 一格,所以写「skip」这种等于没写。" >&2; exit 1 ;;
      esac ;;
    # 同上,理由必填:0928 连发四版旧手机包就是因为这一条当时压根不存在。
    --skip-apk-check)
      shift; SKIP_APK_WHY="${1:-}"
      case "$SKIP_APK_WHY" in
        ''|-*) echo "--skip-apk-check 要跟一句**理由**(为什么这一版不核手机包是不是新打的)。
     它会原样写进公网清单的 apk_check_skipped 一格,所以写「skip」这种等于没写。" >&2; exit 1 ;;
      esac ;;
    --skip-livekit-check)
      shift; SKIP_LIVEKIT_WHY="${1:-}"
      case "$SKIP_LIVEKIT_WHY" in
        ''|-*) echo "--skip-livekit-check 要跟一句**理由**(为什么这一版不验本机房间)。" >&2; exit 1 ;;
      esac ;;
    --no-local-apply) LOCAL_APPLY=0 ;;
    --local-base) shift; LOCAL_BASE="${1:-}" ;;
    --no-kit) KIT=0 ;;
    --installer) shift; INSTALLER_DMG="${1:-}" ;;
    # 头注释到 `set -euo` 之前那一行为止(0925 加了 runtime 那一段,头注释长了,
    # 写死的 50 会把「参数」那一节切掉一半 —— 所以按 set 那一行现算)。
    --help|-h) sed -n "2,$(($(awk '/^set -euo/{print NR; exit}' "${BASH_SOURCE[0]}") - 1))p" "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "不认识的参数:$1(--help 看能用的)" >&2; exit 1 ;;
  esac
  shift
done

say() { printf '\n▸ %s\n' "$1"; }
info() { printf '  %s\n' "$1"; }
die() { printf '\n×  %s\n' "$1" >&2; exit 1; }

want() { case ",$WITH," in *,all,*) return 0 ;; *",$1,"*) return 0 ;; *) return 1 ;; esac; }
# 安装包要**点名**才发,`--with all` 不算(理由见头注释那一节):它由 build-installer.sh 另外打,
# 100MB 上下,不该被一个 all 顺手带上。
want_installer() { case ",$WITH," in *,installer,*) return 0 ;; *) return 1 ;; esac; }

# ───────────────────────── 1. 体检 ─────────────────────────

say "看一眼手边的工具"
for tool in node npm pnpm tar ditto shasum rsync; do
  command -v "$tool" >/dev/null 2>&1 || die "缺 $tool。"
done
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
[ "$NODE_MAJOR" -ge 24 ] || die "要 node ≥ 24(现在是 $NODE_MAJOR)。"

if [ -z "$VERSION" ]; then
  VERSION="$(node -p "require('$REPO_ROOT/workbench-plugin/package.json').version")"
fi
# 安装包带版本号(2026-09-27):文件名与 build-installer.sh 打出来的一致;旧版目录里的老名字照旧 carry。
INSTALLER_NAME="工作台安装器-$VERSION.dmg"
case "$VERSION" in
  [0-9]*) ;;
  *) die "版本号看着不对:$VERSION(要以数字开头)" ;;
esac

if [ -z "$NOTES" ]; then
  die "这一版改了什么?用 --notes \"…\" 写一句**人话**。
     它会原样显示在用户的设置 → 更新里 —— 那是他决定要不要点「立即更新」的唯一依据。
     写「bump version」「misc fixes」这种等于没写。"
fi

say "看一眼签名身份"
SIGN_ID="$(bash "$REPO_ROOT/deploy/codesign-identity.sh" --resolve 2>/dev/null || echo '-')"
if [ "$SIGN_ID" = "-" ]; then
  info "ad-hoc(没有长期证书)。"
  if want shell; then
    die "要发壳(shell),但这台机器上没有那张长期证书 —— 发上去用户那边会**整步跳过**
     (签名身份对不上就不换壳,免得把他的辅助功能授权弄掉)。
     先跑一遍 \`bash deploy/codesign-identity.sh\` 再来,或者这次别发壳。"
  fi
else
  info "工作台本机签名($SIGN_ID)"
fi

say "要发的是哪一版"
info "版本 $VERSION"
info "通道:$CHANNEL($([ "$CHANNEL" = stable ] && echo "稳定版:写 $STABLE_MANIFEST_NAME 并同时更新 $HOTFIX_MANIFEST_NAME" || echo "热修:只写 $HOTFIX_MANIFEST_NAME,$STABLE_MANIFEST_NAME 不动"))"
info "带上:$(echo "$WITH" | tr ',' ' ')"
# 服务器上两份清单各是哪一版(拿不到不算失败:第一次发、热修那份还没发过、或者这会儿没网)。
# **整份存下来**:下面「没重打的那几样照上一版原样带上」要从较新的那一份里抄(卡 U8)。
# 存在 $OUT 里的点文件:rsync 只推 $STAGE/ 与清单,它们上不去。
mkdir -p "$OUT"
PREV_STABLE="$OUT/.previous-latest.json"
PREV_HOTFIX="$OUT/.previous-beta.json"
# 一份清单里的版本号;取不到 / 不是合法清单就空,并把那个文件删掉(也不拿它抄)。
remote_manifest_version() {
  local name="$1" file="$2" got=""
  rm -f "$file"
  curl -fsS --connect-timeout 8 -o "$file" "$BASE_URL/$name" 2>/dev/null || rm -f "$file"
  if [ -f "$file" ]; then
    got="$(node -e '
      const fs = require("node:fs");
      try { process.stdout.write(String(JSON.parse(fs.readFileSync(process.argv[1], "utf8")).version ?? "")); }
      catch { /* 不是合法清单就空着 */ }
    ' "$file" || true)"
    [ -n "$got" ] || rm -f "$file"
  fi
  printf '%s' "$got"
}
# a 比 b 新吗。规矩与客户端 update/manifest.ts 的 compareVersions 一模一样(数字段按数值比、
# 带预发布尾巴的小于同号正式版),**抄在这里而不是去 import 那个文件**:import 失败会被当成「不新」,
# 一个读不到文件的错就悄悄变成「不许发」。两边由 release-channels.test.ts 拿同一张表对着跑。
version_newer() {
  node -e '
    const split = v => { const [core = "", ...rest] = v.trim().split("-"); const pre = rest.join("-"); return { main: core.split("."), pre: pre === "" ? [] : pre.split(".") } };
    const parts = (x, y) => {
      for (let i = 0; i < Math.max(x.length, y.length); i += 1) {
        const xs = x[i], ys = y[i];
        if (xs === undefined) return ys === undefined ? 0 : (Number(ys) === 0 ? 0 : -1);
        if (ys === undefined) return Number(xs) === 0 ? 0 : 1;
        const xn = /^\d+$/.test(xs) ? Number(xs) : undefined, yn = /^\d+$/.test(ys) ? Number(ys) : undefined;
        if (xn !== undefined && yn !== undefined) { if (xn !== yn) return xn < yn ? -1 : 1; continue }
        if (xn !== undefined) return -1;
        if (yn !== undefined) return 1;
        if (xs !== ys) return xs < ys ? -1 : 1;
      }
      return 0;
    };
    const a = split(process.argv[1]), b = split(process.argv[2]);
    let c = parts(a.main, b.main);
    if (c === 0) c = a.pre.length === 0 && b.pre.length === 0 ? 0 : a.pre.length === 0 ? 1 : b.pre.length === 0 ? -1 : parts(a.pre, b.pre);
    process.exit(c > 0 ? 0 : 1);
  ' "$1" "$2"
}
STABLE_REMOTE_VERSION="$(remote_manifest_version "$STABLE_MANIFEST_NAME" "$PREV_STABLE")"
HOTFIX_REMOTE_VERSION="$(remote_manifest_version "$HOTFIX_MANIFEST_NAME" "$PREV_HOTFIX")"
info "服务器上:稳定版 ${STABLE_REMOTE_VERSION:-(没读到)},热修 ${HOTFIX_REMOTE_VERSION:-(没读到 —— 还没发过热修,或者这会儿没网)}"
# 较新的那一份:版本号门槛与「照上一版原样带上」都认它。
REMOTE_VERSION="$STABLE_REMOTE_VERSION"
PREV_MANIFEST="$PREV_STABLE"
if [ -n "$HOTFIX_REMOTE_VERSION" ] && { [ -z "$REMOTE_VERSION" ] || version_newer "$HOTFIX_REMOTE_VERSION" "$REMOTE_VERSION"; }; then
  REMOTE_VERSION="$HOTFIX_REMOTE_VERSION"
  PREV_MANIFEST="$PREV_HOTFIX"
fi
if [ -n "$REMOTE_VERSION" ]; then
  [ "$REMOTE_VERSION" = "$VERSION" ] && die "服务器上已经是 $VERSION 了。先 bump workbench-plugin/package.json 的 version,或者 --version 指一个新的。"
  version_newer "$VERSION" "$REMOTE_VERSION" \
    || die "要发的 $VERSION 不比服务器上较新的那一版($REMOTE_VERSION)新。
     两条通道共用一串版本号:热修发过的版本,稳定版要从它后面那一个起。先 bump workbench-plugin/package.json 的 version。"
else
  info "两份清单都没读到(第一次发,或者这会儿没网)—— 照发,但发完自己 curl 一下确认。"
fi

STAGE="$OUT/$VERSION"
rm -rf "$STAGE"
mkdir -p "$STAGE"

# ───────────────────────── 2. 构建 ─────────────────────────

say "构建工作台插件(pnpm build → npm pack)"
[ -x "$REPO_ROOT/workbench-plugin/node_modules/.bin/tsdown" ] || die "workbench-plugin 还没装依赖:先 cd workbench-plugin && pnpm install。"
PACKED="$STAGE/.packed"
mkdir -p "$PACKED"
(cd "$REPO_ROOT/workbench-plugin" && pnpm build >/dev/null && npm pack --pack-destination "$PACKED" >/dev/null)
# 构建注入(见头注释那一节):编进去的是哪一份、对不对得上。
ENDPOINTS_CHECK="$(cd "$REPO_ROOT/workbench-plugin" && node scripts/build-endpoints.mjs --check lib/index.js)" \
  || die "插件产物里编进去的中转地址与构建档对不上(上面那句)。"
info "${ENDPOINTS_CHECK#*:}"
if [ "$UPLOAD" = "1" ]; then
  BUILT_RELAY="$(cd "$REPO_ROOT/workbench-plugin" && node -e "import('./scripts/build-endpoints.mjs').then(m => console.log(m.resolveBuildEndpoints().relay_url))")"
  BUILT_UPDATE="$(cd "$REPO_ROOT/workbench-plugin" && node -e "import('./scripts/build-endpoints.mjs').then(m => console.log(m.resolveBuildEndpoints().update_manifest_url))")"
  [ -n "$BUILT_RELAY" ] || die "这一份插件没带中转地址(开源档)。推上去,装上它的机器就接不上中转 —— 真推要用我们的构建档(deploy/release-endpoints.env)。"
  [ "$BUILT_UPDATE" = "${BASE_URL%/}/latest.json" ] \
    || die "插件里编进去的更新清单是 $BUILT_UPDATE,这一趟却推到 ${BASE_URL%/}/latest.json —— 装上它的机器会去别处查更新。两边对齐了再推。"
fi
TGZ="$(ls "$PACKED"/*.tgz | head -1)"
[ -n "$TGZ" ] || die "npm pack 没出 .tgz。"
# 打出来的包名里带版本号 —— 顺手核对一下,免得发了个版本号对不上的包。
case "$(basename "$TGZ")" in
  *"$VERSION"*) ;;
  *) die "打出来的包是 $(basename "$TGZ"),跟要发的版本 $VERSION 对不上。" ;;
esac
mv "$TGZ" "$STAGE/plugin.tgz"
rm -rf "$PACKED"
info "plugin.tgz($(du -h "$STAGE/plugin.tgz" | cut -f1))"

if want scripts; then
  say "打启动脚本与 plist"
  # **按仓库相对路径打**,解开就是仓库的样子 —— 客户端那几步(setup/install.ts)
  # 要的本来就只是「仓库里的那几个文件」,而不是「一个真的 git 仓库」。
  tar -czf "$STAGE/scripts.tgz" -C "$REPO_ROOT" \
    workbench-plugin/bin/dsh-start \
    workbench-plugin/bin/butler-start \
    deploy/channel-start \
    deploy/livekit-start \
    deploy/ai.deepseek.dsh.plist \
    butler-server/launchd/ai.deepseek.butler.plist \
    deploy/ai.deepseek.livekit.plist
  info "scripts.tgz($(du -h "$STAGE/scripts.tgz" | cut -f1))"
fi

if want runtime; then
  say "打 DSH 运行环境的锁定清单"
  # **每一版都带**(几十 KB),理由与 scripts 那一样相同,而且更硬:这是**已经装过的机器
  # 换 DSH 版本的唯一通道**(update/types.ts 里 `runtime_tgz` 那一段)。在 2026-09-25 之前
  # 热更新没有这一步,于是已装用户永远停在他当初那个安装包里的那一版 DSH 上。
  #
  # 发清单、不发那 500MB 的依赖树:客户端照清单 `npm ci`,每个包由 resolved + integrity
  # 钉死,装出来与这边逐字节相同;慢网上"几十 KB"与"半小时"的差别,就是用户点不点这个按钮。
  #
  # **这条路径与 apply.ts 的 `RUNTIME_LOCK_PAYLOAD_DIR` 逐字相同**(两边各有用例钉着):
  # 解进 payload 之后正好落在"仓库的样子"里那个位置,运行时那一步从那儿读。
  RUNTIME_LOCK_DIR="workbench-plugin/src/server/setup/dsh-runtime"
  for f in runtime.package.json runtime.package-lock.json; do
    [ -f "$REPO_ROOT/$RUNTIME_LOCK_DIR/$f" ] || die "仓库里没有 $RUNTIME_LOCK_DIR/$f,不发。"
  done
  # 清单锁的是哪一版 dsh —— 打包前跟 paths.ts 的 LOCKED_DSH_VERSION 对一次。
  # 只改了常量没重生成清单(或反过来)就停在这里:那样的包发出去,用户装的是另一版 DSH,
  # 而更新页上会说"已经是最新的了"。
  RUNTIME_DSH="$(node -p "require('$REPO_ROOT/$RUNTIME_LOCK_DIR/runtime.package-lock.json').packages['node_modules/@deepseek-ai/dsh'].version" 2>/dev/null || true)"
  LOCKED_DSH="$(node -e "
    import('$REPO_ROOT/workbench-plugin/src/server/setup/paths.ts')
      .then(m => process.stdout.write(m.LOCKED_DSH_VERSION))
  " 2>/dev/null || true)"
  [ -n "$RUNTIME_DSH" ] || die "读不出锁定清单里 @deepseek-ai/dsh 的版本($RUNTIME_LOCK_DIR/runtime.package-lock.json)。"
  [ "$RUNTIME_DSH" = "$LOCKED_DSH" ] || die "锁定清单锁的是 dsh $RUNTIME_DSH,paths.ts 的 LOCKED_DSH_VERSION 是 ${LOCKED_DSH:-(读不出来)} —— 两处对不上,不发。
     换 DSH 版本要**一起**重生成那两份清单(步骤见 workbench-plugin/src/server/setup/dshRuntimeLock.ts 文件头);
     先跑 pnpm vitest run tests/dsh-runtime-lock.test.ts 看它红在哪。"
  tar -czf "$STAGE/runtime.tgz" -C "$REPO_ROOT" \
    "$RUNTIME_LOCK_DIR/runtime.package.json" \
    "$RUNTIME_LOCK_DIR/runtime.package-lock.json"
  info "runtime.tgz($(du -h "$STAGE/runtime.tgz" | cut -f1),锁的是 dsh $RUNTIME_DSH)"
  info "用户那边:照这份清单 npm ci 装进 ~/.dsh/runtime-next,核过关键包版本再原子换名;"
  info "          装失败或核不过,他在用的那份运行环境一个字节不动;换下来的旧那份留在 ~/.dsh/runtime-prev。"
fi

if want shell; then
  say "构建壳(工作台.app)并打成 zip"
  (cd "$REPO_ROOT/workbench-app" && ./build.sh) >"$STAGE/.build-shell.log" 2>&1 \
    || { sed 's/^/    /' "$STAGE/.build-shell.log" >&2; die "壳没构建出来(上面是它的输出)。"; }
  [ -d "$REPO_ROOT/workbench-app/build/工作台.app" ] || die "壳没构建出来。"
  # ditto 而不是 zip:.app 里有符号链接与扩展属性,zip 会弄丢它们。
  # --keepParent 让 zip 里最外层就是「工作台.app」,客户端解开直接拿得到。
  ditto -c -k --sequesterRsrc --keepParent "$REPO_ROOT/workbench-app/build/工作台.app" "$STAGE/shell-app.zip"
  rm -f "$STAGE/.build-shell.log"
  SHELL_REQ="$(codesign -d -r - "$REPO_ROOT/workbench-app/build/工作台.app" 2>/dev/null | sed -n 's/^#\{0,1\} *designated => //p')"
  info "shell-app.zip($(du -h "$STAGE/shell-app.zip" | cut -f1))"
  info "requirement:${SHELL_REQ:-(读不出来)}"
  info "用户那边只有在他现在装的那份 requirement 与这一条逐字相同时才会换壳。"
fi

if want butler; then
  say "打事务官本机后端(连 node_modules)"
  (cd "$REPO_ROOT/butler-server" && pnpm install --frozen-lockfile --prefer-offline >/dev/null 2>&1 || pnpm install --prefer-offline >/dev/null)
  if [ -d "$REPO_ROOT/butler-server/admin-ui" ]; then
    (cd "$REPO_ROOT/butler-server/admin-ui" && pnpm build >/dev/null 2>&1) \
      || info "admin-ui 没构建成 —— 用仓库里已有的 dist/"
  fi
  for dep in $(node -e 'console.log(Object.keys(require(process.argv[1]).dependencies||{}).join(" "))' "$REPO_ROOT/butler-server/package.json"); do
    [ -e "$REPO_ROOT/butler-server/node_modules/$dep" ] || die "butler-server 缺依赖 $dep,不发(0918 真机踩过:少了 ws 就是 8792 起不来)"
  done
  tar -czf "$STAGE/butler-server.tgz" -C "$REPO_ROOT" \
    butler-server/server butler-server/package.json \
    $([ -d "$REPO_ROOT/butler-server/admin-ui/dist" ] && echo butler-server/admin-ui/dist) \
    butler-server/node_modules
  info "butler-server.tgz($(du -h "$STAGE/butler-server.tgz" | cut -f1))"
fi

if want worker; then
  say "打通话组件(deploy/pack-channel-worker.sh)"
  # **只装生产依赖 + 砍掉用不到的原生库**,而且打完会在那棵树上真起一次(--selfcheck)。
  # 砍哪几样、凭什么敢砍,全写在那个脚本开头 —— 出安装包(build-installer.sh)用的也是它,
  # 免得两边各写一段 exclude、改一处漏一处。108MB → 37MB(2026-09-18 实测)。
  bash "$REPO_ROOT/deploy/pack-channel-worker.sh" --tar "$STAGE/channel-worker.tgz" \
    || die "通话组件没打出来(上面是它的输出)。"
  info "channel-worker.tgz($(du -h "$STAGE/channel-worker.tgz" | cut -f1))"
fi

if want livekit; then
  say "打本机通话服务(deploy/fetch-livekit.sh)"
  # 与出安装包同一段取法(两道 sha256、同一张证书重签);解进 payload 之后正好是安装那一步找的位置。
  LK_STAGE="$STAGE/.livekit"
  rm -rf "$LK_STAGE"
  bash "$REPO_ROOT/deploy/fetch-livekit.sh" --into "$LK_STAGE" --sign "$SIGN_ID" \
    || die "本机通话服务没打出来(上面是它的输出)。"
  mkdir -p "$LK_STAGE/deploy"
  cp "$REPO_ROOT/deploy/livekit-start" "$REPO_ROOT/deploy/ai.deepseek.livekit.plist" "$LK_STAGE/deploy/"
  tar -czf "$STAGE/livekit.tgz" -C "$LK_STAGE" livekit deploy/livekit-start deploy/ai.deepseek.livekit.plist
  rm -rf "$LK_STAGE"
  info "livekit.tgz($(du -h "$STAGE/livekit.tgz" | cut -f1))"
  [ "$SIGN_ID" = "-" ] && info "!! ad-hoc 签的:用户每换一次这个二进制,系统防火墙就要再问一次「允许传入连接」。"
fi

if want_installer; then
  say "带上电脑安装包(dmg)"
  # 安装包不在这里打(`deploy/build-installer.sh` 打,几分钟,而且要壳先构建好)——
  # 这一步只把已经打好的那一份带上并记进清单。文件名带版本号(2026-09-27 起);
  # 更早的版本目录里是不带版本号的老名字,carry 过来的 url 照原样指回去。
  DMG_SRC="${INSTALLER_DMG:-$REPO_ROOT/dist/$INSTALLER_NAME}"
  [ -f "$DMG_SRC" ] || die "没有安装包($DMG_SRC)。先跑一次 bash deploy/build-installer.sh,或用 --installer 指一份。"
  cp "$DMG_SRC" "$STAGE/$INSTALLER_NAME"
  info "$INSTALLER_NAME($(du -h "$STAGE/$INSTALLER_NAME" | cut -f1))"
  info "已经装好的机器**不下载它**:清单里这一格只给设置 → 更新那一格的链接用(给另一台机器装)。"
fi

if want apk; then
  say "带上手机包"
  APK_SRC="$REPO_ROOT/butler-app/android/app/build/outputs/apk/debug/app-debug.apk"
  [ -f "$APK_SRC" ] || die "没有手机包($APK_SRC)。先在 butler-app/ 里跑一次 pnpm android:debug。"
  # ── 这份包是从哪一份源码打出来的(2026-10-03,审计 C 条)──
  # 0928 连发四版,手机包每次都是同一份旧的:apk 是在 butler-app/ 里手工打的,而这里原来
  # 只看"文件在不在",不看"它是什么时候打的" —— 四版的清单都指着同一份旧包,手机那边
  # 点了「检查更新」拿到的还是旧的。所以从包里读它**自己记的那行指纹**
  # (`butler-app` 构建时写的 `public/build.json`,包内路径 `assets/public/build.json`),
  # 跟这会儿仓库里 `butler-app` 那棵树比,对不上就不发。
  if [ -n "$SKIP_APK_WHY" ]; then
    info "!! **没核手机包是不是新打的**。理由:$SKIP_APK_WHY"
    info "!! 清单里记了一格 apk_check_skipped —— 公网上看得见这一版没核过。"
  else
    command -v unzip >/dev/null 2>&1 || die "缺 unzip —— 没法核手机包是不是这份源码打的(实在要跳过:--skip-apk-check \"<理由>\")。"
    command -v git >/dev/null 2>&1 || die "缺 git —— 读不出仓库里 butler-app 那棵树的 id。"
    # 一趟读三格:`<40 位 tree> <dirty|clean> <版本号|->`。
    # 形状不对(老包、写坏了)就印空的 —— 当"读不出来"。
    APK_STAMP="$( (unzip -p "$APK_SRC" assets/public/build.json 2>/dev/null || true) | node -e '
      let text = "";
      process.stdin.on("data", chunk => { text += chunk }).on("end", () => {
        try {
          const body = JSON.parse(text);
          const tree = typeof body.butler_app_tree === "string" ? body.butler_app_tree : "";
          if (!/^[0-9a-f]{40}$/.test(tree)) return;
          const version = typeof body.version === "string" && /^\d+\.\d+\.\d+$/.test(body.version) ? body.version : "-";
          process.stdout.write(`${tree} ${body.dirty === true ? "dirty" : "clean"} ${version}`);
        }
        catch { /* 老包里压根没有这一份,或者写坏了:当成"读不出来" */ }
      });
    ' 2>/dev/null || true )"
    APK_TREE="$(printf '%s' "$APK_STAMP" | awk '{print $1}')"
    APK_DIRTY="$(printf '%s' "$APK_STAMP" | awk '{print $2}')"
    APK_VERSION="$(printf '%s' "$APK_STAMP" | awk '{print $3}')"
    WANT_TREE="$( (cd "$REPO_ROOT" && git rev-parse HEAD:butler-app) 2>/dev/null || true)"
    [ -n "$WANT_TREE" ] || die "读不出仓库里 butler-app 那棵树的 id(git rev-parse HEAD:butler-app)。"
    if [ -z "$APK_TREE" ]; then
      die "这份手机包里没有构建指纹(包内 assets/public/build.json)—— 它是 10-03 之前打的那种旧包,
     没法确认它是不是这份源码打出来的。在 butler-app/ 里重打一次(pnpm build && pnpm android:debug),
     或者 --skip-apk-check \"<理由>\"。"
    fi
    if [ "$APK_TREE" != "$WANT_TREE" ]; then
      die "手机包不是这会儿这份源码打出来的:
     包里记的 butler-app 那棵树是 ${APK_TREE}
     仓库里这会儿是         ${WANT_TREE}
     **0928 连发四版旧手机包就是这条没守住**。在 butler-app/ 里重打一次再来,或者 --skip-apk-check \"<理由>\"。"
    fi
    # `dirty` 那一格:打包那会儿 `butler-app/` 底下有没提交的改动(含未跟踪文件)。
    # **也拒**(统筹 10-03 午定):那种包的 tree id 与 HEAD 一致、上面那一道照样过,
    # 而包里的字节并不是那个 tree 的字节 —— 发出去之后谁也说不清用户手上那一版到底是什么。
    if [ "$APK_DIRTY" = "dirty" ]; then
      die "这份手机包是在一棵**有没提交改动**的源码树上打的(包里 dirty:true):
     它的指纹写着 ${WANT_TREE},可那棵树当时还有改动没提交 —— 发出去就说不清用户手上那一版是什么了。
     先提交(或撤掉)butler-app/ 底下的改动,再重打一次;实在要发:--skip-apk-check \"<理由>\"。"
    fi
    # ── 包里那个版本号要与这一版的版本号相等(2026-10-03,卡 claude/phone-in-app-update)──
    # 上面两道只核「出自哪一份源码」。可手机包里**还写着自己的版本号**(`versionName`,
    # 与 build.json 的 `version` 同一个数,源头都是 workbench-plugin/package.json),
    # 而手机端的「有没有新版」就是拿它跟清单里 apk 那一格的版本比。
    #
    # 少了这一道会出一个**死循环**:butler-app 两版之间一个字没改时那棵树的 id 是一样的,
    # 于是拿 0.4.90 打的包发 0.4.91 照样过前两道 —— 清单说这份包是 0.4.91,而装上去还是 0.4.90,
    # 手机于是永远显示「有新版 0.4.91」,下一次按下去下的还是同一份。
    if [ "$APK_VERSION" != "$VERSION" ]; then
      die "手机包里记的版本号与这一版对不上:
     包里是   ${APK_VERSION:--}(10-03 之前打的包压根没有这一格)
     这一版是 ${VERSION}
     发出去手机会永远显示「有新版 ${VERSION}」而装上去还是 ${APK_VERSION:--}(那是个死循环)。
     在 butler-app/ 里重打一次(pnpm android:debug,它会把当前版本号写进 versionName),
     或者 --skip-apk-check \"<理由>\"。"
    fi
    info "指纹对得上:butler-app 那棵树 ${WANT_TREE}(clean),包里版本号 ${APK_VERSION}"
  fi
  cp "$APK_SRC" "$STAGE/app.apk"
  info "app.apk($(du -h "$STAGE/app.apk" | cut -f1))"
fi

# ───────────────────────── 3. 算 sha256,写清单 ─────────────────────────

say "算 sha256,写清单"
# 每一件产物的 sha256 是客户端**唯一的**校验依据(下完对不上就当没下到),
# 所以这一段绝不能"算不出来就跳过" —— 算不出来就是不发。
asset_json() {
  local kind="$1" file="$2"
  [ -f "$STAGE/$file" ] || return 1
  local sum size
  sum="$(shasum -a 256 "$STAGE/$file" | awk '{print $1}')"
  size="$(wc -c < "$STAGE/$file" | tr -d ' ')"
  [ ${#sum} -eq 64 ] || die "$file 的 sha256 算出来不对:$sum"
  printf '    "%s": { "url": "%s/%s/%s", "sha256": "%s", "size": %s }' \
    "$kind" "$BASE_URL" "$VERSION" "$file" "$sum" "$size"
}

# 清单里那几格的顺序(kind:文件名)。carry 与写清单两处都照这一份走。
ASSET_PAIRS="plugin_tgz:plugin.tgz scripts_tgz:scripts.tgz runtime_tgz:runtime.tgz shell_app_zip:shell-app.zip
butler_server_tgz:butler-server.tgz channel_worker_tgz:channel-worker.tgz livekit_tgz:livekit.tgz apk:app.apk
installer_dmg:$INSTALLER_NAME"

# ── 没重打的那几样:照上一版清单原样抄(卡 U8,理由见文件头那一节) ──
# node 那一段只做一件事:把上一版清单里**这次没打的**那几格逐格校验后原样印出来,
# 一行一格「kind<TAB>{ …json… }」。校验照客户端 manifest.ts 那几条(url 同源且合法、
# sha256 是 64 位十六进制、size 是正整数)—— 抄一格坏的过来,等于把那道守门在这条路上关掉。
CARRY_LINES=""
MISSING=""
for pair in $ASSET_PAIRS; do
  file="${pair##*:}"
  [ -f "$STAGE/$file" ] || MISSING="$MISSING ${pair%%:*}"
done
if [ -n "$MISSING" ] && [ "$CARRY" = "1" ] && [ -f "$PREV_MANIFEST" ]; then
  CARRY_LINES="$(PREV="$PREV_MANIFEST" MISSING="$MISSING" BASE_URL="$BASE_URL" node -e '
    const fs = require("node:fs");
    const prev = JSON.parse(fs.readFileSync(process.env.PREV, "utf8"));
    const assets = prev !== null && typeof prev.assets === "object" ? prev.assets : {};
    const prevVersion = typeof prev.version === "string" ? prev.version : "";
    const origin = new URL(process.env.BASE_URL).origin;
    for (const kind of (process.env.MISSING || "").trim().split(/\s+/).filter(Boolean)) {
      const one = assets[kind];
      if (one === null || typeof one !== "object") continue;
      const { url, sha256, size } = one;
      if (typeof url !== "string") continue;
      let parsed; try { parsed = new URL(url); } catch { continue; }
      if (parsed.origin !== origin) continue;
      if (typeof sha256 !== "string" || !/^[0-9a-f]{64}$/.test(sha256)) continue;
      if (typeof size !== "number" || !Number.isInteger(size) || size <= 0) continue;
      // 出自哪一版:上一版清单里抄来的那一格自己写着就照它(它也可能是从更早那一版抄来的),
      // 否则就是上一版自己打的。客户端拿它说真话(「手机包有新的了」不许乱报)。
      const from = typeof one.from_version === "string" && one.from_version !== "" ? one.from_version : prevVersion;
      const json = `{ "url": ${JSON.stringify(url)}, "sha256": ${JSON.stringify(sha256)}, "size": ${size}`
        + (from === "" ? "" : `, "from_version": ${JSON.stringify(from)}`) + " }";
      process.stdout.write(`${kind}\t${json}\n`);
    }
  ' 2>/dev/null || true)"
fi

# 抄过来的那一格(没有就空)。**一定回 0**:`set -e` 下 `x="$(f)"` 会把 f 的退出码当自己的。
carried_json() {
  [ -n "$CARRY_LINES" ] || return 0
  printf '%s\n' "$CARRY_LINES" | awk -F'\t' -v k="$1" '$1 == k { print $2; exit }'
}

# 热修写 beta.json;稳定版写 latest.json,下面再原样复制一份成 beta.json(稳定版不落后于热修)。
if [ "$CHANNEL" = "stable" ]; then MANIFEST_NAME="$STABLE_MANIFEST_NAME"; else MANIFEST_NAME="$HOTFIX_MANIFEST_NAME"; fi
MANIFEST="$OUT/$MANIFEST_NAME"
mkdir -p "$OUT"
{
  printf '{\n'
  printf '  "version": "%s",\n' "$VERSION"
  printf '  "released_at": "%s",\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  # notes 要经 JSON 转义(里面会有引号、换行、中文标点)。
  printf '  "notes": %s,\n' "$(NOTES="$NOTES" node -e 'process.stdout.write(JSON.stringify(process.env.NOTES))')"
  [ -n "$SKIP_WHY" ] && printf '  "local_check_skipped": %s,\n' "$(SKIP_WHY="$SKIP_WHY" node -e 'process.stdout.write(JSON.stringify(process.env.SKIP_WHY))')"
  [ -n "$SKIP_APK_WHY" ] && printf '  "apk_check_skipped": %s,\n' "$(SKIP_APK_WHY="$SKIP_APK_WHY" node -e 'process.stdout.write(JSON.stringify(process.env.SKIP_APK_WHY))')"
  # 回归门那一格(2026-10-28):有报告就带上通过率,公网上看得见这一版事务官听懂了几成。
  [ -f "$INTENT_REPORT" ] && printf '  "intent_regression": %s,\n' "$(INTENT_REPORT="$INTENT_REPORT" node -e '
    const r = JSON.parse(require("node:fs").readFileSync(process.env.INTENT_REPORT, "utf8"));
    const total = Number(r.total) || 0, passed = Number(r.passed) || 0;
    process.stdout.write(JSON.stringify({ rate: total > 0 ? Math.round(passed / total * 1000) / 1000 : 0, total, passed, at: typeof r.at === "string" ? r.at : null }));
  ')"
  [ -n "$MIN_INSTALLER" ] && printf '  "min_installer_version": "%s",\n' "$MIN_INSTALLER"
  printf '  "channel": "%s",\n' "$CHANNEL"
  [ -n "$SKIP_REHEARSE_WHY" ] && [ "$CHANNEL" = "stable" ] && printf '  "rehearse_skipped": %s,\n' "$(SKIP_REHEARSE_WHY="$SKIP_REHEARSE_WHY" node -e 'process.stdout.write(JSON.stringify(process.env.SKIP_REHEARSE_WHY))')"
  printf '  "assets": {\n'
  FIRST=1
  for pair in $ASSET_PAIRS; do
    kind="${pair%%:*}"; file="${pair##*:}"
    if [ -f "$STAGE/$file" ]; then
      [ "$FIRST" = "1" ] || printf ',\n'
      FIRST=0
      asset_json "$kind" "$file"
      continue
    fi
    carried="$(carried_json "$kind")"
    [ -n "$carried" ] || continue
    [ "$FIRST" = "1" ] || printf ',\n'
    FIRST=0
    printf '    "%s": %s' "$kind" "$carried"
  done
  printf '\n  }\n}\n'
} > "$MANIFEST"

node -e 'JSON.parse(require("node:fs").readFileSync(process.argv[1],"utf8"))' "$MANIFEST" \
  || die "写出来的 $MANIFEST_NAME 不是合法 JSON(这是脚本的 bug,别发)。"
# 这一趟要推上去的清单(文件名),以及服务器上一个字节都不动的那一份。
if [ "$CHANNEL" = "stable" ]; then
  cp "$MANIFEST" "$OUT/$HOTFIX_MANIFEST_NAME"
  PUSH_MANIFESTS="$HOTFIX_MANIFEST_NAME $STABLE_MANIFEST_NAME"
  UNTOUCHED_MANIFEST=""
else
  PUSH_MANIFESTS="$HOTFIX_MANIFEST_NAME"
  UNTOUCHED_MANIFEST="$STABLE_MANIFEST_NAME"
fi

say "这一版发出去的每样产物有多大"
# 逐个如实报 —— 用户那边下多少,取决于**他机器上没有的那几样**,而不是这里的总数;
# 但这一栏是唯一能让发版的人当场看出"这次是不是把一个 350MB 的包又发了一遍"的地方。
TOTAL_BYTES=0
for f in "$STAGE"/*; do
  [ -f "$f" ] || continue
  bytes="$(wc -c < "$f" | tr -d ' ')"
  TOTAL_BYTES=$((TOTAL_BYTES + bytes))
  printf '  %-22s %8s  %s 字节\n' "$(basename "$f")" "$(du -h "$f" | cut -f1)" "$bytes"
done
printf '  %-22s %8s\n' '合计' "$(echo "$TOTAL_BYTES" | awk '{printf "%.1fM", $1/1048576}')"
info "用户那边只下**跟他机器上那份对不上的**几样(客户端拿 sha256 跟 ~/.dsh/updates/installed.json 比)。"

# 这一趟没打、从上一版原样带上的那几格(卡 U8)。**说清楚**:这一栏是唯一能当场看出
# 「这一版清单里还有没有手机包」的地方 —— 0.4.1 丢掉 apk 那次,输出里什么都没说。
say "没重打、照上一版清单原样带上的"
if [ -n "$CARRY_LINES" ]; then
  printf '%s\n' "$CARRY_LINES" | sed 's/^/  /'
  info "客户端按 sha256 比,与他机器上那份一样就不下不装;url 指的是那一版的目录(旧版本从不删)。"
else
  if [ "$CARRY" = "0" ]; then
    info "(按 --no-carry,一格都不抄)"
  elif [ ! -f "$PREV_MANIFEST" ]; then
    info "读不到服务器上那一版清单(第一次发,或者这会儿没网)—— 一格都没抄。"
  else
    info "(上一版清单里也没有这几格,或者那几格的形状不对 —— 抄不过来)"
  fi
fi
# **这一栏是唯一能当场看出「这一版清单里还有没有手机包」的地方** —— 0.4.1 丢掉 apk 那次,
# 输出里什么都没说,发版的人根本看不出来。所以最后总要按清单本身再核一遍缺了哪几格。
LEFT_OUT=""
for pair in $ASSET_PAIRS; do
  kind="${pair%%:*}"
  node -e '
    const fs = require("node:fs");
    const assets = JSON.parse(fs.readFileSync(process.argv[1], "utf8")).assets ?? {};
    process.exit(assets[process.argv[2]] === undefined ? 1 : 0);
  ' "$MANIFEST" "$kind" || LEFT_OUT="$LEFT_OUT $kind"
done
if [ -n "$LEFT_OUT" ]; then
  info "!! 这一版清单里**没有**:$LEFT_OUT"
  info "!! 用户与手机看的只有最新这一份清单,这几格在他那边会是空的(0.4.1 丢掉手机包就是这么丢的)。"
  info "!! 是有意的(某件产物不再发了)就不用管;不是就先别推,有网了重发一次。"
fi

info "$MANIFEST"
sed 's/^/    /' "$MANIFEST"

# ──────────── 3½. 稳定版:先在隔离的新机器上演练一遍(2026-10-21) ────────────

# 体验的人收的是这一版,新机器那条路(双击安装包从零装)每个稳定版都要先走一遍。
# 演练只碰 mktemp 出来的隔离 home(安装器内核带 --no-launch),真 ~/.dsh 与 launchd 一个字节不动,
# 所以干跑与 --no-upload 也照跑。用哪个安装包:--installer 指了就用它,否则 dist/ 里这一版的那份,
# 都没有就由演练自己临时打一份(打在它的隔离目录里,不落 dist/)。
REHEARSE_REPORT=""
if [ "$CHANNEL" = "stable" ]; then
  if [ -n "$SKIP_REHEARSE_WHY" ]; then
    say "新机器演练:跳过"
    info "!! 这一版稳定版**没在新机器上演练过**。理由:$SKIP_REHEARSE_WHY"
    info "!! 清单里记了一格 rehearse_skipped —— 公网上看得见它没演练。"
  else
    say "新机器演练:隔离 home 里从安装包装一遍、体检、出报告(红了就不发)"
    REHEARSE_REPORT="$REPO_ROOT/dist/rehearsals/演练-$VERSION.md"
    REHEARSE_ARGS=(--version "$VERSION" --report "$REHEARSE_REPORT")
    [ -n "$INSTALLER_DMG" ] && REHEARSE_ARGS+=(--dmg "$INSTALLER_DMG")
    (cd "$REPO_ROOT/workbench-plugin" && pnpm --silent rehearse "${REHEARSE_ARGS[@]}") \
      || die "新机器演练没过($([ -f "$REHEARSE_REPORT" ] && echo "报告:$REHEARSE_REPORT" || echo "没出报告:演练没起来,看上面那几行")),这一版稳定版**一个字节都没推**。
     看报告里「没成」的那几行修好再来;只想先发热修就换成 --channel hotfix。"
    info "✓ 演练过了:$REHEARSE_REPORT"
  fi
fi

# ───────────────────────── 4. 本机闸 ─────────────────────────

if [ "$UPLOAD" = "0" ]; then
  if [ "$DRY_RUN" = "1" ]; then
    say "干跑:要推的是这些(这一趟一个都没推)"
    info "产物:$STAGE/ → $SSH_HOST:$REMOTE_DIR/$VERSION/"
    for name in $PUSH_MANIFESTS; do
      info "清单:$OUT/$name → $SSH_HOST:$REMOTE_DIR/$name"
    done
    [ -n "$UNTOUCHED_MANIFEST" ] && info "不动:$SSH_HOST:$REMOTE_DIR/$UNTOUCHED_MANIFEST(热修不碰稳定版那一份)"
    [ -n "$REHEARSE_REPORT" ] && info "演练报告:$REHEARSE_REPORT"
    printf '\n✓  干跑完了:没有 rsync,没过本机闸,没在本机按更新,没打源码包\n\n'
    exit 0
  fi
  printf '\n✓  产物与清单都在 %s(按 --no-upload,没有 rsync,也没过本机闸,也没在本机按更新)\n\n' "$OUT"
  exit 0
fi

# 0.4.87 先推公网再升本机,崩了才知道(文件头「本机闸」那一节)。**只管插件**。
if [ -n "$SKIP_WHY" ]; then
  say "本机闸:跳过"
  info "!! 这一版**没在本机验过**。理由:$SKIP_WHY"
  info "!! 清单里记了一格 local_check_skipped —— 公网上看得见它没过闸。"
else
  say "本机闸:先把这一版装到这台机器上,起来了才许推"
  bash "$REPO_ROOT/deploy/local-install-gate.sh" --tgz "$STAGE/plugin.tgz" --version "$VERSION" --settle "${GATE_SETTLE:-10}" ${SKIP_LIVEKIT_WHY:+--skip-livekit "$SKIP_LIVEKIT_WHY"} ${INTENT_MIN:+--intent-min "$INTENT_MIN"} --intent-report "$INTENT_REPORT" \
    || die "本机闸没过,这一版**一个字节都没推**(上面有回退命令)。
     修好再来一趟;实在要跳过就 --skip-local-check \"<理由>\"。"
fi

# ───────────────────────── 5. 推上去 ─────────────────────────

say "推到 $SSH_HOST:$REMOTE_DIR"
# **先推产物,后推清单**:反过来的话,清单已经说"有 0.2.42 了",而产物还在路上 ——
# 这中间去点「立即更新」的人会撞上一串 404。
#
# **不带 --delete**:旧版本的产物要留着 —— 有人可能正在慢网上续传上一版,
# 而且出了事要能把 latest.json 改回去(旧包还在,改一行就回滚了)。
# macOS 自带的是 openrsync,不认 --chmod;权限在服务器上用 chmod 补。
#
# 稳定版两份清单:**先 beta.json 后 latest.json** —— 中间那一下收热修的机器先看到新版,
# 反过来的话会有一瞬间稳定版比热修新。热修只推 beta.json,latest.json 一个字节不动。
rsync -av "$STAGE/" "$SSH_HOST:$REMOTE_DIR/$VERSION/"
for name in $PUSH_MANIFESTS; do
  rsync -av "$OUT/$name" "$SSH_HOST:$REMOTE_DIR/$name"
done
CHMOD_TARGETS="'$REMOTE_DIR/$VERSION'"
for name in $PUSH_MANIFESTS; do CHMOD_TARGETS="$CHMOD_TARGETS '$REMOTE_DIR/$name'"; done
ssh "$SSH_HOST" "chmod -R u=rwX,go=rX $CHMOD_TARGETS"

say "回头看一眼公网上真的发出来了没有"
sleep 2
for name in $PUSH_MANIFESTS; do
  if curl -fsS --connect-timeout 10 "$BASE_URL/$name" | grep -q "\"$VERSION\""; then
    info "✓ $BASE_URL/$name 已经是 $VERSION"
  else
    info "! $name 还没读到 ${VERSION}。可能是 Caddy 没放行 /updates/*(先在服务器上跑一遍 deploy/aliyun-relay-setup.sh),"
    info "  或者 CDN/缓存还没过。自己 curl 一下:curl -s $BASE_URL/$name"
  fi
done

# ──────────── 6. 本机也走一遍真正的更新路(闸只装了插件) ────────────

# 为什么要这一趟:见文件头「发完之后本机也走一遍真正的更新路」。
# **公网已经推完了**,所以这一段里的每一下失败都只打印一句,不 die。

LOCAL_BASE="${LOCAL_BASE%/}"

# JSON 里取一格(`plan.changed` 这种点路径也认);取不到就空。
# **一定回 0**:`set -e` 下 `x="$(f)"` 会把 f 的退出码当自己的。
json_field() {
  BODY="$1" KEY="$2" node -e '
    try {
      const body = JSON.parse(process.env.BODY);
      const got = String(process.env.KEY).split(".").reduce(
        (one, key) => (one === null || one === undefined ? undefined : one[key]), body);
      process.stdout.write(got === undefined || got === null ? "" : String(got));
    } catch { /* 不是合法 JSON 就空着 */ }
  ' 2>/dev/null || true
}

# 服务没回来时**先打读数、再给救法**(2026-10-13,0.4.115「装完没自己起来」)。
#
# 那天这里只说了一句「自己看一眼 /state」,而真正能下结论的三个数都在 `launchctl print` 里:
#   state = not running + last exit code = 0 + runs 没加一
#     = 进程自己正常退出了、那下 kickstart 没到 launchd、而 KeepAlive.SuccessfulExit=false
#       故意不拉它(机理见 docs/交接-1013-热更新装完重启没起来.md)。
#   state = spawn scheduled  = launchd 正等 ThrottleInterval(10 秒)过去,再等等就起来。
# 救法那一句**不带 -k**:对还在跑的项它什么都不做,照着跑一遍不会把好着的服务弄掉。
launchd_readout() {
  local label="ai.deepseek.dsh"
  info "  launchd 那边的读数(gui/$(id -u)/${label}):"
  launchctl print "gui/$(id -u)/${label}" 2>&1 \
    | grep -E '^[[:space:]]+(state|runs|pid|last exit)[[:space:]]' \
    | sed 's/^/    /' || info "    (launchctl print 没给出东西 —— launchd 里可能压根没有这一项)"
  info "  日志尾巴:tail -5 ${DSH_HOME:-$HOME/.dsh}/logs/web.stderr.log"
  info "  救法(先试这一句,不带 -k,对还在跑的项它什么都不做):"
  info "    launchctl kickstart gui/\$(id -u)/${label}"
  info "  这一版带的壳会在 8791 连续 20 秒不答时自己拉一次;装着旧壳的机器要人跑上面那句。"
}

local_apply() {
  info "工作台在 ${LOCAL_BASE}"
  # ① 先让它重新查一次**刚推上去的**那份清单 —— 闸那一趟查到的还是上一版。
  local checked
  checked="$(curl -fsS -m 60 "$LOCAL_BASE/update/check" 2>/dev/null || true)"
  if [ -z "$checked" ]; then
    info "! 问不到本机工作台(${LOCAL_BASE}/update/check 没人应答)。"
    return 1
  fi
  local now latest changed
  now="$(json_field "$checked" current)"
  latest="$(json_field "$checked" latest)"
  changed="$(json_field "$checked" plan.changed)"
  info "本机 current=${now:-(读不出来)}、latest=${latest:-(没查到)},这一版里有 ${changed:-?} 样跟本机那份对不上"
  # **它得真看见刚推上去的那一版**。取不到公网清单(CDN 还没过、这会儿断网)时它手上还是
  # 上一版那份清单 —— 这时候按下去装的是**那一版**的东西,而 `apply` 还会回一句
  # 「已经是最新的了」让这一趟看着像过了。所以对不上就当场停,不按。
  if [ "$latest" != "$VERSION" ]; then
    info "! 本机查到的最新版不是刚推上去的 ${VERSION} —— 这一趟不按更新(按下去装的会是它手上那份旧清单)。"
    if [ "$CHANNEL" = "hotfix" ] && [ "$(json_field "$checked" channel)" = "stable" ]; then
      info "  这台机器收的是稳定版,看不到热修:设置 → 更新 →「收哪条更新」选热修,再点一次。"
    else
      info "  多半是公网那份清单还没传到位。过一会儿在设置 → 更新里点一次就行。"
    fi
    return 1
  fi

  # ② 按一次「立即更新」。409 = 它自己说没有要装的东西 —— 那也是一种"过"。
  local body code id
  body="$OUT/.local-apply.json"
  code="$(curl -s -m 60 -o "$body" -w '%{http_code}' -X POST "$LOCAL_BASE/update/apply" 2>/dev/null || true)"
  if [ "$code" = "409" ]; then
    info "工作台说不用装:$(json_field "$(cat "$body")" error)"
    rm -f "$body"
    return 0
  fi
  if [ "$code" != "200" ]; then
    info "! POST ${LOCAL_BASE}/update/apply 回的是 ${code:-(没人应答)}"
    rm -f "$body"
    return 1
  fi
  id="$(json_field "$(cat "$body")" id)"
  rm -f "$body"
  if [ -z "$id" ]; then
    info "! 更新作业起来了,但回包里没有 id"
    return 1
  fi
  info "更新作业 ${id} 起来了,盯着它(最多 $((LOCAL_APPLY_WAIT / 60)) 分钟)"

  # ③ 盯着它。**作业忽然问不到了 = 装完重启了**(更新最后一步就是 launchctl kickstart),
  #    那不是失败 —— 真正的结论由下面第 ④ 步再查一次清单来下。
  local deadline job state note last
  deadline=$(( $(date +%s) + LOCAL_APPLY_WAIT ))
  last=""
  while :; do
    job="$(curl -fsS -m 30 "$LOCAL_BASE/update/job/$id" 2>/dev/null || true)"
    if [ -z "$job" ]; then
      info "问不到那条作业了 —— 多半是装完重启了。等它起来再核一遍。"
      break
    fi
    state="$(json_field "$job" state)"
    note="$(json_field "$job" note)"
    if [ -n "$note" ] && [ "$note" != "$last" ]; then
      info "  ${note}"
      last="$note"
    fi
    if [ "$state" = "done" ]; then
      info "装完了"
      break
    fi
    if [ "$state" = "failed" ]; then
      info "! 本机这一趟没装成:$(json_field "$job" error)"
      return 1
    fi
    if [ "$(date +%s)" -ge "$deadline" ]; then
      info "! 等了 ${LOCAL_APPLY_WAIT} 秒,本机那条作业还没跑完(state=${state:-?})。"
      return 1
    fi
    sleep "$LOCAL_APPLY_POLL"
  done

  # ④ 等它起来,再查一次清单:这一版的每一样都该跟本机那份对得上了。
  sleep "$LOCAL_APPLY_SETTLE"
  local back left
  deadline=$(( $(date +%s) + LOCAL_APPLY_BACK ))
  while :; do
    back="$(curl -fsS -m 30 "$LOCAL_BASE/update/check" 2>/dev/null || true)"
    [ -z "$back" ] || break
    if [ "$(date +%s)" -ge "$deadline" ]; then
      info "! 等了 ${LOCAL_APPLY_BACK} 秒,本机工作台还没应答(${LOCAL_BASE} 没人接)。"
      launchd_readout
      return 1
    fi
    sleep "$LOCAL_APPLY_POLL"
  done
  left="$(json_field "$back" plan.changed)"
  if [ "$left" = "0" ]; then
    info "✓ 本机核过了:这一版的每一样都跟清单对得上(current=$(json_field "$back" current))"
    return 0
  fi
  info "! 本机还有 ${left:-?} 样跟清单对不上(available=$(json_field "$back" available))。"
  info "  在设置 → 更新里再点一次,或者再跑一遍:curl -X POST ${LOCAL_BASE}/update/apply"
  return 1
}

if [ "$LOCAL_APPLY" = "0" ]; then
  say "本机更新路:跳过"
  info "(按 --no-local-apply。闸装上去的那份插件照旧在,别的几样还是旧的。)"
elif [ -n "$SKIP_WHY" ]; then
  say "本机更新路:跳过"
  info "跟本机闸一起跳过了(--skip-local-check)。理由:$SKIP_WHY"
  info "自改闭环那条路走的就是这一支:这里按一次更新会把跑着它的那个进程当场重启掉,"
  info "决策记录就写不成了 —— 它自己的第 ⑧ 步在记录落盘之后再按。"
else
  say "本机也走一遍真正的更新路(闸只装了插件;事务官后端 / 通话组件要走这一趟才装得上)"
  local_apply || info "! 本机这一趟没走完(上面写了停在哪)。**${VERSION} 已经推上去了,公网是对的** —— 这一条不算发版失败。"
fi

# ──────────────── 7. 顺手打一个给运营同学的源码包(不上传) ────────────────

# 每版重打一次,她手上那份的基线才不会越落后越难合(文件头那一节)。
# **在推完之后**:发版是正事,源码包打不出来(工作树不干净之类)不该把这一版挡在外面。
KIT_ZIP="$REPO_ROOT/dist/工作台源码包-$VERSION.zip"
if [ "$KIT" = "1" ]; then
  say "顺手打一个源码包(给运营同学,不上传)"
  bash "$REPO_ROOT/deploy/make-source-kit.sh" "$VERSION" \
    || die "$VERSION **已经发出去了**,但源码包没打出来(上面是它的输出)。
     多半是工作树不干净 —— 先提交,再单独跑一遍 bash deploy/make-source-kit.sh ${VERSION}。"
else
  say "源码包"
  info "(按 --no-kit,这一趟不打)"
fi

printf '\n✓  发完了:%s\n' "$VERSION"
printf '   用户那边:设置 → 更新 → 「检查更新」就看得到;后台一天自己查一次,有新版齿轮上打个点。\n'
printf '   通道:%s(推了:%s)\n' "$CHANNEL" "$PUSH_MANIFESTS"
printf '   要回滚:把上一版的 latest.json 再推一次(旧包没删)。\n'
[ "$CHANNEL" = "hotfix" ] && printf '   热修这一版要回滚:推回的是 %s(%s 这一趟没动)。\n' "$HOTFIX_MANIFEST_NAME" "$STABLE_MANIFEST_NAME"
[ -f "$KIT_ZIP" ] && printf '   源码包(发给运营同学,不在清单里):%s\n' "$KIT_ZIP"
printf '\n'
