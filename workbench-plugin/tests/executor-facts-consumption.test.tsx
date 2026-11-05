import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, expect, it } from 'vitest'
import type { TaskView } from '../src/protocol.ts'
import { ButlerTaskStage } from '../src/client/ButlerTaskStage.tsx'
import { createItemDriver } from '../src/server/itemDriver.ts'
import * as composer from '../src/server/composer.ts'

const dirs: string[] = []
afterEach(() => { dirs.splice(0).forEach(dir => rmSync(dir, { recursive: true, force: true })) })
const task = (): TaskView => ({ id: 't-one', title: '实现回执', status: 'doing', assignee: 'codex', direction: 'mine', created_at: '2026-10-26T00:00:00Z', updated_at: '2026-10-26T00:00:00Z', source: { kind: 'manual' }, links: [{ agent: 'codex', session_id: 'codex-external-001' }] })

it('红例1：外部 CLI 的精确任务链接纳入执行事实，重复链接不重复读', async () => {
  let reads = 0
  const one = task()
  one.links = [...one.links!, ...one.links!]
  const result = await composer.readLinkedCodexExecutions([one], {
    now: () => new Date('2026-10-26T00:01:00Z'),
    authorize: async () => ({ agent: 'codex', session_id: 'codex-external-001', file: '/fixture/exact.jsonl', format: 'codex-rollout' }),
    read: async () => { reads++; return [
      { type: 'session_meta', payload: { id: 'codex-external-001', cwd: '/fixture/project', source: 'cli' } },
      { type: 'event_msg', timestamp: '2026-10-26T00:00:30Z', payload: { type: 'task_started', turn_id: 'turn-1' } },
    ].map(row => JSON.stringify(row)).join('\n') },
  })
  expect(reads).toBe(1)
  expect(result.sessions).toMatchObject([{ agent: 'codex', session_id: 'codex-external-001', status: 'running' }])
  expect(result.sources).toMatchObject([{ task_id: 't-one', state: 'running', events: [{ kind: 'started', round: 'turn-1' }] }])
})

it('红例2：doing 卡和缺席计数不能被舞台冒算成运行或全量零', () => {
  const html = renderToStaticMarkup(<ButlerTaskStage items={[]} focus={null} onChoose={() => {}} running={undefined} />)
  expect(html).toContain('执行状态未知')
  expect(html).not.toContain('此刻留给你')
})

it('红例4：独立交回被驱动消费，重启不重核，同刻不同回执不丢', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'exec-receipts-')); dirs.push(dir)
  const one = task()
  const returns: string[] = []
  const make = () => createItemDriver({ tasks: { list: async () => ({ tasks: [one] }), update: async () => true }, file: join(dir, 'drive.json'), mode: async () => 'plan', now: () => new Date('2026-10-26T00:02:00Z'), onReturn: id => returns.push(id) })
  const driver = make()
  await driver.reconcile()
  one.receipt = { kind: 'done', at: '2026-10-26T00:01:00Z', text: '做完：提交产物', by: 'codex' }
  await driver.reconcile()
  expect(returns).toEqual(['t-one'])
  await make().reconcile()
  expect(returns).toEqual(['t-one'])
  one.receipt = { ...one.receipt, kind: 'objection', text: '有异议：需要退回' }
  await make().reconcile()
  expect(returns).toEqual(['t-one', 't-one'])
})

it('同事项多 CLI 各有任务标题；token/context 元数据不能延长开工事实', async () => {
  const one = task()
  one.links = [...one.links!, { agent: 'codex', session_id: 'codex-external-002', note: '核对验收产物' }]
  const result = await composer.readLinkedCodexExecutions([one], {
    now: () => new Date('2026-10-26T00:10:00Z'),
    authorize: async (_, link) => ({ ...link, file: '/fixture/exact.jsonl', format: 'codex-rollout' }),
    read: async ref => [
      { type: 'session_meta', payload: { id: ref.session_id } },
      { type: 'event_msg', timestamp: '2026-10-26T00:00:30Z', payload: { type: 'task_started', turn_id: 'turn-1' } },
      { type: 'event_msg', timestamp: '2026-10-26T00:09:59Z', payload: { type: 'token_count', tokens: 99 } },
      { type: 'turn_context', timestamp: '2026-10-26T00:10:00Z', payload: { model: 'fixture', effort: 'high' } },
    ].map(row => JSON.stringify(row)).join('\n'),
  })
  expect(result.sources).toHaveLength(2)
  expect(result.sources.every(one => one.state === 'unknown' && one.unknown === 'stale')).toBe(true)
  expect(result.sessions.map(one => one.title)).toEqual(['实现回执', '核对验收产物'])
  expect(result.sessions.every(one => one.status === 'offline' && one.updated_at === '2026-10-26T00:00:30Z')).toBe(true)
})

it('一条来源挂到两个事项拒绝任取归属，不读原件', async () => {
  let reads = 0
  const one = task(), two = { ...task(), id: 't-two' }
  const result = await composer.readLinkedCodexExecutions([one, two], { now: () => new Date(), authorize: async () => { reads++; return undefined } })
  expect(reads).toBe(0)
  expect(result.sessions).toEqual([])
  expect(result.sources.map(one => [one.task_id, one.unknown])).toEqual([['t-one', 'ambiguous_link'], ['t-two', 'ambiguous_link']])
})

it('未授权和原件身份不符都不可作为运行来源', async () => {
  let reads = 0
  const denied = await composer.readLinkedCodexExecutions([task()], { now: () => new Date(), authorize: async () => undefined, read: async () => { reads++; return '' } })
  expect(reads).toBe(0)
  expect(denied.sources[0]?.unknown).toBe('unavailable')
  const mismatch = await composer.readLinkedCodexExecutions([task()], { now: () => new Date(), authorize: async () => ({ agent: 'codex', session_id: 'different-id', file: '/fixture/x', format: 'codex-rollout' }) })
  expect(mismatch.sessions).toEqual([])
})

it('CLI 退出不是交回；只有规范末条回答才产生可消费的回执', async () => {
  const rows = [
    { type: 'session_meta', payload: { id: 'codex-external-001', model_provider: 'openai' } },
    { type: 'event_msg', timestamp: '2026-10-26T00:00:30Z', payload: { type: 'task_started', turn_id: 'turn-1' } },
    { type: 'event_msg', timestamp: '2026-10-26T00:01:00Z', payload: { type: 'task_complete', turn_id: 'turn-1', last_agent_message: '已经退出' } },
  ]
  const deps = { now: () => new Date('2026-10-26T00:02:00Z'), authorize: async () => ({ agent: 'codex' as const, session_id: 'codex-external-001', file: '/fixture/x', format: 'codex-rollout' as const }), read: async () => rows.map(row => JSON.stringify(row)).join('\n') }
  const ended = await composer.readLinkedCodexExecutions([task()], deps)
  expect(ended.sources[0]?.state).toBe('ended')
  expect(ended.sources[0]?.receipt).toBeUndefined()
  rows[2]!.payload.last_agent_message = '做完: 1. result.json 已生成'
  const back = await composer.readLinkedCodexExecutions([task()], deps)
  expect(back.sources[0]?.receipt).toMatchObject({ kind: 'done', by: 'codex', at: '2026-10-26T00:01:00Z' })
  expect(back.sources[0]?.state).toBe('returned')
  const replay = await composer.readLinkedCodexExecutions([task()], deps)
  expect(replay).toEqual(back)
})

it('退回清空回执不产生新交回，重开轮次的新回执仍可核对', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'exec-reopen-')); dirs.push(dir)
  const one = task(), returns: string[] = []
  one.dispatch = { family: 'codex', hand: 'cli', status: 'done', started_at: '2026-10-26T00:00:00Z', ended_at: '2026-10-26T00:01:00Z' }
  const driver = createItemDriver({ tasks: { list: async () => ({ tasks: [one] }), update: async () => true }, file: join(dir, 'drive.json'), mode: async () => 'plan', now: () => new Date(), onReturn: id => returns.push(id) })
  await driver.reconcile()
  one.receipt = { kind: 'done', at: '2026-10-26T00:01:00Z', text: '做完:交回', by: 'codex' }
  await driver.reconcile()
  delete one.receipt
  one.round = 2
  await driver.reconcile()
  expect(returns).toEqual(['t-one'])
  one.receipt = { kind: 'done', at: '2026-10-26T00:01:00Z', text: '做完:交回', by: 'codex' }
  await driver.reconcile()
  expect(returns).toEqual(['t-one', 't-one'])
})

it('只有 doing、会话原件与 token 元数据，没有真实生命周期就不算开工', async () => {
  const result = await composer.readLinkedCodexExecutions([task()], {
    now: () => new Date('2026-10-26T00:02:00Z'),
    authorize: async () => ({ agent: 'codex', session_id: 'codex-external-001', file: '/fixture/existing.jsonl', format: 'codex-rollout' }),
    read: async () => [
      { type: 'session_meta', payload: { id: 'codex-external-001', pid: 12345 } },
      { type: 'event_msg', timestamp: '2026-10-26T00:01:00Z', payload: { type: 'token_count', total: 12000 } },
    ].map(row => JSON.stringify(row)).join('\n'),
  })
  expect(result.sessions).toEqual([])
  expect(result.sources[0]).toMatchObject({ state: 'unknown', unknown: 'unobservable', events: [] })
})

it('首次观察尚无回执也保存基线，停机期间到达的首份交回不能被当成旧历史', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'exec-first-return-')); dirs.push(dir)
  const one = task(), returns: string[] = []
  const make = () => createItemDriver({ tasks: { list: async () => ({ tasks: [one] }), update: async () => true }, file: join(dir, 'drive.json'), mode: async () => 'plan', now: () => new Date(), onReturn: id => returns.push(id) })
  await make().reconcile()
  one.receipt = { kind: 'done', at: '2026-10-26T00:01:00Z', text: '做完:交回', by: 'codex' }
  await make().reconcile()
  expect(returns).toEqual(['t-one'])
})

it('当前真实Codex原件的custom_tool_call输出刷新实质进展，不靠token续命', async () => {
  const result = await composer.readLinkedCodexExecutions([task()], {
    now: () => new Date('2026-10-26T00:10:00Z'),
    authorize: async () => ({ agent: 'codex', session_id: 'codex-external-001', file: '/fixture/exact.jsonl', format: 'codex-rollout' }),
    read: async () => [
      { type: 'session_meta', payload: { id: 'codex-external-001' } },
      { type: 'event_msg', timestamp: '2026-10-26T00:00:00Z', payload: { type: 'task_started', turn_id: 'round-one' } },
      { type: 'response_item', timestamp: '2026-10-26T00:09:30Z', payload: { type: 'custom_tool_call_output', call_id: 'controlled-call', output: 'controlled work result' } },
      { type: 'event_msg', timestamp: '2026-10-26T00:09:59Z', payload: { type: 'token_count' } },
    ].map(row => JSON.stringify(row)).join('\n'),
  })
  expect(result.sources[0]?.state).toBe('running')
  expect(result.sources[0]?.events.at(-1)).toMatchObject({ kind: 'updated', at: '2026-10-26T00:09:30Z' })
  expect(result.sessions[0]?.updated_at).toBe('2026-10-26T00:09:30Z')
})
