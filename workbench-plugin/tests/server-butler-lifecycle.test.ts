// @vitest-environment node
/**
 * 事项生命周期闭环(2026-09-16):会话结束 → 事项过渡。
 *
 * 真机现象(Ben 2026-09-16):两条事项各开了一条 DSH 会话,会话早已 done,事项仍是 doing、
 * 事务官档「进行中 02」、球却待命。这里钉的是三条映射与两条不动的边界:
 * done → 等我确认(交付物挂回答、依据是会话 id);error → 阻塞(出错原话);aborted → 待办(你停了它);
 * 不是 mine / 没有会话 / 不在 doing 的不动;人在会话结束之后改过的以人为准。
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { TaskView } from '../src/protocol.ts'
import { createTasksService } from '../src/server/tasks.ts'
import {
  SESSION_ENDED_NOTE,
  STOPPED_NOTE,
  createButlerLifecycle,
  itemTransitionOnSessionEnd,
} from '../src/server/butlerLifecycle.ts'

const END_TS = Math.floor(Date.parse('2026-09-16T10:00:00Z') / 1000)

const dirs: string[] = []
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop() as string, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
})

function task(over: Partial<TaskView> = {}): TaskView {
  return {
    id: 't-1', title: '你是什么模型', status: 'doing', direction: 'mine', source: { kind: 'manual' },
    conversation: { agent: 'dsh', session_id: 's-1' }, links: [{ agent: 'dsh', session_id: 's-1' }],
    created_at: '2026-09-16T09:50:00.000Z', updated_at: '2026-09-16T09:50:00.000Z',
    ...over,
  }
}

describe('itemTransitionOnSessionEnd(纯函数)', () => {
  it('★done 且真办了事 → 等我确认:交付物挂上会话摘要,依据写会话 id', () => {
    // 「你是什么模型」那一句从 2026-09-25(卡 Y)起不算一件事,所以这条要一个**真派出去了**的样本。
    const next = itemTransitionOnSessionEnd(task({ assignee: 'codex' }), { kind: 'done', ts: END_TS }, '我是 DeepSeek')
    expect(next).toEqual({
      status: 'confirm',
      update: { deliverables: [{ kind: 'reply', ref: '我是 DeepSeek', session_id: 's-1' }], note: null },
    })
  })

  /**
   * ★「随手问一句不算一件事」(2026-09-25,卡 Y;维护者拍板)。同一张卡、同一次 done,
   * 只因为**没派出去、没改文件、没有要交回的东西** → 不进「等我确认」,卡自己收掉。
   * 判据在 server/casualAsk.ts(测在 tests/casual-ask.test.ts),这里只钉生命周期这一步的出口。
   */
  it('★done 但只是问了一句 → 进「完成」并盖 casual 章,回答照样挂上,**而且另报一条答案**', () => {
    const next = itemTransitionOnSessionEnd(task(), { kind: 'done', ts: END_TS, filesChanged: 0 }, '我是 DeepSeek')
    expect(next).toEqual({
      status: 'done',
      update: { deliverables: [{ kind: 'reply', ref: '我是 DeepSeek', session_id: 's-1' }], note: '只是问了一句', casual: true },
      /**
       * ★ 2026-10-04(卡 `claude/answer-comes-to-her`):卡与 `casual` 那一章**一个字没改**,
       * 多的只是这一条 —— 答案要送到她面前(手机球下那一行字幕、电脑事务官页同一处,
       * 以及一条**正文就是答案本身**的通知)。维护者原话:「信息直接从正在办切到办完了,
       * 我是自己追过去点开查看的」。
       */
      answer: { question: task().title, answer: '我是 DeepSeek', session_id: 's-1' },
    })
  })

  it('没有摘要就写「会话已结束,去看对话」,不编一句', () => {
    const next = itemTransitionOnSessionEnd(task({ assignee: 'codex' }), { kind: 'done', ts: END_TS }, undefined)
    expect(next?.update.deliverables).toEqual([{ kind: 'reply', ref: SESSION_ENDED_NOTE, session_id: 's-1' }])
  })

  it('已有交付物的保留,回答追加在后面', () => {
    const next = itemTransitionOnSessionEnd(task({ deliverables: [{ kind: 'url', ref: 'https://a' }] }), { kind: 'done', ts: END_TS }, '答')
    expect(next?.update.deliverables).toEqual([{ kind: 'url', ref: 'https://a' }, { kind: 'reply', ref: '答', session_id: 's-1' }])
  })

  it('★error → 阻塞,block_reason=error,原话记在卡上', () => {
    const next = itemTransitionOnSessionEnd(task(), { kind: 'error', ts: END_TS, detail: '模型路由不可用' })
    expect(next).toEqual({ status: 'blocked', update: { blockReason: 'error', note: '模型路由不可用' } })
  })

  it('error 没原话 → 卡上写「会话出错」,不编原因', () => {
    const next = itemTransitionOnSessionEnd(task(), { kind: 'error', ts: END_TS })
    expect(next?.update.note).toBe('会话出错')
  })

  it('★aborted(你按了停)→ 回待办,记「你停了它」', () => {
    const next = itemTransitionOnSessionEnd(task(), { kind: 'aborted', ts: END_TS })
    expect(next).toEqual({ status: 'todo', update: { note: STOPPED_NOTE } })
  })

  it.each(['confirm', 'done', 'canceled', 'todo', 'blocked', 'backlog'] as const)('事项在 %s 时不动(不倒退、不越级)', (status) => {
    expect(itemTransitionOnSessionEnd(task({ status }), { kind: 'done', ts: END_TS })).toBeUndefined()
    expect(itemTransitionOnSessionEnd(task({ status }), { kind: 'error', ts: END_TS })).toBeUndefined()
    expect(itemTransitionOnSessionEnd(task({ status }), { kind: 'aborted', ts: END_TS })).toBeUndefined()
  })

  it('不是 mine 的卡(看板手建、只挂了 links)不动;没有 conversation 的不动', () => {
    const board = task()
    delete board.direction
    expect(itemTransitionOnSessionEnd(board, { kind: 'done', ts: END_TS })).toBeUndefined()
    const noConversation = task()
    delete noConversation.conversation
    expect(itemTransitionOnSessionEnd(noConversation, { kind: 'done', ts: END_TS })).toBeUndefined()
  })

  it('★人在会话结束之后改过的,以人为准:updated_at 晚于事件那一秒就不动', () => {
    const edited = task({ updated_at: '2026-09-16T10:00:05.000Z' })
    expect(itemTransitionOnSessionEnd(edited, { kind: 'done', ts: END_TS })).toBeUndefined()
    // 同一秒之内的(建事项那条路自己 move 到 doing 时盖的章)不算人改过
    const sameSecond = task({ updated_at: '2026-09-16T10:00:00.900Z' })
    expect(itemTransitionOnSessionEnd(sameSecond, { kind: 'done', ts: END_TS })).toBeDefined()
  })
})

describe('createButlerLifecycle(接 tasks 服务:找到那条事项、改状态、落盘、通知)', () => {
  function tempFile(): string {
    const dir = mkdtempSync(join(tmpdir(), 'wb-butler-lifecycle-'))
    dirs.push(dir)
    return join(dir, 'tasks.json')
  }

  async function harness(summary?: string) {
    let n = 0
    const tasks = createTasksService({ file: tempFile(), now: () => END_TS - 600, newId: () => `t-${++n}` })
    const onChanged = vi.fn()
    const lifecycle = createButlerLifecycle({ tasks, summaryOf: () => summary, onChanged })
    return { tasks, lifecycle, onChanged }
  }

  /**
   * `assignee` 点了名 = 这件活真派出去了(卡 Y 的判据之一)。**默认带上它**:不带的那一句
   * 从 2026-09-25 起算「随手问了一句」,会走另一个出口(下面单独一条钉它)。
   */
  async function createItem(tasks: ReturnType<typeof createTasksService>, sessionId = 's-1', over: { assignee?: 'codex' } = { assignee: 'codex' }) {
    const created = await tasks.create({ title: '把导出 PDF 做出来', direction: 'mine', status: 'todo', ...(over.assignee === undefined ? {} : { assignee: over.assignee }) })
    await tasks.update(created.id!, { conversation: { agent: 'dsh', session_id: sessionId }, links: [{ agent: 'dsh', session_id: sessionId }] })
    await tasks.move(created.id!, 'doing')
    return created.id!
  }

  it('★会话 done → 那条事项进「等我确认」,交付物落盘,归档章不盖(还没完结)', async () => {
    const { tasks, lifecycle, onChanged } = await harness('派给 Codex 做完了')
    const id = await createItem(tasks)
    await lifecycle.handleSessionEnd('s-1', { kind: 'done', ts: END_TS })
    const saved = (await tasks.list()).tasks.find(t => t.id === id)!
    expect(saved.status).toBe('confirm')
    expect(saved.deliverables).toEqual([{ kind: 'reply', ref: '派给 Codex 做完了', session_id: 's-1' }])
    expect(saved.conversation?.archived_at).toBeUndefined()
    expect(onChanged).toHaveBeenCalledTimes(1)
  })

  it('★会话 done 但只是问了一句 → 进「完成」、盖 casual 章、归档章跟着盖(这件事收场了)', async () => {
    const { tasks, lifecycle } = await harness('我是 DeepSeek-V3')
    const id = await createItem(tasks, 's-1', {})
    await lifecycle.handleSessionEnd('s-1', { kind: 'done', ts: END_TS, filesChanged: 0 })
    const saved = (await tasks.list()).tasks.find(t => t.id === id)!
    expect(saved.status).toBe('done')
    expect(saved.casual).toBe(true)
    expect(saved.deliverables).toEqual([{ kind: 'reply', ref: '我是 DeepSeek-V3', session_id: 's-1' }])
    // 对话原样留着(move 只盖归档章,不删会话):点开还能看那段话。
    expect(saved.conversation?.session_id).toBe('s-1')
  })

  it('会话 error → 阻塞 + 原话;aborted → 待办 + 你停了它', async () => {
    const { tasks, lifecycle } = await harness()
    const a = await createItem(tasks, 's-a')
    const b = await createItem(tasks, 's-b')
    await lifecycle.handleSessionEnd('s-a', { kind: 'error', ts: END_TS, detail: '额度不足' })
    await lifecycle.handleSessionEnd('s-b', { kind: 'aborted', ts: END_TS })
    const list = (await tasks.list()).tasks
    expect(list.find(t => t.id === a)).toMatchObject({ status: 'blocked', block_reason: 'error', note: '额度不足' })
    expect(list.find(t => t.id === b)).toMatchObject({ status: 'todo', note: STOPPED_NOTE })
    expect(list.find(t => t.id === b)?.block_reason).toBeUndefined()
  })

  it('没有这条会话的事项:什么都不动、不通知', async () => {
    const { tasks, lifecycle, onChanged } = await harness()
    await createItem(tasks, 's-1')
    await lifecycle.handleSessionEnd('s-unknown', { kind: 'done', ts: END_TS })
    expect((await tasks.list()).tasks[0]?.status).toBe('doing')
    expect(onChanged).not.toHaveBeenCalled()
  })

  it('同一条会话的结束报两遍(项目名补报那种)只过渡一次', async () => {
    const { tasks, lifecycle, onChanged } = await harness('答')
    const id = await createItem(tasks)
    await lifecycle.handleSessionEnd('s-1', { kind: 'done', ts: END_TS })
    await lifecycle.handleSessionEnd('s-1', { kind: 'done', ts: END_TS + 1 })
    const saved = (await tasks.list()).tasks.find(t => t.id === id)!
    expect(saved.deliverables).toHaveLength(1)
    expect(onChanged).toHaveBeenCalledTimes(1)
  })

  it('tasks 服务抛了也不往外抛(它挂在 DSH 的事件回调上)', async () => {
    const tasks = { list: async () => { throw new Error('disk') } } as unknown as ReturnType<typeof createTasksService>
    const lifecycle = createButlerLifecycle({ tasks })
    await expect(lifecycle.handleSessionEnd('s-1', { kind: 'done', ts: END_TS })).resolves.toBeUndefined()
  })
})
