/**
 * 引导流程的阶段机(2026-09-15,docs/设计-引导流程.md v2;决策记录 2026-09-11 第 2、5 条)。
 *
 * 状态在哪:`~/.dsh/workbench/onboarding.json`(阶段、已答项、时间、会话 id),外加用户记忆文件
 * 头部一行「引导进度」。每一步问什么:onboardingStages.ts 的种子句与清单。答了写哪:
 * 用户文件 / 项目文件 / 授权.md / ~/.dsh/AGENTS.md 的标记段——都在这里落笔,模型只能通过
 * `POST /onboarding/answer { stage, key, value }` 交数据,阶段机校验 key 白名单、写文件、推进阶段。
 * 断了怎么续:任何时候进程死掉,onboarding.json 就是全部真相;再开会话第一句是「上次到哪,接着吗」。
 *
 * 纪律:
 * - 记忆写入只走三种写权限(新建项目文件 / 追加进展等 / 重写索引与标记段);**不删任何文件**。
 * - 「当场答即拍板」:一句话 / 阶段 / 目标 / 截止日直接写项目文件,不进待拍板。
 * - 每阶段推进一次 commit(`chore(记忆): 引导·<阶段>`;收尾是 `chore(记忆): 入职·收尾`),
 *   不 push——push 由统筹会话或事务官按授权做。commit 失败不挡推进,如实带回 error。
 * - 不编数:/state.onboarding 只有 stage / done / askedAt,没问过就没有 askedAt。
 */
import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { access, mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { promisify } from 'node:util'
import { BASE_APP_LABELS } from './appsRegistry.ts'
import { MEMORY_FAMILY_APP_KEYS } from './agentMemory.ts'
import type { AuthorizationService, AuthStatus } from './authorization.ts'
import { effortFor } from './butlerEffort.ts'
import type { GitGateResult } from './gitGate.ts'
import { createGitGate } from './gitGate.ts'
import type { ButlerSessionOpener } from './butlerItem.ts'
import {
  SPEAKING_STYLE_BLOCK,
  appendIndexRow, appendUnderSection, applyAgentsFile, newProjectFile, newUserFile, upsertMarkedBlock, upsertProjectField,
} from './memoryMd.ts'
import { PROMPT_NAME_SECTION, resolvePromptBody } from './promptOverrides.ts'
import { calendarBrief } from './holidays.ts'
import type {
  AccountAnswer, IdeaAnswer, KeyBrief, MachineFacts, OnboardingMode, OnboardingStage, Persona, PlanAnswer, ProjectAnswer, StageDef,
} from './onboardingStages.ts'
import {
  AUTH_KEY_DESC, AUTH_READ_KEYS, AUTH_WRITE_KEYS, FIRSTRUN_CLOSING_LINE, FIRSTRUN_DEFAULTS, FIRSTRUN_PLAN, FULL_PLAN, STAGE_LABEL,
  firstMessage, isFirstrunPlan, keyBriefs, planWithoutRecords, requiredKeys, resolveAppKeys,
  safeName, scanRootsDefault, speakingStyleSection, stageDef, validateValue,
} from './onboardingStages.ts'
import { wantsToSkipRest } from './onboardingConsent.ts'
import { SURFACED_TTL_MS, briefPathKey, confirmsOnly, projectNameOf } from './projectBrief.ts'
import { SAME_TITLE, staleVersionOf, titleSimilarity } from './materialize.ts'
import type { TasksService } from './tasks.ts'
import type { OnboardingSummaryInput } from './callSummary.ts'
import { templateById } from '../templates.ts'

const execFileAsync = promisify(execFile)

export type RestartScope = 'all' | 'persona' | 'authorization'
export const RESTART_SCOPES: readonly RestartScope[] = ['all', 'persona', 'authorization']

/**
 * 谁在主导引导(2026-09-18,Ben:「似乎电脑手机同时都能操作;如果手机已经扫码,优先手机的引导流程」)。
 *
 * **只决定界面归属,不是权限**:两端共用同一份 onboarding.json,谁都写得进去(这一点没变,
 * 也不该变 —— 手机断电时人必须还能在电脑上把引导做完)。它决定的是「电脑那一屏出不出输入框」。
 */
export type OnboardingLeader = 'phone' | 'desktop'
export const ONBOARDING_LEADERS: readonly OnboardingLeader[] = ['phone', 'desktop']

/**
 * /state.onboarding。不编数:没开过会话就没有 askedAt,没人主导过就没有 leader。
 *
 * 2026-09-18 多了四格,全是为了电脑那一屏能显示**只读进度**「在手机上继续 · 现在到第 N 步:xxx」:
 * `leader` / `leader_at`(主导方与它最后一次有动静的时刻)、`step` / `steps`(第几步、共几步)、`label`。
 * 它们都是从既有状态算出来的,onboarding.json 里只多存了 leader 与 leader_at 两样。
 */
export interface OnboardingView {
  stage: OnboardingStage
  done: boolean
  askedAt?: string
  leader?: OnboardingLeader
  /** 主导方最后一次真的有动静(接上引导、念了种子句、交了一项答案)。电脑据此判断「手机那边没动静」。 */
  leader_at?: string
  /** 这一阶段的名字(「① 开场」)。电脑那一屏照它显示,不自己维护第二份对照表。 */
  label: string
  /** 第几步(1 起),按当前计划算 —— 计划可能只剩两步(补问新项目),所以 steps 也一起给。 */
  step: number
  steps: number
  /**
   * 走完的那一刻(2026-09-25,卡 feat/first-look-orb-top)。只在 done 时有。电脑首页认它「刚走完那一次切回事务官档」,
   * 手机首页「最近一次通话」在引导那一通没留纪要卡时拿它补一行。
   */
  done_at?: string
}

interface CommitRecord { stage: OnboardingStage, at: string, ok: boolean, message: string, error?: string }

interface OnboardingFile {
  version: 1
  stage: OnboardingStage
  plan: OnboardingStage[]
  mode?: OnboardingMode
  nickname?: string
  /**
   * ①′ 选的布局模板 id(2026-09-21)。缺席 = 还没问到那一步 / 老存档 —— 那时候
   * 阶段机按做产品那一套走,与加这一步之前逐字相同。
   */
  template?: string
  /** 阶段 → key → 值。projects 阶段里 `project` 这一项是「项目名 → 合并后的答案」。 */
  answers: Record<string, Record<string, unknown>>
  askedAt?: string
  startedAt: string
  updatedAt: string
  /**
   * 走完的那一刻(2026-09-25)。`advance()` 走到 `done` 时盖章,重来(restart)时清掉。
   * 电脑首页据此在「刚走完引导」那一次自己切回事务官档;老存档没有它,view 退回 `updatedAt`。
   */
  done_at?: string
  session_id?: string
  /**
   * 这条引导会话最近一轮以错误结束(2026-09-23,新装机器真机)。
   *
   * DSH 会话建出来那一刻就把 provider 钉死了:模型还没接好时开的会话,之后模型接好、DSH 重启,
   * 它**仍然**走老路由,每一轮都 `no API key`。所以续接前要知道它坏过 —— 这件事要落盘:
   * 回合表只在内存里,DSH 一重启就忘了。`session_id` 与当前 session_id 不同的记录视为过期。
   */
  session_failed?: { session_id: string, at: string, code?: string }
  /** 只补问这一个项目(新仓库出现)。 */
  focus?: string
  /** B2 立项建出来的第一个事项 id(只为回指,不是答案)。 */
  first_task_id?: string
  /**
   * ④ 习惯里「常用应用」那一问认出来的键的**展示名**(与 `answers.habits.apps` 一一对应)。
   * 记忆文件里写给人看的是名字,不是 `wechat` 这种键。
   */
  app_labels?: string[]
  /**
   * 同一问里**认不出来**的那几个名字,原样留着(2026-09-18)。不进窗位清单 —— 没查到 bundle id
   * 的应用开不起来(D13:没有的能力不装成有);留在这儿是为了他自己看得见、以后能手动加。
   */
  custom_apps?: string[]
  /**
   * 哪些阶段的种子句**已经出过声**(2026-09-18,手机引导改通话模式)。
   * 通话里种子句由工人直接流式 TTS 说出来,不等模型;挂断再进来不能重说一遍——
   * 「开场白只说一次」这条规矩从此在这里落盘,而不是靠手机端记着。
   */
  spoken_seeds?: string[]
  /**
   * 谁在主导(2026-09-18)。手机开始引导通话时工人落 `'phone'`;人在电脑上按「改在电脑上做」落 `'desktop'`。
   * 没有这一格 = 还没人主导过 —— 那时候电脑端按「配没配过手机」自己判(见 client/firstrun/onboardingLead.ts),
   * **不在服务端猜**:服务端不知道此刻有没有一台手机真的醒着。
   */
  leader?: OnboardingLeader
  /** 主导方最后一次有动静的时刻。电脑那一屏据此在十分钟后问一句「改在电脑上做?」。 */
  leader_at?: string
  /**
   * 已经按方案建过事项的标题(项目名 → 标题列表,2026-09-20)。
   *
   * 本机真跑里她把同一份方案交了三次(每次措辞略有不同),看板上就冒出十二条 ——
   * 对用户来说那不是「记下了」,那是一堆重复的活儿。方案本身可以改(他改主意了),
   * **但同一条事项只建一次**。
   */
  plan_tasks?: Record<string, string[]>
  /**
   * 从各家客户端拷过来的那几份记忆的索引行(2026-09-21)。
   *
   * 记在这儿而不是每次现扫:用户文件里那几行是「那一次拷了什么」的**记录**,
   * 不是「此刻各家有什么」的快照 —— 他之后在 Claude 里又记了十条,不该让
   * 已经写下的那几行自己变数字。
   */
  memory_index?: string[]
  /** 待补问的新项目名单。 */
  supplement: string[]
  /**
   * 引导做完那一刻项目区里**已经有**的项目名(2026-09-23)。这些不算「新冒出来的」:
   * 「先录一个,没挑的一个都不记」(09-23 拍板)—— 引导做完后项目区第一次扫到的十几个仓库
   * 不该全进补问名单(统筹自跑时 13 个全进了)。缺席 = 还没立过基线,下一次自动发现时立。
   */
  project_baseline?: string[]
  commits: CommitRecord[]
  history: { at: string, event: string }[]
}

/** 引导要用到窗位清单的三件事。接线在 index.ts(registry + clientScan),这里只认这三个函数。 */
export interface OnboardingAppsDeps {
  /** 登记过的全部应用(基础七个 + 自定义),不过滤可见性 —— 名字认成键靠它。 */
  known: () => Promise<readonly { key: string, label: string }[]>
  /** 把这几个键记进 apps.json 的 `enabled`(「首次不自动认领」那条规矩下,这是窗位清单出现的方式)。 */
  enable: (keys: readonly string[]) => Promise<{ enabled: string[], already: string[], unknown: string[] }>
  /**
   * 这会儿扫到装了的那几家(clientScan 的 `installedKeys()`)。给简报用:模型据此说
   * 「我看到你装了 Claude、Kimi、微信,都要吗」。**没扫过就 undefined**,那时简报里整格缺席
   * —— 不冒充「一家都没装」(同 clientScan.ts 顶部那条纪律)。
   */
  installed?: () => readonly string[] | undefined
}

/**
 * 引导 ①′ 要的那两件事:把模板换过去、知道现在是哪一个。
 * 形状照着 server/templateStore.ts 的 TemplateService 挑最小的一份 —— 引导不该认识
 * 备份、文件夹、窗位清单那些细节。
 */
export interface OnboardingTemplateDeps {
  apply: (id: string) => Promise<{ ok: boolean, reason?: string, folders_made?: string[], apps_note?: string }>
  currentId: () => string
}

/**
 * 引导 ②′ 运营线要写的那一件事(2026-09-21):把一个账号记到**工作目录**下。
 *
 * 为什么不直接把工作目录路径传进来自己写:引导这一层已经有一个"往哪儿写"的概念了
 * (`repoRoot`,记忆仓库),再塞第二个路径进来,以后每读一处代码都要先分清这两个是谁。
 * 给一个函数,引导只管"记这个账号",落到哪儿、文件长什么样是 server/accounts.ts 的事。
 *
 * **不传 = 这台工作台没配工作目录**:答案照收(记进 onboarding.json),但一个文件夹都不建,
 * 并在 note 里如实说一句(同 tasks / apps / template 三处的先例)。
 */
export interface OnboardingAccountsDeps {
  write: (account: {
    name: string
    fields: Partial<Record<'定位' | '风格' | '人群' | '平台' | '开号日期', string>>
    /** 记进账号文件「进展」那一行的日期。**引导给**,用的是它自己那只(测试可注入的)钟。 */
    date: string
  }) => Promise<{ ok: boolean, path?: string, reason?: string, created?: boolean }>
}

/**
 * ②′ 那一问「各家客户端里记的东西,要不要拷一份过来」(2026-09-21)。
 *
 * 形状照着 server/agentMemory.ts 的 `importAgentMemories` 挑最小的一份 —— 阶段机不该认识
 * `~/.claude/projects` 这种路径,它只负责「他点头了就调这一下,然后把回来的那句话原样说出去」。
 */
export interface OnboardingMemoryDeps {
  /** 真去拷一趟。回:写了哪几个文件(相对仓库根)、索引行、念给用户听的那一句。 */
  importAll: () => Promise<{
    written: readonly string[]
    /** 这一趟**头一回**出现的那几份(没有就当全是新的,老接线兼容)。 */
    added?: readonly string[]
    index: readonly string[]
    line: string
  }>
  /**
   * 先探一眼:各家各有几份(2026-09-22,界面上那颗按钮)。**只读、只数,不拷**。
   *
   * 没接这一档就没有这条路 —— 界面照实说「这台工作台没接」,不画一个空表冒充"一家都没有"。
   */
  probeAll?: () => Promise<readonly {
    family: string
    label: string
    count: number
    /** 看见了但不拷的那几样(Codex 的 SQLite、软链、太大的),每条一句人话。 */
    left: readonly string[]
    /** 整家不拷的理由(工作台自己那一份)。缺席 = 照拷。 */
    skip?: string
  }[]>
}

/** 一家在这台机器上探到的样子。**数是数出来的**,一家都没有就是 0 + 界面写「未查到」。 */
export interface MemoryProbeFamily {
  family: string
  label: string
  count: number
  left: readonly string[]
  skip?: string
}

/** `probeMemories()` 回的那一份。界面拿它画三档授权与每家几份。 */
export interface MemoryProbeResult {
  /** 授权表里「读各家客户端文件」是不是「可以」。不是就别让那颗「拷」按下去。 */
  allowed: boolean
  status: AuthStatus
  /** 这台工作台接没接「拷别家记忆」这一档。没接时 families 是空的,不冒充"一家都没有"。 */
  wired: boolean
  families: readonly MemoryProbeFamily[]
  /** 一句人话:不是「可以」时写清该去哪放开。 */
  note: string
}

export interface OnboardingServiceOptions {
  /** ~/.dsh/workbench/onboarding.json */
  file: string
  /**
   * 新存档走哪套骨架(2026-09-27,卡 OB)。
   * **缺席 = 新骨架**(`FIRSTRUN_PLAN`,最多 5 问)。钉着老骨架那一串阶段的用例传 `FULL_PLAN`。
   */
  plan?: readonly OnboardingStage[]
  /** 记忆所在仓库根(docs/记忆 在它底下)。 */
  repoRoot: string
  /** ~/.dsh/AGENTS.md(测试给临时目录)。 */
  agentsFile: string
  authorization: AuthorizationService
  /** B 线立项要建第一个事项;没接看板就如实说建不了。 */
  tasks?: TasksService
  /**
   * 窗位清单(2026-09-18,引导 ④ 习惯多问一句「你平时最常开哪几个应用」)。
   * **不传 = 不启用这一档**:答案照收(记进 onboarding.json 与记忆文件),但一个键都不写进
   * apps.json,并在 note 里如实说一句 —— 既有那一大批用例一条没改(同 tasks 的先例)。
   */
  apps?: OnboardingAppsDeps
  /**
   * 布局模板(2026-09-21,引导 ①′)。**不传 = 不启用这一档**:答案照收(记进
   * onboarding.json 与记忆文件),但布局一个字不换,并在 note 里如实说一句 ——
   * 既有那一大批引导用例一条没改(同 tasks / apps 的先例)。
   */
  template?: OnboardingTemplateDeps
  /**
   * 账号(2026-09-21,运营模板下的 ②′)。**不传 = 不启用这一档**,同上。
   */
  accounts?: OnboardingAccountsDeps
  /**
   * 各家客户端的记忆(2026-09-21,②′ 那一问)。**不传 = 不启用这一档**:答案照记
   * (记进 onboarding.json 与记忆文件),但一份都不拷,并在 note 里如实说一句
   * —— 既有那一大批引导用例一条没改(同 tasks / apps / template 的先例)。
   */
  memories?: OnboardingMemoryDeps
  /**
   * 引导技能文件按顺序找,第一个读到的算(装机后在 `~/.dsh/skills/引导/SKILL.md`,
   * 开发时在仓库的 `.dsh/skills/引导/SKILL.md`)。都读不到就**不编一份**,简报里如实说一句。
   */
  skillFiles?: readonly string[]
  /**
   * 项目区(2026-09-23):引导里他确认「是这个」的那个仓库,落成项目区的**那一条**(同一个 id / 同一行)。
   * **不传 = 不启用这一档**:项目文件照写,项目区里不动,note 里如实说一句。
   */
  projects?: { adopt: (input: { name: string, path: string }) => Promise<{ id: string }> }
  /**
   * 项目仓库现在的版本(2026-09-24 晚,卡 feat/onboarding-materialize)。②′ 按方案建事项时,提到的版本比现在旧的那几条
   * (「查 0.2.80 真机聚球还卡不卡」,而仓库已经 0.2.83)是照搬旧交接的,不建、如实说一句。不传 = 不判。
   */
  version?: (path: string) => Promise<string | undefined>
  now?: () => Date
  /** git 执行器,测试可注入。默认 execFile('git', args, { cwd })。 */
  git?: (args: string[], cwd: string) => Promise<string>
  /**
   * **调 git 之前那道门**(2026-09-30,止血第 5 条):没有 `.git` / 没装开发者工具就别调 ——
   * 新 Mac 上一调就弹「安装命令行开发者工具」,她不是开发者,不该被问(见 `gitGate.ts`)。
   *
   * 不传就按 `repoRoot` 现做一道(答案缓存在进程里,不是每次一个子进程)。
   */
  gitReady?: () => Promise<GitGateResult>
}

/**
 * 刚收尾的那一段,晚到的一项还认多久(2026-09-24 晚,卡 feat/onboarding-materialize)。
 *
 * 模型一口气交好几项时,工具调用是**流式一件件到的**(LiveKit 的解析:前一件在下一件开始吐的那一刻就开跑,
 * 最后一件要等它自己的参数吐完)。所以「done 在前、project 在后」时,done 先到 → 这一段推进 → project 晚几秒到、
 * 落在下一段 → 409(09-24 真机,她只好靠 correct_answer 自救,而没答过的项 correct 也不收)。
 * 工人那边排不了这个序 —— 它不知道后面还有没有下一件。这里认:刚收尾的那一段、一分钟内晚到的一项,照收进那一段。
 */
export const LATE_ANSWER_GRACE_MS = 60_000

export type AnswerResult =
  | {
    ok: true
    stage: OnboardingStage
    advanced: boolean
    done: boolean
    next?: { label: string, seed: string, goals: readonly string[], keys: string[] }
    recap?: string
    commit?: { ok: boolean, message: string, error?: string }
    note?: string
    /**
     * 新骨架走到完了要念的那一句(2026-09-27,卡 OB):「好,进去吧。剩下的用到时我再问,设置里也随时能改。」
     * **照它念,别再复述、别念清单、别念文件路径**。没走完就缺席。
     */
    closing?: string
  }
  | { ok: false, status: 400 | 409, error: string }

/**
 * 改一项已经答过的(2026-09-20,Ben:「包括它说不能改,我当时一度想要停下」)。
 *
 * 和 `answer` 的两处不同,都是故意的:
 * - **不看当前阶段**。听错称呼是在「② 分岔」才被发现的,拿「现在不在开场」把他挡回去
 *   正是那次真机上发生的事(日志里那条 `引导 opening.nickname → 409`)。
 * - **不推进阶段**。改个称呼不该把人重新拖回开场,也不该因为「必答项齐了」再推一次。
 */
export type CorrectResult =
  | {
    ok: true
    /** 改的是哪个阶段的哪一项。 */
    stage: OnboardingStage
    key: string
    /** 当前阶段(没变,回给调用方对账)。 */
    current: OnboardingStage
    /** 这一改还顺带动了什么(改称呼会改记忆文件名)。没有就缺席。 */
    also?: string
    commit?: { ok: boolean, message: string, error?: string }
    note?: string
  }
  | { ok: false, status: 400 | 404 | 409, error: string }

/**
 * 同一条引导会话,多久之内不再往里推第二次「接着」(2026-09-24 真机第五轮)。
 * 两处几乎同时来开会话(电脑页面 + 手机挂断后的那一下)只说一次;过了这段时间他再进来,照常推一次。
 */
export const RESUME_NUDGE_QUIET_MS = 20_000

export type SessionResult =
  | {
    ok: true
    stage: OnboardingStage
    session_id?: string
    note?: string
    first_message: string
    /** 当前阶段的种子句(开场是 Ben 亲笔那句):手机开会话成功后立刻显示、朗读,不等模型(2026-09-16)。 */
    seed: string
    /** 接着做:模型第一句直接问还没答的那一题(2026-09-24 起不问「上次到哪」),不是种子句。 */
    resumed: boolean
    /**
     * 这一次**没往会话里说话**(2026-09-24 真机第五轮):同一条会话刚被推过一次「接着」,
     * 又有人来开(电脑页面与手机挂断后几乎同时敲门),只把会话交出去,不再说一遍 —— 不然她连说两条「接着」。
     * 调用方看到它就别重绑回合表(那一条还在答)。
     */
    quiet?: boolean
    /**
     * `first_message` 是按哪些已答项写的(阶段 → key,与 `detail().answered` 同形;2026-09-24)。
     * 重启后预热那条据此认「页面来领时阶段机变没变」(onboardingWarm.progressMark)。quiet 时没写消息,缺席。
     */
    answered?: Record<string, string[]>
  }
  | { ok: false, status: 409, error: string }

/** `openSession` 的附加项(2026-09-24)。 */
export interface OpenSessionOptions {
  /**
   * 这条会话别再续,另开一条:重启后预热的那条,第一条消息是按预热那一刻的阶段写的,之后阶段机又变了
   * (onboardingWarm.ts claim 回 `stale`)。只在它**还是当前那条**时算数 —— 这期间别处已经换过会话就照常走。
   */
  replace?: string
}

/**
 * 引导简报(2026-09-18,手机引导改通话模式)。通道层的工人**不进 DSH 会话**,它自己接话,
 * 所以要有一份东西一次性告诉它:现在在哪个阶段、该弄清什么、能写哪些 key、值是什么形状、
 * 引导技能怎么说、这一阶段的种子句出过声没有。
 *
 * 它只是**另一种取法**,阶段机一个字没改:答案照旧只能走 `POST /onboarding/answer`。
 */
export interface OnboardingBrief {
  stage: OnboardingStage
  label: string
  done: boolean
  /** 这一阶段该说的那句(开场是 Ben 亲笔那句,一字不改)。done 时缺席。 */
  seed?: string
  /** 还没出过声:true 时工人**立刻**说出来,不等模型。 */
  speak_seed: boolean
  goals: readonly string[]
  keys: readonly KeyBrief[]
  answered: Record<string, string[]>
  nickname?: string
  mode?: OnboardingMode
  /** 只补问这一个项目(扫描发现的新仓库)。 */
  focus?: string
  /** 收尾阶段:代码从已答项算的复述清单(不编)。 */
  recap?: string
  /**
   * 这台机器上**扫到装了**的那几家(2026-09-18)。只在问「常用应用」的那一段给(④ 习惯),
   * 模型据此说「我看到你装了 Claude、Kimi、微信,都要吗」。
   * 没扫过(或这一段不问应用)就缺席 —— 不编数,也不冒充「一家都没装」。
   */
  installed_apps?: readonly { key: string, label: string }[]
  /**
   * 日历(2026-09-20,Ben:「10 月 4 号,智能一点就该知道这是国庆」)。今天几号星期几、
   * 接下来 90 天的法定假期、已经记下的截止日各自还剩几个工作日 —— 都由 `holidays.ts` 现算。
   * 算不出来就整格缺席。
   */
  calendar?: string
  plan: readonly OnboardingStage[]
  /** `.dsh/skills/引导/SKILL.md` 全文。读不到就缺席,并在 skill_note 里如实说一句。 */
  skill?: string
  skill_note?: string
  /** 事务官第一次开过口的时刻。没开过就缺席(不编数)。 */
  askedAt?: string
  /**
   * 这会儿引导归谁管。`'desktop'` 时工人**一个字都不说**,手机上显示「电脑上在做,先别说」。
   * 还没人主导过就缺席 —— 手机打进来那一下会把它落成 `'phone'`。
   */
  leader?: OnboardingLeader
  /**
   * **这台电脑上真装了、而且真有记录可读的那几家 AI**(2026-09-27,卡 OB;展示名)。
   * 引导「能不能读它们记着的东西」那一问的名单**只能是这一份** —— 通道层照它念,一家都不许自己加。
   * 缺席 = 这台工作台没接探测这一档(话术退回老字面量);空数组 = 探过了,一家都没有,那一问不问。
   */
  memory_families?: readonly string[]
  /** 这份存档走的是新骨架(最多 5 问)吗(2026-09-27)。 */
  firstrun?: boolean
}

export interface OnboardingService {
  load: () => Promise<void>
  view: () => OnboardingView
  /** 给通道层工人的简报(含引导技能全文)。 */
  brief: () => Promise<OnboardingBrief>
  /**
   * 这一阶段的种子句已经出过声了。工人一开口就调(不等说完 —— 说到一半掉线也算说过,
   * 再进来重念一遍开场白比漏念更糟)。顺手把 askedAt 记上:那本来就是「事务官开过口」的意思。
   */
  markSeedSpoken: (stage: unknown) => Promise<{ ok: true, stage: OnboardingStage, speak_seed: boolean } | { ok: false, status: 400, error: string }>
  /**
   * 换一个主导方(2026-09-18)。手机开始引导通话 → `'phone'`(工人替它落);
   * 人在电脑上按「改在电脑上做」→ `'desktop'`。**只改界面归属**,阶段与答案一个字不动。
   */
  setLeader: (leader: unknown) => Promise<{ ok: true, leader: OnboardingLeader } | { ok: false, status: 400, error: string }>
  /**
   * 通话纪要那一句话的原料(2026-09-25,server/callSummary.ts):走完没有、停在哪、答过哪几段、他确认过的项目名。
   * 可选:测试里的假服务不用都补。
   */
  summaryInput?: () => OnboardingSummaryInput
  /** 引导里答的称呼(界面上写用户自己用,`/state.me`)。可选:测试里的假服务不用都补。 */
  nickname?: () => string | undefined
  detail: () => {
    stage: OnboardingStage
    done: boolean
    mode?: OnboardingMode
    nickname?: string
    plan: readonly OnboardingStage[]
    answered: Record<string, string[]>
    next?: { label: string, seed: string, goals: readonly string[], keys: string[] }
    recap?: string
    askedAt?: string
    leader?: OnboardingLeader
    leader_at?: string
    session_id?: string
    supplement: readonly string[]
    commits: readonly CommitRecord[]
  }
  openSession: (opener: ButlerSessionOpener | undefined, baseUrl: string, options?: OpenSessionOptions) => Promise<SessionResult>
  /**
   * 忘掉「刚推过一次接着」(2026-09-24)。往会话里说话失败(DSH 里那条没了)时调:下一次来开就真去开 / 说,
   * 不因为防重复而交出一条死会话。
   */
  clearNudge?: () => void
  /**
   * 引导会话的一轮结束了(2026-09-23)。以错误结束 → 记下「这条会话坏了」,下次 openSession 另开一条;
   * 之后又有一轮正常结束 → 撤掉。不是当前那条会话的一律不理。
   */
  noteTurnEnd: (sessionId: string, outcome: { ok: true } | { ok: false, code?: string }) => Promise<void>
  /** 当前引导会话是不是坏了(最近一轮以错误结束)。/onboarding/say 据此先换一条新会话再说。 */
  sessionBroken: () => boolean
  /**
   * 各家客户端的记忆,现在就拷一份过来(2026-09-21)。不看阶段、不推进阶段;
   * `note` 是**照实**数出来的那一句(拷了几份、哪几家没找到),原样念给用户听。
   */
  /**
   * 拷别家记忆。授权表里「读各家客户端文件」不是「可以」时回 `ok:false` + 那句原话(2026-09-22 C5)。
   *
   * `written` 是**这一趟真写进仓库**的那几份(相对仓库根),`added` 是其中头一回出现的。
   * 内容一个字没变的不在里面 —— 界面上那颗按钮可以重复点,第二次点要说得出「没有新的」。
   */
  importMemories: () => Promise<{
    ok: boolean
    note: string
    written: readonly string[]
    added: readonly string[]
  }>
  /**
   * 先探一眼:每家各有几份、授权现在是哪一档(2026-09-22,界面上那颗按钮)。
   *
   * **只读、只数,不拷,也不改任何状态**(这一条不进队列改不了盘上的东西)。
   */
  probeMemories: () => Promise<MemoryProbeResult>
  /**
   * `heard`:她最近问出口的那句 + 他之后说的那句(与凭据门同一份,http 层给;2026-09-24 下午小修)。
   * 只用来给「读了仓库、他点头之后」记的那几句标出处(见 {@link OnboardingService.noteBriefRead});缺席 = 拿不到,只看读没读过。
   */
  answer: (input: { stage: unknown, key: unknown, value: unknown, heard?: { asked: string, reply: string } }) => Promise<AnswerResult>
  /**
   * **他喊停了:剩下的按默认记完,直接进页面**(2026-09-27,卡 OB)。
   * 词表判在 onboardingConsent 的 `wantsToSkipRest`;这里只管落地。他的内容一个字都不编。
   */
  skipRest: (reason?: string) => Promise<{ ok: true, stage: OnboardingStage, done: boolean, line: string, skipped: string[] }>
  /**
   * 这一次引导里读过这个项目的摘要(2026-09-24 下午小修「出处写对」)。8791 读成一份(找到时顺手读、或 project-brief)就调一下。
   * 之后记下的 project 带着这个 path、他那句话只是点头 → 一句话 / 进展 / 下一步标「读仓库说明,他确认」,不再标「他口述」。
   * 只记在这个进程里(30 分钟),不落盘;重来整个引导就清掉。
   */
  noteBriefRead?: (path: string) => void
  /**
   * 改一项**已经答过的**(2026-09-20)。任何阶段的任何 key 都能改,阶段不动。
   * 改称呼会连记忆文件的文件名与标题一起改(见 renameUserFile)。
   */
  correct: (input: { stage: unknown, key: unknown, value: unknown }) => Promise<CorrectResult>
  restart: (scope: RestartScope) => Promise<{ ok: true, stage: OnboardingStage }>
  /** 扫描发现新项目:引导已完成且没有项目文件的,记进待补问名单。 */
  /**
   * `explicit`:他亲口说「再加一个 XX」(POST /onboarding/project)。不看基线,直接排进补问名单。
   * 缺省是项目区自动发现的那一路:第一次只立基线(见 project_baseline),之后新冒出来的才补问。
   */
  noticeProjects: (names: readonly string[], options?: { explicit?: boolean }) => Promise<string[]>
  /**
   * 引导落地落完了(2026-09-24 晚,卡 feat/onboarding-materialize):项目背景(「9/29 起远程,只带 Pad;中秋……」)写进项目文件,
   * 记一笔历史,存一个版本(`chore(记忆): 引导·落地`)。阶段一个字不动。
   */
  recordMaterialized?: (input: { background?: { project: string, text: string } }) => Promise<void>
}

export function defaultOnboardingFile(home = process.env.HOME ?? ''): string {
  return `${home}/.dsh/workbench/onboarding.json`
}

export function defaultAgentsFile(home = process.env.HOME ?? ''): string {
  return `${home}/.dsh/AGENTS.md`
}

export function defaultAuthorizationFile(repoRoot: string): string {
  return join(repoRoot, 'docs', '记忆', '授权.md')
}

class AnswerError extends Error {
  readonly status: 400 | 409
  constructor(status: 400 | 409, message: string) {
    super(message)
    this.status = status
  }
}

/** 这一项是怎么来的(2026-09-24 下午小修「出处写对」):他那句话(answer 带来的),或者这是一次更正。 */
interface AnswerContext {
  heard?: { asked: string, reply: string }
  correcting?: boolean
}

const PROGRESS_BLOCK = '进度'
const RECORD_BLOCK = '记录'
/** 从各家客户端拷过来的那几份,在用户文件里占的那一段(2026-09-21)。 */
const MEMORY_BLOCK = '外部记忆'

/** 技能文件一个都读不到时简报里那句话。**不编一份**:少了它工人照样按阶段清单聊,只是背景薄一点。 */
export const SKILL_MISSING_NOTE
  = '读不到引导技能(.dsh/skills/引导/SKILL.md),这一份简报里只有阶段清单与值的形状;照它聊就行,别自己发挥流程。'

/**
 * 断点续做:老存档的阶段顺序升级(2026-09-23,顺序从「称呼 → 布局 → 分岔」改成「称呼 → 分岔 → 布局」)。
 *
 * 纯函数。只动 `plan` 里 template / branch 两格的先后,和**正好停在这两格上**的 `stage`:
 * - 分岔还没答 → 停在分岔(哪怕老顺序下正停在布局上、布局也还没答:新顺序先问分岔);
 * - 分岔答了、布局还没答 → 停在布局;
 * - 两个都答了 → 往后走一格(不会发生,推进是答完当场做的;防一手)。
 * 已答的一项不丢、不重问;停在别的阶段的存档只换 plan,`stage` 原样。
 * 还没答的那一格若「种子句已经说过」,把它划掉 —— 老顺序下念过的是老说法,新顺序到那一格要重新开口。
 */
export function upgradeLegacyOrder(input: {
  stage: OnboardingStage
  plan: readonly OnboardingStage[]
  mode?: OnboardingMode
  template?: string
  spoken_seeds?: readonly string[]
}): { stage: OnboardingStage, plan: OnboardingStage[], spoken_seeds?: string[], changed: boolean } {
  const plan = [...input.plan]
  const ti = plan.indexOf('template')
  const bi = plan.indexOf('branch')
  const same = { stage: input.stage, plan, ...(input.spoken_seeds === undefined ? {} : { spoken_seeds: [...input.spoken_seeds] }), changed: false }
  if (ti < 0 || bi < 0 || ti > bi) return same
  plan[ti] = 'branch'
  plan[bi] = 'template'
  let stage = input.stage
  if (stage === 'template' || stage === 'branch') {
    if (input.mode === undefined) stage = 'branch'
    else if (input.template === undefined) stage = 'template'
    else stage = plan[plan.indexOf('template') + 1] ?? 'done'
  }
  const unanswered = new Set<string>([
    ...(input.mode === undefined ? ['branch'] : []),
    ...(input.template === undefined ? ['template'] : []),
  ])
  const spoken = input.spoken_seeds?.filter(item => !unanswered.has(item))
  return { stage, plan, ...(spoken === undefined ? {} : { spoken_seeds: spoken }), changed: true }
}

export function createOnboardingService(options: OnboardingServiceOptions): OnboardingService {
  const now = options.now ?? (() => new Date())
  /**
   * 刚收尾的那一段(见 {@link LATE_ANSWER_GRACE_MS})。只在内存里:要接住的是几秒内的赛跑,重启了就不认。
   */
  let lastFinished: { stage: OnboardingStage, at: number } | undefined
  const runGit = options.git ?? (async (args: string[], cwd: string) => (await execFileAsync('git', args, { cwd })).stdout)
  /**
   * 调 git 之前那道门(2026-09-30,止血第 5 条)。没有 `.git` / 没装开发者工具就**一次都不调**:
   * 新 Mac 上一调就弹系统的「安装命令行开发者工具」对话框,而这一步本来就只是「顺手存个版本」。
   * 过不去就当这一次提交失败,把那一句人话原样记进 `state.commits`(汇报里看得见),
   * 文件留在 dirty 里 —— 她哪天装上了工具,下一次推进自然就提交上了。
   */
  const gitReady = options.gitReady ?? createGitGate(options.repoRoot)
  const git = async (args: string[], cwd: string): Promise<string> => {
    const gate = await gitReady()
    if (!gate.ok) throw new Error(gate.note ?? '这一步没存版本')
    return await runGit(args, cwd)
  }
  const iso = (): string => now().toISOString()
  const today = (): string => iso().slice(0, 10)

  let state: OnboardingFile = fresh()
  /** 本阶段写过的文件(相对仓库根),推进时一起 commit。 */
  let dirty = new Set<string>()
  /** noticeProjects 已经看过的名字,进程内记住,不重复 stat。 */
  const seenProjects = new Set<string>()
  let writeQueue: Promise<unknown> = Promise.resolve()
  /** 最近一次往引导会话里说「开 / 接着」的那一下(只在内存:进程换了,会话也就换了)。 */
  let nudged: { session_id: string, stage: OnboardingStage, at: number } | undefined
  /**
   * 这一次引导里读过摘要的项目(路径比对键 → 读的那一刻,毫秒;2026-09-24 下午小修「出处写对」)。
   * 只在内存:进程换了就当没读过 —— 那几句照旧标「他口述」,宁可少说一句读过,不多说。
   */
  const briefReads = new Map<string, number>()
  const homeDir = (): string => process.env.HOME ?? ''

  function fresh(): OnboardingFile {
    const at = iso()
    // 2026-09-27(卡 OB):新存档走**新骨架**(最多 5 问)。钉着老骨架的用例与老存档各自带自己的 plan。
    const plan = [...(options.plan ?? FIRSTRUN_PLAN)]
    return { version: 1, stage: 'opening', plan, answers: {}, startedAt: at, updatedAt: at, supplement: [], commits: [], history: [] }
  }

  /**
   * 这份存档走的是新骨架吗(判据看 plan,不看版本号)。
   *
   * 两条都要:① 老骨架必有的「④ 习惯」不在;② 计划里有「② 分岔」—— 第二条挡的是
   * **补问新项目**那一支(`plan` 只剩 `['projects','done']`),它不是一遍新引导,
   * 不该往里加「⑤ 读记录」、也不该去写那批默认值。
   */
  function firstrun(): boolean {
    return isFirstrunPlan(state.plan) && state.plan.includes('branch')
  }

  /**
   * 「这台电脑上真装了、而且真有记录可读的那几家 AI」(2026-09-27,卡 OB)。
   *
   * 两条都要满足:`probeAll()` 在这台机器上**真数出了 .md 记录**(`count > 0`、不是工作台自己那一份),
   * 而且应用探测里**真装了那个 App**(`installed`;探测整个缺席时不拿它卡 —— 记录都在那儿了,
   * 装没装这件事没探到不等于没装)。
   *
   * 这一份是引导「读记录」那一问的**唯一名单来源**:名单空了那一问整个不问。
   * 探不到(这台工作台没接 `memories` 这一档)→ `undefined` =「没探过」,话术退回老字面量。
   */
  async function memoryFamilyNames(): Promise<string[] | undefined> {
    const probe = options.memories?.probeAll
    if (probe === undefined) return undefined
    let families: readonly { family: string, label: string, count: number, skip?: string }[]
    try { families = await probe() }
    catch { return undefined }
    const installed = options.apps?.installed?.()
    const ok = (family: string): boolean => {
      const key = MEMORY_FAMILY_APP_KEYS[family]
      if (key === undefined) return false
      if (installed === undefined) return true
      return installed.includes(key)
    }
    return families.filter(one => one.skip === undefined && one.count > 0 && ok(one.family)).map(one => one.label)
  }

  /** 这一刻的机器事实(缓存一份:引导走一遍的几分钟里这台机器上装了什么不会变)。 */
  let factsCache: MachineFacts | undefined
  async function facts(): Promise<MachineFacts> {
    if (factsCache === undefined) {
      const names = await memoryFamilyNames()
      factsCache = { firstrun: firstrun(), ...(names === undefined ? {} : { memoryFamilies: names }) }
    }
    return { ...factsCache, firstrun: firstrun() }
  }

  /** 同步取一份(拿不到就只带 firstrun —— 名单缺席 = 没探过,话术照老字面量)。 */
  function factsNow(): MachineFacts {
    return { ...(factsCache ?? {}), firstrun: firstrun() }
  }

  function enqueue<T>(task: () => Promise<T>): Promise<T> {
    const result = writeQueue.then(task, task)
    writeQueue = result.then(() => undefined, () => undefined)
    return result
  }

  async function save(): Promise<void> {
    state.updatedAt = iso()
    await mkdir(dirname(options.file), { recursive: true })
    const tmp = `${options.file}.${randomUUID()}.tmp`
    await writeFile(tmp, `${JSON.stringify(state, null, 2)}\n`, 'utf8')
    await rename(tmp, options.file)
  }

  // ———————————————————————— 路径与文件读写 ————————————————————————

  const rel = (...parts: string[]): string => join('docs', '记忆', ...parts)
  const abs = (relative: string): string => join(options.repoRoot, relative)

  async function readOr(relative: string, fallback: () => string): Promise<string> {
    try {
      return await readFile(abs(relative), 'utf8')
    }
    catch {
      return fallback()
    }
  }

  async function writeRel(relative: string, text: string): Promise<void> {
    await mkdir(dirname(abs(relative)), { recursive: true })
    await writeFile(abs(relative), text, 'utf8')
    dirty.add(relative)
  }

  /**
   * 引导技能全文。读到一次就记住(它是发版时一起装的,进程活着的时候不会变);
   * 一个都读不到就是 undefined —— 每次再试一遍,Ben 把文件补上之后不用重启工作台。
   */
  let skillText: string | undefined
  async function readSkill(): Promise<string | undefined> {
    if (skillText !== undefined) return skillText
    for (const file of options.skillFiles ?? []) {
      try {
        const text = await readFile(file, 'utf8')
        if (text.trim() !== '') { skillText = text; return skillText }
      }
      catch { /* 下一个候选 */ }
    }
    return undefined
  }

  async function exists(path: string): Promise<boolean> {
    try {
      await access(path)
      return true
    }
    catch {
      return false
    }
  }

  function userFileRel(): string | undefined {
    const name = state.nickname === undefined ? undefined : safeName(state.nickname)
    return name === undefined ? undefined : rel(`用户-${name}.md`)
  }

  // ———————————————————————— 答案的取用 ————————————————————————

  /** 模板 id → 人话名字。认不出就原样回 id(不猜,同 layoutSnapshot 的规矩)。 */
  const templateName = (id: string): string => templateById(id)?.name ?? id
  const answersOf = (stage: string): Record<string, unknown> => state.answers[stage] ?? {}
  const str = (stage: string, key: string): string | undefined => {
    const value = answersOf(stage)[key]
    return typeof value === 'string' ? value : undefined
  }
  const projectAnswers = (): Record<string, ProjectAnswer> =>
    (answersOf('projects').project as Record<string, ProjectAnswer> | undefined) ?? {}
  const ideaAnswer = (): IdeaAnswer | undefined => answersOf('projects').idea as IdeaAnswer | undefined
  /** 运营线 ②′ 记下的账号,按名字存(同 project 那一份:一个账号一条,多发几次就是几个)。 */
  const accountAnswers = (): Record<string, AccountAnswer> =>
    (answersOf('projects').account as Record<string, AccountAnswer> | undefined) ?? {}

  function answeredKeys(): Record<string, string[]> {
    const out: Record<string, string[]> = {}
    for (const [stage, keys] of Object.entries(state.answers)) {
      const names = Object.keys(keys)
      if (names.length > 0) out[stage] = names
    }
    return out
  }

  function answeredCount(): number {
    return Object.values(answeredKeys()).reduce((sum, keys) => sum + keys.length, 0)
  }

  /**
   * 前面几段已经答过的授权项(2026-09-23 Z)。现在只有 ②′ 会提前答授权(读目录、读客户端文件),
   * ③ 授权段据此不再问它们(见 onboardingStages.withCarriedConsent)。
   */
  function carriedConsent(): Record<string, unknown> {
    // 「重来授权这一段」(plan = ['authorization','done'])就是要整段重问 —— 不带前面的。
    if (!state.plan.includes('projects')) return {}
    const earlier = answersOf('projects')
    const out: Record<string, unknown> = {}
    for (const key of [...AUTH_READ_KEYS, ...AUTH_WRITE_KEYS]) {
      if (earlier[key] !== undefined) out[key] = earlier[key]
    }
    return out
  }

  function nextInfo(): { label: string, seed: string, goals: readonly string[], keys: string[] } | undefined {
    if (state.stage === 'done') return undefined
    const def = stageDef(state.stage, state.mode, state.template, carriedConsent(), factsNow())
    return { label: def.label, seed: def.seed, goals: def.goals, keys: Object.keys(def.keys) }
  }

  // ———————————————————————— 复述清单(不编数) ————————————————————————

  function authLine(): string {
    const parts: string[] = []
    const read = AUTH_READ_KEYS.map(key => [key, answersOf('projects')[key] ?? answersOf('authorization')[key]] as const)
      .filter(([, value]) => typeof value === 'boolean')
    if (read.length > 0) parts.push(`读:${read.map(([key, value]) => `${AUTH_SHORT[key]}${value === true ? '可以' : '不可以'}`).join('、')}`)
    const write = AUTH_WRITE_KEYS.map(key => [key, answersOf('authorization')[key]] as const)
      .filter(([, value]) => typeof value === 'string')
    if (write.length > 0) parts.push(`写:${write.map(([key, value]) => `${AUTH_SHORT[key]}${value as string}`).join('、')}`)
    return parts.length === 0 ? '还没答' : parts.join(';')
  }

  function recap(): string {
    const lines: string[] = []
    lines.push(`- 称呼:${state.nickname ?? '还没答'}`)
    const idea = ideaAnswer()
    const projects = projectAnswers()
    const confirmed = Object.entries(projects).filter(([, project]) => project.later !== true).map(([name]) => name)
    const later = Object.entries(projects).filter(([, project]) => project.later === true).map(([name]) => name)
    if (state.mode === 'fresh') {
      lines.push(`- 重心:从零开始${idea === undefined ? '' : `——「${idea.name}」:${idea.one_liner}(阶段 ${idea.stage})`}`)
    }
    else if (state.mode === 'existing') {
      lines.push(`- 重心:已有项目;确认了 ${confirmed.length} 个${confirmed.length > 0 ? `(${confirmed.join('、')})` : ''}${later.length > 0 ? `,稍后再聊 ${later.length} 个(${later.join('、')})` : ''}`)
    }
    else {
      lines.push('- 重心:还没答')
    }
    if (state.template !== undefined) lines.push(`- 布局:${templateName(state.template)}`)
    lines.push(`- 授权:${authLine()}`)
    const habits = answersOf('habits')
    const prefs = [
      ['节奏', habits.rhythm], ['汇报', habits.report_pref], ['渠道', habits.channel], ['音乐', habits.music], ['其它', habits.other],
    ].filter(([, value]) => typeof value === 'string') as [string, string][]
    const appsRecap = commonAppsLine()
    if (appsRecap !== undefined) prefs.push(['常用应用', appsRecap])
    lines.push(`- 偏好:${prefs.length === 0 ? '还没答' : prefs.map(([label, value]) => `${label} ${value}`).join(';')}`)
    const persona = answersOf('persona')
    if (typeof persona.persona === 'string') {
      lines.push(`- 对话方式:${persona.persona},直言度 ${String(persona.candor)}/5,话量 ${String(persona.verbosity)}/5${typeof persona.persona_note === 'string' ? `;${persona.persona_note}` : ''}`)
    }
    const butlerName = str('naming', 'butler_name')
    if (butlerName !== undefined) lines.push(`- 名字:${butlerName}`)
    const unsure = [
      ...Object.entries(projects).flatMap(([name, project]) => (project.unsure ?? []).map(item => `${name}:${item}`)),
      ...((answersOf('wrapup').unsure as string[] | undefined) ?? []),
    ]
    lines.push(`- 拿不准:${unsure.length === 0 ? '无' : unsure.join(';')}`)
    // 2026-09-24 晚(卡 feat/onboarding-materialize):「收尾那两句」(「以后我叫你 X……」+「今天记下的几份在 docs/记忆/……」)拿掉了 ——
    // 真机上她照着念出了文件路径。收尾只说落地那一句(「都摆好了……行吗?」/「派出去了,做完叫你。」),**永不念文件路径**。
    return lines.join('\n')
  }

  // ———————————————————————— 用户文件 ————————————————————————

  async function writeUserFile(): Promise<void> {
    const relative = userFileRel()
    if (relative === undefined) return
    const nickname = state.nickname as string
    let text = await readOr(relative, () => newUserFile(nickname))
    const later = Object.entries(projectAnswers()).filter(([, project]) => project.later === true).map(([name]) => name)
    const progress = `> 引导进度:${STAGE_LABEL[state.stage]} · 已答 ${answeredCount()} 项 · ${state.updatedAt}${later.length > 0 ? ` · 稍后再聊:${later.join('、')}` : ''}`
    text = upsertMarkedBlock(text, PROGRESS_BLOCK, progress, 'afterTitle')
    text = upsertMarkedBlock(text, RECORD_BLOCK, recordBlock(), 'end')
    // 拷过别家记忆才有这一段。**没拷过就一个字不写** —— 一段空的「外部记忆」
    // 会被下一个人读成"拷过了、是空的",而事实是他压根没答应过这一问。
    const memoryIndex = state.memory_index ?? []
    if (memoryIndex.length > 0) {
      text = upsertMarkedBlock(text, MEMORY_BLOCK, ['## 从别家拷过来的记忆', '', ...memoryIndex].join('\n'), 'end')
    }
    await writeRel(relative, text)
  }

  /**
   * 称呼改了:把已经写下的那份记忆改过来(2026-09-20)。
   *
   * 三样一起改,少一样都会留下一个用错名字的现场:
   *   ① **文件名** `用户-旧.md` → `用户-新.md`(内容一字不丢,git 自己把它认成一次改名)。
   *      挪不动(权限、跨卷)就**写新的、把旧的改成一行指路**,而不是删掉它 ——
   *      「不删任何文件」那条纪律照旧(文件头第一条),而两份内容打架的用户文件比一行指路糟得多。
   *   ② **标题行** `# 用户:旧` → `# 用户:新`,和紧随的那句导语里的称呼。**只改这两处**:
   *      正文里「本」这种字可能是他自述里的普通字,全文替换会改坏他自己说的话。
   *   ③ AGENTS.md 的「说话方式」标记段里那行「叫他「X」」—— 由调用方随后的 writeAgents 带上。
   *
   * 旧称呼没有文件(还没写过)时什么都不做,回 undefined。
   */
  async function renameUserFile(from: string, to: string): Promise<string | undefined> {
    const oldName = safeName(from)
    const newName = safeName(to)
    if (oldName === undefined || newName === undefined || oldName === newName) return undefined
    const oldRel = rel(`用户-${oldName}.md`)
    const newRel = rel(`用户-${newName}.md`)
    if (!(await exists(abs(oldRel)))) return undefined
    const text = await readFile(abs(oldRel), 'utf8')
    const renamedText = text
      .replace(new RegExp(`^# 用户:${escapeRe(oldName)}$`, 'm'), `# 用户:${newName}`)
      .replace(new RegExp(`^(> 两段.*)$`, 'm'), line => line.split(oldName).join(newName))
    /**
     * 改名用 `rename`,**不用 `git mv`**:`git mv` 会把旧路径从索引里一并摘掉,
     * 随后 `git add -- <旧路径>` 就再也匹配不到任何东西(本机实测,那一次提交整个失败了)。
     * `rename` 之后旧路径在 HEAD 里还在,`git add -A -- 两条路径` 正好把「删一条、加一条」
     * 一起记上,git 自己会把它认成一次改名(内容一字未改)。
     */
    let moved = false
    try {
      await mkdir(dirname(abs(newRel)), { recursive: true })
      await rename(abs(oldRel), abs(newRel))
      moved = true
    }
    catch {
      moved = false
    }
    await writeRel(newRel, renamedText)
    if (!moved) {
      // 挪不动(权限、跨卷):新的照写,旧的**不删**,内容换成一行指路 ——
      // 两份打架的用户记忆比一行指路糟得多。
      await writeRel(oldRel, `# 用户:${oldName}(称呼改了)\n\n> 这个称呼是听错的,已经改成「${newName}」。现在的记忆在 [用户-${newName}.md](用户-${newName}.md)。\n`)
      return `记忆文件改名了:用户-${oldName}.md → 用户-${newName}.md(旧的那份挪不动,留了一行指路,没删)`
    }
    dirty.add(oldRel)
    return `记忆文件改名了:用户-${oldName}.md → 用户-${newName}.md(内容一个字没丢)`
  }

  /**
   * 他点头了的那份方案(2026-09-20)。**`confirmed !== true` 一条事项都不建** ——
   * 「先念给他听、他确认了才落成事项」是这一项存在的全部理由。
   *
   * 没确认的照样写进项目文件的「下一步」(那不是替他做主,那是记下我们聊到哪了),
   * 并如实回一句「还没建事项」,让她照着告诉他。
   */
  async function writePlan(plan: PlanAnswer): Promise<string | undefined> {
    const who = state.nickname ?? '用户'
    const origin = `引导排的方案,${who}${plan.confirmed ? '当场确认' : '还没确认'},${today()}`
    const lines = plan.items.map((item, index) =>
      `- ${index + 1}. ${item.title}${item.when === undefined ? '' : `(${item.when})`}${item.why === undefined ? '' : ` —— ${item.why}`}(${origin})`)
    if (await exists(abs(rel('项目', `${plan.project}.md`)))) {
      let text = await readFile(abs(rel('项目', `${plan.project}.md`)), 'utf8')
      for (const line of lines) text = appendUnderSection(text, '下一步', line)
      if (plan.note !== undefined) text = appendUnderSection(text, '下一步', `- 他改过的地方:${plan.note}(${origin})`)
      await writeRel(rel('项目', `${plan.project}.md`), text)
    }
    if (!plan.confirmed) return '方案记进项目文件的「下一步」了,**没有建事项**(他还没点头)。念给他听、他说行了再交一次 confirmed=true。'
    if (options.tasks === undefined) return `方案记下了,但事项没建:任务看板未接线(${plan.items.length} 条都只写进了项目文件)`
    const created: string[] = []
    const failed: string[] = []
    // 同一条只建一次(见 plan_tasks 的注释):方案可以改,看板上不该多出一份重复的活儿。
    const before = new Set(state.plan_tasks?.[plan.project] ?? [])
    const skipped: string[] = []
    /**
     * 2026-09-24 晚(卡 feat/onboarding-materialize):同一件事换个说法又交了一遍(「让事务官能自己扫仓库,不用口述」
     * 与「让她能自己扫仓库,不用你口述」),按内容认成同一条 —— 看板上还开着的卡也算。
     * 提到的版本比仓库现在旧的(「查 0.2.80 ……」,仓库已经 0.2.83)是照搬旧交接的,**不建**,如实说一句让她问他。
     */
    let open: string[] = []
    try { open = (await options.tasks.list()).tasks.filter(task => task.status !== 'done' && task.status !== 'canceled').map(task => task.title) }
    catch { open = [] }
    const projectPath = projectAnswers()[plan.project]?.path
    let current: string | undefined
    try { current = projectPath === undefined ? undefined : await options.version?.(projectPath) }
    catch { current = undefined }
    const stale: string[] = []
    for (const item of plan.items) {
      if (before.has(item.title)) { skipped.push(item.title); continue }
      if ([...before, ...open].some(title => titleSimilarity(title, item.title) >= SAME_TITLE)) { skipped.push(item.title); continue }
      const old = staleVersionOf(`${item.title} ${item.why ?? ''}`, current)
      if (old !== undefined) { stale.push(`${item.title}(提到 ${old})`); continue }
      try {
        const result = await options.tasks.create({
          title: item.title,
          desc: `引导 ②′ 排的方案「${plan.project}」${item.when === undefined ? '' : `,${item.when}`}${item.why === undefined ? '' : `。${item.why}`}`,
          direction: 'mine',
          // 出处说明在 desc 里,不是他说的话 —— 固化提议不数它(2026-09-25)。
          origin: 'onboarding',
          status: 'todo',
        })
        if (result.ok && result.id !== undefined) { created.push(item.title); before.add(item.title) }
        else failed.push(`${item.title}(${result.reason ?? '看板拒绝'})`)
      }
      catch (error) {
        failed.push(`${item.title}(${error instanceof Error ? error.message.split('\n')[0] ?? '' : String(error)})`)
      }
    }
    state.plan_tasks = { ...state.plan_tasks, [plan.project]: [...before] }
    const again = skipped.length === 0 ? '' : `;这 ${skipped.length} 条前面已经建过了,没重复建(${skipped.join('、')})`
    const old = stale.length === 0 ? '' : `;这 ${stale.length} 条提到的版本比仓库现在(${current as string})旧,像是照搬旧交接的,没建:${stale.join('、')} —— 问他一句还要不要,别直接排进去`
    if (failed.length === 0) return `方案确认了,建了 ${created.length} 条事项${again}${old}`
    return `方案确认了,建了 ${created.length} 条事项${again}${old};这几条没建成:${failed.join(';')}——如实告诉他`
  }

  /** 已经记下的截止日,给日历那一段用。没有就是空数组(不编一个日期)。 */
  function knownDeadlines(): { label: string, date: string }[] {
    const out: { label: string, date: string }[] = []
    for (const [name, project] of Object.entries(projectAnswers())) {
      const iso = isoDateIn(project.deadline, today())
      if (iso !== undefined) out.push({ label: `${name} 的截止日`, date: iso })
    }
    return out
  }

  /** 日历那一段。今天算不出来(不该发生)就整格缺席。 */
  function calendar(): string | undefined {
    return calendarBrief(today(), knownDeadlines())
  }

  /** 「常用应用:Claude、微信;没认出来的:飞书」。一项都没答过就缺席。 */
  function commonAppsLine(): string | undefined {
    const labels = state.app_labels ?? []
    const custom = state.custom_apps ?? []
    if (labels.length === 0 && custom.length === 0) return undefined
    const parts: string[] = []
    if (labels.length > 0) parts.push(labels.join('、'))
    if (custom.length > 0) parts.push(`没认出来的:${custom.join('、')}`)
    return parts.join(';')
  }

  function recordBlock(): string {
    const lines: string[] = ['## 引导记录(阶段机按当场回答生成,整段重写)', '']
    lines.push(`- 称呼:${state.nickname ?? '待答'}`)
    const intro = str('habits', 'self_intro')
    if (intro !== undefined) lines.push(`- 自述(引导时口述):${intro}`)
    const idea = ideaAnswer()
    if (state.mode !== undefined) {
      lines.push(`- 重心:${state.mode === 'fresh' ? `从零开始${idea === undefined ? '' : `——${idea.name}`}` : '已有项目'}`)
    }
    const habits = answersOf('habits')
    const prefs = [
      ['工作节奏', habits.rhythm], ['汇报偏好', habits.report_pref], ['语音 / 文字 / 形象', habits.channel],
      ['音乐口味(供 AIDJ 建歌单)', habits.music], ['其它', habits.other],
    ].filter(([, value]) => typeof value === 'string') as [string, string][]
    const appsLine = commonAppsLine()
    if (appsLine !== undefined) prefs.push(['常用应用', appsLine])
    if (state.template !== undefined) prefs.unshift(['布局模板', templateName(state.template)])
    if (prefs.length > 0) {
      lines.push('', '### 偏好')
      for (const [label, value] of prefs) lines.push(`- ${label}:${value}`)
    }
    const persona = answersOf('persona')
    if (typeof persona.persona === 'string') {
      lines.push('', '### 对话预期')
      lines.push(`- 人设:${persona.persona};直言度 ${String(persona.candor)}/5;话量 ${String(persona.verbosity)}/5`)
      if (typeof persona.persona_note === 'string') lines.push(`- 自己的描述:${persona.persona_note}`)
      lines.push('- 规矩:包装可以俏皮,内容不能打折;坏消息上不耍宝')
    }
    const butlerName = str('naming', 'butler_name')
    if (butlerName !== undefined) lines.push('', `### 事务官的名字`, `- ${butlerName}(随时可改)`)
    const wrapup = answersOf('wrapup')
    if (Object.keys(wrapup).length > 0) {
      lines.push('', '### 汇报节奏')
      if (typeof wrapup.morning_report === 'boolean') lines.push(`- 早上先汇报再干活:${wrapup.morning_report ? '是' : '否'}`)
      if (typeof wrapup.evening_routine === 'string') lines.push(`- 下班例程:${wrapup.evening_routine}`)
      // 2026-09-21(资讯与播客):答了才写这一行。没答 = 还没问过,不是"他说不要"。
      if (typeof wrapup.feed_podcast === 'boolean') lines.push(`- 每天早上的资讯播客:${wrapup.feed_podcast ? '要' : '不要'}(关注什么在设置「资讯偏好」里改)`)
      if (typeof wrapup.first_item === 'string') lines.push('', '### 第一条事项建议(只建议,没建事项)', `- ${wrapup.first_item}`)
      const unsure = wrapup.unsure as string[] | undefined
      if (unsure !== undefined && unsure.length > 0) {
        lines.push('', '### 拿不准')
        for (const item of unsure) lines.push(`- ${item}`)
      }
    }
    return lines.join('\n')
  }

  // ———————————————————————— 项目文件 ————————————————————————

  async function ensureProjectFile(name: string, input: { oneLiner?: string, stage?: string, goal?: string, deadline?: string, origin: string }): Promise<string> {
    const relative = rel('项目', `${name}.md`)
    if (await exists(abs(relative))) return await readFile(abs(relative), 'utf8')
    const text = newProjectFile(name, { ...input, date: today() })
    await writeRel(relative, text)
    const indexRel = rel('项目', '索引.md')
    const index = await readOr(indexRel, () => '# 项目索引\n\n| 项目 | 一句话 | 阶段 | 最近活动 | 路径 | 文件 |\n|---|---|---|---|---|---|\n')
    await writeRel(indexRel, appendIndexRow(index, `| ${name} | ${input.oneLiner ?? '待梳理'} | ${input.stage ?? '待梳理'} | 引导建档 ${today()} | 待定 | [项目/${name}.md](项目/${name}.md) |`))
    return text
  }

  /**
   * 引导录的项目 = 项目区的那一条(2026-09-23)。项目文件与索引行写上路径,项目区那边按路径认领同一行。
   * 认领失败不挡引导:项目文件已经写好了,如实说一句项目区里可能要他自己对一下。
   */
  async function adoptProject(name: string, path: string): Promise<string | undefined> {
    const relative = rel('项目', `${name}.md`)
    try {
      await writeRel(relative, upsertProjectField(await readFile(abs(relative), 'utf8'), '路径', `\`${path}\``))
      const indexRel = rel('项目', '索引.md')
      const index = await readOr(indexRel, () => '')
      const rows = index.split('\n').map((line) => {
        if (!line.startsWith(`| ${name} |`)) return line
        const cells = line.split('|').map(cell => cell.trim())
        if (cells.length < 7) return line
        cells[5] = `\`${path}\``
        return `| ${cells.slice(1, -1).join(' | ')} |`
      })
      await writeRel(indexRel, rows.join('\n'))
    }
    catch { /* 文件写不上不挡认领项目区那一条 */ }
    if (options.projects === undefined) return '这台工作台没接项目区,项目区里这一条要等它自己扫到(名字可能不一样)。'
    try {
      await options.projects.adopt({ name, path })
      return undefined
    }
    catch (err) {
      return `项目文件写好了,但项目区那一条没认上(${err instanceof Error ? err.message : String(err)}),项目区里可能暂时是另一个名字。`
    }
  }

  /**
   * 这一条 project 是不是「她读了仓库、复述、他点头」之后记的(2026-09-24 下午小修「出处写对」)。**按事实判,不靠模型报**:
   *   ① 这一次引导里读过这个 path 的摘要({@link OnboardingService.noteBriefRead},30 分钟内),这一条记在读之后;
   *      path 看合并后的那一份 —— 后面只补一句 next_step 的,认前面带过的 path;
   *   ② 他刚才那句只是点头、或在她念的几件里挑一件(projectBrief.ts `confirmsOnly`)。
   *      **他在确认时改了说法、补了自己的话,仍按「他说」记**;拿不到他那句话(老调用方)只看 ①。
   * 更正(/onboarding/correct)一律按「他说」:改,就是他改的。
   */
  function projectSource(merged: ProjectAnswer, context: AnswerContext | undefined): 'brief' | 'said' {
    if (context?.correcting === true) return 'said'
    const key = briefPathKey(merged.path, homeDir())
    const readAt = key === undefined ? undefined : briefReads.get(key)
    if (readAt === undefined) return 'said'
    const since = now().getTime() - readAt
    if (since < 0 || since > SURFACED_TTL_MS) return 'said'
    const heard = context?.heard
    if (heard !== undefined && !confirmsOnly(heard, [merged.name, projectNameOf(merged.path as string)])) return 'said'
    return 'brief'
  }

  async function writeProject(project: ProjectAnswer, source: 'brief' | 'said' = 'said'): Promise<void> {
    const who = state.nickname ?? '用户'
    const origin = `引导访谈,${who}口述,${today()}`
    /**
     * 读了仓库、他点头的那几句按事实标(2026-09-24 下午小修):她复述的是一句话 / 现在到哪 / 下一步,
     * 所以只有这三项(和这一下建档的那一行)标「读仓库说明,他确认」;阶段、目标、截止日、细节、拿不准是文档里没有、问他的,照旧「他口述」。
     */
    const confirmed = source === 'brief' ? `读仓库说明,${who}确认,${today()}` : origin
    let text = await ensureProjectFile(project.name, {
      ...(project.one_liner === undefined ? {} : { oneLiner: project.one_liner }),
      ...(project.stage === undefined ? {} : { stage: project.stage }),
      ...(project.vision === undefined ? {} : { goal: project.vision }),
      ...(project.deadline === undefined ? {} : { deadline: project.deadline }),
      origin: confirmed,
    })
    // 当场答即拍板:四个字段直接写,不进待拍板。
    if (project.one_liner !== undefined) text = upsertProjectField(text, '一句话', `${project.one_liner}(${confirmed})`)
    if (project.stage !== undefined) text = upsertProjectField(text, '阶段', `${project.stage}(${origin})`)
    if (project.vision !== undefined) text = upsertProjectField(text, '目标', `${project.vision}(${origin})`)
    if (project.deadline !== undefined) text = upsertProjectField(text, '截止日', `${project.deadline}(${origin})`)
    // 其余只追加。
    if (project.status !== undefined) text = appendUnderSection(text, '进展', `- ${today()}:${project.status}(${confirmed})`, 'top')
    if (project.details !== undefined) text = appendUnderSection(text, '细节(关键决定 / 不能碰的 / 合作的人与 Agent)', `- ${today()}:${project.details}(${origin})`)
    if (project.next_step !== undefined) text = appendUnderSection(text, '下一步', `- ${project.next_step}(${confirmed})`)
    for (const item of project.unsure ?? []) text = appendUnderSection(text, '风险', `- 拿不准:${item}(${origin})`)
    await writeRel(rel('项目', `${project.name}.md`), text)
  }

  /**
   * 一个账号落成 `<工作目录>/账号/<名>/账号.md` + 空的 `笔记/`(2026-09-21)。
   *
   * 这是运营模板下 ②′ 与项目区之间的那根线:写的正是 `server/accountSource.ts` 读的地方,
   * 所以答完**下一拍**(工作台每秒轮询一次 /state)账号就出现在项目区里。
   *
   * 英文字段名 → `账号.md` 里的中文表头的对应关系**只在这一处**写着
   * (键在 onboardingStages.AccountAnswer,表头在 accounts.ACCOUNT_FIELDS)。
   */
  async function writeAccount(account: AccountAnswer): Promise<string | undefined> {
    if (options.accounts === undefined) {
      // 如实说。最坏的失真是"答应了但其实没记"——模型会转头告诉他「记下了」。
      return '这台工作台还没配工作目录,账号文件没落盘(答案记在引导进度里了)。'
    }
    const result = await options.accounts.write({
      name: account.name,
      date: today(),
      fields: {
        ...(account.positioning === undefined ? {} : { 定位: account.positioning }),
        ...(account.style === undefined ? {} : { 风格: account.style }),
        ...(account.audience === undefined ? {} : { 人群: account.audience }),
        ...(account.platform === undefined ? {} : { 平台: account.platform }),
        ...(account.opened_at === undefined ? {} : { 开号日期: account.opened_at }),
      },
    })
    if (!result.ok) return `账号没记成:${result.reason ?? '未知原因'}`
    return result.created === true
      ? `账号「${account.name}」建好了(${result.path}),项目区里下一拍就能看到它。`
      : undefined
  }

  async function writeIdea(idea: IdeaAnswer): Promise<string | undefined> {
    const who = state.nickname ?? '用户'
    const origin = `引导 B 线点子访谈,${who}口述,${today()}`
    let text = await ensureProjectFile(idea.name, { oneLiner: idea.one_liner, stage: idea.stage, ...(idea.problem === undefined ? {} : { goal: idea.problem }), origin })
    text = upsertProjectField(text, '一句话', `${idea.one_liner}(${origin})`)
    text = upsertProjectField(text, '阶段', `${idea.stage}(${origin})`)
    // 2026-09-27(卡 OB):一句话就收之后,目标 / 手上有什么 / 第一步都可能还没聊到 ——
    // **缺的那一项整行不写**(不写一行「目标:undefined」,也不编一句)。
    if (idea.problem !== undefined) text = upsertProjectField(text, '目标', `${idea.problem}(${origin})`)
    if (idea.assets !== undefined) text = appendUnderSection(text, '进展', `- ${today()}:手上有:${idea.assets}(${origin})`, 'top')
    if (idea.first_step !== undefined) text = appendUnderSection(text, '下一步', `- ${idea.first_step}(${origin})`)
    await writeRel(rel('项目', `${idea.name}.md`), text)
    // B2 立项的第一个事项(方向 = 我交给事务官)。没接看板就建不了,如实回一句。
    // 第一步还没聊到就**不建事项** —— 事项的标题只能是他说过的话。
    if (idea.first_step === undefined) return undefined
    if (options.tasks === undefined) return '第一个事项没建:任务看板未接线'
    const created = await options.tasks.create({
      title: idea.first_step,
      desc: `引导 B2 立项「${idea.name}」的第一步。${idea.one_liner}`,
      direction: 'mine',
      origin: 'onboarding',
      status: 'todo',
    })
    if (!created.ok || created.id === undefined) return `第一个事项没建:${created.reason ?? '看板拒绝'}`
    // 记在答案之外:它不是用户答的,不该出现在「已经答过」里。
    state.first_task_id = created.id
    return undefined
  }

  // ———————————————————————— 常用应用(窗位清单) ————————————————————————

  /**
   * 「你平时最常开哪几个应用?」这一答的落地(2026-09-18)。
   *
   * 认得出的键写进 `apps.json` 的 `enabled` —— **首次不自动认领**那条规矩下(见 appsRegistry 的
   * `baseKeyVisible`),这就是窗位清单出现的方式,下一拍 `/state.apps` 就有标签。
   * 认不出的原样留在 `custom_apps` 给人看,**不猜一个键**(D13);办没办成都回一句人话,
   * 让模型照实告诉他 —— 最坏的失真是"答应了但其实没记"。
   */
  async function applyApps(names: readonly string[]): Promise<{ keys: string[], note?: string }> {
    const known = (await options.apps?.known()) ?? []
    const { keys, custom } = resolveAppKeys(names, known)
    const labelOf = new Map(known.map(app => [app.key, app.label]))
    state.app_labels = keys.map(key => labelOf.get(key) ?? BASE_APP_LABELS[key] ?? key)
    if (custom.length > 0) state.custom_apps = custom
    else delete state.custom_apps

    const notes: string[] = []
    if (custom.length > 0) {
      notes.push(`${custom.join('、')} 认不出是哪个应用,原样记下来了,没放进窗口槽——他要的话,把那扇窗拖进窗位就认领上了`)
    }
    if (keys.length === 0) return { keys, ...(notes.length === 0 ? {} : { note: notes.join(';') }) }
    if (options.apps === undefined) {
      notes.push('窗位清单没接线(这台服务没接 apps.json),这几个应用只记在记忆里,没写进窗口槽')
      return { keys, note: notes.join(';') }
    }
    try {
      const result = await options.apps.enable(keys)
      if (result.unknown.length > 0) notes.push(`窗位清单不认识这几个键:${result.unknown.join('、')}`)
      const listed = keys.filter(key => !result.unknown.includes(key)).map(key => labelOf.get(key) ?? BASE_APP_LABELS[key] ?? key)
      // 2026-09-24 晚(卡 C 提的,卡 B 改):以前这里没有话,模型就当「摆好了」—— 真机上她说「窗口槽摆好了」,其实窗一扇没拉进来。
      if (listed.length > 0) {
        notes.unshift(`记进窗口槽清单了:${listed.join('、')}(标签出来了,窗还没拉进来,收尾落地时拉;拉不进来的标签上写「点一下拉进来」)。别说「摆好了」`)
      }
    }
    catch (error) {
      notes.push(`窗位清单没写进去:${error instanceof Error ? error.message.split('\n')[0] ?? '' : String(error)}`)
    }
    return { keys, ...(notes.length === 0 ? {} : { note: notes.join(';') }) }
  }

  /** 扫到装了的那几家(展示名)。没扫过 / 没接窗位清单就 undefined —— 不冒充「一家都没装」。 */
  async function installedAppNames(): Promise<{ key: string, label: string }[] | undefined> {
    const installed = options.apps?.installed?.()
    if (installed === undefined) return undefined
    const known = (await options.apps?.known()) ?? []
    const labelOf = new Map(known.map(app => [app.key, app.label]))
    return installed.map(key => ({ key, label: labelOf.get(key) ?? BASE_APP_LABELS[key] ?? key }))
  }

  // ———————————————————————— 授权 / AGENTS.md ————————————————————————

  /**
   * ②′ 那一问的落地(2026-09-21):他点头了就真去拷一趟,摇头就只记一行。
   *
   * 回的那一句**原样**交给模型去念(阶段机自己不编数):拷了几份、哪几家没找到,
   * 都是 `importAgentMemories` 数出来的。没接这一档(测试、老接线)就如实说一句
   * "记下了,但没拷" —— 不让模型转头跟用户说「已经拷好了」(D13)。
   */
  /**
   * 拷别家记忆之前的那道门(2026-09-22,Ben 定的 C5)。
   *
   * 授权表里 `read_client_files` **不是「可以」就一个字节都不拷**,并如实说一句现在是哪一档。
   * 为什么这一条要过授权表、而 `/onboarding/*` 其余几条不过:那几条写的是**他自己刚说的话**,
   * 而这一条要去**读他电脑上别的软件的文件** —— 那正是授权表存在的理由。
   * 「要问」这一档在代码里与「不可以」同样拦住:代码问不了他,问他的是对话里那一句。
   */
  async function clientFilesAllowed(): Promise<{ ok: boolean, status: AuthStatus }> {
    let status: AuthStatus = '未答'
    try { status = (await options.authorization.get()).read_client_files.status }
    catch { status = '未答' }
    return { ok: status === '可以', status }
  }

  /** 不是「可以」时那句原话。按钮那条路与电话里那条路**说的是同一句**。 */
  function notAllowedLine(status: AuthStatus): string {
    return `没拷:授权表里「${AUTH_KEY_DESC.read_client_files}」现在是「${status}」,`
      + '不是「可以」。要我拷的话,在这一问上答「可以」(或者 Ben 直接改 docs/记忆/授权.md)。原件一个字没动。'
  }

  /**
   * 拷一趟,并把「这一趟真写了哪几份」带出来(2026-09-22)。
   *
   * 界面上那颗按钮可以重复点,所以 `written` / `added` 不能丢在这一层:
   * 点完屏幕上要写得出「写了哪几份」,第二次点要说得出「没有新的」。
   */
  async function runMemoryImportDetailed(wanted: boolean): Promise<{
    ok: boolean
    note: string
    written: readonly string[]
    added: readonly string[]
  }> {
    const nothing = { written: [] as readonly string[], added: [] as readonly string[] }
    if (!wanted) return { ok: true, note: '记下了:不拷别家的记忆。这一问往后不再问第二遍。', ...nothing }
    const allowed = await clientFilesAllowed()
    if (!allowed.ok) return { ok: false, note: notAllowedLine(allowed.status), ...nothing }
    // 没接这一档:**照旧算答过了**(`ok:true`)—— 他答的那句话记下来了,只是这台机器上
    // 没有人去拷。这与 C5 那道门不是一回事,别混:那一条是"他还没放行",这一条是"没人接线"。
    if (options.memories === undefined) {
      return { ok: true, note: '记下了,但这台工作台没接「拷别家记忆」这一档,一份都没拷。', ...nothing }
    }
    let result: Awaited<ReturnType<OnboardingMemoryDeps['importAll']>>
    try { result = await options.memories.importAll() }
    catch (error) {
      // 拷不成是真事,不许吞。他听到的必须是"没拷成",不是一句含糊的"好了"。
      return { ok: false, note: `没拷成:${error instanceof Error ? error.message : String(error)}。原件一个字没动。`, ...nothing }
    }
    for (const relative of result.written) dirty.add(relative)
    if (result.index.length > 0) state.memory_index = [...result.index]
    return {
      ok: true,
      note: result.line,
      written: [...result.written],
      added: [...(result.added ?? result.written)],
    }
  }

  async function runMemoryImport(wanted: boolean): Promise<string | undefined> {
    return (await runMemoryImportDetailed(wanted)).note
  }

  async function writeAuth(key: string, value: unknown): Promise<void> {
    const status: AuthStatus = typeof value === 'boolean' ? (value ? '可以' : '不可以') : value as AuthStatus
    await options.authorization.set(key as never, status, today())
    // 授权.md 在仓库里,推进时一并 commit(文件路径相对仓库根)。
    if (options.authorization.file.startsWith(options.repoRoot)) {
      dirty.add(options.authorization.file.slice(options.repoRoot.length).replace(/^\//, ''))
    }
  }

  async function writeAgents(input: { name?: boolean, style?: boolean }): Promise<void> {
    const persona = answersOf('persona')
    const butlerName = str('naming', 'butler_name') ?? '事务官'
    const hasStyle = typeof persona.persona === 'string'
    const styleSection = input.style === true && hasStyle
      ? speakingStyleSection({
          persona: persona.persona as Persona,
          candor: persona.candor as number,
          verbosity: persona.verbosity as number,
          ...(typeof persona.persona_note === 'string' ? { note: persona.persona_note } : {}),
          // 称呼进标记段(2026-09-20):改称呼时这一行跟着改,AGENTS.md 不会一直用听错的名字叫他。
          ...(state.nickname === undefined ? {} : { nickname: state.nickname }),
        }, butlerName)
      : undefined
    if (input.name !== true && styleSection === undefined) return
    let text = ''
    try {
      text = await readFile(options.agentsFile, 'utf8')
    }
    catch {
      text = ''
    }
    /**
     * 2026-10-01(卡「设置里集中改提示词」):**重跑引导不冲掉她在设置里改过的那两处**。
     * 这两支不走 `wbSkillMergeInto`(那是标记段那条腰眼),所以在这里各问一次覆盖层;
     * 没装覆盖层 / 她没改过时原样回引导算出来的那一份 —— 之前的行为一字不变。
     */
    const next = applyAgentsFile(text, {
      ...(input.name === true ? { butlerName: resolvePromptBody(PROMPT_NAME_SECTION, butlerName) } : {}),
      ...(styleSection === undefined ? {} : { styleSection: resolvePromptBody(SPEAKING_STYLE_BLOCK, styleSection) }),
    })
    if (next === text) return
    await mkdir(dirname(options.agentsFile), { recursive: true })
    const tmp = `${options.agentsFile}.${randomUUID()}.tmp`
    await writeFile(tmp, next, 'utf8')
    await rename(tmp, options.agentsFile)
  }

  // ———————————————————————— commit ————————————————————————

  async function commitStage(stage: OnboardingStage): Promise<{ ok: boolean, message: string, error?: string } | undefined> {
    if (dirty.size === 0) return undefined
    const files = [...dirty]
    dirty = new Set()
    const message = stage === 'wrapup' ? 'chore(记忆): 入职·收尾' : `chore(记忆): 引导·${stageDef(stage, state.mode, state.template).label}`
    try {
      // `-A`:这一批里可能有一条是**被改名挪走的**旧路径(改称呼那一下),
      // 不带 -A 的 `git add` 对着一个不存在的路径会整条失败。
      await git(['add', '-A', '--', ...files], options.repoRoot)
      await git(['commit', '-q', '-m', message, '--', ...files], options.repoRoot)
      state.commits.push({ stage, at: iso(), ok: true, message })
      return { ok: true, message }
    }
    catch (error) {
      const text = error instanceof Error ? error.message.split('\n')[0] ?? '' : String(error)
      state.commits.push({ stage, at: iso(), ok: false, message, error: text })
      // 没提交成的文件留在 dirty 里,下一次推进再试一次。
      for (const file of files) dirty.add(file)
      return { ok: false, message, error: text }
    }
  }

  /**
   * 更正的那一次提交(2026-09-20)。和 `commitStage` 共用 dirty 那一套,只有消息不一样
   * ——「引导·① 开场」看不出这是一次更正,而改称呼那次改动在仓库历史里必须一眼认得出来。
   */
  async function commitCorrection(stage: OnboardingStage, key: string): Promise<{ ok: boolean, message: string, error?: string } | undefined> {
    if (dirty.size === 0) return undefined
    const files = [...dirty]
    dirty = new Set()
    const message = `chore(记忆): 引导·更正 ${STAGE_LABEL[stage]} 的 ${key}`
    try {
      await git(['add', '-A', '--', ...files], options.repoRoot)
      await git(['commit', '-q', '-m', message, '--', ...files], options.repoRoot)
      state.commits.push({ stage, at: iso(), ok: true, message })
      return { ok: true, message }
    }
    catch (error) {
      const text = error instanceof Error ? error.message.split('\n')[0] ?? '' : String(error)
      state.commits.push({ stage, at: iso(), ok: false, message, error: text })
      for (const file of files) dirty.add(file)
      return { ok: false, message, error: text }
    }
  }

  // ———————————————————————— 阶段推进 ————————————————————————

  const currentStage = (): OnboardingStage => state.stage

  function stageComplete(): boolean {
    const answered = answersOf(state.stage)
    return requiredKeys(state.stage, state.mode, state.template, carriedConsent(), factsNow()).every(key => answered[key] !== undefined)
  }

  /** 算 AI 的那几个应用键(窗位槽自动放进去的就这几家)。 */
  const AI_APP_KEYS: readonly string[] = ['codex', 'claude', 'kimi', 'doubao']

  /**
   * 新骨架走到「完成」那一下(2026-09-27,卡 OB):**没问的那几项一次按默认落盘**。
   *
   * 每一项都走 `applyAnswer`(与他亲口答的走同一条路),所以授权表、AGENTS.md 的说话方式与名字、
   * 用户文件、窗位清单该动的都动了 —— 不是往 json 里偷偷塞几个键。
   * 回一句要念给他听的收尾话;已经答过的项一个都不覆盖。
   */
  async function applyFirstrunDefaults(): Promise<string | undefined> {
    if (!firstrun()) return undefined
    for (const one of FIRSTRUN_DEFAULTS) {
      if (answersOf(one.stage)[one.key] !== undefined) continue
      try { await applyAnswer(one.stage, one.key, one.value) }
      catch { continue }
    }
    // 「能不能看你放代码的目录」:已有那一支开、新点子那一支关(统筹盘点第 6 条)。
    if (answersOf('projects').read_scan_roots === undefined && answersOf('authorization').read_scan_roots === undefined) {
      try { await applyAnswer('authorization', 'read_scan_roots', scanRootsDefault(state.mode)) }
      catch { /* 没接授权表:答案照记,授权表由那一档自己说 */ }
    }
    // 窗位槽:本机探到的那几家 AI 直接放进去(**不问**;他随时能加减)。探不到就一个都不放,不编。
    if (answersOf('habits').apps === undefined) {
      const ai = ((await installedAppNames()) ?? []).filter(app => AI_APP_KEYS.includes(app.key)).map(app => app.label)
      if (ai.length > 0) {
        try { await applyAnswer('habits', 'apps', ai) }
        catch { /* 窗位清单没接线:同上 */ }
      }
    }
    return FIRSTRUN_CLOSING_LINE
  }

  /**
   * 喊停那一下的落地(2026-09-27,卡 OB)。**不在队列里**(两个调用方各自排队):
   * 剩下的按默认记完 → 阶段直接到「完成」→ 回那一句收尾话。他的内容一个字都不编。
   */
  async function skipRestInner(reason?: string): Promise<{ ok: true, stage: OnboardingStage, done: boolean, line: string, skipped: string[] }> {
    const already = state.stage === 'done'
    const at = state.plan.indexOf(state.stage)
    const skipped = already
      ? []
      : state.plan.filter((stage, index) => stage !== 'done' && index >= at).map(stage => STAGE_LABEL[stage])
    if (!already) {
      state.stage = 'done'
      state.done_at = iso()
      state.history.push({ at: iso(), event: `他喊停(${reason ?? '不耐烦'}):剩下的按默认记完,直接进页面(跳过 ${skipped.join('、')})` })
      await applyFirstrunDefaults()
      await writeUserFile()
      await save()
    }
    return { ok: true, stage: state.stage, done: true, line: FIRSTRUN_CLOSING_LINE, skipped }
  }

  /**
   * ⑤ 读记录那一问问不问(2026-09-27,卡 OB)。**两条都要满足才问**:
   * 分支 = 已经有在做的事,而且本机真探到有记录可读的 AI。
   * 不问就把它从计划里摘掉 —— 段数、`/state.onboarding` 的 step/steps、进度条跟着变。
   */
  function syncRecordsStage(): void {
    if (!firstrun()) return
    const names = factsNow().memoryFamilies
    // 还没探过(名单缺席):先留着这一格,探到了再定 —— 不拿"还不知道"把一问删掉。
    const keep = state.mode !== 'fresh' && (names === undefined || names.length > 0)
    const has = state.plan.includes('authorization')
    if (keep === has) return
    if (keep) {
      const plan = [...state.plan]
      plan.splice(Math.max(plan.indexOf('done'), 0), 0, 'authorization')
      state.plan = plan
      return
    }
    state.plan = planWithoutRecords(state.plan)
    if (state.stage === 'authorization') state.stage = 'done'
  }

  function advance(): void {
    syncRecordsStage()
    let index = state.plan.indexOf(state.stage)
    let next = state.plan[index + 1] ?? 'done'
    // 2026-09-23 顺序升级:老存档在「布局 → 分岔」时答过布局、停在分岔,升级后分岔答完下一格是布局 ——
    // 已经答过的不重问,直接跳过。只管这两格(其余阶段从不会预先答好)。
    while ((next === 'template' || next === 'branch') && requiredKeys(next, state.mode, state.template).every(key => answersOf(next)[key] !== undefined)) {
      index += 1
      next = state.plan[index + 1] ?? 'done'
    }
    state.stage = next
    if (next === 'done') {
      state.done_at = iso()
      // 补问的那个项目完成了,从名单里划掉。
      if (state.focus !== undefined) {
        state.supplement = state.supplement.filter(name => name !== state.focus)
        delete state.focus
      }
    }
  }

  /**
   * 刚收尾的那一段晚到的一项(2026-09-24 晚,卡 feat/onboarding-materialize)。见 {@link LATE_ANSWER_GRACE_MS}。
   * 认的条件都得满足:标的就是刚收尾的那一段、还在宽限期里、这一项是那一段的 key、不是 `done`、不是会改流程的(分岔 / 布局),
   * 而且那一段还没答过它(`project` / `account` 按名字合并,是加一个,照收)。认了:记进那一段、存盘、补一个提交,**不推进、不倒退**。
   * 不认 → undefined(照原来的路走,该 409 还是 409)。
   */
  async function lateAnswer(input: { stage?: unknown, key?: unknown, value?: unknown, heard?: AnswerContext['heard'] }): Promise<AnswerResult | undefined> {
    const finished = lastFinished
    if (finished === undefined || input.stage !== finished.stage || input.stage === state.stage) return undefined
    if (now().getTime() - finished.at > LATE_ANSWER_GRACE_MS) return undefined
    const key = input.key
    if (typeof key !== 'string' || key === 'done' || key === 'mode' || key === 'template') return undefined
    const def = stageDef(finished.stage, state.mode, state.template)
    const keyDef = def.keys[key]
    if (keyDef === undefined) return undefined
    // 当前这一段也收这个 key(比如授权的几项):按原来的路记在当前这一段,不抢。
    if (state.stage !== 'done' && stageDef(state.stage, state.mode, state.template).keys[key] !== undefined) return undefined
    const merging = key === 'project' || key === 'account'
    if (!merging && answersOf(finished.stage)[key] !== undefined) return undefined
    const checked = validateValue(keyDef.kind, input.value)
    if (!checked.ok) return { ok: false, status: 400, error: `${key}:${checked.error}` }
    let note: string | undefined
    try {
      note = await applyAnswer(finished.stage, key, checked.value, input.heard === undefined ? undefined : { heard: input.heard })
    }
    catch (error) {
      if (error instanceof AnswerError) return { ok: false, status: error.status, error: error.message }
      throw error
    }
    const lateNote = `「${STAGE_LABEL[finished.stage]}」那一段刚收尾,这一项晚到了一步,补记在那一段里(不倒回去)`
    const commit = await commitStage(finished.stage)
    state.leader_at = iso()
    await save()
    const stage = currentStage()
    const next = nextInfo()
    return {
      ok: true,
      stage,
      advanced: false,
      done: stage === 'done',
      ...(next === undefined ? {} : { next }),
      ...(stage === 'wrapup' || stage === 'done' ? { recap: recap() } : {}),
      ...(commit === undefined ? {} : { commit }),
      note: note === undefined ? lateNote : `${note};${lateNote}`,
    }
  }

  async function applyAnswer(stage: OnboardingStage, key: string, value: unknown, context?: AnswerContext): Promise<string | undefined> {
    let note: string | undefined
    if (stage === 'opening' && key === 'nickname') {
      const name = safeName(value)
      if (name === undefined) throw new AnswerError(400, '称呼要非空、不带路径分隔符,60 字以内')
      const before = state.nickname
      state.nickname = name
      // 改称呼(2026-09-20):已经写下的那份记忆要跟着改名,否则屏幕上会并排躺着两个用户文件,
      // 而其中一个用的是听错的名字。AGENTS.md 标记段里那行「叫他「X」」由下面的 writeAgents 带上。
      if (before !== undefined && before !== name) {
        note = await renameUserFile(before, name)
        await writeAgents({ style: true })
      }
    }
    if (stage === 'template' && key === 'template') {
      const id = String(value)
      state.template = id
      if (options.template === undefined) {
        // 没接模板服务:答案照记,但**如实说一句**布局没换 —— 不让模型以为已经换好了,
        // 转头跟用户说「已经给你摆成运营那一套了」(D13)。
        note = '记下了,但这台工作台没接布局模板服务,界面没有换。'
      }
      else {
        const applied = await options.template.apply(id)
        if (!applied.ok) note = `布局没换成:${applied.reason ?? '未知原因'}`
        else {
          const parts = ['布局已经换过去了。']
          if ((applied.folders_made ?? []).length > 0) parts.push(`工作目录下建好了:${(applied.folders_made ?? []).join('、')}。`)
          if (applied.apps_note !== undefined && applied.apps_note !== '') parts.push(applied.apps_note)
          note = parts.join('')
        }
      }
    }
    if (stage === 'branch' && key === 'mode') state.mode = value as OnboardingMode
    if (key === 'import_memories') note = await runMemoryImport(value === true)
    if (key.startsWith('read_') || key.startsWith('write_')) await writeAuth(key, value)
    if (key === 'account') {
      // 运营线 ②′(2026-09-21)。形状照着下面 project 那一支:按名字合并,`later` 的只记不落盘。
      const account = value as AccountAnswer
      const merged = { ...(accountAnswers()[account.name] ?? {}), ...account }
      state.answers[stage] = { ...answersOf(stage), account: { ...accountAnswers(), [account.name]: merged } }
      if (account.later !== true) note = await writeAccount(account)
    }
    else if (key === 'project') {
      const project = value as ProjectAnswer
      const merged = { ...(projectAnswers()[project.name] ?? {}), ...project }
      state.answers[stage] = { ...answersOf(stage), project: { ...projectAnswers(), [project.name]: merged } }
      if (project.later !== true) {
        await writeProject(project, projectSource(merged, context))
        if (project.path !== undefined) note = await adoptProject(project.name, project.path)
      }
    }
    else if (key === 'idea') {
      state.answers[stage] = { ...answersOf(stage), idea: value }
      note = await writeIdea(value as IdeaAnswer)
    }
    else if (key === 'plan') {
      const plan = value as PlanAnswer
      state.answers[stage] = { ...answersOf(stage), plan }
      note = await writePlan(plan)
    }
    else if (key === 'apps') {
      const applied = await applyApps(value as string[])
      // 存的是**键**(机器真相);展示名与认不出的那几个在 state.app_labels / state.custom_apps。
      state.answers[stage] = { ...answersOf(stage), apps: applied.keys }
      note = applied.note
    }
    else {
      state.answers[stage] = { ...answersOf(stage), [key]: value }
    }
    if (stage === 'persona') await writeAgents({ style: true })
    if (stage === 'naming') await writeAgents({ name: true, style: true })
    await writeUserFile()
    return note
  }

  return {
    async load() {
      try {
        const parsed = JSON.parse(await readFile(options.file, 'utf8')) as OnboardingFile
        if (parsed?.version === 1 && typeof parsed.stage === 'string' && Array.isArray(parsed.plan)) {
          state = { ...fresh(), ...parsed, supplement: parsed.supplement ?? [], commits: parsed.commits ?? [], history: parsed.history ?? [] }
          // 2026-09-23:老顺序(布局在分岔前)的存档升级成新顺序,已答的不丢不重问。
          const upgraded = upgradeLegacyOrder(state)
          if (upgraded.changed) {
            const before = state.stage
            state.plan = upgraded.plan
            state.stage = upgraded.stage
            if (upgraded.spoken_seeds !== undefined) state.spoken_seeds = upgraded.spoken_seeds
            state.history.push({ at: iso(), event: `阶段顺序升级:称呼 → 分岔 → 布局(停在 ${before} → ${upgraded.stage})` })
          }
          // 2026-09-25:走完了却没盖过「走完那一刻」的老存档(done_at 之前没有这一格),拿最后一次写盘的时刻盖上
          // (走完那一下一定写过盘),随下一次写盘落地。**盖在读进来这一下**,不在 view 里现算:之后别的写盘会改
          // updatedAt,而电脑首页按 done_at「同一次走完只切一次事务官档」—— 它要是跟着变,就会一次次把人拽回来。
          if (state.stage === 'done' && state.done_at === undefined) state.done_at = state.updatedAt
        }
      }
      catch {
        // 没有文件 = 还没开始引导;写坏了 = 从头来(进度在用户文件头部还有一份人能读的)。
      }
    },

    view() {
      const done = state.stage === 'done'
      /**
       * 「第 N 步 / 共 M 步」。**`done` 不算一步** —— 计划里它是终点标记,
       * 把它算进去会让人看到「共 9 步」却只答 8 次(数对不上是最招人烦的一种小谎)。
       */
      // 显式标注:filter 的谓词会把类型收窄成「不含 done」,那样 indexOf(state.stage) 就编不过了。
      const steps: OnboardingStage[] = state.plan.filter(stage => stage !== 'done')
      const at = steps.indexOf(state.stage)
      return {
        stage: state.stage,
        done,
        ...(state.askedAt === undefined ? {} : { askedAt: state.askedAt }),
        ...(state.leader === undefined ? {} : { leader: state.leader }),
        ...(state.leader_at === undefined ? {} : { leader_at: state.leader_at }),
        label: STAGE_LABEL[state.stage],
        // 阶段不在计划里(补问那一支把计划换过)、或者已经做完:都按「最后一步」说,不编一个 0 或 -1。
        step: at < 0 ? steps.length : at + 1,
        steps: steps.length,
        // 走完的那一刻(2026-09-25)。老存档没盖过章:退回最后一次写盘的时刻(走完那一下一定写过盘)。
        ...(done ? { done_at: state.done_at ?? state.updatedAt } : {}),
      }
    },

    async brief() {
      const machine = await facts()
      const def = stageDef(state.stage, state.mode, state.template, carriedConsent(), machine)
      const skill = await readSkill()
      const done = state.stage === 'done'
      // 「这台机器上装了哪几家」只在问应用的那一段给,而且只在**真扫过**的时候给。
      const asksApps = Object.values(def.keys).some(key => key.kind === 'apps')
      const installedApps = asksApps ? await installedAppNames() : undefined
      return {
        stage: state.stage,
        label: def.label,
        done,
        ...(done ? {} : { seed: def.seed }),
        speak_seed: !done && !(state.spoken_seeds ?? []).includes(state.stage),
        goals: def.goals,
        keys: keyBriefs(state.stage, state.mode, state.template, carriedConsent(), machine),
        // 这台电脑上真装了、真有记录可读的那几家 AI(代码探的)。缺席 = 没探过,通道层照老字面量说。
        ...(machine.memoryFamilies === undefined ? {} : { memory_families: machine.memoryFamilies }),
        firstrun: machine.firstrun === true,
        answered: answeredKeys(),
        ...(state.nickname === undefined ? {} : { nickname: state.nickname }),
        ...(state.mode === undefined ? {} : { mode: state.mode }),
        ...(state.focus === undefined ? {} : { focus: state.focus }),
        ...(state.stage === 'wrapup' || done ? { recap: recap() } : {}),
        ...(installedApps === undefined ? {} : { installed_apps: installedApps }),
        // 日历:整通电话都给。她随时可能说到一个日期,而「10 月 4 号是国庆」不该等到某一段才知道。
        ...(calendar() === undefined ? {} : { calendar: calendar() as string }),
        plan: state.plan,
        ...(skill === undefined ? { skill_note: SKILL_MISSING_NOTE } : { skill }),
        ...(state.askedAt === undefined ? {} : { askedAt: state.askedAt }),
        ...(state.leader === undefined ? {} : { leader: state.leader }),
      }
    },

    setLeader(leader) {
      if (typeof leader !== 'string' || !(ONBOARDING_LEADERS as readonly string[]).includes(leader)) {
        return Promise.resolve({ ok: false as const, status: 400 as const, error: `leader 要 ${ONBOARDING_LEADERS.join(' / ')} 之一` })
      }
      return enqueue(async () => {
        const next = leader as OnboardingLeader
        state.leader = next
        state.leader_at = iso()
        await save()
        return { ok: true as const, leader: next }
      })
    },

    markSeedSpoken(stage) {
      if (typeof stage !== 'string' || !(FULL_PLAN as readonly string[]).includes(stage)) {
        return Promise.resolve({ ok: false as const, status: 400 as const, error: `stage 要 ${FULL_PLAN.join(' / ')} 之一` })
      }
      return enqueue(async () => {
        const marked = stage as OnboardingStage
        const spoken = new Set(state.spoken_seeds ?? [])
        spoken.add(marked)
        state.spoken_seeds = [...spoken]
        // 「事务官开过口了」——手机上那条「引导还没做完 · 继续」的横幅认的就是它。
        if (state.askedAt === undefined) state.askedAt = iso()
        // 主导方有动静了(2026-09-18):电脑那一屏据此不再问「手机那边没动静?」。
        state.leader_at = iso()
        await save()
        return {
          ok: true as const,
          stage: marked,
          speak_seed: state.stage !== marked ? !spoken.has(state.stage) : false,
        }
      })
    },

    nickname() {
      return state.nickname
    },

    summaryInput() {
      const picked = state.answers.projects?.project
      const projects = typeof picked === 'object' && picked !== null ? Object.keys(picked as Record<string, unknown>) : []
      return { done: state.stage === 'done', stage: state.stage, answered: answeredKeys(), projects }
    },

    detail() {
      const next = nextInfo()
      return {
        stage: state.stage,
        done: state.stage === 'done',
        ...(state.mode === undefined ? {} : { mode: state.mode }),
        ...(state.nickname === undefined ? {} : { nickname: state.nickname }),
        plan: state.plan,
        answered: answeredKeys(),
        ...(next === undefined ? {} : { next }),
        ...(state.stage === 'wrapup' || state.stage === 'done' ? { recap: recap() } : {}),
        ...(state.askedAt === undefined ? {} : { askedAt: state.askedAt }),
        ...(state.leader === undefined ? {} : { leader: state.leader }),
        ...(state.leader_at === undefined ? {} : { leader_at: state.leader_at }),
        ...(state.session_id === undefined ? {} : { session_id: state.session_id }),
        supplement: state.supplement,
        commits: state.commits,
      }
    },

    openSession(opener, baseUrl, options) {
      return enqueue(async (): Promise<SessionResult> => {
        if (state.stage === 'done') {
          const focus = state.supplement[0]
          if (focus === undefined) {
            return { ok: false, status: 409, error: '引导已经完成。要重来用 POST /onboarding/restart { scope: all | persona | authorization }。' }
          }
          // 新项目只补问那一个:计划只剩「项目 → 完成」。
          state.stage = 'projects'
          state.plan = ['projects', 'done']
          state.mode = 'existing'
          state.focus = focus
          state.answers.projects = { ...answersOf('projects') }
          delete state.answers.projects.done
          state.history.push({ at: iso(), event: `补问新项目 ${focus}` })
        }
        // 开过会话就算「接着」——哪怕一项都还没答(2026-09-16 真机:称呼没答就从主页再点「接着引导」,
        // 原先当成第一次开,又发了一遍开场白,手机上念了三遍)。
        const opened = state.session_id !== undefined
        // 旧会话最近一轮以错误结束(模型没接上时开的,provider 钉在坏路由上):不往里续,另开一条。
        // 「接着」照旧算 —— 已答的内容都在,新会话第一条消息照样是「接着上次」那一版。
        const broken = opened && state.session_failed?.session_id === state.session_id
        /**
         * 这条不续了,另开(2026-09-24,卡 fix/firstrun-session-after-answers):重启后预热的那条会话,第一条消息是按
         * 预热那一刻的阶段写的,之后阶段机又往前走了(onboardingWarm.ts 文件头)。往里续,她会先把旧阶段那一问说完;
         * 也不能因为「刚推过一次」就只交会话。第一条消息照常是「接着做」那一版(不是坏会话那种「换了一条」的说法 ——
         * 他还一句都没看到,没有什么要瞒的)。
         */
        const replacing = opened && options?.replace !== undefined && options.replace === state.session_id
        const resumed = opened || state.stage !== state.plan[0] || answeredCount() > 0
        // 电脑那条路(DSH 会话)也拿得到「扫到装了哪几家」——与手机简报同一份来源。
        // 这条消息是开会话那一刻拼的:从头走到 ④ 习惯的那一遍看不到它(那时它还没被问起),
        // 模型就照常开放地问,不编一个清单出来。
        const installedNames = await installedAppNames()
        const machine = await facts()
        syncRecordsStage()
        const answered = answeredKeys()
        const message = firstMessage({
          stage: state.stage,
          mode: state.mode,
          baseUrl,
          answered,
          ...(state.nickname === undefined ? {} : { nickname: state.nickname }),
          resumed,
          // F(2026-09-23):坏会话另开 —— 他那头是同一段对话,不问「上次到哪」、不提断线。
          ...(broken ? { quietResume: true } : {}),
          ...(state.focus === undefined ? {} : { focusProject: state.focus }),
          ...(state.stage === 'wrapup' ? { recap: recap() } : {}),
          ...(installedNames === undefined ? {} : { installedApps: installedNames.map(app => app.label) }),
          ...(calendar() === undefined ? {} : { calendar: calendar() as string }),
          // 2026-09-21:当前布局模板。还没选过就缺席 —— 那时阶段机按做产品那一套走。
          ...(state.template === undefined ? {} : { template: state.template }),
          carried: carriedConsent(),
          facts: machine,
        })
        /**
         * 同一条会话刚推过一次「接着」(RESUME_NUDGE_QUIET_MS 内),又来开:只交会话,不再说(2026-09-24)。
         * 真机:他挂断电话转到电脑,对话屏上两条几乎一样的「接着上次」相隔 0.9 秒 —— 两处几乎同时来开会话,
         * 每来一次就往同一条会话里说一次,她就答两次。
         */
        const lastNudge = nudged
        if (opened && !broken && !replacing && opener?.say !== undefined && lastNudge !== undefined
          && lastNudge.session_id === state.session_id && lastNudge.stage === state.stage
          && now().getTime() - lastNudge.at < RESUME_NUDGE_QUIET_MS) {
          return {
            ok: true,
            stage: state.stage,
            session_id: state.session_id as string,
            first_message: '',
            seed: stageDef(state.stage, state.mode, state.template).seed,
            resumed: true,
            quiet: true,
          }
        }
        state.askedAt = iso()
        let sessionId: string | undefined
        // 原会话还在:续做那条消息排进它的队列,不另开——模型记得自己说过什么,不会再念开场白。
        // 排不进去(DSH 里没了 / 没有 say 通道)才另开一条。
        if (opened && !broken && !replacing && opener?.say !== undefined) {
          try {
            if (await opener.say(state.session_id as string, message)) sessionId = state.session_id
          }
          catch {
            sessionId = undefined
          }
        }
        if (sessionId === undefined) {
          try {
            // 思考档(2026-09-28 卡 BS):引导里的对答她正坐在那儿等 → 关。
            sessionId = await opener?.open(message, { effort: effortFor('onboarding') })
          }
          catch {
            sessionId = undefined
          }
        }
        if (sessionId !== undefined && sessionId !== '') nudged = { session_id: sessionId, stage: state.stage, at: now().getTime() }
        if (sessionId !== undefined && sessionId !== '') {
          if (broken && sessionId !== state.session_id) {
            state.history.push({ at: iso(), event: `旧引导会话 ${state.session_id as string} 上一轮报错(${state.session_failed?.code ?? '未知'}),另开 ${sessionId}` })
          }
          else if (replacing && sessionId !== state.session_id) {
            state.history.push({ at: iso(), event: `预热的引导会话 ${state.session_id as string} 是按预热那一刻的阶段写的,之后阶段变了,另开 ${sessionId}` })
          }
          state.session_id = sessionId
          if (state.session_failed?.session_id !== sessionId) delete state.session_failed
        }
        await save()
        return {
          ok: true,
          stage: state.stage,
          ...(sessionId !== undefined && sessionId !== '' ? { session_id: sessionId } : { note: '会话未开' }),
          first_message: message,
          seed: stageDef(state.stage, state.mode, state.template).seed,
          resumed,
          answered,
        }
      })
    },

    clearNudge() { nudged = undefined },

    noteBriefRead(path) {
      const key = briefPathKey(path, homeDir())
      if (key !== undefined) briefReads.set(key, now().getTime())
    },

    noteTurnEnd(sessionId, outcome) {
      // 她答完了一轮:刚才那次「接着」已经有了回音,之后再来开就照常推一次(防重复只挡「还没答」的那一小段)。
      if (nudged?.session_id === sessionId) nudged = undefined
      return enqueue(async () => {
        if (state.session_id === undefined || sessionId !== state.session_id) return
        if (outcome.ok) {
          if (state.session_failed === undefined) return
          delete state.session_failed
          await save()
          return
        }
        if (state.session_failed?.session_id === sessionId) return
        state.session_failed = { session_id: sessionId, at: iso(), ...(outcome.code === undefined ? {} : { code: outcome.code }) }
        await save()
      })
    },

    sessionBroken() {
      return state.session_id !== undefined && state.session_failed?.session_id === state.session_id
    },

    /**
     * 「把各家客户端里记的东西拷一份过来」这一下(2026-09-21,`POST /onboarding/import-memories`)。
     *
     * 与 `answer({ key: 'import_memories' })` 走的是**同一个** `runMemoryImport` ——
     * 电话里她调 record_answer,人在电脑上点按钮走这一条,两条路必须是同一件事。
     * 差别只在这一条**不看当前阶段、不推进阶段**:引导做完了他还想拷,那也该拷得成。
     */
    /**
     * 探一眼(2026-09-22,`GET /onboarding/memories`)。
     *
     * **不过授权表那道门**,而拷那一下过:这里做的事只是 `readdir` / `lstat` ——
     * 数一数各家有几份 `.md`,**一个字节的正文都不读、不落盘**。
     * 界面上先让他看见「Claude 45 份 / Codex 1 份 / Kimi 未查到」,他才谈得上决定要不要拷;
     * 把这一眼也锁上的话,那颗按钮旁边只剩一句「没授权」,他连要授权什么都不知道。
     *
     * 不进 `enqueue`:它什么都不改,排在一串写操作后面只会让界面白等。
     */
    async probeMemories(): Promise<MemoryProbeResult> {
      const allowed = await clientFilesAllowed()
      const probe = options.memories?.probeAll
      if (probe === undefined) {
        return {
          allowed: allowed.ok,
          status: allowed.status,
          wired: false,
          families: [],
          note: '这台工作台没接「拷别家记忆」这一档,探不了,也拷不了。',
        }
      }
      let families: readonly MemoryProbeFamily[]
      try { families = (await probe()).map(one => ({ ...one })) }
      catch (error) {
        return {
          allowed: allowed.ok,
          status: allowed.status,
          wired: true,
          families: [],
          note: `探不成:${error instanceof Error ? error.message : String(error)}。一个字节都没拷。`,
        }
      }
      return {
        allowed: allowed.ok,
        status: allowed.status,
        wired: true,
        families,
        note: allowed.ok
          ? '可以拷。点下面那颗按钮,只读它们的,原件一个字不动。'
          : `现在拷不了:授权表里「${AUTH_KEY_DESC.read_client_files}」是「${allowed.status}」,不是「可以」。`
            + '去引导里那一问答「可以」,或者直接改 docs/记忆/授权.md。',
      }
    },

    importMemories() {
      return enqueue(async () => {
        /**
         * 2026-09-22(C5):授权不到位就**不拷、也不把这一问记成答过了** ——
         * 记成 true 的话,等他把授权改成「可以」,这一问再也不会被问第二遍,
         * 而一份都没拷过。回 `ok:false` 加那句原话,按钮那一侧照原样显示。
         */
        const run = await runMemoryImportDetailed(true)
        if (!run.ok) return { ok: false as const, note: run.note, written: run.written, added: run.added }
        state.answers.projects = { ...answersOf('projects'), import_memories: true }
        await writeUserFile()
        await save()
        return { ok: true as const, note: run.note, written: run.written, added: run.added }
      })
    },

    answer(input) {
      return enqueue(async (): Promise<AnswerResult> => {
        await facts()
        /**
         * 他这一句是在喊停(2026-09-27,卡 OB)。这一路管的是**电话与手机**那两端:
         * 工人把他刚说的那句带在 `heard` 里,判据同电脑那条路(代码词表,不靠模型自觉)。
         * 落地之后这一条答案照记(他可能是"答了一句又加一句烦") —— 但阶段已经到「完成」,不再问下一题。
         */
        if (input.heard !== undefined && wantsToSkipRest(input.heard.reply) && state.stage !== 'done') {
          await skipRestInner(input.heard.reply.slice(0, 40))
          return { ok: true, stage: state.stage, advanced: true, done: true, closing: FIRSTRUN_CLOSING_LINE }
        }
        const late = await lateAnswer(input)
        if (late !== undefined) return late
        if (state.stage === 'done') return { ok: false, status: 409, error: '引导已经完成,现在不收答案。要重来用 /onboarding/restart。' }
        if (typeof input.stage !== 'string' || !(FULL_PLAN as readonly string[]).includes(input.stage)) {
          return { ok: false, status: 400, error: `stage 要 ${FULL_PLAN.filter(s => s !== 'done').join(' / ')} 之一` }
        }
        const def: StageDef = stageDef(state.stage, state.mode, state.template)
        /**
         * ——— 认 key,不认标签(2026-09-20 本机真跑之后加的) ———
         *
         * 本机跑一遍就看得见:模型在电话里一路把 stage 写成上一段的名字
         * (`branch.read_scan_roots → 409`、`opening.read_scan_roots → 409`),
         * 而那几项**明明就是当前这一段能写的**。阶段名是我们的记账方式,不是他答的内容 ——
         * 拿它把一条正确的答案挡回去,用户看到的就是「我说了它没记」。
         *
         * 所以:key 在当前这一段的白名单里,就按当前这一段收,并在 note 里如实说一句。
         * key 不在,才谈得上 409,而那时**要把出路写进错误里**:
         * 已经答过的那一项走 /onboarding/correct(改,不倒退阶段),别的就先把这一段答完。
         */
        let mislabelled: string | undefined
        if (input.stage !== state.stage) {
          if (typeof input.key === 'string' && def.keys[input.key] !== undefined) {
            mislabelled = `顺带说一句:${input.key} 属于「${STAGE_LABEL[state.stage]}」,我按这一段记的`
          }
          else {
            const from = input.stage as OnboardingStage
            const answeredThere = typeof input.key === 'string' && answersOf(from)[input.key] !== undefined
            return {
              ok: false,
              status: 409,
              error: answeredThere
                ? `${input.key} 是「${STAGE_LABEL[from]}」里记过的一项,现在在「${STAGE_LABEL[state.stage]}」。`
                  + '要改它用 POST /onboarding/correct(同样的 stage / key / value,阶段不会倒回去)。'
                : `现在在「${STAGE_LABEL[state.stage]}」,不能答「${STAGE_LABEL[from]}」的问题。`
                  + `这一段能写的是 ${Object.keys(def.keys).join(' / ')};`
                  + '要改之前记过的用 POST /onboarding/correct。',
            }
          }
        }
        if (typeof input.key !== 'string' || def.keys[input.key] === undefined) {
          return { ok: false, status: 400, error: `「${STAGE_LABEL[state.stage]}」只能写 ${Object.keys(def.keys).join(' / ')},没有 ${String(input.key)}` }
        }
        const keyDef = def.keys[input.key] as NonNullable<StageDef['keys'][string]>
        const checked = validateValue(keyDef.kind, input.value)
        if (!checked.ok) return { ok: false, status: 400, error: `${input.key}:${checked.error}` }

        let note: string | undefined
        try {
          note = await applyAnswer(state.stage, input.key, checked.value, input.heard === undefined ? undefined : { heard: input.heard })
        }
        catch (error) {
          if (error instanceof AnswerError) return { ok: false, status: error.status, error: error.message }
          throw error
        }
        if (mislabelled !== undefined) note = note === undefined ? mislabelled : `${note};${mislabelled}`

        const finishedStage = state.stage
        const advanced = stageComplete()
        let commit: { ok: boolean, message: string, error?: string } | undefined
        let closing: string | undefined
        if (advanced) {
          advance()
          // 新骨架走到完了:没问的那几项按默认落盘,回一句收尾话(照它念,不再复述、不念清单)。
          if (currentStage() === 'done') closing = await applyFirstrunDefaults()
          lastFinished = { stage: finishedStage, at: now().getTime() }
          // 先推进再写一次用户文件:进度行写成新阶段,和这一阶段的其它改动进同一个 commit。
          await writeUserFile()
          commit = await commitStage(finishedStage)
        }
        // 主导方有动静了(2026-09-18):谁在做引导,交答案就是最实的那个信号。
        state.leader_at = iso()
        await save()
        const next = nextInfo()
        // advance() 在闭包里改了 state.stage,TS 的控制流看不见,这里重新读一次。
        const stage = currentStage()
        return {
          ok: true,
          stage,
          advanced,
          done: stage === 'done',
          ...(next === undefined ? {} : { next }),
          ...(stage === 'wrapup' ? { recap: recap() } : {}),
          ...(commit === undefined ? {} : { commit }),
          ...(note === undefined ? {} : { note }),
          ...(closing === undefined ? {} : { closing }),
        }
      })
    },

    /**
     * **他不耐烦了:剩下的别问了**(2026-09-27,卡 OB)。判据在代码里(onboardingConsent 的
     * `wantsToSkipRest`),入口是 `/onboarding/say` 与 `POST /onboarding/skip-rest`。
     *
     * 做三件事:没问的那几项按默认落盘 → 阶段直接到「完成」→ 回那一句收尾话。
     * **他的内容一个字都不编**(称呼、项目、点子、账号没说过就是没说过,以后他自己说)。
     */
    skipRest(reason?: string) {
      return enqueue(() => skipRestInner(reason))
    },

    /**
     * ——— 改一项已经答过的(2026-09-20,Ben:「它说不能改,我当时一度想要停下」) ———
     *
     * 那天早上的日志里有一行 `引导 opening.nickname → 409`:他说「我叫本,不是 Java」,
     * 阶段机回了「现在在② 分岔,不能答① 开场的问题」,于是她只能说「这个名字的改动我这会儿没能记上」。
     * 对一个第一次用的人来说,那一句就是「这东西记岔了而且改不回来」。
     *
     * 这条路和 `answer` 差在三处,每一处都是故意的:
     *   ① **不看当前阶段**:要改的那一项属于哪个阶段,就按哪个阶段的白名单与形状校验。
     *   ② **不推进阶段**:改称呼不该把人重新拖回开场,也不该因为「必答项齐了」再推一次。
     *   ③ **必须先答过**:没答过的用 `answer`(那条会推进);这条只管「改」。
     *      没答过还走这条就 404 并把话说清 —— 让模型自己改调 `answer`,而不是干等。
     *
     * 引导做完了照样能改:`done` 之后 `answer` 一律 409,但「称呼记错了」不会因为引导做完就不算数。
     */
    correct(input) {
      return enqueue(async (): Promise<CorrectResult> => {
        if (typeof input.stage !== 'string' || !(FULL_PLAN as readonly string[]).includes(input.stage) || input.stage === 'done') {
          return { ok: false, status: 400, error: `stage 要 ${FULL_PLAN.filter(s => s !== 'done').join(' / ')} 之一` }
        }
        const stage = input.stage as OnboardingStage
        // 校验按**那一项所属阶段**的定义来,不是按当前阶段。
        const def: StageDef = stageDef(stage, state.mode, state.template)
        if (typeof input.key !== 'string' || def.keys[input.key] === undefined) {
          return { ok: false, status: 400, error: `「${STAGE_LABEL[stage]}」只能写 ${Object.keys(def.keys).join(' / ')},没有 ${String(input.key)}` }
        }
        const key = input.key
        if (answersOf(stage)[key] === undefined) {
          return {
            ok: false,
            status: 404,
            error: `「${STAGE_LABEL[stage]}」的 ${key} 还没答过,没有可改的。第一次记用 /onboarding/answer。`,
          }
        }
        const keyDef = def.keys[key] as NonNullable<StageDef['keys'][string]>
        const checked = validateValue(keyDef.kind, input.value)
        if (!checked.ok) return { ok: false, status: 400, error: `${key}:${checked.error}` }

        let note: string | undefined
        try {
          // 更正是他改了说法:项目那几句照旧标「他口述」(2026-09-24 下午小修,见 projectSource)。
          note = await applyAnswer(stage, key, checked.value, { correcting: true })
        }
        catch (error) {
          if (error instanceof AnswerError) return { ok: false, status: error.status, error: error.message }
          throw error
        }
        state.history.push({ at: iso(), event: `改了 ${stage}.${key}` })
        state.leader_at = iso()
        // **阶段一个字不动**,但改出来的字要落进 git —— 提交消息说清这是一次更正。
        const commit = await commitCorrection(stage, key)
        await save()
        return {
          ok: true,
          stage,
          key,
          current: currentStage(),
          ...(note === undefined ? {} : { also: note }),
          ...(commit === undefined ? {} : { commit }),
        }
      })
    },

    restart(scope) {
      return enqueue(async () => {
        state.history.push({ at: iso(), event: `重新引导 ${scope}` })
        delete state.session_id
        delete state.session_failed
        delete state.focus
        // 重来 = 还没走完:下一次走完是新的一刻(电脑首页那一次切回事务官档认的就是它)。
        delete state.done_at
        // 重来就要重新开口:这一段的种子句(all 是开场白)得再说一遍,所以把「说过了」划掉。
        if (scope === 'all') {
          const kept = { history: state.history, commits: state.commits, supplement: state.supplement }
          state = { ...fresh(), ...kept }
          // 新的一次引导:上一次读过的项目不算「这一次读过」。
          briefReads.clear()
        }
        else if (scope === 'persona') {
          delete state.answers.persona
          state.plan = ['persona', 'done']
          state.stage = 'persona'
          state.spoken_seeds = (state.spoken_seeds ?? []).filter(item => item !== 'persona')
        }
        else {
          delete state.answers.authorization
          state.plan = ['authorization', 'done']
          state.stage = 'authorization'
          state.spoken_seeds = (state.spoken_seeds ?? []).filter(item => item !== 'authorization')
        }
        dirty = new Set()
        await writeUserFile()
        await save()
        return { ok: true as const, stage: state.stage }
      })
    },

    recordMaterialized(input) {
      return enqueue(async () => {
        const bg = input.background
        const name = bg === undefined ? undefined : safeName(bg.project)
        if (bg !== undefined && name !== undefined && await exists(abs(rel('项目', `${name}.md`)))) {
          const text = await readFile(abs(rel('项目', `${name}.md`)), 'utf8')
          await writeRel(rel('项目', `${name}.md`), upsertProjectField(text, '背景', `${bg.text}(引导落地,${state.nickname ?? '他'}在引导里说的,${today()})`))
        }
        state.history.push({ at: iso(), event: '引导落地:照单子落了' })
        if (dirty.size > 0) {
          const files = [...dirty]
          dirty = new Set()
          const message = 'chore(记忆): 引导·落地'
          try {
            await git(['add', '-A', '--', ...files], options.repoRoot)
            await git(['commit', '-q', '-m', message, '--', ...files], options.repoRoot)
            state.commits.push({ stage: state.stage, at: iso(), ok: true, message })
          }
          catch (error) {
            const text = error instanceof Error ? error.message.split('\n')[0] ?? '' : String(error)
            state.commits.push({ stage: state.stage, at: iso(), ok: false, message, error: text })
            for (const file of files) dirty.add(file)
          }
        }
        await save()
      })
    },

    async noticeProjects(names, noticeOptions) {
      // 引导没做完时不排队:项目阶段本来就会聊到;只有做完了(或正在补问)的新项目才补问。
      const supplementing = state.plan.length === 2 && state.plan[0] === 'projects'
      if (state.stage !== 'done' && !supplementing) return []
      const explicit = noticeOptions?.explicit === true
      if (!explicit && state.project_baseline === undefined) {
        // 做完后第一次自动发现:这些是他本来就有的,不是新冒出来的 —— 立基线,一个都不补问。
        const baseline = names.map(raw => safeName(raw)).filter((name): name is string => name !== undefined)
        for (const name of baseline) seenProjects.add(name)
        return enqueue(async () => {
          state.project_baseline = baseline
          await save()
          return []
        })
      }
      const baseline = new Set(state.project_baseline ?? [])
      const added: string[] = []
      for (const raw of names) {
        const name = safeName(raw)
        if (name === undefined) continue
        if (!explicit && (seenProjects.has(name) || baseline.has(name))) continue
        seenProjects.add(name)
        if (state.supplement.includes(name) || projectAnswers()[name] !== undefined) continue
        if (await exists(abs(rel('项目', `${name}.md`)))) continue
        added.push(name)
      }
      if (added.length === 0) return []
      return enqueue(async () => {
        state.supplement.push(...added)
        state.history.push({ at: iso(), event: `发现新项目 ${added.join('、')}` })
        await save()
        return added
      })
    },
  }
}

/** 正则里当字面量用的转义。称呼是用户给的,拿它拼正则之前必须过一遍。 */
function escapeRe(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * 从一段人话里把日期抠出来(`2026-10-04`)。抠不出来回 undefined —— **不猜一个日期**(D13)。
 *
 * 认三种写法:`2026-10-04` / `2026/10/4` / `2026年10月4日`,以及**不带年份**的「10 月 4 日」。
 * 不带年份的那一种按**今年**算;算出来的日子比今天早半年以上时按明年算
 * (他在 9 月说「1 月 5 日截止」,指的显然是明年的 1 月)。这是一条**读法**,不是一个数据:
 * 拿不准的仍然会经由 holidays 那边的「推算」标记说出去。
 */
export function isoDateIn(text: unknown, today: string): string | undefined {
  if (typeof text !== 'string') return undefined
  const full = /(\d{4})\s*[-/年]\s*(\d{1,2})\s*[-/月]\s*(\d{1,2})\s*日?/.exec(text)
  const pad = (year: number, month: number, day: number): string | undefined => {
    if (month < 1 || month > 12 || day < 1 || day > 31) return undefined
    const at = Date.UTC(year, month - 1, day)
    const back = new Date(at)
    if (back.getUTCMonth() + 1 !== month || back.getUTCDate() !== day) return undefined
    return back.toISOString().slice(0, 10)
  }
  if (full !== null) {
    return pad(Number(full[1]), Number(full[2]), Number(full[3]))
  }
  const short = /(\d{1,2})\s*月\s*(\d{1,2})\s*[日号]/.exec(text)
  if (short === null) return undefined
  const thisYear = Number(today.slice(0, 4))
  if (!Number.isFinite(thisYear)) return undefined
  const candidate = pad(thisYear, Number(short[1]), Number(short[2]))
  if (candidate === undefined) return undefined
  const gap = Date.parse(`${candidate}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)
  return gap < -180 * 86_400_000 ? pad(thisYear + 1, Number(short[1]), Number(short[2])) : candidate
}

const AUTH_SHORT: Record<string, string> = {
  read_scan_roots: '扫描根 ',
  read_session_titles: '会话标题 ',
  read_workbench_state: '工作台状态 ',
  read_client_files: '读客户端文件 ',
  read_session_content: '看对话最后几句 ',
  write_docs: '写 docs ',
  write_commit: 'commit ',
  write_api: '写接口 ',
}
