/**
 * ★ **从她的话里学风格**(2026-10-09,卡「学风格」;设计 `docs/设计-事务官从她的行为里学-2026-10-09.md`
 * 第三节第 3 条、第五节)。学到的是 `habits.ts` 里的第五种习惯 `style`,同一张表、同一套试用 → 留 / 撤、同一份进化日志。
 *
 * 分两半:
 * - **模型只做一件事**:读她的原话(或一条「观察」),从下面这张**固定的风格维度表**里挑候选,并**摘原话当证据**;
 *   摘的那段不在原话里、挑的不在表里,一律丢掉 —— 认不出就不提。
 * - **其余全在代码**:同一候选按表里的 id 认「同一个」(不靠模型判相同);不同的两件事上都出现才试用;
 *   试用里下一次交付她没再这么说 = 留,又说了(或说了相反的)= 撤;撤过的不再自动学回来。
 *
 * 三路证据,走同一道:
 * - **说**:行为账里她对事务官说的原话(含打回时带的那句);
 * - **观察**:每晚下班例程写进 `用户-*.md`「观察」的条目 —— 不再一次性导进规矩表;观察里没原话,以观察原文为证据、标出处;
 * - **改稿**:选题 / 需求的上一版与她存下的那一版按段比,只记改了哪类(`revisionStyleOf`,不经模型)。
 *
 * 风格只管怎么说、怎么交,**不碰权限**:表里没有一条是「问不问她」、花钱、对外、要她亲手做的那四类。
 */
import type { DeckDiffRow } from '../protocol.ts'
import { BEHAVIOR_EVENTS, type BehaviorEntry, type BehaviorInput } from './behaviorLog.ts'
import { splitParagraphs } from './deckRun.ts'
import type { HabitEvidence, StoredHabit } from './habits.ts'

// ───────────────────────────── 风格维度表 ─────────────────────────────

export interface StyleCandidate {
  /** 稳定 id:同一候选就是同一个 id。 */
  id: string
  /** 维度(长短、结论先行……)。 */
  dim: string
  /** 她在嫌什么 / 要什么(给模型认、给她看)。 */
  title: string
  /** 照做的那一句(进规矩那几段)。 */
  rule: string
  /** 改稿里这一类叫什么(只有能从改稿里数出来的才有)。 */
  revision?: string
  /** 相反的那一条(试用里她说了相反的也算纠正)。 */
  opposite?: string
}

export const STYLE_CANDIDATES: readonly StyleCandidate[] = [
  { id: '长短.短', dim: '长短', title: '嫌说得太长、要短', rule: '汇报、回话说短一点:先给要点,细节她问了再展开', revision: '缩短', opposite: '长短.长' },
  { id: '长短.长', dim: '长短', title: '嫌说得太简略、要具体', rule: '说具体一点:关键的经过与依据交代清楚', revision: '加长', opposite: '长短.短' },
  { id: '结论先行', dim: '结论先行', title: '要先听结论', rule: '先说结论,再说经过', revision: '把结论挪到开头' },
  { id: '语气.少客套', dim: '语气', title: '嫌客套话多、要开门见山', rule: '少客套、不寒暄,开门见山', revision: '删了开头客套' },
  { id: '用词.白话', dim: '用词', title: '嫌术语多、要说人话', rule: '说人话,少用术语和英文缩写' },
  { id: '格式.少符号', dim: '格式', title: '嫌列表和符号多', rule: '少用列表和符号,写成几句完整的话', revision: '去掉了列表和符号', opposite: '格式.分点' },
  { id: '格式.分点', dim: '格式', title: '要分点列清楚', rule: '分点列出来,一点一件事', revision: '改成分点', opposite: '格式.少符号' },
  { id: '依据.数据', dim: '依据', title: '要带上数据或例子', rule: '下判断时带上数据或例子', revision: '加了数据' },
]

export function styleCandidate(id: string): StyleCandidate | undefined {
  return STYLE_CANDIDATES.find(one => one.id === id)
}

/** 风格习惯的 id 前缀(规矩那几段据此把它们单列一小节)。 */
export const STYLE_ID_PREFIX = '风格:'
export const styleHabitId = (candidate: string): string => `${STYLE_ID_PREFIX}${candidate}`

// ───────────────────────────── 常量 ─────────────────────────────

/** 不同的几件事上出现同一候选才试用。 */
export const STYLE_MIN_THINGS = 2
/** 数多久以内的候选。 */
export const STYLE_WINDOW_DAYS = 30
/** 一次问模型最多带几句。 */
export const STYLE_BATCH = 8
/**
 * **每天最多问几次模型**(说 + 观察合起来算)。一次一批 8 句,≈ 2k token 进、几百 token 出,
 * 走 V4 Flash(`index.ts askModel`)一次约 ¥0.003;6 次一天封顶约 ¥0.02。认不完的明天接着认。
 */
export const STYLE_DAILY_CALLS = 6
/** 一句原话 / 一条观察最多送几个字去认。 */
export const STYLE_TEXT_MAX = 300
/** 候选留多少条。 */
export const STYLE_NOTES_MAX = 500
/** 认过的观察留多少个指纹。 */
export const STYLE_OBSERVED_MAX = 1000

// ───────────────────────────── 存的形状 ─────────────────────────────

export type StyleSource = '说' | '观察' | '改稿'

/** 一条候选:她在哪件事上、凭哪句话,被认成了表里哪一条。 */
export interface StyleNote {
  at: string
  /** 哪件事(数「不同的两件事」用;`styleThingOf`)。 */
  thing: string
  candidate: string
  /** 证据:她的原话片段 / 观察原文片段 / 改了哪类。 */
  quote: string
  source: StyleSource
  /** 出处(哪一端、哪件事、哪份稿、哪条观察)。 */
  from: string
}

/** 落在 `rules.json` 的 `style` 一节(与 `habits` 同一张表)。 */
export interface StyleState {
  /** 行为账里「说」认到哪一刻了(含)。 */
  said_until?: string
  /** 认过的观察(指纹)。 */
  observed: string[]
  notes: StyleNote[]
  /** 今天问了几次模型。 */
  calls: { day: string, n: number }
}

export function emptyStyleState(): StyleState {
  return { observed: [], notes: [], calls: { day: '', n: 0 } }
}

export function sanitizeStyleState(value: unknown): StyleState | undefined {
  const raw = value as Record<string, unknown> | null
  if (raw === null || typeof raw !== 'object') return undefined
  const sources: readonly StyleSource[] = ['说', '观察', '改稿']
  const notes = Array.isArray(raw.notes)
    ? raw.notes.filter((one): one is StyleNote => one !== null && typeof one === 'object'
      && typeof one.at === 'string' && typeof one.thing === 'string' && typeof one.quote === 'string' && typeof one.from === 'string'
      && styleCandidate(one.candidate) !== undefined && sources.includes(one.source))
    : []
  const calls = raw.calls as { day?: unknown, n?: unknown } | undefined
  return {
    ...(typeof raw.said_until === 'string' ? { said_until: raw.said_until } : {}),
    observed: Array.isArray(raw.observed) ? raw.observed.filter((one): one is string => typeof one === 'string') : [],
    notes,
    calls: typeof calls?.day === 'string' && typeof calls.n === 'number' ? { day: calls.day, n: calls.n } : { day: '', n: 0 },
  }
}

// ───────────────────────────── 哪件事 ─────────────────────────────

/** 对事务官随口说的这两种「对象」不是一件具体的事:每句各算一件,也不算一次交付。 */
const LOOSE_OBJECTS = new Set(['事务官', '问进度'])

export function styleLoose(entry: Pick<BehaviorEntry, '对象'>): boolean {
  return LOOSE_OBJECTS.has(entry.对象.trim())
}

/** 这一条说的是哪件事:卡按卡(id),选题 / 需求按那一份(不分页签),电话按那一通,随口说的每句各算一件。 */
export function styleThingOf(entry: Pick<BehaviorEntry, 'at' | '对象'>): string {
  const object = entry.对象.trim()
  if (LOOSE_OBJECTS.has(object)) return `${object}@${entry.at}`
  if (object.includes(' · ')) return object.split(' · ')[0]?.trim() ?? object
  const parts = object.split(/\s+/)
  if (parts[0] === '通话') return parts.slice(0, 2).join(' ')
  return parts[0] ?? object
}

// ───────────────────────────── 送去认的那几句 ─────────────────────────────

const ACK = /^(好|好的|好滴|行|可以|嗯+|哦|ok|okay|收到|谢谢|多谢|对|是|是的|没问题|继续|知道了)[。.!！~～,，\s]*$/iu

/** 这条值不值得送去认:她的原话(说,或打回 / 通过时带的那句),去掉「好」「收到」这种。 */
export function styleSayable(entry: BehaviorEntry): boolean {
  if (entry.事 !== BEHAVIOR_EVENTS.say && entry.事 !== BEHAVIOR_EVENTS.review) return false
  const text = entry.原话?.trim() ?? ''
  if ([...text].length < 2) return false
  return !ACK.test(text)
}

function clip(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  const chars = [...flat]
  return chars.length > STYLE_TEXT_MAX ? `${chars.slice(0, STYLE_TEXT_MAX).join('')}…` : flat
}

const tableLines = (): string[] => STYLE_CANDIDATES.map(one => `- ${one.id}:${one.title}`)

/** 问模型的那段话。`kind` 决定说明那一句(原话 / 观察)。每句一行、编号,便于逐条核对。 */
export function styleExtractPrompt(texts: readonly string[], kind: 'say' | 'observation'): string {
  return [
    kind === 'say'
      ? '下面是她对事务官(她的助理)说的原话。认一认她在嫌什么、要什么 —— 只关于事务官怎么说话、怎么交东西。'
      : '下面是事务官记下的、关于她的观察(不是她的原话)。认一认里面有没有她对事务官说话、交东西的风格要求。',
    '只能从这张表里挑,表外的一概不提;认不出、拿不准就不提:',
    ...tableLines(),
    '对上的,必须从那一行里**一字不改地照抄**一小段当证据(quote),不许改写、不许概括。',
    '只回 JSON:{"items":[{"n":<行号>,"id":"<表里的 id>","quote":"<照抄的那一段>"}]};一条都对不上就回 {"items":[]}。',
    '',
    ...texts.map((text, index) => `${index + 1}. ${clip(text)}`),
  ].join('\n')
}

const squash = (text: string): string => text.replace(/\s+/g, '')

/**
 * 核对模型的回包:**id 在表里、行号对得上、quote 逐字在那一行里**(空白不计)才留;同一行同一候选只留一次。
 * 回包坏了 = 一条都没有(不抛)。
 */
export function parseStyleReply(reply: string, texts: readonly string[]): { n: number, id: string, quote: string }[] {
  const body = reply.trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '')
  let json: unknown
  try { json = JSON.parse(body) }
  catch {
    const start = body.indexOf('{')
    const end = body.lastIndexOf('}')
    try { json = start >= 0 && end > start ? JSON.parse(body.slice(start, end + 1)) : undefined }
    catch { json = undefined }
  }
  const items = (json as { items?: unknown } | undefined)?.items
  if (!Array.isArray(items)) return []
  const out: { n: number, id: string, quote: string }[] = []
  for (const item of items as Record<string, unknown>[]) {
    if (item === null || typeof item !== 'object') continue
    const n = item.n
    const id = item.id
    const quote = typeof item.quote === 'string' ? item.quote.trim() : ''
    if (typeof n !== 'number' || !Number.isInteger(n) || n < 1 || n > texts.length) continue
    if (typeof id !== 'string' || styleCandidate(id) === undefined) continue
    if ([...squash(quote)].length < 2 || !squash(clip(texts[n - 1] as string)).includes(squash(quote))) continue
    if (out.some(one => one.n === n && one.id === id)) continue
    out.push({ n, id, quote })
  }
  return out
}

// ───────────────────────────── 观察 ─────────────────────────────

export interface ObservationLine { key: string, text: string, date?: string }

/** 简单稳定的指纹(观察那一行认过没有)。 */
function fingerprint(text: string): string {
  let h = 2166136261
  for (const ch of text) {
    h ^= ch.codePointAt(0) as number
    h = Math.imul(h, 16777619)
  }
  return (h >>> 0).toString(16).padStart(8, '0')
}

/** `用户-*.md`「## 观察…」一节里的条目(以 `-` / `*` 开头的那几行)。 */
export function observationLines(markdown: string): ObservationLine[] {
  const lines = markdown.split('\n')
  const start = lines.findIndex(line => /^##\s*观察/u.test(line))
  if (start === -1) return []
  let end = lines.findIndex((line, index) => index > start && /^##\s/u.test(line))
  if (end === -1) end = lines.length
  const out: ObservationLine[] = []
  for (const line of lines.slice(start + 1, end)) {
    const m = /^\s*[-*]\s+(.+)$/u.exec(line)
    if (m === null) continue
    const text = (m[1] ?? '').trim()
    if (text === '') continue
    const date = /(\d{4}-\d{2}-\d{2})/u.exec(text)?.[1]
    out.push({ key: fingerprint(text), text, ...(date === undefined ? {} : { date }) })
  }
  return out
}

// ───────────────────────────── 改稿 ─────────────────────────────

const GREETING = /^(您好|你好|大家好|哈喽|嗨|hi\b|hello|各位|亲爱的|宝子们|姐妹们|感谢|谢谢|很高兴|首先|今天给大家|今天和大家)/iu
const MARKERS = /^\s*(?:[-*•]|\d+[.、)])\s+|\*\*|^\s*#{1,6}\s/gmu
const NUMBERS = /\d+(?:\.\d+)?\s*(?:%|％)?/gu

const charsOf = (paragraphs: readonly string[]): number => [...paragraphs.join('')].length
const countOf = (text: string, re: RegExp): number => (text.match(re) ?? []).length

/**
 * 上一版(事务官 / 别家写的)与她存下的那一版按段比,只认改了哪几类(表里的 id)。**不经模型**。
 * 只改个错字、调个词 = 一类都不认。
 */
export function revisionStyleOf(before: string, after: string): string[] {
  const a = splitParagraphs(before)
  const b = splitParagraphs(after)
  if (a.length === 0 || b.length === 0) return []
  const out: string[] = []
  const greetingCut = GREETING.test(a[0] as string) && !GREETING.test(b[0] as string)
  if (greetingCut) out.push('语气.少客套')
  // 结论挪到开头:她的第一段是原来后面的一段,原来的第一段还在(挪下去了,不是删了)。
  const moved = a.indexOf(b[0] as string)
  if (moved >= 1 && b.includes(a[0] as string)) out.push('结论先行')
  const lenA = charsOf(a)
  const lenB = charsOf(b)
  if (lenA >= 80 && lenB <= lenA * 0.7) out.push('长短.短')
  else if (lenA >= 40 && lenB >= lenA * 1.5) out.push('长短.长')
  if (countOf(after, NUMBERS) - countOf(before, NUMBERS) >= 2) out.push('依据.数据')
  const markA = countOf(before, MARKERS)
  const markB = countOf(after, MARKERS)
  if (markA >= 3 && markB * 2 <= markA) out.push('格式.少符号')
  else if (markB >= 3 && markB >= Math.max(markA, 1) * 2) out.push('格式.分点')
  return out
}

/** 存稿时回的那份段落级 diff → 两版各是什么 → 改了哪几类(`saveDeckDoc` 已经比过一遍,不再读 `修订/`)。 */
export function revisionStyleOfDiff(rows: readonly DeckDiffRow[]): string[] {
  const before = rows.filter(row => row.kind !== 'add').map(row => row.text).join('\n\n')
  const after = rows.filter(row => row.kind !== 'del').map(row => row.text).join('\n\n')
  return revisionStyleOf(before, after)
}

/** 进行为账的那一条「改稿」:结果写人话,类写表里的 id(逗号隔开)。一类都没认出来就不记。 */
export function revisionNoteOf(input: { 对象: string, ids: readonly string[] }): Omit<BehaviorInput, '端'> | undefined {
  const ids = input.ids.filter(id => styleCandidate(id)?.revision !== undefined)
  if (ids.length === 0) return undefined
  return {
    事: BEHAVIOR_EVENTS.revise,
    对象: input.对象,
    结果: ids.map(id => styleCandidate(id)?.revision ?? id).join('、'),
    类: ids.join(','),
  }
}

const revisionIdsOf = (entry: BehaviorEntry): string[] =>
  (entry.类 ?? '').split(',').map(one => one.trim()).filter(id => styleCandidate(id) !== undefined)

/** 行为账里的「改稿」→ 候选(现算,不落盘;账留 90 天,窗口只看 30 天)。 */
export function styleNotesOfRevisions(entries: readonly BehaviorEntry[]): StyleNote[] {
  const out: StyleNote[] = []
  for (const entry of entries) {
    if (entry.事 !== BEHAVIOR_EVENTS.revise) continue
    for (const id of revisionIdsOf(entry)) {
      out.push({ at: entry.at, thing: styleThingOf(entry), candidate: id, quote: styleCandidate(id)?.revision ?? id, source: '改稿', from: `改稿 · ${entry.对象}` })
    }
  }
  return out
}

// ───────────────────────────── 计数 → 试用 ─────────────────────────────

const pad = (n: number): string => String(n).padStart(2, '0')

function stamp(iso: string): string {
  const d = new Date(iso)
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

export function styleEvidenceOf(note: StyleNote): HabitEvidence {
  if (note.source === '观察') return { at: note.at, what: `观察里记着「${note.quote}」(出处:${note.from})` }
  if (note.source === '改稿') return { at: note.at, what: `${stamp(note.at)} 她改稿时${note.quote}(出处:${note.from})` }
  return { at: note.at, what: `${stamp(note.at)} 她说「${note.quote}」(出处:${note.from})` }
}

const live = (habit: Pick<StoredHabit, 'status'>): boolean => habit.status === 'trial' || habit.status === 'kept'

/** 不同的两件事上出现同一候选 → 试用。撤过的不再学;相反的那条还算数时不学(先等那条验出结果)。 */
export function findStyleHabits(notes: readonly StyleNote[], known: readonly StoredHabit[], nowMs: number): StoredHabit[] {
  const from = nowMs - STYLE_WINDOW_DAYS * 86_400_000
  const recent = notes
    .filter((one) => { const t = Date.parse(one.at); return !Number.isNaN(t) && t >= from && t <= nowMs })
    .sort((a, b) => a.at.localeCompare(b.at))
  const out: StoredHabit[] = []
  for (const candidate of STYLE_CANDIDATES) {
    const id = styleHabitId(candidate.id)
    if (known.some(one => one.id === id)) continue
    if (candidate.opposite !== undefined && known.some(one => one.id === styleHabitId(candidate.opposite as string) && live(one))) continue
    const hits = recent.filter(one => one.candidate === candidate.id)
    if (new Set(hits.map(one => one.thing)).size < STYLE_MIN_THINGS) continue
    const at = new Date(nowMs).toISOString()
    out.push({
      id,
      kind: 'style',
      类: candidate.dim,
      value: candidate.id,
      text: candidate.rule,
      status: 'trial',
      evidence: hits.slice(-10).map(styleEvidenceOf),
      applied: [],
      created_at: at,
      updated_at: at,
      adopted_at: at,
      from: [...new Set(hits.map(one => one.source))],
    })
  }
  return out
}

// ───────────────────────────── 验 ─────────────────────────────

/**
 * 试用的这一条验出结论没有。看试用之后**第一次交付**她的反应:
 * - 她说的话(说 / 打回带的那句)认出了同一候选或相反那条 = 撤(随口对事务官说的也算);
 * - 一件具体的事上她回了话、没再提 = 留;通过 / 打回那一下没再提 = 留;下一份稿她改了、没改这一类 = 留,又改了这一类 = 撤。
 * - 从改稿学来的,同类交付是下一份稿:只认改稿与选题 / 需求的通过 / 打回。
 * - 还没送去认的那句(`saidUntil` 之后)先不下结论,等认过再说。
 */
export function verifyStyleHabit(
  habit: StoredHabit,
  notes: readonly StyleNote[],
  entries: readonly BehaviorEntry[],
  saidUntil: string | undefined,
): { status: StoredHabit['status'], why: string } {
  const targets = new Set([habit.value, styleCandidate(habit.value)?.opposite].filter((one): one is string => one !== undefined))
  const draftsOnly = (habit.from ?? []).length > 0 && (habit.from ?? []).every(one => one === '改稿')
  const sorted = entries.filter(one => one.at > habit.adopted_at).sort((a, b) => a.at.localeCompare(b.at))
  for (const entry of sorted) {
    if (entry.事 === BEHAVIOR_EVENTS.revise) {
      const hit = revisionIdsOf(entry).find(id => targets.has(id))
      if (hit !== undefined) return { status: 'reverted', why: `${stamp(entry.at)}《${entry.对象}》她改稿时又${styleCandidate(hit)?.revision ?? hit}` }
      return { status: 'kept', why: `${stamp(entry.at)}《${entry.对象}》她改了稿,没再${styleCandidate(habit.value)?.revision ?? '改这一处'}` }
    }
    const said = styleSayable(entry)
    if (said) {
      if (saidUntil === undefined || entry.at > saidUntil) return { status: 'trial', why: '试用之后她说的话还没认过' }
      const thing = styleThingOf(entry)
      const hit = notes.find(one => one.source === '说' && one.at === entry.at && one.thing === thing && targets.has(one.candidate))
      if (hit !== undefined) return { status: 'reverted', why: `${stamp(entry.at)} 她又说「${hit.quote}」` }
    }
    if (entry.事 === BEHAVIOR_EVENTS.review && (entry.结果 === '通过' || entry.结果 === '打回')) {
      if (draftsOnly && !/^(选题|需求)\s/u.test(entry.对象)) continue
      return { status: 'kept', why: `${stamp(entry.at)}《${entry.对象}》她${entry.结果}了,没再提这一处` }
    }
    if (said && entry.事 === BEHAVIOR_EVENTS.say && !draftsOnly && !styleLoose(entry)) {
      return { status: 'kept', why: `${stamp(entry.at)}《${entry.对象}》她回了话,没再提这一处` }
    }
    if (!said && entry.事 === BEHAVIOR_EVENTS.say && !draftsOnly && !styleLoose(entry) && (entry.原话?.trim() ?? '') !== '') {
      return { status: 'kept', why: `${stamp(entry.at)}《${entry.对象}》她回了一句「${entry.原话?.trim()}」,没再提这一处` }
    }
  }
  return { status: 'trial', why: '试用之后还没有下一次交付' }
}
