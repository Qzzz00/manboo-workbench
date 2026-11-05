/**
 * 理解中枢的一条路(设计第二节):句子 + 入口 + 上下文包 → understand → guard → execute → reply + say 账。
 *
 * 答挂着的那一问有两条规则路,都不交模型:她点了按钮(`confirmed`);或打字回得与那一问的某个选项原话
 * 逐字一样(第一选项 = 点头,其余 = 不批;10-29 卡),或一句只有一种读法的「好 / 先别」——命中即照原命令办 / 销掉。
 * 主路是模型自己答:命令表里的 `confirm {ask_id, choice}`(10-29 卡,机制版)——上下文包里看得见挂着的问
 * (ask_id + 问句 + 选项),模型看出她这句是在答那一问就出它,执行走现有 `answerPending`;
 * 不在命令表里的读法、同名同指向的猜法,一概没有。除此之外没有任何一步在模型之前就地结束。
 * 入口回包形状:`say_id / items / say{screen,spoken} / ask? / asks?` 与旧口一致,另带一段 `hub`(命令与结果)。
 *
 * 另露两口给电话工人与手机(A2;路由由 A2 接在 8791 上,这里只出函数):
 *   hubContext({entrance, said?})                 → { context, text }(设计第三节那包 + 成文)
 *   hubExecute({entrance, commands[], said?, confirmed?}) → { say_id, results:[{command, ok, did, why?, next?, card_id?, who?, ask?{ask_id,question,options}}], say }
 * 理解在那一侧的模型里,执行一律回这里的同一执行器(电脑入口也是它),护栏与 say 账同一份。
 * 电话工人那头答挂着的问走 `wb_confirm` → 这里的 `confirmed` 路,与 confirm 同一条 answerPending。
 */
import { randomUUID } from 'node:crypto'
import { affirmFast } from '../butlerSay.ts'
import { parseCommands, type HubCommand, type HubResult } from './commands.ts'
import { buildContext, renderContext, type HubContext, type HubEntrance, type HubFileFact, type HubHand, type HubWidgetFact } from './context.ts'
import { executeCommands, type HubHands } from './execute.ts'
import { guardCommands } from './guard.ts'
import { itemsOf, replyOf, type HubPendingAsk, type SayBook } from './reply.ts'
import { understandCommands, type HubModelDeps } from './understand.ts'

/** 中枢一条 say 主路的总时限(2026-10-28 卡「悬浮窗 say 挂住与超时」):到点照回 200、说清卡在哪一步。 */
export const HUB_SAY_TIMEOUT_MS = 120_000
/** 超时回执里那一步的名字(给她看的白话,对应打点的五步)。 */
const SAY_STAGE_NAME: Record<string, string> = {
  received: '收下这句',
  model: '问模型那一步',
  exec_start: '执行那一步',
  exec_done: '执行那一步',
  replied: '回话那一步',
}
/** 总时限到点的回执;哪一步从 say 账的最后一个打点看。 */
export function sayTimeoutScreen(stage: string): string {
  return `这句办到一半卡在${SAY_STAGE_NAME[stage] ?? '办事那一步'},我接着办,办完说`
}

export interface HubFacts {
  tasks: Parameters<typeof buildContext>[0]['tasks']
  goals: Parameters<typeof buildContext>[0]['goals']
  hands: readonly HubHand[]
  widgets: readonly HubWidgetFact[]
  files?: readonly HubFileFact[]
  devMachine?: boolean
  rules?: string
  focus?: string
  /** 这条请求附带的事实(附件 / 引用 / 点名;入口适配层给,见 context.ts 的 request_facts)。 */
  facts?: readonly string[]
}

export interface HubRunDeps {
  book: SayBook
  hands: HubHands
  model: HubModelDeps
  /** 现取上下文包的事实(板、目标、手、用户层;句子里点名的文件)。 */
  facts: (said: string) => Promise<HubFacts>
  now?: () => number
  newId?: () => string
  /** 主路整条的总时限(毫秒);缺省 HUB_SAY_TIMEOUT_MS,测试注小值。 */
  sayTimeoutMs?: number
}

export interface HubReply { status: number, body: Record<string, unknown> }

/** 她不批:按钮 false / 「否 / 不 / 先别 / 先留着 / 算了」开头。 */
const DENY = /^(?:no|否|否定|不|不要|别|先别|先留着|算了|不用|不办)/iu

export const HUB_UNREACHABLE = '理解服务这会儿没接上,这句我没动 —— 原话还在输入框里,等一下再发。'
export const HUB_BAD_OUTPUT = '这句我没理解成能办的事,没动 —— 原话还在输入框里,换个说法再发?'

function denied(choice: unknown): boolean {
  return choice === false || (typeof choice === 'string' && DENY.test(choice.trim()))
}

/** 她那一句去掉首尾空白与标点(10-29 卡:答护栏问给的选项原话要逐字对得上)。 */
function trimEdge(said: string): string {
  return said.replace(/^[\s\p{P}]+/u, '').replace(/[\s\p{P}]+$/u, '')
}

/** 最近那一条挂着的护栏问(有命令挂着等点头的;模型自己的问不算)。 */
function latestGuardAsk(deps: HubRunDeps): HubPendingAsk | undefined {
  return deps.book.asks().filter(one => one.held.length > 0).at(-1)
}

/** 现取一份上下文包(三入口同一拼法)。 */
async function contextFor(said: string, entrance: HubEntrance, deps: HubRunDeps): Promise<HubContext> {
  const now = deps.now ?? Date.now
  const facts = await deps.facts(said)
  return buildContext({ said, entrance, now: now(), says: deps.book.recent(), asks: deps.book.asks(), ...facts, ...(facts.devMachine === undefined ? {} : { devMachine: facts.devMachine }), ...(facts.facts === undefined ? {} : { requestFacts: facts.facts }) })
}

/** 已核过指向的命令 → 护栏 → 执行 → 回话 + say 账。三入口共用(电脑入口经 hubSay,电话 / 手机经 hubExecute)。 */
export async function runCommands(said: string, entrance: HubEntrance, commands: readonly HubCommand[], rejected: readonly { name: string, why: string }[], deps: HubRunDeps, opts: { confirmed?: boolean, sayId: string, ctx?: HubContext }): Promise<HubReply> {
  const newId = deps.newId ?? randomUUID
  const ctx = opts.ctx ?? await contextFor(said, entrance, deps)
  // 模型答挂着的那一问(10-29 卡,机制版):confirm {ask_id, choice} 是这一句唯一一条命令(解析时拦过夹带)。
  // 走现有 answerPending 那条路(点头照原命令办 / 不批销掉),与按钮 confirmed / 电话 wb_confirm 同一个落点。
  if (commands.length === 1 && commands[0]!.name === 'confirm') {
    const confirm = commands[0] as Extract<HubCommand, { name: 'confirm' }>
    const pending = deps.book.take(confirm.ask_id)
    if (pending === undefined) {
      // 答过了 / 过了十分钟:照实说,不猜、不拿挂着的别条顶。
      const line = '这一问已经不在了(答过了或过了十分钟),再说一句吧。'
      const results: HubResult[] = [{ command: 'confirm', ok: false, did: line, why: '答过了或过了十分钟' }]
      deps.book.record({ say_id: opts.sayId, entrance, said, commands: ['confirm'], results })
      return { status: 200, body: { say_id: opts.sayId, items: itemsOf(results), say: { screen: line, spoken: '这一问已经不在了,再说一句吧。' }, hub: { commands, rejected, results } } }
    }
    // 模型自己的问(没挂命令):她选的那个选项就是新的一句,带着问句交回主路重新听懂(与按钮路同一个处置)。
    if (pending.held.length === 0 && !denied(confirm.choice)) {
      return hubSay({ said: `${confirm.choice}(答「${pending.question}」)`, entrance }, deps)
    }
    return answerPending(pending, confirm.choice, entrance, deps)
  }
  const guarded = guardCommands(commands, ctx, opts.confirmed === true ? { confirmed: true } : {})
  deps.book.mark(opts.sayId, 'exec_start')
  const executed = await executeCommands(guarded.pass.filter(one => one.name !== 'ask'), ctx, deps.hands, { said })
  deps.book.mark(opts.sayId, 'exec_done')
  const asks: { ask_id: string, question: string, options: readonly string[] }[] = []
  const askResults: HubResult[] = []
  for (const one of guarded.asks) {
    const askId = newId()
    deps.book.hold({ ask_id: askId, say_id: opts.sayId, said, question: one.question, options: one.options, held: [one.held] })
    asks.push({ ask_id: askId, question: one.question, options: one.options })
    askResults.push({ command: one.held.name, ok: true, did: one.question, ask: { question: one.question, options: one.options, ask_id: askId }, ...('card_id' in one.held && typeof one.held.card_id === 'string' ? { card_id: one.held.card_id } : {}) })
  }
  // 模型自己问的(拿不准指哪张 / 做什么):问句与选项在回话里,下一句的上下文包里看得见;
  // 不挂「确认 / 否定」两颗键(那是给护栏挂起的命令用的,答它要的是一句话,不是是 / 否)。
  for (const one of guarded.pass.filter((cmd): cmd is Extract<HubCommand, { name: 'ask' }> => cmd.name === 'ask')) {
    deps.book.hold({ ask_id: newId(), say_id: opts.sayId, said, question: one.question, options: one.options, held: [] })
    askResults.push({ command: 'ask', ok: true, did: one.question, ask: { question: one.question, options: one.options }, ...(one.about === undefined ? {} : { card_id: one.about }) })
  }
  const rejectedResults: HubResult[] = rejected
    // 模型那一侧指向全落空时已经变成一问(understand 的 askForRejected),这里不再重复报。
    .filter(one => one.name !== '?' && !(commands.length > 0 && commands.every(cmd => cmd.name === 'ask')))
    .map(one => ({ command: (one.name as HubResult['command']), ok: false, did: '有一条没办', why: one.why }))
  const results = [...executed, ...guarded.refused, ...rejectedResults, ...askResults]
  const say = replyOf(results)
  // 回话同源写卡:这一句办到(或没办成)的那几张卡写上同一句;挂起的问还没办,不写。
  for (const id of new Set(executed.flatMap(one => (one.card_id === undefined ? [] : [one.card_id])))) await deps.hands.sayNote?.(id, say.screen).catch(() => undefined)
  deps.book.record({ say_id: opts.sayId, entrance, said, commands: commands.map(one => one.name), results })
  deps.book.mark(opts.sayId, 'replied')
  return {
    status: 200,
    body: {
      say_id: opts.sayId,
      items: itemsOf(results),
      say,
      ...(asks.length === 0 ? {} : { ask: { ask_id: asks[0]!.ask_id, question: asks[0]!.question, options: asks[0]!.options } }),
      ...(asks.length > 1 ? { asks: asks.map(one => ({ ask_id: one.ask_id, question: one.question, options: one.options })) } : {}),
      hub: { commands, rejected, results },
    },
  }
}

async function answerPending(pending: HubPendingAsk, choice: unknown, entrance: HubEntrance, deps: HubRunDeps): Promise<HubReply> {
  if (denied(choice) || pending.held.length === 0 && typeof choice !== 'string') {
    const line = `好,先没动 ——「${pending.question}」这件没办。`
    deps.book.record({ say_id: pending.ask_id, entrance, said: typeof choice === 'string' ? choice : '否', commands: [], results: [{ command: 'chat', ok: true, did: line, reply: line }] })
    return { status: 200, body: { say_id: pending.ask_id, items: [], say: { screen: line, spoken: '好,先没动,这件没办。' }, hub: { commands: [], rejected: [], results: [] } } }
  }
  return runCommands(pending.said, entrance, pending.held, [], deps, { confirmed: true, sayId: pending.ask_id })
}

/**
 * 主路整条的总时限:到点照回 200、回执说清卡在哪一步(从 say 账最后一个打点看),
 * 并记一笔 timeout 打点;办事那一路不回断 —— 办完了照常落卡、写卡,她下一句也照常发。
 */
async function withSayDeadline(work: Promise<HubReply>, sayId: string, deps: HubRunDeps): Promise<HubReply> {
  const timeoutMs = deps.sayTimeoutMs ?? HUB_SAY_TIMEOUT_MS
  if (!(timeoutMs > 0)) return work
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<HubReply>((resolve) => {
    timer = setTimeout(() => {
      const stage = deps.book.lastStageOf(sayId) ?? 'received'
      deps.book.mark(sayId, 'timeout')
      const screen = sayTimeoutScreen(stage)
      resolve({ status: 200, body: { say_id: sayId, items: [], say: { screen, spoken: screen }, hub: { commands: [], rejected: [], results: [] } } })
    }, timeoutMs)
    if (typeof timer === 'object' && timer !== null && typeof (timer as { unref?: unknown }).unref === 'function') (timer as { unref: () => void }).unref()
  })
  try {
    return await Promise.race([work, timeout])
  }
  finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

export async function hubSay(input: { said: string, entrance: HubEntrance, confirmed?: { ask_id: string, choice: unknown } }, deps: HubRunDeps): Promise<HubReply> {
  const newId = deps.newId ?? randomUUID
  // 她点了按钮:答的是哪一问清清楚楚,照原命令办 / 销掉。
  if (input.confirmed !== undefined) {
    const pending = deps.book.take(input.confirmed.ask_id)
    if (pending === undefined) return { status: 409, body: { error: '这一问已经不在了(答过了或过了十分钟),再说一句吧' } }
    // 模型自己问的(没挂命令):她选的那个选项就是新的一句,带着问句交模型。
    if (pending.held.length === 0 && typeof input.confirmed.choice === 'string' && !denied(input.confirmed.choice)) {
      return hubSay({ said: `${input.confirmed.choice}(答「${pending.question}」)`, entrance: input.entrance }, deps)
    }
    return answerPending(pending, input.confirmed.choice, input.entrance, deps)
  }
  // 快路径:挂着护栏问时 —— 选项原话逐字命中(第一选项 = 点头,其余 = 不批;先于「好 / 先别」判,
  // 因为有的选项(「不要了」)本身像否定话),或「好 / 先别」这类只有一种读法的短句;命中即走,不命中照常交模型。
  const latest = latestGuardAsk(deps)
  if (latest !== undefined) {
    const saidEdge = trimEdge(input.said)
    const hitOption = latest.options.findIndex(one => trimEdge(one) === saidEdge)
    if (hitOption === 0 || (hitOption < 0 && affirmFast(input.said))) {
      deps.book.take(latest.ask_id)
      return answerPending(latest, 'yes', input.entrance, deps)
    }
    if (hitOption > 0 || (hitOption < 0 && DENY.test(input.said.trim()) && input.said.trim().length <= 6)) {
      deps.book.take(latest.ask_id)
      return answerPending(latest, hitOption > 0 ? false : input.said, input.entrance, deps)
    }
  }
  // 主路(交模型的那一条):每步打点进 say 账,整条有总时限 —— 哪一步卡住、卡了多久,账里看得见。
  const sayId = newId()
  deps.book.mark(sayId, 'received')
  const work = (async (): Promise<HubReply> => {
    const ctx = await contextFor(input.said, input.entrance, deps)
    const understood = await understandCommands(input.said, ctx, deps.model)
    if (!understood.ok) {
      return understood.why === 'unreachable'
        ? { status: 503, body: { error: HUB_UNREACHABLE, hub: { why: 'unreachable' } } }
        : { status: 502, body: { error: HUB_BAD_OUTPUT, hub: { why: 'bad_output' } } }
    }
    deps.book.mark(sayId, 'model')
    return runCommands(input.said, input.entrance, understood.commands, understood.rejected, deps, { sayId, ctx })
  })()
  return withSayDeadline(work, sayId, deps)
}

/** 上下文包(给在别处理解的入口:电话工人的模型读它)。said 给了就按它补命中的旧卡与点名的文件。 */
export async function hubContext(input: { entrance: HubEntrance, said?: string }, deps: HubRunDeps): Promise<{ context: HubContext, text: string }> {
  const context = await contextFor(input.said ?? '', input.entrance, deps)
  return { context, text: renderContext(context) }
}

/**
 * 执行别处理解出来的命令(原始 JSON,按命令表核指向)。`confirmed` = 答护栏挂起的那一问(results 里的 ask.ask_id),
 * 此时 commands 忽略。回 `{ say_id, results, say }`;一条失败不拖累其余,护栏照样过。
 */
export async function hubExecute(input: { entrance: HubEntrance, commands: unknown, said?: string, confirmed?: { ask_id: string, choice: unknown } }, deps: HubRunDeps): Promise<HubReply> {
  const shape = (reply: HubReply): HubReply => {
    if (reply.status !== 200) return reply
    const hub = reply.body.hub as { results?: HubResult[] } | undefined
    return { status: 200, body: { say_id: reply.body.say_id, results: hub?.results ?? [], say: reply.body.say } }
  }
  if (input.confirmed !== undefined) {
    const pending = deps.book.take(input.confirmed.ask_id)
    if (pending === undefined) return { status: 409, body: { error: '这一问已经不在了(答过了或过了十分钟)' } }
    return shape(await answerPending(pending, input.confirmed.choice, input.entrance, deps))
  }
  if (!Array.isArray(input.commands)) return { status: 400, body: { error: 'commands 要是命令数组(命令表见 hub/commands.ts)' } }
  const said = input.said ?? ''
  const ctx = await contextFor(said, input.entrance, deps)
  const { commands, rejected } = parseCommands({ commands: input.commands }, ctx)
  const newId = deps.newId ?? randomUUID
  return shape(await runCommands(said, input.entrance, commands, rejected, deps, { sayId: newId(), ctx }))
}
