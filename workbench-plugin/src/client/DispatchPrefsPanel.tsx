/**
 * 设置里的「派活与办完提醒」(2026-10-23,卡「分层第二刀一」前两条;照评审页「偏好」一节的行式)。
 *
 * 她 10-03 在产物上改的两样开成设置项:
 *   1. **办完要告诉你的事** —— 按事项类型勾(交办 / 派活 / 会议 / 例程),缺省照现状
 *      (交办 / 会议 / 例程提醒,派出去的活不提醒);判定(算不算失败、谁的会话收尾)本体说了算,这里只管范围;
 *   2. **在电脑上动手的活** —— 「桌面那一类不问就派」开关,缺省关(「先问我」档照旧由事务官先接手)。
 *
 * 跟别的设置节同一套规矩(同 RulesPanel):数据自己拉 `GET /dispatch/prefs`,404 = 没接 → 整节不出现;
 * 结果如实上屏;新文案见交接(维护者过一遍字眼)。
 */
import { useEffect, useState } from 'react'
import type { DispatchPrefsView, TellKind, TellScopeView } from '../protocol.ts'
import { TELL_KINDS, TELL_KIND_TITLES } from '../protocol.ts'
import { SetActions, SetBtn, SetMsg, SetRow, SetSection } from './settings/setKit.tsx'

/** 形状不对就当没拿到(并行用例里 fetch 会串台)。 */
export function isDispatchPrefsPayload(body: unknown): body is DispatchPrefsView {
  if (typeof body !== 'object' || body === null) return false
  const raw = body as Record<string, unknown>
  const scope = raw.tell_scope
  if (typeof scope !== 'object' || scope === null) return false
  return typeof (scope as Record<string, unknown>).mine === 'boolean' && typeof raw.auto_desk === 'boolean'
}

/** 那一行副行:勾着的几类,顿号连;一个都没勾如实说「先都不提醒」。 */
export function tellScopeLine(scope: TellScopeView): string {
  const picked = TELL_KINDS.filter(kind => scope[kind]).map(kind => TELL_KIND_TITLES[kind])
  return picked.length === 0 ? '先都不提醒' : picked.join('、')
}

export function DispatchPrefsPanel({ baseUrl, fetchImpl }: { baseUrl: string, fetchImpl?: typeof fetch }) {
  const [payload, setPayload] = useState<DispatchPrefsView | null>(null)
  const [message, setMessage] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  /** 「办完要告诉你的事」摊开改勾了没有。 */
  const [editing, setEditing] = useState(false)
  /** 摊开后那组勾的草稿。 */
  const [draft, setDraft] = useState<TellScopeView | null>(null)

  const call = fetchImpl ?? fetch

  async function reload(): Promise<DispatchPrefsView | null> {
    try {
      const res = await call(`${baseUrl}/dispatch/prefs`)
      if (!res.ok) return null
      const body = await res.json() as unknown
      return isDispatchPrefsPayload(body) ? body : null
    }
    catch { return null }
  }

  useEffect(() => {
    let alive = true
    void (async () => {
      const next = await reload()
      if (alive && next !== null) setPayload(next)
    })()
    return () => { alive = false }
    // 依赖只列 baseUrl / fetchImpl,同 RulesPanel:reload 是每次渲染新建的闭包。
  }, [baseUrl, fetchImpl])

  if (payload === null) return null

  async function send(body: Record<string, unknown>): Promise<void> {
    setBusy(true)
    setMessage(null)
    try {
      const res = await call(`${baseUrl}/dispatch/prefs`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
      })
      const said = (await res.json().catch(() => ({}))) as { ok?: boolean, error?: string }
      if (!res.ok || said.error !== undefined) setMessage(said.error ?? '没办成')
      else setMessage('好了。')
      const next = await reload()
      if (next !== null) setPayload(next)
    }
    catch { setMessage('工作台服务没应答') }
    finally { setBusy(false) }
  }

  const scope = payload.tell_scope
  return (
    <SetSection id="ben-wb-dispatch-prefs" title="派活与办完提醒">
      {message !== null && <SetMsg>{message}</SetMsg>}

      <SetRow title="办完要告诉你的事" sub={tellScopeLine(scope)} data-dispatch-tell-scope="1">
        <SetBtn
          aria-expanded={editing}
          onClick={() => {
            if (editing) { setEditing(false); setDraft(null) }
            else { setDraft({ ...scope }); setEditing(true) }
          }}
        >
          {editing ? '收起' : '改'}
        </SetBtn>
      </SetRow>
      {editing && draft !== null && (
        <div className="ben-wb__srow-more" data-dispatch-tell-edit="1">
          <p className="ben-wb__smsg">哪几类事项办完要告诉你。派出去的活勾上了,办完、办砸、停下来等你的话也照这个范围提醒。</p>
          {TELL_KINDS.map((kind: TellKind) => (
            <label key={kind} className="ben-wb__scheck" data-tell-kind={kind}>
              <input
                type="checkbox"
                aria-label={`办完提醒:${TELL_KIND_TITLES[kind]}`}
                checked={draft[kind]}
                onChange={event => setDraft({ ...draft, [kind]: event.target.checked })}
              />
              {TELL_KIND_TITLES[kind]}
            </label>
          ))}
          <SetActions>
            <SetBtn disabled={busy} onClick={() => { setEditing(false); setDraft(null) }}>取消</SetBtn>
            <SetBtn
              kind="outline"
              disabled={busy}
              onClick={() => { const tell_scope = draft as TellScopeView; setEditing(false); setDraft(null); void send({ tell_scope }) }}
            >
              保存
            </SetBtn>
          </SetActions>
        </div>
      )}

      <SetRow title="在电脑上动手的活" sub={payload.auto_desk ? '交代了不问就派' : '交代了由事务官先接着'} data-dispatch-auto-desk="1">
        <SetBtn disabled={busy} onClick={() => { void send({ auto_desk: !payload.auto_desk }) }}>
          {payload.auto_desk ? '关' : '开'}
        </SetBtn>
      </SetRow>
    </SetSection>
  )
}
