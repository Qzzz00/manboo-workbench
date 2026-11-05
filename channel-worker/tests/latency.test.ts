/**
 * 一回合的计时(src/latency.ts)。
 *
 * 这一份钉住的是**「没测到就写 null」**这条纪律 —— 卡上那句「不编数」在代码里
 * 唯一能被机器检查的形式就是它。外加一回合里 thinking↔speaking 来回好几次时
 * 只吐一条(和 filler 那条规矩同源,出处见 filler.ts 头注释)。
 */
import { describe, expect, it } from 'vitest'
import {
  LATENCY_KEEP,
  LatencyLog,
  TurnTimeline,
  applyAgentStateToTimeline,
  formatTurnLatency,
  latencyOf,
  spanOf,
} from '../src/latency.ts'
import type { TurnLatency } from '../src/latency.ts'

describe('spanOf', () => {
  it('两头都有才算一段', () => {
    expect(spanOf({ user_end: 100, stt_final: 460 }, 'user_end', 'stt_final')).toBe(360)
  })

  it('有一头缺席就是 null,不是 0', () => {
    expect(spanOf({ user_end: 100 }, 'user_end', 'stt_final')).toBeNull()
    expect(spanOf({}, 'user_end', 'stt_final')).toBeNull()
  })

  it('负数当没测到(时钟倒退比一个错数据好发现)', () => {
    expect(spanOf({ user_end: 500, stt_final: 100 }, 'user_end', 'stt_final')).toBeNull()
  })
})

describe('latencyOf', () => {
  const full = {
    user_end: 1000,
    stt_final: 1300,
    committed: 1600,
    llm_first: 2200,
    tts_request: 2260,
    tts_first_audio: 2640,
    speaking: 2700,
    llm_done: 3100,
    tts_done: 3900,
  }

  it('一条走全了的回合,每一段都算得出来', () => {
    const latency = latencyOf(7, full)
    expect(latency).toEqual({
      round: 7,
      at: 1000,
      asr_ms: 300,
      commit_ms: 300,
      llm_first_ms: 600,
      llm_gen_ms: 900,
      tts_first_ms: 380,
      publish_ms: 60,
      tts_all_ms: 1640,
      mouth_ms: 500,
      total_ms: 1700,
    })
  })

  it('招呼那一类没有 user_end:前面几段如实是 null,后面照算', () => {
    const { user_end: _dropped, stt_final: _also, ...rest } = full
    const latency = latencyOf(1, rest)
    expect(latency.asr_ms).toBeNull()
    expect(latency.commit_ms).toBeNull()
    expect(latency.total_ms).toBeNull()
    expect(latency.mouth_ms).toBe(500)
    expect(latency.at).toBe(1600)
  })

  it('★ 垫过的回合带 filler:true(那一回合的 speaking 是垫场出声);没垫就缺席', () => {
    expect(latencyOf(1, {}, { filler: true })).toMatchObject({ filler: true })
    expect(latencyOf(1, {})).not.toHaveProperty('filler')
    const rows: TurnLatency[] = []
    const timeline = new TurnTimeline({ onTurn: row => rows.push(row), now: () => 1000 })
    timeline.mark('committed')
    timeline.note({ filler: true })
    timeline.mark('speaking')
    timeline.end()
    expect(rows[0]).toMatchObject({ filler: true })
  })

  it('一个点都没有也不抛,全 null', () => {
    const latency = latencyOf(0, {})
    expect(latency.at).toBe(0)
    const segments = Object.entries(latency).filter(([key]) => key.endsWith('_ms'))
    expect(segments.every(([, value]) => value === null)).toBe(true)
  })
})

describe('formatTurnLatency', () => {
  it('前面是人话、后面是能直接喂 jq 的一坨 JSON', () => {
    const line = formatTurnLatency(latencyOf(3, { user_end: 0, speaking: 1200 }))
    expect(line.startsWith('回合计时 #3 {')).toBe(true)
    const parsed = JSON.parse(line.slice(line.indexOf('{'))) as TurnLatency
    expect(parsed.total_ms).toBe(1200)
    expect(parsed.asr_ms).toBeNull()
  })
})

describe('TurnTimeline', () => {
  function collect() {
    const rows: TurnLatency[] = []
    let clock = 0
    const timeline = new TurnTimeline({ onTurn: row => rows.push(row), now: () => clock })
    return { rows, timeline, tick: (ms: number) => { clock += ms }, at: () => clock }
  }

  it('一条正常的回合:停说 → 出声,吐一条', () => {
    const { rows, timeline, tick } = collect()
    timeline.mark('user_end')
    tick(300); timeline.mark('stt_final')
    tick(300); applyAgentStateToTimeline(timeline, 'thinking')
    tick(600); timeline.mark('llm_first')
    tick(60); timeline.mark('tts_request')
    tick(380); timeline.mark('tts_first_audio'); timeline.mark('tts_done')
    tick(60); applyAgentStateToTimeline(timeline, 'speaking')
    tick(2000); applyAgentStateToTimeline(timeline, 'listening')
    expect(rows).toHaveLength(1)
    expect(rows[0]?.round).toBe(1)
    expect(rows[0]?.total_ms).toBe(1700)
    expect(rows[0]?.tts_first_ms).toBe(380)
  })

  it('一个回合里工具来回切 thinking↔speaking,**只吐一条**', () => {
    const { rows, timeline, tick } = collect()
    timeline.mark('user_end')
    tick(100); applyAgentStateToTimeline(timeline, 'thinking')
    tick(100); applyAgentStateToTimeline(timeline, 'speaking')
    tick(100); applyAgentStateToTimeline(timeline, 'thinking')
    tick(100); applyAgentStateToTimeline(timeline, 'speaking')
    tick(100); applyAgentStateToTimeline(timeline, 'listening')
    expect(rows).toHaveLength(1)
    expect(rows[0]?.round).toBe(1)
  })

  it('先到先得:同一个点第二次不覆盖(`speaking` 要的是第一次开口)', () => {
    const { rows, timeline, tick } = collect()
    timeline.mark('user_end')
    tick(500); timeline.mark('speaking')
    tick(500); timeline.mark('speaking')
    timeline.end()
    expect(rows[0]?.total_ms).toBe(500)
  })

  it('`tts_done` 例外:后到的盖掉先到的(要最后一小块合完那一下)', () => {
    const { rows, timeline, tick } = collect()
    timeline.mark('tts_request')
    tick(400); timeline.mark('tts_done')
    tick(900); timeline.mark('tts_done')
    timeline.end()
    expect(rows[0]?.tts_all_ms).toBe(1300)
  })

  it('他说了一句她没接话:下一句的 user_end 盖掉上一句的,发呆的时间不算进延迟', () => {
    const { rows, timeline, tick } = collect()
    timeline.mark('user_end')
    tick(5000)
    timeline.mark('user_end')
    tick(800); timeline.mark('speaking')
    timeline.end()
    expect(rows[0]?.total_ms).toBe(800)
  })

  it('一个点都没打过的「回合」什么都不吐(房里没人时框架也会晃状态)', () => {
    const { rows, timeline } = collect()
    applyAgentStateToTimeline(timeline, 'listening')
    applyAgentStateToTimeline(timeline, 'idle')
    expect(rows).toHaveLength(0)
    expect(timeline.round).toBe(0)
  })

  it('收尾之后再来一轮,轮号自己加一', () => {
    const { rows, timeline, tick } = collect()
    timeline.mark('user_end'); tick(100); timeline.mark('speaking'); timeline.end()
    tick(100)
    timeline.mark('user_end'); tick(200); timeline.mark('speaking'); timeline.end()
    expect(rows.map(row => row.round)).toEqual([1, 2])
    expect(rows.map(row => row.total_ms)).toEqual([100, 200])
  })

  it('onTurn 自己抛也不把电话带走', () => {
    const timeline = new TurnTimeline({ onTurn: () => { throw new Error('炸了') } })
    timeline.mark('user_end')
    expect(() => timeline.end()).not.toThrow()
  })
})

describe('LatencyLog', () => {
  it('只留最近 20 条,最近的在前', () => {
    const log = new LatencyLog()
    for (let i = 1; i <= 25; i += 1) log.add(latencyOf(i, { user_end: 0, speaking: i }))
    const rows = log.recent()
    expect(rows).toHaveLength(LATENCY_KEEP)
    expect(rows[0]?.round).toBe(25)
    expect(rows[LATENCY_KEEP - 1]?.round).toBe(6)
  })

  it('回的是拷贝,读的人改不动这份记录', () => {
    const log = new LatencyLog()
    log.add(latencyOf(1, { user_end: 0, speaking: 100 }))
    const rows = log.recent() as TurnLatency[]
    rows.pop()
    expect(log.recent()).toHaveLength(1)
  })
})

describe('成绩单上的分流(2026-09-23)', () => {
  it('记下这一回合走的哪条路、谁判的', () => {
    const rows: TurnLatency[] = []
    const timeline = new TurnTimeline({ onTurn: row => rows.push(row) })
    timeline.mark('user_end', 0)
    timeline.note({ route: 'chat', router: 'rules' })
    timeline.mark('speaking', 900)
    timeline.end()
    expect(rows[0]).toMatchObject({ route: 'chat', router: 'rules', total_ms: 900 })
  })

  it('没判过就没有这两格(**缺席 = 没判过**,不补一个 act 上去)', () => {
    const rows: TurnLatency[] = []
    const timeline = new TurnTimeline({ onTurn: row => rows.push(row) })
    timeline.mark('user_end', 0)
    timeline.mark('speaking', 100)
    timeline.end()
    expect(rows[0]).not.toHaveProperty('route')
    expect(rows[0]).not.toHaveProperty('router')
  })

  it('一个回合里判了两次:算头一次(这一回合是按什么走的)', () => {
    const rows: TurnLatency[] = []
    const timeline = new TurnTimeline({ onTurn: row => rows.push(row) })
    timeline.mark('user_end', 0)
    timeline.note({ route: 'act', router: 'rules' })
    timeline.note({ route: 'chat', router: 'jev' })
    timeline.end()
    expect(rows[0]).toMatchObject({ route: 'act', router: 'rules' })
  })

  it('下一回合不沿用上一回合那两格', () => {
    const rows: TurnLatency[] = []
    const timeline = new TurnTimeline({ onTurn: row => rows.push(row) })
    timeline.mark('user_end', 0)
    timeline.note({ route: 'chat', router: 'rules' })
    timeline.end()
    timeline.mark('user_end', 1000)
    timeline.mark('speaking', 1100)
    timeline.end()
    expect(rows[1]).not.toHaveProperty('route')
  })

  it('这一行日志里带得上分流(统筹 grep 出来直接 jq)', () => {
    const line = formatTurnLatency(latencyOf(7, { user_end: 0, speaking: 800 }, { route: 'chat', router: 'rules' }))
    expect(line).toContain('"route":"chat"')
    expect(line).toContain('"router":"rules"')
  })
})
