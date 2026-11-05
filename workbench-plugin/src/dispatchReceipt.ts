import type { DispatchRuntime } from './protocol.ts'

export function runtimeLine(runtime: DispatchRuntime | undefined): string {
  if (runtime === undefined) return '运行模型与思考档未核实'
  const effort = { minimal: '最少', low: '低', medium: '中', high: '高', xhigh: '很高', max: '最高', ultra: '最高', off: '关闭', on: '开启' }[runtime.observed.effort ?? ''] ?? (runtime.observed.effort === undefined ? undefined : '未识别')
  const detail = [runtime.observed.model, effort === undefined ? undefined : `思考档${effort}`].filter(Boolean).join('，')
  return `${detail === '' ? '' : `${detail}；`}${runtime.status === 'verified' ? '已核实' : runtime.status === 'mismatch' ? '运行档位与请求不符' : '运行模型与思考档未核实'}`
}

/** An alias is a request, not evidence of which immutable model snapshot it resolved to. */
export function runtimeStatus(family: string, requested: DispatchRuntime['requested'], observed: DispatchRuntime['observed']): DispatchRuntime['status'] {
  const unresolvedAlias = family === 'claude' && ['opus', 'sonnet', 'haiku', 'fable'].includes(requested.model ?? '') && requested.model !== observed.model
  const conflict = (['model', 'effort'] as const).some(key => requested[key] !== undefined && observed[key] !== undefined && requested[key] !== observed[key] && !(key === 'model' && unresolvedAlias))
  return conflict ? 'mismatch' : !unresolvedAlias && observed.model !== undefined && observed.effort !== undefined ? 'verified' : 'unverified'
}
