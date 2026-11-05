// @vitest-environment jsdom
/*
 * 任务书 10-29「在跑的事项要数到命令行真在跑的活」用例②(客户端):
 * useCollabRuns 改成**一次无参请求**读全部未结卡的片段 —— 没归目标的卡不再被 goal_id 去重漏掉;
 * runningCountOf 数出没归目标的在跑卡 = 1(从前是 0),有目标的照旧;收起球与展开窗同源用例不动。
 */
import '@testing-library/jest-dom/vitest'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useCollabRuns } from '../src/client/useCollabRuns.ts'
import { runningCountOf, runningTaskIdsOfRuns } from '../src/client/businessExecutionModel.ts'
import type { RunSegment, WorkbenchState } from '../src/protocol.ts'

afterEach(() => { cleanup(); vi.unstubAllGlobals() })

const AT = '2026-10-29T03:00:00.000Z'
const stateWith = (tasks: unknown[]): WorkbenchState => ({
  agents: [], sessions: [], quota: {}, now: AT, stale: false,
  tasks: { tasks, sprints: [], modules: [], project_meta: [] },
  butler_inbox: { items: [] },
} as unknown as WorkbenchState)
const segment = (taskId: string, status: RunSegment['status']): RunSegment => ({
  task_id: taskId, status, role: 'business', source: 'kimi', started_at: AT,
})

/** 读一次 useCollabRuns:把请求过的路径记下来,把数出来的在跑事项数摆出来。 */
function Probe({ state, paths }: { state: WorkbenchState, paths: string[] }) {
  const facts = useCollabRuns(state, { baseUrl: 'http://x' })
  const count = runningCountOf(facts, 0)
  return <output data-testid="probe">{JSON.stringify({ paths, count, ids: Array.isArray(facts) ? runningTaskIdsOfRuns(facts) : facts })}</output>
}

const fetchRecording = (runsBody: unknown, paths: string[]) => (async (input: RequestInfo | URL) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
  paths.push(url)
  if (url.includes('/collab/runs')) return new Response(JSON.stringify(runsBody), { headers: { 'content-type': 'application/json' } })
  return new Response('{}', { headers: { 'content-type': 'application/json' } })
}) as typeof fetch

describe('useCollabRuns:一次无参请求,没归目标的卡也数得到', () => {
  it('没归目标的在跑卡:runningCountOf 是 1,不是 0(从前的洞:按 goal_id 逐本读,一本都不发)', async () => {
    const paths: string[] = []
    vi.stubGlobal('fetch', fetchRecording({ runs: [segment('a', 'running')] }, paths))
    // 卡 a 没归目标(goal_id 空)——悬浮球里说一句建的那种。
    render(<Probe state={stateWith([{ id: 'a', title: '没归目标的活', status: 'doing', source: { kind: 'manual' }, created_at: AT, updated_at: AT }])} paths={paths} />)
    await waitFor(() => expect(screen.getByTestId('probe')).toHaveTextContent('"count":1'))
    const got = JSON.parse(screen.getByTestId('probe').textContent ?? '{}') as { paths: string[], ids: string[] }
    expect(got.ids).toEqual(['a'])
    // 整本一次取回:不带 goal_id,也不按目标发一串。
    const runsCalls = got.paths.filter(one => one.includes('/collab/runs'))
    expect(runsCalls).toEqual(['http://x/collab/runs'])
  })
  it('有目标与没归目标的混在一起:两本都在数', async () => {
    const paths: string[] = []
    vi.stubGlobal('fetch', fetchRecording({ runs: [segment('a', 'running'), segment('b', 'running')] }, paths))
    render(<Probe state={stateWith([
      { id: 'a', title: '目标下的活', goal_id: 'g-1', status: 'doing', source: { kind: 'manual' }, created_at: AT, updated_at: AT },
      { id: 'b', title: '没归目标的活', status: 'doing', source: { kind: 'manual' }, created_at: AT, updated_at: AT },
    ])} paths={paths} />)
    await waitFor(() => expect(screen.getByTestId('probe')).toHaveTextContent('"count":2'))
  })
  it("回包不是数组 = 'missing'(不编数)", async () => {
    const paths: string[] = []
    vi.stubGlobal('fetch', fetchRecording({}, paths))
    render(<Probe state={stateWith([])} paths={paths} />)
    await waitFor(() => expect(screen.getByTestId('probe')).toHaveTextContent('"count":0'))
    expect(screen.getByTestId('probe')).toHaveTextContent('"ids":"missing"')
  })
})
