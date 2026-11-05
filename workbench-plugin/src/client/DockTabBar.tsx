/**
 * 由 Workbench.tsx 拆出(2026-08-25 地基:六窗口并行前的接缝切分)。**逐字搬运,
 * 没有改一行行为**——原文件 1190 行,四块需求都要改它,不拆开必冲突。
 */

import { useEffect, useRef, useState } from 'react'
import type { AgentSessionView, CustomModuleView, DockTab, RunningView, SessionView, WorkbenchState } from '../protocol.ts'
import { WAIT_REASON_TITLES } from '../protocol.ts'
// 「这条会话是他的吗」(工作台自己起的探针不算;2026-09-25,卡 V,src/running.ts)。
import { isHisSession } from '../running.ts'
import { humanDuration } from './sessionFeed.ts'
import { postSilently } from './postSilently.ts'
import { DevToolButton } from './DevToolButton.tsx'
import { DockAppButton } from './DockAppButton.tsx'
import { CustomModuleTab } from './CustomModuleTab.tsx'
import { entryForDockTab, markReadRequest, registrySelf, type RegistryState } from './agentRegistryView.ts'
import { AgentIcon, AppIcon, agentIconSrc, appIconSrc } from './AgentIcon.tsx'

/**
 * 一条会话(圆点与气泡数的就是它):与 `SessionView` 同形,只是 `agent` 按字符串(Agent 登记表里的 id),
 * `via` 说它从哪一路来(读窗口读出来的看过了走 `/agents/read`,专门读法的走 `/read`)。
 */
type BadgeSession = Omit<SessionView, 'agent'> & { agent: string, via?: AgentSessionView['via'] }

/**
 * 这一格标签底下那家 App 的会话(2026-09-25,卡 Q):**按 Agent 登记表**,用包标识把标签对上登记表里的那一家 ——
 * 运行时新接上的一家(Muse、Manus、豆包……)也有圆点与气泡;不在登记表里的 App(微信、一个普通软件)没有会话圆点。
 * 老服务端(没有登记表)退回按键名对 `/state.sessions`。
 */
function sessionsOfTab(tab: { key: string }, sessions: readonly BadgeSession[], registry: RegistryState | undefined): readonly BadgeSession[] {
  if (registry?.agent_registry === undefined) return sessions.filter(session => session.agent === tab.key)
  return entryForDockTab(registry, tab)?.sessions ?? []
}

/**
 * 这一格标签底下那一家在**别处**叫什么(2026-09-26,卡 WS)。`/state.running.items[].agent` 写的是
 * **登记表里的 id** —— 有专门读法的几家是 `claude` / `codex` / `kimi`,运行时新接上的一家是它的**包标识**
 * (`com.google.antigravity`);而窗口槽这一格的键是 App 注册表的键 —— 目录认识的那几家是家名本身
 * (`muse`:2026-09-27 卡 HC 起各家包标识进了 `activation.APP_BUNDLES`,反查到的是基础键,不再是 `c-muse`;
 * 钉在 `tests/engine-wire-hands.test.ts`),运行时才认出来的陌生 App 才是 `c-antigravity` 这种。
 *
 * **09-26 撞出来的就是这条**:维护者说「新加的……没有弹过执行中的气泡」。卡 V 把白点的数改成
 * `running.items.filter(item => item.agent === tab.key)` 之后,凡是键与登记表 id 不一样的标签
 * (所有 `c-*`:Muse、Manus、豆包、Grok Bot、Antigravity……)一律筛出空数组 —— 而 `[].length` 是 0、
 * 不是 `undefined`,`?? open.length` 那条退路也够不着,白点**整个消失**。真机实证(09-26 16:2x `/state`):
 * Antigravity 的窗口会话 `status: 'running'`、`running.items` 里也有它(`agent: 'com.google.antigravity'`),
 * 坞上那一格的键却是 `c-antigravity`。
 *
 * 所以按登记表对:先按 `dock.bundles` 认出这一格是登记表里的哪一家(同 `sessionsOfTab`),
 * 拿它的 id 与包标识去筛;认不出那一家(老服务端、不是 Agent 的普通 App)才退回按键名筛。
 */
function agentIdsOfTab(tab: { key: string }, registry: RegistryState | undefined): ReadonlySet<string> {
  const entry = registry?.agent_registry === undefined ? undefined : entryForDockTab(registry, tab)
  if (entry === undefined) return new Set([tab.key])
  return new Set(entry.bundle_id === undefined ? [entry.id] : [entry.id, entry.bundle_id])
}

/** 看过了:逐条告诉服务端(失败静默,真相以下一拍轮询为准)。读窗口读出来的与专门读法的各走各的口。 */
function postReads(reads: readonly Pick<BadgeSession, 'agent' | 'session_id' | 'via'>[], baseUrl: string, fetchImpl: typeof fetch): void {
  for (const read of reads) {
    const request = markReadRequest({ agent: read.agent, session_id: read.session_id, via: read.via ?? 'sessions' })
    void postSilently(`${baseUrl}${request.path}`, request.body, fetchImpl)
  }
}

/**
 * 「看过了就该灭」的停留阈值(2026-08-27 Ben 真机反馈)。
 *
 * **5 秒的理由**:路过式切换(点错了、或者一路点过去找某个标签)实测就是一两秒;
 * 而真的把窗口调到前台看一眼完成结果,不可能少于几秒。5 秒卡在两者中间——
 * 既挡得住"路过就算看过"的误清,又短到他离开标签时那颗蓝点已经灭了、不会觉得迟钝。
 *
 * 这个值宁可偏小也不宜偏大:清错了的代价是"一条完成没被注意到"(还能从会话列表里
 * 找回来),而迟迟不清的代价是他每次都得回来手动戳——那正是这条反馈要解决的事。
 */
const DWELL_READ_MS = 5000

/**
 * 切到某个应用标签并停留够久 → 把该应用**当时已亮**的蓝点标已读。
 *
 * 起因(2026-08-27 Ben 真机反馈,等效授权):他的动线是"点 Codex 标签 → 真窗口到前台
 * → 在 Codex 里看完 → 点别的标签离开"。工作台明知他把 Codex 调到前台看过了,却还要求
 * 他回来戳蓝点才肯灭,反直觉。**这条修订了 PRD §5.3「只有显式 /read 才清」**——
 * 把窗口调到前台并停留,本身就是一次显式的"我看了"。
 *
 * 两条边界都是 Ben 点名的:
 * - **只清切过去那一刻已经亮着的**:快照在"成为 current"那一瞬取,停留期间新完成的
 *   不在这批里,不会被顺手清掉(他还没看过它)。
 * - **必须停留够久**:路过式切一下不算看过,见 DWELL_READ_MS 的理由。
 *
 * 实现上的两个要点:
 * - **不新增轮询**。这里只在"current 变了"时装一个一次性 setTimeout,切走就清掉。
 *   数据仍来自既有的 1 秒 /state 轮询,没有多开任何回路。
 * - **effect 只认 currentKey 变化**。sessions 每一拍都是新数组,若把它列进依赖,
 *   计时器会被每秒重置、永远等不到到期;所以 sessions 走 ref,只在计时开始那一刻读一次
 *   ——这同时正好实现了上面"只清当时那批"的语义。
 */
function useDwellAutoRead({ dock, sessions, registry, baseUrl, fetchImpl, dwellMs }: {
  dock: WorkbenchState['dock']
  sessions: readonly BadgeSession[]
  registry?: RegistryState | undefined
  baseUrl: string
  fetchImpl: typeof fetch
  dwellMs: number
}): void {
  const sessionsRef = useRef(sessions)
  sessionsRef.current = sessions
  const registryRef = useRef(registry)
  registryRef.current = registry
  // 上一拍观察到的 current。用来区分"他刚切过去"和"首屏本来就是它"。
  const seenKeyRef = useRef<string | null | undefined>(undefined)

  const currentKey = dock === undefined
    ? undefined
    : dock.stack.find(tab => tab.current)?.key ?? null

  useEffect(() => {
    const previous = seenKeyRef.current
    seenKeyRef.current = currentKey
    // 首屏(previous === undefined)不算切换:那不是他刚点过去的,替他灭掉等于
    // 把他没看过的完成给收了。dock 字段本身也可能晚一拍才到,同样走这条。
    if (previous === undefined || previous === currentKey) return
    if (currentKey === null || currentKey === undefined) return

    // 快照:只取此刻已亮的那批(这一格对上的那一家,按 Agent 登记表)。
    const pending = sessionsOfTab({ key: currentKey }, sessionsRef.current, registryRef.current)
      .filter(s => s.status === 'done' && s.unread)
      .map(s => ({ agent: s.agent, session_id: s.session_id, ...(s.via === undefined ? {} : { via: s.via }) }))
    if (pending.length === 0) return

    const timer = setTimeout(() => {
      postReads(pending, baseUrl, fetchImpl)
    }, dwellMs)
    // 没停够就切走 → 计时器随 effect 清理掉,这次不算看过。
    return () => clearTimeout(timer)
  }, [currentKey, baseUrl, fetchImpl, dwellMs])
}

/** W4:固定在最左的「事务官」标签。不是 dock.stack 的成员——它不是被认领的应用,
 *  而是内嵌的 DSH 对话页,所以不参与拖拽/除名/互斥那套。 */
export const BUTLER_TAB_LABEL = '事务官'

/** UUID 显示随机尾部，避免同期 UUIDv7 的时间前缀碰撞；普通短 id 保持完整（同 SessionFeed.tsx 的规则）。 */
function shortSessionId(sessionId: string): string {
  const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(sessionId)
  return `#${isUuid ? sessionId.slice(-6) : sessionId}`
}

type BadgeTone = 'running' | 'waiting' | 'done' | 'error' | 'im'

interface BadgeInfo {
  tone: BadgeTone
  count: number
  lines: readonly string[]
  label?: string
  /**
   * 仅蓝色「未读完成」档携带:点圆点要标记已读的那批会话(2026-08-26 修复)。
   * 会话区退休(A3)时「点会话行标已读」这个唯一入口跟着整块下线了,POST /read 从此
   * 没有任何界面会调——蓝点一旦亮起就永不熄灭。已读手势搬到圆点本身:点蓝点=收掉。
   */
  reads?: readonly Pick<BadgeSession, 'agent' | 'session_id' | 'via'>[]
}

/** 圆点旁的 aria-label 前缀——纯装饰的颜色圆点本身不该是"看颜色猜含义"，屏幕阅读器要听得懂。 */
const BADGE_TONE_LABEL: Record<BadgeTone, string> = {
  running: '开着', waiting: '等确认', done: '未读完成', error: '出错', im: '未读消息',
}

/**
 * 标签徽章分类(spec A3):等你确认(黄)/出错(红)/刚完成未读(蓝)三类会话徽章按
 * `session.agent === tab.key` 归属(dsh 没有对应的 dock 标签,天然不会命中)。
 *
 * S4(review 修复,真机截图实证):IM 未读(灰,中性色,跟前三类的"会话状态"区分开)
 * 原来靠 `tab.key === 'wechat' || tab.key === 'wecom'` 字符串比对来决定看
 * state.badges 的哪一路——真机上失配了:微信的 bundle id 反复漂移(activation.ts
 * 顶部注释),一旦漂移触发 A2(b) 自愈注册,这个标签的 key 就会变成 `c-<slug>` 这样的
 * 自定义键,字符串比对从此永远不命中,badge 直接消失不见。改成读服务端在 dock.ts
 * view() 里按 bundle_id 判定好的 `tab.im` 字段——不管这个 tab 的 registry 键叫什么,
 * 服务端那一侧认得出它对应哪家 IM,客户端不用重新猜。非零才渲染——空分类不占位置。
 */
function tabBadges(
  tab: DockTab,
  sessions: readonly BadgeSession[],
  badges: Record<string, number | null | undefined>,
  registry?: RegistryState,
  /**
   * 公共执行事实已分类时，这一格按实际来源会话计数，球下按业务事项计数。
   * 老服务未分类时保留原来的 running 切片退路。
   */
  running?: RunningView,
): BadgeInfo[] {
  /**
   * **工作台自己起的会话不算他的**(2026-09-25,卡 V):能力体检 / 派活探针 / 统筹自测那几条
   * 一概不进气泡(要看去设置里「工作台自检记录」)。09-25 晚那颗写着「3」的白气泡里
   * 有两条就是体检探针。
   */
  const mine = sessionsOfTab(tab, sessions, registry).filter(isHisSession)
  // 行尾带上等待原因(2026-09-09 拍板第 4 条):同一枚黄点下面可能一条在等审批、
  // 一条只是在等他说下一句,不写出来就得逐个点开看。判不出原因的行照旧只有标题与时长。
  const sessionLine = (session: BadgeSession): string => {
    const head = `${session.title ?? shortSessionId(session.session_id)} · ${humanDuration(session.elapsed_sec)}`
    return session.wait_reason === undefined ? head : `${head} · ${WAIT_REASON_TITLES[session.wait_reason]}`
  }

  // running 档专属:行尾可选带上"上次输出 Xs 前"——last_output_sec 字段本来就是给
  // running 状态用的(见 protocol.ts 的注释),字段缺省(还没输出过/上游没给)就不硬凑。
  const runningLine = (session: BadgeSession): string => {
    const base = sessionLine(session)
    return session.last_output_sec === undefined
      ? base
      : `${base} · 上次输出 ${humanDuration(session.last_output_sec)}前`
  }

  // push 顺序即渲染顺序(Ben 钦定):进行中→等确认→已完成待验收→失败,IM 固定殿后。
  const list: BadgeInfo[] = []
  /**
   * 白点 = **此刻正在跑**(2026-09-02 Ben 选定「看过就该消失」,**修订 0827 的方案 A**)。
   *
   * 0827 曾把白点扩成"会话还开着"(在跑 + 跑完已读),为的是让"开着、等他下一句"这个
   * 状态有归宿。真机用下来代价更大:他点开看过的完成会话**不会消失,只是从蓝变白**,
   * 一直挂到 2 小时闲置为止。2026-09-02 重启后,4 条 15:22 完成、他也都看过的 Codex
   * 会话就这么占着白点要挂到 17:22——他连着两次报"气泡一直是 4,什么都没跑也是 4"。
   *
   * 新语义:看过就该消失。跑完且已读的**不再进任何档**——它既不需要他回来看,也不在
   * 等他。分桶仍互不重叠:等确认→黄、出错→红、未读完成→蓝、正在跑→白;offline 不计。
   */
  const open = mine.filter(session => session.status === 'running')
  /** 公共分类下白点数这家实际运行会话；业务事项的总数在事务官页。 */
  const agentIds = agentIdsOfTab(tab, registry)
  const runningHere = running?.items.filter(item => agentIds.has(item.agent))
  const scoped = running?.scope === 'classified_business_tasks'
  const sourceFacts = scoped ? [...running.items, ...(running.excluded ?? [])].flatMap(item => item.sources ?? []) : []
  const sourceKey = (one: { agent: string, session_id: string }) => JSON.stringify([one.agent, one.session_id])
  const linked = new Set(sourceFacts.map(sourceKey))
  const runningSources = [...new Map(sourceFacts.filter(one => one.state === 'running' && agentIds.has(one.agent))
    .map(one => [sourceKey(one), one])).values()]
  const unlinkedOpen = scoped ? open.filter(one => !linked.has(sourceKey(one))) : []
  // The Butler count is per business task. A provider tab shows its running sessions,
  // including coordination, so two providers working on one task can each show one.
  const runningCount = scoped ? runningSources.length + unlinkedOpen.length : runningHere?.length ?? open.length
  if (runningCount > 0) {
    list.push({
      tone: 'running',
      count: runningCount,
      ...(scoped ? { label: '运行会话' } : {}),
      // 行:有会话就写会话那几行(带时长);数比会话多(派出去的事没挂会话)时补上那几件事的标题。
      lines: scoped ? [...runningSources.map(source => {
        const session = mine.find(one => sourceKey(one) === sourceKey(source))
        return session === undefined ? `${source.agent} ${shortSessionId(source.session_id)} · 运行中` : runningLine(session)
      }), ...unlinkedOpen.map(runningLine)] : open.length > 0 ? open.map(runningLine) : (runningHere ?? []).map(item => item.text),
    })
  }
  /**
   * 琥珀色这一档 = **真的停下来在等他**。
   *
   * 2026-09-25(卡 V;维护者:「待确认也是错的,那个黄色的,哪有要确认的」):那条 `ben-cc` 在桌面 App 里
   * 说完一轮等他打字,却被记成 `waiting` + `idle_prompt`,于是这里出了一颗琥珀色的「1」。
   * **修在源头,不在这里筛**:
   * ① `hooks.ts`:`idle_prompt` 那种通知改报 `done`(空闲),不再走到这一档;
   * ② `waitingForYou.overlayWaiting`(2026-09-26 补):**按内容判出来的「在等你」只挂 `ask`,不改运行状态** ——
   *    一条说完了、顺口问了他一句的会话在这儿是**蓝点(完成 · 未读)**,那一问走「事务官」标签的琥珀气泡。
   *
   * 于是走到这一档的 `waiting` 一定有**形式信号**(权限弹窗 / 提问弹窗 / 等他批计划,`by: 'form'`),
   * 那种是它真的卡在那儿动不了。**这里不必按 reason 或 ask 再筛一道** —— 筛了反而会把真卡住的也藏掉。
   */
  const waiting = mine.filter(session => session.status === 'waiting')
  if (waiting.length > 0) list.push({ tone: 'waiting', count: waiting.length, lines: waiting.map(sessionLine) })
  const doneUnread = mine.filter(session => session.status === 'done' && session.unread)
  if (doneUnread.length > 0) {
    list.push({
      tone: 'done',
      count: doneUnread.length,
      lines: doneUnread.map(sessionLine),
      reads: doneUnread.map(session => ({ agent: session.agent, session_id: session.session_id, ...(session.via === undefined ? {} : { via: session.via }) })),
    })
  }
  // 他自己按停的(`reason:'interrupted'`)不是出错:卡片上写「已停下」,红点也不该挂着(2026-09-28 Air 维护包)。
  const errored = mine.filter(session => session.status === 'error' && session.reason !== 'interrupted')
  if (errored.length > 0) list.push({ tone: 'error', count: errored.length, lines: errored.map(sessionLine) })

  const imUnread = tab.im === undefined ? undefined : badges[tab.im]
  if (typeof imUnread === 'number' && imUnread > 0) {
    list.push({ tone: 'im', count: imUnread, lines: [`未读 ${imUnread} 条`] })
  }
  return list
}

/** 气泡跟视口边缘留的最小间距,以及没量出真实气泡宽度前用来估一个"半宽"做水平夹紧的粗略值。 */
const BUBBLE_VIEWPORT_MARGIN_PX = 8
// 真机反馈(Ben):气泡加大一档,style.ts 里 .ben-wb__dock-badge-bubble 的 max-width
// 放宽到 260px——这里的估计半宽跟着同步调大(130 = 260/2),否则水平夹紧算出来的位置
// 会比实际气泡窄一圈,真机上还是可能贴着视口边缘露出一小截。
const BUBBLE_HALF_WIDTH_ESTIMATE_PX = 130

/**
 * 单个圆点徽章 + 悬停气泡(spec A3;真机反馈修订:气泡改 fixed 定位、朝上开)。
 *
 * 真机实况:窗位里认领的是一扇**真实的原生窗口**,壳把它摆得跟 `.ben-wb__slot-body`
 * 的屏幕矩形严丝合缝——那不是网页内容,是操作系统层面盖在浏览器渲染表面之上的另一个
 * 窗口。气泡原来朝下开、落进槽体范围内(甚至只是紧挨着标签栏),画面上全被这扇原生
 * 窗口彻底盖住,肉眼完全看不见,只有 DOM 里"存在",没有"可见"。CSS z-index 对此无解——
 * z-index 只能排 web 内容自己的前后顺序,排不到操作系统窗口前面。
 *
 * 改法:气泡换 `position:fixed`(逃出 `.ben-wb__dock-tab`/`.ben-wb__mod` 两层裁剪,
 * 也不再关心哪个祖先元素是不是 `overflow:hidden`),鼠标移上圆点那一刻用
 * `dotRef.getBoundingClientRect()` 现量圆点的屏幕位置,气泡朝上开(气泡底边贴着圆点
 * 顶边)——标签栏在窗位模块顶部,往上是项目区那些普通网页内容,不会被原生窗口盖住。
 * 定位因此从"纯 CSS `:hover`"改成"JS 算好坐标 + React state 控制挂载/卸载"(存在于
 * DOM 就是可见,不需要 display:none 那一层)。水平方向做了个粗略夹紧,不让气泡出视口
 * 左右边缘——量不到气泡真实宽度(还没渲染出来测),用一个估计的半宽,不是像素级精确,
 * 但足够避免"气泡一半飘到窗口外"这种明显问题。
 */
function DockTabBadge({ badge, onMarkRead, actionLabel }: {
  badge: BadgeInfo
  onMarkRead?: (() => void) | undefined
  /** 圆点是一颗按钮时它的名字(缺省「标记已读:…」;「事务官」那一格是「看等你的 n 件」)。 */
  actionLabel?: string
}) {
  // span(不可点档)与 button(蓝色已读档)共用一个 ref,取公共祖先类型量矩形。
  const dotRef = useRef<HTMLElement | null>(null)
  const [bubblePos, setBubblePos] = useState<{ left: number, bottom?: number, top?: number } | null>(null)

  const openBubble = (): void => {
    const rect = dotRef.current?.getBoundingClientRect()
    if (rect === undefined) return
    const anchorX = rect.left + rect.width / 2
    const left = Math.min(
      Math.max(anchorX, BUBBLE_VIEWPORT_MARGIN_PX + BUBBLE_HALF_WIDTH_ESTIMATE_PX),
      window.innerWidth - BUBBLE_VIEWPORT_MARGIN_PX - BUBBLE_HALF_WIDTH_ESTIMATE_PX,
    )
    // fixed 定位下 bottom 是"离视口底边的距离"——朝上开就是"圆点顶边到视口底边的距离
    // 再加一点间隙",这样气泡的底边正好贴着圆点顶边之上。Math.max(...,margin) 兜底:
    // 圆点万一贴着视口顶端(理论上不会,标签栏不会摆那么高),也不会算出负值把气泡顶出屏幕。
    const bottom = Math.max(window.innerHeight - rect.top + 6, BUBBLE_VIEWPORT_MARGIN_PX)
    /**
     * 上面放不下就朝下开(2026-09-25,卡 M):「事务官」那一格在左栏最上头,朝上开会顶出屏幕、前几行看不见。
     * 高度按行数估(一行约 20px + 上下内边距),不量 —— 气泡还没画出来量不了。
     */
    const estimated = badge.lines.length * 20 + 20
    if (rect.top - 6 - estimated < BUBBLE_VIEWPORT_MARGIN_PX) {
      setBubblePos({ left, top: rect.bottom + 6 })
      return
    }
    setBubblePos({ left, bottom })
  }
  const closeBubble = (): void => setBubblePos(null)

  return (
    <span
      className="ben-wb__dock-badge"
      data-tone={badge.tone}
      onMouseEnter={openBubble}
      onMouseLeave={closeBubble}
    >
      {onMarkRead === undefined
        ? (
            <span
              ref={(el) => { dotRef.current = el }}
              className="ben-wb__dock-badge-dot"
              aria-label={`${badge.label ?? BADGE_TONE_LABEL[badge.tone]} ${badge.count}`}
            >
              {badge.count}
            </span>
          )
        : (
            /* 蓝色「未读完成」档专属:圆点本身就是「标记已读」按钮(2026-08-26 修复,
               会话区退休后 POST /read 失去了唯一入口)。点掉之后真相以下一拍轮询回来的
               快照为准——unread 翻 false,这颗圆点整个不再渲染,跟 markRead 一贯的
               "失败静默、服务端为准"规矩一致。 */
            <button
              ref={(el) => { dotRef.current = el }}
              type="button"
              className="ben-wb__dock-badge-dot"
              aria-label={actionLabel ?? `标记已读:${BADGE_TONE_LABEL[badge.tone]} ${badge.count}`}
              onClick={onMarkRead}
            >
              {badge.count}
            </button>
          )}
      {bubblePos !== null && (
        <div
          className="ben-wb__dock-badge-bubble"
          style={bubblePos.top !== undefined
            ? { left: `${bubblePos.left}px`, top: `${bubblePos.top}px`, bottom: 'auto' }
            : { left: `${bubblePos.left}px`, bottom: `${bubblePos.bottom}px` }}
        >
          {badge.lines.map((line, index) => <p key={`${index}-${line}`}>{line}</p>)}
        </div>
      )}
    </span>
  )
}

/**
 * 窗位叠标签栏(spec 2026-08-24 窗位叠 v2 V1–V9;A3 起标签上加彩色圆点徽章):渲染
 * state.dock.stack——同一窗位里叠着的应用,current 那扇高亮;running:false 只是置灰
 * 提示(这会儿没在跑),点了照样发 /dock/switch——服务端会把它拉起来,不是禁用态
 * (D13:多一步不等于做不到)。
 *
 * S2(a)(review,真机截图实证):dock.note 不在这里渲染了——挪去了 SlotZone,以
 * position:absolute 悬浮在槽体内部(见 SlotZone 里的注释:出现/消失原来会改变槽体
 * 上方那段区域的高度,连带把槽体自己的盒子尺寸挤变了,ResizeObserver 因此把这当"槽体
 * 真的变了尺寸"重新报一次矩形,服务端据此把已经贴住的窗口重新摆一次位置)。
 *
 * 事务官固定格无条件渲染,应用标签才依赖 state.dock:state.dock 整体缺省(未接
 * dockService)时,应用标签那半退回 SlotZone 自己的 helper 未接入横幅——那条横幅
 * 跟标签栏是两件事,不在这里重复判断。
 */
export function DockTabBar({
  dock, sessions, badges, baseUrl, fetchImpl, butlerActive, onSelectButler, dwellReadMs, onDevTool, showButlerTab = true,
  modules, activeModuleId, onSelectModule, onRemoveModule, butlerWaiting, registry, running,
}: {
  dock: WorkbenchState['dock']
  sessions: readonly SessionView[]
  /**
   * Agent 登记表(2026-09-25,卡 Q;就是 `/state` 本身)。给了就按它把标签对上那一家 App 的会话 ——
   * 圆点与气泡各家一条路;不给(老用例)按键名对 `sessions`。
   */
  registry?: RegistryState
  badges: Record<string, number | null | undefined>
  /**
   * 公共事实已分类时，标签白点按这家运行中的来源会话计；事务官页按业务事项计。
   * 老服务没有分类时沿用原 running 切片。
   */
  running?: RunningView
  /**
   * 「事务官」那一格的气泡(2026-09-25,卡 M;维护者:「事务官自己应该也有气泡才对」):
   * 有要他答的、要他批的、要他确认的,就在「事务官」上出一个数(与 Codex / Claude 标签同一套样式,琥珀色「等确认」那一档),
   * 数字与球下「等你 n」是同一个数;悬停看是哪几件,点它切到事务官那一档、把那几张摊开。0 就不画。
   */
  butlerWaiting?: { count: number, lines: readonly string[], onOpen: () => void }
  baseUrl: string
  fetchImpl: typeof fetch
  /** W4:「事务官」是否选中。真相是服务端的 `dock.current === null`——客户端不另存一份,
   *  两份状态必然走漂(真窗到底藏没藏只有服务端知道)。
   *  唯一的例外(终审 C1):叠里一个成员都没有时 current 恒为 null,服务端表达不了
   *  "选没选事务官",那一档由 Workbench.tsx 的 butlerPicked 说了算(理由与清除时机
   *  写在那个 state 的声明处)。这一层照旧只是转发,不自己判断。 */
  butlerActive: boolean
  /** W4:点「事务官」——上层发 POST /dock/hide。 */
  onSelectButler: () => void
  /**
   * 最左那一格「事务官」画不画(2026-10-27 已拍板:去掉各处独立的事务官标签页,入口只剩悬浮球)。
   * 工作台传 false;缺省 true 只为老调用方与用例。
   */
  showButlerTab?: boolean
  /** 「看过了就该灭」的停留阈值,缺省 DWELL_READ_MS;测试注入很小的值。 */
  dwellReadMs?: number | undefined
  /**
   * 「开发一个小工具」那颗按钮点下去做什么(2026-09-20)。**可选,给了才画**——
   * 横屏下这一份标签栏被提进左侧窄栏(SlotModule 的 hoistTabs),那颗按钮要落在**栏底**
   * (Ben:「横版在底部」),而标签这一排在窄栏里是可滚动的竖排,按钮跟着滚就不叫"在底部"了。
   * 所以横屏那一支不传这个回调,改由 Workbench 在栏的末尾自己画一颗;竖屏这一支传,
   * 按钮殿在标签那一排的最右(Ben:「竖版在最右侧」)。**全页始终只有一颗**。
   */
  onDevTool?: (() => void) | undefined
  /**
   * 自定义模块(2026-09-21)。**与事务官同一档**:点它的标签,当前在台的原生窗藏起来
   * (同一条 `POST /dock/hide`),这一格的 iframe 铺在窗位槽上。
   *
   * 排在应用标签之后:点了切过去就能用,与应用标签一起组成窗口槽的去处。
   *
   * 不传 / 空 = 一格都不画(没接 modules 服务的那一档,与这块功能之前逐字相同)。
   */
  modules?: readonly CustomModuleView[]
  /** 这会儿选中的是哪一个自定义模块;没有就是 null。真相在 Workbench.tsx(与 butlerActive 同源)。 */
  activeModuleId?: string | null
  onSelectModule?: (id: string) => void
  /** 「移除」(移进回收站,可恢复)。**二次确认在标签自己身上**,见 CustomModuleTab.tsx。 */
  onRemoveModule?: (id: string) => void
}) {
  useDwellAutoRead({ dock, sessions, registry, baseUrl, fetchImpl, dwellMs: dwellReadMs ?? DWELL_READ_MS })

  /**
   * 拖拽排序(2026-09-02 Ben:"想把 AI 的都放一块,现在是先来后到,不小心拖出去再回来就到队尾")。
   *
   * 用原生 HTML5 拖放,不引第三方拖拽库——这里只要"把一枚标签插到另一枚前面"这一件事,
   * 为它加一个依赖不划算(YAGNI,与仓库既有纪律一致)。
   *
   * 顺序的真相在服务端(dock.json):这里只发新顺序,不本地乐观重排——本地先排会与下一拍
   * 轮询回来的快照打架(先例见 butlerActive 那条"真相在服务端,客户端不另存一份")。
   * 拖到自己身上、或算出来的顺序跟现在一样,就一个请求都不发。
   */
  const [draggingKey, setDraggingKey] = useState<string | null>(null)
  /**
   * 松手后本地先按新序渲染,不等服务端那一拍(2026-09-02 Ben:"松手他进不去,又回到队尾,
   * 过一会才跳过去")。真机实测服务端是瞬时的(POST 0.02s、/state 0.03s 就反映),
   * 但客户端原来不做本地重排,标签要等下一拍轮询才跳位——机器一忙那一拍就拖长,
   * 松手瞬间看着就像"没进去、弹回原位"。
   *
   * 与"真相在服务端"并不冲突:这份乐观序**只在服务端追上之前**顶一会儿,
   * 一旦轮询回来的顺序与它一致就自动作废(下面的 useEffect),之后完全交还服务端。
   * 成员发生增删(认领/放出)时也立刻作废——那种情况下这份旧序已经不适用了。
   */
  const [optimisticKeys, setOptimisticKeys] = useState<readonly string[] | null>(null)

  const serverKeys = (dock?.stack ?? []).map(tab => tab.key)
  const serverKeysFingerprint = serverKeys.join('|')
  useEffect(() => {
    if (optimisticKeys === null) return
    // 服务端追上了(顺序一致),或者成员变了(增删),这份乐观序就该退场。
    const sameOrder = optimisticKeys.join('|') === serverKeysFingerprint
    const sameMembers = [...optimisticKeys].sort().join('|') === [...serverKeys].sort().join('|')
    if (sameOrder || !sameMembers) setOptimisticKeys(null)
  }, [serverKeysFingerprint, optimisticKeys])

  const reorder = (fromKey: string, toKey: string): void => {
    if (fromKey === toKey) return
    const keys = optimisticKeys === null ? serverKeys : [...optimisticKeys]
    const from = keys.indexOf(fromKey)
    const to = keys.indexOf(toKey)
    if (from < 0 || to < 0) return
    const next = [...keys]
    next.splice(from, 1)
    next.splice(to, 0, fromKey)
    if (next.join('|') === keys.join('|')) return
    setOptimisticKeys(next)
    void postSilently(`${baseUrl}/dock/reorder`, { keys: next }, fetchImpl)
  }

  /** 渲染用的标签序:有乐观序就按它排(认不出的键按服务端原序补在后面,一个不丢)。 */
  const orderedTabs = (() => {
    const stack = dock?.stack ?? []
    if (optimisticKeys === null) return stack
    const byKey = new Map(stack.map(tab => [tab.key, tab]))
    const out: typeof stack[number][] = []
    for (const key of optimisticKeys) {
      const tab = byKey.get(key)
      if (tab === undefined) continue
      byKey.delete(key)
      out.push(tab)
    }
    for (const tab of stack) if (byKey.has(tab.key)) out.push(tab)
    return out
  })()

  const switchTo = (key: string): void => { void postSilently(`${baseUrl}/dock/switch`, { app: key }, fetchImpl) }
  const release = (key: string): void => { void postSilently(`${baseUrl}/dock/release`, { app: key }, fetchImpl) }
  /** 事务官自己那一条(2026-09-26,卡 LG2):第一格的图标就是工作台自己的图标。 */
  const butlerSelf = registrySelf(registry)
  /**
   * 还没拉进来的那几格(2026-09-25,卡 fix/quota-and-slot-apps):点一下 = `POST /dock/claim`
   * (服务端先开应用、再把它的窗摆进窗位、置前)。拉的这几秒里那一格写「正在拉…」,回来以服务端为准:
   * 拉成了它从 pending 挪进 stack;拉不成那一句进窗位 note(告诉他还能把窗拖进虚线区)。
   */
  const [claimingKey, setClaimingKey] = useState<string | null>(null)
  const claim = (key: string): void => {
    setClaimingKey(key)
    void postSilently(`${baseUrl}/dock/claim`, { app: key }, fetchImpl).finally(() => {
      setClaimingKey(current => (current === key ? null : current))
    })
  }
  /** 那一格的 ✕:从窗口槽拿掉(不要这个标签了)。走既有的 /apps/remove(记进 disabled,不删任何东西)。 */
  const unwant = (key: string): void => { void postSilently(`${baseUrl}/apps/remove`, { key }, fetchImpl) }
  // 点蓝点=对那批未读完成会话逐条说看过了(失败静默,真相以下一拍轮询为准)。
  const markReads = (reads: readonly Pick<BadgeSession, 'agent' | 'session_id' | 'via'>[]): void => {
    postReads(reads, baseUrl, fetchImpl)
  }
  return (
    <div className="ben-wb__dock">
      <div className="ben-wb__dock-tabs" role="group" aria-label="窗位叠标签">
        {/* W4:固定第一格。**不加 ✕**——不可拖出、不可除名。dock 整体未接入
            (dockService 没挂)时这一格照样在:那种情况本来就没有原生窗会盖住 iframe。 */}
        {/* W4 + 2026-09-21:选中了某个自定义模块时,**事务官这一格不算选中** ——
            那会儿服务端的 `dock.current` 同样是 null(两档走的是同一条 /dock/hide),
            光看 butlerActive 分不出来,得把"选中的是哪个自定义模块"一起算进去。 */}
        {showButlerTab && (
        <span className="ben-wb__dock-tab ben-wb__dock-tab--butler" data-current={butlerActive && (activeModuleId ?? null) === null}>
          <button type="button" className="ben-wb__dock-tab-name" onClick={onSelectButler}>
            {/* 事务官那一格的图标(2026-09-26,卡 LG2):**工作台自己的图标** —— 登记表里 `self`
                那一条的图就是它(`agentDiscovery.icon` 把 self 换成工作台的包标识),所以这一格
                不必另开一条取图的路。取不到 → 中性小方块:它这一格原来一个记号都没有,
                凭空多一颗彩色圆点会被读成「事务官在跑」,而那件事由旁边的琥珀气泡说。 */}
            <AppIcon
              {...(butlerSelf?.icon === true ? { src: agentIconSrc(butlerSelf.id, baseUrl) } : {})}
              fallback="square"
            />
            {BUTLER_TAB_LABEL}
          </button>
          {/* 等你的几件(2026-09-25,卡 M):同应用标签那一套圆点 + 悬停气泡;点圆点 = 切过来并把那几张摊开。 */}
          {butlerWaiting !== undefined && butlerWaiting.count > 0 && (
            <span className="ben-wb__dock-badges">
              <DockTabBadge
                badge={{ tone: 'waiting', count: butlerWaiting.count, lines: butlerWaiting.lines.length > 0 ? butlerWaiting.lines : [`等你 ${butlerWaiting.count} 件`] }}
                onMarkRead={butlerWaiting.onOpen}
                actionLabel={`看等你的 ${butlerWaiting.count} 件`}
              />
            </span>
          )}
        </span>
        )}
        {orderedTabs.map((tab) => {
            const badgesForTab = tabBadges(tab, sessions, badges, registry, running)
            // 这一格对上的那一家(按包标识,卡 Q)。在登记表里的走 `/agents/icon/<登记表 id>`(卡 LG);
            // 不在登记表里的(微信、企业微信、Notion、终端、Finder、Pen……)走 `/apps/icon/<坞项的键>`
            // (2026-09-26,卡 LG2;维护者 18:05:「现在只有 Agent 有 logo,你看着怪不怪」)——
            // **坞上每一格都有图**,取不到才是一个中性小方块。
            const entry = registry?.agent_registry === undefined ? undefined : entryForDockTab(registry, tab)
            // 登记表里的家用登记表的名字(「豆包办公」),坞上存的旧标签(「豆包」)只作退路 —— 名字只有一份(2026-09-26)。
            const label = entry?.name ?? tab.label
            return (
              <span
                key={tab.key}
                className="ben-wb__dock-tab"
                data-current={tab.current}
                data-running={tab.running}
                data-dragging={draggingKey === tab.key}
                // 这一格的窗其实不在窗位里(2026-09-25):虚边 + 「点一下拉进来」,同还没认领的那几格一个样子。
                data-unplaced={tab.unplaced !== undefined ? 'true' : undefined}
                draggable
                onDragStart={(event) => {
                  setDraggingKey(tab.key)
                  event.dataTransfer.effectAllowed = 'move'
                  // 带上 key:跨渲染的拖拽状态以 dataTransfer 为准,React state 只用来加高亮。
                  event.dataTransfer.setData('text/plain', tab.key)
                }}
                onDragEnd={() => setDraggingKey(null)}
                onDragOver={(event) => {
                  event.preventDefault() // 不 preventDefault 就不会触发 drop
                  event.dataTransfer.dropEffect = 'move'
                }}
                onDrop={(event) => {
                  event.preventDefault()
                  const fromKey = event.dataTransfer.getData('text/plain') || draggingKey
                  setDraggingKey(null)
                  if (fromKey !== null && fromKey !== '') reorder(fromKey, tab.key)
                }}
              >
                <DockAppButton
                  label={label}
                  onClick={() => switchTo(tab.key)}
                  hint={tab.unplaced !== undefined
                    ? `${tab.unplaced} · 点一下拉进来`
                    : tab.dual === true ? '同时切换两扇窗口' : undefined}
                  {...(tab.unplaced === undefined ? {} : { 'aria-label': `${label}:点一下拉进来` })}
                >
                  {/* 那一格的图标(卡 LG / LG2):16px 圆角,名字前面。读屏不念它(名字就在旁边)。
                      是 Agent 的那几家取不到时退回**它自己颜色的色点**(状态语义在那颗点上);
                      不是 Agent 的那几家退回**中性小方块** —— 它们本来就没有状态色,
                      给一颗彩色圆点等于凭空发明「微信在跑」这种意思。 */}
                  {entry !== undefined
                    ? <AgentIcon id={entry.id} icon={entry.icon} tint={entry.color} baseUrl={baseUrl} />
                    : <AppIcon src={appIconSrc(tab.key, baseUrl)} fallback="square" />}
                  {label}
                  {/* 窗没在窗位里(2026-09-25,卡 fix/slot-current-empty):点了照旧 /dock/switch ——
                      那条路会先开应用、唤窗、摆位、置前,正是"拉进来"。原因在轻提示里,也在槽里那一句。 */}
                  {tab.unplaced !== undefined && (
                    <span className="ben-wb__dock-tab-hint" aria-hidden="true">点一下拉进来</span>
                  )}
                  {/* 双窗态标记(2026-08-25「一个标签两半」):一枚标签管两扇窗时,
                      光看标签名分不出来——切换/放出会同时动两扇窗,这件事必须看得见。
                      用「⧉」而不是数字 2:它是"两层叠着"的形,不会被误读成未读计数。 */}
                  {tab.dual === true && (
                    <span className="ben-wb__dock-tab-dual" aria-label="这枚标签管着两扇窗">⧉</span>
                  )}
                </DockAppButton>
                {badgesForTab.length > 0 && (
                  <span className="ben-wb__dock-badges">
                    {badgesForTab.map((badge) => {
                      const reads = badge.reads
                      return (
                        <DockTabBadge
                          key={badge.tone}
                          badge={badge}
                          onMarkRead={reads === undefined ? undefined : () => markReads(reads)}
                        />
                      )
                    })}
                  </span>
                )}
                <button
                  type="button"
                  className="ben-wb__dock-tab-close"
                  aria-label={`放出 ${label}`}
                  onClick={() => release(tab.key)}
                >
                  ✕
                </button>
              </span>
            )
          })}
        {/* 他要的、还没拉进来的那几家(2026-09-25):跟在认领了的标签之后,虚边、写「点一下拉进来」。
            维护者 09-24:「他说把一些应用拉进去,它也没拉啊」—— 原来 enabled 只进了清单,这一排一个都没有。
            **不可拖拽排序、没有徽章**:背后还没有窗,没有会话可挂。✕ = 不要这个标签了(不是"放出")。 */}
        {(dock?.pending ?? []).map(tab => (
          <span
            key={`pending:${tab.key}`}
            className="ben-wb__dock-tab ben-wb__dock-tab--pending"
            data-pending="true"
            data-busy={claimingKey === tab.key}
          >
            <DockAppButton
              label={tab.label}
              onClick={() => claim(tab.key)}
              disabled={claimingKey === tab.key}
              hint="点一下拉进窗口槽，没开着会先打开"
              aria-label={`${tab.label}:点一下拉进来`}
            >
              {/* 还没拉进来的那几格也有图(2026-09-26,卡 LG2):图从 `/apps/icon/<键>` 来,
                  与认领了的那几格同一条路 —— 这一格背后还没有窗,可那个 App 装着,图标就在那儿。 */}
              <AppIcon src={appIconSrc(tab.key, baseUrl)} fallback="square" />
              {tab.label}
              <span className="ben-wb__dock-tab-hint" aria-hidden="true">{claimingKey === tab.key ? '正在拉…' : '点一下拉进来'}</span>
            </DockAppButton>
            <button
              type="button"
              className="ben-wb__dock-tab-close"
              aria-label={`从窗口槽拿掉 ${tab.label}`}
              title="不要这个标签了"
              onClick={() => unwant(tab.key)}
            >
              ✕
            </button>
          </span>
        ))}
        {/* 自定义模块(2026-09-21):跟在应用标签之后,与事务官同一档。
            **不可拖拽排序**——顺序由「做出来的先后」决定(服务端按 created_at 排),
            那是一个不会骗人的顺序;而 dock.stack 那套拖拽排序落盘在 dock.json 里,
            自定义模块不在那份清单里,硬塞进去就要多维护一份顺序。 */}
        {(modules ?? []).map(module => (
          <CustomModuleTab
            key={module.id}
            module={module}
            current={activeModuleId === module.id}
            onSelect={() => onSelectModule?.(module.id)}
            {...(onRemoveModule === undefined ? {} : { onRemove: () => onRemoveModule(module.id) })}
          />
        ))}
        {/* 「开发一个小工具」殿后(2026-09-20)。放在标签之后而不是「事务官」旁边:
            它不是一个可切换的去处,是这一排最末尾的一个动作。见 onDevTool 的注释。 */}
        {onDevTool !== undefined && <DevToolButton onClick={onDevTool} />}
      </div>
    </div>
  )
}
