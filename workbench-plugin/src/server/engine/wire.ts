/**
 * ★ **把引擎接上**(2026-10-02,卡「引擎接线与删复制品」;设计 `docs/设计-一条引擎替八条管线-2026-10-02.md` 第四节第 3 段)。
 *
 * 前两段把引擎(`engine.ts`)、登记处(`registry.ts`)与三个适配器(Claude socket / Codex 协议 / 窗口)
 * 都写好了,可**一个调用方都没有** —— 旧的八条管线照原样跑着。这一份就是那一个调用方:
 * 一处造出 `registry` + `engine`,`index.ts` 与 `http.ts` 各接一次,**别处不许再造第二份**。
 *
 * ## 登记哪几条通道
 *
 * | 家 | 通道 | 为什么 |
 * |---|---|---|
 * | `claude` | socket(协议)+ 窗口 | socket 送得进话、读得到记录文件;点键 / 写面板 / 按停止它做不了 → 换窗口那条 |
 * | `codex` | `app-server`(协议)+ 窗口 | 同上;窗口只用来点键 / 写面板 |
 * | 别的每一家 | 窗口 | 豆包 / Kimi / Manus / Muse / Antigravity / Grok Bot / 下一家新接上的 |
 * | 本机有对话库的那几家(千问办公) | 记录文件(只读)+ 窗口 | 收回答先从它的库里取,读不了换窗口(2026-10-09) |
 * | Claude / Kimi | 再多一条记录文件(只读) | 收回答按记号在它的会话记录里找那一轮(2026-10-12);Claude 读的时候 socket 那条排在前 |
 *
 * **窗口那一条是按家现造的**(一个实例管一家,契约里 `family` 是只读的一格):
 * 家族目录里那几家在建的时候就登记上;运行时才认出来的陌生 App(`extra()`)与
 * 第一次被点名的那一家在 {@link ensure} 里**现登记** —— 不预先列一张名单,也就没有「名单里没有它」这回事。
 *
 * ## 不在这里的几件事
 *
 * - 「这件事的键」:`jobKey.ts` 一处(这里只把它接成 `gateJobOf`);
 * - 「这件事收场了没有」:`actionGate` + `jobKey.jobPhaseOf`(这里只把闸接进去);
 * - 「派给谁」:`dispatchChoice.ts`;
 * - 「这是不是个 AI 应用」:`agentDiscovery.ts`,**只对目录不认识的陌生 App 判一次**,判成了喂进 `extra()`。
 */
import type { ActionGate } from '../actionGate.ts'
import type { AgentRecordReaders } from '../agentRecords.ts'
import { FAMILY_SOURCES, packagesOf } from '../agentSources.ts'
import type { JobLog } from '../jobLog.ts'
import type { Job } from './adapter.ts'
import { createClaudeAdapter, type ClaudeAdapterDeps } from './adapters/claude.ts'
import { codexAdapter, type CodexAdapterDeps } from './adapters/codex.ts'
import { createRecordsAdapter } from './adapters/records.ts'
import { createWindowAdapter, type WindowAdapterDeps } from './adapters/window.ts'
import type { Engine, EngineDeps } from './engine.ts'
import { createEngine } from './engine.ts'
import type { AdapterRegistry, RegistryDeps } from './registry.ts'
import { createRegistry } from './registry.ts'

/** Claude 桌面那一家在家族目录里的家名(socket 适配器登记的就是它)。 */
export const CLAUDE_FAMILY = 'claude'
/** Codex 桌面那一家在家族目录里的家名。 */
export const CODEX_FAMILY = 'codex'

/**
 * **哪几家在建的时候就登记上窗口那一条**:家族目录里**有自己那扇窗**的每一家。
 *
 * 去掉两种:事务官自己(`self` —— 她不派活给自己),以及**没有自己那扇能送话的窗**的那几家
 * (`noWindow`,今天 = GPT:它与 Codex 是同一个 App,两家抢同一扇窗会互相盖掉)。
 */
export function windowFamiliesOf(): readonly string[] {
  return FAMILY_SOURCES.filter(one => one.self !== true && one.noWindow !== true).map(one => one.agent)
}

export interface EngineWiringDeps {
  gate: ActionGate
  log: JobLog
  /** 家名(人话;缺席 = 家名 id 原样)。 */
  name?: (family: string) => string
  /**
   * **这件事的键**(`jobKey.ts` 一处定法:有事项用事项 id,没有就用会话键)。
   * 引擎自己算一份(`engineJobKey`),这一格是给**窗口适配器里那一样** `window_wake` 用的
   * —— 开窗只存在于那一层,引擎看不见它(交接「窗口适配器」第三节第 6 条)。
   */
  gateJobOf?: (job: Job) => string | undefined
  /** 窗口那一条要的那几样(每一格都带 `family` 参数,所以一份 deps 管所有家)。 */
  window?: WindowAdapterDeps
  /**
   * ★ **它自己的记录**(`agentRecords.createRecordReaders`;2026-10-09)。有 `reply` 这一路的那几家,
   * 登记窗口那一条时一起登记一条只读的「记录文件」通道:收回答先读它的库,读不了换窗口。
   * 缺席 = 不登记(用例 / 老接线一字不变)。
   */
  records?: AgentRecordReaders
  /** Claude 跨会话 socket 那一条。`false` / 缺席 = 这台不登记它(用例)。 */
  claude?: ClaudeAdapterDeps | false
  /** Codex `app-server` 那一条。`false` / 缺席 = 不登记。 */
  codex?: CodexAdapterDeps | false
  /** 登记处那几样(这台装了哪几个包、目录不认识的那几家、能力答案留多久)。 */
  registry?: Pick<RegistryDeps, 'installed' | 'extra' | 'capsTtlMs' | 'now'>
  /**
   * **第三档证据:那条会话自己的记录文件**(卡 AW 三档里最硬的那一档;见 {@link EngineDeps.transcript})。
   * 缺席 = 这一档关着 —— 窗口那一层核不上时就只能说「没能核实」。
   */
  transcript?: EngineDeps['transcript']
  /**
   * ★ **电脑锁着屏时那几件活排的队**(2026-10-03,卡「锁屏时窗口型的家送不进」;
   * 那一本在 `engine/lockQueue.ts`,落盘、原顺序、重启不丢)。
   * 缺席 = 不排(如实说没送,与 2026-10-03 之前一字不差)。
   */
  lockQueue?: EngineDeps['lockQueue']
  /** 每一家一条窗口通道(2026-10-21,卡「派活按家隔离」;`familyLanes.ts`)。缺席 = 不隔离。 */
  lanes?: EngineDeps['lanes']
  /** 一条通道最多跑几回(含第一回)。缺席 = 契约里那个数。 */
  maxTries?: number
  sleep?: (ms: number) => Promise<void>
  warn?: (line: string) => void
}

export interface EngineWiring {
  registry: AdapterRegistry
  engine: Engine
  /** 工作台停的时候叫一次(Codex 那条长连接要关掉)。 */
  close: () => void
}

export function createEngineWiring(deps: EngineWiringDeps): EngineWiring {
  const base = createRegistry(deps.registry ?? {})
  /** 已经登记过窗口那一条的家(一家一个实例,不重复登记)。 */
  const windowed = new Set<string>()
  const closers: (() => void)[] = []

  function ensure(family: string): void {
    if (family.trim() === '' || windowed.has(family)) return
    windowed.add(family)
    if (deps.window === undefined) return
    // 事务官自己不派活给自己;没有自己那扇窗的那几家不登记窗口(见 {@link windowFamiliesOf})。
    const binding = FAMILY_SOURCES.find(one => one.agent === family)
    if (binding?.self === true || binding?.noWindow === true) return
    base.register(createWindowAdapter(family, deps.window))
    /*
     * 记录那一条只跟着窗口那一条登记(问到这一家 / 认出这一家才有),不凭空把一家列进候选。
     * 这一家可能是哪几个包:家族目录认识就是它的那几个包;不认识的那几家家名就是包标识(`entryIdForBundle`)。
     */
    const records = deps.records
    if (records !== undefined) {
      const bundles = binding === undefined ? [family] : packagesOf(binding).map(one => one.bundle_id)
      const mine = bundles.filter(one => records.hasReply(one))
      if (mine.length > 0) base.register(createRecordsAdapter(family, { bundleIds: mine, readers: records }))
    }
  }

  function ensureAll(): void {
    for (const family of windowFamiliesOf()) ensure(family)
    for (const one of deps.registry?.extra?.() ?? []) ensure(one.family)
  }

  /*
   * 协议那两条先登记:`comparePicks` 按「通道从稳到脆」排(协议 > 命令行 > 文件 > 窗口),
   * 所以登记顺序其实不决定次序 —— 先登记只是让一家的通道在 `all()` 里看着顺。
   */
  if (deps.claude !== undefined && deps.claude !== false) {
    base.register(createClaudeAdapter(deps.claude))
  }
  if (deps.codex !== undefined && deps.codex !== false) {
    const codex = codexAdapter(deps.codex)
    base.register(codex)
    if (typeof codex.close === 'function') closers.push(() => { codex.close?.() })
  }
  ensureAll()

  /**
   * 登记处外面套一层:**问到哪一家就现登记那一家的窗口那一条**。
   * 运行时才认出来的陌生 App(Grok Bot / Antigravity / 可灵)不必预先列进任何名单。
   */
  const registry: AdapterRegistry = {
    register: adapter => { windowed.add(adapter.family); base.register(adapter) },
    all: () => base.all(),
    channelsOf: (family) => { ensure(family); return base.channelsOf(family) },
    whyNotFor: (family) => { ensure(family); return base.whyNotFor(family) },
    picksFor: (job, options) => { ensure(job.family); return base.picksFor(job, options) },
    adapterFor: (family, options) => { ensure(family); return base.adapterFor(family, options) },
    targets: () => { ensureAll(); return base.targets() },
    targetsNow: () => { ensureAll(); return base.targetsNow() },
    packageFor: (family, named) => base.packageFor(family, named),
    knownCaps: (family, options) => { ensure(family); return base.knownCaps(family, options) },
  }

  const engine = createEngine({
    registry,
    gate: deps.gate,
    log: deps.log,
    ...(deps.name === undefined ? {} : { name: deps.name }),
    ...(deps.maxTries === undefined ? {} : { maxTries: deps.maxTries }),
    ...(deps.sleep === undefined ? {} : { sleep: deps.sleep }),
    ...(deps.warn === undefined ? {} : { warn: deps.warn }),
    ...(deps.transcript === undefined ? {} : { transcript: deps.transcript }),
    ...(deps.lockQueue === undefined ? {} : { lockQueue: deps.lockQueue }),
    ...(deps.lanes === undefined ? {} : { lanes: deps.lanes }),
  })

  /*
   * ★ **起来就把每条通道的能力现查一遍**(2026-10-02)。
   *
   * 界面上那几格(`/state.sessions[].ask.press` / `.write` / `.permission`、@ 候选、能力体检)
   * 读的是**同步**那一份(`knownCaps` / `targetsNow`:上一次现查到的)。不预热的话第一拍必然答
   * 「还不知道」,于是起服务后第一眼那几颗键是空的 —— 下一拍才出来,她看到的是键在闪。
   * **绝不抛**:探不到就探不到(那一家照旧在候选里,只是能力那几格空着)。
   */
  void registry.targets().catch(() => {})

  return { registry, engine, close: () => { for (const one of closers) one() } }
}
