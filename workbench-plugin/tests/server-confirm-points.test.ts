// @vitest-environment node
/**
 * 接需求先给确认点(2026-09-23,维护者 13:05:「不能假装自己搞懂了」)。
 *
 * 这一份钉的是**规则那一半**(`server/confirmPoints.ts`,零 I/O),外加两种卡的提示词:
 *
 * 1. 按需求类型挑 2–4 条、**不许全问**、**最后一条永远是「怎么算做完」**;
 * 2. 每条都带「她的默认理解」—— 只问不答等于把活推回给他;
 * 3. 固定形状一字不差(他要的那三句:我理解的是 / 要确认的 / 哪条不对说一下);
 * 4. 电话里**最多三条**;
 * 5. 「确认点」那一节进**顶部**,段外一个字不动;未确认时**不写验收标准**;
 * 6. 验收标准**从确认点生成**:他答过的用他那句,没答的写「(按默认)」;
 * 7. 两种卡:未确认 → 第一态照形状问、后面几态**明写不许派活**;确认过 → 那一整段缺席。
 */
import { describe, expect, it } from 'vitest'
import {
  ACCEPTANCE_POINT, ACCEPTANCE_SECTION_TITLE, CONFIRM_POINT_MAX, CONFIRM_POINT_MIN,
  CONFIRM_POINT_RULES, CONFIRM_POINT_SPOKEN_MAX, CONFIRM_SECTION_TITLE, CONFIRM_SKILL_NAME,
  acceptanceLines, applyConfirmSections, buildConfirmPoints, changedIndexes, classifyNeed,
  formatConfirmBlock, hasAcceptancePoint, parseConfirmPoints, sectionOf, spokenConfirmBlock,
  upsertSection,
} from '../src/server/confirmPoints.ts'
import { FEATURE_CONFIRM_FILE, buildFeatureRunPrompt } from '../src/server/featureRun.ts'
import { TOPIC_CONFIRM_FILE, buildTopicRunPrompt } from '../src/server/topicRun.ts'
import { deckConfirmed } from '../src/server/deckRun.ts'
import { FEATURE_DOC_TABS, TOPIC_DOC_TABS } from '../src/protocol.ts'
import type { FeatureDocView, FeatureReviewEntry, TopicDocView } from '../src/protocol.ts'
import { FEATURE_DOC_FILES } from '../src/server/featureRun.ts'
import { TOPIC_DOC_FILES } from '../src/server/topicRun.ts'

/** 09-23 那一句原话 —— 整份用例的样本就是它。 */
const NEED = '把音色改成可配置的,而且我在电话通话中能够改'

describe('这句需求像哪一类', () => {
  it('★「把音色改成可配置、通话中能改」既是交互也是动作 —— 两类都要问到', () => {
    expect(classifyNeed(NEED)).toContain('交互')
    expect(classifyNeed(NEED)).toContain('动作')
  })

  it('纯看数的那一句归「数据」', () => {
    expect(classifyNeed('我想在工作台上看店铺每天的销售数据')).toContain('数据')
  })

  it('一类都不像 → 空数组(**不硬归一类**);空话也是空数组', () => {
    expect(classifyNeed('嗯')).toEqual([])
    expect(classifyNeed('   ')).toEqual([])
  })
})

describe('挑哪几条', () => {
  it('★ 2–4 条,**最后一条永远是「怎么算做完」**', () => {
    const points = buildConfirmPoints({ need: NEED })
    expect(points.length).toBeGreaterThanOrEqual(CONFIRM_POINT_MIN)
    expect(points.length).toBeLessThanOrEqual(CONFIRM_POINT_MAX)
    expect(points[points.length - 1]?.ask).toBe(ACCEPTANCE_POINT.ask)
    expect(hasAcceptancePoint(points)).toBe(true)
  })

  it('★ 每条都带「她的默认理解」—— 只问不答等于把活推回给他', () => {
    for (const one of buildConfirmPoints({ need: NEED })) {
      expect(one.guess.trim()).not.toBe('')
    }
  })

  it('★ 同时像两类时,两类**各先出一条**,不让一类把名额占满', () => {
    const asked = buildConfirmPoints({ need: NEED }).map(one => one.ask)
    expect(asked).toContain(CONFIRM_POINT_RULES.交互[0]?.ask)
    expect(asked).toContain(CONFIRM_POINT_RULES.动作[0]?.ask)
  })

  it('★ 不许全问:一类三条 + 验收 = 4 条封顶,max 再大也不多问', () => {
    expect(buildConfirmPoints({ need: '每天定时自动发一条通知', max: 99 }).length).toBe(CONFIRM_POINT_MAX)
  })

  it('max 压到最小时仍有一条分歧点 + 验收 —— 只剩验收一句就不成其为"确认"', () => {
    const points = buildConfirmPoints({ need: NEED, max: 1 })
    expect(points.length).toBe(CONFIRM_POINT_MIN)
    expect(hasAcceptancePoint(points)).toBe(true)
  })

  it('一类都不像也有确认点(问范围与归属),不是"没有确认点"', () => {
    const points = buildConfirmPoints({ need: '嗯' })
    expect(points.length).toBeGreaterThanOrEqual(CONFIRM_POINT_MIN)
    expect(hasAcceptancePoint(points)).toBe(true)
  })
})

describe('那一段话长什么样(固定形状)', () => {
  const points = buildConfirmPoints({ need: NEED })

  it('★ 他要的那三句一字不差', () => {
    const block = formatConfirmBlock({ understanding: NEED, points })
    expect(block.startsWith(`我理解的是:${NEED}。`)).toBe(true)
    expect(block).toContain('要确认的:')
    expect(block.trimEnd().endsWith('哪条不对说一下,都对就开工。')).toBe(true)
    expect(block).toContain('①')
  })

  it('★ 默认理解写在每条里 —— 他可以只说「第二条不对」', () => {
    const block = formatConfirmBlock({ understanding: NEED, points })
    for (const one of points) expect(block).toContain(one.guess)
  })

  it('★ 电话里最多念三条(维护者第 4 条)', () => {
    const many = buildConfirmPoints({ need: NEED, max: CONFIRM_POINT_MAX })
    const spoken = spokenConfirmBlock({ understanding: NEED, points: many })
    const numbered = spoken.split('\n').filter(line => /^[①②③④(]/.test(line))
    expect(numbered.length).toBeLessThanOrEqual(CONFIRM_POINT_SPOKEN_MAX)
    expect(spoken).not.toContain('④')
  })
})

describe('产物里那一节', () => {
  const points = buildConfirmPoints({ need: NEED })

  it('★ 进**顶部**:排在第一个 `## ` 之前,标题与前言一个字不动', () => {
    const before = '# 音色可配置\n\n> 由事务官生成于 2026-09-23。\n\n## 目标\n\n能在电话里换。\n'
    const after = applyConfirmSections({ text: before, points, confirmed: false })
    expect(after.indexOf(`## ${CONFIRM_SECTION_TITLE}`)).toBeLessThan(after.indexOf('## 目标'))
    expect(after).toContain('# 音色可配置')
    expect(after).toContain('> 由事务官生成于 2026-09-23。')
    expect(after).toContain('能在电话里换。')
  })

  it('★ 未确认时第一行就写着「不派活」,而且**不生成验收标准**', () => {
    const after = applyConfirmSections({ text: '', points, confirmed: false })
    expect(after).toContain('未确认')
    expect(after).toContain('没答之前不派活')
    expect(after).not.toContain(`## ${ACCEPTANCE_SECTION_TITLE}`)
  })

  it('★ 再写一次是原地换,**不会出现两节**', () => {
    const once = applyConfirmSections({ text: '## 目标\n\n能在电话里换。\n', points, confirmed: false })
    const twice = applyConfirmSections({ text: once, points, confirmed: true, at: '2026-09-23T05:00:00.000Z' })
    expect(twice.split(`## ${CONFIRM_SECTION_TITLE}`).length - 1).toBe(1)
    expect(twice).toContain('已确认')
    expect(twice).toContain('能在电话里换。')
  })

  it('★ 确认过 + 他改了第 ② 条 → 那一节里写着他改了哪条,他的原话也在', () => {
    const corrected = points.map((one, index) => (
      index === 0 ? { ...one, answer: '他模糊描述、或者你播一段样音,你去库里挑' } : one
    ))
    const after = applyConfirmSections({
      text: '',
      points: corrected,
      confirmed: true,
      at: '2026-09-23T05:00:00.000Z',
      changed: changedIndexes(corrected),
    })
    expect(after).toContain('他改了第 ①')
    expect(after).toContain('他模糊描述、或者你播一段样音,你去库里挑')
  })

  it('★ 验收标准**从确认点生成**:他答过的用他那句,没答的写「(按默认)」', () => {
    const corrected = points.map((one, index) => (index === 0 ? { ...one, answer: '她去库里挑' } : one))
    const after = applyConfirmSections({ text: '', points: corrected, confirmed: true })
    expect(after).toContain(`## ${ACCEPTANCE_SECTION_TITLE}`)
    const lines = acceptanceLines(corrected)
    expect(lines[0]).toContain('她去库里挑')
    expect(lines[1]).toContain('(按默认)')
    for (const line of lines) expect(after).toContain(line)
  })

  it('`sectionOf` 读得回来,`upsertSection` 换的只是那一节', () => {
    const text = upsertSection('## 甲\n\n一\n\n## 乙\n\n二\n', '甲', '## 甲\n\n新的一\n')
    expect(sectionOf(text, '甲')).toContain('新的一')
    expect(sectionOf(text, '乙')).toContain('二')
    expect(sectionOf(text, '丙')).toBeUndefined()
  })
})

describe('收回来那几条', () => {
  it('★ 缺默认理解就不收 —— 只问不答等于把活推回给他', () => {
    const got = parseConfirmPoints([{ ask: '从哪儿触发' }, { ask: '怎么算做完', guess: '走一遍' }])
    expect(got.ok).toBe(false)
    expect(got.ok === false ? got.error : '').toContain('guess')
  })

  it('条数出界就不收(2–4 条)', () => {
    expect(parseConfirmPoints([{ ask: 'a', guess: 'b' }]).ok).toBe(false)
    expect(parseConfirmPoints(Array.from({ length: 5 }, () => ({ ask: 'a', guess: 'b' }))).ok).toBe(false)
    expect(parseConfirmPoints('不是数组').ok).toBe(false)
  })

  it('★ 「他改了哪条」是**算出来的**,不收传进来的 —— 两处说同一件事一定会漂', () => {
    const points = [
      { ask: 'a', guess: 'b' },
      { ask: 'c', guess: 'd', answer: '不对,应该这样' },
      { ask: '怎么算做完', guess: '走一遍' },
    ]
    const got = parseConfirmPoints(points)
    expect(got.ok).toBe(true)
    expect(got.ok === true ? changedIndexes(got.points) : []).toEqual([2])
  })
})

/* ──────────────────────── 两种卡的那段话 ──────────────────────── */

function featureDocs(): FeatureDocView[] {
  return FEATURE_DOC_TABS.map(tab => ({ tab, file: FEATURE_DOC_FILES[tab], exists: false }))
}
function topicDocs(): TopicDocView[] {
  return TOPIC_DOC_TABS.map(tab => ({ tab, file: TOPIC_DOC_FILES[tab], exists: false }))
}

const featureBase = {
  name: '音色可配置',
  taskId: 't-1',
  dir: '/repo/docs/需求/音色可配置',
  docs: featureDocs(),
  reviews: [],
  handsReady: true,
  need: NEED,
}

const topicBase = {
  name: '露营锅具怎么选',
  taskId: 't-7',
  dir: '/假路径/选题/露营锅具怎么选',
  docs: topicDocs(),
  reviews: [],
  relayReady: true,
  need: '我想做一期讲露营锅具怎么选的',
}

describe('需求卡那段话', () => {
  it('★ 未确认 + 梳理 → 照固定形状先问,并写清写进 需求.md 顶部那一节', () => {
    const text = buildFeatureRunPrompt({ ...featureBase, stage: '梳理', confirmed: false })
    expect(text).toContain('我理解的是:')
    expect(text).toContain('要确认的:')
    expect(text).toContain('哪条不对说一下,都对就开工。')
    expect(text).toContain(FEATURE_CONFIRM_FILE)
    expect(text).toContain(CONFIRM_SECTION_TITLE)
    expect(text).toContain(CONFIRM_SKILL_NAME)
    expect(text).toContain('不要往下做、更不要派活')
  })

  it('★★ 未确认 + 拆解与派活 → **明写这一次一件都不要派**', () => {
    const text = buildFeatureRunPrompt({ ...featureBase, stage: '拆解与派活', confirmed: false })
    expect(text).toContain('还没过确认点')
    expect(text).toContain('这一次一件都不要派')
    expect(text).toContain('这一步不要派活')
  })

  it('★ 确认过 → 确认点那一整段缺席,话与加它之前逐字相同', () => {
    const text = buildFeatureRunPrompt({ ...featureBase, stage: '拆解与派活', confirmed: true })
    expect(text).not.toContain('确认点')
    expect(text).not.toContain('我理解的是:')
    expect(text).toContain('按 AGENTS.md 里「派活给别家Agent」那一节派')
  })

  it('复述那一句用的是**他的原话**;没有原话时留一个占位让它自己复述', () => {
    expect(buildFeatureRunPrompt({ ...featureBase, stage: '梳理', confirmed: false })).toContain(NEED)
    const { need: _dropped, ...noNeed } = featureBase
    const bare = buildFeatureRunPrompt({ ...noNeed, stage: '梳理', confirmed: false })
    expect(bare).toContain('<用一句话复述他要的那件事>')
  })
})

describe('选题卡那段话', () => {
  it('★ 未确认 + 构思(灵感)→ 照固定形状先问,写进 框架.md 顶部那一节', () => {
    const text = buildTopicRunPrompt({ ...topicBase, stage: '灵感', confirmed: false })
    expect(text).toContain('我理解的是:')
    expect(text).toContain('哪条不对说一下,都对就开工。')
    expect(text).toContain(TOPIC_CONFIRM_FILE)
    expect(text).toContain(CONFIRM_SECTION_TITLE)
  })

  it('★★ 未确认 + 初稿 → **一家都不要派**(GPT / 豆包 都不派)', () => {
    const text = buildTopicRunPrompt({ ...topicBase, stage: '初稿', confirmed: false })
    expect(text).toContain('还没过确认点')
    expect(text).toContain('这一次一家都不要派')
    expect(text).not.toContain('按《运营-给AI分发任务》派')
  })

  it('★ 确认过 → 那一整段缺席', () => {
    const text = buildTopicRunPrompt({ ...topicBase, stage: '初稿', confirmed: true })
    expect(text).not.toContain('确认点')
    expect(text).toContain('按《运营-给AI分发任务》派')
  })
})

describe('过没过确认点,判据只在留痕里', () => {
  it('★ 有一条 `confirm_points` 才算过 —— 产物文件里那一节是会被改写的,不作数', () => {
    const none: FeatureReviewEntry[] = [
      { at: '2026-09-23T01:00:00.000Z', tab: '需求', action: 'run', stage: '梳理' },
      { at: '2026-09-23T02:00:00.000Z', tab: '需求', action: 'pass', stage: '梳理' },
    ]
    expect(deckConfirmed(none)).toBe(false)
    expect(deckConfirmed([...none, {
      at: '2026-09-23T03:00:00.000Z', tab: '需求', action: 'confirm_points', stage: '梳理', points: ['怎么算做完:走一遍'],
    }])).toBe(true)
  })
})
