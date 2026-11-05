/**
 * 协作A「继续这件事」真浏览器验收页(2026-10-23 复审):真 NoteDialog 组件 + 真隔离 8791。
 * 数据就是隔离服务里那一张借名卡;fetch 走 vite 代理(同源,不碰 CORS)。
 * CDP 驱动脚本在 /tmp/collab-a-browser/cdp-run.mjs。
 */
import { createRoot } from 'react-dom/client'
import { useEffect, useState } from 'react'
import type { CollabGoal, TaskView, WorkbenchState } from '../../src/protocol.ts'
import { NoteDialog } from '../../src/client/collab/NoteDialog.tsx'
import { collabApi } from '../../src/client/collab/collabApi.ts'

function App() {
  const [state, setState] = useState<WorkbenchState | undefined>(undefined)
  const [task, setTask] = useState<TaskView | undefined>(undefined)
  useEffect(() => {
    void fetch('/state').then(async (res) => {
      const s = await res.json() as WorkbenchState
      setState(s)
      const first = s.tasks?.tasks?.[0]
      if (first !== undefined) setTask(first)
    }).catch(() => {})
  }, [])
  if (state === undefined || task === undefined) return <p style={{ padding: 24 }}>在读 /state…</p>
  const goals: CollabGoal[] = state.tasks?.goals ?? []
  return (
    <div style={{ position: 'fixed', inset: 0, background: '#0d0d0d' }}>
      <NoteDialog
        task={task}
        state={state}
        goals={goals}
        cards={[]}
        entries={state.agent_registry?.entries ?? []}
        api={collabApi('', fetch)}
        baseUrl=""
        fetchImpl={fetch}
        assigneeText={() => ''}
        onClose={() => {}}
        onFlyGoal={() => {}}
        onReceipt={(text) => { console.log('[receipt]', text) }}
      />
    </div>
  )
}

createRoot(document.getElementById('root')!).render(<App />)
