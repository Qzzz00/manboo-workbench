// @vitest-environment node
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { DailyReport, UsageDay } from '../src/protocol.ts'
import { createDailyService, defaultDailyFile } from '../src/server/daily.ts'

const dirs: string[] = []
afterEach(() => { while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }) })
function tempFile(): string {
  const dir = mkdtempSync(join(tmpdir(), 'wb-daily-'))
  dirs.push(dir)
  return join(dir, 'daily.json')
}

/** 2026-09-02(周三)10:00 本地时刻,报告对象日是 09-01。 */
const AT_10AM = Date.parse('2026-09-02T10:00:00+08:00')
const AT_8AM = Date.parse('2026-09-02T08:00:00+08:00')

/** 生成在后台跑(不许拖住 /state,先例见 projectsService 的 stale-while-revalidate),
 *  测试用限时轮询等它落地——同款纪律先例见 server-projects.test.ts。 */
async function viewUntilReady(
  svc: { view: () => Promise<DailyReport | undefined> },
  ms = 1000,
): Promise<DailyReport> {
  const deadline = Date.now() + ms
  for (;;) {
    const report = await svc.view()
    if (report !== undefined) return report
    if (Date.now() > deadline) throw new Error('日结没有在期限内生成出来')
    await new Promise(resolve => setTimeout(resolve, 10))
  }
}

function usageDay(date: string, byProject: Record<string, { input: number, output: number }>): UsageDay {
  const projects: UsageDay['by_project'] = {}
  for (const [name, t] of Object.entries(byProject)) {
    projects[name] = { input: t.input, output: t.output, cache_read: 0, cache_write: 0 }
  }
  return { date, by_project: projects, by_model: {}, by_source: {}, sessions: 2, messages: 9, hour_counts: {} }
}

function makeService(over: Partial<Parameters<typeof createDailyService>[0]> = {}) {
  return createDailyService({
    file: tempFile(),
    now: () => AT_10AM,
    usageDays: () => [usageDay('2026-09-01', { Aiboo: { input: 22_000_000, output: 3_000_000 } })],
    listNotes: async () => [
      { id: 'n1', text: '想给展示台加个温度计', created_at: '2026-09-01T12:00:00+08:00' },
      { id: 'n2', text: '今天的点子不算昨天的', created_at: '2026-09-02T09:30:00+08:00' },
    ],
    listRepos: async () => ['/gh/Aiboo', '/gh/Echo'],
    countCommits: async (repo: string) => (repo === '/gh/Aiboo' ? 5 : 0),
    ...over,
  })
}

describe('日结 v1(2026-09-02 Ben 拍板:早 9 点生成昨天的;PRD 5.7 四段,数据驱动不编造)', () => {
  it('defaultDailyFile 落在 ~/.dsh/workbench/daily.json', () => {
    expect(defaultDailyFile('/Users/example')).toBe('/Users/example/.dsh/workbench/daily.json')
  })

  it('9 点后首次查看触发生成昨日报告:四段齐全,「什么没发生」非空(PRD 必填)', async () => {
    const svc = makeService()
    const report = await viewUntilReady(svc)
    expect(report.date).toBe('2026-09-01')
    // 推进:有提交或有用量的项目各占一行
    expect(report.progress.join('\n')).toContain('Aiboo')
    expect(report.progress.join('\n')).toContain('5 次提交')
    // 没发生(必填):Echo 零提交零用量,必须点名
    expect(report.missing.join('\n')).toContain('Echo')
    // 新点子:只收昨天的随手记,今天的不算
    expect(report.ideas).toEqual(['想给展示台加个温度计'])
    // 提议:系统未上线,如实说,不留空
    expect(report.proposals.length).toBeGreaterThan(0)
  })

  it('都动了的时候「什么没发生」也不为空——用一句如实的说明顶上(必填不许空)', async () => {
    const svc = makeService({
      listRepos: async () => ['/gh/Aiboo'],
      countCommits: async () => 3,
    })
    const report = await viewUntilReady(svc)
    expect(report.missing.length).toBeGreaterThan(0)
  })

  it('9 点前不生成;9 点后生成的旧报告在次日 9 点前照常返回', async () => {
    const file = tempFile()
    const base = {
      usageDays: () => [] as UsageDay[],
      listNotes: async () => [],
      listRepos: async () => [] as string[],
      countCommits: async () => 0,
    }
    const early = createDailyService({ file, now: () => AT_8AM, ...base })
    expect(await early.view()).toBeUndefined()
    await new Promise(resolve => setTimeout(resolve, 30))
    expect(await early.view()).toBeUndefined() // 8 点就是不生成,不是"还没轮到"

    const at10 = createDailyService({ file, now: () => AT_10AM, ...base })
    expect((await viewUntilReady(at10)).date).toBe('2026-09-01')

    const nextMorning = createDailyService({ file, now: () => Date.parse('2026-09-03T08:00:00+08:00'), ...base })
    expect((await nextMorning.view())?.date).toBe('2026-09-01') // 旧的先顶着,9 点后才换
  })

  it('生成落盘且当日只跑一次素材采集:重建服务读同一文件,不重新跑 git', async () => {
    const file = tempFile()
    let gitCalls = 0
    const opts = {
      file,
      now: () => AT_10AM,
      usageDays: () => [] as UsageDay[],
      listNotes: async () => [],
      listRepos: async () => ['/gh/Aiboo'],
      countCommits: async () => { gitCalls += 1; return 1 },
    }
    const first = createDailyService(opts)
    await viewUntilReady(first)
    const callsAfterGenerate = gitCalls
    const second = createDailyService(opts)
    expect((await second.view())?.date).toBe('2026-09-01')
    expect(gitCalls).toBe(callsAfterGenerate) // 已有昨日报告,重建实例不再采集
  })
})

describe('日结把 DeepSeek 当日消耗按峰谷分两笔(2026-09-09)', () => {
  it('账簿里有昨天的记录:总数与两笔都进报告', async () => {
    const svc = makeService({
      deepseekSpend: (date: string) => (date === '2026-09-01'
        ? { spent: '12.60', peak: '9.00', offpeak: '3.60' }
        : undefined),
    })
    const report = await viewUntilReady(svc)
    expect(report.deepseek_spend).toEqual({ total: '12.60', peak: '9.00', offpeak: '3.60' })
  })

  it('账簿里没有昨天:整节缺席,不写 0(那天没采到就是没采到)', async () => {
    const svc = makeService({ deepseekSpend: () => undefined })
    const report = await viewUntilReady(svc)
    expect(report.deepseek_spend).toBeUndefined()
  })

  it('没接账簿也照常出报告——分账是附加信息,不该拦住日结本身', async () => {
    const report = await viewUntilReady(makeService())
    expect(report.progress.length).toBeGreaterThan(0)
    expect(report.deepseek_spend).toBeUndefined()
  })

  it('只有总数、分不出时段时:总数照报,两笔缺席', async () => {
    const svc = makeService({ deepseekSpend: () => ({ spent: '12.60' }) })
    const report = await viewUntilReady(svc)
    expect(report.deepseek_spend).toEqual({ total: '12.60' })
  })

  it('账簿读出错不拦报告(与随手记同一条降级纪律)', async () => {
    const svc = makeService({ deepseekSpend: () => { throw new Error('账簿坏了') } })
    const report = await viewUntilReady(svc)
    expect(report.deepseek_spend).toBeUndefined()
    expect(report.missing.length).toBeGreaterThan(0)
  })
})

/**
 * ★ **同一类事反复撞上限,日结里提一句**(2026-10-04,卡「事务官上限只看钱」第 3 条)。
 *
 * 维护者:「同一类事反复撞线,在日结 / 早报里提一句『这类事常撞线,缺一个正规做法』。不自动调高线。」
 * 素材是现成的那本任务账(`jobLog.ts` 的 `budget_stop`),这里只钉日结这一侧:接上就多一句、
 * 不够次数 / 没接上就**整句缺席**(不写「今天没撞线」),而且读账出错只少这一句、不拦整份报告。
 */
describe('★ 日结:同一类事反复撞上限提一句(卡「事务官上限只看钱」)', () => {
  it('撞够 3 次 → 「什么没发生 / 被绕开」那一节多一句', async () => {
    const report = await viewUntilReady(makeService({
      budgetStops: date => (date === '2026-09-01' ? [{ kind: 'desk' }, { kind: 'desk' }, { kind: 'desk' }] : []),
    }))
    expect(report.missing.some(one => one.includes('这类事常撞线,缺一个正规做法'))).toBe(true)
    expect(report.missing.some(one => one.includes('要在你电脑上动手'))).toBe(true)
  })

  it('只按报告对象日那天数(今天撞的不算昨天的)', async () => {
    const report = await viewUntilReady(makeService({
      budgetStops: date => (date === '2026-09-02' ? [{ kind: 'desk' }, { kind: 'desk' }, { kind: 'desk' }] : []),
    }))
    expect(report.missing.some(one => one.includes('常撞线'))).toBe(false)
  })

  it('不够次数 / 没接那本账 → 整句缺席(不写「今天没撞线」)', async () => {
    const few = await viewUntilReady(makeService({ budgetStops: () => [{ kind: 'desk' }, { kind: 'desk' }] }))
    expect(few.missing.some(one => one.includes('撞线'))).toBe(false)
    const none = await viewUntilReady(makeService())
    expect(none.missing.some(one => one.includes('撞线'))).toBe(false)
    // 「什么没发生」那一节照旧必填(这一句缺席不会把它弄空)。
    expect(none.missing.length).toBeGreaterThan(0)
  })

  it('读那本账抛了只少这一句,不拦整份报告', async () => {
    const report = await viewUntilReady(makeService({ budgetStops: () => { throw new Error('账读不了') } }))
    expect(report.missing.length).toBeGreaterThan(0)
    expect(report.progress.length).toBeGreaterThan(0)
  })
})
