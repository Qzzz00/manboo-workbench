import type { UsageRecord } from './types.ts'

export interface UsageTotals {
  input: number
  output: number
  cache_read: number
  cache_write: number
}

export interface UsageDayAgg {
  date: string
  by_project: Record<string, UsageTotals>
  by_model: Record<string, UsageTotals>
  by_source: Record<string, UsageTotals>
  sessions: number
  messages: number
  hour_counts: Record<string, number>
}

export interface UsageAggregate {
  days: readonly UsageDayAgg[]
}

export interface UsageStore {
  /**
   * 吃进一批记录,返回**新计入**几条(被去重键或时刻判掉的都不算)。
   * 返回值给采集器用来判断本轮账本脏没脏(2026-10-28,8791 第五轮:有新增才重写落盘账)。
   */
  ingest: (records: readonly UsageRecord[]) => number
  aggregate: () => UsageAggregate
  /**
   * 按会话汇总(2026-09-09 任务卡费用归因)。键是 `${source}:${session}`——claude / codex / dsh
   * 三家的 source 与看板 TaskLink 的 agent 是同一套字,session 与 session_id 也对得上
   * (Claude 是 transcript 文件名的 UUID,Codex 是 rollout 文件名尾部的 UUID)。
   * 只回问到且有账的键;没账的不出现,由上层保持缺席而不是填 0(D13)。
   */
  sessionTotals: (keys: readonly string[]) => Record<string, UsageTotals>
  /**
   * 整份内部状态的快照(2026-10-28,8791 第五轮):落盘 `usage-offsets.json`,
   * 重启的新实例 restore 后续账——已读偏移只覆盖文件字节,**已聚合的数字**靠这里带过去,
   * 否则新实例跳过未变文件后面板就是空的。供 saveLedger 拿到后立即 JSON 序列化,
   * 不承诺之后内部不再变。
   */
  snapshot: () => UsageStoreSnapshot
  /** 从 snapshot 整体恢复;只在启动、账本为空时调一次(第五轮)。 */
  restore: (snap: UsageStoreSnapshot) => void
}

/** {@link UsageStore.snapshot} 的形状:天桶 + 去重键 + 每天的会话集合 + 每条会话的累计。 */
export interface UsageStoreSnapshot {
  days: readonly UsageDayAgg[]
  seen: string[]
  daySessions: Record<string, string[]>
  bySession: Record<string, UsageTotals>
}

function emptyTotals(): UsageTotals {
  return { input: 0, output: 0, cache_read: 0, cache_write: 0 }
}

/**
 * 一条记录算**哪一天、哪个钟点**(2026-10-02 运营同学 Air 那一版)。
 *
 * 上一版直接切 ISO 字符串:`ts.slice(0,10)` / `ts.slice(11,13)`。日志里的 `ts` 是 UTC,
 * 于是在东八区**每天早上 8 点之前的用量都被记到昨天**,她上午看「今天」那一格恒为 0 ——
 * 而「昨天」那一条凭空多出一截。时段分布那张图同理整条挪了 8 小时。
 *
 * 这一版按**本机时区**切天,与 `server/tasks.ts` 的 `localDateOf`、`client/dates.ts` 的
 * `localDateStr` 同一把尺(她的机器就在东八区;写死 `+8` 的话换个时区又错一次)。
 * 认不出的时刻回 undefined —— 那一条**不计入**,不塞进一个猜出来的日子(D13)。
 */
export function localDayOf(ts: string): { date: string, hour: string } | undefined {
  const at = new Date(ts)
  const msec = at.getTime()
  if (!Number.isFinite(msec)) return undefined
  const pad = (value: number): string => String(value).padStart(2, '0')
  return {
    date: `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}`,
    hour: String(at.getHours()),
  }
}

function add(bucket: Record<string, UsageTotals>, key: string, record: UsageRecord): void {
  const totals = bucket[key] ?? emptyTotals()
  totals.input += record.input
  totals.output += record.output
  totals.cache_read += record.cache_read
  totals.cache_write += record.cache_write
  bucket[key] = totals
}

/**
 * 增量追读的游标推进(纯函数)。
 *
 * 文件变长 → 从上次偏移往后读那一小段;文件变短 → 被截断/重写了,整份重扫。
 * 这是"实时但不烧机器"的关键:除首轮外每轮只做 stat + 追读。
 */
export function nextCursor(size: number, offset: number): { offset: number, rescan: boolean } {
  if (size < offset) return { offset: 0, rescan: true }
  return { offset, rescan: false }
}

export function createUsageStore(): UsageStore {
  const days = new Map<string, UsageDayAgg>()
  /** 已计入的去重键。Claude 同一请求会出现多条,不去重会放大数倍。 */
  const seen = new Set<string>()
  /** 每天见过的会话 id,用于会话数去重。 */
  const daySessions = new Map<string, Set<string>>()
  /** 每条会话的累计(跨天),键 `${source}:${session}`。给任务卡归因用,不进按天切片。 */
  const bySession: Record<string, UsageTotals> = {}

  return {
    ingest(records) {
      let accepted = 0
      for (const record of records) {
        if (record.key !== undefined) {
          if (seen.has(record.key)) continue
          seen.add(record.key)
        }

        // 按本机时区切天(见 localDayOf):认不出的时刻一条都不计入。
        const when = localDayOf(record.ts)
        if (when === undefined) continue
        accepted += 1
        const { date } = when

        const day = days.get(date) ?? {
          date,
          by_project: {},
          by_model: {},
          by_source: {},
          sessions: 0,
          messages: 0,
          hour_counts: {},
        }
        add(day.by_project, record.project, record)
        add(day.by_model, record.model, record)
        add(day.by_source, record.source, record)
        add(bySession, `${record.source}:${record.session}`, record)
        day.messages += 1

        day.hour_counts[when.hour] = (day.hour_counts[when.hour] ?? 0) + 1

        const sessionSet = daySessions.get(date) ?? new Set<string>()
        sessionSet.add(record.session)
        daySessions.set(date, sessionSet)
        day.sessions = sessionSet.size

        days.set(date, day)
      }
      return accepted
    },

    aggregate() {
      return { days: [...days.values()].sort((left, right) => left.date.localeCompare(right.date)) }
    },

    sessionTotals(keys) {
      const out: Record<string, UsageTotals> = {}
      for (const key of keys) {
        const totals = bySession[key]
        if (totals !== undefined) out[key] = { ...totals }
      }
      return out
    },

    snapshot() {
      return {
        days: this.aggregate().days,
        seen: [...seen],
        daySessions: Object.fromEntries([...daySessions].map(([date, set]) => [date, [...set]])),
        bySession: Object.fromEntries(Object.entries(bySession).map(([key, totals]) => [key, { ...totals }])),
      }
    },

    restore(snap) {
      days.clear()
      seen.clear()
      daySessions.clear()
      for (const key of Object.keys(bySession)) delete bySession[key]
      for (const day of snap.days) days.set(day.date, day)
      for (const key of snap.seen) seen.add(key)
      for (const [date, sessions] of Object.entries(snap.daySessions)) daySessions.set(date, new Set(sessions))
      Object.assign(bySession, snap.bySession)
    },
  }
}
