import '@testing-library/jest-dom/vitest'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { TaskView } from '../src/protocol.ts'
import { starterWidget } from './helpers/starterLayer.ts'

// 2026-10-21:这几格搬进了用户层(`user-layer/起步/小组件/`),经本体的加载口装出来。
const PublishModule = starterWidget('publish')

afterEach(cleanup)
const BOX = { id: 'publish', title: '发布计划', basisPct: 30, dragging: false, onResizeStart() {}, onResizeMove() {}, onResizeEnd() {} }
const NOW = new Date(2026, 9, 20, 12).toISOString()
function plan(id: string, over: Partial<TaskView> = {}): TaskView {
  return { id, title: `内容${id}`, status: 'todo', kind: 'topic', planned_at: '2026-10-20', ...over } as TaskView
}
function props(tasks: TaskView[], fetchImpl: typeof fetch) {
  return { box: BOX, header: <h3 id="publish">发布计划</h3>, headingId: 'publish', baseUrl: 'http://127.0.0.1:8791', fetchImpl, tasks, now: NOW }
}
function pick() { fireEvent.click(screen.getByRole('button', { name: /^2026-10-20，/ })) }
function remove(title = '内容a') { fireEvent.click(screen.getByRole('button', { name: `删除计划：${title}` })) }
function confirm() { fireEvent.click(screen.getByRole('button', { name: '确认删除' })) }
function response(ok = true) { return new Response(JSON.stringify(ok ? { ok: true } : { error: '暂时无法保存' }), { status: ok ? 200 : 500 }) }

describe('在日期面板删除单条发布计划', () => {
  it('逐条显示删除入口；确认后只撤掉选中计划，立即更新当天列表和月历计数', async () => {
    const fetchImpl = vi.fn(async () => response()) as unknown as typeof fetch
    render(<PublishModule {...props([plan('a'), plan('b'), plan('c', { planned_at: '2026-10-21' })], fetchImpl)} />)
    pick()
    expect(screen.getByLabelText('发布内容标题')).not.toHaveFocus()
    remove()
    expect(fetchImpl).not.toHaveBeenCalled()
    expect(screen.getByText(/选题和素材会保留/)).toBeInTheDocument()
    confirm()
    await waitFor(() => expect(screen.queryByRole('button', { name: '删除计划：内容a' })).toBeNull())
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    const [url, init] = vi.mocked(fetchImpl).mock.calls[0]!
    expect(url).toBe('http://127.0.0.1:8791/task/update')
    expect(JSON.parse(String(init?.body))).toEqual({ id: 'a', planned_at: null })
    expect(screen.getByRole('button', { name: '删除计划：内容b' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /^2026-10-20，今天，1条未发布/ })).toBeInTheDocument()
    expect(within(screen.getByRole('dialog')).getByRole('status')).toHaveTextContent('已删除')
    expect(screen.getByRole('dialog')).toBeInTheDocument()
  })

  it.each([undefined, '2026-10-20'])('兼容 due 旧计划和回退日期，清掉排期后刷新不会重新出现（planned_at=%s）', async planned_at => {
    const fetchImpl = vi.fn(async () => response()) as unknown as typeof fetch
    const task = plan('a', { due: '2026-10-18', desc: '素材仍在', status: 'doing' })
    if (!planned_at) { delete task.planned_at; task.due = '2026-10-20' }
    const view = render(<PublishModule {...props([task], fetchImpl)} />)
    pick(); remove(); confirm()
    await waitFor(() => expect(fetchImpl).toHaveBeenCalledOnce())
    expect(JSON.parse(String(vi.mocked(fetchImpl).mock.calls[0]![1]?.body))).toEqual({ id: 'a', planned_at: null, due: null })
    await waitFor(() => expect(screen.queryByRole('button', { name: '删除计划：内容a' })).toBeNull())
    // 模拟服务端已持久化后的快照，仍保留同一内容及创作状态。
    const saved = { ...task }
    delete saved.planned_at
    delete saved.due
    view.unmount()
    render(<PublishModule {...props([saved], fetchImpl)} />)
    expect(screen.getByRole('button', { name: /^2026-10-20，今天，0条未发布/ })).toBeInTheDocument()
  })

  it('可以放弃确认，保留计划且不发送请求', () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch
    render(<PublishModule {...props([plan('a')], fetchImpl)} />)
    pick(); remove()
    fireEvent.click(screen.getByRole('button', { name: '保留计划' }))
    expect(screen.queryByRole('button', { name: '确认删除' })).toBeNull()
    expect(screen.getByRole('button', { name: '删除计划：内容a' })).toBeInTheDocument()
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it.each(['http', 'network'])('删除失败保留计划并允许重试（%s）', async failure => {
    const fn = vi.fn().mockImplementationOnce(async () => {
      if (failure === 'network') throw new Error('网络断开')
      return response(false)
    }).mockImplementation(async () => response())
    render(<PublishModule {...props([plan('a')], fn as typeof fetch)} />)
    pick(); remove(); confirm()
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent(failure === 'network' ? '网络断开' : '暂时无法保存'))
    expect(screen.getByRole('button', { name: /^2026-10-20，今天，1条未发布/ })).toBeInTheDocument()
    confirm()
    await waitFor(() => expect(screen.queryByRole('button', { name: '删除计划：内容a' })).toBeNull())
    expect(fn).toHaveBeenCalledTimes(2)
  })

  it('删除处理中阻止重复请求、保存与关闭；完成后恢复操作', async () => {
    let finish!: (value: Response) => void
    const fn = vi.fn(() => new Promise<Response>(resolve => { finish = resolve }))
    render(<PublishModule {...props([plan('a')], fn as typeof fetch)} />)
    pick(); remove(); confirm()
    expect(screen.getByRole('button', { name: '正在删除…' })).toBeDisabled()
    expect(screen.getByLabelText('发布内容标题')).toBeDisabled()
    fireEvent.click(screen.getByRole('button', { name: '正在删除…' }))
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' })
    expect(screen.getByRole('dialog')).toBeInTheDocument()
    expect(fn).toHaveBeenCalledOnce()
    await act(async () => { finish(response()) })
    expect(screen.getByLabelText('发布内容标题')).not.toBeDisabled()
  })

  it('已发布记录可查看，但不出现删除排期按钮', () => {
    const fn = vi.fn() as unknown as typeof fetch
    render(<PublishModule {...props([plan('a', { published_at: '2026-10-20' })], fn)} />)
    fireEvent.click(screen.getByRole('button', { name: '已发布' }))
    pick()
    expect(within(screen.getByRole('dialog')).getByText('内容a')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /^删除计划：/ })).toBeNull()
  })

  it('服务端确认删除后，同一内容重新排期可再次显示', async () => {
    const fn = vi.fn(async () => response()) as unknown as typeof fetch
    const task = plan('a')
    const view = render(<PublishModule {...props([task], fn)} />)
    pick(); remove(); confirm()
    await waitFor(() => expect(screen.queryByRole('button', { name: '删除计划：内容a' })).toBeNull())
    const saved = { ...task }
    delete saved.planned_at
    view.rerender(<PublishModule {...props([saved], fn)} />)
    view.rerender(<PublishModule {...props([{ ...task }], fn)} />)
    expect(screen.getByRole('button', { name: '删除计划：内容a' })).toBeInTheDocument()
  })
})
