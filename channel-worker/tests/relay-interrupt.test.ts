/**
 * **电话里哪一句算「打断再发」**(2026-09-28,卡 WR)。
 *
 * 维护者点的第三个场景原话:「一个是给工作中的会话发信息,**并且打断发送新信息**」。
 * 两种意图差得远,而且不对称:
 * - 「补一句」送错了 = 多了他自己要说的那句话;
 * - 「打断」按错了 = **把他正在跑的那件活废了**。
 *
 * 所以这道门写成代码、按**他的原话**判(不是模型填的参数),而且**认不准一律按补一句**。
 * 这一份与插件那一侧 `server/relayMove.ts` 的 `looksLikeInterrupt` 同一个口径。
 */
import { describe, expect, it } from 'vitest'
import { looksLikeInterrupt, looksLikeLookupOnly, looksLikeRelay } from '../src/butlerRoute.ts'

describe('打断再发 / 补一句', () => {
  it('★他明说要停 → 打断', () => {
    for (const said of [
      '打断它,改成先做导出',
      '先停下,我改主意了',
      '你让它别做了,改成先出提纲',
      '停一下,这个方向不对',
      '跟 Codex 说不用做了',
      '把那条终止掉,重新来',
    ]) expect(looksLikeInterrupt(said), said).toBe(true)
  })

  it('★没说要停的一律按「补一句」—— 多送一句话比无端按停止键轻得多', () => {
    for (const said of [
      '跟那个 Claude 说一句现在到哪了',
      '给 Codex 捎句话,顺手把标题也改成蓝色',
      '问问它做完了没',
      '再加一句:要带上这周的数据',
      '告诉它我十点要用',
    ]) expect(looksLikeInterrupt(said), said).toBe(false)
  })

  it('★与前两道门不打架:「不要给他发信息,就看一眼」还是只读的,不因为带「不要」就算打断', () => {
    const said = '不要给他发信息,就看一眼现在什么状态'
    expect(looksLikeLookupOnly(said)).toBe(true)
    expect(looksLikeInterrupt(said)).toBe(false)
  })

  it('★「打断它」这一句本身照旧认得出是要捎话(不然打断这一档根本走不到)', () => {
    expect(looksLikeRelay('打断那个 Manus,跟它说改成先出提纲')).toBe(true)
  })

  it('空话不算打断', () => {
    expect(looksLikeInterrupt('')).toBe(false)
    expect(looksLikeInterrupt('   ')).toBe(false)
  })
})
