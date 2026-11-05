// @vitest-environment node
/**
 * 句子 → 动作草案(2026-09-22「用自然语言改布局」)。
 *
 * 这一份的主体是**一张表**:每一行一句中文,后面写清"该认成什么 / 该认不出"。
 * 表比一条条 it 更该存在,理由是这层功能的质量就等于"这张表覆盖了多少种说法" ——
 * 以后 Ben 说了一句没认出来的话,直接往表里加一行,是最小的修法。
 *
 * 表里**故意留着一整段认不出的**(否定、一次改一片、删模块、光说模块名不说要干嘛)。
 * 「认不出」是这一层的正确输出之一,不是缺陷:猜错了他得自己再说一遍才发现。
 */
import { describe, expect, it } from 'vitest'
import { LAYOUT_DECK_TARGET } from '../src/protocol.ts'
import { MODULE_IDS } from '../src/client/layout.ts'
import { DEFAULT_MODULE_TITLES, templateModuleTitle } from '../src/templates.ts'
import { loadStarterLayoutTemplate } from './helpers/starterLayer.ts'
import {
  LAYOUT_WORDS_STEP_PCT,
  isLayoutUndoWord,
  layoutWordModuleIds,
  parseLayoutWords,
} from '../src/layoutWords.ts'

const OPS_TEMPLATE = await loadStarterLayoutTemplate()

const LAND = { orientation: 'landscape' as const }
const PORT = { orientation: 'portrait' as const }

/** 一行表:句子 → 期望的那一条动作(只比对写出来的字段)。 */
interface Row {
  say: string
  ctx: { orientation: 'portrait' | 'landscape' }
  act: Record<string, unknown>
}

const HITS: readonly Row[] = [
  // —— Ben 原话里的四句(这四行是验收本身)——
  { say: '把消耗数据挪到项目区下面', ctx: LAND, act: { kind: 'region', module: 'usage', region: 'side' } },
  { say: '把随手记藏起来', ctx: PORT, act: { kind: 'hide', module: 'notes' } },
  { say: '项目区改叫账号', ctx: PORT, act: { kind: 'rename', module: 'projects', title: '账号' } },
  { say: '底部那排高一点', ctx: LAND, act: { kind: 'resize', module: LAYOUT_DECK_TARGET, axis: 'height', delta_pct: LAYOUT_WORDS_STEP_PCT } },

  // —— 挪进区域 ——
  { say: '把余额额度也拉到项目区下面', ctx: LAND, act: { kind: 'region', module: 'quota', region: 'side' } },
  { say: '随手记放到右侧栏', ctx: LAND, act: { kind: 'region', module: 'notes', region: 'side' } },
  { say: '把消耗数据挪回底部那一排', ctx: LAND, act: { kind: 'region', module: 'usage', region: 'deck' } },
  { say: '用量放回底部', ctx: LAND, act: { kind: 'region', module: 'usage', region: 'deck' } },
  { say: '素材管理挪到账号下面', ctx: LAND, act: { kind: 'region', module: 'files', region: 'side' } },

  // —— 上下左右各挪一格 ——
  { say: '把随手记往上挪', ctx: PORT, act: { kind: 'move', module: 'notes', dir: 'up' } },
  { say: '额度往下挪一格', ctx: PORT, act: { kind: 'move', module: 'quota', dir: 'down' } },
  { say: '消耗数据上移', ctx: PORT, act: { kind: 'move', module: 'usage', dir: 'up' } },
  { say: '把系统文件夹往左挪', ctx: LAND, act: { kind: 'move', module: 'files', dir: 'left' } },
  { say: '选题池往右挪一格', ctx: LAND, act: { kind: 'move', module: 'todo', dir: 'right' } },

  // —— 藏 / 显示 ——
  { say: '把消耗数据收起来', ctx: PORT, act: { kind: 'hide', module: 'usage' } },
  { say: '隐藏发布计划', ctx: PORT, act: { kind: 'hide', module: 'publish' } },
  { say: '不要显示数据复盘', ctx: PORT, act: { kind: 'hide', module: 'review' } },
  { say: '把随手记显示出来', ctx: PORT, act: { kind: 'show', module: 'notes' } },
  { say: '选题池放出来', ctx: PORT, act: { kind: 'show', module: 'todo' } },
  { say: '别藏了,把额度露出来', ctx: PORT, act: { kind: 'show', module: 'quota' } },

  // —— 改名 ——
  { say: '把系统文件夹改叫素材库', ctx: PORT, act: { kind: 'rename', module: 'files', title: '素材库' } },
  { say: '待办事项名字改成选题池', ctx: PORT, act: { kind: 'rename', module: 'todo', title: '选题池' } },
  { say: '随手记重命名为灵感', ctx: PORT, act: { kind: 'rename', module: 'notes', title: '灵感' } },
  { say: '项目区改叫「账号」吧', ctx: PORT, act: { kind: 'rename', module: 'projects', title: '账号' } },

  // —— 高矮宽窄 ——
  { say: '底部那一排矮一点', ctx: LAND, act: { kind: 'resize', module: LAYOUT_DECK_TARGET, axis: 'height', delta_pct: -LAYOUT_WORDS_STEP_PCT } },
  { say: '项目区高一点', ctx: PORT, act: { kind: 'resize', module: 'projects', axis: 'height', delta_pct: LAYOUT_WORDS_STEP_PCT } },
  { say: '把窗口槽矮一点', ctx: PORT, act: { kind: 'resize', module: 'slot', axis: 'height', delta_pct: -LAYOUT_WORDS_STEP_PCT } },
  { say: '消耗数据宽一点', ctx: LAND, act: { kind: 'resize', module: 'usage', axis: 'width', delta_pct: LAYOUT_WORDS_STEP_PCT } },
  { say: '随手记窄一点', ctx: LAND, act: { kind: 'resize', module: 'notes', axis: 'width', delta_pct: -LAYOUT_WORDS_STEP_PCT } },

  // —— 换位 ——
  { say: '把随手记和系统文件夹换个位置', ctx: LAND, act: { kind: 'swap', module: 'notes', other: 'files' } },
  { say: '消耗数据跟额度对调', ctx: LAND, act: { kind: 'swap', module: 'usage', other: 'quota' } },
]

/** 认不出来的那一批。**reason 里必须有那个触发退回的词**,不然他看不出该改哪里。 */
const MISSES: readonly { say: string, ctx: { orientation: 'portrait' | 'landscape' }, because: string }[] = [
  // 否定
  { say: '别把消耗数据挪上去', ctx: LAND, because: '别' },
  { say: '不要把随手记挪到项目区下面', ctx: LAND, because: '不要' },
  { say: '不想把项目区改叫账号', ctx: PORT, because: '不想' },
  { say: '这一格不用挪了', ctx: PORT, because: '不用' },
  // 一次改一片
  { say: '把所有模块都藏起来', ctx: PORT, because: '所有模块' },
  { say: '全部模块往上挪', ctx: PORT, because: '全部模块' },
  // 删不掉
  { say: '把随手记删掉', ctx: PORT, because: '删掉' },
  { say: '数据复盘去掉', ctx: PORT, because: '去掉' },
  // 认不出模块
  { say: '把那个东西挪上去', ctx: PORT, because: '模块' },
  { say: '帮我把界面弄好看点', ctx: PORT, because: '模块' },
  // 认出了模块,没认出动作
  { say: '随手记', ctx: PORT, because: '随手记' },
  { say: '项目区怎么样了', ctx: PORT, because: '项目区' },
  // 方向在这个屏上不成立
  { say: '把消耗数据挪到右侧栏', ctx: PORT, because: '右侧栏' },
  { say: '底部那一排高一点', ctx: PORT, because: '底部那一排' },
  // 改名缺一半
  { say: '改叫账号', ctx: PORT, because: '改叫' },
  { say: '项目区改叫', ctx: PORT, because: '改叫' },
  { say: '项目区改叫一个特别特别长长长的名字', ctx: PORT, because: '太长' },
  // 换位缺一半
  { say: '把随手记换个位置', ctx: LAND, because: '哪两格' },
  // 空句子
  { say: '   ', ctx: PORT, because: '空' },
]

describe('句子 → 动作草案', () => {
  for (const row of HITS) {
    it(`认得:「${row.say}」`, () => {
      const result = parseLayoutWords(row.say, row.ctx)
      if (!result.ok) throw new Error(`没认出来:${result.reason}`)
      expect(result.actions).toHaveLength(1)
      expect(result.actions[0]).toMatchObject(row.act)
      // 复述必须是一句反问,而且提到那一格现在叫什么。
      expect(result.restate).toContain('对吗?')
    })
  }

  for (const row of MISSES) {
    it(`认不出:「${row.say}」`, () => {
      const result = parseLayoutWords(row.say, row.ctx)
      expect(result.ok).toBe(false)
      if (result.ok) return
      expect(result.reason).toContain(row.because)
    })
  }

  it('表里认得的句子一共 30 句以上,认不出的一批也在(这一层的质量 = 表有多全)', () => {
    expect(HITS.length).toBeGreaterThanOrEqual(30)
    expect(MISSES.length).toBeGreaterThanOrEqual(10)
  })
})

describe('复述用他看得见的那几个字', () => {
  it('运营模板下,项目区在复述里叫「账号」', () => {
    const result = parseLayoutWords('把消耗数据挪到项目区下面', {
      orientation: 'landscape',
      titleOf: id => templateModuleTitle(OPS_TEMPLATE, id),
    })
    if (!result.ok) throw new Error(result.reason)
    expect(result.restate).toContain('账号')
    expect(result.restate).not.toContain('项目区')
  })

  it('不给 titleOf 时落回默认标题', () => {
    const result = parseLayoutWords('把随手记藏起来', PORT)
    if (!result.ok) throw new Error(result.reason)
    expect(result.restate).toContain(DEFAULT_MODULE_TITLES.notes as string)
  })
})

describe('词表跟模块清单对得上', () => {
  it('每一个模块 id 都在词表里有说法(以后加模块、词表没跟上就当场红)', () => {
    for (const id of MODULE_IDS) {
      expect(layoutWordModuleIds()).toContain(id)
    }
  })

  it('两套模板的每一个模块标题都认得出来(做产品 + 运营)', () => {
    for (const id of MODULE_IDS) {
      for (const template of [undefined, OPS_TEMPLATE]) {
        const shown = templateModuleTitle(template, id)
        const result = parseLayoutWords(`把${shown}藏起来`, PORT)
        if (!result.ok) throw new Error(`「${shown}」(${id})没认出来:${result.reason}`)
        expect(result.actions[0]).toMatchObject({ kind: 'hide', module: id })
      }
    }
  })
})

describe('「撤销」只认整句', () => {
  for (const word of ['撤销', '撤销吧', '撤回', '还原', '回退', '改回去', 'undo', ' 撤销 。']) {
    it(`认:「${word}」`, () => { expect(isLayoutUndoWord(word)).toBe(true) })
  }
  for (const word of ['把撤销按钮做大一点', '撤销这件事以后再说', '我想撤销上周那次提交', '']) {
    it(`不认:「${word}」`, () => { expect(isLayoutUndoWord(word)).toBe(false) })
  }
})
