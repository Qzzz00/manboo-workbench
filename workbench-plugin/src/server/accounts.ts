/**
 * 账号文件夹的读与写(2026-09-21「项目数据源换成账号」)。
 *
 * ```
 * <工作目录>/账号/<账号名>/
 *   账号.md     定位 / 风格 / 人群 / 平台 / 开号日期
 *   笔记/       一条笔记一个文件
 * ```
 *
 * ## 为什么不复用 memoryMd 那一套「字段 + 依据」的写法
 *
 * 记忆仓库里的项目文件写的是 `- **一句话**:…(引导访谈,Ben 口述,2026-09-21)` ——
 * 依据跟着值写在同一行,因为那是一份**给事务官读的档案**,每一条都要能追到出处。
 *
 * `账号.md` 不是档案,它在**工作目录**里,是 Ben 自己会打开改的一个文件,而且它的值
 * 会**原样显示在项目区那一行上**。依据写进字段行的后果是项目区显示成
 * 「小红书(引导访谈,Ben 口述,2026-09-21)」—— 那不是平台名。
 * 所以这里的取舍是:**字段行只放值,依据与日期放在「进展」那一节**。
 * 代价:某一个字段是哪天记的、依据是什么,要去「进展」里对,精度比记忆文件低一档。
 *
 * ## 「只建不删、只补不覆盖」
 *
 * 写第二次只改**这次真的说到**的那几个字段,别的字段、人自己加的段落一个字不碰
 * (2026-09-04 那条事故纪律在文件级别的样子)。一项都没变就连「进展」那一行都不追加 ——
 * 没发生的事不许在文件里留痕。
 */
import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { appendUnderSection, upsertProjectField } from './memoryMd.ts'

export const ACCOUNTS_DIR_NAME = '账号'
export const ACCOUNT_FILE_NAME = '账号.md'
export const ACCOUNT_NOTES_DIR = '笔记'

/**
 * `账号.md` 里那五个字段。**顺序就是文件里的顺序,也是项目区展开后那几行的顺序**,
 * 一处定义两处用(同 MODULE_IDS 那条 F1)。
 *
 * 前四个是引导 ②′ 问的四件事(账号定位 / 内容风格 / 目标人群 / 平台,
 * 逐字取自 `templates.ts` 的 `OPS_TEMPLATE.onboarding.projects_goals`);
 * 「开号日期」是卡里额外点名的一项。
 */
export const ACCOUNT_FIELDS = ['定位', '风格', '人群', '平台', '开号日期'] as const
export type AccountField = typeof ACCOUNT_FIELDS[number]
export type AccountFields = Partial<Record<AccountField, string>>

/** 还没人说过的那一项写这个词。读的时候它**不算答案**(见 readAccountFields)。 */
const PLACEHOLDER = '待梳理'

export function accountsDir(workdir: string): string {
  return join(workdir, ACCOUNTS_DIR_NAME)
}

/**
 * 账号名能不能做文件夹名。规矩与 `onboardingStages.safeName` 同一套:
 * 不能空、不能带路径分隔符或 `..`、不能以点开头、长度有限。
 *
 * 这道闸不是形式主义 —— 它挡的是"在用户盘上按一个模型吐出来的字符串建目录"。
 */
export function safeAccountName(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined
  const name = raw.trim()
  if (name === '' || name.length > 60) return undefined
  if (/[/\\]/.test(name) || name.includes('..') || name.startsWith('.')) return undefined
  return name
}

/** 新账号文件的骨架。 */
export function newAccountFile(
  name: string,
  input: { fields: AccountFields, date: string, origin: string },
): string {
  return [
    `# ${name}`,
    '',
    '> 账号文件。这一份是给你自己改的:字段行里就是值,改完工作台下一拍就跟着变。'
    + '「待梳理」= 还没人说过。日期与依据在下面的「进展」里。',
    '',
    ...ACCOUNT_FIELDS.map(field => `- **${field}**:${input.fields[field] ?? PLACEHOLDER}`),
    '',
    '## 进展(倒序,一条一日期)',
    `- ${input.date}:建档(${input.origin})`,
    '',
    `## ${ACCOUNT_NOTES_DIR}`,
    `- 一条笔记一个文件,放在同目录的 \`${ACCOUNT_NOTES_DIR}/\` 里;文件名以 YYYY-MM-DD 开头的,工作台按它排最近一条。`,
    '',
  ].join('\n')
}

/**
 * 从 `账号.md` 里读那五个字段。
 *
 * - 「待梳理」**不算答案**,整项缺席 —— 占位词当成他说过的话,是编数据;
 * - 全角 `:` 与半角 `:` 都认,冒号后的空格吃掉 —— 这文件是人改的,别在标点上难为他;
 * - **不认识的字段一律不收**:读到什么收什么,界面上会冒出他没打算给工作台看的行。
 */
export function readAccountFields(text: string): AccountFields {
  const out: AccountFields = {}
  for (const field of ACCOUNT_FIELDS) {
    const matched = new RegExp(`^- \\*\\*${field}\\*\\*[::]\\s*(.*)$`, 'm').exec(text)
    const value = matched?.[1]?.trim()
    if (value === undefined || value === '' || value === PLACEHOLDER) continue
    out[field] = value
  }
  return out
}

/** 这一次真的改了哪几项(值不同才算)。 */
function changedFields(text: string, fields: AccountFields): AccountField[] {
  const before = readAccountFields(text)
  return ACCOUNT_FIELDS.filter((field) => {
    const next = fields[field]
    return next !== undefined && next !== '' && next !== before[field]
  })
}

/** 补字段。只改这次说到且真的变了的那几项;一项都没变就原样返回(连进展行都不加)。 */
export function upsertAccountFields(
  text: string,
  fields: AccountFields,
  input: { date: string, origin: string },
): string {
  const changed = changedFields(text, fields)
  if (changed.length === 0) return text
  let out = text
  for (const field of changed) out = upsertProjectField(out, field, fields[field] as string)
  return appendUnderSection(out, '进展', `- ${input.date}:记下 ${changed.join(' / ')}(${input.origin})`, 'top')
}

/** 账号文件夹下有哪几个账号。**只认目录**,点开头的不算;文件夹不存在就是空的(不是错)。 */
export async function listAccountNames(dir: string): Promise<string[]> {
  let entries: Awaited<ReturnType<typeof readdir>>
  try {
    entries = await readdir(dir, { withFileTypes: true }) as never
  }
  catch {
    // 还没建过 `账号/` —— 「还没有账号」,不是一条错误。
    return []
  }
  return (entries as unknown as { name: string, isDirectory: () => boolean }[])
    .filter(entry => entry.isDirectory() && !entry.name.startsWith('.'))
    .map(entry => entry.name)
    // 'en' 排序 = 码位序,在任何一台机器上都一样(同 gitSource.list 那条确定性排序的理由);
    // 拼音序要看 ICU 装得全不全,换台机器顺序就变,而顺序一变界面上的账号就跟着跳。
    .sort((a, b) => a.localeCompare(b, 'en'))
}

/** 文件名前面那段 `YYYY-MM-DD`。没有就 undefined —— **不从别处猜一个**。 */
function dateFromNoteName(name: string): string | undefined {
  return /^(\d{4}-\d{2}-\d{2})/.exec(name)?.[1]
}

function dateOnly(ms: number): string {
  const date = new Date(ms)
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

/**
 * 一个账号有几条笔记、最近一条是哪天。
 *
 * 日期的来源有两条,按顺序:① 文件名开头的 `YYYY-MM-DD`;② 这个文件自己的修改时间。
 * ② 是**退而求其次**而不是编造 —— 它是盘上真有的一个时刻,只是含义弱一点
 * (拷进来的旧笔记会显示成拷贝那天)。两条都拿不到就没有日期,界面如实说「还没有笔记」。
 */
export async function readAccountNotes(accountDir: string): Promise<{ count: number, lastAt?: string }> {
  const dir = join(accountDir, ACCOUNT_NOTES_DIR)
  let names: string[]
  try {
    const entries = await readdir(dir, { withFileTypes: true }) as unknown as { name: string, isFile: () => boolean }[]
    names = entries.filter(entry => entry.isFile() && !entry.name.startsWith('.')).map(entry => entry.name)
  }
  catch {
    return { count: 0 } // 没有 `笔记/` = 0 条,不是错。
  }
  if (names.length === 0) return { count: 0 }
  let last: string | undefined
  for (const name of names) {
    let at = dateFromNoteName(name)
    if (at === undefined) {
      try { at = dateOnly((await stat(join(dir, name))).mtimeMs) }
      catch { at = undefined } // 这一条问不出时间就不算进"最近",条数照数。
    }
    if (at !== undefined && (last === undefined || at > last)) last = at
  }
  return { count: names.length, ...(last === undefined ? {} : { lastAt: last }) }
}

/** 读一个账号的 `账号.md`。文件不在(只有文件夹)就是"五项全空",不是错。 */
export async function readAccountFile(accountDir: string): Promise<AccountFields> {
  try {
    return readAccountFields(await readFile(join(accountDir, ACCOUNT_FILE_NAME), 'utf8'))
  }
  catch {
    return {}
  }
}

export interface WriteAccountResult {
  ok: boolean
  /** 写成了的话,`账号.md` 的绝对路径。 */
  path?: string
  reason?: string
  /** 这一次是新建的这个账号(而不是补了一个已有账号的字段)。 */
  created?: boolean
}

/**
 * 记一个账号:没有就建文件夹 + `账号.md` + 空的 `笔记/`,有就只补字段。
 *
 * **只建不删**:已有的 `账号.md` 里人自己写的东西一个字不碰(见 upsertAccountFields)。
 */
export async function writeAccount(
  workdir: string,
  account: { name: string, fields: AccountFields },
  input: { date: string, origin: string },
): Promise<WriteAccountResult> {
  const name = safeAccountName(account.name)
  if (name === undefined) {
    return { ok: false, reason: '账号名要非空、不带路径分隔符或 `..`、不以点开头,60 字以内' }
  }
  const dir = join(accountsDir(workdir), name)
  const file = join(dir, ACCOUNT_FILE_NAME)
  try {
    await mkdir(join(dir, ACCOUNT_NOTES_DIR), { recursive: true })
    let text: string
    let created = false
    try {
      text = await readFile(file, 'utf8')
    }
    catch {
      text = newAccountFile(name, { fields: account.fields, date: input.date, origin: input.origin })
      created = true
    }
    if (!created) text = upsertAccountFields(text, account.fields, input)
    await writeFile(file, text, 'utf8')
    return { ok: true, path: file, ...(created ? { created } : {}) }
  }
  catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) }
  }
}

// ───────────────────────────────────────────────────────────────────────────
// 运营目标与经验闭环(2026-09-22 卡④)
//
// 三份文件,都在 `账号/<名>/` 底下,都是**人能打开改**的 markdown:
//
// ```
// 账号/<名>/
//   账号.md    五个字段 + 「风格与偏好(工作台学到的)」那一段(下班例程整段重写)
//   目标.md    由技能 docs/技能/运营-运营目标.md 写,格式钉死;这里**只读不写**
//   经验.md    复盘里提炼的一句话,一行一条
// ```
//
// 贯穿这一段的一条规矩:**读不懂就跳过并说出来**。`目标.md` 是模型按技能写的,
// 人也会自己改;读不懂的那一行退回"这一项没有",并把原行带回给调用方念出来 ——
// 猜一个数出来,早报上那句"还差 5 篇"就是编的(D13)。
// ───────────────────────────────────────────────────────────────────────────

/** `账号/<名>/目标.md`。写它的是技能,不是这份代码。 */
export const ACCOUNT_GOAL_FILE = '目标.md'
/** `账号/<名>/经验.md`。复盘提炼的一句话一行一条。 */
export const ACCOUNT_EXPERIENCE_FILE = '经验.md'

/** 画像那一段在 `账号.md` 里的标题与标记。**段内整段重写,段外一个字不动**(同 hooksApply 那套)。 */
export const ACCOUNT_PROFILE_HEADING = '风格与偏好(工作台学到的)'
export const ACCOUNT_PROFILE_BEGIN = '<!-- 工作台学到的:开始 -->'
export const ACCOUNT_PROFILE_END = '<!-- 工作台学到的:结束 -->'

/** —— 一、`目标.md` 读回来 —— */

export interface AccountGoal {
  /** 这一轮目标的日期区间(两头都含)。读不懂就缺席。 */
  period?: { from: string, to: string }
  /** 笔记发布目标 N(条)。 */
  notes_target?: number
  /** 粉丝目标 M(这一轮要涨**到**的数,技能里就是这么定义的)。 */
  fans_target?: number
  /** 粉丝起点。技能允许写「起点没取到」——那时这一项缺席。 */
  fans_start?: number
  /** 哪几行没读懂(原行,截短)。**空数组 = 全读懂了**。 */
  unreadable: string[]
}

function goalFieldLine(text: string, field: string): string | undefined {
  const matched = new RegExp(`^- \\*\\*${field}\\*\\*[::]\\s*(.*)$`, 'm').exec(text)
  const value = matched?.[1]?.trim()
  return value === undefined || value === '' ? undefined : value
}

/**
 * 一个计数:`8`、`8 条`、`1,200`。**「1.2万」这种一律不认** ——
 * 取首个数字会把它读成 1,而 1 与 12000 差了四个量级。
 */
export function parseGoalCount(raw: string): number | undefined {
  const cleaned = raw.trim().replace(/[,,]/g, '').replace(/[条个人粉篇]\s*$/, '').trim()
  if (!/^\d+$/.test(cleaned)) return undefined
  const value = Number(cleaned)
  return Number.isSafeInteger(value) ? value : undefined
}

const DATE_RE = /(\d{4}-\d{2}-\d{2})/g

/**
 * 解析 `目标.md`。只认技能里钉死的那四行,**认不出的整行带回 `unreadable`**。
 *
 * 宽容的只有标点(全角/半角冒号、全角括号)—— 那是人手改文件时最容易变的东西;
 * 数字与日期一点都不宽容:形状不对就是没有。
 */
export function parseAccountGoal(text: string): AccountGoal {
  const goal: AccountGoal = { unreadable: [] }

  const period = goalFieldLine(text, '周期')
  if (period !== undefined) {
    const dates = period.match(DATE_RE) ?? []
    if (dates.length >= 2 && (dates[0] as string) <= (dates[1] as string)) {
      goal.period = { from: dates[0] as string, to: dates[1] as string }
    }
    else goal.unreadable.push(`周期:${period.slice(0, 80)}`)
  }

  const notes = goalFieldLine(text, '笔记发布目标')
  if (notes !== undefined) {
    const value = parseGoalCount(notes)
    if (value === undefined) goal.unreadable.push(`笔记发布目标:${notes.slice(0, 80)}`)
    else goal.notes_target = value
  }

  const fans = goalFieldLine(text, '粉丝目标')
  if (fans !== undefined) {
    // 形状:`250(起点 1200)` / `250(起点 起点没取到)` / `250`。
    const head = fans.split(/[((]/)[0] ?? ''
    const target = parseGoalCount(head)
    if (target === undefined) goal.unreadable.push(`粉丝目标:${fans.slice(0, 80)}`)
    else goal.fans_target = target
    const inside = /[((]\s*起点\s*([^))]*)[))]/.exec(fans)?.[1]
    if (inside !== undefined) {
      const start = parseGoalCount(inside)
      // 「起点没取到」是技能里明写的一种写法,**不算读不懂**,就是没有起点。
      if (start !== undefined) goal.fans_start = start
    }
  }

  return goal
}

export interface ReadAccountGoalResult {
  /** `目标.md` 在不在。不在 = 还没定目标(**不是错**)。 */
  exists: boolean
  goal?: AccountGoal
}

/** 读一个账号的 `目标.md`。文件不在就是「还没定目标」。 */
export async function readAccountGoal(accountDir: string): Promise<ReadAccountGoalResult> {
  let text: string
  try {
    text = await readFile(join(accountDir, ACCOUNT_GOAL_FILE), 'utf8')
  }
  catch {
    return { exists: false }
  }
  return { exists: true, goal: parseAccountGoal(text) }
}

/** —— 二、进度怎么算、早报里怎么说 —— */

/**
 * 本周期内这个账号已经发了几篇。
 *
 * 判据只有一条:**这张卡是选题(`kind: 'topic'`)、归这个账号、`published_at` 落在区间里**。
 * `published_at` 有值 = 已发布(2026-09-22 发布计划两状态),没有第二种读法。
 *
 * 账号 id 或周期缺一个就回 `undefined` —— 那是"算不了",不是 0。
 */
export function countPublishedInPeriod(
  tasks: readonly { kind?: string, project_id?: string, published_at?: string }[],
  projectId: string | undefined,
  period: { from: string, to: string } | undefined,
): number | undefined {
  if (projectId === undefined || period === undefined) return undefined
  let count = 0
  for (const task of tasks) {
    if (task.kind !== 'topic' || task.project_id !== projectId) continue
    const at = task.published_at
    if (typeof at !== 'string' || at < period.from || at > period.to) continue
    count += 1
  }
  return count
}

export interface GoalProgressInput {
  account: string
  /** `目标.md` 不在的时候传 undefined。 */
  goal?: AccountGoal
  /** 本周期已发布篇数(countPublishedInPeriod 的结果)。 */
  published?: number
  /** 涨粉:数据复盘那一格里取到的那一项,**原样那串**也带上。 */
  fans?: { value: number, raw: string, range: string }
  /** 涨粉这一项为什么没有(后台没给 / 没登录 / 还没自取过)。 */
  fans_absent_why?: string
}

/** 只报事实与差额。**不加油、不预测**(技能「早报里怎么报进度」那一节的原话)。 */
export function composeGoalProgress(input: GoalProgressInput): string {
  const who = `「${input.account}」`
  const goal = input.goal
  if (goal === undefined) return `${who}还没定目标。`

  const parts: string[] = []

  // 发布进度。
  if (goal.notes_target === undefined) parts.push('笔记发布目标没读懂,这一项跳过')
  else if (input.published === undefined) {
    parts.push(`笔记发布目标 ${goal.notes_target} 条,已发几篇算不了(${goal.period === undefined ? '周期没读懂' : '看板上对不上这个账号'})`)
  }
  else {
    const period = goal.period as { from: string, to: string }
    const gap = goal.notes_target - input.published
    const tail = gap > 0 ? `还差 ${gap} 篇` : gap === 0 ? '刚好够' : `多出 ${-gap} 篇`
    parts.push(`${period.from} 到 ${period.to} 发了 ${input.published}/${goal.notes_target} 篇,${tail}`)
  }

  // 粉丝进度。
  if (goal.fans_target === undefined) parts.push('粉丝目标没读懂,这一项跳过')
  else if (input.fans === undefined) {
    parts.push(`粉丝目标 ${goal.fans_target},涨粉这次没取到(${input.fans_absent_why ?? '数据复盘那一格没给'}),差多少算不了`)
  }
  else if (goal.fans_start === undefined) {
    parts.push(`粉丝目标 ${goal.fans_target},起点没取到、差多少算不了;${input.fans.range}涨了 ${input.fans.raw}`)
  }
  else {
    const gap = goal.fans_target - goal.fans_start - input.fans.value
    const tail = gap > 0 ? `还差 ${gap}` : gap === 0 ? '刚好够' : `多出 ${-gap}`
    parts.push(`粉丝目标 ${goal.fans_target}(起点 ${goal.fans_start}),${input.fans.range}涨了 ${input.fans.raw},${tail}`)
  }

  // 涨粉那一项的口径:后台只给近 7 / 近 30 日,**不是按周期算的**。这句每次都带,
  // 因为"还差 130"看上去像是按周期算的,而它不是。
  const caveat = input.fans === undefined || goal.fans_target === undefined
    ? ''
    : `(涨粉是${input.fans.range}那一份,后台只给这两个范围,不是按周期算的)`
  const unreadable = goal.unreadable.length === 0
    ? ''
    : `;目标.md 里这几行没读懂、跳过了:${goal.unreadable.join(' / ')}`
  return `${who}${parts.join(';')}。${caveat}${unreadable}`
}

/** —— 三、`经验.md`:复盘提炼的一句话 —— */

export function newExperienceFile(name: string): string {
  return [
    `# ${name} · 经验`,
    '',
    '> 复盘里提炼的一句话,一行一条,新的在最后。括号里是这一条从哪来的。',
    '> 这一份是给你自己改的:删掉一行就是不认它,工作台不会把它写回来。',
    '',
    '## 经验',
    '',
  ].join('\n')
}

/**
 * 追加一条经验。**一模一样的一行已经在了就不动** —— 同一次复盘写两遍不该出现两条
 * (同 appendProgress 那条幂等)。
 */
export function appendExperience(text: string, line: string): { text: string, changed: boolean } {
  if (text.split('\n').includes(line)) return { text, changed: false }
  return { text: appendUnderSection(text, '经验', line), changed: true }
}

export interface AppendExperienceResult {
  ok: boolean
  path?: string
  /** 真的追加了(false = 这一条已经在了)。 */
  appended?: boolean
  reason?: string
}

/**
 * 把一句经验追加进 `<账号目录>/<名>/经验.md`。文件不在就先建骨架。
 *
 * 第一个参数是**账号们的根**(`<工作目录>/账号`)而不是工作目录 ——
 * 调用方(http.ts 那条路由)手上只有 `/state.template.asset_dirs` 里那份算好的绝对路径,
 * **不自己拼一条**(同 `/topic/assets` 那条规矩)。
 */
export async function appendExperienceIn(
  accountsRoot: string,
  account: string,
  input: { lesson: string, date: string, origin: string },
): Promise<AppendExperienceResult> {
  const name = safeAccountName(account)
  if (name === undefined) return { ok: false, reason: '账号名要非空、不带路径分隔符或 `..`、不以点开头,60 字以内' }
  const lesson = input.lesson.trim()
  if (lesson === '') return { ok: false, reason: '经验一句话不能是空的' }
  const dir = join(accountsRoot, name)
  const file = join(dir, ACCOUNT_EXPERIENCE_FILE)
  const line = `- ${input.date}:${lesson}(${input.origin})`
  try {
    await mkdir(dir, { recursive: true })
    let text: string
    try { text = await readFile(file, 'utf8') }
    catch { text = newExperienceFile(name) }
    const appended = appendExperience(text, line)
    if (appended.changed) await writeFile(file, appended.text, 'utf8')
    return { ok: true, path: file, appended: appended.changed }
  }
  catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) }
  }
}

/** 同上,参数是**工作目录**(引导、例程那一侧手上有的就是它)。 */
export async function appendAccountExperience(
  workdir: string,
  account: string,
  input: { lesson: string, date: string, origin: string },
): Promise<AppendExperienceResult> {
  return await appendExperienceIn(accountsDir(workdir), account, input)
}

/** `经验.md` 里的那几行(原样,去掉 `- ` 前缀之前的样子不动)。没有文件就是空的。 */
export function readExperienceLines(text: string): string[] {
  const lines = text.split('\n')
  const start = lines.findIndex(line => line === '## 经验' || line.startsWith('## 经验('))
  const body = start === -1 ? lines : lines.slice(start + 1)
  return body.filter(line => line.startsWith('- ')).map(line => line.slice(2).trim()).filter(line => line !== '')
}

/** —— 四、把关记录 `选题/<名>/审核记录.jsonl` —— */

/**
 * 一行一个 JSON:`{ at, doc, action, note }`(卡 ② 写的)。
 *
 * **action 不做枚举**:那几个词由卡 ② 定(「通过 / 改一改 / 我自己改」),
 * 在这里写死一遍就成了两处定义、改一头忘另一头。这里按读到什么分组数什么。
 * 读不成 JSON 的行**安静跳过** —— 一行坏了不该让整份统计消失。
 */
export interface ReviewLogStats {
  total: number
  /** action → 次数,按次数降序、同次数按 action 码位序(确定性)。 */
  by_action: readonly { action: string, count: number }[]
  /** 他在「改一改」时说过的那几句(**按 `at` 倒序**,新的在前),带是哪一份产物。 */
  notes: readonly { note: string, doc?: string, action?: string, at?: string }[]
}

export function parseReviewLog(text: string, maxNotes = 3): ReviewLogStats {
  const counts = new Map<string, number>()
  const notes: { note: string, doc?: string, action?: string, at?: string }[] = []
  let total = 0
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (trimmed === '') continue
    let parsed: unknown
    try { parsed = JSON.parse(trimmed) }
    catch { continue }
    if (typeof parsed !== 'object' || parsed === null) continue
    const record = parsed as Record<string, unknown>
    total += 1
    const action = typeof record.action === 'string' && record.action.trim() !== '' ? record.action.trim() : undefined
    if (action !== undefined) counts.set(action, (counts.get(action) ?? 0) + 1)
    const note = typeof record.note === 'string' ? record.note.trim() : ''
    if (note !== '') {
      notes.push({
        note,
        ...(typeof record.doc === 'string' && record.doc !== '' ? { doc: record.doc } : {}),
        ...(action === undefined ? {} : { action }),
        ...(typeof record.at === 'string' && record.at !== '' ? { at: record.at } : {}),
      })
    }
  }
  // 「最近几句」按 `at` 倒序。**没有 `at` 的排在后面** —— 不拿"读到的先后"冒充时间顺序
  // (几份文件拼起来读的时候,先后只反映文件名排序)。
  notes.sort((a, b) => {
    if (a.at === undefined && b.at === undefined) return 0
    if (a.at === undefined) return 1
    if (b.at === undefined) return -1
    return a.at < b.at ? 1 : a.at > b.at ? -1 : 0
  })
  const by_action = [...counts.entries()]
    .map(([action, count]) => ({ action, count }))
    .sort((a, b) => b.count - a.count || a.action.localeCompare(b.action, 'en'))
  return { total, by_action, notes: notes.slice(0, maxNotes) }
}

/** —— 五、画像回写:`账号.md` 的「风格与偏好(工作台学到的)」 —— */

export interface ProfileSectionInput {
  /** `经验.md` 里的那几行(新的在后),这里只取最近几条。 */
  experiences: readonly string[]
  reviews: ReviewLogStats
  date: string
  /** 最多列几条经验。 */
  maxExperiences?: number
  /**
   * 她说过不止一次的偏好,一条一行(2026-09-23,`evolve.preferenceLines()`)。
   * 缺席或空 = 这一行整行不出现,段与加它之前逐字相同。
   */
  preferences?: readonly string[]
}

/**
 * 画像那一段的正文(含两个标记)。**一个字都不是归纳出来的**:经验是她自己认下的那句话、
 * 把关次数是数出来的、打回时的原话是她打的字。这一段里没有模型。
 *
 * 两边都空 → 回 `undefined`:**没有内容就不写这一段**,不往她的账号文件里塞一句
 * 「暂无」(那是噪音,而且下次有内容了还要覆盖回去)。
 */
export function renderProfileSection(input: ProfileSectionInput): string | undefined {
  const max = input.maxExperiences ?? 8
  const experiences = input.experiences.slice(-max)
  const preferences = (input.preferences ?? []).filter(line => line.trim() !== '')
  if (experiences.length === 0 && input.reviews.total === 0 && preferences.length === 0) return undefined

  const lines = [
    ACCOUNT_PROFILE_BEGIN,
    `## ${ACCOUNT_PROFILE_HEADING}`,
    '',
    `> 这一段由工作台**整段重写**(下班例程从 \`${ACCOUNT_EXPERIENCE_FILE}\` 与 \`选题/*/审核记录.jsonl\` 拼,${input.date})。`,
    '> 两个标记之间改的字下次会被覆盖;要留住就写到标记外面去。',
    '> 这里的每一句都是你自己说过的话或数出来的次数,**没有一句是猜的**。',
    '',
  ]
  if (experiences.length > 0) {
    lines.push(`- **复盘里攒下的经验**(\`${ACCOUNT_EXPERIENCE_FILE}\` 最近 ${experiences.length} 条):`)
    for (const line of experiences) lines.push(`  - ${line}`)
  }
  if (preferences.length > 0) {
    // 与「打回时你说过的」那几句分开写:那几句是**单次**的原话,这几条是**不止一条选题上**都说过的。
    lines.push('- **你说过不止一次的偏好**(从 `选题/*/审核记录.jsonl` 里数出来的;「试用中」的在下一条选题上验,没见效自动撤):')
    for (const line of preferences) lines.push(`  - ${line}`)
  }
  if (input.reviews.total > 0) {
    const breakdown = input.reviews.by_action.map(item => `${item.action} ${item.count}`).join('、')
    lines.push(`- **把关习惯**(\`选题/*/审核记录.jsonl\`,共 ${input.reviews.total} 次)${breakdown === '' ? '' : `:${breakdown}`}`)
    if (input.reviews.notes.length > 0) {
      lines.push('- **打回时你说过的**(最近几句,原话):')
      for (const item of input.reviews.notes) {
        lines.push(`  - 「${item.note}」${item.doc === undefined ? '' : `(${item.doc})`}`)
      }
    }
  }
  lines.push(ACCOUNT_PROFILE_END, '')
  return lines.join('\n')
}

/**
 * 把画像那一段塞进 `账号.md`。**标记之间整段换掉,标记之外一个字不动**;
 * 没有标记就贴在文件末尾。内容一个字都没变 → `changed: false`,**连写都不写**
 * (同 hooksApply「一个字都没变就不写、不备份」)。
 */
export function upsertProfileSection(text: string, section: string): { text: string, changed: boolean } {
  const begin = text.indexOf(ACCOUNT_PROFILE_BEGIN)
  const end = text.indexOf(ACCOUNT_PROFILE_END)
  if (begin === -1 || end === -1 || end < begin) {
    const base = text.endsWith('\n') || text === '' ? text : `${text}\n`
    return { text: `${base}\n${section}`, changed: true }
  }
  const head = text.slice(0, begin)
  const tail = text.slice(end + ACCOUNT_PROFILE_END.length)
  // 段尾那个换行归这一段自己(section 末尾带了一个),tail 开头多出来的那个去掉一次。
  const next = `${head}${section}${tail.startsWith('\n') ? tail.slice(1) : tail}`
  return { text: next, changed: next !== text }
}

export interface WriteProfileResult {
  ok: boolean
  path?: string
  /** 真的写了盘(false = 一个字没变,或者没内容可写)。 */
  written?: boolean
  reason?: string
}

/**
 * 回写一个账号的画像段。`账号.md` 不在就**什么都不做** ——
 * 这一段是贴在她的账号文件上的,不是理由去替她建一份账号档案。
 */
export async function writeAccountProfile(
  workdir: string,
  account: string,
  input: { experiences: readonly string[], reviews: ReviewLogStats, date: string, preferences?: readonly string[] },
): Promise<WriteProfileResult> {
  const name = safeAccountName(account)
  if (name === undefined) return { ok: false, reason: '账号名不合法' }
  const file = join(accountsDir(workdir), name, ACCOUNT_FILE_NAME)
  let text: string
  try { text = await readFile(file, 'utf8') }
  catch { return { ok: false, reason: `${ACCOUNT_FILE_NAME} 还不在,画像段没地方贴` } }
  const section = renderProfileSection(input)
  if (section === undefined) return { ok: true, path: file, written: false }
  const next = upsertProfileSection(text, section)
  if (!next.changed) return { ok: true, path: file, written: false }
  try {
    await writeFile(file, next.text, 'utf8')
    return { ok: true, path: file, written: true }
  }
  catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) }
  }
}
