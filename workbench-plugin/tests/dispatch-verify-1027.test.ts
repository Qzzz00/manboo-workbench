// @vitest-environment node
/**
 * 交回核验纯核(2026-10-27,卡 t-bd1c04ed):逐条核验收条件,模型缺席/坏回执 = 核不了,
 * 不猜不冒充;pass 必须明说 true。退修话术把没做到的条照实列出。
 */
import { describe, expect, it } from 'vitest'
import { literalPassOf, reworkTextOf, verifyAcceptance, VERIFY_SYSTEM } from '../src/server/dispatchVerify.ts'

describe('verifyAcceptance:逐条核,核不了如实', () => {
  const input = { acceptance: ['面板有 Kimi 列', '数字与后台一致'], receipt: '做完了:面板加了 Kimi 列,数字与后台对过。', title: '接用量' }

  const passItems = '{"items":[{"condition":"面板有 Kimi 列","met":true,"evidence":"面板加了 Kimi 列"},{"condition":"数字与后台一致","met":true,"evidence":"数字与后台对过"}]}'

  it('全过且证据逐字出自回执 → pass', async () => {
    const got = await verifyAcceptance(input, { askModel: async () => passItems })
    expect(got).toEqual({ verdict: 'pass' })
  })

  it('缺一条 → fail + missing 照抄条件原文', async () => {
    const got = await verifyAcceptance(input, { askModel: async () => '{"items":[{"condition":"面板有 Kimi 列","met":true,"evidence":"面板加了 Kimi 列"},{"condition":"数字与后台一致","met":false,"evidence":""}]}' })
    expect(got).toEqual({ verdict: 'fail', missing: ['数字与后台一致'] })
  })

  it('★拿别的对象抵(「验收日期」抵「验收人:验收员甲」)→ 字面重叠不过 = 不算数(真机假过红例)', async () => {
    // 回执里有「验收日期:2026-10-27」;判词拿它当「验收人:验收员甲」的证据 —— 与条件无 ≥4 字重叠。
    const tricky = { acceptance: ['第一行是「工作台验收」', '文末有「验收人:验收员甲」一行'], receipt: '做完了:首行「工作台验收」;文末加「验收日期:2026-10-27」。', title: '改 README' }
    const got = await verifyAcceptance(tricky, { askModel: async () => '{"items":[{"condition":"第一行是「工作台验收」","met":true,"evidence":"首行「工作台验收」"},{"condition":"文末有「验收人:验收员甲」一行","met":true,"evidence":"文末加「验收日期:2026-10-27」"}]}' })
    expect(got).toMatchObject({ verdict: 'fail' })
    if (got.verdict === 'fail') expect(got.missing[0]).toContain('验收人:验收员甲')
    // 公共前缀「文末有「」一行」不构成重叠:同前缀、不同对象必须不过。
  })

  it('对象比对:真做了的那条过,偷换对象的那条不过', async () => {
    const done = { acceptance: ['第一行是「工作台验收」', '文末有「验收人:验收员甲」一行'], receipt: '做完了:首行「工作台验收」;文末已加「验收人:验收员甲」。', title: '改 README' }
    const ok = await verifyAcceptance(done, { askModel: async () => '{"items":[{"condition":"第一行是「工作台验收」","met":true,"evidence":"首行「工作台验收」"},{"condition":"文末有「验收人:验收员甲」一行","met":true,"evidence":"文末已加「验收人:验收员甲」"}]}' })
    expect(ok).toEqual({ verdict: 'pass' })
  })

  it('★判词说过了但引的证据不在回执里 → 这条不算数(真机假过红例的加固)', async () => {
    const got = await verifyAcceptance(input, { askModel: async () => '{"items":[{"condition":"面板有 Kimi 列","met":true,"evidence":"面板加了 Kimi 列"},{"condition":"数字与后台一致","met":true,"evidence":"与后台核对无误"}]}' })
    // receipt 里没有「数字与后台对过」→ 第二条证据不成立。
    expect(got).toMatchObject({ verdict: 'fail' })
  })

  it('模型没接成 / 回执坏 / 旧形状(无逐条 evidence)→ unknown(不冒充过)', async () => {
    expect(await verifyAcceptance(input, { askModel: async () => undefined })).toEqual({ verdict: 'unknown', why: '理解服务没接成' })
    expect(await verifyAcceptance(input, { askModel: async () => 'not json' })).toMatchObject({ verdict: 'unknown' })
    expect(await verifyAcceptance(input, { askModel: async () => '{"weird":1}' })).toMatchObject({ verdict: 'unknown' })
    // 旧的 {"pass":true} 没有逐条证据 —— 一律 unknown,不拿没有证据的判词当真。
    expect(await verifyAcceptance(input, { askModel: async () => '{"pass":true}' })).toMatchObject({ verdict: 'unknown' })
  })

  it('字面兜底:逐字包含(去空白)才算过 —— 保守档不冒充智能', () => {
    expect(literalPassOf(['面板有 Kimi 列'], '做完了:面板有 Kimi 列。')).toEqual({ pass: true, missing: [] })
    expect(literalPassOf(['面板有 Kimi 列'], '做完了:别的。').pass).toBe(false)
  })

  it('退修话术:缺哪条说哪条 + 全条件复述', () => {
    const text = reworkTextOf(['数字与后台一致'], input.acceptance)
    expect(text).toContain('数字与后台一致')
    expect(text).toContain('面板有 Kimi 列')
  })

  it('SYSTEM 只让回 JSON 且不许放水', () => {
    expect(VERIFY_SYSTEM).toContain('只回 JSON')
    expect(VERIFY_SYSTEM).toContain('不许')
  })
})
