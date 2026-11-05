/**
 * 预览台的页面:插件里那几个组件原样挂上(首次流程、首页「现在能做什么」、实验开关),
 * `/state` 每秒问一次真的 8791(经 serve.mjs 转过去)。顶上那条是模拟那几样的开关。
 */
import { useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { CapabilityCard } from '../../src/client/CapabilityCard.tsx'
import { ExperimentsPanel } from '../../src/client/ExperimentsPanel.tsx'
import { FirstRunFlow } from '../../src/client/firstrun/FirstRunFlow.tsx'
import { PARTICLE_STYLE } from '../../src/client/particleStyle.ts'
import { STYLE } from '../../src/client/style.ts'
import type { WorkbenchState } from '../../src/protocol.ts'
// DSH 自己的主题变量(颜色、卡片底色):真机上由 DSH 外壳带进来,预览台照同一份加载,深色那一套。
import '../../../../../../../deepseek-harness/packages/client/ui-theme/src/styles/design-platform.css'
document.body.setAttribute('data-ds-dark-theme', '')
document.documentElement.setAttribute('data-platform', 'darwin')

const base = ''

function Bar({ onHome, home }: { onHome: (on: boolean) => void, home: boolean }) {
  const post = (path: string): void => { void fetch(path, { method: 'POST', body: '{}' }) }
  return (
    <>
      <span className="tag">预览台 · 模拟:</span>
      <button type="button" onClick={() => post('/sim/pair')}>手机扫码配上</button>
      <button type="button" onClick={() => post('/sim/guide-done')}>跳过五问(当走完了)</button>
      <button type="button" onClick={() => post('/sim/call')}>手机打进来、记下一张事项</button>
      <button type="button" onClick={() => onHome(!home)}>{home ? '回到首次流程' : '看首页卡与实验开关'}</button>
      <span style={{ color: '#9a9890' }}>Claude / Codex 登录:点页面里那颗「登录」键就当登上了。刷新页面 = 从第一屏重来(数据还在);要全新一台,重启 serve.mjs。</span>
    </>
  )
}

function App() {
  const [state, setState] = useState<WorkbenchState | undefined>(undefined)
  const [home, setHome] = useState(false)
  const [guideDone, setGuideDone] = useState(false)
  useEffect(() => {
    let alive = true
    const tick = async (): Promise<void> => {
      try {
        const [next, sim] = await Promise.all([
          fetch('/state').then(res => res.json() as Promise<WorkbenchState>),
          fetch('/sim/state').then(res => res.json() as Promise<{ guideDone: boolean }>),
        ])
        if (alive) { setState(next); setGuideDone(sim.guideDone) }
      }
      catch { /* 下一拍再问 */ }
    }
    void tick()
    const timer = window.setInterval(() => { void tick() }, 1000)
    return () => { alive = false; window.clearInterval(timer) }
  }, [])
  useEffect(() => {
    const bar = document.getElementById('bar')
    if (bar !== null) barRoot.render(<Bar home={home} onHome={setHome} />)
  }, [home])
  if (state === undefined) return <p style={{ padding: 24 }}>在连真的 8791…</p>
  // 引导对话那一半(DSH)是模拟的:五问走没走完由预览台说。
  const shown: WorkbenchState = { ...state, onboarding: { stage: guideDone ? 'done' : 'opening', done: guideDone } }
  return (
    <main className="ben-wb" aria-label="工作台" style={{ minHeight: '100%' }}>
      {/* 照 Workbench.tsx:首次流程那一屏只挂 STYLE;首页那一档才多挂粒子样式(多挂了会把引导的球撑高、压到字上)。 */}
      <style>{STYLE}{home ? PARTICLE_STYLE : ''}</style>
      {home
        ? (
            <div style={{ maxWidth: 520, margin: '24px auto', display: 'flex', flexDirection: 'column', gap: 16 }}>
              <CapabilityCard state={shown} baseUrl={base} />
              {state.experiments !== undefined && <ExperimentsPanel view={state.experiments} baseUrl={base} />}
            </div>
          )
        : <FirstRunFlow baseUrl={base} state={shown} onDone={() => setHome(true)} />}
    </main>
  )
}

const barRoot = createRoot(document.getElementById('bar') as HTMLElement)
createRoot(document.getElementById('app') as HTMLElement).render(<App />)
