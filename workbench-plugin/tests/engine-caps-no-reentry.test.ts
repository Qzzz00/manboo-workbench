// @vitest-environment node
/**
 * ★ **能力现查不许回头问候选名单**(2026-10-03,卡「0.4.87 启动崩溃」)。
 *
 * 0.4.87 装到维护者那台之后工作台起不来、每 5 分钟崩一次 launchd 重启一次,
 * `~/.dsh/logs/web.stderr.log` 里反复是
 *
 * ```
 * Exception in PromiseRejectCallback: node:internal/process/promises:183
 * RangeError: Maximum call stack size exceeded
 * ```
 *
 * 环在这里(交接 `docs/交接-1003-0.4.87启动崩溃.md` 第二节):
 *
 * ```
 * registry.targetsNow()            ← 过期就踢一次异步现查
 *   → void probe(adapter)
 *     → adapter.capabilities()     ← 窗口适配器这一格整个是同步的(里面一个 await 都没有)
 *       → deps.caps()              ← index.ts: () => agentCaps.view()
 *         → agentCaps.familiesNow()
 *           → capTargetsFor({ engineTargets: registry.targetsNow() })
 *             → registry.targetsNow()   ← 回到第一行,而缓存要等 capabilities() 回来才填
 * ```
 *
 * 每一层都是**同步**的,于是一路递归到爆栈;爆在 `async` 函数体里 → 变成一条拒绝的 Promise →
 * `void probe(…).catch(…)` 那只手在爆栈的深度上被调用,这才是 stderr 里那句
 * 「Exception in PromiseRejectCallback」的来处。
 *
 * 这一份钉两样,**都是登记处自己的事**(不靠调用方守规矩):
 *
 * 1. 一条通道的 `capabilities()` 在求值期间再被问到候选名单,也**不许**递归下去;
 * 2. 同一条通道的现查**同时只跑一次**(在跑的那一次直接复用,不另起一次)。
 */
import { describe, expect, it } from 'vitest'
import type { Adapter, AdapterCapabilities, Job, JobResult } from '../src/server/engine/adapter.ts'
import type { AdapterRegistry } from '../src/server/engine/registry.ts'
import { NO_CAPABILITIES, createRegistry } from '../src/server/engine/registry.ts'

/** 什么都会(现查回这一份;具体哪几格这条用例不关心)。 */
const ALL: AdapterCapabilities = {
  open: true, send: true, read: true, press: true, approve: true, writeAsk: true, stop: true, openSession: true,
}

/**
 * 一条**会回头问候选名单**的通道 —— 真机上就是窗口适配器:
 * `capabilities()` 读体检表(`deps.caps()`),而体检表的「体检哪几家」读 `targetsNow()`。
 * 这里把那一整条链压成一句 `back()`,环的形状一模一样。
 */
function nosyAdapter(family: string, back: () => void, calls: { n: number }): Adapter {
  return {
    family,
    via: 'window',
    // 真机那一格里一个 await 都没有:整段同步跑完才返回 —— 递归因此是同步的。
    capabilities: async () => {
      calls.n += 1
      back()
      return ALL
    },
    run: async (): Promise<JobResult> => ({ delivered: 'not_sent', via: 'window', why: '用例不送' }),
  }
}

const job = (family: string): Job => ({
  id: 'j-1', family, kind: 'answer', target: { kind: 'new' }, text: '嗨', expect: 'ack',
})

/** 让踢出去的那几次现查跑完(登记处是「这一拍答上一次查到的,下一拍跟得上」)。 */
async function settle(): Promise<void> {
  for (let i = 0; i < 20; i += 1) await new Promise<void>((resolve) => { setTimeout(resolve, 0) })
}

describe('能力现查回头问候选名单也不许递归(0.4.87 启动崩溃的那个环)', () => {
  it('★ targetsNow 求值期间被再问一次:不抛、不爆栈', () => {
    const calls = { n: 0 }
    let registry: AdapterRegistry | undefined
    registry = createRegistry({ installed: () => undefined })
    registry.register(nosyAdapter('kimi', () => { registry?.targetsNow() }, calls))

    expect(() => registry?.targetsNow()).not.toThrow()
    // 一次外部调用只许现查有限几回(没有再入保护时这里是爆栈)。
    expect(calls.n).toBeLessThan(5)
  })

  it('★ 缓存过期之后那一拍也不许爆栈(真机上就是这一拍:起服务 5 秒后第一次有人读 /state)', async () => {
    const calls = { n: 0 }
    let nowMs = 1_000_000
    let registry: AdapterRegistry | undefined
    registry = createRegistry({
      installed: () => undefined,
      now: () => new Date(nowMs),
    })
    registry.register(nosyAdapter('kimi', () => { registry?.targetsNow() }, calls))
    registry.register(nosyAdapter('doubao', () => { registry?.targetsNow() }, calls))

    // 第一轮:缓存空着 → 踢一次现查,等它落地(真机上这一轮是起服务时那一遍预热)。
    registry.targetsNow()
    await settle()
    expect(calls.n).toBe(2)
    // 查到的那一份照旧答得出来 —— 再入保护不许把候选名单吃空。
    expect(registry.targetsNow().map(one => one.family)).toContain('kimi')
    expect(registry.targetsNow().find(one => one.family === 'kimi')?.can.send).toBe(true)

    // 过了那 5 秒:登记处会「踢一次异步现查」,正是递归的入口。
    nowMs += 10_000
    expect(() => registry?.targetsNow()).not.toThrow()
    expect(() => registry?.knownCaps('kimi')).not.toThrow()
    await settle()
    // 一轮就是一条通道一次,不是指数级(没有再入保护时这里是爆栈)。
    expect(calls.n).toBe(4)
  })

  it('★ targets() / picksFor() 那两条异步的路同样不许爆栈', async () => {
    const calls = { n: 0 }
    let registry: AdapterRegistry | undefined
    registry = createRegistry({ installed: () => undefined })
    registry.register(nosyAdapter('kimi', () => { registry?.targetsNow() }, calls))

    await expect(registry.targets()).resolves.toBeInstanceOf(Array)
    await expect(registry.picksFor(job('kimi'))).resolves.toBeInstanceOf(Array)
    expect(calls.n).toBeLessThan(20)
  })

  it('★ 现查同时只跑一次:两边同时问,底下那一格只被叫一回', async () => {
    let calls = 0
    let release: (() => void) | undefined
    const slow: Adapter = {
      family: 'kimi',
      via: 'window',
      capabilities: async () => {
        calls += 1
        await new Promise<void>((resolve) => { release = resolve })
        return ALL
      },
      run: async (): Promise<JobResult> => ({ delivered: 'not_sent', via: 'window', why: '用例不送' }),
    }
    const registry = createRegistry({ installed: () => undefined })
    registry.register(slow)

    const both = Promise.all([registry.targets(), registry.targets()])
    await new Promise<void>((resolve) => { setTimeout(resolve, 0) })
    release?.()
    await both

    expect(calls).toBe(1)
  })

  it('★ 现查抛了也只算「这一条什么都不会」,不往外抛、不递归抛', async () => {
    const boom: Adapter = {
      family: 'kimi',
      via: 'window',
      capabilities: async () => { throw new Error('壳炸了') },
      run: async (): Promise<JobResult> => ({ delivered: 'not_sent', via: 'window', why: '用例不送' }),
    }
    const registry = createRegistry({ installed: () => undefined })
    registry.register(boom)

    const out = await registry.targets()
    expect(out.find(one => one.family === 'kimi')?.can).toEqual(NO_CAPABILITIES)
  })
})
