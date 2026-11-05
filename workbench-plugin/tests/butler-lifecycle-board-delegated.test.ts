// @vitest-environment node
/**
 * **看板上交给事务官的卡也收尾、也通知**(2026-10-03,运营维护包审计末节第三项)。
 *
 * 负责人驱动把看板上写着「事务官」的卡交给她(`startButlerOnItem`):开一条 DSH 会话、挂 `conversation`、
 * 挪进行中 —— 可这张卡没有 `direction:'mine'`(那一格只落在收件箱建出来的那批上),生命周期与来电都只认 mine,
 * 于是会话办完了、卡一直停在「进行中」,也不叫她。
 *
 * 收窄的边界(审计里那张对照表第 4 条:直接改成 isTrackedItem 会把「我自己的待办」「同事的」也拉进来):
 * 只认**有委托证据**的那一种 —— 负责人是事务官、而且挂着她那条 DSH 会话。按**结束的那条会话**认卡;
 * 他按了停照旧回待办、写「你停了它」(不是故障)。
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { TaskView } from '../src/protocol.ts'
import { createTasksService } from '../src/server/tasks.ts'
import { STOPPED_NOTE, createButlerLifecycle, itemTransitionOnSessionEnd } from '../src/server/butlerLifecycle.ts'
import { delegatedToButler } from '../src/server/butlerItem.ts'
import { taskCallOutEvent } from '../src/server/callOut.ts'

const END_TS = Math.floor(Date.parse('2026-10-03T10:00:00Z') / 1000)

const dirs: string[] = []
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop() as string, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
})

/** 看板上的一张卡(没有 direction),负责人驱动交给了事务官:startButlerOnItem 落下的那个形状。 */
function boardCard(over: Partial<TaskView> = {}): TaskView {
  return {
    id: 'b-1', title: '整理十月选题会纪要', status: 'doing', assignee: 'dsh', source: { kind: 'manual' },
    conversation: { agent: 'dsh', session_id: 's-board' }, links: [{ agent: 'dsh', session_id: 's-board' }],
    created_at: '2026-10-03T09:00:00.000Z', updated_at: '2026-10-03T09:00:00.000Z',
    ...over,
  }
}

describe('谁算「交给事务官的」', () => {
  it('收件箱建的(mine)照旧算;看板上负责人是事务官、挂着她那条会话的也算', () => {
    const { assignee: _a, ...inbox } = boardCard({ direction: 'mine' })
    expect(delegatedToButler(inbox)).toBe(true)
    expect(delegatedToButler(boardCard())).toBe(true)
  })

  it('★我自己的待办、同事的、别人的:不算(就算卡上挂着一条会话)', () => {
    for (const assignee of ['me', 'colleague', 'other'] as const) {
      expect(delegatedToButler(boardCard({ assignee })), assignee).toBe(false)
    }
  })

  it('负责人是事务官但还没开会话 / 会话不是她的 / 选题池的卡:不算', () => {
    const { conversation: _, ...noSession } = boardCard()
    expect(delegatedToButler(noSession)).toBe(false)
    expect(delegatedToButler({ ...boardCard(), conversation: { agent: 'codex', session_id: 'x' } as never })).toBe(false)
    expect(delegatedToButler(boardCard({ kind: 'topic' }))).toBe(false)
  })
})

describe('itemTransitionOnSessionEnd:看板上交给事务官的卡', () => {
  it('★会话办完 → 等我确认,交付物记在结束的那条会话上(不收成「只是问了一句」:这是她摆在看板上的一件事)', () => {
    const next = itemTransitionOnSessionEnd(boardCard(), { kind: 'done', ts: END_TS, filesChanged: 0 }, '纪要整理好了')
    expect(next).toEqual({
      status: 'confirm',
      update: { deliverables: [{ kind: 'reply', ref: '纪要整理好了', session_id: 's-board' }], note: null },
    })
  })

  it('★他按了停 → 回待办、写「你停了它」(不是故障)', () => {
    expect(itemTransitionOnSessionEnd(boardCard(), { kind: 'aborted', ts: END_TS })).toEqual({ status: 'todo', update: { note: STOPPED_NOTE } })
  })

  it('我自己的待办挂着会话、会话办完:不动', () => {
    expect(itemTransitionOnSessionEnd(boardCard({ assignee: 'me' }), { kind: 'done', ts: END_TS }, 'x')).toBeUndefined()
  })
})

describe('createButlerLifecycle:按结束的那条会话认卡', () => {
  function tempFile(): string {
    const dir = mkdtempSync(join(tmpdir(), 'wb-board-delegated-'))
    dirs.push(dir)
    return join(dir, 'tasks.json')
  }

  async function board() {
    let n = 0
    const tasks = createTasksService({ file: tempFile(), now: () => END_TS - 600, newId: () => `t-${++n}` })
    const delegated = await tasks.create({ title: '整理十月选题会纪要', assignee: 'dsh', status: 'todo' })
    const mine = await tasks.create({ title: '给妈妈打电话', assignee: 'me', status: 'todo' })
    for (const [id, session] of [[delegated.id, 's-board'], [mine.id, 's-me']] as const) {
      await tasks.update(id as string, { conversation: { agent: 'dsh', session_id: session }, links: [{ agent: 'dsh', session_id: session }] })
      await tasks.move(id as string, 'doing')
    }
    return { tasks, delegatedId: delegated.id as string, mineId: mine.id as string }
  }

  it('★看板上交给事务官的那张:会话办完挪到「等我确认」', async () => {
    const { tasks, delegatedId } = await board()
    const lifecycle = createButlerLifecycle({ tasks, summaryOf: () => '纪要整理好了' })
    await lifecycle.handleSessionEnd('s-board', { kind: 'done', ts: END_TS })
    const card = (await tasks.list()).tasks.find(one => one.id === delegatedId)
    expect(card?.status).toBe('confirm')
    expect(card?.deliverables).toEqual([{ kind: 'reply', ref: '纪要整理好了', session_id: 's-board' }])
  })

  it('我自己那张挂着的会话结束了:不动', async () => {
    const { tasks, mineId } = await board()
    const lifecycle = createButlerLifecycle({ tasks, summaryOf: () => '好' })
    await lifecycle.handleSessionEnd('s-me', { kind: 'done', ts: END_TS })
    expect((await tasks.list()).tasks.find(one => one.id === mineId)?.status).toBe('doing')
  })

  it('★只挂在 links 里的旧会话结束了:不把它的结果记到这张卡的当前会话上', async () => {
    const { tasks, delegatedId } = await board()
    await tasks.update(delegatedId, { links: [{ agent: 'dsh', session_id: 's-old' }, { agent: 'dsh', session_id: 's-board' }] })
    const lifecycle = createButlerLifecycle({ tasks, summaryOf: () => '旧会话的话' })
    await lifecycle.handleSessionEnd('s-old', { kind: 'done', ts: END_TS })
    const card = (await tasks.list()).tasks.find(one => one.id === delegatedId)
    expect(card?.status).toBe('doing')
    expect(card?.deliverables ?? []).toEqual([])
  })
})

describe('taskCallOutEvent:通知范围', () => {
  it('★看板上交给事务官的那张进「等我确认」→ 有一条事件', () => {
    const event = taskCallOutEvent(boardCard({ status: 'confirm', deliverables: [{ kind: 'reply', ref: '好了', session_id: 's-board' }], owner_ask: { kind: 'spend' as const, proposal: '买这个', basis: '核过的事实', by: 'butler', at: 'x' } }))
    expect(event?.item_id).toBe('b-1')
  })

  it('★我自己的待办 / 同事的做完了:一条都不出(审计对照第 4 条的反例)', () => {
    for (const assignee of ['me', 'colleague'] as const) {
      const { conversation: _, ...plain } = boardCard({ assignee, status: 'done', done_at: '2026-10-03T10:00:00.000Z' })
      expect(taskCallOutEvent(plain), assignee).toBeUndefined()
    }
  })
})
