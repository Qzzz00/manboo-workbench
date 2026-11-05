/**
 * **读它自己的记录**:窗口型那几家里,本机有对话库的,在跑 / 做完 / 标题 / 最新一句以它的库为准(2026-10-08,根治方案)。
 *
 * 来源分级(`docs/设计-各家在不在跑以它自己的记录为准-2026-10-08.md`):①它自己的本机记录 ②它的接口 ③看屏幕。
 * Claude / Codex / Kimi 的记录走各自的会话流(`/state.sessions`,`AgentId` 那四家);这张表给**其余几家**用:
 * 登记表里那一家的会话直接从它的库里长出来(`via: 'records'`),气泡、事务官卡片、手机都走这一份;
 * 读窗口那一路退成只补标题,库读不了(没装、表的样子变了)时整家退回读窗口。
 *
 * 新接一家:写一个读它库的函数(纪律同 `qwenWorkRecords.ts`:只读、不添文件、对不上就回 undefined),在下面加一行。
 * 它的库里还能按「送进去那句」找到那一轮的,再给一个 `reply`:派活 / 捎话收回答也先从库里取
 * (引擎里那条只读的「记录文件」通道,`engine/adapters/records.ts`),读窗口退成兜底(2026-10-09)。
 * 有会话记录文件、本来就走会话流的那几家(Claude / Kimi)只给 `reply`、不给 `read`:会话照旧从会话流长出来,
 * 收回答按记号在它们的记录里找那一轮(`transcriptReply.ts`,2026-10-12)。
 * 判断逻辑里不写包名。
 */
import { existsSync } from 'node:fs'
import { bindingFor, bundleIdsOf } from './agentSources.ts'
import { QWENWORK_BUNDLE_ID, defaultQwenWorkDb, readQwenWorkRecords, readQwenWorkReply } from './qwenWorkRecords.ts'
import { readTranscriptReply, type TranscriptAccess } from './transcriptReply.ts'

/** 它库里的一条对话(= 侧栏 / 坞上的一条)。 */
export interface AgentRecordChat {
  /** 它库里的对话号(只在这一层用;会话号按标题算,与读窗口那一路对得上)。 */
  id: string
  title?: string
  status: 'running' | 'done'
  /** 它最新那句回答的最后一行(截短)。 */
  latest?: string
  /** 最后一次动的时刻。 */
  updated_at: string
  /** 这一轮她说话的时刻(「跑了多久」)。 */
  started_at?: string
  /** 这一轮收尾的时刻(在跑时缺席)。 */
  finished_at?: string
}

/** 读一次的结果:新的在前。 */
export interface AgentRecordRead {
  chats: readonly AgentRecordChat[]
}

/**
 * 按「送进去那句」找到的那一轮(派活 / 捎话收回答用)。
 * `found:false` = 它库里还没有这一句(还没落盘 / 字还在框里);在跑时不给半截。
 */
export type AgentRecordReply =
  | { found: false }
  | { found: true, status: 'running' }
  | {
    found: true
    status: 'done'
    /** 那一轮回答的正文(只取文字块);没写出字时缺席。 */
    reply?: string
    /** 她停掉的 / 中断的(不是正常收尾)。 */
    stopped?: true
  }

/** 读记录那几样共用的入参。 */
export interface AgentRecordInput {
  home: string
  /** 会话流那一份(有会话记录文件的那几家按它找文件);缺席 = 没接。 */
  transcripts?: TranscriptAccess
}

export interface AgentRecordSource {
  bundle_ids: readonly string[]
  /** 登记表来源那一格的人话。 */
  label: string
  /** 整家的会话从它的库里长出来(登记表那一路)。缺席 = 会话不归这张表管(走会话流的那几家)。 */
  read?: (input: { home: string, nowMs: number }) => AgentRecordRead | undefined
  /** 它的记录在不在这台电脑上(「记录文件」那条通道报不报「读得到」)。缺席 = 在。 */
  present?: (input: AgentRecordInput) => boolean
  /**
   * 按记号找那一轮;读不了 → undefined。缺席 = 这一家收回答不走记录。
   * `sessionId`:调用方已认准那一条会话(只读那一条)。
   */
  reply?: (input: AgentRecordInput & { marker: string, nowMs: number, sessionId?: string }) =>
    AgentRecordReply | undefined | Promise<AgentRecordReply | undefined>
}

export const RECORD_SOURCE_LABEL = '它自己的记录'
/** 第三级:看它的屏幕(读辅助功能树)。登记表来源那一格的名字。 */
export const SCREEN_SOURCE_LABEL = '看它的屏幕'
/** 新接上一家、它有记录这一路时日志那一句。 */
export const RECORD_LEVEL_LINE = '先读它自己的记录,窗口只作兜底'
/** 本机没有它能读的记录(这张表里没有它):如实写它只能看屏幕。 */
export const SCREEN_ONLY_NOTE = '它在本机没有能读的对话记录,只能看屏幕'

/** 有会话记录文件的一家(会话流在读它的记录):只给收回答这一路。`agent` 是会话流里那一家的 id。 */
function transcriptSource(agent: string): AgentRecordSource {
  return {
    bundle_ids: bundleIdsOf(bindingFor(agent)),
    label: RECORD_SOURCE_LABEL,
    present: ({ transcripts }) => transcripts !== undefined,
    reply: ({ transcripts, marker, sessionId }) => transcripts === undefined
      ? undefined
      : readTranscriptReply({ agent, marker, access: transcripts, ...(sessionId === undefined ? {} : { sessionId }) }),
  }
}

export const RECORD_SOURCES: readonly AgentRecordSource[] = [
  {
    bundle_ids: [QWENWORK_BUNDLE_ID],
    label: RECORD_SOURCE_LABEL,
    read: ({ home, nowMs }) => readQwenWorkRecords({ dbPath: defaultQwenWorkDb(home), nowMs }),
    present: ({ home }) => existsSync(defaultQwenWorkDb(home)),
    reply: ({ home, marker, nowMs }) => readQwenWorkReply({ dbPath: defaultQwenWorkDb(home), marker, nowMs }),
  },
  transcriptSource('claude'),
  transcriptSource('kimi'),
]

/** 发现那一边用的读法:按包问。 */
export interface AgentRecordReaders {
  /** 这个包的会话是不是从它的记录里长出来(登记表那一路)。 */
  has: (bundleId: string) => boolean
  /** 这个包收回答有没有「它自己的记录」这一路(不看此刻读不读得到;接线那一处据此登记通道)。 */
  hasReply: (bundleId: string) => boolean
  /** 读一次;读不了 → undefined(整家退回读窗口)。绝不抛。 */
  read: (bundleId: string) => AgentRecordRead | undefined
  /** 这个包收回答能不能走它的记录(有 `reply` 这一路、库在这台电脑上)。 */
  canReply: (bundleId: string) => boolean
  /** 按记号找那一轮;读不了 / 没这一路 → undefined(退回读窗口)。绝不抛。`sessionId`:已认准的那一条会话。 */
  reply: (bundleId: string, marker: string, hint?: { sessionId?: string }) => Promise<AgentRecordReply | undefined>
}

export function createRecordReaders(input: {
  home: string
  now?: () => number
  sources?: readonly AgentRecordSource[]
  /** 会话流那一份(生产:`/state.sessions` + `sessionHistory.locate`)。缺席 = 有记录文件的那几家读不到。 */
  transcripts?: TranscriptAccess
}): AgentRecordReaders {
  const sources = input.sources ?? RECORD_SOURCES
  const now = input.now ?? (() => Date.now())
  const sourceOf = (bundleId: string): AgentRecordSource | undefined => sources.find(one => one.bundle_ids.includes(bundleId))
  const base: AgentRecordInput = { home: input.home, ...(input.transcripts === undefined ? {} : { transcripts: input.transcripts }) }
  return {
    has: bundleId => sourceOf(bundleId)?.read !== undefined,
    hasReply: bundleId => sourceOf(bundleId)?.reply !== undefined,
    read(bundleId) {
      const read = sourceOf(bundleId)?.read
      if (read === undefined) return undefined
      try { return read({ home: input.home, nowMs: now() }) }
      catch { return undefined }
    },
    canReply(bundleId) {
      const source = sourceOf(bundleId)
      if (source?.reply === undefined) return false
      try { return source.present?.(base) ?? true }
      catch { return false }
    },
    async reply(bundleId, marker, hint) {
      const source = sourceOf(bundleId)
      if (source?.reply === undefined) return undefined
      const sessionId = hint?.sessionId
      try { return await source.reply({ ...base, marker, nowMs: now(), ...(sessionId === undefined ? {} : { sessionId }) }) }
      catch { return undefined }
    },
  }
}

/** 这一家这一份记录此刻在不在跑(有一条在跑就算)。 */
export function recordsBusy(read: AgentRecordRead): boolean {
  return read.chats.some(one => one.status === 'running')
}
