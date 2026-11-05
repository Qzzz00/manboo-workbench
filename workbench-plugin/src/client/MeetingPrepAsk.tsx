/**
 * 电脑上的会前准备(2026-10-10,卡「会前画像与预案」):球下那一区,一场待开的会一张。
 *
 * 一问一答(缺哪问问哪问,不猜)→ 目的说不清先拦(拟好一句去问组织者的话,**只给她复制,不替她发**)
 * → 预案卡全本(一个数带出处 / 一个说法 / 一个退路)。花名档案在这张卡底下展开看、删,只在这台电脑上。
 * 真相在服务端:答完由下一拍 `/state` 换掉这张卡,这里不本地乐观改。
 */
import { useState } from 'react'
import type { MeetingPrepAnswer, MeetingPrepView, MeetingView } from '../protocol.ts'

const FROM_LABEL: Record<string, string> = { said: '你那句话里说的', asked: '你答的' }

function fromOf(answer: MeetingPrepAnswer<unknown>): string {
  return answer.from === 'record' ? (answer.basis ?? '已有记录里认出的') : FROM_LABEL[answer.from] ?? ''
}

/** 收成一行时那句话。 */
export function meetingPrepRowText(meeting: MeetingView): string {
  const prep = meeting.prep
  const head = `会前:「${meeting.title}」${prep?.when === undefined ? '' : ` · ${prep.when}`}`
  if (prep === undefined) return head
  if (prep.ask !== undefined) return `${head} · 还差一问`
  if (prep.card_status === 'goal') return `${head} · 要定什么还没说清`
  if (prep.card_status === 'ready') return `${head} · 预案卡好了`
  if (prep.card_status === 'failed') return `${head} · 预案卡没做成`
  return `${head} · 预案卡在做`
}

function portraitRows(prep: MeetingPrepView): { label: string, value: string, from?: string }[] {
  const row = <T,>(label: string, answer: MeetingPrepAnswer<T> | undefined, show: (value: T) => string) =>
    answer === undefined ? { label, value: '还没答' } : { label, value: show(answer.value), from: fromOf(answer as MeetingPrepAnswer<unknown>) }
  return [
    row('内部还是外部', prep.scope, v => v),
    row('类型', prep.kind, v => v),
    row('谁来', prep.people, v => v.map(p => (p.role === undefined ? p.alias : `${p.alias}(${p.role})`)).join('、') || '没说'),
    row('谁拍板', prep.decider, v => v),
    row('你的角色', prep.my_role, v => v),
    prep.goal_unclear === true ? { label: '要定下什么', value: '还没说清' } : row('要定下什么', prep.goal, v => v),
  ]
}

export function MeetingPrepAsk({ meeting, baseUrl, fetchImpl }: { meeting: MeetingView, baseUrl: string, fetchImpl: typeof fetch }) {
  const prep = meeting.prep
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | undefined>(undefined)
  const [note, setNote] = useState<string | undefined>(undefined)
  const [archive, setArchive] = useState<{ alias: string, role?: string, last_meeting: { title: string, date: string } }[] | undefined>(undefined)
  if (prep === undefined) return null

  const send = async (path: string, body: Record<string, unknown>): Promise<boolean> => {
    if (busy) return false
    setBusy(true)
    setError(undefined)
    try {
      const res = await fetchImpl(`${baseUrl}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
      const payload = await res.json() as { ok?: boolean, error?: string, note?: string }
      if (payload.ok !== true) { setError(payload.error ?? '没办成'); return false }
      setNote(payload.note)
      return true
    }
    catch { setError('工作台服务没应答,什么都没改'); return false }
    finally { setBusy(false) }
  }
  const answer = async (value: string, question = prep.ask?.id): Promise<void> => {
    if (question === undefined || value.trim() === '') return
    if (await send('/meeting/answer', { id: meeting.id, question, answer: value })) setText('')
  }
  const copyAsk = async (): Promise<void> => {
    try { await navigator.clipboard.writeText(prep.organizer_ask ?? ''); setNote('那句话复制好了,发不发、发给谁由你。') }
    catch { setError('复制没成,照着上面那句自己发就行') }
  }
  const loadArchive = async (): Promise<void> => {
    try {
      const res = await fetchImpl(`${baseUrl}/meeting/people`)
      const payload = await res.json() as { people?: typeof archive }
      setArchive(payload.people ?? [])
    }
    catch { setError('花名档案没读到') }
  }
  const forget = async (alias: string): Promise<void> => {
    if (await send('/meeting/people/forget', { alias })) await loadArchive()
  }

  return (
    <section className="ben-wb__evolveask ben-wb__meetprep" aria-label={`会前准备:${meeting.title}`}>
      <p className="ben-wb__evolveask-head">{`会前准备:「${meeting.title}」${prep.when === undefined ? '' : ` · ${prep.when}`}`}</p>
      <dl className="ben-wb__meetprep-portrait">
        {portraitRows(prep).map(row => (
          <div key={row.label}>
            <dt>{row.label}</dt>
            <dd>{row.value}{row.from !== undefined && <small>{`(${row.from})`}</small>}</dd>
          </div>
        ))}
      </dl>
      <p className="ben-wb__evolveask-hint">参会人只记花名;花名对应谁只有你知道。</p>

      {prep.ask !== undefined && (
        <div className="ben-wb__meetprep-ask">
          <p className="ben-wb__evolveask-plan">{prep.ask.text}</p>
          {prep.ask.hint !== undefined && <p className="ben-wb__evolveask-hint">{prep.ask.hint}</p>}
          {prep.ask.choices !== undefined && (
            <div className="ben-wb__evolveask-ways">
              {prep.ask.choices.map(choice => <button key={choice} type="button" disabled={busy} onClick={() => { void answer(choice) }}>{choice}</button>)}
            </div>
          )}
          <div className="ben-wb__evolveask-name">
            <input type="text" aria-label={prep.ask.text} value={text} disabled={busy} maxLength={120} onChange={event => setText(event.target.value)}
              onKeyDown={(event) => { if (event.key === 'Enter') void answer(text) }} />
            <button type="button" disabled={busy || text.trim() === ''} onClick={() => { void answer(text) }}>答</button>
          </div>
        </div>
      )}

      {prep.card_status === 'goal' && (
        <div className="ben-wb__meetprep-goal" role="alert">
          <p className="ben-wb__evolveask-plan">这场会要定什么还没说清,先别急着备材料。可以先问问组织者:</p>
          <blockquote>{prep.organizer_ask}</blockquote>
          <p className="ben-wb__evolveask-hint">这句话只替你拟好,发不发、发给谁由你,事务官不会替你发。</p>
          <div className="ben-wb__evolveask-row">
            <button type="button" disabled={busy} onClick={() => { void copyAsk() }}>复制这句</button>
            <button type="button" disabled={busy} onClick={() => { void send('/meeting/card', { id: meeting.id, proceed: true }) }}>先照现在的准备</button>
          </div>
          <div className="ben-wb__evolveask-name">
            <input type="text" aria-label="问清楚了:这场会要定下什么" placeholder="问清楚了就写在这儿" value={text} disabled={busy} maxLength={80} onChange={event => setText(event.target.value)} />
            <button type="button" disabled={busy || text.trim() === ''} onClick={() => { void answer(text, 'goal') }}>就定这个</button>
          </div>
        </div>
      )}

      {prep.card_status === 'making' && <p className="ben-wb__evolveask-hint" role="status">预案卡在做…</p>}
      {prep.card_status === 'failed' && (
        <div className="ben-wb__evolveask-row">
          <p className="ben-wb__evolveask-err">{prep.card_error ?? '预案卡没做成'}</p>
          <button type="button" disabled={busy} onClick={() => { void send('/meeting/card', { id: meeting.id }) }}>再做一次</button>
        </div>
      )}
      {prep.card !== undefined && (
        <ol className="ben-wb__meetprep-card" aria-label="预案卡">
          {prep.card.questions.map(one => (
            <li key={one.q}>
              <p className="ben-wb__evolveask-plan"><strong>{one.q}</strong></p>
              <p>{one.number === undefined ? '一个数:没有这个数' : `一个数:${one.number.text}`}{one.number !== undefined && <small>{`(出处:${one.number.source})`}</small>}</p>
              <p>{`一个说法:${one.line}`}</p>
              <p>{`一个退路:${one.fallback}`}</p>
            </li>
          ))}
        </ol>
      )}
      {prep.card_status === 'ready' && (
        <p className="ben-wb__evolveask-hint">数只从你自己的数据里查,写明出处;查不到写「没有这个数」。手机上开会前也能看到这张卡。</p>
      )}

      <div className="ben-wb__evolveask-row">
        {prep.card_status === 'ready' && <button type="button" disabled={busy} onClick={() => { void send('/meeting/card', { id: meeting.id }) }}>重做预案卡</button>}
        <button type="button" disabled={busy} onClick={() => { void send('/meeting/drop', { id: meeting.id }) }}>这不是一场会,撤掉</button>
        <button type="button" disabled={busy} onClick={() => { if (archive === undefined) void loadArchive(); else setArchive(undefined) }}>{archive === undefined ? '花名档案' : '收起花名档案'}</button>
      </div>
      {archive !== undefined && (
        <ul className="ben-wb__evolveask-says" aria-label="花名档案">
          {archive.length === 0 && <li>档案里还没有人。</li>}
          {archive.map(person => (
            <li key={person.alias}>
              {`${person.alias}${person.role === undefined ? '' : `(${person.role})`} · 上次「${person.last_meeting.title}」${person.last_meeting.date}`}
              <button type="button" disabled={busy} aria-label={`从档案里删掉 ${person.alias}`} onClick={() => { void forget(person.alias) }}>删</button>
            </li>
          ))}
        </ul>
      )}
      {note !== undefined && <p className="ben-wb__evolveask-note" role="status">{note}</p>}
      {error !== undefined && <p className="ben-wb__evolveask-err" role="alert">{error}</p>}
    </section>
  )
}
