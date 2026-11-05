/**
 * Jev 分流(可插拔的第二实现)。**假 HTTP**,一个真请求都不发 ——
 * 这几条用例本身就是「他说的话不许出境」的一部分。
 *
 * 钉五件:
 *   ① 回包认得出来(choice + confidence);
 *   ② **`other` / 把握不够 / 非 200 / 超时 / 读不懂,一律按要办事**;
 *   ③ key 只进 Authorization 头,**不进日志、不进任何一句话**;
 *   ④ 请求体里选项带 `other`(官方规矩:choice 必加);
 *   ⑤ 成本估算是估的,而且随句子长短变。
 */
import { describe, expect, it } from 'vitest'
import {
  JEV_CHOICES,
  JEV_MIN_CONFIDENCE,
  JEV_MODEL,
  JevTurnRouter,
  decisionOfJevBody,
  estimateCostUsd,
  estimateTokens,
} from '../src/jevRouter.ts'

/** 一台假的 Jev:回什么由用例说了算,顺手把收到的请求留下来给用例看。 */
function fakeJev(reply: { status?: number, body?: unknown, throws?: Error }) {
  const seen: { url: string, init: RequestInit }[] = []
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    seen.push({ url: String(url), init: init ?? {} })
    if (reply.throws !== undefined) throw reply.throws
    return {
      ok: (reply.status ?? 200) < 400,
      status: reply.status ?? 200,
      json: async () => reply.body,
    } as unknown as Response
  }) as unknown as typeof fetch
  return { fetchImpl, seen }
}

/** 官方那种形状:questions 数组里一条 choice 的答案。 */
function body(choice: string, confidence?: number): unknown {
  return { model: JEV_MODEL, questions: [{ id: 'route', choice, ...(confidence === undefined ? {} : { confidence }) }] }
}

describe('Jev 回包 → 判定', () => {
  it('判「闲聊」而且够有把握 → 闲聊', () => {
    expect(decisionOfJevBody(body('闲聊', 0.93), 310)).toMatchObject({ route: 'chat', router: 'jev', ms: 310, confidence: 0.93 })
  })

  it('判「要办事」→ 要办事', () => {
    expect(decisionOfJevBody(body('要办事', 0.88), 280).route).toBe('act')
  })

  it('选了 other(拿不准)→ 要办事', () => {
    const decision = decisionOfJevBody(body('other', 0.99), 300)
    expect(decision.route).toBe('act')
    expect(decision.reason).toContain('other')
  })

  it(`把握低于 ${JEV_MIN_CONFIDENCE} → 要办事(置信度不当放行权限用)`, () => {
    const decision = decisionOfJevBody(body('闲聊', 0.51), 300)
    expect(decision.route).toBe('act')
    expect(decision.reason).toContain('0.51')
  })

  it('没有 confidence 那一格也能用(noul 那一类就没有)', () => {
    expect(decisionOfJevBody(body('闲聊'), 300).route).toBe('chat')
  })

  it('回包读不懂 → 要办事', () => {
    expect(decisionOfJevBody({ 天书: 1 }, 300).route).toBe('act')
    expect(decisionOfJevBody(null, 300).route).toBe('act')
  })
})

describe('JevTurnRouter:一次调用', () => {
  it('请求发对地方、带对模型、选项里有 other', async () => {
    const fake = fakeJev({ body: body('闲聊', 0.9) })
    const router = new JevTurnRouter({ apiKey: 'sk-不该出现在别处', baseUrl: 'https://假的/systemone', fetchImpl: fake.fetchImpl })
    expect((await router.route('你是谁？')).route).toBe('chat')
    const sent = fake.seen[0]
    expect(sent?.url).toBe('https://假的/systemone')
    const payload = JSON.parse(String(sent?.init.body))
    expect(payload.model).toBe(JEV_MODEL)
    expect(payload.state).toBe('你是谁？')
    expect(payload.questions[0].choices).toEqual([...JEV_CHOICES])
    expect(payload.questions[0].choices).toContain('other')
  })

  it('key 只在 Authorization 头里,一个字都不进日志', async () => {
    const lines: string[] = []
    const fake = fakeJev({ status: 500 })
    const router = new JevTurnRouter({ apiKey: 'sk-绝密', fetchImpl: fake.fetchImpl, log: line => lines.push(line) })
    const decision = await router.route('随便一句')
    expect(decision.route).toBe('act')
    const headers = fake.seen[0]?.init.headers as Record<string, string>
    expect(headers.authorization).toBe('Bearer sk-绝密')
    expect(lines.join('\n')).not.toContain('绝密')
    expect(JSON.stringify(decision)).not.toContain('绝密')
  })

  it('回了 500 → 要办事,并记一行', async () => {
    const lines: string[] = []
    const fake = fakeJev({ status: 500 })
    const router = new JevTurnRouter({ apiKey: 'sk-x', fetchImpl: fake.fetchImpl, log: line => lines.push(line) })
    expect((await router.route('一句话')).reason).toContain('500')
    expect(lines.join('\n')).toContain('500')
  })

  it('网断了 / 超时 → 要办事,绝不抛', async () => {
    const fake = fakeJev({ throws: Object.assign(new Error('The operation was aborted'), { name: 'AbortError' }) })
    const router = new JevTurnRouter({ apiKey: 'sk-x', timeoutMs: 50, fetchImpl: fake.fetchImpl })
    const decision = await router.route('一句话')
    expect(decision.route).toBe('act')
    expect(decision.reason).toContain('50ms')
  })

  it('判一次要多久:自己量,进日志与体检页', async () => {
    let clock = 1000
    const fake = fakeJev({ body: body('闲聊', 0.95) })
    const router = new JevTurnRouter({ apiKey: 'sk-x', fetchImpl: fake.fetchImpl, now: () => (clock += 320) })
    expect((await router.route('你是谁？')).ms).toBe(320)
  })
})

describe('成本估算(是估的,不是账单)', () => {
  it('句子越长估得越贵,而且一直是个极小的数', () => {
    const 短 = estimateCostUsd('喂。')
    const 长 = estimateCostUsd('把音色这个事情改成可以配置的，而且是我在电话通话中能够改的，你能派单吗？')
    expect(长).toBeGreaterThan(短)
    expect(长).toBeLessThan(0.0001)
  })

  it('token 按中文一字一个保守估,问题与选项也算进去', () => {
    expect(estimateTokens('喂。')).toBeGreaterThan('喂。'.length)
  })
})
