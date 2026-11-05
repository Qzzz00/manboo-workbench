import '@testing-library/jest-dom/vitest'
import { cleanup, render, screen, waitFor, fireEvent } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { FirstRunFlow } from '../src/client/firstrun/FirstRunFlow.tsx'
import { FIRST_USE_SAY, type FirstUseView, type MainPath } from '../src/mainPaths.ts'
import type { WorkbenchState } from '../src/protocol.ts'
afterEach(cleanup)
const useView = (status: 'ok' | 'missing' = 'ok'): FirstUseView => ({ day0: '2026-10-26', order: ['call', 'morning', 'delegate'], call_mode: 'phone', paths: (['call', 'morning', 'delegate'] as MainPath[]).map(path => ({ path, title: path, say: FIRST_USE_SAY[path], state: path === 'call' ? 'todo' : status, oks: 0, fails: 0, ...(status === 'missing' && path !== 'call' ? { door: { door: 'other' as const, title: '服务失败', text: '服务暂时不可用，请重试', fixes: [] } } : {}) })) })
const state = (patch: Partial<WorkbenchState> = {}): WorkbenchState => ({ agents: [], sessions: [], quota: {}, stale: false, now: '2026-10-26T01:00:00Z', ...patch })
function setup(snapshot = state(), failFinish = false) {
  const done = vi.fn()
  let fail = failFinish
  const fetchImpl = vi.fn(async (url: string) => {
    if (String(url).endsWith('/first-run') && fail) { fail = false; return new Response(JSON.stringify({ error: '保存失败' }), { status: 500 }) }
    return new Response(JSON.stringify(String(url).endsWith('/onboarding') ? { stage: 'opening', done: false } : { ok: true, available: false }))
  }) as unknown as typeof fetch
  const view = render(<FirstRunFlow baseUrl="http://x" state={snapshot} fetchImpl={fetchImpl} onDone={done} turnsPollMs={0} />)
  return { ...view, done, fetchImpl }
}
it('全新电脑与已配对电脑都从电脑出场开始，不先二维码也不等手机', () => {
  for (const devices of [[], [{ id: 'old', name: '旧手机', platform: 'android', created_at: '', last_seen_at: '' }]]) {
    const t = setup(state({ devices }))
    expect(screen.getByRole('button', { name: '已经有在做的事' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: '已装,去配对' })).toBeNull()
    t.unmount()
  }
})
it('电脑两项完成就提供最后可选配对，保存失败能重试', async () => {
  const t = setup(state({ onboarding: { done: true, stage: 'done' }, first_use: useView() }), true)
  fireEvent.click(await screen.findByRole('button', { name: '继续' }))
  expect(await screen.findByText('连接手机与座机（可选）')).toBeTruthy()
  expect(t.done).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: '稍后再配，进工作台' }))
  expect(await screen.findByRole('alert')).toHaveTextContent('保存失败')
  fireEvent.click(screen.getByRole('button', { name: '稍后再配，进工作台' }))
  await waitFor(() => expect(t.done).toHaveBeenCalledOnce())
})
it('缺门如实说明仍能完成主路，不要求电话成功', async () => {
  setup(state({ onboarding: { done: true, stage: 'done' }, first_use: useView('missing') }))
  expect(await screen.findAllByText('服务暂时不可用，请重试')).toHaveLength(2)
  fireEvent.click(screen.getByRole('button', { name: '继续' }))
  expect(await screen.findByText('连接手机与座机（可选）')).toBeTruthy()
})
it('配置入口在引导中可达，不必先完成引导', () => {
  render(<FirstRunFlow baseUrl="http://x" state={state()} onDone={() => {}} turnsPollMs={0} fetchImpl={vi.fn(async () => new Response('{}'))} />)
  fireEvent.click(screen.getByRole('button', { name: '配置模型与 AI 来源' }))
  expect(screen.getByRole('button', { name: '返回引导' })).toBeTruthy()
})
it('刷新后可从服务端已有阶段接着引导，不重交已答的称呼与分岔', async () => {
  const calls: string[] = []
  const fetchImpl = vi.fn(async (url: string) => {
    calls.push(String(url))
    return new Response(JSON.stringify(String(url).endsWith('/onboarding/session') ? { stage: 'habits', session_id: 's', first_message: '继续', seed: '继续', resumed: true } : String(url).endsWith('/onboarding') ? { stage: 'habits', nickname: '小林', done: false } : { turns: [], busy: false }))
  }) as unknown as typeof fetch
  render(<FirstRunFlow baseUrl="http://x" state={state({ onboarding: { stage: 'habits', done: false } })} onDone={() => {}} fetchImpl={fetchImpl} turnsPollMs={0} />)
  fireEvent.click(screen.getByRole('button', { name: '继续引导' }))
  expect(await screen.findByRole('textbox', { name: '说一句' })).toBeTruthy()
  expect(calls.some(path => path.endsWith('/onboarding/answer') || path.endsWith('/onboarding/restart'))).toBe(false)
})
it('电脑主路的首次选择不再把电话列为下一步', () => {
  setup(state({ first_use: useView() }))
  expect(screen.queryByText(/打个电话/)).toBeNull()
})
it('已知缺门时不承诺一分钟后出早报', async () => {
  setup(state({ onboarding: { done: true, stage: 'done' }, first_use: useView('missing') }))
  await screen.findByRole('heading', { name: '第一次有用：在电脑上试两件事' })
  expect(screen.queryByText(FIRST_USE_SAY.morning)).toBeNull()
  expect(screen.queryByText(FIRST_USE_SAY.delegate)).toBeNull()
})
