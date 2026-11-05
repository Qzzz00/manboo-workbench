/**
 * 理解中枢的上下文包(设计 `docs/设计-理解中枢-模型出命令-2026-10-28.md` 第三节)。
 *
 * 模型读的是这一包,不是全板:最近的话、活着的卡(+ 按句子命中的旧卡)、全部目标、每只手此刻能不能用、
 * 用户层里有哪几格、入口与时间。包里没有的它只能问。三入口共用这一处拼法;取事实的 IO 在调用方(http 适配层),
 * 这里只做取舍与成文,不碰 IO。
 */
import { CARD_ID_RE } from './commands.ts'

export type HubEntrance = 'desktop' | 'call' | 'phone'

/** say 账的一条(中枢自己的账;回话时落)。 */
export interface HubSayRecord {
  say_id: string
  at: number
  entrance: HubEntrance
  said: string
  /** 当时出的命令名(按顺序)。 */
  commands: readonly string[]
  /** 涉及的卡号。 */
  cards: readonly string[]
  /** 每条命令的结果一句(做了什么 / 为什么没做)。 */
  results?: readonly string[]
}

/** 一只手(一家或一张名片)此刻的状态 —— 派前核手全看它。 */
export interface HubHand {
  /** 家名(`claude`)或名片 id(`agent:…`)。 */
  id: string
  title: string
  /** 底下那一家(名片的 runtime.family)。 */
  family: string
  card: boolean
  /** 装没装;undefined = 查不出(不当成没装)。 */
  installed: boolean | undefined
  login: 'yes' | 'no' | 'unknown'
  quota: 'ok' | 'low' | 'empty' | 'unknown'
  quota_text?: string
  /** 此刻在跑几件。 */
  running: number
  /** 派活选项表说这会儿派得出去。 */
  ok: boolean
  why?: string
  /** 能改本机文件(写代码 / 改用户层用得上)。 */
  code: boolean
  /** 规矩 / 学到的默认推荐它。 */
  recommended?: boolean
  good_at?: string
}

export interface HubCardFact {
  id: string
  title: string
  status: string
  assignee?: string
  goal_id?: string
  updated_at: string
  /** 派发那一格:谁、在不在跑。 */
  dispatch?: { family?: string, status?: string, /** 收场时刻(交回核验拿它当这一轮的交回时间,卡片行带「交回于」)。 */ ended_at?: string }
  acceptance?: number
  /** 验收条件原文(2026-10-28 卡「重派派发词带补话与轮次」:supplement 像条件时往后追加,要拿得到现有几条)。 */
  acceptance_lines?: readonly string[]
  desc_head?: string
}

export interface HubGoalFact { id: string, title: string, status: string, due?: string, conditions: number }
export interface HubWidgetFact { id: string, name?: string, status: string, replaces?: string }
export interface HubFileFact { path: string, head: string }
export interface HubAskFact { ask_id: string, question: string, options: readonly string[] }

export interface HubContext {
  entrance: HubEntrance
  now: number
  /** 这台机器上有本体源码(本体毛病可以直接派人改);undefined = 不确定。 */
  dev_machine?: boolean
  /** 她正在看的卡。 */
  focus?: string
  says: HubSayRecord[]
  cards: HubCardFact[]
  goals: HubGoalFact[]
  hands: readonly HubHand[]
  user_layer: HubWidgetFact[]
  /** 句子里点名的文件,读得到的开头一段(验收条件从这里抽)。 */
  files: HubFileFact[]
  /** 挂着等她答的问。 */
  asks: HubAskFact[]
  /** 她的规矩(派活 / 说话那几条)。 */
  rules?: string
  /** 这条请求附带的事实(附件路径 / 引用 / 她点的名;入口适配层给,不是她说的话)。 */
  request_facts?: readonly string[]
}

export const CONTEXT_LIMITS = { says: 20, sayWindowMs: 2 * 86_400_000, openCards: 60, hitCards: 20 } as const

const CLOSED = new Set(['done', 'canceled'])

interface TaskLike {
  id: string
  title: string
  status: string
  updated_at: string
  assignee?: string
  goal_id?: string
  desc?: string
  acceptance?: readonly string[]
  dispatch?: { family?: string, status?: string, ended_at?: string }
}

interface GoalLike { id: string, title: string, status: string, due?: string, conditions?: readonly unknown[] }

/** 汉字两两一组 + 拉丁词(≥3 字母或带数字):给「按句子关键词命中旧卡」打分用。 */
function grams(text: string): Set<string> {
  const out = new Set<string>()
  const han = text.match(/[\p{Script=Han}]+/gu) ?? []
  for (const run of han) for (let i = 0; i + 1 < run.length; i += 1) out.add(run.slice(i, i + 2))
  for (const word of text.toLowerCase().match(/[a-z0-9][a-z0-9_.-]{2,}/gu) ?? []) out.add(word)
  return out
}

/** 句子里出现的卡号。 */
export function cardIdsIn(said: string): string[] {
  return [...new Set((said.match(CARD_ID_RE) ?? []).map(one => one.toLowerCase()))]
}

function cardFact(task: TaskLike): HubCardFact {
  const desc = (task.desc ?? '').trim()
  return {
    id: task.id,
    title: task.title,
    status: task.status,
    updated_at: task.updated_at,
    ...(task.assignee === undefined ? {} : { assignee: task.assignee }),
    ...(task.goal_id === undefined ? {} : { goal_id: task.goal_id }),
    ...(task.dispatch === undefined ? {} : { dispatch: { ...(task.dispatch.family === undefined ? {} : { family: task.dispatch.family }), ...(task.dispatch.status === undefined ? {} : { status: task.dispatch.status }), ...(task.dispatch.ended_at === undefined ? {} : { ended_at: task.dispatch.ended_at }) } }),
    ...(task.acceptance === undefined || task.acceptance.length === 0 ? {} : { acceptance: task.acceptance.length, acceptance_lines: [...task.acceptance] }),
    ...(desc === '' || desc === task.title ? {} : { desc_head: desc.slice(0, 80) }),
  }
}

export function buildContext(input: {
  said: string
  entrance: HubEntrance
  now: number
  says: readonly HubSayRecord[]
  tasks: readonly TaskLike[]
  goals: readonly GoalLike[]
  hands: readonly HubHand[]
  widgets: readonly HubWidgetFact[]
  files?: readonly HubFileFact[]
  asks?: readonly HubAskFact[]
  devMachine?: boolean
  focus?: string
  rules?: string
  /** 这条请求附带的事实(附件 / 引用 / 点名;由入口适配层给)。 */
  requestFacts?: readonly string[]
}): HubContext {
  const says = input.says
    .filter(one => input.now - one.at <= CONTEXT_LIMITS.sayWindowMs)
    .slice(-CONTEXT_LIMITS.says)
  const byRecent = [...input.tasks].sort((a, b) => b.updated_at.localeCompare(a.updated_at))
  const open = byRecent.filter(one => !CLOSED.has(one.status)).slice(0, CONTEXT_LIMITS.openCards)
  const picked = new Set(open.map(one => one.id))
  // 点到的卡号与最近的话涉及的卡:一定进包(接续要看得见那张卡)。
  const must = new Set([...cardIdsIn(input.said), ...says.flatMap(one => one.cards), ...(input.focus === undefined ? [] : [input.focus])])
  const forced = input.tasks.filter(one => must.has(one.id) && !picked.has(one.id))
  for (const one of forced) picked.add(one.id)
  const want = grams(input.said)
  const hits = want.size === 0 ? [] : input.tasks
    .filter(one => !picked.has(one.id))
    .map(one => {
      const have = grams(one.title)
      let score = 0
      for (const g of want) if (have.has(g)) score += 1
      return { one, score }
    })
    .filter(one => one.score >= 2)
    .sort((a, b) => b.score - a.score || b.one.updated_at.localeCompare(a.one.updated_at))
    .slice(0, CONTEXT_LIMITS.hitCards)
    .map(one => one.one)
  return {
    entrance: input.entrance,
    now: input.now,
    ...(input.devMachine === undefined ? {} : { dev_machine: input.devMachine }),
    ...(input.focus === undefined ? {} : { focus: input.focus }),
    says,
    cards: [...open, ...forced, ...hits].map(cardFact),
    goals: input.goals.map(one => ({ id: one.id, title: one.title, status: one.status, ...(one.due === undefined ? {} : { due: one.due }), conditions: one.conditions?.length ?? 0 })),
    hands: input.hands,
    user_layer: [...input.widgets],
    files: [...(input.files ?? [])],
    asks: [...(input.asks ?? [])],
    ...(input.rules === undefined || input.rules.trim() === '' ? {} : { rules: input.rules.trim() }),
    ...(input.requestFacts === undefined || input.requestFacts.length === 0 ? {} : { request_facts: [...input.requestFacts] }),
  }
}

/** 这只手此刻能不能接活;不能就说清为什么(一句带名字)。 */
export function handUsable(hand: HubHand): { ok: true } | { ok: false, why: string } {
  if (hand.installed === false) return { ok: false, why: `${hand.title} 这台电脑上没装` }
  if (hand.login === 'no') return { ok: false, why: `${hand.title} 登录过期了` }
  if (hand.quota === 'empty') return { ok: false, why: `${hand.title} 额度用完了` }
  if (!hand.ok) return { ok: false, why: `${hand.title} ${hand.why ?? '这会儿派不出去'}` }
  return { ok: true }
}

function handLine(hand: HubHand): string {
  const state = handUsable(hand)
  const bits = [
    `${hand.id}`,
    `「${hand.title}」`,
    hand.card ? `名片(${hand.family})` : '一家',
    state.ok ? '可用' : `不可用:${state.why}`,
    hand.login === 'unknown' ? '' : `登录${hand.login === 'yes' ? '正常' : '过期'}`,
    hand.quota_text ?? (hand.quota === 'unknown' ? '' : `额度${hand.quota}`),
    `在跑 ${hand.running} 件`,
    hand.code ? '能改本机文件' : '',
    hand.recommended === true ? '默认推荐' : '',
    hand.good_at === undefined || hand.good_at === '' ? '' : `擅长:${hand.good_at}`,
  ].filter(one => one !== '')
  return `- ${bits.join(' / ')}`
}

function clock(ms: number): string {
  const d = new Date(ms + 8 * 3_600_000)
  return d.toISOString().slice(5, 16).replace('T', ' ')
}

/** 成文:模型读的那一段(按块分,块内一行一件)。 */
export function renderContext(ctx: HubContext): string {
  const lines: string[] = []
  lines.push(`【入口与时间】${ctx.entrance} · ${clock(ctx.now)}(北京时间)${ctx.dev_machine === undefined ? '' : ctx.dev_machine ? ' · 这台机器上有源码(本体毛病可以派人改)' : ' · 这台机器上没有源码(本体毛病只能反馈)'}${ctx.focus === undefined ? '' : ` · 她正在看 ${ctx.focus}`}`)
  lines.push('【最近的话】(旧→新)')
  if (ctx.says.length === 0) lines.push('- (没有)')
  for (const one of ctx.says) {
    lines.push(`- ${clock(one.at)} [${one.entrance}] 「${one.said.slice(0, 160)}」 → ${one.commands.join('+') || '无'}${one.cards.length === 0 ? '' : ` 卡:${one.cards.join(',')}`}${one.results === undefined || one.results.length === 0 ? '' : ` 结果:${one.results.join(';').slice(0, 160)}`}`)
  }
  if (ctx.asks.length > 0) {
    lines.push('【挂着等她答的问】(答它出 confirm,choice 照抄选项原话)')
    for (const one of ctx.asks) lines.push(`- ${one.ask_id}:${one.question}${one.options.length === 0 ? '' : `(${one.options.join(' / ')})`}`)
  }
  lines.push('【板上的卡】(id / 标题 / 状态 / 负责人 / 目标 / 派发)')
  if (ctx.cards.length === 0) lines.push('- (没有)')
  for (const one of ctx.cards) {
    // 交回时间(回归集 10-29 09:30 行):「10-24 到 10-27 交回的那几张」这一句对得上 ——
    // 只有真交回过(dispatch.ended_at 在)的卡片行才带,没交回的(还在跑 / 没派过)不带。
    const endedMs = one.dispatch?.ended_at === undefined ? NaN : Date.parse(one.dispatch.ended_at)
    lines.push(`- ${one.id}「${one.title}」 ${one.status}${one.assignee === undefined ? '' : ` 负责:${one.assignee}`}${one.goal_id === undefined ? '' : ` 目标:${one.goal_id}`}${one.dispatch === undefined ? '' : ` 派发:${one.dispatch.family ?? '?'}/${one.dispatch.status ?? '?'}`}${Number.isNaN(endedMs) ? '' : ` 交回于${clock(endedMs)}`}${one.acceptance === undefined ? '' : ` 验收${one.acceptance}条`} 改于${clock(Date.parse(one.updated_at))}${one.desc_head === undefined ? '' : ` 说明:${one.desc_head}`}`)
  }
  lines.push('【目标】')
  if (ctx.goals.length === 0) lines.push('- (没有)')
  for (const one of ctx.goals) lines.push(`- ${one.id}「${one.title}」 ${one.status}${one.due === undefined ? '' : ` 截止${one.due}`} 条件${one.conditions}条`)
  lines.push('【手(能派的家与名片)】')
  if (ctx.hands.length === 0) lines.push('- (一只都没接上)')
  for (const one of ctx.hands) lines.push(handLine(one))
  lines.push('【用户层(她自己的那几格,改它们走 user_layer_fix)】')
  if (ctx.user_layer.length === 0) lines.push('- (没有)')
  for (const one of ctx.user_layer) lines.push(`- ${one.id}${one.name === undefined ? '' : `「${one.name}」`}${one.replaces === undefined ? '' : ` 替换本体那一格:${one.replaces}`} ${one.status}`)
  if (ctx.files.length > 0) {
    lines.push('【她点名的文件(开头一段)】')
    for (const one of ctx.files) lines.push(`--- ${one.path}\n${one.head}`)
  }
  if (ctx.request_facts !== undefined && ctx.request_facts.length > 0) {
    lines.push('【这条请求附带的事实】(不是她说的话,是随请求带进来的)')
    for (const one of ctx.request_facts) lines.push(`- ${one}`)
  }
  if (ctx.rules !== undefined) lines.push(`【她的规矩】${ctx.rules}`)
  return lines.join('\n')
}
