/**
 * 布局模板的那一层皮肤**从用户层装上**(2026-10-23,卡「分层第二刀(二)」)。
 *
 * 本体不再内置任何模板皮肤(`client/opsThemeStyle.ts` 已删):页面按
 * `/state.user_layer.layouts` 里当前模板的那份 `skin_rev` 去
 * `GET /user-layer/layouts/<id>/skin` 取 css;取不到 / 没带皮肤就**什么都不注入**。
 *
 * 指纹(rev)是缓存键:同一份不发第二次请求;她改了文件(指纹变)就重取。
 */
import '@testing-library/jest-dom/vitest'
import { cleanup, render, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { WorkbenchOverlay, type MinimalWebSocket, type WorkbenchOverlayProps } from '../src/client/Workbench.tsx'
import { useUserLayerSkin } from '../src/client/userLayer.tsx'
import { createWorkbenchStore } from '../src/client/store.ts'
import type { TemplateStateView, UserLayerStateView, WorkbenchState } from '../src/protocol.ts'
import { UNUSED_STANDARD_PROPS } from './helpers/standardProps.ts'

afterEach(cleanup)

/** 见 workbenchLayout.test.tsx 顶部注释:不喂假 WS 会真的去连 8791 端口。 */
function fakeWebSocket(): (url: string) => MinimalWebSocket {
  return () => ({ onmessage: null, onclose: null, close: () => {} })
}

const SKIN_A = '/* 皮肤甲 */.ben-wb[data-template=ops]{--probe-skin-a:1}'
const SKIN_B = '/* 皮肤乙 */.ben-wb[data-template=ops]{--probe-skin-b:1}'

/** 布局清单:ops 带皮肤(指纹可换),product 不带。 */
function layerView(skinRev: string | undefined): UserLayerStateView {
  return {
    contract: 1,
    widgets: [],
    layouts: [
      { id: 'ops', name: '自媒体运营', status: 'ok', rev: 'tpl000000001', ...(skinRev === undefined ? {} : { skin_rev: skinRev }) },
    ],
  }
}

/** 打皮肤路由的 fetch:/skin 回 css 文本,别的请求回服务端快照(Workbench 轮询 /state 用)。 */
function fetchWithSkin(css: string, state?: unknown, opts: { ok?: boolean } = {}): typeof fetch {
  return vi.fn(async (input: unknown) => {
    const url = String(input)
    if (url.includes('/user-layer/layouts/') && url.includes('/skin')) {
      if (opts.ok === false) return { ok: false, status: 404, text: async () => '' } as Response
      return { ok: true, status: 200, text: async () => css } as Response
    }
    return { ok: true, status: 200, json: async () => ({ ...(state as object) }) } as Response
  }) as unknown as typeof fetch
}

function SkinProbe({ view, templateId, baseUrl, fetchImpl }: {
  view: UserLayerStateView | undefined
  templateId: string | undefined
  baseUrl: string
  fetchImpl: typeof fetch
}) {
  const css = useUserLayerSkin(view, templateId, baseUrl, fetchImpl)
  return <div data-testid="skin">{css ?? '∅'}</div>
}

describe('useUserLayerSkin(钩子)', () => {
  it('清单里当前模板带皮肤 → 去取,回 css 原文', async () => {
    const fetchImpl = fetchWithSkin(SKIN_A)
    const { getByTestId } = render(
      <SkinProbe view={layerView('rev000000001')} templateId="ops" baseUrl="http://x" fetchImpl={fetchImpl} />,
    )
    await waitFor(() => { expect(getByTestId('skin').textContent).toBe(SKIN_A) })
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    expect(String(vi.mocked(fetchImpl).mock.calls[0]?.[0])).toBe('http://x/user-layer/layouts/ops/skin?rev=rev000000001')
  })

  it('同一个指纹走缓存:重渲染(换视图对象)不再发请求', async () => {
    const fetchImpl = fetchWithSkin(SKIN_A)
    const first = render(<SkinProbe view={layerView('rev000000002')} templateId="ops" baseUrl="http://x" fetchImpl={fetchImpl} />)
    await waitFor(() => { expect(first.getByTestId('skin').textContent).toBe(SKIN_A) })
    first.rerender(<SkinProbe view={layerView('rev000000002')} templateId="ops" baseUrl="http://x" fetchImpl={fetchImpl} />)
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  it('指纹变(她改了皮肤文件)→ 重取新的一份', async () => {
    const fetchImpl = fetchWithSkin(SKIN_B)
    const { getByTestId, rerender } = render(
      <SkinProbe view={layerView('rev000000003')} templateId="ops" baseUrl="http://x" fetchImpl={fetchImpl} />,
    )
    await waitFor(() => { expect(getByTestId('skin').textContent).toBe(SKIN_B) })
    // 指纹变了 → 新的一份(这里 mock 对任何指纹都回皮肤乙,数请求次数就行)。
    rerender(<SkinProbe view={layerView('rev000000004')} templateId="ops" baseUrl="http://x" fetchImpl={fetchImpl} />)
    await waitFor(() => { expect(vi.mocked(fetchImpl).mock.calls.length).toBe(2) })
  })

  it('取失败 / 没带皮肤 / 模板坏了 → 回 undefined,不嚷嚷', async () => {
    const failing = fetchWithSkin('', undefined, { ok: false })
    const { getByTestId } = render(
      <SkinProbe view={layerView('rev000000005')} templateId="ops" baseUrl="http://x" fetchImpl={failing} />,
    )
    await waitFor(() => { expect(vi.mocked(failing).mock.calls.length).toBe(1) })
    expect(getByTestId('skin').textContent).toBe('∅')
    // 没带皮肤的模板(做产品)连请求都不发。
    const spare = fetchWithSkin(SKIN_A)
    const productProbe = render(<SkinProbe view={layerView('rev000000006')} templateId="product" baseUrl="http://x" fetchImpl={spare} />)
    expect(vi.mocked(spare).mock.calls.length).toBe(0)
    expect(productProbe.container.querySelector('[data-testid=skin]')?.textContent).toBe('∅')
    // 清单里没有这一块(老服务端)也是 undefined。
    const bareProbe = render(<SkinProbe view={{ contract: 1, widgets: [] }} templateId="ops" baseUrl="http://x" fetchImpl={spare} />)
    expect(bareProbe.container.querySelector('[data-testid=skin]')?.textContent).toBe('∅')
  })
})

function templateView(id: string): TemplateStateView {
  return { id, name: id, project_word: '项目', project_empty_line: '', module_titles: {}, board_lanes: [], has_backup: false } as TemplateStateView
}

function snapshot(template: TemplateStateView | undefined, userLayerView: UserLayerStateView | undefined): WorkbenchState {
  return {
    agents: [], sessions: [], quota: {}, stale: false, now: '2026-10-23T10:00:00+08:00',
    ...(template === undefined ? {} : { template }),
    ...(userLayerView === undefined ? {} : { user_layer: userLayerView }),
  } as WorkbenchState
}

function props(template: TemplateStateView | undefined, userLayerView: UserLayerStateView | undefined, css: string): WorkbenchOverlayProps {
  const state = snapshot(template, userLayerView)
  const instance = createWorkbenchStore().create()
  const workspaceState = { items: [], phase: 'ready', archivedSessionIds: [], state: 'idle', error: null, baselinesReady: true, recentWorkspaceId: undefined }
  return {
    useStore: selector => selector(instance.getSnapshot()),
    actions: instance.actions,
    useWorkspaces: selector => selector(workspaceState as never),
    useSessions: selector => selector({} as never),
    ...UNUSED_STANDARD_PROPS,
    openWorkspace: async () => {},
    openSession: () => {},
    serviceFetch: fetchWithSkin(css, state) as unknown as typeof fetch,
    servicePollMs: 0,
    serviceWebSocket: fakeWebSocket(),
  }
}

describe('Workbench 那一处注入点', () => {
  it('ops 模板 + 用户层带了皮肤 → 页面出现 <style>,内容就是那份 css', async () => {
    const { container } = render(
      <WorkbenchOverlay {...props(templateView('ops'), layerView('rev000000101'), SKIN_A)} />,
    )
    await waitFor(() => {
      const sheets = [...container.querySelectorAll('style')].map(one => one.textContent ?? '')
      expect(sheets.some(text => text.includes('--probe-skin-a'))).toBe(true)
    })
  })

  it('ops 模板但用户层没带皮肤 → 不注入那一层(本体里没有内置的了)', async () => {
    const { container } = render(
      <WorkbenchOverlay {...props(templateView('ops'), layerView(undefined), SKIN_A)} />,
    )
    await waitFor(() => {
      const root = container.querySelector('main.ben-wb')
      expect(root).not.toBeNull()
    })
    const sheets = [...container.querySelectorAll('style')].map(one => one.textContent ?? '')
    expect(sheets.some(text => text.includes('--probe-skin'))).toBe(false)
  })

  it('做产品模板 → 不注入(她那一份皮肤落不到这一档上)', async () => {
    const { container } = render(
      <WorkbenchOverlay {...props(templateView('product'), layerView('rev000000102'), SKIN_A)} />,
    )
    await waitFor(() => {
      const root = container.querySelector('main.ben-wb')
      expect(root).not.toBeNull()
    })
    const sheets = [...container.querySelectorAll('style')].map(one => one.textContent ?? '')
    expect(sheets.some(text => text.includes('--probe-skin'))).toBe(false)
  })
})
