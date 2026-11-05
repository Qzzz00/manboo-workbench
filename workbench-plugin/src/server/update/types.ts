/**
 * 热更新的契约(2026-09-18)。Ben:「能加热更新的按钮吗,更新完之后重启。」
 *
 * 跟 `server/setup/types.ts` 同一条纪律:**纯类型 + 常量,不 import 任何 node 内置模块**
 * —— 浏览器那半边(`client/update/*`)直接 import 它,进 client bundle。
 *
 * ## 清单长什么样
 *
 * 服务器上一份 `https://api.aibooo.cn/updates/latest.json`(由中转的只读静态路由发,
 * 见 relay/server/app.cjs 与 deploy/aliyun-relay-setup.sh)。发版由 `deploy/publish-update.sh`
 * 在 Mac 上跑:构建 → 算 sha256 → 写清单 → rsync 上去。
 *
 * ```json
 * {
 *   "version": "0.2.42",
 *   "released_at": "2026-09-18T12:00:00Z",
 *   "notes": "这次改了什么,人话,给不懂代码的人看",
 *   "assets": {
 *     "plugin_tgz":        { "url": "...", "sha256": "…64 位十六进制…", "size": 1150000 },
 *     "scripts_tgz":       { … },
 *     "shell_app_zip":     { … },
 *     "butler_server_tgz": { … },
 *     "channel_worker_tgz":{ … },
 *     "apk":               { … }
 *   },
 *   "min_installer_version": "0.2.40"
 * }
 * ```
 *
 * **只有 `plugin_tgz` 是必须的**,别的都可以缺席 —— 绝大多数发版只动网页与插件,
 * 让它也拖着 350MB 的工人包走一趟,等于把"更新"变成一件人不愿意点的事。
 * 缺哪样就跳过对应那一步,并在进度里如实说一句(不是静默跳过)。
 */

/** 清单里一件产物。`sha256` 是**校验的唯一依据**:下完对不上就当没下到。 */
export interface UpdateAsset {
  url: string
  /** 64 位小写十六进制。发布脚本用 `shasum -a 256` 算。 */
  sha256: string
  /** 字节数。只用来显示「要下多大」与算进度条,**不作为校验依据**。 */
  size: number
  /**
   * 这一格的产物**出自哪一版**(2026-09-26,卡 U8)。缺席 = 就是这一版打的。
   *
   * 发版时没重打的那几样(apk、通话组件、事务官后端、壳)照上一版清单原样带上 ——
   * 同一个 url 与 sha256,只是 url 指着那一版的目录。带上它是为了**不说假话**:
   * 一份 0.4.1 打的手机包,在 0.4.2 的清单里也还是 0.4.1 的手机包,所以
   * 「手机包有新的了」那一格不会在它身上乱报(service.ts 的 `apk`)。
   */
  from_version?: string
}

/**
 * 认得的产物种类。顺序无意义;真正的安装顺序在 `apply.ts` 的 `PLANNED_STEPS` 里。
 *
 * - `plugin_tgz`         工作台插件(`npm pack` 出来的那个)。**必须有**。
 * - `scripts_tgz`        三个启动脚本 + 两份 plist。按仓库相对路径打包,解开就是仓库的样子。
 * - `runtime_tgz`        DSH 运行时的**锁定清单那两份文件**(几十 KB,不是那 500MB 的依赖树)。
 *                        见下面「为什么运行环境发的是一份清单」。
 * - `shell_app_zip`      构建好的 `工作台.app`。**签名身份对不上就不换**(见 apply.ts)。
 * - `butler_server_tgz`  事务官本机后端(连 node_modules)。
 * - `channel_worker_tgz` 通道层工人(连 node_modules,原生模块必须一起带)。
 * - `livekit_tgz`        本机通话服务(2026-10-21,局域网主路卡 M1):`livekit/livekit-server`(出包时已重签)、
 *                        LICENSE / NOTICE,外加它自己的启动脚本与开机自启模板 —— 启动脚本那一份没变、不下的时候,
 *                        装这一样的那一步也能把 launchd 项补上。发版用 `--with livekit`。
 * - `apk`                手机端安装包。**Mac 这边不下载它** —— 手机自己从同一个地址下,
 *                        这边只把地址与大小转给手机看(`/state.update_available_apk`)。
 * - `installer_dmg`      电脑安装包(工作台安装器.dmg)。**这台机器永远不下载它**,同 apk ——
 *                        它是给**另一台**机器用的:这一格只把地址、大小、sha256 露出来
 *                        (`/state.update.installer`),设置里「更新」那一格给一个链接。
 *                        见下面「为什么清单里要有 installer_dmg」。
 *
 * ## 为什么清单里要有 `installer_dmg`(2026-09-26,卡 SM)
 *
 * 安装包本来只有一个**手工拷来的、带版本号的地址**(`…/updates/0.4.4/工作台安装器.dmg`,
 * 交接-0924 末尾)—— 网页上的「下载地址」于是每发一版都要有人去改一行,改漏了就指着一版旧的。
 * 而清单本来就是「这一版的东西都在哪」的唯一出处,发版脚本已经在往那个目录里推产物了:
 * 把安装包也记成一格,`latest.json` 就是那个**稳定入口**(找最新的安装包 = 读最新那份清单)。
 *
 * **这台机器不装它**:已经装好的机器点「立即更新」就够了,让它去下 100MB 的 dmg 再装一遍
 * 是把「更新」变回「重装」。这一格是给**别的机器**用的 —— 他要给另一台 Mac 装、要把地址
 * 发给别人时,不必再去翻某一份交接。所以它不进 `DOWNLOADED_ASSET_KINDS`、不进更新计划的账,
 * 界面上也只是一个链接,不是一颗按钮。
 *
 * ## 为什么要有 `runtime_tgz`(2026-09-25,升 0.1.7)
 *
 * 在这之前热更新**没有换 DSH 这一步**(plugin / scripts / butler / worker / shell / launchd 六步),
 * 于是**已经装过的机器永远升不到新版 DSH**:用户机器上那份 DSH 是安装器按仓库里的锁定清单
 * `npm ci` 装的,换版本原来只有"重新下一次 dmg"一条路。加这一样就是把那条路补上 ——
 * 它是让已装用户升上 0.1.7 的**唯一**通道(评估 1.2 节最后一行)。
 *
 * ## 为什么发的是一份清单,不是一整棵树
 *
 * ① 客户端照清单 `npm ci`,装出来的每个包由 `resolved` + `integrity` 钉死,与我们这边装出来的
 *    **逐字节相同** —— 发一整棵 500MB 的树并不更安全,只是更慢;
 * ② 500MB 在慢网上是半小时,清单是几十 KB;
 * ③ 断了能接着装(下过的包在 npm 缓存里),一整棵树断了要重下。
 *
 * ## 为什么不能直接用插件包里那一份
 *
 * 锁定清单是 `import … with { type: 'json' }` 编进插件产物的,而跑这趟更新作业的**是旧那份插件的
 * 进程** —— 它手上的清单永远是旧版本的。所以新清单必须作为一件产物单独下来,由 apply.ts
 * 交给运行时那一步(`prebuilt.runtimeLockDir`)。
 */
export const UPDATE_ASSET_KINDS = [
  'plugin_tgz', 'scripts_tgz', 'runtime_tgz', 'shell_app_zip', 'butler_server_tgz', 'channel_worker_tgz', 'livekit_tgz', 'apk', 'installer_dmg',
] as const
export type UpdateAssetKind = typeof UPDATE_ASSET_KINDS[number]

/** Mac 这边真会下载的那几样(apk 不在里面,理由见上)。 */
export const DOWNLOADED_ASSET_KINDS: readonly UpdateAssetKind[] = [
  'plugin_tgz', 'scripts_tgz', 'runtime_tgz', 'shell_app_zip', 'butler_server_tgz', 'channel_worker_tgz', 'livekit_tgz',
]

/**
 * 每样产物的人话名字。进度条上那句「正在下载 2/4:通道层工人」用它。
 *
 * `runtime_tgz` 叫「运行环境」而不是「DSH 运行时锁定清单」:验收第 2 条要的是更新页上出现
 * 一句**用户看得懂**的「正在更新运行环境」,而「运行时」「锁定清单」「npm」「profile」
 * 都是占位盘查那一条盯着的内部词。
 */
export const UPDATE_ASSET_TITLES: Record<UpdateAssetKind, string> = {
  plugin_tgz: '工作台本体',
  scripts_tgz: '启动脚本',
  runtime_tgz: '运行环境',
  shell_app_zip: '工作台窗口(壳)',
  butler_server_tgz: '事务官本机后端',
  channel_worker_tgz: '通话组件',
  livekit_tgz: '本机通话服务',
  apk: '手机端安装包',
  installer_dmg: '电脑安装包',
}

export interface UpdateManifest {
  version: string
  released_at?: string
  /** 这一版改了什么,人话。界面上原样显示给 Ben 看,所以发版时就要写成人话。 */
  notes?: string
  assets: Partial<Record<UpdateAssetKind, UpdateAsset>>
  /**
   * 低于这个版本的机器**升不过来**(比如中间换过安装步骤的形状),要重新下安装包 dmg。
   * 缺席 = 任何版本都能直接升。
   */
  min_installer_version?: string
}

/** `GET /update/check` 回的东西。界面上「当前版本 / 有没有新版 / 新版说了什么 / 要下多大」。 */
export interface UpdateCheckView {
  /** 这会儿跑着的插件版本(src/version.ts 构建时注入的那个)。 */
  current: string
  /** 服务器上最新那版。取不到清单时缺席。 */
  latest?: string
  /** 有没有值得装的新版(latest > current)。 */
  available: boolean
  /** 新版的说明,人话。 */
  notes?: string
  /**
   * 这次**真要下**多少字节(2026-09-18 起只算有变化的那几件;apk 不算)。
   * 没变的那几件不在里面 —— 按钮上那句「要下 12MB」说的就是这个数。
   */
  size?: number
  /**
   * 这次的账:几件、几件变了、要下多少、不比对的话本来要下多少(2026-09-18)。
   * 界面上那句「5 项里 2 项有变化,下载 12MB」用它。清单取不到时缺席。
   */
  plan?: UpdatePlanView
  /** 清单里带了手机包时:版本、地址、大小。手机端设置里显示的就是它。 */
  apk?: { version: string, url: string, size: number }
  /** 这次检查是什么时候做的(ISO)。 */
  checked_at: string
  /**
   * 取清单没取成时的人话(没网 / 服务器 404 / 清单写坏了)。
   * **有 error 时 available 一定是 false**:查不到不等于没有新版,但也绝不能当成有。
   */
  error?: string
  /**
   * 这一份压根不查更新(2026-10-21,零服务器档):构建没带更新地址、或 endpoints.json 里写了 off。
   * 这时 `error` 是那句说明,界面不给「再查一次」(查多少次都一样)。
   */
  not_configured?: true
  /**
   * 这台机器太旧、热更新跨不过去(`min_installer_version` 比当前版本新)。
   * 有它的时候界面不给「立即更新」,只给一句「去重新下一次安装包」。
   */
  needs_installer?: string
  /**
   * **插件版本没落后,落后的是运行环境**(2026-09-26,卡 U6)。
   *
   * 09-26 生产切换那天真撞上的:旧客户端执行新版热更新时跳过了 `runtime` 那一步,
   * 于是插件已经是新版、运行环境还是旧的;而「检查更新」原来只比插件版本号,
   * 从此永远回 `available:false` —— 运行环境装不上了。所以这一档也算「有更新」,
   * 只是这一趟**只跑运行环境那一步**(+ profile 修正 + 重启),没有下载几十兆那一段。
   *
   * 有它的时候 `notes` 是我们自己写的那句人话(不是发版说明),`plan` 里只有「运行环境」那一件。
   */
  runtime_only?: boolean
  /**
   * **版本号一样,可这一版里还有几样没装到这台电脑上**(2026-10-03,第 ③ 档)。
   *
   * 0.4.89 发完那十分钟真撞上的:发版闸只装了插件,`current == latest == 0.4.89`,
   * 于是设置里写着「没有更新」;而同一份回包的 `plan` 里事务官后端(没有语气代码)与
   * 电话工人(没有中文打断)都 `changed: true` —— 两个进程都还是旧的,而且**再也装不上**
   * (`available` 只认版本号与运行环境那两档)。
   *
   * 有它的时候 `current` 与 `latest` 照实都是同一个版本号(不编一个新版本号),
   * `notes` 是我们自己写的那句人话(`componentsBehindNotes`),按下去那一趟按 `plan`
   * 只装 `changed` 的那几样。
   *
   * **只数有凭据的那几件**(`behindItems`):没记过是哪一份的那几样不算"没装" ——
   * 否则刚用安装包装好的机器一打开就会被告知有一堆东西没装。
   */
  components_behind?: boolean
  /** 这一趟查的是哪条更新通道(见 `UPDATE_CHANNELS`)。 */
  channel?: UpdateChannel
  /**
   * 收热修的机器,服务器上还没有热修清单(`beta.json` 回 404),这一趟照稳定版那份清单查的。
   * 稳定版从不落后于热修,所以这时候稳定版就是热修通道上最新的那一版。
   */
  channel_fallback?: boolean
}

/**
 * 更新通道(2026-10-21,内测发版底座)。
 *
 * - `stable`(缺省):体验的人收。每周一次,发前在隔离的新机器上演练过(`pnpm rehearse`)。
 * - `hotfix`:维护者与统筹收。一天可能好几版,修完就发。
 *
 * 服务器上两份清单放在同一个目录:稳定版是 `latest.json`(从第一天起就是它,老客户端只认它),
 * 热修是 `beta.json`。发稳定版时两份一起写,所以热修通道上的版本永远不旧于稳定版。
 *
 * **切回稳定版不降级**:本机装着的热修版比稳定版新时,检查更新照实说「没有新版」,
 * 等稳定版追上来再收(`isNewerVersion` 只认更新的那一边)。
 */
export const UPDATE_CHANNELS = ['stable', 'hotfix'] as const
export type UpdateChannel = typeof UPDATE_CHANNELS[number]
export const DEFAULT_UPDATE_CHANNEL: UpdateChannel = 'stable'

/** 每条通道读服务器上哪一份清单。与 `deploy/publish-update.sh` 写的那两个文件名逐字相同。 */
export const UPDATE_CHANNEL_MANIFEST: Record<UpdateChannel, string> = {
  stable: 'latest.json',
  hotfix: 'beta.json',
}

/** 设置里那两个选项的说法。 */
export const UPDATE_CHANNEL_TITLES: Record<UpdateChannel, string> = {
  stable: '稳定版(每周一次)',
  hotfix: '热修(维护者用)',
}

export function isUpdateChannel(value: unknown): value is UpdateChannel {
  return typeof value === 'string' && (UPDATE_CHANNELS as readonly string[]).includes(value)
}

/**
 * 「运行环境还没换到这一版」这件事对外的样子(2026-09-26,卡 U6)。
 *
 * `/state.update.runtime_stale` 与设置里「更新」那一格读同一份;事务官也看得见
 * (它要能说出"这台电脑还差一次运行环境"这件事)。判据在 `setup/dshRuntimeLock.ts`
 * 的 `readRuntimeDrift` —— 这里只是把它翻成给人看的几句话。
 */
export interface UpdateRuntimeStaleView {
  /** 那一句人话,原样显示 / 原样弹通知。 */
  says: string
  /** 这一版锁定的 DSH 版本。 */
  locked: string
  /** 这会儿装着的那一版。读不出来缺席(没装上),**不猜**。 */
  installed?: string
  /** 界面上那颗按钮写什么。 */
  action_label: string
  /**
   * 自动补那一趟(0.3.x 升上来那条路)的状态。**缺席 = 这会儿没有自动补在跑**。
   * `stopped` 是防循环停下来了:自动试过 `attempts` 次都没成,不再自动试 —— 按钮还在。
   */
  repair?: {
    state: 'running' | 'failed' | 'stopped'
    /** 这会儿在干什么 / 为什么停了,人话。 */
    says: string
    /** 在跑的那条作业 id(界面用 `/setup/install/:job` 轮询,与一键装同一套)。 */
    job?: string
    /** 自动试过几次。 */
    attempts: number
  }
}

/** 更新作业跑到哪一步了。形状与 `SetupJobView` 对齐 —— 界面用的是同一套轮询与同一个进度框。 */
export interface UpdateJobView {
  id: string
  /** 固定 'update'。留这个字段是为了跟 SetupJobView 同形,界面那个组件不用分叉。 */
  step: 'update'
  state: 'running' | 'done' | 'failed'
  started_at: string
  finished_at?: string
  /** 这会儿在干什么,人话。 */
  note?: string
  /** 失败原因,人话。 */
  error?: string
  /** 原始输出的尾 20 行。 */
  tail: readonly string[]
  /** 装的是哪一版。 */
  version: string
  /** 0–100。下载那一段按字节算,安装那几步按步数算(见 apply.ts 的 `progressOf`)。 */
  progress: number
  /** 当前这一步的标题(「正在下载」「正在安装工作台本体」…)。 */
  phase: string
  /** 已经发出重启了。界面据此显示「重启中…」并开始等页面自己回来。 */
  restarting?: boolean
  /** 有意跳过的那几步,各一句人话(壳签名对不上、清单里没带这一样)。界面在结尾原样列出来。 */
  skipped: readonly string[]
  /**
   * 下载这一段的实时账(2026-09-18)。跑到下载那一步才有,下完就不再更新。
   * 界面拿它画「已下 12.3 MB / 28.0 MB · 1.2 MB/秒 · 大约还要 13 秒」。
   */
  download?: UpdateDownloadProgress
  /**
   * 跟本机装着的那份**一模一样、这次整件跳过**的产物,各一句人话(2026-09-18)。
   * 跟 `skipped` 分开:那个说的是"这次没换成",这个说的是"本来就不用换"。
   */
  unchanged: readonly string[]
}

/** `/state` 里那一格(2026-09-18)。**读的是上一次后台检查的结论,不现查**。 */
export interface UpdateStateView {
  current: string
  latest?: string
  available: boolean
  notes?: string
  checked_at: string
  /**
   * 运行环境还没换到这一版(2026-09-26,卡 U6)。
   *
   * **跟「有没有新版」是两回事**,所以单开一格:插件已经是最新的、`available` 是 false,
   * 这一格照样可能有东西 —— 那正是 09-26 那台机器的样子。它不等后台去查清单
   * (读的是本机的运行时目录),所以**一打开就看得见**,没网也看得见。
   */
  runtime_stale?: UpdateRuntimeStaleView
  /**
   * 这一版的**电脑安装包**在哪(2026-09-26,卡 SM)。给**别的机器**装用 ——
   * 与「这台有没有新版」无关(`available` 是 false 时它照样在),所以单开一格。
   * 清单里没这一格(老服务器、还没发过带安装包的版本)就缺席,**不编一个地址**。
   */
  installer?: UpdateInstallerView
  /** 上一次查的是哪条通道。没查过就缺席。 */
  channel?: UpdateChannel
}

/**
 * 云上那份手机包(清单里的 `assets.apk`),**与「电脑这边有没有新版」无关**(2026-09-18)。
 *
 * 跟 `UpdateApkStateView` 的区别就在这一句:那一格问的是「有没有**新**的手机包」(要比版本),
 * 这一个问的是「**那个包在哪**」。首次流程的二维码、手机端「重新下载手机包」要的都是后者 ——
 * Ben 真机上扫出来的是局域网 IP,一出门就失效(决策记录 2026-09-18「包一律放阿里云服务器」)。
 */
export interface UpdateCloudApk {
  /** 清单自己的版本号 —— 手机包跟着工作台一起发,没有单独的版本号。 */
  version: string
  url: string
  size: number
  /** 64 位十六进制。清单已经校验过它的形状(manifest.ts),这里原样带出去给人核对。 */
  sha256: string
}

/**
 * 清单里那份**电脑安装包**(`assets.installer_dmg`),2026-09-26,卡 SM。
 *
 * 与 `UpdateCloudApk` 同一条口径:问的是「**那个包在哪**」,不是「有没有**新**的」——
 * 所以它**不比版本**、与 `available` 无关,查到过一次清单就一直在。
 * `version` 说的是那份 dmg **真出自哪一版**(清单里带 `from_version` 就照它说,卡 U8)——
 * 一份 0.4.4 打的安装包,在 0.4.6 的清单里也还是 0.4.4 的安装包,界面上不许说成 0.4.6。
 */
export interface UpdateInstallerView {
  version: string
  url: string
  size: number
  /** 64 位十六进制。原样带出去给人核对(清单已经校验过它的形状)。 */
  sha256: string
}

/** `/state.update_available_apk`:电脑这边知道有新的手机包了。手机端设置里显示它。 */
export interface UpdateApkStateView {
  version: string
  url: string
  size: number
}

export function isUpdateAssetKind(value: unknown): value is UpdateAssetKind {
  return typeof value === 'string' && (UPDATE_ASSET_KINDS as readonly string[]).includes(value)
}

/** 「1.1 MB」这种。给人看的,不做精确计量 —— 服务端与浏览器共用同一份,免得两处各说一个数。 */
export function humanSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} 字节`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`
}

/* ─────────────────────── 只下变了的(2026-09-18,Ben:「好慢」) ─────────────────────── */

/**
 * `~/.dsh/updates/installed.json` 里一条:**这台机器上装着的那一份产物是哪一份**。
 *
 * 只记 sha256 —— 它就是清单里锁着的那个数,两边一样就是同一份字节,不用再比版本号、
 * 不用再比时间戳(那两样都能对但字节不同,反过来也一样)。
 */
export interface InstalledAssetRecord {
  /** 64 位小写十六进制。装上去的那一份产物文件的 sha256。 */
  sha256: string
  /** 跟着哪一版装上去的。只用来在日志与界面上说人话,**不参与判断**。 */
  version: string
  /** 装于什么时候(ISO)。同上,只给人看。 */
  at: string
}

/** `installed.json` 整份。读不懂、缺文件都退化成「一条记录都没有」——最坏的结果只是多下一趟。 */
export interface InstalledAssets {
  /** 上一次装完的那一版。给人看的,不参与判断。 */
  version?: string
  updated_at?: string
  assets: Partial<Record<UpdateAssetKind, InstalledAssetRecord>>
}

/**
 * 一件产物这次到底下不下。`changed=false` 的那几件**连下载带安装整步跳过**。
 *
 * `source` 说的是"凭什么这么判",三种:
 * - `record`:`installed.json` 里有记录,拿它比的 —— 最可靠;
 * - `local`:没记录,对本机已经装着的那份现算了一次 sha 兜底(今天只有插件 tgz 算得出来);
 * - `none`:两样都没有,**照下**。「没查出来」不能当成「没变」(D13)。
 * - `missing`:这台电脑上**确实没有**这一样(文件不在,2026-10-21 起只有本机通话服务判得出)。
 *   跟 `none` 不同,这是凭据:第 ③ 档(版本号一样、还有几样没装上)数得着它。
 */
export interface UpdatePlanItem {
  kind: UpdateAssetKind
  /** 人话名字(`UPDATE_ASSET_TITLES`)。界面直接显示。 */
  title: string
  size: number
  changed: boolean
  source: 'record' | 'local' | 'none' | 'missing'
  /** 给人看的一句话:「没变,跳过」「有变化」「本机这份认不出来,照下一次」。 */
  why: string
}

/** 这次更新的账:几件、几件变了、要下多少。界面上那句「5 项里 2 项有变化,下载 12MB」用它。 */
export interface UpdatePlanView {
  items: readonly UpdatePlanItem[]
  /** 清单里会下载的产物件数(apk 不算)。 */
  total: number
  /** 其中有变化、这次真要下的件数。 */
  changed: number
  /** 这次真要下的字节数。 */
  bytes: number
  /** 不比对的话本来要下的字节数。界面上那句「省下 96MB」用它减 bytes。 */
  all_bytes: number
}

/**
 * 下载这一段的实时账(2026-09-18)。**每一项都可能缺席,缺了就别显示那半句** ——
 * 刚开始下的头一秒算不出速度,算不出就不给(0918 热更新那张卡第 4 条:宁可缺席,不给假的)。
 */
export interface UpdateDownloadProgress {
  /** 这次要下的总字节(= 计划里 changed 那几件之和)。 */
  total: number
  /** 已经下到的字节(下完的那几件 + 正在下的那件此刻的大小)。 */
  done: number
  /** 字节/秒。头一两秒没有。 */
  bytes_per_sec?: number
  /** 估计还要多少秒。没速度就没有它。 */
  eta_seconds?: number
  /** 正在下的是哪一件(人话名字)。都下完了就没有。 */
  current?: string
}
