/**
 * **工具按意图只下发用得上的那几件**(2026-10-03,卡「首声提速」甲)。
 *
 * 这一份钉四件事:
 *   ① **对照表只有一处**,而且 `turnRoute.ts` 那边有一个意图 id,这边就得有一行
 *      (漏一行 = 那个意图悄悄退回全套,省不下来还查不出来);
 *   ② 表里**每个工具名都真的存在** —— 读的是源头 `createChannelTools` 真造出来的那一份,
 *      不是另抄一张名单(抄错的那一行会静默地变成「这一组少一件」);
 *   ③ 认不出意图 → **全量**(卡上原话「分不出意图时退回全量(不许漏能力)」);
 *   ④ **省了多少字**(成绩单的一半,另一半在 `air-1002-replay.test.ts`)。
 */
import { describe, expect, it } from 'vitest'
import { llm as llmNs } from '@livekit/agents'
import { ALWAYS_TOOLS, INTENT_TOOLS, intentToolNote, pickTools, planTurnTools, toolsForIntent } from '../src/intentTools.ts'
import { ACT_INTENTS, FOLLOW_ACT_INTENTS, LOOKUP_INTENT, RELAY_INTENT, INTRO_INTENT } from '../src/turnRoute.ts'
import { TOOL_END_CALL } from '../src/farewell.ts'
import { TOOL_LAYOUT, TOOL_SEND_FILE, TOOL_VOICE, createChannelTools } from '../src/tools.ts'

/**
 * 真造一份工具集。**一件都不会被执行** —— 这里要的只是「有哪几件、每件的说明书多长」,
 * 所以依赖全是永不被调用的桩(造工具这一步本身不发任何请求)。
 */
function realTools(): Record<string, { description?: string, parameters?: unknown }> {
  const stub = new Proxy({}, { get: () => async () => ({ ok: true, text: '' }) }) as never
  return createChannelTools({
    workbench: stub,
    voice: stub,
    deviceFiles: stub,
    endCall: () => ({ ok: true, text: '' }),
  }) as unknown as Record<string, { description?: string, parameters?: unknown }>
}

/** 一件工具发给模型要占多少字(名字 + 说明书 + 参数表)。 */
function sizeOf(tools: Record<string, { description?: string, parameters?: unknown }>, name: string): number {
  const tool = tools[name]
  if (tool === undefined) return 0
  return name.length + String(tool.description ?? '').length + JSON.stringify(tool.parameters ?? {}).length
}

function sizeOfAll(tools: Record<string, { description?: string, parameters?: unknown }>, names: readonly string[]): number {
  return names.reduce((sum, name) => sum + sizeOf(tools, name), 0)
}

/** `turnRoute.ts` 里**所有**会落到判定上的意图 id。 */
const ALL_INTENT_IDS: readonly string[] = [...new Set([
  ...ACT_INTENTS.map(one => one.id),
  LOOKUP_INTENT.id,
  RELAY_INTENT.id,
  ...FOLLOW_ACT_INTENTS.map(one => one.id),
  // ★ 闲聊那一侧唯一的意图(2026-10-13 夜,卡 V):介绍自己,零工具,只为带上人设里那一段。
  INTRO_INTENT,
])]

describe('对照表只有一处', () => {
  it('★ turnRoute 那边每一个意图 id,这边都有一行', () => {
    const listed = new Set(INTENT_TOOLS.map(one => one.id))
    const missing = ALL_INTENT_IDS.filter(id => !listed.has(id))
    expect(missing).toEqual([])
  })

  it('这边不许有 turnRoute 那边压根不存在的意图(两边各自漂就是从这儿开始的)', () => {
    const known = new Set(ALL_INTENT_IDS)
    expect(INTENT_TOOLS.filter(one => !known.has(one.id)).map(one => one.id)).toEqual([])
  })

  it('一个意图只许有一行', () => {
    expect(new Set(INTENT_TOOLS.map(one => one.id)).size).toBe(INTENT_TOOLS.length)
  })

  it('★★ 表里每个工具名都真的存在(读的是 createChannelTools 造出来的那一份)', () => {
    const real = realTools()
    const unknown = [...INTENT_TOOLS.flatMap(one => [...one.tools]), ...ALWAYS_TOOLS]
      .filter(name => real[name] === undefined)
    expect(unknown).toEqual([])
  })

  it('每一组都写了「故意不给哪一类」(交接与日志读它,代码不读)', () => {
    expect(INTENT_TOOLS.every(one => one.without.trim() !== '')).toBe(true)
  })
})

describe('挑哪几件', () => {
  it('★ 认不出意图 / 没有意图 → 全量(undefined)', () => {
    expect(toolsForIntent(undefined)).toBeUndefined()
    expect(toolsForIntent('')).toBeUndefined()
    expect(toolsForIntent('这个意图不存在')).toBeUndefined()
  })

  it('挂断那一件每一组都有(她在交代事情中间说「先这样吧」是常事)', () => {
    for (const row of INTENT_TOOLS) {
      expect(toolsForIntent(row.id)).toContain(TOOL_END_CALL)
    }
  })

  it('换音色那一组只有换音色 + 挂断 —— 省得最干净的一组', () => {
    expect(toolsForIntent('voice')).toEqual([TOOL_VOICE, TOOL_END_CALL])
  })

  it('文件那一组不给版面、版面那几件只在含糊的那一组里', () => {
    expect(toolsForIntent('file')).not.toContain(TOOL_LAYOUT)
    // 「换成 / 挪到 / 改一下」分不出是看板上的事还是屏幕上的版面 —— 两样都给(认错的方向宁可宽)
    expect(toolsForIntent('change')).toContain(TOOL_LAYOUT)
    // 「打开豆包放个音乐」那一类不该为了版面多背 1400 字
    expect(toolsForIntent('operate')).not.toContain(TOOL_LAYOUT)
    expect(toolsForIntent('operate')).not.toContain(TOOL_SEND_FILE)
  })

  it('每一组都去过重', () => {
    for (const row of INTENT_TOOLS) {
      const got = toolsForIntent(row.id) as readonly string[]
      expect(new Set(got).size).toBe(got.length)
    }
  })

  it('pickTools:挑不着的名字跳过,不抛', () => {
    const picked = pickTools({ a: 1, b: 2 }, ['a', '不存在', 'b'])
    expect(picked).toEqual({ a: 1, b: 2 })
  })

  it('★ pickTools:一件都不剩就回 undefined(调用方按全量走 —— act 路上「一件工具都没有」是另一种错)', () => {
    expect(pickTools({ a: 1 }, ['不存在'])).toBeUndefined()
    expect(pickTools({}, [])).toBeUndefined()
  })
})

describe('★★ 这一回合到底递哪几件(agent.ts 的 llmNode 只照它办)', () => {
  const real = realTools()

  it('开关关着 → 全量(undefined),逐字回到这一版之前', () => {
    expect(planTurnTools({ on: false, intent: 'voice', all: real })).toBeUndefined()
  })

  it('★ 认不出意图 → 全量', () => {
    expect(planTurnTools({ on: true, all: real })).toBeUndefined()
    expect(planTurnTools({ on: true, intent: '不存在这个意图', all: real })).toBeUndefined()
  })

  it('认得出意图 → 就那几件(换音色那一组最干净)', () => {
    const plan = planTurnTools({ on: true, intent: 'voice', all: real })
    expect(plan?.names).toEqual([TOOL_VOICE, TOOL_END_CALL])
    expect(Object.keys(plan?.tools ?? {})).toEqual([TOOL_VOICE, TOOL_END_CALL])
  })

  it('★ 这台机器上那一组一件都没装上 → 也回全量(「这一回合一件工具都没有」是另一种错)', () => {
    // 没配音色服务的那台:`createChannelTools` 里压根没有换音色那一件
    expect(planTurnTools({ on: true, intent: 'voice', all: {} })).toBeUndefined()
  })

  it('手上那一份缺席(拿不到这一次要发的那份)→ 全量', () => {
    expect(planTurnTools({ on: true, intent: 'voice' })).toBeUndefined()
  })
})

/**
 * ——— **真用框架造一次**(这一节是这张卡最要紧的一条用例)———
 *
 * `agent.ts` 的 `llmNode` 要把挑出来的那几件装回一个 `ToolContext` 再交给上游。
 * 框架收**对象**时要求每一件是匿名的(`normalizeToolContextInit`:
 * `if ("name" in toolValue || "id" in toolValue) throw`),而我们挑出来的那几件
 * 是从 `toolCtx.functionTools` 来的 —— 早就被框架落上了 `id` 与 `name`。
 * 拿对象去造会抛「must be anonymous」,**每一个要办事的回合都炸**(写这张卡时第一版就是这么写的)。
 * 所以走的是收**数组**那条路,这里真造一次钉住它。
 */
describe('★★ 真用框架造一次(收数组那条路)', () => {
  it('挑完的那几件能装回 ToolContext,名字与件数都对', () => {
    const full = new llmNs.ToolContext(realTools() as never)
    const plan = planTurnTools({ on: true, intent: 'voice', all: full.functionTools })
    const narrowed = new llmNs.ToolContext(Object.values(plan?.tools ?? {}) as never)
    expect(Object.keys(narrowed.functionTools)).toEqual([TOOL_VOICE, TOOL_END_CALL])
    expect(narrowed.hasTool(TOOL_VOICE)).toBe(true)
    expect(narrowed.hasTool(TOOL_LAYOUT)).toBe(false)
  })

  it('★ 对象那条路会抛「must be anonymous」—— 这就是上面为什么用数组', () => {
    const full = new llmNs.ToolContext(realTools() as never)
    const one = full.functionTools[TOOL_VOICE]
    expect(() => new llmNs.ToolContext({ [TOOL_VOICE]: one } as never)).toThrow(/anonymous/)
  })

  it('每一组都装得进去(一组一次,真造)', () => {
    const full = new llmNs.ToolContext(realTools() as never)
    for (const row of INTENT_TOOLS) {
      const plan = planTurnTools({ on: true, intent: row.id, all: full.functionTools })
      const narrowed = new llmNs.ToolContext(Object.values(plan?.tools ?? {}) as never)
      expect(Object.keys(narrowed.functionTools)).toEqual([...(plan?.names ?? [])])
    }
  })
})

describe('人设里跟着只讲那几件(那一行)', () => {
  it('把手上那几件念出来,并且不许它把结果说成办好了', () => {
    const note = intentToolNote([TOOL_VOICE, TOOL_END_CALL])
    expect(note).toContain(TOOL_VOICE)
    expect(note).toContain(TOOL_END_CALL)
    expect(note).toContain('一个结果都不许说成已经办了')
  })

  it('★ 这一行里一个数字都没有(「不经模型的地方不经模型」:进度与事实只来自工具结果)', () => {
    expect(/[0-9]/.test(intentToolNote([TOOL_VOICE]))).toBe(false)
  })

  it('不念系统里的名词(10-02「只说她关心的」那一份词)', () => {
    const note = intentToolNote([TOOL_VOICE])
    for (const word of ['看板', '栏位', '待办', '等你确认']) expect(note).not.toContain(word)
  })
})

describe('★★ 省了多少字(成绩单之一;另一半在 air-1002-replay.test.ts)', () => {
  it('打出全套与每一组的字数', () => {
    const real = realTools()
    const all = Object.keys(real)
    const full = sizeOfAll(real, all)
    const rows = INTENT_TOOLS.map((row) => {
      const names = toolsForIntent(row.id) as readonly string[]
      return { id: row.id, n: names.length, size: sizeOfAll(real, names) }
    }).sort((a, b) => a.size - b.size)
    const lines = [
      '',
      `全套:${all.length} 件、${full} 字(每一个要办事的回合都重发一遍)`,
      ...rows.map(one => `  ${one.id.padEnd(10)} ${String(one.n).padStart(2)} 件 ${String(one.size).padStart(5)} 字`
        + `  ${((one.size / full) * 100).toFixed(0)}%`),
      `每组平均 ${Math.round(rows.reduce((sum, one) => sum + one.size, 0) / rows.length)} 字`,
    ]
    // eslint-disable-next-line no-console
    console.log(lines.join('\n'))

    // ★ 每一组都真的比全套小(有一组不小就是这张卡白做了)
    for (const one of rows) expect(one.size).toBeLessThan(full)
    // ★ 平均省一半以上
    expect(rows.reduce((sum, one) => sum + one.size, 0) / rows.length).toBeLessThan(full / 2)
  })
})
