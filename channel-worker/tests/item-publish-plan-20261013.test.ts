/**
 * 电话里一句话排进发布计划(2026-10-13,卡「演示 · 座机一句话记发布计划」;周三 10-14 演示场景 4)。
 *
 * 工作台那头这一句**直接记进她日历上那一格**(一条选题卡 + 计划发布日),没有人在办、没派给谁,
 * 回执里带 `publish_plan` 与那一句话。工人这一侧要做的只有一件事:**照那一句说** ——
 * 不许走下面那两句「我这就去办」/「人还没派上」,那会儿两样都是假话(D13,同 `feedback` 那一档的理由)。
 *
 * 这原是上一张卡在 `channel-worker` 里唯一的改动(其余全在插件侧;发版要带通话组件才有这一句)。
 *
 * **2026-10-13 下午续(卡 B / B′,交接 `docs/交接-1013-认法与记发布计划.md`)**:场景 4 真机那一通里
 * 「你帮我记到日历上面去啊?」8791 没认出来 → 模型编了一件不存在的工具 `wb_calendar_add`,
 * 转头用 `wb_dispatch_item` 建了张没负责人的卡(t-86856ebb),被事务官自己接去跑了 51 步 ¥0.51。
 * 所以模型这条路上补一件 `wb_publish_plan`(打 8791 新增的 `POST /publish/plan`),
 * 并在 `wb_dispatch_item` 门口把明说「记到日历 / 记进发布计划」的那一句拦回去。
 */
import { describe, expect, it } from 'vitest'
import { toolsForIntents } from '../src/intentTools.ts'
import { TOOL_DISPATCH, TOOL_PUBLISH_PLAN, TOOL_REMEMBER, createChannelTools } from '../src/tools.ts'
import { routeByRules } from '../src/turnRoute.ts'
import { createWorkbenchClient, type WorkbenchClient } from '../src/workbench.ts'
import { RPC_ALLOWED } from '../src/rpc.ts'

function stub(reply: Record<string, unknown>, status = 200) {
  return createWorkbenchClient({
    baseUrl: 'http://127.0.0.1:8791',
    fetchImpl: (async () => new Response(JSON.stringify(reply), { status })) as unknown as typeof fetch,
  })
}

const SAID = '计划 18 号发一个关于秋天穿搭的视频'
const NOTE = '好,记进发布计划了:10 月 18 号,秋天穿搭的视频'

describe('发布计划:照工作台那一句说', () => {
  it('★回执带 publish_plan → 说那一句,不说「我去办」、不说「人还没派上」', async () => {
    const out = await stub({ ok: true, id: 't-1', publish_plan: { day: '2026-10-18', title: '秋天穿搭的视频' }, note: NOTE }).rememberItem(SAID)
    expect(out.ok).toBe(true)
    // 第一行就是工作台那一句;底下只有「照这一句说」的纪律(那一行里本来就写着「别说『派出去了』」)。
    expect(out.text.split('\n')[0]).toBe(NOTE)
    expect(out.text).not.toContain('事项 id')
    expect(out.text).not.toContain('我这就去办')
    expect(out.text).not.toContain('人还没派上')
  })

  it('★日子没说清:工作台 400 + 回问那一句 —— 工人原样把那一问带回去,不许说记上了', async () => {
    const ask = '这条打算哪天发?说个日子(「18 号」「10 月 20 日」「下周三」都行),我就记进发布计划。'
    const out = await stub({ error: ask }, 400).rememberItem('月底发一条关于秋天穿搭的视频')
    expect(out.ok).toBe(false)
    expect(out.text).toContain(ask)
    expect(out.text).not.toContain('记下了')
  })

  it('没有 publish_plan 这一格就一个字都不变(普通一件事照旧)', async () => {
    const out = await stub({ id: 'item-9' }).rememberItem('明天上午十点提醒我开会')
    expect(out.text).toContain('事项 id item-9')
  })
})

/**
 * ——— 这一句在电话里走哪条路(**本卡一个字都没改 `turnRoute.ts` / `intentTools.ts`**)———
 *
 * 钉下来是为了彩排页上那句「照这么说」有依据:**说「发布」那一种**才带得到那件能打到
 * `/butler/item` 的工具(`wb_dispatch_item`);少了「发布」又短过长句门槛的那一种落到闲聊(零工具),
 * 带「记一下」的那一种会被模型挑去 `wb_remember_item` —— 那一件走 `/task/create`,**不进日历**。
 * 这三条是现状的量,不是本卡的做法;要让后两种也进日历得再改工人(交接里列为下一张卡)。
 */
describe('电话里这一句走哪条路(现状,本卡没改)', () => {

  it('没有「发布」又短过长句门槛的那一种,现在落到闲聊(零工具)—— 彩排别这么说', () => {
    expect(routeByRules('计划 18 号发一个穿搭视频').route).toBe('chat')
  })

  it('带「记一下」的那一种归「记一笔」那一组(手上两件都有,模型多半挑只记那一件)', () => {
    const hit = routeByRules('记一下,18 号发一条关于秋天穿搭的视频')
    expect(hit.route).toBe('act')
    expect(hit.intent).toBe('remember')
    expect(toolsForIntents(hit.intents)).toContain(TOOL_REMEMBER)
  })
})

/* ──────── 2026-10-13 下午:模型那条路也要能把一条计划记进日历(卡 B / B′)──────── */

interface FakeTool { execute: (args: Record<string, unknown>, ctx: never) => Promise<unknown> }

function toolOf(name: string, wb: Partial<WorkbenchClient>): FakeTool {
  return (createChannelTools({ workbench: wb as WorkbenchClient }) as unknown as Record<string, FakeTool>)[name] as FakeTool
}

/** 一个真客户端上的 `publishPlan`(接口上那一格是可选的 —— 老工作台没有这条路)。 */
function plannerOn(fetchImpl: typeof fetch): NonNullable<WorkbenchClient['publishPlan']> {
  const client = createWorkbenchClient({ baseUrl: 'http://127.0.0.1:8791', fetchImpl })
  return client.publishPlan as NonNullable<WorkbenchClient['publishPlan']>
}

describe('wb_publish_plan:模型路「记到日历」只走它', () => {
  it('★调它 → 打 /publish/plan,照工作台那一句说', async () => {
    const calls: unknown[] = []
    const tool = toolOf(TOOL_PUBLISH_PLAN, {
      publishPlan: async (input) => { calls.push(input); return { ok: true, text: NOTE } },
    })
    const text = String(await tool.execute({ title: '大赛回顾', date: '20 号', content_type: '视频', said: '我20号计划要发一个视频' }, {} as never))
    expect(calls).toEqual([{ title: '大赛回顾', date: '20 号', contentType: '视频', said: '我20号计划要发一个视频' }])
    expect(text).toContain(NOTE)
  })

  it('★这台工作台还没有这条路:如实说,别说记上了', async () => {
    const tool = toolOf(TOOL_PUBLISH_PLAN, {})
    const text = String(await tool.execute({ title: '大赛回顾', date: '20 号' }, {} as never))
    expect(text).not.toContain('记进发布计划了')
    expect(text).toContain('如实')
  })

  it('★HTTP 那一层:POST /publish/plan {title,date,content_type,said}', async () => {
    const calls: { path: string, body: unknown }[] = []
    const publishPlan = plannerOn((async (input: string | URL | Request, init?: RequestInit) => {
      calls.push({ path: new URL(String(input)).pathname, body: JSON.parse(String(init?.body ?? '{}')) as unknown })
      return new Response(JSON.stringify({ ok: true, id: 't-1', publish_plan: { day: '2026-10-20', title: '大赛回顾的视频' }, note: NOTE }), { status: 200, headers: { 'content-type': 'application/json' } })
    }) as unknown as typeof fetch)
    const out = await publishPlan({ title: '大赛回顾', date: '20 号', contentType: '视频', said: '原话' })
    expect(calls).toEqual([{ path: '/publish/plan', body: { title: '大赛回顾', date: '20 号', content_type: '视频', said: '原话' } }])
    expect(out.ok).toBe(true)
    expect(out.text.split('\n')[0]).toBe(NOTE)
    // 第一行是工作台那一句,底下只有「照这一句说」的纪律(那一行里本来就写着别说「我去办」)。
    expect(out.text).toContain('照这一句说')
  })

  it('★日子说不清:8791 那一问原样带回去问她,不许说记上了', async () => {
    const ask = '这条打算哪天发?说个日子(「18 号」「10 月 20 日」「下周三」都行),我就记进发布计划。'
    const publishPlan = plannerOn((async () => new Response(JSON.stringify({ error: ask }), { status: 400, headers: { 'content-type': 'application/json' } })) as unknown as typeof fetch)
    const out = await publishPlan({ title: '大赛回顾', date: '月底' })
    expect(out.ok).toBe(false)
    expect(out.text).toContain(ask)
    expect(out.text).not.toContain('记进发布计划了')
  })

  it('★她压根没说要发什么:一条请求都不发,先问她一句', async () => {
    let sent = 0
    const publishPlan = plannerOn((async () => { sent += 1; return new Response('{}', { status: 200 }) }) as unknown as typeof fetch)
    const out = await publishPlan({ title: '  ', date: '20 号' })
    expect(sent).toBe(0)
    expect(out.ok).toBe(false)
    expect(out.text).toContain('关于什么')
  })

  it('★老工作台(404):如实说版本旧了', async () => {
    const publishPlan = plannerOn((async () => new Response(JSON.stringify({ error: 'not found' }), { status: 404, headers: { 'content-type': 'application/json' } })) as unknown as typeof fetch)
    const out = await publishPlan({ title: '大赛回顾', date: '20 号' })
    expect(out.ok).toBe(false)
    expect(out.text).toContain('版本旧了')
  })
})

describe('按意图递工具的表里有 wb_publish_plan', () => {
  for (const said of ['记一下,20 号发一个大赛回顾的视频', '20 号发布一条关于秋天穿搭的视频', '把它改成 20 号发', '提醒我 20 号发那条片子']) {
    it(`「${said}」这一回合手上有它`, () => {
      const hit = routeByRules(said)
      expect(toolsForIntents(hit.intents), said).toContain(TOOL_PUBLISH_PLAN)
    })
  }

  it('★「你帮我记到日历上面去啊」不再落到闲聊(零工具):归「记一笔」那一组,手上有它', () => {
    // 10-13 下午那一通里这一句判成闲聊、一件工具都没有,于是模型自己编了一件 `wb_calendar_add`。
    const hit = routeByRules('你帮我记到日历上面去啊')
    expect(hit.route).toBe('act')
    expect(hit.intent).toBe('remember')
    expect(toolsForIntents(hit.intents)).toContain(TOOL_PUBLISH_PLAN)
  })

  it('房间白名单里有 POST /publish/plan(出门经中转也记得上)', () => {
    expect(RPC_ALLOWED.some(one => one.method === 'POST' && one.path === '/publish/plan')).toBe(true)
  })
})
