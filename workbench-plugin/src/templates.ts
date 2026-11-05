/**
 * 布局模板(2026-09-21,决策记录 2026-09-20「去掉预置场景;引导里选布局模板」)。
 *
 * ## 一个模板是什么
 *
 * Ben 2026-09-20:「『模板』= 命名的一整套(横竖两份模块布局 + 窗位应用清单 +
 * 工作目录文件夹结构 + 看板列 + 引导问法)」。
 *
 * 2026-10-23(分层二刀二)起,这个文件**只自带「做产品」一份** + 模板格式(WorkbenchTemplate
 * 那几个接口);运营(自媒体)那一份的内容整份搬进了用户层 `布局/ops.json`(起步层带缺省),
 * 本体只认格式 —— parser / validator 在 server/userLayer.ts,格式写进用户层目录里每次启动
 * 重写的 契约.md。运行时有哪些模板经 `setWorkbenchTemplateSource` 注入(见文件底部),
 * 深调用方(onboardingStages / productFeedback / http)拿不到服务实例,走那个一次性注册。
 * **一行 I/O 都没有**——落盘、备份、apply 在 server/templateStore.ts;布局文件的读法在
 * server/userLayer.ts。
 *
 * ## 为什么放在 src/ 顶层而不是 src/server/ 或 src/client/
 *
 * 两边都要读它:服务端要按它写布局、建文件夹、换引导问法;客户端要按它显示模块标题、
 * 「项目 / 账号」那个词、设置里那两张卡片。`src/protocol.ts` 已经是这种"两边共用"的先例,
 * 这个文件跟它同一层。**一行 I/O 都没有**——落盘、备份、apply 在 server/templateStore.ts。
 *
 * ## 「做产品」模板 = 现状,一字不改
 *
 * `PRODUCT_TEMPLATE.portrait` / `.landscape` 就是 2026-09-20 之前 client/layout.ts 里的
 * `DEFAULT_LAYOUT.modules` / `DEFAULT_LANDSCAPE_MODULES` **逐字搬过来的那两份**
 * (client/layout.ts 现在从这里 re-export,不再各存一份——两份字面量必走漂,先例见
 * layout.ts MODULE_IDS 的 F1 注)。切回 product 模板就是回到今天的样子,既有那一大批
 * 布局用例原样兜着。
 *
 * ## 模板定义曾经是 ts 常量;为什么现在只有 product 一份(2026-10-23,分层二刀二)
 *
 * 内置数据写错了 `tsc` 当场红,这条理由对**本体自带的 product** 仍然成立,所以它留下。
 * 运营那一份是**她的内容**(与她的六格小组件同理):要能在她的机器上改、升级不动它,
 * 就得离开本体常量,住进用户层 `布局/ops.json` —— 格式(parser / validator / 契约.md)
 * 仍由本体管。当时选 ts 不选 `templates/*.json` 的打包理由(发出去的只有 lib/ 两个文件)
 * 由 `lib/starter-layer/` 整体拷贝接住。
 */
import type { LayoutModule, ProjectSourceId, TopicStage } from './protocol.ts'

/**
 * 没选过模板时是哪一个。**必须是 product**——它就是现状,老机器读不到 template.json 时一格不挪。
 *
 * 2026-10-23(分层二刀二):模板 id 不再限定内置联合类型 —— 用户层 `布局/<id>.json` 里的
 * 模板 id 由那份文件自己声明,本体只认格式。product 仍是本体唯一自带的那一份。
 */
export const DEFAULT_TEMPLATE_ID = 'product'

/**
 * 模板带的一个窗位应用。
 *
 * - `kind: 'native'`:本机原生应用,能贴进窗位槽。`bundle_id` **查不到就不写**
 *   (D13:不许猜一个常见 bundle id;appsRegistry.add 的老规矩)。
 * - `kind: 'web'`:网页型(可灵 / 小红书 / 可画)。**这一版只登记不认领**——
 *   窗位叠里显示成一颗「打开」按钮,点了用系统默认浏览器开那个网址,不贴进槽。
 *   把网页也做成能贴的窗位是另一件事(要嵌浏览器),不在这张卡里。
 */
export interface TemplateApp {
  kind: 'native' | 'web'
  /** 窗位键。基础应用用既有的键(codex / claude / …),模板新增的用 `t-` 前缀。 */
  key: string
  label: string
  /** native:`open -a <app_name>` 里那个名字。 */
  app_name?: string
  /** native:实测到的 bundle id;**查不到就整个字段缺席**,不是空串、不是猜的值。 */
  bundle_id?: string
  /** native 且本机没查到 bundle id 时,把「为什么没有」如实写在这儿,界面上原样显示。 */
  bundle_note?: string
  /** web:点「打开」去哪儿。 */
  url?: string
}

/** 模板要在工作目录下建的一个文件夹。`purpose` 只是给人看的一句话,不参与任何逻辑。 */
export interface TemplateFolder {
  /** 相对工作目录(butler_cwd)的路径,`/` 分隔。不许以 `/` 开头、不许含 `..`(apply 会再校验一遍)。 */
  rel: string
  purpose: string
}

/**
 * 模板在引导里换掉哪些问法。**只换 goals 与种子句,不加问卷**
 * (2026-09-20「引导 ②′ 从『问卷+总结』改成『协助梳理』」那一条还管着)。
 * 缺席的字段 = 这个模板不换那一处,照既有的走。
 */
export interface TemplateOnboarding {
  // ② 分岔那一句 2026-09-23 起不随模板换:分岔排在布局之前问,问的时候还不知道模板
  // (维护者真机:「为什么一开始是布局而不是从新点子或已有项目,这反了啊」)。原先的 branch_seed / branch_goals 删了。
  /** ②′ 那一步的种子句。 */
  projects_seed?: string
  /** ②′ 那一步要弄清的东西。**运营模板这一份里一个字都不提扫仓库**。 */
  projects_goals?: readonly string[]
  /** ②′ 这个模板下还要不要扫仓库。false = 引导简报里连「可以读你的仓库目录吗」都不出现。 */
  scan_repos?: boolean
}

export interface WorkbenchTemplate {
  id: string
  name: string
  /** 设置里那张卡片上的一句话。 */
  tagline: string
  /** 「项目」在这个模板里叫什么。做产品 = 项目,运营 = 账号。 */
  project_word: string
  /** 项目区空着时说哪句话。 */
  project_empty_line: string
  /** 素材管理 / 系统文件夹那一格空着时说哪句话(2026-09-26,卡 ZM)。 */
  files_empty_line?: string
  /**
   * 项目区这一格里的数据从哪来(2026-09-21「项目数据源」那张卡)。
   *
   * - `'git'`:扫描根下的 git 仓库(做产品,现状一字不改)
   * - `'accounts'`:工作目录下 `账号/<名>/` 那些文件夹(自媒体运营)
   *
   * ## 这个字段 2026-09-21 早上被删过一次,现在加回来了 —— 区别在哪
   *
   * 上一版写过一个 `project_source: 'git' | 'folder'`,当天就删掉了,理由是
   * **内核里没有任何一行会因为它而改变行为**(项目区照样跑 git 扫描),
   * 一个写下去没人读的字段比没有更糟。删它的时候留了一句:「真要换数据源是另一张卡,
   * 到那时再加,**并且加的同一刻就要有人读它**」。
   *
   * 这一版就是那张卡,而这个字段现在有**两个**读它的人,各自有用例钉着:
   *
   * 1. `src/index.ts`:按它在 `gitSource` 与 `accountSource` 之间挑一个(server/projectSource.ts);
   * 2. `src/server/onboardingStages.ts`:按它决定 ②′ 那一段 `record_answer` 记的是
   *    「项目」还是「账号」(记账号就往工作目录写 `账号/<名>/账号.md`)。
   *
   * 两处都换了之后,内核假设表 A-1 那一整段(项目枚举 = 找 git 仓库)才真的挪得动。
   */
  project_source: ProjectSourceId
  /** 竖屏那一份模块布局。 */
  portrait: readonly LayoutModule[]
  /** 横屏那一份模块布局。 */
  landscape: readonly LayoutModule[]
  /** 模块标题。**只写与 DEFAULT_MODULE_TITLES 不同的那几个**,其余落回默认。 */
  module_titles: Readonly<Record<string, string>>
  /** 这个模板要往窗位清单里登记的应用。 */
  apps: readonly TemplateApp[]
  /** 这个模板要在工作目录下建的文件夹(**只建不删**)。 */
  folders: readonly TemplateFolder[]
  /**
   * 这个模板要在工作目录下种的**文件**(相对路径,2026-09-21 第八格「收藏网址」)。
   *
   * 与 `folders` 分开:folders 里每一条都会被 `mkdir -p`,把一个 `.md` 放进去
   * 会建出一个叫 `收藏网址.md` 的**目录**。
   * **只种不覆盖** —— 文件已经在了就一个字不动(那是他攒的东西,见 templateStore.makeFolders)。
   */
  files: readonly string[]
  /**
   * 看板列(= 事项按哪几个环节分列)。空数组 = 这个模板不换列,走既有的状态列。
   *
   * 落地方式见 server/templateStore.ts:**不动 Sprint / BoardModule 那三层**
   * (它们的根是 WorkbenchProject,运营模板这一版没有项目实体,凭空造一个 project_id
   * 会让卡片在既有看板上整个看不见 —— buildProjectTabs 只按真实 projects 出标签)。
   */
  board_lanes: readonly string[]
  onboarding: TemplateOnboarding
}

/** 模块标题的默认值(= 2026-09-20 之前 client/Workbench.tsx 的 MODULE_TITLES,一字不改 + 三个新模块)。 */
export const DEFAULT_MODULE_TITLES: Readonly<Record<string, string>> = {
  projects: '项目区',
  usage: '消耗数据',
  quota: '余额 / 额度',
  slot: '窗口槽',
  notes: '随手记',
  // 2026-10-23(卡「系统文件夹改成Graphify图谱」):这一格嵌 graphify 的 graph.html,改名「图谱」。
  files: '图谱',
  // 2026-09-21 新增的三个(运营模板用;做产品模板里它们默认收起,标题仍然要有)。
  todo: '待办事项',
  publish: '发布计划',
  review: '数据复盘',
  // 2026-10-12:运营同学那个待办小组件进了本体,只在自媒体模板里摆。
  today: '今天的待办',
}

/* ───────────────────────────── 做产品(vibecoding)───────────────────────────── */

/**
 * 竖屏那一份 —— **逐字搬自 2026-09-20 的 client/layout.ts DEFAULT_LAYOUT.modules**。
 *
 * 三行:行 0 左列项目区独占、右列消耗数据在上余额在下;行 1 窗位叠独占;
 * 行 2 随手记(40%)与系统文件夹(60%)并排。高度 34 + 42 + 24 = 100。
 */
const PRODUCT_PORTRAIT: readonly LayoutModule[] = [
  { id: 'projects', order: 0, basis_pct: 34, row: 0, col: 0, width_pct: 60 },
  { id: 'usage', order: 1, basis_pct: 22, row: 0, col: 1, width_pct: 40 },
  { id: 'quota', order: 2, basis_pct: 12, row: 0, col: 1, width_pct: 40 },
  { id: 'slot', order: 3, basis_pct: 42, row: 1 },
  { id: 'notes', order: 4, basis_pct: 24, row: 2, width_pct: 40 },
  { id: 'files', order: 5, basis_pct: 24, row: 2, width_pct: 60 },
]

/** 横屏那一份 —— **逐字搬自 2026-09-20 的 client/layout.ts DEFAULT_LANDSCAPE_MODULES**。 */
const PRODUCT_LANDSCAPE: readonly LayoutModule[] = [
  { id: 'slot', order: 0, basis_pct: 70, row: 0, col: 0, width_pct: 64 },
  { id: 'projects', order: 1, basis_pct: 70, row: 0, col: 1, width_pct: 36 },
  { id: 'usage', order: 2, basis_pct: 24, row: 1, width_pct: 25 },
  { id: 'quota', order: 3, basis_pct: 24, row: 1, width_pct: 25 },
  { id: 'notes', order: 4, basis_pct: 24, row: 1, width_pct: 25 },
  { id: 'files', order: 5, basis_pct: 24, row: 1, width_pct: 25 },
]

export const PRODUCT_TEMPLATE: WorkbenchTemplate = {
  id: 'product',
  name: '做产品',
  tagline: '写代码、带 Agent、盯仓库和额度 —— 现在这一套就是它。',
  project_word: '项目',
  project_empty_line: '还没有项目。引导里会帮你扫描已有的,或者从零建第一个。',
  // 现状:项目 = 扫描根下的 git 仓库。这一支一行代码都没动过(server/gitSource.ts)。
  project_source: 'git',
  portrait: PRODUCT_PORTRAIT,
  landscape: PRODUCT_LANDSCAPE,
  // 一个都不改:做产品模板的标题就是默认标题。
  module_titles: {},
  // 窗位清单**一个字不动**:基础七应用由 appsRegistry 的探测与用户自己的 enabled 决定,
  // 做产品模板不往里塞任何东西(2026-09-18「第一次用一切从空开始」那条还管着)。
  apps: [],
  folders: [],
  files: [],
  board_lanes: [],
  onboarding: {},
}

/* ───────────────────────────── 自媒体运营 ───────────────────────────── */

/**
 * 选题目录(2026-09-21 选题池)。工作目录下 `选题/<选题名>/`,**一条选题一个目录**。
 *
 * 与 `素材/选题池` 的区别(两个都留着,别混):
 * - `素材/选题池` 是**白板上七类素材库之一**,放的是"还没立项的点子"那类文件(Ben 的草图,逐字);
 * - `选题/<名>/` 是**一条已经进了选题池的选题自己的工作目录**,框架 / 初稿 / 定稿 / 素材清单 /
 *   发布包装 / 复盘六份产物加一个 `素材/` 子目录都落在这里(结构见 server/topicAssets.ts 顶上那段)。
 *
 * 这两个要不要合成一个,记在交接里等 Ben 拍。**这一版不动 `素材/选题池`**:
 * 它已经在用户盘上建出来了,改名或搬走要动人家已有的文件,那不是一张卡该顺手做的事。
 */
export const TOPIC_DIR = '选题'

/** 一条选题自己那个素材子目录叫什么(`选题/<名>/素材/`)。 */
export const TOPIC_ASSET_SUBDIR = '素材'

/**
 * `选题/<名>/` 底下那六份产物的文件名。**这里只是约定表,这张卡一份都不写** ——
 * 落产物的是 `feat/ops-skills` 那张卡的技能包,两边照这张表对齐(写进交接第三节)。
 * 键是六段进度里的哪一段该产出它。
 *
 * 2026-09-21 守卫卡起,**这就是那六个文件名的唯一定义处**:
 * `server/opsSkills.ts` 的技能产物路径直接从这里拼(`topicArtifact`),不再另写一份;
 * `tests/ops-skills-topic-files-guard.test.ts` 连技能文档里的路径一起钉着。
 *
 * 键用 `TopicStage` 而不是 `string`:六段漏一段、或者多一个拼错的段名,**tsc 当场红**。
 */
export const TOPIC_DELIVERABLE_FILES: Readonly<Record<TopicStage, string>> = {
  灵感: '框架.md',
  初稿: '初稿.md',
  准备素材: '素材清单.md',
  制作中: '定稿.md',
  发布: '发布包装.md',
  复盘: '复盘.md',
}

/** 素材管理那一格里的七个固定子文件夹(Ben 的运营草图,逐字)。 */
export const OPS_ASSET_DIRS = [
  '选题池', '脚本', '图片素材', '视频素材', '文件素材', '设计素材', '成片',
] as const

/**
 * 素材管理那一格的**第八格**:收藏网址(2026-09-21,白板第一节 Ben 草图上素材管理的第一项)。
 *
 * 它是一个**文件**,不是文件夹 —— 一行一条(标题 + 链接 + 备注),所以不能混进
 * `OPS_ASSET_DIRS`(那一份每一条都会被 `mkdir -p` 建成目录)。
 * 解析与追加在 `server/favoriteLinks.ts`,种文件在 `server/templateStore.ts`。
 */
export const OPS_FAVORITES_NAME = '收藏网址'
export const OPS_FAVORITES_REL = `素材/${OPS_FAVORITES_NAME}.md`

/**
 * 2026-10-23(分层二刀二):运营(自媒体)那一份模板**不再内置在本体里** —— 它的内容
 * (摆哪几格、叫什么、泳道、素材文件夹、附带应用、引导问法)整份搬进了用户层
 * `布局/ops.json`(起步层带一份缺省,`user-layer/起步/布局/`),本体只认格式
 * (parser 在 server/userLayer.ts,格式写进用户层目录里每次启动重写的 契约.md)。
 * 横屏 / 竖屏那两份排布、module_titles、八环节泳道 …… 的字面量都在那份 JSON 里,
 * 别回本体找。
 */

/**
 * 模板从哪来(2026-10-23,分层二刀二)。
 *
 * 本体只自带 product 一份;其余模板由**启动时**注入的 source 提供 —— 真机上来自
 * 用户层服务(读 `用户层/布局/*.json`),测试里可以注入任何来源。深调用方
 * (onboardingStages / productFeedback / http)拿不到服务实例,统一走这个
 * 模块级的一次性注册;`setWorkbenchTemplateSource` 只在启动接线时调一次。
 *
 * 缺省只有 product(与旧行为「认不出即 product」等价),所以没接线的环境
 * (展示台、手机、一大批用例)一行都不变。
 */
export interface WorkbenchTemplateSource {
  all: () => readonly WorkbenchTemplate[]
  byId: (id: string) => WorkbenchTemplate | undefined
}

let source: WorkbenchTemplateSource = {
  all: () => [PRODUCT_TEMPLATE],
  byId: (id: string) => (id === PRODUCT_TEMPLATE.id ? PRODUCT_TEMPLATE : undefined),
}

/** 启动接线时调一次(index.ts):模板从此从注入的来源出。 */
export function setWorkbenchTemplateSource(next: WorkbenchTemplateSource): void {
  source = next
}

/** 此刻认得的全部模板(本体自带 + 注入来源给的)。 */
export function allTemplates(): readonly WorkbenchTemplate[] {
  return source.all()
}

/** 认不出的 id 回 undefined,**不退回 product** —— 调用方要能分得开「没选过」和「选了个不认识的」。 */
export function templateById(id: string): WorkbenchTemplate | undefined {
  return source.byId(id)
}

/**
 * 一条模板文件夹路径合不合法。**只允许工作目录之下的相对路径**:
 * 不许以 `/` 开头(那是绝对路径,会建到工作目录外面)、不许含 `..`(同理)、
 * 不许空段。用户层布局 JSON 里写的 folders / files 也走这道闸(2026-10-23 从
 * server/templateStore.ts 搬来:布局 parser 在 server/userLayer.ts,那边引不了
 * templateStore;templateStore re-export 保持兼容)。
 *
 * 内置模板本来就不会写出违规的路径 —— 这道闸是给"以后有人加一条"准备的,
 * 而建目录这件事一旦越界就是在用户盘上乱建文件夹(9/4 那条纪律)。
 */
export function isSafeTemplateRel(rel: string): boolean {
  if (rel === '' || rel.startsWith('/') || rel.startsWith('~')) return false
  const parts = rel.split('/')
  return parts.length > 0 && parts.every(part => part !== '' && part !== '.' && part !== '..')
}

/** 这个模板下某个模块叫什么。模板没改就落回默认;两边都没有就原样回 id(不猜,同 layoutSnapshot)。 */
export function templateModuleTitle(template: WorkbenchTemplate | undefined, id: string): string {
  return template?.module_titles[id] ?? DEFAULT_MODULE_TITLES[id] ?? id
}

/** 给 client/layout.ts 用:做产品模板那两份排布就是"默认布局"。 */
export const DEFAULT_PORTRAIT_MODULES = PRODUCT_PORTRAIT
export const DEFAULT_LANDSCAPE_MODULES_DEF = PRODUCT_LANDSCAPE

/**
 * 一件事项属于哪个环节,记在 `TaskView.module_id` 上,值是 `lane:<环节名>`。
 *
 * ## 为什么用既有的 module_id,而不是新加一个字段
 *
 * 协议里已经有「这张卡属于哪条泳道」这件事(`TaskView.module_id` → `BoardModule`)。
 * 环节就是泳道,概念一模一样,再加一个 `stage` 字段等于同一件事有两个地方可以说。
 *
 * ## 为什么不真的去建 BoardModule
 *
 * `BoardModule` 挂 `Sprint`,`Sprint` 挂 `WorkbenchProject` —— 而 WorkbenchProject 是
 * **git 扫出来的**。运营模板这一版没有项目实体,凭空造一个 project_id 的后果不是"多一个
 * 空标签",而是**那些卡在既有看板上整个看不见**:`buildProjectTabs` 只按真实 projects 出
 * 标签,指向一个不存在的项目的卡连落脚的标签都没有。所以这一版把环节做成一个**约定好的
 * module_id 字符串**:既有看板把它当"归属链断了"接到「未归模块」那条泳道里(那条泳道存在的
 * 理由正是这个,见 boardModel.buildLanes 的注释),卡一张都不会消失;运营模板的「待办事项」
 * 那一格自己按这个前缀分列。
 *
 * 等「项目 ≠ git 仓库」那张卡把项目实体挪出内核之后,这一层可以换成真的 BoardModule ——
 * 换的时候 `module_id` 的值从 `lane:选题策划` 变成一个真 id,**存量数据要迁移**,
 * 这一点写在交接的内核假设表里。
 */
export const LANE_MODULE_PREFIX = 'lane:'

export function laneModuleId(lane: string): string {
  return `${LANE_MODULE_PREFIX}${lane}`
}

/** 反过来:一个 module_id 是哪个环节。不是这种约定的回 undefined(**不猜**)。 */
export function laneOfModuleId(moduleId: string | undefined): string | undefined {
  if (moduleId === undefined || !moduleId.startsWith(LANE_MODULE_PREFIX)) return undefined
  const lane = moduleId.slice(LANE_MODULE_PREFIX.length)
  return lane === '' ? undefined : lane
}
