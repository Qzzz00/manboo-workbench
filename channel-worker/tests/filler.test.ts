/**
 * 缓冲语 —— **工人这一侧只发信号**(2026-09-20 第二版,Ben:「缓冲语可以存到手机里啊」)。
 *
 * 第一版在这里钉的是「到点才垫 / 她一出声就作废 / 不重复」—— 那三条**整个搬到手机上去了**
 * (butler-app/tests/fillerAudio.test.ts),因为等多久、说哪句、什么时候掐都归放音频的那一头管。
 *
 * 留在工人这边要钉的只有四件:
 *   ① 回合提交发一条,**一轮只发一条**;
 *   ② 轮号会往前走,手机据此分得清批次;
 *   ③ 只有白名单里那几件慢工具才发 `tool`,`record_answer` 一声不吭;
 *   ④ 发不出去不许把会话带走。
 */
import { describe, expect, it } from 'vitest'
import type { FillerSignal, FillerVoiceSignal } from '../src/filler.ts'
import { FillerSignaller, SLOW_TOOLS, VoiceWatcher, applyAgentState, encodeFillerSignal, encodeFillerVoiceSignal } from '../src/filler.ts'

function collector() {
  const sent: FillerSignal[] = []
  let clock = 1000
  const signaller = new FillerSignaller({ send: signal => sent.push(signal), now: () => (clock += 1) })
  return { sent, signaller }
}

describe('FillerSignaller:回合', () => {
  it('回合提交发一条 thinking', () => {
    const { sent, signaller } = collector()
    signaller.thinking()
    expect(sent).toHaveLength(1)
    expect(sent[0]).toMatchObject({ type: 'filler', kind: 'thinking', round: 1 })
    expect(sent[0]?.at).toBeGreaterThan(0)
  })

  it('一轮只发一条(她想得久不该变成一串信号 —— 手机每收一条就会重新计时)', () => {
    const { sent, signaller } = collector()
    signaller.thinking()
    signaller.thinking()
    signaller.thinking()
    expect(sent).toHaveLength(1)
  })

  it('下一轮换一个轮号(手机据此分得清「同一轮的第二条」和「新的一轮」)', () => {
    const { sent, signaller } = collector()
    signaller.thinking()
    signaller.endRound()
    signaller.thinking()
    expect(sent.map(s => s.round)).toEqual([1, 2])
  })

  it('还没开过轮的时候 round 是 0', () => {
    expect(collector().signaller.round).toBe(0)
  })
})

/**
 * ——— 状态 → 轮号(2026-09-22,Ben 真机:「在生成回复之前,它一次念了好几句」)———
 *
 * 这一节是这次那个 bug 的落点。原先 agent.ts 里写的是「不是 thinking 就 endRound」,
 * 而 `@livekit/agents` 在**一个回合的工具步之间**就会 `speaking ↔ thinking` 来回切
 * (`agent_activity.js`:工具还忙着 / 工具有输出 → `updateAgentState(lease,'thinking')`),
 * 于是一个回合被切成好几轮,手机那边每个新轮号都当成「他又说了一句话」,一句接一句地垫。
 */
describe('agent_state_changed → 轮号', () => {
  it('★**一个回合里的工具步不换轮号**(speaking ↔ thinking 来回切也只发一条)', () => {
    const { sent, signaller } = collector()
    // 他说完 → 她想 → 说半句 → 去调工具(又回 thinking)→ 再说半句 → 再调一次 → 说完
    for (const state of ['thinking', 'speaking', 'thinking', 'speaking', 'thinking', 'speaking']) {
      applyAgentState(signaller, state)
    }
    expect(sent).toHaveLength(1)
    expect(sent.map(s => s.round)).toEqual([1])
  })

  it('回到 listening 才算这一轮完了,下一次 thinking 是新的一轮', () => {
    const { sent, signaller } = collector()
    applyAgentState(signaller, 'thinking')
    applyAgentState(signaller, 'speaking')
    applyAgentState(signaller, 'listening')
    applyAgentState(signaller, 'thinking')
    expect(sent.map(s => s.round)).toEqual([1, 2])
  })

  it('idle / initializing 一样算结束(认不出来的状态按"结束"处理,宁可多开一轮也不要漏垫)', () => {
    for (const ending of ['idle', 'initializing', '谁知道是什么']) {
      const { sent, signaller } = collector()
      applyAgentState(signaller, 'thinking')
      applyAgentState(signaller, ending)
      applyAgentState(signaller, 'thinking')
      expect(sent.map(s => s.round)).toEqual([1, 2])
    }
  })

  it('同一个回合里那件慢工具照旧发得出来,和 thinking 共用同一个轮号', () => {
    const { sent, signaller } = collector()
    applyAgentState(signaller, 'thinking')
    applyAgentState(signaller, 'speaking')
    signaller.toolStarted('scan_projects')
    expect(sent.map(s => [s.kind, s.round])).toEqual([['thinking', 1], ['tool', 1]])
  })
})

describe('FillerSignaller:工具', () => {
  it('慢工具开跑 → 带着工具名发一条,和同一轮的 thinking 共用轮号', () => {
    const { sent, signaller } = collector()
    signaller.thinking()
    expect(signaller.toolStarted('scan_projects')).toBe(true)
    expect(sent).toHaveLength(2)
    expect(sent[1]).toMatchObject({ kind: 'tool', tool: 'scan_projects', round: 1 })
  })

  it('同一件工具一轮只发一次(模型连调两次不该垫两句)', () => {
    const { sent, signaller } = collector()
    signaller.thinking()
    signaller.toolStarted('scan_projects')
    expect(signaller.toolStarted('scan_projects')).toBe(false)
    expect(sent.filter(s => s.kind === 'tool')).toHaveLength(1)
  })

  it('下一轮同一件工具可以再发一次', () => {
    const { sent, signaller } = collector()
    signaller.thinking(); signaller.toolStarted('scan_projects')
    signaller.endRound()
    signaller.thinking(); expect(signaller.toolStarted('scan_projects')).toBe(true)
    expect(sent.filter(s => s.kind === 'tool').map(s => s.round)).toEqual([1, 2])
  })

  it('**白名单之外的工具一声不吭** —— record_answer 最多等 400ms,垫它只会插在她要开口前面', () => {
    const { sent, signaller } = collector()
    signaller.thinking()
    expect(signaller.toolStarted('record_answer')).toBe(false)
    expect(signaller.toolStarted('wb_list_doing')).toBe(false)
    expect(signaller.toolStarted('')).toBe(false)
    expect(sent.filter(s => s.kind === 'tool')).toHaveLength(0)
  })

  /**
   * 2026-09-23 多了一件:`wb_ask_butler`(把问题转给事务官本尊,要等 DSH 一个来回,
   * 上限 12 秒)。它正是这张白名单存在的理由的标准样本 —— 慢是明着换来的,那几秒必须有人垫着。
   */
  /**
   * 2026-09-24 又多一件:`read_project`(已有项目拉齐,读一个项目的说明与最近记录,整份上限 5 秒)。
   */
  it('白名单是一张明单:今天就这六件(引导落地的排单子 / 落单子 2026-09-24 晚加进来;捎话 2026-09-26 卡 BR)', () => {
    expect([...SLOW_TOOLS]).toEqual(['scan_projects', 'read_project', 'wb_ask_butler', 'wb_relay_to_session', 'setup_preview', 'setup_apply'])
  })

  it('没有 thinking 就来了工具(框架换了实现)也给得出一个轮号,不让手机分不清批次', () => {
    const { sent, signaller } = collector()
    expect(signaller.toolStarted('scan_projects')).toBe(true)
    expect(sent[0]).toMatchObject({ kind: 'tool', round: 1 })
  })
})

/**
 * ——— 慢工具跑完(2026-09-24 傍晚,卡 fix/scan-orb-working-whole-wait)———
 *
 * 手机引导通话页要知道「她下一次开口就是在说结果」:找项目那一整段球是执行中,到那一刻才回去。
 * 接的是框架的 `function_tools_executed`(她跑之前说的那几句也放完了),见 filler.ts 的 toolsDone。
 */
describe('FillerSignaller:慢工具跑完', () => {
  it('白名单里的慢工具跑完发一条 tool_done,带工具名、和开跑那条同一个轮号', () => {
    const { sent, signaller } = collector()
    signaller.toolStarted('scan_projects')
    expect(signaller.toolsDone(['scan_projects'])).toBe(true)
    expect(sent.map(s => [s.kind, s.tool, s.round])).toEqual([['tool', 'scan_projects', 1], ['tool_done', 'scan_projects', 1]])
  })

  it('不按轮去重:同一轮里第二次调(开跑那条被去重掉了),跑完这条照样要有', () => {
    const { sent, signaller } = collector()
    signaller.toolStarted('scan_projects')
    signaller.toolsDone(['scan_projects'])
    expect(signaller.toolStarted('scan_projects')).toBe(false)
    expect(signaller.toolsDone(['scan_projects'])).toBe(true)
    expect(sent.filter(s => s.kind === 'tool_done')).toHaveLength(2)
  })

  it('白名单之外的一声不吭;一步里调了好几件,只为慢的那几件发', () => {
    const { sent, signaller } = collector()
    signaller.thinking()
    expect(signaller.toolsDone(['record_answer', ''])).toBe(false)
    expect(signaller.toolsDone(['record_answer', 'read_project'])).toBe(true)
    expect(sent.filter(s => s.kind === 'tool_done').map(s => s.tool)).toEqual(['read_project'])
  })

  it('还没开过轮就不发(没有轮号可带,手机分不清批次)', () => {
    const { sent, signaller } = collector()
    expect(signaller.toolsDone(['scan_projects'])).toBe(false)
    expect(sent).toHaveLength(0)
  })

  it('工人自己垫场时照样带 voiced_by;发不出去不许把会话带走', () => {
    const sent: FillerSignal[] = []
    const voiced = new FillerSignaller({ send: signal => sent.push(signal), workerVoiced: true })
    voiced.toolStarted('scan_projects')
    voiced.toolsDone(['scan_projects'])
    expect(sent[1]).toMatchObject({ kind: 'tool_done', voiced_by: 'worker' })
    const broken = new FillerSignaller({ send: () => { throw new Error('房间断了') } })
    broken.toolStarted('scan_projects')
    expect(() => broken.toolsDone(['scan_projects'])).not.toThrow()
  })
})

describe('FillerSignaller:发不出去', () => {
  it('房间断了也不许把会话带走(垫一句是好意,不是主线)', () => {
    const signaller = new FillerSignaller({ send: () => { throw new Error('房间断了') } })
    expect(() => signaller.thinking()).not.toThrow()
    expect(() => signaller.toolStarted('scan_projects')).not.toThrow()
  })
})

describe('线上那条消息', () => {
  it('是一行 JSON,而且**不带话** —— 说哪一句由放音频的那一头挑', () => {
    const line = encodeFillerSignal({ type: 'filler', kind: 'tool', tool: 'scan_projects', round: 3, at: 42 })
    expect(JSON.parse(line)).toEqual({ type: 'filler', kind: 'tool', tool: 'scan_projects', round: 3, at: 42 })
    expect(line).not.toContain('我想想')
  })

  it('小(它一轮发一两条,而房间里还跑着音频)', () => {
    const line = encodeFillerSignal({ type: 'filler', kind: 'thinking', round: 1, at: Date.now() })
    expect(Buffer.byteLength(line, 'utf8')).toBeLessThan(120)
  })
})

/**
 * 音色换了那一条广播(2026-09-22)。
 *
 * 手机上那七句缓冲语按音色缓存,所以「换了音色」必须有人说一声 ——
 * 否则电话里一半新嗓子一半旧嗓子(交接-0920 第六节第 1 条那个洞)。
 */
describe('VoiceWatcher:音色换了才说一声', () => {
  function watcher(values: readonly (string | undefined)[], options: { throwAt?: number } = {}) {
    const sent: FillerVoiceSignal[] = []
    let at = 0
    const one = new VoiceWatcher({
      read: async () => {
        const index = at
        at += 1
        if (options.throwAt === index) throw new Error('8791 连不上')
        return values[index]
      },
      send: signal => { sent.push(signal) },
      now: () => 1000,
    })
    return { one, sent }
  }

  it('★第一次问到的那个值不算「变了」—— 工人重启不该让手机重合成七句', async () => {
    const { one, sent } = watcher(['V1', 'V1'])
    expect(await one.tick()).toBe(false)
    expect(one.known).toBe('V1')
    expect(await one.tick()).toBe(false)
    expect(sent).toEqual([])
  })

  it('★真换了才发一条,而且只发一条(下一拍同一个值不再发)', async () => {
    const { one, sent } = watcher(['V1', 'V2', 'V2'])
    await one.tick()
    expect(await one.tick()).toBe(true)
    expect(sent).toEqual([{ type: 'filler_voice_changed', voice: 'V2', at: 1000 }])
    expect(await one.tick()).toBe(false)
    expect(sent.length).toBe(1)
  })

  it('★问不到(8792 没跑)就当没发生:不广播一个空音色', async () => {
    const { one, sent } = watcher(['V1', undefined, '  '])
    await one.tick()
    expect(await one.tick()).toBe(false)
    expect(await one.tick()).toBe(false)
    expect(sent).toEqual([])
    // 记着的还是上一次问到的那个,没被 undefined 冲掉。
    expect(one.known).toBe('V1')
  })

  it('★问这一下抛了也不许把工人带走', async () => {
    const { one, sent } = watcher(['V1', 'V2'], { throwAt: 1 })
    await one.tick()
    expect(await one.tick()).toBe(false)
    expect(sent).toEqual([])
  })

  it('那条消息编码之后是一行 JSON(和字幕、缓冲语同一条 topic)', () => {
    expect(JSON.parse(encodeFillerVoiceSignal({ type: 'filler_voice_changed', voice: 'V2', at: 7 })))
      .toEqual({ type: 'filler_voice_changed', voice: 'V2', at: 7 })
  })
})
