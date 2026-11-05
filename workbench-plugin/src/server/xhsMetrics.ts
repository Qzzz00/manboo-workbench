/**
 * 小红书创作者中心那八个数的**纯解析层**(2026-09-21 写,2026-09-22 按真页面重写标签)。
 *
 * 这个文件**一行 I/O 都没有**:输入是一段「页面上看得见的文字」(document.innerText),
 * 输出是八个指标里取到了哪几个。开浏览器、落盘、算环比在 xhsCreator.ts / xhsStore.ts。
 *
 * ## 2026-09-22:标签不再是猜的了
 *
 * 9/21 那一版的候选标签是照公开资料猜的(文件头当时写明「这一列是猜的」)。
 * 9/22 统筹会话在 Ben 登录后的专用窗口里**实测**了两页,于是这一版换成真标签:
 *
 * | 页 | 是什么 | 给哪几个指标 |
 * |---|---|---|
 * | `/new/home`(首页) | **账号级总览**。「统计周期 MM-DD 至 MM-DD」+ 近7日/近30日两颗切换按钮 | 曝光数、观看数、封面点击率、点赞数、收藏数、**净涨粉** |
 * | `/statistics/data-analysis` | **按笔记的表**,一行一篇 + 「发布于 日期」+ 分页 | 笔记发布数(数出来的,见 xhsNotesTable.ts) |
 *
 * 9/21 默认指的 `/statistics/data-analysis` **不是**账号级总览,它是按笔记的表 ——
 * 上一版把它当成「近 7 日」那一页是错的,这一版改掉了。
 *
 * ## 首页**没有**的两项
 *
 * - **笔记发布数**:首页不给。从按笔记的表按「发布于」日期数出来(xhsNotesTable.ts),
 *   数不全的时候**缺席**,不给一个偏小的数。
 * - **平均观看时长**:首页不给,按笔记的表里只有**每篇**的「人均观看时长」。
 *   把那一列按范围内的笔记取个平均是**我们算的、不是平台给的**,而且要先把
 *   每行的十个数字按列位对上 —— 那正是这份代码一直在防的「抓串行」。
 *   所以这一版**留空**,界面上写「平台没给」并把上面这句话说出来(`absent_why`)。
 *   (可推翻:决策记录 2026-09-22「技术选择」那一节。)
 *
 * ## 一个数都不编
 *
 * - 标签找不到 → 这一项缺席,界面显示「后台没有这项 / 平台没给」;
 * - 标签找到了但旁边那串不是数 → 一样缺席,**绝不退回 0**;
 * - 解析出来的形态与这个指标该有的形态对不上(比如「封面点击率」旁边是个时长)→ 也缺席;
 * - 往下找值的时候**撞上「环比」就停** —— 首页每个数下面都跟着一行「环比-12%」,
 *   让「封面点击率」抓到那个百分比是这一页上最容易犯、又最看不出来的一种编数;
 * - 一个标签都没找到 → 整页判为「页面变了」,而不是「八项全是 0」。
 */

/** 数据范围。Ben 草图上就这两个,与 client/ReviewModule.tsx 的 REVIEW_RANGES 同一份口径。 */
export const XHS_RANGES = ['近 7 日', '近 30 日'] as const
export type XhsRange = typeof XHS_RANGES[number]

/** 一个范围要回看多少天。算环比时用它找"上一周期那一天",数笔记时用它定窗口。 */
export const XHS_RANGE_DAYS: Readonly<Record<XhsRange, number>> = {
  '近 7 日': 7,
  '近 30 日': 30,
}

/** 八个指标的机器名。顺序就是 Ben 草图上从左到右的顺序。 */
export const XHS_METRIC_KEYS = [
  'notes', 'impressions', 'views', 'cover_ctr',
  'likes', 'favorites', 'new_fans', 'avg_watch',
] as const
export type XhsMetricKey = typeof XHS_METRIC_KEYS[number]

/**
 * 一个指标该长什么形状。**解析出来的形状对不上就算没取到** ——
 * 「封面点击率」那一格里冒出来一个 12000,多半是抓串行了,宁可缺席。
 */
export type XhsMetricKind = 'count' | 'percent' | 'seconds'

/**
 * 这一项**从哪来**。9/22 加的,因为八个指标现在来自三处不同的地方,
 * 而「首页上找不到它」与「首页上本来就没有它」是两句不同的实话。
 */
export type XhsMetricSource = 'overview' | 'note_table' | 'none'

export interface XhsMetricDef {
  key: XhsMetricKey
  /** 界面上的名字,逐字取自 Ben 的运营草图。 */
  label: string
  kind: XhsMetricKind
  source: XhsMetricSource
  /**
   * 在页面文字里找它的候选标签,**从长到短**匹配。
   * 2026-09-22 起第一条是**实测到的真标签**,后面几条是改版退路。
   */
  aliases: readonly string[]
  /** 这一项天生取不到时,界面上除了「平台没给」还要补的那一句。 */
  absent_why?: string
}

/** 平均观看时长为什么永远是空的。界面与交接共用这一句,别写第二份。 */
export const AVG_WATCH_ABSENT_WHY
  = '平台没给:首页的账号总览里没有这一项,按笔记的表里只有每篇的「人均观看时长」——'
    + '按范围内的笔记取平均是我们算的、不是平台给的,而且要先按列位把每行十个数字对上,'
    + '猜错一列就会把「弹幕」当成时长。这一版不猜。'

/** 笔记发布数为什么有时候是空的。 */
export const NOTES_FROM_TABLE_WHY = '数的是按笔记的表里「发布于」在这个范围内的行数(首页的账号总览没有这一项)。'

/**
 * 八个指标的定义。
 *
 * `label` 是 Ben 草图上的原话;`aliases` 第一条是 2026-09-22 在真页面上看到的那个词
 * (首页那六项),后面几条留作改版退路。
 */
export const XHS_METRICS: readonly XhsMetricDef[] = [
  {
    key: 'notes',
    label: '笔记发布数',
    kind: 'count',
    source: 'note_table',
    // 首页上**没有**这一项。这里一条 alias 都不留:「笔记数」会撞上首页的「笔记数据总览」,
    // 而它下面第二行是「统计周期 09-15 至 09-21」—— 那一行里的 09 会被读成 9 篇笔记。
    aliases: [],
    absent_why: NOTES_FROM_TABLE_WHY,
  },
  { key: 'impressions', label: '曝光数', kind: 'count', source: 'overview', aliases: ['曝光数', '曝光量', '曝光人次', '曝光'] },
  { key: 'views', label: '观看数', kind: 'count', source: 'overview', aliases: ['观看数', '观看量', '阅读量', '观看人次'] },
  { key: 'cover_ctr', label: '封面点击率', kind: 'percent', source: 'overview', aliases: ['封面点击率', '点击率'] },
  { key: 'likes', label: '点赞数', kind: 'count', source: 'overview', aliases: ['点赞数', '点赞量', '获赞数'] },
  { key: 'favorites', label: '收藏数', kind: 'count', source: 'overview', aliases: ['收藏数', '收藏量'] },
  {
    key: 'new_fans',
    label: '涨粉数',
    kind: 'count',
    source: 'overview',
    // ★ 真页面上写的是「净涨粉」(= 新增关注 - 取消关注),排在最前。
    //   「新增关注」故意**不做** alias:它比净涨粉大,拿它冒充涨粉数是往好看了编。
    aliases: ['净涨粉', '涨粉数', '新增粉丝数', '粉丝增长'],
  },
  {
    key: 'avg_watch',
    label: '平均观看时长',
    kind: 'seconds',
    source: 'none',
    aliases: [],
    absent_why: AVG_WATCH_ABSENT_WHY,
  },
]

/** 首页那一页上真能取到的六项。`parseCreatorPage` 只扫这几个。 */
export const XHS_OVERVIEW_KEYS: readonly XhsMetricKey[]
  = XHS_METRICS.filter(def => def.source === 'overview').map(def => def.key)

export function metricDefOf(key: XhsMetricKey): XhsMetricDef {
  const found = XHS_METRICS.find(def => def.key === key)
  // XHS_METRIC_KEYS 与 XHS_METRICS 同源,找不到只可能是有人改了一头忘了另一头。
  if (found === undefined) throw new Error(`没有这个指标:${key}`)
  return found
}

/**
 * 取到的一个数。`raw` 是**页面上原样那串**,界面显示它,不重新格式化(「1.2万」就是「1.2万」)。
 *
 * `derived` 只在**合计那一行**上出现(见 xhsTotal.ts):那一格的数是我们加出来/加权算出来的,
 * 不是任何一页上写着的字,所以必须在界面上自报家门。页面上直接读到的数**永远没有** `derived`。
 */
export interface XhsMetricValue {
  /** 归一化后的数:count 是个数,percent 是百分点(12.3 表示 12.3%),seconds 是秒。 */
  value: number
  raw: string
  /** 这个数是算出来的时候,一句话说清怎么算的(「合计」「按曝光加权」)。 */
  derived?: string
}

/**
 * 把页面上那串中文数字读成一个数。**读不出来回 undefined,绝不退回 0**。
 *
 * 认得:`1,234` `1234` `12.3%` `1.2万` `3.5亿` `1千` `00:12` `1:02:03` `12秒` `1分23秒`。
 * 返回值带 kind,调用方拿它和指标该有的形状对一遍。
 */
export function parseXhsNumber(raw: string): { value: number, kind: XhsMetricKind } | undefined {
  const text = raw.trim()
  if (text === '') return undefined

  // 时长:mm:ss 或 hh:mm:ss。**先于纯数字判**,否则 `00:12` 会被当成 0。
  const clock = /^(\d{1,2}):([0-5]\d)(?::([0-5]\d))?$/.exec(text)
  if (clock !== null) {
    const a = Number(clock[1]); const b = Number(clock[2]); const c = clock[3]
    const seconds = c === undefined ? a * 60 + b : a * 3600 + b * 60 + Number(c)
    return { value: seconds, kind: 'seconds' }
  }

  // 时长:「1分23秒」「23秒」「1分」。
  const cn = /^(?:(\d+(?:\.\d+)?)\s*(?:分钟|分))?\s*(?:(\d+(?:\.\d+)?)\s*秒)?$/.exec(text)
  if (cn !== null && (cn[1] !== undefined || cn[2] !== undefined)) {
    const minutes = cn[1] === undefined ? 0 : Number(cn[1])
    const seconds = cn[2] === undefined ? 0 : Number(cn[2])
    return { value: minutes * 60 + seconds, kind: 'seconds' }
  }

  // 百分比。
  const percent = /^([+-]?\d+(?:,\d{3})*(?:\.\d+)?)\s*%$/.exec(text)
  if (percent !== null) {
    const value = Number((percent[1] ?? '').replace(/,/g, ''))
    return Number.isFinite(value) ? { value, kind: 'percent' } : undefined
  }

  // 计数,可带「万 / 亿 / 千」。
  const count = /^([+-]?\d+(?:,\d{3})*(?:\.\d+)?)\s*(万|亿|千)?$/.exec(text)
  if (count !== null) {
    const base = Number((count[1] ?? '').replace(/,/g, ''))
    if (!Number.isFinite(base)) return undefined
    const scale = count[2] === '万' ? 10_000 : count[2] === '亿' ? 100_000_000 : count[2] === '千' ? 1_000 : 1
    return { value: base * scale, kind: 'count' }
  }

  return undefined
}

/** 页面上一个数字长什么样(供在一行里往后找)。与 parseXhsNumber 认得的集合保持一致。 */
const NUMBER_TOKEN = /(?:\d{1,2}:[0-5]\d(?::[0-5]\d)?|\d+(?:\.\d+)?\s*分钟?\s*\d+(?:\.\d+)?\s*秒|\d+(?:\.\d+)?\s*秒|[+-]?\d+(?:,\d{3})*(?:\.\d+)?\s*(?:%|万|亿|千)?)/g

/**
 * 往下找值的时候撞上这几个词就停。
 *
 * ★ 「环比」这一条是 2026-09-22 真页面逼出来的:首页每个数下面都跟着一行「环比-12%」。
 * 万一某一项的值那一行没渲染出来,「封面点击率」就会往下抓到那个 `-12%` ——
 * 形状还正好对得上(都是百分比),于是界面上会出现一个**看不出来是错的**错数。
 */
const LOOKAHEAD_STOP = ['环比', '统计周期'] as const

/**
 * 一整页取出来的东西。
 *
 * `state` 三档,**各自对应界面上一句不同的实话**:
 * - `ok`:至少认出一个标签(哪怕值没取到)。缺的那几项界面说「后台没有这项」。
 * - `logged_out`:页面就是登录页。界面说「登录态过期了,去设置里重登一次」。
 * - `layout_changed`:页面有内容,但首页那六个指标的标签一个都没出现。
 *   界面说「后台页面变了,等更新」,**并且不重试轰炸**(见 xhsCreator.ts 的闸)。
 */
export interface XhsPageParse {
  state: 'ok' | 'logged_out' | 'layout_changed'
  metrics: Partial<Record<XhsMetricKey, XhsMetricValue>>
  /** 认出了标签但值读不出来的那几项。交接与自取记录里如实写出来。 */
  label_seen_no_value: XhsMetricKey[]
  /** 首页上「统计周期 09-15 至 09-21」那一整行,原样。切范围时靠它确认页面真的换了。 */
  period?: string
}

/** 登录页的特征字串(2026-09-21 实测未登录页原文)。命中即判「没登录」。 */
const LOGIN_MARKERS = ['短信登录', '登录即同意', '发送验证码'] as const

/** 首页上那行「统计周期 …」的标签。切范围确认靠它。 */
export const XHS_PERIOD_LABEL = '统计周期'

/**
 * 把「统计周期 09-15 至 09-21」那一整行原样取出来。没有就回 undefined。
 *
 * 它是**切范围唯一的硬证据**:近7日与近30日是同一页上的两颗按钮,地址栏一个字都不变,
 * 所以「点完之后这一行变了没有」就是"这一份到底是不是 30 日那一份"的全部依据。
 * 变不了就**不存这一份**(存了就是把同一份数当成两份,那是编得看不出来的那种编)。
 */
export function periodLineOf(pageText: string): string | undefined {
  for (const line of pageText.split('\n')) {
    const trimmed = line.trim()
    if (trimmed.includes(XHS_PERIOD_LABEL)) return trimmed
  }
  return undefined
}

/**
 * 把首页(`/new/home`)的可见文字解析成指标。
 *
 * 找法:把文字切成行 → 对**首页那六项**按 `aliases` 从长到短找**第一处**出现 →
 * 先在同一行里取标签后面的第一个数字;同一行没有就往下看最多两行。
 * **往下看的那两行如果是别的指标的标签、或者是「环比 / 统计周期」,就停。**
 *
 * @param pageText - 页面可见文字(`document.body.innerText`)
 * @param labels - 覆盖后的候选标签表(默认用 XHS_METRICS 里那份)
 */
export function parseCreatorPage(
  pageText: string,
  labels: Readonly<Partial<Record<XhsMetricKey, readonly string[]>>> = {},
): XhsPageParse {
  const metrics: Partial<Record<XhsMetricKey, XhsMetricValue>> = {}
  const labelSeen: XhsMetricKey[] = []

  const lines = pageText.split('\n').map(line => line.trim()).filter(line => line !== '')
  const joined = lines.join('\n')

  if (LOGIN_MARKERS.some(marker => joined.includes(marker))) {
    return { state: 'logged_out', metrics: {}, label_seen_no_value: [] }
  }

  const period = periodLineOf(pageText)

  const aliasesOf = (def: XhsMetricDef): readonly string[] => {
    const override = labels[def.key]
    return override !== undefined && override.length > 0 ? override : def.aliases
  }

  /** 只扫首页上真有的那几项。`notes` / `avg_watch` 不在这儿取,见文件头。 */
  const scanned = XHS_METRICS.filter(def => aliasesOf(def).length > 0)
  /** 所有被扫指标的所有标签,用来判断"往下那一行是不是已经属于别人了"。 */
  const allAliases = scanned.flatMap(def => aliasesOf(def))

  let anyLabel = false

  for (const def of scanned) {
    const aliases = [...aliasesOf(def)].sort((a, b) => b.length - a.length)
    let hit: { line: number, after: string } | undefined
    outer: for (const alias of aliases) {
      for (const [index, line] of lines.entries()) {
        const at = line.indexOf(alias)
        if (at < 0) continue
        hit = { line: index, after: line.slice(at + alias.length) }
        break outer
      }
    }
    if (hit === undefined) continue

    anyLabel = true
    const candidates: string[] = []
    // 同一行标签之后。
    candidates.push(...(hit.after.match(NUMBER_TOKEN) ?? []))
    // 同一行没有就往下最多两行,遇到别的标签 / 「环比」 / 「统计周期」就停。
    if (candidates.length === 0) {
      for (let offset = 1; offset <= 2; offset++) {
        const next = lines[hit.line + offset]
        if (next === undefined) break
        if (LOOKAHEAD_STOP.some(word => next.includes(word))) break
        if (allAliases.some(alias => next.includes(alias))) break
        const found = next.match(NUMBER_TOKEN) ?? []
        if (found.length > 0) { candidates.push(...found); break }
      }
    }

    // 取第一个**形状对得上**的。对不上一律当没取到(D13:宁可缺席,不许错位)。
    const picked = candidates
      .map(raw => ({ raw: raw.trim(), parsed: parseXhsNumber(raw) }))
      .find(item => item.parsed !== undefined && item.parsed.kind === def.kind)

    if (picked?.parsed === undefined) labelSeen.push(def.key)
    else metrics[def.key] = { value: picked.parsed.value, raw: picked.raw }
  }

  return {
    state: anyLabel ? 'ok' : 'layout_changed',
    metrics,
    label_seen_no_value: labelSeen,
    ...(period === undefined ? {} : { period }),
  }
}

/**
 * 把覆盖文件里那份标签表读成可用的形状。**认不出的键一律丢掉**
 * (覆盖文件是用户可以手改的,一个错键不该把整份覆盖废掉,更不该让服务崩)。
 */
export function mergeLabelOverrides(raw: unknown): Partial<Record<XhsMetricKey, readonly string[]>> {
  if (typeof raw !== 'object' || raw === null) return {}
  const source = (raw as { labels?: unknown }).labels
  if (typeof source !== 'object' || source === null) return {}
  const out: Partial<Record<XhsMetricKey, readonly string[]>> = {}
  for (const key of XHS_METRIC_KEYS) {
    const value = (source as Record<string, unknown>)[key]
    if (!Array.isArray(value)) continue
    const list = value.filter((item): item is string => typeof item === 'string' && item.trim() !== '')
    if (list.length > 0) out[key] = list
  }
  return out
}
