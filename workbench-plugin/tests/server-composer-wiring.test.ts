// @vitest-environment node
/**
 * 统一输入框接到 DSH 的那两处(2026-09-24):开会话时的模型 / 权限 / 只出方案 / 图片,
 * 以及「先问我」的审批排在 DSH waterfall 最前面。DSH 的服务都是假的 —— 真 DSH 里的
 * 那一遍由统筹发版后真机验(见交接)。
 */
import { describe, expect, it, vi } from 'vitest'
import { createButlerSessionOpener, wireApprovalAnswerer } from '../src/index.ts'
import { createApprovalBroker } from '../src/server/composer.ts'

function fakeDsh(over: { prompt?: (request: unknown) => Promise<void> } = {}) {
  const calls = { prompt: [] as unknown[], selectModel: [] as unknown[], commands: [] as string[] }
  const agent = { session: { id: 'sess-1' } }
  const services = {
    sessionController: {
      create: async () => ({ sessionId: 'sess-1' }),
      prompt: over.prompt ?? (async (request: unknown) => { calls.prompt.push(request) }),
      selectModel: async (request: unknown) => { calls.selectModel.push(request) },
      modelCatalog: async () => ({ default: { provider: 'workbench-relay', model: 'deepseek-v4-flash' }, routableProviders: [], groups: [], failures: [] }),
    },
    commands: { execute: async (_agent: unknown, line: string) => { calls.commands.push(line); return { result: { kind: 'success' } } } },
    agents: { get: (id: string) => (id === 'sess-1' ? agent : undefined) },
  }
  const inject = vi.fn((_names: readonly string[], cb: (ctx: never) => void) => { cb(services as never) })
  return { calls, inject }
}

describe('createButlerSessionOpener 的统一输入框那几件', () => {
  it('先选模型、切权限、进 /plan,再说第一句(带图)', async () => {
    const { calls, inject } = fakeDsh()
    const opener = createButlerSessionOpener({ on: vi.fn(), inject })
    const id = await opener?.open('想想导出怎么做', {
      mode: 'plan',
      model: { provider: 'workbench-relay', id: 'deepseek-v4-pro' },
      images: [{ mediaType: 'image/png', data: 'QUJD', name: 'a.png' }],
    })
    expect(id).toBe('sess-1')
    // 思考档缺席 = 关,而且**明写**(2026-09-28 卡 BS:selectModel 顺手改全局默认,靠默认会漏给下一条)。
    expect(calls.selectModel).toEqual([{ sessionId: 'sess-1', provider: 'workbench-relay', model: 'deepseek-v4-pro', reasoningEffort: 'off' }])
    expect(calls.commands).toEqual(['/permission read-only', '/plan'])
    expect(calls.prompt).toEqual([expect.objectContaining({
      content: [{ type: 'text', text: '想想导出怎么做' }, { type: 'image', mediaType: 'image/png', data: 'QUJD', name: 'a.png' }],
    })])
  })

  it('「先问我」/「自动办」都是 workspace-write,不进 /plan;从不切 danger-full-access', async () => {
    for (const mode of ['ask', 'auto'] as const) {
      const { calls, inject } = fakeDsh()
      await createButlerSessionOpener({ on: vi.fn(), inject })?.open('做', { mode })
      expect(calls.commands).toEqual(['/permission workspace-write'])
    }
  })

  it('模型不收图 → 只发文字(原话里本来就写着图在哪),会话照开', async () => {
    const prompts: unknown[] = []
    const { inject } = fakeDsh({
      prompt: async (request) => {
        const content = (request as { content: { type: string }[] }).content
        if (content.some(one => one.type === 'image')) throw new Error('MODEL_DOES_NOT_SUPPORT_IMAGES')
        prompts.push(request)
      },
    })
    const id = await createButlerSessionOpener({ on: vi.fn(), inject })?.open('看图', { images: [{ mediaType: 'image/png', data: 'x' }] })
    expect(id).toBe('sess-1')
    expect(prompts).toEqual([expect.objectContaining({ content: [{ type: 'text', text: '看图' }] })])
  })

  /**
   * 思考档(2026-09-28,卡 BS)。两条都要:**不给模型也要把档写下去**(否则档等于没设),
   * 以及**这个模型没有那一档时挪一档**(pro 线上没有 low)。
   */
  it('只给档不给模型:先问 catalog 拿此刻的默认模型,再把档明写下去', async () => {
    const { calls, inject } = fakeDsh()
    await createButlerSessionOpener({ on: vi.fn(), inject })?.open('挑一家', { effort: 'low' })
    expect(calls.selectModel).toEqual([{
      sessionId: 'sess-1', provider: 'workbench-relay', model: 'deepseek-v4-flash', reasoningEffort: 'low',
    }])
  })

  it('pro 没有 low 那一档 → 往上挪到 high(不掉到关:要它想一点的事不能把判断去掉)', async () => {
    const { calls, inject } = fakeDsh()
    await createButlerSessionOpener({ on: vi.fn(), inject })?.open('挑一家', {
      effort: 'low', model: { provider: 'workbench-relay', id: 'deepseek-v4-pro' },
    })
    expect(calls.selectModel).toEqual([{
      sessionId: 'sess-1', provider: 'workbench-relay', model: 'deepseek-v4-pro', reasoningEffort: 'high',
    }])
  })

  it('catalog 透传 DSH 的模型表', async () => {
    const { inject } = fakeDsh()
    expect((await createButlerSessionOpener({ on: vi.fn(), inject })?.catalog?.())?.default.model).toBe('deepseek-v4-flash')
  })
})

describe('wireApprovalAnswerer', () => {
  function wire() {
    const broker = createApprovalBroker()
    let listener: ((req: unknown, next: () => Promise<string>) => Promise<string>) | undefined
    let options: unknown
    const on = vi.fn((event: string, fn: never, opts?: unknown) => { if (event === 'approval/request') { listener = fn; options = opts } })
    wireApprovalAnswerer({ on: on as never, inject: vi.fn() }, broker)
    return { broker, call: (req: unknown, next: () => Promise<string>) => listener!(req, next), options: () => options }
  }

  it('排在最前面(prepend)', () => {
    expect(wire().options()).toEqual({ prepend: true })
  })

  it('网页那边没人答(unavailable)→ 不算数,等档上点「允许」', async () => {
    const { broker, call } = wire()
    const pending = call({ agent: { session: { id: 's-1' } }, toolName: 'bash', reason: '写 /etc/hosts' }, async () => 'unavailable')
    await vi.waitFor(() => expect(broker.list()).toHaveLength(1))
    expect(broker.list()[0]).toMatchObject({ session_id: 's-1', tool: 'bash', reason: '写 /etc/hosts' })
    broker.answer(broker.list()[0]!.id, true)
    expect(await pending).toBe('allowed-once')
    expect(broker.list()).toEqual([])
  })

  it('网页那边先答了真答案 → 用它的,档上那一行撤掉', async () => {
    const { broker, call } = wire()
    expect(await call({ agent: { session: { id: 's-1' } }, toolName: 'bash' }, async () => 'rejected')).toBe('rejected')
    expect(broker.list()).toEqual([])
  })

  it('这一轮被停了(signal)→ cancelled', async () => {
    const { broker, call } = wire()
    const controller = new AbortController()
    const pending = call({ agent: { session: { id: 's-1' } }, toolName: 'bash', signal: controller.signal }, () => new Promise(() => {}))
    await vi.waitFor(() => expect(broker.list()).toHaveLength(1))
    controller.abort()
    expect(await pending).toBe('cancelled')
  })
})
