import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { FormEvent, PointerEvent as ReactPointerEvent } from 'react'
import { BUTLER_BALL_DIAMETER_PX, MIN_BUTLER_H_PX, MIN_BUTLER_W_PX } from '../protocol.ts'
import type { BriefView, SentinelView } from '../protocol.ts'
import { clampButlerPos, clampButlerSize, rectsIntersect, type RectLike } from './butlerGeometry.ts'
import { useVeilSlot, type VeilTarget } from './useVeilSlot.ts'
import { localDateStr } from './dates.ts'
import { admissibleProposals, EVIDENCE_DAYS_REQUIRED } from './proposals.ts'
import { SENSOR_LABEL } from './sentinel.ts'
import { ParticleOrb } from './ParticleOrb.tsx'
import { PARTICLE_STYLE } from './particleStyle.ts'
import { getParticleSettingsStore, useParticleSettings } from './particleSettingsStore.ts'
import { floatOrbCounts, type FloatOrbView } from './floatOrb.ts'

/**
 * 事务官浮窗(spec D11)。
 *
 * 不可改清单第 1 条——这个浮窗不进 `layout.modules`,不可被拖拽/隐藏/删除：Workbench.tsx
 * 把它放在模块渲染循环之外、独立挂载,代码层面就没有一条路径能让它消失，不靠"提示词
 * 里写了别动它"这种软约束（跟 layout.ts 顶部注释是同一条纪律，那边管的是模块，这里管
 * 的是事务官本体）。可移动的只有 `layout.butler.corner`（四角）、`layout.butler.min`
 * （收小）、`layout.butler.pos`（A6 新增,自由拖动的百分比坐标）、`layout.butler.size`
 * （Task 5 新增,可拉伸的像素尺寸,下限见 protocol.ts 的 MIN_BUTLER_W_PX/MIN_BUTLER_H_PX）
 * 与 `narrowForced`（W4 新增,选中「事务官」标签时的运行态投影,不落存档）这五项，前四项
 * 走 Workbench.tsx 的 applyLayout，跟其余布局字段同一条持久化路径。「全部暂停」的存在
 * 与行为不在这条能力范围内——A6/Task5 只加拖动/拉伸，别的不碰。
 *
 * W4:窄条是少画几个块，不是卸载组件；「全部暂停」不在任何条件分支里。
 */
export interface ButlerProps {
  /**
   * 浮窗展开时身里放什么(10-22 第三轮,维护者:「浮窗里直接放窗口槽里那页事务官」)。给了就放它(同一个组件,两个入口),
   * 老那套话(结论、快报、在盯着的事)不画;收成球态时照旧只有球与球上叫停入口(不可改清单第 1 条)。
   */
  page?: React.ReactNode
  /** butlerConclusions(state, nowSec) 的结果，[0] 是主文案，空数组时显示安静态。 */
  conclusions: readonly string[]
  corner: 'br' | 'bl' | 'tr' | 'tl'
  min: boolean
  /**
   * W4:选中「事务官」标签时强制窄条。**不写进存档**——它是"这会儿在看事务官"这个运行态的
   * 投影,不是 Ben 的偏好;切回别的应用标签就该回到他自己收小/展开的选择。
   * 与 `min` 的关系是**或**:两者任一成立即窄条(见组件内的 narrow)。
   */
  narrowForced: boolean
  /** A6:拖动后的位置(视口宽/高的百分比,clamp 0–95)。未设置时按 corner 摆在角落。 */
  pos?: { x_pct: number, y_pct: number }
  /** W4:拖动后的尺寸(px)。未设置时用 style.ts 的默认值。 */
  size?: { w_px: number, h_px: number }
  /** spec §5 诚实边界：暂停只影响工作台自己的响铃/采集，不控制 Agent 进程。 */
  paused: boolean
  /** 手动试铃是否在响（来电链 v0）。真相来自 /ring/test 的响应，不本地瞎猜。 */
  testRinging: boolean
  /**
   * 2026-09-11:事务官档露出时、以及纯净模式下,浮窗**藏起来**(hidden 属性)——它的功能
   * (全部暂停/试铃/在盯着的事/提议/快报)并进了事务官档(ButlerInbox 的抽屉与左堆),
   * 不可改清单第 1 条要的"永远有叫停入口"仍然成立。藏不是卸载:组件一直挂着,切到别的
   * 应用标签、或切回完整模式,它原样回来。
   */
  hidden?: boolean
  /** 标题栏点击触发，切换 layout.butler.min。 */
  onToggleMin: () => void
  /** A6:标题栏拖动触发,携带新的百分比坐标——拖拽和"点击切换收小"共用同一个标题栏,
   *  靠移动距离阈值区分(见组件内 handlePointerUp 的注释)。 */
  onMove: (pos: { x_pct: number, y_pct: number }) => void
  /** W4:拉伸手柄触发,携带新尺寸——与 onMove 同一条 800ms 去抖持久化路径。 */
  onResize: (size: { w_px: number, h_px: number }) => void
  /** "⏸ 全部暂停" / "▶ 恢复" 触发，POST /pause（翻转，不是两个独立接口）。 */
  onPause: () => void
  /** "🔔 试铃" / "🔕 停铃" 触发，POST /ring/test（同款翻转型接口）。 */
  onTestRing: () => void
  /** W4:今晨快报(来自 AiDJ 电台,服务端已算好 push)。缺省、无条目、或服务端说
   *  今天这份已被划走(`dismissed`,终审 C3)时整块不渲染——没有内容源时不推、
   *  不显示空壳(诚实边界)。 */
  brief?: BriefView
  /** W4:划走快报 → POST /brief/dismiss,当天不再推。 */
  onDismissBrief: () => void
  /**
   * W4:「跟事务官说一句」。
   *
   * **诚实边界**:这句话并没有被发给事务官——DSH 没有任何受支持的接口能从插件把文本送进
   * 对话(sessions 服务没有 send/submit,create() 不收初始提示词;DSH 不监听 postMessage;
   * 也没有 URL 参数能预填)。唯一"能带话"的办法是伸手进同源 iframe 的 DOM 去戳 DSH 的
   * 输入框——一升级就碎,不做。所以实际动作是:放进剪贴板 + 切到「事务官」标签,由 Ben ⌘V。
   * 返回值 = 是否成功放进剪贴板;false 时组件**不清空输入框**(内容还没安全落地)。
   * 将来 DSH 开放了送文本的接口,换掉上层这一个实现即可,组件这一侧不用动。
   */
  onAsk: (text: string) => Promise<boolean>
  /**
   * 哨兵(2026-09-09):在盯着的事。服务端没启用/一条都没有时整栏不渲染,不摆空壳
   * (同今晨快报的纪律)。**触发本身不走这个字段**——那走会话事件(黄点)。
   */
  sentinel?: SentinelView
  /** ✕ 取消一条监视。取消之后它那条会话也会被服务端收掉,不留永远黄着的点。 */
  onCancelWatch: (id: string) => void
  /**
   * 弹层让开窗位(2026-09-11):浮窗常驻、可拖到任何位置,**只有它的矩形与窗位矩形相交**时才
   * 让窗位让开(不能一直让窗位空着)。`slotRect` 由 Workbench 传入(量 slotBodyRef),这里在
   * 挂载、拖动结束、拉伸结束、窄条切换时各判一次——拖动过程中不判,免得一路上开开关关。
   * 不在壳里不传。只加 hook 调用,不动布局。
   */
  veil?: { target: VeilTarget, slotRect: () => RectLike | undefined }
  /**
   * 收起的球带的状态(2026-10-27,合并稿 5.1):形态、提示色、等你角标、两颗小点、悬停卡。
   * 由 Workbench 用 `floatOrbView(state)` 算好传进来;缺席 = 老调用方,球照旧待命、不画角标。
   */
  orb?: FloatOrbView
  /** 点角标:展开并摊开「待你处理」。缺席时角标点了等于展开。 */
  onOpenAsks?: () => void
}

/**
 * 一条监视项在界面上该说哪一句(纯函数,好单测)。
 *
 * 优先级就是"最该让人知道的那件事"排前面:探不到 > 收工了 > 最近一次变化 > 还没变过。
 * 探不到时**绝不**把 last_change 当成现状摆出来——那是上一次的事实,拿它冒充此刻
 * 就是编数(D13)。
 */
export function watchLine(watch: SentinelView['watches'][number]): string {
  if (watch.error !== undefined) return `探不到(${watch.error})`
  if (watch.done === true) return `已收工${watch.last_change === undefined ? '' : ` · ${watch.last_change}`}`
  if (watch.fires === 0) return `还没有变化${watch.last_change === undefined ? '' : `(${watch.last_change})`}`
  return `最近:${watch.last_change ?? '变过,但没记下变成了什么'}`
}

/** 拖拽判定阈值(px):移动小于这个距离算"没拖动"，落到点击/键盘那条"切换收小"的老路。 */
const DRAG_THRESHOLD_PX = 4

function clampPct(value: number): number {
  return Math.min(95, Math.max(0, value))
}

export function Butler({
  conclusions, corner, min, narrowForced, pos, size, paused, testRinging,
  onToggleMin, onMove, onResize, onPause, onTestRing, brief, onDismissBrief, onAsk,
  sentinel, onCancelWatch, hidden = false, veil, page, orb, onOpenAsks,
}: ButlerProps) {
  const headline = conclusions[0] ?? '一切正常，没什么要说的'
  // 球的外观设置与 ButlerInbox 同源(10-22 统筹第三轮):同一个粒子设置 store,两个入口一颗球。
  const particleSettings = useParticleSettings(getParticleSettingsStore())
  // W4:原「收小」与新「窄条」并成一态(Ben 2026-08-25 拍板)。今天的收小只剩「事务官」
  // 两个字、按钮全没了——那跟"永远有叫停入口"这条硬约束对不上。合并之后不再有任何一态
  // 会让「全部暂停」离开屏幕。
  const narrow = min || narrowForced

  // M4(review 修复):拖拽本体是这个 <aside>,不是标题栏按钮——抓取偏移量要按它的
  // 当前屏幕矩形算,不能拿按钮自己的矩形(按钮只占标题栏那一小条,矩形原点跟浮窗
  // 本身的左上角对不上)。
  const asideRef = useRef<HTMLElement | null>(null)
  const [showStopPopover, setShowStopPopover] = useState(false)
  const longPressTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    return () => {
      if (longPressTimerRef.current !== null) clearTimeout(longPressTimerRef.current)
    }
  }, [])

  useEffect(() => {
    if (!narrow) setShowStopPopover(false)
  }, [narrow])

  // A6:拖拽态存在 ref 里，不进 state——拖拽过程中的每一次 pointermove 都要触发
  // onMove(进而触发上层的 800ms 去抖持久化 effect)，用 state 会带来不必要的重渲染。
  // M4(review 修复):补 offsetX/offsetY——按下那一刻记录"指针相对浮窗左上角的偏移量",
  // 不是"指针位置就是浮窗左上角"。没有这个偏移量的话,只要不是精确按在左上角按下,
  // 松手瞬间浮窗就会"传送"到指针位置,而不是跟着指针移动的距离平移。
  const dragRef = useRef<{
    pointerId: number, startX: number, startY: number, offsetX: number, offsetY: number, moved: boolean
  } | null>(null)
  // pointerup 判定"这是一次拖拽,不是点击"之后，紧跟着浏览器原生的 click 事件也会触发——
  // 用这个 ref 告诉 onClick"这次跳过，别再切换一次收小"，触发过一次就复位。
  const suppressClickRef = useRef(false)

  // 弹层让开窗位(2026-09-11):浮窗此刻是否压在窗位上。只在几个"落定"时刻判(见 ButlerProps.veil)。
  const [overSlot, setOverSlot] = useState(false)
  const slotRectOf = veil?.slotRect
  const checkOverSlot = useCallback((): void => {
    if (slotRectOf === undefined) return
    const el = asideRef.current
    if (el === null) return
    const r = el.getBoundingClientRect()
    const slot = slotRectOf()
    setOverSlot(slot !== undefined && rectsIntersect({ x: r.left, y: r.top, w: r.width, h: r.height }, slot))
  }, [slotRectOf])
  useVeilSlot(overSlot, veil?.target)

  const handlePointerDown = (event: ReactPointerEvent<HTMLButtonElement>): void => {
    // M3(review 修复):只处理主指针(isPrimary,多点触控只认第一根手指)与左键
    // (button===0,不吃掉右键菜单/中键的语义)——之前只有注释这么说,代码没真的挡。
    if (!event.isPrimary || event.button !== 0) return
    const rect = asideRef.current?.getBoundingClientRect()
    dragRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      offsetX: rect === undefined ? 0 : event.clientX - rect.left,
      offsetY: rect === undefined ? 0 : event.clientY - rect.top,
      moved: false,
    }
    event.currentTarget.setPointerCapture?.(event.pointerId)
    if (narrow) {
      if (longPressTimerRef.current !== null) clearTimeout(longPressTimerRef.current)
      longPressTimerRef.current = setTimeout(() => {
        setShowStopPopover(true)
        suppressClickRef.current = true
      }, 500)
    }
  }

  const handlePointerMove = (event: ReactPointerEvent<HTMLButtonElement>): void => {
    const drag = dragRef.current
    if (drag === null || drag.pointerId !== event.pointerId) return
    const dx = event.clientX - drag.startX
    const dy = event.clientY - drag.startY
    if (!drag.moved && Math.hypot(dx, dy) < DRAG_THRESHOLD_PX) return
    drag.moved = true
    if (longPressTimerRef.current !== null) {
      clearTimeout(longPressTimerRef.current)
      longPressTimerRef.current = null
    }
    const viewportW = window.innerWidth || 1
    const viewportH = window.innerHeight || 1
    // M4:浮窗左上角 = 指针当前位置 − 抓取时记录的偏移量,不是指针位置本身。
    const leftPx = event.clientX - drag.offsetX
    const topPx = event.clientY - drag.offsetY
    onMove({ x_pct: clampPct((leftPx / viewportW) * 100), y_pct: clampPct((topPx / viewportH) * 100) })
  }

  const handlePointerUp = (event: ReactPointerEvent<HTMLButtonElement>): void => {
    if (longPressTimerRef.current !== null) {
      clearTimeout(longPressTimerRef.current)
      longPressTimerRef.current = null
    }
    const drag = dragRef.current
    if (drag === null || drag.pointerId !== event.pointerId) return
    dragRef.current = null
    if (drag.moved) suppressClickRef.current = true // 这次是拖拽，紧跟着的 click 不该再切换收小
    checkOverSlot() // 弹层让开窗位:拖动结束再判一次相交
  }

  const handleClick = (): void => {
    // 鼠标拖拽结尾会自然触发一次 click——用标记跳过它，键盘 Enter/Space 触发的
    // click 不会经过 pointerdown/up，不受这个标记影响，收小/展开照常可用。
    if (suppressClickRef.current) { suppressClickRef.current = false; return }
    onToggleMin()
  }

  // W4:拉伸手柄——复用上面拖动逻辑的形状(setPointerCapture + ref 存拖拽态,不进 state),
  // 不引入新机制。手柄自己 stopPropagation,别让标题栏那套拖动逻辑也吃到这次按下。
  const resizeRef = useRef<{ pointerId: number, startX: number, startY: number, w: number, h: number } | null>(null)

  const handleResizeDown = (event: ReactPointerEvent<HTMLSpanElement>): void => {
    if (!event.isPrimary || event.button !== 0) return
    const rect = asideRef.current?.getBoundingClientRect()
    resizeRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      w: rect?.width ?? MIN_BUTLER_W_PX,
      h: rect?.height ?? MIN_BUTLER_H_PX,
    }
    event.currentTarget.setPointerCapture?.(event.pointerId)
    event.stopPropagation() // 别让标题栏那套拖动逻辑也吃到这次按下
  }

  const handleResizeMove = (event: ReactPointerEvent<HTMLSpanElement>): void => {
    const drag = resizeRef.current
    if (drag === null || drag.pointerId !== event.pointerId) return
    onResize(clampButlerSize(
      { w_px: drag.w + (event.clientX - drag.startX), h_px: drag.h + (event.clientY - drag.startY) },
      { w: window.innerWidth || 1, h: window.innerHeight || 1 },
    ))
  }

  const handleResizeUp = (event: ReactPointerEvent<HTMLSpanElement>): void => {
    if (resizeRef.current?.pointerId === event.pointerId) resizeRef.current = null
    checkOverSlot() // 拉伸结束再判一次相交
  }

  // W4:读存档来的值同样要夹——存档里可能有旧版本/手改进去的越界值(拖拽那条路已经
  // 夹过了,但那不覆盖"打开页面时读到的第一份布局")。窄条态不吃 size:它的尺寸由内容
  // 决定(就那么两个按钮),硬套一个存下来的展开态尺寸只会留下一片空白。
  const viewport = { w: window.innerWidth || 1, h: window.innerHeight || 1 }
  const clampedSize = (narrow || size === undefined) ? undefined : clampButlerSize(size, viewport)
  const sizeStyle = clampedSize === undefined
    ? undefined
    : { width: `${clampedSize.w_px}px`, height: `${clampedSize.h_px}px` }

  /**
   * C2(整分支终审,合并前必修 · 不可改清单第 1 条):**实际渲染尺寸**,布局阶段量出来的。
   *
   * 位置夹紧必须知道浮窗到底多大。有 `size` 那一档知道(那是行内 width/height,渲染
   * 出来就是那么大);**没有 `size` 的那一档静态算不出来**——宽度是 CSS 的 250px(不是
   * MIN_BUTLER_W_PX 那个 200),高度更是内容撑出来的(展开态带 20 条快报能到 800+px)。
   * 老写法在这一档拿 200×80 顶替,于是夹出来的落位把浮窗底部整个推出下沿,「全部暂停」
   * 离开可视区——而 `size` 是 W4 才加的字段,旧存档一律没有,`pos` 却早就在用,
   * 所以这是升级后第一次打开就会命中的常规路径,不是边角。
   *
   * 只能量,不能算:所以在布局阶段(useLayoutEffect,浏览器绘制之前)量一次真实矩形,
   * 量到之后重算一次位置。纯 CSS 解决不了——`max-height:100vh` 管得住"浮窗比屏幕高",
   * 管不住"从 y=95% 往下画 887px",而 CSS 里拿不到自己的 top 百分比去算可用高度。
   */
  const [measuredSize, setMeasuredSize] = useState<{ w_px: number, h_px: number } | undefined>(undefined)
  useLayoutEffect(() => {
    // 没有 pos 就没人用这个尺寸(位置交给 corner 的 CSS 规则),不必每次渲染都强制一次
    // 同步布局——上层每秒一拍轮询会让这个组件跟着重渲染,白量一次是白量一秒一次。
    if (pos === undefined) return
    const el = asideRef.current
    if (el === null) return
    const rect = el.getBoundingClientRect()
    // 量不到(jsdom 不做布局、元素还没进文档)就不动上一次的值——0 不是"很小",是"不知道",
    // 拿 0 去夹位置会得出"整个视口都能放得下"这种假结论。
    if (rect.width <= 0 || rect.height <= 0) return
    setMeasuredSize(prev => (
      prev !== undefined && Math.abs(prev.w_px - rect.width) < 0.5 && Math.abs(prev.h_px - rect.height) < 0.5
        ? prev // 没变就返回同一个引用,React 直接跳过这次更新,不会自我循环
        : { w_px: rect.width, h_px: rect.height }
    ))
  })

  // 弹层让开窗位:挂载、窄条切换、pos/size 落定(不在拖动/拉伸中——那两条各自在松手时判)
  // 时判一次相交。拖动中 pos 每帧都在变,这里靠 dragRef 跳过,松手那次由 handlePointerUp 补。
  useEffect(() => {
    if (dragRef.current !== null || resizeRef.current !== null) return
    checkOverSlot()
  }, [checkOverSlot, narrow, pos?.x_pct, pos?.y_pct, size?.w_px, size?.h_px])

  // 夹位置用的尺寸:有 size 走 size(Task 5 已验证过的那条路,一字不改),否则用量到的
  // 真实尺寸;**量不到就是 undefined**——不拿常量顶替。顶替的代价(统筹验收回修,真回归):
  // 拖拽发上来的第一帧 pos 带着"还没量到"的兜底尺寸进 clamp,520×680 的下限常量比默认
  // 渲染尺寸(宽 250、高内容撑)大得多,视口矮一点就把 top 夹成 0%;jsdom 里量不到,
  // 天然停在"只按 0–95% 夹"这一档。真实尺寸量到之后(布局阶段,绘制之前)下一次渲染
  // 自然改走尺寸感知 clamp,藏得住近似帧。夹只在渲染时发生、绝不回写(2026-10-28,
  // 见下面那一大段)——所以 clamp 用多大的尺寸都只会影响这一帧画在哪儿,不会再经
  // onMove 变成一次写盘。
  const posSize: { w_px: number, h_px: number } | undefined = narrow
    ? { w_px: BUTLER_BALL_DIAMETER_PX, h_px: BUTLER_BALL_DIAMETER_PX }
    : (clampedSize ?? measuredSize)
  // pos 存在时用行内样式覆盖 corner 的角落定位(inline style 的优先级天然高于外部
  // 样式表的 [data-corner] 规则,不需要额外加 !important)；没有 pos 时不设行内样式,
  // corner 的 CSS 规则原样生效(向后兼容旧存档/从未拖动过的默认态)。
  // 尺寸未知那一档只按 0–95% 夹(A6 的老语义)——没有尺寸的浮窗宽度是 CSS 的 250px、
  // 高度内容撑,拿任何常量顶替都会系统性夹过头(见上)。
  const posStyle = pos === undefined
    ? undefined
    : (() => {
        const p = posSize === undefined
          ? { x_pct: clampPct(pos.x_pct), y_pct: clampPct(pos.y_pct) }
          : clampButlerPos(pos, posSize, viewport)
        return { left: `${p.x_pct}%`, top: `${p.y_pct}%`, right: 'auto', bottom: 'auto' }
      })()

  const style = { ...(posStyle ?? {}), ...(sizeStyle ?? {}) }

  // 2026-10-28(交接-1027「12:0x 气泡」那节的治本第一条):**夹位置只在渲染时算,不回写**。
  // 这里原来还有一句"校正后的位置经 onMove 落盘"——它就是悬浮窗反复开合那轮事故里
  // `POST → 服务端回声 → 再 POST` 的环的发动机:任何一次渲染量到的尺寸跟上一帧不一样
  // (球态/展开态切换、内容高度变了、回声里夹过的值跟本地不同),校正就会产出一个新
  // pos 写回存档,回声再盖回来,永动。渲染时夹(上面的 posStyle)已经保证浮窗始终待在
  // 视口内;存档里留着未校正的原始值无害——下一次渲染照样按当时的真实尺寸夹。
  // 所以:onMove 只剩拖拽一个调用方(用户动作),渲染路径一行持久化都不发。

  // 修复轮 1(Important 1,评审):今天没有提议源,所以这里传的是空数组——但**这条
  // 调用链是真的**,不是注释里的许诺。将来接上数据源时,只需要把空数组换成真实
  // 来源,PRD §9 的三条门槛(见 proposals.ts 的 admissibleProposals)已经在路径上
  // 了,不会被漏掉。不为此引入时间依赖注入机制,直接读墙钟。
  //
  // I2(整分支终审):这里原来写的是 `new Date().toISOString().slice(0, 10)`——那是
  // **UTC 日期**,东八区每天 00:00–08:00 之间它给出的是昨天,而门槛①回溯用的
  // proposals.ts 的 dayBefore 走本地时区,两头对不上。今天输入恒为空数组、后果还
  // 看不见,但门槛要的正是"结构性在场,将来接源不必有人记得补",埋着一条每天错
  // 8 小时的日期就不算在场。改用客户端日期算法的单一实现(dates.ts 的 localDateStr,
  // 那份的头注释写明了同一条纪律)。
  const todayStr = localDateStr(Date.now())
  const admissible = admissibleProposals([], todayStr)

  // W4:「跟事务官说一句」——见 ButlerProps.onAsk 的诚实边界注释。这里只管输入框自己的
  // 状态与提交,真正的剪贴板/切标签动作都在上层(Workbench.tsx 的 handleAsk)。
  const [ask, setAsk] = useState('')
  const [askHint, setAskHint] = useState<string | undefined>(undefined)

  const submitAsk = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault()
    const text = ask.trim()
    if (text === '') return
    void onAsk(text).then((copied) => {
      // 文案只说做过的事。没发出去就不能写"已发送"——那是工作台做不到的事。
      setAskHint(copied ? '已复制,⌘V 粘进对话框' : '没能复制,请手动选中复制')
      if (copied) setAsk('')
    })
  }

  return (
    <aside
      ref={asideRef}
      className="ben-wb__butler"
      data-corner={corner}
      data-min={min}
      data-narrow={narrow}
      data-paused={paused}
      style={style}
      aria-label="事务官"
      hidden={hidden}
    >
      {narrow ? (
        <div className="ben-wb__butler-ball-wrap">
          {/* 粒子球(10-22 统筹第三轮,维护者:「那个球体也是粒子球?」):与 ButlerInbox 里
              同一颗 ParticleOrb、同一份外观设置 store。mode 照它那一条映射——浮窗收起态
              没有输入框焦点与执行计数可读,恒 'idle';试铃按服务端 /state.orb 那一格的口径
              (callingNowOf:test_ringing 算通话中)只翻提示色 confirmation(琥珀),不动 mode,
              与事务官页那颗球逐字一致。PARTICLE_STYLE 平时由 ButlerInbox 注入,浮窗是独立
              挂载、收起时那一页可能不在——这里自备一份(内容相同,重复注入无副作用)。 */}
          <style>{PARTICLE_STYLE}</style>
          <button
            type="button"
            className="ben-wb__butler-ball-btn"
            aria-label={orb === undefined ? '事务官(点一下展开)' : `事务官:${orb.line}(点一下展开)`}
            data-paused={paused}
            data-stale={orb?.stale === true}
            onClick={handleClick}
            onPointerDown={handlePointerDown}
            onPointerMove={handlePointerMove}
            onPointerUp={handlePointerUp}
            onPointerCancel={handlePointerUp}
            onContextMenu={(event) => {
              event.preventDefault()
              setShowStopPopover(v => !v)
            }}
          >
            <span aria-hidden="true">
              <ParticleOrb
                mode={testRinging ? 'calling' : orb?.mode ?? 'idle'}
                notice={testRinging ? 'confirmation' : orb?.notice ?? 'neutral'}
                visible={!hidden}
                settings={particleSettings.preset.settings}
                paused={particleSettings.paused}
              />
            </span>
          </button>
          {orb !== undefined && orb.waiting > 0 && (
            <button type="button" className="ben-wb__butler-badge" aria-label={`等你 ${orb.waiting} 件,点一下摊开`} onClick={() => (onOpenAsks ?? onToggleMin)()}>{orb.waiting}</button>
          )}
          {orb !== undefined && (orb.answer || orb.fresh) && (
            <span className="ben-wb__butler-dots">
              {orb.answer && <i title="有一条没看的回复" />}
              {orb.fresh && <i data-fresh="true" title="有刚办完的结果没看" />}
            </span>
          )}
          {orb !== undefined && (
            <div className="ben-wb__butler-hover" role="tooltip">
              <b>事务官 · {orb.line}</b>
              <span>{floatOrbCounts(orb)}</span>
              {orb.lines.length > 0 && <ul>{orb.lines.slice(0, 3).map(one => <li key={one}>{one}</li>)}{orb.lines.length > 3 && <li>还有 {orb.lines.length - 3} 件</li>}</ul>}
              {paused && <span className="ben-wb__butler-hover-warn">已暂停:只停响铃与采集,不停 Agent</span>}
              {orb.stale && <span className="ben-wb__butler-hover-warn">保留上次状态,不当作空闲</span>}
              <small>长按或右键:全部暂停 / 试铃</small>
            </div>
          )}
          {showStopPopover && (
            <div className="ben-wb__butler-stop-popover" role="region" aria-label="事务官叫停入口">
              <button
                type="button"
                className="ben-wb__butler-pause"
                onClick={() => { onPause(); setShowStopPopover(false) }}
              >
                {paused ? '▶ 恢复' : '⏸ 全部暂停'}
              </button>
              <button
                type="button"
                className="ben-wb__butler-pause"
                onClick={() => { onTestRing(); setShowStopPopover(false) }}
                title={testRinging ? '取消刚排的那一通(工人已经领走就停不掉,手机上按挂断)' : '排一通真来电:手机会响,拿起听筒就能接'}
              >
                {testRinging ? '🔕 停铃' : '🔔 试铃'}
              </button>
            </div>
          )}
        </div>
      ) : (
        <>
          <div className="ben-wb__butler-head-bar">
            <button
              type="button"
              className="ben-wb__butler-head"
              onClick={handleClick}
              onPointerDown={handlePointerDown}
              onPointerMove={handlePointerMove}
              onPointerUp={handlePointerUp}
              onPointerCancel={handlePointerUp}
              aria-expanded={true}
            >
              <span className="ben-wb__butler-dot" aria-hidden="true" />
              <span className="ben-wb__butler-title">事务官</span>
            </button>
            <button
              type="button"
              className="ben-wb__butler-collapse"
              aria-label="收起为球"
              title="收起为球"
              onClick={onToggleMin}
            >
              收起
            </button>
          </div>

          {page !== undefined ? <div className="ben-wb__butler-page">{page}</div> : (
            <div className="ben-wb__butler-body">
              <div className="ben-wb__butler-text">
                <p className="ben-wb__butler-line">{headline}</p>
                {paused && (
                  <p className="ben-wb__butler-paused">
                    已暂停工作台自动行为(响铃/采集)——不控制 Agent 进程
                  </p>
                )}
                {brief !== undefined
                  && ((brief.topics.length > 0 && brief.dismissed !== true) || brief.error !== undefined) && (
                  <section className="ben-wb__butler-brief" aria-labelledby="ben-wb-butler-brief">
                    <div className="ben-wb__butler-brief-head">
                      <h2 className="ben-wb__ttl" id="ben-wb-butler-brief">今晨快报</h2>
                      {brief.topics.length > 0 && (
                        <button
                          type="button"
                          className="ben-wb__butler-brief-x"
                          aria-label="划走今晨快报"
                          onClick={onDismissBrief}
                        >
                          ✕
                        </button>
                      )}
                    </div>
                    {brief.error !== undefined ? (
                      <p className="ben-wb__empty">今天没取到快报({brief.error})</p>
                    ) : (
                      <ul className="ben-wb__butler-brief-list">
                        {brief.topics.map(topic => (
                          <li key={topic.id}>
                            <a href={topic.url} target="_blank" rel="noopener noreferrer">{topic.title}</a>
                            <span className="ben-wb__butler-brief-src">{topic.source}</span>
                          </li>
                        ))}
                      </ul>
                    )}
                  </section>
                )}
                {sentinel !== undefined && sentinel.watches.length > 0 && (
                  <section className="ben-wb__butler-sentinel" aria-labelledby="ben-wb-butler-sentinel">
                    <h2 className="ben-wb__ttl" id="ben-wb-butler-sentinel">在盯着的事</h2>
                    <ul className="ben-wb__butler-sentinel-list">
                      {sentinel.watches.map(watch => (
                        <li key={watch.id} data-done={watch.done === true}>
                          <div className="ben-wb__butler-sentinel-head">
                            <span className="ben-wb__butler-sentinel-note">{watch.note}</span>
                            <button
                              type="button"
                              className="ben-wb__butler-brief-x"
                              aria-label={`取消监视:${watch.note}`}
                              onClick={() => onCancelWatch(watch.id)}
                            >
                              ✕
                            </button>
                          </div>
                          <span className="ben-wb__butler-sentinel-target">
                            {SENSOR_LABEL[watch.kind]} · {watch.target}
                          </span>
                          <span className="ben-wb__butler-sentinel-change">{watchLine(watch)}</span>
                        </li>
                      ))}
                    </ul>
                  </section>
                )}
                <section className="ben-wb__butler-prop" aria-labelledby="ben-wb-butler-prop">
                  <h2 className="ben-wb__ttl" id="ben-wb-butler-prop">工作台自己的提议</h2>
                  {admissible.length === 0 && (
                    <p className="ben-wb__empty">
                      证据不足,暂不提议。功能层提议需同一模块连续 {EVIDENCE_DAYS_REQUIRED} 天同向行为才允许发起。
                    </p>
                  )}
                </section>
                <form className="ben-wb__butler-ask" onSubmit={submitAsk}>
                  <input
                    className="ben-wb__inp"
                    aria-label="跟事务官说一句"
                    placeholder="＋ 跟事务官说一句(回车切过去)"
                    value={ask}
                    onChange={event => { setAsk(event.target.value); setAskHint(undefined) }}
                  />
                  {askHint !== undefined && <p className="ben-wb__butler-ask-hint" role="status">{askHint}</p>}
                </form>
              </div>
              <div className="ben-wb__butler-acts">
                <button type="button" className="ben-wb__butler-pause" onClick={onPause}>
                  {paused ? '▶ 恢复' : '⏸ 全部暂停'}
                </button>
                <button
                  type="button"
                  className="ben-wb__butler-pause"
                  onClick={onTestRing}
                  title={testRinging ? '取消刚排的那一通(工人已经领走就停不掉,手机上按挂断)' : '排一通真来电:手机会响,拿起听筒就能接'}
                >
                  {testRinging ? '🔕 停铃' : '🔔 试铃'}
                </button>
              </div>
            </div>
          )}

          <span
            className="ben-wb__butler-grip"
            role="separator"
            aria-label="拉伸事务官浮窗"
            onPointerDown={handleResizeDown}
            onPointerMove={handleResizeMove}
            onPointerUp={handleResizeUp}
            onPointerCancel={handleResizeUp}
          />
        </>
      )}
    </aside>
  )
}
