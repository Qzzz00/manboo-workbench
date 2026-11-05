// @vitest-environment node
/**
 * 派活的第二只手:经中转发给 GPT / 豆包(2026-09-22)。
 *
 * **上游全是打桩的**:没有真 Key、一个字节都不出这台机器。要钉的是四样:
 * ① 提示词里那三条硬边界(尤其"你改不了文件")真在里面;
 * ② 发出去那条请求长什么样(模型名、两条 message、带的是中转令牌);
 * ③ 失败**如实归类、原话原样带走**,绝不假装成功;
 * ④ 记到卡上的那条 `TaskDispatch` 是 `hand:'api'`,没有工作目录时那一格干脆缺席。
 */
import { describe, expect, it } from 'vitest'
import {
  API_DISPATCH_FAMILIES, API_DISPATCH_MODELS, buildDispatchPrompt, classifyApiFailure,
  createApiDispatch, isApiDispatchFamily, replyNote,
} from '../src/server/dispatchApi.ts'

const NOW = new Date('2026-09-22T10:00:00Z')

/** 一个会说 OpenAI 方言的假上游。**记下每一条请求**,用例对着它断言。 */
function stub(reply: unknown, status = 200) {
  const calls: { url: string, headers: Record<string, string>, body: Record<string, unknown> }[] = []
  const fetchImpl = ((url: string, init: RequestInit) => {
    calls.push({
      url: String(url),
      headers: init.headers as Record<string, string>,
      body: JSON.parse(String(init.body)) as Record<string, unknown>,
    })
    return Promise.resolve(new Response(JSON.stringify(reply), {
      status, headers: { 'content-type': 'application/json' },
    }))
  }) as unknown as typeof fetch
  return { fetchImpl, calls }
}

const OK_REPLY = {
  choices: [{ message: { role: 'assistant', content: '这是它写的文案。' } }],
  usage: { total_tokens: 123 },
}

function make(reply: unknown, status = 200, endpoint?: Partial<{ mode: 'relay' | 'own', baseUrl: string, key: string, ready: boolean }>) {
  const stubbed = stub(reply, status)
  const dispatch = createApiDispatch({
    endpoint: () => Promise.resolve({
      mode: 'relay', baseUrl: 'https://relay.example.com/v1', key: 'wb_token_x', ready: true, ...endpoint,
    }),
    fetchImpl: stubbed.fetchImpl,
    now: () => NOW,
  })
  return { dispatch, calls: stubbed.calls }
}

describe('哪两家走这只手', () => {
  it('只有 GPT 与豆包,顺序固定', () => {
    expect([...API_DISPATCH_FAMILIES]).toEqual(['gpt', 'doubao'])
  })

  it('★ 老三家进不来 —— 它们有订阅可用,走窗口或命令行', () => {
    expect(isApiDispatchFamily('codex')).toBe(false)
    expect(isApiDispatchFamily('claude')).toBe(false)
    expect(isApiDispatchFamily('kimi')).toBe(false)
    expect(isApiDispatchFamily('gpt')).toBe(true)
  })

  it('★ 默认模型的前缀就是中转分家的判据(gpt-* / doubao-*)', () => {
    // 这两个前缀与 relay/server/providers.cjs 的 providerOfModel 是同一件事:
    // 前缀改了就会发到另一家去,而两边的 Key 都是对的,于是错得毫无声响。
    expect(API_DISPATCH_MODELS.gpt.startsWith('gpt-')).toBe(true)
    expect(API_DISPATCH_MODELS.doubao.startsWith('doubao-')).toBe(true)
  })
})

describe('提示词', () => {
  const prompt = buildDispatchPrompt({
    family: 'gpt',
    text: '给这条笔记写三个标题',
    context: { project: '小红书账号', cwd: '/Users/example/Code/ops', note: '做科普内容' },
  })

  it('★ 三条硬边界都在 system 里,尤其「你改不了文件」', () => {
    expect(prompt.system).toContain('改不了任何文件')
    expect(prompt.system).toContain('不要推测、不要编')
    expect(prompt.system).toContain('用中文回答')
  })

  it('白板上的分工写进去了(它得知道自己是被当成哪一手请来的)', () => {
    expect(prompt.system).toContain('你是 GPT')
    expect(buildDispatchPrompt({ family: 'doubao', text: 'x' }).system).toContain('润色')
  })

  it('项目上下文与原话分开放,原话一个字不改', () => {
    expect(prompt.user).toContain('项目:小红书账号')
    expect(prompt.user).toContain('/Users/example/Code/ops')
    expect(prompt.user).toContain('给这条笔记写三个标题')
  })

  it('★ 没挂项目就**明说没有上下文**,不悄悄少一段(模型看不到上下文时会自己脑补)', () => {
    const bare = buildDispatchPrompt({ family: 'gpt', text: '写条文案' })
    expect(bare.user).toContain('没挂在任何项目上')
    // 没有"项目:…"那几行(那是有上下文时才拼的)。
    expect(bare.user).not.toContain('项目:')
  })
})

describe('真发一次(上游打桩)', () => {
  it('发的是中转的 /chat/completions,带的是中转令牌、默认模型、两条 message', async () => {
    const { dispatch, calls } = make(OK_REPLY)
    const out = await dispatch.send({ family: 'gpt', text: '写条文案' })
    expect(out.ok).toBe(true)
    expect(calls).toHaveLength(1)
    expect(calls[0]?.url).toBe('https://relay.example.com/v1/chat/completions')
    expect(calls[0]?.headers.authorization).toBe('Bearer wb_token_x')
    expect(calls[0]?.body.model).toBe('gpt-4o')
    const messages = calls[0]?.body.messages as { role: string }[]
    expect(messages.map(one => one.role)).toEqual(['system', 'user'])
  })

  it('明着传 model 就用它(以后界面上做「换个型号」不用改这一层)', async () => {
    const { dispatch, calls } = make(OK_REPLY)
    await dispatch.send({ family: 'gpt', text: 'x', model: 'gpt-4o-mini' })
    expect(calls[0]?.body.model).toBe('gpt-4o-mini')
  })

  it('豆包发的是 doubao- 开头的模型(中转据此挑火山方舟)', async () => {
    const { dispatch, calls } = make(OK_REPLY)
    await dispatch.send({ family: 'doubao', text: '润色一下' })
    expect(String(calls[0]?.body.model).startsWith('doubao-')).toBe(true)
  })

  it('成了:卡上记 done、hand=api,回答与 token 数都带回来', async () => {
    const { dispatch } = make(OK_REPLY)
    const out = await dispatch.send({ family: 'gpt', text: '写条文案', context: { cwd: '/Users/example/Code/ops' } })
    expect(out.dispatch.status).toBe('done')
    expect(out.dispatch.hand).toBe('api')
    expect(out.dispatch.family).toBe('gpt')
    expect(out.dispatch.cwd).toBe('/Users/example/Code/ops')
    expect(out.dispatch.note).toBe('这是它写的文案。')
    expect(out.reply).toBe('这是它写的文案。')
    expect(out.tokens).toBe(123)
  })

  it('★ 没有工作目录时 cwd 那一格**干脆缺席**,不写一个编的', async () => {
    const { dispatch } = make(OK_REPLY)
    const out = await dispatch.send({ family: 'gpt', text: '写条文案' })
    expect(out.dispatch.cwd).toBeUndefined()
  })

  it('开始与结束时刻都记上(卡上要显示"什么时候派的")', async () => {
    const { dispatch } = make(OK_REPLY)
    const out = await dispatch.send({ family: 'gpt', text: 'x' })
    expect(out.dispatch.started_at).toBe(NOW.toISOString())
    expect(out.dispatch.ended_at).toBe(NOW.toISOString())
  })
})

describe('发不出去的那几种', () => {
  it('★ 用自己的 DeepSeek Key 时如实拦下,并说清下一步 —— 不把 gpt-4o 发给 DeepSeek', async () => {
    const { dispatch, calls } = make(OK_REPLY, 200, { mode: 'own' })
    const out = await dispatch.send({ family: 'gpt', text: 'x' })
    expect(out.ok).toBe(false)
    expect(out.kind).toBe('not_relay')
    expect(out.reason).toContain('设置 → 模型')
    // 一个字节都没发出去。
    expect(calls).toHaveLength(0)
  })

  it('还没领到中转令牌:如实说,不发', async () => {
    const { dispatch, calls } = make(OK_REPLY, 200, { ready: false, key: undefined as unknown as string })
    const out = await dispatch.send({ family: 'gpt', text: 'x' })
    expect(out.kind).toBe('no_token')
    expect(calls).toHaveLength(0)
  })

  it('★ 服务器没配那家(中转 503):原话原样挂到卡上', async () => {
    const { dispatch } = make(
      { error: { message: '服务器没配 OpenAI(缺 RELAY_OPENAI_KEY),这条请求发不出去。', code: 'openai_not_configured' } },
      503,
    )
    const out = await dispatch.send({ family: 'gpt', text: 'x' })
    expect(out.ok).toBe(false)
    expect(out.kind).toBe('not_configured')
    // 中转那句话本来就是写给不懂代码的人看的中文人话,这里**不改写**。
    expect(out.dispatch.note).toContain('服务器没配 OpenAI')
    expect(out.dispatch.status).toBe('failed')
  })

  it('额度用完(429):归到额度那一类', async () => {
    const { dispatch } = make({ error: { message: '今天额度用完了。', code: 'daily_quota_exceeded' } }, 429)
    expect((await dispatch.send({ family: 'gpt', text: 'x' })).kind).toBe('quota')
  })

  it('上游回了一段空的:算没做成,而不是记一张"完成"的空卡', async () => {
    const { dispatch } = make({ choices: [{ message: { content: '   ' } }] })
    const out = await dispatch.send({ family: 'doubao', text: 'x' })
    expect(out.ok).toBe(false)
    expect(out.kind).toBe('empty')
    expect(out.dispatch.status).toBe('failed')
  })

  it('连不上:502 那一类,而且错误里不带请求细节', async () => {
    const dispatch = createApiDispatch({
      endpoint: () => Promise.resolve({ mode: 'relay' as const, baseUrl: 'https://relay.example.com/v1', key: 'k', ready: true }),
      fetchImpl: (() => Promise.reject(new Error('connect ECONNREFUSED 10.0.0.1:8795 with Bearer wb_token_x'))) as unknown as typeof fetch,
      now: () => NOW,
    })
    const out = await dispatch.send({ family: 'gpt', text: 'x' })
    expect(out.kind).toBe('unreachable')
    // ★ 令牌、地址一个字都不许进那句给人看的原因里。
    expect(out.reason).not.toContain('wb_token_x')
    expect(out.reason).not.toContain('10.0.0.1')
  })

  it('正文是空的就不发', async () => {
    const { dispatch, calls } = make(OK_REPLY)
    expect((await dispatch.send({ family: 'gpt', text: '   ' })).ok).toBe(false)
    expect(calls).toHaveLength(0)
  })

  it('归类表:认不出的状态码归 upstream_error,不硬塞进某一类', () => {
    expect(classifyApiFailure(400)).toBe('upstream_error')
    expect(classifyApiFailure(401)).toBe('no_token')
    expect(classifyApiFailure(503, 'doubao_not_configured')).toBe('not_configured')
    expect(classifyApiFailure(200)).toBe('other')
  })
})

describe('卡上那句 note', () => {
  it('短回答原样记', () => {
    expect(replyNote('三个标题:一、二、三')).toBe('三个标题:一、二、三')
  })

  it('★ 太长就截,而且**明说截了多少**(被悄悄切一半的回答比没有更坏)', () => {
    const note = replyNote('字'.repeat(500))
    expect(note).toContain('…(还有 100 字')
    expect(note).toContain('全文在这条事项的会话里')
  })

  it('换行压成一行(小标那一格是一行的)', () => {
    expect(replyNote('第一行\n\n第二行')).toBe('第一行 第二行')
  })
})
