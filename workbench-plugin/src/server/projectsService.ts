/**
 * 项目区汇总服务(spec §6):把「算」(scan.ts)、「归属」(attribution.ts)、
 * 「状态/零散/DDL」(projects.ts 持久化)三层拼成 ProjectsState。
 *
 * 状态只有人确认一条写路径(confirmStatus),其余(setDdl/addRule/setLayout)也都是
 * load→改→save;任何写操作后使缓存失效,下次 getProjectsState 重扫。
 *
 * getProjectsState 有节流(R5):距上次成功构建不足 scanMinIntervalSec 直接回缓存,
 * 避免界面轮询把 git/文件系统打成拒绝服务。
 */
import type {
  DirRule,
  LayoutModule,
  ProjectDdl,
  ProjectDetailLine,
  ProjectsState,
  ProjectStatusLine,
  WorkbenchLayout,
  WorkbenchProject,
} from '../protocol.ts'
import { LAYOUT_MODULE_IDS, LEGACY_LAYOUT_MODULE_IDS } from '../protocol.ts'
import { attributeCwd, clusterPending, codexSessionCwds } from './attribution.ts'
import type { StoredProject } from './projects.ts'
import { isStale, loadProjectsFile, saveProjectsFile } from './projects.ts'
import { createGitSource } from './gitSource.ts'
import type { ProjectSource, ProjectSummary } from './projectSource.ts'
import { RISK_WINDOW_DAYS } from './scheduleRisk.ts'
import type { Exec, ScanRoot } from './scan.ts'
import { findRepos } from './scan.ts'

/** 按名字 / 目录找,最多回几个(电话里一口气念得完的数)。 */
export const LOCATE_MAX_MATCHES = 5

function repoNameOf(repoPath: string): string {
  return repoPath.split('/').filter(Boolean).at(-1) ?? repoPath
}

/**
 * I2(review 修复):按 LAYOUT_MODULE_IDS 过滤——读路径专用的最小版本,跟
 * http.ts 的 sanitizeModules(写路径,额外做 basis_pct clamp)是各自独立的两份,
 * 不互相 import(避免 server 服务层反过来依赖 http 传输层这种反向层级关系);
 * id 白名单本身共用同一个 protocol.ts 常量,不会走漂。
 *
 * 为什么读路径也要过一遍:此前只有 POST /layout 这条写路径校验 id,GET /state
 * 直接透传 getLayout() 的落盘原文——旧存档里残留的 `{id:'sessions',...}` 幽灵条目
 * (A3 退休 sessions 之前存下的布局)会原样发给客户端,`moveModule`/`toggleHidden`
 * 对着这条幽灵模块瞎换 order/hidden,界面上看着像按钮点了没反应(其实换的是一条
 * 不渲染的幽灵条目),要等下一次真的 POST /layout 才会被写路径的过滤自愈掉。
 * 读路径补上同一层后,幽灵条目在读的那一刻就没了,不用等一次写操作。
 */
/**
 * 2026-08-25 版面重排:legacy id(widgets)必须**放行**——它的下游紧接着就是
 * composeState 里的 migrateLayoutModules,那一步才把它换成 notes + files。在这里滤掉
 * 的话迁移永远看不见它,界面上表现为"底部两栏没出现,组件条也没了"。真幽灵(sessions,
 * 没有对应的新模块)仍然照旧滤掉。
 */
const READABLE_MODULE_IDS: readonly string[] = [...LAYOUT_MODULE_IDS, ...LEGACY_LAYOUT_MODULE_IDS]

function sanitizeStoredModules(modules: readonly LayoutModule[]): LayoutModule[] {
  return modules.filter(module => READABLE_MODULE_IDS.includes(module.id))
}

/**
 * 未存的仓库项目 id 候选序列,从最短到最不可能撞车:
 * 名字小写 → 并入父目录名 → 再并入上一级 → …… → 兜底为整条路径小写化去斜杠。
 * 两个扫描根下同名仓库(如 GitHub/Echo 与 WeChatProjects/Echo)靠这个消歧,
 * 不然 confirmStatus/setDdl 按 id find 会写错对象且没有任何报错(id 撞车是静默事故)。
 */
function repoIdCandidates(repoPath: string): string[] {
  const parts = repoPath.split('/').filter(Boolean)
  const name = repoNameOf(repoPath)
  const candidates: string[] = [name.toLowerCase()]
  const segments = [name]
  for (let i = parts.length - 2; i >= 0; i--) {
    segments.push(parts[i]!)
    candidates.push(segments.join('-').toLowerCase())
  }
  // 兜底:整条路径小写化、去斜杠,不同 repoPath 下必唯一。
  candidates.push(repoPath.toLowerCase().replace(/\//g, '-').replace(/^-+/, ''))
  return candidates
}

/** 从候选序列里挑第一个没被占用的 id,并让调用方把它记进 reserved 供后续仓库消歧。 */
function pickRepoId(repoPath: string, reserved: ReadonlySet<string>): string {
  for (const candidate of repoIdCandidates(repoPath)) {
    if (!reserved.has(candidate)) return candidate
  }
  // 候选序列最后一项已是全路径,理论不可达;留个保底避免返回 undefined。
  return repoPath.toLowerCase()
}

/** 默认扫描根(spec §6):按本机实测分布,GitHub 深1、Documents/Codex 深2、WeChatProjects 深1;
 * `~/esp`、`~/thinksmart-view` 不在列(SDK 非项目)。 */
export function DEFAULT_SCAN_ROOTS(home: string): ScanRoot[] {
  return [
    { path: `${home}/Documents/GitHub`, depth: 1 },
    { path: `${home}/Documents/Codex`, depth: 2 },
    { path: `${home}/WeChatProjects`, depth: 1 },
  ]
}

export interface ProjectsServiceOptions {
  file: string
  exec: Exec
  listDir: (d: string) => Promise<string[]>
  isRepo: (d: string) => Promise<boolean>
  codexHome: string
  codexDeps: Parameters<typeof codexSessionCwds>[1]
  home: string
  now?: () => number
  /** 两次真实重扫之间的最短间隔,秒。默认 30(R5)。 */
  scanMinIntervalSec?: number
  /**
   * 缺省用 DEFAULT_SCAN_ROOTS(home)。测试传固定值,不随生产 home 目录实况漂移。
   *
   * 2026-09-17(卡 C,扫描根可配):也可以传一个**函数**。生产走这一条——每次真扫之前
   * 现问一遍 app.json 的 scan_roots,Ben 在设置里改完不必重启 DSH,下一次扫描就是新根。
   * 存成数组(改造前的样子)等于"起服务时取一次",正是"改了没反应"这类 bug 的出处。
   */
  scanRoots?: readonly ScanRoot[] | (() => readonly ScanRoot[] | Promise<readonly ScanRoot[]>)
  /**
   * 「项目这一格里的数据从哪来」(2026-09-21,见 server/projectSource.ts)。
   *
   * **每次真扫现问一遍**(同 scanRoots 那条):当前模板是运行中能换的,起服务时取一次
   * 等于"切了模板要重启才换数据源"。
   *
   * 这个函数缺席、或者它回 `undefined`,都是**用下面那份 git 数据源**(现状)——
   * 所以既有那一大批用例与老接线一个字都不用改,接线中途(模板服务还没建起来)也有个
   * 说得过去的答案。
   */
  source?: () => ProjectSource | undefined
  /**
   * 项目区能不能去扫他的目录(2026-09-23 统筹从零重装自跑:新机器 18:27 起项目区就把扫描根下
   * 13 个仓库全扫了,每 30 秒刷新 —— 那时引导还没做完、他也没点头让看目录)。
   *
   * 回 `undefined` = 能扫;回一句人话 = 不能扫,项目区只列**已经落盘的**项目(引导里他亲口交的那一个),
   * 不列目录、不读会话、不自动建条目,界面上照这句话如实说(`ProjectsState.scan_blocked`)。
   * **只管 git 那一支**:账号数据源读的是工作目录下的 `账号/`,那是引导自己写出来的,不是去翻他的硬盘。
   * 缺席 = 能扫(既有用例与老接线不变)。
   */
  scanGate?: () => Promise<string | undefined> | string | undefined
}

export interface ProjectsService {
  getProjectsState(): Promise<ProjectsState>
  confirmStatus(id: string, text: string): Promise<boolean>
  setDdl(id: string, ddl: ProjectDdl | null): Promise<boolean>
  addRule(rule: DirRule): Promise<void>
  getLayout(): Promise<WorkbenchLayout | undefined>
  setLayout(layout: WorkbenchLayout): Promise<void>
  /**
   * 把扫描缓存作废,下一次 getProjectsState 重扫(2026-09-17 卡 C)。
   *
   * 四条写路径内部本来就会作废缓存,但"改了扫描根"这件事发生在这个服务**外面**
   * (app.json),它自己看不见;没有这一手的话,改完最多还要等一个节流周期(30 秒)
   * 才看得到变化——而那 30 秒里界面显示的是旧根扫出来的项目,像是没生效。
   */
  invalidateScanCache(): void
  /**
   * 扫描进度(2026-09-23,引导里「扫描要有进度」)。纯内存,随时可读,不触发扫描。
   * 界面(进度条 / 粒子「工作中」)轮询 `GET /onboarding/scan/status` 拿的就是它。
   */
  scanProgress?: () => ScanProgress
  /**
   * **只按名字 / 路径找一个项目**,不做全量扫描(2026-09-23,维护者:「我只想录工作台这一个」)。
   *
   * 只列扫描根下的目录、看是不是 git 仓库(与 findRepos 同一套),**不跑任何 git 命令、不读会话**。
   * `query` 以 `/` 或 `~` 开头当路径直接认;否则按目录名比(不分大小写、忽略空格 - _)。
   */
  locate?: (query: string) => Promise<{ matches: { name: string, path: string }[], errors: { root: string, reason: string }[] }>
  /**
   * **引导里她主动发起的那一次全量扫描**(2026-09-23)。与项目区那一份分开:
   * - 不看 `scanGate` 的「引导没做完」(引导里他说「你帮我找找」时本来就没做完;授权那道门在 http 层);
   * - **不写项目区的缓存** —— 不然项目区借着这一次就把整份仓库清单摆出来了,等于绕过了门;
   * - 只有它(和 locate)推进 `scanProgress`,项目区自己的刷新不再让引导页显示「在扫」。
   */
  scanForOnboarding?: () => Promise<ProjectsState>
  /**
   * 把引导里他亲口交的那个项目**落成项目区的那一条**(2026-09-23:引导录的「工作台」与项目区自动建的
   * desktop-workbench 在索引里是两行)。同一个 repoPath 已经有条目就只改名字、沿用它的 id;
   * 没有就新建一条(id 按与扫描同一套候选规则挑)。回那一条的 id。
   */
  adopt?: (input: { name: string, path: string }) => Promise<{ id: string }>
  /**
   * 此刻生效的扫描根(绝对路径,2026-09-24 已有项目拉齐)。读项目的路径白名单「扫描根之下」认的就是它 ——
   * 与 locate / 全量扫描问的是同一份(每次现问,设置里改了不必重启)。
   */
  scanRootPaths?: () => Promise<readonly string[]>
  /**
   * 项目区**已经录了**的仓库路径(projects.json 的 repoPath,2026-09-24)。读项目的白名单认它;
   * 只读落盘那一份,**不扫描、不跑 git**。
   */
  knownPaths?: () => Promise<readonly string[]>
  /**
   * 「正在读 X 的说明」那一段也算进引导的扫描进度(2026-09-24):读的那几百毫秒里
   * `scanProgress()` 是 `{ scanning: true, phase: 'read', current: X }`;读完 `{ scanning: false, last_read: X, finished_at }`,
   * 两端据此显示那一行、球进工作态(很快的也至少挂 0.6 秒)。
   */
  trackRead?: <T>(name: string, run: () => Promise<T>) => Promise<T>
}

/** 扫描进度。`phase` 缺席 = 没在扫。 */
export interface ScanProgress {
  /** 正在扫。 */
  scanning: boolean
  /**
   * list = 在扫描根里找仓库;repos = 逐个读仓库;read = 读一个项目的说明和最近记录(2026-09-24,已有项目拉齐)。
   * 认不得 read 的老界面照「正在找你的项目… <current>」显示,不出错。
   */
  phase?: 'list' | 'repos' | 'read'
  /** 已读完几个仓库(phase=repos 时有意义)。 */
  done: number
  /** 一共几个仓库;list 阶段还不知道,缺席。 */
  total?: number
  /** 正在读的那一个(目录名,不是绝对路径;phase=read 时是项目名)。 */
  current?: string
  /**
   * 上一轮是「读一个项目」,读的是哪个(只在 scanning:false 时有)。读很快、落在两次轮询之间时,
   * 界面凭它补显示「正在读 X 的说明…」那一行,而不是笼统的「正在找你的项目…」。
   */
  last_read?: string
  /** 这一轮什么时候开始的(ISO)。 */
  started_at?: string
  /** 上一轮什么时候扫完的(ISO)。 */
  finished_at?: string
}

/** 目录名比较键:不分大小写、去掉空格 - _ . 与中英文标点、引号。 */
export function projectNameKey(text: string): string {
  return text.toLowerCase().replace(/[\s\-_.·,，、。:;；:!！?？"'“”‘’「」『』()（）《》<>]/g, '')
}

/**
 * 常见中英对照(2026-09-24 真机第五轮):他说「工作台」,仓库叫 desktop-workbench。
 * 只放**这台产品线里真出现过的说法**,不做通用翻译 —— 翻错比找不到更糟(会把别的仓库念成他的)。
 */
export const PROJECT_NAME_ALIASES: Readonly<Record<string, readonly string[]>> = {
  工作台: ['workbench'],
  事务官: ['butler'],
  管家: ['butler'],
  官网: ['site', 'website'],
  网站: ['site', 'website', 'web'],
  插件: ['plugin'],
  展示台: ['display'],
  中转: ['relay'],
  手机: ['app', 'mobile'],
  笔记: ['notes', 'note'],
}

/**
 * 他说的一句 → 几个比较键(2026-09-24)。一句里可能报了两个名字(「工作台,ben-dsh-workbench」)、
 * 可能夹着中文说法(「工作台」→ workbench),可能把英文拆开念(「work bench」→ workbench)。
 * 每一段各出一个键,中文说法再各出一个英文键。短于 2 个字的键不要(一个字母什么都能「包含」)。
 */
export function projectQueryKeys(query: string): string[] {
  const parts = query.split(/[,，、/;；|]|\s+(?:or|或者?|还是)\s+|或者?|还是/).map(part => part.trim()).filter(part => part !== '')
  const keys = new Set<string>()
  for (const part of [query, ...parts]) {
    const key = projectNameKey(part)
    if (key.length >= 2) keys.add(key)
    let translated = key
    for (const [zh, ens] of Object.entries(PROJECT_NAME_ALIASES)) {
      if (!translated.includes(zh)) continue
      translated = translated.split(zh).join(ens[0] as string)
      for (const en of ens) {
        const alt = key.split(zh).join(en)
        if (alt.length >= 2) keys.add(alt)
      }
    }
    if (translated.length >= 2) keys.add(translated)
  }
  return [...keys]
}

/**
 * 一个仓库名与他说的那句有多像:3 = 一模一样(归一之后);2 = 仓库名里包含他说的(workbench ⊂ desktopworkbench);
 * 1 = 他说的里包含仓库名(「ben-dsh-workbench 那个」⊃ bendshworkbench);0 = 不像。
 * 「包含」要求被包含的那一方至少 4 个字符(英文)或 2 个汉字,免得「app」把一半仓库都拉进来。
 */
export function projectNameScore(repoName: string, queryKeys: readonly string[]): number {
  const repo = projectNameKey(repoName)
  if (repo === '') return 0
  const longEnough = (key: string): boolean => /[\u4e00-\u9fff]/.test(key) ? key.length >= 2 : key.length >= 4
  let best = 0
  for (const key of queryKeys) {
    if (key === repo) return 3
    if (repo.includes(key) && longEnough(key)) best = Math.max(best, 2)
    else if (key.includes(repo) && longEnough(repo)) best = Math.max(best, 1)
  }
  return best
}

export function createProjectsService(opts: ProjectsServiceOptions): ProjectsService {
  const now = opts.now ?? (() => Math.floor(Date.now() / 1000))
  const scanMinIntervalSec = opts.scanMinIntervalSec ?? 30
  const scanRootsOption = opts.scanRoots ?? DEFAULT_SCAN_ROOTS(opts.home)
  /** 每次真扫现问一遍(传函数时);传数组就是固定值。 */
  const currentScanRoots = async (): Promise<readonly ScanRoot[]> =>
    typeof scanRootsOption === 'function' ? await scanRootsOption() : scanRootsOption

  // 没指定数据源就是 git —— 现状(见 server/gitSource.ts,函数体是从下面 build() 里原样搬走的)。
  const gitSource = createGitSource({
    exec: opts.exec,
    listDir: opts.listDir,
    isRepo: opts.isRepo,
    scanRoots: currentScanRoots,
    recentDays: RISK_WINDOW_DAYS,
    now,
  })
  const currentSource = (): ProjectSource => opts.source?.() ?? gitSource

  let cache: { at: number, state: ProjectsState } | undefined
  // single-flight（2026-08-21 真机实测补的）：build() 是四个 sampler 里最重的一个
  // （findRepos 逐仓 git、codexSessionCwds 497 个文件），冷启动时展示台按 1 秒轮询，
  // 重启后第一秒内的并发 GET /state 会各自发现 cache 是空的、各自起一轮全量扫描——
  // 实测重启后首个 /state 超过 5 秒才响应。把"正在构建"的那次 build() 存成共享 promise，
  // 并发调用者共享它，不各自重开一轮扫描。
  let inFlight: Promise<ProjectsState> | undefined
  /** 只记引导 / 她主动发起的那一次扫描(scanForOnboarding 与 locate)。项目区自己的刷新不碰它。 */
  let progress: ScanProgress = { scanning: false, done: 0 }
  let onboardingInFlight: Promise<ProjectsState> | undefined

  // 写队列(promise 链):四条写路径全部过这里,严格排成一条队——
  // confirmStatus/setDdl/addRule/setLayout 都是 load→改→save,不排队并发跑
  // 会两次都读到旧文件,后写的把先写的覆盖掉(丢更新)。
  // 任务里的 load 要等轮到自己执行时才发生(不是入队那一刻),这样每个任务
  // 读到的都是它前一个任务写完之后的最新文件。
  let writeQueue: Promise<void> = Promise.resolve()
  function enqueueWrite<T>(task: () => Promise<T>): Promise<T> {
    const result = writeQueue.then(task)
    // 吞掉错误再接回队列:一次写失败不该把后续写永久卡住。
    writeQueue = result.then(() => undefined, () => undefined)
    return result
  }

  function invalidate(): void {
    cache = undefined
  }

  async function build(options: { track: boolean, gate: boolean }): Promise<ProjectsState> {
    if (!options.track) return await buildInner(options.gate, () => {})
    progress = {
      scanning: true,
      phase: 'list',
      done: 0,
      started_at: new Date(now() * 1000).toISOString(),
      ...(progress.finished_at === undefined ? {} : { finished_at: progress.finished_at }),
    }
    try {
      return await buildInner(options.gate, (patch) => { progress = { ...progress, ...patch } })
    }
    finally {
      progress = {
        scanning: false,
        done: progress.done,
        ...(progress.total === undefined ? {} : { total: progress.total }),
        finished_at: new Date(now() * 1000).toISOString(),
      }
    }
  }

  /** 门关着时:只列已经落盘的项目(他亲口交的),不列目录、不读会话、不跑 git。 */
  async function blockedState(note: string): Promise<ProjectsState> {
    const stored = await loadProjectsFile(opts.file)
    const projects: WorkbenchProject[] = stored.projects.map(p => ({
      id: p.id,
      name: p.name,
      stage: p.stage,
      ...(p.repoPath === undefined ? {} : { path: p.repoPath }),
      ...(p.status === undefined ? {} : { status: { ...p.status, stale: false } }),
      ...(p.ddl === undefined ? {} : { ddl: p.ddl }),
      links: p.links,
      session_count: 0,
      idle: false,
      // 落盘的就是他确认过的(2026-09-25):项目区只排这几个。
      confirmed: true as const,
    }))
    return {
      projects,
      pending: [],
      scan_errors: [],
      scanned_at: new Date(now() * 1000).toISOString(),
      scan_blocked: note,
    }
  }

  async function gateNote(): Promise<string | undefined> {
    if (opts.scanGate === undefined) return undefined
    if (currentSource() !== gitSource) return undefined
    try { return await opts.scanGate() }
    // 门本身读坏了(授权表这一瞬间被写坏):按关着算 —— 宁可项目区少一拍,也不在没授权时翻他的目录。
    catch { return '暂时读不到授权表,先不看你的项目目录' }
  }

  async function buildInner(gate: boolean, report: (patch: Partial<ScanProgress>) => void): Promise<ProjectsState> {
    if (gate) {
      const note = await gateNote()
      if (note !== undefined) return await blockedState(note)
    }
    const source = currentSource()
    const stored = await loadProjectsFile(opts.file)
    const nowSec = now()
    const scanErrors: { root: string, reason: string }[] = []

    // 1) 问数据源要「有哪些」。git 那一支是逐扫描根找仓库,账号那一支是读工作目录下的
    //    `账号/`;一个根读不到只记那个根的错、其余照常(D13)这条规矩在数据源里面。
    //    路径的确定性排序也在数据源里(顺序一变 id 消歧就漂,理由见 gitSource.list)。
    const listed = await source.list()
    /**
     * 每个项目实体在盘上的落点。**名字是 `entryPaths` 不是 `repoPaths`**:
     * 它在 git 那一支里是仓库路径,在账号那一支里是账号文件夹路径。
     * (落盘那一侧的字段仍然叫 `StoredProject.repoPath` —— 改它要一次存量迁移,
     * 记在交接「没做的」里。)
     */
    const entryPaths = listed.paths
    scanErrors.push(...listed.scan_errors)

    // 2) 会话归属:**只有说自己要参与归属的数据源才跑这一段**(2026-09-21)。
    //    账号数据源不参与 —— 账号文件夹里不会有人开编码会话,跑一遍的结果是把机器上
    //    所有会话都聚成「待归档」挂在账号下面,而且每轮要读几百个会话文件。
    const sessionCountByRepo = new Map<string, number>()
    const sessionCountByProjectId = new Map<string, number>()
    const pendingItems: { cwd: string, at?: string }[] = []

    if (source.attributes_sessions) {
      // Codex 会话归属:仓库前缀命中累加 session_count;project 规则命中按 projectId 累加;
      // 都推不出的进 pending 聚类(D5,绝不猜)。
      const codexResult = await codexSessionCwds(opts.codexHome, opts.codexDeps)
      if (codexResult.errors > 0) {
        scanErrors.push({ root: opts.codexHome, reason: `${codexResult.errors} 个会话文件解析失败` })
      }
      for (const item of codexResult.items) {
        // 这一支只有 git 数据源会跑,所以这里的 entryPaths 确实是仓库路径。
        const attribution = attributeCwd(item.cwd, entryPaths, stored.rules)
        if (attribution.kind === 'repo') {
          sessionCountByRepo.set(attribution.repoPath, (sessionCountByRepo.get(attribution.repoPath) ?? 0) + 1)
        }
        else if (attribution.kind === 'rule') {
          if (attribution.rule.action === 'project' && attribution.rule.projectId !== undefined) {
            const pid = attribution.rule.projectId
            // 已知取舍(Minor,暂不修):这里不校验 pid 对应的项目是否存在。
            // 若规则指向的 projectId 从未落盘或已被删除,这份计数会静默丢失——
            // 既不报错也不进 pending,界面上就是"少几个会话",留给后续任务处理。
            sessionCountByProjectId.set(pid, (sessionCountByProjectId.get(pid) ?? 0) + 1)
          }
          // ignore / not_mine:一次生效后既不算会话数也不进 pending(D7)。
        }
        else {
          pendingItems.push(item)
        }
      }
    }
    const pending = clusterPending(pendingItems, opts.home)

    // 4) 与已存的 StoredProject 合并:repoPath 匹配的仓库项目用 stored 的状态/DDL/链接,
    //    未存的仓库先以「待整理」出现(D4,不做手工空壳台账);无仓库的 stored 项目(如市场调研)照留。
    const storedByRepoPath = new Map<string, StoredProject>()
    for (const p of stored.projects) {
      if (p.repoPath !== undefined) storedByRepoPath.set(p.repoPath, p)
    }
    const usedStoredIds = new Set<string>()
    // id 消歧的占用登记:先占满所有已落盘 id(它们是固定值,不能被新分配的 id 撞上)。
    const reservedIds = new Set(stored.projects.map(p => p.id))

    const projects: WorkbenchProject[] = []
    let doneCount = 0
    report({ phase: 'repos', total: entryPaths.length, done: 0 })
    for (const entryPath of entryPaths) {
      report({ current: repoNameOf(entryPath) })
      const storedProject = storedByRepoPath.get(entryPath)
      let id: string
      if (storedProject !== undefined) {
        id = storedProject.id
      }
      else {
        // 未存的:按候选序列挑一个没被占用的 id,立刻登记,防止同一批里下一个同名的撞上。
        id = pickRepoId(entryPath, reservedIds)
        reservedIds.add(id)
      }
      const name = storedProject?.name ?? repoNameOf(entryPath)

      // 3) 问数据源要这一条的「算」。**id 先算出来再问** —— 账号那一支要拿 id 去看板
      //    那边取「还有几件在办」(git 那一支不读它)。
      const summary: ProjectSummary = await source.summary(entryPath, id)
      const detail = await source.detail(entryPath)
      const lastActivityAt = summary.last_activity_at

      const status: ProjectStatusLine | undefined = storedProject?.status === undefined ? undefined : {
        ...storedProject.status,
        stale: isStale(storedProject.status.updated_at, lastActivityAt),
      }

      if (storedProject !== undefined) usedStoredIds.add(storedProject.id)

      const sessionCount = (sessionCountByRepo.get(entryPath) ?? 0) + (sessionCountByProjectId.get(id) ?? 0)
      // 「已经落盘的项目不进闲置线」这条不变;够不够格由数据源说(git:7 天没提交)。
      const idle = storedProject === undefined && summary.idle_candidate

      doneCount += 1
      report({ done: doneCount })
      projects.push({
        id,
        name,
        stage: storedProject?.stage ?? '待整理',
        path: entryPath,
        ...(summary.kind === 'repo' ? { signals: summary.signals } : {}),
        ...(summary.kind === 'account' ? { account: summary.account } : {}),
        ...(summary.kind === 'error' ? { signal_error: summary.error } : {}),
        ...(detail.length === 0 ? {} : { detail: detail as readonly ProjectDetailLine[] }),
        ...(status === undefined ? {} : { status }),
        ...(storedProject?.ddl === undefined ? {} : { ddl: storedProject.ddl }),
        links: storedProject?.links ?? [],
        session_count: sessionCount,
        idle,
        // 在 projects.json 里 = 他确认过的(2026-09-25);扫到而没落盘的不带,项目区收进「其他仓库」。
        // 账号那一支(运营模板)不是「扫到的」:工作目录下 `账号/` 里的每一个都是她自己建的,一律算她的。
        ...(storedProject === undefined && source === gitSource ? {} : { confirmed: true as const }),
      })
    }

    // 无仓库对应的 stored 项目(市场调研之类):没有「算」行,不算 idle,session_count 只来自规则归属。
    for (const p of stored.projects) {
      if (usedStoredIds.has(p.id)) continue
      const status: ProjectStatusLine | undefined = p.status === undefined ? undefined : {
        ...p.status,
        stale: isStale(p.status.updated_at, undefined),
      }
      projects.push({
        id: p.id,
        name: p.name,
        stage: p.stage,
        ...(p.repoPath === undefined ? {} : { path: p.repoPath }),
        ...(status === undefined ? {} : { status }),
        ...(p.ddl === undefined ? {} : { ddl: p.ddl }),
        links: p.links,
        session_count: sessionCountByProjectId.get(p.id) ?? 0,
        idle: false,
        confirmed: true as const,
      })
    }

    return {
      projects,
      pending,
      scan_errors: scanErrors,
      scanned_at: new Date(nowSec * 1000).toISOString(),
    }
  }

  async function getProjectsState(): Promise<ProjectsState> {
    // 上一份是「门关着」的那一份:每次都现问一遍门(读一下授权表的 mtime,很便宜)。
    // 门开了就当没有缓存,当场扫 —— 他刚点头,不该再等 30 秒才看到自己的项目。
    if (cache?.state.scan_blocked !== undefined && inFlight === undefined && (await gateNote()) === undefined) {
      cache = undefined
    }
    return await getProjectsStateInner()
  }

  function getProjectsStateInner(): Promise<ProjectsState> {
    const nowSec = now()
    if (cache !== undefined) {
      // stale-while-revalidate(2026-08-31 风暴修复,标签时灵时不灵一案):节流到期的读
      // 原来会干等一整轮 build()——真机上 findRepos+逐仓 git+codexSessionCwds 一轮 ~6 秒,
      // GET /state 挂着它,页面每 30 秒瞎 6 秒。改成立即回旧缓存、重扫放后台:
      // 项目区的数字迟一轮(≤30 秒)无所谓,页面卡 6 秒是每次都疼。
      // 只有"缓存过期"这条路走后台;冷启动(无缓存)和写路径 invalidate 之后仍然
      // 等真数据——写完必须立刻读到自己刚写的东西,那两处语义不动。
      if (nowSec - cache.at >= scanMinIntervalSec && inFlight === undefined) {
        inFlight = build({ track: false, gate: true })
          .then((state) => {
            cache = { at: nowSec, state }
            return state
          })
          .finally(() => { inFlight = undefined })
        // 后台那轮失败只是这次没刷成,旧缓存继续用;不留未处理拒绝。
        inFlight.catch(() => {})
      }
      return Promise.resolve(cache.state)
    }
    if (inFlight !== undefined) return inFlight

    const promise = build({ track: false, gate: true })
      .then((state) => {
        cache = { at: nowSec, state }
        return state
      })
      .finally(() => { inFlight = undefined })
    inFlight = promise
    return promise
  }

  function confirmStatus(id: string, text: string): Promise<boolean> {
    return enqueueWrite(async () => {
      const data = await loadProjectsFile(opts.file)
      let project = data.projects.find(p => p.id === id)
      if (project === undefined) {
        // D4「顺手创建」:id 是本次扫描出但尚未落盘的仓库,先补一条 StoredProject 再写状态。
        const scanned = (await getProjectsState()).projects.find(p => p.id === id)
        if (scanned === undefined) return false
        project = {
          id: scanned.id,
          name: scanned.name,
          stage: scanned.stage,
          ...(scanned.path === undefined ? {} : { repoPath: scanned.path }),
          links: [...scanned.links],
        }
        data.projects.push(project)
      }
      project.status = {
        text,
        review: 'confirmed',
        author: '你',
        updated_at: new Date(now() * 1000).toISOString(),
      }
      await saveProjectsFile(opts.file, data)
      invalidate()
      return true
    })
  }

  function setDdl(id: string, ddl: ProjectDdl | null): Promise<boolean> {
    return enqueueWrite(async () => {
      const data = await loadProjectsFile(opts.file)
      const project = data.projects.find(p => p.id === id)
      if (project === undefined) return false
      if (ddl === null) delete project.ddl
      else project.ddl = ddl
      await saveProjectsFile(opts.file, data)
      invalidate()
      return true
    })
  }

  function addRule(rule: DirRule): Promise<void> {
    return enqueueWrite(async () => {
      const data = await loadProjectsFile(opts.file)
      data.rules.push(rule)
      await saveProjectsFile(opts.file, data)
      invalidate()
    })
  }

  async function getLayout(): Promise<WorkbenchLayout | undefined> {
    const layout = (await loadProjectsFile(opts.file)).layout
    // I2(review 修复):落盘原文可能带着旧布局残留的幽灵模块 id(比如 A3 退休掉的
    // 'sessions')——读的时候就过滤掉,不必等下一次 POST /layout 才自愈。
    if (layout === undefined) return undefined
    // 2026-09-18 横屏布局:横屏那一份走同一条白名单过滤。**不放行 legacy id**——
    // 下游的 migrateLayoutModules 只跑在竖屏那一份上(横屏是写死的五个区域,没有
    // "组件条拆成两栏"这种迁移可言),放行了就真成了一条永远不会被换掉的幽灵条目。
    // 横屏分支是 2026-09-18 才有的,它里面本来也不可能存在退休前的 id。
    const landscape = layout.landscape === undefined
      ? undefined
      : {
          ...layout.landscape,
          modules: layout.landscape.modules.filter(
            module => (LAYOUT_MODULE_IDS as readonly string[]).includes(module.id),
          ),
        }
    return {
      ...layout,
      modules: sanitizeStoredModules(layout.modules),
      ...(landscape === undefined ? {} : { landscape }),
    }
  }

  function setLayout(layout: WorkbenchLayout): Promise<void> {
    return enqueueWrite(async () => {
      const data = await loadProjectsFile(opts.file)
      data.layout = layout
      await saveProjectsFile(opts.file, data)
      invalidate()
    })
  }

  async function locate(query: string): Promise<{ matches: { name: string, path: string }[], errors: { root: string, reason: string }[] }> {
    const text = query.trim()
    const errors: { root: string, reason: string }[] = []
    if (text === '') return { matches: [], errors }
    if (text.startsWith('/') || text.startsWith('~')) {
      const path = (text.startsWith('~') ? `${opts.home}${text.slice(1)}` : text).replace(/\/+$/, '')
      try {
        if (await opts.isRepo(path)) return { matches: [{ name: repoNameOf(path), path }], errors }
        // 2026-09-24:他报的是**放仓库的那个目录**(「文稿里的 GitHub」)而不是仓库本身 —— 列它下面一层的仓库给他挑。
        const under = await findRepos({ path, depth: 1 }, opts.listDir, opts.isRepo)
        return { matches: under.slice(0, LOCATE_MAX_MATCHES).map(one => ({ name: repoNameOf(one), path: one })), errors }
      }
      catch (err) { errors.push({ root: path, reason: String(err) }) }
      return { matches: [], errors }
    }
    const keys = projectQueryKeys(text)
    const scored: { name: string, path: string, score: number }[] = []
    // 按名字找也是她替他去看了一眼目录:算进「引导的那次扫描」的进度(只有 list 这一段,没有总数)。
    progress = {
      scanning: true,
      phase: 'list',
      done: 0,
      started_at: new Date(now() * 1000).toISOString(),
      ...(progress.finished_at === undefined ? {} : { finished_at: progress.finished_at }),
    }
    try {
      for (const root of await currentScanRoots()) {
        try {
          for (const path of await findRepos(root, opts.listDir, opts.isRepo)) {
            const score = projectNameScore(repoNameOf(path), keys)
            if (score > 0 && !scored.some(m => m.path === path)) scored.push({ name: repoNameOf(path), path, score })
          }
        }
        catch (err) { errors.push({ root: root.path, reason: String(err) }) }
      }
    }
    finally {
      progress = { scanning: false, done: 0, finished_at: new Date(now() * 1000).toISOString() }
    }
    // 一模一样的有就只要它们;没有才轮到「包含」的(workbench → desktop-workbench)。
    const top = scored.reduce((max, one) => Math.max(max, one.score), 0)
    const matches = scored.filter(one => one.score === top).slice(0, LOCATE_MAX_MATCHES).map(({ name, path }) => ({ name, path }))
    return { matches, errors }
  }

  async function trackRead<T>(name: string, run: () => Promise<T>): Promise<T> {
    progress = {
      scanning: true,
      phase: 'read',
      done: 0,
      current: name,
      started_at: new Date(now() * 1000).toISOString(),
      ...(progress.finished_at === undefined ? {} : { finished_at: progress.finished_at }),
    }
    try { return await run() }
    finally {
      progress = { scanning: false, done: 0, finished_at: new Date(now() * 1000).toISOString(), last_read: name }
    }
  }

  async function scanRootPaths(): Promise<readonly string[]> {
    return (await currentScanRoots()).map(root => root.path)
  }

  async function knownPaths(): Promise<readonly string[]> {
    const stored = await loadProjectsFile(opts.file)
    return stored.projects.flatMap(project => project.repoPath === undefined || project.repoPath === '' ? [] : [project.repoPath])
  }

  function scanForOnboarding(): Promise<ProjectsState> {
    if (onboardingInFlight !== undefined) return onboardingInFlight
    const promise = build({ track: true, gate: false }).finally(() => { onboardingInFlight = undefined })
    onboardingInFlight = promise
    return promise
  }

  function adopt(input: { name: string, path: string }): Promise<{ id: string }> {
    return enqueueWrite(async () => {
      const data = await loadProjectsFile(opts.file)
      const path = input.path.replace(/\/+$/, '')
      let project = data.projects.find(p => p.repoPath === path)
        ?? data.projects.find(p => p.repoPath === undefined && p.name === input.name)
      if (project === undefined) {
        const id = pickRepoId(path, new Set(data.projects.map(p => p.id)))
        project = { id, name: input.name, stage: '待整理', repoPath: path, links: [] }
        data.projects.push(project)
      }
      else {
        project.name = input.name
        project.repoPath = path
      }
      await saveProjectsFile(opts.file, data)
      invalidate()
      return { id: project.id }
    })
  }

  return {
    getProjectsState, confirmStatus, setDdl, addRule, getLayout, setLayout, invalidateScanCache: invalidate,
    scanProgress: () => ({ ...progress }),
    locate,
    scanForOnboarding,
    adopt,
    scanRootPaths,
    knownPaths,
    trackRead,
  }
}
