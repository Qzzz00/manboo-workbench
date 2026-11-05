/**
 * 任务关系(2026-10-24,小K collab-desktop-1024;消费 core 契约 §3 D2)。
 *
 * 父子不在这一列(走 children,阅读模式分组呈现);这里管其余五种:衍生 / 前置依赖 /
 * 流程交接 / 验收退回 / 参考。规则服务端强制(自连/重复/依赖环 409;退回可回路),
 * 前端只做两件事:handoff / rejected_back 的说明一句必填先挡;409 的中文原话原样给人看。
 * 上游重开(目标卡 round 涨)的关系服务端标 `stale` —— 「旧交接需复核」,不回滚任何已发生的执行。
 */
import { useEffect, useState } from 'react'
import type { TaskRelation, TaskRelationKind, TaskView } from '../../protocol.ts'
import type { CollabApi } from './collabApi.ts'
import { RELATION_TITLES } from './collabContract.ts'

const KINDS: readonly TaskRelationKind[] = ['derived', 'depends_on', 'handoff', 'rejected_back', 'reference']
/** 这两种必须写一句:交接 = 交回什么/谁接收;退回 = 修改要求。 */
const NEEDS_NOTE: readonly TaskRelationKind[] = ['handoff', 'rejected_back']

export function RelationsPanel({ taskId, tasks, api, onOpenTask }: {
  taskId: string
  /** 板上其它卡(选关系目标用)。 */
  tasks: readonly TaskView[]
  api: CollabApi
  onOpenTask: (taskId: string) => void
}) {
  const [relations, setRelations] = useState<readonly TaskRelation[] | undefined>(undefined)
  const [live, setLive] = useState<boolean | undefined>(undefined)
  const [toId, setToId] = useState('')
  const [kind, setKind] = useState<TaskRelationKind>('depends_on')
  const [note, setNote] = useState('')
  const [msg, setMsg] = useState<string | undefined>(undefined)
  const others = tasks.filter(one => one.id !== taskId && one.casual !== true)
  const load = (): void => {
    void api.get<{ relations?: TaskRelation[] }>(`/collab/relations?task_id=${encodeURIComponent(taskId)}`).then((got) => {
      if (got === undefined || !Array.isArray(got.relations)) { setLive(false); return }
      setLive(true)
      setRelations(got.relations)
    })
  }
  useEffect(() => {
    let alive = true
    void api.get<{ relations?: TaskRelation[] }>(`/collab/relations?task_id=${encodeURIComponent(taskId)}`).then((got) => {
      if (!alive) return
      if (got === undefined || !Array.isArray(got.relations)) { setLive(false); return }
      setLive(true)
      setRelations(got.relations)
    })
    return () => { alive = false }
  }, [api, taskId, tasks])
  const titleOf = (id: string): string => tasks.find(one => one.id === id)?.title ?? id
  const needsNote = NEEDS_NOTE.includes(kind)
  const addable = toId !== '' && (!needsNote || note.trim() !== '')
  return (
    <div className="ben-cl__rels">
      {live === undefined && <p className="ben-cl__muted" role="status">在读……</p>}
      {live === false && <p className="ben-cl__muted" role="status">关系账还没接上(老服务);已有联系照样在卡片和会话里。</p>}
      {live === true && (
        <>
          <ul className="ben-cl__rels-list">
            {(relations ?? []).map((one) => (
              <li key={one.id} data-kind={one.kind} data-stale={one.stale === true}>
                <span className="ben-cl__rels-kind">{RELATION_TITLES[one.kind]}</span>
                <button type="button" className="ben-cl__link" onClick={() => onOpenTask(one.from_id === taskId ? one.to_id : one.from_id)}>
                  {one.from_id === taskId ? `→ ${titleOf(one.to_id)}` : `← ${titleOf(one.from_id)}`}
                </button>
                {one.note !== undefined && <span className="ben-cl__rels-note">{one.note}</span>}
                {one.kind === 'rejected_back' && one.round !== undefined && <small className="ben-cl__muted">第 {one.round} 轮退回</small>}
                {one.stale === true && <small className="ben-cl__rels-stale">上游重开,旧交接需复核</small>}
                <button type="button" className="ben-cl__link" onClick={() => { void api.post('/collab/relation/remove', { id: one.id }).then((got) => { setMsg(got.ok ? '这条关系删了' : got.error ?? '没删成'); if (got.ok) load() }) }}>删</button>
              </li>
            ))}
            {(relations ?? []).length === 0 && <li className="ben-cl__muted">这张卡还没有画出关系。</li>}
          </ul>
          <div className="ben-cl__rels-add">
            <select aria-label="关系到哪张" value={toId} onChange={event => setToId(event.target.value)}>
              <option value="">选一张卡……</option>
              {others.map(one => <option key={one.id} value={one.id}>{one.title}</option>)}
            </select>
            <select aria-label="哪种关系" value={kind} onChange={event => { setKind(event.target.value as TaskRelationKind); setNote(''); setMsg(undefined) }}>
              {KINDS.map(one => <option key={one} value={one}>{RELATION_TITLES[one]}</option>)}
            </select>
            <input aria-label="说明一句" value={note} placeholder={kind === 'handoff' ? '交回什么、谁接收(必填)' : kind === 'rejected_back' ? '修改要求(必填)' : '满足条件/参考什么(可选)'} onChange={event => setNote(event.target.value)} />
            <button
              type="button"
              className="ben-cl__primary"
              disabled={!addable}
              onClick={() => {
                void api.post('/collab/relation/save', { from_id: taskId, to_id: toId, kind, ...(note.trim() === '' ? {} : { note: note.trim() }) }).then((got) => {
                  if (!got.ok) { setMsg(got.error ?? '没加上'); return }
                  setMsg('关系加上了(画了线不等于自动执行)')
                  setToId(''); setNote(''); setKind('depends_on')
                  load()
                })
              }}
            >
              加上关系
            </button>
          </div>
          {needsNote && note.trim() === '' && <small className="ben-cl__muted">{kind === 'handoff' ? '交接要写一句:交回什么、谁接收。' : '退回要写一句:哪里不行、怎么改。'}</small>}
          {msg !== undefined && <p className="ben-cl__receipt-inline" role="status">{msg}</p>}
        </>
      )}
    </div>
  )
}
