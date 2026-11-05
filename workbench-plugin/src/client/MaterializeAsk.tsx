/**
 * 「我照你说的摆好了」(2026-09-24 晚,卡 feat/onboarding-materialize;设计 docs/设计-引导落地-引导结束后的样子-2026-09-24.md 第二节)。
 *
 * 2026-09-25 真壳验收(卡 fix/materialize-card-fit):窗口槽只有 500 来 px 高时,单子最下面的「就这样 / 改一下」落在输入框后面,看不见也点不到。
 * 现在:① 卡是「卡头 / 行区 / 底栏」三截,**只有行区滚**,底栏(就这样、改一下、看全部)钉在卡里;整张卡的高度跟着球下那一区还剩多少走
 * (量出来的,不是写死的 vh),所以底栏任何高度下都在那一区里、在输入框上面;② 统筹拍板(粒子球是主角,球不让):
 * 球下那一区摆不下整张时收成**一行**(`variant="row"`:标题 + 几个项目几件事 + 就这样 / 改一下 / 看全部,ButlerInbox 按 asksFit 定),
 * 「看全部」「改一下」把整张单子摊在事务官这一档上面(`variant="sheet"`,ButlerInbox 摆),「收起」回到那一行。
 *
 * 引导(电话或打字)聊完,事务官把他说的摆成一张单子:项目、冲刺与卡、每天几点、桌面、记忆、撤掉的旧事项、第一件派给谁。
 * **他点「就这样」才落**;逐条能勾掉;「改一下」能改卡片的标题与负责人。落完只留一句回执(「派出去了,做完叫你。」)。
 *
 * 摆在球下面「要你处理的」那一区、ButlerInbox 里 `asks` 那张表的**第一个**(卡 A 管那一区的排布与那一道光:
 * 表里最前面那张走光,这里不再自己画一圈)。
 * 真相在服务端:按完不本地乐观改,等下一拍 /state(同 DevToolAsk / LayoutAsk / EvolveAsk)。
 */
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { MaterializeOwner, MaterializeStateView } from '../protocol.ts'
import { MATERIALIZE_OWNER_LABELS } from '../protocol.ts'
import { useMeName } from './meName.tsx'
import {
  OWNER_CHOICES, applyPayload, groupedRows, headLine, liveCount, quietEndChoices, rowCheckable, rowChecked, rowTitle, shouldShow, spokenClock, type RowChoice,
} from './materializeAskModel.ts'

const DISMISS_KEY = 'ben-wb:materialize:dismissed'

/** 点过「收起」的那一张单子(本机记着)。壳里、无痕窗口里 localStorage 可能直接抛:当没收起过。 */
export function readMaterializeDismissed(): string | undefined {
  try { return globalThis.localStorage?.getItem(DISMISS_KEY) ?? undefined }
  catch { return undefined }
}

export function writeMaterializeDismissed(id: string): void {
  try { globalThis.localStorage?.setItem(DISMISS_KEY, id) }
  catch { /* 存不下就只收这一次 */ }
}

/** 卡在那一区里能用的高度低于这个数,就收成一行(卡头 + 底栏),整张单子靠「看全部」摊开。 */
export const LAID_COMPACT_BELOW = 200

/**
 * 这张卡在球下那一区里最多能占多高:从卡的顶到事务官那一档的舞台底(输入框上面)。**量的是不随卡变的东西**
 * (舞台底、那一区的顶 + 卡在那一区内容里的位置),卡自己变高变矮不会反过来改这个数。量不出来(没有布局的环境)回 undefined。
 */
function measureFit(card: HTMLElement): number | undefined {
  const scene = card.closest('.ben-wb__particle-scene')
  const region = card.closest('.ben-wb__scene-below')
  if (!(scene instanceof HTMLElement) || !(region instanceof HTMLElement)) return undefined
  const sceneRect = scene.getBoundingClientRect()
  const regionRect = region.getBoundingClientRect()
  if (sceneRect.height <= 0 || regionRect.width <= 0) return undefined
  const offsetInRegion = card.getBoundingClientRect().top - regionRect.top + region.scrollTop
  const px = (value: string): number => Number.parseFloat(value) || 0
  const padBottom = px(getComputedStyle(region).paddingBottom)
  // 卡 A 那一区给每张卡套的框(.ben-wb__ask)底下还有内边距与边线:也要摆得下,不然框的底边被那一区切掉。
  const frame = card.closest('.ben-wb__ask')
  const frameBottom = frame instanceof HTMLElement ? px(getComputedStyle(frame).paddingBottom) + px(getComputedStyle(frame).borderBottomWidth) : 0
  return Math.floor(sceneRect.bottom - padBottom - regionRect.top - offsetInRegion - frameBottom)
}

export function MaterializeAsk({
  view, baseUrl, fetchImpl, now = () => Date.now(), dismissed: dismissedProp, onDismiss, variant = 'inline', onOpenSheet, onCloseSheet, startEditing = false,
}: {
  view: MaterializeStateView | undefined
  baseUrl: string
  fetchImpl: typeof fetch
  now?: () => number
  /** 「收起」由上一层管时传这两个(ButlerInbox:收起了就不进 asks 表);不传就自己记。 */
  dismissed?: string | undefined
  onDismiss?: (id: string) => void
  /**
   * inline:球下那一区里那张(整张,行区滚、底栏钉住;那一区摆不下时自己收成一行);
   * row:球下那一区摆不下整张时收成的那一行(「标题 + 就这样 / 改一下 / 看全部」,ButlerInbox 按 asksFit 定);
   * sheet:摊在事务官这一档上面的整张(「看全部」「改一下」打开)。
   */
  variant?: 'inline' | 'row' | 'sheet'
  /** inline 那张:把整张单子摊开(edit = 一打开就是「改一下」)。不传就没有「看全部」。 */
  onOpenSheet?: (edit: boolean) => void
  /** sheet 那张:收起回球下那一张。 */
  onCloseSheet?: () => void
  startEditing?: boolean
}) {
  // 负责人「me」写账号名(2026-10-22 第三轮 8);服务端那一行原文仍是「负责:你」(落卡时靠它回读),只在这里换着显示。
  const meName = useMeName()
  const ownerLabel = (owner: MaterializeOwner): string => (owner === 'me' ? meName : MATERIALIZE_OWNER_LABELS[owner])
  const [choices, setChoices] = useState<Record<string, RowChoice>>({})
  const [editing, setEditing] = useState(startEditing)
  const cardRef = useRef<HTMLElement | null>(null)
  const [fit, setFit] = useState<number | undefined>(undefined)
  const sheet = variant === 'sheet'
  // 量这张卡还能占多高(只量 inline 那张;sheet 那张占满整档)。那一区、舞台、窗口一变就重量。
  useLayoutEffect(() => {
    const card = cardRef.current
    if (variant !== 'inline' || card === null) return undefined
    const measure = (): void => {
      const next = measureFit(card)
      setFit(prev => (prev === next ? prev : next))
    }
    measure()
    if (typeof ResizeObserver === 'undefined') return undefined
    const observer = new ResizeObserver(measure)
    const scene = card.closest('.ben-wb__particle-scene')
    if (scene !== null) observer.observe(scene)
    const region = card.closest('.ben-wb__scene-below')
    if (region !== null) observer.observe(region)
    window.addEventListener('resize', measure)
    return () => { observer.disconnect(); window.removeEventListener('resize', measure) }
  }, [variant, view?.id, view?.status])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | undefined>(undefined)
  const [dismissedOwn, setDismissedOwn] = useState<string | undefined>(readMaterializeDismissed)
  const dismissed = onDismiss === undefined ? dismissedOwn : dismissedProp
  // 换了一张单子(重跑、他在电话里又说了一遍),他在旧单子上勾的不带过去。
  const planId = view?.id
  useEffect(() => { setChoices({}); setEditing(startEditing); setError(undefined) }, [planId, startEditing])

  if (view === undefined || !shouldShow(view, now(), dismissed)) return null

  const choose = (key: string, patch: RowChoice): void => setChoices(prev => ({ ...prev, [key]: { ...prev[key], ...patch } }))

  const apply = async (): Promise<void> => {
    if (busy) return
    setBusy(true)
    setError(undefined)
    try {
      const res = await fetchImpl(`${baseUrl}/onboarding/materialize/apply`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(applyPayload(view, choices)),
      })
      const payload = await res.json() as { ok?: boolean, error?: string, line?: string }
      if (res.status !== 200) setError(payload.error ?? '没落成')
      else setEditing(false)
    }
    catch { setError('工作台服务没应答,什么都没落') }
    finally { setBusy(false) }
  }

  const dismiss = (): void => {
    if (onDismiss !== undefined) { onDismiss(view.id); return }
    setDismissedOwn(view.id)
    writeMaterializeDismissed(view.id)
  }

  const rowVariant = variant === 'row'
  if (view.status === 'applied' && view.result !== undefined) {
    const failed = view.result.rows.filter(row => !row.ok)
    if (rowVariant) {
      return (
        <section ref={cardRef} className="ben-wb__laid ben-wb__laid--row ben-wb__laid--done" aria-label="我照你说的摆好了">
          <span className="ben-wb__laid-rowtitle">我照你说的摆好了</span>
          <span className="ben-wb__laid-rowsub" role="status">{view.result.line}</span>
          <span className="ben-wb__laid-rowacts">
            <button type="button" className="ben-wb__laid-ghost" onClick={dismiss}>收起</button>
          </span>
        </section>
      )
    }
    return (
      <section ref={cardRef} className={`ben-wb__laid ben-wb__laid--done${sheet ? ' ben-wb__laid--sheet' : ''}`} aria-label="我照你说的摆好了">
        <div className="ben-wb__laid-donehead">
          <p className="ben-wb__laid-head">我照你说的摆好了</p>
          <p className="ben-wb__laid-line" role="status">{view.result.line}</p>
          <button type="button" className="ben-wb__laid-ghost" onClick={() => { dismiss(); onCloseSheet?.() }}>收起</button>
        </div>
        {failed.length > 0 && (
          <ul className="ben-wb__laid-failed" aria-label="没落上的">
            {failed.map(row => <li key={row.key}>{row.title}{row.note === undefined ? '' : `:${row.note}`}</li>)}
          </ul>
        )}
      </section>
    )
  }

  const count = liveCount(view, choices)
  // 收成一行:ButlerInbox 说那一区只摆得下一行(row),或者整张摆着、卡自己量出来连两三行都摆不下(inline 且 fit 太小)。
  // 一行 = 「标题 + 几个项目几件事 + 就这样 / 改一下 / 看全部」;「改一下」「看全部」把整张单子摊开。
  const compact = rowVariant || (variant === 'inline' && onOpenSheet !== undefined && fit !== undefined && fit < LAID_COMPACT_BELOW)
  const openSheet = (edit: boolean): void => { onOpenSheet?.(edit) }
  if (compact) {
    return (
      <section ref={cardRef} className="ben-wb__laid ben-wb__laid--row" aria-label="我照你说的摆好了">
        <span className="ben-wb__laid-rowtitle">我照你说的摆好了</span>
        <span className="ben-wb__laid-rowsub">{headLine(view)}</span>
        <span className="ben-wb__laid-rowacts">
          <button type="button" className="ben-wb__laid-go" disabled={busy || view.status !== 'pending' || count === 0} onClick={() => { void apply() }}>
            {busy || view.status === 'applying' ? '正在落…' : '就这样'}
          </button>
          <button type="button" className="ben-wb__laid-ghost" disabled={busy || onOpenSheet === undefined} onClick={() => openSheet(true)}>改一下</button>
          {onOpenSheet !== undefined && <button type="button" className="ben-wb__laid-link" disabled={busy} onClick={() => openSheet(false)}>看全部</button>}
        </span>
        {error !== undefined && <span className="ben-wb__laid-err" role="alert">{error}</span>}
      </section>
    )
  }
  return (
      <section
        ref={cardRef}
        className={`ben-wb__laid${sheet ? ' ben-wb__laid--sheet' : ''}`}
        aria-label="我照你说的摆好了"
        data-editing={editing}
        style={!sheet && fit !== undefined ? { maxHeight: Math.max(fit, 56) } : undefined}
      >
        <header className="ben-wb__laid-top">
          <p className="ben-wb__laid-head">我照你说的摆好了</p>
          <p className="ben-wb__laid-sub">{headLine(view)}</p>
          {sheet && onCloseSheet !== undefined && (
            <button type="button" className="ben-wb__laid-ghost ben-wb__laid-close" disabled={busy} onClick={onCloseSheet}>收起</button>
          )}
        </header>
        {/* 行区:单子长,只有这一截滚;卡头与底栏不动。 */}
        <div className="ben-wb__laid-scroll">
        {groupedRows(view).map(group => (
          <div key={group.id} className="ben-wb__laid-group" data-group={group.id}>
            <p className="ben-wb__laid-gtitle">{group.title}</p>
            <ul className="ben-wb__laid-rows">
              {group.rows.map((row) => {
                const checkable = rowCheckable(row)
                const checked = rowChecked(row, choices)
                const choice = choices[row.key]
                return (
                  <li key={row.key} className="ben-wb__laid-item" data-done={row.done === true} data-off={checkable && !checked} data-kind={row.kind}>
                    <label className="ben-wb__laid-check">
                      <input
                        type="checkbox"
                        checked={checked}
                        disabled={!checkable || busy}
                        aria-label={row.title}
                        onChange={event => choose(row.key, { checked: event.target.checked })}
                      />
                      {editing && row.editable === true
                        ? (
                          <input
                            className="ben-wb__laid-title-input"
                            type="text"
                            value={choice?.title ?? row.title}
                            maxLength={40}
                            aria-label={`改标题:${row.title}`}
                            disabled={busy}
                            onChange={event => choose(row.key, { title: event.target.value })}
                          />
                        )
                        : <span className="ben-wb__laid-title">{rowTitle(row, choices)}</span>}
                    </label>
                    {editing && row.time !== undefined && (
                      <select
                        className="ben-wb__laid-owner"
                        value={choice?.to ?? row.time.to}
                        aria-label={`改到几点:${row.title}`}
                        disabled={busy}
                        onChange={event => choose(row.key, { to: event.target.value })}
                      >
                        {quietEndChoices(row.time.to).map(time => <option key={time} value={time}>{`到${spokenClock(time)}`}</option>)}
                      </select>
                    )}
                    {editing && row.editable === true && (
                      <select
                        className="ben-wb__laid-owner"
                        value={choice?.owner ?? row.owner ?? 'me'}
                        aria-label={`改负责人:${row.title}`}
                        disabled={busy}
                        onChange={event => choose(row.key, { owner: event.target.value as MaterializeOwner })}
                      >
                        {OWNER_CHOICES.map(one => <option key={one.id} value={one.id}>{ownerLabel(one.id)}</option>)}
                      </select>
                    )}
                    {row.detail !== undefined && row.detail !== '' && (
                      <span className="ben-wb__laid-detail">
                        {editing && row.editable === true && choice?.owner !== undefined && choice.owner !== row.owner
                          ? row.detail.replace(/^负责:[^ ·]+/, `负责:${ownerLabel(choice.owner)}`)
                          : row.detail.replace(/^负责:你(?=$|[ ·(（])/, `负责:${meName}`)}
                      </span>
                    )}
                    {row.done === true && <span className="ben-wb__laid-note">已经有了</span>}
                    {row.placeholder !== undefined && <span className="ben-wb__laid-note">{row.placeholder}</span>}
                  </li>
                )
              })}
            </ul>
          </div>
        ))}
        </div>
        {/* 底栏:钉在卡里,任何高度下都看得见(列表滚、这一栏不滚)。 */}
        <footer className="ben-wb__laid-foot">
          <div className="ben-wb__laid-row">
            <button type="button" className="ben-wb__laid-go" disabled={busy || view.status !== 'pending' || count === 0} onClick={() => { void apply() }}>
              {busy || view.status === 'applying' ? '正在落…' : '就这样'}
            </button>
            <button type="button" className="ben-wb__laid-ghost" disabled={busy} aria-pressed={editing} onClick={() => setEditing(on => !on)}>
              {editing ? '改好了' : '改一下'}
            </button>
            {!sheet && onOpenSheet !== undefined && (
              <button type="button" className="ben-wb__laid-link" disabled={busy} onClick={() => openSheet(false)}>看全部</button>
            )}
          </div>
          <p className="ben-wb__laid-hint">勾掉的不做;「改一下」能改卡的标题和负责人、免打扰到几点。点「就这样」才落,撤掉的只改成「取消」,不删。</p>
          {error !== undefined && <p className="ben-wb__laid-err" role="alert">{error}</p>}
        </footer>
      </section>
  )
}
