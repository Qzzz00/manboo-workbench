/**
 * **一句话里交代了两件事,两件的工具都要在手上**(2026-10-03,卡 fix/voice-route-zh;
 * 审计 `docs/审计材料/2026-10-03/voice.md` 第 3 条)。
 *
 * 10-03 早上那张卡把「意图」从「先应哪一句」的依据升成了**工具裁剪的边界**,
 * 而意图那一格只留第一个命中的 —— 于是:
 *
 *   · 「把文件发给我,再换个音色」→ 意图 voice,手上只剩换音色那一件,**文件那两件没了**;
 *   · 「换个音色,再帮我记一下明天开会」→ 意图 remember,**换音色那一件没了**。
 *
 * 模型手上没有能办的那一件时,工具说明书里那句话会让它「只说打算」(intentTools.ts 的
 * `intentToolNote`)—— 也就是她嘴上应了、事情只办了一半。
 *
 * 这一版:判定多一格 `intents`(这一句命中的**全部**意图,按
 * ACT_INTENTS → butlerRoute(lookup/relay)→ FOLLOW_ACT_INTENTS 的顺序去重),
 * 工具按**并集**下发。`intent` 那一格**还是第一个** —— 先应的那一句、`回合计时`
 * 那一行、8791 那头认的字段表一个字都没动。
 */
import { describe, expect, it } from 'vitest'
import { INTENT_TOOLS, planTurnTools, toolsForIntent, toolsForIntents } from '../src/intentTools.ts'
import { RulesTurnRouter, routeByRules } from '../src/turnRoute.ts'
import { TOOL_SEARCH_FILES, TOOL_SEND_FILE, TOOL_VOICE } from '../src/tools.ts'
import { TOOL_END_CALL } from '../src/farewell.ts'

/** 这台机器上「全套」长什么样(名字即工具,够这几条用)。 */
const ALL = Object.fromEntries(
  [...new Set(INTENT_TOOLS.flatMap(one => [...one.tools])), TOOL_END_CALL].map(name => [name, { name }]),
)

describe('★★ 审计那两句复合指令(反例逐字)', () => {
  it('★ 「把文件发给我，再换个音色」—— 文件那两件与换音色那一件都在手上', () => {
    const hit = routeByRules('把文件发给我，再换个音色')
    expect(hit.route).toBe('act')
    // 先应的那一句照旧按第一个意图(她的嘴一个字没改)
    expect(hit.intent).toBe('voice')
    expect(hit.intents?.[0]).toBe('voice')
    expect(hit.intents).toContain('file')
    const tools = toolsForIntents(hit.intents)
    expect(tools).toContain(TOOL_VOICE)
    expect(tools).toContain(TOOL_SEARCH_FILES)
    expect(tools).toContain(TOOL_SEND_FILE)
    // 审计当时数出来的那一份:只有这两件
    expect(toolsForIntent(hit.intent)).toEqual([TOOL_VOICE, TOOL_END_CALL])
  })

  it('★ 「换个音色，再帮我记一下明天开会」—— 换音色那一件回来了', () => {
    const hit = routeByRules('换个音色，再帮我记一下明天开会')
    // 「记一下」那一组排在表的最前面,意图还是它;先应的是换音色那一句(2026-10-12 起记一笔不先应)
    expect(hit.intent).toBe('remember')
    expect(hit.ack).toBe('好,我挑几个给你听。')
    expect(hit.intents?.[0]).toBe('remember')
    expect(hit.intents).toContain('voice')
    const tools = toolsForIntents(hit.intents)
    // 审计当时数出来的那一份:换音色那一件不在里头
    expect(toolsForIntent(hit.intent)).not.toContain(TOOL_VOICE)
    expect(tools).toContain(TOOL_VOICE)
    // 记一笔那一组本来就有的那几件照旧在
    expect(tools).toEqual(expect.arrayContaining([...(toolsForIntent('remember') ?? [])]))
  })

  it('★★ 真要发出去的那一份(planTurnTools)也按并集', () => {
    const hit = routeByRules('把文件发给我，再换个音色')
    const plan = planTurnTools({
      on: true,
      ...(hit.intent === undefined ? {} : { intent: hit.intent }),
      ...(hit.intents === undefined ? {} : { intents: hit.intents }),
      all: ALL,
    })
    expect(plan?.names).toContain(TOOL_VOICE)
    expect(plan?.names).toContain(TOOL_SEND_FILE)
    expect(plan?.names).toContain(TOOL_END_CALL)
  })
})

describe('intents 那一格怎么来的', () => {
  it('单意图的句子:intents 就一个,等于 intent', () => {
    const hit = routeByRules('把这个事情记下来')
    expect(hit.intent).toBe('remember')
    expect(hit.intents).toEqual(['remember'])
  })

  /**
   * **词表里的词互相是子串**(2026-10-03 量出来的代价,决策记录里记成待拍板):
   * 「换个音色」里含着动作词「换个」,「发给我」里含着「发给」—— 于是这两类
   * 必然多带上 `change` / `relay` 那两组的工具。审计要的能力一件没少,
   * 代价是 10-03 早上「换音色只给一件」那条省得最干净的路没了。
   */
  it('★ 子串重叠:「换个音色」连着 change 那一组一起带(量出来的代价,不是意外)', () => {
    const hit = routeByRules('你能不能换个音色')
    expect(hit.intent).toBe('voice')
    expect(hit.intents).toEqual(['voice', 'change'])
    expect(toolsForIntents(hit.intents)?.length).toBeGreaterThan((toolsForIntent('voice') ?? []).length)
  })

  it('★ 顺序:ACT_INTENTS → butlerRoute → 动作词,去过重', () => {
    // 「派给」(dispatch,ACT_INTENTS)+「问一下」(relay,动作词)
    const hit = routeByRules('这件事派给豆包，顺便问一下 Codex 还有没有空')
    expect(hit.intents?.[0]).toBe('dispatch')
    expect(hit.intents).toContain('relay')
    expect(new Set(hit.intents).size).toBe(hit.intents?.length)
  })

  it('★ 动作词那几组也会一起带上(两个动作一句话说完)', () => {
    // 「让」(relay)+「查」(find)+「天气」(status):审计之前只剩 relay,她去问了但不会查
    const hit = routeByRules('让豆包查询一下今天深圳的天气。')
    expect(hit.intent).toBe('relay')
    expect(hit.intents?.[0]).toBe('relay')
    expect(hit.intents).toContain('find')
    expect(hit.intents).toContain('status')
  })

  it('认不出意图的回合:intents 缺席 → 照旧全量', () => {
    const asked = routeByRules('然后。', { previous: 'act', pendingAsk: true })
    expect(asked.route).toBe('act')
    expect(asked.intent).toBeUndefined()
    expect(asked.intents).toBeUndefined()
    expect(toolsForIntents(asked.intents)).toBeUndefined()
  })

  it('闲聊回合没有 intents(一件工具都不带)', () => {
    const hit = routeByRules('不是的，不是的。')
    expect(hit.route).toBe('chat')
    expect(hit.intents).toBeUndefined()
  })

  it('★ 问她自己是闲聊里唯一带意图的一类(2026-10-13 夜,卡 V):intents [intro],对照表里那一行零工具', () => {
    const hit = routeByRules('你是谁？')
    expect(hit.route).toBe('chat')
    expect(hit.intents).toEqual(['intro'])
    expect(INTENT_TOOLS.find(one => one.id === 'intro')?.tools).toEqual([])
  })

  it('判定(TurnDecision)把 intents 原样带出来 —— agent.ts 读的是它', async () => {
    const decision = await new RulesTurnRouter().route('把文件发给我，再换个音色')
    expect(decision.intent).toBe('voice')
    expect(decision.intents?.[0]).toBe('voice')
    expect(decision.intents).toContain('file')
  })
})

describe('toolsForIntents:并集 + 挂断那一件', () => {
  it('空的 / 缺席 → undefined(全量)', () => {
    expect(toolsForIntents(undefined)).toBeUndefined()
    expect(toolsForIntents([])).toBeUndefined()
  })

  it('★ 里头有一个认不出的 id → 整个回全量(不许漏能力)', () => {
    expect(toolsForIntents(['voice', '压根没有这一组'])).toBeUndefined()
  })

  it('一个意图时与 toolsForIntent 一字不差(退回那条路没改行为)', () => {
    for (const row of INTENT_TOOLS) {
      expect(toolsForIntents([row.id])).toEqual(toolsForIntent(row.id))
    }
  })

  it('去过重,挂断那一件只有一个', () => {
    const tools = toolsForIntents(['voice', 'change', 'pick']) ?? []
    expect(new Set(tools).size).toBe(tools.length)
    expect(tools.filter(one => one === TOOL_END_CALL)).toHaveLength(1)
  })

  it('★ planTurnTools:有 intents 用并集,没有退回单 intent,再没有就全量', () => {
    const union = planTurnTools({ on: true, intent: 'voice', intents: ['voice', 'file'], all: ALL })
    expect(union?.names).toContain(TOOL_SEND_FILE)
    const single = planTurnTools({ on: true, intent: 'voice', all: ALL })
    expect(single?.names).toEqual([TOOL_VOICE, TOOL_END_CALL])
    // 空的 intents 当没有(退回单 intent)
    expect(planTurnTools({ on: true, intent: 'voice', intents: [], all: ALL })?.names)
      .toEqual([TOOL_VOICE, TOOL_END_CALL])
    // 开关关着照旧全量
    expect(planTurnTools({ on: false, intent: 'voice', intents: ['voice', 'file'], all: ALL })).toBeUndefined()
    // 一个意图都认不出 → 全量
    expect(planTurnTools({ on: true, intents: ['压根没有这一组'], all: ALL })).toBeUndefined()
  })
})

describe('★ 接线还在吗(读 src/agent.ts)', () => {
  it('llmNode 把 decision.intents 传进 planTurnTools', async () => {
    const { readFileSync } = await import('node:fs')
    const source = readFileSync(new URL('../src/agent.ts', import.meta.url), 'utf8')
    const node = source.slice(source.indexOf('const routedLlmNode'), source.indexOf('agent.llmNode ='))
    expect(node).toContain('decision.intents')
    expect(node).toContain('planTurnTools')
  })
})
