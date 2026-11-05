// @vitest-environment node
/**
 * 「哪几类事项办完要告诉你」开关(2026-10-23,卡「分层第二刀一」第一条)。
 *
 * 10-03 那批维护包在产物上扩大了通知范围;这张卡把「范围」开成设置项(按事项类型勾:交办 / 派活 / 会议 / 例程),
 * **判定留本体不动**(算不算失败、谁的会话收尾照旧),开关只在出事件那一处(`callOutEventsOf`)读。
 *
 * 钉这几件:
 *   ① 缺省 = 2026-10-23 之前的行为:交办(交给事务官的)与会议待办、例程照出事件;派出去的活**不出**(现状就是没有);
 *   ② 勾上「派活」:派出去的活办完(等你确认)/ 失败 / 停下来等输入,各出各的事件;
 *   ③ 取消「交办」:交给事务官办的卡一条都不出;「会议」单独一档 —— 取消「交办」不影响会议待办,取消「会议」只挡会议待办;
 *   ④ 取消「例程」:例程跑完 / 跑挂都不出;
 *   ⑤ 偏好服务:缺省、落盘读回、脏文件不坏;座机服务那一拍从 `tellScope` 口读。
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { RoutinesView, TaskView, TasksState } from '../src/protocol.ts'
import { DISPATCH_PREFS_DEFAULT, TELL_KIND_TITLES, TELL_SCOPE_DEFAULT } from '../src/protocol.ts'
import { callOutEventsOf, createCallOutService, taskCallOutEvent } from '../src/server/callOut.ts'
import { createDispatchPrefsService, defaultDispatchPrefsFile, parseDispatchPrefs, parseTellScope } from '../src/server/dispatchPrefs.ts'

const dirs: string[] = []
function tmpDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'wb-tell-scope-'))
  dirs.push(dir)
  return dir
}
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }) })

function task(patch: Partial<TaskView> & Pick<TaskView, 'id' | 'status'>): TaskView {
  return {
    title: `卡 ${patch.id}`,
    direction: 'mine',
    source: 'manual',
    created_at: '2026-10-23T09:00:00.000Z',
    updated_at: '2026-10-23T10:00:00.000Z',
    ...patch,
  } as TaskView
}

function board(tasks: readonly TaskView[], agent_cards?: readonly unknown[]): TasksState {
  return { tasks, sprints: [], modules: [], project_meta: [], ...(agent_cards === undefined ? {} : { agent_cards }) } as unknown as TasksState
}

/** 板上登记过的 Agent 名片(`agent:local:…`,与 tasks.ts `newAgentCardId` 同形)。 */
function card(id: string, family: string): unknown {
  return { id, name: `${family} 的名片`, owner: 'me', hand: family, runtime: { family }, shared: { to: 'none' }, created_at: 'x', updated_at: 'x' }
}

function routines(last: RoutinesView['last']): RoutinesView {
  return { next: {}, last, running: [], config: { morning: { enabled: true, not_before: '08:00' }, evening: { enabled: true, at: '19:00' }, lint: { enabled: true, weekday: 5 } } }
}

/** 交给事务官办的卡(direction:mine,挂着她的会话)。2026-10-26(卡「事务官页接管队列」):confirm 要出事件,前提是事务官核过、标了四类拍板请求。 */
const OWNER_ASK = { kind: 'spend' as const, proposal: '买这个', basis: '核过的事实', by: 'butler', at: '2026-10-23T10:00:00.000Z' }
const MINE_CONFIRM = () => task({ id: 'a', status: 'confirm', conversation: { agent: 'dsh', session_id: 's-1' }, owner_ask: OWNER_ASK })
/** 会议待办(origin:meeting 的卡本来就是 direction:mine)。 */
const MEETING_CONFIRM = () => task({ id: 'm', status: 'confirm', origin: 'meeting', conversation: { agent: 'dsh', session_id: 's-2' }, owner_ask: OWNER_ASK })
/** 派给别家 AI 的活(负责人是 Codex,没有事务官会话,也没有 direction —— 不是交给事务官的卡)。 */
function dispatched(patch: Partial<TaskView> & Pick<TaskView, 'id' | 'status'>): TaskView {
  const one = task(patch) as unknown as Record<string, unknown>
  delete one.direction
  return one as unknown as TaskView
}
const DISPATCHED_CONFIRM = () => dispatched({ id: 'p', status: 'confirm', assignee: 'codex', deliverables: [{ kind: 'reply', ref: '改完了' }], owner_ask: OWNER_ASK })
const DISPATCHED_FAILED = () => dispatched({ id: 'f', status: 'blocked', block_reason: 'error', assignee: 'codex', note: '命令行没登录' })
const DISPATCHED_ASK = () => dispatched({ id: 'w', status: 'blocked', block_reason: 'input', assignee: 'codex', note: '在等你回话' })
const EVENING_OK = (): RoutinesView['last'] => ({ evening: { status: 'ok', name: 'evening', date: '2026-10-23', trigger: 'schedule', started_at: '2026-10-23T11:00:00.000Z' } })

describe('通知范围开关', () => {
  it('① 缺省 = 现状:交办 / 会议 / 例程照出;派出去的活一条都不出', () => {
    const events = callOutEventsOf({
      tasks: board([MINE_CONFIRM(), MEETING_CONFIRM(), DISPATCHED_CONFIRM(), DISPATCHED_FAILED()]),
      routines: routines(EVENING_OK()),
    })
    expect(events.map(one => one.item_id)).toEqual(['a', 'm', 'routine:evening:2026-10-23'])
  })

  it('② 勾上「派活」:办完 / 失败 / 停下来等输入,各出各的事件', () => {
    const scope = { ...TELL_SCOPE_DEFAULT, dispatch: true }
    const events = callOutEventsOf({ tasks: board([DISPATCHED_CONFIRM(), DISPATCHED_FAILED(), DISPATCHED_ASK()]), scope })
    expect(events.map(one => [one.reason, one.item_id])).toEqual([
      ['confirm', 'p'],
      ['failed', 'f'],
      ['ask', 'w'],
    ])
    expect(events[0]?.note).toBe('1 件交付物')
    expect(events[1]?.note).toBe('命令行没登录')
  })

  it('③ 取消「交办」:交给事务官办的卡不出;会议待办照出', () => {
    const scope = { ...TELL_SCOPE_DEFAULT, mine: false }
    const events = callOutEventsOf({ tasks: board([MINE_CONFIRM(), MEETING_CONFIRM()]), scope })
    expect(events.map(one => one.item_id)).toEqual(['m'])
  })

  it('③′ 取消「会议」只挡会议待办;取消「交办」留着「会议」时会议待办照出', () => {
    expect(callOutEventsOf({ tasks: board([MEETING_CONFIRM()]), scope: { ...TELL_SCOPE_DEFAULT, meeting: false } })).toEqual([])
    const kept = callOutEventsOf({ tasks: board([MEETING_CONFIRM()]), scope: { ...TELL_SCOPE_DEFAULT, mine: false, meeting: true } })
    expect(kept.map(one => one.item_id)).toEqual(['m'])
  })

  it('④ 取消「例程」:跑完也不出', () => {
    const events = callOutEventsOf({ tasks: board([MINE_CONFIRM()]), routines: routines(EVENING_OK()), scope: { ...TELL_SCOPE_DEFAULT, routine: false } })
    expect(events.map(one => one.item_id)).toEqual(['a'])
  })

  it('逐项勾:四项全关 → 一条都不出', () => {
    const events = callOutEventsOf({
      tasks: board([MINE_CONFIRM(), MEETING_CONFIRM()]),
      routines: routines(EVENING_OK()),
      scope: { mine: false, dispatch: false, meeting: false, routine: false },
    })
    expect(events).toEqual([])
  })

  it('`taskCallOutEvent` 缺省参数与旧调用一字不差(派出去的活不出)', () => {
    expect(taskCallOutEvent(DISPATCHED_CONFIRM())).toBeUndefined()
    expect(taskCallOutEvent(MINE_CONFIRM())?.reason).toBe('confirm')
  })

  it('★P1 回归(统筹验收):真实板上派活全走名片 —— 名片负责人的 confirm 卡,勾上「派活」照出', () => {
    const scope = { ...TELL_SCOPE_DEFAULT, dispatch: true }
    for (const id of ['agent:local:codex-code', 'agent:local:kimi-code']) {
      const cards = [card(id, id.includes('kimi') ? 'kimi' : 'codex')]
      const one = dispatched({ id: 'p1', status: 'confirm', assignee: id, deliverables: [{ kind: 'reply', ref: '改完了' }], owner_ask: OWNER_ASK })
      const events = callOutEventsOf({ tasks: board([one], cards), scope })
      expect(events.map(event => [event.reason, event.item_id])).toEqual([['confirm', 'p1']])
      // 缺省(开关关着)= 现状:一条都不出。
      expect(callOutEventsOf({ tasks: board([one], cards) })).toEqual([])
    }
  })

  it('★P1 回归:名片负责人的办砸 / 停下来等输入,勾上「派活」各出各的', () => {
    const scope = { ...TELL_SCOPE_DEFAULT, dispatch: true }
    const id = 'agent:local:codex-code'
    const cards = [card(id, 'codex')]
    const failed = dispatched({ id: 'f1', status: 'blocked', block_reason: 'error', assignee: id, note: '命令行没登录' })
    const asking = dispatched({ id: 'w1', status: 'blocked', block_reason: 'input', assignee: id, note: '在等你回话' })
    const events = callOutEventsOf({ tasks: board([failed, asking], cards), scope })
    expect(events.map(one => [one.reason, one.item_id])).toEqual([['failed', 'f1'], ['ask', 'w1']])
  })

  it('★P1 回归:名片被删了认不出时,卡上的派活记录(dispatch)兜底;一条记录都没有才算认不出', () => {
    const scope = { ...TELL_SCOPE_DEFAULT, dispatch: true }
    const id = 'agent:local:codex-code'
    // 名片表里没有这张名片,但卡上留着派活记录 → 仍是派出去的活。
    const withRecord = dispatched({ id: 'p2', status: 'confirm', assignee: id, dispatch: { family: 'codex', status: 'done', started_at: '2026-10-23T10:00:00.000Z' }, owner_ask: OWNER_ASK })
    expect(callOutEventsOf({ tasks: board([withRecord], []), scope })).toHaveLength(1)
    // 名片没了、派活记录也没有(负责人驱动认不出就不派的那种)→ 不出。
    const orphan = dispatched({ id: 'p3', status: 'confirm', assignee: id, owner_ask: OWNER_ASK })
    expect(callOutEventsOf({ tasks: board([orphan], []), scope })).toEqual([])
    // 负责人不是家名也不是名片(人 / 同事 / 事务官),就算有 dispatch 之外的形状也不许混进来:没有派活记录就不出。
    const person = dispatched({ id: 'p4', status: 'confirm', assignee: 'colleague', owner_ask: OWNER_ASK })
    expect(callOutEventsOf({ tasks: board([person], []), scope })).toEqual([])
  })

  it('★P1 回归:没有负责人、只凭卡上的派活记录(dispatch)也算派出去的活', () => {
    const scope = { ...TELL_SCOPE_DEFAULT, dispatch: true }
    const one = dispatched({ id: 'p5', status: 'confirm', dispatch: { family: 'doubao', status: 'done', started_at: '2026-10-23T10:00:00.000Z' }, owner_ask: OWNER_ASK })
    delete (one as unknown as Record<string, unknown>).assignee
    expect(callOutEventsOf({ tasks: board([one], []), scope })).toHaveLength(1)
    expect(callOutEventsOf({ tasks: board([one], []) })).toEqual([])
  })
})

describe('偏好服务(dispatch-prefs.json)', () => {
  it('缺省:文件不在 / 读不懂 = 缺省值(交办、会议、例程勾着;派活不勾;桌面不问就派关)', async () => {
    const dir = tmpDir()
    const prefs = createDispatchPrefsService({ file: join(dir, 'prefs.json') })
    await prefs.load()
    expect(prefs.view()).toEqual(DISPATCH_PREFS_DEFAULT)
    expect(prefs.view().tell_scope).toEqual({ mine: true, dispatch: false, meeting: true, routine: true })
    expect(prefs.view().auto_desk).toBe(false)

    const broken = createDispatchPrefsService({ file: join(dir, 'broken.json') })
    await broken.save({ auto_desk: true })
    // 写进去再手工弄脏:读不懂 = 缺省,不让工作台起不来。
    const { writeFileSync } = await import('node:fs')
    writeFileSync(join(dir, 'broken.json'), '{not json', 'utf8')
    await broken.load()
    expect(broken.view()).toEqual(DISPATCH_PREFS_DEFAULT)
  })

  it('存 / 取回:勾派活、开桌面直派;只给一部分时另一部分不动', async () => {
    const dir = tmpDir()
    const file = join(dir, 'prefs.json')
    const prefs = createDispatchPrefsService({ file })
    await prefs.load()
    await prefs.save({ tell_scope: { dispatch: true } })
    expect(prefs.view().tell_scope.dispatch).toBe(true)
    expect(prefs.view().tell_scope.mine).toBe(true)
    await prefs.save({ auto_desk: true })
    const again = createDispatchPrefsService({ file })
    await again.load()
    expect(again.view()).toEqual({ tell_scope: { mine: true, dispatch: true, meeting: true, routine: true }, auto_desk: true })
  })

  it('解析:缺格 / 错类型按缺省补,不认的键不炸', () => {
    expect(parseTellScope(undefined)).toEqual(TELL_SCOPE_DEFAULT)
    expect(parseTellScope({ mine: false, dispatch: 'yes' })).toEqual({ ...TELL_SCOPE_DEFAULT, mine: false })
    expect(parseDispatchPrefs(null)).toEqual(DISPATCH_PREFS_DEFAULT)
    expect(parseDispatchPrefs({ auto_desk: 1, tell_scope: { meeting: false } }))
      .toEqual({ tell_scope: { ...TELL_SCOPE_DEFAULT, meeting: false }, auto_desk: false })
  })

  it('缺省文件在 用户层/偏好/ 下(2026-10-26 切割收尾,与规矩、改过的提示词同一格)', () => {
    expect(defaultDispatchPrefsFile('/Users/x')).toBe('/Users/x/.dsh/workbench/用户层/偏好/dispatch-prefs.json')
  })

  it('类型中文名在协议里(设置页勾选用)', () => {
    expect(TELL_KIND_TITLES).toEqual({ mine: '交办', dispatch: '派活', meeting: '会议', routine: '例程' })
  })
})

describe('座机服务那一拍从 tellScope 口读', () => {
  it('pump 用此刻的开关:关掉「交办」后,交给事务官办的卡不再排进来', async () => {
    let seq = 0
    let scope = TELL_SCOPE_DEFAULT
    const service = createCallOutService({
      file: join(tmpDir(), 'call-out.json'),
      newId: () => `call-${++seq}`,
      now: () => new Date('2026-10-23T14:00:00').getTime(),
      tasks: { list: async () => board([MINE_CONFIRM()]) },
      tellScope: () => scope,
    })
    await service.load()
    await service.pump()
    expect(service.view().entries).toHaveLength(1)
    // 她刚动过手也不会排第二通(seen 去重),所以另起一台、只换开关。
    const service2 = createCallOutService({
      file: join(tmpDir(), 'call-out.json'),
      newId: () => `call-${++seq}`,
      now: () => new Date('2026-10-23T14:00:00').getTime(),
      tasks: { list: async () => board([MINE_CONFIRM()]) },
      tellScope: () => ({ ...scope, mine: false }),
    })
    await service2.load()
    await service2.pump()
    expect(service2.view().entries).toHaveLength(0)
  })
})
