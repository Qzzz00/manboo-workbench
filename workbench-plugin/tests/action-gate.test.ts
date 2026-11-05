/**
 * **一处动作闸:工作台对别家 App 的每一个自动动作都先过它**(2026-10-02,卡 AG)。
 *
 * 维护者 10-02 原话:「你不要拿着打补丁的心态,网易云是一个例子,你要有机制上的调整」。
 * 现场(Air 运营同学,0.4.85):「我让他打开网易云音乐,事务官不能分派让 ai 去打开,
 * 只有在命令里加了【豆包】,他才会通过豆包打开,完成后每隔 10s 又自行打开网易云。。不断弹窗」。
 *
 * 机制上的病根**不是哪一家**:工作台有七八条管线会去动别家的窗(派活送话、重派、盯窗读回、
 * 开窗重试 `open -b`、叫台前、按停止、点选项、批准、捎话),**每条路各自判「还动不动得」**——
 * 有的判了(`dispatchRun.waitingWindowDispatch` 查 `done/canceled`),有的根本没判(捎话轻账只认自己的
 * `state`,20 分钟内一直读那扇窗),而且**没有一条路有「同一件事对同一家同一种动作最多来几回」的上限**。
 * 于是任何一处判漏,工作台就会在事情早已收场之后接着去碰那一家。
 *
 * 这一份守的口径(三条,一处写):
 * ① **收场了就不再动那一家**:`phaseOf(job) === 'settled'`(办完 / 取消 / 撤了)→ 一律拦下;
 * ② **同一件事 · 同一家 · 同一种动作有次数与间隔上限**(重派、开窗都算),到顶停下并**如实告诉她**;
 * ③ **每一次放行 / 拦下都记一行**进任务日志(时间、事项、哪一家、什么动作、为什么)。
 *
 * 还有一条反过来的:**不许每条管线各写一份判断** —— 判据只在这里,管线只问 `allow()`。
 */
import { describe, expect, it } from 'vitest'
import {
  GATE_ACTIONS,
  GATE_ACTION_TEXT,
  GATE_LIMITS,
  createActionGate,
  gateBlockSay,
} from '../src/server/actionGate.ts'
import type { GateAction, JobPhase } from '../src/server/actionGate.ts'
import { createJobLog } from '../src/server/jobLog.ts'

interface Options {
  phase?: JobPhase | ((job: string) => JobPhase)
  nowMs?: { value: number }
  limits?: Partial<Record<GateAction, { tries: number, minIntervalMs: number }>>
}

function gateWith(options: Options = {}) {
  const clock = options.nowMs ?? { value: 0 }
  const log = createJobLog({ now: () => new Date(clock.value) })
  const phase = options.phase ?? 'open'
  const gate = createActionGate({
    phaseOf: typeof phase === 'function' ? phase : () => phase,
    log,
    now: () => new Date(clock.value),
    name: family => (family === 'doubao' ? '豆包办公' : family),
    ...(options.limits === undefined ? {} : { limits: options.limits }),
  })
  return { gate, log, clock }
}

describe('动作闸 · 收场了就不再动那一家', () => {
  /**
   * ★ **她亲手交代的那一下例外**(2026-10-13 夜,卡 Y)。真机:维护者手机上往 Codex「查询 GoSim 深圳活动日期」那条会话里
   * 捎话,那条会话是 10-12 派活起的、卡早已办完 → 闸回「这件已经收场了(办完 / 取消 / 撤了),我不再去把你那句捎进去」。
   * 第 ① 条拦的是工作台自动追着办的(盯窗、重派、巡检);她自己再说一句是新的交代。次数与间隔照旧算。
   */
  it('★她亲手捎的那一下(by: user):收场了也放行;自动的照旧拦;次数上限对她的那一下照旧算', () => {
    const { gate } = gateWith({ phase: 'settled', limits: { relay_send: { tries: 2, minIntervalMs: 0 } } })
    expect(gate.allow({ job: 'session:codex/01a12e47', family: 'codex', action: 'relay_send', by: 'user' })).toMatchObject({ ok: true, tried: 1 })
    expect(gate.allow({ job: 'session:codex/01a12e47', family: 'codex', action: 'relay_send' })).toMatchObject({ ok: false, why: 'settled' })
    expect(gate.allow({ job: 'session:codex/01a12e47', family: 'codex', action: 'reply_watch', by: 'user' })).toMatchObject({ ok: true })
    expect(gate.allow({ job: 'session:codex/01a12e47', family: 'codex', action: 'relay_send', by: 'user' })).toMatchObject({ ok: true, tried: 2 })
    expect(gate.allow({ job: 'session:codex/01a12e47', family: 'codex', action: 'relay_send', by: 'user' })).toMatchObject({ ok: false, why: 'too_many' })
  })

  it('办完 / 取消 / 撤了:每一种动作都拦下', () => {
    const { gate } = gateWith({ phase: 'settled' })
    for (const action of GATE_ACTIONS) {
      const verdict = gate.allow({ job: 't-1', family: 'doubao', action })
      expect(verdict.ok, action).toBe(false)
      if (!verdict.ok) expect(verdict.why).toBe('settled')
    }
  })

  it('拦下那一句是人话:说这件已经收场、说不再动哪一家', () => {
    const { gate } = gateWith({ phase: 'settled' })
    const verdict = gate.allow({ job: 't-1', family: 'doubao', action: 'reply_watch' })
    expect(verdict.ok).toBe(false)
    if (verdict.ok) return
    expect(verdict.say).toContain('豆包办公')
    expect(verdict.say).toBe(gateBlockSay('settled', { who: '豆包办公', action: 'reply_watch', tried: 0 }))
  })

  it('还在办就放行', () => {
    const { gate } = gateWith({ phase: 'open' })
    expect(gate.allow({ job: 't-1', family: 'doubao', action: 'dispatch_send' }).ok).toBe(true)
  })

  it('查不出状态(不在看板上的那几条)不当成收场 —— 照旧放行,但次数上限照算', () => {
    const { gate } = gateWith({ phase: 'unknown' })
    expect(gate.allow({ job: 'r-1', family: 'doubao', action: 'reply_watch' }).ok).toBe(true)
  })
})

describe('动作闸 · 次数与间隔上限', () => {
  it('同一件事 · 同一家 · 同一种动作,到顶就停', () => {
    const clock = { value: 0 }
    const { gate } = gateWith({ nowMs: clock, limits: { window_wake: { tries: 3, minIntervalMs: 0 } } })
    for (let i = 0; i < 3; i += 1) {
      expect(gate.allow({ job: 't-1', family: 'doubao', action: 'window_wake' }).ok, `第 ${i + 1} 回`).toBe(true)
    }
    const over = gate.allow({ job: 't-1', family: 'doubao', action: 'window_wake' })
    expect(over.ok).toBe(false)
    if (!over.ok) {
      expect(over.why).toBe('too_many')
      expect(over.tried).toBe(3)
      // 如实告诉她:来过几回、到顶了。
      expect(over.say).toContain('3')
      expect(over.say).toContain(GATE_ACTION_TEXT.window_wake)
    }
  })

  it('换一种动作、换一家、换一件事,各自从头数', () => {
    const { gate } = gateWith({ limits: { window_wake: { tries: 1, minIntervalMs: 0 }, bring_front: { tries: 1, minIntervalMs: 0 } } })
    expect(gate.allow({ job: 't-1', family: 'doubao', action: 'window_wake' }).ok).toBe(true)
    expect(gate.allow({ job: 't-1', family: 'doubao', action: 'window_wake' }).ok).toBe(false)
    expect(gate.allow({ job: 't-1', family: 'doubao', action: 'bring_front' }).ok).toBe(true)
    expect(gate.allow({ job: 't-1', family: 'codex', action: 'window_wake' }).ok).toBe(true)
    expect(gate.allow({ job: 't-2', family: 'doubao', action: 'window_wake' }).ok).toBe(true)
  })

  it('太密的那一下拦下,等够间隔再放 —— 而且拦下的不算一回', () => {
    const clock = { value: 0 }
    const { gate } = gateWith({ nowMs: clock, limits: { reply_watch: { tries: 2, minIntervalMs: 5000 } } })
    expect(gate.allow({ job: 't-1', family: 'doubao', action: 'reply_watch' }).ok).toBe(true)
    clock.value = 4999
    const soon = gate.allow({ job: 't-1', family: 'doubao', action: 'reply_watch' })
    expect(soon.ok).toBe(false)
    if (!soon.ok) expect(soon.why).toBe('too_soon')
    clock.value = 5000
    expect(gate.allow({ job: 't-1', family: 'doubao', action: 'reply_watch' }).ok).toBe(true)
    // 刚才被「太密」拦下那一下没算进次数,所以这才是第三次 → 到顶。
    clock.value = 20_000
    expect(gate.allow({ job: 't-1', family: 'doubao', action: 'reply_watch' }).ok).toBe(false)
  })

  it('每一种动作都有上限(没有哪一样是无限的)', () => {
    for (const action of GATE_ACTIONS) {
      expect(GATE_LIMITS[action].tries, action).toBeGreaterThan(0)
      expect(GATE_ACTION_TEXT[action], action).not.toBe('')
    }
  })

  it('开窗重试的上限与 windowWake 那一圈是同一个数', () => {
    expect(GATE_LIMITS.window_wake.tries).toBe(3)
  })

  it('她重来一遍(forget)之后从头数', () => {
    const { gate } = gateWith({ limits: { dispatch_resend: { tries: 1, minIntervalMs: 0 } } })
    expect(gate.allow({ job: 't-1', family: 'doubao', action: 'dispatch_resend' }).ok).toBe(true)
    expect(gate.allow({ job: 't-1', family: 'doubao', action: 'dispatch_resend' }).ok).toBe(false)
    gate.forget('t-1')
    expect(gate.allow({ job: 't-1', family: 'doubao', action: 'dispatch_resend' }).ok).toBe(true)
  })
})

describe('动作闸 · 每一次都记一行', () => {
  it('放行记 gate_pass,拦下记 gate_block,都带动作与原因', () => {
    const clock = { value: 1_000 }
    const { gate, log } = gateWith({ nowMs: clock, phase: job => (job === 't-done' ? 'settled' : 'open') })
    gate.allow({ job: 't-1', family: 'doubao', action: 'dispatch_send', bundle_id: 'com.work.pc.doubao' })
    gate.allow({ job: 't-done', family: 'doubao', action: 'reply_watch' })
    const pass = log.events('t-1')
    expect(pass).toHaveLength(1)
    expect(pass[0]?.step).toBe('gate_pass')
    expect(pass[0]?.action).toBe('dispatch_send')
    expect(pass[0]?.bundle_id).toBe('com.work.pc.doubao')
    const block = log.events('t-done')
    expect(block[0]?.step).toBe('gate_block')
    expect(block[0]?.why).toContain('收场')
  })

  it('没接账也照样放行 / 拦下(账缺席不等于闸失效)', () => {
    const gate = createActionGate({ phaseOf: () => 'settled', now: () => new Date(0) })
    expect(gate.allow({ job: 't-1', family: 'doubao', action: 'stop' }).ok).toBe(false)
  })

  it('phaseOf 自己坏了不许把闸带塌 —— 当成查不出,放行', () => {
    const gate = createActionGate({ phaseOf: () => { throw new Error('看板读坏了') }, now: () => new Date(0) })
    expect(gate.allow({ job: 't-1', family: 'doubao', action: 'dispatch_send' }).ok).toBe(true)
  })
})
