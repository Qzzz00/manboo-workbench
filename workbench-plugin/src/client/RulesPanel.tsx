/**
 * 设置里的「记住的规矩」(2026-09-24 晚,卡 K;docs/设计-全局自进化-2026-09-24.md 确认点 1)。
 *
 * 维护者:「这些其实你都得写进事务官那边,不然以后我还得调教他一遍」。这一节就是那张表的**唯一一处**
 * 看全、随手删改的地方(手机设置里是同一张表,butler-app/src/settings/RulesSection.tsx)。
 *
 * 跟别的设置节同一套规矩(同 CustomModulesPanel):
 * 1. **数据自己拉 `GET /butler/rules`**,不走 /state;404 = 这台服务没接规矩表 → 整节不出现。
 * 2. **不露内部的东西**(他的规矩 ③):不显示 id、英文键名、文件路径;块名用中文(全局 / 说话 / 界面 / 验收 / 内容)。
 * 3. **删不是抹掉**:删了的进「不再照做的」,随时恢复;结果如实上屏,服务端怎么说就怎么写。
 */
import { useEffect, useState } from 'react'
import type { ButlerRuleArea, ButlerRuleView, ButlerRulesView } from '../protocol.ts'
import { BUTLER_RULE_AREAS, BUTLER_RULE_AREA_TITLES, BUTLER_RULE_CHANNEL_TITLES } from '../protocol.ts'
import { SetActions, SetBtn, SetErr, SetFold, SetLead, SetMsg, SetRow, SetSection, SetX } from './settings/setKit.tsx'

/** 形状不对就当没拿到(并行用例里 fetch 会串台)。 */
export function isRulesPayload(body: unknown): body is ButlerRulesView {
  if (typeof body !== 'object' || body === null) return false
  const raw = body as Record<string, unknown>
  return Array.isArray(raw.rules) && Array.isArray(raw.retired)
}

/** 本机时间 `MM-DD HH:mm`(评审页「你在设置里说的 · 10-21 09:12 · 验收」那一格);读不懂原样截前 10 位。 */
function ruleStamp(at: string): string {
  const time = new Date(at)
  if (Number.isNaN(time.getTime())) return at.slice(0, 10)
  const two = (n: number): string => String(n).padStart(2, '0')
  return `${two(time.getMonth() + 1)}-${two(time.getDate())} ${two(time.getHours())}:${two(time.getMinutes())}`
}

/** 一条规矩后面那一小行:哪来的 · 几时 · 管哪一块,试用到哪了。 */
export function ruleMetaLine(rule: ButlerRuleView): string {
  const first = rule.evidence[0]
  const from = rule.origin === 'topic'
    ? '选题卡上学到的'
    : rule.origin === 'repeated'
      ? '你在不止一件活上打回过同一处'
      : first === undefined ? '你说过的' : `${BUTLER_RULE_CHANNEL_TITLES[first.channel]}说的`
  const when = ruleStamp(first?.at ?? rule.created_at)
  const state = rule.status === 'trial'
    ? ' · 试用中(下一件你通过就留下,再打回就撤)'
    : rule.status === 'kept' ? ' · 验过了,留下' : rule.status === 'reverted' ? ' · 没见效,撤了' : ''
  return `${from} · ${when} · ${BUTLER_RULE_AREA_TITLES[rule.area]}${state}`
}

/** 节名右边那一句状态(原来在组首入口行上,2026-10-22 挪到这里)。 */
export function rulesEntryLine(view: ButlerRulesView): string {
  if (view.rules.length === 0 && view.retired.length === 0) return '还没有记下的规矩'
  return `${view.rules.length} 条正在照做 · ${view.retired.length} 条已撤下`
}

export function RulesPanel({ baseUrl, fetchImpl }: { baseUrl: string, fetchImpl?: typeof fetch }) {
  const [payload, setPayload] = useState<ButlerRulesView | null>(null)
  const [message, setMessage] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [draft, setDraft] = useState('')
  const [editing, setEditing] = useState<{ id: string, text: string } | null>(null)

  const call = fetchImpl ?? fetch

  async function reload(): Promise<ButlerRulesView | null> {
    try {
      const res = await call(`${baseUrl}/butler/rules`)
      if (!res.ok) return null
      const body = await res.json() as unknown
      return isRulesPayload(body) ? body : null
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
    // 依赖只列 baseUrl / fetchImpl,同 CustomModulesPanel:reload 是每次渲染新建的闭包。
  }, [baseUrl, fetchImpl])

  if (payload === null) return null

  async function send(path: string, body: Record<string, unknown>): Promise<void> {
    setBusy(true)
    setMessage(null)
    try {
      const res = await call(`${baseUrl}${path}`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
      })
      const said = (await res.json().catch(() => ({}))) as { ok?: boolean, error?: string, note?: string, added?: number }
      if (!res.ok || said.error !== undefined) setMessage(said.error ?? '没办成')
      else setMessage(said.note ?? (typeof said.added === 'number' ? `导进来 ${said.added} 条。` : '好了。'))
      const next = await reload()
      if (next !== null) setPayload(next)
    }
    catch { setMessage('工作台服务没应答') }
    finally { setBusy(false) }
  }

  const rules = payload.rules
  /** 排序分组的键:试用沉底 + 块。上移 / 下移只在该组内换位置(跨组的那一颗置灰)。 */
  const groupKey = (rule: ButlerRuleView): string => `${rule.status === 'trial' ? 'trial' : 'firm'}:${rule.area}`
  const canMove = (index: number, step: -1 | 1): boolean => {
    const neighbor = rules[index + step]
    const rule = rules[index]
    return neighbor !== undefined && rule !== undefined && neighbor.editable && groupKey(neighbor) === groupKey(rule)
  }
  // 评审页 `section('rules', '记住的规矩', …)`:一句 + 出处 · 范围 + 改 / ✕;一行添新规矩;「已撤下 N 条 · 展开 ›」。
  // 「管哪一块」的下拉稿里没有常驻,收进「改」里面;长说明删掉(机制在规矩那份设计稿里)。
  return (
    <SetSection id="ben-wb-rules" title="记住的规矩" aside={rulesEntryLine(payload)} className="ben-wb__rules">
      {payload.synced !== undefined && !payload.synced.ok && (
        <SetErr>这张表这次没写进事务官的设置:{payload.synced.note ?? '原因不明'}。下次启动会再试。</SetErr>
      )}

      {rules.length === 0 && <SetLead>还没有明说的规矩,写一条就从下次开始照做。</SetLead>}
      {rules.map((rule, index) => (
        editing?.id === rule.id
          ? (
              <div className="ben-wb__srow ben-wb__rule" key={rule.id} data-rule-status={rule.status}>
                <div className="ben-wb__srow-label ben-wb__sform">
                  <input
                    aria-label="改这条规矩"
                    value={editing.text}
                    onChange={event => setEditing({ id: rule.id, text: event.target.value })}
                  />
                  <select
                    aria-label="这条管哪一块"
                    value={rule.area}
                    disabled={busy}
                    onChange={(event) => { void send('/butler/rules/update', { id: rule.id, area: event.target.value as ButlerRuleArea }) }}
                  >
                    {BUTLER_RULE_AREAS.map(area => <option key={area} value={area}>{BUTLER_RULE_AREA_TITLES[area]}</option>)}
                  </select>
                </div>
                <span className="ben-wb__srow-acts">
                  <SetBtn
                    disabled={busy || editing.text.trim() === ''}
                    onClick={() => { const text = editing.text; setEditing(null); void send('/butler/rules/update', { id: rule.id, text }) }}
                  >
                    存
                  </SetBtn>
                  <SetBtn onClick={() => setEditing(null)}>取消</SetBtn>
                </span>
              </div>
            )
          : (
              <SetRow className="ben-wb__rule" key={rule.id} data-rule-status={rule.status} title={rule.text} sub={ruleMetaLine(rule)}>
                <span className="ben-wb__srow-acts">
                  {rule.editable && (
                    <>
                      <SetBtn
                        kind="icon"
                        aria-label="上移规矩"
                        title="上移"
                        disabled={busy || !canMove(index, -1)}
                        onClick={() => { void send('/butler/rules/move', { id: rule.id, dir: 'up' }) }}
                      >
                        ↑
                      </SetBtn>
                      <SetBtn
                        kind="icon"
                        aria-label="下移规矩"
                        title="下移"
                        disabled={busy || !canMove(index, 1)}
                        onClick={() => { void send('/butler/rules/move', { id: rule.id, dir: 'down' }) }}
                      >
                        ↓
                      </SetBtn>
                    </>
                  )}
                  {rule.editable && <SetBtn disabled={busy} onClick={() => setEditing({ id: rule.id, text: rule.text })}>改</SetBtn>}
                  <SetBtn kind="icon" aria-label="撤下规矩" title={rule.origin === 'topic' ? '撤' : '删'} disabled={busy} onClick={() => { void send('/butler/rules/remove', { id: rule.id }) }}>
                    <SetX />
                  </SetBtn>
                </span>
              </SetRow>
            )
      ))}

      <form className="ben-wb__sform" onSubmit={(event) => { event.preventDefault(); const text = draft; if (text.trim() === '') return; setDraft(''); void send('/butler/rules', { text, channel: 'settings' }) }}>
        <input
          aria-label="写一条新规矩"
          placeholder="添一条长期规矩"
          value={draft}
          onChange={event => setDraft(event.target.value)}
        />
        <SetBtn kind="outline" type="submit" disabled={busy || draft.trim() === ''}>记下</SetBtn>
      </form>
      {rules.length === 0 && (
        <SetActions>
          <SetBtn kind="text" disabled={busy} onClick={() => { void send('/butler/rules/import', { from: 'observations' }) }}>
            从记忆里的「观察」学风格
          </SetBtn>
        </SetActions>
      )}

      {payload.retired.length > 0 && (
        <SetFold summary={`已撤下 ${payload.retired.length} 条`}>
          {payload.retired.map(rule => (
            <SetRow key={rule.id} data-rule-status={rule.status} title={rule.text} sub={rule.status === 'removed' ? '你删的' : (rule.verdict ?? '没见效,撤了')}>
              {rule.origin !== 'topic' && (
                <SetBtn disabled={busy} onClick={() => { void send('/butler/rules/restore', { id: rule.id }) }}>恢复</SetBtn>
              )}
            </SetRow>
          ))}
        </SetFold>
      )}

      {message !== null && <SetMsg>{message}</SetMsg>}
    </SetSection>
  )
}
