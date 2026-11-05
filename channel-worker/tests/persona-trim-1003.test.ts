/**
 * **人设按意图裁**(2026-10-03,卡 ②「chat 路人设按意图裁」,维护者拍板「做」)。
 *
 * 来处:`docs/交接-1003-首声提速.md` 第一节末那句照实话 ——
 * 「**chat < 1s 这一半这张卡一件事都没做**。chat 路本来就不带工具,它的 1934ms(p95)
 * 全在『长人设 + 模型本身 + 跨境那一跳』上」。那份人设 **3159 字**、每一个回合整份重发。
 *
 * 这一包钉五件:
 *   ① 裁法({@link personaForTurn}):必带段一段不少、按意图的段、按工具的段、组的头、
 *      **看不懂就整份退回**;
 *   ② 8791 下发那一格的两道门({@link personaSectionsOf}):形状 + 「拼回去逐字等于整份」;
 *   ③ 换上下文里那条消息({@link withTrimmedPersona}):**不原地改**(框架 `copy()` 是浅的)、
 *      找不着就原样;
 *   ④ **对照源头**:读 `workbench-plugin/src/server/channel.ts` 比对段名与那几个标记,
 *      再拿工作台真算出来的那一份夹具跑一遍(两边同一套意图 id);
 *   ⑤ 成绩单:每个意图这一回合的人设多少字(交接里引的就是它)。
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { llm as llmNs } from '@livekit/agents'
import { describe, expect, it } from 'vitest'
import { ALWAYS_TOOLS, INTENT_TOOLS, toolsForIntents } from '../src/intentTools.ts'
import {
  personaForTurn,
  personaSectionsOf,
  withTrimmedPersona,
  type PersonaChatContext,
  type PersonaChatItem,
  type PersonaSection,
} from '../src/personaTrim.ts'
import { channelWorkerConfigOf } from '../src/config.ts'

const chars = (text: string): number => [...text].length

/** 工作台真算出来的那一份(夹具由 `workbench-plugin/tests/persona-sections-1003.test.ts` 钉着不许飘)。 */
const REAL: readonly PersonaSection[] = JSON.parse(
  readFileSync(join(import.meta.dirname, 'fixtures', 'persona-sections-1003.json'), 'utf8'),
) as PersonaSection[]
const REAL_FULL = REAL.map(one => one.text).join('\n')

/** 手写的一小份:判法用例拿它跑,不跟着人设的真文字一起变。 */
const FAKE: readonly PersonaSection[] = [
  { name: '身份', text: '你就是事务官。', always: true },
  { name: '【语气】', text: '【语气】每句开头一个标签。', always: true },
  { name: '【手上的事】', text: '【手上的事】快照。', intents: ['lookup', 'dispatch'] },
  { name: '【你能做什么】', text: '【你能做什么】', head: '工具' },
  { name: '工具的成败', text: '- 没办成就说没办成。', group: '工具', intents: ['lookup', 'dispatch'] },
  { name: '换嗓子', text: '- 要换嗓子 → wb_set_voice。', group: '工具', tool: 'wb_set_voice' },
  { name: '去办', text: '- 要去办 → wb_dispatch_item。', group: '工具', tool: 'wb_dispatch_item' },
]

// ———————————————————— ① 裁法 ————————————————————

describe('personaForTurn:这一回合带哪几段', () => {
  it('闲聊回合(没有意图、手上没工具)→ **只剩必带段**', () => {
    const got = personaForTurn(FAKE, { intents: [], tools: [] })
    expect(got?.kept).toEqual(['身份', '【语气】'])
    expect(got?.text).toBe('你就是事务官。\n【语气】每句开头一个标签。')
    expect(got?.dropped).toContain('【你能做什么】')
  })

  it('换音色那一回合:必带段 + 换嗓子那一条,别的工具说明一条都不带', () => {
    const got = personaForTurn(FAKE, { intents: ['voice'], tools: ['wb_set_voice', 'wb_end_call'] })
    expect(got?.kept).toEqual(['身份', '【语气】', '【你能做什么】', '换嗓子'])
    // 「手上的事」那份快照不在 voice 的意图里 → 不带
    expect(got?.dropped).toContain('【手上的事】')
  })

  it('派活那一回合:按意图的段与按工具的段一起带', () => {
    const got = personaForTurn(FAKE, { intents: ['dispatch'], tools: ['wb_dispatch_item'] })
    expect(got?.kept).toEqual(['身份', '【语气】', '【手上的事】', '【你能做什么】', '工具的成败', '去办'])
  })

  it('**组的头**:组里一条都没带上时,【你能做什么】那一行自己也不出现', () => {
    const got = personaForTurn(FAKE, { intents: [], tools: [] })
    expect(got?.kept).not.toContain('【你能做什么】')
  })

  it('组里只要有一条带上了,头就带上(头自己不算组里那一条)', () => {
    const got = personaForTurn(FAKE, { intents: [], tools: ['wb_set_voice'] })
    expect(got?.kept).toEqual(['身份', '【语气】', '【你能做什么】', '换嗓子'])
  })

  it('段的顺序一个都不许挪(人设是按顺序读的)', () => {
    const got = personaForTurn(FAKE, { intents: ['lookup', 'dispatch'], tools: ['wb_dispatch_item', 'wb_set_voice'] })
    expect(got?.kept).toEqual(FAKE.map(one => one.name))
    expect(got?.text).toBe(REALLY_ALL)
  })

  it('**一段四种标记一个都没有 → 整份退回**(看不懂的人设一个字都不裁)', () => {
    const odd = [...FAKE, { name: '新来的一段', text: '- 谁知道这是什么。' }]
    expect(personaForTurn(odd, { intents: [], tools: [] })).toBeUndefined()
  })

  it('没下发分段 / 下发了个空的 → 整份退回', () => {
    expect(personaForTurn(undefined, { intents: [], tools: [] })).toBeUndefined()
    expect(personaForTurn([], { intents: [], tools: [] })).toBeUndefined()
  })

  it('一段都没留下 → 整份退回(不交一份空人设出去)', () => {
    const noAlways: PersonaSection[] = [{ name: '只给 voice', text: 'x', intents: ['voice'] }]
    expect(personaForTurn(noAlways, { intents: [], tools: [] })).toBeUndefined()
  })

  it('意图 / 工具那两格缺席与空数组是同一个意思', () => {
    expect(personaForTurn(FAKE, {})?.kept).toEqual(['身份', '【语气】'])
  })
})

const REALLY_ALL = FAKE.map(one => one.text).join('\n')

// ———————————————————— ② 下发那一格的两道门 ————————————————————

describe('personaSectionsOf:8791 下发的那一格认不认', () => {
  it('工作台真算出来的那一份:认,而且拼回去逐字等于整份', () => {
    const got = personaSectionsOf(REAL, REAL_FULL)
    expect(got).toHaveLength(REAL.length)
    expect(got?.map(one => one.text).join('\n')).toBe(REAL_FULL)
  })

  it('**拼回去对不上整份就整格扔掉**(两边不是同一份东西,宁可一个字都不裁)', () => {
    expect(personaSectionsOf(REAL, `${REAL_FULL}\n多了一行`)).toBeUndefined()
  })

  it('老工作台没有这一格 / 给了个不是数组的 → 缺席', () => {
    expect(personaSectionsOf(undefined, 'x')).toBeUndefined()
    expect(personaSectionsOf([], 'x')).toBeUndefined()
    expect(personaSectionsOf('一段字', 'x')).toBeUndefined()
    expect(personaSectionsOf([null], 'x')).toBeUndefined()
  })

  it('形状不对的一段 → 整格扔掉(段名空的、text 不是字、标记类型不对)', () => {
    const ok = [{ name: '甲', text: 'x', always: true }]
    expect(personaSectionsOf(ok, 'x')).toHaveLength(1)
    expect(personaSectionsOf([{ name: '  ', text: 'x', always: true }], 'x')).toBeUndefined()
    expect(personaSectionsOf([{ name: '甲', text: 1, always: true }], 'x')).toBeUndefined()
    expect(personaSectionsOf([{ name: '甲', text: 'x', always: 'yes' }], 'x')).toBeUndefined()
    expect(personaSectionsOf([{ name: '甲', text: 'x', intents: 'voice' }], 'x')).toBeUndefined()
    expect(personaSectionsOf([{ name: '甲', text: 'x', intents: [''] }], 'x')).toBeUndefined()
    expect(personaSectionsOf([{ name: '甲', text: 'x', tool: '' }], 'x')).toBeUndefined()
    expect(personaSectionsOf([{ name: '甲', text: 'x', head: 1 }], 'x')).toBeUndefined()
  })

  it('多出来的键原样丢掉(以后工作台加一格,老工人不会因此判废)', () => {
    const got = personaSectionsOf([{ name: '甲', text: 'x', always: true, 以后才有的一格: 7 }], 'x')
    expect(got).toEqual([{ name: '甲', text: 'x', always: true }])
  })
})

// ———————————————————— ③ 换上下文里那条消息 ————————————————————

/** 十行的假上下文 —— 和 turnRoute.ts 那几条用例同一个做法,不起 LiveKit。 */
function fakeCtx(items: PersonaChatItem[]): PersonaChatContext & { items: PersonaChatItem[] } {
  return {
    items,
    copy(): PersonaChatContext {
      return fakeCtx([...items])
    },
  }
}

const replace = (like: PersonaChatItem, text: string): PersonaChatItem => ({ ...like, content: [text] })

describe('withTrimmedPersona:只换这一次那份副本里的人设那一条', () => {
  it('换掉的就是那一段,别的消息一个字不动', () => {
    const items: PersonaChatItem[] = [
      { type: 'message', role: 'system', content: ['整份人设\n底下还有一段'] },
      { type: 'message', role: 'user', content: ['帮我换个音色'] },
    ]
    const ctx = fakeCtx(items)
    const got = withTrimmedPersona(ctx, { full: '整份人设', trimmed: '裁过的', replace })
    expect(got).not.toBe(ctx)
    expect(got.items[0]?.content).toEqual(['裁过的\n底下还有一段'])
    expect(got.items[1]?.content).toEqual(['帮我换个音色'])
  })

  it('**原来那一份一个字都没动**(框架的 copy() 是浅的,原地改会把对话历史也改了)', () => {
    const items: PersonaChatItem[] = [{ type: 'message', role: 'system', content: ['整份人设'] }]
    const ctx = fakeCtx(items)
    withTrimmedPersona(ctx, { full: '整份人设', trimmed: '裁过的', replace })
    expect(items[0]?.content).toEqual(['整份人设'])
  })

  it('找不着那条人设消息 → **原样返回**(连副本都不造),而且说一句', () => {
    const said: string[] = []
    const ctx = fakeCtx([{ type: 'message', role: 'user', content: ['喂'] }])
    const got = withTrimmedPersona(ctx, { full: '整份人设', trimmed: '裁过的', replace, log: one => said.push(one) })
    expect(got).toBe(ctx)
    expect(said.join('')).toContain('找不到那份人设')
  })

  it('裁出来的与整份一样 / 整份是空的 → 原样返回(不白造一个副本)', () => {
    const ctx = fakeCtx([{ type: 'message', role: 'system', content: ['整份人设'] }])
    expect(withTrimmedPersona(ctx, { full: '整份人设', trimmed: '整份人设', replace })).toBe(ctx)
    expect(withTrimmedPersona(ctx, { full: '', trimmed: 'x', replace })).toBe(ctx)
  })

  it('content 不是「就一段字」的那种消息一律不碰(图片、多段的那些)', () => {
    const ctx = fakeCtx([
      { type: 'message', role: 'system', content: ['整份人设', '还有一段'] },
      { type: 'message', role: 'system', content: [{ 不是字: true }] },
    ])
    expect(withTrimmedPersona(ctx, { full: '整份人设', trimmed: '裁过的', replace })).toBe(ctx)
  })
})

describe('真拿框架的 ChatContext 走一次(浅 copy 那个坑)', () => {
  it('★ 换的是副本里那一条,**框架那份原件一个字没动**', () => {
    const full = '整份人设'
    // 真机上那一条不止人设:后面还接着「关于我自己」与「开场白已经说过了」(agent.ts 的 `baseInstructions`)。
    const instructions = `${full}\n\n关于我自己:…\n(开场白已经说过了。)`
    const ctx = llmNs.ChatContext.empty()
    // 框架给人设那一条落的就是这个 id(`dist/voice/generation.js` 第 343 行);原样留着。
    ctx.items.unshift(llmNs.ChatMessage.create({ id: 'lk.agent_task.instructions', role: 'system', content: [instructions] }))
    ctx.addMessage({ role: 'user', content: '帮我换个音色' })
    const got = withTrimmedPersona(ctx as unknown as PersonaChatContext, {
      full,
      trimmed: '裁过的',
      replace: (like, text) => llmNs.ChatMessage.create({
        ...(typeof (like as { id?: unknown }).id === 'string' ? { id: (like as { id: string }).id } : {}),
        role: 'system',
        content: [text],
      }) as unknown as PersonaChatItem,
    }) as unknown as InstanceType<typeof llmNs.ChatContext>
    expect((got.items[0] as { content: unknown[] }).content)
      .toEqual(['裁过的\n\n关于我自己:…\n(开场白已经说过了。)'])
    // ★ 那个 id 留住了:框架在 llmNode 之前按它找人设那一条(`updateInstructions` / `applyInstructionsModality`)
    expect((got.items[0] as { id: string }).id).toBe('lk.agent_task.instructions')
    // ★★ `ChatContext.copy()` 是**浅**的(`dist/llm/chat_context.js` 原样 `items.push(item)`)——
    //    原地改那条消息会把对话历史里那一条也改掉,裁过的人设于是留到下一回合。
    expect((ctx.items[0] as { content: unknown[] }).content).toEqual([instructions])
    expect(got.items).toHaveLength(ctx.items.length)
  })
})

// ———————————————————— ④ 对照源头 ————————————————————

describe('对照源头:段与标记的主人是工作台', () => {
  const channel = readFileSync(
    join(import.meta.dirname, '..', '..', 'workbench-plugin', 'src', 'server', 'channel.ts'),
    'utf8',
  )

  it('工作台那一头真有这一套:`ChannelPersonaSection` 与四种标记', () => {
    expect(channel).toContain('export interface ChannelPersonaSection')
    expect(channel).toContain('export function channelPersonaSections')
    for (const tag of ['always?: true', 'intents?: readonly string[]', 'tool?: string', 'head?: string', 'group?: string']) {
      expect(channel, tag).toContain(tag)
    }
  })

  it('**段名比对**:夹具里每一个段名都在工作台那份源码里写着', () => {
    for (const one of REAL) expect(channel, one.name).toContain(`name: '${one.name}'`)
  })

  it('必带段就是卡上点名的那几样(身份 / 底线 / 语气)外加不可改清单上的澄清环节', () => {
    const always = REAL.filter(one => one.always === true).map(one => one.name)
    expect(always).toEqual([
      '开头',
      '【只有一个「我」】',
      '【怎么说话】',
      '【说话的规矩】',
      '【拿不准的时候怎么问】',
      '【语气】',
    ])
  })

  it('★ **同一套意图 id**:工作台标的那几个 id 与 `intentTools.ts` 的 `INTENT_TOOLS` 一个不差', () => {
    const mine = new Set(INTENT_TOOLS.map(one => one.id))
    const theirs = new Set(REAL.flatMap(one => one.intents ?? []))
    expect([...theirs].sort()).toEqual([...mine].sort())
  })

  it('★ 按工具标的那几段,工具名都是真有的那几件', () => {
    const real = new Set([...INTENT_TOOLS.flatMap(one => one.tools), ...ALWAYS_TOOLS])
    for (const one of REAL) {
      if (one.tool === undefined) continue
      expect(real.has(one.tool), `${one.name} → ${one.tool}`).toBe(true)
    }
  })

  it('★ 每一件工具的说明,只在**手上有它**的那几个回合出现', () => {
    for (const row of INTENT_TOOLS) {
      const tools = toolsForIntents([row.id]) as readonly string[]
      const got = personaForTurn(REAL, { intents: [row.id], tools }) as { kept: readonly string[] }
      for (const one of REAL) {
        if (one.tool === undefined) continue
        expect(got.kept.includes(one.name), `${row.id} / ${one.name}`).toBe(tools.includes(one.tool))
      }
    }
  })
})

describe('接线对照:agent.ts 真把它接在 llmNode 上', () => {
  const agentSrc = readFileSync(join(import.meta.dirname, '..', 'src', 'agent.ts'), 'utf8')

  it('两条路都裁(闲聊那一条、要办事那一条),而且走的是上下文副本那条路', () => {
    expect(agentSrc).toContain('const trimPersona =')
    expect(agentSrc).toContain('personaForTurn(persona.persona_sections')
    expect(agentSrc).toContain('withTrimmedPersona(ctx, {')
    // 闲聊那一条:意图是空的、手上就挂断那一件
    expect(agentSrc).toContain('const turn: PersonaTurn = { intents: [], tools:')
    // 要办事那一条:真送出去的那几件
    expect(agentSrc).toContain('trimPersona(withHub, { intents: actIntents, tools: plan.names })')
  })

  it('开关关着一个字都不裁', () => {
    const at = agentSrc.indexOf('const trimPersona =')
    expect(at).toBeGreaterThan(0)
    expect(agentSrc.slice(at, at + 400)).toContain('deps.config.personaByIntent')
  })

  it('引导与来电接起那两通压根不走这儿(照旧整份)', () => {
    const at = agentSrc.indexOf('const trimPersona =')
    const before = agentSrc.slice(0, at)
    // 那两种在分流之前就早返回了(与工具按意图下发同一条例外)
    expect(before).toContain("if (onboardingOn || ring?.answered() !== undefined) {")
  })
})

describe('开关:WORKBENCH_CHANNEL_PERSONA_BY_INTENT', () => {
  it('不配 = 开', () => {
    expect(channelWorkerConfigOf({}).personaByIntent).toBe(true)
  })

  it('=off 就逐字回到每回合整份', () => {
    expect(channelWorkerConfigOf({ WORKBENCH_CHANNEL_PERSONA_BY_INTENT: 'off' }).personaByIntent).toBe(false)
  })
})

// ———————————————————— ⑤ 成绩单 ————————————————————

describe('★★ 改前改后:一个回合的人设多少字', () => {
  it('打出成绩单(交接里引的就是这几行)', () => {
    const full = chars(REAL_FULL)
    const chat = personaForTurn(REAL, { intents: [], tools: [] }) as { text: string, dropped: readonly string[] }
    const chatEnd = personaForTurn(REAL, { intents: [], tools: [...ALWAYS_TOOLS] }) as { text: string }
    const lines = [
      '',
      `整份人设 ${full} 字(每一个回合都重发一遍 —— 这是改前)`,
      `闲聊回合(没有意图、手上零工具):${chars(chat.text)} 字,省 `
      + `${(((full - chars(chat.text)) / full) * 100).toFixed(1)}%;没带 ${chat.dropped.length} 段:${chat.dropped.join('、')}`,
      `闲聊回合 + 只递挂断那一件:${chars(chatEnd.text)} 字(挂断那一件在人设里没有自己的一段,所以与上一行相同)`,
      '',
      '要办事的回合(按意图):',
      ...INTENT_TOOLS.map((row) => {
        const tools = toolsForIntents([row.id]) as readonly string[]
        const got = personaForTurn(REAL, { intents: [row.id], tools }) as { text: string }
        return `  ${row.id.padEnd(9)} ${String(tools.length).padStart(2)} 件工具  ${chars(got.text)} 字  `
          + `省 ${(((full - chars(got.text)) / full) * 100).toFixed(1)}%`
      }),
      `  认不出意图 → 全套工具      ${full} 字  省 0.0%(不漏规矩)`,
    ]
    // eslint-disable-next-line no-console
    console.log(lines.join('\n'))

    // ★★ 卡上量的那一个:闲聊回合的人设砍掉一半
    expect(chars(chat.text)).toBeLessThan(full * 0.55)
    // ★ 必带段一段都不许少
    expect(chat.text).toContain('【语气】')
    expect(chat.text).toContain('【拿不准的时候怎么问】')
    expect(chat.text).toContain('【说话的规矩】')
    expect(chat.text).toContain('【只有一个「我」】')
    // ★ 闲聊回合不带那十来条工具说明
    expect(chat.text).not.toContain('【你能做什么】')
    // ★ 认不出意图 + 全套工具 = **逐字等于整份**(不漏规矩那一条)
    const allTools = [...new Set([...INTENT_TOOLS.flatMap(one => one.tools), ...ALWAYS_TOOLS])]
    const everything = personaForTurn(REAL, { intents: INTENT_TOOLS.map(one => one.id), tools: allTools })
    expect(everything?.text).toBe(REAL_FULL)
  })
})

/* ──────── ★ 介绍自己那一段只在 intro 回合带(2026-10-13 夜,卡 V)──────── */

describe('★【介绍自己】那一段', () => {
  const INTRO = REAL.find(one => one.name === '【介绍自己】')
  it('工作台真算出来的那份里有它,只标 intro', () => {
    expect(INTRO).toBeDefined()
    expect(INTRO?.intents).toEqual(['intro'])
  })
  it('闲聊回合默认不带;问她自己那一回合带上,仍是零工具', () => {
    const chat = personaForTurn(REAL, { intents: [], tools: [] }) as { kept: readonly string[], dropped: readonly string[] }
    expect(chat.dropped).toContain('【介绍自己】')
    const intro = personaForTurn(REAL, { intents: ['intro'], tools: [] }) as { kept: readonly string[], text: string }
    expect(intro.kept).toContain('【介绍自己】')
    expect(intro.text).toContain('桌上多一部电话')
    // 要办事那几段照旧不带。
    expect(intro.kept).not.toContain('【手上的事】')
  })
})

