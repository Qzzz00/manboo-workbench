/**
 * 登录台碰的每一条路径,都在这里由 `home` / `repoRoot` 算出来(2026-09-17)。
 *
 * **为什么全部集中在这一个文件**:登录台是整个仓库里唯一会往 `~/.dsh`、
 * `~/Library/LaunchAgents`、`/Applications` 写东西的一块。测试必须能把它整个搬进一个
 * 临时 HOME 里跑 —— 只要没有任何一处写死 `process.env.HOME`,这件事就是结构性成立的,
 * 而不是靠每个用例自己记得去 mock。所以:
 *
 *   ① 这里每个函数都**必须**收 `home`(没有默认值,漏传会在类型层就被拦下来);
 *   ② `/Applications` 是唯一一条不随 home 走的路径,所以它也收一个可覆盖的前缀。
 *
 * 2026-09-04 家目录被删事故之后,这条纪律不是洁癖:测试里一次写错路径就是真删真写。
 */

/**
 * DSH 锁定版本(README「运行要求」C3)。一键装装的就是这个版本,不跟随上游。
 *
 * **改它必须一起重生成 `dsh-runtime/runtime.package.json` 与 `runtime.package-lock.json`**
 * (2026-09-23):运行时按那份锁文件 `npm ci`,整棵依赖树都锁在里面,只改这一行等于没改。
 * 步骤见 dshRuntimeLock.ts 文件头;忘了的话 tests/dsh-runtime-lock.test.ts 会红。
 */
export const LOCKED_DSH_VERSION = '0.1.7-rc.2'

/**
 * DSH 上游「内测声明」对话框的确认版本(2026-09-23 从零重装验收)。
 *
 * 浏览器第一屏会弹一个上游的声明框(「DeepSeek Harness 0.1 面向开发者测试……继续」),对我们的
 * 用户不合适。上游的判断是:`settings.yaml` 里 `ui-onboarding.welcomeNoticeVersion` **逐字等于**
 * 它代码里的常量就不弹。所以安装时把这一条预先写好。
 *
 * 常量出处(dsh 0.1.2-rc.1):`@deepseek-ai/dsh-client-ui-settings-models` 的
 * `lib/types/onboarding-copy.d.ts` → `WELCOME_NOTICE_VERSION = "2026-08-13.1"`
 * (上游源码 `src/onboarding-copy.ts`)。**换 LOCKED_DSH_VERSION 时要去新版本里复核这个值** ——
 * 上游改了声明会 bump 它,不跟着改的话新装的机器又会弹。
 * 2026-09-25 升 0.1.7-rc.2 时复核过:上游同一处仍写 `2026-08-13.1`,这一行不用改。
 * 只管本机回环打开的那一页;局域网 / 手机上打开的网页上游只记在进程里,刷新还会弹(上游行为)。
 */
export const DSH_WELCOME_NOTICE_VERSION = '2026-08-13.1'

/**
 * 上游缺省的默认模型(`@deepseek-ai/dsh-base/cordis.patch.yml` 里 `agent-default-model` 那一项)。
 * 换 LOCKED_DSH_VERSION 时一并复核 —— 2026-09-25 升 0.1.7-rc.2 时**变了**:
 * `deepseek-v4-flash` → `deepseek-flash`(上游 `packages/bundle/base/cordis.patch.yml:82-86`)。
 *
 * **它只是「上游默认是什么」这句事实**,不是我们播种给用户的那个模型 —— 见
 * `SEEDED_DEFAULT_MODEL`。0.1.2 时两者恰好同名,升级把这个巧合拆开了。
 */
export const DSH_UPSTREAM_DEFAULT_MODEL = { provider: 'deepseek-official', model: 'deepseek-flash' } as const

/**
 * 新装机器上播种给 `agent-default-model` 的那个模型(2026-09-25,升 0.1.7 时拆出来)。
 *
 * **为什么不能直接用上游那个名字**:播种的最后一步是 `settingsForRelay` —— 它把 provider
 * 指到 `workbench-relay`,而 **`model:` 那一行原样保留**(用户选的模型由他自己定,中转把名字
 * 透传给上游)。所以落到新机器上的默认模型 = 这里写的这个名字,它必须是**我们中转真的认**的
 * 一个 id(`dshModelSettings.ts` 的 `RELAY_STANDARD_MODELS`:`deepseek-v4-flash` / `deepseek-v4-pro`;
 * 中转内部再映射成上游的 `deepseek-flash`)。
 *
 * 0.1.2 时上游缺省恰好也叫 `deepseek-v4-flash`,于是「照上游播种」与「播一个中转认的」
 * 是同一件事;0.1.7 上游改叫 `deepseek-flash`,照抄上游就会给新机器播一个中转不认的 id
 * ——第一次对话就 UNKNOWN_MODEL。所以这一条钉在我们自己的中转口径上。
 */
export const SEEDED_DEFAULT_MODEL = 'deepseek-v4-flash'

/**
 * 0.1.2-rc.1 起要**显式补**的三个 client 包(README / 交接-0909):npm 装 dsh 主包不会
 * 把它们带全,少了就是页面白屏。版本跟主包锁同一个。
 * 2026-09-23 起它们是运行时锁定清单的顶层依赖(随 npm ci 一起装),这里留着给清单自检与版本守卫用。
 */
export const EXTRA_DSH_PACKAGES = [
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-ui-primitives',
  '@deepseek-ai/dsh-client-web',
] as const

/** 自有 node 的最低大版本。低于它 channel-worker 剥不了 TypeScript(deploy/channel-start 那条硬要求)。 */
export const MIN_NODE_MAJOR = 24

/**
 * 自有 node 的锁定版本 —— 就是 2026-09-07 事故恢复之后一直跑在生产上的那一版。
 *
 * **为什么要有一份能下载的独立包**(2026-09-17 裸机引导实测):
 * 「把这会儿跑着的那条 node 复制过去」这个做法,只在源 node 是**自带依赖的独立发行版**时
 * 成立(0907 复制的是 codex 运行时缓存里那份,正是独立的)。而一台裸机按 README 装到的是
 * Homebrew 的 node,它的 `libnode.<主版本>.dylib` 在隔壁 `lib/` 里、靠 `@loader_path/../lib`
 * 找 —— 单拎一个二进制出来,一跑就是 `dyld: Library not loaded: @rpath/libnode.147.dylib`。
 * 所以复制不成时要有个兜底:下官方独立包。
 */
export const LOCKED_NODE_VERSION = '24.19.0'

/** 官方独立包。README「运行要求」:只支持 macOS + Apple Silicon,所以只认 darwin-arm64。 */
export const NODE_TARBALL_NAME = `node-v${LOCKED_NODE_VERSION}-darwin-arm64.tar.gz`
export const NODE_TARBALL_URL = `https://nodejs.org/dist/v${LOCKED_NODE_VERSION}/${NODE_TARBALL_NAME}`

/**
 * 下这个包时按顺序试的几条源(2026-09-18 桌面安装包)。**国内镜像在前,官方在后**。
 *
 * 为什么:Ben 这台机器在国内,nodejs.org 的 50MB 包实测能下十几分钟甚至断流;而
 * npmmirror(阿里)与清华 TUNA 都镜像了 nodejs 的 dist 目录,文件字节完全一样 ——
 * 所以**校验和只有一份**(`NODE_TARBALL_SHA256`),换哪条源下来都得对得上。
 * 镜像被投毒的那种情形,正是这一份钉在仓库里的 sha256 挡着的。
 *
 * 官方那条永远留在最后:镜像同步滞后或者挂了的时候,它是唯一一定有的。
 */
export const NODE_TARBALL_URLS: readonly string[] = [
  `https://cdn.npmmirror.com/binaries/node/v${LOCKED_NODE_VERSION}/${NODE_TARBALL_NAME}`,
  `https://mirrors.tuna.tsinghua.edu.cn/nodejs-release/v${LOCKED_NODE_VERSION}/${NODE_TARBALL_NAME}`,
  NODE_TARBALL_URL,
]
/**
 * 上面那个包的 sha256,**从 nodejs.org 的 SHASUMS256.txt 抄下来钉在仓库里**(2026-09-17 取)。
 * 钉在这儿而不是跟着包一起下:跟着下的校验和只防传输损坏,钉在仓库里的还经过一次人工审阅
 * (同 C4「第三方依赖先审计再 pin 版本」的规矩)。换版本时这两行要一起改。
 */
export const NODE_TARBALL_SHA256 = '8294b7aa9b03997481c06babf1e8b270c859358f27da57a11509afe537ac381d'

/**
 * 自带的 pnpm 锁定版本(2026-09-27,卡 PN:裸机上装不进 profile)。
 *
 * **为什么工作台要自己带一份 pnpm**:DSH 0.1.7 的 `dsh plugin add` 自己不装包,它转手给
 * pnpm(`@deepseek-ai/dsh-plugin-manager` 的 `execa(options.command ?? 'pnpm', …)`);
 * 找不到就回 **127** 并印 "pnpm was not found; install pnpm and make it available on PATH"。
 * 维护者那台机器上有 `/opt/homebrew/bin/pnpm`,而安装器的 PATH 里正好带着 `/opt/homebrew/bin`
 * —— 所以这条依赖在开发机上从来没暴露过;一台全新的 Mac 上没有 Homebrew、没有 pnpm,
 * 「装进 profile」这一步必然 127(2026-09-27 维护者在新 MacBook Air 上撞的就是这个)。
 *
 * 取 11.16.0:与维护者本机那条 `/opt/homebrew/bin/pnpm`(11.16.0)**同一版** ——
 * 装出来的 profile 与他验过的那台机器上是同一套解析结果,而不是"另一版 pnpm 也许也行"。
 */
export const LOCKED_PNPM_VERSION = '11.16.0'
export const PNPM_TARBALL_NAME = `pnpm-${LOCKED_PNPM_VERSION}.tgz`
/**
 * 下这个包时按顺序试的几条源。**国内镜像在前、官方在后**,同 `NODE_TARBALL_URLS` 那条理由。
 * 安装包里带着这个 .tgz,所以这几条只在**热更新**那条路上用得到(那时候机器上还没有 pnpm)。
 */
export const PNPM_TARBALL_URLS: readonly string[] = [
  `https://registry.npmmirror.com/pnpm/-/${PNPM_TARBALL_NAME}`,
  `https://registry.npmjs.org/pnpm/-/${PNPM_TARBALL_NAME}`,
]
/**
 * 上面那个包的 sha256,钉在仓库里(2026-09-27 取)。同 C4「第三方依赖先审计再 pin 版本」。
 *
 * 核过一遍:npmmirror 那份与 `registry.npmjs.org/pnpm/11.16.0` 元数据里的
 * `dist.integrity`(sha512-t2fpqY/Ieuw…)**逐字节同一个包**,所以换哪条源下来都得对上这一份。
 * 换 `LOCKED_PNPM_VERSION` 时这两行一起改(`tests/install-shape-pnpm.test.ts` 盯着格式)。
 */
/**
 * 国内的 npm 镜像(2026-09-27)。装插件那一步 pnpm 要去 registry 取 peer 依赖,
 * **官方源不通时**换它再试一次(见 install.ts 的 plugin 那一步)。
 * DSH 0.1.7 自己的 plugin 服务也把它列为 fallback registry,口径一致。
 */
export const NPM_MIRROR_REGISTRY = 'https://registry.npmmirror.com'

export const PNPM_TARBALL_SHA256 ='3f2a848545f82fce6966f3ecaa8b7d87b5563f901a170e2bd573b02296b382fa'

/**
 * 随包的本机房间服务(livekit-server,2026-10-21,局域网主路卡 M1;设计稿第一节)。
 *
 * **LiveKit 官方不出 macOS 的二进制**(GitHub Releases 只有 linux / windows,macOS 那条路是 `brew install`),
 * 所以随包的那一份取自 **Homebrew 官方 bottle**(ghcr.io 上 `homebrew/core/livekit`,Homebrew 从官方源码
 * `v1.13.7.tar.gz` 编的,Apache-2.0,bottle 里带 LICENSE 与 NOTICE)。挑 `arm64_sequoia` 那一份:
 * 它的 `LC_BUILD_VERSION minos` 是 15.0;`arm64_tahoe` 那份是 26.0,装不上 macOS 15。
 * **两份都不支持 macOS 14**(壳与安装器的最低是 14.0)—— 14 上这一步如实跳过,打电话走云上那条
 * (`LIVEKIT_MIN_MACOS_MAJOR`)。要支持 14 得自己从源码 `CGO_ENABLED=0` 编一份,另开卡。
 *
 * 钉两样:bottle 包本身(下载完先核它)与解出来的那个二进制(**重签之前**的字节)。出包时用
 * 「工作台本机签名」重签(`deploy/fetch-livekit.sh --sign`),所以装到用户机器上的那份 sha 与这里不同 ——
 * 这一对 sha 守的是「从网上取来的就是审过的那一份」,同 Node / pnpm 那两条的口径(C4)。
 * 换版本:改版本号与 bottle 那一格,`deploy/fetch-livekit.sh --print-sha` 取新的两个 sha 填上,
 * `tests/local-room-paths-1021.test.ts` 盯着格式。
 */
export const LIVEKIT_SERVER_VERSION = '1.13.7'
export const LIVEKIT_BOTTLE_TAG = 'arm64_sequoia'
export const LIVEKIT_BOTTLE_SHA256 = 'a1999329af64094572cf75ee21d9c352973b0e08d8120927027b56394369f1bb'
/** ghcr.io 上 bottle 的地址就是它的 sha256(OCI blob);匿名取要带 `Authorization: Bearer QQ==`(Homebrew 自己也这么取)。 */
export const LIVEKIT_BOTTLE_URL = `https://ghcr.io/v2/homebrew/core/livekit/blobs/sha256:${LIVEKIT_BOTTLE_SHA256}`
/** bottle 里那个二进制的相对路径。 */
export const LIVEKIT_BOTTLE_BINARY = `livekit/${LIVEKIT_SERVER_VERSION}/bin/livekit-server`
export const LIVEKIT_SERVER_SHA256 = 'be6804a3531b1a7ba54c1224d1d4385c7ebbf2056a6d835dca81541fa7c66be2'
/** 跑得起这一份的最低 macOS 大版本(bottle 的 minos)。`deploy/livekit-start` 里的 `MIN_MACOS` 与它同一个数。 */
export const LIVEKIT_MIN_MACOS_MAJOR = 15
/** 重签时给的 identifier(没有它 codesign 按文件名定,换一次名就是另一个程序 —— 系统防火墙的「允许」就白点了)。 */
export const LIVEKIT_CODESIGN_IDENTIFIER = 'ai.ben.workbench.livekit-server'

/**
 * 本机房间的三个口(设计稿第一节):7880/TCP 信令(HTTP + WebSocket)、7881/TCP 走 TCP 的兜底、7882/UDP **单个**口收全部媒体。
 * 7880 被别的程序占着时整组换到 7890 / 7891 / 7892(`livekit-start` 做,并写回 `livekit.yaml` 与 `channel.json`)——
 * 只换信令口不够:最常见的占用者是另一台 `livekit-server --dev`,它三个口都占。
 */
export const LIVEKIT_PORTS = { signal: 7880, tcp: 7881, udp: 7882 } as const
export const LIVEKIT_ALT_PORTS = { signal: 7890, tcp: 7891, udp: 7892 } as const

export const DSH_LAUNCHD_LABEL = 'ai.deepseek.dsh'
export const BUTLER_LAUNCHD_LABEL = 'ai.deepseek.butler'
export const LIVEKIT_LAUNCHD_LABEL = 'ai.deepseek.livekit'

/** 壳 App 的安装位置。测试传一个临时目录当 `/Applications`。 */
export const DEFAULT_APPLICATIONS_DIR = '/Applications'
export const SHELL_APP_NAME = '工作台.app'
/** 安装器本身的名字(dmg 里那个双击的东西)。 */
export const INSTALLER_APP_NAME = '安装工作台.app'

/**
 * 装完之后事务官/引导落脚的那个工作仓库(2026-09-18 桌面安装包)。
 *
 * 为什么非有不可:引导、授权表、日常例程都要一个 git 仓库当落脚点(`butler_cwd`),
 * 而**普通用户机器上没有 desktop-workbench 这个仓库** —— 安装器只带产物,不带源码。
 * 所以装的时候现建一个空的:`git init` + 最小的 AGENTS.md / docs 结构。
 * 已经有 Ben 那种"仓库还在"的机器,可以在设置 → 目录里把它改回仓库路径。
 */
export const DEFAULT_WORK_REPO_DIR_NAME = 'Documents/工作台'

export interface SetupPathInput {
  home: string
  /**
   * DSH 的家。缺省 `<home>/.dsh`。
   *
   * 2026-09-17 补(裸机引导):`DSH_HOME` 本来就是 dsh-start 里的一个环境变量,让它可覆盖,
   * 在临时目录里真跑一遍时就不必连整个 HOME 一起搬。**`~/Library/LaunchAgents` 不跟着它走**
   * —— plist 只能装在家目录下那一处,那是 launchd 定的,不是我们能选的。
   */
  dshHome?: string
  /** 仓库根(WORKBENCH_BUTLER_CWD / 卡 C 的 butler_cwd)。没配时与仓库有关的那些路径都取不到。 */
  repoRoot?: string
  /** 壳装到哪。缺省 /Applications;测试传临时目录。 */
  applicationsDir?: string
}

export interface SetupPaths {
  /** 家目录。测试里是 mktemp 出来的那个。 */
  home: string
  dshHome: string
  /** 自有 node 的整棵树(独立包解包后 bin/ lib/ include/ 都在里面)。 */
  nodeDir: string
  /** 下官方独立包时的暂存目录。**唯一一处会被 rmrf 的路径**,所以它也由这里算出来。 */
  nodeDownloadDir: string
  nodeBin: string
  /** 自带 pnpm 的那棵树(npm 包 `pnpm` 解包后的样子:bin/ dist/ 都在里面)。 */
  pnpmDir: string
  /** 真正跑的那个入口(`pnpm` 包 package.json 的 `bin.pnpm`)。 */
  pnpmEntry: string
  /**
   * PATH 上那条叫 `pnpm` 的小脚本。**放在 `node/bin` 里是有意的**:
   * `dshEnv()` 与 `bin/dsh-start` 的 PATH 第一段都是这里,于是安装器、launchd 起的 DSH、
   * 热更新装插件那一步三条路都找得到,不用各自再加一段 PATH。
   * 换 node(解包到同一个目录)不会把它删掉 —— tar 只覆盖同名文件。
   */
  pnpmBin: string
  /** 下 pnpm 包时的暂存目录(会被 rmrf,所以由这里算出来)。 */
  pnpmDownloadDir: string
  runtimeDir: string
  /**
   * 装新运行时的**暂存目录**(2026-09-25,升 0.1.7:热更新要能换 DSH 版本)。
   *
   * 为什么不直接往 `runtime` 里 `npm ci`:那一步的第一件事就是清掉 `node_modules`,
   * 中途断网 / 断电就把一台**能用的**机器留在"半棵依赖树"上 —— DSH 起不来、界面白屏,
   * 而用户看不出是哪一步坏的(09-23 白屏事故的同一类)。所以先在这里装全、核过版本,
   * 再两次 rename 换过去(`runtime` → `runtimePrevDir`,这里 → `runtime`)。
   * 装失败、核不过,旧 runtime 一个字节没动。
   */
  runtimeNextDir: string
  /**
   * 换下来的那一份旧运行时(回滚的现成材料,也是验收第 2 条「旧 runtime 留在备份」)。
   * 换名而不是删:回滚只要把它换回来,不用重新联网装一遍 0.1.2。
   */
  runtimePrevDir: string
  runtimeDshPackageJson: string
  runtimeBinJs: string
  profileDir: string
  profilePackageJson: string
  profilePatchYml: string
  profilePluginPackageJson: string
  packagesDir: string
  binDir: string
  dshStart: string
  butlerStart: string
  channelStart: string
  logsDir: string
  webStdoutLog: string
  dshEnvFile: string
  dshCredentialsYaml: string
  /** DSH 的设置文件。安装时只往里合并 `ui-onboarding.welcomeNoticeVersion` 一个键。 */
  dshSettingsYaml: string
  /**
   * 0.1.7 把 `settings.yaml` 收进 profile 之后留下的那份原件(2026-09-25 灰度实测)。
   *
   * **0.1.7 没有 settings.yaml 这个文件了**:每次启动只要看见它,就**先改名成
   * `settings.yaml.imported`**,再把里面每个顶层段写进 profile 的 `cordis.patch.yml`
   * (上游 `packages/settings/settings/src/index.ts` 的 `importLegacyDocument`;
   * 段名按 `LEGACY_SECTION_ENTRIES` 映射,`ui-onboarding` → `ui-settings-general`)。
   *
   * 所以这个文件存在 = **「我们播的那一份,DSH 已经收下了」**。安装器据此不再重播
   * —— 重播一次就等于在下次启动时把他自己选过的模型覆盖回默认值。
   */
  dshSettingsImported: string
  credentialsJson: string
  /** 工作台自己的开关(lan_access / scan_roots / butler_cwd / …)。安装器往里写 butler_cwd。 */
  appJson: string
  /**
   * 事务官的系统提示(`<dshHome>/AGENTS.md`)。引导往里写「我叫 X」与说话方式,
   * 工作台往里写技能标记段(hooksApply 的 `wbOpsSkillsApply`)。
   *
   * 2026-09-22(卡 ①)加进这张表,是为了让**体检那一项**与**真去写的那一处**
   * 指的是同一个文件 —— 两边各拼一次字符串,迟早会出现"写了但界面还说没接上"。
   */
  dshAgentsMd: string
  /** 安装器/脚本步骤把手机包落在数据目录里的位置(普通用户机器上没有仓库,只能从这里发)。 */
  homeApk: string
  /**
   * 热更新下载下来的产物落脚处(2026-09-18)。真正用的是 `<updatesDir>/<版本号>/`。
   *
   * 放在 `~/.dsh` 下面而不是临时目录:下 350MB 的工人包断了要能接着下(`curl -C -`),
   * 而临时目录随时可能被系统清掉。**热更新只删自己算出来的这一棵**(见 update/apply.ts)。
   */
  updatesDir: string
  /**
   * 「这台机器上装着的每样产物是哪一份」(2026-09-18 增量更新,Ben:「好慢」)。
   *
   * 一份 JSON:产物种类 → 那一份的 sha256 + 跟着哪一版装上去的。更新时拿它跟清单比,
   * 一样的就**连下载带安装整步跳过**。放在 `updatesDir` 旁边、而不是 `~/.dsh/workbench/app.json` 里:
   * 它记的是**安装事实**,跟用户的设置不是一回事;删掉它最坏的结果也只是下一次多下一趟
   * (见 update/installed.ts)。
   */
  installedJson: string
  /**
   * 「自动补运行环境这件事在这台机器上试过几次了」(2026-09-26,卡 U6)。
   *
   * 一份小 JSON:锁定的 DSH 版本 + 自动试了几次 + 上一次什么时候、为什么没成。
   * **它存在的唯一理由是防循环**:补运行环境最后一步是重启 DSH,而重启之后新进程会
   * 再探一次漂移 —— 要是那一趟其实没补上(网断了、npm 装不出来),不记着就会
   * 「探到漂移 → 装 → 重启 → 探到漂移 → …」无穷转下去,机器整天在重启。
   * 记着之后:同一个锁定版本最多自动试两次,之后只亮按钮、不再自己动手。
   *
   * 放在 `~/.dsh/workbench/` 下(跟 app.json、model.json 一起):它是这台机器的状态,
   * 删掉它最坏的结果是自动补的额度重新回满。
   */
  runtimeRepairJson: string
  /**
   * 模型从哪儿来(`relay` 工作台中转 / `own` 自己的 DeepSeek Key)。归 modelConfig.ts 管,
   * 体检只读 —— 「DeepSeek 密钥」那一项要先知道他到底需不需要 Key(2026-09-23)。
   */
  modelJson: string
  /**
   * 「上一次看到辅助功能**已授权**时,壳的签名要求是哪一条」(2026-09-23)。
   * 体检判「旧签名记录」的直接依据:没有这份 = 这台机器上从没见过授权 ⇒ 只说「还没授权」,
   * 不让新用户去删一条根本不存在的记录。内容只是 codesign 的 designated requirement,不是凭据。
   */
  accessibilityGrantJson: string
  /** 装完之后事务官落脚的工作仓库(`<home>/Documents/工作台`)。 */
  workRepoDir: string
  launchAgentsDir: string
  dshPlist: string
  butlerPlist: string
  butlerServerDir: string
  butlerServerEntry: string
  channelWorkerDir: string
  channelWorkerEntry: string
  channelWorkerNativeDep: string
  /**
   * 本机房间服务(livekit-server,2026-10-21 卡 M1)。整个目录就是它一家的:二进制、配置、LICENSE / NOTICE。
   * `livekitYaml` 里有 api secret(0600),与 `channelJson` 里那一对是同一对。
   */
  livekitDir: string
  livekitBin: string
  livekitYaml: string
  /** `~/.dsh/bin/livekit-start`:launchd 那一项跑的就是它(读配置、探端口、exec livekit-server)。 */
  livekitStart: string
  livekitPlist: string
  /** 通道配置(`channel.ts` 的 `defaultChannelConfigFile` 同一处)。装本机房间时往里写钥匙,0600。 */
  channelJson: string
  /** 这台 Mac 的机器 id(`machineId.ts`)。本机房间名 `wb-local-<前 8 位>` 从它来。 */
  machineIdFile: string
  shellApp: string
  shellAppBinary: string
  claudeSettings: string
  codexHooks: string
  /** Codex 自己的设置;她在 Codex 里点的「信任」记在这里(codexHookTrust.ts 只读它的摘要,看变没变)。 */
  codexConfig: string
  /** 以下几条要仓库根;没配 repoRoot 时是 undefined。 */
  repoDshStart?: string
  repoButlerStart?: string
  repoChannelStart?: string
  repoDshPlistTemplate?: string
  repoButlerPlistTemplate?: string
  repoLivekitStart?: string
  repoLivekitPlistTemplate?: string
  repoPluginDir?: string
  repoPluginPackageJson?: string
  repoShellDir?: string
  repoShellBuildScript?: string
  repoShellSourcesDir?: string
  repoButlerServerDir?: string
  repoChannelWorkerDir?: string
  repoApk?: string
}

export function setupPaths(input: SetupPathInput): SetupPaths {
  const home = input.home
  const dshHome = input.dshHome === undefined || input.dshHome === '' ? `${home}/.dsh` : input.dshHome.replace(/\/+$/, '')
  const apps = input.applicationsDir ?? DEFAULT_APPLICATIONS_DIR
  const repo = input.repoRoot === undefined || input.repoRoot === '' ? undefined : input.repoRoot.replace(/\/+$/, '')

  const base: SetupPaths = {
    home,
    dshHome,
    nodeDir: `${dshHome}/node`,
    nodeDownloadDir: `${dshHome}/node.download`,
    nodeBin: `${dshHome}/node/bin/node`,
    pnpmDir: `${dshHome}/pnpm`,
    pnpmEntry: `${dshHome}/pnpm/bin/pnpm.mjs`,
    pnpmBin: `${dshHome}/node/bin/pnpm`,
    pnpmDownloadDir: `${dshHome}/pnpm.download`,
    runtimeDir: `${dshHome}/runtime`,
    runtimeNextDir: `${dshHome}/runtime-next`,
    runtimePrevDir: `${dshHome}/runtime-prev`,
    runtimeDshPackageJson: `${dshHome}/runtime/node_modules/@deepseek-ai/dsh/package.json`,
    runtimeBinJs: `${dshHome}/runtime/node_modules/@deepseek-ai/dsh/lib/bin.js`,
    profileDir: `${dshHome}/profiles/web`,
    profilePackageJson: `${dshHome}/profiles/web/package.json`,
    profilePatchYml: `${dshHome}/profiles/web/cordis.patch.yml`,
    profilePluginPackageJson: `${dshHome}/profiles/web/node_modules/@ben/dsh-workbench/package.json`,
    packagesDir: `${dshHome}/packages`,
    binDir: `${dshHome}/bin`,
    dshStart: `${dshHome}/bin/dsh-start`,
    butlerStart: `${dshHome}/bin/butler-start`,
    channelStart: `${dshHome}/bin/channel-start`,
    logsDir: `${dshHome}/logs`,
    webStdoutLog: `${dshHome}/logs/web.stdout.log`,
    dshEnvFile: `${dshHome}/.env`,
    dshCredentialsYaml: `${dshHome}/.credentials.yaml`,
    dshSettingsYaml: `${dshHome}/settings.yaml`,
    dshSettingsImported: `${dshHome}/settings.yaml.imported`,
    credentialsJson: `${dshHome}/workbench/credentials.json`,
    appJson: `${dshHome}/workbench/app.json`,
    dshAgentsMd: `${dshHome}/AGENTS.md`,
    homeApk: `${dshHome}/workbench/apk/app-debug.apk`,
    updatesDir: `${dshHome}/updates`,
    installedJson: `${dshHome}/updates/installed.json`,
    runtimeRepairJson: `${dshHome}/workbench/runtime-repair.json`,
    modelJson: `${dshHome}/workbench/model.json`,
    accessibilityGrantJson: `${dshHome}/workbench/accessibility-grant.json`,
    workRepoDir: `${home}/${DEFAULT_WORK_REPO_DIR_NAME}`,
    launchAgentsDir: `${home}/Library/LaunchAgents`,
    dshPlist: `${home}/Library/LaunchAgents/${DSH_LAUNCHD_LABEL}.plist`,
    butlerPlist: `${home}/Library/LaunchAgents/${BUTLER_LAUNCHD_LABEL}.plist`,
    butlerServerDir: `${dshHome}/butler-server`,
    butlerServerEntry: `${dshHome}/butler-server/server/index.cjs`,
    channelWorkerDir: `${dshHome}/channel-worker`,
    channelWorkerEntry: `${dshHome}/channel-worker/src/main.ts`,
    channelWorkerNativeDep: `${dshHome}/channel-worker/node_modules/@livekit/rtc-node`,
    livekitDir: `${dshHome}/livekit`,
    livekitBin: `${dshHome}/livekit/livekit-server`,
    livekitYaml: `${dshHome}/livekit/livekit.yaml`,
    livekitStart: `${dshHome}/bin/livekit-start`,
    livekitPlist: `${home}/Library/LaunchAgents/${LIVEKIT_LAUNCHD_LABEL}.plist`,
    channelJson: `${dshHome}/workbench/channel.json`,
    machineIdFile: `${dshHome}/workbench/machine-id`,
    shellApp: `${apps}/${SHELL_APP_NAME}`,
    shellAppBinary: `${apps}/${SHELL_APP_NAME}/Contents/MacOS/workbench`,
    claudeSettings: `${home}/.claude/settings.json`,
    codexHooks: `${home}/.codex/hooks.json`,
    codexConfig: `${home}/.codex/config.toml`,
  }
  if (repo === undefined) return base
  return {
    ...base,
    repoDshStart: `${repo}/workbench-plugin/bin/dsh-start`,
    repoButlerStart: `${repo}/workbench-plugin/bin/butler-start`,
    repoChannelStart: `${repo}/deploy/channel-start`,
    repoDshPlistTemplate: `${repo}/deploy/${DSH_LAUNCHD_LABEL}.plist`,
    repoButlerPlistTemplate: `${repo}/butler-server/launchd/${BUTLER_LAUNCHD_LABEL}.plist`,
    repoLivekitStart: `${repo}/deploy/livekit-start`,
    repoLivekitPlistTemplate: `${repo}/deploy/${LIVEKIT_LAUNCHD_LABEL}.plist`,
    repoPluginDir: `${repo}/workbench-plugin`,
    repoPluginPackageJson: `${repo}/workbench-plugin/package.json`,
    repoShellDir: `${repo}/workbench-app`,
    repoShellBuildScript: `${repo}/workbench-app/build.sh`,
    repoShellSourcesDir: `${repo}/workbench-app/Sources`,
    repoButlerServerDir: `${repo}/butler-server`,
    repoChannelWorkerDir: `${repo}/channel-worker`,
    // 手机端调试包(butler-app/README:`pnpm android:debug` 出在这里)。
    repoApk: `${repo}/butler-app/android/app/build/outputs/apk/debug/app-debug.apk`,
  }
}
