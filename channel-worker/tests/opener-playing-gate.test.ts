/**
 * **开场白等到「我这边真的在放了」再开口**(2026-09-28,卡 CF 第 4 条)。
 *
 * 卡 CL 那道闸等的是「对端订上工人音轨了没有」。真机日志(工作台诊断包-20260928-155543)里那一行是:
 *
 * > 开场白:对端订上工人音轨了(等了 0ms),开口。
 *
 * ——小米**十几分钟前**就订上了音轨(手机常驻房间),所以那道闸当场就开;它真正开始出声
 * (切通话音频路由、AudioTrack 重开、播放器起播)晚得多,整句前面一大截还是被吃了。
 * 维护者:「开场白还是被吃,只听到『吩咐』两个字」。
 *
 * 所以判据换成**手机自己说的那一句**:它本地真的开始播远端音轨之后,经数据通道发一条
 * 「我这边在放了」,工人等到它再开口。三条纪律:
 *   · 等不到有上限(缺省 2.5s),到点照旧说,日志里记一行;
 *   · **老手机不发这一条** → 一个字都不等(它接起时没说过「我会报」),逐字回到卡 CL 那一版;
 *   · 这一通结束 / 挂断要把它清掉,不许把上一通的「在放了」算到下一通头上。
 */
import { describe, expect, it, vi } from 'vitest'
import { PLAYING_PRE_ARRIVAL_MS, PLAYING_WAIT_MS, createPlayingGate } from '../src/tts/playingGate.ts'

/** 一台手动推进的计时器。 */
function timers() {
  const pending: { fn: () => void, at: number }[] = []
  let clock = 0
  return {
    now: () => clock,
    setTimer: (fn: () => void, ms: number) => {
      const entry = { fn, at: clock + ms }
      pending.push(entry)
      return () => { const at = pending.indexOf(entry); if (at >= 0) pending.splice(at, 1) }
    },
    advance(ms: number) {
      clock += ms
      for (const entry of [...pending]) {
        if (entry.at > clock) continue
        pending.splice(pending.indexOf(entry), 1)
        entry.fn()
      }
    },
  }
}

describe('等手机说「我这边在放了」', () => {
  it('没说过「我会报」(老手机)→ 一个字都不等', async () => {
    const clock = timers()
    const gate = createPlayingGate({ now: clock.now, setTimer: clock.setTimer })
    expect(await gate.wait()).toEqual({ how: 'skipped', waitedMs: 0 })
  })

  it('说了会报、也报了 → 等那一下,报了就开口', async () => {
    const clock = timers()
    const log = vi.fn()
    const gate = createPlayingGate({ now: clock.now, setTimer: clock.setTimer, log })
    gate.expect('wb-phone-1')
    const waiting = gate.wait()
    clock.advance(180)
    gate.arrived('wb-phone-1')
    const outcome = await waiting
    expect(outcome.how).toBe('playing')
    expect(outcome.waitedMs).toBe(180)
    expect(log.mock.calls.join('\n')).toContain('在放了')
  })

  it('已经报过了再问 → 当场开口(报的比问的早)', async () => {
    const clock = timers()
    const gate = createPlayingGate({ now: clock.now, setTimer: clock.setTimer })
    gate.expect('wb-phone-1')
    gate.arrived('wb-phone-1')
    expect((await gate.wait()).how).toBe('playing')
  })

  it('报的是房里另一台 → 不算(那一台不是这一通说话的人)', async () => {
    const clock = timers()
    const gate = createPlayingGate({ now: clock.now, setTimer: clock.setTimer, timeoutMs: 2500 })
    gate.expect('wb-phone-1')
    const waiting = gate.wait()
    gate.arrived('wb-phone-2')
    clock.advance(2500)
    expect((await waiting).how).toBe('timeout')
  })

  it('说了会报、到点没报 → 照旧开口,日志记一行', async () => {
    const clock = timers()
    const log = vi.fn()
    const gate = createPlayingGate({ now: clock.now, setTimer: clock.setTimer, log })
    gate.expect('wb-phone-1')
    const waiting = gate.wait()
    clock.advance(PLAIN_WAIT)
    const outcome = await waiting
    expect(outcome.how).toBe('timeout')
    expect(outcome.waitedMs).toBe(PLAYING_WAIT_MS)
    expect(log.mock.calls.join('\n')).toContain('照旧开口')
  })

  it('这一通结束就清掉:下一通不许用上一通那一下', async () => {
    const clock = timers()
    const gate = createPlayingGate({ now: clock.now, setTimer: clock.setTimer })
    gate.expect('wb-phone-1')
    gate.arrived('wb-phone-1')
    gate.reset('这一通结束了')
    expect((await gate.wait()).how).toBe('skipped')
  })

  /*
   * ——— 「先到」那一支(2026-09-28,卡 OP)———
   *
   * **他从手机打出去**的那一路顺序是反的:手机先开喇叭(这时它就判得出自己热了、报一条
   * `playing`),之后才发 `call.start`(带 `reports_playing`)—— 也就是说那条 `playing`
   * **一定比 expect 先到**。卡 CF 那一版里先到的那一下被丢掉(那时 `expected` 还是 undefined),
   * 随后 `expect()` 又把 `arrived` 抹成 false,于是每通拨出都白等到上限。
   *
   * 现在先到的记着:同一台、在 {@link PLAYING_PRE_ARRIVAL_MS} 之内,`expect()` 就认它。
   * **不是无条件认**:换一台、过了期、这一通已经清掉了,一律不认 —— 那一下不属于这一通。
   */
  it('手机先报「在放了」、再发接起(他从手机拨出的那一路)→ 认,当场开口', async () => {
    const clock = timers()
    const log = vi.fn()
    const gate = createPlayingGate({ now: clock.now, setTimer: clock.setTimer, log })
    gate.arrived('wb-phone-1', 240)
    clock.advance(80)
    gate.expect('wb-phone-1')
    const outcome = await gate.wait()
    expect(outcome.how).toBe('playing')
    expect(outcome.waitedMs).toBe(0)
    const lines = log.mock.calls.join('\n')
    expect(lines).toContain('在放了')
    // 凭什么开口、手机自己烘热等了多久 —— 统筹真机核的就是这一行。
    expect(lines).toContain('240ms')
  })

  it('先报的过期了 → 不认(那一下不属于这一通)', async () => {
    const clock = timers()
    const gate = createPlayingGate({ now: clock.now, setTimer: clock.setTimer, timeoutMs: 2500 })
    gate.arrived('wb-phone-1')
    clock.advance(PLAYING_PRE_ARRIVAL_MS + 1)
    gate.expect('wb-phone-1')
    const waiting = gate.wait()
    clock.advance(2500)
    expect((await waiting).how).toBe('timeout')
  })

  it('先报的是房里另一台 → 不认', async () => {
    const clock = timers()
    const gate = createPlayingGate({ now: clock.now, setTimer: clock.setTimer, timeoutMs: 2500 })
    gate.arrived('wb-phone-2')
    gate.expect('wb-phone-1')
    const waiting = gate.wait()
    clock.advance(2500)
    expect((await waiting).how).toBe('timeout')
  })

  it('清掉之后先报的那一下也清掉:下一通不许用上一通那一下', async () => {
    const clock = timers()
    const gate = createPlayingGate({ now: clock.now, setTimer: clock.setTimer, timeoutMs: 2500 })
    gate.arrived('wb-phone-1')
    gate.reset('手机挂了')
    gate.expect('wb-phone-1')
    const waiting = gate.wait()
    clock.advance(2500)
    expect((await waiting).how).toBe('timeout')
  })

  it('等着的时候报的,烘热那个数也进日志', async () => {
    const clock = timers()
    const log = vi.fn()
    const gate = createPlayingGate({ now: clock.now, setTimer: clock.setTimer, log })
    gate.expect('wb-phone-1')
    const waiting = gate.wait()
    clock.advance(120)
    gate.arrived('wb-phone-1', 310)
    await waiting
    expect(log.mock.calls.join('\n')).toContain('310ms')
  })

  it('上限设成 0 = 不等(逐字回到卡 CL 那一版)', async () => {
    const clock = timers()
    const gate = createPlayingGate({ now: clock.now, setTimer: clock.setTimer, timeoutMs: 0 })
    gate.expect('wb-phone-1')
    expect((await gate.wait()).how).toBe('skipped')
  })
})

const PLAIN_WAIT = PLAYING_WAIT_MS
