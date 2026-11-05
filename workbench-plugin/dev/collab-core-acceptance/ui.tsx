/** 仅 QA 装配;组件按参数从唯一 UI 主人源码只读载入,数据来自真实 core HTTP。 */
import { useEffect, useMemo, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { GoalPanel } from '@qa-ui/GoalPanel.tsx'
import { NoteTalk } from '@qa-ui/NoteTalk.tsx'
import { RunsPanel } from '@qa-ui/RunsPanel.tsx'
import { RelationsPanel } from '@qa-ui/RelationsPanel.tsx'
import { collabApi } from '../../src/client/collab/collabApi.ts'
import { STYLE } from '@qa-ui/../style.ts'
function App() {
 const [state, setState] = useState<any>()
 const params = new URLSearchParams(location.search)
 const api = useMemo(() => collabApi('/api', fetch), [])
 useEffect(() => { const load = () => { void api.get('/state').then(setState) }; load(); const timer = setInterval(load, 600); return () => clearInterval(timer) }, [api])
 if (!state) return <p>正在读真实服务…</p>
 const goal = state.tasks.goals.find((g: any) => g.id === params.get('goal'))
 const task = state.tasks.tasks.find((t: any) => t.id === params.get('task'))
 return <><style>{STYLE}</style><main className="ben-cl" style={{ color: '#eee', background: '#111', minHeight: '100vh', padding: 24 }}>
 {params.get('panel') === 'activity' ? <NoteTalk task={task} cards={[]} api={api} onReceipt={() => {}} />
 : params.get('panel') === 'runs' ? <RunsPanel taskId={task.id} api={api} snapshotKey={state.tasks} />
 : params.get('panel') === 'relations' ? <RelationsPanel taskId={task.id} tasks={state.tasks.tasks} api={api} onOpenTask={() => {}} />
 : <GoalPanel goal={goal} snapshotKey={state.tasks} api={api} onOpenTask={() => {}} onClose={() => {}} />}
 </main></>
}
createRoot(document.getElementById('root')!).render(<App />)
