/**
 * 派出去的那件子事项**跑完之后,结果自己回到卡上**(2026-09-23,断点 B)。
 *
 * 出处:`docs/设计-中秋目标-手机远程指挥电脑优化事务官-2026-09-23.md` 第二节断点 B:
 *
 * > 三只手在;**结果摘要回卡靠事务官写文件**;截图没有。
 *
 * 「靠事务官写文件」是这张卡要治的病:一段由模型转述的结果,它想写多少写多少,
 * 写错了也没人对得出来。这个文件把**四样事实**从事务官手里拿走,由工作台自己落盘:
 *
 * 1. **退出码** —— 成没成只有它说了算(事务官读日志读出来的"看起来成了"不算);
 * 2. **最后 200 行** —— 原话,不摘要。红在哪一行她自己看得见;
 * 3. **改了哪些文件** —— `git status --short` + `git diff --stat`,在项目根现跑;
 * 4. **测试跑没跑** —— 项目里 `package.json` 有 `test` 就跑一次,把结果也落进去。
 *
 * 截图这一项:**这台机器上没有现成的截屏能力**(`screencapture` 要屏幕录制授权,
 * 只有 Ben 能给;决策记录 2026-09-18 与 09-21 各记过一次实测失败),而且客户端窗口的
 * 截图会把他的私人对话一起拍进仓库。所以这一项**如实写「没截」并写清为什么**
 * —— 卡里那句「没有就写『没截』」逐字。
 *
 * ## 落在哪
 *
 * ```
 * <项目根>/docs/需求/<需求名>/结果-<子事项>.md
 * ```
 *
 * 与四个页签(`需求.md` / `子事项.md` / `验收.md` / `记录.md`)待在同一个目录里,
 * 因为「验收」那个页签要念的就是这几份。**一件子事项一份文件**:几件派出去的活
 * 挤在同一份里,第二件回来时只能追加在末尾,而她想看的是"第三件成没成"。
 *
 * ## 这一层不起活
 *
 * 与 `featureRun.ts` / `topicRun.ts` 逐字同一条纪律:真去跑 Codex 的是事务官
 * (按「派活给别家Agent」那一节)。这里只在**它跑完之后**收事实 ——
 * `git` 与测试那两下由调用方注进来的执行器跑,用例里全是假的。
 */
import { mkdir, readdir, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { FeatureResultView } from '../protocol.ts'
import { isSafeDeckName, readIfThere } from './deckRun.ts'

/** 结果文件的前缀。**唯一定义处**(界面要按它把结果挑出来)。 */
export const RESULT_FILE_PREFIX = '结果-'

/** 日志留最后多少行。卡里钉死:200。 */
export const RESULT_LOG_TAIL = 200

/** 一份结果文件里日志那一段最多多少字。再长就截,末尾如实说一句。 */
export const RESULT_LOG_MAX_CHARS = 40_000

/** 这件子事项的结果落哪个文件。名字不合法回 undefined(同 `featureDirOf`,不拼半截路径)。 */
export function resultFileOf(item: string): string | undefined {
  return isSafeDeckName(item) ? `${RESULT_FILE_PREFIX}${item.trim()}.md` : undefined
}

/**
 * 留最后 n 行。**从后往前数**,前面砍掉的说一句「前面还有 N 行没贴」——
 * 一段悄悄被砍了头的日志,读的人会以为它就是全部。
 */
export function tailLines(text: string, n: number = RESULT_LOG_TAIL): { text: string, cut: number } {
  const lines = text.replace(/\r\n/g, '\n').split('\n')
  // 末尾那个空行是 split 的产物,不是一行日志。
  while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop()
  if (lines.length <= n) return { text: lines.join('\n'), cut: 0 }
  return { text: lines.slice(-n).join('\n'), cut: lines.length - n }
}

/* ──────────────────────── 改了哪些文件 ──────────────────────── */

/** 跑一条命令。**调用方注进来**(用例喂假的)。`code` 是退出码。 */
export type RunCommand = (input: {
  cmd: string
  args: readonly string[]
  cwd: string
}) => Promise<{ code: number, out: string }>

export interface ChangedFiles {
  /** `git status --short` 的原文。 */
  status: string
  /** `git diff --stat` 的原文。 */
  stat: string
  /** 跑不起来时那一句(人话)。有它就说明上面两样是空的。 */
  error?: string
}

/**
 * 在项目根跑那两条 git,把「改了哪些文件」取回来。
 *
 * **两条都只读**:`git status --short` 与 `git diff --stat` 不改任何东西。
 * 跑不起来(不是仓库、没有 git)**不是错**:如实记一句,结果文件照样落 ——
 * 一件活的退出码不该因为取不到 diff 就丢了。
 *
 * ★ `-c core.quotepath=false`:git 默认把非 ASCII 路径转义成 `"\344\272\244…"`,
 * 而她的仓库里一半文件名是中文 —— 不关掉它,这一段贴出来的是一串八进制,她读不懂。
 */
export async function collectChangedFiles(run: RunCommand, cwd: string): Promise<ChangedFiles> {
  const quiet = ['-c', 'core.quotepath=false']
  const status = await run({ cmd: 'git', args: [...quiet, 'status', '--short'], cwd })
  if (status.code !== 0) {
    return { status: '', stat: '', error: `git status 没跑成(退出码 ${status.code}):${tailLines(status.out, 5).text}` }
  }
  const stat = await run({ cmd: 'git', args: [...quiet, 'diff', '--stat'], cwd })
  if (stat.code !== 0) {
    return { status: status.out.trim(), stat: '', error: `git diff --stat 没跑成(退出码 ${stat.code})` }
  }
  return { status: status.out.trim(), stat: stat.out.trim() }
}

/* ──────────────────────── 项目里能不能跑测试 ──────────────────────── */

export interface TestProbe {
  /** 跑不跑得了。 */
  can: boolean
  /** 为什么(两种结论都给)。 */
  why: string
}

/**
 * 项目根的 `package.json` 里有没有 `scripts.test`。
 *
 * 没有 package.json、解析不了、没有 test 脚本 —— 三种都回 `can:false` 并**说清是哪一种**。
 * 卡里那句「若项目里能跑测试(package.json 有 test)」的判据就是这一条,不多猜一层
 * (不去找 pytest.ini、不去猜 Makefile):一条猜出来的测试命令跑起来的后果不可控。
 */
export function probeTestScript(packageJsonText: string | undefined): TestProbe {
  if (packageJsonText === undefined) return { can: false, why: '项目根没有 package.json,没跑测试' }
  let scripts: unknown
  try { scripts = (JSON.parse(packageJsonText) as { scripts?: unknown }).scripts }
  catch { return { can: false, why: 'package.json 解析不了,没跑测试' } }
  const test = (scripts as { test?: unknown } | undefined)?.test
  if (typeof test !== 'string' || test.trim() === '') {
    return { can: false, why: 'package.json 里没有 test 脚本,没跑测试' }
  }
  return { can: true, why: `package.json 里的 test 是 \`${test.trim()}\`` }
}

export interface TestOutcome {
  ran: boolean
  /** 没跑的原因,或者跑了之后那一句摘要。 */
  why: string
  code?: number
  /** 测试输出的尾巴(最后 40 行)。跑了才有。 */
  tail?: string
}

/** 测试输出留多少行。比日志短:它是"摘要",全文在那次派活自己的日志里。 */
export const TEST_TAIL = 40

/**
 * 项目里能跑测试就跑一次。**用 `npm test` 而不是 `pnpm test`**:
 * 判据是 package.json 的 `scripts.test`,而 `npm test` 对任何有 package.json 的项目都成立;
 * 猜包管理器(有没有 pnpm-lock)是另一件会猜错的事,而这一步猜错了就是一次假红。
 */
export async function runProjectTest(
  run: RunCommand,
  cwd: string,
  probe: TestProbe,
): Promise<TestOutcome> {
  if (!probe.can) return { ran: false, why: probe.why }
  const result = await run({ cmd: 'npm', args: ['test', '--silent'], cwd })
  const tail = tailLines(result.out, TEST_TAIL).text
  return {
    ran: true,
    why: result.code === 0 ? `测试通过(${probe.why})` : `测试没通过,退出码 ${result.code}`,
    code: result.code,
    tail,
  }
}

/* ──────────────────────── 结果文件长什么样 ──────────────────────── */

/**
 * 截图这一项。**这台机器上没有** —— 理由写在正文里,不是一句「暂不支持」。
 *
 * 留成一个可注入的值而不是写死一句话:哪天真有了截屏能力(比如 Ben 给了屏幕录制授权),
 * 调用方把路径塞进来,这里就写路径。
 */
export const NO_SHOT_NOTE = '没截 —— 这台机器上没有现成的截屏能力('
  + 'screencapture 要「屏幕录制」授权,只有 Ben 能给;'
  + '而客户端窗口的截图会把他的私人对话一起拍进仓库)'

export interface FeatureResultInput {
  /** 哪件子事项(= 文件名里那一截)。 */
  item: string
  /** 派给了谁(Codex / Claude / 事务官自己)。不知道就不写。 */
  hand?: string
  /** 那条命令的退出码。**没有默认值**:不知道退出码就不该落一份结果。 */
  exitCode: number
  /** 那条命令跑在哪个目录里。 */
  cwd?: string
  /** 原始输出。会自己取最后 200 行。 */
  log?: string
  changed?: ChangedFiles
  test?: TestOutcome
  /** 截图路径。缺席 = 写「没截」。 */
  shot?: string
  at: Date
}

/** 一段原文贴进 markdown 的样子。空的就写「(没有输出)」,不留一个空的代码块。 */
function block(text: string | undefined, empty: string): string {
  const one = (text ?? '').trim()
  if (one === '') return empty
  return ['```', one, '```'].join('\n')
}

/**
 * 结果文件的正文。**纯函数**,一行 I/O 都没有。
 *
 * 排版按"她最想先知道什么"排:成没成 → 改了什么 → 测试 → 日志 → 截图。
 * 日志排在后面是因为它最长,而她在手机上看的是最上面那三行。
 */
export function buildFeatureResultDoc(input: FeatureResultInput): string {
  const ok = input.exitCode === 0
  const lines: string[] = []
  lines.push(`# 结果:${input.item.trim()}`)
  lines.push('')
  lines.push(`- 成没成:**${ok ? '成了' : '没成'}**(退出码 ${input.exitCode})`)
  if (input.hand !== undefined && input.hand.trim() !== '') lines.push(`- 谁做的:${input.hand.trim()}`)
  if (input.cwd !== undefined && input.cwd.trim() !== '') lines.push(`- 在哪跑的:${input.cwd.trim()}`)
  lines.push(`- 什么时候:${input.at.toISOString()}`)
  lines.push('')

  lines.push('## 改了哪些文件')
  lines.push('')
  if (input.changed === undefined) {
    lines.push('没取(这一次没在项目根问过 git)。')
  }
  else if (input.changed.error !== undefined) {
    lines.push(input.changed.error)
  }
  else if (input.changed.status === '' && input.changed.stat === '') {
    lines.push('一个文件都没改(`git status --short` 是空的)。')
  }
  else {
    lines.push('`git status --short`:')
    lines.push('')
    lines.push(block(input.changed.status, '(空的)'))
    lines.push('')
    lines.push('`git diff --stat`:')
    lines.push('')
    lines.push(block(input.changed.stat, '(空的 —— 改动可能已经 add 过了)'))
  }
  lines.push('')

  lines.push('## 测试')
  lines.push('')
  if (input.test === undefined) lines.push('没跑(这一次没探过项目里有没有测试)。')
  else {
    lines.push(input.test.ran ? `跑了:${input.test.why}` : `没跑:${input.test.why}`)
    if (input.test.tail !== undefined && input.test.tail.trim() !== '') {
      lines.push('')
      lines.push(block(input.test.tail, '(没有输出)'))
    }
  }
  lines.push('')

  const tail = tailLines(input.log ?? '')
  lines.push(`## 最后 ${RESULT_LOG_TAIL} 行`)
  lines.push('')
  if (tail.cut > 0) lines.push(`(前面还有 ${tail.cut} 行没贴)`)
  lines.push('')
  const clipped = tail.text.length > RESULT_LOG_MAX_CHARS
    ? `${tail.text.slice(-RESULT_LOG_MAX_CHARS)}\n(这一段太长,只留了末尾 ${RESULT_LOG_MAX_CHARS} 字)`
    : tail.text
  lines.push(block(clipped, '(它一个字都没输出)'))
  lines.push('')

  lines.push('## 截图')
  lines.push('')
  lines.push(input.shot === undefined || input.shot.trim() === '' ? NO_SHOT_NOTE : input.shot.trim())
  lines.push('')
  return lines.join('\n')
}

export interface WriteFeatureResult {
  ok: boolean
  /** 落在哪(绝对路径)。出错时也带上 —— 她要知道我们本来想写哪儿。 */
  path?: string
  file?: string
  reason?: string
}

/**
 * 把一份结果落进需求目录。**覆盖同名的那一份**(重派一次看的是最新那次的结果),
 * 与产物页签那边"写之前存快照"不同:结果不是她会去改的东西,留一堆历史只会把目录撑满。
 */
export async function writeFeatureResult(dir: string, input: FeatureResultInput): Promise<WriteFeatureResult> {
  const file = resultFileOf(input.item)
  if (file === undefined) {
    return { ok: false, reason: '子事项的名字不能带 / 或 \\,也不能以点开头 —— 它要当文件名用' }
  }
  const path = join(dir, file)
  try {
    await mkdir(dir, { recursive: true })
    await writeFile(path, buildFeatureResultDoc(input), 'utf8')
  }
  catch (error) {
    return { ok: false, path, file, reason: `写不进 ${file}:${(error as Error).message}` }
  }
  return { ok: true, path, file }
}

/** 读一份已经落下的结果(「验收」页签要念它)。不存在回 undefined —— 不是错。 */
export async function readFeatureResult(dir: string, item: string): Promise<string | undefined> {
  const file = resultFileOf(item)
  if (file === undefined) return undefined
  return readIfThere(join(dir, file))
}

/**
 * 一份结果在「验收」页签上的那一行摘要。**只从落下的那份文件里读**,不另存一份状态
 * ——「这条需求上发生过什么只该有一处可查」(同 `审核记录.jsonl` 那条纪律)。
 */
export function resultSummaryLine(item: string, text: string): string {
  const ok = /- 成没成:\*\*成了\*\*/.test(text)
  const code = /退出码 (-?\d+)/.exec(text)?.[1]
  const files = /`git status --short`/.test(text) ? '有改动' : '没记到改动'
  return `- ${item}:${ok ? '成了' : '没成'}(退出码 ${code ?? '不详'},${files})`
}

/**
 * 这条需求目录里已经落了哪几份结果(「验收」页签念的就是这一份)。
 *
 * **现扫目录,不另存一份清单**:一份存在别处的清单与目录里的文件迟早会漂
 * (同 `审核记录.jsonl`「这条需求上发生过什么只该有一处可查」那条纪律)。
 *
 * 目录读不到回空数组 —— **不是错**:这条需求还没派过活而已。
 */
export async function listFeatureResults(dir: string): Promise<FeatureResultView[]> {
  let names: string[]
  try {
    names = (await readdir(dir, { withFileTypes: true }))
      .filter(entry => entry.isFile() && entry.name.startsWith(RESULT_FILE_PREFIX) && entry.name.endsWith('.md'))
      .map(entry => entry.name)
      .sort()
  }
  catch { return [] }

  const out: FeatureResultView[] = []
  for (const file of names) {
    const item = file.slice(RESULT_FILE_PREFIX.length, -'.md'.length)
    const text = await readIfThere(join(dir, file)).catch(() => undefined)
    if (text === undefined) continue
    let updatedAt: string | undefined
    try { updatedAt = (await stat(join(dir, file))).mtime.toISOString() }
    catch { updatedAt = undefined }
    out.push({
      item,
      file,
      ok: /- 成没成:\*\*成了\*\*/.test(text),
      summary: resultSummaryLine(item, text),
      text,
      ...(updatedAt === undefined ? {} : { updated_at: updatedAt }),
    })
  }
  return out
}
