// @vitest-environment node
/**
 * 事务官浮窗的几何约束(W4)。
 *
 * **这个文件是不可改清单第 1 条在"可拉伸/可拖动"之下的守卫**:浮窗能被拉小、能被拖走,
 * 但不能小到、也不能远到让「全部暂停」离开可视区。CSS 的 min-width 拦得住鼠标拖拽,
 * 拦不住存档里被写进一个更小的值(手改 json、旧版本、将来的迁移)——所以拖拽路径与
 * 读路径共用这里的纯函数,两处都夹一遍。
 */
import { describe, expect, it } from 'vitest'
import { clampButlerPos, clampButlerSize, rectsIntersect } from '../src/client/butlerGeometry.ts'
import { BUTLER_BALL_DIAMETER_PX, MIN_BUTLER_H_PX, MIN_BUTLER_W_PX } from '../src/protocol.ts'

const VIEWPORT = { w: 1400, h: 900 }

describe('展开态最小宽高常量与球直径', () => {
  it('展开态最小宽高为 520 × 680,球直径为 96px', () => {
    expect(MIN_BUTLER_W_PX).toBe(520)
    expect(MIN_BUTLER_H_PX).toBe(680)
    expect(BUTLER_BALL_DIAMETER_PX).toBe(96)
  })
})

describe('clampButlerSize', () => {
  it('正常值原样通过', () => {
    expect(clampButlerSize({ w_px: 600, h_px: 700 }, VIEWPORT)).toEqual({ w_px: 600, h_px: 700 })
  })

  it('荒谬的小值抬回下限——叫停入口不能被拉没(展开态最小 520 × 680)', () => {
    expect(clampButlerSize({ w_px: 1, h_px: 1 }, VIEWPORT))
      .toEqual({ w_px: MIN_BUTLER_W_PX, h_px: MIN_BUTLER_H_PX })
  })

  it('比视口还大的值收到视口内——拉出屏幕就再也抓不着手柄了', () => {
    expect(clampButlerSize({ w_px: 9999, h_px: 9999 }, VIEWPORT)).toEqual({ w_px: 1400, h_px: 900 })
  })

  it('视口比下限还小(极窄窗口)时,下限优先——宁可溢出也要保住按钮', () => {
    expect(clampButlerSize({ w_px: 300, h_px: 300 }, { w: 100, h: 50 }))
      .toEqual({ w_px: MIN_BUTLER_W_PX, h_px: MIN_BUTLER_H_PX })
  })

  it('NaN / 负数按下限处理,不把 NaN 写进存档', () => {
    expect(clampButlerSize({ w_px: Number.NaN, h_px: -5 }, VIEWPORT))
      .toEqual({ w_px: MIN_BUTLER_W_PX, h_px: MIN_BUTLER_H_PX })
  })
})

describe('clampButlerPos(把浮窗自身尺寸算进去)', () => {
  const size = { w_px: 250, h_px: 200 }

  it('正常坐标原样通过', () => {
    expect(clampButlerPos({ x_pct: 10, y_pct: 10 }, size, VIEWPORT)).toEqual({ x_pct: 10, y_pct: 10 })
  })

  it('拖到右下角:收回来,保证整个浮窗仍在视口内', () => {
    // 既有 clampPct 只夹 0–95,95% × 1400 = 1330,250 宽的浮窗有 180px 出屏
    const out = clampButlerPos({ x_pct: 99, y_pct: 99 }, size, VIEWPORT)
    expect(out.x_pct * VIEWPORT.w / 100 + size.w_px).toBeLessThanOrEqual(VIEWPORT.w)
    expect(out.y_pct * VIEWPORT.h / 100 + size.h_px).toBeLessThanOrEqual(VIEWPORT.h)
  })

  it('负坐标收回 0,不让浮窗跑到视口左上之外', () => {
    expect(clampButlerPos({ x_pct: -50, y_pct: -50 }, size, VIEWPORT)).toEqual({ x_pct: 0, y_pct: 0 })
  })

  it('浮窗比视口还宽时贴左上角,不算出负值', () => {
    const out = clampButlerPos({ x_pct: 90, y_pct: 90 }, { w_px: 2000, h_px: 2000 }, VIEWPORT)
    expect(out).toEqual({ x_pct: 0, y_pct: 0 })
  })
})

/**
 * 弹层让开窗位(2026-09-11):事务官浮窗常驻,只有它的矩形与窗位矩形**相交**时才让窗位让开
 * ——不能因为浮窗在屏幕角落就一直让窗位空着。纯函数,拖动结束/挂载时各判一次。
 */
describe('rectsIntersect(浮窗与窗位相交判定)', () => {
  const SLOT = { x: 100, y: 100, w: 800, h: 400 }

  it('浮窗一角压进窗位 → 相交', () => {
    expect(rectsIntersect({ x: 800, y: 400, w: 250, h: 300 }, SLOT)).toBe(true)
  })

  it('浮窗整个在窗位里 → 相交', () => {
    expect(rectsIntersect({ x: 200, y: 200, w: 100, h: 100 }, SLOT)).toBe(true)
  })

  it('浮窗在窗位下方/右侧、不碰边 → 不相交', () => {
    expect(rectsIntersect({ x: 100, y: 600, w: 250, h: 300 }, SLOT)).toBe(false)
    expect(rectsIntersect({ x: 1000, y: 100, w: 250, h: 300 }, SLOT)).toBe(false)
  })

  it('只是贴着边(共享一条边、不重叠面积)→ 不算相交,别为一条线让路', () => {
    expect(rectsIntersect({ x: 100, y: 500, w: 250, h: 300 }, SLOT)).toBe(false)
    expect(rectsIntersect({ x: 900, y: 100, w: 250, h: 300 }, SLOT)).toBe(false)
  })

  it('零面积矩形(jsdom 量不到/元素还没布局)→ 不相交,不凭空让路', () => {
    expect(rectsIntersect({ x: 200, y: 200, w: 0, h: 0 }, SLOT)).toBe(false)
    expect(rectsIntersect({ x: 200, y: 200, w: 10, h: 10 }, { x: 0, y: 0, w: 0, h: 0 })).toBe(false)
  })
})
