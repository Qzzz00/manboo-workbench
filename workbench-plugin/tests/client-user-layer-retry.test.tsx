/**
 * 用户层小组件取代码的重试(2026-10-28,卡「用户层小组件取代码超时就永久算坏」):
 *   ① 没取到(超时 / 网络 / 非 200)不等于她的代码坏:退避 5 → 15 → 45 秒自动重试,最多 5 次,
 *      期间那一格说「工作台这会儿忙,…稍等接上(第 N 次重试)」,不说「没装上」;
 *   ② 代码跑不起来照旧:failed,不重试(原行为);
 *   ③ 重试用尽才算「没装上」,并给一颗「再试一次」键,点了再取一次;
 *   ④ 页面重新可见(visibilitychange)或指纹变了,取不到失败态重取一次。
 */
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { createElement } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { UserLayerStateView, UserLayerWidgetView } from '../src/protocol.ts'
import {
  USER_LAYER_FETCH_RETRY_DELAYS_MS,
  USER_LAYER_FETCH_RETRY_MAX,
  USER_LAYER_LOAD_TIMEOUT_MS,
  UserLayerCell,
  createUserLayerRegistry,
  useUserLayerSync,
  type UserLayerRegistry,
} from '../src/client/userLayer.tsx'

afterEach(cleanup)

const W: UserLayerWidgetView = { id: 'notes', name: '随手记', status: 'ok', replaces: 'notes', export: 'NotesModule', rev: 'aaaaaaaaaaaa' }
const CODE = `
const { jsx } = require('react/jsx-runtime')
function NotesModule(props) { return jsx('p', { children: '她的随手记' }) }
module.exports = { NotesModule }
`

function view(...widgets: UserLayerWidgetView[]): UserLayerStateView {
  return { contract: 1, widgets }
}

function Cell({ registry }: { registry: UserLayerRegistry }) {
  return createElement(UserLayerCell, {
    registry,
    slot: 'notes',
    templateId: undefined,
    props: {},
    fallback: (problem?: string, retry?: () => void) => createElement('div', null,
      createElement('p', null, `本体那一版${problem === undefined ? '' : `(${problem})`}`),
      retry === undefined ? null : createElement('button', { onClick: retry }, '再试一次')),
    pending: createElement('p', null, '等一下'),
    retrying: (message: string) => createElement('p', null, message),
  })
}

describe('没取到(超时 / 网络 / 非 200):退避重试,不是直接算坏', () => {
  it('★第一次取代码超时:那一格是「重试中」的文案、不是 failed;5 秒后 fetch 再被调一次,成功 → 装上', async () => {
    vi.useFakeTimers()
    try {
      const registry = createUserLayerRegistry()
      let release: (code: string) => void = () => {}
      const asked: string[] = []
      const load = (widget: UserLayerWidgetView): Promise<string> => {
        asked.push(widget.rev ?? '')
        return new Promise((resolve) => { release = resolve })
      }
      await act(async () => { registry.sync(view(W), load) })
      render(<Cell registry={registry} />)
      expect(screen.getByText('等一下')).toBeTruthy()
      // 8 秒没取到:不是 failed,是「重试中」,也不往问题清单里记。
      await act(async () => { await vi.advanceTimersByTimeAsync(USER_LAYER_LOAD_TIMEOUT_MS) })
      expect(screen.getByText('工作台这会儿忙,随手记稍等接上(第 1 次重试)')).toBeTruthy()
      expect(registry.problems().size).toBe(0)
      // 5 秒后自动再取一次,这次取到了 → 装上。
      await act(async () => { await vi.advanceTimersByTimeAsync(USER_LAYER_FETCH_RETRY_DELAYS_MS[0]) })
      expect(asked).toHaveLength(2)
      await act(async () => { release(CODE) })
      expect(screen.getByText('她的随手记')).toBeTruthy()
    }
    finally { vi.useRealTimers() }
  })

  it('★取到代码但执行抛错:failed,不重试(原行为)', async () => {
    vi.useFakeTimers()
    try {
      const registry = createUserLayerRegistry()
      let calls = 0
      await act(async () => {
        registry.sync(view(W), async () => { calls += 1; return 'function (' })
      })
      render(<Cell registry={registry} />)
      // 跑过远超全部退避的时间:一次都没再取。
      await act(async () => { await vi.advanceTimersByTimeAsync(10 * 60_000) })
      expect(calls).toBe(1)
      expect(registry.problems().get('notes')).toContain('运行出错')
      expect(screen.getByText(/本体那一版/)).toBeTruthy()
      // 代码坏不给「再试一次」(改了文件指纹变,它自己会重取)。
      expect(screen.queryByText('再试一次')).toBeNull()
    }
    finally { vi.useRealTimers() }
  })

  it('★重试用尽:failed + 「再试一次」键,点了再取一次', async () => {
    vi.useFakeTimers()
    try {
      const registry = createUserLayerRegistry()
      let calls = 0
      const fail = async (): Promise<string> => { calls += 1; throw new Error('网络不通') }
      await act(async () => { registry.sync(view(W), fail) })
      render(<Cell registry={registry} />)
      // 初取 + 5 次退避(5 / 15 / 45 / 45 / 45 秒)全部跑完。
      await act(async () => { await vi.advanceTimersByTimeAsync(10 * 60_000) })
      expect(calls).toBe(1 + USER_LAYER_FETCH_RETRY_MAX)
      expect(registry.problems().get('notes')).toMatch(/读不到/)
      // 这时才算「没装上」,并给「再试一次」键。
      expect(screen.getByText(/本体那一版/)).toBeTruthy()
      expect(screen.getByText('再试一次')).toBeTruthy()
      // 点了再取一次:取不到就回到「重试中」,不是死在地上。
      await act(async () => { fireEvent.click(screen.getByText('再试一次')) })
      expect(calls).toBe(2 + USER_LAYER_FETCH_RETRY_MAX)
      expect(screen.getByText('工作台这会儿忙,随手记稍等接上(第 1 次重试)')).toBeTruthy()
    }
    finally { vi.useRealTimers() }
  })

  it('重试中清单同一指纹再来:不重置重试,接着等', async () => {
    vi.useFakeTimers()
    try {
      const registry = createUserLayerRegistry()
      let calls = 0
      const fail = async (): Promise<string> => { calls += 1; throw new Error('网络不通') }
      await act(async () => { registry.sync(view(W), fail) })
      // 第一败 → 第 1 次重试排定;同一指纹再 sync 几次,不另起一摊。
      await act(async () => { await vi.advanceTimersByTimeAsync(USER_LAYER_LOAD_TIMEOUT_MS) })
      await act(async () => { registry.sync(view(W), fail) })
      await act(async () => { registry.sync(view(W), fail) })
      await act(async () => { await vi.advanceTimersByTimeAsync(10 * 60_000) })
      expect(calls).toBe(1 + USER_LAYER_FETCH_RETRY_MAX)
    }
    finally { vi.useRealTimers() }
  })
})

describe('失败态的两种重取口子(2026-10-28 卡第 2 条)', () => {
  function Sync({ registry, widget, baseUrl, fetchImpl }: {
    registry: UserLayerRegistry
    widget: UserLayerWidgetView
    baseUrl: string
    fetchImpl: typeof fetch
  }) {
    useUserLayerSync(registry, view(widget), baseUrl, fetchImpl)
    return null
  }

  it('页面重新可见(visibilitychange):取不到重试用尽的那一格重取一次', async () => {
    vi.useFakeTimers()
    try {
      const registry = createUserLayerRegistry()
      let codeCalls = 0
      const fetchImpl = (async (input: unknown) => {
        if (String(input).includes('/user-layer/report')) return new Response('{"ok":true}')
        codeCalls += 1
        return new Response('no', { status: 500 })
      }) as typeof fetch
      render(<Sync registry={registry} widget={W} baseUrl="http://x" fetchImpl={fetchImpl} />)
      await act(async () => { await vi.advanceTimersByTimeAsync(10 * 60_000) })
      expect(codeCalls).toBe(1 + USER_LAYER_FETCH_RETRY_MAX)
      expect(registry.problems().get('notes')).toMatch(/读不到/)
      // 页面重新可见 → 重取一次(工作台那会儿忙,不是她的代码坏)。
      await act(async () => {
        document.dispatchEvent(new Event('visibilitychange'))
        await Promise.resolve()
      })
      expect(codeCalls).toBe(2 + USER_LAYER_FETCH_RETRY_MAX)
    }
    finally { vi.useRealTimers() }
  })

  it('重试用尽后清单里这一格的指纹变了:重取(原有「指纹变了重取」盖住失败态)', async () => {
    vi.useFakeTimers()
    try {
      const registry = createUserLayerRegistry()
      let calls = 0
      const fail = async (): Promise<string> => { calls += 1; throw new Error('网络不通') }
      await act(async () => { registry.sync(view(W), fail) })
      await act(async () => { await vi.advanceTimersByTimeAsync(10 * 60_000) })
      expect(calls).toBe(1 + USER_LAYER_FETCH_RETRY_MAX)
      await act(async () => { registry.sync(view({ ...W, rev: 'bbbbbbbbbbbb' }), fail) })
      expect(calls).toBe(2 + USER_LAYER_FETCH_RETRY_MAX)
    }
    finally { vi.useRealTimers() }
  })
})
