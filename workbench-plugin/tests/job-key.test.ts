/**
 * **「这件事」的键只有一处定法**(2026-10-02,卡 AG2;`src/server/jobKey.ts`)。
 *
 * 卡 AG 留下的口子(交接第二节 D 末尾):捎话轻账与会话那六只手上**没有事项 id**,
 * 于是动作闸的第一条规矩(收场了就不再动那一家)在那几条路上退化成只管次数。
 * 这一份守三件事:
 * ① 有事项就用事项 id,没有就用会话键(拼 / 拆只在这一处);
 * ② **有卡认领了这条会话**就按那张卡算 —— 这就是「有对应事项的带上」那一半;
 * ③ **查不出的一律 `unknown`(放行)**:什么都不知道的时候不许拦她的活,也不许把查不到说成收场了。
 */
import { describe, expect, it } from 'vitest'
import {
  SESSION_JOB_PREFIX,
  SESSION_JOB_SEP,
  itemOfSession,
  jobPhaseOf,
  legacySessionOfJob,
  sessionJobId,
  sessionOfJob,
} from '../src/server/jobKey.ts'
import type { JobKeyTask } from '../src/server/jobKey.ts'
import { sessionAskCallOutEvents } from '../src/server/sessionAskCalls.ts'
import { waitingOnHim } from '../src/waiting.ts'
import { runningNow } from '../src/running.ts'
import type { SessionView, WorkbenchState } from '../src/protocol.ts'

const DOUBAO_SESSION = 'window:825f1900'

describe('键:事项 id 优先,没有就用会话', () => {
  it('会话键拼得出、拆得回来', () => {
    const job = sessionJobId('doubao', DOUBAO_SESSION)
    expect(job.startsWith(SESSION_JOB_PREFIX)).toBe(true)
    // 窗口型的会话 id 自己带冒号 —— 拆的时候一个字都不能丢。
    expect(sessionOfJob(job)).toEqual({ agent: 'doubao', sessionId: DOUBAO_SESSION })
  })

  it('事项 id 不是会话键(别把它当会话拆)', () => {
    expect(sessionOfJob('t-59322587')).toBeUndefined()
    expect(sessionOfJob('relay:r-1')).toBeUndefined()
    expect(sessionOfJob(`${SESSION_JOB_PREFIX}doubao`)).toBeUndefined()
  })
})

describe('这条会话归哪一件事', () => {
  const tasks: readonly JobKeyTask[] = [
    { id: 't-1', status: 'doing', client_dispatch: { family: 'doubao', session_id: DOUBAO_SESSION } },
    { id: 't-2', status: 'done', client_dispatch: { family: 'codex', session_id: 's-codex' } },
    { id: 't-3', status: 'todo' },
  ]

  it('卡上认下的那条会话认得出来', () => {
    expect(itemOfSession(tasks, 'doubao', DOUBAO_SESSION)).toBe('t-1')
    expect(itemOfSession(tasks, 'codex', 's-codex')).toBe('t-2')
  })

  it('同一个会话 id 但不是同一家 → 不算(宁可没有这一格,也不指到别人的事上)', () => {
    expect(itemOfSession(tasks, 'claude', DOUBAO_SESSION)).toBeUndefined()
  })

  it('没有一张卡认领就缺席(**不硬造一张卡**)', () => {
    expect(itemOfSession(tasks, 'manus', 'window:aaaa')).toBeUndefined()
  })
})

describe('这个键此刻收场了没有', () => {
  const tasks: readonly JobKeyTask[] = [
    { id: 't-open', status: 'doing' },
    { id: 't-done', status: 'done' },
    { id: 't-cancel', status: 'canceled' },
    { id: 't-card', status: 'done', client_dispatch: { family: 'doubao', session_id: DOUBAO_SESSION } },
  ]
  const sessions = [
    { agent: 'doubao', session_id: DOUBAO_SESSION },
    { agent: 'doubao', session_id: 'window:other' },
  ]

  it('事项 id:办完 / 取消 = 收场,别的还动得', () => {
    expect(jobPhaseOf({ job: 't-open', tasks, sessions })).toBe('open')
    expect(jobPhaseOf({ job: 't-done', tasks, sessions })).toBe('settled')
    expect(jobPhaseOf({ job: 't-cancel', tasks, sessions })).toBe('settled')
  })

  it('★会话键:认领这条会话的那张卡收了 → 这条路也一起停手(「有对应事项的带上」)', () => {
    expect(jobPhaseOf({ job: sessionJobId('doubao', DOUBAO_SESSION), tasks, sessions })).toBe('settled')
  })

  it('★会话键:没卡认领、会话还在清单上 → 还在办', () => {
    expect(jobPhaseOf({ job: sessionJobId('doubao', 'window:other'), tasks, sessions })).toBe('open')
  })

  it('★会话键:这一家的清单查得到、这一条不在里面 → 收场(那条对话关掉了)', () => {
    expect(jobPhaseOf({ job: sessionJobId('doubao', 'window:gone'), tasks, sessions })).toBe('settled')
  })

  it('★连这一家的清单都没有(壳没连上 / 还没扫到)→ 查不出,照旧放行', () => {
    expect(jobPhaseOf({ job: sessionJobId('manus', 'window:x'), tasks, sessions })).toBe('unknown')
    expect(jobPhaseOf({ job: sessionJobId('doubao', DOUBAO_SESSION), tasks: [], sessions: [] })).toBe('unknown')
  })

  it('既不是看板上的卡、也不是会话键 → 查不出', () => {
    expect(jobPhaseOf({ job: 'r-1', tasks, sessions })).toBe('unknown')
  })
})


/**
 * ★ **三处同一种**(2026-10-03,卡「两条接缝」;审计第二表第 15 条)。
 *
 * 从前同一个 `session:` 前缀在三处是三个意思:
 *   - 闸与账(`jobKey.sessionJobId`):`session:<家>/<会话 id>`;
 *   - 座机台账的 `item_id`(`sessionAskCalls`):`session:<会话 id>`,**没有家名**;
 *   - `/state.waiting` 与 `/state.running` 那一行的 `key`:`session:<家>:<会话 id>`,**分隔符是冒号**,
 *     而窗口型那几条会话 id 自己带冒号,于是拆的时候要「只切第一刀 / 前两刀」各写一遍。
 *
 * 这一组**真去跑那三处**,比对出来的串逐字相同 —— 不写「逐字相同」的注释代替测试。
 */
describe('★ 三处同一种:闸与账 / 座机台账 / 「等你」与「在跑」那一行', () => {
  const ASKING = {
    agent: 'doubao',
    session_id: DOUBAO_SESSION,
    project: '',
    status: 'waiting',
    elapsed_sec: 60,
    last_output_sec: 10,
    unread: false,
    updated_at: '2026-10-03T08:00:00+08:00',
    ask: { kind: 'choose', by: 'form', question: '要不要发出去?', since: '2026-10-03T07:59:00+08:00', options: [{ label: '发出去' }], reply: 'desk' },
  } as unknown as SessionView

  const RUNNING = { ...ASKING, status: 'running', ask: undefined } as unknown as SessionView

  const stateOf = (sessions: readonly SessionView[]): WorkbenchState => ({
    now: '2026-10-03T08:00:00+08:00',
    sessions,
  } as WorkbenchState)

  it('★ 座机台账那条 ask 的 item_id = 闸的会话键', () => {
    const events = sessionAskCallOutEvents({ sessions: [ASKING as never] })
    expect(events).toHaveLength(1)
    expect(events[0]?.item_id).toBe(sessionJobId('doubao', DOUBAO_SESSION))
  })

  it('★ 「等你」那一行的 key = 闸的会话键', () => {
    const pile = waitingOnHim(stateOf([ASKING]))
    expect(pile.items.map(one => one.key)).toEqual([sessionJobId('doubao', DOUBAO_SESSION)])
  })

  it('★ 「在跑」那一行的 key = 闸的会话键', () => {
    const running = runningNow(stateOf([RUNNING]))
    expect(running.items.map(one => one.key)).toEqual([sessionJobId('doubao', DOUBAO_SESSION)])
  })

  it('★ 分隔符是斜杠(冒号那一版拆不开窗口型会话 id)', () => {
    expect(SESSION_JOB_SEP).toBe('/')
    expect(sessionJobId('doubao', DOUBAO_SESSION)).toBe('session:doubao/window:825f1900')
  })
})

describe('★ 老格式:两种各自读,不自动认(它们彼此有歧义)', () => {
  it('台账那一种(没有家名):整截都是会话 id', () => {
    expect(legacySessionOfJob('session:window:825f1900', { withAgent: false })).toEqual({ sessionId: 'window:825f1900' })
    expect(legacySessionOfJob('session:d777', { withAgent: false })).toEqual({ sessionId: 'd777' })
  })

  it('「等你」那一行的老键(冒号那一种):切第一刀', () => {
    expect(legacySessionOfJob('session:doubao:window:825f1900', { withAgent: true }))
      .toEqual({ agent: 'doubao', sessionId: 'window:825f1900' })
  })

  it('★ 新格式不是老格式 —— 不然迁移会把家名拼两遍', () => {
    expect(legacySessionOfJob(sessionJobId('doubao', DOUBAO_SESSION), { withAgent: false })).toBeUndefined()
    expect(legacySessionOfJob(sessionJobId('doubao', DOUBAO_SESSION), { withAgent: true })).toBeUndefined()
  })

  it('认不出的一律 undefined(不猜)', () => {
    expect(legacySessionOfJob('t-59322587', { withAgent: false })).toBeUndefined()
    expect(legacySessionOfJob('session:', { withAgent: false })).toBeUndefined()
    expect(legacySessionOfJob('session:d777', { withAgent: true })).toBeUndefined()
  })
})
