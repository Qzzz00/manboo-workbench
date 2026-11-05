/**
 * 电话里「让 Codex 把 X 做了」(2026-09-21,参赛冲刺卡 ④)。
 *
 * 工人这一侧只负责两件事:**把模型填的那一家归一化**,以及**把它原样发给 8791**。
 * 谁真去派活、派不派得出去,都是工作台那边的事 —— 这里绝不替它判断。
 *
 * 最要紧的两条:
 * - 模型没填 → **整个字段不发**(发一个空的上去,8791 分不清"没点名"与"点了名但认不出");
 * - 说给他听的那句话**以回执里的 assignee 为准**,不以我们发上去的为准
 *   (他点名的那家在那台电脑上可能根本没有命令行)。
 */
import { describe, expect, it } from 'vitest'
import { createWorkbenchClient, itemAssigneeOf } from '../src/workbench.ts'

/** 一个假的 8791:记下每次请求,按 `reply` 回包。 */
function stub(reply: Record<string, unknown>, status = 200) {
  const calls: { path: string, body: Record<string, unknown> }[] = []
  const client = createWorkbenchClient({
    baseUrl: 'http://127.0.0.1:8791',
    fetchImpl: (async (url: string, init?: RequestInit) => {
      calls.push({ path: String(url), body: JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown> })
      return new Response(JSON.stringify(reply), { status })
    }) as unknown as typeof fetch,
  })
  return { client, calls }
}

describe('模型填的那一家', () => {
  it('五家加它自己都认得,大小写与空格不管', () => {
    expect(itemAssigneeOf('codex')).toBe('codex')
    expect(itemAssigneeOf(' Claude ')).toBe('claude')
    expect(itemAssigneeOf('KIMI')).toBe('kimi')
    expect(itemAssigneeOf('dsh')).toBe('dsh')
  })

  /**
   * 2026-09-22:接口那只手有适配器了,GPT 与豆包进了值域。
   * 这条原来写在"认不得"那一条里(`'gpt'` 当时确实是认不得的),现在事实变了。
   */
  it('★ 走接口那两家也认得(他会在电话里说「让 GPT 写三个标题」)', () => {
    expect(itemAssigneeOf('gpt')).toBe('gpt')
    expect(itemAssigneeOf(' GPT ')).toBe('gpt')
    expect(itemAssigneeOf('Doubao')).toBe('doubao')
  })

  /**
   * ★ **开集**(2026-10-22,卡「契约对照测试补齐」):插件把写死名单删了(`AgentDispatchFamily = string`),
   * 工人这份跟着收成一样 —— 任意非空字符串都收,新家名不再当成「没点名」。
   * 开集这件事由 `tests/item-assignee-sync.test.ts` 读插件源码钉着。
   */
  it('★ 任意非空字符串都收(新家名不再当「没点名」)', () => {
    expect(itemAssigneeOf('gemini')).toBe('gemini')
    expect(itemAssigneeOf(' some-new-family ')).toBe('some-new-family')
  })

  it('空的、不是字符串的 → **当没点名**(整个字段不发,8791 分得清)', () => {
    for (const value of ['', '  ', null, undefined, 7, {}]) {
      expect(itemAssigneeOf(value)).toBeUndefined()
    }
  })
})

describe('发给 8791 的那一包', () => {
  it('点了名 → body 里带 assignee', async () => {
    const { client, calls } = stub({ id: 'item-1', assignee: 'codex' })
    await client.rememberItem('让 Codex 把首页改了', 'codex')
    expect(calls[0]?.path).toContain('/butler/item')
    // `source:'call'`(2026-09-24,卡 F):电话里已经过了确认点,工作台据此直接派、不再挂审批。
    expect(calls[0]?.body).toEqual({ text: '让 Codex 把首页改了', source: 'call', assignee: 'codex', client_key: expect.any(String) })
  })

  it('没点名 → **整个字段不发**', async () => {
    const { client, calls } = stub({ id: 'item-1' })
    await client.rememberItem('把首页改了')
    expect(calls[0]?.body).toEqual({ text: '把首页改了', source: 'call', client_key: expect.any(String) })
    expect('assignee' in (calls[0]?.body ?? {})).toBe(false)
  })
})

describe('回给模型的那句话', () => {
  it('工作台说落在 Codex 上 → 提一句它会去派,还提醒那边可能没有命令行', async () => {
    const { client } = stub({ id: 'item-1', assignee: 'codex' })
    const result = await client.rememberItem('让 Codex 把首页改了', 'codex')
    expect(result.ok).toBe(true)
    expect(result.text).toContain('codex')
    expect(result.text).toContain('没有命令行')
  })

  it('**以回执为准**:我们发了 codex 但工作台没落上 → 那句话里不提派活', async () => {
    const { client } = stub({ id: 'item-1' })
    const result = await client.rememberItem('让 Codex 把首页改了', 'codex')
    expect(result.text).not.toContain('会去派')
  })

  it('assignee=dsh(它自己办)→ 不提派活', async () => {
    const { client } = stub({ id: 'item-1', assignee: 'dsh' })
    const result = await client.rememberItem('这件你自己来', 'dsh')
    expect(result.text).not.toContain('会去派')
  })

  it('★工作台直接派了(回执里有 dispatch_note)→ 照那句说,**不说交给事务官了**,也不说做完了', async () => {
    const { client } = stub({ id: 'item-1', assignee: 'muse', dispatch_note: '正在派给 Muse(在它那边新开一条对话送进去),做完我把结果收回来' })
    const result = await client.rememberItem('让 Muse 查一下', 'muse')
    expect(result.ok).toBe(true)
    expect(result.text).toContain('正在派给 Muse')
    expect(result.text).not.toContain('交给事务官去办')
    expect(result.text).toContain('别说做完了')
  })

  it('会话没开成 → 还是那句「人还没派上」,不因为点了名就改口', async () => {
    const { client } = stub({ id: 'item-1', assignee: 'codex', note: '会话未开' })
    const result = await client.rememberItem('让 Codex 把首页改了', 'codex')
    expect(result.text).toContain('会话未开')
    expect(result.text).toContain('人还没派上')
  })
})
