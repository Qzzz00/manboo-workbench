/**
 * 三入口验收的判定器(2026-10-22,第 0 步「验收成制度」)。
 *
 * 只认两样东西:句子集(`sentences.json`,每句带期望)与一次观察(那一句在某个入口上跑完之后,
 * 回了什么、新建了哪几张卡、推回了几次、音色换没换)。观察怎么取是 `run.ts` 的事,这里不碰网络。
 *
 * 尺子是维护者 10-22 定的:记一笔一轮完成、推回 0 次、卡的数量和标题对、回话一句说全。
 * 一格只给一句原因(最要紧的那一条在前),其余原因与原始事实落在报告下半截。
 */
import { readFileSync } from 'node:fs'

export const ENTRANCES = ['desk', 'phone', 'call'] as const
export type Entrance = typeof ENTRANCES[number]

/**
 * 表里的列:三个入口,外加「电话·文字口」—— 同一组句子塞在工人识别定稿那一格再打一遍电话(`--call both`),
 * 与真音频那一列对照,分得清是听错了还是办错了。它判法与电话那一列相同(句子集里写的是 `call`)。
 */
export const COLUMNS = ['desk', 'phone', 'call', 'callText'] as const
export type Column = typeof COLUMNS[number]

export const ENTRANCE_TITLES: Readonly<Record<Column, string>> = {
  desk: '电脑对话框',
  phone: '手机文字',
  call: '电话',
  callText: '电话·文字口',
}

export const entranceOf = (column: Column): Entrance => (column === 'callText' ? 'call' : column)

export interface CardSpec {
  /** todo = 记下的待办(不派、不开会话);dispatch = 派出去办。 */
  type: 'todo' | 'dispatch'
  assignee?: string
  must: string[]
  mustNot?: string[]
  /** 推回过(拿不准问了一句)时这张可以没有。 */
  optionalIfAsked?: boolean
}

export interface Sentence {
  id: string
  name: string
  turns: string[]
  entrances: Entrance[]
  /** 前几轮是铺垫(挂一句确认),不算这一句的「答」。 */
  setupTurns?: number
  /**
   * 旁人插话:电话那一路拼成「她说到 splitAfter 为止 → 旁人说 say → 她说完」一段音频(同一支麦克风);
   * 文字回合测试口那一路直接塞 asrMixed(识别把两段拼成一句的样子)。
   */
  bystander?: { say: string, splitAfter: string, asrMixed: string }
  expect: {
    rounds: number
    /** 允许推回的上限。 */
    pushBacks: number
    /** 铺垫那几轮必须问(挂着一句确认才有得答)。 */
    setupAsks?: boolean
    bystanderWords?: string[]
    cards: CardSpec[]
    /** 女声 / 男声:这一句跑完音色该是哪一类。 */
    voice?: 'female' | 'male'
    reply?: { groups?: string[][], none?: string[] }
  }
}

/** 一张新卡的事实(从 `/state` 的那张卡上取)。 */
export interface CardFact {
  id: string
  title: string
  status: string
  assignee?: string
  desc?: string
  /** 开了事务官会话。 */
  session: boolean
  /** 派出去办了:在办 / 开了会话 / 有派活记录 / 派不出去挂着阻塞,任一为是。 */
  dispatched: boolean
  /** 卡的种类(topic = 选题 / 发布计划那一类)与排期,只进细节。 */
  kind?: string
  plannedAt?: string
}

export interface TurnFact {
  said: string
  /** 她看到 / 听到的那一句(电脑:回执;手机:气泡;电话:她说的几段连起来)。 */
  reply: string
  /** 这一轮多出来的「等你批 / 等你回答」。 */
  approvalsAdded?: number
  tools?: { name: string, result?: string }[]
  /** 原始回包里那句(电脑、手机:8791 的 note)。只进细节,不参与判定。 */
  raw?: string
  ms?: number
}

export interface Observation {
  sentence: string
  entrance: Entrance
  turns: TurnFact[]
  newCards: CardFact[]
  voice?: { before?: string, after?: string }
  /** 跑的时候出了错(实例没起来、请求失败):单独一档。 */
  error?: string
  /** 这一格没跑(比如电话那一路今天走不通),一句原因。 */
  skipped?: string
  /** 观察时顺手记下的备注(用的是哪条路、哪一步是假的)。 */
  notes?: string[]
}

export type VerdictStatus = 'pass' | 'fail' | 'na' | 'error' | 'skipped'

export interface Verdict {
  status: VerdictStatus
  reasons: string[]
}

const SENTENCES_FILE = new URL('./sentences.json', import.meta.url)

export function loadSentences(file: URL | string = SENTENCES_FILE): Sentence[] {
  return parseSentences(JSON.parse(readFileSync(file, 'utf8')))
}

function strings(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(one => typeof one === 'string')
}

/** 句子集的形状核一遍。错了直接抛,说清是哪一句哪一格 —— 数据文件是手改的。 */
export function parseSentences(raw: unknown): Sentence[] {
  const list = (raw as { sentences?: unknown })?.sentences
  if (!Array.isArray(list)) throw new Error('句子集里没有 sentences 这一格')
  const seen = new Set<string>()
  return list.map((one: unknown, index: number) => {
    const s = one as Partial<Sentence>
    const id = typeof s.id === 'string' && s.id !== '' ? s.id : `第 ${index + 1} 句`
    const bad = (what: string): never => { throw new Error(`句子集 ${id}:${what}`) }
    if (seen.has(id)) bad('id 重了')
    seen.add(id)
    if (typeof s.name !== 'string') bad('缺 name')
    if (!strings(s.turns) || s.turns.length === 0) bad('缺 turns(至少一句)')
    if (!strings(s.entrances) || s.entrances.length === 0) bad('缺 entrances')
    for (const e of s.entrances as string[]) if (!(ENTRANCES as readonly string[]).includes(e)) bad(`入口「${e}」不认识(只认 ${ENTRANCES.join(' / ')})`)
    if (s.bystander !== undefined && !(s.turns as string[])[0]!.includes(s.bystander.splitAfter)) bad(`bystander.splitAfter「${s.bystander.splitAfter}」不在第一句里`)
    const ex = s.expect
    if (ex === undefined || typeof ex.rounds !== 'number' || typeof ex.pushBacks !== 'number') bad('expect 缺 rounds / pushBacks')
    if (!Array.isArray(ex!.cards) || ex!.cards.length === 0) bad('expect.cards 至少一张')
    for (const c of ex!.cards) {
      if (c.type !== 'todo' && c.type !== 'dispatch') bad(`卡的 type 只认 todo / dispatch,写的是 ${String(c.type)}`)
      if (!strings(c.must) || c.must.length === 0) bad('卡的 must 至少一个词')
    }
    return s as Sentence
  })
}

/** 比对用:去空白、不分大小写(识别会把「B 客户」转成「b 客户」,那不是她说错了)。 */
const compact = (text: string): string => text.replace(/\s+/g, '').toLowerCase()

/**
 * 这一句是不是把事推回给她了:有问号(半角 / 全角),或者某一小句以「吗 / 么」收尾。
 * 句中带「要不要」「是不是」而整句是陈述的不算(「到时候要不要真发,你说了算。」)。
 * 等她批 / 等她回答的单子由观察里的 `approvalsAdded` 另算。
 */
export function looksLikeAsk(reply: string): boolean {
  const text = reply.trim()
  if (text === '') return false
  if (/[?\uFF1F]/.test(text)) return true
  return text.split(/[。.!\uFF01;\uFF1B\n…]+/).some(clause => /(?:吗|么)\s*$/.test(clause.trim()))
}

function pushedBack(turn: TurnFact): boolean {
  return looksLikeAsk(turn.reply) || (turn.approvalsAdded ?? 0) > 0
}

function cardFits(spec: CardSpec, card: CardFact): string | undefined {
  const title = compact(card.title)
  const missing = spec.must.filter(word => !title.includes(compact(word)))
  const dirty = (spec.mustNot ?? []).filter(word => title.includes(compact(word)))
  if (spec.type === 'todo' && card.dispatched) return `「${card.title}」被派出去办了(${card.status}${card.session ? '、开了会话' : ''})`
  if (spec.type === 'dispatch' && !card.dispatched) return `「${card.title}」没派出去(${card.status})`
  if (spec.assignee !== undefined && card.assignee !== spec.assignee) return `「${card.title}」派给了 ${card.assignee ?? '没人'},要 ${spec.assignee}`
  if (dirty.length > 0) return `标题「${card.title}」带${dirty.map(w => `「${w}」`).join('')}`
  if (missing.length > 0) return `标题「${card.title}」缺${missing.map(w => `「${w}」`).join('')}`
  return undefined
}

/**
 * 期望的卡与新卡一一配对(张数小,回溯就够)。配不上的那几张给出离它最近那张卡的毛病。
 */
function matchCards(specs: CardSpec[], cards: CardFact[]): { unmatched: { spec: CardSpec, why: string }[] } {
  const n = specs.length
  let best: number[] | undefined
  let bestCount = -1
  const used = new Set<number>()
  const pick: number[] = []
  const walk = (i: number, count: number): void => {
    if (i === n) {
      if (count > bestCount) { bestCount = count; best = [...pick] }
      return
    }
    for (let j = 0; j < cards.length; j += 1) {
      if (used.has(j) || cardFits(specs[i]!, cards[j]!) !== undefined) continue
      used.add(j); pick.push(j)
      walk(i + 1, count + 1)
      used.delete(j); pick.pop()
      if (bestCount === n) return
    }
    pick.push(-1)
    walk(i + 1, count)
    pick.pop()
  }
  walk(0, 0)
  const chosen = new Set((best ?? []).filter(j => j >= 0))
  const unmatched: { spec: CardSpec, why: string }[] = []
  specs.forEach((spec, i) => {
    if ((best ?? [])[i] !== undefined && (best ?? [])[i]! >= 0) return
    const left = cards.filter((_, j) => !chosen.has(j))
    const why = left.length === 0
      ? `没有一张卡对得上「${spec.must.join(' ')}」`
      : left.map(c => cardFits(spec, c)).find(w => w !== undefined) ?? `没有一张卡对得上「${spec.must.join(' ')}」`
    unmatched.push({ spec, why })
  })
  return { unmatched }
}

const isFemale = (voice: string): boolean => /female|女/i.test(voice)
const isMale = (voice: string): boolean => !isFemale(voice) && /male|男/i.test(voice)

export function judge(sentence: Sentence, o: Observation): Verdict {
  if (!sentence.entrances.includes(o.entrance)) {
    return { status: 'na', reasons: [sentence.bystander !== undefined ? '文字入口没有旁人说话这回事' : '这一句不走这个入口'] }
  }
  if (o.skipped !== undefined) return { status: 'skipped', reasons: [o.skipped] }
  if (o.error !== undefined) return { status: 'error', reasons: [o.error] }

  const ex = sentence.expect
  const first: string[] = []
  const rest: string[] = []
  const setup = sentence.setupTurns ?? 0
  const answerTurns = o.turns.slice(setup)
  const pushes = o.turns.filter(pushedBack).length
  const asked = pushes > 0

  // 1 张数与哪几张
  const specs = ex.cards.filter(c => !(c.optionalIfAsked === true && asked))
  const bystander = ex.bystanderWords ?? []
  const strayCards = o.newCards.filter(c => bystander.some(w => compact(c.title).includes(compact(w))))
  if (strayCards.length > 0) first.push(`把别人的话也记成了卡:「${strayCards[0]!.title}」`)
  if (o.newCards.length === 0 && specs.length > 0) {
    first.push('没建成卡')
  }
  else if (o.newCards.length !== specs.length && !(specs.length === 0 && o.newCards.length === 0)) {
    first.push(`要 ${specs.length} 张,建了 ${o.newCards.length} 张(${o.newCards.map(c => `「${c.title}」`).join('、')})`)
  }
  const { unmatched } = matchCards(specs, o.newCards)
  if (o.newCards.length > 0) for (const u of unmatched) (first.length === 0 ? first : rest).push(u.why)

  // 2 铺垫那一轮
  if (ex.setupAsks === true) {
    const setupAsked = o.turns.slice(0, setup).some(pushedBack)
    if (!setupAsked) rest.unshift('铺垫那句没先问(没有挂着的确认可答)')
  }

  // 3 推回
  if (pushes > ex.pushBacks) rest.push(`推回 ${pushes} 次(最多 ${ex.pushBacks})`)
  if (bystander.length > 0 && o.newCards.length === 0 && !asked) first.push('没建也没问')

  // 4 回话
  const reply = answerTurns.map(t => t.reply).join(' ').trim()
  const replyAll = o.turns.map(t => t.reply).join(' ')
  const banned = (ex.reply?.none ?? []).filter(word => replyAll.includes(word))
  if (banned.length > 0) rest.push(`回话里有${banned.map(w => `「${w}」`).join('')}`)
  const groups = ex.reply?.groups ?? []
  const missed = groups.filter(group => !group.some(word => reply.includes(word)))
  if (missed.length > 0 && !(bystander.length > 0 && asked)) {
    rest.push(reply === '' ? '回话是空的' : `回话没说到${missed.map(g => `「${g[0]}」`).join('')}:「${reply.slice(0, 40)}」`)
  }

  // 5 音色
  if (ex.voice !== undefined) {
    const after = o.voice?.after
    if (after === undefined) rest.push('音色读不到')
    else if (o.voice?.before === after) rest.push(`音色没变(${after})`)
    else if (ex.voice === 'female' ? !isFemale(after) : !isMale(after)) rest.push(`音色没换成${ex.voice === 'female' ? '女声' : '男声'}(${after})`)
  }

  const reasons = [...new Set([...first, ...rest])]
  return { status: reasons.length === 0 ? 'pass' : 'fail', reasons }
}

export interface RunResult {
  sentence: Sentence
  entrance: Entrance
  /** 缺席 = 与 entrance 同一列。 */
  column?: Column
  observation: Observation
}

const cell = (text: string): string => text.replace(/\|/g, '/').replace(/\n+/g, ' ')

function cellOf(v: Verdict): string {
  if (v.status === 'pass') return '✔ 过'
  if (v.status === 'na') return `n/a(${cell(v.reasons[0] ?? '')})`
  if (v.status === 'skipped') return `— 没跑:${cell(v.reasons[0] ?? '')}`
  if (v.status === 'error') return `⚠ 出错:${cell(v.reasons[0] ?? '')}`
  return `✘ ${cell(v.reasons[0] ?? '不过')}`
}

/** 报告:先一张「句 × 三入口」的表,下面每格一节细节(轮次、推回、卡、回话原文)。 */
export function renderReport(input: { title: string, meta: string[], sentences: Sentence[], results: RunResult[] }): string {
  const lines: string[] = [`# ${input.title}`, '', ...input.meta.map(m => `- ${m}`), '']
  const columns = COLUMNS.filter(c => c !== 'callText' || input.results.some(r => r.column === 'callText'))
  const find = (s: Sentence, c: Column): RunResult | undefined => input.results.find(r => r.sentence.id === s.id && (r.column ?? r.entrance) === c)
  const verdictOf = (s: Sentence, c: Column): Verdict => {
    const r = find(s, c)
    const e = entranceOf(c)
    if (!s.entrances.includes(e)) return judge(s, { sentence: s.id, entrance: e, turns: [], newCards: [] })
    return r === undefined ? { status: 'skipped', reasons: [''] } : judge(s, r.observation)
  }
  lines.push(`| 句 | ${columns.map(c => ENTRANCE_TITLES[c]).join(' | ')} |`)
  lines.push(`|---|${columns.map(() => '---').join('|')}|`)
  for (const s of input.sentences) {
    const cells = columns.map((c) => {
      const r = find(s, c)
      if (r === undefined && s.entrances.includes(entranceOf(c))) return '— 没跑'
      return cellOf(verdictOf(s, c))
    })
    lines.push(`| ${s.id} ${cell(s.name)} | ${cells.join(' | ')} |`)
  }
  const tally = columns.map((c) => {
    const vs = input.sentences.filter(s => s.entrances.includes(entranceOf(c))).map(s => (find(s, c) === undefined ? 'skipped' : verdictOf(s, c).status))
    return `${ENTRANCE_TITLES[c]} 过 ${vs.filter(v => v === 'pass').length} / ${vs.length}`
  })
  lines.push('', `合计:${tally.join(';')}。`, '', '## 逐格细节', '')
  for (const s of input.sentences) {
    for (const c of columns) {
      const r = find(s, c)
      if (r === undefined) continue
      const v = judge(s, r.observation)
      const o = r.observation
      lines.push(`### ${s.id} · ${ENTRANCE_TITLES[c]}`, '')
      lines.push(`- 判定:${cellOf(v)}${v.reasons.length > 1 ? `;另:${v.reasons.slice(1).join(';')}` : ''}`)
      if (v.status === 'na') { lines.push(''); continue }
      lines.push(`- 轮次 ${o.turns.length};推回 ${o.turns.filter(pushedBack).length} 次`)
      for (const [i, t] of o.turns.entries()) {
        lines.push(`- 第 ${i + 1} 轮 她说:「${t.said}」`)
        lines.push(`  - 回话原文:「${t.reply}」${t.ms === undefined ? '' : `(${t.ms} ms)`}`)
        if (t.raw !== undefined && t.raw !== t.reply) lines.push(`  - 服务端原话:「${t.raw}」`)
        if ((t.approvalsAdded ?? 0) > 0) lines.push(`  - 多出 ${t.approvalsAdded} 件等她批 / 等她回答`)
        if (t.tools !== undefined && t.tools.length > 0) lines.push(`  - 工具:${t.tools.map(tool => `${tool.name}${tool.result === undefined ? '' : ` → ${tool.result.replace(/\s+/g, ' ').slice(0, 120)}`}`).join(';')}`)
      }
      lines.push(`- 卡 ${o.newCards.length} 张${o.newCards.length === 0 ? '' : ':'}`)
      for (const c of o.newCards) {
        lines.push(`  - 「${c.title}」 ${c.status}${c.assignee === undefined ? '' : ` · 负责 ${c.assignee}`}${c.dispatched ? ' · 派了' : ' · 没派'}${c.session ? ' · 开了会话' : ''}${c.kind === undefined ? '' : ` · kind ${c.kind}`}${c.plannedAt === undefined ? '' : ` · 排在 ${c.plannedAt}`}`)
      }
      if (o.voice !== undefined) lines.push(`- 音色:${o.voice.before ?? '?'} → ${o.voice.after ?? '?'}`)
      for (const n of o.notes ?? []) lines.push(`- 注:${n}`)
      if (o.error !== undefined) lines.push(`- 出错:${o.error}`)
      lines.push('')
    }
  }
  return `${lines.join('\n').replace(/\n{3,}/g, '\n\n')}\n`
}
