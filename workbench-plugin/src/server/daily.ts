/**
 * 日结生成(PRD 5.7;2026-09-02 Ben 拍板:每天早 9 点生成**昨天**的,与晨间回顾合流)。
 *
 * v1 是**数据驱动的如实汇总**,不做 AI 撰写——四段素材全部可验证:
 * - 推进了什么:昨日各仓库的 git 提交数(countCommits 现查)+ 用量按天的项目消耗;
 * - 什么没发生(PRD 必填):零提交零用量的在册项目线;全动了就写一句如实说明顶上;
 * - 新点子:created_at 落在昨天的随手记原文;
 * - 提议:提议系统(M5)未上线,固定一句如实说明,不留空也不编造(D13)。
 *
 * 触发是**请求驱动**的:view() 发现"本地时刻已过 9 点且还没有昨天的报告"才在后台
 * 生成一次(single-flight),/state 永远只拿现成的——git 采集哪怕只有一次也不许挂在
 * 请求路径上,教训见 0831 风暴(projectsService 的 stale-while-revalidate 同款纪律)。
 * 落盘 ~/.dsh/workbench/daily.json(原子写+容错读,与 dock.json/notes.json 同规格),
 * 重启不重新采集。
 */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { DailyReport, NoteView, UsageDay } from '../protocol.ts'
import { localDateStr } from './brief.ts'
import type { BudgetStopRecord } from './budgetPolicy.ts'
import { budgetRepeatLine } from './budgetPolicy.ts'

export interface DailyServiceOptions {
  file: string
  /** 当前时刻(ms)。默认 Date.now——测试注入固定时钟。 */
  now?: () => number
  /** 用量按天投影(collector 的 view().days);用量模块没接/失败时给 undefined。 */
  usageDays: () => readonly UsageDay[] | undefined
  listNotes: () => Promise<readonly NoteView[]>
  /** 在册项目线:项目区同一批扫描根下发现的仓库路径。 */
  listRepos: () => Promise<readonly string[]>
  /** 数一个仓库在 [sinceIso, untilIso) 的提交数;查不了(不是 git 仓库/git 失败)回 undefined。 */
  countCommits: (repoPath: string, sinceIso: string, untilIso: string) => Promise<number | undefined>
  /** 本地几点起允许生成,默认 9。 */
  generateAfterHour?: number
  /**
   * 昨天 DeepSeek 的消耗账本(2026-09-09,峰谷分账)。素材是余额采样差分按时段记的账,
   * 落盘在 quota/spendLedger.ts。**不接、或那天没记过,这一节就整个缺席**——
   * 不写 0,也不拿今天的数顶昨天的位(D13:拿不到就留空,绝不编数)。
   */
  deepseekSpend?: (date: string) => { spent?: string, peak?: string, offpeak?: string } | undefined
  /**
   * 那天**撞上限停下来问她**的那几条(2026-10-04,卡「事务官上限只看钱」第 3 条)。
   *
   * 素材是现成的那本任务账(`jobLog.ts` 的 `budget_stop`),**不另起一个数据库**;
   * 同一类事撞线 ≥ 3 次才在「什么没发生 / 被绕开」那一节多一句「这类事常撞线,缺一个正规做法」
   * (`budgetPolicy.budgetRepeatLine`)。**不自动调高线。**
   *
   * 不接、或那天一条都没撞 → 那一句整句缺席(不写「今天没撞线」)。
   */
  budgetStops?: (date: string) => readonly BudgetStopRecord[] | undefined
}

export interface DailyService {
  view(): Promise<DailyReport | undefined>
}

export function defaultDailyFile(home = process.env.HOME ?? ''): string {
  return `${home}/.dsh/workbench/daily.json`
}

interface DailyFile { version: 1, report: DailyReport }

async function loadDailyFile(file: string): Promise<DailyReport | undefined> {
  try {
    const parsed = JSON.parse(await readFile(file, 'utf8')) as DailyFile
    if (parsed?.version !== 1 || typeof parsed.report?.date !== 'string') return undefined
    return parsed.report
  }
  catch {
    return undefined // 不存在/写坏了按"没有"兜底,先例见 notes.ts loadNotesFile。
  }
}

async function saveDailyFile(file: string, report: DailyReport): Promise<void> {
  await mkdir(dirname(file), { recursive: true })
  const tmp = `${file}.${randomUUID()}.tmp`
  await writeFile(tmp, `${JSON.stringify({ version: 1, report } satisfies DailyFile, null, 2)}\n`, 'utf8')
  await rename(tmp, file)
}

/** 与 UsagePanel.formatTokens 同款量级收整;这里独立实现,server 不 import client。 */
function formatTokens(value: number): string {
  if (value >= 1e9) return `${(value / 1e9).toFixed(1)}B`
  if (value >= 1e6) return `${(value / 1e6).toFixed(1)}M`
  if (value >= 1e3) return `${(value / 1e3).toFixed(1)}K`
  return String(Math.round(value))
}

function repoName(path: string): string {
  return path.split('/').filter(Boolean).at(-1) ?? path
}

export function createDailyService(opts: DailyServiceOptions): DailyService {
  const now = opts.now ?? (() => Date.now())
  const generateAfterHour = opts.generateAfterHour ?? 9

  let cache: DailyReport | undefined
  let loaded = false
  let inFlight: Promise<void> | undefined
  /** 上次生成失败的时刻(ms):失败后冷却一分钟再试,别让 1 秒轮询把 git 采集打成风暴。 */
  let lastFailAt = 0
  const FAIL_COOLDOWN_MS = 60_000

  async function generate(reportDate: string, todayDate: string): Promise<void> {
    const sinceIso = `${reportDate}T00:00:00`
    const untilIso = `${todayDate}T00:00:00`

    const repos = await opts.listRepos()
    const commitCounts = await Promise.all(repos.map(async repo => ({
      repo,
      count: await opts.countCommits(repo, sinceIso, untilIso),
    })))

    const day = (opts.usageDays() ?? []).find(d => d.date === reportDate)
    const usageByProject = new Map<string, number>()
    for (const [name, totals] of Object.entries(day?.by_project ?? {})) {
      const billed = totals.input + totals.output
      if (billed > 0) usageByProject.set(name, billed)
    }

    // 推进:有提交或有用量的项目各一行,提交靠前(它是"真的落了东西"的证据)。
    const progress: string[] = []
    const covered = new Set<string>()
    for (const { repo, count } of commitCounts) {
      const name = repoName(repo)
      const billed = usageByProject.get(name)
      if ((count ?? 0) === 0 && billed === undefined) continue
      covered.add(name)
      const parts: string[] = []
      if ((count ?? 0) > 0) parts.push(`${count} 次提交`)
      if (billed !== undefined) parts.push(`用量 ${formatTokens(billed)}(入+出)`)
      progress.push(`${name}:${parts.join(' · ')}`)
    }
    // 不在扫描根里但有用量的项目(比如 worktree 归拢名)也算推进,不吞。
    for (const [name, billed] of usageByProject) {
      if (covered.has(name)) continue
      progress.push(`${name}:用量 ${formatTokens(billed)}(入+出)`)
    }
    if (progress.length === 0) progress.push('昨天没有任何提交和用量记录')

    // 什么没发生(必填):零提交零用量的在册仓库点名;全动了也要有一句,不许空。
    const missing = commitCounts
      .filter(({ repo, count }) => (count ?? 0) === 0 && !usageByProject.has(repoName(repo)))
      .map(({ repo }) => `${repoName(repo)}:零提交零用量`)
    if (missing.length === 0) missing.push('在册项目线昨天全都有动静')
    /*
     * ★ 同一类事反复撞上限(2026-10-04 第 3 条)。这一节本来就是「什么没发生 / 被绕开」——
     * 一类事天天停在上限上,就是那一类**缺一个正规做法**,不是她该一次次点「继续」。
     * 读不到那本账、或那天没撞够次数 → 这一句整句缺席(不写「今天没撞线」)。
     */
    try {
      const repeat = budgetRepeatLine(opts.budgetStops?.(reportDate) ?? [])
      if (repeat !== undefined) missing.push(repeat)
    }
    catch { /* 账读不了只少这一句,不拦整份报告(同随手记那条降级) */ }

    let ideas: string[] = []
    try {
      ideas = (await opts.listNotes())
        .filter(note => localDateStr(Date.parse(note.created_at)) === reportDate)
        .map(note => note.text)
    }
    catch {
      ideas = [] // 随手记读不了只影响这一段,不拦整份报告。
    }

    // 峰谷两笔:读不到就整节缺席。读出错也只丢这一节,不拦整份报告(同随手记那条降级)。
    let deepseekSpend: DailyReport['deepseek_spend']
    try {
      const ledger = opts.deepseekSpend?.(reportDate)
      if (ledger !== undefined && (ledger.spent !== undefined || ledger.peak !== undefined || ledger.offpeak !== undefined)) {
        deepseekSpend = {
          ...(ledger.spent === undefined ? {} : { total: ledger.spent }),
          ...(ledger.peak === undefined ? {} : { peak: ledger.peak }),
          ...(ledger.offpeak === undefined ? {} : { offpeak: ledger.offpeak }),
        }
      }
    }
    catch {
      deepseekSpend = undefined
    }

    const report: DailyReport = {
      date: reportDate,
      generated_at: new Date(now()).toISOString(),
      progress,
      missing,
      ideas,
      proposals: ['提议系统(M5)未上线,本节暂空'],
      ...(deepseekSpend === undefined ? {} : { deepseek_spend: deepseekSpend }),
    }
    await saveDailyFile(opts.file, report)
    cache = report
  }

  return {
    async view(): Promise<DailyReport | undefined> {
      if (!loaded) {
        cache = await loadDailyFile(opts.file)
        loaded = true
      }
      const nowMs = now()
      const todayDate = localDateStr(nowMs)
      const reportDate = localDateStr(nowMs - 86_400_000)
      const due = new Date(nowMs).getHours() >= generateAfterHour
        && cache?.date !== reportDate
        && nowMs - lastFailAt >= FAIL_COOLDOWN_MS
      if (due && inFlight === undefined) {
        inFlight = generate(reportDate, todayDate)
          .catch(() => { lastFailAt = now() }) // 失败这轮作罢,旧报告(或空)顶着,冷却后再试。
          .finally(() => { inFlight = undefined })
      }
      return cache
    },
  }
}
