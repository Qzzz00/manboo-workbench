// @vitest-environment node
/**
 * 座机主动来电的**触发规则**(2026-09-21,Ben:「待确认 / 运行失败 / 完成提醒时座机响铃」)。
 *
 * 这一份钉的是四条规矩,一条一节:
 *   ① 三类事件各自从哪个已有事实源来,以及「只认 direction:'mine'」那道闸;
 *   ② 等确认 / 失败立刻,完成要等合并窗、窗里的并成一通;
 *   ③ 夜间静默时段**照打但只发通知**(不是「不打」);
 *   ④ 同一件事的同一个理由只打一次,没接就记未接。
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { CallOutEntry, RoutinesView, TaskView, TasksState, WorkbenchState } from '../src/protocol.ts'
import { BUTLER_SESSION_OFFLINE_NOTE, CALL_OUT_SILENT_REASONS } from '../src/protocol.ts'
import { callOutLine } from '../src/client/callOutLine.ts'
import {
  CALL_OUT_MERGE_WINDOW_MS,
  CALL_OUT_RING_STALE_MS,
  callOutEventsOf,
  callOutKey,
  createCallOutService,
  dismissMissedEntries,
  defaultCallOutConfig,
  emptyCallOutFile,
  inQuietHours,
  lastAskRing,
  liveCallFor,
  loadCallOutFile,
  parseClock,
  planCallOuts,
  sanitizeCallOutConfig,
  saveCallOutFile,
  taskCallOutEvent,
} from '../src/server/callOut.ts'

const dirs: string[] = []
function tmpFile(): string {
  const dir = mkdtempSync(join(tmpdir(), 'wb-call-out-'))
  dirs.push(dir)
  return join(dir, 'call-out.json')
}
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })

function task(patch: Partial<TaskView> & Pick<TaskView, 'id' | 'status'>): TaskView {
  return {
    title: `卡 ${patch.id}`,
    direction: 'mine',
    source: 'manual',
    created_at: '2026-09-21T09:00:00.000Z',
    updated_at: '2026-09-21T10:00:00.000Z',
    ...patch,
  } as TaskView
}

/**
 * 标了四类拍板请求的「等我确认」(2026-10-26,卡「事务官页接管队列」):事务官核过、带方案与依据,
 * 才通知 / 响。没标的(confirm 裸卡)一条都不出 —— 待核验队列不摊给他,未知不自动放行。
 */
function confirmAsked(patch: Partial<TaskView> & Pick<TaskView, 'id'>): TaskView {
  return task({
    ...patch,
    status: 'confirm',
    owner_ask: { kind: 'spend', proposal: '买这个', basis: '核过的事实', by: 'butler', at: '2026-09-21T10:00:00.000Z' },
  })
}

function board(tasks: readonly TaskView[]): TasksState {
  return { tasks, sprints: [], modules: [], project_meta: [] } as unknown as TasksState
}

function routines(last: RoutinesView['last']): RoutinesView {
  return { next: {}, last, running: [], config: { morning: { enabled: true, not_before: '08:00' }, evening: { enabled: true, at: '19:00' }, lint: { enabled: true, weekday: 5 } } }
}

// ———————————————————————— ① 事件从哪来 ————————————————————————

describe('三类事件复用已有事实源', () => {
  it('「等我确认」的卡 → confirm,交付物件数原样写进 note', () => {
    const events = callOutEventsOf({ tasks: board([confirmAsked({ id: 'a', deliverables: [{ kind: 'reply', ref: '答完了' }] })]) })
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({ reason: 'confirm', item_id: 'a', note: '1 件交付物' })
  })

  it('「等我确认」但没标四类拍板请求 → 一条都不出(2026-10-26,卡「事务官页接管队列」):待核验队列不摊给他,未知不自动放行', () => {
    expect(callOutEventsOf({ tasks: board([task({ id: 'a', status: 'confirm', deliverables: [{ kind: 'reply', ref: '答完了' }] })]) })).toEqual([])
    // 类别认不出(坏形状)同样不出。
    const bad = task({ id: 'a', status: 'confirm', owner_ask: { kind: 'unknown' as never, proposal: 'x', basis: 'y', at: '2026-09-21T10:00:00.000Z' } })
    expect(callOutEventsOf({ tasks: board([bad]) })).toEqual([])
  })

  it('阻塞且 block_reason=error → failed,DSH 给的原话原样带走', () => {
    const events = callOutEventsOf({ tasks: board([task({ id: 'b', status: 'blocked', block_reason: 'error', note: '模型回了 500' })]) })
    expect(events[0]).toMatchObject({ reason: 'failed', item_id: 'b', note: '模型回了 500' })
  })

  it('阻塞但原因不是 error(他自己标的「等人」)→ 一条都不出', () => {
    expect(callOutEventsOf({ tasks: board([task({ id: 'c', status: 'blocked', block_reason: 'approval' })]) })).toEqual([])
  })

  it('完成 → done', () => {
    const events = callOutEventsOf({ tasks: board([task({ id: 'd', status: 'done', done_at: '2026-09-21T11:00:00.000Z' })]) })
    expect(events[0]).toMatchObject({ reason: 'done', item_id: 'd', at: '2026-09-21T11:00:00.000Z' })
  })

  it('**不是 direction:mine 的卡一条都不打** —— 他自己摆的待办不该让座机响', () => {
    const plain = { ...task({ id: 'e', status: 'confirm' }) } as Record<string, unknown>
    delete plain.direction
    expect(callOutEventsOf({ tasks: board([plain as unknown as TaskView]) })).toEqual([])
  })

  it('例程跑失败 → failed;跑完 → done;skipped 不打(DSH 不在线是常事)', () => {
    const events = callOutEventsOf({
      routines: routines({
        morning: { name: 'morning', date: '2026-09-21', trigger: 'schedule', started_at: '2026-09-21T09:00:00.000Z', status: 'ok', report: '三句' },
        evening: { name: 'evening', date: '2026-09-21', trigger: 'schedule', started_at: '2026-09-21T19:00:00.000Z', status: 'failed', note: '写不进仓库' },
        lint: { name: 'lint', date: '2026-09-21', trigger: 'schedule', started_at: '2026-09-21T20:00:00.000Z', status: 'skipped' },
      }),
    })
    expect(events.map(one => `${one.reason}:${one.item_id}`)).toEqual([
      'done:routine:morning:2026-09-21',
      'failed:routine:evening:2026-09-21',
    ])
  })

  /**
   * 兄弟路(2026-10-13):DSH 不在线时的早报从 `skipped` 改成了 `no_session` + `session_offline`
   * (程序拼的那一半照出,见 routines.ts 文件头),于是**这一通照打** —— 与「会话开不出来」那一份一样。
   * 跳过的那两条(下班例程 / 知识 lint)仍然不打。
   */
  it('DSH 不在线时的早报(no_session + session_offline)照打一通「完成」;跳过的那两条仍不打', () => {
    const events = callOutEventsOf({
      routines: routines({
        morning: {
          name: 'morning', date: '2026-10-13', trigger: 'sighting', started_at: '2026-10-13T01:00:00.000Z',
          status: 'no_session', session_offline: true, report: '三句', note: BUTLER_SESSION_OFFLINE_NOTE,
        },
        evening: { name: 'evening', date: '2026-10-13', trigger: 'schedule', started_at: '2026-10-13T10:30:00.000Z', status: 'skipped', note: 'DSH 不在线,这次跳过' },
      }),
    })
    expect(events.map(one => `${one.reason}:${one.item_id}`)).toEqual(['done:routine:morning:2026-10-13'])
    expect(events[0]?.note).toBe(BUTLER_SESSION_OFFLINE_NOTE)
  })

  it('两个事实源都没接上时就是空列表,不为了凑数编一条', () => {
    expect(callOutEventsOf({})).toEqual([])
  })
})

// ———————————————————————— ③ 静默时段 ————————————————————————

describe('夜间静默时段', () => {
  it('跨零点的 23:00–08:00:深夜与清晨都在里头,中午不在', () => {
    expect(inQuietHours(new Date('2026-09-21T23:30:00'), '23:00', '08:00')).toBe(true)
    expect(inQuietHours(new Date('2026-09-21T07:59:00'), '23:00', '08:00')).toBe(true)
    expect(inQuietHours(new Date('2026-09-21T08:00:00'), '23:00', '08:00')).toBe(false)
    expect(inQuietHours(new Date('2026-09-21T12:00:00'), '23:00', '08:00')).toBe(false)
  })

  it('不跨零点的也认', () => {
    expect(inQuietHours(new Date('2026-09-21T13:30:00'), '13:00', '14:00')).toBe(true)
    expect(inQuietHours(new Date('2026-09-21T14:00:00'), '13:00', '14:00')).toBe(false)
  })

  it('**时刻读不出来就当不静默** —— 别替他静音,那会让他以为座机坏了', () => {
    expect(parseClock('25:00')).toBeUndefined()
    expect(parseClock('八点')).toBeUndefined()
    expect(inQuietHours(new Date('2026-09-21T23:30:00'), '八点', '08:00')).toBe(false)
  })
})

// ———————————————————————— ② 立刻 / 合并 ————————————————————————

describe('排电话:立刻与合并窗', () => {
  const now = Date.parse('2026-09-21T14:00:00+08:00')
  const quiet = { from: '23:00', to: '08:00' }
  let seq = 0
  const newId = () => `call-${++seq}`

  it('等确认与失败立刻(due_at = 现在),完成要等一个合并窗', () => {
    seq = 0
    const plan = planCallOuts({
      events: [
        { key: callOutKey('confirm', 'a'), reason: 'confirm', item_id: 'a', title: '甲', at: '2026-09-21T05:00:00.000Z' },
        { key: callOutKey('done', 'b'), reason: 'done', item_id: 'b', title: '乙', at: '2026-09-21T05:01:00.000Z' },
      ],
      seen: new Set(), waiting: [], now, quiet, newId,
    })
    expect(plan.created).toHaveLength(2)
    expect(Date.parse(plan.created[0]!.due_at)).toBe(now)
    expect(Date.parse(plan.created[1]!.due_at)).toBe(now + CALL_OUT_MERGE_WINDOW_MS)
  })

  it('同一拍里的几条「完成」并成一通;已经排着的那一通也并得进去', () => {
    seq = 0
    const plan = planCallOuts({
      events: [
        { key: callOutKey('done', 'b'), reason: 'done', item_id: 'b', title: '乙', at: '2026-09-21T05:01:00.000Z' },
        { key: callOutKey('done', 'c'), reason: 'done', item_id: 'c', title: '丙', at: '2026-09-21T05:02:00.000Z' },
        { key: callOutKey('done', 'd'), reason: 'done', item_id: 'd', title: '丁', at: '2026-09-21T05:03:00.000Z' },
      ],
      seen: new Set(), waiting: [], now, quiet, newId,
    })
    expect(plan.created).toHaveLength(1)
    expect(plan.merged.map(one => one.event.item_id)).toEqual(['c', 'd'])
  })

  it('静默时段里照打,只是这一通带 silent —— 不是「不打」', () => {
    seq = 0
    const night = Date.parse('2026-09-22T01:00:00+08:00')
    const plan = planCallOuts({
      events: [{ key: callOutKey('confirm', 'a'), reason: 'confirm', item_id: 'a', title: '甲', at: '2026-09-21T17:00:00.000Z' }],
      seen: new Set(), waiting: [], now: night, quiet, newId,
    })
    expect(plan.created[0]!.silent).toBe(true)
    expect(plan.created[0]!.state).toBe('queued')
  })

  it('打过了的不再打', () => {
    seq = 0
    const plan = planCallOuts({
      events: [{ key: callOutKey('confirm', 'a'), reason: 'confirm', item_id: 'a', title: '甲', at: '2026-09-21T05:00:00.000Z' }],
      seen: new Set([callOutKey('confirm', 'a')]), waiting: [], now, quiet, newId,
    })
    expect(plan.created).toEqual([])
    expect(plan.seen).toEqual([])
  })

  it('**这件事已经因为「等确认」打过了,它后来变成「完成」就不再打**(那通电话里他已经处理过)', () => {
    seq = 0
    const plan = planCallOuts({
      events: [{ key: callOutKey('done', 'a'), reason: 'done', item_id: 'a', title: '甲', at: '2026-09-21T06:00:00.000Z' }],
      seen: new Set([callOutKey('confirm', 'a')]), waiting: [], now, quiet, newId,
    })
    expect(plan.created).toEqual([])
    // 但要记上,否则下一拍又算一遍。
    expect(plan.seen).toEqual([callOutKey('done', 'a')])
  })
})

// ———————————————————————— A1:「完成」那一类只发通知,不打电话 ————————————————————————

/**
 * 2026-09-22 Ben 拍的板(决策记录「待拍板清单回复」A1):
 * 「『完成』类只发通知不打电话;早报也只通知,用户自己点开。」
 *
 * 落法是**复用夜间静默那条现成的通知路**(`silent:true` → 手机只弹一条通知、台账记 `notified`),
 * 不新开一条「通知」协议。`silent_reason` 记下这一通为什么没响 —— 「完成策略」与「夜间」
 * 是两回事,混成一个 `silent:true` 的话,他把静默时段改回去会以为完成类又该响了。
 */
describe('A1:「完成」只通知,「等确认 / 失败」照旧打', () => {
  const now = Date.parse('2026-09-21T14:00:00+08:00')
  const quiet = { from: '23:00', to: '08:00' }
  let seq = 0
  const newId = () => `call-${++seq}`

  it('缺省(done_call 关着):完成那一通 silent、原因是「完成策略」;等确认那一通照旧响', () => {
    seq = 0
    const plan = planCallOuts({
      events: [
        { key: callOutKey('confirm', 'a'), reason: 'confirm', item_id: 'a', title: '甲', at: '2026-09-21T05:00:00.000Z' },
        { key: callOutKey('done', 'b'), reason: 'done', item_id: 'b', title: '乙', at: '2026-09-21T05:01:00.000Z' },
      ],
      seen: new Set(), waiting: [], now, quiet, newId,
    })
    // 2026-09-28(卡 UX):「办完了等你验收」与「完成」同一个开关 —— 关着时两类都只发通知,原因分开记。
    expect(plan.created[0]).toMatchObject({ reason: 'confirm', silent: true, silent_reason: 'confirm' })
    expect(plan.created[1]).toMatchObject({ reason: 'done', silent: true, silent_reason: 'done' })
  })

  it('失败那一类一个字没变:照旧立刻、照旧响', () => {
    seq = 0
    const plan = planCallOuts({
      events: [{ key: callOutKey('failed', 'c'), reason: 'failed', item_id: 'c', title: '丙', at: '2026-09-21T05:00:00.000Z' }],
      seen: new Set(), waiting: [], now, quiet, newId,
    })
    expect(plan.created[0]).toMatchObject({ reason: 'failed', silent: false })
    expect(Date.parse(plan.created[0]!.due_at)).toBe(now)
  })

  it('他在设置里把「完成也打给我」打开:完成那一通就响(合并窗照旧)', () => {
    seq = 0
    const plan = planCallOuts({
      events: [{ key: callOutKey('done', 'b'), reason: 'done', item_id: 'b', title: '乙', at: '2026-09-21T05:01:00.000Z' }],
      seen: new Set(), waiting: [], now, quiet, newId, doneCall: true,
    })
    expect(plan.created[0]).toMatchObject({ reason: 'done', silent: false })
    expect(Date.parse(plan.created[0]!.due_at)).toBe(now + CALL_OUT_MERGE_WINDOW_MS)
  })

  it('夜里的完成:silent 照旧,但原因记的是**夜间**(改回完成也打给我,它夜里还是不响)', () => {
    seq = 0
    const night = Date.parse('2026-09-22T01:00:00+08:00')
    const plan = planCallOuts({
      events: [{ key: callOutKey('done', 'b'), reason: 'done', item_id: 'b', title: '乙', at: '2026-09-21T17:00:00.000Z' }],
      seen: new Set(), waiting: [], now: night, quiet, newId, doneCall: true,
    })
    expect(plan.created[0]).toMatchObject({ silent: true, silent_reason: 'quiet' })
  })

  it('**早报例程跑完也只通知**(routine 那一条走的就是 done)', () => {
    seq = 0
    const events = callOutEventsOf({
      routines: routines({
        morning: { name: 'morning', date: '2026-09-21', trigger: 'schedule', started_at: '2026-09-21T09:00:00.000Z', status: 'ok', report: '三句' },
      } as RoutinesView['last']),
    })
    const plan = planCallOuts({ events, seen: new Set(), waiting: [], now, quiet, newId })
    // 2026-09-28(卡 UX):例程那一条的原因记成 `routine`(座机不为例程响,连「办完了也打给我」都不认)。
    expect(plan.created[0]).toMatchObject({ reason: 'done', silent: true, silent_reason: 'routine' })
  })

  it('缺省值就是「完成 = 只通知」;设置里改得动,坏值不改它', () => {
    expect(defaultCallOutConfig().done_call).toBe(false)
    expect(sanitizeCallOutConfig({ done_call: true }, defaultCallOutConfig()).done_call).toBe(true)
    expect(sanitizeCallOutConfig({ done_call: '是' }, defaultCallOutConfig()).done_call).toBe(false)
  })
})

// ——————— 2026-09-22 真机台账逮到的三件事(docs/交接-0922-完成类来电与重复排通.md) ———————

/**
 * 8791 的 `GET /call/log` 上那八条:七条 `reason:'done'`、`silent:false`、`state:'missed'`,
 * 全是同一件 `routine:evening:2026-09-20` —— 两天前那次下班例程。Ben 看到的是
 * **「下班待办」的电话一分钟一通地打了六分钟**。
 *
 * 台账把三条路各自钉死了:
 *   ① 那七条里有六条 `queued_at === at === due_at`(没有合并窗)→ 走的是手动那条 `request()`,
 *     而它**没有套 A1 的完成策略**,所以 `done_call` 关着照样响。
 *   ② 五条排在 07:37:05–07:37:10 的五秒里 → 手动那条**一次去重都没有**:
 *     上一通还排着 / 还在响,再点一次照样再排一通。
 *   ③ 最早那一条 `at` 是 09-20T10:30Z、`queued_at` 却是 09-21T09:39Z —— 隔了 23 小时。
 *     「完成」是一条**汇报**,没有时效上限的话,一件两天前办完的事在任何一次
 *     「台账里还没有它的记号」时(重启、换机器、台账重建)都会排出一通电话来。
 */
describe('2026-09-22:完成类响了、五秒排五通、两天前的例程', () => {
  const now = Date.parse('2026-09-21T14:00:00+08:00')
  const quiet = { from: '23:00', to: '08:00' }

  it('③ 两天前才办完的「完成」不再排电话(照旧记进 seen,下一拍不重算)', () => {
    const plan = planCallOuts({
      events: [{ key: callOutKey('done', 'routine:evening:2026-09-19'), reason: 'done', item_id: 'routine:evening:2026-09-19', title: '下班例程', at: '2026-09-19T10:30:00.000Z' }],
      seen: new Set(), waiting: [], now, quiet, newId: () => 'call-1',
    })
    expect(plan.created).toEqual([])
    expect(plan.seen).toEqual([callOutKey('done', 'routine:evening:2026-09-19')])
  })

  it('③ 时效只管「完成」:两天前就等着他确认的那张卡照旧响(它此刻仍然成立)', () => {
    const plan = planCallOuts({
      events: [{ key: callOutKey('confirm', 'a'), reason: 'confirm', item_id: 'a', title: '甲', at: '2026-09-19T10:30:00.000Z' }],
      seen: new Set(), waiting: [], now, quiet, newId: () => 'call-1',
    })
    // 照旧排得出来(时效只管「完成」);响不响是另一条规矩 —— 2026-09-28 起它只发通知(卡 UX)。
    expect(plan.created[0]).toMatchObject({ reason: 'confirm', silent: true })
  })

  it('② 同一件事的同一个理由还没收场(排着 / 正在响)时,不再开新的一通', () => {
    const ringing: CallOutEntry = {
      id: 'call-0', reason: 'confirm', item_id: 'a', title: '甲', at: '2026-09-21T05:00:00.000Z',
      state: 'ringing', silent: false, queued_at: '2026-09-21T05:00:00.000Z', due_at: '2026-09-21T05:00:00.000Z',
    }
    const plan = planCallOuts({
      events: [{ key: callOutKey('confirm', 'a'), reason: 'confirm', item_id: 'a', title: '甲', at: '2026-09-21T05:00:00.000Z' }],
      seen: new Set(), waiting: [ringing], now, quiet, newId: () => 'call-1',
    })
    expect(plan.created).toEqual([])
  })

  it('liveCallFor 只认还没收场的那两档:未接 / 已接 / 只发了通知都不算', () => {
    const base = { reason: 'done' as const, item_id: 'a', title: '甲', at: '', silent: false, queued_at: '', due_at: '' }
    const log: CallOutEntry[] = [
      { ...base, id: 'c1', state: 'missed' },
      { ...base, id: 'c2', state: 'answered' },
      { ...base, id: 'c3', state: 'notified' },
    ]
    expect(liveCallFor(log, 'done', 'a')).toBeUndefined()
    expect(liveCallFor([...log, { ...base, id: 'c4', state: 'queued' }], 'done', 'a')?.id).toBe('c4')
    expect(liveCallFor([...log, { ...base, id: 'c5', state: 'ringing' }], 'done', 'a')?.id).toBe('c5')
    // 理由不同就是另一件事(同一张卡先失败、后完成,是两通)。
    expect(liveCallFor([{ ...base, id: 'c6', state: 'ringing' }], 'confirm', 'a')).toBeUndefined()
  })
})

// ———————————————————————— ④ 服务:台账、领活、未接 ————————————————————————

describe('来电服务', () => {
  function svc(overrides: Partial<Parameters<typeof createCallOutService>[0]> = {}) {
    let seq = 0
    return createCallOutService({
      file: tmpFile(),
      newId: () => `call-${++seq}`,
      ...overrides,
    })
  }

  it('她问你的话 / 要你批的事(ask,卡 M):白天照「等你确认」那样排一通;每一问只打一次', async () => {
    const asks = [{ key: 'ask:question:q-1', reason: 'ask' as const, item_id: 't-1', title: '「修小头像」问你:派活前对一遍', note: '选项:都对,开工 / 都对,但你自己做', at: '2026-09-25T06:00:00.000Z' }]
    const service = svc({ askEvents: async () => asks, now: () => new Date('2026-09-25T14:00:00').getTime() })
    await service.load()
    await service.pump()
    expect(service.view().entries).toEqual([expect.objectContaining({ reason: 'ask', item_id: 't-1', state: 'queued', silent: false, title: '「修小头像」问你:派活前对一遍' })])
    await service.pump()
    expect(service.view().entries).toHaveLength(1)
  })

  it('★接连几问只响一次(卡 M 追加):同一拍里两问 → 一通响、后一问并进去;同一件事里的第二问也不吞', async () => {
    const asks = [
      { key: 'ask:question:q-1', reason: 'ask' as const, item_id: 't-1', title: '「修小头像」问你:派活前对一遍', at: '2026-09-25T06:00:00.000Z' },
      { key: 'ask:approval:a-1', reason: 'ask' as const, item_id: 't-1', title: '「修小头像」要你批:要开一个看不见的浏览器', at: '2026-09-25T06:00:05.000Z' },
    ]
    const service = svc({ askEvents: async () => asks, now: () => new Date('2026-09-25T14:00:00').getTime() })
    await service.load()
    await service.pump()
    const entries = service.view().entries
    expect(entries).toHaveLength(1)
    expect(entries[0]).toMatchObject({ reason: 'ask', silent: false, title: '「修小头像」问你:派活前对一遍' })
    expect(entries[0]!.merged).toEqual([{ item_id: 't-1', title: '「修小头像」要你批:要开一个看不见的浏览器', key: 'ask:approval:a-1' }])
  })

  it('★那一通正在响:窗里新来的一问并进它;接完挂了、还在 5 分钟窗里:只发通知;过了窗:再响', async () => {
    let clock = new Date('2026-09-25T14:00:00').getTime()
    let asks = [{ key: 'ask:question:q-1', reason: 'ask' as const, item_id: 't-1', title: '「甲」问你:先做哪个', at: '2026-09-25T06:00:00.000Z' }]
    const service = svc({ askEvents: async () => asks, now: () => clock })
    await service.load()
    await service.pump()
    const [first] = await service.claim()
    expect(first).toMatchObject({ reason: 'ask', silent: false })
    // 正在响:第二问并进这一通。
    clock += 30_000
    asks = [...asks, { key: 'ask:question:q-2', reason: 'ask' as const, item_id: 't-2', title: '「乙」问你:派给谁', at: '2026-09-25T06:00:30.000Z' }]
    await service.pump()
    expect(service.view().entries).toHaveLength(1)
    expect(service.view().entries[0]!.merged).toEqual([{ item_id: 't-2', title: '「乙」问你:派给谁', key: 'ask:question:q-2' }])
    await service.ack({ id: first!.id, result: 'answered' })
    // 挂了,2 分钟后又来一问:还在窗里,只发通知。
    clock += 2 * 60_000
    asks = [...asks, { key: 'ask:approval:a-3', reason: 'ask' as const, item_id: 't-3', title: '「丙」要你批:要跑一条命令', at: '2026-09-25T06:02:30.000Z' }]
    await service.pump()
    expect(service.view().entries.find(entry => entry.item_id === 't-3')).toMatchObject({ silent: true, silent_reason: 'ask' })
    // 离上一次响过了 5 分钟:再来一问,再响。
    clock += 3 * 60_000
    asks = [...asks, { key: 'ask:question:q-4', reason: 'ask' as const, item_id: 't-4', title: '「丁」问你:要不要', at: '2026-09-25T06:05:30.000Z' }]
    await service.pump()
    expect(service.view().entries.find(entry => entry.item_id === 't-4')).toMatchObject({ silent: false })
  })

  it('响过的那一通没打出去(工人不在)不算「刚响过」:下一问照样响', () => {
    expect(lastAskRing([
      { id: 'c1', reason: 'ask', item_id: 't-1', title: '甲', at: '', state: 'failed', silent: false, queued_at: '2026-09-25T06:00:00.000Z', due_at: '' },
      { id: 'c2', reason: 'ask', item_id: 't-2', title: '乙', at: '', state: 'notified', silent: true, silent_reason: 'ask', queued_at: '2026-09-25T06:01:00.000Z', due_at: '' },
    ])).toBeUndefined()
    expect(lastAskRing([
      { id: 'c3', reason: 'ask', item_id: 't-3', title: '丙', at: '', state: 'missed', silent: false, queued_at: '2026-09-25T06:02:00.000Z', due_at: '' },
    ])).toBe(Date.parse('2026-09-25T06:02:00.000Z'))
  })

  it('夜间静默时段:ask 那一通只发通知(不响)', async () => {
    const asks = [{ key: 'ask:approval:a-1', reason: 'ask' as const, item_id: 't-1', title: '「修小头像」要你批:要跑一条命令', at: '2026-09-25T15:00:00.000Z' }]
    const service = svc({ askEvents: async () => asks, now: () => new Date('2026-09-25T23:30:00').getTime() })
    await service.load()
    await service.pump()
    expect(service.view().entries[0]).toMatchObject({ reason: 'ask', silent: true, silent_reason: 'quiet' })
  })

  it('一件「等我确认」走完整条:pump 排一通 → 工人领走 → 接起来 → 台账里是已接', async () => {
    const tasks = { list: async () => board([confirmAsked({ id: 'a' })]) }
    const service = svc({ tasks })
    await service.load()
    await service.pump()
    let view = service.view()
    expect(view.entries).toHaveLength(1)
    expect(view.entries[0]).toMatchObject({ reason: 'confirm', item_id: 'a', state: 'queued' })

    const claimed = await service.claim()
    expect(claimed).toHaveLength(1)
    expect(service.view().entries[0]!.state).toBe('ringing')

    await service.ack({ id: claimed[0]!.id, result: 'answered' })
    view = service.view()
    expect(view.entries[0]!.state).toBe('answered')
    expect(view.missed).toBe(0)
  })

  it('同一件事 pump 几拍也只排一通', async () => {
    const tasks = { list: async () => board([confirmAsked({ id: 'a' })]) }
    const service = svc({ tasks })
    await service.load()
    await service.pump()
    await service.pump()
    await service.pump()
    expect(service.view().entries).toHaveLength(1)
  })

  it('没人接 → 未接来电;工人领了活再没回话也按未接记', async () => {
    let clock = Date.parse('2026-09-21T14:00:00+08:00')
    // 2026-09-28(卡 UX):数得进「未接来电」的必须是**真响过**的那几通 —— 这里用「运行失败」那一类。
    const tasks = { list: async () => board([task({ id: 'a', status: 'blocked', block_reason: 'error' })]) }
    const service = svc({ tasks, now: () => clock })
    await service.load()
    await service.pump()
    const [first] = await service.claim()
    await service.ack({ id: first!.id, result: 'missed' })
    expect(service.view().missed).toBe(1)

    // 第二通:领走之后工人被杀,台账自己把它扫成未接。
    await service.request({ reason: 'failed', item_id: 'b', title: '乙' })
    const [second] = await service.claim()
    expect(second!.state).toBe('ringing')
    clock += CALL_OUT_RING_STALE_MS + 1000
    await service.pump()
    const entry = service.view().entries.find(one => one.id === second!.id)
    expect(entry?.state).toBe('missed')
    expect(entry?.error).toContain('工人没回话')
  })

  it('合并窗没到就领不走;到了才领得走,而且窗里那几条都在 merged 里', async () => {
    let clock = Date.parse('2026-09-21T14:00:00+08:00')
    let rows: readonly TaskView[] = [task({ id: 'a', status: 'done' })]
    const service = svc({ tasks: { list: async () => board(rows) }, now: () => clock })
    await service.load()
    await service.pump()
    expect(await service.claim()).toEqual([])

    rows = [...rows, task({ id: 'b', status: 'done' })]
    clock += 60_000
    await service.pump()
    expect(service.view().entries).toHaveLength(1)
    expect(service.view().entries[0]!.merged).toEqual([{ item_id: 'b', title: '卡 b', key: 'done:b' }])

    clock += CALL_OUT_MERGE_WINDOW_MS
    const claimed = await service.claim()
    expect(claimed).toHaveLength(1)
    expect(claimed[0]!.merged).toHaveLength(1)
  })

  it('手动 POST /call/out 那一条**不进合并窗、不看打过没打过**,但照旧认静默时段', async () => {
    const night = Date.parse('2026-09-22T01:00:00+08:00')
    const service = svc({ now: () => night })
    await service.load()
    const first = await service.request({ reason: 'confirm', item_id: 'x', title: '甲' })
    expect(first.ok).toBe(true)
    expect(first.entry?.silent).toBe(true)
    expect(first.entry?.silent_reason).toBe('quiet')
    expect(Date.parse(first.entry!.due_at)).toBe(night)
    // 「打过没打过」照旧不看:上一通**收场之后**他再点一次,照样排得出来。
    await service.ack({ id: first.entry!.id, result: 'missed' })
    const again = await service.request({ reason: 'confirm', item_id: 'x', title: '甲' })
    expect(again.ok).toBe(true)
    expect(service.view().entries).toHaveLength(2)
  })

  // ——— 2026-09-22 真机那七通(见本文件上面那一节的注释) ———

  it('① 手动那条也认 A1:`done_call` 关着时「完成」不排电话,如实说为什么;打开了照旧排', async () => {
    // 钉在白天(2026-09-25 补):不钉的话半夜 23:00–08:00 跑这一条,夜间静默会把它排成静音,断言跟着钟点红。
    const service = svc({ now: () => Date.parse('2026-09-22T10:00:00+08:00') })
    await service.load()
    const refused = await service.request({ reason: 'done', item_id: 'routine:evening:2026-09-20', title: '下班例程' })
    expect(refused.ok).toBe(false)
    expect(refused.error).toContain('只发通知')
    expect(refused.error).toContain('办完了也打电话给我')
    expect(service.view().entries).toEqual([])

    await service.setConfig({ done_call: true })
    const allowed = await service.request({ reason: 'done', item_id: 'routine:evening:2026-09-20', title: '下班例程' })
    expect(allowed.ok).toBe(true)
    expect(allowed.entry).toMatchObject({ silent: false })
  })

  it('② 连点五下「回拨」只排一通:上一通还排着 / 还在响就不再排,收场之后才排得出下一通', async () => {
    const service = svc()
    await service.load()
    const first = await service.request({ reason: 'confirm', item_id: 'a', title: '甲' })
    expect(first.ok).toBe(true)
    for (let i = 0; i < 4; i += 1) {
      const again = await service.request({ reason: 'confirm', item_id: 'a', title: '甲' })
      expect(again.ok).toBe(false)
      expect(again.error).toContain('没有再排一通')
    }
    expect(service.view().entries).toHaveLength(1)

    // 领走之后还在响,照样不排。
    await service.claim()
    expect((await service.request({ reason: 'confirm', item_id: 'a', title: '甲' })).ok).toBe(false)
    expect(service.view().entries).toHaveLength(1)

    // 这一通收场(没人接)了,他再点一次 —— 这一下是他亲口要的,排得出来。
    await service.ack({ id: first.entry!.id, result: 'missed' })
    expect((await service.request({ reason: 'confirm', item_id: 'a', title: '甲' })).ok).toBe(true)
    expect(service.view().entries).toHaveLength(2)
  })

  it('③ 例程是两天前跑完的:重启后第一拍也不再为它排一通(台账一条不多)', async () => {
    const clock = Date.parse('2026-09-22T15:37:00+08:00')
    const service = svc({
      now: () => clock,
      routines: () => routines({
        evening: { name: 'evening', date: '2026-09-20', trigger: 'schedule', started_at: '2026-09-20T10:30:00.000Z', status: 'ok', note: '布局快照已覆盖' },
      } as RoutinesView['last']),
    })
    await service.load()
    await service.pump()
    expect(service.view().entries).toEqual([])
  })

  it('③ 今天刚跑完的例程照旧进台账(只是只发通知)', async () => {
    const clock = Date.parse('2026-09-22T18:35:00+08:00')
    const service = svc({
      now: () => clock,
      routines: () => routines({
        evening: { name: 'evening', date: '2026-09-22', trigger: 'schedule', started_at: '2026-09-22T10:30:00.000Z', status: 'ok' },
      } as RoutinesView['last']),
    })
    await service.load()
    await service.pump()
    // 原因记成 `routine`(2026-09-28,卡 UX:例程播报不打电话)。
    expect(service.view().entries[0]).toMatchObject({ reason: 'done', silent: true, silent_reason: 'routine' })
  })

  it('认不出的理由 / 缺 item_id 都如实拒,不静默丢掉', async () => {
    const service = svc()
    await service.load()
    expect(await service.request({ reason: '随便' as never, item_id: 'x' })).toMatchObject({ ok: false })
    expect(await service.request({ reason: 'done', item_id: '  ' })).toMatchObject({ ok: false })
  })

  it('关掉之后 pump 不再排任何一通(手动那条仍然能打)', async () => {
    const tasks = { list: async () => board([confirmAsked({ id: 'a' })]) }
    const service = svc({ tasks })
    await service.load()
    await service.setConfig({ enabled: false })
    await service.pump()
    expect(service.view().entries).toEqual([])
    expect((await service.request({ reason: 'confirm', item_id: 'a', title: '甲' })).ok).toBe(true)
  })

  it('静默时段写坏了回上一份,不回一个 0 点(那会把整晚静音而他看不出来)', async () => {
    const service = svc()
    await service.load()
    const config = await service.setConfig({ quiet_from: '不知道', quiet_to: '07:30' })
    expect(config.quiet_from).toBe(defaultCallOutConfig().quiet_from)
    expect(config.quiet_to).toBe('07:30')
  })

  it('台账落盘之后重新读得回来 —— 重启一次不该让他的手机再响一遍', async () => {
    const file = tmpFile()
    const tasks = { list: async () => board([confirmAsked({ id: 'a' })]) }
    const first = createCallOutService({ file, tasks })
    await first.load()
    await first.pump()

    const again = createCallOutService({ file, tasks })
    await again.load()
    await again.pump()
    expect(again.view().entries).toHaveLength(1)
    expect((await loadCallOutFile(file)).seen).toContain(callOutKey('confirm', 'a'))
  })

  it('A1:一件「完成」pump 出来的那一通不响铃,只发通知;手点「回拨」也不再破这条规矩', async () => {
    const tasks = { list: async () => board([task({ id: 'a', status: 'done', done_at: '2026-09-21T10:00:00.000Z' })]) }
    const service = svc({ tasks, mergeWindowMs: 0, now: () => Date.parse('2026-09-21T11:00:00.000Z') })
    await service.load()
    await service.pump()
    expect(service.view().entries[0]).toMatchObject({ reason: 'done', silent: true, silent_reason: 'done' })

    /**
     * 2026-09-22 改:手动那条**也**套完成策略。原来的取舍是「回拨是他亲口要的,别静音成通知」,
     * 但真机上这条口子把 A1 整条绕过去了(七通「下班例程」)。
     */
    const manual = await service.request({ reason: 'done', item_id: 'a', title: '卡 a' })
    expect(manual.ok).toBe(false)
    expect(service.view().entries).toHaveLength(1)
  })

  it('A1:设置里把「完成也打给我」打开,pump 出来的那一通就响', async () => {
    const tasks = { list: async () => board([task({ id: 'a', status: 'done', done_at: '2026-09-21T10:00:00.000Z' })]) }
    const service = svc({ tasks, mergeWindowMs: 0, now: () => Date.parse('2026-09-21T11:00:00.000Z') })
    await service.load()
    await service.setConfig({ done_call: true })
    await service.pump()
    expect(service.view().entries[0]).toMatchObject({ reason: 'done', silent: false })
  })

  it('每一档「只发通知」的理由落盘再读回来都还在(2026-09-28 漏过卡 UX 的 confirm / routine)', async () => {
    const file = tmpFile()
    const log = CALL_OUT_SILENT_REASONS.map((reason): CallOutEntry => ({
      id: reason,
      reason: 'confirm',
      item_id: reason,
      title: `卡 ${reason}`,
      at: '2026-09-28T10:00:00.000Z',
      state: 'notified',
      silent: true,
      silent_reason: reason,
      queued_at: '2026-09-28T10:00:00.000Z',
      due_at: '2026-09-28T10:00:00.000Z',
    }))
    await saveCallOutFile(file, { ...emptyCallOutFile(), log })
    const back = await loadCallOutFile(file)
    expect(back.log.map(one => one.silent_reason)).toEqual([...CALL_OUT_SILENT_REASONS])
  })

  it('认不出来的理由当没有(台账里混进别的字)', async () => {
    const file = tmpFile()
    const log = [{
      id: 'x', reason: 'confirm', item_id: 'x', title: '卡 x', at: '', state: 'notified',
      silent: true, silent_reason: '瞎写的', queued_at: '', due_at: '',
    }] as unknown as CallOutEntry[]
    await saveCallOutFile(file, { ...emptyCallOutFile(), log })
    expect((await loadCallOutFile(file)).log[0]).not.toHaveProperty('silent_reason')
  })

  it('文件坏了当没有,不抛', async () => {
    expect((await loadCallOutFile('/不存在/call-out.json')).log).toEqual([])
  })
})

// ———————————————————————— 电脑端面板那一行 ————————————————————————

describe('事务官面板:打过电话:已接 / 未接', () => {
  function stateWith(entries: readonly CallOutEntry[]): WorkbenchState {
    return { call_out: { config: defaultCallOutConfig(), entries, missed: 0 } } as unknown as WorkbenchState
  }
  function entry(patch: Partial<CallOutEntry> & Pick<CallOutEntry, 'state'>): CallOutEntry {
    return {
      id: 'c1', reason: 'confirm', item_id: 'a', title: '甲', at: '2026-09-21T06:00:00.000Z',
      silent: false, queued_at: '2026-09-21T06:00:00.000Z', due_at: '2026-09-21T06:00:00.000Z',
      ended_at: '2026-09-21T06:03:00.000Z', ...patch,
    }
  }

  it('接了 / 没接各说一句,带时刻', () => {
    expect(callOutLine(stateWith([entry({ state: 'answered' })]), 'a')).toContain('已接')
    expect(callOutLine(stateWith([entry({ state: 'missed' })]), 'a')).toContain('未接')
  })

  it('并进来的那几件也算「打过电话」—— 那一通里确实说到它了', () => {
    const merged = entry({ state: 'answered', reason: 'done', merged: [{ item_id: 'b', title: '乙' }] })
    expect(callOutLine(stateWith([merged]), 'b')).toContain('已接')
  })

  it('A1:只发了通知的那一通**不说「打过电话」**(它压根没响)', () => {
    const one = entry({ state: 'notified', reason: 'done', silent: true, silent_reason: 'done' })
    const text = callOutLine(stateWith([one]), 'a')
    expect(text).toContain('只发了通知')
    expect(text).not.toContain('打过电话')
  })

  it('**没打过 / 还排着 / 这台机器没接主动来电,三种都不写字**(不知道就不填)', () => {
    expect(callOutLine(stateWith([entry({ state: 'answered' })]), '别的')).toBeUndefined()
    expect(callOutLine(stateWith([entry({ state: 'queued' })]), 'a')).toBeUndefined()
    expect(callOutLine({} as unknown as WorkbenchState, 'a')).toBeUndefined()
  })
})

// ———————————————————————— ⑤ 未接来电收得掉(2026-09-22) ————————————————————————

/**
 * 真机 0.2.56 上九条「完成 · 下班例程」堆在未接面板里,**没有任何一条路能收掉**
 * (`missed` 只增不减)。这一节钉住那条路:
 *
 *   · 收的是**读没读过**,不是**发生过没有** —— 台账一条都不删,只多一格 `dismissed_at`;
 *   · `view()` 的 `missed` 只数还没收的,`entries` 一条不少(「最近一次通话」照旧看得见)。
 */
describe('未接来电:清空只标记、不删台账', () => {
  function missedEntry(patch: Partial<CallOutEntry> & Pick<CallOutEntry, 'id'>): CallOutEntry {
    return {
      reason: 'done', item_id: 'routine:evening:2026-09-22', title: '下班例程',
      at: '2026-09-22T09:06:00.000Z', state: 'missed', silent: false,
      queued_at: '2026-09-22T09:06:00.000Z', due_at: '2026-09-22T09:06:00.000Z',
      ...patch,
    }
  }

  function svc2(overrides: Partial<Parameters<typeof createCallOutService>[0]> = {}) {
    let seq = 0
    // 钉在白天(2026-09-30 晚):缺省免打扰 23:00–08:00,用真时钟的话晚上跑这几条会红(那一通只发通知、不进 claim)。
    return createCallOutService({ file: tmpFile(), newId: () => `call-${++seq}`, now: () => new Date('2026-09-25T14:00:00').getTime(), ...overrides })
  }

  it('dismissMissedEntries 只碰「未接且还没收过」的那几条,别的一个字不动', () => {
    const log: CallOutEntry[] = [
      missedEntry({ id: 'c1' }),
      missedEntry({ id: 'c2', dismissed_at: '2026-09-22T10:00:00.000Z' }),
      missedEntry({ id: 'c3', state: 'answered' }),
      missedEntry({ id: 'c4', state: 'queued' }),
    ]
    const result = dismissMissedEntries(log, Date.parse('2026-09-22T11:00:00.000Z'))
    expect(result.dismissed).toBe(1)
    expect(result.log[0]!.dismissed_at).toBe('2026-09-22T11:00:00.000Z')
    // 已经收过的那条保留原来的时刻(不刷新),别的两条压根没有这一格。
    expect(result.log[1]!.dismissed_at).toBe('2026-09-22T10:00:00.000Z')
    expect(result.log[2]!.dismissed_at).toBeUndefined()
    expect(result.log[3]!.dismissed_at).toBeUndefined()
    // 状态一个都没改 —— 收的是「读没读过」,不是「发生过没有」。
    expect(result.log.map(one => one.state)).toEqual(['missed', 'missed', 'answered', 'queued'])
  })

  it('一条都没得收时回 0,而且**不重写台账**(同一个数组原样回去)', () => {
    const log: CallOutEntry[] = [missedEntry({ id: 'c1', state: 'answered' })]
    const result = dismissMissedEntries(log, Date.now())
    expect(result.dismissed).toBe(0)
    expect(result.log).toBe(log)
  })

  it('★清空之后 `missed` 归零,而 `entries` 一条不少(GET /call/log 回的就是这个 view)', async () => {
    let clock = Date.parse('2026-09-22T14:00:00+08:00')
    const service = svc2({ now: () => clock })
    await service.load()
    await service.request({ reason: 'confirm', item_id: 'a', title: '甲' })
    await service.request({ reason: 'failed', item_id: 'b', title: '乙' })
    for (const one of await service.claim()) await service.ack({ id: one.id, result: 'missed' })
    expect(service.view().missed).toBe(2)
    const before = service.view().entries.map(one => one.id)

    clock += 60_000
    const cleared = await service.dismissMissed()
    expect(cleared).toEqual({ ok: true, dismissed: 2 })
    const after = service.view()
    expect(after.missed).toBe(0)
    expect(after.entries.map(one => one.id)).toEqual(before)
    expect(after.entries.every(one => one.state === 'missed')).toBe(true)
    expect(after.entries.every(one => one.dismissed_at === new Date(clock).toISOString())).toBe(true)

    // 再收一次:没得收了,回 0(按两下不报错)。
    expect(await service.dismissMissed()).toEqual({ ok: true, dismissed: 0 })
  })

  it('★收过之后再来一通没接的,`missed` 重新变 1 —— 收的只是已经看过的那几条', async () => {
    const service = svc2()
    await service.load()
    await service.request({ reason: 'confirm', item_id: 'a', title: '甲' })
    for (const one of await service.claim()) await service.ack({ id: one.id, result: 'missed' })
    await service.dismissMissed()
    expect(service.view().missed).toBe(0)

    await service.request({ reason: 'failed', item_id: 'b', title: '乙' })
    for (const one of await service.claim()) await service.ack({ id: one.id, result: 'missed' })
    expect(service.view().missed).toBe(1)
  })

  it('★收过的记号落盘,重启之后还是收过的(不然重启一次九条又回来了)', async () => {
    const file = tmpFile()
    const first = createCallOutService({ file, newId: () => 'call-1' })
    await first.load()
    await first.request({ reason: 'confirm', item_id: 'a', title: '甲' })
    for (const one of await first.claim()) await first.ack({ id: one.id, result: 'missed' })
    await first.dismissMissed()

    const again = createCallOutService({ file })
    await again.load()
    expect(again.view().entries).toHaveLength(1)
    expect(again.view().missed).toBe(0)
  })
})

// ———————————————————————— 没装好不排电话(2026-09-23 从零重装验收第 3 件) ————————————————————————

describe('卡 M 补:他刚动过手不响;只是一段回答的「等你确认」不打电话要他验收', () => {
  const now = Date.parse('2026-09-25T19:30:00+08:00')
  const quiet = { from: '23:00', to: '08:00' }
  const confirmOf = (patch: Partial<TaskView>) => taskCallOutEvent(confirmAsked({ id: 't-1', ...patch }))!

  it('只是一段回答(没派给别家、交回来的只有那段话)→ 事件带 quiet:chat;派出去的、交回文件链接的 → 不带', () => {
    expect(confirmOf({ deliverables: [{ kind: 'reply', ref: '收到,选 B' }] }).quiet).toBe('chat')
    expect(confirmOf({ deliverables: [] }).quiet).toBe('chat')
    expect(confirmOf({ deliverables: [{ kind: 'reply', ref: 'x' }], dispatch: { family: 'codex', status: 'done' } as NonNullable<TaskView['dispatch']> }).quiet).toBeUndefined()
    expect(confirmOf({ deliverables: [{ kind: 'reply', ref: 'x' }], client_dispatch: { family: 'kimi', status: 'sent' } as NonNullable<TaskView['client_dispatch']> }).quiet).toBeUndefined()
    expect(confirmOf({ deliverables: [{ kind: 'reply', ref: 'x' }, { kind: 'file', ref: '/tmp/周报.md' }] }).quiet).toBeUndefined()
  })

  it('★「等你确认」:只是一段回答的只发通知(chat);派出去的照旧响', () => {
    const plan = planCallOuts({
      events: [confirmOf({ id: 'chat' } as Partial<TaskView>), { ...confirmOf({ dispatch: { family: 'codex', status: 'done' } as NonNullable<TaskView['dispatch']> }), key: callOutKey('confirm', 'sent'), item_id: 'sent' }],
      seen: new Set(), waiting: [], now, quiet, newId: (() => { let n = 0; return () => `c-${++n}` })(),
    })
    // 2026-09-28(卡 UX):派出去、交回了东西那一件也改成只发通知(做完了是一条汇报)——
    // 「只是一段回答」那一条照旧记 `chat`(它说得更多:压根没派出去)。
    expect(plan.created.map(one => [one.item_id, one.silent, one.silent_reason])).toEqual([['chat', true, 'chat'], ['sent', true, 'confirm']])
  })

  it('★他刚对这件事动过手(10 分钟内):「等你确认」「等你回答」都只发通知(touched);过了 10 分钟照旧;别的事不受影响', () => {
    const touchedAt = new Map([['t-1', now - 3 * 60_000], ['t-old', now - 11 * 60_000]])
    const dispatched = (id: string) => ({ ...confirmOf({ dispatch: { family: 'codex', status: 'done' } as NonNullable<TaskView['dispatch']> }), key: callOutKey('confirm', id), item_id: id })
    const plan = planCallOuts({
      events: [
        dispatched('t-1'),
        dispatched('t-old'),
        dispatched('t-other'),
        { key: 'ask:question:q-1', reason: 'ask', item_id: 't-1', title: '「甲」问你:先做哪个', at: '2026-09-25T11:29:00Z' },
      ],
      seen: new Set(), waiting: [], now, quiet, touchedAt, newId: (() => { let n = 0; return () => `c-${++n}` })(),
    })
    const byKey = new Map(plan.created.map(one => [`${one.reason}:${one.item_id}`, one]))
    expect(byKey.get('confirm:t-1')).toMatchObject({ silent: true, silent_reason: 'touched' })
    // 过了 10 分钟就不是「刚动过手」了;响不响另有一条规矩 —— 2026-09-28 起「等你确认」只发通知(卡 UX)。
    expect(byKey.get('confirm:t-old')).toMatchObject({ silent: true, silent_reason: 'confirm' })
    expect(byKey.get('confirm:t-other')).toMatchObject({ silent: true, silent_reason: 'confirm' })
    expect(byKey.get('ask:t-1')).toMatchObject({ silent: true, silent_reason: 'touched' })
  })

  it('服务:touch 之后那一拍排出来的只发通知;夜里照旧是 quiet(夜间在前)', async () => {
    let clock = new Date('2026-09-25T14:00:00').getTime()
    const tasks = { list: async () => board([confirmAsked({ id: 'a', dispatch: { family: 'codex', status: 'done' } as NonNullable<TaskView['dispatch']> })]) }
    const service = createCallOutService({ file: tmpFile(), tasks, now: () => clock, newId: () => 'call-1' })
    await service.load()
    service.touch?.('a')
    clock += 60_000
    await service.pump()
    expect(service.view().entries[0]).toMatchObject({ item_id: 'a', silent: true, silent_reason: 'touched' })
  })
})

describe('★ 没注册 / 引导没走完:自动那条一通都不排', () => {
  it('例程「完成」与看板「等我确认」都不排,也不记「打过了」;装好之后照排', async () => {
    let gate: string | undefined = '还没注册账号'
    const now = Date.parse('2026-09-23T09:01:00.000Z')
    const tasks = { list: async () => board([confirmAsked({ id: 'a' })]) }
    const routines = () => ({
      next: {}, running: [], config: {} as never,
      last: { morning: { name: 'morning' as const, date: '2026-09-23', trigger: 'sighting' as const, started_at: '2026-09-23T09:01:00.000Z', status: 'no_session' as const } },
    })
    let seq = 0
    const service = createCallOutService({
      file: tmpFile(), newId: () => `call-${++seq}`, tasks, routines, now: () => now, mergeWindowMs: 0,
      setupGate: () => gate,
    })
    await service.load()
    await service.pump()
    expect(service.view().entries).toEqual([])
    gate = undefined
    await service.pump()
    expect(service.view().entries.map(e => e.reason).sort()).toEqual(['confirm', 'done'])
  })

  it('手动那条(回拨 / 试铃)不拦', async () => {
    const service = createCallOutService({ file: tmpFile(), setupGate: () => '还没注册账号' })
    await service.load()
    const result = await service.request({ reason: 'confirm', item_id: 'x', title: '试铃' })
    expect(result.ok).toBe(true)
  })
})

describe('一通收场叫一声 onSettled(2026-10-09 行为账:接没接)', () => {
  it('工人回「接了」、领走后没回话按未接记,都叫一声;叫的那一下抛了也不连累台账', async () => {
    let clock = Date.parse('2026-10-09T14:00:00+08:00')
    const settled: string[] = []
    const service = createCallOutService({
      file: tmpFile(),
      now: () => clock,
      onSettled: (entry) => { settled.push(`${entry.item_id}:${entry.state}`); throw new Error('记账坏了') },
    })
    await service.load()
    await service.request({ reason: 'failed', item_id: 'a', title: '甲' })
    const [first] = await service.claim()
    await service.ack({ id: first!.id, result: 'answered' })
    await service.request({ reason: 'failed', item_id: 'b', title: '乙' })
    await service.claim()
    clock += CALL_OUT_RING_STALE_MS + 1000
    await service.pump()
    expect(settled).toEqual(['a:answered', 'b:missed'])
    expect(service.view().entries.find(one => one.item_id === 'b')?.state).toBe('missed')
  })
})
