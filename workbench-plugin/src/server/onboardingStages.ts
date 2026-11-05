/**
 * 引导流程的**骨架**(2026-09-15,docs/设计-引导流程.md v2 + docs/设计-事务官完整材料.md 第 3 节)。
 *
 * 「对话由模型做,骨架由代码定」:这个文件只有纯数据与纯函数——每个阶段一句种子句、
 * 一份「要弄清的东西」清单(不是要问的问题)、一张「本阶段允许写什么」的 key 白名单,
 * 以及把这些拼成 DSH 会话第一条消息的函数。没有 I/O。阶段怎么落盘、答案怎么写进记忆
 * 在 onboarding.ts。
 *
 * 开场白是 Ben 2026-09-11 亲笔,**一字不改**(决策记录 2026-09-11 第 2 条);测试会拿设计文档
 * 里那一行来对。
 */

import { allTemplates, templateById } from '../templates.ts'
import { ASK_TO_READ } from './projectBrief.ts'

export type OnboardingStage =
  | 'opening' | 'template' | 'branch' | 'projects' | 'authorization' | 'habits' | 'persona' | 'naming' | 'wrapup' | 'done'

export type OnboardingMode = 'existing' | 'fresh'

/** 完整一遍的阶段顺序。重新引导只走其中一段(见 onboarding.ts 的 plan)。 */
export const FULL_PLAN: readonly OnboardingStage[] = [
  // 2026-09-23(维护者第二轮真机:「为什么一开始是布局而不是从新点子或已有项目,这反了啊」):
  // 顺序改成 **① 称呼 → ② 分岔 → ①′ 布局 → ②′ 项目 / 账号**。
  //
  // 09-21 那一版把布局放在分岔前面,理由是「分岔那一句在运营模板下要整个换掉」。现在反过来:
  // 分岔先问,用**中性**的一句「已经有在做的事,还是从一个新点子开始」(不提"项目"也不提"账号",
  // 两套布局都说得通);布局接着问,而且能顺着他刚说的那件事问「这件事更像做产品还是做自媒体运营?」
  // —— 先问他在做什么、再问这像哪一类,比一上来让他在两套界面里挑一个自然得多。
  // ②′ 在布局定了之后才开始,所以仍按模板走产品线(项目 / 点子)或运营线(账号)。
  // 标签(①′、②)不改号:UI 与记忆里认的是这几个名字,不是序号。老存档的升级见 onboarding.ts reorderLegacyPlan。
  'opening', 'branch', 'template', 'projects', 'authorization', 'habits', 'persona', 'naming', 'wrapup', 'done',
]

/**
 * **新首次引导的骨架**(2026-09-27 19:55,统筹按维护者授权定死;决策记录同日那一条)。
 *
 * 现场:全新 Air 上走一遍电脑文字引导,15 问、11 分钟,他中途连说「你好啰嗦啊」「快点让开」,
 * 事务官还在依次问音乐、性格、取名。维护者:整个引导流程重新整理。
 *
 * 新骨架**最多 5 问**,三端(电脑文字 / 手机文字 / 手机语音)同一套:
 *   ① 称呼 → ② 分岔(已有 / 新点子)→ ③ 模板(做产品 / 自媒体)→ ④ 这件事一句话
 *   → ⑤ **仅当**分支=已有 且本机真探到至少一家有记录可读的 AI:「能不能读 <那几家> 里跟这件事有关的记录」
 *   → 收尾一句「好,进去吧。剩下的用到时我再问,设置里也随时能改。」
 *
 * ⑤ 那一问借用 `authorization` 这个阶段名(它本来就收 `read_session_content`),
 * 用不上时由 {@link planWithoutRecords} 从计划里摘掉 —— 段数、进度条跟着变。
 *
 * **旧的 ③ 授权补全 / ④ 习惯 / ④′ 人设 / ④″ 取名 / ⑤ 收尾不再问**:按默认落盘
 * (见 server/onboarding.ts 的 `FIRSTRUN_DEFAULTS`),设置里随时能改。
 * 老存档照自己存着的 plan 走,已经走完的人不受影响。
 */
export const FIRSTRUN_PLAN: readonly OnboardingStage[] = ['opening', 'branch', 'template', 'projects', 'authorization', 'done']

/**
 * 新骨架里**不问、按默认落盘**的那几项(2026-09-27,统筹按维护者授权定)。
 *
 * 走到「完成」那一刻由阶段机一次写完(server/onboarding.ts 的 `applyFirstrunDefaults`),
 * 每一项都写进记忆里那份用户文件,**设置里随时能改**。收尾那一句里一并告知。
 *
 * 故意**不**默认写的:
 * - 称呼、项目 / 点子 / 账号、第一件 —— 他的内容,编不得;
 * - 下班例程时刻、开工汇报 —— 早报的真开关在 `routines.json` 的 `morning.enabled`(现默认开),
 *   这儿**不写**,免得偷偷把现默认改掉(统筹 2026-09-27 盘点第 7 条);
 * - 常用应用 —— 按本机探到的那几家 AI 现填(见 onboarding.ts 的 `applyFirstrunDefaults`);
 * - `read_session_titles` / `read_workbench_state` / `habits` 的 channel / music / report_pref
 *   —— 现在没有人读它们,不问也不编(盘点第 6 条)。
 */
export const FIRSTRUN_DEFAULTS: readonly { stage: OnboardingStage, key: string, value: unknown, label: string }[] = [
  { stage: 'authorization', key: 'write_docs', value: true, label: '往我这边的记忆文件夹里写你的偏好与项目' },
  { stage: 'authorization', key: 'write_commit', value: true, label: '每次写完在这台电脑上存一个版本' },
  { stage: 'authorization', key: 'write_api', value: true, label: '替你建事项、挪看板' },
  { stage: 'persona', key: 'persona', value: '沉稳', label: '说话方式按「沉稳」' },
  { stage: 'persona', key: 'candor', value: 3, label: '直言度 3' },
  { stage: 'persona', key: 'verbosity', value: 3, label: '话量 3' },
  { stage: 'naming', key: 'butler_name', value: '事务官', label: '先叫我「事务官」' },
]

/**
 * 「能不能看你放代码的目录」这一项的默认(盘点第 6 条):**已有那一支开、新点子那一支关**。
 * 新点子那一支本来就不找不读(接口 403),给它开一个用不上的权限是多余的。
 */
export function scanRootsDefault(mode: OnboardingMode | undefined): boolean {
  return mode !== 'fresh'
}

/** 收尾那一句(新骨架,一句话说完就进页面)。 */
export const FIRSTRUN_CLOSING_LINE = '好,进去吧。剩下的用到时我再问,设置里也随时能改。'

/** ⑤ 用不上时的计划(分支=新点子,或本机一家可读的 AI 都没有)。 */
export function planWithoutRecords(plan: readonly OnboardingStage[]): OnboardingStage[] {
  return plan.filter(stage => stage !== 'authorization')
}

/** 这份计划是不是新骨架(判据:老骨架里必有的「④ 习惯」在不在)。 */
export function isFirstrunPlan(plan: readonly OnboardingStage[]): boolean {
  return !plan.includes('habits')
}

/**
 * 09-21 ~ 09-23 那一版的顺序(布局在分岔前)。只给断点续做认老存档用。
 */
export const LEGACY_TEMPLATE_FIRST: readonly OnboardingStage[] = ['opening', 'template', 'branch']

export const STAGE_LABEL: Record<OnboardingStage, string> = {
  opening: '① 开场',
  template: '①′ 布局(做产品 / 自媒体运营)',
  branch: '② 分岔',
  projects: '②′ 项目(A 授权线∥访谈线 / B 从零)',
  authorization: '③ 授权补全',
  habits: '④ 习惯偏好',
  persona: '④′ 对话预期',
  naming: '④″ 取名',
  wrapup: '⑤ 收尾',
  done: '已完成',
}

/** Ben 亲笔,一字不改。 */
export const OPENING_LINE
  = '你好,很高兴认识你,我是你的专属事务官。我能够帮助你更轻松、更有条理的经营你的事业,为了后面的工作能顺利开展,我需要对你和你正在做的事有一些了解,首先,你希望我怎么称呼你?'

export const PERSONAS = ['沉稳', '周到', '傲娇'] as const
export type Persona = typeof PERSONAS[number]

export const AUTH_READ_KEYS = ['read_scan_roots', 'read_session_titles', 'read_workbench_state', 'read_client_files', 'read_session_content'] as const
export const AUTH_WRITE_KEYS = ['write_docs', 'write_commit', 'write_api'] as const
export type AuthKey = typeof AUTH_READ_KEYS[number] | typeof AUTH_WRITE_KEYS[number]

export const AUTH_KEY_DESC: Record<AuthKey, string> = {
  read_scan_roots: '读三个扫描根与指定目录里的仓库与文件(只读)',
  read_session_titles: '读各家会话的状态与标题(不读正文)',
  read_workbench_state: '读工作台状态(/state)',
  // 2026-09-22 Ben 定的 C5:「授权表加『读各家客户端文件』一项」。**三档同 write_docs**
  // (可以 / 要问 / 不可以),因为它管的是"以后还去不去翻",而不是"这一次拷不拷"。
  read_client_files: '读各家客户端文件(Claude / Codex / Kimi 的记忆与配置)',
  // 2026-09-25(卡 N「进度靠证据」):判断每件事做到哪了,要看相关会话的**最后几轮**(`read_session_titles` 只到标题)。
  // 统筹 09-25 定:**并进引导 ③ 授权那一段一起问**;已经走完引导的人(维护者)第一次核进度要读时在外层问一次。缺省「要问」。
  // 2026-10-09 维护者拍板改(行为账):她对事务官说的话存原文,各家 AI 的聊天正文照旧不存。
  read_session_content: '读各家 AI 里跟看板上的事有关的对话的最后几句(判断事情做到哪了;只读,各家 AI 的聊天正文不存,判的时候相关几句会发给 AI 看一眼);你对事务官说的话存原文进本机行为账(只在这台电脑上,不进记忆仓库、不推远端、留 90 天)',
  // 2026-09-23(统筹第三轮自跑,X):原来写的是「写本仓库 docs/」「commit / push 到私有远端」,
  // 她照着念成「往这个仓库的 docs 里写东西、并且提交推上去」—— 既吓人又不对:
  // 记忆写在事务官自己的工作目录(引导配的 repoRoot,默认 ~/Documents/工作台)的 docs/记忆/ 里,
  // 阶段机只做**本地** git commit(onboarding.ts commitStage),**从不 push**,没有任何远端。
  write_docs: '往事务官工作目录的记忆文件夹(docs/记忆/)里写他的偏好、项目与授权(只在这台电脑上)',
  write_commit: '每次写完在这台电脑上存一个版本(本地 git 提交,能翻回去;不推到任何远端)',
  write_api: '调工作台写接口(建事项 /butler/item、看板 /task/*)',
}

/**
 * 系统授权(辅助功能)为什么要(2026-09-23)。与体检那一项的人话同一件事(setup/accessibility.ts):
 * 引导 ③ 授权阶段她照这句讲给他听,界面在那颗「去授权」旁边也摆这一句。
 */
export const SYSTEM_AUTH_WHY
  = '我要替你把别的应用窗口摆进窗位、拖进来认领、把话送进 Claude / Codex 的输入框 —— 这得你在系统里给「工作台」开一个「辅助功能」的开关。'

/**
 * 系统授权第二样:「完全磁盘访问」为什么要(2026-10-13)。与体检那一格、顶上那条横幅
 * 同一件事(setup/fullDiskAccess.ts、client/accessNotice.ts),这一句是**引导里她讲给他听**的版本。
 *
 * 跟辅助功能那一样有一处关键不同:**她替他按不了,连系统框都弹不出来** ——
 * 这一项 macOS 根本不给程序"请求"的机会,只能人自己去那张表里按 + 把那个文件加进去。
 * 所以这一句的落点不是"我帮你开",是"我把该点的地方摆到你面前"。
 */
export const FILE_ACCESS_WHY
  = '你在手机上看电脑里的文件时,macOS 每次都会在电脑上弹一个框问"要不要让它读" —— 而你那会儿不在电脑前,没人点,手机上就一直看不到文件。给工作台的服务一次「完全磁盘访问」,这个框就再也不出现了。'

/**
 * 这台电脑上的**事实**,代码算好了塞进来(2026-09-27,卡 OB)。
 *
 * 现场:全新 MacBook Air 上只装了豆包办公与 Codex,引导「读文件」那一步照样问「Claude 和 Kimi 里记着的
 * 东西要不要读」—— 这两家这台机器上根本没有。根因是这几句话里那串家名是**写死的字面量**,
 * 模型照剧本念,没有人告诉它这台机器上有谁。
 *
 * 规矩(AGENTS.md「不经模型的地方坚决不经模型」):**名单由代码探,模型只念**。
 */
export interface MachineFacts {
  /**
   * 新首次引导(最多 5 问)那一套骨架(2026-09-27 19:55,维护者授权、统筹定)。
   * **false / 缺席 = 老骨架,逐字不变** —— 老存档与钉着老骨架的用例一条不改。
   */
  firstrun?: boolean
  /**
   * 「读他电脑上各家 AI 记着的东西」那一问念得出的那几家(展示名,按固定顺序)。
   * 判据两条都要满足:这台电脑上**真装了**、而且**真有记录可读**(见 server/onboarding.ts 的 `memoryFamilyNames`)。
   *
   * - **缺席 = 没探过**(老接线、没接这一档的测试):照加它之前的字面量说,一个字不改;
   * - **空数组 = 探过了,一家都没有**:这一问**整个不问** —— goals 与 keys 里一起摘掉,
   *   并留一句人话交代「这台电脑上没有别家 AI 的记录」,不许再念一个没装的家。
   */
  memoryFamilies?: readonly string[]
}

/** 探不到时那串名字(加 MachineFacts 之前写死的那三家)。**只在「没探过」时用**。 */
const DEFAULT_MEMORY_FAMILY_NAMES: readonly string[] = ['Claude', 'Codex', 'Kimi']

function familyNames(families: readonly string[] | undefined): string {
  return (families ?? DEFAULT_MEMORY_FAMILY_NAMES).join('、')
}

/** ②′ 最后那一问(拷不拷一份过来)。名单由代码给。 */
function importMemoriesGoal(families?: readonly string[]): string {
  return `最后再问一句:「你电脑上${familyNames(families)} 这几个里头,它们各自记着一些东西。`
    + '要不要我拷一份到我这边?我只读它们的,一个字都不改。」——'
    // 2026-09-22(C5,Ben 定):拷之前先要「读各家客户端文件」这项授权,否则工作台不拷、如实说。
    + '他点头的话**先把 read_client_files 记成「可以」,再把 import_memories 记成 true**'
    + '(顺序不能反:授权不到位工作台不会拷,会回一句「没拷」);'
    + '工作台拷完回一句拷了几份、哪几家没找到,**照那句话念给他听,一个数都不许自己编**;'
    + '他说不要就把 import_memories 记成 false,**往后不再问第二遍**'
    + '。**这几家是工作台在这台电脑上探出来的,只念这几个** —— 没探到的一家都不许提,名字都别说出口'
}

/** ③ 授权那一问(以后还能不能去翻)。名单由代码给。 */
function clientFilesGoal(families?: readonly string[]): string {
  return `「读你电脑上${familyNames(families)} 这几个客户端里的文件(它们各自记着的东西与配置)」`
    + '——可以、要问还是不可以。**只读它们的,一个字都不改**;'
    + '这一项不是「可以」的话,连「把它们的记忆拷一份过来」也不做'
    + '。**名单是工作台探出来的,只念这几家**,没探到的别提'
}

/** ③ 授权里「照对话判进度」那一问(卡 N)。名单由代码给。 */
function sessionContentGoal(families?: readonly string[]): string {
  return `「看板上每件事做到哪了,我想照你在${familyNames(families)}里跟这件事有关的对话来写 —— 这样不用你一件件告诉我;只看最后几句,不改不存,判的时候相关几句会发给 AI 看一眼」`
    + '——可以、要问还是不可以。**为什么要看、看了他得到什么,都要说到**;不同意也没关系:那就只看项目文件夹和看板,看不出来的再问他'
}

/** 这台电脑上一家都没探到时,交代这一问为什么不问的那一句。 */
const NO_MEMORY_FAMILIES_GOAL
  = '**这台电脑上没有别家 AI 记着的东西可读**(工作台探过了:没装、或者装了但一份记录都没有)——'
    + '「要不要读 / 拷一份各家 AI 记着的东西」「照你跟各家 AI 的对话判进度」这两问**整个不问**,'
    + '**一个没装的家都不许提**(不说 Claude、不说 Kimi);他自己问起就照实说一句'
    + '「你这台电脑上我没找到别的 AI 记着的东西,以后装了随时能收」。'

/** 摘掉的那几项 key(一家都没探到时)。 */
const MEMORY_KEYS = ['read_client_files', 'import_memories', 'read_session_content'] as const

/**
 * 「没探过」那一版的三句话。goals 数组里摆的就是这三个常量 —— {@link withMachineFacts}
 * 按**同一性**认出它们再换成探到的名单(不做字符串匹配:那种认法改一个标点就悄悄失效)。
 */
const IMPORT_MEMORIES_GOAL = importMemoriesGoal()
const CLIENT_FILES_GOAL = clientFilesGoal()
const SESSION_CONTENT_GOAL = sessionContentGoal()

export type KeyKind =
  | 'string' | 'bool' | 'tri' | 'mode' | 'persona' | 'knob' | 'time' | 'strings' | 'project' | 'idea' | 'apps' | 'plan'
  // 2026-09-21:布局模板 id(product / ops)。
  | 'template'
  // 2026-09-21(项目数据源):一个**账号**的一项或几项。运营模板下 ②′ 记的是它,不是 project。
  | 'account'

export interface KeyDef {
  kind: KeyKind
  desc: string
  /** 答了这些才算本阶段做完。开放式阶段只有 done 一项是必答。 */
  required?: boolean
}

export interface StageDef {
  id: OnboardingStage
  label: string
  /** 种子句:模型开口的样子。开场那句一字不改;其余是「照样子说」。 */
  seed: string
  /** 要弄清的东西(不是要问的问题)。 */
  goals: readonly string[]
  keys: Readonly<Record<string, KeyDef>>
  /** 本阶段允许写什么(人话,进第一条消息与 SKILL.md)。 */
  writes: readonly string[]
}

const PROJECT_VALUE_DESC
  = '一个项目的一项或几项:{ name(必填), one_liner(是什么、给谁用), stage(阶段), vision(愿景:做成什么样算成), status(现状:到哪了、卡在哪), details(细节:关键决定/不能碰的/合作的人与 Agent), next_step(下一步), deadline(截止日), unsure(拿不准的,数组), later(true=稍后聊), '
    + 'path(找到的那个仓库的路径:scan_projects / read_project / POST /onboarding/scan / POST /onboarding/project-brief 回的 path **原样填**,他确认「是这个」之后带一次就行 —— 带上了项目区里就是同一行,不会多出一条) }。每弄清一项就发一次,不必一次填全'

const IDEA_VALUE_DESC
  = '{ name(项目名,必填), one_liner(一句话说它是什么), problem(想解决谁的什么问题), assets(现在手上有什么:想法/素材/人), first_step(第一步想做什么), stage(市场调研 | 项目策划,用户定) }'

/**
 * 「我排了个方案,你看行不行」那一份(2026-09-20)。**只有 `confirmed: true` 才会落成事项** ——
 * 念给他听、他点头,是这一项存在的全部理由。
 */
const PLAN_VALUE_DESC
  = '你排出来、**并且已经念给他听、他点头了**的那份方案:'
    + '{ project(哪个项目,必填), confirmed(必填,true=他听完说行;他没点头就写 false,只记不落事项), '
    + 'items(必填,1–12 条,每条 { title(一句话,必填), when(什么时候做,比如「今天」「9 月 22 日前」,可选), '
    + 'why(为什么排在这儿,可选) }), note(他改过哪里,可选) }。'
    + '**先念后记**:没念给他听过的方案,一条都不许写进来。'

const OPENING: StageDef = {
  id: 'opening',
  label: STAGE_LABEL.opening,
  seed: OPENING_LINE,
  goals: [
    '用户希望被怎么称呼',
    // 2026-09-23(统筹第三轮自跑 U / V):09-20 那条「记下之后立刻复述确认『我叫你 X,对吗?』」
    // 真机上成了「好,那我叫你 Ben。我先记一下——我叫你 Ben,对吗?」(同一件事确认两遍),
    // 还有「对吗?是拼音的 Ben 吧?另外已有还是新点子?」(一口气三问)。
    // 称呼他一说就**直接用**:下一句开头叫他一声,他听见叫错了自然会纠正(09-20 那次「本 → Java」也是这么被发现的)。
    '**他说了称呼就直接用,不再问「对吗」**:下一句开头就这么叫他一声(「好,<称呼>。」),紧接着问下一段那一题 —— 一句话里只有那一个问题',
    '**不问多余的确认**:「是拼音吗」「是哪个字」「英文还是中文」都不问;只有真没听清(转出来的字明显不像个称呼)才请他再说一遍',
    '他纠正(「不是 X,是 Y」)就用 correct_answer 改,改完照新的叫,别再确认;**不宣告**「那我以后就这么叫你了」「名字改过来了」,下一句开头叫他一声新称呼就是最好的确认',
    '他的称呼是英文字母(Ben、Tom),**写和说都写成一个词**,不拆成「B e n」',
  ],
  keys: {
    nickname: { kind: 'string', desc: '称呼(以后就这么叫)。他说了就直接用,不再问「对吗」;他纠正了用 correct_answer 改', required: true },
  },
  writes: ['docs/记忆/用户-<称呼>.md 的标题与「引导进度」一行'],
}

/**
 * ①′ 布局(2026-09-21)。Ben 原话:「现在有两个布局模板,一个是产品研发的布局,
 * 一个是自媒体运营的布局」,用户选一个;以后在设置里可切。
 *
 * 2026-09-23 起它排在 ② 分岔**之后**:他刚说完手上在做的事(或那个新点子),这一问就顺着那件事问
 * 「这件事更像做产品还是做自媒体运营?」,而不是凭空让他在两套布局里挑。
 *
 * **两个选项都念出来,不要推荐一个** —— 这一问没有"更常见的那个",他做什么只有他知道;
 * 也**不要展开讲每个模板里有哪几块**(电话里念一串模块名没人记得住),他听到
 * 「产品研发」和「自媒体运营」就够判断了。听不出来就照他说的活儿归类,再复述一次确认。
 */
const TEMPLATE: StageDef = {
  id: 'template',
  label: STAGE_LABEL.template,
  seed: '你说的这件事,更像是做产品研发,还是做自媒体运营?我按这个给你把工作台摆好。',
  goals: [
    'product(做产品研发)还是 ops(自媒体运营)',
    '**顺着他上一段说的那件事问**:「你说的<那件事>,更像做产品还是做自媒体运营?」—— 已有的、新点子都这么问,别换成凭空的「你选哪套布局」',
    // 2026-09-24(卡 fix/firstrun-session-after-answers):原来这一条是「先问一句『你在做的 / 想做的是件什么事?』,听完再问像哪一类」。
    // 可电脑首次流程的对话屏在她开口之前就把这一段的种子句摆出来了(chatHerLine),她再先绕一句「你在做什么」,
    // 屏上那句与她说的就打架,布局那一问前后出现两次 —— 维护者 09-24:首次流程里同一个问题只出现一次。
    '他还没说过在做什么(分岔是在屏幕上点按钮答的):**直接照种子句问这一题**,「你说的这件事」按他选的分岔说成「你在做的这件事」或「你想做的这个新点子」;'
    + '**别先另问一句「你在做什么」再绕回来** —— 屏幕上已经摆着这一问,多绕一句就是同一个问题问两遍。他答的是在做什么,照下面那条替他归类',
    '**这一问要问出口**:他在上一段顺口说了「做产品」「做号」也不算选好了,这一问照样问',
    // 2026-09-24 真机第五轮:问「更像做产品还是做运营」→ 他答「产品研发」→ 她又「那我先给你摆成做产品研发那一套……对吗?」,他反问「你为什么问我那句对吗」。
    '**他答得明确就直接记,不复述、不求确认**:他说了「产品」「研发」「写代码」「运营」「做号」「自媒体」这类一听就归得了类的话,当场记 template,'
    + '回一句很短的话就往下走(「好,按做产品那一套摆。」),**不说「对吗」**',
    '**只有他答得含糊才确认一次**:两样都沾(「都有点」)、或者说的活儿你拿不准归哪类,才复述一句「那我先按 X 那一套摆,行吗?」',
    '**两个都念出来,不推荐**;他说的是干的活儿(「我剪视频的」「我写代码的」)就替他归类直接记',
    // 「有什么区别」那一句**从模板自己的 tagline 生成**,不在这儿另写一份。
    // 第一版这里写死的是「做产品那套盯的是仓库和额度」—— 那句话把「产品研发 = 仓库 + 额度」
    // 这条 vibecoding 假设固化进了**内核**(两个模板共用同一个 TEMPLATE 阶段定义,
    // 模板覆盖不了它),而且以后加第三个模板时这里会悄悄说错话。
    '**不要念模块清单** —— 电话里念一串「待办、发布计划、素材管理…」没人记得住;'
    + `他要是问"有什么区别",一句话说完:${allTemplates().map(t => `${t.name} ${t.tagline}`).join(' ')}`,
    '拿不准就默认 product,并说一句「以后在设置里随时能换,换布局不丢东西」',
    '**他问「为什么问这个」就一句话答**(「两类活儿桌面摆法不一样」),不展开讲每套里有什么',
  ],
  keys: {
    template: {
      kind: 'template',
      desc: 'product = 做产品研发 / ops = 自媒体运营。答完服务端会当场把布局换过去',
      required: true,
    },
  },
  writes: [
    '~/.dsh/workbench/template.json(当前模板)+ 横竖两份模块布局',
    '运营模板另外:工作目录下的「账号」与「素材/*」七个文件夹(只建不删)、窗位清单里的几个应用',
    'docs/记忆/用户-<称呼>.md 的「布局模板」一行',
  ],
}

/**
 * ② 分岔。2026-09-23 起排在 ①′ 布局**之前**,问的时候还不知道他做产品还是做运营,
 * 所以这一句是**中性**的:不说"项目"(运营的人听着像别人的事),也不说"账号"。
 * 模板不再换这一句(templates.ts 的 branch_seed 随之删掉)。
 */
const BRANCH: StageDef = {
  id: 'branch',
  label: STAGE_LABEL.branch,
  seed: '你现在是已经有在做的事,还是想从一个新点子开始?',
  goals: [
    '已经有在做的(A,existing)还是从一个新点子开始(B,fresh);答不清就问一句,再不清默认 A',
    // 2026-09-23 统筹自跑:上一题复述确认时他答「对」,她拿这个「对」记了 mode —— 这一问从没问出口。
    // 服务端拦(onboardingConsent.guardAnswer)。新顺序下上一题是称呼(他答称呼时的「对」「好」同样不算)。
    '**这一问必须问出口**:上一题他说的「对」「好」是在答上一题,**不是这一题的答案**;先把这句问出来,等他答了再记 mode',
    '**先别问是做产品还是做运营、也别提布局** —— 下一段才问;他顺口说了在做什么(「我在做个 App」「我有个小红书号」)就记在心里,下一段顺着它问',
    '一个字都不提"项目""账号":做运营的人听到"项目"会以为问的不是他',
  ],
  keys: {
    mode: { kind: 'mode', desc: 'existing = 已经有在做的;fresh = 从一个新点子开始', required: true },
  },
  writes: ['引导进度(mode)'],
}

/**
 * 「协助梳理」的五条(2026-09-20,Ben:「更多是问问题和总结,而不是协助梳理」)。
 *
 * 早上那通真实引导里她连问八题、每答一条记一条 —— 每一句都是问句,没有一句复述、
 * 没有一句提议。这五条是把「问卷」改成「梳理」的全部内容,**A 线 B 线通用**,
 * 所以提成一份常量;两条支线各自的清单只管自己那点不同。
 */
export const ASSIST_GOALS = [
  '**先梳理再追问**:他说完一段,你**第一句永远是复述成结构**(「我听到三件事:一是…二是…三是…」),'
  + '顺手指出里头的关系与矛盾(「硬件重做和 10 月 4 号报名,这两件是挤在一起的」);复述完了再问。'
  + '**复述后面只跟一个问句** —— 要么「对吗」,要么下一个问题,不两个都来。',
  '**一轮最多一个问题**,而且这个问题要**从他上一段话里长出来** —— 不是从你心里那张清单上取下一条。'
  + '清单是用来对照「还差什么」的,不是用来挨个念的。',
  '**字段顺手从对话里摘**:一段话里同时带了截止日和合作者就两样一起记,不回头补问;'
  + '他没提到的先空着,聊到了再记 —— 为了填满一个字段去多问一句,那就是问卷。',
  '**有边界**:你没有依据的事**不替他估**。「3D 打印的外壳来得及吗」这种,你不知道打一个壳要一天还是两周 ——'
  + '只能问「这件大概要多久?」,不能自己下结论说来得及或来不及。要作判断先把它说成猜测:'
  + '「我猜这一件不占你几天,对吗?」,他点头了才算数。**不替他下结论、不替他估别人的工作量。**',
  '**懂日历**:说到任何日期,先用 count_workdays 算一遍再开口(「10 月 4 号是国庆假里的周日,'
  + '从今天到那天实际工作日只剩 X 天」)。节假日表在工作台那边,**不要自己心算,也不要猜连休到几号**。',
] as const

/**
 * 「别让他从零排时间」(2026-09-20,Ben:「先问目前的安排是什么、有哪些事项,
 * 然后按优先级先排一个方案给用户,别让用户在 0 基础上自己排时间」)。
 *
 * 顺序是**收集 → 排 → 念 → 他确认 → 才落成事项**,四步一步都不能省:
 * 没收齐就排,排出来的是瞎排;不念给他听就落事项,那是替他做主。
 */
export const PLAN_GOALS = [
  '**先问「目前的安排是什么」「手上有哪些事项」** —— 不是问「你下一步打算做什么」。'
  + '他已经在脑子里排过一遍了,你要的是把那一遍掏出来,不是让他当场再排一遍。',
  '收齐了(事项、截止日、他说的轻重)**你来排**:按优先级和日期排一个方案,'
  + '用 count_workdays 对一遍日期,**念给他听**:「我建议这么排:这两天先…,国庆前…,你看行不行?」',
  '他改就照他的改,**确认了才用 plan 这一项落成事项**;他没点头就一条都不落。'
  + '他说「先这样」「回头再说」也算没点头 —— 那就只记进项目文件的下一步,不建事项。',
  // W(2026-09-23 统筹第三轮自跑):他说「没了,下一步」,她还在追问排期、中秋放几天。
  '**他说「没了」「下一步」「先这样」就收**:排期、假期、细节都不再追问,手上有的先记下,记 done 进下一段;没问到的明说一句「这些以后随时补」',
] as const

/**
 * ②′ 已有项目(2026-09-23 维护者拍板改):**先问交哪一个,不先扫**。
 *
 * 09-20 那一版是「授权 → 当场全量扫 → 照清单聊」。维护者真机上不舒服:他只想录「工作台」这一个,
 * 她却像是要把整台电脑的仓库都过一遍。现在的顺序:
 *   1. 先问「你想先把哪个项目交给我?」—— 他说哪个就**只录哪个**(按名字 / 路径找,`scan_projects` 带 name);
 *   2. 他说不清在哪 / 「你帮我找找」—— 才全量扫;扫完只念候选让他挑,**挑中的才录,没挑的一个不记**;
 *   3. 他说「全部」—— 先说清全扫要一会儿、之后得一个一个过,**建议先从一个开始**;他坚持就先排优先级,再按顺序一个个对齐;
 *   4. 聊完告诉他:以后随时说「再加一个 XX」就能加,不必重走引导。
 */
const PROJECTS_EXISTING_GOALS = [
  '**先不扫**。开口就问「你想先把哪个项目交给我?」—— 他说哪个就**只录哪个**,别的一个都不提',
  // 2026-09-23 统筹自跑:她没问就先把 read_scan_roots 记成可以、去看了目录,事后才说「顺手记成可以了」。
  // 服务端现在拦:没有「问出口 + 他点头」的那一问一答,read_scan_roots 记不成可以,/onboarding/scan 也就 403。
  // 2026-09-24(维护者拍板,已有项目拉齐确认点 1):问一句就够 —— 找它、读它的说明和最近的记录一起问,仍记 read_scan_roots,不另加一问。
  `他报了名字或路径:**先问后看** —— 还没有读目录的授权,就先问一句「${ASK_TO_READ}」,`
  + '**等他说可以**,再把 read_scan_roots 记成 true,再用 scan_projects 带上 name 找它(**只找这一个,不全量扫**;打字这条路是 POST /onboarding/scan {"name":"工作台"})。'
  + '**没问之前不许看,也不许事后补一句「顺手记成可以了」** —— 按名字找也算看。没找到就问他放在哪,给个路径就行',
  // 2026-09-24(确认点 2 / 3):找到唯一一个就先读,用读到的内容问「是这个吗」;复述两句以内,之后只问文档里没有的。
  // 2026-09-24 下午小修:电脑那条路她拿到摘要后又调了一次 project-brief(读了两遍,多一两秒)。
  '**只找到一个时,工作台已经顺手读好了**:回包里有摘要(brief)和用法(note),**不用再调 project-brief**,**照 note 说** —— 找到了哪个、读了哪几份,'
  + '两句以内复述它做什么、给谁、现在到哪,再问「是这个吗」;他点头或纠正之后才记 project(one_liner / status / next_step 用他认可的说法,path 原样带上)。'
  + '找到几个像的、或者回了候选:只念名字让他挑,挑中了用 POST /onboarding/project-brief {"path":"<那一个的 path>"} 读它,照回包的 note 说;他后来说「你再看看」也走这一条',
  '**读项目只走这两个接口**(scan 带 name / project-brief):拿到什么说什么,**不自己打开他的文件**(不 ls、不 cat、不 git log、不满仓库翻),'
  + '**没有读目录的授权时更不许**;哪一段写着没读到就如实说没读到,不编',
  '他说不清在哪、或者说「你帮我找找」:这时才整个扫一遍(scan_projects 不带 name;那几秒界面上会显示在扫)。'
  + '扫完**只念候选让他挑**(「我看到最近在动的是 X、Y,是哪个?」,别一条条念完、别念路径),**挑中的才录,没挑的一个都不记**',
  '他说「全部」:先说清「全扫要一会儿,之后得一个一个过背景和目标,**建议先从一个开始**」;他坚持说无所谓,'
  + '就先扫、再让他排个先后,然后**按顺序一个一个**对齐背景、目标、下一步 —— 一次只聊一个,其余记「稍后」',
  ...ASSIST_GOALS,
  '要弄清的(**是清单不是问题**,顺着他说的摘,别挨个问):'
  + '这个项目是什么、给谁用;做成什么样算成;现在到哪了、卡在哪;'
  + '关键决定 / 不能碰的 / 一起做的人与 Agent;下一步与截止日。'
  + '**读到的摘要里有的(说明、设计、交接、决策记录、最近提交)别拿它当问题问他**,只问文档里没有的',
  // 2026-09-24(确认点 2):交接里写着的下一步由她念出来让他排先后 —— 那就是下面「目前的安排」那一问的答案。
  '**读到了交接的**:交接里写着的下一步由你念出来(最多三条),问他先做哪个 —— 这就是下面「目前的安排」那一问,'
  + '**不再问「你手上有哪些事」**;没读到交接、或者他说交接旧了,才照下面问',
  ...PLAN_GOALS,
  '**扫到 / 找到 / 读到的是素材不是结论** —— 仓库看到的与用户说的矛盾时指出来,以用户为准',
  // 2026-09-24 下午小修:以前写「照上面那句再问一遍」,她就说成「那我再问一遍确认:……」—— 过程话。
  '他说不可以读目录:一句话应下来,改走访谈线(全靠问),**别再提扫描**;'
  + '他后来改口说「你去看吧」:**直接照上面那句问他**,像头一回问那样,不提前面问过,也不说「确认一下」这类话;'
  + '他答了可以再记、再找、再读(不能拿他那句顺口话直接记)',
  '这一个聊完告诉他一句:「以后想再交一个,随时跟我说『再加一个 XX』就行,不用再走一遍这套。」—— **不追问还有没有别的**',
  // 2026-09-21(Ben:「Agent 客户端里的记忆这件事,后面在引导里要加一条进去,在已有项目
  // 那里要加,就是要不要把记忆拷贝到事务官那」)。**放在扫完仓库、聊过项目之后**:
  // 这一问要他再点一次头让工作台读他电脑上的东西,摆在这一段开头会把授权那一问问成两遍;
  // 而且聊过项目之后他才知道"拷过来能干什么"。
  // 一个英文词都不出现 —— 他不知道什么叫 memory 目录,他知道的是「Claude 里记着的那些东西」。
  // 2026-09-27(卡 OB):那串家名以前写死成「Claude、Codex、Kimi」,新机器上照样念没装的两家。
  // 现在由 importMemoriesGoal() 按本机探到的名单造句(见 MachineFacts)。
  IMPORT_MEMORIES_GOAL,
] as const

const PROJECTS_FRESH_GOALS = [
  ...ASSIST_GOALS,
  '要弄清的(顺着聊,不是四道题):一句话说它是什么;想解决谁的什么问题;'
  + '现在手上有什么(想法 / 素材 / 人);阶段由他定 —— 市场调研还是项目策划',
  /*
   * 2026-09-27(卡 OB,统筹盘点第 2 条):这里原来混着 PLAN_GOALS,而它第一条是
   * 「**先问「目前的安排是什么」「手上有哪些事项」**」—— 新点子这一支他手上一件事都还没有。
   * 现场那句「按照跟这件事相关的事项来写」就是从这儿来的。删掉,换成从零那一支自己的说法。
   */
  '**这是个还没开始的新点子**:**不问「你手上有哪些事」「目前的安排是什么」**,也不提'
  + '「跟这件事相关的事项」「已经在做的」—— 他手上什么都还没有,问了等于让他替你想',
  '聊清了是什么、给谁之后,**你来排第一步**(一两件最小的、这几天能动手的),念给他听;'
  + '他点头了才用 plan 落成事项,没点头就只写进项目文件的「下一步」',
  '**他说「没了」「下一步」「先这样」就收**:手上有的先记下,没问到的明说一句「这些以后随时补」',
] as const

const PROJECTS: StageDef = {
  id: 'projects',
  label: STAGE_LABEL.projects,
  // 2026-09-23(维护者拍板):先问交哪一个,不先扫、不先要读目录的授权 —— 他报了名字再去找那一个。
  seed: '你想先把哪个项目交给我?说个名字就行,我先只录这一个。',
  goals: PROJECTS_EXISTING_GOALS,
  keys: {
    read_scan_roots: { kind: 'bool', desc: AUTH_KEY_DESC.read_scan_roots },
    read_session_titles: { kind: 'bool', desc: AUTH_KEY_DESC.read_session_titles },
    read_workbench_state: { kind: 'bool', desc: AUTH_KEY_DESC.read_workbench_state },
    /**
     * 2026-09-22(C5):拷记忆那一下**先要这一项授权**。这一段里也能答 ——
     * ③ 授权补全在这一段**之后**,把它留到那时候问,②′ 这一问就永远拷不成。
     */
    read_client_files: { kind: 'tri', desc: `${AUTH_KEY_DESC.read_client_files}:true=可以 / "ask"=要问 / false=不可以`, required: false },
    project: { kind: 'project', desc: PROJECT_VALUE_DESC },
    plan: { kind: 'plan', desc: PLAN_VALUE_DESC },
    /**
     * 2026-09-21:各家客户端自己记的那些东西,拷不拷一份过来。
     *
     * **不是必答项**:他不答这一段照样做得完 —— 这一问是加法,不是新的一道关。
     * **它自己不是授权**:这一项是"就现在,拷这一次";"以后还能不能去翻"是上面那项
     * `read_client_files`(2026-09-22 C5 加的)。两件事分开记,但**拷这一次要先过那一项**:
     * 那一项不是「可以」,工作台一个字节都不拷,并如实回一句(见 server/onboarding.ts)。
     */
    import_memories: {
      kind: 'bool',
      desc: '各家客户端(Claude / Codex / Kimi)自己记的那些东西,拷不拷一份到事务官这边。'
        + 'true=拷(工作台当场拷,只读原件、不改不删);false=不拷(记下来,往后不再问)',
    },
    done: { kind: 'bool', desc: '他交给你的那一个(或他排了先后的那几个)聊完了;没挑的不算', required: true },
  },
  writes: [
    'docs/记忆/授权.md 的「能读什么」三项(拿到哪项就写哪项)',
    'docs/记忆/来自-<家>/(他点头了才拷:各家客户端的记忆原样拷一份,附一份「来源.md」写清哪份来自哪里)',
    'docs/记忆/项目/<名>.md:一句话 / 阶段 / 目标 / 截止日直接写(当场答即拍板);进展 / 细节 / 下一步 / 拿不准追加',
    '新项目:新建项目文件并补一行到 docs/记忆/项目/索引.md',
    '他点头了的方案:写进项目文件的「下一步」,并按每条建一个事项(没接看板就如实说建不了)',
  ],
}

const PROJECTS_FRESH: StageDef = {
  id: 'projects',
  label: '②′ 从零开始(B1 点子访谈 → B2 立项)',
  seed: '好,那我们从这个点子聊起。先用一句话说说它是什么?',
  goals: PROJECTS_FRESH_GOALS,
  keys: {
    idea: { kind: 'idea', desc: IDEA_VALUE_DESC, required: true },
    plan: { kind: 'plan', desc: PLAN_VALUE_DESC },
  },
  writes: [
    'docs/记忆/项目/<名>.md(新建;一句话 / 阶段 / 目标 / 下一步当场答即拍板)+ 索引一行',
    '第一个事项(方向 = 我交给事务官;有看板才建,建不了如实说)',
    '他点头了的方案:每条建一个事项',
    '不扫描任何目录,不装东西',
  ],
}

/**
 * 运营那条线的 ②′(2026-09-21「项目数据源换成账号」)。
 *
 * 上一版(布局模板那张卡)只换了这一段的**种子句与 goals** —— 问的是账号,
 * 记下来的却还是 `project`,落盘落进记忆仓库的 `docs/记忆/项目/<名>.md`。
 * 也就是说她问完账号定位、风格、人群、平台之后,工作台的项目区里**什么都不会多出来**。
 *
 * 这一版把记的东西也换了:`account` 这一项落成**工作目录下** `账号/<名>/账号.md`,
 * 而那正是账号数据源(server/accountSource.ts)读的地方 —— 所以答完下一拍项目区里就有它。
 *
 * `done` 那一项的人话里带着「还有别的账号吗」:**多账号是一次问清的**,
 * 一个账号发一次 `account`,发几次就有几个文件夹。
 */
const ACCOUNT_VALUE_DESC
  = '一个账号的一项或几项:{ name(账号名,必填,会拿它建文件夹), '
    + 'positioning(定位:这个账号是做什么的、一句话说清), style(风格:什么调性、什么形式——口播/图文/剧情/测评…), '
    + 'audience(人群:给谁看的、他们在意什么), platform(平台:主阵地是哪个), '
    + 'opened_at(开号日期,他说得出就记,说不出别问第二遍), later(true=这个账号稍后聊) }。'
    + '每弄清一项就发一次,不必一次填全'

/** 运营线 + 新点子(2026-09-23,分岔先于布局之后才有这一支)。 */
export const ACCOUNTS_FRESH_SEED = '好,那我们从这个新号聊起。先用一句话说说它打算做什么内容、给谁看?'
const ACCOUNTS_FRESH_GOAL
  = '**这是个还没做起来的新号**:号还没开也没关系,先给它起个名字(以后能改)记成 account 的 name;'
  + '定位 / 风格 / 人群顺着聊,平台想好了就记,**开号日期不问**'

const PROJECTS_ACCOUNTS: StageDef = {
  id: 'projects',
  label: '②′ 账号(定位 / 风格 / 人群 / 平台)',
  // 种子句与 goals 由模板覆盖(用户层 布局/<id>.json 里的 onboarding);这里这一份是"万一模板没写"的兜底,
  // 与模板那一份说的是同一件事。
  seed: '那我们从这个账号聊起。先用一句话说说它是做什么的、给谁看的?',
  goals: [
    ...ASSIST_GOALS,
    '要弄清的(**是清单不是问题**,顺着他说的摘):账号定位 / 内容风格 / 目标人群 / 平台;'
    + '开号日期他顺口说了就记,**不为了填满它多问一句**',
    '**一个仓库都不要扫,也不要提「读你放仓库的目录」** —— 运营这台机器上没有仓库',
    // 2026-09-23(维护者拍板,同项目那一支):先录一个,不全量录。
    '**先问先录哪个账号**,只录这一个;聊完告诉她「以后想加别的账号,随时说『再加一个 XX』就行」,**不追问还有没有别的**;'
    + '她自己主动说还有,才再发一次 account(**一个账号一个文件夹**)',
    ...PLAN_GOALS,
  ],
  keys: {
    account: { kind: 'account', desc: ACCOUNT_VALUE_DESC },
    plan: { kind: 'plan', desc: PLAN_VALUE_DESC },
    done: { kind: 'bool', desc: '她先交给你的那个账号聊完了(她主动提的别的也聊了);不追问还有没有别的', required: true },
  },
  writes: [
    '<工作目录>/账号/<账号名>/账号.md:定位 / 风格 / 人群 / 平台 / 开号日期(当场答即拍板,只补不覆盖)',
    '<工作目录>/账号/<账号名>/笔记/(空文件夹,以后一条笔记一个文件)',
    '他点头了的方案:按每条建一个事项(没接看板就如实说建不了)',
  ],
}

const AUTHORIZATION: StageDef = {
  id: 'authorization',
  label: STAGE_LABEL.authorization,
  seed: '接下来是我能做什么。先说清楚:删文件、改代码、碰凭据这些我永远不会请求。要问你的是三件事——',
  goals: [
    // Y(2026-09-23 统筹第三轮自跑):授权还没问完就插一句「你一天大概怎么分段」,又回头问授权。
    '**这一段只问授权,一项一项来,问完才进下一段**:作息、汇报、音乐、常用应用这些是下一段的题,**这一段一个都不问**(他顺口说了记在心里,下一段再用)',
    // X(同上):她照老说法念成「往这个仓库的 docs 里写东西、并且提交推上去」—— 不对也吓人。
    // 实际:写在事务官自己的工作目录的 docs/记忆/,每一段本地 git 提交一次,从不 push。
    '写记忆与存版本(write_docs + write_commit,**一句问完,两项按他同一个回答记**):照这个意思说'
    + '「我会往我这边的记忆文件夹里写你的偏好和项目,每次存一个版本、能翻回去,只在这台电脑上 —— 可以、要问,还是不可以?」。'
    + '**不说「仓库」「docs」「提交」「推上去」「push」「commit」**:记忆不在他的代码仓库里,也从来不推到任何地方',
    '调工作台写接口(建事项、收件箱、看板)——默认不可以,单独一问',
    // 2026-09-22 Ben 定的 C5。**一个英文词都不出现**:他知道的是「Claude 里记着的那些东西」,
    // 不是「memory 目录」。三档同写 docs 那一问 —— 「要问」= 每次动手前问一句。
    // 2026-09-27(卡 OB):那串家名由本机探测给,不写死(见 MachineFacts)。
    CLIENT_FILES_GOAL,
    '(B 线在这里补问读权限:扫描根、会话标题、工作台状态)',
    // 2026-09-25(卡 N,统筹定):判断每件事做到哪了要看相关会话的最后几轮,并进这一段一起问。**一个英文词都不出现**。
    SESSION_CONTENT_GOAL,
    '主动声明:删文件 / 改代码 / 凭据永不请求',
    // 2026-09-23 统筹自跑:这一段只问了写记忆与写接口,系统授权(辅助功能)从头到尾没出现,最后只剩主界面一条红横幅。
    '**系统授权(辅助功能)**:先 GET /onboarding/system-auth 看一眼 —— `accessibility` 是 granted 就提一句「辅助功能那个开关你已经开好了」跳过;'
    + `否则讲清为什么要:「${SYSTEM_AUTH_WHY}」,问他「我现在帮你把那一页打开,可以吗?」;`
    + '他说可以 → POST /onboarding/system-auth(工作台会弹系统框、打开设置页),然后告诉他「系统要是弹了框就点『打开系统设置』,在列表里把『工作台』打开」;'
    + '屏幕上也会亮一颗「去授权」,他自己点也一样。**你替他点不了那个开关**;他说不要就过,不劝。这一项不用记 key,工作台自己会复查',
    // 2026-10-13(维护者:「我在手机上每次看文件,电脑上都有一个授权弹窗要点…不解决这个功能就废了」)。
    // 位置紧跟上一条:同是「系统授权」,同是只有他点得了。**这一样连系统框都弹不出来** ——
    // macOS 不给程序请求「完全磁盘访问」的机会,所以这一条只讲清为什么要 + 指路,不许说"我帮你开"。
    '**系统授权(完全磁盘访问)**:接着上一条问 —— 先 GET /onboarding/system-auth 看 `file_access`:'
    + 'granted 就提一句「手机看文件要的那个授权你也给过了」跳过;unknown(判断不了)就别提这一项,一个字都别说;'
    + `missing 才讲清为什么要:「${FILE_ACCESS_WHY}」,`
    + '然后告诉他「屏幕上体检那一页第 3 步有一格『完全磁盘访问』,三颗键:打开系统设置那一页、在访达里显示要加的那个文件、再核一次;'
    + '那个文件在隐藏目录里,所以一定要用第二颗键把它翻出来拖进去,加完点第三颗键核一下 —— 一般当场就生效,不用重启」;'
    + '**这一项你连系统框都弹不出来,全程只能指路**(不像上一条,上一条你能替他按一下);他说以后再弄就过,不劝。这一项不用记 key',
  ],
  keys: {
    write_docs: { kind: 'tri', desc: `${AUTH_KEY_DESC.write_docs}:true=可以 / "ask"=要问 / false=不可以`, required: true },
    write_commit: { kind: 'tri', desc: `${AUTH_KEY_DESC.write_commit}:true / "ask" / false`, required: true },
    write_api: { kind: 'tri', desc: `${AUTH_KEY_DESC.write_api}:true / false(默认 false)`, required: true },
    read_client_files: { kind: 'tri', desc: `${AUTH_KEY_DESC.read_client_files}:true=可以 / "ask"=要问 / false=不可以`, required: true },
    /**
     * 卡 N(2026-09-25,统筹定):并进这一段一起问,**不是必答项** —— 她漏问了也不挡引导收尾(老存档、已经走完引导的人同理),
     * 第一次核进度要读会话时在外层问他一次(progress.ts 的 `ACCESS_QUESTION`,走卡 M 的提问),答了写回授权表这一格。
     */
    read_session_content: { kind: 'tri', desc: `${AUTH_KEY_DESC.read_session_content}:true=可以 / "ask"=要问 / false=不可以` },
    read_scan_roots: { kind: 'bool', desc: AUTH_KEY_DESC.read_scan_roots },
    read_session_titles: { kind: 'bool', desc: AUTH_KEY_DESC.read_session_titles },
    read_workbench_state: { kind: 'bool', desc: AUTH_KEY_DESC.read_workbench_state },
    /**
     * 2026-09-24 晚(卡 feat/onboarding-materialize):这一段问「读各家客户端文件」时,提示词同时让她问「要不要拷一份过来」,
     * 而这个 key 以前只在 ②′ 收 —— 真机上连着两次 `authorization.import_memories → 400`,记忆一份没拷。
     * 现在这一段也收:先 read_client_files,再 import_memories(同一道授权门,同一个拷法)。
     */
    import_memories: {
      kind: 'bool',
      desc: '各家客户端(Claude / Codex / Kimi)自己记的那些东西,拷不拷一份到事务官这边。'
        + 'true=拷(先把 read_client_files 记成可以;工作台当场拷,只读原件);false=不拷(往后不再问)',
    },
  },
  writes: ['docs/记忆/授权.md(整份由阶段机重写;插件的写接口按它校验)', 'docs/记忆/来自-<家>/(他点头了才拷)'],
}

const HABITS: StageDef = {
  id: 'habits',
  label: STAGE_LABEL.habits,
  seed: '再聊聊你平时怎么干活——不用一条条答,聊到哪记到哪。',
  goals: [
    '工作节奏:一天几段、几点开工收工、什么时候不想被打扰',
    '汇报偏好:早上先汇报再干活?变化到什么程度才叫你?',
    '语音还是文字、称呼语气、要不要 Live2D 形象说话',
    '音乐口味:喜欢的歌手、曲风、工作时听什么、不想听什么(供 AIDJ 建歌单)',
    // 2026-09-18:窗位槽空态那句「或让事务官在引导里帮你选」从此有着落 —— 答了就写进窗位清单。
    '平时最常开哪几个应用(「我把它们放进窗口槽」)——这台机器上装了哪几家,下面那份清单里有的话就照着念,没有就开放地问,别编',
    '其它自述(只记工作需要的,不追问私事)',
  ],
  keys: {
    rhythm: { kind: 'string', desc: '工作节奏' },
    report_pref: { kind: 'string', desc: '汇报偏好' },
    channel: { kind: 'string', desc: '语音 / 文字 / 形象' },
    music: { kind: 'string', desc: '音乐口味' },
    apps: { kind: 'apps', desc: '常用应用:数组,写他说的应用名或窗位键(Claude / Kimi / 微信 / 企业微信 / 终端 / 日历…);服务端认成窗位键写进窗位清单,认不出的原样留着给人看。不想选就别发这一项' },
    self_intro: { kind: 'string', desc: '自述:一句话介绍自己、现在的重心' },
    other: { kind: 'string', desc: '其它与工作有关的' },
    done: { kind: 'bool', desc: '聊够了', required: true },
  },
  writes: [
    'docs/记忆/用户-<称呼>.md 的「偏好」与「自述」(常用应用记一行)',
    '~/.dsh/workbench/apps.json 的 enabled(窗位清单;认不出的名字不写进去)',
  ],
}

const PERSONA: StageDef = {
  id: 'persona',
  label: STAGE_LABEL.persona,
  seed: '接下来的日子里,你希望我用什么样的方式和状态跟你对话?有三种,可以混搭,也可以自己描述——',
  goals: [
    '三个人设挑一个:沉稳(话少,先结论后理由)/ 周到(主动细致,顺手关心你)/ 傲娇(嘴硬心软,不邀功)',
    '两个旋钮:直言度(1 委婉 ↔ 5 说破风险、会反驳)、话量(1 只答不问 ↔ 5 主动提醒)',
    '混搭或自己描述的记 persona_note',
  ],
  keys: {
    persona: { kind: 'persona', desc: '沉稳 | 周到 | 傲娇', required: true },
    candor: { kind: 'knob', desc: '直言度 1–5', required: true },
    verbosity: { kind: 'knob', desc: '话量 1–5', required: true },
    persona_note: { kind: 'string', desc: '用户自己的描述 / 混搭说明' },
  },
  writes: ['docs/记忆/用户-<称呼>.md 的「对话预期」', '~/.dsh/AGENTS.md 的「说话方式」一节(只改标记段)'],
}

const NAMING: StageDef = {
  id: 'naming',
  label: STAGE_LABEL.naming,
  seed: '最后,给我取个名字吧——以后你这么叫我,我也这么自称。',
  // AA(2026-09-23 统筹第三轮自跑):他已经说了「就叫小管家」,她回「我先按流程这一题正式问一次:给我取个名字吧……是小管家,对吗?」。
  goals: [
    '名字;没想好就先叫「事务官」',
    '**他已经说了叫什么**(这一段或前面哪一段顺口说的「就叫小管家」)**就直接记**,不再问这一题,也不再问「对吗」:应一句「好,以后我就叫小管家」就行',
  ],
  keys: {
    butler_name: { kind: 'string', desc: '事务官的名字(空 = 事务官)', required: true },
  },
  writes: ['~/.dsh/AGENTS.md 首行「我叫 X」', 'docs/记忆/用户-<称呼>.md 的「事务官的名字」'],
}

const WRAPUP: StageDef = {
  id: 'wrapup',
  label: STAGE_LABEL.wrapup,
  // 2026-09-24 晚(卡 feat/onboarding-materialize,维护者:「结束环节的大总结听得我好累」):
  // 以前开口就是「我把今天了解到的复述一遍……」,真机上念了 240 字总结,末尾还念了 docs/记忆/… 的路径。
  // 现在收尾只问还没答的那几项,完整的单子摆在屏幕上(「我照你说的摆好了」),一句都不念。
  seed: '最后几件小事,问完我就把今天说的摆上屏。早上要我先报一下当天的安排再开工吗?',
  goals: [
    '**不复述、不念清单、永不念文件路径**:今天说的都摆在屏幕上那张「我照你说的摆好了」里,你一句都不念;记忆写进了哪几份文件也不说',
    '**每轮最多两句短话、一个问题**',
    '前面已经说过的**直接记、不再问**:习惯里说过「早上先听汇报」就把 morning_report 记 true;说过几点收尾就记 evening_routine;说过爱听播客、想按项目定向搜就把 feed_podcast 记 true',
    '还没说过的才问:早上要不要先汇报;晚上几点收个尾;要不要每天早上一段资讯播客(通勤时听,关注什么以后在设置里改)',
    '第一件:从他说的事里挑最急、已经有人在做的那件,一句话建议(「第一件让 Codex 接着把参赛网页的架构补完,行吗?」);他点头就记 first_item。**这一段不建事项**,落地时一起建',
    '他说「下去再确认」「回头再说」的记进 unsure,不念',
    '收尾这几项记完,工作台会让你接着把单子摆上屏(电话里调 setup_preview;打字这条路 POST /onboarding/materialize/preview):'
    + '**只说它回的那一句**(「都摆好了,两个项目、十件事,屏幕上有张单子;第一件交给 Codex 接着做参赛网页,行吗?」);'
    + '他说可以 / 就这样才落(setup_apply;打字这条路 POST /onboarding/materialize/apply),落完只说回话里那一句(「派出去了,做完叫你。」)',
  ],
  keys: {
    morning_report: { kind: 'bool', desc: '早上先汇报再干活', required: true },
    evening_routine: { kind: 'time', desc: '下班例程时刻 HH:MM', required: true },
    /**
     * 2026-09-21:**不设 required** —— 它是加出来的一问,设成必答会把所有还没答它的
     * 存量引导档从「收尾做完了」打回「还差一项」,而那些人早就跑完引导了。
     */
    feed_podcast: { kind: 'bool', desc: '每天早上给一段资讯播客' },
    first_item: { kind: 'string', desc: '第一件(他点头的那句;落地时建卡并派出去)', required: true },
    unsure: { kind: 'strings', desc: '拿不准的,数组' },
    recap_ok: { kind: 'bool', desc: '用户看过屏幕上的单子说没记错' },
  },
  writes: ['docs/记忆/用户-<称呼>.md 的「汇报节奏」「拿不准」「第一条事项建议」「资讯播客」', 'commit chore(记忆): 入职·收尾'],
}

const DONE: StageDef = {
  id: 'done',
  label: STAGE_LABEL.done,
  seed: '引导已经完成。',
  goals: [],
  keys: {},
  writes: [],
}

/**
 * 2026-09-21(布局模板):多一个**可选**的第三参 —— 当前布局模板 id。
 *
 * **缺席 = 与加它之前逐字相同**(做产品那一套),既有那一大批引导用例一条没改。
 *
 * 模板能换的只有两样:
 * 1. ②′ 的**种子句与 goals**(运营这条线上没有"项目",有的是账号)。② 分岔 2026-09-23 起排在布局之前,不换;
 * 2. `scan_repos: false` 时,②′ 那一段**摘掉三个 `read_*` 键**。
 *
 * 第 2 条不是"顺手也换一下 keys" —— 通话模式的工人是**按 keys 里有没有 `read_scan_roots`**
 * 决定要不要把「我可以真去看你的仓库」那一整段说给模型听的(channel-worker/src/onboarding.ts)。
 * 留着那三个键,运营模板下 goals 写着「一个仓库都不要扫」,而系统提示里同时躺着一段
 * 「你可以真去看他的仓库」—— 两句话打架,模型听谁的靠运气。三个键都**不是必答项**,
 * 摘掉不影响这一段什么时候算做完。
 *
 * `writes` 一个字不动:那是"这一段能写什么"的权限白名单,不是问法。
 */
export function stageDef(
  stage: OnboardingStage,
  mode: OnboardingMode | undefined,
  templateId?: string,
  carried?: Readonly<Record<string, unknown>>,
  /**
   * 这台电脑上的事实(2026-09-27,卡 OB)。**缺席 = 与加它之前逐字相同** ——
   * 既有那一大批引导用例一条没改(同 templateId / carried 的先例)。
   */
  facts?: MachineFacts,
): StageDef {
  const base = baseStageDef(stage, mode, templateId)
  // 新骨架(最多 5 问):④ 与 ⑤ 整段换掉,旧的授权补全 / 习惯 / 人设 / 取名 / 收尾不再问(不在计划里)。
  if (facts?.firstrun === true) return withFirstrun(base, stage, mode, templateId, facts)
  const carriedDone = stage === 'authorization' && carried !== undefined ? withCarriedConsent(base, carried) : base
  return withMachineFacts(carriedDone, facts)
}

/**
 * 「读他电脑上各家 AI 记着的东西」那几句话里的**名单换成本机探到的**(2026-09-27,卡 OB)。
 *
 * 三种情形:
 * - `facts` / `memoryFamilies` 缺席(没探过)→ 一个字不动(老接线、老用例);
 * - 探到了几家 → 那几句话按探到的名字重造,并明说「只念这几个」;
 * - 探过了一家都没有 → 这几句话与对应的 key(`read_client_files` / `import_memories` /
 *   `read_session_content`)**一起摘掉**,换成一句交代。key 摘掉 = 必答项里也没有它,
 *   这一段不会因为一个问不出口的问题卡住(接口白名单不动:`answer()` 那一路仍收,真要改照样收)。
 */
function withMachineFacts(def: StageDef, facts: MachineFacts | undefined): StageDef {
  const families = facts?.memoryFamilies
  if (families === undefined) return def
  const touched = def.goals.some(goal => goal === IMPORT_MEMORIES_GOAL || goal === CLIENT_FILES_GOAL || goal === SESSION_CONTENT_GOAL)
  if (!touched) return def
  if (families.length === 0) {
    const goals = def.goals.filter(goal => goal !== IMPORT_MEMORIES_GOAL && goal !== CLIENT_FILES_GOAL && goal !== SESSION_CONTENT_GOAL)
    return {
      ...def,
      goals: [NO_MEMORY_FAMILIES_GOAL, ...goals],
      keys: Object.fromEntries(Object.entries(def.keys).filter(([name]) => !(MEMORY_KEYS as readonly string[]).includes(name))),
    }
  }
  return {
    ...def,
    goals: def.goals.map((goal) => {
      if (goal === IMPORT_MEMORIES_GOAL) return importMemoriesGoal(families)
      if (goal === CLIENT_FILES_GOAL) return clientFilesGoal(families)
      if (goal === SESSION_CONTENT_GOAL) return sessionContentGoal(families)
      return goal
    }),
  }
}

// ——————————————— 新首次引导的那两段(2026-09-27,最多 5 问) ———————————————

/** ④ 这件事一句话:三支各一句。**只问这一句**,不扫、不读、不提进度。 */
const ONE_LINER_SEED: Readonly<Record<'existing' | 'fresh', string>> = {
  existing: '你在做的是什么?一句话就行。',
  fresh: '你想做个什么?一句话就行。',
}
const ONE_LINER_SEED_OPS: Readonly<Record<'existing' | 'fresh', string>> = {
  existing: '你在做的号是什么?一句话就行。',
  fresh: '你想做个什么号?一句话就行。',
}

/** ④ 那一段共同的规矩:一问一句,答完立刻记、立刻往下。 */
const ONE_LINER_RULES: readonly string[] = [
  '**只问这一句**:他答完就记,不复述、不追问细节、不问截止日、不问「还有别的吗」——'
  + '别的以后用到时再问,他自己也随时能说',
  '**不寒暄、不解释流程**、不说「为了后面的工作」这类话',
  '他一句话里带了名字就拿它当 name;只说了做什么、没给名字,就从他那句话里取一个短名(以后能改),**不为了取名多问一句**',
]

const ONE_LINER_FRESH_RULES: readonly string[] = [
  '**这是个还没开始的新点子**:这台电脑上什么都还没有 —— **不扫仓库、不读任何东西、不提「做到哪了」「相关的事项」「你手上在做的」**;'
  + '`scan_projects` / `/onboarding/scan` / `/onboarding/project-brief` 一个都不调(接口也会 403)',
]

const ONE_LINER_EXISTING_RULES: readonly string[] = [
  '**这一段也不扫、不读** —— 要不要读他电脑上的记录是下一段单独那一问;这一段只要他那一句话',
]

const ONE_LINER_OPS_RULES: readonly string[] = [
  '**模板是自媒体**:这一句答完再追一句「发在哪个平台?」记进 account 的 platform;'
  + '他刚才那句里已经说了平台(「我在小红书做…」)**就不问了**,直接记',
]

/**
 * ⑤ 读记录那一问(**只在分支=已有、而且本机真探到有记录可读的 AI 时出现**)。
 * 名单是代码探的(见 MachineFacts.memoryFamilies),模型只念。
 */
function recordsDef(families: readonly string[]): StageDef {
  const names = families.join('、')
  return {
    id: 'authorization',
    label: '⑤ 读记录(只读)',
    seed: `最后一件:能不能让我读一下${names}里跟这件事有关的记录,好知道做到哪了?只读,不改一个字。`,
    goals: [
      '**这一段只有这一问**:念完他答什么就记什么,答完这一段就结束 —— 不追问、不解释、不换个说法再问一遍',
      `**只念这几家:${names}**(工作台在这台电脑上探出来的)。没在这份名单里的一家都不许提 ——`
      + '名单外的一家**当这台电脑上没有它**(名字都别说出口);他说「我没有某某」时那是在纠正名单、不是拒绝,'
      + '**别记成不可以**,照名单里剩下的再说一次就行',
      '他说可以 → `read_client_files` 记成「可以」,紧接着 `import_memories` 记成 true(工作台当场拷,'
      + '回话里说拷了几份、哪几家没找到,**照那句话念,一个数都不许自己编**);'
      + '他不肯 → `read_client_files` 记 false,应一句就过,不劝、不再问',
      '**不摆「可以、要问,还是不可以」三选一**:就问一句「可以吗」。他自己说「每次先问我」才记「要问」',
      // 统筹 2026-09-27 盘点第 3 条:看板上每件事做到哪了,有「用到时再问」的通道(progress.ts 的 ACCESS_QUESTION,卡 M),
      // 引导里不问它 —— 一进门就问两个「能不能读」是同一件事问两遍。
      '**不问「看板上每件事做到哪了、能不能照你跟各家 AI 的对话来写」** —— 那一问以后真要用到时工作台会自己问他',
    ],
    keys: {
      // 说明里的家名同样**只能是探到的那几家**:这段文字会原样进第一条消息,写死三家就等于又念了一遍没装的。
      read_client_files: { kind: 'tri', desc: `读${names}里它们各自记着的东西与配置(只读):true=可以 / "ask"=要问 / false=不可以`, required: true },
      import_memories: { kind: 'bool', desc: `把${names}记着的东西拷一份到事务官这边(先把 read_client_files 记成可以)` },
    },
    writes: ['docs/记忆/授权.md 的「读各家客户端文件」一项', 'docs/记忆/来自-<家>/(他点头了才拷)'],
  }
}

/**
 * 新骨架下这一段长什么样(2026-09-27)。只改**怎么问**(种子句、要弄清的、必答项),
 * 接口白名单不动 —— `answer()` 那一路仍按完整的 stageDef 收,老存档、更正都不受影响。
 */
function withFirstrun(
  def: StageDef,
  stage: OnboardingStage,
  mode: OnboardingMode | undefined,
  templateId: string | undefined,
  facts: MachineFacts,
): StageDef {
  const families = facts.memoryFamilies ?? []
  if (stage === 'authorization') return recordsDef(families.length === 0 ? ['Codex'] : families)
  if (stage !== 'projects') return def
  const which = mode === 'fresh' ? 'fresh' : 'existing'
  const ops = templateById(templateId ?? '')?.project_source === 'accounts'
  const contentKey = ops ? 'account' : which === 'fresh' ? 'idea' : 'project'
  const keyDef = def.keys[contentKey]
  return {
    ...def,
    seed: (ops ? ONE_LINER_SEED_OPS : ONE_LINER_SEED)[which],
    goals: [
      ...ONE_LINER_RULES,
      ...(which === 'fresh' ? ONE_LINER_FRESH_RULES : ONE_LINER_EXISTING_RULES),
      ...(ops ? ONE_LINER_OPS_RULES : []),
    ],
    // 这一段只收那一项内容(done 不再要:一问一答,答完就往下)。
    keys: keyDef === undefined ? def.keys : { [contentKey]: { ...keyDef, required: true } },
  }
}

/**
 * 授权项在人眼里的名字(2026-09-23 Z)。③ 授权段复述「之前你已经说过可以」时用,不念 key。
 */
export const CONSENT_LABEL: Record<AuthKey, string> = {
  read_scan_roots: '看你放代码的那个目录',
  read_session_titles: '看各家会话的标题',
  read_workbench_state: '看工作台的状态',
  read_client_files: '读 Claude、Codex、Kimi 里记着的东西',
  read_session_content: '看你跟各家 AI 的对话的最后几句(判断事情做到哪了)',
  write_docs: '往记忆文件夹里写',
  write_commit: '每次存一个版本',
  write_api: '直接建事项、挪看板',
}

function consentWord(value: unknown): string | undefined {
  if (value === true || value === '可以') return '可以'
  if (value === false || value === '不可以') return '不可以'
  if (value === 'ask' || value === '要问') return '要问'
  return undefined
}

/**
 * Z(2026-09-23 统筹第三轮自跑):②′ 找项目时已经问过「看一眼你放代码的目录」、他答了可以,
 * 到 ③ 授权段她又问「这一项我也记成可以了,对吗?」—— 同一个授权问两遍。
 *
 * `carried` 是**前面几段已经答过的授权项**(阶段机从 ②′ 的答案里取)。在 ③ 这一段:
 *   - 它们从「本段能写 / 要弄清」的清单里摘掉(模型看不见就不会再问;接口白名单不动,真要改照样收);
 *   - 必答项里有它们的(`read_client_files`)算已答,不再挡推进;
 *   - goals 最前面多一行「已经答过的,这一段不再问,复述时带一句就行」。
 */
function withCarriedConsent(def: StageDef, carried: Readonly<Record<string, unknown>>): StageDef {
  const done = Object.entries(carried)
    .filter(([key]) => def.keys[key] !== undefined && key in CONSENT_LABEL)
    .map(([key, value]) => [key, consentWord(value)] as const)
    .filter((entry): entry is readonly [string, string] => entry[1] !== undefined)
  if (done.length === 0) return def
  const skip = new Set(done.map(([key]) => key))
  return {
    ...def,
    keys: Object.fromEntries(Object.entries(def.keys).filter(([key]) => !skip.has(key))),
    goals: [
      `**已经答过的授权,这一段不再问**:${done.map(([key, word]) => `${CONSENT_LABEL[key as AuthKey]}(${word})`).join('、')} —— `
      + '前面他亲口答过了,别再问「这一项也记成可以了,对吗?」;复述时带一句「之前你说过可以看你放代码的目录」就行',
      ...def.goals,
    ],
  }
}

function baseStageDef(
  stage: OnboardingStage,
  mode: OnboardingMode | undefined,
  templateId?: string,
): StageDef {
  const template = templateId === undefined ? undefined : templateById(templateId)
  const tpl = template?.onboarding
  switch (stage) {
    case 'opening': return OPENING
    case 'template': return TEMPLATE
    // 2026-09-23:分岔排在布局之前,问的时候不知道模板 —— 一律中性的那一句,模板不换它。
    case 'branch': return BRANCH
    case 'projects': {
      /*
       * 2026-09-21(项目数据源):这一段记的是「项目」还是「账号」,由**模板的
       * `project_source`** 决定,不是由种子句决定。
       *
       * 这是那个字段的第二个读它的人(第一个在 src/index.ts 挑数据源那儿)—— 它写下去的
       * 同一刻就有人读,正是上一版把 `project_source` 删掉时留下的那条规矩。
       *
       * `accounts` 这一支记的都是 `account`:运营那条线上没有"从零立项",新点子也是一个(还没开的)号。
       * 2026-09-23 起分岔先问,`mode=fresh` 只换开口那一句(见下面 ACCOUNTS_FRESH_SEED)。
       */
      const base = template?.project_source === 'accounts'
        ? PROJECTS_ACCOUNTS
        : (mode === 'fresh' ? PROJECTS_FRESH : PROJECTS)
      if (tpl === undefined) return base
      const keys = tpl.scan_repos === false
        ? Object.fromEntries(Object.entries(base.keys).filter(([name]) => !name.startsWith('read_')))
        : base.keys
      const merged: StageDef = tpl.projects_seed === undefined && tpl.projects_goals === undefined && keys === base.keys
        ? base
        : {
            ...base,
            keys,
            ...(tpl.projects_seed === undefined ? {} : { seed: tpl.projects_seed }),
            ...(tpl.projects_goals === undefined ? {} : { goals: tpl.projects_goals }),
          }
      // 2026-09-23:分岔先问了,运营线也分得出「已经有号」和「新点子」。新点子那一支还是记账号
      // (账号数据源读的是 账号/<名>/),只是开口换成「这个新号」,号还没开也能聊。
      if (template?.project_source === 'accounts' && mode === 'fresh') {
        return { ...merged, seed: ACCOUNTS_FRESH_SEED, goals: [ACCOUNTS_FRESH_GOAL, ...merged.goals] }
      }
      return merged
    }
    case 'authorization': return AUTHORIZATION
    case 'habits': return HABITS
    case 'persona': return PERSONA
    case 'naming': return NAMING
    case 'wrapup': return WRAPUP
    case 'done': return DONE
  }
}

export function requiredKeys(
  stage: OnboardingStage,
  mode: OnboardingMode | undefined,
  templateId?: string,
  carried?: Readonly<Record<string, unknown>>,
  facts?: MachineFacts,
): string[] {
  const def = stageDef(stage, mode, templateId, carried, facts)
  return Object.entries(def.keys).filter(([, key]) => key.required === true).map(([name]) => name)
}

/** 一个 key 摊平成「名字 + 形状 + 人话 + 必答吗」。给引导简报用(通道层工人照它讲值的形状)。 */
export interface KeyBrief {
  name: string
  kind: KeyKind
  desc: string
  required: boolean
}

/**
 * 本阶段能写的 key,按定义顺序。**不是**「要问的问题」——顺序只决定说给模型听的顺序。
 * 与 firstMessage() 里那份清单同一处来源(stageDef),两边不会长歪。
 */
export function keyBriefs(
  stage: OnboardingStage,
  mode: OnboardingMode | undefined,
  templateId?: string,
  carried?: Readonly<Record<string, unknown>>,
  facts?: MachineFacts,
): KeyBrief[] {
  const def = stageDef(stage, mode, templateId, carried, facts)
  return Object.entries(def.keys).map(([name, key]) => ({
    name,
    kind: key.kind,
    desc: key.desc,
    required: key.required === true,
  }))
}

/** 值的校验。合法回 { ok:true, value(规整后) },不合法回一句人话。 */
export function validateValue(kind: KeyKind, value: unknown): { ok: true, value: unknown } | { ok: false, error: string } {
  switch (kind) {
    case 'string': {
      if (typeof value !== 'string' || value.trim() === '') return { ok: false, error: '要一段非空文字' }
      return { ok: true, value: value.trim() }
    }
    case 'bool': {
      if (typeof value !== 'boolean') return { ok: false, error: '要 true / false' }
      return { ok: true, value }
    }
    case 'tri': {
      if (value === true || value === '可以') return { ok: true, value: '可以' }
      if (value === false || value === '不可以') return { ok: true, value: '不可以' }
      if (value === 'ask' || value === '要问') return { ok: true, value: '要问' }
      return { ok: false, error: '要 true(可以)/ "ask"(要问)/ false(不可以)' }
    }
    case 'mode': {
      if (value === 'existing' || value === 'fresh') return { ok: true, value }
      return { ok: false, error: 'mode 要 existing(已有项目)或 fresh(从零开始)' }
    }
    case 'template': {
      // 认不出的 id **不兜底成 product**:这一问是他亲口选的,猜错了界面整个换成另一套,
      // 而他不会知道是自己那句话被听岔了。回一句人话,让模型再问一遍。
      // 合法集合 = 此刻认得的全部模板(2026-10-23 起含用户层 布局/*.json,经 allTemplates)。
      const ids = allTemplates().map(template => template.id)
      if (typeof value === 'string' && ids.includes(value)) {
        return { ok: true, value }
      }
      return { ok: false, error: `布局要 ${ids.join(' / ')} 之一(product = 做产品研发,ops = 自媒体运营)` }
    }
    case 'persona': {
      if (typeof value === 'string' && (PERSONAS as readonly string[]).includes(value)) return { ok: true, value }
      return { ok: false, error: `人设要 ${PERSONAS.join(' / ')} 之一` }
    }
    case 'knob': {
      if (typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= 5) return { ok: true, value }
      return { ok: false, error: '旋钮要 1 到 5 的整数' }
    }
    case 'time': {
      if (typeof value === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(value)) return { ok: true, value }
      return { ok: false, error: '时刻要 HH:MM(24 小时制)' }
    }
    case 'strings': {
      if (!Array.isArray(value) || !value.every(item => typeof item === 'string' && item.trim() !== '')) {
        return { ok: false, error: '要一个非空字符串数组' }
      }
      return { ok: true, value: value.map(item => (item as string).trim()) }
    }
    case 'apps': {
      if (!Array.isArray(value)) return { ok: false, error: '要一个应用名的数组,比如 ["Claude","微信"]' }
      if (value.length === 0) return { ok: false, error: '至少要一个应用名;一个都不想选就别发这一项(可选)' }
      if (value.length > MAX_APPS) return { ok: false, error: `最多 ${MAX_APPS} 个` }
      const out: string[] = []
      for (const item of value) {
        if (typeof item !== 'string' || item.trim() === '') return { ok: false, error: '每一项都要是非空的应用名' }
        if (item.trim().length > 40) return { ok: false, error: '应用名太长(40 字以内)' }
        out.push(item.trim())
      }
      return { ok: true, value: out }
    }
    case 'account': return validateAccount(value)
    case 'project': return validateProject(value)
    case 'idea': return validateIdea(value)
    case 'plan': return validatePlan(value)
  }
}

export interface PlanItem {
  title: string
  when?: string
  why?: string
}

export interface PlanAnswer {
  project: string
  /** 念给他听、他点头了。false = 只记不落事项。 */
  confirmed: boolean
  items: PlanItem[]
  note?: string
}

/** 一份方案最多几条。电话里念得完的就这么多;再多是在灌清单,不是在排事。 */
export const MAX_PLAN_ITEMS = 12

function validatePlan(value: unknown): { ok: true, value: PlanAnswer } | { ok: false, error: string } {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return { ok: false, error: 'plan 要一个对象' }
  const raw = value as Record<string, unknown>
  const project = safeName(raw.project)
  if (project === undefined) return { ok: false, error: 'plan.project 要非空、不带路径分隔符的项目名' }
  if (typeof raw.confirmed !== 'boolean') {
    return { ok: false, error: 'plan.confirmed 要 true / false —— 他听完方案点头了才是 true,没点头就写 false(只记,不建事项)' }
  }
  if (!Array.isArray(raw.items) || raw.items.length === 0) return { ok: false, error: 'plan.items 至少要一条' }
  if (raw.items.length > MAX_PLAN_ITEMS) return { ok: false, error: `plan.items 最多 ${MAX_PLAN_ITEMS} 条(电话里念得完的就这么多)` }
  const items: PlanItem[] = []
  for (const entry of raw.items) {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) return { ok: false, error: 'plan.items 每一条要一个对象' }
    const item = entry as Record<string, unknown>
    const title = typeof item.title === 'string' ? item.title.trim() : ''
    if (title === '') return { ok: false, error: 'plan.items[].title 要非空文字' }
    if (title.length > 120) return { ok: false, error: 'plan.items[].title 太长(120 字以内)' }
    const when = typeof item.when === 'string' && item.when.trim() !== '' ? item.when.trim() : undefined
    const why = typeof item.why === 'string' && item.why.trim() !== '' ? item.why.trim() : undefined
    items.push({ title, ...(when === undefined ? {} : { when }), ...(why === undefined ? {} : { why }) })
  }
  const note = typeof raw.note === 'string' && raw.note.trim() !== '' ? raw.note.trim() : undefined
  return { ok: true, value: { project, confirmed: raw.confirmed, items, ...(note === undefined ? {} : { note }) } }
}

export interface ProjectAnswer {
  name: string
  one_liner?: string
  stage?: string
  vision?: string
  status?: string
  details?: string
  next_step?: string
  deadline?: string
  unsure?: string[]
  later?: boolean
  /**
   * 找到的那个仓库的路径(2026-09-23)。带上了,阶段机把它落成项目区的**那一条**(同一个 id),
   * 引导录的「工作台」与项目区的 desktop-workbench 不再是两行。只收绝对路径或 `~/` 开头的。
   */
  path?: string
}

const PROJECT_TEXT_FIELDS = ['one_liner', 'stage', 'vision', 'status', 'details', 'next_step', 'deadline'] as const

/** 项目名做文件名:不能空、不能带路径分隔符或 `..`,长度有限。 */
export function safeName(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined
  const name = raw.trim()
  if (name === '' || name.length > 60) return undefined
  if (/[/\\]/.test(name) || name.includes('..') || name.startsWith('.')) return undefined
  return name
}

function validateProject(value: unknown): { ok: true, value: ProjectAnswer } | { ok: false, error: string } {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return { ok: false, error: 'project 要一个对象' }
  const raw = value as Record<string, unknown>
  const name = safeName(raw.name)
  if (name === undefined) return { ok: false, error: 'project.name 要非空、不带路径分隔符的项目名' }
  const out: ProjectAnswer = { name }
  for (const field of PROJECT_TEXT_FIELDS) {
    const item = raw[field]
    if (item === undefined) continue
    if (typeof item !== 'string' || item.trim() === '') return { ok: false, error: `project.${field} 要非空文字` }
    out[field] = item.trim()
  }
  if (raw.unsure !== undefined) {
    const checked = validateValue('strings', raw.unsure)
    if (!checked.ok) return { ok: false, error: `project.unsure ${checked.error}` }
    out.unsure = checked.value as string[]
  }
  if (raw.later !== undefined) {
    if (typeof raw.later !== 'boolean') return { ok: false, error: 'project.later 要 true / false' }
    out.later = raw.later
  }
  if (raw.path !== undefined) {
    const path = typeof raw.path === 'string' ? raw.path.trim().replace(/\/+$/, '') : ''
    if (!(path.startsWith('/') || path.startsWith('~/')) || path.includes('..')) {
      return { ok: false, error: 'project.path 要找到的那个仓库的绝对路径(scan_projects 回的 path 原样填)' }
    }
    out.path = path
  }
  const filled = PROJECT_TEXT_FIELDS.some(field => out[field] !== undefined) || out.unsure !== undefined || out.later !== undefined || out.path !== undefined
  if (!filled) return { ok: false, error: 'project 除了 name 至少要带一项内容' }
  return { ok: true, value: out }
}

/**
 * 一个账号的一项或几项(2026-09-21)。字段名是英文的,与 `ProjectAnswer` 同一套风格;
 * 落到 `账号.md` 里的中文表头由 `server/accounts.ts` 的 ACCOUNT_FIELDS 决定,
 * 两边的对应关系只在 `onboarding.writeAccount` 一处写着。
 */
export interface AccountAnswer {
  name: string
  /** 定位:这个账号是做什么的。 */
  positioning?: string
  /** 风格:什么调性、什么形式。 */
  style?: string
  /** 人群:给谁看的。 */
  audience?: string
  /** 平台:主阵地。 */
  platform?: string
  /** 开号日期。**原样存他说的那句**(「去年三月」也收),不强行解析成日期 —— 解析不出来就得猜。 */
  opened_at?: string
  /** 这个账号稍后聊。 */
  later?: boolean
}

const ACCOUNT_TEXT_FIELDS = ['positioning', 'style', 'audience', 'platform', 'opened_at'] as const

function validateAccount(value: unknown): { ok: true, value: AccountAnswer } | { ok: false, error: string } {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return { ok: false, error: 'account 要一个对象' }
  const raw = value as Record<string, unknown>
  // 账号名会**拿去建文件夹**,所以这道闸比别的字段严(同 safeName:不带路径分隔符、不含 `..`、不以点开头)。
  const name = safeName(raw.name)
  if (name === undefined) return { ok: false, error: 'account.name 要非空、不带路径分隔符的账号名(会拿它建文件夹)' }
  const out: AccountAnswer = { name }
  for (const field of ACCOUNT_TEXT_FIELDS) {
    const item = raw[field]
    if (item === undefined) continue
    if (typeof item !== 'string' || item.trim() === '') return { ok: false, error: `account.${field} 要非空文字` }
    out[field] = item.trim()
  }
  if (raw.later !== undefined) {
    if (typeof raw.later !== 'boolean') return { ok: false, error: 'account.later 要 true / false' }
    out.later = raw.later
  }
  const filled = ACCOUNT_TEXT_FIELDS.some(field => out[field] !== undefined) || out.later !== undefined
  if (!filled) return { ok: false, error: 'account 除了 name 至少要带一项内容' }
  return { ok: true, value: out }
}

export interface IdeaAnswer {
  name: string
  one_liner: string
  /** 2026-09-27(卡 OB,新骨架一句话就收):这三样以后用到时再聊,缺席就是缺席,不编一句填上。 */
  problem?: string
  assets?: string
  first_step?: string
  stage: '市场调研' | '项目策划'
}

function validateIdea(value: unknown): { ok: true, value: IdeaAnswer } | { ok: false, error: string } {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return { ok: false, error: 'idea 要一个对象' }
  const raw = value as Record<string, unknown>
  const name = safeName(raw.name)
  if (name === undefined) return { ok: false, error: 'idea.name 要非空、不带路径分隔符的项目名' }
  const text = (field: string): string | undefined => {
    const item = raw[field]
    return typeof item === 'string' && item.trim() !== '' ? item.trim() : undefined
  }
  const one_liner = text('one_liner')
  const problem = text('problem')
  const assets = text('assets')
  const first_step = text('first_step')
  /**
   * 2026-09-27(卡 OB,新骨架最多 5 问):**一句话就收**。
   *
   * 以前 `one_liner / problem / assets / first_step / stage` 五项缺一项就 400 —— 那是四问的形状,
   * 而新骨架里「你想做个什么?」只问一句。问题、手上有什么、第一步以后用到时再聊;
   * 阶段他没说就按「项目策划」(他能在设置与项目卡里改),**不为了填满一个字段多问一句**。
   */
  if (one_liner === undefined) return { ok: false, error: 'idea 要 name 与 one_liner(一句话说它是什么);别的以后再补' }
  if (raw.stage !== undefined && raw.stage !== '市场调研' && raw.stage !== '项目策划') {
    return { ok: false, error: 'idea.stage 要 市场调研 或 项目策划(由用户定)' }
  }
  return {
    ok: true,
    value: {
      name,
      one_liner,
      ...(problem === undefined ? {} : { problem }),
      ...(assets === undefined ? {} : { assets }),
      ...(first_step === undefined ? {} : { first_step }),
      stage: (raw.stage as '市场调研' | '项目策划' | undefined) ?? '项目策划',
    },
  }
}

// ———————————————————————— 常用应用 → 窗位键 ————————————————————————

/** 一次最多收几个应用名。人嘴上说得出来的常用应用不会超过这个数;再多就是模型在灌清单。 */
export const MAX_APPS = 20

/**
 * 应用名 → 窗位键的**别名表**(2026-09-18,引导 ④ 习惯多问一句「你平时最常开哪几个应用」)。
 *
 * 只认这张明写的表加「已经登记过的应用」(基础七个 + apps.json 里的自定义应用)的键与展示名。
 * **不做模糊匹配、不猜**:`iTerm` 不是 `Terminal`,名字像不算认得出 —— 认错一家的后果是
 * 窗位里冒出一个他没说过的应用,比"没认出来"糟得多。认不出的原样留着给人看(`custom_apps`),
 * 由他以后自己拖一扇窗进来认领(那条路会记一笔 enabled,见 appsRegistry 的 addResolved)。
 *
 * `codex` 这一行收 `ChatGPT`:macOS 上并没有 Codex.app,那个键开的就是 ChatGPT.app(见 apps.ts 顶部)。
 */
export const APP_ALIASES: Readonly<Record<string, string>> = {
  codex: 'codex',
  chatgpt: 'codex',
  openai: 'codex',
  claude: 'claude',
  'claude code': 'claude',
  克劳德: 'claude',
  kimi: 'kimi',
  月之暗面: 'kimi',
  // 2026-09-27(卡 OB):他说的是「豆包办公」,以前一个都认不出。
  doubao: 'doubao',
  豆包: 'doubao',
  豆包办公: 'doubao',
  豆包办公模式: 'doubao',
  // 2026-09-30:Air 上那个包(com.work.pc.doubao)在坞上写的就是「豆包工作」,她也这么说。
  豆包工作: 'doubao',
  wechat: 'wechat',
  wechat2: 'wechat',
  weixin: 'wechat',
  微信: 'wechat',
  wecom: 'wecom',
  wework: 'wecom',
  企业微信: 'wecom',
  企微: 'wecom',
  term: 'term',
  terminal: 'term',
  终端: 'term',
  命令行: 'term',
  calendar: 'calendar',
  日历: 'calendar',
  日程: 'calendar',
  日程表: 'calendar',
}

/** 比名字用的规整:去空白与分隔符、去 `.app` 后缀、小写。中文不受影响。 */
function normalizeAppName(raw: string): string {
  return raw.trim().toLowerCase().replace(/\.app$/, '').replace(/[\s\-_.·・]+/g, '')
}

/**
 * 一串用户说的应用名 → 窗位键 + 认不出的那几个(原样保留)。纯函数,没有 I/O。
 *
 * `known` 是**已经登记过的全部应用**(基础七个 + 自定义,不过滤可见性)。别名表压在它上面:
 * 万一有人把自定义应用起名叫「微信」,`wechat` 这个基础键仍然赢 —— 基础表是实测过的命令表。
 * 两边都认不出来的进 `custom`,顺序按他说的来,两边各自去重。
 */
export function resolveAppKeys(
  names: readonly string[],
  known: readonly { key: string, label: string }[] = [],
): { keys: string[], custom: string[] } {
  const table = new Map<string, string>()
  for (const app of known) {
    table.set(normalizeAppName(app.key), app.key)
    table.set(normalizeAppName(app.label), app.key)
  }
  for (const [alias, key] of Object.entries(APP_ALIASES)) table.set(normalizeAppName(alias), key)
  const keys: string[] = []
  const custom: string[] = []
  const seenCustom = new Set<string>()
  for (const raw of names) {
    if (typeof raw !== 'string') continue
    const name = raw.trim()
    if (name === '') continue
    const normalized = normalizeAppName(name)
    const key = table.get(normalized)
    if (key === undefined) {
      if (!seenCustom.has(normalized)) { seenCustom.add(normalized); custom.push(name) }
      continue
    }
    if (!keys.includes(key)) keys.push(key)
  }
  return { keys, custom }
}

// ———————————————————————————————— 人设 ————————————————————————————————

export interface PersonaText {
  /** 一句自述。 */
  self: string
  /** 四场景口吻(提醒 / 做完了 / 出错或赶不上 / 被夸)。设计文档只给了傲娇的四句;
   *  沉稳与周到的四句照各自的自述写,标「照样子写」,待 Ben 过目。 */
  scenes: { remind: string, finished: string, trouble: string, praised: string }
}

export const PERSONA_TEXT: Record<Persona, PersonaText> = {
  沉稳: {
    self: '话少,先结论后理由,不闲聊,只在必要时开口',
    scenes: {
      remind: 'X 三天没动,截止日周五。要不要挪到今天?',
      finished: '材料理好了,在你桌上。',
      trouble: 'Y 赶不上周五,差两天。两条路:今天砍范围,或往后挪。你定。',
      praised: '嗯。下一件。',
    },
  },
  周到: {
    self: '主动、细致,会顺手关心你的状态,话稍多',
    scenes: {
      remind: 'X 三天没动了,周五要交;你这两天会议多,排到明早第一件?材料我先理好。',
      finished: '材料理好了,放你桌上了;顺手把相关的两份也带上了,免得再找。',
      trouble: 'Y 赶不上周五了,差两天。我先说清楚:今天砍范围能保住周五,往后挪就要跟对方说一声。你想怎么办?',
      praised: '谢谢。有什么不顺手的随时说。',
    },
  },
  傲娇: {
    self: '嘴硬心软:嘴上嫌弃、手上早帮你做好;不邀功,被夸会别扭',
    scenes: {
      remind: 'X 三天没动了。周五要交。……我又不是提醒你,只是路过。',
      finished: '材料理好了,放你桌上了。别谢我,顺手的事。',
      trouble: 'Y 赶不上周五了,差两天。我不绕弯子:今天砍范围,还是往后挪?你定。',
      praised: '……知道了。下次别说这种话。',
    },
  },
}

export const CANDOR_DESC: Record<number, string> = {
  1: '委婉,先顾情面',
  2: '偏委婉,风险点到为止',
  3: '有一说一,不刻意',
  4: '说破风险,必要时反驳',
  5: '直说到底,该反驳就反驳,不留情面',
}

export const VERBOSITY_DESC: Record<number, string> = {
  1: '只答不问',
  2: '答完最多补一句',
  3: '该提醒的提醒',
  4: '主动提醒,顺手带相关的事',
  5: '主动汇报与提醒,能想到的都说',
}

/** 俏皮类的规矩:包装可以俏皮,内容不能打折。任何人设都适用。 */
export const PLAYFUL_RULE = '包装可以俏皮,内容不能打折:时间、数字、风险照实说;坏消息(出错、赶不上)上不耍宝,先说事。'

export interface SpeakingStyle {
  persona: Persona
  candor: number
  verbosity: number
  note?: string
  /**
   * 怎么称呼用户(2026-09-20)。**称呼要在标记段里有一份** —— 改称呼时这一行跟着改,
   * 不然 AGENTS.md 会一直用听错的那个名字叫他,而那正是 Ben 说「离谱」的那件事。
   * 还没答过称呼时缺席(不写一行「叫他 undefined」)。
   */
  nickname?: string
}

/** 「说话方式」一节的正文(不含标记),用于 ~/.dsh/AGENTS.md 与用户文件。 */
export function speakingStyleSection(style: SpeakingStyle, butlerName: string): string {
  const text = PERSONA_TEXT[style.persona]
  const lines = [
    '## 说话方式',
    '',
    ...(style.nickname === undefined || style.nickname === '' ? [] : [`- 叫他「${style.nickname}」。`]),
    `- 人设:**${style.persona}**——${text.self}。`,
    `- 直言度 ${style.candor}/5:${CANDOR_DESC[style.candor] ?? ''}。`,
    `- 话量 ${style.verbosity}/5:${VERBOSITY_DESC[style.verbosity] ?? ''}。`,
    ...(style.note === undefined ? [] : [`- 用户自己的描述:${style.note}`]),
    `- 自称「${butlerName}」。`,
    `- ${PLAYFUL_RULE}`,
    '- 四种场景的口吻(照样子写,不照抄):',
    `  - 提醒:「${text.scenes.remind}」`,
    `  - 做完了:「${text.scenes.finished}」`,
    `  - 出错 / 赶不上(不耍宝,先说事):「${text.scenes.trouble}」`,
    `  - 被夸:「${text.scenes.praised}」`,
  ]
  return lines.join('\n')
}

// ———————————————————————————— 第一条消息 ————————————————————————————

export interface FirstMessageInput {
  stage: OnboardingStage
  mode: OnboardingMode | undefined
  /** 工作台地址,模型用它 POST /onboarding/answer。 */
  baseUrl: string
  /** 已答过的(阶段 → key 列表),用来告诉模型「问过的不再问」。 */
  answered: Readonly<Record<string, readonly string[]>>
  nickname?: string
  /** 中断后再来(或开过会话又进来):true 时不带种子句原文,直接问还没答的那一题(2026-09-24 起不问「上次到哪」)。 */
  resumed: boolean
  /**
   * 上一条会话是**工作台这边**坏掉另开的(2026-09-23 统筹自跑,F):他那头看到的是同一段对话,
   * 没有「上次」。这时不问「上次到哪」、不提断线,直接自然地接着问还没答的那一题。
   */
  quietResume?: boolean
  /** 只补问这一个项目(新仓库出现)。 */
  focusProject?: string
  /** 收尾阶段:代码算好的复述清单。 */
  recap?: string
  /**
   * 这台机器上扫到装了的那几家的**展示名**(2026-09-18)。只在这一段问「常用应用」时给,
   * 与手机那条路的简报 `installed_apps` 同一份来源。没扫过就不传 —— 不冒充「一家都没装」。
   */
  installedApps?: readonly string[]
  /**
   * 日历那一段(2026-09-20,Ben:「10 月 4 号,智能一点就该知道这是国庆」)。
   * 由 `holidays.calendarBrief()` 现算 —— 今天几号、接下来的假期、已知截止日还剩几个工作日。
   * 算不出来就不传:**宁可整格缺席,也不摆一段空日历**(D13)。
   */
  calendar?: string
  /**
   * 当前布局模板 id(2026-09-21)。**缺席 = 做产品那一套**,与加它之前逐字相同。
   * 只影响 ②′ 那一段的种子句与 goals(见 stageDef;② 分岔 2026-09-23 起不随模板换)。
   */
  template?: string
  /** 前面几段已经答过的授权项(2026-09-23 Z)。③ 授权段据此不再问它们。 */
  carried?: Readonly<Record<string, unknown>>
  /**
   * 这台电脑上的事实(2026-09-27,卡 OB):本机真装了、真有记录可读的那几家 AI。
   * **缺席 = 与加它之前逐字相同**。
   */
  facts?: MachineFacts
}

/**
 * 一题一答 / 一段一段来 / 喊停就停 / 不说内部话(2026-09-23 统筹第三轮自跑 V / Y / W / AA)。
 * DSH 会话的第一条消息与电话工人的系统提示(channel-worker/src/onboarding.ts 有同义的一段)都带。
 */
export const TURN_RULES: readonly string[] = [
  // V
  '**一次只问一件事**:一句话里只有一个问句。复述之后要么问「对吗」,要么问下一题,不两个都来;不追加「另外……」',
  // Y
  '**一段一段来**:这一段标 * 的问完之前,不问后面几段的题(授权没问完别问作息、音乐、常用应用);他顺口说了后面的事,记在心里,到那一段再用',
  // W
  '**他喊停就停**:他说「没了」「下一步」「先这样」「就这些」「跳过」,这一段就收 —— 不再追问(排期、假期、细节都不问了);'
  + '还没问到的可选项留空,必答项按默认记,并明说一句「X 我先按 Y 来,以后随时能改」,然后记 done / 进下一段',
  // AA
  '**不说内部话**:「按流程」「系统那边」「工作台要求」「正式问一次」「这一题要先问出口」这类话一个字都不说 —— 他不知道也不用知道有流程;'
  + '他已经说出口的答案直接收,不用为了「问过」再问一遍',
  // 2026-09-24 真机第五轮 4 / 5
  '**答得明确就不求确认**:他答得清清楚楚(「产品研发」「叫我 Ben」),直接记、往下走,不复述一遍再问「对吗」;只有他答得含糊、两头都沾,才确认一次。'
  + '称呼确认过一次就算数,之后不再宣告「那我以后就这么叫你了」',
  // 2026-09-24 真机第五轮 6 / 7:回复会被念出来
  '**不替自己辩解**:他问「你为什么问这个」,一句话答完就直接往下问,不解释你心里怎么想(「是我猜的」「我才敢往下记」),不打比方',
  '**短**:每次回复一到两句、一个问题,一般不超过 50 个字;他问「为什么」就一句话答。别用破折号、引号、括号、省略号,这些念出来语气会怪;英文名写成一个词,不拆字母',
]

/** 分岔两支的说法,与首次流程那两颗按钮、分岔种子句同一套字(2026-09-24)。 */
const MODE_WORDS: Record<OnboardingMode, string> = { existing: '已经有在做的事', fresh: '从一个新点子开始' }

/**
 * 「这台电脑上的事实」那一段(2026-09-27,卡 OB)。**代码算好,模型只念** ——
 * 现场两处错都出在这儿:装了哪几家 AI(问了这台机器上没有的 Claude 与 Kimi)、
 * 他在分岔选的是哪一支(选了新点子,说的却是「已经有在做的事」那一支的话)。
 *
 * 缺席的事实**整行不出现**(D13:宁可缺席也不摆一句猜的)。
 */
export function factLines(input: { mode?: OnboardingMode, facts?: MachineFacts }): string[] {
  const lines: string[] = []
  if (input.mode !== undefined) {
    lines.push(`- **他在分岔选的是「${MODE_WORDS[input.mode]}」**(他自己在屏幕上点的 / 亲口说的,这是定了的事实):`
      + `从这儿起每一句都按这一支说 —— ${input.mode === 'fresh'
        ? '这件事这台电脑上还什么都没有,**不提**「你手上在做的事」「跟这件事相关的事项」「已经在做的那几件」,也不提扫仓库、找项目'
        : '按他已经在做的那件事说,别当成一个还没开始的新点子'}。`)
  }
  const families = input.facts?.memoryFamilies
  if (families !== undefined) {
    lines.push(families.length === 0
      ? '- **这台电脑上没有别家 AI 记着的东西**(工作台探过了):**一个家名都别提**,也不问「要不要读它们记着的东西」。'
      : `- **这台电脑上装了、而且真有记录可读的 AI 只有:${families.join('、')}**(工作台探的)——`
        + '问「能不能读它们记着的东西」时**只念这几个**;这份名单以外的一家都不许提,名字都别说出口。')
  }
  return lines
}

export function firstMessage(input: FirstMessageInput): string {
  const def = stageDef(input.stage, input.mode, input.template, input.carried, input.facts)
  const lines: string[] = []
  lines.push(`[引导 · ${def.label}]`)
  if (input.resumed) {
    // 称呼与分岔带上值(2026-09-24):电脑首次流程里这两项是他在屏幕上答的,模型没听见 ——
    // 只写「答过 nickname」,她不知道该叫他什么、他选的是在做的事还是新点子。
    const valued = (key: string): string => {
      const value = key === 'nickname' ? input.nickname : key === 'mode' && input.mode !== undefined ? MODE_WORDS[input.mode] : undefined
      return value === undefined || value === '' ? key : `${key}:${value}`
    }
    const done = Object.entries(input.answered)
      .filter(([, keys]) => keys.length > 0)
      .map(([stage, keys]) => `${STAGE_LABEL[stage as OnboardingStage] ?? stage}(${keys.map(valued).join('、')})`)
    if (input.quietResume === true) {
      // F:坏会话另开时她开口说「上次聊到……还没等你答就把会话断了」—— 把内部故障念给了他听。
      lines.push(`这是接着做(工作台这边换了一条会话,**他不知道也不用知道**)。现在在「${def.label}」${done.length > 0 ? `,已经答过:${done.join(';')}` : ''}。`)
      lines.push('**不要问「上次到哪」,不要提会话、断线、重连、出错、模型这些内部的事**;他那头看到的是同一段对话。'
        + `他要是紧跟着说了一句,先接住那一句;然后直接、自然地接着问还没答的那一题(照样子说:「${input.stage === 'opening' ? '你希望我怎么称呼你?' : def.seed}」),问过的不再问。`)
    }
    else {
      // 2026-09-24 真机第五轮:他挂断电话转到电脑,对话屏上是「Ben,接着上次那句问一句——上次到哪,接着吗?」。
      // 0923 已定:不念内部断线、不问「上次到哪」—— 直接接着问还没答的那一题。
      lines.push(`这是接着做。现在在「${def.label}」${done.length > 0 ? `,已经答过:${done.join(';')}` : ''}。`)
      lines.push('**开口不寒暄进度**:不问聊到哪了、要不要继续,不说我们刚才聊到哪,不复述进度,不提会话、断线、电话挂了、换了设备这些事;'
        + `开口就**只问还没答的那一题**,一句话、一个问句(照样子说:「${input.stage === 'opening' ? '你希望我怎么称呼你?' : def.seed}」),问过的不再问。`
        + `${input.nickname === undefined ? '' : `可以先叫他一声「${input.nickname}」。`}`)
    }
  }
  if (input.focusProject !== undefined) {
    lines.push(`扫描发现了新项目「${input.focusProject}」,**只补问这一个**,不重来。`)
  }
  const machine = factLines({ ...(input.mode === undefined ? {} : { mode: input.mode }), ...(input.facts === undefined ? {} : { facts: input.facts }) })
  if (machine.length > 0) {
    // **代码算好的事实**:他选了哪一支、这台电脑上有哪几家 AI。模型不许自己猜这两件(卡 OB)。
    lines.push('这台电脑上的事实(工作台算的,**照它说,别自己猜**):')
    for (const line of machine) lines.push(line)
    lines.push('')
  }
  lines.push('按 .dsh/skills/引导/SKILL.md 做:骨架由代码定,对话由你来——不是问卷,顺着聊,聊清一项记一项。')
  // 2026-09-16 手机端引导:回复会被手机原样显示并朗读,接口地址以这条消息为准(工作台端口不一定是 8791)。
  lines.push('用户在手机上和你说话:你的每句回复会原样显示在手机上并朗读——短句、口语、一次只问一件事,不用 Markdown 标题 / 列表 / 表格;记数据的 curl 命令自己跑,不要写在回复里。接口地址以本消息里写的为准。')
  lines.push('')
  if (input.resumed && input.quietResume === true) {
    lines.push('开场白与各阶段种子句都说过了,别从头再念;照上面那句接着问。')
  }
  else if (input.resumed) {
    // 2026-09-16 真机:从主页「接着引导」再进来时又发了一遍开场白,模型照念,手机上念了三遍。
    // 续做不再带种子句原文、不重念开场白;2026-09-24 起也不先问「上次到哪」,直接问那一题。
    lines.push('开场白与各阶段种子句都说过了,别从头再念;照上面那句直接问还没答的那一题,然后接着弄清下面的东西。')
  }
  else {
    lines.push(input.stage === 'opening' ? '开场白(Ben 亲笔,一字不改,原样说):' : '种子句(照样子说):')
    lines.push(`「${def.seed}」`)
  }
  if (def.goals.length > 0) {
    lines.push('')
    lines.push('要弄清的东西:')
    for (const goal of def.goals) lines.push(`- ${goal}`)
  }
  if (input.calendar !== undefined && input.calendar !== '') {
    lines.push('')
    lines.push('日历(工作台算的,涉及日期照它说,别自己心算):')
    lines.push(input.calendar)
  }
  if (input.recap !== undefined) {
    lines.push('')
    // 2026-09-24 晚:收尾不再念复述(维护者「结束环节的大总结听得我好累」),完整的单子在屏幕上。
    lines.push('今天记下的(代码从已答项算的,给你心里有数用,**不念、不复述**;完整的单子在他屏幕上):')
    lines.push(input.recap)
  }
  const keys = Object.entries(def.keys)
  if (keys.length > 0) {
    lines.push('')
    lines.push(`本阶段只能写这些(每记一项:POST ${input.baseUrl}/onboarding/answer,body {"stage":"${input.stage}","key":"<key>","value":<值>};必答项标 *):`)
    for (const [name, key] of keys) lines.push(`- ${name}${key.required === true ? ' *' : ''}:${key.desc}`)
    lines.push('必答项都答完阶段自动推进,接口会回下一阶段的种子句与清单;接着说下一阶段就行。')
    // 2026-09-20(Ben:「包括它说不能改,我当时一度想要停下」):**已经答过的任何一项都随时可以改**。
    // 改的那一条走另一个路径,因为它故意不推进阶段 —— 改个称呼不该把人重新拖回开场。
    lines.push(`他说「我刚才说错了」「不是这个」:**照改,别说改不了**——`
      + `POST ${input.baseUrl}/onboarding/correct,body {"stage":"<那一项属于哪个阶段>","key":"<key>","value":<新值>}。`
      + '之前的阶段也能改(改称呼连已经写下的记忆文件一起改),阶段不会倒回去。')
    if (keys.some(([, key]) => key.kind === 'apps') && (input.installedApps?.length ?? 0) > 0) {
      lines.push(`这台机器上扫到装了:${(input.installedApps as readonly string[]).join('、')}——问常用应用时照着念这几个(「都要吗?」),**只念这几个**,没扫到的别编。`)
    }
  }
  if (def.writes.length > 0) {
    lines.push('')
    lines.push('本阶段会写到:')
    for (const item of def.writes) lines.push(`- ${item}`)
  }
  lines.push('')
  // K(2026-09-23 统筹自跑):她问「开口说还是发文字」,他答「没有了」,她直接进了下一段,那一项空着。
  lines.push('**一题一答**:分岔、布局与授权这几项,要是他对**那一题**的回答 —— 上一题的「对」「好」不算这一题的答案;'
    + '问出口的一项他答非所问(「好」「可以」这种跟题对不上的)不算答:**追问一次**,换个说法;'
    + '还不答就按默认记,并明说「那我先按 X 来,以后随时能改」。称呼、名字、习惯这些他主动说了就直接记。被工作台拦了照它说的做,但别把拦的事说给他听。')
  for (const rule of TURN_RULES) lines.push(rule)
  lines.push('纪律:不编数,拿不准就记「拿不准」;凭据、账号、密钥不进任何出口;当场答的一句话 / 阶段 / 目标直接写项目文件(当场答即拍板);任何时候用户说「稍后」都可以停,进度已经落盘。')
  return lines.join('\n')
}
