/**
 * 用量面板 —— **产品研发模板那一版**(spec 2026-08-25,即 0.4.89 那一份)。
 *
 * ★ 2026-10-03 按模板分流(维护者原话:「产品研发布局改回之前的样子……主要是消耗数据,
 * 改成我自己之前在用的啊,其他的可以不改」)。0.4.90 把这一整块换成了运营同学(Air)
 * 自己写的那一份(`air/usage.js`),维护者在自己机器上看到的于是是他那一格。
 * 现在两份都在,**挑哪一份只在 `UsageModule.tsx` 那一处分叉**:
 *
 * | 模板 | 面板 |
 * |---|---|
 * | `product`(产品研发,缺省) | 这一份(三标签页 + stat tile + 年度热力图 + 项目/模型排行) |
 * | `ops`(运营 / 自媒体) | `air/usage.js`(他那一版:三档范围 + 按日柱状 + 占比条) |
 *
 * 这一份是从 `79b3757a` 原样取回的,**除了给 `formatTokens` 加了个 `export`、
 * 这段文件头、以及把注释里指 Air 的「她」改成「他」(10-03 维护者纠正称呼),
 * 一行没改** —— 它是「他之前在用的那个样子」,改它就不是回退了。
 *
 * ★ 2026-10-21:时间范围默认 All、切过的那一档记住(`USAGE_RANGE_KEY`;维护者「我每次都得从30d切到all」)。
 *
 * —— 以下是 0.4.89 当时的文件头,原样留着 ——
 *
 * 三标签页共用一份按天切片,标签与时间范围都是本地状态
 * ——视图偏好不值得为它多跑一轮服务端往返。
 *
 * 诚实边界(D13):`{ error }` 显示"未接入"而不是 0;`partial` 来源(只取到部分字段的
 * 那种)不参与缓存命中率与输入占比——那几个指标会被它悄悄带偏。
 *
 * 主次(2026-09-15 三次修订,Ben:「总消耗数太少了,搞多一点」→ 统筹会话解释后拍板**不编数**,
 * 换口径展示):总览大字是「总吞吐」(含缓存读),「总消耗」(入+缓存写+出)降成同一格的小字;10-21 起两行的括弧去掉,口径只在「计算口径」里写。
 * 两个数的算法一字不改(billed / throughput),只换主次;排行、占比、热力图仍按总消耗——
 * 那是计费口径,09-02 的定义不动。项目/模型页页头的大字也仍是总消耗,占比才和条长对得上。
 *
 * 视觉(2026-08-25 二轮):首版被 Ben 判"就是个线性图"。根因有二,都已修:
 * 1. 用了两个**不存在的令牌**(--dsw-alias-fill-l1/l2),卡片没底色、轨道透明,
 *    所以塌成一条条线。真实令牌见下方 style.ts 里的 .ben-wb__usage-* 段。
 * 2. 排版本身缺层级——现在改成 stat tile 卡片网格 + 热力图 + 分段控件式标签页。
 *    条形按数据可视化规范:单一色相的顺序色阶、轨道可见、数据端 4px 圆角。
 */
import { useMemo, useState } from 'react'
import type { UsageDay, UsageState, UsageTotals } from '../protocol.ts'
import { billedTokens } from '../protocol.ts'
import { StackRungs } from './ui/index.tsx'

type Tab = 'project' | 'model' | 'overview'
type Range = 'all' | '30d' | '7d'

/** 顺序即优先级:总览先给全貌,再按项目/模型下钻。对象字面量的键序就是渲染顺序。 */
const TAB_LABELS: Record<Tab, string> = { overview: '总览', project: '项目', model: '模型' }
const RANGE_LABELS: Record<Range, string> = { all: 'All', '30d': '30d', '7d': '7d' }
const RANGE_DAYS: Record<Range, number> = { all: Number.MAX_SAFE_INTEGER, '30d': 30, '7d': 7 }

/**
 * 时间范围**默认 All,切过的那一档记住**(2026-10-21,维护者:「能不能默认展示All,我每次都得从30d切到all」)。
 * 记在这台浏览器的 localStorage;读不到(壳里、无痕窗口、截图环境里会直接抛,或者压根没有)、或记的值认不出,一律回 All。
 */
export const USAGE_RANGE_KEY = 'ben-wb.usage.range'

function readRange(): Range {
  try {
    const saved = window.localStorage?.getItem(USAGE_RANGE_KEY)
    return saved === 'all' || saved === '30d' || saved === '7d' ? saved : 'all'
  }
  catch { return 'all' }
}

function saveRange(range: Range): void {
  try { window.localStorage?.setItem(USAGE_RANGE_KEY, range) }
  catch { /* 记不住只是下次回 All,不拦这一次的切换 */ }
}

/** 排行榜一次显示多少条。其余折进"其余 N 项"一行,不无限铺——太长就没人读了。 */
const RANK_LIMIT = 8

/**
 * ★ 2026-10-02(运营同学 Air 那一版):**一家没有用量来源时写这个,不写 0**。
 *
 * 他那一格原来把豆包办公显示成一个 0。那一个 0 读起来是"今天一次都没用",
 * 而真相是我们这儿**没有它的用量来源** —— 豆包办公是在它自己的窗口里跑的,
 * 本机没有留下任何可数的 token 日志。两件事差得远:一个是他的使用习惯,
 * 一个是我们的采集边界。这是「取不到就缺席,不编一个数」在这一格里的说法。
 */
export const USAGE_NOT_WIRED = '未接入用量'
/** 格脚右端那颗(评审页 0cf75042 消耗数据 `.module-foot`「来源与口径 ›」),点开是口径说明。 */
export const USAGE_METHOD_LABEL = '来源与口径'
/** 有来源残缺 / 没接上时收成的那一行(评审页异常档「暂未更新 2 家 · 查看原因 ›」)。 */
export const USAGE_STALE_LINE = (count: number): string => `暂未更新 ${count} 家`

/** 这一块底下那一句:它们**不计入**上面任何一个合计,也不按 0 计。 */
export const USAGE_NOT_WIRED_NOT_COUNTED = '这几家不计入上面的合计,也不按 0 计 —— 本机没有它们的用量日志。'

/**
 * 还没有用量来源的那几家。
 *
 * **一家一条,各自写明为什么** —— 不写一句笼统的"还有几家没接"。
 * 接上了就从这张表里删掉那一条(到那时它会出现在上面的来源里,带着真实的数)。
 */
export const USAGE_NOT_WIRED_FAMILIES: readonly { id: string, name: string, why: string }[] = [
  { id: 'doubao', name: '豆包办公', why: '它在自己的窗口里跑,本机没有可数的 token 日志' },
]

function emptyTotals(): UsageTotals {
  return { input: 0, output: 0, cache_read: 0, cache_write: 0 }
}

/**
 * 主口径「总消耗」= 新增输入 + **缓存写** + 输出(2026-09-02 二次修订,Ben 定)。
 *
 * 为什么必须带上 cache_write:两家的记账口径根本不同,漏了它等于把 Claude 抹成零。
 * 全时段真机数据(68 天):
 * - Codex 的 `input_tokens` **包含**缓存部分(解析时已减掉),所以它的"新增输入"
 *   4.76 亿是实数,而 cache_write 恒为 0;
 * - Claude 的 `input_tokens` 既不含缓存读、**也不含缓存写**——它"第一次送进去、
 *   真被处理"的那批全记在 `cache_creation_input_tokens`(= cache_write)里:
 *   新增输入只有 **63,182**,而缓存写有 **63,602,029**。
 *
 * 旧口径(入+出)因此让 Claude 看起来几乎没用过,与事实相反。缓存**读**仍然排除在外:
 * 它是"重看一遍已经送过的上下文",计价约十分之一,归到下面的「总吞吐」里去。
 *
 * 2026-09-09:算式本身搬去 protocol.ts 的 billedTokens——任务卡的「本卡消耗」用的是同一个
 * 口径,两处各写一份迟早会漂。这里只保留这段来龙去脉,它是这个口径唯一写全的地方。
 */
function billed(totals: UsageTotals): number {
  return billedTokens(totals)
}

/** 总吞吐:四项全加——回答"到底过了多少数据"(Ben 追问三次的那个数)。 */
function throughput(totals: UsageTotals): number {
  return totals.input + totals.output + totals.cache_read + totals.cache_write
}

/**
 * 大数收成人眼能读的量级。个位数的 token 没有展示意义,统一进位。
 *
 * **2026-10-03 多了个 `export`**(只多这一个词):他那一版面板
 * (`air/usage.js`,构建产物里叫 `formatTokens$1`)import 的就是这一份 ——
 * 两套面板一个量级口径,两边各写一份迟早会漂。
 */
export function formatTokens(value: number): string {
  if (value >= 1e9) return `${(value / 1e9).toFixed(1)}B`
  if (value >= 1e6) return `${(value / 1e6).toFixed(1)}M`
  if (value >= 1e3) return `${(value / 1e3).toFixed(1)}K`
  return String(Math.round(value))
}

function formatCount(value: number): string {
  return value.toLocaleString('en-US')
}

function mergeInto(target: Record<string, UsageTotals>, source: Record<string, UsageTotals>): void {
  for (const [key, totals] of Object.entries(source)) {
    const current = target[key] ?? emptyTotals()
    target[key] = {
      input: current.input + totals.input,
      output: current.output + totals.output,
      cache_read: current.cache_read + totals.cache_read,
      cache_write: current.cache_write + totals.cache_write,
    }
  }
}

function sortedEntries(bucket: Record<string, UsageTotals>): [string, UsageTotals][] {
  return Object.entries(bucket).sort(([, left], [, right]) => billed(right) - billed(left))
}

/**
 * 热力图的五档强度(顺序色阶,单一色相由浅到深——不是彩虹)。
 * 0 档是"这天没有用量",用极淡的白而不是强调色的最浅档:那样才看得出"空"与"少"的区别。
 */
/** 年历上面那一行月份(评审页 `.months`:「1 月」带字,其余只写数)。 */
const HEAT_MONTHS = ['1 月', '2', '3', '4', '5', '6', '7', '8', '9', '10', '11', '12']

function heatLevel(value: number, max: number): number {
  if (value <= 0 || max <= 0) return 0
  const ratio = value / max
  if (ratio > 0.6) return 4
  if (ratio > 0.3) return 3
  if (ratio > 0.1) return 2
  return 1
}

export interface UsagePanelProps {
  usage: UsageState | { error: string } | undefined
}

/** 来源键 → 界面上的家名(认不出就照原样)。 */
const SOURCE_NAMES: Record<string, string> = { claude: 'Claude', codex: 'Codex', dsh: 'DeepSeek', kimi: 'Kimi' }

/**
 * 各家构成(2026-10-21,视觉 A):范围内按来源累计总消耗(入 + 缓存写 + 出),多的两家各一份,其余并成「其他」。
 * 一家都没有量就是空数组(那一排整个不画)。
 */
export function usageMix(days: readonly UsageDay[]): { label: string, value: number }[] {
  const bucket: Record<string, UsageTotals> = {}
  for (const day of days) mergeInto(bucket, day.by_source)
  const ranked = Object.entries(bucket).map(([key, totals]) => ({ label: SOURCE_NAMES[key] ?? key, value: billed(totals) }))
    .filter(one => one.value > 0).sort((a, b) => b.value - a.value)
  if (ranked.length <= 3) return ranked
  return [...ranked.slice(0, 2), { label: '其他', value: ranked.slice(2).reduce((sum, one) => sum + one.value, 0) }]
}

export function UsagePanel({ usage }: UsagePanelProps) {
  const [tab, setTab] = useState<Tab>('overview')
  const [range, setRange] = useState<Range>(readRange)

  const days: readonly UsageDay[] = usage !== undefined && !('error' in usage) ? usage.days : []
  const scoped = useMemo(() => {
    const limit = RANGE_DAYS[range]
    return limit === Number.MAX_SAFE_INTEGER ? [...days] : days.slice(-limit)
  }, [days, range])

  const byProject = useMemo(() => {
    const bucket: Record<string, UsageTotals> = {}
    for (const day of scoped) mergeInto(bucket, day.by_project)
    return sortedEntries(bucket)
  }, [scoped])

  const byModel = useMemo(() => {
    const bucket: Record<string, UsageTotals> = {}
    for (const day of scoped) mergeInto(bucket, day.by_model)
    return sortedEntries(bucket)
  }, [scoped])

  const total = useMemo(
    () => byProject.reduce((sum, [, totals]) => sum + billed(totals), 0),
    [byProject],
  )

  /**
   * 缓存读/写单独累计(2026-09-02 误读案:Ben 把 5.4B 的缓存读记成了"总消耗",对比
   * 只算入+出的总数 5.49 亿,得出"数字一看就有问题"。Ben 拍板:总数口径不变,缓存
   * 独立成行、处处标清口径——量级差十倍的两类数字必须分开摆,谁也别替谁。)
   */
  const cacheTotals = useMemo(() => {
    let read = 0
    let write = 0
    let total = 0
    for (const [, totals] of byProject) {
      read += totals.cache_read
      write += totals.cache_write
      total += throughput(totals)
    }
    return { read, write, throughput: total }
  }, [byProject])

  /**
   * 缓存命中率只累计 status==='ok' 的来源。
   * partial 来源(字段不全的那种)把它的 0 输入算进分母会让命中率虚高。
   */
  const cacheHitRate = useMemo(() => {
    if (usage === undefined || 'error' in usage) return undefined
    let read = 0
    let input = 0
    for (const day of scoped) {
      for (const [source, totals] of Object.entries(day.by_source)) {
        if (usage.sources[source]?.status !== 'ok') continue
        read += totals.cache_read
        input += totals.input
      }
    }
    const denominator = read + input
    // 分母为 0 时不报 0%——那会被读成"缓存一次没命中"。
    return denominator === 0 ? undefined : Math.round((read / denominator) * 100)
  }, [usage, scoped])

  const overview = useMemo(() => {
    const hours: Record<string, number> = {}
    let sessions = 0
    let messages = 0
    for (const day of scoped) {
      sessions += day.sessions
      messages += day.messages
      for (const [hour, count] of Object.entries(day.hour_counts)) {
        hours[hour] = (hours[hour] ?? 0) + count
      }
    }
    const peak = Object.entries(hours).sort(([, left], [, right]) => right - left)[0]

    // 连续天数:从最后一天往回数,日期断档就停(缺的那天等于没用)。
    const active = new Set(scoped.filter(day => day.messages > 0).map(day => day.date))
    let streak = 0
    const cursor = scoped.length > 0 ? new Date(`${scoped[scoped.length - 1]?.date}T00:00:00Z`) : undefined
    while (cursor !== undefined) {
      const key = cursor.toISOString().slice(0, 10)
      if (!active.has(key)) break
      streak += 1
      cursor.setUTCDate(cursor.getUTCDate() - 1)
    }

    return {
      sessions,
      messages,
      activeDays: active.size,
      streak,
      peakHour: peak?.[0],
      favoriteModel: byModel[0]?.[0],
    }
  }, [scoped, byModel])

  /**
   * 热力图 —— GitHub 式贡献格子图:**列 = 周,行 = 星期几**,铺开整整一年。
   *
   * 为什么铺一年而不是只画有数据的那几天(Ben 两次反馈):
   * - **只画有数据的天铺不满宽度**。7 行的方格图,列数 = 天数/7;65 天只有 10 列,
   *   在 500px 宽的面板里右边空一大片。把格子拉宽就成了长方形,不再是日历。
   *   一年 = 53 列,天然铺满,这也正是 GitHub / Claude 那张图的做法。
   * - **未来格子留着看它被点亮**(Ben 的主意)。窗口是**本自然年 1/1 → 12/31**:
   *   先前用"数据起始那周往后 53 周",结果一直排到次年,年底之后空一大截
   *   (Ben 反馈"2026 年只剩不到 4 个月了,怎么会还有那么长的空")。
   *   按自然年铺,空白就只剩今年余下的那部分,而且会随时间自己变短。
   *
   * 三种状态必须分开,不能合并(D13:不编数、不糊弄):
   * - `future`:还没到的日子。**不是"没有用量"**——把未来伪装成 0 档是在编数。
   * - 0 档:过去某天真的没用。
   * - 1–4 档:有用量,五级强度(同一色相由浅到深)。
   *
   * 首列按第一天是星期几留空,否则整张图的星期对位全错一格。
   */
  const heat = useMemo(() => {
    if (scoped.length === 0) return { cells: [], lit: 0, span: 0, year: 0 }
    const byDate = new Map<string, number>()
    for (const day of scoped) {
      byDate.set(day.date, billed(
        Object.values(day.by_project).reduce((acc, t) => {
          acc.input += t.input; acc.output += t.output
          acc.cache_read += t.cache_read; acc.cache_write += t.cache_write
          return acc
        }, emptyTotals()),
      ))
    }

    const today = new Date()
    const year = today.getFullYear()
    // 本自然年 1 月 1 日 → 12 月 31 日。首列回退到 1 月 1 日所在那周的周一,
    // 否则整张图的星期对位会错一格。
    const start = new Date(Date.UTC(year, 0, 1))
    start.setUTCDate(start.getUTCDate() - ((start.getUTCDay() + 6) % 7))
    const end = new Date(Date.UTC(year, 11, 31))

    const todayKey = today.toISOString().slice(0, 10)
    const max = [...byDate.values()].reduce((top, value) => Math.max(top, value), 0)
    const cells: { date: string, value: number, level: number, future: boolean }[] = []
    const cursor = new Date(start)
    let lit = 0
    let span = 0
    while (cursor <= end) {
      const date = cursor.toISOString().slice(0, 10)
      const value = byDate.get(date) ?? 0
      const future = date > todayKey
      const inYear = date.slice(0, 4) === String(year)
      if (value > 0) lit += 1
      if (inYear) span += 1
      cells.push({ date, value, level: future ? 0 : heatLevel(value, max), future })
      cursor.setUTCDate(cursor.getUTCDate() + 1)
    }
    return { cells, lit, span, year }
  }, [scoped])

  const mix = useMemo(() => usageMix(scoped), [scoped])

  const scannedClock = usage !== undefined && !('error' in usage) ? clockOf(usage.scanned_at) : undefined
  const notes = usage !== undefined && !('error' in usage)
    ? Object.entries(usage.sources).filter(([, meta]) => meta.status !== 'ok')
    : []

  if (usage === undefined) {
    return <div className="ben-wb__scroll"><p className="ben-wb__empty">用量未接入</p></div>
  }
  if ('error' in usage) {
    return (
      <div className="ben-wb__scroll">
        <p className="ben-wb__pj-calc ben-wb__pj-calc--error">用量未接入:{usage.error}</p>
      </div>
    )
  }

  return (
    <div className="ben-wb__scroll ben-wb__usage">
      <div className="ben-wb__usage-bar">
        <div className="ben-wb__usage-seg" role="tablist" aria-label="用量视图">
          {(Object.keys(TAB_LABELS) as Tab[]).map(key => (
            <button
              key={key}
              type="button"
              role="tab"
              aria-selected={tab === key}
              className="ben-wb__usage-segbtn"
              data-on={tab === key}
              onClick={() => setTab(key)}
            >
              {TAB_LABELS[key]}
            </button>
          ))}
        </div>
        <div className="ben-wb__usage-seg" role="group" aria-label="时间范围">
          {(Object.keys(RANGE_LABELS) as Range[]).map(key => (
            <button
              key={key}
              type="button"
              className="ben-wb__usage-segbtn"
              data-on={range === key}
              aria-pressed={range === key}
              onClick={() => { setRange(key); saveRange(key) }}
            >
              {RANGE_LABELS[key]}
            </button>
          ))}
        </div>
      </div>

      {tab !== 'overview' && (
        <div className="ben-wb__usage-hero">
          <span className="ben-wb__usage-hero-v">{formatTokens(total)}</span>
          <span className="ben-wb__usage-hero-l">
            入+缓存写+出
            {cacheHitRate === undefined ? '' : ` · 缓存命中 ${cacheHitRate}%`}
          </span>
        </div>
      )}

      {tab === 'project' && (
        <RankList entries={byProject} total={total} />
      )}

      {tab === 'model' && (
        <RankList
          entries={byModel}
          total={total}
          subline={totals => `${formatTokens(totals.input)} in · ${formatTokens(totals.output)} out`}
        />
      )}

      {tab === 'overview' && (
        <>
          <div className="ben-wb__usage-tiles">
            <Tile
              primary
              label="总吞吐"
              value={formatTokens(cacheTotals.throughput)}
              sub={`总消耗 ${formatTokens(total)}`}
            />
            <div className="ben-wb__usage-group ben-wb__usage-activity" role="group" aria-label="活动统计">
            <Tile label="会话" value={formatCount(overview.sessions)} />
            <Tile label="消息" value={formatCount(overview.messages)} />
            </div>
          </div>

          {mix.length > 0 && (
            <div className="ben-wb__usage-mix">
              <StackRungs label="各家构成" parts={mix} cells={48} />
              <span className="ben-wb__usage-mixlegend">
                {mix.map((one, at) => (
                  <span key={one.label}><i data-part={Math.min(at, 2)} aria-hidden="true" />{one.label} <b>{formatTokens(one.value)}</b></span>
                ))}
              </span>
            </div>
          )}

          {heat.cells.length > 0 && (
            <figure className="ben-wb__usage-heatwrap" aria-label="年度用量">
              <div className="ben-wb__usage-heathead">
                <span>{heat.year} 年 · 一格一天</span>
                <span className="ben-wb__usage-heatlegend" role="group" aria-label="用量强度">
                  <span>少</span>
                  {[0, 1, 2, 3, 4].map(level => <span key={level} className="ben-wb__usage-heatcell" data-level={level} aria-hidden="true" />)}
                  <span>多</span>
                </span>
              </div>
              <div className="ben-wb__usage-heat">
                {/* 星期几栏。只标一/三/五——七个全标太密,GitHub 也是隔行标。
                    没有这一栏,再规整的格子也读不出"这是日历"。 */}
                <div className="ben-wb__usage-heatdays" aria-hidden="true">
                  {['一', '', '三', '', '五', '', ''].map((label, index) => (
                    <span key={index}>{label}</span>
                  ))}
                </div>
                <div className="ben-wb__usage-heatmain">
                {/* 月份一行(2026-10-22 评审页 `.months`):整年铺开,两端对齐;读屏不念(格子的说明里已经有日期)。 */}
                <div className="ben-wb__usage-heatmonths" aria-hidden="true">
                  {HEAT_MONTHS.map(label => <span key={label}>{label}</span>)}
                </div>
                <div
                  className="ben-wb__usage-heatgrid"
                  role="img"
                  aria-label={`一年用量方格图,列为周、行为星期几,已点亮 ${heat.lit} 天`}
                >
                  {heat.cells.map(cell => (
                    <span
                      key={cell.date}
                      className="ben-wb__usage-heatcell"
                      data-level={cell.level}
                      data-future={cell.future}
                      title={cell.future
                        ? `${cell.date}:还没到`
                        : cell.value === 0 ? `${cell.date}:没有用量` : `${cell.date}:${formatTokens(cell.value)}`}
                    />
                  ))}
                </div>
                </div>
              </div>
              <figcaption className="ben-wb__usage-heatcap">明度表示用量 · 已点亮 {heat.lit} / {heat.span} 天</figcaption>
            </figure>
          )}
          <div className="ben-wb__usage-group ben-wb__usage-cache" role="group" aria-label="缓存统计">
            <h3>缓存</h3>
            <Tile label="缓存读" value={formatTokens(cacheTotals.read)} />
            <Tile label="缓存写" value={formatTokens(cacheTotals.write)} />
            <Tile label="缓存命中" value={cacheHitRate === undefined ? '未接入' : `${cacheHitRate}%`} />
          </div>
          <div className="ben-wb__usage-group ben-wb__usage-habits" role="group" aria-label="使用习惯">
            <h3>使用习惯</h3>
            <Tile label="活跃天数" value={String(overview.activeDays)} />
            <Tile label="连续天数" value={`${overview.streak}d`} />
            <Tile label="高峰时段" value={overview.peakHour === undefined ? '未接入' : `${overview.peakHour}:00`} />
            <Tile label="常用模型" value={overview.favoriteModel ?? '未接入'} />
          </div>
          {/* ★ 没接上用量的那几家(2026-10-02 运营同学 Air 那一版)。
              他那一格原来显示一个「豆包办公 0」—— 看上去像"今天一次都没用",而真相是
              **我们这儿没有它的用量来源**。于是单开这一块:写「未接入用量」,
              并且明说不计入上面任何一个合计(`USAGE_NOT_WIRED_FAMILIES`)。 */}
          <div className="ben-wb__usage-group ben-wb__usage-unwired" role="group" aria-label="还没有用量来源的">
            <h3>没有用量来源</h3>
            {USAGE_NOT_WIRED_FAMILIES.map(family => (
              <Tile key={family.id} label={family.name} value={USAGE_NOT_WIRED} sub={family.why} />
            ))}
            <p className="ben-wb__usage-hint">{USAGE_NOT_WIRED_NOT_COUNTED}</p>
          </div>

          <details className="ben-wb__usage-method">
            <summary><span>本机记录{scannedClock === undefined ? '' : ` · ${scannedClock}`}</span><span>{USAGE_METHOD_LABEL} ›</span></summary>
            <p className="ben-wb__usage-hint">
              总吞吐 = 入 + 缓存写 + 出 + 缓存读;总消耗 = 入 + 缓存写 + 出(计费口径,排行与热力图按它排)。
              缓存读 = 每轮重读上下文,计价约为输入的十分之一,所以缓存读通常是总消耗的几十倍——
              这是长上下文的正常形态,不是数据错。「All」= 有日志的全部区间,缺的月份不假装有。
            </p>
            {/* Kimi 的覆盖范围(2026-10-27 重新接上,任务书原文):普通聊天在云端跑、本机没数据,
                写明「未计入」——不按 0 填。Kimi 缺席(没装/没数到)时这一句也不出现。 */}
            {(usage.sources.kimi !== undefined || scoped.some(day => day.by_source.kimi !== undefined)) && (
              <p className="ben-wb__usage-hint">Kimi 只计命令行和桌面版本机 Agent,普通聊天未计入。</p>
            )}
            {/* 这两句**是服务端给的**(usage/collector.ts 的 view()):按哪个时区切天、这份数覆盖到哪。
                老服务端不带这两个字段时整句缺席 —— 不自己编一个口径(D13)。 */}
            {(usage.timezone !== undefined || usage.scope !== undefined) && (
              <p className="ben-wb__usage-hint">
                {[
                  usage.timezone === undefined ? undefined : `按天切片用的时区:${usage.timezone}`,
                  usage.scope === undefined ? undefined : `范围:${usage.scope}`,
                ].filter(one => one !== undefined).join(' · ')}
              </p>
            )}
          </details>
        </>
      )}

      {/* 残缺 / 没接上的来源收成一行(评审页异常档),展开才见各家;上面的数照常,缺的那家不按 0 计。 */}
      {notes.length > 0 && (
        <details className="ben-wb__usage-stale">
          <summary><span>{USAGE_STALE_LINE(notes.length)}</span><span>查看原因 ›</span></summary>
          <ul>
            {notes.map(([source, meta]) => (
              <li key={source}>
                {source} · {meta.status === 'partial' ? '残缺口径' : '未接入'}
                {meta.note === undefined ? '' : ` — ${meta.note}`}
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  )
}

/** ISO → 本地「HH:MM」;读不出来 → undefined(格脚那半句就不写时刻)。 */
function clockOf(iso: string): string | undefined {
  const at = new Date(iso)
  if (Number.isNaN(at.getTime())) return undefined
  return `${String(at.getHours()).padStart(2, '0')}:${String(at.getMinutes()).padStart(2, '0')}`
}

/**
 * 排行榜。条形按数据可视化规范:单一色相顺序色阶、轨道常显(看得出"占比多少"而不只是
 * "有多长")、数据端 4px 圆角。数值用等宽数字右对齐,列间才对得齐。
 */
function RankList({ entries, total, subline }: {
  entries: readonly [string, UsageTotals][]
  total: number
  subline?: (totals: UsageTotals) => string
}) {
  if (entries.length === 0) {
    return <p className="ben-wb__empty">这段时间没有用量记录</p>
  }

  const shown = entries.slice(0, RANK_LIMIT)
  const restValue = entries.slice(RANK_LIMIT).reduce((sum, [, totals]) => sum + billed(totals), 0)
  const restCount = entries.length - shown.length
  const top = billed(shown[0]?.[1] ?? emptyTotals())

  return (
    <div className="ben-wb__usage-rank">
      {shown.map(([name, totals]) => {
        const value = billed(totals)
        // 条长按"相对第一名"而不是"占总量"——占总量时第一名之后全挤成一条缝。
        const width = top === 0 ? 0 : Math.max(2, Math.round((value / top) * 100))
        const share = total === 0 ? 0 : Math.round((value / total) * 100)
        return (
          <div className="ben-wb__usage-rankrow" key={name} title={`${name}:${formatTokens(value)}(${share}%)`}>
            <div className="ben-wb__usage-rankhead">
              <span className="ben-wb__usage-rankname">{name}</span>
              <span className="ben-wb__usage-rankval">{formatTokens(value)}</span>
            </div>
            <div className="ben-wb__usage-rankbar">
              <span className="ben-wb__usage-rankfill" style={{ width: `${width}%` }} />
            </div>
            {subline !== undefined && <p className="ben-wb__usage-ranksub">{subline(totals)}</p>}
          </div>
        )
      })}

      {restCount > 0 && (
        <p className="ben-wb__usage-rest">
          其余 {restCount} 项合计 {formatTokens(restValue)}
        </p>
      )}
    </div>
  )
}

/** `sub` 是同一格里的次要口径小字(总览主格用它摆总消耗),不是第二个数字格。 */
function Tile({ label, value, primary = false, sub }: { label: string, value: string, primary?: boolean, sub?: string }) {
  return (
    <div className={`ben-wb__usage-tile${primary ? ' ben-wb__usage-tile--primary' : ''}`}>
      <p className="ben-wb__usage-tile-l">{label}</p>
      <p className="ben-wb__usage-tile-v" title={value}>{value}</p>
      {sub !== undefined && <p className="ben-wb__usage-tile-sub">{sub}</p>}
    </div>
  )
}
