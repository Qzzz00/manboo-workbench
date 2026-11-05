/**
 * 「模型设置变更 → 受控会话重指」(2026-10-23 运行时 P1,真实 DSH + 假 OpenAI 复现)。
 *
 * 现场:同一 /butler/item 入口先说一句(模型 A)→ PUT /model 只改成 B → 同一入口再说一句:
 * carryOnTarget 复用旧会话,而旧会话钉在 (workbench-own, A) 上;workbench-own 的 catalog
 * 已被这次切换重写成只有 B → DSH turn/end 报 UNKNOWN_MODEL,第二轮一个上游请求都没有。
 *
 * 修法(上游 `deepseek-harness` 源码核实过,不是猜):`sessionController.selectModel`
 * 能给**已在跑的会话**换模型(requireModel 校验 → selectForNextRequest → 下一条请求生效)。
 * 所以模型一变,把受这份设置控制的会话重指到新目标:
 *
 * - 钉在我们维护的路由(workbench-relay / workbench-own)上的 —— 路由的 catalog 由这份设置重写,
 *   不指走就是 UNKNOWN_MODEL;
 * - 「只换模型名」那一场,官方 provider 上**正用被换掉的那个模型名**的 —— 它走的也是这份
 *   设置定的默认;
 * - 其他会话(别的 provider、没说过话的、模型名对不上的)一个字不动 ——
 *   不强制改所有历史 AI 会话,只修事务官当前受这份设置控制的主路。
 *
 * 重指 = 保留会话上下文接着聊,不新建会话;也不靠把旧模型留在 catalog 里让它悄悄继续用旧模型。
 * 这个文件只放纯函数与编排,真正调 DSH 的是 ButlerSessionOpener.retarget(index.ts 接线)。
 */
import { DSH_OWN_PROVIDER, DSH_RELAY_PROVIDER } from './dshModelSettings.ts'

/** 一条会话此刻钉在哪(优先 DSH `modelSelection.next`，旧宿主回退 `request/header`)。 */
export interface SessionSelection {
  sessionId: string
  provider?: string
  model?: string
}

/** 模型设置刚变成什么样(modelService 在 DSH 那侧写成功后递过来的)。 */
export interface ModelRetargetChange {
  /** DSH 侧此刻的目标 provider(workbench-relay / workbench-own / deepseek-official)。 */
  provider: string
  /** 明确知道的模型名(own 端点 / 只换模型名);缺席(relay / 默认官方)= 由 catalog 缺省补。 */
  model?: string
  /** 「只换模型名」那一场:被换掉的那个模型名(官方 provider 上正用它的会话要跟)。 */
  prevModel?: string
}

/** 我们维护的路由:这份设置重写它们的 catalog,钉在上面的会话必须跟着走。 */
const MANAGED_PROVIDERS = new Set([DSH_RELAY_PROVIDER, DSH_OWN_PROVIDER])

/**
 * 这一条会话受这份设置控制吗(2026-10-23 源审退修,**唯一判据**,needsAlign 与
 * planModelRetargets 都用它,两边不再漂):
 * - 钉在我们维护的路由(workbench-relay / workbench-own)上 —— 路由的 catalog 由这份设置
 *   重写,不指走就是 UNKNOWN_MODEL;
 * - **官方 provider(deepseek-official)上**正用被换掉的模型名(prevModel)的 —— 那个名字
 *   是这份设置替他写的选择。**provider 必须钉死 deepseek-official**:用户自配的 provider
 *   上恰好也叫这个名字的会话,不在受控范围内(卡原要求:自配 provider 一个字不动);
 *   他在 DSH 网页里自己选的其它模型名同样不动。
 * provider 缺席(没说过话 / 登记表没读到)= 不算「受控」,由各自调用点决定怎么处理
 * (plan 跳过;needsAlign 对未知钉法保守对齐)。
 */
export function isSettingControlledSession(
  sel: { provider?: string, model?: string } | undefined,
  prevModel: string | undefined,
): boolean {
  if (sel?.provider === undefined) return false
  if (MANAGED_PROVIDERS.has(sel.provider)) return true
  return sel.provider === 'deepseek-official' && prevModel !== undefined && sel.model === prevModel
}

/**
 * 哪些会话该重指。`fallback` = catalog 缺省(provider + model),只在 change.model 缺席时用;
 * 两者都缺席 → 一条都不指(不猜模型名,猜错 = 那条会话 UNKNOWN_MODEL)。
 */
export function planModelRetargets(
  selections: readonly SessionSelection[],
  change: ModelRetargetChange,
  fallback: { provider: string, model: string } | undefined,
): { sessionId: string, provider: string, model: string }[] {
  const model = change.model ?? fallback?.model
  if (model === undefined) return []
  const out: { sessionId: string, provider: string, model: string }[] = []
  for (const one of selections) {
    if (!isSettingControlledSession(one, change.prevModel)) continue
    // 已经在目标上的不用动。
    if (one.provider === change.provider && one.model === model) continue
    out.push({ sessionId: one.sessionId, provider: change.provider, model })
  }
  return out
}

/**
 * 一条会话说之前要不要先对齐到 target(2026-10-23 竞态闭环)。
 * PUT /model 返回后立刻续聊时,后台那次 retarget 可能还没跑到(catalog 也可能没热加载完);
 * DSH 重启后登记表(feed)是空的,carryOnTarget 却仍能接上历史会话 —— 这两种情况下
 * 靠枚举就漏了。所以在 say 之前对**这一条**会话再判一次:
 * - 已经在目标上:不用动;
 * - 不知道它钉在哪(feed 空):保守对齐;
 * - 受控会话(isSettingControlledSession,含官方 provider 上正用被换掉的模型名的):
 *   对齐;
 * - 其余(他在 DSH 网页自选的其它模型名、用户自己配的 provider):不动。
 * 「受控 / 旧官方模型」的判据与 planModelRetargets 共用同一个函数,保证两边一致。
 */
export function needsAlign(
  sel: { provider?: string, model?: string } | undefined,
  target: { provider: string, model: string, prevModel?: string },
): boolean {
  if (sel?.provider === target.provider && sel.model === target.model) return false
  if (sel?.provider === undefined) return true
  return isSettingControlledSession(sel, target.prevModel)
}

/** retargetManagedSessions 的依赖(测试注入桩用)。 */
export interface RetargetDeps {
  /** 此刻在册的会话与它们的 selection。 */
  selections: () => Promise<readonly SessionSelection[]>
  /** catalog 缺省(change.model 缺席时补模型名;拿不到回 undefined)。 */
  catalogDefault?: () => Promise<{ provider: string, model: string } | undefined>
  /** DSH 那头 opener 的 retarget 口。 */
  opener: { retarget?: (sessionId: string, provider: string, model: string) => Promise<boolean> }
  change: ModelRetargetChange
}

/**
 * 模型设置变更那一刻的编排:枚举 → 规划 → 逐条 retarget。
 * 失败必须向设置传播；调用方不能把仍未完成的会话切换当成成功。
 */
/** 只保存本次内存中的成功选择，调用方先恢复 catalog 再调用。 */
export type ModelRetargetRollback = () => Promise<void>

export class ModelRetargetError extends Error {
  constructor(readonly rollback: ModelRetargetRollback) { super('MODEL_RETARGET_FAILED') }
}

export async function retargetManagedSessions(deps: RetargetDeps): Promise<ModelRetargetRollback> {
  // 不能留对可变 feed/fixture 的引用：selectModel 会更新选择投影。
  const selections = (await deps.selections()).map(one => ({ ...one }))
  const fallback = deps.change.model === undefined ? await deps.catalogDefault?.() : undefined
  const plan = planModelRetargets(selections, deps.change, fallback)
  if (plan.length > 0 && deps.opener.retarget === undefined) throw new Error('MODEL_SELECTION_UNAVAILABLE')
  const completed: typeof plan = []
  const rollback = async () => {
    let failed = false
    for (const one of [...completed].reverse()) {
      const previous = selections.find(old => old.sessionId === one.sessionId)
      const current = (await deps.selections()).find(now => now.sessionId === one.sessionId)
      // 用户后来另选的会话不回写，也不扩大到未被此次操作触及的同名会话。
      if (current?.provider !== one.provider || current.model !== one.model) continue
      if (previous?.provider === undefined || previous.model === undefined) { failed = true; continue }
      try {
        if (!await deps.opener.retarget?.(one.sessionId, previous.provider, previous.model)) failed = true
      }
      catch { failed = true }
    }
    if (failed) throw new Error('MODEL_SELECTION_ROLLBACK_FAILED')
  }
  try {
    for (const one of plan) {
      if (!await deps.opener.retarget?.(one.sessionId, one.provider, one.model)) throw new Error('MODEL_RETARGET_FAILED')
      completed.push(one)
    }
  }
  catch { throw new ModelRetargetError(rollback) }
  return rollback
}
