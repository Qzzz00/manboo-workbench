/**
 * 事务官的日常例程(2026-09-15,docs/设计-事务官完整材料.md §4.2、docs/设计-事务官的主动性.md §二 2、
 * docs/记忆/下班例程.md、docs/设计-事务官记忆系统.md §四)。
 *
 * 三条例程,全部是「插件按时开一条 DSH 会话 + 一份技能(.dsh/skills/例程/SKILL.md)告诉它做什么 +
 * 结果落回记忆与事项收件箱」。Ben 看到的是事务官先开口,不是一个 cron:
 *
 * | 例程 | 何时 | 代码做什么(不经模型) | 会话里的模型做什么 |
 * |---|---|---|---|
 * | 开工汇报 morning | 当天第一次工作台露面,或设定的时刻 | 先收一次各家 AI 的记忆(只收不并),再从记忆文件与 /state 拼三句加一问,作为一条「事务官交给我」的事项进收件箱 | 只回一行「等你定」,Ben 回答「今天先做哪件」后才接手 |
 * | 下班例程 evening | 到点(默认 18:30)或 POST /routine/run | 收各家 AI 的记忆、覆盖布局快照、给今天有活动的项目追加一条进展、更新两份索引(每行都补文件)、一次 commit、配了远端就推 | 把收来的并进用户/项目文件、偏好进用户文件、找矛盾、待拍板,回三行 |
 * | 知识 lint lint | 周五下班例程之后 | 只开会话,不写任何文件 | 写一份 docs/交接-<日期>-知识lint.md,只提议不改 |
 *
 * 纪律:
 * - **同一例程不并发**:在跑时再触发直接拒绝(HTTP 409),不排队——排队等于同一天跑两遍。
 * - **DSH 不在线:下班例程与知识 lint 跳过并记一条 note**(status=skipped);过一会儿再试,DSH 起来了自然补上。
 *   **开工汇报不跳**(2026-10-13):程序拼的那一半照出、照进收件箱,模型那一半如实说缺席
 *   (status=no_session + `session_offline`)—— 与「会话开不出来」同一条取舍。出过那一份之后当天不再重跑。
 * - **会话开不出来如实标「会话未开」**(status=no_session),代码那一半照做——开工汇报仍进收件箱,
 *   下班例程的文件仍写、仍 commit。伪装成"事务官在办"是最坏的失真(D13)。
 * - **写只在记忆目录内、只追加不删**;commit 只带 docs/记忆 与 docs/记忆索引.md 两个路径,别的改动一概不碰。
 * - 定时挂在 http.ts 那根既有的 1 秒 tick 上(同哨兵、布局快照),不新起定时器。
 * - **收尾不指望模型活到最后**(2026-09-27):每 10 分钟 + 每条例程开跑前,收尾检查刷一遍各家的进度、
 *   把记忆目录里没提交的改动提交掉(`server/memoryCloseout.ts`)。会话中途断了,明天仍看得出并到哪了。
 */
import { execFile } from 'node:child_process'
import { mkdir, readdir, readFile, rename, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { dirname, join } from 'node:path'
import { promisify } from 'node:util'
import type {
  RoutineName,
  RoutineNext,
  RoutineRun,
  RoutineTrigger,
  RoutinesConfigView,
  RoutinesView,
  WorkbenchState,
} from '../protocol.ts'
import { BUTLER_NO_SESSION_NOTE, BUTLER_SESSION_OFFLINE_NOTE, ROUTINE_NAMES } from '../protocol.ts'
import { composeDayReview, dayReviewWindow } from './agentDayReview.ts'
import { localDateStr } from './brief.ts'
import type { ButlerJob } from './butlerEffort.ts'
import { effortFor } from './butlerEffort.ts'
import type { ButlerSessionOpener } from './butlerItem.ts'
import type { JobEvent } from './jobLog.ts'
/** 接力记录的形状(读法只有 `videoChain.view()` 一处;见 {@link RoutinesDeps.videoChains})。 */
import type { ChainRecord } from './videoChain.ts'
import type { GitGateResult } from './gitGate.ts'
import { createGitGate } from './gitGate.ts'
import { renderLayoutSnapshot, snapshotInputOf } from './layoutSnapshot.ts'
import type { EveningCollectResult } from './memoryCollect.ts'
import { stalledMorningLines } from './itemStanding.ts'
import type { MemoryIndexEntry } from './routineMemory.ts'
import {
  appendProgress,
  composeMorningReport,
  describeMarkdown,
  meetingTodayLines,
  mergeLayoutMemory,
  newProjectFile,
  parseMemoryFacts,
  progressLine,
  projectIndexRows,
  renderMemoryIndex,
  stateFactsOf,
  todayTodoLines,
  updateProjectIndex,
} from './routineMemory.ts'

const execFileAsync = promisify(execFile)

/** —— 配置 —— */

export type RoutinesConfig = RoutinesConfigView

export const DEFAULT_ROUTINES_CONFIG: RoutinesConfig = {
  morning: { enabled: true, not_before: '06:00' },
  evening: { enabled: true, at: '18:30' },
  lint: { enabled: true, weekday: 5 },
}

export function defaultRoutinesFile(home = process.env.HOME ?? ''): string {
  return `${home}/.dsh/workbench/routines.json`
}

export function defaultRoutinesStateFile(home = process.env.HOME ?? ''): string {
  return `${home}/.dsh/workbench/routines-state.json`
}

/** `HH:MM` → 当天的分钟数。认不出回 undefined。 */
function parseHhmm(text: unknown): number | undefined {
  if (typeof text !== 'string') return undefined
  const match = /^(\d{1,2}):(\d{1,2})$/.exec(text.trim())
  if (match === null) return undefined
  const hour = Number(match[1])
  const minute = Number(match[2])
  if (hour > 23 || minute > 59) return undefined
  return hour * 60 + minute
}

function hhmm(minutes: number): string {
  return `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`
}

/**
 * 解析 routines.json。**宽容**:认不出的字段退回默认值、不抛——配错一个字符串不该让工作台起不来,
 * 也不该让例程整个停掉。未知字段丢弃(不往回写)。
 */
export function parseRoutinesConfig(raw: unknown, fallback: RoutinesConfig = DEFAULT_ROUTINES_CONFIG): RoutinesConfig {
  const obj = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>
  const morning = (typeof obj.morning === 'object' && obj.morning !== null ? obj.morning : {}) as Record<string, unknown>
  const evening = (typeof obj.evening === 'object' && obj.evening !== null ? obj.evening : {}) as Record<string, unknown>
  const lint = (typeof obj.lint === 'object' && obj.lint !== null ? obj.lint : {}) as Record<string, unknown>
  const morningAt = parseHhmm(morning.at)
  const notBefore = parseHhmm(morning.not_before)
  const eveningAt = parseHhmm(evening.at)
  const weekday = typeof lint.weekday === 'number' && Number.isInteger(lint.weekday) && lint.weekday >= 0 && lint.weekday <= 6
    ? lint.weekday
    : fallback.lint.weekday
  const repo = typeof obj.repo === 'string' && obj.repo.trim() !== '' ? obj.repo.trim() : fallback.repo
  return {
    morning: {
      enabled: typeof morning.enabled === 'boolean' ? morning.enabled : fallback.morning.enabled,
      // `at: null` 是「清掉,回到露面触发」;缺席则沿用 fallback。
      ...(morningAt !== undefined ? { at: hhmm(morningAt) } : morning.at === null || fallback.morning.at === undefined ? {} : { at: fallback.morning.at }),
      not_before: notBefore === undefined ? fallback.morning.not_before : hhmm(notBefore),
    },
    evening: {
      enabled: typeof evening.enabled === 'boolean' ? evening.enabled : fallback.evening.enabled,
      at: eveningAt === undefined ? fallback.evening.at : hhmm(eveningAt),
    },
    lint: {
      enabled: typeof lint.enabled === 'boolean' ? lint.enabled : fallback.lint.enabled,
      weekday,
    },
    ...(repo === undefined ? {} : { repo }),
  }
}

/** —— 服务 —— */

/** `env` 是额外环境变量(commit 用它定作者/提交日期),别的调用不传。 */
export type GitExec = (args: readonly string[], cwd: string, env?: Readonly<Record<string, string>>) => Promise<{ ok: boolean, stdout: string, stderr?: string }>

/**
 * 默认的 git 执行器:不弹任何凭据提示(GIT_TERMINAL_PROMPT=0),60 秒超时,失败一律 `{ ok:false }`。
 *
 * 2026-09-26 起也 push(第 7 步 commit 之后,配了 upstream 才推;见 runEveningWrites)——**失败的那句原文要带回来**,
 * 所以 `stderr` 也收:推不上去的原因(没网、远端拒了、要凭据)得进汇报,不能只剩一个 false。
 */
export async function defaultRoutineGit(args: readonly string[], cwd: string, env: Readonly<Record<string, string>> = {}): Promise<{ ok: boolean, stdout: string, stderr?: string }> {
  try {
    const { stdout, stderr } = await execFileAsync('git', args as string[], {
      cwd,
      timeout: 60_000,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0', ...env },
    })
    return { ok: true, stdout, stderr }
  }
  catch (error) {
    const stderr = (error as { stderr?: unknown })?.stderr
    return { ok: false, stdout: '', ...(typeof stderr === 'string' && stderr !== '' ? { stderr } : {}) }
  }
}

export interface RoutinesServiceOptions {
  /** `~/.dsh/workbench/routines.json`:开关与时间。Ben(或设置面板)改。 */
  configFile: string
  /** `~/.dsh/workbench/routines-state.json`:每条例程最近一次的结果。进程重启后靠它不重跑。 */
  stateFile: string
  /** 当前时刻(ms)。默认 Date.now——测试注入固定时钟。 */
  now?: () => number
  /** DSH 会话通道。缺席 = DSH 没接,三条例程都跳过并记 note。 */
  session?: ButlerSessionOpener
  git?: GitExec
  /** 跳过(DSH 不在线)之后多久允许再试,默认 5 分钟;测试传 0。 */
  skipRetryMs?: number
  /** routines.json 没写 repo 时的兜底(生产传 WORKBENCH_BUTLER_CWD)。 */
  defaultRepo?: string
  /**
   * 从行为账里学到的开工汇报时刻(2026-10-09,`habits.ts` 的 `briefAt`:她通常第一次露面前 10 分钟)。
   * **只在她没设时刻时用**;露面就开工那一路照旧(她比它早到也不用等)。缺席 = 没学。
   */
  learnedMorningAt?: () => string | undefined
  /**
   * 开工汇报**之前**先跑一下的活儿(2026-09-21 数据复盘:每天早报前自取一次小红书后台,
   * 取完让模型写三条建议)。回一句人话进 run.note —— **自动动作要看得见**(PRD §9)。
   *
   * 它抛了不影响开工汇报:数据复盘接不上是数据复盘的事,不该把早报一起拖没。
   * 缺席 = 这台服务没接数据复盘,开工汇报与加这个钩子之前逐字相同。
   */
  beforeMorning?: () => Promise<string | undefined>
  /**
   * 早报**之前**跑一轮资讯搜索,并把「每个项目最多 3 条」交回来(2026-09-21,资讯与播客那张卡)。
   *
   * 与 `beforeMorning` 分开是因为它有**返回值要进汇报正文**:数据复盘只回一句话记进 note,
   * 资讯那几条是要念给 Ben 听的。同样地:**它抛了不影响开工汇报** —— 搜索服务没配、
   * 模型接不上,是资讯的事,不该把早报一起拖没,如实记进 note 就够。
   *
   * 缺席 = 这台服务没接资讯,开工汇报与加这个钩子之前逐字相同。
   */
  feedBeforeMorning?: () => Promise<{
    note?: string
    groups: readonly { project_name: string, items: readonly { title: string, why: string, source?: string }[] }[]
  }>
  /**
   * 早报**之前**对一次运营目标的进度(2026-09-22 卡④)。一行一个账号,
   * 内容来自 `账号/<名>/目标.md` + 看板上的已发布数 + 数据复盘那一格的涨粉。
   *
   * 与资讯那个钩子同一条纪律:**它抛了不影响开工汇报** —— `目标.md` 读不懂、
   * 工作目录没配,都是目标这件事的事,不该把早报一起拖没,如实记进 note 就够。
   *
   * 缺席 = 这台服务不在运营模板下(或没配工作目录),开工汇报与加它之前逐字相同。
   */
  goalsBeforeMorning?: () => Promise<readonly string[]>
  /**
   * 早报**之前**按证据核一轮进度(2026-09-25,卡 N):仓库、派出去的活、各家会话 → 每张卡「现在到哪」。
   * 回要念的那几行(**只有变了的**,加上他自己的事与到期提醒)和一句 note。
   * 与资讯、目标同一条纪律:**它抛了不影响开工汇报**。缺席 = 没接进度核对,开工汇报逐字不变。
   */
  progressBeforeMorning?: () => Promise<{ lines: readonly string[], note?: string }>
  /**
   * 日报那四段(2026-10-13,照《日报规范》`docs/规范-日报-2026-10-12.md`;「日报就是早报」)。
   *
   * 事实表与五档判法在 `server/agentDayReview.ts`,素材**全在 /state 上**(事项卡的派活记录、
   * `standing` 现算的「停在哪」、`progress` 现算的「现在到哪」、今天的待办、随手记),
   * 所以这里只要两样外部的东西:任务账与问一次模型。**两样都缺席也出得来**(程序按事实表排四段)。
   *
   * 与资讯、目标、进度核对同一条纪律:**它抛了不影响开工汇报** —— 四段出不来如实记进 note。
   */
  dayReview?: {
    /** 任务账(`jobLog.all()`)。缺席 = 事实只用卡上的证据。 */
    jobEvents?: () => readonly JobEvent[]
    /** 问一次模型(归并与措辞;`askModel`)。缺席 / 抛了 = 程序按事实表排四段。 */
    chat?: (prompt: string) => Promise<string>
  }
  /**
   * 下班例程**写完记忆之后**再做的一件:把复盘经验与把关记录回写进
   * `账号/<名>/账号.md` 的「风格与偏好(工作台学到的)」段(2026-09-22 卡④)。
   *
   * **先写后说**:代码写完盘,回一句人话进 `run.note` 与会话第一条消息 ——
   * 自动动作要看得见(PRD §9)。它抛了不影响下班例程的其余几步(同上一条)。
   */
  profileAfterEvening?: () => Promise<string | undefined>
  /**
   * 下班例程**之后**扫一遍"她这两周反复在说什么"（2026-09-22，卡 ⑥ 进化循环）。
   * 回一句人话进 `run.note` —— **自动动作要看得见**（PRD §9，同 `beforeMorning`）。
   *
   * 挂在下班例程之后而不是早报之前，是因为它产出的是**提议**不是情报：早上她要的是
   * 今天先做哪件，不是"要不要改一下我自己"。一天的活干完了再问，才问得动。
   *
   * 它抛了不影响下班例程：进化提议扫不出来是提议的事，不该把记忆写入与 commit 一起拖没。
   * 缺席 = 这台服务没接进化循环，下班例程与加这个钩子之前逐字相同。
   */
  afterEvening?: () => Promise<string | undefined>
  /**
   * **这台机器装好了没有**(2026-09-23 从零重装验收第 3 件)。回一句「为什么还不跑」就是**还没好**,
   * 回 undefined 就是好了。没好时**到点与露面都不自动跑**(开工汇报、下班例程、知识 lint 三条都不跑);
   * 他在设置里亲手点「现在跑一次」(`run` 的 `manual`)照跑 —— 那是他此刻亲口要的。
   *
   * 由来:新装机器第一次启动,用户还没注册,本机网页的第一次 GET /state 就算「当天第一次露面」,
   * 于是跑了一次开工汇报(会话开不出来 → no_session),座机台账里多了一通「完成 · 开工汇报 · 排着」。
   * 缺席 = 不设门(老调用方与老用例一个字不用改)。
   */
  setupGate?: () => string | undefined
  /**
   * 下班例程**第 0 步「收」**(2026-09-26,设计 §二 0):把各家 AI 的记忆拷进 `docs/记忆/来自-<家>/`,
   * 并算出「与 `已并入.md` 相比新增或变了的」那份清单交给事务官(第 5 步由模型并)。
   *
   * 授权门、拷法、清单怎么算全在 `server/memoryCollect.ts`;这里只负责**在写别的文件之前**调它一次
   * (拷来的文件在 `docs/记忆` 底下,跟第 7 步一起提交)。它抛了只丢这一句 ——
   * 「今天没收成」不该把布局快照、进展、索引、commit 一起拖没(同 profileAfterEvening 的取舍)。
   *
   * 缺席 = 这台服务没接各家记忆,下班例程与加这个钩子之前逐字相同。
   */
  collectMemories?: (input: { repo: string, date: string }) => Promise<EveningCollectResult>
  /**
   * **收尾检查**(2026-09-27,并入闭环那张卡):每 `closeoutEveryMs` 一次,且**每条例程开跑前先做一次**。
   *
   * 由来:09-26 晚上事务官会话并到第 23 份时中途没了 —— 台账一行没写、并好的 6 个文件一直没提交。
   * 收尾这件事从此**不指望模型活到最后**:刷新每一家「来源.md」顶上的进度、把没提交的改动提交掉。
   * 实现全在 `server/memoryCloseout.ts`;这里只负责按节拍叫它,并把回的那句话丢掉(它自己不抛)。
   *
   * 缺席 = 这台服务没接收尾检查,例程与加它之前逐字相同。
   */
  closeoutMemories?: () => Promise<string | undefined>
  /** 收尾检查的间隔,默认 10 分钟;测试传 0。 */
  closeoutEveryMs?: number
}

export interface RoutinesDeps {
  /** 组装一份 /state(http.ts 的 composeState)。 */
  readState: () => Promise<WorkbenchState>
  /** 一次例程跑完后叫一声,让 /live 上的订阅者立刻看到收件箱多了一条。 */
  onChanged?: () => void
  /**
   * ★ **正在走的两步接力**(2026-10-13,卡 F;出参考图 → 可灵出片)。日报四段据此不把
   * 「豆包那一步回话了」当成交付(四场景验收第 16 条)。
   *
   * 读法只有 `videoChain.view()` 一处(接力那一层自己的记录),这里不碰
   * `~/.dsh/workbench/video-chains.json`。接力那一层建在 http.ts 里,所以从 `attach` 这一格进来;
   * 缺席 = 这台服务没接接力,分档与加这一道之前逐字相同。
   */
  videoChains?: () => readonly ChainRecord[]
}

export interface RoutinesService {
  load(): Promise<void>
  /** 起服务后由 http.ts 接上 composeState;没接上时 run() 如实失败。 */
  attach(deps: RoutinesDeps): void
  config(): RoutinesConfig
  /** 部分更新并落盘(设置面板用)。校验同 parseRoutinesConfig:认不出的字段不改。 */
  setConfig(patch: unknown): Promise<RoutinesConfig>
  view(): RoutinesView
  /** 跑一条。同一例程在跑时拒绝。 */
  run(name: RoutineName, trigger?: RoutineTrigger): Promise<{ ok: true, run: RoutineRun } | { ok: false, reason: string }>
  /** 走一拍定时。挂在既有的 1 秒 tick 上,自己不起定时器。 */
  pump(): void
  /** 工作台露面了(本机来源的 GET /state)。开工汇报没设时刻时靠这个触发。 */
  sighted(): void
}

const MEMORY_DIR = 'docs/记忆'
const PROJECTS_DIR = 'docs/记忆/项目'
const MEMORY_INDEX = 'docs/记忆索引.md'
/** commit 只带这两个路径:例程写的全在这里,别处的改动(别的会话正在做的活)一概不碰。 */
export const MEMORY_COMMIT_PATHS = [MEMORY_DIR, MEMORY_INDEX] as const
const COMMIT_PATHS = MEMORY_COMMIT_PATHS

export const ROUTINE_SKILL = '.dsh/skills/例程/SKILL.md'

/** 项目名 → 记忆文件名。名字里的斜杠会变成子目录,换掉;别的字符原样(文件名就是项目名,索引里要能对上)。 */
function projectFileName(name: string): string {
  return `${name.replace(/[/\\]/g, '-')}.md`
}

/** `MMDD`,交接文档的日期段用的格式。 */
function mmdd(date: string): string {
  return date.slice(5).replace('-', '')
}

export function lintDocPath(date: string): string {
  return `docs/交接-${mmdd(date)}-知识lint.md`
}

/** —— 三条会话的第一条消息(由代码从固定模板拼,不经模型) —— */

export function morningFirstMessage(report: string, date: string): string {
  return [
    report,
    '',
    `(工作台开工汇报 ${date})上面几句是工作台从记忆文件与 /state 拼出来的,已经发给 Ben 看了。`,
    `按 ${ROUTINE_SKILL} 的「开工汇报」一节:你只回一行「等你定」,不要复述、不要动手;等 Ben 在这条会话里回答「今天先做哪件」再接手。`,
  ].join('\n')
}

/** 第一条消息里最多列几份待并的文件。再多就只说数目 —— 一条消息不该是一张一百行的清单。 */
const FIRST_MESSAGE_FRESH_LIMIT = 20

export interface EveningFirstMessageExtra {
  /** 第 0 步收来、还没并过的那几份(相对仓库根 + 指纹)。空 / 缺席 = 这次没有要并的。 */
  fresh?: readonly { rel: string, fingerprint: string }[]
  /** 这个仓库里用户文件到底叫什么(`docs/记忆/用户-*.md`)。缺席 = 按老名字说。 */
  userFile?: string
}

/** 第 0 步收来的清单那一段(设计 §二 5:列出来,让事务官逐份读、并完记台账)。 */
function freshBlock(fresh: readonly { rel: string, fingerprint: string }[], date: string): string[] {
  if (fresh.length === 0) {
    return ['第 0 步「收」:各家 AI 那边**没有新增或变了的记忆**(或者这次没收),所以第 5 步的「并」这次跳过。']
  }
  const shown = fresh.slice(0, FIRST_MESSAGE_FRESH_LIMIT)
  return [
    `第 5 步「并」(设计-讨论结论都落进工作台记忆-2026-09-26 §二 5):下面这 ${fresh.length} 份是各家 AI 新记的或改过的。`
    + '**一份一份来,不要攒到最后**——上一次(09-26)攒到最后,并到第 23 份时会话断了,台账一行没写、'
    + '并好的文件一直没提交,第二天同样的内容还得再读一遍。所以每一份都这么走:',
    '1. 先在目标文件里搜一下这份的**原件路径**:已经作为依据出现过 = 以前并过了,'
    + '这次**只补台账那一行**,不要再并一遍、不要再写一条观察;',
    '2. 没出现过就读它:属于他偏好习惯的并进用户文件「观察」段、属于某个项目的并进 '
    + 'docs/记忆/项目/<名>.md 的「进展/风险/关键文件」,每条带依据(原件路径);纯技术备忘**不并**,但也算已看过;',
    '3. 这一份处理完(含判定「不并」的)**立刻**往那一家的 `来自-<家>/已并入.md` 追加这一行,不要等全部并完再写;',
    `4. **每处理完 5 份就 commit 一次**(\`chore(记忆): 下班例程 ${date} 并入\`)。中途断了没关系:`
    + '台账里记过的下次就不再列给你,接着做剩下的就行。',
    '只处理下面列出的这几份,别顺手去并没列出来的:',
    ...shown.map(one => `- ${one.rel}(指纹 ${one.fingerprint})`),
    ...(fresh.length > shown.length ? [`- ……还有 ${fresh.length - shown.length} 份,在同几个 docs/记忆/来自-*/ 目录里`] : []),
    '台账每行四列:`| 文件 | 指纹 | 日期 | 并到哪 |`'
    + '(表头就这四列;文件写相对 `来自-<家>/` 的路径,指纹照抄上面那一串)。**记了的下次就不再列给你**。',
  ]
}

export function eveningFirstMessage(date: string, done: string, extra: EveningFirstMessageExtra = {}): string {
  const userFile = extra.userFile ?? 'docs/记忆/用户-Ben.md'
  return [
    `下班例程 ${date}。工作台已经做完机械的几步:${done}。`,
    ...freshBlock(extra.fresh ?? [], date),
    `请按 ${ROUTINE_SKILL} 的「下班例程」一节接着做剩下的:今天对话里听到的偏好追加到 ${userFile}「观察」段;`,
    '检查记忆文件之间有无矛盾;该待拍板的追加到 docs/决策记录.md。写权限按 .dsh/skills/记忆/SKILL.md,只追加不删、不碰凭据。',
    `偏好与矛盾那几步写完再 commit 一次(chore(记忆): 下班例程 ${date} 观察);**工作台那一笔已经由代码提交并推过了**`
    + '(推没推成上面那句写着),你只推**你自己这几笔**:配了远端就 git push,没配就只提交、不推;推不上去在回话里说。'
    + '真断在半路也不用担心:工作台每 10 分钟会把记忆目录里没提交的改动收尾提交一次。',
    '最后回三行:今天记住了什么、有什么矛盾、有什么待拍板;第一行末尾带一句「今天从各家 AI 收了 N 份、并进 M 条」。',
  ].join('\n')
}

export function lintFirstMessage(date: string): string {
  const doc = lintDocPath(date)
  return [
    `每周知识 lint ${date}。按 ${ROUTINE_SKILL} 的「知识 lint」一节做:`,
    `通读 docs/记忆索引.md 与近 7 天的 docs/交接-*.md,只写一份 ${doc}——哪些交接可归档、哪些结论该进决策记录、哪里前后矛盾。`,
    '**只提议,不改任何别的文件**;写完 commit 一次(chore(记忆): 知识 lint ' + date + ');'
    + '这一条代码没有替你提交,所以这一笔由你推:配了远端就 git push,没配就只提交、不推。回三行摘要。',
  ].join('\n')
}

/** —— 下班例程的机械写入(真 I/O) —— */

export interface EveningWriteResult {
  /** 追加了进展的项目名。 */
  projects: string[]
  /** 新建档的项目名。 */
  created: string[]
  layout: boolean
  index: boolean
  commit?: string
  /** 第 0 步「收」的结果(缺席 = 这台服务没接各家记忆)。 */
  collect?: EveningCollectResult
  /**
   * 第 7 步 commit 之后推没推(2026-09-26,设计 §二 7):
   * `pushed` 推成了;`no-upstream` 这个工作目录没配远端(只存在这台电脑);`failed` 推了没成(原因在 summary 里);
   * `nothing` 这次没有 commit,没什么可推。
   */
  push: 'pushed' | 'no-upstream' | 'failed' | 'nothing'
  /** 一句人话,写进 run.note 与会话第一条消息。 */
  summary: string
}

async function readIfExists(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, 'utf8')
  }
  catch {
    return undefined
  }
}

export async function writeAtomic(path: string, text: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  const tmp = `${path}.${randomUUID()}.tmp`
  await writeFile(tmp, text, 'utf8')
  await rename(tmp, path)
}

async function listMarkdown(dir: string, prefix = ''): Promise<string[]> {
  let entries
  try {
    entries = await readdir(dir, { withFileTypes: true })
  }
  catch {
    return []
  }
  const out: string[] = []
  for (const entry of entries) {
    const rel = prefix === '' ? entry.name : `${prefix}/${entry.name}`
    if (entry.isDirectory()) out.push(...await listMarkdown(join(dir, entry.name), rel))
    else if (entry.isFile() && entry.name.endsWith('.md')) out.push(rel)
  }
  return out.sort()
}

/**
 * 这个仓库里的用户文件叫什么(相对仓库根,如 `docs/记忆/用户-Ben.md`)。没有就 undefined。
 *
 * 2026-09-26(设计 §一 6):原来写死 `用户-Ben.md` —— 换一个用户(称呼不是 Ben)就读不到,
 * 而文件名是引导里按**他自己的称呼**建的。所以按 `用户-*.md` 找:
 * 只有一份就用它;有好几份(改过称呼、留了旧的)时优先老名字 `用户-Ben.md`,否则取排序第一份 ——
 * **要的是确定性**:同一个仓库每次算出同一份,不随 readdir 的顺序漂。
 */
export async function findUserMemoryFile(repo: string): Promise<string | undefined> {
  const names = (await listMarkdown(join(repo, MEMORY_DIR)))
    .filter(rel => !rel.includes('/') && /^用户-.+\.md$/.test(rel))
    .sort()
  if (names.length === 0) return undefined
  const picked = names.includes('用户-Ben.md') ? '用户-Ben.md' : names[0] as string
  return `${MEMORY_DIR}/${picked}`
}

/** 记忆文件三族读成文本,喂给 parseMemoryFacts。仓库不存在 / 读不到就是空的(汇报少一句,不编)。 */
export async function readMemoryTexts(repo: string): Promise<{ projects: { name: string, text: string }[], user?: string, decisions?: string }> {
  const projects: { name: string, text: string }[] = []
  for (const rel of await listMarkdown(join(repo, PROJECTS_DIR))) {
    if (rel === '索引.md' || rel.includes('/')) continue
    const text = await readIfExists(join(repo, PROJECTS_DIR, rel))
    if (text !== undefined) projects.push({ name: rel.slice(0, -3), text })
  }
  const userFile = await findUserMemoryFile(repo)
  const user = userFile === undefined ? undefined : await readIfExists(join(repo, userFile))
  const decisions = await readIfExists(join(repo, 'docs/决策记录.md'))
  return { projects, ...(user === undefined ? {} : { user }), ...(decisions === undefined ? {} : { decisions }) }
}

export interface EveningWriteInput {
  repo: string
  /** 例程的「今天」(本地日期);commit 的作者/提交日期也定在这一天,记忆索引里的 git log 日期才与它一致。 */
  date: string
  /** 例程开跑那一刻(ms),只用来给 commit 定时分秒。 */
  startedMs: number
  state: WorkbenchState
  git: GitExec
  /**
   * **调 git 之前那道门**(2026-09-30,止血第 5 条):没有 `.git` / 没装开发者工具就一次都不调 ——
   * 新 Mac 上一调就弹「安装命令行开发者工具」(见 `gitGate.ts`)。不传就按 `repo` 现做一道。
   */
  gitReady?: () => Promise<GitGateResult>
  /** 第 0 步「收」。缺席 = 不收(老调用方与老用例一个字不用改)。 */
  collect?: () => Promise<EveningCollectResult>
}

/**
 * commit 的日期字符串:`date` 那天 + `startedMs` 的本地时分秒,不带时区(git 取本地时区)。
 * 生产上 date 就是 startedMs 的本地日期,与不设无异;测试注入固定时钟时,%cs 才不会漂到墙上钟那天——
 * 否则第一次 run 提交后索引里这些文件的日期就从 date 变成真实提交日,第二次 run 又多一个 commit。
 */
export function commitDateOf(date: string, startedMs: number): string {
  const d = new Date(startedMs)
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${date}T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}

/** 推没推的四种结果(与 EveningWriteResult.push 同一口径)。 */
export type PushOutcome = 'pushed' | 'no-upstream' | 'failed' | 'nothing'

/**
 * **提交完由代码推**(2026-09-26,设计 §一 5 / §二 7)。原来代码里根本没有 push,
 * 只在给模型的话里写了「git push」—— 配了远端也不一定推,于是她的记忆只存在这一台电脑上。
 *
 * 判据只有一条:**当前分支有没有 upstream**(`rev-parse --abbrev-ref @{u}` 成不成)。
 * 成了就 `git push`(不带分支名、不带远端名 —— 工作目录可能设了 push.default=upstream、
 * 本地 main 跟踪的是远端别名分支,写死分支名反而推错地方);没配就不推,如实说「只存在这台电脑」。
 * **推失败不抛**:把 stderr 一句带回去写进汇报就够 —— 没网不是「下班例程失败了」。
 *
 * 2026-09-27 抽成共用函数:下班例程第 7 步与收尾检查(memoryCloseout.ts)推的口径必须一个字不差。
 */
export async function pushIfUpstream(git: GitExec, repo: string): Promise<{ push: PushOutcome, failure?: string }> {
  const upstream = await git(['rev-parse', '--abbrev-ref', '@{u}'], repo)
  if (!upstream.ok || upstream.stdout.trim() === '') return { push: 'no-upstream' }
  const pushed = await git(['push'], repo)
  if (pushed.ok) return { push: 'pushed' }
  // 先挑最后一行(git 的解释都在末尾),再走 errorNote 截短抹长串 —— 反过来会把那一行截没。
  const lines = (pushed.stderr ?? '').split('\n').map(line => line.trim()).filter(line => line !== '')
  return { push: 'failed', failure: lines.length === 0 ? '没说原因' : errorNote(lines[lines.length - 1]) }
}

/** 推的结果那一句人话。`nothing`(没什么可推)不说话。 */
export function pushNote(push: PushOutcome, failure?: string): string | undefined {
  if (push === 'nothing') return undefined
  if (push === 'pushed') return '已推到远端'
  if (push === 'no-upstream') return '这个工作目录没配远端,没推——记忆只存在这台电脑上'
  return `推不上去:${failure ?? '没说原因'}`
}

/**
 * 下班例程第 0、1、2、3、4、6、7 步(docs/记忆/下班例程.md):收各家 AI 的记忆 → 读状态 → 覆盖布局快照 →
 * 每个今天有活动的项目追加一条进展 → 项目索引(每一行都补上文件)→ 记忆索引 → 一次 commit → 配了远端就推。
 * 第 5 步(偏好与「并」)与第 8 步(回三行)是模型的。
 *
 * 写只落在 docs/记忆 与 docs/记忆索引.md;每个文件都是「读 → 纯函数改 → 写回」,追加类的改动经
 * appendProgress 保证旧行不丢。commit 带路径限定,别处的改动一概不进。
 */
export async function runEveningWrites(input: EveningWriteInput): Promise<EveningWriteResult> {
  const { repo, date, startedMs, state } = input
  /**
   * 门过不去(这个工作目录不是 git 仓库 / 这台电脑没装开发者工具)就**把 git 整条换成一个不做事的**:
   * 记忆索引那一步的日期照样退回「今天」、第 7 步没有 commit、第 7b 步没什么可推 —— 全是既有的分支,
   * 一行行为都不用改。过不去的那一句人话进汇报(**不假装存过版本**)。
   */
  const gate = await (input.gitReady ?? createGitGate(repo))()
  const git: GitExec = gate.ok ? input.git : async () => ({ ok: false, stdout: '' })
  const result: EveningWriteResult = { projects: [], created: [], layout: false, index: false, push: 'nothing', summary: '' }

  // 0. 收:各家 AI 的记忆拷进 docs/记忆/来自-<家>/(过授权门),算出「新增或变了的」清单给第 5 步。
  //    拷来的文件在 COMMIT_PATHS 底下,跟第 7 步一起提交 —— 这里不单独 add、不单独 commit。
  //    **它出错只丢这一句**:今天没收成不该把下面几步一起拖没(见 collectMemories 那段注释)。
  let collectNote: string | undefined
  /** 推失败时那句原文(只留最后一行 —— git 的解释都在末尾)。 */
  let pushFailure: string | undefined
  if (input.collect !== undefined) {
    try {
      result.collect = await input.collect()
      collectNote = result.collect.summary
    }
    catch (error) {
      collectNote = `收各家记忆出错:${errorNote(error)}`
    }
  }

  // 1–2. 布局快照:直接用工作台那份纯函数渲染(与 /snapshot/layout.md 逐字同源),手写那一节保留。
  const snapshot = renderLayoutSnapshot({ ...snapshotInputOf(state), date })
  const layoutMd = join(repo, MEMORY_DIR, '工作台-布局.md')
  await writeAtomic(layoutMd, mergeLayoutMemory(snapshot.markdown, await readIfExists(layoutMd)))
  await writeAtomic(join(repo, MEMORY_DIR, '工作台-布局.html'), snapshot.html)
  result.layout = true

  // 3. 今天有活动的项目各追加一条进展。「有活动」= 仓库信号 idle_days 为 0(与项目区「今天在动」同一判据)。
  const projects = state.projects?.projects ?? []
  for (const project of projects) {
    if (project.signals?.idle_days !== 0) continue
    const file = join(repo, PROJECTS_DIR, projectFileName(project.name))
    let text = await readIfExists(file)
    if (text === undefined) {
      text = newProjectFile(project.name, project.path, date)
      result.created.push(project.name)
    }
    const appended = appendProgress(text, progressLine(project, date, state.tasks))
    if (appended.changed || result.created.includes(project.name)) {
      await writeAtomic(file, appended.text)
      result.projects.push(project.name)
    }
  }

  // 4. 项目索引的「最近活动」列。没有索引文件就不造一份(那是统筹会话建档时的事)。
  const indexFile = join(repo, PROJECTS_DIR, '索引.md')
  const indexText = await readIfExists(indexFile)
  if (indexText !== undefined) {
    const activities = projects
      .filter(p => p.signals !== undefined)
      .map(p => ({ name: p.name, idle_days: p.signals?.idle_days ?? 0, ...(p.path === undefined ? {} : { path: p.path }) }))
    const nextIndex = updateProjectIndex(indexText, date, activities)
    await writeAtomic(indexFile, nextIndex)
    result.index = true
    /**
     * 4b(2026-09-26,设计 §一 3 / §二 3–4):**索引里有的项目都要有文件**。
     * 原来只补行不建档 —— 索引 15 行、文件 5 个,点进去是空链接。这里按索引行补:
     * 缺的按 `newProjectFile` 建一份「待梳理」的档(那是事实:还没人梳理),已经有的一个字不动。
     * 链接指到 `项目/` 以外、或者认不出链接的行不管(那不是这一族的文件,不替它造)。
     */
    for (const row of projectIndexRows(nextIndex)) {
      const link = row.link ?? `项目/${projectFileName(row.name)}`
      if (!link.startsWith('项目/') || link.includes('..')) continue
      const file = join(repo, MEMORY_DIR, link)
      if (await readIfExists(file) !== undefined) continue
      await writeAtomic(file, newProjectFile(row.name, row.path, date))
      if (!result.created.includes(row.name)) result.created.push(row.name)
    }
  }

  // 6. 全仓库记忆索引重写:一行一文件,最后提交日来自 git log(没提交过的用今天)。
  //    第 7 步马上要提交的文件(记忆路径下有改动的)按提交后算、记今天——否则同一天第二次跑,
  //    这些文件的 git log 日期已变成今天,索引跟着变,就会多出第二个 commit。
  const docsDir = join(repo, 'docs')
  const status = await git(['status', '--porcelain', '-z', '--untracked-files=all', '--', ...COMMIT_PATHS], repo)
  const pending = new Set(status.ok ? status.stdout.split('\0').filter(line => line.length > 3).map(line => line.slice(3)) : [])
  const entries: MemoryIndexEntry[] = []
  for (const rel of await listMarkdown(docsDir)) {
    if (rel === '记忆索引.md') continue
    const text = await readIfExists(join(docsDir, rel))
    if (text === undefined) continue
    const log = pending.has(`docs/${rel}`) ? { ok: false, stdout: '' } : await git(['log', '-1', '--format=%cs', '--', `docs/${rel}`], repo)
    const logged = log.ok ? log.stdout.trim() : ''
    entries.push({ rel, ...describeMarkdown(text), date: /^\d{4}-\d{2}-\d{2}$/.test(logged) ? logged : date })
  }
  await writeAtomic(join(repo, MEMORY_INDEX), renderMemoryIndex(entries, date))

  // 7. 一次 commit,只带记忆那两个路径;作者/提交日期定在 date 那天(见 commitDateOf)。没改动就没有 commit,如实说。
  await git(['add', '--', ...COMMIT_PATHS], repo)
  const commitDate = commitDateOf(date, startedMs)
  const committed = await git([
    '-c', 'user.name=事务官', '-c', 'user.email=butler@workbench.local',
    'commit', '-m', `chore(记忆): 下班例程 ${date}`, '--', ...COMMIT_PATHS,
  ], repo, { GIT_AUTHOR_DATE: commitDate, GIT_COMMITTER_DATE: commitDate })
  if (committed.ok) {
    const head = await git(['rev-parse', '--short', 'HEAD'], repo)
    if (head.ok && head.stdout.trim() !== '') result.commit = head.stdout.trim()
  }

  // 7b. 提交完由代码推(2026-09-26);判据与口径全在 pushIfUpstream。没有 commit 就没什么可推。
  if (result.commit === undefined) {
    result.push = 'nothing'
  }
  else {
    const pushed = await pushIfUpstream(git, repo)
    result.push = pushed.push
    pushFailure = pushed.failure
  }

  const parts = [
    ...(collectNote === undefined ? [] : [collectNote]),
    ...(gate.ok ? [] : [gate.note ?? '这一步没存版本']),
    '布局快照已覆盖',
    result.projects.length === 0
      ? '今天没有项目有活动,进展没追加'
      : `${result.projects.length} 个项目追加了进展(${result.projects.slice(0, 5).join('、')}${result.projects.length > 5 ? ' 等' : ''})`,
    ...(result.created.length === 0 ? [] : [`新建档 ${result.created.length} 个`]),
    result.index ? '项目索引已更新' : '项目索引不存在、没动',
    '记忆索引已重写',
    result.commit === undefined ? '没有需要提交的改动' : `commit ${result.commit}`,
    ...(pushNote(result.push, pushFailure) === undefined ? [] : [pushNote(result.push, pushFailure) as string]),
  ]
  result.summary = parts.join(';')
  return result
}

/** —— 服务本体 —— */

interface PersistedState {
  last: Partial<Record<RoutineName, RoutineRun>>
}

function isRoutineName(value: unknown): value is RoutineName {
  return typeof value === 'string' && (ROUTINE_NAMES as readonly string[]).includes(value)
}

/** 本机时间 `YYYY-MM-DDTHH:MM`(不带时区——routines.json 里的时刻就是本机时刻,这里保持同一口径)。 */
function localStamp(ms: number, minutes: number): string {
  return `${localDateStr(ms)}T${hhmm(minutes)}`
}

/** 一句错误原文,截短;凭据本来就不会出现在例程的错误里,但保险起见把像 token 的长串抹掉。 */
export function errorNote(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  return message.replace(/[A-Za-z0-9_-]{32,}/g, '…').slice(0, 200)
}

export function createRoutinesService(opts: RoutinesServiceOptions): RoutinesService {
  const now = opts.now ?? (() => Date.now())
  const git = opts.git ?? defaultRoutineGit
  const skipRetryMs = opts.skipRetryMs ?? 5 * 60_000
  const closeoutEveryMs = opts.closeoutEveryMs ?? 10 * 60_000
  /** 上一次收尾检查是什么时候。0 = 还没做过(起来后第一拍就做一次)。 */
  let lastCloseoutMs = 0
  let closeoutRunning = false
  let config: RoutinesConfig = opts.defaultRepo === undefined
    ? DEFAULT_ROUTINES_CONFIG
    : { ...DEFAULT_ROUTINES_CONFIG, repo: opts.defaultRepo }
  const fallback = config
  let last: PersistedState['last'] = {}
  const running = new Set<RoutineName>()
  let deps: RoutinesDeps | undefined

  async function saveState(): Promise<void> {
    const state: PersistedState = { last }
    await writeAtomic(opts.stateFile, `${JSON.stringify(state, null, 2)}\n`)
  }

  async function saveConfig(): Promise<void> {
    await writeAtomic(opts.configFile, `${JSON.stringify(config, null, 2)}\n`)
  }

  function minutesOf(ms: number): number {
    const at = new Date(ms)
    return at.getHours() * 60 + at.getMinutes()
  }

  /** 今天这条跑过没:跑过且不是「跳过」就算跑过;跳过的过了冷却可以再试。 */
  function doneToday(name: RoutineName, today: string, nowMs: number): boolean {
    const run = last[name]
    if (run === undefined || run.date !== today) return false
    if (run.status !== 'skipped') return true
    const finished = Date.parse(run.finished_at ?? run.started_at)
    return Number.isNaN(finished) ? true : nowMs - finished < skipRetryMs
  }

  function nextOf(name: RoutineName, nowMs: number): RoutineNext | undefined {
    const today = localDateStr(nowMs)
    const nowMin = minutesOf(nowMs)
    const eveningMin = parseHhmm(config.evening.at) ?? 18 * 60 + 30
    if (name === 'morning') {
      if (!config.morning.enabled) return undefined
      const at = parseHhmm(config.morning.at)
      if (at === undefined) return { kind: 'sighting', not_before: config.morning.not_before }
      const tomorrow = last.morning?.date === today || nowMin >= at
      return { kind: 'at', at: localStamp(tomorrow ? nowMs + 86_400_000 : nowMs, at) }
    }
    if (name === 'evening') {
      if (!config.evening.enabled) return undefined
      const tomorrow = last.evening?.date === today && last.evening.status !== 'skipped'
      return { kind: 'at', at: localStamp(tomorrow ? nowMs + 86_400_000 : nowMs, eveningMin) }
    }
    if (!config.lint.enabled) return undefined
    for (let offset = 0; offset < 8; offset++) {
      const candidate = nowMs + offset * 86_400_000
      if (new Date(candidate).getDay() !== config.lint.weekday) continue
      if (offset === 0 && last.lint?.date === today && last.lint.status !== 'skipped') continue
      return { kind: 'at', at: localStamp(candidate, eveningMin) }
    }
    return undefined
  }

  function sessionOffline(): boolean {
    const session = opts.session
    if (session === undefined) return true
    return session.available !== undefined && session.available() === false
  }

  /**
   * 开一条例程会话。`job` 决定思考档(2026-09-28 卡 BS,设计 6.2):
   * 开工汇报念变化 → 关;下班例程的「关于你的观察」与 lint 的综合提案是真判断、错了会学歪 → high。
   */
  async function openSession(firstMessage: string, job: ButlerJob): Promise<string | undefined> {
    try {
      const id = await opts.session?.open(firstMessage, { effort: effortFor(job) })
      return typeof id === 'string' && id !== '' ? id : undefined
    }
    catch {
      return undefined
    }
  }

  function repoOf(): string | undefined {
    return config.repo
  }

  /**
   * 收尾检查跑一次。**不抛、不并发**:收尾没做成不该把例程一起拖没(memoryCloseout.ts 纪律 4)。
   * 时刻在开始与结束各记一次 —— 中间跑了多久都不该让下一拍紧接着又来一遍。
   */
  async function runCloseout(): Promise<void> {
    if (opts.closeoutMemories === undefined || closeoutRunning) return
    closeoutRunning = true
    lastCloseoutMs = now()
    try { await opts.closeoutMemories() }
    catch { /* 收尾没做成只是这一轮没做成,10 分钟后还有一次 */ }
    finally {
      closeoutRunning = false
      lastCloseoutMs = now()
    }
  }

  async function execMorning(run: RoutineRun, readState: () => Promise<WorkbenchState>, offline = false): Promise<void> {
    // 早报之前先把数据复盘那一轮跑掉(2026-09-21)。**它失败不连累开工汇报** ——
    // 取不到数是取不到数,不是"今天没有早报"。结果如实记进 note。
    const notes: string[] = []

    /**
     * 第 0 步「收」也在开工汇报时做一次(2026-09-27,并入闭环那张卡 C 条)。
     *
     * 由来:收原来只在下班例程跑,于是白天 Claude 新记的东西**第二天晚上**才进得来。
     * 同一道授权门、同一个函数;这里**只收不并** —— 清单留给下班例程那一条会话,
     * 早上 Ben 要的是「今天先做哪件」,不是一张待并清单。抛了不连累开工汇报(同下面几个钩子)。
     */
    const collectRepo = repoOf()
    if (opts.collectMemories !== undefined && collectRepo !== undefined) {
      try {
        const collected = await opts.collectMemories({ repo: collectRepo, date: run.date })
        notes.push(collected.skipped ?? `收各家记忆:${collected.summary}(清单留给下班例程)`)
      }
      catch (error) { notes.push(`收各家记忆出错:${errorNote(error)}`) }
    }

    try {
      const line = await opts.beforeMorning?.()
      if (line !== undefined) notes.push(line)
    }
    catch (error) { notes.push(`数据复盘自取出错:${errorNote(error)}`) }

    // 资讯:搜一轮,拿每个项目最多 3 条。同样"失败不连累开工汇报"。
    let feedGroups: readonly { project_name: string, items: readonly { title: string, why: string, source?: string }[] }[] = []
    try {
      const feed = await opts.feedBeforeMorning?.()
      if (feed !== undefined) {
        feedGroups = feed.groups
        if (feed.note !== undefined) notes.push(feed.note)
      }
    }
    catch (error) { notes.push(`资讯自取出错:${errorNote(error)}`) }

    // 运营目标:一行一个账号对一次进度。同样"失败不连累开工汇报"。
    let goalLines: readonly string[] = []
    try {
      goalLines = await opts.goalsBeforeMorning?.() ?? []
    }
    catch (error) { notes.push(`运营目标对进度出错:${errorNote(error)}`) }

    // 进度核对(2026-09-25,卡 N):按证据核一轮,只念变了的。同样"失败不连累开工汇报"。
    let progressLines: readonly string[] = []
    try {
      const checked = await opts.progressBeforeMorning?.()
      if (checked !== undefined) {
        progressLines = checked.lines
        if (checked.note !== undefined) notes.push(checked.note)
      }
    }
    catch (error) { notes.push(`进度核对出错:${errorNote(error)}`) }

    const state = await readState()
    const repo = repoOf()
    const memory = repo === undefined ? undefined : parseMemoryFacts(await readMemoryTexts(repo))
    // 停太久的事项(2026-10-12):/state 上每件事项已经现算好「停在哪」,这里只挑出停太久的念,不另起扫描。
    const stalledLines = stalledMorningLines(state.tasks?.tasks ?? [])
    // 今天的会与今天的待办(2026-10-13):同一条纪律 —— 素材已经在 /state 上(会前卡与「今天的待办」各自算好的),这里只挑出来念。
    const meetingLines = meetingTodayLines(state.meetings?.upcoming, run.date)
    const todoLines = todayTodoLines(state.today_todos)
    /*
     * 日报正文那四段(2026-10-13,《日报规范》):窗口 = 上次早报那一刻到现在(`last.morning` 还是上一次那条,
     * 本次的 record 要等 run() 收尾才写进去)。它抛了不连累早报(同资讯 / 目标 / 进度核对那几个钩子)。
     */
    let reviewLines: readonly string[] = []
    try {
      const window = dayReviewWindow(now(), last.morning?.started_at)
      const made = await composeDayReview({
        ...window,
        tasks: state.tasks?.tasks ?? [],
        ...(opts.dayReview?.jobEvents === undefined ? {} : { jobEvents: opts.dayReview.jobEvents() }),
        ...(state.projects === undefined ? {} : { projects: state.projects.projects.map(one => ({ id: one.id, name: one.name })) }),
        ...(state.today_todos === undefined ? {} : { today_todos: state.today_todos }),
        ...(state.notes === undefined ? {} : { notes: state.notes }),
        ...(opts.dayReview?.chat === undefined ? {} : { chat: opts.dayReview.chat }),
        // 正在走的接力(卡 F):读不到就当没有(接力那一层自己绝不抛,这里也不为它丢掉四段)。
        ...(deps?.videoChains === undefined ? {} : { chains: deps.videoChains() }),
      })
      reviewLines = made.lines
      if (made.note !== undefined) notes.push(made.note)
    }
    catch (error) { notes.push(`日报四段没出成:${errorNote(error)}`) }
    const report = composeMorningReport({
      memory,
      state: stateFactsOf(state),
      feed: feedGroups,
      goals: goalLines,
      progress: progressLines,
      stalled: stalledLines,
      meetings: meetingLines,
      todos: todoLines,
      day_review: reviewLines,
    })
    run.report = report.text
    if (offline) {
      // DSH 不在线(2026-10-13):模型那一半缺席,程序拼的这一半照样进收件箱 —— 同 no_session 那条取舍。
      run.status = 'no_session'
      run.session_offline = true
      run.note = [BUTLER_SESSION_OFFLINE_NOTE, ...notes].join(';')
      return
    }
    const sessionId = await openSession(morningFirstMessage(report.text, run.date), 'morning')
    if (sessionId === undefined) {
      run.status = 'no_session'
      // 数据复盘与资讯那两轮是**代码做的**,会话开不出来它们照样已经做完了 —— 记录里不能不写。
      run.note = [BUTLER_NO_SESSION_NOTE, ...notes].join(';')
      return
    }
    run.conversation = { agent: 'dsh', session_id: sessionId }
    const base = repo === undefined ? '没配记忆仓库(routines.json 的 repo),第一句没有' : '已发给 Ben,等他回答'
    run.note = [base, ...notes].join(';')
  }

  async function execEvening(run: RoutineRun, readState: () => Promise<WorkbenchState>): Promise<void> {
    const state = await readState()
    const repo = repoOf()
    let done: string
    const extra: EveningFirstMessageExtra = {}
    if (repo === undefined) {
      done = '没配记忆仓库(routines.json 的 repo),文件一个没写'
    }
    else {
      const collect = opts.collectMemories
      const written = await runEveningWrites({
        repo,
        date: run.date,
        startedMs: Date.parse(run.started_at),
        state,
        git,
        ...(collect === undefined ? {} : { collect: () => collect({ repo, date: run.date }) }),
      })
      done = written.summary
      if (written.commit !== undefined) run.commit = written.commit
      if (written.collect !== undefined) extra.fresh = written.collect.fresh
      // 用户文件叫什么按仓库里现有的那份算(2026-09-26,不写死 用户-Ben.md)。
      const userFile = await findUserMemoryFile(repo)
      if (userFile !== undefined) extra.userFile = userFile
    }
    // 画像回写(2026-09-22 卡④)。**在记忆仓库那几步之外**:它写的是工作目录里她自己的
    // `账号.md`,与 repo 配没配无关,所以放在 if/else 外面。抛了只丢这一句。
    try {
      const line = await opts.profileAfterEvening?.()
      if (line !== undefined) done = `${done};${line}`
    }
    catch (error) { done = `${done};画像回写出错:${errorNote(error)}` }
    run.note = done
    const sessionId = await openSession(eveningFirstMessage(run.date, done, extra), 'evening')
    if (sessionId === undefined) {
      run.status = 'no_session'
      run.note = `${done};${BUTLER_NO_SESSION_NOTE}`
      // 会话开不出来，代码那一半照样做完了（同 execMorning 的取舍）——这一扫也照样该跑。
      await afterEveningNote(run)
      return
    }
    run.conversation = { agent: 'dsh', session_id: sessionId }
    await afterEveningNote(run)
  }

  /**
   * 下班例程收尾那一下（2026-09-22）。**两条出口都走它** —— 会话开不出来那一支
   * 上面已经 return 了，所以那一支自己也调一次（见 execEvening）。失败只记一句，不改 status：
   * 「今天的提议没扫成」不是「下班例程失败了」。
   */
  async function afterEveningNote(run: RoutineRun): Promise<void> {
    if (opts.afterEvening === undefined) return
    try {
      const line = await opts.afterEvening()
      if (line !== undefined && line !== '') run.note = run.note === undefined ? line : `${run.note};${line}`
    }
    catch (error) { run.note = `${run.note ?? ''};进化提议没扫成:${errorNote(error)}` }
  }

  async function execLint(run: RoutineRun): Promise<void> {
    run.report = lintDocPath(run.date)
    const sessionId = await openSession(lintFirstMessage(run.date), 'lint')
    if (sessionId === undefined) {
      run.status = 'no_session'
      run.note = BUTLER_NO_SESSION_NOTE
      return
    }
    run.conversation = { agent: 'dsh', session_id: sessionId }
    run.note = `提议写在 ${run.report},只提议不改文件`
  }

  async function run(name: RoutineName, trigger: RoutineTrigger): Promise<{ ok: true, run: RoutineRun } | { ok: false, reason: string }> {
    if (running.has(name)) return { ok: false, reason: '这条例程正在跑' }
    const current = deps
    if (current === undefined) return { ok: false, reason: '例程还没接上工作台状态' }
    running.add(name)
    // 例程开跑前先收一次尾:上一条例程之后模型写了没提交的东西,先落成一笔,再开始今天这一条。
    await runCloseout()
    const startedMs = now()
    const record: RoutineRun = {
      name,
      date: localDateStr(startedMs),
      trigger,
      started_at: new Date(startedMs).toISOString(),
      status: 'ok',
    }
    const offline = sessionOffline()
    try {
      // DSH 不在线时**早报照出程序拼的那一半**(2026-10-13);下班例程与 lint 仍然跳过 —— 它们那一半要写文件、要 commit。
      if (offline && name !== 'morning') {
        record.status = 'skipped'
        record.note = 'DSH 不在线,这次跳过'
      }
      else if (name === 'morning') await execMorning(record, current.readState, offline)
      else if (name === 'evening') await execEvening(record, current.readState)
      else await execLint(record)
    }
    catch (error) {
      record.status = 'failed'
      record.note = errorNote(error)
    }
    record.finished_at = new Date(now()).toISOString()
    last = { ...last, [name]: record }
    running.delete(name)
    try {
      await saveState()
    }
    catch {
      // 状态文件写不下只影响「重启后不重跑」,不影响这次的结果。
    }
    current.onChanged?.()
    return { ok: true, run: record }
  }

  function fire(name: RoutineName, trigger: RoutineTrigger): void {
    void run(name, trigger)
  }

  return {
    async load(): Promise<void> {
      try {
        config = parseRoutinesConfig(JSON.parse(await readFile(opts.configFile, 'utf8')), fallback)
      }
      catch {
        config = fallback
      }
      try {
        const raw = JSON.parse(await readFile(opts.stateFile, 'utf8')) as Partial<PersistedState>
        const loaded: PersistedState['last'] = {}
        for (const name of ROUTINE_NAMES) {
          const candidate = raw.last?.[name]
          if (typeof candidate === 'object' && candidate !== null && typeof candidate.date === 'string') loaded[name] = candidate
        }
        last = loaded
      }
      catch {
        last = {}
      }
    },

    attach(next: RoutinesDeps): void {
      deps = next
    },

    config(): RoutinesConfig {
      return config
    },

    async setConfig(patch: unknown): Promise<RoutinesConfig> {
      const obj = (typeof patch === 'object' && patch !== null ? patch : {}) as Record<string, unknown>
      // 逐块合并:只给了 evening.at 不该把 evening.enabled 冲回默认。
      const merged = {
        morning: { ...config.morning, ...(typeof obj.morning === 'object' && obj.morning !== null ? obj.morning : {}) },
        evening: { ...config.evening, ...(typeof obj.evening === 'object' && obj.evening !== null ? obj.evening : {}) },
        lint: { ...config.lint, ...(typeof obj.lint === 'object' && obj.lint !== null ? obj.lint : {}) },
        repo: 'repo' in obj ? obj.repo : config.repo,
      }
      const base: RoutinesConfig = { ...config }
      // repo: null 表示清掉;parse 那边空串/非字符串退回 fallback,所以这里先把 fallback 的 repo 摘掉。
      if (obj.repo === null) delete base.repo
      config = parseRoutinesConfig(merged, base)
      await saveConfig()
      return config
    },

    view(): RoutinesView {
      const nowMs = now()
      const next: RoutinesView['next'] = {}
      for (const name of ROUTINE_NAMES) {
        const value = nextOf(name, nowMs)
        if (value !== undefined) next[name] = value
      }
      return { next, last: { ...last }, running: [...running], config }
    },

    async run(name: RoutineName, trigger: RoutineTrigger = 'manual') {
      if (!isRoutineName(name)) return { ok: false as const, reason: '没有这条例程' }
      return run(name, trigger)
    },

    pump(): void {
      if (deps === undefined) return
      if (opts.setupGate?.() !== undefined) return
      const nowMs = now()
      const today = localDateStr(nowMs)
      const nowMin = minutesOf(nowMs)
      const eveningMin = parseHhmm(config.evening.at) ?? 18 * 60 + 30

      // 收尾检查:每 10 分钟一拍(与三条例程的时刻无关 —— 模型什么时候断的没人知道)。
      if (nowMs - lastCloseoutMs >= closeoutEveryMs) void runCloseout()

      const morningAt = parseHhmm(config.morning.at ?? opts.learnedMorningAt?.())
      if (config.morning.enabled && morningAt !== undefined && nowMin >= morningAt
        && !doneToday('morning', today, nowMs) && !running.has('morning')) {
        fire('morning', 'schedule')
      }
      if (config.evening.enabled && nowMin >= eveningMin && !doneToday('evening', today, nowMs) && !running.has('evening')) {
        fire('evening', 'schedule')
      }
      // 知识 lint:那天的下班例程跑完之后(下班例程关着就只看时刻)。
      const eveningSettled = !config.evening.enabled
        || (last.evening?.date === today && last.evening.status !== 'skipped' && !running.has('evening'))
      if (config.lint.enabled && new Date(nowMs).getDay() === config.lint.weekday && nowMin >= eveningMin
        && eveningSettled && !doneToday('lint', today, nowMs) && !running.has('lint')) {
        fire('lint', 'schedule')
      }
    },

    sighted(): void {
      if (deps === undefined) return
      if (opts.setupGate?.() !== undefined) return
      if (!config.morning.enabled || config.morning.at !== undefined) return
      const nowMs = now()
      const notBefore = parseHhmm(config.morning.not_before) ?? 6 * 60
      if (minutesOf(nowMs) < notBefore) return
      if (doneToday('morning', localDateStr(nowMs), nowMs) || running.has('morning')) return
      fire('morning', 'sighting')
    },
  }
}
