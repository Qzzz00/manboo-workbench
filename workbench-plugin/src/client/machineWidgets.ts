/**
 * 组件条·存储/性能两格(spec §3 组件条定案)的纯投影。
 *
 * machine 采样已经在服务端接通(src/server/machine.ts:disk_pct/disk_free_gb/mem_gb/cpu_idle_pct)，
 * 只是界面上一直没有常显位置——终审 F2 指出这条范围收缩没进台账，这里补上。
 * 早报组件本期不做(数据源不存在，见验收记录 §9.7 的范围说明)，不在本文件里。
 *
 * 跟 portfolio.ts/butler.ts 同一套规矩：纯函数，不碰 DOM、不发请求；machine 缺省
 * (还没来得及采样/服务端没启用该功能)或 { error }(D13:命令失败/解析失败)都要
 * 显式标"未接入:<原因>"，不留空、不编数——两种情况在这里合并处理，理由跟 D13
 * 的降级纪律一致：读者不关心"没有信号"和"信号说取不到"的内部区别，都是同一句话。
 */
import type { WorkbenchState } from '../protocol.ts'

export interface StorageWidgetView {
  /** true＝未接入(machine 缺省或 { error })，此时 valueText 就是"未接入:<原因>"。 */
  error: boolean
  valueText: string
  /** disk_pct >= 95 时为 true(参照 v5 原型 .wg.bad 红色告警态)。 */
  alert: boolean
}

export interface PerformanceWidgetView {
  error: boolean
  valueText: string
}

/** 磁盘告警阈值(spec §3，与 butler.ts/layout.ts hoistedAlerts 用的同一条阈值)。 */
const DISK_ALERT_PCT = 95

/** machine 缺省时的展示原因——不是命令失败，是压根还没有一条采样结果。 */
const NOT_SAMPLED_REASON = '尚未采样'

/** 存储格:disk_pct% + 剩 N G；disk_pct>=95 告警态；未接入显式标注(D13)。 */
export function buildStorageWidget(machine: WorkbenchState['machine']): StorageWidgetView {
  if (machine === undefined) return { error: true, valueText: `未接入:${NOT_SAMPLED_REASON}`, alert: false }
  if ('error' in machine) return { error: true, valueText: `未接入:${machine.error}`, alert: false }
  return {
    error: false,
    valueText: `${Math.round(machine.disk_pct)}% · 剩 ${Math.round(machine.disk_free_gb)}G`,
    alert: machine.disk_pct >= DISK_ALERT_PCT,
  }
}

/** 性能格:cpu_idle_pct% 空闲 + mem_gb G；未接入显式标注(D13)。 */
export function buildPerformanceWidget(machine: WorkbenchState['machine']): PerformanceWidgetView {
  if (machine === undefined) return { error: true, valueText: `未接入:${NOT_SAMPLED_REASON}` }
  if ('error' in machine) return { error: true, valueText: `未接入:${machine.error}` }
  return {
    error: false,
    valueText: `${Math.round(machine.cpu_idle_pct)}% 空闲 · ${Math.round(machine.mem_gb)}G`,
  }
}
