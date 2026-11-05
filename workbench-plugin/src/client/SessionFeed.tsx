/**
 * 会话区（PRD §5.3，工作台核心模块）。
 *
 * 按 agent 分四组，不按项目——一条项目线可能挂多个 agent 的会话，
 * 按 agent 分组才能回答"哪个客户端在等我"这个真正的问题。
 *
 * 目标写在 PRD §5.3：每条会话带足够信息，做到**不必打开对应客户端也能判断要不要现在处理**。
 */
import type { AgentSessionView } from '../protocol.ts'
import { WAIT_REASON_TITLES } from '../protocol.ts'
import type { AgentGroup } from './sessionFeed.ts'
import { FxAvatar } from './fx/Fx.tsx'
import { avatarStateOfGroup } from './fx/fxModel.ts'
import {
  activationTarget, humanDuration, label, metricParts, peopleChips, sessionLamp,
} from './sessionFeed.ts'

/** 一行会话。各家一条路(2026-09-25,卡 Q):`agent` 是 Agent 登记表里的 id,名字在组头上。 */
type SessionView = AgentSessionView

/**
 * 这一行为什么停着(2026-09-09 傍晚拍板第 4 条:等审批 / 等你输入 / 额度不足 / 出错 分开)。
 *
 * **判不出就一个字都不多说**(D13):没有 wait_reason 的行照旧是从前那套措辞
 * (「等你」「等你下一句」「出错了」),不写「原因未知」——那句话既没信息量,
 * 还会让人以为系统本该知道却弄丢了。Kimi 与 Codex 两家永远走这条路(它们判不出)。
 */
function statusText(session: SessionView): string {
  const elapsed = humanDuration(session.elapsed_sec)
  const wait = session.wait_reason === undefined ? undefined : WAIT_REASON_TITLES[session.wait_reason]

  if (session.status === 'waiting') {
    if (wait !== undefined) return `${wait} ${elapsed}`
    return session.reason === 'idle_prompt' ? `等你下一句 ${elapsed}` : `等你 ${elapsed}`
  }
  // 「已完成 · 额度不足」:这条跑完了,但那一家已经没额度,接不上下一句——他该先去充值/换家。
  if (session.status === 'done') return wait === undefined ? '已完成' : `已完成 · ${wait}`
  if (session.status === 'running') return `在跑 ${elapsed}`
  if (session.status === 'error') {
    // 「已中断」是他自己按的停止,不该被额度那类环境原因盖掉。
    if (session.reason === 'interrupted') return '已中断'
    // 额度打光导致的失败说「额度不足」比「出错了」有用得多;来源只说出错时照旧「出错了」。
    return wait === undefined || session.wait_reason === 'error' ? '出错了' : wait
  }
  return '离线'
}

/** UUID 显示随机尾部，避免同期 UUIDv7 的时间前缀碰撞；普通短 id 保持完整。 */
function shortId(sessionId: string): string {
  const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(sessionId)
  return `#${isUuid ? sessionId.slice(-6) : sessionId}`
}

function SessionRow({ session, onRead, onActivate }: {
  session: SessionView
  onRead: (session: SessionView) => void
  onActivate: (app: string) => void
}) {
  const meta = [
    session.project,
    statusText(session),
    ...(session.status === 'running' && session.last_output_sec !== undefined
      ? [`上次输出 ${humanDuration(session.last_output_sec)}前`]
      : []),
    `会话 ${shortId(session.session_id)}`,
    ...(session.unread ? ['未读'] : []),
  ].join(' · ')

  // 「刚完成」可点表示已读（PRD §5.3：用户点过才收，不会被后续消息刷掉）；
  // claude/codex/kimi 的行还可点激活对应客户端（会话区点击激活，dsh 无独立可激活的 app）。
  const markRead = session.status === 'done' && session.unread
  const target = activationTarget(session.agent)
  const clickable = markRead || target !== null
  const cls = `ben-wb__sess${session.status === 'waiting' ? ' ben-wb__sess--wait' : ''}${
    session.status === 'done' ? ' ben-wb__sess--fresh' : ''}`

  // 三个数字(目前只有 DSH 会话有)。拿不到就整段不渲染——同 summary 那条纪律,
  // 界面上宁可少一行,也不摆占位数字(D13)。
  const numbers = metricParts(session.metrics)

  // 悬停文案:把分类原原本本说一遍。没判出原因的行**不挂 title**——
  // 空 tooltip 与"有话要说"在鼠标底下长得一样,那才是误导。
  const waitTitle = session.wait_reason === undefined
    ? undefined
    : `等待原因:${WAIT_REASON_TITLES[session.wait_reason]}`

  const body = (
    <>
      <span className={`ben-wb__lamp ben-wb__lamp--${sessionLamp(session)}`} aria-hidden="true" />
      <span className="ben-wb__sess-bd">
        <span className="ben-wb__sess-h">{session.title ?? '（无标题）'}</span>
        <span className="ben-wb__sess-m" {...(waitTitle === undefined ? {} : { title: waitTitle })}>{meta}</span>
        {numbers.length > 0 && <span className="ben-wb__sess-n">{numbers.join(' · ')}</span>}
        {/* 摘要拿不到就整段不渲染。PRD §5.3 明令不许编造，也就不该显示占位假文本。 */}
        {session.summary !== undefined && session.summary !== ''
          && <span className="ben-wb__sess-q">{session.summary}</span>}
      </span>
    </>
  )

  if (!clickable) return <div className={cls}>{body}</div>

  const label = markRead
    ? `标记已读：${session.title ?? shortId(session.session_id)}`
    : `打开：${session.title ?? shortId(session.session_id)}`

  return (
    <button
      type="button"
      className={`${cls} ben-wb__sess--clickable`}
      aria-label={label}
      onClick={() => {
        if (markRead) onRead(session)
        if (target !== null) onActivate(target)
      }}
    >
      {body}
    </button>
  )
}

function groupCount(group: AgentGroup): string {
  if (group.sessions.length === 0) return '今日无会话'
  const parts: string[] = []
  if (group.waiting > 0) parts.push(`${group.waiting} 等你`)
  if (group.running > 0) parts.push(`${group.running} 在跑`)
  const done = group.sessions.filter(s => s.status === 'done').length
  if (done > 0) parts.push(`${done} 刚完成`)
  return parts.join(' · ')
}

function groupLamp(group: AgentGroup): string {
  if (group.waiting > 0) return 'red'
  if (group.sessions.some(s => s.status === 'done' && s.unread)) return 'blue'
  if (group.running > 0) return 'teal'
  return 'off'
}

/** 「人找我」：微信/企业微信角标（spec §3；点它按包标识拉起，不假定 App 在这台机器上叫什么），由 GET /state 的 badges 驱动。 */
function PeopleChips({ badges, onActivate }: {
  badges: Record<string, number | null | undefined>
  onActivate: (app: string) => void
}) {
  return (
    <div className="ben-wb__chips" role="group" aria-label="人找我">
      {peopleChips(badges).map(chip => (
        <button
          key={chip.app}
          type="button"
          className="ben-wb__chip"
          aria-label={chip.label}
          onClick={() => onActivate(chip.app)}
        >
          <span className="ben-wb__chip-label">{chip.label}</span>
          {chip.value === null && <span className="ben-wb__chip-help">未接入</span>}
          {chip.value !== null && chip.value > 0 && <span className="ben-wb__chip-badge">{chip.value}</span>}
        </button>
      ))}
    </div>
  )
}

export function SessionFeed({
  groups, offline, onRead, onActivate, badges, alerts,
}: {
  groups: readonly AgentGroup[]
  /** 服务读不到时为 true，界面要明示"Agent 掉线"（架构约束 C1）。 */
  offline: boolean
  onRead: (session: SessionView) => void
  /** 点会话行 / 「人找我」chip 激活对应客户端（会话区点击激活）。 */
  onActivate: (app: string) => void
  /** 「人找我」三家角标的取数来源，取不到的家 badges 里缺省或为 null。 */
  badges: Record<string, number | null | undefined>
  /** 收起补偿（spec §4"收起必有通知"）：其它被隐藏模块上浮的信号，钉在会话区顶部。 */
  alerts?: readonly string[]
}) {
  return (
    <div className="ben-wb__scroll">
      {offline && (
        <p className="ben-wb__offline" role="status">
          Agent 掉线 · 下面是最后一次已知状态
        </p>
      )}

      {alerts !== undefined && alerts.length > 0 && (
        <div className="ben-wb__alerts" role="status" aria-label="收起模块的提醒">
          {alerts.map(text => <p key={text}>{text}</p>)}
        </div>
      )}

      {groups.map(group => (
        <section className="ben-wb__grp" key={group.agent} aria-label={group.name}>
          <header className="ben-wb__ghead">
            <span className={`ben-wb__lamp ben-wb__lamp--${groupLamp(group)}`} aria-hidden="true" />
            {/* 动效配角(2026-09-23):一家一个小头像,有一条在跑就蹦,都停了就睡。灯照旧是准话,头像只是认人。 */}
            <FxAvatar agent={group.agent} name={group.name} {...(group.color === undefined ? {} : { color: group.color })} state={offline ? 'sleeping' : avatarStateOfGroup(group.sessions.map(one => one.status))} size={18} />
            <span className="ben-wb__gname">{group.name}</span>
            <span className="ben-wb__gct">{groupCount(group)}</span>
          </header>
          {/* 无会话的组只留组头一行，不撑开空 body（PRD §5.3）。 */}
          {group.sessions.length > 0 && (
            <div className="ben-wb__gbody">
              {group.sessions.map(session => (
                <SessionRow
                  key={`${session.agent}:${session.session_id}`}
                  session={session}
                  onRead={onRead}
                  onActivate={onActivate}
                />
              ))}
            </div>
          )}
        </section>
      ))}

      <PeopleChips badges={badges} onActivate={onActivate} />
    </div>
  )
}

export { label }
