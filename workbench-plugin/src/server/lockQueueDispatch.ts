/**
 * ★ **解锁之后,排着的派活回到派活的正常流程**(2026-10-12,卡「锁屏派活排队」)。
 *
 * 锁屏队里的她那句话(替她答 / 捎话)解锁后再调一次引擎就够了;派活不行 ——
 * 字送出去之后还有卡要挪「在办」、要盯窗读回话、要自查,这几样都在 `dispatchRun` 里。
 * 所以派活那几条经 `dispatchItem` **整件重派**(与「登录好了接着派」`whenLoggedIn` 同一个口)。
 *
 * 重派之前先看卡上的事实({@link LockQueueDispatch.stillWanted}):卡还挂着「在等你解锁电脑」
 * (`dispatch_block.unlock`)、还是派给这一家,才送。卡收了、改派了、别的手已经派出去了 → 撤掉不送。
 * 不按「排了多久」猜。
 */
import type { AgentDispatchFamily, JobKind, TaskView } from '../protocol.ts'
import { STATUS_TITLES } from '../protocol.ts'
import type { ClientDispatchSource } from './dispatchClient.ts'
import type { DispatchStartResult } from './dispatchRun.ts'
import type { Job, JobResult } from './engine/adapter.ts'
import type { LockDropWhy } from './engine/lockQueue.ts'
import { SETTLED_TASK_STATUS } from './jobKey.ts'

export interface LockQueueDispatchDeps {
  /** 她那句话那几样:再调一次引擎。 */
  run: (job: Job) => Promise<JobResult>
  findTask: (id: string) => Promise<TaskView | undefined>
  /** 进程内派活口(`http.ts` 的 `dispatchItem`)。缺席 = 派活重派不了,如实撤掉。 */
  dispatchItem?: (taskId: string, input: { family: AgentDispatchFamily, text: string, source: ClientDispatchSource, kind?: JobKind }) => Promise<DispatchStartResult>
  /**
   * 把卡上「在等你解锁电脑」那一格摘掉、写上那一句(卡照旧挂「等你处理」,她点一下就能重派)。
   * 缺席 = 不摘(用例 / 老宿主)。
   */
  releaseCard?: (taskId: string, note: string) => Promise<void>
}

export interface LockQueueDispatch {
  run: (job: Job) => Promise<JobResult>
  /** 回一句话 = 这件派活不在等了(撤掉);`undefined` = 还在等 / 不是派活。 */
  stillWanted: (job: Job) => Promise<string | undefined>
  /**
   * ★ 这件派活**不会再自动送了**(重派没成 / 队里过期 / 到顶):卡上还挂着「解锁就送」就摘掉并说一句。
   * 只动「还挂着、还是这一家」的那张卡 —— 已经派出去 / 改派了的不碰。
   */
  release: (job: Job, why: string) => Promise<void>
}

/** 队里自己丢掉那一条时,卡上那一句的前半句(三种缘由,键同 `lockQueue.LockDropWhy`)。 */
export const LOCK_DROP_WHY_TEXT: Readonly<Record<LockDropWhy, string>> = {
  expired: '排着等解锁超过 12 个小时了,不再自动派',
  overflow: '锁屏时排着的事太多,最早这一件被挤掉了',
  tries: '解锁后重派了几回都又撞上锁屏',
}

/** 摘掉「解锁就送」时卡上那一句的后半句(断言照常量)。 */
export const LOCK_RELEASE_NOTE = '解锁后没能接着派出去,点一下这张卡重派'

function itemOf(job: Job): string | undefined {
  if (job.kind !== 'dispatch') return undefined
  const item = job.itemId?.trim()
  return item === undefined || item === '' ? undefined : item
}

export function createLockQueueDispatch(deps: LockQueueDispatchDeps): LockQueueDispatch {
  async function release(job: Job, why: string): Promise<void> {
    const item = itemOf(job)
    if (item === undefined || deps.releaseCard === undefined) return
    const task = await deps.findTask(item).catch(() => undefined)
    const block = task?.dispatch_block
    if (task === undefined || block?.unlock !== true || block.family !== job.family) return
    await deps.releaseCard(item, `${why} —— ${LOCK_RELEASE_NOTE}`)
  }

  return {
    release,

    async stillWanted(job) {
      const item = itemOf(job)
      if (item === undefined) return undefined
      if (deps.dispatchItem === undefined) return '派活那一路这会儿没接上,重派不了'
      const task = await deps.findTask(item)
      if (task === undefined) return '这件事不在看板上了'
      if (SETTLED_TASK_STATUS.includes(task.status)) return `这件事已经「${STATUS_TITLES[task.status]}」了`
      const block = task.dispatch_block
      if (task.status !== 'blocked' || block?.unlock !== true) return '这件事已经不在等解锁了(派出去了,或者你动过它)'
      if (block.family !== job.family) return `这件事已经改派给 ${block.family} 了`
      return undefined
    },

    async run(job) {
      const item = itemOf(job)
      if (item === undefined || deps.dispatchItem === undefined) return await deps.run(job)
      let said = job.brief?.trim() ?? ''
      if (said === '') {
        const task = await deps.findTask(item)
        said = task?.desc ?? task?.title ?? job.text
      }
      const started = await deps.dispatchItem(item, {
        family: job.family as AgentDispatchFamily,
        text: said,
        // 当初替不替她按发送,原样带回去(`dispatchItem` 按来源定:`item` 按、`ui` 不按)。
        source: job.submit === false ? 'ui' : 'item',
        ...(job.work === undefined ? {} : { kind: job.work }),
      })
      if (started.ok) {
        const via: JobResult['via'] = started.hand === 'cli' ? 'cli' : started.hand === 'api' ? 'api' : 'window'
        // 送到没核上这一层不管:卡上那一份由 `dispatchRun` 照常写好了(盯窗那条巡检接着核)。
        return { delivered: 'unconfirmed', via, evidence: 'none', why: started.note }
      }
      if (started.screen_locked === true) return { delivered: 'not_sent', via: 'none', evidence: 'none', screenLocked: true, why: started.note }
      /*
       * 别的失败:`dispatchRun` 多半已经照常写了卡(挂「运行失败」、那一格换掉);
       * 闸拦下那一类它**一个字不改卡** —— 卡上还挂着「解锁就送」就摘掉(队里这一条随后由 drain 拿掉)。
       */
      await release(job, started.note).catch(() => {})
      return { delivered: 'not_sent', via: 'none', evidence: 'none', why: started.note }
    },
  }
}
