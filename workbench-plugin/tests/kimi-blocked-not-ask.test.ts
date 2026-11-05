/**
 * 「Kimi 说完一轮 ≠ 待确认」(2026-09-28,卡 KM)。
 *
 * 真机现场(09-28 10:5x,维护者本机):坞上 Kimi 标签一颗橙色的「1」,而那条对话它早交代完了
 * (一段修复总结,末尾「你验证完如果…,我可以…」),**没有弹任何确认框**。`/state.sessions` 里那条:
 * `status:'waiting'`、`reason:'idle_prompt'`、`formal_wait:null`、
 * `ask:{kind:'approve', question:'Kimi 停下来等你确认', by:'form', where:'…(它那边弹了个框等你点)'}`。
 *
 * 两条路各错一半:
 * - `kimiSessionFeed.resolveKimiStatus`(卡 LK)只在 `mark === 'working'` 时把 `blocked` 掰回「在跑」,
 *   说完一轮(`mark: 'ended'`)仍旧照字面算「等你」;
 * - `waitingForYou.formVerdict` 的 `form:blocked` 那一支**不看证据**:只要状态是 `waiting`、又说不出等什么,
 *   就挂一个 `by:'form'` 的「停下来等你确认」,于是 `overlayWaiting` 把运行状态改成 `waiting`(橙色角标),
 *   `sessionAnswer` 又按 `by:'form'` 补一句「它那边弹了个框等你点」—— 框是编的。
 *
 * 判据统一成一句:**Kimi 的 `blocked` 只有在记录里找得到真的待批/待答请求(`ApprovalRequest` /
 * `QuestionRequest`)时才算「在等你」**;找不到 = 这一轮说完了(蓝点,做完未读),不挂橙色角标、不编框。
 *
 * 下面的 wire 片段照 `~/.kimi/sessions/<摘要>/<id>/wire.jsonl`(protocol 1.10)的**结构**抄,
 * 对话内容一律换成占位。
 */
import { describe, expect, it, vi } from 'vitest'
import type { SessionView, WorkbenchEvent } from '../src/protocol.ts'
import { resolveKimiStatus, startKimiSessionFeed } from '../src/server/kimiSessionFeed.ts'
import { digestKimi } from '../src/server/sessionDigest.ts'
import { decide, overlayWaiting, type WaitVerdict } from '../src/server/waitingForYou.ts'

const lines = (...rows: unknown[]): string => rows.map(row => JSON.stringify(row)).join('\n')

const wrapped = (type: string, payload: Record<string, unknown>, at: string) => ({ timestamp: at, message: { type, payload } })

/** 说完一轮就停:最后一条是 `TurnEnd`,一条 `ApprovalRequest` 都没有 —— 而 Kimi 自己记 `blocked`。 */
const TURN_END = lines(
  { type: 'metadata', protocol_version: '1.10' },
  wrapped('TurnBegin', { turn_id: 'turn-1' }, '2026-09-28T02:40:00.000Z'),
  wrapped('TurnEnd', { turn_id: 'turn-1' }, '2026-09-28T02:51:00.000Z'),
)

/**
 * 真的待批那一条(真机结构:`sender` / `action` / `description` / `display[]`,内容换成占位)。
 * `ApprovalResponse` 一到就不算在等了 —— 这一份里没有。
 */
const APPROVAL = lines(
  { type: 'metadata', protocol_version: '1.10' },
  wrapped('TurnBegin', { turn_id: 'turn-2' }, '2026-09-28T02:40:00.000Z'),
  wrapped('ApprovalRequest', {
    id: '00000000-0000-4000-8000-000000000001',
    tool_call_id: 'tool_0000000000000000000000',
    sender: 'Shell',
    action: 'run command',
    description: 'Run command `<占位命令>`',
    source_kind: 'foreground_turn',
    source_id: '00000000000000000000000000000000',
    agent_id: null,
    subagent_type: null,
    source_description: null,
    display: [{ type: 'shell', language: 'bash', command: '<占位命令>' }],
  }, '2026-09-28T02:50:00.000Z'),
)

const digestOfWire = (text: string) => digestKimi({ head: text, tail: text })

describe('★ Kimi blocked:找不到真审批请求就不算等你(卡 KM)', () => {
  it('记录里最后一条是「这一轮说完了」→ 做完未读(蓝点),不是等你确认', () => {
    const digest = digestOfWire(TURN_END)
    expect(digest.mark).toBe('ended')
    expect(digest.formal_wait).toBeUndefined()
    expect(resolveKimiStatus('waiting', digest)).toBe('done')
  })

  it('记录里有待批的 ApprovalRequest → 还是等你,并说清是要批一步操作', () => {
    const digest = digestOfWire(APPROVAL)
    expect(digest.formal_wait).toBe('approval')
    expect(resolveKimiStatus('waiting', digest)).toBe('waiting')
    expect(decide({ hisTurn: false }, { status: 'waiting', formal_wait: 'approval', agent_name: 'Kimi' }))
      .toMatchObject({ waiting: true, by: 'form', kind: 'approve', question: 'Kimi 要你批准一步操作', rule: 'form:blocked' })
  })

  it('读不到记录、认不出最后一条 → 也不当「等你确认」(没有证据就不编一个框)', () => {
    expect(resolveKimiStatus('waiting', undefined)).toBe('done')
    expect(resolveKimiStatus('waiting', { format: 'kimi-wire', rounds: [] })).toBe('done')
    // 状态说 waiting、又拿不出形式证据:`form:blocked` 那一支不再出手,交给内容判断。
    expect(decide({ hisTurn: false }, { status: 'waiting', agent_name: 'Kimi' })).toMatchObject({ waiting: false })
  })

  it('还在干活 / 球在他那边 → 在跑,不是等你', () => {
    expect(resolveKimiStatus('waiting', { format: 'kimi-wire', rounds: [], mark: 'working' })).toBe('running')
    expect(resolveKimiStatus('waiting', { format: 'kimi-wire', rounds: [], mark: 'asked' })).toBe('running')
  })

  it('真机形状:statuses 说 blocked、记录里它刚说完 → 报 done,坞上是蓝点不是橙色角标', async () => {
    vi.useFakeTimers()
    try {
      const nowSec = Math.floor(Date.parse('2026-09-28T02:55:00Z') / 1000)
      const key = 'agent:main:main:conversation:14243c38-4310-4ec5-ba1d-9d2ca9fd20a9'
      const applied: WorkbenchEvent[] = []
      const feed = startKimiSessionFeed({
        readStatuses: async () => ({ [key]: 'blocked' }),
        readContextUsage: async () => ({ [key]: { updatedAt: '2026-09-28T02:51:00.000Z' } }),
        readConversations: () => new Map([[key, { title: '<占位标题>', records: '/tmp/wire.jsonl' }]]),
        readDigest: async () => digestOfWire(TURN_END),
      }, { applyEvent: event => applied.push(event), now: () => nowSec })
      await vi.advanceTimersByTimeAsync(0)
      feed.stop()

      expect(applied).toHaveLength(1)
      expect(applied[0]?.type).toBe('done')
      expect(applied[0]?.formal_wait).toBeUndefined()
    }
    finally {
      vi.useRealTimers()
    }
  })

  it('内容上顺口问的那一句只挂 ask、不改运行状态:蓝点照旧(卡 V 的纪律,这里再钉一遍)', () => {
    const nowSec = Math.floor(Date.parse('2026-09-28T02:55:00.000Z') / 1000)
    const view: SessionView = {
      agent: 'kimi', session_id: 'k1', project: 'p', status: 'done', elapsed_sec: 240, unread: true,
      updated_at: '2026-09-28T02:51:00.000Z',
    }
    const verdict: WaitVerdict = { waiting: true, certainty: 'sure', kind: 'review', question: '它交了东西等你审', by: 'rules', rule: 'review' }
    const [shown] = overlayWaiting([view], new Map([['kimi:k1', verdict]]), new Map(), { nowSec })
    expect(shown?.status).toBe('done')
    expect(shown?.unread).toBe(true)
    expect(shown?.ask?.by).toBe('rules')
  })

  it('Claude / Codex 说完一轮报的 idle_prompt 同样不算等你:按空闲摆', () => {
    // 形式上不算(reason idle_prompt 走不到 form 那一支),内容上也读不出在问他。
    expect(decide({ hisTurn: false }, { status: 'waiting', reason: 'idle_prompt', agent_name: 'Claude' })).toMatchObject({ waiting: false })
    const nowSec = Math.floor(Date.parse('2026-09-28T02:55:00.000Z') / 1000)
    const view: SessionView = {
      agent: 'claude', session_id: 'c1', project: 'p', status: 'waiting', reason: 'idle_prompt', wait_reason: 'input',
      elapsed_sec: 60, unread: false, updated_at: '2026-09-28T02:54:00.000Z',
    }
    const idle: WaitVerdict = { waiting: false, certainty: 'sure', by: 'rules', rule: 'report' }
    const [shown] = overlayWaiting([view], new Map([['claude:c1', idle]]), new Map(), { nowSec })
    expect(shown?.status).toBe('done')
    expect(shown?.wait_reason).toBeUndefined()
  })
})
