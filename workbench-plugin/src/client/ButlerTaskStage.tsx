import { useEffect, useRef, useState, type ReactNode } from 'react'
import { arrangeButlerTasks, butlerConnector } from './butlerLayout.ts'
import type { SceneItem } from './butlerSceneModel.ts'
import { agentTitle } from './butlerSceneModel.ts'
import type { RegistryState } from './agentRegistryView.ts'
import { agentColorOf } from './agentRegistryView.ts'
import { elapsedLabel } from './orb.ts'
import { FxAvatar, FxBeam, FxThinking } from './fx/Fx.tsx'
import { BEAM, agentOfExecutorLabel, avatarStateOfSession } from './fx/fxModel.ts'
import type { SessionStatus } from '../protocol.ts'
import { SESSION_ACTIVITY_UNKNOWN, sessionChildrenLine } from '../protocol.ts'

/**
 * 台上的星座:在执行的事项(实线连球)+ 排队等会话的事项(虚线,2026-09-16)。
 * `now` 是 /state.now,给「进行中 · n 分钟」用——不用浏览器时钟,免得与服务端对不上。
 *
 * 2026-09-25(卡 feat/first-look-orb-top,维护者「最上面不应该是我精心制作的那张粒子球吗」):
 * 这一格固定在事务官档**最上面**、占满上半截(见 butlerLayoutStyle.ts `.ben-wb__scene-top`),
 * 要他处理的卡一律排到下面自己的滚动区里,再多也挤不掉它。台上没有事的时候球更大
 * (butlerLayout.ts 的 `arrangeButlerTasks`)。在办的那几条连线上有一道光顺着线走(「连线与流光跟着亮」)。
 */
export function ButlerTaskStage({ items, now = '', focus, onChoose, orb, visible = true, tools, registry, running, waiting, baseUrl, glow, executionSummary }: {
  items: SceneItem[], now?: string, focus: string | null, onChoose: (item: SceneItem) => void, orb?: ReactNode, visible?: boolean
  /** Agent 登记表(卡 Q):卡上那几家叫什么、什么颜色从这里取。缺席就原样用 id、中性灰。 */
  registry?: RegistryState
  /** 标题行右边那几颗小键(抽屉 ⋯、外观设置)。放在这一行里,不再占球下面的地方。 */
  tools?: ReactNode
  /**
   * 「正在执行 n」那个数(2026-09-26,卡 ST):**`/state.running` 那一格**,不再数台上的卡 ——
   * 台上按会话画卡，卡数与事项数不同。计数缺席就是未知，不能退回数卡。
   */
  executionSummary?: ReactNode
  running?: number | undefined
  /** 「等你 n」那个数:`/state.waiting`。缺席就不写这一截。 */
  waiting?: number | undefined
  /** 各家 logo 从哪儿取(`GET /agents/icon/<id>`);缺席就用相对地址。 */
  baseUrl?: string | undefined
  /**
   * 哪一张卡走光(2026-09-27,卡 DD 追加;`SceneItem.id`)。同一件「等你」只摆一处之后,球下那一行没了,
   * 那道光跟着挪到台上这张卡上。**只给「等你」那一张**:在跑的卡从不单独走光(2026-09-25 卡 P 补三),
   * 谁走光由上层按「要他处理的第一件」定,这里只照着画。缺席 = 一张都不走。
   */
  glow?: string
}) {
  const executing = running
  const pending = items.filter(item => item.pending).length
  const [page, setPage] = useState(0)
  const pages = Math.max(1, Math.ceil(items.length / 6)), current = Math.min(page, pages - 1)
  useEffect(() => { if (page !== current) setPage(current) }, [page, current])
  const shown = items.slice(current * 6, current * 6 + 6)
  const stage = useRef<HTMLDivElement>(null)
  const [size, setSize] = useState({ width: 900, height: 380 })
  useEffect(() => {
    const element = stage.current
    if (!element) return
    const measure = () => {
      const { width, height } = element.getBoundingClientRect()
      if (width > 0 && height > 0) setSize(prior => prior.width === width && prior.height === height ? prior : { width, height })
    }
    measure()
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(measure)
    observer.observe(element)
    return () => observer.disconnect()
  }, [])
  const geometry = arrangeButlerTasks(size.width, size.height, shown.length)
  // 在跑的卡**一个样**(2026-09-25 卡 P 补三;维护者:「为什么只有一个有光效,另一个没有」):以前「当前事项」那一张
  // 单独走一圈光(他点过的优先,否则最近动过的那张),看的人分不出「当前」和「在跑」,只看到两张一样在跑、一张有光一张没有。
  // 现在谁都不单独走光(在跑的那几条连线上的流光本来就一样);他点开的那一张只多一个小字「你点开的」,说明为什么是它。
  const previous = useRef(new Map<string, string>())
  const [pulses, setPulses] = useState<Record<string, string>>({})
  // Existing execution's changed output only. Initial render, reading and elapsed clocks are not progress.
  // 「在做什么」换一句**不算**(2026-09-25,卡 P):那是轮询读出来的状态,几秒就换一次,
  // 跟着它走光就是「时不时自己闪一下」。光只跟回传的输出走。
  const versions = JSON.stringify(items.map(item => [item.id, JSON.stringify(item.executors.map(({ id, session }) => [id, session?.summary, session?.reason, session?.status, session?.wait_reason]))]))
  useEffect(() => {
    const next = new Map<string, string>(JSON.parse(versions)), changed: Record<string, string> = {}
    for (const [id, version] of next) if (visible && previous.current.has(id) && previous.current.get(id) !== version) changed[id] = version
    previous.current = next
    setPulses(changed)
    if (Object.keys(changed).length === 0) return
    const timer = setTimeout(() => setPulses({}), 1000)
    return () => clearTimeout(timer)
  }, [versions, visible])
  return <>
    <header className="ben-wb__task-stage-heading">
      {executionSummary ?? <span>{executing === undefined ? '执行状态未知' : executing > 0 ? <><span className="ben-wb__particle-dot" />正在执行 <b>{executing}</b>{pending > 0 && <> · 排队 <b>{pending}</b></>}{waiting !== undefined && waiting > 0 && <> · 等你 <b>{waiting}</b></>}</> : pending > 0 ? <>排队 <b>{pending}</b> · 会话开启中</> : waiting !== undefined && waiting > 0 ? <>等你 <b>{waiting}</b></> : '此刻留给你'}</span>}
      <span className="ben-wb__task-stage-tools">
        {pages > 1 && <nav aria-label="执行事项分页">
          <button type="button" aria-label="上一组执行事项" disabled={current === 0} onClick={() => setPage(current - 1)}>‹</button>
          <span>{current + 1} / {pages}</span>
          <button type="button" aria-label="下一组执行事项" disabled={current === pages - 1} onClick={() => setPage(current + 1)}>›</button>
        </nav>}
        {tools}
      </span>
    </header>
    <div ref={stage} className="ben-wb__task-stage" data-portrait={geometry.portrait} data-many={shown.length > 3} data-empty={shown.length === 0}>
      <svg className="ben-wb__task-connections" viewBox={`0 0 ${size.width} ${size.height}`} aria-hidden="true">
        {shown.map((item, i) => {
          const { path, start } = butlerConnector(geometry.cards[i]!, geometry.orb)
          return <g key={item.id} data-active={focus === item.id} data-pending={item.pending} data-executing={item.executing}>
            <path data-task-link={item.id} data-pending={item.pending} d={path} />
            {/* 在办的那几条:一道光从球顺着线流向那张卡(「她办事时连线与流光跟着亮」)。排队的不走光。 */}
            {item.executing && visible && <path className="ben-wb__task-flow" data-task-flow={item.id} d={path} pathLength={100} />}
            <circle cx={start.x} cy={start.y} r="2" />
            {pulses[item.id] && <circle key={pulses[item.id]} data-progress-pulse={item.id} r="2.6">
              <animateMotion dur=".9s" path={path} keyTimes="0;1" keyPoints="0;1" calcMode="spline" keySplines=".4 0 .2 1" fill="freeze" />
            </circle>}
          </g>
        })}
      </svg>
      <div className="ben-wb__task-orb-anchor" style={{ left: geometry.orb.x, top: geometry.orb.y, width: geometry.orb.r / .32, height: geometry.orb.r / .32 }}>{orb}</div>
      <ul className="ben-wb__task-constellation" aria-label="执行中的事项">
        {shown.map((item, i) => {
          const box = geometry.cards[i]!
          // 那几家的名字从 Agent 登记表来(卡 Q):运行时新接上的一家也写得出名字,不认名字表。
          const agents = item.external !== undefined
            ? item.external.name
            : [...new Set(item.executors.map(executor => agentTitle(executor.label.split(' / ')[0] ?? '', registry)))].join(' · ')
          // 派出去的那几家各一个小头像:在跑 = 忙,等你 / 跑完 = 醒着,离线 = 睡着。
          const faces = new Map<string, SessionStatus | undefined>()
          for (const executor of item.executors) {
            const agent = agentOfExecutorLabel(executor.label)
            if (agent === undefined) continue
            const status = executor.offline ? 'offline' : executor.session?.status
            if (!faces.has(agent) || status === 'running') faces.set(agent, status)
          }
          // 在做什么 · 几分钟前(组装时按 /state.now 算好,见 butlerSceneModel.sceneProgressLine);读不到就「读不到它在做什么」。
          const progress = item.progress
          const elapsed = item.pending ? undefined : elapsedLabel(item.at, now)
          // 会话卡(卡 ST)的状态字由 `stageSessionStatus` 给(在跑 / 等你 / 做完 · 未读 / 空闲);事项卡照旧「进行中 · n 分钟」。
          const card = item.sessionCard
          const status = card !== undefined
            ? card.status
            : item.pending ? '排队' : item.group === 'attention' ? '需留意' : elapsed === undefined ? '进行中' : `进行中 · ${elapsed}`
          const lit = glow === item.id
          return <li key={item.id} data-task-card={item.id} data-notice={item.notice} data-pending={item.pending} data-external={item.external !== undefined} data-selected={focus === item.id} {...(card === undefined ? {} : { 'data-session-card': card.tone })} style={{ left: box.x, top: box.y, width: box.w, height: box.h }}>
            {/* 走光那一张:光绕着整张卡走(同球下那一区原来那道,BEAM.ask 一套参数)。不走光时同一层结构、只是不亮。 */}
            <FxBeam name="ask" spec={BEAM.ask} active={lit}>
            <button type="button" aria-label={`查看事项:${item.title}`} aria-pressed={focus === item.id} onClick={() => onChoose(item)}>
              <small className="ben-wb__task-agents">
                {/* 会话卡也用那颗会跳的卡通小头像(2026-09-26 晚,维护者:「之前那些会跳动的小动效没了」)——
                    卡 ST 换成的静态 logo 撤回;logo 留在坞标签与顶栏。 */}
                {card !== undefined
                  ? <FxAvatar agent={card.agent} name={card.name} color={card.tint} state={avatarStateOfSession(card.tone === 'running' ? 'running' : undefined)} size={16} />
                  : [...faces].map(([agent, status]) => <FxAvatar key={agent} agent={agent} name={agentTitle(agent, registry)} color={agentColorOf(registry, agent)} state={avatarStateOfSession(status)} size={16} />)}
                {item.pending && <FxThinking state="connecting" label="会话开启中" />}
                {/* 名字这一截单独包一层:省略号归它,头像那一行不再裁(见 butlerLayoutStyle 里那条注释)。 */}
                <span className="ben-wb__task-agents-name">{card?.name ?? (agents || (item.pending ? '事务官' : '执行中'))}</span>
                <span data-attention={card === undefined ? item.group === 'attention' : card.tone === 'ask'}>
                  {status}
                  {/* 他点开的那一张:不发光,只一个小字说为什么是它(下面「当前聚焦事项」摊开的就是这一张)。 */}
                  {focus === item.id && <b className="ben-wb__task-current">你点开的</b>}
                </span>
              </small>
              {/* 对话名**整句**:折行,不裁成一行(摊开时连行数上限也去掉)。 */}
              <strong>{item.title}</strong>
              {/* 卡上只一行(2026-09-26 晚,维护者:「多了好多乱七八糟」):有一问在等他写那一问,否则照旧「在做什么 · 几分钟前」。 */}
              {card?.ask !== undefined
                ? <small className="ben-wb__task-ask">{card.ask.head}:{card.ask.question}</small>
                : <small className="ben-wb__task-progress" data-unknown={progress === SESSION_ACTIVITY_UNKNOWN}>{progress}</small>}
              {/* 它底下的后台任务(卡 Q):卡上只多这一行,点开详情才一项一行;它们不单独成卡、不单独算执行。 */}
              {sessionChildrenLine(item.children) !== undefined && <small className="ben-wb__task-children">{sessionChildrenLine(item.children)}</small>}
            </button>
            </FxBeam>
          </li>
        })}
      </ul>
    </div>
  </>
}
