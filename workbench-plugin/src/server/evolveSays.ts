/**
 * 进化循环数「他反复在说的话」从哪来(2026-09-25,卡 feat/first-look-orb-top)。
 *
 * 维护者 09-24 晚引导完,事务官档里摆出一张「这 4 次你都在说「引导 ②′ 排的方案「desktop-workbench」。交接里排的第三件」
 * —— 要不要把它固化下来?」:那四条是引导替他排的事项,desc 里写的是**出处说明**,不是他说的话;
 * 同一天还有一张「时长:4 秒」的 —— 那是通话纪要的正文。原来的口径是「所有 `direction:'mine'` 的卡,取 desc ?? title」。
 *
 * 现在两条纪律:
 *   1. **只数他亲口交代的**(`taskOriginOf(task) === 'user'`):通话纪要、引导排的、会议挑出来的一概不算;
 *   2. **只用他那句原话**(标题),不看 desc —— desc 要么是长文全文、要么是出处说明,都不是「那一句」。
 *
 * 零 I/O,纯函数;index.ts 只负责把看板喂进来。
 */
import { taskOriginOf, type TaskView } from '../protocol.ts'
import type { EvolveSay } from './evolve.ts'

/** 进化循环要的「他说过的话」:他亲口交代的事项的标题。 */
export function userSaysOf(tasks: readonly TaskView[]): EvolveSay[] {
  const rows: EvolveSay[] = []
  for (const task of tasks) {
    if (task.direction !== 'mine') continue
    if (taskOriginOf(task) !== 'user') continue
    rows.push({ id: task.id, text: task.title, at: task.created_at })
  }
  return rows
}

/**
 * 他亲口交代过的全部原文(标题与全文都算)。给 `evolve.revalidate` 认「摆着的提议还靠不靠得住」:
 * 旧口径按 desc 攒出来的真提议(他长长交代的那几句)照样认得出来,系统写的那几句认不出来 —— 撤下。
 */
export function userSpokenOf(tasks: readonly TaskView[]): string[] {
  const texts: string[] = []
  for (const task of tasks) {
    if (task.direction !== 'mine' || taskOriginOf(task) !== 'user') continue
    texts.push(task.title)
    if (task.desc !== undefined) texts.push(task.desc)
  }
  return texts
}
