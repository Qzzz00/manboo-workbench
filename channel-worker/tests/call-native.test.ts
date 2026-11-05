/**
 * Ben 2026-09-23 第五通电话里那四件事(称呼、记住、派单、换音色),外加「转交本体」。
 *
 * 他的原话(工人日志,双方都记了):
 *   「你的回答基本上非常套公式……你非常不智能,你像个机器人。」
 *   「你不能说『喂,Ben,是我』——我肯定知道是你啊……你应该说『老板,我有个事情要跟你确认一下』。」
 *   「第一次叫老板,下一次叫姚总,有点好玩。」
 *   「把音色这个事情改成可以配置的,而且是我在电话通话中能够改的,你能派单吗?」
 *   「你的声音太像豆包了,我要换一个。」
 *   ——外加三次「这个我记着了/记住」,而当时**什么都没落盘**。
 *
 * 开场白那一半在 tests/call-out.test.ts;这一份钉的是剩下的四件 + 分流。
 */
import { describe, expect, it } from 'vitest'
import { DEFAULT_ADDRESSES, addressListOf, localDay, nextAddress } from '../src/address.ts'
import { judgePreference, preferenceLine } from '../src/prefs.ts'
import { butlerAskPrefix, classifyCallTurn, looksLikeRelay } from '../src/butlerRoute.ts'
import {
  TOOL_ASK_BUTLER,
  TOOL_REMEMBER,
  TOOL_PREFERENCE,
  createChannelTools,
} from '../src/tools.ts'
import { createWorkbenchClient, newestAssistantText, writeApiHint, type WorkbenchClient } from '../src/workbench.ts'

interface FakeTool { execute: (args: Record<string, unknown>, ctx: never) => Promise<unknown> }
function toolOf(tools: unknown, name: string): FakeTool {
  return (tools as Record<string, FakeTool>)[name] as FakeTool
}

/** 一个记账的假 fetch(照抄 tests/layout-tool.test.ts 那一份)。 */
function stubFetch(reply: (path: string, method: string) => { status: number, body: unknown }) {
  const calls: { path: string, method: string, body: unknown }[] = []
  const impl = (async (input: string | URL | Request, init?: RequestInit) => {
    const path = new URL(String(input)).pathname
    const method = init?.method ?? 'GET'
    calls.push({ path, method, body: typeof init?.body === 'string' ? JSON.parse(init.body) as unknown : undefined })
    const result = reply(path, method)
    return new Response(JSON.stringify(result.body), {
      status: result.status, headers: { 'content-type': 'application/json' },
    })
  }) as unknown as typeof fetch
  return { impl, calls }
}

// ———————————————————————— ① 称呼轮换 ————————————————————————

describe('称呼:同一天不重复用同一个', () => {
  it('★缺省是「老板」在前 —— 他嫌直呼其名像机器人', () => {
    expect([...DEFAULT_ADDRESSES]).toEqual(['老板', 'Ben'])
    expect(addressListOf(undefined)).toEqual(['老板', 'Ben'])
    expect(addressListOf([])).toEqual(['老板', 'Ben'])
  })

  it('★同一天第二通换一个;表用完了从头来', () => {
    const list = ['老板', '姚总']
    const one = nextAddress(list, undefined, '2026-09-23')
    expect(one.address).toBe('老板')
    const two = nextAddress(list, one.state, '2026-09-23')
    expect(two.address).toBe('姚总')
    // 一天里第三通:两个都叫过了,从头再来(用完了还得叫人)。
    const three = nextAddress(list, two.state, '2026-09-23')
    expect(three.address).toBe('老板')
  })

  it('★隔了一天整张重来,不会连着两天都从第二个开始', () => {
    const list = ['老板', '姚总']
    const one = nextAddress(list, undefined, '2026-09-23')
    const next = nextAddress(list, one.state, '2026-09-24')
    expect(next.address).toBe('老板')
    expect(next.state.day).toBe('2026-09-24')
  })

  it('人设里的表:去重、掐空白、太长的挑掉;挑到一个不剩就退回缺省', () => {
    expect(addressListOf([' 老板 ', '老板', '', '姚总'])).toEqual(['老板', '姚总'])
    expect(addressListOf(['这是一整句写进表里的话,明显不是个称呼'])).toEqual(['老板', 'Ben'])
  })

  it('本机日期按本地日历算', () => {
    expect(localDay(new Date(2026, 8, 3))).toBe('2026-09-03')
  })
})

// ———————————————————————— ② 长期偏好 ————————————————————————

describe('偏好:「以后都这样」才落人设', () => {
  it('★「以后 / 每次 / 别再 / 从今以后」算长期', () => {
    for (const said of ['以后别念标题', '每次都先说结论', '别再叫我 Ben', '从今以后用第一人称', '默认用中文']) {
      expect(judgePreference(said).kind).toBe('long_term')
    }
  })

  it('★「这次 / 这一通 / 这回」只管这一通,**不落盘**', () => {
    const verdict = judgePreference('这次先别说那件事')
    expect(verdict.kind).toBe('one_call')
    expect(verdict.kind === 'one_call' ? verdict.reason : '').toContain('这次')
  })

  it('★两个词都有时按「只管这一通」算 —— 拿不准宁可不写', () => {
    expect(judgePreference('这次以后再说').kind).toBe('one_call')
  })

  it('看不出是哪一种就**问他一句**,不替他决定', () => {
    const verdict = judgePreference('说话慢一点')
    expect(verdict.kind).toBe('unclear')
    expect(verdict.kind === 'unclear' ? verdict.reason : '').toContain('以后')
  })

  it('写进去的是他的原话 + 日期,不转述', () => {
    expect(preferenceLine('  以后别念标题 ', '2026-09-23')).toBe('- 以后别念标题(2026-09-23)')
    expect(preferenceLine('以后别念标题', '2026-09-23')).not.toContain('Ben 说')
  })
})

// ———————————————————————— ③ 转交本体的分流 ————————————————————————

describe('分流:哪一句该交回事务官本尊', () => {

  it('★闲聊、寒暄归工人自己答(为了快)', () => {
    for (const said of ['喂', '你好', '听得见吗', '谢谢', '嗯', '天气不错']) {
      expect(classifyCallTurn(said)).toBe('chat')
    }
  })

  /**
   * 捎话那一条(2026-09-26,卡 BR)。维护者 16:41 那一句里带着「在做」——
   * 按老顺序它会被当成"问事项进度",一路走到「它归哪件事」。他要的是**把话送进那条会话**。
   */
  describe('给某条会话捎话 → relay(2026-09-26,卡 BR)', () => {
    it('★维护者 16:41 那一句:relay,不是 item', () => {
      const said = '给那个 Claude,现在正在做统筹交接的那个会话窗口,发个信息问一下:现在进行到什么情况,大概什么时候能处理完'
      expect(looksLikeRelay(said)).toBe(true)
      expect(classifyCallTurn(said)).toBe('relay')
    })

    it('★捎话那行上下文不许再问「这归哪件事」,而且点名那条路怎么走', () => {
      const prefix = butlerAskPrefix('relay')
      expect(prefix).toContain('/sessions/relay')
      expect(prefix).toContain('捎话不需要事项')
      expect(prefix).toContain('一个字都别改写')
      expect(prefix).toContain('念给他选')
    })
  })
})

describe('只认比问话更新的那一条回答', () => {
  const turns = [
    { role: 'assistant' as const, text: '上一轮的答案', at: '2026-09-23T03:00:00.000Z' },
    { role: 'user' as const, text: '他这一轮的问题', at: '2026-09-23T03:01:00.000Z' },
  ]

  it('★没有新回合时回 undefined —— 绝不把上一轮的答案念给他', () => {
    expect(newestAssistantText(turns, '2026-09-23T03:00:00.000Z')).toBeUndefined()
  })

  it('有了新回合就取它', () => {
    const next = [...turns, { role: 'assistant' as const, text: '这一轮的答案', at: '2026-09-23T03:02:00.000Z' }]
    expect(newestAssistantText(next, '2026-09-23T03:00:00.000Z')).toBe('这一轮的答案')
  })
})

// ———————————————————————— ④ 换音色 ————————————————————————
//
// 09-23 第二版整组挪到了 **tests/voice-pick.test.ts**:换音色从「念三个名字」变成
// 「按描述打分挑 + 逐个播样音」之后,这一组比这里其余四组加起来还长,挤在这个文件里
// 谁都不好找。那边钉的是打分与挑选、样音缓存、序数与模糊指代、「换一批」不重复。

// ———————————————————————— ⑤ 建事项 / 派需求卡 ————————————————————————

describe('建事项与派需求卡', () => {
  function client(reply: (path: string, method: string) => { status: number, body: unknown }) {
    const stub = stubFetch(reply)
    return { stub, workbench: createWorkbenchClient({ baseUrl: 'http://127.0.0.1:8791', fetchImpl: stub.impl }) }
  }

  it('建一张普通卡不带 kind', async () => {
    const { stub, workbench } = client(() => ({ status: 200, body: { ok: true, id: 't-1' } }))
    await toolOf(createChannelTools({ workbench }), TOOL_REMEMBER).execute({ text: '看一下合同' }, {} as never)
    expect(stub.calls[0]?.body).not.toHaveProperty('kind')
  })

  it('那句提示自己也钉一遍:文件、键名、去哪儿找', () => {
    expect(writeApiHint()).toContain('docs/记忆/授权.md')
    expect(writeApiHint()).toContain('write_api')
    expect(writeApiHint()).toContain('~/Documents/工作台')
  })
})

// ———————————————————————— ⑦ 转本体 ————————————————————————

describe('转本体那件工具', () => {
  it('★没有事项 id 时不硬造一条卡,如实说这一版够不着', async () => {
    const stub = stubFetch(() => ({ status: 200, body: {} }))
    const workbench = createWorkbenchClient({ baseUrl: 'http://127.0.0.1:8791', fetchImpl: stub.impl })
    const tool = toolOf(createChannelTools({ workbench }), TOOL_ASK_BUTLER)
    const text = String(await tool.execute({ question: '我以前说过什么' }, {} as never))
    expect(text).toContain('这一版只能顺着某一条事项')
    expect(stub.calls).toEqual([])
  })

  it('★本体没回话:如实说「它还没回」,**不编一个答案**', async () => {
    const stub = stubFetch((path) => (
      path === '/butler/item/say' ? { status: 200, body: { ok: true } } : { status: 200, body: { turns: [] } }
    ))
    const workbench = createWorkbenchClient({ baseUrl: 'http://127.0.0.1:8791', fetchImpl: stub.impl })
    const result = await workbench.askButler({ itemId: 'task-7', question: '在办什么', timeoutMs: 30 })
    expect(result.ok).toBe(false)
    // 2026-10-02(卡「电话里像个活人」):话改成第一人称 ——「我还在查」,不再说「我问了事务官」。
    expect(result.text).toContain('我还在查')
    expect(result.text).toContain('不要自己编一个答案')
    // 那句第三人称**逐字列成禁例**(「也别说『我问了事务官』」),不是教她这么说
    expect(result.text).toContain('也别说「我问了事务官」')
  })

  it('★送不进去(没授权)就到此为止,还要说清去哪儿改', async () => {
    const stub = stubFetch(() => ({
      status: 403,
      body: { error: '事务官还没有这项授权:调工作台写接口(docs/记忆/授权.md 里 write_api 不是「可以」)。' },
    }))
    const workbench = createWorkbenchClient({ baseUrl: 'http://127.0.0.1:8791', fetchImpl: stub.impl })
    const result = await workbench.askButler({ itemId: 'task-7', question: '在办什么', timeoutMs: 30 })
    expect(result.ok).toBe(false)
    expect(result.text).toContain('write_api')
    // 只发了那一条 say,没有去轮询回合(问题压根没送出去)。
    expect(stub.calls.filter(one => one.path.includes('/turns'))).toEqual([])
  })
})
