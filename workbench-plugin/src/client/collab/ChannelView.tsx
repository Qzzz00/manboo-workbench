import { ReportText } from './ReportText.tsx'
/**
 * 协作区「频道」那一屏(2026-10-22 起;2026-10-24 小K collab-desktop-1024 按契约 §5 F 改只读)。
 *
 * 频道是事务官们的局域网聊天室(资讯 / 日报 / 周报):**人类旁观,没有发送框**。
 * LAN 走项目配对消息流，来源快照由 core 发布器提供；中转独立沿用:`GET /collab/relay/studio` 认工作室与频道、
 * `GET /collab/relay/channel?id=` 读消息流。消息=发送者/时间/引用,撤回的不混进来。
 * 顶上那一组是本机事务官的局域网身份(改名查重在 `LanIdentityPanel`,稳定 ID 不换)。
 * 中转没接上 / 连不上 / 还没加入工作室时,整屏一块说清楚为什么、去哪儿接上,
 * 不画一个点了没反应的空壳。
 */
import { useEffect, useState } from 'react'
import type { CollabChannelMessage, CollabChannelSnapshot } from '../../protocol.ts'
import type { CollabApi } from './collabApi.ts'
import { LanProjectFeed } from './LanProjectFeed.tsx'
import { LanIdentityPanel } from './LanIdentityPanel.tsx'
import { AvatarFace } from './people.tsx'
import { STUDIO_STATE_TEXT, useRelayStudio } from './RelaySections.tsx'
import { Empty } from '../ui/index.tsx'

/** 「09:58」;不是今天的写「10 月 20 日 09:58」。 */
function whenText(iso: string, nowMs: number): string {
  const at = new Date(iso)
  if (Number.isNaN(at.getTime())) return ''
  const clock = `${String(at.getHours()).padStart(2, '0')}:${String(at.getMinutes()).padStart(2, '0')}`
  return at.toDateString() === new Date(nowMs).toDateString() ? clock : `${at.getMonth() + 1} 月 ${at.getDate()} 日 ${clock}`
}

function Message({ one, nowMs }: { one: CollabChannelMessage, nowMs: number }) {
  const name = `${one.author.nick}${one.author.butler === true ? ' 的事务官' : ''}`
  return (
    <li className="ben-cl__msg">
      <div className="ben-cl__msg-head">
        <span className="ben-cl__person"><AvatarFace owner={one.author.person} name={one.author.nick} kind="human" /><span className="ben-cl__person-name">{name}</span></span>
        <small>{one.via === 'wecom' ? '企微 · ' : ''}{whenText(one.at, nowMs)}</small>
      </div>
      <ReportText text={one.retracted !== undefined ? '(已撤回)' : one.text} report={one.kind === 'daily' || one.kind === 'weekly'} />
      {one.refs.map(ref => <div key={ref.object_id} className="ben-cl__msg-ref">{ref.title ?? ref.kind}</div>)}
    </li>
  )
}

interface ChannelViewProps {
  api: CollabApi
  tick: unknown
  lanTick?: unknown
  projects?: readonly { id: string, title: string }[]
  nowMs: number
  /** 「去设置」:打开协作区设置的工作室那一组。 */
  onOpenStudio: () => void
  /** 只读屏没有发送动作;留着参数是旧调用点的兼容,发送回执已无人消费。 */
  onReceipt: (text: string) => void
}

export function ChannelView(props: ChannelViewProps) {
  const projects = props.projects ?? []
  const [picked, setPicked] = useState<string>()
  const projectId = projects.some(one => one.id === picked) ? picked : projects[0]?.id
  return (
    <div className="ben-cl__chview">
      <LanIdentityPanel api={props.api} />
      <section role="region" aria-label="局域网项目频道">
        <h3>局域网项目频道</h3>
        <p className="ben-cl__muted">仅本项目已配对的局域网成员；人在这里只读旁观。</p>
        {projects.length > 0 && <label>项目 <select aria-label="局域网频道项目" value={projectId} onChange={event => setPicked(event.target.value)}>{projects.map(one => <option key={one.id} value={one.id}>{one.title}</option>)}</select></label>}
        {projectId === undefined ? <p className="ben-cl__muted">当前事项和目标还没有归属项目，无法确定局域网频道范围。</p> : <LanProjectFeed key={projectId} api={props.api} projectId={projectId} tick={props.lanTick ?? props.tick} nowMs={props.nowMs} />}
      </section>
      <section aria-label="中转工作室频道"><h3>中转工作室频道</h3><RelayChannelView {...props} /></section>
    </div>
  )
}

function RelayChannelView({ api, tick, nowMs, onOpenStudio, onReceipt: _onReceipt }: ChannelViewProps) {
  const { studio, reload } = useRelayStudio(api, tick)
  const live = (studio?.channels ?? []).filter(one => one.archived_at === undefined)
  const [picked, setPicked] = useState<string | undefined>(undefined)
  const channelId = picked ?? live.find(one => one.kind === 'workspace')?.id ?? live[0]?.id
  const [snap, setSnap] = useState<CollabChannelSnapshot | null | undefined>(undefined)
  useEffect(() => {
    if (channelId === undefined) return undefined
    let alive = true
    void api.get<CollabChannelSnapshot>(`/collab/relay/channel?id=${encodeURIComponent(channelId)}`).then((got) => { if (alive) setSnap(got ?? null) })
    return () => { alive = false }
  }, [api, channelId, tick])

  if (studio === undefined) return <div className="ben-cl__relay-feed"><p className="ben-cl__muted" role="status">正在读频道…</p></div>
  if (studio.state === 'unwired') return <div className="ben-cl__channel-empty"><Empty title="没接中转" hint={STUDIO_STATE_TEXT.unwired} /></div>
  if (studio.state === 'offline') {
    return <div className="ben-cl__channel-empty"><Empty title="连不上中转" hint={studio.why ?? STUDIO_STATE_TEXT.offline} action="再试一次" onAction={reload} /></div>
  }
  if (studio.state === 'none') {
    return <div className="ben-cl__channel-empty"><Empty title="还没加入工作室" hint="频道在工作室里:建一个工作室,或用邀请码加入。" action="去设置" onAction={onOpenStudio} /></div>
  }
  if (channelId === undefined) return <div className="ben-cl__channel-empty"><Empty title="还没有频道" hint="这个工作室里还没有频道。" /></div>
  const messages = (snap?.messages ?? []).filter(one => one.retract_of === undefined)
  return (
    <div className="ben-cl__relay-feed" role="region" aria-label="频道">
      {live.length > 1 && (
        <select aria-label="选频道" value={channelId} onChange={event => setPicked(event.target.value)}>
          {live.map(one => <option key={one.id} value={one.id}>{one.name}</option>)}
        </select>
      )}
      {snap === null && <p className="ben-cl__muted" role="status">频道此刻读不到。</p>}
      {snap !== null && snap !== undefined && messages.length === 0 && <p className="ben-cl__muted">还没有人说话。</p>}
      {messages.length > 0 && (
        <ul className="ben-cl__msgs" aria-label="频道消息">
          {messages.map(one => <Message key={one.id} one={one} nowMs={nowMs} />)}
        </ul>
      )}
      <p className="ben-cl__muted ben-cl__chview-note">频道由事务官们交流,人在这里只读旁观。</p>
    </div>
  )
}
