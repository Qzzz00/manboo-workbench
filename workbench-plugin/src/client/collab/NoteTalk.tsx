/**
 * 事项留言/邀请 + 统一活动流(2026-10-24,小K collab-desktop-1024;消费 core 契约 §2 C)。
 *
 * - 普通留言默认只记(`intent:'record'`);@名片 = `ask`:发送前亮准确对象与动作
 *   「将请 X 处理(发送后成为协作者,负责人不变)」,可改「只留记录」——协作者/负责人
 *   都由服务端按 mentions 落,这里一个 assignee/collaborators 字都不写;
 * - `client_msg_id` 幂等:没送成草稿留着、重发复用同一个号,不重复留言/派活;
 * - 投递态如实:已受理待处理 / 已开始处理 / 没送到+原因(未知名字不当已邀请);
 * - 活动流 = message/comment/receipt/transition/run 按 at 合一;老服务没有这个口,
 *   退回本地 comments+receipt 平铺,不冒充有流;
 * - 草稿 localStorage 一键一事:悬浮速览与详情(NoteDialog)挂同一个组件 = 同一份记录与草稿。
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import { RECEIPT_TITLES, STAMP_TITLES, assigneeName } from '../../protocol.ts'
import type { ActivityItem, NoteMessage } from '../../protocol.ts'
import type { CollabApi } from './collabApi.ts'
import { runLine } from './RunsPanel.tsx'
import { DELIVERY_TITLES } from './collabContract.ts'
import type { RailCard } from './collabModel.ts'
import { receiptBody } from './collabModel.ts'
import { changeComposer, readComposer, watchComposer, type NoteComposer, type PendingNote, type ReplyTarget } from './noteComposer.ts'

function clock(at: string): string {
  const d = new Date(at)
  if (Number.isNaN(d.getTime())) return ''
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${pad(d.getMonth() + 1)}/${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

/** 从一句里 @名片:按名片名最长匹配(「Codex 名片」优先于「Codex」)。 */
export function mentionsOf(text: string, cards: readonly RailCard[]): string[] {
  const found = new Set<string>()
  const sorted = [...cards].sort((a, b) => b.name.length - a.name.length)
  for (let index = text.indexOf('@'); index !== -1; index = text.indexOf('@', index + 1)) {
    const card = sorted.find(one => {
      if (one.name === '' || !text.startsWith(one.name, index + 1)) return false
      const next = text[index + 1 + one.name.length]
      return next === undefined || !/[\p{L}\p{N}_-]/u.test(next)
    })
    if (card !== undefined) { found.add(card.id); index += card.name.length }
  }
  return [...found]
}

const newMsgKey = (): string => {
  try {
    const uuid: string | undefined = globalThis.crypto?.randomUUID?.()
    if (typeof uuid === 'string' && uuid !== '') return `nm-${uuid}`
  }
  catch { /* 老环境没有 randomUUID */ }
  return `nm-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
}

function MessageLine({ one, nameOf, onReply, onOpenTask }: { one: NoteMessage, nameOf: (id: string) => string, onReply: (one: ReplyTarget) => void, onOpenTask?: ((id: string) => void) | undefined }) {
  return (
    <li data-kind="message">
      <b>{nameOf(one.by)}</b> <time>{clock(one.at)}</time> {one.text}
      {one.intent === 'ask' && <small className="ben-cl__talk-tag">请求处理</small>}
      <button type="button" className="ben-cl__link" onClick={() => onReply({ kind: 'message', id: one.id, by: one.by, text: one.text, at: one.at })}>回复</button>
      {(one.deliveries ?? []).map((d) => (
        <small key={`${d.to}-${d.at}`} className="ben-cl__talk-delivery" data-status={d.status}>
          → {nameOf(d.to)}:{d.receipt === undefined ? DELIVERY_TITLES[d.status] : '已回执'}{d.status === 'failed' && d.error !== undefined ? ` · ${d.error}` : ''}
          {d.receipt !== undefined && <span> · 回执 · {RECEIPT_TITLES[d.receipt.kind]}:{receiptBody(d.receipt.text)} <button type="button" className="ben-cl__link" onClick={() => onReply({ kind: 'receipt', by: d.receipt!.by ?? d.to, text: d.receipt!.text, at: d.receipt!.at })}>回复回执</button></span>}
          {d.task_id !== undefined && onOpenTask !== undefined && <button type="button" className="ben-cl__link" data-task-id={d.task_id} onClick={() => onOpenTask(d.task_id!)}>查看协作执行事项</button>}
        </small>
      ))}
    </li>
  )
}

interface NoteTalkProps {
  task: import('../../protocol.ts').TaskView
  cards: readonly RailCard[]
  api: CollabApi
  onReceipt: (text: string) => void
  onOpenTask?: ((id: string) => void) | undefined
}

export function NoteTalk(props: NoteTalkProps) {
  return <NoteTalkInner key={props.task.id} {...props} />
}

function NoteTalkInner({ task, cards, api, onReceipt, onOpenTask }: NoteTalkProps) {
  const nameOf = (id: string | undefined): string => (id === undefined ? '' : cards.find(one => one.id === id)?.name ?? assigneeName(id))
  const [activity, setActivity] = useState<readonly ActivityItem[] | undefined>(undefined)
  const [activityLive, setActivityLive] = useState<boolean | undefined>(undefined)
  const [activityTick, setActivityTick] = useState(0)
  useEffect(() => {
    let alive = true
    void api.get<{ items?: ActivityItem[] }>(`/collab/note/activity?id=${encodeURIComponent(task.id)}`).then((got) => {
      if (!alive) return
      if (got === undefined || !Array.isArray(got.items)) { setActivityLive(false); return }
      setActivityLive(true)
      setActivity([...got.items].sort((a, b) => a.at.localeCompare(b.at)))
    })
    return () => { alive = false }
  }, [api, task.id, task.updated_at, activityTick])

  const [draft, setDraft] = useState<NoteComposer>(() => readComposer(task.id))
  const [posting, setPosting] = useState<readonly string[]>([])
  const inFlight = useRef(new Set<string>())
  const mounted = useRef(true)
  const [error, setError] = useState<string>()
  useEffect(() => {
    mounted.current = true
    const stop = watchComposer(task.id, () => setDraft(readComposer(task.id)))
    setDraft(readComposer(task.id))
    return () => { mounted.current = false; stop() }
  }, [task.id])
  const edit = (change: (current: NoteComposer) => NoteComposer): void => {
    try { setDraft(changeComposer(task.id, change)); setError(undefined) }
    catch { setError('草稿暂时存不下，尚未发送。请保留原文后再试。') }
  }
  const text = draft.text
  const replyTarget = draft.reply
  const mentions = useMemo(() => {
    const ids = mentionsOf(text, cards)
    if (replyTarget !== undefined && cards.some(card => card.id === replyTarget.by && card.kind === 'card')) ids.push(replyTarget.by)
    return [...new Set(ids)]
  }, [text, cards, replyTarget])
  const sending = posting.length > 0
  const transmit = async (action: PendingNote): Promise<void> => {
    const key = action.body.client_msg_id
    if (inFlight.current.has(key)) return
    inFlight.current.add(key)
    setPosting([...inFlight.current])
    let got
    try { got = await api.post('/collab/note/message', action.body) }
    catch { got = { ok: false, body: {}, error: '工作台服务没应答,稍后再试' } }
    const body = got.body as { ok?: boolean, duplicated?: boolean, error?: string }
    try {
      changeComposer(task.id, current => {
        if (!(got.ok && body.ok === true) && body.duplicated !== true) {
          return { ...current, pending: current.pending.map(one => one.body.client_msg_id !== key ? one : { ...one, error: body.error ?? got.error ?? '回包尚未确认' }) }
        }
        const sameVersion = current.revision === action.revision
        return { ...current, ...(sameVersion ? { text: '', reply: undefined, revision: current.revision + 1 } : {}), pending: current.pending.filter(one => one.body.client_msg_id !== key) }
      })
    } catch {
      if (mounted.current) setError('回包尚未确认，保留原动作后重发。')
    }
    inFlight.current.delete(key)
    if (mounted.current) { setPosting([...inFlight.current]); setActivityTick(value => value + 1) }
  }
  const send = (intent: 'record' | 'ask'): void => {
    if (text.trim() === '' || sending) return
    // 当前版本的同动作仍未确认时，必须复用整个已保存包。
    const existing = draft.pending.find(one => one.revision === draft.revision && one.body.intent === intent)
    if (existing !== undefined) { void transmit(existing); return }
    const quote = replyTarget?.kind === 'receipt' ? `回复 ${nameOf(replyTarget.by)} (${replyTarget.by}) 的回执 ${replyTarget.at}：\n${replyTarget.text}\n\n` : ''
    const action: PendingNote = { revision: draft.revision, ...(replyTarget === undefined ? {} : { reply: replyTarget }), body: {
      task_id: task.id, client_msg_id: newMsgKey(), text: quote + text.trim(), intent,
      ...(intent === 'ask' ? { mentions } : {}),
      ...(replyTarget?.id === undefined ? {} : { reply_to: replyTarget.id }),
    } }
    try { changeComposer(task.id, current => ({ ...current, pending: [...current.pending, action] })) }
    catch { setError('待确认动作暂时存不下，尚未发送。请保留原文后再试。'); return }
    void transmit(action)
  }
  const reply = (one: ReplyTarget): void => edit(current => ({ ...current, reply: one, revision: current.revision + 1 }))

  const fallbackComments = task.comments ?? []
  return (
    <div className="ben-cl__talk">
      {activityLive === false && <p className="ben-cl__muted" role="status">活动暂时读不到，当前投递状态未知{activity === undefined ? '。' : '；保留上次已知记录。'}</p>}
      {activity !== undefined && (
        <ol className="ben-cl__talk-stream" aria-label="事项活动">
          {activity.map((item, index) => {
            if (item.type === 'message') return <MessageLine key={`m-${item.message.id}`} one={item.message} nameOf={nameOf} onReply={reply} onOpenTask={onOpenTask} />
            if (item.type === 'comment') return <li key={`c-${item.comment.id}-${index}`} data-kind="comment"><b>{nameOf(item.comment.by)}</b> <time>{clock(item.comment.at)}</time> {item.comment.text} <button type="button" className="ben-cl__link" onClick={() => reply({ kind: 'comment', id: item.comment.id, by: item.comment.by, text: item.comment.text, at: item.comment.at })}>回复</button></li>
            if (item.type === 'receipt') return <li key={`r-${index}`} data-kind="receipt"><time>{clock(item.receipt.at)}</time> 回执 · {RECEIPT_TITLES[item.receipt.kind]}:{receiptBody(item.receipt.text)} <button type="button" className="ben-cl__link" onClick={() => reply({ kind: 'receipt', by: item.receipt.by ?? '', text: item.receipt.text, at: item.receipt.at })}>回复</button></li>
            if (item.type === 'transition') return <li key={`t-${index}`} data-kind="transition"><time>{clock(item.at)}</time> 盖成「{STAMP_TITLES[item.to]}」</li>
            return <li key={`run-${index}`} data-kind="run"><time>{clock(item.at)}</time> 运行 · {runLine(item.segment)}</li>
          })}
          {activity.length === 0 && <li className="ben-cl__muted">这件事还没有来往记录。</li>}
        </ol>
      )}
      {activityLive === false && activity === undefined && (
        <ul className="ben-cl__talk-stream" aria-label="留言与回执">
          {fallbackComments.map(one => <li key={one.id}><b>{nameOf(one.by)}</b> <time>{clock(one.at)}</time> {one.text}</li>)}
          {task.receipt !== undefined && <li>回执 · {RECEIPT_TITLES[task.receipt.kind]}:{receiptBody(task.receipt.text)}</li>}
          {fallbackComments.length === 0 && task.receipt === undefined && <li className="ben-cl__muted">尚未读到留言。</li>}
        </ul>
      )}
      {activityLive === undefined && <p className="ben-cl__muted">在读……</p>}
      <div className="ben-cl__talk-compose">
        {replyTarget !== undefined && <section className="ben-cl__reply-preview" aria-label="回复对象与原文">
          <b>回复 {nameOf(replyTarget.by) || '作者未知'} · {replyTarget.by || '稳定身份未知'}</b>
          <small>{replyTarget.kind} · {replyTarget.id ?? replyTarget.at}</small>
          <blockquote>{replyTarget.text}</blockquote>
          <button type="button" onClick={() => edit(current => ({ ...current, reply: undefined, revision: current.revision + 1 }))}>取消回复</button>
          <p className="ben-cl__muted">{mentions.length > 0 ? '可明确请对方处理，也可只留记录。' : '没有已登记的处理对象，这次只留记录。'}</p>
        </section>}
        <textarea
          aria-label="留一句"
          value={text}
          rows={2}
          placeholder="留一句;@名片名 = 请 TA 处理;回复 = 点那句底下的「回复」"
          onChange={(event) => { const value = event.target.value; edit(current => ({ ...current, text: value, revision: current.revision + 1 })) }}
        />
        {mentions.length > 0 && (
          <div className="ben-cl__talk-ask" role="status">
            <span>这句将请 {mentions.map(nameOf).join('、')} 处理(发送后成为协作者,负责人不变)。也可以只留记录,不叫人。</span>
            <span className="ben-cl__dlg-actions">
              <button type="button" className="ben-cl__primary" disabled={sending} onClick={() => { void send('ask') }}>{sending ? '在送' : '请 TA 处理'}</button>
              <button type="button" className="ben-cl__secondary" disabled={sending} onClick={() => { void send('record') }}>只留记录</button>
            </span>
          </div>
        )}
        {mentions.length === 0 && (
          <div className="ben-cl__dlg-actions">
            <button type="button" disabled={text.trim() === '' || sending} onClick={() => { void send('record') }}>{sending ? '在送' : '留言'}</button>
          </div>
        )}
        {draft.pending.map(action => <div key={action.body.client_msg_id} className="ben-cl__rail-note" role={action.error === undefined ? 'status' : 'alert'} aria-label="待确认动作">
          <p>{action.body.intent === 'ask' ? '请处理' : '只留记录'} · {action.body.text}</p>
          <small>{(action.body.mentions ?? []).map(id => `${nameOf(id)} (${id})`).join('、')}{action.body.reply_to === undefined ? '' : ` · 回复 ${action.body.reply_to}`}</small>
          <p>{action.error ?? '回包尚未确认'} <button type="button" className="ben-cl__link" disabled={posting.includes(action.body.client_msg_id)} onClick={() => { void transmit(action) }}>重发</button></p>
        </div>)}
        {error !== undefined && <p role="alert">{error}</p>}
      </div>
    </div>
  )
}
