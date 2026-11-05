/**
 * 会议卡(2026-10-21,视觉 A 第 28、29 屏)。**会前与会后是同一张卡**:会前有议题、参与人、目标与排期;
 * 会后同一张保留纪要、已确认的决定和关联任务。会议的状态、会议时间与任务状态各自独立(会议没有章)。
 *
 * 一张卡串起:安排(时间、参与人、目标)→ 会议记录(纪要)→ 决定 → 后续任务 → 关联任务。
 * 数据全读现成的会议目录(`/state.meetings`,`server/meeting.ts`):议题取会前预案卡那几问;**决定**取纪要里标「已确定」的判断
 * (服务端读回 `decisions`);**后续任务**取纪要的「下一步」,「记成任务」走既有的 `POST /meeting/apply`。
 * 从一条决定建便签:四样照门走(来源固定为这场会 + 那句原话),建好后卡上那条挂「打开便签」(按便签来源认回来,不另存链接)。
 * 取不到的就不画,不编。
 */
import { useState } from 'react'
import type { MeetingView, TaskView } from '../../protocol.ts'
import { STAMP_TITLES } from '../../protocol.ts'
import type { CollabApi } from './collabApi.ts'
import type { RailCard } from './collabModel.ts'
import { TypeIcon } from './parts.tsx'
import { MeetingPeople } from './people.tsx'

const MEETING_STATUS: Readonly<Record<MeetingView['status'], string>> = {
  planned: '会前', recording: '在开', transcribing: '在转写', summarizing: '在整理纪要', done: '开完了', failed: '没整理成',
}

function hm(iso: string | undefined): string | undefined {
  if (iso === undefined) return undefined
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? undefined : `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

function when(meeting: MeetingView): string {
  const at = meeting.status === 'planned' ? meeting.prep?.scheduled_at : meeting.started_at
  if (at === undefined) return meeting.prep?.when ?? '还没排时间'
  const d = new Date(at)
  const day = `${d.getMonth() + 1} 月 ${d.getDate()} 日`
  const end = meeting.status === 'planned' ? undefined : hm(meeting.ended_at)
  return `${day} ${hm(at) ?? ''}${end === undefined ? '' : `–${end}`}`
}

/** 这条决定建过的便签(来源是这场会、原话就是这一句)。 */
export function decisionNote(meeting: MeetingView, decision: string, tasks: readonly TaskView[]): TaskView | undefined {
  return tasks.find(task => task.from?.kind === 'meeting' && task.from.ref === meeting.id && task.from.quote === decision)
}

function DecisionForm({ meeting, decision, cards, api, onDone, onCancel }: {
  meeting: MeetingView
  decision: string
  cards: readonly RailCard[]
  api: CollabApi
  onDone: (text: string) => void
  onCancel: () => void
}) {
  const [title, setTitle] = useState(decision)
  const [assignee, setAssignee] = useState(cards[0]?.id ?? 'me')
  const [accept, setAccept] = useState('')
  const [error, setError] = useState<string | undefined>(undefined)
  const acceptance = accept.split('\n').map(one => one.trim()).filter(one => one !== '')
  return (
    <form
      className="ben-cl__form"
      aria-label={`从决定建便签:${decision}`}
      onSubmit={(event) => {
        event.preventDefault()
        void api.post('/task/create', {
          note: true, title: title.trim(), status: 'todo', assignee, acceptance,
          from: { kind: 'meeting', ref: meeting.id, quote: decision },
        }).then((got) => { if (got.ok) onDone('便签贴上了,卡上带了会议链接'); else setError(got.error ?? '没贴上') })
      }}
    >
      <label htmlFor="cl-dec-title">便签标题</label><input id="cl-dec-title" value={title} onChange={event => setTitle(event.target.value)} />
      <label htmlFor="cl-dec-who">谁负责</label>
      <select id="cl-dec-who" value={assignee} onChange={event => setAssignee(event.target.value)}>{cards.map(one => <option key={one.id} value={one.id}>{one.name}</option>)}</select>
      <span>来源</span><span className="ben-cl__muted">这场会 ·「{decision}」</span>
      <label htmlFor="cl-dec-accept">做到什么算完</label><textarea id="cl-dec-accept" rows={2} value={accept} onChange={event => setAccept(event.target.value)} placeholder="一行一条,1–3 条" />
      {error !== undefined && <><span /><span role="alert">{error}</span></>}
      <span />
      <span>
        <button type="submit" className="ben-cl__primary" disabled={title.trim() === '' || acceptance.length === 0}>贴便签</button>
        <button type="button" onClick={onCancel}>算了</button>
      </span>
    </form>
  )
}

export function MeetingDialog({ meeting, tasks, cards = [], api, onClose, onOpenNote, onReceipt }: {
  meeting: MeetingView
  tasks: readonly TaskView[]
  /** 谁能被选成负责人(名片栏那几张)。 */
  cards?: readonly RailCard[]
  api: CollabApi
  onClose: () => void
  onOpenNote: (id: string) => void
  onReceipt: (text: string) => void
}) {
  const agenda = meeting.prep?.card?.questions.map(one => one.q) ?? []
  const decisions = meeting.decisions ?? []
  const fromDecisions = decisions.flatMap(one => { const task = decisionNote(meeting, one, tasks); return task === undefined ? [] : [task] })
  const fromTodos = meeting.todos.flatMap(todo => (todo.task_id === undefined ? [] : tasks.filter(task => task.id === todo.task_id)))
  const linked = [...new Map([...fromDecisions, ...fromTodos].map(task => [task.id, task])).values()]
  const [drafting, setDrafting] = useState<string | undefined>(undefined)
  const apply = (todoId: string): void => {
    void api.post('/meeting/apply', { id: meeting.id, todos: [todoId] }).then(got => onReceipt(got.ok ? '记成任务了' : got.error ?? '没记上'))
  }
  return (
    <div className="ben-cl__dialog-veil" onClick={onClose}>
      <div className="ben-cl__dialog ben-cl__meeting" data-type="meeting" role="dialog" aria-label={`会议:${meeting.title}`} onClick={event => event.stopPropagation()}>
        <header className="ben-cl__dlg-head">
          <TypeIcon type="meeting" size={18} />
          <h2>{meeting.title}</h2>
          <span className="ben-cl__mstatus">{MEETING_STATUS[meeting.status]}</span>
          <button type="button" className="ben-cl__icon" onClick={onClose} aria-label="关上">✕</button>
        </header>
        <section className="ben-cl__dlg-block" aria-label="安排">
          <p className="ben-cl__meta"><span>会议</span><span>{when(meeting)}</span></p>
          <p className="ben-cl__meta ben-cl__people" aria-label="参与人"><MeetingPeople meeting={meeting} /></p>
          {meeting.prep?.goal !== undefined && <p className="ben-cl__meta">目标 · {meeting.prep.goal.value}</p>}
        </section>
        <div className="ben-cl__meeting-cols">
          <div>
            {meeting.status === 'planned'
              ? (
                  <section className="ben-cl__dlg-block" aria-label="会前">
                    <h3>会前</h3>
                    {meeting.prep?.said !== undefined && meeting.prep.said !== '' && <p>{meeting.prep.said}</p>}
                    {meeting.prep?.decider !== undefined && <p className="ben-cl__muted">拍板的人 · {meeting.prep.decider.value}</p>}
                    {meeting.prep?.my_role !== undefined && <p className="ben-cl__muted">你的角色 · {meeting.prep.my_role.value}</p>}
                    {meeting.prep?.ask !== undefined && <p className="ben-cl__muted">还差一问:{meeting.prep.ask.text}</p>}
                  </section>
                )
              : (
                  <section className="ben-cl__dlg-block" aria-label="会议记录">
                    <h3>会议记录</h3>
                    {meeting.summary === undefined ? <p className="ben-cl__muted">{meeting.error ?? '纪要还没整理出来。'}</p> : <p className="ben-cl__prewrap">{meeting.summary}</p>}
                  </section>
                )}
            {meeting.status !== 'planned' && (
              <section className="ben-cl__dlg-block" aria-label="决定">
                <h3>决定</h3>
                {decisions.length === 0
                  ? <p className="ben-cl__muted">{meeting.summary === undefined ? '纪要出来后,标「已确定」的判断列在这里。' : '纪要里没有标「已确定」的判断。'}</p>
                  : (
                      <ul className="ben-cl__decisions">
                        {decisions.map((one) => {
                          const note = decisionNote(meeting, one, tasks)
                          return (
                            <li key={one}>
                              <b>{one}</b>
                              {note !== undefined
                                ? <button type="button" className="ben-cl__link" onClick={() => onOpenNote(note.id)}>打开便签 · {note.title}</button>
                                : drafting === one
                                  ? <DecisionForm meeting={meeting} decision={one} cards={cards} api={api} onCancel={() => setDrafting(undefined)} onDone={(text) => { setDrafting(undefined); onReceipt(text) }} />
                                  : <button type="button" className="ben-cl__act" onClick={() => setDrafting(one)}>建便签</button>}
                            </li>
                          )
                        })}
                      </ul>
                    )}
              </section>
            )}
            {meeting.todos.length > 0 && (
              <section className="ben-cl__dlg-block" aria-label="后续任务">
                <h3>后续任务</h3>
                <ul className="ben-cl__decisions">
                  {meeting.todos.map(todo => (
                    <li key={todo.id}>
                      <b>{todo.what}</b>
                      <span className="ben-cl__muted">{[todo.who, todo.due].filter(Boolean).join(' · ')}</span>
                      {todo.task_id === undefined
                        ? <button type="button" className="ben-cl__act" onClick={() => apply(todo.id)}>记成任务</button>
                        : <button type="button" className="ben-cl__link" onClick={() => onOpenNote(todo.task_id as string)}>打开任务</button>}
                    </li>
                  ))}
                </ul>
              </section>
            )}
            {linked.length > 0 && (
              <section className="ben-cl__dlg-block" aria-label="关联任务">
                <h3>关联任务</h3>
                {linked.map(task => (
                  <button key={task.id} type="button" className="ben-cl__linked" onClick={() => onOpenNote(task.id)}>
                    <b>{task.title}</b><span className="ben-cl__stamp" data-status={task.status}>{STAMP_TITLES[task.status]}</span>
                  </button>
                ))}
              </section>
            )}
          </div>
          <aside>
            <section className="ben-cl__dlg-block" aria-label="会前议题">
              <h3>会前议题</h3>
              {agenda.length === 0 ? <p className="ben-cl__muted">会前没备议题。</p> : <ol>{agenda.map(q => <li key={q}>{q}</li>)}</ol>}
            </section>
            {meeting.dir !== undefined && (
              <section className="ben-cl__dlg-block" aria-label="材料与原始记录">
                <h3>材料与原始记录</h3>
                <p><code>{meeting.dir}</code></p>
                {meeting.seconds !== undefined && <p className="ben-cl__muted">录音 · {Math.round(meeting.seconds / 60)} 分钟</p>}
              </section>
            )}
            {(meeting.timeline ?? []).length > 0 && (
              <section className="ben-cl__dlg-block" aria-label="经手">
                <h3>经手</h3>
                <ol className="ben-cl__timeline">{(meeting.timeline ?? []).map(mark => <li key={`${mark.at}-${mark.text}`}><time>{hm(mark.at)}</time> {mark.text}</li>)}</ol>
              </section>
            )}
          </aside>
        </div>
      </div>
    </div>
  )
}
