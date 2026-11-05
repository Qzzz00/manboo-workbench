/**
 * 电脑那份「派活的眼睛」的纯函数(2026-10-22,卡「契约对照测试补齐」的统筹验收补):
 * 手机那份的对照在 `butler-app/tests/item-controls-sync.test.ts`(直接读本文件逐行比对),
 * 这里钉本侧自己的行为 —— 尤其 `budgetLine` 的人名兜底:名表里没有的家(运行时新登记的,
 * 包标识 / agent 名片的家)原样念家名、不念 undefined。
 */
import { describe, expect, it } from 'vitest'
import { budgetLine } from '../src/client/itemControlsModel.ts'

describe('itemControlsModel budgetLine', () => {
  it('名表里没有的家(包标识 / agent 名片的家)原样念家名,不出现 undefined', () => {
    expect(budgetLine({ cli_family: 'com.google.antigravity', limit_cny: 0.5, limit_minutes: 30, state: 'running', run_minutes: 2 })).toBe(
      'com.google.antigravity 在后台做了 2 分钟(上限 30 分钟;花的是 com.google.antigravity 自己的额度,这里只管时间)',
    )
    // run_minutes 缺席时的那一档也一样兜得住。
    expect(budgetLine({ cli_family: 'com.google.antigravity', limit_cny: 0.5, limit_minutes: 30, state: 'running' })).toBe(
      'com.google.antigravity 在后台做(上限 30 分钟;花的是 com.google.antigravity 自己的额度,这里只管时间)',
    )
    expect(budgetLine({ cli_family: 'com.google.antigravity', limit_cny: 0.5, limit_minutes: 30, state: 'running' })).not.toContain('undefined')
  })

  it('登记过的家照旧念正名(表里有就不用原样家名)', () => {
    expect(budgetLine({ cli_family: 'doubao', limit_cny: 0.5, limit_minutes: 30, state: 'running', run_minutes: 2 })).toBe(
      '豆包办公 在后台做了 2 分钟(上限 30 分钟;花的是 豆包办公 自己的额度,这里只管时间)',
    )
  })
})
