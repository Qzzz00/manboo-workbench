// @vitest-environment node
/**
 * 「注册那一刻自动接模型服务」的那一层壳(2026-09-18,决策记录同日「新用户零凭据」)。
 *
 * 这里**不起中转、不碰文件**:领令牌那一段是 modelService 的事(tests/model-service.test.ts 里
 * 对着临时 HOME 真跑)。这一份钉的是壳本身的三件事:
 *   ① 失败不许冒泡(不然会把登录带下去);
 *   ② 「没试过」不是「没缺」—— 横幅那一格的缺席与真假;
 *   ③ 那一下 `launchctl kickstart` 只在 DSH 没有会话在跑的时候发。
 */
import { describe, expect, it, vi } from 'vitest'
import { createModelAutoSetup } from '../src/server/modelAutoSetup.ts'
import type { ModelAutoSetupResult, ModelService } from '../src/server/modelService.ts'

const READY: ModelAutoSetupResult = {
  ok: true,
  attempted: true,
  status: {
    mode: 'relay', relay_url: 'https://x.test', relay_configured: true,
    relay_token_configured: true, own_key_configured: false,
    own_base_url: 'https://api.deepseek.com/v1', own_model: 'deepseek-v4-flash', ready: true,
  },
  hints: ['已经接上工作台提供的模型服务,不用填任何东西。'],
  dsh_restart_required: true,
}

const FAILED: ModelAutoSetupResult = {
  ok: true,
  attempted: true,
  status: {
    mode: 'relay', relay_url: 'https://x.test', relay_configured: true,
    relay_token_configured: false, own_key_configured: false,
    own_base_url: 'https://api.deepseek.com/v1', own_model: 'deepseek-v4-flash', ready: false,
  },
  hints: ['还没能领到模型服务的凭证:连不上工作台的模型服务(网络不通,或者服务还没部署好)。'],
}

const SKIPPED: ModelAutoSetupResult = {
  ok: true,
  attempted: false,
  skipped: 'own_key',
  status: {
    mode: 'relay', relay_url: 'https://x.test', relay_configured: true,
    relay_token_configured: false, own_key_configured: true,
    own_base_url: 'https://api.deepseek.com/v1', own_model: 'deepseek-v4-flash', ready: false,
  },
  hints: [],
}

/** 只实现 autoSetup;别的方法这一层用不到,谁真去调了就当场炸,免得悄悄多打一条网络。 */
function fakeModel(results: ModelAutoSetupResult[] | (() => Promise<ModelAutoSetupResult>)): {
  model: ModelService
  calls: () => number
} {
  let calls = 0
  const autoSetup = async (): Promise<ModelAutoSetupResult> => {
    calls += 1
    if (typeof results === 'function') return results()
    return results[Math.min(calls - 1, results.length - 1)] as ModelAutoSetupResult
  }
  const boom = (): never => { throw new Error('这一层不该碰它') }
  return {
    model: { autoSetup, status: boom, update: boom, reissue: boom, endpoint: boom } as unknown as ModelService,
    calls: () => calls,
  }
}

describe('上一次接的结论', () => {
  it('还没跑过:那一格缺席(「没试过」不是「没缺」)', () => {
    const auto = createModelAutoSetup({ model: fakeModel([READY]).model })
    expect(auto.last()).toBeUndefined()
    expect(auto.alert()).toBeUndefined()
  })

  it('接上了:横幅那一格是假(不出横幅)', async () => {
    const auto = createModelAutoSetup({ model: fakeModel([READY]).model })
    await auto.run()
    expect(auto.alert()).toBe(false)
    expect(auto.last()).toMatchObject({ attempted: true, ready: true })
  })

  it('没接上:那一格是真,并且记着一句人话', async () => {
    const auto = createModelAutoSetup({ model: fakeModel([FAILED]).model })
    await auto.run()
    expect(auto.alert()).toBe(true)
    expect(auto.last()?.error).toContain('连不上')
  })

  it('记下来的是**原因**,不是后果(hints 的第一句,不是最后一句)', async () => {
    const auto = createModelAutoSetup({
      model: fakeModel([{
        ...FAILED,
        hints: [
          '还没能领到模型服务的凭证:领取太频繁了,过一会儿再试。',
          '还没领到模型服务的凭证,事务官(DSH)那一侧要等领到之后才真的能用。',
        ],
      }]).model,
    })
    await auto.run()
    // 最后一句说的是后果,照着它谁也做不了什么。
    expect(auto.last()?.error).toContain('领取太频繁')
    expect(auto.last()?.error).not.toContain('要等领到之后')
  })

  it('压根没去领(他用自己的 Key):那一格**缺席**,不是假 —— 这件事不归自动化管', async () => {
    const auto = createModelAutoSetup({ model: fakeModel([SKIPPED]).model })
    await auto.run()
    expect(auto.alert()).toBeUndefined()
  })

  it('autoSetup 自己抛了:兜住,记一条「没接上」,绝不往上冒(登录不能被它带下去)', async () => {
    const auto = createModelAutoSetup({
      model: fakeModel(async () => { throw new TypeError('fetch failed') }).model,
    })
    const result = await auto.run()
    expect(result.ok).toBe(false)
    expect(auto.alert()).toBe(true)
    expect(auto.last()?.error).toContain('TypeError')
  })

  it('kick() 不等结果,也不抛', async () => {
    const auto = createModelAutoSetup({
      model: fakeModel(async () => { throw new Error('boom') }).model,
    })
    expect(() => auto.kick()).not.toThrow()
    await new Promise(resolve => setImmediate(resolve))
    expect(auto.alert()).toBe(true)
  })

  it('同一时刻只跑一遍(注册之后紧跟着的那次轮询不该变成第二次领令牌)', async () => {
    let release: (() => void) | undefined
    const gate = new Promise<void>((resolve) => { release = resolve })
    const fake = fakeModel(async () => { await gate; return READY })
    const auto = createModelAutoSetup({ model: fake.model })
    const first = auto.run()
    const second = auto.run()
    release?.()
    await Promise.all([first, second])
    expect(fake.calls()).toBe(1)
  })
})

describe('那一下 launchctl kickstart', () => {
  function withSessions(sessions: number | undefined, results = [READY]) {
    const calls: string[][] = []
    const auto = createModelAutoSetup({
      model: fakeModel(results).model,
      exec: async (cmd) => { calls.push([...cmd]); return { ok: true } },
      uid: () => 501,
      dshSessionCount: () => sessions,
      restartDelayMs: 0,
    })
    return { auto, calls }
  }

  it('没写过 DSH 配置就不重启', async () => {
    const { auto, calls } = withSessions(0, [FAILED])
    await auto.run()
    expect(auto.restartPending()).toBe(false)
    expect(await auto.restartIfPending()).toEqual({ restarted: false, reason: 'not_pending' })
    expect(calls.length).toBe(0)
  })

  it('刚写过、而且 DSH 没有会话在跑 → 真发 kickstart', async () => {
    const { auto, calls } = withSessions(0)
    await auto.run()
    expect(auto.restartPending()).toBe(true)
    const outcome = await auto.restartIfPending()
    expect(outcome.restarted).toBe(true)
    expect(calls).toEqual([['launchctl', 'kickstart', '-k', 'gui/501/ai.deepseek.dsh']])
    // 发过一次就不再挂着,免得下一条路由又发一次。
    expect(auto.restartPending()).toBe(false)
  })

  it('有会话在跑 → 不重启,交回一句人话(那是用户的活儿,不能替他决定丢掉)', async () => {
    const { auto, calls } = withSessions(2)
    await auto.run()
    const outcome = await auto.restartIfPending()
    expect(outcome).toMatchObject({ restarted: false, reason: 'busy' })
    expect(outcome.restarted === false && outcome.reason === 'busy' && outcome.note).toContain('还有活儿在跑')
    expect(calls.length).toBe(0)
    // 还挂着:等它空下来再说。
    expect(auto.restartPending()).toBe(true)
  })

  it('数不出有几条会话(没接那根线)→ 按「有」处理,不重启', async () => {
    const { auto, calls } = withSessions(undefined)
    await auto.run()
    expect((await auto.restartIfPending()).restarted).toBe(false)
    expect(calls.length).toBe(0)
  })

  it('没有可以跑命令的办法 → 如实说,不假装重启过了', async () => {
    const auto = createModelAutoSetup({
      model: fakeModel([READY]).model,
      dshSessionCount: () => 0,
      restartDelayMs: 0,
    })
    await auto.run()
    expect(await auto.restartIfPending()).toMatchObject({ restarted: false, reason: 'no_exec' })
  })

  it('延迟发出去:当前这个响应要先出得去(kickstart 会把这个进程一起换掉)', async () => {
    vi.useFakeTimers()
    try {
      const calls: string[][] = []
      const auto = createModelAutoSetup({
        model: fakeModel([READY]).model,
        exec: async (cmd) => { calls.push([...cmd]); return { ok: true } },
        uid: () => 501,
        dshSessionCount: () => 0,
        restartDelayMs: 800,
      })
      await auto.run()
      await auto.restartIfPending()
      expect(calls.length).toBe(0)
      vi.advanceTimersByTime(800)
      expect(calls.length).toBe(1)
    }
    finally {
      vi.useRealTimers()
    }
  })
})
