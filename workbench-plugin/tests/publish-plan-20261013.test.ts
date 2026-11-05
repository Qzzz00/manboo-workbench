// @vitest-environment node
/**
 * 座机 / 手机一句话排进发布计划(2026-10-13,卡「演示 · 座机一句话往自媒体日历里记发布计划」;周三 10-14 演示场景 4)。
 *
 * 钉三件事:
 *   ① 认话(`server/publishPlan.ts` 的 `publishPlanOf`):哪几句算在排发布计划、哪几句**故意不认**
 *      (「帮我做一个 XXX 的视频」要留给出图接力那张卡、「把那条视频发到小红书」是真发出去);
 *   ② 日期(`parsePublishDay`):「N 号」取最近的那个 N 号、「M 月 N 日」直接取、相对日子按常规,
 *      说不清的**不猜**(回问一句);
 *   ③ http 那一层:`POST /butler/item` 直接写成一条**与「卡片内填」同形**的选题卡
 *      (`kind:'topic'` + `planned_at`),不开会话、不建派活卡;同一天同一条再说一次不重复记。
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { DEFAULT_TOPIC_STAGE, publishPlanDescParts } from '../src/protocol.ts'
import type { WorkbenchServer } from '../src/server/http.ts'
import { startWorkbenchServer } from '../src/server/http.ts'
import {
  PUBLISH_PLAN_ASK_DAY,
  PUBLISH_PLAN_ASK_SUBJECT,
  parsePublishDay,
  publishPlanConfirmLine,
  publishPlanOf,
  publishPlanReply,
  publishPlanTitleOf,
  samePublishPlanOn,
} from '../src/server/publishPlan.ts'
import { createWorkbenchService } from '../src/server/service.ts'
import { createTasksService } from '../src/server/tasks.ts'

/** 钉死的工作台钟:2026-10-13(周二)上午 11 点。所有相对日子都从它算。 */
const NOW = new Date(2026, 9, 13, 11, 0).getTime()

describe('认话:哪几句是在排发布计划', () => {
  it('★「计划 18 号发一个关于秋天穿搭的视频」:主题、内容形式、哪一天都认出来', () => {
    const plan = publishPlanOf('计划 18 号发一个关于秋天穿搭的视频', NOW)
    expect(plan?.subject).toBe('秋天穿搭')
    expect(plan?.title).toBe('秋天穿搭的视频')
    expect(plan?.contentType).toBe('视频')
    expect(plan?.day).toBe('2026-10-18')
  })

  it('★「10 月 20 号发布一条露营装备的短视频」:没有「关于」也认得出主题;标题用她的那个词', () => {
    const plan = publishPlanOf('10 月 20 号发布一条露营装备的短视频', NOW)
    expect(plan?.title).toBe('露营装备的短视频')
    expect(plan?.contentType).toBe('视频')
    expect(plan?.day).toBe('2026-10-20')
  })

  it('图文 / 笔记算「图文」', () => {
    expect(publishPlanOf('下周三发一篇关于露营装备的图文', NOW)?.contentType).toBe('图文')
    expect(publishPlanOf('下周三发一篇关于露营装备的图文', NOW)?.day).toBe('2026-10-21')
    expect(publishPlanOf('打算后天发一条咖啡探店的笔记', NOW)?.contentType).toBe('图文')
  })

  it('★「帮我做一个花海中的大叔漫步的视频」不认 —— 那是「出图进可灵」那条接力,不是排计划', () => {
    expect(publishPlanOf('帮我做一个花海中的大叔漫步的视频', NOW)).toBeUndefined()
    expect(publishPlanOf('生成一条关于秋天穿搭的视频', NOW)).toBeUndefined()
  })

  it('★真发出去 / 问话 / 没主题的都不认(宁可漏认:照旧当一件普通事项)', () => {
    expect(publishPlanOf('把昨天那条视频发到小红书', NOW)).toBeUndefined()
    expect(publishPlanOf('那条视频发给我', NOW)).toBeUndefined()
    expect(publishPlanOf('18 号发什么视频好?', NOW)).toBeUndefined()
    // 识别结果里的问号两种宽度都有，两种都不认
    expect(publishPlanOf('18 号要发一条关于秋天穿搭的视频吗？', NOW)).toBeUndefined()
    expect(publishPlanOf('18 号发视频', NOW)).toBeUndefined()
    expect(publishPlanOf('安排一下发布计划', NOW)).toBeUndefined()
    expect(publishPlanOf('', NOW)).toBeUndefined()
  })

  it('★说不清哪天的照旧认下来,但 day 缺席 —— 由调用方回问一句,不猜', () => {
    const plan = publishPlanOf('月底发一条关于露营装备的视频', NOW)
    expect(plan?.title).toBe('露营装备的视频')
    expect(plan?.day).toBeUndefined()
    expect(PUBLISH_PLAN_ASK_DAY).toContain('哪天')
  })
})

/* ──────── 2026-10-13 下午真机那一句:不带「发布」、主题在后半句(卡 B「认法」)──────── */

describe('放宽认法:自然说法也要进日历(维护者 10-13 拍板)', () => {
  it('★真机原话「呃,我20号计划要发一个视频,是做我们大赛的整个回顾。」认得出', () => {
    const plan = publishPlanOf('呃,我20号计划要发一个视频,是做我们大赛的整个回顾。', NOW)
    expect(plan?.day).toBe('2026-10-20')
    expect(plan?.subject).toBe('我们大赛的整个回顾')
    expect(plan?.title).toBe('我们大赛的整个回顾的视频')
    expect(plan?.contentType).toBe('视频')
  })

  it('★「发一个 / 发个 / 发条 / 发一条」四种量词说法都算在排计划', () => {
    for (const said of [
      '我 20 号打算发一个关于秋天穿搭的视频',
      '20 号发个关于秋天穿搭的视频',
      '20 号发条关于秋天穿搭的视频',
      '20 号要发一条关于秋天穿搭的视频',
    ]) {
      expect(publishPlanOf(said, NOW)?.title, said).toBe('秋天穿搭的视频')
      expect(publishPlanOf(said, NOW)?.day, said).toBe('2026-10-20')
    }
  })

  it('★主题在后半句的几种引子:是做 / 是关于…的 / 讲', () => {
    expect(publishPlanOf('我打算 20 号发个视频,是关于秋天穿搭的', NOW)?.title).toBe('秋天穿搭的视频')
    expect(publishPlanOf('20 号发一条图文,讲露营装备怎么选', NOW)?.title).toBe('露营装备怎么选的图文')
    expect(publishPlanOf('20 号发一个视频,内容是我们大赛的回顾', NOW)?.subject).toBe('我们大赛的回顾')
  })

  it('★主题认不出:认下来但标 subjectUnknown —— 调用方回问一句,不猜主题', () => {
    const plan = publishPlanOf('我 20 号要发一个视频', NOW)
    expect(plan?.subjectUnknown).toBe(true)
    expect(plan?.subject).toBe('')
    expect(plan?.title).toBe('')
    expect(plan?.day).toBe('2026-10-20')
    expect(PUBLISH_PLAN_ASK_SUBJECT).toContain('关于什么')
  })

  it('★后半句不是主题的(「到时候提醒我」)不硬认成主题', () => {
    expect(publishPlanOf('20 号发一个视频,到时候提醒我', NOW)?.subjectUnknown).toBe(true)
  })

  it('★「N 号」仍是最近的那个 N 号:今天 13 号,20 号在本月、5 号算下月', () => {
    expect(publishPlanOf('我20号计划要发一个视频,是做大赛回顾', NOW)?.day).toBe('2026-10-20')
    expect(publishPlanOf('我5号计划要发一个视频,是做大赛回顾', NOW)?.day).toBe('2026-11-05')
  })
})

describe('publishPlanTitleOf:模型那条路递来的标题', () => {
  it('★没带内容形式的补上「的视频 / 的图文」,带了的不重复加', () => {
    expect(publishPlanTitleOf('大赛回顾', '视频')).toBe('大赛回顾的视频')
    expect(publishPlanTitleOf('大赛回顾的视频', '视频')).toBe('大赛回顾的视频')
    expect(publishPlanTitleOf('露营装备的笔记', '图文')).toBe('露营装备的笔记')
    expect(publishPlanTitleOf('「大赛回顾」。', '视频')).toBe('大赛回顾的视频')
    expect(publishPlanTitleOf('   ', '视频')).toBe('')
  })
})

describe('日期:从工作台的钟算起', () => {
  it('★「N 号」取最近的那个 N 号:本月还没到就本月,已经过了就下个月,今天就是今天', () => {
    expect(parsePublishDay('18 号发', NOW).day).toBe('2026-10-18')
    expect(parsePublishDay('5 号发', NOW).day).toBe('2026-11-05')
    expect(parsePublishDay('13 号发', NOW).day).toBe('2026-10-13')
    expect(parsePublishDay('十八号发', NOW).day).toBe('2026-10-18')
  })

  it('★「M 月 N 日 / 号」直接取;这个月份已经过了就算明年', () => {
    expect(parsePublishDay('10 月 20 日发', NOW).day).toBe('2026-10-20')
    expect(parsePublishDay('1 月 5 号发', NOW).day).toBe('2027-01-05')
    // 这个月份里没有这一天 —— 不挪到 3 月 2 号,一天都不记
    expect(parsePublishDay('2 月 30 号发', NOW).day).toBeUndefined()
  })

  it('相对日子与周几按常规(2026-10-13 是周二)', () => {
    expect(parsePublishDay('明天发', NOW).day).toBe('2026-10-14')
    expect(parsePublishDay('后天发', NOW).day).toBe('2026-10-15')
    expect(parsePublishDay('大后天发', NOW).day).toBe('2026-10-16')
    expect(parsePublishDay('今天发', NOW).day).toBe('2026-10-13')
    expect(parsePublishDay('周三发', NOW).day).toBe('2026-10-14')
    expect(parsePublishDay('下周三发', NOW).day).toBe('2026-10-21')
    expect(parsePublishDay('下周日发', NOW).day).toBe('2026-10-25')
  })

  it('★「月底」这种只认出「她在说日子」,一天都不填', () => {
    expect(parsePublishDay('月底发', NOW)).toEqual({ vague: true })
    expect(parsePublishDay('下个月发', NOW)).toEqual({ vague: true })
    expect(parsePublishDay('关于露营装备', NOW)).toEqual({})
  })
})

describe('回话那一句与去重', () => {
  it('★回的是「记进发布计划了 + 哪天 + 什么」,一句话说完', () => {
    const plan = publishPlanOf('计划 18 号发一个关于秋天穿搭的视频', NOW)
    expect(publishPlanReply(plan!, plan!.day!)).toBe('好,记进发布计划了:10 月 18 号,秋天穿搭的视频')
    expect(publishPlanConfirmLine(plan!, plan!.day!)).toContain('10 月 18 号')
  })

  it('★同一天同一条已经在盘上就认出来(再说一次不重复记);取消掉的那张不算', () => {
    const one = { id: 't-1', title: '秋天穿搭的视频', status: 'todo', planned_at: '2026-10-18', source: { kind: 'manual' as const }, created_at: '', updated_at: '' }
    expect(samePublishPlanOn([one] as never, '2026-10-18', '秋天穿搭的视频')?.id).toBe('t-1')
    expect(samePublishPlanOn([one] as never, '2026-10-19', '秋天穿搭的视频')).toBeUndefined()
    expect(samePublishPlanOn([{ ...one, status: 'canceled' }] as never, '2026-10-18', '秋天穿搭的视频')).toBeUndefined()
  })
})

// ———————————————————————— http 那一层 ————————————————————————

const started: WorkbenchServer[] = []
const dirs: string[] = []

afterEach(async () => {
  while (started.length) await started.pop()?.close()
  while (dirs.length) rmSync(dirs.pop() as string, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
})

async function post(url: string, path: string, body: unknown) {
  const res = await fetch(`${url}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  return { status: res.status, body: await res.json() as Record<string, any> }
}

async function serve() {
  const dir = mkdtempSync(join(tmpdir(), 'wb-publish-plan-'))
  dirs.push(dir)
  let n = 0
  const tasks = createTasksService({ file: join(dir, 'tasks.json'), newId: () => `t-${++n}` })
  const opened: string[] = []
  const server = await startWorkbenchServer({
    port: 0,
    service: createWorkbenchService({}),
    tickIntervalMs: 0,
    heartbeatMs: 0,
    tasks,
    // 开会话那条口留着,好证明这一支**一条都没开**。
    butlerSession: { open: async (text: string) => { opened.push(text); return 's-1' } } as never,
  })
  started.push(server)
  return { url: server.url, tasks, opened }
}

/** 这一句里的日子是写死的(12 月 31 号),所以断言不跟「今天是哪天」赌。 */
const SAID = '12 月 31 号发布一条关于年终总结的视频'

describe('POST /publish/plan:模型那条路也能把一条计划记进日历', () => {
  it('★落成与「一句话记发布计划」逐字同形的那张卡,不开会话', async () => {
    const { url, tasks, opened } = await serve()
    const res = await post(url, '/publish/plan', {
      title: '大赛回顾',
      date: '20 号',
      content_type: '视频',
      said: '我20号计划要发一个视频,是做我们大赛的整个回顾',
    })
    expect(res.status).toBe(200)
    expect(res.body.publish_plan?.title).toBe('大赛回顾的视频')
    expect(res.body.note).toContain('记进发布计划了')
    const card = (await tasks.list()).tasks.find(one => one.id === res.body.id)
    expect(card?.kind).toBe('topic')
    expect(card?.stage).toBe(DEFAULT_TOPIC_STAGE)
    expect(card?.content_type).toBe('视频')
    expect(card?.title).toBe('大赛回顾的视频')
    expect(card?.planned_at).toMatch(/-\d\d-20$/)
    expect(publishPlanDescParts(card?.desc).said).toContain('大赛')
    expect(opened).toEqual([])
  })

  it('★日子写成 YYYY-MM-DD 也收', async () => {
    const { url, tasks } = await serve()
    const res = await post(url, '/publish/plan', { title: '年终总结', date: '2026-12-31' })
    expect(res.body.publish_plan?.day).toBe('2026-12-31')
    expect((await tasks.list()).tasks[0]?.planned_at).toBe('2026-12-31')
  })

  it('★日子说不清:400 + 回问那一句,一张卡都不建', async () => {
    const { url, tasks } = await serve()
    const res = await post(url, '/publish/plan', { title: '年终总结', date: '月底' })
    expect(res.status).toBe(400)
    expect(res.body.error).toBe(PUBLISH_PLAN_ASK_DAY)
    expect((await tasks.list()).tasks.length).toBe(0)
  })

  it('★没说要发什么:400 + 回问那一句,一张卡都不建', async () => {
    const { url, tasks } = await serve()
    const res = await post(url, '/publish/plan', { title: '  ', date: '20 号' })
    expect(res.status).toBe(400)
    expect(res.body.error).toBe(PUBLISH_PLAN_ASK_SUBJECT)
    expect((await tasks.list()).tasks.length).toBe(0)
  })

  it('★同一天同一条再说一次:不重复记,回原来那张', async () => {
    const { url, tasks } = await serve()
    const first = await post(url, '/publish/plan', { title: '年终总结的视频', date: '2026-12-31' })
    const again = await post(url, '/publish/plan', { title: '年终总结', date: '2026-12-31' })
    expect(again.body.id).toBe(first.body.id)
    expect(again.body.publish_plan?.already).toBe(true)
    expect((await tasks.list()).tasks.length).toBe(1)
  })
})

describe('POST /confirm/points:电话里问的那一句照发布计划说', () => {
  it('★认出是在排计划 → 一句话确认(别念派活那三条)', async () => {
    const { url } = await serve()
    const res = await post(url, '/confirm/points', { text: SAID })
    expect(res.status).toBe(200)
    expect(res.body.simple).toBe(true)
    expect(res.body.spoken).toContain('发布计划')
    expect(res.body.spoken).toContain('12 月 31 号')
  })
})
