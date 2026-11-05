/**
 * 电话里怎么叫他(2026-09-23,Ben 第五通:「你不能说『喂,Ben,是我』——我肯定知道是你啊」)。
 *
 * 他的原话:「你应该说『老板,我有个事情要跟你确认一下』,就这样简单一句;或者每次有些不一样:
 * 第一次叫老板,下一次叫姚总,有点好玩。」
 *
 * 所以称呼是**一张表**,不是一个字符串:表在人设里(`~/.dsh/AGENTS.md` 的「称呼」标记段,
 * 由 8791 解析成 `ChannelPersona.addresses`),缺省是下面这两个。轮换的规矩只有一条 ——
 * **同一天不重复用同一个**;一天里把表用完了就从头再来。
 *
 * 为什么按「天」而不是按「每通电话轮一个」:他一天可能接三通,也可能接一通。
 * 按通轮的话,表里第二个称呼要等到第二通才出现,而**同一通里**她如果多叫一次
 * (开场一次、后面又一次)就会一次「老板」一次「姚总」—— 那不是好玩,那是分裂。
 * 一通电话认一个称呼,换天再换,这才是他说的「每次有些不一样」。
 *
 * 这个文件里没有时钟、没有磁盘:`today` 由调用方给(agent.ts 用本机日期),
 * 状态原样回给调用方存着。于是三条路(第一次、同一天第二通、跨天)在单测里跑得完。
 */

/** 人设里没写称呼表时用这两个。**「Ben」排在「老板」后面** —— 他嫌直呼其名像机器人。 */
export const DEFAULT_ADDRESSES = ['老板', 'Ben'] as const

/** 一天之内已经用过哪几个。`day` 变了就整张作废(见 {@link nextAddress})。 */
export interface AddressState {
  day: string
  used: readonly string[]
}

/**
 * 人设里那张表 → 能用的称呼列表。空的、全是空白的、重复的都挑掉;
 * 一个都不剩就退回 {@link DEFAULT_ADDRESSES} —— **绝不返回空表**:
 * 空表会让开场白变成没有主语的一句话,那比叫错更奇怪。
 */
export function addressListOf(raw: readonly string[] | undefined): readonly string[] {
  const cleaned: string[] = []
  for (const one of raw ?? []) {
    const trimmed = typeof one === 'string' ? one.trim() : ''
    // 一个称呼长过 12 个字基本是把一整句话写进表里了,念出来只会更怪。
    if (trimmed === '' || trimmed.length > 12) continue
    if (!cleaned.includes(trimmed)) cleaned.push(trimmed)
  }
  return cleaned.length === 0 ? DEFAULT_ADDRESSES : cleaned
}

/**
 * 这一通叫他什么。
 *
 * - `state` 是上一通留下的(没有 = 今天第一通);
 * - `state.day` 与 `today` 不一样 = 隔天了,整张重来;
 * - 今天还没用过的里挑**表上最靠前**的那一个(不随机:随机会连着两天都是「老板」,
 *   而他要的正是「下一次不一样」);
 * - 今天把表用完了就从头开始(用完了还得叫人)。
 */
export function nextAddress(
  list: readonly string[],
  state: AddressState | undefined,
  today: string,
): { address: string, state: AddressState } {
  const addresses = addressListOf(list)
  const used = state !== undefined && state.day === today ? state.used : []
  const fresh = addresses.filter(one => !used.includes(one))
  // 用完一轮就从头来:`fresh` 空了说明今天每个都叫过一遍了。
  const pool = fresh.length === 0 ? addresses : fresh
  const address = pool[0] as string
  const nextUsed = fresh.length === 0 ? [address] : [...used, address]
  return { address, state: { day: today, used: nextUsed } }
}

/** 本机日期 → `YYYY-MM-DD`。跨天只看本地日历,不看时区偏移(他人在哪就是哪)。 */
export function localDay(at: Date): string {
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}`
}
