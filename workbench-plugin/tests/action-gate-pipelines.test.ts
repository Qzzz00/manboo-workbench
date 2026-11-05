/**
 * **接上动作闸的那几条管线:事情收场之后一下都不再动那一家**(2026-10-02,卡 AG)。
 *
 * 复现用例取自 Air 现场那一串(她的原话:「完成后每隔 10s 又自行打开网易云。。不断弹窗」):
 * 派给豆包 → 它交回来、卡收了 → 之后**任何**管线都不再碰豆包(不送话、不开它的窗、不去读它的窗)。
 *
 * 但守的不是「网易云」这一家:下面每一组都另有**两个别的场景**,证明这是机制不是特例 ——
 * 捎话巡检在事情收场后不再读窗、开窗重试到顶之后不再开、换一家换一件事各自从头数。
 *
 * ★ 2026-10-02(卡「引擎接线与删复制品」):**闸只接在引擎一处**了。
 * 两处跟着变,断言照着改(这两条本身就是这张卡要的):
 * ① 「没接闸的老宿主」那两条没有了 —— 引擎的 `gate` **不是可选的**:可选就等于留了一条不过闸的旁路,
 *    而这正是 10-02 那一类的病根。那两条改成「闸说还在办就照旧放行」(同一件事的另一面);
 * ② 「换包那两下闸不拦」变得更硬:换包现在是**一次 `run` 里面**的重试(`RetryableError`),
 *    一次 `run` 只过**一次**闸 —— 不是「两下都过、靠间隔为 0 放过去」。
 */
import { describe, expect, it } from 'vitest'
import type { JobPhase } from '../src/server/actionGate.ts'
import { createClientDispatch } from '../src/server/dispatchSend.ts'
import type { DispatchTarget } from '../src/server/dispatchTargets.ts'
import { NO_WINDOW_WAKE_TRIES } from '../src/server/windowWake.ts'
import { createEngineRelayReader, createRelayWatchService } from '../src/server/relayWatch.ts'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { engineHarness, type EngineHarnessOptions } from './helpers/engineHarness.ts'

const WORK = 'com.work.pc.doubao'
const DOUBAO: DispatchTarget = {
  id: 'doubao', title: '豆包办公', bundle_id: WORK, hands: ['window'], aliases: [], from_registry: true,
} as unknown as DispatchTarget

const NO_WINDOW = (bundleId: string): string =>
  `找不到窗口:${bundleId} 在跑,但一扇标准窗口都没有(可能最小化了或只剩菜单栏图标)`

interface Harness {
  /** 每一件事此刻的状态(看板上查卡那一下的替身)。 */
  phases?: Record<string, JobPhase>
  /** 这个包上壳一律说「一扇标准窗口都没有」。 */
  noWindow?: boolean
  /** 盖掉钟(换包那一组要一台**不走**的钟)。 */
  now?: EngineHarnessOptions['now']
  /** 这一家装着哪几个包(换包那一组要两个)。 */
  installed?: EngineHarnessOptions['installed']
  /** 没接「把窗开出来」那样本事 → 那一圈缺席(送不成就立刻换包)。 */
  noOpenApp?: boolean
  targets?: readonly DispatchTarget[]
}

function harness(options: Harness = {}) {
  const opened: string[] = []
  const h = engineHarness({
    phaseOf: job => options.phases?.[job] ?? 'open',
    nameOf: family => (family === 'doubao' ? '豆包办公' : family),
    ...(options.now === undefined ? {} : { now: options.now }),
    ...(options.installed === undefined ? {} : { installed: options.installed }),
    ...(options.noOpenApp === true ? {} : { openApp: (bundleId: string) => { opened.push(bundleId); return Promise.resolve({ ok: true }) } }),
    reply: (req) => {
      if (req.op !== 'send_text') return {}
      const bundleId = (req as { bundle_id: string }).bundle_id
      if (options.noWindow === true) throw new Error(NO_WINDOW(bundleId))
      return { submitted: true, method: 'ax_value' }
    },
  })
  const dispatch = createClientDispatch({
    engine: h.engine,
    targets: () => options.targets ?? [DOUBAO],
    sessionIdsOf: () => [],
    now: () => new Date('2026-10-02T02:00:00.000Z'),
  })
  return { dispatch, gate: h.gate, log: h.log, sends: () => h.sentTo().length, sentTo: h.sentTo, opened, requests: h.requests }
}

describe('派活送话:过闸', () => {
  it('★这件事已经收场(她点了完成 / 取消)→ 一个字都不送进那一家的窗', async () => {
    const h = harness({ phases: { 't-done': 'settled' } })
    const got = await h.dispatch.send({ family: 'doubao', job: 't-done', text: '打开网易云音乐', submit: true })
    expect(got.ok).toBe(false)
    expect(got.kind).toBe('not_allowed')
    expect(got.reason ?? '').toContain('豆包办公')
    // 壳那边一个 op 都没发出去。
    expect(h.sends()).toBe(0)
    expect(h.requests).toHaveLength(0)
    // 账上有这一行,说得出为什么拦的。
    expect(h.log.events('t-done')[0]?.step).toBe('gate_block')
  })

  it('还在办就照送(没带事项 id 的那一路也照送:键用这一送自己的 id,闸答「查不出」→ 放行)', async () => {
    const h = harness()
    expect((await h.dispatch.send({ family: 'doubao', job: 't-1', text: '打开网易云音乐', submit: true })).ok).toBe(true)
    expect((await h.dispatch.send({ family: 'doubao', text: '打开网易云音乐', submit: true })).ok).toBe(true)
    expect(h.sends()).toBe(2)
  })

  it('★同一件事对同一家送到顶就停,并且如实说到顶了', async () => {
    const h = harness()
    for (let i = 0; i < 3; i += 1) {
      expect((await h.dispatch.send({ family: 'doubao', job: 't-1', text: `第 ${i} 回`, submit: true })).ok, `第 ${i + 1} 回`).toBe(true)
    }
    const over = await h.dispatch.send({ family: 'doubao', job: 't-1', text: '再来一回', submit: true })
    expect(over.ok).toBe(false)
    expect(over.reason ?? '').toContain('到顶了')
    expect(h.sends()).toBe(3)
  })

  it('换一件事、换一家各自从头数(不是一把总闸)', async () => {
    const h = harness()
    for (let i = 0; i < 3; i += 1) await h.dispatch.send({ family: 'doubao', job: 't-1', text: 'x', submit: true })
    expect((await h.dispatch.send({ family: 'doubao', job: 't-2', text: 'x', submit: true })).ok).toBe(true)
  })
})

describe('重派:另一样、另一个上限(2026-10-02,卡 AG2)', () => {
  /**
   * 重派那一样的间隔是**一分钟**(`GATE_LIMITS.dispatch_resend`:机器自己不许连着重派),
   * 所以这一组用一台**一分钟一跳**的钟 —— 「太密」那一道不该把「到顶」那一道的用例盖住。
   */
  function minutes() {
    let tick = 0
    return (): Date => new Date(Date.UTC(2026, 9, 2, 2, (tick += 1), 0))
  }

  it('★「重派」走的是闸里 `dispatch_resend` 那一样(账上那一行就写着它)', async () => {
    const h = harness({ now: minutes() })
    expect((await h.dispatch.send({ family: 'doubao', job: 't-1', text: '再做一遍', submit: true, resend: true })).ok).toBe(true)
    expect(h.log.events('t-1').map(one => one.action)).toContain('dispatch_resend')
  })

  it('★这件事收场了 → 一回都不重派', async () => {
    const h = harness({ phases: { 't-done': 'settled' } })
    const got = await h.dispatch.send({ family: 'doubao', job: 't-done', text: '再做一遍', submit: true, resend: true })
    expect(got.ok).toBe(false)
    expect(h.sends()).toBe(0)
  })

  it('★重派到顶就停,并且如实说到顶了', async () => {
    const h = harness({ now: minutes() })
    for (let i = 0; i < 2; i += 1) {
      expect((await h.dispatch.send({ family: 'doubao', job: 't-1', text: `第 ${i} 回`, submit: true, resend: true })).ok, `第 ${i + 1} 回`).toBe(true)
    }
    const over = await h.dispatch.send({ family: 'doubao', job: 't-1', text: '再来一回', submit: true, resend: true })
    expect(over.ok).toBe(false)
    expect(over.reason ?? '').toContain('到顶了')
    expect(h.sends()).toBe(2)
  })

  it('第一次送与重派各算各的(第一次送到顶了,她说重派一次照样派得出去)', async () => {
    const h = harness({ now: minutes() })
    for (let i = 0; i < 3; i += 1) await h.dispatch.send({ family: 'doubao', job: 't-1', text: 'x', submit: true })
    expect((await h.dispatch.send({ family: 'doubao', job: 't-1', text: 'x', submit: true })).ok).toBe(false)
    expect((await h.dispatch.send({ family: 'doubao', job: 't-1', text: 'x', submit: true, resend: true })).ok).toBe(true)
  })
})

describe('开窗重试(open -b):过闸', () => {
  it('★开窗也要先问一句「这件还动不动得」—— 收场了一回都不开', async () => {
    const h = harness({ noWindow: true, phases: { 't-done': 'settled' } })
    const got = await h.dispatch.send({ family: 'doubao', job: 't-done', text: '打开网易云音乐', submit: true })
    expect(got.ok).toBe(false)
    expect(h.opened).toHaveLength(0)
  })

  it('★开窗的上限跨调用也只有这几回:第二次派同一件事时不再从头开 3 回', async () => {
    const h = harness({ noWindow: true })
    const first = await h.dispatch.send({ family: 'doubao', job: 't-1', text: '打开网易云音乐', submit: true })
    expect(first.ok).toBe(false)
    expect(h.opened).toHaveLength(NO_WINDOW_WAKE_TRIES)
    // 同一件事、同一家再来一次:送还放行(送的上限是 3),但**窗一回都不再开**。
    const again = await h.dispatch.send({ family: 'doubao', job: 't-1', text: '打开网易云音乐', submit: true })
    expect(again.ok).toBe(false)
    expect(h.opened).toHaveLength(NO_WINDOW_WAKE_TRIES)
  })

  it('★换一件事从头数:另一个事项 id 又有它自己那几回(开窗那一样也是按「事项 · 家」记的)', async () => {
    const h = harness({ noWindow: true })
    await h.dispatch.send({ family: 'doubao', job: 't-1', text: 'x', submit: true })
    expect(h.opened).toHaveLength(NO_WINDOW_WAKE_TRIES)
    await h.dispatch.send({ family: 'doubao', job: 't-2', text: 'x', submit: true })
    expect(h.opened).toHaveLength(NO_WINDOW_WAKE_TRIES * 2)
  })
})

describe('闸不许把 10-01 修好的东西弄坏', () => {
  it('★挑中的包没窗口 → 当场换同一家另一个包再送:闸不拦(一次 `run` 只过一次闸)', async () => {
    const STORE = 'com.bot.neotix.doubao'
    const TWO: DispatchTarget = {
      id: 'doubao',
      title: '豆包办公',
      bundle_id: WORK,
      hands: ['window'],
      aliases: [],
      from_registry: true,
      packages: [
        { bundle_id: WORK, name: '豆包工作', running: true },
        { bundle_id: STORE, name: '豆包', running: true },
      ],
    } as unknown as DispatchTarget
    /*
     * **钟不走**:真机上换包那两下就是同一毫秒里发生的。
     * 从前这一条靠「`dispatch_send` 的间隔是 0」才过得去;现在换包是**一次 `run` 里面**的重试
     * (适配器抛 `RetryableError`、循环在引擎),一次 `run` 只过一次闸 ——
     * 钟走不走都不影响,所以这一条比从前硬。
     */
    const frozen = (): Date => new Date('2026-10-02T02:00:00.000Z')
    const h = engineHarness({
      now: frozen,
      phaseOf: () => 'open',
      installed: () => [
        { bundle_id: WORK, name: '豆包工作', running: true },
        { bundle_id: STORE, name: '豆包', running: true },
      ],
      // 只有办公那个包没窗口(真机那一次就是这样:她开着的是 App Store 版)。
      reply: (req) => {
        if (req.op !== 'send_text') return {}
        const bundleId = (req as { bundle_id: string }).bundle_id
        if (bundleId === WORK) throw new Error(NO_WINDOW(WORK))
        return { submitted: true, method: 'ax_value' }
      },
    })
    const dispatch = createClientDispatch({ engine: h.engine, targets: () => [TWO], sessionIdsOf: () => [], now: frozen })
    const got = await dispatch.send({ family: 'doubao', job: 't-1', text: '打开网易云音乐', submit: true })
    expect(got.ok).toBe(true)
    expect(h.sentTo()).toEqual([WORK, STORE])
    // 账上只有**一回**放行(一次 `run` 一回),不是两回。
    expect(h.log.events('t-1').filter(one => one.step === 'gate_pass')).toHaveLength(1)
  })
})

describe('捎话巡检(relayWatch):过闸', () => {
  /** 一条真巡检:假壳 + 真引擎 + 真闸(`reply_watch` 在 `engine.read` 里面)。 */
  async function watcher(options: { phaseOf: (job: string) => JobPhase, itemOf?: () => string | undefined }) {
    const dir = await mkdtemp(join(tmpdir(), 'wb-gate-'))
    let nowMs = 0
    const h = engineHarness({
      phaseOf: options.phaseOf,
      installed: () => [{ bundle_id: WORK, name: '豆包工作', running: true }],
      reply: () => ({ found: false, busy: false, texts: [] }),
      now: () => new Date(nowMs),
    })
    const service = createRelayWatchService({
      file: join(dir, 'relay.json'),
      reader: createEngineRelayReader({ engine: h.engine }),
      now: () => nowMs,
      newId: () => 'r-1',
      pollMs: 0,
      ...(options.itemOf === undefined ? {} : { itemOf: options.itemOf }),
    })
    await service.load()
    return {
      service,
      dir,
      reads: () => h.requests.filter(one => one.op === 'read_reply').length,
      tick: (ms: number) => { nowMs = ms },
    }
  }

  it('★这一条收场之后,巡检一次都不再去读那一家的窗', async () => {
    let phase: JobPhase = 'open'
    const w = await watcher({ phaseOf: () => phase })
    try {
      await w.service.remember({ agent: 'doubao', session_id: 's-1', title: '刚才那条', mark: '事务官捎话 a1b2c3', from: 'phone' })
      w.tick(1000)
      await w.service.pump()
      expect(w.reads()).toBe(1)
      // 她在别处把这件收了 —— 巡检这就该停手,不是等 20 分钟那个超时。
      phase = 'settled'
      w.tick(5000)
      await w.service.pump()
      w.tick(9000)
      await w.service.pump()
      expect(w.reads()).toBe(1)
    }
    finally { await rm(w.dir, { recursive: true, force: true }) }
  })

  it('★账上带着事项 id:她在看板上把那张卡收了 → 巡检这就停手(2026-10-02,卡 AG2)', async () => {
    const phases: Record<string, JobPhase> = {}
    const w = await watcher({ phaseOf: job => phases[job] ?? 'open', itemOf: () => 't-7' })
    try {
      const wait = await w.service.remember({ agent: 'doubao', session_id: 'window:825f1900', title: '刚才那条', mark: '事务官捎话 a1b2c3', from: 'phone' })
      // 账上真记下了那一件(重启之后也还在:它落盘)。
      expect(wait.item_id).toBe('t-7')
      w.tick(1000)
      await w.service.pump()
      expect(w.reads()).toBe(1)
      // 她把那张卡收了 —— 闸按**卡**的状态算,不再看这本账自己的 state。
      phases['t-7'] = 'settled'
      w.tick(5000)
      await w.service.pump()
      w.tick(9000)
      await w.service.pump()
      expect(w.reads()).toBe(1)
    }
    finally { await rm(w.dir, { recursive: true, force: true }) }
  })

  it('闸说还在办:每一拍照旧读那扇窗(拦的只是收场了的那几条)', async () => {
    const w = await watcher({ phaseOf: () => 'open' })
    try {
      await w.service.remember({ agent: 'doubao', session_id: 's-1', title: '刚才那条', mark: '事务官捎话 a1b2c3', from: 'phone' })
      w.tick(1000)
      await w.service.pump()
      w.tick(5000)
      await w.service.pump()
      expect(w.reads()).toBe(2)
    }
    finally { await rm(w.dir, { recursive: true, force: true }) }
  })
})
