/**
 * DSH 会话里那一问跨不过重启 —— **让事务官重新问一遍**(2026-09-26,卡 SM 第四件)。
 *
 * ## 为什么不是「原样挂回去」
 *
 * 卡 U8 交接第四节第 2 条查清的:`ask_user_question` 那一路(`wireQuestionAnswerer`)只在内存里,
 * **等这一问的是那一轮 agent 的一个 Promise**。工作台重启(热更新 `launchctl kickstart`、装插件)之后
 * 那一轮早没了,把那一行原样摆回界面上是**更糟的谎**:他答了,答案落进一个没人在等的 Promise ——
 * 他以为答过了,而她那边什么也没收到。所以外层**不**挂回那一问(经纪人只在内存里,重启后本来就是空的),
 * 这一层做的是另一件事:**跟那条会话说一句,让她自己再问一次**。她知道要确认什么,重新问出来的那一问
 * 有人在等,答了才算数。
 *
 * 这和卡 U8 的结论是同一条:**账记在问的人那里,让问的人重新问**(进度那几问记在 `progress.json`,
 * 卡 N 的驱动记在 `drive.json`)。这里问的人是 DSH 会话里的事务官自己,而她的账就是**会话日志** ——
 * 所以这一层**不新增任何文件**(9/4 之后的规矩:能不落盘就不落;多一个文件就多一处和真相不同步的地方)。
 *
 * ## 判据(全在 {@link danglingAskOf},纯函数)
 *
 * 会话日志里(形状见 `tests/fixtures/dsh-session-v4/`,上游自己的编码器生成的):
 *
 * | 行 | 说明 |
 * |---|---|
 * | `tool/call` `{ callId, name:'ask_user_question', arguments }` | 她问了他一问 |
 * | `tool/result` `{ message: { toolCallId } }` | 那一问有了着落(答了 / 她自己撤了 / 出错了) |
 * | `user/message` | 他(或我们)往这条会话里说的话 |
 *
 * **断了** = 最后那一次 `ask_user_question` 的 `tool/call` **一条 `tool/result` 都没有**。
 * 只认「压根没有结果」这一种:
 * - 有结果就不碰 —— 内容是 `{answers}` 是他答了;是别的(她自己关掉、出错)说明那一轮已经收到回话、
 *   接着走了。**宁可少问一次,不冤枉一次**:多问一遍等于让她把一件已经定了的事再问他一次。
 * - 进程被 kill 的那一下写不出结果,所以「断了」在日志上的样子就是「有 call、没有 result」。
 *
 * ## 去重:账也在日志里
 *
 * 我们那一句话本身会作为 `user/message` 落进同一份日志。所以「问过没有」不用记在别处:
 * 那一次 `tool/call` **之后**出现过带 {@link RE_ASK_MARK} 的一条 `user/message`,就是**已经让她重新问过了**。
 * 这一条同时管住三种重复:
 * ① 同一次运行里 `resume()` 被叫两遍;② 又重启一次(那一次 call 永远留在日志里,没有这一条会每次重启都说一遍);
 * ③ 她重新问出来的那一问他答掉了 —— 新的那次 call 有 result,而旧的那次前面已经有我们的话。
 */
import type { TaskView } from '../protocol.ts'

/** 我们那一句里必带的记号。**认「问过没有」只认这一句**,所以它改一个字就等于把账本换了(用例钉着)。 */
export const RE_ASK_MARK = '因为工作台重启断了'

/**
 * 跟那条会话说的那一句。写给**她**看(不是给他看的),所以说清三件事:
 * 断了、没人在等他的答复了、原样再问一次。
 */
export const RE_ASK_LINE = `刚才你问我的那一问,${RE_ASK_MARK} —— 我没看见,而且已经没人在等我的答复了。`
  + '请把那一问原样再问我一次(不用重新分析、不用换问法),我答了你再接着办。'

/** 一条会话里断掉的那一问。 */
export interface DanglingAsk {
  /** 那一次工具调用的 id(日志里 `tool/call.data.callId`)。 */
  call_id: string
  /** 她问出来那一刻(日志行上的 `time`,毫秒)。读不出来就缺席,**不猜**。 */
  at_ms?: number
  /** 第一问的正文(只用来记一笔 / 给用例看;不摆到界面上,界面上那一问已经没人在等了)。 */
  question?: string
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** `user/message` 那一行里人能读的字(content 是块数组,也可能就是一段字符串)。 */
function userTextOf(data: Record<string, unknown> | undefined): string {
  const content = data?.content
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .filter(isRecord)
    .map(block => (typeof block.text === 'string' ? block.text : ''))
    .join('\n')
}

/** 她那一问的正文(`arguments` 是一段 JSON 字符串,也可能已经是对象)。取不出来就缺席。 */
function firstQuestionOf(raw: unknown): string | undefined {
  let args: unknown = raw
  if (typeof raw === 'string') {
    try { args = JSON.parse(raw) }
    catch { return undefined }
  }
  if (!isRecord(args) || !Array.isArray(args.questions)) return undefined
  for (const one of args.questions) {
    if (isRecord(one) && typeof one.question === 'string' && one.question !== '') return one.question
  }
  return undefined
}

/**
 * 一份会话日志 → 断掉的那一问(没有就 undefined)。判据与去重见文件头。
 *
 * **只看最后那一次**:一条会话里问过好几轮,要重新问的只有最后那一问 ——
 * 早先那几轮要么答过了,要么她自己早就走过去了(「只问一次」的一半在这里)。
 * 坏行(截断的最后一行、别的东西)一律跳过,**绝不抛**。
 */
export function danglingAskOf(logText: string): DanglingAsk | undefined {
  let open: DanglingAsk | undefined
  for (const line of logText.split('\n')) {
    if (line.trim() === '') continue
    let row: unknown
    try { row = JSON.parse(line) }
    catch { continue }
    if (!isRecord(row)) continue
    const data = isRecord(row.data) ? row.data : undefined
    if (row.type === 'tool/call') {
      if (data?.name !== 'ask_user_question' || typeof data.callId !== 'string' || data.callId === '') continue
      const at = typeof row.time === 'number' && Number.isFinite(row.time) ? row.time : undefined
      const question = firstQuestionOf(data.arguments)
      // 后一问顶掉前一问:要重新问的只有最后那一次。
      open = { call_id: data.callId, ...(at === undefined ? {} : { at_ms: at }), ...(question === undefined ? {} : { question }) }
      continue
    }
    if (row.type === 'tool/result') {
      const message = isRecord(data?.message) ? data.message : undefined
      const callId = typeof message?.toolCallId === 'string'
        ? message.toolCallId
        : (isRecord(message?.source) && typeof message.source.callId === 'string' ? message.source.callId : undefined)
      // 有了着落就不是「断了」(答了 / 她自己撤了 / 出错了都算,理由见文件头)。
      if (callId !== undefined && open?.call_id === callId) open = undefined
      continue
    }
    if (row.type === 'user/message' && open !== undefined && userTextOf(data).includes(RE_ASK_MARK)) {
      // 这一次已经让她重新问过了(账就在日志里)。
      open = undefined
    }
  }
  return open
}

/** 这条会话的日志在哪:`<sessionsDir>/<编码后的项目目录>/<会话 id>/session[.vN].jsonl[.zstd]`。 */
export interface DshAskResumeIo {
  /** 一层目录里有什么。读不了(不存在、没权限)一律回空数组,**不抛**。 */
  readdir: (dir: string) => Promise<readonly string[]>
  /** 读一份日志(已经解过压的文字)。读不了 / 解不开回 undefined。 */
  readLog: (file: string, compressed: boolean) => Promise<string | undefined>
}

export interface DshAskResumeDeps {
  /** `~/.dsh/sessions`。 */
  sessionsDir: string
  io: DshAskResumeIo
  /** 看板上的事项(候选会话从这儿来,理由见 {@link candidateSessions})。 */
  tasks: () => Promise<readonly TaskView[]>
  /** 这会儿经纪人里挂着的那几问(`questions.list()`)。它们是**活的**,不是断的。 */
  pending: () => readonly { session_id: string }[]
  /** 往那条会话里说一句(`butlerSession.say`)。回 false = 这句没说进去。 */
  say: (sessionId: string, text: string) => Promise<boolean>
  /** 会话通道接上了没(`butlerSession.available`)。缺席按「接上了」。 */
  ready?: () => boolean
  /** 等一会儿(等注册表把 sessionController 送来)。用例传一个立即完成的。 */
  wait?: (ms: number) => Promise<void>
  /** 最多等几拍、每拍多久。 */
  readyTries?: number
  readyGapMs?: number
}

/** 这一趟做了什么(给用例与日志看;界面上不显示 —— 这件事他不需要知道)。 */
export interface DshAskResumeReport {
  /** 通道没接上,这一趟什么也没做(下次重启再说)。 */
  ready: boolean
  /** 看了几条会话。 */
  looked: number
  /** 让她重新问的那几条会话。 */
  asked: readonly string[]
  /** 认出断了、但那一句没说进去的(会话在 DSH 里真没了)。 */
  failed: readonly string[]
}

export interface DshAskResume {
  /** 起服务时叫一次。**叫第二次是空操作**(「只问一次」的另一半)。绝不抛。 */
  resume: () => Promise<DshAskResumeReport>
}

/**
 * 要看哪几条会话:**看板上还活着的事项底下那几条**(去重,最多 {@link CANDIDATES_MAX} 条)。
 *
 * 为什么不扫整个 `~/.dsh/sessions`:① 那里有历史上每一条会话,起服务时整份读一遍又慢又没用;
 * ② 一问总是挂在一件事上(同卡 M 把「同类的都允许」记在事项上那条),不在看板上的会话
 * (引导、例程开的那几条)就算有一问断了,重新问出来也没人看得见;
 * ③ 完成 / 取消了的事项**不再问**(同 `grantTaskAlive`:那件事已经定了,再问他一遍是打扰)。
 */
export function candidateSessions(tasks: readonly TaskView[]): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  for (const task of tasks) {
    if (task.status === 'done' || task.status === 'canceled') continue
    const id = task.conversation?.session_id
    if (typeof id !== 'string' || id === '' || seen.has(id)) continue
    seen.add(id)
    out.push(id)
    if (out.length >= CANDIDATES_MAX) break
  }
  return out
}

/** 一趟最多看几条会话。看板上活着的事项本来就是十几件这个量级,这是个兜底。 */
export const CANDIDATES_MAX = 30

/** 上游规范名 + 压缩后缀,同 `dshSessionFile.ts`;这里只要「是不是一份日志、压没压」。 */
const LOG_NAME_RE = /^session(?:\.v([1-9][0-9]*))?\.jsonl(\.zstd)?$/

/** 一个会话目录里该读哪一份:**数字最高的那一代**(同 `pickLatestGeneration` 那条纪律)。 */
export function pickLogName(names: readonly string[]): { name: string, compressed: boolean } | undefined {
  let best: { name: string, compressed: boolean, version: number } | undefined
  for (const name of names) {
    const match = LOG_NAME_RE.exec(name)
    if (match === null) continue
    const version = match[1] === undefined ? 0 : Number(match[1])
    const compressed = match[2] !== undefined
    // 同一代里压缩那份是生产形态(两份同时在只会是手工拷出来的)。
    if (best === undefined || version > best.version || (version === best.version && compressed && !best.compressed)) {
      best = { name, compressed, version }
    }
  }
  return best === undefined ? undefined : { name: best.name, compressed: best.compressed }
}

export function createDshAskResume(deps: DshAskResumeDeps): DshAskResume {
  const wait = deps.wait ?? (async (ms: number) => { await new Promise<void>((resolve) => { const t = setTimeout(resolve, ms); t.unref?.() }) })
  const tries = deps.readyTries ?? 20
  const gap = deps.readyGapMs ?? 500
  let done = false

  /** 这条会话的日志文件(在哪个项目目录底下不知道,所以按会话 id 找一遍)。 */
  async function logOf(sessionId: string): Promise<{ file: string, compressed: boolean } | undefined> {
    for (const project of await deps.io.readdir(deps.sessionsDir)) {
      const dir = `${deps.sessionsDir}/${project}/${sessionId}`
      const picked = pickLogName(await deps.io.readdir(dir))
      if (picked !== undefined) return { file: `${dir}/${picked.name}`, compressed: picked.compressed }
    }
    return undefined
  }

  return {
    async resume(): Promise<DshAskResumeReport> {
      // 「只问一次」:叫第二次是空操作(热更新只重启一次,但起服务那一段有好几条路会走过来)。
      if (done) return { ready: true, looked: 0, asked: [], failed: [] }
      // 通道还没接上就等一会儿(`ctx.inject` 是异步来的);等不到就算了,下次重启再说 ——
      // 硬等在这儿会把起服务那一段拖住,而这件事一点都不急。
      for (let i = 0; deps.ready !== undefined && !deps.ready() && i < tries; i += 1) await wait(gap)
      // **这一趟一句话都没说,所以不算「问过了」**:一次也没催成的空跑不该把这一枪用掉
      // (`done` 因此落在这道闸门后面,而不是进门就落)。
      if (deps.ready !== undefined && !deps.ready()) return { ready: false, looked: 0, asked: [], failed: [] }
      done = true

      let tasks: readonly TaskView[] = []
      try { tasks = await deps.tasks() }
      catch { tasks = [] }
      // 经纪人里挂着的那几条是**活的**(这一趟之前刚问的):不是断了,别去催。
      let live: ReadonlySet<string> = new Set()
      try { live = new Set(deps.pending().map(one => one.session_id)) }
      catch { live = new Set() }

      const asked: string[] = []
      const failed: string[] = []
      let looked = 0
      for (const sessionId of candidateSessions(tasks)) {
        if (live.has(sessionId)) continue
        looked += 1
        let text: string | undefined
        try {
          const found = await logOf(sessionId)
          text = found === undefined ? undefined : await deps.io.readLog(found.file, found.compressed)
        }
        catch { text = undefined }
        if (text === undefined) continue
        let dangling: DanglingAsk | undefined
        try { dangling = danglingAskOf(text) }
        catch { dangling = undefined }
        if (dangling === undefined) continue
        let accepted = false
        try { accepted = await deps.say(sessionId, RE_ASK_LINE) }
        catch { accepted = false }
        if (accepted) asked.push(sessionId)
        else failed.push(sessionId)
      }
      return { ready: true, looked, asked, failed }
    },
  }
}
