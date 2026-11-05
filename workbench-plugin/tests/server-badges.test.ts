// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { createBadgesSampler, parseStatusLabel } from '../src/server/badges.ts'

// 三条真实样本均取自 §R4 实测记录(2026-08-20),不是编的格式。
const LABEL_EMPTY = '"StatusLabel"={ "label"="" }'
const LABEL_NUMERIC = '"StatusLabel"={ "label"="5" }'
const LABEL_CAP = '"StatusLabel"={ "label"="99+" }'
const LABEL_GARBAGE = '"StatusLabel"={ "label"="●" }'

describe('parseStatusLabel(§R4)', () => {
  it('纯数字字符串 → 数字', () => {
    expect(parseStatusLabel(LABEL_NUMERIC)).toBe(5)
  })
  it('"99+" 这类上限文案 → 按数字部分算', () => {
    expect(parseStatusLabel(LABEL_CAP)).toBe(99)
  })
  it('非空但不是数字/上限文案的垃圾格式 → null,不猜(§R4 明确未实测过非空样本)', () => {
    expect(parseStatusLabel(LABEL_GARBAGE)).toBeNull()
  })
  it('label 为空字符串 → null(这一层不知道"跑没跑",只管解析)', () => {
    expect(parseStatusLabel(LABEL_EMPTY)).toBeNull()
  })
})

/** 造一个按 `-app <bundleID>` 和 `-only <key>` 分派回答的假 lsappinfo。 */
function fakeRun(
  answers: Record<string, { pid?: string, label?: string }>,
  opts: { failPidFor?: string, failLabelFor?: string } = {},
): (cmd: readonly string[]) => Promise<{ ok: boolean, stdout: string }> {
  return async (cmd) => {
    const app = cmd[cmd.indexOf('-app') + 1] as string
    const only = cmd[cmd.indexOf('-only') + 1] as string
    if (only === 'pid') {
      if (app === opts.failPidFor) return { ok: false, stdout: '' }
      const pid = answers[app]?.pid
      return { ok: true, stdout: pid === undefined ? '' : `"pid"=${pid}` }
    }
    if (only === 'StatusLabel') {
      if (app === opts.failLabelFor) return { ok: false, stdout: '' }
      const label = answers[app]?.label
      return { ok: true, stdout: label === undefined ? '' : `"StatusLabel"={ "label"="${label}" }` }
    }
    return { ok: false, stdout: '' }
  }
}

describe('createBadgesSampler(§R4:先查 pid 再解释 StatusLabel)', () => {
  it('跑着且 label 空 → 0(有信号,信号说"没有未读",不是"没接入")', async () => {
    // 真实记录:WeChat2(com.tencent.xinWeChat)运行中,pid=63274,label=""——
    // 2026-08-22 起 wechat 键查的就是这个 bundle id(主微信客户端已删除)。
    const run = fakeRun({ 'com.tencent.xinWeChat': { pid: '63274', label: '' } })
    const sample = await createBadgesSampler(run, () => 0)()
    expect(sample.wechat).toBe(0)
  })

  it('没跑 → null(不是 0——0 会被界面读成"有信号但无未读",这里根本没信号)', async () => {
    // wechat 现在查 com.tencent.xinWeChat,fakeRun 不给它答案即当前未运行。
    const run = fakeRun({})
    const sample = await createBadgesSampler(run, () => 0)()
    expect(sample.wechat).toBeNull()
  })

  it('pid 命令失败 → null,不假装知道有没有在跑', async () => {
    const run = fakeRun({}, { failPidFor: 'com.tencent.WeWorkMac' })
    const sample = await createBadgesSampler(run, () => 0)()
    expect(sample.wecom).toBeNull()
  })

  it('StatusLabel 命令失败(pid 查得到,label 查不到) → null,不猜', async () => {
    const run = fakeRun(
      { 'com.tencent.WeWorkMac': { pid: '3382' } },
      { failLabelFor: 'com.tencent.WeWorkMac' },
    )
    const sample = await createBadgesSampler(run, () => 0)()
    expect(sample.wecom).toBeNull()
  })

  it('两个键同时给出(跑着有未读/跑着无未读)', async () => {
    const run = fakeRun({
      'com.tencent.xinWeChat': { pid: '63274', label: '3' },
      'com.tencent.WeWorkMac': { pid: '3382', label: '' },
    })
    const sample = await createBadgesSampler(run, () => 0)()
    expect(sample).toEqual({ wechat: 3, wecom: 0 })
  })

  it('60 秒最短间隔内复用缓存,不重复发命令(不得靠 setInterval,靠请求驱动)', async () => {
    let calls = 0
    const run = async (cmd: readonly string[]) => {
      calls += 1
      if (cmd.includes('pid')) return { ok: true, stdout: '"pid"=1' }
      return { ok: true, stdout: '"StatusLabel"={ "label"="1" }' }
    }
    let now = 1000
    const sampler = createBadgesSampler(run, () => now, 60)
    await sampler()
    const callsAfterFirst = calls
    now += 30
    await sampler()
    expect(calls).toBe(callsAfterFirst) // 30s < 60s,应该直接回缓存
    now += 31
    await sampler()
    expect(calls).toBeGreaterThan(callsAfterFirst) // 过了 60s,重新采一轮
  })

  it('缺省最短间隔是 5 秒(2026-08-26 症状:60s 缓存让角标出现/消失最坏迟一分钟,Ben 读完消息气泡还挂着)', async () => {
    let calls = 0
    const run = async (cmd: readonly string[]) => {
      calls += 1
      if (cmd.includes('pid')) return { ok: true, stdout: '"pid"=1' }
      return { ok: true, stdout: '"StatusLabel"={ "label"="1" }' }
    }
    let now = 1000
    const sampler = createBadgesSampler(run, () => now) // 不传间隔,吃缺省
    await sampler()
    const callsAfterFirst = calls
    now += 4
    await sampler()
    expect(calls).toBe(callsAfterFirst) // 4s < 5s,回缓存
    now += 2
    await sampler()
    expect(calls).toBeGreaterThan(callsAfterFirst) // 过了 5s,重新采
  })
})
