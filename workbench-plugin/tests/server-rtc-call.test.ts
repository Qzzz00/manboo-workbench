// @vitest-environment node
/**
 * 通话模式在工作台这一侧的那几块纯逻辑(2026-09-17,交接-0917-手机通话模式):
 *
 * 1. **人设从哪来**:~/.dsh/AGENTS.md 的首行「我叫 X。」与「说话方式」标记段——那是引导真的写过的
 *    地方(server/onboarding.ts + memoryMd.ts),不是 docs 里那份草稿。读不到就退成通用称呼,**不编人设**。
 * 2. **上下文**:当前在办 / 等我确认的事项摘要塞进人设。一件都没有就如实说「没有」,不留空段。
 * 3. **工具**:没配 WORKBENCH_RTC_CALLBACK_URL(本机没有公网地址)就不给工具、不下发回调——
 *    人设里也不能吹她能记事项,否则她会在电话里答应一件根本没落下的事。
 * 4. **回调**:签名是进程级随机的,比对不上一律不认;tool_calls 的 Message 解析不出来就当没有。
 * 5. **通话纪要**:时长 + 字幕 → 一条事项的标题与正文。时长没记下就不写时长(不编数)。
 */
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { TasksState, TaskView } from '../src/protocol.ts'
import {
  CALL_TOOL_DOING,
  CALL_TOOL_REMEMBER,
  buildCallSystemMessage,
  buildCallTools,
  buildCallWelcome,
  butlerNameOf,
  callContextBlock,
  createRtcCallService,
  formatCallDuration,
  parseToolCalls,
  rtcCallbackUrlOf,
  speakingStyleOf,
} from '../src/server/rtcCall.ts'

const AGENTS = `我叫 周到。

# 事务官

<!-- 引导:说话方式:开始 -->
- 先说结论,再说理由。
- 不确定就说不确定。
<!-- 引导:说话方式:结束 -->

其它段落一个字都不该被读进通话人设。
`

function task(input: Partial<TaskView> & { id: string, title: string }): TaskView {
  return {
    status: 'doing',
    source: 'manual',
    created_at: '2026-09-17T00:00:00.000Z',
    updated_at: '2026-09-17T00:00:00.000Z',
    ...input,
  } as TaskView
}

function board(tasks: readonly TaskView[]): TasksState {
  return { tasks, sprints: [], modules: [], project_meta: [] }
}

describe('人设从 ~/.dsh/AGENTS.md 来', () => {
  it('读出名字与「说话方式」段;段外的字一个都不带', () => {
    expect(butlerNameOf(AGENTS)).toBe('周到')
    const style = speakingStyleOf(AGENTS)
    expect(style).toContain('先说结论')
    expect(style).not.toContain('其它段落')
  })

  it('文件没有 / 没写过 → 名字与说话方式都缺席,不编', () => {
    expect(butlerNameOf(undefined)).toBeUndefined()
    expect(butlerNameOf('# 一份还没被引导写过的 AGENTS.md\n')).toBeUndefined()
    expect(speakingStyleOf('# 空的\n')).toBeUndefined()
  })
})

describe('待办 / 在办 / 等我确认 塞进人设', () => {
  it('三列都列出来,标题带上;待排的不进电话', () => {
    const block = callContextBlock(board([
      task({ id: 't-1', title: '手机通话模式', status: 'doing' }),
      task({ id: 't-2', title: '事项收件箱', status: 'confirm' }),
      task({ id: 't-3', title: '还没排的事', status: 'backlog' }),
    ]))
    expect(block).toContain('手机通话模式')
    expect(block).toContain('事项收件箱')
    // 待排的不进通话上下文:电话里只说手上的事。
    expect(block).not.toContain('还没排的事')
  })

  it('一件都没有 → 如实说没有,不留空段', () => {
    const block = callContextBlock(board([]))
    expect(block).toContain('没有')
    expect(block.trim()).not.toBe('')
  })

  it('看板整个拿不到 → 不假装是「没有」,说的是拿不到', () => {
    const block = callContextBlock(undefined)
    expect(block).toContain('拿不到')
  })
})

describe('通话 systemMessage', () => {
  it('带上名字、说话方式、上下文,并交代这是电话', () => {
    const msg = buildCallSystemMessage({
      agentsText: AGENTS,
      tasks: board([task({ id: 't-1', title: '手机通话模式', status: 'doing' })]),
      toolsEnabled: false,
    })
    expect(msg).toContain('周到')
    expect(msg).toContain('先说结论')
    expect(msg).toContain('手机通话模式')
    expect(msg).toContain('电话')
  })

  it('没有工具时绝不许诺「我记下来了」——那条能力这会儿不存在', () => {
    const without = buildCallSystemMessage({ agentsText: AGENTS, toolsEnabled: false })
    expect(without).not.toContain(CALL_TOOL_REMEMBER)
    expect(without).toContain('记不了')
    const withTools = buildCallSystemMessage({ agentsText: AGENTS, toolsEnabled: true })
    expect(withTools).toContain(CALL_TOOL_REMEMBER)
    expect(withTools).toContain(CALL_TOOL_DOING)
    expect(withTools).not.toContain('记不了')
  })

  it('AGENTS.md 读不到也能通话:退成通用称呼,人设不编', () => {
    const msg = buildCallSystemMessage({ toolsEnabled: false })
    expect(msg).toContain('事务官')
    expect(msg).not.toContain('undefined')
  })

  it('开场白短,一句话', () => {
    expect(buildCallWelcome('周到')).toContain('周到')
    expect(buildCallWelcome(undefined)).not.toContain('undefined')
    expect(buildCallWelcome('周到').length).toBeLessThan(40)
  })
})

describe('工具清单', () => {
  it('只有两件:记一件事项、查现在在办什么', () => {
    const tools = buildCallTools()
    expect(tools.map(t => t.function.name)).toEqual([CALL_TOOL_REMEMBER, CALL_TOOL_DOING])
    const remember = tools[0]!
    expect(remember.function.parameters.required).toEqual(['text'])
  })
})

describe('火山回调', () => {
  it('Message 是一串 tool_calls JSON → 解析成 { id, name, args }', () => {
    const calls = parseToolCalls(JSON.stringify([
      { id: 'call_1', function: { name: CALL_TOOL_REMEMBER, arguments: JSON.stringify({ text: '周五交报销' }) } },
      { id: 'call_2', function: { name: CALL_TOOL_DOING, arguments: '{}' } },
    ]))
    expect(calls).toEqual([
      { id: 'call_1', name: CALL_TOOL_REMEMBER, args: { text: '周五交报销' } },
      { id: 'call_2', name: CALL_TOOL_DOING, args: {} },
    ])
  })

  it('解析不出 / 不是数组 / arguments 是垃圾 → 不抛,当作没有或空参数', () => {
    expect(parseToolCalls('不是 JSON')).toEqual([])
    expect(parseToolCalls(JSON.stringify({ a: 1 }))).toEqual([])
    expect(parseToolCalls(undefined)).toEqual([])
    expect(parseToolCalls(JSON.stringify([{ id: 'c', function: { name: 'x', arguments: '{坏的' } }]))).toEqual([
      { id: 'c', name: 'x', args: {} },
    ])
  })

  it('回调地址没配 → undefined(没有公网地址就不下发回调)', () => {
    expect(rtcCallbackUrlOf({})).toBeUndefined()
    expect(rtcCallbackUrlOf({ WORKBENCH_RTC_CALLBACK_URL: '   ' })).toBeUndefined()
    expect(rtcCallbackUrlOf({ WORKBENCH_RTC_CALLBACK_URL: 'https://x.example/' })).toBe('https://x.example/butler/rtc/callback')
    expect(rtcCallbackUrlOf({ WORKBENCH_RTC_CALLBACK_URL: 'https://x.example/butler/rtc/callback' })).toBe('https://x.example/butler/rtc/callback')
  })
})

describe('时长', () => {
  it('时长的说法', () => {
    expect(formatCallDuration(0)).toBe('0 秒')
    expect(formatCallDuration(45)).toBe('45 秒')
    expect(formatCallDuration(60)).toBe('1 分')
    expect(formatCallDuration(185)).toBe('3 分 5 秒')
    expect(formatCallDuration(undefined)).toBeUndefined()
  })
})

describe('createRtcCallService', () => {
  function dir(): string { return mkdtempSync(join(tmpdir(), 'wb-rtc-call-')) }

  it('没配回调 → 不给 tools、不给 functionCalling,人设里也不许诺', async () => {
    const d = dir()
    const agentsFile = join(d, 'AGENTS.md')
    writeFileSync(agentsFile, AGENTS, 'utf8')
    const svc = createRtcCallService({ agentsFile, tasks: { list: async () => board([]) } })
    const injection = await svc.injection()
    expect(injection.tools).toBeUndefined()
    expect(injection.functionCalling).toBeUndefined()
    expect(injection.systemMessage).toContain('周到')
    expect(injection.systemMessage).toContain('记不了')
    expect(injection.welcomeMessage).toContain('周到')
  })

  it('配了回调 → tools + functionCalling 一起给,签名是进程级随机的', async () => {
    const d = dir()
    const agentsFile = join(d, 'AGENTS.md')
    writeFileSync(agentsFile, AGENTS, 'utf8')
    const svc = createRtcCallService({
      agentsFile,
      tasks: { list: async () => board([]) },
      callbackUrl: 'https://x.example/butler/rtc/callback',
    })
    const injection = await svc.injection()
    expect(injection.tools).toHaveLength(2)
    expect(injection.functionCalling).toEqual({
      serverMessageUrl: 'https://x.example/butler/rtc/callback',
      serverMessageSignature: svc.signature(),
    })
    expect(svc.signature().length).toBeGreaterThanOrEqual(32)
    expect(svc.verify(svc.signature())).toBe(true)
    expect(svc.verify('别人猜的')).toBe(false)
    expect(svc.verify(undefined)).toBe(false)
  })

  it('AGENTS.md 不存在 → 照样能通话,只是没有名字', async () => {
    const svc = createRtcCallService({ agentsFile: join(dir(), '没有这个文件.md') })
    const injection = await svc.injection()
    expect(injection.systemMessage).toContain('事务官')
    expect(injection.systemMessage).not.toContain('undefined')
  })

  it('看板抛错 → 通话照常,上下文说「拿不到」', async () => {
    const svc = createRtcCallService({
      agentsFile: join(dir(), '没有.md'),
      tasks: { list: async () => { throw new Error('看板炸了') } },
    })
    const injection = await svc.injection()
    expect(injection.systemMessage).toContain('拿不到')
  })
})
