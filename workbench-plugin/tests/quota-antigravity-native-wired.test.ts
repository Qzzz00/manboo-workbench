/**
 * **Antigravity 的额度以「直接问它自己在本机的语言服务」为主,窗口读法兜底**(2026-09-27,卡 AN)。
 *
 * 维护者 11:15 拍板(原话「可以的」)。这几例钉的是接进去之后的行为,不是取数那一半
 * (取数与解析在 `quota-antigravity-native.test.ts`,夹具是实测形状):
 *
 * | 钉什么 | 为什么 |
 * |---|---|
 * | 原生读成了 = **整趟不碰壳**(不 `read_texts`、不叫模型) | 这条路的全部好处就在这 —— 不要辅助功能、不用把他藏起来的窗放出来、不花钱 |
 * | 原生哑了 → **退回窗口读法**,「说明」里说清走的哪条 | 调研 3.2 第一条:窗口读法一条都不删,全降级为兜底 |
 * | 两条都没数 → 把**原生卡在哪一步**也说出来 | D13:不许一句笼统的「读不到」 |
 * | **谁新摆谁** | 原生哑掉之后那个数会越来越旧,不能压住窗口读法刚读到的新数 |
 * | 事件触发那一路**也读**原生这一家 | 卡 AG 的 `onlyKnown` 本来只想挡「要叫模型」的那几家;原生连模型都不叫 |
 */
import { beforeEach, describe, expect, it } from 'vitest'
import type { AgentQuotaView } from '../src/protocol.ts'
import type { OpenQuotaFamily, QuotaAdapterContext } from '../src/server/agentQuota.ts'
import {
  antigravityNativeView, createWindowQuotaReader, forgetQuotaMemory, quotaFor,
} from '../src/server/agentQuota.ts'
import { parseAntigravityQuota } from '../src/quota/antigravityNative.ts'

beforeEach(() => { forgetQuotaMemory() })

const NOW = new Date('2026-09-27T02:30:00.000Z')
const ANTIGRAVITY: OpenQuotaFamily = { id: 'antigravity', title: 'Antigravity', bundleId: 'com.google.antigravity' }

/** 实测那一份的形状(数值按实测那一刻;详见 `quota-antigravity-native.test.ts`)。 */
function groups(fiveHour = 0.98) {
  return parseAntigravityQuota({
    response: {
      groups: [
        {
          displayName: 'Gemini Models',
          buckets: [
            { bucketId: 'gemini-weekly', displayName: 'Weekly Limit Remaining', window: 'weekly', remainingFraction: 1, resetTime: '2026-10-03T07:35:07Z' },
            { bucketId: 'gemini-5h', displayName: 'Five Hour Limit Remaining', window: '5h', remainingFraction: fiveHour, resetTime: '2026-09-27T07:05:04Z' },
          ],
        },
        {
          displayName: 'Claude and GPT models',
          buckets: [
            { bucketId: '3p-weekly', displayName: 'Weekly Limit Remaining', window: 'weekly', remainingFraction: 1, resetTime: '2026-10-04T02:05:04Z' },
            { bucketId: '3p-5h', displayName: 'Five Hour Limit Remaining', window: '5h', remainingFraction: 1, resetTime: '2026-09-27T07:05:04Z' },
          ],
        },
      ],
    },
  })
}

/** 窗口读法那一页(与卡 AG 那份用例里的一字不差)。 */
const PAGE = [
  { id: 'page', text: 'Models & Usage', x: 560, y: 96, window: 0 },
  { id: 'group', text: 'Gemini Models', x: 560, y: 200, window: 0 },
  { id: 'limit', text: 'Weekly Limit Remaining', x: 600, y: 248, window: 0 },
  { id: 'pct', text: '100%', x: 1200, y: 248, window: 0 },
  { id: 'limit', text: 'Five Hour Limit Remaining', x: 600, y: 312, window: 0 },
  { id: 'pct', text: '55%', x: 1200, y: 312, window: 0 },
]
const VERDICT = '{"kind":"numbers","quote":"100%","evidence":"Weekly Limit Remaining","measure":"left_pct","value":100,"items":["100%","55%"],"reason":"限额剩余"}'

function ctx(patch: Partial<QuotaAdapterContext> = {}): QuotaAdapterContext {
  return { quota: {}, now: NOW, ...patch }
}

function world(input: { native?: (at: string) => AgentQuotaView | undefined, clock?: () => Date } = {}) {
  const fake = { shellReads: 0, prompts: 0, scheduled: [] as { fn: () => void, ms: number }[] }
  const r = createWindowQuotaReader({
    request: async (req) => {
      const one = req as { bundle_id?: string }
      if (one.bundle_id !== ANTIGRAVITY.bundleId) return { ok: true, result: { matches: [] } }
      fake.shellReads += 1
      return { ok: true, result: { windows: [{ index: 0, w: 1640, h: 945 }], matches: PAGE, text_nodes: 300, window_count: 1 } }
    },
    helper: () => ({ connected: true, authorized: true, readTexts: true }),
    judgeQuota: async () => { fake.prompts += 1; return VERDICT },
    now: input.clock ?? (() => NOW),
    schedule: (fn, ms) => { fake.scheduled.push({ fn, ms }) },
    readNative: async (family, at) => {
      if (family.bundleId !== ANTIGRAVITY.bundleId) return undefined
      if (input.native === undefined) return undefined
      return input.native(at)
    },
  })
  return { r, fake, fire: () => { for (const one of fake.scheduled.splice(0)) one.fn() } }
}

const nativeOk = (at: string, fiveHour = 0.98): AgentQuotaView =>
  antigravityNativeView({ id: 'antigravity', title: 'Antigravity', at, groups: groups(fiveHour) })

describe('原生那条路读成了', () => {
  it('★整趟不碰壳:不 read_texts、不叫模型', async () => {
    const { r, fake } = world({ native: at => nativeOk(at) })
    await r.refreshOpen([ANTIGRAVITY], { full: true })
    expect(fake.shellReads).toBe(0)
    expect(fake.prompts).toBe(0)
  })

  it('四行两组照它给的原样摆上,那一句说最紧的那一行', async () => {
    const { r } = world({ native: at => nativeOk(at) })
    await r.refreshOpen([ANTIGRAVITY], { full: true })
    const view = quotaFor(ANTIGRAVITY.id, ctx({ open: r.openReadings([ANTIGRAVITY]) }))
    expect(view.state).toBe('numbers')
    expect(view.left_pct).toBe(98)
    expect(view.windows?.map(one => [one.group, one.label, one.left_pct])).toEqual([
      ['Gemini Models', 'Weekly Limit Remaining', 100],
      ['Gemini Models', 'Five Hour Limit Remaining', 98],
      ['Claude and GPT models', 'Weekly Limit Remaining', 100],
      ['Claude and GPT models', 'Five Hour Limit Remaining', 100],
    ])
  })

  it('★「说明」里说清走的是**原生**那条', async () => {
    const { r } = world({ native: at => nativeOk(at) })
    await r.refreshOpen([ANTIGRAVITY], { full: true })
    const view = quotaFor(ANTIGRAVITY.id, ctx({ open: r.openReadings([ANTIGRAVITY]) }))
    expect(view.source).toContain('直接问 Antigravity 在本机的语言服务读到的')
    expect(view.source).not.toContain('窗口上读到的')
  })

  it('名字用这一刻登记表里的(他刚改过名那一格就该跟着改)', async () => {
    const { r } = world({ native: at => nativeOk(at) })
    await r.refreshOpen([ANTIGRAVITY], { full: true })
    const renamed = [{ ...ANTIGRAVITY, title: '反重力' }]
    expect(quotaFor(ANTIGRAVITY.id, ctx({ open: r.openReadings(renamed) })).title).toBe('反重力')
  })
})

describe('原生那条路哑了 —— 退回窗口读法', () => {
  it('★它没开着:窗口读法接上,「说明」里说的是窗口那条', async () => {
    const { r, fake } = world({ native: () => { throw new Error('Antigravity 没在跑(找不到它自己的语言服务)') } })
    await r.refreshOpen([ANTIGRAVITY], { full: true })
    expect(fake.shellReads).toBe(1)
    const view = quotaFor(ANTIGRAVITY.id, ctx({ open: r.openReadings([ANTIGRAVITY]) }))
    expect(view.left_pct).toBe(55)
    expect(view.source).toContain('在 Antigravity 的窗口上读到的')
  })

  it('★两条都没数:原生卡在哪一步也要说出来,不许一句笼统的「读不到」', async () => {
    const fake = { n: 0 }
    const r = createWindowQuotaReader({
      request: async () => ({ ok: true, result: { windows: [{ index: 0, w: 900, h: 600 }], matches: [], text_nodes: 261, window_count: 1 } }),
      helper: () => ({ connected: true, authorized: true, readTexts: true }),
      now: () => NOW,
      readNative: async () => { fake.n += 1; throw new Error('Antigravity 的语言服务不认这个令牌(它多半刚重启过、换了一个)') },
    })
    await r.refreshOpen([ANTIGRAVITY], { full: true })
    const view = quotaFor(ANTIGRAVITY.id, ctx({ open: r.openReadings([ANTIGRAVITY]) }))
    expect(view.state).toBe('unconnected')
    expect(view.line).toContain('不认这个令牌')
    // 窗口读法那条「卡在哪一步」也还在(卡 AG 立的那套话)。
    expect(view.line).toContain('段字')
  })

  it('抛出来那一句里绝不许出现令牌(取数那一层已经抹过,这里再钉一道)', async () => {
    const { r } = world({ native: () => { throw new Error('Antigravity 的语言服务回了 500:oops *** oops') } })
    await r.refreshOpen([ANTIGRAVITY], { full: true })
    const all = JSON.stringify(r.openReadings([ANTIGRAVITY]))
    expect(all).toContain('***')
    expect(all).not.toMatch(/csrf_token=[^*]/)
  })
})

describe('谁新摆谁', () => {
  it('★原生哑掉之后,窗口读法刚读到的新数不该被一个更旧的原生数压住', async () => {
    let t = new Date('2026-09-27T02:00:00.000Z')
    let alive = true
    const { r } = world({
      clock: () => t,
      native: at => (alive ? nativeOk(at) : (() => { throw new Error('Antigravity 没在跑') })()),
    })
    await r.refreshOpen([ANTIGRAVITY], { full: true })
    expect(quotaFor(ANTIGRAVITY.id, ctx({ open: r.openReadings([ANTIGRAVITY]) })).left_pct).toBe(98)

    // 他把 Antigravity 关了 App、又开了窗口那一页(半小时后)。
    alive = false
    t = new Date('2026-09-27T02:30:00.000Z')
    await r.refreshOpen([ANTIGRAVITY], { full: true })
    const view = quotaFor(ANTIGRAVITY.id, ctx({ open: r.openReadings([ANTIGRAVITY]) }))
    expect(view.left_pct).toBe(55)
    expect(view.source).toContain('窗口上读到的')
  })

  it('原生这一次读到的更新 —— 摆原生那一份', async () => {
    let t = new Date('2026-09-27T02:00:00.000Z')
    const { r } = world({ clock: () => t, native: at => nativeOk(at, 0.41) })
    await r.refreshOpen([ANTIGRAVITY], { full: true })
    t = new Date('2026-09-27T02:30:00.000Z')
    await r.refreshOpen([ANTIGRAVITY], { full: true })
    expect(quotaFor(ANTIGRAVITY.id, ctx({ open: r.openReadings([ANTIGRAVITY]) })).left_pct).toBe(41)
  })
})

describe('事件触发那一路(卡 AG 那套)也要带上原生这一家', () => {
  it('★他从 Antigravity 切走 → 原生这一家立刻重读(它连模型都不叫,没道理被 onlyKnown 挡住)', async () => {
    let fiveHour = 0.98
    const { r, fake, fire } = world({ native: at => nativeOk(at, fiveHour) })
    r.bindOpenFamilies(() => [ANTIGRAVITY])
    await r.refreshOpen([ANTIGRAVITY], { full: true })
    expect(quotaFor(ANTIGRAVITY.id, ctx({ open: r.openReadings([ANTIGRAVITY]) })).left_pct).toBe(98)

    fiveHour = 0.41
    r.nudge(['com.google.antigravity'])
    fire()
    await r.refreshOpen([ANTIGRAVITY], { onlyKnown: true })
    expect(quotaFor(ANTIGRAVITY.id, ctx({ open: r.openReadings([ANTIGRAVITY]) })).left_pct).toBe(41)
    expect(fake.prompts).toBe(0)
    expect(fake.shellReads).toBe(0)
  })

  it('★切回工作台 → 放了一会儿的原生那一家按**它自己**上次读到的时刻算岁数,补读一遍', async () => {
    let t = new Date('2026-09-27T02:00:00.000Z')
    const { r, fake } = world({ clock: () => t, native: at => nativeOk(at) })
    r.bindOpenFamilies(() => [ANTIGRAVITY])
    await r.refreshOpen([ANTIGRAVITY], { full: true })
    t = new Date('2026-09-27T02:10:00.000Z')
    r.catchUp()
    expect(fake.scheduled.some(one => one.ms > 0)).toBe(true)
  })
})
