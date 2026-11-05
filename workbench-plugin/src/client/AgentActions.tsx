/**
 * 外层那一张「Agent 登记表」卡上的几颗键(2026-09-25,卡 Q「Agent 自动发现与统一接入」)。
 *
 * - 「新接上一家:XX」:它已经接上了 ——「知道了」收掉这一句;判错了就「这不是 Agent」当场撤回
 *   (撤回之后它从顶栏、窗口槽的圆点、舞台、会话列表里一起消失,以后不再判、不再读)。
 * - 某一家在跑的会话(点开那一张):同样挂「这不是 Agent」。
 *
 * 拿不准的那一家「XX 像是个 Agent,要接上吗?」不在这里:那一问走卡 M 的提问卡(QuestionAsk,进「等你」那一堆)。
 *
 * 点了之后把服务端回的那一句人话摆出来(「好,XX 不算 Agent 了,以后不读它」),
 * 真相以下一拍的 /state 为准(那一张卡随之消失)。
 */
import { useState } from 'react'
import type { SceneItem } from './butlerSceneModel.ts'

export function AgentActions({ item, talk, connect = false }: {
  item: Pick<SceneItem, 'agent' | 'title'>
  /** 往哪儿说(同卡 P / 卡 M 的 SceneTalk:上层给了才画键)。 */
  talk?: { baseUrl: string, fetchImpl: typeof fetch } | undefined
  /**
   * 这一家还**拿不准**(2026-09-26,卡 TB2 追加):多一颗「接上」。只有真要他判断的那几行才给 ——
   * 已经接上的那几家在登记表面板里默认一颗键都不显(「这不是 Agent」收进那一行的「⋯」里)。
   */
  connect?: boolean
}) {
  const [reply, setReply] = useState<string | undefined>(undefined)
  const [busy, setBusy] = useState(false)
  const agent = item.agent
  if (agent === undefined || talk === undefined) return null
  const say = async (path: string, body: Record<string, string>): Promise<void> => {
    setBusy(true)
    try {
      const res = await talk.fetchImpl(`${talk.baseUrl}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
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
  return <div className="ben-wb__particle-actions ben-wb__agent-actions">
    {connect && <button type="button" disabled={busy} aria-label={`接上:${item.title}`} onClick={() => { void say('/agents/connect', { id: agent.id }) }}>接上</button>}
    {agent.notice_id !== undefined && <button type="button" disabled={busy} onClick={() => { void say('/agents/notice/dismiss', { id: agent.notice_id as string }) }}>知道了</button>}
    {/* ★ 重置这一家(2026-10-21,卡「派活按家隔离」):清闸计数、撤在等的读、重开那扇窗 —— 不重启插件,别家不动。 */}
    <button type="button" disabled={busy} aria-label={`重置这一家:${item.title}`} onClick={() => { void say('/dispatch/family/reset', { family: agent.id }) }}>重置这一家</button>
    <button type="button" disabled={busy} aria-label={`这不是 Agent:${item.title}`} onClick={() => { void say('/agents/not-agent', { id: agent.id }) }}>这不是 Agent</button>
    {reply !== undefined && <p role="status">{reply}</p>}
  </div>
}
