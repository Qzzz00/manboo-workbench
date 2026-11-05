import { runtimeStatus } from '../dispatchReceipt.ts'
import type { DispatchRuntime, DispatchSelection, TaskDispatch } from '../protocol.ts'
import { isAgentDispatchFamily } from '../protocol.ts'
const record = (v: unknown): Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {}
const text = (v: unknown): string | undefined => typeof v === 'string' && v.length > 0 ? v.slice(0, 1000) : undefined
const config = (v: unknown): DispatchRuntime['requested'] => {
  const r = record(v)
  return { ...(text(r.model) === undefined ? {} : { model: text(r.model)! }), ...(text(r.effort) === undefined ? {} : { effort: text(r.effort)! }) }
}
/** Disk round trips only; external update routes do not accept these fields. */
export function sanitizeDispatchEvidence(raw: Record<string, unknown>): Pick<TaskDispatch, 'runtime' | 'selection'> {
  const out: Pick<TaskDispatch, 'runtime' | 'selection'> = {}
  const r = record(raw.runtime)
  if (text(r.attempt_id) !== undefined && typeof r.started_at === 'string' && Number.isFinite(Date.parse(r.started_at)) && (r.mode === 'new' || r.mode === 'resume')) {
    const observed = config(r.observed)
    const requested = config(r.requested)
    const source = r.source === 'native_context' || r.source === 'cli_result' ? r.source : undefined
    out.runtime = {
      attempt_id: text(r.attempt_id)!, started_at: r.started_at, mode: r.mode, requested, observed,
      status: source === undefined ? 'unverified' : runtimeStatus(String(raw.family), requested, observed),
      ...(source === undefined ? {} : { source }),
      ...(text(r.session_id) === undefined ? {} : { session_id: text(r.session_id)! }),
      ...(text(r.turn_id) === undefined ? {} : { turn_id: text(r.turn_id)! }),
    }
  }
  const s = record(raw.selection)
  if (isAgentDispatchFamily(s.family) && typeof s.evaluated_at === 'string' && Number.isFinite(Date.parse(s.evaluated_at)) && text(s.reason) !== undefined) {
    out.selection = { family: s.family, evaluated_at: s.evaluated_at, reason: text(s.reason)!, candidates: (Array.isArray(s.candidates) ? s.candidates : []).flatMap(value => {
      const c = record(value)
      if (!isAgentDispatchFamily(c.family) || typeof c.ok !== 'boolean' || typeof c.quota !== 'string' || !['ok', 'low', 'empty', 'unknown'].includes(String(c.level))) return []
      return [{ family: c.family, ok: c.ok, quota: c.quota.slice(0, 1000), level: c.level as DispatchSelection['candidates'][number]['level'], ...(text(c.read_at) === undefined ? {} : { read_at: text(c.read_at)! }) }]
    }) }
  }
  return out
}
