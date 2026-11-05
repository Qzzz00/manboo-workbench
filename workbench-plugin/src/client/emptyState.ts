/**
 * 第一次用:「首次」判定与各模块的空态(2026-09-18)。**纯函数**,不碰 DOM、不发请求
 * ——同 areaUnlock.ts / shellWindowMode.ts 的先例:算什么该显示的那一半单独一个文件、
 * 有单测,组件只负责把结论画出来。
 *
 * Ben 2026-09-17 真机原话:「我直接点了跳过进入工作台,消耗数据、事务官会话都有残留,
 * 窗口槽里也什么都有了……我是第一次用啊,这些本质上都得引导用户去处理,在第一次的时候。」
 *
 * 两条贯穿全文件的规矩,顺序不能反:
 *
 * 1. **不是首次 → 一个字都不变。** 引导做完(或这台服务压根没接引导)之后,这里的每个
 *    函数都回 `undefined`,界面退回这一版之前的样子。
 * 2. **有数据 → 显示数据,哪怕是首次。** 空态只在「这一格真的什么都没有」时出现。
 *    这条是刻意写死的:Ben 这台机器上留着旧事项、旧账本,把它们藏起来换一句"还没有…"
 *    等于**替用户把他的东西藏了**,比多显示一格残留糟得多。残留数据该不该清是另一件事
 *    (统筹从零验收时清),界面这一层永远不撒这个谎。
 */
import type { AgentId, AgentQuotaView, QuotaEntry } from '../protocol.ts'
import type { IconName } from './ui/icons.tsx'

/**
 * 「第一次用」怎么算 —— **引导没做完就是第一次**。
 *
 * 刻意**不看** `first_run_done_at`(那面旗子在 app.json 里,`/first-run` 那条路上):
 * 那面旗子记的是"三屏给他看过了没有",而 Ben 正是**点了「跳过」**才掉进这次反馈里的
 * ——跳过也会写旗子。按旗子判,他第一次进工作台就已经"不是首次"了,这整张卡等于没做。
 *
 * `onboarding` 整格缺席 = 这台服务没接引导阶段机(展示台、手机、既有那一大批用例),
 * 一律**当作不是首次**:没查过不等于没有,而"没接引导"的那些场合本来就不该被一句
 * 「引导里会帮你…」拦住(同 areaUnlock 里 `clients` 缺席退回旧行为那条纪律)。
 */
export function isFirstTime(state: { onboarding?: { done: boolean } }): boolean {
  if (state.onboarding === undefined) return false
  return !state.onboarding.done
}

/** 哪几格有空态。跟 layout 的 ModuleId 不是一回事:事务官会话区不是一个可拖的模块。 */
export type EmptyModule = 'slot' | 'projects' | 'butler' | 'usage' | 'quota' | 'notes'

export interface EmptyView {
  module: EmptyModule
  /** 一句结论(评审页 0cf75042 各格空态的标题,10-22 拍板 23 补齐)。 */
  title: string
  /** 一句引导。界面原样显示,不再拼接。 */
  line: string
  /** 标题上面那枚线性图标(评审页那套)。 */
  icon: IconName
  /**
   * 一颗按钮。**只在引导真的能替他做这件事时才有**(今天只有项目区那一格):
   * 画一颗按下去什么也办不成的按钮就是骗人(D13)。其余几格的出路写在那句话里
   * ——「把窗口拖进来」「在下面打字跟她说第一句」都是他当场就能做的动作。
   */
  action?: { label: string }
}

/**
 * 这几个函数认的状态。写成结构化的一小份而不是直接吃 `WorkbenchState`:
 * `WorkbenchState` 必填五个字段(agents/sessions/quota/now/stale),用例要测
 * 「窗口槽空不空」得先凑一份完整快照才行。`WorkbenchState` 结构上满足这份接口,
 * 调用点原样传就行。
 */
export interface EmptyStateInput {
  onboarding?: { done: boolean }
  /** `pending`(2026-09-25):他要的、还没拉进来的那几家 —— 有的话那句话先指「点一下拉进来」。 */
  dock?: { stack?: readonly unknown[], pending?: readonly unknown[] }
  projects?: { projects?: readonly unknown[] }
  tasks?: { tasks?: readonly unknown[] }
  butler_inbox?: { items?: readonly unknown[] }
  sessions?: readonly unknown[]
  /**
   * `/state.usage` 取不到时是 `{ error }`(没有 days)—— 那正好是"这一格没有数据"的另一种
   * 说法,所以 `days` 在这里是可选的,而不是让调用点先分一次支。
   */
  usage?: { days?: readonly unknown[], error?: string }
  quota?: Partial<Record<AgentId, QuotaEntry>>
  /**
   * 能接活那几家的额度(卡 O 的 `/state.agent_quota`)。**缺席 = 老宿主 / 展示台那份副本**,
   * 那时这一格的判法与卡 QS 之前逐字相同(同 dock、onboarding 缺席那两条纪律)。
   */
  agent_quota?: readonly AgentQuotaView[]
  model_mode?: 'relay' | 'own'
  notes?: readonly unknown[]
  /** 已配对的手机。事务官那一句话按有没有手机换半句。 */
  devices?: readonly unknown[]
  /**
   * 当前布局模板(2026-09-21)。`project_empty_line` 一句跟着它换:
   * 「项目」在运营模板里叫「账号」,空态那一句跟着换成「还没有账号,引导里会问。」。
   * 缺席就退回做产品那一句,与加这个字段之前逐字相同。
   */
  template?: { project_empty_line?: string }
}

/**
 * 一家额度**有没有真数字**。
 *
 * `unknown` 是"这家的取数方式还没实测通";`balance` 的 `available:false` 是"这次没取到"
 * ——两者都不算有数(界面上它们本来就显示「未接入」)。**绝不把它们当成 0**:
 * 0 会被读成"额度耗尽",意思正好相反(quotaCells.ts 顶上那条老纪律)。
 */
function quotaHasNumbers(entry: QuotaEntry | undefined): boolean {
  if (entry === undefined) return false
  if (entry.kind === 'balance') return entry.available
  if (entry.kind === 'quota') return entry.windows.length > 0
  return false
}

/**
 * **上次读到的那个数也算有数**(2026-09-26,卡 SM;卡 QS 交接第八节第 2 条)。
 *
 * 卡 QS 起,这一轮读不到新的、但以前真读到过的那一家,`/state.agent_quota` 里照旧是
 * 「有数」(`state:'numbers'`,带「几点读到的」),额度区那一格也照旧摆着那个数。
 * 而这一格原来只看 `/state.quota` —— 于是有一种很窄的情形:没走中转、没填 DeepSeek Key、
 * Codex / Kimi 也没有数,只有 Claude 顶着一个昨晚读到的旧数 —— 整块会压在那个数上面写
 * 「还没接上任何一家的凭据」。**屏幕上明明摆着一个真数字,却说一家都没接上**,按第一次用的人
 * 读就是自相矛盾。所以两处都看。
 *
 * **「不限」不算**(`state:'unlimited'`):那是查实过的官方说法(豆包的普通对话、Manus 限时免费),
 * 一台刚装好、什么都没接的机器上也是这么写 —— 拿它当"接上了"会让这一格的空态**永远不出现**,
 * 第一次用的人就再也看不到那句指路的话了。`unconnected` 更不算(它自己就在说没接上)。
 */
function agentQuotaHasNumbers(views: readonly AgentQuotaView[] | undefined): boolean {
  return (views ?? []).some(one => one.state === 'numbers')
}

/** 这一格此刻有没有东西可显示。有 → 显示它,空态让位(见文件头第 2 条)。 */
function hasData(module: EmptyModule, state: EmptyStateInput): boolean {
  switch (module) {
    /**
     * 窗位叠里认领过窗 = 有东西。**不看应用清单**:清单是"能往里放什么",不是"里面有什么"。
     *
     * `dock` 整格缺席是另一回事 —— 那是**这台服务压根没接窗位叠**(展示台、手机、
     * 一大批用例),那时候界面上根本没有落点,一句「把常用的窗口拖进来」是指着一条
     * 不存在的路说话。所以缺席一律当作"不归这一格管",不出空态(同 isFirstTime 里
     * onboarding 缺席那条的写法)。
     */
    case 'slot': return state.dock === undefined || (state.dock.stack ?? []).length > 0
    // 项目区与看板同一格两个视图,任一有内容就不算空。
    case 'projects': return (state.projects?.projects ?? []).length > 0 || (state.tasks?.tasks ?? []).length > 0
    // 事务官:手上有事项、或者各家有会话在跑 —— 两者都是"她已经在替你干活了"。
    case 'butler': return (state.butler_inbox?.items ?? []).length > 0 || (state.sessions ?? []).length > 0
    case 'usage': return (state.usage?.days ?? []).length > 0
    // 余额/额度:走中转时那一格说的是工作台自家的今日用量,本来就有话可说。
    // 这一轮取到的数(/state.quota)与上次读到的数(/state.agent_quota)**两处都算**,见 agentQuotaHasNumbers。
    case 'quota': return state.model_mode === 'relay'
      || Object.values(state.quota ?? {}).some(entry => quotaHasNumbers(entry as QuotaEntry | undefined))
      || agentQuotaHasNumbers(state.agent_quota)
    case 'notes': return (state.notes ?? []).length > 0
  }
}

/**
 * 事务官那一句按有没有配过手机换半句 —— 配过就把"手机上也能说"这条路说出来,
 * 没配过就不提(替他操心一件他还没打算做的事,是这一版最该避免的味道)。
 */
function butlerLine(state: EmptyStateInput): string {
  return (state.devices ?? []).length > 0
    ? '在下面打字说第一句,手机上也可以直接说。'
    : '在下面打字说第一句 —— 配对手机之后,还能直接对着手机说。'
}

/**
 * 模板给的那一句若以「还没有 X」开头,拆成标题与引导;不是这么开头的(运营模板的素材那一句),标题只说「这一格还空着」,
 * 不拿这一格自己那个标题去配一句说别的事的话。模板没给就用这一格自己的标题与引导。
 */
function split(line: string | undefined, title: string, hint: string): { title: string, line: string } {
  if (line === undefined || line === '') return { title, line: hint }
  const head = /^(还没有[^,。]+)[,。](.+)$/.exec(line)
  return head === null ? { title: '这一格还空着', line } : { title: head[1] as string, line: (head[2] as string).trim() }
}

/**
 * 每一格的标题、那句话与图标(10-22 拍板 23:照评审页各格空态补齐「图标 + 标题 + 一句说明 + 次按钮」,文案按稿的例子写、
 * 口吻按这一格实际能做什么)。按钮只给按下去真能办成的那几格(见 EmptyView.action 的注释)。
 */
function viewOf(module: EmptyModule, state: EmptyStateInput): EmptyView {
  switch (module) {
    /**
     * 2026-09-20 改了这一句(Ben 原话):原来是「还没有应用。把常用的窗口拖进来,或让
     * 事务官在引导里帮你选。」——后半句指着一条今天走不通的路(引导里并没有替他选应用
     * 这一步),前半句也没说清楚「拖到哪儿、拖完会怎样」。新的一句把动作(从屏幕上拖进
     * 这块槽)和结果(出现在这排标签里)都说出来,这是预置场景删掉之后唯一的那条路。
     */
    // 2026-09-25:他要的那几家已经作为「点一下拉进来」的标签摆在上面了 —— 先指那条一步就到的路,拖拽退到后半句。
    case 'slot': return (state.dock?.pending ?? []).length > 0
      // 不说「上面」:横屏时标签栏在左边那一条里。
      ? { module, title: '窗口槽还空着', icon: 'layers', line: '标签栏里写着「点一下拉进来」的那几个,点一下就把那家的窗拉进来;别的应用从屏幕上拖进这块槽里也行。' }
      : { module, title: '窗口槽还空着', icon: 'layers', line: '把常用的应用从屏幕上拖进这块槽里,它就会出现在这排标签里。' }
    // 2026-09-21:这一句跟模板走(运营模板下是「还没有账号,引导里会问。」)。
    // 那颗「开始引导」按钮两个模板都留着:两边的空态都是"引导里会问",按钮就是那条路。
    case 'projects': return {
      module,
      icon: 'layers',
      ...split(state.template?.project_empty_line, '还没有项目', '引导里会帮你扫描已有的,或者从零建第一个。'),
      action: { label: '开始引导' },
    }
    case 'butler': return { module, title: '还没有事项', icon: 'messages-square', line: butlerLine(state) }
    case 'usage': return { module, title: '还没有消耗记录', icon: 'calendar-days', line: '接入一家的记录后,这里开始显示每日用量。' }
    // 「连接账号」去设置里填各家的密钥与登录(额度从那里取),按下去真能办成。
    case 'quota': return { module, title: '还没有接上额度', icon: 'sliders-horizontal', line: '已有账号可以在设置里连接。未接入不会显示为 0%。', action: { label: '连接账号' } }
    case 'notes': return { module, title: '想法先留在这里', icon: 'file-pen-line', line: '不用先想好归到哪个项目。' }
  }
}

/**
 * 「首次」那道闸门管不着的格子(2026-09-20 去预置场景)。
 *
 * 除了这里列出的,别的格子一律是**首次专属**的空态:引导做完就整片退场(见下面那条
 * 老纪律)。窗位叠这一格例外 —— 原来装机时预置的「干活 / 沟通」两条空场景被删掉了
 * (Ben:「那两个所谓的『预置』从默认布局里删掉吧,反而是要提醒用户把常用的应用自己
 * 拖进来」),从此**没有任何东西替用户把应用放进窗位**。要是这句提醒跟着引导一起退场,
 * 跳过引导、或者引导做完还没顾上拖应用的人,看到的就是一块什么都不说的空槽。
 * 所以它的出场条件只剩一条:**叠里一个应用都没认领过**(而且这台服务真的接了窗位叠)。
 * 认领第一个应用那一刻它自己消失,不需要引导来收。
 */
const ALWAYS_WHEN_EMPTY: ReadonlySet<EmptyModule> = new Set<EmptyModule>(['slot'])

/**
 * 这一格此刻该不该画空态,该画就把那句话给出来。
 *
 * 回 `undefined` 的两种情形在界面上后果一样(照旧渲染),但语义完全不同,所以合成一个
 * 函数而不是让调用点各判各的:**不是首次**(引导做完了 / 没接引导)与**有数据**。
 * 引导做完那一刻 `onboarding.done` 翻真,同一拍轮询里所有空态一起退场;某一格的数据
 * 先到,就只有那一格先退 —— 两条退场路各走各的,不互相等。
 */
export function emptyStateFor(module: EmptyModule, state: EmptyStateInput): EmptyView | undefined {
  if (!ALWAYS_WHEN_EMPTY.has(module) && !isFirstTime(state)) return undefined
  if (hasData(module, state)) return undefined
  return viewOf(module, state)
}
