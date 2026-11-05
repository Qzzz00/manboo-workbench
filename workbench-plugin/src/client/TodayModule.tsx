/**
 * 「今天的待办」那一格(2026-10-12;只在自媒体模板,决策记录同日「运营补丁留的两条」第 2 条)。
 *
 * 运营同学 10-08 在产物上加过一个待办小组件(数据存他浏览器 localStorage)。进本体时统筹定:
 * **它是看板事项的今天视图,不另存一份**。读的是服务端切好的 `/state.today_todos`(src/todayTodos.ts,
 * 手机事项页读同一份);写只走看板现有的三条路:
 *
 *   勾选     → `/task/move`,按七态表一格一格走到「完成」(`todo → done` 表上不通,得经「进行中」)
 *   取消勾选 → `/task/move` 回「进行中」(办完只能重开到进行中,同看板)
 *   延到明天 → `/task/update {due}`
 *   新加一件 → `/task/create {status:'todo', due: 今天}`
 *
 * 不先改界面再等服务端:改完以下一份快照为准(同 ButlerInbox.confirmTask),拒了就把服务端那句话摆出来。
 * 视觉:黑底白字灰线,不借主题点缀色(维护者 10-03:紫色点缀太丑;这一格干脆一格彩色都不用)。
 *
 * ## 两版(2026-10-13;维护者:「改成按列表展示或按卡片展示」)
 *
 *   **列表**(`flat`,缺省)= 今天那一条平铺清单,一行一件;
 *   **卡片**(`by_date`)= 每条一张小卡,按今天 / 明天 / 更晚分三组摆成三列(窄了掉成三段),
 *     卡上带到期、负责人、状态点(已完成打勾、阻塞照看板那道语义色)。
 *
 * 原来「按日期汇总」那一版并进卡片版,不再单独存在;协议那两个值(`by_date` / `flat`)一个字没改 ——
 * 手机那一格读同一份,这一轮不打手机包。卡面那三样从 `tasks` 里同 id 的看板卡上现取,没加协议字段。
 */
import { useEffect, useRef, useState } from 'react'
import { SetMsg, SetRow, SetSection, SetSeg } from './settings/setKit.tsx'
import type { FormEvent, ReactNode } from 'react'
import type { TaskStatus, TaskView, TodayTodoGroup, TodayTodoItem, TodayTodosView, TodayViewStyle } from '../protocol.ts'
import {
  TODAY_SWITCH_MS, TODAY_SWITCH_TEXT, TODAY_VIEWS, TODAY_VIEW_TITLES, WAIT_REASON_TITLES, assigneeName, statusPathTo,
} from '../protocol.ts'
import { ModuleBox } from './ModuleBox.tsx'
import { useMeName } from './meName.tsx'

/** 遮罩淡出用多久(毫秒)。 */
export const TODAY_VEIL_FADE_MS = 320

/** 卡片版每组的标题:「明天 · 2 件」。 */
export function todayGroupHeading(group: TodayTodoGroup): string {
  return `${group.label} · ${group.items.length} 件`
}

/** 卡片上那颗状态点的三态。阻塞那一态照看板的语义色(`--dsw-alias-state-warn-label`)。 */
export const TODAY_CARD_STATES: Readonly<Record<'done' | 'blocked' | 'open', string>> = {
  done: '已完成',
  blocked: '阻塞',
  open: '还没办',
}

/** 卡片版空着的那一组写的那一行。 */
export const TODAY_GROUP_EMPTY = '没有。'

/** 一张小卡的脸。 */
export interface TodayCardFace {
  /** 到期:今天 / 明天 / 10/18 / 逾期 · 10/10。 */
  due: string
  state: keyof typeof TODAY_CARD_STATES
  /** 负责人(看板上那一格的名字)。缺席 = 没派给谁。 */
  owner?: string
  /** 阻塞原因(看板上挂的那个)。 */
  blockWhy?: string
}

/**
 * 卡面上那三样(2026-10-13):到期、负责人、状态点。
 *
 * **都从看板那张卡上现取**(`tasks` 里同 id 的那一条),没往 `/state.today_todos` 里加字段 ——
 * 那份形状手机也在读,这一轮不打手机包。
 */
export function todayCardFace(
  item: TodayTodoItem,
  task: Pick<TaskView, 'status' | 'assignee' | 'block_reason'> | undefined,
  days: { date: string, tomorrow: string },
  meName?: string,
): TodayCardFace {
  const state: TodayCardFace['state'] = item.done ? 'done' : task?.status === 'blocked' ? 'blocked' : 'open'
  const due = item.overdue
    ? `逾期 · ${shortDay(item.due)}`
    : item.due === days.date
      ? '今天'
      : item.due === days.tomorrow ? '明天' : shortDay(item.due)
  const owner = task?.assignee === undefined ? undefined : task.assignee === 'me' && meName !== undefined ? meName : assigneeName(task.assignee)
  const why = state === 'blocked' && task?.block_reason !== undefined ? WAIT_REASON_TITLES[task.block_reason] : undefined
  return {
    due,
    state,
    ...(owner === undefined ? {} : { owner }),
    ...(why === undefined ? {} : { blockWhy: why }),
  }
}

/**
 * 换版本那一下(2026-10-12,周三演示):`/state.today_todos.style` 变了,先盖一层「正在优化…」,
 * 底下仍摆旧版;TODAY_SWITCH_MS 后换成新版、遮罩淡出。第一次挂上就是哪一版直接摆,不盖。
 */
function useVeiledStyle(incoming: TodayViewStyle): { shown: TodayViewStyle, veil: 'off' | 'on' | 'fading' } {
  const [shown, setShown] = useState(incoming)
  const [veil, setVeil] = useState<'off' | 'on' | 'fading'>('off')
  useEffect(() => {
    // 遮罩还盖着又切回原来那一版:不用换,揭掉。
    if (incoming === shown) { setVeil(now => (now === 'on' ? 'off' : now)); return }
    setVeil('on')
    const swap = setTimeout(() => {
      setShown(incoming)
      setVeil('fading')
    }, TODAY_SWITCH_MS)
    return () => clearTimeout(swap)
  }, [incoming, shown])
  useEffect(() => {
    if (veil !== 'fading') return
    const fade = setTimeout(() => setVeil('off'), TODAY_VEIL_FADE_MS)
    return () => clearTimeout(fade)
  }, [veil])
  return { shown, veil }
}

/** 运营同学那一版存待办的键(他 10-08 的 `DAILY_TODO_KEY`)。只读,不删不改。 */
export const LEGACY_TODO_KEY = 'dsh-workbench.daily-todo.v1'
/** 问过「导不导」之后记一笔,之后不再问(值是问完那一刻)。 */
export const LEGACY_TODO_ASKED_KEY = 'ben-wb.today.legacy-asked'

export const TODAY_NO_VIEW = '工作台服务还没给出今天的待办'
export function todayImportAsk(n: number): string {
  return `把之前记在浏览器里的 ${n} 件导成事项?`
}

interface StorageLike {
  getItem: (key: string) => string | null
  setItem: (key: string, value: string) => void
}

/**
 * 他那份里还没办完的(`{title, day, done}`,形状不对的跳过)。日子早于今天的按今天导 ——
 * 他当时是要今天前后做的事,导进来就挂成逾期不如直接摆在今天。
 */
export function legacyTodosOf(raw: string | null, today: string): { title: string, due: string }[] {
  if (raw === null) return []
  let parsed: unknown
  try { parsed = JSON.parse(raw) } catch { return [] }
  if (!Array.isArray(parsed)) return []
  const out: { title: string, due: string }[] = []
  for (const one of parsed as Record<string, unknown>[]) {
    if (one === null || typeof one !== 'object') continue
    if (typeof one.title !== 'string' || one.title.trim() === '' || typeof one.day !== 'string' || one.done === true) continue
    const day = /^\d{4}-\d{2}-\d{2}$/.test(one.day) ? one.day : today
    out.push({ title: one.title.trim(), due: day < today ? today : day })
  }
  return out
}

function shortDay(day: string): string {
  const m = /^\d{4}-(\d{2})-(\d{2})$/.exec(day)
  return m === null ? day : `${Number(m[1])}/${Number(m[2])}`
}

function monthDay(day: string): string {
  const m = /^\d{4}-(\d{2})-(\d{2})$/.exec(day)
  return m === null ? day : `${Number(m[1])}月${Number(m[2])}日`
}

function browserStorage(): StorageLike | undefined {
  try { return typeof localStorage === 'undefined' ? undefined : localStorage } catch { return undefined }
}

const TODAY_CSS = `
.ben-wb__today{display:flex;flex-direction:column;min-height:0;gap:8px;padding:4px 2px 8px;font-size:14px}
.ben-wb__today *{box-sizing:border-box}
.ben-wb__today-top{display:flex;align-items:baseline;justify-content:space-between;gap:10px}
.ben-wb__today-top strong{font-size:18px;font-weight:600}
.ben-wb__today-top span{font-size:12px;color:#ffffff99}
.ben-wb__today-add{display:flex;gap:6px}
.ben-wb__today-add input{flex:1;min-width:0;height:34px;padding:6px 10px;border:1px solid #ffffff2e;border-radius:8px;background:transparent;color:inherit;font:inherit}
.ben-wb__today-add input:focus{outline:0;border-color:#ffffff80}
.ben-wb__today button{border:1px solid #ffffff2e;border-radius:8px;background:transparent;color:inherit;font:inherit;font-size:13px;padding:5px 10px;cursor:pointer}
.ben-wb__today button:hover{border-color:#ffffff66}
.ben-wb__today button:disabled{opacity:.4;cursor:default}
.ben-wb__today-list{flex:1;min-height:0;overflow-y:auto;margin:0;padding:0;list-style:none;display:flex;flex-direction:column}
.ben-wb__today-item{display:grid;grid-template-columns:auto minmax(0,1fr) auto;align-items:center;gap:10px;padding:7px 2px;border-bottom:1px solid #ffffff1a}
.ben-wb__today-item[data-done=true]{opacity:.45}
.ben-wb__today-item[data-done=true] .ben-wb__today-title{text-decoration:line-through}
.ben-wb__today-item input{width:16px;height:16px;margin:0;accent-color:#e6e6e6;cursor:pointer}
.ben-wb__today-title{overflow-wrap:anywhere;line-height:1.4}
.ben-wb__today-late{display:block;font-size:12px;color:#ffffff8c}
.ben-wb__today-empty,.ben-wb__today-said{margin:0;font-size:12px;color:#ffffff99}
.ben-wb__today-ask{display:flex;flex-wrap:wrap;align-items:center;gap:6px;padding:7px 8px;border:1px dashed #ffffff33;border-radius:8px}
.ben-wb__today-ask p{flex:1 1 100%;margin:0}
.ben-wb__today-body{position:relative;flex:1;min-height:0;display:flex;flex-direction:column;container-type:inline-size}
/* 卡片版:这一格够宽就三组摆成三列,窄了掉成三段(上下排)。按那一格的宽度自己判,不看屏幕宽。 */
.ben-wb__today-cards{flex:1;min-height:0;overflow-y:auto;display:grid;grid-template-columns:minmax(0,1fr);align-content:start;gap:10px}
@container (min-width:520px){.ben-wb__today-cards{grid-template-columns:repeat(3,minmax(0,1fr))}}
.ben-wb__today-group{display:flex;flex-direction:column;gap:6px;min-width:0}
.ben-wb__today-group h4{margin:0;padding:2px 2px 4px;font-size:12px;font-weight:500;color:#ffffffb3;border-bottom:1px solid #ffffff2e}
.ben-wb__today-group .ben-wb__today-empty{padding:6px 2px}
.ben-wb__today-cardlist{margin:0;padding:0;list-style:none;display:flex;flex-direction:column;gap:6px}
/* 卡面借看板卡片那一套变量与圆角(border-l1 / border-l2 / bg-layer-1 / 8px),没造新色;取不到变量时退到灰阶。 */
.ben-wb__today-card{display:flex;flex-direction:column;gap:5px;padding:7px 9px 7px 10px;border:1px solid var(--dsw-alias-border-l1,#ffffff2e);border-left:3px solid var(--dsw-alias-border-l2,#ffffff40);border-radius:8px;background:var(--dsw-alias-bg-layer-1,#ffffff0a)}
.ben-wb__today-card[data-state=blocked]{border-color:var(--dsw-alias-state-warn-label,#d9d9d9)}
.ben-wb__today-card[data-done=true]{opacity:.45}
.ben-wb__today-card[data-done=true] .ben-wb__today-title{text-decoration:line-through}
.ben-wb__today-card input{width:16px;height:16px;margin:0;accent-color:#e6e6e6;cursor:pointer}
.ben-wb__today-card-top{display:grid;grid-template-columns:auto minmax(0,1fr) auto;align-items:start;gap:8px}
.ben-wb__today-card-foot{display:flex;flex-wrap:wrap;align-items:center;gap:6px;font-size:12px;color:#ffffff99}
.ben-wb__today-card-foot button{font-size:12px;padding:3px 8px}
.ben-wb__today-card-due{font-family:ui-monospace,Menlo,monospace;white-space:nowrap}
.ben-wb__today-card-who{padding:1px 6px;border-radius:999px;background:#ffffff14}
.ben-wb__today-card-block{padding:1px 6px;border-radius:999px;border:1px solid var(--dsw-alias-state-warn-label,#d9d9d9);color:var(--dsw-alias-state-warn-label,#d9d9d9)}
.ben-wb__today-dot{flex:none;width:14px;height:14px;border-radius:50%;border:1px solid #ffffff40;font-size:10px;line-height:12px;text-align:center;color:#e6e6e6}
.ben-wb__today-dot[data-state=done]{border-color:#ffffff80}
.ben-wb__today-dot[data-state=blocked]{border-color:var(--dsw-alias-state-warn-label,#d9d9d9);background:var(--dsw-alias-state-warn-label,#d9d9d9)}
.ben-wb__today-veil{position:absolute;inset:-4px;z-index:2;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:10px;border-radius:8px;background:#000000b8;color:#e6e6e6;font-size:13px;opacity:1;transition:opacity ${TODAY_VEIL_FADE_MS}ms ease}
.ben-wb__today-veil[data-fading=true]{opacity:0}
.ben-wb__today-spin{width:18px;height:18px;border:2px solid #ffffff33;border-top-color:#e6e6e6;border-radius:50%;animation:ben-wb-today-spin .8s linear infinite}
@keyframes ben-wb-today-spin{to{transform:rotate(360deg)}}
.ben-wb__today-pick{display:flex;flex-wrap:wrap;align-items:center;gap:8px}
.ben-wb__today-pick button{border:1px solid #ffffff2e;border-radius:8px;background:transparent;color:inherit;font:inherit;font-size:13px;padding:5px 12px;cursor:pointer}
.ben-wb__today-pick button[aria-pressed=true]{border-color:#ffffffb3}
.ben-wb__today-pick button:disabled{opacity:.4;cursor:default}
.ben-wb__today-pick p{flex:1 1 100%;margin:0;font-size:12px;color:#ffffff99}
`

/**
 * 设置里那两颗键(周三演示的救场:电话里没切成就在这儿点)。走同一条 `POST /today/view`。
 */
export function TodayViewPicker({ baseUrl, fetchImpl, current }: {
  baseUrl: string
  fetchImpl: typeof fetch
  current: TodayViewStyle
}) {
  const [busy, setBusy] = useState(false)
  const [said, setSaid] = useState<string | undefined>(undefined)
  const pick = async (view: TodayViewStyle): Promise<void> => {
    if (busy) return
    setBusy(true)
    try {
      const res = await fetchImpl(`${baseUrl}/today/view`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ view }) })
      const result = await res.json().catch(() => ({})) as { ok?: boolean, error?: string }
      setSaid(res.ok && result.ok === true ? undefined : (result.error ?? '这一下没成,再试一次'))
    } catch {
      setSaid('没送到,工作台服务没应答')
    } finally {
      setBusy(false)
    }
  }
  return (
    // 评审页 `section('today', '待办显示', …)`:一行「今天的待办 / 选择常用的显示方式。」+ 右边分段「卡片 | 列表」。
    <SetSection id="ben-wb-today-view" title="待办显示">
      <SetRow title="今天的待办" sub="选择常用的显示方式。">
        <SetSeg
          label="今天的待办怎么显示"
          options={TODAY_VIEWS.map(view => ({ value: view, label: TODAY_VIEW_TITLES[view] }))}
          value={current}
          disabled={busy}
          onPick={(view) => { void pick(view) }}
        />
      </SetRow>
      {said !== undefined && <SetMsg>{said}</SetMsg>}
    </SetSection>
  )
}

export function TodayModule({ box, header, headingId, baseUrl, fetchImpl, view, tasks, storage = browserStorage() }: {
  box: Omit<Parameters<typeof ModuleBox>[0], 'children'>
  header: ReactNode
  headingId: string
  baseUrl: string
  fetchImpl: typeof fetch
  view?: TodayTodosView
  /** 看板事项(取每件此刻的状态,好照七态表算走到「完成」那几格)。 */
  tasks: readonly TaskView[]
  storage?: StorageLike | undefined
}) {
  const meName = useMeName()
  const [draft, setDraft] = useState('')
  const [busy, setBusy] = useState(false)
  const [said, setSaid] = useState<string | undefined>(undefined)
  const lock = useRef(false)
  const today = view?.date
  // 浏览器里那份旧待办:只在第一次挂上、而且还没问过时算一次。
  const [legacy, setLegacy] = useState<{ title: string, due: string }[]>([])
  useEffect(() => {
    if (today === undefined || storage === undefined) return
    try {
      if (storage.getItem(LEGACY_TODO_ASKED_KEY) !== null) return
      setLegacy(legacyTodosOf(storage.getItem(LEGACY_TODO_KEY), today))
    } catch { /* 读不了浏览器存储 = 没有旧的可导 */ }
  }, [today, storage])

  async function post(path: string, body: Record<string, unknown>): Promise<string | undefined> {
    try {
      const res = await fetchImpl(`${baseUrl}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
      const result = await res.json().catch(() => ({})) as { ok?: boolean, error?: string }
      return res.ok && result.ok === true ? undefined : (result.error ?? '这一下没成,再试一次')
    } catch { return '没送到,工作台服务没应答' }
  }

  /** 一次只办一件:前一下还在路上时别的按钮不响(同发布计划那一格的 lock)。 */
  async function run(work: () => Promise<string | undefined>, ok?: string): Promise<void> {
    if (lock.current) return
    lock.current = true
    setBusy(true)
    try {
      const failed = await work()
      setSaid(failed ?? ok)
    } finally {
      lock.current = false
      setBusy(false)
    }
  }

  async function walk(id: string, to: TaskStatus): Promise<string | undefined> {
    const from = tasks.find(one => one.id === id)?.status
    const route = from === undefined ? [to] : statusPathTo(from, to)
    if (route === undefined) return '这件事从现在的状态走不到那一步'
    for (const status of route) {
      const failed = await post('/task/move', { id, status })
      if (failed !== undefined) return failed
    }
    return undefined
  }

  const toggle = (item: TodayTodoItem): void => {
    void run(() => walk(item.id, item.done ? 'doing' : 'done'))
  }
  const later = (item: TodayTodoItem): void => {
    if (view === undefined) return
    void run(() => post('/task/update', { id: item.id, due: view.tomorrow }), `「${item.title}」挪到明天了`)
  }
  const add = (event: FormEvent): void => {
    event.preventDefault()
    const title = draft.trim()
    if (title === '' || today === undefined) return
    void run(async () => {
      const failed = await post('/task/create', { title, status: 'todo', due: today })
      if (failed === undefined) setDraft('')
      return failed
    })
  }
  const markAsked = (): void => {
    try { storage?.setItem(LEGACY_TODO_ASKED_KEY, new Date().toISOString()) } catch { /* 记不下就下次再问 */ }
    setLegacy([])
  }
  const importLegacy = (): void => {
    const list = legacy
    void run(async () => {
      for (const one of list) {
        const failed = await post('/task/create', { title: one.title, status: 'todo', due: one.due })
        if (failed !== undefined) return failed
      }
      markAsked()
      return undefined
    }, `导好了 ${list.length} 件`)
  }

  const items = view?.items ?? []
  const open = items.filter(one => !one.done).length
  const { shown, veil } = useVeiledStyle(view?.style ?? 'flat')
  const groups = shown === 'by_date' ? view?.groups : undefined

  const days = { date: view?.date ?? '', tomorrow: view?.tomorrow ?? '' }

  /**
   * 卡片版的一张小卡(2026-10-13):标题 + 状态点,底下一行到期 / 负责人 / 阻塞。
   * 勾选、延到明天还是列表版那两条路(同一个 `toggle` / `later`),这里只是摆法不一样。
   */
  const card = (item: TodayTodoItem): ReactNode => {
    const face = todayCardFace(item, tasks.find(one => one.id === item.id), days, meName)
    return (
      <li key={item.id} className="ben-wb__today-card" data-done={item.done} data-state={face.state}>
        <div className="ben-wb__today-card-top">
          <input
            type="checkbox"
            checked={item.done}
            disabled={busy}
            aria-label={`${item.done ? '重开' : '完成'}:${item.title}`}
            onChange={() => toggle(item)}
          />
          <span className="ben-wb__today-title">{item.title}</span>
          <span className="ben-wb__today-dot" data-state={face.state} title={TODAY_CARD_STATES[face.state]} aria-label={TODAY_CARD_STATES[face.state]}>
            {face.state === 'done' ? '✓' : ''}
          </span>
        </div>
        <div className="ben-wb__today-card-foot">
          <span className="ben-wb__today-card-due">{face.due}</span>
          {face.owner !== undefined && <span className="ben-wb__today-card-who">{face.owner}</span>}
          {face.state === 'blocked' && (
            <span className="ben-wb__today-card-block">
              {face.blockWhy === undefined ? TODAY_CARD_STATES.blocked : `${TODAY_CARD_STATES.blocked} · ${face.blockWhy}`}
            </span>
          )}
          {!item.done && (
            // 卡面上「到期」就写着「明天」,这颗键再写「明天」两件事分不开 —— 卡片版上写全。
            <button type="button" disabled={busy} aria-label={`${item.title} 延到明天`} title="延到明天" onClick={() => later(item)}>
              挪到明天
            </button>
          )}
        </div>
      </li>
    )
  }

  const row = (item: TodayTodoItem): ReactNode => (
    <li key={item.id} className="ben-wb__today-item" data-done={item.done}>
      <input
        type="checkbox"
        checked={item.done}
        disabled={busy}
        aria-label={`${item.done ? '重开' : '完成'}:${item.title}`}
        onChange={() => toggle(item)}
      />
      <span>
        <span className="ben-wb__today-title">{item.title}</span>
        {item.overdue && <small className="ben-wb__today-late">{`逾期 · ${shortDay(item.due)}`}</small>}
      </span>
      {!item.done && (
        <button type="button" disabled={busy} aria-label={`${item.title} 延到明天`} title="延到明天" onClick={() => later(item)}>
          明天
        </button>
      )}
    </li>
  )
  return (
    <ModuleBox {...box}>
      <section className="ben-wb__card ben-wb__card--fill" aria-labelledby={headingId}>
        {header}
        <style>{TODAY_CSS}</style>
        <div className="ben-wb__today">
          {view === undefined
            ? <p className="ben-wb__today-empty">{TODAY_NO_VIEW}</p>
            : (
                <>
                  <div className="ben-wb__today-top">
                    <strong>{monthDay(view.date)}</strong>
                    <span>{open > 0 ? `还有 ${open} 件` : items.length > 0 ? '今天的都办完了' : '今天'}</span>
                  </div>
                  {legacy.length > 0 && (
                    <div className="ben-wb__today-ask" role="group" aria-label="浏览器里的旧待办">
                      <p>{todayImportAsk(legacy.length)}</p>
                      <button type="button" disabled={busy} onClick={importLegacy}>导成事项</button>
                      <button type="button" disabled={busy} onClick={markAsked}>不用了</button>
                    </div>
                  )}
                  <form className="ben-wb__today-add" onSubmit={add}>
                    <input
                      value={draft}
                      maxLength={120}
                      placeholder="记下今天要做的事…"
                      aria-label="新加一件今天的待办"
                      onChange={event => setDraft(event.target.value)}
                    />
                    <button type="submit" disabled={busy || draft.trim() === ''}>添加</button>
                  </form>
                  {said !== undefined && <p className="ben-wb__today-said" role="status">{said}</p>}
                  <div className="ben-wb__today-body">
                    {groups !== undefined
                      ? (
                          <div className="ben-wb__today-cards">
                            {groups.map(group => (
                              <section key={group.key} className="ben-wb__today-group" aria-label={group.label}>
                                <h4>{todayGroupHeading(group)}</h4>
                                {group.items.length === 0
                                  ? <p className="ben-wb__today-empty">{TODAY_GROUP_EMPTY}</p>
                                  : <ul className="ben-wb__today-cardlist">{group.items.map(card)}</ul>}
                              </section>
                            ))}
                          </div>
                        )
                      : items.length === 0
                        ? <p className="ben-wb__today-empty">今天还没有要做的事。</p>
                        : <ul className="ben-wb__today-list" aria-label="今天的待办">{items.map(row)}</ul>}
                    {veil !== 'off' && (
                      <div className="ben-wb__today-veil" data-fading={veil === 'fading'} role="status" aria-live="polite">
                        <span className="ben-wb__today-spin" aria-hidden="true" />
                        <span>{TODAY_SWITCH_TEXT}</span>
                      </div>
                    )}
                  </div>
                </>
              )}
        </div>
      </section>
    </ModuleBox>
  )
}
