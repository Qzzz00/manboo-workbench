import { useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import type { WorkbenchState } from '../../src/protocol.ts'
import { ButlerInbox } from '../../src/client/ButlerInbox.tsx'
import { STYLE } from '../../src/client/style.ts'
function App() {
  const [state, setState] = useState<WorkbenchState>(), [draft, setDraft] = useState('')
  useEffect(() => {
    let current = true
    const load = () => { void fetch('/api/state').then(res => res.json()).then(got => { if (current) setState(got) }) }
    load(); const timer = setInterval(load, 600)
    return () => { current = false; clearInterval(timer) }
  }, [])
  if (state === undefined) return <p>正在读隔离服务</p>
  return <><style>{STYLE}{`body{margin:0;background:#111;color:#eee}#root{height:100vh}.ben-wb{height:100vh;position:relative;--dsw-alias-bg-layer-1:#111;--dsw-alias-bg-layer-2:#191919;--dsw-alias-label-primary:#eee;--dsw-alias-label-secondary:#bbb;--dsw-alias-label-tertiary:#888;--dsw-alias-border-l1:#333}`}</style>
    <main className="ben-wb"><ButlerInbox state={state} baseUrl="/api" fetchImpl={fetch} onOpenConversation={() => {}} draft={draft} onDraftChange={setDraft} visible controls={{ paused: false, testRinging: false, onPause: () => {}, onTestRing: () => {}, onCancelWatch: () => {}, onDismissBrief: () => {}, proposals: [] }} /></main></>
}
createRoot(document.getElementById('root')!).render(<App />)
