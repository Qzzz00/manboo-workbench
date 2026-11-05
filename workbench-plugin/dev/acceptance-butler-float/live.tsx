/** Controlled browser entry: production float/inbox, actual paired API, no fabricated state. */
import { useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { Butler } from '../../src/client/Butler.tsx'
import { ButlerInbox } from '../../src/client/ButlerInbox.tsx'
import { STYLE } from '../../src/client/style.ts'
import { PARTICLE_STYLE } from '../../src/client/particleStyle.ts'
import { BUTLER_LAYOUT_STYLE, BUTLER_COMPOSER_STYLE } from '../../src/client/butlerLayoutStyle.ts'
import type { WorkbenchState } from '../../src/protocol.ts'
import 'dsh-ui-theme/base.css'
import 'dsh-ui-theme/design-platform.css'
declare global { interface Window { __collab1cPairing?: { host: string, port: number, token: string } } }
const p = window.__collab1cPairing
if (!p || p.host !== '127.0.0.1') throw new Error('Own controlled paired session required')
const base = `http://${p.host}:${p.port}`
const token = p.token
const request: typeof fetch = (input, init) => { const headers = new Headers(init?.headers); headers.set('authorization', `Bearer ${token}`); return fetch(input, { ...init, headers }) }
function LiveInbox() {
  const [state, setState] = useState<WorkbenchState>()
  const [draft, setDraft] = useState('')
  const full = new URLSearchParams(location.search).get('full') === '1'
  useEffect(() => { let live = true; const refresh = async () => { const response = await request(base + '/state'); if (!response.ok) throw new Error(`state ${response.status}`); const next = await response.json() as WorkbenchState; if (live) setState(next) }; void refresh(); const timer = setInterval(() => { void refresh() }, 1000); return () => { live = false; clearInterval(timer) } }, [])
  if (!state) return <p>正在读取隔离 API…</p>
  const inbox = <ButlerInbox state={state} baseUrl={base} fetchImpl={request} draft={draft} onDraftChange={setDraft} visible onOpenConversation={() => {}} orientation={full ? 'landscape' : 'portrait'} controls={{ paused: false, testRinging: false, proposals: [], onPause() {}, onTestRing() {}, onCancelWatch() {}, onDismissBrief() {} }} />
  return <div className="ben-wb" style={{ width: '100%', height: '100%', position: 'relative', overflow: 'hidden' }}>
    <style>{STYLE + PARTICLE_STYLE + BUTLER_LAYOUT_STYLE + BUTLER_COMPOSER_STYLE}</style>
    {full ? inbox : <Butler conclusions={[]} corner="tl" min={false} narrowForced={false} pos={{ x_pct: 0, y_pct: 0 }} size={{ w_px: 520, h_px: 680 }} paused={false} testRinging={false} onToggleMin={() => {}} onMove={() => {}} onResize={() => {}} onPause={() => {}} onTestRing={() => {}} onAsk={async () => true} onDismissBrief={() => {}} onCancelWatch={() => {}} page={inbox} />}
  </div>
}
createRoot(document.getElementById('root')!).render(<LiveInbox />)
