// @vitest-environment node
/**
 * 派活之前先分流(2026-09-28,卡 FB):这句话要改的是**本体**,还是**用户层**。
 *
 * 钉住的是 2026-09-27 17:20 那条拍板(她和她的 Agent 不能改本体)在代码里的落点,
 * 以及 09-28 早上那一幕的原话 —— 「发布计划那里没有标记今天是哪一天,这个不方便,
 * 安排 Codex 去处理吧」**一家都不许派**。
 */
import { describe, expect, it } from 'vitest'
import {
  FEEDBACK_ASK_LINE, MAX_FEEDBACK_NOTE, feedbackNote, triageRequest, uiWordIn, uiWords,
} from '../src/productFeedback.ts'
import { DEFAULT_MODULE_TITLES, PRODUCT_TEMPLATE, setWorkbenchTemplateSource } from '../src/templates.ts'
import { loadStarterLayoutTemplate } from './helpers/starterLayer.ts'

// 2026-10-23(分层二刀二):本体 uiWords() 经全局模板来源认「运营模板的那几个标题」;
// 真机来源由 index.ts 注入,这里注入同一份(读真起步层)。
{
  const ops = await loadStarterLayoutTemplate()
  setWorkbenchTemplateSource({
    all: () => [PRODUCT_TEMPLATE, ops],
    byId: (id: string) => (id === PRODUCT_TEMPLATE.id ? PRODUCT_TEMPLATE : id === ops.id ? ops : undefined),
  })
}

describe('本体那一档', () => {
  it('09-28 早上那句原话:发布计划没标今天 → 本体,不派人', () => {
    const out = triageRequest('发布计划那里没有标记今天是哪一天,这个不方便,安排 Codex 去处理吧')
    expect(out.verdict).toBe('product')
    expect(out.ui).toBe('发布计划')
    // 他点名了 Codex 也不算 —— 本体那一档谁都不派。
    expect(out.why).toContain('发布计划')
  })

  it('界面元素 + 「不对 / 加个 / bug」都算本体', () => {
    for (const said of [
      '随手记那一格的字太小了',
      '顶栏的时间显示不对',
      '给设置里加个开关,我想关掉铃声',
      '工作台点更新之后崩了',
      '早报里的进度对不上',
    ]) {
      expect(triageRequest(said).verdict, said).toBe('product')
    }
  })
})

describe('用户层那一档', () => {
  it('小工具 / 采集器 / 偏好 / 布局照旧往下走', () => {
    for (const said of [
      '给我做个番茄钟小工具',
      '做一个采集器,每天把小红书后台的数据采回来',
      '以后初稿都按我上次那个口气写',
      '把随手记的布局调一下',
    ]) {
      expect(triageRequest(said).verdict, said).toBe('hers')
    }
  })

  it('提到了界面里那一块、但要的是一个小工具 → 用户层(小工具优先)', () => {
    expect(triageRequest('照着发布计划那一格,给我做个小工具算档期').verdict).toBe('hers')
  })

  it('普通的活、普通的问一句,一概不拦', () => {
    for (const said of [
      '帮我写一篇小红书文案,讲通勤包',
      '明天上午十点提醒我开会',
      'Lapis 那个仓库的登录接口报错了,派 Claude 去修',
    ]) {
      expect(triageRequest(said).verdict, said).toBe('hers')
    }
  })
})

describe('拿不准就问一句', () => {
  it('提到界面里那一块、可没说清要干什么 → unsure + 那一问', () => {
    const out = triageRequest('发布计划那块地方你给我优化一下')
    expect(out.verdict).toBe('unsure')
    expect(out.question).toBe(FEEDBACK_ASK_LINE)
  })

  it('她答完了就按她说的算,不再认字', () => {
    expect(triageRequest('随便什么', { explicit: 'product' }).verdict).toBe('product')
    expect(triageRequest('随便什么', { explicit: 'hers' }).verdict).toBe('hers')
  })
})

describe('本体有哪几块:由代码算,不写死', () => {
  it('两套模板的每一个模块标题都认得出(2026-10-23 起 ops 那份从用户层起步层读)', async () => {
    const ops = await loadStarterLayoutTemplate()
    const titles = [
      ...Object.values(DEFAULT_MODULE_TITLES),
      ...Object.values(ops.module_titles),
    ]
    for (const title of titles) {
      expect(uiWordIn(`${title}那里不对`), title).toBeTruthy()
    }
  })

  it('长的先命中:「发布计划」不会被「发布」吃掉', () => {
    expect(uiWordIn('发布计划不方便')).toBe('发布计划')
    const words = uiWords()
    expect(words.indexOf('发布计划')).toBeLessThan(words.indexOf('发布') === -1 ? words.length : words.indexOf('发布'))
  })
})

describe('事务官那「一句整理」', () => {
  it('是从她自己那句话里切出来的,一个字都不编', () => {
    const said = '发布计划那里没有标记今天是哪一天,这个不方便'
    const note = feedbackNote(said, '发布计划')
    expect(note).toContain(said)
    expect(note.startsWith('工作台「发布计划」:')).toBe(true)
  })

  it('长了截断,不会把一行撑爆', () => {
    const note = feedbackNote('太'.repeat(400), '随手记')
    expect(note.length).toBeLessThanOrEqual(MAX_FEEDBACK_NOTE)
    expect(note.endsWith('…')).toBe(true)
  })
})
