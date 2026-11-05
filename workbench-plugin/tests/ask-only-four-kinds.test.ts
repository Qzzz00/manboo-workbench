// @vitest-environment node
/**
 * **只在四类事上问她**(2026-10-04,卡 `claude/three-small-1004`;维护者点头)。
 *
 * 维护者原话:「别拿细枝末节来问我拍板」「总抛些无关紧要的给我拍版,你和事务官一个毛病」。
 * 运营同学 10-02 独立反馈同一个病:「频繁询问是否继续……每一步设置得太细了」。
 *
 * 10-02 那张卡删掉了「复述成 2–4 个确认点」那套**话术**,留下的「拿不准才问」说的是
 * **怎么问**,没说**问什么** —— 于是实现细节、默认值、要不要记一笔还是照样摆到她面前。
 * 这张卡补的就是「问什么」那一格,收成**一条、一处主人**(`confirmPoints.ts`),
 * 三个注入点各引那一处:
 *
 * | 注入点 | 什么时候到她面前 |
 * |---|---|
 * | `composer.MODE_LINES.ask` | 每一件交给事务官的事的第一条消息(「先问我」那一档) |
 * | `channel.ts` 【拿不准的时候怎么问】 | 每一通电话的人设(标 `always`,裁人设不许碰) |
 * | `docs/技能/需求确认点.md` | AGENTS.md 里那一段技能正文(两种模板都有:BASE_SKILLS) |
 *
 * 断言一律走导出的常量 / 函数,**不逐字抄中文**(AGENTS.md 的规矩)。
 */
import { describe, expect, it } from 'vitest'
import {
  ASK_ONLY_FOUR_KINDS,
  ASK_SELF_DECIDE_EXAMPLES,
  CONFIRM_SKILL_NAME,
  askOnlyFourKindsBlock,
  askOnlyFourKindsLine,
  askSelfDecideLine,
} from '../src/server/confirmPoints.ts'
import { MODE_LINES } from '../src/server/composer.ts'
import { buildChannelSystemMessage } from '../src/server/channel.ts'
import { BUNDLED_SKILL_DOCS } from '../src/server/bundledSkills.generated.ts'
import { BASE_SKILLS } from '../src/server/opsSkills.ts'

const AGENTS_WITH_ADDRESS = [
  '我叫 周到。',
  '',
  '<!-- 引导:称呼:开始 -->',
  '- 以后叫我小笨蛋就行',
  '<!-- 引导:称呼:结束 -->',
  '',
].join('\n')

function persona(): string {
  return buildChannelSystemMessage({
    agentsText: AGENTS_WITH_ADDRESS,
    rememberTool: 'wb_remember_item',
    doingTool: 'wb_list_doing',
    handTool: 'wb_hand_to_butler',
  })
}

/** 技能正文那一份(出厂自带,AGENTS.md 里那一段就是它)。 */
const SKILL = BUNDLED_SKILL_DOCS[`${CONFIRM_SKILL_NAME}.md`] ?? ''

describe('四类事:一处定', () => {
  it('★正好四类,一类不多一类不少', () => {
    expect(ASK_ONLY_FOUR_KINDS).toHaveLength(4)
  })

  it('四类各是哪一类:习惯 / 钱与额度 / 对外说法 / 要她亲手做', () => {
    const [habit, money, outward, byHand] = ASK_ONLY_FOUR_KINDS
    expect(habit).toContain('使用习惯')
    expect(money).toContain('额度')
    expect(money).toContain('花钱')
    expect(outward).toContain('发布')
    expect(byHand).toContain('登录')
    expect(byHand).toContain('验证码')
  })

  it('自己定那几样举的是例子:实现细节 / 默认值 / 记不记一笔', () => {
    expect(ASK_SELF_DECIDE_EXAMPLES.join('')).toContain('实现细节')
    expect(ASK_SELF_DECIDE_EXAMPLES.join('')).toContain('默认值')
  })

  it('那一句里四类都在;称呼跟着入参换(电话里用她的称呼)', () => {
    for (const kind of ASK_ONLY_FOUR_KINDS) expect(askOnlyFourKindsLine()).toContain(kind)
    expect(askOnlyFourKindsLine('小鱼')).toContain('问小鱼')
  })

  it('★另半句说的是「自己定、照做、事后说一句」—— 不是「不许问」就完了', () => {
    const line = askSelfDecideLine()
    expect(line).toContain('自己定')
    expect(line).toContain('事后一句话')
  })

  it('两句一块给(三个注入点用的都是它)', () => {
    expect(askOnlyFourKindsBlock()).toEqual([askOnlyFourKindsLine(), askSelfDecideLine()])
  })
})

describe('三个注入点,引的是同一处', () => {
  it('★事项第一条消息(「先问我」那一档)带着那两句', () => {
    for (const line of askOnlyFourKindsBlock('他')) expect(MODE_LINES.ask).toContain(line)
  })

  it('「先问我」原来那几条一个字没掉(拿不准才问、一次只问一件、不复述)', () => {
    expect(MODE_LINES.ask).toContain('一次只问最要紧的那一件')
    expect(MODE_LINES.ask).toContain('不要复述一遍他刚说的话')
  })

  it('「只出方案」与「自动办」两档一个字没碰(它们管的不是「问什么」)', () => {
    for (const line of askOnlyFourKindsBlock('他')) {
      expect(MODE_LINES.plan).not.toContain(line)
      expect(MODE_LINES.auto).not.toContain(line)
    }
  })

  it('★电话人设里带着那两句(用她的称呼)', () => {
    const text = persona()
    for (const line of askOnlyFourKindsBlock('小笨蛋')) expect(text).toContain(line)
  })

  it('★技能正文里那四类都写着,而且说清了「此外自己定」', () => {
    expect(SKILL).not.toBe('')
    expect(SKILL).toContain('只在这四类事上问他')
    expect(SKILL).toContain('使用习惯')
    expect(SKILL).toContain('验证码')
    expect(SKILL).toContain('此外一律自己定、照做')
  })

  it('★技能正文写清了与「先问我」档 / 派活闸 / 上限问话各管什么(不冲突)', () => {
    expect(SKILL).toContain('先问我')
    expect(SKILL).toContain('派活闸')
    expect(SKILL).toContain('上限问话')
  })

  it('★技能正文说清了与她规矩表里那条同义的「照一条办」(不让她看到两遍)', () => {
    expect(SKILL).toContain('是同一条,不是两条')
    expect(SKILL).toContain('照一条办')
  })

  it('这一段两种模板下都在(它进的是 BASE_SKILLS,与做运营还是做产品无关)', () => {
    expect(BASE_SKILLS.map(one => one.name)).toContain(CONFIRM_SKILL_NAME)
  })

  it('派活技能里也指到那四类(派给谁之外的细节自己定)', () => {
    const dispatch = BUNDLED_SKILL_DOCS['派活给别家Agent.md'] ?? ''
    expect(dispatch).toContain('别拿细枝末节来问他')
    expect(dispatch).toContain(CONFIRM_SKILL_NAME)
  })
})
