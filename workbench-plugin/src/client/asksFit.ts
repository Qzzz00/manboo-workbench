/**
 * 球下那一区摆得下多少(2026-09-25,卡 fix/materialize-card-fit;统筹拍板,维护者规矩第 1 条:**粒子球是主角,最上面、够大,不许被卡片挤没**)。
 *
 * 球的大小照卡 A 的(至少占这一档 45%、至少 300px;这一档太矮时给输入框与状态那几行让位),**卡片不许挤球**。
 * 球下那一区剩多少就摆多少:
 *   - 够摆整张 → 整张(`full`,单子自己的行区滚、底栏钉在卡里);
 *   - 不够 → 每张收成一行(`rows`:单子是「标题 + 就这样 / 改一下 / 看全部」,别的卡是「一句话 + 展开」);
 *   - 连一行一张都摆不下 → 只留一行「还有 N 件要你看 · 展开」(`summary`)。
 * 「展开」「看全部」「改一下」把整张摊在事务官这一档上面(盖住球与输入框,「收起」回去)。
 */
export type AsksMode = 'full' | 'rows' | 'summary'

/** 收成一行时一行多高(px,含上下各 2px)。那一区在真壳 1475×812 下只剩 21px 可用,一行要摆得进去。 */
export const ASK_ROW_HEIGHT = 21
export const ASK_ROW_GAP = 4
/** 那一区至少这么高才摆整张(单子要摆得下卡头、三四行与底栏)。 */
export const ASKS_FULL_MIN = 320
/** 收成一行 / 只留一行时那一区上下的内边距(px,各 2)。 */
export const ASKS_COMPACT_PADDING = 4

export function asksMode(room: number | undefined, count: number): AsksMode {
  if (count === 0 || room === undefined) return 'full'
  if (room >= ASKS_FULL_MIN) return 'full'
  // 量出来的高度带小数(舞台最矮高度是按这一档高度算的百分比),差 1px 以内算摆得下。
  if (room + 1 >= count * ASK_ROW_HEIGHT + (count - 1) * ASK_ROW_GAP) return 'rows'
  return 'summary'
}

export function asksSummaryText(count: number): string {
  return `还有 ${count} 件要你看`
}

/**
 * 量球下那一区能用多高:事务官那一档的舞台区(`.ben-wb__particle-scene`)减去上面那一截(标题行 + 球的舞台**最矮**高度 + 状态那几行)
 * 再减去收成一行时的上下内边距。**只量不随卡片变的东西**(舞台按最矮算,不按它此刻长到多高 —— 卡片少时它会长,那是把空处给了球),
 * 所以卡片从整张收成一行、又展开,不会反过来改这个数。量不出来(没有布局的环境)回 undefined。
 */
export function measureAsksRoom(section: HTMLElement): number | undefined {
  const scene = section.querySelector('.ben-wb__particle-scene')
  const stage = section.querySelector('.ben-wb__task-stage')
  if (!(scene instanceof HTMLElement) || !(stage instanceof HTMLElement)) return undefined
  const rect = scene.getBoundingClientRect()
  if (rect.height <= 0) return undefined
  const px = (value: string): number => Number.parseFloat(value) || 0
  const sceneStyle = getComputedStyle(scene)
  const heading = section.querySelector('.ben-wb__task-stage-heading')
  const center = section.querySelector('.ben-wb__items-center')
  const topMin = (heading instanceof HTMLElement ? heading.getBoundingClientRect().height : 0)
    + px(getComputedStyle(stage).minHeight)
    + (center instanceof HTMLElement ? center.getBoundingClientRect().height : 0)
  return Math.round(rect.height - px(sceneStyle.paddingTop) - px(sceneStyle.paddingBottom) - topMin - ASKS_COMPACT_PADDING)
}
