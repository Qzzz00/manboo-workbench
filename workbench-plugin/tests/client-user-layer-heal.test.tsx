/**
 * 分层自愈完善 · 客户端那一半(2026-10-23,卡「分层自愈完善」):
 *   ① 装得怎样的上报带上样式指纹(坏版本按 入口指纹@样式指纹 记,样式变了是另一版);
 *   ② 清单说这一版带 style.css 而样式取不到 = 这一版没装好,按坏版报(二刀二 style_rev 异步路),
 *      不拿没样式的页面冒充装好。
 */
import { act, cleanup, render } from '@testing-library/react'
import { createElement } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { UserLayerStateView, UserLayerWidgetView } from '../src/protocol.ts'
import { UserLayerCell, createUserLayerRegistry, useUserLayerSync, type UserLayerRegistry } from '../src/client/userLayer.tsx'

afterEach(cleanup)

const W: UserLayerWidgetView = { id: 'files', name: '素材管理', status: 'ok', replaces: 'files', export: 'FilesModule', rev: 'aaaaaaaaaaaa' }
const CODE = `
const { jsx } = require('react/jsx-runtime')
function FilesModule(props) { return jsx('p', { children: '她的素材管理:' + props.title }) }
module.exports = { FilesModule }
`

function view(...widgets: UserLayerWidgetView[]): UserLayerStateView {
  return { contract: 1, widgets }
}

function Cell({ registry }: { registry: UserLayerRegistry }) {
  return createElement(UserLayerCell, {
    registry,
    slot: 'files',
    templateId: undefined,
    props: { title: '素材' },
    fallback: (problem?: string) => createElement('p', null, `本体那一版${problem === undefined ? '' : `(${problem})`}`),
    pending: createElement('p', null, '等一下'),
  })
}

describe('上报带上样式指纹(坏版按 入口@样式 组合记)', () => {
  it('带 style_rev 的小组件:报 ok 时原样带上', () => {
    const registry = createUserLayerRegistry()
    const said: unknown[] = []
    registry.setReporter(outcome => said.push(outcome))
    registry.install({ ...W, style_rev: 'bbbbbbbbbbbb' }, CODE)
    render(<Cell registry={registry} />)
    expect(said).toEqual([{ id: 'files', rev: 'aaaaaaaaaaaa', style_rev: 'bbbbbbbbbbbb', ok: true }])
  })

  it('不带 style_rev 的:上报不变(老契约)', () => {
    const registry = createUserLayerRegistry()
    const said: unknown[] = []
    registry.setReporter(outcome => said.push(outcome))
    registry.install(W, CODE)
    render(<Cell registry={registry} />)
    expect(said).toEqual([{ id: 'files', rev: 'aaaaaaaaaaaa', ok: true }])
  })

  it('同一个入口指纹、样式指纹变了:是另一版,重新报(不拿旧键挡)', async () => {
    const registry = createUserLayerRegistry()
    const said: unknown[] = []
    registry.setReporter(outcome => said.push(outcome))
    const load = async (): Promise<string> => CODE
    act(() => { registry.sync(view({ ...W, style_rev: 'aaaaaaaaaaaa' }), load) })
    const { unmount } = render(<Cell registry={registry} />)
    await act(async () => { await Promise.resolve() })
    expect(said).toEqual([{ id: 'files', rev: 'aaaaaaaaaaaa', style_rev: 'aaaaaaaaaaaa', ok: true }])
    unmount()
    act(() => { registry.sync(view({ ...W, style_rev: 'cccccccccccc' }), load) })
    render(<Cell registry={registry} />)
    await act(async () => { await Promise.resolve() })
    expect(said).toEqual([
      { id: 'files', rev: 'aaaaaaaaaaaa', style_rev: 'aaaaaaaaaaaa', ok: true },
      { id: 'files', rev: 'aaaaaaaaaaaa', style_rev: 'cccccccccccc', ok: true },
    ])
  })
})

describe('样式取不到 = 这一版没装好(按坏版报)', () => {
  function Sync({ registry, widget, baseUrl, fetchImpl }: {
    registry: UserLayerRegistry
    widget: UserLayerWidgetView
    baseUrl: string
    fetchImpl: typeof fetch
  }) {
    useUserLayerSync(registry, view(widget), baseUrl, fetchImpl)
    return null
  }

  it('清单说带 style.css 而 /style 取不到:先退避重试不算坏;用尽后这一版不装、本地判坏说清楚;取不到这类不算确定坏,不替服务端记(与代码取不到同一纪律)', async () => {
    vi.useFakeTimers()
    try {
      const registry = createUserLayerRegistry()
      const bodies: unknown[] = []
      const fetchImpl = (async (input: unknown, init?: RequestInit) => {
        const url = String(input)
        if (url.includes('/user-layer/report')) {
          bodies.push(JSON.parse(String(init?.body)))
          return new Response('{"ok":true}')
        }
        if (url.includes('/style')) return new Response('no', { status: 404 })
        return new Response(CODE)
      }) as typeof fetch
      render(<Sync registry={registry} widget={{ ...W, style_rev: 'bbbbbbbbbbbb' }} baseUrl="http://x" fetchImpl={fetchImpl} />)
      await act(async () => { await Promise.resolve() })
      // 第一次没取到:先重试,还不算坏、不替服务端记。
      expect(registry.problems().size).toBe(0)
      expect(bodies).toEqual([])
      // 退避全部跑完:这一版不装、本地判坏说清楚。
      await act(async () => { await vi.advanceTimersByTimeAsync(10 * 60_000) })
      const problem = registry.problems().get('files')
      expect(problem).toContain('style.css')
      // 不拿没样式的页面冒充装好:没有 ok 上报,也没往坏版本表里记
      expect(bodies).toEqual([])
    }
    finally { vi.useRealTimers() }
  })

  it('样式取得到:照常装好报 ok', async () => {
    const registry = createUserLayerRegistry()
    const bodies: unknown[] = []
    const fetchImpl = (async (input: unknown, init?: RequestInit) => {
      const url = String(input)
      if (url.includes('/user-layer/report')) {
        bodies.push(JSON.parse(String(init?.body)))
        return new Response('{"ok":true}')
      }
      if (url.includes('/style')) return new Response('.a { color: red }')
      return new Response(CODE)
    }) as typeof fetch
    render(<><Sync registry={registry} widget={{ ...W, style_rev: 'bbbbbbbbbbbb' }} baseUrl="http://x" fetchImpl={fetchImpl} /><Cell registry={registry} /></>)
    await act(async () => { await Promise.resolve() })
    expect(registry.problems().size).toBe(0)
    expect(bodies).toEqual([{ id: 'files', rev: 'aaaaaaaaaaaa', style_rev: 'bbbbbbbbbbbb', ok: true }])
  })
})
