/**
 * 手机拨出那一通,开场白前面垫**一秒多**静音(2026-09-28 19:2x,统筹)。
 *
 * 维护者 Pixel 真机(0.4.56 + 新手机包):工人日志「手机在请她开口之前就说它这边在放了(等了 0ms),开口」,
 * 他照旧只听到「何吩咐」—— 前面约 0.8–1 秒被吃。手机拿去烘热的那段静音走的是媒体那一路,
 * 通话声音是另一路,烘热不到。最直接的一招:**顺着同一路通话音轨先发静音帧**把它冲开。
 * 座机话筒(树莓派 aplay 管子常开)不吃字,照旧 260ms。
 */
import { describe, expect, it } from 'vitest'
import { channelWorkerConfigOf } from '../src/config.ts'
import { OPENER_LEAD_PHONE_SILENCE_MS, OPENER_LEAD_SILENCE_MS, openerLeadFor } from '../src/tts/greeting.ts'

describe('手机拨出那一通开场前垫的静音(09-28 19:2x)', () => {
  it('缺省 1200ms,可用 WORKBENCH_CHANNEL_OPENER_LEAD_PHONE_MS 改', () => {
    expect(OPENER_LEAD_PHONE_SILENCE_MS).toBe(1200)
    expect(channelWorkerConfigOf({}, '/home/ben').openerLeadPhoneMs).toBe(1200)
    expect(channelWorkerConfigOf({ WORKBENCH_CHANNEL_OPENER_LEAD_PHONE_MS: '900' }, '/home/ben').openerLeadPhoneMs).toBe(900)
  })

  it('★ 手机拨出用长的那一档;座机话筒与不知道是谁的照旧 260ms', () => {
    const config = channelWorkerConfigOf({}, '/home/ben')
    expect(openerLeadFor('phone', config)).toBe(1200)
    expect(openerLeadFor('handset', config)).toBe(OPENER_LEAD_SILENCE_MS)
    expect(openerLeadFor(undefined, config)).toBe(OPENER_LEAD_SILENCE_MS)
  })
})

describe('垫的那一段不能是纯零(19:3x:垫了 1200ms 还是吃掉「老板」)', () => {
  it('★ 极轻的底噪:不全是零(纯零会被通话编码当成「没声音」省掉不发),又轻到听不见(|样本| ≤ 4)', async () => {
    const { silencePcm } = await import('../src/tts/greeting.ts')
    const pcm = silencePcm(100, 16_000)
    expect(pcm.length).toBe(1600 * 2)
    let nonZero = 0
    let peak = 0
    for (let i = 0; i < pcm.length; i += 2) {
      const v = pcm.readInt16LE(i)
      if (v !== 0) nonZero += 1
      peak = Math.max(peak, Math.abs(v))
    }
    expect(nonZero).toBeGreaterThan(1600 / 2)
    expect(peak).toBeLessThanOrEqual(4)
  })
})
