/**
 * 缓冲语第三版:工人用当前音色自己说(2026-09-23 晚,维护者拍板)。
 * 帧用数字代替(`withFillerFrames` 是泛型),不起房间、不起框架。
 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  FILLER_LINES,
  FILLER_WAIT_MS,
  THINKING_LINE_TEXTS,
  WorkerFiller,
  carriesText,
  dropEmptyText,
  pickFillerClip,
  withFillerFrames,
  withFillerKick,
} from '../src/workerFiller.ts'
import { FillerSignaller, THINKING_LINE_IDS, applyAgentState } from '../src/filler.ts'

/** 手动拨的定时器:`fire()` 让到点那一下发生。 */
function manualTimer() {
  const pending: { fn: () => void, ms: number, cancelled: boolean }[] = []
  return {
    setTimer: (fn: () => void, ms: number) => {
      const one = { fn, ms, cancelled: false }
      pending.push(one)
      return () => { one.cancelled = true }
    },
    fire: () => { for (const one of pending.splice(0)) if (!one.cancelled) one.fn() },
    pending,
  }
}

const CLIP = { text: '我想想。', frames: [-1, -2, -3, -4] }

async function readAll<T>(stream: ReadableStream<T>): Promise<T[]> {
  const out: T[] = []
  const reader = stream.getReader()
  for (;;) {
    const next = await reader.read()
    if (next.done) return out
    out.push(next.value)
  }
}

function pushable<T>() {
  let ctl!: ReadableStreamDefaultController<T>
  const stream = new ReadableStream<T>({ start(c) { ctl = c } })
  return { stream, push: (v: T) => ctl.enqueue(v), close: () => ctl.close() }
}

const tick = () => new Promise(resolve => setTimeout(resolve, 0))

describe('那几句话与手机那一份逐字相同', () => {
  it('★ id 与原文和 butler-app/src/call/fillerLines.json 的 thinking 那五句一致;与信号里点名的 id 一致', () => {
    const json = JSON.parse(readFileSync(resolve(__dirname, '../../butler-app/src/call/fillerLines.json'), 'utf8')) as { lines: { id: string, kind: string, text: string }[] }
    const thinking = Object.fromEntries(json.lines.filter(one => one.kind === 'thinking').map(one => [one.id, one.text]))
    expect(THINKING_LINE_TEXTS).toEqual(thinking)
    expect(Object.keys(THINKING_LINE_TEXTS)).toEqual([...THINKING_LINE_IDS])
    expect(FILLER_LINES).toHaveLength(5)
    expect(FILLER_WAIT_MS).toBe(700)
  })

  it('★ 挑缓存里有的:点名那句优先;没有就别的一句;一句都没有 → 不垫', () => {
    const has = new Set(['稍等一下。', '让我看看。'])
    const lookup = (text: string) => (has.has(text) ? [1] : undefined)
    expect(pickFillerClip('think-3', lookup)?.text).toBe('让我看看。')
    expect(pickFillerClip('think-1', lookup)?.text).toBe('稍等一下。')
    expect(pickFillerClip(undefined, lookup)?.text).toBe('稍等一下。')
    expect(pickFillerClip('think-1', () => undefined)).toBeUndefined()
  })
})

describe('一轮一次的那个开关', () => {
  it('★ 700ms 到点、还没出声 → 该垫了;只有一个人领得到', () => {
    const timer = manualTimer()
    const filler = new WorkerFiller({ clip: () => CLIP, setTimer: timer.setTimer })
    let told = 0
    filler.onWanted(() => { told += 1 })
    filler.arm('think-1')
    expect(timer.pending[0]?.ms).toBe(700)
    expect(filler.wanted).toBe(false)
    timer.fire()
    expect(filler.wanted).toBe(true)
    expect(told).toBe(1)
    expect(filler.take()).toEqual(CLIP)
    expect(filler.take()).toBeUndefined()
  })

  it('★ 真声先到 → 计时器取消,这一轮不垫', () => {
    const timer = manualTimer()
    const filler = new WorkerFiller({ clip: () => CLIP, setTimer: timer.setTimer })
    filler.arm()
    filler.realVoice()
    timer.fire()
    expect(filler.wanted).toBe(false)
    expect(filler.take()).toBeUndefined()
  })

  it('★ 一轮最多垫一次:同一轮再 arm 不认;这一轮已经出过真声也不认;下一轮重新来', () => {
    const timer = manualTimer()
    const filler = new WorkerFiller({ clip: () => CLIP, setTimer: timer.setTimer })
    filler.arm(); timer.fire(); filler.take()
    filler.arm()
    expect(timer.pending).toHaveLength(0)
    filler.endRound()
    filler.realVoice() // 上一段的尾巴也好、这一轮已经开口也好
    filler.arm()
    expect(timer.pending).toHaveLength(0)
    filler.endRound()
    filler.arm()
    expect(timer.pending).toHaveLength(1)
  })

  it('★ 缓存没命中(没合好 / 刚换音色作废了)→ 宁可不垫,不放旧的也不现合成', () => {
    const timer = manualTimer()
    const logs: string[] = []
    const filler = new WorkerFiller({ clip: () => undefined, setTimer: timer.setTimer, log: line => logs.push(line) })
    filler.arm(); timer.fire()
    expect(filler.wanted).toBe(false)
    expect(filler.phase).toBe('spent')
    expect(logs.join('')).toContain('不垫')
  })

  it('回合结束就收掉(他打断了、回到听)', () => {
    const timer = manualTimer()
    const filler = new WorkerFiller({ clip: () => CLIP, setTimer: timer.setTimer })
    filler.arm(); filler.endRound(); timer.fire()
    expect(filler.wanted).toBe(false)
  })

  it('★ 已经按意图先应过的回合:闸门不按下 → 工人不垫(沿用 fillerGateVerdict)', () => {
    const timer = manualTimer()
    const filler = new WorkerFiller({ clip: () => CLIP, setTimer: timer.setTimer })
    const signaller = new FillerSignaller({ send: () => {} })
    // 闸门没按(应过 / 闲聊):emit 不被调用,工人那边 arm 也不会发生。
    applyAgentState(signaller, 'thinking', () => {})
    expect(timer.pending).toHaveLength(0)
    expect(filler.phase).toBe('idle')
  })
})

describe('llmNode 那一层:到点、模型还没吐字 → 塞一个空串开一段', () => {
  it('★ 该垫了一响就塞空串,只塞一次;之后原样转交模型的字', async () => {
    const timer = manualTimer()
    const filler = new WorkerFiller({ clip: () => CLIP, setTimer: timer.setTimer })
    const base = pushable<string>()
    const out = withFillerKick(base.stream, filler, '')
    filler.arm(); timer.fire()
    base.push('好的'); base.close()
    expect(await readAll(out)).toEqual(['', '好的'])
  })

  it('★ 模型的真文字先过了 → 不再塞', async () => {
    const timer = manualTimer()
    const filler = new WorkerFiller({ clip: () => CLIP, setTimer: timer.setTimer })
    const base = pushable<string>()
    const out = withFillerKick(base.stream, filler, '')
    const reader = out.getReader()
    base.push('你好')
    expect((await reader.read()).value).toBe('你好')
    filler.arm(); timer.fire()
    base.close()
    expect((await reader.read()).done).toBe(true)
  })

  it('只有工具调用、没有文字的块不算「开口」', () => {
    expect(carriesText('')).toBe(false)
    expect(carriesText('字')).toBe(true)
    expect(carriesText({ delta: { toolCalls: [{}] } })).toBe(false)
    expect(carriesText({ delta: { content: '字' } })).toBe(true)
  })

  it('空串不进 TTS 的文字流(别当成模型首字进计时)', async () => {
    const base = pushable<string>()
    base.push(''); base.push('你好'); base.close()
    expect(await readAll(dropEmptyText(base.stream))).toEqual(['你好'])
  })
})

describe('ttsNode 那一层:垫场帧在前,真声一到立刻停', () => {
  it('★ 该垫了 → 先吐垫场帧;真声第一帧一到,剩下的垫场一帧都不再吐', async () => {
    const timer = manualTimer()
    const filler = new WorkerFiller({ clip: () => CLIP, setTimer: timer.setTimer })
    const real = pushable<number>()
    const out = withFillerFrames(real.stream, { filler, silence: () => 0 })
    const reader = out.getReader()
    filler.arm(); timer.fire()
    expect((await reader.read()).value).toBe(-1)
    expect((await reader.read()).value).toBe(-2)
    real.push(10); real.push(11); real.close()
    await tick()
    const rest: number[] = []
    for (;;) { const next = await reader.read(); if (next.done) break; rest.push(next.value) }
    expect(rest).toEqual([10, 11])
    expect(filler.phase).toBe('playing')
  })

  it('★ 真声先到:一帧垫场都没有,并且告诉开关「出声了」(计时器取消)', async () => {
    const timer = manualTimer()
    const filler = new WorkerFiller({ clip: () => CLIP, setTimer: timer.setTimer })
    filler.arm()
    const real = pushable<number>()
    const out = withFillerFrames(real.stream, { filler, silence: () => 0 })
    real.push(10); real.close()
    expect(await readAll(out)).toEqual([10])
    expect(timer.pending[0]?.cancelled).toBe(true)
    timer.fire()
    expect(filler.wanted).toBe(false)
  })

  it('只有工具调用那一段(没有真声):垫场整句放完,流照常收尾', async () => {
    const timer = manualTimer()
    const filler = new WorkerFiller({ clip: () => CLIP, setTimer: timer.setTimer })
    filler.arm(); timer.fire()
    const real = pushable<number>()
    const out = withFillerFrames(real.stream, { filler, silence: () => 0 })
    await tick()
    real.close()
    expect(await readAll(out)).toEqual([-1, -2, -3, -4])
  })

  it('★ 垫完了真声迟迟不来:按节拍补静音帧保活(框架 10 秒没新帧会当 TTS 卡死)', async () => {
    const timer = manualTimer()
    const filler = new WorkerFiller({ clip: () => ({ text: 'x', frames: [-1] }), setTimer: timer.setTimer })
    filler.arm(); timer.fire()
    const real = pushable<number>()
    const out = withFillerFrames(real.stream, { filler, silence: () => 0, keepaliveMs: 5 })
    const reader = out.getReader()
    expect((await reader.read()).value).toBe(-1)
    expect((await reader.read()).value).toBe(0)
    real.push(10); real.close()
    await tick()
    const rest: number[] = []
    for (;;) { const next = await reader.read(); if (next.done) break; rest.push(next.value) }
    expect(rest.filter(v => v !== 0)).toEqual([10])
  })

  it('没垫的段不补静音(只在垫过之后保活)', async () => {
    const filler = new WorkerFiller<number>({ clip: () => undefined })
    const real = pushable<number>()
    const out = withFillerFrames(real.stream, { filler, silence: () => 0, keepaliveMs: 1 })
    setTimeout(() => { real.push(10); real.close() }, 20)
    expect(await readAll(out)).toEqual([10])
  })
})

describe('信号上的能力标记:工人接管了,手机别再放本地那份', () => {
  it('★ workerVoiced 开着 → 每条信号带 voiced_by:worker;关着 → 不带(老行为)', () => {
    const sent: Record<string, unknown>[] = []
    const on = new FillerSignaller({ send: s => sent.push(s as unknown as Record<string, unknown>), slowTools: ['scan_projects'], workerVoiced: true })
    on.thinking(); on.toolStarted('scan_projects')
    expect(sent.every(one => one.voiced_by === 'worker')).toBe(true)
    const old: Record<string, unknown>[] = []
    const off = new FillerSignaller({ send: s => old.push(s as unknown as Record<string, unknown>) })
    off.thinking()
    expect(old[0]).not.toHaveProperty('voiced_by')
  })
})

/**
 * ★ 框架那几行是这一整套的地基(C3:DSH / 框架版本锁死)。升级 `@livekit/agents` 时
 * 这几条先红,提醒人回来重看 workerFiller.ts 头注释那两条前提:
 *   ① 空串照样开一段(`if (current === null) current = await startSegment()`),
 *   ② 对话历史里那条 assistant 消息只由**转发出去的文字**拼成,空的就不写。
 *   ③ 发言队列是串行的(say 插不进当前这一条)—— 这是不用 `session.say` 的理由。
 */
describe('框架前提(升级 @livekit/agents 时先红)', () => {
  const dist = resolve(__dirname, '../node_modules/@livekit/agents/dist/voice')
  const activity = readFileSync(resolve(dist, 'agent_activity.js'), 'utf8')
  const generation = readFileSync(resolve(dist, 'generation.js'), 'utf8')

  it('空串照样开一段、不改生成的文字', () => {
    expect(activity).toContain('if (current === null) {\n            current = await startSegment();')
    expect(generation).toContain('data.generatedText += chunk;')
  })

  it('对话历史只收转发出去的文字,空的不写', () => {
    expect(activity).toContain('const forwardedText = segmentOutputs.map(forwardedTextFor).join("");\n    if (forwardedText) {')
  })

  it('发言队列一次只放一条(say 排不进当前这条回答的前面)', () => {
    expect(activity).toContain('const generation = speechHandle._waitForGeneration();\n        await speechHandle.waitIfNotInterrupted([generation]);')
  })
})
