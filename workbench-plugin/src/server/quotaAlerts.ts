/**
 * 剩余额度告警 → 工作台消息(2026-10-23,卡 t-8e617888;设计 `docs/设计-剩余额度告警-2026-10-23.md`)。
 *
 * 维护者 12:37 撞见小K「5 小时窗口只剩约 10%」而周 / 总还宽裕,拍板「补剩余额度告警,
 * 工作台消息即可」。这一层只做**从统一额度视图到收件箱一条**的事:
 *
 * - **只消费 `AgentQuotaView`**(`agentQuotaNow` 出来的那一份,与额度面板同一份)——
 *   不各家另抓、不复制阈值:判级就是 `agentQuota.ts` 的 `quotaLevelOfPct`
 *   (耗尽 ≤1 / 低额 < `BALANCE_LOW_PCT`,与面板变黄同一条线);
 * - **每家每扇窗每个周期**:进入 low 提醒一次,进一步 empty 再提醒一次;
 *   恢复(verifiable 地回到宽裕)后清账,新周期可再提醒;
 * - **重复快照 / 页面刷新 / 服务重启不重报**:去重记号落在一份最小本机 JSON
 *   (默认 `~/.dsh/workbench/quota-alerts.json`),**只记「哪家哪扇窗提醒到哪一级 + 提醒时刻」**
 *   —— 不存余量、不存读数,不是第二套额度账(额度账仍只有 agentQuota 那一处);
 * - **不误报**:unknown / 没接上 / 不限 / 只有积分没有百分比 / 旧样本(`stale`,统一视图
 *   按现有 freshness 判据把百分比摘掉了)一律不出消息;旧样本期间**不清账**——
 *   「无 reset_at 来源按可验证的恢复边界再开启告警」,一次读不到不算恢复;
 * - **只出工作台消息**:条目不带 task_id / conversation / wait_reason,不进「等你」、
 *   不触发来电(来电只看看板与例程,同 `habit` 那一档的先例)。
 *
 * 条目**现拼不落消息库**(同 butlerInbox 的纪律):告警一刻记下记号,只要那一扇窗还在
 * low/empty,每一拍都把同一条(id/at 不变)摆回收件箱 —— 她随时回看;恢复即收。
 *
 * ★ **退修(2026-10-23 晚,独立审 Minor1)**:一条消息**说过的话冻结在提醒那一刻**。
 * 收件箱投影的 version 含 title/note(`butlerSceneModel` 的 eventVersion)——若每拍拿新读数
 * 重拼,百分比一降,她已读过的同一条就被顶回未读:那是换着花样重复提醒。所以记号里
 * 连同这一条消息自己的**显示事实**(那一刻的百分比、拼好的重置/读到补句)一起记;
 * 百分比与「读到」时刻来自同一个样本,不混用旧值新时刻;新读数只有在**升级 empty** 或
 * **可验证恢复后的新周期**(都会成为新的一条)时才说话。这不是第二套额度账:没有历史
 * 序列,一扇窗一个周期就一份显示快照,额度事实的主人仍是 agentQuota。
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { AgentQuotaView, ButlerInboxItem } from '../protocol.ts'
import { quotaAsOfClock } from '../protocol.ts'
import { quotaLevelOfPct, windowName } from './agentQuota.ts'

/**
 * 一家一扇窗一级提醒的记号。`at` = 提醒那一刻(ISO,跨拍不变);
 * `pct` / `note` = 这一条消息自己说过的话(冻结,见文件头退修一段)。
 * 旧文件里 `low`/`empty` 是裸字符串(只有时刻):兼容读入,见到下一拍读数时补齐。
 */
export interface QuotaAlertFired {
  at: string
  pct?: number
  note?: string
}

/** 一家一扇窗的两级记号。缺席 = 那一级还没提醒过。 */
export interface QuotaAlertMark {
  low?: QuotaAlertFired
  empty?: QuotaAlertFired
}

/**
 * 去重账:键 = `<agent id>\0<窗口 label>`(label 为空 = 这一家只有「最紧的一个数」,
 * 没有分窗)。**\u0000 做分隔**:agent id 里有没有冒号都不怕互撞。
 */
export type QuotaAlertMarks = Record<string, QuotaAlertMark>

export interface QuotaAlertsIo {
  read: (file: string) => Promise<string | undefined>
  write: (file: string, text: string) => Promise<void>
}

/** 默认落点,与 `quota/persist.ts` 的 `last-quota.json` 同一个惯例、同一个目录。 */
export function defaultQuotaAlertsFile(home = process.env.HOME ?? ''): string {
  return `${home}/.dsh/workbench/quota-alerts.json`
}

/** 读坏了 / 不在就当没有:至多重复提醒一次,比拿着一份坏账不响要强。 */
export function parseQuotaAlerts(text: string | undefined): QuotaAlertMarks {
  if (text === undefined) return {}
  try {
    const parsed = JSON.parse(text) as { marks?: unknown }
    const marks = parsed?.marks
    if (typeof marks !== 'object' || marks === null) return {}
    const out: QuotaAlertMarks = {}
    for (const [key, mark] of Object.entries(marks as Record<string, unknown>)) {
      if (typeof mark !== 'object' || mark === null) continue
      const { low, empty } = mark as { low?: unknown, empty?: unknown }
      const fired = (raw: unknown): QuotaAlertFired | undefined => {
        // 旧格式:裸字符串只有时刻;新格式:{ at, pct?, note? }。
        if (typeof raw === 'string') return { at: raw }
        if (typeof raw !== 'object' || raw === null) return undefined
        const { at, pct, note } = raw as { at?: unknown, pct?: unknown, note?: unknown }
        if (typeof at !== 'string') return undefined
        return {
          at,
          ...(typeof pct === 'number' && Number.isFinite(pct) ? { pct } : {}),
          ...(typeof note === 'string' ? { note } : {}),
        }
      }
      const lowFired = fired(low)
      const emptyFired = fired(empty)
      out[key] = {
        ...(lowFired === undefined ? {} : { low: lowFired }),
        ...(emptyFired === undefined ? {} : { empty: emptyFired }),
      }
    }
    return out
  }
  catch {
    return {}
  }
}

export function serializeQuotaAlerts(marks: QuotaAlertMarks): string {
  return `${JSON.stringify({ marks }, null, 2)}\n`
}

const nodeIo = (): QuotaAlertsIo => ({
  read: async (file) => {
    try { return await readFile(file, 'utf8') }
    catch { return undefined }
  },
  write: async (file, text) => {
    await mkdir(dirname(file), { recursive: true })
    await writeFile(file, text)
  },
})

export interface QuotaAlerts {
  /** 启动时读一次去重账;读不到 / 读坏了 = 空账。 */
  load: () => Promise<void>
  /**
   * 消费这一拍的统一额度视图:该记帐的记帐,该收起的收起;
   * 返回这一拍该摆在收件箱里的那几条(同一条告警在两拍之间 id/at 不变,界面不闪)。
   */
  itemsFor: (views: readonly AgentQuotaView[], at: Date) => ButlerInboxItem[]
  /** 现在记着哪些(测试与排查用)。 */
  marks: () => QuotaAlertMarks
  /** 把没写完的落盘写完(测试要确定性;运行时都是 fire-and-forget)。 */
  flush: () => Promise<void>
}

export function createQuotaAlerts(options: { file: string, io?: QuotaAlertsIo }): QuotaAlerts {
  const io = options.io ?? nodeIo()
  let marks: QuotaAlertMarks = {}
  let loaded = false
  let saving: Promise<void> = Promise.resolve()

  const persist = (): void => {
    const text = serializeQuotaAlerts(marks)
    saving = saving.then(async () => { await io.write(options.file, text) }).catch(() => {})
  }

  /** 告警那一条的标题:家名 + 哪扇窗 + 余量/耗尽。措辞与额度面板同一套词。 */
  const titleOf = (view: AgentQuotaView, label: string, level: 'low' | 'empty', pct: number): string => {
    const who = leadNameOf(view.title)
    const word = windowWord(label)
    if (level === 'empty') return `${who}的${word}额度用完了`
    return `${who}的${word}额度只剩约 ${pct}%`
  }

  /** 补一句:那一扇窗的重置时刻(来源给了才写,不编)+ 这一读数几点读到的。 */
  const noteOf = (view: AgentQuotaView, resetAt: string | undefined, at: Date): string | undefined => {
    const parts: string[] = []
    const reset = resetAt === undefined ? undefined : quotaAsOfClock(resetAt, at)
    if (reset !== undefined) parts.push(`${reset} 重置`)
    const read = view.read_at === undefined ? undefined : quotaAsOfClock(view.read_at, at)
    if (read !== undefined) parts.push(`${read} 读到`)
    return parts.length === 0 ? undefined : parts.join(' · ')
  }

  const itemOf = (view: AgentQuotaView, label: string, level: 'low' | 'empty', fired: QuotaAlertFired): ButlerInboxItem => ({
    id: `quota:${view.id}:${label}:${level}`,
    kind: 'quota',
    // title/note 一律用记号里冻结的事实(见文件头退修一段),跨拍逐字节相同 → 已读不漂移。
    title: titleOf(view, label, level, fired.pct ?? 0),
    ...(fired.note === undefined ? {} : { note: fired.note }),
    at: fired.at,
  })

  const itemsFor = (views: readonly AgentQuotaView[], at: Date): ButlerInboxItem[] => {
    const items: ButlerInboxItem[] = []
    let changed = false
    for (const view of views) {
      // 不误报的那几档:只认「有数、不旧、有百分比」的视图。
      if (view.state !== 'numbers' || view.stale === true) continue
      const windows = quotaWindowsOf(view)
      for (const one of windows) {
        const level = quotaLevelOfPct(one.left_pct)
        const key = `${view.id}${one.label}`
        if (level === 'ok') {
          // 可验证的恢复边界:读数真的回到宽裕了,清账,新周期才能再提醒。
          if (marks[key] !== undefined) { delete marks[key]; changed = true }
          continue
        }
        const mark = marks[key] ?? {}
        const fired = level === 'low' ? mark.low : mark.empty
        if (fired === undefined) {
          // 第一次到这一级:记一条新消息,显示事实冻结在这一刻的样本上。
          const freshPct = Math.max(0, Math.min(100, Math.round(one.left_pct)))
          const fresh: QuotaAlertFired = { at: at.toISOString(), pct: freshPct }
          const note = noteOf(view, one.reset_at, at)
          if (note !== undefined) fresh.note = note
          if (level === 'empty') {
            // ok→empty 直跳:只出 empty 一条;low 那一级一并记掉,不补发一条过时的低额提醒。
            const lowFired: QuotaAlertFired = mark.low ?? { at: fresh.at, pct: freshPct }
            if (lowFired.note === undefined && note !== undefined) lowFired.note = note
            marks[key] = { low: lowFired, empty: fresh }
          }
          else marks[key] = { ...mark, low: fresh }
          changed = true
        }
        else if (fired.pct === undefined) {
          // 旧格式记号(只有时刻):用这一拍读数补齐显示事实,一次性升级。
          fired.pct = Math.max(0, Math.min(100, Math.round(one.left_pct)))
          const note = noteOf(view, one.reset_at, at)
          if (note !== undefined) fired.note = note
          changed = true
        }
        const kept = level === 'low' ? marks[key]?.low : marks[key]?.empty
        if (kept !== undefined) items.push(itemOf(view, one.label, level, kept))
      }
    }
    if (changed) persist()
    return items
  }

  return {
    load: async () => {
      if (loaded) return
      loaded = true
      marks = parseQuotaAlerts(await io.read(options.file))
    },
    itemsFor,
    marks: () => marks,
    flush: async () => { await saving },
  }
}

/** 名字**起头**一句话:英文名后面留一个空格,中文名不留(同 `agentQuota.ts` 的 `leadName`)。 */
function leadNameOf(name: string): string {
  return /^[\x00-\x7F]+$/.test(name) ? `${name} ` : name
}

/** 消息里那一扇窗的叫法:`5h → 5 小时`、`周 → 本周`、`总 → 总`;空 label(没分窗)不点名。 */
function windowWord(label: string): string {
  if (label === '') return ''
  const word = windowName(label)
  return word.endsWith('窗口') ? word.slice(0, word.length - '窗口'.length) : word
}

/**
 * 这一格要看的几扇窗:有 `windows` 就逐扇看(每扇各自判级);没有就只看最紧的那个数。
 * 2026-10-28(卡 t-f68365f6)导出:额度活用建议(`quotaSpendTips.ts`)与告警共用这同一份,
 * 两处不许各写一份「哪几扇窗」。
 */
export function quotaWindowsOf(view: AgentQuotaView): readonly { label: string, left_pct: number, reset_at?: string }[] {
  const real = (view.windows ?? []).filter(one => Number.isFinite(one.left_pct))
  if (real.length > 0) return real
  return view.left_pct === undefined || !Number.isFinite(view.left_pct) ? [] : [{ label: '', left_pct: view.left_pct, ...(view.reset_at === undefined ? {} : { reset_at: view.reset_at }) }]
}
