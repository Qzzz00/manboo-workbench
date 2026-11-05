/**
 * 「卡 = 指挥台」的**通用那一半**(2026-09-22,`docs/审视-用户到底得到什么-2026-09-22.md` 第三节)。
 *
 * 审视第三节的结论逐字:**两条模板要的是同一个东西 ——「卡 = 指挥台」+「产物回卡」
 * +「把关留痕」+「回写画像」**。选题卡(运营)与需求卡(做产品)之间只差三样:
 *
 * 1. 页签叫什么、各自落哪个文件;
 * 2. 段叫什么、这一段该派给谁;
 * 3. 交给事务官的那段话怎么拼。
 *
 * 除此之外一个字不差:同一套段落级 diff、同一个 `修订/` 快照、同一份 `审核记录.jsonl`、
 * 同一套"读不到不等于出错"的分寸。**那些就搬进这个文件**,两边各自只留自己那三样。
 *
 * ## 这个文件是怎么来的
 *
 * 它是 2026-09-22 夜 `server/topicRun.ts` 里那些函数**原样搬过来**的:
 * 名字、注释、边界条件(`DIFF_MAX_PARAGRAPHS` 超了不比、坏行跳过、ENOENT 不是错)
 * 一处都没改。`topicRun.ts` 现在从这里拿,对外那一份 API 与用例**一个字没变**。
 * 需求卡不是"照着抄一遍",是**用同一份**。
 *
 * ## 目录约定(两种卡共用)
 *
 * ```
 * <卡的目录>/
 *   <产物>.md …           ← 页签读写的就是它们(哪几个由调用方给)
 *   审核记录.jsonl        ← 把关留痕(一行一条 DeckReviewEntry)
 *   修订/<文件名>.<时刻>  ← 每次写回之前把上一版留一份,diff 拿它比
 * ```
 */
import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { DeckDiffRow, DeckDocView, DeckReviewEntry } from '../protocol.ts'

export const REVIEW_LOG_NAME = '审核记录.jsonl'
export const REVISIONS_DIR = '修订'

/* ──────────────────────── 段落级 diff ──────────────────────── */

/**
 * 一段文本拆成段落。**空行分段**,段内的换行原样留着(markdown 的列表、代码块是一段)。
 * 首尾空白去掉;全空的段丢掉(否则 diff 里会出现一堆看不见的"改动")。
 */
export function splitParagraphs(text: string): string[] {
  return text.split(/\n[ \t]*\n/).map(one => one.trim()).filter(one => one !== '')
}

/**
 * 一次 diff 最多比多少段。超了**不比**,如实说一句(见 `diffParagraphs` 的返回)——
 * LCS 是 O(n²),一份几千段的稿子能把这一拍卡住;而一个悄悄算了一半的 diff 比没有更坏。
 */
export const DIFF_MAX_PARAGRAPHS = 400

/**
 * 段落级 diff(最长公共子序列)。**`same` 也回**:只给增删两种,读的人对不上位置。
 *
 * 两边都空 → 空数组(没有"没改动"这条要说的);超过 `DIFF_MAX_PARAGRAPHS` → 回 undefined,
 * 由调用方说「这份太长了,这一轮没比」——不静默给一个只比了前面那些的 diff(D13)。
 */
export function diffParagraphs(before: string, after: string): DeckDiffRow[] | undefined {
  const a = splitParagraphs(before)
  const b = splitParagraphs(after)
  if (a.length > DIFF_MAX_PARAGRAPHS || b.length > DIFF_MAX_PARAGRAPHS) return undefined
  if (a.length === 0 && b.length === 0) return []

  // LCS 表:lcs[i][j] = a.slice(i) 与 b.slice(j) 的最长公共子序列长度。
  const lcs: number[][] = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0))
  for (let i = a.length - 1; i >= 0; i -= 1) {
    for (let j = b.length - 1; j >= 0; j -= 1) {
      const row = lcs[i] as number[]
      const next = lcs[i + 1] as number[]
      row[j] = a[i] === b[j]
        ? (next[j + 1] as number) + 1
        : Math.max(next[j] as number, row[j + 1] as number)
    }
  }

  const out: DeckDiffRow[] = []
  let i = 0
  let j = 0
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) { out.push({ kind: 'same', text: a[i] as string }); i += 1; j += 1; continue }
    const down = (lcs[i + 1] as number[])[j] as number
    const right = (lcs[i] as number[])[j + 1] as number
    // 并列时先出「删」再出「增」:同一处改写读起来是"原来这么写 → 现在这么写"。
    if (down >= right) { out.push({ kind: 'del', text: a[i] as string }); i += 1 }
    else { out.push({ kind: 'add', text: b[j] as string }); j += 1 }
  }
  for (; i < a.length; i += 1) out.push({ kind: 'del', text: a[i] as string })
  for (; j < b.length; j += 1) out.push({ kind: 'add', text: b[j] as string })
  return out
}

/** 这份 diff 里有没有真改动。全是 `same` = 这一轮什么都没改,界面据此不画那一块。 */
export function diffHasChange(rows: readonly DeckDiffRow[] | undefined): boolean {
  return rows !== undefined && rows.some(row => row.kind !== 'same')
}

/* ──────────────────────── 读写产物 ──────────────────────── */

/** 读一个文件;不存在回 undefined(**不是错**),别的错抛出去。 */
export async function readIfThere(path: string): Promise<string | undefined> {
  try { return await readFile(path, 'utf8') }
  catch (error) {
    if ((error as { code?: string }).code === 'ENOENT') return undefined
    throw error
  }
}

/** 一个文件最后改动的时刻(ISO)。读不到回 undefined —— 不编一个"刚刚"。 */
async function mtimeOf(path: string): Promise<string | undefined> {
  try { return (await stat(path)).mtime.toISOString() }
  catch { return undefined }
}

/**
 * `修订/` 里这个文件名最新的那一份的内容。一份都没有回 undefined。
 *
 * 快照名是 `<文件名>.<可排序时刻>`(`框架.md.2026-09-22T13-40-05-123Z`),
 * 所以**按名字排序就是按时间排序**,不用 stat 每一个。
 */
async function newestRevision(dir: string, file: string): Promise<string | undefined> {
  let names: string[]
  try {
    names = (await readdir(join(dir, REVISIONS_DIR), { withFileTypes: true }))
      .filter(entry => entry.isFile() && entry.name.startsWith(`${file}.`))
      .map(entry => entry.name)
      .sort()
  }
  catch { return undefined }
  const newest = names[names.length - 1]
  return newest === undefined ? undefined : readIfThere(join(dir, REVISIONS_DIR, newest))
}

/**
 * 几个页签一次全读回来(**一次问一批**:每个页签各发一个请求等于把一次目录读拆成七次)。
 *
 * 每一份都带上「与上一版比这一轮改了什么」:上一版在 `修订/` 里,没有上一版就没有 diff。
 */
export async function readDeckDocs<Tab extends string>(
  dir: string,
  tabs: readonly Tab[],
  files: Readonly<Record<Tab, string>>,
): Promise<DeckDocView<Tab>[]> {
  const out: DeckDocView<Tab>[] = []
  for (const tab of tabs) {
    const file = files[tab]
    const path = join(dir, file)
    let text: string | undefined
    let error: string | undefined
    try { text = await readIfThere(path) }
    catch (caught) { error = `读不了 ${file}:${(caught as Error).message}` }

    const previous = text === undefined ? undefined : await newestRevision(dir, file)
    const diff = previous === undefined || text === undefined ? undefined : diffParagraphs(previous, text)
    const updatedAt = text === undefined ? undefined : await mtimeOf(path)
    out.push({
      tab,
      file,
      exists: text !== undefined,
      ...(text === undefined ? {} : { text }),
      ...(updatedAt === undefined ? {} : { updated_at: updatedAt }),
      ...(diffHasChange(diff) ? { diff: diff as DeckDiffRow[] } : {}),
      ...(error === undefined ? {} : { error }),
    })
  }
  return out
}

/** 快照名里那一截时刻。冒号与点在文件名里能用,但难认也难排 —— 一律换成 `-`。 */
export function revisionStamp(at: Date): string {
  return at.toISOString().replace(/[:.]/g, '-')
}

export interface SaveDeckDocResult {
  ok: boolean
  reason?: string
  /** 这一次写回改了什么(与写之前那一版比)。新建的那一次没有(**不是"全加"**)。 */
  diff?: readonly DeckDiffRow[]
  /** 这一份太长,没比 diff。如实说一句。 */
  diff_note?: string
}

/**
 * 把一份产物写回文件。**写之前先把上一版存进 `修订/`** —— 她自己改与事务官改都走这里,
 * 所以「每一轮改了什么」才有得比。
 *
 * 新建的那一次不存快照(没有"上一版"这回事),也不给 diff:
 * 把一份新稿子整个标成"新增"是噪音,不是信息。
 */
export async function saveDeckDoc(input: {
  dir: string
  file: string
  text: string
  now: Date
}): Promise<SaveDeckDocResult> {
  const { dir, file } = input
  const path = join(dir, file)
  let previous: string | undefined
  try { previous = await readIfThere(path) }
  catch (error) { return { ok: false, reason: `读不了原来那一版 ${file}:${(error as Error).message}` } }

  try {
    if (previous !== undefined) {
      await mkdir(join(dir, REVISIONS_DIR), { recursive: true })
      await writeFile(join(dir, REVISIONS_DIR, `${file}.${revisionStamp(input.now)}`), previous, 'utf8')
    }
    else {
      await mkdir(dir, { recursive: true })
    }
    await writeFile(path, input.text, 'utf8')
  }
  catch (error) {
    return { ok: false, reason: `写不进 ${file}:${(error as Error).message}` }
  }

  if (previous === undefined) return { ok: true }
  const diff = diffParagraphs(previous, input.text)
  if (diff === undefined) return { ok: true, diff_note: `这一份超过 ${DIFF_MAX_PARAGRAPHS} 段,这一轮没比改了什么` }
  return { ok: true, diff }
}

/* ──────────────────────── 把关留痕 ──────────────────────── */

/**
 * 往 `审核记录.jsonl` 追加一行。**追加,永不改写**:把关记录是她做过的判断,
 * 不是一份可以整理的状态。写不进去要如实回 —— 一次没留痕的把关比没有把关更坏。
 */
export async function appendDeckReview(
  dir: string, entry: DeckReviewEntry,
): Promise<{ ok: true } | { ok: false, reason: string }> {
  try {
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, REVIEW_LOG_NAME), `${JSON.stringify(entry)}\n`, { encoding: 'utf8', flag: 'a' })
    return { ok: true }
  }
  catch (error) {
    return { ok: false, reason: `写不进 ${REVIEW_LOG_NAME}:${(error as Error).message}` }
  }
}

/** 一次最多回几条把关记录。卡上只摆最近这些,全文在文件里。 */
export const REVIEW_TAIL = 40

/**
 * 读把关记录(**最近的在最后**,与文件里的顺序一致)。
 *
 * 认不出的行**整行跳过**,不抛:这份文件是追加写的,断电或半行是可能的,
 * 一行坏字不该让整张卡看不见历史。
 */
export async function readDeckReviews<Entry extends DeckReviewEntry>(
  dir: string, tail = REVIEW_TAIL,
): Promise<Entry[]> {
  const text = await readIfThere(join(dir, REVIEW_LOG_NAME)).catch(() => undefined)
  if (text === undefined) return []
  const out: Entry[] = []
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue
    try {
      const one = JSON.parse(line) as Entry
      if (typeof one.at === 'string' && typeof one.action === 'string') out.push(one)
    }
    catch { /* 半行 / 坏字:跳过这一行,别的照读。 */ }
  }
  return out.slice(-tail)
}

/** 最后一次「让事务官推进」是什么时候。卡上的「排队 / 在做」要靠它算。 */
export function lastRunEntry<Entry extends DeckReviewEntry>(entries: readonly Entry[]): Entry | undefined {
  for (let i = entries.length - 1; i >= 0; i -= 1) {
    const one = entries[i]
    if (one?.action === 'run') return one
  }
  return undefined
}

/* ──────────────────────── 拼那段话时共用的两行 ──────────────────────── */

/** 一份产物在话里怎么点名。**不塞全文**:事务官自己会去读文件,塞全文只会把这段话撑爆。 */
export function deckDocLine(doc: DeckDocView): string {
  if (!doc.exists) return `- ${doc.file}:还没有`
  const chars = (doc.text ?? '').trim().length
  const when = doc.updated_at === undefined ? '' : `,最后改于 ${doc.updated_at}`
  return `- ${doc.file}:有了(${chars} 字${when})`
}

/**
 * 一条把关记录在话里怎么写。`fileOf` 把页签名翻成文件名 ——
 * 事务官读的是文件,所以话里点的也该是文件名。
 */
export function deckReviewLine(one: DeckReviewEntry, fileOf: (tab: string) => string | undefined): string {
  const said = one.text === undefined || one.text.trim() === '' ? '' : `:「${one.text.trim()}」`
  const what = fileOf(one.tab) ?? one.tab
  const action = one.action === 'pass'
    ? '通过'
    : one.action === 'revise'
        ? '打回改一改'
        : one.action === 'self'
          ? '她自己改了'
          : one.action === 'record'
      ? '把结论落进了决策记录'
      : one.action === 'confirm_points' ? '逐条过了确认点' : '让我推进'
  return `- ${one.at} 对 ${what} ${action}${said}`
}

/**
 * 这张卡过没过确认点(2026-09-23,维护者:「不能假装自己搞懂了」)。
 *
 * 判据只有一件看得见的事:`审核记录.jsonl` 里有没有一条 `confirm_points`。
 * **不看产物文件里那一节** —— 那一节是会被改写的,而"他到底点过头没有"
 * 必须是一条追加写、永不改写的记录。
 *
 * 两种卡共用(选题卡的「构思」、需求卡的「梳理」)。
 */
export function lastConfirmEntry<Entry extends DeckReviewEntry>(
  entries: readonly Entry[],
): Entry | undefined {
  for (let i = entries.length - 1; i >= 0; i -= 1) {
    const one = entries[i]
    if (one?.action === 'confirm_points') return one
  }
  return undefined
}

/** 过了没有。{@link lastConfirmEntry} 的是非版。 */
export function deckConfirmed<Entry extends DeckReviewEntry>(entries: readonly Entry[]): boolean {
  return lastConfirmEntry(entries) !== undefined
}

/**
 * 一张卡的名字能不能当目录名用。**一段,不许拐弯**:带 `/`、`..`、点开头的一律不认。
 *
 * 两种卡同一份(选题目录与需求目录都拿卡的标题当文件夹名)。
 */
export function isSafeDeckName(name: string): boolean {
  if (typeof name !== 'string') return false
  const trimmed = name.trim()
  if (trimmed === '' || trimmed.length > 120) return false
  if (trimmed.startsWith('.')) return false
  return !/[/\\]/.test(trimmed) && trimmed !== '.' && trimmed !== '..'
}
