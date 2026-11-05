/**
 * 「项目区这一格里的数据从哪来」这件事的接缝(2026-09-21)。
 *
 * ## 这张卡在补哪个洞
 *
 * `docs/交接-0921-布局模板与运营横屏.md` 第四节那张内核假设表,A-1 一整段(「项目 = git 仓库」
 * 的扫描与数据层)**一条都没挪**,第七节第 1 条写着「『账号』这一格的数据来源没换 —— 它仍然是
 * git 扫出来的项目」。这个文件就是那一条的工单。
 *
 * 同一份交接里还记了一笔:上一版写过一个 `project_source: 'git' | 'folder'` 字段,**因为没有
 * 任何一行代码读它而被删掉**。所以这一版的规矩是反过来的 —— 字段与读它的人**同一刻**落地:
 * `WorkbenchTemplate.project_source` 由 `src/index.ts` 在挑数据源时读,由
 * `src/server/onboardingStages.ts` 在挑 ②′ 记什么时读。两个读法都有用例钉着。
 *
 * ## 三个方法为什么是 list / summary / detail
 *
 * 不是新造的三分法,是把**既有 `projectsService.build()` 里本来就有的三步**拆出来:
 *
 * | 这个方法 | git 那一支原来是哪一段 | 账号那一支 |
 * |---|---|---|
 * | `list()`    | `findRepos` 逐扫描根找仓库 | `readdir <工作目录>/账号` |
 * | `summary()` | `scanRepo` 那六条 git 命令 | 读 `账号.md` + 数 `笔记/` + 问看板要在办事项数 |
 * | `detail()`  | **空的**(见下) | `账号.md` 里的定位 / 风格 / 人群 / 平台 / 开号日期 |
 *
 * `detail()` 在 git 那一支恒为空数组,这是**故意的、写明的**:项目行展开之后那两行
 * (「零散」「DDL」)来自 `projects.json`,是人写进去的东西,跟"这个项目是怎么被枚举出来的"
 * 没有关系,所以它不该被搬到数据源里来。account 那一支有真东西要说,才有了这个方法。
 *
 * ## 边界:这个接缝**不管**什么
 *
 * 合并(与 `projects.json` 里存的状态 / DDL / 零散对齐)、id 消歧、排序、节流缓存、
 * 写路径 —— 全都留在 `projectsService.ts`。数据源只回答"有哪些、每一个长什么样",
 * 一行都不落盘。换数据源不该顺手换掉"人写的状态存在哪儿"。
 */
import type { AccountSignals, ProjectDetailLine, ProjectSourceId, RepoSignals } from '../protocol.ts'

/*
 * `ProjectSourceId`(`'git' | 'accounts'`)在 `protocol.ts` 里 —— `src/templates.ts` 要拿它
 * 标 `WorkbenchTemplate.project_source` 的类型,而 templates.ts 是两边共用的那一层,
 * 不该 import `server/` 里的东西。模板里写错一个字 `npx tsc` 当场红
 * (同 templates.ts 头注那条「内置数据写错了不该靠运行时校验兜」)。
 */
export type { ProjectSourceId }

export interface ProjectSourceListing {
  /**
   * 每个项目实体在磁盘上的落点(git = 仓库路径;账号 = 账号文件夹路径)。
   *
   * **只给路径,不给 id 也不给名字**:id 消歧(两个扫描根下同名仓库、两个同名账号)
   * 与"名字用哪一段"是合并层的事,两个数据源各写一份必走漂 —— 那一份在
   * `projectsService.repoIdCandidates` / `pickRepoId`,一字没动。
   */
  paths: string[]
  /** 哪个根读不出来、为什么。**整块读不到不抛**,如实记一条,别的根照常(D13)。 */
  scan_errors: { root: string, reason: string }[]
}

/** 两个数据源都要回答的那几件事,与具体是哪一支无关。 */
export interface ProjectSummaryBase {
  /**
   * 最近一次活动的时刻(ISO)。git = 最后一次提交;账号 = 最近一条笔记。
   * 「状态过期」(人写下状态之后这个项目又动过,`projects.isStale`)按它判。拿不到就缺席。
   */
  last_activity_at?: string
  /**
   * 这一条够不够格折进项目区末尾那条灰色的「闲置线」。
   *
   * - git:`idle_days >= 7`(2026-08 起的既有口径,一字没改);
   * - 账号:**恒为 false**。「几天没动就折成一行灰字」是提交频率那套口径;
   *   刚被引导建出来、还一条笔记都没有的账号被折进去,等于事务官刚问完就把它藏了,
   *   而卡里明写着这一版要"当场在项目区出现"。真要给账号一条闲置口径,那是运营自己的事
   *   (多久不更新算停更),要 Ben 定,不在这张卡里拍。
   */
  idle_candidate: boolean
}

/**
 * 一条的「算」。**回的是数据不是文案** —— 文案在客户端 `client/portfolio.ts` 拼。
 * 两边各拼一半必走漂(同 protocol.scheduleRiskText 那条理由),而 git 那一支的那句
 * 「main · 10 未提交 · 1 worktree」今天就在客户端拼着,**这张卡一个字都不许动它**。
 */
export type ProjectSummary = ProjectSummaryBase & (
  | { kind: 'repo', signals: RepoSignals }
  | { kind: 'account', account: AccountSignals }
  /** 这一条读不出来(git rev-parse 失败 / 账号文件夹读不动)。原话进 `signal_error`,界面醒目地说"未接入"。 */
  | { kind: 'error', error: string }
)

export interface ProjectSource {
  readonly id: ProjectSourceId
  /**
   * 这个数据源的项目要不要参与「Codex 会话归属」(会话的 cwd 落在项目路径下就算它的)。
   *
   * - git:**要** —— 编码会话本来就是在仓库里开的;
   * - 账号:**不要**。账号文件夹里不会有人开编码会话,跑一遍的结果是把这台机器上所有
   *   会话都聚成「待归档:N 组 / M 条」挂在账号列表下面 —— 在运营机器上那是纯噪音,
   *   而且每次扫描要读几百个会话文件。
   *
   * 这个字段就是「额度 / 会话 = 编码 Agent」那条内核假设在项目区这一侧被挪出来的那半步。
   */
  readonly attributes_sessions: boolean
  list(): Promise<ProjectSourceListing>
  /**
   * 一条的「算」。`id` 是**合并层消歧之后**的项目 id(见 projectsService.pickRepoId)——
   * 数据源要按项目 id 去别处取数时用得上(账号那一支拿它问看板要「还有几件在办」)。
   * git 那一支不读它:仓库的一切都从路径直接问得出来。
   */
  summary(path: string, id: string): Promise<ProjectSummary>
  detail(path: string): Promise<readonly ProjectDetailLine[]>
}
