/**
 * 传输记录(2026-09-21)。**每一次传输,发的那头和收的那头各留一条。**
 *
 * 为什么非留不可:文件从一台机器到另一台机器是一件「发生过就改不回来」的事。
 * 事务官替他传的那几次尤其 —— 他在电话里说一句、几秒钟后文件就在另一台机器上了,
 * 没有记录的话第二天他根本无从知道「那份东西到底去了哪儿」。
 *
 * **记录里不写内容**:只有文件名、大小、两头的设备名、时间、成没成。
 * 一行一条 JSON(jsonl),追加写;读的时候只读最后 N 行 —— 它是流水,不是表。
 */
import { appendFile, mkdir, readFile } from 'node:fs/promises'
import { dirname } from 'node:path'

/** 记录面板里最多回几条。再多他也不会往下翻。 */
export const TRANSFER_LIMIT = 50

export type TransferDirection = 'out' | 'in'

export interface TransferRecord {
  at: string
  direction: TransferDirection
  /** 对方是谁(设备名)。 */
  peer: string
  name: string
  bytes: number
  ok: boolean
  /** 没成时那句人话。成了就缺席。 */
  error?: string
  /**
   * 这一次是谁发起的:他自己拖进发件目录(`outbox`)、手机上点的(`manual`)、事务官替他办的(`butler`)、
   * 手机上打字要的(`typed`,2026-09-25)、统一输入框的附件(`attachment`,2026-09-25 —— 电脑首页不单独提它)。
   */
  by?: 'outbox' | 'manual' | 'butler' | 'typed' | 'attachment'
  /**
   * ★ **这一次推的是哪张取件单**(2026-10-04,卡 `claude/phone-file-send-loop`)。
   *
   * 「她要一份文件」那一类事项的"办完"以**传输回执**为准(8791 的
   * `workbench-plugin/src/server/fileDelivery.ts`),而**出门那条路**的完成事实只有工人知道:
   * 字节是这里用 `wb.file` 推过去的。所以这条流水报给 8791 时带上单号,
   * 8791 就能按单号认出这是哪一件事的回执。
   *
   * 只有「手机在外面取文件」那一条路有它(`file_pull`);他自己拖进发件目录、
   * 电话里 `wb_send_file` 那两条没有单号,**整格缺席**(不编一个)。
   * 字段名与 8791 的 `TransferEntry.offer` 逐字相同。
   */
  offer?: string
}

/** 一条记录 → 一句给人看的话。 */
export function transferLine(record: TransferRecord): string {
  const when = record.at.slice(5, 16).replace('T', ' ')
  const arrow = record.direction === 'out' ? '发给' : '收自'
  const size = humanSize(record.bytes)
  if (!record.ok) return `${when} ${arrow} ${record.peer}:「${record.name}」没成 —— ${record.error ?? '没说原因'}`
  return `${when} ${arrow} ${record.peer}:「${record.name}」${size}`
}

export function humanSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '大小不详'
  if (bytes < 1024) return `${bytes} 字节`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

/** 一行 jsonl → 一条记录。解不出来就 undefined(坏行跳过,不让一行把整份记录带走)。 */
export function parseTransferLine(line: string): TransferRecord | undefined {
  let raw: unknown
  try { raw = JSON.parse(line) }
  catch { return undefined }
  if (raw === null || typeof raw !== 'object') return undefined
  const record = raw as Record<string, unknown>
  if (typeof record.at !== 'string' || typeof record.name !== 'string') return undefined
  if (record.direction !== 'out' && record.direction !== 'in') return undefined
  return {
    at: record.at,
    direction: record.direction,
    peer: typeof record.peer === 'string' ? record.peer : '不知道是谁',
    name: record.name,
    bytes: typeof record.bytes === 'number' ? record.bytes : 0,
    ok: record.ok !== false,
    ...(typeof record.error === 'string' ? { error: record.error } : {}),
    ...(record.by === 'outbox' || record.by === 'manual' || record.by === 'butler' || record.by === 'typed' || record.by === 'attachment' ? { by: record.by } : {}),
  }
}

export interface TransferLogDeps {
  file: string
  appendImpl?: (file: string, line: string) => Promise<void>
  readImpl?: (file: string) => Promise<string>
  now?: () => Date
}

export interface TransferLog {
  append: (record: Omit<TransferRecord, 'at'> & { at?: string }) => Promise<TransferRecord>
  recent: (limit?: number) => Promise<readonly TransferRecord[]>
  file: string
}

/** 追加写的流水账。**写不进去不抛** —— 记不上这一条,不该让文件传不过去。 */
export function createTransferLog(deps: TransferLogDeps): TransferLog {
  const now = deps.now ?? (() => new Date())
  const appendImpl = deps.appendImpl ?? (async (file: string, line: string) => {
    await mkdir(dirname(file), { recursive: true })
    await appendFile(file, line, 'utf8')
  })
  const readImpl = deps.readImpl ?? ((file: string) => readFile(file, 'utf8'))
  return {
    file: deps.file,
    async append(input) {
      const record: TransferRecord = { ...input, at: input.at ?? now().toISOString() }
      try { await appendImpl(deps.file, `${JSON.stringify(record)}\n`) }
      catch { /* 记不上这一条不该把传输带走 */ }
      return record
    },
    async recent(limit = TRANSFER_LIMIT) {
      let text: string
      try { text = await readImpl(deps.file) }
      catch { return [] }
      const out: TransferRecord[] = []
      for (const line of text.split('\n')) {
        if (line.trim() === '') continue
        const record = parseTransferLine(line)
        if (record !== undefined) out.push(record)
      }
      return out.slice(-limit).reverse()
    },
  }
}
