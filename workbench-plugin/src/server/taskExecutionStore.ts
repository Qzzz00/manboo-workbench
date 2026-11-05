/**
 * ★ **执行记录的受控持久存储**(2026-10-29,可靠执行闭环第一批第 1 步)。
 *
 * 适配现有任务存储(`server/tasks.ts` 的卡文件,记录挂在卡上一格 `TaskView.execution`),
 * **不新建 JSON 账**。写入走 tasks 服务自己的写队列(load→改→save 串行化,见 tasks.ts),
 * 与看板其它写口互不切账;同一 `expectedVersion` 并发两次比较写入只有一个成功,
 * 失败的那次**重新读取**再决,不让迟到结果覆盖新版(计划第 1 步钉的)。
 *
 * 本步不接线到 dispatchRun / http / hub(第 2、3 步做);这里只暴露推进职责要的三样。
 */

import type { TasksService } from './tasks.ts'
import type { ExecutionRecord } from './taskExecution.ts'

export interface ExecutionStore {
  read: (taskId: string) => Promise<ExecutionRecord | undefined>
  compareAndSet: (taskId: string, expectedVersion: number, next: ExecutionRecord) => Promise<boolean>
  unfinished: () => Promise<ExecutionRecord[]>
}

/** 推进职责 persistence 口的唯一装配处;消费方(Dispatch/HTTP/hub)拿它提交事实与读取恢复项。 */
export function createExecutionStore(tasks: TasksService): ExecutionStore {
  return {
    read: (taskId) => tasks.readExecution(taskId),
    compareAndSet: (taskId, expectedVersion, next) => tasks.writeExecution(taskId, next, expectedVersion),
    unfinished: () => tasks.unfinishedExecutions(),
  }
}
