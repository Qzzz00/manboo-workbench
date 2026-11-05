/**
 * 点开一件事 —— 在工作台里看,不跳到 DSH 原始界面(2026-09-25,卡 M;维护者点名的 bug)。
 *
 * 维护者:「我点了事务官那里的按钮……然后就变成这个页面了,工作台回不来了」。以前事项详情里那颗「打开对话 ↗」
 * 把整个壳切到 DSH 自己的界面(左上 deepseek HARNESS、一行行 Bash / Think、英文输入框),回来的路只有侧栏最底下一个小图标。
 *
 * 现在这一段就摆在事项详情里:
 *   1. 这件事此刻在哪一步(正在办 / 停下来在等你回答 / 等你批 / 办完了);
 *   2. 在等他的那一问、那几条要批的 —— 同球下那几张一模一样,在这里也能答;
 *   3. 这件事里他点过的「同类的都允许」,能收回;
 *   4. 对话:他说的(只留原话,我们替他交代给事务官的那几句不露)与事务官说的(去掉记号),工具调用一条都不出现;
 *   5. 最底下一个不起眼的「看原始对话」—— 开发者用,切到 DSH 原始界面(那边左上角有「‹ 回工作台」)。
 */
import { useEffect, useState } from 'react'
import type { SessionTurn, WorkbenchState } from '../protocol.ts'
import { ApprovalAsk } from './ApprovalAsk.tsx'
import { useMeName } from './meName.tsx'
import { QuestionAsk } from './QuestionAsk.tsx'
import { fetchTurns, revokeGrant } from './askApi.ts'
import { hisWords, plainTalk, talkStatus } from './askModel.ts'

export interface ItemTalkProps {
  state: WorkbenchState
  /** 事项 id(看板卡的 id)。不是事项(各家客户端的会话)时缺席:那时只摆等他的那几张。 */
  taskId?: string
  /** 这件事底下那条事务官会话。 */
  sessionId: string
  /** 场景里这张卡的版本(会话一有动静就变):变了就重拉一次对话。 */
  version: string
  baseUrl: string
  fetchImpl: typeof fetch
  /** 「看原始对话」(开发者用):切到 DSH 原始界面。不传就不画这颗键。 */
  onOpenRaw?: (sessionId: string) => void
  onReceipt?: (text: string) => void
}

/** 对话里最多摆几段(从最新往回)。 */
const TURNS_SHOWN = 30

export function ItemTalk({ state, taskId, sessionId, version, baseUrl, fetchImpl, onOpenRaw, onReceipt }: ItemTalkProps) {
  const meName = useMeName()
  const [turns, setTurns] = useState<SessionTurn[] | undefined>(undefined)
  const [turnsNote, setTurnsNote] = useState<string | undefined>(undefined)
  const [revoking, setRevoking] = useState(false)
  useEffect(() => {
    if (taskId === undefined) return undefined
    let alive = true
    void fetchTurns(baseUrl, fetchImpl, taskId, TURNS_SHOWN).then((result) => {
      if (!alive) return
      if (result.ok) { setTurns(result.turns); setTurnsNote(undefined); return }
      setTurns(undefined)
      // 事务官重启过(对话只在内存里)、或会话还没开:如实说,不编。
      setTurnsNote(result.error === '没有这个会话'
        ? '这段对话在事务官上次重启之前,这里看不到了。'
        : result.error === '会话未开' ? '这件事还没交到事务官手上。' : `对话没拉到:${result.error}`)
    })
    return () => { alive = false }
  }, [taskId, version, baseUrl, fetchImpl])

  const questions = (state.questions ?? []).filter(one => one.session_id === sessionId || (taskId !== undefined && one.task_id === taskId))
  const approvals = (state.approvals ?? []).filter(one => one.session_id === sessionId || (taskId !== undefined && one.task_id === taskId))
  // 记在这件事上的(卡 M 追加:换了一条会话接着办、DSH 重启过也还在)与记在这条会话上的。
  const grants = (state.approval_grants ?? []).filter(one => (taskId !== undefined && one.task_id === taskId) || one.session_id === sessionId)
  const session = state.sessions.find(one => one.agent === 'dsh' && one.session_id === sessionId)
  const task = taskId === undefined ? undefined : state.tasks?.tasks.find(one => one.id === taskId)
  const status = talkStatus({
    questions: questions.length,
    approvals: approvals.length,
    ...(session?.status === undefined ? {} : { sessionStatus: session.status }),
    ...(task?.status === undefined ? {} : { taskStatus: task.status }),
  })
  const shown = (turns ?? [])
    .map(turn => ({ ...turn, text: turn.role === 'user' ? hisWords(turn.text) : plainTalk(turn.text) }))
    .filter(turn => turn.text !== '')

  const revoke = (key: string, grantTaskId?: string): void => {
    if (revoking) return
    setRevoking(true)
    void revokeGrant(baseUrl, fetchImpl, sessionId, key, grantTaskId).then((failed) => {
      setRevoking(false)
      onReceipt?.(failed ?? '收回了:同类的又会一条条问你')
    })
  }

  return (
    <section className="ben-wb__talk" aria-label="这件事的对话">
      <p className="ben-wb__talk-status" data-waiting={questions.length + approvals.length > 0}>{status}</p>
      {questions.map(one => (
        <div key={one.id} className="ben-wb__talk-ask">
          <QuestionAsk question={one} baseUrl={baseUrl} fetchImpl={fetchImpl} variant="inline" {...(onReceipt === undefined ? {} : { onReceipt })} />
        </div>
      ))}
      {approvals.map(one => (
        <div key={one.id} className="ben-wb__talk-ask">
          <ApprovalAsk approval={one} baseUrl={baseUrl} fetchImpl={fetchImpl} variant="inline" {...(onReceipt === undefined ? {} : { onReceipt })} />
        </div>
      ))}
      {grants.map(one => (
        <p key={one.key} className="ben-wb__talk-grant">
          <span>这件事里你允许过:{one.title}{one.allowed > 0 ? `(已放行 ${one.allowed} 次)` : ''}</span>
          <button type="button" className="ben-wb__laid-link" disabled={revoking} onClick={() => revoke(one.key, one.task_id)}>收回</button>
        </p>
      ))}
      {shown.length > 0 && (
        <ol className="ben-wb__talk-turns" aria-label="对话">
          {shown.map((turn, index) => (
            <li key={`${turn.at}-${index}`} data-role={turn.role}>
              <small>{turn.role === 'user' ? meName : '事务官'}</small>
              <p>{turn.text}</p>
            </li>
          ))}
        </ol>
      )}
      {turnsNote !== undefined && <p className="ben-wb__talk-note">{turnsNote}</p>}
      {onOpenRaw !== undefined && (
        <p className="ben-wb__talk-raw">
          <button type="button" className="ben-wb__talk-raw-link" title="开发者用:切到事务官的原始界面;左上角「‹ 回工作台」回来" onClick={() => onOpenRaw(sessionId)}>看原始对话</button>
        </p>
      )}
    </section>
  )
}
