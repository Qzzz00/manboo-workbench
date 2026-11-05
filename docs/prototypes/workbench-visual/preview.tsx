import React, { useMemo, useState, useSyncExternalStore } from 'react'
import { createRoot } from 'react-dom/client'
// 预览没有 DSH 插件入口；只导入宿主的 props 类型合并，不加载客户端运行时代码。
import type {} from '../../../workbench-plugin/node_modules/@deepseek-ai/dsh-client-ui-workspace/lib/types/client/index.d.ts'
import type {} from '../../../workbench-plugin/node_modules/@deepseek-ai/dsh-client-ui-session/lib/types/client/index.d.ts'
import { WorkbenchOverlay, type WorkbenchOverlayProps } from '../../../workbench-plugin/src/client/Workbench.tsx'
import { createWorkbenchStore } from '../../../workbench-plugin/src/client/store.ts'
import { createPreviewFetch, previewBoardState, previewButlerState, previewState } from './fixture.ts'
import './preview.css'

declare const __PREVIEW_BEFORE__: boolean

const instance = createWorkbenchStore().create()
const workspace = { items: [], phase: 'ready', archivedSessionIds: [], state: 'idle', error: null, baselinesReady: true }
const query = new URLSearchParams(location.search)
const sizes = ['自适应', '1100×1700', '1440×1000', '820×1100', '640×900']

/**
 * 取证模式 `?shot=<宽>x<高>`(2026-09-21 fix/slot-refit-on-orientation 加的)。
 *
 * 为什么要有它:交接里要附「横屏一张、竖屏一张」的页面截图,而预览页平时那一身工具条
 * (主题/画布/状态三个下拉 + 页脚)会把画布挤到一边,截出来的比例不是壳里真实的比例;
 * 画布下拉里也没有 维护者 那两块屏的尺寸。开了这个参数就:① 只留画布,尺寸按参数写死;
 * ② 在画布上烧一条**红色**的「假数据」横幅 —— 这页喂的是 fixture.ts 里的示例数字,
 * 截图一旦进了仓库/文档,没有这条红字迟早有人把它当成 维护者 机器上的真实状态。
 */
function shotSize(): { width: number, height: number } | undefined {
  const raw = query.get('shot')
  if (raw === null) return undefined
  const [w, h] = raw.toLowerCase().split('x').map(Number)
  if (!(w > 0) || !(h > 0)) return undefined
  return { width: w, height: h }
}

function Preview() {
  const [theme, setTheme] = useState(query.get('theme') === 'light' ? 'light' : 'dark')
  const [size, setSize] = useState(sizes.includes(query.get('size') ?? '') ? query.get('size')! : '自适应')
  const [scenario, setScenario] = useState(['normal', 'board', 'butler', 'butler-empty', 'error'].includes(query.get('scenario') ?? '') ? query.get('scenario')! : 'normal')
  const [notice, setNotice] = useState('仅示例数据 · 不连接、不控制客户端')
  const [executionCount, setExecutionCount] = useState(3)
  const [width, height] = size.split('×').map(Number)
  const comparison = `?${new URLSearchParams({ theme, size, scenario })}`
  const fixture = useMemo(() => {
    const value = scenario === 'butler' || scenario === 'butler-empty'
      ? previewButlerState(scenario === 'butler-empty', executionCount)
      : scenario === 'board' ? previewBoardState() : previewState()
    if (scenario === 'error') {
      value.stale = true
      value.usage = { error: '示例：用量来源暂不可用' }
      value.machine = { error: '示例：机器信号暂不可用' }
      value.projects!.scan_errors = [{ root: '/preview/unavailable', reason: '示例：暂时无法读取项目' }]
    }
    return value
  }, [scenario, executionCount])
  const fetchImpl = useMemo(() => createPreviewFetch(fixture, setNotice), [fixture])
  const props: WorkbenchOverlayProps = {
    useStore: selector => selector(useSyncExternalStore(instance.subscribe, instance.getSnapshot)),
    actions: instance.actions,
    useWorkspaces: selector => selector(workspace as never),
    useSessions: selector => selector({} as never),
    useSessionPendingInteraction: (() => undefined) as never,
    openWorkspace: async () => { setNotice('仅视觉预览：未打开实际项目') },
    openSession: () => setNotice('仅视觉预览：未打开实际会话'),
    serviceBaseUrl: 'https://preview.invalid', serviceFetch: fetchImpl, servicePollMs: 0,
    serviceWebSocket: () => ({ onmessage: null, onclose: null, close: () => {} }),
  }
  const shot = shotSize()
  if (shot !== undefined) {
    return <div className="preview preview--shot" data-theme={theme}>
      <div className="preview-stage" style={{ width: shot.width, height: shot.height }}>
        <WorkbenchOverlay {...props} />
        <p className="preview-stamp">假数据 · 视觉预览 · 不是 维护者 机器上的真实状态</p>
      </div>
    </div>
  }
  return <div className="preview" data-theme={theme}>
    <header className="preview-toolbar">
      <div className="preview-label"><strong>Workbench</strong><span>内部编排 · 真实组件</span></div>
      <nav aria-label="样式版本"><a aria-current={!__PREVIEW_BEFORE__ ? 'page' : undefined} href={`../after/${comparison}`}>新版</a><a aria-current={__PREVIEW_BEFORE__ ? 'page' : undefined} href={`../before/${comparison}`}>上一版</a></nav>
      <label>主题<select aria-label="预览主题" value={theme} onChange={e => setTheme(e.target.value)}><option value="dark">深色</option><option value="light">浅色</option></select></label>
      <label>画布<select aria-label="预览画布" value={size} onChange={e => setSize(e.target.value)}>{sizes.map(value => <option key={value}>{value}</option>)}</select></label>
      <label>状态<select aria-label="预览状态" value={scenario} onChange={e => { instance.actions.open(); setScenario(e.target.value) }}><option value="normal">常规</option><option value="board">有任务的看板</option><option value="butler">事务官 · 多任务</option><option value="butler-empty">事务官 · 空态</option><option value="error">异常与未接入</option></select></label>
      {scenario === 'butler' && <label>执行<select aria-label="预览执行事项数" value={executionCount} onChange={e => setExecutionCount(Number(e.target.value))}>{[0, 1, 3, 6, 9].map(count => <option key={count} value={count}>{count} 件</option>)}</select></label>}
    </header>
    <p className="preview-notice" role="status">{notice}</p>
    <div className="preview-stage" style={size === '自适应' ? { width: '100%', maxWidth: 1440, height: 1700 } : { width, height }}><WorkbenchOverlay {...props} /></div>
    <footer className="preview-foot">粒子事务官已纳入窗口槽 · 此页为隔离示例，不连接真实 Agent、语音或拨号；原生客户端贴合与 Finder 尚未在此验证。</footer>
  </div>
}

createRoot(document.getElementById('root')!).render(<Preview />)
