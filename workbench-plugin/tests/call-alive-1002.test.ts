/**
 * **电话里像个活人**(2026-10-02,卡 claude/voice-alive)。
 *
 * 维护者:「肯定是机械化,没有活人感……而且啰嗦,自言自语,答非所问才是核心关键」
 * 「我们做事不是为了打补丁,是为了从根上修复」。
 * 根子逐条量在 `docs/分析-和事务官说话为什么费劲-2026-10-02.md`。
 *
 * 这一份钉工作台这一头的五件:
 *   ① **一个「我」**:人设里没有第三人称的事务官,称谓不写死「他」;
 *   ② **规矩留判断、删话术**:「先问我」那一句不再要求复述 + 2–4 个确认点;电话里只问一句;
 *   ③ **只说她关心的**:不念栏位 / 状态名 / 会话;通话纪要**不排来电、不播报**;
 *   ④ **称呼表只存称呼本身**:写进去剥一遍、读出来再剥一遍(已存的整句就这么迁移掉);
 *   ⑤ **耳朵配词表**:`GET /channel/persona` 下发识别热词。
 */
import { describe, expect, it } from 'vitest'
import {
  CHANNEL_HOTWORDS_MAX, NEUTRAL_ADDRESS, buildChannelSystemMessage, channelHotwords, latinWordsIn, personaAddress,
} from '../src/server/channel.ts'
import { addressNameOf, callAddressesOf } from '../src/server/rtcCall.ts'
import { taskCallOutEvent } from '../src/server/callOut.ts'
import { buildConfirmPoints, formatConfirmBlock, spokenConfirmBlock } from '../src/server/confirmPoints.ts'
import { MODE_LINES } from '../src/server/composer.ts'
import type { TaskView, TasksState } from '../src/protocol.ts'

/** 一份人设,里头有称呼表(第一个是她要的那个)。 */
const AGENTS_WITH_ADDRESS = [
  '我叫 周到。',
  '',
  '<!-- 引导:称呼:开始 -->',
  '- 以后叫我小笨蛋就行',
  '- 老板',
  '<!-- 引导:称呼:结束 -->',
  '',
].join('\n')

function persona(agentsText?: string, tasks?: TasksState): string {
  return buildChannelSystemMessage({
    ...(agentsText === undefined ? {} : { agentsText }),
    ...(tasks === undefined ? {} : { tasks }),
    rememberTool: 'wb_remember_item',
    doingTool: 'wb_list_doing',
    handTool: 'wb_hand_to_butler',
  })
}

function board(titles: readonly string[]): TasksState {
  return {
    tasks: titles.map((title, index) => ({ id: `t-${index}`, title, status: 'doing' as const })),
    sprints: [], modules: [], projects: [], accounts: [],
  } as unknown as TasksState
}

/* ──────────────────────── ① 一个「我」 ──────────────────────── */

describe('★★ 只有一个「我」', () => {
  it('第一句就是「你就是事务官」,而且明说电脑上那条会话是它自己的手', () => {
    const text = persona(AGENTS_WITH_ADDRESS)
    expect(text).toContain('你就是事务官,名字叫周到。')
    expect(text).toContain('【只有一个「我」】')
    expect(text).toContain('电脑上那条会话是**你自己的手**')
    expect(text).toContain('永远说「我」')
  })

  it('工具那张单子上一句第三人称都没有(「事务官本尊」「我让事务官去办」只在禁例里)', () => {
    const tools = persona(AGENTS_WITH_ADDRESS).split('【你能做什么】')[1] ?? ''
    expect(tools).not.toBe('')
    expect(tools).not.toContain('事务官本尊')
    expect(tools).not.toContain('我让事务官去办,办完告诉你')
    expect(tools).not.toContain('交给事务官本尊去办')
  })

  it('★ 称谓按称呼表,不写死「他」(运营同学是女生)', () => {
    expect(personaAddress(AGENTS_WITH_ADDRESS)).toBe('小笨蛋')
    const text = persona(AGENTS_WITH_ADDRESS)
    expect(text).toContain('小笨蛋在手机上跟你说话')
    expect(text).not.toContain('他在手机上跟你说话')
  })

  it('没有称呼表就用中性的「对方」—— 不编一个性别', () => {
    expect(personaAddress(undefined)).toBe(NEUTRAL_ADDRESS)
    expect(persona()).toContain('对方在手机上跟你说话')
  })
})

/* ──────────────────────── ② 规矩留判断、删话术 ──────────────────────── */

describe('★★ 澄清环节:留判断、删话术', () => {
  it('人设里有「拿不准才问 / 一次只问一件 / 用她的话问」,没有三问模板', () => {
    const text = persona(AGENTS_WITH_ADDRESS)
    expect(text).toContain('【拿不准的时候怎么问】')
    expect(text).toContain('**真拿不准才问**')
    expect(text).toContain('一次只问最要紧的那一件')
    expect(text).toContain('用小笨蛋自己的话**问')
    expect(text).toContain('**不要复述一遍她刚说的话**再问')
    // 「要确认的」「确认点」只出现在禁例那一行里(不要念它们),不是教她这么说
    expect(text).toContain('不要列①②③、不要念「要确认的」「确认点」')
    expect(text).not.toContain('确认三点')
    expect(text).not.toContain('跟你核三条')
  })

  it('★ 事项第一条消息里那一句:不再要求「复述成 2–4 个确认点」', () => {
    expect(MODE_LINES.ask).toContain('**拿不准的时候**先问一句')
    expect(MODE_LINES.ask).toContain('一次只问最要紧的那一件')
    expect(MODE_LINES.ask).not.toContain('复述成 2–4 个确认点')
    expect(MODE_LINES.ask).not.toContain('复述成')
  })

  it('★ 电话里念的那一段只有一句;屏幕上那一段照旧列条', () => {
    const points = buildConfirmPoints({ need: '加一个导出 PDF 的按钮' })
    const spoken = spokenConfirmBlock({ understanding: '加一个导出 PDF 的按钮', points })
    expect(spoken.split('\n')).toHaveLength(1)
    expect(spoken).not.toContain('我理解的是')
    expect(spoken).not.toContain('①')
    expect(formatConfirmBlock({ understanding: '加一个导出 PDF 的按钮', points })).toContain('①')
  })

  it('★ 开场白不用「{称呼},有什么吩咐」那种模板,也禁掉同一句开场', () => {
    const text = persona(AGENTS_WITH_ADDRESS)
    expect(text).toContain('**也不要每次用同一句开场**')
    expect(text).toContain('有什么吩咐')
    // 只出现在禁例里(「这种模板,一次都不要」),不是教她这么说
    expect(text).not.toContain('小笨蛋,有什么吩咐')
  })
})

/* ──────────────────────── ③ 只说她关心的 / 跟着她的长短 ──────────────────────── */

describe('★★ 只说她关心的', () => {
  it('回话按「结果 → 要她做的一件事」;栏位、状态名、会话、通话记录一律不念', () => {
    const text = persona(AGENTS_WITH_ADDRESS)
    expect(text).toContain('顺序是「结果 → 要小笨蛋做的那一件事」')
    expect(text).toContain('**不念系统里的名词**')
    for (const word of ['卡', '事项', '待办', '在办', '看板', '栏位', '状态', '等你确认', '会话']) {
      expect(text.split('**不念系统里的名词**')[1] ?? '').toContain(word)
    }
    expect(text).toContain('**不把通话本身当一件事报**')
    expect(text).toContain('问「为什么」「怎么回事」时才说')
  })

  it('★ 跟着她的长短说:默认一句,要多说先问', () => {
    const text = persona(AGENTS_WITH_ADDRESS)
    expect(text).toContain('跟着小笨蛋的长短说')
    expect(text).toContain('默认**一句**')
    expect(text).toContain('要细说吗')
  })

  it('★ 事务官不自己干活(与 09-28 那条拍板、base-086「按能力选家」一致)', () => {
    const text = persona(AGENTS_WITH_ADDRESS)
    expect(text).toContain('**你自己不动手干活**')
    expect(text).toContain('没点名你按本机各家的能力自己挑一家')
    expect(text).toContain('别问她「要不要我自己办」')
    // 确认点那一条的默认理解同改
    expect(buildConfirmPoints({ need: '随便一句谁也归不了类的话' })[0]?.guess)
      .toBe('按各家的能力挑一家派出去,动的是工作台这一处,不牵别的')
  })

  it('★ 听不准只问一次,不摆两个候选', () => {
    const text = persona(AGENTS_WITH_ADDRESS)
    expect(text).toContain('【听不准的时候】')
    expect(text).toContain('**只问一次**')
    expect(text).toContain('你是说 Codex 吗')
    expect(text).toContain('不要摆两个候选让她挑')
  })
})

describe('★★ 通话纪要不是一件办完的事', () => {
  const record = (over: Partial<TaskView>): TaskView => ({
    id: 't-call', title: '和事务官通了个电话(5 秒)', status: 'done', direction: 'mine', origin: 'call',
    updated_at: '2026-10-02T12:00:00.000Z', ...over,
  } as TaskView)

  it('带 call.kind 的纪要卡不排来电(2026-09-28 那一条)', () => {
    expect(taskCallOutEvent(record({ call: { kind: 'call' } } as Partial<TaskView>))).toBeUndefined()
  })

  it('★ 老版本落下的纪要卡**没有 call 那一格**,靠标题也认出来(2026-10-02;Air 10-02 那通播的正是它)', () => {
    expect(taskCallOutEvent(record({}))).toBeUndefined()
    expect(taskCallOutEvent(record({ title: '和事务官通了一次电话' }))).toBeUndefined()
  })

  it('电话里交代出来的**真事项**(origin:call 但不是纪要)照旧提醒', () => {
    const real = taskCallOutEvent(record({ id: 't-real', title: '让豆包查今天深圳的天气' }))
    expect(real?.reason).toBe('done')
  })
})

/* ──────────────────────── ④ 称呼表只存称呼本身 ──────────────────────── */

describe('★★ 称呼表只存称呼本身', () => {
  it('一句话剥成名字:「以后叫我小笨蛋就行」→「小笨蛋」', () => {
    expect(addressNameOf('以后叫我小笨蛋就行')).toBe('小笨蛋')
    expect(addressNameOf('叫我小笨蛋')).toBe('小笨蛋')
    expect(addressNameOf('以后叫我姚总就可以了')).toBe('姚总')
    expect(addressNameOf('我叫 Ben')).toBe('Ben')
  })

  it('★ 逗号后面那一截切掉 —— Air 那 22 次开场白就是它(「以后叫小笨蛋,有什么吩咐」)', () => {
    expect(addressNameOf('以后叫小笨蛋,有什么吩咐')).toBe('小笨蛋')
    expect(addressNameOf('以后叫小笨蛋,有件事跟你确认一下')).toBe('小笨蛋')
  })

  it('已经是一个称呼的一个字不动', () => {
    expect(addressNameOf('老板')).toBe('老板')
    expect(addressNameOf('姚总')).toBe('姚总')
    expect(addressNameOf('小笨蛋')).toBe('小笨蛋')
  })

  it('剥完还是一整句(长过 12 字)就当它不是称呼,回空串让调用方跳过', () => {
    expect(addressNameOf('这一句根本不是一个称呼而是一整段自言自语的话')).toBe('')
    expect(addressNameOf('   ')).toBe('')
  })

  it('★★ 读的时候也剥一遍:她机器上那张表里已经躺着的整句就这么迁移掉', () => {
    expect(callAddressesOf(AGENTS_WITH_ADDRESS)).toEqual(['小笨蛋', '老板'])
  })

  it('剥完撞车的去重(表里既有「以后叫我小笨蛋」又有「小笨蛋」)', () => {
    const agents = [
      '<!-- 引导:称呼:开始 -->',
      '- 以后叫我小笨蛋就行',
      '- 小笨蛋',
      '<!-- 引导:称呼:结束 -->',
    ].join('\n')
    expect(callAddressesOf(agents)).toEqual(['小笨蛋'])
  })
})

/* ──────────────────────── ⑤ 耳朵配词表 ──────────────────────── */

describe('★★ 识别热词', () => {
  it('家名(称呼与家名本身)都在表里 —— Air 那一通「Codex」被听成 to death / 泄露 五轮', () => {
    const words = channelHotwords({})
    expect(words).toContain('Codex')
    // 家名本身也进(她可能说英文的那个):与称呼不同形的才多一条(doubao / 豆包办公),
    // 同形的大小写算同一个(codex ≡ Codex,见 channelHotwords 的去重)
    expect(words).toContain('doubao')
    expect(words).toContain('豆包办公')
    expect(words).toContain('Manus')
    expect(words).toContain('Kimi')
  })

  it('事务官的名字、称呼表、调用方给的(账号名 / 小组件名)都进去', () => {
    const words = channelHotwords({
      agentsText: AGENTS_WITH_ADDRESS,
      butlerName: '周到',
      extra: ['消耗数据', '小红书运营号'],
    })
    expect(words).toContain('周到')
    expect(words).toContain('小笨蛋')
    expect(words).toContain('消耗数据')
    expect(words).toContain('小红书运营号')
  })

  it('★ 最近她说过的专有词:事项标题里的拉丁词(中文词不收 —— 收了会把同音字拉偏)', () => {
    expect(latinWordsIn('派 Codex 修小组件的 UI')).toEqual(['Codex', 'UI'])
    expect(latinWordsIn('把发布计划整理一下')).toEqual([])
    const words = channelHotwords({ tasks: board(['加一个导出 PDF 的按钮', '让 Manus 查天气']) })
    expect(words).toContain('PDF')
  })

  it('单字不收、去重、有上限', () => {
    const many = Array.from({ length: 200 }, (_, i) => `词${i}`)
    const words = channelHotwords({ extra: ['好', ...many] })
    expect(words).not.toContain('好')
    expect(words.length).toBeLessThanOrEqual(CHANNEL_HOTWORDS_MAX)
    expect(new Set(words).size).toBe(words.length)
  })
})
