/**
 * `GET /collab/trace` 回包按行验(2026-10-28):整包不是轨迹 → 取不到;单行形状不对 → 那一行记 'bad',
 * 其余照画。一行坏数据不能把整块拖在「读中」或抛错清屏。
 */
import type { TaskTrace } from '../../protocol.ts'
import { TRACE_CURRENT_TITLES, TRACE_NODE_TITLES } from './boardProgress.ts'

export type TraceRow = TaskTrace | 'bad'

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const optStr = (v: unknown): boolean => v === undefined || typeof v === 'string'

function goodRow(row: Record<string, unknown>): boolean {
  const { nodes, current } = row
  if (!Array.isArray(nodes) || !isObj(current)) return false
  if (typeof current.state !== 'string' || !(current.state in TRACE_CURRENT_TITLES) || !optStr(current.actor) || !optStr(current.since)) return false
  return nodes.every(node => isObj(node)
    && typeof node.at === 'string' && typeof node.kind === 'string' && node.kind in TRACE_NODE_TITLES
    && optStr(node.actor) && optStr(node.to) && optStr(node.text)
    && (node.evidence === undefined || (Array.isArray(node.evidence) && node.evidence.every(one => typeof one === 'string'))))
}

/** 按事项 id 一行;认不出事项 id 的行无处可挂,丢掉。 */
export function readTraceView(raw: unknown): Map<string, TraceRow> | undefined {
  if (!isObj(raw) || !Array.isArray(raw.traces)) return undefined
  const rows = new Map<string, TraceRow>()
  for (const row of raw.traces) {
    if (!isObj(row) || typeof row.task_id !== 'string') continue
    rows.set(row.task_id, goodRow(row) ? row as unknown as TaskTrace : 'bad')
  }
  return rows
}
