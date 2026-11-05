/**
 * **一条引擎 + 一个假壳**(2026-10-02,卡「引擎接线与删复制品」)。
 *
 * 到 10-02 为止「往别家 AI 送一句话」在四个文件的八处各写一遍,于是用例里也有好几套假件:
 * `ClientDispatchDeps`(派活那一套)、`WindowAnswerHand`(六只手那一套)、`RelayReaderDeps`(巡检那一套)。
 * 删掉那八处之后只剩**一条**路,所以用例也只搭一次:
 * **假壳 + 真引擎**(真的窗口适配器、真的登记处、真的闸、真的账)。
 *
 * 这样写还有一个好处:用例从此是**端到端**的 —— 壳收到哪几个 op、带哪几个字段,断言看得见;
 * 从前假的那只手挡在中间,壳那一侧的回归(`submitted` 回执不可靠、reject 一个 Error)测不到。
 */
import { createActionGate, type ActionGate } from '../../src/server/actionGate.ts'
import { createJobLog, type JobEvent, type JobLog } from '../../src/server/jobLog.ts'
import type { HelperRequest } from '../../src/server/helperChannel.ts'
import type { StructureMode } from '../../src/server/agentJudge.ts'
import { createEngineWiring, type EngineWiringDeps } from '../../src/server/engine/wire.ts'
import { CLI_FAMILIES, createCliAdapter, type CliAdapterDeps } from '../../src/server/engine/adapters/cli.ts'
import { createApiAdapter, type ApiAdapterDeps } from '../../src/server/engine/adapters/api.ts'
import { API_DISPATCH_FAMILIES } from '../../src/server/dispatchApi.ts'
import type { Engine } from '../../src/server/engine/engine.ts'
import type { AdapterRegistry } from '../../src/server/engine/registry.ts'
import type { JobPhase } from '../../src/server/actionGate.ts'

/** 假壳这一回怎么答(回一个对象 = 成;抛 = 壳那边 reject,真壳失败就是这一种)。 */
export type FakeHelperReply = (req: HelperRequest) => Record<string, unknown> | Promise<Record<string, unknown>>

/** 这份假壳会哪几件本事(照真壳 `HelperSocket` 报的那一串)。 */
export const ALL_HELPER_CAPS: readonly string[] = [
  'read_reply', 'agent_read', 'agent_pick', 'agent_stop', 'agent_press', 'agent_write_ask', 'agent_approval',
  'new_conversation', 'save_draft',
]

export interface EngineHarnessOptions {
  /**
   * **直接给一份壳**(已经造好的那种:`HelperChannel` 的假件 / 真件)。
   * 给了它就不用 {@link reply} / {@link connected} —— 那几条 http 用例本来就自己记着发给壳的每一条 req。
   */
  helper?: { connected: () => boolean, supports?: (cap: string) => boolean, request: (req: HelperRequest, timeoutMs?: number) => Promise<Record<string, unknown>> }
  /** 壳这一回答什么。缺席 = 一律 `{ submitted: true, method: 'ax_value' }`。 */
  reply?: FakeHelperReply
  /** 壳连上了没有。缺席 = 连上了。 */
  connected?: () => boolean
  /** 这份壳会哪几件本事。缺席 = {@link ALL_HELPER_CAPS} 全会。 */
  caps?: readonly string[]
  /** 这一家装着哪几个包(窗口适配器挑包的输入)。缺席 = 家族目录的主包。 */
  installed?: (family: string) => readonly { bundle_id: string, name?: string, running?: boolean }[] | undefined
  /** 这台电脑上装着哪几个包(候选名单那一格)。 */
  machine?: readonly { bundle_id: string, running?: boolean }[]
  /** 登记表给的那个包(运行时发现的那几家家名就是包标识)。 */
  bundleOf?: (family: string) => string | undefined
  /** 这一家叫什么。 */
  nameOf?: (family: string) => string
  /** 登记表「认出是 AI 应用、可那扇窗读不到」那一截(生产由 index.ts 从发现引擎取)。缺席 = 不知道。 */
  unreadable?: () => readonly { id: string, name: string, bundle_id: string }[]
  /** 深链要的那个编号(Claude 的 `local_…`)。 */
  hostIdOf?: (family: string, sessionId: string) => string | undefined
  /** 这扇窗是不是自绘的。 */
  structureMode?: (family: string) => StructureMode | undefined
  /** 「这件事收场了没有」。缺席 = 一律 `unknown`(放行)。 */
  phaseOf?: (job: string) => JobPhase
  /** 开深链 / 开窗 / 叫台前。缺席 = 都成(但不发 op)。 */
  openUrl?: (url: string) => Promise<{ ok: boolean }>
  openApp?: (bundleId: string) => Promise<{ ok: boolean }>
  bringToFront?: (bundleId: string) => Promise<{ ok: boolean }>
  /** 没跑就拉起来。缺席 = 不拉(行为与老宿主一字不差)。 */
  ensureRunning?: (family: string, bundleId: string) => Promise<{ ok: boolean, reason?: string }>
  /**
   * **这一刻电脑锁着屏没有**(2026-10-03,卡「锁屏时窗口型的家送不进」)。
   * 缺席 = 不知道(窗口那一层照旧送,与 2026-10-03 之前一字不差)。
   */
  screenLocked?: () => boolean | undefined
  /** 锁着屏时那几件活排的队(缺席 = 不排:如实说没送)。 */
  lockQueue?: EngineWiringDeps['lockQueue']
  /** 框里她没发出去的那段字存哪。缺席 = 不接(壳照旧「有草稿就不送」)。 */
  saveDraft?: (input: { family: string, text: string, at: string }) => Promise<{ ok: boolean, path?: string, reason?: string }>
  draftNote?: (input: { who: string, saved: { ok: boolean, path?: string, reason?: string }, returned: boolean, reason?: string }) => string
  /** 第三档证据(那条会话的记录文件)。缺席 = 这一档关着。 */
  transcript?: EngineWiringDeps['transcript']
  /**
   * 现在几点(闸的间隔、账上的时刻)。
   *
   * 缺席 = **一条自己往前走的钟**(每问一次 +1 秒)。为什么不给一个定住的钟:
   * 闸里几样动作的间隔是 1~1.5 秒(`GATE_LIMITS`),钟定住的话同一条用例里送第二句话会被
   * 「离上一回太密」拦下 —— 那是钟的毛病,不是代码的。要测那一条间隔的用例自己传一个定住的钟。
   */
  now?: () => Date
  /** 协议那两条要不要登记(缺席 = 都不登记:用例里只测窗口那一条)。 */
  claude?: EngineWiringDeps['claude']
  codex?: EngineWiringDeps['codex']
  /**
   * 命令行 / 接口那两条要不要登记(2026-10-03,卡「派活三只手收进引擎」;缺席 = 不登记)。
   * 生产由 `http.ts` 往登记表里登(它手里有 runCli / apiDispatch 那几样);用例在这儿给假件。
   */
  cli?: CliAdapterDeps
  api?: ApiAdapterDeps
  /** 闸的上限盖掉(用例里调小 / 调大)。 */
  limits?: Parameters<typeof createActionGate>[0]['limits']
}

export interface EngineHarness {
  engine: Engine
  registry: AdapterRegistry
  gate: ActionGate
  log: JobLog
  /** 假壳收到的每一个 op(顺序照原样)。 */
  requests: HelperRequest[]
  /** 收到的 `send_text` 各送给了哪个包。 */
  sentTo: () => string[]
  /** 账上那几行。 */
  events: () => readonly JobEvent[]
  /** 引擎记的那几行日志(结局那一行)。 */
  lines: readonly string[]
}

export function engineHarness(options: EngineHarnessOptions = {}): EngineHarness {
  const requests: HelperRequest[] = []
  const lines: string[] = []
  const caps = new Set(options.caps ?? ALL_HELPER_CAPS)
  const base = Date.parse('2026-10-02T12:00:00.000Z')
  let ticks = 0
  const now = options.now ?? (() => new Date(base + (ticks += 1000)))
  const log = createJobLog({ now, warn: () => {} })
  const gate = createActionGate({
    phaseOf: options.phaseOf ?? (() => 'unknown'),
    log,
    now,
    // 闸拦下那句人话里的家名(与生产一样:`sessionAgentName` / 登记表里的显示名)。
    ...(options.nameOf === undefined ? {} : { name: options.nameOf }),
    ...(options.limits === undefined ? {} : { limits: options.limits }),
  })
  const wiring = createEngineWiring({
    gate,
    log,
    ...(options.nameOf === undefined ? {} : { name: options.nameOf }),
    warn: line => { lines.push(line) },
    sleep: () => Promise.resolve(),
    ...(options.transcript === undefined ? {} : { transcript: options.transcript }),
    ...(options.lockQueue === undefined ? {} : { lockQueue: options.lockQueue }),
    ...(options.claude === undefined ? {} : { claude: options.claude }),
    ...(options.codex === undefined ? {} : { codex: options.codex }),
    registry: {
      installed: () => options.machine,
    },
    window: {
      helper: options.helper === undefined
        ? {
            connected: options.connected ?? (() => true),
            supports: cap => caps.has(cap),
            request: (req) => {
              requests.push(req)
              const answer = options.reply ?? (() => ({ submitted: true, method: 'ax_value' }))
              return Promise.resolve(answer(req))
            },
          }
        : {
            connected: options.helper.connected,
            supports: cap => options.helper?.supports?.(cap) ?? caps.has(cap),
            request: (req, timeoutMs) => {
              requests.push(req)
              return (options.helper as NonNullable<EngineHarnessOptions['helper']>).request(req, timeoutMs)
            },
          },
      ...(options.installed === undefined ? {} : { installed: options.installed }),
      ...(options.bundleOf === undefined ? {} : { bundleOf: options.bundleOf }),
      ...(options.nameOf === undefined ? {} : { nameOf: options.nameOf }),
      ...(options.unreadable === undefined ? {} : { unreadable: options.unreadable }),
      ...(options.hostIdOf === undefined ? {} : { hostIdOf: options.hostIdOf }),
      ...(options.structureMode === undefined ? {} : { structureMode: options.structureMode }),
      ...(options.openUrl === undefined ? {} : { openUrl: options.openUrl }),
      ...(options.openApp === undefined ? {} : { openApp: options.openApp }),
      ...(options.bringToFront === undefined ? {} : { bringToFront: options.bringToFront }),
      ...(options.ensureRunning === undefined ? {} : { ensureRunning: options.ensureRunning }),
      ...(options.screenLocked === undefined ? {} : { screenLocked: options.screenLocked }),
      ...(options.saveDraft === undefined ? {} : { saveDraft: options.saveDraft }),
      ...(options.draftNote === undefined ? {} : { draftNote: options.draftNote }),
      gate,
      // 闸上「这件事」的键:与生产一样(`jobKey.ts` 一处定法,引擎自己也用它)。
      gateJobOf: job => (job.itemId ?? job.id),
      sleep: () => Promise.resolve(),
      settleMs: 0,
      wakeWaitMs: 0,
      now,
    },
  })
  // 命令行 / 接口两条通道(与生产 `http.ts` 同一条登记法:按家登,一家一条)。
  if (options.cli !== undefined) for (const family of CLI_FAMILIES) wiring.registry.register(createCliAdapter(family, options.cli))
  if (options.api !== undefined) for (const family of API_DISPATCH_FAMILIES) wiring.registry.register(createApiAdapter(family, options.api))
  return {
    engine: wiring.engine,
    registry: wiring.registry,
    gate,
    log,
    requests,
    sentTo: () => requests.filter(one => one.op === 'send_text').map(one => (one as { bundle_id: string }).bundle_id),
    events: () => log.all(),
    lines,
  }
}
