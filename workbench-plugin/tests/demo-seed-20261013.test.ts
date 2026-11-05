// @vitest-environment node
/**
 * 演示数据一键放进去(2026-10-13,卡「演示数据一键放进去」)。
 *
 * 这份用例的主钉子是**那四段真的出得来**:把放进去的卡与任务账原样喂给
 * `agentDayReview`(早报正文那四段的那一处),已完成 / 推进中 / 卡点 / 下一步四段都要有东西。
 * 样例表一改(少一件交回来的、少一件卡住的)这几条当场红。
 *
 * 看板与任务账用的是**真东西**:`createTasksService`(临时文件)与 `createJobLog`(内存 io),
 * 所以七态转换、`done_at` 盖章、落盘体检都照真跑 —— 不拿假 store 糊过去。
 * 模型一次都不问(四段走程序排的那一份)。
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { TaskStatus, TaskView } from '../src/protocol.ts'
import { publishPlanDescParts } from '../src/protocol.ts'
import { todayTodosOf } from '../src/todayTodos.ts'
import {
  DAY_REVIEW_SECTION_HEADS,
  dayReviewFacts,
  dayReviewLines,
  dayReviewSectionsByProgram,
  dayReviewWindow,
} from '../src/server/agentDayReview.ts'
import {
  DEMO_AGENT_RECORDS,
  DEMO_BOARD_ITEMS,
  DEMO_MEETING_SAID,
  DEMO_MORNING_NO_ROUTINE,
  DEMO_PUBLISH_PLANS,
  DEMO_SOURCE,
  DEMO_SPAN_MINUTES,
  DEMO_TAG,
  clearDemoData,
  demoDayOf,
  demoRecordAt,
  seedDemoData,
} from '../src/server/demoSeed.ts'
import type { DemoSeedDeps } from '../src/server/demoSeed.ts'
import { drivable } from '../src/server/itemDriver.ts'
import { createJobLog } from '../src/server/jobLog.ts'
import type { JobEvent } from '../src/server/jobLog.ts'
import { draftMeetingPlan } from '../src/server/meetingPrep.ts'
import { createTasksService } from '../src/server/tasks.ts'

const NOW = Date.parse('2026-10-13T18:20:00.000+08:00')

const dirs: string[] = []
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop() as string, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
})

function harness(options: { lastMorningAt?: string, withMeeting?: boolean, withRoutine?: boolean } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'wb-demo-seed-'))
  dirs.push(dir)
  const tasks = createTasksService({ file: join(dir, 'tasks.json'), now: () => Math.floor(NOW / 1000) })
  const events: JobEvent[] = []
  const log = createJobLog({ now: () => new Date(NOW) })
  const meetings: { title: string, date: string }[] = []
  const planned: string[] = []
  const mornings: number[] = []
  const deps: DemoSeedDeps = {
    now: () => NOW,
    ...(options.lastMorningAt === undefined ? {} : { lastMorningAt: () => options.lastMorningAt }),
    tasks: {
      list: async () => (await tasks.list()).tasks,
      create: input => tasks.create(input),
      move: (id, status) => tasks.move(id, status),
      update: (id, input) => tasks.update(id, input),
    },
    appendJob: (event) => { events.push(log.append(event)) },
    ...(options.withMeeting === false
      ? {}
      : {
          planMeeting: async (text) => {
            planned.push(text)
            const draft = draftMeetingPlan(text, NOW)
            meetings.push({ title: draft.title, date: draft.date })
            return { ok: true, title: draft.title }
          },
          listMeetings: async () => [...meetings],
          draftMeetingTitle: (said, nowMs) => draftMeetingPlan(said, nowMs),
        }),
    ...(options.withRoutine === false ? {} : { runMorning: async () => { mornings.push(NOW); return { ok: true } } }),
  }
  return {
    deps,
    events,
    planned,
    mornings,
    meetings,
    list: async (): Promise<readonly TaskView[]> => (await tasks.list()).tasks,
  }
}

/** 放进去的那几张卡 + 任务账 → 早报四段(程序排的那一份,一次模型都不问)。 */
function sections(tasks: readonly TaskView[], events: readonly JobEvent[], lastMorningAt?: string) {
  const today = demoDayOf(NOW, 0)
  const window = dayReviewWindow(NOW, lastMorningAt)
  const facts = dayReviewFacts({ ...window, tasks, jobEvents: events, today_todos: todayTodosOf(tasks, today) })
  return { facts, made: dayReviewSectionsByProgram(facts) }
}

describe('放一套演示数据:照真实路径放,全部标着「演示用」', () => {
  it('★ 看板事项 / Agent 记录 / 发布计划 / 今天那场会都放进去了,每张卡都带记号', async () => {
    const h = harness()
    const report = await seedDemoData(h.deps)
    const tasks = await h.list()

    expect(tasks).toHaveLength(DEMO_BOARD_ITEMS.length + DEMO_AGENT_RECORDS.length + DEMO_PUBLISH_PLANS.length)
    expect(tasks.every(one => one.demo === true)).toBe(true)
    // 人看得见的那一半在 desc 第一段里(卡片与发布计划悬浮读的就是它)
    expect(tasks.every(one => (one.desc ?? '').includes(DEMO_TAG))).toBe(true)
    // 卡是按七态表一格一格挪过去的,所以每一格都停在样例写的那一格
    const statusOf = (title: string): TaskStatus | undefined => tasks.find(one => one.title === title)?.status
    for (const item of DEMO_BOARD_ITEMS) expect(statusOf(item.title)).toBe(item.status)
    for (const one of DEMO_AGENT_RECORDS) expect(statusOf(one.title)).toBe(one.status)
    // 办完那一张真的盖了章(move 走的是真路)
    expect(tasks.find(one => one.status === 'done')?.done_at).toBe(new Date(NOW).toISOString())
    // 那一场会走的是 meeting.plan,句子原样交出去
    expect(h.planned).toEqual([DEMO_MEETING_SAID])
    expect(report.lines.filter(one => one.group === 'meeting')).toHaveLength(1)
    expect(report.jobs).toBe(DEMO_AGENT_RECORDS.reduce((sum, one) => sum + one.marks.length, 0))
  })

  it('带日期的事项:今天 / 明天 / 更晚三组都有东西(今天至少 4 条还没办的)', async () => {
    const h = harness()
    await seedDemoData(h.deps)
    const view = todayTodosOf(await h.list(), demoDayOf(NOW, 0))
    const group = (key: string) => view.groups?.find(one => one.key === key)?.items ?? []
    expect(group('today').filter(one => !one.done).length).toBeGreaterThanOrEqual(4)
    expect(group('today').some(one => one.done)).toBe(true)
    expect(group('tomorrow').length).toBeGreaterThanOrEqual(2)
    expect(group('later').length).toBeGreaterThanOrEqual(2)
    // 选题(发布计划那三条)一条都不进这一格 —— 它们按 planned_at 在月历里
    const titles = [...group('today'), ...group('tomorrow'), ...group('later')].map(one => one.title)
    for (const plan of DEMO_PUBLISH_PLANS) expect(titles).not.toContain(plan.title)
  })

  it('发布计划那三条:选题卡 + planned_at 落在未来几天,悬浮上去有原话与「演示数据」那一行', async () => {
    const h = harness()
    await seedDemoData(h.deps)
    const tasks = await h.list()
    for (const plan of DEMO_PUBLISH_PLANS) {
      const card = tasks.find(one => one.title === plan.title)
      expect(card?.kind).toBe('topic')
      expect(card?.content_type).toBe(plan.contentType)
      expect(card?.planned_at).toBe(demoDayOf(NOW, plan.plannedDays))
      expect(card?.published_at).toBeUndefined()
      const parts = publishPlanDescParts(card?.desc)
      expect(parts.said).toContain(DEMO_TAG)
      expect(parts.source).toContain(DEMO_SOURCE)
    }
  })

  it('今天下午那一场会:标题与日子由登记那句话切出来,落在今天', () => {
    const draft = draftMeetingPlan(DEMO_MEETING_SAID, NOW)
    expect(draft.date).toBe(demoDayOf(NOW, 0))
    expect(draft.title).not.toBe('')
    expect(DEMO_MEETING_SAID).toContain(draft.title)
    expect(draft.prep.scheduled_at).not.toBeUndefined()
  })
})

describe('★ 放完早报那四段真的出得来', () => {
  it('已完成 2、推进中 2、卡点 1、下一步若干;推进中写得出「做到哪」', async () => {
    const h = harness()
    await seedDemoData(h.deps)
    const { made } = sections(await h.list(), h.events)

    expect(made.done).toHaveLength(2)
    expect(made.in_progress).toHaveLength(2)
    expect(made.blocked).toHaveLength(1)
    expect(made.next.length).toBeGreaterThanOrEqual(3)
    // 两种完成依据各一件:那家交回来了 / 她自己把卡收了
    expect(made.done.some(one => one.line.includes('交回来了'))).toBe(true)
    expect(made.done.some(one => one.line.includes('办完'))).toBe(true)
    // 推进中那一句是具体的(规范 §6),不是「送出去了,还没回话」
    expect(made.in_progress.some(one => one.line.includes('挑了 6 首备选'))).toBe(true)
    expect(made.in_progress.some(one => one.line.includes('筛到 6 个方向'))).toBe(true)
    // 卡点说清卡在哪 + 要不要外部条件
    expect(made.blocked[0]?.line).toContain('读不到')
    expect(made.blocked[0]?.line).toContain('重派')
    // 四段都渲染进早报正文
    const lines = dayReviewLines(made).join('\n')
    for (const head of Object.values(DAY_REVIEW_SECTION_HEADS)) expect(lines).toContain(head)
  })

  it('同一条片子那三件归在一起(并条的素材):头三件标题同一个前缀', () => {
    const camping = DEMO_AGENT_RECORDS.filter(one => one.title.startsWith('露营短片:'))
    expect(camping.length).toBeGreaterThanOrEqual(3)
  })

  it('上次早报就在三分钟前:记录整段压进那之后,四段照样出得来', async () => {
    const lastMorningAt = new Date(NOW - 3 * 60_000).toISOString()
    const h = harness({ lastMorningAt })
    await seedDemoData(h.deps)
    const since = Date.parse(dayReviewWindow(NOW, lastMorningAt).since)
    for (const event of h.events) expect(Date.parse(event.at)).toBeGreaterThan(since)
    const { made } = sections(await h.list(), h.events, lastMorningAt)
    expect(made.done).toHaveLength(2)
    expect(made.in_progress).toHaveLength(2)
    expect(made.blocked).toHaveLength(1)
  })

  it('没跑过早报(窗口按 24 小时退):记录按名义的分钟数摆,最老的那一条正好在四小时前', () => {
    expect(demoRecordAt(NOW, undefined, DEMO_SPAN_MINUTES)).toBe(new Date(NOW - DEMO_SPAN_MINUTES * 60_000).toISOString())
    expect(demoRecordAt(NOW, undefined, 0)).toBe(new Date(NOW).toISOString())
    // 上次早报比四小时前还早 → 不压缩(以名义位置为准)
    expect(demoRecordAt(NOW, new Date(NOW - 20 * 3_600_000).toISOString(), 60)).toBe(new Date(NOW - 60 * 60_000).toISOString())
  })
})

describe('重复点、清掉、说实话', () => {
  it('再放一次:卡不重建(说跳过了),但那几条记录重记一套 —— 窗口往前走了', async () => {
    const h = harness()
    await seedDemoData(h.deps)
    const first = (await h.list()).length
    const jobs = h.events.length
    const again = await seedDemoData(h.deps)
    expect((await h.list()).length).toBe(first)
    expect(again.lines.filter(one => one.skipped === true).length).toBe(again.lines.length)
    expect(h.events.length).toBe(jobs * 2)
  })

  it('清掉:只动带记号的卡,全挪进「取消」(连办完那一张也挪得动);月历与待办跟着空', async () => {
    const h = harness()
    await seedDemoData(h.deps)
    const cleared = await clearDemoData(h.deps)
    const tasks = await h.list()
    expect(cleared.canceled).toBe(tasks.length)
    expect(cleared.failed).toHaveLength(0)
    expect(tasks.every(one => one.status === 'canceled')).toBe(true)
    expect(todayTodosOf(tasks, demoDayOf(NOW, 0)).items).toHaveLength(0)
    // 取消掉的不进早报四段(dayReviewFacts 第一道就排掉它们)
    const { made } = sections(tasks, h.events)
    expect(dayReviewLines(made)).toHaveLength(0)
    // 账与会删不掉,如实说
    expect(cleared.note).toContain('只追加')
    expect(cleared.note).toContain('会议')
  })

  it('清过之后再放一次,照样放得进(取消掉的不算「已经有了」)', async () => {
    const h = harness()
    await seedDemoData(h.deps)
    await clearDemoData(h.deps)
    const again = await seedDemoData(h.deps)
    // 卡都重新放了一遍;**那一场会照旧跳过** —— 会议模式里没有删除的路,它还在(清掉那一下也这么说)
    expect(again.lines.filter(one => one.group !== 'meeting').some(one => one.skipped === true)).toBe(false)
    expect(again.lines.find(one => one.group === 'meeting')?.skipped).toBe(true)
    const live = (await h.list()).filter(one => one.status !== 'canceled')
    expect(live).toHaveLength(DEMO_BOARD_ITEMS.length + DEMO_AGENT_RECORDS.length + DEMO_PUBLISH_PLANS.length)
  })

  it('同一天同一场会已经有了就不登记第二场', async () => {
    const h = harness()
    await seedDemoData(h.deps)
    const again = await seedDemoData(h.deps)
    expect(h.planned).toHaveLength(1)
    expect(again.lines.find(one => one.group === 'meeting')?.skipped).toBe(true)
  })

  it('放完顺手跑一遍早报;没接例程就如实说让她自己点', async () => {
    const h = harness()
    const report = await seedDemoData(h.deps)
    expect(h.mornings).toHaveLength(1)
    expect(report.morning).toContain('早报')
    const bare = harness({ withRoutine: false })
    expect((await seedDemoData(bare.deps)).morning).toBe(DEMO_MORNING_NO_ROUTINE)
  })

  it('没接会议模式 / 没接例程都不连累别的:卡照样放进去,那两行如实说', async () => {
    const h = harness({ withMeeting: false, withRoutine: false })
    const report = await seedDemoData(h.deps)
    expect((await h.list()).length).toBe(DEMO_BOARD_ITEMS.length + DEMO_AGENT_RECORDS.length + DEMO_PUBLISH_PLANS.length)
    expect(report.lines.find(one => one.group === 'meeting')?.note).toContain('没接会议模式')
  })

  it('★ 放进去的卡一张都不会被负责人驱动真派出去(只写记录)', async () => {
    const h = harness()
    await seedDemoData(h.deps)
    for (const task of await h.list()) expect(drivable(task)).toBe(false)
  })

  it('演示文案:虚构、没有凭据、不写真人真公司', () => {
    const texts = [
      ...DEMO_BOARD_ITEMS.flatMap(one => [one.title, one.desc]),
      ...DEMO_AGENT_RECORDS.flatMap(one => [one.title, one.desc, one.blurb]),
      ...DEMO_PUBLISH_PLANS.map(one => one.title),
      DEMO_MEETING_SAID,
    ]
    for (const text of texts) {
      expect(text).not.toMatch(/[\w.]+@[\w.]+/)
      expect(text).not.toMatch(/\d{6,}/)
      expect(text).not.toMatch(/微信|手机号|邮箱|密码|密钥|token|api[ -]?key/i)
      // 公司 / 有限公司 / 某某总 这类抬头一个都不许有(「品牌方」是通称,照 meetingDemoCases 的口径)
      expect(text).not.toMatch(/公司|集团|总监|老板/)
    }
  })
})
