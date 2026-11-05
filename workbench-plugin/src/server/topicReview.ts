/**
 * 复盘的沉淀(2026-09-22 卡④,设计-运营事务官指挥做事 §一「复盘」那一行 + §〇 第 3 条)。
 *
 * ## 这一份要解决的事
 *
 * 技能 `docs/技能/运营-复盘.md` 让她**先自评再由事务官总结**,顺序是对的;
 * 但那份自评**只活在对话里** —— 她打的分、她说的「最好的是哪一部分」、
 * 「重做一次会改哪里」,聊完就散了。下一次复盘、下一次定稿,谁都读不到它。
 *
 * 所以这里给 `选题/<名>/复盘.md` 钉一个**固定结构的自评段**,并且让它**同时**
 * 往 `账号/<名>/经验.md` 里追加一句 —— 一次复盘要落两处:
 *
 * | 落在哪 | 是什么 | 谁读它 |
 * |---|---|---|
 * | `选题/<名>/复盘.md` 的「自评」节 | 这一条内容的分数与三句话 | 下次深度复盘、卡上的「复盘」页签 |
 * | `账号/<名>/经验.md` | 那一句**可复用**的经验 | 下班例程回写画像 → 事务官下一次先读 |
 *
 * ## 五格,一格不多
 *
 * 自评分 / 好在哪 / 差在哪 / 下次怎么做 / 经验一句话。前四格逐字对应复盘技能
 * 「步骤 · 单篇复盘」第 2 步那三问加一个分数;第五格是这张卡新加的那一件
 * (「每一次复盘都是给 AI 的一次学习」)。
 *
 * ## 三条纪律
 *
 * 1. **一个字都不代她写**。五格全空 → 拒绝,不生成一份空壳复盘;
 *    她只填了两格就只写那两格,别的格**整行不出现**(不是写「未填」)。
 * 2. **只追加不覆盖**。同一条选题复盘两次 = 两节,按日期排;一模一样的一节
 *    不写第二遍(同一次点两下不该出现两条)。
 * 3. **经验那一句写不进去不算整件事失败**。`复盘.md` 已经落盘了是事实,
 *    经验没落是第二件事 —— 如实回,不回滚(同 `/topic/open` 那条「目录建出来了,
 *    Finder 没弹出来是第二件事」)。
 */
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { ReviewLogStats } from './accounts.ts'
import { appendExperienceIn, parseReviewLog } from './accounts.ts'
import { isSafeTopicName, topicDirOf } from './topicAssets.ts'

/** `选题/<名>/复盘.md`。与 templates.ts 的 `TOPIC_DELIVERABLE_FILES.复盘` 同一个字面量。 */
export const TOPIC_REVIEW_FILE = '复盘.md'

/**
 * 自评那五格。**顺序就是文件里的顺序**(一处定义两处用,同 ACCOUNT_FIELDS 那条 F1)。
 * `key` 是接口字段名,`label` 是文件里那一行的中文。
 */
export const TOPIC_REVIEW_FIELDS = [
  { key: 'score', label: '自评分' },
  { key: 'good', label: '好在哪' },
  { key: 'bad', label: '差在哪' },
  { key: 'next', label: '下次怎么做' },
  { key: 'lesson', label: '经验一句话' },
] as const

export type TopicReviewFieldKey = typeof TOPIC_REVIEW_FIELDS[number]['key']

export interface TopicReview {
  /** 1–5。技能里那一问就是「这条你自己打几分(1-5)」。 */
  score?: number
  good?: string
  bad?: string
  next?: string
  /** 可复用的那一句,会同时追加进 `账号/<名>/经验.md`。 */
  lesson?: string
}

/** 校验结果:`ok:false` 时 `reason` 是一句原话,原样回给调用方(400)。 */
export type ValidateResult = { ok: true, review: TopicReview } | { ok: false, reason: string }

function textField(raw: unknown, label: string): { ok: true, value?: string } | { ok: false, reason: string } {
  if (raw === undefined || raw === null) return { ok: true }
  if (typeof raw !== 'string') return { ok: false, reason: `${label} 必须是字符串` }
  const value = raw.trim()
  if (value === '') return { ok: true } // 空串 = 这一格没填,不是错。
  if (value.length > 2000) return { ok: false, reason: `${label} 太长了(最多 2000 字)` }
  return { ok: true, value }
}

/**
 * 收一份自评。**五格全空就拒绝** —— 那不是一次复盘,是一次空点击,
 * 写下去等于在她的选题目录里留一份什么都没说的 `复盘.md`(比没有更糟)。
 */
export function validateTopicReview(raw: Record<string, unknown>): ValidateResult {
  const review: TopicReview = {}

  if (raw.score !== undefined && raw.score !== null) {
    const score = typeof raw.score === 'string' ? Number(raw.score.trim()) : raw.score
    if (typeof score !== 'number' || !Number.isInteger(score) || score < 1 || score > 5) {
      return { ok: false, reason: '自评分要是 1 到 5 的整数(技能里那一问就是 1-5)' }
    }
    review.score = score
  }

  for (const field of TOPIC_REVIEW_FIELDS) {
    if (field.key === 'score') continue
    const got = textField(raw[field.key], field.label)
    if (!got.ok) return got
    if (got.value !== undefined) review[field.key] = got.value
  }

  const filled = TOPIC_REVIEW_FIELDS.some(field => review[field.key] !== undefined)
  if (!filled) return { ok: false, reason: '五格一格都没填 —— 自评分 / 好在哪 / 差在哪 / 下次怎么做 / 经验一句话,至少要有一格' }
  return { ok: true, review }
}

/** 新的 `复盘.md` 骨架。第二行那句「由…生成于…依据」与八份技能的产物同一个格式。 */
export function newReviewFile(topic: string, input: { date: string, origin: string }): string {
  return [
    `# ${topic} · 复盘`,
    '',
    `> 由${input.origin}写于 ${input.date}。「自评」几节是她自己打的分与原话,**工作台一个字没改**;`,
    '> 事务官的总结与深度复盘按 `docs/技能/运营-复盘.md` 另起「单篇」「深度」两节。',
    '',
  ].join('\n')
}

/** 一节自评。她没填的格**整行不出现** —— 不写「未填」,那是拿占位词冒充回答。 */
export function renderReviewSection(review: TopicReview, input: { date: string, origin: string }): string {
  const lines = [`## 自评(${input.date})`]
  for (const field of TOPIC_REVIEW_FIELDS) {
    const value = review[field.key]
    if (value === undefined) continue
    lines.push(`- **${field.label}**:${field.key === 'score' ? `${value as number}/5` : value as string}`)
  }
  lines.push(`- **谁填的**:${input.origin}`)
  lines.push('')
  return lines.join('\n')
}

/**
 * 把一节自评追加到 `复盘.md` 末尾。**一模一样的一节已经在了就不动**
 * (同一次点两下 / 事务官重放一遍,不该出现两条)。
 */
export function appendReviewSection(text: string, section: string): { text: string, changed: boolean } {
  if (text.includes(section.trimEnd())) return { text, changed: false }
  const base = text.endsWith('\n') || text === '' ? text : `${text}\n`
  return { text: `${base}${base.endsWith('\n\n') || base === '' ? '' : '\n'}${section}`, changed: true }
}

export interface WriteTopicReviewOptions {
  /** `<工作目录>/选题` 的绝对路径(来自 `/state.template.asset_dirs`,**不自己拼**)。 */
  topicsDir: string
  /** `<工作目录>/账号` 的绝对路径 —— 经验那一句落 `<它>/<账号名>/经验.md`。 */
  accountsRoot: string
  /** 选题名(= 目录名)。 */
  name: string
  review: TopicReview
  /** 这条选题归哪个账号。缺席 = 经验那一句没地方落,**如实说**,不猜一个账号。 */
  account?: string
  date: string
  /** 谁填的(「她在界面上填的」/「事务官代填」)。 */
  origin: string
}

export interface WriteTopicReviewResult {
  ok: boolean
  reason?: string
  /** `复盘.md` 的绝对路径。 */
  path?: string
  /** 真的追加了一节(false = 一模一样的一节已经在了)。 */
  appended?: boolean
  /** 经验那一句的落点与结果。**没有经验一句话 / 没给账号时整块缺席**。 */
  experience?: { ok: boolean, path?: string, appended?: boolean, reason?: string }
  /** 一句实话:经验为什么没落。 */
  note?: string
}

/**
 * 写自评:`复盘.md` 追加一节(+ 必要时建目录与骨架),经验一句话追加进 `账号/<名>/经验.md`。
 *
 * **两件事分开成败**:复盘落了、经验没落,照样 `ok: true` 并把原因写进 `note` ——
 * 把已经发生的事说成失败,她会再点一次,于是复盘里多一节一模一样的(所以上面那条幂等也要在)。
 */
export async function writeTopicReview(opts: WriteTopicReviewOptions): Promise<WriteTopicReviewResult> {
  if (!isSafeTopicName(opts.name)) return { ok: false, reason: '选题名不能带 / 或 \\,也不能以点开头' }
  const dir = topicDirOf(opts.topicsDir, opts.name)
  if (dir === undefined) return { ok: false, reason: '选题名不能带 / 或 \\,也不能以点开头' }
  const file = join(dir, TOPIC_REVIEW_FILE)
  const topic = opts.name.trim()

  let appended: boolean
  try {
    await mkdir(dir, { recursive: true })
    let text: string
    try { text = await readFile(file, 'utf8') }
    catch { text = newReviewFile(topic, { date: opts.date, origin: opts.origin }) }
    const next = appendReviewSection(text, renderReviewSection(opts.review, { date: opts.date, origin: opts.origin }))
    if (next.changed) await writeFile(file, next.text, 'utf8')
    appended = next.changed
  }
  catch (error) {
    return { ok: false, reason: `写不了 ${TOPIC_REVIEW_FILE}:${error instanceof Error ? error.message : String(error)}` }
  }

  const lesson = opts.review.lesson
  if (lesson === undefined) return { ok: true, path: file, appended }
  if (opts.account === undefined || opts.account.trim() === '') {
    return { ok: true, path: file, appended, note: '经验那一句没落:这条选题没说归哪个账号(不猜一个)' }
  }
  const experience = await appendExperienceIn(opts.accountsRoot, opts.account, {
    lesson,
    date: opts.date,
    origin: `《${topic}》复盘自评`,
  })
  return {
    ok: true,
    path: file,
    appended,
    experience,
    ...(experience.ok ? {} : { note: `经验那一句没落:${experience.reason ?? '写不进去'}` }),
  }
}


/** —— 把关记录:`选题/<名>/审核记录.jsonl`(卡 ② 写,这里只读) —— */

/** 一行一个 JSON:`{ at, doc, action, note }`。**不存在是常态**(卡 ② 还没落过、或者她没把过关)。 */
export const TOPIC_REVIEW_LOG_FILE = '审核记录.jsonl'

/**
 * 把**所有**选题的审核记录合起来数一遍。
 *
 * 为什么是「所有选题」而不是「这个账号的选题」:审核记录挂在选题目录上,
 * 选题归哪个账号要走看板(`project_id`)才知道;而「她把关的习惯」本来就是**她**的习惯,
 * 不是某个账号的。所以画像段里那一行会写清楚口径是 `选题/*`,不假装它按账号分过。
 *
 * 目录不在 / 某一份读不了 → **安静跳过**(同 topicAssets 那条「读不到不等于出错」)。
 */
export async function readReviewLogs(topicsDir: string, maxNotes = 3): Promise<ReviewLogStats> {
  let names: string[]
  try {
    const entries = await readdir(topicsDir, { withFileTypes: true })
    names = entries.filter(entry => entry.isDirectory() && !entry.name.startsWith('.')).map(entry => entry.name)
  }
  catch {
    return { total: 0, by_action: [], notes: [] }
  }
  // 选题名排序是确定的(同 listAccountNames 那条:码位序,换台机器顺序也一样)。
  names.sort((a, b) => a.localeCompare(b, 'en'))
  const texts: string[] = []
  for (const name of names) {
    try { texts.push(await readFile(join(topicsDir, name, TOPIC_REVIEW_LOG_FILE), 'utf8')) }
    catch { continue }
  }
  return parseReviewLog(texts.join('\n'), maxNotes)
}
