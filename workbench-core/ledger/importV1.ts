/**
 * 从今天的 v1 文件导入账:只做形状映射,只读原文件、一个字节不改。
 *
 * - tasks.json:每张卡 → 一个对象(legacy_id = 卡 id,data = 卡原样去掉 id);
 *   dispatch / client_dispatch 各投影成一条委派(只放路由与时刻,原话、回话不进委派)。
 * - jobs.jsonl:每行 → 一条 `job.<step>` 事件;对得上卡的落在对象上,对不上的(捎话轻账那类)进 job 话题。
 * - 都是幂等的:卡按 legacy_id / request_id 跳过,行按「整行内容的哈希」当 request_id 去重。先导 tasks 再导 jobs。
 *
 * 双写镜像(插件每次写 v1 文件时同步进账)由卡 A 在转发层接,用的是 objects.create(legacy_id) 等同一套接口。
 */
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import type { Ledger } from './ledger.ts'
import { KINDS } from './reduce.ts'
import type { Actor, Tx } from './types.ts'

const EVIDENCE = 'v1-import'

/** v1 tasks.json 里导入要用到的那几样(其余字段原样进 data)。 */
export interface V1Task {
  id: string
  status?: string
  created_at?: string
  dispatch?: V1Dispatch
  client_dispatch?: V1ClientDispatch
  [k: string]: unknown
}

interface V1Dispatch {
  family: string
  status: string
  hand?: string
  started_at?: string
  session_id?: string
  [k: string]: unknown
}

interface V1ClientDispatch {
  hand?: string
  family: string
  status: string
  at?: string
  session_id?: string
  turn_id?: string
  [k: string]: unknown
}

export interface V1TasksFile {
  tasks: V1Task[]
  [k: string]: unknown
}

export interface ImportTasksResult {
  objects_created: number
  deliveries_created: number
  skipped: number
}

export function importFromTasksJson(ledger: Ledger, input: string | V1TasksFile, opts: { owner: string; actor: Actor }): ImportTasksResult {
  const file = (typeof input === 'string' ? JSON.parse(readFileSync(input, 'utf8')) : input) as Partial<V1TasksFile> | null
  if (!file || !Array.isArray(file.tasks)) throw new Error('importFromTasksJson: 文件里没有 tasks 数组,不当空看板导入')
  const out: ImportTasksResult = { objects_created: 0, deliveries_created: 0, skipped: 0 }
  file.tasks.forEach((task, i) => {
    if (!task || typeof task.id !== 'string' || task.id === '') throw new Error(`importFromTasksJson: 第 ${i} 张卡没有 id`)
    if (ledger.objects.byLegacyId(task.id)) {
      out.skipped += 1
      return
    }
    const r = ledger.request({ request_id: `import:tasks:${task.id}`, op: 'import.tasks' }, (tx) => importTask(tx, task, opts))
    if (!r.ok) throw new Error(`importFromTasksJson: 卡 ${task.id} 导入被拒:${r.error.code}`)
    if (r.replayed) {
      out.skipped += 1
      return
    }
    out.objects_created += 1
    out.deliveries_created += r.result.deliveries
  })
  return out
}

function importTask(tx: Tx, task: V1Task, opts: { owner: string; actor: Actor }): { object_id: string; deliveries: number } {
  const { id, ...data } = task
  const object_id = tx.newObjectId()
  const createdTs = parseTs(task.created_at) ?? tx.now
  tx.emit({
    kind: KINDS.objectCreated,
    object_id,
    actor: opts.actor,
    evidence: EVIDENCE,
    ts: createdTs,
    payload: { owner: opts.owner, status: typeof task.status === 'string' ? task.status : null, data, legacy_id: id },
  })
  let n = 0
  const d = task.dispatch
  if (d && typeof d.family === 'string') {
    n += 1
    tx.emit({
      kind: KINDS.deliveryCreated,
      object_id,
      actor: opts.actor,
      evidence: EVIDENCE,
      ts: parseTs(d.started_at) ?? createdTs,
      payload: {
        delivery_id: `${object_id}.d${n}`,
        n,
        family: d.family,
        channel: d.hand ?? 'cli',
        target: { family: d.family, ...pick(d, ['session_id']) },
        status: d.status,
        data: pick(d, ['started_at', 'ended_at', 'cwd', 'pid', 'kind', 'branch', 'stopped', 'output_file']),
      },
    })
  }
  const c = task.client_dispatch
  if (c && typeof c.family === 'string') {
    n += 1
    tx.emit({
      kind: KINDS.deliveryCreated,
      object_id,
      actor: opts.actor,
      evidence: EVIDENCE,
      ts: parseTs(c.at) ?? createdTs,
      payload: {
        delivery_id: `${object_id}.d${n}`,
        n,
        family: c.family,
        channel: c.hand ?? 'window',
        target: { family: c.family, ...pick(c, ['session_id', 'turn_id']) },
        status: c.status,
        data: pick(c, ['at', 'method', 'submitted', 'matched_at', 'reply_state', 'reply_at', 'rework', 'new_conversation']),
      },
    })
  }
  return { object_id, deliveries: n }
}

export interface ImportJobsResult {
  appended: number
  orphans: number
  unreadable: number
  skipped: number
}

export function importFromJobsJsonl(ledger: Ledger, path: string, opts: { actor: Actor }): ImportJobsResult {
  const out: ImportJobsResult = { appended: 0, orphans: 0, unreadable: 0, skipped: 0 }
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    if (line.trim() === '') continue
    let parsed: unknown
    try {
      parsed = JSON.parse(line)
    } catch {
      out.unreadable += 1
      continue
    }
    // 合法 JSON 不一定是一条记录(null、数字、数组):先判形状再读字段,一行坏的不中断整次导入。
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      out.unreadable += 1
      continue
    }
    const e = parsed as Record<string, unknown>
    const ts = parseTs(e.at)
    if (typeof e.job !== 'string' || typeof e.step !== 'string' || ts === undefined) {
      out.unreadable += 1
      continue
    }
    const { at: _at, step, ...payload } = e
    const object = ledger.objects.byLegacyId(e.job)
    const actor: Actor = typeof e.family === 'string' ? { ...opts.actor, family: e.family } : { ...opts.actor }
    const request_id = `import:jobs:${createHash('sha256').update(line).digest('hex')}`
    const r = ledger.request({ request_id, op: 'import.jobs' }, (tx) => {
      tx.emit({
        kind: `job.${step as string}`,
        object_id: object?.object_id ?? null,
        topic: object ? 'object' : 'job',
        actor,
        evidence: EVIDENCE,
        ts,
        payload,
      })
      return { object_id: object?.object_id ?? null }
    })
    if (!r.ok) throw new Error(`importFromJobsJsonl: 一行导入被拒:${r.error.code}`)
    if (r.replayed) out.skipped += 1
    else if (r.result.object_id) out.appended += 1
    else out.orphans += 1
  }
  return out
}

function parseTs(v: unknown): number | undefined {
  if (typeof v !== 'string') return undefined
  const t = Date.parse(v)
  return Number.isNaN(t) ? undefined : t
}

function pick(src: Record<string, unknown>, keys: readonly string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const k of keys) if (src[k] !== undefined) out[k] = src[k]
  return out
}
