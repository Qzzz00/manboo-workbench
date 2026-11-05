/**
 * 额度按到期先花 · 例程建议(2026-10-28,卡 t-f68365f6;任务书
 * `docs/交接-1028-机制退修任务书-接续对题与改派语义.md` 第 10 条)。
 *
 * 维护者 14:3x:「Kimi 月额度明天重置,这种场景怎么做成机制」。那一句话拆成两张卡:
 * 选人那一半(dispatchChoice 按「快重置且剩得多」排前)是 t-8c3c93be;**这一张是例程这一半**:
 * 重置前 6 小时某家某扇窗还剩一半以上 → 把板上「待排」的研发活列成一条建议递给她
 * (替你拿主意那种卡),**不自动派**。
 *
 * 与剩余额度告警(2026-10-23,卡 t-8e617888)同一层、同一条接缝(额度样本→提示与去重,
 * 主人 = 小K),纪律照抄:
 *
 * - **只消费 `AgentQuotaView`**(`agentQuotaNow` 出来的那一份,与额度面板 / 告警同一份)——
 *   不各家另抓、不复制阈值;要看的几扇窗就是 `quotaAlerts.ts` 那一个 `quotaWindowsOf`
 *   (导出共用,两处不许各写一份);
 * - **触发窗口**:窗口给了 `reset_at`、且在 (现在, 现在+6h] 之内、`left_pct` ≥ 50(一半以上)
 *   才提议;更早、已过、不到一半、没有/认不出 `reset_at` 一律不出 —— 不编时刻(D13);
 * - **建议内容**:板上「待排」(`status:'backlog'`)的研发活 —— 类型只认 `protocol.ts`
 *   `workTypeOf` 那一处(明写 `work_type` 优先,否则从已知事实认),不另写认法;
 *   一条至多点名 {@link SPEND_TIP_TASK_MAX} 件、带总数;**一件都没有 = 没主意可拿,不提议**
 *   (她派完了消息即收,板上来了新活同周期内可以再递);
 * - **每个「家+窗+重置周期」只递一次**:去重记号落在一份最小本机 JSON
 *   (默认 `~/.dsh/workbench/quota-spend-tips.json`),键 = `<agent id>\u0000<窗口 label>\u0000<reset_at>`
 *   —— `reset_at` 就是周期身份,重置一过键自然作废;**只记「递过 + 这一条自己说过的话」**,
 *   不存额度读数,不是第二套额度账(额度事实的主人仍是 agentQuota);
 * - **显示事实冻结在递出那一刻**(同 quotaAlerts 退修 Minor1 的教训):title/note 用记号里
 *   冻住的那份,后续拍读数变化不把已读顶回未读;新周期(新 `reset_at`)是新的一条;
 * - **只是工作台消息**:不带 task_id / conversation / wait_reason,不进「等你」、不触发来电。
 *
 * 看板读不到(`tasks === undefined`,快照冻结)时不提议也不动账 —— 同「stale 不清账」那条:
 * 一次读不到不算「她派完了」。
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { AgentQuotaView, ButlerInboxItem, TaskView } from '../protocol.ts'
import { workTypeOf } from '../protocol.ts'
import { windowName } from './agentQuota.ts'
import { quotaWindowsOf } from './quotaAlerts.ts'

/** 重置前多久递建议:6 小时(任务书原话)。 */
export const SPEND_TIP_WINDOW_MS = 6 * 60 * 60 * 1000
/** 「还剩一半以上」的那条线:正好 50 也算(任务书原话「一半以上」,取 ≥)。 */
export const SPEND_TIP_MIN_LEFT_PCT = 50
/** 一条建议里至多点名几件待排研发活;更多的写进「共 N 件」。 */
export const SPEND_TIP_TASK_MAX = 3

/**
 * 一个「家+窗+重置周期」递过一次的记号。`at` = 递出那一刻(跨拍不变);
 * `title` / `note` = 这一条消息自己说过的话(冻结,见文件头);`pct` 记下来只为排查对照,
 * 不参与拼装。
 */
export interface QuotaSpendTipFired {
  at: string
  pct?: number
  title?: string
  note?: string
}

/** 去重账:键 = `<agent id>\u0000<窗口 label>\u0000<reset_at>`。缺席 = 这一周期还没递过。 */
export type QuotaSpendTipMarks = Record<string, QuotaSpendTipFired>

export interface QuotaSpendTipsIo {
  read: (file: string) => Promise<string | undefined>
  write: (file: string, text: string) => Promise<void>
}

/** 默认落点,与 `quota-alerts.json` 同一个目录、同一个惯例;两个账互不相通。 */
export function defaultQuotaSpendTipsFile(home = process.env.HOME ?? ''): string {
  return `${home}/.dsh/workbench/quota-spend-tips.json`
}

/** 读坏了 / 不在就当没有:至多重复递一次,比拿着一份坏账不响要强。 */
export function parseQuotaSpendTips(text: string | undefined): QuotaSpendTipMarks {
  if (text === undefined) return {}
  try {
    const parsed = JSON.parse(text) as { marks?: unknown }
    const marks = parsed?.marks
    if (typeof marks !== 'object' || marks === null) return {}
    const out: QuotaSpendTipMarks = {}
    for (const [key, mark] of Object.entries(marks as Record<string, unknown>)) {
      if (typeof mark !== 'object' || mark === null) continue
      const { at, pct, title, note } = mark as { at?: unknown, pct?: unknown, title?: unknown, note?: unknown }
      if (typeof at !== 'string') continue
      out[key] = {
        at,
        ...(typeof pct === 'number' && Number.isFinite(pct) ? { pct } : {}),
        ...(typeof title === 'string' ? { title } : {}),
        ...(typeof note === 'string' ? { note } : {}),
      }
    }
    return out
  }
  catch {
    return {}
  }
}

export function serializeQuotaSpendTips(marks: QuotaSpendTipMarks): string {
  return `${JSON.stringify({ marks }, null, 2)}\n`
}

const nodeIo = (): QuotaSpendTipsIo => ({
  read: async (file) => {
    try { return await readFile(file, 'utf8') }
    catch { return undefined }
  },
  write: async (file, text) => {
    await mkdir(dirname(file), { recursive: true })
    await writeFile(file, text)
  },
})

export interface QuotaSpendTips {
  /** 启动时读一次去重账;读不到 / 读坏了 = 空账。 */
  load: () => Promise<void>
  /**
   * 消费这一拍的统一额度视图 + 看板:该递的递、该收的收;
   * 返回这一拍该摆在收件箱里的那几条(同一条在两拍之间 id/at 不变,界面不闪)。
   */
  itemsFor: (views: readonly AgentQuotaView[], tasks: readonly TaskView[] | undefined, at: Date) => ButlerInboxItem[]
  /** 现在记着哪些(测试与排查用)。 */
  marks: () => QuotaSpendTipMarks
  /** 把没写完的落盘写完(测试要确定性;运行时都是 fire-and-forget)。 */
  flush: () => Promise<void>
}

export function createQuotaSpendTips(options: { file: string, io?: QuotaSpendTipsIo }): QuotaSpendTips {
  const io = options.io ?? nodeIo()
  let marks: QuotaSpendTipMarks = {}
  let loaded = false
  let saving: Promise<void> = Promise.resolve()

  const persist = (): void => {
    const text = serializeQuotaSpendTips(marks)
    saving = saving.then(async () => { await io.write(options.file, text) }).catch(() => {})
  }

  /** 重置时刻写成人话:今天只写几点;明天写「明天 HH:MM」;更后写「MM-DD HH:MM」(6 小时窗内不会更后)。 */
  const resetClockOf = (resetAt: Date, at: Date): string => {
    const pad = (n: number): string => String(n).padStart(2, '0')
    const dayOf = (d: Date): number => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
    const days = Math.round((dayOf(resetAt) - dayOf(at)) / 86_400_000)
    const hhmm = `${pad(resetAt.getHours())}:${pad(resetAt.getMinutes())}`
    if (days <= 0) return hhmm
    if (days === 1) return `明天 ${hhmm}`
    return `${pad(resetAt.getMonth() + 1)}-${pad(resetAt.getDate())} ${hhmm}`
  }

  /** 名字**起头**一句话:英文名后面留一个空格,中文名不留(同 `quotaAlerts.ts` 的 `leadNameOf`)。 */
  const leadNameOf = (name: string): string => {
    return /^[\x00-\x7F]+$/.test(name) ? `${name} ` : name
  }

  /** 消息里那一扇窗的叫法:`5h → 5 小时`、`周 → 本周`、`总 → 总`;空 label(没分窗)不点名。 */
  const windowWord = (label: string): string => {
    if (label === '') return ''
    const word = windowName(label)
    return word.endsWith('窗口') ? word.slice(0, word.length - '窗口'.length) : word
  }

  /** 递出那一刻拼好、冻进记号的那一句「建议」。 */
  const wordsOf = (view: AgentQuotaView, label: string, pct: number, resetAt: Date, at: Date, backlog: readonly TaskView[]): { title: string, note: string } => {
    const who = leadNameOf(view.title)
    const word = windowWord(label)
    const title = `${who}的${word}额度快重置了,还剩约 ${pct}%`
    const named = backlog.slice(0, SPEND_TIP_TASK_MAX).map(one => one.title)
    const more = backlog.length - named.length
    const list = more > 0 ? `${named.join('、')} 等 ${backlog.length} 件` : named.join('、')
    const note = `${resetClockOf(resetAt, at)} 重置 · 板上压着 ${backlog.length} 件研发活(待排):${list} —— 不用就作废,想派哪件说一声`
    return { title, note }
  }

  const itemsFor = (views: readonly AgentQuotaView[], tasks: readonly TaskView[] | undefined, at: Date): ButlerInboxItem[] => {
    // 看板读不到:不提议也不动账(一次读不到不算「她派完了」,同 stale 不清账)。
    if (tasks === undefined) return []
    const backlog = tasks.filter(one => one.status === 'backlog' && workTypeOf(one) === 'dev')
    // 没主意可拿:待排研发活一件都没有 → 收掉所有建议、清账。
    if (backlog.length === 0) {
      if (Object.keys(marks).length !== 0) { marks = {}; persist() }
      return []
    }

    // 这一拍满足触发窗口的「家+窗+重置周期」。
    const candidates = new Map<string, { view: AgentQuotaView, label: string, left_pct: number, reset_at: string }>()
    for (const view of views) {
      // 不误报的那几档:只认「有数、不旧、有百分比」的视图(同 quotaAlerts)。
      if (view.state !== 'numbers' || view.stale === true) continue
      for (const one of quotaWindowsOf(view)) {
        if (one.reset_at === undefined) continue
        const resetMs = Date.parse(one.reset_at)
        if (!Number.isFinite(resetMs)) continue
        const until = resetMs - at.getTime()
        if (until < 0 || until > SPEND_TIP_WINDOW_MS) continue
        if (!Number.isFinite(one.left_pct) || one.left_pct < SPEND_TIP_MIN_LEFT_PCT) continue
        candidates.set(`${view.id}\u0000${one.label}\u0000${one.reset_at}`, { view, label: one.label, left_pct: one.left_pct, reset_at: one.reset_at })
      }
    }

    // 收:重置过了 / 掉出一半以下 / 读数变旧 → 这一拍不再是候选的记号清掉。
    let changed = false
    for (const key of Object.keys(marks)) {
      if (candidates.has(key)) continue
      delete marks[key]
      changed = true
    }

    const items: ButlerInboxItem[] = []
    for (const [key, one] of candidates) {
      const [agentId = '', label = '', resetAtIso = ''] = key.split('\u0000')
      if (agentId === '' || resetAtIso === '') continue
      const fired = marks[key]
      if (fired === undefined) {
        // 这一周期第一次满足:递一条新建议,说过的话冻结在这一刻。
        const pct = Math.max(0, Math.min(100, Math.round(one.left_pct)))
        const fresh: QuotaSpendTipFired = { at: at.toISOString(), pct }
        const words = wordsOf(one.view, label, pct, new Date(resetAtIso), at, backlog)
        fresh.title = words.title
        fresh.note = words.note
        marks[key] = fresh
        changed = true
        items.push({ id: `spend:${agentId}:${label}:${resetAtIso}`, kind: 'spend', title: words.title, note: words.note, at: fresh.at })
        continue
      }
      // 已递过:原样重放同一条(id/at/title/note 逐字节相同 → 已读不漂移)。
      items.push({
        id: `spend:${agentId}:${label}:${resetAtIso}`,
        kind: 'spend',
        title: fired.title ?? '',
        ...(fired.note === undefined ? {} : { note: fired.note }),
        at: fired.at,
      })
    }
    if (changed) persist()
    return items
  }

  return {
    load: async () => {
      if (loaded) return
      loaded = true
      marks = parseQuotaSpendTips(await io.read(options.file))
    },
    itemsFor,
    marks: () => marks,
    flush: async () => { await saving },
  }
}
