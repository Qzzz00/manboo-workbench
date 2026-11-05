/**
 * 理解中枢的命令表(设计 `docs/设计-理解中枢-模型出命令-2026-10-28.md` 第四节)。
 *
 * 模型只能从这张表里出命令;每条命令的指向(卡号 / 目标 / 手)必须落在上下文包里看得见的那几样上,
 * 落不上的整条拒掉、如实说为什么 —— 模型编不出板上没有的卡,也编不出没接上的手。
 * 执行结果一律是 {@link HubResult}:做了什么 / 为什么没做 / 下一步建议,回话由它拼。
 */
import { TASK_STATUSES, GOAL_STATUSES, type GoalStatus, type TaskStatus } from '../../protocol.ts'
import type { HubContext, HubHand } from './context.ts'

export const HUB_COMMANDS = [
  'dispatch', 'reassign', 'supplement', 'rename', 'cancel', 'move_status',
  'set_goal', 'goal_status', 'goal_create', 'goal_due',
  'note', 'user_layer_fix', 'remember', 'feedback', 'voice', 'ask', 'confirm', 'chat', 'verify',
] as const
export type HubCommandName = typeof HUB_COMMANDS[number]

/** 模型可以给派活标的风险(护栏据此改成问一句;不标也会按动作再核一遍)。 */
export const HUB_RISKS = ['money', 'external', 'account'] as const
export type HubRisk = typeof HUB_RISKS[number]

export const REMEMBER_SCOPES = ['global', 'dispatch', 'content'] as const
export type RememberScope = typeof REMEMBER_SCOPES[number]

export interface HubNewCard { title: string, goal_id?: string, acceptance?: readonly string[] }

export type HubCommand =
  | { name: 'dispatch', card_id?: string, new?: HubNewCard, to?: string, text: string, acceptance?: readonly string[], risk?: HubRisk }
  | { name: 'reassign', card_id: string, to: string, restart: boolean }
  | { name: 'supplement', card_id: string, text: string }
  | { name: 'rename', card_id: string, title: string }
  | { name: 'cancel', card_id: string }
  | { name: 'move_status', card_id: string, status: TaskStatus }
  | { name: 'set_goal', card_id: string, goal_id: string | null }
  | { name: 'goal_status', goal_id: string, status: GoalStatus }
  | { name: 'goal_create', title: string, due?: string }
  | { name: 'goal_due', goal_id: string, due: string | null }
  | { name: 'note', title: string, status: 'backlog' | 'todo', goal_id?: string, acceptance?: readonly string[] }
  | { name: 'user_layer_fix', said: string, widget?: string, to?: string }
  | { name: 'remember', text: string, scope: RememberScope }
  | { name: 'feedback', text: string }
  | { name: 'voice', gender: 'female' | 'male' }
  | { name: 'ask', question: string, options: readonly string[], about?: string }
  | { name: 'confirm', ask_id: string, choice: string }
  | { name: 'chat', reply: string }
  | { name: 'verify', card_id: string, acceptance?: readonly string[] }

/** 每条命令的执行结果,形状一律相同(设计第四节末)。 */
export interface HubResult {
  command: HubCommandName
  ok: boolean
  /** 做了什么(或打算做什么),一句人话,带卡号。 */
  did: string
  why?: string
  next?: string
  card_id?: string
  goal_id?: string
  /** 派给了谁(手的名字)。 */
  who?: string
  /** 这一条变成了一问(ask 命令或护栏挂起)。 */
  /** ask_id:护栏挂起、等她点头的那一问(带回 confirmed 就照原命令办);模型自己的问没有。 */
  ask?: { question: string, options: readonly string[], ask_id?: string }
  /** chat 的原话(回话直接用)。 */
  reply?: string
}

/** 一句话里最多几条命令(多了是模型失控,整份当坏输出)。 */
export const HUB_MAX_COMMANDS = 6

/** 卡号的样子(句子里出现就按卡号认)。 */
export const CARD_ID_RE = /\bt-[0-9a-z]{4,12}\b/giu

/** 名字归一:NFKC + 小写 + 去空白(与 `sayCards.normalizeCardName` 同口径,这里不 import 免得牵上那一侧)。 */
export function normName(raw: string): string {
  return raw.normalize('NFKC').toLowerCase().replace(/\s+/gu, '')
}

/** 「to」认手:id 精确 / 名字归一 / 家名;认不出 undefined。 */
export function resolveHand(raw: unknown, hands: readonly HubHand[]): HubHand | undefined {
  if (typeof raw !== 'string' || raw.trim() === '') return undefined
  const wanted = raw.trim()
  const byId = hands.find(one => one.id === wanted || one.id === wanted.toLowerCase())
  if (byId !== undefined) return byId
  const name = normName(wanted)
  return hands.find(one => normName(one.title) === name)
    // 只说家名(「Claude」「kimi」)时认那一家本身,不认挂在它名下的名片。
    ?? hands.find(one => !one.card && one.family === name)
}

function str(raw: unknown, max = 400): string | undefined {
  if (typeof raw !== 'string') return undefined
  const text = raw.trim()
  return text === '' ? undefined : text.slice(0, max)
}

function strList(raw: unknown, maxItems = 5, maxLen = 120): string[] | undefined {
  if (!Array.isArray(raw)) return undefined
  const out = raw.flatMap(one => (typeof one === 'string' && one.trim() !== '' ? [one.trim().slice(0, maxLen)] : []))
  return out.length === 0 ? undefined : out.slice(0, maxItems)
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/u

/**
 * 把模型给的原始 JSON 收成命令(按上下文包核指向)。认不出的单条拒掉并写明为什么,其余照收;
 * `feedback` 与 `dispatch` 互斥 —— 同一句里两样都有,丢 feedback(点了手就是交代)。
 */
export function parseCommands(raw: unknown, ctx: HubContext): { commands: HubCommand[], rejected: { name: string, why: string }[] } {
  const list = Array.isArray(raw) ? raw : (typeof raw === 'object' && raw !== null && Array.isArray((raw as { commands?: unknown }).commands) ? (raw as { commands: unknown[] }).commands : undefined)
  if (list === undefined) return { commands: [], rejected: [{ name: '?', why: '模型没给命令清单' }] }
  const commands: HubCommand[] = []
  const rejected: { name: string, why: string }[] = []
  const cardIds = new Set(ctx.cards.map(one => one.id))
  const goalIds = new Set(ctx.goals.map(one => one.id))
  const card = (id: unknown): string | undefined => (typeof id === 'string' && cardIds.has(id.trim()) ? id.trim() : undefined)
  const goal = (id: unknown): string | undefined => (typeof id === 'string' && goalIds.has(id.trim()) ? id.trim() : undefined)
  for (const one of list.slice(0, HUB_MAX_COMMANDS)) {
    if (typeof one !== 'object' || one === null) { rejected.push({ name: '?', why: '命令不是对象' }); continue }
    const c = one as Record<string, unknown>
    const name = c.name
    if (typeof name !== 'string' || !(HUB_COMMANDS as readonly string[]).includes(name)) { rejected.push({ name: String(name), why: '不在命令表里' }); continue }
    const reject = (why: string): void => { rejected.push({ name, why }) }
    const needCard = (): string | undefined => {
      const id = card(c.card_id)
      if (id === undefined) reject(typeof c.card_id === 'string' && c.card_id !== '' ? `板上没有 ${c.card_id} 这张卡` : '没指明哪张卡')
      return id
    }
    switch (name as HubCommandName) {
      case 'dispatch': {
        const text = str(c.text, 2000)
        const existing = c.card_id === undefined || c.card_id === null || c.card_id === '' ? undefined : needCard()
        if (c.card_id !== undefined && c.card_id !== null && c.card_id !== '' && existing === undefined) break
        const fresh = typeof c.new === 'object' && c.new !== null ? c.new as Record<string, unknown> : undefined
        const freshTitle = str(fresh?.title, 120)
        if (existing === undefined && freshTitle === undefined) { reject('派活要么指一张卡、要么给新卡标题'); break }
        const to = c.to === undefined || c.to === null || c.to === '' ? undefined : resolveHand(c.to, ctx.hands)
        if (c.to !== undefined && c.to !== null && c.to !== '' && to === undefined) { reject(`不认识「${String(c.to)}」这只手`); break }
        const acceptance = strList(c.acceptance, 5) ?? strList(fresh?.acceptance, 5)
        const goalId = goal(fresh?.goal_id)
        const risk = (HUB_RISKS as readonly unknown[]).includes(c.risk) ? c.risk as HubRisk : undefined
        commands.push({
          name: 'dispatch',
          text: text ?? freshTitle ?? '',
          ...(existing === undefined ? {} : { card_id: existing }),
          ...(existing !== undefined || freshTitle === undefined ? {} : { new: { title: freshTitle, ...(goalId === undefined ? {} : { goal_id: goalId }) } }),
          ...(to === undefined ? {} : { to: to.id }),
          ...(acceptance === undefined ? {} : { acceptance }),
          ...(risk === undefined ? {} : { risk }),
        })
        break
      }
      case 'reassign': {
        const id = needCard()
        if (id === undefined) break
        const to = resolveHand(c.to, ctx.hands)
        if (to === undefined) { reject(typeof c.to === 'string' ? `不认识「${c.to}」这只手` : '改派没说给谁'); break }
        commands.push({ name: 'reassign', card_id: id, to: to.id, restart: c.restart !== false })
        break
      }
      case 'supplement': {
        const id = needCard()
        const text = str(c.text, 2000)
        if (id === undefined) break
        if (text === undefined) { reject('补话没有内容'); break }
        commands.push({ name: 'supplement', card_id: id, text })
        break
      }
      case 'rename': {
        const id = needCard()
        const title = str(c.title, 120)
        if (id === undefined) break
        if (title === undefined) { reject('没说改成什么名'); break }
        commands.push({ name: 'rename', card_id: id, title })
        break
      }
      case 'cancel': {
        const id = needCard()
        if (id !== undefined) commands.push({ name: 'cancel', card_id: id })
        break
      }
      case 'move_status': {
        const id = needCard()
        if (id === undefined) break
        if (!(TASK_STATUSES as readonly unknown[]).includes(c.status)) { reject(`不认识的状态:${String(c.status)}`); break }
        commands.push({ name: 'move_status', card_id: id, status: c.status as TaskStatus })
        break
      }
      case 'set_goal': {
        const id = needCard()
        if (id === undefined) break
        if (c.goal_id === null) { commands.push({ name: 'set_goal', card_id: id, goal_id: null }); break }
        const g = goal(c.goal_id)
        if (g === undefined) { reject(`板上没有 ${String(c.goal_id)} 这个目标`); break }
        commands.push({ name: 'set_goal', card_id: id, goal_id: g })
        break
      }
      case 'goal_status': {
        const g = goal(c.goal_id)
        if (g === undefined) { reject(`板上没有 ${String(c.goal_id)} 这个目标`); break }
        if (!(GOAL_STATUSES as readonly unknown[]).includes(c.status)) { reject(`目标状态只有 open / reached / dropped`); break }
        commands.push({ name: 'goal_status', goal_id: g, status: c.status as GoalStatus })
        break
      }
      case 'goal_create': {
        const title = str(c.title, 120)
        if (title === undefined) { reject('新目标没有标题'); break }
        const due = typeof c.due === 'string' && DATE_RE.test(c.due) ? c.due : undefined
        commands.push({ name: 'goal_create', title, ...(due === undefined ? {} : { due }) })
        break
      }
      case 'goal_due': {
        const g = goal(c.goal_id)
        if (g === undefined) { reject(`板上没有 ${String(c.goal_id)} 这个目标`); break }
        if (c.due !== null && !(typeof c.due === 'string' && DATE_RE.test(c.due))) { reject('截止日要是 YYYY-MM-DD 或 null'); break }
        commands.push({ name: 'goal_due', goal_id: g, due: c.due as string | null })
        break
      }
      case 'note': {
        const title = str(c.title, 120)
        if (title === undefined) { reject('记的事没有标题'); break }
        const g = goal(c.goal_id)
        const acceptance = strList(c.acceptance, 5)
        commands.push({ name: 'note', title, status: c.status === 'backlog' ? 'backlog' : 'todo', ...(g === undefined ? {} : { goal_id: g }), ...(acceptance === undefined ? {} : { acceptance }) })
        break
      }
      case 'user_layer_fix': {
        const said = str(c.said, 2000)
        if (said === undefined) { reject('没说要改什么'); break }
        const widget = str(c.widget, 80)
        const to = c.to === undefined || c.to === null || c.to === '' ? undefined : resolveHand(c.to, ctx.hands)
        if (c.to !== undefined && c.to !== null && c.to !== '' && to === undefined) { reject(`不认识「${String(c.to)}」这只手`); break }
        commands.push({ name: 'user_layer_fix', said, ...(widget === undefined ? {} : { widget }), ...(to === undefined ? {} : { to: to.id }) })
        break
      }
      case 'remember': {
        const text = str(c.text, 400)
        if (text === undefined) { reject('没说记什么规矩'); break }
        const scope = (REMEMBER_SCOPES as readonly unknown[]).includes(c.scope) ? c.scope as RememberScope : 'global'
        commands.push({ name: 'remember', text, scope })
        break
      }
      case 'feedback': {
        const text = str(c.text, 2000)
        if (text === undefined) { reject('反馈没有内容'); break }
        commands.push({ name: 'feedback', text })
        break
      }
      case 'voice': {
        if (c.gender !== 'female' && c.gender !== 'male') { reject('音色只有女声 / 男声'); break }
        commands.push({ name: 'voice', gender: c.gender })
        break
      }
      case 'ask': {
        const question = str(c.question, 300)
        if (question === undefined) { reject('问句是空的'); break }
        const about = card(c.about)
        commands.push({ name: 'ask', question, options: strList(c.options, 4, 60) ?? [], ...(about === undefined ? {} : { about }) })
        break
      }
      case 'confirm': {
        const askId = str(c.ask_id, 80)
        const choice = str(c.choice, 120)
        if (askId === undefined) { reject('没说答哪一问'); break }
        if (choice === undefined) { reject('没说她选的哪个'); break }
        if (list.length > 1) { reject('答挂着的那一问要单独一句'); break }
        commands.push({ name: 'confirm', ask_id: askId, choice })
        break
      }
      case 'chat': {
        const reply = str(c.reply, 600)
        if (reply === undefined) { reject('闲聊没有回话'); break }
        commands.push({ name: 'chat', reply })
        break
      }
      case 'verify': {
        const id = needCard()
        if (id === undefined) break
        const acceptance = strList(c.acceptance, 5)
        commands.push({ name: 'verify', card_id: id, ...(acceptance === undefined ? {} : { acceptance }) })
        break
      }
    }
  }
  // 点了手就是交代:feedback 与 dispatch 互斥(设计第四节)。
  if (commands.some(one => one.name === 'dispatch') && commands.some(one => one.name === 'feedback')) {
    for (let i = commands.length - 1; i >= 0; i -= 1) {
      if (commands[i]!.name === 'feedback') { commands.splice(i, 1); rejected.push({ name: 'feedback', why: '同一句里已经派了活,不再当反馈' }) }
    }
  }
  return { commands, rejected }
}

/** 给模型看的命令表(提示词里的那一段;字段与 {@link parseCommands} 一一对应)。 */
export const COMMAND_TABLE_TEXT = [
  'dispatch {new:{title,goal_id?}|card_id, to?, text, acceptance?[], risk?} —— 派活。默认 new 建新卡;只有她回指已有的那张(卡号 / 那张 / 刚才那件)才给 card_id。to=手的 id(点了名必须给;没点名可省,由执行层按状态挑)。acceptance=原话或点名文件里写的「做到什么算完」,逐条摘,不编。risk 只在这件活本身要花钱(money)、对外发出(external)、动账号设备(account)时给。',
  'reassign {card_id, to, restart?} —— 同一张卡换人(改派 / 换人 / 改给 X / 交给 X 接着做)。旧派发由执行层收场再重派。永不改名。',
  'supplement {card_id, text} —— 给某张卡补一句(补充 / 再加一条要求 / 告诉它…)。先落卡,在跑的会话能捎就捎。',
  'rename {card_id, title} —— 只在原话明说「改名 / 标题改成 / 标题改回」时用。',
  'cancel {card_id} —— 取消 / 不要了 / 撤掉那张卡。',
  'move_status {card_id, status: backlog|todo|doing|confirm|done|blocked|canceled} —— 挪状态(排到待排、标完成、放回待办)。她明说「按通过 / 算通过 / 直接结掉」= 人已判通过 → move_status done(执行层记「人判通过」,不再核验);「核一遍」才是 verify。',
  'set_goal {card_id, goal_id|null} —— 卡归到某个目标下(或移出)。',
  'goal_status {goal_id, status: open|reached|dropped} —— 目标标成达成 / 不要了 / 重新打开。',
  'goal_create {title, due?:YYYY-MM-DD} —— 建一个新目标。',
  'goal_due {goal_id, due:YYYY-MM-DD|null} —— 改目标截止日。',
  'note {title, status: backlog|todo, goal_id?, acceptance?[]} —— 只记一张卡、不派人(记一下 / 建个待办 / 排到待排)。一句里几件就几条。',
  'user_layer_fix {said, widget?, to?} —— 改她自己那一格(那一格在「用户层」里时)。said=她要的改法原话。',
  'remember {text, scope: global|dispatch|content} —— 她明说以后都这样的规矩 / 偏好。',
  'feedback {text} —— 只在:说的是工作台本体的毛病、这台机器上没有源码可改、而且没有点名任何手。与 dispatch 互斥。',
  'voice {gender: female|male} —— 换事务官说话的音色(换个女声 / 男声)。',
  'ask {question, options[], about?} —— 拿不准指哪张 / 做什么时问一句,选项上屏(最多 4 个)。',
  'confirm {ask_id, choice} —— 只在答【挂着等她答的问】里的某一问时用:ask_id 填那一问的,choice 照抄她选的那个选项原话(第一选项=点头照办,其余=不批,执行层会照实办 / 销掉)。这一句里只出 confirm 这一条。',
  'chat {reply} —— 闲聊、问进度、问事:只按上下文包里的事实答;不许说「已派 / 已改」这类办成了的话。',
  'verify {card_id, acceptance?[]} —— 按卡上验收条件核一遍已交回的卡(她说「核一遍那张 / 按条件核一下」;只对「等你确认」的卡,一句几张就几条)。过 → 挪「完成」,不过 → 退修给原执行者,核不了 → 如实说、卡不动记待核。卡上没条件、她这句里带了条件时,把条件逐条给在 acceptance(执行层先落卡再核)。她明说「按通过结掉」不是这条 —— 那是人判通过,走 move_status done。',
].join('\n')
