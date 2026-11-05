/**
 * 点开一条「某家在跑的会话」(2026-09-25,卡 P;维护者:「事务官中并没有显示会话的标题和内容」)。
 *
 * 在工作台里看,**不跳 DSH 底层页、也不跳那家客户端**:标题、在哪个项目、现在怎样(进行中 · 14 分钟)、
 * 最近在做什么(· 几分钟前)、最近几轮(他说的 + 它最后说的 + 数出来的「做了什么」)。
 * 最近几轮是**点开时当场读**的(`GET /sessions/digest`),开着的时候 15 秒再读一次;/state 里只有标题与在做什么。
 *
 * 不露内部的东西(维护者规矩第 3 条):没有会话 id、没有路径、没有工具名 —— 服务端给的就是洗过的人话,
 * 这里也不画 `claude / d9991aac…` 那种执行者标签。
 */
import type { WorkbenchState } from '../protocol.ts'
import { agentTitle, type SceneItem, type SceneSession } from './butlerSceneModel.ts'
import { elapsedLabel } from './orb.ts'
import { AgentActions } from './AgentActions.tsx'
import { SessionChildren } from './SessionChildren.tsx'
// 这条会话停着在等他时,怎么答就摊在点开的详情里(2026-09-27,卡 DD)。
import { SessionAsk } from './SessionAsk.tsx'
/**
 * 「最近几轮」那一段 2026-10-04 搬去了 `SessionRounds.tsx`(卡 `claude/ask-with-context`:
 * 「等你确认」那张卡也要摆它,留在这儿就跟 `SessionAsk.tsx` 成了 import 环)。
 * 这里**照旧转出** `SessionDigestPanel`,老调用方一处都不用改。
 */
import { SessionDigestPanel, projectLine } from './SessionRounds.tsx'
export { SessionDigestPanel, ASK_CONTEXT_NO_READ } from './SessionRounds.tsx'

/** 点开一件事要的那几样(与卡 M 的 SceneTalk 同一个形状:上层给了才能当场读)。 */
export interface SceneTalk {
  state: WorkbenchState
  baseUrl: string
  fetchImpl: typeof fetch
  onReceipt?: (text: string) => void
}

/** 开着的时候多久再读一次。 */
const REFRESH_MS = 15_000

/** 「进行中 · 14 分钟」「这一轮说完了」「等你」……会话此刻怎样,一句人话。 */
export function sessionStatusLine(session: SceneSession | undefined, runningSince: string | undefined, now: string | undefined, agentName?: string): string {
  if (session === undefined) return '状态读不到'
  const name = agentName ?? agentTitle(session.agent)
  if (session.status === 'running') {
    const elapsed = now === undefined ? undefined : elapsedLabel(runningSince, now)
    return elapsed === undefined ? `${name} · 进行中` : `${name} · 进行中 · ${elapsed}`
  }
  if (session.status === 'waiting') return `${name} · 在等你`
  if (session.status === 'done') return `${name} · 这一轮说完了`
  if (session.status === 'error') return `${name} · 出错停下了`
  return `${name} · 已经关了`
}


/**
 * 点开的那一张(某家客户端里的一条会话):标题、项目、现在怎样、在做什么、最近几轮。
 * 没给 `talk`(上层没接取数)时只画卡片上已有的几样,不画「最近几轮」。
 */
export function ExternalSessionDetails({ item, now, talk }: { item: SceneItem, now?: string, talk?: SceneTalk }) {
  const external = item.external
  if (external === undefined) return null
  const session = item.executors[0]?.session
  const project = projectLine(item.context ?? session?.project)
  return <>
    {project !== undefined && <small>{project}</small>}
    <h3>{item.title}</h3>
    <p>{sessionStatusLine(session, item.at, now ?? talk?.state.now, external.name)}</p>
    <p className="ben-wb__session-activity">{item.progress}</p>
    {/*
      这条会话停着在等他 → 怎么答就摊在这里(2026-09-27,卡 DD:同一件「等你」只摆一处,拍板留球旁的卡)。
      球下那一区不再摆它那一行,所以**答的入口一个都不能少** —— 它明写的选项、我自己说、去回答、不用管这条
      全在 `SessionAsk` 里,这里原样用那一张(card 那种摆法),不另写一套。
      取数那几样(baseUrl / fetchImpl)只有上层给了 `talk` 才有;没给就不画那几颗按下去没反应的键(D13)。
    */}
    {session?.ask !== undefined && talk !== undefined && (
      <SessionAsk
        session={{ ...session, name: external.name }}
        baseUrl={talk.baseUrl}
        fetchImpl={talk.fetchImpl}
        {...(talk.onReceipt === undefined ? {} : { onReceipt: talk.onReceipt })}
        /*
          这一页底下本来就摆着「最近几轮」(下面那个 SessionDigestPanel)与项目那一行 ——
          所以这张卡不再摆自己那一颗「它刚才在干什么」(2026-10-04,卡 `claude/ask-with-context`):
          同一段对话在一页上出现两回比没有更糟。
        */
        contextOnPage
      />
    )}
    {/* 它底下的后台任务(卡 Q):一行说几项、在跑几项,展开才一项一行。 */}
    <SessionChildren items={item.children} now={now ?? talk?.state.now ?? new Date().toISOString()} />
    {talk !== undefined && <SessionDigestPanel agent={external.agent} name={external.name} sessionId={external.session_id} baseUrl={talk.baseUrl} fetchImpl={talk.fetchImpl} />}
    {/* 它其实不是 Agent(卡 Q):这里当场撤掉 —— 顶栏、窗口槽圆点、台上、会话列表里一起消失,以后不再读它。 */}
    <AgentActions item={{ title: item.title, agent: { id: external.agent } }} talk={talk} />
  </>
}
