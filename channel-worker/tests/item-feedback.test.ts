/**
 * 电话里说了一句「工作台这里不对」(2026-09-28 卡 FB,2026-10-01 按新 main 重做)。
 *
 * 工作台那头这一句**不建卡、不派任何一家**,回执里带 `feedback` 与事务官那一句。
 * 工人这一侧要做的只有一件事:**照那一句说**,别走「记下了,事项 id …」那几句 ——
 * 那会儿既没有 id,也没有人在办,说成「事务官还没开始办」是假话(D13)。
 */
import { describe, expect, it } from 'vitest'
import { createWorkbenchClient } from '../src/workbench.ts'

function stub(reply: Record<string, unknown>, status = 200) {
  const client = createWorkbenchClient({
    baseUrl: 'http://127.0.0.1:8791',
    fetchImpl: (async () => new Response(JSON.stringify(reply), { status })) as unknown as typeof fetch,
  })
  return client
}

const NOTE = '这是工作台本身的问题,我已经反馈给开发者了,修好会随更新到你这。'

describe('本体的毛病:照工作台那一句说', () => {
  it('回执带 feedback → 说那一句,不提事项 id、不提事务官', async () => {
    const client = stub({ ok: true, feedback: { id: 'fb-1', status: 'sent' }, note: NOTE })
    const out = await client.rememberItem('发布计划那里没有标记今天是哪一天,这个不方便,安排 Codex 去处理吧')
    expect(out.ok).toBe(true)
    // 第一句就是工作台那一句;底下只有「照这一句说」的纪律,没有「记下了,事项 id …」那几句。
    expect(out.text.startsWith(NOTE)).toBe(true)
    expect(out.text).not.toContain('记下了,事项 id')
    expect(out.text).not.toContain('已经交给事务官去办')
  })

  it('发不出去那一句也原样说(不许说成已经反馈了)', async () => {
    const local = '这是工作台本身的问题,我记下了。还没连上服务器(没登录),这一条先记在本机。'
    const client = stub({ ok: true, feedback: { id: 'fb-2', status: 'local' }, note: local })
    const out = await client.rememberItem('顶栏的时间显示不对')
    expect(out.text).toContain('还没连上服务器')
  })

  it('没有 feedback 这一格就一个字都不变(普通一件事照旧)', async () => {
    const client = stub({ id: 'item-9' })
    const out = await client.rememberItem('明天上午十点提醒我开会')
    expect(out.text).toContain('事项 id item-9')
  })
})
