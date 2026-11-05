/**
 * ★ **哪几家在这台电脑上 · 各有几条通道 · 这一次走哪一条**(2026-10-02,卡「引擎核心」)。
 *
 * 契约在 {@link ./adapter.ts}(**不许改**),引擎在 {@link ./engine.ts}。这一份只回答三个问题,
 * 每个问题**只在这里**回答一次:
 *
 * ## ① 有哪几家({@link AdapterRegistry.targets})
 *
 * **家族目录认识它**(`agentSources.FAMILY_SOURCES`)**+ 这台真有它**(探到它的包标识 /
 * 它某条通道此刻答应得上)。目录不认识的陌生 App 由调用方喂进来({@link RegistryDeps.extra})。
 *
 * ★ 这一条**替掉** `agentDiscovery.ts` 现在那条判法(2026-10-02 统筹查实,维护者原话:
 * 「事务官输入窗口里的四件套这种都需要扫描来做的,你看过现在的代码吗」):
 * 今天 composer 的 @ 候选 = `dispatchTargets.windowTargets(dispatchTargets())` = 登记表里
 * `state:'connected'` 的那几家,而 `agentDiscovery` 只在 `agentJudge.judgeStructure` 过了才标 connected ——
 * 那一关要**读窗口结构**、而且**三样都要**(对话区 / 输入框 / 发送键或「新对话」)。后果在 Air 上看见了:
 *
 * - Kimi(kmp 版自绘输入框,辅助功能里是 `AXUnknown`)永远过不了「有输入框」,于是**永远不在候选里**;
 * - Codex 把窗口一关就掉出候选 —— 哪怕 `codex app-server` 好好的、这条路根本不需要窗口。
 *
 * **一家存不存在与它的窗口长什么样无关。** 存在 = 目录 + 装机;能做什么 = 适配器现查。
 * 模型判「这是不是个 AI 应用」只对**目录不认识的陌生 App** 用一次(那一段留在 `agentDiscovery.ts`),
 * 认识的家**不判、不每 10 分钟重探**。
 *
 * ## ② 各家能做什么
 *
 * 只问各适配器的 {@link Adapter.capabilities},现查:协议型 = 握手得上;窗口型 = 壳连着、AX 读得到、
 * 会不会点 / 会不会停。查不出来(抛了)就当**这一条通道什么都不会**({@link NO_CAPABILITIES}),
 * 不编一个 —— 同一家别的通道照旧算。
 *
 * ★ **不是「接上 / 没接上」两档**({@link WriteMode}):自绘界面那一类(官网版 Kimi / Compose /
 * Flutter / 自画 canvas)是**读得到、写入靠粘贴** —— 两档只会把它判成「没接上」,整家派不了活。
 * 这样的家在候选名单上**照常出现**,只多一个标(`write: 'paste_only'`,念法见 {@link WRITE_MODE_TEXT})。
 *
 * ## ③ 这一次走哪一条({@link AdapterRegistry.picksFor})
 *
 * 一家可以登记好几条通道(Claude = socket + 窗口两条)。排队的判据只有
 * {@link comparePicks} 那四条,**通道从稳到脆**(协议 > 命令行 > 文件 > 窗口,设计第一节)垫底。
 * 排不上的(这一样它不会)一条都不进队 —— 引擎只在队里换路。
 *
 * ## 不做的事
 *
 * - **不新造「家→包」表**:一家装着几个包、这次动哪一个,只问 `agentSources.pickFamilyPackage`。
 * - **包解析不否决**:探不出包标识时 `bundle_id` 缺席(账上那一格就空着),
 *   「这一家此刻能不能办」由适配器说 —— 这里再判一次就又是一处散落的判断。
 */
import type { Adapter, AdapterCapabilities, Job, JobKind, JobResult, JobVia, WorkKind } from './adapter.ts'
import { bindingFor, packagesOf, pickFamilyPackage, FAMILY_SOURCES } from '../agentSources.ts'

/** 通道从稳到脆(设计 `docs/设计-一条引擎替八条管线-2026-10-02.md` 第一节)。小的在前。**同一家多条通道时的缺省**。 */
export const VIA_ORDER: readonly JobResult['via'][] = ['protocol', 'cli', 'api', 'file', 'window']

/** 这条通道排第几(目录外的写法排最后,不猜)。 */
export function channelRank(via: JobResult['via']): number {
  const at = VIA_ORDER.indexOf(via)
  return at < 0 ? VIA_ORDER.length : at
}

/**
 * ★ **派活**(`kind:'dispatch'`)挑通道的次序:协议 > 窗口 > 命令行 > 接口(2026-10-03,卡「派活三只手收进引擎」;统筹拍板)。
 *
 * 与 {@link VIA_ORDER} 的出入只有一条:聊天的派活里**命令行 / 接口是备用**(维护者 09-22 定的「聊天的活命令行只给 Codex 当备用」、
 * 「接口是豆包 / GPT 的备用」),窗口送不进去才轮到它们。`VIA_ORDER` 那条是「同一家多条通道时的缺省」,别的活种照旧。
 */
export const DISPATCH_VIA_ORDER: readonly JobResult['via'][] = ['protocol', 'window', 'cli', 'api', 'file']

export function dispatchChannelRank(via: JobResult['via']): number {
  const at = DISPATCH_VIA_ORDER.indexOf(via)
  return at < 0 ? DISPATCH_VIA_ORDER.length : at
}

/**
 * ★ **这件派活按活的种类留哪几条通道**(2026-10-03;从前在 `dispatchChoice.handsFor`,搬进来之后那边只认这一处):
 * 写代码(`code`)只走命令行 —— 沙箱里改文件,窗口 / 协议都不是改文件的路;
 * 在电脑上动手(`desk`)只走窗口 —— 命令行只改文件、接口在云上,都点不了她的界面;
 * 聊天(`chat`)/ 没说是哪一种 → 全留,按 {@link DISPATCH_VIA_ORDER} 排。
 */
export function channelAllowedFor(work: WorkKind | undefined, via: JobResult['via']): boolean {
  if (work === 'code') return via === 'cli'
  if (work === 'desk') return via === 'window'
  return true
}

/**
 * **这一种活要这一家会哪一样**(一处写:排队、换路、如实说「做不了」都照它)。
 *
 * ★ 2026-10-02(接线那张卡):`write_ask` 不再算 `send` —— 契约加了 `writeAsk` 那一格。
 * 从前并着算的后果是界面那一格(「我自己说」那个框)只能在管线里另判一份「这份壳会不会 `agent_write_ask`」,
 * 两处一漂就出 D13 那个「摆着能点、点下去说到电脑上点」。
 */
export const JOB_NEEDS: Readonly<Record<JobKind, keyof AdapterCapabilities>> = {
  answer: 'send',
  relay: 'send',
  dispatch: 'send',
  write_ask: 'writeAsk',
  press: 'press',
  stop: 'stop',
}

/** 什么都不会(`capabilities()` 抛了时按它算)。 */
export const NO_CAPABILITIES: AdapterCapabilities = {
  open: false, send: false, read: false, press: false, approve: false, writeAsk: false, stop: false, openSession: false,
}

/**
 * ★ **写进去到什么程度**(2026-10-02 统筹补;与 `origin/claude/kimi-kmp` f13f3b63 的
 * `agentJudge.StructureMode` **同一张表**,合并时只留一处)。
 *
 * 契约里 `AdapterCapabilities` 只有「会不会 `send`」一格,而自绘界面那一类
 * (官网版 Kimi `com.moonshot.kimichat.kmp.mac`、Compose / Flutter / 自画 canvas)是
 * **对话文字读得到、输入框与发送键画成了 `AXUnknown` 认不出** —— 送话靠点一下 + 粘贴 + 回车、发完按证据核。
 * 「接上 / 没接上」两档说不清它:两档只会把它判成「没接上」,于是整家派不了活(Air 诊断包
 * 20261002-193929 就是这一种)。所以候选名单上这一家**照常出现**,只多一个标。
 *
 * - `full` 老样子:认得出输入框;
 * - `paste_only` 自绘界面:读得到、写入靠粘贴。
 */
export type WriteMode = 'full' | 'paste_only'

/** 候选名单上这个标怎么念(一处写:界面、电话、回话里都用它)。 */
export const WRITE_MODE_TEXT: Readonly<Record<WriteMode, string>> = {
  full: '打字送进去',
  paste_only: '写入靠粘贴',
}

/**
 * **窗口适配器多实现这一个就报得出那一档**(可选;**契约一个字不改**)。
 * 不实现 = 缺席 = `full`(老样子,与 kimi-kmp 那一版「`roles` 缺席 → 这一档永不触发」同一条规矩)。
 */
export interface WriteModeAdapter {
  writeMode: () => Promise<WriteMode> | WriteMode
}

/** 这一条通道报的那一档。没实现 / 问坏了 = `full`(老样子,不编一个新档出来)。 */
export async function writeModeOf(adapter: Adapter): Promise<WriteMode> {
  const maybe = adapter as Partial<WriteModeAdapter>
  if (typeof maybe.writeMode !== 'function') return 'full'
  try { return await maybe.writeMode() }
  catch { return 'full' }
}

/** 这一次挑中的那一条通道 + 真要动的那个包。 */
export interface AdapterPick {
  adapter: Adapter
  /** 这一条通道此刻会哪几样(现查来的那一份)。 */
  caps: AdapterCapabilities
  /** 真要动的那个包(协议型 / 没有本机 App 的那几家缺席)。 */
  bundle_id?: string
  /** 这个包的显示名(回话里要说清动的是哪一个)。 */
  name?: string
  /** 为什么是这个包(`pickFamilyPackage` 那四种)。 */
  why?: 'said' | 'only' | 'running' | 'default'
}

/** 排队用的一条(`comparePicks` 的入参;`at` = 登记顺序)。 */
export interface PickCandidate {
  adapter: Adapter
  caps: AdapterCapabilities
  at: number
}

/**
 * **这一次谁先**(纯函数,四条,依次比):
 *
 * ① 她指名了某一段对话时,**开得到那一段**的先(`openSession`:有深链 / 有 threadId;
 *    没有的那一条只能把它叫到台前,送进去的是哪一段说不清);
 * ② 她要回话时(`expect:'reply'`),**读得到回答**的先;
 * ③ 通道从稳到脆({@link VIA_ORDER});
 * ④ 都一样就按登记顺序。
 *
 * 「这一样会不会」不在这四条里 —— 不会的那一条根本不进队(见 {@link AdapterRegistry.picksFor})。
 *
 * ★ `reading`(只读一眼那条巡检,`need:'read'`)**不按派活那张备用次序排**(2026-10-09):
 * 那张表管的是「送」(命令行 / 接口是聊天派活的备用),读回答要的是最准的那一份 ——
 * 它自己的记录(`file`)在窗口前,藏起来停住的窗只作兜底。
 */
export function comparePicks(a: PickCandidate, b: PickCandidate, job: Job, options?: { reading?: boolean }): number {
  const better = (pick: (caps: AdapterCapabilities) => boolean): number =>
    (pick(b.caps) ? 1 : 0) - (pick(a.caps) ? 1 : 0)
  if (job.target.kind === 'session') {
    const bySession = better(caps => caps.openSession)
    if (bySession !== 0) return bySession
  }
  if (job.expect === 'reply') {
    const byRead = better(caps => caps.read)
    if (byRead !== 0) return byRead
  }
  // 派活按备用规矩排(协议 > 窗口 > 命令行 > 接口);别的活种按缺省(协议 > 命令行 > 接口 > 文件 > 窗口)。
  const rank = job.kind === 'dispatch' && options?.reading !== true ? dispatchChannelRank : channelRank
  const byVia = rank(a.adapter.via) - rank(b.adapter.via)
  if (byVia !== 0) return byVia
  return a.at - b.at
}

/** 候选名单上的一家(composer 的 @ 候选 / 派活候选 / 能力体检第三段改接这一份)。 */
export interface EngineTarget {
  /** 家名(家族目录里那个 id;目录不认识的就是它自己的 id / 包标识)。 */
  family: string
  /** 显示名。 */
  name: string
  /** 这一次该动的那个包(没有本机 App 的那几家缺席)。 */
  bundle_id?: string
  /** 这一家这台装着的那几个包(装着两个以上才有这一格;界面上照旧一家一条)。 */
  packages?: readonly { bundle_id: string, name: string }[]
  /** 这一家今天有哪几条通道(按稳到脆排好)。 */
  channels: readonly JobResult['via'][]
  /** 合起来能做什么(每条通道的 `capabilities()` 取或)。 */
  can: AdapterCapabilities
  /**
   * **写进去到什么程度**(送得进去才有这一格;念法见 {@link WRITE_MODE_TEXT})。
   * 一家取**最好**的那一档:有一条通道是 `full` 就是 `full`,会 `send` 的通道全是自绘那一档才标 `paste_only`。
   */
  write?: WriteMode
  /**
   * 凭什么说它在这台电脑上:
   * - `package` 探到它的包标识;
   * - `channel` 它某条通道此刻答应得上(Codex 关着窗、`app-server` 答应得上就是这一种);
   * - `unknown` 目录认识它、**这台探不出装没装**(Spotlight 关了 / 壳没连上)—— 照旧列出,
   *   「查不到」不许冒充「没有」(D13)。
   */
  here: 'package' | 'channel' | 'unknown'
}

export interface RegistryDeps {
  /**
   * 这台电脑上探到装了的那几个包(`installedAgents` / `clientScan` 那一份)。
   * 缺席 / 回 `undefined` = **探不出来**(不是「一个都没装」)。
   */
  installed?: () => readonly { bundle_id: string, running?: boolean }[] | undefined
  /**
   * **家族目录不认识、却已经认成一家**的那几条(今天 = `agentDiscovery` 判成 Agent 的陌生 App)。
   * 第三段把登记表那一份喂进来;这一份不自己判、不调模型。
   */
  extra?: () => readonly { family: string, name?: string, bundle_id?: string }[]
  /**
   * 一条通道的 `capabilities()` 答案留多久(毫秒)。默认 {@link CAPS_TTL_MS}。
   * 为什么要留一下:候选名单每打一个字就问一次,而窗口型那一条的 `capabilities()` 要碰壳。
   */
  capsTtlMs?: number
  now?: () => Date
}

/** `capabilities()` 的答案留多久。几秒 = 「现查」在人的尺度上,又不至于每打一个字碰一次壳。 */
export const CAPS_TTL_MS = 5000

export interface AdapterRegistry {
  /** 按 `family` 登记一条通道。同一家登记几条就是几条(Claude = socket + 窗口)。 */
  register: (adapter: Adapter) => void
  /** 这一家登记了哪几条通道(按稳到脆排;登记顺序打平)。 */
  channelsOf: (family: string) => readonly Adapter[]
  /**
   * 这一家每条通道此刻**为什么用不上**(人话;用得上的那几条不出现)。
   * 一条都排不上队时引擎把它接进 `why` —— 「壳没连上」与「这台没装它」下一步做的事不一样。
   */
  whyNotFor: (family: string) => readonly string[]
  /** 登记了的全部(登记顺序)。 */
  all: () => readonly Adapter[]
  /**
   * 这一件事能走哪几条通道,**排好队**。队里第一条就是 {@link adapterFor};
   * 这一样不会的一条都不在队里(引擎只在队里换路)。
   *
   * `need` 盖掉 {@link JOB_NEEDS} 那一格:**只读一眼**那条巡检要的是「读得到」而不是「送得进」
   * (`Engine.read` / `Engine.readApproval` 用它)—— 判据照旧只有这一处。
   */
  picksFor: (job: Job, options?: { need?: keyof AdapterCapabilities }) => Promise<readonly AdapterPick[]>
  /** 这一次先走哪一条(卡上那个 `adapterFor(family, package?)`)。队是空的就 undefined。 */
  adapterFor: (family: string, options?: { kind?: JobKind, package?: string }) => Promise<AdapterPick | undefined>
  /** 候选名单(家 + 能力标记)。**现查**:每条通道的 `capabilities()` 问一遍。 */
  targets: () => Promise<readonly EngineTarget[]>
  /**
   * ★ 候选名单的**同步**那一份(用上一次现查到的能力)。
   *
   * 为什么要它:composer 的 @ 候选、派活候选、能力体检这三处都挂在**同步**地拼 `/state` 那一拍上,
   * 而 `capabilities()` 是异步的。不给这个口子,那三处就只能各自再长一份「有哪几家」的判法 ——
   * 那正是「四件套的根子」(设计第七节)。过期的那几条顺手踢一次异步刷新,下一拍就跟得上。
   */
  targetsNow: () => readonly EngineTarget[]
  /**
   * ★ **上一次现查到的那一份(同步)**,`undefined` = 这一家还没查过。
   *
   * 为什么要一个同步的口子:界面上那几格(`/state.sessions[].ask.press` / `.write` / `.permission`)
   * 是在**同步**地拼 `/state` 的那一拍里算出来的,而 `capabilities()` 是异步的。
   * 不给这个口子,那几格就只能在管线里**另写一份**「这份壳会不会 `agent_press`」——
   * 两处判得不一样,界面上就会摆出一颗点下去说「到电脑上点」的键(D13 那个「点了没反应」)。
   *
   * 读这一下**顺手踢一次异步现查**(过了 {@link RegistryDeps.capsTtlMs} 才踢),所以第二拍起就跟得上;
   * 第一拍答 `undefined`,调用方照「查不到」说话 —— **「查不到」不许冒充「不行」,也不许冒充「行」**。
   */
  knownCaps: (family: string, options?: { vias?: readonly JobVia[] }) => AdapterCapabilities | undefined
  /** 这一次动这一家的哪个包(**只为记账与回话说清是哪扇窗**;探不出就缺席,不否决)。 */
  packageFor: (family: string, named?: string) => { bundle_id: string, name: string, why: 'said' | 'only' | 'running' | 'default' } | undefined
}

/** `Job.vias` 那张白名单(缺席 = 不限)。`picksFor` 与 `knownCaps` 同一处判。 */
function allowedVia(vias: readonly JobVia[] | undefined, via: JobVia): boolean {
  return vias === undefined || vias.includes(via)
}

export function createRegistry(deps: RegistryDeps = {}): AdapterRegistry {
  const now = deps.now ?? (() => new Date())
  const ttl = deps.capsTtlMs ?? CAPS_TTL_MS
  /** 登记顺序(同一家几条按登记先后打平)。 */
  const adapters: Adapter[] = []
  /** 一条通道上次查出来的能力 + 那一档 + 什么时候查的(一次问清,两处别各问一遍)。 */
  const capsCache = new Map<Adapter, { caps: AdapterCapabilities, write: WriteMode, atMs: number }>()
  /**
   * ★ **这一条通道的现查此刻在跑**(2026-10-03,卡「0.4.87 启动崩溃」;
   * 交接 `docs/交接-1003-0.4.87启动崩溃.md`)。
   *
   * 0.4.87 装到维护者那台上起不来、每 5 分钟崩一次,崩的是这个环:
   *
   * ```
   * targetsNow() → 过期就踢一次现查 → probe() → adapter.capabilities()
   *   → 窗口适配器问体检表 → 体检表问「体检哪几家」→ 又回到 targetsNow()
   * ```
   *
   * 窗口适配器那一格里**一个 `await` 都没有**(整段同步),于是这一圈是**同步**递归:
   * 一路爆栈,`RangeError` 爆在 `async` 函数体里 → 变成一条拒绝的 Promise →
   * 爆栈的深度上再去叫 `.catch()`,这才是 `web.stderr.log` 里那句
   * 「Exception in PromiseRejectCallback」的来处。
   *
   * 环的**根**在接线上(体检表的「哪几家」不许回头问候选名单,见 `adapters/window.ts` 的 `capCells`),
   * 这一格是**登记处自己的再入保护**:不靠任何调用方守规矩,
   * 同一条通道的现查**同时只跑一次**,而且现查期间一下都不再踢新的(见 {@link refresh})。
   */
  const inFlight = new Map<Adapter, Promise<{ caps: AdapterCapabilities, write: WriteMode }>>()

  /**
   * 现查这一条通道会哪几样。抛了 = 这一条什么都不会({@link NO_CAPABILITIES}),别的通道照旧算。
   *
   * `fresh:true` **不吃那几秒的缓存**:真要动手那一下(`picksFor`)必须问现在。
   * 不这样会出一个真毛病 —— 服务器先起、壳后连,中间只要有谁问过一次(候选名单 / `/state` 那一拍),
   * `send:false` 就被缓存住,接下来几秒里派活会被答成「没有一条能送话的通道」,而其实送得出去。
   * 界面那几格(`targets` / `knownCaps`)照旧吃缓存:它们每秒问一次,而且晚一拍不要紧。
   *
   * ★ **已经在跑的那一次照旧复用**(连 `fresh:true` 也复用;2026-10-03):在跑的那一次**不是缓存**,
   * 它问的就是现在。另起一次只会在同一拍里把壳问两遍 —— 而「两遍」正是 0.4.87 爆栈那一圈的燃料。
   */
  function probe(adapter: Adapter, options?: { fresh?: boolean }): Promise<{ caps: AdapterCapabilities, write: WriteMode }> {
    const had = capsCache.get(adapter)
    if (options?.fresh !== true && had !== undefined && now().getTime() - had.atMs < ttl) return Promise.resolve(had)
    const running = inFlight.get(adapter)
    if (running !== undefined) return running
    /*
     * ★ `Promise.resolve().then(() => adapter.capabilities())` 这一层**是故意的**,两件事:
     *
     * ① **先登记上「在跑」,再去碰 `capabilities()`。** 直接写 `adapter.capabilities()` 的话,
     *    一个 `async` 函数的函数体会在第一个 `await` 之前**同步**跑完 —— 于是它在下面那句
     *    `inFlight.set` **之前**就跑起来了,里面回头问一次候选名单,看见的还是「一次都没在跑」,
     *    于是再起一次、又一次,就是 0.4.87 那个环。隔开这一拍,再入的那一下才看得见「这一条在跑」。
     * ② **适配器同步抛**(不是 `async` 写法的那一种)也照契约算「这一条什么都不会」。
     *    同步抛会从 `probe` 里原样窜出去 —— 那正是「拒绝递归抛」的入口。
     */
    const task = (async () => {
      const caps = await Promise.resolve().then(() => adapter.capabilities()).catch(() => NO_CAPABILITIES)
      const write = await writeModeOf(adapter)
      const out = { caps, write }
      capsCache.set(adapter, { ...out, atMs: now().getTime() })
      return out
    })().finally(() => { inFlight.delete(adapter) })
    inFlight.set(adapter, task)
    return task
  }

  /**
   * ★ **过期 / 没查过的那几条顺手踢一次现查 —— 现查正在跑的时候一下都不踢**(2026-10-03)。
   *
   * 这就是再入保护那一半:`capabilities()` 求值期间再问一次候选名单(`targetsNow` / `knownCaps`),
   * 这一拍**不生出任何新的现查**。外面那一次本来就把每条通道都踢过了,少踢的这一下什么都不少;
   * 而少了它,同步递归就没有了燃料。
   */
  function refresh(which: readonly Adapter[]): void {
    if (inFlight.size > 0) return
    for (const one of which) void probe(one).catch(() => {})
  }

  async function capsOf(adapter: Adapter, options?: { fresh?: boolean }): Promise<AdapterCapabilities> {
    return (await probe(adapter, options)).caps
  }

  /** 这一家登记了的那几条(带登记顺序;能力还没查)。 */
  function channels(family: string): { adapter: Adapter, at: number }[] {
    return adapters
      .map((adapter, at) => ({ adapter, at }))
      .filter(one => one.adapter.family === family)
  }

  function packageFor(family: string, named?: string): ReturnType<AdapterRegistry['packageFor']> {
    const known = packagesOf(bindingFor(family))
    if (named !== undefined && named.trim() !== '') {
      const one = known.find(had => had.bundle_id === named)
      return { bundle_id: named, name: one?.name ?? bindingFor(family)?.name ?? named, why: 'said' }
    }
    const installed = deps.installed?.()
    const picked = pickFamilyPackage({ family, ...(installed === undefined ? {} : { installed }) })
    if (picked !== undefined) return picked
    /*
     * 家族目录里没有这一家(运行时新发现的那几家):它的家名**就是**它的包标识
     * (`agentSources.entryIdForBundle` 的那条规矩),所以不用再查一张表。
     * 目录认识、而这台一个包都没探到的那一种留 undefined —— 账上那一格空着,比记一个不在这台机器上的包标识实在。
     */
    if (family.includes('.')) return { bundle_id: family, name: bindingFor(family)?.name ?? family, why: 'default' }
    return undefined
  }

  async function picksFor(job: Job, options?: { need?: keyof AdapterCapabilities }): Promise<readonly AdapterPick[]> {
    const need = options?.need ?? JOB_NEEDS[job.kind]
    // 只许走那几条(`Job.vias`,卡 D):不在白名单里的连能力都不问 —— 不碰那只手。
    const configured = job.model !== undefined || job.effort !== undefined
    const mine = channels(job.family).filter(one => allowedVia(job.vias, one.adapter.via))
      .filter(one => !configured || one.adapter.via === 'cli' || job.family === 'codex' && one.adapter.via === 'protocol')
    const withCaps: PickCandidate[] = []
    // **现查**:真要动手那一下不吃缓存(见 {@link probe} 那一段)。
    for (const one of mine) withCaps.push({ ...one, caps: await capsOf(one.adapter, { fresh: true }) })
    const pkg = packageFor(job.family, job.package)
    return withCaps
      .filter(one => one.caps[need])
      // 派活按活的种类留通道(写代码只走命令行、在电脑上动手只走窗口);别的活种不过这一道。
      .filter(one => job.kind !== 'dispatch' || channelAllowedFor(job.work, one.adapter.via))
      .sort((a, b) => comparePicks(a, b, job, { reading: need === 'read' }))
      .map(one => ({
        adapter: one.adapter,
        caps: one.caps,
        ...(pkg === undefined ? {} : { bundle_id: pkg.bundle_id, name: pkg.name, why: pkg.why }),
      }))
  }


  /**
   * ★ **候选名单只算一遍**(`targets` 现查 / `targetsNow` 用上一次查到的,**判据同一份**)。
   *
   * `capsOf` 回 `undefined` = 这一条通道这会儿还不知道会什么 —— 那一格按「什么都不会」算
   * ({@link NO_CAPABILITIES}),但**这一家照旧列出**:她装着的那一家不该因为我们还没探完就从候选里消失。
   */
  function build(capsOf: (adapter: Adapter) => { caps: AdapterCapabilities, write: WriteMode } | undefined): readonly EngineTarget[] {
    const installed = deps.installed?.()
    const extras = deps.extra?.() ?? []
    /** 目录认识的那几家(事务官自己不进候选:她不派活给自己)+ 登记了通道的 + 调用方喂进来的。 */
    const order: string[] = []
    const push = (family: string): void => { if (family !== '' && !order.includes(family)) order.push(family) }
    for (const one of FAMILY_SOURCES) if (one.self !== true) push(one.agent)
    for (const one of adapters) push(one.family)
    for (const one of extras) push(one.family)
    const out: EngineTarget[] = []
    for (const family of order) {
      const binding = bindingFor(family)
      const extra = extras.find(one => one.family === family)
      if (binding?.self === true) continue
      const known = packagesOf(binding)
      const here = known.filter(one => installed?.some(had => had.bundle_id === one.bundle_id) === true)
      const mine = channels(family)
      const can: AdapterCapabilities = { ...NO_CAPABILITIES }
      const vias: JobResult['via'][] = []
      /** 会 `send` 的那几条通道各报的那一档(有一条 `full` 就是 `full`)。 */
      const writes: WriteMode[] = []
      /**
       * ★ **「某条通道此刻答应得上」只算协议那几条**(`here:'channel'` 的依据)。
       *
       * 窗口那一条说「会」只说明**壳连着**:这台到底装没装那一家,它是从家族目录的主包猜的
       * (`resolvePackage` 在探不出装机时退到主包 —— 那是送话那一刻的合理退路,
       * 可拿它当「这一家在这台电脑上」的证据就是**把「查不到」说成了「有」**)。
       * 协议那几条不一样:Codex 的 `app-server` 握上了、Claude 的 socket 文件在,
       * 那是**真答应得上** —— 哪怕它的窗一扇都没有(设计第七节那两个病例之一)。
       */
      let answered = false
      for (const one of mine) {
        const got = capsOf(one.adapter) ?? { caps: NO_CAPABILITIES, write: 'full' as WriteMode }
        for (const key of Object.keys(can) as (keyof AdapterCapabilities)[]) can[key] = can[key] || got.caps[key]
        if (!vias.includes(one.adapter.via)) vias.push(one.adapter.via)
        if (got.caps.send) writes.push(got.write)
        // 只算协议那几条(见上面那段):命令行 / 接口那两条「会」只说明这台有那个二进制 / 中转配了,不说明这一家在这台电脑上。
        if (one.adapter.via === 'protocol' && Object.values(got.caps).some(Boolean)) answered = true
      }
      const write: WriteMode | undefined = writes.length === 0
        ? undefined
        : writes.includes('full') ? 'full' : 'paste_only'
      vias.sort((a, b) => channelRank(a) - channelRank(b))
      const where: EngineTarget['here'] | undefined
        = here.length > 0 || (extra?.bundle_id !== undefined && installed?.some(had => had.bundle_id === extra.bundle_id) === true)
          ? 'package'
          : answered
            ? 'channel'
            // 探不出装没装(壳没连上 / Spotlight 关了)→ 照旧列出;探过、没它、通道也不答应 → 不列。
            : installed === undefined ? 'unknown' : undefined
      if (where === undefined) continue
      const pkg = packageFor(family, extra?.bundle_id)
      out.push({
        family,
        name: binding?.name ?? extra?.name ?? family,
        ...(pkg === undefined ? {} : { bundle_id: pkg.bundle_id }),
        ...(here.length < 2 ? {} : { packages: here.map(one => ({ bundle_id: one.bundle_id, name: one.name })) }),
        channels: vias,
        can,
        ...(write === undefined ? {} : { write }),
        here: where,
      })
    }
    return out
  }

  return {
    register(adapter) { adapters.push(adapter); capsCache.delete(adapter) },
    all() { return [...adapters] },
    channelsOf(family) {
      return channels(family)
        .sort((a, b) => channelRank(a.adapter.via) - channelRank(b.adapter.via) || a.at - b.at)
        .map(one => one.adapter)
    },
    picksFor,
    whyNotFor(family) {
      const out: string[] = []
      for (const one of channels(family)) {
        const why = one.adapter.unavailable?.()
        if (why !== undefined && why.trim() !== '' && !out.includes(why)) out.push(why)
      }
      return out
    },
    knownCaps(family, options) {
      const mine = channels(family).filter(one => allowedVia(options?.vias, one.adapter.via))
      if (mine.length === 0) return undefined
      const nowMs = now().getTime()
      let out: AdapterCapabilities | undefined
      let stale = false
      for (const one of mine) {
        const had = capsCache.get(one.adapter)
        if (had === undefined) { stale = true; continue }
        /*
         * ★ **过期了照旧答上一次查到的那一份**(2026-10-02):这一格的约定就是「上一次现查到的」。
         * 换成「过期 = 查不到」会出一个真毛病:界面闲了几秒(`CAPS_TTL_MS`)之后的第一拍,
         * 那几颗键会先消失一拍再回来 —— 她看到的是键在闪。
         */
        if (nowMs - had.atMs >= ttl) stale = true
        out = out === undefined ? { ...had.caps } : out
        for (const key of Object.keys(out) as (keyof AdapterCapabilities)[]) out[key] = out[key] || had.caps[key]
      }
      // 过期 / 没查过的那几条:踢一次异步现查,下一拍就跟得上(这一拍照旧答上一次查到的)。
      if (stale) refresh(mine.map(one => one.adapter))
      return out
    },
    async adapterFor(family, options) {
      const kind = options?.kind ?? 'answer'
      const picks = await picksFor({
        id: `probe:${family}`,
        family,
        kind,
        target: { kind: 'new' },
        text: '',
        expect: 'ack',
        ...(options?.package === undefined ? {} : { package: options.package }),
      })
      return picks[0]
    },
    packageFor,
    /**
     * 候选名单(见 {@link AdapterRegistry.targets})。**现查**:每条通道的 `capabilities()` 都问一遍。
     */
    async targets() {
      const caps = new Map<Adapter, { caps: AdapterCapabilities, write: WriteMode }>()
      for (const one of adapters) caps.set(one, await probe(one))
      return build(one => caps.get(one))
    },
    /**
     * 候选名单的**同步**那一份(见 {@link AdapterRegistry.targetsNow})。
     * 用上一次现查到的能力(`knownCaps` 那一套),过期的顺手踢一次异步刷新。
     */
    targetsNow() {
      const nowMs = now().getTime()
      let stale = false
      const out = build((adapter) => {
        const had = capsCache.get(adapter)
        if (had === undefined) { stale = true; return undefined }
        // 过期了照旧用上一次查到的那一份(同 {@link AdapterRegistry.knownCaps} 那一段的理由)。
        if (nowMs - had.atMs >= ttl) stale = true
        return { caps: had.caps, write: had.write }
      })
      if (stale) refresh(adapters)
      return out
    },
  }
}
