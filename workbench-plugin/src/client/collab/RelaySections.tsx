/**
 * 协作区跨机那几屏(2026-10-21,接中转底座)。全部走本机 `/collab/relay/*`,令牌只在座机服务里,界面一枚都不碰。
 *
 * - 工作室四种样子照实画:没登录中转账号(unwired)、连不上(offline)、没加入(none:建工作室 / 输入邀请码两条路)、已加入;
 * - 频道、别人共享的 Agent、请它做、主人那边的待批、定时派活的回调地址、企业微信绑定,都等座机服务回包再画,不摆假数据;
 * - 没办成就把服务端那一句原样给人看。
 */
import { useCallback, useEffect, useState } from 'react'
import type {
  CollabChannelMessage, CollabChannelSnapshot, CollabChannelView, CollabObjectView, CollabWecomBinding,
  TaskView, WorkspaceMemberView, WorkspaceRole, WorkspaceView,
} from '../../protocol.ts'
import type { CollabApi } from './collabApi.ts'
import { presetOf } from './avatarModel.ts'
import { PresetArt } from './people.tsx'
import { avatarGlyph } from './peopleModel.ts'

/** `GET /collab/relay/studio` 的回包。 */
export interface RelayStudio {
  state: 'unwired' | 'none' | 'joined' | 'offline'
  why?: string
  me?: { account_id: string, nick: string, role: WorkspaceRole }
  workspace?: WorkspaceView | null
  members?: readonly WorkspaceMemberView[]
  channels?: readonly CollabChannelView[]
}

/** `GET /collab/relay/asks` 里的一条:别人请你的 Agent 做事,等你批。 */
export interface RelayAsk {
  request_id: string
  from_account: string
  from_nick?: string
  card_id: string
  card_name: string
  title: string
  acceptance?: readonly string[]
  repos?: readonly string[]
  budget_per_day?: number
  at: string
}

export const STUDIO_STATE_TEXT: Readonly<Record<'unwired' | 'offline', string>> = {
  unwired: '这台还没登录中转账号,工作室用不了;先在设置里登录账号。',
  offline: '连不上中转,工作室此刻看不到;网络好了再刷新。',
}

/** 读工作室的样子;`tick` 变了就重读(座机服务推一拍,界面跟着刷新)。 */
export function useRelayStudio(api: CollabApi, tick: unknown): { studio: RelayStudio | undefined, reload: () => void } {
  const [studio, setStudio] = useState<RelayStudio | undefined>(undefined)
  const [nonce, setNonce] = useState(0)
  useEffect(() => {
    let live = true
    void api.get<RelayStudio>('/collab/relay/studio').then((got) => {
      if (!live) return
      const known = got !== undefined && ['unwired', 'none', 'joined', 'offline'].includes(got.state)
      setStudio(known ? got : { state: 'offline', why: '工作台服务没应答,稍后再试' })
    })
    return () => { live = false }
  }, [api, tick, nonce])
  return { studio, reload: useCallback(() => setNonce(value => value + 1), []) }
}

const online = (member: WorkspaceMemberView, nowMs: number): boolean =>
  member.devices.some(one => one.last_seen_at !== undefined && nowMs - Date.parse(one.last_seen_at) < 2 * 60_000)

export function StudioSection({ api, tick, notes, onReceipt }: {
  api: CollabApi
  tick: unknown
  notes: readonly TaskView[]
  onReceipt: (text: string) => void
}) {
  const { studio, reload } = useRelayStudio(api, tick)
  const [name, setName] = useState('')
  const [nick, setNick] = useState('')
  const [code, setCode] = useState('')
  const [invite, setInvite] = useState<{ code: string, expires_at: string } | undefined>(undefined)
  const done = (text: string): void => { onReceipt(text); reload() }

  if (studio === undefined) return <section className="ben-cl__setsec" aria-label="工作室"><h3>工作室</h3><p className="ben-cl__muted" role="status">在问中转…</p></section>
  if (studio.state === 'unwired' || studio.state === 'offline') {
    return (
      <section className="ben-cl__setsec" aria-label="工作室">
        <h3>工作室</h3>
        <p className="ben-cl__muted" role="status">{studio.why ?? STUDIO_STATE_TEXT[studio.state]}</p>
        <div className="ben-cl__setrow">
          <button type="button" className="ben-cl__primary" disabled>建一个工作室</button>
          <button type="button" disabled>用邀请码加入</button>
          {studio.state === 'offline' && <button type="button" onClick={reload}>再试一次</button>}
        </div>
      </section>
    )
  }
  if (studio.state === 'none' || studio.workspace === null || studio.workspace === undefined) {
    return (
      <section className="ben-cl__setsec" aria-label="工作室">
        <h3>工作室</h3>
        <p className="ben-cl__muted" role="status">还没加入工作室。自己建一个,或者用别人给的邀请码加入。</p>
        <form
          className="ben-cl__form"
          aria-label="建一个工作室"
          onSubmit={(event) => {
            event.preventDefault()
            void api.post('/collab/relay/studio/create', { name: name.trim(), nick: nick.trim() }).then(got => done(got.ok ? `工作室「${name.trim()}」建好了` : got.error ?? '没建成'))
          }}
        >
          <label htmlFor="cl-studio-name">工作室名字</label><input id="cl-studio-name" value={name} onChange={event => setName(event.target.value)} />
          <label htmlFor="cl-studio-nick">你的花名</label><input id="cl-studio-nick" value={nick} onChange={event => setNick(event.target.value)} />
          <span /><button type="submit" className="ben-cl__primary" disabled={name.trim() === '' || nick.trim() === ''}>建一个工作室</button>
        </form>
        <form
          className="ben-cl__form"
          aria-label="用邀请码加入"
          onSubmit={(event) => {
            event.preventDefault()
            void api.post('/collab/relay/studio/join', { code: code.trim(), nick: nick.trim() }).then(got => done(got.ok ? '加入了' : got.error ?? '没加入成'))
          }}
        >
          <label htmlFor="cl-studio-code">邀请码</label><input id="cl-studio-code" value={code} onChange={event => setCode(event.target.value)} placeholder="8 位" />
          <span>花名</span><span className="ben-cl__muted">用上面填的那个</span>
          <span /><button type="submit" disabled={code.trim() === '' || nick.trim() === ''}>加入</button>
        </form>
      </section>
    )
  }

  const workspace = studio.workspace
  const admin = studio.me?.role === 'admin'
  const nowMs = Date.now()
  return (
    <section className="ben-cl__setsec" aria-label="工作室">
      <h3>工作室 · {workspace.name}</h3>
      <p className="ben-cl__muted">你是「{studio.me?.nick ?? ''}」{admin ? ' · 管理员' : ''}</p>
      <h4>成员</h4>
      <ul aria-label="成员">
        {(studio.members ?? []).map(member => (
          <li key={member.account_id} className="ben-cl__setrow">
            <b>{member.nick}</b>
            <span>{member.role === 'admin' ? '管理员' : '成员'}</span>
            <span className="ben-cl__muted">{online(member, nowMs) ? '在线' : '不在线'}</span>
            {admin && member.account_id !== studio.me?.account_id && (
              <>
                <button type="button" onClick={() => { void api.post('/collab/relay/studio/role', { account_id: member.account_id, role: member.role === 'admin' ? 'member' : 'admin' }).then(got => done(got.ok ? '改好了' : got.error ?? '没改成')) }}>
                  {member.role === 'admin' ? '改成成员' : '设为管理员'}
                </button>
                <button type="button" onClick={() => { void api.post('/collab/relay/studio/remove', { account_id: member.account_id }).then(got => done(got.ok ? `请「${member.nick}」离开了` : got.error ?? '没办成')) }}>请离开</button>
              </>
            )}
          </li>
        ))}
      </ul>
      {admin && (
        <div className="ben-cl__setrow">
          <button type="button" onClick={() => { void api.post('/collab/relay/studio/invite', {}).then((got) => { const one = got.body.invite as { code: string, expires_at: string } | undefined; if (got.ok && one !== undefined) setInvite(one); else onReceipt(got.error ?? '没拿到邀请码') }) }}>发一个邀请码</button>
          {invite !== undefined && <span role="status">邀请码 <b>{invite.code}</b> · {invite.expires_at.slice(5, 16).replace('T', ' ')} 前有效</span>}
        </div>
      )}
      <ChannelPanel api={api} tick={tick} channels={studio.channels ?? []} onReceipt={onReceipt} />
      <StudioAgents api={api} tick={tick} me={studio.me?.account_id} notes={notes} onReceipt={onReceipt} />
    </section>
  )
}

function messageText(one: CollabChannelMessage): string {
  if (one.retracted !== undefined) return '(已撤回)'
  return one.text
}

export function ChannelPanel({ api, tick, channels, onReceipt }: {
  api: CollabApi
  tick: unknown
  channels: readonly CollabChannelView[]
  onReceipt: (text: string) => void
}) {
  const live = channels.filter(one => one.archived_at === undefined)
  const [picked, setPicked] = useState<string>(live.find(one => one.kind === 'workspace')?.id ?? live[0]?.id ?? '')
  const [snap, setSnap] = useState<CollabChannelSnapshot | undefined>(undefined)
  const [text, setText] = useState('')
  const [nonce, setNonce] = useState(0)
  useEffect(() => {
    if (picked === '') return undefined
    let alive = true
    void api.get<CollabChannelSnapshot>(`/collab/relay/channel?id=${encodeURIComponent(picked)}`).then((got) => { if (alive) setSnap(got) })
    return () => { alive = false }
  }, [api, picked, tick, nonce])
  if (live.length === 0) return <p className="ben-cl__muted">这个工作室还没有频道。</p>
  return (
    <div role="region" aria-label="频道">
      <h4>频道</h4>
      {live.length > 1 && (
        <select aria-label="选频道" value={picked} onChange={event => setPicked(event.target.value)}>
          {live.map(one => <option key={one.id} value={one.id}>{one.name}</option>)}
        </select>
      )}
      {snap === undefined
        ? <p className="ben-cl__muted" role="status">频道此刻读不到。</p>
        : snap.messages.length === 0
          ? <p className="ben-cl__muted">还没有人说话。</p>
          : (
              <ul aria-label="频道消息" className="ben-cl__channel">
                {snap.messages.filter(one => one.retract_of === undefined).map(one => (
                  <li key={one.id}>
                    <b>{one.author.nick}{one.author.butler === true ? ' 的事务官' : ''}</b>
                    {one.via === 'wecom' && <span className="ben-cl__muted"> · 企微</span>}
                    <span className="ben-cl__muted"> {one.at.slice(5, 16).replace('T', ' ')}</span>
                    <div>{messageText(one)}</div>
                  </li>
                ))}
              </ul>
            )}
      <form
        className="ben-cl__setrow"
        aria-label="在频道里说"
        onSubmit={(event) => {
          event.preventDefault()
          const said = text.trim()
          void api.post('/collab/relay/channel/say', { channel_id: picked, text: said }).then((got) => {
            if (got.ok) { setText(''); setNonce(value => value + 1) }
            else onReceipt(got.error ?? '没发出去')
          })
        }}
      >
        <input aria-label="说点什么" value={text} onChange={event => setText(event.target.value)} />
        <button type="submit" className="ben-cl__primary" disabled={text.trim() === ''}>发</button>
      </form>
    </div>
  )
}

const OPEN_NOTE = new Set(['backlog', 'todo', 'blocked'])

/** 工作室里别人共享的 Agent:在线与否照中转说;请它做 = 把一张便签发到主人那里等批。 */
export function StudioAgents({ api, tick, me, notes, onReceipt }: {
  api: CollabApi
  tick: unknown
  me: string | undefined
  notes: readonly TaskView[]
  onReceipt: (text: string) => void
}) {
  const [cards, setCards] = useState<readonly CollabObjectView[] | undefined>(undefined)
  const [pick, setPick] = useState<Record<string, string>>({})
  useEffect(() => {
    let alive = true
    void api.get<{ cards: CollabObjectView[] }>('/collab/relay/agents').then((got) => { if (alive) setCards(got?.cards) })
    return () => { alive = false }
  }, [api, tick])
  const others = (cards ?? []).filter(one => one.owner_account !== me)
  const open = notes.filter(one => OPEN_NOTE.has(one.status))
  return (
    <div role="region" aria-label="工作室里的 Agent">
      <h4>别人共享的 Agent</h4>
      {cards === undefined && <p className="ben-cl__muted" role="status">此刻读不到。</p>}
      {cards !== undefined && others.length === 0 && <p className="ben-cl__muted">还没有人共享 Agent。</p>}
      {others.map((card) => {
        const data = (card.data ?? {}) as { good_at?: string, avatar?: { preset?: string, thumb?: string } }
        const noteId = pick[card.object_id] ?? ''
        return (
          <div key={card.object_id} className="ben-cl__setrow">
            <RemoteAvatar avatar={data.avatar} name={card.title} />
            <b>{card.title}</b>
            {data.good_at !== undefined && <span>{data.good_at}</span>}
            <span className="ben-cl__muted">{card.owner_online === true ? '主人在线' : '主人不在线,请求会排队'}</span>
            <select aria-label={`交给 ${card.title} 的便签`} value={noteId} onChange={event => setPick({ ...pick, [card.object_id]: event.target.value })}>
              <option value="">选一张便签</option>
              {open.map(one => <option key={one.id} value={one.id}>{one.title}</option>)}
            </select>
            <button
              type="button"
              disabled={noteId === '' || card.owner_account === null}
              onClick={() => {
                void api.post('/collab/relay/borrow', { object_id: card.object_id, owner_account: card.owner_account, owner_epoch: card.owner_epoch, note_id: noteId })
                  .then(got => onReceipt(got.ok ? `请求发到「${card.title}」的主人那里了,批了才开工` : got.error ?? '没发出去'))
              }}
            >请它做</button>
          </div>
        )
      })}
    </div>
  )
}

/** 别人名片上的头像:中转只带内置库编号或 64 像素缩略图(原图不过中转);都没有就一个字。 */
function RemoteAvatar({ avatar, name }: { avatar: { preset?: string, thumb?: string } | undefined, name: string }) {
  const thumb = avatar?.thumb !== undefined && avatar.thumb.startsWith('data:image/png;base64,') ? avatar.thumb : undefined
  const preset = avatar?.preset !== undefined && presetOf(avatar.preset) !== undefined ? avatar.preset : undefined
  return (
    <span className="ben-cl__avatar" data-round={false} data-custom={thumb !== undefined || preset !== undefined} aria-hidden="true">
      {thumb !== undefined ? <img src={thumb} alt="" /> : preset !== undefined ? <PresetArt id={preset} /> : avatarGlyph(name, 'agent')}
    </span>
  )
}

/** 主人那边:别人请你的 Agent 做事,在「现在等你」里批 / 不批。数从 `/state` 来,有了才去读。 */
export function RelayAsks({ api, count, onReceipt }: { api: CollabApi, count: number, onReceipt: (text: string) => void }) {
  const [asks, setAsks] = useState<readonly RelayAsk[]>([])
  const [nonce, setNonce] = useState(0)
  useEffect(() => {
    if (count === 0) { setAsks([]); return undefined }
    let alive = true
    void api.get<{ asks: RelayAsk[] }>('/collab/relay/asks').then((got) => { if (alive) setAsks(got?.asks ?? []) })
    return () => { alive = false }
  }, [api, count, nonce])
  if (asks.length === 0) return null
  return (
    <>
      {asks.map(ask => (
        <span key={ask.request_id} className="ben-cl__chip" data-kind="ask">
          <span className="ben-cl__chip-text">
            {`${ask.from_nick ?? '工作室的人'} 请「${ask.card_name}」做「${ask.title}」`}
            {ask.acceptance !== undefined && ask.acceptance.length > 0 ? ` · 做到:${ask.acceptance.join(';')}` : ''}
          </span>
          {[true, false].map(approve => (
            <button
              key={String(approve)}
              type="button"
              className={approve ? 'ben-cl__secondary' : undefined}
              aria-label={`${approve ? '批' : '不批'} ${ask.title}`}
              onClick={() => {
                void api.post('/collab/relay/asks/answer', { request_id: ask.request_id, approve }).then((got) => {
                  onReceipt(got.ok ? (approve ? `批了,「${ask.card_name}」开工` : '回了不批') : got.error ?? '没办成')
                  setNonce(value => value + 1)
                })
              }}
            >{approve ? '批' : '不批'}</button>
          ))}
        </span>
      ))}
    </>
  )
}

/** 定时派活的回调地址:要一个 / 换一个。整串地址就是钥匙,只在发的那一下显示一次;定时上存的只是遮住尾巴的样子。 */
export function WebhookButton({ api, timerId, hasUrl, onReceipt }: { api: CollabApi, timerId: string, hasUrl: boolean, onReceipt: (text: string) => void }) {
  const [shown, setShown] = useState<string | undefined>(undefined)
  return (
    <>
      <button
        type="button"
        onClick={() => {
          void api.post(hasUrl ? '/collab/relay/webhook/rotate' : '/collab/relay/webhook', { timer_id: timerId }).then((got) => {
            const url = typeof got.body.url === 'string' ? got.body.url : undefined
            if (got.ok && url !== undefined) setShown(url)
            onReceipt(got.ok ? (hasUrl ? '换了新地址,旧地址作废' : '地址发下来了') : got.error ?? '没拿到地址')
          })
        }}
      >{hasUrl ? '换地址' : '要一个地址'}</button>
      {shown !== undefined && (
        <span role="status" aria-label="回调地址(只显示这一次)">
          <code>{shown}</code> <span className="ben-cl__muted">只显示这一次,现在抄走;丢了就换一个。</span>
        </span>
      )}
    </>
  )
}

export function WecomSection({ api, tick, onReceipt }: { api: CollabApi, tick: unknown, onReceipt: (text: string) => void }) {
  const { studio } = useRelayStudio(api, tick)
  const [bindings, setBindings] = useState<readonly CollabWecomBinding[] | undefined>(undefined)
  const [channel, setChannel] = useState('')
  const [code, setCode] = useState<{ code: string, expires_at: string } | undefined>(undefined)
  const [nonce, setNonce] = useState(0)
  const joined = studio?.state === 'joined'
  useEffect(() => {
    if (!joined) return undefined
    let alive = true
    void api.get<{ bindings: CollabWecomBinding[] }>('/collab/relay/wecom').then((got) => { if (alive) setBindings(got?.bindings) })
    return () => { alive = false }
  }, [api, joined, tick, nonce])
  const channels = (studio?.channels ?? []).filter(one => one.archived_at === undefined)
  const channelName = (id: string): string => channels.find(one => one.id === id)?.name ?? id
  return (
    <section className="ben-cl__setsec" aria-label="企业微信机器人">
      <h3>企业微信机器人</h3>
      {studio === undefined && <p className="ben-cl__muted" role="status">在问中转…</p>}
      {studio !== undefined && !joined && (
        <p className="ben-cl__muted" role="status">
          {studio.state === 'none' ? '机器人绑在工作室的频道上;先在「工作室」里建一个或加入。' : studio.why ?? STUDIO_STATE_TEXT[studio.state === 'unwired' ? 'unwired' : 'offline']}
        </p>
      )}
      {joined && (
        <>
          {bindings === undefined && <p className="ben-cl__muted" role="status">绑定此刻读不到。</p>}
          {bindings !== undefined && bindings.length === 0 && <p className="ben-cl__muted">还没有绑定的群。</p>}
          {(bindings ?? []).map(one => (
            <div key={one.chatid} className="ben-cl__setrow">
              <b>群 {one.chatid}</b>
              <span>→ {channelName(one.channel_id)}</span>
              <button type="button" onClick={() => { void api.post('/collab/relay/wecom/remove', { chatid: one.chatid }).then((got) => { onReceipt(got.ok ? '解绑了' : got.error ?? '没解绑成'); setNonce(value => value + 1) }) }}>解绑</button>
            </div>
          ))}
          <div className="ben-cl__setrow">
            <select aria-label="绑到哪个频道" value={channel} onChange={event => setChannel(event.target.value)}>
              <option value="">选一个频道</option>
              {channels.map(one => <option key={one.id} value={one.id}>{one.name}</option>)}
            </select>
            <button
              type="button"
              disabled={channel === ''}
              onClick={() => { void api.post('/collab/relay/wecom/code', { channel_id: channel }).then((got) => { if (got.ok) setCode(got.body as { code: string, expires_at: string }); else onReceipt(got.error ?? '没拿到绑定码') }) }}
            >要一个绑定码</button>
            {code !== undefined && <span role="status">在群里 @机器人 发「绑定 <b>{code.code}</b>」· {code.expires_at.slice(5, 16).replace('T', ' ')} 前有效</span>}
          </div>
        </>
      )}
    </section>
  )
}
