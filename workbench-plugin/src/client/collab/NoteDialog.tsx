import type { StampChoice } from './collabModel.ts'
import { groupFacts, isTaskGroup } from './taskGroup.ts'
/**
 * 点便签开的弹窗(设计稿 3.6;维护者 10-21:「点击事项卡的时候,能不能打开一个弹窗,让我能看到全部……」)。
 *
 * 七块,数据今天大半都有,缺的是拼在一处:头 · 前因后果 · 经手(含工具级执行回放)· 各阶段产出 · 文件与仓库 · 留言 · 等他的。
 * 不是新页面:浮在画布上,←/→ 切相邻便签,Esc 关。改动一律走既有的路(`/task/update`、`/task/move`、`/task/comment`)。
 */
import { useEffect, useMemo, useState } from 'react'
import type {
  AgentEntryView, CollabGoal, ItemContinueView, ItemSayIntent, SessionTranscriptEntry, SessionTranscriptView, TaskAssignee, TaskView, WorkbenchState,
} from '../../protocol.ts'
import {
  ASSIGNEE_PICKER_PEOPLE, NOTE_FROM_TITLES, OWNER_ASK_TITLES, RECEIPT_TITLES, TASK_PRIORITIES, UNSORTED_GOAL_ID, assigneeName, boardAssignee,
  friendlyWhen, noteFromOf, ownerAskOf,
} from '../../protocol.ts'
import { ItemControls } from '../ItemControls.tsx'
import { TaskConditionFacts } from '../TaskConditionFacts.tsx'
import { PRIORITY_TITLES } from '../boardModel.ts'
import { buildButlerScene, isEvidenceProposal } from '../butlerSceneModel.ts'
import { executorLine, hasItemControls } from './detailUnion.ts'
import { TaskTraceStrip } from './TraceRail.tsx'
import { ItemTalk } from '../ItemTalk.tsx'
import { workTypeOf } from '../../protocol.ts'
import { useAssigneeName } from '../meName.tsx'
import { managerOf } from './identity.ts'
import { useWorkTypes } from './workTypes.tsx'
import { Stamp } from './parts.tsx'
import { NoteTalk } from './NoteTalk.tsx'
import { RelationsPanel } from './RelationsPanel.tsx'
import { RunsPanel } from './RunsPanel.tsx'
import type { CollabApi } from './collabApi.ts'
import { moveAlong } from './collabApi.ts'
import type { RailCard } from './collabModel.ts'
import { noteCost, receiptBody, replaySources, stampChoices } from './collabModel.ts'

/** 账上的那几步怎么念(经手时间线)。 */
const STEP_TITLES: Readonly<Record<string, string>> = {
  assigned: '派给', sent: '送进去了', seen: '看见送到了', started: '真实开工', replied: '交回来了', timeout: '等过头了', unreadable: '读不到它的窗',
  not_sent: '没送出去', waiting: '排着队等', done: '收了', called: '打了电话', no_call: '没打电话',
  gate_pass: '动作闸放行', gate_block: '动作闸拦下', budget_stop: '到上限先停下',
}

interface JobEventView { at: string, step: string, family?: string, why?: string }

function clock(at: string): string {
  const d = new Date(at)
  if (Number.isNaN(d.getTime())) return at
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${d.getMonth() + 1}/${d.getDate()} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

export interface NoteDialogProps {
  task: TaskView
  state: WorkbenchState
  goals: readonly CollabGoal[]
  cards: readonly RailCard[]
  entries: readonly AgentEntryView[]
  api: CollabApi
  baseUrl: string
  fetchImpl: typeof fetch
  assigneeText: (task: TaskView) => string
  /** 打开时直接滚到留言那一块(对话气泡「放大」)。 */
  focusTalk?: boolean
  onClose: () => void
  onPrev?: () => void
  onNext?: () => void
  onFlyGoal: (goalId: string) => void
  onReceipt: (text: string) => void
  /** 关系面板跳到另一张卡(可选;给了才画关系那一段)。 */
  onOpenTask?: ((taskId: string) => void) | undefined
}

export function NoteDialog(props: NoteDialogProps) {
  const nameOf = useAssigneeName()
  const { task, state, goals, cards, entries, api, baseUrl, fetchImpl, onClose, onPrev, onNext, onFlyGoal, onReceipt } = props
  const grouped = isTaskGroup(task)
  const group = groupFacts(task, state.tasks?.tasks ?? [])
  const round = task.round ?? 1
  const goal = goals.find(one => one.id === task.goal_id)
  const types = useWorkTypes()
  const factType = types.find(one => one.id === workTypeOf(task))
  const from = noteFromOf(task)
  // 管理(2026-10-27):只读卡上记下的,缺席不画这一行。
  const manager = managerOf(task)
  const cost = noteCost(task, state.tasks?.session_usage ?? {})
  const project = state.projects?.projects.find(one => one.id === task.project_id)
  const meta = state.tasks?.project_meta.find(one => one.project_id === task.project_id)

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      const typing = event.target instanceof HTMLElement && /^(INPUT|TEXTAREA|SELECT)$/.test(event.target.tagName)
      if (event.key === 'Escape') { onClose(); return }
      if (typing) return
      if (event.key === 'ArrowLeft') onPrev?.()
      if (event.key === 'ArrowRight') onNext?.()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose, onPrev, onNext])

  const done = async (failed: string | undefined, ok: string): Promise<void> => { onReceipt(failed ?? ok) }
  const update = async (patch: Record<string, unknown>, ok: string): Promise<void> => {
    const got = await api.post('/task/update', { id: task.id, ...patch })
    await done(got.ok ? undefined : got.error, ok)
  }

  // —— 改卡名(2026-10-23,卡 A):人的手盖过来源 —— 服务端从此不再拿来源会话的名覆盖这张。
  const [renaming, setRenaming] = useState(false)
  const [nameDraft, setNameDraft] = useState(task.title)
  const commitName = (): void => {
    const next = nameDraft.trim()
    setRenaming(false)
    if (next === '' || next === task.title) return
    void update({ title: next }, '卡名改好了')
  }

  // —— 继续这件事(2026-10-23,卡 A):来源与结果都由服务端说,这里只摆与选 ——
  const [cont, setCont] = useState<ItemContinueView | undefined>(undefined)
  const [contTarget, setContTarget] = useState<string | undefined>(undefined)
  const [contText, setContText] = useState('')
  const [contNote, setContNote] = useState<{ ok: boolean, text: string } | undefined>(undefined)
  const [contSending, setContSending] = useState(false)
  /**
   * 这句怎么递(2026-10-26,卡「事务官机制A」):补充 / 改方向 / 催一下(撤回走旁边那颗键,
   * 它允许不带字)。缺省补充 —— 发送不带 intent 字段,与卡 A 之前逐字一致。
   */
  const [contIntent, setContIntent] = useState<ItemSayIntent>('supplement')
  /**
   * ★ 请求号绑**整个动作包**(2026-10-23 复审 Important 3):同一个包(同事项 + 同目标/同档 + 同一句)
   * 重试才复用同一个号;换了目标 / 换了 record 档 / 换了字,就是另一个动作,换新号 ——
   * 电脑那头的台账按号只办一次,号不能跨动作复用。
   */
  const [lastPackage, setLastPackage] = useState<string | undefined>(undefined)
  const [lastKey, setLastKey] = useState<string | undefined>(undefined)
  const contSendable = (cont?.sources ?? []).filter(one => one.action.kind !== 'none')
  const contBlocked = (cont?.sources ?? []).filter(one => one.action.kind === 'none')
  /** 草稿按事项留着(关详情、切邻卡都不丢;换事项不串稿):localStorage 一格一事。 */
  const draftKey = `ben-wb.continue-draft.${task.id}`
  /** 人动过这一格才许写存档 —— 挂载那一拍不能拿空框把存的草稿盖掉(读取是异步的)。 */
  const [contDirty, setContDirty] = useState(false)
  useEffect(() => {
    let alive = true
    void api.get<ItemContinueView>(`/butler/item/${encodeURIComponent(task.id)}/continue`).then(view => {
      // 旧工作台没有这条路(或回了个认不出的形状):这一段不摆,别的照常。
      if (!alive || view === undefined || !Array.isArray(view.sources)) return
      setCont(view)
      const sendable = view.sources.filter(one => one.action.kind !== 'none')
      /*
       * ★ 歧义不代选(复审 Important 1):只有一条能续 = 没有歧义,直接用那一条;
       * 多条能续 = 要人自己选,「数组第一条」不是用户的选择。草稿里存过明确选择的,
       * restored 回来(选过的那条这会儿还得能续)。
       */
      setContTarget(sendable.length === 1 ? sendable[0]?.key : undefined)
      try {
        const raw = localStorage.getItem(draftKey)
        if (raw === null) return
        const draft = JSON.parse(raw) as { text?: unknown, target?: unknown, intent?: unknown }
        if (typeof draft.text === 'string' && draft.text !== '') setContText(draft.text)
        if (typeof draft.target === 'string' && sendable.some(one => one.key === draft.target)) {
          setContTarget(draft.target)
        }
        if (draft.intent === 'redirect' || draft.intent === 'hurry') setContIntent(draft.intent)
      }
      catch { /* 草稿读不懂就当没有 */ }
    })
    return () => { alive = false }
  }, [api, task.id, draftKey])
  useEffect(() => {
    if (!contDirty) return
    try { localStorage.setItem(draftKey, JSON.stringify({ text: contText, target: contTarget ?? null, ...(contIntent === 'supplement' ? {} : { intent: contIntent }) })) }
    catch { /* 存不下不挡发送 */ }
  }, [draftKey, contText, contTarget, contIntent, contDirty])
  const newContinueKey = (): string => {
    try {
      const uuid: string | undefined = globalThis.crypto?.randomUUID?.()
      if (typeof uuid === 'string' && uuid !== '') return `nc-${uuid}`
    }
    catch { /* 老环境没有 randomUUID */ }
    return `nc-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
  }
  /**
   * 发这一句(2026-10-26 起带意图):record 档永远纯留言(不带意图);
   * 撤回允许空原话(意图本身就是交代)。意图是动作包的一部分 —— 换意图 = 换号新账。
   */
  const contSend = async (record: boolean, intentOverride?: ItemSayIntent): Promise<void> => {
    const effIntent = record ? 'supplement' as const : intentOverride ?? contIntent
    const text = contText.trim()
    if ((text === '' && effIntent !== 'recall') || contSending) return
    // 动作包:同事项 + 发给谁(或 record 档)+ 原话 + 意图。包没变 = 上一次没办成的重试,复用号。
    const pkg = JSON.stringify({ id: task.id, aim: record ? 'record' : contTarget ?? '', text, intent: effIntent })
    const key = pkg === lastPackage && lastKey !== undefined ? lastKey : newContinueKey()
    setLastPackage(pkg)
    setLastKey(key)
    setContSending(true)
    setContNote(undefined)
    const got = await api.post('/butler/item/continue', {
      id: task.id,
      text,
      client_key: key,
      ...(record ? { record: true } : contTarget === undefined ? {} : { target: contTarget }),
      // 补充是缺省档:不带 intent 字段,老服务端 / 卡 A 之前的行为逐字兼容。
      ...(effIntent === 'supplement' ? {} : { intent: effIntent }),
    })
    setContSending(false)
    if (!got.ok) { setContNote({ ok: false, text: got.error ?? '没办成,稍后再试' }); return }
    const body = got.body as { ok?: boolean, note?: string, fact?: string }
    if (body.fact === 'pick') { setContNote({ ok: false, text: body.note ?? '这件事连着好几条会话,选一条再发。' }); return }
    setContNote({ ok: body.ok === true, text: body.note ?? (body.ok === true ? '送到了' : '没办成') })
    // 送出去了才清稿(本地那份草稿一起清);没送成留着 —— 那句话还没落地,清了就是替他丢话。
    if (body.ok === true) {
      setContText('')
      setContDirty(false)
      try { localStorage.removeItem(draftKey) } catch { /* 同上 */ }
    }
  }

  // —— 经手:任务账的那几步 ——
  const [events, setEvents] = useState<readonly JobEventView[] | undefined>(undefined)
  useEffect(() => {
    let alive = true
    void api.get<{ events?: JobEventView[] }>(`/jobs/${encodeURIComponent(task.id)}/trace`).then((got) => {
      if (alive) setEvents(got?.events ?? [])
    })
    return () => { alive = false }
  }, [api, task.id, task.updated_at])

  // —— 验收:改 ——
  const [editingAcceptance, setEditingAcceptance] = useState(false)
  const [acceptanceDraft, setAcceptanceDraft] = useState('')

  // —— 验收意见(带结论的留言:通过 / 改一改 / 我自己改) ——
  // 2026-10-26(卡「事务官页接管队列」):章在「等我确认」、事务官还没标四类拍板请求的,先由事务官核验;
  // 不拦他本人动手(他是负责人),但把话说在前头。
  const butlerReviewing = task.status === 'confirm' && ownerAskOf(task) === undefined
  const [comment, setComment] = useState('')
  const say = async (verdict?: 'pass' | 'rework' | 'self'): Promise<void> => {
    if (grouped && verdict !== undefined) return
    const text = comment.trim() === '' && verdict === 'pass' ? '通过' : comment.trim()
    if (text === '') return
    const said = await api.post('/task/comment', { id: task.id, text, ...(verdict === undefined ? {} : { verdict }) })
    if (!said.ok) { onReceipt(said.error ?? '没留上'); return }
    setComment('')
    if (verdict === 'pass') {
      const path = stampChoices(task.status).find(one => one.status === 'done')?.path
      await done(path === undefined ? '这张现在点不了做完' : await moveAlong(api, task.id, path), '通过了,章盖成「做完」')
    }
    else if (verdict === 'rework') {
      const path = stampChoices(task.status).find(one => one.status === 'doing')?.path
      const moved = path === undefined ? undefined : await moveAlong(api, task.id, path)
      // 有事务官那条会话就把这句话捎过去;没有就记在留言里(他回来看得见)。
      if (task.conversation !== undefined && task.conversation.archived_at === undefined) {
        await api.post('/butler/item/say', { id: task.id, text })
      }
      await done(moved, '记下了,章回到「在做」')
    }
    else if (verdict === 'self') {
      await update({ assignee: 'me' }, `记下了:这张你自己改,负责人换成${nameOf('me')}`)
    }
    else onReceipt('留言记下了')
  }

  // —— 负责人那一排:你、事务官、本机几家、登记过的名片(「同事 / 别人」退休)——
  const picker: { id: TaskAssignee | string, name: string }[] = [
    ...ASSIGNEE_PICKER_PEOPLE.map(id => ({ id, name: nameOf(id) })),
    ...entries.filter(entry => entry.self !== true && entry.id !== 'dsh').map(entry => ({ id: entry.id, name: entry.name })),
    ...cards.filter(card => card.kind === 'card').map(card => ({ id: card.id, name: card.name })),
  ]
  const current = boardAssignee(task.assignee)
  // 这张便签上有没有在等他答的问 / 要批的权限(没有、也没开过事务官会话,就不摆那一段对话的壳)。
  const waitingAsks = (state.questions ?? []).some(one => one.task_id === task.id) || (state.approvals ?? []).some(one => one.task_id === task.id)

  /*
   * 原事务官页详情独有的几样(2026-10-27,合并稿第六节):执行者状态与「要不要加」与事务官页读同一个模型,
   * 不在这里另推一遍判据;按键走的也是事务官页那几条路(`/task/move`、`/butler/item/*`)。
   */
  const sceneItem = useMemo(() => buildButlerScene(state).items.find(one => one.id === task.id), [state, task.id])
  const executors = sceneItem?.executors ?? []
  const ownerAsk = ownerAskOf(task)
  const proposal = isEvidenceProposal(task)
  const conditionGoal = goals.find(one => one.id === task.goal_id && (one.conditions ?? []).some(c => c.task_id === task.id))
  const move = (status: 'done' | 'todo' | 'canceled', ok: string, fail: string): void => {
    void (async () => {
      try {
        const res = await fetchImpl(`${baseUrl}/task/move`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: task.id, status }) })
        const body = await res.json() as { ok?: boolean, error?: string }
        onReceipt(res.ok === false || body.ok !== true ? body.error ?? fail : ok)
      } catch { onReceipt('没送到,工作台服务没应答') }
    })()
  }
  const controls = <ItemControls task={task} sessions={state.sessions ?? []} baseUrl={baseUrl} fetchImpl={fetchImpl} />

  return (
    <div className="ben-cl__dialog-veil" onClick={onClose}>
      <div className="ben-cl__dialog" role="dialog" aria-label={`便签:${task.title}`} onClick={event => event.stopPropagation()}>
        <header className="ben-cl__dlg-head">
          <Stamp status={grouped ? group.status : task.status} {...(grouped ? {} : { onPick: (choice: StampChoice) => { if (choice.path !== undefined) void moveAlong(api, task.id, choice.path).then(failed => onReceipt(failed ?? `章盖成「${choice.stamp}」`)) } })} />
          {renaming
            ? (
              <input
                aria-label="卡名"
                value={nameDraft}
                autoFocus
                onChange={event => setNameDraft(event.target.value)}
                onBlur={commitName}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') commitName()
                  if (event.key === 'Escape') { setNameDraft(task.title); setRenaming(false) }
                }}
              />
            )
            : <h2>{task.title}</h2>}
          {round > 1 && <span className="ben-cl__round" title="验收退回/重开过,这是新轮次;旧轮核验已失效">第 {round} 轮</span>}
          <button
            type="button"
            className="ben-cl__link"
            aria-label="改卡名"
            onClick={() => { setNameDraft(task.title); setRenaming(true) }}
          >
            修改事项名称
          </button>
          <div className="ben-cl__dlg-nav">
            <button type="button" onClick={onPrev} disabled={onPrev === undefined} aria-label="上一张">←</button>
            <button type="button" onClick={onNext} disabled={onNext === undefined} aria-label="下一张">→</button>
            <button type="button" onClick={onClose} aria-label="关上">✕</button>
          </div>
        </header>

        {/* 合并稿第六节:中间是轨迹、待你处理、过程与交流;右栏是背景与安排。窄了自动排成一栏。 */}
        <div className="ben-cl__dlg-cols">
          <div className="ben-cl__dlg-main">
            {task.goal_id !== undefined && task.goal_id !== UNSORTED_GOAL_ID && (
              <TaskTraceStrip api={api} goalId={task.goal_id} taskId={task.id} snapshotKey={task.updated_at} nameOf={nameOf} />
            )}

            {!grouped && (ownerAsk !== undefined || proposal) && (
              <section className="ben-cl__dlg-block ben-cl__dlg-asks" aria-label="待你处理">
                <h3>待你处理</h3>
                {ownerAsk !== undefined && <div className="ben-cl__dlg-ask">
                  <p>{`要拍板:${OWNER_ASK_TITLES[ownerAsk.kind]}`}</p>
                  <p>{`方案:${ownerAsk.proposal}`}</p>
                  <p className="ben-cl__muted">{`依据:${ownerAsk.basis}`}</p>
                  <div className="ben-cl__dlg-actions">
                    <button type="button" aria-label={`确认收下:${task.title}`} onClick={() => move('done', '确认已送达,等待服务端更新事项状态', '确认未完成,请稍后重试')}>确认</button>
                  </div>
                </div>}
                {proposal && <div className="ben-cl__dlg-ask">
                  <p>证据里冒出来的下一步,要不要加?</p>
                  <div className="ben-cl__dlg-actions">
                    <button type="button" aria-label={`加上这张卡:${task.title}`} onClick={() => move('todo', '加上了,在看板「待办」里', '没改成,请稍后重试')}>加上</button>
                    <button type="button" aria-label={`不要这张卡:${task.title}`} onClick={() => move('canceled', '不要了,这张改成取消', '没改成,请稍后重试')}>不要</button>
                  </div>
                </div>}
              </section>
            )}

            {!grouped && hasItemControls(task, state.sessions ?? []) && (
              <section className="ben-cl__dlg-block ben-cl__dlg-intervene" aria-label="干预">
                <h3>干预</h3>
                {controls}
              </section>
            )}

            {(task.progress !== undefined || executors.length > 0) && (
              <section className="ben-cl__dlg-block" aria-label="现在到哪">
                <h3>现在到哪</h3>
                {task.progress !== undefined && <>
                  <p data-state={task.progress.state}>{task.progress.line}</p>
                  {task.progress.state === 'mismatch' && task.progress.mismatch !== undefined && <p>和卡上写的对不上:{task.progress.mismatch}</p>}
                  {task.progress.basis[0] !== undefined && <p className="ben-cl__muted">依据:{task.progress.basis[0].source}{task.progress.basis[0].at ? ` · ${friendlyWhen(task.progress.basis[0].at, state.now)}` : ''} · {friendlyWhen(task.progress.checked_at, state.now)} 看的</p>}
                </>}
                {executors.map(one => <p key={one.id} className="ben-cl__dlg-executor"><b>{assigneeName(one.id.split(':')[0] ?? '')}</b> {executorLine(one)}</p>)}
              </section>
            )}

            <section className="ben-cl__dlg-block" aria-label="经手">
              <h3>经手</h3>
              {events === undefined && <p className="ben-cl__muted">在读……</p>}
              {events !== undefined && events.length === 0 && task.receipt === undefined && <p className="ben-cl__muted">账上还没有这件事的经手记录。</p>}
              <ol className="ben-cl__timeline">
                {(events ?? []).map(one => (
                  <li key={`${one.at}-${one.step}-${one.family ?? ''}`}>
                    <time>{clock(one.at)}</time> {STEP_TITLES[one.step] ?? one.step}{one.family === undefined ? '' : ` · ${assigneeName(one.family)}`}{one.why === undefined ? '' : ` —— ${one.why}`}
                  </li>
                ))}
                {task.receipt !== undefined && (
                  <li data-kind="receipt">
                    <time>{clock(task.receipt.at)}</time> 回执 · {RECEIPT_TITLES[task.receipt.kind]}{task.receipt.by === undefined ? '' : ` · ${nameOf(task.receipt.by)}`}:{receiptBody(task.receipt.text)}
                  </li>
                )}
              </ol>
              <h4>运行片段(实际;计划时间在上面「时间」改)</h4>
              <RunsPanel key={task.id} taskId={task.id} api={api} snapshotKey={state.tasks} />
              <Replay task={task} baseUrl={baseUrl} fetchImpl={fetchImpl} />
            </section>

            <section className="ben-cl__dlg-block" aria-label="各阶段产出">
              <h3>各阶段产出</h3>
              {(task.deliverables ?? []).length === 0 && (task.receipt?.evidence ?? []).length === 0 && <p className="ben-cl__muted">还没有交回来的东西。</p>}
              <ul>
                {(task.receipt?.evidence ?? []).map(one => <li key={`ev-${one}`}><code>{one}</code>(回执带的证据)</li>)}
                {(task.deliverables ?? []).map((one, index) => (
                  <li key={`${one.kind}-${index}`}>{one.kind === 'reply' ? '回答' : one.kind}:{one.ref.length > 240 ? `${one.ref.slice(0, 240)}…` : one.ref}</li>
                ))}
              </ul>
            </section>

            {cont !== undefined && (
              <section className="ben-cl__dlg-block" aria-label="继续这件事">
                <h3>继续这件事</h3>
                {cont.sources.length === 0 && <p className="ben-cl__muted">{cont.note ?? '这件事没有连着能接续的会话。'}</p>}
                {contSendable.length > 1 && (
                  <select aria-label="发给哪一条会话" value={contTarget ?? ''} onChange={(event) => { setContDirty(true); setContTarget(event.target.value === '' ? undefined : event.target.value) }}>
                    <option value="">选一条会话……</option>
                    {contSendable.map(one => <option key={one.key} value={one.key}>{one.title}</option>)}
                  </select>
                )}
                {contSendable.length === 1 && <p className="ben-cl__muted">发给:{contSendable[0]?.title}</p>}
                {contBlocked.map(one => (
                  <p key={one.key} className="ben-cl__muted">{one.title}:{one.action.kind === 'none' ? one.action.why : ''}</p>
                ))}
                <select
                  aria-label="这句怎么递"
                  value={contIntent}
                  onChange={(event) => { setContDirty(true); setContIntent(event.target.value === 'redirect' || event.target.value === 'hurry' ? event.target.value : 'supplement') }}
                >
                  <option value="supplement">补充一句(排在它后面)</option>
                  <option value="redirect">改方向(打断正在跑的,旧办法作废)</option>
                  <option value="hurry">催一下(别干等)</option>
                </select>
                <textarea
                  aria-label="接着说"
                  value={contText}
                  onChange={(event) => { setContDirty(true); setContText(event.target.value) }}
                  rows={2}
                  placeholder="接着说……"
                />
                <div className="ben-cl__dlg-actions">
                  <button
                    type="button"
                    onClick={() => { void contSend(false) }}
                    disabled={contText.trim() === '' || contSending || contTarget === undefined}
                  >
                    发出去
                  </button>
                  <button type="button" className="ben-cl__secondary" onClick={() => { void contSend(true) }} disabled={contText.trim() === '' || contSending}>只留记录</button>
                  <button
                    type="button"
                    className="ben-cl__secondary"
                    title="把正在跑的那一轮停住,这件先撤下 —— 可以不填字"
                    onClick={() => { void contSend(false, 'recall') }}
                    disabled={contSending}
                  >
                    撤回
                  </button>
                </div>
                {contNote !== undefined && <p role="status" data-ok={contNote.ok}>{contNote.text}</p>}
              </section>
            )}

            <section className="ben-cl__dlg-block" aria-label="留言" data-focus={props.focusTalk === true}>
              <h3>来往记录与留言</h3>
              <NoteTalk task={task} cards={cards} api={api} onReceipt={onReceipt} onOpenTask={props.onOpenTask} />
              <h4>验收意见</h4>
              {grouped && <p className="ben-cl__muted">父组状态由子事项汇总，不能单独完成 · 子事 {group.done}/{group.total}{group.unknown ? " · 部分子事未知" : ""}</p>}
              {butlerReviewing && <p className="ben-cl__muted">事务官核验中:这一件还没标出要拍板的事，先由事务官查事实、验收或退回;标了四类拍板请求(带方案与依据)才会回到你手上。</p>}
              <textarea aria-label="验收意见" value={comment} onChange={event => setComment(event.target.value)} rows={2} placeholder="写一句验收意见(可选;「改一改」必须有内容)" />
              <div className="ben-cl__dlg-actions">
                <button type="button" disabled={grouped} onClick={() => { void say('pass') }}>通过</button>
                <button type="button" onClick={() => { void say('rework') }} disabled={grouped || comment.trim() === ''}>改一改</button>
                <button type="button" onClick={() => { void say('self') }} disabled={grouped || comment.trim() === ''}>我自己改</button>
              </div>
            </section>

            <section className="ben-cl__dlg-block" aria-label="等他的">
              <h3>等你的</h3>
              {task.conversation === undefined && !waitingAsks && <p className="ben-cl__muted">没有在等你答的。</p>}
              {(task.conversation !== undefined || waitingAsks) && <ItemTalk
                state={state}
                taskId={task.id}
                sessionId={task.conversation?.session_id ?? ''}
                version={task.updated_at}
                baseUrl={baseUrl}
                fetchImpl={fetchImpl}
                onReceipt={onReceipt}
              />}
            </section>
          </div>
          <aside className="ben-cl__dlg-side" aria-label="背景与安排">
            <section className="ben-cl__dlg-block" aria-label="头">
              <dl className="ben-cl__dlg-facts">
                <dt>负责人</dt>
                <dd>
                  <select
                    aria-label="负责人"
                    value={current ?? ''}
                    onChange={(event) => { void update({ assignee: event.target.value === '' ? null : event.target.value }, '负责人改好了') }}
                  >
                    <option value="">没写</option>
                    {current !== undefined && !picker.some(one => one.id === current) && <option value={current}>{props.assigneeText(task)}</option>}
                    {picker.map(one => <option key={one.id} value={one.id}>{one.name}</option>)}
                  </select>
                </dd>
                {manager !== undefined && (<><dt>管理</dt><dd>{cards.find(one => one.id === manager)?.name ?? nameOf(manager)}</dd></>)}
                <dt>目标</dt>
                <dd>
                  <select
                    aria-label="所属目标"
                    value={goal === undefined ? UNSORTED_GOAL_ID : goal.id}
                    onChange={(event) => { void update({ goal_id: event.target.value === UNSORTED_GOAL_ID ? null : event.target.value }, '挪到那个目标了') }}
                  >
                    <option value={UNSORTED_GOAL_ID}>未归目标(目标待定)</option>
                    {goals.filter(one => one.id !== UNSORTED_GOAL_ID).map(one => <option key={one.id} value={one.id}>{one.title}</option>)}
                  </select>
                  <button type="button" className="ben-cl__link" onClick={() => onFlyGoal(goal?.id ?? UNSORTED_GOAL_ID)}>在板上看</button>
                </dd>
                {(state.tasks?.squads ?? []).length > 0 && (
                  <>
                    <dt>小队</dt>
                    <dd>
                      <select
                        aria-label="派给小队"
                        value={task.squad_id ?? ''}
                        onChange={(event) => {
                          const squad = (state.tasks?.squads ?? []).find(one => one.id === event.target.value)
                          // 派给小队 = 派给组长(组长再分下去);撤掉小队不动负责人。
                          void update(squad === undefined ? { squad_id: null } : { squad_id: squad.id, assignee: squad.leader }, squad === undefined ? '不归小队了' : `派给小队「${squad.name}」了`)
                        }}
                      >
                        <option value="">不归小队</option>
                        {(state.tasks?.squads ?? []).map(one => <option key={one.id} value={one.id}>{one.name}</option>)}
                      </select>
                    </dd>
                  </>
                )}
                <dt>协作</dt>
                <dd>
                  {picker.filter(one => one.id !== current).map(one => (
                    <label key={one.id}>
                      <input
                        type="checkbox"
                        checked={(task.collaborators ?? []).includes(one.id)}
                        onChange={(event) => {
                          const next = event.target.checked ? [...(task.collaborators ?? []), one.id] : (task.collaborators ?? []).filter(id => id !== one.id)
                          void update({ collaborators: next }, '协作的人改好了')
                        }}
                      />{one.name}
                    </label>
                  ))}
                </dd>
                <dt>类型</dt>
                <dd>
                  <select
                    aria-label="类型"
                    value={task.work_type ?? ''}
                    onChange={(event) => { void update({ work_type: event.target.value === '' ? null : event.target.value }, '类型改好了') }}
                  >
                    <option value="">{factType === undefined ? '没写(中性灰)' : `按事实认:${factType.title}`}</option>
                    {types.map(type => <option key={type.id} value={type.id}>{type.title}</option>)}
                  </select>
                </dd>
                <dt>时间</dt>
                <dd><TimeFields task={task} onSave={(patch, ok) => { void update(patch, ok) }} /></dd>
                {task.due !== undefined && (<><dt>截止</dt><dd>{task.due}</dd></>)}
                <dt>优先级</dt>
                <dd>
                  <select
                    aria-label="优先级"
                    value={task.priority ?? ''}
                    onChange={(event) => {
                      const next = event.target.value === '' ? null : event.target.value
                      void update({ priority: next }, next === null ? '优先级清掉了' : `优先级改成「${PRIORITY_TITLES[next as keyof typeof PRIORITY_TITLES]}」`)
                    }}
                  >
                    <option value="">不定</option>
                    {TASK_PRIORITIES.map(one => <option key={one} value={one}>{PRIORITY_TITLES[one]}</option>)}
                  </select>
                </dd>
                {(task.version ?? goal?.version) !== undefined && (<><dt>版本</dt><dd>{task.version ?? goal?.version}</dd></>)}
                {task.module !== undefined && (<><dt>模块</dt><dd>{task.module}</dd></>)}
                {(task.labels ?? []).length > 0 && (<><dt>标签</dt><dd>{(task.labels ?? []).join('、')}</dd></>)}
                {cost !== undefined && (<><dt>花了</dt><dd>{cost}</dd></>)}
              </dl>
            </section>

            <section className="ben-cl__dlg-block" aria-label="前因后果">
              <h3>前因后果</h3>
              <p><b>为什么:</b>{goal?.why ?? (goal === undefined ? '目标待定 —— 还没说这件事为了什么' : '目标上没写为什么')}</p>
              <p>
                <b>从哪来:</b>{NOTE_FROM_TITLES[from.kind]}
                {from.quote !== undefined && <q className="ben-cl__quote">{from.quote}</q>}
                {from.ref !== undefined && <code className="ben-cl__ref">{from.ref}</code>}
              </p>
              <div>
                <b>做到什么算完:</b>
                {!editingAcceptance && (task.acceptance ?? []).length === 0 && <span className="ben-cl__muted">还没写</span>}
                {!editingAcceptance && (task.acceptance ?? []).length > 0 && (
                  <ol className="ben-cl__acceptance">
                    {(task.acceptance ?? []).map(item => <li key={item} data-done={task.status === 'done'}>{task.status === 'done' ? '✓ ' : ''}{item}</li>)}
                  </ol>
                )}
                {!editingAcceptance && (
                  <button type="button" className="ben-cl__link" onClick={() => { setAcceptanceDraft((task.acceptance ?? []).join('\n')); setEditingAcceptance(true) }}>
                    {(task.acceptance ?? []).length === 0 ? '写几条' : '改'}
                  </button>
                )}
                {editingAcceptance && (
                  <form onSubmit={(event) => {
                    event.preventDefault()
                    setEditingAcceptance(false)
                    void update({ acceptance: acceptanceDraft.split('\n').map(one => one.trim()).filter(one => one !== '') }, '验收写好了')
                  }}
                  >
                    <textarea aria-label="做到什么算完(一行一条,最多三条)" value={acceptanceDraft} onChange={event => setAcceptanceDraft(event.target.value)} rows={3} />
                    <button type="submit">存</button>
                    <button type="button" onClick={() => setEditingAcceptance(false)}>算了</button>
                  </form>
                )}
              </div>
            </section>

            {conditionGoal !== undefined && (
              <section className="ben-cl__dlg-block" aria-label="目标条件事实" data-testid="note-condition-facts">
                <TaskConditionFacts taskId={task.id} goalId={conditionGoal.id} revision={JSON.stringify([task.round, task.updated_at, task.receipt, conditionGoal.updated_at, state.stale])} api={api} history={conditionGoal.conditions ?? []} round={round} />
              </section>
            )}

            {props.onOpenTask !== undefined && (
              <section className="ben-cl__dlg-block" aria-label="关系">
                <h3>关系</h3>
                <RelationsPanel key={task.id} taskId={task.id} tasks={state.tasks?.tasks ?? []} api={api} onOpenTask={props.onOpenTask} />
              </section>
            )}

            <section className="ben-cl__dlg-block" aria-label="文件与仓库">
              <h3>文件与仓库</h3>
              <ul>
                {(task.attachments ?? []).map(one => <li key={`att-${one.name}`}>附件:{one.name}</li>)}
                {project?.path !== undefined && <li>项目「{project.name}」:<code>{project.path}</code></li>}
                {(meta?.repos ?? []).map(one => <li key={`repo-${one.local_path}`}>仓库:<code>{one.local_path}</code>{one.branch === undefined ? '' : ` · ${one.branch}`}{one.remote_url === undefined ? '' : ` · ${one.remote_url}`}</li>)}
                {(meta?.resources ?? []).map(one => <li key={`res-${one.ref}`}>{one.title}:<code>{one.ref}</code></li>)}
                {(task.links ?? []).map(one => <li key={`link-${one.agent}-${one.session_id}`}>会话:{assigneeName(one.agent)} · <code>{one.session_id.slice(0, 12)}</code></li>)}
              </ul>
              {(task.attachments ?? []).length === 0 && project?.path === undefined && (task.links ?? []).length === 0 && <p className="ben-cl__muted">没有带文件、仓库或会话。</p>}
            </section>
          </aside>
        </div>
      </div>
    </div>
  )
}

/** 一行回放:工具那几步折成一行(展开看每步)、出错 / 停下那几句、回答开头。 */
function replayLine(entry: SessionTranscriptEntry): string {
  if (entry.k === 'steps') return `${entry.line}${entry.steps.length > 0 ? `:${entry.steps.map(one => one.line).join(' · ')}` : ''}`
  if (entry.k === 'note') return `${entry.tone === 'fail' ? '出错' : entry.tone === 'stop' ? '停下' : '等着'}:${entry.text}`
  if (entry.k === 'ask') return `交代:${entry.text.slice(0, 160)}`
  return `回答:${entry.text.slice(0, 160)}${entry.text.length > 160 ? '…' : ''}`
}

/**
 * 工具级执行回放(维护者 10-21 勾回来的那一样,阶段一):有记录文件的那几家(事务官 / Codex / Claude)按时间回放
 * 工具调用、命令、报错 —— 读的是手机读对话那一条(`GET /sessions/transcript`),不开新接口;
 * 窗口型那几家如实写「这家没有记录,只有窗里看见的」。
 */
function Replay({ task, baseUrl, fetchImpl }: { task: TaskView, baseUrl: string, fetchImpl: typeof fetch }) {
  const sources = replaySources(task)
  const [open, setOpen] = useState<Record<string, SessionTranscriptView | 'loading' | 'missing'>>({})
  if (sources.length === 0) return null
  return (
    <div className="ben-cl__replay">
      <h4>执行回放</h4>
      {sources.map((source) => {
        const key = `${source.agent}:${source.session_id ?? ''}`
        if (!source.recorded) {
          return <p key={key} className="ben-cl__muted">{assigneeName(source.agent)}:这家没有记录,只有窗里看见的。</p>
        }
        const got = open[key]
        return (
          <details
            key={key}
            onToggle={(event) => {
              if (!(event.currentTarget as HTMLDetailsElement).open || got !== undefined) return
              setOpen(prev => ({ ...prev, [key]: 'loading' }))
              const url = `${baseUrl}/sessions/transcript?agent=${encodeURIComponent(source.agent)}&id=${encodeURIComponent(source.session_id as string)}`
              void fetchImpl(url).then(async res => (res.ok ? await res.json() as SessionTranscriptView : 'missing' as const)).catch(() => 'missing' as const)
                .then(view => setOpen(prev => ({ ...prev, [key]: view })))
            }}
          >
            <summary>{assigneeName(source.agent)} · {(source.session_id as string).slice(0, 12)}</summary>
            {got === 'loading' && <p className="ben-cl__muted">在读……</p>}
            {got === 'missing' && <p className="ben-cl__muted">这条会话的记录读不到了。</p>}
            {got !== undefined && got !== 'loading' && got !== 'missing' && (
              <ol className="ben-cl__replay-list">
                {got.entries.map((entry, index) => (
                  <li key={index} data-kind={entry.k}>
                    {entry.at !== undefined && <time>{clock(entry.at)}</time>} {replayLine(entry)}
                  </li>
                ))}
              </ol>
            )}
          </details>
        )
      })}
    </div>
  )
}

const pad2 = (n: number): string => String(n).padStart(2, '0')
function localParts(iso: string | undefined): { date: string, time: string } {
  if (iso === undefined) return { date: '', time: '' }
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return { date: '', time: '' }
  return { date: `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`, time: `${pad2(d.getHours())}:${pad2(d.getMinutes())}` }
}

/**
 * 改时间只走这几个明确的字段(日期 / 开始 / 结束);只填开始 = 时间点;全清 = 回到「未排时间」。
 * 拖动在哪个视图里都不改时间。结束早于开始当场说,不存。
 */
export function TimeFields({ task, onSave }: { task: TaskView, onSave: (patch: Record<string, unknown>, ok: string) => void }) {
  const start = localParts(task.start)
  const end = localParts(task.end)
  const [date, setDate] = useState(start.date)
  const [from, setFrom] = useState(start.time)
  const [to, setTo] = useState(end.time)
  const [why, setWhy] = useState<string | undefined>(undefined)
  return (
    <form
      className="ben-cl__timeform"
      aria-label="时间"
      onSubmit={(event) => {
        event.preventDefault()
        if (date === '' || from === '') {
          if (date === '' && from === '' && to === '') { setWhy(undefined); onSave({ start: null, end: null }, '回到未排时间了'); return }
          setWhy('要先写日期和开始时刻'); return
        }
        const s = new Date(`${date}T${from}:00`)
        const e = to === '' ? undefined : new Date(`${date}T${to}:00`)
        if (e !== undefined && e.getTime() <= s.getTime()) { setWhy('结束要晚于开始'); return }
        setWhy(undefined)
        onSave({ start: s.toISOString(), end: e === undefined ? null : e.toISOString() }, e === undefined ? '排成时间点了' : '时间排好了')
      }}
    >
      <input type="date" aria-label="日期" value={date} onChange={event => setDate(event.target.value)} />
      <input type="time" aria-label="开始" value={from} onChange={event => setFrom(event.target.value)} />
      <span aria-hidden="true">–</span>
      <input type="time" aria-label="结束" value={to} onChange={event => setTo(event.target.value)} />
      <button type="submit" className="ben-cl__secondary">存时间</button>
      {why !== undefined && <span role="alert" className="ben-cl__rail-note">{why}</span>}
    </form>
  )
}
