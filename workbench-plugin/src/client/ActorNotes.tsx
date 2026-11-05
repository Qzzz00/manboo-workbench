/**
 * 事务官(或别的程序)动了哪一块:在那一块旁边出一行字(2026-09-25 卡 P 补三)。
 *
 * 维护者 0.3.1 截图:「看到红框里的东西了吗,好像是个新bug」—— 「事务官正在挪任务卡的状态」连同一圈光框
 * 挂在工作台左上角,任务卡却在右边的看板里。那是服务端按布局参数重算「看板在哪」再让壳去画,算漂了。
 * 统筹定:程序做的动作一律**只出一行字**,**页面自己画,挂在真实的元素上**:
 * - 看板动作(建事项、改卡、挪状态)挂**那张卡**;没有那张卡(建事项)或那张卡不在页面上,挂任务所在的那一块;
 * - 文件动作挂**文件区**;窗口槽动作挂**窗口槽**(挂在那一块的右上角 —— 窗口槽里贴着的原生窗盖不到那一截);
 * - 那一块看不见(纯净模式、模块收起)**就不画**;
 * - 没有光、没有圈:流线光只属于他亲手把新应用拖进窗口槽、松手那一下。
 *
 * 位置每一帧从那个元素**当场量**(字挂着的那两秒):元素挪了(滚动、布局变了)字跟着走;不挂字的时候一次都不量。
 * 不改那个元素自己的样式 —— 字画在最上面一层里,不往卡片 / 模块里塞东西,不会把它们原来的排布挤动。
 */
import { useEffect, useState } from 'react'
import type { ActorNote } from '../protocol.ts'

/** 页面上挂着的一行字:挂在哪(key = 哪一块 + 哪张卡)、说什么、留到什么时候(Date.now() 毫秒)。 */
export interface ShownActorNote {
  key: string
  note: ActorNote
  until: number
}

/** `/live` 送来的那一格像不像一条 ActorNote(不像就当没收到)。 */
export function isActorNote(value: unknown): value is ActorNote {
  if (typeof value !== 'object' || value === null) return false
  const raw = value as Record<string, unknown>
  return typeof raw.action === 'string'
    && (raw.region === 'slot' || raw.region === 'files' || raw.region === 'board')
    && typeof raw.text === 'string' && raw.text.trim() !== ''
    && typeof raw.ttl_ms === 'number' && Number.isFinite(raw.ttl_ms) && raw.ttl_ms > 0
    && (raw.task_id === undefined || typeof raw.task_id === 'string')
}

function keyOf(note: ActorNote): string {
  return note.task_id === undefined ? note.region : `${note.region}:${note.task_id}`
}

/** 收到一条就挂上;同一块(同一张卡)再来一条就续上、换成新的那句,不叠两行。 */
export function addActorNote(list: readonly ShownActorNote[], note: ActorNote, now: number): ShownActorNote[] {
  const key = keyOf(note)
  return [...list.filter(one => one.key !== key && one.until > now), { key, note, until: now + note.ttl_ms }]
}

/** 到点的收掉。 */
export function liveActorNotes(list: readonly ShownActorNote[], now: number): ShownActorNote[] {
  return list.filter(one => one.until > now)
}

/** 看板动作没有那张卡时挂哪:任务所在的那几块(项目区的看板优先,运营模板的待办区其次)。 */
const BOARD_MODULES = ['projects', 'todo'] as const

export interface ActorNoteView {
  /** 纯净模式:所有模块都不显示 —— 一行都不画。 */
  pureMode: boolean
  /** 此刻看得见的模块(这一档、没收起的)。 */
  visibleModuleIds: ReadonlySet<string>
  root: ParentNode
}

/**
 * 这一行字挂在哪个元素上;看不见就回 undefined(不画)。只认页面上真实存在的元素:
 * 模块用 `data-module-box`(ModuleBox),任务卡用 `data-task-id`(TaskCard)。
 */
export function actorNoteAnchor(note: ActorNote, view: ActorNoteView): Element | undefined {
  if (view.pureMode) return undefined
  const moduleBox = (id: string): Element | undefined => {
    if (!view.visibleModuleIds.has(id)) return undefined
    return [...view.root.querySelectorAll('[data-module-box]')].find(el => el.getAttribute('data-module-box') === id)
  }
  if (note.region !== 'board') return moduleBox(note.region)
  if (note.task_id !== undefined) {
    const card = [...view.root.querySelectorAll('[data-task-id]')].find(el => el.getAttribute('data-task-id') === note.task_id)
    const host = card?.closest('[data-module-box]')?.getAttribute('data-module-box')
    if (card !== undefined && host != null && view.visibleModuleIds.has(host)) return card
  }
  for (const id of BOARD_MODULES) {
    const box = moduleBox(id)
    if (box !== undefined) return box
  }
  return undefined
}

/** 字摆在哪:任务卡的正上方(不挡卡上的字);模块的右上角里面(标题那一行)。 */
function placement(anchor: Element): { left: number, top: number, onCard: boolean } {
  const rect = anchor.getBoundingClientRect()
  const onCard = anchor.hasAttribute('data-task-id')
  return onCard
    ? { left: rect.left, top: Math.max(4, rect.top - 24), onCard }
    : { left: rect.right - 12, top: rect.top + 8, onCard }
}

const nextFrame = (fn: () => void): (() => void) => {
  if (typeof requestAnimationFrame === 'function') {
    const id = requestAnimationFrame(fn)
    return () => cancelAnimationFrame(id)
  }
  const id = setTimeout(fn, 16)
  return () => clearTimeout(id)
}

export function ActorNotes({ notes, pureMode, visibleModuleIds }: {
  notes: readonly ShownActorNote[]
  pureMode: boolean
  visibleModuleIds: ReadonlySet<string>
}) {
  // 字挂着的时候每一帧重画一次(位置当场量);一行字都没有就不量。
  const [, setFrame] = useState(0)
  const active = notes.length > 0
  useEffect(() => {
    if (!active) return undefined
    let cancel = (): void => {}
    const tick = (): void => {
      setFrame(frame => frame + 1)
      cancel = nextFrame(tick)
    }
    cancel = nextFrame(tick)
    return () => cancel()
  }, [active])

  if (!active || typeof document === 'undefined') return null
  const view: ActorNoteView = { pureMode, visibleModuleIds, root: document }
  const shown = notes.flatMap(({ key, note }) => {
    const anchor = actorNoteAnchor(note, view)
    return anchor === undefined ? [] : [{ key, note, anchor }]
  })
  if (shown.length === 0) return null
  return (
    <div className="ben-wb__actor-notes">
      {shown.map(({ key, note, anchor }) => {
        const { left, top, onCard } = placement(anchor)
        return (
          <p
            key={key}
            className="ben-wb__actor-note"
            role="status"
            data-region={note.region}
            data-anchor={onCard ? `task:${note.task_id ?? ''}` : `module:${anchor.getAttribute('data-module-box') ?? ''}`}
            data-on-card={onCard}
            style={{ left, top }}
          >
            {note.text}
          </p>
        )
      })}
    </div>
  )
}
