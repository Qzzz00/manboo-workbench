/**
 * ★ 2026-10-04:球的提示色与球下那一行(运营同学交回的那一版,维护者当天拍板)。
 *
 * 病症:`ButlerSceneModel.notice` 数的是「所有**未读**的事项里有没有一件出错」,
 * 于是上周那件早就放下的事把球**永久染红**。拍板:
 *
 * - 红只认「此刻台上**正在执行**的那件出错」;
 * - 历史阻塞改成球下那一行的「受阻 N」,**只在 N>0 时出现**;
 * - 通话中(来电在响 / 接通未挂)与等她回话同一档:琥珀;
 * - 执行中那一档**一个字不改**(维护者硬规矩「球不要蓝」:不另开青色 working 档)。
 *
 * 判据都是纯函数(`client/butlerSceneModel.ts`),这一份直接喂数据。
 */
import { describe, expect, it } from 'vitest'
import type { CallOutEntry, SessionView, TaskView, WorkbenchState } from '../src/protocol.ts'
import {
  activeFailureOf, buildButlerScene, callingNowOf, orbCountsLine, orbNoticeOf,
  type SceneItem,
} from '../src/client/butlerSceneModel.ts'
import { deriveButlerInbox } from '../src/server/butlerInbox.ts'

const task = (id: string, status: TaskView['status'], more: Partial<TaskView> = {}): TaskView => ({
  id, title: id, status, direction: 'mine', source: { kind: 'manual' },
  created_at: '2026-10-04', updated_at: '2026-10-04', ...more,
})

function state(tasks: TaskView[], sessions: SessionView[] = []): WorkbenchState {
  const base: WorkbenchState = {
    agents: [], sessions, quota: {}, stale: false, now: '2026-10-04T10:00:00+08:00',
    tasks: { tasks, sprints: [], modules: [], project_meta: [] }, butler_inbox: { items: [] },
  }
  return { ...base, butler_inbox: deriveButlerInbox({ tasks: base.tasks, sessions: base.sessions }) }
}

/** 台上一张卡,只给判据要读的那两格。 */
const stageCard = (executing: boolean, notice: SceneItem['notice']): Pick<SceneItem, 'executing' | 'notice'> =>
  ({ executing, notice })

const callEntry = (more: Partial<CallOutEntry>): CallOutEntry => ({
  id: 'c-1', reason: 'ask', state: 'queued', created_at: '2026-10-04T09:00:00Z', ...more,
} as CallOutEntry)

describe('当前故障才红,历史阻塞不红', () => {
  it('台上正在执行的那件出错 → 红', () => {
    expect(activeFailureOf([stageCard(true, 'failed')])).toBe(true)
    expect(orbNoticeOf({ activeFailure: true, waitingOnUser: false, calling: false, base: 'neutral' })).toBe('failed')
  })

  it('出过错但**没在执行**的那张不算当前故障', () => {
    expect(activeFailureOf([stageCard(false, 'failed'), stageCard(true, 'neutral')])).toBe(false)
  })

  it('台上一张卡都没有也不算', () => {
    expect(activeFailureOf([])).toBe(false)
  })

  it('历史阻塞把 base 顶成 failed,球也不红 —— 它去「受阻 N」那一行', () => {
    expect(orbNoticeOf({ activeFailure: false, waitingOnUser: false, calling: false, base: 'failed' })).toBe('neutral')
  })

  it('红压过等用户与通话', () => {
    expect(orbNoticeOf({ activeFailure: true, waitingOnUser: true, calling: true, base: 'neutral' })).toBe('failed')
  })
})

describe('通话中进「等用户」那一档(琥珀)', () => {
  it.each([
    ['来电在响', { ringing: [{ agent: 'dsh' as const, session_id: 's-1' }] }],
    ['她按的试铃', { test_ringing: true }],
    ['座机打过去正在响', { call_out: { config: {}, entries: [callEntry({ state: 'ringing' })] } }],
    ['接通了还没挂', { call_out: { config: {}, entries: [callEntry({ state: 'answered' })] } }],
  ] as const)('%s → 在通话里', (_name, patch) => {
    expect(callingNowOf(patch as Parameters<typeof callingNowOf>[0])).toBe(true)
    expect(orbNoticeOf({ activeFailure: false, waitingOnUser: false, calling: true, base: 'neutral' })).toBe('confirmation')
  })

  it.each([
    ['一格都没有', {}],
    ['还排着队', { call_out: { config: {}, entries: [callEntry({ state: 'queued' })] } }],
    ['已经挂了', { call_out: { config: {}, entries: [callEntry({ state: 'answered', ended_at: '2026-10-04T09:05:00Z' })] } }],
    ['没接到', { call_out: { config: {}, entries: [callEntry({ state: 'missed' })] } }],
  ] as const)('%s → 不在通话里', (_name, patch) => {
    expect(callingNowOf(patch as Parameters<typeof callingNowOf>[0])).toBe(false)
  })

  it('等她回话同样是琥珀;都没有就照 base 走', () => {
    expect(orbNoticeOf({ activeFailure: false, waitingOnUser: true, calling: false, base: 'neutral' })).toBe('confirmation')
    expect(orbNoticeOf({ activeFailure: false, waitingOnUser: false, calling: false, base: 'confirmation' })).toBe('confirmation')
  })

  it('执行中不另开一档 —— base 是什么就还是什么(维护者:球不要蓝)', () => {
    expect(orbNoticeOf({ activeFailure: false, waitingOnUser: false, calling: false, base: 'neutral' })).toBe('neutral')
    // `completed` 照现有约定(particleScene.ts 把它折成 neutral),这一层不改写它。
    expect(orbNoticeOf({ activeFailure: false, waitingOnUser: false, calling: false, base: 'completed' })).toBe('completed')
  })
})

describe('球下那一行的「受阻 N」', () => {
  it('N>0 才出现', () => {
    expect(orbCountsLine({ running: 1, queued: 2, waiting: 3, blocked: 0 })).toBe('执行 1 · 排队 2 · 等你 3')
    expect(orbCountsLine({ running: 1, queued: 2, waiting: 3, blocked: 4 })).toBe('执行 1 · 排队 2 · 等你 3 · 受阻 4')
  })

  it('N 数的就是卡住 / 没做成那几件(与台上标「阻塞」那几张同一个判据)', () => {
    const model = buildButlerScene(state([
      task('t-blocked', 'blocked'),
      task('t-error', 'doing', { block_reason: 'error' }),
      task('t-ok', 'doing'),
      task('t-done', 'done'),
      task('t-canceled', 'canceled'),
    ]))
    expect(model.blocked).toBe(2)
    expect(model.items.filter(item => item.blocked).map(item => item.id)).toEqual(['t-blocked', 't-error'])
  })

  it('一件都没卡住就是 0 —— 那一行里不多一个零', () => {
    const model = buildButlerScene(state([task('t-ok', 'doing'), task('t-done', 'done')]))
    expect(model.blocked).toBe(0)
    expect(orbCountsLine({ running: model.running ?? 0, queued: model.groups.queued.length, waiting: 0, blocked: model.blocked }))
      .not.toContain('受阻')
  })
})
