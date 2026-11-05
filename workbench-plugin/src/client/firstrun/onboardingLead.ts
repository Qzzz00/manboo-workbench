/** 电脑默认主导；只在服务端明确保留旧手机会话时显示进度与电脑接手入口。 */
import type { OnboardingStateView } from '../../protocol.ts'

export type OnboardingLeader = 'phone' | 'desktop'

/** 手机那边多久没动静就问一句。任务书定的十分钟。 */
export const PHONE_IDLE_MS = 10 * 60 * 1000

/** 手机那边没动静时电脑上那句话。**是问句不是通知**:主导权不自动切。 */
export const PHONE_IDLE_ASK = '手机那边没动静,改在电脑上做?'

/** 手机主导时电脑上那一屏的标题。 */
export const PHONE_LEAD_TITLE = '在手机上继续'

/**
 * 此刻谁主导。`leader` 认不出来的值一律当没有 —— 老工作台、写坏的文件都走同一条路。
 */
export function onboardingLeaderOf(input: { leader?: string, phonePaired: boolean }): OnboardingLeader {
  if (input.leader === 'phone' || input.leader === 'desktop') return input.leader
  return 'desktop'
}

/**
 * 手机那边多久没动静了。**没有过动静**(`leader_at` 缺席)时回 false ——
 * 那多半是刚配上手机、还没开始;那时候就问「没动静?」是在催人。
 */
export function phoneIdle(input: { leaderAt?: string, now: number, idleMs?: number }): boolean {
  if (input.leaderAt === undefined) return false
  const at = Date.parse(input.leaderAt)
  if (!Number.isFinite(at)) return false
  return input.now - at >= (input.idleMs ?? PHONE_IDLE_MS)
}

/**
 * 只读进度那一行:「现在到第 2 步(共 8 步):② 分岔」。
 *
 * **不编数**:服务端没给 step / label 就只说得出阶段名,给多少说多少。
 */
export function phoneProgressText(view: Pick<OnboardingStateView, 'stage' | 'done' | 'label' | 'step' | 'steps'>): string {
  if (view.done) return '引导已经做完了。'
  const label = view.label ?? view.stage
  if (view.step === undefined) return `现在到:${label}`
  if (view.steps === undefined) return `现在到第 ${view.step} 步:${label}`
  return `现在到第 ${view.step} 步(共 ${view.steps} 步):${label}`
}
