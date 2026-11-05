/**
 * **额度重读改成事件触发为主、定时为辅**(2026-09-27,卡 AG 追加;统筹转维护者 10:45 原话:
 * 「10 分钟一轮这个解法会不会太不优雅了,我听着延迟大,用户还是可感知的」)。
 *
 * 道理很简单:**额度只会在他用那家的时候变**。所以不必每 10 分钟去翻一遍他的窗口 ——
 *
 * | 什么时候读 | 读谁 | 花什么 |
 * |---|---|---|
 * | 他从那家 App **切走**(另一家被激活,上一家失活) | 就那一家 | 只重读上次命中的那几条正则,**不叫模型** |
 * | 他**切回工作台** | 超过一两分钟没读到新数的那几家 | 同上 |
 * | 10 分钟那一轮 | 全部 | 兜底,照旧 |
 *
 * 两条硬规矩:
 * 1. **防抖**:他连着切好几下(Cmd-Tab 连按)只读一次;
 * 2. **不认得的那一家一次模型钱都不花**:事件触发这一路**只读认出来过的**(有方子的)那几家 ——
 *    没方子的要走全套、要叫模型,那是他点「读一下」时才该花的钱。
 *
 * 外加卡 QG 留的那条待拍板(维护者已答要):**开集那两家(Grok Bot / Antigravity)的读数也落盘**,
 * 工作台重启不丢。
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { OpenQuotaFamily, QuotaAdapterContext } from '../src/server/agentQuota.ts'
import {
  QUOTA_CATCHUP_AGE_MS, QUOTA_NUDGE_DEBOUNCE_MS,
  createWindowQuotaReader, forgetQuotaMemory, quotaFor, windowQuotaFileStore,
} from '../src/server/agentQuota.ts'

const dirs: string[] = []
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }) })
beforeEach(() => { forgetQuotaMemory() })

const NOW = new Date('2026-09-27T02:30:00.000Z')
const ANTIGRAVITY: OpenQuotaFamily = { id: 'antigravity', title: 'Antigravity', bundleId: 'com.google.antigravity' }

/** 维护者截图上那一页(四行两组)。 */
const PAGE = [
  { id: 'page', text: 'Models & Usage', x: 560, y: 96, window: 0 },
  { id: 'group', text: 'Gemini Models', x: 560, y: 200, window: 0 },
  { id: 'limit', text: 'Weekly Limit Remaining', x: 600, y: 248, window: 0 },
  { id: 'pct', text: '100%', x: 1200, y: 248, window: 0 },
  { id: 'limit', text: 'Five Hour Limit Remaining', x: 600, y: 312, window: 0 },
  { id: 'pct', text: '98%', x: 1200, y: 312, window: 0 },
  { id: 'group', text: 'Claude and GPT models', x: 560, y: 420, window: 0 },
  { id: 'limit', text: 'Weekly Limit Remaining', x: 600, y: 468, window: 0 },
  { id: 'pct', text: '100%', x: 1200, y: 468, window: 0 },
  { id: 'limit', text: 'Five Hour Limit Remaining', x: 600, y: 532, window: 0 },
  { id: 'pct', text: '100%', x: 1200, y: 532, window: 0 },
]

const VERDICT = '{"kind":"numbers","quote":"100%","evidence":"Weekly Limit Remaining","measure":"left_pct","value":100,"items":["100%","98%","100%","100%"],"reason":"限额剩余"}'

function ctx(patch: Partial<QuotaAdapterContext> = {}): QuotaAdapterContext {
  return { quota: {}, now: NOW, ...patch }
}

/** 一份读取器:`later` 是第二次以后读回来的那一页(模拟他用了一会儿之后数字掉了)。 */
function world(input: {
  later?: typeof PAGE
  store?: ReturnType<typeof windowQuotaFileStore>
  clock?: () => Date
} = {}) {
  // `reads` 只数 **Antigravity 那一家**被读了几次(补读那一路会顺手也读 Muse / Manus / 豆包办公,
  // 那几家不是这几例要看的东西)。
  const fake = { reads: 0, prompts: 0, scheduled: [] as { fn: () => void, ms: number }[] }
  const r = createWindowQuotaReader({
    request: async (req) => {
      const one = req as { bundle_id?: string }
      if (one.bundle_id !== ANTIGRAVITY.bundleId) return { ok: true, result: { matches: [] } }
      fake.reads += 1
      const page = fake.reads === 1 ? PAGE : input.later ?? PAGE
      return { ok: true, result: { windows: [{ index: 0, w: 1640, h: 945 }], matches: page, text_nodes: 300, window_count: 1 } }
    },
    helper: () => ({ connected: true, authorized: true, readTexts: true }),
    judgeQuota: async () => { fake.prompts += 1; return VERDICT },
    now: input.clock ?? (() => NOW),
    schedule: (fn, ms) => { fake.scheduled.push({ fn, ms }) },
    ...(input.store === undefined ? {} : { store: input.store }),
  })
  return { r, fake, fire: () => { for (const one of fake.scheduled.splice(0)) one.fn() } }
}

describe('卡 AG 追加一、事件触发重读(切走那一下就读,不等 10 分钟)', () => {
  it('★他从 Antigravity 切走 → 那一家立刻重读,而且**一次模型都不叫**(只照上次的方子再算一遍)', async () => {
    const later = PAGE.map(one => (one.id === 'pct' && one.y === 312 ? { ...one, text: '41%' } : one))
    const { r, fake, fire } = world({ later })
    r.bindOpenFamilies(() => [ANTIGRAVITY])
    // 先认出来一次(他点过「读一下」)。
    await r.refreshOpen([ANTIGRAVITY], { full: true })
    expect(fake.prompts).toBe(1)
    expect(quotaFor(ANTIGRAVITY.id, ctx({ open: r.openReadings([ANTIGRAVITY]) })).left_pct).toBe(98)

    // 他切走了 —— 不等那 10 分钟。
    r.nudge(['com.google.antigravity'])
    expect(fake.scheduled[0]?.ms).toBe(QUOTA_NUDGE_DEBOUNCE_MS)
    fire()
    await r.refreshOpen([ANTIGRAVITY])
    expect(fake.prompts).toBe(1) // ★ 还是 1:重读不叫模型
    expect(quotaFor(ANTIGRAVITY.id, ctx({ open: r.openReadings([ANTIGRAVITY]) })).left_pct).toBe(41)
  })

  it('★防抖:连着切好几下(Cmd-Tab 连按)只排一次,读一次', async () => {
    const { r, fake } = world()
    r.bindOpenFamilies(() => [ANTIGRAVITY])
    await r.refreshOpen([ANTIGRAVITY], { full: true })
    const before = fake.reads
    r.nudge(['com.google.antigravity'])
    r.nudge(['com.google.antigravity'])
    r.nudge(['com.anysphere.sand'])
    expect(fake.scheduled).toHaveLength(1)
    expect(fake.reads).toBe(before)
  })

  /**
   * 2026-09-27 改:「读一下」撤了(维护者:「读一下这个东西就不要了吧,不止交互,包括功能」)。
   * 还没认出过用量页的那一家,只剩「他从那家切走」这一次机会第一次认:认一次要叫模型,
   * 所以**同一家 30 分钟内最多试一次全套**,再切走也不再花钱。
   */
  it('★还没认出来过的那一家:切走时试一次全套认,30 分钟内再切走不再试', async () => {
    let at = NOW.getTime()
    const { r, fake, fire } = world({ clock: () => new Date(at) })
    r.bindOpenFamilies(() => [ANTIGRAVITY])
    r.nudge(['com.google.antigravity'])
    fire()
    await vi.waitFor(() => expect(fake.prompts).toBe(1))
    const reads = fake.reads
    // 认出来了之后再切走:按方子重读,不叫模型。
    at += 60_000
    r.nudge(['com.google.antigravity'])
    fire()
    await vi.waitFor(() => expect(fake.reads).toBeGreaterThan(reads))
    expect(fake.prompts).toBe(1)
  })

  it('★切回工作台:超过一两分钟没读到新数的那几家顺手补读一遍(读过没多久的不动)', async () => {
    let at = NOW.getTime()
    const later = PAGE.map(one => (one.id === 'pct' && one.y === 312 ? { ...one, text: '41%' } : one))
    const { r, fake, fire } = world({ later, clock: () => new Date(at) })
    r.bindOpenFamilies(() => [ANTIGRAVITY])
    await r.refreshOpen([ANTIGRAVITY], { full: true })
    const after = fake.reads

    // 刚读过:补读那一下什么都不做。
    r.catchUp()
    fire()
    expect(fake.reads).toBe(after)

    // 过了两分钟再切回来:补读。
    at += QUOTA_CATCHUP_AGE_MS + 1_000
    r.catchUp()
    fire()
    await r.refreshOpen([ANTIGRAVITY], { onlyKnown: true })
    expect(fake.reads).toBeGreaterThan(after)
    expect(fake.prompts).toBe(1)
  })

  it('★10 分钟那一轮还在(兜底),只是不再是唯一那一路', () => {
    const { r } = world()
    expect(typeof r.pumpOpen).toBe('function')
    expect(QUOTA_CATCHUP_AGE_MS).toBeLessThan(10 * 60_000)
  })
})

describe('卡 AG 追加二、开集那两家的读数也落盘(重启不丢)', () => {
  it('★读到过 → 重启(新建一份读取器)后那一格仍是四行两组,不再回到「还没读过它窗口上的用量」', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'oq-')); dirs.push(dir)
    const file = join(dir, 'window-quota.json')
    const first = world({ store: windowQuotaFileStore(file) })
    await first.r.refreshOpen([ANTIGRAVITY], { full: true })
    expect(quotaFor(ANTIGRAVITY.id, ctx({ open: first.r.openReadings([ANTIGRAVITY]) })).windows).toHaveLength(4)

    forgetQuotaMemory()
    const second = world({ store: windowQuotaFileStore(file) })
    const view = quotaFor(ANTIGRAVITY.id, ctx({ open: second.r.openReadings([ANTIGRAVITY]) }))
    expect(view.state).toBe('numbers')
    expect(view.windows).toHaveLength(4)
    expect(view.line).not.toContain('还没读过')
  })

  it('★落盘的是认出来的那一份(数 + 方子),老那一格 `lasts` 一个字没动', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'oq-')); dirs.push(dir)
    const file = join(dir, 'window-quota.json')
    await world({ store: windowQuotaFileStore(file) }).r.refreshOpen([ANTIGRAVITY], { full: true })
    const saved = JSON.parse(readFileSync(file, 'utf8')) as { version: number, lasts: unknown, opens: Record<string, { recipe: unknown, view: { windows: unknown[] } }> }
    expect(saved.version).toBe(1)
    expect(saved.lasts).toEqual({})
    expect(saved.opens.antigravity?.recipe).toBeDefined()
    expect(saved.opens.antigravity?.view.windows).toHaveLength(4)
  })
})
