/**
 * 电话那一路关思考(2026-09-28,卡 BS)。真机那一遍(听筒里首句多快回)见交接;
 * 这里只钉住那层 fetch 的行为:该补的补上、不该碰的一个字节不碰。
 *
 * 2026-10-03(卡「首声提速」):维护者问「之前的思考模式分档压根没生效?」——
 * 底下多了一节**对照测试**,钉住「那层 fetch 真的在电话这条路上」:
 * 接话那一路与首句那一路都必须把自建客户端交给上游,否则这层补丁一个字都到不了模型。
 * 结论与没验到的那一条写在 `docs/交接-1003-首声提速.md`。
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { THINKING_DISABLED, bodyWithThinkingDisabled, withThinkingDisabled } from '../src/llmThinking.ts'

function recorder(): { calls: { url: string, body: unknown }[], fetchImpl: (input: string | URL | Request, init?: RequestInit) => Promise<Response> } {
  const calls: { url: string, body: unknown }[] = []
  return {
    calls,
    fetchImpl: async (input, init) => {
      calls.push({ url: String(input), body: init?.body })
      return new Response('{}', { status: 200 })
    },
  }
}

describe('往 body 里补 thinking', () => {
  it('聊天补全:补上 thinking: { type: disabled },别的字段原样', async () => {
    const { calls, fetchImpl } = recorder()
    await withThinkingDisabled(fetchImpl)('https://api.aibooo.cn/v1/chat/completions', {
      method: 'POST',
      body: JSON.stringify({ model: 'deepseek-v4-flash', messages: [{ role: 'user', content: '喂' }] }),
    })
    expect(JSON.parse(calls[0]?.body as string)).toEqual({
      model: 'deepseek-v4-flash',
      messages: [{ role: 'user', content: '喂' }],
      thinking: THINKING_DISABLED,
    })
  })

  it('别的路(连通性探测 models.list)一个字不碰', async () => {
    const { calls, fetchImpl } = recorder()
    await withThinkingDisabled(fetchImpl)('https://api.aibooo.cn/v1/models', { method: 'GET' })
    expect(calls[0]?.body).toBeUndefined()
  })

  it('body 里已经有 thinking → 让位,不覆盖(哪天上游自己支持了这层自动失效)', () => {
    const had = JSON.stringify({ model: 'x', thinking: { type: 'enabled' } })
    expect(bodyWithThinkingDisabled(had)).toBeUndefined()
  })

  it.each([
    ['不是 JSON', 'これはJSONではない'],
    ['是数组', '[1,2]'],
    ['空的', ''],
  ])('body %s → 原样发出去,不因为这层把请求弄坏', (_name, body) => {
    expect(bodyWithThinkingDisabled(body)).toBeUndefined()
  })

  it('首句那一路也走同一个 base / key 的客户端 —— 一句话两套凭据是另一种病', async () => {
    const { calls, fetchImpl } = recorder()
    await withThinkingDisabled(fetchImpl)('https://api.aibooo.cn/v1/chat/completions', {
      method: 'POST',
      body: JSON.stringify({ model: 'deepseek-v4-flash', messages: [], max_tokens: 40 }),
    })
    expect(JSON.parse(calls[0]?.body as string).thinking).toEqual(THINKING_DISABLED)
  })

  it('authorization 头原样透传(这层只认 URL 和 body)', async () => {
    const seen: (RequestInit['headers'] | undefined)[] = []
    const impl = async (_input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      seen.push(init?.headers)
      return new Response('{}')
    }
    await withThinkingDisabled(impl)('https://x/v1/chat/completions', {
      method: 'POST',
      headers: { authorization: 'Bearer 不该被读的' },
      body: JSON.stringify({ model: 'x' }),
    })
    expect(seen[0]).toEqual({ authorization: 'Bearer 不该被读的' })
  })
})

/**
 * ——— **这层补丁真的在电话这条路上吗**(2026-10-03 对照测试)———
 *
 * 维护者问的是「之前的思考模式分档压根没生效?」。生没生效分两层:
 *
 *   ① **我们这一侧有没有把参数发出去** —— 这一节钉的就是它(读 `src/agent.ts` 的源码比对:
 *      上游的 `withDeepSeek` 只在 `opts.client` 缺席时才自己造一个客户端,
 *      所以一旦哪天这行接线掉了,`llmThinking.ts` 整层补丁就一个字都到不了模型,
 *      而**现象是「电话变慢了」,不会有任何报错**);
 *   ② 上游收到之后照不照办 —— 那在模型那一侧,只能真机量(见交接「思考模式」一节)。
 *
 * 为什么是读源码而不是起一个会话:起会话要 LiveKit 房间、ASR、TTS 三样真东西。
 * 这一条要钉的只是「那行接线还在」,读源头文件比对是这件事最便宜也最稳的形式
 * (AGENTS.md「有对照测试就跑、没有就补一条(读源头文件比对)」)。
 */
describe('★★ 接线还在吗(读 src/agent.ts 源码比对)', () => {
  const SOURCE = readFileSync(new URL('../src/agent.ts', import.meta.url), 'utf8')

  it('接话那一路把自建客户端交给了上游(withDeepSeek 的 client 那一格)', () => {
    const call = SOURCE.slice(SOURCE.indexOf('OpenAILLM.withDeepSeek('))
    expect(call.slice(0, 600)).toContain('client: createNoThinkingClient(')
  })

  it('电话这一路显式写着「关思考」那一格(「关于我自己」那段读的也是它)', () => {
    expect(SOURCE).toContain('thinking: THINKING_DISABLED')
  })

  it('★ 首句那一路也是自建客户端 —— 工厂体内是 createNoThinkingClient(2026-10-23:它已是工厂)', () => {
    // 首句 client 2026-10-23 起是 buildFirstVoiceClient(view) 工厂(每通换模要重建),
    // createNoThinkingClient 在**工厂体内**,不在初始化那一行 —— 定位锚点跟着结构走。
    const factoryAt = SOURCE.indexOf('const buildFirstVoiceClient')
    expect(factoryAt).toBeGreaterThanOrEqual(0)
    const initAt = SOURCE.indexOf('let firstVoiceClient = buildFirstVoiceClient(llmOptions)')
    expect(initAt).toBeGreaterThan(factoryAt)
    const factory = SOURCE.slice(factoryAt, initAt)
    expect(factory).toContain('createNoThinkingClient(')
    // 初始化只取工厂返回值 —— 不是另起一次客户端构造。
    expect(SOURCE.slice(initAt, initAt + 200)).not.toContain('createNoThinkingClient(')
  })

  it('★ 首句接线整条链:工厂 → 初始化 → ask 用同一颗 → 每通换模成功后按工厂重建', () => {
    const factoryAt = SOURCE.indexOf('const buildFirstVoiceClient')
    const initAt = SOURCE.indexOf('let firstVoiceClient = buildFirstVoiceClient(llmOptions)')
    const askAt = SOURCE.indexOf('ask: async ({ system, user })')
    const refreshAt = SOURCE.indexOf('firstVoiceClient = buildFirstVoiceClient(llmViewOf(applied))')
    // 四个锚点一个不缺。
    for (const [name, at] of [['工厂', factoryAt], ['初始化', initAt], ['ask', askAt], ['每通刷新', refreshAt]] as const) {
      expect(at, `src/agent.ts 里找不到「${name}」锚点`).toBeGreaterThanOrEqual(0)
    }
    // 顺序合法:工厂定义 → 初始化 → ask → 每通刷新。
    expect(factoryAt).toBeLessThan(initAt)
    expect(initAt).toBeLessThan(askAt)
    expect(askAt).toBeLessThan(refreshAt)
    // ask 那一问用的是同一颗 client(首句快的一半原因:不带工具、不带人设)。
    const ask = SOURCE.slice(askAt, SOURCE.indexOf('speak: async (text, guard)'))
    expect(ask).toContain('firstVoiceClient.chat.completions.create(')
    // 每通刷新:换模那一块里先 applyCallModelRefresh 成功(agent.updateOptions 过),
    // 才用同一工厂重建首句 client —— 换不上就不动本地这颗。
    const refreshBlock = SOURCE.slice(SOURCE.indexOf('applyCallModelRefresh(current, fresh'), refreshAt)
    expect(refreshBlock).toContain('agent.updateOptions')
    expect(refreshBlock).not.toContain('createNoThinkingClient(')
  })

  it('首句那一问不带工具、也不带电话人设(短是它快的一半原因)', () => {
    // 终点那一行 2026-10-03(卡 fix/voice-route-zh)多了第二个参数 `guard`,所以标记跟着改。
    const call = SOURCE.slice(SOURCE.indexOf('ask: async ({ system, user })'), SOURCE.indexOf('speak: async (text, guard)'))
    expect(call).not.toBe('')
    expect(call).toContain('max_tokens: FIRST_VOICE_MAX_TOKENS')
    expect(call).not.toContain('tools')
    expect(call).not.toContain('persona')
  })
})
