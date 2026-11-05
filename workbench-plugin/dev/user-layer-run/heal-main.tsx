/**
 * 用户层自愈 · 真实浏览器验收那一页(2026-10-23,卡「分层自愈完善」补验收)。
 *
 * 不另写一套假组件:挂的就是真的 `UserLayerPanel`(设置 →「这台电脑」→「用户层」那一节)
 * 与真的 `UserLayerCell` + `useUserLayerSync`(页面装小组件那条 React 路),经 vite 代理 `/wb`
 * 打到 `heal-check.ts` 起的那台真 `WorkbenchServer`。驱动脚本(chromium CDP)在这一页里点
 * 「选回这一版」、看格子退回与换上,证明 UI 与真 HTTP 接线可用 —— 不留维护者手点。
 */
import { useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import type { UserLayerStateView } from '../../src/protocol.ts'
import { UserLayerCell, createUserLayerRegistry, useUserLayerSync, type UserLayerRegistry } from '../../src/client/userLayer.tsx'
import { UserLayerPanel } from '../../src/client/UserLayerPanel.tsx'

const BASE = '/wb'

/** 真 fetch 外面包一层:把 /user-layer/report 的请求体记在窗口上,驱动脚本拿来数「报过几次」。 */
const watchedFetch: typeof fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
  const url = String(input)
  if (url.includes('/user-layer/report')) {
    try { window.__reports.push(JSON.parse(String(init?.body))) }
    catch { /* 记不上不影响真上报 */ }
  }
  return fetch(input, init)
}) as typeof fetch

const registry: UserLayerRegistry = createUserLayerRegistry()

/** 真的那一格:按 /state.user_layer 经 useUserLayerSync 取代码、求值、挂载、上报。 */
function FilesCell({ view }: { view: UserLayerStateView | undefined }) {
  useUserLayerSync(registry, view, BASE, watchedFetch)
  return (
    <UserLayerCell
      registry={registry}
      slot="files"
      templateId={undefined}
      props={{ title: '素材' }}
      fallback={(problem?: string) => <p data-fallback>{`本体那一版${problem === undefined ? '' : `(${problem})`}`}</p>}
      pending={<p data-pending>等一下</p>}
    />
  )
}

function App() {
  const [view, setView] = useState<UserLayerStateView | undefined>(undefined)
  useEffect(() => {
    let alive = true
    const pull = async (): Promise<void> => {
      try {
        const res = await fetch(`${BASE}/state`)
        const state = await res.json() as { user_layer?: UserLayerStateView }
        if (!alive) return
        window.__states.push(state.user_layer)
        if (window.__states.length > 50) window.__states.shift()
        setView(state.user_layer)
      }
      catch { /* 服务重启那一下读不到,下一拍再来 */ }
    }
    void pull()
    const timer = setInterval(() => { void pull() }, 700)
    return () => { alive = false; clearInterval(timer) }
  }, [])
  return (
    <div>
      <h3>真实格子(files 槽)</h3>
      <div data-cell>{view === undefined ? <p data-pending>等一下</p> : <FilesCell view={view} />}</div>
      <h3>真实设置节</h3>
      <UserLayerPanel baseUrl={BASE} fetchImpl={watchedFetch} registry={registry} />
    </div>
  )
}

createRoot(document.getElementById('root')!).render(<App />)
