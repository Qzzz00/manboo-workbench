/**
 * 「事务官的建议」那三条(2026-09-21)。运营同事的原话是
 * 「希望能够实时同步数据看板,**并进一步给出优化建议**」。
 *
 * 这个文件也是**纯的**:拼提示词、把模型回的那几行读成结构、把依据拼出来。
 * 真去调模型在 xhsCreator.ts(注入一个 `chat`,用例里打桩)。
 *
 * ## ★ 依据里的数字由**代码**算,模型一个数都不许心算
 *
 * 同 holidays.ts 那条纪律(决策记录 2026-09-19 第 6 条)。做法是把职责切开:
 *
 * - **模型只做一件事**:从我们给的涨跌清单里挑一个指标,说一句"因此该怎么做";
 * - **依据那一句由我们拼**:`曝光数 9.9万 → 7.7万(-22%,对 9 月 14 日那份)`。
 *
 * 所以模型哪怕把数字说错了,写进模块里的依据仍然是对的 —— 因为那一句根本不经过它。
 * 它挑的指标不在清单里(编了一个、或者挑了一个没有环比的),那一条**整条丢掉**。
 *
 * ## 没数据就不生成
 *
 * 卡里写死的一条。判据是 `advisableChanges` 回空数组 —— 一个指标都没有"本期与上期
 * 都取到"时,连提示词都不拼,更不会去调模型。界面上那一块整块缺席,
 * 而不是显示三条正确的废话。
 */
import type { XhsAdviceView, XhsRangeView } from '../protocol.ts'
import type { XhsMetricKind } from './xhsMetrics.ts'

/** 一个指标这一期与上一期的对比。**全部由代码算**。 */
export interface XhsChange {
  key: string
  label: string
  kind: XhsMetricKind
  now: number
  nowRaw: string
  before: number
  beforeRaw: string
  /** 相对变化的百分比,四舍五入到整数。上期是 0 时缺席(除不了,**不编一个数**)。 */
  percent?: number
  /** 上一周期那份快照是哪天取的。 */
  sinceDate: string
}

/** 能拿来当依据的那几个指标:**本期与上期都取到**的才算。 */
export function advisableChanges(view: XhsRangeView | undefined): XhsChange[] {
  if (view === undefined) return []
  const out: XhsChange[] = []
  for (const metric of view.metrics) {
    if (metric.value === undefined || metric.raw === undefined || metric.prev === undefined) continue
    const before = metric.prev.value
    out.push({
      key: metric.key,
      label: metric.label,
      kind: metric.kind,
      now: metric.value,
      nowRaw: metric.raw,
      before,
      beforeRaw: metric.prev.raw,
      // 上期是 0 时"涨了多少倍"没有意义,整块缺席 —— 界面只说绝对值的变化。
      ...(before === 0 ? {} : { percent: Math.round(((metric.value - before) / Math.abs(before)) * 100) }),
      sinceDate: metric.prev.date,
    })
  }
  return out
}

/** 日期说成人话:`2026-09-14` → `9 月 14 日`。认不出就原样回。 */
export function friendlyDate(date: string): string {
  const parts = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date)
  if (parts === null) return date
  return `${Number(parts[2])} 月 ${Number(parts[3])} 日`
}

/** 依据那一句。**这一句里的每个数都是代码算的**。 */
export function basisLine(change: XhsChange): string {
  const delta = change.percent === undefined
    ? (change.now > change.before ? '涨了' : change.now < change.before ? '跌了' : '没变')
    : `${change.percent > 0 ? '+' : ''}${change.percent}%`
  return `${change.label} ${change.beforeRaw} → ${change.nowRaw}(${delta},对 ${friendlyDate(change.sinceDate)}那一份)`
}

/**
 * 给模型的那段话。**把涨跌清单摆出来,让它只挑一个指标 + 说一句怎么做**。
 *
 * 格式故意定得很死(`指标名|一句建议`),因为这一段的产物要直接上屏:
 * 读不成这个格式的行一律丢掉,宁可少一条也不把一段自由发挥贴到界面上。
 */
export function buildAdvicePrompt(range: string, changes: readonly XhsChange[]): string {
  const rows = changes.map(change => `- ${change.key}(${change.label}):${basisLine(change)}`).join('\n')
  return [
    '你在帮一位小红书运营同事做数据复盘。下面是她自己后台里这个周期与上一个周期的对比,',
    `范围是「${range}」。数字已经算好了,**你不要再算、也不要改写任何数字**。`,
    '',
    rows,
    '',
    '请挑出最值得动的三个指标,每个写一句**下一条内容该怎么做**的具体动作。要求:',
    '1. 每行的格式必须是 `指标机器名|一句建议`,机器名就是上面括号前面那个英文词;',
    '2. 一行一条,最多三行,不要标号、不要解释、不要前后缀;',
    '3. 建议里**不要出现任何数字**(依据由系统自己拼,你写了也会被丢掉);',
    '4. 只挑上面列出来的指标,列表里没有的一个都不要提。',
  ].join('\n')
}

/** 模型回的一条。 */
export interface XhsAdviceDraft {
  key: string
  text: string
}

/**
 * 把模型回的那几行读成结构。**认不出的行一律丢掉**,不去猜它想说什么。
 *
 * @param reply - 模型原样回的文本
 * @param allowed - 清单里有的指标机器名。不在里面的(模型编的)整条丢掉
 */
export function parseAdviceReply(reply: string, allowed: readonly string[]): XhsAdviceDraft[] {
  const known = new Set(allowed)
  const seen = new Set<string>()
  const out: XhsAdviceDraft[] = []
  for (const line of reply.split('\n')) {
    // 有的模型会把 | 写成全角,或者在前面加一个「- 」。这两处宽容,别的一律不猜。
    const cleaned = line.trim().replace(/^[-*]\s*/, '').replace(/｜/g, '|')
    const at = cleaned.indexOf('|')
    if (at < 0) continue
    const key = cleaned.slice(0, at).trim()
    const text = cleaned.slice(at + 1).trim()
    if (key === '' || text === '') continue
    if (!known.has(key)) continue
    // 同一个指标只收第一条:三条建议都挂在同一个数上,对用户来说只是一条。
    if (seen.has(key)) continue
    seen.add(key)
    out.push({ key, text })
    if (out.length === 3) break
  }
  return out
}

/** 把草稿配上代码算好的依据。配不上依据的(理论上进不来)整条丢掉。 */
export function composeAdvice(
  drafts: readonly XhsAdviceDraft[],
  changes: readonly XhsChange[],
  range: string,
  at: string,
): XhsAdviceView | undefined {
  const byKey = new Map(changes.map(change => [change.key, change]))
  const items = drafts
    .map((draft) => {
      const change = byKey.get(draft.key)
      return change === undefined ? undefined : { text: draft.text, basis: basisLine(change) }
    })
    .filter((item): item is { text: string, basis: string } => item !== undefined)
  // 一条都没成型就整块缺席 —— 空着的「事务官的建议」比没有更糟。
  return items.length === 0 ? undefined : { at, range, items }
}
