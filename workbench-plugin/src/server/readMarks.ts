/**
 * 已读标记落盘(2026-09-02 Ben 点名的待办)。
 *
 * 会话表本身**只活在 DSH 进程内存里**,这是对的:会话随 agent 生灭,重启后由各家的
 * feed/hook 重新报一遍即可。但"我已经看过它了"不一样——那是**用户的判断**,
 * 不该随进程一起蒸发。当天真机现场:重启了七八次,每次那几条他早就看过的完成会话
 * 又统统变回未读蓝点(applyEvent 里 `done` 一律置 unread=true),格外刺眼。
 *
 * 所以这里只存一件极小的事:哪些 (agent, session_id) 被标过已读、以及标的时刻。
 * - **不存会话内容**:标题/状态/时长全都不落盘,那些的真相在各家的日志里;
 * - **自动过期**(默认 14 天):会话 id 是一次性的,过期条目留着只会让文件无限长;
 * - **写失败不影响使用**:退化成"这次重启后又变未读",跟修之前一样,不更糟(D13)。
 *
 * 落盘 ~/.dsh/workbench/read-marks.json,原子写 + 容错读(与 dock.json/notes.json 同规格)。
 */
import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { AgentId } from '../protocol.ts'

/** 默认保留期:14 天。比会话的实际寿命宽裕得多,又不至于让文件长到没边。 */
const DEFAULT_KEEP_MS = 14 * 24 * 60 * 60 * 1000

export interface ReadMarks {
  /** 从磁盘装载(过期条目在此丢弃)。失败静默,当空表。 */
  load(): Promise<void>
  has(agent: AgentId, sessionId: string): boolean
  /** 记一条已读。内存立即生效,落盘异步进行(不挡调用方)。 */
  add(agent: AgentId, sessionId: string): void
  /** 把挂起的写落定——测试用;生产靠 add 内部的异步写。 */
  flush(): Promise<void>
}

export interface ReadMarksOptions {
  file: string
  /** 当前 Unix 秒。默认 Date.now/1000。 */
  now?: () => number
  keepMs?: number
}

export function defaultReadMarksFile(home = process.env.HOME ?? ''): string {
  return `${home}/.dsh/workbench/read-marks.json`
}

interface ReadMarksFile { version: 1, marks: Record<string, number> }

/** 键里带 agent:同一个 session_id 分属两家时互不影响。 */
function markKey(agent: AgentId, sessionId: string): string {
  return `${agent}:${sessionId}`
}

export function createReadMarks(options: ReadMarksOptions): ReadMarks {
  const now = options.now ?? (() => Math.floor(Date.now() / 1000))
  const keepMs = options.keepMs ?? DEFAULT_KEEP_MS
  /** key → 标记时刻(Unix 秒)。 */
  const marks = new Map<string, number>()
  // 写队列:add 可能连着来(点一次标签会把那一批逐条标已读),排队避免互相覆盖。
  let writeQueue: Promise<void> = Promise.resolve()

  function prune(nowSec: number): void {
    for (const [key, at] of [...marks]) {
      if ((nowSec - at) * 1000 > keepMs) marks.delete(key)
    }
  }

  async function save(): Promise<void> {
    const data: ReadMarksFile = { version: 1, marks: Object.fromEntries(marks) }
    await mkdir(dirname(options.file), { recursive: true })
    const tmp = `${options.file}.${randomUUID()}.tmp`
    await writeFile(tmp, `${JSON.stringify(data, null, 2)}\n`, 'utf8')
    await rename(tmp, options.file)
  }

  function enqueueSave(): void {
    // 失败静默:退化成"这次重启后又变未读",跟修之前一样,不更糟。
    writeQueue = writeQueue.then(() => save()).catch(() => {})
  }

  return {
    async load() {
      try {
        const parsed = JSON.parse(await readFile(options.file, 'utf8')) as ReadMarksFile
        if (parsed?.version !== 1 || typeof parsed.marks !== 'object' || parsed.marks === null) return
        for (const [key, at] of Object.entries(parsed.marks)) {
          if (typeof at === 'number' && Number.isFinite(at)) marks.set(key, at)
        }
        prune(now())
      }
      catch {
        // 不存在/写坏了都按空表兜底,先例见 notes.ts loadNotesFile。
      }
    },
    has(agent, sessionId) {
      return marks.has(markKey(agent, sessionId))
    },
    add(agent, sessionId) {
      const nowSec = now()
      marks.set(markKey(agent, sessionId), nowSec)
      prune(nowSec)
      enqueueSave()
    },
    async flush() {
      await writeQueue
    },
  }
}
