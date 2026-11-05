/**
 * **人设一段一段带标记下发**(2026-10-03,卡 ②「chat 路人设按意图裁」,维护者拍板「做」)。
 *
 * 这一头是**标记的主人**:把那一整段人设拆成一段一段,每段写明「哪些意图 / 哪件工具用得上它」。
 * 裁在工人那一侧(`channel-worker/src/personaTrim.ts`),所以这一包钉的是**接缝**:
 *
 *   ① **拼回去逐字就是 `system_message`** —— 工人裁出来的那一份要去替掉上下文里整份人设那一段,
 *      对不上就什么都不敢裁(工人那边 `personaSectionsOf` 的第二道门);
 *   ② **每一段至少有一种标记** —— 一种都没有的段工人会判成「我看不懂这份人设」→ 整份退回;
 *   ③ **同一套意图 id** —— 读 `channel-worker/src/intentTools.ts` 的源码比对
 *      (`INTENT_TOOLS` 里那几个 `id`),少一个这一包就红;
 *   ④ **必带段就是那几样**(身份 / 底线 / 语气 + 不可改清单上的澄清环节);
 *   ⑤ 工人那边的夹具(`channel-worker/tests/fixtures/persona-sections-1003.json`)
 *      就是这一头真算出来的那一份,**不许飘**。
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  buildChannelSystemMessage,
  channelPersonaSections,
  createChannelService,
  PERSONA_ACT_INTENTS,
  PERSONA_CHAT_INTENTS,
  PERSONA_TOOLS_GROUP,
  type ChannelPersonaInput,
  type ChannelPersonaSection,
} from '../src/server/channel.ts'
import { CALL_ADDRESS_BLOCK, CALL_PREFS_BLOCK, markers } from '../src/server/memoryMd.ts'

/** 工人那份夹具是用这几格算出来的(两边必须一字不差,见第 ⑤ 条)。 */
const FIXTURE_INPUT: ChannelPersonaInput = {
  rememberTool: 'wb_note',
  doingTool: 'wb_list_doing',
  handTool: 'wb_supplement',
  inboxName: '收件',
}

const WORKER = join(import.meta.dirname, '..', '..', 'channel-worker')

/** 带「通话偏好」「称呼」两个标记段的一份 AGENTS.md(标记格式的主人是 memoryMd.ts 的 `markers`)。 */
const AGENTS_WITH_PREFS = [
  markers(CALL_PREFS_BLOCK).open,
  '- 别念标题',
  markers(CALL_PREFS_BLOCK).close,
  markers(CALL_ADDRESS_BLOCK).open,
  '- 小笨蛋',
  markers(CALL_ADDRESS_BLOCK).close,
].join('\n')
const chars = (text: string): number => [...text].length

function tagsOf(one: ChannelPersonaSection): string[] {
  return [
    ...(one.always === true ? ['always'] : []),
    ...(one.intents === undefined ? [] : ['intents']),
    ...(one.tool === undefined ? [] : ['tool']),
    ...(one.head === undefined ? [] : ['head']),
  ]
}

describe('① 拼回去逐字就是整份人设', () => {
  it('同一份输入:分段拼起来 === buildChannelSystemMessage', () => {
    for (const input of [
      FIXTURE_INPUT,
      // 没配收件目录名那一种(【文件】那一段换一句话)
      { rememberTool: 'a', doingTool: 'b', handTool: 'c' },
      { ...FIXTURE_INPUT, rulesBlock: '【他的规矩】\n- 电话每轮不超过两句' },
      { ...FIXTURE_INPUT, agentsText: AGENTS_WITH_PREFS },
    ] satisfies ChannelPersonaInput[]) {
      const sections = channelPersonaSections(input)
      expect(sections.map(one => one.text).join('\n')).toBe(buildChannelSystemMessage(input))
    }
  })

  it('`persona()` 下发的那两格也对得上(不是只在用例里拼一次)', async () => {
    const service = createChannelService({
      agentsFile: '/不存在/AGENTS.md',
      env: {},
      configFile: '/不存在',
      rememberTool: 'wb_remember_item',
      doingTool: 'wb_list_doing',
    })
    const persona = await service.persona()
    expect(persona.persona_sections).toBeDefined()
    expect((persona.persona_sections ?? []).map(one => one.text).join('\n')).toBe(persona.system_message)
  })

  it('他的规矩那一段在就多一段、不在就整段不出现(空段不许留)', () => {
    const without = channelPersonaSections(FIXTURE_INPUT)
    const with_ = channelPersonaSections({ ...FIXTURE_INPUT, rulesBlock: '【他的规矩】\n- 每轮两句' })
    expect(with_.length).toBe(without.length + 1)
    expect(without.some(one => one.text === '')).toBe(false)
    // 空白的规矩段等于没给
    expect(channelPersonaSections({ ...FIXTURE_INPUT, rulesBlock: '   ' })).toHaveLength(without.length)
  })

  it('他以前在电话里说过的那几条:有就多一段', () => {
    const got = channelPersonaSections({ ...FIXTURE_INPUT, agentsText: AGENTS_WITH_PREFS })
    expect(got.some(one => one.name === '【以前说过、以后都算数的】')).toBe(true)
  })
})

describe('② 每一段至少有一种标记', () => {
  it('一段都不许「什么标记都没有」(那会让工人整份退回,白标了)', () => {
    for (const one of channelPersonaSections(FIXTURE_INPUT)) {
      expect(tagsOf(one), one.name).not.toHaveLength(0)
    }
  })

  it('标记互斥:一段只用一种(读的人不用猜哪一个说了算)', () => {
    for (const one of channelPersonaSections(FIXTURE_INPUT)) {
      expect(tagsOf(one), one.name).toHaveLength(1)
    }
  })

  it('组的头只有一个,组里的成员都挂着同一个组名', () => {
    const sections = channelPersonaSections(FIXTURE_INPUT)
    const heads = sections.filter(one => one.head !== undefined)
    expect(heads.map(one => one.head)).toEqual([PERSONA_TOOLS_GROUP])
    const members = sections.filter(one => one.group !== undefined && one.head === undefined)
    expect(members.length).toBeGreaterThan(5)
    expect(members.every(one => one.group === PERSONA_TOOLS_GROUP)).toBe(true)
    // 头自己不算组里那一条(否则「组里有人带上了」会恒为真)
    expect(heads.every(one => one.group === undefined)).toBe(true)
  })

  it('段名不重复(工人按段名记日志)', () => {
    const names = channelPersonaSections(FIXTURE_INPUT).map(one => one.name)
    expect(new Set(names).size).toBe(names.length)
  })
})

describe('③ 对照源头:与 channel-worker 的 intentTools.ts 同一套意图 id', () => {
  /** 读那个文件的源码,把 `INTENT_TOOLS` 里那几个 `id: '…'` 抠出来。 */
  const intentTools = readFileSync(join(WORKER, 'src', 'intentTools.ts'), 'utf8')
  const ids = [...intentTools.matchAll(/^\s{4}id: '([a-z]+)',$/gm)].map(one => one[1] as string)

  it('源码里真抠出来十来个 id(正则失效时当场显形,而不是悄悄比了个空集)', () => {
    expect(ids.length).toBeGreaterThanOrEqual(10)
  })

  it('★ `PERSONA_ACT_INTENTS` + `PERSONA_CHAT_INTENTS` 与那一套一个不差(2026-10-13 夜起多了闲聊那一侧的「介绍自己」)', () => {
    expect([...PERSONA_ACT_INTENTS, ...PERSONA_CHAT_INTENTS].sort()).toEqual([...ids].sort())
    // 两边不重叠:介绍自己是零工具的闲聊回合,不是要办事。
    for (const id of PERSONA_CHAT_INTENTS) expect(PERSONA_ACT_INTENTS).not.toContain(id)
  })

  it('★ 标在段上的每一个 id 都在那一套里', () => {
    for (const one of channelPersonaSections(FIXTURE_INPUT)) {
      for (const id of one.intents ?? []) expect(ids, `${one.name} → ${id}`).toContain(id)
    }
  })

  it('★ 按工具标的那几段,工具名就是这份人设里真点过名的那几件', () => {
    const sections = channelPersonaSections(FIXTURE_INPUT)
    const full = buildChannelSystemMessage(FIXTURE_INPUT)
    for (const one of sections) {
      if (one.tool === undefined) continue
      expect(full, one.name).toContain(one.tool)
      // 这一段自己就在讲那一件(不是别处提了一句)
      expect(one.text, one.name).toContain(one.tool)
    }
  })
})

describe('④ 必带段', () => {
  const sections = channelPersonaSections(FIXTURE_INPUT)

  it('身份 / 底线 / 语气 + 澄清环节(不可改清单,PRD §9)都是必带', () => {
    const always = sections.filter(one => one.always === true).map(one => one.name)
    expect(always).toContain('开头')
    expect(always).toContain('【只有一个「我」】')
    expect(always).toContain('【怎么说话】')
    expect(always).toContain('【说话的规矩】')
    expect(always).toContain('【拿不准的时候怎么问】')
    expect(always).toContain('【语气】')
  })

  it('讲工具的那十来条、听不准、文件、手上的事都**不是**必带(闲聊回合用不上)', () => {
    const notAlways = sections.filter(one => one.always !== true).map(one => one.name)
    expect(notAlways).toContain('【你能做什么】')
    expect(notAlways).toContain('【听不准的时候】')
    expect(notAlways).toContain('【文件】')
    expect(notAlways).toContain('【手上的事】')
  })

  it('必带段加起来约占整份一半 —— 闲聊回合省下的就是另外那一半', () => {
    /*
     * ★ 2026-10-14(卡 AA):只标闲聊意图的那几段(【介绍自己】,`PERSONA_CHAT_INTENTS`)不算进「整份」——
     * 它们只在问她自己的回合带,闲聊 / 办事回合都不带,与这条「省下的是办事那一半」的口径无关。
     */
    const chatOnly = (one: ChannelPersonaSection): boolean => one.intents !== undefined && one.intents.every(id => PERSONA_CHAT_INTENTS.includes(id))
    const full = chars(sections.filter(one => !chatOnly(one)).map(one => one.text).join('\n'))
    const always = chars(sections.filter(one => one.always === true).map(one => one.text).join('\n'))
    expect(always).toBeLessThan(full * 0.55)
    expect(always).toBeGreaterThan(full * 0.4)
  })
})

describe('⑤ 工人那份夹具就是这一头算出来的', () => {
  it('★ `channel-worker/tests/fixtures/persona-sections-1003.json` 一字不差', () => {
    const fixture = JSON.parse(
      readFileSync(join(WORKER, 'tests', 'fixtures', 'persona-sections-1003.json'), 'utf8'),
    ) as ChannelPersonaSection[]
    // 改了人设这一条就红:**照这一头重新生成那份夹具**(它是工人那一侧量字数与对照段名的底本)。
    expect(fixture).toEqual(channelPersonaSections(FIXTURE_INPUT))
  })

  it('工人那边的 `PersonaSection` 与这边的 `ChannelPersonaSection` 同一套格', () => {
    const trim = readFileSync(join(WORKER, 'src', 'personaTrim.ts'), 'utf8')
    for (const key of ['name: string', 'text: string', 'always?: true', 'intents?: readonly string[]', 'tool?: string', 'head?: string', 'group?: string']) {
      expect(trim, key).toContain(key)
    }
  })
})
