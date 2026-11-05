/**
 * 定时派活的最小 cron(2026-10-21 协作区全量):五段「分 时 日 月 周」,每段只认 `*`、数字、逗号、「每 n 个」(星号斜杠 n)。
 * 范围(`1-5`)、名字(`MON`)、`?` / `L` 都不认 —— 认不出就整条拒,不猜它想什么时候跑。
 * 按电脑本机时区判(同例程那几样);周日是 0。
 */

export interface CronSpec {
  minute: ReadonlySet<number>
  hour: ReadonlySet<number>
  day: ReadonlySet<number>
  month: ReadonlySet<number>
  weekday: ReadonlySet<number>
}

const FIELDS: readonly { min: number, max: number }[] = [
  { min: 0, max: 59 }, { min: 0, max: 23 }, { min: 1, max: 31 }, { min: 1, max: 12 }, { min: 0, max: 6 },
]

function field(text: string, min: number, max: number): Set<number> | undefined {
  const out = new Set<number>()
  for (const part of text.split(',')) {
    if (part === '*') { for (let n = min; n <= max; n += 1) out.add(n); continue }
    const step = /^\*\/(\d+)$/.exec(part)
    if (step !== null) {
      const every = Number(step[1])
      if (every < 1) return undefined
      for (let n = min; n <= max; n += every) out.add(n)
      continue
    }
    if (!/^\d+$/.test(part)) return undefined
    const n = Number(part)
    if (n < min || n > max) return undefined
    out.add(n)
  }
  return out.size === 0 ? undefined : out
}

export function parseCron(text: string): CronSpec | undefined {
  const parts = text.trim().split(/\s+/)
  if (parts.length !== 5) return undefined
  const sets = parts.map((part, i) => field(part, (FIELDS[i] as { min: number }).min, (FIELDS[i] as { max: number }).max))
  if (sets.some(one => one === undefined)) return undefined
  const [minute, hour, day, month, weekday] = sets as Set<number>[]
  return { minute: minute as Set<number>, hour: hour as Set<number>, day: day as Set<number>, month: month as Set<number>, weekday: weekday as Set<number> }
}

/** 这一分钟该不该跑(本机时区)。 */
export function cronMatches(spec: CronSpec, at: Date): boolean {
  return spec.minute.has(at.getMinutes())
    && spec.hour.has(at.getHours())
    && spec.day.has(at.getDate())
    && spec.month.has(at.getMonth() + 1)
    && spec.weekday.has(at.getDay())
}

/** 这一分钟的键(同一分钟不重复跑)。 */
export function minuteKey(at: Date): string {
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}T${pad(at.getHours())}:${pad(at.getMinutes())}`
}
