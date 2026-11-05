import { describe, expect, it } from 'vitest'
import {
  DEFAULT_LAYOUT, FIXED_MODULES, moveModule, resetLayout, resizeModule, toggleHidden,
} from '../src/client/layout.ts'

describe('moveModule', () => {
  it('把模块往前挪一位，order 随之交换', () => {
    // 默认布局:projects(0) / usage(1) / quota(2) / slot(3) / notes(4) / files(5)
    // ——A3 起 sessions 退休;2026-08-25 起 usage 与项目区并排在顶部行、余额独立成模块,
    // 同日组件条退休换成底部并排的随手记 + 系统文件夹。slot 往前挪一位换的是 quota。
    const next = moveModule(DEFAULT_LAYOUT, 'slot', -1)

    expect(next.modules.find(m => m.id === 'slot')?.order).toBe(2)
    expect(next.modules.find(m => m.id === 'quota')?.order).toBe(3)
    expect(next.modules.find(m => m.id === 'projects')?.order).toBe(0)
    expect(next.modules.find(m => m.id === 'usage')?.order).toBe(1)
    expect(next.modules.find(m => m.id === 'notes')?.order).toBe(4)
    expect(next.modules.find(m => m.id === 'files')?.order).toBe(5)
  })

  it('已在最前时再往前挪，原样返回（不折返、不循环）', () => {
    const next = moveModule(DEFAULT_LAYOUT, 'projects', -1)

    expect(next).toBe(DEFAULT_LAYOUT)
  })

  it('已在最后时再往后挪，原样返回（不折返、不循环）', () => {
    const next = moveModule(DEFAULT_LAYOUT, 'files', 1)

    expect(next).toBe(DEFAULT_LAYOUT)
  })

  it.each(FIXED_MODULES)('对不可改模块 %s 调用，原样返回（不可改清单第 1/4 条,代码层排除）', (id) => {
    expect(moveModule(DEFAULT_LAYOUT, id, 1)).toBe(DEFAULT_LAYOUT)
  })
})

describe('resizeModule', () => {
  it('在范围内正常加减', () => {
    const next = resizeModule(DEFAULT_LAYOUT, 'notes', 5)

    expect(next.modules.find(m => m.id === 'notes')?.basis_pct).toBe(29)
  })

  it('clamp 到上限 70', () => {
    const next = resizeModule(DEFAULT_LAYOUT, 'projects', 100)

    expect(next.modules.find(m => m.id === 'projects')?.basis_pct).toBe(70)
  })

  it('clamp 到下限 8（A3 默认值 54 减到底也不会跌破合法区间）', () => {
    const next = resizeModule(DEFAULT_LAYOUT, 'slot', -50)

    expect(next.modules.find(m => m.id === 'slot')?.basis_pct).toBe(8)
  })

  it.each(FIXED_MODULES)('对不可改模块 %s 调用，原样返回', (id) => {
    expect(resizeModule(DEFAULT_LAYOUT, id, 10)).toBe(DEFAULT_LAYOUT)
  })
})

describe('toggleHidden', () => {
  it('收起再展开，来回是幂等的', () => {
    const hidden = toggleHidden(DEFAULT_LAYOUT, 'notes')
    expect(hidden.modules.find(m => m.id === 'notes')?.hidden).toBe(true)

    const shown = toggleHidden(hidden, 'notes')
    expect(shown.modules.find(m => m.id === 'notes')?.hidden).toBe(false)
  })

  it.each(FIXED_MODULES)('对不可改模块 %s 调用，原样返回', (id) => {
    expect(toggleHidden(DEFAULT_LAYOUT, id)).toBe(DEFAULT_LAYOUT)
  })
})

describe('resetLayout', () => {
  it('恢复默认布局，多次调用结果一致（幂等）', () => {
    expect(resetLayout()).toEqual(DEFAULT_LAYOUT)
    expect(resetLayout()).toEqual(resetLayout())
  })

  it('返回深拷贝，不与 DEFAULT_LAYOUT 共享引用（浅层原地改不该污染常量）', () => {
    const next = resetLayout()

    expect(next).not.toBe(DEFAULT_LAYOUT)
    expect(next.modules[0]).not.toBe(DEFAULT_LAYOUT.modules[0])
  })

  it('调用方原地改返回值，不影响 DEFAULT_LAYOUT', () => {
    const next = resetLayout()
    next.butler.min = true

    expect(DEFAULT_LAYOUT.butler.min).toBe(false)
  })
})

/*
 * 2026-10-13:这里原来有一整个 describe('hoistedAlerts（收起补偿,spec §4："收起必有通知"）'),
 * 逐条钉着"projects 收起 → 项目名上浮""widgets 收起不再上浮磁盘告警""sessions 不再上浮"。
 * 最后那一支(projects)也退休了,函数本身一起删了 —— 维护者看着真机截图问「顶部这个黄色框
 * 是啥意思」,那个框画的就是它的输出:一条琥珀描边里只有一个项目名。退休的理由、以及"要让
 * 收起的信号继续说话该接在哪儿",记在 src/client/layout.ts 原 hoistedAlerts 那一处。
 *
 * 新事实由 tests/client-hoisted-alert-bar-gone-20261013.test.tsx 钉:同样的那一刻
 * (项目区收起 + DDL 过期 + 另一个 stale)渲染出来的屏幕上**没有那条横条**,而"把它展开"
 * 那颗键原样在。放在那一份而不是这一份:它是"屏幕上有没有"的事,这一份只管布局纯函数。
 */
