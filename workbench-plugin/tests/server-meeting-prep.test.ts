// @vitest-environment node
import { describe, expect, it } from 'vitest'
import {
  MEETING_ORGANIZER_ASK,
  answerPrep,
  buildCardPrompt,
  draftMeetingPlan,
  fillFromRecords,
  looksLikeMeetingPlan,
  meetingFactsOf,
  nextPrepAsk,
  parseCardReply,
  parseMeetingWhen,
  renderPrepMd,
  upsertPeople,
  type MeetingFact,
  type MeetingPeopleFile,
  type StoredMeetingPrep,
} from '../src/server/meetingPrep.ts'

/** 2026-10-10 周六 上午 10:00(本机时区)。 */
const NOW = new Date(2026, 9, 10, 10, 0, 0).getTime()

function prepOf(text: string): StoredMeetingPrep {
  return draftMeetingPlan(text, NOW).prep
}

describe('一句话里的时间', () => {
  it('下午三点 → 今天 15:00', () => {
    const when = parseMeetingWhen('下午三点跟 B 客户谈下季度合作', NOW)
    expect(when.phrase).toBe('下午三点')
    expect(when.date).toBe('2026-10-10')
    expect(new Date(when.at!).getHours()).toBe(15)
  })
  it('明天上午 10:30', () => {
    const when = parseMeetingWhen('明天上午10:30 组里例会', NOW)
    expect(when.date).toBe('2026-10-11')
    expect(new Date(when.at!).getHours()).toBe(10)
    expect(new Date(when.at!).getMinutes()).toBe(30)
  })
  it('只说「三点」不说上午下午:日期认、几点不猜', () => {
    const when = parseMeetingWhen('三点跟小鱼碰一下', NOW)
    expect(when.phrase).toBe('三点')
    expect(when.date).toBe('2026-10-10')
    expect(when.at).toBeUndefined()
  })
  it('下周二', () => {
    expect(parseMeetingWhen('下周二跟品牌方开会', NOW).date).toBe('2026-10-13')
  })
  it('没有时间就什么都没有', () => {
    expect(parseMeetingWhen('跟 B 客户谈合作', NOW).phrase).toBeUndefined()
  })
})

describe('认不认得出这是在登记一场会', () => {
  it.each([
    '下午三点跟 B 客户谈下季度合作',
    '明天上午十点组里例会',
    '周三下午给大老板汇报',
    '后天跟小鱼碰一下选题',
  ])('认:%s', (text) => { expect(looksLikeMeetingPlan(text, NOW)).toBe(true) })
  it.each([
    '跟 B 客户谈下季度合作',            // 没时间
    '明天下午三点提醒我给 B 客户打电话', // 提醒是另一件事
    '下午三点的会开了吗?',               // 问话
    '明天把选题表改完',                  // 不是会
  ])('不认:%s', (text) => { expect(looksLikeMeetingPlan(text, NOW)).toBe(false) })
})

describe('登记:能从那句话认出来的直接填,认不出的不猜', () => {
  it('跟 B 客户谈:外部(她说了「客户」)、花名 B客户;类型、谁拍板、她的角色、要定什么都要问', () => {
    const { prep, title } = draftMeetingPlan('下午三点跟 B 客户谈下季度合作', NOW)
    expect(title).toBe('跟 B 客户谈下季度合作')
    expect(prep.scope).toEqual({ value: '外部', from: 'said' })
    expect(prep.kind).toBeUndefined()
    expect(prep.aliases).toEqual(['B客户'])
    expect(prep.goal).toBeUndefined()
    expect(nextPrepAsk(prep)?.id).toBe('kind')
  })
  it('明说了「例会」就是例会、内部', () => {
    const prep = prepOf('明天上午十点组里例会')
    expect(prep.kind).toEqual({ value: '例会', from: 'said' })
    expect(prep.scope).toEqual({ value: '内部', from: 'said' })
  })
  it('明说了要定什么就填第五问', () => {
    const prep = prepOf('下午三点跟 B 客户谈,要敲定下季度报价')
    expect(prep.goal).toEqual({ value: '敲定下季度报价', from: 'said' })
  })
  it('「谈」不等于谈判会:不猜', () => {
    expect(prepOf('下午三点跟 B 客户谈合作').kind).toBeUndefined()
  })
})

describe('一问一答', () => {
  it('五问按次序问,答完就没有下一问', () => {
    let prep = prepOf('下午三点跟 B 客户谈下季度合作')
    const step = (id: string, answer: string): void => {
      expect(nextPrepAsk(prep)?.id).toBe(id)
      const got = answerPrep(prep, id as never, answer)
      if (!got.ok) throw new Error(got.error)
      prep = got.prep
    }
    step('kind', '谈判会')
    step('people', 'B客户拍板,小鱼执行')
    step('my_role', '汇报人')
    step('goal', '下季度投放预算定个数')
    expect(nextPrepAsk(prep)).toBeUndefined()
    expect(prep.people?.value).toEqual([{ alias: 'B客户', role: '拍板', decides: true }, { alias: '小鱼', role: '执行' }])
    expect(prep.decider).toEqual({ value: 'B客户', from: 'asked' })
    expect(prep.goal).toEqual({ value: '下季度投放预算定个数', from: 'asked' })
  })
  it('谁来里没说谁拍板 → 追一问「谁拍板」', () => {
    const prep = prepOf('明天上午十点组里例会')
    const got = answerPrep(prep, 'people', '小鱼、阿峰')
    expect(got.ok).toBe(true)
    if (!got.ok) return
    const ask = nextPrepAsk(got.prep)
    expect(ask?.id).toBe('decider')
    expect(ask?.choices).toEqual(['小鱼', '阿峰', '我', '还没定'])
  })
  it('花名里不记联系方式', () => {
    const got = answerPrep(prepOf('明天上午十点组里例会'), 'people', '小鱼 13800138000 拍板')
    expect(got.ok).toBe(false)
  })
  it('第五问答不上来:先拦,替她拟一句去问组织者的话', () => {
    const got = answerPrep(prepOf('明天上午十点组里例会'), 'goal', '说不清')
    expect(got.ok).toBe(true)
    if (!got.ok) return
    expect(got.prep.goal_unclear).toBe(true)
    expect(got.prep.goal).toBeUndefined()
    expect(MEETING_ORGANIZER_ASK).toContain('主要想定哪几件事')
  })
  it('选项外的自由回答也收(类型、角色)', () => {
    const got = answerPrep(prepOf('明天上午十点组里碰头'), 'kind', '复盘会')
    expect(got.ok && got.prep.kind?.value).toBe('复盘会')
  })
})

describe('花名档案(用户层,只在她电脑上)', () => {
  it('答完谁来 → 记进档案;下次同一个花名出现,谁来、谁拍板、内外从记录认出(写明依据)', () => {
    const file: MeetingPeopleFile = { version: 1, people: [] }
    upsertPeople(file, [{ alias: 'B客户', role: '拍板', decides: true }], { id: 'm1', title: '跟 B 客户谈合作', date: '2026-10-01', scope: '外部' }, NOW)
    expect(file.people).toHaveLength(1)
    expect(JSON.stringify(file)).not.toMatch(/\d{11}/)
    const prep = fillFromRecords(prepOf('下周二跟 B 客户再对一下'), file)
    expect(prep.people?.from).toBe('record')
    expect(prep.people?.basis).toContain('跟 B 客户谈合作')
    expect(prep.decider).toMatchObject({ value: 'B客户', from: 'record' })
    // 「客户」是她自己说的,说过的优先于记录
    expect(prep.scope).toEqual({ value: '外部', from: 'said' })
  })
  it('她没说内外、档案里有 → 从记录认出', () => {
    const file: MeetingPeopleFile = { version: 1, people: [] }
    upsertPeople(file, [{ alias: '小鱼', role: '执行' }], { id: 'm1', title: '选题周会', date: '2026-10-01', scope: '内部' }, NOW)
    const prep = fillFromRecords(prepOf('下周二跟小鱼再对一下'), file)
    expect(prep.scope).toMatchObject({ value: '内部', from: 'record' })
    expect(prep.decider).toBeUndefined()
  })
  it('有一个花名没见过就不从记录填谁来(不猜)', () => {
    const file: MeetingPeopleFile = { version: 1, people: [] }
    upsertPeople(file, [{ alias: 'B客户', role: '拍板', decides: true }], { id: 'm1', title: 't', date: '2026-10-01' }, NOW)
    const prep = fillFromRecords(prepOf('下周二跟 B 客户和小鱼开会'), file)
    expect(prep.people).toBeUndefined()
  })
})

describe('预案卡:数只从她的数据里来,带出处,查不到写没有', () => {
  const facts: MeetingFact[] = [
    { id: 'f1', text: '账号「小鱼日记」近7天:曝光数 1.1万、净涨粉 32', source: '小红书创作者数据(2026-10-09 取)' },
    { id: 'f2', text: '看板上进行中 3 件', source: '看板' },
  ]
  it('事实表从账号数据 / 复盘 / 选题池 / 看板里来,每条带出处', () => {
    const got = meetingFactsOf({
      now: NOW,
      xhs: [{ name: '小鱼日记', ranges: [{ range: '近7天', date: '2026-10-09', metrics: [{ label: '曝光数', raw: '1.1万' }, { label: '净涨粉', raw: '32' }, { label: '观看数' }] }] }],
      accounts: [{ name: '小鱼日记', notes: 12, goal: '粉丝目标 1000' }],
      reviews: [{ topic: '秋日穿搭', line: '自评分 4/5', date: '2026-10-05' }],
      tasks: [
        { id: 't1', title: 'B客户的报价单', status: 'doing' },
        { id: 't2', title: '秋日穿搭', status: 'doing', kind: 'topic', stage: '初稿' },
        { id: 't3', title: '灵感一', status: 'todo', kind: 'topic', stage: '灵感' },
      ],
      keywords: ['B客户'],
    })
    expect(got.every(f => f.source !== '')).toBe(true)
    const texts = got.map(f => f.text).join('\n')
    expect(texts).toContain('曝光数 1.1万')
    expect(texts).not.toContain('观看数')
    expect(texts).toContain('已发笔记 12 篇')
    expect(texts).toContain('自评分 4/5')
    expect(texts).toContain('选题池')
    expect(texts).toContain('B客户的报价单')
    expect(got.map(f => f.id)).toEqual(got.map((_, i) => `f${i + 1}`))
  })
  it('提示里带画像与事实表,要求只引编号', () => {
    const prompt = buildCardPrompt({ title: '跟 B 客户谈', prep: prepOf('下午三点跟 B 客户谈下季度合作') }, facts)
    expect(prompt).toContain('f1')
    expect(prompt).toContain('小红书创作者数据')
    expect(prompt).toContain('外部')
  })
  it('数由代码按编号填(原样 + 出处);没有编号写没有这个数', () => {
    const reply = JSON.stringify([
      { q: '最近涨粉怎么样?', fact: 'f1', line: '近七天净涨粉 32。', fallback: '细的我会后补给您。' },
      { q: '下季度预算多少?', fact: null, line: '这个要看这次谈的结果。', fallback: '这个我会后给您补一份。' },
      { q: '团队忙得过来吗?', fact: 'f2', line: '手上在推进的有 3 件。', fallback: '' },
    ])
    const got = parseCardReply(reply, facts, '跟 B 客户谈下季度合作')
    if ('error' in got) throw new Error(got.error)
    expect(got.questions[0]?.number).toEqual({ text: facts[0]!.text, source: facts[0]!.source })
    expect(got.questions[1]?.none).toBe(true)
    expect(got.questions[1]?.number).toBeUndefined()
    expect(got.questions[2]?.fallback).toBe('这个我会后给您补一份。')
  })
  it('说法里冒出一个出处里没有的数 → 这一条不要(不编)', () => {
    const reply = JSON.stringify([
      { q: '转化率多少?', fact: null, line: '大概 15% 左右。', fallback: '会后补。' },
      { q: '最近涨粉?', fact: 'f1', line: '净涨粉 32。', fallback: '会后补。' },
    ])
    const got = parseCardReply(reply, facts, '')
    if ('error' in got) throw new Error(got.error)
    expect(got.questions).toHaveLength(1)
    expect(got.questions[0]?.q).toBe('最近涨粉?')
  })
  it('认不出的编号当没有数;一条都不像样就报错', () => {
    expect('error' in parseCardReply('不是 JSON', facts, '')).toBe(true)
    const got = parseCardReply(JSON.stringify([{ q: '问?', fact: 'f9', line: '说法', fallback: '退路' }]), facts, '')
    if ('error' in got) throw new Error(got.error)
    expect(got.questions[0]?.none).toBe(true)
  })
  it('最多五条', () => {
    const many = Array.from({ length: 8 }, (_, i) => ({ q: `问题${'一二三四五六七八'[i]}?`, fact: null, line: '说法', fallback: '退路' }))
    const got = parseCardReply(JSON.stringify(many), facts, '')
    expect('questions' in got && got.questions.length).toBe(5)
  })
})

describe('会前.md(电脑上看全本)', () => {
  it('画像、出处、预案卡、拟好的那句问话都在;不写「已发出」', () => {
    let prep = prepOf('明天上午十点组里例会')
    const got = answerPrep(prep, 'goal', '不知道')
    if (got.ok) prep = got.prep
    const md = renderPrepMd({ title: '组里例会', date: '2026-10-11', prep, ask: MEETING_ORGANIZER_ASK })
    expect(md).toContain('# 会前准备:组里例会')
    expect(md).toContain('例会')
    expect(md).toContain('你那句话里说的')
    expect(md).toContain(MEETING_ORGANIZER_ASK)
    expect(md).toContain('发不发由你')
  })
})
