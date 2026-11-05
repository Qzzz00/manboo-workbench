/**
 * ★ **核验、缺证据、退修与交付的推进职责**(2026-10-29,可靠执行闭环第一批第 4 步;
 * 任务书 `docs/交接-1029-可靠执行第一批-步骤4-核验缺证据退修与交付.md`)。
 *
 * `http.ts` 里 `verifyDelivered` / `settleVerify` 的职责迁入这里:**凡交回都核** —— CLI / 窗口 /
 * 接口 / 事务官自办,进「等你确认」且有回执就进核验(执行者自称做完不等于交付);缺验收从委托提取
 * 默认条件写卡再核,不推人;核不了记待核、带 wakeAt 定时再核;明确不过退修,重派被闸挡下卡回
 * 「等你确认」,执行记录 `next = recover` 由这里接着推;用户层产物热装 ok 才记「交付」。
 *
 * 判法本体是 `dispatchVerify.verifyAcceptance`(一次模型结构化调用 + 程序按产物核),这里只管推进:
 * 守门(状态 / 拍板请求 / 去重 / 在飞)、提取默认条件、提交 {@link reduceExecution} 事实、
 * 退修重派与换手、定时再核与重启接续({@link TaskDelivery.resume})。不 import HTTP / React;
 * IO 全部走注入的 dep(与 `taskExecution.ts` 纯函数 + `taskExecutionStore.ts` 同一套纪律)。
 */
import { ownerAskOf, type TaskView } from '../protocol.ts'
import { reduceExecution, waitUserExecution, type ExecutionFact, type ExecutionRecord } from './taskExecution.ts'
import type { ExecutionStore } from './taskExecutionStore.ts'
import {
  USER_LAYER_DEFAULT_ACCEPTANCE,
  parseExtractedAcceptance,
  reworkResendNote,
  reworkTextOf,
  verifyAcceptance,
  verifyUnknownNote,
  VERIFY_GIVE_UP,
  VERIFY_NO_ACCEPTANCE,
  VERIFY_PASS_NOTE,
  type ArtifactCheckDeps,
  type DispatchVerdict,
} from './dispatchVerify.ts'

/** 「人判通过」那一句:她明说「按通过 / 算通过 / 直接结掉」= 人已判通过,不是再核验一遍。 */
export const HUMAN_PASS_NOTE = '人判通过:按你说的结掉了,没再走核验。'

/** 提交给推进模块的依赖(全部由 http 适配层注入;用例给替身)。 */
export interface TaskDeliveryDeps {
  /** 任务账(读卡 / 留言 / 挪状态 / 改验收)。 */
  tasks: {
    list: () => Promise<{ tasks: readonly TaskView[] }>
    comment: (id: string, input: { by: 'butler', text: string }) => Promise<unknown>
    move: (id: string, status: 'confirm' | 'doing' | 'done') => Promise<{ ok: boolean }>
    update: (id: string, patch: { acceptance?: readonly string[] }) => Promise<unknown>
  }
  /** 执行记录(第 1 步那张;缺席 = 老行为,只动卡不落记录)。 */
  execution?: ExecutionStore
  /** 交回核验那一次模型调用(VERIFY_SYSTEM;缺 key / 没接成回 undefined)。 */
  askVerify: (userText: string) => Promise<string | undefined>
  /** 缺验收时提取默认条件的模型调用(DEFAULT_ACCEPTANCE_EXTRACT_SYSTEM)。 */
  askExtract?: (input: { title: string, said: string, receipt: string }) => Promise<string | undefined>
  /** 产物核对(生产 createArtifactCheckDeps;用例替身拖时间)。 */
  artifacts?: ArtifactCheckDeps
  /** 退修重派那一下(派发口同一只);ok = 派成了(卡自行挪「进行中」);`repair` = 退修那一档(被挡不停卡)。 */
  dispatchRepair?: (taskId: string, input: { family: string, text: string, kind?: string, resume: boolean, repair: boolean }) => Promise<{ ok: boolean, note?: string, block?: { alternatives?: readonly { family: string, title: string }[] } }>
  /** 那一家叫什么(换手留言用)。 */
  targetTitle?: (family: string) => string
  /** 用户层任务判定(dispatch.cwdFixed 且钉在用户层目录)。 */
  isUserLayerTask?: (task: TaskView) => boolean
  /**
   * 用户层「交付就绪」程序检查:目标那一格热装 ok + 原件 / 本体没动 + 交回点名了改的文件。
   * `{ok:true}` 才许记交付;`{ok:false, why}` = 压着不交付、定时再核;`{ok:undefined}` = 用户层
   * 服务这会儿不在,按不过处理(不冒称交付)。
   */
  userLayerDeliverable?: (task: TaskView, receipt: string) => Promise<{ ok: boolean | undefined, why?: string }>
  /** 状态变了广播一次(缺省不播)。 */
  onChanged?: () => void
  /** 现在时刻(wakeAt 用 epoch 秒;缺省真钟)。 */
  now?: () => number
  /** 定时器(缺省 setTimeout / clearTimeout)。 */
  setTimer?: (fn: () => void, ms: number) => unknown
  clearTimer?: (handle: unknown) => void
  /** 核不了 / 恢复重试的间隔(缺省 60s;用例调小)。 */
  retryMs?: number
}

export interface TaskDelivery {
  /**
   * 任一交回路口(CLI / 窗口 / 接口 / 事务官自办)挪进「等你确认」后调用。**立即返回**,
   * 核验异步跑(代跑可能 120s,不阻塞交回那条 HTTP);结果回写卡与执行记录。
   */
  onReturned: (taskId: string) => void
  /** 中枢 verify 命令的那只手:她点名要核,同步给判词(同一套 settle 判法)。 */
  verifyOnDemand: (taskId: string, acceptance: readonly string[]) => Promise<{ verdict: 'pass' | 'fail' | 'unknown', text: string }>
  /** 本人明说按通过结掉:记「人判通过」、执行记录终态,不再核验。 */
  humanSettled: (taskId: string) => Promise<void>
  /** 重启接续:待核(verify)与待恢复(recover)的记录接回来接着推;已收场的卡记录落终态。 */
  resume: () => Promise<void>
  /** 撤掉全部定时器(服务收尾)。 */
  close: () => void
}

export function createTaskDelivery(deps: TaskDeliveryDeps): TaskDelivery {
  const now = deps.now ?? (() => Math.floor(Date.now() / 1000))
  const setTimer = deps.setTimer ?? ((fn: () => void, ms: number) => setTimeout(fn, ms))
  const clearTimer = deps.clearTimer ?? ((handle: unknown) => clearTimeout(handle as ReturnType<typeof setTimeout>))
  const retryMs = deps.retryMs ?? 60_000
  /** 这一次交回的去重键(进程内;重启后由执行记录的 next 判「还该不该核」)。 */
  const verified = new Set<string>()
  /** 正在核验中的卡(同进程不并发核同一张卡)。 */
  const inFlight = new Set<string>()
  const timers = new Map<string, unknown>()

  const taskOf = async (taskId: string): Promise<TaskView | undefined> => {
    try { return (await deps.tasks.list()).tasks.find(one => one.id === taskId) }
    catch { return undefined }
  }
  /** 这次交回的回执原文:CLI / 接口在 dispatch.reply,窗口在 client_dispatch.reply,外部回执在 receipt。 */
  const receiptOf = (task: TaskView): string =>
    task.receipt?.text ?? task.dispatch?.reply ?? task.client_dispatch?.reply ?? ''
  const say = async (taskId: string, text: string): Promise<void> => { await deps.tasks.comment(taskId, { by: 'butler', text }).catch(() => undefined) }
  const changed = (): void => { deps.onChanged?.() }

  /** 提交一条事实(读 → reduce → CAS;迟到/终态由 reduceExecution 自己拒)。 */
  async function submitFact(taskId: string, fact: ExecutionFact): Promise<ExecutionRecord | undefined> {
    if (deps.execution === undefined) return undefined
    try {
      const current = await deps.execution.read(taskId)
      if (current === undefined) return undefined
      const reduced = reduceExecution(current, fact)
      if (reduced === current) return current
      if (!await deps.execution.compareAndSet(taskId, current.version, reduced)) return current
      return reduced
    }
    catch { return undefined }
  }

  const currentFact = (task: TaskView): { attemptId: string, planVersion: number } => ({
    attemptId: task.execution?.attemptId ?? task.dispatch?.session_id ?? '',
    planVersion: task.round ?? 1,
  })

  function schedule(kind: 'verify' | 'recover', taskId: string, ms: number): void {
    const prior = timers.get(taskId)
    if (prior !== undefined) clearTimer(prior)
    timers.set(taskId, setTimer(() => {
      timers.delete(taskId)
      if (kind === 'verify') void runVerify(taskId, 'retry').catch(() => undefined)
      else void runRecover(taskId).catch(() => undefined)
    }, ms))
  }

  /** 缺验收:用户层按固定三句;其余委托由模型从原话提取(写明「由委托提取」)。 */
  async function ensureAcceptance(task: TaskView, receipt: string): Promise<readonly string[] | 'asked' | 'pending'> {
    const onCard = task.acceptance ?? []
    if (onCard.length > 0) return onCard
    const taskId = task.id
    if (deps.isUserLayerTask?.(task) === true) {
      const lines = USER_LAYER_DEFAULT_ACCEPTANCE
      await say(taskId, `事务官核验:卡上没写验收条件,按用户层默认三条核(由委托提取):${lines.map((one, i) => `${i + 1}. ${one}`).join(';')}。`)
      await deps.tasks.update(taskId, { acceptance: lines }).catch(() => undefined)
      return lines
    }
    const raw = deps.askExtract === undefined ? undefined : await deps.askExtract({ title: task.title, said: task.desc ?? task.title, receipt }).catch(() => undefined)
    const parsed = parseExtractedAcceptance(raw)
    if (parsed === undefined || ('acceptance' in parsed && parsed.acceptance.length === 0)) {
      await say(taskId, VERIFY_NO_ACCEPTANCE)
      const fact = currentFact(task)
      await submitFact(taskId, { kind: 'verification_unknown', ...fact, reason: 'missing_acceptance', wakeAt: now() + retryMs })
      schedule('verify', taskId, retryMs)
      return 'pending'
    }
    if ('question' in parsed) {
      // 真有目标歧义才问一句(模型自己的问);卡留「等你确认」,记录挂 ask。
      await say(taskId, `事务官核验:目标有一句拿不准 —— ${parsed.question}(答了我就按你说的核)`)
      if (deps.execution !== undefined) {
        try {
          const current = await deps.execution.read(taskId)
          if (current !== undefined) await deps.execution.compareAndSet(taskId, current.version, waitUserExecution(current, `goal_ambiguous:${parsed.question.slice(0, 80)}`))
        }
        catch { /* 记录写不上不连累卡上那一句 */ }
      }
      return 'asked'
    }
    await say(taskId, `事务官核验:卡上没写验收条件,从委托提取了这几条(由委托提取):${parsed.acceptance.map((one, i) => `${i + 1}. ${one}`).join(';')}。`)
    await deps.tasks.update(taskId, { acceptance: parsed.acceptance }).catch(() => undefined)
    return parsed.acceptance
  }

  /** 用户层任务的程序核验:目标文件点名 + 那一格热装 ok + 原件 / 本体没动(模型不验这三条)。 */
  async function verifyUserLayer(task: TaskView, receipt: string): Promise<DispatchVerdict> {
    const namedFile = /\S+\.(?:js|jsx|ts|tsx|css|json|md|html)\b/u.test(receipt) || receipt.includes('小组件/')
    if (!namedFile) return { verdict: 'fail', missing: ['交回里没点名改了用户层哪个文件'] }
    const check = deps.userLayerDeliverable === undefined ? { ok: undefined as boolean | undefined } : await deps.userLayerDeliverable(task, receipt).catch(() => ({ ok: undefined as boolean | undefined }))
    if (check.ok !== true) return { verdict: 'unknown', why: check.why ?? '用户层这一拍核不动(热装 / 守门)' }
    return { verdict: 'pass' }
  }

  async function settle(task: TaskView, acceptance: readonly string[]): Promise<DispatchVerdict> {
    const receipt = receiptOf(task)
    if (deps.isUserLayerTask?.(task) === true) return await verifyUserLayer(task, receipt)
    return await verifyAcceptance({
      acceptance, receipt, title: task.title,
      workspace: task.dispatch?.cwd, baseSha: task.dispatch?.base_sha,
    }, { askModel: deps.askVerify, ...(deps.artifacts === undefined ? {} : { artifacts: deps.artifacts }) })
  }

  /** 核验判词 → 卡与执行记录(退修 / 记待核 / 交付)。 */
  async function applyVerdict(task: TaskView, acceptance: readonly string[], verdict: DispatchVerdict): Promise<void> {
    const taskId = task.id
    const fact = currentFact(task)
    if (verdict.verdict === 'pass') {
      await say(taskId, verdict.notes !== undefined && verdict.notes.length > 0 ? `${VERIFY_PASS_NOTE}${verdict.notes.join(';')}` : VERIFY_PASS_NOTE)
      await deps.tasks.move(taskId, 'done').catch(() => ({ ok: false as const }))
      await submitFact(taskId, { kind: 'verification_passed', ...fact })
      changed()
      return
    }
    if (verdict.verdict === 'unknown') {
      await say(taskId, verifyUnknownNote(verdict.why))
      await submitFact(taskId, { kind: 'verification_unknown', ...fact, reason: verdict.why.slice(0, 200), wakeAt: now() + retryMs })
      schedule('verify', taskId, retryMs)
      return
    }
    // fail → 退修;两轮上限按轮次计(卡上「验收未过」留言数,跨重启照数)。
    const failCount = (task.comments ?? []).filter(one => one.by === 'butler' && /验收未过/u.test(one.text)).length
    if (failCount >= 2) {
      await say(taskId, VERIFY_GIVE_UP)
      if (deps.execution !== undefined) {
        try {
          const current = await deps.execution.read(taskId)
          if (current !== undefined) await deps.execution.compareAndSet(taskId, current.version, waitUserExecution(current, `repair_give_up:${verdict.missing.join(';').slice(0, 120)}`))
        }
        catch { /* 记录写不上不连累 */ }
      }
      changed()
      return
    }
    const reworkText = reworkTextOf(verdict.missing, acceptance)
    await say(taskId, reworkText)
    await submitFact(taskId, { kind: 'verification_failed', ...fact, reason: `verification_failed:${verdict.missing.join(';').slice(0, 160)}`, wakeAt: now() + retryMs })
    await repair(task, acceptance, reworkText)
  }

  /**
   * 退修重派:原执行者续跑;派不出去按候选表换手(按家去重是 dispatchVerify 那份话术);
   * 都派不出去 → 卡回「等你确认」(不挂 doing / 卡住没人执行,C#9),原因落卡,记录保持
   * recover 带 wakeAt 由定时器接着推。`announce:false` = 恢复重试那一档:话上一轮已落卡,不再刷屏。
   */
  async function repair(task: TaskView, acceptance: readonly string[], reworkText: string, announce = true): Promise<void> {
    const taskId = task.id
    const family = task.dispatch?.family
    if (family === undefined || deps.dispatchRepair === undefined) return
    const kind = task.dispatch?.kind ?? 'code'
    const resend: { ok: boolean, note?: string, block?: { alternatives?: readonly { family: string, title: string }[] } } =
      await deps.dispatchRepair(taskId, { family, text: reworkText, kind, resume: true, repair: true }).catch(() => ({ ok: false, note: '重派那一下出错了' }))
    if (resend.ok) { changed(); return }
    const who = deps.targetTitle?.(family) ?? family
    if (announce) {
      const note = await reworkResendNote({
        who,
        resendNote: resend.note ?? '没派出去',
        family,
        alternatives: resend.block?.alternatives ?? [],
        tryAlt: async altFamily => await deps.dispatchRepair!(taskId, { family: altFamily, text: reworkText, kind, resume: false, repair: true }).catch(() => ({ ok: false as const, note: '重派出错了' })),
      })
      await say(taskId, note)
    }
    // 不挂 doing / 卡住:卡退回「等你确认」;恢复记录带 wakeAt 接着推(重试在 runRecover)。
    const current = await taskOf(taskId)
    if (current !== undefined && current.status === 'doing') await deps.tasks.move(taskId, 'confirm').catch(() => ({ ok: false as const }))
    // 重派那一下在派发口先记了 dispatch_prepared(phase 进了 dispatching)——把恢复事实再盖回来,
    // 记录回到 recovering + recover(身份按这一刻的记录,迟到的旧事实 reduce 自己拒)。
    if (current !== undefined) {
      await submitFact(taskId, { kind: 'verification_failed', ...currentFact(current), reason: 'repair_redispatch_blocked', wakeAt: now() + retryMs })
    }
    schedule('recover', taskId, retryMs)
    changed()
  }

  /** 恢复重试:退修重派再来一遍(由 wakeAt 定时器或重启后的 resume 触发);不再重复落卡留言。 */
  async function runRecover(taskId: string): Promise<void> {
    const task = await taskOf(taskId)
    if (task === undefined || task.status === 'done' || task.status === 'canceled') return
    if (ownerAskOf(task) !== undefined) return
    const acceptance = task.acceptance ?? []
    if (acceptance.length === 0) return
    await repair(task, acceptance, reworkTextOf(['(上一轮退修没派出去,再派一次)'], acceptance), false)
  }

  /** 核验一轮(守门 → 缺验收提取 → 判 → 落)。`mode='ondemand'` = 她点名要核:不去重、同步等结果。 */
  async function runVerify(taskId: string, mode: 'returned' | 'retry' | 'ondemand'): Promise<DispatchVerdict | undefined> {
    if (inFlight.has(taskId)) return undefined
    inFlight.add(taskId)
    try {
      const task = await taskOf(taskId)
      if (task === undefined || task.status !== 'confirm') return undefined
      if (ownerAskOf(task) !== undefined) return undefined
      const receipt = receiptOf(task)
      if (receipt === '') return undefined
      if (mode === 'returned') {
        const key = `${taskId}@${task.dispatch?.ended_at ?? task.receipt?.at ?? ''}#${receipt.length}`
        if (verified.has(key)) return undefined
        verified.add(key)
      }
      const acceptance = await ensureAcceptance(task, receipt)
      if (acceptance === 'asked' || acceptance === 'pending') return { verdict: 'unknown', why: 'missing_acceptance' }
      const fresh = await taskOf(taskId)
      if (fresh === undefined || fresh.status !== 'confirm') return undefined
      const verdict = await settle(fresh, acceptance)
      await applyVerdict(fresh, acceptance, verdict)
      return verdict
    }
    finally { inFlight.delete(taskId) }
  }

  return {
    onReturned(taskId: string): void {
      void runVerify(taskId, 'returned').catch(() => undefined)
    },

    async verifyOnDemand(taskId, acceptance) {
      const task = await taskOf(taskId)
      if (task === undefined) return { verdict: 'unknown', text: '卡不在了' }
      if (task.status !== 'confirm') return { verdict: 'unknown', text: '这张卡这会儿不在「等你确认」' }
      if (ownerAskOf(task) !== undefined) return { verdict: 'unknown', text: '这张卡在等你拍板(花钱 / 对外发出 / 账号设备 / 范围取舍),那四类只有你能定' }
      const receipt = receiptOf(task)
      if (receipt === '') return { verdict: 'unknown', text: '交回回执是空的,核不了' }
      const use = acceptance.length > 0 ? acceptance : (task.acceptance ?? [])
      if (use.length === 0) return { verdict: 'unknown', text: VERIFY_NO_ACCEPTANCE }
      const verdict = await runVerify(taskId, 'ondemand')
      if (verdict === undefined) return { verdict: 'unknown', text: '这一拍核不上(另一轮核验在进行中)' }
      if (verdict.verdict === 'pass') return { verdict: 'pass', text: `${task.id}「${task.title}」核过了,验收通过,挪到「完成」` }
      if (verdict.verdict === 'unknown') return { verdict: 'unknown', text: verdict.why }
      const who = task.dispatch?.family === undefined ? '原执行者' : (deps.targetTitle?.(task.dispatch.family) ?? task.dispatch.family)
      return { verdict: 'fail', text: `${task.id}「${task.title}」没核过:缺 ${verdict.missing.join(';')} —— 退修给 ${who} 接着改了` }
    },

    async humanSettled(taskId: string): Promise<void> {
      const task = await taskOf(taskId)
      if (task === undefined) return
      await say(taskId, HUMAN_PASS_NOTE)
      const planVersion = task.execution?.planVersion ?? task.round ?? 1
      await submitFact(taskId, { kind: 'settled_by_human', planVersion })
      const prior = timers.get(taskId)
      if (prior !== undefined) clearTimer(prior)
      timers.delete(taskId)
      changed()
    },

    async resume(): Promise<void> {
      if (deps.execution === undefined) return
      let records: ExecutionRecord[]
      try { records = await deps.execution.unfinished() }
      catch { return }
      for (const record of records) {
        const task = await taskOf(record.taskId)
        if (task === undefined) continue
        // 已收场的卡:记录落终态(不翻出来再核、也不再留言)。
        if (task.status === 'done') { await submitFact(task.id, { kind: 'settled_by_human', planVersion: record.planVersion }); continue }
        if (task.status === 'canceled') { await submitFact(task.id, { kind: 'cancel_requested', planVersion: record.planVersion }); continue }
        if (ownerAskOf(task) !== undefined) continue
        const next = record.next?.kind
        if (next === 'verify') this.onReturned(task.id)
        else if (next === 'recover') schedule('recover', task.id, retryMs)
        // reconcile / dispatch 那几档归派发口(dispatchRun.resume)与第 3 步的换手恢复,不在这抢。
      }
    },

    close(): void {
      for (const handle of timers.values()) clearTimer(handle)
      timers.clear()
    },
  }
}
