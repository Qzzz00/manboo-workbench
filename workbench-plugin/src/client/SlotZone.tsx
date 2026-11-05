/**
 * 由 Workbench.tsx 拆出(2026-08-25 地基:六窗口并行前的接缝切分)。**逐字搬运,
 * 没有改一行行为**——原文件 1190 行,四块需求都要改它,不拆开必冲突。
 */

import type { RefObject } from 'react'
import type { HelperView, SnapView } from '../protocol.ts'
import { AccessWarn } from './AccessWarn.tsx'
import type { AccessNotice } from './accessNotice.ts'
import { EmptyState } from './EmptyState.tsx'
import type { EmptyView } from './emptyState.ts'
import { FxBeam } from './fx/Fx.tsx'
import { BEAM } from './fx/fxModel.ts'

/**
 * 窗口槽（spec §3.4，W1–W9 起接上贴合编排,2026-08-24 窗位叠 v2 V1–V9 起收口,
 * A4 起「管理」入口下线）：认领/切换/放出全部改由服务端 dockService 决策,客户端
 * 不再有"点应用按钮发 /snap"这条路——那一排按钮连同 SLOT_APPS 常量一并下线,标签栏
 * (DockTabBar)接手了原来"打开一个应用"的入口位置(挂进同一窗位靠壳的 AXObserver
 * 拖动落定事件认领,不是点出来的)。A4:应用管理面板(AppManagePanel)与「管理」按钮
 * 整个移除——标签的 ✕(放出到本机)加拖拽认领(A2)已经覆盖了增删的日常需求,
 * /apps/* 路由与 registry 仍在服务端,只是没有 UI 挂着了。这里保留的只是:helper
 * 未接入横幅、snap 失败/尺寸偏差的如实展示(state.snap 仍是切换/认领放置问题的诚实
 * 兜底)、以及槽体本身(认领后被真窗盖住)。
 */
/**
 * 窗位盒(真机截图实证:管理钮飘到组件条标题上、场景多了槽体压成一条缝;A4 起管理钮
 * 已随管理面板一起下线):未接入横幅/贴合结果/槽体本身——不包含标签栏/场景条,那部分
 * "高度会变"的内容挪去调用点的 `.ben-wb__slot-scroll`(自己的滚动区)。这样
 * `.ben-wb__slot` 剩下的都是高度可控的固定件(偶尔一行 warn/note)+ 槽体本身,槽体的
 * flex:1 才稳稳吃满盒子剩余空间,不会被"场景条今天有多少行"这种外部变量牵着走。
 *
 * F2(review,真机截图实证):原来这里顶部还有一条 `.ben-wb__slot-handle`("收起态
 * 28px 入口把手")——那是模块盒子化改造前的遗留:当时"收起"是 SlotZone 组件自己切换
 * 内部展示模式,这条 28px 把手就是收起态唯一可见的东西。ModuleBox 统一了收起/展开后,
 * "收起"变成整个模块从渲染树里退出(见 Workbench.tsx 的 visibleModules),这条把手
 * 早就没有对应的交互了,纯粹是个不响应点击、不随场景条内容变化的装饰性色块——真机
 * 截图里就是场景区空着时底部那条突兀的横条。整个移除,不是靠 CSS 藏起来(那样还是
 * 占位)。
 */
export function SlotZone({ helper, snap, dockNote, bodyRef, dropHover, dropFlash = false, veiled = false, access, onAuthorize, accessError, empty, missing }: {
  helper: HelperView | undefined
  /**
   * 当前那一格的窗**其实不在窗位里**(2026-09-25,卡 fix/slot-current-empty):标签高亮着,槽里却是空的 ——
   * 维护者一打开看见的就是「一块空黑区 + 高亮的标签」。给了就在槽体里写清是哪一家、为什么,外加一颗
   * 「点一下拉进来」。**画成悬浮层**(同 empty / dock-note 的老办法),不改槽体尺寸。
   */
  missing?: { label: string, reason: string, onPull: () => void }
  /**
   * 「还差辅助功能」那一句(2026-09-18),跟顶上那条横幅**同一句**(accessNotice.ts)。
   * 给了就用它顶掉原来那句「未接入:<helper.reason>」—— 那句只是把壳报来的一个词
   * 接在前缀后面,既没说怎么办,也分不出 Ben 这台机器上真正发生的「记录旧了」。
   * 缺席(还没体检过 / 已授权)就照旧,一个字不变。
   */
  access?: AccessNotice
  /** 「去授权」按下去。不给就不画那颗按钮(EmptyState 的先例)。 */
  onAuthorize?: () => void
  /** 打不开系统设置时的原因原文。 */
  accessError?: string | null
  /**
   * 第一次用、窗位叠还空着的那一句(2026-09-18 首次空态)。
   *
   * 2026-09-18 从 `.ben-wb__slot-stack` 挪进**槽体内部**:它原来悬在 stack 顶端,
   * 而 stack 顶端正是上面那行「未接入:…」红字待的地方,两段字直接叠在一起
   * (横屏首屏实测,截图可证)。槽体自己就是 position:relative(dock-note / 让路占位
   * 早就住在里面),挪进来之后既不再压着红字,又保持"不占文档流"这条要紧的性质
   * ——槽体尺寸一变服务端就会把贴住的窗重摆一次(2026-08-25 那条"窗口莫名往上窜")。
   */
  empty?: EmptyView
  snap: SnapView | undefined
  /** S2(a)(review,真机截图实证):dock.note 现在在这里渲染,不在 DockTabBar——见下方槽体
   *  内部那个 overlay 的注释。 */
  dockNote: string | undefined
  /** 槽体测量交由 Workbench 持有:窗位矩形上报(V3)量的是同一块槽体,量取逻辑不能只留在这里私有。 */
  bodyRef: RefObject<HTMLDivElement>
  /** 悬停高亮 v1:壳侧拖拽悬停判定,经服务端 /live 广播的 hover 事件驱动。 */
  dropHover: boolean
  /**
   * 窗口槽那圈流线光此刻亮不亮(2026-09-25,卡 P;维护者:「窗口槽的流线光效时不时自己闪一下,其实没拖新应用进去」)。
   * **只在他真把一个新应用拖进来、放手那一下**亮一轮 —— 绑「放下」这个动作,不绑槽位状态(悬停、切换、刷新、重连都不亮)。
   * 壳已经亮了原生光圈时上层给 false(两圈叠着不是同一套光)。缺省 false。
   */
  dropFlash?: boolean
  /**
   * 弹层让路中(2026-09-14):窗位里的窗被 hide_app 让开了,这块是空白——画一句浅色占位告诉 Ben
   * 发生了什么,不然像窗坏了。真值由 SlotModule 算(useVeilActive × 台前有窗)。
   */
  veiled?: boolean
}) {
  const ready = helper?.connected === true && helper.authorized === true
  const reason = helper?.reason ?? '工作台 App 未运行'
  /**
   * 壳连上了、只是没授权 —— 这一支才轮得到那句共用的话。壳**没连上**(App 没在跑)时
   * 仍旧说 `helper.reason`:那会儿真正挡路的是"壳没起来",把授权那段话摆在这儿
   * 是指着一条今天走不通的路(D13)。
   */
  const accessOnly = helper?.connected === true && helper.authorized !== true
  return (
    <div className="ben-wb__slot">
      {!ready && (accessOnly && access !== undefined
        ? <AccessWarn prefix="未接入" notice={access} {...(onAuthorize === undefined ? {} : { onAuthorize })} {...(accessError === undefined ? {} : { error: accessError })} />
        : <p className="ben-wb__slot-warn" role="status">未接入:{reason}</p>)}
      {snap?.state === 'failed' && <p className="ben-wb__slot-warn" role="alert">贴合失败:{snap.reason}</p>}
      {/* 贴合成功但尺寸有偏差(F2):政策已判达标,不是失败——低调陈述,不用红色告警样式。 */}
      {snap?.state === 'snapped' && snap.reason !== undefined && (
        <p className="ben-wb__slot-note" role="status">{snap.reason}</p>
      )}
      {/* 槽体:认领矩形以它为准——横幅/标签栏都在它上方,真窗只盖这块(V9 起不再画应用按钮)。
          data-hover 驱动虚线高亮+呼吸动效(style.ts),提示文案只在悬停时挂载,不常驻 DOM。
          flex:1 1 auto;min-height:120px(style.ts):正常情况下吃满 .ben-wb__slot 的剩余
          高度;盒子真的太矮时也不会缩没,.ben-wb__slot-scroll 会先替它扛住挤压(见调用点)。 */}
      {/* 真拖进一个新应用、放手那一下,光绕槽体走一圈(border-beam,参数见 fxModel BEAM.slotHover;2026-09-25 卡 P 起
          不再在悬停时亮 —— 悬停只有那句提示字)。外壳一直在、只切 active:槽体不重挂,bodyRef 的 ResizeObserver
          不会因为光亮灭白白报一次矩形。 */}
      <FxBeam name="slot-hover" spec={BEAM.slotHover} active={dropFlash}>
      <div ref={bodyRef} className="ben-wb__slot-body" data-snapped={snap?.state === 'snapped'} data-hover={dropHover}>
        {/* S2(a)(review,真机截图实证):dock.note 原来渲在标签栏那一侧(常规文档流的
            <p>),它在"有话说"和"没话说"之间来回切换时会改变上面那一段的高度——slot-body
            是跟它同一个 flex 列里的兄弟,分到的剩余空间跟着变了,ResizeObserver 因此
            认为槽体"真的变了尺寸",一份新矩形报上去,服务端据此把已经贴住的窗口重新
            摆一次位置——真机上就是"贴住的窗口莫名往上窜/点一下又弹回去"的另一个成因。
            挪进槽体内部、position:absolute 悬浮在顶端(见 style.ts):不占文档流,
            出现/消失都不会改变 .ben-wb__slot-body 自身的盒子尺寸,ResizeObserver 不会
            被它误触发。 */}
        {dockNote !== undefined && <p className="ben-wb__dock-note" role="status">{dockNote}</p>}
        {dropHover && <p className="ben-wb__slot-hover-hint" role="status">松手认领到窗位</p>}
        {/* 让路占位:同 dock-note 一样 position:absolute 悬浮在槽体里(style.ts),不占文档流——
            出现/消失都不改 .ben-wb__slot-body 的尺寸,ResizeObserver 不会被它误触发去重贴窗。
            浅色小字,不是错误样式:这不是故障,是让路。 */}
        {veiled && <p className="ben-wb__slot-veiled" role="status">窗位里的应用已让开,关闭弹窗后回来</p>}
        {empty !== undefined && <EmptyState view={empty} overlay />}
        {missing !== undefined && (
          <div className="ben-wb__slot-missing" role="status">
            <p className="ben-wb__slot-missing-line">{`「${missing.label}」的窗没在窗位里:${missing.reason}。`}</p>
            <button type="button" className="ben-wb__unlock-btn ben-wb__slot-missing-pull" onClick={missing.onPull}>点一下拉进来</button>
          </div>
        )}
      </div>
      </FxBeam>
    </div>
  )
}
