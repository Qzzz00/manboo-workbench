/**
 * 捎话节流闸误拦(2026-10-23,卡「捎话节流闸误拦」)。
 *
 * 现场:10-23 07:36 维护者在手机上给统筹会话捎话,8791 只有两行 `gate_block · relay_send · claude ·
 * com.anthropic.claudefordesktop · 离上一回太密`(07:36:40.041 与 07:36:40.733),`action-gate.json` 里
 * 这条 job 的记录 `tried: 3` —— 事务官一句捎话一秒内连试几次(工具重试 / 两条路各试一次),第二、三次被
 * 「离上一回太密」拦下;第一次也被拦的疑点是 stale 状态挡路。
 *
 * 这一份守四条口径(判据只在 `actionGate.ts` 一处):
 * ① **整夜没动之后第一次 relay_send 必须放行** —— 前一晚的记录(隔了 6 小时以上)到期清掉,不挡今天第一句;
 * ② **同一 job · 同一句话在窗口内重复 = 同一回**:放行一次、其余**静默合并**(不拦、不计数、不占次数);
 * ③ **不同句第二次在 1 秒内被拦时回那句能念的话**(「刚捎过,这一句没送进去,过几秒再说」),不许静默吞掉;
 * ④ **参数放一处**:去重的开关与窗口都只在 {@link GATE_LIMITS} 那一张表里。
 */
import { describe, expect, it } from 'vitest'
import {
  GATE_LIMITS,
  RELAY_DEDUPED_NOTE,
  RELAY_TOO_SOON_SAY,
  createActionGate,
  gateBlockSay,
} from '../src/server/actionGate.ts'
import type { GateAction, GateLimit, GateRecord, GateRequest } from '../src/server/actionGate.ts'
import { createJobLog } from '../src/server/jobLog.ts'
import { createSessionJobs } from '../src/server/sessionJobs.ts'
import { sessionAgentName } from '../src/waiting.ts'
import { engineHarness } from './helpers/engineHarness.ts'
import type { Job } from '../src/server/engine/adapter.ts'

const JOB = 'session:claude/01a12e47'
const FAMILY = 'claude'
const relay: GateRequest = { job: JOB, family: FAMILY, action: 'relay_send', by: 'user', text: '现在到哪了' }

function gateWith(records: readonly GateRecord[] = [], opts: { limits?: Partial<Record<GateAction, GateLimit>>, startMs?: number } = {}) {
  const clock = { value: opts.startMs ?? Date.UTC(2026, 9, 23, 7, 36, 40, 0) }
  const log = createJobLog({ now: () => new Date(clock.value) })
  const gate = createActionGate({
    phaseOf: () => 'open',
    log,
    now: () => new Date(clock.value),
    ...(opts.limits === undefined ? {} : { limits: opts.limits }),
    store: { load: () => records, save: () => {} },
  })
  return { gate, log, clock }
}

describe('捎话节流闸 · 整夜后首次必须放行', () => {
  it('★前一晚的记录(tried 3、隔了整夜)不挡今天第一句', () => {
    const lastNight = Date.UTC(2026, 9, 22, 22, 0, 0)
    const { gate } = gateWith([{ job: JOB, family: FAMILY, action: 'relay_send', tried: 3, last_ms: lastNight }])
    const v = gate.allow(relay)
    expect(v).toMatchObject({ ok: true, tried: 1 })
  })
})

describe('捎话节流闸 · 同一句话一秒内重试只送一次', () => {
  it('★三次同句:第一次放行、后两次静默合并(不拦、不计数)', () => {
    const { gate, log, clock } = gateWith()
    const a = gate.allow(relay)
    clock.value += 500
    const b = gate.allow(relay)
    clock.value += 200
    const c = gate.allow(relay)
    expect(a).toMatchObject({ ok: true, tried: 1 })
    expect(b).toMatchObject({ ok: true, deduped: true, tried: 1 })
    expect(c).toMatchObject({ ok: true, deduped: true, tried: 1 })
    // 静默:一个 gate_block 都不记进账。
    expect(log.all().filter(one => one.step === 'gate_block')).toHaveLength(0)
  })

  it('★同句重试不占次数:1 秒后换一句照旧算第二回', () => {
    const { gate, clock } = gateWith()
    gate.allow(relay)
    clock.value += 1200
    const v = gate.allow({ ...relay, text: '换个问题' })
    expect(v).toMatchObject({ ok: true, tried: 2 })
  })
})

describe('捎话节流闸 · 不同句被拦回那句能念的话', () => {
  it('★第二句(不同句)在 1 秒内被拦,回「刚捎过,这一句没送进去,过几秒再说」', () => {
    const { gate, clock } = gateWith()
    gate.allow({ ...relay, text: '第一句' })
    clock.value += 500
    const v = gate.allow({ ...relay, text: '第二句' })
    expect(v.ok).toBe(false)
    if (!v.ok) {
      expect(v.why).toBe('too_soon')
      expect(v.say).toBe(RELAY_TOO_SOON_SAY)
    }
  })

  it('★gateBlockSay 对 relay_send 的「太密」说那一句(一处写)', () => {
    expect(gateBlockSay('too_soon', { who: 'Claude', action: 'relay_send', tried: 1 })).toBe(RELAY_TOO_SOON_SAY)
  })
})

describe('捎话节流闸 · 参数放一处', () => {
  it('★relay_send 的去重开关与窗口都在 GATE_LIMITS 一张表里', () => {
    expect(GATE_LIMITS.relay_send.dedupeText).toBe(true)
    expect(GATE_LIMITS.relay_send.minIntervalMs).toBeGreaterThan(0)
    expect(GATE_LIMITS.relay_send.tries).toBeGreaterThan(0)
    // 别家的参数不受影响(去重只开给捎话;替她答那一路由锁屏队的 1.6 秒间隔管)。
    expect(GATE_LIMITS.answer_send.dedupeText).toBeUndefined()
  })

  it('★去重后的那一句人话与拦下那一句人话都是导出的常量', () => {
    expect(typeof RELAY_DEDUPED_NOTE).toBe('string')
    expect(RELAY_DEDUPED_NOTE.length).toBeGreaterThan(0)
    expect(typeof RELAY_TOO_SOON_SAY).toBe('string')
    expect(RELAY_TOO_SOON_SAY.length).toBeGreaterThan(0)
  })
})

describe('捎话节流闸 · 引擎那一路端到端', () => {
  const CLAUDE = 'com.anthropic.claudefordesktop'

  /** 真引擎 + 真闸 + 假壳,钟我自己拨(测 1 秒窗口用)。 */
  function engine() {
    const clock = { value: Date.UTC(2026, 9, 23, 7, 36, 40, 0) }
    const h = engineHarness({
      now: () => new Date(clock.value),
      phaseOf: () => 'open',
      installed: family => (family === 'claude' ? [{ bundle_id: CLAUDE, name: 'Claude', running: true }] : []),
      reply: req => (req.op === 'send_text' ? { submitted: true, method: 'ax_value' } : { found: false }),
    })
    const relayJob: Job = {
      id: 'session:claude/h1',
      family: 'claude',
      kind: 'relay',
      target: { kind: 'session', sessionId: 'h1' },
      text: '现在到哪了',
      marks: ['修手机横屏'],
      expect: 'ack',
      by: 'user',
    }
    return { h, clock, relayJob }
  }

  it('★同句重试:第一次真的送、第二次一个字都不再送(只 1 个 send_text)', async () => {
    const { h, clock, relayJob } = engine()
    const first = await h.engine.run(relayJob)
    clock.value += 500
    const second = await h.engine.run(relayJob)
    // 第一次送出去了(壳答不上证据 → unconfirmed 那一档,不是闸拦的)。
    expect(first.delivered).toBe('unconfirmed')
    expect(h.requests.filter(one => one.op === 'send_text')).toHaveLength(1)
    // 第二次:同一句 = 同一回,`deduped` 那一格,一句都不再送。
    expect(second.deduped).toBe(true)
    expect(second.blocked).toBeUndefined()
    expect(second.why).toBe(RELAY_DEDUPED_NOTE)
    expect(h.requests.filter(one => one.op === 'send_text')).toHaveLength(1)
  })

  it('★过 1 秒换一句 = 新一回,照送', async () => {
    const { h, clock, relayJob } = engine()
    await h.engine.run(relayJob)
    clock.value += 2000
    const third = await h.engine.run({ ...relayJob, text: '换个问题' })
    expect(third.delivered).toBe('unconfirmed')
    expect(h.requests.filter(one => one.op === 'send_text')).toHaveLength(2)
  })

  it('★不同句 1 秒内被拦:回那句能念的话,不接「去电脑上自己说」那截', async () => {
    const { h, clock } = engine()
    const service = createSessionJobs({
      engine: h.engine,
      registry: h.registry,
      sessions: () => [{
        agent: 'claude' as never,
        session_id: 'h1',
        project: 'desktop-workbench',
        title: '修手机横屏',
        status: 'running' as const,
        elapsed_sec: 30,
        unread: false,
        updated_at: '2026-10-02T04:10:00.000Z',
      }],
      entryOf: () => 'claude-desktop',
      agentName: sessionAgentName,
    })
    const first = await service.relay('claude', 'h1', '现在到哪了')
    // 第一句送进去了(壳核不上 → unconfirmed 那一档,不是闸拦)。
    expect(first.ok ? '' : first.status === 200 ? first.why : first.error).not.toContain('太密')
    clock.value += 500
    const second = await service.relay('claude', 'h1', '换个问题')
    expect(second.ok).toBe(false)
    if (!second.ok && second.status === 200) {
      // 回的就是那一句能念的话,不是「这句话得你到电脑上的 Claude 里自己说(…)」。
      expect(second.why).toBe(RELAY_TOO_SOON_SAY)
      expect(second.why).not.toContain('电脑')
    }
  })
})
