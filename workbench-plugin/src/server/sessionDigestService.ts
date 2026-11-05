/**
 * 点开一条「某家在跑的会话」看什么(2026-09-25,卡 P)。
 *
 * 维护者:「事务官中并没有显示会话的标题和内容」。卡片上写了标题与「最近在做什么」之后,他点开要看的是
 * **这条会话是什么、最近几轮在做什么、在哪个项目** —— 在工作台里看,不跳 DSH 底层页、也不跳那家客户端。
 *
 * 两件事:
 * 1. **登记**:三家的会话接入(claudeSessionRecover / codexSessionFeed / kimiSessionFeed)每读到一条会话的文件
 *    就登记一下「哪条会话在哪个文件、那家自己叫它什么」。只在内存,重启后各家 feed 下一轮自然再登记;
 * 2. **当场读**:点开时按登记找文件,头尾各读一段读成人话(sessionDigest.ts),和 /state 里那条会话的
 *    项目、状态拼成一页。**不落盘、不经模型**;读不到就说读不到(路由回 404 + 一句人话),不拿旧的凑。
 *
 * 为什么不把「最近几轮」放进 /state:/state 每秒一拍、还推给展示台;几轮对话是点开才看的东西,
 * 放进快照就是每秒把他的会话内容多搬一遍(hooks.ts 那条「展示台不该拿到会话内容」的纪律)。
 */
import type { SessionDigestView, SessionView } from '../protocol.ts'
import { readSessionDigest, type DigestFormat, type ReadDigestOptions, type SessionDigest } from './sessionDigest.ts'
import { UNKNOWN_PROJECT } from './sessions.ts'

export interface SessionDigestService {
  /**
   * 各家读会话文件时登记一下:哪一家(按字符串,不收窄成固定几家)、哪条会话、在哪个文件、什么格式、那家自己叫它什么。
   * 卡 Q 自动发现的 Agent 只要登记进来(记录是认得的格式)就能点开看。
   */
  note: (agent: string, sessionId: string, file: string, format: DigestFormat, name?: string) => void
  /** 点开一条会话:当场读。没登记过这条会话 / 读不到它的记录 → undefined。 */
  view: (agent: string, sessionId: string) => Promise<SessionDigestView | undefined>
  /** 登记表里此刻的每一条(卡 T「在等你」按它读各家会话;最近登记的在后)。 */
  files: () => { agent: string, session_id: string, file: string, format: DigestFormat, name?: string }[]
  /**
   * 登记变化的订阅(8791 第六轮第 4 轮):note() 进新条目时通知 —— 对账的来源定位认这份登记,
   * 登记变了要重读。可选;听的一方抛了不连累登记。
   */
  onChanged?: (fn: () => void) => () => void
  /**
   * 那一条会话登记过的记录文件在哪(2026-09-25,卡 Q:Claude 的子代理就在它旁边那个目录里,见 sessionChildren.ts)。
   * 没登记过 → undefined。
   */
  fileOf?: (agent: string, sessionId: string) => string | undefined
}

export interface SessionDigestServiceOptions {
  /** 此刻的会话表(/state.sessions 同一份):项目、状态、标题以它为准,卡片上看到的和点开看到的是同一句。 */
  sessions: () => readonly SessionView[]
  now?: () => Date
  read?: (ref: { format: DigestFormat, file: string, name?: string }, options: ReadDigestOptions) => Promise<SessionDigest | undefined>
  /** 登记表最多记多少条(最近登记的留着),默认 500。 */
  cap?: number
  /**
   * ★ **登记表里没有时按 id 去各家目录里找**(2026-10-13 夜,卡 W;维护者手机上:「一开始还有输入框,现在输入框都没有了,
   * 说这个会话没有开着」)。登记表只在内存、启动不回放历史、Codex 那一路只登记两小时内有动静的 ——
   * 工作台一重启(今晚两次发版),他正要接着说的那条(最后一次动在 2.5 小时前)就不在表里,点开 404「读不到这条会话的记录」,
   * 手机据此收掉输入框。记录文件本身读得好好的。传 `sessionHistory.locate`:找到了就顺手登记,之后与登记过的一样。
   */
  locate?: (agent: string, sessionId: string) => Promise<{ file: string, format: DigestFormat, name?: string } | undefined>
}

/** 点开时尾巴读大一点(1MB):最近几轮要装得下,又不至于把几十 MB 的会话整份读进来。 */
const VIEW_TAIL_BYTES = 1024 * 1024

export function createSessionDigestService(options: SessionDigestServiceOptions): SessionDigestService {
  const now = options.now ?? (() => new Date())
  const read = options.read ?? readSessionDigest
  const cap = options.cap ?? 500
  const files = new Map<string, { file: string, format: DigestFormat, name?: string }>()
  const keyOf = (agent: string, sessionId: string): string => `${agent}:${sessionId}`
  const listeners = new Set<() => void>()
  const tell = (): void => { for (const fn of [...listeners]) { try { fn() } catch { /* 订阅方自己负责 */ } } }

  return {
    onChanged(fn) {
      listeners.add(fn)
      return () => { listeners.delete(fn) }
    },
    note(agent, sessionId, file, format, name) {
      if (agent === '' || sessionId === '' || file === '') return
      const key = keyOf(agent, sessionId)
      const prior = files.get(key)
      const changed = prior === undefined || prior.file !== file || prior.format !== format || prior.name !== name
      files.delete(key) // 重新登记挪到最新(原有 recency 语义不動)
      files.set(key, name === undefined ? { file, format } : { file, format, name })
      if (files.size > cap) {
        const oldest = files.keys().next().value
        if (oldest !== undefined) files.delete(oldest)
      }
      if (changed) tell()
    },

    files() {
      return [...files.entries()].map(([key, ref]) => {
        const cut = key.indexOf(':')
        return { agent: key.slice(0, cut), session_id: key.slice(cut + 1), ...ref }
      })
    },

    fileOf(agent, sessionId) {
      return files.get(keyOf(agent, sessionId))?.file
    },

    async view(agent, sessionId) {
      let ref = files.get(keyOf(agent, sessionId))
      if (ref === undefined && options.locate !== undefined) {
        // 登记表里没有(多半是重启后那家还没再写过这条):按 id 找一次,找到就登记(卡 W)。
        const found = await options.locate(agent, sessionId).catch(() => undefined)
        if (found !== undefined) {
          this.note(agent, sessionId, found.file, found.format, found.name)
          ref = files.get(keyOf(agent, sessionId))
        }
      }
      if (ref === undefined) return undefined
      const digest = await read(
        { format: ref.format, file: ref.file, ...(ref.name === undefined ? {} : { name: ref.name }) },
        { tailBytes: VIEW_TAIL_BYTES },
      )
      if (digest === undefined) return undefined
      const session = options.sessions().find(one => one.agent === agent && one.session_id === sessionId)
      // 标题以会话表为准(卡片上就是那一句);会话表里没有才用这次读到的。
      const title = session?.title ?? digest.title
      // 在做什么以这次当场读的为准(比 /state 那一格新);这次没读出来才用会话表里的。
      const activity = digest.activity ?? session?.activity
      return {
        agent,
        session_id: sessionId,
        ...(title === undefined ? {} : { title }),
        project: session?.project ?? UNKNOWN_PROJECT,
        ...(session === undefined ? {} : { status: session.status, elapsed_sec: session.elapsed_sec }),
        ...(activity === undefined ? {} : { activity }),
        rounds: digest.rounds,
        ...(digest.ended === undefined ? {} : { ended: digest.ended }),
        read_at: now().toISOString(),
      }
    },
  }
}
