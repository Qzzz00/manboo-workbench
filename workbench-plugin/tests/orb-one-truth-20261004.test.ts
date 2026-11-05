/**
 * ★ **球的颜色一处算、两端只显示**(2026-10-04,卡「球的颜色一处算」)。
 *
 * 维护者 10-04 原话(经工作台捎话):「有一个镜头发现手机的粒子球和电脑上粒子球两个的状态不一样、
 * 颜色比如状态……我担心他跟到最新版两个端还是会有一样的问题」。
 *
 * 根子是两端各自从 /state 推算:电脑在 `client/butlerSceneModel.ts`(0.4.96 刚改成「只认此刻正在执行的
 * 那件出错才红」),手机在 `butler-app/src/swarm/orbState.ts`(红的判据还是「有一件还开着的事出过错」=> 永久红)。
 *
 * 这一份钉三件事:
 * ① `src/orbCell.ts` 的判据(= 0.4.96 电脑端那一套)；
 * ② 它与 0.4.96 电脑端本地那一套**在同一份状态上结论相同**(搬家没搬错)；
 * ③ 两端那一条对照(同一份 /state,电脑与手机算出的 notice 相同)在手机那一侧:
 *    `butler-app/tests/orbOneTruthParity.test.ts` —— 它跨目录 import 这里的 `src/orbCell.ts`,
 *    把同一份夹具喂给两边。**方向只能是那一边**:本仓的 tsconfig 比手机那边严
 *    (`exactOptionalPropertyTypes` / `noUncheckedIndexedAccess`),反过来 import 会把手机源码一起判红。
 */
import { describe, expect, it } from 'vitest'
import type { CallOutEntry, SessionView, TaskView, WorkbenchState } from '../src/protocol.ts'
import { activeFailureOf as cellActiveFailureOf, blockedCountOf, callingNowOf as cellCallingNowOf, orbCellOf } from '../src/orbCell.ts'
import { activeFailureOf, buildButlerScene, callingNowOf, orbNoticeOf } from '../src/client/butlerSceneModel.ts'
import { deriveButlerInbox } from '../src/server/butlerInbox.ts'

const NOW = '2026-10-04T10:00:00.000Z'

const session = (more: Partial<SessionView> & Pick<SessionView, 'agent' | 'session_id'>): SessionView => ({
  project: '工作台', status: 'running', elapsed_sec: 60, unread: false, updated_at: '2026-10-04T09:59:00.000Z', ...more,
})

const task = (id: string, status: TaskView['status'], more: Partial<TaskView> = {}): TaskView => ({
  id, title: id, status, direction: 'mine', source: { kind: 'manual' },
  created_at: '2026-10-04T09:00:00.000Z', updated_at: '2026-10-04T09:30:00.000Z', ...more,
})

function state(tasks: TaskView[], sessions: SessionView[] = [], more: Partial<WorkbenchState> = {}): WorkbenchState {
  const base: WorkbenchState = {
    agents: [], sessions, quota: {}, stale: false, now: NOW,
    tasks: { tasks, sprints: [], modules: [], project_meta: [] }, butler_inbox: { items: [] },
    ...more,
  }
  return { ...base, butler_inbox: more.butler_inbox ?? deriveButlerInbox({ tasks: base.tasks, sessions: base.sessions }) }
}

const callEntry = (more: Partial<CallOutEntry>): CallOutEntry => ({
  id: 'c-1', reason: 'ask', state: 'queued', created_at: '2026-10-04T09:00:00Z', ...more,
} as CallOutEntry)

/** 座机台账那一格(只填判据读的 `entries`;`missed` 是整本的未接数,这里用不上)。 */
const callOut = (entries: CallOutEntry[]): NonNullable<WorkbenchState['call_out']> =>
  ({ config: {}, entries, missed: 0 } as unknown as NonNullable<WorkbenchState['call_out']>)

/** 此刻真有一件在跑、而且就是它出错了(球该红的那一种)。 */
function failingNow(): WorkbenchState {
  return state(
    [task('t-now', 'doing', { block_reason: 'error', links: [{ agent: 'codex', session_id: 'codex-1' }] })],
    [session({ agent: 'codex', session_id: 'codex-1', status: 'running' })],
  )
}

/** 上周那件早就放下的事(出过错、不在跑)—— 球**不该**红,它只进「受阻 N」。 */
function oldFailure(): WorkbenchState {
  return state([task('t-last-week', 'blocked', { block_reason: 'error' })])
}

describe('★ 判据:红只认此刻正在执行的那件出错', () => {
  it('正在跑的那件出错 → 红', () => {
    const cell = orbCellOf(failingNow())
    expect(cell.active_failure).toBe(true)
    expect(cell.notice).toBe('failed')
    expect(cell.working).toBe(true)
  })

  it('上周那件出过错、早就不跑了 → 球中性,只记进「受阻 1」', () => {
    const cell = orbCellOf(oldFailure())
    expect(cell.active_failure).toBe(false)
    expect(cell.notice).toBe('neutral')
    expect(cell.blocked).toBe(1)
    expect(cell.working).toBe(false)
  })

  it('快照冻结(电脑掉线)不说在办、也不红 —— 数不出来就不编', () => {
    const cell = orbCellOf({ ...failingNow(), stale: true })
    expect(cell.working).toBe(false)
    expect(cell.active_failure).toBe(false)
    expect(cell.notice).toBe('neutral')
  })

  it('办完 / 取消了的那几件,当初那条出错不再算', () => {
    const cell = orbCellOf(state([
      task('t-done', 'done', { block_reason: 'error' }),
      task('t-canceled', 'canceled', { block_reason: 'error' }),
    ]))
    expect(cell.blocked).toBe(0)
    expect(cell.notice).toBe('neutral')
  })

  it('他按的停止(dispatch.stopped)不是出错', () => {
    const stopped = orbCellOf(state([task('t-stopped', 'doing', { dispatch: { family: 'codex', status: 'failed', started_at: NOW, stopped: 'user' } })]))
    expect(stopped.blocked).toBe(0)
    const really = orbCellOf(state([task('t-failed', 'doing', { dispatch: { family: 'codex', status: 'failed', started_at: NOW } })]))
    expect(really.blocked).toBe(1)
  })
})

describe('★ 判据:等她回话 / 通话中是琥珀', () => {
  it.each([
    ['来电在响', { ringing: [{ agent: 'dsh' as const, session_id: 's-1' }] }],
    ['她按的试铃', { test_ringing: true }],
    ['座机打过去正在响', { call_out: callOut([callEntry({ state: 'ringing' })]) }],
    ['接通了还没挂', { call_out: callOut([callEntry({ state: 'answered' })]) }],
  ] as const)('%s → 琥珀', (_name, patch) => {
    const cell = orbCellOf(state([], [], patch as Partial<WorkbenchState>))
    expect(cell.calling).toBe(true)
    expect(cell.notice).toBe('confirmation')
  })

  it('已经挂了 / 还排着队 → 不算通话', () => {
    expect(cellCallingNowOf({ call_out: callOut([callEntry({ state: 'queued' })]) })).toBe(false)
    expect(cellCallingNowOf({ call_out: callOut([callEntry({ state: 'answered', ended_at: NOW })]) })).toBe(false)
  })

  it('「等你」那一堆有东西(读 /state.waiting 那一格)→ 琥珀', () => {
    const cell = orbCellOf(state([], [], { waiting: { count: 2, items: [] } }))
    expect(cell.waiting).toBe(true)
    expect(cell.notice).toBe('confirmation')
  })

  it('红压过琥珀', () => {
    const cell = orbCellOf({ ...failingNow(), waiting: { count: 3, items: [] }, test_ringing: true })
    expect(cell.notice).toBe('failed')
  })

  it('**永远不发 completed**(电脑把它折成中性、手机根本不产生它,发出来就是两端唯一的分歧点)', () => {
    for (const one of [failingNow(), oldFailure(), state([task('t-done', 'done')])]) {
      expect(['neutral', 'confirmation', 'failed']).toContain(orbCellOf(one).notice)
    }
  })
})

describe('★ 搬家没搬错:服务端这一格 = 0.4.96 电脑端本地那一套', () => {
  const fixtures: [string, WorkbenchState][] = [
    ['正在跑的那件出错', failingNow()],
    ['上周那件出过错', oldFailure()],
    ['一切正常', state([task('t-ok', 'doing'), task('t-done', 'done')])],
    ['卡在阻塞 + 在等某家 + 一件正常', state(
      [
        task('t-blocked', 'blocked'),
        task('t-waiting', 'doing', { links: [{ agent: 'claude', session_id: 's-wait' }] }),
        task('t-ok', 'doing'),
      ],
      [session({ agent: 'claude', session_id: 's-wait', status: 'waiting' })],
    )],
  ]

  it.each(fixtures)('%s:当前故障与「受阻 N」两边一致', (_name, one) => {
    const model = buildButlerScene(one)
    expect(cellActiveFailureOf(one)).toBe(activeFailureOf(model.stage))
    expect(blockedCountOf(one)).toBe(model.blocked)
  })

  it.each(fixtures)('%s:提示色与 0.4.96 那三条推出来的一致', (_name, one) => {
    const model = buildButlerScene(one)
    const legacy = orbNoticeOf({
      activeFailure: activeFailureOf(model.stage),
      // 0.4.96 电脑端这一格数的是 questions + approvals;这一份夹具里两样都没有,与 `waiting` 同为空。
      waitingOnUser: false,
      calling: callingNowOf(one),
      base: model.notice,
    })
    // `completed` 在电脑上折成中性(particleScene.ts),服务端这一格直接不发它。
    expect(orbCellOf(one).notice).toBe(legacy === 'completed' ? 'neutral' : legacy)
  })
})
