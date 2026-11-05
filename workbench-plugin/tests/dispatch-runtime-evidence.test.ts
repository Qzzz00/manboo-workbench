// @vitest-environment node
import { describe, expect, it } from 'vitest'
import type { DispatchRuntime } from '../src/protocol.ts'
import { observeRuntime } from '../src/server/dispatchRuntime.ts'
const at = '2026-10-26T03:00:00.000Z'
const runtime = (mode: 'new' | 'resume' = 'new'): DispatchRuntime => ({ attempt_id: 'attempt', mode, started_at: at, requested: { model: 'gpt-test', effort: 'high' }, observed: {}, status: 'unverified' })
const context = (id = 's1', time = at, effort = 'high', turn = 'turn1') => [
  { type: 'session_meta', payload: { id, cwd: '/repo' } },
  { type: 'turn_context', timestamp: time, payload: { cwd: '/repo', model: 'gpt-test', effort, turn_id: turn } },
].map(row => JSON.stringify(row)).join('\n')
describe('宿主原生上下文核验', () => {
  it.each(['new', 'resume'] as const)('%s 只核本次会话与本轮原生上下文', mode => {
    expect(observeRuntime(runtime(mode), { family: 'codex', sessionId: 's1', cwd: '/repo', log: '', context: context() })).toMatchObject({ status: 'verified', observed: { model: 'gpt-test', effort: 'high' }, turn_id: 'turn1' })
  })
  it('错误会话、旧轮、错目录不核实', () => {
    for (const data of [{ context: context('s2') }, { context: context('s1', '2026-10-25T00:00:00Z') }, { context: context(), cwd: '/other' }]) {
      expect(observeRuntime(runtime('resume'), { family: 'codex', sessionId: 's1', cwd: '/repo', log: '', ...data }).status).toBe('unverified')
    }
  })
  it('同一 attempt 看到多个轮次不能猜最后一轮', () => {
    expect(observeRuntime(runtime(), { family: 'codex', sessionId: 's1', cwd: '/repo', log: '', context: `${context()}\n${context('s1', at, 'high', 'turn2')}` }).status).toBe('unverified')
  })
  it('实际档位冲突保存实际值并报不符', () => {
    expect(observeRuntime(runtime(), { family: 'codex', sessionId: 's1', cwd: '/repo', log: '', context: context('s1', at, 'low') })).toMatchObject({ status: 'mismatch', observed: { effort: 'low' } })
  })
  it('执行方正文与请求参数不能自证,缺字段不填配置', () => {
    const log = JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'model=gpt-test effort=high verified' } })
    expect(observeRuntime(runtime(), { family: 'codex', sessionId: 's1', log }).status).toBe('unverified')
    expect(observeRuntime(runtime(), { family: 'claude', sessionId: 's1', log: JSON.stringify({ type: 'result', session_id: 's1', modelUsage: { 'gpt-test': {} }, result: 'effort high' }) })).toMatchObject({ status: 'unverified', observed: { model: 'gpt-test' } })
  })
})

it('续跑不能将另一条实际会话核成原会话', () => {
  expect(observeRuntime({ ...runtime('resume'), session_id: 'original' }, { family: 'codex', sessionId: 's1', cwd: '/repo', log: '', context: context() }).status).toBe('unverified')
})

it('完整本轮后出现无轮次标识的上下文不能标已核实', () => {
  const fragment = JSON.stringify({ type: 'turn_context', timestamp: at, payload: { cwd: '/repo', model: 'gpt-test', effort: 'high' } })
  expect(observeRuntime(runtime(), { family: 'codex', sessionId: 's1', cwd: '/repo', log: '', context: `${context()}\n${fragment}` })).toMatchObject({ status: 'unverified', observed: {} })
})
it.each(['model', 'effort'] as const)('原生 %s 空白不算已核实', key => {
  const data = context().split('\n').map(row => JSON.parse(row))
  data[1].payload[key] = ' '
  expect(observeRuntime(runtime(), { family: 'codex', sessionId: 's1', cwd: '/repo', log: '', context: data.map(row => JSON.stringify(row)).join('\n') }).status).toBe('unverified')
})
