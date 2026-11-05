/**
 * 登录台(初始化页)的服务端契约(2026-09-17,docs/设计-电脑端登录台梳理-2026-09-17.md)。
 *
 * 这个文件只有形状,没有任何 I/O —— 服务端(server/setup/*)与浏览器(client/setup/*)
 * 共用同一份类型,所以它必须是纯类型 + 常量,不能 import 任何 node 内置模块
 * (client bundle 会把它打进去)。
 *
 * 一条纪律贯穿整块登录台:**体检结果只说观察到的事实**。取不到就说取不到(state 里
 * 没有 'unknown' 这一档是故意的 —— 取不到属于 'missing',而 detail 里要写清楚
 * 「是没装,还是没法判断」),绝不把「没查出来」显示成绿灯(D13)。
 */

/**
 * 一项体检的四种结局。
 *
 * - `ok`        已就绪,不用管。
 * - `missing`   程序能装,现在没有 —— 配 `action.kind === 'install'`。
 * - `stale`     有,但旧了 / 跟仓库对不上 —— 同样能一键装,装的是"覆盖成新的"。
 * - `needs_user` 只能 Ben 本人做(系统授权、填密钥、装客户端),程序只能引路。
 */
export type SetupItemState = 'ok' | 'missing' | 'stale' | 'needs_user'

/** 一键装的步骤名。顺序就是从零装机的顺序,前面没装好后面多半会失败(但每步都可单独重跑)。 */
export const SETUP_INSTALL_STEPS = [
  'node', 'runtime', 'profile', 'plugin', 'scripts', 'launchd', 'shell', 'butler', 'worker', 'livekit', 'web_login', 'restart',
] as const
export type SetupInstallStep = typeof SETUP_INSTALL_STEPS[number]

export function isSetupInstallStep(value: unknown): value is SetupInstallStep {
  return typeof value === 'string' && (SETUP_INSTALL_STEPS as readonly string[]).includes(value)
}

/**
 * 「去授权」那颗键能把她送到的地方。前四条是系统设置里的一页(值是 macOS 的
 * x-apple.systempreferences URL 后缀),见 panes.ts。
 *
 * 2026-10-13 多两条,都是「完全磁盘访问」那一格要的:
 * - `all_files`   —— 隐私与安全性 → 完全磁盘访问那一页;
 * - `node_binary` —— **不是一页,是一个文件**:`open -R ~/.dsh/node/bin/node`,
 *   在访达里弹出并选中要拖进那张表的那条 node。`.dsh` 是隐藏目录,她在系统设置的
 *   选文件框里翻不到它,所以这一下不是方便,是必需。路径由服务端给(panes.ts),
 *   客户端一个路径都传不进来。
 */
export const SETUP_PANES = ['accessibility', 'files', 'calendar', 'automation', 'all_files', 'node_binary'] as const
export type SetupPane = typeof SETUP_PANES[number]

export function isSetupPane(value: unknown): value is SetupPane {
  return typeof value === 'string' && (SETUP_PANES as readonly string[]).includes(value)
}

/**
 * 体检项上那颗按钮。**主按钮一项只有一个**(`action`):两个主按钮的那种项(既能装又要授权)
 * 在现实里不存在 —— 装完之后才轮到授权,那是下一次体检的事。
 */
export type SetupAction =
  /** 关 1:一键装。 */
  | { kind: 'install', step: SetupInstallStep, label: string }
  /** 关 2:打开系统设置的某一页(或在访达里显示要加的那个文件),回来点「再核一次」。 */
  | { kind: 'open_pane', pane: SetupPane, label: string }
  /** 关 4:这家客户端没装,给官网/下载页。 */
  | { kind: 'link', url: string, label: string }
  /** 关 3:DSH 网页 token → cookie,前端拿地址跳一次。 */
  | { kind: 'web_login', label: string }
  /** 关 3/5/6:去工作台自己的某处配置(密钥面板、路径设置、事务官后台)。 */
  | { kind: 'config', target: string, label: string }
  /**
   * 当场再体检一次(2026-10-13)。页头那颗「重新检查」早就有,这一档是给
   * **「出去点一下、回来确认」那种项**用的:她在系统设置里拖完文件,手就停在这一格上,
   * 不该让她为了确认跑回页头。按下去走的就是页头那一下(client/setup/SetupPage.tsx)。
   */
  | { kind: 'recheck', label: string }

export interface SetupItem {
  /** 稳定键,前端按它分组与做用例断言。 */
  key: string
  /** 人话标题。 */
  label: string
  state: SetupItemState
  /** 观察到的事实,一句话。绝不写成"应该没问题"。 */
  detail: string
  /** 怎么修,人话。已就绪时缺席。 */
  fix?: string
  /** 属于九步里的第几步(设计文档第三节)。 */
  step: number
  /**
   * 「不弄它工作台也能用」。**只影响 all_ok**(也就是初始化页还会不会自己冒出来),
   * 不影响它在页面上照常显示一盏灯。
   *
   * 哪些算可选是有判据的,不是拍脑袋:少了它**主路(看板 + 窗位 + 会话)仍然成立**的,
   * 就是可选 —— 各家客户端(没装只是那一家「未接入」)、通道层工人(手机通话)、
   * 事务官本机后端(形象与音色)、日历。反过来,少了 node / 运行时 / profile / 插件 /
   * 启动脚本 / launchd / 壳 / 仓库路径 / 三项密钥与授权,工作台要么起不来、要么整片红字。
   */
  optional?: boolean
  action?: SetupAction
  /**
   * 主按钮之外还要的几颗(2026-10-13,「完全磁盘访问」那一格)。缺席 = 没有,老用例一条不改。
   *
   * 为什么这一格真的需要三颗:她要做的是**三步**,而且少一步就做不完 ——
   * 打开那一页、在访达里把那条隐藏目录里的 node 翻出来拖进去、回来确认。
   * 这不是"顺手再给一条路",是同一件事的三段。**别的项不要往这里加东西**:
   * 一项一句话一颗键那条口径(SettingsDialog 文件头第 3 条)仍然是默认。
   */
  extras?: readonly SetupAction[]
}

export interface SetupStatus {
  items: readonly SetupItem[]
  /**
   * **每一项非可选的都 ok** 才为真。这也是壳那边 `setup_required` 的反面 ——
   * 没装微信不该让初始化页天天自己弹出来(可选项见 SetupItem.optional)。
   */
  all_ok: boolean
  /** 可选项里还没就绪的个数。界面用它说一句「另有 n 项可选的没弄」,不影响 all_ok。 */
  optional_pending: number
  /** 这份体检是什么时候做的(ISO)。界面显示"刚刚检查过"。 */
  checked_at: string
}

/**
 * 顶上那两条横幅要的两件事(2026-09-17 引导入口)。**登录与引导都不包含它们** ——
 * 缺授权、缺密钥都不该拦住人进工作台,只在顶上说一句、给一条去的路。
 * 这一份读的是上一次体检的结论(service.alerts),所以挂在每秒轮询的 /state 上不花钱。
 */
export interface SetupAlerts {
  /** 辅助功能授权缺着(窗位、拖窗、认领全靠它)。 */
  accessibility: boolean
  /** DeepSeek 密钥两处没齐(额度、事务官接话要它)。 */
  deepseek_key: boolean
  /**
   * 「缺辅助功能」是哪一种(2026-09-18)。**只在 accessibility 为真时出现**,
   * 缺席一律按 `'unauthorized'` 读 —— 老服务端(还没有这个字段)与"看不到"
   * (壳根本没连上,谈不上哪一种)都走那一支,界面上就是今天这句「还差一个授权」。
   *
   * `'stale_record'` 说的是 Ben 2026-09-18 真机上那一幕:系统设置里那个开关**开着**,
   * 壳却报未授权 —— 那条记录对应的是换证书之前那一份壳(TCC 认签名不认路径,
   * 见 docs/交接-0918-壳稳定签名.md)。这一支要说的是"把它移除再重新添加",
   * 而不是"去把开关打开" —— 后者他已经做过了,再说一遍就是把人往回赶。
   */
  accessibility_kind?: 'unauthorized' | 'stale_record'
  /**
   * 「完全磁盘访问」还缺着(2026-10-13)。**真 = 还缺着**(同上面两格的口径);
   * **缺席 = 还没体检过、或者这台机器上探不着**(「没查过」不是「没缺」)。
   *
   * 缺着的后果只有一样,但那一样要紧:**手机上看不到电脑上的文件** —— 每次取文件
   * macOS 都在电脑上弹一个「node 想要访问…」的框等人点,而她要看文件的场景恰恰是
   * 她不在电脑桌前(维护者 2026-10-13 早)。所以这一条照辅助功能的样子在顶上说一句。
   */
  file_access?: boolean
}

/** 一次安装作业的对外视图。**不含任何密钥**:tail 是命令的原始输出尾巴,步骤本身不传密钥。 */
export interface SetupJobView {
  id: string
  step: SetupInstallStep
  state: 'running' | 'done' | 'failed'
  started_at: string
  finished_at?: string
  /** 这会儿在干什么,人话(「在装 @deepseek-ai/dsh,网络慢会久一点,断了能接着来」)。 */
  note?: string
  /** 失败原因,人话。成功时缺席。 */
  error?: string
  /** 原始输出的**尾 20 行**。失败时它是唯一能照着查的东西。 */
  tail: readonly string[]
  /** web_login 那一步回的带 token 地址;别的步骤缺席。 */
  url?: string
}

/** 手机端 APK 的取包情况(GET /setup/apk 的兄弟接口,给二维码用)。 */
export interface SetupApkView {
  /** 出过包就有:文件大小与修改时间,前端据此说"这个包是什么时候出的"。 */
  available: boolean
  path: string
  size?: number
  built_at?: string
  /** 没出过包时的人话:照着这句在仓库里跑一下就有了。 */
  hint?: string
  /**
   * 手机扫的地址。**优先是阿里云上那份**(2026-09-18);云上取不到时才是局域网地址,
   * 而局域网地址只在"局域网访问开着、且真拿得到本机 IP"时才有 —— 两样都没有就缺席
   * (D13:宁可没有二维码,也不给一个手机连不上的地址)。
   */
  url?: string
  /**
   * 这个 url 是哪儿来的(2026-09-18「包一律放阿里云服务器」):
   * - `cloud` —— 更新清单里的 `assets.apk`,公网地址,**出了这间屋子也扫得通**;
   * - `lan`   —— 这台电脑自己发的 `http://<局域网 IP>:8791/setup/apk`,只在同一个 Wi-Fi 下有效。
   *
   * 界面据此换二维码底下那行小字。没有 url 时这一格也缺席。
   */
  source?: 'cloud' | 'lan'
  /** 云上那份包的校验和(64 位十六进制,清单里钉着的)。局域网那份没有。 */
  sha256?: string
  /** 云上那份包的版本号(手机包跟工作台同一个版本号)。局域网那份没有。 */
  version?: string
}
