/**
 * 用户层真跑 · 页面(2026-10-21)。挂真的 `WorkbenchOverlay`,自媒体布局;看板上的数据是
 * `dev/readability-sample/fixture.ts` 那一份编的,再补几条选题与发布计划。**用户层那几条路**
 * (`/state.user_layer`、`/user-layer*`)经 vite 代理打到 server.ts 起的那台真服务。
 *
 *   ?orient=portrait   竖屏布局(缺省横屏)
 *   ?theme=dark        深色
 *
 * 对照「搬家之前」:同一个页面用 `FIG_REF=<main 的提交>` 起(src 整个从那个提交读,
 * 那时六格还编在本体里),两边量同一块 DOM。
 */
import { createRoot } from 'react-dom/client'
import '../../../../deepseek-harness/packages/client/ui-theme/src/styles/base.css'
import '../../../../deepseek-harness/packages/client/ui-theme/src/styles/design-platform.css'
import type { LayoutModule, TaskView, WorkbenchState } from '../../src/protocol.ts'
import { DEFAULT_MODULE_TITLES, PRODUCT_TEMPLATE } from '../../src/templates.ts'
import { WorkbenchOverlay, type MinimalWebSocket, type WorkbenchOverlayProps } from '../../src/client/Workbench.tsx'
import { createWorkbenchStore } from '../../src/client/store.ts'
import { NOW, STATE } from '../readability-sample/fixture.ts'

const query = new URLSearchParams(location.search)
if (query.get('theme') === 'dark') document.body.setAttribute('data-ds-dark-theme', '')

/**
 * ?tpl=product:同一页、同一份真实服务与小组件,横竖网格与模板视图换「做产品」那一套
 * (product 仍在本体)。随手记 / 素材管理两格的用户层小组件两种模板下都生效,这一档
 * 就是拿来对照这两格的(2026-10-23,分层二刀二 monoStyle 搬迁的截图对照)。
 */
const AS_PRODUCT = query.get('tpl') === 'product'
const TEMPLATE_VIEW = AS_PRODUCT
  ? {
      id: PRODUCT_TEMPLATE.id,
      name: PRODUCT_TEMPLATE.name,
      project_word: PRODUCT_TEMPLATE.project_word,
      project_empty_line: PRODUCT_TEMPLATE.project_empty_line,
      module_titles: { ...DEFAULT_MODULE_TITLES },
      board_lanes: [],
      has_backup: false,
    }
  : undefined

/**
 * 起步层那一份真布局(2026-10-23,分层二刀二):本体不再内置 OPS_TEMPLATE,横竖两份模块
 * 从仓库 `user-layer/起步/布局/ops.json` 运行时读(数据与 skin 同源)。vite root 在本目录,
 * 仓库里的文件走 `/@fs`;两份都试,哪条通走哪条。
 */
async function starterOpsModules(): Promise<{ portrait: LayoutModule[], landscape: LayoutModule[] }> {
  const at = new URL('../../../user-layer/起步/布局/ops.json', import.meta.url).pathname
  for (const url of [at, `/@fs${at}`]) {
    try {
      const res = await fetch(url)
      if (res.ok) {
        const raw = await res.json() as { portrait: LayoutModule[], landscape: LayoutModule[] }
        return { portrait: raw.portrait, landscape: raw.landscape }
      }
    }
    catch { /* 试下一条路 */ }
  }
  throw new Error(`起步层 布局/ops.json 取不到(${at} 与 /@fs 都不行)`)
}

/** 真服务那一份 /state 里取 user_layer 与 template(它别的都没接)。没起(搬家之前那一侧)就当没有。 */
async function realState(): Promise<{ user_layer?: unknown, template?: unknown }> {
  try { return await (await fetch('/wb/state')).json() as { user_layer?: unknown, template?: unknown } }
  catch { return {} }
}

const topic = (id: string, title: string, stage: string, extra: Partial<TaskView> = {}): TaskView => ({
  id, title, status: 'todo', kind: 'topic', stage, project_id: 'p-1', created_at: NOW, updated_at: NOW, ...extra,
} as unknown as TaskView)
const TOPICS: TaskView[] = [
  topic('tp1', '国庆出游,3 个值得拍的镜头', '构思', { content_type: '视频' } as never),
  topic('tp2', '一周穿搭复盘', '脚本', { due: '2026-10-23' } as never),
  topic('tp3', '新品开箱', '待发布', { due: '2026-10-22', publish_on: '2026-10-22' } as never),
]
const STATE_BASE = {
  ...STATE,
  projects: { projects: [{ id: 'p-1', name: '小红书主号', stage: '运营中', links: [], session_count: 0, idle: false }], pending: [], scan_errors: [], scanned_at: NOW },
  tasks: { ...(STATE.tasks as object), tasks: [...((STATE.tasks as { tasks: TaskView[] }).tasks), ...TOPICS] },
} as unknown as WorkbenchState

const json = (body: unknown): Response => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })
const serviceFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = new URL(String(input))
  if (url.pathname.startsWith('/user-layer')) return await fetch(`/wb${url.pathname}${url.search}`, init)
  if (init?.method !== undefined && init.method !== 'GET') return json({ ok: true })
  if (url.pathname === '/state') {
    // template / user_layer 用真服务经真实注入回来的那份;横竖 modules 与 skin 起步层那份真文件。
    // 皮肤不用在这里塞:useUserLayerSkin 见 user_layer.layouts 里有 skin_rev,自己去
    // /user-layer/layouts/ops/skin 取(上面那条代理打到真服务)。
    const [real, starter] = await Promise.all([realState(), starterOpsModules()])
    return json({
      ...STATE_BASE,
      // product 档:模板视图也用 product 那份(real 那份是 ops);ops 档照旧用真服务注入的。
      ...(AS_PRODUCT
        ? { template: TEMPLATE_VIEW }
        : real.template === undefined ? {} : { template: real.template }),
      ...(real.user_layer === undefined ? {} : { user_layer: real.user_layer }),
      layout: {
        modules: (AS_PRODUCT ? PRODUCT_TEMPLATE.portrait : starter.portrait).map(m => ({ ...m })),
        butler: { corner: 'br', min: false },
        landscape: { modules: (AS_PRODUCT ? PRODUCT_TEMPLATE.landscape : starter.landscape).map(m => ({ ...m })) },
      },
    })
  }
  return json({})
}) as typeof fetch

const instance = createWorkbenchStore().create()
const workspaceState = { items: [], phase: 'ready', archivedSessionIds: [], state: 'idle', error: null, baselinesReady: true, recentWorkspaceId: undefined }
const unused = (() => undefined) as never
const props: WorkbenchOverlayProps = {
  useStore: selector => selector(instance.getSnapshot()),
  actions: instance.actions,
  useWorkspaces: selector => selector(workspaceState as never),
  useSessions: selector => selector({} as never),
  usePanelInfo: unused,
  useSessionStatus: unused,
  useSessionRetainInfo: unused,
  openWorkspace: async () => {},
  openSession: () => {},
  serviceBaseUrl: 'http://sample.invalid',
  serviceFetch,
  servicePollMs: 0,
  serviceWebSocket: (): MinimalWebSocket => ({ onmessage: null, onclose: null, close: () => {} }),
} as WorkbenchOverlayProps

const style = document.createElement('style')
style.textContent = 'html,body{margin:0;height:100%;background:var(--dsw-alias-bg-base)}'
document.body.appendChild(style)
createRoot(document.getElementById('root')!).render(<WorkbenchOverlay {...props} />)
