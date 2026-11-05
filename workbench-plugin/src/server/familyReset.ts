/**
 * ★ **重置这一家**(2026-10-21,卡「派活按家隔离」;全景地图「鲁棒该长什么样」那一句)。
 *
 * 从前一家卡住之后清通道只有三条路:停单件、关掉重开那家 App、重启插件 —— 重启又清掉会话登记表(手机 404)。
 * 这一下把「清通道」要做的几件收成一处,**不重启插件、别家一点不动**:
 *
 * 1. 插件这一侧那一家的窗口通道:排着的撤掉、在跑的那一下作废、「堵了」的记录清掉(`familyLanes.reset`);
 * 2. 闸上那一家的计数从头数(`actionGate.forgetFamily`);
 * 3. 壳那一侧那一家排着的读窗撤掉(`cancel_reads`,壳报 `read_lanes` 才发;老壳如实说没撤);
 * 4. 重开那扇窗(`open -b`,与引擎开窗同一只手:零窗口的 App 靠它把窗开回来);
 * 5. 卡上「通道堵了」那一格清掉(下一拍巡检照常读;读不动会再挂上);
 * 6. 记账:任务账这一家每件还开着的事一行 `lane_reset` + 这一下本身一行;行为账一笔「重置」。
 *
 * 在等回话的那几件**接着等**(它们的回话还在那扇窗里);排着的那几件照旧排(前一件收回就送)。
 */
import type { TaskView } from '../protocol.ts'
import type { ActionGate } from './actionGate.ts'
import type { BehaviorInput } from './behaviorLog.ts'
import { BEHAVIOR_EVENTS } from './behaviorLog.ts'
import type { FamilyLanes } from './familyLanes.ts'
import { SETTLED_TASK_STATUS } from './jobKey.ts'
import type { JobLog } from './jobLog.ts'

export const FAMILY_RESET_BEHAVIOR = BEHAVIOR_EVENTS.reset

/** 任务账上「这一下本身」那一行的键。 */
export function familyResetJobKey(family: string): string {
  return `family:${family}`
}

export interface FamilyResetDeps {
  lanes?: Pick<FamilyLanes, 'reset'>
  gate?: Pick<ActionGate, 'forgetFamily'>
  jobLog?: Pick<JobLog, 'append'>
  name: (family: string) => string
  now: () => Date
  /** 这一家在这台电脑上的那几个包(家族目录 / 登记表)。 */
  packagesOf: (family: string) => readonly string[]
  helper?: {
    supports?: (cap: string) => boolean
    request: (req: { op: 'cancel_reads', bundle_ids: string[] }, timeoutMs?: number) => Promise<Record<string, unknown>>
  }
  openApp?: (bundleId: string) => Promise<{ ok: boolean }>
  tasks: {
    list: () => Promise<{ tasks: readonly TaskView[] }>
    update: (id: string, patch: { dispatchLane: null }) => Promise<boolean>
  }
  behavior?: (input: Pick<BehaviorInput, '事' | '对象' | '结果'>) => void
}

export interface FamilyResetResult {
  ok: boolean
  note: string
  cancelled_reads: number
  abandoned: number
  gate_cleared: number
  /** 壳那一侧撤了几下(老壳 / 没接上:缺席)。 */
  shell_cancelled?: number
  reopened: boolean
  /** 这一家还开着的事有几件(在等回话的接着等、排着的照旧排)。 */
  open_jobs: number
}

function isOpenFor(task: TaskView, family: string): boolean {
  if (SETTLED_TASK_STATUS.includes(task.status)) return false
  const waiting = task.client_dispatch?.family === family && task.client_dispatch.reply_state === 'waiting'
  return waiting || task.dispatch_lane?.family === family
}

export async function resetFamily(deps: FamilyResetDeps, family: string): Promise<FamilyResetResult> {
  const who = deps.name(family)
  const lane = deps.lanes?.reset(family) ?? { cancelled: 0, abandoned: 0 }
  const gateCleared = deps.gate?.forgetFamily(family) ?? 0
  let tasks: readonly TaskView[] = []
  try { tasks = (await deps.tasks.list()).tasks } catch { tasks = [] }
  const open = tasks.filter(one => isOpenFor(one, family))
  // 卡上真送进去的那个包排前面(两个豆包时,重开的是正在用的那一个)。
  const used = open.map(one => one.client_dispatch?.bundle_id).filter((one): one is string => one !== undefined)
  const bundles = [...new Set([...deps.packagesOf(family), ...used])]
  let shellCancelled: number | undefined
  if (deps.helper !== undefined && deps.helper.supports?.('read_lanes') === true && bundles.length > 0) {
    try {
      const got = await deps.helper.request({ op: 'cancel_reads', bundle_ids: bundles }, 3000)
      shellCancelled = typeof got.cancelled === 'number' ? got.cancelled : 0
    }
    catch { shellCancelled = undefined }
  }
  let reopened = false
  const front = used[0] ?? bundles[0]
  if (front !== undefined && deps.openApp !== undefined) {
    reopened = (await deps.openApp(front).catch(() => ({ ok: false }))).ok
  }
  for (const one of open) {
    if (one.dispatch_lane?.state !== 'jammed') continue
    try { await deps.tasks.update(one.id, { dispatchLane: null }) } catch { /* 下一拍巡检照样会重写那一格 */ }
  }
  const parts = [
    `撤了 ${lane.cancelled + lane.abandoned} 下在等的读窗`,
    ...(shellCancelled === undefined ? ['工作台 App 那一侧没撤(要新版工作台 App)'] : [`工作台 App 那一侧撤了 ${shellCancelled} 下`]),
    `清了 ${gateCleared} 格次数`,
    reopened ? '重开了它的窗' : '没重开成它的窗(去看一眼它开着没有)',
  ]
  const tail = open.length === 0 ? '' : `;它那边还开着的 ${open.length} 件接着办`
  const note = `已重置 ${who}:${parts.join('、')}${tail}`
  const why = parts.join('、')
  for (const one of open) deps.jobLog?.append({ job: one.id, step: 'lane_reset', family, why })
  deps.jobLog?.append({ job: familyResetJobKey(family), step: 'lane_reset', family, why })
  try { deps.behavior?.({ 事: FAMILY_RESET_BEHAVIOR, 对象: who, 结果: why }) } catch { /* 行为账坏了不挡这一下 */ }
  return {
    ok: true,
    note,
    cancelled_reads: lane.cancelled,
    abandoned: lane.abandoned,
    gate_cleared: gateCleared,
    ...(shellCancelled === undefined ? {} : { shell_cancelled: shellCancelled }),
    reopened,
    open_jobs: open.length,
  }
}
