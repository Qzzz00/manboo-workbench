/**
 * 由 Workbench.tsx 拆出(2026-08-25 地基:六窗口并行前的接缝切分)。
 *
 * 2026-08-25 版面重排:组件条(widgets)整块退休,原来挤在里面的存储/性能两格搬到这里
 * ——Ben 的盘长期 95%+,这是真实风险提示,不能跟着宿主模块一起消失(设计稿 §0 澄清结论)。
 * 顶条只放数字与告警色;machine 缺省或 { error } 仍按 D13 显式标"未接入:<原因>",绝不编数。
 * 右端的齿轮是凭据的入口(SettingsDialog),把"配置类"的东西从常显区域收走。
 *
 * 2026-09-11 纯净模式:右侧多一个「纯净 / 完整」开关(给了 onTogglePureMode 才画);纯净时
 * 额度格收起了,顶栏多一行额度摘要(quotaSummary,完整模式不传——同一个数字不在两处各说一遍,
 * Ben 2026-08-25 定);页头那一行(含「返回对话」)也收起了,不在壳里时「返回对话」搬到这里
 * (onReturn),否则浏览器里就没有离开浮层的路。
 *
 * 2026-09-25(卡 TB,维护者「顶部空隙难受」):**页头那一行整块没了,并进了这一条**。
 * 原来顶上叠三层 —— 系统菜单栏、壳的窗口标题栏、网页里的「工作台 + 副标题」标题行,再下面
 * 才是状态行。现在:壳的标题栏透明掉(workbench-app/Sources/TitleBar.swift),网页内容顶到窗顶,
 * 这一条就是窗口的顶栏 —— 左边留出红绿灯的位置(`shell` 为真时),接着是小字「工作台」、
 * 各家小灯、存储 / 性能、额度摘要、时间、齿轮、纯净开关;页头上的「恢复默认布局」「返回对话」
 * 也搬到这条的右端(onResetLayout / onReturn),没有丢功能。
 * 空白处按住能拖窗口(判断在 topbarDrag.ts,壳那侧 performDrag);红绿灯下面那一截不放任何能点的东西。
 *
 * 2026-09-26(卡 TB2,维护者对着截图:「这两个明显重叠了…前面的是汇总,后面的是在线/在忙情况?
 * 这能整合的吧…悬浮上去还被挡住了」):**两排并成一排**。卡 LG 加的那条「N 家 Agent 客户端 + 一排小图标」
 * 与原来的小灯排说的是同一批家 —— 那条排整块退休,只剩小灯排;排最前面多一小格「N 家」(悬停/读屏
 * 念整句「这台电脑上 N 家 Agent 客户端」),点它就是原来那张登记表面板。还没接上的候选家不再单独一排,
 * 灰着画在这一排里(悬停说清为什么)。
 *
 * 「被挡住」那一半:窗口槽里是**真的原生窗**,永远盖在 WebView 上。顶栏这一条上的弹出物统一
 * 走**一处** `useVeilSlot`(让槽里那扇窗让路,关掉就回来),再加一条不依赖壳的退路 ——
 * 点开的登记表面板横向躲开窗位(topbarPopover.ts 的 popoverShift)。悬停那一张要悬够一小段时间才算打开,
 * 鼠标扫过不 veil、不闪。
 *
 * 2026-09-26(卡 AC,维护者对着截图:「悬停顶栏 Claude 那一格,浮层跑到屏幕最右边」):**悬停那一张不躲窗位**,
 * 只锚在被悬停那一格正下方、靠右时收边(popoverClamp);被窗位压住那一半交给 useVeilSlot。
 * 同一张里那颗「这不是 Agent」也去掉了 —— 撤一家只在「N 家」面板每行的「⋯」里。
 */

import type { CSSProperties, MouseEvent as ReactMouseEvent } from 'react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { AgentActions } from './AgentActions.tsx'
import { AgentIcon } from './AgentIcon.tsx'
import { LampCardBody, LampIcon } from './AgentLamp.tsx'
import type { EntryLamp, LampDetail, RegistryCount } from './agentRegistryView.ts'
import type { PerformanceWidgetView, StorageWidgetView } from './machineWidgets.ts'
import { isDragBlank, requestShellDrag, requestShellMoveScreen, requestShellTitleBarDoubleClick } from './topbarDrag.ts'
import { TOPBAR_HOVER_CLOSE_MS, TOPBAR_HOVER_OPEN_MS, popoverClamp, popoverShift, popoverViewport } from './topbarPopover.ts'
import type { VeilTarget } from './useVeilSlot.ts'
import { useVeilSlot } from './useVeilSlot.ts'

/** 两张浮层各多宽(px)。与 style.ts 里 `.ben-wb__lampcard` / `.ben-wb__agentcount-card` 的 width 一致 —— 躲窗位要按真实宽度算。 */
const LAMPCARD_WIDTH = 290
const COUNTCARD_WIDTH = 320
/** 浮层默认相对锚点左沿偏多少(同 style.ts 里那两个 `left`)。 */
const LAMPCARD_OFFSET = -6
const COUNTCARD_OFFSET = 0

/**
 * 顶栏最左边那几个字。壳的窗口标题已经隐藏(标题栏透明,卡 TB),「工作台」这三个字只在这里
 * 说一次,小字、不抢视线。字面与 Workbench.tsx 的 WORKBENCH_TITLE 一致 —— 不 import 它是为了
 * 不跟 Workbench.tsx 形成循环引用(它 import 本文件)。
 */
const TOPBAR_NAME = '工作台'

/**
 * 那颗灯的悬停提示(原生 title):有最近那一句就说它;没接上的那几家说清为什么灰着(卡 TB2)。
 * `data-bubble` 只跟着"最近那一句"走 —— 它驱动的是灯旁那一闪(style.ts 的 ben-wb-lamp-bubble)。
 */
function lampTitle(lamp: TopBarLamp): { title?: string, 'data-bubble'?: 'on' } {
  if (lamp.bubble !== undefined) return { title: lamp.bubble, 'data-bubble': 'on' }
  // 顶栏只留 logo 之后,鼠标停上去至少要看得见是哪一家。
  return lamp.dim === true && lamp.why !== undefined ? { title: lamp.why } : { title: lamp.name }
}

/**
 * 登记表面板里**已经接上那几家**行末的「⋯」(2026-09-26,卡 TB2 追加)。
 *
 * 维护者原话:「每一个下面都有一个『这不是 Agent』的按钮,这很蠢」。他是对的 —— 一张表上九行、
 * 每行都摆一颗撤销键,那张表看起来像九个待办。接上了的那几家**没有要他判断的事**,行里只说
 * 图标 · 名字 · 状态;判错了要撤时点「⋯」才出现那颗「这不是 Agent」。
 * (真要他判断的是「还拿不准的」那几家,那几行才常显「接上 / 这不是 Agent」。)
 */
function RegistryRowMenu({ name, id, talk }: {
  name: string
  id: string
  talk?: { baseUrl: string, fetchImpl: typeof fetch } | undefined
}) {
  const [menuOpen, setMenuOpen] = useState(false)
  if (talk === undefined) return null
  return (
    <>
      <button
        type="button"
        className="ben-wb__agentcount-more"
        aria-label={`${name}:更多`}
        aria-expanded={menuOpen}
        title={`${name}:更多`}
        onClick={() => setMenuOpen(prev => !prev)}
      >
        ⋯
      </button>
      {menuOpen && <AgentActions item={{ title: name, agent: { id } }} talk={talk} />}
    </>
  )
}

/**
 * 顶条上的一颗小灯(2026-09-25,卡 Q):**一家 Agent 一颗,按登记表来**,名字也是登记表里的 ——
 * 这里不再有「DSH / Claude / Codex / Kimi」那张写死的表,新发现的一家接上就有它的灯。
 * `bubble` = 它最近冒的那一句(「Muse 开始跑了」「Muse 回了:…」),挂在灯上当提示,灯旁一闪。
 * `detail` = 点开 / 悬停出来那一张(它此刻怎样、读了什么不读什么)。
 * **那一张里没有「这不是 Agent」**(2026-09-26,卡 AC):撤一家只在「N 家」面板每行的「⋯」里。
 */
export interface TopBarLamp {
  id: string
  name: string
  /** 灯色(状态):在跑 / 等你 / 其余。 */
  color: string
  /** 这一家自己的颜色(从它 App 图标来,卡 Q):名字用它写,与会话卡上的小头像同一个色。 */
  tint?: string
  /**
   * 它的 **logo** 取到了没(2026-09-26,卡 LG;维护者:「把对应的 logo 也搞上」)。
   * 取到了:这颗灯画成那家 App 的图标,**状态那颗色点叠在图的右下角当角标** —— 状态语义一点没丢,
   * 只是不再靠一颗点独自说「这是哪一家」。没取到 / 图加载失败:还是原来那颗色点(见 AgentIcon)。
   */
  icon?: boolean
  /**
   * 还没接上的那一家(2026-09-26,卡 TB2):**灰着画在这一排里**。原来它们只出现在那条单独的
   * 「N 家 Agent 客户端」排里,那条排已经并进来了 —— 灰 + 悬停说清 `why`,不再另起一排。
   */
  dim?: boolean
  /** 灰着的原因(「Muse 没开,还没读到过它的窗口」):悬停时说这一句。 */
  why?: string
  bubble?: string
  detail?: LampDetail
}

/**
 * 小灯那一排后面那一句(2026-09-25,卡 Q;统筹:没给壳辅助功能授权时「得是一句能懂的话,加上一键去开的入口,不许空白」)。
 * `onAction` 给了就带那颗键(没授权时是「去打开」,同顶上横幅那颗「去授权」一样打开系统设置那一页)。
 */
export interface TopBarAgentHint {
  text: string
  action?: string
  onAction?: () => void
  /** 打不开系统设置时的原因原文。 */
  error?: string | null
}

/** 顶栏那颗把当前方向的排布换回默认的键(评审页写「恢复布局」,10-22 拍板照稿)。 */
export const RESET_LAYOUT_LABEL = '恢复布局'

/** 顶条：各家在线状态 + 存储/性能 + 时间 + 设置（PRD §5.1）。壳里它同时就是窗口的标题栏（卡 TB）。 */

export function TopBar({ lamps, agentCount, agentHint, talk, veil, now, storage, performance, onOpenSettings, pureMode = false, onTogglePureMode, quotaSummary, onReturn, onResetLayout, onOpenLearned, shell = false, updateDot = false }: {
  lamps: readonly TopBarLamp[]
  /**
   * 小灯那一排最前面那一小格「N 家」(2026-09-26,卡 LG 起头、卡 TB2 并进这一排)。
   * 不给就不画(TopBar 单独渲染的老用例不受影响)。数法只认登记表(`registryCount`),不写死名单。
   */
  agentCount?: RegistryCount
  /**
   * 窗口槽让路(2026-09-26,卡 TB2):顶栏上的弹出物一开,槽里那扇真窗就得退下去,不然浮层被它压住。
   * **整条顶栏只有一处** `useVeilSlot` 管这件事(见下面 anyOpen)。不在壳里(浏览器页面)不给,
   * 那时什么都不发;`slotRect` 还兼作"浮层躲开窗位"的退路(壳旧 / 让路没成也至少不重叠)。
   */
  veil?: VeilTarget
  /** 读不了别家窗口、要他动一下手时那一句(见 TopBarAgentHint)。 */
  agentHint?: TopBarAgentHint
  /** 登记表面板里那颗「这不是 Agent」(在每行的「⋯」里)往哪儿说,兼各家 logo 的取图地址。不给就不画那颗键。 */
  talk?: { baseUrl: string, fetchImpl: typeof fetch }
  now: string
  storage: StorageWidgetView
  performance: PerformanceWidgetView
  onOpenSettings: () => void
  /** 纯净模式开着。 */
  pureMode?: boolean
  /** 「纯净 / 完整」开关。不给就不画(TopBar 单独渲染的老用例不受影响)。 */
  onTogglePureMode?: () => void
  /** 纯净模式下的额度摘要一行。 */
  quotaSummary?: string
  /** 不在壳里(浏览器标签页):「返回对话」搬到顶栏——页头那一行已经没了。 */
  onReturn?: () => void
  /** 「恢复布局」也从页头搬来(卡 TB)。不给就不画。 */
  onResetLayout?: () => void
  /** 「学到的做法」:开设置里「它学到了什么」那一节(评审页顶栏,10-22 拍板加)。不给就不画。 */
  onOpenLearned?: () => void
  /**
   * 在壳里(卡 TB):左边留出红绿灯的位置,整条空白处当窗口标题栏用(按住拖、双击照系统设置)。
   * 浏览器标签页里没有红绿灯、也没有窗口可拖,这两样都不做。
   */
  shell?: boolean
  /**
   * 齿轮上那个小点(2026-09-18 热更新):服务器上有比本机新的一版。
   *
   * **只打一个点,不弹窗**。Ben 的原话是「能加热更新的按钮吗」—— 他要的是有个地方能点,
   * 不是被一个模态框拦住。点本身也不带数字、不带颜色告警:它不是故障,是一件可以以后再做的事。
   */
  updateDot?: boolean
  /**
   * 2026-09-17:顶栏上那颗「初始化」**没了**。那一页改名「体检与修复」,按 09-17 的拍板
   * (「三个环节分开」)只从设置里进 —— 它是维护用的东西,不该在第一次开机时抢视线;
   * 而"还差什么"现在由顶上那两条细横幅(NeedBar)说,且各自带着去那儿的路。
   */
}) {
  /** 开着的是哪一颗灯那一张(同时只开一张;点开的与悬停开的是同一个状态)。 */
  const [open, setOpen] = useState<string | undefined>(undefined)
  /** 这一张是点开的(pinned):鼠标移开也留着,只有点别处 / Esc 才收。悬停开的那张移开就收。 */
  const [pinned, setPinned] = useState(false)
  /** 「N 家」那一小格点开没(卡 LG 的登记表面板,卡 TB2 起挂在这一格上)。 */
  const [countOpen, setCountOpen] = useState(false)
  /** 开着那一张要不要横向挪一挪才不压在窗位上(px,相对锚点;undefined = 照原位)。 */
  const [shift, setShift] = useState<number | undefined>(undefined)
  /** 整排(含「N 家」那一格与两张浮层):点排外面才收。 */
  const lampsRef = useRef<HTMLDivElement>(null)
  const hoverTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  /**
   * 顶栏上**有没有浮层开着**。窗口槽让路只认这一条 —— 一处 `useVeilSlot`,开一次、关一次,
   * 配对由那个 hook 自己管(它连整页关闭时的补发都做了)。悬停那一张也走这里:它要悬够
   * TOPBAR_HOVER_OPEN_MS 才进 open,所以鼠标扫过顶栏不会一路 veil / unveil。
   */
  const anyOpen = countOpen || open !== undefined
  useVeilSlot(anyOpen, veil)

  /**
   * 浮层躲开窗位(不依赖壳的那条退路,卡 TB2 第 3 条):让路没成 / 壳是旧版 / 压根不在壳里时,
   * 至少把浮层挪到不与窗位横向重叠的地方。开的那一刻按锚点实量一次(纯几何在 topbarPopover.ts)。
   */
  const measureShift = useCallback((anchor: HTMLElement | null, width: number, offset: number): number | undefined => {
    if (anchor === null) return undefined
    const box = anchor.getBoundingClientRect()
    const next = popoverShift({ x: box.left, y: box.top, w: box.width, h: box.height }, width, veil?.slotRect?.(), popoverViewport(), offset)
    return next === undefined ? undefined : next - box.left
  }, [veil])
  /**
   * 悬停那一张的位置(2026-09-26,卡 AC):**锚在那一格正下方**,只在靠右装不下时往左收边。
   * 不走 `measureShift` —— 躲窗位会把它甩到屏幕另一头(维护者 21:40 的截图就是这个),
   * 被窗位压住那一半由上面那一处 `useVeilSlot` 管。
   */
  const measureClamp = useCallback((anchor: HTMLElement | null, width: number, offset: number): number | undefined => {
    if (anchor === null) return undefined
    const box = anchor.getBoundingClientRect()
    const next = popoverClamp({ x: box.left, y: box.top, w: box.width, h: box.height }, width, popoverViewport(), offset)
    return next === undefined ? undefined : next - box.left
  }, [])

  const clearHoverTimer = (): void => {
    if (hoverTimerRef.current !== null) {
      clearTimeout(hoverTimerRef.current)
      hoverTimerRef.current = null
    }
  }
  /** 全收(点别处 / Esc / 那一家没了)。 */
  const closeAll = useCallback((): void => {
    clearHoverTimer()
    setOpen(undefined)
    setPinned(false)
    setCountOpen(false)
    setShift(undefined)
  }, [])
  const openLamp = (id: string, anchor: HTMLElement | null, byClick: boolean): void => {
    setCountOpen(false)
    setShift(measureClamp(anchor, LAMPCARD_WIDTH, LAMPCARD_OFFSET))
    setOpen(id)
    setPinned(byClick)
  }
  // 悬停:悬够一小段时间才真打开(那一刻才 veil)。移开留一点回头的余地,好让鼠标走进浮层里点东西;
  // 点开的那一张(pinned)不受移开影响。
  const handleLampEnter = (lamp: TopBarLamp, event: ReactMouseEvent<HTMLDivElement>): void => {
    if (lamp.detail === undefined || pinned) return
    const anchor = event.currentTarget
    clearHoverTimer()
    hoverTimerRef.current = setTimeout(() => {
      hoverTimerRef.current = null
      openLamp(lamp.id, anchor, false)
    }, TOPBAR_HOVER_OPEN_MS)
  }
  const handleLampLeave = (lamp: TopBarLamp): void => {
    clearHoverTimer()
    if (pinned) return
    hoverTimerRef.current = setTimeout(() => {
      hoverTimerRef.current = null
      setOpen(prev => (prev === lamp.id ? undefined : prev))
      setShift(undefined)
    }, TOPBAR_HOVER_CLOSE_MS)
  }
  useEffect(() => clearHoverTimer, [])
  /** 这一条本身(拖窗口时要判断「按的地方在不在这条里、是不是空白」)。 */
  const barRef = useRef<HTMLDivElement>(null)

  // 壳里:空白处按住拖窗口 / 双击照系统设置(卡 TB)。能点的东西按下去不算拖动,判断在
  // topbarDrag.isDragBlank;右键、中键不管(菜单与粘贴各有各的去处)。
  const handleBarMouseDown = (event: ReactMouseEvent<HTMLDivElement>): void => {
    if (!shell || event.button !== 0) return
    if (!isDragBlank(event.target, barRef.current)) return
    requestShellDrag(window)
  }
  const handleBarDoubleClick = (event: ReactMouseEvent<HTMLDivElement>): void => {
    if (!shell) return
    if (!isDragBlank(event.target, barRef.current)) return
    requestShellTitleBarDoubleClick(window)
  }
  // 点排外面 / 按 Esc 收起 —— 两张浮层同一处收法(卡 TB2:顶栏弹出物不各写一套)。
  useEffect(() => {
    if (!anyOpen) return
    const onDown = (event: MouseEvent): void => {
      if (lampsRef.current !== null && event.target instanceof Node && lampsRef.current.contains(event.target)) return
      closeAll()
    }
    const onKey = (event: KeyboardEvent): void => { if (event.key === 'Escape') closeAll() }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [anyOpen, closeAll])
  // 那一家已经不在登记表里了(刚说了「这不是 Agent」):那一张跟着收,以后它再回来也不会自己弹开。
  useEffect(() => {
    if (open !== undefined && !lamps.some(lamp => lamp.id === open)) {
      setOpen(undefined)
      setPinned(false)
    }
  }, [lamps, open])
  return (
    <div
      className="ben-wb__topbar"
      role="group"
      aria-label="来源与额度概览"
      ref={barRef}
      // 壳里这一条就是窗口的标题栏:留红绿灯的位置、空白处可拖(样式见 style.ts 的 [data-shell=app])。
      {...(shell ? { 'data-shell': 'app' } : {})}
      onMouseDown={handleBarMouseDown}
      onDoubleClick={handleBarDoubleClick}
    >
      {/* 「工作台」三个字(卡 TB):原来是页头里 22px 的 h1 加一行副标题,现在缩成顶栏左边的小字。
          仍然是 h1 —— 这一屏总得有个标题;纯净模式下连它也收起(那时候整屏只留一颗球)。 */}
      <h1 className="ben-wb__topname" hidden={pureMode}>{TOPBAR_NAME}</h1>
      {/* **只剩这一排**(2026-09-26,卡 TB2)。排最前面是「N 家」那一小格(卡 LG 那条排的全部内容
          都在它点开的面板里),后面一家一颗灯。两处浮层都挂在这个 div 里:收法、让路、躲窗位同一处。 */}
      <div className="ben-wb__toplamps" ref={lampsRef}>
        {/* 「N 家」(悬停/读屏念整句「这台电脑上 N 家 Agent 客户端」;不数事务官)。点它 = 登记表面板。
            **不画边框**:维护者 19:40「有一条奇怪的白色线框」说的就是原来那条排的描边(卡 TB2)。 */}
        {agentCount !== undefined && agentCount.total > 0 && (
          <div className="ben-wb__agentcount" hidden={pureMode}>
            <button
              type="button"
              className="ben-wb__agentcount-btn"
              aria-label={agentCount.text}
              aria-haspopup="dialog"
              aria-expanded={countOpen}
              title={agentCount.text}
              onClick={(event) => {
                const anchor = event.currentTarget
                setOpen(undefined)
                setPinned(false)
                setCountOpen((prev) => {
                  const next = !prev
                  setShift(next ? measureShift(anchor, COUNTCARD_WIDTH, COUNTCARD_OFFSET) : undefined)
                  return next
                })
              }}
            >
              <span className="ben-wb__agentcount-n">{agentCount.label}</span>
            </button>
            {countOpen && (
              <div
                className="ben-wb__agentcount-card"
                role="dialog"
                aria-label={agentCount.text}
                {...(shift === undefined ? {} : { style: { left: `${shift}px` } as CSSProperties })}
              >
                <p className="ben-wb__agentcount-title">{agentCount.text}</p>
                <ul className="ben-wb__agentcount-list">
                  {agentCount.items.map(item => (
                    <li key={item.id} className="ben-wb__agentcount-row" data-dim={item.connected ? undefined : 'true'}>
                      <AgentIcon id={item.id} icon={item.icon} tint={item.tint} baseUrl={talk?.baseUrl} dim={!item.connected} />
                      <span className="ben-wb__agentcount-name">{item.name}</span>
                      <span className="ben-wb__agentcount-why">{item.why}</span>
                      {/* 2026-09-26 卡 TB2 追加(维护者:「每一个下面都有一个『这不是 Agent』的按钮,这很蠢」):
                          已经接上的那几家**默认一颗键都不显** —— 「这不是 Agent」收进这一行的「⋯」里。
                          事务官自己连「⋯」也没有(没有可撤的)。 */}
                      {!item.self && <RegistryRowMenu name={item.name} id={item.id} talk={talk} />}
                    </li>
                  ))}
                </ul>
                {/* ★ 认出是 AI 应用、窗口却读不到的那几家(2026-10-01):**如实摆一行**,不默默不列(D13)。
                    Air 上的新版 Kimi、可灵、App Store 版豆包都是这样 —— 她拉进窗口槽也不会有动静,
                    得让她知道是读不到那扇窗,不是工作台没看见它。这几家没有「接上」可点(接上了也读不到)。 */}
                {agentCount.unreadable.length > 0 && (
                  <>
                    <p className="ben-wb__agentcount-title ben-wb__agentcount-asking">认出来了、读不到它的窗口:</p>
                    <ul className="ben-wb__agentcount-list">
                      {agentCount.unreadable.map(one => (
                        <li key={one.id} className="ben-wb__agentcount-row" data-dim="true" title={one.detail}>
                          <AgentIcon id={one.id} tint={undefined} baseUrl={talk?.baseUrl} dim />
                          <span className="ben-wb__agentcount-name">{one.name}</span>
                          <span className="ben-wb__agentcount-why">{one.why}</span>
                        </li>
                      ))}
                    </ul>
                  </>
                )}
                {/* 真要他判断的只有这几家:「接上 / 这不是 Agent」两颗键常显(卡 TB2 追加)。 */}
                {agentCount.candidates.length > 0 && (
                  <>
                    <p className="ben-wb__agentcount-title ben-wb__agentcount-asking">还拿不准的:</p>
                    <ul className="ben-wb__agentcount-list">
                      {agentCount.candidates.map(one => (
                        <li key={one.id} className="ben-wb__agentcount-row" data-dim="true">
                          <AgentIcon id={one.id} tint={undefined} baseUrl={talk?.baseUrl} dim />
                          <span className="ben-wb__agentcount-name">{one.name}</span>
                          <span className="ben-wb__agentcount-why">{one.why}</span>
                          <AgentActions item={{ title: one.name, agent: { id: one.id } }} talk={talk} connect />
                        </li>
                      ))}
                    </ul>
                  </>
                )}
              </div>
            )}
          </div>
        )}
        {lamps.map(lamp => (
          <div
            className="ben-wb__topagent-slot"
            key={lamp.id}
            onMouseEnter={event => handleLampEnter(lamp, event)}
            onMouseLeave={() => handleLampLeave(lamp)}
          >
            {lamp.detail === undefined
              ? (
                  <span className="ben-wb__topagent" data-dim={lamp.dim === true ? 'true' : undefined} style={lamp.tint === undefined ? undefined : { color: lamp.tint }} {...lampTitle(lamp)}>
                    <LampIcon lamp={lamp} baseUrl={talk?.baseUrl} />
                    {/* 顶栏只留 logo(2026-09-27,维护者搬到竖屏后:「顶部要不只留 icon,不要名字了吧」)。
                        名字留给读屏与悬停:取不到 logo 的那一家(退回色点)才把名字露出来,不然认不出是谁。 */}
                    <span className="ben-wb__topagent-name" data-shown={lamp.icon === true ? undefined : 'true'}>{lamp.name}</span>
                  </span>
                )
              : (
                  <button
                    type="button"
                    className="ben-wb__topagent"
                    // 念出来是「Muse 的详情」:与窗口槽里同名的那颗标签键分得开。
                    aria-label={`${lamp.name} 的详情`}
                    aria-haspopup="dialog"
                    aria-expanded={open === lamp.id}
                    // 还没接上的那几家灰着(卡 TB2:候选家并进这一排,不再单独一排)。
                    data-dim={lamp.dim === true ? 'true' : undefined}
                    style={lamp.tint === undefined ? undefined : { color: lamp.tint }}
                    onClick={(event) => {
                      if (open === lamp.id && pinned) { closeAll(); return }
                      openLamp(lamp.id, event.currentTarget.parentElement, true)
                    }}
                    {...lampTitle(lamp)}
                  >
                    <LampIcon lamp={lamp} baseUrl={talk?.baseUrl} />
                    {/* 顶栏只留 logo(2026-09-27,维护者搬到竖屏后:「顶部要不只留 icon,不要名字了吧」)。
                        名字留给读屏与悬停:取不到 logo 的那一家(退回色点)才把名字露出来,不然认不出是谁。 */}
                    <span className="ben-wb__topagent-name" data-shown={lamp.icon === true ? undefined : 'true'}>{lamp.name}</span>
                  </button>
                )}
            {open === lamp.id && lamp.detail !== undefined && (
              <div
                className="ben-wb__lampcard"
                role="dialog"
                aria-label={lamp.name}
                {...(shift === undefined ? {} : { style: { left: `${shift}px` } as CSSProperties })}
              >
                <LampCardBody lamp={lamp} />
                {/* 2026-09-26 卡 AC:这一张里**没有**「这不是 Agent」。维护者 21:40:「TB2 说已收进『⋯』,
                    悬停浮层里还在」—— 收进「⋯」只改了登记表面板那几行,这一张漏了。鼠标扫过顶栏就
                    弹出一颗能把一家撤掉的键,是误点的路;那颗键只在「N 家」面板每行的「⋯」里(RegistryRowMenu)。
                    这一张只**说它此刻怎样**:状态、最近那句、备注、读了什么。 */}
              </div>
            )}
          </div>
        ))}
        {agentHint !== undefined && (
          <span className="ben-wb__tophint" role="status">
            <span className="ben-wb__tophint-text">{agentHint.text}</span>
            {agentHint.onAction !== undefined && (
              <button type="button" className="ben-wb__tophint-btn" onClick={agentHint.onAction}>{agentHint.action ?? '去打开'}</button>
            )}
            {agentHint.error !== undefined && agentHint.error !== null && <span className="ben-wb__tophint-err">{agentHint.error}</span>}
          </span>
        )}
      </div>
      {/* role/aria-label/data-alert 三样跟组件条时期保持一致:它们验的是"这两格在界面上有
          常显位置",搬了家断言照样该成立(tests/workbenchLayout.test.tsx 就是这么查的)。 */}
      <span className="ben-wb__topstat" role="group" aria-label="存储" data-alert={storage.alert}>
        <span className="ben-wb__topstat-label">存储</span>
        <span
          className={`ben-wb__topstat-val${storage.alert ? ' ben-wb__topstat-val--alert' : ''}${
            storage.error ? ' ben-wb__topstat-val--off' : ''}`}
        >
          {storage.valueText}
        </span>
      </span>
      <span className="ben-wb__topstat" role="group" aria-label="性能">
        <span className="ben-wb__topstat-label">性能</span>
        <span className={`ben-wb__topstat-val${performance.error ? ' ben-wb__topstat-val--off' : ''}`}>
          {performance.valueText}
        </span>
      </span>
      {/* 2026-08-25 版面重排:顶条那条额度提词抹掉了——余额与额度已经在「消耗数据」下面
          有了自己的模块(QuotaPanel),同一个数字不在两处各说一遍(Ben 2026-08-25 定)。
          2026-09-11:只有纯净模式(额度格收起了)才把摘要放回来。 */}
      {quotaSummary !== undefined && (
        <span className="ben-wb__topquota" role="group" aria-label="额度摘要">{quotaSummary}</span>
      )}
      <span className="ben-wb__topclock">{now}</span>
      {onOpenLearned !== undefined && (
        <button type="button" className="ben-wb__topplain" onClick={onOpenLearned}>学到的做法</button>
      )}
      <button
        type="button"
        className="ben-wb__topgear"
        aria-label={updateDot ? '设置(有新版)' : '设置'}
        data-dot={updateDot ? 'update' : undefined}
        title={updateDot ? '工作台有新版,在设置里可以更新' : undefined}
        onClick={onOpenSettings}
      >
        设置
        {updateDot && <i className="ben-wb__topgear-dot" aria-hidden="true" />}
      </button>
      {onTogglePureMode !== undefined && (
        <button
          type="button"
          className="ben-wb__toppure"
          data-pure={pureMode}
          aria-label={pureMode ? '完整' : '纯净'}
          title={pureMode ? '切回完整工作台' : '纯净模式:整屏只留一颗球'}
          onClick={onTogglePureMode}
        >
          {pureMode ? '完整' : '纯净'}
        </button>
      )}
      {/* 页头没了之后从那儿搬过来的两颗(卡 TB):「恢复默认布局」是全局动作,纯净模式下
          没有布局可恢复(整屏只有一颗球),收起;「返回对话」只在浏览器里有意义(壳里没有
          DSH 的对话界面),由 Workbench 决定给不给。 */}
      {/* 「换屏」(2026-09-27,维护者:「还是拖不动,你要不加一个按钮,一键搬运到另一个桌面吧」):
          只在壳里画(浏览器里没有窗口可搬),点一下壳把窗口搬到下一块屏、按那块屏铺好。 */}
      {shell && (
        <button type="button" className="ben-wb__topplain" onClick={() => { requestShellMoveScreen(window) }}>换屏</button>
      )}
      {onResetLayout !== undefined && !pureMode && (
        <button type="button" className="ben-wb__topplain" onClick={onResetLayout}>{RESET_LAYOUT_LABEL}</button>
      )}
      {onReturn !== undefined && (
        <button type="button" className="ben-wb__toppure" onClick={onReturn}>返回对话</button>
      )}
    </div>
  )
}
