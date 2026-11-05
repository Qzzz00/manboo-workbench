import { describe, expect, it } from 'vitest'
import { readLinkedCodexExecutions } from '../src/server/codexExecutionFacts.ts'
import type { TaskView } from '../src/protocol.ts'

const task = (id: string, sessionId: string): TaskView => ({ id, title: id, status: 'doing', source: { kind: 'manual' }, created_at: '', updated_at: '', links: [{ agent: 'codex', session_id: sessionId }] })
const source = (id: string) => [
  { type: 'session_meta', payload: { id } },
  { type: 'event_msg', timestamp: '2026-10-26T01:00:00.000Z', payload: { type: 'task_started', turn_id: 'round-1' } },
  { type: 'response_item', timestamp: '2026-10-26T01:01:00.000Z', payload: { type: 'custom_tool_call', turn_id: 'round-1', name: 'x', input: { private: 'must-not-leak' } } },
  { type: 'event_msg', timestamp: '2026-10-26T01:02:00.000Z', payload: { type: 'task_complete', turn_id: 'round-1', last_agent_message: '做完:产物已生成' } },
].map(row => JSON.stringify(row)).join('\n')

describe('精确关联的 Codex 执行事实', () => {
  it('相同rollout读取方式按当前轮实际模型识别Kimi，实质回答刷新但不泄漏正文', async () => {
    const raw = [
      { type: 'session_meta', payload: { id: 's-1', model_provider: 'openai' } },
      { type: 'event_msg', timestamp: '2026-10-26T01:00:00.000Z', payload: { type: 'task_started', turn_id: 'r-1' } },
      { type: 'turn_context', payload: { model: 'kimi-k2.5' } },
      { type: 'response_item', timestamp: '2026-10-26T01:04:00.000Z', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'private substantive answer' }] } },
    ].map(row => JSON.stringify(row)).join('\n')
    const got = await readLinkedCodexExecutions([task('t-1', 's-1')], {
      now: () => new Date('2026-10-26T01:04:01.000Z'),
      authorize: async () => ({ agent: 'codex', session_id: 's-1', format: 'codex-rollout', file: '/qa/source' }), read: async () => raw,
    })
    expect(got.sources[0]).toMatchObject({ agent: 'codex', provider: 'kimi', transport: 'codex-rollout', state: 'running' })
    expect(got.sources[0]?.events.at(-1)?.kind).toBe('updated')
    expect(JSON.stringify(got)).not.toContain('private substantive answer')
  })
  it('只输出真实事件摘要与稳定来源身份，不带原件正文或路径', async () => {
    const got = await readLinkedCodexExecutions([task('t-1', 's-1')], {
      now: () => new Date('2026-10-26T01:03:00.000Z'),
      authorize: async () => ({ agent: 'codex', session_id: 's-1', format: 'codex-rollout', file: '/private/source.jsonl' } as never),
      read: async () => source('s-1'),
    })
    expect(got.sources[0]).toMatchObject({ task_id: 't-1', session_id: 's-1', state: 'returned', events: [{ round: 'round-1', kind: 'started' }, { round: 'round-1', kind: 'updated' }, { round: 'round-1', kind: 'ended', receipt: { kind: 'done' } }] })
    expect(JSON.stringify(got)).not.toContain('/private/source.jsonl')
    expect(JSON.stringify(got)).not.toContain('must-not-leak')
  })
  it('同一会话挂两张卡明确歧义，不读来源', async () => {
    let reads = 0
    const got = await readLinkedCodexExecutions([task('t-1', 's-1'), task('t-2', 's-1')], {
      now: () => new Date('2026-10-26T01:03:00.000Z'), authorize: async () => { reads += 1; throw new Error('must not authorize') },
    })
    expect(reads).toBe(0)
    expect(got.sources.map(one => one.unknown)).toEqual(['ambiguous_link', 'ambiguous_link'])
  })
  it('拒绝与超大原件均显式未知', async () => {
    const denied = await readLinkedCodexExecutions([task('t-1', 's-1')], {
      now: () => new Date(), authorize: async () => { throw Object.assign(new Error('denied'), { code: 'denied' }) },
    })
    const oversized = await readLinkedCodexExecutions([task('t-1', 's-1')], {
      now: () => new Date(), authorize: async () => ({ agent: 'codex', session_id: 's-1', format: 'codex-rollout', file: '/private/x' } as never),
      read: async () => { throw new Error('source exceeds bounded replay') },
    })
    expect(denied.sources[0]?.unknown).toBe('denied')
    expect(oversized.sources[0]?.unknown).toBe('oversized')
  })
})
