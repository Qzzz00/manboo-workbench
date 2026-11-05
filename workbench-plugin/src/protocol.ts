/**
 * 工作台本地服务的线上协议（PRD §8.3）。
 *
 * 这是工作台、各 agent 上报方、展示台三者之间唯一的契约。
 * display-client 不 import 本文件（两边工具链独立），而是保有一份等价的类型副本；
 * 改动这里必须同步 display-client/src/display/workbenchProtocol.ts。
 */

import type { ExperimentsView, FirstUseView } from './mainPaths.ts'

/** 会话来源。第一版固定四家，接不上的也要占位以便界面标明"未接入"。 */
export type AgentId = 'dsh' | 'claude' | 'codex' | 'kimi'

export const AGENT_IDS: readonly AgentId[] = ['dsh', 'claude', 'codex', 'kimi']

/**
 * 各家桌面客户端(2026-09-17「每个区域单独解锁」)。
 *
 * 跟 `AgentId` 是两回事,别混:`AgentId` 是**会话来源**(含 `dsh`,它没有桌面客户端),
 * 这里是**装在这台 Mac 上的那个 App**(含微信/企微,它们没有会话)。两张表的交集是
 * claude/codex/kimi —— 额度面板与顶部状态点用的正是这个交集。
 */
export type ClientKey = 'claude' | 'codex' | 'kimi' | 'wechat' | 'wecom'

export const CLIENT_KEYS: readonly ClientKey[] = ['claude', 'codex', 'kimi', 'wechat', 'wecom']

/**
 * **有额度的那几家客户端**(2026-09-25,卡 fix/quota-and-slot-apps)。
 *
 * 额度面板、「已接上 N 家」那一行、「全部接上」只认这三家(DeepSeek 另算:它没有桌面客户端)。
 * 微信 / 企业微信是聊天应用:没有额度、没有「接」这一步,**永不算接上**,也不出现在额度那一块
 * —— 维护者 09-24 引导完看到「已接上 2 家:微信、企业微信」,原话:「接微信和企业微信干嘛,
 * 这两家有额度???」。它们只在窗位清单里用得上 `installed`。
 */
export const QUOTA_CLIENT_KEYS: readonly ClientKey[] = ['claude', 'codex', 'kimi']

/**
 * 一家客户端的三态(Ben 2026-09-17:「扫描到了再开始,最好每个区域单独解锁」)。
 *
 * - `installed=false` → 这家**整块不出现**:不显示、不催、不占位。没装 Kimi 的人
 *   不该在界面上看见一格写着「Kimi 未接入」—— 那是在替他操心一件他没打算做的事。
 * - `installed=true, connected=false` → 出一张**解锁卡**:名字 + `how` 那一句 + 一颗按钮。
 * - `connected=true` → 才显示真数字。
 *
 * `how` 只在没接上时有:接上了就没有"下一步"可说,写一句空话不如缺席(D13)。
 *
 * 聊天类(微信 / 企微,不在 `QUOTA_CLIENT_KEYS` 里)**`connected` 恒为 false、没有 `how`**
 * (2026-09-25):它们没有「接」这回事,说「接上了」是句假话,说「还没接」也是。
 */
export interface ClientAreaView {
  installed: boolean
  connected: boolean
  /** 没接上时,下一步该做什么的人话。**一句、一个动作**,不是一段说明书。 */
  how?: string
}

/** 五家各一格。**整格缺席 = 还没扫过**(不是"都没装"),界面据此退回"全都显示"。 */
export type ClientsView = Readonly<Record<ClientKey, ClientAreaView>>

/**
 * 探到装了的一家(2026-09-27,卡 HC)。`id` 是登记表 id、`bundle_id` 是它的包标识。
 * 名字来自那张知识表(`FAMILY_SOURCES`)—— 「认得出是谁」可以写死,「有哪几家」不行。
 */
export interface InstalledAgentView {
  id: string
  name: string
  bundle_id: string
  /**
   * **这一家装着的那几个 App**(2026-09-28,卡 DP):只有同一台上装着两个以上时才有这一格。
   * 界面照旧一家一条;派活那一刻挑哪一个由 `agentSources.pickFamilyPackage` 一处说了算
   * (她说「豆包工作」= `com.work.pc.doubao`)。
   */
  packages?: readonly { bundle_id: string, name: string }[]
}

/**
 * **这台电脑上装了哪几家 AI**(2026-09-27,卡 HC)。`at` 是这一份什么时候探的。
 * **整格缺席 = 还没探过**(不是「一家都没装」),上层据此退回"全都显示"。
 */
export interface InstalledAgentsView {
  agents: readonly InstalledAgentView[]
  at: string
}

/**
 * 有额度的一家此刻的样子(2026-09-25,卡 fix/quota-and-slot-apps)。
 *
 * - `connected`     接上了(额度数字取得到);
 * - `one_click`     Claude / Codex 装了没接:点一次「全部接上」就好(工作台替他写,写完能撤回);
 * - `login`         Kimi 装了没登:**要他本人登一次**(账号密码工作台不经手);
 * - `setup`         DeepSeek 没走中转、也没填 Key:去设置里二选一;
 * - `not_installed` 没装 —— 不提、不催;
 * - `unknown`       这会儿说不出来(还没取过数 / 这次没取到)—— **别说成没接上**(D13)。
 */
export type QuotaProviderState = 'connected' | 'one_click' | 'login' | 'setup' | 'not_installed' | 'unknown'

export interface QuotaConnectView {
  /** 固定顺序:DeepSeek、Claude、Codex、Kimi。 */
  providers: readonly { agent: AgentId, label: string, state: QuotaProviderState, note?: string }[]
  /** Claude / Codex 有一家是 `one_click` 就 true(「全部接上」那颗要不要亮)。 */
  one_click: boolean
  /** 现成的一句人话:「DeepSeek 已接上;Claude、Codex 要你点一次『全部接上』;Kimi 要你自己登一次」。 */
  line: string
}

/** 会话状态。PRD §5.3 的四种状态，外加 error/offline 两种上报类型。 */
export type SessionStatus = 'waiting' | 'running' | 'done' | 'error' | 'offline'

/**
 * 状态变化的成因。waiting 必须带 reason 以区分"等审批"和"等你下一句"——
 * 只有前者到时才允许响铃（PRD §7.2）。
 */
export type EventReason =
  | 'permission_prompt'
  | 'idle_prompt'
  | 'stop'
  | 'error'
  | 'interrupted'
  | 'offline'

/**
 * 等待原因(2026-09-09 傍晚拍板第 4 条:等审批 / 等你输入 / 额度不足 / 出错 分开)。
 *
 * 与 EventReason 是两个层面:EventReason 是**来源给的成因**(响铃判定只认它的 permission_prompt),
 * 这四个 id 是**给 Ben 看的分类**。它们没有并成一个枚举,因为响铃规则不动(仍只有等审批响),
 * 而「额度不足」这一档根本不是任何来源报上来的——它由额度采集器按 quota 打标。
 *
 * 纪律(D13):**能可靠判定才填,判不出就不填**。每家来源在自己的翻译层填
 * (hooks.ts / kimiSessionFeed / codexSessionFeed / dshSessionFeed),各家能填哪几种见
 * docs/交接-0909-等待原因分类.md 的那张表——Kimi 只有一个 blocked、Codex 没有等待态,两家都一种不填。
 *
 * 任务板「阻塞」列的卡挂的原因(TaskView.block_reason)用的也是这套 id,不另造一套。
 * 可选字段:protocol.ts 是与 display-client 的三方契约,只能加可选字段;展示台本期不读它,副本不同步。
 */
export type WaitReason = 'approval' | 'input' | 'quota' | 'error'

export const WAIT_REASONS: readonly WaitReason[] = ['approval', 'input', 'quota', 'error']

/** 四个原因的中文名。服务端与客户端共用一份,两边各写一份迟早会漂(先例:STATUS_TITLES)。 */
export const WAIT_REASON_TITLES: Record<WaitReason, string> = {
  approval: '等审批',
  input: '等你输入',
  quota: '额度不足',
  error: '出错',
}

/** POST /event 的请求体：各来源上报一次状态变化。 */
export interface WorkbenchEvent {
  agent: AgentId
  session_id: string
  /** 所属项目。取不到时由服务端按 cwd 推断。 */
  project?: string
  cwd?: string
  type: SessionStatus
  reason?: EventReason
  /** 等待原因。来源能可靠判定才带;缺省就是「判不出」,服务端与界面都不替它猜。 */
  wait_reason?: WaitReason
  title?: string
  /** 从 transcript 最后几轮生成。拿不到时留空，不允许编造（PRD §5.3）。 */
  summary?: string
  /**
   * 最近在做什么(2026-09-25,卡 P):一句人话 + 那一刻,从会话记录最后几条里挑的(server/sessionDigest.ts)。
   * 读不到就缺席 —— 界面写「读不到它在做什么」,不写占位话。
   */
  activity?: SessionActivity
  /**
   * 这条会话是工作台自己起的(2026-09-25,卡 V)。见 `SELFCHECK_*`。
   * **一旦报过就跟着这条会话**(sessions.ts 沿用上一次已知值):探针的记号不会因为下一拍读不到就掉。
   */
  selfcheck?: SelfcheckView
  /** 出错那一档的人话 + 一键入口(src/humanError.ts 翻好的)。 */
  human_error?: HumanErrorView
  /** 判成这个状态的依据,一句话。 */
  status_why?: string
  /** 记录里明写着停下来在等人(形式信号;内容判断归卡 T)。 */
  formal_wait?: 'approval' | 'question'
  /** Unix 秒。缺省时服务端用接收时刻。 */
  ts?: number
  /**
   * **最后一次动静是几点**(Unix 秒,2026-09-27,卡 LK)。缺席 = 与 {@link ts} 同一刻。
   *
   * `ts` 说的是「进入这个状态是几点」(会话表拿它算「跑了多久」),而这一格说的是
   * 「这条会话最近一次有东西写出来是几点」(拿它算「多久没动静」)。
   * 原来两件事共用一个数,于是一条在跑四小时、每分钟都在写文件的 Codex 对话,
   * 「最后一次动静」被说成「快四个小时前」—— 那是它**开始**那一刻,不是它最近一次动。
   */
  output_ts?: number
}

/**
 * 话机摘挂机事件的类型。offhook=摘机（接听），onhook=挂机，missed=响铃超时没人接。
 * agent/session_id 指的是这通电话对应的会话——话机自己不是会话来源，
 * 所以 AgentId 不加 'pi'（加了会在界面上多出一家"未接入"，见设计文档）。
 */
export type PhoneEventType = 'offhook' | 'onhook' | 'missed'

/** POST /phone/event 的请求体：树莓派上的 phone-bridge 上报摘挂机。 */
export interface PhoneEvent {
  type: PhoneEventType
  agent: AgentId
  session_id: string
  /** Unix 秒。缺省时服务端用接收时刻。 */
  ts?: number
}

/**
 * 一条会话行上的几个数字(2026-09-09,先只有 DSH 会话有)。
 *
 * 三个字段**各自独立、全部可选**:取不到的那个整个缺席,界面就不显示那一段——
 * 不占位、不填 0(D13)。取数来源与实测形状见
 * docs/superpowers/research/2026-09-09-DSH会话投影可读性.md。
 *
 * 可选字段:protocol.ts 是与 display-client 的三方契约,只能加可选字段;
 * 展示台本期不读它,副本不同步(同 BriefView.dismissed 的先例)。
 */
export interface SessionMetrics {
  /** 当前上下文占用的 token 数(厂商回报优先,dsh-context 的估算作后备)。 */
  context_tokens?: number
  /** 缓存命中率百分比,口径与用量面板一致:读 /(读 + 未命中输入)。 */
  cache_hit_pct?: number
  /** 这条会话改过几个文件(去重);没改过就缺席。 */
  files_changed?: number
}

/** GET /state 里的单条会话。 */
export interface SessionView {
  agent: AgentId
  session_id: string
  project: string
  cwd?: string
  status: SessionStatus
  reason?: EventReason
  /**
   * 等待原因(见 WaitReason)。来源自己判出的原样带上;那一家额度见底时由服务端叠加 `quota`
   * (叠加规则见 server/sessions.ts 的 applyQuotaOverlay)。缺省 = 判不出,界面不写「未知」。
   */
  wait_reason?: WaitReason
  title?: string
  summary?: string
  /**
   * 最近在做什么(2026-09-25,卡 P;维护者:「事务官中并没有显示会话的标题和内容」)。
   * 一句人话(不含工具名、路径、英文键名)+ 那一刻;界面写「在做的事 · 3 分钟前」。
   * 读不到就缺席(界面写「读不到它在做什么」)。可选字段:display-client 读不到当无。
   */
  activity?: SessionActivity
  /**
   * 这条会话在等他什么(2026-09-25,卡 T「在等你:不只看会话状态」;见 {@link SessionAskView})。
   * 有这一格时 `status` 一定是 `waiting`。缺席 = 没在等他(或判不出)。事务官自己的会话(dsh)不走这一格(卡 M 的外层提问管)。
   */
  ask?: SessionAskView
  /** 进入当前状态至今的秒数。waiting 时持续走，用于响铃判定与界面计时。 */
  elapsed_sec: number
  /** 上次输出距今秒数，running 状态下显示。 */
  last_output_sec?: number
  /** 仅 done 用：未读会一直留着，用户点过才收（PRD §5.3）。 */
  unread: boolean
  updated_at: string
  /** 会话行上的几个数字(目前只有 DSH 会话有)。一个都取不到时整个字段缺席。 */
  metrics?: SessionMetrics
  /**
   * **这条会话是工作台自己起的**(2026-09-25,卡 V):能力体检、派活探针、统筹自测那一类。
   * 有这一格的会话**不进舞台、不进会话列表、不计入「执行」**,要看就在设置里「工作台自检记录」。
   * 缺席 = 他自己在某家客户端里开的会话(该看见的那些)。约定见 `SELFCHECK_*`。
   */
  selfcheck?: SelfcheckView
  /**
   * `status === 'error'` 时给他看的那一句人话 + 一键入口(2026-09-25,卡 V;src/humanError.ts 翻的)。
   * 「Not logged in · Please run /login」→「Claude 命令行还没登录」+ 一颗「登录 Claude」。
   * 翻不出的归成「出错了(看原始)」,原文在 `raw` 里(点「看原始」才看)。
   */
  human_error?: HumanErrorView
  /**
   * 判成这个状态的依据,一句话(2026-09-25,卡 V)。给验收与排错看 ——
   * 「最后一条记录是报错」「他刚说完话、它还没开口,而写它的进程已经没了」。界面不必显示。
   */
  status_why?: string
  /**
   * 记录里**明写着**它停下来在等人(2026-09-25,卡 V):`approval` 等批准、`question` 在问他。
   * 这是**形式信号**,内容上「最后一轮是不是在问他」归卡 T 判 —— 这里只如实摆出文件里有没有这个信号。
   * Claude 的权限弹窗不写进会话文件(只走 hook),所以 Claude 这一格永远缺席。
   */
  formal_wait?: 'approval' | 'question'
  /**
   * 这条会话底下的后台任务(2026-09-25,卡 Q;维护者:「这种后台任务,事务官是看不到的……一张卡片里有后台任务的说明,
   * 就是多一层的意思」)。Claude 的子代理、Codex 的子任务、事务官派出去的活,同一个形状({@link SessionChildView})。
   * **只挂在主会话上**:子任务不单独成一条会话、不单独算「执行」;主卡上一行「内含 N 项后台任务 · 在跑 x · 等你 y」,展开才列每条。
   * 读法给不出来的那一家就缺席。
   */
  children?: readonly SessionChildView[]
}

/** 一句人话 + 一颗按钮 + 原文。字段与 src/humanError.ts 的 `HumanError` 同形(那边是实现,这里是契约)。 */
export interface HumanErrorView {
  line: string
  action?: 'login_claude' | 'login_codex' | 'login_kimi' | 'quota' | 'model' | 'install_client' | 'credentials'
  raw?: string
}

// ───────────────────── 工作台自己起的会话怎么认(2026-09-25,卡 V) ─────────────────────

/**
 * **工作台自己起的会话不当他的会话**(2026-09-25,卡 V;维护者 09-25 21:00 撞出来的)。
 *
 * 能力体检(卡 O 的 `server/agentCaps.ts` / `clientScan.ts`)会用 `claude -p` 探一句「What is 2+2?」
 * 看这家通不通。那两条探针的会话文件跟他自己的会话躺在同一个目录里,读法认不出来,于是:
 * 舞台上多出两张「进行中」的卡、窗口槽气泡多数两个、「执行」跟着多两件。
 * 维护者:「实际一个会话在跑,从事务官的卡片,再到气泡,都不对」。
 *
 * 约定**三样,写在这一处**(起的那一半在卡 O,读的那一半在 claudeSessionRecover / 各家 feed):
 *
 * 1. **环境变量** `WORKBENCH_SELFCHECK`:起探针的进程把它设成 `caps` / `dispatch` / `selftest`
 *    (`SelfcheckKind`)。**这是首选** —— 不依赖会话文件里有什么。
 * 2. **第一句的固定前缀** `【工作台自检】`:探针发过去的那一句话以它开头。环境变量传不进去、
 *    或者读的那一头只有会话文件时,靠它认(`isSelfcheckAsk`)。派活标签 `【工作台派活 xxxxxx】`
 *    是另一码事(那是他要的活,该看见),两者都在 sessionDigest 的 `stripLeadingTags` 里被剥掉。
 * 3. **固定 cwd** `<butler_cwd>/.工作台自检`:探针一律在这个目录里跑,别拿 `/` 当 cwd
 *    (09-25 那两条探针的 cwd 是 `/`,于是会话文件落在 `~/.claude/projects/-/`,项目名成了「未归类」)。
 *    读的那一头按 `isSelfcheckCwd` 认。
 *
 * 三样**任一命中就算**,`SelfcheckView.by` 如实记是哪一样认出来的(验收时看得见靠的是哪条证据)。
 */
export const SELFCHECK_ENV = 'WORKBENCH_SELFCHECK'

/** 探针那句话的固定前缀。改它要同时改卡 O 起探针的那一半 —— 所以只在这里写一次。 */
export const SELFCHECK_PREFIX = '【工作台自检】'

/** 探针跑在哪个目录里(相对 `butler_cwd`)。名字带点,访达里默认看不见。 */
export const SELFCHECK_DIRNAME = '.工作台自检'

/** 工作台为什么起这条会话。设置里「工作台自检记录」按它分组。 */
export type SelfcheckKind = 'caps' | 'dispatch' | 'selftest'

export const SELFCHECK_KIND_TITLES: Record<SelfcheckKind, string> = {
  caps: '能力体检',
  dispatch: '派活探针',
  selftest: '统筹自测',
}

/**
 * 靠哪条证据认出来的。`env` 最硬,`cwd` 次之,`prefix` 只看会话文件时用;`sdk` 是**过渡那一条**(见下)。
 */
export type SelfcheckBy = 'env' | 'prefix' | 'cwd' | 'sdk'

export interface SelfcheckView {
  kind?: SelfcheckKind
  by: SelfcheckBy
}

/**
 * **没有人往这条会话里打过字**(2026-09-25,卡 V 的过渡那一条)。
 *
 * 为什么要这一条:卡 O 现在的探针还没换成上面那三样约定 —— 它用 `claude -p` 在 cwd `/` 里探一句
 * 「What is 2+2?」。维护者这台上那三条就是它,不认出来的话舞台上照旧多几张卡、Claude 标签上多一颗红点
 * (「出错 2」—— 而那两条「出错」是工作台自己探出来的,不是他的事)。
 *
 * 判据**不认名字、不认那句话**(写死一句英文就是维护者说的「打补丁」),而是认记录里
 * 「**这一轮是谁发起的**」:`turnOrigin`。
 *
 * - `turnOrigin: 'sdk'` = 一个程序说的这句话;`entrypoint: 'sdk-ts'` = 整条会话是一个程序开的。
 * - 他自己的会话是 `turnOrigin: 'human'`,`entrypoint` 是 `claude-desktop` / `cli`(78 份真机文件核过)。
 *
 * **`promptSource` 不能用**(09-25 差点栽在这儿):统筹那条**真会话**里有 83 条记录是
 * `promptSource: 'sdk'` 而 `turnOrigin: 'human'` —— 那是**他的话经程序转进来**的(手机上打的、
 * 统筹替他转述的)。拿 `promptSource` 当判据的话,唯一那条真在跑的会话会被当成探针藏掉,
 * 舞台上就从「3 张假的」变成「一张都没有」—— 比原来的毛病更糟。
 *
 * 再加一道保险:**这条会话里只要有过一句「人说的话」(`turnOrigin: 'human'`),就不是探针** ——
 * 他往里打过字的会话,无论怎么开出来的,都是他的会话。
 *
 * 会不会误伤?**事务官派出去的活也走 sdk 这条路** —— 但那些会被 links 挂到事项上,舞台上摆的是
 * 那张事项卡(`unlinkedBusySessions` 本来就去重),藏掉那条散会话正是对的。别的第三方 SDK 程序
 * 开的会话同理:他没在任何客户端里打开过它、也没往里说过话,舞台上不该冒出来。
 *
 * **它比另外三条弱**,所以 `by` 单列一个值(`sdk`),设置里那一格看得出是靠哪条认的;
 * 卡 O 换成 `env` / `cwd` 之后这一条就只是兜底。
 */
export function isSdkDrivenRecord(row: { turnOrigin?: unknown, entrypoint?: unknown }): boolean {
  return row.turnOrigin === 'sdk' || row.entrypoint === 'sdk-ts'
}

/** 这一条是**人说的话**吗(`turnOrigin: 'human'`)。有一条就说明他往这条会话里打过字 —— 那是他的会话。 */
export function isHumanTurnRecord(row: { turnOrigin?: unknown }): boolean {
  return row.turnOrigin === 'human'
}

/** 这一句是探针发的吗(认前缀,前后空白不计)。 */
export function isSelfcheckAsk(text: string | undefined): boolean {
  return text !== undefined && text.trimStart().startsWith(SELFCHECK_PREFIX)
}

/** 这个 cwd 是探针目录吗(它本身或它下面)。 */
export function isSelfcheckCwd(cwd: string | undefined): boolean {
  if (cwd === undefined || cwd === '') return false
  return cwd.split(/[\\/]/).filter(Boolean).includes(SELFCHECK_DIRNAME)
}

/** 环境变量的值 → `SelfcheckKind`;认不出的值仍算自检(设了这个变量就是自检),只是分不了组。 */
export function selfcheckKindOf(value: string | undefined): SelfcheckKind | undefined {
  return value === 'caps' || value === 'dispatch' || value === 'selftest' ? value : undefined
}

/** 「能力体检 · 起的时候打了标记」这一句(设置里那一列)。 */
export function selfcheckText(view: SelfcheckView): string {
  const what = view.kind === undefined ? '工作台自检' : SELFCHECK_KIND_TITLES[view.kind]
  const by = view.by === 'env'
    ? '起的时候打了标记'
    : view.by === 'prefix'
      ? '第一句带自检前缀'
      : view.by === 'cwd' ? '跑在自检目录里' : '没有人往这条会话里打过字'
  return `${what} · ${by}`
}

/** 一项后台任务的状态:在跑 / 等你 / 办完了 / 出错了。 */
export type SessionChildStatus = 'running' | 'waiting' | 'done' | 'error'

/**
 * 主会话底下的一项后台任务(卡 Q)。卡 N(进度靠证据)与卡 T(在等你)读的是同一份。
 * **给他看的只有 `title`、状态、`activity`、时间** —— `id`、`model` 这类只给程序用,界面上不露。
 */
export interface SessionChildView {
  /** 那一家自己给它的 id(Claude 子代理的 agentId、事项 id……)。界面上不显示。 */
  id: string
  /** 谁派的:父会话的 session_id。 */
  parent_session_id: string
  /** 一句描述:派它时的标题 / 任务说明(Claude 子代理的 description)。 */
  title: string
  status: SessionChildStatus
  /** 在做什么(最近一句,人话)+ 那一刻。读不到就缺席。 */
  activity?: SessionActivity
  started_at?: string
  /** 办完 / 出错的那一刻;还在跑就缺席。 */
  ended_at?: string
  /** 型号(那一家原样的名字)。界面不露。 */
  model?: string
}

/**
 * 一条会话里的一个回合(2026-09-15,给手机端 GET /butler/item/:id/turns)。
 * 正文已去掉工具调用与围栏代码块,单条截 2000 字(尾部「…」);`at` 是工作台收到它的时刻(ISO)。
 * 目前只有 DSH 会话有(来源 server/dshSessionFeed.ts)。
 */
export interface SessionTurn {
  role: 'user' | 'assistant'
  text: string
  at: string
}

export interface AgentView {
  id: AgentId
  /** 该来源是否接入并存活。未接入的来源也要出现，界面据此标明"未接入"。 */
  online: boolean
  /** 是否从未接入过（Codex/Kimi 第一版可能如此），界面显式标明而不是留白。 */
  connected: boolean
  waiting: number
  running: number
}

/**
 * 一份额度**截至什么时候**(2026-10-02,卡 QA)。额度型的每一格都有这两个可选字段。
 *
 * 维护者 21:3x:「本机上的 Claude 额度,一晚上了,还是 100%」。那会儿 `/state.quota.claude` 是
 * `{windows:[{5h,left_pct:100},{周,left_pct:82}]}` —— 数没错,它是 Claude 桌面端 **04:27** 那个样本
 * (`{fh:0, sd:18}`)算出来的;可那会儿是 21:3x。17 小时前的数被当成此刻显示,既没有时刻、
 * 也没有一个字说它旧 —— 而她整晚都在用 Claude。
 *
 * 所以每一家的额度都带上:
 * - `as_of`:这个数**截至**什么时候(ISO)。**取数那一刻不一定等于这一刻**:桌面端那条路读的是
 *   十几分钟前落的样本,所以这里要的是**样本自己的时刻**,而不是我们读文件的时刻(claudeDesktop.ts)。
 * - `source`:哪来的(「Claude 桌面端自己记的用量」「Claude Code 状态栏报上来的」)。
 *
 * 过了 `QUOTA_AS_OF_STALE_AFTER_MS` 这条线,消费方**不许再出百分比**,只说「读不到最新的,上次 04:27」
 * (`quotaAsOfWords`)—— 陈旧的数不能冒充当下。**缺席 = 老宿主 / 这条来源没给**:那时照这一版之前那样显示,
 * 只是不写「截至」—— 不替它编一个时刻(D13)。本机每一条活着的来源都会填它(quota/collect.ts 一处补)。
 */
export interface QuotaAsOf {
  as_of?: string
  source?: string
  /**
   * 过线那一格**该说什么**(2026-10-02,卡 QK)。缺席 = 这一家一个字都不多说,只剩「上次 HH:MM」。
   * 由**各家额度来源自己声明**(`quota/liveSources.ts` 一处),界面不写死家名。
   */
  stale_hint?: QuotaStaleHint
}

/**
 * **「读不到最新」那一格说清为什么、给一个入口**(2026-10-02,卡 QK)。
 *
 * 卡 QA 把过线那一档从「照说那个数」改成「读不到最新的,上次 04:27」——不再骗人了,
 * 可她看到的仍然只有这一句:**为什么读不到、她能做什么,界面上一个字都没有**。
 * 查实的那一幕(`docs/交接-1002-额度陈旧要标出来.md`)是:Claude 唯一能随她的使用实时更新的那条路
 * (自发 1 token 请求读响应头)要一把她没配的凭据,而桌面端那份用量文件早就停更了。
 *
 * 所以这一格有两半,**各家额度来源自己声明,一家一处**:
 * - `why`:为什么读不到最新(「Claude 桌面没在跑」)。**查实过才写** —— 不替哪一家编一个原因(D13)。
 * - `live`:这一家还有一条**更实时的**来源,但缺一样东西 —— 那一句人话 + 一个入口。
 *   **没有更实时来源的家整格缺席**,过线就只说「上次 HH:MM」,不凭空长出一颗按钮。
 *
 * 三端(电脑额度格 / 手机 / 展示台横屏额度条)念的是同一份(`quotaStaleNote` 一处拼),
 * 入口那颗键只有电脑上画得出(`desk_only`:手机与展示台上只说那一句)。
 */
export interface QuotaStaleHint {
  why?: string
  live?: QuotaLiveHint
}

/** 这一家有一条更实时的来源,但缺一样东西。 */
export interface QuotaLiveHint {
  /** 一句人话:配上什么就能实时(2026-10-03 起是「点一下「接上」就实时」)。**不说密钥长什么样**。 */
  why: string
  /** 点一下去哪。缺席 = 只说那句话,不画入口(那一步还没有现成的去处时就该如此)。 */
  fix?: QuotaStaleFix
}

/**
 * 过线那一格上那颗键。**这张卡不在这里做配置流程** —— 它只把她送到已经有的设置页那一行。
 * `at` 是「设置里哪一节、哪一行」,界面照它定位(不按家名写 if)。
 */
export interface QuotaStaleFix {
  label: string
  at: { group: string, row: string }
  /** 只能在这台电脑前做(手机与展示台上只说一句,不画按钮)。同 `AgentQuotaFixView.desk_only`。 */
  desk_only?: true
}

/** 余额型额度（DeepSeek）：绝对值，无分母，不画进度条（PRD §8.2）。 */
export interface BalanceQuota extends QuotaAsOf {
  kind: 'balance'
  currency: string
  total: string
  today_spent?: string
  available: boolean
}

/** 窗口型额度（Claude/Codex/Kimi）：统一按剩余显示，条越短越危险。 */
export interface QuotaWindow {
  label: string
  left_pct: number
  reset_at?: string
  /**
   * 这一条归**哪一组**(2026-09-27,卡 AG)。页面上就分了组的那几家才有:
   * Antigravity 的「Models & Usage」把四条限额分在「Gemini Models」与「Claude and GPT models」
   * 两组下面,组名是从它页面上**读回来的原话**。缺席 = 这一家没分组(老四家、豆包办公都不给这一格,
   * 界面照旧一条一行地画)。
   */
  group?: string
}

export interface WindowQuota extends QuotaAsOf {
  kind: 'quota'
  windows: readonly QuotaWindow[]
  /**
   * 取到数了，但有话要说——目前只用于"某个窗口这次没返回"。
   *
   * 展示台不渲染它，它是给 /state 看的：一栏静默消失和"接口改了"在界面上长得
   * 一模一样，真机上就为此误判过。把当时响应里**实际有哪些顶层字段**记下来，
   * 下次一眼能分清是窗口归零了还是上游变了。只记字段名，不记值。
   */
  note?: string
  /**
   * 要让 Ben 看见的一句话——**与上面的 note 是两回事**(2026-08-26 新增)。
   *
   * 起因:note 按上面的注释是"给 /state 看的"调试字段,界面那层
   * (client/quotaCells.ts 的 cellFor)对 kind==='quota' 的格子会用重置时间
   * **整个覆盖**掉它。于是服务端那条"403 要重新登录、不许闷声少一栏"的纪律
   * 写了很久,却从来没有一个字到过界面上——Fable 那栏消失了整天,屏幕上没有
   * 任何痕迹可查,正是因为诊断话术全落在这个不渲染的字段里。
   *
   * 所以另开一个**明确要渲染**的字段:只放"少了什么、为什么、要不要动手"这类
   * 人话,不放字段名清单那种调试内容。缺省即没有话要说,界面不占位。
   * 加字段而不是改 note 的语义:展示台有自己一份协议副本、不认识这个字段,
   * 加法对它是无害的,改语义则会波及它。
   */
  alert?: string
}

/** 尚未实测通该来源的取数方式时用它，界面显式标明而不是显示 0。 */
export interface UnknownQuota {
  kind: 'unknown'
  note?: string
  /**
   * 这一格**不许**退回上一次采样(2026-09-18,Ben 真机「清空凭据后还显示 ¥2.26」)。
   *
   * 采集循环对"这一轮没取到"留了几轮宽限(quota/collector.ts 的 GRACE_ROUNDS),防的是
   * 一次网络抖动把好数字打成"未接入"。但有两种 unknown **不是抖动**,是确定的结论:
   *
   * - **凭据没配 / 刚被清空** —— 上一轮那个数字是用一把已经不在的 Key 取的;
   * - **换了来源**(切到工作台中转)—— 上一轮那个数字说的是另一个账户的钱。
   *
   * 两者留着旧数都等于在界面上写一句假话(D13),所以打上这面旗子,宽限对它不适用。
   * 加字段而不是改 note 的语义:展示台有自己一份协议副本、不认识这个字段,加法对它无害。
   */
  no_stale?: boolean
}

export type QuotaEntry = BalanceQuota | WindowQuota | UnknownQuota

/**
 * **一份额度过了多久就不许再冒充当下**(2026-10-02,卡 QA)。**一处常量**:
 * 服务端那一处判(`server/agentQuota.ts` 的 `dated`)、电脑额度格、展示台、手机、电话念的那一句,
 * 读的都是这一个数。
 *
 * 2 小时怎么来的:比各家来源的采样间隔都宽(Claude 桌面端空闲时实测见过 45 分钟一个样本,
 * 从窗口上读的那几家是十分钟看一眼),一闲下来不会无缘无故变脸;又短得足以挡住现场那一幕 ——
 * 17 小时前的 100% 挂了一整晚。
 *
 * ★ 这条线**取代**了 2026-09-26(卡 QS)那条 6 小时的「标灰但照说那个数」:标灰不够,
 * 她看见的还是一个百分比,还是把它当成此刻的用量。过线之后**连百分比都不出**。
 */
export const QUOTA_AS_OF_STALE_AFTER_MS = 2 * 60 * 60 * 1000

/** 过线之后那一格写的字(大字那一格、派活确认点括号里都是这一句)。 */
export const QUOTA_STALE_VALUE = '读不到最新的'

/**
 * ★ **Claude 桌面端不再落新样本时说的那句实话**(2026-10-03;维护者 10-03 午后:
 * 「Claude 额度格如实显示『Claude 桌面端没再提供』不再追」)。
 *
 * 这一格上一版写的是笼统的「未接入」——「未接入」的意思是"工作台还没接上这一家",
 * 而真相完全不是:钩子接着、文件也在,只是 `~/Library/Application Support/Claude/
 * plan-usage-history.json` 里**最后一个样本已经是几小时前的了**(桌面端这段时间没在跑)。
 * 两件事差得远:一个要她去接,一个她什么都不用做。
 *
 * **为什么放在 protocol.ts**:取数层(`quota/claudeDesktop.ts` 抛的那句)与界面层
 * (`client/quotaCells.ts` 据它认出这一种)读的必须是同一份字 —— 两边各写一份,
 * 改一处就认不出来了,而认不出来的后果正是又变回「未接入」。
 * **也不加新数据源、不碰凭据**:这张卡只换这一格说的话。
 */
export const CLAUDE_DESKTOP_GONE = 'Claude 桌面端没再提供用量记录'

/**
 * 那句话加上岁数。**以小时计**:这条线本来就是 2 小时(`QUOTA_AS_OF_STALE_AFTER_MS`),
 * 写成「918 分钟前」要她自己心算。不满一小时按 1 小时写(走到这儿不会发生,留着兜底)。
 */
export function claudeDesktopGoneNote(ageMs: number): string {
  const hours = Math.max(1, Math.round(ageMs / 3_600_000))
  return `${CLAUDE_DESKTOP_GONE}(最后一次 ${hours} 小时前)`
}

/** 认不认得出这是「桌面端没再提供用量记录」那一种(界面层据它换掉「未接入」)。 */
export function isClaudeDesktopGone(note: string | undefined): boolean {
  return note !== undefined && note.startsWith(CLAUDE_DESKTOP_GONE)
}

/**
 * 截至时刻写成人话:今天只写几点(「今天」是废话);昨天写「昨天 09:15」,昨天傍晚以后写「昨晚 20:42」
 * (维护者原话就是这么说的);更早写「09-26 22:10」(同额度格里重置时刻那一套写法)。
 *
 * 认不出的时刻回 `undefined` —— 界面上宁可不写,也不糊一个 ISO 串或编一个时刻(D13)。
 * `server/agentQuota.ts` 的 `readWhen` 就是这一个函数(那边只是个别名,两套写法会迟早长不一样)。
 */
export function quotaAsOfClock(iso: string, now: Date): string | undefined {
  const at = new Date(iso)
  if (Number.isNaN(at.getTime())) return undefined
  const pad = (n: number): string => String(n).padStart(2, '0')
  const dayOf = (d: Date): number => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
  const days = Math.round((dayOf(now) - dayOf(at)) / 86_400_000)
  const hhmm = `${pad(at.getHours())}:${pad(at.getMinutes())}`
  if (days <= 0) return hhmm
  if (days === 1) return `${at.getHours() >= 18 ? '昨晚' : '昨天'} ${hhmm}`
  return `${pad(at.getMonth() + 1)}-${pad(at.getDate())} ${hhmm}`
}

/**
 * 这份额度过线了吗。**缺席 / 认不出 / 时钟倒着走都不算过线**:
 * 缺席就是缺席(老宿主、这条来源没给),不替它判一个旧 —— 判错会让一格好数据凭空消失。
 */
export function quotaAsOfStale(asOf: string | undefined, now: Date): boolean {
  if (asOf === undefined) return false
  const at = new Date(asOf).getTime()
  if (!Number.isFinite(at)) return false
  const age = now.getTime() - at
  return Number.isFinite(age) && age > QUOTA_AS_OF_STALE_AFTER_MS
}

/**
 * 「截至什么时候」那一句:线以内「截至 04:27」,过线「读不到最新的,上次 04:27」。
 * 时刻缺席 / 认不出 → `undefined`,那一行不占位。
 */
export function quotaAsOfWords(asOf: string | undefined, now: Date): string | undefined {
  if (asOf === undefined) return undefined
  const clock = quotaAsOfClock(asOf, now)
  if (clock === undefined) return undefined
  // 「上次 04:27」:数字开头的留一个空格,「昨晚 20:42」这种中文开头的不留(同 leadName 那条规矩)。
  if (quotaAsOfStale(asOf, now)) return `${QUOTA_STALE_VALUE},上次${/^\d/.test(clock) ? ' ' : ''}${clock}`
  return `截至 ${clock}`
}

/** 过线那一格小字的第一段:「上次 04:27」(数字开头留一个空格,中文开头不留 —— 同 `quotaAsOfWords`)。 */
export function quotaLastSeenWords(clock: string): string {
  return `上次${/^\d/.test(clock) ? ' ' : ''}${clock}`
}

/**
 * **过线那一格小字里的整句**(2026-10-02,卡 QK)—— 大字是 `QUOTA_STALE_VALUE`,这是它底下那一行。
 *
 * 三段,有就说、没有就不占位(D13:不替哪一家编一个原因):
 *
 *   上次 04:27 · Claude 桌面没在跑 · 点一下「接上」就实时
 *   └ 这个数多大年纪    └ 为什么读不到最新    └ 有更实时的一条,缺什么
 *
 * **一处拼,三端共用**:电脑额度格(`client/quotaCells.ts`)、展示台额度区与横屏额度条
 * (那两份协议副本里有同一个函数,`quotaAsOf` 系列的对照测试读源头文件比对)、
 * 手机(服务端 `agentQuota.ts` 把同样三段拼进 `line`,手机照念)。
 *
 * 时刻认不出 → 只剩后两段;三段都没有 → 空串,调用方自己决定空串要不要占位。
 */
export function quotaStaleNote(asOf: string | undefined, now: Date, hint?: QuotaStaleHint): string {
  const clock = asOf === undefined ? undefined : quotaAsOfClock(asOf, now)
  return [
    ...(clock === undefined ? [] : [quotaLastSeenWords(clock)]),
    ...(hint?.why === undefined ? [] : [hint.why]),
    ...(hint?.live === undefined ? [] : [hint.live.why]),
  ].join(' · ')
}

/** GET /state 的响应：当前完整快照。 */
/** 一条正在响的铃(2026-08-25 新增，配合 WorkbenchState.ringing)。 */
export interface ActiveRing {
  agent: AgentId
  session_id: string
}

/**
 * 今晨快报的一条(W4)。形状照 AiDJ 电台 `GET /api/dj/commute/today` 的 topics 原样收下,
 * 不在这里重命名字段——上游改了形状要能一眼看出来,而不是被一层映射盖住。
 */
export interface BriefTopic {
  id: string
  section: string
  title: string
  summary: string
  url: string
  source: string
  tier: string
}

/**
 * 日结报告(PRD 5.7;2026-09-02 Ben 拍板:每天早 9 点生成**昨天**的,与晨间回顾合流)。
 * v1 是数据驱动的如实汇总,不做 AI 撰写:四段全部来自可验证素材(git 提交/用量按天/
 * 随手记时间戳),缺素材的段落写明"暂空"或"未上线",不编造(D13)。
 * 「什么没发生」是 PRD 点名的必填段——全都动了也要用一句如实说明顶上,不许空。
 */
/**
 * DeepSeek 峰谷时段(2026-09-09,借 dsh-save-money 的时间窗语义)。
 *
 * 服务端算好峰谷再下发,客户端只渲染(架构约束 C2)。**只是意识**:显示与分账,
 * 不自动暂停任何任务——那是 save-money 的主功能,我们的纪律是不替 Ben 做决定。
 */
export interface DeepSeekPeakView {
  phase: 'peak' | 'offpeak'
  next_phase: 'peak' | 'offpeak'
  /** 下一次切换的墙钟时刻 HH:MM。 */
  next_switch: string
  /** 当前生效的时间表,给设置弹窗回填输入框用(额度格只用上面三个字段)。 */
  periods: readonly { start: string, end: string }[]
}

/**
 * 事务官本机后端(butler-server,2026-09-11)的运行状态。设置弹窗那一节靠它。
 * 数字取不到就缺席、不填 0(D13);token 永远不在这里。
 * 可选字段:display-client 副本本期不同步,它不读这个字段。
 */
/**
 * 引导落地(2026-09-24 晚,卡 feat/onboarding-materialize;设计 docs/设计-引导落地-引导结束后的样子-2026-09-24.md 第三节)。
 * 服务端排的计划见 server/materialize.ts;这里只是给界面画的那一份(每一行真做时要的数据留在服务端)。
 */
/** 负责人:三家 Agent、事务官、他自己、同事、别人。 */
export type MaterializeOwner = 'codex' | 'claude' | 'kimi' | 'butler' | 'me' | 'colleague' | 'other'
export const MATERIALIZE_OWNER_LABELS: Record<MaterializeOwner, string> = {
  codex: 'Codex', claude: 'Claude', kimi: 'Kimi', butler: '事务官', me: '你', colleague: '同事', other: '别人',
}
/** `rules`(2026-09-25,卡 O):引导里他说的分工 → 规矩表里「派活默认分工」那一条。 */
export type MaterializeGroup = 'projects' | 'sprint' | 'daily' | 'desk' | 'rules' | 'memory' | 'cleanup' | 'first'
export type MaterializeRowKind =
  | 'project' | 'sprint' | 'task' | 'routine' | 'quiet' | 'feed' | 'slot' | 'quota' | 'caps' | 'division' | 'memories' | 'cancel' | 'dispatch'

export interface MaterializeRowView {
  /** 稳定键:同一份存档重跑得到同一个键。勾掉 / 改一下都按它。 */
  key: string
  kind: MaterializeRowKind
  group: MaterializeGroup
  title: string
  /** 小字:负责人、截止、「等你确认」、为什么撤。 */
  detail?: string
  /** 出自他哪句原话。 */
  quote?: string
  /** 默认勾不勾。 */
  checked: boolean
  /** 已经有了 / 落过了:灰掉、不再做。 */
  done?: boolean
  /** 这一行做不了的原因(不勾、不能勾)。 */
  placeholder?: string
  owner?: MaterializeOwner
  /** 「改一下」能改标题与负责人(卡片那几行)。 */
  editable?: boolean
  /**
   * 免打扰那一行的起止(2026-09-25 统筹:到几点也要能在「改一下」里改)。「改一下」时给一个「到几点」的下拉,
   * 交上来是 `edits[key].to`。
   */
  time?: { from: string, to: string }
}

export interface MaterializeResultView {
  ok: boolean
  /** 落完那一句(「派出去了,做完叫你。」)。 */
  line: string
  rows: readonly { key: string, title: string, ok: boolean, note?: string }[]
  dispatch?: { task_id: string, ok: boolean, session_id?: string, note?: string }
  /** 电话里他说「那件不用」、却没认出是哪一行的。 */
  unmatched?: readonly string[]
}

export interface MaterializeStateView {
  id: string
  status: 'pending' | 'applying' | 'applied'
  /** 电话里那一句(「都摆好了,两个项目、十件事……行吗?」)。 */
  line: string
  /** 卡片是规则表认的,还是模型那一份合进来过。 */
  source: 'rules' | 'model+rules'
  counts: { projects: number, tasks: number, cancel: number }
  groups: readonly { id: MaterializeGroup, title: string }[]
  rows: readonly MaterializeRowView[]
  created_at: string
  applied_at?: string
  result?: MaterializeResultView
}

/** /state.onboarding。阶段 id 见 workbench-plugin/src/server/onboardingStages.ts 的 OnboardingStage。 */
export interface OnboardingStateView {
  // 2026-09-21:多一个 'template'(①′ 布局)。2026-09-23 起排在 ② 分岔之后(见 server/onboardingStages.ts FULL_PLAN)。
  stage: 'opening' | 'template' | 'branch' | 'projects' | 'authorization' | 'habits' | 'persona' | 'naming' | 'wrapup' | 'done'
  done: boolean
  askedAt?: string
  /**
   * 谁在主导引导(2026-09-18,Ben:「如果手机已经扫码,优先手机的引导流程」)。
   * **只决定界面归属,不是权限** —— 两端共用同一份 onboarding.json,谁都写得进去。
   * 还没人主导过就缺席:那时候电脑端按「配没配过手机」自己判(client/firstrun/onboardingLead.ts)。
   */
  leader?: 'phone' | 'desktop'
  /** 主导方最后一次真的有动静。电脑那一屏据此在十分钟后问一句「手机那边没动静,改在电脑上做?」。 */
  leader_at?: string
  /** 这一阶段的名字(「① 开场」)。电脑那一屏照它显示,不在浏览器里维护第二份对照表。 */
  label?: string
  /** 第几步 / 共几步(按当前计划算 —— 补问新项目那一支的计划只有两步)。 */
  step?: number
  steps?: number
  /**
   * 引导**走完的那一刻**(2026-09-25)。只在 `done` 时有。电脑首页据此在「刚走完引导」那一次
   * 自己切回事务官档(大球那一页)—— 同一次走完只切一次,之后他点哪个标签就是哪个。
   * 老存档没记这一刻,退回 onboarding.json 的 `updatedAt`。
   */
  done_at?: string
}

/**
 * 它此刻处在哪一档(卡 OC2)。
 * `missing` 还没装也还没开始装 / `installing` 正在装 / `ready` 装好了 / `failed` 这次没装上。
 */
export type ConnectorPhase = 'missing' | 'installing' | 'ready' | 'failed'

/** 连接器(open-connector)的状态。取不到的一律**缺席**,不填 0。 */
export interface ConnectorView {
  phase: ConnectorPhase
  installed: boolean
  /** 进程在不在跑(问过 `/healthz`)。没装时一定是 false。 */
  running: boolean
  port: number
  /** 钉死的那一版,装没装都答得出。 */
  version: string
  /** 这台机器上它认得多少家平台。数不到就缺席。 */
  apps?: number
  /** 她已经授权、打开了的那几家。没装时缺席。 */
  connected?: number
  /** 占多少字节。没装时缺席;装着但数不到也缺席。 */
  bytes?: number
  /** 第一次装要下多大 —— 界面上「第一次要下载约 230MB」那句用它。 */
  downloadBytes: number
  /** 一句人话:正在装什么、为什么没装上。没有话说就缺席。 */
  note?: string
  /** 三家 Agent 各自接上了没有。 */
  hosts: readonly { id: 'dsh' | 'claude-code' | 'codex', label: string, connected: boolean }[]
}

export interface ButlerView {
  running: boolean
  port: number
  avatarCount?: number
  voiceCount?: number
  /**
   * chat 场景此刻解析出来的音色 id(2026-09-22)。**解析不出来就缺席**。
   * 通道层工人盯着它,变了就往房里广播 `filler_voice_changed`;
   * 手机据此按音色重取缓冲语那七句(butler-app/src/call/fillerVoiceCache.ts)。
   */
  voice?: string
}

/**
 * 手机配对与设备令牌(2026-09-11,设计-事务官完整材料 §2:配对先于账号)。
 *
 * 三块视图都只是「设置里那一节」要显示的东西:
 * - PairingView 只对**本机来源**的 GET /state 返回(配对码就是钥匙,不进广播、不进 /live);
 * - qr 的内容是 `workbench://pair?host=<局域网 IP>&port=8791&code=<码>`,取不到局域网 IP 就缺省——
 *   界面只显示数字码,不编一个地址出来;
 * - DeviceView 里没有令牌也没有哈希,devices.json 里的 tokenHash 不进任何出口。
 */
export interface PairingView {
  code: string
  expires_at: string
  qr?: string
}
export interface DeviceView {
  id: string
  name: string
  platform: string
  /**
   * 这台是什么(2026-09-21)。`handset` = 树莓派上那只实体话筒,别的都是 `phone`。
   * 由 `platform` 推出来(server/devices.ts 的 deviceKindOf),不是另存的一份。
   * 老工作台的回包里没有这一项 —— 前端按缺省当 `phone` 处理,不当成坏数据。
   */
  kind?: 'phone' | 'handset'
  created_at: string
  last_seen_at: string
}
export interface LanView {
  /** 「允许手机在局域网访问」开关(app.json 的 lan_access)。开着才同时监听 0.0.0.0 并广播 mDNS。 */
  enabled: boolean
  /** 本机当前的局域网 IPv4;取不到就缺省(那就没有二维码)。 */
  host?: string
  port: number
  /** mDNS 现在有没有在广播。开关开着但广播起不来(端口被占之类)时如实为 false。 */
  advertising: boolean
}

export interface DailyReport {
  /** 报告对象日(昨天),YYYY-MM-DD 本地日。 */
  date: string
  generated_at: string
  /** 昨天推进了什么:有提交或有用量的项目,一行一个。 */
  progress: readonly string[]
  /** 昨天什么没发生/被绕开(必填):零提交零用量的在册项目线;全动了则是一句说明。 */
  missing: readonly string[]
  /** 昨天冒出的新点子:created_at 落在昨天的随手记原文。 */
  ideas: readonly string[]
  /** 昨天采纳/拒绝了哪些提议:提议系统(M5)未上线前固定为如实说明。 */
  proposals: readonly string[]
  /**
   * 昨天 DeepSeek 的消耗按峰谷分的两笔(2026-09-09)。
   *
   * 素材是余额采样差分(quota/dailySpend.ts)按时段记的账,落盘在 spend.json。
   * **拿不到就整个字段缺席**——那天没采到、或工作台没在跑,就不该有这一节,
   * 更不许写 0(0 会被读成"这天真没花钱")。两笔之和可能小于总数:那是
   * "有一部分差值分不了时段"的如实结果,不是算错。
   */
  deepseek_spend?: {
    total?: string
    peak?: string
    offpeak?: string
  }
}

/**
 * 快报投影(W4)。`push` 是**服务端**按触发规则算好的"该不该现在推"——客户端不自己算:
 * 这台机器上同时有多个页面客户端(壳内 WKWebView、浏览器开的 3080 标签,0.1.58 矩形
 * 投毒案已实锤),各算各的就会变成每个客户端各推一次。
 * `error` 只在取数失败时出现,且**只在用户主动展开时**摆给他看——没取到不推、不显示空壳。
 */
export interface BriefView {
  date: string
  topics: readonly BriefTopic[]
  /**
   * 触发规则算出来的"该不该现在推"。
   *
   * **现状(2026-08-26 整分支终审记录):今天全仓库没有任何消费者。** 浮窗是"展开就
   * 看得见快报",没有"被推一下"这个动作可推,所以这个值目前只是被算出来、投影出来,
   * 谁也没读。**保留**是有意的:触发规则那台机器(brief.ts 的 shouldPushBrief +
   * pushed_at 落盘)是 Ben 定的规则的落地,将来接上真正的"推"(响铃/通知/自动展开)
   * 时要用。**别拿它当渲染开关**——它是一次性的:当天第一次算出 true 的同时就写了
   * pushed_at,下一拍立刻变 false,拿它控制显隐会让快报在一秒后自己消失。
   */
  push: boolean
  error?: string
  /**
   * 终审 C3:今天这份被划走了(POST /brief/dismiss 记在服务端,跨客户端唯一)。
   * 客户端据此整块不渲染——在此之前它只活在 brief.json 里,点了 ✕ 界面纹丝不动。
   * 可选字段:protocol.ts 是与 display-client 的三方契约,只能加可选字段;服务端
   * 只在真被划走时带上,缺省即"没划走"(同 note/error 的"缺省即无"纪律)。
   */
  dismissed?: boolean
}

/**
 * 热更新那两格的形状(2026-09-18)。真正的定义在 server/update/types.ts —— 那个文件是
 * 纯类型,浏览器侧也直接 import 它;这里只 re-export,免得 /state 的契约里出现两份定义。
 */
import type { UpdateApkStateView, UpdateCloudApk, UpdateStateView } from './server/update/types.ts'
import type { ExecutionRecord } from './server/taskExecution.ts'

export type { UpdateApkStateView, UpdateCloudApk, UpdateStateView }

/**
 * 当前布局模板那一块(2026-09-21 布局模板)。界面只要这几样:模块标题、「项目 / 账号」
 * 那个词、素材那几个**绝对**路径(客户端拼不出 butler_cwd)、看板列、有没有备份可回退。
 *
 * 模板的完整定义(两份排布、引导问法)**不进 /state**:界面不需要它,而 /state 是每秒
 * 轮询一次的东西,往里塞一份每拍都一模一样的静态数据是纯浪费。设置里那两张卡片要的
 * 名字与一句话走 `GET /template`(那条是点开设置才拉一次的)。
 */
export interface TemplateStateView {
  id: string
  name: string
  /** 「项目」在这个模板里叫什么(做产品 = 项目 / 运营 = 账号)。 */
  project_word: string
  /** 项目区空着时说哪句话。 */
  project_empty_line: string
  /** 模块标题。**已经把模板的覆盖与默认合并好了**,客户端直接取,不再自己兜底。 */
  module_titles: Readonly<Record<string, string>>
  /** 看板列(事项按哪几个环节分列)。空数组 = 这个模板不换列。 */
  board_lanes: readonly string[]
  /**
   * 素材那几个文件夹的**绝对路径**(键是文件夹名,值是全路径)。
   * 工作目录没配(butler_cwd 缺席)时**整块缺席** —— 不拿一个猜出来的路径顶替(D13)。
   */
  asset_dirs?: Readonly<Record<string, string>>
  /**
   * 素材那一行里的**文件**(2026-09-21 第八格「收藏网址」),键是显示名、值是绝对路径。
   *
   * 与 `asset_dirs` 分开的理由只有一条:**它们的点法不一样**——文件夹那几颗是"把 Finder
   * 领到那个目录去",文件这一颗是"在 Finder 里选中这个文件"。混在一份 Record 里的话,
   * 客户端只能靠 `.md` 后缀去猜哪个是文件,而"靠后缀猜"迟早会猜错(素材文件夹里真可能
   * 出现一个叫 `脚本.md` 的东西)。工作目录没配时同样**整块缺席**。
   */
  asset_files?: Readonly<Record<string, string>>
  /** 模板登记的网页应用;保留数据兼容旧客户端,当前窗口槽不显示网页入口。 */
  web_apps?: readonly { key: string, label: string, url: string }[]
  /** 有没有存过可回退的布局备份。false 时设置里那颗「回退上次」是灰的。 */
  has_backup: boolean
}

/**
 * 用户层(2026-10-21,卡「分层第一刀」;`server/userLayer.ts` / `client/userLayer.ts`)。
 *
 * 本体开出来、用户层小组件能替的那几格。`usage-panel` 只替「消耗数据」格子**里面**那块面板,
 * 别的都是整格。只增不改(加载口契约第 1 版)。
 */
/**
 * 加载口契约的版本(服务端读清单、客户端给小组件的接口,两边同一个数)。**只增不改**:
 * 往清单或接口里加东西不升号;哪天要改一个已有字段的意思或拿掉一样东西才升,而且旧版照旧认。
 *
 * 2026-10-23(卡「系统文件夹改成Graphify图谱」):`files` 那一格换成图谱格,Workbench 不再传
 * view/pin/helper/inbox 那几个旧 props —— **契约不升号**:SLOT_PROPS 与 HOST_API 一个名字没动
 * (本体 builtin.FilesModule 对旧 props 仍收,旧小组件传了不会炸;验收明确要求用户层起步层不动)。
 */
export const USER_LAYER_CONTRACT = 1

export type WidgetSlotId = 'notes' | 'files' | 'todo' | 'publish' | 'review' | 'usage-panel'

/** `用户层/小组件/<id>/widget.json` 读出来的一条。broken 的那份带一句她看得懂的话。 */
export interface UserLayerWidgetView {
  id: string
  name: string
  status: 'ok' | 'broken'
  problem?: string
  replaces?: WidgetSlotId
  /** 入口文件里导出的那个名字(`default` = module.exports 本身)。 */
  export?: string
  contract?: number
  /** 只在这几个模板下替(缺席 = 都替)。值是 `/state.template.id`。 */
  templates?: readonly string[]
  author?: string
  version?: string
  /** 入口文件内容的指纹(12 位十六进制)。变了客户端就重装。只有 ok 的才有。 */
  rev?: string
  /**
   * 组件专属兼容样式(.css)的指纹(12 位十六进制)。可选;有 style.css 的组件才有。
   * (2026-10-23,分层二刀二:升级路径兼容,客户端把它注在组件自带 <style> 之前)。
   */
  style_rev?: string
  /**
   * 新改的那一版坏了,这里端的是**上一版画好过的**(`rev` 是上一版的指纹),值是新那一版坏在哪。
   * 她改的文件原样留着,改好了(指纹再变)自动换回去。
   */
  rolled_back?: string
  /**
   * 这一格存下的可用版本(新→旧,最多 3 份;2026-10-23,卡「分层自愈完善」)。
   * 只有设置里 `GET /user-layer` 才带(「选回这一版」用);`/state` 一秒一拍不背这份。
   */
  history?: readonly { rev: string, style_rev?: string, at: string }[]
}

/**
 * `用户层/布局/<id>.json` 读出来的一条(2026-10-23,分层二刀二)。
 * broken 的那份带一句她看得懂的话(设置 →「这台电脑」→「用户层」原样上屏)。
 */
export interface UserLayerLayoutView {
  id: string
  name: string
  status: 'ok' | 'broken'
  problem?: string
  /** 模板 JSON 的指纹(12 位十六进制)。只有 ok 的才有。 */
  rev?: string
  /** 皮肤文件(.css)的指纹;这份模板没带皮肤就缺席。 */
  skin_rev?: string
}

export interface UserLayerStateView {
  contract: number
  widgets: readonly UserLayerWidgetView[]
  /** 布局模板清单(2026-10-23,分层二刀二)。老载荷可以没有这一块;服务端总是填。 */
  layouts?: readonly UserLayerLayoutView[]
}

/** 插件清单的一行(四族;代码还没搬时 `where` 是 built-in)。 */
export interface UserLayerPluginView {
  id: string
  name: string
  where: 'built-in' | 'user-layer'
  /** 搬出去的顺序(1 最先)。 */
  order: number
  note: string
}

/** `GET /user-layer`:设置里「用户层」那一节读它。 */
export interface UserLayerPayload extends UserLayerStateView {
  dir: string
  folders: readonly { name: string, live: boolean, what: string }[]
  slots: readonly { id: WidgetSlotId, name: string }[]
  plugins: readonly UserLayerPluginView[]
  /** 网页小组件(沙箱)那一份目录。 */
  web_widgets_dir: string
  note?: string
}

/**
 * 一个**自定义模块**(2026-09-21「自定义模块容器」)。
 *
 * 它不是 `layout.modules` 里的那种模块 —— 那些是工作台自己写死的格子(项目区、随手记…),
 * 排布由布局/模板管。自定义模块是「说一句话让 DSH 做出来的一个小网页」,落在
 * `~/.dsh/workbench/modules/<id>/`,在窗位叠里**跟事务官同一档**:点它的标签,
 * 当前在台的原生窗藏起来,这一格的 iframe 铺满窗位槽。
 *
 * 所以它**不进布局、也不进模板** —— 切模板一个自定义模块都不会动(见 docs 交接第五节)。
 */
export interface CustomModuleView {
  /** 目录名,同时是路由前缀 `/modules/<id>/`。只许 `[a-z0-9][a-z0-9-]{0,39}`。 */
  id: string
  /** 标签上那几个字。用户在确认那一步自己起的名。 */
  name: string
  /** 标签上的小图标(一个字符,比如一个 emoji)。没有就不画。 */
  icon?: string
  created_at: string
  /**
   * `dsh` = 走「开发一个小工具」那条路做出来的;`user` = 用户自己往目录里放的。
   *
   * 字面值**没改**(盘上那些 `module.json` 里写着的就是 `dsh`),但它的含义 2026-10-01 变了:
   * 写它的不再是事务官自己那条 DSH 会话,而是她机器上被派活的那一家(设计 C2)。
   */
  source: 'dsh' | 'user'
  /** 入口文件名,恒是 `index.html`(留字段是为了以后能换,不是为了现在能换)。 */
  entry: string
  /**
   * 那块 iframe 的 src(2026-09-22,C7「自定义模块真边界」)。
   *
   * 它指向**单开的那个来源**(默认 `http://127.0.0.1:8794`),而且签着这个模块自己那把
   * 短期令牌 —— 客户端不自己拼这个地址,也拼不出来(端口与令牌只有服务端知道)。
   *
   * **缺席 = 这一格挂不出来**。没配单开来源(或者那台监听没起来)时整条不带,
   * 界面据此一格都不画 —— 绝不退回"同源打开"那条老路,那条路就是这张卡要关掉的门。
   */
  frame_url?: string
}

/**
 * 一条**待确认的小工具需求**(提议流程,PRD §5.6 门槛②③)。
 *
 * 用户说完那句话,事务官**先复述一遍 + 问它叫什么**,他点「就这样」才真派出去
 * (2026-10-01 起派给这台电脑上能写代码的那一家,不再是事务官自己写;设计 C2)——
 * 「不得自行执行」那一条在这里是一道代码门槛:没有 `POST /devtool/confirm`,
 * 一条事项都不会建、一个字都不会写进 modules/。
 *
 * PRD §9 门槛①(连续 3 天同向行为)**不适用于这一条**:那一条管的是"工作台自己看够了
 * 证据才许开口提议";这里是用户自己开口要的(决策记录 2026-09-20「从『看够证据才提议』
 * 升级为『用户开口就改』」),他那句话本身就是证据。门槛②(先预览)与③(明确采纳)照旧。
 */
export interface DevToolProposalView {
  id: string
  /** 他打的那一整句(含预填的开头)。原文一个字不改。 */
  request: string
  /** 复述:预填那段开头之后他自己说的那部分。**由代码切出来,不经模型**。 */
  restate: string
  /**
   * 草图(一句话描述界面)。**只有接了模型才有**;没接就整个缺席,界面照实说一句
   * 「这一版没有草图」 —— 不拿一句模板话冒充草图(D13)。
   */
  sketch?: string
  /** 确认之后这个模块会落在 `modules/<module_id>/`。确认那一刻之前它只是个占位的名字。 */
  module_id: string
  created_at: string
}

/** `/state.dev_tool`:这会儿有没有待确认的小工具需求。没接自定义模块服务时整块缺席。 */
export interface DevToolStateView {
  pending: readonly DevToolProposalView[]
}

/**
 * 「开发一个小工具」那颗按钮预填进事务官输入框的那一句(**预填,不发送**)。
 *
 * 2026-09-21 从 `client/DevToolButton.tsx` 搬到这里:服务端要拿它**认出**一条事项其实是
 * 一次造模块的请求(见 server/devTool.ts 的 isDevToolRequest),而服务端 import 不了客户端。
 * 同一句话有两个地方说得出口就是走漂的起点(同 MODULE_IDS、DEFAULT_LAYOUT 那两条先例),
 * 所以原处改成 re-export。
 *
 * 结尾故意停在「它要做的是:」——光标落在这里,用户接着说想要什么就行。
 */
export const DEV_TOOL_DRAFT = '我想在窗口槽这个位置开发一个工具类的小应用,它要做的是:'

/* ─────────────────── 用自然语言改布局(2026-09-22,「非标需求由事务官直接改」第一层)───────────────────
 *
 * Ben 原话:「我希望用户能用自然语言描述他对布局和模块功能的需求,事务官直接改。」
 *
 * 一句话 → 一份**动作草案** → 一张确认卡 → `POST /layout/act`。动作是**协议**,不是自由文本:
 * 每一种 kind 都能在 `client/layout.ts` 里指到一个既有的纯函数(见 src/layoutActs.ts 的映射表),
 * 所以"事务官能对布局做什么"这件事是**枚举出来的**,不是"它想改哪就改哪"。
 */

/**
 * 一次布局改动的动作种类。**这七个就是全集** —— 事务官做不了别的。
 *
 * | kind | 映射到 |
 * |---|---|
 * | `move`   | `moveModule`(上下)/ `swapModules` 与同排邻居(左右) |
 * | `region` | 反复 `moveLandscapeModule` 直到落进目标区域(只有横屏有区域) |
 * | `hide`   | `toggleHidden`(只在现在看得见时) |
 * | `show`   | `toggleHidden`(只在现在被收起时) |
 * | `rename` | `renameModule`(只改 `layout.titles`,不碰任何几何) |
 * | `resize` | `resizeModule` / `resizeRowPair` / `resizeLandscapeDeck` / `resizeLandscapeDeckPair` |
 * | `swap`   | `swapModules`(两格位置字段整体对调) |
 */
export const LAYOUT_ACT_KINDS = ['move', 'region', 'hide', 'show', 'rename', 'resize', 'swap'] as const
export type LayoutActKind = typeof LAYOUT_ACT_KINDS[number]

/** 底部那一排本身(横屏)。「底部那排高一点」说的是这个,它不是一个模块。 */
export const LAYOUT_DECK_TARGET = 'deck'

/** 布局的两个方向。`/layout/act` 校验 `orientation` 用的就是这一份。 */
export const LAYOUT_ORIENTATIONS = ['portrait', 'landscape'] as const

/**
 * 一条布局动作。字段按 kind 取用,**多给的一律忽略**(不报错:草案是机器生成的,
 * 多一个用不上的键不该让整句话作废)。
 */
export interface LayoutAct {
  kind: LayoutActKind
  /** 对哪一格。`'deck'`(LAYOUT_DECK_TARGET)= 横屏底部那一整排。 */
  module: string
  /** `move`:往哪儿挪一格。 */
  dir?: 'up' | 'down' | 'left' | 'right'
  /** `region`:挪进哪个区域(横屏)。`side` = 右侧栏、项目区下面;`deck` = 底部那一排。 */
  region?: 'side' | 'deck'
  /** `rename`:改叫什么。 */
  title?: string
  /** `swap`:跟谁换。 */
  other?: string
  /** `resize`:改高矮还是改宽窄。 */
  axis?: 'height' | 'width'
  /** `resize`:加几个百分点(负数就是减)。 */
  delta_pct?: number
}

/**
 * 一条待确认的布局改动(落盘在 `~/.dsh/workbench/layout-asks.json`)。
 *
 * 形状照抄 `DevToolProposalView`,理由也一样:从"说完那句话"到"点确认"中间可能隔着一次
 * 刷新,那条需求只活在内存里的话他回来就得重说一遍。
 */
export interface LayoutAskView {
  id: string
  /** 他打的那一整句。原文一个字不改。 */
  request: string
  /** 复述:**由代码从词表拼出来的**,不经模型(同 devToolRestate 的理由)。 */
  restate: string
  /** 这份草案按哪个方向的布局算。 */
  orientation: 'portrait' | 'landscape'
  actions: readonly LayoutAct[]
  created_at: string
}

/** `/state.layout_ask`:这会儿有没有等他点头的布局改动。没接这条链路时整块缺席。 */
export interface LayoutAskStateView {
  pending: readonly LayoutAskView[]
}

/* ─────────────────── 进化循环（2026-09-22，卡 ⑥；设计文档 §五「持续进化的一条线」）───────────────────
 *
 * Ben 原话:「变成一个能够持续进化的工作系统,结合我们开发一个小工具、小组件这样的能力,
 * 能够一些东西固化下来,通过事务官的自编程能力,逐步进化。」
 *
 * 判据、阈值与全部纯函数在 `server/evolve.ts`;这里只放**两端都要认的形状**。
 * 这一版"自编程"的上限钉死在两样:一份技能文档、一条走既有造模块链路的小组件请求 ——
 * **不改工作台本体代码**（设计文档 §五 末尾那一句）。
 */

/** 固化成什么。三条都是**现成的路**,一条都不新造。 */
export type EvolveWay = 'skill' | 'tool' | 'template'

export const EVOLVE_WAYS: readonly EvolveWay[] = ['skill', 'tool', 'template']

/**
 * 一条等她点头的固化提议（落盘在 `~/.dsh/workbench/evolve.json`）。
 *
 * 形状照抄 `DevToolProposalView` / `LayoutAskView`,理由一样:从"提议冒出来"到"她点头"
 * 中间隔着至少一个晚上,只活在内存里的话第二天就没了。
 *
 * **每一个字段都是从她自己说过的话里拼出来的**,不经模型（server/evolve.ts 的纪律②）。
 */
export interface EvolveProposalView {
  /** 稳定 id（`evolve:<归一化文本>`）。她点过「不要」之后靠它认出同一条,下次不再提。 */
  id: string
  /** 卡的第一行:「这 3 次你都在说「X」—— 要不要把它固化下来?」 */
  ask: string
  /** 代表句（那一簇里最短的一条原话）。 */
  sample: string
  /** 近 14 天里同一类说过几次。 */
  times: number
  /** 那几次的原话。她要能看见"我哪三次说过",否则这条提议无从判断。 */
  says: readonly string[]
  /** 默认建议走哪条路。**只是默认值**,卡上三条都点得动。 */
  suggested_way: EvolveWay
  /** 三条路各自「准备怎么做、会碰什么」。她点头之前唯一看得见的凭据。 */
  plans: Record<EvolveWay, string>
  created_at: string
}

/**
 * 采集器(2026-09-23,用户层;`server/collectors.ts`)。一行采集记录:成没成、为什么。
 * `status` 里 `logged_out` / `captcha` / `blocked` 三种是撞墙(与采集类三项同一套判据),
 * `window_closed` 是那个登录窗口没开着,`gated` 这一版不落盘(闸拦下的不算一次尝试)。
 */
export interface CollectorRecordView {
  at: string
  trigger: 'manual' | 'routine'
  status: 'ok' | 'logged_out' | 'captcha' | 'blocked' | 'window_closed' | 'error'
  href?: string
  chars?: number
  message?: string
}

export interface CollectorView {
  name: string
  url: string
  profile: string
  created_at: string
  note?: string
  /** 最后一次尝试(成没成都算)。 */
  last?: CollectorRecordView
  /** 最后一次**采成**的时刻。 */
  latest_at?: string
  /** 今天试了几次(闸按它算)。 */
  today: number
}

/** `/state.collectors`。没配工作目录时 `items` 空、`note` 说明为什么。 */
export interface CollectorsView {
  items: readonly CollectorView[]
  note?: string
}

/** `/state.evolve`:等她点头的固化提议 + 上一次固化的回看。没接这条链路时整块缺席。 */
export interface EvolveStateView {
  pending: readonly EvolveProposalView[]
  /**
   * 复盘/下班例程里那一句「上次固化的 X 用了没」。**没有已固化的就整条缺席** ——
   * 不拿一句"还没有固化过任何东西"占位（D13）。
   */
  review?: string
  /**
   * 她说过不止一次的偏好(2026-09-23,自进化最小闭环)。**只列还在生效的**(试用中 / 已验证),
   * 撤了的不在这里(在进化日志里)。没接这条链路、或一条都没攒够时整块缺席。
   */
  preferences?: readonly EvolvePreferenceView[]
  /**
   * 收件箱里那至多两条提示(记下了一条偏好 / 验证过了保留 / 没见效撤了)。
   * 过了 `NOTICE_TTL_DAYS` 自己消失,**没有按钮**:要撤走 `/evolve/revert`。
   */
  notices?: readonly EvolveNoticeView[]
}

/**
 * 一条偏好的三种状态(2026-09-23):
 * - `trial`    记下了,等下一条选题验证 —— 推进的话里已经带上它;
 * - `kept`     下一条选题她通过了那份产物、没再打回同一处 → 保留;
 * - `reverted` 下一条选题她又打回了同一处 → 没见效,撤了(或她手动撤的)。
 */
export type EvolvePreferenceStatus = 'trial' | 'kept' | 'reverted'

/**
 * 一条「她在不止一条选题上都打回过同一处」的偏好。
 *
 * **每一个字都是她自己打的字或数出来的**:`text` 是那几次里最短的那句原话,
 * `topics` 是在哪几条选题上说过。这里没有一句是归纳的(server/evolve.ts 的纪律②)。
 */
export interface EvolvePreferenceView {
  /** 稳定 id(`pref:<归一化文本>`)。撤过的靠它认出来,不再自动记第二遍。 */
  id: string
  /** 代表句(原话,最短那一条)。 */
  text: string
  /** 在哪几条选题上说过(按时间先后)。 */
  topics: readonly string[]
  status: EvolvePreferenceStatus
  /** 记下来的时刻(ISO)。验证只看这之后的推进。 */
  adopted_at: string
  /** 验证的结论(人话)。还在试用时缺席。 */
  verdict?: string
  /** 拼好的一行:推进的话里、`账号.md` 里、收件箱里都用它,三处一个字不差。 */
  line: string
}

/** 收件箱里那一条提示。`kind` 三种,对应偏好的三步:记下 / 保留 / 撤。 */
export interface EvolveNoticeView {
  id: string
  kind: 'adopted' | 'kept' | 'reverted'
  title: string
  note: string
  at: string
}

 /**
 * 数据复盘自取回来的一个指标(2026-09-21)。
 *
 * **取不到就整条缺席,绝不用 0 顶替** —— 0 和「不知道」是两回事。
 * 界面对缺席的那几项说「后台没有这项」。
 */
export interface XhsMetricView {
  key: string
  /** 界面上的名字(Ben 草图的原话)。 */
  label: string
  kind: 'count' | 'percent' | 'seconds'
  /** 归一化的值。缺席 = 这一项后台没给。 */
  value?: number
  /** **页面上原样那串**(「1.1万」「11.1%」「00:11」)。界面显示它,不重新格式化。 */
  raw?: string
  /**
   * 这个数是**算出来的**时候写一句怎么算的(「合计」「按曝光加权」)。
   * 页面上直接读到的数**永远没有这一项** —— 有它就是"这不是后台写着的字"。
   */
  derived?: string
  /**
   * 这一格空着的时候,**为什么**空着(2026-09-22)。
   * 「平台没给」与「这次没数全」是两句不同的实话,界面把这一句原样贴在那一格下面。
   */
  why?: string
  /** 上一周期同一指标的值,以及那份快照是哪天取的。没有就缺席,界面不画箭头。 */
  prev?: { value: number, raw: string, date: string }
}

/** 一个数据范围的一份快照。 */
export interface XhsRangeView {
  range: string
  /** 这份快照是哪天取的(本地日期)。 */
  date: string
  at: string
  metrics: readonly XhsMetricView[]
}

/** 一次自取的记录。成功失败都写一条,模块里「自取记录」原样列出来。 */
export interface XhsFetchLogView {
  at: string
  ok: boolean
  /** 取到几项 / 一共几项。失败时 got 为 0。 */
  got: number
  total: number
  /** 这一次是谁发起的。`login` = 登录窗口里一看出他登上了就自己取的那一轮(2026-09-30)。 */
  trigger: 'routine' | 'manual' | 'login'
  /** 失败原因,一句人话。成功时缺席。 */
  reason?: string
}

/** 事务官给的三条优化建议。没数据就整块缺席 —— **不生成**。 */
export interface XhsAdviceView {
  at: string
  /** 依据的是哪个范围。 */
  range: string
  items: readonly { text: string, basis: string }[]
}

/**
 * 「数据复盘」那一格的全部数据(2026-09-21)。
 *
 * 登录态**只回布尔与昵称**:Cookie 留在那个专用 Chrome 档案里,
 * 我们一个字都不存、也一个字都不往外送(同 credentials.ts 的「永不回显」)。
 */
/** 折线图上的一个点。**只有真取到的那一天才有点**(缺的天整条不出现,见 server/xhsTrend.ts)。 */
export interface XhsTrendPointView {
  date: string
  /** 归一化的值(算高低用)。 */
  value: number
  /** 页面上原样那串;互动那条是「<点赞原文> + <收藏原文>」。提示里显示它,不重新格式化。 */
  raw: string
}

/** 折线图上的一条线。三条:观看数 / 互动(点赞+收藏)/ 涨粉。 */
export interface XhsTrendSeriesView {
  key: string
  /** 界面上那一行小标题(逐字取自 Ben 的运营草图)。 */
  label: string
  /** 这条线是从快照里哪几项来的。界面上「依据」那一句念的就是它。 */
  from: readonly string[]
  /** 有值的那几天,按日期升序。**空数组 = 这条线一个点都没取到**,不是"全是 0"。 */
  points: readonly XhsTrendPointView[]
}

/**
 * 折线图那一份(2026-09-21)。`dates` 是**完整的日历轴**(近 7 日 = 7 天,近 30 日 = 30 天),
 * `series[].points` 只出现在真有快照的日子上 —— 两者一对,界面就知道哪几天该断线。
 */
export interface XhsTrendView {
  range: string
  /** 轴上的每一天(升序,含今天)。 */
  dates: readonly string[]
  series: readonly XhsTrendSeriesView[]
}

/**
 * 一个账号 = 一个浏览器档案(2026-09-22 多账号)。
 *
 * 归属只认**从首页读回来的**账号名与「小红书账号」id;两样都读不到时 `name`
 * 就是「账号 N」——**不拿档案目录名冒充昵称**。
 */
export interface XhsAccountView {
  /** 浏览器档案目录名。机器键,界面不显示它。 */
  profile: string
  /** 第几个档案(1 起)。 */
  index: number
  /** 界面上叫它什么。读到了就是首页上那个名字,读不到就是「账号 N」。 */
  name: string
  /** 首页「小红书账号」那一串。读不到就缺席。 */
  uid?: string
  /** 这个档案此刻还在登录态吗。 */
  connected: boolean
  /** 两个范围各一份,取不到的那个范围缺席。 */
  ranges: readonly XhsRangeView[]
  trends?: readonly XhsTrendView[]
  /**
   * 对上的运营账号文件夹(`<工作目录>/账号/<名>`)的名字。
   * **按名字匹配,匹配不上就缺席** —— 不强绑(见 server/xhsAccount.ts 文件头)。
   */
  account_dir?: string
  /** 这个账号这一次的实话(登录态过期了 / 范围没切成 / 笔记数没数全)。 */
  note?: string
}

export interface XhsView {
  login: {
    connected: boolean
    /** 后台页面上显示的昵称。读不到就缺席,界面只说「已接上」,**不编一个名字**。 */
    nickname?: string
  }
  /**
   * 每个账号一份(2026-09-22)。**空数组 = 一个档案都还没有**(没登过)。
   * 只有一个账号时,下面那份 `ranges` / `trends` 与 `accounts[0]` 的逐字相同。
   */
  accounts: readonly XhsAccountView[]
  /**
   * 合计那一行(所有账号加起来)。只有一个账号时**就是它自己,一个字不改**。
   * 能加的加、比率按曝光加权、少一个账号就整格缺席 —— 口径在 server/xhsTotal.ts。
   */
  ranges: readonly XhsRangeView[]
  /** 自取记录,新的在前。 */
  fetches: readonly XhsFetchLogView[]
  /** 最近一次**成功**的自取时刻。从没成功过就缺席。 */
  last_ok_at?: string
  /** 此刻这一格顶上要说的那句实话(没登录 / 页面变了 / 上次成功 x 小时前)。 */
  note?: string
  advice?: XhsAdviceView
  /** 下一次能点「刷新」的时刻(两次自取之间至少 10 分钟)。 */
  refresh_ready_at?: string
  /** 「让我看看这页」最近一次把页面文本导到哪。**不含 cookie**。 */
  peek?: { at: string, file: string, chars: number }
  /**
   * 折线图(2026-09-21)。两个范围各一份。**这一份也是合计那一条。**
   * **缺席 = 这台服务还没接折线图**(老版本),界面就只画上面那一行八格,不画图。
   */
  trends?: readonly XhsTrendView[]
  /** 合计那一行下面那句话(算了几个账号、为什么有的格是空的)。 */
  total_note?: string
}

/**
 * 采集类(2026-09-22):一条采集记录。**成功失败都有一条** —— 自动动作要看得见(PRD §9),
 * 而这件事比自动动作更要紧:他得随时能看见我们替他打开过哪几页、滚了几下。
 */
export interface XhsCollectLogView {
  at: string
  /** 来源链接,**他自己给的那一条**,原样。 */
  url: string
  ok: boolean
  /** 这一次是采笔记还是拆解。 */
  kind: 'note' | 'breakdown'
  /** 采到几条评论。失败时缺席,**不写 0**。 */
  comments?: number
  /** 产物落在哪个文件夹。 */
  dir?: string
  /** 让页面滚了几下。写出来是因为它是我们唯一让页面动的动作,不藏着。 */
  scrolls?: number
  /** 失败原因,一句人话。成功时缺席。 */
  reason?: string
}

/**
 * 「采集」那一块的全部数据(2026-09-22)。
 *
 * 与 {@link XhsView}(数据复盘)**是两件事**:那条读的是他自己的后台,
 * 这条读的是别人的笔记。设置里的承诺也是两段,不共用一个字。
 */
export interface XhsCollectView {
  /** 今天已经采了几条。 */
  today: number
  /** 一天上限(可在 `~/.dsh/workbench/xhs-collect.json` 里改)。 */
  daily_max: number
  /** 采集记录,新的在前。 */
  logs: readonly XhsCollectLogView[]
  /** 工作目录配了没有。没配 = 采下来没地方落,整块如实拒绝。 */
  workdir_ready: boolean
  /** 此刻要说的那句实话(上一次为什么停下来)。 */
  note?: string
  /** 爆款拆解那几样本机工具在不在。缺席 = 这台服务没问过。 */
  tools?: { ffmpeg: boolean, whisper: boolean, model: boolean, note: string }
}

/**
 * 插件进程自己的内存与事件循环(2026-10-19,卡「插件内存增长与 GC 抖动」;采样在 server/processHealth.ts)。
 *
 * 全是**数出来的事实**:`process.memoryUsage()`、`v8.getHeapStatistics().heap_size_limit`、
 * `perf_hooks.monitorEventLoopDelay`。取不到的那一格缺席,不编(D13)。
 * 事件循环那三格是**最近一个采样窗**(≤ 60 秒)里的分位数,窗里一个样本都没有就缺席。
 */
export interface ProcessHealthView {
  /** 常驻内存(MB,一位小数)。 */
  rss_mb: number
  heap_used_mb: number
  heap_total_mb: number
  /** V8 给这个进程的堆上限(MB)。堆用量贴着它,就是「一直在做全量回收」的直接原因。 */
  heap_limit_mb: number
  /** V8 堆之外的(Buffer、原生对象)。 */
  external_mb: number
  /** 进程起了多久(秒,整数)。 */
  up_sec: number
  started_at: string
  /** 事件循环延迟 p50 / p99 / 最大(毫秒,一位小数)。 */
  loop_p50_ms?: number
  loop_p99_ms?: number
  loop_max_ms?: number
  sampled_at: string
}

export interface WorkbenchState {
  agents: readonly AgentView[]
  sessions: readonly SessionView[]
  quota: Partial<Record<AgentId, QuotaEntry>>
  now: string
  /**
   * 上游（DSH/Agent 层）掉线时为 true。
   * 架构约束 C1：此时看板必须继续显示最后已知状态并明示"Agent 掉线"。
   */
  stale: boolean
  /**
   * 当前正在响的铃(2026-08-25 新增)。
   *
   * 在此之前响铃状态**只活在消息流里**，谁也不持有：订阅者一断线重连就永久丢失这次响铃。
   * 真机后果——树莓派重连后回到待机态，POP 按键按下去什么也不做；网页那个「🔕停铃」
   * 只认 dsh:test-ring 一个键，真响铃只能干等展示台 60 秒兜底自停。
   * 放进快照之后，重连的订阅者能立刻知道现在在响什么并恢复响铃态。
   *
   * 可选字段：display-client 副本本期不同步，它不读这个字段，不受影响。
   */
  ringing?: readonly ActiveRing[]
  /** v5 项目区整块(spec §6)。未接 ProjectsService 或本次取不到就缺省，不让整个 /state 挂掉。 */
  projects?: ProjectsState
  /** 自定义布局(spec D12)。未存过时缺省，界面退回默认布局。 */
  layout?: WorkbenchLayout
  /**
   * 机器信号一次采样(spec §6)。任一底层命令失败就是 { error }，绝不编数(D13)。
   *
   * `process` 是**插件进程自己**的内存与事件循环(2026-10-19,卡「插件内存增长与 GC 抖动」):
   * 机器那几个数说「这台电脑怎么样」,这一格说「跑工作台的这个进程怎么样」—— 10-19 那天
   * 进程跑了 4 天 20 小时后 RSS 350~520MB 来回涨落、一直在做全量回收,每个请求都要几秒,
   * 而 /state 里没有一格能看出来。没接采样器就缺席;机器采样整格缺席时它也一起缺席。
   */
  machine?: ({
    disk_pct: number
    disk_free_gb: number
    mem_gb: number
    cpu_idle_pct: number
    sampled_at: string
  } | { error: string }) & { process?: ProcessHealthView }
  /** 各来源的未读/待办数，供角标显示；取不到某家就该家缺省。 */
  badges?: Record<string, number | null>
  /**
   * 工作台是否处于暂停(spec §5 诚实边界)。
   * 暂停只跳过响铃广播与工作台自身的自动行为——没有任何通道能控制/挂起 Agent 进程本身，
   * 暂停期间各 agent 该干嘛还干嘛，工作台只是不再为它们敲铃、不再自动推送。
   */
  paused?: boolean
  /**
   * 手动试铃（/ring/test）是否在响。按钮文案的真相在服务端——POP 摘机停铃、
   * 60 秒自动归零、别的窗口按过，浏览器本地都无从知晓，只能从这里读。
   */
  test_ringing?: boolean
  /**
   * 系统日历"今天+7天"事件(spec §R3 结论:走 AppleScript/osascript，免安装)。
   * calendar.ts 里任一环节失败就是 `{ error }`，绝不编数(D13)——包括还没等到首次采样、
   * osascript 执行失败/超时、日历访问未授权等情况，界面据此显式标注"日历未接入"。
   * 首次调用会触发 DSH 宿主进程自己的一次系统日历授权弹窗(§R3 Step 2b：TCC 按宿主
   * bundle id 独立记账，和调研会话所在的 Claude.app 不是同一份授权)，这是一次性成本。
   */
  calendar?: { events: readonly { date: string, title: string }[] } | { error: string }
  /**
   * 哨兵(2026-09-09)。未接 sentinelService 时缺省,事务官浮窗那一栏整块不渲染。
   * 触发本身不走这个字段——它走的是会话事件(waiting + idle_prompt),
   * 这里只是「在盯着的事」那张表。
   */
  sentinel?: SentinelView
  /** 随手记(2026-08-25 版面重排起服务端落盘)。未启用该服务时缺省。 */
  notes?: readonly NoteView[]
  /** 窗口编排壳的连接/授权状态。未接 helper 时缺省,界面按「未接入」处理。 */
  helper?: HelperView
  /** 场景列表(spec W6)。未接 scenes 服务时缺省。 */
  scenes?: readonly SceneView[]
  /**
   * 当前布局模板(2026-09-21)。**additive 可选**——没接模板服务(展示台、手机、一大批用例)
   * 时整块缺席,界面按「做产品」那一套文案走,与加这个字段之前逐字相同。
   */
  template?: TemplateStateView
  /**
   * 自定义模块清单(2026-09-21)。**additive 可选** —— 没接 modules 服务(展示台、手机、
   * 一大批用例)时整块缺席,窗位叠里一个自定义标签都不画,与加这个字段之前逐字相同。
   * 回收站里那些**不在这里**(`GET /modules` 才给),标签栏只该看见还活着的。
   */
  modules?: readonly CustomModuleView[]
  /**
   * 用户层的页内小组件清单(2026-10-21)。**additive 可选** —— 没接用户层(展示台、手机、一大批用例)
   * 时整块缺席,客户端那几格一律用本体自带的那一版(或已装好的那一份,见 `client/userLayer.ts`)。
   */
  user_layer?: UserLayerStateView
  /** 待确认的小工具需求(2026-09-21)。同上,additive 可选。 */
  dev_tool?: DevToolStateView
  /**
   * 等她点头的固化提议（2026-09-22，卡 ⑥ 进化循环）。**additive 可选** ——
   * 没接这条链路（展示台、手机、一大批用例）时整块缺席，事务官档里一张固化提议都不画。
   */
  evolve?: EvolveStateView
  /** 采集器(2026-09-23,用户层)。没接这块服务时整块缺席。 */
  collectors?: CollectorsView
  /**
   * 等他点头的布局改动(2026-09-22「用自然语言改布局」)。**additive 可选** ——
   * 没接这条链路(展示台、手机、一大批用例)时整块缺席,事务官档里一张确认卡都不画。
   */
  layout_ask?: LayoutAskStateView
  /**
   * 会议(2026-09-21 会议模式)。**additive 可选** —— 没接会议服务(展示台、一大批用例、
   * 以及**没配工作目录的机器**)时整块缺席,事务官面板里那条「最近一次会议」一个字都不出。
   */
  meetings?: MeetingsView
  /**
   * 通话记录(2026-10-22:通电话是记录不是事项)。**additive 可选** —— 没接这块服务时整块缺席,
   * 手机退回读老的纪要卡。
   */
  calls?: CallsView
   /**
   * 数据复盘从小红书创作者中心自取的那几个数(2026-09-21)。**additive 可选** ——
   * 没接自取服务(展示台、手机、一大批用例)时整块缺席,「数据复盘」那一格按
   * 「还没接上」那一版显示,与加这个字段之前逐字相同。
   */
  xhs?: XhsView
  /**
   * 采集类三项(2026-09-22)。**additive 可选** —— 没接采集服务时整块缺席,
   * 界面上一个采集入口都不出(**不是"灰着的按钮"**:没接就是没有这件事)。
   * 与上面那个 `xhs` 是两件事,故意不合并:那条读他自己的后台,这条读别人的笔记。
   */
  xhs_collect?: XhsCollectView
  /** 最近一次贴合结果。从未贴合过时缺省。 */
  snap?: SnapView
  /**
   * 窗口槽应用清单(spec S4)。未接 appsRegistry 时缺省。
   * A4(2026-08-24 UX 波):客户端的「管理」入口 + AppManagePanel 已经下线——标签的 ✕
   * (放出到本机、不删清单)加拖拽认领(A2)取代了它,增删应用变成纯服务端能力
   * (registry.add/remove 与 /apps/* 路由仍在,只是没有 UI 挂在这份数据上了)。这份字段
   * 因此暂时没有客户端消费者,继续保留是为了不打破 /state 的既有契约,也留给以后
   * 万一要重新露出增删入口时用。
   */
  apps?: readonly { key: string, label: string }[]
  /** 窗位叠状态(spec 2026-08-24 窗位叠 v2 V1–V6)。未接 dockService 时缺省。 */
  /**
   * 用量面板整块(2026-08-25)。取不到就缺省,不让整个 /state 挂掉——
   * 与 projects/machine 同一套降级纪律。全部来源都失败时为 { error }。
   */
  usage?: UsageState | { error: string }
  /**
   * 任务看板整块(2026-08-25)。取不到就缺省——tasks.json 写坏了只是看板空着,
   * 不会把整个 /state 弄挂(与 projects/usage 同一套降级纪律)。
   */
  tasks?: TasksState
  /**
   * 事项收件箱里「事务官交给我」那一半(2026-09-10)。**现拼不落盘**,四个来源
   * (等我确认的卡 / 等审批的 DSH 会话 / 哨兵命中 / 排期赶不上)全在这份快照里,
   * 拼不出来就是空列表——不是缺省,空列表本身就是"这会儿事务官没什么要找你"的真话。
   * 服务端**恒带这个字段**;可选只是为了给老客户端与 display-client 留退路。
   */
  butler_inbox?: ButlerInboxView
  /**
   * 进度评估器此刻的样子(2026-09-25,卡 N):上一轮什么时候、为什么跑、花了多少、今天一共花了多少 / 上限多少,
   * 读不读得了各家会话正文(授权表 `read_session_content`)。每张卡自己的结论在 `tasks.tasks[].progress`。
   * 缺席 = 没接评估器。
   */
  progress?: ProgressRunStateView
  /**
   * Agent 登记表(2026-09-25,卡 Q「Agent 自动发现与统一接入」)。**有哪几家 Agent 只认这一份**:
   * 运行时自己发现、记在 `~/.dsh/workbench/agents.json`,界面(顶栏、会话列表、事务官舞台、手机)、
   * 派活与额度都读它,代码里不再有「有哪几家」的表。没接登记表服务时整块缺席。
   */
  agent_registry?: AgentRegistryView
  /**
   * 座机主动来电的台账(2026-09-21)。**落盘**(与收件箱「现拼不落盘」相反):
   * 「打没打过、他接没接」是发生过的事,不是从别处算得出来的状态 —— 重启一次就忘了打过没有,
   * 等于重启一次他的手机就再响一遍。未接来电数在 `missed`;事务官面板据此在那一条上
   * 标「打过电话:已接 / 未接」。没接来电服务时缺省,面板上那一格整格不出。
   */
  call_out?: CallOutView
  /**
   * **此刻能不能出声**(2026-09-26,卡 QH)。整个产品只有这一格 —— 来电、朗读、提示音、
   * 手机与电脑的一切出声都读它,**不许各处各写一份时段判断**(那次半夜朗读就是这么漏的)。
   * 判断在 `server/quietHours.ts`;时段读不出来时只回 `{ active: false }`(不编一个时段出来)。
   * 没接座机服务(没有那份 `/call/config`)时整格缺席 —— 缺席按「能出声」算,不替他静音。
   */
  quiet?: QuietView
  dock?: {
    stack: readonly DockTab[]
    /**
     * 叠里每一格是哪个 App(键 → 包标识,2026-09-25 卡 Q)。界面据此把标签对上 Agent 登记表里的那一家
     * (圆点与气泡读登记表,不再按键名猜是哪家)。老服务端没有这一格。
     */
    bundles?: Readonly<Record<string, string>>
    /**
     * 他要放进窗口槽、但**还没拉进来**的那几家(2026-09-25,卡 fix/quota-and-slot-apps)。
     * 来源是 apps.json 的 `enabled`(引导 ④ 他说的「那几个都放进去」),按那里的顺序;已经在 `stack`
     * 里的不重复出现。标签栏把它们画成虚边的标签,写「点一下拉进来」(点了 `POST /dock/claim`)。
     * 一个都没有时整格缺席。
     */
    pending?: readonly DockPendingTab[]
    note?: string
    /**
     * S6(review,紧急小轮):moved 事件可观测环——验收拖拽认领"到底有没有生效"以前只能
     * 靠代理指标(note 有没有清、stack 有没有多一条),真机上反复出现"note 清了但没认领"
     * 这种代理指标失真的情况,根源是服务端对"moved 事件到底有没有收到"完全没有可见性。
     * 这里把 handleMoved 每一次被调用(不管走哪个分支、包括被判定为跟叠无关而忽略的)
     * 都如实记一条,最近 8 条,内存环、不落盘——纯诊断用,查的是"事件有没有到达+服务端
     * 怎么判的",不是给客户端渲染 UI 用的字段。
     */
    recent_moves?: readonly { bundle_id: string, ts: string, decision: string, detail?: string }[]
    /**
     * Chromium AX 修复:ax_stale 诊断环——壳侧探测到某个 bundle 的 AXObserver 通道休眠
     * (看似订阅成功但收不到回调)、已自动唤醒重试后如实记一条,最近 8 条,同 recent_moves
     * 一样内存环、不落盘。纯诊断用,查的是"哪个应用的 AX 通道睡过、睡了几次",不是给
     * 客户端渲染 UI 用的字段。
     */
    recent_ax?: readonly { bundle_id: string, ts: string, ax_err: number, ax_count: number, cg_count: number }[]
    /**
     * 窗位矩形观测环(2026-08-25 真机实证,同 recent_moves/recent_ax 先例):setSlotRect
     * 每一次被调用都如实记一条——包括被 rectEquals/8px 噪声门槛挡下、没有真的存的那些
     * (`stored:false`)。排障用:回答"服务端到底收到过哪些矩形上报,哪些真的存了、
     * 哪些被门槛挡了"。最近 8 条,内存环、不落盘,不是给客户端渲染 UI 用的字段。
     *
     * `rejected`(2026-08-25 矩形上报只认壳内页面,评审补):http.ts 在 source !== 'app'
     * 时业务层直接拒绝、根本不会调用 setSlotRect——这类请求如果完全不进环,部署兼容窗口期
     * (壳内页面还没跟上带 source 这条规则)排障时环是空的,和"压根没在报"无法区分。
     * 这类条目 `rejected:true`、`stored` 恒为 false(业务拒绝,连噪声门槛判定都没走到)。
     */
    recent_rects?: readonly { ts: string, rect: HelperRect | null, reason?: 'resize', stored: boolean, rejected?: boolean }[]
    /**
     * 事务官清理观测环(2026-09-09 事务官标签 bug,同 recent_moves/recent_ax/recent_rects 先例):
     * 点「事务官」(POST /dock/hide)时每一次真的 hide_app 成功都记一条——`decision:'current'`
     * 是原本在台的那一扇,`decision:'stray'` 是被别的路径(场景恢复、用户自己点回、双窗
     * 第二扇、AX 重挂)露出来、盖在事务官 iframe 上的残留窗口。最近 8 条,内存环、不落盘。
     * 纯诊断用:回答"这次点事务官到底清了谁",不是给客户端渲染 UI 用的字段。没藏成的不进环
     * (失败原因走 note)。
     * 2026-09-16 起弹层让路(POST /dock/veil on)也记:`'veil-current'` 是让路时藏起的 current,
     * `'veil-stray'` 是让路时顺手清掉的残留窗(unveil 不带回它们)。
     */
    recent_hides?: readonly { app: string, bundle_id: string, ts: string, decision: 'current' | 'stray' | 'veil-current' | 'veil-stray' | 'switch' | 'switch-deferred' | 'restore-stray' | 'transient' }[]
    /**
     * 切换耗时观测环(2026-09-21 Ben:「今天点击标签切换应用经常卡住」)。
     *
     * **跟上面几个环不一样:这一条是给人看的** —— 设置里「体检与修复」最下面那一小块
     * 「最近的窗位切换」一行一条渲染它。"卡住"只有 Ben 感觉得到,而「哪一次慢、慢在抬窗
     * 还是藏别家、谁超时了」必须有真数字才谈得下去。最近 10 条,内存环、不落盘。
     *
     * - `total_ms` 整件事花了多久(切换有 3 秒总预算,见 dock.ts 的 SWITCH_TOTAL_BUDGET_MS);
     * - `raise_ms` 其中「把要切到的那家抬起来」花了多久(用户看得见的那一半,最优先);
     * - `hidden` 当场藏掉了几家;`deferred` 有几家因为超预算挪到了后台队列(缺省即 0);
     * - `timed_out` 哪几家这次没动成、壳给的原话(缺省即没有)。
     */
    recent_switches?: readonly {
      app: string
      ts: string
      ok: boolean
      total_ms: number
      raise_ms: number
      hidden: number
      deferred?: number
      timed_out?: readonly string[]
    }[]
    /**
     * 「有一家被叫到前面」观测环(2026-09-25,卡 P;截图快捷键把企业微信叫出来)。壳每报一次结论记一条,最近 12 条,
     * 内存、不落盘,纯诊断(同 recent_moves 先例):那一家是谁、壳的结论(真切过去 / 临时叫一下、为什么)、
     * 遮罩那扇窗的层级与大小,以及服务端这边做了什么(`decision`:藏回去 / 跟过去 / 不在窗口槽里 / 本来就在台前 …)。
     * 真机点验与写「各家截图遮罩窗的特征」都看它。
     */
    recent_activations?: readonly ActivationRecord[]
    /**
     * 弹层让开窗位(2026-09-11):此刻有弹层开着、窗位正让着路时才有。`depth` = 开着的弹层数
     * (计数式,最后一个关才 unveil),`app` = 让路时藏起来的那一扇(事务官在台/没藏成时缺省)。
     * 缺省即"没在让路"。纯诊断透出,不驱动 UI。
     */
    veil?: { app?: string, depth: number }
  }
  /** 今晨快报(W4)。未接 briefService 时缺省。取数失败/status 非 ready/topics 为空一律不推、不摆空壳。 */
  brief?: BriefView
  /** 日结(PRD 5.7)。未接 dailyService 或还没到过 9 点、一份都没生成过时缺省。 */
  daily?: DailyReport
  /**
   * DeepSeek 峰谷时段(2026-09-09)。每次组装 /state 现算,所以"12:02 转低谷"是当下的,
   * 不会被五分钟一轮的额度采集拖成陈旧值。未接时间表服务时缺省。
   */
  deepseek_peak?: DeepSeekPeakView
  /** 事务官本机后端(butler-server)。未接线时缺省,设置弹窗那一节整块不出现。 */
  butler?: ButlerView
  /**
   * 连接器(open-connector,各家平台的插座板)。**默认装上**,开机后在后台自己装
   * (维护者 09-27 11:30:「我是让你装啊」)。未接线时缺省,设置里那一行不出现。
   */
  connector?: ConnectorView
  /** 手机与设备(2026-09-11)。未接配对服务时三者都缺省,设置里那一节整块不渲染。 */
  lan?: LanView
  /** 当前有效的配对码。**只对本机来源的 GET /state 返回**,广播快照与 /live 里永远没有。 */
  pairing?: PairingView
  devices?: readonly DeviceView[]
  /**
   * 引导流程进度(2026-09-15,docs/设计-引导流程.md v2)。未接 onboarding 服务时缺省。
   * 只有三个字段,不编数:没开过引导会话就没有 askedAt。前台(手机 App)据此决定要不要开口。
   */
  onboarding?: OnboardingStateView
  /**
   * 界面上怎么写用户自己(2026-10-22 新 UI 第三轮 8,维护者:协作区上不写「你」,写账号名)。
   * 引导里答过称呼就用称呼,没有就用本机登录的账号用户名;两样都没有就整格缺席。
   */
  me?: { name: string }
  /**
   * 引导落地那张单子(2026-09-24 晚,卡 feat/onboarding-materialize):「我照你说的摆好了」。
   * 电脑首页球下面与手机「等你确认」都画它;没排过就缺席。
   */
  materialize?: MaterializeStateView
  /**
   * 事务官外观的版本号(2026-09-16,~/.dsh/workbench/appearance.json 的 version)。没存过就缺省;
   * Mac 页面与手机看到它变了就重新拉 GET /butler/appearance。
   */
  appearance_version?: number
  /**
   * ★ 这台工作台**认请求号**(2026-10-12,卡「手机交代只执行一次」;`server/clientKeys.ts`):带同一个 `client_key` 再来只办一次。
   * 手机看到它才**自动**补发待发箱里没送到的那几句 —— 老工作台不认号,自动补发可能真办两次。缺席 = 老工作台。
   */
  client_keys?: true
  /**
   * 事务官的日常例程(2026-09-15):开工汇报 / 下班例程 / 每周知识 lint 的下一次、上一次与在跑。
   * 未接例程服务时缺省,设置里那一节整块不渲染。
   */
  routines?: RoutinesView
  /**
   * 三件主路(早报、交代、电话)各成没成、她答的「想先试哪一件」、自检那三行(2026-10-21,卡「引导三件事」;
   * 形状与口径在 `src/mainPaths.ts`)。首次引导「第一次有用」那一屏与首页「现在能做什么」读它。未接线时缺省。
   */
  first_use?: FirstUseView
  /** 实验开关此刻各开没开(同上那张卡)。设置里那一节与首页那张卡读它。未接线时缺省。 */
  experiments?: ExperimentsView
  /**
   * 登录台(2026-09-17):就绪检查没全绿。客户端看到它为真就**自动把初始化页打开一次**
   * (可关掉,不弹窗);全绿之后这一格变 false,初始化页不再自己出现。
   *
   * **还没体检过时这一格缺席**,不是 false —— "没查过"和"查过了、没问题"是两件事,
   * 前者不该让界面表现得像后者(D13)。体检本身是节流的,见 server/setup/service.ts。
   */
  setup_required?: boolean
  /**
   * 顶上那几条横幅(2026-09-17 引导入口):还差辅助功能授权 / 还没填 DeepSeek 密钥 /
   * 模型服务还没接上(2026-09-18)。都不拦路:登录和引导照走,横幅只在顶上说一句、给一条去的路。
   *
   * **每一格都可缺席,而且缺席 ≠ false**:前两格读的是上一次体检的结论(还没体检过就没有),
   * 第三格读的是上一次"自动接模型服务"的结论(没跑过、或者他用自己的 Key 时没有)。
   * 两个来源各自成熟得不一样快,所以是逐格合并(server/http.ts 的 setupAlertsNow)——
   * 一边还没有结论时,另一边已经有的那一格照样要说出来。
   */
  setup_alerts?: {
    accessibility?: boolean
    deepseek_key?: boolean
    /**
     * 模型服务(工作台提供的那一份)这会儿**还没接上**(2026-09-18,决策记录同日
     * 「新用户零凭据:模型服务令牌要在注册那一刻自动领」)。
     * 真 = 注册/登录那一刻替他领令牌**试过了、没成**,顶上出一条「模型服务还没接上 → 重试」。
     * 缺席 = 还没试过,或者这件事不归自动化管(他自己填了 DeepSeek Key、或早就接上了)。
     */
    model_service?: boolean
    /**
     * 「缺辅助功能」是哪一种(2026-09-18)。只在 `accessibility` 为真时出现,
     * **缺席一律按 `'unauthorized'` 读**(老服务端、以及"壳没连上、判断不了"那一支)。
     * `'stale_record'` = 系统设置里开关还在、但那条记录对应的是旧签名的壳
     * (TCC 认签名不认路径,见 docs/交接-0918-壳稳定签名.md)。
     */
    accessibility_kind?: 'unauthorized' | 'stale_record'
    /**
     * ★ 「完全磁盘访问」还缺着(2026-10-13,卡「手机看文件时电脑弹 node 的文件夹授权」)。
     *
     * 真 = 体检真探到没给:8791 跑的那条 `~/.dsh/node/bin/node` 列不动只有这项授权才列得动的
     * 目录(EPERM)。后果只有一样,但那一样要紧 —— **手机上看不到电脑上的文件**:
     * 每取一次文件 macOS 就在电脑上弹一个「node 想要访问…」等人点,而她要看文件的场景
     * 恰恰是她不在电脑桌前(维护者 2026-10-13 早:「不解决这个问题,那这个功能就废了」)。
     *
     * **缺席 ≠ false**:还没体检过、或者这台机器上那几条探针目录都不在(判断不了)时缺席 ——
     * 判断不了的时候宁可不说,也不催她去点一个可能已经给过的授权(D13)。
     * 判法与探针的理由见 `server/setup/fullDiskAccess.ts`。
     */
    file_access?: boolean
  }
  /**
   * 热更新(2026-09-18,Ben:「能加热更新的按钮吗,更新完之后重启」)。
   * **读上一次后台检查的结论**(一天真查一次),没查过时整格缺席 —— 同 setup_required 的口径。
   * 齿轮上那个小点只看 `available`,有新版也**不弹窗**。
   */
  update?: UpdateStateView
  /**
   * 电脑这边查到有新的手机包了(2026-09-18)。手机端设置里显示一行「电脑有新版手机包」
   * 加一个下载地址 —— **电脑不代下也代装不了**,手机自己去下、走系统安装。
   */
  update_available_apk?: UpdateApkStateView
  /**
   * 云上那份手机包在哪(2026-09-18「包一律放阿里云服务器」)。跟上一格的区别是**不比版本**:
   * 上一格说「有新的」,这一格说「那个包在哪」—— 手机端设置里「重新下载手机包」用它
   * (装坏了、换了台手机,跟有没有新版没关系)。电脑没查过清单、或者清单里没带手机包时缺席。
   */
  phone_apk?: UpdateCloudApk
  /**
   * 手机才显示的那几格从哪一版手机包起才有(2026-10-09,表在 `src/phoneCells.ts`)。
   * 手机拿自己装的版本比:落后于其中一格、而且 `phone_apk` 更新时,首页提示更新手机端。
   */
  phone_cells?: readonly PhoneCellView[]
  /**
   * 「今天的待办」(2026-10-12):看板事项按 `due` 切出来的今天那一刀,**不另存一份**(切法在 `src/todayTodos.ts`)。
   * 只在自媒体模板下出现;电脑那一格与手机事项页读的是这同一份。缺席 = 不是自媒体模板 / 没接看板。
   */
  today_todos?: TodayTodosView
  /**
   * 这台工作台的名字(2026-09-17 手机登录流程交接第四节 A 条):与 mDNS 广播的那一份**同一来源**,
   * 手机设置页「已登录:工作台 · <主机名>」读它;没配局域网那一段时缺席,手机退回配对时记下的名字、再退回 IP。
   */
  workbench?: { name: string }
  /**
   * 各家客户端扫到没有、接上没有(2026-09-17「每个区域单独解锁」)。
   *
   * **还没扫过时整格缺席**,不是五个 `installed:false` —— 这两件事在界面上的后果正好相反:
   * 缺席时前台退回"全都显示"(跟今天一模一样),而五个 false 会让整个额度面板与窗位清单
   * 空掉。同 `setup_required` 的那条规矩(D13:"没查过"和"查过了、没有"不是一件事)。
   *
   * 扫描是节流的(60 秒一轮,见 server/clientScan.ts):mdfind 一轮五条子命令,
   * 挂在一秒一次的 /state 上就是每秒五个子进程。
   */
  clients?: ClientsView
  /**
   * **这台电脑上装了哪几家 AI**(2026-09-27,卡 HC「不写死各家 AI」)。
   *
   * 维护者在全新 Air(只装了豆包办公与 Codex)上:「顶部栏也是一样,现在还是有 claude 和 kimi,
   * 你要全面检查一遍,每一个人电脑装的东西都不一样,千万不能写死,豆包办公还认不出来呢」。
   *
   * 规矩:**显示与否只看探测,不写死任何一家**。`agents`、额度、派活对象、引导都过 `shownAgentIds`
   * 这一道(server/installedAgents.ts);名字 / 图标 / 读法那张知识表(`FAMILY_SOURCES`)照旧留着,
   * 它只回答「认得出是谁」,不回答「有哪几家」。
   *
   * **还没探过时整格缺席**,不是「一家都没装」—— 缺席时上面那几处退回这一版之前的行为(全都显示)。
   * 同 `clients` 那条纪律(D13:"没查过"和"查过了、没有"不是一件事)。
   */
  installed_agents?: InstalledAgentsView
  /**
   * 有额度的四家各自接没接上(2026-09-25,卡 fix/quota-and-slot-apps)。**只有 DeepSeek、Claude、
   * Codex、Kimi**,微信 / 企业微信永远不在里面。给「球下面那张额度卡」与引导落地(卡 B)的预览用:
   * 一处算好,两处照念。`clients` 还没扫过时整格缺席(同 clients 那条:没查过不等于没有)。
   */
  quota_connect?: QuotaConnectView
  /**
   * 模型从哪儿来(2026-09-17「模型 API 是后面的可选步骤」)。`relay` = 用工作台提供的服务
   * (自家中转),`own` = 用户自己的 DeepSeek Key 直连。**`~/.dsh/workbench/model.json`
   * 不存在时这一格缺席**,额度面板按今天的逻辑照旧渲染。
   *
   * ⚠️ 合并提醒:`model.json` 这个文件归 `feat/model-relay` 那张卡所有(它还要往里放中转地址、
   * 计量口径)。这里只读 `mode` 一个字段,合并时把这一格换成它那份更全的 view 即可。
   */
  model_mode?: 'relay' | 'own'
  /**
   * 这台接没接中转(2026-10-21,零服务器是缺省):`false` = 构建没带、model.json 也没填中转地址 ——
   * 登录中转账号、工作室、出门、热更新那几处都如实说「这台没接中转」,在家功能照常。缺席 = 不知道(老版本 / 用例)。
   * 手机另读 `/channel/route` 的 `relay` 整格缺不缺席,两处同一个判据。
   */
  relay_configured?: boolean
  /**
   * 「先问我」那一档的审批(2026-09-24,统一输入框)。DSH 会话里一次要批准的操作
   * (工作区外写文件、跑一条要批的命令)挂在这里,**档上与手机上都能点**。
   * 缺席 = 没接审批(旧宿主);空表 = 没有在等的。
   */
  approvals?: readonly PendingApprovalView[]
  /**
   * 「这件事里同类的都允许」记下的那几条(2026-09-25,卡 M)。缺席 = 老服务;空表 = 一条都没有。
   */
  approval_grants?: readonly ApprovalGrantView[]
  /**
   * 事务官在 DSH 会话里问他的话(2026-09-25,卡 M)。缺席 = 没接提问(老宿主);空表 = 没有在等的。
   * 电脑球下那一区、手机「等你确认」都从这一格读。
   */
  questions?: readonly PendingQuestionView[]
  /**
   * 「等你」的那一堆(2026-09-25,卡 M 追加;维护者硬规矩「同一件事的数字各处一致」)。
   * 服务端用 `src/waiting.ts` 的 `waitingOnHim` 从这一份快照算好;电脑球下「等你 n」「还有 N 件要你看」、
   * 「事务官」标签上的数、手机「等你确认」那一格**都读这一格**。缺席 = 老服务。
   */
  waiting?: WaitingView
  /**
   * 「此刻有几件在跑」(2026-09-25,卡 V;同上那条硬规矩)。服务端用 `src/running.ts` 的 `runningNow`
   * 从这一份快照算好;舞台「正在执行 n」、球下「执行 n」、窗口槽标签气泡、汇报条「运行会话 n 个」、
   * 手机首页**都读这一格**。缺席 = 老服务(两端用同一个函数就地算)。
   */
  running?: RunningView
  /** Request-time business execution facts. Unlinked/private conversations are outside this scope. */
  execution?: ExecutionOverview
  /**
   * 粒子球此刻的状态(2026-10-04,卡「球的颜色一处算」;同上那条硬规矩)。服务端用 `src/orbCell.ts` 的
   * `orbCellOf` 从这一份快照算好;**电脑首页的球与手机舞台的球都只读这一格**(提示色、在办与否、球下「受阻 N」)。
   * 缺席 = 老服务(两端各自退回本地推算)。见 {@link OrbView}。
   */
  orb?: OrbView
  /**
   * ★ **她问一句、答案送回来放在这儿**(2026-10-04,卡 `claude/answer-comes-to-her`)。
   *
   * 维护者 10-04 原话(经工作台捎话):「我刚给事务官发信息……坏消息是信息直接从正在办切到办完了,
   * 我是自己追过去点开查看的」。从此「问一句」的答案**出现在她提问的那个地方**:
   * 手机球下那一行字幕、电脑事务官页同一处,App 在后台时**通知正文就是答案本身**。
   *
   * 服务端一处算(`src/server/directAnswer.ts` 那本账 + `src/answerCell.ts` 的投影),两端只显示。
   * 缺席 = 老服务(两端照旧现在的样子:那张卡进「办完」里的 `casual` 那一摞)。
   */
  answers?: AnswersView
  /**
   * ★ **刚办完、她还没看过结果的那几件**(同上第 2 条)。办完的事**不直接沉进「办完」**:
   * 首页先挂一张「刚办完 · 结果一句话」,她看过或划掉(`POST /task/seen-result`)才收进去。
   *
   * 服务端一处算(`src/answerCell.ts` 的 `freshResultsOf`),两端只显示;
   * 缺席 = 老服务(照旧:办完的事直接进「办完」那一摞)。
   */
  fresh_results?: FreshResultsView
  /**
   * 页面上最近出的几个错(2026-09-25,卡 V)。事务官在设置里看,统筹 `curl /state` 看。
   * 缺席 = 老服务;空数组 = 接上了、还没出过错。
   */
  client_errors?: readonly ClientErrorView[]
  /**
   * 输入框胶囊上此刻写什么(2026-09-24):粘性的档与模型。**电脑与手机共用一份**。
   * 下拉里的完整表另走 GET /composer/options(点开才拉)。缺席 = 没接输入框服务。
   */
  composer?: ComposerCurrentView
  /**
   * 各家能力体检(2026-09-25,卡 O「派活的眼睛」):六家各三格 —— 能聊天 / 能改本机文件 / 能把结果收回来。
   * **派活与界面共用这一份**(设置、引导落地那张单子、派活挑手都读它)。缺席 = 这台服务没接体检(老宿主)。
   */
  agent_caps?: AgentCapsView
  /**
   * 一件事的花费 / 时长上限(2026-09-25,卡 O):事务官自己在办的那几件,花到这么多钱或跑了这么久就先停下来问他。
   * 设置里可改(`POST /butler/budget`)。缺席 = 没接上限(老宿主)。
   */
  item_budget?: ItemBudgetConfig
  /**
   * 能接活的每一家的额度(2026-09-25,卡 O;统筹:「Muse、Manus、豆包现在额度那里什么都没有」)。
   * 每家落在三格之一(`AgentQuotaState`):有数 / 不限(查实)/ 没接上:原因。额度区在老的四格(DeepSeek、Claude、
   * Codex、Kimi)之外,把这里其余几家各画一行;派活确认点读的也是同一份(`quotaFor`)。缺席 = 老宿主。
   */
  agent_quota?: readonly AgentQuotaView[]
}

// ───────────────────────── 派活的眼睛(2026-09-25,卡 O)─────────────────────────

/**
 * 体检的那几家 = 能接活的里面**有本机应用**的几家(GPT 只走接口、没有本机应用,不在里面)。
 *
 * ★ 2026-09-25(卡 Z):原来它等于写死的白名单 `CLIENT_DISPATCH_FAMILIES`,现在**来自 Agent 登记表**
 * (`server/dispatchTargets.ts` 的 `windowTargets(dispatchTargets(…))`)—— 登记表里新接上一家,
 * 体检表上就多一行,不改一行代码。所以这里是开集。
 */
export type CapFamily = string

export function isCapFamily(value: unknown): value is CapFamily {
  return isClientDispatchFamily(value)
}

/** 三格。 */
export type CapCell = 'chat' | 'edit' | 'collect'
export const CAP_CELLS: readonly CapCell[] = ['chat', 'edit', 'collect']
export const CAP_CELL_TITLES: Readonly<Record<CapCell, string>> = {
  chat: '能聊天',
  edit: '能改本机文件',
  collect: '能把结果收回来',
}

/**
 * 命令行能在指定目录里改文件的那几家(2026-10-22 卡 C 起含 Kimi:Kimi Code CLI 2.2.0 实测可 `-p` 非交互)。
 * **只有这三家**:别家要么没有命令行,要么命令行不是派活用的。
 * ★ 唯一定义在协议层(卡「名片编辑表单重排」挪进来的):服务端(`agentCaps` / `dispatchChoice` / 命令行适配器)
 * 与客户端(名片表单第 3 段显示条件)读同一份,不许各写一份。
 */
export const CODE_CLI_FAMILIES: readonly CapFamily[] = ['claude', 'codex', 'kimi']

export function hasCodeCli(family: string): family is 'claude' | 'codex' | 'kimi' {
  return family === 'claude' || family === 'codex' || family === 'kimi'
}

/**
 * 一格的结论。**`unknown` 与 `no` 是两回事**(D13):没查过 / 这次没查到,不许说成「不行」。
 * `na` = 这家本来就没有这件本事(Kimi 改不了本机文件 —— 不是坏了,是没有),界面画成灰的、不给修法。
 */
export type CapState = 'ok' | 'no' | 'unknown' | 'na'

/**
 * 一键修的那几种。**账号密码工作台一律不经手**:`login_cli` 是替他打开那家**自己的**登录流程
 * (一扇终端窗口跑它自己的登录命令,账号密码在它自己的授权页上填)。
 */
export type CapFixKind = 'login_cli' | 'grant_ax' | 'update_shell'

export interface CapFixView {
  kind: CapFixKind
  family: CapFamily
  /** 按钮上的字(「登录 Claude」「去授权」)。 */
  label: string
  /** 按钮旁边那一句人话(点哪个、在哪点)。 */
  hint?: string
  /** 只能在这台电脑前做(手机上只说一句,不画按钮)。 */
  desk_only?: boolean
}

export interface CapCellView {
  state: CapState
  /** 一句人话:凭什么这么判、行的话是哪只手。 */
  note: string
  /** 这一格靠哪只手成立(行的时候才有)。 */
  via?: DispatchHand
  fix?: CapFixView
}

export interface AgentCapView {
  family: CapFamily
  title: string
  /** 装没装(`undefined` = 查不出来)。 */
  installed?: boolean
  cells: Readonly<Record<CapCell, CapCellView>>
  /** 一整句(「能聊天、能改本机文件(命令行)、能收回结果」/「Claude 能聊天,但改不了你电脑上的文件……」)。 */
  line: string
}

export interface AgentCapsView {
  agents: readonly AgentCapView[]
  /** 上一次体检的时刻(ISO)。没查过就缺席。 */
  checked_at?: string
  /** 正在查。 */
  checking?: boolean
  /** 他点了「登录 X」之后,工作台在等那家登好(每几秒看一眼)。 */
  login_wait?: { family: CapFamily, since: string }
  line: string
}

/**
 * 活的类型。
 * - `code` 写代码 / 改文件;
 * - `chat` 聊天 / 问答 / 写文案 —— 只要一段话,**事务官自己答得了**;
 * - `desk` **要在这台电脑上动手**(打开 / 关掉某个 App、点一下、调亮、截图、放音乐……)
 *   —— 2026-10-02 卡 AG 加的那一类。事务官自己不干活(09-28 拍板),这一类**必须派给能动这台电脑的那一家**;
 *   从前它被当成 `chat`,于是「打开网易云音乐」这种话既派不出去、也没人说一句(Air 0.4.85 现场)。
 */
export type JobKind = 'code' | 'chat' | 'desk'
export const JOB_KIND_TITLES: Readonly<Record<JobKind, string>> = {
  code: '写代码的活',
  chat: '聊天 / 问答的活',
  desk: '要在你电脑上动手的活',
}

export function isJobKind(value: unknown): value is JobKind {
  return value === 'code' || value === 'chat' || value === 'desk'
}

/**
 * 一家的额度此刻落在哪一格(2026-09-25,卡 O;统筹:「额度/余额要覆盖派活名单里的每一家」)。**只有三格**:
 * - `numbers`     有数:剩多少(百分比 / 积分 / 元)、什么时候重置;
 * - `unlimited`   这家本来就不按额度算(**查实过的**,`source` 写出处)→ 界面写「不限」;
 * - `unconnected` 读不到 →「没接上:原因」,能一键接上的带 `fix`。
 * 认不出的 id 一律 `unconnected`「没接上:还没找到这家的额度来源」,不报错、不返回空(`server/agentQuota.ts` `quotaFor`)。
 */
export type AgentQuotaState = 'numbers' | 'unlimited' | 'unconnected'

/** 额度那一格「没接上」时的一键接上。账号密码一律不经手。 */
export interface AgentQuotaFixView {
  /**
   * `grant_ax` 去授权辅助功能;`update_shell` 装新版工作台 App;`unlock` 去设置里接上。
   *
   * ★ 2026-09-30(维护者拍板,见 `docs/决策记录.md` 末尾那一条):**把那家叫到台前的那一档没有了** ——
   * 该他自己去点的那一步,如实写成一句话(进 `line` / `note`),不摆一颗键。
   */
  kind: 'grant_ax' | 'update_shell' | 'unlock'
  label: string
  hint?: string
  /** 只能在这台电脑前做(手机上只说一句,不画按钮)。 */
  desk_only?: boolean
  /**
   * **不用催他的那一档**(2026-09-26 晚,卡 QG)。维护者 22:40:「muse 和豆包办公都已经取到了,
   * 为什么还有那两个按钮啊?」—— 数已经读到了、还不旧,那几颗键就不该
   * 摆在行上当「还差一步」看;可他想立刻再读一次照样得点得到。
   *
   * 所以这一档的键**收进「▸ 说明」里**,只留一颗「再读一次」(`AgentQuotaCells`)。
   * 什么时候打这个记号,由服务端一处定(`agentQuota.ts` 的 `dated`:有数、没标灰就打)——
   * 电脑与手机读的是同一份判断,手机那一侧本来就不画键。
   */
  quiet?: true
}

export interface AgentQuotaView {
  /** agent id(今天 = 派活那一家的名字 / `dsh`)。 */
  id: string
  title: string
  state: AgentQuotaState
  /** 整句人话(额度区那一行):「本周还剩约 62%」「剩 1,234 积分」「不限」「没接上:Manus 没开着」。 */
  line: string
  /** 短一点的同一句(派活确认点括号里用):「没接上:要新版工作台 App」。缺席 = 同 `line`。 */
  short?: string
  /** 有数时:快用完 / 用完了(同 DispatchBalanceView.level 的口径)。 */
  level?: 'ok' | 'low' | 'empty'
  left_pct?: number
  /**
   * 这一家是**窗口型额度**(一个短时段 + 一个长时段,像 Claude 那样):每一扇窗各剩多少。
   *
   * 形状就是老四格那份 `QuotaWindow`(2026-09-26,卡 QD:豆包办公的「当前时段」+「近 7 天」)——
   * **不另造一种形状**,界面据此照老四格那样一扇窗画一条横条(`AgentQuotaCells.tsx`)。
   * 上面的 `line` / `level` / `left_pct` / `reset_at` 仍然说**最紧的那一扇**(派活确认点、手机上那一句
   * 只说一个数),所以这一格缺席时界面照旧只画一条 —— 加字段不改老行为。
   */
  windows?: readonly QuotaWindow[]
  /** 有数时的余量(积分 / 元):「1,234 积分」。 */
  left?: { text: string, unit: string, amount?: number }
  reset_at?: string
  /** 「不限」/ 数字的出处(官方帮助页、那家窗口上哪一格)。 */
  source?: string
  /** 没接上的原因(`line` 里「没接上:」后面那一段)。 */
  why?: string
  fix?: AgentQuotaFixView
  /**
   * 这个数是几点读到的。**有数就该有它**(2026-09-26,卡 QS):没有一家的额度是实时的
   * —— Claude 桌面端十几分钟落一个样本,Manus / Muse 是看它窗口的那一眼 —— 所以界面写
   * 「本周还剩约 69% · 昨晚 20:42 读到的」,不让人以为那是这一秒的数。
   * 超过一刻钟没读到新的才把那句时刻写进 `line`(刚读到的写时刻是噪音)。
   */
  read_at?: string
  /**
   * 这个数**老了**(离 `read_at` 超过 `QUOTA_STALE_AFTER_MS`,见 server/agentQuota.ts)。
   *
   * 2026-09-26(卡 QS;维护者早上:「Claude 的额度怎么突然显示为未接入了」):Claude 桌面端的用量记录
   * 从昨夜 20:42 起没再更新(它没在跑),原来那一格就翻成「没接上」——按第一次用的人看,「没接上」
   * = 从没接上,又吓人又不对。现在读到过的数**照显示**,只是标灰、`line` 里多一句
   * 「Claude 桌面没在跑,数字可能旧」。界面据此把那一格画淡,**不换成别的说法**。
   */
  stale?: boolean
  /**
   * **这一格不许拿上次读到的数顶上来**(同 `UnknownQuota.no_stale` 那条老纪律,2026-09-26 卡 QS):
   * 来源确实断了 / 从没接上 —— 没装、钩子没装、凭据清空了、要先授权。这几种里上次那个数
   * 要么压根不存在,要么是用一份已经不在的来源取的,留着就是在界面上写一句假话(D13)。
   * 服务端一处判(`quotaFor`),界面不读它。
   */
  no_stale?: boolean
  /**
   * 过线那一格该多说哪两句、入口指向哪(2026-10-02,卡 QK)。**由各家额度来源自己声明**
   * (`quota/liveSources.ts` 一处;老四家经采集层盖在 entry 上,`numbersFromEntry` 原样带过来)。
   *
   * `line` 里已经把这两句拼好了(手机、电话念的就是它);这一格另给一份是为了那颗**入口键** ——
   * 电脑上要按 `live.fix.at` 把她送到设置里那一行,手机与展示台只念那句话。
   * 缺席 = 这一家没什么可多说的(从窗口上读的那几家今天都是这一格)。
   */
  stale_hint?: QuotaStaleHint
}

/** 一家此刻还剩多少额度(派活确认点里那一句)。 */
export interface DispatchBalanceView {
  read_at?: string
  /** `unknown` = 读不到(不装作知道)。「不限」算 `ok`。 */
  level: 'ok' | 'low' | 'empty' | 'unknown'
  /** 「本周还剩约 62%」「5 小时窗口只剩约 9%,快用完了」「不限」「没接上:要新版工作台 App」。 */
  text: string
  /** 三格里的哪一格(2026-09-25 起;缺席 = 老宿主,按 level 读)。 */
  state?: AgentQuotaState
  left_pct?: number
  reset_at?: string
  /** 没接上时的一键接上。 */
  fix?: AgentQuotaFixView
  /** 这个数是上次读到的、而且已经老了(同 `AgentQuotaView.stale`):`text` 里带着时刻与那一句,界面画淡。 */
  stale?: boolean
}

/**
 * 派活选项里的一家。**只有别家**:「事务官自己做」那一项 2026-09-28(卡 BS2,设计 C1)拿掉了,
 * 于是这里再也没有 `dsh`。
 */
export interface DispatchChoiceView {
  family: AgentDispatchFamily
  title: string
  /** 这会儿派得出去。 */
  ok: boolean
  /** 派出去用哪只手(写代码的活一律是能改本机文件的那只)。 */
  hand?: DispatchHand
  /** 派不出去 / 要注意的那一句。 */
  why?: string
  fix?: CapFixView
  balance?: DispatchBalanceView
  /** 按规矩选的默认项。 */
  recommended?: boolean
}

/**
 * 默认那家从哪来(2026-10-12,电话里只在拿不准时先确认):她点的名 / 学出来的默认分派 / 规矩里这个项目归谁 /
 * 规矩里这一类活归谁 / 只是挑了第一家能做的(或者额度用完换了一家)。电话里「没说派给谁」要不要问看它(`callAsk.ts`)。
 */
export type DispatchDefaultFrom = 'named' | 'learned' | 'project_rule' | 'rule' | 'fallback'

export interface DispatchChoicesView {
  kind: JobKind
  kind_why: string
  /** 按规矩该派谁。**挑不到一家时缺席**(卡 BS2:没有「事务官自己做」那一项兜底了),理由在 `default_why`。 */
  default?: AgentDispatchFamily
  /** 默认那家从哪来。`default` 缺席时也缺席。 */
  default_from?: DispatchDefaultFrom
  default_why: string
  options: readonly DispatchChoiceView[]
  /** 确认点里原样用的那一句(「写代码的活 → 派给 Claude(本周还剩约 62%)」)。 */
  line: string
}

/**
 * 派活挑不到能做这件活的手(2026-09-25,卡 O):**不假装派出去**。卡挂「阻塞」,这一格说清为什么、
 * 给修法与能换的几家;界面据此画「登录 Claude」「换 Codex 来做」。
 */
/**
 * ★ **这一件在那一家窗口通道里的处境**(2026-10-21,卡「派活按家隔离」;只由服务端写,`dispatchRun.ts`)。
 *
 * 窗口型那几家同一时刻只送一件:后来的那件**排在前一件后面**,卡上写明排在谁后面;
 * 正在送的那一下也落盘(插件中途被杀,重启后据此核一眼送没送进去 —— 不丢、也不送第二遍);
 * 读窗超了硬上限的那一家,卡上写「通道堵了」那一句(哪家、哪一步、等了多久)。
 */
export interface TaskDispatchLane {
  family: AgentDispatchFamily
  /** `queued` 排着;`sending` 正在送;`jammed` 送出去了、在等回话,可那扇窗这会儿读不动。 */
  state: 'queued' | 'sending' | 'jammed'
  since: string
  /** 卡上那一句人话。 */
  note: string
  /** 排在哪一件后面(事项 id)。 */
  behind?: string
  /** 读不动卡在哪一步、等了多久(`jammed`)。 */
  step?: string
  waited_ms?: number
  /** 派活那一次的交代(排着的那件轮到了 / 重启之后照它接着派)。 */
  input?: TaskDispatchLaneInput
  /** 正在送的那一段的记号与全文(`sending`:重启后核一眼它露面没有)。 */
  marker?: string
  text?: string
}

export interface TaskDispatchLaneInput {
  resume?: true
  said: string
  cwd?: string
  cwd_fixed?: boolean
  project?: string
  kind?: JobKind
  submit?: boolean
  skills?: readonly string[]
}

export interface TaskDispatchBlock {
  family: AgentDispatchFamily
  kind: JobKind
  why: string
  fix?: CapFixView
  /** 能换的几家。**只有别家**(卡 BS2:「事务官自己做」拿掉了)。 */
  alternatives?: readonly { family: AgentDispatchFamily, title: string, note?: string }[]
  /**
   * ★ **在等她解锁电脑**(2026-10-12,卡「锁屏派活排队」):电脑锁着屏、窗口型的家送不进,
   * 这件派活**真排进了队**,解锁后自动重派、回到正常流程。电脑与手机据此把「等你处理」说成 {@link UNLOCK_WAIT_LABEL}。
   * 缺席 = 不是这一种(没排上的锁屏照旧只有那句 note:「解锁了再叫我一次」)。
   */
  unlock?: true
  at: string
}

/** 卡挂着「在等你解锁电脑」时那一格的字(电脑卡片与手机事项页同一句;手机那份副本有对照用例)。 */
export const UNLOCK_WAIT_LABEL = '等你解锁电脑(解锁就送)'

/** 卡上「卡在哪」那一格的字:排着等解锁的派活说 {@link UNLOCK_WAIT_LABEL},别的照 `block_reason`。没有就不标。 */
export function taskWaitLabel(task: { block_reason?: WaitReason, dispatch_block?: { unlock?: true } }): string | undefined {
  if (task.dispatch_block?.unlock === true) return UNLOCK_WAIT_LABEL
  return task.block_reason === undefined ? undefined : WAIT_REASON_TITLES[task.block_reason]
}

/** 一件事花费 / 时长上限的配置(元、分钟;先到哪个算哪个)。 */
export interface ItemBudgetConfig {
  cny: number
  minutes: number
}

export const DEFAULT_ITEM_BUDGET: ItemBudgetConfig = { cny: 0.5, minutes: 10 }

/**
 * **命令行那件活的时长上限缺省(分钟)**(2026-10-23,卡「派活给名片的四处」③):名片没写
 * `budget.minutes` 时,派给命令行家的活按这一档停(写代码的卡 30–90 分钟是常态,全局设置里那
 * 10 分钟把第一张卡读到一半就停了)。只管命令行那只手;窗口家没有这条线,事务官自己在办的那几件
 * 仍看 `DEFAULT_ITEM_BUDGET`(设置里「每件事的上限」)。
 */
export const CARD_CLI_BUDGET_MINUTES = 120

/**
 * 一件事此刻花了多少、上限多少(事务官自己在办、卡上挂着 DSH 会话的那几件)。
 * `state`:`running` 在跑 / `paused` 到上限先停下来了、等他说继续还是停 / `stopped` 他停掉了。
 */
export interface TaskBudgetView {
  limit_cny: number
  limit_minutes: number
  /**
   * ★ **不再用**(2026-10-04,卡「事务官上限只看钱」)。
   *
   * 原来是「这一件最多走几步」(2026-09-28 卡 BS2)。10-04 维护者拍板**去掉步数线**,
   * 只留钱(时间保留现状)—— 那次事故三轮全是撞步数线停的,钱一次都没到。
   *
   * 这一格**只为老数据留着**:`tasks.ts` 的 `sanitizeBudget` 照旧收得下、落盘里老卡不坏,
   * 但工作台既不判它、也不再写它(`itemBudget.budgetVerdict` 不把它放进视图)。
   * 「走了 N 步」这个事实照旧在 `requests` 里。
   */
  limit_steps?: number
  /** 那条会话到现在花了约多少元(工作台模型服务的价目算的;读不到就缺席)。 */
  spent_cny?: number
  /** 那条会话**在跑**的分钟数(等他批 / 等他回话不算)。 */
  run_minutes?: number
  /** 调了几次模型。 */
  requests?: number
  model?: string
  state: 'running' | 'paused' | 'stopped'
  /** 他说了几次「继续」(每次加一档)。 */
  extended?: number
  note?: string
  paused_at?: string
  /** 到上限停下来时「换 X 来做」那一家的名字(挑手挑的:写代码的活里第一家派得出去的)。 */
  switch_to?: string
  /**
   * 这一格管的是**派给那家命令行的活**(统筹 09-25 拍板 ③:跟事务官自己做的同一份上限,只管时间 ——
   * 命令行花的是那家自己的额度,不是工作台的钱)。缺席 = 事务官自己在办的那种(钱 + 时间)。
   */
  cli_family?: AgentDispatchFamily
  /**
   * **事务官自己报的「我卡在哪」**(2026-10-04,卡「事务官上限只看钱」;维护者第 2 条)。
   *
   * 一句人话:「我在找 X,试了 A、B,还差 C」。它在干活的过程里随时报(`POST /butler/item/stuck`),
   * 这里只留**最后一句**;到上限停下来那一刻工作台把它原样放进问她那一句里
   * (`budgetPolicy.budgetAskLine`,手机 / 电话 / 电脑三处同一句)。
   *
   * **缺席 = 它没说**,那一问里就照实写「它没说卡在哪」——不编一个原因(D13)。
   * 她点「继续」时这一格清掉:上一轮的卡点过期了,留着会拿旧话当新话用。
   */
  stuck?: string
  /** 上面那一句是什么时候报的(ISO)。 */
  stuck_at?: string
}

export interface ComposerCurrentView {
  mode: ComposerMode
  model?: { provider: string, id: string, title: string, images: boolean }
}

/** WS /live 推给展示台的消息。 */
export type LiveMessage =
  | { kind: 'snapshot', state: WorkbenchState }
  | { kind: 'event', event: WorkbenchEvent }
  | { kind: 'ring', session_id: string, agent: AgentId }
  | {
    /**
     * 话机（树莓派+POP）的摘挂机动向，工作台从 POST /phone/event 原样翻出来。
     * 展示台靠 offhook/missed 停铃（来电链 v0，见 docs/设计-来电链-v0.md）。
     */
    kind: 'call'
    phase: PhoneEventType
    agent: AgentId
    session_id: string
  }
  /**
   * 心跳。**必须是应用层消息，不能只靠 WS 协议层的 ping 帧**——浏览器会自动回 pong，
   * 但既不把 ping 也不把 pong 暴露给 JS，展示台那边的看门狗根本看不见协议层心跳。
   * 协议层 ping 仍要发，那是给服务端自己用的：pong 不回来就说明这条连接已经死了。
   */
  | { kind: 'ping', ts: number }
  /**
   * 拖拽悬停进出圈信号（悬停高亮 v1，附加能力，非核心协议扩展）：壳的 AXObserver 原始
   * 回调（300ms 落定去抖之前）在悬停圈内外跳变那一刻推 hover 事件，workbench-plugin
   * 客户端订这条 WS 原样点亮/熄灭槽体的虚线高亮——页面 1s 轮询做不了这种实时反馈。
   * display-client 副本本期不同步；它若按 kind 分发且对未知 kind 只是忽略，不受影响；
   * 若其解析器对未知 kind 告警，那属于可接受的噪音，不是本条消息的责任。
   *
   * 2026-09-25(卡 P)起**悬停只亮那句提示字,不亮光**:壳对程序化挪窗也报进圈(点标签切换、应用自己缩放、
   * 截图把藏着的应用放出来),维护者看到的是「窗口槽的流线光效时不时自己闪一下,其实没拖新应用进去」。
   * 光改绑「放下」这个动作,见下面 `slot_drop`。`native` 这一格老服务还会带,新服务不再发。
   */
  | { kind: 'hover', inside: boolean, native?: boolean }
  /**
   * 他真把一个**新**应用拖进窗口槽、放手那一下(2026-09-25,卡 P)。窗口槽那圈流线光**只在这一下**亮一轮。
   * `native` = 壳已经在槽的屏幕矩形上亮了原生光圈(压在所有应用窗之上),页面不再画自己那圈;
   * 缺席 = 原生那圈没亮成(老壳、壳没连、矩形未知),页面自己的 border-beam 亮一轮顶上。
   */
  | { kind: 'slot_drop', native?: boolean }
  /**
   * 他点了系统通知「事务官有话问你 / 要你批一件事」(2026-09-25,卡 M):壳把他带回前台,
   * 页面据此切到事务官那一档、把那一张摊开。`key` 是 `question:<id>` / `approval:<id>`。
   */
  | { kind: 'focus_ask', key: string }
  /**
   * 事务官(或别的程序)动了哪一块,页面在那一块旁边出**一行字**(2026-09-25 卡 P 补三,见 ActorNote)。
   * 没有光、没有圈 —— 流线光只属于他亲手把新应用拖进窗口槽、松手那一下(`slot_drop`)。
   */
  | { kind: 'actor_note', note: ActorNote }
  /** 把页面上还挂着的那几行字都收掉(`POST /highlight {region:null}`)。 */
  | { kind: 'actor_note_clear' }
  /**
   * 协作区板上的一个光标(2026-10-21):Agent 小鼠标由任务账的事件推({@link CollabPresence})。
   * **不进快照、不落盘**:它是即时画面,不是事实;断了就没。
   */
  | { kind: 'presence', presence: CollabPresence }

/** 程序动的是哪一块:窗口槽 / 文件区 / 看板(任务卡所在的那一块)。 */
export type ActorNoteRegion = 'slot' | 'files' | 'board'

/**
 * 「事务官正在挪任务卡的状态」这类一行字(2026-09-25 卡 P 补三)。
 *
 * 维护者 0.3.1 截图:「看到红框里的东西了吗,好像是个新bug」—— 工作台左上角冒出一行「事务官正在挪任务卡的状态」
 * 外加一圈光框,框住的是标题、顶栏和窗口槽上半截,任务卡却在右边的看板里。根因:服务端按布局参数重算了一遍
 * 「看板在哪」,跟页面实际的样子漂了,再让壳在那个算出来的矩形上画。统筹定:**程序做的动作一律只出一行字,
 * 不出流线光、不出光圈;那行字由页面自己画,挂在真实的元素上**(看板动作挂那张卡或项目区,文件动作挂文件区,
 * 窗口槽动作挂窗口槽);元素看不见(纯净模式、模块收起)就不画。服务端只广播「哪个动作、哪张卡、一句话」。
 */
export interface ActorNote {
  /** 哪个动作(`dock.switch` / `task.move` / `files.pin` …;事务官手动指一下那口是 `point`)。 */
  action: string
  region: ActorNoteRegion
  /** 看板动作挂在哪张卡上:有就挂那张卡;没有(建事项)或那张卡不在页面上就挂任务所在的那一块。 */
  task_id?: string
  /** 那一行字。 */
  text: string
  /** 这一行留多久(毫秒)。动作跑得久,服务端每半个时长再发一条续上;动作做完再发一条,让字在做完之后还留一会儿。 */
  ttl_ms: number
}

/** 提醒分档（PRD §7.1）。展示台不做判断，档位由工作台算好推过去。 */
export type AlertTier = 'ring' | 'turn' | 'light' | 'quiet'

/** 「等你确认」持续超过该秒数才响铃（PRD §7.1）。 */
export const RING_AFTER_SEC = 180

/** 同一会话重复响铃的最小间隔（PRD §7.2），防止铃声疲劳。 */
export const RING_COOLDOWN_SEC = 600

/** —— v5 项目区(spec D1–D14)。以下均为新增可选字段,display-client 副本本期不同步。 —— */
export type ProjectStage = '市场调研' | '项目策划' | '需求梳理' | 'MVP 开发' | 'MVP 验证' | '待整理'
/** 「算」行:机器信号,每次扫描重算,永不落盘(spec D3)。 */
export interface RepoSignals {
  branch: string
  dirty_count: number
  worktrees: number
  cleanup_count: number
  last_commit_at?: string
  idle_days: number
  /**
   * 本地分支名清单(`git for-each-ref refs/heads`,2026-09-09 任务卡挂交付物用):
   * 「交付物 = 某条分支」那一格要能从下拉里挑,而不是手敲一串 `claude/xxx-yyy`。
   * worktree 的分支也在这里(共用同一份 refs)。取不到就缺席,界面退回手敲;**不落盘**,
   * 与本结构其余字段同一条纪律(每次扫描重算)。
   */
  branches?: readonly string[]
  /**
   * 排期风险窗口(RISK_WINDOW_DAYS)内的提交次数(2026-09-09 排期风险)。
   * 项目没有任务卡时,这是唯一能说明「还在动没有」的数字;拿不到(rev-list 失败)就缺省,不填 0(D13)。
   */
  recent_commits?: number
}

/** 目录规则的动作:归到某项目 / 忽略 / 标记「不是我的」(spec D5/D7)。 */
export type RuleAction = 'project' | 'ignore' | 'not_mine'
/** 一条目录归属规则,一次生效对同前缀下的 cwd 永久有效,优先于 pending(spec D7)。 */
export interface DirRule {
  dir: string
  action: RuleAction
  projectId?: string
}
/** 待归档目录聚类结果的一组(spec D5)。 */
export interface PendingGroup {
  dir: string
  count: number
  first_at?: string
  last_at?: string
}

/** 「状态」行(spec D3):人写、带署名日期,过期只标记不自动改写。 */
export interface ProjectStatusLine {
  text: string
  review: 'confirmed' | 'suggested'
  author: string
  updated_at: string
  stale: boolean
}

/** DDL(spec D10):日历只是投影,DDL 本体存在项目状态里,不另建清单。 */
export interface ProjectDdl {
  date: string
  title: string
}

/**
 * 排期风险的四档(2026-09-09,项目经理层「按当前速度 vs 截止日」;决策记录 2026-09-09 傍晚拍板第 6 条)。
 *
 * - `ample`   宽裕:按最近的完成速度,截止前做得完,还有余量
 * - `tight`   紧:做得完,但余量很小
 * - `late`    赶不上:按当前速度到截止日做不完,或截止日已过而活还没干完
 * - `unknown` 无法判断:没有截止日 / 没有任务卡 / 速度算不出——**数据不够就是无法判断,不编**(D13)
 *
 * 算法是服务端纯函数(server/scheduleRisk.ts),客户端只显示。速度口径与窗口天数见那边的头注释。
 */
export type ScheduleRiskLevel = 'ample' | 'tight' | 'late' | 'unknown'

export const SCHEDULE_RISK_LEVELS: readonly ScheduleRiskLevel[] = ['ample', 'tight', 'late', 'unknown']

/** 四档的中文名。放 protocol 而不是客户端:事件 summary(服务端)与界面(客户端)要说同一个词。 */
export const SCHEDULE_RISK_TITLES: Record<ScheduleRiskLevel, string> = {
  ample: '宽裕',
  tight: '紧',
  late: '赶不上',
  unknown: '无法判断',
}

/**
 * 「宽裕 · 预计 9-19 做完」这一小段。**放在 protocol 而不是某个客户端文件**:
 * 项目行、看板列头、冲刺条三处都要说同一句话,各写一份迟早会漂(同 STATUS_TITLES 的理由)。
 *
 * 算不出预计完成日时**只留等级那半句**:没有就是没有,不写「预计 —」也不写
 * 「预计 undefined」(D13)。
 */
export function scheduleRiskText(risk: ScheduleRisk): string {
  const level = SCHEDULE_RISK_TITLES[risk.level]
  if (risk.eta === undefined) return level
  const [, month, day] = /^\d{4}-(\d{2})-(\d{2})/.exec(risk.eta) ?? []
  const when = month === undefined || day === undefined ? risk.eta : `${Number(month)}-${Number(day)}`
  return `${level} · 预计 ${when} 做完`
}

/**
 * 一条排期风险判断。挂在项目行(WorkbenchProject.risk)与冲刺(SprintView.risk)上,同一口径。
 * 每次组装 /state 现算、永不落盘(与 RepoSignals 同一条纪律:落盘的判断会和真实进度漂移)。
 */
export interface ScheduleRisk {
  level: ScheduleRiskLevel
  /** 按当前速度预计完成日(YYYY-MM-DD)。算不出就缺省,界面不显示,不填占位日期。 */
  eta?: string
  /** 一句能直接显示的依据(「按最近 14 天 3 条的速度,剩 5 条约 24 天做完,截止只剩 10 天」)。 */
  reason: string
  /** 速度窗口(天)。写进来是为了界面 title 里能把口径说全。 */
  window_days: number
  /** 窗口内完成的条数。没有任务卡时缺省。 */
  done_recent?: number
  /** 还没完成的条数(不含取消)。没有任务卡时缺省。 */
  remaining?: number
}

/**
 * 项目区这一格里的数据从哪来(2026-09-21)。
 *
 * - `'git'`:扫描根下的 git 仓库(做产品模板,现状)
 * - `'accounts'`:工作目录下 `账号/<名>/` 那些文件夹(自媒体运营模板)
 *
 * **放在 protocol.ts 而不是 server/projectSource.ts**:`src/templates.ts` 要用它给
 * `WorkbenchTemplate.project_source` 标类型,而 templates.ts 是客户端与服务端共用的那一层,
 * 它不该 import 任何 `server/` 里的东西(哪怕只是个类型)。接口本身(list / summary / detail,
 * 带着读盘的语义)仍然在 `server/projectSource.ts` —— 那是服务端的事。
 */
export const PROJECT_SOURCE_IDS = ['git', 'accounts'] as const
export type ProjectSourceId = typeof PROJECT_SOURCE_IDS[number]

/**
 * 账号数据源那一支的「算」信号(2026-09-21「项目数据源」那张卡)。
 *
 * 与 `RepoSignals` 平级、**互斥**:一个项目要么是 git 扫出来的仓库,要么是工作目录下
 * 「账号/<名>/」那个文件夹。哪一支由**当前模板的 `project_source`** 决定,不是靠猜。
 *
 * 纪律与 RepoSignals 完全一样:**每次扫描重算,永不落盘**。落盘的信号会和盘上的真实
 * 文件夹漂移,然后开始骗人。
 *
 * 「拿不到就缺席,不填 0」这条在这里格外要紧 —— `note_count: 0` 说的是"笔记文件夹是空的"
 * (这是真话),而 `open_tasks` 缺席说的是"没接看板,数不出来",两件事不许长成同一个 0。
 */
export interface AccountSignals {
  /** 平台(小红书 / 抖音 / …)。`账号.md` 里没写就缺席,界面留白,**不猜一个**。 */
  platform?: string
  /** `笔记/` 里有几条。文件夹不存在也是 0 —— 这一条是真话,不是"数不出来"。 */
  note_count: number
  /** 最近一条笔记的日期(YYYY-MM-DD)。一条笔记都没有就缺席。 */
  last_note_at?: string
  /**
   * 这个账号名下还没做完的事项数(backlog / todo / doing / confirm / blocked)。
   * **没接看板时整个缺席,不填 0** —— 「一件都没有」和「数不出来」是两回事(D13)。
   */
  open_tasks?: number
  /** 开号日期(`账号.md` 里的那一行,原样)。没写就缺席。 */
  opened_at?: string
  /** 最近一条笔记到现在几天。一条笔记都没有就缺席(不是 0:那会显示成"今天有笔记")。 */
  idle_days?: number
}

/**
 * 项目行展开之后、数据源自己多说的那几行(2026-09-21)。
 *
 * git 那一支是**空的** —— 它展开后的「零散 / DDL」两行来自 `projects.json`,跟数据源无关。
 * 账号那一支放的是 `账号.md` 里的定位 / 风格 / 人群 / 平台 / 开号日期。
 */
export interface ProjectDetailLine {
  label: string
  text: string
}

/** 工作台展示用的项目行:算/状态/零散/DDL 四层的合并视图(spec D3/D4)。 */
export interface WorkbenchProject {
  id: string
  name: string
  stage: ProjectStage
  path?: string
  signals?: RepoSignals
  /**
   * 账号数据源那一支的「算」信号(2026-09-21)。**与 `signals` 互斥**:同一个快照里
   * 一个项目行上只会有其中一个,因为一台工作台同一时刻只跑一个数据源(模板决定哪个)。
   */
  account?: AccountSignals
  /** 数据源在展开那一层多说的几行。git 那一支恒为空,所以整块缺席。 */
  detail?: readonly ProjectDetailLine[]
  signal_error?: string
  status?: ProjectStatusLine
  ddl?: ProjectDdl
  links: readonly string[]
  session_count: number
  idle: boolean
  /** 排期风险(2026-09-09)。服务端组装 /state 时现算;没接任务板时缺省。 */
  risk?: ScheduleRisk
  /**
   * 他确认过的项目(2026-09-25,卡 feat/first-look-orb-top):**在 `projects.json` 里的那几个**
   * (引导里他点头录的、落地时建的、他手动整理过的)。扫描自动发现的仓库不带它 ——
   * 项目区总览与看板页签只排带它的,其余收进「其他仓库(N)」。缺席 = 扫到的,不是他确认的。
   */
  confirmed?: true
}

/**
 * 「图谱」那一格的状态(2026-10-23,卡「系统文件夹改成Graphify图谱」)。
 * 独立端点 GET /graphify/status 现取:installed = uv 在 + graphifyy 那套环境热好了
 * (--offline 探针),generatedAt 是产物根里 meta.json 的那一行(读不到 = null),
 * hasHtml 是同一份 meta 里的(超过 5000 节点的那次只有 json 和报告,没有可嵌的页面),
 * running 是此刻有没有这个项目的 build 在跑。
 */
export interface GraphifyStatusView {
  installed: boolean
  generatedAt: number | null
  hasHtml: boolean
  running: boolean
}

/**
 * Graphify 的一次安装/生成作业(2026-10-23,卡「系统文件夹改成Graphify图谱」)。
 * 内存态,服务重启就没了;界面拿 jobId 轮询,状态落在 error 上的那一格如实显示原因。
 * stage 是生成 pipeline 最后一个完成的阶段(detect/extract/build/cluster/report/export),
 * 界面拿来把「正在生成…」说到实处。
 */
export interface GraphifyJobView {
  id: string
  status: 'running' | 'done' | 'error'
  startedAt: number
  finishedAt?: number
  error?: string
  stage?: string
}

/**
 * Archify 单张架构图视图(2026-10-23,卡「图谱显示修复与Archify产品图接入」)。
 */
export interface ArchifyDiagramView {
  id: string
  name: string
  type: string
  pinnedCommit?: string | undefined
  generatedAt?: number | undefined
  hasHtml: boolean
  hasSpec: boolean
}

/**
 * Archify 状态视图(2026-10-23,卡「图谱显示修复与Archify产品图接入」)。
 */
export interface ArchifyStatusView {
  projectId: string
  hasDiagrams: boolean
  pinnedCommit?: string | undefined
  sourceNote?: string | undefined
  diagrams: readonly ArchifyDiagramView[]
  selectedDiagramId?: string | undefined
}

/**
 * 随手记一条(PRD §5.5:一个框,不分类不打标签,所以只有这三个字段)。
 * 2026-08-25 版面重排起服务端落盘(server/notes.ts)——在此之前它只活在前端内存里,
 * 刷新一下就全没了,"跳走前按一下"这个用法根本不成立。
 */
export interface NoteView { id: string, text: string, created_at: string }

/** —— 哨兵(2026-09-09,借鉴 dsh-sentinel 的设计,不装它)。 —— */

/**
 * 传感器四类。**`command` 不在其中,而且是拍板不做**:被借鉴的那个插件正是靠
 * `command` 类按间隔执行任意 shell 行、且源码里没有任何权限门,才被判定为不装
 * (docs/superpowers/research/审计-dsh-sentinel-2026-09-09.md)。
 */
export type SensorKind = 'file' | 'http' | 'process' | 'port'

export const SENSOR_KINDS: readonly SensorKind[] = ['file', 'http', 'process', 'port']

/** 一条「在盯着的事」。 */
export interface SentinelWatch {
  id: string
  kind: SensorKind
  /** 盯什么:file=路径、http=URL、process=pgrep 模式、port=`host:port` 或光一个端口。 */
  target: string
  /** 触发时对人说的那一句话。必填——没话可说的监视项没有意义。 */
  note: string
  /** 最短探测间隔(秒)。 */
  interval_sec: number
  /** 两次触发之间的最短间隔(秒),防唤醒疲劳,语义同 RING_COOLDOWN_SEC。 */
  cooldown_sec: number
  /** 触发多少次之后自动收工。缺省即不限次。 */
  max_fires?: number
  /** 到这个时刻之后自动收工。缺省即不设期限。 */
  expires_at?: string
  created_at: string
  /** 已经触发过几次。 */
  fires: number
  last_checked_at?: string
  last_fired_at?: string
  /** 最近一次变化的人话描述(也用来记"刚开始盯"「冷却中,没喊」这类实况)。 */
  last_change?: string
  /** 收工了(次数用尽或已到期),不再探。 */
  done?: boolean
  /** 最近一次探测失败的原因。探不到就如实记,绝不当成变化去触发(D13)。 */
  error?: string
}

/** GET /state 哨兵整块。 */
export interface SentinelView { watches: readonly SentinelWatch[] }

/** GET /state 项目区整块(spec §6)。 */
export interface ProjectsState {
  projects: readonly WorkbenchProject[]
  pending: readonly PendingGroup[]
  scan_errors: readonly { root: string, reason: string }[]
  scanned_at: string
  /**
   * 项目区这一回**没去看他的目录**,为什么(2026-09-23)。人话,界面照它说,比如
   * 「还没授权看你的项目目录」。有它时 `projects` 里只有已经落盘的(引导里他亲口交的那几个)。
   */
  scan_blocked?: string
}

/** 自定义布局(spec D12)单个模块的顺序/篇幅/显隐。 */
export interface LayoutModule {
  id: string
  order: number
  basis_pct?: number
  hidden?: boolean
  /**
   * 行号。同一行号的模块并排渲染(2026-08-25 顶部分栏)。
   * 缺省视为独占一行——旧存档没有这个字段,读进来行为与从前一致。
   */
  row?: number
  /** 该行内的宽度占比。同行的**列**按此切宽;缺省时该行内均分。 */
  width_pct?: number
  /**
   * 列号(2026-08-25 右侧上下堆叠)。同一行内、列号相同的模块**竖向堆叠成一列**;
   * 缺省视为各占一列。宽度看该列第一个模块的 width_pct,列内高度按各自 basis_pct 分。
   */
  col?: number
  /**
   * 横屏下这个模块待在哪个区域(2026-09-20「横屏模块挪区」)。**只在 landscape 分支里有意义**,
   * 竖屏那一份(顶层 modules)读都不读它。
   *
   * - `'deck'`:底部那一排(横排,左→右);
   * - `'side'`:右侧栏(竖排,项目区之下,上→下)。
   *
   * **additive 可选,缺席 = `'deck'`** —— 2026-09-18 那一版横屏存档里四个模块全在底部一排,
   * 不带这个键;读进来仍然全在底部,一格不挪(旧存档不迁移、不报错)。
   * 窗位槽(中间大区)与项目区(右侧栏最上那一格)位置固定,不带这个键也不读它。
   */
  region?: 'deck' | 'side'
  /**
   * 横屏右侧栏里这一格占整条侧栏高度的比例(2026-09-20)。**只在 region='side' 时有意义**
   * (以及项目区——它恒在侧栏最上)。走的是 flex-grow:几个数之比就是高度之比,
   * 和不必等于 100(同底部一排的 width_pct,见 client/Workbench.tsx renderModule 的 grow)。
   *
   * additive 可选,缺席时用 client/layout.ts 的默认值(项目区 50,别的模块 25),
   * 也就是"项目区占大头、下面每格占一小格"那个第一眼的样子。
   */
  side_pct?: number
}

/** 横屏下可以放模块的两个区域(2026-09-20)。客户端与服务端共用同一份字面量(同 F1)。 */
export const LANDSCAPE_REGIONS = ['deck', 'side'] as const
export type LandscapeRegion = typeof LANDSCAPE_REGIONS[number]

/**
 * 横屏右侧栏里单格高度占比的上下限(2026-09-20)。理由同底部单格那条 10%:
 * 低于 14 只剩一条标题栏,格子在那儿但读不出任何东西,而"让一格消失"应该走「收起」;
 * 上限 80 是给同栏别的格子留下至少一条能抓回来的边。
 *
 * 放在 protocol.ts 的理由同 LANDSCAPE_RAIL_MIN_PCT:**服务端 parseLayout 也要夹同一个区间**
 * ——客户端拖拽夹过一遍,直接拼 JSON 打 /layout 能绕过去。
 */
export const LANDSCAPE_SIDE_MIN_PCT = 14
export const LANDSCAPE_SIDE_MAX_PCT = 80

/**
 * 事务官浮窗的最小尺寸(px)。取"标题栏 + 「全部暂停」「试铃」并排一行"所需的尺寸——
 * 不可改清单第 1 条(AI 悬浮窗必须永远有叫停入口)在"浮窗可拉伸"之下的直接体现:
 * 比这个再小,按钮就被挤出可视区了。放在 protocol.ts 而不是客户端某处,是因为
 * 服务端 parseLayout 的读路径也要用同一份下限(见 http.ts)。
 *
 * 展开态最小尺寸按 ButlerInbox 最窄可用布局量出(520 × 680),收起态为一颗直径 96px 的球。
 */
export const MIN_BUTLER_W_PX = 520
export const MIN_BUTLER_H_PX = 680
export const BUTLER_BALL_DIAMETER_PX = 96

/**
 * 横屏左栏(窗位应用栏)宽度的上下限,占整条上半区的百分比(2026-09-18 分栏把手)。
 *
 * 放在 protocol.ts 而不是客户端某处,理由同上面那两个常量:**服务端 parseLayout 的
 * 写路径也要夹同一个区间**。客户端拖拽已经夹过一遍,但直接拼 JSON 打 /layout 能绕过
 * 客户端,存进一个把左栏挤成一条灰缝(或者把中间贴窗区吃掉大半)的值,下次打开就是
 * 一个自己拖不回来的界面——同 butler.size 下限那条纪律:客户端函数层的夹只在客户端生效。
 *
 * 取值理由(5:2560 宽上是 128px,标签名开始省略号但还认得出是哪个应用;30:再宽中间
 * 那块贴窗区就开始亏)见 client/layout.ts 的 LANDSCAPE_RAIL_MIN_PCT 注释。
 */
export const LANDSCAPE_RAIL_MIN_PCT = 5
export const LANDSCAPE_RAIL_MAX_PCT = 30

/** 布局整体:模块列表 + 事务官浮窗位置(不可删,可移动收小,spec D11)。 */
export interface WorkbenchLayout {
  modules: readonly LayoutModule[]
  butler: {
    corner: 'br' | 'bl' | 'tr' | 'tl'
    min: boolean
    /**
     * A6:事务官浮窗可拖动。百分比坐标(视口宽/高的百分比,clamp 0–95),additive 可选字段——
     * 设了就覆盖 corner 的角落定位,不设时退回 corner(向后兼容旧存档,拖过一次之前的布局
     * 没有这个字段)。「全部暂停」和浮窗本体的存在性不在这条能力范围内(不可改清单)。
     */
    pos?: { x_pct: number, y_pct: number }
    /**
     * W4:浮窗可拉伸。像素尺寸,additive 可选字段——不设时退回 style.ts 的默认 250px 宽、
     * 高度由内容决定(向后兼容旧存档)。下限由 MIN_BUTLER_W_PX/MIN_BUTLER_H_PX 夹死,
     * **拖拽路径与读路径两处都夹**(只在 CSS 里写 min-width 拦不住存档里被写进的小值)。
     */
    size?: { w_px: number, h_px: number }
  }
  /**
   * 项目区的展示模式(2026-08-25 地基,为任务看板预留)。'overview' 是既有的项目总览,
   * 'board' 是 JIRA 式任务看板(竖列=状态,横向泳道=项目)。可选字段,缺省即 'overview'
   * ——旧存档读进来与从前一致。看板本体由「任务看板」窗口实现,地基只定这一个开关,
   * 免得两个窗口同时改 WorkbenchLayout 撞在一起。
   */
  projects_view?: 'overview' | 'board'
  /**
   * 用户自己改过的模块标题(2026-09-22「用自然语言改布局」)。键是模块 id,值是他要的那几个字。
   *
   * **additive 可选,缺席 = 一格不变**:旧存档读进来与加这个字段之前逐字相同。
   *
   * ## 为什么标题住在布局里,而不是另开一份 titles.json
   *
   * 「项目区改叫账号」跟「把随手记藏起来」是同一类操作(他看着界面说一句,界面就变),
   * 撤销也该是同一步。标题住在 `WorkbenchLayout` 里,`/layout/act` 应用前存的那份布局快照
   * **天然连标题一起存**,`/layout/undo` 也天然连标题一起回退 —— 另开一份文件的话,
   * 撤销就得同时回退两份东西,而"两份东西一起回退"迟早会漏掉一份。
   *
   * 它**盖在模板给的标题之上**:服务端 composeState 把这一份并进 `/state.template.module_titles`,
   * 客户端 `titleOf(id)` 一行不用改(见 client/Workbench.tsx)。模板切换不清它 —— 那是他
   * 亲手起的名字,不是模板产物。
   */
  titles?: Readonly<Record<string, string>>
  /**
   * 任务看板的排布方向(2026-08-25 Ben:"任务卡片可以有横排和竖排的切换")。
   *
   * - `'module-rows'`(缺省,原样):**模块是横向泳道**,状态是竖列 → 改状态是左右拖
   * - `'module-columns'`:**模块是竖列**(在上),状态是横向行(在下) → 改状态是上下拖
   * - `'status-columns'`(2026-09-09):**只按状态分列,不分模块泳道** → 一屏看清各状态各有几件
   *
   * 两种都不是"更好的那个":模块少、功能点多时横排更省地方;模块多、每个模块只有
   * 几张卡时竖排一眼能看全。所以做成开关而不是替换。可选字段,旧存档读进来即横排。
   */
  board_axis?: 'module-rows' | 'module-columns' | 'status-columns'
  /**
   * 「今天的待办」那一格用哪一版(2026-10-12,周三演示)。可选,缺席 = `flat`(列表)。
   * 切换只走 `POST /today/view`(切之前存一份布局快照,`/layout/undo` 能切回上一版)。
   */
  today_view?: TodayViewStyle
  /**
   * 纯净模式(2026-09-11,Ben 原话:「全屏幕只有一个球,事项卡片都不留」)。
   * true = 整屏只有顶栏与一颗声纹球,窗口槽/项目区/用量/额度/随手记/文件夹/日结条/浮窗
   * 全部收起(只是不显示,不卸载);点球临时展开事务官档,Esc 收回。
   * 可选字段,缺省即 false(完整工作台)——旧存档读进来与从前一致。切换只改这一个字段,
   * 别的布局一字不动。
   */
  pureMode?: boolean
  /**
   * 横屏那一版排布(2026-09-18 横屏布局)。**additive 可选字段**——不存在时横屏用
   * client/layout.ts 的 DEFAULT_LANDSCAPE_MODULES,竖屏那一份(顶层 `modules`)一字不动。
   *
   * 为什么另开一个分支而不是"一份布局两边共用":横竖两版的模块排布本来就不是同一件事
   * ——竖屏是"一行一行往下堆"(窗位叠占满一整行),横屏是"左中右三栏 + 底部四格"
   * (窗位槽占中间那一大块)。同一组 row/col/basis 在另一个方向上没有任何合理的换算,
   * 强行共用的结果是"在横屏拖宽了项目区,回到竖屏发现窗位叠矮了一截"。所以拖拽分栏、
   * 盒子高度、收起状态**按方向分别记**,「恢复默认布局」也只恢复当前方向那一份。
   *
   * 共用的只有跟方向无关的那几样:事务官浮窗位置(butler)、纯净模式(pureMode)、
   * 项目区/文件夹/看板的展示模式——它们是"看什么",不是"怎么排"。
   */
  landscape?: LandscapeLayout
}

/**
 * 横屏分支(2026-09-18)。方向无关的字段都留在 WorkbenchLayout 顶层,不在这里复制一份
 * (两份同名字段必然走漂,先例见 layout.ts MODULE_IDS 的 F1 注)。
 *
 * 下面两个字段是「横屏每条边界都要有分栏把手」(2026-09-18 Ben 截图)加的,两个都是
 * **additive 可选**:缺席时行为与加它们之前逐字相同,旧存档读进来不迁移、不报错。
 */
export interface LandscapeLayout {
  modules: readonly LayoutModule[]
  /**
   * 左栏(窗位应用栏)占整条上半区的宽度百分比。**缺席 = 定死 168px**(2026-09-18
   * 横屏布局那一版的行为,style.ts 里的 `.ben-wb__land-rail{width:168px}`),用户拖过
   * 那根「左栏 | 窗口槽」把手之后才有值。
   *
   * 为什么不给它一个默认百分比:168px 是按左栏要装的内容(一列标签 + 一颗场景条按钮)
   * 量出来的**绝对**下限,换成百分比之后同一份存档在 1200 宽那一档只剩 84px、在更宽的屏
   * 上又白白撑开——"缺席即旧行为"这条比"给一个在别的屏上错的默认值"稳。
   *
   * clamp 见 client/layout.ts 的 LANDSCAPE_RAIL_MIN/MAX_PCT,服务端 parseLayout 再夹一遍。
   */
  rail_pct?: number
  /**
   * 横屏那一份事务官浮窗落点(视口宽/高的百分比,与顶层 butler.pos 同一套读法)。
   *
   * **按方向分别记**(2026-09-18 决策记录):竖屏拖到左上角、横屏拖到右栏底部,是两件
   * 互不相干的事——共用一份坐标的结果是"在横屏摆好的位置回到竖屏正压着窗位槽"。
   * 缺席时横屏用 CSS 默认落点(右栏底部之上、不压底部四格),顶层 butler.pos 只管竖屏。
   * 浮窗尺寸(butler.size)仍然共用一份:它是"这个窗多大",跟摆在哪儿不是一回事。
   */
  butler_pos?: { x_pct: number, y_pct: number }
}

/**
 * 可自定义的模块 id(spec §3 分区 2/4/5,不含日结条 foot 与事务官浮窗 butler)。
 * 客户端(client/layout.ts 的 MODULE_IDS)与服务端(server/http.ts 的 parseLayout)
 * 共用同一份字面量——终审 F1:此前服务端 /layout 只校验形状不校验 id,靠的是客户端
 * 三个纯函数(moveModule/resizeModule/toggleHidden)单方面把 butler/foot 排除在外,
 * 服务端持久化层没有兜底。这里补上后,两边都从这一份常量派生,不会各写一份字面量走漂。
 *
 * A3(2026-08-24 UX 波):'sessions' 从这份清单里退休——会话区整块下线,改成窗位叠标签上的
 * 彩色圆点徽章(见 client/Workbench.tsx 的 DockTabBar)。这不破坏任何契约:display-client
 * 从不消费 layout(它是纯展示台,不读工作台自定义布局这条协议),而 http.ts 的
 * sanitizeModules 只按这份常量白名单过滤——旧布局文件里残留的 `{id:'sessions',...}` 条目
 * 下次写入时会被静默剔除,不会报错、也不会让 GET /state 挂掉。会话*数据*(state.sessions)
 * 不受影响,继续走 /event、/hook/* 等既有上报路径,只是不再有一块布局区域展示它。
 * 2026-08-25(版面重排):'widgets' 已退休,拆成 'notes'(随手记)与 'files'(系统文件夹)
 * 两个并排模块。旧存档的迁移见 server/http.ts 的 migrateLayoutModules,退休 id 见下面的
 * LEGACY_LAYOUT_MODULE_IDS——那一份存在的唯一理由就是让迁移还能看见它。
 */
export const LAYOUT_MODULE_IDS = [
  'projects', 'slot', 'usage', 'quota', 'notes', 'files',
  // 2026-09-21(布局模板):运营模板要用的三个。**纯 additive** —— 做产品模板的两份排布里
  // 一个都不出现,旧存档读进来一格不挪(sanitizeModules 只是多放行三个 id,不会凭空补上)。
  //   todo    待办事项(事项按模板给的环节分列)
  //   publish 发布计划(月历;读带 due 的事项,点日期新建)
  //   review  数据复盘(这一版是占位)
  'todo', 'publish', 'review',
  // 2026-10-12:今天的待办(看板事项的今天视图,src/todayTodos.ts)。只进自媒体模板;老布局缺它时
  // 读路径按模板补这一格(server/templateStore.ts addMissingTemplateModules),做产品模板一格不动。
  'today',
] as const

/**
 * 已退休、但**旧存档里还可能出现**的模块 id。它们不是合法的展示模块(不进 MODULE_IDS,
 * 界面认不出),但迁移必须先看得见它们才能把它们换成新模块——所以读路径的过滤要放行
 * 这一份,把"认不认得"和"该不该渲染"分成两件事。
 *
 * 顺序陷阱(2026-08-25 版面重排):migrateLayoutModules 与 projectsService 的
 * sanitizeStoredModules 都是先按 LAYOUT_MODULE_IDS 过滤——如果直接把 'widgets' 从白名单
 * 删掉,旧存档那条会在迁移看见它之前就被滤掉,迁移永远不触发,界面上表现为"底部两栏没
 * 出现,组件条也没了"。
 *
 * 'sessions' 是 A3 退休的,它没有对应的新模块(职责转给了标签徽章),所以不进这份清单
 * ——它就是该被静默剔除的幽灵。
 */
export const LEGACY_LAYOUT_MODULE_IDS = ['widgets'] as const

/** —— 窗口编排(spec 2026-08-21 W1–W9)。以下均为可选新增,display-client 副本本期不同步。 —— */

/** 矩形,单位 px/pt,坐标系原点为全局屏幕左上(AX 坐标系,y 向下)。页面矩形则相对视口左上。 */
export interface HelperRect { x: number, y: number, w: number, h: number }

/** 壳(工作台.app)连接状态。未连/未授权时 reason 是给界面直接显示的人话(D13)。 */
export interface HelperView {
  connected: boolean
  authorized: boolean
  reason?: string
  /**
   * 壳的系统通知到底弹没弹(2026-09-25,卡 M 补;统筹:以前这一路是「静默失败」—— 服务端把结果吞了、壳也不看错误,
   * 维护者说点了「允许」却一条都没看到,谁也说不清为什么)。壳每读到一次授权、每交一条给系统,都回一次;
   * 老壳不回就缺席。统筹和事务官都看得到;出了问题事务官在界面上说一句人话,给一键去系统设置那一页。
   */
  notify?: HelperNotifyView
  /**
   * ★ **这一刻电脑锁着屏没有**(2026-10-03,卡「锁屏时窗口型的家送不进」)。
   *
   * 锁着屏时窗口型那几家(豆包 / Kimi / Manus / Muse / Cursor…)**起不出窗、辅助功能一扇窗都列不出**
   * —— 送话、点键、开窗一下都做不到(协议型的 Claude / Codex 不受影响)。
   * 2026-10-03 09:04 真机那一回,界面与手机上只看得到「一扇标准窗口都没有」,
   * 谁也看不出是电脑锁着:这一格就是为了让它看得见。
   *
   * **缺席 = 不知道**(老壳不报这一格 / 壳没连上 / 辅助功能没授权)—— 不许当成「没锁」显示成一切正常,
   * 也不许当成「锁着」(界面照旧什么都不说)。
   */
  screen_locked?: boolean
}

/** 系统那边让不让「工作台」发通知(壳读到的)。 */
export type HelperNotifyPermission = 'allowed' | 'denied' | 'not_determined' | 'unknown'

export interface HelperNotifyView {
  permission: HelperNotifyPermission
  /** 最近一次交给系统的那一条:哪一张(key)、几点、系统收没收(ok)、没收的原话(error)。 */
  last_post?: { key: string, at: string, ok: boolean, error?: string }
}

/** 系统设置里「通知 → 工作台」那一页(壳里的网页点这个地址,壳交给系统打开)。 */
export const NOTIFY_SETTINGS_URL = 'x-apple.systempreferences:com.apple.Notifications-Settings.extension?id=ai.ben.workbench'

/** 场景列表项。app_count 为 0 表示预置但从未保存过内容。 */
export interface SceneView {
  id: string
  name: string
  app_count: number
  saved_at?: string
}

/** 最近一次贴合的结果。failed 时 reason 必填,界面如实显示,绝不装成功。 */
export interface SnapView {
  app: string
  state: 'snapped' | 'failed'
  reason?: string
}

/** 窗口槽里还没拉进来的一格(2026-09-25):只有键和名字 —— 背后还没有窗,没有「在不在跑」「在不在台」可说。 */
export interface DockPendingTab {
  key: string
  label: string
}

/**
 * 窗位叠标签(spec 2026-08-24 窗位叠 v2 V1–V6):拖进同一窗位的多个应用叠成一摞标签栏,
 * 同一时刻只显示 current 那扇,其余隐藏在后台。key 对应 appsRegistry 的应用键(不是 bundle id,
 * 界面/切换指令统一走这个键);running 现查 isRunning,不落盘、不缓存,避免显示假状态。
 *
 * S4(review,真机截图实证):im 标出这个标签对应哪一家 IM(供客户端把 state.badges 的
 * 未读数渲染成标签上的中性灰徽章)。这里不能靠客户端拿 key 直接字符串比对 'wechat'/
 * 'wecom'——key 是 registry 键,微信的 bundle id 反复漂移过(见 activation.ts 顶部
 * 注释),一旦某次漂移导致 A2(b) 自愈注册把它注册成 `c-<slug>` 这样的自定义键,
 * 字符串比对就会永远失配、badge 从此不再出现。判定改在服务端按 bundle_id 与
 * APP_BUNDLES.wechat/wecom 比对(dock.ts view()),不管这个 tab 最终叫什么 key 都认得出。
 */
export interface DockTab {
  key: string
  label: string
  running: boolean
  current: boolean
  /**
   * 这一格的窗**没在窗位里**,为什么(2026-09-25,卡 fix/slot-current-empty)。缺省 = 在(或说不出来)。
   * 摆回 / 切换没摆成、那家没开着、被藏起来了 —— 标签上写「点一下拉进来」(点了照旧 /dock/switch,
   * 那条路会先开应用、唤窗、摆位、置前);是当前那一格时,槽里写这句原因,不留一块空黑区。
   */
  unplaced?: string
  im?: 'wechat' | 'wecom'
  /**
   * 这枚标签管着两扇窗(2026-08-25「一个标签两半」)。缺省即单窗。
   * 界面据此标注双窗态;切换/放出仍是一枚标签一次操作,两扇一起动。
   */
  dual?: boolean
}

/** —— 用量面板(2026-08-25)。以下均为可选新增,display-client 副本本期不同步。 —— */

/** 四类 token 分开记账。主口径 = input + output,**不含 cache_read**(与 Claude 官方用量页一致)。 */
export interface UsageTotals {
  /** 真实输入(不含缓存读取)。 */
  input: number
  output: number
  cache_read: number
  cache_write: number
}

/**
 * 主口径「总消耗」= 新增输入 + **缓存写** + 输出(2026-09-02 Ben 定,理由见 UsagePanel 的长注释:
 * Claude 真正被处理的那批全记在 cache_creation 里,漏掉它等于把 Claude 抹成零)。
 * **缓存读不算**——它是"重看一遍已经送过的上下文",计价约十分之一。
 *
 * 放协议层的理由同 STATUS_TITLES / canTransition:用量面板与任务卡的「本卡消耗」必须是同一个
 * 口径,两边各写一份迟早会漂,然后同一批 token 在两处显示成两个数。
 */
export function billedTokens(totals: UsageTotals): number {
  return totals.input + totals.cache_write + totals.output
}

/** 一天的用量切片。三个 by_* 是同一批记录的三种切法,总量相等。 */
export interface UsageDay {
  /** YYYY-MM-DD(本地日)。 */
  date: string
  by_project: Record<string, UsageTotals>
  by_model: Record<string, UsageTotals>
  by_source: Record<string, UsageTotals>
  sessions: number
  messages: number
  /** '0'..'23' → 消息条数,供"高峰时段"用。 */
  hour_counts: Record<string, number>
}

/**
 * 单个来源的可用性。
 * - `ok`:完整口径,可参与全部指标
 * - `partial`:残缺口径(只取到部分字段的来源),**不参与缓存命中率与输入/输出占比**
 * - `error`:本轮取不到,界面显示"未接入",绝不显示 0(D13)
 */
export interface UsageSourceStatus {
  status: 'ok' | 'partial' | 'error'
  note?: string
}

/** 用量整块。任一来源失败只影响该来源;全部失败时上层给 `{ error }`。 */
export interface UsageState {
  days: readonly UsageDay[]
  sources: Record<string, UsageSourceStatus>
  /** 本轮扫描完成时间(ISO)。 */
  scanned_at: string
  /**
   * 按天切片用的是哪个时区(`Asia/Shanghai` 这种;2026-10-02)。**缺席 = 问不出来**,
   * 界面那时候就不提时区 —— 不写一个"按本地时间"去冒充(问不出来说明连本地是哪都不知道)。
   */
  timezone?: string
  /** 这份数覆盖到哪(`usage/collector.ts` 的 `USAGE_SCOPE_LOCAL_LOGS`)。缺席 = 老服务端。 */
  scope?: string
}

/** —— 任务看板(2026-08-25)。以下均为可选新增,display-client 副本本期不同步。 —— */

/**
 * 看板的四层收敛(2026-08-25 Ben 定的 JIRA 式层级,不要压平):
 *
 * ```
 * 项目(WorkbenchProject,顶部标签)
 *   └ 冲刺 Sprint(冲刺目标 + 一组组成版本号)
 *       └ 模块 BoardModule(模块目标)
 *           └ 功能点 TaskView(功能描述,就是看板上那张卡)
 * ```
 *
 * 为什么必须有前三层:功能点直接挂项目的话,几十张卡平铺在一起,"这一批到底要干成
 * 什么、算哪个版本"没有任何地方回答得了——Ben 的原话是"没有前面那些收敛,整个项目
 * 系统会很混乱"。
 *
 * 项目本身不在这里定义:它是既有实体(WorkbenchProject,来自 projects.json 的扫描),
 * 看板只往上挂一层自己的排期元数据(ProjectBoardMeta)。
 */

/**
 * 卡片状态 = 看板的竖列。
 *
 * Ben 亲口定的那四个(待办 / 进行中 / 等我确认 / 完成)一个字都没动,**只在两头各加了
 * 一段**(2026-09-09,借鉴 shengsheng90/DSH-taskboard 的七态语义,只借语义、不装那个插件、
 * 不抄它的代码;取舍见 docs/决策记录.md 2026-09-09「首批插件的取舍」):
 *
 * | 我们的值 | 界面上叫 | taskboard 那边的对应 | 为什么要它 |
 * |---|---|---|---|
 * | `backlog`  | 待排   | backlog     | 记下来了但这个冲刺不打算做——扔进待办列会把「这周要干的事」冲淡 |
 * | `todo`     | 待办   | todo        | 原样 |
 * | `doing`    | 进行中 | in_progress | 原样 |
 * | `confirm`  | 等我确认 | in_review | 原样。**措辞不跟着改成「待审」**:这一列的意思是「等 Ben 验收」,他自己定的话最准 |
 * | `done`     | 完成   | done        | 原样 |
 * | `blocked`  | 阻塞   | blocked     | 卡住了,和「在做」是两回事——混在进行中列里,那一列就不再回答「现在真有几件在动」 |
 * | `canceled` | 取消   | canceled    | 不做了。**这是「不做」不是「删掉」**:卡还在看板上,不可改清单第 5 条要的正是"系统不许替他扔东西" |
 *
 * 顺序即看板从左到右的列序:前五个是主干,`blocked` / `canceled` 是两条旁路,排在最后。
 */
export type TaskStatus = 'backlog' | 'todo' | 'doing' | 'confirm' | 'done' | 'blocked' | 'canceled'

export const TASK_STATUSES: readonly TaskStatus[] = [
  'backlog', 'todo', 'doing', 'confirm', 'done', 'blocked', 'canceled',
]

/**
 * 状态的中文名。**放在 protocol 而不是客户端的 boardModel**:服务端拒绝一次非法转换时
 * 要在原因里说人话(「『完成』不能直接回到『待排』」),两边各写一份中文名迟早会漂。
 */
export const STATUS_TITLES: Record<TaskStatus, string> = {
  backlog: '待排',
  todo: '待办',
  doing: '进行中',
  confirm: '等我确认',
  done: '完成',
  blocked: '阻塞',
  canceled: '取消',
}

/**
 * 转换表:从某个状态出发,允许去哪几个状态。
 *
 * 借 DSH-taskboard 的语义,但**按这台工作台只有 Ben 一个人用**收紧/放宽了三处:
 *
 * 1. `doing → done` 允许(taskboard 那边要求过一次 in_review)。他自己干完的活不必自己审一遍;
 *    「等我确认」那一列留给别人(agent / 别的窗口)交回来的东西。
 * 2. `canceled` 不是终点:`→ backlog / todo` 都通。取消是「现在不做」,不是「永远不存在」。
 * 2½. `doing → backlog` 通(2026-10-23,卡「待排的卡不许被派出去」):排着的 / 正在办的卡
 *    她随时能扔回「待排」—— 10-22 那 16 张被误派的卡就是这么挪回去的;挪回去那一刻
 *    排着的那条队由 `tasks.move` 撤掉(`client_dispatch` 那一格不动,只是挪状态)。
 * 3. 任何状态都能 `→ canceled`,除了 `done`——已经做完的事说「取消」没有意义,
 *    要撤销就先重开(`done → doing`)。
 *
 * 表里没写的一律拒绝并回一句原因(D13:降级/拒绝都要如实说出来,不静默丢掉)。
 * **原地不动(from === to)恒为合法**:拖回原处、重复点同一格都不该报错。
 */
export const TASK_TRANSITIONS: Readonly<Record<TaskStatus, readonly TaskStatus[]>> = {
  backlog: ['todo', 'canceled'],
  todo: ['doing', 'backlog', 'blocked', 'canceled'],
  doing: ['confirm', 'done', 'todo', 'backlog', 'blocked', 'canceled'],
  confirm: ['done', 'doing', 'blocked', 'canceled'],
  // 重开只回「进行中」:回到待办等于假装没做过,而它的 links / 时间戳都还在。
  done: ['doing'],
  blocked: ['todo', 'doing', 'canceled'],
  canceled: ['backlog', 'todo'],
}

/** 一次转换合不合法。非法时 reason 是一句能直接显示给 Ben 看的中文。 */
export type TransitionCheck = { ok: true } | { ok: false, reason: string }

/**
 * 纯函数,服务端(tasks.ts 的 move)与客户端(把去不了的那几格置灰)共用同一份判断——
 * 两边各写一份规则的话,界面允许的和服务端接受的迟早对不上。
 */
export function canTransition(from: TaskStatus, to: TaskStatus): TransitionCheck {
  if (from === to) return { ok: true }
  if (TASK_TRANSITIONS[from].includes(to)) return { ok: true }
  const allowed = TASK_TRANSITIONS[from].map(status => `「${STATUS_TITLES[status]}」`).join('、')
  return {
    ok: false,
    reason: allowed === ''
      ? `「${STATUS_TITLES[from]}」不能再改状态`
      : `「${STATUS_TITLES[from]}」不能直接改成「${STATUS_TITLES[to]}」;能去的是 ${allowed}`,
  }
}

/**
 * 从 from 走到 to 最短的一条路(按 {@link TASK_TRANSITIONS}),走不到回 undefined;原地回 `[]`。
 * 进度核对听他说「做完了」挪卡(server/progress.ts)与「今天的待办」那一格打勾(client/TodayModule.tsx)共用:
 * `/task/move` 一次只走一格,`todo → done` 表上不通,得照表一格一格走。
 */
export function statusPathTo(from: TaskStatus, to: TaskStatus): TaskStatus[] | undefined {
  if (from === to) return []
  const queue: { at: TaskStatus, path: TaskStatus[] }[] = [{ at: from, path: [] }]
  const seen = new Set<TaskStatus>([from])
  while (queue.length > 0) {
    const { at, path } = queue.shift() as { at: TaskStatus, path: TaskStatus[] }
    for (const next of TASK_TRANSITIONS[at]) {
      if (seen.has(next)) continue
      const route = [...path, next]
      if (next === to) return route
      seen.add(next)
      queue.push({ at: next, path: route })
    }
  }
  return undefined
}

/**
 * 优先级三档。用高/中/低不用 P0/P1/P2——这台工作台只有 Ben 一个人看,
 * 他不写代码,"P1 比 P2 急还是反过来"是纯粹的记忆负担。
 */
export type TaskPriority = 'high' | 'mid' | 'low'

export const TASK_PRIORITIES: readonly TaskPriority[] = ['high', 'mid', 'low']

/* ──────────────── 选题(2026-09-21 选题池;运营同事白板第二节)──────────────── */

/**
 * 一条事项是**哪一种**。缺省(整个字段缺席)= 普通事项,也就是今天看板上那些卡 ——
 * 「做产品」模板一字不变靠的就是这个缺省,不靠任何迁移代码。
 *
 * `'topic'` = 一条**选题**(运营同事原话:「选题池里的每个选题都有自己的创作进度」)。
 * 选题不是新实体,是事项的一种:它照样有标题、优先级、归属(`project_id` = 账号)、
 * `due`(发布日),照样落在同一份 tasks.json 里、同一条 /task/* 路由上。
 *
 * **为什么不另开一份 topics.json**:那样「这条选题的发布日」与「发布计划月历上那一天」
 * 就成了两份数据,月历得同时读两个源;而且不可改清单第 5 条那一整套保护(不许自动删、
 * 删上层不级联)要在第二个文件上再写一遍 —— 两份一定会漂。
 *
 * `'feature'` = 一条**需求**(2026-09-22,审视-用户到底得到什么 第三节:
 * 「两条模板要的是同一个东西 ——『卡 = 指挥台』」)。做产品模板下那句「加一个导出 PDF」
 * 建出来的就是它。与选题**同一个理由**不另开一份 features.json:它照样有标题、优先级、
 * 归属(`project_id` = 项目),照样落在同一份 tasks.json、同一条 /task/* 路由上。
 *
 * ★ 缺省仍然是普通事项:既有的那些卡一张都没有这个字段,行为一字不变。
 */
export type TaskKind = 'topic' | 'feature'

export const TASK_KINDS: readonly TaskKind[] = ['topic', 'feature']

/** 选题的内容类型(运营同事原话:「内容类型可选图文/视频」)。**只有这两个**,不猜第三种。 */
export type TopicContentType = '图文' | '视频'

export const TOPIC_CONTENT_TYPES: readonly TopicContentType[] = ['图文', '视频']

/**
 * 选题的创作进度六段(运营同事原话逐字:「灵感-初稿-准备素材-制作中-发布-复盘」)。
 * **顺序就是推进顺序**,`advanceTopic` 按它往后走一格。
 */
export type TopicStage = '灵感' | '初稿' | '准备素材' | '制作中' | '发布' | '复盘'

export const TOPIC_STAGES: readonly TopicStage[] = ['灵感', '初稿', '准备素材', '制作中', '发布', '复盘']

/**
 * 六段 → 八环节的映射(卡里:「八环节保留为流程说明(卡片展开时显示当前处于哪个环节,映射写清)」)。
 *
 * 八环节来自运营同事整理的《自媒体内容生产全流程》(docs/调研/…),是**说明性的流程表**;
 * 六段是他在白板上给选题池定的**可操作进度**。两者是同一条流水线的粗细两种刻度,
 * 所以这里是一对多,而且**八个环节一个不落**:
 *
 * | 六段 | 八环节 |
 * |---|---|
 * | 灵感 | 选题策划 |
 * | 初稿 | 内容调研、结构与脚本 |
 * | 准备素材 | 素材制作 |
 * | 制作中 | 后期制作 |
 * | 发布 | 发布包装、发布与互动 |
 * | 复盘 | 数据复盘 |
 *
 * **映射只用来显示,不落盘**:选题身上存的是 `stage`(六段那一个),环节是现算的一句话。
 * 存一份环节副本就等于同一件事有两个地方可以说,推进一步之后两边一定会打架
 * (同 TaskDirection「事务官交给我」那一半不落盘的理由)。
 */
export const TOPIC_STAGE_FLOW: Readonly<Record<TopicStage, readonly string[]>> = {
  灵感: ['选题策划'],
  初稿: ['内容调研', '结构与脚本'],
  准备素材: ['素材制作'],
  制作中: ['后期制作'],
  发布: ['发布包装', '发布与互动'],
  复盘: ['数据复盘'],
}

/** 这一段之后是哪一段。**最后一段(复盘)回 undefined**——没有下一步就如实说没有,不绕回第一段。 */
export function nextTopicStage(stage: TopicStage): TopicStage | undefined {
  const at = TOPIC_STAGES.indexOf(stage)
  return at === -1 ? undefined : TOPIC_STAGES[at + 1]
}

/** 没写进度的选题从哪一段算起。**灵感** —— 与「+新建选题」建出来的那一条一致。 */
export const DEFAULT_TOPIC_STAGE: TopicStage = '灵感'

/* ───────── 四种工作状态(2026-09-22 设计第〇节 Ben 的定调,第 2 条)───────── */

/**
 * 她**此刻在做哪一种事**。Ben 原话:「构思时、专注制作时、准备发布时、回头复盘时,
 * 需要的信息与操作重心不同」——所以界面按这四种状态组织,不按六段各摆一颗按钮。
 *
 * **与六段是显示层的粗细两种刻度**(同 `TOPIC_STAGE_FLOW` 的分寸):
 * 盘上存的仍然只有 `stage`(六段那一个),四态是由它现算出来的。
 * 存一份副本 = 同一件事有两个地方可以说,推进一步之后两边一定会打架。
 */
export type TopicPhase = '构思' | '制作' | '发布' | '复盘'

export const TOPIC_PHASES: readonly TopicPhase[] = ['构思', '制作', '发布', '复盘']

/**
 * 六段各归哪一态。设计第〇节逐字:「构思(灵感/框架)、制作(初稿→定稿→素材→包装)、
 * 发布、复盘」——**「制作中」那一段仍然归「制作」**,它出的是定稿,不是发布那一步。
 *
 * 「发布」那一态只剩「发布」一段:到了那里稿子与包装都定了,她要做的只有排期与点「已发布」。
 */
export const TOPIC_PHASE_OF_STAGE: Readonly<Record<TopicStage, TopicPhase>> = {
  灵感: '构思',
  初稿: '制作',
  准备素材: '制作',
  制作中: '制作',
  发布: '发布',
  复盘: '复盘',
}

/** 这条选题此刻算哪一态。**认不出的段落归「构思」**(而不是抛):段是老数据里可能出现的字符串。 */
export function topicPhaseOf(stage: TopicStage | undefined): TopicPhase {
  return TOPIC_PHASE_OF_STAGE[stage ?? DEFAULT_TOPIC_STAGE] ?? '构思'
}

/** 一态里包含哪几段(按 `TOPIC_STAGES` 的顺序)。**由上面那张表现算**,不另写一份字面量。 */
export function stagesOfTopicPhase(phase: TopicPhase): readonly TopicStage[] {
  return TOPIC_STAGES.filter(stage => TOPIC_PHASE_OF_STAGE[stage] === phase)
}

/* ───────── 产物页签(2026-09-22 设计第一节「成果必须回到卡上」)───────── */

/**
 * 卡里那一排页签。**七个**:六段各自的产物 + 合规查词。
 *
 * 页签名与文件名**不是一回事**:合规那一份落的是 `查词.md`(技能《运营-合规查词》的
 * 固定产物,守卫用例的白名单里写着它为什么不在 `TOPIC_DELIVERABLE_FILES` 里),
 * 页签上写「合规查词」是因为她记的是"查没查过词",不是文件叫什么。
 * 页签 → 文件名那张表在 `server/topicRun.ts`(挨着 `TOPIC_DELIVERABLE_FILES`,**只有一份**)。
 */
export type TopicDocTab = '框架' | '初稿' | '定稿' | '素材清单' | '合规查词' | '发布包装' | '复盘'

export const TOPIC_DOC_TABS: readonly TopicDocTab[] = [
  '框架', '初稿', '定稿', '素材清单', '合规查词', '发布包装', '复盘',
]

/**
 * 每一态**铺开**哪几个页签(设计第〇节:「构思态只留框架与随手记;制作态定稿编辑与
 * 素材清单占主位、数据收起;发布态只剩包装与日历;复盘态数据与对标铺开」)。
 *
 * ★ **只决定"先铺开哪个",不决定"能看哪个"**:七个页签一直都在,点一下就能翻到 ——
 * 一个因为"现在不该看"而被藏起来的定稿,只会让她去文件夹里找,那正是这一版要省掉的事。
 */
export const TOPIC_PHASE_TABS: Readonly<Record<TopicPhase, readonly TopicDocTab[]>> = {
  构思: ['框架'],
  制作: ['定稿', '素材清单', '合规查词'],
  发布: ['发布包装'],
  复盘: ['复盘'],
}

/* ───────── 把关三键与留痕(设计第一节「把关有动作、留痕」)───────── */

/**
 * ## 这一段为什么是泛型的(2026-09-22 需求卡那张卡)
 *
 * 审视第三节的结论逐字:「两条模板要的是同一个东西 ——『卡 = 指挥台』+『产物回卡』
 * +『把关留痕』+『回写画像』」。选题卡与需求卡**页签名不同、段名不同,别的一个字不差**:
 * 一样的三键、一样的 `审核记录.jsonl`、一样的段落级 diff、一样的四档小标。
 *
 * 所以这几样做成**以"页签名 / 段名"为参数的泛型**,选题那一套是它的一个实例
 * (`TopicReviewEntry = DeckReviewEntry<TopicDocTab, TopicStage>`)。
 * 名字、字段、行为一个字没改 —— 复制一份平行定义才是两份一定会漂的那条老路。
 */

/**
 * 把关三键。措辞由设计第四节第 2 条定(建议沿用「通过 / 改一改 / 我自己改」),
 * **存的是英文 id、显示的是中文**:改一次措辞不该让盘上已经写下的历史跟着变。
 */
export type DeckReviewAction = 'pass' | 'revise' | 'self' | 'run' | 'record' | 'confirm_points'

/** 卡上真正画出来的那**三颗**。`run` / `record` 不是按钮,是另外两件事(见下)。 */
export const DECK_REVIEW_ACTIONS: readonly DeckReviewAction[] = ['pass', 'revise', 'self']

export const DECK_REVIEW_ACTION_TITLES: Readonly<Record<DeckReviewAction, string>> = {
  pass: '通过',
  revise: '改一改',
  self: '我自己改',
  // `run` 不是把关,是「让事务官推进这一步」那一下。它也写进同一份记录里 ——
  // 这条卡上发生过什么,只该有一处可查(而且卡上的「排队 / 在做」要靠它算)。
  run: '让事务官推进',
  // `record` 只有需求卡会写(2026-09-22):把结论落进她仓库的决策记录那一下。
  // 落在同一份 `审核记录.jsonl` 里,理由同 `run` —— 一处可查。选题卡永远不产生这个值。
  record: '写进决策记录',
  // `confirm_points` 是 2026-09-23 加的那一件(维护者:「不能假装自己搞懂了」):
  // 她逐条过完确认点那一下。**它不是按钮,也不是把关** —— 它是"这条需求到底是什么"
  // 被定下来的那一刻。两种卡都会写;没有它的卡一律算"未确认",后面几态不许派活。
  confirm_points: '过确认点',
}

/** 选题那边的名字。**同一份东西**,不是第二套(见上面那段)。 */
export type TopicReviewAction = DeckReviewAction
export const TOPIC_REVIEW_ACTIONS: readonly TopicReviewAction[] = DECK_REVIEW_ACTIONS
export const TOPIC_REVIEW_ACTION_TITLES: Readonly<Record<TopicReviewAction, string>> = DECK_REVIEW_ACTION_TITLES

/**
 * `审核记录.jsonl` 里的一行。**一行一条,追加,永不改写**。
 *
 * 两个类型参数就是两种卡唯一的差别:页签名与段名。
 */
export interface DeckReviewEntry<Tab extends string = string, Stage extends string = string> {
  /** ISO 时刻。 */
  at: string
  /** 对哪一份产物。`run` 那一条记的是那一段对应的产物。 */
  tab: Tab
  action: DeckReviewAction
  /** 「改一改」时她说的那一句;`run` 时她额外补的那一句(可缺)。 */
  text?: string
  /** 当时在哪一段。留痕要能还原当时的上下文。 */
  stage?: Stage
  /**
   * 这一次是**代做**吗(设计第四节第 4 条)。`run` 那一条才有意义:
   * 该派出去的那几家派不出去时,这一步由事务官自己顶着做,卡上标「代做」。
   */
  standin?: boolean
  /**
   * `confirm_points` 那一条才有:**最终定下来的那几条确认点**,一条一行
   * (「<问的那一句>:<最后算数的答案>」)。留痕要能还原"当时到底确认了什么",
   * 而产物文件是会被改写的 —— 只指着文件说"去看那一节"等于没留痕。
   */
  points?: readonly string[]
  /**
   * `confirm_points` 那一条才有:**他改了哪几条**(序号从 1 起)。
   * 空 = 他说「都对」。维护者第 3 条逐字:「含他改了哪条」——
   * 他纠正过的那几条正是"她原本理解错了"的地方,是下一次生成规则该学的东西。
   */
  changed?: readonly number[]
}

export type TopicReviewEntry = DeckReviewEntry<TopicDocTab, TopicStage>

/** 段落级 diff 的一行。`same` 也回 —— 只给增删两种,读的人对不上位置。 */
export interface DeckDiffRow {
  kind: 'same' | 'add' | 'del'
  text: string
}

export type TopicDiffRow = DeckDiffRow

/** 一个页签在这张卡上的现状。`POST /topic/docs`(`/feature/docs`)一次把几个都回来。 */
export interface DeckDocView<Tab extends string = string> {
  tab: Tab
  /** 文件名(`框架.md` / `需求.md`)。**始终有**:她要知道东西落在哪个名字上。 */
  file: string
  /** 文件在不在。**不在不是错**:那一段还没做而已。 */
  exists: boolean
  /** 全文。文件不在时缺席(**不给空字符串** —— "没有这份"与"这份是空的"是两件事)。 */
  text?: string
  /** 最后改动时刻(ISO)。读不到就缺席。 */
  updated_at?: string
  /** 与上一版比,这一轮改了什么。没有上一版时缺席。 */
  diff?: readonly DeckDiffRow[]
  /** 读这一份时出的真错误(不含"文件还没有")。原样带回界面。 */
  error?: string
}

export type TopicDocView = DeckDocView<TopicDocTab>

/**
 * 派活小标的四档(设计第一节「看得见进度」逐字:排队 / 在做 / 回来了 / 失败)。
 *
 * **这四个字不是 `DispatchStatus` 的别名**:那一份说的是"命令起没起来"
 * (running / done / failed,外加她取消后收场出来的 `canceled`),这一份说的是**她点完那颗按钮之后,这件事走到哪了** ——
 * 「排队」就是"交出去了,那头还没报任何进度",只有把 `run` 那一条留痕与卡上的派活
 * 记录放在一起才算得出来。算法在 `client/DeckModel.ts` 的 `deckRunBadge`。
 */
export type DeckRunBadge = '排队' | '在做' | '回来了' | '失败'

export type TopicRunBadge = DeckRunBadge

/* ─────── 需求卡 = 指挥台(2026-09-22,审视第三节 + 第四节第三幕)─────── */

/**
 * 一条需求走的**四态**(卡上看得见的就是这四格):
 *
 * | 态 | 事务官做什么 | 她做什么 |
 * |---|---|---|
 * | 梳理 | 她一句话 → 最多问两问 → 写 `需求.md`(目标 / 边界 / 验收标准) | 答两句、认这份需求 |
 * | 拆解与派活 | 拆成子事项 `子事项.md`,每件标「派给谁」,一键派出 | 看拆得对不对 |
 * | 验收 | 每件回来的结果摘要落 `验收.md` | 通过 / 打回(带一句话)/ 我自己改 |
 * | 记录 | 把结论写成 `记录.md`,通过后落进她仓库的 `docs/决策记录.md` | 只点一下,不用自己写 |
 *
 * ## 这里为什么**没有**「六段 / 四态」那两把刻度
 *
 * 选题那边盘上存六段、四态现算(`TOPIC_PHASE_OF_STAGE`),因为六段是运营同事白板上
 * 已经在用的词,四态是 Ben 后来定的组织方式 —— 两把刻度都有人在用。
 * 需求这条线**只有这一把**:审视第三节那句「拆、派、收、验、记」就是它。
 * 硬造一个粗刻度盖在上面,等于给同一件事再开一处可以说的地方(见 TOPIC_STAGE_FLOW 那段)。
 */
export type FeatureStage = '梳理' | '拆解与派活' | '验收' | '记录'

export const FEATURE_STAGES: readonly FeatureStage[] = ['梳理', '拆解与派活', '验收', '记录']

/** 没写过进度的需求卡从哪一态算起。**梳理** —— 她刚说完那一句,什么都还没有。 */
export const DEFAULT_FEATURE_STAGE: FeatureStage = '梳理'

/** 这一态之后是哪一态。**最后一态(记录)回 undefined**,不绕回第一态。 */
export function nextFeatureStage(stage: FeatureStage): FeatureStage | undefined {
  const at = FEATURE_STAGES.indexOf(stage)
  return at === -1 ? undefined : FEATURE_STAGES[at + 1]
}

/** 这条需求此刻算哪一态。**认不出的归「梳理」**(而不是抛):老数据里可能是任意字符串。 */
export function featureStageOf(stage: FeatureStage | undefined): FeatureStage {
  return stage !== undefined && FEATURE_STAGES.includes(stage) ? stage : DEFAULT_FEATURE_STAGE
}

export function isFeatureStage(value: unknown): value is FeatureStage {
  return typeof value === 'string' && (FEATURE_STAGES as readonly string[]).includes(value)
}

/**
 * 卡里那一排页签。**四个**,与四态一一对应。
 *
 * 页签 → 文件名那张表在 `server/featureRun.ts`(挨着 `FEATURE_DELIVERABLE_FILES`,**只有一份**),
 * 同选题那边的分寸。
 */
export type FeatureDocTab = '需求' | '子事项' | '验收' | '记录'

export const FEATURE_DOC_TABS: readonly FeatureDocTab[] = ['需求', '子事项', '验收', '记录']

/**
 * 每一态**铺开**哪几个页签。
 *
 * ★ 与选题那边同一条分寸:**只决定"先铺开哪个",不决定"能看哪个"** ——
 * 四个页签一直都在,点一下就翻得到。
 */
export const FEATURE_STAGE_TABS: Readonly<Record<FeatureStage, readonly FeatureDocTab[]>> = {
  梳理: ['需求'],
  拆解与派活: ['子事项'],
  验收: ['验收'],
  记录: ['记录'],
}

/**
 * 派出去的一件子事项跑完之后落下的那份结果(2026-09-23,断点 B)。
 *
 * 文件是 `docs/需求/<名>/结果-<子事项>.md`,**这份视图现扫目录拼出来**,不另存清单
 * (同「这条需求上发生过什么只该有一处可查」那条纪律)。「验收」页签念的就是它。
 */
export interface FeatureResultView {
  /** 哪件子事项。 */
  item: string
  /** 落在哪个文件(文件名,不是全路径 —— 全路径在 `/feature/docs` 回的 `dir` 里)。 */
  file: string
  /** 退出码是不是 0。 */
  ok: boolean
  /** 一行摘要(成没成、退出码、有没有改动)。 */
  summary: string
  /** 全文。手机上点开看的就是它。 */
  text: string
  updated_at?: string
}

export type FeatureReviewEntry = DeckReviewEntry<FeatureDocTab, FeatureStage>

export type FeatureDocView = DeckDocView<FeatureDocTab>

/**
 * 一件子事项**派给谁**(第三幕逐字:「派给 Codex 做代码、Claude 审代码」)。
 *
 * 只有三种,不猜第四种:`butler` 是"事务官自己办"。
 * 前两个的 id 与 `AgentDispatchFamily` 里那两家**故意同名** —— 事务官真要派出去时
 * 走的就是「派活给别家Agent」那一节,那里认的是这两个 id。
 */
export type FeatureHand = 'codex' | 'claude' | 'butler'

export const FEATURE_HANDS: readonly FeatureHand[] = ['codex', 'claude', 'butler']

export const FEATURE_HAND_TITLES: Readonly<Record<FeatureHand, string>> = {
  codex: 'Codex 做代码',
  claude: 'Claude 审与分析',
  butler: '事务官自己',
}

/**
 * 决策记录写在她仓库的哪儿(**缺省**,2026-09-22)。
 *
 * 路径可配:`POST /feature/record` 收一个 `record_rel`。**相对项目根**,不收绝对路径 ——
 * 一条从界面传进来的绝对路径等于一把"往任何地方写文件"的钥匙。
 */
export const DECISION_RECORD_REL = 'docs/决策记录.md'

/**
 * 「发布计划」那两个日期的形状:`YYYY-MM-DD` 的**本地**日期(2026-09-22 两状态)。
 *
 * 为什么要把关而不是像 `due` 那样什么字符串都收:这两个日期**唯一的用处**就是把一条选题
 * 摆进月历的某一格。形状不对的日期在月历上永远落不到任何一格,留着它等于在卡上写了一个
 * 界面读不出来的日期 —— 看起来排过期了,其实哪天都不出现,这比空着更糟(D13)。
 *
 * 连 2026-02-30 这种"形状对、那天不存在"的也不收:按 `new Date(y, m-1, d)` 回弹一次,
 * 弹到 3 月 2 日就说明那一天不存在。月份/日子的范围检查是它顺带做掉的。
 */
export function isPublishDay(value: unknown): value is string {
  if (typeof value !== 'string') return false
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value)
  if (match === null) return false
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])]
  const at = new Date(year, month - 1, day)
  return at.getFullYear() === year && at.getMonth() === month - 1 && at.getDate() === day
}

/**
 * ——— 一句话排进发布计划时,卡上那段 desc 的形状(2026-10-13,卡「座机一句话记发布计划」)———
 *
 * 维护者要的是「悬浮上去就能看到相关内容」:她说的**原话**与这条计划**从哪儿交代的**。
 * 两样都落在 desc 里(不新开字段:additive 字段每加一个,展示台与手机的副本就要跟一次),
 * 而**写(`server/publishPlan.ts` 那条路由)与读(月历悬浮)只认这一个记号** ——
 * 月历那一格在客户端,服务端的模块它 import 不到,所以记号放在这份三方契约里。
 *
 * 老卡、她手填的那几条没有这一行:`publishPlanDescParts` 回的 `said` 就是整段 desc,`source` 缺席。
 */
export const PUBLISH_PLAN_SOURCE_PREFIX = '来源:'


/** `<原话>\n\n来源:电话 10-13 19:30`。`from` 缺席(认不出是哪一端)就只有原话。 */
export function publishPlanDescOf(input: { said: string, from?: string, at?: Date }): string {
  const said = input.said.trim()
  if (input.from === undefined || input.from === '') return said
  const at = input.at ?? new Date()
  const p = (n: number): string => String(n).padStart(2, '0')
  const stamp = `${p(at.getMonth() + 1)}-${p(at.getDate())} ${p(at.getHours())}:${p(at.getMinutes())}`
  return `${said}\n\n${PUBLISH_PLAN_SOURCE_PREFIX}${input.from} ${stamp}`
}

/**
 * ——— 从一条资讯深聊出来的结论,带着它的来源(2026-10-13,卡「播客页重做」★4)———
 *
 * 维护者原话:「聊完之后的结论同步到电脑的随手记,如果需要形成待办的则做成事项卡出现在项目区的
 * 看板里,要带上来源于,也就是对应资讯卡片信息和链接」。
 *
 * 两样都只是**一段文本**(随手记只有 `text`,事项卡只有 `desc`),所以来源那一行的形状
 * 与 {@link publishPlanDescOf} 同一条规矩:**写与读只认这一个记号**,放在这份三方契约里
 * ——— 手机写(它发的是结论 + 条目 id,文本由服务端拼)、电脑看板与随手记读,两处 import 的是这一处。
 *
 * 不新开字段的理由也和发布计划那条一样:additive 字段每加一个,展示台与手机的副本就要跟一次。
 */
export const FEED_NOTE_SOURCE_PREFIX = '来源:'
/** 事项卡上那一行(比随手记多一句摘要,看板上悬浮就能看见为什么)。 */
export const FEED_TASK_SOURCE_PREFIX = '来源于:'

/** 随手记那一条:`<结论>\n\n来源:《标题》 链接`。 */
export function feedNoteTextOf(input: { said: string, title: string, url?: string }): string {
  const said = input.said.trim()
  const title = input.title.trim()
  if (title === '') return said
  const url = (input.url ?? '').trim()
  return `${said}\n\n${FEED_NOTE_SOURCE_PREFIX}《${title}》${url === '' ? '' : ` ${url}`}`
}

/** 事项卡那段 desc:`来源于:《标题》 链接 · 摘要`。结论本身是卡的标题,不在 desc 里重复一遍。 */
export function feedTaskDescOf(input: { title: string, url?: string, why?: string }): string {
  const title = input.title.trim()
  const url = (input.url ?? '').trim()
  const why = (input.why ?? '').trim()
  return `${FEED_TASK_SOURCE_PREFIX}《${title}》${url === '' ? '' : ` ${url}`}${why === '' ? '' : ` · ${why}`}`
}

/**
 * 把一段文本拆回「正文」与「来源」那一行。两个记号都认(随手记那条与事项卡那条),
 * 没有那一行就只有正文 —— 她手填的、老卡上的那些照旧只有正文。
 */
export function feedSourceParts(text: string | undefined): { said?: string, source?: string } {
  const body = (text ?? '').trim()
  if (body === '') return {}
  for (const prefix of [FEED_NOTE_SOURCE_PREFIX, FEED_TASK_SOURCE_PREFIX]) {
    const at = body.lastIndexOf(`\n${prefix}`)
    if (at >= 0) {
      const said = body.slice(0, at).trim()
      const source = body.slice(at + 1 + prefix.length).trim()
      return { ...(said === '' ? {} : { said }), ...(source === '' ? {} : { source }) }
    }
    if (body.startsWith(prefix)) {
      const source = body.slice(prefix.length).trim()
      return { ...(source === '' ? {} : { source }) }
    }
  }
  return { said: body }
}

/** 把 desc 拆回「原话」与「来源」那一行(月历悬浮用)。没有那一行就只有原话。 */
export function publishPlanDescParts(desc: string | undefined): { said?: string, source?: string } {
  const text = (desc ?? '').trim()
  if (text === '') return {}
  const at = text.lastIndexOf(`\n${PUBLISH_PLAN_SOURCE_PREFIX}`)
  if (at < 0) return { said: text }
  const said = text.slice(0, at).trim()
  const source = text.slice(at + 1 + PUBLISH_PLAN_SOURCE_PREFIX.length).trim()
  return { ...(said === '' ? {} : { said }), ...(source === '' ? {} : { source }) }
}

/**
 * 负责人 = 某一家 agent(Ben 的原话:"执行人(其实是 Agent,这是要关联的)",
 * 后来他纠正措辞:界面上叫**负责人**)。直接复用 AgentId,不另造一套人名。
 *
 * 负责人只有一个,但**真正在干活的窗口可以有好几个**(见 TaskLink):一个功能点中途
 * 因为额度耗尽做了交接,会从 Codex 换到 Claude,两边的窗口都得留痕。这两件事分开记:
 * 负责人是"这条归谁管",关联窗口是"实际上谁在/谁干过"。
 */
/**
 * **2026-09-22 起比 `AgentId` 宽**:多了 `gpt` 与 `doubao` 两家(它们走接口那只手,
 * 没有会话流,所以不在 `AgentId` 里)。电话里说一句「让 GPT 写个文案」要落得到卡上,
 * 而卡上的「负责人」正是这一格。
 *
 * 界面上那排**可点的负责人按钮仍然只有 `AGENT_IDS` 那四个**(TaskDialog / TaskBoard 里
 * 遍历的是 AGENT_IDS):手点指派的是"这条归谁管",而 GPT / 豆包是"这一次派给谁做",
 * 由事务官按原话填 —— 给它们画一颗按钮,点完却没有任何窗口能看,那是画一颗点了没反应的钮。
 */
/*
 * ★ **2026-09-25 多了「人」那三档**(卡 N「一件事一份、进度靠证据」;维护者:「右侧现在有事项和看板了,
 * 哪些是谁来处理,这个明确吗」)。以前「你 / 同事 / 别人」没有地方放,引导落地只好写进描述那一行
 * 「负责:同事(9/29 回来写)」,负责人那一格缺席 —— 于是没人知道这张该谁动。现在负责人**就是真的**:
 * 某家 AI → 按档位派;事务官(`dsh`)→ 她办;`me` → 他自己的事(进「今天要做」、早报提);
 * `colleague` / `other` → 只跟进、到期提醒。见 {@link PERSON_ASSIGNEES}、server/itemDriver.ts。
 * 界面上那排可点的负责人按钮从这一天起列全(你 / 事务官 / 几家 AI / 同事 / 别人),上面那段「只有四个」作废。
 */
export type TaskAssignee = AgentId | AgentDispatchFamily | PersonAssignee | MemberAssignee | AgentCardAssignee

/**
 * 能被**派活**的那几家(2026-09-21,参赛冲刺卡 ④「指挥电脑上的 Agent」)。
 *
 * 跟 `AgentId` 差一个 `dsh`:事务官自己就是 DSH,「派给 DSH」= 它自己办,不是一次派活
 * ——所以那一档根本不进这张表(进了就要在界面上多出一个永远是"进行中"的小标)。
 *
 * **2026-09-22 多了 `gpt` 与 `doubao`**(决策记录 09-21「运营白板三件」第 2 条,
 * Ben 的原话:「产品研发场景怎么派活,这个场景就怎么派活,不是通用的吗」)。
 * 这两家与前三家的区别只在**手**:它们没有命令行,豆包的窗口也送不进去
 * (辅助功能树只有 10 个节点,见 docs/交接-0921-送话进客户端窗口.md),所以走 `api` 那一只 ——
 * 请求经中转转到 OpenAI / 火山方舟,Key 在服务器上(用户手里是订阅,不是 Key)。
 *
 * ★ **它们与 `AgentId` 的差别不止 `dsh` 了**:`gpt` / `doubao` **没有会话流**,
 * 所以它们进不了 `AgentId`(那张表的含义是"/state.sessions 里会出现的那几家")。
 * 派活的目标与会话的来源从这一天起是两张表 —— 这不是疏漏,是它们本来就不是一回事。
 */
/*
 * ★ **2026-09-24 多了 `muse` 与 `manus`**(卡 F「手机远程派活六家」,维护者:「codex,kimi,Claude,
 * 还有我今天新装的 muse,还有之前的 manus,豆包,你随便用,最重要是要能 work」)。
 * 两家都只有窗口那一只手(没有命令行、没有接口),也都**没有会话流** —— 所以同 gpt / 豆包,
 * 进不了 `AgentId`;结果靠读它们窗口里的回复收回来(`server/dispatchRun.ts`)。
 */
/*
 * ★ **2026-09-25(卡 Z)这张写死的名单删了**。原来这里是
 * `AGENT_DISPATCH_FAMILIES = ['codex','claude','kimi','gpt','doubao','muse','manus']`,
 * 每加一家都得改代码 —— 维护者:「要是写死了就很糟糕了……你得想个机制」。现在**有哪几家能接活只问 Agent 登记表**
 * (`server/dispatchTargets.ts` 的 `dispatchTargets`:登记表里判成 Agent、接上了的每一家,
 * 外加只走接口、连 App 都没有的那几家)。所以这个类型是**开集** —— 一个字符串,登记表说谁在就是谁在。
 *
 * 老记录里的家名(`muse` / `manus` / `doubao`)一字不变:写过专门接法的那几家,登记表 id 就是它自己的家名
 * (`server/agentSources.ts` 的 `FAMILY_SOURCES`);别的一律是它的包标识。
 */
export type AgentDispatchFamily = string

/**
 * **拿不到登记表时,家名 → 显示名的退路**(老记录的派活小标、进度那句话)。
 * 有登记表的地方一律用登记表里的 `name`(`dispatchTargets` 的 `title`);这张表里只有写过专门接法的那几家,
 * 认不出的家名**原样显示**(`dispatchFamilyTitle`),不猜一个名字出来。
 */
export const DISPATCH_FAMILY_TITLES: Readonly<Record<string, string>> = {
  codex: 'Codex',
  claude: 'Claude',
  kimi: 'Kimi',
  gpt: 'GPT',
  doubao: '豆包办公',
  muse: 'Muse',
  manus: 'Manus',
}

/** 一家怎么称呼:表里有就用它,没有就原样用家名(登记表 id / 包标识)。 */
export function dispatchFamilyTitle(family: string): string {
  return DISPATCH_FAMILY_TITLES[family] ?? family
}

/**
 * **永远不算一家能派活的**(2026-09-25,卡 Z)。名单改成开集之后,这一道**黑名单**是必须留的那一份:
 * 微信、企业微信这类人跟人聊天的 —— 往它们的聊天窗口里打一行字再按回车,是以他的身份对真人说话。
 * 与壳的 `SendTextPolicy.neverBundleIds`、服务端 `dispatchClient.CLIENT_DISPATCH_NEVER` 是同一条纪律,
 * 三道门各自成立(客户端键与包标识两种写法都挡)。
 */
export const NEVER_DISPATCH_FAMILIES: readonly string[] = [
  'wechat', 'wecom',
  'com.tencent.xinWeChat', 'com.tencent.WeWorkMac',
]

/** 包标识的形状(`com.meta.endo` / `im.manus.desktop`):至少一个点,只有字母数字与 `. _ -`。 */
const BUNDLE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]*(?:\.[A-Za-z0-9][A-Za-z0-9_-]*)+$/

/**
 * 这个值是不是**一个家名**(2026-09-25,卡 Z 起是开集:「这台电脑上到底有没有这一家」由登记表回答,
 * `dispatchTargets` + `isDispatchTarget`;HTTP 入口按那一份把关、报得出候选有哪几家)。
 *
 * 开集不等于什么字符串都算。登记表里一家的 id **只有两种形状**(`server/agentSources.ts` 的规矩):
 * ① 仓库里为它写过专门接法的那个家名(`claude` / `muse` / `gpt` …… —— 就是 {@link DISPATCH_FAMILY_TITLES} 的键);
 * ② 它的**包标识**(带点的那种,`com.meta.endo`)。
 * 所以「张三」「unknown」这类既不是家名、也不像包标识的值一律不算 —— 读盘时丢掉、HTTP 入口 400,
 * 而**运行时新发现的一家(包标识)不用改这里一行代码**就认得。
 * 事务官自己(`dsh`)、人那三档、{@link NEVER_DISPATCH_FAMILIES} 一律不算。
 */
export function isAgentDispatchFamily(value: unknown): value is AgentDispatchFamily {
  if (typeof value !== 'string') return false
  const id = value.trim()
  if (id === '' || id === 'dsh' || isPersonAssignee(id) || NEVER_DISPATCH_FAMILIES.includes(id)) return false
  return Object.hasOwn(DISPATCH_FAMILY_TITLES, id) || BUNDLE_ID.test(id)
}

/**
 * 派活用的是**哪只手**(2026-09-21 Ben 纠正,决策记录「派活 = 直接操作客户端窗口」)。
 *
 * 统筹原来只按「命令行」理解派活;Ben 说派活是**直接操作窗口槽里的客户端** ——
 * 用户手里有的是订阅,不是 API Key。于是三只手并存,**目标那家不变,只是手不同**:
 *
 * | 手 | 怎么送 | 谁在做 |
 * |---|---|---|
 * | `cli` | 各家自己的非交互命令行(`codex exec` / `claude -p`) | 这张卡(server/agentDispatch.ts) |
 * | `api` | OpenAI 兼容接口,经中转记账(GPT / 豆包这种没有 CLI 的) | 另开的适配器卡 |
 * | `window` | 激活窗口、聚焦输入框、送文本、回车 | `feat/dispatch-into-client` |
 *
 * 这个字段就是那个**留给第三只手的口子**:记录里写清这次是用哪只手送出去的,
 * 界面与收件箱据此说得出"它是怎么被派出去的"。缺席按 `cli` 读(这件功能头一版只有命令行)。
 */
export type DispatchHand = 'cli' | 'api' | 'window'

export const DISPATCH_HANDS: readonly DispatchHand[] = ['cli', 'api', 'window']

/** 三只手在界面上怎么说。**不出现英文词** —— 半专业用户不认识 "CLI"。 */
export const DISPATCH_HAND_TITLES: Readonly<Record<DispatchHand, string>> = {
  cli: '命令行',
  api: '接口',
  window: '客户端窗口',
}

/**
 * 一次派活的几档。**没有"排队中"**:命令要么起来了,要么没起来(没起来就是 failed)。
 * `canceled`(2026-10-28,任务书「取消要收场执行者」)= 她取消了这张卡、在跑的那一次被
 * 当场收场(SIGTERM 那一下已发):不是没做成,是不要再做了。
 */
export type DispatchStatus = 'running' | 'done' | 'failed' | 'canceled'

export const DISPATCH_STATUSES: readonly DispatchStatus[] = ['running', 'done', 'failed', 'canceled']

/**
 * 一次派活的记录(2026-09-21)。一条事项同一时刻只有一次 —— 再派一次就把这条覆盖掉,
 * 不留历史:卡面要回答的是"现在谁在做、做到哪",经过在那条 DSH 会话里,不在卡上存第二份。
 */
export interface RuntimeConfig { model?: string, effort?: string }
export interface DispatchRuntime {
  attempt_id: string
  mode: 'new' | 'resume'
  started_at: string
  requested: RuntimeConfig
  observed: RuntimeConfig
  status: 'verified' | 'mismatch' | 'unverified'
  source?: 'native_context' | 'cli_result'
  session_id?: string
  turn_id?: string
}
export interface DispatchSelection {
  evaluated_at: string
  family: AgentDispatchFamily
  reason: string
  candidates: readonly { family: AgentDispatchFamily, ok: boolean, quota: string, level: DispatchBalanceView['level'], read_at?: string }[]
}

export interface TaskDispatch {
  selection?: DispatchSelection
  runtime?: DispatchRuntime
  family: AgentDispatchFamily
  status: DispatchStatus
  /** 用哪只手送出去的。缺席按 `cli` 读(头一版只有命令行这一只)。 */
  hand?: DispatchHand
  /**
   * 在哪个目录里跑的。要显示 —— 「在哪个仓库改的」是验收时第一个要问的。
   * `window` 那只手也填(话是对着某个仓库说的,只是送法不同)。
   *
   * ★ **`api` 那只手可以缺席**(2026-09-22):接口这条路**不碰文件**,它只回一段字;
   * 而"让 GPT 写条小红书文案"这种活根本没有仓库。原来这一格是必填的,
   * 为它编一个目录出来正是 D13 说的那种编 —— 所以改成可缺,由三只手各自如实填。
   * 命令行与窗口那两只手在入口处仍然必填(http.ts 那条路由把着)。
   */
  cwd?: string
  /**
   * 子进程 pid。**「停掉」按钮的唯一依据**:事务官没报 pid 就停不了它,
   * 那时卡面上那颗按钮不出现(不画一颗点了没反应的按钮,D13)。
   */
  pid?: number
  started_at: string
  /** 结束时刻。还在跑就缺席。 */
  ended_at?: string
  /**
   * 失败原因的**原话**(退出码、报错第一行),或完成时那一句结果摘要。
   * 事务官报什么就存什么,服务端不替它编(D13)。
   */
  note?: string
  /**
   * 那家交回来的**回答原文**(2026-09-24,卡 F)。命令行那只手 = `-o` 那个文件里的最后一条消息;
   * 接口那只手 = 上游回的那段话。截到 4000 字。它就是手机上「汇报」那一格显示的东西。
   */
  reply?: string
  /** 命令行那只手的结果文件(`codex exec -o`)。工作台重启之后靠它把没收完的结果收回来。 */
  output_file?: string
  /** 命令行那只手在那家留下的会话 id(`codex exec --json` 的 thread id),写进 links 让首页只数一次。 */
  session_id?: string
  /**
   * **不是没做成,是停下来的**(2026-09-25,卡 O):`user` = 他点了「停掉这一件」;`cap` = 到时长上限先停下来了
   * (卡上在问他继续 / 停掉 / 换一家)。状态照旧记 `failed`(这一次没做完;老宿主照旧认得),界面与收件箱不按失败染红、不问「要我自己来吗」。
   */
  stopped?: 'user' | 'cap'
  /** 这件活是什么类型(写代码 / 聊天;卡 O)。到上限要换一家时按它挑能做的那几家。缺席 = 老记录。 */
  kind?: JobKind
  /**
   * **这件命令行活的时长上限(分钟)**(2026-10-23,卡「派活给名片的四处」③):派出那一刻按名片
   * `budget.minutes`(没写按命令行家缺省 120)解析好记下,巡检到点照它停。缺席 = 老记录,退回全局设置。
   */
  budget_minutes?: number
  /**
   * 在独立工作区里跑时的分支(卡 O,统筹拍板 ②:别的项目的写代码的活也不在他那份目录里改)。
   * 工作台自己的仓库另记在 `self_ship`;别的项目记在这里(`workbench/<名>`),改完他看过再合。
   */
  branch?: string
  /**
   * ★ 这一轮的**派发基线**(2026-10-28,任务书「按产物核三个洞」洞1):派出那一刻工作树所在的提交
   * (`git rev-parse HEAD` 于 dispatch.cwd)。交回核验的 diff 类与这一格比,不跟 HEAD 比 —— 命令行执行者
   * 的规矩是提交并推分支再交回,交回那一刻树干净、HEAD 就是它自己的提交,跟 HEAD 比永远「没有改动」。
   * 缺席 = 老记录:核验退回 `git merge-base HEAD main`,再算不出如实「核不了」,不放行。
   */
  base_sha?: string
}

/* ──────────────────────── 改工作台自己(2026-09-23,断点 C)──────────────────────── */

/**
 * 那条闭环的八步。id 的唯一定义处在 `server/selfShip.ts`,这里只是把它的形状写给界面看。
 *
 * ★ **跑的顺序是 `SELF_SHIP_STEPS` 那个数组**,不是这一行联合类型的字面量顺序 ——
 * 2026-09-23 起 `record` 在 `apply` 之前(热更新会把那个进程换掉,记录留到那之后就写不成了)。
 */
export type SelfShipStepId = 'guard' | 'test' | 'merge' | 'version' | 'commit' | 'publish' | 'apply' | 'record'

export type SelfShipStepStatus = 'ok' | 'failed' | 'skipped' | 'pending'

export interface SelfShipStepView {
  id: SelfShipStepId
  /** 这一步在卡上叫什么(人话)。 */
  title: string
  status: SelfShipStepStatus
  /** 成了写做了什么,没成写**原话**。服务端从事实拼,不经模型。 */
  note?: string
  at?: string
}

/**
 * 一条需求「改自己」这件事此刻是什么样(2026-09-23)。
 *
 * **两件事合在一个字段里**:派活之前开的那条分支,以及验收通过之后那条闭环跑到哪了。
 * 不拆成两个字段的理由与 `client_dispatch` 不并进 `dispatch` 正好相反 ——
 * 这两件事说的是**同一条需求的同一条路**:分支是它的起点,发版是它的终点,
 * 卡上要显示的也是这一条线(「在 feat/xxx 上做 → 停在第 3 步」)。
 */
export interface TaskSelfShip {
  /** 在哪条分支上做。`POST /feature/branch` 之后才有。 */
  branch?: string
  /** 那条分支的 worktree 在哪。 */
  worktree?: string
  /** 闭环此刻的样子。`running` = 正在跑那八步。 */
  status: 'branched' | 'running' | 'ok' | 'failed'
  /** 停在哪一步(`failed` 才有)。 */
  stopped_at?: SelfShipStepId
  /** 停下来的**原话**。收件箱那一条与电话里念的就是它。 */
  note?: string
  /** 发出去的那一版(走到第 4 步之后才有)。 */
  version?: string
  /** 之前那一版。 */
  previous_version?: string
  /** 八步各自跑成什么样。跑过才有。 */
  steps?: readonly SelfShipStepView[]
  started_at: string
  ended_at?: string
}

/**
 * 一个功能点关联的 agent 窗口(Ben 的原话:"进行中的应该有窗口的 ID……允许一个功能点
 * 有多个任务 ID,当然也支持有多个 Agent,可能中间因为额度做了交接和切换")。
 *
 * session_id 就是 /state.sessions 里那个 id,界面据此把卡片和真实会话对上——
 * 那条会话此刻是不是还活着、在跑还是在等你确认,由 sessions 现查,**不落盘**:
 * 落盘的状态一定会和真实会话漂移,然后开始骗人(与 RepoSignals 同一条纪律)。
 */
export interface TaskLink {
  agent: AgentId
  session_id: string
  /** 记一句这个窗口在这条功能点上干的是什么(交接时尤其有用)。 */
  note?: string
  /** Explicit source role; absent inherits the task's recorded role. */
  execution_role?: ExecutionRoleFact
}

/*
 * ★ **2026-09-25(卡 Z)这张写死的名单也删了**。原来这里是
 * `CLIENT_DISPATCH_FAMILIES = ['claude','codex','kimi','doubao','muse','manus']`
 * ——「能被送话进窗口的那几家」。现在换成一句现算的:**登记表里那一条给了包标识,它就有窗口那只手**
 * (`server/dispatchTargets.ts` 的 `handsOf` / `windowTargets`)。
 * 能力体检那几家也是这么来的(原来 `CapFamily = ClientDispatchFamily`)。
 *
 * `codex` 与 ChatGPT 桌面版仍然是同一个 app(`com.openai.codex`,应用名 ChatGPT):
 * 这台机器上 `osascript -e 'id of app "ChatGPT"'` 与 `"Codex"` 回的是同一个 bundle id,
 * 所以登记表里也只有一条 —— 界面上不会出现两格指着同一扇窗。GPT 那一家干脆没有 App(`noWindow`)。
 */
export type ClientDispatchFamily = string

/** 卡面小标上写的名字。同 {@link DISPATCH_FAMILY_TITLES}:拿不到登记表时的退路,认不出的原样显示。 */
export const CLIENT_DISPATCH_TITLES: Readonly<Record<string, string>> = DISPATCH_FAMILY_TITLES

/**
 * 送进窗口之后,**回答收回来没有**(2026-09-24,卡 F)。
 *
 * - `waiting` 送出去了,工作台在读那扇窗等回答(只有 `dispatchRun.ts` 起的派活才有这一格,
 *   老的「只送不收」记录没有它 —— 读的一方据此只盯新的那几条);
 * - `done` 回答读回来了,在 `reply` 里,事项已挪到「等我确认」;
 * - `unreadable` 等够了也没读到(他切走了那条对话、或者这家的对话区读不出字)——
 *   **如实写「已发出,结果要你到 X 里看」**,不假装收回来了;
 * - `canceled`(2026-10-28,任务书「取消要收场执行者」)= 她取消了这张卡:已往那条会话
 *   捎了「这件取消了,停下」,卡上不再等它交回(它真交回来也不再收、只留一条评论)。
 */
export type ClientDispatchReplyState = 'waiting' | 'done' | 'unreadable' | 'canceled'

/**
 * 这个值看上去是一家能送话进窗口的。**开集**(同 `isAgentDispatchFamily`):
 * 真要确认「它有没有窗口那只手」问登记表(`dispatchTargets` 里那一条有没有 `bundle_id`)。
 */
export function isClientDispatchFamily(value: unknown): value is ClientDispatchFamily {
  return isAgentDispatchFamily(value)
}

/**
 * 一次「送话进窗口」的结果。**三档**:发出去了(`sent`)、**写进框里了但没发出去**(`typed`)、
 * 没送成(`failed`)。
 *
 * 没有「进行中」——那是 ②③ 的事(气泡已经知道谁在跑、谁在等确认),由会话流现查,
 * 不在这里存第二份(与 TaskLink 同一条纪律:落盘的状态一定会和真实会话漂移,然后开始骗人)。
 *
 * ## 为什么多出 `typed`(2026-09-28,卡 WR)
 *
 * 统筹 09-28 10:07 真机(维护者本机 + Manus):那一次 `client_dispatch` 记的是
 * `{status:'sent', submitted:false}`,事项还被挪进了「在办」—— 统筹截屏亲眼看到那段字**停在
 * Manus 的输入框里**,一个字都没发出去。**状态在撒谎**:`sent` 这个词在卡上、在电话里、
 * 在收件箱里都被当成「已经交给它了」。
 *
 * 从此:要我们按发送(`submit`)而**壳回 `submitted !== true`** 时一律记 `typed`,
 * 事项不进「在办」(进「卡住了」并说清「字写进去了,你去按一下发送」)。
 */
export type ClientDispatchStatus = 'sent' | 'typed' | 'failed'

/**
 * 送话那一次记在卡上的东西(2026-09-21)。
 *
 * `text` **原样存**:卡面上要把送出去的那段话一字不改地显示出来(卡上的规矩第 4 条)——
 * 用户得能看见我们以他的名义说了什么。
 */
export interface TaskClientDispatch {
  cwd?: string
  selection?: DispatchSelection
  runtime?: DispatchRuntime
  /**
   * 固定 `'window'` —— 就是 `DispatchHand` 里派活那张卡留出来的第三只手
   * (它那份注释里写着「`window` …… 谁在做:`feat/dispatch-into-client`」,这就是那一支)。
   *
   * 为什么不把这次记录并进 `TaskDispatch`:那条记录的骨架是 `cwd` + `pid` +
   * running/done/failed,而送话进窗口**没有工作目录、没有子进程**,状态也只有两档。
   * 硬并进去就得给 `cwd` 编一个值,而 D13 说的就是别编。
   */
  hand: 'window'
  family: ClientDispatchFamily
  status: ClientDispatchStatus
  /** 送出时刻(ISO)。会话匹配的基线时刻就是它。 */
  at: string
  /** 送出去的原话,原样。 */
  text: string
  /** 用的哪条路:`ax_value`(直接写属性)/ `paste`(剪贴板粘贴)。壳报什么存什么。 */
  method?: string
  /** 有没有替他按下发送。缺省 false —— 按回车是用他的账号真跑一次会话,得他自己来。 */
  submitted?: boolean
  /** 没送成时的原因**原话**(壳报的那一句),服务端不替它编。 */
  reason?: string
  /**
   * 认出来的那条会话(送出之后那家新出现的会话)。匹配规则见 `server/dispatchClient.ts`
   * 的 `matchNewSession`:**认不准就空着**,宁可这一格没有,也不能指到别人的会话上。
   */
  session_id?: string
  /** 认上会话的时刻(ISO)。 */
  matched_at?: string
  /** 没认上时的一句话(「同时冒出两条,认不准」「还没等到它开新会话」)。 */
  match_note?: string
  /**
   * 送进去的是它的**哪一轮**(2026-10-03;协议型对端自己报的,Codex 的 turn id)。
   * 盯窗读回话时只认这一轮 —— 她自己又在那条线程里发了一句也不会把她那一轮当成我们这件的结果。窗口型缺席。
   */
  turn_id?: string
  /**
   * 送出**那一刻**那家已经有的会话 id(基线)。之后拿它做差集认新会话。
   *
   * 为什么存基线而不是存一个时刻:会话视图里**没有开始时刻**(只有 `elapsed_sec` 与
   * `updated_at`,而 `elapsed_sec` 在状态变化时归零,它不是会话年龄)。拿 `updated_at`
   * 当开始时间去比大小,第一条被人动过的老会话就会被认成新的。
   */
  baseline?: readonly string[]
  /**
   * 送进去那句话开头的记号(「工作台派活 1a2b3c」,2026-09-24 卡 F)。读回复时拿它在那扇窗里
   * 找到**我们那一句**,只读它后面的字 —— 那之前是他自己的东西,不读。
   */
  marker?: string
  /** 送之前先开了新对话没有:那家菜单项的名字(`New Chat` / `新聊天` …),或 `single_thread`(Muse)。 */
  new_conversation?: string
  /** 回答收回来没有(见 ClientDispatchReplyState)。 */
  reply_state?: ClientDispatchReplyState
  /** 读回来的回答原文(去掉了界面上的按钮字、时间戳),截到 4000 字。 */
  reply?: string
  /** 回答收回来的时刻(ISO)。 */
  reply_at?: string
  /** `unreadable` 时那一句(「已发出,结果要你到 Muse 里看」)。 */
  reply_note?: string
  /** 按他的规矩自查没过、打回同一条对话让它改过几次(卡 K 的自查;最多 1 次)。 */
  rework?: number
  /**
   * 他在那家输入框里**没发出去的那段字**给这一送让了位(2026-09-27,卡 DB)。
   * 缺席 = 框本来就是空的(常态)。**内容不在这里** —— 原文落在 `saved_to` 那个文件里
   * (`~/.dsh/workbench/drafts/`),卡上只留"存哪了、放回去了没有"。
   */
  draft?: {
    /** 存下来了没有。false = 没存住(原因在 `note` 里),那时这一送已经发出去了,得如实说。 */
    saved: boolean
    /** 存哪了(绝对路径)。没存住时缺席。 */
    saved_to?: string
    /** 送完原样放回那家输入框了没有。 */
    returned: boolean
    /** 给他看的那一句(由 `server/clientDrafts.ts` 的 `draftSavedNote` 出,服务端不另编)。 */
    note: string
  }
  /**
   * **真送进去的那个包**(2026-09-30 止血,根子 1 / 3)。一家装着两个 App 时(Air 上只有
   * `com.work.pc.doubao`)按家名回主包会读到另一扇窗 —— 读回话、核「看见没看见」一律先用这一格。
   * 缺席 = 0.4.72 之前记下的老记录,照旧按家名找包。
   */
  bundle_id?: string
  /**
   * **在它对话区里亲眼看见我们那一句的时刻**(ISO)。这是「已送达」的唯一凭据:
   * 壳回执说「按了发送」不算数(豆包真机:发出去了回执说没发,Manus 真机:没发出去回执说发了)。
   * 缺席 = 还没核上 —— 卡上就说「还没在它那边看到」,不替它说成送到了。
   */
  seen_at?: string
  /**
   * 按了发送、**当场没在它对话区里核上**时那一句(`dispatchClient` 的 confirm_note 原样)。
   * 核上了(`seen_at` 有了)就清掉。
   */
  confirm_note?: string
}

/**
 * 卡上那一格:**这一件到底派出去了没有**(2026-09-30 维护者拍板:派活成功不回电话,
 * 但看板与手机上都要一眼看得出「已送达 / 按了发送没核上 / 没派出去」)。
 *
 * 四档都只从落盘的事实算出来,不另存一份(存一份就会与真状态漂):
 * - `seen` 在它对话区里看见我们那一句了(`seen_at`),或者回答都收回来了(`reply_state==='done'`);
 * - `unconfirmed` 壳说按了发送,可我们没亲眼看见 —— 还在盯;
 * - `typed` 字写进框里了,没发出去;
 * - `failed` 根本没送成,原因在 `reason` 里。
 */
export type ClientDispatchDelivery = 'seen' | 'unconfirmed' | 'typed' | 'failed'

export function clientDispatchDelivery(dispatch: TaskClientDispatch): ClientDispatchDelivery {
  if (dispatch.status === 'failed') return 'failed'
  if (dispatch.status === 'typed') return 'typed'
  if (dispatch.seen_at !== undefined || dispatch.reply_state === 'done') return 'seen'
  return 'unconfirmed'
}

/**
 * 那一格上的人话。**手机那一份是照抄的**(`butler-app/src/items/itemsModel.ts`),
 * 由 `butler-app/tests/DeliveryLineMirror.test.ts` 读这个文件比对 —— 不靠注释同步。
 */
export function clientDeliveryLine(dispatch: TaskClientDispatch, name?: string): string {
  const who = name ?? dispatchFamilyTitle(dispatch.family)
  const why = dispatch.reason === undefined || dispatch.reason.trim() === '' ? '' : `:${dispatch.reason.trim()}`
  switch (clientDispatchDelivery(dispatch)) {
    case 'seen': return `已派出 · ${who}那边看到了`
    case 'unconfirmed': return `按了发送,还没在${who}那边看到 —— 我在盯着`
    case 'typed': return `没派出去:字写进${who}的输入框了,没发出去`
    case 'failed': return `没派出去${why === '' ? `:${who}那边没送成` : why}`
  }
}

/**
 * 交付物的四种形态(2026-09-09,待办第 5 条「任务卡挂交付物与费用」)。
 *
 * 借的是 Multica 那句「work lands in review, not in main」——**验收的对象是产物,不是一句
 * 「完成」**(docs/superpowers/research/2026-09-09-竞品-Multica与DeerFlow.md);只借思路,
 * 界面颗粒度按我们现有看板:交付物只是卡上一个可选清单,不另起审阅流。
 *
 * - `branch`:一条分支(ref = 分支名,repo = 仓库路径),从项目区扫到的 `RepoSignals.branches` 里挑
 * - `diff`:一份 diff/patch 文件或一段提交区间(ref 自由填,repo 可选)
 * - `file`:一个文件的绝对路径(可从收件箱「归到项目」的落点直接带入)
 * - `url`:一个链接
 */
export type TaskDeliverableKind = 'branch' | 'diff' | 'file' | 'url' | 'reply'

export const TASK_DELIVERABLE_KINDS: readonly TaskDeliverableKind[] = ['branch', 'diff', 'file', 'url', 'reply']

/**
 * 弹窗里能手挂的那几类。`reply`(会话的回答)**只由工作台在会话结束时挂上**(server/butlerLifecycle.ts),
 * 不给人手敲——手敲一句"回答"等于替事务官编一句它没说过的话(D13)。
 */
export const MANUAL_DELIVERABLE_KINDS: readonly TaskDeliverableKind[] = ['branch', 'diff', 'file', 'url']

/** 交付物的中文名。放协议层的理由同 STATUS_TITLES:服务端拒绝时要说人话,两边各一份会漂。 */
export const DELIVERABLE_TITLES: Record<TaskDeliverableKind, string> = {
  branch: '分支',
  diff: 'diff',
  file: '文件',
  url: '链接',
  reply: '回答',
}

/**
 * 一件交付物。ref 是那件东西本身(分支名 / 路径 / 链接 / 区间),repo 只对 branch / diff 有意义
 * (哪个仓库的分支)。**只留痕,工作台不回查它**:分支被删了、文件被挪了,卡上这一条照旧在——
 * 它记的是「交回来的是什么」,不是「它现在还在不在」(与 TaskSource.ref 同一条纪律)。
 */
export interface TaskDeliverable {
  kind: TaskDeliverableKind
  ref: string
  repo?: string
  /**
   * 依据:这件交付物出自哪条会话(2026-09-16 事项生命周期闭环)。只有 `reply` 有——
   * 会话 done 时工作台把摘要挂上来,`ref` 是那句话,这里记的是它从哪条对话来的,点开能对证。
   */
  session_id?: string
}

/** 卡片是从哪来的。manual=在看板上手敲;其余三种是「一键转卡」的三个入口。 */
/**
 * 转卡来源。`meeting` 是 2026-09-21 会议模式加的:会议纪要里那几条待办建成卡时带它,
 * **纯留痕**——看板上看得出这张卡是从哪一场会来的,工作台不回查它(同 TaskSource.ref 的纪律)。
 */
export type TaskSourceKind = 'manual' | 'note' | 'session' | 'file' | 'meeting'

/** 转卡来源。ref 是来源侧的标识(会话 id / 文件路径),纯留痕,工作台不回查它。 */
export interface TaskSource {
  kind: TaskSourceKind
  ref?: string
}

/**
 * 冲刺里的一条组成版本号(Ben 的原话:"客户端版本号 V0.1,后端版本号 V0.1")。
 * label 是这条版本管的是哪一块,version 是版本号本身,两者都由 Ben 自己填,不推断。
 */
export interface SprintVersion {
  label: string
  version: string
}

/** 一个冲刺。goal 是冲刺目标——空着就是还没想清楚,界面如实显示"还没写冲刺目标"。 */
export interface SprintView {
  id: string
  project_id: string
  name: string
  goal?: string
  versions: readonly SprintVersion[]
  /** 起止日期(YYYY-MM-DD)。缺省表示还没排期,界面留白,绝不替他编一个。 */
  starts_at?: string
  ends_at?: string
  created_at: string
  updated_at: string
  /**
   * 本冲刺的排期风险(2026-09-09),截止日取 ends_at、任务取本冲刺各模块下的卡——与项目行同一口径。
   * 组装 /state 时现算,**不落盘**(tasks.json 里没有这个字段,读到也忽略)。
   */
  risk?: ScheduleRisk
}

/** 冲刺里的一个模块。看板上一条横向泳道就是它。 */
export interface BoardModule {
  id: string
  sprint_id: string
  name: string
  /** 这个模块在本次冲刺里的目标。 */
  goal?: string
  /**
   * 这个模块算哪条组成版本(取 SprintView.versions 里某条的 label,如「客户端」「后端」)。
   *
   * 为什么不是把模块**等同于**端:Ben 预设的模块就是"客户端模块/后端模块",而这一版
   * 拆出来的是"选歌大脑/播放与搜索"这类功能域。两种拆法都成立,真正对不上的是版本号
   * 该挂谁——挂模块名就逼着他按端拆,挂冲刺又粗到分不出前后端各自到哪一版。所以版本
   * 留在冲刺上(一组),模块只**指一条**。按端拆就一一对应,按功能域拆就标一下算哪端。
   *
   * 只存 label 不存版本号本身:版本号会往前走(V0.1 → V0.2),存了副本就要两处一起改。
   */
  version_label?: string
  created_at: string
  updated_at: string
}

/** 一个功能点,就是看板上那张卡。层级的叶子。 */
export interface TaskView {
  id: string
  title: string
  /**
   * ★ **卡名来源**(2026-10-23,卡 A「同事项接续与动作契约」;需求 3.6「改名各有归属」)。
   *   - `'session'`:这张卡的标题借自来源会话的名(placeSession 建卡时带的名)→ 来源会话改名,卡跟着改
   *     (`sessionTitleFallback.ts` 的 `syncBorrowedCardTitles`);
   *   - `'custom'`:用户手动改过卡名 → 从此不再被来源覆盖。
   * 缺席 = 老卡 / 从没借过名:不跟着任何会话改。与 211d2977d 那一条(无名会话借卡标题)方向相反、两条并存。
   */
  title_from?: 'session' | 'custom'
  /**
   * 这句话落下时事务官回她的那一句(2026-10-24,卡 1a):电脑浮窗/全屏/手机同一来源,
   * 由「落地」口执行后写在卡上;手机 `chatModel` 优先显示它,不另拼。
   */
  say_note?: string
  /** 功能描述。展开卡片才看得到,列表态只显示标题。 */
  desc?: string
  status: TaskStatus
  /**
   * 卡在「阻塞」列时可挂的原因,与会话的等待原因**同一套 id**(WaitReason)。
   * 由 Ben 在弹窗里选,不推断;离开「阻塞」列时服务端清掉(原因是「为什么卡住」,不卡了它就是陈旧信息)。
   */
  block_reason?: WaitReason
  /**
   * 归哪个项目(WorkbenchProject.id)。缺省 = 未归项目。
   * **即使挂了模块也照样存**:模块→冲刺→项目那条链任何一环被 Ben 手动删掉时,
   * 卡不该跟着失去归属漂到别的项目下面去(删冲刺不删卡,见 server/tasks.ts)。
   */
  project_id?: string
  /** 归哪个模块。缺省 = 该项目的「未归模块」泳道。 */
  module_id?: string
  /**
   * 这是哪一种事项(2026-09-21 选题池)。**缺省 = 普通事项**,也就是今天看板上那些卡:
   * 「做产品」模板下这个字段永远不出现,所有既有行为一字不变。
   */
  kind?: TaskKind
  /** 选题的内容类型(图文 / 视频)。**只有 `kind: 'topic'` 才有意义**;普通事项身上不该出现。 */
  content_type?: TopicContentType
  /**
   * 选题的创作进度(六段之一)。缺省 = 还没写过进度,界面按 DEFAULT_TOPIC_STAGE(灵感)那一列摆,
   * **但不替他往盘上写一个他没选过的值**(同 status 那条老数据兼容的分寸)。
   */
  stage?: TopicStage
  /**
   * 需求卡走到哪一态(四态之一,2026-09-22)。**只有 `kind: 'feature'` 才有意义**。
   *
   * 为什么不跟选题挤同一个 `stage`:那个字段的值域是六段(灵感 … 复盘),
   * 塞进「梳理」「验收」之后,`TOPIC_STAGE_TAB[task.stage]` 这类按段查表的地方
   * 会拿到 undefined —— 同一个字段在两种卡上说两件事,是"一个词两个真相"的老毛病。
   * 缺省 = 还没写过进度,界面按 `DEFAULT_FEATURE_STAGE`(梳理)摆,但不替她往盘上写。
   */
  feature_stage?: FeatureStage
  priority?: TaskPriority
  /** 负责人。只有一个;实际干活的窗口在 links 里,可以有好几个、跨好几家。 */
  assignee?: TaskAssignee
  /**
   * 负责人那一格的补充(2026-09-25,卡 N):「9/29 回来写」「接手做」。负责人是人(他 / 同事 / 别人)时才有意义,
   * **不参与任何判断**,只跟在名字后面给人看。缺席 = 没有补充。
   */
  assignee_note?: string
  /**
   * 谁管这件事:派活与验收的那一方(2026-10-27,协作区与事务官标签页合并 §3.1)。
   * 建卡 / 派活那一刻写下的事实:事务官建的、派的写 `'dsh'`(事务官在负责人表里的 id);
   * 统筹手派时只能写真实的合法值(如 `'me'`),不许记成事务官。缺席 = 不知道,界面不写、不猜。
   * 判据与负责人同一套(`isTaskAssigneeValue`)。
   */
  manager?: TaskAssignee
  /** 预期结束时间(YYYY-MM-DD)。 */
  due?: string
  /**
   * 选题的**计划发布日**(`YYYY-MM-DD`,2026-09-22 发布计划两状态;Ben 原话:
   * 「其实是未发布和已发布的部分,我认为这是两个状态」)。缺席 = 还没排过计划。
   *
   * **与 `due` 分开而不是复用它**:`due` 是普通事项的预期结束时间,今天看板上那些卡身上
   * 就有(「做产品」模板一直在用)。把"这条内容打算哪天发"塞进同一个字段,等于让同一个
   * 词在两个模板下说两件事,而月历要按"发没发"分两个视图时就再也分不出哪个是哪个了。
   */
  planned_at?: string
  /**
   * 选题的**实际发布日**(`YYYY-MM-DD`)。**有值 = 已发布**,月历的两个状态就按它分:
   * 缺席进「未发布」视图(按 `planned_at` 摆),有值进「已发布」视图(按它自己摆)。
   *
   * 由「推进一步」碰到「发布」那一段时盖上(见 server/tasks.ts advanceTopic),
   * 也可以在卡片上手改 —— 真发出去的那天只有 Ben 知道,我们记的只是个默认值。
   */
  published_at?: string
  /** 关联的 agent 窗口。交接过就有多条,顺序即添加顺序(先干的在前)。 */
  links?: readonly TaskLink[]
  /**
   * 事项的方向(2026-09-10)。**落盘的只有 `mine`**——从收件箱底部输入框建出来的那一批;
   * 看板上原有的卡一张都没有这个字段,它们不是"事项",只是卡(缺省即不属于任何方向)。
   * 「事务官交给我」不写进这里,由服务端现拼(见 TaskDirection 的注释)。
   */
  direction?: TaskDirection
  /**
   * 这条事项是谁写下的(2026-09-25):他亲口交代 / 通话纪要 / 引导排的 / 会议来的。见 {@link TaskOrigin}。
   * 缺席 = 老卡,读的时候走 `taskOriginOf` 按形状认。
   */
  origin?: TaskOrigin
  /** 这张卡是一通电话的纪要(2026-09-25)。只有 `origin:'call'` 的卡才有。见 {@link TaskCallMeta}。 */
  call?: TaskCallMeta
  /**
   * 「只是问了一句」(2026-09-25,卡 Y;维护者:随手问一句、试一下**不算一件事**)。
   *
   * 她答完那一刻自己判的:这一轮**没派出去、没改文件、没有要交回的东西** → 盖这个章、卡进「完成」,
   * **不进「等我确认」、不要他验收、不打电话**(判据只有一处:`server/casualAsk.ts` 的 `casualAskVerdict`)。
   *
   * 三条边界:
   * - **卡与对话都留着**(不可改清单第 5 条:系统不许替他扔东西)。看板主视图上不占位
   *   (`client/boardModel.ts` 的 `tasksInCell` / `tasksInStatus` 把它挑掉),事务官档「办完」那一摞里找得到,
   *   点开就是那段对话;
   * - **只有服务端自己写**(会话结束那一步),`/task/update` 不接这个字段 —— 它是事实的转述,不是给人编辑的(同 `note`);
   * - 他把这张卡从「完成」拖回「进行中」时章跟着擦掉(他说它是一件事,那它就是一件事)。
   */
  casual?: boolean
  /**
   * ★ **她看过这件事的结果了**(2026-10-04,卡 `claude/answer-comes-to-her`;ISO 时刻)。
   *
   * 维护者 10-04:「信息直接从正在办切到办完了,我是自己追过去点开查看的」。从此办完的事
   * **先在首页挂一张「刚办完 · 结果一句话」**(`/state.fresh_results`),她点开看过、或者划掉,
   * 才盖这一格、收进「办完」那一摞。
   *
   * 三条边界(照 `casual` 那一格的先例):
   * - **这是她这一端的状态,不是这件事的状态**。所以不新开一个事项状态:状态表是人摆卡的地方
   *   (见 {@link FreshResultView} 文件头那一段),这一格只回答「她看过了没有」。
   * - **两端同步**:手机看过、电脑那张也收(服务端就这一格,`POST /task/seen-result`)。
   * - **老客户端不认这一格** → 它们照旧现在的样子(办完的事直接摆进「办完」),一处都不用改。
   */
  seen_result_at?: string
  /** 这条事项底下那段 DSH 会话(一事项一会话)。开不出会话时整个字段缺席 = 界面显示「会话未开」。 */
  conversation?: TaskConversation
  /**
   * 最近一次「把话送进那家客户端的窗口」(2026-09-21)。缺席 = 没往窗口派过活。
   *
   * **同一时刻只存一次**:再派一次就覆盖(与派活那张卡的 `dispatch` 同一条取舍)——
   * 卡面要回答的是"这段话送到哪儿去了",经过在那条会话里。
   */
  client_dispatch?: TaskClientDispatch
  /**
   * 交办时是哪一档(2026-09-24,统一输入框「模式 = 权限」)。**建下时定,之后改档不影响这一件**。
   * 缺席 = 输入框出现之前建的卡(当「先问我」读)。
   */
  mode?: ComposerMode
  /** 交办时带的附件(只记名字与是不是图,文件本身在电脑的收件文件夹里)。 */
  attachments?: readonly TaskAttachment[]
  /**
   * 交付物清单(2026-09-09)。可选:没有就是没有。进入「等我确认」时卡上一件都没有,
   * 卡面提示「没有可验收的东西」——**只提示,不阻止**:状态机的转换表一个字不改。
   */
  deliverables?: readonly TaskDeliverable[]
  /**
   * 工作台记在卡上的一句话(2026-09-16 事项生命周期闭环):会话怎么结束的——出错原话、
   * 「你停了它」、「会话未开」。**只由服务端写**,不给人在弹窗里编辑;下一次会话结束时被覆盖或清掉,
   * 会话正常答完(进「等我确认」)时清掉——那时该看的是交付物里的回答。缺省即没有话要说。
   */
  note?: string
  /**
   * 这条事项**派给了别家**(2026-09-21)。缺席 = 没派过 / 事务官自己办。
   * **只由服务端写**(POST /butler/item/dispatch,事务官报什么写什么),/task/update 不接这个字段。
   */
  dispatch?: TaskDispatch
  /**
   * ★ **这件委托的执行身份与恢复记录**(2026-10-29,可靠执行闭环第一批第 1 步;
   * 形状唯一定义在 `server/taskExecution.ts`)。阶段 + 下一动作 + 版本:所有「下一步该谁做」
   * 由它回答,重启后未完成委托从它接回(不依赖 jobLog —— 那本会裁掉)。
   *
   * **只由推进职责写**(`server/taskExecutionStore.ts` 的 compareAndSet,串行比较版本),
   * `/task/update` 不接这个字段 —— 理由与 `dispatch` 逐字相同:它是一份事实记录,不是给人编辑的状态。
   * 老卡没有这一格时由存储读侧从 `dispatch` / `client_dispatch` / `receipt` 导入,导不出确定阶段的
   * 记为 `reconciling`(待对账),不直接重派。
   */
  execution?: ExecutionRecord
  /**
   * 这条需求**改的是工作台自己**,而且那条闭环跑过了(2026-09-23,断点 C)。
   * 缺席 = 没跑过 / 这条需求不是「改自己」。
   *
   * **只由服务端写**(`POST /feature/branch` 与 `POST /feature/ship`),
   * `/task/update` 不接这个字段 —— 理由与 `dispatch` 逐字相同:
   * 它是一份"发生过什么"的记录,不是她能在弹窗里编辑的状态。
   */
  self_ship?: TaskSelfShip
  /**
   * 派活挑不到能做这件活的手(2026-09-25,卡 O):写代码的活而那家只能聊天 / 命令行没登录……
   * 卡挂「阻塞」、这一格说清为什么并给修法与能换的几家。**只由服务端写**;重新派出去就清掉。
   */
  dispatch_block?: TaskDispatchBlock
  /** 在那一家窗口通道里排着 / 正送着 / 读不动(2026-10-21,见 {@link TaskDispatchLane})。只由服务端写。 */
  dispatch_lane?: TaskDispatchLane
  /**
   * 这件事的花费 / 时长上限(2026-09-25,卡 O):**只有事务官自己在办的**(挂着 DSH 会话的)才有。
   * 落盘的是上限、状态与他说过几次继续;花了多少、跑了多久是 /state 组装时从会话用量现算的。只由服务端写。
   */
  budget?: TaskBudgetView
  /**
   * 完成时刻(ISO)。move 到 `done` 时盖章,离开 `done`(重开)时清掉(2026-09-09 排期风险)。
   * 为什么不用 updated_at 顶:完成之后改个标题它就变了,速度就跟着虚高。
   * 这个字段出现之前就完成的老卡没有它,速度计算退回用 updated_at(见 scheduleRisk.ts)。
   */
  done_at?: string
  /**
   * 现在到哪(2026-09-25,卡 N「进度靠证据」):证据评估器的结论 —— 一句话 + 依据 + 什么时候看的。
   * **组装 /state 时从 progress.json 挂上,不落 tasks.json**(同 SprintView.risk 的纪律;
   * tasks.ts 的 sanitizeTask 只抄认得的字段,这一格写不进盘)。缺席 = 还没评估过。
   */
  progress?: TaskProgressView
  /**
   * 现在该谁动(2026-09-25,卡 N):事项按这个排(看板按项目 / 冲刺排,同一张卡两种排法)。
   * 组装 /state 时现算(`server/itemMover.ts`),不落盘。缺席 = 老服务。
   */
  mover?: TaskMoverView
  /**
   * 没办完的事项停在哪(2026-10-12,卡「没办完的事项说清楚」):最后一条证据、在等谁、下一步,以及是哪一种停法。
   * 组装 /state 时按已有证据现算(`server/itemStanding.ts`),不经模型、不落盘。办完 / 取消 / 待排 / 不是事项的卡缺席。
   */
  standing?: ItemStandingView
  /**
   * ★ **这张卡是演示用的**(2026-10-13,卡「演示数据一键放进去」;`server/demoSeed.ts`)。
   *
   * 记号与演示用那几场会(`meetings.json` 里的 `demo`)同一条纪律:**只做一个记号**,
   * 不另开一套存储、不改任何既有行为。两个用处:
   * - 人看得见的那一半不在这一格 —— 在 `desc` 第一段(「演示用 · …」),卡片与发布计划悬浮里都读它;
   * - 机器按这一格挑:「清掉演示数据」只把带它的卡挪进「取消」(`demoSeed.clearDemoData`)。
   *
   * **只有服务端自己写**(`POST /demo/seed`),`/task/update` 不接这个字段 —— 同 `dispatch` / `note`:
   * 它是「这条数据是哪来的」这件事实,不是给人在弹窗里编辑的状态。
   * 缺席 = 她自己的真数据(绝大多数卡)。老客户端读不到即当无。
   */
  demo?: boolean
  /*
   * ★ **协作区那几格**(2026-10-21,`docs/设计-协作区-无限画布-2026-10-21.md` 3.1)。全是可选的加法,
   * 老卡一格都没有、读的时候走 `goalIdOf` / `noteFromOf` 兜底;类型定义在本文件末尾「协作区」那一节。
   */
  /** 所属目标。缺席 = 「未归目标」({@link UNSORTED_GOAL_ID})。 */
  goal_id?: string
  /** 从哪来(哪场会 / 哪条会话 / 他说的哪句)。缺席 = 老卡,按 `origin` 认({@link noteFromOf})。 */
  from?: NoteFrom
  /** 做到什么算完,1–3 条短句。派活说明里带编号,回执对着编号答。 */
  acceptance?: readonly string[]
  /** 交回的那一句,只许三种({@link NoteReceipt})。只由服务端写(派活读回 / `POST /task/receipt`)。 */
  receipt?: NoteReceipt
  /** All source-specific receipts, retaining parallel returns and prior rounds. */
  receipts?: readonly NoteReceipt[]
  /** Sanitized request-time source facts, without file paths or transcript text. */
  execution_sources?: readonly TaskExecutionSource[]
  /** Recorded role provenance; an automatically placed session is not an explicit business commission. */
  execution_role?: ExecutionRoleFact
  /** 交回来的话认不出是三种里的哪一种:章照旧按今天的现算走,章上多标「回执不规范」。只由服务端写。 */
  receipt_irregular?: true
  /**
   * 要本人拍板的结构化请求(2026-10-26,卡「事务官页接管队列」):事务官核验后,只有花钱 / 新对外发布 /
   * 本人账号与设备配对 / 习惯与范围取舍四类才标这一格,带方案与依据。标了它、章在「等我确认」的卡才进
   * 用户侧「等你」队列({@link ownerAskOf});没标的事务官先核验,不摊给本人。离开「等我确认」即被
   * 拍板 / 退回答掉(`move()` 清掉)。只由服务端写(`POST /task/owner-ask`)。
   */
  owner_ask?: OwnerAsk
  /** 自由标签。 */
  labels?: readonly string[]
  /** 子便签(id)。 */
  children?: readonly string[]
  /** 关注这张的人 / 名片(阶段二起回执只通知负责人与关注者)。 */
  watchers?: readonly string[]
  /** 自定义属性(键自由),详情里「其他」那一块,筛选条能按键筛。 */
  props?: Readonly<Record<string, string>>
  /** 组长 / 他的评估。 */
  evaluation?: NoteEvaluation
  /** 模块标签(自由文本;老冲刺下的模块迁过来时写的是模块名)。 */
  module?: string
  /** 版本号。缺席 = 继承目标的。 */
  version?: string
  /** 留言(详情底部那一块)。 */
  comments?: readonly NoteComment[]
  /**
   * 轮次(2026-10-24 契约 B/D2):`confirm→doing`(验收退回)或 `done→doing`(重开)时 +1。
   * 缺省 1。**只由服务端写**(`move()`),核验与交接按轮次对账:轮次不符的旧证据失效。
   */
  round?: number
  /** 状态经手记录(只追加,cap {@link NOTE_TRANSITIONS_MAX})。**只由服务端写**(`move()`)。 */
  transitions?: readonly TaskTransition[]
  /** 留言 / 邀请(2026-10-24 契约 §2,cap {@link NOTE_MESSAGES_MAX})。 */
  messages?: readonly NoteMessage[]
  /** 开始 / 结束时刻(ISO,带时区)。只有 `start` = 时间点卡;都缺席 = 未排时间。**只走明确字段改**,拖动不改它。 */
  start?: string
  end?: string
  /** 事项类型(四组底色)。缺席 = 按已知事实认({@link workTypeOf}),认不出就中性灰。 */
  work_type?: WorkType
  /** 协作的人 / 名片(头像标签选中时标「协作」)。负责人只有一个,在 `assignee`。 */
  collaborators?: readonly string[]
  /** 派给了哪个小队(负责人写成「小队 · 组长 → 实际负责人」)。 */
  squad_id?: string
  /** 挂上的 PR(`<owner>/<repo>#<号>`)。 */
  pull_requests?: readonly string[]
  source: TaskSource
  created_at: string
  updated_at: string
}

/**
 * 项目的排期元数据(看板自己存,不写进 projects.json)。
 *
 * **预期结束时间不在这里**:项目那一层早就有 ProjectDdl 了,再存一份两边一定会打架。
 * 这里只补 projects.json 没有的两样:优先级与执行人。
 */
export interface ProjectBoardMeta {
  project_id: string
  priority?: TaskPriority
  /**
   * 负责人(界面措辞:不是"执行人")。
   *
   * **这一格仍然只有 `AgentId` 那四家**,不跟着 `TaskAssignee` 一起放宽(2026-09-22):
   * 一整个项目归谁管,说的是"哪扇窗口在这条线上长期跑";而 GPT / 豆包是**一次性**
   * 派一件活的对象(没有会话流、没有窗口),把一个项目挂在它名下没有任何东西读得出来。
   */
  assignee?: AgentId
  /** 项目挂的仓库(2026-10-21 协作区)。派活说明与便签详情「文件与仓库」读它。 */
  repos?: readonly ProjectRepo[]
  /** 项目挂的资源:文档 / 网址 / 路径(2026-10-21 协作区)。 */
  resources?: readonly ProjectResource[]
}

/** GET /state 任务看板整块。取不到就缺省,不让整个 /state 挂掉——与 projects 同一套降级纪律。 */
export interface TasksState {
  tasks: readonly TaskView[]
  sprints: readonly SprintView[]
  modules: readonly BoardModule[]
  project_meta: readonly ProjectBoardMeta[]
  /**
   * 费用归因(2026-09-09):**已关联到某张卡的会话**各自的用量,键是 `${agent}:${session_id}`。
   * 只算卡上 links 指到的那些,不是全部会话——全量按会话切的表塞进每秒轮询是纯浪费。
   * 拿不到的会话(那家不记 token、或日志里没有这条)**整个缺席,不填 0**(D13);
   * 卡面把自己 links 里查得到的几条加起来显示「本卡消耗 x 万 token」,一条都查不到就不显示。
   * 口径沿用用量面板的「总消耗」= 入 + 缓存写 + 出(2026-09-02 Ben 定),不含缓存读。
   * 每次组装 /state 现算,不落盘。
   */
  session_usage?: Record<string, UsageTotals>
  /**
   * tasks.json 读不出来时给人看的一句(2026-10-21):此刻看板是空的、改动一律不写、原文件没动、
   * 另存在哪。缺席 = 读得好好的。只加可选字段,展示台与手机不读也不坏。
   */
  problem?: string
  /*
   * ★ 协作区(2026-10-21)。缺席 = 老服务。`sprints` / `modules` 迁成目标后**再留一个版本只读**,之后删。
   */
  /** 目标(板上的区域)。 */
  goals?: readonly CollabGoal[]
  /** 可选的冲刺:一段时间里要推的几个目标。 */
  goal_sprints?: readonly CollabSprint[]
  /** 本机登记的 Agent 名片。 */
  agent_cards?: readonly AgentCard[]
  /** 他直接开的会话「放进哪个目标?」(现算,不落盘;只有一个目标时不问,见 `session_placed`)。 */
  session_proposals?: readonly SessionProposal[]
  /** 只有一个目标时事务官直接放进去的会话:「等你」里那行已办说明(他换过目标 / 撤掉 / 点开看过就没了)。 */
  session_placed?: readonly SessionPlaced[]
  /** 小队、定时派活、工作室 MCP 库(2026-10-21 协作区全量)。 */
  squads?: readonly CollabSquad[]
  timers?: readonly CollabTimer[]
  mcp?: readonly CollabMcpEntry[]
}

/** —— 事项收件箱(2026-09-10,事务官页 = 事项收件箱;设计-事务官形态 §六 6.1)。 —— */

/**
 * 事项的方向(Ben 2026-09-10:用户体感里没有「会话」,交互单位是**事项**,只有两个方向)。
 *
 * - `mine`   我交给事务官的:Ben 在收件箱底部输入框里打的那一句,服务端替它开一条 DSH 会话。
 * - `butler` 事务官交给我的:要我确认 / 要我看 / 告诉我结果。
 *
 * **落盘的只有 `mine`**。「事务官交给我」那一半是服务端**每次组装 /state 现拼**的
 * (见 server/butlerInbox.ts):它的四个来源(等我确认的卡、等审批的 DSH 会话、哨兵命中、
 * 排期赶不上)本来就各有各的事实源,再落一份盘就等于把同一件事记两遍,然后开始互相打架
 * ——与 RepoSignals / session_usage 同一条纪律(现算不落盘)。
 *
 * 可选字段:protocol.ts 是与 display-client 的三方契约,只能加可选字段;展示台本期不读,副本不同步。
 */
export type TaskDirection = 'mine' | 'butler'

export const TASK_DIRECTIONS: readonly TaskDirection[] = ['mine', 'butler']

/**
 * 这条 `direction:'mine'` 的事项**是谁写下的**(2026-09-25,卡 feat/first-look-orb-top)。
 *
 * - `user`       他亲口交代的一件事(收件箱 / 手机 / 电话里「交给你办」)。标题就是他那句原话。
 * - `call`       一通电话的纪要(挂断后自动落的那一张;2026-10-13 起标题写的是**聊了什么**)。
 * - `onboarding` 引导里排的方案、立项的第一步 —— 出处说明写在 desc 里,不是他说的话。
 * - `meeting`    会议纪要里挑出来的待办(话是会上大家说的,不只是他)。
 *
 * **为什么要它**:进化循环(固化提议)数的是「他反复在说的话」,以前把所有 mine 卡的 desc 都当原话,
 * 于是四条引导排的事项共用一句出处说明「引导 ②′ 排的方案「desktop-workbench」…」就被判成「这 4 次你都在说」,
 * 通话纪要的「时长:4 秒」也一样。从此**只有 `user` 才是他说的话**。
 *
 * 缺席 = 这个字段出现之前落的老卡,按 `taskOriginOf` 从形状认(只认三种写死的形状,认不出就当 `user`)。
 * additive,老客户端读不到即当无。
 */
export type TaskOrigin = 'user' | 'call' | 'onboarding' | 'meeting' | 'evidence'

/**
 * `evidence`(2026-09-25,卡 N):**证据里冒出来的下一步**(会话里他说「还要注册域名」、派出去的活交回来说「还差下载地址」)。
 * 建成「待排」的卡、在「等你确认」里问他「要加上吗」—— 他点头才挪「待办」,不要就「取消」。话不是他今天说的,
 * 所以同 `onboarding` 一样**不算他说的话**(固化提议不数它)。
 */
export const TASK_ORIGINS: readonly TaskOrigin[] = ['user', 'call', 'onboarding', 'meeting', 'evidence']

export function isTaskOrigin(value: unknown): value is TaskOrigin {
  return typeof value === 'string' && (TASK_ORIGINS as readonly string[]).includes(value)
}

/**
 * **老卡**通话纪要的标题开头。没有 origin 的老卡靠它认。
 *
 * 2026-10-13 到 10-22 落的纪要卡标题是「聊了什么」、带 `origin:'call'`,所以认卡**先看 origin**;
 * 这一格只管这个字段出现之前落的那些。2026-10-22 起通话不再建卡(落成 {@link CallRecordView}),
 * 这一套只剩认存量。
 */
export const CALL_RECORD_TITLE_PREFIX = '和事务官通了'
/** 引导里建的事项,desc 都以这两个字开头(`onboarding.ts writePlan / writeIdea`)。老卡没有 origin 时靠它认。 */
export const ONBOARDING_TASK_DESC_PREFIX = '引导'

/**
 * 一张卡是谁写下的。有 `origin` 就用它;老卡按形状认:
 * 通话纪要看标题、引导建的看 desc、会议来的看 source.kind。**只认这三种写死的形状**,
 * 其余一律当他亲口说的 —— 宁可偶尔多数一条,也不把他真说过的话漏掉。
 */
export function taskOriginOf(task: Pick<TaskView, 'origin' | 'title' | 'desc' | 'source'>): TaskOrigin {
  if (task.origin !== undefined) return task.origin
  if (task.title.startsWith(CALL_RECORD_TITLE_PREFIX)) return 'call'
  if (task.desc !== undefined && task.desc.startsWith(ONBOARDING_TASK_DESC_PREFIX)) return 'onboarding'
  if (task.source.kind === 'meeting') return 'meeting'
  return 'user'
}

/**
 * 通话纪要卡上的那一通电话(2026-09-25)。**只由服务端写**(`POST /butler/call/record`)。
 *
 * - `kind`:`onboarding` = 引导那一通(不落全文,只落一句摘要);`call` = 平时那几种(他拨的、她打来的、话筒)。
 * - `summary`:一句话摘要,**由代码从事实拼,不经模型**(引导那通按阶段机走到哪;平时那通取他开口第一句)。
 * - `duration_seconds`:知道才有。
 *
 * 手机首页「最近一次通话」读的就是最新一张带它的卡。
 */
export interface TaskCallMeta {
  kind: 'onboarding' | 'call'
  summary: string
  duration_seconds?: number
}

/**
 * ★ **一通电话是一条记录,不是事项**(2026-10-22,决策记录同日「通电话是记录不是事项」)。
 *
 * 维护者:「『和事务官通了电话』这个不叫事项,这是个记录或者说动作……如果只是闲聊,有必要建立吗?」
 * 所以从这一天起 `POST /butler/call/record` **不再建卡**:一通电话落成工作目录 `通话/` 下的一份 md
 * (`<日期>-<时刻>-<call_id>.md`)+ `~/.dsh/workbench/calls.json` 里一条索引,归材料那一类(同会议的放法);
 * 事项只从电话里说到的事来(通话里工人用工具当场建 / 挪),闲聊不建。
 * 上面那个 {@link TaskCallMeta} 与 `origin:'call'` 只剩认存量老卡那一个用处。
 */
export interface CallRecordLine {
  who: 'me' | 'butler'
  text: string
}

/** 通话里对一张卡做了什么:建了 / 挪了 / 补了一句话。 */
export type CallRecordItemDid = 'created' | 'moved' | 'said'

/** 记录上挂着的一张卡。标题是落记录那一刻的;卡后来改名了以 `task_id` 为准。 */
export interface CallRecordItemLink {
  task_id: string
  did: CallRecordItemDid
  title?: string
  /** 挪到了哪一格(`moved` 才有)。 */
  to?: TaskStatus
}

export interface CallRecordView {
  /** 这一通的编号(`call_id`;上报方没带就由工作台给一个)。 */
  id: string
  kind: 'onboarding' | 'call'
  /** 落记录那一刻(≈ 挂断)。 */
  at: string
  duration_seconds?: number
  /** 一句话:聊了什么(代码从字幕拼,不经模型;引导那一通按阶段机拼)。 */
  summary: string
  /** 一共几句(引导那一通不落字幕,这里也是 0)。 */
  lines: number
  transcript: readonly CallRecordLine[]
  /** 通话里经「电话」那一端建过 / 挪过 / 补过话的卡。 */
  items: readonly CallRecordItemLink[]
  /**
   * **可能要办**:她明说「记一下 / 帮我记」的那几句,通话里又没有对得上的卡。**只标不建** ——
   * 拿不准的事替她建一张卡,比漏标一句坏(判法在 `server/callRecords.ts` 的 `maybeTodosOf`)。
   */
  maybe_todo?: readonly string[]
  /** 记录那份 md 在这台电脑上的位置。写盘没成就缺席(索引还在)。 */
  file?: string
}

/** `/state.calls`。没接通话记录服务时整块缺席。 */
export interface CallsView {
  /** 最近几通,最新的在最前。 */
  recent: readonly CallRecordView[]
  /** 记录都落在这个目录下面。 */
  dir?: string
}

/**
 * `POST /butler/call/record` 请求体的那几格(三端对照:工人 `channel-worker/src/callRecord.ts`、
 * 手机 `butler-app/src/api/call.ts` 各有一份,用例读这一行比对)。
 *
 * - `call_id`:这一通的编号。来电那一通是台账上的 id;他拨出去的那一通由拨号的那一台编(手机 / 工人),
 *   两边报同一通靠它并成一份;
 * - `durationSeconds` / `transcript`:时长与双方字幕;
 * - `kind`:`onboarding` = 引导那一通(不收字幕);
 * - `todos`:工人带来的「要办」—— 通话里建卡那一下**工作台连不上**的那几张(`{ title, desc?, feature? }`)。
 */
export const CALL_RECORD_BODY_FIELDS = ['call_id', 'durationSeconds', 'transcript', 'kind', 'todos'] as const

/** 通话里建的卡指回那一通:`from: { kind: 'said', ref: 'call:<id>' }`。 */
export const CALL_RECORD_FROM_PREFIX = 'call:'

/**
 * 一条事项底下那段对话(一事项一会话,设计-事务官形态 §六 6.1)。
 *
 * 形状**沿用 TaskLink**(agent + session_id),不另造一套:界面拿它去 /state.sessions 里
 * 现查状态,查法与卡上的 links 逐字相同。`agent` 收窄成 `'dsh'`——一事项一会话开的是
 * 我们自己的 DSH 会话,别家(Claude/Codex/Kimi)的窗口进不来这个字段,那些仍然走 links。
 *
 * **与 links 并存不冲突**:links 记的是"实际上谁在/谁干过"(可以有好几条、跨好几家),
 * conversation 记的是"这条事项自己那段对话"(只有一条)。
 */
export interface TaskConversation {
  agent: 'dsh'
  session_id: string
  /**
   * 归档时刻(ISO)。事项完结(done / canceled)时盖章,重开时清掉。
   * **归档不是删除**:会话在 DSH 那边照旧存在,点开还能看——只是收件箱不再把它算作在办
   * (不可改清单第 5 条延伸:系统不许替 Ben 扔东西)。
   */
  archived_at?: string
}

/**
 * 「事务官交给我」的一条。四个来源各自的形状差得远,统一成这一种可渲染的条目。
 *
 * **每一条都必须能指回它的事实源**(task_id / conversation / 无),这样点开才有地方去;
 * 指不回去的就不给点,不画一个点了没反应的条目(D13)。
 */
export interface ButlerInboxItem {
  /** 稳定 id:`<kind>:<来源 id>`。同一件事在两拍之间必须是同一个 id,否则界面会闪。 */
  id: string
  /**
   * 哪一档:
   * - `confirm`  看板上停在「等我确认」的卡——事务官把活干完了,等 Ben 验收
   * - `session`  某条 DSH 会话在等(能可靠判定的只有等审批,见 dshSessionFeed 的注释)
   * - `sentinel` 哨兵盯的事变了
   * - `risk`     排期判定为「赶不上」
   * - `routine`  事务官的例程开口了(2026-09-15):开工汇报的三句加一问、下班例程的回执、每周知识 lint 的待拍板
   * - `feed`     今天的资讯里有一条值得跟进(2026-09-21):**只是建议**,点了才成事项 ——
   *              一个每天自动往看板里塞卡的东西,一周之后就没人看看板了(server/feed.ts 纪律②)
   * - `topic`    今天的资讯**按这个账号的定位提炼出来的一条选题**(2026-09-22,运营模板):
   *              标题是选题、note 是一句「为什么现在做」,两颗键「加入选题池 / 不要」。
   *              与 `feed` 分成两档而不是共用一档:那一档点开是去读一条新闻,
   *              这一档点下去是**在她的盘上建一条选题**,两件事的后果不是一个量级
   * - `dispatch` 派给别家的那次活**没做成**(2026-09-21):事务官在这里问一句「要我自己来吗」
   * - `meeting`  最近一次会议梳理完了(2026-09-21):纪要写好了,待办等他挑
   * - `evolve`   事务官提议把一件反复在做的事固化下来（2026-09-22，卡 ⑥）：**只是提议**，
   *              她点头才做 —— 一个能自己改自己的东西，没有这道门就不该存在（设计文档 §五 3）
   * - `ship`     事务官「改工作台自己」那条闭环**停在某一步了**(2026-09-23,断点 C):
   *              标题是停在哪一步、note 是**原话**。与 `dispatch` 分成两档:那一档是
   *              "别家没做成,要我自己来吗",这一档是"我自己这条路走不下去了" ——
   *              后者动的是 main 与发版链,她必须一眼看出是哪一种
   * - `file`     手机(或另一台电脑)**发来了一个文件**(2026-09-25,卡 J):落在「事务官 / 收件」里,
   *              24 小时内的最近两条。**只是让他看见**,没有按钮 —— 文件已经在那个文件夹里了
   * - `agent`    Agent 登记表的外层那一句(2026-09-25,卡 Q):「新接上一家:XX」(带「这不是 Agent」好撤回),
   *              或者拿不准的那一家「XX 像是个 Agent,要接上吗?」(「接上」/「这不是 Agent」)。见 `agent` 那一格
   * - `habit`    「它学到了什么」新开始试用一条(2026-10-10,维护者 10-09 拍板):「新学到一条:…,正在试用」+ 依据摘要,
   *              点开能「撤掉」/「知道了」。**只是让她知道**:不响铃、不打电话、不进来电;同一条只说一次。见 `habit` 那一格
   * - `quota`    剩余额度告警(2026-10-23,卡 t-8e617888):「Kimi 的 5 小时额度只剩约 10%」,带重置与读数时刻。
   *              **只是工作台消息**:不进「等你」、不触发来电;每扇窗每个周期 low 一次、empty 再一次,恢复即收。
   *              判级与额度面板同一处(`server/agentQuota.ts` 的 `quotaLevelOfPct`),去重在 `server/quotaAlerts.ts`。
   * - `spend`    额度活用建议(2026-10-28,卡 t-f68365f6,任务书「额度按到期先花」):「Kimi 的本周额度快重置了,
   *              还剩约 79%」——重置前 6 小时某扇窗还剩一半以上,把板上「待排」的研发活列成建议递给她
   *              (替你拿主意那种卡),**只提议不自动派**;她去派 / 重置过了 / 研发活派完即收,新周期再递。
   *              与 `quota` 同一纪律:只是工作台消息,不进「等你」、不触发来电;去重在 `server/quotaSpendTips.ts`。
   */
  kind: 'confirm' | 'session' | 'sentinel' | 'risk' | 'routine' | 'feed' | 'topic' | 'dispatch' | 'meeting' | 'evolve' | 'ship' | 'file' | 'agent' | 'habit' | 'quota' | 'spend'
  /** 给 Ben 看的那一句。由代码从事实拼出来,不经模型。 */
  title: string
  /** 补一句上下文(项目名、哨兵那句话、预计完成日)。没有就没有,不占位。 */
  note?: string
  /**
   * 这件事发生的时刻(ISO)。哨兵用触发时刻、卡用最后一次改动时刻;
   * 会话与排期没有可靠的"发生时刻"(会话只有"等了多久",排期是现算的),**整个字段缺席**。
   */
  at?: string
  /** 七态里的哪一格。只有 `confirm` 那一档有——另外三档根本不是卡,给不出状态(D13)。 */
  status?: TaskStatus
  /**
   * `confirm` 那一档专有(2026-10-26,卡「事务官页接管队列」):事务官核过后标上的四类拍板请求
   * (类别 / 方案 / 依据)。**只有带它的事项才在界面给「确认收下」**;没带的是事务官待核验队列,
   * 只看不批。**只有 `kind: 'confirm'` 才有**。与卡上 {@link TaskView.owner_ask} 同一份,不另存。
   */
  owner_ask?: OwnerAsk
  /** 等待原因(与会话/卡同一套 id)。判不出就不填。 */
  wait_reason?: WaitReason
  /** 来源卡。有它才点得开卡片详情。 */
  task_id?: string
  /** 来源会话。有它才点得开那段对话。 */
  conversation?: TaskConversation
  /**
   * 那段会话最近一回合模型说的话(2026-09-15,手机端事务官念的就是它)。
   * **与 `/state.sessions[]` 里同一条会话的 `summary` 是同一个值**(现拼时从会话表抄过来,不另存);
   * 会话没说过话、或会话不在表里,就不填。
   */
  summary?: string
  /**
   * 点开去哪儿(2026-09-21,`feed` 与 `topic` 两档)。手机上用系统浏览器开,电脑上用默认浏览器。
   * 别的几档指向的是本机的卡与会话,没有网址(D13:没有就不填)。
   */
  url?: string
  /**
   * 选题建议那一档专有(2026-09-22)。**只有 `kind: 'topic'` 才有** ——
   * 两颗键(「加入选题池」/「不要」)要拿它回服务端,别的档上出现它没有意义。
   */
  topic?: ButlerInboxTopic
  /** Agent 登记表那一档专有(2026-09-25,卡 Q)。**只有 `kind: 'agent'` 才有**。 */
  agent?: ButlerInboxAgent
  /**
   * 会议那一档专有(2026-10-09):哪一场,能不能「重新来」。**只有 `kind: 'meeting'` 才有**;
   * `retryable` 缺席就不摆那颗键(同 MeetingView.retryable)。
   */
  meeting?: {
    id: string
    retryable?: true
    /** 会后那一句(2026-10-10):这场登记时要定的那件事;她回过「定下来没有」就缺席。 */
    ask_outcome?: string
  }
  /**
   * 「新学到一条」那一档专有(2026-10-10)。**只有 `kind: 'habit'` 才有**:那条习惯的 id,
   * 「撤掉」拿它回 `POST /habits/revoke`、「知道了」拿它回 `POST /habits/seen`。
   */
  habit?: ButlerInboxHabit
}

/** 「新学到一条」那一档要带回服务端的(2026-10-10)。 */
export interface ButlerInboxHabit {
  id: string
}

/**
 * Agent 登记表那一档要带回服务端的几样(卡 Q):哪一家(登记表 id)、「新接上一家」那一句(`notice_id`,
 * 「知道了」拿它回 `/agents/notice/dismiss`)。
 *
 * 拿不准要问他的那一问(「XX 像是个 Agent,要接上吗?」)**不在收件箱里**:它挂在卡 M 的提问经纪人上
 * (`state.questions`,数进 `state.waiting`),电脑球下、手机「等你确认」同一张卡答(server/agentAsk.ts)。
 */
export interface ButlerInboxAgent {
  id: string
  notice_id?: string
}

/** 一条选题建议要带回服务端的几样(2026-09-22,server/feed.ts 的 topicSuggestions)。 */
export interface ButlerInboxTopic {
  /** 这条资讯在 feed.json 里的 id。两颗键都拿它回 `/feed/adopt` 与 `/feed/feedback`。 */
  feed_id: string
  /** 哪个账号(建成选题卡时挂在这个项目上)。 */
  project_id: string
  /** 账号名。给界面显示用(项目表读不到时还有名字)。 */
  project_name: string
}

/**
 * 开不出会话时那句话。**放 protocol 而不是各写一份**:服务端 POST /butler/item 的回执
 * 与收件箱条目上的标记必须是同一个词,两边各写一份迟早会漂(同 STATUS_TITLES 的理由)。
 */
export const BUTLER_NO_SESSION_NOTE = '会话未开'

/**
 * DSH 不在线时的早报那句话(2026-10-13)。与 {@link BUTLER_NO_SESSION_NOTE} 分成两句:
 * 「会话开不出来」是出了点事,「事务官会话没开」是这台机器此刻没接上 DSH ——
 * 她看到的那张卡要说得出是哪一种,不然只会以为早报坏了。
 */
export const BUTLER_SESSION_OFFLINE_NOTE = '事务官会话没开,这份只有程序拼的部分'

// ———————————————————————— 座机主动来电(2026-09-21) ————————————————————————

/**
 * 事务官为什么打这个电话。三类,与 Ben 的原话一一对应
 * (「待确认 / 运行失败 / 完成提醒时座机响铃」)。
 *
 * 判据与事实源在 server/callOut.ts 的文件头那张表里 —— **一条都不新造**:
 * `confirm` 与 `failed` 来自看板七态(confirm / blocked+error),`done` 来自看板与例程。
 */
export type CallOutReason = 'confirm' | 'failed' | 'done' | 'ask' | 'relay'

/**
 * `ask`(2026-09-25,卡 M):事务官在 DSH 会话里问他一件事 / 要他批一件事,那件事正停着等他 ——
 * 与「等你确认」同一档:白天按来电设置响,夜间静默时段只发通知;每一问 / 每一条只打一次。
 */
/**
 * `relay`(2026-09-27,卡 CB):**他让事务官捎的那句话,那家回了**(或者等太久还没回)。
 * 维护者原话:「我在手机上问了事务官,理论上事务官去问了对应的 AI 之后,事务官得回电话给我。」
 * 与「等你回答」同一档:白天响、免打扰时段只发通知;`item_id` 是 `relay:<轻账里那一条的 id>`
 * (不是看板上的事项 —— 捎话不挂卡,见 server/relayWatch.ts 的文件头)。
 * 这一通**只是转述**:接起来她把那家的回话说给他,不要他批、不改任何状态。
 */
export const CALL_OUT_REASONS: readonly CallOutReason[] = ['confirm', 'failed', 'done', 'ask', 'relay']

/**
 * {@link CallOutEntry.silent_reason} 的全部档位,**只在这一处列**(同 CALL_OUT_REASONS 的理由)。
 *
 * 2026-09-28 漏过一次:卡 UX 往类型里加了 `confirm` / `routine`,而 server/callOut.ts 的
 * `sanitizeEntry` 手写了一串 `=== ` 比较没跟上 —— 工作台重启、从 `call-out.json` 读回台账时
 * 这两档的理由被静默丢掉(界面上「为什么只发了通知」那一句没了;响不响不受影响)。
 * 下面那条 `satisfies` 加上 callOut.ts 里的反向检查钉住两头:类型里多一档而这里没跟上,`tsc` 直接报错。
 */
export const CALL_OUT_SILENT_REASONS = [
  'quiet', 'done', 'ask', 'touched', 'chat', 'confirm', 'routine', 'nocall', 'habit',
] as const satisfies readonly NonNullable<CallOutEntry['silent_reason']>[]

/** 「为什么只发了通知」那一档。写字段、挑文案都用它,不再各处手抄一串字面量。 */
export type CallOutSilentReason = (typeof CALL_OUT_SILENT_REASONS)[number]
// 反过来也钉住:类型里多出一档而上面的数组没跟上,这里编译不过。
const _silentReasonsCoverAll: NonNullable<CallOutEntry['silent_reason']> extends CallOutSilentReason ? true : never = true
void _silentReasonsCoverAll

/**
 * 电话里那一句的开头、以及来电界面上那一行大字。
 * **放 protocol 而不是各写一份**:工人在电话里说的和手机屏幕上写的必须是同一个词
 * (同 STATUS_TITLES 的理由)。
 */
export const CALL_OUT_REASON_TITLES: Record<CallOutReason, string> = {
  confirm: '等你确认',
  failed: '运行失败',
  done: '完成',
  ask: '等你回答',
  relay: '回话来了',
}

/**
 * 一通电话此刻到哪儿了:
 * - `queued`    排着(「完成」那一类还在合并窗里等,别的立刻)
 * - `ringing`   工人领走了,手机在响
 * - `answered`  他接起来了
 * - `missed`    响够 60 秒没人接 / 他按了「稍后」→ **未接来电**
 * - `notified`  只发了通知,没响铃(夜间静默时段,或者「完成」那一类 —— 见 `silent_reason`)
 * - `failed`    压根没打出去(工人不在、没有接话模型),`error` 里是那句人话
 */
export type CallOutState = 'queued' | 'ringing' | 'answered' | 'missed' | 'notified' | 'failed'

export const CALL_OUT_STATE_TITLES: Record<CallOutState, string> = {
  queued: '排队中',
  ringing: '正在响',
  answered: '已接',
  missed: '未接',
  // 2026-09-22 A1 之后这一档有两个来源(夜间静默、「完成」那一类),所以不再写死「夜间」。
  notified: '只发了通知',
  failed: '没打出去',
}

/** 台账里的一通。 */
/** 来电里逐字念的那道题(见 {@link CallOutEntry.ask})。 */
export interface CallOutAskText {
  /** 哪一家在问(登记表里的名字)。 */
  from: string
  question: string
  /** 它明写的选项(没有就是空数组:自由回答)。 */
  options: readonly string[]
  /**
   * ★ **这是一个权限弹窗**(2026-10-13,additive)。她答的是「批准 / 拒绝」,不是选项里的某一条 ——
   * 工人按这一格决定开场怎么收尾(「批准还是拒绝?」),老工人不认这一格就照旧念选项。
   */
  permission?: true
}

export interface CallOutEntry {
  id: string
  /**
   * 排它出来的那条事件的 key(2026-09-28,卡 AQ)。`<reason>:<item_id>`,
   * 「等你答」那一路还带这一问的时刻(`ask:session:<会话 id>:<since>`)。
   *
   * 为什么要落这一格:「这一通说的那件事此刻还在不在」只有按 key 才问得准 ——
   * 同一条会话换了一问是**新的 key、同一个 item_id**。没有它就只能按 item_id 猜,
   * 于是要么撤错(把新那一问的电话撤了),要么不敢撤(为一个已经答掉的问打过去)。
   * 老台账里的那几条没有这一格 —— 它们一通都不撤(宁可多响一次)。
   */
  key?: string
  reason: CallOutReason
  /** 为哪件事打的:事项是卡 id,例程是 `routine:<name>:<date>`。 */
  item_id: string
  /** 电话里念的那一句、界面上那一行。由代码从事实拼,不经模型。 */
  title: string
  /** 补一句上下文(几件交付物、失败的原话)。没有就没有。 */
  note?: string
  /**
   * 别家窗口里摆着的那道题的**原话**(2026-10-12,豆包演示那条路)。只有会话那一路「等你答」、而且那家明写了题时才有。
   * 工人接起来那一句**逐字念它**(哪一家在问 + 问题 + 选项),不让模型转述 —— 那是别家的题,改一个字她就对不上屏幕。
   * `title` 是给眼睛看的那一行(截过);这里的问题不截。老工人不认这一格,照旧按 `title` 说。
   */
  ask?: CallOutAskText
  /** 那件事发生的时刻(ISO)。 */
  at: string
  state: CallOutState
  /** 排出来就不响的:手机收到它只发通知,不响铃、不弹来电页。为什么不响见 `silent_reason`。 */
  silent: boolean
  /**
   * 这一通**为什么**只发通知(2026-09-22,A1)。
   * - `quiet` 夜间静默时段;
   * - `done` 「完成」那一类 —— Ben 定的:完成只通知,他自己点开看;
   * - `ask` 「等你回答」那一类几分钟里刚响过一次(2026-09-25,卡 M 追加:接连几问只响一次,见 server/callOut.ts 的
   *   `CALL_OUT_ASK_WINDOW_MS`;2026-10-12 晚起**上一通里的问都答完了就不算这一窗**,新的一问照响);
   * - `touched` 他刚对这件事动过手(答、批、点、交代),10 分钟里后续不打电话(卡 M 补,`CALL_OUT_TOUCH_QUIET_MS`);
   * - `chat` 只是一段回答的「等你确认」:没派给别家、没交回文件链接 —— 维护者定之前不打电话要他验收(卡 M 补)。
   *
   * - `confirm` 「办完了等你验收」那一类(2026-09-28,卡 UX):做完了是一条汇报,不是他不点头就卡住的事 ——
   *   只发通知(他把「办完了也打电话给我」打开就照响,同 `done`);
   * - `routine` 例程播报(早报 / 下班 / 知识 lint 跑完或跑挂了):只发通知,座机不为例程响(同上)。
   *
   * - `nocall` **现在没人写这一档**(2026-10-04 下午,卡 `claude/relay-nocall-noread`)。
   *   当天上午那张卡(`claude/relay-call-optin`)曾用它记「她这一句没勾『回了打电话给我』,
   *   所以这一通只发通知」;同一天维护者追了一句「不勾的时候可以不读」—— 于是不勾的那一句
   *   **压根不登记、不盯、不读**,也就不再有一通要静音。这一档**留在这张表里只为读得懂老台账**
   *   (那半天里落过盘的几条),产品代码里一处都不写(见 server/relayWatch.ts 的 `ring`)。
   *
   * 几个来源分开记,否则他把静默时段改回去、会以为完成类又该响了。响铃的那几通没有这一格。
   */
  silent_reason?: 'quiet' | 'done' | 'ask' | 'touched' | 'chat' | 'confirm' | 'routine' | 'nocall' | 'habit'
  queued_at: string
  /** 到这个时刻才交给工人(「完成」那一类要等合并窗)。 */
  due_at: string
  ringing_at?: string
  ended_at?: string
  /**
   * 这一条未接他**在手机上收过了**的时刻(2026-09-22)。
   *
   * 真机 0.2.56 上九条「完成 · 下班例程」堆在未接面板里,而 `missed` 只增不减 ——
   * 手机上那颗「清空」写的就是这一格。**只标记,不删台账**:那本记的是发生过的事,
   * 「读没读过」是另一回事,座机页「最近一次通话」照旧要看得见它。
   *
   * 只有 `state==='missed'` 的那几条会有这一格;收过之后 {@link CallOutView.missed} 不再数它。
   */
  dismissed_at?: string
  /** 并进这一通的其它「完成」(5 分钟内的多条打一次)。 */
  /**
   * 并进这一通的那几问。`key` 是那一问排出来的事件 key(2026-10-12 晚起才记):「上一通里的问都答完了没」按它认 ——
   * 同一条会话换了一问是新的 key、同一个 item_id,按 item_id 认会把新一问当成旧的没答完。老台账里没有这一格的按 item_id 兜底。
   */
  merged?: readonly { item_id: string, title: string, key?: string }[]
  /** 没打成 / 按未接记时那一句人话。原样显示,不套一层。 */
  error?: string
  /**
   * `failed` 是哪一种(2026-10-12,卡「没办完的事项说清楚」):只有 `state === 'failed'` 才有。见 {@link CallOutFailKind}。
   * 写下时就记;这一格出现之前的老台账读回来时按 `error` 原话补({@link callOutFailKindOf}),认不出的标 `unknown`。
   */
  fail_kind?: CallOutFailKind
  /**
   * 领到这一通的那几间房(2026-10-21,局域网主路 M2):工人按房间领(`POST /call/claim {room}`)才有。
   * 工人在本机房间与云房间各一条时(卡 M6),同一通两间房都领得到、都响。老工人不带房间领的那几通没有这一格
   * —— 它们不再交给第二间房。
   */
  rooms?: readonly string[]
  /** 这几间房已经收了场(回了没接 / 打不出去 / 已被别处接走)。领到的房**全收了场**才落未接这类最终状态。 */
  rooms_done?: readonly string[]
  /** 先接起的那一间房与那台设备(`POST /call/answered`,先接先得)。后到的判「已被接」挂断。 */
  answered_room?: string
  answered_device?: string
}

/**
 * 「没打出去」拆开(2026-10-12;运营同学 10-12:200 条里 28 条 `failed`,混着她停铃、她已经答了无需再打)。
 * - `tech` 技术失败:工人没回话、和房间断开、工人退出 —— **只有这一种算失败**(统计、诊断上报、界面上的「没打出去」);
 * - `declined` 她停了铃(桌面上按「停铃」撤掉排着的那一通);
 * - `moot` 已无需再打:她已经在别处答了,排着的那一通撤掉;
 * - `unknown` 老台账里认不出是哪一种。
 * `state` 照旧记 `failed`(老手机、老工人认得),这一格是加在旁边的。
 */
export type CallOutFailKind = 'tech' | 'declined' | 'moot' | 'unknown'

export const CALL_OUT_FAIL_KINDS: readonly CallOutFailKind[] = ['tech', 'declined', 'moot', 'unknown']

export const CALL_OUT_FAIL_KIND_TITLES: Readonly<Record<CallOutFailKind, string>> = {
  tech: '没打出去',
  declined: '你停了铃',
  moot: '已无需再打',
  unknown: '结果不明',
}

/**
 * 老台账里那几句原话各是哪一种(写这些话的地方:`server/callOut.ts` 的 `CALL_OUT_MOOT_ASK_ERROR` /
 * `CALL_OUT_STOP_RING_ERROR` / `CALL_OUT_WORKER_SILENT_ERROR`,电话工人 `channel-worker/src/agent.ts` 与 `callOut.ts` 取消那一通的三句)。
 * 用例读工人源文件比对这三句还在。
 */
export const CALL_OUT_FAIL_EVIDENCE: Readonly<Record<string, CallOutFailKind>> = {
  '他已经答了,这一通没打出去': 'moot',
  '桌面上按了「停铃」': 'declined',
  '电脑上的工人没回话,这一条通知按没发出去记': 'tech',
  '和房间断开了,这一通没打成': 'tech',
  '工人要退出了,这一通没打成': 'tech',
  '这一通取消了': 'tech',
}

/** 这一通 `failed` 是哪一种。记了就用记的;没记按原话认;认不出 `unknown`。不是 `failed` 回 undefined。 */
export function callOutFailKindOf(entry: Pick<CallOutEntry, 'state' | 'error' | 'fail_kind'>): CallOutFailKind | undefined {
  if (entry.state !== 'failed') return undefined
  if (entry.fail_kind !== undefined && (CALL_OUT_FAIL_KINDS as readonly string[]).includes(entry.fail_kind)) return entry.fail_kind
  return CALL_OUT_FAIL_EVIDENCE[(entry.error ?? '').trim()] ?? 'unknown'
}

/** 算不算一次失败:**只有技术失败算**。 */
export function isCallOutTechFailure(entry: Pick<CallOutEntry, 'state' | 'error' | 'fail_kind'>): boolean {
  return callOutFailKindOf(entry) === 'tech'
}

export interface CallOutConfigView {
  /** 整个主动来电开着没有。关了就只剩手动 `POST /call/out`。 */
  enabled: boolean
  /** 夜间静默时段的两头(本机时间 `HH:MM`,缺省 23:00–08:00,跨零点)。 */
  quiet_from: string
  quiet_to: string
  /**
   * 「完成」那一类要不要真打电话(2026-09-22,Ben 定,**缺省 false**)。
   *
   * 原话:「『完成』类只发通知不打电话;早报也只通知,用户自己点开。」
   * 关着时完成类照排、照进台账、照发通知,只是不响铃(`silent:true` + `silent_reason:'done'`)——
   * **不是「不发」**:第二天他该看得见昨天办完了哪几件。
   * 「等你确认」与「运行失败」不受它管:那两类是要他做决定的事,照旧响。
   *
   * 2026-09-22 补:**手动那条 `POST /call/out`(手机上的「回拨」)也过这道门**。
   * 原来它是个例外,而真机台账上那七通「下班例程」全是从那个例外里排出去的 ——
   * 关着时它对完成类回 `{ok:false, error}` 并说清开关在哪,不静音成一条通知。
   */
  done_call: boolean
}

/** GET /state 与 GET /call/log 的那一块。最近的在前。 */
export interface CallOutView {
  config: CallOutConfigView
  entries: readonly CallOutEntry[]
  /**
   * 未接来电数。手机回到前台显示「未接来电 N」认的就是它。
   *
   * **只数还没收过的那几条**(2026-09-22):手机上按过「清空」的带 `dismissed_at`,
   * 它们照旧留在 `entries` 里(台账一条不删),只是不再挂在他眼前。
   */
  missed: number
}

/**
 * **此刻能不能出声**(2026-09-26,卡 QH)。`/state.quiet` 那一格,判断在 `server/quietHours.ts`。
 *
 * 维护者的规矩只有一句:**晚上 9 点以后不想被打扰**。那句话管的不是「电话」,是「声音」——
 * 来电、朗读、提示音、手机与电脑的一切出声都读这一格,**谁都不许自己再算一遍时段**。
 *
 * 两件它**不**管的事:
 * - 界面照常。字幕、气泡、通知该出就出 —— 免打扰是不出声,不是不告诉他。
 * - **他自己按下的「播放 / 朗读 / 回拨」不拦**。那是他要的声音;拦不拦由每个出声点按
 *   「是他按的吗」自己决定,这一格只回「此刻算不算免打扰时段」。
 */
export interface QuietView {
  /** 此刻在免打扰时段里。true = 一切「不是他刚按下的」声音都不出。 */
  active: boolean
  /**
   * 时段两头(本机时间 `HH:MM`,可跨零点;维护者设的是 21:00–08:30)。
   * **时段外也带着** —— 设置里要显示,界面要说得出「几点起不出声」。
   * 时段写坏了读不出来时**两格一起缺席**:不编一个时段出来当真的。
   */
  from?: string
  to?: string
  /** 到几点恢复出声(= `to`)。只在 `active` 时有 —— 没在免打扰里就没有「几点恢复」这回事。 */
  until?: string
  /** 为什么不出声,一句人话(「免打扰时段」)。界面拼成「免打扰中 · 08:30 后恢复」。只在 `active` 时有。 */
  reason?: string
}

/** GET /state 事项收件箱整块。**只有「事务官交给我」那一半**——另一半在 tasks 里(direction=mine)。 */
export interface ButlerInboxView {
  items: readonly ButlerInboxItem[]
  /**
   * 此刻「执行中」的事项数(2026-09-16 口径统一)。由 `isItemExecuting` 数出来——顶栏「运行会话 n 个」、
   * 球下「执行 n」、手机端与例程要报"几件在执行"时都读同一个定义。任务板没接上、或快照冻结(stale)时缺省,不填 0。
   */
  executing?: number
}

/**
 * 「执行中」的事项——**全仓库唯一的口径**(2026-09-16,Ben 真机:顶栏「运行会话 3 个」而球下「执行 0」):
 * 是一件事项({@link isTrackedItem}:他交给事务官的,或看板上写了负责人的)、状态 `doing`,且它 links 里至少一条会话
 * 此刻 `running`、那家 agent 在线、快照没冻结。
 * 会话早已 done 而卡还停在 doing 的(闭环之前的老卡)**不算**——「执行」说的是真有人在动,不是卡在哪一列。
 * 客户端 butlerSceneModel 与服务端 butlerInbox 都调这一个函数,两边永远相等。
 *
 * 2026-09-25(卡 N,一件事一份):门从 `direction:'mine'` 放宽到 isTrackedItem —— 看板上写着 Codex 的卡被驱动派出去、
 * 在那边跑着,它就是一件正在执行的事项,不因为它是在看板上建的就不数。
 */
export function isItemExecuting(
  task: TaskView,
  snapshot: { sessions: readonly SessionView[], agents: readonly AgentView[], stale: boolean },
): boolean {
  if (snapshot.stale || !isTrackedItem(task) || task.status !== 'doing' || executionRoleOf(task).kind !== 'business') return false
  if (task.execution_sources !== undefined) return task.execution_sources.some(source => source.role === 'business' && source.state === 'running')
  return (task.links ?? []).some((link) => {
    const session = snapshot.sessions.find(s => s.agent === link.agent && s.session_id === link.session_id)
    if (session === undefined || session.status !== 'running') return false
    const agent = snapshot.agents.find(a => a.id === link.agent)
    return agent?.online !== false
  })
}

/**
 * 「排队」的事项(2026-09-16):建好了、会话还没开出来的那几秒——`mine`、待办、没有 conversation、
 * 卡上没话(「会话未开」是话),且建卡不超过 `PENDING_WINDOW_MS`。窗口一过就只是一张待办
 * (闭环之前建的、会话开不出来又没记话的老卡不该一直画着虚线等一条永远不来的会话)。
 */
export const PENDING_WINDOW_MS = 90_000

export function isItemPending(task: TaskView, nowIso: string): boolean {
  if (task.direction !== 'mine' || task.status !== 'todo' || task.conversation !== undefined || task.note !== undefined) return false
  const now = Date.parse(nowIso)
  const created = Date.parse(task.created_at)
  if (Number.isNaN(now) || Number.isNaN(created)) return false
  return now - created >= 0 && now - created < PENDING_WINDOW_MS
}

/**
 * —— 事务官的日常例程(2026-09-15,docs/设计-事务官完整材料.md §4.2)——
 *
 * 三条例程都是「插件按时开一条 DSH 会话 + 一份技能告诉它做什么 + 结果落回记忆与事项收件箱」。
 * 用户看到的是事务官先开口,不是一个 cron。开关与时间在 `~/.dsh/workbench/routines.json`,
 * 这里只是 /state 里那一块的形状。
 */
export type RoutineName = 'morning' | 'evening' | 'lint'

export const ROUTINE_NAMES: readonly RoutineName[] = ['morning', 'evening', 'lint']

/** 三条例程的中文名。收件箱条目、设置面板、回执要说同一个词,放 protocol。 */
export const ROUTINE_TITLES: Record<RoutineName, string> = {
  morning: '开工汇报',
  evening: '下班例程',
  lint: '每周知识 lint',
}

/**
 * 一次例程的结果:
 * - `ok`          跑完了,会话开出来了
 * - `no_session`  该做的做了(开工汇报拼好了 / 下班例程的机械步骤写完了),但 DSH 会话开不出来——如实标「会话未开」;
 *                 开工汇报在 DSH 不在线时也走这一档(2026-10-13),另带 `session_offline` 分得开是哪一种
 * - `skipped`     DSH 不在线,这次跳过,note 里说一句(下班例程与知识 lint 两条)
 * - `failed`      中途抛了,note 是原因(已抹掉任何凭据)
 */
export type RoutineRunStatus = 'ok' | 'no_session' | 'skipped' | 'failed'

export type RoutineTrigger = 'schedule' | 'sighting' | 'manual'

export interface RoutineRun {
  name: RoutineName
  /** 本机日期 YYYY-MM-DD。同一天不重复跑(手动 POST /routine/run 除外)。 */
  date: string
  trigger: RoutineTrigger
  started_at: string
  finished_at?: string
  status: RoutineRunStatus
  /** 一句人话:跳过的原因、写了什么、commit 号、会话未开。 */
  note?: string
  /** 开出来的那条 DSH 会话。开不出来整个字段缺席。 */
  conversation?: TaskConversation
  /**
   * `no_session` 的那一种是「DSH 根本不在线」(2026-10-13):早报照出程序拼的那一半,
   * 收件箱那张卡据此说 {@link BUTLER_SESSION_OFFLINE_NOTE} 而不是「会话未开」。不是这一种就缺席。
   */
  session_offline?: true
  /** 开工汇报:三句加一问的原文;知识 lint:交接文档路径。由代码拼,不经模型。 */
  report?: string
  /** 下班例程:那一次 commit 的短 hash。没提交(没改动 / 未配置仓库)就缺席。 */
  commit?: string
}

/** 下一次什么时候:到点触发给时刻(本机 ISO);开工汇报没设时间时是「当天第一次露面」。 */
export type RoutineNext =
  | { kind: 'at', at: string }
  | { kind: 'sighting', not_before: string }

export interface RoutinesConfigView {
  morning: { enabled: boolean, at?: string, not_before: string }
  evening: { enabled: boolean, at: string }
  lint: { enabled: boolean, weekday: number }
  /** 记忆所在的仓库(含 docs/记忆)。没配就缺省,汇报少一句、下班例程只开会话不写文件。 */
  repo?: string
}

export interface RoutinesView {
  /** 每条例程的下一次。关着的不出现。 */
  next: Partial<Record<RoutineName, RoutineNext>>
  /** 每条例程最近一次的结果(进程重启后从 routines-state.json 读回)。 */
  last: Partial<Record<RoutineName, RoutineRun>>
  /** 此刻在跑的例程。同一例程不并发:在跑时再触发直接拒绝。 */
  running: readonly RoutineName[]
  /** 当前生效的配置(routines.json 解析后的样子),给设置面板回显用。 */
  config: RoutinesConfigView
}

/* ——— 会议模式(2026-09-21,Ben:「手机上还有『会议模式』,开完会直接打通这套系统帮忙办事、梳理」)——— */

/**
 * 一场会议此刻在哪一步。**不合并**:手机上这四种状态要说四句不一样的话。
 *
 * - `planned`      会前登记的、还没开录的那一场(2026-10-10 卡「会前画像与预案」):开录时接到同一场
 * - `recording`    还在录(分段陆续上来)
 * - `transcribing` 在转写(火山)
 * - `summarizing`  在梳理(事务官那家模型)
 * - `done`         梳理完了,纪要与待办等他挑
 * - `failed`       出事了。**原始录音一个都不删**(会议模式边界第 6 条)
 */
export type MeetingStatus = 'planned' | 'recording' | 'transcribing' | 'summarizing' | 'done' | 'failed'

/**
 * 纪要里的一条待办。
 *
 * 三个字段的纪律一样:**转写里没说的就缺席,不推断**。
 * 「谁」尤其如此 —— 这一版没有说话人分离,所以只有转写正文里明确点了名
 * (「小王你来跟进」)才填得出来;听不出来就整个字段缺席,界面显示「没说谁」。
 */
export interface MeetingTodoView {
  /** 这一场会里稳定的编号(`t1`、`t2`…)。手机上逐条勾用它。 */
  id: string
  /** 做什么。空的那条根本不会进这个列表。 */
  what: string
  /** 谁。听不出来就缺席,**绝不填「某人」这种占位**。 */
  who?: string
  /** 期限,模型抄的转写里那句原话(「这周五前」)。**不换算成日期**——算错比没有更坏。 */
  due?: string
  /** 已经建成卡了的话,那张卡的 id。没建过就缺席。 */
  task_id?: string
}

/** 一场会议。`/state.meetings.recent` 里的一条。 */
export interface MeetingView {
  id: string
  /** 标题。手机上没填就是「会议」,落盘目录名里那一半。 */
  title: string
  /** 本地日期 YYYY-MM-DD(目录名的前一半)。 */
  date: string
  started_at: string
  /** 按「结束」那一刻。还在录就缺席。 */
  ended_at?: string
  status: MeetingStatus
  /** 收到几段。 */
  segments: number
  /** 转写完了几段(status=transcribing 时手机上显示进度)。 */
  transcribed?: number
  /** 录了多久(秒)。**分段真实时长之和**,不是墙钟差——中途暂停过的话两者差很多。 */
  seconds?: number
  /** 落盘目录(绝对路径)。工作目录没配时整场会都建不起来,所以有会议就一定有它。 */
  dir?: string
  /**
   * 纪要正文(markdown,代码从结构拼出来的)。还没梳理完就缺席。
   *
   * 2026-10-13 起按《会议纪要生成规则》分段:解决了什么 → 按议题(讨论了什么 / 判断 / 为什么 / 链路)
   * → 最值得保留 → 下一步 → 拿不准。**两端都只按原文显示**(手机 `<pre>`、电脑收件箱只报状态),
   * 没有谁在解析这几段标题 —— 改结构不用跟着改两端(规范原文见 `docs/规范-会议纪要生成规则-2026-10-12.md`)。
   */
  summary?: string
  todos: readonly MeetingTodoView[]
  /** 事务官拿不准的地方。一条都没有就是空数组(不是缺席——「它说没有拿不准的」是一条信息)。 */
  unsure: readonly string[]
  /** 出了什么事。原样那一句,不套一层(D13)。 */
  error?: string
  /**
   * 能「重新来」(2026-10-09):转写或梳理有一截没成、或者工作台中途重启过而这一场停在半路。
   * 手机会议页与电脑收件箱那一档据此摆那颗键;重来只重做没成的那一截(已转好的段不再送识别)。
   * 不能重来就整格缺席。
   */
  retryable?: true
  /** 会前画像与预案卡(2026-10-10)。会前登记过的那一场才有;直接开录的缺席。 */
  prep?: MeetingPrepView
  /**
   * 会中那一段能看的东西(2026-10-13,卡「会议页不再空着」):**转写里的时间戳**摆成的一条线。
   *
   * 这不是现场记号 —— 「记一下」那种会中记号这一版**没有**,所以这里只有转写自己带的时间。
   * 转写里一个时间戳都没有(导入的纯文字)就整格缺席,界面上照实说没有。
   */
  timeline?: readonly MeetingTimelineMark[]
  /**
   * 演示用那几场(2026-10-13 `POST /meeting/seed-demo` 放进来的虚构样例)。
   * 两端据此在列表上摆一个不起眼的记号 —— **不冒充一场真会**。真录的、她自己导的都缺席。
   */
  demo?: true
  /** 会后她回的「要定的定下来没有」。没回就缺席(给以后的会议学习当证据,本卡只存)。 */
  outcome?: MeetingOutcomeView
}

/**
 * 时间线上的一刻(2026-10-13)。`at` 是**转写里那一行的时间戳原样**(`00:03:11`,从会议开始算起),
 * `text` 是那一刻的那句话截过的一段。
 *
 * 为什么不换算成「几点几分」:转写里的时间是相对会议开头的,换算要靠 `started_at` 对得准,
 * 而导入进来的那一场本来就没有开录那一刻(同「期限不换算」那条纪律)。
 */
export interface MeetingTimelineMark {
  at: string
  text: string
}

/* ——— 会前:画像五问与预案卡(2026-10-10,设计 `docs/设计-会议模式目标与验收-2026-09-27.md` 第三节)——— */

/** 这一问的答案从哪来:她那句话里认出的 / 花名档案等已有记录里认出的 / 她答的。 */
export type MeetingPrepFrom = 'said' | 'record' | 'asked'

export interface MeetingPrepAnswer<T> {
  value: T
  from: MeetingPrepFrom
  /** 从记录认出时写依据(「花名档案:上次「X」」)。 */
  basis?: string
}

/** 一位参会人。**只有花名**,不记真名与联系方式(设计第六节)。 */
export interface MeetingPersonView {
  alias: string
  /** 拍板 / 有影响力 / 执行 / 对面的人 / 旁听,或她自己的说法。没说就缺席。 */
  role?: string
  decides?: true
}

export type MeetingPrepQuestionId = 'scope' | 'kind' | 'people' | 'decider' | 'my_role' | 'goal'

/** 此刻要问她的那一问(一问一答,不猜)。 */
export interface MeetingPrepAsk {
  id: MeetingPrepQuestionId
  text: string
  /** 能点的几个选项;自由回答时缺席或只作提示。 */
  choices?: readonly string[]
  hint?: string
}

/**
 * 预案卡这一刻在哪一步:
 * - `answers`  五问还没问完
 * - `goal`     第五问答不上来,先拦着(等她去问组织者,或者点「先照现在的准备」)
 * - `making`   在做(一次模型调用)
 * - `ready`    做好了
 * - `failed`   没做成(`card_error` 说为什么;额度到了也在这里)
 */
export type MeetingCardStatus = 'answers' | 'goal' | 'making' | 'ready' | 'failed'

/** 预案卡上的一个问题:一个数 / 一个说法 / 一个退路。 */
export interface MeetingCardQuestionView {
  q: string
  /** 一个数:**只从她自己的数据里查**,原样那一句 + 出处。查不到整格缺席,`none` 为 true。 */
  number?: { text: string, source: string }
  none?: true
  line: string
  fallback: string
}

export interface MeetingPrepView {
  /** 她登记时那一句原话。 */
  said: string
  /** 原话里说的时间(「下午三点」)。没说就缺席。 */
  when?: string
  /** 能确定到几点几分时才有(「三点」没说上午下午就不填,不猜)。 */
  scheduled_at?: string
  scope?: MeetingPrepAnswer<'内部' | '外部'>
  kind?: MeetingPrepAnswer<string>
  people?: MeetingPrepAnswer<readonly MeetingPersonView[]>
  /** 谁拍板:花名 /「我」/「还没定」。 */
  decider?: MeetingPrepAnswer<string>
  my_role?: MeetingPrepAnswer<string>
  goal?: MeetingPrepAnswer<string>
  /** 第五问答不上来(设计第三节第 2 条:先拦)。 */
  goal_unclear?: true
  /** 替她拟的那句去问组织者的话。**发不发由她**,事务官不替她发。 */
  organizer_ask?: string
  /** 此刻要问她的那一问。五问齐了就缺席。 */
  ask?: MeetingPrepAsk
  card_status: MeetingCardStatus
  card?: { made_at: string, questions: readonly MeetingCardQuestionView[] }
  card_error?: string
}

/** 会后她回的那一句:这场要定的定下来没有。 */
export interface MeetingOutcomeView {
  settled: 'yes' | 'partly' | 'no'
  said?: string
  at: string
}

/** `/state.meetings`。没接会议服务时整块缺席。 */
export interface MeetingsView {
  /** 最近几场,最新的在最前。 */
  recent: readonly MeetingView[]
  /** 会前登记、还没开录的那几场(2026-10-10),最近要开的在前。手机据此在首页那颗会议键上亮点、会议页列出来。 */
  upcoming?: readonly MeetingView[]
  /**
   * 会议都落在这个目录下面(`<工作目录>/会议`)。**工作目录没配时缺席**,
   * 此时会议模式整个用不了 —— 界面照实说,不猜一个路径(pathConfig.ts 的纪律)。
   */
  dir?: string
}

// ─────────────────────────────────────────────────────────────────────────────
// 统一输入框(2026-09-24,docs/设计-统一输入框-2026-09-24.md)
// 电脑(workbench-plugin/src/client/composer/)与手机(butler-app/src/composer/)各一份界面,
// 口径都在这一节:四个菜单的数据、交办请求的新字段、审批。
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 模式 = 权限(维护者 2026-09-24 拍板:三档,一个开关同时管事务官自己与派出去的活,**不给全权**,
 * 守 09-21「永不 --dangerously-*」)。
 * - `plan` 只出方案:事务官会话只读 + /plan;三只派活的手见到这件一律 409。
 * - `ask` 先问我(默认):工作区可写、越界要批;派活前先复述确认点;送进窗口不替他按回车。
 * - `auto` 自动办:工作区可写、越界要批;不先问、直接派;送进窗口按回车。
 */
export const COMPOSER_MODES = ['plan', 'ask', 'auto'] as const
export type ComposerMode = typeof COMPOSER_MODES[number]
export const COMPOSER_MODE_TITLES: Readonly<Record<ComposerMode, string>> = {
  plan: '只出方案',
  ask: '先问我',
  auto: '自动办',
}
export const COMPOSER_MODE_HINTS: Readonly<Record<ComposerMode, string>> = {
  plan: '只读、不改文件、不派活,方案写回卡上',
  ask: '改动越界要你批;派给别家前先跟你确认',
  auto: '工作区里直接办、直接派;越界仍要你批',
}
export const DEFAULT_COMPOSER_MODE: ComposerMode = 'ask'
export function isComposerMode(value: unknown): value is ComposerMode {
  return typeof value === 'string' && (COMPOSER_MODES as readonly string[]).includes(value)
}

/** 卡上记的附件。 */
export interface TaskAttachment {
  name: string
  image: boolean
}

/** 「@」与「指定谁来办」的一条候选。**实时算,不写死**(见 server/composer.ts composerAgents)。 */
export interface ComposerAgentView {
  /** `dsh` = 事务官自己办(不 @ 就是它)。 */
  family: 'dsh' | AgentDispatchFamily
  title: string
  /** 会用哪几只手、各自能不能用。先后照 AGENT_HAND_ORDER。 */
  hands: readonly { hand: DispatchHand, ready: boolean, why?: string }[]
  /** 至少一只手能用。 */
  ready: boolean
  /** 在窗口槽里。 */
  in_slot: boolean
  /** 本机最近一次用它(会话 / 用量里看到的)。 */
  last_used_at?: string
}

export interface ComposerModelView {
  provider: string
  id: string
  /** 胶囊上的短名(V4 Flash)。 */
  title: string
  /** 这一个能不能直接看图。 */
  images: boolean
}

/** GET /composer/options */
export interface ComposerOptionsView {
  agents: readonly ComposerAgentView[]
  modes: readonly { id: ComposerMode, title: string, hint: string }[]
  /** 当前档(粘性:选了一直用,电脑与手机共用一份)。 */
  mode: ComposerMode
  models: readonly ComposerModelView[]
  /** 当前模型(粘性,同上)。缺席 = 拿不到模型表(DSH 没接上)。 */
  model?: { provider: string, id: string }
  /** 模型表拿不到时那一句(不编)。 */
  models_note?: string
  /** 「引用」里的最近几条。 */
  recent: readonly { kind: 'item' | 'project', id: string, title: string, note?: string }[]
}

/** POST /composer/upload 的回执。`id` 就是它在收件文件夹里的文件名。 */
export interface ComposerUploadView {
  id: string
  name: string
  type: string
  bytes: number
  image: boolean
}

/** POST /butler/item 的新字段(老字段 text / orientation / assignee / kind 照旧)。 */
export interface ComposerItemFields {
  mode?: ComposerMode
  model?: { provider: string, id: string }
  attachments?: readonly (string | { id: string })[]
  refs?: readonly { kind: 'item' | 'project', id: string }[]
}

/** 一次在等批准的操作。 */
export interface PendingApprovalView {
  id: string
  session_id: string
  /** 这条会话挂在哪张卡上(查不到就缺席)。 */
  task_id?: string
  task_title?: string
  tool: string
  reason?: string
  at: string
  /**
   * 派活前那一问(卡 O):这件活能派给的几家,**一家一行、各带额度那一格**(有数 / 不限 / 没接上:原因)。
   * 统筹 09-25:派活确认里每一家都要有一行,没有空白、没有占位句。别的审批(越界写文件之类)缺席。
   */
  options?: readonly ApprovalOptionView[]
  /**
   * 人话(2026-09-25,卡 M;维护者:「escalate sandbox to danger-full-access: …」看不懂)。
   * 服务端一处翻好,电脑与手机照着摆,两端一个字不差。缺席 = 老服务,界面退回 `reason ?? tool`。
   * - `say`:她要做什么(「开一个看不见的浏览器,把页面截下来看」);
   * - `why`:她给的理由(原话里的术语换成人话);
   * - `scope`:这一下放开到多大(「这一条要能改这台电脑上的任何文件……」);
   * - `kind`:同一件事里「同类的」那一类 —— 有它,卡上多一颗「这件事里<title>都允许」;
   * - `raw`:底层原话与那条命令,只在「看原始」里给开发者看。
   */
  say?: string
  why?: string
  scope?: string
  kind?: { key: string, title: string }
  raw?: { reason?: string, command?: string }
  /**
   * 这一条是**事务官自己的提议**(2026-09-28,卡 UX):负责人驱动挂的「这张派给 X 开工?」。
   * 与他自己交代之后那一问(「让 Manus 查一下」→「派给 Manus(剩 2,690 积分)」)长得一样、
   * 会话 id 前缀也一样(`dispatch:<事项 id>`),**只有这一格分得开**。
   *
   * 有它的:不进「等你」那一堆、座机不为它响(2026-09-27 卡 WY 已拍板:提议走「做完告知」那一路)。
   * 从前靠认那句话(「要你批:这张派给…」)分,真机 09-28 上 9 通未接就是漏了审批这一路。
   */
  proposal?: true
}

/** 派活确认点里的一家(卡 O)。**只有别家**(卡 BS2:「事务官自己做」那一项拿掉了)。 */
export interface ApprovalOptionView {
  /** 派活那一家的名字。 */
  family: string
  title: string
  /** 额度那一格的原话:「本周还剩约 62%」「不限」「没接上:剩多少只在它的「使用情况」页上」。 */
  quota: string
  state?: AgentQuotaState
  /** 这个数是上次读到的、而且老了(同 `AgentQuotaView.stale`):`quota` 里带着时刻与那一句,这一行画淡。 */
  stale?: boolean
  /** 这次问的就是它(他点了名 / 按规矩的默认)。 */
  chosen?: boolean
}

/**
 * 「等你」的那一堆里的一件(2026-09-25,卡 M 追加)。**只有他能做的三样**:
 *   - `答`:事务官在会话里问他的(`question`);
 *   - `批`:要他批的操作(`approval`)、等他点头的单子(`plan`)、等他点头的提议(`proposal`:做个小工具 / 改布局 / 固化下来);
 *   - `验收`:办完了等他确认的事项(`confirm`,七态里的「等我确认」)。
 * 卡 T(2026-09-25)加一样:**别家的会话停着在等他**(`session`:Claude / Codex / Kimi 那边在问他、让他选 / 批 / 去做 / 审,
 * 弹窗的与没弹窗的都算,见 `SessionView.ask`)—— 同一堆、同一个数,动词照它在等的那一类(`做` = 要他亲手去做,`审` = 交了东西等他看)。
 * 不在这一堆里的:「额度还差一步」「还差一个授权」这类装配提醒、单子落好之后那张回执 —— 那不是哪件事停着在等他。
 */
export type WaitingKind = 'question' | 'approval' | 'plan' | 'proposal' | 'confirm' | 'session' | 'decide'

export interface WaitingItemView {
  /**
   * 与电脑球下那一区、通知、手机那一行共用的键:`question:<id>` / `approval:<id>` / `laid:<id>` / `dev:<id>` / `layout:<id>` / `evolve:<id>` / `confirm:<事项 id>`
   * / `session:<哪一家>:<会话 id>`(卡 T:别家的会话在等他)
   * / `decide:<事项 id>`(卡 O:派不出去、到上限停下来了 —— 要他定:登录 / 换一家 / 继续 / 停)。
   */
  key: string
  kind: WaitingKind
  /** 他要做的那一下。 */
  verb: '答' | '批' | '验收' | '做' | '审'
  /** 一行人话(气泡、手机那一格、「要你看的」那一层都用它)。 */
  text: string
  /** 哪件事(有的话)。 */
  task_id?: string
}

export interface WaitingView {
  /** = items.length。单列出来是为了两端读同一个字段,不各自数。 */
  count: number
  items: readonly WaitingItemView[]
}

// ───────────────────── 「执行 n」:全工作台一个数(2026-09-25,卡 V) ─────────────────────

/**
 * 「此刻有几件在跑」**全工作台唯一的一份**(2026-09-25,卡 V;做法照 `waiting.ts` 的 `waitingOnHim`)。
 *
 * 维护者 09-25 21:00:「实际一个会话在跑,从事务官的卡片,再到气泡,都不对」。原来五处各数各的:
 * 舞台「正在执行 n」数 `buildButlerScene` 的 items、球下「执行 n」读同一个 model、窗口槽标签气泡
 * 自己按 `session.status === 'running'` 过滤、汇报条「运行会话 n 个」转述球下那个数、手机首页再数一遍。
 * 探针一进来,过滤那条路多数两个,而事项那条路不多 —— 同一刻两个数。
 *
 * 现在:服务端用 `src/running.ts` 的 `runningNow` 从这一份快照算好放进 `/state.running`,
 * **上面五处都读这一格**。老服务没给这一格时用同一个函数就地算(`runningOf`)。
 */
export interface RunningItemView {
  role?: ExecutionRole
  role_origin?: ExecutionRoleFact['origin']
  sources?: readonly TaskExecutionSource[]
  execution_state?: ExecutionState
  /** 事项那一件用 `task:<事项 id>`;没挂在事项上的那条会话用 `session:<哪一家>:<会话 id>`。 */
  key: string
  /** 哪一家(事项那一件取它挂着的第一条在跑的会话)。**字符串**,不收窄成固定几家(卡 P / 卡 Q 的规矩)。 */
  agent: string
  session_id?: string
  task_id?: string
  /** 一行人话(气泡里那几行)。 */
  text: string
}

export interface RunningView {
  scope?: 'classified_business_tasks'
  /** Observed business tasks only, even when the full count is unavailable. */
  observed_count?: number
  excluded?: readonly RunningItemView[]
  /**
   * 此刻在跑几件。**缺席 = 数不出来**(任务板没接上 / 快照冻结 `stale`)——
   * 不填 0(填 0 就是「都没在跑」,那是假话)。与 `ButlerInboxView.executing` 同一条纪律。
   */
  count?: number
  items: readonly RunningItemView[]
}

// ───────────────────── 球的颜色:一处算、两端只显示(2026-10-04,卡「球的颜色一处算」) ─────────────────────

/**
 * 粒子球此刻的状态 —— **全工作台唯一的一份**(2026-10-04;做法照 `waiting.ts` / `running.ts`)。
 *
 * 维护者 10-04 原话(经工作台捎话):「有一个镜头发现手机的粒子球和电脑上粒子球两个的状态不一样、
 * 颜色比如状态……我担心他跟到最新版两个端还是会有一样的问题」。
 *
 * 根子是**两端各自从 /state 推算**:电脑在 `client/butlerSceneModel.ts`(0.4.96 的
 * `activeFailureOf` / `callingNowOf` / `orbNoticeOf`)、手机在 `butler-app/src/swarm/orbState.ts`
 * (`signalsFromState`,红的判据是「有一件还开着的事出过错」=> 历史阻塞永久红)。0.4.96 把电脑那一套改对之后,
 * 两端更不一致了。
 *
 * 现在:服务端拼 /state 时用 `src/orbCell.ts` 的 `orbCellOf` 算好放进 `/state.orb`,
 * **电脑与手机都只显示这一格**。缺席 = 老服务(两端各自退回本地推算,行为与 0.4.96 一字不差)。
 *
 * 手机自己的**本机交互态**(在说话 / 在收音 / 在想 / 通话页)照旧叠在上面 —— 那是手机独有的、电脑没有的东西;
 * 这一格管的只有**提示色**与**在办与否**。
 */
export interface OrbView {
  /**
   * 球此刻的提示色。`failed`(红)只认**此刻台上正在执行的那件出错**;
   * `confirmation`(琥珀)= 有事停着等她回话 / 来电在响 / 通话中;其余 `neutral`。
   *
   * **故意不发 `completed`**:电脑把它折成 `neutral`(`client/particleScene.ts`)、手机从来不产生它 ——
   * 发出来只会成为两端唯一的分歧点。
   */
  notice: 'neutral' | 'confirmation' | 'failed'
  /** 此刻有没有在办(= `running.count > 0`)。球的形态(莫比乌斯环)认它。快照冻结时为 `false`(数不出来不编)。 */
  working: boolean
  /** 受阻几件:历史阻塞、出错、在等某家回来的那几件。球下那一行「受阻 N」认它,**不染红主球**。 */
  blocked: number
  /** 判据摊开给人看(读屏、`curl /state`、交接都看它;界面只认上面三格)。 */
  active_failure: boolean
  /** 有事停着等她回话(= `waiting.count > 0`)。 */
  waiting: boolean
  /** 此刻在通话里(来电在响 / 已接通还没挂 / 她刚按的试铃)。 */
  calling: boolean
  /**
   * ★ **有一条她还没看过的回答**(2026-10-04,卡 `claude/answer-comes-to-her`;= `answers.items` 里有 `seen_at` 缺席的)。
   *
   * **故意不进 `notice`**:琥珀的意思是「有事停着等你回话」,一条回答不等她做任何事 ——
   * 把它染琥珀,球就会在她每问一句话之后长期发黄,「等你」那一档随之不值钱了(维护者 09-18
   * 「又是黄色的笑脸」同一个病)。两端只拿这一格画球下那一行 / 一颗小点。
   */
  answer?: boolean
  /**
   * ★ **有一张「刚办完」她还没看过**(同上;= `fresh_results.items` 非空)。
   *
   * 同样**不进 `notice`**:2026-09-28 定过「完成那一类不打电话,只发通知」—— 办完是好消息,
   * 不是一件等她的事。要她点一下的只是「看过 / 划掉」,那一下在卡上。
   */
  fresh_result?: boolean
}

// ───────── 答案来找她(2026-10-04,卡 `claude/answer-comes-to-her`) ─────────

/**
 * 她在哪问的 —— 答案先往那儿送(「她在哪问就在哪答」)。
 *
 * **复用 {@link ButlerRuleChannel}**,不另立一个枚举:那一处已经是「她这句话是在哪儿说的」的主人
 * (`http.ts` 的 `ruleChannelOf` 一处算出来,`BUTLER_RULE_CHANNEL_TITLES` 一处给中文名)。
 * 这张卡只用得到其中三档:
 *
 * - `phone` 手机上(**打字与语音同一条路** —— 两样都走 `POST /butler/item`、都带设备令牌,
 *   所以它们不是两条兄弟路,是同一条);
 * - `desk` 电脑输入框;
 * - `call` 电话里。**这一条本来就当场答了**,所以只记下来、界面上照旧摆一行,
 *   **不再推一次通知**(见 `answerCell.ts` 的 `answerWorthNotifying`)。
 *
 * 捎话给别家 AI 那条**不在这里**:它的回话有自己的勾选规矩(2026-10-04 卡 `claude/relay-call-optin`),
 * 而且不建事项,压根不走这本账。
 */

/**
 * 一条「问一句」的回答。**答案原文一个字不截**(字幕那一行自己截一句、点一下展开全文;
 * 通知正文由壳 / 原生那一侧决定摆多长)——「取不到就缺席,不编一个」的另一面是「取到了就别洗」。
 */
export interface AnswerView {
  /** 这一条的 id。= 那张卡的 `task_id`(一张卡一条回答,她再问一句是新的一条卡)。 */
  id: string
  /** 她问的那一句(那张卡的标题;认不出来就是她的原话)。 */
  question: string
  /** 答案原文。**不截**。 */
  answer: string
  /** 答案到的时刻(ISO)。 */
  at: string
  /** 那张卡(点开看整段对话用)。 */
  task_id?: string
  /** 那条 DSH 会话(「打开整段对话」那条路用)。 */
  session_id?: string
  /** 她在哪问的(见上面那一段)。认不出来就缺席 —— 那时两端都摆、都推通知:宁可多摆一处,不能让答案没去处。 */
  where?: ButlerRuleChannel
  /** 她看过了(两端同步:`POST /answers/seen`)。缺席 = 还没看过。 */
  seen_at?: string
}

export interface AnswersView {
  /** 最近几条,新的在前。看过的留一会儿(她点开过的那一条不该立刻从字幕里消失)。 */
  items: readonly AnswerView[]
  /** 还没看过的几条。两端那一行「有 N 条新回答」认它,**不自己数**。 */
  unseen: number
}

/**
 * 一张「刚办完 · 结果一句话」。**办完不直接沉进「办完」**:她看过或划掉才收进去。
 *
 * 为什么不新开一个事项状态:状态表是人摆卡的地方(`todo/doing/blocked/confirm/done/canceled`),
 * 多一个 `just_done` 会让每一处转换表、每一处「收场了没有」都要跟着改一遍,而这件事说的
 * 不是「这件事到哪一步了」,是「**她看过结果了没有**」。所以只在卡上记一格 `seen_result_at`,
 * 这一份是从它算出来的投影。老客户端不认这一格,照旧现在的样子。
 */
export interface FreshResultView {
  /** 那张卡。 */
  task_id: string
  /** 卡的标题(她当初交代的那件事)。 */
  title: string
  /** 结果一句话(交付物里那段回答 / 卡上那句 note;两样都没有就缺席)。 */
  result?: string
  /** 办完那一刻(卡的 `updated_at`)。 */
  done_at: string
}

export interface FreshResultsView {
  /** 刚办完、还没看过的那几件,新的在前。 */
  items: readonly FreshResultView[]
}

// ───────────────────── 页面自己报错(2026-09-25,卡 V) ─────────────────────

/**
 * 页面上出的错(2026-09-25,卡 V)。09-25 晚维护者点「事务官」没反应、页面卡死,而
 * **没有任何地方记录** —— 统筹只能靠他复述。从此:客户端 `window.onerror` / `unhandledrejection`
 * 报到 `POST /client/error`,进服务端日志 + `/state.client_errors`(最近几条)。
 * 事务官在设置里看得到,统筹 `curl` 查得到。手机端同一条路。
 */
export interface ClientErrorView {
  /** 服务端收到的时刻(ISO)。 */
  at: string
  /** 哪一头出的:电脑页面 / 手机。 */
  where: 'desktop' | 'phone'
  /** 一句话(`error.message`;没有就 `String(reason)`)。截过。 */
  message: string
  /** 栈的前几行(截过)。取不到就缺席。 */
  stack?: string
  /** 出错时在哪一页 / 哪一块(客户端自己填的一句,如 `butler` / `settings`)。 */
  view?: string
  /** 同一条错误连着报了几次(同 message + stack 前缀折叠成一行,不让一条死循环冲掉别的)。 */
  count: number
}

/**
 * 「这件事里同类的都允许」(2026-09-25,卡 M)记下的那几条:哪件事、哪一类、放行过几次。
 * 挂在事项上的记在磁盘上(DSH 重启不再问同一类),那件事办完 / 取消就作废;没挂在事项上的只在内存里。
 */
export interface ApprovalGrantView {
  session_id: string
  task_id?: string
  key: string
  title: string
  /** 按这一条自动放行了几次(不算他点的那一次)。 */
  allowed: number
  at: string
}

/**
 * 事务官在 DSH 会话里问他的一件事(2026-09-25,卡 M;DSH 上游 `ask_user_question` 那个提问面板)。
 *
 * 维护者:「对于用户来说,不应该漏出来这个底层,选项应该直接在外层事务官那里显示」。以前这个面板只在 DSH 原始界面里有,
 * 工作台和手机上都看不到。现在工作台排在 DSH 提问 waterfall 的最前面,挂在这里,**电脑球下与手机「等你确认」都能答**;
 * 哪边先答算哪边,答完两边同时消失,答案送回那条会话她接着干。
 *
 * 文字服务端已经收拾过(去掉 `**` 之类的记号,「(Recommended)」换成「(推荐)」),两端照着摆。
 */
export interface PendingQuestionView {
  id: string
  session_id: string
  /** 这条会话挂在哪张卡上(查不到就缺席)。 */
  task_id?: string
  task_title?: string
  at: string
  questions: readonly PendingQuestionItemView[]
}

export interface PendingQuestionItemView {
  /** 她给这一问起的 id,答的时候原样带回去。 */
  id: string
  /** 小标题(「派活前对一遍」)。 */
  header?: string
  /** 她的话。 */
  question: string
  /** 补充说明。 */
  detail?: string
  /** 能不能多选。 */
  multi: boolean
  options: readonly PendingQuestionOptionView[]
}

export interface PendingQuestionOptionView {
  /** 原样的选项名 —— **交回去的是它**,一个字不改。 */
  label: string
  /** 摆在按钮上的字(「(Recommended)」换成「(推荐)」、去掉记号)。 */
  text: string
  /** 选项底下那行小字。 */
  note?: string
}

/** POST /questions/answer 里的一问一答。与 DSH 的 `AskUserQuestionAnswerItem` 同形。 */
export interface QuestionAnswerItem {
  id: string
  selected: readonly string[]
  custom?: string
}
/**
 * 引导开口前,DSH 为认刚领到的模型凭证要重启一次(modelAutoSetup.restartIfPending)。
 * 那一下 `POST /onboarding/session` 回 503 `{ error: 这句, restarting: true }`。
 *
 * 2026-09-24 维护者:原来那句「事务官正在重启,好把刚接上的模型服务认下来 —— 十几秒后自己回来,页面不用动。」
 * 用红字写在首次流程页正中间,像报错。这是**预料之中的一步**,不是出错:界面上只配一行灰字 + 球的等待态,
 * 重启完自动接着往下走、这一行自己消失;真的一直没回来才用红字(ONBOARDING_RESTART_TIMEOUT_TEXT)。
 * 服务端回包与界面用的是这同一句(两处对齐)。
 */
export const ONBOARDING_RESTARTING_NOTE = '稍等,正在准备…'
/** 重启之后等了很久还没回来(真失败):这时才用红字。 */
export const ONBOARDING_RESTART_TIMEOUT_TEXT = '事务官重启之后一直没回来。等一会儿再点一次;还不行就把工作台窗口关掉重开。'

/* ──────────────────────── 他的规矩:一处存、处处读(2026-09-24 晚,卡 K)──────────────────────── */

/**
 * 一条规矩管哪一块(docs/设计-全局自进化-2026-09-24.md 二.1)。**按字眼归类,不经模型**;设置里可以改。
 *
 * - `all`     全局(不分场合都算)
 * - `say`     她怎么说话(电话、回话)
 * - `ui`      界面(派做界面的活、验界面的结果、摆界面时)
 * - `review`  怎么验收
 * - `content` 内容(文案、标题、选题)
 */
export type ButlerRuleArea = 'all' | 'say' | 'ui' | 'review' | 'content'

export const BUTLER_RULE_AREAS: readonly ButlerRuleArea[] = ['all', 'say', 'ui', 'review', 'content']

export const BUTLER_RULE_AREA_TITLES: Readonly<Record<ButlerRuleArea, string>> = {
  all: '全局', say: '说话', ui: '界面', review: '验收', content: '内容',
}

export function isButlerRuleArea(value: unknown): value is ButlerRuleArea {
  return typeof value === 'string' && (BUTLER_RULE_AREAS as readonly string[]).includes(value)
}

/**
 * 一条规矩此刻算不算数。
 *
 * - `active`   他明说的(「以后都…」「不要…」、设置里填的、统筹从「观察」导入的)—— **当场生效**
 * - `trial`    没明说,但在不止一件活上打回过同一处 —— 先试着照做,由下一件活的结果来验
 * - `kept`     试用验过了(下一件他通过了)
 * - `reverted` 试用没见效(下一件他又打回同一处)—— 不再照做,留底
 * - `removed`  他删的 —— 不再照做,留底(设置里能恢复)
 */
export type ButlerRuleStatus = 'active' | 'trial' | 'kept' | 'reverted' | 'removed'

/** 这条是从哪条路进来的。**只收他本人的话**:系统写的字(通话纪要、引导出处说明)一律进不来。 */
/**
 * `onboarding`(2026-09-25,卡 O):引导里他说的分工(谁写代码、谁做综合、谁管哪个项目),落地时自动进表。
 */
export type ButlerRuleChannel = 'call' | 'phone' | 'desk' | 'review' | 'settings' | 'coordinator' | 'observation' | 'butler' | 'onboarding'

export const BUTLER_RULE_CHANNELS: readonly ButlerRuleChannel[] = ['call', 'phone', 'desk', 'review', 'settings', 'coordinator', 'observation', 'butler', 'onboarding']

export const BUTLER_RULE_CHANNEL_TITLES: Readonly<Record<ButlerRuleChannel, string>> = {
  call: '电话里', phone: '手机上打字', desk: '电脑上打字', review: '验收打回', settings: '设置里',
  coordinator: '跟统筹说的', observation: '记忆「观察」', butler: '事务官在对话里听到的', onboarding: '引导里',
}

export interface ButlerRuleEvidence {
  channel: ButlerRuleChannel
  at: string
  /** 他的原话(或打回原因)。 */
  text: string
  /** 哪件活(事项 id / 需求卡名)。 */
  where?: string
}

/** 一条规矩(`GET /butler/rules` 回的形状;电脑与手机设置里那张表一行一条)。 */
export interface ButlerRuleView {
  id: string
  /** 规矩本身(他的话)。 */
  text: string
  /** 短名(电话里列举、卡上小标用)。 */
  title: string
  area: ButlerRuleArea
  status: ButlerRuleStatus
  /** 明说的 / 重复出现学到的 / 从「观察」导入的 / 选题卡偏好(老那一截)/ 引导里说的(落地时自动进表,2026-09-25)。 */
  origin: 'said' | 'repeated' | 'observation' | 'topic' | 'onboarding'
  evidence: readonly ButlerRuleEvidence[]
  created_at: string
  updated_at: string
  /** 试用的结论(人话)。 */
  verdict?: string
  /** 这一条能不能在设置里改字(选题卡偏好那几条只能撤)。 */
  editable: boolean
}

export interface ButlerRulesView {
  /** 算数的(生效 + 试用 + 验过保留),生效的在前。 */
  rules: readonly ButlerRuleView[]
  /** 不算数的(他删的 + 没见效撤了的),留底可恢复。 */
  retired: readonly ButlerRuleView[]
  /** 这张表同步进 ~/.dsh/AGENTS.md 了没有(每条新会话才读得到)。 */
  synced?: { ok: boolean, at?: string, note?: string }
}

/* ─────────── 偏好:办完提醒的范围 + 桌面活直派(2026-10-23,卡「分层第二刀一」)─────────── */

/**
 * 办完要告诉她的那一类事项。她 10-03 在产物上扩大了「哪几类事项办完要告诉她」(运营维护包审计);
 * 这张卡把它开成设置项,判定(算不算失败、谁的会话收尾)留本体不动,开关只在出事件那一处读。
 */
export type TellKind = 'mine' | 'dispatch' | 'meeting' | 'routine'

export const TELL_KINDS: readonly TellKind[] = ['mine', 'dispatch', 'meeting', 'routine']

/** 设置里那组勾的字(交办 / 派活 / 会议 / 例程)。 */
export const TELL_KIND_TITLES: Readonly<Record<TellKind, string>> = {
  mine: '交办',
  dispatch: '派活',
  meeting: '会议',
  routine: '例程',
}

/** 哪几类事项办完要告诉她。缺省照 2026-10-23 之前的行为:交办 / 会议 / 例程提醒,派出去的活不提醒。 */
export interface TellScopeView {
  mine: boolean
  dispatch: boolean
  meeting: boolean
  routine: boolean
}

export const TELL_SCOPE_DEFAULT: TellScopeView = { mine: true, dispatch: false, meeting: true, routine: true }

/** 「派活与办完提醒」那一节的值(`GET /dispatch/prefs`;电脑设置页,与 `dispatch-prefs.json` 同形)。 */
export interface DispatchPrefsView {
  /** 办完要告诉她的那几类事项。 */
  tell_scope: TellScopeView
  /** 「桌面那一类不问就派」(2026-10-03 维护包那一项;缺省关 = 「先问我」档照旧由事务官先接手)。 */
  auto_desk: boolean
}

export const DISPATCH_PREFS_DEFAULT: DispatchPrefsView = { tell_scope: TELL_SCOPE_DEFAULT, auto_desk: false }

/* ─────────── 从行为账里数出来的习惯(2026-10-09,`server/habits.ts`)─────────── */

/**
 * 习惯的五种:默认分派 / 什么时段不打电话 / 早报几点备好 / 这类事问不问她 / 说话和做事风格。
 * 前四种是从行为账里**数**出来的,不经模型;风格(`style`,`server/styleHabits.ts`)由模型从她的原话 / 观察里提候选、
 * 必须附原话,计数与验证仍在代码。状态都沿用规矩表那一套(`trial` / `kept` / `reverted` / `removed`)。
 */
export type HabitKind = 'dispatch' | 'quiet' | 'brief' | 'noask' | 'style'
export type HabitStatus = Exclude<ButlerRuleStatus, 'active'>

/** 一条习惯(`GET /habits` 回的形状;「它学到了什么」那一页一行一条)。 */
export interface HabitView {
  id: string
  kind: HabitKind
  kind_title: string
  /** 人话:「写代码的活 · Lapis 这类事默认派给 Codex」。 */
  text: string
  /** 她在嫌什么 / 要什么(只有风格那一种有:「嫌说得太长、要短」;`text` 是照做的那一句)。 */
  title?: string
  status: HabitStatus
  /**
   * 凭什么:哪几次、什么时刻,一条一行。`said` 是她的原话(可选,2026-10-09 卡「它学到了什么」加:
   * 风格那一类必须附原话,「它学到了什么」那一页照原样引出来;计数那几种不带)。
   */
  evidence: readonly { at: string, what: string, said?: string }[]
  /** 试用 / 留下之后真用上了几次。 */
  applied: number
  last_applied_at?: string
  adopted_at: string
  updated_at: string
  /** 留下 / 撤的理由(人话)。 */
  verdict?: string
}

export interface HabitsView {
  /** 正在试用的。 */
  trial: readonly HabitView[]
  /** 验过留下的。 */
  kept: readonly HabitView[]
  /** 撤掉的(她纠正了自动撤的 + 她点「撤掉」的),不再自动学回来。 */
  retired: readonly HabitView[]
}

/* ─────────── 事务官的提示词:集中改的那一页(2026-10-01,`server/promptsPage.ts`)─────────── */

/**
 * `~/.dsh/AGENTS.md` 里的一段(`GET /butler/prompts`)。
 *
 * **不露内部的东西**(同规矩那一节):段名是中文的标记名,路径只露 AGENTS.md 那一条
 * (她改坏了得找得到那份文件)。
 */
export interface ButlerPromptSectionView {
  /** 标记段名(`<!-- 引导:X:开始 -->` 里的 X);首行那句「我叫 X。」用「名字」。 */
  name: string
  title: string
  /** 这一段是干什么的、谁会写它。 */
  note: string
  /** 此刻文件里那一份全文。 */
  body: string
  /** 这一段此刻在不在文件里(技能还没接上时 false)。 */
  present: boolean
  /** 她能在这一页改吗(不可改清单那几段、以及编辑入口在别处的那一段都是 false)。 */
  editable: boolean
  /** 她改过这一段(用户层里有一份覆盖)。 */
  overridden: boolean
  /** 她改过、而默认那一份后来被发版更新了 —— 不冲掉,但要告诉她。 */
  default_changed: boolean
  /** 她改之前那一份(给「恢复默认」看)。 */
  default_body?: string
  /** 发版之后那一份新默认(给「看新默认 / 换成新默认」看)。 */
  latest_default_body?: string
  /** 撤得回上一版吗。 */
  can_undo: boolean
  /** 只读的原因(不可改清单里哪一项)。 */
  locked?: string
  /** 编辑入口在别处时指过去的那句话。 */
  elsewhere?: string
  /** 一个例子(人话那几项每项一句说明 + 一个例子,2026-10-02)。 */
  example?: string
  /** 技能正文:她改不了,这里说清为什么、以及她的那几句该写在哪(2026-10-02)。 */
  manual?: string
}

/**
 * 她在某个**工作环节**上的偏好(2026-10-02,卡「提示词页改成她的偏好页」)。
 *
 * 环节名与例子从模板里那几条技能取(`opsSkills.ts` 的 `stage`),**不在界面里写第二份**。
 * 她写的是一条一句的短话;正文归本体,写 AGENTS.md 那一刻本体把这几句接上去。
 */
export interface ButlerPromptStageView {
  /** 对应哪一段(技能段名)。界面上不显示它,回写时带着。 */
  name: string
  /** 人话环节名(「选题立框架」「标题与封面」)。 */
  title: string
  /** 一句说明:这个环节它替你干什么。 */
  note: string
  /** 一个例子:这个环节你可能会说的一句偏好。 */
  example: string
  /** 她说过的那几条。 */
  lines: readonly string[]
  /** 这个环节此刻接上了没有(没接上时她写的偏好先存着,接上就带进去)。 */
  present: boolean
  can_undo: boolean
  /** 迁移留下的那一段旧正文(她 10-01 那一版改过、拆不成条目的)。 */
  kept?: string
  /** 「这段你改过的旧内容我替你放在这里了」—— 提示一次,她点过就没了。 */
  notice?: string
}

export interface ButlerPromptsView {
  /** `~/.dsh/AGENTS.md`。 */
  file: string
  /**
   * **人话那几项**:它叫什么 / 怎么称呼你 / 说话方式 / 你的规矩 / 还想交代的几句。
   * 这一栏默认就摊开,里面一个接口、一条路径都没有(2026-10-02)。
   */
  basics: readonly ButlerPromptSectionView[]
  /** 按她的模板列的**各工作环节偏好**。 */
  stages: readonly ButlerPromptStageView[]
  /** 页底「工作台怎么干活(只读)」:技能正文那一大摊,**默认收起**。 */
  manual: readonly ButlerPromptSectionView[]
  /** 段外那些话:**只读**,工作台一个字不写(也收在页底那一节里)。 */
  outside: string
  note: string
}

/** 按规矩自查一件交回来的活(`POST /butler/rules/check`、`/butler/item/dispatch` 报 done 时)。 */
export interface ButlerRuleViolation {
  rule_id: string
  rule: string
  /** 为什么算违反(人话,带文件与行号)。 */
  why: string
}

export interface ButlerRuleReviewView {
  pass: boolean
  violations: readonly ButlerRuleViolation[]
  /** 机器查不了、要她亲眼看的那几条(短名)。 */
  by_eye: readonly string[]
  /** 没过时给那家的打回原话(事务官照发)。 */
  reject_text?: string
  /** 查了哪几条(id)。 */
  checked: readonly string[]
  at: string
}

/* ──────────────────────── 一件事一份、进度靠证据(2026-09-25,卡 N)──────────────────────── */

/**
 * 负责人里「人」那三档(2026-09-25,卡 N;设计 docs/设计-谁来做与进度靠证据-2026-09-25.md 第一节第 2 条)。
 *
 * - `me`        他自己:进「今天要做」、早报里提,**不派**;
 * - `colleague` 同事:只跟进、到期提醒,不派;
 * - `other`     别人(接手的人):同上。
 *
 * 为什么放进 `TaskAssignee` 而不是另开一格「owner」:负责人只有一个,「这张归谁」这一个问题不该有两个字段回答。
 */
export const PERSON_ASSIGNEES = ['me', 'colleague', 'other'] as const
export type PersonAssignee = typeof PERSON_ASSIGNEES[number]

export function isPersonAssignee(value: unknown): value is PersonAssignee {
  return typeof value === 'string' && (PERSON_ASSIGNEES as readonly string[]).includes(value)
}

/** 负责人那一格能填的全部值:事务官与会话来源那四家、能派活的几家、人那三档。HTTP 入口与 tasks.ts 同用这一个。 */
export function isTaskAssigneeValue(value: unknown): value is TaskAssignee {
  return (typeof value === 'string' && (AGENT_IDS as readonly string[]).includes(value))
    || isAgentDispatchFamily(value) || isPersonAssignee(value)
    // 2026-10-21 协作区:成员与 Agent 名片。
    || isMemberAssignee(value) || isAgentCardAssignee(value)
}

/**
 * 负责人怎么称呼(卡片、事项、早报、派活确认点同一套)。事务官叫「事务官」,不叫 DSH(不露内部的东西)。
 *
 * ★ 2026-09-25(卡 Z)起这是**开集**:能派活的有哪几家由 Agent 登记表说(`dispatchTargets`),
 * 表里没有的家名一律用 {@link assigneeName} 原样显示 —— 不猜名字,也不再为了显示去维护一份家名单。
 */
export const ASSIGNEE_NAMES: Readonly<Record<string, string>> = {
  dsh: '事务官',
  claude: 'Claude',
  codex: 'Codex',
  kimi: 'Kimi',
  gpt: 'GPT',
  doubao: '豆包办公',
  muse: 'Muse',
  manus: 'Manus',
  me: '你',
  colleague: '同事',
  other: '别人',
}

/** 一个负责人怎么称呼:表里有就用它;名片(`agent:…`)带了名片表就用名片的名字,没带原样显示。 */
export function assigneeName(assignee: string | undefined, cards?: readonly { id: string, name: string }[]): string {
  if (assignee === undefined) return '没写'
  // 成员 / 名片(2026-10-21):名片的名字由界面从名片表里换(带了表就换,没带去掉前缀原样显示)。
  if (assignee.startsWith('member:')) return assignee.slice('member:'.length)
  if (assignee.startsWith('agent:')) {
    const card = cards?.find(one => one.id === assignee)
    return card?.name ?? assignee.slice('agent:'.length)
  }
  return ASSIGNEE_NAMES[assignee] ?? assignee
}

/**
 * 卡片弹窗里那排可点的负责人里**不是 Agent 的那几档**(人那三档 + 事务官)。
 *
 * ★ 2026-09-25(卡 Z):几家 AI 原来写死在这一排(`'claude','codex','kimi','muse','manus','doubao'`),
 * 现在**从 Agent 登记表插进来**(`client/agentRegistryView.ts` 的 `assigneePicker`)—— 新接上一家,
 * 这一排就多一颗。只走接口的 GPT 照旧不画常驻按钮(电话里点名「让 GPT 写」照样落得到卡上)。
 */
export const ASSIGNEE_PICKER_PEOPLE: readonly TaskAssignee[] = ['me', 'dsh']
/** 2026-10-21 协作区:「同事 / 别人」退休,界面不再给选(老卡上的读到按「你」处理,见 `boardAssignee`)。 */
export const ASSIGNEE_PICKER_TAIL: readonly TaskAssignee[] = []

/**
 * 一张卡算不算一件「事项」(有人要动它)—— **事项与看板卡是同一份数据的两种排法**(看板按项目 / 冲刺,
 * 事项按「现在该谁动」),这个函数就是「事项那一排」的门,电脑、手机、服务端同用这一个。
 *
 * - 他交给事务官的(`direction:'mine'`):老口径,一个不少;
 * - 卡上写了负责人的:看板上建的、引导落地排的,只要写了谁负责,就是一件有人要动的事
 *   (2026-09-25 以前这类卡只在看板上,事项那一排看不见 —— 维护者:「哪些是谁来处理,这个明确吗」);
 * - 选题池的卡(`kind:'topic'`)只按 mine 算:它们在选题那一屏按六段排,运营模板一个字不变。
 */
export function isTrackedItem(task: Pick<TaskView, 'direction' | 'assignee' | 'kind'>): boolean {
  if (task.direction === 'mine') return true
  if (task.kind === 'topic') return false
  return task.assignee !== undefined
}

/** 进度的依据从哪来。 */
export type ProgressBasisKind = 'session' | 'dispatch' | 'commit' | 'release' | 'handoff' | 'decision' | 'item' | 'said'

export interface ProgressBasisView {
  kind: ProgressBasisKind
  /** 给人看的出处(人话,不带文件名、路径、提交号):「Codex 里「制作参赛网页」那段对话」「更新说明 0.2.98」「项目里的一次改动」「你说的」。 */
  source: string
  /** 对得上的那个东西:会话记录文件、文档路径、提交号、事项 id。 */
  ref?: string
  /** 这条证据的时刻(会话最后一轮、提交时刻、发版日)。 */
  at?: string
  /** 逐字摘的那一句。模型给的摘录**逐字核过在原文里**才留,核不上的整条丢掉。 */
  quote?: string
}

/**
 * - `found`    找到了证据,`line` 是按证据说的现在到哪;
 * - `none`     项目文件夹(仓库)、派出去的活、各家会话里都没找到 → `line` 是「还没看到进展,要你说一句」;
 * - `mismatch` 找到了,但和卡上写的(口述)对不上 → 问他。
 */
export type ProgressState = 'found' | 'none' | 'mismatch'

/**
 * 找不到证据时那一句(全仓库同一句,早报、卡片、电话都说它)。
 * 2026-09-25 按「不懂技术、第一次用的人」改过一遍:原来是「没找到证据,要你说一句」——「证据」是我们内部的说法,
 * 他看了只会想「什么证据?」;说「还没看到进展」,底下再补一句我在哪儿找过({@link progressNoneHint})。
 */
export const PROGRESS_NONE_LINE = '还没看到进展,要你说一句'

/**
 * 没看到进展时,那一句底下补的「我在哪儿找过」。**照实说**:这一轮没看各家的对话(他还没点头 / 说了不看)就不说看过。
 */
export function progressNoneHint(progress: Pick<TaskProgressView, 'read_sessions'> | undefined): string {
  return progress?.read_sessions === true
    ? '项目文件夹、交出去的活、你跟各家 AI 的对话里,都没说到这件事做到哪了。'
    : '项目文件夹和交出去的活里,都没说到这件事做到哪了(你跟各家 AI 的对话我没看)。'
}

/** 一张卡「现在到哪 · 依据 · 什么时候看的」。 */
export interface TaskProgressView {
  /** 一句话:现在到哪。没找到时就是 {@link PROGRESS_NONE_LINE}。 */
  line: string
  state: ProgressState
  basis: readonly ProgressBasisView[]
  /** 什么时候看的(这一轮评估的时刻,ISO)。 */
  checked_at: string
  /** 现在在等谁:他(审 / 点头 / 说一句)、某家 AI、同事别人、没人在等。说不准就缺席。 */
  waiting_on?: 'me' | 'agent' | 'others' | 'nobody'
  /** 卡上写的(口述)与证据对不上的那一句。 */
  mismatch?: string
  /** 这一句是模型读证据写的(`model`),还是规则拼的(`rules`:没接模型、到了花费上限、模型没回)。 */
  by: 'model' | 'rules'
  /** 和上一轮比变了没有(早报只念变了的)。 */
  changed?: boolean
  /** 这一轮看没看各家 AI 的对话(授权表 `read_session_content` 是「可以」才看)。没看到进展时「我在哪儿找过」照它说。 */
  read_sessions?: boolean
}

/** 现在该谁动。 */
export type ItemMover = 'me' | 'butler' | 'agent' | 'others' | 'none'

export interface TaskMoverView {
  who: ItemMover
  /** 一句话:「你来」「等你点头派给 Claude」「Claude 在做」「事务官在办」「等同事 · 9/29」「要你说一句」。 */
  line: string
  /** 负责人;没写负责人的老事项缺席。 */
  assignee?: TaskAssignee
}

/**
 * 没办完的事项停在哪一种(2026-10-12,卡「没办完的事项说清楚」;运营同学 10-12 排查报告)。
 *
 * 要分开说的四种:`waiting_her` 正常等她(验收、解卡、按发送、解锁电脑)、`result_unwritten` 执行结束但结果没回写
 * (会话已说完 / 那家交回了,卡还在进行中)、`channel_failed` 通道失败后没再推进、`likely_moot` 多半不再需要
 * (久无动静且没人在等)。另三种是正常的:`in_motion` 有一家 AI 正在做、`waiting_others` 等同事 / 别人、`queued` 排着且最近有动静。
 */
export type ItemStandingCase = 'waiting_her' | 'in_motion' | 'waiting_others' | 'queued' | 'result_unwritten' | 'channel_failed' | 'likely_moot'

export const ITEM_STANDING_CASE_TITLES: Readonly<Record<ItemStandingCase, string>> = {
  waiting_her: '等你',
  in_motion: '在做',
  waiting_others: '等别人',
  queued: '排着',
  result_unwritten: '结果回来了没收进卡',
  channel_failed: '没派成,停着',
  likely_moot: '多半不需要了',
}

/** 最后一条证据从哪来:派活回执(卡上的派活记录与任务账)、会话、她的操作;`card` = 卡上最后一次改动(分不出是谁改的)。 */
export type ItemEvidenceSource = 'dispatch' | 'session' | 'her' | 'card'

export const ITEM_EVIDENCE_SOURCE_TITLES: Readonly<Record<ItemEvidenceSource, string>> = {
  dispatch: '派活回执',
  session: '会话',
  her: '你的操作',
  card: '卡上改动',
}

export interface ItemEvidenceView {
  /** 一句人话:「在 Claude 那边看到了那一句(已送达,不等于办完)」。 */
  what: string
  at: string
  source: ItemEvidenceSource
}

/** 现在在等谁:她 / 某家 AI(含事务官)/ 解锁电脑 / 同事别人 / 没人在等。 */
export type ItemWaitingOn = 'her' | 'agent' | 'unlock' | 'others' | 'nobody'

/** 停太久时给她的三个选择(动作走现有入口,见 {@link itemStandingRequest})。 */
export type ItemStandingAction = 'continue' | 'close' | 'redispatch'

export const ITEM_STANDING_ACTION_TITLES: Readonly<Record<ItemStandingAction, string>> = {
  continue: '继续',
  close: '关掉',
  redispatch: '重派',
}

export interface ItemStandingView {
  case: ItemStandingCase
  /** 最后一条证据。一条都取不到就缺席。 */
  last?: ItemEvidenceView
  waiting_on: ItemWaitingOn
  /** 在等哪一家(`waiting_on: 'agent'`;事务官 = `dsh`)。 */
  agent?: string
  /** 下一步,一句人话。 */
  next: string
  /** 离最后一条证据几天(整天)。没有证据就缺席。 */
  idle_days?: number
  /** 超过这一档的阈值({@link ITEM_STANDING_STALL_DAYS})。早报只列带它的。 */
  stalled?: true
  /** 卡上给的选择。四种要分开说的才有。 */
  actions?: readonly ItemStandingAction[]
}

/** 没人在等的事项,几天没动静就算「多半不再需要」。 */
export const ITEM_LIKELY_MOOT_DAYS = 7

/**
 * 停多久算「停太久」(整天,离最后一条证据)。只有这四种会停太久;正常在做 / 排着 / 等别人不提。
 * 等她 3 天(早报每天都在说,3 天还没动就单独点名);结果没收进卡、没派成 1 天(那是代码该接上而没接上的,隔夜就该说);
 * 不再需要按定义就已经 7 天了。
 */
export const ITEM_STANDING_STALL_DAYS: Readonly<Record<'waiting_her' | 'result_unwritten' | 'channel_failed' | 'likely_moot', number>> = {
  waiting_her: 3,
  result_unwritten: 1,
  channel_failed: 1,
  likely_moot: ITEM_LIKELY_MOOT_DAYS,
}

/**
 * 三个选择各走哪个现有入口(电脑卡片与手机事项同用这一处)。
 * - 关掉 = `/task/move` 挪进「取消」(不是删,卡还在);
 * - 重派 = `/item/drive`(负责人驱动按负责人再派一次,派之前照样先按证据核);
 * - 继续:结果回来了没收进卡 → `/task/move` 收进「等我确认」;多半不需要了 → `/item/drive` 接着推;其余 → 打开这件,她自己接着处理。
 */
export function itemStandingRequest(taskId: string, standing: ItemStandingCase, action: ItemStandingAction):
  { path: '/task/move', body: { id: string, status: 'canceled' | 'confirm' } } | { path: '/item/drive', body: { task_id: string } } | { open: true } {
  if (action === 'close') return { path: '/task/move', body: { id: taskId, status: 'canceled' } }
  if (action === 'redispatch') return { path: '/item/drive', body: { task_id: taskId } }
  if (standing === 'result_unwritten') return { path: '/task/move', body: { id: taskId, status: 'confirm' } }
  if (standing === 'likely_moot') return { path: '/item/drive', body: { task_id: taskId } }
  return { open: true }
}

/** 「在等谁」那一句。`agent` 那一档带家名(登记表 / 退路表那个名字,调用方给)。 */
export function standingWaitingText(standing: Pick<ItemStandingView, 'waiting_on'>, agentName?: string): string {
  switch (standing.waiting_on) {
    case 'her': return '在等你'
    case 'agent': return `在等 ${agentName ?? '那一家'}`
    case 'unlock': return '在等你解锁电脑'
    case 'others': return '在等别人'
    case 'nobody': return '没人在等'
  }
}

/**
 * 卡面上那一小格(电脑看板卡、手机事项同一句):只给要她留意的那几种 —— 四种要分开说的里,
 * 等她的只在停太久时出现(等她验收本来就摆在「等我确认」那一列,不必再说一遍)。正常在做 / 排着 / 等别人不出字。
 */
export function standingBadgeText(standing: Pick<ItemStandingView, 'case' | 'idle_days' | 'stalled'> | undefined): string | undefined {
  if (standing === undefined) return undefined
  const problem = standing.case === 'result_unwritten' || standing.case === 'channel_failed' || standing.case === 'likely_moot'
    || (standing.case === 'waiting_her' && standing.stalled === true)
  if (!problem) return undefined
  const days = standing.idle_days === undefined || standing.idle_days < 1 ? '' : ` · 停了 ${standing.idle_days} 天`
  return `${ITEM_STANDING_CASE_TITLES[standing.case]}${days}`
}

/** 评估器这一轮为什么跑。 */
export type ProgressTrigger = 'morning' | 'ask' | 'dispatch' | 'return' | 'manual' | 'startup'

/**
 * 短时刻(写进要存下来的那几句话里用):ISO →「9月24日 20:17」(本地时区);只有日子的(发版记录、决策记录那一节)→「9月25日」,
 * 不补一个编出来的钟点;认不出回空串。**不写「今天 / 昨天」**:这几句会存下来,过两天再看「昨天」就错了 —— 界面上现画的用 {@link friendlyWhen}。
 */
export function shortMoment(iso: string | undefined): string {
  if (iso === undefined) return ''
  const day = /^\d{4}-(\d{2})-(\d{2})$/.exec(iso)
  if (day !== null) return `${Number(day[1])}月${Number(day[2])}日`
  const at = new Date(iso)
  if (Number.isNaN(at.getTime())) return ''
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${at.getMonth() + 1}月${at.getDate()}日 ${pad(at.getHours())}:${pad(at.getMinutes())}`
}

/**
 * 界面上现画的时刻(2026-09-25 卡 N;维护者:「从常规用户的第一次使用角度」):「今天 20:17」「昨天 20:17」「9月22日 20:17」;
 * 只有日子的 →「今天」「昨天」「9月22日」;不是今年的带年份。`now` 用 /state.now(同一屏上两处不差一拍);认不出回空串。
 */
export function friendlyWhen(iso: string | undefined, now: string | number | undefined): string {
  if (iso === undefined) return ''
  const dateOnly = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso)
  const at = dateOnly === null ? new Date(iso) : new Date(Number(dateOnly[1]), Number(dateOnly[2]) - 1, Number(dateOnly[3]))
  if (Number.isNaN(at.getTime())) return ''
  const ref = now === undefined ? new Date() : new Date(now)
  const pad = (n: number): string => String(n).padStart(2, '0')
  const clock = dateOnly === null ? ` ${pad(at.getHours())}:${pad(at.getMinutes())}` : ''
  if (Number.isNaN(ref.getTime())) return `${at.getMonth() + 1}月${at.getDate()}日${clock}`
  const dayStart = (d: Date): number => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
  const days = Math.round((dayStart(ref) - dayStart(at)) / 86_400_000)
  if (days === 0) return `今天${clock}`
  if (days === 1) return `昨天${clock}`
  return `${at.getFullYear() === ref.getFullYear() ? '' : `${at.getFullYear()}年`}${at.getMonth() + 1}月${at.getDate()}日${clock}`
}

/**
 * **真派活之前那一问的字**(2026-09-25 卡 N;统筹:「真派活前要有确认,手机和电脑同一套」):
 * 「这张派给 Codex 开工?现在:<按证据的一句>(<出处> <时刻>)」/「这张交给事务官开工?…」。
 * 负责人驱动在外层挂的那一问(审批经纪人)、电脑卡片弹窗与手机事项详情里点「派给 X」之后那一下确认,**同一句**
 *(出处是人话:「Codex 里「制作参赛网页」那段对话 · 昨天 20:17」,不出现文件名、路径、提交号)
 *(手机协议子集 butler-app/src/api/protocol.ts 逐字抄一份)。证据和卡上对不上时把那一句接在后面 —— 派一件证据说已经做完的事,他得看得见。
 */
export function dispatchAskText(assignee: TaskAssignee | undefined, progress: TaskProgressView | undefined, extra?: string, now?: string | number, cards?: readonly { id: string, name: string }[]): string {
  // 「派给 Codex 开工」:英文名后面空一格;「交给事务官开工」不空。名片负责人带了名片表就念名片的名字(2026-10-22 卡 B)。
  const who = assignee === 'dsh' || assignee === undefined ? '交给事务官' : `派给 ${assigneeName(assignee, cards)} `
  const basis = progress?.basis[0]
  // 界面上现画的(给了 now)说「昨天 20:17」;挂进外层那一问的(会存一阵子)说「9月24日 20:17」。
  const when = now === undefined ? shortMoment(basis?.at) : friendlyWhen(basis?.at, now)
  // 没看到进展:派活这一问里不说「要你说一句」(他此刻要答的是派不派),只说还没看到。
  const where = progress === undefined || progress.state === 'none'
    ? '还没看到这件事的进展'
    : `${progress.line}${basis === undefined ? '' : `(${basis.source}${when === '' ? '' : ` · ${when}`})`}`
  const mismatch = progress?.state === 'mismatch' && progress.mismatch !== undefined ? `;和卡上对不上:${progress.mismatch}` : ''
  return `这张${who}开工?现在:${where}${mismatch}${extra === undefined || extra === '' ? '' : `;${extra}`}`
}

/**
 * 卡上那颗「派给 X」/「交给事务官」给什么字(2026-09-25 卡 N,负责人驱动的 driveNow)。**只在这张能派时给字**:
 * 在「待办」、负责人是某家 AI 或事务官、不是选题 / 需求卡(它们有自己那一套)、没有一次正在跑的派活。其余缺席 —— 按钮不画
 *(他 / 同事 / 别人的卡不派,是提醒)。电脑卡片弹窗与手机事项详情同用(手机子集逐字抄一份)。
 */
export function driveLabel(task: Pick<TaskView, 'status' | 'assignee' | 'kind' | 'dispatch'>): string | undefined {
  if (task.status !== 'todo' || task.kind === 'topic' || task.kind === 'feature') return undefined
  if (task.dispatch?.status === 'running') return undefined
  const who = task.assignee
  if (who === undefined || isPersonAssignee(who)) return undefined
  if (who === 'dsh') return '交给事务官'
  if (!isAgentDispatchFamily(who)) return undefined
  return `派给 ${ASSIGNEE_NAMES[who]}`
}

/** `/state.progress`:评估器此刻的样子。 */
export interface ProgressRunStateView {
  running: boolean
  last?: {
    at: string
    trigger: ProgressTrigger
    /** 这一轮核了几张。 */
    cards: number
    /** 这一轮模型花了多少(元)。 */
    spend_cny: number
    by: 'model' | 'rules'
    note?: string
  }
  /** 今天所有评估一共花了多少(元)。 */
  today_cny: number
  /** 一轮的上限(元,与「每件事上限」同一套设置)。 */
  cap_cny: number
  /** 读不读得了各家会话的最后几轮(授权表 `read_session_content`):可以 / 要问(还没问过或等他答)/ 不可以。 */
  sessions: 'allowed' | 'ask' | 'denied'
}

/* ──────────────────────── 在跑的会话写清是什么(2026-09-25,卡 P)──────────────────────── */

/** 最近在做什么:一句人话 + 那一刻(ISO)。见 server/sessionDigest.ts。 */
export interface SessionActivity {
  line: string
  at: string
}

/** 一条会话最近的一轮:他说的一句 + 它这一轮最后说的 + 数出来的「做了什么」。字段各自可缺。 */
export interface SessionDigestRound {
  ask?: string
  reply?: string
  did?: string
  at?: string
}

/**
 * `GET /sessions/digest?agent=&id=`:点开一条「某家在跑的会话」时看的那一页 ——
 * 标题、在哪个项目、最近在做什么、最近几轮。**当场读那条会话的记录**(头尾各一段,有上限),不经模型、不落盘。
 * 电脑事务官页与手机「在办」同一个口。读不到那条会话的记录 → 404 + 一句人话。
 */
export interface SessionDigestView {
  /** 哪一家(会话来源的 id,按字符串处理 —— 自动发现的 Agent 挂进来也是这一格,不收窄成固定几家)。 */
  agent: string
  session_id: string
  /** 那家自己的标题;没有就第一句要求的前 20 来字。都读不到 = 缺席(界面写「某家的一条会话」)。 */
  title?: string
  /** 在哪个项目(与 /state.sessions[].project 同一个口径;「未归类」照写)。 */
  project: string
  status?: SessionStatus
  /** 这条会话进入当前状态多久了(秒),与 /state 同源。 */
  elapsed_sec?: number
  activity?: SessionActivity
  /** 最近几轮,旧 → 新(最多 6 轮)。 */
  rounds: readonly SessionDigestRound[]
  /**
   * 最近几轮**为什么是空的**(2026-09-28,卡 WR)。读它的窗口读出来的那几条只存了标题与最新一句,
   * 没有对话记录可读 —— 这一格如实说一句,界面照它说(不画一段空白,也不假装在读)。
   */
  rounds_note?: string
  /** 这一轮说完了(它在等他下一句)。 */
  ended?: boolean
  /** 这一次是什么时候读的(ISO)。 */
  read_at: string
  /**
   * **现在能不能在这张卡下面直接往这条会话里说一句**(2026-09-27,卡 PS;维护者 22:0x:
   * 「还得能直接在下面输入信息,对标最外侧的输入框,能直接把信息发到这个会话窗口里」)。
   * 手机会话卡据此决定给不给输入框:能捎就摆(发出去走 `POST /sessions/relay`),
   * 不能捎就一行 `why` 说清为什么、**不摆输入框**(摆了按下去只会挨一句「你自己去电脑上说」)。
   * 判据是真捎话那道门(`server/sessionAnswer.ts` 的 `relayReady`,一只手都不碰);捎话那条路没接上时缺席。
   */
  relay?: SessionRelayReadyView
}

/** 能不能往这条会话里捎话(卡 PS)。`why` 是送不进去时那句人话,与真捎话回的那一句一模一样。 */
export interface SessionRelayReadyView {
  can: boolean
  why?: string
  /** 它此刻在跑没(2026-09-28,卡 WR):手机卡片据此摆不摆「打断并发送」那颗次级键。 */
  running?: boolean
  /**
   * 能不能替他**打断**(先按那家的停止键,停下了再送)。`can:false` 时 `why` 是那句人话
   * (「认不出它的停止键,没敢替你按」/「这一家我不去打断」)—— 界面照它说,不摆那颗键。
   */
  interrupt?: { can: boolean; why?: string };
}

/* ──────── 1a「落地」口常量(2026-10-24,卡 t-1fc4c898;类型源头在 server/butlerSay.ts,两处用例互钉)──────── */
export const SAY_KINDS = ['记', '办', '问', '改', '捎话', '闲聊'] as const
export const RISKS = ['none', 'external', 'irreversible', 'money', 'release'] as const

/* ──────────────────────── 同事项接续(2026-10-23,卡 A「同事项接续与动作契约」)──────────────────────── */

/**
 * 一条来源这会儿能做什么(2026-10-23,卡 A)。**动作只有这两条路**,与各家的实现无关:
 *   - `butler`:发到这条事项自己的事务官会话(与 `POST /butler/item/say` 同一条路);
 *   - `relay`:发到原 Agent 的那条会话(与 `POST /sessions/relay` 同一条路,目标明确、不按名字猜)。
 * `none` = 这条来源这会儿接续不了,`why` 是那句人话(与真发话回的那一句同一个出处)。
 * 普通留言(只记记录)不在这里 —— 它总可以,由动作接口的 `record` 档表达。
 */
export type ItemContinueAction =
  | { kind: 'butler' }
  | { kind: 'relay' }
  | { kind: 'none', why: string }

/** 同事项的一条来源:`GET /butler/item/:id/continue` 下发,电脑与手机同一个口。 */
export interface ItemContinueSource {
  /**
   * 稳定键。事务官那条会话固定 {@link ITEM_CONTINUE_BUTLER_KEY};外部会话是
   * `${agent}:${session_id}`(与 TaskLink 同一个键)。动作接口按它认目标。
   */
  key: string
  agent: string
  session_id: string
  /** 这条来源的名字(给人在列表里认);认不到时「X 的会话」。 */
  title: string
  action: ItemContinueAction
}

/**
 * `GET /butler/item/:id/continue`:这件事现在能从哪儿接着做。
 * 来源只有两类:事项自己的事务官会话 + `links` 里的外部会话;不另建来源账。
 */
export interface ItemContinueView {
  id: string
  sources: readonly ItemContinueSource[]
  /** 一条能续的来源都没有时的一句人话(普通记录总可以,不在这一格里)。 */
  note?: string
}

/**
 * 接续动作的**结果事实**(2026-10-23,卡 A):保存 / 暂存待上线 / 已投递 / 失败 / 这条路走不通 / 要先选来源。
 * 2026-10-26(卡「事务官机制A」)补 `redirected` / `recalled` 两档:**只有真打断 / 真停住**才许回 —
 * steer 被接受(改方向、加速)回 redirected / sent,撤回把在跑的那一轮真停住了才回 recalled。
 *
 * ★ **没有 `started` 这一档**:实际开工只有拿到真实开工回执才许说(卡上回执、运行账),
 * 发一句话这个动作本身永远报不出来 —— 客户端不许凭「送进去了」自己推「它开工了」。
 */
export type ItemContinueFact = 'saved' | 'kept' | 'sent' | 'failed' | 'unsupported' | 'pick' | 'redirected' | 'recalled'

/**
 * 同一事项上补一句的**意图**(2026-10-26,卡「事务官机制A」;依据
 * docs/设计-事务官通用规划与分工机制-2026-10-26.md 缺口表第 4 行):
 *   - `supplement` 补充:排进原会话,不打断(旧调用不传 intent 的缺省,行为逐字不变);
 *   - `redirect` 改方向:**打断**正在跑的轮次(steer),旧做法就此作废,已派未回的不追、不二派;
 *   - `hurry` 加速:同样打断递进去,催它别干等(计划不变,不是改向);
 *   - `recall` 撤回:把在跑的那一轮**停住**(cancel)再交代一句,别再办别再派。
 * 只对事务官那条会话有意义;往外部会话 relay 只捎得动原话,这三种意图那里如实回 unsupported。
 */
export type ItemSayIntent = 'supplement' | 'redirect' | 'hurry' | 'recall'

/** 意图全集(服务端校验用;用例钉着,认不出的值拒掉,不静默当补充)。 */
export const ITEM_SAY_INTENTS: readonly ItemSayIntent[] = ['supplement', 'redirect', 'hurry', 'recall']

/** `POST /butler/item/continue` 的结果。`note` 是给人看的那一句,照服务端原话说,不另编。 */
export interface ItemContinueResult {
  ok: boolean
  fact: ItemContinueFact
  note: string
  /** 这次动作用的意图(缺席 = 老服务端 / 老调用,按 supplement 理解)。 */
  intent?: ItemSayIntent
  /** 实际发去的那条来源(ITEM_CONTINUE_BUTLER_KEY 或 `agent:session_id`)。 */
  target?: string
  /** 投递的如实细分:真发到会话但当场没核上时是 'unconfirmed'(多半已收到,先别重发)。 */
  delivered?: 'sent' | 'kept' | 'unconfirmed'
  /** fact 是 'pick' 时的候选(只列能续的,不猜最新)。 */
  candidates?: readonly ItemContinueSource[]
  /**
   * 事务官会话那一路的**最终拒发分类**(2026-10-23 晚,吸收 main 787f4d8f8 与 /butler/item/say 同一契约):
   * model = 模型还没完成应用(零发送,原事项与会话保留),host = 会话通道暂不可用。两种都**没有发送**。
   * 2026-10-26(卡「事务官机制A」)stale_queue = 改方向前要清掉这条会话里排着的旧话(旧队列不复活),
   * 队列这会儿读不清/清不动 —— 怕旧方案复活,这句没有发送,宁可原样不动。
   */
  code?: 'model_alignment_failed' | 'session_send_failed' | 'session_stale_queue'
  /** 撤回专用:在跑的那一轮真停住了是 true;没会话/没在跑是 false。 */
  stopped?: boolean
  /** 撤回 / 改方向专用:这次作废掉的几句排队旧话(工作台递进去的)条数。 */
  cleared?: number
}

/** 事务官那条会话在来源清单里的固定键。 */
export const ITEM_CONTINUE_BUTLER_KEY = 'butler'

/* ──────────────────────── 手机读对话:历史、完整对话、附件(2026-10-01)──────────────────────── */

/**
 * `GET /sessions/history`:各家最近 {@link SESSION_HISTORY_DAYS} 天的对话,**从各家的会话记录文件读**(不是这次开机以来的会话表),
 * 按最后动静排、每家多条、分页。窗口型那几家(没有记录文件)也在里面,带 `window_only`。
 */
export const SESSION_HISTORY_DAYS = 7
export const SESSION_HISTORY_LIMIT = 20
/**
 * 固定入口那一份每家最多这么多条(2026-10-03,卡「手机各家最近会话固定入口」;维护者原话:
 * 「给他一个固定的入口,固定显示每一家最近的十个会话,最好是按项目分好的」)。
 * 手机首页那个常驻入口按它要 `?per_family=10`;**老工作台不认这个参数**,见 {@link SessionHistoryView.per_family}。
 */
export const SESSION_HISTORY_PER_FAMILY = 10
/** 窗口型那几家只能看到这么多(手机照这句说)。 */
export const SESSION_WINDOW_ONLY_NOTE = '这家只能看最新一句,完整的对话在它自己的窗口里'
/**
 * 窗口型那几家(豆包 / Manus / Muse / Grok Bot / Antigravity …)的图片与文件(2026-10-04)。
 *
 * 它们是**读窗口**读出来的:工作台只拿到窗口上那一句字,没有任何会话记录文件 —— 既没有图片的字节,
 * 也没有哪个文件在哪的线索。**不编一个** —— 照这句如实说。
 */
export const SESSION_WINDOW_ONLY_MEDIA_NOTE = '这一家没有对话记录文件,图片和文件只能在电脑上它自己的窗口里看'

export interface SessionHistoryItem {
  agent: string
  session_id: string
  /** 那家自己的标题 / custom-title / 第一句前 20 来字(与卡片同一套取法);读不到缺席。 */
  title?: string
  project?: string
  /** 最后动静(ISO):记录文件的修改时刻。窗口型读不到真实时间 → 缺席(会话表里那一刻只是读窗口的时刻,2026-10-01)。 */
  last_at?: string
  /** 最后一句(洗过、截过的人话)。 */
  last_line?: { who: 'you' | 'ai', text: string }
  /** 此刻会话表里的状态(这次开机后见过才有):手机据此把在跑的留在「正在办」。 */
  status?: SessionStatus
  /** 窗口型那几家:只有标题与最新一句,没有完整对话。 */
  window_only?: true
}

export interface SessionHistoryView {
  items: SessionHistoryItem[]
  /** 往下翻的游标(原样带回 `before=`);缺席 = 到底了。`per_family` 那一档整份一次给完,这一格永远缺席。 */
  next?: string
  days: number
  read_at: string
  /**
   * 这一份是按**每家最多 n 条**取的(2026-10-03)。只有带了 `?per_family=` 的请求才有,
   * 值是真用上的那个数(服务端夹过)。
   *
   * **缺席就是「这台工作台不认 `per_family`」** —— 老工作台会把这个参数当没看见、照旧回那一页,
   * 回包的形状一模一样,手机只能靠这一格分辨。手机据此退回老样子(一条平列表)并说一句,不空白。
   */
  per_family?: number
}

/** 附件是哪一类(手机按它挑怎么显示)。 */
export type SessionAttachmentKind =
  | 'image' | 'video' | 'audio' | 'markdown' | 'text' | 'code' | 'table' | 'html'
  | 'pdf' | 'document' | 'slides' | 'sheet' | 'archive' | 'other'

/** 对话里的一个附件:她贴的图、它看的截图、对话里提到的本机文件。`ref` 只在这条会话里有效。 */
export interface SessionAttachmentRef {
  ref: string
  name: string
  kind: SessionAttachmentKind
  bytes?: number
  /** 谁带出来的:她贴的 / 它那边的(截图、它写出的文件、它提到的文件)。 */
  from: 'you' | 'ai'
  /** 电脑上这个文件已经不在了。 */
  missing?: true
}

/** 完整对话里的一条。工具调用连着的几步折成一条 `steps`(一行人话,展开看每步的说明与文件名;不给原始输出)。 */
export type SessionTranscriptEntry =
  | { k: 'ask', text: string, at?: string, attachments?: SessionAttachmentRef[] }
  | { k: 'reply', text: string, at?: string, final?: true, clipped?: true, attachments?: SessionAttachmentRef[] }
  | { k: 'steps', line: string, at?: string, steps: { line: string, detail?: string, files?: string[] }[], attachments?: SessionAttachmentRef[] }
  | { k: 'note', text: string, at?: string, tone: 'fail' | 'stop' | 'wait' }

/** 每页几轮(一轮 = 她说一句 + 它这一轮干的)。 */
export const SESSION_TRANSCRIPT_ROUNDS = 4

/**
 * `GET /sessions/transcript?agent=&id=&before=`:完整对话,从最新往前按轮分页。文字不截断(单条超大的才截,带 `clipped`)。
 * `before` 是往上翻的游标,原样带回;缺席 = 已经翻到开头。
 */
export interface SessionTranscriptView {
  agent: string
  session_id: string
  title?: string
  entries: SessionTranscriptEntry[]
  before?: string
  read_at: string
}

/** 附件一块最多多少字节(base64 之后要装进中转 1MB 一条的回包)。 */
export const SESSION_ATTACHMENT_PART_BYTES = 512 * 1024
/** 文字类附件一块最多多少字。 */
export const SESSION_ATTACHMENT_TEXT_PART = 200_000

/**
 * `GET /sessions/attachment?agent=&id=&ref=&view=info`:这个附件能怎么看。转换(缩略图、HEIC、正文、逐页)都在电脑上做,
 * 手机只收图片 / 文字 / 表格 / 能直接播的音视频。
 */
export interface SessionAttachmentInfo {
  ref: string
  name: string
  kind: SessionAttachmentKind
  mime: string
  bytes: number
  modified_at?: string
  /** 有没有缩略图(`view=thumb`)。 */
  thumb: boolean
  /** 能整份取(`view=full&part=`):图片 / 音视频 / 原样的文件。 */
  full?: { mime: string, bytes: number, parts: number }
  /** 能读成文字(`view=text&part=`)。`table` 回的是行;`html` 是电脑上转好的一页(手机放进不跑脚本的框里)。 */
  text?: { format: 'plain' | 'markdown' | 'code' | 'table' | 'html', parts: number, lang?: string }
  /** 能逐页看(`view=page&page=`,PDF)。 */
  pages?: number
  /** 这一类只能到电脑上看全的,说一句为什么。 */
  note?: string
}

/** `view=thumb|full|text|page` 的一块。 */
export interface SessionAttachmentChunk {
  ref: string
  view: 'thumb' | 'full' | 'text' | 'page'
  part: number
  parts: number
  mime?: string
  /** base64(图片 / 音视频 / 缩略图 / 一页)。 */
  data?: string
  text?: string
  rows?: string[][]
}

/**
 * 一条会话在界面上叫什么:那家的标题;没有就「<那家的名字> 的一条会话」。**电脑与手机同一个说法**(「正在办」同一口径)。
 * 那家叫什么由调用方给(`agentName`)—— 这里不存「是哪几家」的名单(卡 Q 做运行时自动发现)。
 */
export function sessionDisplayTitle(session: { title?: string | undefined }, agentName: string): string {
  const title = session.title?.trim()
  return title === undefined || title === '' ? `${agentName} 的一条会话` : title
}

/**
 * 「3 分钟前」「刚刚」「2 小时前」。`now` 用 /state.now(服务端时钟),不用浏览器 / 手机的时钟 —— 两边对不上时宁可跟服务端走。
 * 算不出(时刻坏了、在未来太远)→ undefined,界面就不写这一截。
 */
export function agoLabel(at: string, now: string): string | undefined {
  const then = Date.parse(at)
  const current = Date.parse(now)
  if (!Number.isFinite(then) || !Number.isFinite(current)) return undefined
  const seconds = Math.round((current - then) / 1000)
  if (seconds < -120) return undefined
  if (seconds < 60) return '刚刚'
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes} 分钟前`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours} 小时前`
  return `${Math.floor(hours / 24)} 天前`
}

/** 一到十的中文数(念给他听的时长用;超过十就照旧写阿拉伯数字)。 */
const CN_NUMBERS = ['零', '一', '两', '三', '四', '五', '六', '七', '八', '九', '十'] as const

/**
 * **念给他听的那个时长**(2026-09-27,卡 LK)。{@link agoLabel} 是给眼睛看的,这一个是给耳朵听的。
 *
 * 现场(维护者 21:2x 电话里):事务官念的是「226 分钟没动静」「228 分钟没动静」——
 * 他当场说「那是 4 个小时啊」。**没人用分钟数四个小时**。所以:
 * 一小时以内照旧说分钟(「12 分钟前」);过了一小时说整点数,零头不到 10 分钟就说整
 * (「三个小时前」)、快满一小时说「快四个小时前」、中间说「三个多小时前」。
 * 半小时上下那一段单独有一句(「半小时前」),电话里听着比「29 分钟前」自然。
 */
export function agoSpokenLabel(at: string, now: string): string | undefined {
  const then = Date.parse(at)
  const current = Date.parse(now)
  if (!Number.isFinite(then) || !Number.isFinite(current)) return undefined
  const seconds = Math.round((current - then) / 1000)
  if (seconds < -120) return undefined
  if (seconds < 90) return '刚刚'
  const minutes = Math.floor(seconds / 60)
  if (minutes >= 28 && minutes <= 33) return '半小时前'
  if (minutes < 60) return `${minutes} 分钟前`
  const hours = Math.floor(minutes / 60)
  const rest = minutes - hours * 60
  const say = (n: number): string => (n <= 10 ? CN_NUMBERS[n] ?? String(n) : String(n))
  if (hours < 24) {
    if (rest >= 45) return `快${say(hours + 1)}个小时前`
    if (rest <= 10) return `${say(hours)}个小时前`
    return `${say(hours)}个多小时前`
  }
  const days = Math.floor(hours / 24)
  return `${say(days)}天前`
}

/** 读不到它在做什么时写的那句(电脑、手机同一句)。 */
export const SESSION_ACTIVITY_UNKNOWN = '读不到它在做什么'

/** 「在做的事 · 3 分钟前」;读不到就是 {@link SESSION_ACTIVITY_UNKNOWN}。 */
export function sessionActivityLine(activity: SessionActivity | undefined, now: string): string {
  if (activity === undefined || activity.line.trim() === '') return SESSION_ACTIVITY_UNKNOWN
  const ago = agoLabel(activity.at, now)
  return ago === undefined ? activity.line : `${activity.line} · ${ago}`
}

/* ──────────────────────── 后台任务挂在主会话卡里(2026-09-25,卡 Q)──────────────────────── */

/** 一项后台任务的状态怎么说(电脑、手机同一句)。 */
export const SESSION_CHILD_STATUS_TEXT: Readonly<Record<SessionChildStatus, string>> = {
  running: '在跑', waiting: '等你', done: '办完了', error: '出错了',
}

/** 主卡上那几个数:一共几项、在跑几项、等你几项。 */
export function sessionChildCounts(children: readonly Pick<SessionChildView, 'status'>[] | undefined): { total: number, running: number, waiting: number } {
  const list = children ?? []
  return {
    total: list.length,
    running: list.filter(one => one.status === 'running').length,
    waiting: list.filter(one => one.status === 'waiting').length,
  }
}

/**
 * 主卡上那一行:「内含 3 项后台任务 · 在跑 2 · 等你 1」;都办完了是「内含 3 项后台任务 · 都办完了」。没有后台任务 → undefined(不写这一行)。
 * 电脑的会话卡、事务官舞台、手机同一句(维护者:「一张卡片里有后台任务的说明,就是多一层的意思」)。
 */
export function sessionChildrenLine(children: readonly Pick<SessionChildView, 'status'>[] | undefined): string | undefined {
  const counts = sessionChildCounts(children)
  if (counts.total === 0) return undefined
  const parts = [`内含 ${counts.total} 项后台任务`]
  if (counts.running > 0) parts.push(`在跑 ${counts.running}`)
  if (counts.waiting > 0) parts.push(`等你 ${counts.waiting}`)
  if (counts.running === 0 && counts.waiting === 0) parts.push('都办完了')
  return parts.join(' · ')
}

/** 展开之后一项一行的第二行:「在跑 · 在跑测试 · 3 分钟前」;读不到在做什么就只说状态与时间。 */
export function sessionChildLine(child: Pick<SessionChildView, 'status' | 'activity' | 'started_at' | 'ended_at'>, now: string): string {
  const parts: string[] = [SESSION_CHILD_STATUS_TEXT[child.status]]
  if (child.activity !== undefined && child.activity.line.trim() !== '') parts.push(child.activity.line)
  const at = child.activity?.at ?? child.ended_at ?? child.started_at
  const ago = at === undefined ? undefined : agoLabel(at, now)
  if (ago !== undefined) parts.push(ago)
  return parts.join(' · ')
}

/** 主会话算不算「在办」:它自己在跑,或者底下有后台任务在跑 / 在等你(只算这一条主会话一次)。 */
export function sessionBusy(session: { status: SessionStatus, children?: readonly Pick<SessionChildView, 'status'>[] | undefined }): boolean {
  if (session.status === 'running') return true
  if (session.status === 'offline') return false
  return (session.children ?? []).some(child => child.status === 'running' || child.status === 'waiting')
}

/* ──────────────────────── 在等你:不只看会话状态(2026-09-25,卡 T)──────────────────────── */

/**
 * 在等他哪一类(维护者 09-25:「事务官不能纯按照 Agent 的会话状态来判断是否由我确认,
 * 也有可能跟你这次一样,你并没有用弹窗的形式列出问题和选项」)。
 * - `choose`:让他选 / 答一个问题(列了选项、问「你选哪个」);
 * - `approve`:问他能不能做、要不要继续(权限弹窗、「要不要我…?」、「你点头我就合」);
 * - `do`:要他亲手去做一件事(在终端里跑命令、去点、登录、给材料);
 * - `review`:交了东西等他看 / 审 / 验收。
 */
export type SessionAskKind = 'choose' | 'approve' | 'do' | 'review'

export const SESSION_ASK_KINDS: readonly SessionAskKind[] = ['choose', 'approve', 'do', 'review']

/** 四类的中文名(电脑、手机同一份)。 */
export const SESSION_ASK_KIND_TITLES: Record<SessionAskKind, string> = {
  choose: '要你选',
  approve: '要你批',
  do: '要你去做',
  review: '要你审',
}

export interface SessionAskOption {
  /** 选项原话(去掉 `**` 这类记号,截 40 字)。答的时候送回去的就是它。 */
  label: string
  /** 选项后面那半句说明(截 60 字)。 */
  note?: string
}

/**
 * **那一问的原文**(2026-10-04,卡 `claude/ask-with-context`)。维护者原话:「麻烦的是每次要确认内容的信息很短,
 * 我都不知道发生了什么,还得自己去最近的会话找上下文,这个不好」。
 *
 * {@link SessionAskView.question} 是**洗过、截到 60 字**的一句人话 —— 来电里念的、卡面上那一行、
 * 球下那一区的抬头都是它,一个字没改;这一格是**那家弹窗里的原字**,只在她点开那一条时摆。
 * 原文从 `sessionDigest` 收字那一处原样来(问句收口 2000 字、选项 label 200 / note 400),
 * **这里不再洗、不再截**:她点开就是要看清到底问的是什么。
 *
 * 只有真读到了原文才有:提问弹窗、等批计划那两种(`by: 'form'`)。按内容判出来的那几条(`by: 'rules' | 'model'`)
 * **缺席 —— 不拿洗过的那句冒充原文**(「取不到就缺席,不编」);那几条的依据照旧收在 {@link SessionAskView.quote} 里。
 */
export interface SessionAskFullView {
  /** 弹窗里那一问的原字(等批计划那一条是计划原文)。 */
  question: string
  /** 那一问上面那行小标题(弹窗给了才有)。 */
  header?: string
  /** 选项原字(`label` 答的时候送回去的不是它 —— 送回去的照旧是 {@link SessionAskOption.label})。 */
  options?: readonly SessionAskOption[]
}

/**
 * 权限弹窗上给她按的一颗(2026-10-01,卡 AP)。`label` = 壳读到的原字(按的时候原样交回去);
 * `does` = 它的意思(`once` 批准这一次 / `deny` 不批),界面在键名底下配一句中文。
 */
export interface SessionApprovalKey {
  label: string
  does: 'once' | 'deny'
}

/**
 * 某家会话停下来在等他(卡 T)。判法全仓只有一份:`server/waitingForYou.ts`。
 *
 * 两种来源,满足一种就算:① **形式上的**:那家自己的权限弹窗、提问弹窗、等批计划(`by: 'form'`);
 * ② **内容上的**:最后一轮是在问他、让他选、让他批、让他去点或去跑一个命令(`by: 'rules'`;规则拿不准时问一次便宜的模型,`by: 'model'`)。
 */
export interface SessionAskView {
  kind: SessionAskKind
  /** 一句人话:在等他什么(不露路径、代码、英文键名;截 60 字)。 */
  question: string
  /** 那家明写的选项(有才有)。 */
  options?: readonly SessionAskOption[]
  /**
   * **那一问的原文**(2026-10-04,卡 `claude/ask-with-context`;见 {@link SessionAskFullView})。
   * 她点开那一条时摆的是这一格 —— `question` 那一句照旧是短的那一句。
   * 缺席 = 读不到原文(按内容判出来的那几条),界面照旧摆 `question`;老手机 / 老页面没有这一格,也照旧。
   */
  full?: SessionAskFullView
  /** 从什么时候开始等(ISO):那家说那句话的时刻 / 弹窗出现的时刻。 */
  since: string
  /** 依据:从那家说的话里摘的那一句(只去掉 `**` 这类记号,截 80 字)。 */
  quote?: string
  by: 'form' | 'rules' | 'model'
  /**
   * 在外层 / 手机上答了能不能送回那家会话(卡 T 第 5 条,各家结论见交接):
   * `window` = 窗口那只手找到那段对话打进去;`cli` = 命令行续上那一轮;`desk` = 这一问要到电脑上那家里回。
   */
  reply?: 'window' | 'cli' | 'desk'
  /** 送不回去(`reply: 'desk'`)时去哪儿答,一句人话:「这一问得在电脑上的 Claude 里回答」。 */
  where?: string
  /**
   * **这几个选项工作台能替他点**(2026-09-28,卡 WQ)。维护者原话:「它现在几个选项给出来了,
   * 给完之后我还不能选,我还得回那个会话窗口回……那这个功能的意义就变成了:我告诉你有事,但是我帮你传不了话。」
   *
   * 弹框那一问(`by:'form'`)打字送不进去(`reply:'desk'`),但**框上那几颗键点得下去**:
   * 壳的 `agent_press` 把那家叫到台前、在它窗口里按标签找到那一项、按下去,再重读一次确认那一问没了。
   * 这一格 = 「此刻这条路通」(壳连上了、这份壳会 `agent_press`、认得出是哪一家、它明写了选项)。
   * 缺席 = 照旧只能到那家里自己点(界面照 `where` 说,不摆能点的选项)。
   */
  press?: true
  /**
   * **她自己打的那一句工作台也送得进去**(2026-09-28,卡 AT)。维护者原话:「做半天还是不能送进去?……
   * 你就复制黏贴我贴在框里的文字输入进去不就好了吗。」
   *
   * 壳的 `agent_write_ask`:认出**含问句 / 选项的那个面板容器** → 面板里那个自由作答框
   * (Codex:「Or write your own response」)→ 把她那句**原文一字不改**写进去 → 按**面板自己**那颗发送键
   * → 再核实「那个面板没了 + 窗口里出现了她那句」。这一格 = 「此刻这条路通」(壳连上了、
   * 这份壳会 `agent_write_ask`、认得出是哪一家)。缺席 = 照旧只能到那家里自己说
   * (界面照 `where` 说,不摆「我自己说」那个框)。
   */
  write?: true
  /** 电脑上那颗「去回答」能把那段对话 / 那个 App 调到前面(终端里开的、VS Code 里的调不了,就不摆那颗键)。 */
  reveal?: true
  /**
   * **这一问是那家的权限弹窗**(2026-10-01,卡 AP「手机替她批准」)。维护者 10-01 午饭在外面:
   * 「找到那个会话是在待确认里,输入回复内容之后,说发不出去」—— 打字批不了权限弹窗。
   *
   * 有这一格 = 界面**不摆输入框**(电脑抽屉、手机「待确认」都是):
   * - `keys`:壳读到的弹窗上那几颗(只有「批准一次 / 拒绝」;键名是壳读到的原字),摆成按钮 →
   *   `POST /asks/answer {key, choice: <键名>}`,工作台只在这条会话的那个弹窗上按那一颗、按完重读核实;
   * - `readable`:还没读过、这一路读得了 → 界面打开这张卡时问一次 `POST /sessions/approval/read`;
   * - `why`:上次没读成的那句话(界面照它说,给一颗「再看一次」);
   * - 三样都没有(`{}`)= 这一路读不了(旧壳 / 认不出是哪一家 / 没有原话可认)→ 照 `where` 说「到电脑上点」。
   * 「本次会话都允许」那类放宽的键**不在 `keys` 里**(决策记录待拍板,先不替她放宽)。
   */
  permission?: { keys?: readonly SessionApprovalKey[], readable?: true, why?: string }
  /**
   * 在等他的其实是这条会话底下的一个子任务(后台任务)—— 哪一个(设计第六节:子任务在等他,冒到主会话卡上、进「等你」同一堆)。
   * `title` 是派它时的那句说明。缺席 = 是主会话自己在等他。
   */
  child?: { id: string, title?: string }
}

/* ──────────────────────── 截图不切窗:被叫到前面的那一家(2026-09-25,卡 P)──────────────────────── */

/** 一扇窗的层级与大小(CGWindowList 的全局坐标)。 */
export interface ActivationWindowView {
  layer: number
  x: number
  y: number
  w: number
  h: number
  /** 壳为什么把它当遮罩(「层级 2000」「铺满整块屏」「子角色 AXUnknown」)。只在 overlay 上有。 */
  why?: string
}

/**
 * 壳报来的「有一家被叫到前面」的结论(`{kind:'activation'}`;判断在 workbench-app/Sources/ActivationSense.swift):
 * - `switch`:它的普通窗口成了最前面那扇并待满 1.5 秒 —— 他要切过去;
 * - `transient`:临时叫一下(截图遮罩 / 划词浮窗 / 快捷面板,或没待够就回去了);
 * - `overlay`:**还不是结论**,遮罩刚开(截图框选中)(2026-09-25 卡 P 补)。服务端据此预约「遮罩一收就藏回去」
 *   (壳的 `arm_rehide`),遮罩一收壳当场藏,不等服务端再转一圈。
 * `was_hidden` = 被叫出来之前它是藏着的(藏着的才要藏回去:只还原这一趟放出来的)。
 */
export interface ShellActivation {
  bundle_id: string
  verdict: 'switch' | 'transient' | 'overlay'
  reason?: 'overlay' | 'quick_return' | 'no_window'
  was_hidden: boolean
  prev_bundle_id?: string
  dwell_ms: number
  overlay?: ActivationWindowView
  front?: ActivationWindowView
  /** 壳已经按预约当场藏回去了(`transient` 才有):服务端只记账,不再发 hide_app。 */
  rehidden?: boolean
  /**
   * 这一趟的时间线(2026-09-25 卡 P 补二;统筹:「先把时间线量清楚……写进 recent_activations,方便我事后核」)。
   * `started_at` = 壳收到 didUnhide / didActivate 那一刻(墙钟);`<名字>_ms` = 离那一刻多少毫秒:
   * `unhide` / `activate`(系统通知)、`first_look`、`ordinary_before_overlay`(遮罩盖上之前就看到它的普通窗口露着 = 开头那一下闪了)、
   * `overlay_on`、`armed`、`parked`(遮罩底下把它的普通窗口挪到屏外)、`overlay_off`、`rehide`、`hidden`(didHide 通知)、`unparked`(挪回原位)。
   * 另有计数 `start_poll_ms`(开头几拍多久看一次)、`parked` / `unparked`(几扇)、`revealed_px`(遮罩收起那一拍它的窗在屏上露着多少像素²:
   * 挪开了是 0~1,没挪开是整扇窗)与说明 `park_error` / `unpark_error` / `wait_note`。只有时刻与几何,没有标题、没有内容。
   */
  timeline?: ActivationTimelineView
}

export type ActivationTimelineView = Record<string, number | string>

/**
 * 服务端拿到一条结论之后做了什么。`armed` / `arm-failed`:遮罩刚开时预约「遮罩一收就藏回去」成没成
 * (没成 = 壳回说遮罩已经收了,或者壳没连上 —— 那一趟照老路:结论来了服务端藏)。
 */
export type ActivationDecision =
  | 'restore' | 'restore-failed' | 'follow' | 'follow-failed' | 'follow-off'
  | 'not-member' | 'current' | 'was-visible' | 'already' | 'ours' | 'armed' | 'arm-failed'

export interface ActivationRecord extends ShellActivation {
  ts: string
  decision: ActivationDecision
  detail?: string
}

/* ──────────────────────── Agent 登记表(2026-09-25,卡 Q「Agent 自动发现与统一接入」)──────────────────────── */

/**
 * 维护者 09-25:「要是写死了就很糟糕了……你得想个机制,后面检测到是 Agent,有会话窗口的的这种都得能有气泡和
 * 会话状态、标题、内容」。所以「有哪几家」不再是代码里的一张表,而是运行时的**登记表**(`server/agentRegistry.ts`):
 * App 启动 / 切到前台 / 工作台启动 / 低频巡检时发现,**两条都过才算**(窗口像对话窗口 + 回话的是 AI 不是人),
 * 判完记下来。每一家都有四样:状态、会话标题、最新一句、气泡;拿不到的那一样明说「没接上:原因」。
 * 设计见 docs/设计-Agent自动发现与统一接入-2026-09-25.md。
 */

/** 一家是怎么被认出来的:App 启动时 / 切到前台时 / 工作台启动扫的 / 平时巡检 / 它的会话记录里有会话 / 他说「接上」/ 事务官自己。 */
export type AgentFoundHow = 'launch' | 'activate' | 'startup' | 'patrol' | 'sessions' | 'user' | 'self'

/** 一家此刻在不在跑。`unknown` = 读不到(原因在 `gaps.status`)。 */
export type AgentRunStatus = 'running' | 'waiting' | 'idle' | 'unknown'

/**
 * 一家的一路来源:通用的读窗口,专门的会话记录(Claude / Codex / Kimi / 事务官自己的那几种读法),
 * 或它自己的本机记录(`records`,2026-10-08 起:千问办公的对话库;见 server/agentRecords.ts)。
 */
export interface AgentSourceView {
  kind: 'window' | 'sessions' | 'records'
  /** 人话:「读它的窗口」「它的会话记录」。 */
  label: string
  /** 这一路此刻读得到没有。 */
  ok: boolean
  /** 读不到的原因(人话)。 */
  note?: string
}

/**
 * 一家的一条会话。**界面上的气泡、会话列表、「执行」数都数它**,各家一条路。
 * 字段与 `SessionView` 同名同义(含卡 P 的 `activity`「最近在做什么」),只是 `agent` 是登记表里的 id
 * (有专门读法的那几家就是 `claude` / `codex` / `kimi` / `dsh`,别的是包标识),不再是那四家的闭集。
 */
export type AgentSessionView = Omit<SessionView, 'agent'> & {
  agent: string
  /**
   * 从哪一路来的:专门的会话记录(`/state.sessions` 的副本),读窗口读出来的,
   * 还是它自己的本机记录(`records`,2026-10-08)。后两种**只在登记表里**,见 {@link registryOnlySession}。
   */
  via: 'sessions' | 'window' | 'records'
}

/**
 * 这条会话是不是**只在登记表里**(不是 `/state.sessions` 的副本):读窗口的、读它自己记录的。
 * 捎话候选、「在等你」、手机最近会话、动作闸要把这几条并进来 —— 一处判,不各写 `via === 'window'`。
 */
export function registryOnlySession(one: Pick<AgentSessionView, 'via'>): boolean {
  return one.via !== 'sessions'
}

/** 「冒一下」:开始跑了、有新回复了。 */
export interface AgentBubbleView {
  kind: 'started' | 'replied'
  /** 冒出来的那一句:「Muse 开始跑了」「Muse 回了:……」。 */
  text: string
  at: string
}

/** 四样:状态、会话标题、最新一句、气泡。 */
export type AgentGapKey = 'status' | 'title' | 'latest' | 'bubble'

export interface AgentEntryView {
  /**
   * 登记表里的 id。**界面上不显示**。有专门读法的那几家是那一路的 id(`claude` / `codex` / `kimi`;事务官自己 `dsh`)——
   * 事项卡的 `links`、`POST /read`、`GET /sessions/digest` 认的都是它;别的一律是它的包标识。
   */
  id: string
  bundle_id?: string
  /** 显示名。 */
  name: string
  /** 事务官自己(不是别家 App)。 */
  self?: boolean
  /**
   * 这一家在界面上的颜色(`#rrggbb`,2026-09-25 卡 Q):从它自己 App 图标的主色来,深色底上提亮过;取不到图标是中性灰。
   * 会话卡的小头像、事务官舞台、顶栏小灯、手机都用这一格 —— 同一家处处同一个色。规则在 server/agentRegistry.ts 的 agentColor。
   * 新服务端总是给;老服务端没有这一格时界面用 {@link AGENT_NEUTRAL_COLOR}。
   */
  color?: string
  /**
   * 这一家的 **logo 取到了没**(2026-09-26,卡 LG;维护者:「增加一个功能,就是现在电脑上有多少个 Agent 客户端,
   * 把对应的 logo 也搞上;桌面端的应用标签,也加各家的 logo icon」)。
   *
   * 取到了 → 界面按 `GET /agents/icon/<id>` 当一张 PNG 画(窗口槽标签名字前那 16px、顶栏那一排小灯、
   * 「这台电脑上 N 家 Agent 客户端」那一条上的小图标);没取到(这台电脑上没装 / 渲不出 / 壳是旧版没有
   * `app_icon` 这件本事)→ **退回色点**(卡 Q 那一颗,颜色还是从它图标的主色来的),不出错、不空白。
   *
   * 图片本身不在 `/state` 里(一张十几 KB,九家一百多 KB,每秒一拍的快照塞不下),只有这一格真假;
   * 服务端那份缓存也只在内存里,不进 `agents.json`(见 server/agentIcons.ts 的说明)。
   * 新服务端总是给;老服务端没有这一格,界面当 false(画色点,就是这块功能之前的样子)。
   */
  icon?: boolean
  /** 怎么认出来的、什么时候、判定依据(人话)。 */
  found: { how: AgentFoundHow, at: string, basis: string }
  sources: readonly AgentSourceView[]
  /** App 此刻开着没。没有 App 的(事务官自己)缺席。 */
  app_running?: boolean
  status: AgentRunStatus
  title?: string
  /** 最新一句(截断)。 */
  latest?: string
  /** 标题 / 最新一句是什么时候读到的。 */
  read_at?: string
  bubble?: AgentBubbleView
  /** 四样里拿不到的:「没接上:原因」。**任何一样既没有值、也不在这里,就是一个 bug**(用例钉着)。 */
  gaps: Partial<Record<AgentGapKey, string>>
  /** 整家一句说明,如「Muse 没开,显示的是 15:20 最后一次读到的」。 */
  note?: string
  sessions: readonly AgentSessionView[]
  /** 侧栏里的会话标题(读窗口读到的,最多 8 条)。 */
  titles?: readonly string[]
  /** 在跑 / 等你 / 没看过的回复 各几条(与 `sessions` 同一口径)。 */
  counts: { running: number, waiting: number, unread: number }
}

/**
 * 拿不准的一家:外层问一句「XX 像是个 Agent,要接上吗?」,不答之前不读它。
 * 这一问本身挂在 `state.questions` 上(卡 M 的提问经纪人,进「等你」那一堆);这一格是登记表自己的账,
 * 与 `state.questions` 里那几问一一对应(「先不管」还没到期的两边都不算)。
 */
export interface AgentAskView {
  id: string
  name: string
  question: string
  /** 为什么拿不准(人话)。 */
  basis: string
  at: string
}

/** 一句话提示:「新接上一家:XX」。 */
export interface AgentNoticeView {
  id: string
  text: string
  at: string
  /** 说的是哪一家(登记表 id):外层那一句上挂「这不是 Agent」好当场撤回。 */
  agent?: string
}

export interface AgentRegistryView {
  /** 接上了的那几家(事务官自己在最前,其余按认出来的先后)。 */
  entries: readonly AgentEntryView[]
  asking: readonly AgentAskView[]
  /** 24 小时内、没收掉的提示。 */
  notices: readonly AgentNoticeView[]
  /** 发现与巡检此刻停着的原因(通话中、壳没接上……)。在跑就缺席。 */
  paused?: string
  /** 整张表的一句说明(比如壳太旧、读不了窗口)。 */
  note?: string
  /**
   * 要他动一下手才读得了别家窗口的那一种(2026-09-25,卡 Q;维护者:「得是从常规用户的第一次使用角度」)。
   * 顶栏小灯那一排后面摆这一句,`accessibility` 带「去打开」一键到系统设置那一页 —— 不许空白。缺席 = 不缺什么。
   */
  blocked?: AgentBlockedView
  /**
   * **认出是 AI 应用、可它那扇窗读不到**的那几家(2026-10-01)。开着、判成 `ai_agent`、
   * 窗口结构那一道没过(不含「藏在窗口槽里」那种暂时读不到)。**不进 `entries`**
   * (没接上就不冒充接上了),但也不许默默不列 —— 界面上灰着摆一行,说清读不到。
   */
  unreadable?: readonly AgentUnreadableView[]
}

/** 认出是 AI 应用、窗口却读不到的那一家(2026-10-01)。 */
export interface AgentUnreadableView {
  /** 登记表 id(多半就是包标识)。 */
  id: string
  name: string
  bundle_id: string
  /** 一句人话:认出来了,但读不到它的窗口。 */
  why: string
  /** 结构那一道没过的原话(「不像对话窗口:没有输入框;…」)。 */
  detail: string
  at: string
}

/**
 * 读不了别家窗口、要他动一下手的原因(一句人话)。
 * - `accessibility`:工作台还没开「辅助功能」权限(第一次装多半是这样)。`apps` = 已经认出来像 Agent、开了权限就能看到的那几家。
 * - `old_shell`:这台电脑上的工作台 App 是旧版,不会读窗口。
 */
export interface AgentBlockedView {
  kind: 'accessibility' | 'old_shell'
  text: string
  apps?: readonly string[]
}

/**
 * 接上一家之后**读什么、不读什么**(2026-09-25,卡 Q;统筹:第一次接上一家时用一句人话说清)。
 * 「新接上一家」那一句、「要接上吗」那一问、顶栏小灯点开那一张都用这一句 —— 一处改、处处跟着。
 */
export const AGENT_READ_SCOPE = '只看它在不在跑、会话标题和最新一句,别的聊天内容不存、不往外发;只看,不动它。'
/** 人跟人聊天的那几家永远不读(壳与服务端各有一道门)。 */
export const AGENT_NEVER_READ = '微信、企业微信这类跟人聊天的从来不读。'

/**
 * ★ **藏在窗口槽里 ≠ 没有窗口**(2026-10-01,卡「窗口槽里的家与读不到的家」)。
 *
 * 她把一家拉进窗口槽之后,不在台前那一格的 App 由工作台自己 `hide_app` 藏起来;藏着的 App
 * 辅助功能一扇窗都列不出,壳回的是 `windows: 0, hidden: true`。以前这一下被说成「它没有窗口」
 * (于是登记表写「豆包办公 开着,但一扇窗都没有」、事务官据此说派不了活)—— **那是假话**:
 * 窗好好地开着,是工作台自己把它藏了。藏它的手是我们的,就不该让她去「把窗口叫出来」。
 *
 * 2026-10-09(根治方案第三节第 1 条第 3 级):Chromium 系的窗藏起来后辅助功能树停在藏起那一刻,读到的是旧画面 ——
 * 所以这一句也说清「看不见它此刻在干什么」,不凭旧画面说它在跑或做完。
 */
export function agentHiddenInSlotWhy(name: string): string {
  return `${name} 藏在窗口槽里,看不见它此刻在干什么;切到它那一格时我再看一眼`
}
/** **没开**就说没开(2026-10-01):来源说「没在跑」时不许说成「开着,但一扇窗都没有」。 */
export function agentNotOpenWhy(name: string): string {
  return `${name} 没开`
}
/**
 * 判成 AI 应用、可它那扇窗读不出任何可用的界面(Air 上的新版 Kimi、可灵、App Store 版豆包)。
 * **如实摆出来**,不是默默不列(D13):工作台确实送不进话,她得知道这件事。
 */
export function agentUnreadableWhy(name: string): string {
  return `认出 ${name} 是 AI 应用,但读不到它的窗口,工作台没法替你往里发话`
}
/**
 * ★ **派给读不到窗口的那一家 —— 当场说,别自己折腾**(2026-10-01,卡「派给读不到的那家当场说」)。
 *
 * 现场(Air 诊断包 17:53):她说「让 Kimi 查一下国庆放假多少天」。新版 Kimi 整个界面是自绘画布,
 * 辅助功能树只有一扇窗一张图 —— 读不到输入框、读不到发送键,工作台一个字都送不进去。
 * 以前这一下没有人当场说这句话:事务官**自己**「在跑命令」约 8 分钟、撞上 15 步上限,
 * 电话工人连发三次「到上限了」,那件事一直停在 todo。维护者 09-28 已经拍过板:事务官自己不干活。
 *
 * 所以派活 / 捎话 / 替她答撞上这一类目标时,**在工作台这一侧当场判、当场回这一句**(不经模型):
 * 名字用登记表里现成的显示名,能派的那几家从候选里现列 —— 两样都不写死。
 */
export function dispatchUnreadableSay(input: { name: string, others: readonly string[] }): string {
  return input.others.length === 0
    ? `${input.name} 这台读不到它的窗口,派不了 —— 这台电脑上还没有别家能接活的 AI`
    : `${input.name} 这台读不到它的窗口,派不了 —— 换 ${input.others.join('、')} 吗?`
}

/** 取不到图标(App 没装、只有会话文件、壳是旧版)时一家的颜色:中性灰,**不猜**(卡 Q)。 */
export const AGENT_NEUTRAL_COLOR = '#8f8f96'
/** 黑白的图标(ChatGPT / Codex 那种)在深色底上的样子:浅的中性色,与「取不到」的灰分得开。 */
export const AGENT_MONO_COLOR = '#dcdce0'

/** 判过的一个 App(`GET /agents` 才给,诊断用,不上界面)。 */
export interface AgentJudgedAppView {
  bundle_id: string
  name: string
  state: 'connected' | 'asking' | 'not_agent' | 'candidate'
  verdict?: { kind: 'ai_agent' | 'human_chat' | 'other' | 'unsure', reason: string, by: 'model' | 'user' | 'floor' | 'sessions', at: string }
  /**
   * 窗口结构那一道的结论。`mode`(2026-10-02)= 过了的那一家**写得进去到什么程度**:
   * 缺席 / `full` 是老样子(认得出输入框);`paste_only` 是自绘界面(Compose / Flutter / 自画 canvas
   * 那一类)—— 对话文字读得到,输入框与发送键画成了 `AXUnknown` 认不出,送话靠点一下 + 粘贴 + 回车,
   * 发完按证据核(在对话区里找她那一句)。判在 `server/agentJudge.ts` 的 `judgeStructure`。
   */
  structure?: { pass: boolean, why: string, at: string, mode?: 'full' | 'paste_only' }
  /** 还没判完的原因(预算用完、模型没接上……)。 */
  pending?: string
  /** 问过他「要接上吗」,他答「先不管」:到这一刻再问。 */
  ask_again_at?: string
  /**
   * 判成 AI 应用、结构那一道却没过的那几家:**这扇窗的辅助功能结构长什么样**(2026-10-01,诊断用)。
   * **只有数**(各角色各几个、窗口多大、藏没藏、敲没敲过门),**一个字的内容都没有** —— 诊断包里
   * 带的就是它,好让下一次不用再上真机猜「它那扇窗到底是什么样」。
   */
  ax?: AgentAxSummary
  /**
   * ★ **输入框认不出的那几家:这扇窗的辅助功能树明细**(2026-10-02,卡「适配自绘界面的 Kimi」)。
   *
   * 10-01 只带 {@link AgentAxSummary} 那几个数,于是隔着一台机器看得出「它是自绘界面」、
   * 写不出「输入框是哪一个节点、怎么往里写」。这一格补上:每个元素的角色、子角色、在树上第几层、
   * 位置大小、按得下去哪些动作、哪几条属性写得进去,以及标题 / 说明 / 帮助 / 值各**几个字**。
   *
   * **一个字的内容都没有**(壳只回这些,服务端 `parseAxDetail` 再把一切不是系统常量形状的字段扔掉)。
   * 只对**输入框没认出来**的那几家收(结构没过的,以及过了但走自绘那一档的),认得出的那几家缺席。
   */
  ax_detail?: AgentAxDetailView
}

/** 一个元素的明细(2026-10-02)。全是结构与数:角色 / 动作 / 属性名是系统常量,文字只有字数。 */
export interface AgentAxElementView {
  role: string
  sub?: string
  /** 在树上第几层(窗口自己是 0)。 */
  d: number
  x: number
  y: number
  w: number
  h: number
  /** 按得下去哪些动作(`AXPress` / `AXConfirm` …)。 */
  act?: readonly string[]
  /** 哪几条属性写得进去(`AXValue` / `AXFocused` …)。 */
  set?: readonly string[]
  /** 此刻是不是焦点。 */
  foc?: boolean
  /** 标题 / 说明 / 帮助 / 值各有**几个字**。缺席 = 压根没有这一格;`0` = 有这一格、里面是空的。 */
  tl?: number
  dl?: number
  hl?: number
  vl?: number
}

/** 那扇窗的辅助功能树明细(2026-10-02,诊断用)。见 {@link AgentJudgedAppView.ax_detail}。 */
export interface AgentAxDetailView {
  at: string
  window?: { w: number, h: number }
  elements: readonly AgentAxElementView[]
  /** 走过几个节点、是不是没回完(行数封顶 / 时间到了)。 */
  visited?: number
  capped?: boolean
}

/**
 * 一扇窗的辅助功能**结构摘要**(2026-10-01)。只数不读:没有标题、没有提示字、没有任何对话内容。
 * 来源是壳 `agent_probe` 已经回的那一份(`roles` 要新壳才有,老壳缺席)。
 */
export interface AgentAxSummary {
  at: string
  /** 系统说它开着几扇窗(藏着时是 0)。 */
  windows: number
  /** 这一刻它是藏着的(多半是工作台自己的窗口槽藏的)。 */
  hidden?: boolean
  /** 辅助功能直接回错(通道关着 / 树没建好)。 */
  ax_err?: number
  /** 主窗多大。 */
  window?: { w: number, h: number }
  /** 各角色各数到几个(`AXTextArea` / `AXButton` / `AXWebArea` …;新壳才有)。 */
  roles?: Readonly<Record<string, number>>
  /** 认出来的输入框 / 发送键 / 停止键 / 列表各几个。 */
  inputs: number
  send: number
  stop: number
  lists: number
  left_links: number
  /** 字块:一共几块、侧栏里几块、输入框上面几块(**只数位置,不读字**)。 */
  texts: { total: number, left: number, above_input: number }
  /** 输入框旁边那排按钮几颗、菜单栏顶上几项(只数)。 */
  toolbar: number
  menus: number
  /** 走过几个节点、是不是没走完。 */
  visited?: number
  capped?: boolean
  /**
   * 读之前敲过 `AXManualAccessibility` 那一下没有(Chromium / Electron 要靠它才吐网页那一层的树)。
   * 壳 `agent_probe` 这条路一直敲(`AXWake.app`),所以新壳回真;老壳不报这一格 → 缺席。
   */
  ax_manual?: boolean
}

/** `GET /agents` 的回包:登记表 + 判过的 App + 今天判了几次、花了多少。 */
export interface AgentRegistryDetailView extends AgentRegistryView {
  apps: readonly AgentJudgedAppView[]
  budget: { day: string, calls: number, cny: number, cap_calls: number, cap_cny: number }
  in_call: boolean
}

/** 一格手机才显示的东西,从哪一版手机包起才有(`/state.phone_cells`;手机那边 `butler-app/src/api/protocol.ts` 同形)。 */
/** 「今天的待办」里的一件(看板事项的一个子集,字段名照事项原样)。 */
export interface TodayTodoItem {
  id: string
  title: string
  /** 事项的 `due`(`YYYY-MM-DD`)。 */
  due: string
  /** 今天办完的(状态 `done`,`done_at` 落在今天)。 */
  done: boolean
  /** `due` 早于今天、还没办完。 */
  overdue: boolean
}

/**
 * 「今天的待办」那一格的两种显示(2026-10-12,周三演示;决策记录同日「演示:切换待办版本」)。
 *
 * ★ **2026-10-13 两版改名也改样**(维护者原话:「待办小组件的切换,感觉变化不大,
 * 改成按列表展示或按卡片展示」):`by_date` = **卡片**(每条一张小卡,今天 / 明天 / 更晚分三组,
 * 卡上带到期、负责人、状态点);`flat` = **列表**(今天那一条平铺清单,缺省)。原来「按日期汇总」
 * 那一版并进卡片版,不再单独存在。
 *
 * **两个值一个字没改**(`by_date` / `flat`):手机那一格、房间白名单、`/state.today_todos` 的形状
 * 都照旧,换的只是这一格长什么样与嘴里怎么说(改值要连手机包一起发)。
 * 用哪一版存在布局里(`WorkbenchLayout.today_view`),电脑那一格与手机读同一份 `/state.today_todos.style`。
 */
export const TODAY_VIEWS = ['by_date', 'flat'] as const
export type TodayViewStyle = typeof TODAY_VIEWS[number]
export const TODAY_VIEW_TITLES: Readonly<Record<TodayViewStyle, string>> = { by_date: '卡片', flat: '列表' }
/** 换版本时那一格盖着遮罩多久(毫秒),到点切到新版本、遮罩淡出。手机 `butler-app/src/api/protocol.ts` 同一个数。 */
export const TODAY_SWITCH_MS = 2400
/** 遮罩上那一行字。 */
export const TODAY_SWITCH_TEXT = '正在优化…'

/** 卡片版的一组(今天 / 明天 / 更晚)。 */
export interface TodayTodoGroup {
  key: 'today' | 'tomorrow' | 'later'
  label: string
  items: readonly TodayTodoItem[]
}

/** `/state.today_todos`。`date` / `tomorrow` 按电脑本机时区算(「延到明天」写的就是 `tomorrow`)。 */
export interface TodayTodosView {
  date: string
  tomorrow: string
  /** 今天那一刀(列表版就摆它)。 */
  items: readonly TodayTodoItem[]
  /** 这一格此刻用哪一版。老工作台缺席 = 列表。 */
  style?: TodayViewStyle
  /** 卡片版的三组(今天含逾期 / 明天 / 更晚)。不管此刻用哪一版都切好,换版本时两版都摆得出来。 */
  groups?: readonly TodayTodoGroup[]
}

export interface PhoneCellView {
  /** 稳定的标识(不显示)。 */
  cell: string
  /** 她看得懂的名字(「答案来找她」)。 */
  title: string
  /** 从这一版手机包起有(三段数字;手机包版本就是插件版本)。 */
  since: string
}

/* ──────────────────────── 协作区(2026-10-21,阶段一 · 一个人的板)──────────────────────── */
/*
 * 看板与工作室频道合成一张无限画布(`docs/设计-协作区-无限画布-2026-10-21.md`)。
 * 便签 = 今天的任务卡(`TaskView`)加几格可选字段;**字段只增不改**,老客户端读不到即当无。
 * 状态机一个字不动:章只是七态的另一套叫法({@link STAMP_TITLES})。
 */

/** 章的七个字,对今天七态一对一(设计稿 3.1)。界面上那排章、筛选、「现在等你」同用这一份。 */
export const STAMP_TITLES: Readonly<Record<TaskStatus, string>> = {
  backlog: '待领',
  todo: '领了',
  doing: '在做',
  confirm: '等你',
  done: '做完',
  blocked: '卡住',
  canceled: '不做',
}

/** 「未归目标」那一块的 id。老卡没有 `goal_id` 就算在这里;写不出目标的新便签也贴这里(便签上标「目标待定」)。 */
export const UNSORTED_GOAL_ID = 'goal:unsorted'

export function goalIdOf(task: Pick<TaskView, 'goal_id'>): string {
  const g = task.goal_id
  return g === undefined || g === null || (typeof g === 'string' && g.trim() === '') ? UNSORTED_GOAL_ID : (typeof g === 'string' ? g.trim() : UNSORTED_GOAL_ID)
}

/** 便签从哪来。今天的 `TaskOrigin` 并进来:`call → said`、`onboarding → user`,其余同名。 */
export type NoteFromKind = 'meeting' | 'session' | 'said' | 'channel' | 'evidence' | 'user'
export const NOTE_FROM_KINDS: readonly NoteFromKind[] = ['meeting', 'session', 'said', 'channel', 'evidence', 'user']

export function isNoteFromKind(value: unknown): value is NoteFromKind {
  return typeof value === 'string' && (NOTE_FROM_KINDS as readonly string[]).includes(value)
}

export interface NoteFrom {
  kind: NoteFromKind
  /** 哪场会 / 哪条会话(`<家>:<id>`)/ 频道哪条 / 哪通电话(`call:<id>`,{@link CALL_RECORD_FROM_PREFIX})。 */
  ref?: string
  /** 他说的那一句原话(`said`)或纪要里那一句。 */
  quote?: string
}

/** 来源那一句怎么说(详情「前因后果」、便签角上同用)。 */
export const NOTE_FROM_TITLES: Readonly<Record<NoteFromKind, string>> = {
  meeting: '会上定的',
  session: '从会话来的',
  said: '你说的',
  channel: '频道里的',
  evidence: '证据里冒出来的',
  user: '你写下的',
}

/**
 * 一张卡从哪来。有 `from` 用它;老卡按 `origin`(认不出就用 `taskOriginOf` 按形状认)并过来;
 * 从会话转的卡(`source.kind:'session'`)带着会话那一格。**不编 ref**:老卡没记就缺席。
 */
export function noteFromOf(task: Pick<TaskView, 'from' | 'origin' | 'title' | 'desc' | 'source'>): NoteFrom {
  if (task.from !== undefined) return task.from
  if (task.source.kind === 'session') return { kind: 'session', ...(task.source.ref === undefined ? {} : { ref: task.source.ref }) }
  if (task.source.kind === 'meeting' && task.origin === undefined) {
    return { kind: 'meeting', ...(task.source.ref === undefined ? {} : { ref: task.source.ref }) }
  }
  const origin = taskOriginOf(task)
  const kind: NoteFromKind = origin === 'call' ? 'said' : origin === 'onboarding' ? 'user' : origin
  return { kind }
}

/** 验收最多几条(设计稿 3.1:1–3 条短句)。多了不是「做到什么算完」,是一份需求文档。 */
export const ACCEPTANCE_MAX = 3
/** 一条验收最多多少字。 */
export const ACCEPTANCE_ITEM_MAX = 80

/** 交回的那一句只许三种(GOSIM · Octos 的内环回执)。 */
export type NoteReceiptKind = 'done' | 'objection' | 'blocked'
export const RECEIPT_KINDS: readonly NoteReceiptKind[] = ['done', 'objection', 'blocked']
export const RECEIPT_TITLES: Readonly<Record<NoteReceiptKind, string>> = { done: '做完', objection: '有异议', blocked: '卡住' }

export function isReceiptKind(value: unknown): value is NoteReceiptKind {
  return typeof value === 'string' && (RECEIPT_KINDS as readonly string[]).includes(value)
}

export interface NoteReceipt {
  kind: NoteReceiptKind
  text: string
  /** 对应的留言/邀请 id。缺席时不将任何 ask 推断为已受理。 */
  message_id?: string
  /** 带的产物 / 证据(路径、链接、版本号)。 */
  evidence?: readonly string[]
  /** 哪家交回来的(登记表 id / 名片 id)。 */
  by?: string
  source_session_id?: string
  source_round?: string
  task_round?: number
  at: string
}

export interface TaskExecutionSource {
  task_id: string
  agent: string
  /** Actual provider, independent of the source reader/CLI identified by agent. Missing means unconfirmed. */
  provider?: string
  transport?: string
  provider_basis?: 'native_reader' | 'turn_context' | 'session_metadata'
  role?: ExecutionRole
  role_origin?: ExecutionRoleFact['origin']
  task_round?: number
  session_id: string
  state: 'running' | 'returned' | 'ended' | 'interrupted' | 'unknown'
  unknown?: 'ambiguous_link' | 'unavailable' | 'unobservable' | 'stale' | 'denied' | 'missing' | 'oversized' | 'awaiting_restart' | 'unsupported'
  /** Receipt metadata only; the explicit deliverable stays in task.receipts, never transcript text here. */
  receipt?: Pick<NoteReceipt, 'kind' | 'at'>
  rounds: readonly { round: string, event_id: string, kind: 'started' | 'updated' | 'ended' | 'interrupted', at: string }[]
}

export type ExecutionState = 'running' | 'awaiting_review' | 'rework' | 'blocked' | 'unknown' | 'completed' | 'canceled' | 'queued'
export type ExecutionRole = 'business' | 'coordination' | 'unclassified'
export interface ExecutionRoleFact {
  kind: ExecutionRole
  origin: 'explicit_task' | 'automatic_session' | 'user' | 'delegation' | 'unclassified'
}
export function isExecutionRole(value: unknown): value is ExecutionRole {
  return value === 'business' || value === 'coordination' || value === 'unclassified'
}
export function sanitizeExecutionRole(value: unknown): ExecutionRoleFact | undefined {
  if (value === null || typeof value !== 'object') return undefined
  const raw = value as Record<string, unknown>
  if (!isExecutionRole(raw.kind) || !['explicit_task', 'automatic_session', 'user', 'delegation', 'unclassified'].includes(String(raw.origin))) return undefined
  return { kind: raw.kind, origin: raw.origin as ExecutionRoleFact['origin'] }
}
/** Role comes from a record or a commission path, never a title/model/PID/task id. */
export function executionRoleOf(task: Pick<TaskView, 'execution_role' | 'source' | 'from' | 'direction'>): ExecutionRoleFact {
  if (task.execution_role !== undefined) return task.execution_role
  if (task.direction === 'mine' || task.from?.kind === 'said') return { kind: 'business', origin: 'explicit_task' }
  if (task.source.kind === 'session' || task.from?.kind === 'session') return { kind: 'unclassified', origin: 'automatic_session' }
  return { kind: 'business', origin: 'explicit_task' }
}
export interface ExecutionItem {
  task_id: string
  title: string
  task_round: number
  state: ExecutionState
  role: ExecutionRole
  role_origin: ExecutionRoleFact['origin']
  sources: readonly TaskExecutionSource[]
}
export interface ExecutionOverview {
  scope: 'linked_tasks'
  complete: boolean
  /** Local observed counts are always scoped, not full-machine totals. 在跑数从任务日志现算(与 /collab/runs 同一处),不由 execution_sources 单独决定。 */
  observed_running_tasks: number
  observed_running_sessions: number
  items: readonly ExecutionItem[]
}

/** 回执落到哪个章:做完 / 有异议 → 等你;卡住 → 卡住。**只有他点「做完」才进 done**(证据四级)。 */
export function receiptStatus(kind: NoteReceiptKind): TaskStatus {
  return kind === 'blocked' ? 'blocked' : 'confirm'
}

/**
 * 需要本人决定的四类(2026-10-26,卡「事务官页接管队列」;与 AGENTS.md「要维护者亲手做的只有四类」
 * 同一份口径):花钱 / 新对外发布 / 本人账号与设备配对 / 习惯与范围取舍。只有这四类能标成
 * {@link OwnerAsk};别的事务官核验、退回、验收,不生成人工请求,**未知不得自动放行**。
 */
export type OwnerAskKind = 'spend' | 'publish' | 'pairing' | 'scope'
export const OWNER_ASK_KINDS: readonly OwnerAskKind[] = ['spend', 'publish', 'pairing', 'scope']
export const OWNER_ASK_TITLES: Readonly<Record<OwnerAskKind, string>> = {
  spend: '花钱',
  publish: '对外发布',
  pairing: '账号与设备配对',
  scope: '习惯与范围',
}

export function isOwnerAskKind(value: unknown): value is OwnerAskKind {
  return typeof value === 'string' && (OWNER_ASK_KINDS as readonly string[]).includes(value)
}

/**
 * 一张卡上要本人拍板的那一问(结构化决定,不是文案过滤):类别 + 事务官带来的方案 + 核过的依据。
 */
export interface OwnerAsk {
  kind: OwnerAskKind
  /** 事务官带来的方案(怎么做)。 */
  proposal: string
  /** 依据:核过的事实、回执、账。 */
  basis: string
  /** 谁标的(事务官 = `butler`;本人自己在页上标的 = `me`)。 */
  by?: string
  at: string
}

/**
 * 这一件「等我确认」此刻轮不轮到本人(2026-10-26,卡「事务官页接管队列」)——**用户侧等待队列的唯一判据**:
 * 章在「等我确认」、且带着四类之一的结构化请求。没带 = 事务官还在核验,不进本人队列;
 * 类别认不出(老数据 / 坏形状)同样不算,**未知不自动放行**。服务端「等你」堆、协作区「现在等你」、
 * 冲刺条「等我确认」、来电通知各处都读这一处,不各自再写一份。
 */
export function ownerAskOf(task: Pick<TaskView, 'status' | 'owner_ask'>): OwnerAsk | undefined {
  if (task.status !== 'confirm') return undefined
  const ask = task.owner_ask
  return ask !== undefined && isOwnerAskKind(ask.kind) ? ask : undefined
}

/** 组长 / 他对这张便签的评估(小队阶段二才有写入方;阶段一只读得懂)。 */
export interface NoteEvaluation {
  by: string
  text: string
  at: string
}

/** 便签上的一条留言。`verdict` 是详情里那三颗键(通过 / 改一改 / 我自己改)按下时带的。 */
export interface NoteComment {
  id: string
  /** 谁说的:`me` / `butler` / 成员 / 名片 id。 */
  by: string
  text: string
  at: string
  verdict?: 'pass' | 'rework' | 'self'
  resolved_by?: string
  resolved_at?: string
  /** 这句是带着意图递的(2026-10-26,卡「事务官机制A」):卡上四意图可区分,一眼认得出。 */
  intent?: ItemSayIntent
}

/** 一张便签最多留多少条留言(再多就是聊天记录了,那该在频道里)。 */
export const NOTE_COMMENTS_MAX = 200

/** 一次状态经手记录(2026-10-24 契约 §2 活动流)。 */
export interface TaskTransition {
  from: TaskStatus
  to: TaskStatus
  at: string
}

/** 状态经手记录最多留多少条。 */
export const NOTE_TRANSITIONS_MAX = 50

/** 四样里缺哪几样(设计稿第五节)。顺序固定:目标、来源、验收、负责人。 */
export type NoteGap = 'goal' | 'from' | 'acceptance' | 'assignee'
export const NOTE_GAP_TITLES: Readonly<Record<NoteGap, string>> = {
  goal: '目标待定',
  from: '没写从哪来',
  acceptance: '没写做到什么算完',
  assignee: '没写谁来做',
}

/**
 * 一张已经在账上的便签四样缺哪几样(便签角上那几个小字)。
 * 来源总能按 {@link noteFromOf} 认出来(老卡退到「你写下的」),所以这里从不报 `from`;
 * `from` 只在建便签的门上查(新便签必须明说从哪来,见 `server/noteGate.ts`)。
 * 目标:没有 `goal_id` 或贴在「未归目标」都算「目标待定」。
 */
export function noteGaps(task: Pick<TaskView, 'goal_id' | 'acceptance' | 'assignee'>): NoteGap[] {
  const gaps: NoteGap[] = []
  if (goalIdOf(task) === UNSORTED_GOAL_ID) gaps.push('goal')
  if (task.acceptance === undefined || task.acceptance.length === 0) gaps.push('acceptance')
  if (task.assignee === undefined) gaps.push('assignee')
  return gaps
}

/** 负责人是工作室里的一位成员(`member:<账号>`)。阶段一只读得懂、存得下,阶段二才有别的成员。 */
export type MemberAssignee = `member:${string}`
/** 负责人是一张登记过的 Agent 名片(`agent:<id>`)。 */
export type AgentCardAssignee = `agent:${string}`

const MEMBER_ASSIGNEE = /^member:[^\s:]{1,64}$/
const AGENT_CARD_ASSIGNEE = /^agent:[A-Za-z0-9:_-]{1,96}$/

export function isMemberAssignee(value: unknown): value is MemberAssignee {
  return typeof value === 'string' && MEMBER_ASSIGNEE.test(value)
}

export function isAgentCardAssignee(value: unknown): value is AgentCardAssignee {
  return typeof value === 'string' && AGENT_CARD_ASSIGNEE.test(value)
}

/**
 * 板上按谁算(设计稿第二节:「同事 / 别人」退休)。一个人用时标「别人」就是耍赖,
 * 所以老卡上的 `colleague` / `other` **读到按「你」处理**;盘上那一格不改写(老服务、手机照旧读得懂)。
 */
export function boardAssignee(assignee: TaskAssignee | undefined): TaskAssignee | undefined {
  return assignee === 'colleague' || assignee === 'other' ? 'me' : assignee
}

/* ─────────────── 目标能力条件与动态验收(2026-10-24,协作区事实契约 §1) ─────────────── */

/**
 * 一条能力条件当前算到哪一格。**全部由服务端按任务事实现算({@link conditionStateOf}),UI 只展示**,
 * 不落盘、不另造状态。重开 / 退回(任务轮次涨)后旧核验自动失效,状态随任务事实重算。
 */
export type GoalConditionState = 'pending' | 'dispatched' | 'doing' | 'unknown' | 'blocked' | 'submitted' | 'rework' | 'verified' | 'delivered'
export const GOAL_CONDITION_STATES: readonly GoalConditionState[] = ['pending', 'dispatched', 'doing', 'unknown', 'blocked', 'submitted', 'rework', 'verified', 'delivered']

export function isGoalConditionState(value: unknown): value is GoalConditionState {
  return typeof value === 'string' && (GOAL_CONDITION_STATES as readonly string[]).includes(value)
}

/** 人工核验留痕。`round` 是核验时任务轮次;与任务当前轮次不符 = 旧证据,不再使条件算 verified / delivered(历史依据不删)。 */
export interface GoalConditionVerification {
  by: string
  at: string
  /** 核验结论:通过 / 不通过(不通过留痕,条件回 rework)。 */
  pass: boolean
  note?: string
  round: number
}

/**
 * 一条能力条件:用户能做成的事(不是「交接完成」这种标题)。`verifications` 只增不改;
 * `delivered_at` 在任务轮次涨(重开 / 退回)时由服务端清掉,verifications 原样保留。
 */
export interface GoalCondition {
  id: string
  text: string
  /** 承接任务。缺席 = 尚未安排。 */
  task_id?: string
  /** 验收证据(路径 / 链接 / 编号)。 */
  evidence?: readonly string[]
  verifications: readonly GoalConditionVerification[]
  /** 交付时刻;缺席 = 已验收未交付。 */
  delivered_at?: string
  created_at: string
  updated_at: string
}

/** 一个目标的条件条数下限(少于 3 条不是「做到什么算完」,是一份 TODO)。 */
export const GOAL_CONDITIONS_MIN = 3
/** 一个目标的条件条数上限。 */
export const GOAL_CONDITIONS_MAX = 7

/**
 * 条件状态现算(纯函数,读侧口径只有这一处):
 *
 * - 没有承接任务 / 任务取消 → `pending`(取消不算达成);
 * - 任务 blocked → `blocked`(受阻是当前事实,盖过旧核验);
 * - 最后一条核验与任务**当前轮次**相符且通过 → `verified`;再记了交付时刻 → `delivered`;
 * - 有核验但轮次对不上(重开 / 退回后旧证据),或本轮验收被推翻(pass:false)→ `rework`;
 * - 任务在 doing(从未核验)→ `doing`;
 * - 任务在 confirm / done 且本轮无有效核验 → `submitted`(交回待验);
 * - 其余(待办 / 待排、从未核验)→ `pending`。
 */
export function conditionStateOf(
  condition: Pick<GoalCondition, 'verifications' | 'delivered_at'>,
  task: Pick<TaskView, 'status' | 'round' | 'assignee'> | undefined,
  execution?: 'dispatched' | 'running' | 'unknown',
): GoalConditionState {
  if (task === undefined || task.status === 'canceled') return 'pending'
  if (task.status === 'blocked') return 'blocked'
  const round = task.round ?? 1
  const last = condition.verifications.at(-1)
  if (last !== undefined && last.round === round) {
    if (last.pass === true && (task.status === 'confirm' || task.status === 'done')) return condition.delivered_at === undefined ? 'verified' : 'delivered'
    return 'rework'
  }
  if (last !== undefined) return 'rework'
  if (task.status === 'doing') {
    if (task.assignee !== undefined && isPersonAssignee(task.assignee)) return 'doing'
    return execution === 'running' ? 'doing' : execution ?? 'unknown'
  }
  if (task.status === 'confirm' || task.status === 'done') return 'submitted'
  return 'pending'
}

/** 目标汇总投影(`GET /collab/goal/board`,2026-10-24 契约 §1):list() 时现算,不落盘,刷新后口径一致。 */
export interface GoalBoardSummary {
  goal_id: string
  /** 统计范围说明(哪段时间建 / 哪些目标;父子不双计、取消单列在此声明)。 */
  scope: string
  conditions: {
    total: number
    by_state: Record<GoalConditionState, number>
    items: Array<{
      id: string
      text: string
      state: GoalConditionState
      task_id?: string
      /** 承接人;无任务 = 缺席(界面显示「尚未安排」)。 */
      assignee?: string
      /** 最近一条真实回执时刻。 */
      last_receipt_at?: string
      /** 受阻时给。 */
      blocker?: { reason?: string, waiting_on?: string, next?: string }
    }>
  }
  tasks: {
    /** 父组有子卡时父卡不重复计,只计子卡。 */
    total: number
    by_status: Record<TaskStatus, number>
    /** 取消单列,不算达成也不算进行中。 */
    canceled: number
    /** 有条件但无承接任务的条件数(= conditions.by_state.pending)。 */
    unscheduled: number
  }
}

/* ─────────────── 留言 / 邀请 / 活动流(2026-10-24,协作区事实契约 §2) ─────────────── */

/**
 * 留言意图:`record` 普通留言只记;`ask` = 明确「谁会来处理什么」,逐 mention 出一份投递状态。
 * 投递三态不混:已送达(delivered)/ 处理中(pending)/ 已受理(accepted,读取侧凭真实回执现算升级)。
 */
export type NoteMessageIntent = 'record' | 'ask'
export const NOTE_MESSAGE_INTENTS: readonly NoteMessageIntent[] = ['record', 'ask']

export interface MessageDelivery {
  /** 精确的协作执行事项;负责人留在原事项。 */
  task_id?: string
  receipt?: NoteReceipt
  /** 名片 id(`agent:…`)/ `me` / `member:<账号>`。 */
  to: string
  status: 'pending' | 'delivered' | 'accepted' | 'failed'
  /** failed 的真实原因(`unknown target: xxx` 等)。 */
  error?: string
  /** 进入该状态的时刻。 */
  at: string
}

/**
 * 一条留言(可带邀请)。`client_msg_id` 由客户端生成:断网重发带同一个 = 幂等去重,
 * 不重复留言 / 派活。**deliveries 只由服务端写**;`accepted` 不在写时定,读取侧凭回执现算。
 */
export interface NoteMessage {
  id: string
  client_msg_id?: string
  by: string
  text: string
  at: string
  intent: NoteMessageIntent
  /** ask 时必填至少一个,逐个出 delivery。 */
  mentions?: readonly string[]
  /** 回复哪条 message / comment 的 id。 */
  reply_to?: string
  deliveries?: readonly MessageDelivery[]
}

/** 一张便签最多留多少条留言(cap,与 comments 同规矩)。 */
export const NOTE_MESSAGES_MAX = 200

/** 活动流一条(`GET /collab/note/activity` 现算,按 `at` 升序;来源 / 成果 / 链接在卡上,不进流)。 */
export type ActivityItem =
  | { type: 'message', at: string, message: NoteMessage }
  | { type: 'comment', at: string, comment: NoteComment }
  | { type: 'receipt', at: string, receipt: NoteReceipt }
  | { type: 'transition', at: string, from: TaskStatus, to: TaskStatus }
  | { type: 'run', at: string, segment: RunSegment }

/* ─────────────── 时间与容量事实(2026-10-24,协作区事实契约 §4) ─────────────── */

/**
 * 一段运行事实:同一张卡相邻的 assigned→收场步为一段(再一次 assigned 开新段)。
 * 来源只读 jobLog,**现算不落盘**;末条事件未收场且超过 24h 无新事件 = `unknown`
 * (失联 / 记录过旧,不装作 running);无事件 = 这卡没有运行记录(返回空数组,不编一段)。
 */
/* ─────────────── 协作区执行轨迹(2026-10-27,《设计-协作区与事务官标签页合并》2.3、取舍 1 定 A) ─────────────── */

/**
 * 一个轨迹节点。**只由真实记录拼**:任务日志、回执、带结论的评论、状态变化、交接 / 退回关系;
 * 没发生的不出节点(计划不画成实心),没有记录的事项 `nodes` 为空,不编。
 *
 * - `dispatch` 派发(日志 assigned)· `sent` 已提交 / 已确认送达(sent / seen)· `start` 开工(started)
 * - `return` 交回(回执 done / objection,或日志 replied)· `artifact` 产物(回执带的证据、交付物)
 * - `handoff` 交接(关系 handoff,或同一事项相邻两段执行者不同)· `rework` 验收退回(评论 verdict rework / 核验不过 / 关系 rejected_back)
 * - `accept` 验收通过(评论 verdict pass,或状态到 done)· `blocked` 受阻 / 失败(回执 blocked、日志 timeout / not_sent / unreadable)
 * - `arrange` 管理安排(关系 depends_on 新增)
 */
export type TraceNodeKind = 'dispatch' | 'sent' | 'start' | 'return' | 'artifact' | 'handoff' | 'rework' | 'accept' | 'blocked' | 'arrange'
export interface TraceNode {
  at: string
  kind: TraceNodeKind
  /** 谁做的这一步(登记表 id / 名片 id / 'me' / 'butler');记录里没有就缺席,不猜。 */
  actor?: string
  /** 交给谁(派发、交回、交接、退回才有)。 */
  to?: string
  /** 记录里的原话或说明(回执正文、评论正文、阻塞原因),截短,不改写。 */
  text?: string
  /** 产物 / 证据(路径、链接、分支)。 */
  evidence?: readonly string[]
  round?: number
}
/** 一件事项此刻停在哪(轨迹最后那一截);取自最近一段运行片段与卡上状态,读不到就是 unknown。 */
export interface TraceCurrent {
  state: 'not_started' | 'dispatched' | 'running' | 'paused' | 'awaiting_review' | 'blocked' | 'done' | 'unknown'
  actor?: string
  since?: string
}
export interface TaskTrace {
  task_id: string
  nodes: readonly TraceNode[]
  current: TraceCurrent
}
/** `GET /collab/trace?goal_id=` 的回包(目标下每件事项一条,按事项在账上的顺序)。 */
export interface GoalTraceView {
  goal_id: string
  traces: readonly TaskTrace[]
}

export interface RunSegment {
  role?: ExecutionRole
  role_origin?: ExecutionRoleFact['origin']
  task_round?: number
  current?: boolean
  execution_state?: ExecutionState
  task_id: string
  /** Stable source identity keeps parallel sessions and rounds independent. */
  session_id?: string
  agent?: string
  source_round?: string
  /** 哪一家 / 哪条通道:取事件真实字段(family);缺席 = 'unknown',不编。 */
  source: string
  /** running = 未收场且近期核到started;派出未开工为dispatched,失联为unknown。paused/done/failed按原管线事件判定。 */
  status: 'dispatched' | 'running' | 'paused' | 'done' | 'failed' | 'unknown'
  /** 该次 assigned 时刻(段里没有 assigned 时取第一件事件)。 */
  started_at: string
  /** 管线收场步时刻(含超时/人工收卡),不等于执行完成;缺席 = 未收场。 */
  finished_at?: string
  /** 本段首次核到执行源开工的本机观察时刻(jobLog.started),非模型内部精确开工时刻;无证据则缺席。 */
  execution_started_observed_at?: string
  /** 本段核到结果交回的本机观察时刻(jobLog.replied),非模型内部精确完成时刻;人工收卡/超时/失联不补值。 */
  execution_finished_observed_at?: string
  /** 中途 waiting / budget_stop / jammed 的最后一条 why(没有 = 缺席)。 */
  pause_reason?: string
  /** 收场步名(replied / timeout / …);缺席 = 未收场。 */
  outcome?: string
}

/** 未收场且超过这么久无新事件 = unknown(不装作 running)。 */
export const RUN_ACTIVE_STALE_MS = 2 * 60_000
export const RUN_STALE_MS = 24 * 60 * 60_000

/**
 * 一件「谁还能接几件」的事实(2026-10-24 契约 §4):
 * 在线 / 手上几件 / 未收场几件 / 上限是**四个不同的事实,分开给**。
 * `limit` 共享执行资源上限取不到 = 'unknown',**不编**。
 */
export interface CapacityItem {
  /** 名片 id / `me`。 */
  id: string
  /** presence 实推(瞬时光标,TTL 30 分钟;名单见 collabPresence.ts)。 */
  online: boolean
  /** 名下 doing 任务数(任务账现算)。 */
  active_jobs: number
  /** 有未收场运行片段的卡数(jobLog 现算)。 */
  running_jobs: number
  limit: number | 'unknown'
}

/* ─────────────── 局域网身份与成员(2026-10-24,协作区事实契约 §5) ─────────────── */

/**
 * 本机的局域网身份:展示名(name/avatar)与稳定身份(member_id)分开 ——
 * 改名只改展示,消息 / 协作 / 任务关联全按 member_id。存 tasks.json 顶层 `lan_identity`。
 */
export interface LanIdentity {
  /** 稳定身份 UUID,落盘,改名不换。 */
  member_id: string
  /** 展示名(事务官自定义)。 */
  name: string
  avatar?: string
  /** 乐观并发;每次成功保存 +1。 */
  version: number
  updated_at: string
}

/**
 * 配对 / 见面时登记的一员(注册表在 tasks.json 顶层 `lan_members`)。
 * **没有常驻 LAN 发现服务**:reachable / last_seen 只在 UI 显式 `refresh=1` 时逐个短超时 ping,
 * 没 refresh 过或 last_seen 已超过两分钟 = reachable 缺席(未知,不说在线),保留最近见过的时刻。
 * relay 名单不冒充 LAN 成员。
 */
export interface LanMember {
  member_id: string
  name: string
  host: string
  port: number
  /** 最近一次 ping 通的时刻;缺席 = 还没 ping 通过。 */
  last_seen?: string
  /** 最近 refresh 结果;读侧过期时缺席,不据旧 true 声称当前可达。false 仅说明该次探测失败。 */
  reachable?: boolean
}

/** 对端 ping 的那一个口(`GET /collab/lan/hello`)回的就是这两样。 */
export type LanChannelCategory = 'news' | 'daily' | 'weekly'
export interface LanChannelTopic { id: string, title: string }
export interface LanChannelRef { kind: 'task' | 'url', id: string, title: string, url?: string }
export interface LanChannelSource {
  kind: 'feed' | 'project-report'
  id: string
  recorded_at: string
  scope: 'project-feed' | 'local-project-records'
  url?: string
  publisher?: string
  published_at?: string
  period?: { from: string, to: string }
}
export interface LanChannelSourcePolicy {
  project_id: string
  enabled: boolean
  recipients: readonly string[]
  categories: readonly LanChannelCategory[]
  version: number
  updated_at: string
}
export interface LanChannelSourceScope {
  news: 'unwired' | 'empty' | 'ready' | 'unknown'
  reports: 'unknown' | 'ready'
  peer_sources: 'paired-origin-claims'
  publication_enabled: boolean
  notes?: readonly string[]
}

export interface LanChannelMessage {
  id: string
  client_msg_id?: string
  project_id: string
  author: { member_id: string, name: string }
  text: string
  kind: 'message' | 'report'
  reply_to?: string
  at: string
  deliveries?: readonly MessageDelivery[]
  /** 成组正式来源字段,仅来源发布器或已配对对端提供;旧消息缺席即未知,不从正文猜测。 */
  category?: LanChannelCategory
  topic?: LanChannelTopic
  source?: LanChannelSource
  refs?: readonly LanChannelRef[]
}

export interface LanHello {
  member_id: string
  name: string
}

/* ─────────────── 任务关系 / 轮次(2026-10-24,协作区事实契约 §3) ─────────────── */

/**
 * 父子不走这里(用既有 `children` 字段),这里是其余五种。`depends_on` 服务端拒环;
 * `rejected_back` 允许回路(验收退回回到原制作是有意义的流程环)。
 */
export type TaskRelationKind = 'derived' | 'depends_on' | 'handoff' | 'rejected_back' | 'reference'
export const TASK_RELATION_KINDS: readonly TaskRelationKind[] = ['derived', 'depends_on', 'handoff', 'rejected_back', 'reference']

export function isTaskRelationKind(value: unknown): value is TaskRelationKind {
  return typeof value === 'string' && (TASK_RELATION_KINDS as readonly string[]).includes(value)
}

/**
 * 一张卡指向另一张卡的一条关系。**画了线不自动执行**。
 * `round`:`rejected_back` = 退回发生时目标卡(原制作卡)的轮次;`handoff` / `derived` 也记
 * 来源卡建关系时的轮次,读取侧现算 `stale`(上游重开,下游别拿旧交接当数)。
 * `stale` 只由读取侧现算附加,不落盘。
 */
export interface TaskRelation {
  id: string
  from_id: string
  to_id: string
  kind: TaskRelationKind
  /** 满足条件 / 交回什么 / 修改要求(handoff 与 rejected_back 必填)。 */
  note?: string
  round?: number
  created_at: string
  /** 读取侧现算:来源卡轮次涨过 → true。出参附加,不落盘。 */
  stale?: boolean
}

/** 目标的状态:还在推 / 达成了 / 不要了。**没有删除**(不可改清单第 5 条:系统不许替他扔东西)。 */
export type GoalStatus = 'open' | 'reached' | 'dropped'
export const GOAL_STATUSES: readonly GoalStatus[] = ['open', 'reached', 'dropped']

/**
 * 目标状态的人话(open / reached / dropped)。**真源在 protocol.ts**(2026-10-28,卡「机制退修
 * 任务书-接续对题与改派语义」):电脑对话框改目标状态的回话也要用这套词,服务端 import 不了
 * client/,一处定义两端各引。同一套词画布目标头、目标页标签与听懂回话共用;
 * 「在推」一词沿用决策记录 10-22「还在推的目标」的产品说法(待维护者确认,见交接)。
 */
export const GOAL_STATUS_TITLES: Readonly<Record<GoalStatus, string>> = {
  open: '在推',
  reached: '达成了',
  dropped: '不要了',
}

/** 一个目标:板上的一块区域,便签贴在里面。位置与大小只在 `.canvas` 里,不进账。 */
export interface CollabGoal {
  id: string
  title: string
  /** 为什么要它(一句)。 */
  why?: string
  /** `me` 或成员。 */
  owner: 'me' | MemberAssignee
  status: GoalStatus
  /** 截止日(YYYY-MM-DD)。**有才算风险**。 */
  due?: string
  project_id?: string
  /** 版本号(今天冲刺「组成版本号」搬过来)。便签不填就继承它。 */
  version?: string
  /** 从哪个老冲刺迁过来的(回退时认它)。 */
  migrated_from?: string
  /**
   * 能力条件(2026-10-24 契约 §1):用户能做成的事,3–7 条,服务端强制。
   * 老目标没有 = 无条件,按既有「做完几张」口径。状态不落盘,读侧按 {@link conditionStateOf} 现算。
   */
  conditions?: readonly GoalCondition[]
  created_at: string
  updated_at: string
  /** 排期风险:只在有 `due` 时、组装 /state 时现算,不落盘。 */
  risk?: ScheduleRisk
}

/** 一段时间里要推的几个目标(可选对象,只做筛选与「做完几张」)。 */
export interface CollabSprint {
  id: string
  title: string
  start?: string
  end?: string
  goal_ids: readonly string[]
  created_at: string
  updated_at: string
}

/** Agent 名片(设计稿 3.3)。阶段一只在本机登记(名片栏、`workbench agent`);共享到工作室是阶段三。 */
export interface AgentCard {
  /** `agent:<主人前缀>:<随机>`。 */
  id: AgentCardAssignee
  name: string
  owner: 'me' | MemberAssignee
  /**
   * 用哪只手派(2026-10-22 卡「名片编辑表单重排」,语义变了):`'cli'` = 命令行家且体检探到了命令行
   * (edit 格 `ok` 且 `via:'cli'`),`'window'` = 走客户端窗口;由「哪一家」按体检自动推出,界面不选。
   * **老卡**这里仍是登记表 id(codex / claude …)——读它的地方按「不是 cli/window 就当登记表 id」兼容
   * (名片栏在线判法在 `collabModel.railCards`;派给哪一家仍看 `runtime.family`,缺了退回这里)。
   */
  hand: string
  /**
   * **命令行那一家**(2026-10-22,卡「名片补四样与Kimi命令行手」):派活按它起非交互子进程。
   * `bin` 缺省由探测补(`agentDispatch.ts` 的 `cliFor`);`family` 缺席退回 {@link hand}。
   */
  runtime?: { family: string, bin?: string }
  /** **在哪干**:仓库本地路径。派活在它底下开工作树(分支 `<family>/<这件事>`)。 */
  project?: { repo: string }
  /** **用哪个模型**:名字与强度(强度是那家的思考档)。缺省由那家自己定。 */
  model?: { name?: string, effort?: 'low' | 'medium' | 'high' }
  /** **智能体文件**(相对 `project.repo`;缺省 `docs/卡/agents/kimi-coder.md`)。 */
  instructions?: string
  /**
   * **每件事的时长上限(分钟)**(2026-10-23,卡「派活给名片的四处」③):派给这家命令行的活到这一档
   * 先停下来问。缺省 {@link CARD_CLI_BUDGET_MINUTES}(命令行家 120;窗口家没有这条线,沿用现状)。
   * 只认 1..1440 的整数,形状不对整格挑掉。
   */
  budget?: { minutes?: number }
  good_at?: string
  skills?: readonly string[]
  /** 分配给它的工作室 MCP(库里条目的 id)。 */
  mcp?: readonly string[]
  /** 共享给谁:只自己 / 全工作室 / 指定成员(`members` 列成员账号)。 */
  shared: { to: 'workspace' | 'none' | 'members', members?: readonly string[], repos?: readonly string[], budget_per_day?: number }
  created_at: string
  updated_at: string
}

/** `GET /dispatch/skills`:派活技能库的两组(2026-10-22,卡「用户层技能生效」B)——本体随版本那几件 + 用户层 技能/ 里那几件(同名用户层盖本体)。 */
export interface DispatchSkillLibraryView {
  /** 本体 `third_party/skills/` 里派活能带的那几件(目录名)。 */
  builtin: readonly string[]
  /** 用户层「技能」格扫出来的(扁平形包成目录后的 id;`name`/`description` 给它看的)。 */
  mine: readonly { id: string, name: string, description?: string }[]
}

/**
 * 名片表单「模型」下拉的候选(2026-10-22,卡「名片编辑表单重排」):**只收仓库里有据可查的**,
 * 不造模型名清单(「那家能用的模型」没有现成数据源)。第一项固定「缺省,由那家自己定」(值 `''`)。
 * `claude` = Claude Code `--model` 的公开别名;`kimi` = 仓库交接里在用的真名;`codex` 没查到可靠名单 = 只有缺省。
 * 编辑老卡存的模型名不在表内时,界面把它**追加**成一个 option(值不丢)。
 */
export const CARD_MODEL_OPTIONS: Readonly<Record<'claude' | 'codex' | 'kimi', readonly string[]>> = {
  claude: ['sonnet', 'opus', 'haiku'],
  codex: [],
  kimi: ['kimi-for-coding'],
}

/** 项目挂的仓库(本地路径必有;远端与分支知道才写)。 */
export interface ProjectRepo {
  local_path: string
  remote_url?: string
  branch?: string
}

/** 项目挂的资源:文档 / 网址 / 本机路径。派活说明会带上。 */
export interface ProjectResource {
  kind: 'doc' | 'url' | 'path'
  title: string
  ref: string
}

/**
 * 「这条会话放进哪个目标?」(设计稿第五节第 3 条;10-22 第三轮 4 维护者定 B;10-28 任务书 11 维护者 15:0x):
 * 他直接在各家开的会话,没连在任何便签上的那几条。对得上(标题 / 项目,见 collabProposals 的现算)的不提,直接放进去;
 * 对不上的才提一条——带 goal_id 的默认选中那个目标,带 new_goal_title 的默认「新建目标:〈标题〉」。只有一个目标时不提,直接放进去(见 {@link SessionPlaced})。
 * 组装 /state 时现算,不落盘。
 */
export interface SessionProposal {
  agent: AgentId
  session_id: string
  title: string
  project_id?: string
  /** 对得上(标题 / 项目)的那个目标:服务端直接放进去,不问。 */
  goal_id?: string
  /** 对不上任何目标时提议的新目标标题(问的时候的默认选项)。 */
  new_goal_title?: string
  at: string
}

/** 直接放进去的那一条(10-22 第三轮 4):「『X』已放进目标『Y』,负责 Claude,在做」。 */
export interface SessionPlaced {
  agent: AgentId
  session_id: string
  title: string
  task_id: string
  goal_id?: string
  at: string
}

/** 板上的一个光标:人(真光标)或 Agent(没有鼠标,有的是「现在在哪张便签上」)。不进账、不进快照。 */
export type PresenceActor = { kind: 'member', account: string } | { kind: 'agent', id: string }

export type PresenceState = 'idle' | 'moving' | 'working' | 'stamping'

export interface CollabPresence {
  actor: PresenceActor
  cursor?: { x: number, y: number }
  on_note?: string
  state: PresenceState
  at: string
}

/* ──────────────────────── 协作区全量(2026-10-21,视觉 A;`docs/设计-协作区视觉-A-2026-10-21.md`)──────────────────────── */

/**
 * 事项类型。**颜色只表示类型**,不表示完成、紧急或负责人;认不出就缺席(中性灰),**不按 Agent 名字猜**。
 *
 * 2026-10-22(统筹转维护者:类型名不写死,做成设置):类型表由团队自己配(名字、图标、暗亮两套底色),
 * 存在 `<工作目录>/协作区/事项类型.json`,经 8791 `GET / POST /collab/types` 读写(写走「改显示状态」那道门:
 * 页面与事务官令牌都能过)。便签上的 `work_type` 存的是表里的 `id`;表里删掉的 id 照中性灰画,便签不改。
 * 缺省四类取评审页协作区原型的四组:会议 / 研发与设计 / 内容与推广 / 经营与其他。
 */
export type WorkType = string
/** 类型的 id:小写字母开头,字母、数字、连字符,至多 24 个字符。 */
export const WORK_TYPE_ID = /^[a-z][a-z0-9-]{0,23}$/
/** 类型能挑的图标(评审页那套线性图标里的这几枚;客户端 `ui/icons.tsx` 一一对应,用例比对)。 */
export const WORK_TYPE_ICONS = [
  'calendar-days', 'code-2', 'pen-tool', 'circuit-board', 'list-checks', 'scan-search', 'messages-square', 'file-pen-line',
  'megaphone', 'handshake', 'calculator', 'file-check-2', 'users-round', 'headphones', 'repeat-2', 'layers',
] as const
export type WorkTypeIcon = typeof WORK_TYPE_ICONS[number]
/** 一类事项:名字、图标、暗亮两套底色(`#rrggbb`)。 */
export interface CollabWorkTypeView {
  id: WorkType
  title: string
  icon: WorkTypeIcon
  color: { dark: string, light: string }
}
/** `GET /collab/types` 的回包。`scope` 今天只有 `local`(本机);工作室共用一张表是下一步。 */
export interface CollabWorkTypesView {
  scope: 'local'
  types: readonly CollabWorkTypeView[]
}
/** 至多几类(图例一行放得下)。 */
export const WORK_TYPES_MAX = 12
/** 缺省四类:名字取评审页协作区原型图例,底色同原型 `--meeting / --dev / --content / --routine`。 */
export const DEFAULT_WORK_TYPES: readonly CollabWorkTypeView[] = [
  { id: 'meeting', title: '会议', icon: 'calendar-days', color: { dark: '#ebd4c1', light: '#fff0e3' } },
  { id: 'dev', title: '研发与设计', icon: 'code-2', color: { dark: '#d0daf0', light: '#eaf0ff' } },
  { id: 'content', title: '内容与推广', icon: 'file-pen-line', color: { dark: '#dce4c5', light: '#eff4df' } },
  { id: 'routine', title: '经营与其他', icon: 'repeat-2', color: { dark: '#d7d8da', light: '#f0f0f1' } },
]
/** 缺省四类的 id(从事实认类型时只认这四个)。 */
export const WORK_TYPES: readonly WorkType[] = DEFAULT_WORK_TYPES.map(one => one.id)
/** 缺省四类的名字(拿不到类型表时兜底)。 */
export const WORK_TYPE_TITLES: Readonly<Record<string, string>> = Object.fromEntries(DEFAULT_WORK_TYPES.map(one => [one.id, one.title]))

/** 形状对得上的类型 id(在不在表里由读的那一方认,认不出就中性灰)。 */
export function isWorkType(value: unknown): value is WorkType {
  return typeof value === 'string' && WORK_TYPE_ID.test(value)
}

/** 校验一整张类型表;不对就说哪一条哪里不对(写入口与客户端编辑共用)。 */
export function checkWorkTypes(raw: unknown): { ok: true, types: CollabWorkTypeView[] } | { ok: false, error: string } {
  if (!Array.isArray(raw) || raw.length === 0) return { ok: false, error: '类型表至少要有一类' }
  if (raw.length > WORK_TYPES_MAX) return { ok: false, error: `类型至多 ${WORK_TYPES_MAX} 类` }
  const hex = /^#[0-9a-fA-F]{6}$/
  const seen = new Set<string>()
  const types: CollabWorkTypeView[] = []
  for (const [at, one] of raw.entries()) {
    const row = one as Partial<CollabWorkTypeView> | null
    const where = `第 ${at + 1} 类`
    if (row === null || typeof row !== 'object') return { ok: false, error: `${where}不是一条类型` }
    if (!isWorkType(row.id)) return { ok: false, error: `${where}的 id 只能是小写字母开头的字母、数字、连字符(至多 24 个)` }
    if (seen.has(row.id)) return { ok: false, error: `${where}的 id「${row.id}」重了` }
    const title = typeof row.title === 'string' ? row.title.trim() : ''
    if (title === '' || [...title].length > 12) return { ok: false, error: `${where}的名字要 1–12 个字` }
    if (!(WORK_TYPE_ICONS as readonly string[]).includes(String(row.icon))) return { ok: false, error: `${where}的图标不在可选的那几枚里` }
    if (typeof row.color?.dark !== 'string' || !hex.test(row.color.dark) || typeof row.color.light !== 'string' || !hex.test(row.color.light)) {
      return { ok: false, error: `${where}的底色要写成 #rrggbb(暗、亮各一个)` }
    }
    seen.add(row.id)
    types.push({ id: row.id, title, icon: row.icon as WorkTypeIcon, color: { dark: row.color.dark.toLowerCase(), light: row.color.light.toLowerCase() } })
  }
  return { ok: true, types }
}

/**
 * 一张便签是哪一类:明写的 `work_type` 优先;否则只从**已知的事实**认 —— 需求卡 = 研发、选题卡 = 内容、
 * 派出去的是写代码的活 = 研发、定时派活建的 = 例行。别的一律缺席。
 */
export function workTypeOf(task: Pick<TaskView, 'work_type' | 'kind' | 'dispatch' | 'from'>): WorkType | undefined {
  if (task.work_type !== undefined) return task.work_type
  if (task.kind === 'feature') return 'dev'
  if (task.kind === 'topic') return 'content'
  if (task.dispatch?.kind === 'code') return 'dev'
  if (task.from?.kind === 'user' && task.from.ref?.startsWith('timer:') === true) return 'routine'
  return undefined
}

/** 小队:几个人加几只 Agent 一组,派给小队 = 派给组长,组长再分下去、记评估(评估记在便签的 `evaluation` 上)。 */
export interface CollabSquad {
  id: string
  name: string
  /** 组长:`me` / 成员 / 名片 / 本机一家。 */
  leader: string
  /** 成员(人和 Agent 都算,不含组长)。 */
  members: readonly string[]
  created_at: string
  updated_at: string
}

/** 定时派活的触发:cron(本机例程调度跑)或 webhook(地址由中转发,阶段二才有)。 */
export type CollabTimerTrigger =
  | { kind: 'cron', cron: string }
  | { kind: 'webhook', url?: string }

/** 定时派活那张便签的模板(四样;来源固定写「定时派活」)。 */
export interface CollabTimerTemplate {
  title: string
  goal_id?: string
  acceptance: readonly string[]
}

export interface CollabTimerRun {
  at: string
  ok: boolean
  note_id?: string
  why?: string
}

export interface CollabTimer {
  id: string
  name: string
  trigger: CollabTimerTrigger
  /** 派给哪张名片 / 哪一家。 */
  assignee: string
  template: CollabTimerTemplate
  enabled: boolean
  /** 最近几次运行(新的在后)。 */
  runs: readonly CollabTimerRun[]
  created_at: string
  updated_at: string
}

/** 工作室 MCP 库的一条:只记名字、地址模板、要哪些密钥的**名字**;密钥值只在本机,不进库、不进界面。 */
export interface CollabMcpEntry {
  id: string
  name: string
  url_template: string
  secret_names: readonly string[]
  /** 本机还缺哪几把密钥(现算;空 = 本机可用)。 */
  missing?: readonly string[]
  created_at: string
  updated_at: string
}

/** GitHub 设备码登录那一格(凭据只存本机 `~/.dsh/workbench/`,不进中转)。 */
export interface CollabGitHubView {
  /** unconfigured = 这台没配 GitHub 应用的 client id(设备码登录要它)。 */
  state: 'unconfigured' | 'disconnected' | 'pending' | 'connected'
  user_code?: string
  verification_uri?: string
  expires_at?: string
  login?: string
  /** 设备码那一轮出的错(过期、被拒)。 */
  error?: string
}

export interface CollabPullRequest {
  repo: string
  number: number
  title: string
  url: string
  state: string
  author?: string
  updated_at?: string
}

/** 工作室(跨机,阶段二起由中转承载)。本机先只知道「加没加入、连没连上」。 */
export interface CollabStudioView {
  state: 'none' | 'joined' | 'offline' | 'unwired'
  name?: string
  /** 为什么连不上(如实说)。 */
  why?: string
}

/** 个人访问令牌(可以发好几枚,各写用途)。 */
export interface PersonalTokenView {
  id: string
  purpose: string
  hint: string
  created_at: string
  last_used_at?: string
}
// ───────────────────── 协作区跨机底座:工作室、收件箱、对象目录、频道(2026-10-21,中转卡) ─────────────────────
//
// 中转(`relay/server/collab*.cjs`)那一侧的回包形状;客户端在 `src/server/relayInbox.ts`。
// 契约见 docs/设计-工作室频道与层包-2026-10-20.md 一、二节与 docs/设计-协作区-无限画布-2026-10-21.md 三、六节。
// **字段只增不改**:手机与别人的座机服务会读同一份事件。

export const WORKSPACE_ROLES = ['member', 'admin'] as const
export type WorkspaceRole = typeof WORKSPACE_ROLES[number]

export interface WorkspaceView {
  id: string
  name: string
  created_by: string
  created_at: string
}

export interface WorkspaceDeviceView {
  device_id: string
  kind: string
  name?: string
  /** 中转认令牌时记的最后在线(每台每分钟最多写一次)。 */
  last_seen_at?: string
}

export interface WorkspaceMemberView {
  account_id: string
  /** 花名;频道里只显示它,不显示登录用的邮箱 / 手机号。 */
  nick: string
  role: WorkspaceRole
  joined_at: string
  devices: readonly WorkspaceDeviceView[]
}

/** `GET /v1/workspace/me`。不在任何工作室 → `{ workspace: null }`。 */
export type WorkspaceMe =
  | { workspace: null }
  | {
    workspace: WorkspaceView
    me: { account_id: string, nick: string, role: WorkspaceRole }
    members: readonly WorkspaceMemberView[]
    channels: readonly CollabChannelView[]
  }

export interface WorkspaceInvite {
  code: string
  workspace_id: string
  expires_at: string
}

/** 对象目录里的种类。`channel` 由中转建(权威写入方是中转),其余由主人的座机服务登记。 */
export const COLLAB_OBJECT_KINDS = ['card', 'project', 'agent', 'goal', 'channel'] as const
export type CollabObjectKind = typeof COLLAB_OBJECT_KINDS[number]
export type CollabVisibility = 'workspace' | 'owner'

export interface CollabObjectView {
  /** `<来源设备 id 前 8 位>:<本机 id>`;Agent 名片 `agent:<设备前缀>:<ulid>`;频道 `ws:<工作室>/ch:<ulid>`。 */
  object_id: string
  kind: CollabObjectKind
  workspace_id: string
  /** 权威写入方所在账号;频道为 null(中转自己写)。 */
  owner_account: string | null
  owner_device: string | null
  owner_epoch: number
  version: number
  visibility: CollabVisibility
  title: string
  data?: Record<string, unknown>
  updated_at: string
  /** 主人那台座机服务两分钟内露过面。列表接口才有。 */
  owner_online?: boolean
}

/** 登记 / 更新一个对象(`POST /v1/objects`)。 */
export interface CollabObjectUpsert {
  object_id: string
  kind: Exclude<CollabObjectKind, 'channel'>
  title: string
  visibility?: CollabVisibility
  version?: number
  data?: Record<string, unknown>
  /** 发出方本机 seq;带了就按 (设备, seq) 去重。 */
  origin_seq?: number
}

/** Agent 名片的 `data`(协作区设计稿 3.3)。`shared` 由中转核:不共享只有主人能派,`allowed_members` 非空只有名单上的能派。 */
export interface AgentCardData {
  hand?: string
  good_at?: string
  skills?: readonly string[]
  shared?: {
    to: 'workspace' | 'none'
    allowed_members?: readonly string[]
    repos?: readonly string[]
    budget_per_day?: number
  }
  [key: string]: unknown
}

export const INBOX_EVENT_KINDS = ['channel.message', 'channel.created', 'object.event', 'request.result', 'workspace.member'] as const
export type InboxEventKind = typeof INBOX_EVENT_KINDS[number]

export interface InboxEvent {
  /** 这个账号事件队列里的序号,单调 +1。只用于「我读到哪」,不进账、不做业务判断。 */
  cursor: number
  kind: InboxEventKind
  object_id?: string
  /** 这条把对象推到的版本;频道 = 消息 seq。 */
  object_version?: number
  origin: { device?: string, seq?: number }
  /**
   * `channel.message` → `CollabChannelMessage`;`channel.created` → `CollabChannelView`;
   * `object.event` → `{ change: 'upsert' | 'owner_changed', object } | { change: 'withdrawn', object: {object_id, kind} } | { change: 'event', event }`;
   * `request.result` → `InboxRequestResultPayload`;`workspace.member` → `{ account_id, nick, role, change }`。
   */
  payload: Record<string, unknown>
  at: string
}

export interface InboxEventsPage {
  events: readonly InboxEvent[]
  /** 下一次的 since。没有新事件时等于这次的 since。 */
  next_cursor: number
  /** 还有没给完的(一次最多 200 条)。 */
  more: boolean
  head: number
}

/**
 * 请求的种类,名字按 docs/设计-账的对象与动作-2026-10-21.md 4.3(动作名 = `<对象>.<动词>`)。
 * 「通过」= `task.accept`;「改一改 / 我自己改」= `task.return`,`args.by` 区分。
 * `timer.fire` 只由中转投(定时派活的回调地址),客户端发不了。
 */
export const INBOX_REQUEST_OPS = ['task.create', 'task.comment', 'task.say', 'task.accept', 'task.return', 'task.transfer', 'agent.dispatch', 'timer.fire'] as const
export type InboxRequestOp = typeof INBOX_REQUEST_OPS[number]
export type InboxRequestState = 'queued' | 'delivered' | 'done' | 'rejected'

export interface InboxRequest {
  cursor: number
  request_id: string
  to_account: string
  from_account: string
  /** 发起设备;中转自己投的是 `webhook:<id>` / `wecom`。 */
  from_device: string
  op: InboxRequestOp
  object_id?: string
  expected_owner_epoch?: number
  args: Record<string, unknown>
  at: string
  state: InboxRequestState
  result?: Record<string, unknown>
  done_at?: string
}

export interface InboxRequestsPage {
  requests: readonly InboxRequest[]
  next_cursor: number
  more: boolean
  head: number
}

/** 发一条请求(`POST /v1/inbox/requests`)。`request_id` 客户端生成,同号重发只办一次。 */
export interface InboxRequestSend {
  request_id: string
  to_account: string
  op: Exclude<InboxRequestOp, 'timer.fire'>
  object_id?: string
  expected_owner_epoch?: number
  args?: Record<string, unknown>
}

export interface InboxRequestSent {
  request: InboxRequest
  duplicate: boolean
}

export interface InboxRequestResultPayload {
  request_id: string
  to_account: string
  op: InboxRequestOp
  object_id?: string
  state: 'done' | 'rejected'
  result: Record<string, unknown>
}

export const CHANNEL_MESSAGE_KINDS = ['say', 'daily', 'weekly', 'status', 'system'] as const
export type CollabChannelMessageKind = typeof CHANNEL_MESSAGE_KINDS[number]

export interface CollabChannelView {
  /** `ws:<工作室>/ch:<ulid>`;放进 URL 要 encodeURIComponent。 */
  id: string
  kind: 'workspace' | 'project'
  workspace_id: string
  name: string
  project?: { object_id: string, owner_account: string | null, name: string }
  created_by: string
  created_at: string
  archived_at?: string
  /** = 最新一条消息的 seq;0 = 空频道。 */
  version: number
}

export interface CollabChannelRef {
  object_id: string
  kind: string
  object_version?: number
  owner_account?: string
  title?: string
}

/** 附件只存取件单引用(`FileOffer`),字节不过中转。 */
export interface CollabChannelAttachment {
  offer: string
  name: string
  bytes: number
  kind?: string
  owner_device?: string
}

export interface CollabChannelMessage {
  id: string
  channel: string
  /** 频道内序号 = 频道版本,全序、无洞。 */
  seq: number
  kind: CollabChannelMessageKind
  /** `butler: true` = 那个人的事务官发的(只有电脑能标);事务官没有独立身份。 */
  author: { person: string, nick: string, device: string, butler?: true }
  /** `wecom` = 企业微信群里 @机器人 说的,署在绑定人名下,花名 `企微·<userid>`。 */
  via?: string
  /** 已撤回的消息这里是空串。 */
  text: string
  refs: readonly CollabChannelRef[]
  attachments: readonly CollabChannelAttachment[]
  reply_to?: string
  link?: { kind: string, id: string, owner_account?: string }
  /** 这是一条撤回(system),撤的是哪条。 */
  retract_of?: string
  /** 这条被撤回了:原行在中转不删,各端折成「已撤回」。 */
  retracted?: { by: string, at: string }
  request_id: string
  /** 中转收到的时刻(以中转的钟为准)。 */
  at: string
  origin: { device: string, seq?: number }
}

export interface CollabChannelMessageSend {
  request_id: string
  kind?: CollabChannelMessageKind
  text: string
  reply_to?: string
  refs?: readonly CollabChannelRef[]
  attachments?: readonly CollabChannelAttachment[]
  link?: { kind: string, id: string, owner_account?: string }
  butler?: boolean
  origin_seq?: number
}

/** `GET /v1/channels/<id>/messages?before=`:按 seq 升序;`cursor` = 调用者此刻的事件游标,快照之后从它续。 */
export interface CollabChannelSnapshot {
  channel: CollabChannelView
  messages: readonly CollabChannelMessage[]
  cursor: number
}

/** 定时派活的回调地址。整串地址只在开 / 轮换那一次的回包里出现。 */
export interface CollabWebhookView {
  id: string
  label: string
  target: Record<string, unknown>
  prefix: string
  created_at: string
  rotated_at?: string
  revoked_at?: string
  last_hit_at?: string
}

export interface CollabWecomBinding {
  chatid: string
  workspace_id: string
  channel_id: string
  bound_by: string
  created_at: string
}

/** `~/.dsh/workbench/relay-inbox.json`:只记「读到哪」,不进账、不做业务判断。 */
export interface RelayInboxState {
  version: 1
  /** 事件队列读到哪(电脑与手机各记各的,这是电脑这份)。 */
  last_cursor: number
  /** 请求队列读到哪(只有电脑拉)。 */
  last_request_cursor: number
  updated_at?: string
}

// ───────────────────── 协作区跨机:/state 里露的两个数(2026-10-21,协作区全量) ─────────────────────
// 接口合并进上面的 TasksState(只增)。缺席 = 跨机没接上。
export interface TasksState {
  /** 别人想用我的 Agent、等我点批的有几条(详情 `GET /collab/relay/asks`)。 */
  relay_asks?: number
  /** 中转那边变了几回(频道消息、成员变动、借用结果、请求到了):界面拿它当该重读 `/collab/relay/*` 的信号。 */
  relay_tick?: number
  /** 事项类型表(2026-10-22,`GET / POST /collab/types` 那一张)。缺席 = 这台服务没接,读的一方用缺省四类。 */
  work_types?: readonly CollabWorkTypeView[]
}

// ───────────────────── 协作区:名片头像(2026-10-21,协作区评审第 ⑤ 条) ─────────────────────
// 存本机 `~/.dsh/workbench/avatars.json` + `avatars/<owner>.png` / `.thumb.png`;跨机只传内置 id 或小图。
// 只用在名片与头像标签上,顶部各家客户端 Logo 不换。
/** 一个人 / Agent 的头像:内置库里的一张,或上传裁好的照片(`v` = 存的时刻,拿图时当版本号防缓存)。 */
export type CollabAvatar = { kind: 'preset', id: string } | { kind: 'photo', v: number }
/** 裁好的照片边长(px)。待见稿确认。 */
export const AVATAR_PHOTO_PX = 256
/** 跨机用的小图边长(px)。待见稿确认。 */
export const AVATAR_THUMB_PX = 64
/** 裁好的照片最大字节数。待见稿确认。 */
export const AVATAR_PHOTO_MAX_BYTES = 512 * 1024
/** 小图最大字节数(进中转对象的上限)。待见稿确认。 */
export const AVATAR_THUMB_MAX_BYTES = 16 * 1024
export interface TasksState {
  /** owner(名片 id / 家族 id / `me`)→ 头像;不带图片字节,图走 `GET /collab/avatar/<owner>.png`。 */
  avatars?: Readonly<Record<string, CollabAvatar>>
}

/**
 * 会议卡上的「决定」(2026-10-21 协作区评审 ③):纪要里标「已确定」的那几条判断,原话照抄。
 * 纪要由代码按固定格式拼出(`server/meetingText.ts` 的 `renderNotesMd`),这里由服务端从那份纪要读回来;
 * 没有标「已确定」的就是空数组,不拿「当前判断」「初步想法」充数。从决定建的便签靠 `from:{kind:'meeting', ref, quote}` 认回来。
 */
export interface MeetingView {
  decisions?: readonly string[]
}
