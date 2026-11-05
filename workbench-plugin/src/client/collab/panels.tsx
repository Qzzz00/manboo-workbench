/**
 * 板四周的三样:顶上「现在等你」一条、筛选条、右边名片栏(设计稿第〇、四节)。
 *
 * - 「现在等你」替代今天七个桶的计数:章是「等你」、且事务官标了四类拍板请求的便签(2026-10-26 卡
 *   「事务官页接管队列」;没标的是事务官待核验队列,不摊给他),点一下板飞过去;后面跟着「这条会话放进哪个目标?」
 *   (只有一个目标时不问,事务官直接放进去,这里留一行已办说明;10-22 第三轮 4 维护者定 B);
 * - 筛选:项目 / 版本 / 模块 / 冲刺 / 负责人 / 章 / 标签 / 属性,多选,筛掉的变淡不消失;
 * - 名片栏:你 + 本机 Agent(登记表里接上的几家)+ 登记过的名片;在不在线、现在在哪张便签上。
 */
import type { ReactNode } from 'react'
import { useState } from 'react'
import type { AgentEntryView, CollabGoal, CollabSprint, SessionPlaced, TaskStatus, TaskView } from '../../protocol.ts'
import { STAMP_TITLES, assigneeName, boardAssignee } from '../../protocol.ts'
import { AvatarFace, kindOfCard } from './people.tsx'
import type { CollabFilter, FilterKey, RailCard, WaitingItem } from './collabModel.ts'
import type { CapacityItem } from '../../protocol.ts'
import { FILTER_KEYS, FILTER_TITLES } from './collabModel.ts'
import { useWorkTypes } from './workTypes.tsx'

/** 放进哪个目标:现成的目标 id,或新建一个(带名字)。 */
export type GoalChoice = { goalId: string } | { newGoalTitle: string }

const NEW_GOAL = '__new__'
export const PLACE_HINT = '放进去:看板上多一张在做的便签,进度算进这个目标,以后在它下面跟进验收'
export const SKIP_HINT = '不进看板:看板不出现,以后不再问,这条会话照常跑'

/** 多个 / 没有目标时那一行:「『X』这条会话,放进哪个目标?」+ 下拉 +「放进去」/「不进看板」,键下各一行后果。
 *  只到得了这一行的都是服务端对不上目标的(任务书 11):带 new_goal_title 的默认选中「新建目标…」,带 goal_id 的默认选中那个目标。 */
function ProposalRow({ item, goals, onPlace, onDismiss }: {
  item: Extract<WaitingItem, { kind: 'proposal' }>
  goals: readonly CollabGoal[]
  onPlace: (item: Extract<WaitingItem, { kind: 'proposal' }>, choice: GoalChoice) => void
  onDismiss: (item: Extract<WaitingItem, { kind: 'proposal' }>) => void
}) {
  const { proposal } = item
  const open = goals.filter(one => one.status === 'open')
  const first = proposal.new_goal_title !== undefined ? NEW_GOAL
    : proposal.goal_id !== undefined && open.some(one => one.id === proposal.goal_id) ? proposal.goal_id
      : open.length === 0 ? NEW_GOAL : open[0]?.id ?? NEW_GOAL
  const [pick, setPick] = useState(first)
  const [name, setName] = useState(proposal.new_goal_title ?? proposal.title)
  const choice: GoalChoice = pick === NEW_GOAL ? { newGoalTitle: name.trim() === '' ? proposal.title : name.trim() } : { goalId: pick }
  return (
    <span className="ben-cl__chip ben-cl__place" data-kind="proposal">
      <span className="ben-cl__chip-text">「{proposal.title}」这条会话,放进哪个目标?</span>
      <select aria-label={`「${proposal.title}」放进哪个目标`} value={pick} onChange={event => setPick(event.target.value)}>
        {open.map(one => <option key={one.id} value={one.id}>{one.title}</option>)}
        <option value={NEW_GOAL}>新建目标…</option>
      </select>
      {pick === NEW_GOAL && <input aria-label="新目标叫什么" value={name} onChange={event => setName(event.target.value)} />}
      <span className="ben-cl__place-acts">
        <span className="ben-cl__place-act">
          <button type="button" className="ben-cl__primary" onClick={() => onPlace(item, choice)}>放进去</button>
          <small>{PLACE_HINT}</small>
        </span>
        <span className="ben-cl__place-act">
          <button type="button" className="ben-cl__secondary" onClick={() => onDismiss(item)}>不进看板</button>
          <small>{SKIP_HINT}</small>
        </span>
      </span>
    </span>
  )
}

/** 只有一个目标时已经放进去的那一条:一行已办说明 +「换目标」+「不进看板」。点标题飞到那张便签(算看过)。 */
function PlacedRow({ placed, task, goals, nameOf, onOpen, onMove, onRemove }: {
  placed: SessionPlaced
  task: TaskView | undefined
  goals: readonly CollabGoal[]
  nameOf: (id: string | undefined) => string
  onOpen: (placed: SessionPlaced) => void
  onMove: (placed: SessionPlaced, choice: GoalChoice) => void
  onRemove: (placed: SessionPlaced) => void
}) {
  const [pick, setPick] = useState('')
  const [name, setName] = useState(placed.title)
  const goalTitle = goals.find(one => one.id === placed.goal_id)?.title ?? '未归目标'
  const others = goals.filter(one => one.status === 'open' && one.id !== placed.goal_id)
  const stamp = STAMP_TITLES[task?.status ?? 'doing']
  return (
    <span className="ben-cl__chip ben-cl__place" data-kind="placed">
      <button type="button" className="ben-cl__chip-text ben-cl__linkish" onClick={() => onOpen(placed)} title="看这张便签">
        「{placed.title}」已放进目标「{goalTitle}」,负责 {nameOf(task?.assignee ?? placed.agent)},{stamp}
      </button>
      <select
        aria-label={`「${placed.title}」换目标`}
        value={pick}
        onChange={(event) => {
          const next = event.target.value
          setPick(next)
          if (next !== '' && next !== NEW_GOAL) onMove(placed, { goalId: next })
        }}
      >
        <option value="">换目标</option>
        {others.map(one => <option key={one.id} value={one.id}>{one.title}</option>)}
        <option value={NEW_GOAL}>新建目标…</option>
      </select>
      {pick === NEW_GOAL && (
        <>
          <input aria-label="新目标叫什么" value={name} onChange={event => setName(event.target.value)} />
          <button type="button" className="ben-cl__secondary" onClick={() => onMove(placed, { newGoalTitle: name.trim() === '' ? placed.title : name.trim() })}>换过去</button>
        </>
      )}
      <button type="button" className="ben-cl__secondary" onClick={() => onRemove(placed)}>不进看板</button>
    </span>
  )
}

export function WaitingStrip({ items, goals, tasks = [], placed = [], nameOf = assigneeName, onFly, onPlace, onDismiss, onPlacedOpen, onPlacedMove, onPlacedRemove, asks = 0, children }: {
  items: readonly WaitingItem[]
  goals: readonly CollabGoal[]
  tasks?: readonly TaskView[]
  placed?: readonly SessionPlaced[]
  nameOf?: (id: string | undefined) => string
  onFly: (id: string) => void
  onPlace: (item: Extract<WaitingItem, { kind: 'proposal' }>, choice: GoalChoice) => void
  onDismiss: (item: Extract<WaitingItem, { kind: 'proposal' }>) => void
  onPlacedOpen?: (placed: SessionPlaced) => void
  onPlacedMove?: (placed: SessionPlaced, choice: GoalChoice) => void
  onPlacedRemove?: (placed: SessionPlaced) => void
  /** 别人请你的 Agent 做事、等你批的条数(`/state` 里来);条目本身由 children 画。 */
  asks?: number
  children?: ReactNode
}) {
  const notes = items.filter(item => item.kind === 'note')
  return (
    <div className="ben-cl__waitbar" role="region" aria-label="现在等你">
      <b>等你 {notes.length + asks}</b>
      {items.length === 0 && placed.length === 0 && asks === 0 && <span className="ben-cl__muted">没有要你看的</span>}
      {children}
      {items.map(item => item.kind === 'note'
        ? (
            <button key={item.key} type="button" className="ben-cl__chip" onClick={() => onFly(item.task.id)}>
              {item.task.title}
            </button>
          )
        : <ProposalRow key={item.key} item={item} goals={goals} onPlace={onPlace} onDismiss={onDismiss} />)}
      {placed.map(one => (
        <PlacedRow
          key={`placed:${one.agent}:${one.session_id}`}
          placed={one}
          task={tasks.find(task => task.id === one.task_id)}
          goals={goals}
          nameOf={nameOf}
          onOpen={p => onPlacedOpen?.(p)}
          onMove={(p, choice) => onPlacedMove?.(p, choice)}
          onRemove={p => onPlacedRemove?.(p)}
        />
      ))}
    </div>
  )
}

export function FilterBar({ options, filter, onChange, sprints, projectName, cards }: {
  options: Record<FilterKey, string[]>
  filter: CollabFilter
  onChange: (next: CollabFilter) => void
  sprints: readonly CollabSprint[]
  projectName: (id: string) => string
  cards: readonly RailCard[]
}) {
  const types = useWorkTypes()
  const label = (key: FilterKey, value: string): string => {
    if (key === 'stamp') return STAMP_TITLES[value as TaskStatus]
    if (key === 'type') return types.find(one => one.id === value)?.title ?? value
    if (key === 'sprint') return sprints.find(one => one.id === value)?.title ?? value
    if (key === 'project') return projectName(value)
    if (key === 'assignee') return cards.find(one => one.id === value)?.name ?? assigneeName(value)
    return value
  }
  const active = FILTER_KEYS.some(key => (filter[key] ?? []).length > 0)
  return (
    <div className="ben-cl__filters" role="group" aria-label="筛选">
      {FILTER_KEYS.filter(key => options[key].length > 0).map((key) => {
        const picked = (filter[key] ?? []) as readonly string[]
        return (
          <details key={key} className="ben-cl__filter" data-on={picked.length > 0}>
            <summary>{FILTER_TITLES[key]}{picked.length > 0 ? ` · ${picked.length}` : ''}</summary>
            <div className="ben-cl__filter-pop">
              {options[key].map(value => (
                <label key={value}>
                  <input
                    type="checkbox"
                    checked={picked.includes(value)}
                    onChange={(event) => {
                      const next = event.target.checked ? [...picked, value] : picked.filter(one => one !== value)
                      onChange({ ...filter, [key]: next })
                    }}
                  />
                  {label(key, value)}
                </label>
              ))}
            </div>
          </details>
        )
      })}
      {active && <button type="button" className="ben-cl__filter-clear" onClick={() => onChange({})}>清掉筛选</button>}
    </div>
  )
}

export function CardRail({ cards, noteTitle, entries, tasks, selected, onSelect, onFly, onRegister, onEditAvatar, capacity, floating }: {
  cards: readonly RailCard[]
  noteTitle: (id: string) => string | undefined
  /** 登记表里接上的那几家(登记名片时「哪只手」从这里选)。 */
  entries: readonly AgentEntryView[]
  tasks: readonly TaskView[]
  /** 选中的那张名片(相关事项加轮廓、其余变淡)。 */
  selected?: string | undefined
  onSelect: (id: string) => void
  onFly: (id: string) => void
  onRegister: (input: { name: string, hand: string, good_at: string }) => Promise<string | undefined>
  /** 打开这张名片的「更换头像」。 */
  onEditAvatar?: (id: string) => void
  /** 容量四件事(手上/在跑/上限;缺席 = 接口不在,那一行不画不编)。 */
  capacity?: readonly CapacityItem[] | undefined
  /** 窄容器里从入口点开、浮在板上的那一份。 */
  floating?: boolean
}) {
  const [open, setOpen] = useState(false)
  const [name, setName] = useState('')
  const [hand, setHand] = useState('')
  const [goodAt, setGoodAt] = useState('')
  const [note, setNote] = useState<string | undefined>(undefined)
  const hands = entries.filter(entry => entry.self !== true && entry.id !== 'dsh' && entry.status !== 'unknown')
  const holding = (id: string): number => tasks.filter(task => boardAssignee(task.assignee) === id && task.status !== 'done' && task.status !== 'canceled').length
  return (
    <aside className="ben-cl__rail" data-floating={floating === true} aria-label="名片">
      <div className="ben-cl__rail-head"><h4>名片</h4></div>
      <ul className="ben-cl__cards">
        {cards.map(card => (
          <li key={card.id} className="ben-cl__card" data-online={card.online} data-kind={card.kind}>
            <button type="button" className="ben-cl__card-btn" aria-pressed={selected === card.id} aria-label={`看 ${card.name} 的事`} onClick={() => onSelect(card.id)}>
              <AvatarFace owner={card.id} name={card.name} kind={kindOfCard(card)} color={card.color} />
              <span className="ben-cl__card-text">
                <span className="ben-cl__card-name">{card.name}</span>
                {(() => {
                  const cap = capacity?.find(one => one.id === card.id)
                  if (cap !== undefined) {
                    return <span className="ben-cl__card-line">手上 {cap.active_jobs} 件 · 在跑 {cap.running_jobs} 件 · 上限{cap.limit === 'unknown' ? '未知' : ` ${cap.limit} 件`}</span>
                  }
                  return <span className="ben-cl__card-line">手上 {holding(card.id)} 件 · {card.online ? '在线' : '不在线'}</span>
                })()}
                {(card.runtimeFamily !== undefined || card.modelName !== undefined) && (
                  <span className="ben-cl__card-line">{[card.runtimeFamily, card.modelName].filter(one => one !== undefined).join(' · ')}</span>
                )}
                {card.goodAt !== undefined && <span className="ben-cl__card-line">擅长:{card.goodAt}</span>}
              </span>
            </button>
            {onEditAvatar !== undefined && <button type="button" className="ben-cl__card-edit" aria-label={`给 ${card.name} 换头像`} onClick={() => onEditAvatar(card.id)}>换头像</button>}
            {card.onNote !== undefined && (
              <button type="button" className="ben-cl__card-at" onClick={() => onFly(card.onNote as string)}>
                在「{noteTitle(card.onNote) ?? card.onNote}」上
              </button>
            )}
          </li>
        ))}
      </ul>
      {!open && <button type="button" className="ben-cl__rail-add" onClick={() => { setOpen(true); setNote(undefined) }}>登记一个 Agent</button>}
      {open && (
        <form
          className="ben-cl__rail-form"
          onSubmit={(event) => {
            event.preventDefault()
            void onRegister({ name, hand, good_at: goodAt }).then((failed) => {
              if (failed !== undefined) { setNote(failed); return }
              setOpen(false); setName(''); setHand(''); setGoodAt('')
            })
          }}
        >
          <label>名字<input value={name} onChange={event => setName(event.target.value)} placeholder="Ben 的代码 Agent" /></label>
          <label>
            哪只手
            <select value={hand} onChange={event => setHand(event.target.value)}>
              <option value="">选一家(体检过的才在这里)</option>
              {hands.map(entry => <option key={entry.id} value={entry.id}>{entry.name}</option>)}
            </select>
          </label>
          <label>擅长什么<input value={goodAt} onChange={event => setGoodAt(event.target.value)} placeholder="一两句" /></label>
          {note !== undefined && <p role="alert" className="ben-cl__rail-note">{note}</p>}
          <div className="ben-cl__rail-actions">
            <button type="submit" className="ben-cl__primary" disabled={name.trim() === '' || hand === ''}>登记</button>
            <button type="button" onClick={() => setOpen(false)}>算了</button>
          </div>
        </form>
      )}
    </aside>
  )
}
