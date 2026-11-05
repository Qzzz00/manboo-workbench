/**
 * 卡描述的「又交代一句 / 补一句」追加(2026-09-25 卡 N 的落卡那一半;2026-10-13 卡 G 补细节)。
 *
 * ★ 2026-10-29 删规矩第一批:入口归一后,「问进度尾巴当场答」(isProgressQuestion)与
 * 「一件事一份」入口去重(sameItemFor)随旧路删除(A#24)—— 所有入口进理解中枢,
 * 问进度由 chat 按事实答、是不是同一件由模型按上下文判(supplement / 新 dispatch)。
 * 这两件只在旧 `/butler/item` 里有调用方,调用方删后一并下线。
 */

function stampOf(at: Date): string {
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${pad(at.getMonth() + 1)}-${pad(at.getDate())} ${pad(at.getHours())}:${pad(at.getMinutes())}`
}

/** 他在一张已有的卡上又交代了一句:记进那张卡的描述(不改他原来那几句),带上时刻。 */
export function appendSaid(desc: string | undefined, text: string, at: Date): string {
  return withLine(desc, `他 ${stampOf(at)} 又交代:「${text.trim()}」`)
}

/**
 * ★ **她在电话里补的那一句**(2026-10-13,卡 G):记进那张卡的描述,与上面那一句同一个样子。
 *
 * 为什么不复用 `appendSaid`:这一句不是又交代一件事,是**给已经在办的那件补细节** ——
 * 卡上要看得出是补的(可灵那句提示词也从它带上),不是第二件要办的事。
 */
export function appendDetail(desc: string | undefined, text: string, at: Date): string {
  return withLine(desc, `她 ${stampOf(at)} 补的:「${text.trim()}」`)
}

function withLine(desc: string | undefined, line: string): string {
  return desc === undefined || desc.trim() === '' ? line : `${desc.trimEnd()}\n${line}`
}
