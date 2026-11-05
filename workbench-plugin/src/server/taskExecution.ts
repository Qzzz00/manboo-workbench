/**
 * ★ **唯一的执行身份与恢复记录**(2026-10-29,可靠执行闭环第一批第 1 步;
 * 任务书 `docs/交接-1029-可靠执行第一批-步骤1-执行身份与恢复记录.md`)。
 *
 * 一件委托一个 {@link ExecutionRecord}:阶段 + 下一动作 + 版本。所有「下一步该谁做」由它回答;
 * `jobLog` 只记历史,不当恢复账(满了 `JOB_LOG_MAX` 会裁,恢复依据永远在这张记录上)。
 *
 * 本模块是**纯函数**:不 import HTTP、React、fs。唯一推进职责的入口,第 2、3 步的入口与派发
 * 只往这里提交命令与事实(`reduceExecution`),由它决定下一动作。
 *
 * 规则(任务书钉的):
 * - 迟到的回执(`attemptId` 或 `planVersion` 不是当前的)**原样忽略**,返回旧记录。
 * - `returned` → `verifying` + next `verify`(交回 ≠ 交付,不能直接 delivered)。
 * - `verification_missing` → `recovering` + next `recover`,reason 原样带。
 * - `cancel_requested` → 旧计划不再出新动作:`canceled` + next `null`(方案第三节 3:
 *   「先让旧计划不能继续派新动作」;终态吸收一切迟到事实,迟到的旧版本 cancel 忽略)。
 * - `next = null` **只**允许出现在 `delivered` / `canceled`({@link TERMINAL_PHASES})。
 * - 结果不明一律带 `reconcile` 动作({@link restoreExecution}:重启接回时先对账,不盲重发)。
 * - 等待本人带 `ask` 且 reason 写清决定对象({@link waitUserExecution})。
 */

/** 一件委托推进到哪一阶段。`delivered` / `canceled` 是终态:不再出任何新动作。 */
export type ExecutionPhase =
  | 'ready' | 'dispatching' | 'running' | 'reconciling'
  | 'verifying' | 'recovering' | 'waiting_user' | 'delivered' | 'canceled'

export const EXECUTION_PHASES: readonly ExecutionPhase[] = [
  'ready', 'dispatching', 'running', 'reconciling',
  'verifying', 'recovering', 'waiting_user', 'delivered', 'canceled',
]

/** 终态:`next` 只允许在这两阶段为 `null`。 */
export const TERMINAL_PHASES: readonly ExecutionPhase[] = ['delivered', 'canceled']

export function isTerminalPhase(phase: ExecutionPhase): boolean {
  return (TERMINAL_PHASES as readonly string[]).includes(phase)
}

/** 下一动作。`reason` 是机器可读的判据原文(如 `missing_test_output`),不替用户编话。 */
export interface ExecutionAction {
  kind: 'dispatch' | 'observe' | 'reconcile' | 'verify' | 'recover' | 'ask'
  reason: string
  wakeAt: number | null
}

export const EXECUTION_ACTION_KINDS: readonly ExecutionAction['kind'][] = [
  'dispatch', 'observe', 'reconcile', 'verify', 'recover', 'ask',
]

/**
 * 一件委托的执行记录(挂在卡上一格,`protocol.ts` 的 `TaskView.execution`,
 * 由 `server/taskExecutionStore.ts` 独占写入)。
 *
 * 计划草案之外补齐的契约字段(第一批统一在这里定义,各消费方不自行解释):
 * - `requestId`:受理请求去重键(同一入口重复提交只受理一次,第 2 步接线用);
 * - `actionId`:当前/最近一个待办动作的身份(派出前持久保存,动作准备已落盘、是否发出不明时按它对账);
 * - `authorizationRef`:本次委托的确切授权引用(哪一句委托、哪一档权限);
 * - `origin`:执行来源(哪只手/哪家真在跑,与 {@link attemptId} 对应);
 * - `leaseRef`:执行租约关联(第 3 步 `executionLease.ts` 接入,旧执行退出按它核对);
 * - `artifactVersion` / `verifiedVersion`:产物 / 验收版本(第 4 步核验交付接入)。
 *
 * 第 3 步(派发口)补齐的三格:
 * - `candidates`:本次委托许可的候选表(实际能力 ∩ 委托许可;换手只在这张表里进行);
 * - `attempts`:每只手的痕迹(派出准备 / 接单 / 起跑失败 / 结果不明),换手与重启恢复都照它,不凭内存;
 * - `dispatchRequest`:重派要用的原交代(机器可读的最小格),重启后从记录接上,不让她重新交代。
 */
export interface ExecutionRecord {
  taskId: string
  /** 记录自身版本,每次有效变更 +1;`compareAndSet` 按它串行比较。 */
  version: number
  /** 计划版本。改方向 / 取消产生新版本,旧版本的一切事实自动失效。 */
  planVersion: number
  /** 当前这一次执行的身份;还没派出过 = null。 */
  attemptId: string | null
  phase: ExecutionPhase
  next: ExecutionAction | null
  requestId?: string
  actionId?: string
  authorizationRef?: string
  origin?: string
  leaseRef?: string
  artifactVersion?: string
  verifiedVersion?: number
  /** 本次委托许可的候选家表(派发口换手只在其中进行;严格点名时只有一家)。 */
  candidates?: readonly string[]
  /** 每只手的痕迹,顺序即经过顺序(重启恢复与换手判据都看它)。 */
  attempts?: readonly ExecutionAttemptTrace[]
  /** 重派用的原交代(最小格):重启接续 / 换手同卡重派照它,不凭内存。 */
  dispatchRequest?: ExecutionDispatchRequest
}

/** 一只手的痕迹。`reason` 是机器可读或执行者原话(起跑失败 = 那一只没起跑的原因)。 */
export interface ExecutionAttemptTrace {
  attemptId: string
  family: string
  at: string
  outcome: 'prepared' | 'started' | 'startup-failed' | 'outcome-unclear'
  reason?: string
}

/** 重派用的原交代(挂在记录上一并持久,重启后照它接续)。 */
export interface ExecutionDispatchRequest {
  said: string
  cwd?: string
  kind?: string
  project?: string
  cwdFixed?: boolean
}

/** 提交给推进职责的一条执行事实。 */
export type ExecutionFact =
  | { kind: 'started'; attemptId: string; planVersion: number; origin?: string; at?: string }
  | { kind: 'returned'; attemptId: string; planVersion: number; receiptId: string }
  | { kind: 'verification_missing'; attemptId: string; planVersion: number; reason: string }
  | { kind: 'cancel_requested'; planVersion: number }
  /**
   * ★ 第 3 步(派发口)新事实:
   * - `dispatch_prepared`:派出前持久化(attemptId + 候选表 + 授权引用 + 原交代)——写不上就不许起子进程;
   * - `attempt_failed`:那一只**没起跑就退**(进程没起来 / 一出即退),原因原样带,换手照候选表;
   * - `outcome_unclear`:发了收不到确认 / 重启后进程号没了 —— 结果不明,不开第二作者,留 reconcile。
   */
  | { kind: 'dispatch_prepared'; attemptId: string; planVersion: number; at: string; family: string; candidates?: readonly string[]; authorizationRef?: string; request?: ExecutionDispatchRequest }
  | { kind: 'attempt_failed'; attemptId: string; planVersion: number; family: string; reason: string; at: string }
  | { kind: 'outcome_unclear'; attemptId: string; planVersion: number; reason: string; at: string }
  /**
   * ★ 第 4 步(核验交付)新事实:
   * - `verification_passed`:卡上条件逐条核过(含用户层热装那一道程序检查)→ `delivered` 终态
   *   (只有目标组件已加载并验证过才许记交付;`artifactVersion` 记产物版本);
   * - `verification_failed`:明确不过 → `recovering` + `recover`(退修/补证据由恢复接着推,`wakeAt`  bounded);
   * - `verification_unknown`:核不了(模型不在场 / 代跑超时 / 热装还没好)→ 仍 `verifying` + `verify`
   *   带 `wakeAt`,定时再核,不整张卡停在 unknown 推给人;
   * - `settled_by_human`:本人明说「按通过 / 直接结掉」(中枢 move_status done)= 人已判通过,
   *   记录直接终态(不再核验、重启也不再翻出来核)。
   */
  | { kind: 'verification_passed'; attemptId: string; planVersion: number; artifactVersion?: string }
  | { kind: 'verification_failed'; attemptId: string; planVersion: number; reason: string; wakeAt?: number | null }
  | { kind: 'verification_unknown'; attemptId: string; planVersion: number; reason: string; wakeAt?: number | null }
  | { kind: 'settled_by_human'; planVersion: number }

function isCurrent(record: ExecutionRecord, fact: { attemptId: string, planVersion: number }): boolean {
  return fact.planVersion === record.planVersion && fact.attemptId === record.attemptId
}

/**
 * 唯一的事实裁决处。每次有效变更 `version + 1`;被忽略的事实返回**原记录**(引用相等)。
 */
export function reduceExecution(record: ExecutionRecord, fact: ExecutionFact): ExecutionRecord {
  // 终态不再出任何新动作:取消 / 交付之后的一切迟到事实(含同版本回执)原样吸收。
  if (isTerminalPhase(record.phase)) return record
  const next = (change: Omit<ExecutionRecord, 'version'>): ExecutionRecord => ({ ...change, version: record.version + 1 })
  switch (fact.kind) {
    case 'dispatch_prepared': {
      // 派出前持久化:只有当前计划的那一下才算数(迟到的旧计划准备原样忽略)。
      if (fact.planVersion !== record.planVersion) return record
      const trace: ExecutionAttemptTrace = { attemptId: fact.attemptId, family: fact.family, at: fact.at, outcome: 'prepared' }
      return next({
        ...record, attemptId: fact.attemptId, phase: 'dispatching',
        next: { kind: 'dispatch', reason: 'await_accept', wakeAt: null },
        ...(fact.candidates === undefined ? {} : { candidates: [...fact.candidates] }),
        ...(fact.authorizationRef === undefined ? {} : { authorizationRef: fact.authorizationRef }),
        ...(fact.request === undefined ? {} : { dispatchRequest: { ...fact.request } }),
        attempts: [...(record.attempts ?? []), trace],
      })
    }
    case 'started':
      // 迟到的旧计划起跑原样忽略;同计划的新 attempt 接单 → 在跑,进入观察。
      if (fact.planVersion !== record.planVersion) return record
      return next({
        ...record, attemptId: fact.attemptId, phase: 'running',
        ...(fact.origin === undefined ? {} : { origin: fact.origin }),
        next: { kind: 'observe', reason: 'await_result', wakeAt: null },
        attempts: [...(record.attempts ?? []), { attemptId: fact.attemptId, family: fact.origin ?? '', at: fact.at ?? '', outcome: 'started' }],
      })
    case 'attempt_failed': {
      // 那一只没起跑就退:痕迹落进记录(换手 / 重启恢复照它),执行回到「待派出下一只」。
      // 不是当前 attempt 的迟到失败原样忽略(旧轮次摘不动新轮)。
      if (!isCurrent(record, fact)) return record
      return next({
        ...record, attemptId: null, phase: 'dispatching',
        next: { kind: 'dispatch', reason: 'handoff_after_startup_failure', wakeAt: null },
        attempts: [...(record.attempts ?? []), { attemptId: fact.attemptId, family: fact.family, at: fact.at, outcome: 'startup-failed', reason: fact.reason }],
      })
    }
    case 'outcome_unclear': {
      // 发了收不到确认 / 进程号没了:结果不明 —— 不开第二作者,留 reconcile 先对账。
      if (!isCurrent(record, fact)) return record
      return next({
        ...record, phase: 'reconciling',
        next: { kind: 'reconcile', reason: fact.reason, wakeAt: null },
        attempts: [...(record.attempts ?? []), { attemptId: fact.attemptId, family: record.origin ?? '', at: fact.at, outcome: 'outcome-unclear', reason: fact.reason }],
      })
    }
    case 'returned':
      // 迟到的回执(attemptId 或 planVersion 不是当前的)原样忽略 —— 旧回执不串到新任务。
      if (!isCurrent(record, fact)) return record
      // 交回 ≠ 交付:进入核验,由 verify 动作决定下一步。
      return next({ ...record, phase: 'verifying', next: { kind: 'verify', reason: 'receipt_returned', wakeAt: null } })
    case 'verification_missing':
      if (!isCurrent(record, fact)) return record
      // 缺证据留在系统侧补证据 / 恢复,reason 原样带。
      return next({ ...record, phase: 'recovering', next: { kind: 'recover', reason: fact.reason, wakeAt: null } })
    case 'cancel_requested':
      // 只认当前计划的叫停:旧计划不再出新动作(canceled + next null)。
      if (fact.planVersion !== record.planVersion) return record
      return next({ ...record, phase: 'canceled', next: null })
    case 'verification_passed':
      // 逐条核过(含用户层热装那一道程序检查)→ 交付终态。`verifiedVersion` 记核过的那一版记录。
      if (!isCurrent(record, fact)) return record
      return next({
        ...record, phase: 'delivered', next: null,
        verifiedVersion: record.version + 1,
        ...(fact.artifactVersion === undefined ? {} : { artifactVersion: fact.artifactVersion }),
      })
    case 'verification_failed':
      // 明确不过 → 退修 / 补证据由恢复接着推(reason 原样带),wakeAt 由裁决方给有界重试。
      if (!isCurrent(record, fact)) return record
      return next({
        ...record, phase: 'recovering',
        next: { kind: 'recover', reason: fact.reason, wakeAt: fact.wakeAt ?? null },
      })
    case 'verification_unknown':
      // 核不了 → 仍待核,带 wakeAt 定时再核(模型不在场 / 代跑超时 / 热装还没好都不推人)。
      if (!isCurrent(record, fact)) return record
      return next({
        ...record, phase: 'verifying',
        next: { kind: 'verify', reason: fact.reason, wakeAt: fact.wakeAt ?? null },
      })
    case 'settled_by_human':
      // 本人明说按通过结掉 = 人已判通过:直接终态,迟到的核验事实此后一律吸收。
      return next({ ...record, phase: 'delivered', next: null, verifiedVersion: record.version + 1 })
  }
}

/** 新委托的初始记录:ready,等待第一次派出。`expectedVersion = 0` 的比较写入即建记录。 */
export function newExecutionRecord(taskId: string, planVersion = 1): ExecutionRecord {
  return { taskId, version: 1, planVersion, attemptId: null, phase: 'ready', next: { kind: 'dispatch', reason: 'await_dispatch', wakeAt: null } }
}

/**
 * ★ **结果不明一律带 reconcile**(重启接回 / 读到残缺记录时用):非终态而 `next` 缺失或
 * 形状不对的,投影成 `reconciling` + `reconcile` —— 先对账,不盲重发。
 * 纯投影,不改 `version`(盘上那条还是原版本,`compareAndSet` 照它比)。
 */
export function restoreExecution(record: ExecutionRecord): ExecutionRecord {
  if (isTerminalPhase(record.phase)) return record
  const next = record.next
  const usable = next !== null
    && EXECUTION_ACTION_KINDS.includes(next.kind)
    && typeof next.reason === 'string' && next.reason !== ''
    && (next.wakeAt === null || (typeof next.wakeAt === 'number' && Number.isFinite(next.wakeAt)))
  if (usable) return record
  return { ...record, phase: 'reconciling', next: { kind: 'reconcile', reason: 'unknown_outcome', wakeAt: null } }
}

/** 等待本人决定:`waiting_user` + `ask`,reason = 决定对象(机器可读,写清缺他哪一句)。 */
export function waitUserExecution(record: ExecutionRecord, decision: string): ExecutionRecord {
  if (isTerminalPhase(record.phase)) return record
  return { ...record, version: record.version + 1, phase: 'waiting_user', next: { kind: 'ask', reason: decision, wakeAt: null } }
}

/** 读盘时的体检:认不出的记录当没有(同 `sanitizeTask` 各可选字段的取舍,卡本身留着)。 */
export function sanitizeExecutionRecord(value: unknown): ExecutionRecord | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const raw = value as Record<string, unknown>
  if (typeof raw.taskId !== 'string' || raw.taskId === '') return undefined
  if (typeof raw.version !== 'number' || !Number.isInteger(raw.version) || raw.version < 0) return undefined
  if (typeof raw.planVersion !== 'number' || !Number.isInteger(raw.planVersion) || raw.planVersion < 1) return undefined
  if (!(EXECUTION_PHASES as readonly string[]).includes(String(raw.phase))) return undefined
  if (raw.attemptId !== null && typeof raw.attemptId !== 'string') return undefined
  const optional = (key: 'requestId' | 'actionId' | 'authorizationRef' | 'origin' | 'leaseRef' | 'artifactVersion'): Record<string, string> =>
    typeof raw[key] === 'string' && raw[key] !== '' ? { [key]: raw[key] as string } : {}
  const next = sanitizeExecutionAction(raw.next)
  if (raw.next !== null && next === undefined) return undefined
  const candidates = Array.isArray(raw.candidates)
    ? raw.candidates.filter((one): one is string => typeof one === 'string' && one !== '')
    : undefined
  const attempts = Array.isArray(raw.attempts)
    ? raw.attempts.map(sanitizeAttemptTrace).filter((one): one is ExecutionAttemptTrace => one !== undefined)
    : undefined
  const request = sanitizeDispatchRequest(raw.dispatchRequest)
  return {
    taskId: raw.taskId,
    version: raw.version,
    planVersion: raw.planVersion,
    attemptId: raw.attemptId,
    phase: raw.phase as ExecutionPhase,
    ...(next === undefined ? { next: null } : { next }),
    ...optional('requestId'),
    ...optional('actionId'),
    ...optional('authorizationRef'),
    ...optional('origin'),
    ...optional('leaseRef'),
    ...optional('artifactVersion'),
    ...(typeof raw.verifiedVersion === 'number' && Number.isInteger(raw.verifiedVersion) && raw.verifiedVersion >= 0
      ? { verifiedVersion: raw.verifiedVersion }
      : {}),
    ...(candidates === undefined || candidates.length === 0 ? {} : { candidates }),
    ...(attempts === undefined || attempts.length === 0 ? {} : { attempts }),
    ...(request === undefined ? {} : { dispatchRequest: request }),
  }
}

function sanitizeAttemptTrace(value: unknown): ExecutionAttemptTrace | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const raw = value as Record<string, unknown>
  if (typeof raw.attemptId !== 'string' || typeof raw.family !== 'string' || typeof raw.at !== 'string') return undefined
  if (!['prepared', 'started', 'startup-failed', 'outcome-unclear'].includes(String(raw.outcome))) return undefined
  return {
    attemptId: raw.attemptId, family: raw.family, at: raw.at, outcome: raw.outcome as ExecutionAttemptTrace['outcome'],
    ...(typeof raw.reason === 'string' && raw.reason !== '' ? { reason: raw.reason } : {}),
  }
}

function sanitizeDispatchRequest(value: unknown): ExecutionDispatchRequest | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const raw = value as Record<string, unknown>
  if (typeof raw.said !== 'string' || raw.said === '') return undefined
  return {
    said: raw.said,
    ...(typeof raw.cwd === 'string' && raw.cwd !== '' ? { cwd: raw.cwd } : {}),
    ...(typeof raw.kind === 'string' && raw.kind !== '' ? { kind: raw.kind } : {}),
    ...(typeof raw.project === 'string' && raw.project !== '' ? { project: raw.project } : {}),
    ...(raw.cwdFixed === true ? { cwdFixed: true } : {}),
  }
}

function sanitizeExecutionAction(value: unknown): ExecutionAction | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const raw = value as Record<string, unknown>
  if (!(EXECUTION_ACTION_KINDS as readonly string[]).includes(String(raw.kind))) return undefined
  if (typeof raw.reason !== 'string' || raw.reason === '') return undefined
  if (raw.wakeAt !== null && (typeof raw.wakeAt !== 'number' || !Number.isFinite(raw.wakeAt))) return undefined
  return { kind: raw.kind as ExecutionAction['kind'], reason: raw.reason, wakeAt: raw.wakeAt }
}

/** {@link importExecutionRecord} 只看这几格旧字段,结构故意取松(不 import protocol,保持纯函数)。 */
export interface ExecutionImportSource {
  id: string
  status?: string
  dispatch?: unknown
  client_dispatch?: unknown
  receipt?: unknown
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null ? value as Record<string, unknown> : undefined
}

/**
 * ★ **旧卡导入**(任务书第 3 条):老卡没有执行记录时,从可验证的旧字段
 * (`dispatch` / `client_dispatch` / `receipt`)导入;导不出确定阶段的记为 `reconciling`
 * (待对账),**不直接重派**。
 *
 * 判据(我定的,按「可撤回的那种」):
 * - 卡已 `canceled` / `done` → 终态(`canceled` / `delivered`),不再列未完成。
 * - 有回执(`receipt`)→ `verifying` + `verify`(有交回来的东西待核)。
 * - `dispatch` 有 `ended_at` → `verifying` + `verify`;没结束 → 结果不明,`reconciling` + `reconcile`。
 * - `client_dispatch` 回答已收回(`reply_state === 'done'`)→ `verifying` + `verify`;否则 `reconciling`。
 * - 一格可验证的执行痕迹都没有 → `undefined`(它不是一条执行过的委托,不列进未完成)。
 */
export function importExecutionRecord(source: ExecutionImportSource): ExecutionRecord | undefined {
  const base = { taskId: source.id, version: 1, planVersion: 1, attemptId: null }
  if (source.status === 'canceled') return { ...base, phase: 'canceled', next: null }
  if (source.status === 'done') return { ...base, phase: 'delivered', next: null }
  if (source.receipt !== undefined && source.receipt !== null) {
    return { ...base, phase: 'verifying', next: { kind: 'verify', reason: 'legacy_receipt', wakeAt: null } }
  }
  const dispatch = asRecord(source.dispatch)
  if (dispatch !== undefined) {
    if (typeof dispatch.ended_at === 'string' && dispatch.ended_at !== '') {
      return { ...base, phase: 'verifying', next: { kind: 'verify', reason: 'legacy_dispatch_ended', wakeAt: null } }
    }
    return { ...base, phase: 'reconciling', next: { kind: 'reconcile', reason: 'legacy_dispatch_open', wakeAt: null } }
  }
  const clientDispatch = asRecord(source.client_dispatch)
  if (clientDispatch !== undefined) {
    if (clientDispatch.reply_state === 'done') {
      return { ...base, phase: 'verifying', next: { kind: 'verify', reason: 'legacy_reply_returned', wakeAt: null } }
    }
    return { ...base, phase: 'reconciling', next: { kind: 'reconcile', reason: 'legacy_client_dispatch_open', wakeAt: null } }
  }
  return undefined
}

/**
 * ★ **换手只在候选表里进行**(第 3 步,派发口):候选 = 实际能力 ∩ 本次委托许可,
 * 模型已在其中挑过;派发口只兜底 —— 从候选里找第一只**没试过**的。严格点名时候选只有一家,
 * 这里自然回 undefined(不换,由 {@link waitUserExecution} 等本人)。
 */
export function handoffCandidate(record: Pick<ExecutionRecord, 'candidates'>, exclude: readonly string[]): string | undefined {
  return (record.candidates ?? []).find(one => !exclude.includes(one))
}
