// @vitest-environment node
/**
 * 「随手问一句不算一件事」(2026-09-25,卡 Y;`docs/决策记录.md` 同名那一节)。
 *
 * 维护者撞到的:在输入框里问一句,看板上多一张卡、办完还进「等你确认」、还要他验收(交接第九节第 3 条查清)。
 * 他拍的板 → 这里钉四件:
 *   1. 她答完自己判:没派出去、没改文件、没有要交回的东西 → 卡收掉(`done` + `casual` 章),不进「等我确认」;
 *   2. 他接着说一句挂到上一件,不新建(同一会话 + 还开着 + 10 分钟窗);
 *   3. 「只是问了一句」那张卡一条来电事件都不出(连「办完了」那条通知也不发);
 *   4. 各处一致:「等你」统一计数、收件箱、看板主视图都不算它。
 *
 * 走一整条的两句话(卡上点名要的验收):
 *   - 一句「一周有几天?」走完 → 0 件等你确认、0 通电话、对话里有回答;
 *   - 一句「把导出 PDF 派给 Codex」走完 → 1 件等你确认。
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { TaskView, WorkbenchState } from '../src/protocol.ts'
import type { WorkbenchServer } from '../src/server/http.ts'
import { startWorkbenchServer } from '../src/server/http.ts'
import { createWorkbenchService } from '../src/server/service.ts'
import { createTasksService } from '../src/server/tasks.ts'
import { CASUAL_ASK_NOTE, casualAskVerdict, isCasualAsk } from '../src/server/casualAsk.ts'
import { createButlerLifecycle } from '../src/server/butlerLifecycle.ts'
import { callOutEventsOf, taskCallOutEvent } from '../src/server/callOut.ts'
import { createDshSessionFeed } from '../src/server/dshSessionFeed.ts'
import { isCasualAskCard, tasksInCell, tasksInStatus, UNASSIGNED_LANE } from '../src/client/boardModel.ts'
import { waitingOnHim } from '../src/waiting.ts'

const NOW_MS = Date.parse('2026-09-25T21:00:00.000Z')

const started: WorkbenchServer[] = []
const dirs: string[] = []

afterEach(async () => {
  while (started.length) await started.pop()?.close()
  while (dirs.length) rmSync(dirs.pop() as string, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
})

function tempFile(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  dirs.push(dir)
  return join(dir, 'tasks.json')
}

function task(over: Partial<TaskView> = {}): TaskView {
  return {
    id: 't-1', title: '一周有几天?', status: 'doing', direction: 'mine', origin: 'user', source: { kind: 'manual' },
    conversation: { agent: 'dsh', session_id: 's-1' }, links: [{ agent: 'dsh', session_id: 's-1' }],
    created_at: '2026-09-25T20:59:00.000Z', updated_at: '2026-09-25T20:59:00.000Z',
    ...over,
  }
}

// ———————————————————————— 判据:算不算一件事 ————————————————————————

describe('casualAskVerdict:三问全是数出来的事实', () => {
  it('★三问全否 → 只是问了一句', () => {
    // `asksHim`(2026-09-27,卡 MS):第四问 —— 她那段回答是在问他吗。
    expect(casualAskVerdict(task())).toEqual({ real: false, dispatched: false, touchedFiles: false, madeSomething: false, asksHim: false })
    expect(isCasualAsk(task())).toBe(true)
  })

  it('★派出去了(卡上有派活记录)→ 算一件事', () => {
    const dispatched = task({ dispatch: { family: 'codex', status: 'done', cwd: '/x', started_at: '2026-09-25T20:59:30.000Z' } })
    expect(casualAskVerdict(dispatched)).toMatchObject({ real: true, dispatched: true })
  })

  it('他点了名要别家做 → 算一件事(派没派成是另一件事,不能因此把卡收掉)', () => {
    expect(casualAskVerdict(task({ assignee: 'codex' })).real).toBe(true)
    // 「她自己办」不算派出去 —— 每一张事务官的卡都是它办的,那这条判据就白写了。
    expect(casualAskVerdict(task({ assignee: 'dsh' })).real).toBe(false)
  })

  it('把话送进那家客户端窗口 / 自发版那条闭环 / 挑不到手 → 都算派出去了', () => {
    expect(casualAskVerdict(task({ client_dispatch: { hand: 'window', family: 'claude', status: 'sent', at: NOW_ISO(), text: '把 X 做一下' } })).dispatched).toBe(true)
    expect(casualAskVerdict(task({ self_ship: { status: 'running', branch: 'feat/x', started_at: NOW_ISO() } })).dispatched).toBe(true)
    // 派活挑不到能做这件活的手(卡 O):**没派成也算一件事** —— 它正等他去修。
    expect(casualAskVerdict(task({ dispatch_block: { family: 'claude', kind: 'code', why: 'Claude 没登录', at: NOW_ISO() } })).dispatched).toBe(true)
  })

  it('★改了文件 → 算一件事(文件数从会话那头报上来)', () => {
    expect(casualAskVerdict(task(), { filesChanged: 2 })).toMatchObject({ real: true, touchedFiles: true })
    expect(casualAskVerdict(task(), { filesChanged: 0 }).real).toBe(false)
    // 缺席 = 数不出来,按 0 处理(**不猜**)。
    expect(casualAskVerdict(task(), {}).real).toBe(false)
  })

  it('★有要交回的东西(文件 / 链接)→ 算一件事;只有一段回答不算', () => {
    expect(casualAskVerdict(task({ deliverables: [{ kind: 'url', ref: 'https://a' }] })).madeSomething).toBe(true)
    expect(casualAskVerdict(task({ deliverables: [{ kind: 'reply', ref: '一周七天', session_id: 's-1' }] })).madeSomething).toBe(false)
  })
})

function NOW_ISO(): string {
  return new Date(NOW_MS).toISOString()
}

// ———————————————————————— 会话结束 → 卡自己收掉 ————————————————————————

describe('会话答完 → 她自己判这一件算不算「事」', () => {
  it('★只是问了一句 → 卡进「完成」、盖 casual 章、note 说「只是问了一句」,回答照样挂上', async () => {
    const file = tempFile('wb-casual-life-')
    let n = 0
    const tasks = createTasksService({ file, now: () => Math.floor(NOW_MS / 1000), newId: () => `t-${++n}` })
    const created = await tasks.create({ title: '一周有几天?', direction: 'mine', origin: 'user', status: 'todo', conversation: { agent: 'dsh', session_id: 's-1' } })
    await tasks.move(created.id as string, 'doing')
    const lifecycle = createButlerLifecycle({ tasks, summaryOf: () => '七天。' })
    await lifecycle.handleSessionEnd('s-1', { kind: 'done', ts: Math.floor(NOW_MS / 1000), filesChanged: 0 })

    const card = (await tasks.list()).tasks[0] as TaskView
    expect(card.status).toBe('done')
    expect(card.casual).toBe(true)
    expect(card.note).toBe(CASUAL_ASK_NOTE)
    // 对话记录保留:她说的那段话还在卡上(点开就是那段对话)。
    expect(card.deliverables).toEqual([{ kind: 'reply', ref: '七天。', session_id: 's-1' }])
  })

  it('★改过文件 → 照旧进「等我确认」,不盖章', async () => {
    const file = tempFile('wb-casual-life2-')
    let n = 0
    const tasks = createTasksService({ file, now: () => Math.floor(NOW_MS / 1000), newId: () => `t-${++n}` })
    const created = await tasks.create({ title: '把标题改一下', direction: 'mine', origin: 'user', status: 'todo', conversation: { agent: 'dsh', session_id: 's-2' } })
    await tasks.move(created.id as string, 'doing')
    const lifecycle = createButlerLifecycle({ tasks, summaryOf: () => '改好了' })
    await lifecycle.handleSessionEnd('s-2', { kind: 'done', ts: Math.floor(NOW_MS / 1000), filesChanged: 1 })

    const card = (await tasks.list()).tasks[0] as TaskView
    expect(card.status).toBe('confirm')
    expect(card.casual).toBeUndefined()
  })

  it('他把收掉的那张从「完成」拖回「进行中」→ 章擦掉(人改过的以人为准)', async () => {
    const file = tempFile('wb-casual-reopen-')
    let n = 0
    const tasks = createTasksService({ file, now: () => Math.floor(NOW_MS / 1000), newId: () => `t-${++n}` })
    const created = await tasks.create({ title: '问一句', direction: 'mine', origin: 'user', status: 'todo' })
    const id = created.id as string
    await tasks.move(id, 'doing')
    await tasks.update(id, { casual: true })
    await tasks.move(id, 'done')
    expect((await tasks.list()).tasks[0]?.casual).toBe(true)
    await tasks.move(id, 'doing')
    expect((await tasks.list()).tasks[0]?.casual).toBeUndefined()
  })
})

describe('会话那头把「改了几个文件」报上来', () => {
  it('★写类工具调过 → turn/end 那一刻 filesChanged 跟着报给事项那边', () => {
    const ends: { sessionId: string, filesChanged?: number }[] = []
    const feed = createDshSessionFeed({
      applyEvent: () => {}, setMetrics: () => {}, now: () => Math.floor(NOW_MS / 1000),
      onSessionEnd: (sessionId, end) => ends.push({ sessionId, ...(end.filesChanged === undefined ? {} : { filesChanged: end.filesChanged }) }),
    })
    feed.handleCreated('s-9', '/tmp/x')
    feed.handleEvent('s-9', { type: 'turn/start' })
    feed.handleEvent('s-9', { type: 'tool/call', data: { name: 'edit', arguments: JSON.stringify({ file_path: '/tmp/x/a.ts' }) } })
    feed.handleEvent('s-9', { type: 'turn/end', data: { reason: { kind: 'stop' } } })
    expect(ends).toEqual([{ sessionId: 's-9', filesChanged: 1 }])
  })

  it('一个文件都没动 → 报 0(不是缺席:数得出来就说出来)', () => {
    const ends: number[] = []
    const feed = createDshSessionFeed({
      applyEvent: () => {}, setMetrics: () => {}, now: () => Math.floor(NOW_MS / 1000),
      onSessionEnd: (_id, end) => ends.push(end.filesChanged ?? -1),
    })
    feed.handleEvent('s-10', { type: 'turn/start' })
    feed.handleEvent('s-10', { type: 'turn/end', data: { reason: { kind: 'stop' } } })
    expect(ends).toEqual([0])
  })
})

// ———————————————————————— 打电话的范围 ————————————————————————

describe('「只是问了一句」不打电话、也不通知「办完了」', () => {
  it('★盖了章的那张卡一条来电事件都不出', () => {
    const casual = task({ status: 'done', casual: true, done_at: NOW_ISO(), deliverables: [{ kind: 'reply', ref: '七天。', session_id: 's-1' }] })
    expect(taskCallOutEvent(casual)).toBeUndefined()
    expect(callOutEventsOf({ tasks: { tasks: [casual], sprints: [], modules: [], project_meta: [] } })).toEqual([])
  })

  it('只回一段话又走到「等我确认」的(他自己拖进去的)→ 只通知,带 quiet:chat', () => {
    const event = taskCallOutEvent(task({ status: 'confirm', deliverables: [{ kind: 'reply', ref: '七天。', session_id: 's-1' }], owner_ask: { kind: 'spend' as const, proposal: '买这个', basis: '核过的事实', by: 'butler', at: '2026-09-25T20:59:00.000Z' } }))
    expect(event?.quiet).toBe('chat')
  })

  it('★派出去了 / 交回了文件的「等我确认」→ 照响(不带 quiet)', () => {
    expect(taskCallOutEvent(task({ status: 'confirm', assignee: 'codex', owner_ask: { kind: 'spend' as const, proposal: '买这个', basis: '核过的事实', by: 'butler', at: '2026-09-25T20:59:00.000Z' } }))?.quiet).toBeUndefined()
    expect(taskCallOutEvent(task({ status: 'confirm', deliverables: [{ kind: 'file', ref: '/tmp/a.pdf' }], owner_ask: { kind: 'spend' as const, proposal: '买这个', basis: '核过的事实', by: 'butler', at: '2026-09-25T20:59:00.000Z' } }))?.quiet).toBeUndefined()
  })
})

// ———————————————————————— 各处一致 ————————————————————————

describe('各处都不算它', () => {
  const casual = task({ status: 'done', casual: true, done_at: NOW_ISO() })

  it('★「等你」统一计数里没有它(它连 confirm 都没进)', () => {
    expect(waitingOnHim({ butler_inbox: { items: [], executing: 0 } }).count).toBe(0)
  })

  it('★看板主视图上不占位(泳道格与「按状态」那一列都挑掉)', () => {
    expect(isCasualAskCard(casual)).toBe(true)
    expect(tasksInCell([casual], [], undefined, UNASSIGNED_LANE, 'done')).toEqual([])
    expect(tasksInStatus([casual], undefined, 'done')).toEqual([])
    // 没盖章的完成卡照旧在格子里 —— 挑掉的只有这一种。
    const normal = task({ id: 't-2', status: 'done', done_at: NOW_ISO() })
    expect(tasksInStatus([normal], undefined, 'done').map(one => one.id)).toEqual(['t-2'])
  })
})
