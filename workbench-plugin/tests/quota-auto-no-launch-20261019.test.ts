// @vitest-environment node
/**
 * ★ **她关掉的 App 不再被额度那一轮自己拉起来**(2026-10-19)。
 *
 * ## 现场
 *
 * 维护者 10-19 关掉了一大批 App,一会儿千问办公、Muse、Grok Bot、Manus 又自己起来了。
 * 当天日志对得上:`[开App] cn.qwenwork.desktop.mac ← open -b`(10:35、10:54)、`im.manus.desktop`(10:35)、
 * `com.meta.endo`(10:55)、`com.bot.pc.doubao`(10:45)—— 全是额度自动轮(10 分钟一轮)对「没在跑、
 * 而且这一格的数已经过线」的家 `open -g -b` 后台拉起、读额度页、再藏回去(卡 QZ 的 `worthLaunching` / `launchHidden`)。
 * 同一家 90 分钟最多一次,可那张表只在内存里,插件一重启就清零再来一轮。
 * 10-02 Air 上网易云每 10 秒被拉起、10-08 Muse 每 10 分钟闪一下,都是同一个根。
 *
 * ## 这张卡钉的口径
 *
 * - **自动那一轮(10 分钟 `pump` / `pumpOpen`、她切走 `nudge`、切回来 `catchUp`、体检顺手读)对没在跑的家一律不拉起**,
 *   只读已经在跑的;没在跑的那一格如实记 `not_running`(界面上是「X 没开着」,上一次的数照摆、带时刻),不编一个数。
 * - **她亲手点「读一下」照旧可以拉起**(那是她的指令);`launchedAt` 那张 90 分钟的表只给这一下用。
 * - 重启之后也一样:那张表清零与否都不该让自动那一轮拉起任何一家。
 * - 开集那几家的 `full`(她刚从一家没认出过用量页的家切走 → 全套认一遍)**不等于「她亲手点的」**:
 *   她刚 ⌘Q 退掉那家、焦点换到别家,`nudge` 跟着来一轮,那一刻它已经没在跑 —— 这一轮拉起它就是把她刚关的 App 开回来。
 */
import { beforeEach, describe, expect, it } from 'vitest'
import type { WindowQuotaSpec } from '../src/server/agentQuota.ts'
import { QUOTA_AS_OF_STALE_AFTER_MS } from '../src/protocol.ts'
import {
  backgroundOpenCommand,
  createWindowQuotaReader,
  forgetQuotaMemory,
} from '../src/server/agentQuota.ts'

const T0 = new Date('2026-10-19T02:35:00Z')
const FAKE_BUNDLE = 'com.example.fake'
const GROK = { id: 'grok', title: 'Grok Bot', bundleId: 'com.anysphere.sand' }

function fakeSpec(): WindowQuotaSpec {
  return {
    bundleId: FAKE_BUNDLE,
    patterns: [{ id: 'used', regex: '^剩 [0-9]+%$' }],
    parse: last => (last.matches.some(one => one.id === 'used')
      ? { id: 'fake', title: '假的那家', state: 'numbers', line: '还剩约 62%', left_pct: 62, read_at: last.at }
      : undefined),
  }
}

/**
 * 一台假机器,时钟可拨(`tick`)。`apps` = 壳 `running_apps` 回的那几家(空数组 = 一家都没在跑)。
 * `lasts` = 重启前落盘的那几格(模拟「插件重启、`launchedAt` 清零、格子里是旧数」)。
 */
function world(input: {
  apps: readonly { bundle_id: string, active?: boolean, hidden?: boolean }[]
  hit?: boolean
  launchOk?: boolean
  lasts?: Record<string, { at: string, matches: { id: string, text: string, x: number, y: number }[] }>
}) {
  const sent: { op: string, bundle_id?: string, unhide?: unknown }[] = []
  const ran: (readonly string[])[] = []
  const logs: string[] = []
  let apps = input.apps
  let clock = T0.getTime()
  const specs = new Map([['fake', fakeSpec()]])
  const lasts = input.lasts
  const reader = createWindowQuotaReader({
    request: async (req) => {
      sent.push(req as never)
      const op = (req as { op: string }).op
      if (op === 'running_apps') return { ok: true, result: { apps } }
      if (op === 'read_texts') {
        return {
          ok: true,
          result: {
            matches: (input.hit ?? true) ? [{ id: 'used', text: '剩 62%', x: 10, y: 10, window: 0 }] : [],
            windows: [{ index: 0, w: 1200 }],
            window_count: 1,
            text_nodes: (input.hit ?? true) ? 1 : 0,
          },
        }
      }
      if (op === 'agent_press') return { ok: true, result: { found: true, pressed: true } }
      return { ok: true, result: {} }
    },
    helper: () => ({ connected: true, authorized: true, readTexts: true }),
    now: () => new Date(clock),
    wait: async () => {},
    runCommand: async (cmd) => { ran.push(cmd); return { ok: input.launchOk ?? true } },
    log: line => { logs.push(line) },
    specs,
    ...(lasts === undefined ? {} : { store: { load: () => ({ lasts }), save: () => {} } }),
  })
  const launches = (): (readonly string[])[] => ran.filter(cmd => cmd[0] === 'open' && cmd.includes('-b'))
  const reads = (bundleId = FAKE_BUNDLE): typeof sent => sent.filter(one => one.op === 'read_texts' && one.bundle_id === bundleId)
  return {
    reader, sent, ran, logs, launches, reads,
    setApps: (next: typeof input.apps): void => { apps = next },
    tick: (ms: number): void => { clock += ms },
  }
}

beforeEach(() => { forgetQuotaMemory() })

describe('额度自动轮不拉起 App · 窗口型那几家', () => {
  it('★没在跑、从没读到过数(原来最该拉的时候)→ 自动那一轮零次 open、不读、如实记 not_running', async () => {
    const w = world({ apps: [] })
    await w.reader.refresh()
    expect(w.ran).toEqual([])
    expect(w.reads()).toHaveLength(0)
    expect(w.reader.readings().fake?.attempt?.error).toBe('not_running')
    expect(w.logs.join('\n')).toContain('不起它')
  })

  it('★没在跑、上一次的数早过了线 → 自动那一轮照样不拉;上一次的数与时刻原样留着(不编一个数)', async () => {
    const old = new Date(T0.getTime() - QUOTA_AS_OF_STALE_AFTER_MS - 60 * 60_000).toISOString()
    const w = world({ apps: [], lasts: { fake: { at: old, matches: [{ id: 'used', text: '剩 62%', x: 10, y: 10 }] } } })
    await w.reader.refresh()
    expect(w.ran).toEqual([])
    expect(w.reader.readings().fake?.last?.at).toBe(old)
    expect(w.reader.readings().fake?.attempt?.error).toBe('not_running')
  })

  it('★重启之后(launchedAt 清零)自动那一轮也不拉;连着几轮、时钟走过 90 分钟都不拉', async () => {
    const old = new Date(T0.getTime() - 5 * 60 * 60_000).toISOString()
    const first = world({ apps: [], lasts: { fake: { at: old, matches: [{ id: 'used', text: '剩 62%', x: 10, y: 10 }] } } })
    await first.reader.refresh()
    expect(first.launches()).toHaveLength(0)
    // 「重启」= 换一个读数器,内存里那张 launchedAt 表是空的。
    forgetQuotaMemory()
    const second = world({ apps: [], lasts: { fake: { at: old, matches: [{ id: 'used', text: '剩 62%', x: 10, y: 10 }] } } })
    for (let round = 0; round < 12; round++) {
      await second.reader.refresh()
      second.tick(10 * 60_000)
    }
    expect(second.launches()).toHaveLength(0)
  })

  it('★在跑(藏着也算)→ 行为不变:照读、读到数、零次 open', async () => {
    const w = world({ apps: [{ bundle_id: FAKE_BUNDLE, hidden: true }] })
    await w.reader.refresh()
    expect(w.ran).toEqual([])
    expect(w.reads().length).toBeGreaterThan(0)
    expect(w.reader.readings().fake?.attempt?.found).toBe(true)
  })

  it('★她亲手点「读一下」(press:true)→ 没在跑的照旧 open -g -b 起它、藏回去、再读', async () => {
    const w = world({ apps: [] })
    await w.reader.refresh(['fake'], { press: true })
    expect(w.ran).toContainEqual(backgroundOpenCommand(FAKE_BUNDLE))
    const ops = w.sent.map(one => one.op)
    expect(ops.indexOf('hide_app')).toBeGreaterThan(-1)
    expect(ops.indexOf('hide_app')).toBeLessThan(ops.lastIndexOf('read_texts'))
    expect(w.reader.readings().fake?.attempt?.found).toBe(true)
  })

  it('★她点过「读一下」之后,接下来的自动轮还是不拉(launchedAt 那张表只给「读一下」用)', async () => {
    const w = world({ apps: [], hit: false })
    await w.reader.refresh(['fake'], { press: true })
    expect(w.launches()).toHaveLength(1)
    w.tick(2 * 60 * 60_000)                                  // 过了 90 分钟那条线
    await w.reader.refresh()
    expect(w.launches()).toHaveLength(1)
    // 再点一次「读一下」:90 分钟过了,照旧可以再起一次。
    await w.reader.refresh(['fake'], { press: true })
    expect(w.launches()).toHaveLength(2)
  })

  it('★10 分钟那一轮(pump)走的是同一条:没在跑零次 open', async () => {
    const w = world({ apps: [] })
    w.reader.pump()
    await w.reader.refresh()
    expect(w.ran).toEqual([])
  })

  it('★她切走(nudge)/ 切回来(catchUp)那两路也不拉', async () => {
    const w = world({ apps: [] })
    w.reader.nudge([FAKE_BUNDLE])
    await w.reader.refresh()
    w.reader.catchUp()
    await w.reader.refresh()
    expect(w.ran).toEqual([])
  })
})

describe('额度自动轮不拉起 App · 开集那几家(Grok Bot)', () => {
  it('★没在跑 → 自动 refreshOpen 零次 open、不读、记 not_running', async () => {
    const w = world({ apps: [] })
    await w.reader.refreshOpen([GROK])
    expect(w.ran).toEqual([])
    expect(w.reads(GROK.bundleId)).toHaveLength(0)
    expect(w.reader.openReadings().grok?.attempt?.error).toBe('not_running')
  })

  it('★`full`(她刚切走、全套认一遍)也不拉 —— 她刚 ⌘Q 的那家不许被开回来', async () => {
    const w = world({ apps: [] })
    await w.reader.refreshOpen([GROK], { full: true })
    expect(w.ran).toEqual([])
  })

  it('★在跑(藏着)→ 行为不变:照读', async () => {
    const w = world({ apps: [{ bundle_id: GROK.bundleId, hidden: true }] })
    await w.reader.refreshOpen([GROK])
    expect(w.ran).toEqual([])
    expect(w.reads(GROK.bundleId).length).toBeGreaterThan(0)
  })

  it('★她亲手点「读一下」(byHand:true)→ 没在跑的照旧起它、藏回去、再读', async () => {
    const w = world({ apps: [] })
    await w.reader.refreshOpen([GROK], { full: true, byHand: true })
    expect(w.ran).toContainEqual(backgroundOpenCommand(GROK.bundleId))
    expect(w.sent.some(one => one.op === 'hide_app' && one.bundle_id === GROK.bundleId)).toBe(true)
    expect(w.reads(GROK.bundleId).length).toBeGreaterThan(0)
  })

  it('★10 分钟那一轮(pumpOpen)走的是同一条:零次 open', async () => {
    const w = world({ apps: [] })
    w.reader.pumpOpen([GROK])
    await w.reader.refreshOpen([GROK])
    expect(w.ran).toEqual([])
  })
})
