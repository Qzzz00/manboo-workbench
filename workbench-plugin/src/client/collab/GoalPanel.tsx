/**
 * 目标能力条件面板(2026-10-24,小K collab-desktop-1024;消费 core 契约 §1 B)。
 *
 * 从 `GET /collab/goal/board?goal_id=` 拿汇总投影(与 /state 同口径),条件按状态给文字
 * (浅状态色之外必须读得出),进度只按条件算;核验/交付/增删走契约端点,服务端 409 的原话
 * 原样给人看。退回/重开使旧轮核验失效(服务端算好 state,这里把 verifications 里
 * round 不符的标注「旧轮」)。接口不在(老服务)= 这块明说还没接上,不编条件。
 */
import { useEffect, useRef, useState } from 'react'
import type { CollabGoal, GoalBoardSummary, GoalCondition, GoalConditionState, TaskView, WorkbenchState } from '../../protocol.ts'
import type { CollabApi } from './collabApi.ts'
import { GOAL_CONDITION_TITLES, GOAL_STATUS_TITLES } from './collabContract.ts'
import { usePeople } from './people.tsx'
import { useAssigneeName } from '../meName.tsx'

function clock(at: string | undefined): string {
  if (at === undefined) return ''
  const d = new Date(at)
  if (Number.isNaN(d.getTime())) return ''
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${pad(d.getMonth() + 1)}/${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

/** 核验键什么时候可按:承接任务交回待验/做完才有成果可验(服务端同样拒,这里先说清)。 */
function verifiable(state: GoalConditionState): boolean {
  return state === 'submitted' || state === 'verified' || state === 'delivered' || state === 'rework'
}

function ConditionRow({ item, history, currentRound, tasks, onOpenTask, goalId, api, nameOf, onChanged, stale }: {
  item: GoalBoardSummary['conditions']['items'][number]
  history: GoalCondition | undefined
  currentRound: number | undefined
  tasks: readonly TaskView[]
  onOpenTask: (taskId: string) => void
  goalId: string
  api: CollabApi
  nameOf: (id: string | undefined) => string
  onChanged: (note: string) => void
  stale: boolean
}) {
  const [note, setNote] = useState('')
  const [inFlight, setBusy] = useState(false)
  const busy = inFlight || stale
  const [taskId, setTaskId] = useState(item.task_id ?? '')
  const savedEvidence = (history?.evidence ?? []).join('\n')
  const [evidence, setEvidence] = useState(savedEvidence)
  useEffect(() => setTaskId(item.task_id ?? ''), [item.task_id])
  useEffect(() => setEvidence(savedEvidence), [savedEvidence])
  const act = async (path: string, body: Record<string, unknown>, ok: string): Promise<void> => {
    setBusy(true)
    const got = await api.post(path, body)
    setBusy(false)
    onChanged(got.ok ? ok : got.error ?? '没办成')
  }
  const currentTask = tasks.find(one => one.id === item.task_id)
  const canVerify = verifiable(item.state) && (currentTask === undefined ? item.state !== 'rework' : currentTask.status === 'confirm' || currentTask.status === 'done')
  return (
    <li className="ben-cl__gc-item" data-state={item.state}>
      <div className="ben-cl__gc-main">
        <span className="ben-cl__gc-text">{item.text}</span>
        <span className="ben-cl__gc-state" data-state={item.state}>{item.state === 'pending' && item.task_id !== undefined ? '尚未开始' : GOAL_CONDITION_TITLES[item.state]}</span>
        {item.state === 'pending' && item.task_id === undefined && <small className="ben-cl__muted">还没安排给谁做</small>}
        {item.assignee !== undefined && <small className="ben-cl__muted">承接 · {nameOf(item.assignee)}</small>}
        {item.last_receipt_at !== undefined && <small className="ben-cl__muted">最近回执 {clock(item.last_receipt_at)}</small>}
        {item.blocker?.reason !== undefined && <small className="ben-cl__gc-blocked">受阻:{item.blocker.reason}{item.blocker.next !== undefined ? ` · 下一步 ${item.blocker.next}` : ''}</small>}
        {(history?.verifications.length ?? 0) > 0 && (
          <ol className="ben-cl__muted" aria-label={`${item.text} 的核验记录`}>
            {history?.verifications.map((verification, index) => (
              <li key={`${verification.at}-${index}`}>
                第 {verification.round} 轮 · {verification.pass ? '核验通过' : '验收退回'} · {nameOf(verification.by)} · {clock(verification.at)}
                {currentRound !== undefined && verification.round !== currentRound && <b> · 旧轮证据</b>}
                {verification.note !== undefined && ` · ${verification.note}`}
              </li>
            ))}
          </ol>
        )}
      </div>
      <div className="ben-cl__gc-acts">
        <label>承接事项
          <select aria-label={`承接事项 · ${item.text}`} value={taskId} onChange={event => setTaskId(event.target.value)}>
            <option value="" disabled>选一件承接事项…</option>
            {item.task_id !== undefined && !tasks.some(one => one.id === item.task_id) && <option value={item.task_id}>{item.task_id}（当前快照未找到）</option>}
            {tasks.filter(one => one.casual !== true).map(one => <option key={one.id} value={one.id}>{one.title}</option>)}
          </select>
        </label>
        <label>验收证据
          <textarea aria-label={`验收证据 · ${item.text}`} value={evidence} placeholder="每行一条路径、链接或验收编号" onChange={event => setEvidence(event.target.value)} />
        </label>
        <button type="button" disabled={busy} onClick={() => { void act('/collab/goal/condition/save', { goal_id: goalId, id: item.id, text: item.text, ...(taskId === '' ? {} : { task_id: taskId }), evidence: evidence.split('\n').map(one => one.trim()).filter(Boolean) }, '承接与证据存好了') }}>保存承接与证据</button>
        {item.task_id !== undefined && <button type="button" className="ben-cl__link" onClick={() => onOpenTask(item.task_id!)}>查看承接事项</button>}
      </div>
      <div className="ben-cl__gc-acts">
        {canVerify
          ? (
              <>
                <input aria-label="核验依据" value={note} placeholder="核验依据(真机/链接/编号)" onChange={event => setNote(event.target.value)} />
                <button type="button" disabled={busy} onClick={() => { void act('/collab/goal/condition/verify', { goal_id: goalId, condition_id: item.id, by: 'me', pass: true, ...(note.trim() === '' ? {} : { note: note.trim() }) }, '核验通过,留痕了') }}>核验通过</button>
                <button type="button" className="ben-cl__secondary" disabled={busy} onClick={() => { void act('/collab/goal/condition/verify', { goal_id: goalId, condition_id: item.id, by: 'me', pass: false, ...(note.trim() === '' ? {} : { note: note.trim() }) }, '记下了:这条退回重做') }}>验收不过</button>
              </>
            )
          : <small className="ben-cl__muted">成果还没交回,没得验</small>}
        {item.state === 'verified' && <button type="button" className="ben-cl__primary" disabled={busy} onClick={() => { void act('/collab/goal/condition/deliver', { goal_id: goalId, condition_id: item.id }, '交付记上了') }}>记交付</button>}
        <button type="button" className="ben-cl__link" disabled={busy} onClick={() => { void act('/collab/goal/condition/remove', { goal_id: goalId, condition_id: item.id }, '这条条件删了(任务不动)') }}>删</button>
      </div>
    </li>
  )
}

export function GoalPanel({ goal, api, onOpenTask, onClose, snapshotKey }: {
  goal: CollabGoal
  api: CollabApi
  /** 上游 /state.tasks 快照变化时重读派生条件,同步外部事项的交付与退回。 */
  snapshotKey?: WorkbenchState['tasks']
  /** 定位承接任务(回板/详情)。 */
  onOpenTask: (taskId: string) => void
  onClose: () => void
}) {
  const [board, setBoard] = useState<GoalBoardSummary | undefined | null>(undefined)
  const [note, setNote] = useState<string | undefined>(undefined)
  const [draft, setDraft] = useState('')
  const [offline, setOffline] = useState(false)
  const request = useRef(0)
  const activeGoal = useRef(goal.id)
  const alive = useRef(true)
  activeGoal.current = goal.id
  useEffect(() => { alive.current = true; return () => { alive.current = false } }, [])
  const load = (): void => {
    if (!alive.current) return
    const seq = ++request.current
    // 实际回包是 { summary } 一层壳(契约 §1 实现照实消费)。
    void api.get<{ summary?: GoalBoardSummary }>(`/collab/goal/board?goal_id=${encodeURIComponent(goal.id)}`).then((got) => {
      if (!alive.current || activeGoal.current !== goal.id || seq !== request.current) return
      if (got?.summary === undefined) { setOffline(true); setBoard(previous => previous ?? null); return }
      setOffline(false)
      setBoard(got.summary)
    })
  }
  useEffect(() => { load(); return () => { request.current += 1 } }, [api, goal.id, snapshotKey])
  const fallbackName = useAssigneeName()
  const people = usePeople()
  const nameOf = (id: string | undefined): string => people.cards.find(card => card.id === id)?.name ?? fallbackName(id)
  const items = board?.conditions.items ?? []
  const historyOf = (id: string): GoalCondition | undefined => goal.conditions?.find(one => one.id === id)
  const roundOf = (id: string | undefined): number | undefined => {
    const task = snapshotKey?.tasks.find(one => one.id === id)
    return task === undefined ? undefined : task.round ?? 1
  }
  return (
    <div className="ben-cl__dialog-veil" onClick={onClose}>
      <div className="ben-cl__dialog ben-cl__goalpanel" role="dialog" aria-label={`目标条件 · ${goal.title}`} onClick={event => event.stopPropagation()}>
        <header className="ben-cl__dlg-head">
          <h2>目标条件 · {goal.title}<span className="ben-cl__gap" data-status={goal.status}>{GOAL_STATUS_TITLES[goal.status]}</span></h2>
          <div className="ben-cl__dlg-nav"><button type="button" onClick={onClose} aria-label="关上">✕</button></div>
        </header>
        {board === undefined && <p className="ben-cl__muted" role="status">在读……</p>}
        {board === null && <p className="ben-cl__muted" role="status">这个目标的条件账还没接上(老服务),这里不编条件。</p>}
        {board !== undefined && board !== null && (
          <>
            {offline && <p role="status" className="ben-cl__muted">条件账暂时读不到，保留上次已知条件；恢复连接后再操作。</p>}
            <p className="ben-cl__muted ben-cl__gc-scope">{board.scope}</p>
            <p className="ben-cl__muted">
              按条件算:已验收 {board.conditions.by_state.verified ?? 0} · 已交付 {board.conditions.by_state.delivered ?? 0} · 交回待验 {board.conditions.by_state.submitted ?? 0} · 受阻 {board.conditions.by_state.blocked ?? 0} · 尚未安排 {board.conditions.by_state.pending ?? 0}
              / 共 {board.conditions.total} 条;事项 {board.tasks.total} 件只做工作分布,取消 {board.tasks.canceled} 件,不算进达成。
            </p>
            <ul className="ben-cl__gc-list">
              {items.map((item) => (
                <ConditionRow key={item.id} item={item} history={historyOf(item.id)} currentRound={roundOf(item.task_id)} tasks={snapshotKey?.tasks ?? []} onOpenTask={onOpenTask} goalId={goal.id} api={api} nameOf={nameOf} stale={offline} onChanged={(text) => { setNote(text); load() }} />
              ))}
              {items.length === 0 && <li className="ben-cl__muted">这个目标还没有能力条件;写用户能做成的事,不是「交接完成」这种标题。</li>}
            </ul>
            <form
              className="ben-cl__gc-add"
              onSubmit={(event) => {
                event.preventDefault()
                const text = draft.trim()
                if (text === '') return
                void api.post('/collab/goal/condition/save', { goal_id: goal.id, text }).then((got) => {
                  if (!got.ok) { setNote(got.error ?? '没加上的'); return }
                  setDraft('')
                  setNote('条件加上了')
                  load()
                })
              }}
            >
              <input aria-label="新条件(用户能做成的一件事)" value={draft} onChange={event => setDraft(event.target.value)} placeholder="例如:提起听筒三秒内接通" />
              <button type="submit" className="ben-cl__primary" disabled={offline || draft.trim() === ''}>加条件</button>
            </form>
            {note !== undefined && <p className="ben-cl__receipt-inline" role="status">{note}</p>}
          </>
        )}
      </div>
    </div>
  )
}
