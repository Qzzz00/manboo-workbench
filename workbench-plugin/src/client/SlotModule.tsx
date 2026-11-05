/**
 * 由 Workbench.tsx 的模块渲染循环拆出(2026-08-25 地基:六窗口并行前的接缝切分)。
 * **JSX 逐字搬运,没有改一行行为**——四块需求本来都要改同一个 1190 行文件,
 * 拆成"一个模块一个文件"之后各窗口各改各的,合并时不再互相踩。
 *
 * 2026-08-25 版面重排:删掉了"日历借用 slot 位置展开"那条分支(spec D10)。工作台自带
 * 的日历整块下线——应用区已经能认领系统日历,不需要再自带一个。这是本次唯一动这个文件
 * 的地方,别的一行没改。服务端的 calendar 采样与 protocol 的 calendar 字段都保留:
 * 那是与展示台的三方契约,只删客户端 UI。
 */

import { useRef, type ReactNode, type RefObject } from 'react'
import type { CustomModuleView, WorkbenchState } from '../protocol.ts'
import { ModuleBox, type ModuleBoxProps } from './ModuleBox.tsx'
import { DockTabBar } from './DockTabBar.tsx'
import { SceneBar } from './SceneBar.tsx'
import { SlotZone } from './SlotZone.tsx'
import { CustomModuleFrame } from './CustomModuleFrame.tsx'
import { ButlerInbox, type ButlerControls } from './ButlerInbox.tsx'
import { showVeilPlaceholder, useVeilActive } from './useVeilSlot.ts'
import { useAvoidFloat } from './useAvoidFloat.ts'
import { postSilently } from './postSilently.ts'
import type { EmptyView } from './emptyState.ts'
import type { AccessNotice } from './accessNotice.ts'

export function SlotModule({
  box, header, headingId, feed, serviceFetch, slotBodyRef, dropHover, dropFlash = false,
  butlerActive, onSelectButler, dockEmpty, onLeaveButler, dockDwellReadMs, onOpenConversation,
  draft, onDraftChange, focusDraftAt, controls, hoistTabs, empty, butlerEmpty, access, onAuthorize, accessError,
  orientation, butlerInFloat,
  onDevTool, modules, activeModuleId, onSelectModule, onRemoveModule, butlerWaiting, focusAsk, onOpenCollab,
}: {
  /** 那页事务官此刻在浮窗里(浮窗露着且展开):这里就不挂(同一份只挂一处)。 */
  butlerInFloat?: boolean
  /** 窗口槽空着时那一句里的「打开协作区」(2026-10-27)。缺席不画那颗键。 */
  onOpenCollab?: () => void
  /** 「事务官」标签上的气泡(2026-09-25,卡 M)。原样转发给 DockTabBar。 */
  butlerWaiting?: { count: number, lines: readonly string[], onOpen: () => void }
  /** 把「要你看的」摊开到哪一张(2026-09-25,卡 M)。原样转发给 ButlerInbox。 */
  focusAsk?: { key: string, at: number }
  box: ModuleBoxProps
  header: ReactNode
  headingId: string
  feed: { state: WorkbenchState, baseUrl: string }
  serviceFetch: typeof fetch | undefined
  /** 「看过了就该灭」的停留阈值,原样转发给 DockTabBar(SlotModule 只是管道)。 */
  dockDwellReadMs: number | undefined
  slotBodyRef: RefObject<HTMLDivElement>
  dropHover: boolean
  /** 窗口槽那圈流线光此刻亮不亮(只在真拖进新应用、放手那一下,2026-09-25 卡 P)。原样转发给 SlotZone。 */
  dropFlash?: boolean
  /** W4:「事务官」标签是否选中,原样转发给 DockTabBar——SlotModule 只是管道,
   *  不编造这个值(真值来自 Workbench.tsx,Task 3 前是占位)。 */
  butlerActive: boolean
  /** W4:点「事务官」的回调,原样转发给 DockTabBar。 */
  onSelectButler: () => void
  /** C1:叠里一个成员都没有(接了 dockService 但还没认领过谁)。真值由 Workbench.tsx
   *  算(它同时用这个判定驱动 butlerActive),这里不自己再算一遍,免得两处走漂。 */
  dockEmpty: boolean
  /** C1:「回到窗位落点」——叠为空且选中事务官时,标签栏只剩「事务官」一格,这是回去的路。 */
  onLeaveButler: () => void
  /** 点开某条事项底下那段对话(2026-09-10 事项收件箱)。原样转发,SlotModule 只是管道。 */
  onOpenConversation: (sessionId: string) => void
  /**
   * 事务官档输入框的草稿(2026-09-11 起由 Workbench 持有):事务官档在两处渲染——这里那一档,
   * 与纯净模式整屏那一份——同一句没发出去的话在两处都得在。原样转发。
   */
  draft: string
  onDraftChange: (next: string) => void
  /** 「把光标送进输入框」的计数器(2026-09-20「开发一个小工具」)。原样转发给 ButlerInbox。 */
  focusDraftAt?: number | undefined
  /**
   * 这会儿按哪一版排布(2026-09-22「用自然语言改布局」)。管道原样转发给 ButlerInbox,
   * 自己不判断 —— 同这个文件里别的几个可选 prop 的做法。
   */
  orientation?: 'portrait' | 'landscape'
  /** 「开发一个小工具」点下去做什么(2026-09-20)。原样转发给 DockTabBar——横屏下这一份
   *  标签栏根本不挂(hoistTabs),那颗按钮由 Workbench 画在左侧窄栏的栏底。 */
  onDevTool?: (() => void) | undefined
  /** 浮窗搬进事务官档的那几样(全部暂停/试铃/在盯着的事/提议/快报)。原样转发。 */
  controls: ButlerControls
  /**
   * 横屏(2026-09-18):标签栏与场景条已经由 Workbench 画在左侧那条窄栏里了,这里就不再画
   * 第二份。**不是"藏起来"而是"根本不挂"**——两份 DockTabBar 会各跑一遍"停留即已读"
   * 的计时器(useDwellAutoRead),同一枚蓝点被标两次已读,是真会发出去的重复请求。
   * 缺省 false:竖屏那条路径逐字不变。
   */
  hoistTabs?: boolean
  /**
   * 第一次用且窗位叠里一个成员都没有(2026-09-18)。**画成悬浮层**,不进文档流:
   * 槽体(`.ben-wb__slot-body`)是窗位矩形的唯一来源,它上面多出/少掉一段文字都会让
   * ResizeObserver 认为"槽真的变了尺寸",服务端跟着把贴住的窗重摆一次
   * (2026-08-25 真机那条"贴住的窗口莫名往上窜")。同 dock-note / veiled 的老办法。
   */
  empty?: EmptyView
  /** 事务官那一档的空态(原样转发给 ButlerInbox,SlotModule 只是管道)。 */
  butlerEmpty?: EmptyView
  /** 「还差辅助功能」那一句 + 那颗按钮(2026-09-18)。原样转发给 SlotZone,这里只是管道。 */
  access?: AccessNotice
  onAuthorize?: () => void
  accessError?: string | null
  /**
   * 自定义模块(2026-09-21)。**这个组件只是管道**:标签转发给 DockTabBar(竖屏那一份),
   * iframe 画在 `.ben-wb__slot-stack` 里(与事项收件箱同一层,盖在槽体上)。
   * 选中判定、点了发什么请求,全在 Workbench.tsx —— 同 butlerActive 那条纪律,
   * 这里不自己算一遍,免得两处走漂。
   */
  modules?: readonly CustomModuleView[]
  activeModuleId?: string | null
  onSelectModule?: (id: string) => void
  onRemoveModule?: (id: string) => void
}) {
  // 产品决策(2026-08-26 定于 iframe,2026-09-10 事项收件箱沿用):事务官那一档
  // 「懒挂载 + 常驻」。
  //
  // 懒挂载——组件挂载的第一拍(`butlerActiveRef` 初值为 `false` 就是为了这个,
  // 见 Workbench.tsx)其实还不知道该不该显示事务官,那时候无条件挂上会白算一遍;
  // 所以闩锁初值是 false,只有 `butlerActive` 真正为真过一次才扳上去。
  //
  // 常驻——扳上去之后不再卸载:切走再切回来,**输入框里没发出去的那句话不能丢**
  // (原来这条护的是 iframe 里那份 DSH 应用实例的对话状态;收件箱这一版对话已经不在
  // 这里了——点开事项跳的是 DSH 自己的页面——但草稿仍然只活在这棵组件树里)。
  // 可见性交给 CSS display:none,不影响 DOM 存在与否。
  /**
   * 2026-09-21:闩锁与可见性都看 **butlerVisible**,不是 butlerActive。
   * 自定义模块与事务官是同一档(服务端都是 `dock.current === null`),选中一格模块时
   * butlerActive 照样为真 —— 只看它的话,收件箱会跟模块的 iframe 叠在一起。
   */
  const butlerVisible = butlerActive && (activeModuleId ?? null) === null
  // 空态让开展开着的悬浮窗(被压住的那一侧留出来),见 useAvoidFloat。
  const emptyRef = useRef<HTMLDivElement>(null)
  const emptyInset = useAvoidFloat(emptyRef, butlerVisible)
  const butlerEverShownRef = useRef(false)
  if (butlerVisible) butlerEverShownRef.current = true
  // 协作区同「事务官」那一档的老办法:第一次打开才挂,挂上不卸(切走再切回来,筛选、选中的那张、对话气泡里的半句话都在)。
  // 收件箱输入框的草稿以前放在这一层(2026-09-10);纯净模式要在整屏再画一份事务官档,
  // 草稿因此再往上提到 Workbench(2026-09-11),这里只是管道。
  // 弹层让路中(2026-09-14):槽体里画一句「已让开」占位。只在台前真有一扇窗时——事务官在台时
  // veil 什么也没藏,没有谁"让开"。
  const veiled = showVeilPlaceholder(useVeilActive(), feed.state.dock?.stack)
  /**
   * 当前那一格的窗其实不在窗位里(2026-09-25,卡 fix/slot-current-empty):服务端在 DockTab.unplaced
   * 里说了为什么(没摆回来 / 没开着 / 被藏起来了)。这时槽体里写那一句 + 「点一下拉进来」
   * (= 点那个标签:/dock/switch 会先开应用、唤窗、摆位、置前),不留一块空黑区。
   * 让路中(弹层开着)那一档不算:那是故意藏的,槽里已经有「窗位里的应用已让开」。
   */
  const currentTab = feed.state.dock?.stack.find(tab => tab.current)
  const missing = currentTab?.unplaced !== undefined && !butlerVisible && !veiled
    ? {
        label: currentTab.label,
        reason: currentTab.unplaced,
        onPull: () => { void postSilently(`${feed.baseUrl}/dock/switch`, { app: currentTab.key }, serviceFetch ?? fetch) },
      }
    : undefined
  return (
    <ModuleBox {...box}>
      {/* 标题在卡外那一行弱字里(10-22 拍板,评审页 `.slot-tabs`):「窗口槽 · 事务官 · 设置」,收起在行末。 */}
      {header}
      {/* 完整收容(真机截图实证):标签栏/场景条/槽体全部收在这同一个 <section>
          里,连同 ModuleBox 外壳的 overflow:hidden(style.ts),保证这个模块的
          任何内容都不会画到自己盒子外面、盖住下一个模块。A4 起不再有管理面板。 */}
      <section className="ben-wb__card--fill" aria-labelledby={headingId}>
        {/* 标签栏(spec 2026-08-24 窗位叠 v2 V1,A3 起标签带彩色圆点徽章):
            模块顶部,先于场景条/槽体。W4 起最左固定一格「事务官」,无条件渲染;
            state.dock 缺省(未接 dockService)时只是没有应用标签,标签栏本身还在。 */}
        {hoistTabs !== true && (
          <DockTabBar
            dock={feed.state.dock}
            sessions={feed.state.sessions}
            registry={feed.state}
            badges={feed.state.badges ?? {}}
            baseUrl={feed.baseUrl}
            fetchImpl={serviceFetch ?? fetch}
            butlerActive={butlerActive}
            onSelectButler={onSelectButler}
            dwellReadMs={dockDwellReadMs}
            {...(onDevTool === undefined ? {} : { onDevTool })}
            {...(feed.state.template?.web_apps === undefined ? {} : { webApps: feed.state.template.web_apps })}
            {...(modules === undefined ? {} : { modules })}
            {...(activeModuleId === undefined ? {} : { activeModuleId })}
            {...(onSelectModule === undefined ? {} : { onSelectModule })}
            {...(onRemoveModule === undefined ? {} : { onRemoveModule })}
            {...(butlerWaiting === undefined ? {} : { butlerWaiting })}
            {...(feed.state.running === undefined ? {} : { running: feed.state.running })}
            showButlerTab={false}
          />
        )}
        {/* 槽位几何**不取决于当下选中哪个标签**(2026-08-26 真机事故后改)。
            原来这里是三选一:事务官在台前就整个不渲染槽体,改画 iframe。真机上它留了一条
            一开机就钉死的路——点过「事务官」后 current 被持久化成 null,下次 DSH 重启时
            butlerActive 一上来就是真,槽体从头没挂载过,一份矩形都没量出来,而 dock.ts 的
            switchTo 没有矩形就直接失败,于是任何标签都点不动。
            改成槽体常挂载、常量、常报,事务官那一档以浮层盖在它上面(见下方 stack 容器)。
            那块区域在屏幕上的位置本来就跟"这会儿在那儿画什么"无关。 */}
        {/* 场景条:清单为空就整条不画(2026-09-21 Ben:「这个部分不要有了」)。
            这道 `length > 0` 的闸是 A4 时就有的,0920 去预置场景时为了给那句
            「还没存过窗口布局……」腾地方一度改成只看 `!== undefined`;0921 把那句提示
            连同「存成新布局」一起去掉之后,空清单下这一格已经没有任何内容可画 ——
            闸不关回去就是在槽上方留一条空的 `.ben-wb__slot-scroll`。
            横屏左栏那一份不走这里(compact 菜单,清单为空照旧画那颗按钮,见 Workbench.tsx)。 */}
        {hoistTabs !== true && feed.state.scenes !== undefined && feed.state.scenes.length > 0 && (
          <div className="ben-wb__slot-scroll">
            <SceneBar
              baseUrl={feed.baseUrl}
              scenes={feed.state.scenes ?? []}
              {...(serviceFetch === undefined ? {} : { fetchImpl: serviceFetch })}
            />
          </div>
        )}
        {/* data-hover(2026-09-25):拖着窗悬在槽上时,槽体那一层抬到事务官档上面(槽体本身透明、不接点击),
            光与「松手认领到窗位」不再被事务官那一层盖住 —— 维护者一直停在事务官档,以前拖窗进来一点光都看不见。 */}
        <div className="ben-wb__slot-stack" data-hover={dropHover}>
          <SlotZone
            {...(access === undefined ? {} : { access })}
            {...(onAuthorize === undefined ? {} : { onAuthorize })}
            {...(accessError === undefined ? {} : { accessError })}
            {...(empty === undefined || butlerActive ? {} : { empty })}
            helper={feed.state.helper}
            snap={feed.state.snap}
            dockNote={feed.state.dock?.note}
            bodyRef={slotBodyRef}
            dropHover={dropHover}
            dropFlash={dropFlash}
            veiled={veiled}
            {...(missing === undefined ? {} : { missing })}
          />
          {/* C1(整分支终审):叠为空 + 选中事务官——标签栏只剩「事务官」一格,没有别的标签
              可点着回到落点。给一条明摆着的路,不指望用户去猜"再点一次同一个标签"。
              叠非空时不画:那时候点任意一个应用标签就回去了。 */}
          {/* 第一次用、窗位叠还空着那一句在 SlotZone 的槽体内部画(2026-09-18 挪的,
              见那边 empty 的注释:原来它悬在这个 stack 的顶端,跟「未接入:…」那行红字
              叠在一起)。跟下面那条「叠里还没有窗——回到窗位落点」不冲突:那条只在
              **选中事务官**时出现,这条是没选中事务官时该看见的那一句。 */}
          {/*
            窗口槽里没有应用窗在台前(2026-10-27 已拍板:去掉独立的事务官标签页,事务官入口只剩悬浮球):
            不再挂一份事务官页,只说一句这儿是空的,给一条去协作区的路;叠为空时照旧给「回到窗位落点」。
          */}
          {butlerVisible && (
            <div className="ben-wb__slot-empty" role="status" ref={emptyRef} style={{ paddingLeft: 24 + emptyInset.left, paddingRight: 24 + emptyInset.right }}>
              <p>{dockEmpty
                ? ((feed.state.dock?.pending ?? []).length > 0 ? '窗口槽里还没有窗 —— 点标签栏里写着「点一下拉进来」的那几个,或者把窗拖进来。' : '窗口槽里还没有窗 —— 把应用窗拖进虚线区就能认领。')
                : '这会儿没有应用窗在台前 —— 点上面的标签切过去。'}</p>
              <span className="ben-wb__slot-empty-acts">
                {dockEmpty && <button type="button" className="ben-wb__slot-back" onClick={onLeaveButler}>回到窗位落点</button>}
                {onOpenCollab !== undefined && <button type="button" className="ben-wb__slot-back" onClick={onOpenCollab}>打开协作区</button>}
              </span>
            </div>
          )}
          {/* 自定义模块那几档(2026-09-21):**与事项收件箱同一层**,盖在槽体上。
              每个模块一份、一挂上就不卸载(CustomModuleFrame 自己管懒挂载与保活);
              没被选中的那几份是 display:none —— 切走再切回来,番茄钟还在走。 */}
          {(modules ?? []).map(module => (
            <CustomModuleFrame
              key={module.id}
              module={module}
              active={activeModuleId === module.id}
            />
          ))}
        </div>
      </section>
    </ModuleBox>
  )
}
