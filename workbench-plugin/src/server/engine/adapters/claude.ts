/**
 * **Claude 桌面:走跨会话消息 socket 送话**(2026-10-02,卡「Claude socket 适配器」;
 * 设计见 `docs/设计-一条引擎替八条管线-2026-10-02.md` 第二节 Claude 那一行,契约见 `../adapter.ts`)。
 *
 * 从前往 Claude 桌面那条会话里送一句话,走的是最脆的那一级通道 —— 辅助功能树里找窗口、找那段对话、
 * 打字、读回执。真机日志里清一色「没在它的窗口里找到那段对话」,于是**一次都没送出去**。
 *
 * Claude 桌面自己有协议(官方文档 `code.claude.com/docs/en/cross-session-messaging`),10-02 在维护者这台验通:
 *
 * 1. **登记表**:每条开着的会话一份 `~/.claude/sessions/<pid>.json`,里头 `sessionId`(= 记录文件
 *    `~/.claude/projects/<目录>/<sessionId>.jsonl` 的 id)、`hostSessionId`(深链 `claude://code/continue?session=local_…` 认的那个)、
 *    `messagingSocketPath`(`/tmp/cc-socks/<pid>.sock`,有的版本写成 `uds:/tmp/…`)、`status`、`name`、`peerProtocol: 1`。
 *    **同目录的 `.key` 一个字节都不读** —— macOS / Linux 上 auth 行可有可无(验过不带也直达),所以这里连 auth 行都不发。
 *    (原生 Windows 上 auth 行是必须的,而且带的是会话导出的 `CLAUDE_CODE_MESSAGING_TOKEN`,不是那个 `.key` 文件 ——
 *    这一层只管 macOS / Linux。socket 路径一律**从登记表里读**:Claude 认为 `/tmp/cc-socks` 不可接受时会改用
 *    `/tmp/cc-socks-<uid>`,写死前缀迟早出事。)
 * 2. **线协议**:NDJSON,一行一条:
 *    `{"type":"user","message":{"role":"user","content":"…"},"from":"uds:/tmp/cc-socks/<自己>.sock","msgV":1}`。
 * 3. **对方怎么收**:按她的 `crossSessionInbound` 设置 —— `accept` 直接进、`hold` 等她批、`refuse` 丢。
 *    进去之后在对方的记录文件里是一条 `type:'user'` + `isMeta:true` + `origin.kind:'peer'` 的记录,
 *    正文带着「Another Claude session sent a message」那层包装,**不是她本人的 user turn**。
 * 4. **送到的证据**:就是上面那条记录。所以这里**不信「写成功」**:写完回头到记录文件里核一次,
 *    核上了才说 `confirmed`;只写成功是 `unconfirmed`,并告诉她多半是扣在待批准里、去把设置改成 `accept`。
 *
 * 几条纪律:
 * - **不开窗、不开 App、不找窗口**。登记表里找不到那条会话 = 它没开着,如实说,让她自己打开 —— 这一层只有协议。
 * - 点它框上的按钮 / 写提问面板 / 按停止、以及「新开一条」:socket 协议里没有 → `unsupported`,引擎换窗口路。
 * - 不经模型:核实是数出来的(记录文件里多没多出那句),取不到就说取不到。
 *
 * ⚠️ 为什么证据不直接用 `sessionSaid.createSaidInTranscript`:那一份只收「她亲口说的」
 * (`sessionDigest.claudeAsk` 按 `isMeta` / `origin.kind !== 'human'` 滤掉了注入的行),而工作台送进去的那条
 * **正好是** `isMeta: true` + `origin.kind: 'peer'`,在那份里一句都看不到。所以这里自己认这一类行
 * ({@link claudeDeliveredTexts}),比对还是用它导出的 {@link countSaid}(同一个洗法、同一个计数口径)。
 */
import { access, readdir, readFile } from 'node:fs/promises'
import { connect } from 'node:net'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { asRecord, readHeadTail, turnsOf } from '../../sessionDigest.ts'
import type { SessionFileRef } from '../../sessionHistory.ts'
import { countSaid, SAID_TAIL_BYTES } from '../../sessionSaid.ts'
import { TRANSCRIPT_REPLY_TAIL_BYTES, holdsMark, turnReplyOf } from '../../transcriptReply.ts'
import { RetryableError, type Adapter, type AdapterCapabilities, type AdapterReadResult, type Job, type JobKind, type JobResult } from '../adapter.ts'
import { READ_BUSY_WHY } from './window.ts'

/** 这一家在家族目录里的名字,也是会话记录文件那边的 `agent`。 */
export const CLAUDE_FAMILY = 'claude'

/**
 * 工作台自己的标识(线协议里的 `from`)。工作台不是一条 Claude 会话、没有自己的 socket,
 * 这个路径**不必真存在** —— 对方只把它当来路写进那条记录里给她看。
 */
export const CLAUDE_FROM = 'uds:/tmp/cc-socks/workbench.sock'

/**
 * 送进去的字前面加这一句,好让那边的 Claude 分得清「这是她本人经工作台送来的」,
 * 而不是另一个 AI 在插嘴。三种动作各一句,都写明「她本人经工作台」。
 */
export const CLAUDE_PREFIX = {
  answer: '[她本人经工作台回复]',
  relay: '[她本人经工作台捎话]',
  dispatch: '[她本人经工作台派活]',
} as const

export function claudePrefixOf(kind: JobKind): string {
  return kind === 'relay' ? CLAUDE_PREFIX.relay : kind === 'dispatch' ? CLAUDE_PREFIX.dispatch : CLAUDE_PREFIX.answer
}

/** 一行线协议(NDJSON,带结尾换行)。导出给用例与真机自测脚本比对,**只有这一行,没有 auth 行**。 */
export function claudeMessageLine(job: Job, from: string = CLAUDE_FROM): string {
  return `${JSON.stringify({
    type: 'user',
    message: { role: 'user', content: `${claudePrefixOf(job.kind)} ${job.text.trim()}` },
    from,
    msgV: 1,
  })}\n`
}

export const CLAUDE_NOT_OPEN_WHY = '那条 Claude 会话没开着,打开它再说一次'
export const CLAUDE_HELD_WHY = '送进去了,但没在记录里看到;可能她的 Claude 把工作台的消息扣在待批准里 —— 在 Claude 设置里把 crossSessionInbound 设成 accept'
export const CLAUDE_NO_TRANSCRIPT_WHY = '送进去了,但这条会话在本机没有记录文件,核不了是不是真收下了'
export const CLAUDE_NO_REPLY_WHY = '送到了(记录里看到了),但它到现在还没回话'
export const CLAUDE_NO_PRESS_WHY = 'Claude 桌面的跨会话消息只能送字:点它框上的那一项、往提问面板里写、按停止,都得去窗口里'
export const CLAUDE_NO_NEW_WHY = 'Claude 桌面没有「新开一条」的协议:指名一条开着的会话,或者去窗口里新开'
export const CLAUDE_EMPTY_WHY = '一个字都没有,没送'
/**
 * `submit:false`(「只填不发 / 先问我」)协议做不了(2026-10-03,统筹裁定;契约 `Job.submit` 那一段):
 * socket 上写一行就是送了。如实回 `unsupported`,引擎换窗口那条路 —— 字进框,她自己按。
 */
export const CLAUDE_NO_DRAFT_WHY = 'Claude 桌面的跨会话消息一写就是送了,做不了「只填不发」—— 字进框她自己按,要走窗口'
/** `read` 只认指名的那一条会话(记录文件按会话 id 找)。 */
export const CLAUDE_READ_NEEDS_SESSION_WHY = '不知道该看哪一条会话的记录 —— 读一眼也要先认准那一段'
/** 我们那一句还没落到记录里:读不到,**不是**「它还没回」。 */
export const CLAUDE_MARK_NOT_SEEN_WHY = '记录里还没看到我们送进去的那一句,先不认更早的回话'
/** 那一句在记录里、却没有时刻:分不清哪段回话是它之后说的。 */
export const CLAUDE_MARK_NO_TIME_WHY = '记录里看到了那一句,但那一行没有时刻,分不出哪段回话是它之后说的'

/** 送完到记录文件里核多久(与 `sessionAnswer` 的 confirmMs 同刻度)。 */
export const CLAUDE_CONFIRM_MS = 10_000
export const CLAUDE_CONFIRM_STEP_MS = 500
/** `expect:'reply'` 没给 `deadline` 时等多久。 */
export const CLAUDE_REPLY_MS = 120_000
/** 连 socket / 写一行的上限(本机 unix socket,慢成这样就是不对了)。 */
export const CLAUDE_SOCKET_MS = 4000

/** 一条登记在册、开着的 Claude 会话(`~/.claude/sessions/<pid>.json` 里我们用得上的那几格)。 */
export interface ClaudeSocketSession {
  sessionId: string
  pid: number
  /** 剥掉 `uds:` 之后的 socket 路径。 */
  socket: string
  /** 深链 `claude://code/continue?session=<这个>` 认的编号(给「叫她去看」用,这一层自己不开窗)。 */
  hostSessionId?: string
  name?: string
  status?: string
  peerProtocol?: number
  updatedAt?: number
}

/** 会话 id 只认这些字(与 `sessionHistory.safeSessionId` 同口径:拼路径也跑不出那家目录)。 */
const CLAUDE_ID_RE = /^[A-Za-z0-9_][A-Za-z0-9._:-]{0,199}$/

/** 连不上就是「它没开着」的那几种(残留的登记表 / 残留的 socket 文件 / 不是 socket)。 */
const DEAD_CODES = new Set(['ENOENT', 'ECONNREFUSED', 'ENOTSOCK', 'EACCES', 'EPERM'])

function codeOf(error: unknown): string | undefined {
  const code = (error as NodeJS.ErrnoException | undefined)?.code
  return typeof code === 'string' ? code : undefined
}

/**
 * 读 `~/.claude/sessions/*.json`,把带 `messagingSocketPath` 的那几条交出来。
 * **只读 `.json`**;同目录的 `.key`(auth token)一个字节都不碰。读不出 / 没有目录 → 空数组。
 */
export async function readClaudeSockets(claudeHome: string): Promise<readonly ClaudeSocketSession[]> {
  const dir = join(claudeHome, 'sessions')
  let names: string[]
  try {
    names = await readdir(dir)
  }
  catch {
    return []
  }
  const out = new Map<string, ClaudeSocketSession>()
  for (const name of names) {
    if (!name.endsWith('.json')) continue
    let raw: Record<string, unknown> | undefined
    try {
      raw = asRecord(JSON.parse(await readFile(join(dir, name), 'utf8')))
    }
    catch {
      continue // 单份坏了不拦别的
    }
    if (raw === undefined) continue
    const sessionId = raw.sessionId
    const pid = raw.pid
    const socketRaw = raw.messagingSocketPath
    if (typeof sessionId !== 'string' || !CLAUDE_ID_RE.test(sessionId)) continue
    if (typeof pid !== 'number' || typeof socketRaw !== 'string' || socketRaw === '') continue
    const socket = socketRaw.startsWith('uds:') ? socketRaw.slice('uds:'.length) : socketRaw
    if (socket === '') continue
    const entry: ClaudeSocketSession = {
      sessionId,
      pid,
      socket,
      ...(typeof raw.hostSessionId === 'string' && raw.hostSessionId !== '' ? { hostSessionId: raw.hostSessionId } : {}),
      ...(typeof raw.name === 'string' && raw.name.trim() !== '' ? { name: raw.name.trim() } : {}),
      ...(typeof raw.status === 'string' && raw.status !== '' ? { status: raw.status } : {}),
      ...(typeof raw.peerProtocol === 'number' ? { peerProtocol: raw.peerProtocol } : {}),
      ...(typeof raw.updatedAt === 'number' ? { updatedAt: raw.updatedAt } : {}),
    }
    // 同一条会话登记了两份(少见):写得晚的那份说了算。
    const prior = out.get(sessionId)
    if (prior === undefined || (entry.updatedAt ?? 0) >= (prior.updatedAt ?? 0)) out.set(sessionId, entry)
  }
  return [...out.values()]
}

/** 往 socket 写一行(连上 → 写 → 关)。失败按 `code` 原样抛,`run` 那边分「它没开着」与「可重试」。 */

/**
 * ★ **那条 Claude 会话现在开着没有**(2026-10-23,卡「捎话到没开着的会话留言等它醒」)。
 *
 * 巡登记表那一拍问它:排着等它醒的留言,哪条会话的 socket 在了就重送哪条。
 * 与适配器 `live()` 同一个口径(登记表 + socket 文件在);`readClaudeSockets` 不抛、`access` 不抛,
 * 所以这一份也不抛 —— 问不到就回 false(留在队里,下一拍再看)。
 */
export async function claudeSessionOpen(claudeHome: string, sessionId: string): Promise<boolean> {
  const rows = await readClaudeSockets(claudeHome).catch(() => [] as readonly ClaudeSocketSession[])
  const row = rows.find(one => one.sessionId === sessionId)
  if (row === undefined) return false
  try { await access(row.socket); return true }
  catch { return false }
}
async function writeSocketLine(path: string, line: string, timeoutMs = CLAUDE_SOCKET_MS): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const socket = connect(path)
    let settled = false
    const done = (error?: unknown): void => {
      if (settled) return
      settled = true
      socket.destroy()
      if (error === undefined) resolve()
      else reject(error instanceof Error ? error : new Error(String(error)))
    }
    socket.setTimeout(timeoutMs, () => { done(new Error('写 Claude 的 socket 超时')) })
    socket.on('error', done)
    socket.on('close', () => { done() })
    socket.on('connect', () => {
      socket.end(line, () => { /* 'close' 里收尾 */ })
    })
  })
}

/**
 * 记录文件尾巴里**所有「送进去的话」**的原文。三种落法都要(2026-10-02 真机查实):
 *
 * | 记录长什么样 | 什么时候 |
 * |---|---|
 * | `type:'user'`,`origin.kind:'human'` 或没这一格 | 她自己在那边打的字 |
 * | `type:'user'`,`isMeta:true`,`origin.kind:'peer'`,正文带「Another Claude session sent a message」 | 工作台 / 别的会话送进去、对方**空着**,直接收了 |
 * | `type:'queue-operation'`,`operation:'enqueue'`,`content` 是原句 | 工作台送进去、对方**正忙**,收下排进队列(等它这一轮说完才变成上面那条) |
 *
 * 最后那一种是真机那一跑(统筹会话 `status: busy`)拿到的原样一行 —— **排进队列就是送到了**,
 * 漏认它会让她看到「送进去了但没核上」而其实收得好好的。`operation` 不是 `enqueue`(撤掉了)的不算。
 *
 * 工具结果那一类 `user` 记录整条不算。只读、不洗字(洗法交给 `countSaid`)。
 */
export function claudeDeliveredLines(tail: string): { text: string, at?: string, queued?: true }[] {
  const out: { text: string, at?: string, queued?: true }[] = []
  for (const raw of tail.split('\n')) {
    const text = raw.trim()
    if (text === '' || !text.startsWith('{')) continue
    let row: Record<string, unknown> | undefined
    try {
      row = asRecord(JSON.parse(text))
    }
    catch {
      continue // 头尾各读一截,第一 / 最后一行常是半截
    }
    if (row === undefined) continue
    if (row.type === 'queue-operation') {
      if (row.operation === 'enqueue' && typeof row.content === 'string' && row.content.trim() !== '') out.push({ ...stamped(row.content, row.timestamp), queued: true })
      continue
    }
    if (row.type !== 'user') continue
    const content = asRecord(row.message)?.content
    if (typeof content === 'string') {
      if (content.trim() !== '') out.push(stamped(content, row.timestamp))
      continue
    }
    if (!Array.isArray(content)) continue
    const parts: string[] = []
    let skip = false
    for (const block of content) {
      const one = asRecord(block)
      if (one === undefined) continue
      if (one.type === 'tool_result') { skip = true; break }
      if (one.type === 'text' && typeof one.text === 'string' && one.text.trim() !== '') parts.push(one.text)
    }
    if (!skip && parts.length > 0) out.push(stamped(parts.join('\n'), row.timestamp))
  }
  return out
}

/** 一行「送进去的话」+ 它落盘的时刻(记录里的 `timestamp`;没有就不带,**不编一个**)。 */
function stamped(text: string, at: unknown): { text: string, at?: string } {
  return typeof at === 'string' && at !== '' ? { text, at } : { text }
}

/** 同上,只要原文(送完核「收下没有」那一路用它)。 */
export function claudeDeliveredTexts(tail: string): string[] {
  return claudeDeliveredLines(tail).map(one => one.text)
}

/** 记录文件此刻的样子:送进去的话(原文)+ 它说过几段话。读不了 → undefined(这条会话没有本机记录)。 */
interface Snapshot {
  said: readonly string[]
  replies: readonly { text: string, at?: string }[]
}

export interface ClaudeAdapterDeps {
  /** 默认 `~/.claude`。 */
  claudeHome?: string
  /** 按 id 找这条会话的记录文件;生产传 `sessionHistory.locate`,缺席时按 `~/.claude/projects/<目录>/<id>.jsonl` 找。 */
  locate?: (agent: string, sessionId: string) => Promise<SessionFileRef | undefined>
  /** 登记表(默认 {@link readClaudeSockets})。 */
  sockets?: (claudeHome: string) => Promise<readonly ClaudeSocketSession[]>
  /** socket 文件在不在(默认 `access`)。 */
  socketReady?: (path: string) => Promise<boolean>
  /** 往 socket 写一行(默认 {@link writeSocketLine})。 */
  writeLine?: (path: string, line: string) => Promise<void>
  /** 线协议里的 `from`,默认 {@link CLAUDE_FROM}。 */
  from?: string
  confirmMs?: number
  confirmStepMs?: number
  replyMs?: number
  now?: () => number
  sleep?: (ms: number) => Promise<void>
}

export function createClaudeAdapter(deps: ClaudeAdapterDeps = {}): Adapter {
  const claudeHome = deps.claudeHome ?? join(homedir(), '.claude')
  const sockets = deps.sockets ?? readClaudeSockets
  const from = deps.from ?? CLAUDE_FROM
  const now = deps.now ?? (() => Date.now())
  const sleep = deps.sleep ?? (ms => new Promise<void>(resolve => { setTimeout(resolve, ms).unref?.() }))
  const confirmMs = deps.confirmMs ?? CLAUDE_CONFIRM_MS
  const confirmStepMs = deps.confirmStepMs ?? CLAUDE_CONFIRM_STEP_MS
  const replyMs = deps.replyMs ?? CLAUDE_REPLY_MS
  const writeLine = deps.writeLine ?? ((path, line) => writeSocketLine(path, line))
  const socketReady = deps.socketReady ?? (async path => {
    try {
      await access(path)
      return true
    }
    catch {
      return false
    }
  })
  const locate = deps.locate ?? ((agent, sessionId) => defaultLocate(claudeHome, agent, sessionId))

  /** 登记在册 + socket 文件在的那几条。 */
  const live = async (): Promise<readonly ClaudeSocketSession[]> => {
    const rows = await sockets(claudeHome).catch(() => [] as readonly ClaudeSocketSession[])
    const out: ClaudeSocketSession[] = []
    for (const row of rows) if (await socketReady(row.socket)) out.push(row)
    return out
  }

  const snapshot = async (sessionId: string): Promise<Snapshot | undefined> => {
    const ref = await locate(CLAUDE_FAMILY, sessionId).catch(() => undefined)
    if (ref === undefined) return undefined
    const read = await readHeadTail(ref, { headBytes: 4096, maxHeadBytes: 4096, tailBytes: SAID_TAIL_BYTES })
    if (read === undefined) return undefined
    const turns = turnsOf(ref.format, {
      head: read.head,
      tail: read.tail,
      fallbackAt: read.fallbackAt,
      ...(ref.name === undefined ? {} : { name: ref.name }),
    })
    return {
      said: claudeDeliveredTexts(read.tail),
      replies: turns.turns.filter(one => one.k === 'reply').map(one => ({ text: one.text, ...(one.at === undefined ? {} : { at: one.at }) })),
    }
  }

  /** 新冒出来的那段回话:先看条数多没多(尾巴窗口没挪时最准),再看时刻(挪过了也认得出)。 */
  const freshReply = (after: Snapshot, before: Snapshot | undefined, sentAtMs: number): string | undefined => {
    const replies = after.replies
    const beforeCount = before?.replies.length ?? 0
    const pick = replies.length > beforeCount
      ? replies[replies.length - 1]
      : [...replies].reverse().find(one => {
          const ms = one.at === undefined ? Number.NaN : Date.parse(one.at)
          return Number.isFinite(ms) && ms > sentAtMs
        })
    const text = pick?.text.trim()
    return text === undefined || text === '' ? undefined : text
  }

  const capabilities = async (): Promise<AdapterCapabilities> => {
    const rows = await live()
    const deepLink = rows.some(row => row.hostSessionId !== undefined)
    return {
      // 「开到某一段」靠 `hostSessionId` 的深链(只用来给她看;送话这一层自己不开窗)。
      open: deepLink,
      send: rows.length > 0,
      read: rows.length > 0,
      press: false,
      // 协议只送字:点键 / 看按权限弹框 / 写进那个提问面板都让引擎换窗口那条路。
      approve: false,
      writeAsk: false,
      stop: false,
      openSession: deepLink,
    }
  }

  const run = async (job: Job): Promise<JobResult> => {
    const unsupported = (why: string): JobResult => ({ delivered: 'not_sent', via: 'protocol', evidence: 'none', unsupported: true, why })
    if (job.kind === 'press' || job.kind === 'write_ask' || job.kind === 'stop') return unsupported(CLAUDE_NO_PRESS_WHY)
    // 「只填不发」协议做不了:socket 上写一行就是送了(2026-10-03,审计第二节第 4 条)。
    if (job.submit === false) return unsupported(CLAUDE_NO_DRAFT_WHY)
    // 新开一条、以及「它此刻开着的那条」—— socket 协议两样都认不出(它只认一个会话 id)。
    if (job.target.kind !== 'session') return unsupported(CLAUDE_NO_NEW_WHY)

    const text = job.text.trim()
    const sessionId = job.target.sessionId
    if (text === '') return { delivered: 'not_sent', via: 'protocol', evidence: 'none', sessionId, why: CLAUDE_EMPTY_WHY }

    const entry = (await live()).find(row => row.sessionId === sessionId)
    // 找不到 = 这条会话没开着。**不去开窗找**:这一层只有协议,如实说让她打开;带上 `sessionClosed`
    // 那一格 —— 引擎据此留言等它醒(2026-10-23,卡「捎话留言等它醒」),而不是照「没送成」丢。
    if (entry === undefined) return { delivered: 'not_sent', via: 'protocol', evidence: 'none', sessionId, why: CLAUDE_NOT_OPEN_WHY, sessionClosed: true }

    const before = await snapshot(sessionId)
    const sentAtMs = now()
    try {
      await writeLine(entry.socket, claudeMessageLine({ ...job, text }, from))
    }
    catch (error) {
      const code = codeOf(error)
      if (code !== undefined && DEAD_CODES.has(code)) {
        return { delivered: 'not_sent', via: 'protocol', evidence: 'none', sessionId, why: CLAUDE_NOT_OPEN_WHY, sessionClosed: true }
      }
      // 连接刚起 / 刚被对方掐断这类:交给引擎按一处策略重试。
      throw new RetryableError(error instanceof Error ? error.message : String(error))
    }

    // 写成功只说明字节到了那个进程。送到没送到,看记录文件。
    const sent: JobResult = { delivered: 'unconfirmed', via: 'protocol', evidence: 'receipt', sessionId }
    if (before === undefined && (await snapshot(sessionId)) === undefined) return { ...sent, why: CLAUDE_NO_TRANSCRIPT_WHY }

    const want = countSaid(before?.said ?? [], text)
    const budget = job.expect === 'reply' ? replyOf(job, replyMs, now()) : confirmMs
    let seen = false
    let reply: string | undefined
    for (let waited = 0; ; waited += confirmStepMs) {
      const after = await snapshot(sessionId)
      if (after !== undefined) {
        if (!seen && countSaid(after.said, text) > want) seen = true
        if (seen && job.expect === 'reply') reply = freshReply(after, before, sentAtMs)
      }
      if (seen && (job.expect !== 'reply' || reply !== undefined)) break
      if (waited >= budget) break
      await sleep(confirmStepMs)
    }

    if (reply !== undefined) return { delivered: 'confirmed', via: 'protocol', evidence: 'transcript', sessionId, reply }
    if (seen) {
      return job.expect === 'reply'
        ? { delivered: 'confirmed', via: 'protocol', evidence: 'transcript', sessionId, why: CLAUDE_NO_REPLY_WHY }
        : { delivered: 'confirmed', via: 'protocol', evidence: 'transcript', sessionId }
    }
    return { ...sent, why: CLAUDE_HELD_WHY }
  }

  /**
   * ★ **只读一眼那条会话此刻的回话**(2026-10-03,审计第二节第 5 条)。
   *
   * 读的是**这条会话自己的记录文件**(与送完核「收下没有」同一份证据):先找我们那一句(记号)落在哪一刻,
   * 只认它之后的那一轮。**那一轮收尾了才给正文**(2026-10-12,卡「Claude与Kimi收回答读记录」):
   * 判法与「记录文件」那条通道同一处(`transcriptReply.turnReplyOf`)—— 收尾那一段(`end_turn`)才是回答,
   * 还在干活 = `busy`,不拿中途那句「我先看看」顶。
   *
   * 读不了这一段(没指名会话 / 没有记录文件 / 我们那一句还没落到记录里)回 `unsupported`:
   * 引擎接着问「记录文件」那条(按记号在这一家的会话里找)和窗口那条,**不说成「它还没回」**。
   */
  const read = async (job: Job): Promise<AdapterReadResult> => {
    const cannot = (why: string): AdapterReadResult => ({ via: 'protocol', evidence: 'none', unsupported: true, why })
    if (job.target.kind !== 'session') return cannot(CLAUDE_READ_NEEDS_SESSION_WHY)
    const ref = await locate(CLAUDE_FAMILY, job.target.sessionId).catch(() => undefined)
    if (ref === undefined) return cannot(CLAUDE_NO_TRANSCRIPT_WHY)
    const got = await readHeadTail(ref, { headBytes: 4096, maxHeadBytes: 4096, tailBytes: TRANSCRIPT_REPLY_TAIL_BYTES })
    if (got === undefined) return cannot(CLAUDE_NO_TRANSCRIPT_WHY)
    const mark = (job.marks?.[0] ?? job.text).trim()
    // 送进去的话有三种落法(她打的 / 工作台经 socket 送的 / 排进队列的),`claudeDeliveredLines` 都认。
    const delivered = claudeDeliveredLines(got.tail).filter(one => holdsMark(one.text, mark))
    const mine = delivered.at(-1)
    if (mine === undefined) return cannot(CLAUDE_MARK_NOT_SEEN_WHY)
    // 最新那一下只是排进了队列、还没轮到它(它正说着上一轮):之后冒出来的回话是上一轮的,不认 —— 算在跑。
    if (mine.queued === true) return { via: 'protocol', evidence: 'transcript', busy: true, why: READ_BUSY_WHY }
    const sentMs = mine.at === undefined ? Number.NaN : Date.parse(mine.at)
    if (!Number.isFinite(sentMs)) return cannot(CLAUDE_MARK_NO_TIME_WHY)
    const turns = turnsOf(ref.format, { head: got.head, tail: got.tail, fallbackAt: got.fallbackAt, ...(ref.name === undefined ? {} : { name: ref.name }) })
    // 我们那一句之后的:她亲口说的那一句本身落在同一刻(不算「下一句」),之后的才算。
    const after = turns.turns.filter(one => one.at !== undefined && Date.parse(one.at) > sentMs)
    // 经 socket 送进去的那一行不算「她说的」(不进回合),整份记录停在哪儿(`mark`)可能还是上一轮的「说完了」:
    // 它之后一句都还没有 = 它还没开口,算在跑。
    const verdict = after.length === 0 ? { status: 'running' as const } : turnReplyOf(after, turns.mark)
    if (verdict.status === 'running') return { via: 'protocol', evidence: 'transcript', busy: true, why: READ_BUSY_WHY }
    if (verdict.reply === undefined) return { via: 'protocol', evidence: 'transcript', why: CLAUDE_NO_REPLY_WHY }
    return { reply: verdict.reply, evidence: 'transcript', via: 'protocol' }
  }

  return { family: CLAUDE_FAMILY, via: 'protocol', capabilities, run, read }
}

/** `expect:'reply'` 等多久:她给了 `deadline` 就听她的,没给用缺省。 */
function replyOf(job: Job, fallbackMs: number, nowMs: number): number {
  if (job.deadline === undefined) return fallbackMs
  const at = Date.parse(job.deadline)
  return Number.isFinite(at) ? Math.max(0, at - nowMs) : fallbackMs
}

/**
 * 缺省的「按 id 找记录文件」:`~/.claude/projects/<目录>/<sessionId>.jsonl`。
 * 生产里传 `sessionHistory.locate`(它还认登记过的文件与别家);这一份是给真机自测脚本与单跑这一层用的。
 */
export async function defaultLocate(claudeHome: string, agent: string, sessionId: string): Promise<SessionFileRef | undefined> {
  if (agent !== CLAUDE_FAMILY || !CLAUDE_ID_RE.test(sessionId)) return undefined
  const root = join(claudeHome, 'projects')
  let dirs: string[]
  try {
    dirs = await readdir(root)
  }
  catch {
    return undefined
  }
  for (const dir of dirs) {
    const file = join(root, dir, `${sessionId}.jsonl`)
    try {
      await access(file)
      return { agent: CLAUDE_FAMILY, session_id: sessionId, file, format: 'claude-transcript' }
    }
    catch {
      // 换下一个项目目录
    }
  }
  return undefined
}
