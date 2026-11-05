/**
 * 工作台可读性 · 整版样张页(2026-10-21)。挂的是真的 `WorkbenchOverlay`(产品研发布局),
 * `/state` 等接口由下面的假 fetch 答,数全是 fixture.ts 里编的 —— 不读 8791、不读任何真账。
 *
 *   ?theme=dark       深色主题(宿主那套 body[data-ds-dark-theme])
 *   ?ben-workbench=app 壳模式(维护者日常那一种:顶栏左边让红绿灯、没有「返回对话」)
 *   ?v=a / ?v=b       盖上样张 A / B 的原型层(aStyle.ts + aText.ts + aFold.ts)
 *   ?template=ops     同一份夹具换成自媒体布局(核对原型层在那边一条都不生效)
 */
import { createRoot } from 'react-dom/client'
import '../../../../deepseek-harness/packages/client/ui-theme/src/styles/base.css'
import '../../../../deepseek-harness/packages/client/ui-theme/src/styles/design-platform.css'
import { WorkbenchOverlay, type MinimalWebSocket, type WorkbenchOverlayProps } from '../../src/client/Workbench.tsx'
import { createWorkbenchStore } from '../../src/client/store.ts'
import { AGENT_REGISTRY, HABITS, RULES, STATE } from './fixture.ts'
import { COLLAB_EXTRA, COLLAB_GOALS, COLLAB_TASKS } from './collabFixture.ts'
import { A_STYLE, B_DELTA } from './aStyle.ts'
import { applyAText } from './aText.ts'
import { FOLD_STYLE, applyAFold } from './aFold.ts'
import notesCode from '../../../user-layer/起步/小组件/notes/index.js?raw'
import filesCode from '../../../user-layer/起步/小组件/files/index.js?raw'

const query = new URLSearchParams(location.search)
if (query.get('theme') === 'dark') document.body.setAttribute('data-ds-dark-theme', '')

// ?template=ops:同一份夹具换成自媒体布局,核对样张那一层在那边一条都不生效。
// ?icons=1:顶栏各家 logo(登记表 + 本机图标,见 vite.config.mjs)
const withIcons = query.get('icons') === '1' ? { ...STATE, agent_registry: AGENT_REGISTRY } as typeof STATE : STATE
// ?collab=project|slot:协作区的假数据(collabFixture.ts),载入后点开项目区那格 / 窗口槽那一格
const collabMode = query.get('collab')
const base = collabMode === null ? withIcons : {
  ...withIcons, ...COLLAB_EXTRA,
  tasks: { ...withIcons.tasks, tasks: COLLAB_TASKS, goals: COLLAB_GOALS, goal_sprints: [], agent_cards: [] },
} as typeof STATE
// ?place=one|many|none:他直接开的会话放进目标的三态(10-22 第三轮 4 截图用;编的)
const placeMode = query.get('place')
const PROPOSAL = { agent: 'claude', session_id: 's-demo', title: '座机铃声换一版', at: '2026-10-21T04:00:00.000Z' }
const placedBase = placeMode === null || collabMode === null ? base : {
  ...base,
  tasks: {
    ...base.tasks,
    ...(placeMode === 'one'
      ? {
          goals: COLLAB_GOALS.slice(0, 1),
          tasks: [...COLLAB_TASKS, { id: 't-demo', title: PROPOSAL.title, status: 'doing', assignee: 'claude', goal_id: 'g1', links: [{ agent: 'claude', session_id: 's-demo' }], source: { kind: 'session', ref: 'claude:s-demo' }, created_at: PROPOSAL.at, updated_at: PROPOSAL.at }],
          session_placed: [{ ...PROPOSAL, task_id: 't-demo', goal_id: 'g1' }],
        }
      : placeMode === 'many'
        ? { session_proposals: [{ ...PROPOSAL, goal_id: 'g1' }] }
        : { goals: [], session_proposals: [{ ...PROPOSAL, new_goal_title: PROPOSAL.title }] }),
  },
} as typeof STATE
const templated = query.get('template') === 'ops'
  ? { ...placedBase, template: { ...placedBase.template, id: 'ops', name: '自媒体运营' } } as typeof STATE
  : placedBase
// 随手记、系统文件夹是用户层的小组件(本体只有加载口):样张页把起步层那两份原样端出来,两格才画得出来(2026-10-22 对照评审页用)。
const STARTER: Record<string, string> = { notes: notesCode, files: filesCode }
const state = {
  ...templated,
  user_layer: { contract: 1, widgets: Object.keys(STARTER).map(id => ({ id, name: id, status: 'ok', replaces: id, export: id === 'notes' ? 'NotesModule' : 'FilesModule', contract: 1, rev: 'sample' })) },
} as typeof STATE
const json = (body: unknown): Response => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })
const serviceFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = String(input)
  if (init?.method !== undefined && init.method !== 'GET') return json({ ok: true })
  if (/\/state(\?|$)/.test(url)) return json(state)
  if (/\/habits(\?|$)/.test(url)) return json(HABITS)
  if (/\/butler\/rules(\?|$)/.test(url)) return json(RULES)
  const widget = /\/user-layer\/widgets\/([^/]+)\/code/.exec(url)?.[1]
  if (widget !== undefined && STARTER[widget] !== undefined) return new Response(STARTER[widget], { status: 200, headers: { 'content-type': 'text/javascript' } })
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
  serviceBaseUrl: query.get('icons') === '1' ? '' : 'http://sample.invalid',
  serviceFetch,
  servicePollMs: 0,
  serviceWebSocket: (): MinimalWebSocket => ({ onmessage: null, onclose: null, close: () => {} }),
} as WorkbenchOverlayProps

// 样张 A / B 的原型层挂在 body 末尾、#root **之后**:工作台自己那张样式表在 #root 里的 `<main>` 中,
// 文档顺序上永远在前,同特异度时这一层赢。
const variant = query.get('v')
const style = document.createElement('style')
style.textContent = `html,body{margin:0;height:100%;background:var(--dsw-alias-bg-base)}\n${
  variant === 'a' ? `${A_STYLE}\n${FOLD_STYLE}` : variant === 'b' ? `${A_STYLE}\n${B_DELTA}\n${FOLD_STYLE}` : ''}`
document.body.appendChild(style)
createRoot(document.getElementById('root')!).render(<WorkbenchOverlay {...props} />)
if (variant === 'a' || variant === 'b') {
  applyAText()
  applyAFold()
}
// ?settings=1:载入后点一下齿轮,截设置页用(2026-10-21 视觉 A)。
if (query.get('settings') === '1') {
  setTimeout(() => document.querySelector<HTMLButtonElement>('.ben-wb__topgear')?.click(), 800)
  // &group=<组名>:再切到那一组
  const group = query.get('group')
  if (group !== null) setTimeout(() => [...document.querySelectorAll<HTMLButtonElement>('[role=tab]')].find(one => one.textContent === group)?.click(), 1200)
}

if (collabMode !== null) {
  const click = (scope: string, text: string): void => { [...document.querySelectorAll<HTMLButtonElement>(`${scope} button`)].find(one => one.textContent?.trim() === text)?.click() }
  setTimeout(() => {
    if (collabMode === 'project') click('.ben-wb__projects .ben-wb__viewswitch', '协作区')
    else click('.ben-wb__dock', '协作区')
  }, 900)
}
