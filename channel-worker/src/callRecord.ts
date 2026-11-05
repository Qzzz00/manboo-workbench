/**
 * 通话纪要在**工人这一侧**的那一半(2026-09-23,Ben 第四通真机)。
 *
 * ## 为什么要它
 *
 * 那一通打完,`call_records` 一行都没有,看板上也没有纪要卡 —— 查「她到底答了什么、
 * 他到底说了什么」时,证据整个不存在。根因:`POST /butler/call/record` 今天**只有手机会调**
 * (butler-app/src/call/useCall.ts 挂断那一段),而座机形态下电话是**话筒**接的,
 * 手机压根没参与那通对话,于是没有人上报。
 *
 * 所以这一份由工人自己攒:他说的(ASR 最终结果)与她说的(真要出声那一刻的那句)
 * **按时间顺序**进同一本,挂断时连时长一起交给 8791。
 *
 * ## 谁上报,谁不报(避免同一通落两条)
 *
 * 判据只有一条:{@link workerReportsRecord} —— **接话的那一台是手机就由手机报,工人不报**。
 * 来电、他拨出去的、话筒那三条路同一个判法。
 *
 * - **手机接的 / 手机拨的**:手机挂断时自己带着两边字幕上报(`butler-app/src/call/useCall.ts`
 *   的 `hangup`:只要接通过就报,**来电那一通也报**),工人不报;
 * - **话筒拨的 / 接话对象认不出来的**:没有别人会报,工人报(带 `call_id`,8791 按它去重)。
 *
 * ### ★ 为什么 2026-10-13 把来电那一支也改成「手机报」(卡 A 第 5 条)
 *
 * 09-23 写这一份时来电那一通是 `report: true` 写死的,理由是「手机那一侧今天不写纪要」。
 * **那条假设已经过期**:`useCall.hangup()` 对每一通接通过的电话都调 `/butler/call/record`,
 * 而它那条**不带 `call_id`** —— 8791 的去重表按 `call_id` 认
 * (`workbench-plugin/src/server/http.ts` 的 `callRecordsById`),认不上就又落一张卡。
 * 于是 10-13 14:06 那一通(座机响 → 他用手机接 → 说了「给我看看」)在看板上落了
 * **两张一模一样的纪要卡**(t-a351622b / t-2bccb23e)。
 *
 * 两条路里挑了「工人不报」:手机那条是**已经验过的**(他自己拨的那几通今天各落一张,不重),
 * 而让工人报就得去改手机包里那一条(另一张卡、还要重打 APK)。
 * 代价写清楚:手机那条不带 `call_id`,所以纪要卡上**挂不上台账里的那一通**;
 * 手机没机会上报(App 被杀、断网)时这一通就没有纪要 —— 与他自己拨的那几通同一个风险,
 * 不是新的。真要两样都要,得让手机把 `call_id` 带上(见本卡交接「决策记录待写」)。
 *
 * 这条分工写在 agent.ts 的接线里;这个文件只认一个布尔 `report`。
 *
 * ## ★ 2026-10-22:落成记录,不再是卡;每一通都有编号;没建成的「要办」跟着走
 *
 * 维护者拍板「通电话是记录不是事项」(决策记录同日):8791 收到这一份落成工作目录 `通话/` 下的一份记录,
 * 不建卡。工人这一侧跟着改两件:
 *
 * - **每一通都有编号**(`call_id`):来电用台账上的 id;他拨出去的那一通用手机 `start` 带来的那个
 *   (手机挂断报的时候带同一个,8791 并成一份 —— 上面「手机那条不带 call_id」的老毛病就此补上);
 *   话筒拨的、老手机没带的,工人自己编一个。
 * - **没建成的「要办」**({@link unsavedTodoOf}):通话里用工具建卡那一下**工作台连不上**,那张卡就是她明确要的、
 *   却没落下的事。它跟着这一份一起交(`todos`),8791 按建卡那一套补建。这一通归手机报时,工人手上有这种就**补报一份**
 *   (带同一个 call_id);没有就照旧不报。被工作台拒了的(没授权、缺那句需求)不算 —— 那不是没送到,是不该建。
 *
 * ## 这个文件里没有 LiveKit、没有 fetch
 *
 * 攒、算时长、决定报不报,全是纯逻辑;真发那一条 HTTP 是注进来的一个回调。
 * 所以单测跑得完「话筒那通报了 / 手机那通不报 / 一句话没说的不报 / 顺序不乱」四条路。
 */

import { randomUUID } from 'node:crypto'

/** 电话里的一句话。与 workbench-plugin 的 `CallUtterance` 逐字相同(两个仓库不互相 import)。 */
export interface CallLine {
  who: 'me' | 'butler'
  text: string
}

/** 通话里没建成的那一张卡(见文件头 2026-10-22 那一节)。 */
export interface CallTodo {
  title: string
  desc?: string
  feature?: true
}

/**
 * 交给 `POST /butler/call/record` 的那几格。与工作台 `workbench-plugin/src/protocol.ts` 的
 * `CALL_RECORD_BODY_FIELDS` 同名(用例读那边的源文件比对)。工人不报引导那一通,所以 `kind` 从来不发。
 */
export const CALL_RECORD_PAYLOAD_FIELDS = ['call_id', 'durationSeconds', 'transcript', 'kind', 'todos'] as const

/** 交给 `POST /butler/call/record` 的那一份。 */
export interface CallRecordPayload {
  /** 这一通的编号(来电那一通就是台账上的 call_id)。8791 按它把两边报的并成一份。 */
  call_id?: string
  durationSeconds: number
  transcript: readonly CallLine[]
  /** 通话里没建成的「要办」。没有就缺席。 */
  todos?: readonly CallTodo[]
}

/** 一通里最多攒几张没建成的卡。 */
export const MAX_CALL_TODOS = 10

/**
 * 这一次建卡算不算「没建成的要办」:**只认工作台连不上**(`unreachable`)。
 * 工作台回了话却不肯建(没授权、需求卡缺那句需求、标题是空的)→ 不算:那是不该建,不是没送到。
 */
export function unsavedTodoOf(
  input: { title: string, desc?: string, feature?: boolean },
  result: { ok: boolean, text?: string, unreachable?: true },
): CallTodo | undefined {
  if (result.ok || result.unreachable !== true) return undefined
  const title = input.title.trim()
  if (title === '') return undefined
  const desc = input.desc?.trim()
  return {
    title,
    ...(desc === undefined || desc === '' ? {} : { desc }),
    ...(input.feature === true ? { feature: true as const } : {}),
  }
}

/**
 * 一句都没说、又短得不像一通电话的那种**不报**。
 *
 * 5 秒:提机听见铃已经停了又放回去、手机连上就断,这类在台账上留一张
 * 「和事务官通了个电话(1 秒)」的卡是在记一件没发生的事(D13)。
 * 说过话的那一通**多短都报** —— 有内容就是真的发生过。
 */
export const MIN_SILENT_CALL_MS = 5000

/** 一通电话里最多攒多少句。够长的一通也就几十句;上限只是防一条卡住的流把内存吃掉。 */
export const MAX_CALL_LINES = 400

/** 日志里那一行最多抄多少字。120 —— 够看清他说的是哪一句,又不至于把整段私话抄进日志。 */
export const HEARD_LOG_MAX = 120

/**
 * 「他说(ASR):…」那一行(2026-09-23)。
 *
 * 2026-09-20 加这一行时只在引导里打,平时通话不打;第四通真机那天整份日志里
 * **一行「他说」都没有**,于是「她的回复我不是很满意」只能靠她那一半去猜他说了什么。
 * 现在所有识别路径都打,分寸落在这个函数里:**只打最终结果、只打前 120 字**。
 *
 * 空话回 undefined(不打空行)。
 */
export function heardLogLine(text: string): string | undefined {
  const said = text.trim()
  if (said === '') return undefined
  return `[channel-worker] 他说(ASR):${said.slice(0, HEARD_LOG_MAX)}`
}

/**
 * 建卡的那几条路:老的 createTask / rememberItem,与理解中枢的执行口(A2,2026-10-28:wb_note / wb_dispatch 走 hubExecute)。
 */
export interface CardMakers {
  createTask: (input: { title: string, desc?: string, feature?: boolean }) => Promise<{ ok: boolean, text: string, unreachable?: true }>
  rememberItem: (text: string, ...rest: never[]) => Promise<{ ok: boolean, text: string, unreachable?: true }>
  hubExecute?: (input: { said: string, commands?: readonly Record<string, unknown>[], confirmed?: { ask_id: string, choice: string } }) => Promise<{ ok: true, reply: unknown } | { ok: false, why: string, unreachable?: true }>
}

/** 执行口那一下里「要建一张卡」的那几条命令的标题(记 / 派新活)。 */
function cardTitlesOf(commands: readonly Record<string, unknown>[] | undefined): string[] {
  return (commands ?? []).flatMap((one) => {
    const title = one.name === 'note' ? one.title
      : one.name === 'dispatch' && typeof one.new === 'object' && one.new !== null ? (one.new as { title?: unknown }).title
        : undefined
    return typeof title === 'string' && title.trim() !== '' ? [title] : []
  })
}

/**
 * 给通话里那几件工具用的工作台:建卡那两条**照原样**办,工作台连不上时顺手记一张没建成的「要办」。
 * 别的方法一个不碰(原型链委托,`this` 照旧指得到原来那些方法)。
 */
export function watchUnsavedCards<T extends CardMakers>(client: T, recorder: Pick<CallRecorder, 'unsaved'>, titleOf: (text: string) => string): T {
  const watched = Object.create(client) as T
  watched.createTask = (async (input) => {
    const result = await client.createTask(input)
    const todo = unsavedTodoOf(input, result)
    if (todo !== undefined) recorder.unsaved(todo)
    return result
  }) as T['createTask']
  watched.rememberItem = (async (text: string, ...rest: never[]) => {
    const result = await client.rememberItem(text, ...rest)
    const todo = unsavedTodoOf({ title: titleOf(text), desc: text }, result)
    if (todo !== undefined) recorder.unsaved(todo)
    return result
  }) as T['rememberItem']
  const hubExecute = client.hubExecute
  if (typeof hubExecute === 'function') {
    watched.hubExecute = (async (input) => {
      const result = await hubExecute.call(client, input)
      if (!result.ok && result.unreachable === true) {
        for (const title of cardTitlesOf(input.commands)) {
          const todo = unsavedTodoOf({ title, desc: input.said }, { ok: false, unreachable: true })
          if (todo !== undefined) recorder.unsaved(todo)
        }
      }
      return result
    }) as NonNullable<T['hubExecute']>
  }
  return watched
}

export interface CallRecorderDeps {
  /** 真去发那一条 HTTP。回 false = 没落下(8791 不在、授权没开),由调用方记一行。 */
  report: (payload: CallRecordPayload) => Promise<boolean>
  now?: () => number
  log?: (line: string) => void
  /** 这一通没带编号时编一个(用例里注入)。 */
  newId?: () => string
}

/**
 * **这一通该不该由工人上报**(2026-10-13 下午,卡 A 第 5 条;整段理由在文件头)。
 *
 * `answeredOn` = 接话的那一台是什么(agent.ts 的 `answeredOn()`:房里钉住的那一位的 `wb_kind`)。
 * 认不出(`undefined`:房里还没钉上、老调用方)时**照报** —— 宁可多一张卡,也不让一通
 * 真发生过的电话在看板上没有记录。
 */
export function workerReportsRecord(input: { answeredOn?: 'phone' | 'handset' }): boolean {
  return input.answeredOn !== 'phone'
}

export interface CallRecorderStart {
  /** 来电那一通的 id / 手机 `start` 带来的那个;都没有就由这里编一个。 */
  callId?: string
  /** 这一通该不该由工人上报(见文件头「谁上报,谁不报」)。 */
  report: boolean
}

export interface CallRecorder {
  /** 一通电话开始了。**重复 start 不重开**:接起与招呼可能前后脚都来一下。 */
  start: (input: CallRecorderStart) => void
  /** 攒一句。没在通话里就丢掉 —— 房里没人时的那些字幕不是一通电话。 */
  add: (who: CallLine['who'], text: string) => void
  /** 记一张没建成的卡({@link unsavedTodoOf} 认出来的那种)。没在通话里就丢掉。 */
  unsaved: (todo: CallTodo) => void
  /** 这一通的编号(没在通话里是 undefined)。 */
  readonly callId: string | undefined
  /** 挂断。该报的报(**不等**回包),不该报的悄悄收掉。 */
  finish: () => void
  /** 这会儿在不在一通电话里(测试与日志用)。 */
  readonly active: boolean
  /** 这会儿攒了几句(测试用)。 */
  readonly lines: readonly CallLine[]
}

export function createCallRecorder(deps: CallRecorderDeps): CallRecorder {
  const now = deps.now ?? (() => Date.now())
  const log = deps.log ?? (() => {})
  const newId = deps.newId ?? (() => `call-${randomUUID().slice(0, 8)}`)
  let open = false
  let startedAt = 0
  let callId: string | undefined
  let report = false
  let lines: CallLine[] = []
  let todos: CallTodo[] = []

  return {
    start(input) {
      if (open) return
      open = true
      startedAt = now()
      const given = input.callId?.trim()
      callId = given === undefined || given === '' ? newId() : given
      report = input.report
      lines = []
      todos = []
    },

    add(who, text) {
      if (!open) return
      const trimmed = text.trim()
      if (trimmed === '') return
      if (lines.length >= MAX_CALL_LINES) return
      lines.push({ who, text: trimmed })
    },

    unsaved(todo) {
      if (!open) return
      if (todos.length >= MAX_CALL_TODOS) return
      if (todos.some(one => one.title === todo.title)) return
      todos.push(todo)
    },

    finish() {
      if (!open) return
      open = false
      const durationMs = Math.max(0, now() - startedAt)
      const transcript = lines
      const id = callId
      const pending = todos
      // 归手机报的那一通,手上有没建成的「要办」也补报一份(同一个编号,8791 并成一份)。
      const mine = report || pending.length > 0
      lines = []
      todos = []
      callId = undefined
      report = false
      if (!mine) return
      if (transcript.length === 0 && pending.length === 0 && durationMs < MIN_SILENT_CALL_MS) {
        log(`[channel-worker] 这一通没说过话、只有 ${Math.round(durationMs / 1000)} 秒,不落记录`)
        return
      }
      const payload: CallRecordPayload = {
        ...(id === undefined ? {} : { call_id: id }),
        durationSeconds: Math.round(durationMs / 1000),
        transcript,
        ...(pending.length === 0 ? {} : { todos: pending }),
      }
      // **不等回包**:记录不是通话本身;等它落下再收场只会让挂断慢一拍。
      void deps.report(payload)
        .then((ok) => {
          log(ok
            ? `[channel-worker] 通话记录落下了:${payload.durationSeconds} 秒、${transcript.length} 句${pending.length === 0 ? '' : `、${pending.length} 件没建成的要办`}`
            : '[channel-worker] 通话记录没落下(工作台没收,这一通就没有记录)')
        })
        .catch((err: unknown) => log(`[channel-worker] 通话记录没落下:${(err as Error)?.message ?? '没说原因'}`))
    },

    get active() { return open },
    get lines() { return lines },
    get callId() { return open ? callId : undefined },
  }
}
