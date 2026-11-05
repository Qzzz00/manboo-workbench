/**
 * 协作区里「头像 + 名称」的可点标签(2026-10-21 协作区评审 ④⑤)。
 *
 * 一处上下文(名片、头像表、选中的是谁):时间线卡、目标视图便签、会议卡、名片栏都从这里读,
 * 换了头像各处标签跟着同一份 `/state.tasks.avatars` 一起变。点标签 = 选中这个人(再点取消),
 * 相关的突出、其余原位变淡(由各视图按 peopleModel 算)。
 * 头像:有自定义用自定义(内置库画的图 / 本机存的照片),没有就一个字;人圆形、Agent 圆角。
 * **顶部各家客户端的 Logo 不走这里**,自定义头像只用在协作区的名片与标签上。
 */
import { createContext, useContext } from 'react'
import type { CollabAvatar, MeetingView, TaskView } from '../../protocol.ts'
import { boardAssignee } from '../../protocol.ts'
import { useAssigneeName, useMeName } from '../meName.tsx'
import type { RailCard } from './collabModel.ts'
import type { AvatarKind } from './avatarModel.ts'
import { presetOf } from './avatarModel.ts'
import { avatarGlyph } from './peopleModel.ts'
import { AgentIcon } from '../AgentIcon.tsx'

export interface PeopleCtx {
  cards: readonly RailCard[]
  avatars: Readonly<Record<string, CollabAvatar>>
  baseUrl: string
  selected: string | undefined
  onSelect: (id: string) => void
}

const Ctx = createContext<PeopleCtx>({ cards: [], avatars: {}, baseUrl: '', selected: undefined, onSelect: () => {} })
export const PeopleProvider = Ctx.Provider
export const usePeople = (): PeopleCtx => useContext(Ctx)

const TONES = ['#e2e0db', '#c7c9ca', '#ddd7ce', '#b9bdb9', '#e7e7e3', '#c8c3bc', '#d1d3d4', '#bfc1be']
const SKIN = ['#eae6df', '#d2ccc3', '#bab5ae', '#f2eee6']
const INK = ['#343536', '#555759', '#282a2c', '#6b6b69']
const HAIR = [
  'M18 32Q14 12 32 12Q50 12 47 32L42 22Q32 27 22 22Z',
  'M18 42V27Q18 11 32 11Q47 11 47 27V42L42 34V25Q31 28 23 22V36Z',
  'M19 30Q19 14 32 14Q46 14 46 30L41 22L33 25L25 21Z',
  'M20 26Q15 15 25 16Q27 9 34 12Q43 10 46 20V28Q32 21 20 26Z',
]

/** 内置库的一张图(灰阶,自己画的几笔;不冒充任何品牌 Logo)。 */
export function PresetArt({ id }: { id: string }) {
  const preset = presetOf(id)
  if (preset === undefined) return null
  const { n, kind } = preset
  const bg = TONES[n % TONES.length]
  const skin = SKIN[n % 4]
  const ink = INK[n % 4]
  return (
    <svg viewBox="0 0 64 64" width="100%" height="100%" aria-hidden="true">
      <rect width="64" height="64" fill={bg} />
      {kind === 'human'
        ? (
            <>
              <path d="M8 64Q9 46 27 45H37Q55 46 56 64" fill={ink} />
              <path d="M27 40V48Q32 53 37 48V40" fill={skin} />
              <ellipse cx="32" cy="30" rx="14" ry="17" fill={skin} />
              <path d={HAIR[n % 4]} fill={ink} />
              {n % 3 === 0 && <g fill="none" stroke="#353535" strokeWidth="1.4"><circle cx="26" cy="31" r="4" /><circle cx="38" cy="31" r="4" /><path d="M30 31h4" /></g>}
            </>
          )
        : (
            <>
              <path d="M11 64q2-16 21-16t21 16" fill={ink} />
              <path d="M32 10v8" stroke={ink} strokeWidth="3" />
              <circle cx="32" cy="9" r="3" fill={ink} />
              <rect x="12" y="18" width="40" height="31" rx={n % 2 === 1 ? 12 : 7} fill={ink} />
              <rect x="17" y="23" width="30" height="20" rx={n % 2 === 1 ? 8 : 4} fill={skin} />
              {n % 3 === 0 && <path d="M23 32h5M36 32h5" stroke="#303234" strokeWidth="3" strokeLinecap="round" />}
              {n % 3 === 1 && <><circle cx="25" cy="32" r="3" fill="#303234" /><circle cx="39" cy="32" r="3" fill="#303234" /></>}
              {n % 3 === 2 && <><rect x="22" y="29" width="7" height="6" rx="1" fill="#303234" /><rect x="35" y="29" width="7" height="6" rx="1" fill="#303234" /></>}
            </>
          )}
    </svg>
  )
}

export function avatarUrl(baseUrl: string, owner: string, avatar: Extract<CollabAvatar, { kind: 'photo' }>): string {
  return `${baseUrl}/collab/avatar/${encodeURIComponent(owner)}.png?v=${avatar.v}`
}

export const kindOfCard = (card: Pick<RailCard, 'kind'> | undefined, id?: string): AvatarKind => {
  if (card !== undefined) return card.kind === 'me' ? 'human' : 'agent'
  if (id === 'me' || id?.startsWith('alias:')) return 'human'
  if (id !== undefined && (id.startsWith('agent:') || id === 'codex' || id === 'claude' || id === 'kimi')) return 'agent'
  return 'human'
}

/** 头像框。`draft` 给预览用(编辑器里还没存的那一张);`null` = 预览「恢复默认」。 */
export function AvatarFace({ owner, name, kind, draft, photoSrc, color }: {
  owner: string
  name: string
  kind: AvatarKind
  draft?: CollabAvatar | null
  /** 编辑器里还没存的照片(dataURL)。 */
  photoSrc?: string
  color?: string | undefined
}) {
  const { cards, avatars, baseUrl } = usePeople()
  const avatar = draft === undefined ? avatars[owner] : draft ?? undefined
  const card = cards.find(one => one.id === owner)
  const agentFamily = kind === 'human' && owner === 'me'
    ? undefined
    : (card?.runtimeFamily ?? card?.hand ?? (card?.kind === 'agent' ? card.id : owner.startsWith('agent:') ? owner.slice('agent:'.length) : (['codex', 'claude', 'kimi'].includes(owner) ? owner : undefined)))

  let inner: JSX.Element | string
  if (photoSrc !== undefined) inner = <img src={photoSrc} alt="" />
  else if (avatar?.kind === 'photo') inner = <img src={avatarUrl(baseUrl, owner, avatar)} alt="" />
  else if (avatar?.kind === 'preset' && presetOf(avatar.id) !== undefined) inner = <PresetArt id={avatar.id} />
  else if (agentFamily !== undefined) inner = <AgentIcon id={agentFamily} icon={true} tint={color ?? card?.color} baseUrl={baseUrl} />
  else inner = avatarGlyph(name, kind === 'human' ? 'member' : 'agent')
  return (
    <span className="ben-cl__avatar" data-round={kind === 'human' && agentFamily === undefined} data-custom={typeof inner !== 'string'} aria-hidden="true" style={color === undefined ? undefined : { ['--cl-avatar' as string]: color }}>
      {inner}
    </span>
  )
}

/** 可点的「头像 + 名称」标签。认不出的 id 照名字画、不给点(不猜是谁)。 */
export function PersonLabel({ id, name, mini }: { id: string, name?: string, mini?: boolean }) {
  const { cards, selected, onSelect } = usePeople()
  const card = cards.find(one => one.id === id)
  const fallbackName = useAssigneeName()
  const shown = name ?? card?.name ?? fallbackName(id)
  const kind = kindOfCard(card, id)
  if (card === undefined) {
    return <span className="ben-cl__person" data-mini={mini === true}><AvatarFace owner={id} name={shown} kind={kind} />{shown}</span>
  }
  return (
    <button
      type="button"
      className="ben-cl__person nodrag"
      data-mini={mini === true}
      aria-pressed={selected === id}
      aria-label={`看 ${shown} 的相关事项`}
      onClick={(event) => { event.stopPropagation(); onSelect(id) }}
    >
      <AvatarFace owner={id} name={shown} kind={kind} color={card.color} />
      <span className="ben-cl__person-name">{shown}</span>
    </button>
  )
}

/**
 * 便签上的人:负责人(派给小队时名字写成「小队 · 组长 → 负责人」,标签点的仍是负责人)+ 协作人。
 * 还没人领就照写那一句,不画头像。
 */
export function NoteOwners({ task, ownerText }: { task: TaskView, ownerText: string }) {
  const owner = boardAssignee(task.assignee)
  return (
    <>
      {owner === undefined ? <span className="ben-cl__muted">{ownerText}</span> : <PersonLabel id={owner} name={ownerText} mini />}
      {(task.collaborators ?? []).filter(one => one !== owner).map(one => <PersonLabel key={one} id={one} mini />)}
    </>
  )
}

/** 会议上的人:你总在场;会前登记的参与人按花名对得上名片就能点,对不上照写名字。 */
export function MeetingPeople({ meeting, mini }: { meeting: MeetingView, mini?: boolean }) {
  const { cards } = usePeople()
  const meName = useMeName()
  const people = meeting.prep?.people?.value ?? []
  return (
    <>
      <PersonLabel id="me" name={meName} {...(mini === true ? { mini } : {})} />
      {people.map((one) => {
        const card = cards.find(c => c.name === one.alias)
        return <PersonLabel key={one.alias} id={card?.id ?? `alias:${one.alias}`} name={one.alias} {...(mini === true ? { mini } : {})} />
      })}
    </>
  )
}
