import { runtimeStatus } from '../dispatchReceipt.ts'
import type { DispatchRuntime, RuntimeConfig } from '../protocol.ts'

/** Only native envelopes are read; assistant text and argv are never observations. */
export function observeRuntime(runtime: DispatchRuntime, input: {
  family: string, sessionId?: string, cwd?: string, log: string, context?: string,
}): DispatchRuntime {
  if (runtime.mode === 'resume' && runtime.session_id !== undefined && runtime.session_id !== input.sessionId) return { ...runtime, observed: {}, status: 'unverified' }
  const observed: RuntimeConfig = {}
  let source: DispatchRuntime['source']
  let turnId: string | undefined
  interface NativeRow {
    type?: unknown
    timestamp?: unknown
    payload?: { id?: unknown, cwd?: unknown, turn_id?: unknown, model?: unknown, effort?: unknown }
    session_id?: unknown
    modelUsage?: unknown
  }
  const rows = (raw: string): NativeRow[] => raw.split('\n').flatMap(line => {
    try { const row = JSON.parse(line); return row !== null && typeof row === 'object' ? [row] : [] } catch { return [] }
  })
  if (input.family === 'codex' && input.sessionId !== undefined && input.context !== undefined) {
    const entries = rows(input.context)
    const meta = entries.find(row => row.type === 'session_meta')?.payload
    if (meta?.id === input.sessionId && meta.cwd === input.cwd) {
      const contexts = entries.filter(row => row.type === 'turn_context' && typeof row.timestamp === 'string'
        && Date.parse(row.timestamp) >= Date.parse(runtime.started_at) && row.payload?.cwd === input.cwd)
      // A resumed thread may contain old contexts. This attempt must own exactly one turn.
      const ids = new Set(contexts.map(row => row.payload?.turn_id).filter((id): id is string => typeof id === 'string' && id.trim() !== ''))
      const onlyTurnId = ids.size === 1 ? [...ids][0] : undefined
      const row = onlyTurnId !== undefined && contexts.every(entry => entry.payload?.turn_id === onlyTurnId) ? contexts.at(-1)?.payload : undefined
      if (row !== undefined) {
        if (typeof row.model === 'string' && row.model.trim() !== '') observed.model = row.model
        if (typeof row.effort === 'string' && row.effort.trim() !== '') observed.effort = row.effort
        turnId = typeof row.turn_id === 'string' ? row.turn_id : undefined
        source = 'native_context'
      }
    }
  }
  if (input.family === 'claude' && input.sessionId !== undefined) {
    // --output-format json: modelUsage is emitted by the CLI, not result text.
    const result = rows(input.log).findLast(row => row.type === 'result' && row.session_id === input.sessionId)
    const models = result?.modelUsage !== null && typeof result?.modelUsage === 'object' ? Object.keys(result.modelUsage) : []
    if (models.length === 1) { observed.model = models[0]!; source = 'cli_result' }
  }
  return {
    ...runtime, observed,
    status: runtimeStatus(input.family, runtime.requested, observed),
    ...(source === undefined ? {} : { source }),
    ...(input.sessionId === undefined ? {} : { session_id: input.sessionId }),
    ...(turnId === undefined ? {} : { turn_id: turnId }),
  }
}
