/**
 * 预案卡的事实表从哪来(2026-10-10,卡「会前画像与预案」):**只读她工作目录与看板里已有的**。
 *
 * - 账号数据:小红书创作者数据(xhs 服务那份快照,页面上原样那串)、`账号/<名>/笔记/` 篇数、`账号/<名>/目标.md`;
 * - 复盘:`选题/<名>/复盘.md` 里最后一节自评分;
 * - 选题池与看板:`tasks.json`。
 *
 * 读不到的一样就缺席,不补一个数。拼句子、编号在 meetingPrep.ts 的 meetingFactsOf。
 */
import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import type { TaskView, XhsView } from '../protocol.ts'
import { accountsDir, listAccountNames, readAccountGoal, readAccountNotes } from './accounts.ts'
import { meetingFactsOf, type MeetingFact, type MeetingFactsInput } from './meetingPrep.ts'

export interface MeetingFactsDeps {
  workdir: () => string | undefined
  /** `<工作目录>/选题`。 */
  topicsDir: () => string | undefined
  xhs?: () => XhsView | undefined
  tasks?: () => Promise<readonly TaskView[]>
  now?: () => number
}

const REVIEW_SCORE = /-\s*\*\*自评分\*\*[::]\s*(\d\/5)/g
const REVIEW_DATE = /##\s*自评[((]([^))]+)[))]/g

/** 一个账号的目标 → 一句话(只照抄目标.md 里写的数)。 */
function goalLine(goal: { period?: { from: string, to: string }, notes_target?: number, fans_target?: number, fans_start?: number }): string {
  const parts = [
    goal.fans_target === undefined ? '' : `粉丝涨到 ${goal.fans_target}${goal.fans_start === undefined ? '' : `(起点 ${goal.fans_start})`}`,
    goal.notes_target === undefined ? '' : `发 ${goal.notes_target} 篇笔记`,
  ].filter(part => part !== '')
  if (parts.length === 0) return ''
  return `${goal.period === undefined ? '' : `${goal.period.from} 到 ${goal.period.to} `}${parts.join('、')}`
}

export function createMeetingFacts(deps: MeetingFactsDeps): (keywords: readonly string[]) => Promise<MeetingFact[]> {
  return async (keywords) => {
    const now = deps.now?.() ?? Date.now()
    const input: { -readonly [K in keyof MeetingFactsInput]: MeetingFactsInput[K] } = { now, keywords }

    const view = (() => { try { return deps.xhs?.() } catch { return undefined } })()
    if (view !== undefined) {
      input.xhs = view.accounts.map(account => ({
        name: account.name,
        ranges: account.ranges.map(range => ({ range: range.range, date: range.date, metrics: range.metrics.map(m => ({ label: m.label, ...(m.raw === undefined ? {} : { raw: m.raw }) })) })),
      }))
    }

    const workdir = deps.workdir()
    if (workdir !== undefined && workdir !== '') {
      const root = accountsDir(workdir)
      const names = await listAccountNames(root).catch(() => [] as string[])
      const accounts: { name: string, notes?: number, goal?: string }[] = []
      for (const name of names) {
        const notes = await readAccountNotes(join(root, name)).catch(() => undefined)
        const goal = await readAccountGoal(join(root, name)).catch(() => undefined)
        const line = goal?.exists === true && goal.goal !== undefined ? goalLine(goal.goal) : ''
        accounts.push({ name, ...(notes === undefined ? {} : { notes: notes.count }), ...(line === '' ? {} : { goal: line }) })
      }
      input.accounts = accounts
    }

    const topicsDir = deps.topicsDir()
    if (topicsDir !== undefined && topicsDir !== '') {
      const reviews: { topic: string, line: string, date?: string }[] = []
      const topics = await readdir(topicsDir).catch(() => [] as string[])
      for (const topic of topics) {
        if (topic.startsWith('.')) continue
        const text = await readFile(join(topicsDir, topic, '复盘.md'), 'utf8').catch(() => undefined)
        if (text === undefined) continue
        const scores = [...text.matchAll(REVIEW_SCORE)]
        const last = scores[scores.length - 1]?.[1]
        if (last === undefined) continue
        const dates = [...text.matchAll(REVIEW_DATE)]
        const date = dates[dates.length - 1]?.[1]
        reviews.push({ topic, line: `自评分 ${last}`, ...(date === undefined ? {} : { date }) })
      }
      input.reviews = reviews
    }

    if (deps.tasks !== undefined) input.tasks = await deps.tasks().catch(() => [])
    return meetingFactsOf(input)
  }
}
