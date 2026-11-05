/**
 * 引导落地的 **I/O 那一半**(2026-09-24 晚,卡 feat/onboarding-materialize)。
 *
 * `POST /onboarding/materialize/preview`:读存档(onboarding.json)+ 项目区 + 看板 + 例程 / 免打扰 / 资讯现在的样子 →
 * 抽卡(规则表必跑;模型那一份有就合进来,按存档指纹缓存)→ 排计划(materialize.ts `buildPlan`)→ 存进
 * `~/.dsh/workbench/materialize.json`,/state 里出一份给电脑首页与手机「等你确认」画那张「我照你说的摆好了」。
 *
 * `POST /onboarding/materialize/apply {id, uncheck?, check?, edits?, skip?}`:他点「就这样」(或电话里说「可以」)才写 ——
 *   项目(认领、截止日、负责人)→ 冲刺与模块 → 卡 → 例程 → 免打扰 → 资讯 → 窗口槽(卡 C 的接口)→ 补拷记忆 →
 *   撤掉旧事项(改「取消」,**不删**)→ 派第一件(现有派活链路:给这张卡开一条事务官会话,点名 Codex)。
 *
 * **可重跑、按内容去重**:每一步落之前现对一遍(同样的卡在看板上已经有了就跳过,例程已经是这个时刻就跳过),
 * 同一份存档再落一次什么都不会多。没接的那几样(看板、例程、窗口槽……)占位不勾,不装成能做(D13)。
 */
import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { MaterializeResultView, MaterializeStateView, TaskAssignee, TaskPriority, TaskStatus, TasksState } from '../protocol.ts'
import { BUTLER_NO_SESSION_NOTE } from '../protocol.ts'
import type { ButlerEffort } from './butlerEffort.ts'
import { effortFor } from './butlerEffort.ts'
import { butlerConversation, butlerFirstMessage } from './butlerItem.ts'
import type {
  CardOwner, Extraction, MaterializeArchive, MaterializePlan, MaterializeRow, PlanContext, ProjectsSnapshot, RowEdit,
} from './materialize.ts'
import {
  archiveClauses, buildPlan, cardAssignee, cardDesc, contentHash, mergeExtractions, parseModelExtraction, rulesExtract, selectRows, titleSimilarity,
} from './materialize.ts'

type ModelValue = Exclude<ReturnType<typeof parseModelExtraction>, { ok: false }>['value']

/** 卡 C 的窗口槽报告(`dock.claimPreview` / `dock.claimEnabled`)。只认用得到的几格。 */
export interface SlotReport {
  ok: boolean
  results: readonly { app: string, label: string, state: string, note?: string }[]
  claimed?: readonly { app: string, label: string }[]
  pending?: readonly { app: string, label: string, state: string, note?: string }[]
}

export interface MaterializeServiceOptions {
  /** ~/.dsh/workbench/materialize.json */
  file: string
  now?: () => Date
  /** onboarding.json(只读)。没有 = 还没引导过。 */
  readArchive: () => Promise<MaterializeArchive | undefined>
  tasks?: {
    list: () => Promise<TasksState>
    create: (input: {
      title: string, desc?: string, status?: TaskStatus, projectId?: string, moduleId?: string, priority?: TaskPriority,
      assignee?: TaskAssignee, due?: string, direction?: 'mine', source?: { kind: 'manual', ref?: string },
      /** 负责人那一格的补充(「9/29 回来写」,2026-09-25 卡 N)。 */
      assigneeNote?: string,
      /** 谁写下的(2026-09-25,卡 A 的 TaskOrigin):引导落地建的卡一律 `onboarding` —— 不是他亲口交代的,不进「他反复说的话」。 */
      origin?: 'onboarding'
    }) => Promise<{ ok: boolean, id?: string, reason?: string }>
    move: (id: string, status: TaskStatus) => Promise<{ ok: boolean, reason?: string }>
    update: (id: string, input: Record<string, unknown>) => Promise<boolean>
    createSprint: (input: { projectId: string, name: string, goal?: string, startsAt?: string, endsAt?: string }) => Promise<{ ok: boolean, id?: string, reason?: string }>
    createModule: (input: { sprintId: string, name: string }) => Promise<{ ok: boolean, id?: string, reason?: string }>
    setProjectMeta: (projectId: string, input: { assignee?: 'dsh' | 'claude' | 'codex' | 'kimi' | null }) => Promise<boolean>
  }
  projects?: {
    stored: () => Promise<ProjectsSnapshot['stored']>
    repos: () => Promise<ProjectsSnapshot['repos']>
    adopt?: (input: { name: string, path: string }) => Promise<{ id: string }>
    setDdl?: (id: string, ddl: { date: string, title: string } | null) => Promise<boolean>
    /** 项目区那一行状态(projectsService.confirmStatus:作者「你」—— 他点了「就这样」就是他确认的)。 */
    confirmStatus?: (id: string, text: string) => Promise<boolean>
  }
  routines?: { config: () => { morning: { at?: string }, evening: { at?: string } }, setConfig: (patch: unknown) => Promise<unknown> }
  quiet?: { config: () => { quiet_from: string, quiet_to: string }, setConfig: (patch: unknown) => Promise<unknown> }
  feed?: {
    config: () => { podcast: boolean, interests: readonly { project_id: string, project_name: string, keywords: readonly string[] }[] }
    setConfig: (patch: unknown) => Promise<unknown>
  }
  /** apps.json 的 enabled。 */
  apps?: { enabled: () => Promise<readonly string[]> }
  /** 卡 C 的窗口槽(方法在就用,不在就占位)。 */
  dock?: { claimPreview?: () => Promise<SlotReport>, claimEnabled?: (options?: { launch?: boolean }) => Promise<SlotReport> }
  /** 拷别家记忆(onboarding.importMemories,同一道授权门)。 */
  memories?: { importNow: () => Promise<{ ok: boolean, note: string }> }
  /** 授权表里「读各家客户端文件」现在是哪一档。 */
  readClientFiles?: () => Promise<string | undefined>
  /** 项目仓库现在的版本(判交接清单过时)。 */
  version?: (path: string) => Promise<string | undefined>
  /** Codex 里按名字找会话(「参赛网页」→「制作参赛网页」)。 */
  codexThread?: (query: string) => Promise<{ id: string, title: string } | undefined>
  /** 模型那一份(materializeModel.ts `extractWithModel`)。没接 = 只用规则表。 */
  extract?: (archive: MaterializeArchive, today: string) => Promise<{ ok: true, value: ModelValue, model?: string } | { ok: false, why: string }>
  /**
   * 给已经建好的卡派活。`text` 是交给事务官的那一句(现有链路:开一条事务官会话、点名那一家);
   * `agentText` 是直接说给那一家听的那一句(卡 F 的 `dispatchItem` 在就走它)。
   */
  dispatch?: (input: { taskId: string, owner: CardOwner, text: string, agentText: string }) => Promise<{ ok: boolean, note?: string, session_id?: string }>
  /**
   * 规矩表(2026-09-25,卡 O):引导里他说的分工落成「派活默认分工」那一条,来源标「引导」;
   * 表里已经有同标题的(统筹手加的那条)只多记一条依据。缺席 = 这一行占位不勾。
   */
  rules?: {
    hasDivision: () => boolean
    adoptDivision: (input: { text: string, said: string }) => Promise<{ ok: boolean, added: boolean, note: string }>
  }
  /** 落完了告诉引导:项目背景写进项目文件、存一个版本(onboarding.recordMaterialized)。 */
  onApplied?: (input: { background?: { project: string, text: string }, rows: readonly string[] }) => Promise<void>
  /** 状态变了(广播快照)。 */
  onChanged?: () => void
}

/** /state.materialize(不带每一行真做时要的数据),形状在 protocol.ts。 */
export type { MaterializeStateView }

export interface MaterializeApplyResult extends MaterializeResultView {
  rows: { key: string, title: string, ok: boolean, note?: string }[]
  unmatched?: string[]
}

export type PreviewResult =
  | { ok: true, plan: MaterializePlan, reused: boolean }
  | { ok: false, status: 404 | 409 | 500, error: string }

export type ApplyOutcome =
  | { ok: true, result: MaterializeApplyResult, plan_id: string }
  | { ok: false, status: 400 | 404 | 409, error: string }

export interface MaterializeService {
  load: () => Promise<void>
  /** 排一份计划(已经有同一份存档、同样现状的就直接回那一份)。`state` 是 /state 里卡 C 的那两格。 */
  preview: (input?: { force?: boolean, state?: { quota_connect?: unknown, clients?: unknown, agent_caps?: unknown } }) => Promise<PreviewResult>
  apply: (input: { id?: string, uncheck?: readonly string[], check?: readonly string[], edits?: Readonly<Record<string, RowEdit>>, skip?: readonly string[] }) => Promise<ApplyOutcome>
  view: () => MaterializeStateView | undefined
  /** 工人 / 简报要的那一小份:有没有一张等他点头的单子。 */
  brief: () => { pending: boolean, id?: string, line?: string, applied?: boolean }
  /** 后台先把模型那一份问好(引导进收尾时调;存档指纹不变就不再问)。 */
  warm: () => void
}

interface StoredApply { plan_id: string, at: string, result: MaterializeApplyResult }

interface MaterializeFile {
  version: 1
  /** 模型那一份,按「项目答案 + 其它」的指纹缓存(同一份存档重跑不再问模型、卡一个字不变)。 */
  model: Record<string, { at: string, ok: boolean, value?: ModelValue, why?: string, model?: string }>
  /** 最近几份计划(他点的那一份 id 要还认得)。 */
  plans: MaterializePlan[]
  /** 当前挂在屏幕上的那一份。 */
  current?: string
  applied: StoredApply[]
  /** 落过的东西(行键 → 建出来的 id),重跑时对账用。 */
  created: Record<string, { task_id?: string, sprint_id?: string, modules?: Record<string, string> }>
}

const KEEP_PLANS = 5
const KEEP_MODEL = 4

function emptyFile(): MaterializeFile {
  return { version: 1, model: {}, plans: [], applied: [], created: {} }
}

/** 模型那一份的输入指纹:只看项目答案与「其它」(收尾那几项进不进来都一样 —— 第一件由规则认)。 */
export function modelInputHash(archive: MaterializeArchive): string {
  const { project, clauses } = archiveClauses(archive)
  return contentHash({ project: project?.name, clauses: clauses.filter(one => !one.from.startsWith('wrapup.')).map(one => `${one.from}|${one.text}`) })
}

function localDate(now: Date): string {
  const offset = now.getTimezoneOffset() * 60_000
  return new Date(now.getTime() - offset).toISOString().slice(0, 10)
}

function stripData(row: MaterializeRow): Omit<MaterializeRow, 'data'> {
  const { data: _data, ...rest } = row
  return rest
}

export function createMaterializeService(options: MaterializeServiceOptions): MaterializeService {
  const now = options.now ?? (() => new Date())
  let state: MaterializeFile = emptyFile()
  let applying = false
  let queue: Promise<unknown> = Promise.resolve()
  let warming: Promise<void> | undefined

  function enqueue<T>(task: () => Promise<T>): Promise<T> {
    const result = queue.then(task, task)
    queue = result.then(() => undefined, () => undefined)
    return result
  }

  async function save(): Promise<void> {
    await mkdir(dirname(options.file), { recursive: true })
    const tmp = `${options.file}.${randomUUID()}.tmp`
    await writeFile(tmp, `${JSON.stringify(state, null, 2)}\n`, 'utf8')
    await rename(tmp, options.file)
  }

  const currentPlan = (): MaterializePlan | undefined => state.plans.find(plan => plan.id === state.current)
  const appliedOf = (id: string): StoredApply | undefined => state.applied.find(one => one.plan_id === id)

  /** 模型那一份:缓存里有就用;没有就问一次(问过失败的也记下来,同一份存档不反复问)。 */
  async function modelPart(archive: MaterializeArchive, today: string): Promise<{ value?: ModelValue, note?: string }> {
    if (options.extract === undefined) return { note: '没接模型,按规则表认的' }
    const key = modelInputHash(archive)
    const cached = state.model[key]
    if (cached !== undefined) return cached.ok ? { ...(cached.value === undefined ? {} : { value: cached.value }) } : { note: cached.why ?? '模型那一份没用上' }
    let got: Awaited<ReturnType<NonNullable<MaterializeServiceOptions['extract']>>>
    try { got = await options.extract(archive, today) }
    catch (error) { got = { ok: false, why: `模型那一份出错了(${error instanceof Error ? error.message : String(error)})` } }
    state.model[key] = got.ok
      ? { at: now().toISOString(), ok: true, value: got.value, ...(got.model === undefined ? {} : { model: got.model }) }
      : { at: now().toISOString(), ok: false, why: got.why }
    // 只留最近几份。
    const keys = Object.keys(state.model)
    for (const old of keys.slice(0, Math.max(0, keys.length - KEEP_MODEL))) delete state.model[old]
    return got.ok ? { value: got.value } : { note: got.why }
  }

  async function extraction(archive: MaterializeArchive, today: string): Promise<Extraction> {
    const rules = rulesExtract(archive, today)
    const model = await modelPart(archive, today)
    const first = archive.answers.wrapup?.first_item
    return mergeExtractions(rules, model.value, model.note, typeof first === 'string' ? first : undefined, archiveClauses(archive).clauses)
  }

  /** 现状:看板、项目区、例程、免打扰、资讯、窗口槽、额度……拿不到的那一格就缺席。 */
  async function context(archive: MaterializeArchive, ex: Extraction, extra?: { quota_connect?: unknown, clients?: unknown, agent_caps?: unknown }): Promise<PlanContext> {
    const at = now()
    const today = localDate(at)
    const board = options.tasks === undefined ? { tasks: [], sprints: [], modules: [] } : await options.tasks.list()
    const stored = options.projects === undefined ? [] : await options.projects.stored().catch(() => [])
    const repos = options.projects === undefined ? [] : await options.projects.repos().catch(() => [])
    const main = archiveClauses(archive).project
    const version = main?.path === undefined || options.version === undefined ? undefined : await options.version(main.path).catch(() => undefined)
    const first = ex.cards.find(card => card.first === true)
    const thread = first === undefined || first.owner !== 'codex' || options.codexThread === undefined
      ? undefined
      : await options.codexThread(first.title.replace(/收尾$|架构/g, '')).catch(() => undefined)
    const slotPreview = options.dock?.claimPreview === undefined ? undefined : await options.dock.claimPreview().catch(() => undefined)
    const enabled = options.apps === undefined ? undefined : await options.apps.enabled().catch(() => undefined)
    const readClientFiles = options.readClientFiles === undefined ? undefined : await options.readClientFiles().catch(() => undefined)
    const quota = extra?.quota_connect as PlanContext['quotaStatus'] | undefined
    const clients = extra?.clients as PlanContext['clients'] | undefined
    // 各家能做什么(卡 O 的体检,`/state.agent_caps`):单子上「桌面」那一组多一行,只读。
    const caps = extra?.agent_caps as { line?: unknown } | undefined
    const capsLine = typeof caps?.line === 'string' && caps.line.trim() !== '' ? caps.line.trim() : undefined
    return {
      now: at,
      today,
      archive,
      extraction: ex,
      board: { tasks: board.tasks, sprints: board.sprints, modules: board.modules },
      projects: { stored, repos },
      ...(options.routines === undefined ? {} : { routines: options.routines.config() }),
      ...(options.quiet === undefined ? {} : { quiet: { from: options.quiet.config().quiet_from, to: options.quiet.config().quiet_to } }),
      ...(options.feed === undefined ? {} : { feed: options.feed.config() }),
      ...(enabled === undefined ? {} : { apps: { enabled } }),
      ...(slotPreview === undefined ? {} : { slotPreview }),
      ...(quota === undefined || !Array.isArray((quota as { providers?: unknown }).providers) ? {} : { quotaStatus: quota }),
      ...(clients === undefined || clients === null || typeof clients !== 'object' ? {} : { clients }),
      ...(readClientFiles === undefined ? {} : { readClientFiles }),
      ...(capsLine === undefined ? {} : { agentCaps: { line: capsLine } }),
      ...(version === undefined ? {} : { currentVersion: version }),
      ...(thread === undefined ? {} : { codexThread: thread }),
      ...(options.rules === undefined ? {} : { rules: { hasDivision: options.rules.hasDivision() } }),
      wired: {
        tasks: options.tasks !== undefined,
        projects: options.projects !== undefined,
        routines: options.routines !== undefined,
        quiet: options.quiet !== undefined,
        feed: options.feed !== undefined,
        slot: options.dock?.claimEnabled !== undefined,
        quota: false,
        memories: options.memories !== undefined,
        dispatch: options.dispatch !== undefined && options.tasks !== undefined,
        rules: options.rules !== undefined,
      },
    }
  }

  function remember(plan: MaterializePlan): void {
    state.plans = [...state.plans.filter(one => one.id !== plan.id), plan].slice(-KEEP_PLANS)
    state.current = plan.id
  }

  async function preview(input?: { force?: boolean, state?: { quota_connect?: unknown, clients?: unknown, agent_caps?: unknown } }): Promise<PreviewResult> {
    const archive = await options.readArchive()
    if (archive === undefined) return { ok: false, status: 404, error: '还没有引导的存档(onboarding.json),没有可落地的' }
    if (archivedAnswersEmpty(archive)) return { ok: false, status: 409, error: '引导里还没记下项目,没有可落地的' }
    const today = localDate(now())
    const ex = await extraction(archive, today)
    const plan = buildPlan(await context(archive, ex, input?.state))
    const same = currentPlan()
    const reused = same !== undefined && same.id === plan.id && input?.force !== true
    if (!reused) remember(plan)
    await save()
    options.onChanged?.()
    return { ok: true, plan: reused ? same : plan, reused }
  }

  // ———————————————————————— 落地 ————————————————————————

  async function apply(input: Parameters<MaterializeService['apply']>[0]): Promise<ApplyOutcome> {
    if (applying) return { ok: false, status: 409, error: '正在落,等这一次落完' }
    const planId = input.id ?? state.current
    if (planId === undefined) return { ok: false, status: 404, error: '还没有排好的单子,先 POST /onboarding/materialize/preview' }
    const plan = state.plans.find(one => one.id === planId)
    if (plan === undefined) return { ok: false, status: 404, error: '这张单子已经换过了,重新看一眼(preview)再点' }
    const done = appliedOf(plan.id)
    if (done !== undefined) return { ok: true, result: done.result, plan_id: plan.id }
    applying = true
    options.onChanged?.()
    try {
      const picked = selectRows(plan, input)
      const result = await run(plan, picked.rows)
      if (picked.unmatched.length > 0) result.unmatched = picked.unmatched
      state.applied = [...state.applied.filter(one => one.plan_id !== plan.id), { plan_id: plan.id, at: now().toISOString(), result }].slice(-KEEP_PLANS)
      await save()
      return { ok: true, result, plan_id: plan.id }
    }
    finally {
      applying = false
      options.onChanged?.()
    }
  }

  /** 一行一行落。**每一行都现对一遍**:已经有了的跳过(可重跑)。一行失败不挡别的行,回执里如实写。 */
  async function run(plan: MaterializePlan, rows: readonly MaterializeRow[]): Promise<MaterializeApplyResult> {
    const out: MaterializeApplyResult['rows'] = []
    const note = (row: MaterializeRow, ok: boolean, text?: string): void => {
      out.push({ key: row.key, title: row.title, ok, ...(text === undefined ? {} : { note: text }) })
    }
    const today = localDate(now())
    const projectIds = new Map<string, string>()
    let background: { project: string, text: string } | undefined
    const stored = options.projects === undefined ? [] : await options.projects.stored().catch(() => [])
    const repos = options.projects === undefined ? [] : await options.projects.repos().catch(() => [])
    const idForPath = (path: string | undefined, name: string): string | undefined => {
      if (path !== undefined && projectIds.has(path)) return projectIds.get(path)
      return stored.find(one => (path !== undefined && one.repoPath === path) || one.name === name)?.id
        ?? repos.find(one => path !== undefined && one.path === path)?.id
    }

    // ① 项目
    for (const row of rows.filter(one => one.data.kind === 'project')) {
      if (row.data.kind !== 'project') continue
      const data = row.data
      try {
        let id = data.id ?? idForPath(data.path, data.name)
        if (data.path !== undefined && options.projects?.adopt !== undefined) id = (await options.projects.adopt({ name: data.name, path: data.path })).id
        if (id === undefined) { note(row, false, '项目区里没找到它的仓库,只记了名字'); continue }
        if (data.path !== undefined) projectIds.set(data.path, id)
        projectIds.set(data.name, id)
        if (data.ddl !== undefined && options.projects?.setDdl !== undefined) await options.projects.setDdl(id, data.ddl)
        // 状态只在还没写过时写(排单子时已经对过一遍;落之前再对一遍,中间他自己写了就不盖)。
        const before = stored.find(one => one.id === id)?.status
        if (data.status !== undefined && (before === undefined || before.trim() === '') && options.projects?.confirmStatus !== undefined) {
          await options.projects.confirmStatus(id, data.status)
        }
        if (data.owner !== undefined && options.tasks !== undefined && (data.owner === 'codex' || data.owner === 'claude' || data.owner === 'kimi')) {
          await options.tasks.setProjectMeta(id, { assignee: data.owner })
        }
        if (data.main && data.background !== undefined) background = { project: data.memory ?? data.name, text: data.background }
        note(row, true)
      }
      catch (error) { note(row, false, errorText(error)) }
    }

    // ② 冲刺、模块、卡
    const tasks = options.tasks
    let board = tasks === undefined ? undefined : await tasks.list()
    const sprintRow = rows.find(one => one.data.kind === 'sprint')
    const moduleIds = new Map<string, string>()
    let sprintProjectId: string | undefined
    if (sprintRow !== undefined && sprintRow.data.kind === 'sprint' && tasks !== undefined && board !== undefined) {
      const data = sprintRow.data
      const main = plan.rows.find(one => one.data.kind === 'project' && one.data.main)
      const mainData = main?.data.kind === 'project' ? main.data : undefined
      sprintProjectId = mainData === undefined ? undefined : idForPath(mainData.path, mainData.name)
      try {
        if (sprintProjectId === undefined) throw new Error('冲刺要归在一个项目下,项目区里没找到它')
        let sprint = board.sprints.find(one => one.project_id === sprintProjectId && titleSimilarity(one.name, data.name) >= 0.95)
        if (sprint === undefined) {
          const made = await tasks.createSprint({ projectId: sprintProjectId, name: data.name, goal: '引导落地:照他在引导里说的排', startsAt: today, endsAt: data.deadline })
          if (!made.ok || made.id === undefined) throw new Error(made.reason ?? '看板没建成冲刺')
          board = await tasks.list()
          sprint = board.sprints.find(one => one.id === made.id)
        }
        for (const name of data.modules) {
          const have = board.modules.find(one => one.sprint_id === sprint?.id && one.name === name)
          if (have !== undefined) { moduleIds.set(name, have.id); continue }
          const made = await tasks.createModule({ sprintId: sprint?.id as string, name })
          if (made.ok && made.id !== undefined) moduleIds.set(name, made.id)
        }
        state.created[sprintRow.key] = { sprint_id: sprint?.id as string, modules: Object.fromEntries(moduleIds) }
        note(sprintRow, true)
      }
      catch (error) { note(sprintRow, false, errorText(error)) }
    }
    const taskIds = new Map<string, string>()
    /**
     * 冲刺卡是**看板上的卡**,不挂「我交给事务官的」(direction:'mine')—— 那是「他交给事务官、开一条会话去办」的事项,
     * 手机上会当成他说的一句话、配一句「会话未开」(2026-09-24 晚 scratch 截图查出来的)。**只有第一件**是交给事务官去派的,
     * 它挂 mine,描述就是他点头的那句原话。
     */
    const dispatchData = rows.find(one => one.data.kind === 'dispatch')?.data
    const firstKey = dispatchData?.kind === 'dispatch' ? dispatchData.topic_key : undefined
    const firstSaid = dispatchData?.kind === 'dispatch' ? dispatchData.said : undefined
    for (const row of rows.filter(one => one.data.kind === 'task')) {
      if (row.data.kind !== 'task' || tasks === undefined) continue
      const card = row.data.card
      try {
        board = await tasks.list()
        const have = board.tasks.find(task => task.status !== 'canceled' && titleSimilarity(task.title, card.title) >= 0.95)
        if (have !== undefined) { taskIds.set(row.key, have.id); note(row, true, '看板上已经有了,没重复建'); continue }
        const moduleId = moduleIds.get(card.group ?? '参赛冲刺')
        const assignee = cardAssignee(card)
        const handed = row.key === firstKey
        const made = await tasks.create({
          // 负责人那一格的补充(「9/29 回来写」,卡 N):负责人是人的时候跟在名字后面。
          ...(card.owner_note === undefined || cardAssignee(card) === undefined ? {} : { assigneeNote: card.owner_note }),
          title: card.title,
          // 交给事务官的那一件:描述就是他点头的那句原话(手机对话里他那一句;同「交给事务官」那条老链路,描述 = 他说的话)。
          desc: handed && firstSaid !== undefined ? firstSaid : cardDesc(card),
          status: card.status,
          ...(sprintProjectId === undefined ? {} : { projectId: sprintProjectId }),
          ...(moduleId === undefined ? {} : { moduleId }),
          ...(card.priority === undefined ? {} : { priority: card.priority }),
          ...(assignee === undefined ? {} : { assignee }),
          ...(card.due === undefined ? {} : { due: card.due }),
          ...(handed ? { direction: 'mine' as const } : {}),
          source: { kind: 'manual', ref: '引导落地' },
          origin: 'onboarding',
        })
        if (!made.ok || made.id === undefined) throw new Error(made.reason ?? '看板没建成')
        taskIds.set(row.key, made.id)
        state.created[row.key] = { task_id: made.id }
        note(row, true)
      }
      catch (error) { note(row, false, errorText(error)) }
    }

    // ③ 每天
    for (const row of rows.filter(one => one.data.kind === 'routine')) {
      if (row.data.kind !== 'routine' || options.routines === undefined) continue
      try {
        await options.routines.setConfig(row.data.which === 'morning' ? { morning: { enabled: true, at: row.data.at } } : { evening: { enabled: true, at: row.data.at } })
        note(row, true)
      }
      catch (error) { note(row, false, errorText(error)) }
    }
    const quietRow = rows.find(one => one.data.kind === 'quiet')
    if (quietRow !== undefined && quietRow.data.kind === 'quiet' && options.quiet !== undefined) {
      try { await options.quiet.setConfig({ quiet_from: quietRow.data.from, quiet_to: quietRow.data.to }); note(quietRow, true) }
      catch (error) { note(quietRow, false, errorText(error)) }
    }
    const feedRow = rows.find(one => one.data.kind === 'feed')
    if (feedRow !== undefined && feedRow.data.kind === 'feed' && options.feed !== undefined) {
      try {
        const current = options.feed.config()
        const want = feedRow.data.interests.map(one => ({ ...one, id: idForPath(one.project, one.name) }))
        const interests = current.interests.map((have) => {
          const hit = want.find(one => one.id === have.project_id || one.name === have.project_name)
          return hit === undefined ? have : { ...have, project_name: hit.name, keywords: [...hit.keywords] }
        })
        for (const one of want) {
          if (one.id !== undefined && !interests.some(have => have.project_id === one.id)) interests.push({ project_id: one.id, project_name: one.name, keywords: [...one.keywords] })
        }
        await options.feed.setConfig({ interests, ...(feedRow.data.podcast ? { podcast: true } : {}) })
        note(feedRow, true)
      }
      catch (error) { note(feedRow, false, errorText(error)) }
    }

    // ④ 窗口槽(卡 C):真拉;拉进来的才说「摆好了」。
    const slotRow = rows.find(one => one.data.kind === 'slot')
    if (slotRow !== undefined && options.dock?.claimEnabled !== undefined) {
      try {
        const report = await options.dock.claimEnabled()
        const claimed = (report.claimed ?? report.results.filter(one => one.state === 'claimed' || one.state === 'already')).map(one => one.label)
        const pending = (report.pending ?? report.results.filter(one => one.state !== 'claimed' && one.state !== 'already'))
        note(slotRow, pending.length === 0, [
          claimed.length === 0 ? '' : `${claimed.join('、')} 摆好了`,
          pending.length === 0 ? '' : `${pending.map(one => one.label).join('、')} 标签上写「点一下拉进来」`,
        ].filter(one => one !== '').join(';'))
      }
      catch (error) { note(slotRow, false, errorText(error)) }
    }

    // ⑤ 补拷记忆
    const memoryRow = rows.find(one => one.data.kind === 'memories')
    if (memoryRow !== undefined && options.memories !== undefined) {
      try { const got = await options.memories.importNow(); note(memoryRow, got.ok, got.note) }
      catch (error) { note(memoryRow, false, errorText(error)) }
    }

    // ⑥ 撤掉:改「取消」,不删。已经「完成」的那几条按看板规矩先重开再取消(done → doing → canceled)。
    for (const row of rows.filter(one => one.data.kind === 'cancel')) {
      if (row.data.kind !== 'cancel' || tasks === undefined) continue
      try {
        board = await tasks.list()
        const task = board.tasks.find(one => one.id === (row.data as { task_id: string }).task_id)
        if (task === undefined) { note(row, true, '看板上已经没有这条了'); continue }
        if (task.status === 'canceled') { note(row, true, '已经是取消'); continue }
        if (task.status === 'done') {
          const reopened = await tasks.move(task.id, 'doing')
          if (!reopened.ok) throw new Error(reopened.reason ?? '重开没成')
        }
        const moved = await tasks.move(task.id, 'canceled')
        if (!moved.ok) throw new Error(moved.reason ?? '改成取消没成')
        note(row, true)
      }
      catch (error) { note(row, false, errorText(error)) }
    }

    // ⑥′ 派活分工进规矩表(卡 O)。放在派第一件之前:第一件派出去时就照这条挑手。
    const divisionRow = rows.find(one => one.data.kind === 'division')
    if (divisionRow !== undefined && divisionRow.data.kind === 'division' && options.rules !== undefined) {
      try {
        const adopted = await options.rules.adoptDivision({ text: divisionRow.data.text, said: divisionRow.data.said })
        note(divisionRow, adopted.ok, adopted.note)
      }
      catch (error) { note(divisionRow, false, errorText(error)) }
    }

    // ⑦ 第一件:现有派活链路(给这张卡开一条事务官会话,点名那一家)。
    let dispatch: MaterializeApplyResult['dispatch']
    const dispatchRow = rows.find(one => one.data.kind === 'dispatch')
    if (dispatchRow !== undefined && dispatchRow.data.kind === 'dispatch' && options.dispatch !== undefined && tasks !== undefined) {
      const data = dispatchRow.data
      const cardRow = plan.rows.find(one => one.key === data.topic_key)
      const title = cardRow?.title ?? ''
      board = await tasks.list()
      const taskId = taskIds.get(data.topic_key) ?? state.created[data.topic_key]?.task_id
        ?? board.tasks.find(task => task.status !== 'canceled' && titleSimilarity(task.title, title) >= 0.95)?.id
      const task = taskId === undefined ? undefined : board.tasks.find(one => one.id === taskId)
      if (task === undefined) {
        dispatch = { task_id: '', ok: false, note: '卡没建成,没法派' }
        note(dispatchRow, false, dispatch.note)
      }
      else if (task.conversation !== undefined || task.dispatch !== undefined) {
        dispatch = { task_id: task.id, ok: true, note: '已经派过了', ...(task.conversation === undefined ? {} : { session_id: task.conversation.session_id }) }
        note(dispatchRow, true, dispatch.note)
      }
      else {
        try {
          const sent = await options.dispatch({ taskId: task.id, owner: data.owner, text: data.text, agentText: data.agent_text })
          dispatch = { task_id: task.id, ok: sent.ok, ...(sent.session_id === undefined ? {} : { session_id: sent.session_id }), ...(sent.note === undefined ? {} : { note: sent.note }) }
          note(dispatchRow, sent.ok, sent.note)
        }
        catch (error) {
          dispatch = { task_id: task.id, ok: false, note: errorText(error) }
          note(dispatchRow, false, dispatch.note)
        }
      }
    }

    try { await options.onApplied?.({ ...(background === undefined ? {} : { background }), rows: out.filter(one => one.ok).map(one => one.key) }) }
    catch { /* 项目文件写不上不挡落地;回执照旧 */ }

    const failed = out.filter(one => !one.ok)
    return {
      ok: failed.length === 0,
      line: resultLine(out, dispatch, dispatchRow),
      rows: out,
      ...(dispatch === undefined ? {} : { dispatch }),
    }
  }

  return {
    async load() {
      try {
        const parsed = JSON.parse(await readFile(options.file, 'utf8')) as MaterializeFile
        if (parsed?.version === 1) state = { ...emptyFile(), ...parsed }
      }
      catch { state = emptyFile() }
    },

    preview(input) {
      return enqueue(() => preview(input)).catch(error => ({ ok: false as const, status: 500 as const, error: errorText(error) }))
    },

    apply(input) {
      return enqueue(() => apply(input))
    },

    view() {
      const plan = currentPlan()
      if (plan === undefined) return undefined
      const done = appliedOf(plan.id)
      return {
        id: plan.id,
        status: applying ? 'applying' : done === undefined ? 'pending' : 'applied',
        line: plan.line,
        source: plan.source,
        counts: plan.counts,
        groups: plan.groups,
        rows: plan.rows.map(stripData),
        created_at: plan.created_at,
        ...(done === undefined ? {} : { applied_at: done.at, result: done.result }),
      }
    },

    brief() {
      const plan = currentPlan()
      if (plan === undefined) return { pending: false }
      const done = appliedOf(plan.id)
      return done === undefined ? { pending: true, id: plan.id, line: plan.line } : { pending: false, id: plan.id, applied: true }
    },

    warm() {
      if (warming !== undefined || options.extract === undefined) return
      warming = enqueue(async () => {
        const archive = await options.readArchive()
        if (archive === undefined || archivedAnswersEmpty(archive)) return
        const before = Object.keys(state.model).length
        await modelPart(archive, localDate(now()))
        if (Object.keys(state.model).length !== before) await save()
      }).catch(() => undefined).finally(() => { warming = undefined })
    },
  }
}

function archivedAnswersEmpty(archive: MaterializeArchive): boolean {
  const project = archive.answers.projects?.project
  const idea = archive.answers.projects?.idea
  return (project === undefined || project === null || Object.keys(project as object).length === 0) && idea === undefined
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message.split('\n')[0] ?? '出错了' : String(error)
}

/**
 * 落完那一句(电话里 / 屏幕上)。**说到做到**:派出去了才说「派出去了」;有几样没成就照实说是哪几样。
 */
export function resultLine(
  rows: readonly { title: string, ok: boolean, note?: string, key: string }[],
  dispatch: MaterializeApplyResult['dispatch'],
  dispatchRow: MaterializeRow | undefined,
): string {
  const failed = rows.filter(one => !one.ok && !one.key.startsWith('dispatch'))
  const who = dispatchRow?.data.kind === 'dispatch' ? dispatchRow.title.split(' → ')[1] ?? '' : ''
  const head = dispatch === undefined
    ? '摆好了。'
    : dispatch.ok ? '派出去了,做完叫你。' : `摆好了;交给 ${who} 的那件没派出去${dispatch.note === undefined ? '' : `:${dispatch.note}`}。`
  if (failed.length === 0) return head
  return `${head}有 ${failed.length} 样没落上,屏幕上写着是哪几样。`
}

// ———————————————————————— 给已有的卡派活(现有链路) ————————————————————————

/**
 * 给**已经建好**的卡派活:和手机 `wb_dispatch_item`(POST /butler/item)同一件事,只是不新建卡 ——
 * 落负责人 → 开一条事务官会话(第一条消息 `butlerFirstMessage`,点了名就带「按『派活给别家Agent』那一节办」)→
 * 开成了挂上会话、挪到「进行中」;开不成如实标「会话未开」。**这里不起任何子进程**:派活是事务官在它那条会话里做的
 * (同 http.ts `createButlerItem` 那条纪律);怎么送进 Codex、送不进指定会话怎么办,由它照技能段办(卡 F 管那条链)。
 */
export async function dispatchExistingItem(
  deps: {
    tasks: { update: (id: string, input: Record<string, unknown>) => Promise<boolean>, move: (id: string, status: TaskStatus) => Promise<{ ok: boolean, reason?: string }> }
    opener: { open: (message: string, extras?: { effort?: ButlerEffort }) => Promise<string | undefined> } | undefined
  },
  input: { taskId: string, owner: CardOwner, text: string },
): Promise<{ ok: boolean, note?: string, session_id?: string }> {
  const assignee = input.owner === 'codex' || input.owner === 'claude' || input.owner === 'kimi' ? input.owner : undefined
  if (assignee === undefined) return { ok: false, note: '不是交给 Agent 的事,不派' }
  await deps.tasks.update(input.taskId, { assignee })
  let sessionId: string | undefined
  // 思考档(2026-09-28 卡 BS):这条路上 assignee 一定有值 = 她点了名,照名单派,不用挑 → 关。
  try { sessionId = await deps.opener?.open(butlerFirstMessage(input.text, input.taskId, assignee), { effort: effortFor('dispatchNamed') }) }
  catch { sessionId = undefined }
  if (sessionId === undefined || sessionId === '') {
    await deps.tasks.update(input.taskId, { note: BUTLER_NO_SESSION_NOTE })
    return { ok: false, note: deps.opener === undefined ? '这台工作台没接事务官会话' : '事务官那条会话没开起来' }
  }
  await deps.tasks.update(input.taskId, { conversation: butlerConversation(sessionId), links: [{ agent: 'dsh', session_id: sessionId }] })
  await deps.tasks.move(input.taskId, 'doing')
  return { ok: true, session_id: sessionId, note: '交给事务官去派了' }
}
