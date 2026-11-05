import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { CSSProperties, PointerEvent as ReactPointerEvent, ReactNode, RefObject } from 'react'
import type { PropsRuntime, PropsStore } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type { ClientKey, DockTab, HelperView, LayoutModule, QuotaStaleFix, SessionView, SnapView, WorkbenchLayout, WorkbenchState } from '../protocol.ts'
import { buildProjectRows } from './portfolio.ts'
import { ProjectZone } from './ProjectZone.tsx'
import { QuotaPanel } from './QuotaPanel.tsx'
import { SettingsDialog } from './SettingsDialog.tsx'
import { SceneBar } from './SceneBar.tsx'
import { inShellApp, isTopFrame, notifyShellReady } from './shell.ts'
import { installFileDropGuard } from './fileDropGuard.ts'
import { Butler } from './Butler.tsx'
import { TopBar } from './TopBar.tsx'
import { topClockText } from './clockText.ts'
import { ModuleBox, ModuleHeader, SplitHandle } from './ModuleBox.tsx'
import { SlotZone } from './SlotZone.tsx'
import { DockTabBar } from './DockTabBar.tsx'
import { DevToolButton, DEV_TOOL_DRAFT } from './DevToolButton.tsx'
import { postSilently } from './postSilently.ts'
import { ProjectsModule } from './ProjectsModule.tsx'
import { CollabZone } from './collab/CollabZone.tsx'
import { SlotModule } from './SlotModule.tsx'
import { ActorNotes, addActorNote, isActorNote, liveActorNotes, type ShownActorNote } from './ActorNotes.tsx'
import { groupLayoutRows } from '../layoutRows.ts'
import { UsageModule } from './UsageModule.tsx'
// 随手记 / 素材管理 / 选题池 / 发布计划 / 数据复盘这几格由用户层的小组件提供(2026-10-21,卡「分层第一刀」):
// 本体只留自带的那一版(素材管理、选题池有;另外三格本体没有自带的,装不上就说一句人话)。
import { FilesModule as BuiltinFilesModule } from './FilesModule.tsx'
import { UserLayerCell, userLayerRegistry, useUserLayerSkin, useUserLayerSync, type UserLayerRegistry } from './userLayer.tsx'
import { butlerConclusions } from './butler.ts'
import { ButlerInbox, type ButlerControls } from './ButlerInbox.tsx'
import { floatOrbView } from './floatOrb.ts'
import { useCollabRuns } from './useCollabRuns.ts'
import { admissibleProposals } from './proposals.ts'
import { localDateStr } from './dates.ts'
import { quotaAgentIds, quotaCells, quotaSummaryLine } from './quotaCells.ts'
// 每个区域单独解锁(2026-09-17)。这个文件只借两样东西:顶部状态点的清单,以及解锁卡按钮的去处。
import { type UnlockTarget } from './areaUnlock.ts'
// DeepSeek 那张解锁卡上「用我们的服务(推荐)」那一颗(2026-09-21):就地切,不跳设置。
import { switchModelMode } from './model.ts'
// 「点一下,工作台帮你接上」(2026-09-17):解锁卡上那颗按钮弹出来的小确认框。
import { HooksApplyDialog } from './HooksApplyDialog.tsx'
import { ConnectAllDialog } from './ConnectAllDialog.tsx'
import type { HooksAgent } from './hooksApply.ts'
import { createWorkbenchStore } from './store.ts'
import { buildPerformanceWidget, buildStorageWidget } from './machineWidgets.ts'
import { humanDuration } from './sessionFeed.ts'
import { registryCount, registryHint, registryLamps } from './agentRegistryView.ts'
import { useWorkbenchState } from './useWorkbenchState.ts'
import { useVeilSlot, type VeilTarget } from './useVeilSlot.ts'
import type { RectLike } from './butlerGeometry.ts'
import { STYLE } from './style.ts'
import { syncRootTheme } from './tokens.ts'
import { LearnRail } from './LearnRail.tsx'
import { CONFIRMS, ConfirmDialog } from './ui/index.tsx'
import {
  branchModules, butlerPosOf, DEFAULT_LAYOUT, LANDSCAPE_BAND_IDS, LANDSCAPE_MOVABLE_IDS,
  LANDSCAPE_DECK_IDS, LANDSCAPE_RAIL_FALLBACK_PCT, landscapeArrangement, landscapeDeckPct,
  landscapeDeckWidth, landscapeRailPct, landscapeSidePct, landscapeSideTotal,
  MODULE_IDS, resetLayout, resizeLandscapeDeck, resizeLandscapeDeckPair,
  resizeLandscapeSidePair, resizeModule, resizeRowPair, setLandscapeRailPct, toggleHidden,
  withButlerPos, type ModuleId,
} from './layout.ts'
import { decideLayoutAdopt } from './layoutAdopt.ts'
import { useWidgetReorder } from './useWidgetReorder.ts'
import { useOrientation, type Orientation } from './orientation.ts'
import { DailyBar } from './DailyBar.tsx'
import { SetupPage } from './setup/SetupPage.tsx'
import { setupRequestedIn } from './setup/steps.ts'
import { AccountScreen } from './account/AccountScreen.tsx'
import { probeAccount, type AccountProbe } from './account/accountApi.ts'
import { FirstRunFlow } from './firstrun/FirstRunFlow.tsx'
import { fetchFirstRun, markFirstRunDone } from './firstrun/firstRunApi.ts'
import { NeedBar } from './NeedBar.tsx'
import { accessNotice } from './accessNotice.ts'
import { useAccessAuthorize } from './accessAuthorize.ts'
// 壳窗口「前台 / 桌面」两档(2026-09-18):判断是纯函数,这里只负责在状态变化时发一次。
import { decideWindowMode, postWindowMode, type ShellWindowMode } from './shellWindowMode.ts'
// 第一次用的空态(2026-09-18):算在 emptyState.ts(纯函数、有单测),这里只负责把结论分发给各模块。
import { emptyStateFor, type EmptyModule, type EmptyView } from './emptyState.ts'
// 布局模板(2026-09-21):默认模块标题 + 三个新模块的组件。
import { DEFAULT_MODULE_TITLES } from '../templates.ts'
import { TodoModule as BuiltinTodoModule } from './TodoModule.tsx'
import { TodayModule } from './TodayModule.tsx'
import { MeNameProvider } from './meName.tsx'
// 事务官要问的话、要批的事(2026-09-25,卡 M):DSH 原始界面上那颗「‹ 回工作台」、「事务官」标签上的气泡、系统通知点回来。
import { RETURN_PILL_STYLE } from './askStyle.ts'
import { waitingOf } from './askModel.ts'
import type { CollabPresence } from '../protocol.ts'

/**
 * 主界面左上角的标题(2026-09-23)。产品自己的名字,不带上游品牌、不带任何人名。
 * 事务官的名字(引导里起的那个,`~/.dsh/AGENTS.md` 首行「我叫 X」)是事务官的,不是工作台的,不借来当标题。
 */
export const WORKBENCH_TITLE = '工作台'

/**
 * 模块头标题（spec §3 分区 2/4/5，日结条/事务官浮窗不在此列——不可自定义）。
 * A3(2026-08-24 UX 波):不再有 sessions——会话区整块下线,标签上的彩色圆点徽章
 * (DockTabBar)接过了"谁在等我"的职责。
 */
/**
 * 2026-09-21(布局模板):这份文案**搬去了 src/templates.ts 的 DEFAULT_MODULE_TITLES**,
 * 这里改成 re-export。值一个字没改,只是多了三个新模块(待办事项 / 发布计划 / 数据复盘)。
 *
 * 它现在是**默认**标题,不是唯一标题:模板可以改其中几个(运营模板把「项目区」叫
 * 「账号」、把「系统文件夹」叫「素材管理」)。组件里真正要显示的那一个走下面的
 * `titleOf(id)` —— 它先看 `/state.template.module_titles`,没接模板服务才落回这一份。
 */
const MODULE_TITLES: Record<ModuleId, string> = DEFAULT_MODULE_TITLES as Record<ModuleId, string>

/** 布局变更后 debounce 多久才落盘（spec §4：拖坏了要能回来，也不必每次拖都打服务）。 */
const LAYOUT_SAVE_DEBOUNCE_MS = 800

/** 窗位矩形上报的 resize 去抖(spec 2026-08-24 窗位叠 v2 V3):拖窗改视口不必每帧都打服务。 */
const SLOT_RECT_DEBOUNCE_MS = 800

/**
 * 多久比一次壳窗口的屏幕签名(位置 / DPR / 屏幕尺寸;2026-10-12,跨屏重贴)。只比一个字符串,
 * 不量 DOM、不发请求;半秒是「拖到外接屏松手,窗跟着过去」人感觉得到的上限。
 */
export const SLOT_DISPLAY_POLL_MS = 500

/**
 * 稳定性门(2026-08-25 真机实证):被动上报(挂载/ResizeObserver/window resize,即不带
 * reason 的 reportSlotRect 调用)在真正 POST 之前,隔这么久重测一次槽体矩形——两次矩形
 * 四边都在阈值内才当作"真的稳定",否则整次丢弃、不上报。
 *
 * WHY:真机抓到过页面瞬态重排(项目区短暂缺席导致行高从 26% 跌到 13.7%,槽体瞬间上移
 * 约 300px、宽度 1400→1420)——服务端此前无条件存储每一次被动上报的矩形,这条瞬态重
 * 排量出的"毒矩形"因此被存了下来。页面本身几十毫秒内就恢复正常、后续上报会把它覆盖
 * 掉,但覆盖之前的窗口期里用户只要点一次标签切换(switchTo 消费的正是当时存的矩形),
 * 窗口就会被贴到这个错误位置——延迟发作,真机上排查了很久才定位到根因是被动上报路径
 * 本身不设防。这里在真正 POST 前补一道最内层的门:两帧(或一小段时间)后重测,不稳定
 * 就丢弃这一次,不自己排重试循环——下一次 RO/resize 触发自然会带着新的稳定态重新走
 * 一遍这整条上报路径。
 *
 * 带 reason:'resize' 的路径(用户拖把手松手/slot 模块 basis 真的变了)不经过这道门——
 * 那是用户明确动作后的稳定态,矩形本身就是可信的,加门只会给用户能感知到的操作徒增
 * 延迟。
 *
 * 用 setTimeout 而不是连续两帧 requestAnimationFrame:与本文件其余去抖(SLOT_RECT_
 * DEBOUNCE_MS 等)、现有测试基建的假时钟/waitFor 手法更好配合,两种技术选型对"隔一小段
 * 时间重测"这个需求是等价的。
 */
const SLOT_RECT_STABILITY_DELAY_MS = 80
/** 稳定性门判定"两次矩形算不算一致"的阈值——与服务端 dock.ts 的 8px 噪声门槛同一档位。 */
const SLOT_RECT_STABILITY_THRESHOLD_PX = 8

interface SlotRectSnapshot { x: number, y: number, w: number, h: number }

/** 稳定性门专用的矩形比较:四边都在阈值内才算"没变"，先例见 dock.ts 的 rectNearlyEqual。 */
function slotRectNearlyStable(a: SlotRectSnapshot, b: SlotRectSnapshot): boolean {
  return Math.abs(a.x - b.x) < SLOT_RECT_STABILITY_THRESHOLD_PX
    && Math.abs(a.y - b.y) < SLOT_RECT_STABILITY_THRESHOLD_PX
    && Math.abs(a.w - b.w) < SLOT_RECT_STABILITY_THRESHOLD_PX
    && Math.abs(a.h - b.h) < SLOT_RECT_STABILITY_THRESHOLD_PX
}

type WorkbenchStore = ReturnType<typeof createWorkbenchStore>

export interface WorkbenchInjected {
  openWorkspace: (workspaceId: string, projectName: string) => Promise<void>
  /**
   * 打开某条事项底下那段 DSH 对话(2026-09-10 事项收件箱)。实现在 client/index.ts:
   * `ctx.uiWorkspace.openSession(sessionId)`(0.1.7-rc.2 起导航在这个服务上) + 把工作台
   * 浮层让开——**让开是这条路的一半**,不让开的话点完什么都看不到(浮层盖着整屏)。
   */
  openSession: (sessionId: string) => void
}

/**
 * 悬停高亮 v1 的 WS 订阅只用得上这几个成员——特意不直接写 `WebSocket`(浏览器/Node 全量
 * 接口还有 readyState/binaryType/addEventListener 等一大堆本组件用不到的东西)。真实
 * `WebSocket` 结构上天然满足这个窄接口,测试传一个只实现这几个成员的假对象也一样成立,
 * 不用在假类里垫一堆用不到的属性。
 */
export interface MinimalWebSocket {
  onmessage: ((event: { data: unknown }) => void) | null
  onclose: (() => void) | null
  close: () => void
}

/** 本地服务的接入参数。测试传假 fetch + pollMs 0，生产用默认值。 */
export interface WorkbenchServiceProps {
  serviceBaseUrl?: string
  serviceFetch?: typeof fetch
  servicePollMs?: number
  /**
   * 「看过了就该灭」的停留阈值(2026-08-27)。切到某个应用标签并停留这么久,
   * 就把该应用当时已亮的蓝点标已读。缺省见 DockTabBar 的 DWELL_READ_MS;
   * 测试注入一个很小的值,跟 servicePollMs 同一套约定。
   */
  dockDwellReadMs?: number
  /**
   * 悬停高亮 v1(spec 拖拽悬停进出圈信号)：/live 订阅要用的 WebSocket 构造器,缺省用全局
   * `WebSocket`(同 serviceFetch 缺省用全局 fetch 的先例)。**测试必须显式传一个假类**——
   * 不传的话会退回全局 WebSocket 真的去连 baseUrl,真机实测踩过:jsdom 测试环境下这样
   * 会直接连到 Ben 本机正在跑的真实工作台服务(8791 端口),而且 jsdom 的 Event 类和
   * Node WebSocket 实现内部用的 Event 不是同一个东西,真连上时会在 dispatchEvent 里炸出
   * 一条 uncaught exception。
   */
  serviceWebSocket?: (url: string) => MinimalWebSocket
  /** 用户层小组件登记在哪(2026-10-21)。缺省是页面上那一份;测试传一份新的,免得互相串。 */
  userLayer?: UserLayerRegistry
}

export type WorkbenchOverlayProps =
  PropsRuntime<'shell.overlay'> & PropsStore<WorkbenchStore> & WorkbenchInjected & WorkbenchServiceProps

export type WorkbenchButtonProps =
  PropsRuntime<'sidebar.footer.action'> & PropsStore<WorkbenchStore>

/** 悬停那条 /live 连接断了多久重连:3 秒起、翻倍、封顶 15 秒(见 WorkbenchOverlayInner 里那条 effect)。 */
export const HOVER_WS_RETRY_MS = 3000
/** 窗口槽那圈流线光放下那一下亮多久(一圈 3.2 秒,见 fxModel BEAM.slotHover)。 */
export const DROP_FLASH_MS = 3200
export const HOVER_WS_RETRY_MAX_MS = 15000

/** 「引导走完那一刻已经切过一次事务官档」记在本机的哪一格(见 WorkbenchOverlayInner 里 onboardingDoneAt 那段)。 */
export const HOME_SHOWN_KEY = 'ben-wb.home-after-onboarding'
function readHomeShownFor(): string | undefined {
  try { return window.localStorage.getItem(HOME_SHOWN_KEY) ?? undefined } catch { return undefined }
}
function writeHomeShownFor(at: string): void {
  try { window.localStorage.setItem(HOME_SHOWN_KEY, at) } catch { /* 存不了就只是下次还会切一次 */ }
}

/** 工作台是一个入口：项目区回答"事情走到哪了"，会话区回答"现在谁在等我"（design §0）。 */
function WorkbenchOverlayInner({
  useStore, actions, useWorkspaces, openWorkspace, openSession,
  serviceBaseUrl, serviceFetch, servicePollMs, serviceWebSocket, dockDwellReadMs, userLayer,
}: WorkbenchOverlayProps) {
  const state = useStore(snapshot => snapshot)
  const phase = useWorkspaces(snapshot => snapshot.phase)
  const [note, setNote] = useState('')
  const [expandedProjectId, setExpandedProjectId] = useState<string | null>(null)
  // 拖拽悬停高亮(悬停高亮 v1)：壳的 hover 事件经服务端 /live 转广播过来。一个布尔够了,
  // 不需要进 layout/store——纯运行态的"这会儿有没有窗口悬停在圈里"。
  const [dropHover, setDropHover] = useState(false)
  /**
   * 窗口槽那圈流线光此刻亮不亮(2026-09-25,卡 P):**只在他真把一个新应用拖进来、放手那一下**(/live 的 `slot_drop`)
   * 亮一轮 {@link DROP_FLASH_MS};壳已经亮了原生光圈(`native`)就不再画页面自己那圈。悬停、切换、刷新、重连都不亮。
   */
  const [dropFlash, setDropFlash] = useState(false)
  /**
   * 事务官(或别的程序)动了哪一块:那一块旁边挂着的那几行字(2026-09-25 卡 P 补三,/live 的 `actor_note`)。
   * 只是字:没有光、没有圈。挂在哪、看不看得见由 ActorNotes 当场对着真实的元素定。
   */
  const [actorNotes, setActorNotes] = useState<ShownActorNote[]>([])
  /** 协作区板上的小鼠标(2026-10-21):`/live` 的 `kind:'presence'`,不进快照;每个 Agent 只留最后一个样子。 */
  const [collabPresence, setCollabPresence] = useState<readonly CollabPresence[]>([])
  /**
   * C1(整分支终审):**「事务官」选中态唯一的一处客户端状态,只在叠为空时才被读**。
   *
   * 这是"选中态不新增客户端状态"(DockTabBar 的 butlerActive 注释、Task 3 的纪律)
   * 那条原则的一个明确例外,例外的理由是**服务端在这一档确实表达不了**:选中态的
   * 服务端真相是 `dock.current === null`,而叠里一个成员都没有的时候 current 恒为
   * null——不管用户点没点「事务官」,它都是 null。原则本身要防的是"两份状态各说各话
   * 走漂",可这里根本不存在第二份可漂的真相:叠为空时没有任何原生窗,服务端对
   * "Ben 这会儿在看事务官还是在看落点"这件事没有意见,也不需要有。叠非空的那一档
   * 仍然一字不改地读服务端(见下方 butlerActive 的派生)。
   *
   * **何时清除**:
   *   ① 叠一旦确知有了成员(认领了第一扇窗)——这一档的真相回到服务端,它就该归零,
   *      见下方 dockHasMembers 那个 effect。这条同时保证了"放出最后一个应用"之后
   *      落回落点、而不是停在选中事务官的死路上:清除发生在叠还非空的时候。
   *   ② 用户点「回到窗位落点」(handleLeaveButler)——叠为空且选中事务官时,标签栏
   *      只剩「事务官」一格,没有别的标签可点着回去,那条按钮就是回去的路。
   *   ③ 页面刷新/组件重挂载——它不进 layout、不落盘,是纯运行态,跟 narrowForced
   *      同一条纪律:这是"这会儿在看什么"的投影,不是 Ben 的偏好。
   * 过渡态(dockUnknown)不清,轮询漏一拍不该把用户刚做的选择悄悄取消。
   *
   * **undefined = 他这一次还没选过**(2026-09-25,卡 feat/first-look-orb-top):那时按「引导走完没有」给默认 ——
   * 走完了就是事务官档(大球那一页),没走完(或这台服务没接引导)照旧是窗位落点。维护者:「最上面不应该是我
   * 精心制作的那张粒子球吗」「一打开中间是空的窗口槽,事务官缩成右下角一张小卡」—— 叠里一扇窗都没有的时候,
   * 一打开看见的该是她,不是一块空虚线框。
   */
  const [butlerPicked, setButlerPicked] = useState<boolean | undefined>(undefined)
  /**
   * 「要你看的」摊开到哪一张(2026-09-25,卡 M):点「事务官」标签上的气泡、或系统通知点回来时置一次,
   * 事务官那一档据此切过去、把那几张摊开。`at` 每次都变(同一张点两次也要再摊一次)。
   */
  const [focusAsk, setFocusAsk] = useState<{ key: string, at: number } | undefined>(undefined)
  // 齿轮弹窗(2026-08-25 版面重排):凭据与额度余额从组件条收进右上角弹窗。纯运行态的
  // "看不看设置",不进 layout——它不是布局偏好,是"这会儿要不要填个 Key"。
  const [settingsOpen, setSettingsOpen] = useState(false)
  /**
   * 设置弹窗这一次该开在**哪一节、哪一行**(2026-10-02,卡 QK)。
   *
   * 「读不到最新」那一格上那颗入口键(「去设置里配」)带着服务端声明的去处来 ——
   * 弹窗开在那一组、把那一行点亮。缺席 = 照老样子开在默认那一组(顶栏那颗齿轮、解锁卡那几颗键)。
   */
  const [settingsAt, setSettingsAt] = useState<QuotaStaleFix['at'] | undefined>(undefined)
  /**
   * 初始化页(2026-09-17 登录台)。两条进来的路:
   *   ① 地址栏 `?setup=1` / `#setup`(壳与浏览器共用);
   *   ② 顶栏那颗「初始化」。
   * 外加一条**自动**的:`/state.setup_required` 为真时自己打开一次(见下面那个 effect)。
   *
   * 纯运行态,不进 layout:它不是 Ben 的布局偏好,是"这台机器还没装好"。
   */
  const [setupOpen, setSetupOpen] = useState(() => setupRequestedIn(window.location.search, window.location.hash))
  /** 正在给哪家代写钩子(undefined = 没开框)。2026-09-17。 */
  const [hooksApplyFor, setHooksApplyFor] = useState<HooksAgent | undefined>(undefined)
  /** 「全部接上」那个框开着没有(2026-09-25:Claude、Codex 一次看、一次点)。 */
  const [connectAllOpen, setConnectAllOpen] = useState(false)
  /**
   * 本机账号(2026-09-17,决策记录「登录就是账号密码」)。三档:
   *   undefined         —— 还没问到(照旧显示工作台,不闪一屏登录);
   *   { enabled:false } —— 这台服务没接账号(老用例、展示台、手机都走这一支),照旧;
   *   { enabled:true }  —— 服务说了算:没登录就整屏换成登录屏。
   *
   * **只有确知"服务说要登录"才拦路** —— 因为一次网络抖动把 Ben 关在工作台外面,
   * 是这条路能犯的最糟的错(probeAccount 里那段注释是同一条纪律的另一半)。
   */
  const [account, setAccount] = useState<AccountProbe | undefined>(undefined)
  /** 问 /account 的次数:改完密码 / 退出登录之后 +1,重新问一遍。 */
  const [accountNonce, setAccountNonce] = useState(0)
  /**
   * 首次流程(引导入口)要不要出现。undefined = 还没问到 / 不适用。
   * 真相是 app.json 的 `first_run_done_at`,只在**登录之后**问一次。
   */
  const [firstRunNeeded, setFirstRunNeeded] = useState<boolean | undefined>(undefined)
  /**
   * 刚在登录屏上登进来(2026-09-24 去卡顿)。登录屏已经把最新的 /account 问回来了,直接用,不再问一遍;
   * 首次流程那面旗子问回来之前**先空着**,不把整块工作台先渲染一遍再换成引导屏 —— 那一下正好压在
   * 「黑洞粒子飞出来」的头几帧上,是维护者看到「先卡住」的原因之一。旗子问不回来最多空 3 秒。
   */
  const [justLoggedIn, setJustLoggedIn] = useState(false)
  useEffect(() => {
    if (!justLoggedIn) return
    const timer = setTimeout(() => setJustLoggedIn(false), 3000)
    return () => clearTimeout(timer)
  }, [justLoggedIn])
  /**
   * 纯净模式(2026-09-11)里"点过球、临时展开着事务官档"。纯运行态,不进 layout:它是
   * "这会儿看一眼",不是 Ben 的偏好——刷新回来仍是一颗球。切回完整模式时归零(见下方 effect)。
   */
  const [pureExpanded, setPureExpanded] = useState(false)
  /**
   * 选中的是哪个自定义模块(2026-09-21)。null = 没选,事务官那一档就是事务官本身。
   *
   * **为什么这一个记在客户端**:服务端那边两档长得一模一样 —— 点「事务官」与点一格
   * 自定义模块走的是同一条 `POST /dock/hide`(都是"把在台的原生窗藏起来"),
   * `dock.current` 都变 null,服务端分不出他要看哪一个。真正跨两端的那件事(窗藏没藏)
   * 照旧只在服务端;这里记的只是"这会儿在那块矩形上画什么",纯客户端的选择。
   * 与 butlerPicked 是同一条道理(见它的声明)。
   */
  const [activeModuleId, setActiveModuleId] = useState<string | null>(null)
  /**
   * 事务官档输入框的草稿(2026-09-10 起就在客户端持有,2026-09-11 从 SlotModule 提到这里):
   * 事务官档在两处渲染——窗位叠「事务官」那一档,与纯净模式整屏那一份——同一句没发出去的
   * 话在两处都得在。
   */
  const [butlerDraft, setButlerDraft] = useState('')
  /**
   * 「把光标送进事务官输入框」的计数器(2026-09-20「开发一个小工具」)。纯运行态,不进 layout——
   * 它是"刚刚按了那颗按钮"这一下,不是 Ben 的偏好。为什么是计数器不是布尔:见 ButlerInbox
   * 那个 prop 的注释(按第二次也要有反应)。
   */
  const [butlerDraftFocusAt, setButlerDraftFocusAt] = useState(0)

  // 槽体测量(S3):会话区点击贴合与窗口槽按钮点击贴合,量的是同一块槽体——
  // ref 提到 Workbench 这层持有,SlotZone 只负责把它挂在自己的槽体 div 上。
  const slotBodyRef = useRef<HTMLDivElement | null>(null)
  // S5(review,真机截图实证):上一次看到的 slot 模块 basis_pct——槽位矩形上报 effect
  // 靠它判定"这次上报是不是因为 slot 自己的高度真的变了"(变了才该带 reason:'resize'
  // 让服务端顺手把已经贴住的窗口挪过去;没变的话只是被动测量,不该挪窗)。
  // 2026-09-18:从 number 改成字符串签名——它比对的不再只是 slot 的 basis_pct 一个数字,
  // 还含方向与横屏底部一排的高度,见下面上报 effect 里 slotSignature 的注释。
  const slotBasisRef = useRef<string | undefined>(undefined)
  /**
   * 上一次**真的 POST 出去**那一份窗位矩形,当时壳窗口的视口尺寸
   * (2026-09-21 fix/slot-refit-on-orientation)。
   *
   * 根因在这里:原来"该不该让贴住的原生窗跟着挪"只看 slotBasisRef 那个签名(方向 +
   * 布局里那几个百分比),而**壳窗口自己变成了多大**根本不在签名里。壳窗口被拖到另一
   * 块屏时,WKWebView 的 resize 不是一拍到位——先来一拍「宽已经变了、高还没跟上」的中
   * 间尺寸(这一拍就足以把方向翻档:签名变了,带 reason 报出去的却是**中间态**那份矮
   * 矩形),最终尺寸那一拍方向没再翻、百分比也没动,签名一个字没变,于是只走 800ms 去
   * 抖那条被动路径、不带 reason——服务端把新矩形存下来了,却不会去动那扇已经贴住的窗。
   * 真机上的样子正是 Ben 说的「拉到竖屏之后应用窗口还是超出的」。
   *
   * 视口尺寸与 slot 的 basis 是**同一档信号**:都来自用户对窗口/布局的明确动作,不是
   * 页面内部的瞬态重排(S5 要防的正是后者——轮询漏一拍、WS 抖一下、标签栏冒出来,
   * 视口一个像素都不会动)。所以拿它当第二个"该挪窗"的凭证,S5 那条纪律并没有松口。
   */
  const slotViewportRef = useRef<string | undefined>(undefined)
  // S5:dock.stack 曾经非空过——配合下面的 stale 一起挡掉"过渡态快照"触发的被动上报
  // (轮询漏一拍/DSH 重启/WS 抖一下,dock 字段整个从响应里消失,不是变成空数组)。
  const dockEverAdoptedRef = useRef(false)
  // 稳定性门的挂起计时器(评审 2026-08-25:计时器生命周期不能挂在 effect cleanup 上)——
  // 上报 effect 的依赖含 layout/dockStackLen 这类高频变化值,持续拖拽任意模块把手时每次
  // pointermove 都会重跑 effect;计时器要是随 cleanup 一起清,门就被拖拽反复掐死重排,
  // 生命周期完全受制于跟它无关的依赖抖动。改持在跨 effect 存活的 ref 上,由上报管线
  // 自己管理:新的被动请求顶替旧门(用最新测量当基准)、reason:'resize' 显式上报取消它、
  // 过渡态早退分支取消它、组件卸载清它(见专门的卸载 effect)——cleanup 不再碰。
  const slotRectStabilityTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // 壳模式(spec W2)：工作台.app 的 WKWebView 用 ?ben-workbench=app 加载这个页面，
  // 那种场合下没有"返回对话"这一说——DSH 的对话界面压根不在这个壳里。
  const shellMode = inShellApp(window.location.search, window.location.hash)
  // 工作台这一层挂上了 → 告诉壳揭开它自己的加载占位(盖住上游的「Loading plugins…」,见 shell.ts)。
  useEffect(() => { if (shellMode) notifyShellReady(window) }, [shellMode])
  // 视觉 A 的暗亮令牌挂在 <html data-theme>,跟着宿主的明暗走(tokens.ts)。
  useEffect(() => syncRootTheme(document), [])
  // 文件拖放归工作台(2026-09-25):浮层开着时,拖进来的文件不让压在下面的 DSH 对话栏截走
  // (它会整屏盖「当前无法添加图片」并让输入框收不到)。浮层一关就拆,DSH 原生页照常拖图。见 fileDropGuard.ts。
  useEffect(() => (state.open ? installFileDropGuard(document) : undefined), [state.open])

  /**
   * 方向(2026-09-18 横屏布局)。量的是视口——`.ben-wb` 在 style.ts 里是
   * `position:absolute;inset:0`,它铺满的正是视口,两者按构造相等;为什么特意不去量
   * 那个元素,见 orientation.ts 的 measureOrientationBox 注释(踩过一次真的坑)。
   *
   * 拖到另一块屏上不需要刷新:window resize 一来就重判,翻档那一帧整棵树按新方向重排。
   * 壳那边不用配合——它只负责把窗口摆到新屏上,新屏多宽多高由这里自己量。
   */
  const orientation = useOrientation()
  const landscape = orientation === 'landscape'

  const feed = useWorkbenchState({
    ...(serviceBaseUrl === undefined ? {} : { baseUrl: serviceBaseUrl }),
    ...(serviceFetch === undefined ? {} : { fetchImpl: serviceFetch }),
    ...(servicePollMs === undefined ? {} : { pollMs: servicePollMs }),
  })
  // 用户层(2026-10-21):/state.user_layer 里列了哪几格、什么指纹,就去取哪几份代码装上。
  const layer = userLayer ?? userLayerRegistry
  useUserLayerSync(layer, feed.state.user_layer, feed.baseUrl, serviceFetch ?? fetch)
  // 当前模板那一层皮肤(2026-10-23,分层二刀二):来自用户层 `布局/<id>.json` 声明的 .css,
  // 本体不再内置;没有皮肤就什么都不注入。位置照旧:STYLE 之后、__inner 之前。
  const userLayerSkin = useUserLayerSkin(feed.state.user_layer, feed.state.template?.id, feed.baseUrl, serviceFetch ?? fetch)

  // 弹层让开窗位(2026-09-11):几处弹层(设置/任务卡/日结/事务官浮窗)打开时
  // POST /dock/veil 让窗位里的原生窗让开,关闭时回来。**只在壳里**——浏览器里开的工作台
  // 页面没有原生窗盖着弹层,发了只会平白把壳那边的窗藏掉(同 /slot/rect 只认壳内页面的纪律)。
  // "窗位此刻在页面上的矩形"——量的正是 /slot/rect 上报用的那个槽体元素。事务官浮窗拿它判相交;
  // 弹层盖住窗位(2026-09-14)拿它定位。窗位收起(SlotModule 不挂载,ref 为空)或纯净模式
  // (.ben-wb__body display:none,量出 0 矩形)时返回的矩形没面积,dialogCoverStyle 会当没矩形处理。
  const measureSlotRect = useCallback((): RectLike | undefined => {
    const el = slotBodyRef.current
    if (el === null) return undefined
    const r = el.getBoundingClientRect()
    return { x: r.left, y: r.top, w: r.width, h: r.height }
  }, [])
  const veilTarget = useMemo<VeilTarget | undefined>(
    () => (shellMode
      ? { baseUrl: feed.baseUrl, ...(serviceFetch === undefined ? {} : { fetchImpl: serviceFetch }), slotRect: measureSlotRect }
      : undefined),
    [shellMode, feed.baseUrl, serviceFetch, measureSlotRect],
  )
  const veilProp = veilTarget === undefined ? {} : { veil: veilTarget }
  const butlerVeil = useMemo(
    () => (veilTarget === undefined ? undefined : { target: veilTarget, slotRect: measureSlotRect }),
    [veilTarget, measureSlotRect],
  )

  // 悬停高亮 v1:页面本体走 1s 轮询(useWorkbenchState),拖拽悬停这种实时反馈轮询做不了——
  // 单开一条轻量 WS 订 /live 上服务端转广播的 hover 事件,只认 kind==='hover',别的 kind
  // (snapshot/event/ring/call/ping)原样忽略,不重复实现一遍 useWorkbenchState 的职责。
  //
  // **断了就一直重连(2026-09-25 改)**:以前「整个挂载期只重试一次」。壳里这一页一开就是好几天,
  // 而 DSH 同版本重启(引导里认新凭证那一下、kickstart)壳不刷新页面 —— 头一次断、3 秒后重试时 DSH 还没起来,
  // 第二次断之后这条连接就永远没了,之后拖窗进槽一点光都没有(维护者 09-24 晚:「拖拽进窗口槽的光效呢」)。
  // 现在 3 秒起、每次翻倍、封顶 15 秒一直重试;连上收到过消息就把间隔拨回 3 秒。一条本机 WS,代价可以忽略。
  useEffect(() => {
    let alive = true
    let attempt = 0
    let socket: MinimalWebSocket | undefined
    let retryTimer: ReturnType<typeof setTimeout> | undefined
    let flashTimer: ReturnType<typeof setTimeout> | undefined

    const open = (): void => {
      if (!alive) return
      const wsUrl = `${feed.baseUrl.replace(/^http/, 'ws')}/live`
      // as unknown as MinimalWebSocket:真实 WebSocket 的 onmessage/onclose/close 结构上
      // 天然满足这个窄接口(多出来的 readyState 等成员本组件不用),这里只是把类型收窄。
      const make = serviceWebSocket ?? ((url: string) => new WebSocket(url) as unknown as MinimalWebSocket)
      const ws = make(wsUrl)
      socket = ws
      ws.onmessage = (event) => {
        if (!alive) return
        let msg: unknown
        try {
          msg = JSON.parse(String(event.data))
        }
        catch {
          return
        }
        if (typeof msg !== 'object' || msg === null) return
        attempt = 0 // 收得到消息 = 这条是活的,下次断了从 3 秒重来
        const record = msg as Record<string, unknown>
        // 他点了系统通知「事务官有话问你」(2026-09-25,卡 M):壳把他带回前台,这里切到事务官那一档、摊开那一张。
        if (record.kind === 'focus_ask' && typeof record.key === 'string') { setFocusAsk({ key: record.key, at: Date.now() }); return }
        // 事务官动了哪一块(卡 P 补三):挂一行字,同一块再来一条就续上。
        if (record.kind === 'actor_note') {
          const note = record.note
          if (isActorNote(note)) setActorNotes(list => addActorNote(list, note, Date.now()))
          return
        }
        if (record.kind === 'actor_note_clear') { setActorNotes([]); return }
        if (record.kind === 'presence' && typeof record.presence === 'object' && record.presence !== null) {
          const one = record.presence as CollabPresence
          const key = (p: CollabPresence): string => (p.actor.kind === 'agent' ? `agent:${p.actor.id}` : `member:${p.actor.account}`)
          setCollabPresence(list => [...list.filter(other => key(other) !== key(one)), one])
          return
        }
        if (record.kind === 'slot_drop') {
          // 真拖进一个新应用、放手那一下(卡 P):光只绑这个动作。原生那圈亮了就不画自己那圈。
          if (record.native === true) return
          if (flashTimer !== undefined) clearTimeout(flashTimer)
          setDropFlash(true)
          flashTimer = setTimeout(() => { flashTimer = undefined; setDropFlash(false) }, DROP_FLASH_MS)
          return
        }
        if (record.kind !== 'hover') return // 别的 kind 不归这条连接管
        // 悬停只亮那句「松手认领到窗位」,不亮光(卡 P)。
        if (typeof record.inside === 'boolean') setDropHover(record.inside)
      }
      ws.onclose = () => {
        if (!alive) return
        // 断线那一刻若正悬停着,提示也跟着收:收不到「出圈」就别让它一直挂在槽上。重连本身不亮光(卡 P)。
        setDropHover(false)
        const delay = Math.min(HOVER_WS_RETRY_MAX_MS, HOVER_WS_RETRY_MS * 2 ** attempt)
        attempt += 1
        retryTimer = setTimeout(open, delay)
      }
    }
    open()

    return () => {
      alive = false
      if (retryTimer !== undefined) clearTimeout(retryTimer)
      if (flashTimer !== undefined) clearTimeout(flashTimer)
      socket?.close()
    }
  }, [feed.baseUrl, serviceWebSocket])

  // 那几行字到点就收(最早到点的那一条到了就收一次;还有别的再排下一次)。
  useEffect(() => {
    if (actorNotes.length === 0) return undefined
    const wait = Math.max(0, Math.min(...actorNotes.map(one => one.until)) - Date.now())
    const timer = setTimeout(() => setActorNotes(list => liveActorNotes(list, Date.now())), wait + 1)
    return () => clearTimeout(timer)
  }, [actorNotes])

  // 布局是用户数据（spec D12）：本地立即应用，800ms 静默后再落盘。layoutDirtyRef 只在
  // 用户真的点了操作按钮之后才置 true——服务端第一次把 layout 推回来时（下面那个
  // effect）不算"用户编辑"，不然一开局就会把刚读回来的东西原样 POST 回去一次。
  const [layout, setLayout] = useState<WorkbenchLayout>(() => DEFAULT_LAYOUT)
  const layoutInitRef = useRef(false)
  const layoutDirtyRef = useRef(false)
  /**
   * 永远指向**最新一次渲染**的 layout(2026-10-28,「开/收只认用户动作」那一条要用):
   * 事件回调闭包手里的 `layout` 可能过期,而"展开/收起要不要动"必须按最新值判——
   * 拿过期快照判,一次 expand 意图会被看成"还是收起态"而连发两次(连点)或翻错向。
   * 在渲染期同步(不是 effect 里):回调永远跑在某次渲染之后,渲染期赋值保证它读到的
   * 就是那一刻的当前值,不依赖被动 effect 何时刷。
   */
  const layoutRef = useRef<WorkbenchLayout>(layout)
  layoutRef.current = layout
  // S2(a)(review,真机截图实证):layoutReady 用 state(不是 ref)记录"布局初始化是否
  // 已经落定"——只在 feed.loaded(第一次真的问过服务)之后才翻一次,而且跟 setLayout
  // 是同一个 effect 回调里连着调用的两个 setState,React 会把它们批进同一次 re-render:
  // 依赖 layoutReady 的下游 effect(槽位矩形上报)看到它变 true 的那次渲染,layout 本身
  // 保证已经同步套上了服务端真实值(如果有的话),不会有"ready 已经真、layout 还是旧值"
  // 这种中间态被抢跑到——这正是原来只用 layoutInitRef(纯 ref,跟 setLayout 之间隔着一次
  // 异步 re-render)会漏掉的那道缝:某个跟 layout 无关的依赖项(比如认领冒出的标签栏
  // 改了 dockStackLen)如果恰好在 ref 已经翻真、但 setLayout 还没真正生效的那个commit
  // 触发下游 effect,量出来的仍是本地默认布局的几何值,报一次是浪费的,之后 layout 真的
  // 套上时还会再报一次真实值——两次上报之间那个"错的"就是真机上窗口跳一下的另一个成因。
  const [layoutReady, setLayoutReady] = useState(false)

  /**
   * 「服务端那份布局变了要不要跟」这件事的三块记账(2026-09-27,卡 TM;2026-10-28
   * 起记对象不比文本,见 layoutAdopt.ts 文件头「按内容判」那一节)。
   *
   * 修之前这里只有 `layoutInitRef`:第一次读一次 `/state.layout`,之后每秒轮询回来的
   * 布局一律丢掉 —— 于是**在设置里切模板压根看不见界面换过去**(维护者 09-27 原话),
   * 而且他随手拖一下模块,防抖一到就把手里那份**旧**布局 POST 回去,把刚切好的模板覆盖掉。
   * 判据是纯函数 `decideLayoutAdopt`,为什么这么判见 `layoutAdopt.ts` 的文件头。
   */
  /** 上一拍从服务端看到的那一份(解析后的对象)。 */
  const serverLayoutRef = useRef<unknown | null>(null)
  /**
   * 我们自己最后 POST 出去的那一份(服务端下一拍把它回声回来,别当成"别人改了")。
   * 存的是 POST 那一刻的 layout 对象;比的时候是**内容**(键序不敏感),因为服务端
   * parseLayout 会按自己的字段顺序重建布局——文本比对自己的回声都认不出来。
   */
  const postedLayoutRef = useRef<unknown | null>(null)
  /** 本地改了还没落盘(防抖窗口里):这一段不许被服务端那份盖回去。 */
  const pendingLayoutRef = useRef(false)

  useEffect(() => {
    if (!feed.loaded) return
    const incoming = feed.state.layout
    if (incoming === undefined) {
      // 服务端没给布局(项目区没接线):照旧只翻一次 ready,本地默认布局就是全部。
      if (!layoutInitRef.current) { layoutInitRef.current = true; setLayoutReady(true) }
      return
    }
    const decision = decideLayoutAdopt({
      incoming,
      seen: serverLayoutRef.current,
      posted: postedLayoutRef.current,
      pendingLocal: pendingLayoutRef.current,
      initialized: layoutInitRef.current,
    })
    serverLayoutRef.current = incoming
    if (decision === 'keep') return
    // init 与 adopt 做的是同一件事(套上服务端那份);分开只为让判据能被用例逐条钉住。
    // setLayout 不碰 layoutDirtyRef —— 服务端推过来的不算"用户编辑",不该被 POST 回去。
    setLayout(incoming)
    if (decision === 'init') { layoutInitRef.current = true; setLayoutReady(true) }
  }, [feed.loaded, feed.state.layout])

  useEffect(() => {
    if (!layoutDirtyRef.current) return
    const fetchImpl = serviceFetch ?? fetch
    const timer = setTimeout(() => {
      // 记下我们送出去的那份:下一拍服务端把它(净化/重排键序后)回声回来时,
      // 按内容认得出是自己刚发的,不能当成"别人改了布局"而原样套回 state ——
      // 那会让他刚拖的那一下跳一下。
      postedLayoutRef.current = layout
      pendingLayoutRef.current = false
      void postSilently(`${feed.baseUrl}/layout`, { layout }, fetchImpl)
    }, LAYOUT_SAVE_DEBOUNCE_MS)
    return () => clearTimeout(timer)
  }, [layout, feed.baseUrl, serviceFetch])

  const applyLayout = (next: WorkbenchLayout) => {
    layoutDirtyRef.current = true
    pendingLayoutRef.current = true
    setLayout(next)
  }

  // 底边拖拽调高(模块盒子化 W-B)：moduleBodyRef 量的是模块列自己的盒子(.ben-wb__body,
  // 跟槽体测量用的 slotBodyRef 是两回事)——Δpct 要按它的高度换算,不是按被拖模块自己
  // 的高度(拖之前模块自己的高度正是要被改的那个值,拿它当分母会越拖越失真)。
  // resizeDragRef 存拖拽起点:pointermove 每次都拿"起点布局 + 累计 Δpct"算新值,不是
  // 链式叠加上一次 move 算出的中间态——避免 React 状态异步更新带来的抖动/漂移。
  const moduleBodyRef = useRef<HTMLDivElement | null>(null)
  useWidgetReorder(moduleBodyRef, layout, orientation, applyLayout)
  /**
   * 横屏上半那一条(左栏 + 中区 + 右栏)。两个用途,都只读几何、不改任何东西:
   * ① 拖左栏那根把手时算 Δ 的分母(把手自己的 parentElement 就是它,这个 ref 是给 ② 用的);
   * ② 事务官浮窗的横屏默认落点——浮窗要落在这一条的底边之上,也就是底部四格之上。
   */
  const landBandRef = useRef<HTMLDivElement | null>(null)
  const resizeDragRef = useRef<{
    id: string
    pointerId: number
    startY: number
    startLayout: WorkbenchLayout
  } | null>(null)
  // 抓手拖拽态(真机反馈:抓手原来完全不可见,Ben 找不到"为什么还没实现"):只在
  // pointerdown/up 各触发一次 state 更新(不是每次 move 都更新,那样会拖慢拖拽本身)——
  // 纯粹为了驱动 CSS `[data-dragging=true]` 变色,不参与拖拽换算(换算仍然全靠上面
  // 那个不触发渲染的 ref)。
  const [draggingModuleId, setDraggingModuleId] = useState<string | null>(null)

  /**
   * 分栏把手的拖拽(竖屏顶部那对分栏 + 横屏四条边界)。和高度拖拽同一套手法:
   * 换算全靠不触发渲染的 ref,只有 pointerdown/up 各更新一次 state 驱动变色。
   *
   * `kind` 是 2026-09-18「横屏每条边界都要有把手」加的——**四条边界改的不是同一个数**
   * (左栏宽度 / 中区右栏占比 / 底部一排高度 / 底部两格之间占比),但它们的手感、热区、
   * 视觉、落盘路径必须完全一样。所以分叉只落在"这一帧把 Δ 交给哪个纯函数"这一句上,
   * 其余(捕获指针、算分母、applyLayout 去抖落盘、松手清态)四条共用同一段代码。
   * 缺省 'width-pair' —— 竖屏那两处调用点一个字没改。
   */
  type SplitKind = 'width-pair' | 'rail' | 'deck-height' | 'deck-pair' | 'side-pair'
  const widthDragRef = useRef<{
    kind: SplitKind
    leftId: string
    rightId: string
    pointerId: number
    startX: number
    startY: number
    /** 'rail' 专用:按下这一刻左栏占整条上半区的百分比(量真实几何得来,见下)。 */
    startPct: number
    startLayout: WorkbenchLayout
  } | null>(null)
  /** 正在拖的是哪一根(竖屏按左模块 id,横屏四条各有自己的 key)。 */
  const [draggingSplitId, setDraggingSplitId] = useState<string | null>(null)

  const handleSplitResizeStart = (
    event: ReactPointerEvent<HTMLDivElement>,
    leftId: string,
    rightId: string,
    kind: SplitKind = 'width-pair',
    // 这一根把手的 key(只用来驱动"哪一根正在变色")。缺省就是左边那个模块 id ——
    // 竖屏与横屏上半那两根天生唯一。底部一排要显式传:那三根按左格 id 区分,而左格 id
    // 同时还是 resizeLandscapeDeckPair 的参数,两个用途混用一个字段迟早出事。
    dragKey: string = leftId,
  ): void => {
    event.preventDefault()
    event.currentTarget.setPointerCapture?.(event.pointerId)
    // 左栏那根的起点:**量真实几何**,不从存档读——它缺席时的含义是"定死 168px"
    // (protocol.ts LandscapeLayout.rail_pct),没有百分比可读。按住不动松手时左栏不该跳,
    // 所以起点必须等于此刻屏幕上真实的那个宽度。量不到(jsdom / 还没排版)才退回常量。
    let startPct = LANDSCAPE_RAIL_FALLBACK_PCT
    if (kind === 'rail') {
      const stored = landscapeRailPct(layout)
      const band = event.currentTarget.parentElement
      const bandWidth = band?.getBoundingClientRect().width ?? 0
      const railWidth = band?.querySelector('.ben-wb__land-rail')?.getBoundingClientRect().width ?? 0
      startPct = bandWidth > 0 && railWidth > 0
        ? (railWidth / bandWidth) * 100
        : (stored ?? LANDSCAPE_RAIL_FALLBACK_PCT)
    }
    widthDragRef.current = {
      kind,
      leftId,
      rightId,
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      startPct,
      startLayout: layout,
    }
    setDraggingSplitId(dragKey)
  }

  const handleSplitResizeMove = (event: ReactPointerEvent<HTMLDivElement>): void => {
    const drag = widthDragRef.current
    if (drag === null || drag.pointerId !== event.pointerId) return
    // 上下那根(主区 | 底部一排)的分母是整块模块区的高度——跟模块盒子底边那根抓手
    // 用的是同一个分母(moduleBodyRef),两条路拖同一个数时手感才对得上。
    if (drag.kind === 'deck-height') {
      const containerHeight = moduleBodyRef.current?.getBoundingClientRect().height
      if (containerHeight === undefined || containerHeight <= 0) return
      const deltaPct = ((event.clientY - drag.startY) / containerHeight) * 100
      applyLayout(resizeLandscapeDeck(drag.startLayout, deltaPct))
      return
    }
    // 右侧栏里上下两格之间那根(2026-09-20):分母是**右侧栏自己**那一条的高度,不是整块
    // 模块区——它只在这一栏里倒腾。算出来的 Δ 还要乘上这一栏 grow 之和再除以 100:
    // side_pct 是 flex-grow,几个数之比才是高度之比,和不一定是 100(项目区 50 + 一格 25
    // = 75),直接把"挪了百分之几"当 grow 加会比手上慢一截。
    if (drag.kind === 'side-pair') {
      const colHeight = event.currentTarget.parentElement?.getBoundingClientRect().height
      if (colHeight === undefined || colHeight <= 0) return
      const deltaPct = ((event.clientY - drag.startY) / colHeight) * 100
      const total = landscapeSideTotal(drag.startLayout)
      applyLayout(resizeLandscapeSidePair(drag.startLayout, drag.leftId, drag.rightId, deltaPct * total / 100))
      return
    }
    // 左右三根的分母是把手所在那条容器的宽度:Δpx / 容器宽 = Δ百分比。
    const rowWidth = event.currentTarget.parentElement?.getBoundingClientRect().width
    if (rowWidth === undefined || rowWidth <= 0) return
    const deltaPct = ((event.clientX - drag.startX) / rowWidth) * 100
    if (drag.kind === 'rail') {
      applyLayout(setLandscapeRailPct(drag.startLayout, drag.startPct + deltaPct))
      return
    }
    if (drag.kind === 'deck-pair') {
      applyLayout(resizeLandscapeDeckPair(drag.startLayout, drag.leftId, drag.rightId, deltaPct))
      return
    }
    applyLayout(resizeRowPair(drag.startLayout, drag.leftId, drag.rightId, deltaPct, orientation))
  }

  const handleSplitResizeEnd = (event: ReactPointerEvent<HTMLDivElement>): void => {
    const drag = widthDragRef.current
    if (drag === null || drag.pointerId !== event.pointerId) return
    widthDragRef.current = null
    setDraggingSplitId(null)
  }

  const handleModuleResizeStart = (event: ReactPointerEvent<HTMLDivElement>, moduleId: string): void => {
    event.preventDefault()
    // jsdom 没有 setPointerCapture(真实浏览器才有)，可选调用——测试环境静默跳过,
    // 不影响拖拽逻辑本身(逻辑只依赖 pointerId 匹配,不依赖 capture 是否真的生效)。
    event.currentTarget.setPointerCapture?.(event.pointerId)
    resizeDragRef.current = { id: moduleId, pointerId: event.pointerId, startY: event.clientY, startLayout: layout }
    setDraggingModuleId(moduleId)
  }

  const handleModuleResizeMove = (event: ReactPointerEvent<HTMLDivElement>): void => {
    const drag = resizeDragRef.current
    if (drag === null || drag.pointerId !== event.pointerId) return
    // 2026-09-20:模块被挪进右侧栏之后,它底边那根抓手改的是**这一栏里的上下占比**,
    // 不再是底部一排的高度(底部一排里已经没有它了)。分母跟着换成右侧栏那一条的高度,
    // 换算与那根横把手逐字相同——同一条边界,从哪根抓手拖手感都得一样。
    if (landscape) {
      const sideColumn = landscapeArrangement(drag.startLayout).side
        .filter(module => visibleModules.some(m => m.id === module.id))
      const sideIndex = sideColumn.findIndex(module => module.id === drag.id)
      if (sideIndex !== -1) {
        const below = sideColumn[sideIndex + 1]
        const column = event.currentTarget.closest('.ben-wb__land-side')?.getBoundingClientRect().height
        if (column === undefined || column <= 0) return
        const sideDelta = ((event.clientY - drag.startY) / column) * 100
        // 最下那一格的底边就是「主区 | 底部一排」那条边界:往下拖 = 底部变矮
        // (同中间那两块底边的既有规则,取负号)。
        if (below === undefined) {
          const bodyHeight = moduleBodyRef.current?.getBoundingClientRect().height
          if (bodyHeight === undefined || bodyHeight <= 0) return
          applyLayout(resizeLandscapeDeck(drag.startLayout, -((event.clientY - drag.startY) / bodyHeight) * 100))
          return
        }
        const total = landscapeSideTotal(drag.startLayout)
        applyLayout(resizeLandscapeSidePair(drag.startLayout, drag.id, below.id, sideDelta * total / 100))
        return
      }
    }
    const containerHeight = moduleBodyRef.current?.getBoundingClientRect().height
    if (containerHeight === undefined || containerHeight <= 0) return
    const deltaPct = ((event.clientY - drag.startY) / containerHeight) * 100
    // 横屏(2026-09-18):整块模块区只有**一个**可拖的高度——底部那一排多高
    // (中间大条 = 100 - 它,不另存一份,见 layout.ts DEFAULT_LANDSCAPE_MODULES 的注释)。
    // 所以拖中间两块(窗位槽 / 项目区)的底边 = 反向拖底部一排;拖底部任一格的底边 =
    // 正向拖底部一排,四格一起改,不会拖出参差。竖屏那条路径一个字没动。
    if (landscape) {
      const deck = (LANDSCAPE_DECK_IDS as readonly string[]).includes(drag.id)
      const band = (LANDSCAPE_BAND_IDS as readonly string[]).includes(drag.id)
      if (!deck && !band) return
      applyLayout(resizeLandscapeDeck(drag.startLayout, deck ? deltaPct : -deltaPct))
      return
    }
    applyLayout(resizeModule(drag.startLayout, drag.id, deltaPct))
  }

  const handleModuleResizeEnd = (event: ReactPointerEvent<HTMLDivElement>): void => {
    const drag = resizeDragRef.current
    if (drag === null || drag.pointerId !== event.pointerId) return
    resizeDragRef.current = null
    setDraggingModuleId(null)
    // S5(review,真机截图实证):拖高抓手松手是一次明确的用户动作——如果拖的是窗位
    // 模块自己的高度,松手这一刻额外补发一次带 reason:'resize' 的矩形上报,确保
    // 贴合的窗口跟着停在手上最终定格的尺寸上。下面槽位矩形上报那个 effect 也会在
    // layout(slot 的 basis_pct)变化时顺带打上 reason(拖拽过程中的每一帧都会,松手
    // 只是最后一帧),这里是给"最终定格"补的一道显式保险,不依赖那条被动路径覆盖到。
    // 真机实证(2026-08-25 矩形上报只认壳内页面):浏览器里随手开的工作台标签也会走到
    // 这条松手补发路径,但它的视口矩形对壳所在屏幕的贴合几何毫无意义——不在壳内就整个
    // 不发,不是"发了也没用"而是"发了就是错的、会覆盖壳内页面刚报的真值"。
    if (drag.id === 'slot' && shellMode) {
      const el = slotBodyRef.current
      if (el !== null) {
        const r = el.getBoundingClientRect()
        const fetchImpl = serviceFetch ?? fetch
        void postSilently(
          `${feed.baseUrl}/slot/rect`,
          { rect: { x: r.x, y: r.y, w: r.width, h: r.height }, reason: 'resize', source: 'app' },
          fetchImpl,
        )
      }
    }
  }

  // 未知 id 直接丢弃而不是让渲染崩掉：服务端校验只保证 shape，不保证 id 在这四个
  // 之内（D13 的降级纪律同样适用于这里——认不出就不显示，不能让整块界面挂掉）。
  /**
   * 当前方向那一份模块排布(2026-09-18 横屏布局)。横竖各存一份,**这一行是整个分叉的
   * 唯一入口**——下面 sortedModules / visibleModules / moduleRows / 收起判定全部从它派生,
   * 没有第二处再去读 layout.modules,所以不存在"某一处忘了分叉"的缝。
   */
  const activeModules = useMemo(() => branchModules(layout, orientation), [layout, orientation])
  const sortedModules = useMemo(
    () => [...activeModules]
      .filter(module => (MODULE_IDS as readonly string[]).includes(module.id))
      .sort((left, right) => left.order - right.order),
    [activeModules],
  )
  const visibleModules = useMemo(() => sortedModules.filter(module => module.hidden !== true), [sortedModules])
  const visibleModuleIds = useMemo(() => new Set(visibleModules.map(module => module.id)), [visibleModules])

  /**
   * 分组成 行 → 列 → 模块(两层)。
   *
   * 行:**只合并"排序后相邻"且 row 相同的模块**,不按 row 值全局归并——否则 order 与
   * row 会打架:上移/下移换的是 order,若分组只看 row,把别的模块挪进这一对中间时
   * 它俩仍会被并回同一行,界面上"上移了却没动"(真机实证)。按相邻分组,挪进来就自然拆开。
   *
   * 列(2026-08-25 右侧上下堆叠):行内再按相邻且 col 相同合并成**竖向一列**。
   * 这样右边一列可以上下堆两个模块(消耗数据 / 余额),左边项目区独占一列。
   *
   * row / col 缺省的模块永不参与合并,各自独占——旧存档读进来与从前逐帧一致。
   */
  // 分组规则与服务端布局快照**同一份**(src/layoutRows.ts;卡 P 补三并掉了两份抄本)。
  const moduleRows = useMemo(() => groupLayoutRows(visibleModules), [visibleModules])
  const hiddenModules = useMemo(() => sortedModules.filter(module => module.hidden === true), [sortedModules])
  /**
   * 纯净模式(2026-09-11,layout.pureMode):整屏只有顶栏与一颗球,所有模块只是不显示、不卸载。
   * 缺省 false——旧存档读进来即完整工作台。
   */
  const pureMode = layout.pureMode === true
  // 纯净模式下窗口槽不显示,**壳的窗位贴合必须停**——槽体 display:none 之后量出来的是 0 矩形,
  // 拿它贴窗等于把 App 窗口摆到一块不存在的区域上。所以"纯净"对贴合来说就是"窗口槽收起":
  // 下面 /unsnap 与 {rect:null} 那两个 effect 都按 slotHidden 走,切回完整时上报 effect 会
  // 用新量出的矩形自动覆盖(同模块从收起恢复可见那条路)。
  const slotModuleHidden = activeModules.find(module => module.id === 'slot')?.hidden === true
  const slotHidden = slotModuleHidden || pureMode
  // 真机验收实测兜底触发:标签栏(dock.stack 变长)、场景条(scenes 变长)冒出来会把槶体
  // 往下挤,但那不是 window resize——ResizeObserver 本该已经抓住这类变化了,这两个数字
  // 是 jsdom 没有 ResizeObserver 时仍然可测的一条后备路径,不是绕开 ResizeObserver 的主路。
  const dockStackLen = feed.state.dock?.stack.length ?? 0
  const scenesLen = feed.state.scenes?.length ?? 0
  // W4:「事务官」是否选中 = 叠上没有任何窗在台前。
  //
  // 过渡态一律不翻转(与下方 I3/S5 那条 effect 同一条纪律):轮询漏一拍退回
  // offlineState、DSH 重启、WS 抖一下,都会让 dock 整个字段从快照里消失——那只说明
  // 「这一拍不知道」,不说明「没有窗在台前」。这种时候维持上一次的已知判断:翻成真会
  // 让槽体卸载、iframe 挂上、矩形被清,可那扇原生窗还贴在屏幕上没动;翻成假则会在用户
  // 正看着对话页时闪出槽体。两个方向都是闪烁,所以不猜,沿用上一次。
  //
  // 注意区分两种 dock 缺省:从没认领过(dockEverAdoptedRef 为 false)= dockService
  // 压根没接,那是真的「没有窗会盖住 iframe」,该判真;认领过之后才消失的才是过渡态。
  //
  // 放在这里(早于下面几个 effect)是因为窗位矩形失效(I3)那个 effect 的依赖数组要
  // 用到它。渲染期写 ref 在这里是安全的——它只是个"上一次已知值"的缓存,不驱动别的
  // 组件、不产生副作用,不是渲染期副作用那类反模式。
  const dockUnknown = feed.state.stale || (dockEverAdoptedRef.current && feed.state.dock === undefined)
  // I1(review):初值 false,不是 true。挂载第一拍(offlineState 自带 stale:true)
  // dockUnknown 必为真,这时候沿用值其实是一次"猜测"——根本没有真正的"上一次已知值"
  // 可沿用。猜错的两个方向代价不对等:猜 false 最多是先画一个空槽体、下一拍换成
  // iframe(廉价);猜 true 是让浏览器白白开始加载整份同源 DSH 应用(内嵌 iframe),
  // 等第一份快照回来(真机上 dock.json 持久化,常见就是有窗 current)才整个销毁——
  // 昂贵,而且真机上多数时候都猜错。两害相权,初值定为 false。
  const butlerActiveRef = useRef(false)

  // C1(整分支终审,合并前必修):**叠里一个成员都没有**这一档必须单独拿出来判。
  //
  // 空数组的 `.every()` 恒为真,所以老公式在 `stack: []` 上会算出 butlerActive=true:
  // 槽体整个不挂载、I3 那条 effect 再把服务端矩形清成 null。而"把窗拖进
  // `.ben-wb__slot-body`"是认领第一扇窗的**唯一**入口(dock.ts handleMoved 在
  // screenRect===undefined 时早退),slotRect 又是纯内存变量、重启即失效——于是
  // 全新安装(dock.json 还没成员)和"点 ✕ 放出最后一个应用"这两条常规路径会走进
  // 一条谁也出不来的死路:标签栏只剩「事务官」一格,没有任何操作能把 butlerActive
  // 扳回假,连"窗位矩形未上报"那句 note 都看不见(它渲染在没挂载的槽体内部)。
  //
  // 三档分开:
  //   dock 缺省      = dockService 压根没接线,窗位叠这个能力整个不存在,没有落点
  //                    可言,事务官占满是对的(既有行为,不动)。
  //   stack 非空     = 服务端能表达"事务官被选中"(current===null,只可能来自 hideCurrent
  //                    或放出当前那扇窗),照旧读服务端,客户端不另存一份。
  //   stack 为空     = 服务端表达不了——current 恒为 null,不管用户选没选事务官。这一档
  //                    读下面的客户端状态 butlerPicked。
  const dockEmpty = feed.state.dock !== undefined && feed.state.dock.stack.length === 0
  const onboardingDone = feed.state.onboarding?.done === true
  const butlerActive = dockUnknown
    ? butlerActiveRef.current
    : dockEmpty
      ? (butlerPicked ?? onboardingDone)
      : (feed.state.dock === undefined || feed.state.dock.stack.every(tab => !tab.current))
  if (!dockUnknown) butlerActiveRef.current = butlerActive

  /**
   * 自定义模块清单与"这会儿真的选中了哪一个"(2026-09-21)。
   *
   * `moduleActive` **挂在 butlerActive 上**,不是另一个独立开关:两档走的是同一条
   * `/dock/hide`,所以"有原生窗在台前"这件事对它们是同一个否决权 —— 用户点了某个应用
   * 标签,butlerActive 翻假,自定义模块那块 iframe 也该同时让开(它盖的正是那扇窗要贴的
   * 矩形)。写成两个各自为政的开关,迟早出现"窗在台前、iframe 还盖着"。
   *
   * 选中的那个模块**已经不在清单里了**(刚被移除 / DSH 把目录挪走了)也要退回事务官档:
   * 一块指向不存在模块的 iframe 就是一片白。
   */
  const customModules = feed.state.modules ?? []
  /** 协作区那一格(2026-10-21):接了任务账才有;它是本体的一格,永远不算「不在清单里了」。 */
  const collabOn = feed.state.tasks !== undefined
  const activeModuleGone = activeModuleId !== null
    && !customModules.some(module => module.id === activeModuleId)
  const moduleActive = butlerActive && activeModuleId !== null && !activeModuleGone
  // 清单里没有它了就把选中态就地清掉,免得下次再点「事务官」时它又冒出来。
  useEffect(() => {
    if (activeModuleGone) setActiveModuleId(null)
  }, [activeModuleGone])

  // C1:叠一旦有了成员,butlerPicked 就失去意义(那一档的真相回到服务端),就地清掉——
  // 见上面 butlerPicked 声明处对"何时清除"的完整说明。只在**确知**叠非空时清,
  // dockUnknown 的过渡态不动它(否则轮询漏一拍就会把用户刚点的「事务官」悄悄取消)。
  const dockHasMembers = !dockUnknown && (feed.state.dock?.stack.length ?? 0) > 0
  useEffect(() => {
    if (dockHasMembers) setButlerPicked(false)
  }, [dockHasMembers])

  // S5(review,真机截图实证):记一下"dock.stack 曾经非空过"——只增不减(一旦真的认领过
  // 什么,这个标记就一直是 true),下面的槽位矩形上报 effect 拿它识别"这一拍 dock 字段
  // 整个从响应里消失了(不是变成空数组),八成是过渡态快照"这种情况。放单独一个 effect
  // 而不是在渲染期间直接改 ref:渲染期间改 ref 是反模式,交给 effect 在提交后再做。
  useEffect(() => {
    if (dockStackLen > 0) dockEverAdoptedRef.current = true
  }, [dockStackLen])

  // 切回完整模式时,"临时展开"这个运行态跟着归零——它只在纯净模式里有意义。
  useEffect(() => {
    if (!pureMode) setPureExpanded(false)
  }, [pureMode])

  /**
   * 账号(2026-09-17)。挂载时问一次 `/account`,改密码 / 退出登录之后再问一次。
   *
   * 09-17 拍板之后**「体检与修复」不再自己弹出来**了(它降级成维护页,入口在设置里):
   * 装完第一次打开看到的第一屏是登录,不是一页体检 —— Ben 的原话是"用户可能都不知道要做什么"。
   */
  useEffect(() => {
    let alive = true
    void probeAccount(feed.baseUrl, serviceFetch ?? fetch).then((probe) => { if (alive) setAccount(probe) })
    return () => { alive = false }
  }, [feed.baseUrl, serviceFetch, accountNonce])

  /**
   * 首次流程那面旗子:**登录之后**才问(没登录时问了也没用,而且那一屏还没资格出现)。
   * 问不到就当"走过了"(fetchFirstRun 里那条纪律),宁可少走一次引导,不把人按在引导屏上。
   */
  const loggedIn = account?.enabled === true && account.view.logged_in
  useEffect(() => {
    if (!loggedIn || firstRunNeeded !== undefined) return
    let alive = true
    void fetchFirstRun(feed.baseUrl, serviceFetch ?? fetch).then((view) => {
      if (alive) setFirstRunNeeded(view !== undefined && view.done_at === undefined)
    })
    return () => { alive = false }
  }, [loggedIn, firstRunNeeded, feed.baseUrl, serviceFetch])

  /**
   * 壳窗口「前台 / 桌面」两档(2026-09-18,Ben:「安装完……现在的层级已经在底部了,导致我缩小了
   * 很多应用才看到页面,用户会觉得出 bug 了。登录和引导的时候,应该是和其他应用一样,能在顶部
   * 的,现在写死是底部」)。
   *
   * 判断在 `decideWindowMode`(纯函数、有单测):跟下面那两处整屏早退**同一份状态、同一套判断**
   * —— 登录屏 / 首次流程(引导整段在它里面)在屏上就 front,工作台本体在屏上就 desktop,
   * 还没问到就什么都不发(壳启动默认 front,不发即沿用)。
   *
   * **只在壳里发**(同 /slot/rect 那条纪律):浏览器里随手开的工作台标签没有壳窗口可掀,
   * 发了只会平白把壳那边的窗口层级改掉;服务端那边还会再验一道壳的 UA 标记。
   *
   * **状态变化时才发一次**:sentWindowModeRef 记住上一次真的发出去的那一档,同档不重发——
   * 一条多余的 front 会把正在用别的应用的人打断(壳那边也兜了同一道)。发失败(壳没开、
   * 老版服务端没这条路)不记,下次 effect 重跑会再试一次。
   *
   * **窗位矩形上报不需要在这里暂停**:front 只可能发生在那两处整屏早退的时候,而那两屏
   * 下面槽体元素整个没挂载(slotBodyRef 为空),上报 effect 的 measureSlotRect 量不到东西
   * 就自己噤声了 —— 不是"另外又加了一道开关",是本来就发不出来。详见交接文档第三节。
   */
  const windowMode = decideWindowMode({ account, firstRunNeeded })
  /** 上一次**真的发出去**的那一档(undefined = 还没发过)。 */
  const sentWindowModeRef = useRef<ShellWindowMode | undefined>(undefined)
  /**
   * 没送到就再送(2026-09-25,卡 fix/slot-current-empty)。壳没连上时服务端回 `{ok:false}`,
   * 原来那一条就这么丢了,新壳一直停在启动默认的前台档、压在认领的窗上面。两个再送的时机:
   * 壳连上了(`/state.helper.connected` 翻真),以及每 3 秒一次兜底(连着但这一下超时了)。
   */
  const helperConnected = feed.state.helper?.connected === true
  const [windowModeRetry, setWindowModeRetry] = useState(0)
  useEffect(() => {
    if (!shellMode || windowMode === undefined) return
    if (sentWindowModeRef.current === windowMode) return
    const target = windowMode
    let alive = true
    let retry: ReturnType<typeof setTimeout> | undefined
    void postWindowMode(feed.baseUrl, target, serviceFetch ?? fetch).then((sent) => {
      if (sent) { sentWindowModeRef.current = target; return }
      if (alive) retry = setTimeout(() => setWindowModeRetry(n => n + 1), 3_000)
    })
    return () => {
      alive = false
      if (retry !== undefined) clearTimeout(retry)
    }
  }, [shellMode, windowMode, feed.baseUrl, serviceFetch, helperConnected, windowModeRetry])

  /** 设置里那颗「重新走一遍首次流程」:擦掉旗子,那三屏再来一次。 */
  const handleReplayFirstRun = useCallback(() => {
    void markFirstRunDone(feed.baseUrl, false, serviceFetch ?? fetch).then(() => { setFirstRunNeeded(true) })
  }, [feed.baseUrl, serviceFetch])

  /**
   * 第一次用的空态(2026-09-18)。一格一格地问 emptyState.ts:**不是首次**(引导做完了 /
   * 这台服务没接引导)或者**这一格有数据**,都回 undefined,模块照旧渲染。
   *
   * 不缓存、不放 state:判定是一个纯函数,输入就是这一拍的快照。引导做完那一刻
   * `onboarding.done` 翻真,下一拍所有空态一起退场;某一格的数据先到就只有那一格先退。
   */
  const emptyOf = (module: EmptyModule): EmptyView | undefined => emptyStateFor(module, feed.state)
  /**
   * 空态里那颗「开始引导」。走的就是设置里「重新走一遍首次流程」同一条路 ——
   * **没有另造一条**:两处都是"把那面旗子擦掉,首次流程那几屏再来一次",
   * 造第二条只会多一个要各自维护的入口(而首次流程那几屏是别人的地盘,这张卡不碰)。
   */
  /**
   * 设置里那颗「重新做一遍引导」(2026-09-27,卡 OB):**两件事一起做** ——
   * 擦掉首次流程那面旗子,再把引导进度重置到开头(`/onboarding/restart {"scope":"all"}`)。
   * 只擦旗子是不够的:他已经走完过引导,进度停在「已完成」,那几屏会直接跳过问题。
   * 项目、事项、随手记、记忆文件夹、布局一样不删(重置只动 onboarding.json)。
   */
  const handleRedoOnboarding = useCallback(() => {
    void postSilently(`${feed.baseUrl}/onboarding/restart`, { scope: 'all' }, serviceFetch ?? fetch)
      .then(() => markFirstRunDone(feed.baseUrl, false, serviceFetch ?? fetch))
      .then(() => { setFirstRunNeeded(true) })
  }, [feed.baseUrl, serviceFetch])

  // 空态那颗键:项目区是「开始引导」;余额 / 额度是「连接账号」→ 设置里各家的密钥与登录那一节。
  const handleEmptyAction = useCallback((module: EmptyModule) => {
    if (module === 'quota') { setSettingsAt({ group: 'agents', row: 'credentials' }); setSettingsOpen(true); return }
    handleReplayFirstRun()
  }, [handleReplayFirstRun])

  /**
   * 「还差辅助功能」那一句 + 那颗「去授权」(2026-09-18)。**顶上那条横幅与窗位槽那行
   * 红字共用这一份**(原来系统文件夹里还有一行,2026-10-23 那一格改成图谱后没有了)。
   * 说哪一句由 accessNotice 定(已授权 / 还没体检过一律回 undefined,那两处照旧)。
   */
  const access = accessNotice(feed.state.setup_alerts)
  const accessAuthorize = useAccessAuthorize(feed.baseUrl, serviceFetch)
  const accessProps = access === undefined
    ? {}
    : { access, onAuthorize: accessAuthorize.authorize, accessError: accessAuthorize.error }

  // 贴合是"占着一块屏幕"的状态，不是数据——窗口槽模块被收起时，贴合的窗口已经没有
  // 槽体可对齐了，必须先收起来(spec W4)。Workbench 卸载时同理：没人再看着这块屏幕了。
  // (2026-08-25 版面重排:原来还有"日历借位"这第二个触发条件,日历整块下线后没有了。)
  useEffect(() => {
    if (slotHidden) void postSilently(`${feed.baseUrl}/unsnap`, {}, serviceFetch ?? fetch)
  }, [slotHidden, feed.baseUrl, serviceFetch])
  useEffect(() => () => {
    void postSilently(`${feed.baseUrl}/unsnap`, {}, serviceFetch ?? fetch)
  }, [feed.baseUrl, serviceFetch])

  // 窗位矩形上报(spec 2026-08-24 窗位叠 v2 V3):槽体挂载时立即量一次(dockService 认领
  // 拖入的窗口全靠这个矩形判定"拖进/拖出"),布局操作改变了槽体尺寸位置时
  // 同样立即重报;window resize 单独去抖 800ms,不必每帧打服务。槽体没挂载(窗位模块被
  // 收起,ref 拿不到元素)就什么也不发——单纯是这一拍量不到,不是"矩形该失效"那种场景,
  // postSilently 本身也是失败静默,不用客户端自己编一句。
  //
  // S5(review,真机截图实证,取代 S2 里"矩形变了就自动挪窗"那部分描述——服务端已经不
  // 再看被动上报自动挪窗,见 dock.ts setSlotRect 的注释):这个 effect 绝大多数触发源
  // (挂载、window resize、ResizeObserver、dockStackLen/scenesLen 这类被动测量触发器)
  // 都是"被动上报"——只告诉服务端"槽体现在长这样",不代表"应该把已经贴住的窗口挪过去"。
  // 只有 slot 模块自己的 basis_pct 真的变了(拖高抓手、"恢复默认布局"这类会改 basis 的
  // 操作)才是明确的"该挪"信号,这次上报才带 reason:'resize'。
  //
  // C1(review,jsdom 实测复现):依赖数组必须带 butlerActive——它是 W4 新引入的第三个
  // 会让槽体挂载/卸载的开关(另两个已经在依赖数组里:layout 的 slot.hidden、
  // calendarOpen)。真机路径:有窗在台前 → 点「事务官」→ butlerActive 翻真、槽体卸载
  // (I3 那条 effect 发 {rect:null},正确)→ 用户点回原来那扇窗 → butlerActive 翻假、
  // 槽体重新挂载——这一刻 dockStackLen/scenesLen/layout/calendarOpen/stale 全都没变,
  // 若依赖数组不带 butlerActive,这个 effect 不会重跑,新槽体一次也不会被量过,
  // ResizeObserver 也还挂在已经摘掉的旧元素上(cleanup 没跑)。服务端从此永远停在
  // 上一次 I3 发的 rect:null,拖拽认领一直被判"矩形未上报",直到 resize/改布局/标签数
  // 变化才恢复——而"事务官↔应用窗来回切"正是这个任务新造出来的常规操作,不是边角场景。
  useEffect(() => {
    // S2(a)(review,真机截图实证):组件挂载的第一拍,`layout` state 还是本地的
    // DEFAULT_LAYOUT(服务端真实布局要等 GET /state 第一次轮询回来才套上,见上面
    // layoutReady 那个 effect)——如果这时候就量一次槽体、报一次矩形,等真实布局
    // 一到、这个 effect 因为 `layout` 变了重新跑一遍,又会量出第二个(通常不同的)
    // 矩形再报一次。两次矩形一前一后到服务端,已经贴住的窗口就会被带着挪一次位置,
    // 真机上看着像"刚打开工作台窗口自己跳了一下"。在 layoutReady 落定之前(意味着
    // 服务端第一次响应还没到,不知道到底有没有存过布局)干脆不量不报——反正这时候的
    // 矩形本来就可能是错的(基于本地默认布局算出来的),汇报了也只是白白造一次多余的
    // 重贴。gate 用 layoutReady 这个 state 而不是单纯的 ref:见上面那个 effect 的注释,
    // state 才能保证"ready 变 true"与"layout 套上真实值"落在同一次 re-render,不会有
    // 中间态被这里的其它依赖项(dockStackLen/scenesLen)抢跑触发一次基于旧值的上报。
    if (!layoutReady) return
    // 真机实证(2026-08-25 矩形上报只认壳内页面):壳内 WKWebView、Chrome 里开的工作台
    // 标签、浏览器窗格各自按自己的视口量矩形上报,互相矛盾的合法值交替覆盖会把窗位贴合
    // 位置搞乱——浏览器里随手打开的工作台页面是合法查看器,但不是贴合几何的权威,它们的
    // 视口矩形对壳所在屏幕毫无意义。shellMode 是组件顶层算好的一次性判定(见上面
    // inShellApp 那行),这里直接复用,不必每次上报都重新解析 URL。
    if (!shellMode) return
    // 纯净模式(2026-09-11):槽体 display:none,量出来的是 0 矩形,不是真几何——整个不测不报。
    // 失效语义(unsnap + {rect:null})由 slotHidden 那两条 effect 负责;切回完整时这个 effect
    // 因 layout 变了重跑,用新量出的矩形覆盖。
    if (pureMode) return
    // S5:过渡态快照整个不测不报——轮询漏一拍退回 offlineState、DSH 重启、WS 抖一下,
    // 都会让 state.stale 短暂变 true,或者让已经认领过的 dock.stack 整个字段(不是变
    // 空数组,是 undefined)从响应里消失。这类过渡态里量出来的槽体形状没有意义(标签栏/
    // 场景条这类"高度会变"的内容跟着一起消失了,槽体在同一个 flex 列里被顶到模块最
    // 上面)——保守起见整个跳过,不给服务端存进一个基于噪声快照量出来的矩形,污染下一次
    // 真变化时的比对基准(哪怕服务端这一轮不再拿被动上报自动挪窗)。
    const dockMissingAfterAdopt = dockEverAdoptedRef.current && feed.state.dock === undefined
    if (feed.state.stale || dockMissingAfterAdopt) {
      // S5 的保守性同样约束挂起的稳定性门:进入过渡态这一刻把它一并取消——门要是照常
      // 走完,重测的两帧可能都落在过渡态里,"稳定地错着"恰好能从门下溜过去。
      if (slotRectStabilityTimerRef.current !== null) {
        clearTimeout(slotRectStabilityTimerRef.current)
        slotRectStabilityTimerRef.current = null
      }
      return
    }
    const fetchImpl = serviceFetch ?? fetch
    /**
     * 「槽体的几何前提变没变」的签名(2026-09-18 横屏布局把它从一个数字扩成一串)。
     *
     * 原来只有 slot 自己的 basis_pct 一项。横屏之后还有两件事同样会真的把槽体挪位置
     * 或改尺寸,而且都是"用户明确动作后的稳定态",该带 reason:'resize' 让贴住的原生窗
     * 跟着走,不是被动测量:
     *   - **方向本身翻了档**(壳窗口被拖到另一块屏):槽体从"一整行"变成"中间一大块",
     *     位置尺寸全变。这一档最要紧——不带 reason 的话贴着的窗会停在竖屏时的矩形上,
     *     而那块区域在横屏下已经改由别的模块占着。
     *   - **横屏底部一排的高度变了**:中间那条 = 100 - 底部高度,底部一拖中间就跟着变
     *     (横屏下 slot 自己的 basis_pct 不参与排布,只看它会漏掉这次变化)。
     *
     * 2026-09-18 分栏把手又补进来两项——**横屏四条边界里有三条会改槽体的尺寸**,
     * 签名里少一项,拖那一条时贴住的原生窗就不跟着走(这正是这次要修的那类"没有把手"
     * 的另一面:有了把手却不上报,等于拖了个寂寞):
     *   - **左栏宽度**(rail_pct):左栏一宽,中区跟着窄,槽体当场变小;
     *   - **中区/右栏占比**(slot.width_pct):那根把手原来就在,但签名一直没带它 ——
     *     拖它时靠的是下面 800ms 去抖那条被动路径补的一次测量,贴住的窗要等一下才跟上。
     * 底部四格之间那一根不进签名:它只在底部一排内部倒腾,碰不到槽体。
     */
    const slotSignature = landscape
      ? [
          'landscape',
          landscapeDeckPct(layout),
          landscapeRailPct(layout) ?? 'fixed',
          activeModules.find(module => module.id === 'slot')?.width_pct ?? '',
        ].join(':')
      : `portrait:${activeModules.find(module => module.id === 'slot')?.basis_pct ?? ''}`
    // S5:slotBasisRef 还没写过(组件刚挂载)不算"变了"——跟被动测量走同一条不带
    // reason 的路,不无凭无据地挪一次窗;写过之后跟这次的值不一样才算数。
    const basisChanged = slotBasisRef.current !== undefined && slotBasisRef.current !== slotSignature
    slotBasisRef.current = slotSignature
    const measureSlotRect = (): SlotRectSnapshot | undefined => {
      const el = slotBodyRef.current
      if (el === null) return undefined
      const r = el.getBoundingClientRect()
      return { x: r.x, y: r.y, w: r.width, h: r.height }
    }
    /**
     * 壳窗口此刻的屏幕签名——视口尺寸量的与方向判定同一个来源(orientation.ts 量视口不量元素)。
     *
     * ★ 2026-10-12 不只看视口宽高(卡 `claude/ops-patch-1012`,运营同学 10-09 修的):把窗口从内屏拖到
     * 同尺寸的外接屏、或者系统换了缩放比,逻辑宽高可能一字不变 —— `window.resize` 与槽体 ResizeObserver
     * 都不响,服务端就一直拿上一块屏的坐标贴窗。屏幕位置(screenX/Y)认跨屏,DPR 与 screen / avail 尺寸认
     * 缩放比和分辨率切换;签名变了就按 reason:'resize' 重报一次,服务端用当前 screen_info 重新换算、重贴。
     */
    const viewportKey = (): string => [
      `${window.innerWidth}x${window.innerHeight}`,
      `${window.screenX ?? 0},${window.screenY ?? 0}`,
      `dpr:${window.devicePixelRatio || 1}`,
      `screen:${window.screen?.width ?? 0}x${window.screen?.height ?? 0}`,
      `avail:${window.screen?.availWidth ?? 0}x${window.screen?.availHeight ?? 0}`,
    ].join('|')
    /**
     * 壳窗口自己的尺寸跟上一次真的报出去那一份比,变了没有
     * (2026-09-21 fix/slot-refit-on-orientation,理由见 slotViewportRef 声明处)。
     * 还没报过(刚挂载)一律算"没变"——跟 basisChanged 同一条保守规矩,不无凭无据挪窗。
     */
    const shellViewportChanged = (): boolean =>
      slotViewportRef.current !== undefined && slotViewportRef.current !== viewportKey()
    const postSlotRect = (rect: SlotRectSnapshot, reason?: 'resize') => {
      // 记在**真的发出去**这一刻,不是量到这一刻:被稳定性门丢掉的那些测量不该改写基准,
      // 否则"壳窗口变过一次"这件事会被一次丢弃的测量悄悄抹掉。
      slotViewportRef.current = viewportKey()
      void postSilently(
        `${feed.baseUrl}/slot/rect`,
        { rect, ...(reason === undefined ? {} : { reason }), source: 'app' },
        fetchImpl,
      )
    }
    // 稳定性门的挂起计时器持在 slotRectStabilityTimerRef 上(声明处有完整理由),这里
    // 只有"顶替"一种写法:任何新的被动请求都先取消旧门、再用自己刚量到的 first 排新门。
    // 顶替而不是并存/跳过,一石三鸟——(1)任何时刻至多一个门,末次请求的门必然存活到
    // 触发,拖拽最后一帧的矩形不会被中途某个旧门"判不稳→丢弃"连累到丢失;(2)存活的门
    // 永远来自最新一次请求的闭包,原先 cleanup 注释担心的"旧闭包定时器发陈旧 POST"
    // 不复存在;(3)重测不一致时维持既有"整个丢弃、不排重试循环"的语义(见门内注释)。
    const cancelPendingStabilityGate = () => {
      if (slotRectStabilityTimerRef.current !== null) {
        clearTimeout(slotRectStabilityTimerRef.current)
        slotRectStabilityTimerRef.current = null
      }
    }
    const reportSlotRect = (reason?: 'resize') => {
      const first = measureSlotRect()
      if (first === undefined) return
      if (reason === 'resize') {
        // 用户明确动作后的稳定态——不经过稳定性门,矩形本身就是可信的(见
        // SLOT_RECT_STABILITY_DELAY_MS 常量注释)。顺带取消还挂着的被动门:显式上报
        // 已经把最新几何送出去了,旧门走完顶多再发一次多余(甚至更旧)的被动 POST。
        cancelPendingStabilityGate()
        postSlotRect(first, reason)
        return
      }
      cancelPendingStabilityGate()
      slotRectStabilityTimerRef.current = setTimeout(() => {
        slotRectStabilityTimerRef.current = null
        const second = measureSlotRect()
        // 槽体这时可能已经卸载(窗位模块收起)——量不到就静默放弃,不是"矩形该
        // 失效"那种场景,I3 那条独立的 { rect: null } 清除 effect 会处理失效语义。
        if (second === undefined) return
        // 2026-09-21:reason 在**门里**算,不在排门的时候算——壳窗口的尺寸完全可能在
        // 这 80 毫秒里才补到位(换屏时 resize 分两拍到就是这样)。门本身正好当了一道
        // "壳窗口停稳了没有"的哨:两次量到的矩形不一致就整个丢弃,不会拿换屏途中那
        // 一拍的中间态去挪窗。
        if (slotRectNearlyStable(first, second)) postSlotRect(second, shellViewportChanged() ? 'resize' : undefined)
        // 不稳定就整个丢弃这次上报,不自己排重试循环——下一次 RO/resize 触发会自然带着
        // 新的稳定态重新走一遍这整条上报路径(scheduleReport/ResizeObserver 已经在监听)。
      }, SLOT_RECT_STABILITY_DELAY_MS)
    }
    // 方向翻档 / slot 的 basis 变了 → 立刻报一次(这条不经过稳定性门,语义与 2026-09-18
    // 逐字不变)。"壳窗口尺寸变了"这第二个凭证**只走带门那一条**:它的触发源是 resize/RO,
    // 本来就可能落在壳还没停稳的那一拍上,门里重测一次才敢认。
    reportSlotRect(basisChanged ? 'resize' : undefined)
    let timer: ReturnType<typeof setTimeout> | undefined
    const scheduleReport = () => {
      if (timer !== undefined) clearTimeout(timer)
      // window resize / ResizeObserver 本身不是"该挪窗"的凭证(页面内部重排也会触发
      // RO)——带不带 reason 由门里那一下 shellViewportChanged() 说了算:壳窗口的尺寸
      // 真的跟上次报出去时不一样了才算数,页面内部抖动一律仍是被动测量(S5)。
      timer = setTimeout(() => reportSlotRect(), SLOT_RECT_DEBOUNCE_MS)
    }
    window.addEventListener('resize', scheduleReport)
    /**
     * 跨屏 / 换缩放比没有稳定的 DOM 事件(WebKit 不报「窗口换了显示器」)。这里每半秒比一次**字符串签名**:
     * 不量 DOM、不发请求,只有签名真变了才立刻按 reason:'resize' 重报一次(经稳定性门没意义 ——
     * 签名变了就是壳窗口真的挪了)。窗口重新拿到焦点时再比一次:接屏、唤醒后她点回工作台就能马上自愈。
     */
    let observedViewportKey = viewportKey()
    const reportDisplayChange = () => {
      const next = viewportKey()
      if (next === observedViewportKey) return
      observedViewportKey = next
      reportSlotRect('resize')
    }
    const displayTimer = setInterval(reportDisplayChange, SLOT_DISPLAY_POLL_MS)
    window.addEventListener('focus', reportDisplayChange)

    // 真机验收实测(认领后窗口偏上那条 bug):认领会让标签栏冒出来、把槶体在 flex 列里
    // 往下挤——这类"槶体自己的 box 尺寸被上方内容撑高/压低"的变化根本不触发 window
    // resize,只有 ResizeObserver 才看得到槶体本身尺寸的变化,量测/去抖复用同一套
    // reportSlotRect/scheduleReport,不是另开一条上报逻辑。jsdom 没有 ResizeObserver,
    // 守一道 typeof 判断——测试环境退化成靠上面 dockStackLen/scenesLen 这两个依赖项
    // 触发 effect 重跑来覆盖同一条行为,不是真的少了这段能力。
    let resizeObserver: ResizeObserver | undefined
    if (typeof ResizeObserver !== 'undefined') {
      const el = slotBodyRef.current
      if (el !== null) {
        resizeObserver = new ResizeObserver(scheduleReport)
        resizeObserver.observe(el)
      }
    }

    return () => {
      window.removeEventListener('resize', scheduleReport)
      window.removeEventListener('focus', reportDisplayChange)
      clearInterval(displayTimer)
      resizeObserver?.disconnect()
      if (timer !== undefined) clearTimeout(timer)
      // 挂起的稳定性门特意不在这里清(评审 2026-08-25):本 effect 的依赖含 layout/
      // dockStackLen 这类高频值,拖拽期间每次 pointermove 都走一遍 cleanup——门要是
      // 挂在这里,就永远活不过一次拖拽。它由上报管线自己顶替/取消,卸载时由下面那个
      // 专门的 effect 收尾。
    }
  }, [layoutReady, shellMode, layout, feed.baseUrl, serviceFetch, dockStackLen, scenesLen,
    feed.state.stale, butlerActive, orientation, activeModules])

  // 稳定性门计时器的卸载收尾:它跨 effect 存活(理由见 slotRectStabilityTimerRef 声明处),
  // 组件整个卸载时才最后清一次——不然门会在卸载后照常触发,对一个已经没人看的页面量测
  // 并 POST 一次(unsnap/rect:null 的卸载语义由各自的 effect 负责,这里只管别漏计时器)。
  useEffect(() => () => {
    if (slotRectStabilityTimerRef.current !== null) clearTimeout(slotRectStabilityTimerRef.current)
  }, [])

  // 窗位矩形失效(I3):窗位隐藏时槽体整个卸载,但服务端上一次上报的矩形不会自己过期
  // ——不清掉的话,拖进/切换会把窗口贴到一块看不见的区域上(收起的把手条底下)。
  // 只在"变成隐藏"这一刻发一次清除,不挂在 resize 上:槽体已经不在了,上面那个 effect 的
  // reportSlotRect 会因为 el===null 自己噤声,不需要这里重复发。
  // 恢复可见时不必特意处理——上面那个 effect 同样吃 layout,槽体一露面就会用新测出的
  // 矩形自动覆盖掉这里发的 null。
  //
  // 合并注(2026-08-26):计时器修复那条分支是在日历借位还在的时候写的,它的注释里还提着
  // 「日历面板底下」——版面重排已经把工作台自带日历整块下线了,这里保留删掉日历之后的
  // 说法,只取那条分支真正的改动(上面那个卸载 effect)。
  useEffect(() => {
    // 同上(矩形上报只认壳内页面):清除同样只由壳内页面来发——不在壳内的页面本来就
    // 没资格上报过矩形,它的清除请求同理没有意义,发了也只是白打一次服务。
    if (!shellMode) return
    // **只有 slotHidden 才清。事务官在台前不清。**(2026-08-26 真机事故后改)
    //
    // 原来这里还有一支 `butlerActive && !dockUnknown`,理由是"选中事务官时槽体也整个不挂载,
    // 跟 slotHidden 同一个道理"。真机上它造出一个谁也出不来的死锁,Ben 的原话是
    // 「应用标签被钉死在事务官上了,我点击其他的完全不响应」:
    //   ① 点「事务官」→ /dock/hide → 服务端 current 置空
    //   ② butlerActive 翻真(叠非空但没人在台前)→ 槽体卸载
    //   ③ 这里发 {rect:null} → 服务端忘掉槽位矩形
    //   ④ 点任何应用标签 → dock.ts 的 switchTo 在矩形为空时直接抛
    //      NOTE_SWITCH_SLOT_UNKNOWN → 没有标签能变 current → butlerActive 恒为真 → 回不去
    //
    // 两件事本来就不是同一个道理:slotHidden 是**那块屏幕区域改作他用了**(模块收起,
    // 位置让给别的模块),再往那儿贴窗会盖住不相干的内容,所以必须清;事务官在台前时那块
    // 区域**还是它自己**——事务官 iframe 就铺在同一个矩形上,几何依然成立,清掉只是把
    // 回去的路一起清了。
    //
    // 顺带:不清之后,事务官在台前时把窗口拖进那块区域也能照常认领(handleMoved 判 inside
    // 需要的正是这份矩形),比原来多一条出路,不是少一条。
    if (!slotHidden) return
    void postSilently(`${feed.baseUrl}/slot/rect`, { rect: null, source: 'app' }, serviceFetch ?? fetch)
  }, [shellMode, slotHidden, feed.baseUrl, serviceFetch])


  // 项目区(v5,spec D8)：portfolio.ts 只做投影,数据来自本地服务的 GET /state
  // projects 字段,不再从 DSH Workspace 列表反推项目归属。
  const nowSec = Date.parse(feed.state.now) / 1000
  const portfolio = useMemo(
    () => buildProjectRows(feed.state.projects, nowSec),
    [feed.state.projects, nowSec],
  )

  // 事务官的结论(spec D11)是跨区的：读项目区 DDL、会话区等待时长、机器信号，
  // 不是又一份状态，纯函数复算即可，没必要单独存一份。
  const conclusions = useMemo(() => butlerConclusions(feed.state, nowSec), [feed.state, nowSec])

  // 组件条·存储/性能(spec §3，终审 F2 补齐)：machine 采样早就接通了，界面上一直
  // 没有常显位置——这两格就是补上的位置，纯函数投影，不额外发请求。
  const storageWidget = useMemo(() => buildStorageWidget(feed.state.machine), [feed.state.machine])
  const performanceWidget = useMemo(() => buildPerformanceWidget(feed.state.machine), [feed.state.machine])

  /**
   * 顶部的状态点(2026-09-25,卡 Q):**一家 Agent 一颗,按登记表来**(`/state.agent_registry`)——
   * 接上了的才有(事务官自己永远在最前),名字、灯色、最近冒的那一句都从登记表来,界面里不再有「是哪几家」的表。
   * 以前是写死的四家再按「装没装」筛;登记表本来就只有接上了的那几家。
   */
  const lamps = useMemo(() => registryLamps(feed.state), [feed.state])
  /**
   * 「这台电脑上 N 家 Agent 客户端」那一小条(2026-09-26,卡 LG;维护者:「增加一个功能,就是现在电脑上
   * 有多少个 Agent 客户端,把对应的 logo 也搞上」)。**数法只认登记表**,不写死名单。
   */
  const agentCount = useMemo(() => registryCount(feed.state), [feed.state])
  /**
   * 小灯那一排后面那一句(2026-09-25,卡 Q;统筹:没给壳辅助功能授权时「得是一句能懂的话,加上一键去开的入口,不许空白」)。
   * 「去打开」与顶上横幅那颗「去授权」是同一下(打开系统设置 → 隐私与安全性 → 辅助功能,回到窗口时复查)。
   */
  const agentHintBase = registryHint(feed.state)
  const agentHint = agentHintBase === undefined
    ? undefined
    : {
        text: agentHintBase.text,
        ...(agentHintBase.authorize ? { action: '去打开', onAction: accessAuthorize.authorize, error: accessAuthorize.error } : {}),
      }

  // 「浮层关了就不画」那一句挪到了下面最后一个 hook 之后(2026-09-25),见那里的注释。

  /**
   * 「恢复默认布局」**按当前方向恢复**(2026-09-18):在横屏上点它只把横屏那一份换回默认,
   * 竖屏那份一字不动,反之亦然。理由跟"两份分开存"是同一条——两个方向的排布互相不可换算,
   * 顺手把另一版也抹掉是用户绝不会预期的破坏。
   */
  const handleResetLayout = () => applyLayout(resetLayout(orientation, layout))
  // 「恢复布局」先问一句(10-22 统筹定 28,评审页「恢复默认布局?」那张居中弹层)。
  const [resetAsk, setResetAsk] = useState(false)

  /**
   * 解锁卡上那颗按钮(2026-09-17)。**这里不做任何判断**——去设置、去初始化页、
   * 还是弹「帮你接上」那个框,由 areaUnlock.ts 那张表决定,这里只负责把对应的那一扇打开。
   */
  const handleUnlock = (target: UnlockTarget, client?: ClientKey, at?: QuotaStaleFix['at']) => {
    /**
     * `at` = 设置里哪一节、哪一行(2026-10-02,卡 QK)。「读不到最新」那一格上那颗入口键带着它来 ——
     * **这里不判是哪一家**,去处是服务端那一份声明给的(`quota/liveSources.ts`),同 areaUnlock.ts
     * 头上那条老规矩。别的几颗键不带,那时清掉上一次的落点,照旧开在默认那一组。
     */
    setSettingsAt(at)
    if (target === 'settings' || target === 'model') setSettingsOpen(true)
    /**
     * 「用我们的服务(推荐)」(2026-09-21,DeepSeek 那一格)。**就地切,不跳设置** ——
     * 他登录过了的话这本来就是一键的事,把他送进设置里再让他找一个单选框,
     * 等于把"一键"说成了一句空话。
     *
     * 切完没 `ready`(没登录 / 中转还没给凭证)才把设置打开:那一节里有「还没接上」
     * 与「重新接一次」,他在那儿看得见到底卡在哪。**不弹一个自己编的错误框**。
     */
    else if (target === 'relay') {
      void switchModelMode(feed.baseUrl, 'relay', serviceFetch ?? fetch)
        .then((result) => { if (!result.status.ready) setSettingsOpen(true) })
        .catch(() => setSettingsOpen(true))
    }
    // 代写只有 Claude / Codex 两家有(别家没有钩子这回事),那张表里也只给了这两家。
    else if (target === 'apply' && (client === 'claude' || client === 'codex')) setHooksApplyFor(client)
    // 「全部接上」(2026-09-25):两家并成一个框,一次看、一次点,每家仍能单独撤回。
    else if (target === 'apply-all') setConnectAllOpen(true)
    else setSetupOpen(true)
  }

  // 事务官收小/展开(spec D11)：只改 layout.butler.min，不走 moveModule/toggleHidden——
  // 事务官本来就不在 layout.modules 里，不受"不可改清单"那套模块显隐逻辑管辖。
  // 点击是一颗**翻转型的键**(展开⇄收起都走它),来自当前渲染的按钮,拿这一拍的 layout
  // 翻转没问题——它是货真价实的用户动作。
  const handleToggleButlerMin = () => applyLayout({ ...layout, butler: { ...layout.butler, min: !layout.butler.min } })

  /**
   * 事务官浮窗的开/收(2026-10-28,交接-1027「12:0x 气泡」那节的治本第二条:
   * **开/收只认用户动作,而且认的是"展开/收起"这个意图,不是"翻一下"**)。
   *
   * 焦点事件(他点了通知)、角标(他点了"等你 n 件")、"开发一个小工具"、引导走完那一次、
   * 浮窗里点"定位到这一张"——这些回调都该表达**set 语义**(我要展开 / 我要收起),
   * 不能是 `if (min) 翻一下`:回调闭包手里的 layout 可能已经不是最新一拍(同一拍里
   * 布局刚被别的事件改过、effect 还没带着新值重跑),拿过期快照"翻转"会把一次"展开"
   * 翻成"收起"、把一次"收起"翻成"展开";意图连发两下(连点角标),旧写法还会在同一份
   * 闭包上翻两下 = 原地没动。这两种都是"浮窗自己开开关关、怎么点都不对"的直接成因。
   *
   * 所以:这几处一律走 applyButlerMin(按最新布局判"变了才动、set 不 toggle),
   * 唯一保留"翻转"语义的只剩上面那颗用户亲手点的键。
   */
  const applyButlerMin = (min: boolean) => {
    if (layoutRef.current.butler.min === min) return
    applyLayout({ ...layoutRef.current, butler: { ...layoutRef.current.butler, min } })
  }
  /** 展开悬浮球(已经展开就不动)。事务官入口只剩它(2026-10-27)。 */
  const openButlerFloat = () => applyButlerMin(false)

  // 纯净模式开关(2026-09-11):只改 layout.pureMode 这一个字段,别的布局一字不动——切换
  // 不丢任何布局(Ben:「布局照旧落盘,切换不丢任何东西」)。走 applyLayout 同一条落盘路径。
  const handleTogglePureMode = () => {
    setPureExpanded(false)
    applyLayout({ ...layout, pureMode: !pureMode })
  }

  // W4:点「事务官」——藏起当前在台的原生窗(stack 成员不掉),露出下面的 iframe。
  // butlerActive 定义见上方(窗位矩形失效 I3 那个 effect 的依赖数组要更早用到它)。
  const handleSelectButler = () => {
    // 合并注(2026-08-26):这里原来还有一句 setCalendarOpen(false)——日历借位优先级高于
    // 事务官,开着日历点「事务官」会零反馈,所以顺手收起日历。版面重排已把工作台自带日历
    // 整块下线(应用区能认领系统日历了),借位这条路不存在,那句跟着删。
    // C1:叠为空那一档服务端表达不了选中态,记在客户端(清除时机见 butlerPicked 声明处)。
    // 叠非空时这个值不会被读到,置位也无害——不必在这里再判一次 dockEmpty。
    setButlerPicked(true)
    // 2026-09-21:点「事务官」= 回到事务官那一档本身,把自定义模块那一层让开。
    setActiveModuleId(null)
    void postSilently(`${feed.baseUrl}/dock/hide`, {}, serviceFetch ?? fetch)
  }

  /**
   * 「事务官」标签上的数与气泡(2026-09-25,卡 M;维护者:「事务官自己应该也有气泡才对」)。
   * 与球下「等你 n」「还有 N 件要你看」、手机「等你确认」**同一堆、同一个数**:服务端算好的 `state.waiting`(src/waiting.ts)。气泡里一件一行。
   */
  const butlerPile = useMemo(() => waitingOf(feed.state), [feed.state])
  const butlerWaiting = useMemo(() => ({ count: butlerPile.count, lines: butlerPile.items.map(item => item.text) }), [butlerPile])
  // 点那个数:摊开「要你看的」那一层,滚到最前面那一件。
  const firstAskKey = butlerPile.items[0]?.key ?? ''
  // 要摊开某一张:工作台浮层关着(他在 DSH 原始界面)先回来,再切到事务官那一档。
  useEffect(() => {
    if (focusAsk === undefined) return
    if (!state.open) actions.open()
    // 2026-10-27:事务官入口只剩悬浮球 —— 展开浮窗,摊开那一件(浮窗里那一份收 focusAsk)。
    openButlerFloat()
    // 只跟着这一次「要摊开」走。
  }, [focusAsk?.at])

  /**
   * 点一格自定义模块(2026-09-21)。**与点「事务官」是同一条路** ——
   * 藏起当前在台的原生窗(`POST /dock/hide`),露出盖在槽体上的那一层;
   * 区别只在"露出来的是收件箱还是这一格的 iframe",而那是纯客户端的选择。
   */
  const handleSelectModule = (id: string): void => {
    // 再点一次正在看的那一格 = 退出它(2026-10-27:「事务官」那一格去掉之后,这是离开自定义模块的路)。
    if (moduleActive && activeModuleId === id) { setActiveModuleId(null); return }
    setActiveModuleId(id)
    setButlerPicked(true)
    void postSilently(`${feed.baseUrl}/dock/hide`, {}, serviceFetch ?? fetch)
  }

  /**
   * 移除一格自定义模块(**移进回收站,可恢复**;二次确认在标签自己身上,见 CustomModuleTab)。
   *
   * 先把选中态退回事务官档,再发请求:等服务端那一拍回来才退,中间这一拍 iframe 指着的是
   * 一个已经被搬走的目录 —— 那一瞬间是一片白。顺序反过来在真机上就是"删掉之后闪一下白"。
   */
  const handleRemoveModule = (id: string): void => {
    if (activeModuleId === id) setActiveModuleId(null)
    void postSilently(`${feed.baseUrl}/modules/${id}/remove`, {}, serviceFetch ?? fetch)
  }

  /**
   * 「带一句话打开事务官」(2026-09-20「开发一个小工具」)。
   *
   * 两件事,顺序无关(同一批 state 更新):**把那句话写进草稿** + **走点「事务官」同一条路**
   * (handleSelectButler,POST /dock/hide)。最后要一次焦点,光标落在草稿末尾。
   * **不发送**——这一版只是替他起个头,要什么样的小工具得他自己说,见 DEV_TOOL_DRAFT。
   *
   * **他已经打了别的字就不覆盖**:输入框里那句没发出去的话是他的,一颗按钮不该把它抹掉
   * (同 ButlerInbox 提交失败时"没建下来还把他打的字清掉,那句话就真没了"那条纪律)。
   * 那种情况下这颗按钮退化成"打开事务官并把光标送回输入框",他自己接着写。
   */
  const handleOpenButlerWithDraft = (text: string): void => {
    setButlerDraft(current => (current.trim() === '' ? text : current))
    setButlerDraftFocusAt(at => at + 1)
    openButlerFloat()
  }

  /** 那颗按钮点下去的那一下。横竖两处宿主共用同一个回调,两边不会走漂。 */
  const handleDevTool = (): void => handleOpenButlerWithDraft(DEV_TOOL_DRAFT)

  // C1:「回到窗位落点」——只在"叠为空 + 选中事务官"这一种状态下摆出来(见 SlotModule),
  // 那时标签栏只剩「事务官」一格,没有别的标签可点着回去。不发任何请求:叠为空意味着
  // 没有窗可切,要变的只有"这会儿画落点还是画 iframe"这个纯客户端的选择。
  const handleLeaveButler = () => setButlerPicked(false)

  /**
   * **引导刚走完那一次,首页切回事务官档**(2026-09-25,卡 feat/first-look-orb-top)。
   *
   * 维护者 09-24 晚用手机走完引导,电脑上那一屏停在窗口槽(Claude 那扇窗在台前),事务官缩成右下角一张小卡 ——
   * 他要看的「我照你说的摆好了」、在办的事、那颗球,全在事务官档里。所以:`/state.onboarding.done_at`(走完的那一刻)
   * 第一次出现在这台机器上时,走一次点「事务官」同一条路(藏起台前那扇窗)。
   *
   * **同一次走完只切一次**:切过就把那一刻记在本机(localStorage),之后他点哪个标签就是哪个,重开也不再抢。
   * 再走一遍引导(restart)会有新的一刻,那时再切一次。存不了(隐私模式)就当没切过 —— 最多每次打开都回到事务官档,
   * 不会卡住任何事。快照不新鲜(stale)时不动:那一拍的 dock 不可信。
   */
  const onboardingDoneAt = feed.state.onboarding?.done === true ? feed.state.onboarding.done_at : undefined
  useEffect(() => {
    if (onboardingDoneAt === undefined || !feed.loaded || feed.state.stale) return
    if (readHomeShownFor() === onboardingDoneAt) return
    writeHomeShownFor(onboardingDoneAt)
    openButlerFloat()
    // handleSelectButler 每一拍都是新函数,只认「走完的那一刻」变没变。
  }, [onboardingDoneAt, feed.loaded, feed.state.stale]) // eslint-disable-line react-hooks/exhaustive-deps

  // W4:「跟事务官说一句」——DSH 没有受支持的接口能从插件把文本送进对话(见 Butler.tsx 的
  // onAsk 注释),所以只能放进剪贴板再切过去。
  //
  // I1(整分支终审,Task 4 × Task 9 的接缝):**只有复制成功才切标签**。
  // 原来是"无论成没成都切"——切标签会让 dock.current 变 null → butlerActive →
  // narrowForced → 浮窗压成窄条,整个 .ben-wb__butler-text(含输入框与那句提示)
  // 不再渲染。于是失败路径上「没能复制,请手动选中复制」连同刻意保留下来的原文一起
  // 被藏起来,那条诚实兜底在真机上等于不成立(两个任务的组件级测试都单独渲染 Butler、
  // narrowForced 固定不变,所以都测不到)。
  // 而且切过去本来就没有意义:文本没进剪贴板,人到了对话页也粘不出东西来;留在浮窗上
  // 至少还能把输入框里的原文选中手动复制——那正是那句提示让 Ben 去做的事。
  const handleAsk = async (text: string): Promise<boolean> => {
    let copied = false
    try {
      // 自查修复:brief 原稿写的是 `navigator.clipboard?.writeText(text)`——非安全上下文下
      // navigator.clipboard 本身是 undefined,可选链在这种情况下直接短路成 undefined、
      // 不抛异常,会让下面 copied=true 照样执行,谎称"已复制"。这正是下面注释点名要接住
      // 的那个分支("无权限/非安全上下文"),所以改成显式判空后主动抛,统一走 catch,
      // 让"没有 clipboard API"和"写入被拒绝"落到同一条如实返回 false 的路径上。
      if (navigator.clipboard === undefined) throw new Error('clipboard API 不可用')
      await navigator.clipboard.writeText(text)
      copied = true
    }
    catch { copied = false } // 无权限/非安全上下文——如实回 false,让浮窗别清空输入框
    if (copied) handleSelectButler()
    return copied
  }

  // A6:事务官浮窗可拖动——拖拽结束/过程中 Butler.tsx 算出百分比坐标回调这里,只改
  // 落点,不碰 corner/min(同上一条注释同一个理由:不可改清单管不到这个字段,
  // 只是多了一种定位方式)。
  //
  // 2026-09-18:落点**按方向分别记**(决策记录「横屏事务官浮窗默认落点」)。竖屏写顶层
  // butler.pos,横屏写 landscape.butler_pos —— 在横屏上把浮窗拖到右下角,回竖屏时不该
  // 发现它正压着窗位槽。尺寸(butler.size)仍然共用一份:那是"这个窗多大",不是"摆在哪儿"。
  const handleButlerMove = (pos: { x_pct: number, y_pct: number }) =>
    applyLayout(withButlerPos(layout, orientation, pos))

  /**
   * 横屏浮窗默认落点(2026-09-18 决策记录,Ben 截图里它正压着系统文件夹那一格的右半边)。
   *
   * 只在**没拖过**时管用:算出上半那一条的底边离视口底边多远,写成 CSS 变量
   * `--ben-wb-land-butler-bottom`,浮窗那条 `[data-corner=br]` 的 bottom 用它(style.ts)。
   * 拖过一次之后 Butler.tsx 写行内 `bottom:auto`,行内天然压过样式表,用户的落点照旧生效
   * ——"用户拖过就记用户的"这条不需要一行额外代码。
   *
   * 为什么是"抬到底边之上"而不是算一个 x/y 落点:CSS 的 bottom 锚的是浮窗**下沿**,
   * 不需要知道浮窗多高;算落点就得先知道高度,而没有 size 的那一档高度是内容撑出来的
   * (Butler.tsx 的 C2 注释记着这条坑:拿常量顶替会把「全部暂停」推出可视区)。
   *
   * 量不到(竖屏、纯净模式、底部一排整排收起、jsdom)就**不设这个变量**,回落到 style.ts
   * 里那个 16px —— 不猜一个数(D13)。
   */
  const [landButlerBottomPx, setLandButlerBottomPx] = useState<number | undefined>(undefined)
  useEffect(() => {
    if (!landscape || pureMode) {
      setLandButlerBottomPx(undefined)
      return
    }
    const read = (): void => {
      const el = landBandRef.current
      if (el === null) return
      const rect = el.getBoundingClientRect()
      if (rect.height <= 0) return
      // 上半条的下沿到视口底边的距离,再留 11px —— 与两块区域之间的缝同宽。
      const next = Math.max(16, Math.round(window.innerHeight - rect.bottom + 11))
      setLandButlerBottomPx(prev => (prev === next ? prev : next))
    }
    read()
    window.addEventListener('resize', read)
    return () => { window.removeEventListener('resize', read) }
    // layout 进依赖:拖那根横把手时底部一排的高度每帧都在变,浮窗要跟着抬/落,
    // 不能停在拖之前那个位置上。
  }, [landscape, pureMode, layout])

  // 协作区全屏(10-22 第三轮 5):整个工作台只剩协作区;窗位里的原生窗让开,Esc 退。
  const [collabFull, setCollabFull] = useState(false)
  /** 悬浮球「在协作区查看」带进来的那一件(2026-10-27):协作区全屏打开并定位。 */
  const [collabLocate, setCollabLocate] = useState<{ id: string, at: number } | undefined>(undefined)
  useVeilSlot(collabFull, veilTarget)
  useEffect(() => {
    if (!collabFull) return undefined
    void (serviceFetch ?? fetch)(`${feed.baseUrl}/collab/presence`)
      .then(async res => (res.ok ? await res.json() as { presence?: CollabPresence[] } : undefined))
      .then((got) => { if (got?.presence !== undefined) setCollabPresence(got.presence) })
      .catch(() => undefined)
    const onKey = (event: KeyboardEvent): void => { if (event.key === 'Escape') setCollabFull(false) }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [collabFull, feed.baseUrl, serviceFetch])

  /*
   * 收起的球读哪本账(2026-10-28,断点④残留):在跑那一件数与展开窗「在跑的事项」同读
   * /collab/runs(取数以 main 上的 useCollabRuns 为准,口径在 runningCountOf);没接上退回 /state.running 快照。
   * ButlerScene 自己经 talk 也挂了一份同一钩子,两边各自取数、同一本账。
   * 位置:必须放在下面「浮层关了就不画」那个提前 return 之前 —— 那句之后一个 hook 都不许有。
   */
  const runFacts = useCollabRuns(feed.state, { baseUrl: feed.baseUrl, fetchImpl: serviceFetch ?? fetch })

  // 浮层关了就不画 —— **必须在最后一个 hook 之后**(2026-09-25)。以前这句在上面 lamps 之后,
  // 横屏浮窗落点那两个 hook(landButlerBottomPx)排在它后面:「进项目」/打开事项对话一关浮层,
  // React 报「Rendered fewer hooks than expected」,DSH 的 SlotErrorBoundary 接住后把工作台这一格
  // 换成一个空的崩溃占位,侧边栏那颗「工作台」再点也回不来(壳里只能 ⌘R)。新加 hook 请放在这句之上。
  //
  // 2026-09-25(卡 M,维护者:「变成这个页面了,工作台回不来了」):关了也不是什么都不画 —— 在 DSH 原始界面的
  // 左上角摆一颗醒目的「‹ 回工作台」(盖住上游那行品牌字),点了就回来。以前回来的路只有侧栏最底下一个小图标,他没找到。
  if (!state.open) return <ReturnToWorkbench onReturn={actions.open} />

  // W4:拉伸——与 pos 同一条持久化路径(applyLayout → 800ms 去抖),不碰 corner/min。
  const handleButlerResize = (size: { w_px: number, h_px: number }) =>
    applyLayout({ ...layout, butler: { ...layout.butler, size } })

  // 暂停(spec §5 诚实边界)：翻转型接口，不带 body。真相以下一拍轮询回来的
  // state.paused 为准——跟布局/项目状态同一套"失败静默、服务端为准"的规矩。
  const handlePause = () => {
    const fetchImpl = serviceFetch ?? fetch
    void postSilently(`${feed.baseUrl}/pause`, {}, fetchImpl)
  }

  // 试铃(来电链 v0)：同款翻转型接口，发后不管。按钮文案的真相是 /state.test_ringing
  // ——POP 摘机停铃、60 秒自动归零、别的窗口按过，浏览器本地都无从知晓，
  // 本地记状态就会说谎（真机上就说过谎），只能跟服务端轮询走。
  const handleTestRing = () => {
    const fetchImpl = serviceFetch ?? fetch
    void postSilently(`${feed.baseUrl}/ring/test`, {}, fetchImpl)
  }

  // W4:划走今晨快报——当天不再推。真相以下一拍轮询回来的 state.brief 为准,
  // 跟 pause/试铃同一套"失败静默、服务端为准"的规矩。
  // 哨兵(2026-09-09):取消一条监视。服务端会连它那条会话一起收掉(offline),
  // 所以这里不做本地乐观更新——真相以下一拍轮询回来的快照为准(同 markRead 那套规矩)。
  const handleCancelWatch = (id: string) => {
    void postSilently(`${feed.baseUrl}/sentinel/remove`, { id }, serviceFetch ?? fetch)
  }

  const handleDismissBrief = () => {
    void postSilently(`${feed.baseUrl}/brief/dismiss`, {}, serviceFetch ?? fetch)
  }

  // 确认后不本地乐观更新——不改 portfolio.rows 里的文案，真相以下一拍轮询
  // 从服务端 GET /state 拿回来的快照为准（跟 markRead 同一套"失败静默"规矩）。
  const handleConfirmStatus = (id: string, text: string) => {
    const fetchImpl = serviceFetch ?? fetch
    void postSilently(`${feed.baseUrl}/project/status`, { id, text }, fetchImpl)
  }

  // 浮窗搬进事务官档的那几样(2026-09-11,PRD §9 第 1 条:功能一项不能少,只是搬家)。
  // 提议仍走 proposals.ts 的三条门槛——今天没有提议源,传空数组,调用链是真的(见 Butler.tsx)。
  const butlerControls: ButlerControls = {
    paused: feed.state.paused ?? false,
    testRinging: feed.state.test_ringing ?? false,
    onPause: handlePause,
    onTestRing: handleTestRing,
    ...(feed.state.sentinel === undefined ? {} : { sentinel: feed.state.sentinel }),
    onCancelWatch: handleCancelWatch,
    ...(feed.state.brief === undefined ? {} : { brief: feed.state.brief }),
    onDismissBrief: handleDismissBrief,
    proposals: admissibleProposals([], localDateStr(Date.now())),
  }
  // 纯净模式下额度格收起了,顶栏放一行摘要顶替(完整模式不传:同一个数字不在两处各说一遍)。
  const quotaSummary = pureMode
    // agent_quota 也进来(2026-09-26,卡 QS):这一轮取不到数时这一行写上次读到的那个数,不写「未接入」。
    ? quotaSummaryLine(quotaCells(
        feed.state.quota, {}, new Date(feed.state.now),
        feed.state.deepseek_peak, feed.state.agent_quota,
        // 卡 HC:纯净模式顶栏那一行与额度格同一份家名,没装的那一家两处都不出现。
        quotaAgentIds(feed.state),
      ))
    : undefined
  // 事务官档露出时(叠上没窗在台前)或纯净模式下,右下角浮窗藏起来——它的内容就在事务官档里。
  // 事务官入口只剩悬浮球(2026-10-27 已拍板):除纯净模式(整屏就是那颗球)外一直露着。
  const butlerFloatHidden = pureMode
  // 那页事务官只挂一处:浮窗露着且展开时在浮窗里,否则在窗口槽里(10-22 第三轮)。
  const butlerInFloat = !butlerFloatHidden && !layout.butler.min

  /**
   * 登录屏(2026-09-17)。**整屏替换工作台**,不是盖一层半透明的东西:第一次开机时看板上
   * 本来也没有可看的,而盖一层会让人以为后面那片能点。
   *
   * 早退发生在**所有 hook 都跑完之后**(React 的 hook 规则):轮询照旧在跑,登录完不用刷新页面。
   * `account` 还没问到时照旧显示工作台 —— 见上面那个 useState 的注释。
   */
  if (account?.enabled === true && !account.view.logged_in) {
    return (
      <main className="ben-wb" aria-label={WORKBENCH_TITLE}>
        <style>{STYLE}</style>
        <AccountScreen
          baseUrl={feed.baseUrl}
          {...(serviceFetch === undefined ? {} : { fetchImpl: serviceFetch })}
          view={account.view}
          onLoggedIn={(view) => {
            if (view.logged_in) { setAccount({ enabled: true, view }); setJustLoggedIn(true) }
            else setAccountNonce(n => n + 1)
          }}
          onReset={() => setAccountNonce(n => n + 1)}
        />
      </main>
    )
  }

  /**
   * 首次流程(引导入口):注册/登录成功之后、`first_run_done_at` 还没写时**只出现这一次**。
   * 走完或跳过就写旗子;设置里「重新走一遍首次流程」把它擦掉。
   */
  if (justLoggedIn && firstRunNeeded === undefined && account?.enabled === true && account.view.logged_in) {
    return (
      <main className="ben-wb" aria-label={WORKBENCH_TITLE} aria-busy="true">
        <style>{STYLE}</style>
      </main>
    )
  }

  if (firstRunNeeded === true) {
    return (
      <main className="ben-wb" aria-label={WORKBENCH_TITLE}>
        <style>{STYLE}</style>
        <MeNameProvider name={feed.state.me?.name}>
          <FirstRunFlow
            baseUrl={feed.baseUrl}
            {...(serviceFetch === undefined ? {} : { fetchImpl: serviceFetch })}
            state={feed.state}
            onDone={() => setFirstRunNeeded(false)}
          />
        </MeNameProvider>
      </main>
    )
  }

  /**
   * 单个模块的渲染(2026-09-18 从 `moduleRows.map` 的回调里原样提到组件作用域)。
   *
   * **提出来是为了让横竖两版共用同一份**——横屏不是另画一套模块,只是把这同一批
   * 模块摆进另外五个区域里。提的时候除了签名(原来靠闭包拿 `multi`,现在走 `opts`)
   * 与新增的 `opts.fill` 之外,一行没改。
   */
  /**
   * 这个模块在**当前模板**里叫什么(2026-09-21)。没接模板服务(展示台、手机、一大批
   * 用例)时整块缺席,落回 MODULE_TITLES —— 与加模板之前逐字相同。
   *
   * 标题是**服务端拼好的**(templateStateView 已经把模板的覆盖与默认合并过一遍),
   * 这里只取不兜:合并规则写在两处必然会漂。
   */
  const titleOf = (id: string): string =>
    feed.state.template?.module_titles[id] ?? MODULE_TITLES[id as ModuleId] ?? id

  const renderModule = (
    module: LayoutModule,
    colModules: LayoutModule[],
    opts: { multi: boolean, fill?: boolean, grow?: number },
  ) => {
    const id = module.id as ModuleId
    const title = titleOf(id)
    const headingId = `ben-wb-h-${id}`
    // 窗口槽、项目区的标题是卡外一行弱字(10-22 拍板,评审页 `.slot-tabs`);窗口槽那行带「事务官」一档(「设置」只在顶栏)。
    const outside = id === 'slot' || id === 'projects'
    const slotModes = id === 'slot'
      ? (
          <span className="ben-wb__slotmodes" role="group" aria-label="窗口槽里放什么">
            {/* 读屏名带上「窗口槽」:左栏也有「事务官」,同名两颗分不清。「设置」只留顶栏那一颗(10-22 第三轮)。 */}
            {/* 「事务官」那颗键去掉了(2026-10-27 已拍板:入口只剩悬浮球)。 */}
          </span>
        )
      : undefined
    const headerWith = (aside?: ReactNode) => (
      <ModuleHeader
        title={title}
        headingId={headingId}
        draggable={!landscape || LANDSCAPE_MOVABLE_IDS.includes(id)}
        onToggleHidden={() => applyLayout(toggleHidden(layout, module.id, orientation))}
        outside={outside}
        {...(slotModes === undefined ? {} : { extra: slotModes })}
        {...(aside === undefined ? {} : { aside })}
      />
    )
    const header = headerWith()
    const basisPct = module.basis_pct ?? 20
    // 列内堆叠时,高度按"占本列总和的比例"折算——basis_pct 本来是相对整个
    // body 的,而这里的容器只有本列那么高,不折算的话两个模块加起来撑不满
    // 或者溢出。单模块列不折算,走原来的路径(旧布局零回归)。
    // fill(2026-09-18 横屏):这个模块要把它所在的那块区域**填满**,尺寸由区域自己定,
    // 不从 basis_pct/width_pct 算。横屏的五个区域大小是区域容器的事(见下面 landscapeBody),
    // 模块只管"占满我被放进去的那一格"。复用既有的 stacked 通道(flex:<n> 1 0)而不是
    // 给 ModuleBox 新加一个 prop:竖排区域里它是"占满高度",横排的底部一排里它是
    // "四格等分宽度",正好是同一条 flex 规则的两种朝向,不需要第二套代码。
    const stacked = opts.fill === true || colModules.length > 1
    const colSum = colModules.reduce((sum, m) => sum + (m.basis_pct ?? 20), 0)
    // grow(2026-09-18 底部四格之间那三根把手):fill 那一档原来恒等于 1(四格等分),
    // 现在把每格自己的 width_pct 当 flex-grow 传进来——flex-basis 是 0,所以 grow 之比
    // **就是**宽度之比,一条既有规则同时管住"拖出来的占比"和"收起一格后剩下的自动匀开"
    // (剩下几格的 grow 之和不是 100 也没关系,分的是比例不是百分数)。不传就还是 1。
    const heightPct = opts.fill === true
      ? (opts.grow ?? 1)
      : (stacked && colSum > 0 ? (basisPct / colSum) * 100 : basisPct)
    const boxProps = {
      id: module.id,
      title,
      basisPct: heightPct,
      // 并排行内改用宽度定尺;但**列内堆叠的模块不传宽度**——宽度由外层
      // 那一列统一持有,模块只管自己在列里占多高。
      ...(stacked ? { stacked: true } : {}),
      ...(opts.multi && !stacked ? { widthPct: module.width_pct ?? 50 } : {}),
      // 横屏一律不画模块自己那根底边抓手(2026-09-27,卡 LY):横屏每条边界上都已经有
      // 一根 SplitHandle,再画一根就是同一条边界上挨着的两根短横线(运营模板右侧栏三格
      // 竖排时三处成对,维护者截图),而且它改的 basis_pct 在横屏下根本不参与尺寸。
      // 竖屏原样照画 —— 那里它是唯一的调高入口。理由全文见 ModuleBox 的 noHandle 注释。
      ...(landscape ? { noHandle: true } : {}),
      dragging: draggingModuleId === module.id,
      onResizeStart: handleModuleResizeStart,
      onResizeMove: handleModuleResizeMove,
      onResizeEnd: handleModuleResizeEnd,
    }

    if (id === 'projects') {
      return (
        <ProjectsModule
          key={module.id}
          box={boxProps}
          tasksProblem={feed.state.tasks?.problem}
          header={header}
          headingId={headingId}
          portfolio={portfolio}
          expandedProjectId={expandedProjectId}
          setExpandedProjectId={setExpandedProjectId}
          handleConfirmStatus={handleConfirmStatus}
          {...(emptyOf('projects') === undefined ? {} : { empty: emptyOf('projects') as EmptyView, onEmptyAction: handleEmptyAction })}
          {...(collabOn
            ? {
                collab: (
                  <CollabZone
                    state={feed.state}
                    baseUrl={feed.baseUrl}
                    fetchImpl={serviceFetch ?? fetch}
                    presence={collabPresence}
                    visible
                    lamps={lamps}
                    onExpand={() => setCollabFull(true)}
                  />
                ),
              }
            : {})}
        />
      )
    }

    if (id === 'slot') {
      // 自定义模块(2026-09-21):标签那一半只有**竖屏**这一份 DockTabBar 画(横屏那一份被
      // 提进左侧窄栏,见下面 rail 那一段);iframe 那一半横竖都要,所以清单与选中态无条件传。
      return (
        <SlotModule
          key={module.id}
          box={boxProps}
          header={header}
          headingId={headingId}
          feed={feed}
          serviceFetch={serviceFetch}
          hoistTabs={landscape}
          slotBodyRef={slotBodyRef}
          dropHover={dropHover}
          dropFlash={dropFlash}
          butlerActive={butlerActive}
          onSelectButler={handleSelectButler}
          dockEmpty={dockEmpty}
          onLeaveButler={handleLeaveButler}
          dockDwellReadMs={dockDwellReadMs}
          onOpenConversation={openSession}
          draft={butlerDraft}
          onDraftChange={setButlerDraft}
          focusDraftAt={butlerDraftFocusAt}
          orientation={landscape ? 'landscape' : 'portrait'}
          controls={butlerControls}
          {...(landscape ? {} : { onDevTool: handleDevTool })}
          modules={customModules}
          activeModuleId={moduleActive ? activeModuleId : null}
          onSelectModule={handleSelectModule}
          onRemoveModule={handleRemoveModule}
          butlerWaiting={{ ...butlerWaiting, onOpen: () => setFocusAsk({ key: firstAskKey, at: Date.now() }) }}
          {...(focusAsk === undefined ? {} : { focusAsk })}
          butlerInFloat={butlerInFloat}
          {...(collabOn ? { onOpenCollab: () => setCollabFull(true) } : {})}
          {...(emptyOf('slot') === undefined ? {} : { empty: emptyOf('slot') as EmptyView })}
          {...(emptyOf('butler') === undefined ? {} : { butlerEmpty: emptyOf('butler') as EmptyView })}
          {...accessProps}
        />
      )
    }

    /**
     * 用户层替的那几格(2026-10-21)。`pending`:清单里有她的这一格、代码还在路上 —— 只画格子的空壳,
     * 不先闪一下本体那一版;`fallback`:没装 / 坏了 —— 本体自带的那一版,本体没有自带的就说一句人话。
     */
    const cellShell = (line?: string, action?: () => void) => (
      <ModuleBox {...boxProps}>
        <section className="ben-wb__card ben-wb__card--fill" aria-labelledby={headingId}>
          {header}
          {line !== undefined && <p className="ben-wb__module-row-note" role="status">{line}</p>}
          {action !== undefined && <button type="button" className="ben-wb__return" onClick={action}>再试一次</button>}
        </section>
      </ModuleBox>
    )
    const missingLine = (problem?: string) => problem === undefined
      ? `${title}这一格由用户层的小组件提供,这台电脑上还没装。设置 → 这台电脑 → 用户层 里看得到。`
      : `${title}这一格的小组件没装上:${problem}`
    const layerCell = (slot: 'notes' | 'files' | 'todo' | 'publish' | 'review', props: Record<string, unknown>, builtin?: (problem?: string) => ReactNode) => (
      <UserLayerCell
        key={module.id}
        registry={layer}
        slot={slot}
        templateId={feed.state.template?.id}
        // 头右端放一颗小键用(评审页「3 条记录 ›」);用户层小组件拿到就用,不拿照旧摆 header(只增不改)。
        props={{ ...props, headerWith }}
        fallback={builtin ?? ((problem, retry) => cellShell(missingLine(problem), retry))}
        pending={cellShell()}
        // 取代码没取到、在退避重试:格子里说一句「工作台这会儿忙…」,不闪本体那一版、不说「没装上」。
        retrying={message => cellShell(message)}
      />
    )

    if (id === 'usage') {
      return (
        <UsageModule
          key={module.id} box={boxProps} header={header} headingId={headingId} feed={feed} userLayer={layer}
          {...(emptyOf('usage') === undefined ? {} : { empty: emptyOf('usage') as EmptyView })}
        />
      )
    }

    if (id === 'notes') {
      return layerCell('notes', {
        box: boxProps,
        header,
        headingId,
        baseUrl: feed.baseUrl,
        fetchImpl: serviceFetch ?? fetch,
        notes: feed.state.notes ?? [],
        draft: note,
        setDraft: setNote,
        ...veilProp,
        ...(emptyOf('notes') === undefined ? {} : { empty: emptyOf('notes') as EmptyView }),
      })
    }

    if (id === 'files') {
      const filesProps = {
        box: boxProps,
        header,
        headingId,
        baseUrl: feed.baseUrl,
        fetchImpl: serviceFetch ?? fetch,
        projects: feed.state.projects?.projects ?? [],
        currentProjectId: expandedProjectId,
        ...(feed.state.template?.asset_dirs === undefined ? {} : { assetDirs: feed.state.template.asset_dirs }),
        ...(feed.state.template?.asset_files === undefined ? {} : { assetFiles: feed.state.template.asset_files }),
      }
      return layerCell('files', filesProps, () => <BuiltinFilesModule {...filesProps} />)
    }

    // —— 2026-09-21 布局模板新增的三个(运营模板用)——
    if (id === 'todo') {
      const todoProps = {
        box: boxProps,
        header,
        headingId,
        baseUrl: feed.baseUrl,
        fetchImpl: serviceFetch ?? fetch,
        tasks: feed.state.tasks?.tasks ?? [],
        lanes: feed.state.template?.board_lanes ?? [],
        // 选题上那个「账号」= 项目区那一份(运营模板下项目就是账号)。
        projects: feed.state.projects?.projects ?? [],
        // 采集没接上就连「拆解这条」那颗按钮都不画(2026-09-22)。
        collectReady: feed.state.xhs_collect !== undefined,
      }
      return layerCell('todo', todoProps, () => <BuiltinTodoModule {...todoProps} />)
    }

    // 2026-10-12 今天的待办(只在自媒体模板的排布里;读服务端切好的那一份,写走看板那三条路)。
    if (id === 'today') {
      return (
        <TodayModule
          key={module.id}
          box={boxProps}
          header={header}
          headingId={headingId}
          baseUrl={feed.baseUrl}
          fetchImpl={serviceFetch ?? fetch}
          {...(feed.state.today_todos === undefined ? {} : { view: feed.state.today_todos })}
          tasks={feed.state.tasks?.tasks ?? []}
        />
      )
    }

    if (id === 'publish') {
      return layerCell('publish', {
        box: boxProps,
        header,
        headingId,
        baseUrl: feed.baseUrl,
        fetchImpl: serviceFetch ?? fetch,
        tasks: feed.state.tasks?.tasks ?? [],
        now: feed.state.now,
        // 月历上新建那张小表单里的「账号」= 项目区那一份(同选题池)。
        projects: feed.state.projects?.projects ?? [],
      })
    }

    if (id === 'review') {
      return layerCell('review', {
        box: boxProps,
        header,
        headingId,
        baseUrl: feed.baseUrl,
        fetchImpl: serviceFetch ?? fetch,
        // 2026-09-21:`/state.xhs` 缺席 = 这台服务没接自取(展示台、手机),
        // 这一格照旧显示占位那一版。
        ...(feed.state.xhs === undefined ? {} : { xhs: feed.state.xhs }),
      })
    }

    if (id === 'quota') {
      return (
        <ModuleBox key={module.id} {...boxProps}>
          <section className="ben-wb__card ben-wb__card--fill" aria-labelledby={headingId}>
            {header}
            <QuotaPanel
              quota={feed.state.quota}
              now={feed.state.now}
              {...(feed.state.deepseek_peak === undefined ? {} : { peak: feed.state.deepseek_peak })}
              {...(feed.state.clients === undefined ? {} : { clients: feed.state.clients })}
              {...(feed.state.model_mode === undefined ? {} : { modelMode: feed.state.model_mode })}
              {...(feed.state.relay_configured === undefined ? {} : { relayConfigured: feed.state.relay_configured })}
              {...(emptyOf('quota') === undefined ? {} : { empty: emptyOf('quota') as EmptyView, onEmptyAction: handleEmptyAction })}
              onUnlock={handleUnlock}
              // 老四格之外的那几家(卡 O):Muse、Manus、豆包……每家三格之一。
              {...(feed.state.agent_quota === undefined ? {} : { agentQuota: feed.state.agent_quota })}
              // 这台电脑上真有的那几家(2026-09-27,卡 HC):服务端按探测筛过的 /state.agents。
              agents={quotaAgentIds(feed.state)}
              baseUrl={feed.baseUrl}
              fetchImpl={serviceFetch ?? fetch}
            />
          </section>
        </ModuleBox>
      )
    }

    // 认不出的 id 直接不渲染(D13 降级纪律)。sortedModules 已经按 MODULE_IDS
    // 过滤过,正常路径到不了这里——这一支只是类型上的收口。
    return null
  }

  /**
   * 横屏那一版的模块区(2026-09-18)。结构参考 Codex 早先那份原型与 Ben 的截图,
   * **只取布局,不接它的示例数据、不搬它的视觉**(黑白微光风格一字未动)。
   *
   * 五个区域,四个在这里、第五个(日结 + 事务官状态条)是下面那条既有的
   * `.ben-wb__footbar`——横竖两版共用同一条,一行没改(不可改清单第 4 条)。
   *
   *   ┌──────┬────────────────────────┬──────────────┐
   *   │ rail │        stage           │     side     │  ← 上半条,高 100-底部
   *   │ 应用栏│   窗位槽(贴原生窗)     │   项目执行    │
   *   ├──────┴────────────────────────┴──────────────┤
   *   │ 消耗数据 │ 余额/额度 │ 随手记 │ 系统文件夹  │  ← 底部一排,四格等宽
   *   └──────────────────────────────────────────────┘
   *
   * rail 里的标签栏**是从窗位槽模块里提上来的那一份**(SlotModule 的 hoistTabs),
   * 不是新画一份:两份标签栏会各自跑一遍"停留即已读"的计时器,同一枚蓝点被标两次已读。
   *
   * 槽体(`.ben-wb__slot-body`,矩形上报的唯一来源)仍然在窗位槽模块内部,位置换了、
   * 身份没换——`/slot/rect` 量的就是它此刻在页面上的真实矩形,横屏下量到的自然是
   * 中间那一大块。事务官浮窗、纯净模式、光圈都挂在模块区之外,横屏一并照常。
   */
  const landscapeBody = (() => {
    const visible = (id: ModuleId): LayoutModule | undefined => visibleModules.find(m => m.id === id)
    const slotModule = visible('slot')
    const projectsModule = visible('projects')
    // 2026-09-20:哪几格在底部一排、哪几格在右侧栏,由布局里的 region 说了算
    // (landscapeArrangement),不再是写死的那四个 id —— 上下箭头改的就是这份排布,
    // 渲染读的也是它,"点了没反应"在结构上不可能再发生。收起的仍然不画。
    const arrangement = landscapeArrangement(layout)
    const shown = (module: LayoutModule): boolean => visibleModules.some(m => m.id === module.id)
    const deckModules = arrangement.deck.filter(shown)
    // 右侧栏从上到下:项目区(钉死在最上)+ 被挪上来的那几格。
    const sideModules = arrangement.side.filter(shown)
    const sideTotal = landscapeSideTotal(layout)
    const deckPct = landscapeDeckPct(layout)
    // 上半条的高度不另存一份:恒等于 100 - 底部一排(见 layout.ts 的注释)。
    // 底部一排空了(四格全被收起,或者 2026-09-20 起全被挪进右侧栏)上半条独占整块区域,
    // 不留一条空白。
    const bandPct = deckModules.length === 0 ? 100 : 100 - deckPct
    const stageWidth = slotModule?.width_pct ?? 64
    const sideWidth = projectsModule?.width_pct ?? 36
    const fill = { multi: false, fill: true } as const
    // 上半条与底部一排之间那根 11px 的横把手**从上半条里扣**,不是加在两者之外:
    // 不扣的话两块加起来是 100% + 11px,模块区溢出,底部一排的下沿被裁掉 11px
    // (横屏下 .ben-wb__body 是 overflow:hidden,裁得无声无息)。整排收起时没有把手,
    // 也就没什么可扣的。
    const bandBasis = deckModules.length === 0 ? '100%' : `calc(${bandPct}% - 11px)`
    // 左栏:没拖过时不设行内宽度,CSS 那条 168px 原样生效(rail_pct 缺席 = 定死 168px,
    // 见 protocol.ts);拖过之后用 flex-basis 百分比顶掉它。
    const railPct = landscapeRailPct(layout)
    const railStyle = railPct === undefined ? undefined : { flex: `0 0 ${railPct}%`, width: 'auto' }

    return (
      <>
        <div className="ben-wb__land-band" ref={landBandRef} style={{ flex: `0 0 ${bandBasis}` }}>
          {/* ① 左侧窄栏:窗位应用列表(标签竖排)+ 窗口管理动作(场景条的恢复/覆盖/删除)。
              窗位槽被收起时整条不画——它是那个模块的应用栏,模块不在了它没有主人。 */}
          {slotModule !== undefined && (
            <div
              className="ben-wb__land-rail"
              data-land-region="rail"
              role="group"
              aria-label="窗位应用栏"
              {...(railStyle === undefined ? {} : { style: railStyle })}
            >
              <DockTabBar
                dock={feed.state.dock}
                sessions={feed.state.sessions}
                registry={feed.state}
                badges={feed.state.badges ?? {}}
                baseUrl={feed.baseUrl}
                fetchImpl={serviceFetch ?? fetch}
                butlerActive={butlerActive}
                onSelectButler={handleSelectButler}
                dwellReadMs={dockDwellReadMs}
                modules={customModules}
                activeModuleId={moduleActive ? activeModuleId : null}
                onSelectModule={handleSelectModule}
                onRemoveModule={handleRemoveModule}
                butlerWaiting={{ ...butlerWaiting, onOpen: () => setFocusAsk({ key: firstAskKey, at: Date.now() }) }}
                {...(feed.state.running === undefined ? {} : { running: feed.state.running })}
                showButlerTab={false}
              />
              {/* 清单为空也画这颗按钮(2026-09-20 起):0921 把「存成新布局」与那句提示
                  去掉之后,菜单里剩一句「还没有窗口布局」—— 窄栏这一档不跟着清空退场,
                  不然左栏会凭空少一格、等模板把布局带出来之后又凭空多一格。
                  整格缺席(这台服务没接 scenes)才不画。竖屏那一份的闸更严一档
                  (空清单整条不画,见 SlotModule.tsx):那边是常显的一条,不是一颗按钮。 */}
              {feed.state.scenes !== undefined && (
                <SceneBar
                  baseUrl={feed.baseUrl}
                  scenes={feed.state.scenes ?? []}
                  {...(serviceFetch === undefined ? {} : { fetchImpl: serviceFetch })}
                  // 左栏窄(默认 168px,拖过之后按 rail_pct 走,最窄 5%),一行放不下
                  // 「名字 + 恢复 + 覆盖保存 + 删除」—— 2026-09-18 Ben 截图第一处就是
                  // 它被挤成两行、名字截掉半个字、「删除」整颗掉到栏外。收成图标菜单。
                  // **不随左栏拖宽而展开**:同一条栏在两种宽度下长两个样,拖动过程中会
                  // 当场变形,而 compact 那个面板里三颗动作一颗不少,没有信息损失。
                  compact
                />
              )}
              {/* 「开发一个小工具」(2026-09-20,Ben:「横版在底部」)。画在**栏的最后一个孩子**、
                  场景菜单之下 —— 场景菜单管的是"把已经认领的窗摆回去",这一颗管的是
                  "这儿还什么都没有,去造一个",两件事之间那条界线正好落在栏底。
                  CSS 里它带 margin-top:auto,栏再高也贴着底边(devToolStyle.ts)。
                  **不塞进上面那份 DockTabBar**:窄栏里标签那一排是可滚动的竖排
                  (style.ts 的 .ben-wb__land-rail .ben-wb__dock-tabs),跟着滚就不叫"在底部"了。 */}
              {/* 「它学到了什么」(2026-10-21,视觉 A):三行点列;标题键开设置里那一节。取不到整块缺席。 */}
              <LearnRail
                baseUrl={feed.baseUrl}
                {...(serviceFetch === undefined ? {} : { fetchImpl: serviceFetch })}
                onOpen={() => { setSettingsAt({ group: 'butler', row: 'habits' }); setSettingsOpen(true) }}
              />
              <DevToolButton onClick={handleDevTool} />
            </div>
          )}
          {/* 左栏与中区之间那根竖把手(2026-09-18 Ben 截图第一处:这条边界原来没有把手,
              左栏定死 168px 拖不动)。改的是 landscape.rail_pct —— 它不参与中区/右栏
              那对零和的宽度分配:拖宽左栏是中区与右栏**一起**让,两者之间的占比不变。
              左栏在才画(窗位槽收起时整条栏没有主人,也就没有这条边界)。 */}
          {slotModule !== undefined && (
            <SplitHandle
              axis="vertical"
              label={`调整 窗位应用栏 与 ${titleOf('slot')} 的宽度占比`}
              dragging={draggingSplitId === 'rail'}
              onResizeStart={event => handleSplitResizeStart(event, 'rail', 'slot', 'rail')}
              onResizeMove={handleSplitResizeMove}
              onResizeEnd={handleSplitResizeEnd}
            />
          )}
          {/* ② 中间大区:窗位槽,占最大的那一块。 */}
          {slotModule !== undefined && (
            <div
              className="ben-wb__land-stage"
              data-land-region="stage"
              style={{ flex: `1 1 ${stageWidth}%`, minWidth: 0 }}
            >
              {renderModule(slotModule, [slotModule], fill)}
            </div>
          )}
          {/* 中区与右栏之间那根竖拖拽条:复用竖屏顶部分栏那一套(resizeRowPair 改 width_pct),
              不新造一种交互。两块都在才画——只剩一块时没有"占比"可言。
              这是 2026-09-18 之前横屏上**唯一**一根把手,现在它只是四根里的一根,
              画法也换成了跟另外三根同一个组件。 */}
          {slotModule !== undefined && sideModules.length > 0 && (
            <SplitHandle
              axis="vertical"
              label={`调整 ${titleOf('slot')} 与 ${titleOf('projects')} 的宽度占比`}
              dragging={draggingSplitId === 'slot'}
              onResizeStart={event => handleSplitResizeStart(event, 'slot', 'projects')}
              onResizeMove={handleSplitResizeMove}
              onResizeEnd={handleSplitResizeEnd}
            />
          )}
          {/* ③ 右侧栏:项目执行(项目区,内含看板/冲刺/文件那几个现有模块),
              **以及 2026-09-20 起被上箭头挪上来的那几格**(竖排,接在项目区下面)。
              各格高度按自己的 side_pct 当 flex-grow 分——同底部一排那条既有规则
              (grow 之比就是尺寸之比),只是朝向从横的换成竖的。 */}
          {sideModules.length > 0 && (
            <div
              className="ben-wb__land-side"
              data-land-region="side"
              style={{ flex: `1 1 ${sideWidth}%`, minWidth: 0 }}
            >
              {sideModules.map((module, index) => {
                const next = sideModules[index + 1]
                return (
                  <Fragment key={module.id}>
                    {renderModule(module, [module], { ...fill, grow: landscapeSidePct(layout, module.id) })}
                    {/* 上下两格之间那根横把手。跟底部两格之间那根竖把手是同一个组件、
                        同一条"两格之和恒定"的规则,只是朝向不同——四条边界是同一种东西。
                        最下那格下面没有下一格,不画(那儿是「主区 | 底部一排」那条边界)。 */}
                    {next !== undefined && (
                      <SplitHandle
                        axis="horizontal"
                        label={`调整 ${titleOf(module.id)} 与 ${titleOf(next.id)} 的高度占比`}
                        dragging={draggingSplitId === `side:${module.id}`}
                        onResizeStart={event => handleSplitResizeStart(event, module.id, next.id, 'side-pair', `side:${module.id}`)}
                        onResizeMove={handleSplitResizeMove}
                        onResizeEnd={handleSplitResizeEnd}
                      />
                    )}
                  </Fragment>
                )
              })}
            </div>
          )}
        </div>
        {/* 主区与底部一排之间那根横把手(2026-09-18 Ben 截图第三处)。拖的是底部一排多高
            ——横屏整块模块区只有这一个可拖的高度(中间那一大条 = 100 - 它,不另存一份,
            见 layout.ts 的注释)。往下拖 = 底部变矮、中间变高,跟手上的方向一致。 */}
        {deckModules.length > 0 && (
          <SplitHandle
            axis="horizontal"
            label="调整 主区 与 底部一排 的高度占比"
            dragging={draggingSplitId === 'deck'}
            onResizeStart={event => handleSplitResizeStart(event, 'deck', 'deck', 'deck-height')}
            onResizeMove={handleSplitResizeMove}
            onResizeEnd={handleSplitResizeEnd}
          />
        )}
        {/* ④ 底部一排:四格,宽度按各自的 width_pct(renderModule 的 grow)。
            用户收起其中几格时剩下的自动匀分,不留空位。 */}
        {deckModules.length > 0 && (
          <div className="ben-wb__land-deck" data-land-region="deck" style={{ flex: `0 0 ${deckPct}%` }}>
            {deckModules.map((module, index) => {
              const next = deckModules[index + 1]
              return (
                <Fragment key={module.id}>
                  {renderModule(module, [module], { ...fill, grow: landscapeDeckWidth(layout, module.id) })}
                  {/* 相邻两格之间那根竖把手(2026-09-18 Ben 截图第二处:底部四格之间原来
                      一根都没有)。只在这两格之间倒腾、两格之和恒定——不是 100 的零和,
                      所以走的是 resizeLandscapeDeckPair 而不是 resizeRowPair(理由见那个
                      函数的注释)。最后一格右边没有下一格,不画。 */}
                  {next !== undefined && (
                    <SplitHandle
                      axis="vertical"
                      label={`调整 ${titleOf(module.id)} 与 ${titleOf(next.id)} 的宽度占比`}
                      dragging={draggingSplitId === `deck:${module.id}`}
                      onResizeStart={event => handleSplitResizeStart(event, module.id, next.id, 'deck-pair', `deck:${module.id}`)}
                      onResizeMove={handleSplitResizeMove}
                      onResizeEnd={handleSplitResizeEnd}
                    />
                  )}
                </Fragment>
              )
            })}
          </div>
        )}
      </>
    )
  })()

  return (
    <MeNameProvider name={feed.state.me?.name}>
    <main
      className="ben-wb"
      aria-label={WORKBENCH_TITLE}
      data-pure={pureMode}
      data-orientation={orientation}
      // 哪一套布局(2026-10-04,运营同学那套黑紫皮肤合入时加的那条接缝)。
      // 他 10-03/10-04 那一大段 `.ben-wb{…}` 全局样式**只给自媒体(运营)布局** —— 维护者原话:
      // 产品研发布局一个像素都不许被它改到。作用域就挂在这一格上(`client/opsThemeStyle.ts`
      // 里全是 `.ben-wb[data-template=ops] …`)。判据用现成的那一处(`/state.template.id` 与
      // templates.ts 的模板 id),不另造一张表(同 UsageModule.tsx 的 usesAirUsagePanel)。
      // **模板整块缺席就整个不写这一格** —— 缺席按缺省模板(product)算,于是展示台、手机、
      // 老客户端、一大批用例里一个字都不变。
      {...(feed.state.template === undefined ? {} : { 'data-template': feed.state.template.id })}
      // 在壳里(卡 TB):内容顶到窗顶(顶部不留内边距)、顶栏左边给红绿灯让位。样式在 style.ts。
      {...(shellMode ? { 'data-shell': 'app' } : {})}
      // 横屏浮窗默认落点那个 CSS 变量(见上面 landButlerBottomPx 的注释)。量不到时
      // 整个不设,style.ts 里的 fallback(16px)原样生效——不写一个猜出来的数进去。
      {...(landButlerBottomPx === undefined
        ? {}
        : { style: { '--ben-wb-land-butler-bottom': `${landButlerBottomPx}px` } as CSSProperties })}
    >
      <style>{STYLE}</style>
      {/*
        当前模板那一层皮肤(2026-10-04 起;2026-10-23 分层二刀二后**本体不再内置**,从用户层
        `布局/<id>.json` 声明的 .css 经 `/user-layer/layouts/<id>/skin` 装进 `useUserLayerSkin`)。

        只在「这份模板带了皮肤」时注入。皮肤文件自己的约定是每条选择器都从
        `.ben-wb[data-template=<模板id>]` 起头(格式写进用户层目录里的 契约.md),所以落不到
        别的模板那一档;没有皮肤的模板(如做产品)什么都不注入 —— **她那一档不该为他那一层
        付任何代价**(两百多条规则留在表里,浏览器每次算样式都要一条条比,是白费的开销)。
      */}
      {userLayerSkin !== undefined && <style>{userLayerSkin}</style>}
      <div className="ben-wb__inner">
        {/* 2026-09-25(卡 TB,维护者「顶部空隙难受」):**页头那一行整块没了**。
            原来这里是 22px 的「工作台」+ 副标题 + 右上角两颗键,上面还压着壳自己的窗口标题栏,
            顶上白白叠两三层。现在壳的标题栏透明(workbench-app/Sources/TitleBar.swift),下面这条
            TopBar 就是窗口的顶栏:标题缩成它左边的小字,「恢复默认布局」「返回对话」搬到它右端。 */}
        <TopBar
          // 协作区在时,接入的那几家只在它「成员」那排出现(10-22 第三轮),顶栏那一排不画;没有协作区时照旧在顶栏。
          lamps={collabOn ? [] : lamps}
          agentCount={agentCount}
          {...(agentHint === undefined ? {} : { agentHint })}
          talk={{ baseUrl: feed.baseUrl, fetchImpl: serviceFetch ?? fetch }}
          // 顶栏上的浮层(点「N 家」那张登记表、悬停小灯那张)一开就让窗位里那扇真窗让路,
          // 关掉就回来(卡 TB2;不在壳里时 veilProp 是空的,什么都不发)。
          {...veilProp}
          now={topClockText(feed.state.now)}
          storage={storageWidget}
          performance={performanceWidget}
          onOpenSettings={() => setSettingsOpen(true)}
          onOpenLearned={() => { setSettingsAt({ group: 'butler', row: 'habits' }); setSettingsOpen(true) }}
          pureMode={pureMode}
          onTogglePureMode={handleTogglePureMode}
          {...(quotaSummary === undefined ? {} : { quotaSummary })}
          // 壳模式(spec W2)下没有「返回对话」这一说——DSH 的对话界面不在这个壳里。
          {...(shellMode ? {} : { onReturn: actions.close })}
          onResetLayout={() => setResetAsk(true)}
          // 在壳里:这一条就是窗口的标题栏(左边留红绿灯的位置、空白处按住能拖)。
          shell={shellMode}
          // 有新版就在齿轮上打个点(2026-09-18 热更新)。**不弹窗** —— 后台一天查一次,
          // 点着的时候进设置就能看到「更新」那一节。没查过时这一格缺席,自然也没有点。
          updateDot={feed.state.update?.available === true}
        />

        {/* 还差什么(2026-09-17):缺授权 / 缺密钥各一条细横幅,不拦路,各自带着去那儿的路。
            数据是 /state.setup_alerts(上一次体检的结论),还没体检过时整块缺席。
            卡 TB 起排在顶栏**下面** —— 顶栏要贴着窗顶,横幅不能插在它上面。 */}
        <div hidden={pureMode}>
          <NeedBar
            baseUrl={feed.baseUrl}
            {...(serviceFetch === undefined ? {} : { fetchImpl: serviceFetch })}
            {...(feed.state.setup_alerts === undefined ? {} : { alerts: feed.state.setup_alerts })}
            onOpenSettings={() => setSettingsOpen(true)}
          />
        </div>

        {/* 纯净模式(2026-09-11,Ben:「全屏幕只有一个球,事项卡片都不留」):正文就是这一份
            事务官档(同一个组件,pure 形态:一颗放大居中的球 + 「在办 n · 等你 m」)。点球临时
            展开卡片堆与输入框盖在球上,Esc / 点空白收回。下面的模块网格与底栏都还挂着,
            只是 hidden——切回完整时原样回来,布局一字没动。 */}
        {pureMode && (
          <div className="ben-wb__pure">
            <ButlerInbox
              state={feed.state}
              baseUrl={feed.baseUrl}
              fetchImpl={serviceFetch ?? fetch}
              onOpenConversation={openSession}
              draft={butlerDraft}
              onDraftChange={setButlerDraft}
              visible
              controls={butlerControls}
              pure
              pureExpanded={pureExpanded}
              onPureExpand={() => setPureExpanded(true)}
              onPureCollapse={() => setPureExpanded(false)}
              orientation={landscape ? 'landscape' : 'portrait'}
              {...(focusAsk === undefined ? {} : { focusAsk })}
              {...(emptyOf('butler') === undefined ? {} : { empty: emptyOf('butler') as EmptyView })}
            />
          </div>
        )}

        {/* 架构约束 C1(Agent 层挂掉时看板必须继续显示并明示"Agent 掉线")：这条提示原来
            挂在会话区顶部(SessionFeed 的 .ben-wb__offline)，A3 起会话区整块下线，挪到
            这里——C1 是先于 A3 就定的硬约束，不能因为宿主模块被拆掉就一起消失。 */}
        {feed.state.stale && (
          <p className="ben-wb__offline" role="status">Agent 掉线 · 下面是最后一次已知状态</p>
        )}

        {/* 2026-10-13:顶条下面那条固定通知行(`.ben-wb__fixedalerts`)**整块没了**。
            维护者看着真机截图问「顶部这个黄色框是啥意思」—— 那一行只画被收起模块里
            上浮上来的**项目名**,一个字不说为什么,屏上就是一条琥珀描边里的三个字。
            退休的理由(以及"要让收起的信号继续说话该接在哪儿")记在 layout.ts 里
            原 hoistedAlerts 那一处。下面这条还原钮一行原样留着 —— 展开的路没动。 */}

        {/* 这一条现在只剩「已收起的模块」还原钮;没有收起任何模块时整条不渲染,
            不再白占一行(「恢复默认布局」已挪到页头右上角)。 */}
        <div className="ben-wb__layoutbar" hidden={hiddenModules.length === 0 || pureMode}>
          {hiddenModules.length > 0 && (
            <div className="ben-wb__hiddenmods" role="group" aria-label="已收起的模块">
              {hiddenModules.map((module) => {
                const title = titleOf(module.id)
                return (
                  <button
                    key={module.id}
                    type="button"
                    className="ben-wb__hiddenmod"
                    aria-label={`${title} 展开`}
                    onClick={() => applyLayout(toggleHidden(layout, module.id, orientation))}
                  >
                    {title} 展开
                  </button>
                )
              })}
            </div>
          )}
        </div>

        {state.error !== null && <div className="ben-wb__alert" role="alert">{state.error}</div>}

        {phase !== 'ready' ? <div className="ben-wb__loading">正在读取 DSH 项目…</div> : (
          <div className="ben-wb__body" ref={moduleBodyRef} hidden={pureMode} data-orientation={orientation}>
            {landscape ? landscapeBody : moduleRows.map((rowCols) => {
              // 行/列的 key 一律用**其中第一个模块的 id**,不用下标。下标会随模块数量
              // 变化(比如布局里少了 usage/quota)而改变,key 一变 React 就把整行重新
              // 挂载——真机/测试实证:拿到手的节点会变成游离节点、样式停在旧值,窗位
              // 还要跟着重新量矩形。模块 id 才是稳定身份。
              const rowKey = `row-${rowCols[0]?.[0]?.id ?? 'empty'}`
              const multi = rowCols.length > 1 || (rowCols[0]?.length ?? 0) > 1
              // 行高 = 各列所需高度的最大值;一列的所需高度 = 列内各模块 basis 之和
              // (它们是竖着摞起来的,不是并排)。
              const colHeight = (col: LayoutModule[]): number =>
                col.reduce((sum, module) => sum + (module.basis_pct ?? 20), 0)
              const rowHeight = Math.max(...rowCols.map(colHeight))

              // 单模块行不套任何容器,DOM 与改造前完全一致(旧布局零回归)。
              // **必须用带 key 的 Fragment 包起来**:直接 return 数组的话,外层
              // moduleRows.map 产出的这一项没有 key,React 无法稳定协调,任何一次
              // 布局变化都会把所有模块整个重新挂载——真机/测试实证:拿到手的节点会
              // 变成游离节点(styles 停在旧值),窗位还要跟着重新量矩形。
              if (!multi) {
                return (
                  <Fragment key={rowKey}>
                    {rowCols.flat().map(module => renderModule(module, [module], { multi }))}
                  </Fragment>
                )
              }

              // 每一列:列内多于一个模块时套一层竖向容器(上下堆叠),
              // 宽度由这一列统一持有;单模块列直接就是那个模块自己。
              const renderedCols = rowCols.map((colModules) => {
                const head = colModules[0]
                if (head === undefined) return null
                const widthPct = head.width_pct ?? Math.round(100 / rowCols.length)
                if (colModules.length === 1) return renderModule(head, colModules, { multi })
                return (
                  <div
                    className="ben-wb__col"
                    key={`col-${head.id}`}
                    style={{ flex: `0 1 ${widthPct}%`, minWidth: 0 }} // 0 1:两列之间那根 11px 拖拽条要从两列里匀出来,否则整行比容器宽 11px、右列被裁(2026-09-14 Ben)
                  >
                    {colModules.map(module => renderModule(module, colModules, { multi }))}
                  </div>
                )
              })

              // 相邻两列之间插一根竖向拖拽条,可以调左右占比(Ben 反馈要能自己调)。
              const withSplits: ReactNode[] = []
              renderedCols.forEach((node, index) => {
                if (index > 0) {
                  const leftId = rowCols[index - 1]?.[0]?.id ?? ''
                  const rightId = rowCols[index]?.[0]?.id ?? ''
                  // 2026-09-18:这一处原来是一段内联的 `<div className="ben-wb__split">`,
                  // 跟横屏那根几乎一模一样。换成共用的 SplitHandle —— 竖屏的**行为、
                  // 落盘、视觉一个字没变**(同一套类名与结构),变的只是"这份 DOM 现在
                  // 只有一处定义"。横屏要加三根把手,再抄一遍就是六份同样的东西。
                  withSplits.push(
                    <SplitHandle
                      key={`split-${leftId}-${rightId}`}
                      axis="vertical"
                      label={`调整 ${titleOf(leftId)} 与 ${titleOf(rightId)} 的宽度占比`}
                      dragging={draggingSplitId === leftId}
                      onResizeStart={event => handleSplitResizeStart(event, leftId, rightId)}
                      onResizeMove={handleSplitResizeMove}
                      onResizeEnd={handleSplitResizeEnd}
                    />,
                  )
                }
                withSplits.push(node)
              })

              return (
                <div className="ben-wb__row" key={rowKey} style={{ flex: `0 0 ${rowHeight}%` }}>
                  {withSplits}
                </div>
              )
            })}
          </div>
        )}

        {/* 底部条：日结 + AI 悬浮窗。两者都在不可改清单里（PRD §9） */}
        <div className="ben-wb__footbar" data-land-region="foot" hidden={pureMode}>
          <DailyBar daily={feed.state.daily} {...veilProp} />
          <span className="ben-wb__lock">▮ AI 悬浮窗（收起）— 不可改</span>
        </div>
      </div>

      {/* 初始化页(2026-09-17 登录台):整页盖在看板上,不是弹窗 —— 它要装的东西太多,
          一个小对话框装不下,而且第一次开机时看板本来也没什么可看的。 */}
      {setupOpen && (
        <SetupPage
          baseUrl={feed.baseUrl}
          {...(serviceFetch === undefined ? {} : { fetchImpl: serviceFetch })}
          state={feed.state}
          onClose={() => setSetupOpen(false)}
        />
      )}

      {/* 「全部接上」(2026-09-25):Claude、Codex 并成一个框,先看后写、一次写入、每家仍能单独撤回。
          整套流程在 ConnectAllDialog 里;开着时窗位让路(同设置弹窗)。 */}
      {connectAllOpen && (
        <ConnectAllDialog
          baseUrl={feed.baseUrl}
          {...(serviceFetch === undefined ? {} : { fetchImpl: serviceFetch })}
          {...veilProp}
          onClose={() => setConnectAllOpen(false)}
        />
      )}

      {/* 「点一下,工作台帮你接上」(2026-09-17 Ben 拍板)。先看后写、写完能撤回,
          整套流程在 HooksApplyDialog 里;这里只管它开着没有。 */}
      {hooksApplyFor !== undefined && (
        <HooksApplyDialog
          agent={hooksApplyFor}
          baseUrl={feed.baseUrl}
          {...(serviceFetch === undefined ? {} : { fetchImpl: serviceFetch })}
          onClose={() => setHooksApplyFor(undefined)}
        />
      )}

      {collabFull && collabOn && (
        <div className="ben-wb__collab-full" role="dialog" aria-modal="true" aria-label="协作区全屏">
          <CollabZone
            state={feed.state}
            baseUrl={feed.baseUrl}
            fetchImpl={serviceFetch ?? fetch}
            presence={collabPresence}
            visible
            lamps={lamps}
            {...(collabLocate === undefined ? {} : { locate: collabLocate })}
            onExitFull={() => setCollabFull(false)}
          />
        </div>
      )}

      {resetAsk && (
        <ConfirmDialog
          title={CONFIRMS.restoreLayout.title}
          body={CONFIRMS.restoreLayout.body}
          confirm={CONFIRMS.restoreLayout.confirm}
          {...veilProp}
          onConfirm={() => { setResetAsk(false); handleResetLayout() }}
          onCancel={() => setResetAsk(false)}
        />
      )}

      {settingsOpen && (
        <SettingsDialog
          baseUrl={feed.baseUrl}
          onOpenSetup={() => setSetupOpen(true)}
          onReplayFirstRun={handleReplayFirstRun}
          onRedoOnboarding={handleRedoOnboarding}
          {...(account?.enabled === true ? { account: account.view } : {})}
          onAccountChanged={() => setAccountNonce(n => n + 1)}
          {...(serviceFetch === undefined ? {} : { fetchImpl: serviceFetch })}
          {...(feed.state.deepseek_peak === undefined ? {} : { peak: feed.state.deepseek_peak })}
          {...(feed.state.experiments === undefined ? {} : { experiments: feed.state.experiments })}
          {...(feed.state.relay_configured === undefined ? {} : { relayConfigured: feed.state.relay_configured })}
          {...(feed.state.today_todos === undefined ? {} : { todayView: feed.state.today_todos.style ?? 'flat' })}
          {...(feed.state.xhs === undefined
            ? {}
            // 设置里那一栏要能列出每个账号(2026-09-22 多账号),所以把 accounts 也递进去。
            : { xhs: { ...feed.state.xhs.login, accounts: feed.state.xhs.accounts } })}
          {...(feed.state.xhs_collect === undefined
            ? {}
            : { collect: {
                today: feed.state.xhs_collect.today,
                daily_max: feed.state.xhs_collect.daily_max,
                workdir_ready: feed.state.xhs_collect.workdir_ready,
                ...(feed.state.xhs_collect.tools === undefined ? {} : { tools: feed.state.xhs_collect.tools }),
              } })}
          {...(feed.state.butler === undefined ? {} : { butler: feed.state.butler })}
          {...(feed.state.meetings === undefined ? {} : { meetings: feed.state.meetings })}
          {...(feed.state.connector === undefined ? {} : { connector: feed.state.connector })}
          {...(feed.state.lan === undefined
            ? {}
            : {
                devices: {
                  lan: feed.state.lan,
                  ...(feed.state.pairing === undefined ? {} : { pairing: feed.state.pairing }),
                  devices: feed.state.devices ?? [],
                },
              })}
          {...(feed.state.update?.current === undefined ? {} : { currentVersion: feed.state.update.current })}
          {...(feed.state.update?.runtime_stale === undefined ? {} : { runtimeStale: feed.state.update.runtime_stale })}
          {...(settingsAt === undefined
            ? {}
            // 这一次开在哪一节、哪一行(卡 QK)。缺席 = 默认那一组,与这一版之前一字不差。
            : { openAt: settingsAt })}
          onClose={() => setSettingsOpen(false)}
          {...veilProp}
        />
      )}

      {/* 事务官浮窗(spec D11，不可改清单第 1 条)：故意放在模块渲染循环之外、独立挂载——
          不进 layout.modules，代码层面没有一条路径能让它随模块一起被隐藏/删除。 */}
      <Butler
        conclusions={conclusions}
        corner={layout.butler.corner}
        min={layout.butler.min}
        narrowForced={false}
        hidden={butlerFloatHidden}
        // 落点按方向各读各的(2026-09-18):横屏读 landscape.butler_pos,竖屏读
        // butler.pos。横屏那份缺席时**不传 pos**,浮窗走 CSS 的角落规则 —— 而横屏的
        // 角落规则被 --ben-wb-land-butler-bottom 抬到了底部四格之上(style.ts)。
        {...(butlerPosOf(layout, orientation) === undefined
          ? {}
          : { pos: butlerPosOf(layout, orientation) as { x_pct: number, y_pct: number } })}
        {...(layout.butler.size === undefined ? {} : { size: layout.butler.size })}
        paused={feed.state.paused ?? false}
        testRinging={feed.state.test_ringing ?? false}
        onToggleMin={handleToggleButlerMin}
        onMove={handleButlerMove}
        onResize={handleButlerResize}
        onPause={handlePause}
        onTestRing={handleTestRing}
        {...(feed.state.brief === undefined ? {} : { brief: feed.state.brief })}
        onDismissBrief={handleDismissBrief}
        onAsk={handleAsk}
        {...(feed.state.sentinel === undefined ? {} : { sentinel: feed.state.sentinel })}
        onCancelWatch={handleCancelWatch}
        {...(butlerVeil === undefined ? {} : { veil: butlerVeil })}
        // 收起的球带状态(2026-10-27,合并稿 5.1);在跑那一件数与展开窗同读 /collab/runs 一本账(10-28,口径在 runningCountOf)。点角标 = 展开浮窗。
        orb={floatOrbView(feed.state, runFacts)}
        onOpenAsks={() => applyButlerMin(false)}
        // 浮窗里放的就是窗口槽里那页事务官(10-22 第三轮,同一个组件两个入口);窗口槽那页露着时浮窗藏起来,
        // 所以只在浮窗露着时挂这一份,两份不会同时跑。
        {...(!butlerInFloat ? {} : {
          page: (
            <ButlerInbox
              state={feed.state}
              baseUrl={feed.baseUrl}
              fetchImpl={serviceFetch ?? fetch}
              onOpenConversation={openSession}
              draft={butlerDraft}
              onDraftChange={setButlerDraft}
              visible
              controls={butlerControls}
              orientation={landscape ? 'landscape' : 'portrait'}
              {...(focusAsk === undefined ? {} : { focusAsk })}
              {...(emptyOf('butler') === undefined ? {} : { empty: emptyOf('butler') as EmptyView })}
              focusDraftAt={butlerDraftFocusAt}
              compact
              onLocate={(id) => { setCollabFull(true); setCollabLocate({ id, at: Date.now() }); applyButlerMin(true) }}
            />
          ),
        })}
      />
      {/* 事务官动了哪一块:那一块旁边一行字(卡 P 补三)。纯净模式、那一块收起了就不画。 */}
      <ActorNotes notes={actorNotes} pureMode={pureMode} visibleModuleIds={visibleModuleIds} />
    </main>
    </MeNameProvider>
  )
}

/**
 * W4 套娃防护。**2026-09-10 起这条路已经不存在**:事务官标签内嵌 DSH 页面的那个 iframe
 * 随事项收件箱一起下线了,没有任何地方再把工作台套进自己。这层薄壳留着是**便宜的兜底**
 * ——将来谁又在某处嵌一次同源页面(store 的 init 是 open:true,嵌进去就会再挂一遍
 * overlay),这里仍然挡得住;删掉它省不下什么,踩上去却是无限递归。
 *
 * 用一层薄壳挡,而不是在 Inner 里提前 return:提前 return 会让 Inner 在"不是顶层"那一
 * 支上一个 hook 都不调用,违反 React 的 hook 规则(即便 window.self/top 在组件生命周期
 * 内不会变、实际不会出事,那也是靠"恰好稳定"过关,lint 与后来的读者都有理由怀疑)。
 * 薄壳里没有任何 hook,条件返回天然合法;Inner 要么整个不挂载,要么正常跑完全部 hook。
 */
export function WorkbenchOverlay(props: WorkbenchOverlayProps) {
  if (!isTopFrame(window.self, window.top)) return null
  return <WorkbenchOverlayInner {...props} />
}

/**
 * DSH 原始界面左上角那颗「‹ 回工作台」(2026-09-25,卡 M)。工作台浮层关着时才出现;
 * 浮层那一层默认点不中(上游 shell.overlay 是 click-through),它自己把点击要回来(见 askStyle.ts)。
 */
export function ReturnToWorkbench({ onReturn }: { onReturn: () => void }) {
  return (
    <>
      <style>{RETURN_PILL_STYLE}</style>
      <button type="button" className="ben-wb-return" onClick={onReturn} aria-label={`回${WORKBENCH_TITLE}`}>
        <span aria-hidden="true">‹</span>回{WORKBENCH_TITLE}
      </button>
    </>
  )
}

/** Sidebar action that restores the Workbench after entering native DSH. */
export function WorkbenchButton({ wide, useStore, actions }: WorkbenchButtonProps) {
  const open = useStore(state => state.open)
  return (
    <>
      <style>{STYLE}</style>
      <button
        type="button"
        className="ben-wb-button"
        data-open={open}
        aria-label={`打开${WORKBENCH_TITLE}`}
        onClick={actions.open}
      >
        <span className="ben-wb-button__icon" aria-hidden="true">W</span>
        {wide && <span className="ben-wb-button__label">工作台</span>}
      </button>
    </>
  )
}
