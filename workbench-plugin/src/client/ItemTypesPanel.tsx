/**
 * 设置里「事项类型」一节(2026-10-22 拍板:类型名不写死,做成设置;团队自配名字 / 图标 / 暗亮两套底色,事务官也能改)。
 *
 * 读写的是 8791 `GET / POST /collab/types`(整张换,写走「改显示状态」那道门;校验 `checkWorkTypes` 与服务端同一份)。
 * 这里只管**本机这一份**(`scope: 'local'`);工作室共用一张表是另一张卡的事。没接(404)整节不出现。
 * 评审页没画这一节,样子照同页:一类一行(两块底色 + 图标 + 名字,「改」与 ✕),「改」摊开两列表单;底下「加一类」
 * 「恢复缺省四类」和一颗描边「保存类型表」。改完不点保存不生效 —— 一张表一起换,便签上的类型不会半路对不上。
 */
import { useEffect, useState } from 'react'
import { DEFAULT_WORK_TYPES, WORK_TYPE_ICONS, WORK_TYPES_MAX, checkWorkTypes, type CollabWorkTypeView, type WorkTypeIcon } from '../protocol.ts'
import { SetActions, SetBtn, SetErr, SetField, SetFields, SetLead, SetMsg, SetRow, SetSection, SetX } from './settings/setKit.tsx'
import { Icon } from './ui/icons.tsx'

/** 图标在界面上叫什么(`WORK_TYPE_ICONS` 那十六枚,不露英文图标名)。 */
export const WORK_TYPE_ICON_NAMES: Readonly<Record<WorkTypeIcon, string>> = {
  'calendar-days': '日历', 'code-2': '代码', 'pen-tool': '钢笔', 'circuit-board': '电路板',
  'list-checks': '清单', 'scan-search': '检查', 'messages-square': '对话', 'file-pen-line': '写稿',
  'megaphone': '喇叭', 'handshake': '握手', 'calculator': '计算器', 'file-check-2': '验收',
  'users-round': '人', 'headphones': '耳机', 'repeat-2': '循环', 'layers': '层叠',
}

/** 新加的那一类:还没起名,图标「层叠」,底色同缺省里「经营与其他」那一组灰。 */
function freshType(taken: readonly CollabWorkTypeView[]): CollabWorkTypeView {
  let n = taken.length + 1
  while (taken.some(one => one.id === `type-${n}`)) n += 1
  return { id: `type-${n}`, title: '', icon: 'layers', color: { dark: '#d7d8da', light: '#f0f0f1' } }
}

function isTypesPayload(body: unknown): body is { types: CollabWorkTypeView[] } {
  return typeof body === 'object' && body !== null && Array.isArray((body as { types?: unknown }).types)
}

export function ItemTypesPanel({ baseUrl, fetchImpl }: { baseUrl: string, fetchImpl?: typeof fetch }) {
  const call = fetchImpl ?? fetch
  const [saved, setSaved] = useState<readonly CollabWorkTypeView[] | null>(null)
  const [draft, setDraft] = useState<CollabWorkTypeView[]>([])
  const [editing, setEditing] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [message, setMessage] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    let alive = true
    void (async () => {
      try {
        const res = await call(`${baseUrl}/collab/types`)
        if (!res.ok) return
        const body = await res.json() as unknown
        if (!alive || !isTypesPayload(body)) return
        setSaved(body.types)
        setDraft(body.types.map(one => ({ ...one, color: { ...one.color } })))
      }
      catch { /* 读不到就整节不出现 */ }
    })()
    return () => { alive = false }
    // 依赖只列 baseUrl / fetchImpl,同 RulesPanel。
  }, [baseUrl, fetchImpl])

  if (saved === null) return null

  const dirty = JSON.stringify(draft) !== JSON.stringify(saved)
  const patch = (id: string, change: Partial<CollabWorkTypeView>): void => {
    setError(null)
    setDraft(prev => prev.map(one => (one.id === id ? { ...one, ...change } : one)))
  }

  async function save(): Promise<void> {
    const got = checkWorkTypes(draft)
    if (!got.ok) { setError(got.error); return }
    setBusy(true)
    setError(null)
    setMessage(null)
    try {
      const res = await call(`${baseUrl}/collab/types`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ types: got.types }),
      })
      const body = await res.json().catch(() => ({})) as { error?: string, types?: CollabWorkTypeView[] }
      if (!res.ok) { setError(body.error ?? '类型表没存上'); return }
      const next = Array.isArray(body.types) ? body.types : got.types
      setSaved(next)
      setDraft(next.map(one => ({ ...one, color: { ...one.color } })))
      setEditing(null)
      setMessage('存好了;协作区的卡头、图例和筛选下一拍就按新表画。')
    }
    catch { setError('工作台服务没应答') }
    finally { setBusy(false) }
  }

  return (
    <SetSection id="ben-wb-item-types" title="事项类型" aside={`本机这一份 · ${saved.length} 类`}>
      <SetLead>协作区里的便签按这张表分类:卡头图标、底色、图例和筛选都读它。事务官也能改这一张。</SetLead>

      {draft.map(one => (
        <div key={one.id} data-work-type={one.id}>
          <SetRow
            title={(
              <span className="ben-wb__stype">
                <i className="ben-wb__sswatch" style={{ background: one.color.dark }} aria-hidden="true" />
                <i className="ben-wb__sswatch" style={{ background: one.color.light }} aria-hidden="true" />
                <Icon name={one.icon} />
                <span>{one.title === '' ? '(还没起名)' : one.title}</span>
              </span>
            )}
            sub={`图标「${WORK_TYPE_ICON_NAMES[one.icon]}」· 暗色底 ${one.color.dark} · 亮色底 ${one.color.light}`}
          >
            <span className="ben-wb__srow-acts">
              <SetBtn aria-expanded={editing === one.id} onClick={() => setEditing(editing === one.id ? null : one.id)}>改</SetBtn>
              <SetBtn
                kind="icon"
                aria-label={`删掉「${one.title === '' ? '还没起名的那一类' : one.title}」`}
                disabled={draft.length <= 1}
                onClick={() => {
                  setDraft(prev => prev.filter(row => row.id !== one.id))
                  if (editing === one.id) setEditing(null)
                  setMessage('删掉的那一类,已经标着它的便签照中性灰画,便签本身不改(点「保存类型表」才生效)。')
                }}
              >
                <SetX />
              </SetBtn>
            </span>
          </SetRow>
          {editing === one.id && (
            <div className="ben-wb__srow-more">
              <SetFields>
                <SetField label="名字" full>
                  <input value={one.title} maxLength={12} placeholder="1–12 个字" onChange={event => patch(one.id, { title: event.target.value })} />
                </SetField>
                <SetField label="暗色底">
                  <input type="color" value={one.color.dark} onChange={event => patch(one.id, { color: { ...one.color, dark: event.target.value } })} />
                </SetField>
                <SetField label="亮色底">
                  <input type="color" value={one.color.light} onChange={event => patch(one.id, { color: { ...one.color, light: event.target.value } })} />
                </SetField>
              </SetFields>
              <div className="ben-wb__sicons" role="radiogroup" aria-label="图标">
                {WORK_TYPE_ICONS.map(name => (
                  <button
                    key={name}
                    type="button"
                    role="radio"
                    aria-checked={one.icon === name}
                    aria-label={WORK_TYPE_ICON_NAMES[name]}
                    title={WORK_TYPE_ICON_NAMES[name]}
                    onClick={() => patch(one.id, { icon: name })}
                  >
                    <Icon name={name} />
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>
      ))}

      {error !== null && <SetErr>{error}</SetErr>}
      <SetActions>
        <SetBtn
          kind="text"
          disabled={draft.length >= WORK_TYPES_MAX}
          onClick={() => { const next = freshType(draft); setDraft(prev => [...prev, next]); setEditing(next.id); setError(null) }}
        >
          加一类
        </SetBtn>
        <SetBtn
          kind="text"
          onClick={() => { setDraft(DEFAULT_WORK_TYPES.map(one => ({ ...one, color: { ...one.color } }))); setEditing(null); setError(null) }}
        >
          恢复缺省四类
        </SetBtn>
        <SetBtn kind="outline" disabled={busy || !dirty} onClick={() => { void save() }}>保存类型表</SetBtn>
      </SetActions>
      {message !== null && <SetMsg>{message}</SetMsg>}
    </SetSection>
  )
}
