/**
 * ★ 2026-10-04:黑紫主题的**作用域那一格**真的写在 DOM 上了。
 *
 * 样式那一侧由 `client-ops-theme-scope` 逐条核对(每条选择器都带 `[data-template=ops]`);
 * 这一份管另一半:`.ben-wb` 上的 `data-template` 从 `/state.template.id` 来,
 * **模板整块缺席就不写这一格** —— 缺席按缺省模板(product)算,于是展示台、手机、老客户端、
 * 一大批用例里那一层整个匹配不到,与加它之前逐字相同。
 */
import '@testing-library/jest-dom/vitest'
import { cleanup, render, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { WorkbenchOverlay, type MinimalWebSocket, type WorkbenchOverlayProps } from '../src/client/Workbench.tsx'
import { createWorkbenchStore } from '../src/client/store.ts'
import type { TemplateStateView, UserLayerStateView, WorkbenchState } from '../src/protocol.ts'
import { PRODUCT_TEMPLATE } from '../src/templates.ts'
import { UNUSED_STANDARD_PROPS } from './helpers/standardProps.ts'

/** 起步层那一份真皮肤(用户层 布局/ops.css;本体不内置了)。 */
const OPS_SKIN = '/* 测试 */.ben-wb[data-template=ops]{--wb-ops-line:1}'

afterEach(cleanup)

/** 见 workbenchLayout.test.tsx 顶部注释:不喂假 WS 会真的去连 8791 端口。 */
function fakeWebSocket(): (url: string) => MinimalWebSocket {
  return () => ({ onmessage: null, onclose: null, close: () => {} })
}

function templateView(id: string): TemplateStateView {
  return { id, name: id, project_word: '项目', project_empty_line: '', module_titles: {}, board_lanes: [], has_backup: false } as TemplateStateView
}

/** 用户层清单:ops 带皮肤指纹;product 不带。 */
function userLayerView(withSkin: boolean): UserLayerStateView {
  return {
    contract: 1,
    widgets: [],
    layouts: [
      { id: 'ops', name: '自媒体运营', status: 'ok', rev: 'rev00000000a', ...(withSkin ? { skin_rev: 'rev00000000b' } : {}) },
    ],
  }
}

function snapshot(template: TemplateStateView | undefined, userLayer: UserLayerStateView | undefined): WorkbenchState {
  return {
    agents: [], sessions: [], quota: {}, stale: false, now: '2026-10-04T10:00:00+08:00',
    ...(template === undefined ? {} : { template }),
    ...(userLayer === undefined ? {} : { user_layer: userLayer }),
  } as WorkbenchState
}

function props(state: WorkbenchState): WorkbenchOverlayProps {
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
    // 2026-10-23(分层二刀二):皮肤从用户层路由取;/skin 回 css,别的照旧回状态快照。
    serviceFetch: vi.fn(async (input: unknown) => {
      const url = String(input)
      if (url.includes('/user-layer/layouts/') && url.includes('/skin')) {
        return { ok: true, status: 200, text: async () => OPS_SKIN } as Response
      }
      return { ok: true, json: async () => ({ ...state }) } as Response
    }) as unknown as typeof fetch,
    servicePollMs: 0,
    serviceWebSocket: fakeWebSocket(),
  }
}

/**
 * 第一帧渲染的是本地那一份(还没轮询,`/state.template` 还没到),所以这一格要**等**
 * —— 同 client-notes-files 那条老规矩:先等服务端快照落定再断言。
 *
 * 皮肤那一层 2026-10-23 起从用户层 `/state.user_layer.layouts` + `/user-layer/layouts/<id>/skin`
 * 装进(见 client/userLayer.tsx 的 useUserLayerSkin):themed = 当前模板在用户层**带了皮肤**
 * 且取到了 css。
 */
async function expectScope(template: TemplateStateView | undefined, want: string | null, userLayer: UserLayerStateView | undefined, themed: boolean): Promise<void> {
  const { container } = render(<WorkbenchOverlay {...props(snapshot(template, userLayer))} />)
  await waitFor(() => {
    const root = container.querySelector('main.ben-wb')
    expect(root).not.toBeNull()
    expect(root?.getAttribute('data-template')).toBe(want)
    // 判「整层有没有装上」照旧看它的变量名(`--wb-ops-*`)。
    const sheets = [...container.querySelectorAll('style')].map(one => one.textContent ?? '')
    expect(sheets.some(text => text.includes('--wb-ops-'))).toBe(themed)
  })
}

describe('.ben-wb 上的 data-template', () => {
  it('自媒体(运营)模板 + 用户层带了皮肤 → 写 ops,那一层经加载口装上', async () => {
    await expectScope(templateView('ops'), 'ops', userLayerView(true), true)
  })

  it('自媒体模板但用户层没带皮肤 → 写 ops,不注入那一层(本体没有内置的了)', async () => {
    await expectScope(templateView('ops'), 'ops', userLayerView(false), false)
  })

  it('产品研发模板 → 写 product,那一层一条都匹配不到', async () => {
    await expectScope(templateView(PRODUCT_TEMPLATE.id), PRODUCT_TEMPLATE.id, userLayerView(true), false)
  })

  it('模板整块缺席 → 这一格不写(缺席按缺省模板算,缺省就是产品研发)', async () => {
    await expectScope(undefined, null, userLayerView(true), false)
  })
})
