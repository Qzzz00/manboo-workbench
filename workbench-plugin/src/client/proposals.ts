/**
 * 工作台自己的提议(PRD §5.6 / §9)。纯函数,不碰 DOM、不发请求。
 *
 * PRD §9 三条强制规则,在这一层做成**代码门槛**而不是文案约定——系统具备自我迭代能力,
 * 必须存在一块它碰不到的地方:
 *   ① 功能层提议必须同一模块**连续 3 天同向行为**才允许发起
 *   ② 必须先给预览
 *   ③ 必须经明确采纳才执行(已采纳的不再进待提议列表;这里不执行任何东西)
 *
 * 今天没有提议源,`admissibleProposals([])` 恒为空——界面因此恒显示那句如实空态。
 * 门槛本身先立在这里,将来接了源不必再补一遍。
 */

import { localDateStr } from './dates.ts'

/** 连续同向行为的天数门槛(PRD §9 门槛①)。 */
export const EVIDENCE_DAYS_REQUIRED = 3

export interface Proposal {
  id: string
  /** 事务层("卡在哪、需要什么帮助")不受证据门槛约束;功能层("要不要改个功能")受。 */
  layer: 'transaction' | 'feature'
  module_id: string
  text: string
  /** 同向行为发生的日期(YYYY-MM-DD),门槛①按"连续且含今天"判定。 */
  evidence_days: readonly string[]
  /** 门槛②:没有预览一律不可提。 */
  preview?: string
  /** 门槛③:已采纳的不再出现在待提议里。 */
  adopted: boolean
}

/** 前一天。`T00:00:00`(不带 Z)是本地午夜,与 localDateStr 同一条"按本地时区切天"的纪律。 */
function dayBefore(dateStr: string): string {
  const d = new Date(`${dateStr}T00:00:00`)
  d.setDate(d.getDate() - 1)
  return localDateStr(d.getTime())
}

/**
 * 门槛①:必须**连续**且**含今天**。不含今天 = 陈年旧账,不该现在冒出来;
 * 不连续 = 偶发行为,不是"同向"。
 */
function hasContinuousEvidence(days: readonly string[], today: string): boolean {
  const set = new Set(days)
  let cursor = today
  for (let i = 0; i < EVIDENCE_DAYS_REQUIRED; i += 1) {
    if (!set.has(cursor)) return false
    cursor = dayBefore(cursor)
  }
  return true
}

/** 三条门槛全过的才算"可以摆到 Ben 面前"。任何一条不过就不摆——不解释、不降级展示。 */
export function admissibleProposals(all: readonly Proposal[], today: string): Proposal[] {
  return all.filter((p) => {
    if (p.adopted) return false                                        // 门槛③
    if (p.preview === undefined || p.preview === '') return false      // 门槛②
    if (p.layer === 'feature' && !hasContinuousEvidence(p.evidence_days, today)) return false // 门槛①
    return true
  })
}
