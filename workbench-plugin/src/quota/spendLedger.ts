/**
 * 今日消耗账本的落盘(2026-09-09)。
 *
 * 账本本身(dailySpend.ts)是纯函数 + 采集循环内存里的一个变量:跨天清零、重启即失。
 * 那对"今日消耗"够用,对**日结**不够——日结早 9 点生成的是**昨天**的报告,那时内存里
 * 昨天的账本早没了。所以这里把每天的结果留在磁盘上,只留最近几天。
 *
 * 存什么:总数与峰谷两笔(都是两位小数字符串,与界面同一口径),外加最后一次余额读数,
 * 好让**当天**重启后接着记而不是重新建基线。**不存 API Key、不存请求响应**。
 *
 * 纪律:还报不出数的账本(当天第一次读数,只有基线没有消耗)不落盘——留一条空记录
 * 会在日结里变成一个"0.00",而 0 会被读成"这天真没花钱"。
 *
 * 落盘 ~/.dsh/workbench/spend.json,原子写 + 容错读(与 read-marks.json 同规格)。
 */
import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { DailySpendState } from './dailySpend.ts'

/** 默认保留天数:一周。日结只回看一天,多留几天是为了排障时能对账。 */
const DEFAULT_KEEP_DAYS = 7

/** 一天的结果。字段缺席即"这一项报不出来",不写 0(全文件同一条纪律)。 */
export interface SpendDay {
  spent?: string
  peak?: string
  offpeak?: string
}

export interface SpendLedger {
  load(): Promise<void>
  /** 某天的结果;没记过就 undefined(日结据此留空)。 */
  get(date: string): SpendDay | undefined
  /** 恢复某天的账本,供采集循环重启后接着记。不是那天的就 undefined。 */
  resume(date: string): DailySpendState | undefined
  /** 记一次(内存立即生效,落盘异步进行,不挡采集)。 */
  record(state: DailySpendState): void
  /** 把挂起的写落定——测试用;生产靠 record 内部的异步写。 */
  flush(): Promise<void>
}

export function defaultSpendLedgerFile(home = process.env.HOME ?? ''): string {
  return `${home}/.dsh/workbench/spend.json`
}

/** 磁盘上一天的完整记录,比对外的 SpendDay 多一个基线。 */
interface StoredDay extends SpendDay {
  last_cents?: number
}

interface SpendFile { version: 1, days: Record<string, StoredDay> }

export function createSpendLedger(options: { file: string, keepDays?: number }): SpendLedger {
  const keepDays = options.keepDays ?? DEFAULT_KEEP_DAYS
  const days = new Map<string, StoredDay>()
  let writeQueue: Promise<void> = Promise.resolve()

  function prune(): void {
    // 日期是 YYYY-MM-DD,字典序即时间序。
    const sorted = [...days.keys()].sort()
    for (const date of sorted.slice(0, Math.max(0, sorted.length - keepDays))) days.delete(date)
  }

  async function save(): Promise<void> {
    const data: SpendFile = { version: 1, days: Object.fromEntries(days) }
    await mkdir(dirname(options.file), { recursive: true })
    const tmp = `${options.file}.${randomUUID()}.tmp`
    await writeFile(tmp, `${JSON.stringify(data, null, 2)}\n`, 'utf8')
    await rename(tmp, options.file)
  }

  return {
    async load() {
      try {
        const parsed = JSON.parse(await readFile(options.file, 'utf8')) as SpendFile
        if (parsed?.version !== 1 || typeof parsed.days !== 'object' || parsed.days === null) return
        for (const [date, day] of Object.entries(parsed.days)) {
          if (typeof day === 'object' && day !== null) days.set(date, day)
        }
        prune()
      }
      catch {
        // 不存在/写坏了都按空账本兜底:代价只是这一天的分账缺席,采集照跑。
      }
    },
    get(date) {
      const day = days.get(date)
      if (day === undefined) return undefined
      // 基线是内部字段,不外泄给日结/界面。
      const { last_cents: _lastCents, ...view } = day
      return view
    },
    resume(date) {
      const day = days.get(date)
      if (day?.last_cents === undefined) return undefined
      const spentCents = day.spent === undefined ? undefined : Math.round(Number(day.spent) * 100)
      const peakCents = day.peak === undefined ? undefined : Math.round(Number(day.peak) * 100)
      const offpeakCents = day.offpeak === undefined ? undefined : Math.round(Number(day.offpeak) * 100)
      return {
        date,
        lastCents: day.last_cents,
        ...(spentCents === undefined ? {} : { spentCents, spent: day.spent }),
        ...(peakCents === undefined ? {} : { peakCents, peak: day.peak }),
        ...(offpeakCents === undefined ? {} : { offpeakCents, offpeak: day.offpeak }),
      }
    },
    record(state) {
      // 只有基线、还报不出消耗的那一轮不记:空记录在日结里会变成一个骗人的 0.00。
      if (state.spent === undefined) return
      days.set(state.date, {
        spent: state.spent,
        ...(state.peak === undefined ? {} : { peak: state.peak }),
        ...(state.offpeak === undefined ? {} : { offpeak: state.offpeak }),
        last_cents: state.lastCents,
      })
      prune()
      // 失败静默:退化成"这天的分账缺席",跟没有这个文件时一样,不更糟(D13)。
      writeQueue = writeQueue.then(() => save()).catch(() => {})
    },
    async flush() {
      await writeQueue
    },
  }
}
