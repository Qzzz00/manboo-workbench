/**
 * 首页那张固定卡「现在能做什么」(2026-10-21,卡「引导三件事」;设计稿第二节第 8 条)。
 *
 * 三件主路(早报、交代、电话)各一行:通了 / 缺一步(写清缺哪道门,能一颗键修的给键)/ 还没试过;
 * 实验开关里的那几样标「内测中」(没开的标「内测中 · 没开」)—— 体验的人不会再点进半成品。
 * 行与那一句都从 `src/mainPaths.ts` 的 `capabilityRows` 来,与引导那一屏同一句。
 * 服务端没给 `/state.first_use`(老工作台)时整张不出。
 */
import { useState } from 'react'
import { EXPERIMENT_KEYS, FIRST_USE_SAY, capabilityRows, type ExperimentKey, type FirstUseView } from '../mainPaths.ts'
import type { WorkbenchState } from '../protocol.ts'
import { DoorRow, FIRST_USE_STYLE } from './firstrun/FirstUseStep.tsx'
import { loginAgent } from './firstrun/firstRunApi.ts'

const CARD_STYLE = `
.ben-wb__capcard{display:flex;flex-direction:column;gap:6px;padding:10px 12px;border-radius:10px;background:var(--dsw-alias-bg-layer-2);font-size:12.5px}
.ben-wb__capcard summary{cursor:pointer;list-style:none;display:flex;justify-content:space-between;align-items:center;gap:8px}
.ben-wb__capcard h2{display:inline;margin:0;font-size:13px;font-weight:600;color:var(--dsw-alias-label-primary)}
.ben-wb__capcard ul{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:4px}
.ben-wb__capcard li{display:flex;flex-direction:column;gap:3px}
.ben-wb__capcard-line{display:flex;justify-content:space-between;gap:8px;color:var(--dsw-alias-label-secondary)}
.ben-wb__capcard li[data-kind="beta"] .ben-wb__capcard-line{color:var(--dsw-alias-label-tertiary)}
.ben-wb__capcard-closing{margin:0;color:var(--dsw-alias-label-tertiary)}
`

/** 球下那一区里这一张的键(摊开那一层里它照旧整张摆,不收成一行)。 */
export const CAPABILITY_ASK_KEY = 'capabilities'

const DISMISS_KEY = 'ben-wb:capability:dismissed'

/**
 * 点过「收起」没有(本机记着;2026-10-28 维护者看着 0.4.167 问「这个是啥,能去掉吗」)。
 * 这张卡是引导期的东西:三样都通之前帮她看缺哪道门;她自己说不用看了,就从事务官这一档里撤掉,
 * 引导那一屏与 `GET /first-use` 不受影响。壳里、无痕窗口里 localStorage 可能直接抛:当没收起过。
 */
export function readCapabilityDismissed(): boolean {
  try { return globalThis.localStorage?.getItem(DISMISS_KEY) === '1' }
  catch { return false }
}

export function writeCapabilityDismissed(): void {
  try { globalThis.localStorage?.setItem(DISMISS_KEY, '1') }
  catch { /* 存不下就只收这一次 */ }
}

/** 收成一行时那一句。 */
export function capabilityRowText(view: FirstUseView): string {
  const ok = view.paths.filter(one => one.state === 'ok').length
  return `现在能做什么:通了 ${ok} / ${view.paths.length}`
}

export function CapabilityCard({ state, baseUrl, fetchImpl, dismissed: dismissedProp, onDismiss }: {
  state: WorkbenchState
  baseUrl: string
  fetchImpl?: typeof fetch
  /** 外面(球下那一区)记着的「收起」;不传就自己记。 */
  dismissed?: boolean | undefined
  onDismiss?: () => void
}) {
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState<string | null>(null)
  const [dismissedOwn, setDismissedOwn] = useState<boolean>(readCapabilityDismissed)
  const dismissed = onDismiss === undefined ? dismissedOwn : dismissedProp === true
  const view = state.first_use
  if (view === undefined || dismissed) return null
  const dismiss = (): void => {
    if (onDismiss !== undefined) { onDismiss(); return }
    setDismissedOwn(true)
    writeCapabilityDismissed()
  }
  const on = state.experiments?.on ?? Object.fromEntries(EXPERIMENT_KEYS.map(key => [key, false])) as Record<ExperimentKey, boolean>
  const rows = capabilityRows({ paths: view.paths, experiments: on })
  async function login(family: string): Promise<void> {
    setBusy(true)
    try { setNote((await loginAgent(baseUrl, family, fetchImpl ?? fetch)).note ?? null) }
    catch (err) { setNote(err instanceof Error ? err.message : '登录窗口没打开') }
    finally { setBusy(false) }
  }
  return (
    <section className="ben-wb__capcard" aria-label="现在能做什么">
      <style>{FIRST_USE_STYLE}{CARD_STYLE}</style>
      {/* 三样都通之前摊开(她要看缺哪道门),通了之后收成一行,不占球下那一区。 */}
      <details open={view.closed_at === undefined}>
      <summary>
        <h2>现在能做什么</h2>
        {/* 「收起」与「我照你说的摆好了」那张同一个样子;按一下不翻折叠。 */}
        <button type="button" className="ben-wb__laid-ghost" onClick={(event) => { event.preventDefault(); event.stopPropagation(); dismiss() }}>收起</button>
      </summary>
      <ul>
        {rows.map(row => (
          <li key={row.key} data-kind={row.kind} data-state={row.state}>
            <span className="ben-wb__capcard-line"><span>{row.title}</span><span>{row.line}</span></span>
            {row.door !== undefined && row.state === 'missing' && (
              <DoorRow door={row.door} busy={busy} onLogin={(family) => { void login(family) }} />
            )}
          </li>
        ))}
      </ul>
      {view.closed_at !== undefined && <p className="ben-wb__capcard-closing">{FIRST_USE_SAY.closing}</p>}
      {note !== null && <p className="ben-wb__capcard-closing" role="status">{note}</p>}
      </details>
    </section>
  )
}
