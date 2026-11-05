/**
 * 窗位叠(spec 2026-08-24 窗位叠 v2 V1–V6):拖进窗位的窗口认领成一枚标签,叠里同一时刻
 * 只显示 current 那扇,其余隐藏在后台;认领/整理/拖出/切换/放出全部服务端决策,壳只是
 * 执行 set_window_frame/raise_window/hide_app/unhide_app 这几个原语(同 orchestrator.ts/
 * scenes.ts 的分工)。
 *
 * 落盘 ~/.dsh/workbench/dock.json,原子写+容错读+写队列,先例见 scenes.ts。
 */
import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { ActivationDecision, ActivationRecord, HelperRect, ShellActivation, WorkbenchState } from '../protocol.ts'
import type { AppsRegistry } from './appsRegistry.ts'
import type { HelperChannel } from './helperChannel.ts'
import { APP_BUNDLES, ensureRunningWith, isRunning } from './activation.ts'
import { pageRectToScreen } from './orchestrator.ts'
import { matchWindowIndex, splitSlot } from './dockSplit.ts'

/** 一扇被叠管着的窗。只记"认领前那一帧"——放出时要送回它,别的都能现算。 */
export interface StoredDockWindow { original: HelperRect }

/**
 * 叠里的一项 = 一枚标签 = 一个应用。
 *
 * `second` 缺省即单窗态,旧 dock.json 读进来天然是单窗——**零迁移**。
 * 有 `second` 就是双窗态:槽位劈两半,两扇各贴一半(spec 2026-08-25 双窗堆叠)。
 */
export interface StoredDockItem {
  app: string
  bundle_id: string
  original: HelperRect
  second?: StoredDockWindow
}
export interface DockFile { version: 1, stack: StoredDockItem[], current: string | null }

/**
 * 程序化认领的结果(2026-09-25,卡 fix/quota-and-slot-apps)。维护者 09-24:「他说把一些应用拉进去,
 * 它也没拉啊」—— 引导 ④ 只把五家写进了 apps.json 的 enabled,窗口槽空着,她却说「摆好了」。
 *
 * - `claimed`     这一次拉进来了;
 * - `already`     本来就在窗口槽里;
 * - `ready`       **只在预览里出现**:开着、壳也连着,真拉的时候会直接拉进来 —— 别把它说成「摆好了」;
 * - `needs_click` 开着但这次没拉成(没找到它的窗 / 窗口槽这会儿没露出来),标签上点一下再试,或拖进虚线区;
 * - `not_running` 没开着(批量拉**不替他开应用**),标签上点一下会先打开再拉进来;
 * - `failed`      拉不了:辅助功能没授权 / 工作台 App 没连上 / 应用清单里没有这个键。
 *
 * 引导落地(卡 B)只在 `claimed` / `already` 时说「摆好了」。
 */
export type SlotClaimState = 'claimed' | 'already' | 'ready' | 'needs_click' | 'not_running' | 'failed'

export interface SlotClaimRow {
  /** 窗位键(claude / codex / kimi / wechat / wecom …)。 */
  app: string
  /** 展示名(Claude / 微信 …)。 */
  label: string
  state: SlotClaimState
  /** 一句人话,原样可念、可显示,不含路径。 */
  note?: string
}

export interface SlotClaimReport {
  /** 他要的那几家全在窗口槽里了(claimed + already)。一家都不要时也是 true。 */
  ok: boolean
  /** 预览(不动窗口)回的带它。 */
  preview?: true
  /** 按 apps.json enabled 的顺序,一家一行。 */
  results: SlotClaimRow[]
  /** 此刻在窗口槽里的(claimed + already)—— **只有这些能说「摆好了」**。 */
  claimed: { app: string, label: string }[]
  /** 不在的那几家;标签上写「点一下拉进来」。 */
  pending: SlotClaimRow[]
}

export function defaultDockFile(home = process.env.HOME ?? ''): string {
  return `${home}/.dsh/workbench/dock.json`
}

function emptyDockFile(): DockFile {
  return { version: 1, stack: [], current: null }
}

export async function loadDockFile(file: string): Promise<DockFile> {
  let text: string
  try {
    text = await readFile(file, 'utf8')
  }
  catch {
    return emptyDockFile()
  }
  try {
    const parsed = JSON.parse(text) as Partial<DockFile> | null
    if (typeof parsed !== 'object' || parsed === null || !Array.isArray(parsed.stack)) return emptyDockFile()
    return { version: 1, stack: parsed.stack, current: parsed.current ?? null }
  }
  catch {
    return emptyDockFile() // 写坏了按空叠兜底,先例见 scenes.ts loadScenesFile。
  }
}

export async function saveDockFile(file: string, data: DockFile): Promise<void> {
  await mkdir(dirname(file), { recursive: true })
  const tmp = `${file}.${randomUUID()}.tmp`
  await writeFile(tmp, `${JSON.stringify(data, null, 2)}\n`)
  await rename(tmp, file)
}

/** 中心点判定(spec V1):比矩形重叠判定更贴近"拖进/拖出"的直觉——窗口过半在外也该算拖出。 */
function center(rect: HelperRect): { x: number, y: number } {
  return { x: rect.x + rect.w / 2, y: rect.y + rect.h / 2 }
}

function insideRect(point: { x: number, y: number }, rect: HelperRect): boolean {
  return point.x >= rect.x && point.x <= rect.x + rect.w && point.y >= rect.y && point.y <= rect.y + rect.h
}

/** 逐字段比较,{...rect} 这种同值不同引用的重报不该被当成"变了"。 */
function rectEquals(a: HelperRect | undefined, b: HelperRect | undefined): boolean {
  if (a === undefined || b === undefined) return a === b
  return a.x === b.x && a.y === b.y && a.w === b.w && a.h === b.h
}

/**
 * S2(b)(review,真机截图实证)噪声门槛:四条边跟上一次存的矩形相比都小于这个像素数就
 * 当"没变"处理——页面小重排产生的抖动通常只有个位数像素,8px 足够滤掉这类噪声,又不会
 * 挡住真正的变化(窗位模块调高/收起/标签栏冒出这类变化幅度至少几十像素)。调用方
 * (setSlotRect)已经先排除了 a/b 任一为 undefined 的情况,这里只处理两边都有值时的
 * "多接近算接近"。
 */
const SLOT_RECT_NOISE_THRESHOLD_PX = 8

function rectNearlyEqual(a: HelperRect, b: HelperRect, thresholdPx: number): boolean {
  return Math.abs(a.x - b.x) < thresholdPx && Math.abs(a.y - b.y) < thresholdPx
    && Math.abs(a.w - b.w) < thresholdPx && Math.abs(a.h - b.h) < thresholdPx
}

export interface DockServiceOptions {
  file: string
  /** `supports`(可选):壳会不会「遮罩一收就藏回去」(`rehide`)。老的假件没有这一格,按「会」处理。 */
  helper: Pick<HelperChannel, 'request' | 'supports'>
  registry: AppsRegistry
  runCommand: (cmd: readonly string[]) => Promise<{ ok: boolean, stdout: string }>
  sleep: (ms: number) => Promise<void>
  onChanged?: () => void
  /** 当前时刻(ms)。默认 Date.now——测试借此注入固定/递增的时钟,验证 2s 回声抑制窗口。 */
  now?: () => number
  /**
   * A2(b) 自愈注册成功后调用一次——registry 的应用清单刚多了一条(或某个基础键被
   * 重新启用),index.ts 借此重发 observe 订阅集合,让壳的观察范围跟着刷新。
   * 不传就不发(测试/未接 index.ts 时没有这层)。
   */
  onAppRegistered?: () => void
  /**
   * 引导还没做完(2026-09-18「第一次用:一切从空开始」)。同步取值,读的是内存里的
   * 引导阶段(`/state.onboarding.done` 的同一份真相)。
   *
   * Ben 真机原话:「我是第一次用啊……窗口槽里也什么都有了。」第一次那一刻,窗位叠里
   * **只能有他自己放进去的东西** —— 所以首次期间,没认领过的应用只有 `dragged === true`
   * (壳看见了真实的鼠标拖拽)才认领;应用自己重建窗口、我们程序化摆位这类
   * `dragged === false` 的帧一律不认领。
   *
   * 为什么不把整条认领路都关掉:窗位槽那一格的空态原话就是「把常用的窗口拖进来」。
   * 关掉拖拽认领 = 界面上写着一条按不动的路,那比多认领一扇窗糟得多(D13)。
   *
   * **不传 = 不启用这一档**,行为跟这一版之前一模一样(同 installedKeys / onAppRegistered
   * 的先例):既有那一大批直接造 dockService 的用例一条都不受影响。
   */
  firstRun?: () => boolean
  /**
   * 起来之后把「当前那一扇」重新摆回窗位(2026-09-25,卡 fix/slot-current-empty)。
   *
   * 统筹 0.2.88 真壳验收:插件重载后窗口槽停在「Kimi」标签(dock.json 的 current 是 kimi),
   * 槽里却是一整块空的深色区 —— 服务端重启后 slotRect 是空的,页面重挂后报上来的第一个矩形
   * 按 S5 只存不动窗,于是**从来没有人把 current 那扇窗重新摆回来**:它被藏着(上一条命里
   * 弹层让路藏起来的、重启把 veil 的记忆丢了)、在别处、或者被别家的窗压着,界面都照样
   * 高亮着那个标签。
   *
   * 打开之后:服务起来、壳(重新)连上且授权时记一笔「待摆回」,等页面报来的窗位矩形
   * 稳住 `restoreSettleMs`(没有更新的矩形进来)就看一眼 current:原来就露着、而且在窗位上
   * → 一个字都不动(他可能正在用它);藏着的放出来、不在窗位上的贴回窗位;原来是藏着的,
   * 才把压在窗位上的别的成员藏起来(那时露着的是它们)。**不 raise、不激活、不补发 open**:
   * 这一下发生在重载 / 热更新之后,人可能正在用别的应用,抢焦点就是打断他(壳在桌面档,
   * 普通层的窗本来就在它上面)。摆不回来(没开着、没有窗、壳摆不动)→ 那一格标成
   * 「没在窗位里」+ 原因,引导做完了就回事务官那一页(卡 A 的规则:没有能摆进来的窗时默认看她)。
   *
   * 等矩形稳住而不是第一个矩形一到就摆:S5 那条事故正是"页面瞬断时量出来的假矩形拽着真窗走",
   * 刚挂载那一刻的矩形同样可能是半截布局量出来的。
   *
   * 同一个开关还管「平时」那一半:view() 顺手问一声当前那一家开没开、藏没藏,槽里是空的就在那一格
   * 标上 `unplaced`(见 view)。
   *
   * **不传 = 不启用这一档**(同 firstRun 的先例):既有那一大批直接造 dockService 的用例
   * 不会凭空多出一轮摆窗、也不会多问 lsappinfo。生产在 index.ts 打开。
   */
  keepCurrentInSlot?: boolean
  /** 矩形稳住多久才摆回去(毫秒)。缺省 `RESTORE_SETTLE_MS`;测试给小值。 */
  restoreSettleMs?: number
  /**
   * 他真切过去时窗口槽跟不跟(2026-09-25,卡 P)。壳报来 `activation` 的 `switch`(某家的普通窗口成了最前面那扇、
   * 待满 1.5 秒 —— ⌘Tab、点程序坞、点通知)时,那一家在窗口槽里又不在台前 → 切过去(同点它的标签)。
   * 「临时叫一下」(截图遮罩、划词浮窗、快捷面板)那一半**不看这个开关**:藏回去这一趟放出来的,总是做。
   *
   * **不传 = 不跟**(同 keepCurrentInSlot 的先例):既有那批直接造 dockService 的用例不会凭空多切一次窗。生产在 index.ts 打开。
   */
  followActivation?: boolean
}

/** 起来之后窗位矩形稳住多久才把 current 摆回去(见 DockServiceOptions.keepCurrentInSlot)。 */
export const RESTORE_SETTLE_MS = 1_200
/** 摆回时 unhide 之后等它的窗出来:最多问几次、隔多久(不补发 open,见 restoreCurrent)。 */
const RESTORE_WINDOW_TRIES = 3
const RESTORE_WINDOW_WAIT_MS = 300

/**
 * 「当前那一扇」此刻的样子,多久问一次 lsappinfo(开没开、藏没藏)。只问 current 这一家,
 * 一次一个子进程 —— 比 view() 那份每个标签都问的 5 秒缓存更勤一点,因为这一格要回答的是
 * "槽里是不是空着"(2026-09-25,见 view 里 `unplaced` 那一段)。
 */
const CURRENT_PROBE_TTL_MS = 3_000

export interface DockService {
  /** 页面报来的窗位矩形(页面坐标),每次上报都覆盖上一次——未上报过时 handleMoved 不认领(D13)。
   *  传 undefined 表示清除上一次的上报(I3):窗位隐藏/被日历借位时槽体已经卸载,残留的旧矩形
   *  会把之后的拖入/切换错误地贴到一块看不见的区域上,必须能失效。
   *  S5(review,真机截图实证,取代 S2(b) 里"矩形一变就跟随重贴"那部分描述):reason 不传或非
   *  'resize' 时只存矩形、推悬停圈,绝不动当前在台窗口——被动上报(挂载、ResizeObserver、
   *  窗口 resize)不可信,页面态瞬断(轮询漏一拍→offlineState、DSH 重启、WS 抖一下)会让
   *  标签栏/滚动条瞬间不渲染,槽体测出的矩形跳到模块顶部,若照旧跟随重贴,真实窗口跟着被
   *  这条"假矩形"拽上去——这正是"贴住的窗口莫名往上窜"的根因,是被动上报在驱动真实窗口。
   *  只有明确的用户动作(拖拽窗位模块把手调高度松手、布局里 slot 模块 basis 真的变了)才传
   *  reason:'resize',这时才允许跟随重贴当前窗口;认领(adopt)、切换(switchTo)是各自独立
   *  的重贴路径,不经过这个开关。
   *
   *  每一次调用(不管最终是否真的更新了 slotRect,含被 rectEquals/8px 噪声门槛挡下的)都会
   *  记入 view() 可选透出的 recent_rects 观测环——排障"到底收到过哪些矩形上报"用,见下面
   *  recordRect 的注释。 */
  setSlotRect(rect: HelperRect | undefined, reason?: 'resize'): void
  /**
   * 矩形上报只认壳内页面(2026-08-25 真机实证,评审补):http.ts 在 source !== 'app' 时
   * 业务层直接拒绝上报、根本不调用 setSlotRect——部署兼容窗口期(壳内页面还没跟上带
   * source 这条规则)排障时,recent_rects 环会因此对这些被拒请求完全失明,"环是空的"
   * 和"确实没在报"无法区分。这个方法专供 http.ts 的拒绝分支调用:只往 recentRects
   * 观测环里记一条 `rejected:true` 的条目,绝不碰 slotRect 本身——被拒的矩形永远不该
   * 真的存进去,这正是它跟 setSlotRect 分成两个方法而不是共用一个的原因。
   */
  recordRejectedRect(rect: HelperRect | null, reason?: 'resize'): void
  /**
   * 壳重启后呼吸圈永久消失(真机实证 2026-08-25):悬停圈(hover_zone)只存在壳内存,
   * 壳重启即丢;setSlotRect 只在矩形真的变化时才推(rectEquals + 8px 噪声门槛两道
   * 早退都在推送之前),但壳重启后页面重挂上报的还是同一个矩形,会被这两道早退
   * 挡住,圈从此再也不会送到新壳里。这个方法专供"壳重新连上"这个时刻调用——
   * 无条件重推一次当前的悬停圈状态,不管矩形是否变化:slotRect 为 undefined 就推
   * {rect:null}(壳可能还留着上一条命的旧圈,得清掉),有值则按当前矩形换算屏幕
   * 坐标后推。换算失败(壳断线等)静默放弃,先例见 setSlotRect 里的同款 catch;
   * helper.request 失败同样吞掉——这纯粹是视觉信息同步,失败不升级成 note。
   */
  pushHoverZone(): Promise<void>
  /**
   * 壳报来的窗口移动落定。dragged(2026-08-26 真机实证:微信重新登录后窗口不归位)是
   * 壳在这扇窗的事件风暴期间对鼠标左键的采样结果:true=用户在拖(认领/整理/拖出的
   * 旧语义全部保留),false=程序化移动——应用自己重建/摆放窗口。微信登录流程会重启
   * 应用、销毁旧主窗口、在默认位置新开一扇小窗,旧逻辑只有"已认领&界外=拖出→除名"
   * 一种解释,微信因此被静默除名(recent_moves 观测环 decision:outside 实锤)。现在
   * 程序化移动的已认领单窗应用一律贴回槽位(归位);缺省(旧壳没这个字段)按 true,
   * 一切按旧行为,部署兼容。
   *
   * pressed(2026-09-18 Claude/企微拖不进窗位)是**落定那一刻**鼠标左键还按着没有——
   * 与 dragged 是两个独立证据,只在「首次 + 没认领过」那一道门上参与判定(见下面
   * `firstRun` 分支),别的分支一个字都不看它。缺省 false = 没有这条证据,按 dragged
   * 单独判,行为与这一版之前一模一样。
   */
  handleMoved(bundleId: string, frame: HelperRect, dragged?: boolean, pressed?: boolean): Promise<void>
  /**
   * Chromium AX 修复:壳侧探测到某个 bundle 的 AXObserver 通道休眠(看似订阅成功但收不到
   * 回调)、已经自动唤醒重试过之后调用——纯粹的诊断信号,不是"这次操作失败了"。走
   * enqueueWrite 与 handleMoved 同一队列(先例:两者都可能在同一时刻读写 registry/note,
   * 不排队会读到中间态)。推入固定容量 8 的内存环(先例 recordMove),registry 认得这个
   * bundle 才 setNote 提一句"已自动唤醒重试"——认不出就只进环,不拿一句用户看不懂的
   * bundle id 去打扰 Ben(M5 同款纪律)。
   */
  handleAxStale(info: { bundle_id: string, ax_err: number, ax_count: number, cg_count: number }): Promise<void>
  switchTo(app: string): Promise<{ ok: boolean, reason?: string }>
  release(app: string): Promise<{ ok: boolean, reason?: string }>
  /**
   * 标签顺序(2026-09-02 Ben:"想把 AI 的都放一块,现在是先来后到,不小心拖出去再回来就到队尾")。
   *
   * 叠序此前**只由认领先后决定**,没有任何人为干预的口子。这里按给定的键序重排并落盘。
   * 三条纪律:
   * - **不丢标签**:名单里没提到的成员按原顺序补在队尾(拖拽时前端只送可见的那些也不会出事);
   * - **不造成员**:名单里不在叠中的键直接忽略;
   * - **不碰窗口**:纯粹是标签顺序,不发任何 helper 请求、不动 current——
   *   与 switchTo/release 那两条会真的搬窗口的路径彻底分开。
   */
  reorder(keys: readonly string[]): Promise<{ ok: boolean, reason?: string }>
  /**
   * W4:把当前在台的窗藏起来、但**不除名**——「事务官」标签要占用窗位显示内嵌 DSH 对话页,
   * 而认领进来的是一扇真实的原生窗口,盖在槽体屏幕矩形上,CSS z-index 排不到它前面
   * (先例见 DockTabBar.tsx 顶部徽章气泡那段注释),不藏起来 iframe 根本露不出来。
   *
   * 与 release 的区别是根本性的:release 会把窗口送回 original 并**从 stack 里除名**;
   * 这里只 hide_app + current=null,成员一个不掉,点回那个标签就能原样回来。
   * 有意做窄:不碰 handleMoved/switchTo/release/setSlotRect 任何一条路径。
   *
   * 残留窗口清理(2026-09-09 Ben 报「点事务官后窗位里偶尔有别的应用窗口盖在上面清理不干净」,
   * 规划见 docs/设计-借鉴功能落位与资产区.md §二):旧实现只藏 `current` 那一扇,认定
   * 「其余成员一定还藏着」——这个前提在真机上不成立,叠里成员会被别的路径重新露出来:
   * 场景恢复(scenes.ts restore 对它 unhide+摆位)、用户自己去 Dock/cmd-tab 点回那个应用、
   * 双窗态第二扇窗(switchTo 的 secondIndex 分支)、handleAppActivated 的重挂。这些路径都
   * 不经过 dockService 的 current,于是事务官的 iframe 被一扇真实原生窗盖住,点「事务官」也清
   * 不掉它。现在改成**对叠内每个成员逐个判定**:
   * - `current` 那一扇无条件 hide_app(既有行为,它按定义就在台上,没必要多问一次);
   * - 其余成员先问 `app_info`,**只有明确报了 running 且未 hidden**才 hide_app——问出来
   *   已经藏着、没在跑、或者壳压根答不上来(字段缺失/报错)的一律跳过,不发多余请求,
   *   也不拿一个猜测去动用户的窗口(D13)。
   * - 被清掉的成员逐条记进 recent_hides 观测环(同 recent_moves/recent_ax/recent_rects
   *   先例),排障时能回答"这次点事务官到底清了谁"。
   *
   * 因此 `current` 已是 null 时**不再是零 helper 往返的空操作**:事务官已在台前、但某个成员
   * 刚被别的路径露出来,再点一次「事务官」必须能把它清掉——这正是 Ben 报的那个现象里唯一
   * 的自救操作。幂等性现在的含义是"不发多余的 hide_app",而不是"不发任何请求"。
   *
   * 失败的处理分两档,对应两件不同的事:
   * - `current` 那一扇没藏成 → 事务官根本露不出来,`current` 保持不动、返回 ok:false(既有行为);
   * - 清理某个残留成员失败 → 当前那扇确实藏起来了,`current` 照常置 null(落盘如实反映),
   *   但返回 ok:false 并把 note 写成"点名是哪个成员 + 壳给的原因",不假装清干净了。
   */
  hideCurrent(): Promise<{ ok: boolean, reason?: string }>
  /**
   * 程序化认领一家(2026-09-25,卡 fix/quota-and-slot-apps):不经拖拽,直接把它的窗摆进窗位、记进叠里。
   * 标签上「点一下拉进来」走这条(缺省 `launch:true` 先开应用、`raise:true` 置前并藏起上一位)。
   *
   * 壳本来就有这几样原语(unhide / app_info / set_window_frame / raise / hide),**不改 Swift**。
   * 拉不成就如实回 `state` + 一句 `note`,并写进 dock.note(那一句告诉他还可以把窗拖进虚线区)。
   *
   * 可选:测试替身不实现它 = 没有这一档,路由 404。
   */
  claim?(app: string, options?: { launch?: boolean, raise?: boolean }): Promise<{ ok: boolean, state: SlotClaimState, note?: string }>
  /**
   * 把 apps.json `enabled` 里还没进窗口槽的那几家一口气拉进来(2026-09-25)。引导落地(卡 B)点「就这样」之后调。
   *
   * 两条纪律:**缺省不替他开应用**(没开着的记 `not_running`,不一口气拉起五个客户端 —— 挤 CPU、也打扰人);
   * **不换当前在台的那一扇**(拉进来的先摆好、藏起来,标签出现;他点标签才显示)。
   */
  claimEnabled?(options?: { launch?: boolean }): Promise<SlotClaimReport>
  /** 同上,但**只读**:不动任何窗口,只说每一家会是什么结果(`ready` = 会直接拉进来)。 */
  claimPreview?(): Promise<SlotClaimReport>
  /**
   * 壳(重新)连上并且授权了(2026-09-25,卡 fix/slot-current-empty)。index.ts 在 helper.onChange
   * 里、**从没连上 / 没授权翻到连上且授权**的那一下调(壳每次被激活都会再报一遍授权,那些不算):
   * 壳重启过的话,current 可能被藏着、窗可能不在原处 —— 记一笔「待摆回」,矩形在手就排一轮
   * (见 keepCurrentInSlot)。没开这一档时是空操作。
   */
  noteShellReady?(): void
  /**
   * 把此刻窗口槽的成员 bundle id 下发给壳(`slot_apps` op,2026-10-04,卡「常亮认窗口槽里的程序」)。
   *
   * **为什么壳要这张表**:09-27 那条「只要工作台在前台就别让屏幕暗下去」要求工作台**自己**是最前面那个 App,
   * 而她用工作台的常态是点进槽里那扇**真窗**(Codex / Claude / 豆包…)—— 那一刻最前面的是那一家,
   * 断言被放掉、屏暗、锁屏(维护者 10-04 量到的那一幕)。壳有了这张名单,才分得清
   * 「她在工作台里用 Codex」和「她切去了槽外的 Safari」。
   *
   * **一处主人**:谁在槽里只有 dock.json 那一叠知道,所以这张表只从这里出 ——
   * 每次 dock.json 落盘(`persistDock`)自动跟一发,外加壳重连那一下由 index.ts 补一发
   * (壳起来那一格缺省是空表)。发不出去(壳没连上 / 旧壳不认)就吞掉:**那只是回到 10-04 之前的行为**,
   * 不升级成 note。
   */
  pushSlotApps(): Promise<void>
  view(): Promise<WorkbenchState['dock']>
  observeTargets(): Promise<string[]>
  /**
   * 壳对 observe 的回执里带了挂载失败的 bundle 清单(I4)时调用——写一条如实的 note
   * 说明"这些应用不支持拖拽认领",经 registry.keyFor 把 bundle id 换成人看得懂的展示名。
   *
   * M5(review 修复):A2(c)起壳观察的是"当前所有常规界面应用",不再是一份服务端认识的
   * 名单——大部分应用本来就跟窗位叠无关(后台辅助进程、没有主窗口的菜单栏应用等),
   * 它们挂载失败纯属噪音,不该原样报给 Ben(旧版按 D13"查不到就退回 bundle id 本身"
   * 的规矩会把这些噪音也摆出来,在全量观察之下反而淹没真正有用的信号)。这里改成:
   * 只保留 registry 认识的 bundle,或者虽然 registry 不认识但已经在窗位叠 stack 里
   * (理论上不该发生,防御性保留)——两者都不是的直接从这份清单里丢弃,不写进 note。
   *
   * F1(review 修复,真机截图实证):过滤完是空的(这轮没有真正的失败)时,如果当前
   * note 正是上一次 observe 失败写的(前缀匹配),会顺带清掉它——不然真机上会看到
   * 一条永远清不掉的陈旧"不支持拖拽认领"(典型成因:壳启动时 TCC 还没授权,首次
   * attach 全军覆没写了这条 note,授权后重新 attach 全部成功,但旧代码"这轮没失败
   * 就什么都不做",陈旧 note 因此永远留着)。不是 observe 失败写的 note 不受影响。
   */
  noteObserveFailures(bundleIds: readonly string[]): Promise<void>
  /**
   * 我们自己发起的激活(POST /activate、场景恢复;switchTo 在内部自己记)要在**发出激活之前**
   * 调一次:给这个应用留 ACTIVATE_SUPPRESS_MS 的抑制期,期内应用自摆到槽外(dragged=true)
   * 不除名、只归位。不在叠里的应用是空操作——没有标签可保。
   */
  noteActivated(app: string): Promise<void>
  /**
   * 壳报来的「有一家被叫到前面」的结论(2026-09-25,卡 P;维护者:「每次使用截图,都会把企业微信显示出来,
   * 预期应该是保持页面不变,这个机制应该对其他有截图能力的 APP 都是一个逻辑」)。
   *
   * 对所有应用同一套(判断在壳的 ActivationSense.swift,这里只看那一家在不在窗口槽里、是不是台前那一格):
   * - `transient`(临时叫一下)+ 它在窗口槽里、不是台前那一格 + 被叫出来之前是藏着的 → **藏回去**
   *   (macOS 激活藏着的应用会先把它放出来,它摆在窗口槽位置上的那扇主窗就盖了出来)。当前那一格不变、
   *   不置前任何窗、不动工作台自己的层级;
   * - `switch`(真切过去)+ 它在窗口槽里、不是台前那一格 → 窗口槽跟过去(同点它的标签,`switchTo`);
   *   我们自己刚激活过的(切换、摆回,抑制期内)不算他切的;
   * - `overlay`(遮罩刚开,还不是结论;2026-09-25 卡 P 补)+ 同「藏回去」那三条 → 预约壳「遮罩一收就当场藏回去」
   *   (`arm_rehide`)。遮罩一收壳自己藏,结论带 `rehidden` 来,这里只记账、不再发 hide_app ——
   *   统筹:「截图遮罩一关,立刻把被掀出来的那个窗位 App 藏回去……让『窗口闪一下』尽量看不见」。
   *   遮罩开着时不能藏(会连遮罩一起藏掉,截图就断了);
   * - 不在窗口槽里的:只记一笔(观测环),什么都不动(遮罩开了那一句不记,结论来了再记)。
   * 每一次都进 `recent_activations` 观测环。可选:测试替身不实现它 = 没有这一档。
   */
  handleActivation?(info: ShellActivation): Promise<void>
  /**
   * 他真把一个**新**应用拖进窗口槽、放手那一下(2026-09-25,卡 P;维护者:「窗口槽的流线光效时不时自己闪一下,
   * 其实没拖新应用进去」)。窗口槽那圈流线光**只绑这一个动作**:拖拽认领成功(壳报 dragged / pressed 有一个为真)
   * 才通知一次。点标签切换、摆回、同一个应用重复上报、截图把藏着的放出来、重连、刷新,一概不通知。
   * 可选:测试替身不实现它 = 没有这一档。
   */
  onDropClaimed?(listener: (info: { app: string, bundle_id: string }) => void): void
  /**
   * 弹层让开窗位(2026-09-11,Ben:「弹窗(包括现在的浮窗)一直是在应用下层的」)。
   *
   * 窗位里贴着的是一扇**真实原生窗**,永远在 WKWebView 之上——网页里任何与窗位矩形重叠
   * 的弹层(设置弹窗、任务卡弹窗、归档确认、日结弹层、事务官浮窗)都会被它压住,CSS z-index
   * 排不到操作系统窗口前面(同 DockTabBar.tsx 顶部徽章气泡、hideCurrent 的老问题)。修法
   * 只能是**弹层打开 → 窗位让开;弹层关闭 → 窗位回来**。
   *
   * veil = 把 `current` 那一扇 hide_app 并**记住是谁**(veiledApp);与 hideCurrent 的根本
   * 区别是 **`current` 不动、不落盘**——弹层只是暂时盖上来,标签栏不该跳到「事务官」,窗位也
   * 不该切去别的视图;弹层一关就得原样回来。
   *
   * 残留清理(2026-09-16,Ben:「窗位当前是 Claude,点设置……看到的是 Kimi」):藏完 current
   * 之后**复用 hideCurrent 那套 hideStrays**——其余成员逐个问 app_info,只有明确 running 且未
   * hidden 的才 hide_app。这些窗是早先切走时没藏成(AX 通道休眠那类)或被用户在 Dock/⌘Tab
   * 点回又没除名的,仍停在窗位那块矩形上;只藏 current 它们就露出来盖住弹层。每一发记进
   * recent_hides(decision 'veil-current' / 'veil-stray')。`current` 为 null(事务官在台)时同样
   * 扫一遍——弹层不能被残留窗盖住,跟 hideCurrent 的自救路径同理。清残留失败 → ok:false +
   * note 点名成员与壳原话,但 veiledApp 照记(current 确实藏成了),弹层照开。current 那扇
   * 没藏成时**不再扫**:AX 已经不通,多问只是多几条失败。
   *
   * **计数式**:多个弹层同时开只 veil 一次(hide_app 只发一次),最后一个关才 unveil——depth
   * 就是"此刻有几个弹层开着"。计数与 veiledApp 都只在内存:8791 重启后没有"正 veil 着"这回事,
   * 重启前那扇被藏起来的窗由用户点标签找回来(switchTo 走 unhide),不卡任何弹层。
   *
   * hide_app 失败(壳断开/AX 拒绝)→ ok:false 带壳原因,**计数照记、但不记 veiledApp**——
   * 弹层不能因为让路失败而打不开,而没藏成的窗之后也不该被 unveil 去"unhide"一次。
   */
  veil(): Promise<{ ok: boolean, reason?: string }>
  /**
   * 弹层关闭。计数减一;减到 0 且确实 veil 过一扇窗(veiledApp)时,**只有 `current` 还是那一扇**
   * 才把它 unhide 并按**当前** /slot/rect 重贴、置前(复用 switchTo 的贴合路径 placeInSlot,
   * 含双窗劈槽);用户在 veil 期间点了别的标签(switchTo)、点了「事务官」(hideCurrent)、放出
   * 了它(release)都算他改了主意,unveil 一律不动——不把他刚切走的窗又拉回来(验收 4)。
   *
   * veil 时清掉的残留窗**不带回**——它们本来就不该露在窗位上,用户点标签会正常切回(switchTo
   * 走 unhide)。只把 current 那一扇 unhide 并重贴。
   *
   * ★ 让路期间她把那家**退掉了** → 不替她开回来(2026-10-19):那一格标「没开着」(unplaced),
   * ok:true、一条壳请求都不发;开不开它由她点标签(switchTo)说了算。原来这条路会经 placeInSlot 的唤窗
   * 补发一次 open,维护者机器上微信因此一上午被开回来 39 次。
   *
   * 计数已是 0 时是空操作(客户端 keepalive 补发的 off、页面重载后的多余 off 都会落到这里)。
   * 重贴失败(壳断开)→ ok:false + note 如实写,但 veil 状态照样清掉——弹层关闭必须无条件成功,
   * 下一次弹层打开又是一次干净的 veil。不打光圈:veil/unveil 不在 highlight.ts 的 PLANS 表里。
   */
  unveil(): Promise<{ ok: boolean, reason?: string }>
}

const NOTE_SLOT_UNKNOWN = '窗位矩形未上报,拖拽认领暂不可用'
/** switchTo 专用文案(区别于 handleMoved 的拖拽场景):点标签时"拖拽认领"不通,得说清是切换动作本身办不了。 */
const NOTE_SWITCH_SLOT_UNKNOWN = '窗位矩形未上报,暂不能切换——刷新工作台页面后重试'
const REASON_NOT_ADOPTED = '未认领:先把窗口拖进窗位'
/**
 * F1(review,真机截图实证):noteObserveFailures 写的 note 固定这个前缀——用来跟"这条
 * note 是不是 observe 失败写的"这件事做匹配(见下面 noteObserveFailures 的清除逻辑),
 * 不是靠一个额外的布尔标记。改这句文案要记得两处一起改(setNote 那句和这个前缀常量)。
 */
const OBSERVE_FAILURE_PREFIX = '以下应用不支持拖拽认领:'
/**
 * 事务官清理残留窗口失败的文案前缀(2026-09-09 事务官标签 bug):当前那扇已经藏起来了,
 * 但叠里某个被别的路径露出来的成员没藏成——事务官的 iframe 还会被它盖住一块,必须如实
 * 点名是哪个成员、壳给的原因是什么,不含糊成一句"清理失败"。
 */
const NOTE_STRAY_HIDE_FAILED = '已藏起当前窗,但这些窗口没清掉:'
/** veil 同款(2026-09-16 弹层让路清理压窗):弹层已开、current 已让开,只是压在窗位上的残留窗没清成。 */
const NOTE_VEIL_STRAY_FAILED = '弹层让路时这些窗口没清掉:'

/** 叠里的都是单窗聊天类客户端(claude/codex/kimi 等),窗口索引固定 0——同 scenes.ts restore 摆位/置前的惯例。 */
const DOCK_WINDOW_INDEX = 0

/**
 * 程序化认领时等窗的预算(2026-09-25)。批量拉时这是**每一家**的上限:一家等不到窗就记 needs_click,不拖着后面几家一起等。
 *
 * 2026-10-12 从 3 秒放到 8 秒(运营同学 10-08 那一条,卡 `claude/ops-patch-1012`):他那台机器上几家 Electron
 * 的 AI 客户端(可灵、通义、ima)冷启动后 3 秒内窗还没建出来,一拉就记 needs_click、要他再点一次。
 * 切换那条路(SWITCH_TOTAL_BUDGET_MS)照旧 3 秒 —— 那是他点了标签在等,这里是后台拉。
 */
export const CLAIM_WINDOW_BUDGET_MS = 8000

/**
 * 贴完等多久再量一次(2026-10-12,同上那一条):有些 App 第一下 `set_window_frame` 只吃一半 ——
 * 位置先到、尺寸下一拍才到,量到不在槽位就再贴一次。150ms 是壳侧 AX 回声之后、人看不出的一拍。
 */
const FIT_RECHECK_MS = 150

/** 窗位量不到时那一句(收起了、纯净模式、工作台窗口没开 —— 页面上那块槽根本不在)。 */
function slotHiddenNote(label: string): string {
  return `窗口槽这会儿没露出来(收起了、纯净模式,或者工作台窗口没开),露出来之后点「${label}」标签就能拉进来`
}

/**
 * 壳的报错 → 认领结果那一档 + 一句人话。授权与连接两样是"点标签也没用"的(`failed`),
 * 其余(没有第 0 个窗口、摆位读不回来……)点一下标签可能就好了,或者他自己拖(`needs_click`)。
 */
function claimFailure(label: string, error: unknown): { ok: false, state: SlotClaimState, note: string } {
  const message = error instanceof Error ? error.message : String(error)
  if (message.includes('辅助功能')) {
    return { ok: false, state: 'failed', note: `辅助功能还没授权给工作台,拉不了「${label}」—— 授权之后点标签就能拉进来` }
  }
  if (message.includes('工作台 App')) {
    return { ok: false, state: 'failed', note: `工作台 App 没连上,拉不了「${label}」` }
  }
  return { ok: false, state: 'needs_click', note: `没把「${label}」拉进来(${message})—— 点标签再试一次,或者把它的窗拖进虚线区` }
}

/** 一批结果 → 回给调用方的那一份(claimed / pending 两张表由 results 现分,不另记)。 */
function slotReport(results: SlotClaimRow[], preview = false): SlotClaimReport {
  const inSlot = (row: SlotClaimRow): boolean => row.state === 'claimed' || row.state === 'already'
  const pending = results.filter(row => !inSlot(row))
  return {
    ok: pending.length === 0,
    ...(preview ? { preview: true as const } : {}),
    results,
    claimed: results.filter(inSlot).map(row => ({ app: row.app, label: row.label })),
    pending,
  }
}

/** 第二扇窗认不出来时的如实说明——不猜、不假装铺开成功了(D13)。 */
/** 观测环里矩形的紧凑写法——排障要一眼比对,不要一屏 JSON。 */
function fmtRect(r: HelperRect): string {
  return `${Math.round(r.x)},${Math.round(r.y)},${Math.round(r.w)}x${Math.round(r.h)}`
}

const NOTE_SECOND_MISSING = '第二扇窗已经不在了(可能被关掉),这次只处理了主窗'
const NOTE_SECOND_UNRESOLVED = '这扇窗认不出是哪一扇(AX 窗口无稳定 id),已按单窗处理'

/**
 * 唤窗有限重试上限(真机实测补:企业微信 running 但常驻后台、主窗口数=0)——同
 * orchestrator.ts 的 WINDOW_WAIT_TRIES/WINDOW_WAIT_MS(贴合路径已经踩过同一个坑,
 * 这里对齐同一套语义:纯等不会等出窗口,得补一次 open 唤窗)。10 次 × 500ms 是
 * 单次切换动作内的有限重试,不是后台轮询。
 */
const DOCK_WINDOW_WAIT_TRIES = 10
const DOCK_WINDOW_WAIT_MS = 500

/**
 * 一次切换的总预算(2026-09-21 Ben:「今天点击标签切换应用经常卡住」)。
 *
 * 根因不在这条路径的逻辑,在**每一次 AX 调用都在同步等目标应用回话**:机器负载 100–200 时
 * 一次 `/dock/switch` 要好几秒,负载降到 5 之后同一条路只要 40ms。壳那边已经给每个
 * AXUIElement 上了 1 秒的消息时限(`workbench-app/Sources/SwitchBudget.swift`,那边是这组
 * 数字的家、也有单测),但"每一步都有上限"不等于"整件事有上限"——唤窗最多 10×500ms、
 * 摆位/置前/藏别家各自还要一两次往返,叠起来照样能过十秒。所以这里再立一道整体的闸。
 *
 * - `SWITCH_TOTAL_BUDGET_MS`:整件事最多花这么久就回 8791。3 秒是"人还愿意认为这是在
 *   响应我"的上限——再久他会去点第二下,而第二下排在写队列后面,只会更慢(真机上"卡住"
 *   的观感正是这么叠出来的)。
 * - `SWITCH_HIDE_BUDGET_MS`:"藏别家"这一段的预算。**抬起要切到的那家优先**(那是用户
 *   看得见的一半),藏别家是收尾,晚几百毫秒没人看得出来——所以它是可以被牺牲、挪进
 *   后台队列慢慢做的那一段。
 *
 * 用 `opts.now()` 而不是 `Date.now()` 计时:测试要能用假时钟精确验证预算边界(同
 * ECHO_SUPPRESS_MS / AX_STALE_THROTTLE_MS 的先例)。
 */
export const SWITCH_TOTAL_BUDGET_MS = 3000
export const SWITCH_HIDE_BUDGET_MS = 1500

/**
 * release 回声抑制窗口(C1):release 把窗口 set_window_frame 送回 original 是一次程序化移动,
 * 壳的 AXObserver 分不清"程序化"和"用户拖动",300ms 去抖之后照样会报一次 moved 事件——而
 * original 正是认领前那一帧,必然落在窗位矩形内,handleMoved 的认领分支如果照单全收,
 * 刚放出的窗口会被立刻重新认领,✕ 按钮形同虚设。2s 足够盖过壳侧 300ms 去抖 + 一来一回的
 * 网络/AX 延迟,又不会长到真把窗口拖回来时还被当回声吞掉。
 */
export const ECHO_SUPPRESS_MS = 2000

/**
 * 程序化激活抑制期(2026-09-09 从 Dock/⌘Tab 点回已认领的应用会丢标签,Ben 拍板修法):
 * `POST /activate`、switchTo、场景恢复这类**我们自己发起**的激活,会让应用自己重建/摆放
 * 窗口——企业微信被唤到前台时把窗口摆回槽位外,壳把这次移动报成 dragged=true(真机实证,
 * 见 docs/交接-0909-事务官标签残留窗口.md「验收中踩的坑」),handleMoved 按「已认领+界外=
 * 拖出」把它除名,标签就没了。2026-08-26 那次只接住了 dragged=false 这一支。
 *
 * 这里对「刚被我们程序化激活」的 bundle 留一个抑制期:期内 已认领+dragged=true+界外 不除名、
 * 只归位(decision:suppressed)。长度取 ECHO_SUPPRESS_MS 的两倍:回声抑制只需要盖住一次
 * set_window_frame 的 300ms 去抖+一来一回;激活要盖住 open/unhide → 应用自己重建/摆放窗口
 * → 壳去抖 这一整段,比单次回声长。再长就会把用户点回之后紧接着的真实拖出也吞掉——期内
 * 真拖出会被贴回槽位,过期后再拖一次照旧除名,recent_moves 的 suppressed 记录能说明原因。
 * 抑制期**不**覆盖用户从 Dock/⌘Tab 点回(那条路径根本不经过服务端,服务端无从得知)。
 */
export const ACTIVATE_SUPPRESS_MS = ECHO_SUPPRESS_MS * 2

/**
 * 归位判定容差(2026-08-26 微信重登归位修复):程序化落定的帧与槽位矩形"够接近"就
 * 认为已在槽位,什么都不做——这一档必须存在,不然每次贴合动作自己的 AX 回声(应用
 * 还会按网格/最小尺寸微调,终端实测请求 1400×813、实际 1399×819)都会触发下一轮
 * 归位摆位,循环不止。位置从严(±16px)、尺寸 ±32px。
 *
 * 2026-10-12 起尺寸**两头都看**(运营同学 10-08 那一条,卡 `claude/ops-patch-1012`):原来只设下限
 * (「至少够大」),一扇比槽位宽出几百像素、压到旁边模块上的窗也算「已在槽位」,永远不会被贴回去。
 * 最小尺寸大于槽位的那几家(尺寸上界管不住,交接-0824 坑 4)靠下面的归位冷却掐断循环,不靠放宽判定。
 */
const HOME_POS_TOLERANCE_PX = 16
const HOME_SIZE_SLACK_PX = 32
/**
 * 归位冷却:应用把窗口尺寸钳到与槽位差异超出容差时(最小尺寸大于槽位这类),归位
 * 摆位的回声帧会永远"不在槽位",没有冷却就是 摆位→回声→再摆位 的循环。2s 与
 * ECHO_SUPPRESS_MS 同量级:盖过壳侧 300ms 去抖+一来一回的延迟,又不至于把登录
 * 流程里"先出登录窗、后出主窗"这类相隔几十秒的两次真实归位挡掉。
 */
const HOME_COOLDOWN_MS = 2000

/** 程序化落定的帧是否已经贴在槽位上(容差见 HOME_POS_TOLERANCE_PX/HOME_SIZE_SLACK_PX)。 */
function atSlot(frame: HelperRect, slot: HelperRect): boolean {
  return Math.abs(frame.x - slot.x) <= HOME_POS_TOLERANCE_PX
    && Math.abs(frame.y - slot.y) <= HOME_POS_TOLERANCE_PX
    && Math.abs(frame.w - slot.w) <= HOME_SIZE_SLACK_PX
    && Math.abs(frame.h - slot.h) <= HOME_SIZE_SLACK_PX
}

export function createDockService(opts: DockServiceOptions): DockService {
  let slotRect: HelperRect | undefined
  // note 是运行态的"最近一次异常",不落盘(spec 行为规格 4:成功后清除,没有持久化的必要)。
  let note: string | undefined
  // C1:bundle_id → 抑制到期时刻(ms)。只在内存,不落盘——重启后没有"刚 release 过"这回事。
  const suppressUntil = new Map<string, number>()
  // 归位冷却(2026-08-26 微信重登归位修复):bundle_id → 冷却到期时刻(ms)。同 suppressUntil
  // 一样只在内存——重启后没有"刚归位过"这回事。
  const homedUntil = new Map<string, number>()
  // 程序化激活抑制(2026-09-09):bundle_id → 抑制到期时刻(ms)。同上只在内存——重启后
  // 没有"刚激活过"这回事。与 suppressUntil 分开存:那个只管 release 后"界内且未认领"的
  // 回声,这个只管"已认领+dragged=true+界外";两者在 handleMoved 里命中的分支不重叠。
  const activatedUntil = new Map<string, number>()
  const now = (): number => opts.now?.() ?? Date.now()
  // 弹层让开窗位(2026-09-11):veilDepth = 此刻开着几个弹层;veiledApp = 让路时藏起来的那一扇
  // (没窗可让/没藏成时 undefined)。只在内存——重启后没有"正 veil 着"这回事。
  let veilDepth = 0
  let veiledApp: string | undefined
  /**
   * 起来之后把 current 摆回窗位(2026-09-25,见 DockServiceOptions.keepCurrentInSlot)。
   * `restorePending` = 还欠一次摆回(服务刚起来 / 壳刚连上);`restoreTimer` = 等矩形稳住的那个计时器;
   * `restoreRunning` = 摆回正在写队列里跑(这期间 current 暂时藏着不算"空槽",见 view 的 unplaced)。
   */
  let restorePending = opts.keepCurrentInSlot === true
  let restoreTimer: ReturnType<typeof setTimeout> | undefined
  let restoreRunning = false
  /**
   * 哪几扇没能摆进窗位、为什么(2026-09-25)。键是叠里的 app 键。摆回 / 切换失败时记,
   * 切换 / 认领 / 摆回成功、放出、拖出时清。只在内存:重启后由摆回那一轮重新判。
   */
  const unplaced = new Map<string, string>()
  /**
   * 动过窗(藏 / 显 / 拉起)就加一,「当前那一扇」的状态缓存据此作废 —— 不然刚切过去的那一扇
   * 还会按切之前"藏着"的旧答案报成空槽(见 currentProbe)。
   */
  let windowEpoch = 0

  /** 记一次程序化激活:抑制期从现在起算,重复调用只会往后延。 */
  function markActivated(bundleId: string): void {
    activatedUntil.set(bundleId, now() + ACTIVATE_SUPPRESS_MS)
  }

  /** 这个 bundle 是否还在程序化激活抑制期内;过期项顺手清掉。 */
  function activationSuppressed(bundleId: string): boolean {
    const until = activatedUntil.get(bundleId)
    if (until === undefined) return false
    if (now() < until) return true
    activatedUntil.delete(bundleId)
    return false
  }

  /**
   * view() 专用的 isRunning 短缓存(2026-08-31 风暴修复,标签时灵时不灵一案):
   * /state 每秒轮询,view() 原来每拍对叠里每个标签起一个 lsappinfo 子进程——
   * 七个标签=每秒七个子进程,风暴期间(用量扫描+项目区 git 扫描打满磁盘)它们也在
   * 排队挨拖。"在不在跑"只驱动标签置灰,几秒的陈旧无感,刻度与 badges.ts 的 5 秒
   * 采样缓存同款。只有 view() 走这份缓存;switchTo/ensureRunningWith 的激活闭环
   * 仍问实时真相——那边拿陈旧值会把"刚退出的应用"当活的,拉起重试直接乱套。
   */
  const RUNNING_CACHE_TTL_MS = 5_000
  const runningCache = new Map<string, { at: number, val: boolean }>()
  /**
   * 「当前那一扇」此刻开没开、藏没藏(2026-09-25)。一条 lsappinfo 问两样(`-only pid -only hidden`),
   * 不走壳的 AX(那条通道在切换时要让给用户点的那一下)。按 CURRENT_PROBE_TTL_MS 缓存,
   * 动过窗(windowEpoch 变了)就作废。问不出来 → undefined(不冒充"藏着")。
   */
  let currentProbe: { bundleId: string, at: number, epoch: number, running: boolean, hidden: boolean } | undefined
  async function probeCurrentApp(bundleId: string): Promise<{ running: boolean, hidden: boolean } | undefined> {
    const hit = currentProbe
    if (hit !== undefined && hit.bundleId === bundleId && hit.epoch === windowEpoch && now() - hit.at < CURRENT_PROBE_TTL_MS) {
      return { running: hit.running, hidden: hit.hidden }
    }
    const epoch = windowEpoch
    let out: { ok: boolean, stdout: string }
    try { out = await opts.runCommand(['lsappinfo', 'info', '-only', 'pid', '-only', 'hidden', '-app', bundleId]) }
    catch { return undefined }
    if (!out.ok) return undefined
    const running = /"pid"\s*=\s*\d+/.test(out.stdout)
    const hidden = /"Hidden"\s*=\s*true/i.test(out.stdout)
    currentProbe = { bundleId, at: now(), epoch, running, hidden }
    return { running, hidden }
  }

  async function isRunningCached(bundleId: string): Promise<boolean> {
    const hit = runningCache.get(bundleId)
    if (hit !== undefined && now() - hit.at < RUNNING_CACHE_TTL_MS) return hit.val
    const val = await isRunning(bundleId, opts.runCommand)
    runningCache.set(bundleId, { at: now(), val })
    return val
  }

  /**
   * S6(review,紧急小轮):moved 事件可观测环。真机上反复出现"note 清了但没认领"这类
   * 代理指标(note/stack)失真的情况——服务端对"moved 事件到底有没有收到、走了哪个
   * 判定分支"完全没有可见性,排障只能靠猜。这里用一个固定容量 8 的内存环如实记录
   * handleMoved 每一次被调用(不管最后落进哪个分支,包括被判定为跟叠无关而忽略的那种)
   * ——纯诊断用,不落盘、重启即清空,不是给客户端渲染 UI 用的字段。
   */
  const RECENT_MOVES_CAP = 8
  let recentMoves: { bundle_id: string, ts: string, decision: string, detail?: string }[] = []
  /**
   * @param detail 可选的判定依据。双窗堆叠加的:`tidy` 这个结论看不出走的是哪条路
   *   (只有一扇窗?认不出哪扇动了?还是真的只是挪了挪),真机上就没法排障——
   *   代理指标失真正是这条线反复翻车的原因,所以把依据一并如实记下。
   */
  function recordMove(bundleId: string, decision: string, detail?: string): void {
    recentMoves.push({
      bundle_id: bundleId,
      ts: new Date(now()).toISOString(),
      decision,
      ...(detail === undefined ? {} : { detail }),
    })
    if (recentMoves.length > RECENT_MOVES_CAP) recentMoves = recentMoves.slice(-RECENT_MOVES_CAP)
  }

  /**
   * Chromium AX 修复:ax_stale 诊断环,同 recentMoves 一样固定容量 8、内存、不落盘——
   * 壳侧 AXObserver 通道休眠是真机上另一类"代理指标失真"(表现为拖拽/贴合偶发没反应,
   * 但 note/stack 这类既有信号完全看不出成因),如实记下每一次壳报来的休眠+自动唤醒,
   * 供排障直接看证据,不是给客户端渲染 UI 用的字段。
   */
  const RECENT_AX_CAP = 8
  let recentAx: { bundle_id: string, ts: string, ax_err: number, ax_count: number, cg_count: number }[] = []
  function recordAx(info: { bundle_id: string, ax_err: number, ax_count: number, cg_count: number }): void {
    recentAx.push({ bundle_id: info.bundle_id, ts: new Date(now()).toISOString(), ax_err: info.ax_err, ax_count: info.ax_count, cg_count: info.cg_count })
    if (recentAx.length > RECENT_AX_CAP) recentAx = recentAx.slice(-RECENT_AX_CAP)
  }

  /**
   * 窗位矩形观测环(2026-08-25 真机实证:毒矩形被静默存储的排障缺口)。真机上抓到过
   * setSlotRect 存进一个瞬态重排量出的矩形、之后每次切换都贴错位置的 bug——排障当时
   * 完全没有办法回答"服务端到底收到过哪些矩形上报、哪些被 rectEquals/8px 噪声门槛挡
   * 下了没存、哪些真的存了"这类问题,只能翻真机日志硬猜。这里同 recentMoves/recentAx
   * 先例,用固定容量 8 的内存环如实记录 setSlotRect 每一次被调用(不管最终是否真的更新
   * 了 slotRect),包括被两道早退门槛挡下的那些——`stored` 字段区分"这次调用真的把
   * slotRect 换成新值了"还是"被判定为没变/噪声,原地不动"。纯诊断用,不落盘、重启即
   * 清空,不是给客户端渲染 UI 用的字段。
   */
  const RECENT_RECTS_CAP = 8
  let recentRects: { ts: string, rect: HelperRect | null, reason?: 'resize', stored: boolean, rejected?: boolean }[] = []
  function recordRect(rect: HelperRect | undefined, reason: 'resize' | undefined, stored: boolean, rejected?: boolean): void {
    recentRects.push({
      ts: new Date(now()).toISOString(),
      rect: rect ?? null,
      ...(reason === undefined ? {} : { reason }),
      stored,
      ...(rejected === undefined ? {} : { rejected }),
    })
    if (recentRects.length > RECENT_RECTS_CAP) recentRects = recentRects.slice(-RECENT_RECTS_CAP)
  }

  /**
   * 事务官清理观测环(2026-09-09 事务官标签 bug):点「事务官」时每一次真的把某个成员 hide_app
   * 成功都如实记一条——`decision:'current'` 是原本在台的那一扇,`decision:'stray'` 是被
   * 别的路径(场景恢复/用户自己点回/双窗第二扇/AX 重挂)露出来的残留窗口。同
   * recentMoves/recentAx/recentRects 先例:固定容量 8 的内存环、不落盘、重启即清空,纯
   * 排障用(回答"这次点事务官到底清了谁"),不是给客户端渲染 UI 用的字段。没藏成的不进环
   * ——进环就代表"已经清掉了",那是假话;失败的原因走 note。
   */
  const RECENT_HIDES_CAP = 8
  type HideDecision = 'current' | 'stray' | 'veil-current' | 'veil-stray' | 'switch' | 'switch-deferred' | 'restore-stray' | 'transient'
  let recentHides: { app: string, bundle_id: string, ts: string, decision: HideDecision }[] = []
  function recordHide(app: string, bundleId: string, decision: HideDecision): void {
    recentHides.push({ app, bundle_id: bundleId, ts: new Date(now()).toISOString(), decision })
    if (recentHides.length > RECENT_HIDES_CAP) recentHides = recentHides.slice(-RECENT_HIDES_CAP)
  }

  /**
   * 切换耗时观测环(2026-09-21「点标签切换经常卡住」,同 recent_moves/recent_ax/recent_rects/
   * recent_hides 先例)。**这一条跟前面几个环不一样:它是给 Ben 看的**——体检页最下面
   * 那一小块「最近的窗位切换」一行一条渲染它,因为"卡住"这件事只有他能感觉到,而
   * 「哪一次慢、慢在抬窗还是藏别家、哪家超时了」必须有真数字才谈得下去,不能靠他形容。
   *
   * 每次 `switchTo` 记一条,容量 10(比别的环大,因为它要被人翻着看),内存、不落盘。
   * 耗时是真量的(`opts.now()`),不是估的。
   */
  const RECENT_SWITCHES_CAP = 10
  let recentSwitches: {
    app: string
    ts: string
    ok: boolean
    total_ms: number
    raise_ms: number
    hidden: number
    deferred?: number
    timed_out?: readonly string[]
  }[] = []
  function recordSwitch(entry: {
    app: string
    ok: boolean
    total_ms: number
    raise_ms: number
    hidden: number
    deferred: number
    timed_out: readonly string[]
  }): void {
    recentSwitches.push({
      app: entry.app,
      ts: new Date(now()).toISOString(),
      ok: entry.ok,
      total_ms: entry.total_ms,
      raise_ms: entry.raise_ms,
      hidden: entry.hidden,
      // 缺省即"没有"——0 家延后、没人超时是常态,不给常态摆一个恒为 0/[] 的字段。
      ...(entry.deferred === 0 ? {} : { deferred: entry.deferred }),
      ...(entry.timed_out.length === 0 ? {} : { timed_out: [...entry.timed_out] }),
    })
    if (recentSwitches.length > RECENT_SWITCHES_CAP) recentSwitches = recentSwitches.slice(-RECENT_SWITCHES_CAP)
  }

  /**
   * 后台慢慢藏的队列(2026-09-21 切换预算):藏别家超了预算,剩下的挪到这里,不让用户等。
   *
   * **串行**(链在一个 promise 上):这些请求最终还是要挤同一条壳通道、同一条壳里的串行
   * AX 队列,并发发出去只会让壳那边排得更长,不会更快。
   *
   * **失败就算了,不写 note**:用户已经拿到这次切换的结果了,这会儿再冒一句话出来,
   * 只会盖掉真正该看的东西;而且"没藏成"下次切换会再藏一遍,不是需要他处理的事。
   * 藏成了的照旧进 recent_hides(decision:'switch-deferred'),排障看得见。
   *
   * 不排进 `writeQueue`:那条队列是给"读写 dock.json"排的,后台藏窗一个字节都不写存档,
   * 占着它只会把下一次切换/认领堵在后面——那正是这张卡要治的病。
   */
  let deferredHideQueue: Promise<void> = Promise.resolve()
  function deferHides(members: readonly StoredDockItem[]): void {
    if (members.length === 0) return
    deferredHideQueue = deferredHideQueue.then(async () => {
      for (const member of members) {
        try {
          await opts.helper.request({ op: 'hide_app', bundle_id: member.bundle_id })
          recordHide(member.app, member.bundle_id, 'switch-deferred')
        }
        catch {
          // 见上:后台的事,失败不打扰人。
        }
      }
    }, () => undefined)
  }

  /**
   * 终审必修3:同 bundle 节流(建议值 30s)——AX 永久坏死的应用每次激活都会重新触发
   * handleAppActivated 的重挂+补挂检测,ax_stale 因此会一直命中同一个 bundle。真机上
   * cmd-tab 风暴(短时间反复切来切去)会把容量只有 8 的 recentAx 环反复刷成同一个
   * bundle,把别的应用留下的诊断证据统统挤掉;note 也会被同一句文案反复覆盖,盖住
   * 期间可能发生的别的 note。
   *
   * 取舍:节流挡的是"环+note"整体,不是只挡 note——节流期内直接整条跳过,不重复进环、
   * 不重写 note。这比"只挡 note、环照样进"更诚实地反映"发生了但被压掉了"这件事吗?
   * 不——但环里已经有这个 bundle 第一次命中时留下的那一条记录,足以证明"这个 bundle
   * 确实反复在 stale",没必要为了证明"又发生了一次"占用本就只有 8 格的稀缺环容量去
   * 挤掉别的 bundle 的证据。用 opts.now 注入的时钟判断间隔,不用 Date.now()——测试要能
   * 用假时钟精确验证节流边界。
   */
  const AX_STALE_THROTTLE_MS = 30_000
  const axStaleLastAt = new Map<string, number>()

  // 写队列,先例见 scenes.ts:load→改→save 不排队会丢更新;handleMoved 的读判定也走队列,
  // 避免与并发的 switchTo/release 交错读到中间态。
  let writeQueue: Promise<void> = Promise.resolve()
  /**
   * 写队列里此刻有没有活在跑(2026-09-25)。跑着的时候窗正处在"藏了一半 / 摆了一半"的中间态,
   * view() 不拿这一刻的样子去判"槽里空着"(见 view 里 unplaced 那一段);每个活开始和结束都让
   * 「当前那一扇」的状态缓存作废(windowEpoch)。
   */
  let queueBusy = 0
  function enqueueWrite<T>(task: () => Promise<T>): Promise<T> {
    const result = writeQueue.then(async () => {
      queueBusy += 1
      windowEpoch += 1
      try { return await task() }
      finally {
        queueBusy -= 1
        windowEpoch += 1
      }
    })
    writeQueue = result.then(() => undefined, () => undefined)
    return result
  }

  /**
   * dock.json 落盘的**唯一出口**(2026-10-04 收窄):落完顺手把成员表下发给壳。
   *
   * 为什么要收成一处:壳那条「别让屏幕暗下去」要认「最前面那个 App 是不是槽里那一家」,
   * 而「槽里有谁」只有这一叠知道 —— 认领 / 除名 / 整理 / 拖出任何一条路改了叠,壳都得跟着知道,
   * 挨个记得发一遍是迟早漏一条的活。下发是**顺手的**:await 落盘,下发只 void 出去
   * (壳没连上 / 旧壳不认都不该把一次认领判成失败)。
   */
  async function persistDock(data: DockFile): Promise<void> {
    await saveDockFile(opts.file, data)
    void sendSlotApps(data).catch(() => {})
  }

  /**
   * 真发那一下。bundle id 去重、去空(同一家两个包的情形下 stack 里可能出现同一个 bundle)。
   *
   * **壳没报这一格就一个字不发**(`supports`):老壳会回「未知 op」,而这一发是跟在每次
   * dock.json 落盘后面的 —— 每认领一次、每切一次标签都白跑一个往返加一条错误日志,
   * 换不来任何东西(老壳本来就只认工作台自己在最前面)。
   */
  async function sendSlotApps(data: DockFile): Promise<void> {
    if (opts.helper.supports?.('slot_apps') !== true) return
    const bundle_ids = [...new Set(data.stack.map(item => item.bundle_id).filter(id => typeof id === 'string' && id !== ''))]
    await opts.helper.request({ op: 'slot_apps', bundle_ids })
  }

  /**
   * M7:note 的每一次赋值都统一走这里并触发 onChanged——不去抖(频率低,没必要),
   * 这样界面上的 note 才不会一直停在上一次广播时的旧文案,得等下一次别的原因触发广播才更新。
   */
  function setNote(value: string | undefined): void {
    note = value
    opts.onChanged?.()
  }

  /**
   * 已认领应用的程序化移动归位(2026-08-26 微信重登归位修复抽出来的公共段,2026-09-09
   * 程序化激活抑制也走它):不动 stack、不改 original、不 raise 不 hide——纯归位。
   * 只处理 note 与窗口,**不记观测环**:决策名与明细交给调用方,dragged=false 那支照旧记
   * homed/settled/home-cooldown/home-failed/tidy,激活抑制那支统一记 suppressed 并把这里的
   * 结果写进明细。
   */
  async function homeToSlot(
    bundleId: string,
    existing: StoredDockItem,
    frame: HelperRect,
    screenRect: HelperRect,
  ): Promise<{ decision: 'tidy' | 'settled' | 'home-cooldown' | 'home-failed' | 'homed', detail?: string }> {
    if (existing.second !== undefined) {
      // 双窗态认不出该归哪扇(AX 窗口无稳定身份,见 listWindows 注释),如实降级不动。
      return { decision: 'tidy', detail: '程序化移动,双窗态不自动归位' }
    }
    if (atSlot(frame, screenRect)) {
      // 已贴在槽位(自家贴合动作的回声、或应用自己恢复了槽位 frame)——不动,
      // 这一档挡住"摆位→回声→再摆位"的循环起点。
      setNote(undefined)
      return { decision: 'settled', detail: `frame=${fmtRect(frame)} slot=${fmtRect(screenRect)}` }
    }
    const cooldown = homedUntil.get(bundleId)
    if (cooldown !== undefined && now() < cooldown) {
      // 应用把尺寸钳到容差外时(最小尺寸大于槽位这类),归位回声永远过不了 atSlot,
      // 冷却把循环掐断在第二轮——只记环,不再摆位。
      return { decision: 'home-cooldown', detail: `frame=${fmtRect(frame)}` }
    }
    homedUntil.set(bundleId, now() + HOME_COOLDOWN_MS)
    try {
      await opts.helper.request({ op: 'set_window_frame', bundle_id: bundleId, index: DOCK_WINDOW_INDEX, frame: screenRect })
    }
    catch (error) {
      setNote(`归位失败:${error instanceof Error ? error.message : String(error)}`)
      return { decision: 'home-failed', detail: `frame=${fmtRect(frame)}` }
    }
    setNote(undefined)
    return { decision: 'homed', detail: `frame=${fmtRect(frame)} slot=${fmtRect(screenRect)}` }
  }

  /**
   * 把叠里的一项从隐藏里翻出来并贴到窗位上:unhide → 唤窗 → set_window_frame(+raise)。
   * 由 switchTo 抽出(2026-09-11 弹层让开窗位:unveil 要走**同一条**贴合路径,不新写一套),
   * 请求顺序与 switchTo 原来的一字不差。失败原样抛给调用方,这里不编话。
   */
  async function placeInSlot(
    item: StoredDockItem,
    screenRect: HelperRect,
    cmd: readonly string[] | undefined,
    deadline?: number,
    /**
     * 摆好之后置不置前(raise_window = AXRaise + 激活那家)。切换 / 让路回来是他点的,要置前;
     * 起来之后的摆回(restoreCurrent)**不置前**:那一下不是他点的,抢焦点就是打断他(2026-09-25)。
     */
    raise = true,
  ): Promise<void> {
    windowEpoch += 1
    await opts.helper.request({ op: 'unhide_app', bundle_id: item.bundle_id })
    // 唤窗(真机实测:企业微信 running 但常驻后台、主窗口数=0):unhide 之后窗口未必
    // 真的存在,跟 orchestrator.ts 的贴合路径对齐同一条语义——等不到就让下面的
    // set_window_frame 照实失败,不在这里编一句新话。
    // deadline(2026-09-21 切换预算):switchTo 会传一个绝对时刻,到点就停止等窗——
    // 不传(unveil 那条路)= 老行为,等满 10×500ms。
    await waitForDockWindow(item.bundle_id, cmd, deadline)
    if (item.second === undefined) {
      await opts.helper.request({ op: 'set_window_frame', bundle_id: item.bundle_id, index: DOCK_WINDOW_INDEX, frame: screenRect })
      if (raise) await opts.helper.request({ op: 'raise_window', bundle_id: item.bundle_id, index: DOCK_WINDOW_INDEX })
      return
    }
    // 双窗态:劈槽,两扇各贴一半、都置前(spec 2026-08-25 双窗堆叠)。
    // 窗序号每次现查——AX 下标会随开关窗漂移,不能拿上次的接着用。
    // 认不出第二扇(比如用户把它关掉了)就**只铺第一扇并如实写 note**,
    // 不去猜一个下标乱摆(D13)。
    const [firstHalf, secondHalf] = splitSlot(screenRect)
    const windows = await listWindows(item.bundle_id)
    await opts.helper.request({ op: 'set_window_frame', bundle_id: item.bundle_id, index: DOCK_WINDOW_INDEX, frame: firstHalf })
    if (raise) await opts.helper.request({ op: 'raise_window', bundle_id: item.bundle_id, index: DOCK_WINDOW_INDEX })
    const secondIndex = windows.find(w => w.index !== DOCK_WINDOW_INDEX)?.index
    if (secondIndex === undefined) {
      setNote(NOTE_SECOND_MISSING)
    }
    else {
      await opts.helper.request({ op: 'set_window_frame', bundle_id: item.bundle_id, index: secondIndex, frame: secondHalf })
      if (raise) await opts.helper.request({ op: 'raise_window', bundle_id: item.bundle_id, index: secondIndex })
    }
  }

  /**
   * 起来之后把 current 摆回窗位(2026-09-25,卡 fix/slot-current-empty;WHY 见 DockServiceOptions.keepCurrentInSlot)。
   * **调用方负责排进写队列。**
   *
   * 顺序:current 为空 → 什么都不做(本来就是事务官那一页);弹层正开着 → 留着下次(unveil 自己会把它带回来);
   * 窗位量不到 / 壳不通 → 留着下次(矩形或壳一到就再排);没开着 → 不替他开,记「没在窗位里:没开着」;
   * 开着 → 藏着就 unhide → 等窗(不补发 open)→ 没窗就记「没有打开的窗口」→ 原来露着且就在窗位上的一个字不动,
   * 否则贴到窗位 → 原来是藏着的,才把压在窗位上的别的成员藏起来。
   *
   * 摆不回来那一支:记进 unplaced(标签上写「点一下拉进来」、槽里写原因),**引导做完了就回事务官那一页**
   * (current 置空、落盘)—— 维护者一打开看见的该是她,不是一块空黑区 + 一个高亮着的标签。
   */
  async function restoreCurrent(): Promise<void> {
    if (!restorePending) return
    if (veilDepth > 0) return
    let screenRect: HelperRect | undefined
    try { screenRect = await slotScreenRect() }
    catch { return } // 壳不通:留着 restorePending,壳连上(noteShellReady)再来
    if (screenRect === undefined) return // 矩形还没报上来:留着,矩形一到再排
    restorePending = false

    const data = await loadDockFile(opts.file)
    if (data.current === null) return
    const item = data.stack.find(entry => entry.app === data.current)
    if (item === undefined) {
      // 存档里的 current 指向一个已经不在叠里的成员 —— 没有窗可摆,把这个悬空值清掉。
      data.current = null
      await persistDock(data)
      return
    }
    const label = (await opts.registry.listAll()).find(entry => entry.key === item.app)?.label ?? item.app

    restoreRunning = true
    let reason: string | undefined
    let action = '已经好好在窗位里,没动'
    try {
      // 壳说了算:开没开、藏没藏、有几扇窗、在哪(一次 app_info)。
      const info = await opts.helper.request({ op: 'app_info', bundle_id: item.bundle_id }) as { running?: unknown, hidden?: unknown }
      if (info.running !== true) {
        reason = `${label} 没开着`
      }
      else {
        const wasHidden = info.hidden === true
        markActivated(item.bundle_id)
        if (wasHidden) {
          windowEpoch += 1
          await opts.helper.request({ op: 'unhide_app', bundle_id: item.bundle_id })
        }
        // 等它的窗出来,但**不补发 open**:`open -b <包标识>` 会把那家激活到最前(切换那条路的唤窗是他点的,
        // 这一下不是)。一扇窗都没有就如实记下,他点标签时切换那条路会去唤窗。
        let windows = await listWindows(item.bundle_id)
        for (let i = 0; windows.length === 0 && i < RESTORE_WINDOW_TRIES; i++) {
          await opts.sleep(RESTORE_WINDOW_WAIT_MS)
          windows = await listWindows(item.bundle_id)
        }
        const first = windows.find(w => w.index === DOCK_WINDOW_INDEX) ?? windows[0]
        if (first === undefined) {
          reason = `${label} 开着,但没有打开的窗口(可能缩在程序坞里,或者还在登录)`
        }
        else {
          // 原来就露着、而且就在窗位上 → 一个字都不动(他可能正在用它)。藏着的、或者不在窗位上的才摆。
          if (wasHidden || item.second !== undefined || !atSlot(first.frame, screenRect)) {
            await placeInSlot(item, screenRect, undefined, now() + CLAIM_WINDOW_BUDGET_MS, false)
            markActivated(item.bundle_id)
            action = wasHidden ? '藏着的放出来、摆回窗位' : '摆回窗位'
          }
          // 它原来是藏着的 = 窗位上露着的是别的成员(重载前让路藏了它、他从程序坞点回了别家)→ 那几家藏起来,
          // 不然它在它们下面。它原来就露着时不碰别家:他可能正在用其中一扇。
          if (wasHidden) await hideStrays(data, item, 'restore-stray')
        }
      }
    }
    catch (error) {
      reason = error instanceof Error ? error.message : String(error)
    }
    finally {
      restoreRunning = false
    }

    if (reason === undefined) {
      unplaced.delete(item.app)
      recordMove(item.bundle_id, 'restored', action)
      return
    }
    unplaced.set(item.app, reason)
    recordMove(item.bundle_id, 'restore-failed', reason)
    // 卡 A 的规则:引导做完了、又没有能摆进来的窗 → 默认回事务官那一页。引导还没做完时屏上是引导,不动它。
    if (opts.firstRun?.() !== true) {
      data.current = null
      await persistDock(data)
    }
    setNote(`「${label}」的窗没摆回窗位(${reason})—— 先回到事务官这一页;点标签「${label}」再拉一次`)
  }

  /** 等窗位矩形稳住再摆回(见 DockServiceOptions.keepCurrentInSlot 里「等矩形稳住」那一段)。 */
  function scheduleRestore(): void {
    if (!restorePending) return
    if (restoreTimer !== undefined) clearTimeout(restoreTimer)
    restoreTimer = setTimeout(() => {
      restoreTimer = undefined
      void enqueueWrite(restoreCurrent).catch(() => {})
    }, opts.restoreSettleMs ?? RESTORE_SETTLE_MS)
    restoreTimer.unref?.()
  }

  /** 页面矩形→屏幕矩形(复用 orchestrator.ts 的换算),slotRect 未上报时 undefined。 */
  async function slotScreenRect(): Promise<HelperRect | undefined> {
    if (slotRect === undefined) return undefined
    const screen = await opts.helper.request({ op: 'screen_info' }) as unknown as { webview: HelperRect, scale: number }
    return pageRectToScreen(slotRect, screen.webview, screen.scale)
  }

  /**
   * 残留窗口清理(2026-09-09 见 hideCurrent 的 WHY;2026-09-16 起 veil 也走这条):除了 `except`
   * 那扇(刚无条件藏掉的 current)之外的成员,逐个问一次 app_info,只有**明确**报了在跑且没
   * 隐藏的才 hide_app。壳报错、字段缺失、已隐藏、没在跑都跳过——不发多余请求,也不拿猜测去动
   * 窗口(D13)。失败不中断剩下的成员:一个清不掉不该让别的也留在台上。
   *
   * 清掉的逐条进 recent_hides(decision 由调用方定:hideCurrent 记 'stray'、veil 记 'veil-stray');
   * 返回没清成的清单(`app(壳原话)`),由调用方决定怎么写 note——两边的前缀文案不同。
   */
  async function hideStrays(data: DockFile, except: StoredDockItem | undefined, decision: 'stray' | 'veil-stray' | 'restore-stray'): Promise<string[]> {
    const failures: string[] = []
    for (const member of data.stack) {
      if (except !== undefined && member.app === except.app) continue
      let info: { running?: unknown, hidden?: unknown }
      try {
        info = await opts.helper.request({ op: 'app_info', bundle_id: member.bundle_id }) as unknown as { running?: unknown, hidden?: unknown }
      }
      catch {
        continue // 问不出来就不动它
      }
      if (info.running !== true || info.hidden !== false) continue
      try {
        await opts.helper.request({ op: 'hide_app', bundle_id: member.bundle_id })
        recordHide(member.app, member.bundle_id, decision)
      }
      catch (error) {
        failures.push(`${member.app}(${error instanceof Error ? error.message : String(error)})`)
      }
    }
    return failures
  }

  /** app_info 里有没有第 0 个窗口——切换/唤窗只关心"有没有",不需要它的坐标。 */
  async function hasDockWindow(bundleId: string): Promise<boolean> {
    return (await listWindows(bundleId)).length > 0
  }

  /**
   * 列出该应用当前全部标准窗口的 `{index, frame}`。
   *
   * 双窗堆叠靠它按位置反查"哪扇窗动了"——AX 窗口没有稳定 id,`standardWindows` 的
   * 下标还会随开关窗漂移,所以**下标只在当次调用内用来寻址**,绝不落盘、不跨事件复用。
   * 取不到就返回空数组,由调用方按"认不出"降级(D13),不在这里编一个假的窗口出来。
   */
  async function listWindows(bundleId: string): Promise<{ index: number, frame: HelperRect }[]> {
    let info: { windows?: unknown[] }
    try {
      info = await opts.helper.request({ op: 'app_info', bundle_id: bundleId }) as unknown as { windows?: unknown[] }
    }
    catch {
      return []
    }
    if (!Array.isArray(info.windows)) return []
    const out: { index: number, frame: HelperRect }[] = []
    for (const raw of info.windows) {
      if (typeof raw !== 'object' || raw === null) continue
      const w = raw as { index?: unknown, frame?: unknown }
      const f = w.frame as HelperRect | undefined
      if (typeof w.index !== 'number' || f === undefined) continue
      if ([f.x, f.y, f.w, f.h].some(v => typeof v !== 'number')) continue
      out.push({ index: w.index, frame: f })
    }
    return out
  }

  /**
   * 唤窗(真机实测:企业微信 running 但常驻后台、主窗口数=0):switchTo 的 unhide 之后
   * 窗口可能压根不存在,不是"隐藏起来了"而是"从没开过窗"——跟 orchestrator.ts 的
   * waitForWindow 同一条语义,有限等待,只在第一次探测就是零窗口时补发一次 open
   * (open 按包标识对已在运行的应用等效于"把主窗叫出来",不是重新拉起进程,一次顶多补一次,
   * 不是每轮都发)。cmd 解不出来就没法唤,直接放弃——交给调用方后续的 set_window_frame
   * 照实失败,不在这里编一句新话。等满上限仍没有窗口同样不在这里抛错,原因交给
   * set_window_frame 自己(D13:不重复编一句"没窗口",壳报什么就是什么)。
   */
  async function waitForDockWindow(bundleId: string, cmd: readonly string[] | undefined, deadline?: number): Promise<void> {
    for (let i = 0; i < DOCK_WINDOW_WAIT_TRIES; i++) {
      // 切换总预算(2026-09-21):到点就不再等了。窗口还没出来不是这里报错——照旧交给
      // 后面的 set_window_frame 照实失败(D13:不重复编一句"没窗口"),只是不再把用户
      // 按在那儿干等最多 5 秒。deadline 不传 = 老行为(unveil 那条路)。
      if (deadline !== undefined && now() >= deadline) return
      if (await hasDockWindow(bundleId)) return
      if (i === 0 && cmd !== undefined) await opts.runCommand(cmd)
      await opts.sleep(DOCK_WINDOW_WAIT_MS)
    }
  }

  /**
   * 贴完等一拍再量一次,没贴准就再贴一次(2026-10-12,`FIT_RECHECK_MS` 的理由)。
   * 量不到窗(壳不通 / 它刚关了)就什么都不做 —— 这里不编一句新话,原来那一下 set_window_frame 已经回过结果。
   */
  async function refitIfOff(bundleId: string, screenRect: HelperRect): Promise<void> {
    await opts.sleep(FIT_RECHECK_MS)
    const fitted = (await listWindows(bundleId)).find(w => w.index === DOCK_WINDOW_INDEX)
    if (fitted === undefined || atSlot(fitted.frame, screenRect)) return
    await opts.helper.request({ op: 'set_window_frame', bundle_id: bundleId, index: DOCK_WINDOW_INDEX, frame: screenRect })
  }

  /** 这一家(按键或按 bundle)是不是已经在叠里了。自愈注册会让同一个应用换一个键进叠,两样都认。 */
  function inStack(data: DockFile, app: string, bundleId: string | undefined): boolean {
    return data.stack.some(entry => entry.app === app || (bundleId !== undefined && entry.bundle_id === bundleId))
  }

  /** 窗位此刻在屏幕上的矩形;壳不通 → `problem`(整批都卡在这一步),量不到 → rect 缺席。 */
  async function claimRect(): Promise<{ rect?: HelperRect, problem?: unknown }> {
    try {
      const rect = await slotScreenRect()
      return rect === undefined ? {} : { rect }
    }
    catch (error) {
      return { problem: error }
    }
  }

  /**
   * 程序化认领一家(2026-09-25,卡 fix/quota-and-slot-apps)。**调用方负责排进写队列、负责落盘**。
   *
   * 顺序:认得这个键 → 开没开(没开且不许开 = not_running)→ 窗位量得到 → unhide → 等窗(有预算)
   * → set_window_frame 摆进窗位 → raise(点标签那条)→ 藏起上一位 / 藏起它自己(批量那条)→ 记进叠。
   *
   * 与拖拽认领(handleMoved 的认领分支)是同一个结果:叠里多一项、original 记摆位前那一帧
   * (放出时送回去)。摆位成功之后认领就算成立,藏窗失败不回滚(同那边的纪律),只如实带一句。
   */
  async function claimOne(
    item: { app: string, label: string },
    data: DockFile,
    where: { rect?: HelperRect, problem?: unknown },
    options: { launch: boolean, raise: boolean },
  ): Promise<{ ok: boolean, state: SlotClaimState, note?: string }> {
    const { app, label } = item
    const bundleId = await opts.registry.bundleFor(app)
    if (inStack(data, app, bundleId)) return { ok: true, state: 'already' }
    if (bundleId === undefined) return { ok: false, state: 'failed', note: `窗位清单里没有「${label}」` }
    const cmd = await opts.registry.commandFor(app)
    let running: boolean
    try { running = await isRunning(bundleId, opts.runCommand) }
    catch { running = false }
    // 没开着先说没开着:这一句比"窗位没露出来"对他有用(标签上点一下就会先打开)。
    if (!running && !options.launch) {
      return { ok: false, state: 'not_running', note: `${label} 没开着 —— 标签上点一下,会先打开再拉进来` }
    }
    if (where.problem !== undefined) return claimFailure(label, where.problem)
    const screenRect = where.rect
    if (screenRect === undefined) return { ok: false, state: 'needs_click', note: slotHiddenNote(label) }

    let original: HelperRect
    try {
      if (!running) {
        if (cmd === undefined) return { ok: false, state: 'failed', note: `不知道怎么打开「${label}」` }
        // 程序化激活抑制(同 switchTo):应用刚被我们拉起来,它自己摆窗的那几下不算"拖出"。
        markActivated(bundleId)
        const opened = await ensureRunningWith(cmd, bundleId, { runCommand: opts.runCommand, sleep: opts.sleep })
        if (!opened.ok) return { ok: false, state: 'failed', note: `打不开「${label}」(${opened.reason ?? '没起来'})` }
      }
      markActivated(bundleId)
      await opts.helper.request({ op: 'unhide_app', bundle_id: bundleId })
      await waitForDockWindow(bundleId, cmd, now() + CLAIM_WINDOW_BUDGET_MS)
      const first = (await listWindows(bundleId)).find(w => w.index === DOCK_WINDOW_INDEX)
      if (first === undefined) {
        return {
          ok: false,
          state: 'needs_click',
          note: `${label} 开着,但没找到它的窗口(可能缩在程序坞里,或者还在登录)—— 把窗叫出来之后点标签再拉,或者直接拖进虚线区`,
        }
      }
      // original 必须是摆位**之前**那一帧:放出(✕)时要把窗送回这里。
      original = first.frame
      await opts.helper.request({ op: 'set_window_frame', bundle_id: bundleId, index: DOCK_WINDOW_INDEX, frame: screenRect })
      await refitIfOff(bundleId, screenRect)
      if (options.raise) await opts.helper.request({ op: 'raise_window', bundle_id: bundleId, index: DOCK_WINDOW_INDEX })
    }
    catch (error) {
      return claimFailure(label, error)
    }

    let hideReason: string | undefined
    if (options.raise) {
      // 点标签:它上台,上一位藏起来(同拖拽认领)。
      const previous = data.current === null ? undefined : data.stack.find(entry => entry.app === data.current)
      if (previous !== undefined && previous.bundle_id !== bundleId) {
        try { await opts.helper.request({ op: 'hide_app', bundle_id: previous.bundle_id }) }
        catch (error) { hideReason = `上一个应用没藏成(${error instanceof Error ? error.message : String(error)})` }
      }
      data.current = app
    }
    else {
      // 批量拉:摆好就藏起来 —— 他这会儿看着的东西不换,current 不动;点标签时 switchTo 再把它请上台。
      try { await opts.helper.request({ op: 'hide_app', bundle_id: bundleId }) }
      catch (error) { hideReason = `它没藏成,可能盖在窗位上(${error instanceof Error ? error.message : String(error)})` }
    }
    data.stack.push({ app, bundle_id: bundleId, original })
    unplaced.delete(app) // 上一回没摆进来的原因作废(2026-09-25)
    // 摆位引起的回声 moved 事件排在这个写队列后面,那时它已经在叠里 → 走归位分支(已就位),不会被当成新认领。
    markActivated(bundleId)
    recordMove(bundleId, 'claimed', options.raise ? '点标签拉进来' : '批量拉进来')
    return { ok: true, state: 'claimed', ...(hideReason === undefined ? {} : { note: `拉进来了,但${hideReason}` }) }
  }

  /**
   * 「有一家被叫到前面」观测环(2026-09-25,卡 P)。同 recentMoves:内存、不落盘,容量 12。
   * 截图 / 划词 / 快捷面板各家的遮罩窗长什么样(层级、大小)也从这里看。
   */
  /** 「真拖进一个新应用」的听众(窗口槽那圈光,见 DockService.onDropClaimed)。 */
  const dropListeners = new Set<(info: { app: string, bundle_id: string }) => void>()
  const RECENT_ACTIVATIONS_CAP = 12
  let recentActivations: ActivationRecord[] = []
  /**
   * 预约了「遮罩一收就藏回去」的那几家 → 到这个时刻之前,它们的挪窗事件一概不认(卡 P 补二)。
   * 壳在遮罩底下把它的窗挪到屏外、藏好后挪回:那是我们挪的。当成「他拖出窗位」会把它除名,
   * 当成「应用自己跑偏」会把它摆回窗位(挪开白做,遮罩一收照样闪)。壳那边也压着不报,这里再兜一道。
   */
  const parkedUntil = new Map<string, number>()
  /** 预约之后最多压多久(截图框选很少超过一分钟;结论一到就缩成 PARK_ECHO_MS)。 */
  const PARK_HOLD_MS = 60_000
  /** 结论到了之后再压多久:壳藏好、挪回原位那一下的回声。 */
  const PARK_ECHO_MS = 3_000

  function recordActivation(info: ShellActivation, decision: ActivationDecision, detail?: string): void {
    recentActivations.push({ ...info, ts: new Date(now()).toISOString(), decision, ...(detail === undefined ? {} : { detail }) })
    if (recentActivations.length > RECENT_ACTIVATIONS_CAP) recentActivations = recentActivations.slice(-RECENT_ACTIVATIONS_CAP)
  }

  const service: DockService = {
    setSlotRect(rect: HelperRect | undefined, reason?: 'resize'): void {
      const previous = slotRect
      if (rectEquals(rect, previous)) {
        recordRect(rect, reason, false) // 观测环:没变,这次调用没有真的存
        return // 没变,悬停圈推送和跟随重贴都不用做
      }
      // S2(b)(review,真机截图实证)噪声门槛:页面里任何一点小变化(哪怕只是几像素的重排)
      // 都可能触发一次"存新矩形→查 screen_info"。8px 以内(人眼基本分辨不出的抖动)当噪声
      // 直接丢弃:不更新 slotRect(留着上一次真实值,不让抖动慢慢把它"磨"偏)、不重贴、
      // 不重发悬停圈。真正的变化(窗位模块被拖高/收起/认领冒出标签栏)幅度远大于 8px,
      // 不会被这道门槛挡住;矩形从"有"变"无"(undefined,I3 清除)或反过来都不受这道
      // 门槛限制——rectEquals 那一行已经处理了两边有一边是 undefined 的情况。
      if (rect !== undefined && previous !== undefined && rectNearlyEqual(rect, previous, SLOT_RECT_NOISE_THRESHOLD_PX)) {
        recordRect(rect, reason, false) // 观测环:被噪声门槛挡下,没有真的存
        return
      }
      slotRect = rect
      recordRect(rect, reason, true) // 观测环:这次调用真的把 slotRect 换成了新值
      // 起来之后还欠一次摆回(2026-09-25):矩形每变一次就把计时器往后推,稳住了才摆。
      if (rect !== undefined) scheduleRestore()

      // S5(review,真机截图实证,取代 S2(b) 里"矩形一变就跟随重贴当前窗口"那部分描述):
      // 之前的规则是"只要过了 8px 噪声门槛就跟随重贴",真机上仍然复现出"贴住的窗口莫名
      // 往上窜"——根因不是抖动幅度不够大,而是矩形本身可能是假的:页面态瞬断(轮询漏一拍
      // →offlineState、DSH 重启、WS 抖一下)会让标签栏/滚动条瞬间不渲染,槽体测出的矩形
      // 跳到模块顶部,这一下的变化幅度远超 8px,照旧被判定成"真变了"去跟随重贴,真实窗口
      // 就被这条假矩形拽上去了。也就是说,被动上报(挂载时的一次性测量、ResizeObserver、
      // window resize)天生不可信,不该有资格驱动真实窗口——不管它变了多少像素。
      //
      // 新规则:setSlotRect 永远只存矩形(给 handleMoved 的拖拽认领判定用)、永远推悬停圈
      // (壳侧拖拽悬停高亮要实时,矩形失效时代表判定范围没了,不管是不是被动上报都得让壳
      // 知道)——这两件事都不碰"当前已经在台上的窗口"本身,纯粹是信息同步,做错了顶多是
      // 悬停高亮不准,不会真的把窗口挪走。真正会挪动窗口的"跟随重贴当前窗口"这一步,只在
      // 调用方明确传了 reason:'resize' 时才做——这意味着是用户在真实拖动窗位模块的调高
      // 把手松手,或者布局里 slot 模块自己的 basis 确实变了,这两种情形矩形一定是真的。
      // 认领(adopt)、切换(switchTo)各自有独立的重贴路径,不受这个 reason 开关影响。
      void enqueueWrite(async () => {
        if (rect === undefined) {
          await opts.helper.request({ op: 'hover_zone', rect: null }).catch(() => {})
          return
        }

        let screenRect: HelperRect | undefined
        try {
          screenRect = await slotScreenRect()
        }
        catch {
          return // 换算失败(壳断线等)——悬停圈推不了就算了,不升级成 note。
        }
        if (screenRect === undefined) return // 矩形刚设过,理论上不会是 undefined,纯防御

        await opts.helper.request({ op: 'hover_zone', rect: screenRect }).catch(() => {})

        if (reason !== 'resize') return // S5:被动上报到此为止,不碰当前在台窗口。
        // 弹层正开着(让路把 current 藏起来了):不碰,unveil 自己会按那时的槽贴回来(2026-10-12)。
        if (veilDepth > 0) return

        const data = await loadDockFile(opts.file)
        if (data.current === null) return
        const item = data.stack.find(i => i.app === data.current)
        if (item === undefined) return
        try {
          /*
           * 2026-10-12 起走**完整的贴合路径**(placeInSlot:unhide → 等窗 → 贴;双窗态劈槽;不置前),
           * 不再只发一条裸的 set_window_frame(运营同学 10-08 那一条,卡 `claude/ops-patch-1012`):
           * 跨屏 / 换缩放比之后那一扇可能正藏着、或者双窗态要两扇一起挪,裸贴一条只管得了最简单的那种。
           * 不补发 open(cmd 传 undefined,同 restoreCurrent):这一下不是他点的,不替他开应用。
           * 没有循环风险:贴合引起的回声 moved 落进 handleMoved 的"整理"分支(还在叠里、矩形内),不会再触发一轮。
           */
          markActivated(item.bundle_id)
          await placeInSlot(item, screenRect, undefined, now() + CLAIM_WINDOW_BUDGET_MS, false)
          markActivated(item.bundle_id)
          unplaced.delete(item.app)
          setNote(undefined)
        }
        catch (error) {
          const why = error instanceof Error ? error.message : String(error)
          unplaced.set(item.app, why)
          setNote(`窗位变化后自动适配失败:${why}`)
        }
      }).catch(() => {})
    },

    recordRejectedRect(rect: HelperRect | null, reason?: 'resize'): void {
      // stored 恒为 false:业务拒绝连 rectEquals/8px 噪声门槛判定都没走到,slotRect
      // 原样不动——这行只是往观测环里补一条"曾经有个不合规的请求打过来"的证据。
      recordRect(rect ?? undefined, reason, false, true)
    },

    pushHoverZone(): Promise<void> {
      return enqueueWrite(async () => {
        if (slotRect === undefined) {
          await opts.helper.request({ op: 'hover_zone', rect: null }).catch(() => {})
          return
        }
        let screenRect: HelperRect | undefined
        try {
          screenRect = await slotScreenRect()
        }
        catch {
          return // 换算失败(壳断线等)——悬停圈推不了就算了,不升级成 note。
        }
        if (screenRect === undefined) return // slotRect 刚判过有值,理论上不会是 undefined,纯防御
        await opts.helper.request({ op: 'hover_zone', rect: screenRect }).catch(() => {})
      })
    },

    handleMoved(bundleId: string, frame: HelperRect, dragged = true, pressed = false): Promise<void> {
      return enqueueWrite(async () => {
        // 壳在遮罩底下挪开 / 藏好后挪回的那一家(卡 P 补二):不是他拖的,也不是应用自己跑偏 —— 不认。
        const heldUntil = parkedUntil.get(bundleId)
        if (heldUntil !== undefined) {
          if (now() < heldUntil) {
            recordMove(bundleId, 'parked', `截图遮罩底下我们自己挪的窗,不当拖拽:frame=${fmtRect(frame)}`)
            return
          }
          parkedUntil.delete(bundleId)
        }
        let screenRect: HelperRect | undefined
        try {
          screenRect = await slotScreenRect()
        }
        catch (error) {
          // C2:壳断线/超时/辅助功能被收回时 screen_info 请求会 reject——这里必须接住,
          // 不能任它逸出 enqueueWrite 变成 unhandledRejection 炸掉宿主进程。index.ts 的
          // helper.onEvent 接线本身也补了一道 .catch 兜底,这里是双保险的第一道。
          setNote(error instanceof Error ? error.message : String(error))
          recordMove(bundleId, 'no-slot') // S6:screen_info 查不到,判定不了 inside/outside
          return
        }
        if (screenRect === undefined) {
          // D13:窗位矩形还没上报,拖拽认领这条能力老实说"暂不可用",不装作能判定。
          setNote(NOTE_SLOT_UNKNOWN)
          recordMove(bundleId, 'no-slot')
          return
        }
        const inside = insideRect(center(frame), screenRect)

        const data = await loadDockFile(opts.file)
        const existing = data.stack.find(item => item.bundle_id === bundleId)

        if (existing !== undefined && !dragged) {
          /**
           * 程序化移动(2026-08-26 真机实证:微信重新登录后窗口不归位):事件风暴全程
           * 没按过鼠标左键=不是用户在拖,是应用自己在重建/摆放窗口——微信登录流程会
           * 重启应用、销毁旧主窗、在默认位置新开一扇 819×654 的小窗。这种帧既不该走
           * "界外=拖出除名"(把微信静默踢出叠,归位从此无门),也不该走"界内=整理不动"
           * (小窗floating在槽里不贴合)。语义只有一种:已认领的应用自己动了窗,把它
           * 贴回槽位。不动 stack、不改 original、不 raise 不 hide——纯归位。
           * 企业微信重启后自己把窗口恢复到槽位 frame,落进 homeToSlot 的"已就位"分支,
           * 与修复前的实际表现(什么都不做)一致。
           */
          const outcome = await homeToSlot(bundleId, existing, frame, screenRect)
          recordMove(bundleId, outcome.decision, outcome.detail)
          return
        }

        if (existing !== undefined && dragged && !inside && activationSuppressed(bundleId)) {
          /**
           * 程序化激活抑制(2026-09-09):这个应用刚被我们自己激活(/activate、switchTo、
           * 场景恢复),它把窗口摆到槽外多半是应用自己在恢复老位置(企业微信真机实证),
           * 壳却报成 dragged=true。抑制期内不按"拖出"除名,按程序化移动归位——与上面
           * dragged=false 那支走同一套 homeToSlot(容差/冷却/双窗降级都一样),只是
           * 观测环记成 suppressed 并把归位结果写进明细,真机排障能一眼分清这条是
           * "激活抑制"而不是 release 回声(C1 那条 suppressed 不带明细)。
           */
          const outcome = await homeToSlot(bundleId, existing, frame, screenRect)
          recordMove(bundleId, 'suppressed', `程序化激活抑制期内,界外不除名:${outcome.decision}${outcome.detail === undefined ? '' : ` ${outcome.detail}`}`)
          return
        }

        if (existing !== undefined && inside) {
          /**
           * 已认领 & 界内。两种可能,必须分开(spec 2026-08-25 双窗堆叠):
           * (a) 已入坞的那扇在槽里被挪了挪 = 手动整理,照旧什么都不做;
           * (b) **同一应用的另一扇窗被拖进来** = 第二扇进坞,劈槽双显。
           *
           * `moved` 事件只带 bundle_id + frame,不带窗口标识,所以靠 app_info 按位置反查:
           * 事件里那个 frame 对应的窗,是不是已经贴在槽位(或槽位的某一半)上的那扇。
           * 认不出(取不到窗列表/零扇或多扇都对得上)就**如实降级成整理**——宁可少显示
           * 一扇,也不能猜错把用户另一扇窗挪走(D13)。
           */
          if (existing.second !== undefined) {
            // 已经是双窗态:再有窗在槽里动,一律当整理。第三扇不收(一个标签只管两半)。
            setNote(undefined)
            recordMove(bundleId, 'tidy')
            return
          }

          const windows = await listWindows(bundleId)
          /**
           * 判定改用"**槽里现在有几扇窗**",不再试图认出"哪一扇动了"。
           *
           * 原来那套按 frame 反查窗口身份的做法在真机上有两个死角(观测环实证):
           * - 终端按字符格对齐:请求贴 813 高,实际是 819,超出容差就认不出入坞那扇;
           *   而放宽容差又会带来误配,治标不治本。
           * - **两扇窗位置完全相同时(实测 0 与 1 号 frame 逐字相等),位置根本不构成身份。**
           *
           * 数窗口则绕开身份问题:中心点落在槽内的窗有两扇 → 双窗态,一扇 → 单窗。
           * 中心点判定本来就是这条链认"界内"的口径(insideRect),粗粒度、不吃几像素误差。
           */
          const insideWindows = windows.filter(w => insideRect(center(w.frame), screenRect))

          if (insideWindows.length < 2) {
            // 槽里只有一扇 = 用户就是在挪它,不是第二扇进来。
            // **不写 note**:挪窗是高频操作,每次都喊会变成常驻噪音,而噪音本身也是一种
            // 不诚实——它让真正该看的提示被淹掉。
            setNote(undefined)
            recordMove(bundleId, 'tidy', `槽内窗口数=${insideWindows.length}/${windows.length}`)
            return
          }

          const first = insideWindows[0]
          const second = insideWindows[1]
          if (first === undefined || second === undefined) {
            setNote(NOTE_SECOND_UNRESOLVED)
            recordMove(bundleId, 'tidy', `槽内窗口取不到 count=${insideWindows.length}`)
            return
          }
          const dockedIndex = first.index
          const movedIndex = second.index

          // 第二扇窗进坞:劈槽,两扇各贴一半。
          const [firstHalf, secondHalf] = splitSlot(screenRect)
          try {
            await opts.helper.request({ op: 'set_window_frame', bundle_id: bundleId, index: dockedIndex, frame: firstHalf })
            await opts.helper.request({ op: 'set_window_frame', bundle_id: bundleId, index: movedIndex, frame: secondHalf })
            await opts.helper.request({ op: 'raise_window', bundle_id: bundleId, index: dockedIndex })
            await opts.helper.request({ op: 'raise_window', bundle_id: bundleId, index: movedIndex })
          }
          catch (error) {
            // 劈槽失败:不写 second,保持单窗态。窗口现实中可能已经被挪了一半,
            // 但记成双窗态会更糟——那样 release 会去送一扇我们其实没管住的窗。
            setNote(`双窗铺开失败:${error instanceof Error ? error.message : String(error)}`)
            recordMove(bundleId, 'split-failed')
            return
          }

          // original 记的是这扇窗**进坞前**的那一帧,也就是事件里带来的 frame。
          existing.second = { original: frame }
          await persistDock(data)
          setNote(undefined)
          recordMove(bundleId, 'split')
          return
        }

        if (existing !== undefined && !inside) {
          // 已认领 & 拖出窗位 = 除名。窗口留在用户拖到的地方,绝不替用户把窗口挪回去。
          data.stack = data.stack.filter(item => item.bundle_id !== bundleId)
          if (data.current === existing.app) data.current = null
          await persistDock(data)
          unplaced.delete(existing.app)
          setNote(undefined)
          recordMove(bundleId, 'outside')
          return
        }

        if (existing === undefined && inside && !dragged && !pressed && opts.firstRun?.() === true) {
          /**
           * 第一次用(2026-09-18):没认领过的应用 + **两条证据一条都没有** = 不认领。
           * 见 DockOptions.firstRun 那一段。只记一条观测环,**不写 note** ——
           * 他这会儿压根没在跟窗位打交道,冒一句话出来只会让人以为出了什么事。
           *
           * `!pressed` 是 2026-09-18 拖窗认领那张卡补的第二道证据(原来只判 `!dragged`)。
           * dragged 来自「这轮 AX 事件风暴里左键按过没有」,它有一个先天的漏采口子:
           * 采样只发生在 **AX 事件回调里**,而事件风暴起得比按键晚(应用第一帧 moved 迟到、
           * 或壳刚重挂完观察者)的那一拍,按键状态就没人读过。pressed 是在**落定那一刻**
           * 单独读的一次左键状态,跟事件风暴的时序无关——两条证据任一成立就认这是用户在拖。
           *
           * 「两条都没有」才是真正的程序化移动(应用自己重建窗口、我们程序化摆位):
           * 那一刻没有人的手按在鼠标上,这一条的语义没变。
           */
          recordMove(bundleId, 'first-run')
          return
        }

        if (existing === undefined && inside) {
          // C1:release 刚把这个 bundle 的窗口程序化送回 original、原地还在抑制窗口内的话,
          // 这条"界内且未认领"事件大概率就是那次程序化移动的回声,不是用户真的把窗口拖回来——
          // 直接忽略,顺手清掉过期项;过期之后同一帧还能命中这个分支,就按用户真实拖拽处理。
          const suppressedUntil = suppressUntil.get(bundleId)
          if (suppressedUntil !== undefined) {
            if (now() < suppressedUntil) {
              recordMove(bundleId, 'suppressed')
              return
            }
            suppressUntil.delete(bundleId)
          }

          let found = await opts.registry.keyFor(bundleId)
          if (found === undefined) {
            // A2(b) 自愈注册:拖谁进来谁被认领是产品语义,名单制会挡住服务端还不认识的
            // 应用(典型案例:微信更新又把 bundle id 翻回去了)。查不到就问壳这个 bundle
            // 现在的展示名(app_info.name,NSRunningApplication.localizedName),直接注册
            // 成一条新的自定义应用——bundle-id-based 的 `open -b` 打开方式天生对改名免疫,
            // 不用等 Ben 手动去应用区添加。任何一步失败都如实上 note,不装作认识这个应用。
            let name: string | undefined
            try {
              // helper.request 已经把壳回执解到 result 这一层(先例见 slotScreenRect 的
              // screen_info 用法),这里直接取 name,不是再嵌一层 .result。
              const info = await opts.helper.request({ op: 'app_info', bundle_id: bundleId })
              name = typeof info.name === 'string' ? info.name : undefined
            }
            catch (error) {
              setNote(`认领失败:查不到应用信息(${error instanceof Error ? error.message : String(error)})`)
              recordMove(bundleId, 'unknown-app')
              return
            }
            if (name === undefined) {
              // D13:壳没给出名字就不装懂——不拿 bundle_id 硬凑一个"看起来像名字"的东西。
              setNote(`认领失败:应用清单里没有这个应用(${bundleId})`)
              recordMove(bundleId, 'unknown-app')
              return
            }
            const registered = await opts.registry.addResolved({ bundle_id: bundleId, name })
            if (!registered.ok || registered.key === undefined) {
              setNote(`认领失败:自动注册应用失败(${registered.reason ?? '未知原因'})`)
              recordMove(bundleId, 'unknown-app')
              return
            }
            opts.onAppRegistered?.()
            found = { key: registered.key, label: name }
          }
          try {
            // 记 original=frame 必须在贴合动作之前:它是"贴合前"的位置,不是贴过之后的槽位矩形。
            await opts.helper.request({ op: 'set_window_frame', bundle_id: bundleId, index: DOCK_WINDOW_INDEX, frame: screenRect })
            await opts.helper.request({ op: 'raise_window', bundle_id: bundleId, index: DOCK_WINDOW_INDEX })
          }
          catch (error) {
            setNote(`认领失败:${error instanceof Error ? error.message : String(error)}`)
            recordMove(bundleId, 'adopt-failed')
            return
          }
          // 摆位+置前已经成功——窗口现实中已经在槽位里了,认领到这就算成立,不能再因为
          // "隐藏前任"这一步失败而回滚:回滚会造出"窗口在槽位却不在 stack 里"这种比
          // 隐藏失败本身更糟的状态脱节。隐藏前任因此单独 try/catch,失败只如实记 note。
          const prevCurrent = data.current === null ? undefined : data.stack.find(item => item.app === data.current)
          let hideReason: string | undefined
          if (prevCurrent !== undefined) {
            try {
              await opts.helper.request({ op: 'hide_app', bundle_id: prevCurrent.bundle_id })
            }
            catch (error) {
              hideReason = error instanceof Error ? error.message : String(error)
            }
          }
          data.stack.push({ app: found.key, bundle_id: bundleId, original: frame })
          unplaced.delete(found.key) // 上一回没摆进来的原因作废(2026-09-25)
          data.current = found.key
          await persistDock(data)
          setNote(hideReason === undefined ? undefined : `已认领,但隐藏上一个应用失败:${hideReason}`)
          recordMove(bundleId, 'adopted')
          // 光只绑「他真拖进来、放手」这一下(卡 P):有人按着鼠标拖过(dragged / pressed)才亮;
          // 程序化挪窗碰巧落进槽(应用自己恢复位置)照旧认领,但不亮光。
          if (dragged || pressed) {
            const adopted = { app: found.key, bundle_id: bundleId }
            for (const listener of dropListeners) {
              try { listener(adopted) }
              catch { /* 听众出错不影响认领 */ }
            }
          }
          return
        }
        // existing === undefined && !inside:窗位外的普通移动,跟叠无关,忽略。
        recordMove(bundleId, 'ignored')
      })
    },

    handleAxStale(info: { bundle_id: string, ax_err: number, ax_count: number, cg_count: number }): Promise<void> {
      return enqueueWrite(async () => {
        // 终审必修3:节流挡的是"环+note"整体(见上面 AX_STALE_THROTTLE_MS 的 WHY)——
        // 间隔内同一 bundle 的重复上报直接整条丢弃,不进环也不碰 note;不同 bundle 各自
        // 独立计时,互不影响。
        const t = now()
        const last = axStaleLastAt.get(info.bundle_id)
        if (last !== undefined && t - last < AX_STALE_THROTTLE_MS) return
        axStaleLastAt.set(info.bundle_id, t)

        recordAx(info)
        // M5:registry 认不出这个 bundle 就只进环——全量观察下压根没订阅、或者本来就跟
        // 窗位叠无关的应用也可能报休眠,不该拿一句用户看不懂的 bundle id 去打扰 Ben。
        const found = await opts.registry.keyFor(info.bundle_id)
        if (found !== undefined) {
          setNote(`「${found.label}」辅助功能通道休眠,已自动唤醒重试;若拖拽无反应请再拖一次`)
        }
      })
    },

    /**
     * 点标签切换(2026-09-21 重排成「先抬后藏 + 总预算」,Ben:「今天点击标签切换应用经常卡住」)。
     *
     * 顺序与预算(数字与"为什么"见 SWITCH_TOTAL_BUDGET_MS / SWITCH_HIDE_BUDGET_MS):
     * 1. **先抬要切到的那家**(最优先,单独计时)。这是用户看得见的一半——他点了标签,
     *    那扇窗出现在窗位上,这件事就算成了。唤窗也在这一段里,并且带着总预算的绝对到点时刻,
     *    不再最多干等 5 秒。
     * 2. **再藏别家**,整体预算 1.5 秒(抬窗超支时按剩余总预算缩水,见 hideBudget 那行)。
     *    预算用光,剩下的进后台队列慢慢藏——不让用户为"收尾"买单。
     * 3. 无论哪一步,整件事都在总预算左右回 8791。
     *
     * 藏别家的失败**不再让整条切换失败**(这是这次唯一一处判定语义的改动,刻意的):
     * 窗已经抬起来、current 已经是他点的那家了,再因为"上一家没藏成"回一条 ok:false,
     * 只会让界面把一次成功的切换显示成失败。没藏成的如实进 recent_switches 的 `timed_out`,
     * 排障看得见。摆位/置前失败照旧是硬失败——那才是"切换没成"。
     */
    switchTo(app: string): Promise<{ ok: boolean, reason?: string }> {
      return enqueueWrite(async () => {
        const data = await loadDockFile(opts.file)
        const item = data.stack.find(i => i.app === app)
        if (item === undefined) return { ok: false, reason: REASON_NOT_ADOPTED }

        const startedAt = now()
        const deadline = startedAt + SWITCH_TOTAL_BUDGET_MS
        let raiseMs = 0
        let hidden = 0
        let deferred = 0
        const timedOut: string[] = []
        try {
          // M6:矩形检查挪到激活/unhide/摆位这些副作用之前——矩形未知时这条切换注定摆不成,
          // 没必要先把应用拉起来、把窗口从隐藏里翻出来,再半途因为查不到矩形失败,平白多出
          // 用户看得见的窗口抖动;矩形未知时这个分支应该是零 helper 窗口操作。
          const screenRect = await slotScreenRect()
          if (screenRect === undefined) throw new Error(NOTE_SWITCH_SLOT_UNKNOWN)

          // cmd 现在无论是否已在运行都要解出来——运行中但零窗口(下面的唤窗)一样要靠它。
          const cmd = await opts.registry.commandFor(app)
          // 程序化激活抑制(2026-09-09):切换本身就是我们发起的激活,标记要先于 open/unhide
          // 存在——应用自摆窗口的 moved 事件可能紧跟着来。
          markActivated(item.bundle_id)
          if (!(await isRunning(item.bundle_id, opts.runCommand))) {
            if (cmd === undefined) throw new Error(`不认识这个应用:${app}`)
            const activated = await ensureRunningWith(cmd, item.bundle_id, { runCommand: opts.runCommand, sleep: opts.sleep })
            if (!activated.ok) throw new Error(activated.reason ?? '激活失败')
          }
          // ① 抬窗(最优先,单独计时)。
          await placeInSlot(item, screenRect, cmd, deadline)
          raiseMs = now() - startedAt
          // 唤窗(waitForDockWindow)最长会等 DOCK_WINDOW_WAIT_TRIES×DOCK_WINDOW_WAIT_MS,可能把
          // 上面那次标记耗掉一大半——摆位完成后再记一次,让抑制期从"窗口真的出现了"起算。
          markActivated(item.bundle_id)

          // ② 藏别家(可牺牲的一段)。今天"别家"就是上一位 current 那一家;写成列表是因为
          // 预算与后台队列这套机制不该跟"只有一家"这个当下的事实绑死。
          const others = data.current === null || data.current === app
            ? []
            : data.stack.filter(i => i.app === data.current)
          // 抬窗用超了就按总预算的剩余缩水;抬窗把总预算吃光 ⇒ 0,一家都不当场藏。
          const hideBudget = Math.max(0, Math.min(SWITCH_HIDE_BUDGET_MS, deadline - now()))
          const hideStartedAt = now()
          for (let i = 0; i < others.length; i++) {
            const member = others[i]
            if (member === undefined) continue
            if (now() - hideStartedAt >= hideBudget) {
              // 预算用光那一刻就收手,不赌下一家很快:剩下的整批进后台队列。
              const rest = others.slice(i)
              deferred = rest.length
              deferHides(rest)
              break
            }
            try {
              await opts.helper.request({ op: 'hide_app', bundle_id: member.bundle_id })
              hidden += 1
              recordHide(member.app, member.bundle_id, 'switch')
            }
            catch (error) {
              // 这家这次不动:不抛、不重试、不阻塞后面的家(壳侧 1 秒时限与排队放弃都从
              // 这个口子回来)。如实记下是谁、壳说了什么。
              timedOut.push(`${member.app}(${error instanceof Error ? error.message : String(error)})`)
            }
          }
        }
        catch (error) {
          const reason = error instanceof Error ? error.message : String(error)
          setNote(reason)
          // 那一格标成「没在窗位里」(2026-09-25):标签上写「点一下拉进来」,原因就是这一句 —— dock.note
          // 画在槽体里,常常被还在台上的那扇窗盖着,光靠它他看不见为什么没切过去。
          unplaced.set(app, reason)
          recordSwitch({ app, ok: false, total_ms: now() - startedAt, raise_ms: raiseMs, hidden, deferred, timed_out: timedOut })
          return { ok: false, reason }
        }

        data.current = app
        await persistDock(data)
        unplaced.delete(app)
        setNote(undefined)
        recordSwitch({ app, ok: true, total_ms: now() - startedAt, raise_ms: raiseMs, hidden, deferred, timed_out: timedOut })
        return { ok: true }
      })
    },

    reorder(keys: readonly string[]): Promise<{ ok: boolean, reason?: string }> {
      return enqueueWrite(async () => {
        const data = await loadDockFile(opts.file)
        const byApp = new Map(data.stack.map(item => [item.app, item]))
        const ordered: typeof data.stack = []
        for (const key of keys) {
          const item = byApp.get(key)
          if (item === undefined) continue // 不造成员
          byApp.delete(key)
          ordered.push(item)
        }
        // 名单没提到的按原顺序补在队尾,一个都不丢。
        for (const item of data.stack) {
          if (byApp.has(item.app)) ordered.push(item)
        }
        data.stack = ordered
        await persistDock(data)
        return { ok: true }
      })
    },

    release(app: string): Promise<{ ok: boolean, reason?: string }> {
      return enqueueWrite(async () => {
        const data = await loadDockFile(opts.file)
        const item = data.stack.find(i => i.app === app)
        if (item === undefined) return { ok: false, reason: REASON_NOT_ADOPTED }

        // C1:先记一条回声抑制项,再动手送回原位——set_window_frame 一旦发出,壳侧的
        // AXObserver 就可能在之后的 300ms 内报一次回声 moved 事件,抑制项必须先于它存在。
        suppressUntil.set(item.bundle_id, now() + ECHO_SUPPRESS_MS)
        // 程序化激活抑制项相反,到这里必须**清掉**:那个抑制期存在的唯一理由是"别让刚被
        // 我们激活的应用丢标签",而放出正是用户主动要它离开窗位叠——标签都没了,再留着
        // 只会让紧接着的重新认领+拖出在几秒内被误当成激活回声。
        activatedUntil.delete(item.bundle_id)

        // 送回原位是尽力而为(先例见 orchestrator.ts restoreCurrent):窗口可能已被用户关掉,
        // 失败不阻塞除名,但原因如实进返回值,不装成功。
        let reason: string | undefined
        try {
          await opts.helper.request({ op: 'set_window_frame', bundle_id: item.bundle_id, index: DOCK_WINDOW_INDEX, frame: item.original })
          // 双窗态:**两扇都回各自原位**(Ben 定)。第二扇认不出就跳过并如实记原因——
          // 与其按错的下标把某扇窗甩到一个它从没待过的位置,不如让它留在原地。
          if (item.second !== undefined) {
            const secondIndex = (await listWindows(item.bundle_id)).find(w => w.index !== DOCK_WINDOW_INDEX)?.index
            if (secondIndex === undefined) reason = NOTE_SECOND_MISSING
            else {
              await opts.helper.request({
                op: 'set_window_frame',
                bundle_id: item.bundle_id,
                index: secondIndex,
                frame: item.second.original,
              })
            }
          }
        }
        catch (error) {
          reason = error instanceof Error ? error.message : String(error)
        }
        try {
          await opts.helper.request({ op: 'unhide_app', bundle_id: item.bundle_id })
        }
        catch (error) {
          reason = reason ?? (error instanceof Error ? error.message : String(error))
        }

        data.stack = data.stack.filter(i => i.app !== app)
        if (data.current === app) data.current = null
        await persistDock(data)
        unplaced.delete(app)

        setNote(reason)
        if (reason === undefined) return { ok: true }
        return { ok: false, reason }
      })
    },

    hideCurrent(): Promise<{ ok: boolean, reason?: string }> {
      return enqueueWrite(async () => {
        const data = await loadDockFile(opts.file)
        const item = data.current === null ? undefined : data.stack.find(i => i.app === data.current)
        if (item !== undefined) {
          try {
            await opts.helper.request({ op: 'hide_app', bundle_id: item.bundle_id })
          }
          catch (error) {
            const reason = error instanceof Error ? error.message : String(error)
            setNote(reason)
            return { ok: false, reason } // 没藏成就不改 current——不假装藏成功
          }
          recordHide(item.app, item.bundle_id, 'current')
        }

        // 残留窗口清理(2026-09-09,见上面 hideCurrent 的 WHY;实现在 hideStrays,veil 共用)。
        const strayFailures = await hideStrays(data, item, 'stray')

        // item 查不到 = 存档里的 current 指向一个已经不在 stack 里的成员(理论上不该发生)。
        // 那种情况没有窗可藏,但把这个悬空的 current 清掉是对的,不留一个指向空处的值。
        data.current = null
        await persistDock(data)
        if (strayFailures.length > 0) {
          // 当前那扇确实藏起来了(current 已如实置空),只是残留窗口没清干净——如实说是哪个。
          const reason = `${NOTE_STRAY_HIDE_FAILED}${strayFailures.join('、')}`
          setNote(reason)
          return { ok: false, reason }
        }
        setNote(undefined)
        return { ok: true }
      })
    },

    onDropClaimed(listener: (info: { app: string, bundle_id: string }) => void): void {
      dropListeners.add(listener)
    },

    async handleActivation(info: ShellActivation): Promise<void> {
      // 判定与「藏回去」在写队列里做;「跟过去」调 switchTo(它自己进写队列)—— 不能在写队列里再排写队列。
      let followApp: string | undefined
      if (info.verdict === 'overlay') {
        // 遮罩刚开:该藏回去的(同下面 transient 那三条)预约壳「遮罩一收就当场藏回去」。
        // 不该藏的不记 —— 遮罩收了结论会来,那时再记;这里多记一句只会把观测环挤满。
        if (opts.helper.supports?.('rehide') === false) return
        // 不进写队列(卡 P 补二):预约越早到,壳越早在遮罩底下把它的窗挪开 —— 写队列里可能正排着它被放出来
        // 引起的挪窗事件。这里只读:dock.json 是整份换(临时文件 + rename),读到的总是完整的一份。
        const data = await loadDockFile(opts.file)
        const member = data.stack.find(item => item.bundle_id === info.bundle_id)
        if (member === undefined || !info.was_hidden) return
        if (data.current === member.app && veiledApp !== member.app) return
        try {
          // 先压住它的挪窗事件,再预约:壳收下预约就在遮罩底下挪它的窗。
          parkedUntil.set(member.bundle_id, now() + PARK_HOLD_MS)
          const res = await opts.helper.request({ op: 'arm_rehide', bundle_id: member.bundle_id }) as { armed?: unknown } | undefined
          // 壳没收(遮罩已经收了):那一趟照老路走,结论来了这里藏。
          if (res?.armed === true) recordActivation(info, 'armed')
          else {
            parkedUntil.delete(member.bundle_id)
            recordActivation(info, 'arm-failed', '壳回说遮罩已经收了')
          }
        }
        catch (error) {
          parkedUntil.delete(member.bundle_id)
          recordActivation(info, 'arm-failed', error instanceof Error ? error.message : String(error))
        }
        return
      }
      // 预约过的那一家结论到了:再压一小会儿(壳藏好、挪回原位那一下的回声),然后照常。
      if (parkedUntil.has(info.bundle_id)) parkedUntil.set(info.bundle_id, now() + PARK_ECHO_MS)
      let reshow: string | undefined
      await enqueueWrite(async () => {
        const data = await loadDockFile(opts.file)
        const member = data.stack.find(item => item.bundle_id === info.bundle_id)
        if (member === undefined) { recordActivation(info, 'not-member'); return }
        if (info.verdict === 'transient') {
          // 台前那一格本来就露着(弹层让路时藏着的那一扇除外 —— 那是我们藏的,它自己跑出来也要藏回去)。
          if (data.current === member.app && veiledApp !== member.app) {
            // 壳按预约藏的却正是台前那一格(预约之后它成了当前那一格、预约没来得及撤):摆回来,别让窗口槽空着。
            if (info.rehidden === true) reshow = member.app
            recordActivation(info, 'current', info.rehidden === true ? '壳按预约藏了台前那一格,摆回来' : undefined)
            return
          }
          // 只还原这一趟放出来的:被叫出来之前就露着的(别的路径放出来的残留),不在这里替他收。
          if (!info.was_hidden) { recordActivation(info, 'was-visible'); return }
          if (info.rehidden === true) {
            // 遮罩一收壳已经按预约当场藏回去了:只记账,不再发 hide_app。
            windowEpoch += 1
            recordHide(member.app, member.bundle_id, 'transient')
            recordActivation(info, 'restore', '遮罩一收壳当场藏回')
            return
          }
          try {
            await opts.helper.request({ op: 'hide_app', bundle_id: member.bundle_id })
            windowEpoch += 1
            recordHide(member.app, member.bundle_id, 'transient')
            recordActivation(info, 'restore')
          }
          catch (error) {
            // 没藏回去:如实记下来(纯诊断,不写 note —— 他此刻多半在截图,冒一句话只会打扰)。
            recordActivation(info, 'restore-failed', error instanceof Error ? error.message : String(error))
          }
          return
        }
        if (opts.followActivation !== true) { recordActivation(info, 'follow-off'); return }
        if (activationSuppressed(member.bundle_id)) { recordActivation(info, 'ours'); return }
        if (data.current === member.app) { recordActivation(info, 'already'); return }
        followApp = member.app
      })
      if (reshow !== undefined) {
        const back = await service.switchTo(reshow)
        if (back.ok) opts.onChanged?.()
        return
      }
      if (followApp === undefined) return
      const result = await service.switchTo(followApp)
      recordActivation(info, result.ok ? 'follow' : 'follow-failed', result.ok ? undefined : result.reason)
      if (result.ok) opts.onChanged?.()
    },

    noteActivated(app: string): Promise<void> {
      // 走写队列:与 handleMoved 同一队列,保证"先标记、后处理它的 moved 事件"这个顺序——
      // 调用方(/activate、场景恢复)在发出激活之前 await 它,标记就一定先于回声存在。
      return enqueueWrite(async () => {
        const data = await loadDockFile(opts.file)
        const item = data.stack.find(i => i.app === app)
        if (item === undefined) return // 不在叠里,没有标签可保,不留标记
        markActivated(item.bundle_id)
      })
    },

    veil(): Promise<{ ok: boolean, reason?: string }> {
      return enqueueWrite(async () => {
        veilDepth += 1
        if (veilDepth > 1) return { ok: true } // 已经让开了,再开一个弹层不用再藏一次
        veiledApp = undefined
        const data = await loadDockFile(opts.file)
        const item = data.current === null ? undefined : data.stack.find(i => i.app === data.current)
        if (item !== undefined) {
          // 事务官在台/悬空 current 时没有 current 可让,但下面的残留清理照做。
          try {
            await opts.helper.request({ op: 'hide_app', bundle_id: item.bundle_id })
          }
          catch (error) {
            // 没藏成:弹层照开(计数已记),但不记 veiledApp——之后 unveil 不该去 unhide 一扇没藏过的窗。
            // 也不去扫残留:AX 已经不通,多问只是多几条失败。
            const reason = error instanceof Error ? error.message : String(error)
            return { ok: false, reason }
          }
          recordHide(item.app, item.bundle_id, 'veil-current')
          veiledApp = item.app
        }
        // 压在窗位上的残留窗一并清掉(2026-09-16,见接口注释)——只藏 current 它们就露出来盖住弹层。
        const strayFailures = await hideStrays(data, item, 'veil-stray')
        if (strayFailures.length > 0) {
          // current 那扇确实藏成了(veiledApp 已记,unveil 照常带回),只是残留没清干净——如实点名。
          const reason = `${NOTE_VEIL_STRAY_FAILED}${strayFailures.join('、')}`
          setNote(reason)
          return { ok: false, reason }
        }
        return { ok: true }
      })
    },

    unveil(): Promise<{ ok: boolean, reason?: string }> {
      return enqueueWrite(async () => {
        if (veilDepth === 0) return { ok: true } // 多余的 off(keepalive 补发/页面重载),空操作
        veilDepth -= 1
        if (veilDepth > 0) return { ok: true } // 还有弹层开着
        const app = veiledApp
        veiledApp = undefined
        if (app === undefined) return { ok: true } // veil 时没窗可让/没藏成
        const data = await loadDockFile(opts.file)
        // 用户在 veil 期间改了主意(切标签/点事务官/放出)→ current 不再是那一扇,不动。
        if (data.current !== app) return { ok: true }
        const item = data.stack.find(i => i.app === app)
        if (item === undefined) return { ok: true }
        /*
         * ★ **让路期间她退掉了那家 → 不替她开回来**(2026-10-19)。
         *
         * 维护者机器上微信一上午被 `open -b` 了 39 次:current 是微信、她退掉了它,每开关一次顶栏弹层,
         * 这里的 `placeInSlot` → `waitForDockWindow` 第一拍没窗就补发一次 `cmd`,微信就被开回来、摆进窗位。
         * veil 藏的是一扇**开着的**窗,unveil 只该把那扇放回来;它已经退了就没有「回来」这回事 ——
         * 那一格如实标「没开着」(标签上「点一下拉进来」),开不开它由她点标签(`switchTo`)说了算。
         */
        let running: boolean
        try { running = await isRunning(item.bundle_id, opts.runCommand) }
        catch { running = false }
        if (!running) {
          const label = (await opts.registry.listAll()).find(entry => entry.key === app)?.label ?? app
          const reason = `${label} 没开着`
          unplaced.set(item.app, reason)
          recordMove(item.bundle_id, 'unveil-quit', reason)
          setNote(undefined)
          return { ok: true }
        }
        try {
          const screenRect = await slotScreenRect()
          if (screenRect === undefined) throw new Error(NOTE_SWITCH_SLOT_UNKNOWN)
          const cmd = await opts.registry.commandFor(app)
          // unhide 会让应用自己重摆窗口,与 switchTo 同款:先留抑制期,别让回来的窗丢标签。
          markActivated(item.bundle_id)
          await placeInSlot(item, screenRect, cmd)
          markActivated(item.bundle_id)
        }
        catch (error) {
          // 壳断开/重启:回不来就算了,如实写 note,弹层这边已经关掉了,不卡它。
          const reason = error instanceof Error ? error.message : String(error)
          setNote(reason)
          return { ok: false, reason }
        }
        setNote(undefined)
        return { ok: true }
      })
    },

    claim(app: string, options: { launch?: boolean, raise?: boolean } = {}): Promise<{ ok: boolean, state: SlotClaimState, note?: string }> {
      return enqueueWrite(async () => {
        const data = await loadDockFile(opts.file)
        const label = (await opts.registry.listAll()).find(entry => entry.key === app)?.label ?? app
        const out = await claimOne({ app, label }, data, await claimRect(), {
          // 标签上点的:缺省**先开再拉、拉完置前** —— 他点的就是"我要看它"。
          launch: options.launch !== false,
          raise: options.raise !== false,
        })
        if (out.state === 'claimed') await persistDock(data)
        // 拉不成的那一句写进窗位 note:告诉他还可以把窗拖进虚线区。拉成了就清掉旧 note(有藏窗失败那句就留它)。
        setNote(out.state === 'already' ? note : out.note)
        return out
      })
    },

    claimEnabled(options: { launch?: boolean } = {}): Promise<SlotClaimReport> {
      return enqueueWrite(async () => {
        const wanted = await opts.registry.wanted?.() ?? []
        const data = await loadDockFile(opts.file)
        const where = await claimRect()
        const results: SlotClaimRow[] = []
        let changed = false
        for (const item of wanted) {
          const out = await claimOne({ app: item.key, label: item.label }, data, where, { launch: options.launch === true, raise: false })
          if (out.state === 'claimed') changed = true
          results.push({ app: item.key, label: item.label, state: out.state, ...(out.note === undefined ? {} : { note: out.note }) })
        }
        if (changed) {
          await persistDock(data)
          opts.onChanged?.()
        }
        return slotReport(results)
      })
    },

    async claimPreview(): Promise<SlotClaimReport> {
      // 只读:不进写队列、不 unhide、不摆位 —— 只问开没开(lsappinfo)与窗位量不量得到(screen_info)。
      const wanted = await opts.registry.wanted?.() ?? []
      const data = await loadDockFile(opts.file)
      const where = await claimRect()
      const results: SlotClaimRow[] = []
      for (const item of wanted) {
        const row = { app: item.key, label: item.label }
        const bundleId = await opts.registry.bundleFor(item.key)
        if (inStack(data, item.key, bundleId)) { results.push({ ...row, state: 'already' }); continue }
        if (bundleId === undefined) { results.push({ ...row, state: 'failed', note: `窗位清单里没有「${item.label}」` }); continue }
        let running: boolean
        try { running = await isRunning(bundleId, opts.runCommand) }
        catch { running = false }
        if (!running) { results.push({ ...row, state: 'not_running', note: `${item.label} 没开着 —— 标签上点一下,会先打开再拉进来` }); continue }
        if (where.problem !== undefined) {
          const failure = claimFailure(item.label, where.problem)
          results.push({ ...row, state: failure.state, note: failure.note })
          continue
        }
        if (where.rect === undefined) { results.push({ ...row, state: 'needs_click', note: slotHiddenNote(item.label) }); continue }
        results.push({ ...row, state: 'ready', note: `${item.label} 开着,会直接拉进来` })
      }
      return slotReport(results, true)
    },

    noteShellReady(): void {
      if (opts.keepCurrentInSlot !== true) return
      restorePending = true
      // 矩形在手就排一轮;不在手就等页面报上来(setSlotRect 那头会排)。
      if (slotRect !== undefined) scheduleRestore()
    },

    async view(): Promise<WorkbenchState['dock']> {
      const data = await loadDockFile(opts.file)
      const apps = await opts.registry.list()
      const labelByKey = new Map(apps.map(a => [a.key, a.label]))
      /**
       * 「当前那一扇」其实不在窗位里(2026-09-25,卡 fix/slot-current-empty):标签高亮着,槽里却是空的。
       * 两种来源 —— ① 摆回 / 切换时没摆成(unplaced 里记着原因);② 这会儿去问一声:那家没开着、
       * 或者被藏起来了(⌘H、别的应用把它藏了)。问的是 lsappinfo,不走壳的 AX。
       * 这几种时候不问:弹层正让着路(那是故意藏的)、起来之后的摆回还没跑完、写队列里正有活
       * (窗正处在藏了一半 / 摆了一半的中间态)。问不出来就不说(不冒充"藏着")。
       */
      let currentUnplaced: string | undefined
      const currentItem = data.current === null ? undefined : data.stack.find(item => item.app === data.current)
      if (opts.keepCurrentInSlot === true && currentItem !== undefined && !unplaced.has(currentItem.app)
        && veilDepth === 0 && !restorePending && !restoreRunning && queueBusy === 0) {
        const state = await probeCurrentApp(currentItem.bundle_id)
        const label = labelByKey.get(currentItem.app) ?? currentItem.app
        if (state !== undefined && !state.running) currentUnplaced = `${label} 没开着`
        else if (state !== undefined && state.hidden) currentUnplaced = `${label} 被藏起来了`
      }
      const stack = await Promise.all(data.stack.map(async (item) => {
        // S4(review,真机截图实证):按 bundle_id 而不是 item.app(registry 键)判定
        // 这个标签是不是某家 IM——微信的 bundle id 反复漂移过,一旦漂移触发 A2(b)
        // 自愈注册,item.app 就会变成 `c-<slug>` 这样的自定义键,客户端没法再靠字符串
        // 比对 'wechat'/'wecom' 认出它,badge 会从此失配、永远不出现。这里在 bundle_id
        // 这个稳定的真相层面判定,不管 registry 把它叫做什么键都认得出。
        const im = item.bundle_id === APP_BUNDLES.wechat
          ? 'wechat' as const
          : item.bundle_id === APP_BUNDLES.wecom ? 'wecom' as const : undefined
        return {
          key: item.app,
          label: labelByKey.get(item.app) ?? item.app,
          // 双窗态透给界面(只在真的有第二扇时才带这个字段,缺省即单窗)。
          ...(item.second === undefined ? {} : { dual: true }),
          running: await isRunningCached(item.bundle_id),
          current: data.current === item.app,
          ...(im === undefined ? {} : { im }),
          ...((() => {
            const why = unplaced.get(item.app) ?? (item === currentItem ? currentUnplaced : undefined)
            return why === undefined ? {} : { unplaced: why }
          })()),
        }
      }))
      // S6:recent_moves 是可选字段(spec 明确"state 级、可选")——一条 moved 事件都还
      //没收到过(环是空的)时不带这个字段,跟既有 note 同款的"缺省即无"纪律保持一致,
      // 也不用把这波之前那几十个按 stack/note 做精确 toEqual 断言的既有测试全部改一遍。
      // 快照当次的数组引用,不给外部拿到内部环的可变引用去意外改动。
      /**
       * 他要放进窗口槽、还没拉进来的那几家(2026-09-25):apps.json enabled 里、叠里没有的。
       * wanted 里只有基础键,bundle 直接查 APP_BUNDLES —— 这条在一秒一拍的 /state 上,不为它再读几遍 apps.json。
       * 同一个应用以自愈注册的键进了叠(bundle 相同)也算在了,不再冒一格「点一下拉进来」。
       */
      const wanted = await opts.registry.wanted?.() ?? []
      const stackKeys = new Set(data.stack.map(item => item.app))
      const stackBundles = new Set(data.stack.map(item => item.bundle_id))
      const pending = wanted
        .filter(item => !stackKeys.has(item.key) && !stackBundles.has(APP_BUNDLES[item.key] ?? ''))
        .map(item => ({ key: item.key, label: item.label }))
      return {
        stack,
        // 每一格是哪个 App(卡 Q):界面按包标识把标签对上 Agent 登记表里的那一家。
        ...(data.stack.length === 0 ? {} : { bundles: Object.fromEntries(data.stack.map(item => [item.app, item.bundle_id])) }),
        ...(pending.length === 0 ? {} : { pending }),
        ...(note === undefined ? {} : { note }),
        ...(recentMoves.length === 0 ? {} : { recent_moves: [...recentMoves] }),
        ...(recentAx.length === 0 ? {} : { recent_ax: [...recentAx] }),
        ...(recentRects.length === 0 ? {} : { recent_rects: [...recentRects] }),
        ...(recentHides.length === 0 ? {} : { recent_hides: [...recentHides] }),
        ...(recentSwitches.length === 0 ? {} : { recent_switches: [...recentSwitches] }),
        ...(recentActivations.length === 0 ? {} : { recent_activations: [...recentActivations] }),
        ...(veilDepth === 0 ? {} : { veil: { ...(veiledApp === undefined ? {} : { app: veiledApp }), depth: veilDepth } }),
      }
    },

    pushSlotApps(): Promise<void> {
      // 不进写队列:它一个窗口都不碰,只读一次 dock.json 再发一条名单 ——
      // 排在认领 / 切换后面只会让壳晚知道,而晚知道的那几拍正是她刚点进那扇窗的时候。
      return loadDockFile(opts.file).then(sendSlotApps).catch(() => {})
    },

    async observeTargets(): Promise<string[]> {
      const apps = await opts.registry.list()
      const bundles = await Promise.all(apps.map(a => opts.registry.bundleFor(a.key)))
      return bundles.filter((b): b is string => b !== undefined)
    },

    noteObserveFailures(bundleIds: readonly string[]): Promise<void> {
      return enqueueWrite(async () => {
        let labels: string[] = []
        if (bundleIds.length > 0) {
          // M5:先按 dock.json 的当前叠算出"已认领"的 bundle 集合——registry 反查不到
          // 但已经在叠里的极端情况(理论上不该出现,防御性兜底)也不能被当噪音丢掉。
          const data = await loadDockFile(opts.file)
          const adopted = new Set(data.stack.map(item => item.bundle_id))
          for (const bundleId of bundleIds) {
            const found = await opts.registry.keyFor(bundleId)
            if (found !== undefined) { labels.push(found.label); continue }
            if (adopted.has(bundleId)) labels.push(bundleId) // D13:查不到展示名就退回 bundle id 本身
            // 两者都不是:registry 不认识、也没被认领过——全量观察下这是常态噪音
            // (后台辅助进程/无主窗口应用等),直接丢弃,不写进 note。
          }
        }

        if (labels.length > 0) {
          setNote(`${OBSERVE_FAILURE_PREFIX}${labels.join('、')}`)
          return
        }

        // F1(review,真机截图实证):这一轮过滤完是空的(不管是传进来就是空数组,还是
        // 传了东西但全被当噪音丢了)——真机实况:壳启动时 TCC 还没授权,attachAllRunning
        // 会把当时能枚举到的应用全部报成"挂载失败"(不是应用不兼容,是权限还没给),
        // 写成一条陈旧 note;授权后壳重新 attach 基本都成功,但旧代码"清单空就什么都
        // 不做",这条陈旧 note 因此永远赖着,Ben 授权完还在看一句过时的"不支持拖拽认领"。
        // 这里补上:只有当前 note 正是上一次 observe 失败写的(前缀匹配 OBSERVE_FAILURE_
        // PREFIX)才清掉——这次成功了就该把上次的失败记录抹掉;不是 observe 失败写的
        // note(比如切换/认领失败的原因)不受这里影响,不能被"这轮 observe 没有失败"
        // 误清掉。
        if (note !== undefined && note.startsWith(OBSERVE_FAILURE_PREFIX)) setNote(undefined)
      })
    },
  }
  return service
}
