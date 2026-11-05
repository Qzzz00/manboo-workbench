/**
 * 运行片段(2026-10-24,小K collab-desktop-1024;消费 core 契约 §4 E)。
 *
 * `GET /collab/runs?task_id=` 给 jobLog 现算的运行片段:实际运行 / 暂停等待(带原因)/
 * 已收场 / 失败 / 状态未知(失联或记录过旧,不当作在跑)。没有记录就说没有,不编一段;
 * 老服务没有这个口,明说没接上。计划时间照旧走卡上的 start/end(TimeFields),不在这一列。
 */
import { useEffect, useState } from 'react'
import type { RunSegment } from '../../protocol.ts'
import type { CollabApi } from './collabApi.ts'

function clock(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}

export function runLine(one: RunSegment): string {
  // 本机观察只说明何时核到事件，不能用派出/管线时间补齐或计算模型耗时。
  const observed = (iso?: string): string => iso === undefined ? '未知' : clock(iso) || '未知'
  const span = ` · 本机核到开工：${observed(one.execution_started_observed_at)} · 收到结果：${observed(one.execution_finished_observed_at)} · 派出记录：${observed(one.started_at)}${one.finished_at === undefined ? '' : ` · 管线收场：${observed(one.finished_at)}`}`
  if (one.status === 'paused') return `暂停等待 · ${one.source}${span}${one.pause_reason !== undefined ? ` · ${one.pause_reason}` : ''}`
  if (one.status === 'unknown') return `状态未知 · ${one.source}${span} · 失联或记录过旧,不当作在跑`
  if (one.status === 'done') return `实际运行 · ${one.source}${span}${one.outcome !== undefined ? ` · 收场:${one.outcome}` : ''}`
  if (one.status === 'failed') return `失败 · ${one.source}${span}${one.outcome !== undefined ? ` · ${one.outcome}` : ''}`
  const labels: Readonly<Record<string, string>> = { running: '实际运行中', dispatched: '已派出，待开工证据' }
  return `${labels[one.status] ?? '状态未知'} · ${one.source}${span}`
}

export function RunsPanel({ taskId, api, snapshotKey }: { taskId: string, api: CollabApi, snapshotKey?: unknown }) {
  const [segments, setSegments] = useState<readonly RunSegment[] | undefined>(undefined)
  const [live, setLive] = useState<boolean | undefined>(undefined)
  useEffect(() => {
    let alive = true
    // 实际回包是 { runs }(契约 §4 实现照实消费)。
    void api.get<{ runs?: RunSegment[] }>(`/collab/runs?task_id=${encodeURIComponent(taskId)}`).then((got) => {
      if (!alive) return
      if (got === undefined || !Array.isArray(got.runs)) { setLive(false); return }
      setLive(true)
      setSegments(got.runs)
    })
    return () => { alive = false }
  }, [api, taskId, snapshotKey])
  if (live === undefined) return <p className="ben-cl__muted" role="status">在读……</p>
  if (live === false) return <p className="ben-cl__muted" role="status">运行账还没接上(老服务)。</p>
  if (segments !== undefined && segments.length === 0) return <p className="ben-cl__muted">还没有运行记录。</p>
  return (
    <ul className="ben-cl__runs" aria-label="运行片段">
      {(segments ?? []).map((one, index) => (
        <li key={index} data-status={one.status}>{runLine(one)}</li>
      ))}
    </ul>
  )
}
