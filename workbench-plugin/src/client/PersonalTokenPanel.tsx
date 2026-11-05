/**
 * 设置里「个人访问令牌」那一节(2026-10-21 协作区;视觉需求第 14 屏)。
 *
 * 给 `workbench` 命令行、她自己的脚本、别家 agent 用:带着它打本机 8791,写接口按「她本人在点」放行。
 * **先写用途再发**;明文只在发的那一下摆出来(盘上只有哈希)。列表只给用途、开头几个字、发的时间、上次用的时间与撤销。
 * 只在这台电脑上认(不跨机)。数据不走 /state,自己拉 `GET /token/personal`;404(没接)整节不出现。
 */
import { useEffect, useState } from 'react'
import type { PersonalTokenView } from '../protocol.ts'
import { SetActions, SetBtn, SetFold, SetLead, SetMsg, SetRow, SetSection, SetWarn } from './settings/setKit.tsx'

function day(iso: string | undefined): string {
  return iso === undefined || iso === '' ? '' : iso.slice(0, 16).replace('T', ' ')
}

export function PersonalTokenPanel({ baseUrl, fetchImpl }: { baseUrl: string, fetchImpl?: typeof fetch }) {
  const doFetch = fetchImpl ?? fetch
  const [tokens, setTokens] = useState<readonly PersonalTokenView[] | null>(null)
  const [purpose, setPurpose] = useState('')
  const [fresh, setFresh] = useState<{ token: string, purpose: string } | undefined>(undefined)
  const [note, setNote] = useState<string | undefined>(undefined)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    let alive = true
    void (async () => {
      try {
        const res = await doFetch(`${baseUrl}/token/personal`)
        if (!res.ok || !alive) return
        const body = await res.json() as { tokens?: unknown }
        if (!Array.isArray(body.tokens)) return
        setTokens(body.tokens as PersonalTokenView[])
      }
      catch { /* 读不到就整节不出现 */ }
    })()
    return () => { alive = false }
  }, [baseUrl, doFetch])

  if (tokens === null) return null

  const post = async (path: string, body: unknown): Promise<Record<string, unknown> | undefined> => {
    setBusy(true)
    try {
      const res = await doFetch(`${baseUrl}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
      const got = await res.json().catch(() => ({})) as Record<string, unknown>
      if (!res.ok) { setNote(typeof got.error === 'string' ? got.error : '没办成'); return undefined }
      if (Array.isArray(got.tokens)) setTokens(got.tokens as PersonalTokenView[])
      return got
    }
    catch { setNote('工作台服务没应答'); return undefined }
    finally { setBusy(false) }
  }

  // 评审页没有这一节;样子照同页的设置节:一句说明、每枚一行(用途 · 开头几个字 · 发于 · 上次用)+ 文字「撤销」、
  // 一行发新的(同「记住的规矩」那一行添新)、命令行示例收进折叠。协作区设置那一格里摆的也是这一节。
  return (
    <SetSection id="ben-wb-personal-token" title="个人访问令牌" aside={tokens.length === 0 ? undefined : `${tokens.length} 枚`}>
      <SetLead>
        给命令行 <code>workbench</code> 和你自己的脚本用:放进环境变量 <code>WORKBENCH_TOKEN</code>,它们就能替你在协作区建便签、改章、登记 Agent。只在这台电脑上认。
      </SetLead>
      {tokens.length === 0
        ? <SetMsg>还没发过。</SetMsg>
        : (
            <div role="list" aria-label="已发的令牌" className="ben-wb__token-list">
              {tokens.map(one => (
                <SetRow
                  role="listitem"
                  key={one.id}
                  title={one.purpose}
                  sub={`${one.hint}… · 发于 ${day(one.created_at)} · ${one.last_used_at === undefined ? '还没用过' : `上次用 ${day(one.last_used_at)}`}`}
                >
                  <SetBtn
                    kind="text"
                    disabled={busy}
                    aria-label={`撤销 ${one.purpose}`}
                    onClick={() => { void post('/token/personal/revoke', { id: one.id }).then((got) => { if (got !== undefined) setNote(`「${one.purpose}」撤了,带着它的命令行从现在起都进不来`) }) }}
                  >
                    撤销
                  </SetBtn>
                </SetRow>
              ))}
            </div>
          )}
      <form
        className="ben-wb__sform"
        onSubmit={(event) => {
          event.preventDefault()
          const what = purpose.trim()
          if (what === '') return
          void post('/token/personal/issue', { purpose: what }).then((got) => {
            if (got === undefined || typeof got.token !== 'string') return
            setFresh({ token: got.token, purpose: what })
            setPurpose('')
            setNote(undefined)
          })
        }}
      >
        <input aria-label="用途" value={purpose} placeholder="这枚拿去做什么(比如:本机脚本)" onChange={event => setPurpose(event.target.value)} />
        <SetBtn kind="outline" type="submit" disabled={busy || purpose.trim() === ''}>发一枚</SetBtn>
      </form>
      {fresh !== undefined && (
        <SetWarn role="status">
          「{fresh.purpose}」这一枚只显示这一次,关掉就看不到了 —— 现在复制走:
          <pre className="ben-wb__token-fresh" aria-label="刚发的令牌">{fresh.token}</pre>
          <SetActions>
            <SetBtn kind="outline" onClick={() => { void navigator.clipboard?.writeText(fresh.token).then(() => setNote('复制好了'), () => setNote('复制不了,手动选中它')) }}>复制</SetBtn>
          </SetActions>
        </SetWarn>
      )}
      <SetFold summary="命令行示例">
        <pre aria-label="命令行示例">{'export WORKBENCH_TOKEN=wbp_…\nworkbench note list --status confirm\nworkbench note create --title 换铃声 --from "said:铃声太吵" --accept 手机响一次 --assignee codex'}</pre>
      </SetFold>
      {note !== undefined && <SetMsg>{note}</SetMsg>}
    </SetSection>
  )
}
