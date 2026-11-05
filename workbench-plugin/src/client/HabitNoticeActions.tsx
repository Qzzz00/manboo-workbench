/**
 * 收件箱「新学到一条:…,正在试用」那一张上的两颗键(2026-10-10,维护者 10-09 拍板)。
 *
 * - 「撤掉」:直接撤(`POST /habits/revoke`)。不再先确认 —— 撤错了在「它学到了什么」里能恢复,回执里也这么说。
 * - 「知道了」:收掉这一句(`POST /habits/seen`),那一条照常试用。
 *
 * 点了之后把服务端回的那一句人话摆出来;真相以下一拍的 /state 为准(那一张随之消失)。同 AgentActions 的写法。
 */
import { useState } from 'react'
import type { ButlerInboxHabit } from '../protocol.ts'

export function HabitNoticeActions({ item, talk }: {
  item: { title: string, habit?: ButlerInboxHabit | undefined }
  talk?: { baseUrl: string, fetchImpl: typeof fetch } | undefined
}) {
  const [reply, setReply] = useState<string | undefined>(undefined)
  const [busy, setBusy] = useState(false)
  const habit = item.habit
  if (habit === undefined || talk === undefined) return null
  const say = async (path: string): Promise<void> => {
    setBusy(true)
    try {
      const res = await talk.fetchImpl(`${talk.baseUrl}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id: habit.id }),
      })
      const json = await res.json().catch(() => ({})) as { note?: unknown, error?: unknown }
      const text = typeof json.note === 'string' ? json.note : typeof json.error === 'string' ? json.error : undefined
      setReply(text ?? (res.ok ? '好了' : '没办成,等一下再点一次'))
    }
    catch {
      setReply('连不上工作台,等一下再点一次')
    }
    finally {
      setBusy(false)
    }
  }
  return <div className="ben-wb__particle-actions ben-wb__habit-notice-actions">
    <button type="button" disabled={busy} aria-label={`撤掉:${item.title}`} onClick={() => { void say('/habits/revoke') }}>撤掉</button>
    <button type="button" disabled={busy} aria-label={`知道了:${item.title}`} onClick={() => { void say('/habits/seen') }}>知道了</button>
    {reply !== undefined && <p role="status">{reply}</p>}
  </div>
}
