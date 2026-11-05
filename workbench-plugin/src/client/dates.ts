/**
 * DDL 倒数天数的单一实现(spec D3/D10/D11)。
 *
 * 之前 butler.ts / portfolio.ts / layout.ts 各写了一份同名算法，
 * 解析失败时的回退值悄悄分了叉：portfolio.ts 回 0，其余三处回 +Infinity。0 是比
 * "不知道"更危险的答案——一条格式坏掉的 DDL 日期会被 buildDdlText 渲染成"剩 0 天"，
 * 跟真正今天到期的项目长得一模一样，属于典型的"错的数字比没有数字更害人"(D13)。
 *
 * 统一回 +Infinity：解析失败当"没有可用 DDL/不紧急"处理——不小于任何真实的剩余天数，
 * 天然地让所有"daysLeft <= 某阈值"的判断（today/明天交付、今天要动……）在坏数据面前
 * 全部落空，而不是误报紧急。调用方如果要把"剩 N 天"渲染成文案，必须自己判一次
 * `Number.isFinite`，不能假设这里永远给得出一个有意义的数字。
 */
export function daysLeftFromNow(dateOnly: string, nowSec: number): number {
  const now = new Date(nowSec * 1000)
  const today = Date.UTC(now.getFullYear(), now.getMonth(), now.getDate())
  const [, y, m, d] = /^(\d{4})-(\d{2})-(\d{2})/.exec(dateOnly) ?? []
  if (y === undefined || m === undefined || d === undefined) return Number.POSITIVE_INFINITY
  const target = Date.UTC(Number(y), Number(m) - 1, Number(d))
  return Math.round((target - today) / 86_400_000)
}

/**
 * 本地日期字符串 YYYY-MM-DD(整分支终审 I2)。
 *
 * **必须按本地时区切天,不能用 `toISOString().slice(0,10)`**——那是 UTC 的日期:
 * 东八区每天 00:00–08:00 之间它给出的是**昨天**,西半球则会提前跳到明天。门槛①
 * (proposals.ts 的 hasContinuousEvidence)判的是"证据里必须含今天",而它回溯用的
 * `dayBefore` 走的是本地时区——两头对不上,这条链上就永远埋着"每天错 8 小时"的日期。
 * 今天提议源恒为空、后果还看不见,但门槛要的正是"结构性在场,将来接源不必有人记得
 * 补",所以现在就得是对的。
 *
 * **为什么不复用 src/server/brief.ts 的同名函数**:那份在服务端,同文件 import 了
 * node:crypto / node:fs——客户端 import 它会把 Node 内建模块拖进浏览器包。两份实现
 * 一模一样是有意的重复,不是遗漏(那边的头注释写的是同一条纪律)。放在这个文件是
 * 因为它本来就是"客户端日期算法的单一实现"那一处(见上面 daysLeftFromNow 的注释)。
 */
export function localDateStr(ms: number): string {
  const d = new Date(ms)
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}
