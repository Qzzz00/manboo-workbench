/**
 * 事务官要问他的话、要他批的事 —— 摆到外层(2026-09-25,卡 M;维护者点名的 bug)。
 *
 * 维护者原话:「我点了事务官那里的按钮……然后就变成这个页面了,工作台回不来了」;
 * 「对于用户来说,不应该漏出来这个底层,选项应该直接在外层事务官那里显示」;
 * 「现在它有很多要我给权限的,它也不弹出来……事务官自己应该也有气泡才对」。
 *
 * DSH 会话里她停下来等他的只有两种,都是上游的 waterfall,工作台都排在最前面(prepend):
 *
 * | 哪一种 | DSH 里叫什么 | 他在哪答 |
 * |---|---|---|
 * | 她问他一件事(确认点、二选一) | `ask_user_question` 工具 → `user-questions/request` | 本文件的 {@link QuestionBroker} |
 * | 她要做一件得他批的事(越出工作文件夹、提到最高权限) | `approval/request` | `composer.ts` 的审批经纪人(本文件给它配人话与「同类的都允许」) |
 *
 * 以前两样都只在 DSH 原始界面里有面板;审批那一样 09-24 起挂到了球下,可写的是底层原话
 * (「escalate sandbox to danger-full-access: headless Chrome 要写……」)。现在:
 *   - 提问:电脑球下一张卡(她的话 + 选项 + 「我自己说」),手机「等你确认」一行,点开同一套;
 *   - 审批:一句人话说她要做什么、为什么、放开到多大;底层原话收进「看原始」;
 *   - 同一件事里同类的审批(「开浏览器截图」「改某个仓库」)可以一次都允许,后面同类的不再一条条问。
 *
 * 这个文件除 {@link createQuestionBroker} / {@link createApprovalGrants} 两个内存小仓外全是纯函数,不碰磁盘。
 */
import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, normalize } from 'node:path'
import type {
  ApprovalGrantView, PendingQuestionItemView, PendingQuestionView, QuestionAnswerItem, TaskView,
} from '../protocol.ts'
import { plainForHim } from '../plainText.ts'
import { isButlerProposalAsk } from '../waiting.ts'

// ───────────────────────────── 文字:不露底层 ─────────────────────────────

/**
 * 模型写给人看的话里那几种记号去掉(维护者规矩第 3 条:不露 `**` 这类符号)。只去记号不改字:
 * `**加粗**` → 加粗、`` `代码` `` → 代码、行首 `#` / `>` 去掉、`[字](链接)` → 字;三个以上空行并成一个。
 */
export function plainSay(text: string): string {
  // 同 /state 那一个出口(src/plainText.ts,卡 M 补):给他看的字只洗一种方法。
  return plainForHim(text)
}

/** 选项上的字:「(Recommended)」这类英文注脚换成「(推荐)」。**交回去的仍是原样的 label**。 */
export function optionText(label: string): string {
  return plainSay(label).replace(/\s*[(（]\s*recommended\s*[)）]/gi, '(推荐)').trim()
}

/**
 * 她写的理由里常见的几个底层词换成人话(维护者规矩第 3 条:不露英文与内部的东西)。
 * 只换这张表里的,**不改写句子** —— 换不动的原样留着,原话另在「看原始」里。
 */
const TECH_WORDS: readonly (readonly [RegExp, string])[] = [
  [/danger-full-access/gi, '最高权限'],
  [/workspace-write/gi, '只改工作文件夹'],
  [/\bheadless\s+(?:Chrome|Chromium)\b/gi, '看不见的浏览器'],
  [/\bheadless\b/gi, '看不见的'],
  [/\b(?:Google\s+)?Chrome(?:\s+for\s+Testing)?\b|\bChromium\b/g, '浏览器'],
  [/\bcrashpad\b/gi, '崩溃记录'],
  [/\bdev\s*server\b/gi, '预览服务'],
  [/\bsandbox\b/gi, '权限'],
  [/\brepo\b/gi, '仓库'],
]

export function humanizeTech(text: string): string {
  let out = plainSay(text)
  for (const [pattern, word] of TECH_WORDS) out = out.replace(pattern, word)
  // 英文词换成中文之后,它两边原来隔英文用的空格就成了中文里的空格(「看不见的浏览器 要写…与 崩溃记录 目录」):
  // 两个汉字之间的空格去掉;汉字与留下来的英文之间的照旧(「派 Codex 去修」)。
  out = out.replace(/([㐀-鿿」』])[ \t]+(?=[㐀-鿿「『])/g, '$1')
  return out.replace(/[ \t]{2,}/g, ' ').trim()
}

/** 一段字里有没有中文。没有的(纯英文的底层原因)不当人话摆出来,只进「看原始」。 */
export function hasCjk(text: string): boolean {
  return /[㐀-鿿]/.test(text)
}

/** 截短(按码点),超了加「…」。 */
export function clip(text: string, max: number): string {
  const chars = [...text]
  return chars.length <= max ? text : `${chars.slice(0, max).join('')}…`
}

// ───────────────────────────── 提问 ─────────────────────────────

/** DSH `AskUserQuestionItem` 的形状(结构性读取,不 import 上游)。 */
export interface AskQuestionItem {
  id: string
  question: string
  detail?: string
  header?: string
  options?: readonly { label: string, description?: string }[]
  multiSelect?: boolean
}

/** 挂着的一问(内部形状,原样保留她给的字,出 /state 前再收拾)。 */
export interface PendingQuestionRaw {
  id: string
  session_id: string
  questions: readonly AskQuestionItem[]
  at: string
}

export type QuestionOutcome =
  | { kind: 'answer', answers: QuestionAnswerItem[] }
  | { kind: 'cancelled' }

export type QuestionAnswerResult =
  | { ok: true }
  | { ok: false, status: 400 | 409, error: string }

export interface QuestionBroker {
  /**
   * 挂一问,等电脑 / 手机上答;signal 取消就以 cancelled 收场(那一行随之消失)。
   *
   * `at`:这一问**第一次**问他是什么时候。只有「重启后照自己的账挂回来」的那几问会传
   * (2026-09-26,卡 U8:进度那几问落在 progress.json 里,起服务时原样挂回)——
   * 不传就是现在。挂回来的那一问不该看起来像刚问的:他昨天就看见了。
   */
  ask: (req: { sessionId: string, questions: readonly unknown[], signal?: AbortSignal, at?: string }) => { id: string, answer: Promise<QuestionOutcome> }
  list: () => readonly PendingQuestionRaw[]
  /** 他答了。答法不对回 400(一个字不落);这一问已经不在(答过 / 她不等了)回 409。 */
  answer: (id: string, answers: unknown) => QuestionAnswerResult
  /** 有变化(挂上、答掉、取消)就叫一次。 */
  onChange: (listener: () => void) => () => void
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** 她给的那一批问题,只留认得出的(没 id / 没问题正文的那一问不挂:挂上去也答不了)。 */
export function sanitizeQuestions(questions: readonly unknown[]): AskQuestionItem[] {
  const out: AskQuestionItem[] = []
  for (const one of Array.isArray(questions) ? questions : []) {
    if (!isRecord(one) || typeof one.id !== 'string' || one.id === '' || typeof one.question !== 'string') continue
    const options = Array.isArray(one.options)
      ? one.options.filter((option): option is { label: string, description?: string } => isRecord(option) && typeof option.label === 'string' && option.label !== '')
        .map(option => ({ label: option.label, ...(typeof option.description === 'string' && option.description !== '' ? { description: option.description } : {}) }))
      : []
    out.push({
      id: one.id,
      question: one.question,
      ...(typeof one.detail === 'string' && one.detail.trim() !== '' ? { detail: one.detail } : {}),
      ...(typeof one.header === 'string' && one.header.trim() !== '' ? { header: one.header } : {}),
      ...(options.length > 0 ? { options } : {}),
      ...(one.multiSelect === true ? { multiSelect: true } : {}),
    })
  }
  return out
}

/** 「我自己说」最多多长(一段话够了;再长就不是回答一问,是另开一件事)。 */
export const QUESTION_CUSTOM_MAX = 2000

/**
 * 他交上来的答案对不对得上这一批问题,对得上就整理成 DSH 要的形状(按问题的顺序,一问一条)。
 *
 * - 选的必须是这一问**原样的**选项名;单选只能选一个;
 * - 「我自己说」去头尾空白,单选时它**顶掉**选项(同 DSH:custom overrides the selected choice);
 * - 没答的那一问交 `{ id, selected: [] }`(同 DSH 的「跳过这一问」);**一问都没答**不收。
 */
export function normalizeQuestionAnswer(
  questions: readonly AskQuestionItem[],
  answers: unknown,
): { ok: true, answers: QuestionAnswerItem[] } | { ok: false, error: string } {
  if (!Array.isArray(answers)) return { ok: false, error: '要带 answers:每一问一条 { id, selected, custom? }' }
  const byId = new Map<string, Record<string, unknown>>()
  for (const item of answers) {
    if (!isRecord(item) || typeof item.id !== 'string') return { ok: false, error: '每一条回答都要带 id' }
    if (!questions.some(question => question.id === item.id)) return { ok: false, error: '没有这一问' }
    byId.set(item.id, item)
  }
  const out: QuestionAnswerItem[] = []
  let answered = 0
  for (const question of questions) {
    const item = byId.get(question.id)
    if (item === undefined) { out.push({ id: question.id, selected: [] }); continue }
    const labels = new Set((question.options ?? []).map(option => option.label))
    const selected: string[] = []
    for (const label of Array.isArray(item.selected) ? item.selected : []) {
      if (typeof label !== 'string') continue
      if (!labels.has(label)) return { ok: false, error: `「${clip(label, 20)}」不是这一问的选项` }
      if (!selected.includes(label)) selected.push(label)
    }
    const custom = typeof item.custom === 'string' ? item.custom.trim() : ''
    if ([...custom].length > QUESTION_CUSTOM_MAX) return { ok: false, error: `自己说的那段太长了(最多 ${QUESTION_CUSTOM_MAX} 个字)` }
    if (question.multiSelect !== true && selected.length > 1) return { ok: false, error: '这一问只能选一个' }
    const single = question.multiSelect !== true
    const finalSelected = single && custom !== '' ? [] : selected
    if (finalSelected.length > 0 || custom !== '') answered += 1
    out.push({ id: question.id, selected: finalSelected, ...(custom === '' ? {} : { custom }) })
  }
  if (answered === 0) return { ok: false, error: '一问都还没答:点一个选项,或者在「我自己说」里写一句' }
  return { ok: true, answers: out }
}

export function createQuestionBroker(now: () => Date = () => new Date()): QuestionBroker {
  const pending = new Map<string, { raw: PendingQuestionRaw, settle: (outcome: QuestionOutcome) => void }>()
  const listeners = new Set<() => void>()
  const changed = (): void => { for (const listener of listeners) { try { listener() } catch { /* 一个监听者坏了不连累别人 */ } } }
  return {
    ask(req) {
      const id = randomUUID()
      // 这一轮已经停了:挂都不挂(挂上再撤会让两端闪一下)。
      if (req.signal?.aborted === true) return { id, answer: Promise.resolve({ kind: 'cancelled' }) }
      const questions = sanitizeQuestions(req.questions)
      let settleNow: ((outcome: QuestionOutcome) => void) | undefined
      const answer = new Promise<QuestionOutcome>((resolve) => {
        const settle = (outcome: QuestionOutcome): void => {
          if (!pending.delete(id)) return
          resolve(outcome)
          changed()
        }
        settleNow = settle
        pending.set(id, { raw: { id, session_id: req.sessionId, questions, at: req.at ?? now().toISOString() }, settle })
      })
      req.signal?.addEventListener('abort', () => settleNow?.({ kind: 'cancelled' }), { once: true })
      changed()
      return { id, answer }
    },
    list: () => [...pending.values()].map(one => one.raw),
    answer(id, answers) {
      const one = pending.get(id)
      if (one === undefined) return { ok: false, status: 409, error: '这一问已经答过了,或者事务官已经不等了' }
      const normalized = normalizeQuestionAnswer(one.raw.questions, answers)
      if (!normalized.ok) return { ok: false, status: 400, error: normalized.error }
      one.settle({ kind: 'answer', answers: normalized.answers })
      return { ok: true }
    },
    onChange(listener) {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
  }
}

type TaskRef = Pick<TaskView, 'id' | 'title' | 'conversation'>

/** 挂着的几问配上卡(会话 → 事项),文字收拾干净。 */
/**
 * 这一问是哪张卡上的(合并卡 W 09-25 接线)。
 *
 * 事务官在自己会话里问的,`session_id` 就是那条 DSH 会话;**不在会话里问的**那几问把事项 id 写在前缀后面:
 *   - `progress:<事项 id>`(卡 N:「还没看到进展,要你说一句」);
 *   - `dispatch:<事项 id>`(卡 O / 卡 F:「这张派给 X 开工?」—— 审批那一路 `approvalViews` 早就这么认了,提问这一路照同一套)。
 * 后半截不是事项 id 的(卡 N 的 `progress:access`「看各家的对话」)找不到卡,那一行就不带事项名 —— 正是要的:
 * 那是事务官自己问的,不属于哪一件事。
 */
function taskOfAsk(sessionId: string, tasks: readonly TaskRef[]): TaskRef | undefined {
  for (const prefix of ASK_TASK_PREFIXES) {
    if (!sessionId.startsWith(prefix)) continue
    const id = sessionId.slice(prefix.length)
    return id === '' ? undefined : tasks.find(t => t.id === id)
  }
  return tasks.find(t => t.conversation?.session_id === sessionId)
}

/** 会话 id 里「后半截是事项 id」的那几个前缀。 */
const ASK_TASK_PREFIXES = ['progress:', 'dispatch:'] as const

export function questionViews(pending: readonly PendingQuestionRaw[], tasks: readonly TaskRef[]): PendingQuestionView[] {
  return pending.map((one) => {
    const task = taskOfAsk(one.session_id, tasks)
    const questions: PendingQuestionItemView[] = one.questions.map((question) => {
      const header = question.header === undefined ? '' : plainSay(question.header)
      const detail = question.detail === undefined ? '' : plainSay(question.detail)
      return {
        id: question.id,
        ...(header === '' ? {} : { header }),
        question: plainSay(question.question),
        ...(detail === '' ? {} : { detail }),
        multi: question.multiSelect === true,
        options: (question.options ?? []).map((option) => {
          const note = option.description === undefined ? '' : plainSay(option.description)
          return { label: option.label, text: optionText(option.label), ...(note === '' ? {} : { note }) }
        }),
      }
    })
    return {
      id: one.id,
      session_id: one.session_id,
      ...(task === undefined ? {} : { task_id: task.id, task_title: task.title }),
      at: one.at,
      questions,
    }
  })
}

// ───────────────────────────── 审批:说人话 ─────────────────────────────

/** DSH 沙箱提权那一问的原话:`escalate sandbox to <档>: <她的理由>`(dsh-sandbox 的 approveEscalation)。 */
export function parseEscalation(reason: string | undefined): { mode: string, why: string } | undefined {
  if (typeof reason !== 'string') return undefined
  const match = /^\s*escalate sandbox to ([a-z-]+)\s*:?\s*([\s\S]*)$/i.exec(reason)
  if (match === null) return undefined
  return { mode: (match[1] ?? '').toLowerCase(), why: (match[2] ?? '').trim() }
}

/** 工具名 → 她要做的那件事(人话)。认不出的说「做一件事」。 */
const TOOL_DOES: Readonly<Record<string, string>> = {
  bash: '跑一条命令',
  shell: '跑一条命令',
  pwsh: '跑一条命令',
  write: '写一个文件',
  edit: '改一个文件',
  multi_edit: '改一个文件',
  str_replace_editor: '改一个文件',
  apply_patch: '改几个文件',
  read: '读一个文件',
  web_fetch: '上网取一个页面',
}

export function toolDoes(tool: string): string {
  return TOOL_DOES[tool] ?? '做一件事'
}

/** 同一件事里「同类的」那一类。`key` 用来记「这件事里都允许」,`title` 摆在按钮上。 */
export interface ApprovalKind {
  key: string
  title: string
}

export interface ApprovalDetail {
  say: string
  why?: string
  scope?: string
  kind?: ApprovalKind
  raw: { reason?: string, command?: string }
}

/** 她要干的那件事的原文(命令 / 文件路径),给「看原始」与分类用。 */
export function approvalSubject(args: Record<string, unknown> | undefined): string | undefined {
  if (args === undefined) return undefined
  for (const key of ['command', 'file_path', 'path', 'url']) {
    const value = args[key]
    if (typeof value === 'string' && value.trim() !== '') return value
  }
  return undefined
}

/**
 * 一条审批翻成人话(电脑与手机照着摆,两端一个字不差)。
 *
 * - 沙箱提权(`escalate sandbox to …`):**说清放开到多大** —— 维护者 09-25:「要提档到最高的,仍然要问,且说清范围」;
 * - 别的审批(钩子判的「这一下要问」):理由是中文就摆出来,英文原话只进「看原始」。
 */
export function describeApproval(input: {
  tool: string
  reason?: string
  args?: Record<string, unknown>
  kind?: ApprovalKind
  /** 她平时能改的那个文件夹叫什么(「工作台」)。 */
  workspaceName?: string
}): ApprovalDetail {
  const subject = approvalSubject(input.args)
  const raw = {
    ...(input.reason === undefined || input.reason === '' ? {} : { reason: input.reason }),
    ...(subject === undefined ? {} : { command: clip(subject, 4000) }),
  }
  const escalation = parseEscalation(input.reason)
  const justification = escalation?.why
    ?? (typeof input.args?.justification === 'string' ? input.args.justification : undefined)
  const mode = escalation?.mode ?? (typeof input.args?.sandbox_permissions === 'string' ? input.args.sandbox_permissions : undefined)
  const folder = `「${input.workspaceName !== undefined && input.workspaceName !== '' ? input.workspaceName : '工作'}」文件夹`
  const does = input.kind?.key === 'browser'
    ? '开一个看不见的浏览器,把页面截下来看'
    : input.kind?.key.startsWith('repo:') === true
      ? `在「${basename(input.kind.key.slice('repo:'.length))}」这个仓库里${toolDoes(input.tool)}`
      : toolDoes(input.tool)
  if (mode !== undefined) {
    const scope = mode === 'danger-full-access'
      ? `这一条要能改这台电脑上的任何文件;平时只能改${folder}和临时文件。`
      : mode === 'workspace-write'
        ? `这一条要能改${folder}里的文件;平时只能读。`
        : '这一条要比平时多一点权限。'
    const why = justification === undefined ? '' : humanizeTech(justification)
    return {
      say: `要${does}`,
      ...(why === '' ? {} : { why }),
      scope,
      ...(input.kind === undefined ? {} : { kind: input.kind }),
      raw,
    }
  }
  const why = input.reason !== undefined && hasCjk(input.reason) ? humanizeTech(input.reason) : ''
  return {
    say: `要${does}`,
    ...(why === '' ? {} : { why }),
    scope: '只这一次。',
    raw,
  }
}

// ───────────────────────────── 审批:同一件事里同类的 ─────────────────────────────

/**
 * 从命令里捡出绝对路径(与 `~/` 开头的,展开成家目录)。只认像路径的那一段,引号里的也捡。
 * 捡不全不要紧:这一步只决定「能不能合并」,捡漏了最多是那一类不给合并、照旧问他。
 */
export function pathsIn(text: string, home: string): string[] {
  const out: string[] = []
  // 网址不是路径(`http://127.0.0.1:4199/…` 里那一截 `//127…` 别当成根目录下的东西)。
  const bare = text.replace(/[a-z][a-z0-9+.-]*:\/\/[^\s'"<>|;&)]*/gi, ' ')
  const pattern = /(?:^|[\s'"=:(,])((?:~|\/)[^\s'"<>|;&)(,`$]*)/g
  for (let match = pattern.exec(bare); match !== null; match = pattern.exec(bare)) {
    let path = match[1] ?? ''
    if (path === '' || path === '/' || path === '~') { out.push(path === '~' ? home : '/'); continue }
    if (path.startsWith('~/')) path = join(home, path.slice(2))
    else if (path.startsWith('~')) continue // ~别人
    if (!isAbsolute(path)) continue
    out.push(normalize(path).replace(/\/+$/, '') || '/')
  }
  return out
}

function under(path: string, root: string): boolean {
  const r = root.replace(/\/+$/, '')
  return path === r || path.startsWith(`${r}/`)
}

/** 临时文件夹(DSH 的「只改工作文件夹」本来就放行这几处,见上游 dsh-sandbox 的 writableRoots)。 */
export function isTempPath(path: string, tempRoots: readonly string[]): boolean {
  if (path === '/dev/null') return true
  return tempRoots.some(root => under(path, root))
}

/** 开浏览器截图那一类认的程序:看不见的浏览器(真浏览器带 --headless,或 Playwright 的 headless shell)。 */
const BROWSER_PROGRAM = /(chrome-headless-shell|headless_shell|Google Chrome|Chromium|chromium|Microsoft Edge|msedge)/i
const BROWSER_HEADLESS = /--headless|--screenshot|--dump-dom|--print-to-pdf/

/** 这几样一出现就不给合并(同类的都允许不能放过去):要删东西、要管理员权限。 */
const NEVER_MERGE = /\bsudo\b|\brm\s|\bmv\s+\/|\bchmod\s+-R\b|\bchown\b|\bdiskutil\b|\blaunchctl\b|\bdefaults\s+write\b/

/**
 * 这条审批属于哪一类「同类的」(2026-09-25,卡 M;维护者:「同一件事里同类的请求合并成一次,而不是一条一条弹」)。
 *
 * **只有沙箱提权那一种**分类(钩子判的审批照旧一条条问)。认得出的只有两类,别的都不给合并:
 *   - `browser`:开看不见的浏览器截图 —— 程序是浏览器、带 --headless / --screenshot,碰到的路径只在临时文件夹、
 *     /Applications 里的浏览器本身、Playwright 的浏览器缓存;
 *   - `repo:<仓库根>`:在**同一个** git 仓库里动手 —— 命令里出现的路径(除临时文件夹外)全在同一个仓库里。
 * 命令里有删东西(`rm`)、`sudo` 这一类的,一律不给合并(照旧一条条问)。
 *
 * 局限写清楚(交接里也写了):分类靠命令原文,`cd` 进仓库之后再用 `..` 往外走这种写法认不出来;
 * 所以「都允许」只在他点过之后、只在这一件事里、只对这一类生效,卡上一直写着能收回。
 */
export function approvalKind(input: {
  tool: string
  args?: Record<string, unknown>
  home: string
  tempRoots: readonly string[]
  repoRootOf: (path: string) => string | undefined
}): ApprovalKind | undefined {
  const args = input.args
  if (args === undefined || typeof args.sandbox_permissions !== 'string') return undefined
  const text = approvalSubject(args)
  if (text === undefined) return undefined
  if (NEVER_MERGE.test(text)) return undefined
  const paths = pathsIn(text, input.home).filter(path => !isTempPath(path, input.tempRoots))
  const isBrowser = BROWSER_PROGRAM.test(text) && BROWSER_HEADLESS.test(text)
  if (isBrowser) {
    const playwright = join(input.home, 'Library', 'Caches', 'ms-playwright')
    const outside = paths.filter(path => !under(path, '/Applications') && !under(path, playwright))
    if (outside.length === 0) return { key: 'browser', title: '开看不见的浏览器截图' }
  }
  if (paths.length === 0) return undefined
  let root: string | undefined
  for (const path of paths) {
    const found = input.repoRootOf(path)
    if (found === undefined || found === '/' || found === input.home) return undefined
    if (root === undefined) root = found
    else if (root !== found) return undefined
  }
  if (root === undefined) return undefined
  return { key: `repo:${root}`, title: `改「${basename(root)}」这个仓库` }
}

/**
 * 找一个路径所在的 git 仓库根(往上找 `.git`)。路径不存在就从它最近的那一层存在的上级开始找。
 * `exists` 注入(测试不碰磁盘)。家目录与根目录不算仓库。
 */
export function findRepoRoot(path: string, home: string, exists: (path: string) => boolean): string | undefined {
  let dir = normalize(path)
  for (let guard = 0; guard < 64; guard += 1) {
    if (dir === '/' || dir === home || dir === '') return undefined
    if (exists(join(dir, '.git'))) return dir
    const parent = dirname(dir)
    if (parent === dir) return undefined
    dir = parent
  }
  return undefined
}

/** 「这件事里同类的都允许」记在内存里。一件事一条会话(一事项一会话),所以按会话记就是按事记。 */
/**
 * 放行记在哪一件上(2026-09-25,卡 M 追加;统筹:「放行记录要存下来。它只对这一件事有效,这件事结束(做完、取消、验收通过)
 * 就作废。DSH 重启后不能再问一遍同一类」):
 *   - 这条会话挂在一件事上(`taskId`)→ **记在那件事上、落盘**:DSH 重启后、那件事换了一条会话接着办,都照样认;
 *     那件事收了(完成 / 取消,验收通过就是完成)或者不在了 → 作废({@link ApprovalGrants.prune});
 *   - 没挂在哪件事上(不该有)→ 只记这条会话、只在内存里(说不清是哪件事,就不替他长记)。
 */
export interface GrantScope {
  sessionId: string
  taskId?: string | undefined
}

export interface ApprovalGrantRecord {
  session_id: string
  task_id?: string
  key: string
  title: string
  allowed: number
  at: string
}

export interface ApprovalGrants {
  grant: (scope: GrantScope, kind: ApprovalKind) => void
  granted: (scope: GrantScope, key: string) => boolean
  /** 按这一条又放行了一次(卡上写「已放行 n 次」)。 */
  noteAllowed: (scope: GrantScope, key: string) => void
  /** 收回。回 false = 本来就没有。 */
  revoke: (scope: GrantScope, key: string) => boolean
  /** 那件事收了(办完 / 取消 / 验收通过)或不在了:记在它上面的全作废。回作废了几条。 */
  prune: (alive: (taskId: string) => boolean) => number
  list: () => readonly ApprovalGrantRecord[]
  /** 从磁盘读回来(DSH 重启之后)。没有文件 / 读坏了就当一条都没有 —— 宁可多问一次,不替他瞎放。 */
  load: () => Promise<void>
  /** 排着的写盘都落完(测试用;关服务前也可以等一下)。 */
  flush: () => Promise<void>
  onChange: (listener: () => void) => () => void
}

export interface ApprovalGrantsOptions {
  /** 落在哪(缺省不落盘:测试、没有事项的宿主)。生产是 `~/.dsh/workbench/approval-grants.json`。 */
  file?: string
  now?: () => Date
}

/** 「这件事里同类的都允许」落盘那一份在哪(与 call-out.json、tasks.json 同一个目录)。 */
export function defaultApprovalGrantsFile(home = process.env.HOME ?? ''): string {
  return `${home}/.dsh/workbench/approval-grants.json`
}

interface GrantsFile {
  version: 1
  grants: ApprovalGrantRecord[]
}

function isGrantRecord(value: unknown): value is ApprovalGrantRecord {
  const one = value as Record<string, unknown> | null
  return one !== null && typeof one === 'object'
    && typeof one.session_id === 'string' && typeof one.task_id === 'string' && one.task_id !== ''
    && typeof one.key === 'string' && one.key !== '' && typeof one.title === 'string'
    && typeof one.allowed === 'number' && typeof one.at === 'string'
}

export function createApprovalGrants(options: ApprovalGrantsOptions = {}): ApprovalGrants {
  const now = options.now ?? (() => new Date())
  const grants = new Map<string, ApprovalGrantRecord>()
  const listeners = new Set<() => void>()
  /** 写盘排队(load→改→save 不排队会丢更新,同 tasks.ts / callOut.ts)。 */
  let writing: Promise<unknown> = Promise.resolve()
  const persist = (): void => {
    const file = options.file
    if (file === undefined) return
    // 只落记在事项上的那几条(没挂在事项上的说不清是哪件事,重启就忘)。
    const payload: GrantsFile = { version: 1, grants: [...grants.values()].filter(one => one.task_id !== undefined) }
    writing = writing.then(async () => {
      try {
        await mkdir(dirname(file), { recursive: true })
        const tmp = `${file}.${process.pid}.${randomUUID()}.tmp`
        await writeFile(tmp, `${JSON.stringify(payload, null, 2)}\n`, 'utf8')
        await rename(tmp, file)
      }
      catch { /* 落不了盘只是这一次没记上:DSH 重启后同一类会再问一次,不影响此刻 */ }
    })
  }
  const changed = (): void => {
    persist()
    for (const listener of listeners) { try { listener() } catch { /* 同上 */ } }
  }
  /** 有事项记在事项上,没有记在会话上。 */
  const idOf = (scope: GrantScope, key: string): string => scope.taskId !== undefined && scope.taskId !== ''
    ? `task\u0000${scope.taskId}\u0000${key}`
    : `session\u0000${scope.sessionId}\u0000${key}`
  /** 这一条请求能认哪几条:这件事上记的,和(万一)这条会话上记的。 */
  const find = (scope: GrantScope, key: string): ApprovalGrantRecord | undefined =>
    grants.get(idOf(scope, key)) ?? grants.get(idOf({ sessionId: scope.sessionId }, key))
  return {
    grant(scope, kind) {
      const id = idOf(scope, kind.key)
      if (grants.has(id)) return
      grants.set(id, {
        session_id: scope.sessionId,
        ...(scope.taskId === undefined || scope.taskId === '' ? {} : { task_id: scope.taskId }),
        key: kind.key,
        title: kind.title,
        allowed: 0,
        at: now().toISOString(),
      })
      changed()
    },
    granted: (scope, key) => find(scope, key) !== undefined,
    noteAllowed(scope, key) {
      const one = find(scope, key)
      if (one === undefined) return
      one.allowed += 1
      changed()
    },
    revoke(scope, key) {
      const removed = grants.delete(idOf(scope, key)) || grants.delete(idOf({ sessionId: scope.sessionId }, key))
      if (removed) changed()
      return removed
    },
    prune(alive) {
      let removed = 0
      for (const [id, one] of grants) {
        if (one.task_id === undefined || alive(one.task_id)) continue
        grants.delete(id)
        removed += 1
      }
      if (removed > 0) changed()
      return removed
    },
    list: () => [...grants.values()].map(one => ({ ...one })),
    async load() {
      if (options.file === undefined) return
      let parsed: unknown
      try { parsed = JSON.parse(await readFile(options.file, 'utf8')) }
      catch { return }
      const rows = (parsed as { grants?: unknown } | null)?.grants
      if (!Array.isArray(rows)) return
      for (const row of rows) {
        if (!isGrantRecord(row)) continue
        const id = idOf({ sessionId: row.session_id, taskId: row.task_id }, row.key)
        if (!grants.has(id)) grants.set(id, { ...row })
      }
      for (const listener of listeners) { try { listener() } catch { /* 同上 */ } }
    },
    flush: async () => { await writing },
    onChange(listener) {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
  }
}

/** 记下的几条配上卡。 */
export function grantViews(list: ReturnType<ApprovalGrants['list']>, tasks: readonly TaskRef[]): ApprovalGrantView[] {
  return list.map((one) => {
    if (one.task_id !== undefined) return { ...one }
    const task = tasks.find(t => t.conversation?.session_id === one.session_id)
    return { ...one, ...(task === undefined ? {} : { task_id: task.id }) }
  })
}

/** 这件事还算不算「在办」:完成 / 取消了(验收通过就是完成)、或者看板上没它了,它上面记的「同类的都允许」作废。 */
export function grantTaskAlive(tasks: readonly Pick<TaskView, 'id' | 'status'>[]): (taskId: string) => boolean {
  const byId = new Map(tasks.map(task => [task.id, task.status]))
  return (taskId: string) => {
    const status = byId.get(taskId)
    return status !== undefined && status !== 'done' && status !== 'canceled'
  }
}

// ───────────────────────────── 读 DSH 会话里的那一次工具调用 ─────────────────────────────

/**
 * 审批只带 callId,不带命令本身(上游:「The request carries no tool arguments」)。命令在会话日志里那条 `tool/call` 上 ——
 * 从最新往回找(最多看 `maxScan` 条),找到就把 arguments 解出来。读不到(老宿主、日志形状变了)回 undefined:
 * 那一条照旧能批,只是说不出命令、也不给合并。
 */
export function toolCallArgsOf(session: unknown, callId: unknown, maxScan = 800): Record<string, unknown> | undefined {
  if (typeof callId !== 'string' || callId === '' || !isRecord(session)) return undefined
  const eventAt = session.eventAt
  const seq = session.seq
  if (typeof eventAt !== 'function' || typeof seq !== 'number') return undefined
  for (let at = seq - 1, seen = 0; at >= 0 && seen < maxScan; at -= 1, seen += 1) {
    let event: unknown
    try { event = (eventAt as (seq: number) => unknown).call(session, at) } catch { return undefined }
    if (!isRecord(event) || event.type !== 'tool/call' || !isRecord(event.data) || event.data.callId !== callId) continue
    const raw = event.data.arguments
    if (isRecord(raw)) return raw
    if (typeof raw !== 'string') return undefined
    try {
      const parsed: unknown = JSON.parse(raw)
      return isRecord(parsed) ? parsed : undefined
    }
    catch { return undefined }
  }
  return undefined
}

/**
 * 把请求上的 signal 换成「原来那个 或 我们这一个」(2026-09-25,卡 M)。
 *
 * 为什么:这一问我们排在最前面,同时照样往后传给 DSH 自己的网页(开发者在「看原始」里还能看见、还能答)。
 * 我们这边先答了,DSH 网页上那个面板本该一起消失 —— 上游网关按请求上的 signal 撤掉转发出去的那一份
 * (api-gateway `projectRemoteEventRequest` 读的就是 `request.signal`)。所以往后传之前把它换成合成的那一个,
 * 我们答完 abort 自己那一半,网页那边的面板就收掉了。
 *
 * 请求对象是上游为这一次现拼的(user-questions 的 `{ ...request, agent }`、审批的对象字面量),改它不影响上游自己
 * (上游在派发之前已经把 signal 取走了)。换不了(冻住的对象)就不换:网页那边的面板只是多挂一会儿,不影响他答。
 */
export function combineRequestSignal(request: unknown, local: AbortSignal): void {
  if (!isRecord(request)) return
  const outer = request.signal
  const combined = outer instanceof AbortSignal ? AbortSignal.any([outer, local]) : local
  try { Reflect.set(request, 'signal', combined) } catch { /* 换不了就算了 */ }
}

// ───────────────────────────── 系统通知那一句 ─────────────────────────────

/**
 * 壳弹的那条系统通知写什么(2026-09-25,卡 M;维护者:「它也不弹出来……事务官自己应该也有气泡才对」)。
 * 标题说是哪一种,正文一行说是哪件事、要什么;不念底层原话。
 */
export function askNotice(ask: { kind: 'question', view: PendingQuestionView } | { kind: 'approval', view: { task_title?: string, say?: string, reason?: string, tool: string } }): { title: string, body: string } {
  const subject = (title: string | undefined): string => (title === undefined || title.trim() === '' ? '' : `「${clip(title.trim(), 18)}」`)
  if (ask.kind === 'question') {
    const first = ask.view.questions[0]
    const what = first?.header ?? clip((first?.question ?? '').split('\n').find(line => line.trim() !== '') ?? '', 30)
    return { title: '事务官有话问你', body: `${subject(ask.view.task_title)}${what}` }
  }
  const what = ask.view.say ?? (ask.view.reason !== undefined && hasCjk(ask.view.reason) ? humanizeTech(ask.view.reason) : `要${toolDoes(ask.view.tool)}`)
  return { title: '事务官要你批一件事', body: `${subject(ask.view.task_title)}${clip(what, 40)}` }
}

// ───────────────────────────── 手机响铃 ─────────────────────────────

/**
 * 「她问你的那一问」那一通的键前缀(2026-10-13 提成常量:`/butler/understand` 要按它
 * 从键认回是哪一问、好把那几个选项一起带下去,两处别各写一遍)。
 */
export const QUESTION_ASK_KEY = 'ask:question:'

/**
 * 她问你的话、要你批的事 → 座机来电那一类(`ask`,2026-09-25,卡 M;统筹:「手机上照旧进『等你确认』
 * (白天按来电设置响铃,免打扰时段只通知)」)。每一问 / 每一条一个 key,只打一次;没挂在卡上的不打(电话里说不清是哪件事)。
 * `title` 是来电页上那一行、`note` 是她在电话里据以转述的那几句(工人不照念,见 channel-worker 的 ringInstructions)。
 */
export function askCallOutEvents(
  questions: readonly PendingQuestionView[],
  approvals: readonly { id: string, task_id?: string, task_title?: string, at: string, say?: string, reason?: string, tool: string, why?: string, scope?: string, proposal?: true }[],
): { key: string, reason: 'ask', item_id: string, title: string, note?: string, at: string }[] {
  const subject = (title: string | undefined): string => (title === undefined || title.trim() === '' ? '' : `「${clip(title.trim(), 16)}」`)
  const out: { key: string, reason: 'ask', item_id: string, title: string, note?: string, at: string }[] = []
  for (const one of questions) {
    if (one.task_id === undefined) continue
    // 事务官自己的提议(派单提议 / 进度要你说一句)**不响铃**(2026-09-27,卡 WY):
    // 座机只为「他不点头就卡住」的事响,提议走开工汇报。判据与「等你」那一堆同一份(src/waiting.ts)。
    if (isButlerProposalAsk(one.session_id)) continue
    const first = one.questions[0]
    const what = first?.header ?? clip((first?.question ?? '').split('\n').find(line => line.trim() !== '') ?? '', 24)
    const options = (first?.options ?? []).map(option => option.text)
    const note = [
      clip((first?.question ?? '').replace(/\s+/g, ' ').trim(), 160),
      options.length === 0 ? '' : `选项:${options.join(' / ')}`,
    ].filter(part => part !== '').join(' · ')
    out.push({ key: `${QUESTION_ASK_KEY}${one.id}`, reason: 'ask', item_id: one.task_id, title: `${subject(one.task_title)}问你:${what}`, ...(note === '' ? {} : { note }), at: one.at })
  }
  for (const one of approvals) {
    if (one.task_id === undefined) continue
    /**
     * 事务官自己的提议(「这张派给 X 开工?」)**不响铃**(2026-09-28,卡 UX;卡 WY 已拍板的同一条口径)。
     * 真机 09-28 那 18 条未接里 9 条是同一件事的这一问 —— 提问那一路早就筛掉了(上面 isButlerProposalAsk),
     * 审批这一路漏了。判据认 `proposal` 那一格,不认那句话:他自己交代之后的「派给 Manus(剩 2,690 积分)」
     * 会话 id 前缀与它一模一样,那一条照旧响。
     */
    if (one.proposal === true) continue
    const say = one.say ?? (one.reason !== undefined && hasCjk(one.reason) ? humanizeTech(one.reason) : `要${toolDoes(one.tool)}`)
    const note = [one.why === undefined ? '' : `为什么:${one.why}`, one.scope ?? ''].filter(part => part !== '').join(' · ')
    out.push({ key: `ask:approval:${one.id}`, reason: 'ask', item_id: one.task_id, title: `${subject(one.task_title)}要你批:${clip(say, 30)}`, ...(note === '' ? {} : { note }), at: one.at })
  }
  return out
}

// ───────────────────────────── 电话里答 ─────────────────────────────

function normSaid(text: string): string {
  return text.replace(/[\s,。,.!!??、::;;「」“”"'()()\-—…·]/g, '').replace(/推荐|recommended/gi, '')
}

/**
 * 电话里他说的那一句 → 这一问的答案(2026-09-25,卡 M)。说的正是某个选项(或者把某个选项说全了)就选它;
 * 认不准(对上两个、一个都对不上)就把他的原话当「我自己说」交上去 —— **不替他挑**。
 */
export function voiceAnswerFor(question: PendingQuestionItemView, said: string): { answer: QuestionAnswerItem, picked?: string } {
  const text = said.trim()
  const pick = spokenOptionOf(question.options, text)
  if (pick !== undefined) return { answer: { id: question.id, selected: [pick.label] }, picked: pick.text }
  return { answer: { id: question.id, selected: [], custom: text } }
}

/**
 * **电话里他说的那一句是哪一项**(判据一处;2026-09-28 卡 WQ 从 {@link voiceAnswerFor} 里提出来)。
 *
 * 提出来是因为会话自己弹的那个框也要认同一套(卡 WQ:他在电话里说「川菜」→ 替他点 Codex 那个框上的「川菜」)。
 * 三档,**每一档都要求恰好命中一个**:说的正是那一项 → 把那一项说全了 → 说的是那一项的一截。
 * 对上两个、一个都对不上 → `undefined`:**不替他挑**。
 */
export function spokenOptionOf<T extends { label: string, text?: string }>(options: readonly T[], said: string): T | undefined {
  const n = normSaid(said.trim())
  if (n === '') return undefined
  const words = (one: T): string[] => [one.text ?? '', one.label].map(normSaid).filter(word => word !== '')
  const exact = options.filter(one => words(one).includes(n))
  const within = options.filter(one => words(one).some(word => n.includes(word)))
  const partial = n.length >= 2 ? options.filter(one => words(one).some(word => word.includes(n))) : []
  const byWords = exact.length === 1 ? exact[0] : within.length === 1 ? within[0] : partial.length === 1 ? partial[0] : undefined
  return byWords ?? (exact.length + within.length + partial.length === 0 ? optionByOrdinal(options, n) : undefined)
}

const ORDINAL_DIGITS: Readonly<Record<string, number>> = { 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 }

/**
 * 「第二个」「选第一个吧」「最后一个」→ 那一项(2026-10-12,豆包演示:开场把选项念成一串,她顺口说第几个)。
 * 只在**一项都没按字对上**时才认(选项原话里本来就带「第一」的,照原话认);超出范围就不认。
 */
function optionByOrdinal<T>(options: readonly T[], normalized: string): T | undefined {
  const n = normalized.replace(/^(?:我)?(?:选|要)?/u, '').replace(/(?:吧|啊|呀|好了|就行)$/u, '')
  if (/^最后(?:一个|一项|那个)?$/u.test(n)) return options[options.length - 1]
  const hit = /^第?([一二两三四五六七八九1-9])(?:个|项|种|条|款)$/u.exec(n) ?? /^第([一二两三四五六七八九1-9])$/u.exec(n)
  if (hit === null) return undefined
  const index = ORDINAL_DIGITS[hit[1] as string] ?? Number(hit[1])
  return index >= 1 && index <= options.length ? options[index - 1] : undefined
}

/** 电话里他对一件要批的事说的那一句:批 / 不批 / 听不出。先认「不」(「不行」里也有「行」)。 */
export function voiceVerdict(said: string): 'allow' | 'deny' | undefined {
  const n = normSaid(said)
  if (/(不行|不要|不可以|不能|别|拒绝|算了|不批|先别|不同意|停)/.test(n)) return 'deny'
  if (/(可以|允许|行|好的|好|批|同意|没问题|去吧|开工|对)/.test(n)) return 'allow'
  return undefined
}
