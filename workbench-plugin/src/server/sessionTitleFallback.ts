/**
 * ★ **没名字的会话借挂着它的那张卡的标题**(2026-10-23,统筹;维护者 09:2x:「天呐,我为什么没有找到
 * codex 的那条会话,我刚刚还在手机里发信息给他了」)。
 *
 * 现场:统筹用 `codex exec` 起的梳理线程挂在卡 `t-68fc991f` 上,Codex 应用没给它起名(`thread_name` 空),
 * 板上与手机上都显示成「Codex 的一条会话」,混在办完那一列里认不出来。
 *
 * 规矩:会话自己有名字照旧用自己的;**只有空名字**才借卡的标题;一张卡挂了几条会话就都借同一个标题
 * (它们本来就是同一件事);没卡挂着的照旧空着(手机 / 电脑各自的「X 的一条会话」兜底一字不变)。
 */
import type { SessionView, TaskView } from '../protocol.ts'

export function withCardTitles(sessions: readonly SessionView[], tasks: readonly Pick<TaskView, 'title' | 'links'>[]): SessionView[] {
  const byKey = new Map<string, string>()
  for (const task of tasks) {
    const title = task.title.trim()
    if (title === '') continue
    for (const link of task.links ?? []) {
      const key = `${link.agent}:${link.session_id}`
      if (!byKey.has(key)) byKey.set(key, title)
    }
  }
  if (byKey.size === 0) return [...sessions]
  return sessions.map((one) => {
    if ((one.title ?? '').trim() !== '') return one
    const borrowed = byKey.get(`${one.agent}:${one.session_id}`)
    return borrowed === undefined ? one : { ...one, title: borrowed }
  })
}

/**
 * ★ **借源会话名的卡,随来源改名**(2026-10-23,卡 A「同事项接续与动作契约」;需求 3.6「改名各有归属」)。
 *
 * 方向与上面那条(无名会话借卡名,211d2977d)**相反、两条并存**:
 *   - 这里:卡名借自会话(`title_from:'session'`,placeSession 建卡时带的名)→ 来源会话改了名,卡跟着改;
 *   - 上面:会话没名 → 会话借卡的标题(视图层变换,不落盘)。
 *
 * 三条边界:
 *   - **用户改过的卡不动**(`title_from:'custom'`)——人的手盖过来源;
 *   - **会话名空着不动** —— 不拿卡名回填会话(那是上面那条老规矩的事,不越界);
 *   - **没变不写盘**(返回 0)—— 拼 /state 每秒一拍,这里不能变成每秒一写。
 *
 * 防双向覆盖循环:卡名只有这一个写口从会话名写;会话名从来不从卡名落盘 —— 构不成循环。
 * 挂在 `composeState` 读路径上(同「读路径迁移」那几条的老做法):来源一改名,下一拍卡名就跟上。
 *
 * @returns 改了几张卡(0 = 什么都没动)。
 */
export async function syncBorrowedCardTitles(
  tasks: { list: () => Promise<{ tasks: readonly TaskView[] }>, update: (id: string, input: { title?: string, titleFrom?: 'session' | 'custom', titleSyncFrom?: string }) => Promise<boolean> },
  sessions: readonly Pick<SessionView, 'agent' | 'session_id' | 'title'>[],
): Promise<number> {
  const byKey = new Map<string, string>()
  for (const one of sessions) {
    const title = (one.title ?? '').trim()
    if (title !== '') byKey.set(`${one.agent}:${one.session_id}`, title)
  }
  if (byKey.size === 0) return 0
  let changed = 0
  for (const card of (await tasks.list()).tasks) {
    if (card.title_from !== 'session') continue
    if (card.source?.kind !== 'session' || card.source.ref === undefined) continue
    const title = byKey.get(card.source.ref)
    if (title === undefined || title === card.title) continue
    // titleSyncFrom = 同事务复核:写的那一刻这张卡还得借着这条来源的名,否则手改先到不覆盖。
    if (await tasks.update(card.id, { title, titleFrom: 'session', titleSyncFrom: card.source.ref })) changed += 1
  }
  return changed
}
