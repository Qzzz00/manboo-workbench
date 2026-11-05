/**
 * 设置里那一节「实验开关」(2026-10-21,卡「引导三件事」;四样与默认在 `src/mainPaths.ts`)。
 *
 * 视频链、会议录音转纪要、座机听筒、派活到豆包 / Kimi(读窗口):它们靠读别人的窗口或靠硬件,
 * 每台机器一套故障,内测期不进主路。内部机器默认开、外部默认关;关着时事务官对这类要求如实说
 * 「这一类还在内测,我先不接」。数据走 `/state.experiments`,改走 `POST /experiments`(只在这台电脑上)。
 */
import { useState } from 'react'
import { SetLead, SetMsg, SetRow, SetSection } from './settings/setKit.tsx'
import { EXPERIMENT_KEYS, EXPERIMENT_OFF_LINE, EXPERIMENT_TITLES, type ExperimentKey, type ExperimentsView } from '../mainPaths.ts'

export function ExperimentsPanel({ view, baseUrl, fetchImpl }: {
  view: ExperimentsView
  baseUrl: string
  fetchImpl?: typeof fetch
}) {
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState<string | null>(null)
  async function toggle(key: ExperimentKey, on: boolean): Promise<void> {
    setBusy(true)
    setNote(null)
    try {
      const res = await (fetchImpl ?? fetch)(`${baseUrl}/experiments`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ key, on }),
      })
      if (!res.ok) {
        const body = await res.json().catch(() => ({})) as { error?: unknown }
        setNote(typeof body.error === 'string' ? body.error : `没改成(HTTP ${res.status})`)
      }
    }
    catch (err) {
      setNote(err instanceof Error ? err.message : '没改成')
    }
    finally {
      setBusy(false)
    }
  }
  // 评审页没有这一节;样子照同页「电脑保持唤醒」:一句说明,每样一行开关。
  return (
    <SetSection id="ben-wb-experiments" title="实验开关" aside={view.audience === 'internal' ? '内部机器 · 默认开' : '默认关'}>
      <SetLead>
        这几样还在内测,靠读别家的窗口或靠硬件,换一台电脑可能就不灵。关着的时候,你让我做这一类我会说「{EXPERIMENT_OFF_LINE.replace(/。$/u, '')}」。
      </SetLead>
      {EXPERIMENT_KEYS.map(key => (
        <SetRow key={key} title={EXPERIMENT_TITLES[key]}>
          <input type="checkbox" aria-label={EXPERIMENT_TITLES[key]} checked={view.on[key]} disabled={busy} onChange={event => { void toggle(key, event.target.checked) }} />
        </SetRow>
      ))}
      {note !== null && <SetMsg role="alert">{note}</SetMsg>}
    </SetSection>
  )
}
