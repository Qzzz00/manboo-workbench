/**
 * ★ **会话那几条路后面换成引擎**(2026-10-02,卡「引擎接线与删复制品」)。
 *
 * 维护者 10-02:「你不要拿着打补丁的心态……嘴上说着不打补丁,结果全是打补丁。」
 *
 * 这一份接的是 `docs/交接-1002-引擎核心.md` 第四节那张对照表的会话那一半:
 * `/sessions/answer`、`/sessions/relay`、`/asks/answer`(写面板 / 点选项)、`/sessions/approval/read`。
 * 它**只做三件事**:
 *
 * 1. **判这一下该不该动手**(那条会话在不在、是不是弹框那一问、要不要先按停止)——
 *    判据全是 `sessionAnswer.ts` 里的纯函数与 `relayMove.ts`,这里一个字都不另写;
 * 2. **拼一个 `Job` 交给 `Engine.run`** —— 怎么开到那一段、怎么打字、没窗口怎么开窗、
 *    过闸、落账、重试、换路,**一样都不在这儿**(全在引擎与适配器);
 * 3. **把 `JobResult` 三种结局翻成回包形状**(`ok / confirmed / note / where / why / reveal`),
 *    手机 / 电话工人 / 展示台一个字不改。
 *
 * ## 删掉的那一份
 *
 * `sessionAnswer.createWindowAnswerHand` 六只手(答 / 捎话 / 点选项 / 写面板 / 看按权限弹框 / 停止)
 * 与 `pushIntoWindow` / `confirmInTranscript` / `sendIntoConversation` 全删 —— 它们做的事现在在
 * `engine/adapters/window.ts` 一处(送 / 读 / 开窗 / 挑包)与 `engine/engine.ts`(闸 / 账 / 重试 / 记录文件那一档)。
 * 对照表在 `docs/交接-1002-窗口适配器.md` 第二节。
 *
 * ## 三种结局怎么翻(一处写,四条路都照它)
 *
 * | `JobResult` | 回包 |
 * |---|---|
 * | `confirmed` | `ok:true, confirmed:true` |
 * | `unconfirmed` | `ok:true, confirmed:false, note:why` —— **一个字都不说成送到了** |
 * | `not_sent` | `ok:false, status:200, where:'desk', why` + 「去回答」那颗键 |
 */
import type { SessionView } from '../protocol.ts'
import type { ApprovalKey } from './approvalKeys.ts'
import { isPermissionAsk, pickApprovalPanel, resolveApprovalKey, approvalKeyKind } from './approvalKeys.ts'
/** 「替她答完到底成了没有」那一处判据(2026-10-13,卡 C)。 */
import {
  ASK_LANDED_POLL_BUDGET_MS,
  ASK_LANDED_POLL_MS,
  ASK_LANDED_POLL_TRIES,
  askLanded,
  type AskLandedVerdict,
} from './askLanded.ts'
import { CLIENT_DISPATCH_NEVER } from './dispatchClient.ts'
import type { Engine } from './engine/engine.ts'
import { RELAY_DEDUPED_NOTE } from './actionGate.ts'
import type { AdapterCapabilities, Job, JobResult } from './engine/adapter.ts'
import type { AdapterRegistry } from './engine/registry.ts'
import { sessionJobId } from './jobKey.ts'
import { relayMoveOf, type RelayKind } from './relayMove.ts'
/** 锁着屏那一句人话(引擎那一份的同一个出处);2026-10-03。 */
import { screenLockedSay } from './screenLock.ts'
/** 那条会话没开着时留言的那一句(2026-10-23,卡「捎话留言等它醒」)。 */
import { SESSION_CLOSED_QUEUED_SAY } from './sessionClosed.ts'
import { relayMark, relayPrompt, relayReadMark, type RelaySessionView } from './sessionRelay.ts'
import {
  type AnswerPlan,
  type AnswerResult,
  type ApprovalReadResult,
  type AskOrigin,
  type PressResult,
  type RelayReady,
  type RelayResult,
  type SessionAnswerService,
  type WriteAskResult,
  answerMarkerOf,
  answerPlanOf,
  answerViasOf,
  askPanelMarksOf,
  pickMarkerOf,
  relayMarkersOf,
} from './sessionAnswer.ts'
import { sessionBusy } from '../protocol.ts'

/** 「它那边弹了个框等你点」那一截(与从前逐字相同)。 */
const CLICK_THERE = '(它那边弹了个框等你点)'

/** 这条会话此刻在跑没(与气泡、会话列表同一份判据)。 */
function isRunning(view: RelaySessionView): boolean {
  return view.status === 'running' || (view.status !== 'waiting' && sessionBusy(view))
}

/** 这条会话的来路:`window:<hash>` 是读它的窗口读出来的一条对话,别的是那家自己的会话记录。 */
function relayKindOf(sessionId: string): RelayKind {
  return sessionId.startsWith('window:') ? 'window' : 'file'
}

/** 弹窗 / 子任务的那一问:往对话框里打字答不了(得在那家里点那个框)。 */
function mustClick(ask: AskOrigin | undefined): boolean {
  return ask !== undefined && (ask.by === 'form' || ask.child !== undefined)
}

/**
 * ★ **电脑锁着屏那一下的回包**(2026-10-03,卡「锁屏时窗口型的家送不进」)。
 *
 * 四条路(替她答 / 捎话 / 点选项 / 写面板)同一处翻,三件事都是故意的:
 *
 * ① **那句人话原样用引擎那一份**(`screenLock.screenLockedSay` 一处)——
 *    **不在前面接 `deskWhy`**(「这一问得到电脑上的 Kimi 里回」):她这会儿看不见屏幕,
 *    叫她去电脑上点是一句没用的话,而真正该说的是「电脑锁着屏 / 解锁了我就送 /
 *    现在就要办走不靠窗口的那几家」。手机、电话、`jobs.jsonl` 因此是**同一句**(卡上第 3 条)。
 * ② **`reveal:false`**:「去回答」那颗键摆不出来 —— 锁屏时 `open -b` / 深链都开不出窗
 *    (真机 09:04 五次都没用),摆一颗点了没反应的键就是 D13 那个病。
 * ③ **一条替代的路都不走**(同闸拦下那一下):换一条通道、把她点的那一项当一句话发进对话,
 *    一样撞在锁屏上。
 */
function screenLockedReply(out: JobResult): { ok: false, status: 200, where: 'desk', why: string, reveal: false } {
  return { ok: false, status: 200, where: 'desk', why: out.why ?? SCREEN_LOCKED_FALLBACK, reveal: false }
}

/** 引擎没给那句话时的那一份(真路上一定有:`locked()` 一处写;这一句只为类型上不留一个 `undefined`)。 */
const SCREEN_LOCKED_FALLBACK = screenLockedSay({ agentName: '它', queued: false })

/**
 * ★ **那条会话没开着**(2026-10-23,卡「捎话到没开着的会话留言等它醒」;统筹合并时补的替她答那一支):
 * 与 {@link screenLockedReply} 同款 —— 引擎已经把这一件排进队(`lockQueued`)、`why` 就是留言那句
 * (「那条会话没开着,这句我留着,它一开就送进去」),或者没排上时适配器那句「没开着」;这里**原样交出去**,
 * 不接「到电脑上点」那截(那是「这条会话从手机够不着」才说的),`reveal:false`(没开着的会话开不出键)。
 * 捎话那一路另有 ok:true 的翻法(见 `relay` 里那一支);替她答照锁屏那一路的口径回 ok:false + 那句人话,
 * 她看见的是同一句,不会再去电脑上答第二遍。
 */
export function sessionClosedReply(out: JobResult): { ok: false, status: 200, where: 'desk', why: string, reveal: false } {
  return { ok: false, status: 200, where: 'desk', why: out.why ?? SESSION_CLOSED_FALLBACK, reveal: false }
}

/** 引擎没给那句话时的那一份(真路上一定有:`closed()` 一处写;只为类型上不留 `undefined`)。 */
const SESSION_CLOSED_FALLBACK = '那条会话没开着'

export interface SessionJobsDeps {
  /** 一条引擎(`engine/wire.ts` 造的那一份)。 */
  engine: Engine
  /**
   * 登记处。只用两样:`knownCaps`(界面那几格要同步答案)与 `packageFor`(说清动的是哪一个包)。
   * **能力一处现查** —— 这一层不许再写一份「这份壳会不会 `agent_press`」。
   */
  registry: Pick<AdapterRegistry, 'knownCaps' | 'packageFor'>
  /** 此刻的会话表(叠过「在等你」的那一份:要有 `ask`)。 */
  sessions: () => readonly SessionView[]
  /** 窗口型各家登记表里那几条对话(捎话候选 = 文件型那几条 + 这一份)。 */
  windowSessions?: () => readonly RelaySessionView[]
  /**
   * ★ **只有记录文件、不在会话表里的那几条**(2026-10-13 夜,卡 X):会话记录登记表(`sessionDigest.files()`)里有、
   * `/state.sessions` 里没有的 —— 工作台重启后他点开的旧会话就是这样(卡 W 按 id 找到并登记了,
   * 可捎话那道门只认会话表,照旧回「那条会话不在了」,手机上对话看得见、输入框不摆)。
   * 并进候选池(排在会话表与窗口型之后,同一条以会话表为准);送不送得进去照旧由后面那几道门判。
   */
  recordedSessions?: () => readonly RelaySessionView[]
  /**
   * ★ **CLI 派活起的会话**(2026-10-23 深夜,卡 A 硬门槛前置):命令行那只手派出去的活
   * (`dispatch.hand==='cli'` 且带 session_id)会话不在文件型/窗口型/记录型任何一池,
   * 宿主把它们喂进来,relay 才认得(发送走 cli 通道的续跑,见 engine/adapters/cli.ts)。
   */
  cliSessions?: () => readonly RelaySessionView[]
  /** 这条会话从哪儿开的(waitingService 读会话时记下的)。 */
  entryOf?: (agent: string, sessionId: string) => string | undefined
  /** 这条会话在 Claude 桌面 App 里的编号(`local_…`,深链用)。 */
  hostIdOf?: (agent: string, sessionId: string) => string | undefined
  /** 这一家的窗口是哪个包(登记表里那一条)。 */
  bundleOf?: (agent: string) => string | undefined
  agentName?: (agent: string) => string
  /** 「不用管这条」(waitingService.dismiss)。 */
  dismiss?: (agent: string, sessionId: string) => Promise<boolean>
  /** 捎话时在窗口里认那段对话用的几截原文(`sessionDigest` 那一份)。 */
  markersOf?: (agent: string, sessionId: string) => readonly string[]
  /** 认那个批准弹窗用的几截原话(`waitingService.verdictOf().marks`;不上 /state)。 */
  approvalMarksOf?: (agent: string, sessionId: string) => readonly string[] | undefined
  /** 这条会话归哪一件事(`jobKey.itemOfSession` 一处判)。缺席 = 一律用会话键。 */
  itemOf?: (agent: string, sessionId: string) => string | undefined
  /*
   * ★ **开深链 / 叫台前那两样不在这一层了**(2026-10-02):「去回答」走 `engine.reveal`,
   * 开窗 / 开深链 / 侧栏点一下都在窗口适配器那一层(设计第三节:**开窗只在那一层**),
   * 顺带过上了 `bring_front` 那一样闸(审计第二表第 13 条)。
   */
  /** 这一件的 id 怎么起(新开一条那种没有会话键的);缺席 = 时刻 + 随机。 */
  newId?: () => string
  /**
   * ★ **只读一眼那扇窗主对话区的那几行**(2026-10-13 下午,卡 C)。
   *
   * 替她答完**看结果不看回执**要用它:送之前量一眼、送完再量一眼,提到那个答案的行多出来了
   * 就是真送进去了(判据在 `askLanded.ts`,纯的)。用的是**现成的只读壳 op**(`agent_read`),
   * 一个字都不送、一颗键都不按。
   *
   * 缺席(老宿主 / 用例 / 这一家读不到)= 这一档关着,行为与 2026-10-13 之前一字不差。
   */
  askWindowLines?: (agent: string, sessionId: string) => Promise<readonly string[] | undefined>
  /**
   * 送完一拍一拍读窗之间等多久(只有用例换它:真路上就是 `setTimeout`)。
   * 分寸在 `askLanded.ts` 那三个常量里。
   */
  sleep?: (ms: number) => Promise<void>
}

export function createSessionJobs(deps: SessionJobsDeps): SessionAnswerService {
  const who = (agent: string): string => deps.agentName?.(agent) ?? agent
  const newId = deps.newId ?? (() => `job-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`)
  /** 送完一拍一拍读窗之间的那一等(`unref`:这一等不许拖着进程不退)。 */
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>(resolve => { setTimeout(resolve, ms).unref?.() }))
  /** 这一下是为哪一件事(`jobKey.ts` 一处定法:有卡认领就是那张卡,没有就用会话键)。 */
  const itemOf = (agent: string, sessionId: string): string | undefined => deps.itemOf?.(agent, sessionId)

  /**
   * 这一家此刻会哪几样(**一处现查**:登记处的那一份)。
   * `undefined` = 还没查过 —— 界面上那几格照「查不到」说话(不冒充「行」,也不冒充「不行」)。
   */
  const capsOf = (agent: string): AdapterCapabilities | undefined => deps.registry.knownCaps(agent)

  /** 这条会话只许走哪几只手(终端 / VS Code 里开的只有协议那只;卡 D)。缺席 = 不限。 */
  const viasOf = (agent: string, sessionId: string) => answerViasOf(agent, deps.entryOf?.(agent, sessionId))

  /**
   * ★ **这条会话够得着的那几只手此刻会哪几样**(2026-10-20,卡 D)。与 {@link capsOf} 的差别只在白名单:
   * 终端里那条只算协议那只手会的(窗口那只手会点键、会按停止,可它够不着这一条)。
   * 界面那几格与真动手同一张白名单 —— 不摆一个点下去才说不行的键(D13)。
   */
  const capsFor = (agent: string, sessionId: string): AdapterCapabilities | undefined => {
    const vias = viasOf(agent, sessionId)
    return vias === undefined ? capsOf(agent) : deps.registry.knownCaps(agent, { vias })
  }

  /**
   * ★ **能不能替她按那家的停止键**(`relayReady` 与 `relay` **同一处判据**)。
   *
   * 查不到(还没现查过)时答「试一下」:真按不着时引擎会如实回一句「按不到它的停止键」——
   * 比在这儿先悲观地说「不行」实在(那会让起服务后第一下「打断并发送」白白退回)。
   */
  const canStopNow = (agent: string, sessionId: string): boolean => capsFor(agent, sessionId)?.stop !== false

  const planOf = (agent: string, sessionId: string, kind: 'ask' | 'relay' = 'ask'): AnswerPlan => {
    /*
     * 窗口型各家那几条对话(`window:` 开头的会话 id):`answerPlanOf` 那张表只认家族目录里有深链的那几家,
     * 豆包办公的那一问于是一律「去电脑上答」。登记表认得它的包就走窗口那一路(永不送的那几个包除外)。
     */
    const bundleId = sessionId.startsWith('window:') ? deps.bundleOf?.(agent) : undefined
    if (bundleId !== undefined && !CLIENT_DISPATCH_NEVER.includes(bundleId)) {
      return { route: 'window', bundleId, revealable: true }
    }
    /*
     * ★ **「这一家此刻送不送得进去」不在这儿判**(2026-10-02)。
     *
     * 从前这里问「那只手接上了没有」(`deps.window !== undefined`),后来想改成问
     * `registry.knownCaps(family).send` —— 可那一份是**同步**的缓存,第一拍必然答「还不知道」,
     * 于是起服务后第一次替她答会退成「去电脑上答」,而那一下其实送得进去。
     *
     * 所以这一层只回答**路由**:认不认得出是哪一家、深链是哪条、只许哪几只手(终端 / VS Code 里开的只许协议,卡 D)。
     * **送不送得进去由引擎当场答**(`picksFor` 是现查的),
     * 送不出去时它回 `not_sent` + `unsupported`,这一层照 `deskWhy` 说话 —— 一处判据,不抢答。
     */
    return answerPlanOf(
      agent,
      sessionId,
      deps.entryOf?.(agent, sessionId),
      { window: true },
      deps.hostIdOf?.(agent, sessionId),
      kind,
    )
  }

  /** 送不进去时那句人话(按「一只手都没有」那一份说 —— 去哪儿答跟接没接手无关)。 */
  const deskPlanOf = (agent: string, sessionId: string, kind: 'ask' | 'relay' = 'ask'): AnswerPlan =>
    answerPlanOf(agent, sessionId, deps.entryOf?.(agent, sessionId), { window: false }, deps.hostIdOf?.(agent, sessionId), kind)

  /**
   * ★ **界面上那一格(摆不摆输入框)用这一份**:这一家此刻**送得进话**才说 `window`。
   *
   * 与上面那一份({@link planOf},一律 `window:true`)分开,是因为两件事:
   * - **真要动手**那一下不该抢答「这一家行不行」——引擎现查,它说不行再照 `deskWhy` 说话;
   * - **界面那一格**要悲观:壳没连上时摆一个输入框出来就是摆设,她打了字才被告知送不出去(D13)。
   *   查不到(还没现查过)时也不摆 —— 下一拍能力就现查好了,框自己出现。
   */
  const uiPlanOf = (agent: string, sessionId: string, kind: 'ask' | 'relay' = 'ask'): AnswerPlan =>
    answerPlanOf(agent, sessionId, deps.entryOf?.(agent, sessionId), { window: capsFor(agent, sessionId)?.send === true }, deps.hostIdOf?.(agent, sessionId), kind)

  const deskWhyOf = (agent: string, sessionId: string, kind: 'ask' | 'relay' = 'ask'): string => {
    const plan = deskPlanOf(agent, sessionId, kind)
    return plan.why ?? (kind === 'relay'
      ? `这句话得你到电脑上的 ${who(agent)} 里自己说`
      : `这一问得在电脑上的 ${who(agent)} 里回答`)
  }

  /** 能捎话的那几条会话:文件型 + 窗口型登记表 + 记录文件 + **CLI 派活起的**(2026-10-23 深夜,卡 A 硬门槛前置;宿主从派活账喂,dispatch.hand==='cli' 且带 session_id;撞键按文件型算)。 */
  const relayCandidates = (): readonly RelaySessionView[] => {
    const own: readonly RelaySessionView[] = deps.sessions()
    const windows = deps.windowSessions?.() ?? []
    const recorded = deps.recordedSessions?.() ?? []
    const cli = deps.cliSessions?.() ?? []
    if (windows.length === 0 && recorded.length === 0 && cli.length === 0) return own
    const seen = new Set(own.map(one => `${one.agent}\u0000${one.session_id}`))
    const out = [...own]
    for (const one of [...windows, ...recorded, ...cli]) {
      const key = `${one.agent}\u0000${one.session_id}`
      if (seen.has(key)) continue
      seen.add(key)
      out.push(one)
    }
    return out
  }

  /**
   * ★ **拼一个 `Job`**(一处):这一件事的键、送到哪一段、认那一段用的几截原话。
   * `marks[0]` 按窗口适配器的约定 = 这条对话在侧栏里的名字 / 认它的头一截原话。
   */
  function jobOf(input: {
    agent: string
    sessionId?: string
    kind: Job['kind']
    text: string
    marks?: readonly string[]
    expect: Job['expect']
    package?: string
    /** 她勾了「回了打电话给我」(2026-10-04;只有捎话那一路传,跟着落盘给解锁重送用)。 */
    callOnReply?: boolean
  }): Job {
    const itemId = input.sessionId === undefined ? undefined : itemOf(input.agent, input.sessionId)
    const vias = input.sessionId === undefined ? undefined : viasOf(input.agent, input.sessionId)
    return {
      id: input.sessionId === undefined ? newId() : sessionJobId(input.agent, input.sessionId),
      family: input.agent,
      kind: input.kind,
      target: input.sessionId === undefined ? { kind: 'new' } : { kind: 'session', sessionId: input.sessionId },
      text: input.text,
      ...(input.marks === undefined || input.marks.length === 0 ? {} : { marks: input.marks }),
      expect: input.expect,
      ...(itemId === undefined ? {} : { itemId }),
      ...(input.package === undefined ? {} : { package: input.package }),
      ...(input.callOnReply === true ? { callOnReply: true as const } : {}),
      // ★ 终端 / VS Code 里开的那几条只许协议那只手(卡 D):引擎的送 / 读 / 去回答都按它挑通道。
      ...(vias === undefined ? {} : { vias }),
      // ★ 捎话是她亲口 / 亲手交代的(手机输入框、电话里点名;卡 Y):闸的「收场了就不再动那一家」对它不拦。
      ...(input.kind === 'relay' ? { by: 'user' as const } : {}),
    }
  }

  // ───────────── 捎话那道门(判断一个字没改;`relay` 与 `relayReady` 同一份) ─────────────

  type RelayGate =
    | { ok: true, view: RelaySessionView, markers: readonly string[], deskWhy: string, revealable: boolean }
    | { ok: false, status: 404, why: string }
    | { ok: false, status: 200, why: string, reveal: boolean }

  const relayGate = (agent: string, sessionId: string): RelayGate => {
    const view = relayCandidates().find(one => one.agent === agent && one.session_id === sessionId)
    // 那条会话不在了(关掉了 / 认不出来了)—— 三种「捎不到」的第一种。
    if (view === undefined) return { ok: false, status: 404, why: '那条会话不在了(关掉了,或者这会儿认不出来)' }
    const deskPlan = deskPlanOf(agent, sessionId, 'relay')
    const deskWhy = deskWhyOf(agent, sessionId, 'relay')
    // 它那边弹了个框等她点:打字送不进去(同 answer 那一条)。
    if (mustClick(view.ask)) return { ok: false, status: 200, why: `${deskWhy}${CLICK_THERE}`, reveal: deskPlan.revealable }
    const plan = planOf(agent, sessionId, 'relay')
    /*
     * ★ **窗口型各家的一条已有对话**(`window:<hash>`)。这几家没有会话记录文件、也没有「开到某一段」的深链 ——
     * 切到它靠侧栏里那一行标题(`agent_pick`,在窗口适配器里)。2026-10-01 卡 AW 起:标题读不到 / 太短 /
     * 旧壳点不了**都不再是拒发的理由**;这里只剩一道安全门:**认不出是哪一个包**(连往哪扇窗送都不知道)。
     */
    if (sessionId.startsWith('window:')) {
      if (plan.bundleId === undefined) return { ok: false, status: 200, why: deskWhy, reveal: deskPlan.revealable }
      const title = view.title?.trim()
      const marker = title === undefined || title === '' ? undefined : pickMarkerOf(title)
      return {
        ok: true,
        view,
        // `marks[0]` = 侧栏里那一行的名字(标题全文);认它的那一截排在后面。
        markers: [...(title === undefined || title === '' ? [] : [title]), ...(marker === undefined ? [] : [marker])],
        deskWhy,
        revealable: true,
      }
    }
    /*
     * ★ **门 3 不再按「路由是不是 window」先拒**(2026-10-20,卡 D)。从前这里见 `route !== 'window'` 就回 deskWhy ——
     * 终端 / VS Code 里开的 Claude、派活起的 Codex 都在这儿被拒,**引擎一次都没被问到**,而两张探针证明协议那只手够得着。
     * 现在一律进引擎:哪只手够得着这一条由 `picksFor` 现查(只许哪几只手跟着 `Job.vias` 走),
     * 一只都够不着时引擎回 `not_sent` + `unsupported`,`relay` 照 deskWhy 说话 —— 与从前那一句一字不差。
     * 界面那一格(`relayReady`)在进这道门之前已经按同一张白名单问过「此刻送不送得进」。
     */
    const title = view.title?.trim()
    const markers = relayMarkersOf(view, deps.markersOf?.(agent, sessionId))
    return {
      ok: true,
      view,
      markers: [...(title === undefined || title === '' ? [] : [title]), ...markers],
      deskWhy,
      revealable: plan.revealable,
    }
  }

  // ───────────── 权限弹窗那一问(读到的那几颗键记一下,/state 那一格据此说话) ─────────────

  /** 读过的那几颗键(或者没读成的那句话),按「哪条会话 + 这一问的时刻 + 哪个子任务」记;那一问换了就不算数。 */
  const approvalSeen = new Map<string, { since?: string, child?: string, keys?: readonly ApprovalKey[], why?: string }>()
  const seenKey = (agent: string, sessionId: string): string => `${agent}\u0000${sessionId}`
  const seenOf = (agent: string, sessionId: string, ask: AskOrigin | undefined) => {
    const one = approvalSeen.get(seenKey(agent, sessionId))
    // 时刻缺席的一边(那家没说什么时候弹的)不拿来比;子任务必须是同一个。
    const sameSince = one?.since === undefined || ask?.since === undefined || one.since === ask.since
    return one !== undefined && sameSince && one.child === ask?.child?.id ? one : undefined
  }
  const remember = (agent: string, sessionId: string, ask: AskOrigin, got: { keys?: readonly ApprovalKey[], why?: string }) => {
    approvalSeen.delete(seenKey(agent, sessionId))
    approvalSeen.set(seenKey(agent, sessionId), {
      ...(ask.since === undefined ? {} : { since: ask.since }),
      ...(ask.child === undefined ? {} : { child: ask.child.id }),
      ...got,
    })
    while (approvalSeen.size > 64) approvalSeen.delete(approvalSeen.keys().next().value as string)
  }

  /** 认那个弹窗用的几截原话:这一步的命令 / 文件(调用方给)+ 那一步的说明(`quote`)。不到 4 个字的认不准,不用。 */
  const approvalMarks = (agent: string, sessionId: string, quote: string | undefined): readonly string[] => {
    const out: string[] = []
    for (const raw of [...(deps.approvalMarksOf?.(agent, sessionId) ?? []), quote]) {
      const first = raw?.split(/\r?\n/).map(one => one.trim()).find(one => one !== '')
      if (first === undefined || Array.from(first).length < 4 || out.includes(first)) continue
      out.push(first)
    }
    return out.slice(0, 4)
  }

  /**
   * 这一问的批准弹窗**这一路能不能替她看 / 按**:这一家此刻会「看按权限弹框」那一样 + 有原话可认。
   * 缺一样就回 undefined —— 照旧「到电脑上点」,不假装。
   */
  const approvalGate = (agent: string, sessionId: string, quote: string | undefined) => {
    /*
     * 两道门:
     * ① 这一家此刻**会不会看 / 按那个权限弹框**(`capabilities().approve` 现查;旧壳就是不会)——
     *    与界面那一格(`permissionView`)**同一处判据**,两处判得不一样就会摆出一颗
     *    点下去说「到电脑上点」的键(D13);
     * ② 有没有一截原话能用来认出那个弹框(没有的话壳一处都不敢动)。
     * 过了这两道**不等于一定按得上** —— 引擎 / 适配器现查,按不上会如实说。
     */
    if (capsFor(agent, sessionId)?.approve !== true) return undefined
    const marks = approvalMarks(agent, sessionId, quote)
    if (marks.length === 0) return undefined
    return { marks }
  }

  /**
   * 先只读一眼(不动她的窗口);没认出再开到前面读一次。读到哪一块、给哪几颗由 `pickApprovalPanel` 定。
   * 读那两下都在窗口适配器里(`Adapter.readApproval`),这里只挑那一块。
   */
  const readApprovalPanel = async (agent: string, sessionId: string, marks: readonly string[]) => {
    const job = jobOf({ agent, sessionId, kind: 'press', text: '', marks, expect: 'none' })
    /*
     * **一次调用**:先只读一眼(不动她的窗口),读不到再开到前面读一次 —— 那两步在适配器里面。
     * 从前这两步在这一层连调两回,而那只手每一回都过一次 `approval_read` 的闸(间隔 1 秒)——
     * 两下只隔几毫秒,第二回必然被自己拦下,于是「开到前面再读」那条路其实从没走通过。
     */
    const got = await deps.engine.readApproval(job, { active: true })
    if (got.panels.length === 0) {
      return { ok: false as const, why: got.why ?? '没在它窗口里找到那个权限弹框' }
    }
    return pickApprovalPanel(got.panels)
  }

  /** 权限弹窗那一问在 /state 上那一格(不摆输入框;读得了 / 读到的那几颗 / 上次没读成的那句话)。 */
  const permissionView = (view: SessionView, ask: AskOrigin): NonNullable<NonNullable<SessionView['ask']>['permission']> => {
    /*
     * 界面那一格**悲观**:查不到这一家会不会看那个弹框时就不摆那两颗键 —— 摆了点下去说「到电脑上点」
     * 正是 D13 的「点了没反应」。下一拍能力就现查好了,键自己出现。
     */
    if (approvalGate(view.agent, view.session_id, ask.quote ?? view.ask?.quote) === undefined) return {}
    const seen = seenOf(view.agent, view.session_id, ask)
    if (seen?.keys !== undefined) return { keys: seen.keys }
    if (seen?.why !== undefined) return { why: seen.why }
    return { readable: true }
  }

  /** 打字撞上权限弹窗时那一句(界面据此切到按键)。 */
  const permissionTyped = (agent: string, sessionId: string, quote: string | undefined, deskWhy: string): string =>
    approvalGate(agent, sessionId, quote) === undefined
      ? `这是权限弹窗,打字批不了它 —— ${deskWhy}${CLICK_THERE}`
      : '这是权限弹窗,打字批不了它 —— 点「批准」或「拒绝」那颗键'

  /**
   * **替她按那个批准弹窗上的一颗**(卡 AP)。`wanted` 是她点的那颗键名,或者她说的意思
   * (电话里「批准 / 可以 / 拒绝」)。按之前**重新读一次**(位置以这一次为准),只按「批准一次 / 拒绝」;
   * 按完那颗键没了才 `confirmed`(核实在窗口适配器里)。
   */
  const pressApprovalNow = async (view: SessionView, wanted: string): Promise<PressResult> => {
    const ask = view.ask!
    const agent = view.agent
    const deskPlan = deskPlanOf(agent, view.session_id)
    const deskWhy = deskWhyOf(agent, view.session_id)
    const broad = (label: string): PressResult => ({ ok: false, status: 400, error: `「${label}」会放宽这条会话往后的权限,工作台不替你按 —— 要放宽请在电脑上自己按` })
    if (approvalKeyKind(wanted) === 'broad') return broad(wanted)
    const gate = approvalGate(agent, view.session_id, ask.quote)
    if (gate === undefined) return { ok: false, status: 200, where: 'desk', why: `${deskWhy}${CLICK_THERE}`, reveal: deskPlan.revealable }
    const picked = await readApprovalPanel(agent, view.session_id, gate.marks)
    if (!picked.ok) {
      remember(agent, view.session_id, ask, { why: picked.why })
      return { ok: false, status: 200, where: 'desk', why: `${deskWhy}(${picked.why})`, reveal: deskPlan.revealable }
    }
    remember(agent, view.session_id, ask, { keys: picked.keys })
    const key = resolveApprovalKey(picked.keys, wanted)
    if (key === undefined) {
      if (picked.held.includes(wanted)) return broad(wanted)
      return { ok: false, status: 400, error: `「${[...wanted].slice(0, 20).join('')}」不是那个弹窗上的键,也听不出是批准还是拒绝,一颗都没按` }
    }
    const out = await deps.engine.run(jobOf({
      agent, sessionId: view.session_id, kind: 'press', text: key.label, marks: gate.marks, expect: 'none',
    }))
    if (out.delivered === 'not_sent') {
      // 电脑锁着屏:那颗键一下都不按(2026-10-03;批准这件事更不许隔半小时再按)。
      if (out.screenLocked === true) return screenLockedReply(out)
      if (out.sessionClosed === true) return sessionClosedReply(out)
      return { ok: false, status: 200, where: 'desk', why: `${deskWhy}(${out.why ?? '那颗键没按上'})`, reveal: deskPlan.revealable }
    }
    if (out.delivered === 'confirmed') {
      approvalSeen.delete(seenKey(agent, view.session_id))
      return { ok: true, label: key.label, confirmed: true, approved: key.does }
    }
    return {
      ok: true,
      label: key.label,
      confirmed: false,
      approved: key.does,
      note: out.why ?? `按了「${key.label}」,可那个弹窗还在 —— 没按上,去电脑上的 ${who(agent)} 看一眼`,
    }
  }

  /**
   * ★ **替她答完,它窗口上真有动静了没有**(2026-10-13 下午卡 C;傍晚卡 J 改成轮询 + 认面板收起来)。
   *
   * 壳的回执(面板收没收 / 框空没空 / 「送后才出现」)在豆包普通包上**一档都成立不了**
   * (理由与两条判据都写在 `askLanded.ts` 文件头),所以这一下只看结果。
   *
   * **一秒一拍地读**:16:33 真机那一通,豆包的回话要 2–5 秒才冒出来,她那句气泡也可能还没画 ——
   * 送完立刻读一次就下结论,一定判成「没办成」。任一拍成立就停,最多 {@link ASK_LANDED_POLL_TRIES} 拍、
   * 总共不超过 {@link ASK_LANDED_POLL_BUDGET_MS}(电话里她在听着)。
   *
   * **底子没量到就一拍都不读**:那时两条判据都判不出哪一行是新的 / 面板原来在不在,
   * 读六拍也只能回同一句「判不出」,白等 6 秒。
   * 这一档没接上(`askWindowLines` 缺席)回 `undefined` —— 调用方照旧按回执说话。
   */
  const landedInWindow = async (
    view: SessionView,
    answer: string,
    before: readonly string[] | undefined,
    panel: readonly string[],
  ): Promise<AskLandedVerdict | undefined> => {
    if (deps.askWindowLines === undefined) return undefined
    const judge = (after: readonly string[] | undefined): AskLandedVerdict => askLanded({
      answer,
      ...(panel.length === 0 ? {} : { panel }),
      ...(before === undefined ? {} : { before }),
      ...(after === undefined ? {} : { after }),
    })
    if (before === undefined) return judge(undefined)
    const since = Date.now()
    let last = judge(undefined)
    for (let tries = 0; tries < ASK_LANDED_POLL_TRIES; tries += 1) {
      if (tries > 0) {
        if (Date.now() - since >= ASK_LANDED_POLL_BUDGET_MS) return last
        await sleep(ASK_LANDED_POLL_MS)
      }
      last = judge(await deps.askWindowLines(view.agent, view.session_id).catch(() => undefined))
      if (last.landed) return last
    }
    return last
  }

  /** 点 / 送之前先量一眼(量不到就缺席 —— 那时判不出哪一行是新的,照旧按回执说话)。 */
  const linesNow = async (view: SessionView): Promise<readonly string[] | undefined> => {
    if (deps.askWindowLines === undefined) return undefined
    return await deps.askWindowLines(view.agent, view.session_id).catch(() => undefined)
  }

  /**
   * **替她把她自己那句话写进那家提问面板**(卡 AT)。她那句原文**一字不改**。
   * 核实两条(那个面板没了 + 窗口里出现了她那句)在窗口适配器里,这里只翻结局。
   */
  const writeAskNow = async (agent: string, sessionId: string, text: string): Promise<WriteAskResult> => {
    const said = text.trim()
    if (said === '') return { ok: false, status: 400, error: '要写进去的话是空的' }
    const view = deps.sessions().find(one => one.agent === agent && one.session_id === sessionId)
    if (view === undefined) return { ok: false, status: 404, error: '没有这条会话' }
    const ask = view.ask
    if (ask === undefined) return { ok: false, status: 409, error: '这一问已经不在了(那边已经往下走了)' }
    const deskPlan = deskPlanOf(agent, sessionId)
    const deskWhy = deskWhyOf(agent, sessionId)
    const out = await deps.engine.run(jobOf({
      agent, sessionId, kind: 'write_ask', text: said, marks: askPanelMarksOf(ask), expect: 'ack',
    }))
    if (out.delivered === 'not_sent') {
      // 电脑锁着屏(2026-10-03):那一句人话原样说,不接「到电脑上点」(见 {@link screenLockedReply})。
      if (out.screenLocked === true) return screenLockedReply(out)
      if (out.sessionClosed === true) return sessionClosedReply(out)
      // 这一家没有「往那个提问面板里写字」这一样(旧壳 / 没认准的那几个包)→ 照旧那句「到电脑上点」。
      if (out.unsupported === true) {
        return { ok: false, status: 200, where: 'desk', why: `${deskWhy}${CLICK_THERE}`, reveal: deskPlan.revealable }
      }
      return { ok: false, status: 200, where: 'desk', why: `${deskWhy}(${out.why ?? '那一句没写进去'})`, reveal: deskPlan.revealable }
    }
    return out.delivered === 'confirmed'
      ? { ok: true, text: said, confirmed: true }
      : {
          ok: true,
          text: said,
          confirmed: false,
          note: out.why ?? `把「${said}」写进去按了发送,但没看到它收下 —— 去电脑上的 ${who(agent)} 看一眼`,
        }
  }

  return {
    replyOf(view, ask) {
      const click = mustClick(ask)
      const plan = click ? deskPlanOf(view.agent, view.session_id) : uiPlanOf(view.agent, view.session_id)
      const caps = capsFor(view.agent, view.session_id)
      /**
       * **它弹的那个框上那几项,这会儿能不能替她点**(卡 WQ)。判据**只有一处**:
       * 这一家此刻会不会「点它明写的那一项」(`capabilities().press` 现查)。
       * 两处判得不一样的话,界面上摆着能点的键、点下去却说「到电脑上点」—— 那正是 D13 的「点了没反应」。
       */
      const canPress = click && caps?.press === true
      /** **她自己那句话也送得进去**(卡 AT):同一处判据的 `writeAsk` 那一格。 */
      const canWrite = click && caps?.writeAsk === true
      /**
       * ★ **权限弹窗那一问**(卡 AP):打字批不了它,界面不摆输入框、不摆选项;
       * 挂 `permission` 那一格(读得了 / 读到的那几颗键)。`where` 照旧带着,是读不了时那句退路。
       */
      if (ask !== undefined && !canWrite && isPermissionAsk({ kind: ask.kind ?? view.ask?.kind ?? 'choose', by: ask.by, ...(ask.child === undefined ? {} : { child: ask.child }) })) {
        return {
          reply: plan.route,
          ...(plan.route === 'desk' && plan.why !== undefined ? { where: `${plan.why}${CLICK_THERE}` } : {}),
          ...(plan.revealable ? { reveal: true as const } : {}),
          permission: permissionView(view, ask),
        }
      }
      return {
        reply: plan.route,
        ...(plan.route === 'desk' && plan.why !== undefined ? { where: click ? `${plan.why}${CLICK_THERE}` : plan.why } : {}),
        ...(plan.revealable ? { reveal: true as const } : {}),
        ...(canPress ? { press: true as const } : {}),
        ...(canWrite ? { write: true as const } : {}),
      }
    },

    async press(agent, sessionId, label) {
      const wanted = label.trim()
      if (wanted === '') return { ok: false, status: 400, error: '没说要点哪一项' }
      const view = deps.sessions().find(one => one.agent === agent && one.session_id === sessionId)
      if (view === undefined) return { ok: false, status: 404, error: '没有这条会话' }
      const ask = view.ask
      if (ask === undefined) return { ok: false, status: 409, error: '这一问已经不在了(那边已经往下走了)' }
      // ★ 权限弹窗(卡 AP):按的是弹窗上的「批准一次 / 拒绝」,不是它明写的选项。
      if (isPermissionAsk(ask) && (ask.options ?? []).length === 0) return await pressApprovalNow(view, wanted)
      const options = ask.options ?? []
      /**
       * ★ **送去按的是原字,显示照旧可短**(2026-10-04,卡 `claude/three-small-1004`;
       * 出处 `docs/交接-1004-待确认带上下文.md` 待拍板 ②,统筹已定修)。
       *
       * 出门那一道(`waitingForYou.questionView`)把选项 `label` 截到 40 字 + 「…」,
       * 而壳的 `agent_press` 是**按标签在它窗口里找那一项**(整行归一化之后相等,见
       * `AgentWindowPolicy.matchOptionLabel`)—— 带「…」的那一行它窗口里压根没有,
       * 于是超过 40 字的选项一找就找不着(`found:false`)。
       * 卡 `claude/ask-with-context` 之后 `ask.full.options` 里有原字,这里按下标配回去。
       *
       * **只在两份条数一样时才配对**(同界面那一处的规矩:条数不一样宁可按短的那一份,
       * 不猜哪一颗对哪一颗);`full` 缺席的那几条(窗口读出来的、按内容判出来的)一个字不变。
       */
      const fullOptions = ask.full?.options
      const originalAt = (index: number): string | undefined => {
        if (fullOptions === undefined || fullOptions.length !== options.length) return undefined
        const original = fullOptions[index]?.label.trim()
        return original === undefined || original === '' ? undefined : original
      }
      /**
       * **只点它原样写出来的那一项**:认不准就不点(替她挑一个比点不着糟得多)。
       * 两份字都认 —— 老手机包回的是界面上那一份(短的),新客户端可能直接回原字。
       */
      const at = (() => {
        const exact = options.findIndex(one => one.label === wanted)
        if (exact !== -1) return exact
        const trimmed = options.findIndex(one => one.label.trim() === wanted)
        if (trimmed !== -1) return trimmed
        return options.findIndex((_one, index) => originalAt(index) === wanted)
      })()
      const option = at === -1 ? undefined : options[at]
      if (option === undefined || at === -1) return { ok: false, status: 400, error: `「${[...wanted].slice(0, 20).join('')}」不是它给的选项` }
      /** 真按下去 / 真送进对话的那一份字(原字优先);说给她听的照旧是界面上那一份。 */
      const pressing = originalAt(at) ?? option.label
      const deskPlan = deskPlanOf(agent, sessionId)
      const deskWhy = deskWhyOf(agent, sessionId)
      /*
       * ★ **点之前量一眼它窗口里那几行**(2026-10-13 下午,卡 C):底子只有这一刻拿得到。
       * 点完 / 打字回退之后一秒一拍地再量,**冒出新行**或者**那个提问面板整块没了**才算真办成 ——
       * 壳那三档在豆包普通包上一档都成立不了(两条判据见 `askLanded.ts` 文件头)。
       *
       * 只给**走窗口那一条**的会话读(协议那两条压根不靠窗口,读了也白读、还白等一个来回)。
       */
      const pressPlan = planOf(agent, sessionId)
      const linesBefore = pressPlan.route === 'window' && pressPlan.vias === undefined ? await linesNow(view) : undefined
      /**
       * 面板那几行的记号(选项**原字** + 它那一句原话):送之前画着、送完一行不剩 = 那一问答掉了。
       * 用原字是因为界面那一份选项截到 40 字 + 「…」,窗口里画的是整行(同 `marks` 那一处的理由)。
       */
      const panelMarks = askPanelMarksOf({
        ...ask,
        options: options.map((one, index) => ({ ...one, label: originalAt(index) ?? one.label })),
      })
      const out = await deps.engine.run(jobOf({
        agent, sessionId, kind: 'press', text: pressing, marks: options.map((one, index) => originalAt(index) ?? one.label), expect: 'none',
      }))
      if (out.delivered === 'not_sent') {
        /*
         * ★ 电脑锁着屏(2026-10-03):**点键这一下不排队**(隔半小时解锁再按,那个框早就不在了,
         * 按下去等于按在别的东西上 —— 见 `engine.LOCK_QUEUE_KINDS`),如实说,她解锁后再点一次。
         * **不走下面那条「当一句话发进对话」的替代路**:那条一样撞在锁屏上。
         */
        if (out.screenLocked === true) return screenLockedReply(out)
        if (out.sessionClosed === true) return sessionClosedReply(out)
        /*
         * 这一家没有「替她点一下」这一样(旧壳 / 自绘界面 / 协议那条点不了)→ 照旧那句「到电脑上点」。
         * **这一下不走「当一句话发进对话」那条替代的路**:框还在,往对话里再发一句会重复答。
         */
        if (out.unsupported === true) {
          return { ok: false, status: 200, where: 'desk', why: `${deskWhy}${CLICK_THERE}`, reveal: deskPlan.revealable }
        }
        /*
         * ★ **框已经不在了 → 把她点的那一项原样当一句话送进这条对话、按发送**(2026-09-28 20:5x 真机)。
         * Codex 的 `request_user_input_async` 问完这一轮就收工,桌面 App 里那个框随之收掉(不是我们点掉的);
         * 这时它照样收得到对话里的一句话。维护者:「是把我的文字复制过去发送」。
         *
         * **闸拦下的那一下不走这条**(换一条路办同一件事也是动她的电脑):引擎拦下时 `why` 是闸那句人话,
         * 判据在 `out.blocked` —— 旧代码靠 `found:false` 判,漏进这条路等于没拦(卡 AG2)。
         */
        if (out.blocked !== true) {
          // 送进对话的也是**原字**(带「…」的那一行是给她看的,不是她的答复)。
          const sent = await sendIntoConversation(view, pressing)
          if (sent.delivered !== 'not_sent') {
            if (sent.delivered === 'confirmed') {
              return { ok: true, label: option.label, confirmed: true, note: `那个框已经收掉了,把「${option.label}」当一句话发进去了` }
            }
            /*
             * ★ **打字这一送壳说不准 → 再读一次窗口按结果判**(2026-10-13 下午,卡 C;
             * 14:17 真机那一通:壳说「没点上 / 回执尚未确认」,而豆包已经收到并回了)。
             */
            const landed = await landedInWindow(view, pressing, linesBefore, panelMarks)
            if (landed?.landed === true) {
              return { ok: true, label: option.label, confirmed: true, note: `那一项没点上,把「${option.label}」当一句话发进去了 —— ${landed.why}` }
            }
            return {
              ok: true,
              label: option.label,
              confirmed: false,
              note: landed === undefined
                ? sent.why ?? `把「${option.label}」当一句话发进去了,但没看到它收下`
                : `把「${option.label}」当一句话发进去了,可${landed.why}`,
            }
          }
        }
        return { ok: false, status: 200, where: 'desk', why: `${deskWhy}(${out.why ?? '那一项没点上'})`, reveal: deskPlan.revealable }
      }
      /** ⑤ 核实:**点完那一问没了才算答上了**(核实在窗口适配器里)。 */
      if (out.delivered === 'confirmed') return { ok: true, label: option.label, confirmed: true }
      /*
       * ★ 点出去了、壳说那个面板还在(2026-10-13 下午,卡 C):再读一次窗口 ——
       * 它那边冒出了提到这一项的新行就是真选上了(面板画得慢 / 收不掉的那几家)。
       */
      const landedAfterPress = await landedInWindow(view, pressing, linesBefore, panelMarks)
      if (landedAfterPress?.landed === true) {
        return { ok: true, label: option.label, confirmed: true, note: `点了「${option.label}」—— ${landedAfterPress.why}` }
      }
      return {
        ok: true,
        label: option.label,
        confirmed: false,
        note: landedAfterPress === undefined
          ? out.why ?? `点了「${option.label}」,但没看到它收下 —— 去电脑上的 ${who(agent)} 看一眼`
          : `点了「${option.label}」,可${landedAfterPress.why} —— 去电脑上的 ${who(agent)} 看一眼`,
      }
    },

    writeAsk: writeAskNow,

    async answer(agent, sessionId, text) {
      const said = text.trim()
      if (said === '') return { ok: false, status: 400, error: '要送回去的话是空的' }
      const view = deps.sessions().find(one => one.agent === agent && one.session_id === sessionId)
      if (view === undefined) return { ok: false, status: 404, error: '没有这条会话' }
      if (view.ask === undefined) return { ok: false, status: 409, error: '这一问已经不在了(那边已经往下走了)' }
      const deskPlan = deskPlanOf(agent, sessionId)
      const deskWhy = deskWhyOf(agent, sessionId)
      /**
       * ★ **弹框那一问:她自己那句话写进面板里那个框**(卡 AT)。这条路通了就走它
       * (`writeAskNow` 那道门自己会退回同一句话:认不出面板 / 这一家没这一样时行为一字不变)。
       */
      if (mustClick(view.ask)) {
        if (capsFor(agent, sessionId)?.writeAsk === true) {
          const wrote = await writeAskNow(agent, sessionId, said)
          if (wrote.ok) return { ok: true, route: 'window', confirmed: wrote.confirmed, ...(wrote.note === undefined ? {} : { note: wrote.note }) }
          if (wrote.status === 200) return { ok: false, status: 200, where: 'desk', why: wrote.why, reveal: wrote.reveal }
          return { ok: false, status: wrote.status, error: wrote.error }
        }
        /*
         * ★ 2026-10-01(卡 AP):权限弹窗那一类**不往对话里打字**(打一句「可以」批不了它弹的权限框)——
         * 回包说清这是权限弹窗,界面据此切到「批准 / 拒绝」那几颗键。
         */
        if (view.ask.kind === 'approve') {
          return {
            ok: false,
            status: 200,
            where: 'desk',
            why: permissionTyped(agent, sessionId, view.ask.quote, deskWhy),
            reveal: deskPlan.revealable,
            permission: true,
          }
        }
        /*
         * ★ 写不进面板那一格时:**把她那句原样送进这条对话、按发送**(2026-09-28 20:1x,维护者:
         * 「不是替我写一句啊,是把我的文字复制过去发送」),不再退回「去电脑上点」。
         */
      }
      /*
       * ★ **与捎话那道门同一处判据**(2026-10-20,卡 D):不再按「路由是不是 window」先拒。
       * 从前这里说「终端 / VS Code 里开的打不进字,这一道不能交给引擎 —— 引擎不知道这一条在终端里」;
       * 现在引擎知道了:那几条的 `Job.vias` 只许协议那只手(socket / `thread/resume`),窗口那只手不接。
       * 一只手都够不着时引擎回 `unsupported`,下面照 deskWhy 说话,与从前一字不差。
       */
      const out = await sendIntoConversation(view, said)
      if (out.delivered === 'not_sent') {
        /*
         * ★ 电脑锁着屏(2026-10-03,卡「锁屏时窗口型的家送不进」):**这就是 09:04 那一回**
         * (她在手机「等你确认」里给 Kimi 答了一句,电脑锁着屏,那句话就那么没了)。
         * 现在:引擎已经把这一件排进了队,这里只把那句实话原样交出去。
         */
        if (out.screenLocked === true) return screenLockedReply(out)
        if (out.sessionClosed === true) return sessionClosedReply(out)
        /*
         * 这一家**一条能送话的通道都没有**(壳没连上 / 没装 / 这一样它做不了)→ 照旧那句干净的人话
         * (「这一问得在电脑上的 Claude 里回答」),与接手之前一字不差 —— 不把引擎那句解释接在后面。
         * 真动过手才失败的那几种,把壳那句原话接上去(她要看的是哪一步断的)。
         * 「去回答」摆不摆两种都只看这条会话调不调得到前面(终端 / VS Code 里那几条调不到),不看这一下怎么断的。
         */
        if (out.unsupported === true) {
          return { ok: false, status: 200, where: 'desk', why: deskWhy, reveal: deskPlan.revealable }
        }
        return { ok: false, status: 200, where: 'desk', why: `${deskWhy}(${out.why ?? '那句话没发出去'})`, reveal: deskPlan.revealable }
      }
      /*
       * ★ **替她按掉了她窗口上那层框 → 一定说一句**(卡 DP;审计第二表第 5 条收成一份:
       * 从前只有派活那一处说,答 / 捎话压根不读那一格)。替她按了键就不许做完不说。
       */
      const told = [out.modalClosed, out.why].filter((one): one is string => one !== undefined && one !== '')
      return out.delivered === 'confirmed'
        ? { ok: true, route: 'window', confirmed: true, ...(out.modalClosed === undefined ? {} : { note: out.modalClosed }) }
        : { ok: true, route: 'window', confirmed: false, ...(told.length === 0 ? {} : { note: told.join(';') }) }
    },

    async approvalRead(agent, sessionId) {
      const view = deps.sessions().find(one => one.agent === agent && one.session_id === sessionId)
      if (view === undefined) return { ok: false, status: 404, error: '没有这条会话' }
      const ask = view.ask
      if (ask === undefined) return { ok: false, status: 409, error: '这一问已经不在了(那边已经往下走了)' }
      if (!isPermissionAsk(ask)) return { ok: false, status: 409, error: '这一问不是权限弹窗' }
      const deskPlan = deskPlanOf(agent, sessionId)
      const deskWhy = deskWhyOf(agent, sessionId)
      const gate = approvalGate(agent, sessionId, ask.quote)
      if (gate === undefined) return { ok: false, status: 200, where: 'desk', why: `${deskWhy}${CLICK_THERE}`, reveal: deskPlan.revealable }
      const picked = await readApprovalPanel(agent, sessionId, gate.marks)
      if (!picked.ok) {
        remember(agent, sessionId, ask, { why: picked.why })
        return { ok: false, status: 200, where: 'desk', why: `${deskWhy}(${picked.why})`, reveal: deskPlan.revealable }
      }
      remember(agent, sessionId, ask, { keys: picked.keys })
      return { ok: true, keys: picked.keys, held: picked.held }
    },

    relayReady(agent, sessionId) {
      /*
       * ★ CLI 来源的非 Kimi 会话:能力口直接说不能续(2026-10-24 Minor②)——cli 适配器的续说支
       * 只接了 Kimi(t-b34 Kimi 最小支;Claude/Codex 续说仍 unsupported),与其让它显示「能续」、
       * 发送那一刻才 unsupported,不如这道门就 none+why。只认 CLI 池里来的(文件型/窗口型那几家
       * 既有来源一字不误伤)。
       */
      const fromCliPool = agent !== 'kimi'
        && (deps.sessions() as readonly { agent: string, session_id: string }[]).every(one => !(one.agent === agent && one.session_id === sessionId))
        && (deps.windowSessions?.() ?? [] as readonly { agent: string, session_id: string }[]).every(one => !(one.agent === agent && one.session_id === sessionId))
        && (deps.recordedSessions?.() ?? [] as readonly { agent: string, session_id: string }[]).every(one => !(one.agent === agent && one.session_id === sessionId))
        && (deps.cliSessions?.() ?? [] as readonly { agent: string, session_id: string }[]).some(one => one.agent === agent && one.session_id === sessionId)
      if (fromCliPool) {
        return { can: false, why: `${who(agent)} 这条是命令行派活起的会话:这一家这会儿还没有续说这条路(归 CLI 续跑核验那一张卡)` }
      }
      // 这一问回答的就是「卡片下面摆不摆输入框」—— 送不进话就不摆(同 `replyOf` 那一格)。
      if (capsFor(agent, sessionId)?.send !== true) {
        return { can: false, why: deskWhyOf(agent, sessionId, 'relay'), reveal: deskPlanOf(agent, sessionId, 'relay').revealable }
      }
      const gate = relayGate(agent, sessionId)
      if (!gate.ok) return { can: false, why: gate.why, ...(gate.status === 200 && gate.reveal ? { reveal: true } : {}) }
      const running = isRunning(gate.view)
      const move = relayMoveOf({
        running,
        intent: 'interrupt',
        kind: relayKindOf(sessionId),
        canStop: canStopNow(agent, sessionId),
      })
      return {
        can: true,
        running,
        interrupt: move.kind === 'stop_then_send' || move.kind === 'send'
          ? { can: true }
          : { can: false, ...(move.kind === 'refuse' || move.kind === 'wait' ? { why: move.why } : {}) },
      }
    },

    async relay(agent, sessionId, text, opts) {
      const said = text.trim()
      if (said === '') return { ok: false, status: 400, error: '要捎的话是空的' }
      const gate = relayGate(agent, sessionId)
      if (!gate.ok) {
        return gate.status === 404
          ? { ok: false, status: 404, error: gate.why }
          : { ok: false, status: 200, where: 'desk', why: gate.why, reveal: gate.reveal }
      }
      const { view, markers, deskWhy } = gate
      // 读回话认她那句原话本身(前缀拿掉了);原话认不出来(空)才退回老记号。
      const mark = relayReadMark(said) || relayMark(sessionId)
      /** ★ **这一下该怎么送**(卡 WR):补一句 / 排进去 / 先按停止键再送 / 如实不做。判断在 `relayMove.ts`。 */
      const move = relayMoveOf({
        running: isRunning(view),
        intent: opts?.interrupt === true ? 'interrupt' : 'append',
        kind: relayKindOf(sessionId),
        canStop: canStopNow(agent, sessionId),
      })
      if (move.kind === 'refuse' || move.kind === 'wait') {
        return { ok: false, status: 200, where: 'desk', why: `${deskWhy}(${move.why})`, reveal: gate.revealable }
      }
      /**
       * 「打断再发」:**先按那家的停止键,按停了才送**(两条 `Job`、两次过闸 —— 交接「引擎核心」第四节)。
       * 按不着 / 认不出那颗键 → 一个字都不打,如实说是哪一步没成(**不许假装打断**)。
       */
      let stopped: true | undefined
      if (move.kind === 'stop_then_send') {
        const halt = await deps.engine.run(jobOf({ agent, sessionId, kind: 'stop', text: '', marks: markers, expect: 'none' }))
        // 电脑锁着屏:按不到它的停止键,**一个字也不往里说**(不许假装打断);2026-10-03。
        if (halt.screenLocked === true) return screenLockedReply(halt)
        if (halt.sessionClosed === true) return sessionClosedReply(halt)
        if (halt.delivered === 'not_sent') {
          return { ok: false, status: 200, where: 'desk', why: `${deskWhy}(${halt.why ?? '按不到它的停止键'} —— 没打断,也没替你说那句话)`, reveal: gate.revealable }
        }
        if (halt.delivered !== 'confirmed') {
          return { ok: false, status: 200, where: 'desk', why: `${deskWhy}(按了它的停止键,可它还在跑 —— 没敢接着往里说)`, reveal: gate.revealable }
        }
        stopped = true
      }
      const out = await deps.engine.run(jobOf({
        agent, sessionId, kind: 'relay', text: relayPrompt({ sessionId, said }), marks: markers, expect: 'ack',
        // 她勾了「回了打电话给我」(2026-10-04):锁着屏时这件活要排队落盘,解锁重送那一下照它登记回电。
        ...(opts?.callOnReply === true ? { callOnReply: true } : {}),
      }))
      const bundleId = deps.registry.packageFor(agent)?.bundle_id
      /*
       * ★ 电脑锁着屏(2026-10-03):引擎已经把这一件排进队了 —— 这里只把那句实话原样交出去,
       * **不登记回电**(那一条由解锁重送那一下补,见 `engine/lockQueue.ts` 的 `after`),
       * 也**不走 `unconfirmed` 那一档**(那一档是「按了发送、没核上」,而这一下一个字都没发出去)。
       */
      if (out.screenLocked === true) return screenLockedReply(out)
      /*
       * ★ **那条会话没开着、留言排上队了**(2026-10-23,卡「捎话到没开着的会话留言等它醒」):
       * 引擎已经把这一件排进队、回的是留言那句 —— 照「已收下」翻(**不是失败,她不用重试**):
       * ok:true + note = 那句完整的话。`sessionClosed:true` 那一格告诉上一层:别登记回电
       * (那一条由醒来重送那一下补,见 `index.ts` 的 drain.after)、别套「捎到了」的框。
       * 没排上(`lockQueued` 缺席)就走下面那句如实的 `not_sent` —— 那一下真的没了。
       */
      if (out.sessionClosed === true && out.lockQueued === true) {
        return { ok: true, route: 'window', mark, note: out.why ?? SESSION_CLOSED_QUEUED_SAY, sessionClosed: true }
      }
      /*
       * ★ **同一句刚捎过、被静默合并**(2026-10-23,卡「捎话节流闸误拦」):事务官一秒内连试几次时,
       * 第二、三下回这一格 —— **一个字都不再送**,也不是失败(不是闸拦的 `blocked`)。
       * 回 ok + 一句说明(「这一句刚捎过,没再重发」),它据此知道不用再重试。
       */
      if (out.deduped === true) {
        return { ok: true, route: 'window', mark, note: out.why ?? RELAY_DEDUPED_NOTE }
      }
      if (out.delivered === 'confirmed') {
        return {
          ok: true,
          route: 'window',
          mark,
          ...(bundleId === undefined ? {} : { bundle_id: bundleId }),
          ...(move.kind === 'queue' ? { queued: true as const } : {}),
          ...(stopped === true ? { interrupted: true as const } : {}),
          // 替她按掉了她窗口上那层框 → 一定说一句(卡 DP;审计第二表第 5 条)。
          ...(out.modalClosed === undefined ? {} : { note: out.modalClosed }),
          // 哪一轮(协议型报的;2026-10-03):登记回电带上,巡检只认这一轮。
          ...(out.turnId === undefined ? {} : { turn_id: out.turnId }),
        }
      }
      /**
       * ★ **按了发送、当场没核上**(2026-09-30 止血 ③):它多半已经收到了 —— 带上 `unconfirmed`
       * 与登记回电要的那两样(记号 + 真送进去的包),上一层照新开会话那条路登记一条跟踪、回 ok。
       * **`not_sent` 不带这两样**:那一条真没送出去,登记回电等于许一通不会来的电话。
       */
      if (out.delivered === 'unconfirmed') {
        return {
          ok: false,
          status: 200,
          where: 'desk',
          why: out.why ?? `按了发送,但没在那条对话里看到这句话 —— 去 ${who(agent)} 里看一眼`,
          reveal: gate.revealable,
          unconfirmed: true,
          route: 'window',
          mark,
          ...(bundleId === undefined ? {} : { bundle_id: bundleId }),
          ...(out.turnId === undefined ? {} : { turn_id: out.turnId }),
        }
      }
      // 这一家一条能送话的通道都没有 → 照旧那句干净的人话(同 `answer` 那一处)。
      if (out.unsupported === true) {
        return { ok: false, status: 200, where: 'desk', why: deskWhy, reveal: gate.revealable }
      }
      /*
       * ★ **闸拦下的那一下**(收场 / 到顶 / 太密;2026-10-23 卡「捎话节流闸误拦」):
       * 那一句人话已经**完整、能念**(闸的 `gateBlockSay` 一处写)—— 不接「到电脑上自己说」那截,
       * 那是「这条会话从手机够不着」才说的;闸拦的是**这一下**,不是这条会话。
       * 事务官 / 手机照它原样念(「刚捎过,这一句没送进去,过几秒再说」),不许静默吞掉。
       */
      if (out.blocked === true) {
        return { ok: false, status: 200, where: 'desk', why: out.why ?? '这句话没送进去', reveal: gate.revealable }
      }
      return { ok: false, status: 200, where: 'desk', why: `${deskWhy}(${out.why ?? '那句话没送进去'})`, reveal: gate.revealable }
    },

    async dismiss(agent, sessionId) {
      const view = deps.sessions().find(one => one.agent === agent && one.session_id === sessionId)
      if (view === undefined) return { ok: false, status: 404, error: '没有这条会话' }
      if (view.ask === undefined) return { ok: false, status: 409, error: '这一问已经不在了' }
      if (view.ask.by === 'form') return { ok: false, status: 409, error: '它真停着在等你(弹窗),拿不掉 —— 得去那家里回' }
      const done = await deps.dismiss?.(agent, sessionId) ?? false
      return done ? { ok: true } : { ok: false, status: 409, error: '这一问已经不在了' }
    },

    /**
     * 「去回答」:把那段对话调到前面(深链开到那一段;开不了就把那一家叫到前面)。
     *
     * ★ 2026-10-02(审计第二表第 13 条):这一下**走引擎** —— 它真的把一个 App 的窗弹到她眼前,
     * 所以要过 `bring_front` 那一样闸(那一样从卡 AG 立起来一直没有调用方)。
     * **一个字都不送**:开窗 / 开深链 / 侧栏点一下都在窗口适配器那一层。
     */
    async reveal(agent, sessionId) {
      const plan = deskPlanOf(agent, sessionId)
      const got = await deps.engine.reveal(jobOf({
        agent,
        // 开得到「那一段」要会话 id(深链按它拼);窗口型那几家没有深链,叫到台前就够。
        sessionId,
        kind: 'answer',
        text: '',
        expect: 'none',
      }))
      if (got.ok) return { ok: true, how: got.how === 'pick' ? 'app' : got.how }
      return { ok: false, how: 'none', why: got.why ?? plan.why ?? '这一家没有窗口可以调到前面' }
    },
  }

  /**
   * 把一句话原样送进这条对话、按发送(她打的那句 / 框收掉之后她点的那一项,同一条路)。
   * 认那一段对话的记号:标题全文(`marks[0]`,侧栏里点它用的)+ 那一问的原话那一截 + 标题那一截。
   */
  async function sendIntoConversation(view: SessionView, said: string): Promise<JobResult> {
    const title = view.title?.trim()
    const marks = [
      ...(title === undefined || title === '' ? [] : [title]),
      ...[answerMarkerOf(view.ask?.quote), answerMarkerOf(view.title)]
        .filter((one, i, all): one is string => one !== undefined && all.indexOf(one) === i),
    ]
    return await deps.engine.run(jobOf({
      agent: view.agent,
      sessionId: view.session_id,
      kind: 'answer',
      text: said,
      marks,
      expect: 'ack',
    }))
  }
}
