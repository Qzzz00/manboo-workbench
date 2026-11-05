/**
 * 悬浮球那一格(2026-10-27,《设计-协作区与事务官标签页合并》5.1):事务官入口只剩悬浮球,
 * 原事务官页那颗球的状态都要接到收起的球上。颜色认 `orb.notice`,形态认 `orb.working` / `orb.calling`,
 * 数字认 `waiting.count`、`orb.blocked`;**在跑那一件数与展开窗「在跑的事项」同读 /collab/runs 一本账**
 * (2026-10-28,断点④残留,片段由上层 useCollabRuns 取来)——快照与任务日志曾各数各的,这里不再自数快照;
 * 没接上(undefined / 'missing')才退回 running 那一格。快照过期(掉线)时保留上次形态,不出琥珀与角标。
 */
import type { WorkbenchState } from '../protocol.ts'
import type { ParticleMode } from './ParticleOrb.tsx'
import type { ParticleNotice } from './butlerSceneModel.ts'
import { waitingOf } from '../waiting.ts'
import { businessExecutionView, runningCountOf, type CollabRunFacts } from './businessExecutionModel.ts'

export interface FloatOrbView {
  mode: ParticleMode
  notice: ParticleNotice
  /** 等你几件(角标);掉线时 0。 */
  waiting: number
  /** 等你清单,一件一行(悬停卡)。 */
  lines: readonly string[]
  /** 业务执行几件;取不到缺席,不编 0。 */
  running?: number
  blocked: number
  /** 有一条没看的回复 / 有刚办完的结果没看:各一颗小点,不变色。 */
  answer: boolean
  fresh: boolean
  stale: boolean
  /** 读屏名与悬停卡第一行。 */
  line: string
}

export function floatOrbView(state: WorkbenchState, runFacts?: CollabRunFacts): FloatOrbView {
  const cell = state.orb
  const stale = state.stale === true
  const pile = waitingOf(state)
  const running = runningCountOf(runFacts, businessExecutionView(state).count)
  const mode: ParticleMode = cell?.calling === true ? 'calling' : cell?.working === true ? 'working' : 'idle'
  const notice: ParticleNotice = stale ? 'neutral' : cell?.notice ?? 'neutral'
  const waiting = stale ? 0 : pile.count
  const line = stale ? '掉线了 · 显示上次状态'
    : cell?.calling === true ? '通话中'
      : waiting > 0 ? '等你回话'
        : (running ?? 0) > 0 ? `正在执行 ${running} 件`
          : '我在。'
  return {
    mode, notice, waiting,
    lines: stale ? [] : pile.items.map(item => item.text),
    ...(running === undefined ? {} : { running }),
    blocked: cell?.blocked ?? 0,
    answer: cell?.answer === true,
    fresh: cell?.fresh_result === true,
    stale,
    line,
  }
}

/** 悬停卡那一行数字(执行 · 等你 · 受阻);执行取不到就不写那一截。 */
export function floatOrbCounts(view: FloatOrbView): string {
  return [
    ...(view.running === undefined ? [] : [`执行 ${view.running}`]),
    `等你 ${view.waiting}`,
    ...(view.blocked > 0 ? [`受阻 ${view.blocked}`] : []),
  ].join(' · ')
}
