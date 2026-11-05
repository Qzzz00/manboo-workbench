/**
 * **这一回合的第一句话,现生一句贴这件事的**(2026-10-03,卡「首声提速」乙)。
 *
 * 维护者的后果描述:「多数回合先『我想想』垫场,再等好几秒」。
 *
 * 这一份钉三件事:
 *   ① **那一句的边界**(firstVoice.ts 文件头那四条):不许说结果、不许有数字、
 *      不许反问、不许念系统名词 —— 一条不过就整句作废,退回固定那几句;
 *   ② **结局分得清**:念出去了 / 来晚了 / 没问到 / 过不了关 / 合不出声音;
 *   ③ **插进去的那条路**(workerFiller.ts):早合好了就当场垫、到点还没来就多等一小截、
 *      来晚了就扔掉(**绝不在真回答后面补一句**)。
 */
import { describe, expect, it, vi } from 'vitest'
import {
  FIRST_VOICE_MAX_CHARS,
  FIRST_VOICE_SYSTEM,
  FirstVoice,
  cleanFirstVoice,
  firstVoicePrompt,
} from '../src/firstVoice.ts'
import { FILLER_WAIT_MS, FIRST_VOICE_GRACE_MS, WorkerFiller, withFillerFrames } from '../src/workerFiller.ts'
import { CHANNEL_DEFAULTS, channelWorkerConfigOf } from '../src/config.ts'
import { readFileSync } from 'node:fs'

describe('★★ 那一句的边界(四条,当场检查,不靠模型自觉)', () => {
  const 过: string[] = [
    '好,我这就去问豆包。',
    '行,我去看一眼那条。',
    '好,我去安排一下。',
    '嗯,我现在就去派。',
  ]
  for (const text of 过) {
    it(`「${text}」→ 能念`, () => {
      expect(cleanFirstVoice(text)).toEqual({ ok: true, text })
    })
  }

  it('① 只说在办什么,不说结果 —— 这一句说在工具之前,它不可能知道结果', () => {
    expect(cleanFirstVoice('豆包说放八天假。')).toEqual({ ok: false, why: 'digits' })
    expect(cleanFirstVoice('我已经派出去了。')).toEqual({ ok: false, why: 'result' })
    expect(cleanFirstVoice('那条已经做完了。')).toEqual({ ok: false, why: 'result' })
    expect(cleanFirstVoice('查到了,我跟你说。')).toEqual({ ok: false, why: 'result' })
  })

  it('② 一个数字都不许有(进度与事实只来自工具结果)', () => {
    expect(cleanFirstVoice('好,我去看那 3 条。')).toEqual({ ok: false, why: 'digits' })
    expect(cleanFirstVoice('好,我６分钟后打给你。')).toEqual({ ok: false, why: 'digits' })
    expect(cleanFirstVoice('好,我十分钟后打给你。')).toEqual({ ok: false, why: 'digits' })
    expect(cleanFirstVoice('我去问他们两个。')).toEqual({ ok: false, why: 'digits' })
  })

  it('★ 「一」放过 —— 中文里它多半不是一个数(「看一眼」「办一下」正是最想要的句子)', () => {
    expect(cleanFirstVoice('好,我去看一眼。')).toEqual({ ok: true, text: '好,我去看一眼。' })
    expect(cleanFirstVoice('行,我去办一下。')).toEqual({ ok: true, text: '行,我去办一下。' })
  })

  it('③ 不许反问、不许自问自答(10-02 刚治过的那个毛病)', () => {
    expect(cleanFirstVoice('要我现在就派吗?')).toEqual({ ok: false, why: 'asking' })
    expect(cleanFirstVoice('派给豆包还是 Codex?')).toEqual({ ok: false, why: 'asking' })
    expect(cleanFirstVoice('这件事要我去办吗')).toEqual({ ok: false, why: 'asking' })
  })

  it('④ 不许念系统里的名词(与 10-02「只说她关心的」同一份词)', () => {
    expect(cleanFirstVoice('好,我去那条会话里问一下。')).toEqual({ ok: false, why: 'banned' })
    expect(cleanFirstVoice('好,我把它记到看板上。')).toEqual({ ok: false, why: 'banned' })
  })

  it('太长就整句作废(不截断 —— 截一半的句子念出来更怪)', () => {
    const 长 = '好的好的我这就去跟豆包那边说一声让它帮你把这件事情办了'
    expect([...长].length).toBeGreaterThan(FIRST_VOICE_MAX_CHARS)
    expect(cleanFirstVoice(长)).toEqual({ ok: false, why: 'too-long' })
  })

  it('空的、只有空白的、undefined 一律作废', () => {
    expect(cleanFirstVoice('')).toEqual({ ok: false, why: 'empty' })
    expect(cleanFirstVoice('   \n  ')).toEqual({ ok: false, why: 'empty' })
    expect(cleanFirstVoice(undefined)).toEqual({ ok: false, why: 'empty' })
  })

  it('只剥它包装的壳(引号、星号、多行取第一行),一个字不改写', () => {
    expect(cleanFirstVoice('「好,我这就去问豆包。」')).toEqual({ ok: true, text: '好,我这就去问豆包。' })
    expect(cleanFirstVoice('**好,我去安排。**')).toEqual({ ok: true, text: '好,我去安排。' })
    expect(cleanFirstVoice('\n好,我去看一眼。\n(然后再说)')).toEqual({ ok: true, text: '好,我去看一眼。' })
  })
})

describe('问小模型的那两段话', () => {
  it('带上她的原话与「办的是哪一类」,但不替她编内容', () => {
    const prompt = firstVoicePrompt({ said: '让豆包办公查一下国庆放几天假。', intent: 'relay' })
    expect(prompt.user).toContain('让豆包办公查一下国庆放几天假。')
    expect(prompt.user).toContain('捎句话')
    expect(prompt.system).toBe(FIRST_VOICE_SYSTEM)
  })

  it('认不出意图就不提那一句(不编一个门类)', () => {
    const prompt = firstVoicePrompt({ said: '那个事情你看一下' })
    expect(prompt.user.startsWith('她刚说')).toBe(true)
  })

  it('★ 这一段**短**(电话人设 3000 多字,快的一半原因在这儿)', () => {
    expect([...FIRST_VOICE_SYSTEM].length).toBeLessThan(400)
  })

  it('四条规矩逐条写在那一段里', () => {
    for (const word of ['结果', '数字', '问号', '一句话']) expect(FIRST_VOICE_SYSTEM).toContain(word)
  })

  it('她那一句再长也只截前 200 字进提示(整段念进去就不快了)', () => {
    const prompt = firstVoicePrompt({ said: '啊'.repeat(500) })
    expect([...prompt.user].length).toBeLessThan(260)
  })
})

describe('一回合一次:问 → 查 → 念', () => {
  it('★ 问到了、四条都过 → 交给垫场那条路,结局 said', async () => {
    const speak = vi.fn(async () => 'said' as const)
    const onDone = vi.fn()
    const first = new FirstVoice({ ask: async () => '好,我这就去问豆包。', speak, onDone })
    await first.start({ said: '让豆包查一下天气', intent: 'relay' })
    // 第二个参数是「这一拍还算不算数」那道关口(2026-10-03,卡 fix/voice-route-zh)。
    expect(speak).toHaveBeenCalledWith('好,我这就去问豆包。', { current: expect.any(Function) })
    expect(onDone).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'said', text: '好,我这就去问豆包。' }))
  })

  it('没问到(超时 / 出错)→ failed,一个字都不说', async () => {
    const speak = vi.fn(async () => 'said' as const)
    const onDone = vi.fn()
    const first = new FirstVoice({ ask: async () => { throw new Error('断了') }, speak, onDone })
    await first.start({ said: '让豆包查一下天气' })
    expect(speak).not.toHaveBeenCalled()
    expect(onDone).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'failed' }))
  })

  it('★ 到点不等:超时就当没有(这一回合垫固定那句)', async () => {
    const onDone = vi.fn()
    const first = new FirstVoice({
      ask: () => new Promise(resolve => setTimeout(() => resolve('好,我去办。'), 50)),
      speak: async () => 'said',
      timeoutMs: 5,
      onDone,
    })
    await first.start({ said: '让豆包查一下天气' })
    expect(onDone).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'failed' }))
  })

  it('★ 回了话但过不了那四条 → rejected,**绝不念**', async () => {
    const speak = vi.fn(async () => 'said' as const)
    const onDone = vi.fn()
    const first = new FirstVoice({ ask: async () => '豆包说放 8 天。', speak, onDone })
    await first.start({ said: '让豆包查一下放几天假' })
    expect(speak).not.toHaveBeenCalled()
    expect(onDone).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'rejected', why: 'digits' }))
  })

  it('合不出声音 → unvoiced(宁可垫固定那句,也不现合成去撞真回答)', async () => {
    const onDone = vi.fn()
    const first = new FirstVoice({ ask: async () => '好,我去办一下。', speak: async () => 'unvoiced', onDone })
    await first.start({ said: '帮我打开音乐' })
    expect(onDone).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'unvoiced' }))
  })

  it('垫场那条路不接(已经垫过 / 已经出过真声)→ late', async () => {
    const onDone = vi.fn()
    const first = new FirstVoice({ ask: async () => '好,我去办一下。', speak: async () => 'late', onDone })
    await first.start({ said: '帮我打开音乐' })
    expect(onDone).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'late' }))
  })

  it('★★ 她又说了一句(回合换了)→ 上一拍整个丢掉:不念、不记', async () => {
    const speak = vi.fn(async () => 'said' as const)
    const onDone = vi.fn()
    const first = new FirstVoice({
      ask: () => new Promise(resolve => setTimeout(() => resolve('好,我去办一下。'), 10)),
      speak,
      onDone,
    })
    const stale = first.start({ said: '第一句' })
    // 还在飞的时候她又说了一句 —— 新的一回合把轮号推走
    const fresh = first.start({ said: '第二句' })
    await stale
    // 上一拍:一个字都不念、一条都不记
    expect(speak).not.toHaveBeenCalled()
    expect(onDone).not.toHaveBeenCalled()
    await fresh
    expect(speak).toHaveBeenCalledTimes(1)
    expect(onDone).toHaveBeenCalledTimes(1)
  })

  it('首句自己坏掉不许把电话带走(speak 抛了也只是 unvoiced)', async () => {
    const onDone = vi.fn()
    const first = new FirstVoice({
      ask: async () => '好,我去办一下。',
      speak: () => { throw new Error('8792 炸了') },
      onDone,
    })
    await expect(first.start({ said: '帮我打开音乐' })).resolves.toBeUndefined()
    expect(onDone).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'unvoiced' }))
  })
})

describe('★★ 插进去的那条路(垫场那一层)', () => {
  /** 一个能手动推进的定时器盘。 */
  function clock() {
    const timers: { at: number, fn: () => void, dead?: true }[] = []
    let now = 0
    return {
      setTimer: (fn: () => void, ms: number) => {
        const entry: { at: number, fn: () => void, dead?: true } = { at: now + ms, fn }
        timers.push(entry)
        return () => { entry.dead = true }
      },
      tick: (ms: number) => {
        now += ms
        for (const entry of [...timers].sort((a, b) => a.at - b.at)) {
          if (entry.dead === true || entry.at > now) continue
          entry.dead = true
          entry.fn()
        }
      },
    }
  }

  const FIXED = { text: '我想想。', frames: [1] }
  const FIRST = { text: '好,我这就去问豆包。', frames: [2, 3] }

  function filler(options: { grace?: number } = {}) {
    const time = clock()
    const one = new WorkerFiller<number>({
      clip: () => FIXED,
      setTimer: time.setTimer,
      ...(options.grace === undefined ? {} : { firstVoiceGraceMs: options.grace }),
    })
    return { one, time }
  }

  it('★ 首句早合好了 → **当场就垫**,不等满那 700ms', () => {
    const { one } = filler()
    one.expectFirstVoice()
    one.arm()
    expect(one.phase).toBe('armed')
    expect(one.offerFirstVoice(FIRST)).toBe(true)
    expect(one.wanted).toBe(true)
    expect(one.take()).toEqual(FIRST)
  })

  it('★ 到点首句还没来 → 多等一小截;等到了就垫首句', () => {
    const { one, time } = filler()
    one.expectFirstVoice()
    one.arm()
    time.tick(FILLER_WAIT_MS)
    expect(one.phase).toBe('grace')
    expect(one.offerFirstVoice(FIRST)).toBe(true)
    expect(one.take()).toEqual(FIRST)
  })

  it('★ 多等的那一截也过了 → 垫固定那一句(不再等首句)', () => {
    const { one, time } = filler()
    one.expectFirstVoice()
    one.arm()
    time.tick(FILLER_WAIT_MS)
    time.tick(FIRST_VOICE_GRACE_MS)
    expect(one.take()).toEqual(FIXED)
    // 来晚了的那一句**扔掉**:绝不在真回答后面补一句
    expect(one.offerFirstVoice(FIRST)).toBe(false)
  })

  it('★★ 没说好会有首句 → 一点都不多等(逐字回到这一版之前)', () => {
    const { one, time } = filler()
    one.arm()
    time.tick(FILLER_WAIT_MS)
    expect(one.phase).toBe('wanted')
    expect(one.take()).toEqual(FIXED)
  })

  it('多等那一截设成 0 → 也一点都不多等', () => {
    const { one, time } = filler({ grace: 0 })
    one.expectFirstVoice()
    one.arm()
    time.tick(FILLER_WAIT_MS)
    expect(one.phase).toBe('wanted')
    expect(one.take()).toEqual(FIXED)
  })

  it('★ 多等的时候真声来了 → 一个字都不垫', () => {
    const { one, time } = filler()
    one.expectFirstVoice()
    one.arm()
    time.tick(FILLER_WAIT_MS)
    expect(one.phase).toBe('grace')
    one.realVoice()
    expect(one.phase).toBe('spent')
    expect(one.offerFirstVoice(FIRST)).toBe(false)
    expect(one.take()).toBeUndefined()
  })

  it('没帧的首句不算合好(回 false,照旧走固定那句)', () => {
    const { one, time } = filler()
    one.expectFirstVoice()
    one.arm()
    expect(one.offerFirstVoice({ text: '好,我去办。', frames: [] })).toBe(false)
    time.tick(FILLER_WAIT_MS)
    time.tick(FIRST_VOICE_GRACE_MS)
    expect(one.take()).toEqual(FIXED)
  })

  it('这一轮完了,「会有首句」那一格跟着忘掉', () => {
    const { one, time } = filler()
    one.expectFirstVoice()
    one.arm()
    expect(one.expectingFirstVoice).toBe(true)
    one.endRound()
    expect(one.expectingFirstVoice).toBe(false)
    one.arm()
    time.tick(FILLER_WAIT_MS)
    expect(one.phase).toBe('wanted')
  })
})

/**
 * ——— ★★ **首句不许被掐断** ———
 *
 * 固定那句「我想想。」三四个字,真声一到就停,听着像正常接话;现生的首句有十来个字,
 * 真声多半在它说到一半时到 —— 按老规矩会出现「好,我这就去问豆」然后硬切。
 * **吞字是这个项目点过名的毛病**(维护者 09-27:「『吩』字还是尾巴」),
 * 所以带 `whole` 的那一句放完为止,真回答排在它后面。固定那几句照旧一到就停。
 */
describe('★★ 首句不许被掐断(ttsNode 那一层)', () => {
  /** 一条能手动推的流(与 `worker-filler.test.ts` 里那个同一个写法)。 */
  function pushable<T>() {
    let ctl!: ReadableStreamDefaultController<T>
    const stream = new ReadableStream<T>({ start(c) { ctl = c } })
    return { stream, push: (v: T) => ctl.enqueue(v), close: () => ctl.close() }
  }

  const tick = async (): Promise<void> => { await new Promise(resolve => setTimeout(resolve, 0)) }

  async function play(clip: { text: string, frames: number[], whole?: true }): Promise<number[]> {
    const fired: (() => void)[] = []
    const one = new WorkerFiller<number>({
      clip: () => clip,
      setTimer: (fn) => { fired.push(fn); return () => { /* 这一条用例用不着取消 */ } },
    })
    const real = pushable<number>()
    const out = withFillerFrames(real.stream, { filler: one, silence: () => 0 })
    const reader = out.getReader()
    one.arm()
    fired[0]?.()
    const got: number[] = []
    // 先读到垫场的第一帧,然后真声到
    got.push((await reader.read()).value as number)
    real.push(10)
    real.push(11)
    real.close()
    await tick()
    for (;;) {
      const next = await reader.read()
      if (next.done) break
      got.push(next.value)
    }
    return got
  }

  it('★ 带 whole 的首句:真声到了也先把它放完,真回答排在后面', async () => {
    expect(await play({ text: '好,我这就去问豆包。', frames: [-1, -2, -3], whole: true }))
      .toEqual([-1, -2, -3, 10, 11])
  })

  it('★ 固定那几句照旧:真声第一帧一到,剩下的一帧都不再吐(09-23 那一版一字没改)', async () => {
    expect(await play({ text: '我想想。', frames: [-1, -2, -3] })).toEqual([-1, 10, 11])
  })
})

describe('一键关 / 几个数(配置)', () => {
  it('缺省开着,模型跟接话那一路同一个', () => {
    const config = channelWorkerConfigOf({}, '/home/ben')
    expect(config.firstVoice).toBe(true)
    expect(config.toolsByIntent).toBe(true)
    expect(config.firstVoiceModel).toBe(CHANNEL_DEFAULTS.llmModel)
  })

  it('★ 一键关(卡上要的那个开关)', () => {
    expect(channelWorkerConfigOf({ WORKBENCH_CHANNEL_FIRST_VOICE: 'off' }, '/home/ben').firstVoice).toBe(false)
    expect(channelWorkerConfigOf({ WORKBENCH_CHANNEL_TOOLS_BY_INTENT: 'off' }, '/home/ben').toolsByIntent).toBe(false)
  })

  it('接话模型换了,首句跟着换(没单独指定的话)', () => {
    const config = channelWorkerConfigOf({ WORKBENCH_CHANNEL_LLM_MODEL: 'deepseek-chat' }, '/home/ben')
    expect(config.firstVoiceModel).toBe('deepseek-chat')
  })

  it('首句可以单独指一个更小的模型', () => {
    const config = channelWorkerConfigOf({
      WORKBENCH_CHANNEL_LLM_MODEL: 'deepseek-chat',
      WORKBENCH_CHANNEL_FIRST_VOICE_MODEL: '一个更小的',
    }, '/home/ben')
    expect(config.firstVoiceModel).toBe('一个更小的')
  })

  it('多等那一截设 0 是一个真正的值(不是「没设」)', () => {
    expect(channelWorkerConfigOf({}, '/home/ben').firstVoiceGraceMs).toBe(FIRST_VOICE_GRACE_MS)
    expect(channelWorkerConfigOf({ WORKBENCH_CHANNEL_FIRST_VOICE_GRACE_MS: '0' }, '/home/ben').firstVoiceGraceMs).toBe(0)
    expect(channelWorkerConfigOf({ WORKBENCH_CHANNEL_FIRST_VOICE_GRACE_MS: '呃' }, '/home/ben').firstVoiceGraceMs).toBe(FIRST_VOICE_GRACE_MS)
  })
})

/**
 * ——— 接线还在吗(读 `src/agent.ts` 源码比对)———
 *
 * 这一层要真起一个 LiveKit 会话才跑得到,所以这几条钉的是**那几行接线还在**
 * (AGENTS.md:没有对照测试就补一条,读源头文件比对)。
 */
describe('★ 接线还在吗(读 src/agent.ts)', () => {
  const SOURCE = readFileSync(new URL('../src/agent.ts', import.meta.url), 'utf8')

  it('首句那条路看配置(能一键关)', () => {
    expect(SOURCE).toContain('deps.config.firstVoice')
  })

  it('工具按意图那条路看配置(能一键关)', () => {
    expect(SOURCE).toContain('on: deps.config.toolsByIntent')
  })

  it('★ 闲聊那一路一个字没改:它在挑工具之前就返回了', () => {
    const node = SOURCE.slice(SOURCE.indexOf('const routedLlmNode'), SOURCE.indexOf('agent.llmNode ='))
    expect(node.indexOf("if (decision.route === 'chat')")).toBeLessThan(node.indexOf('planTurnTools'))
  })

  /*
   * ★ **2026-10-13:act 回合不再现生首句**(卡「三个入口一套管线」;维护者 10-13 早:
   * 那三次「好,我这就去弄 / 问问豆包 / 跟它说」都没发生过)。改成固定的中性垫场 ——
   * `turnOpening` 回的是 `filler`,`hearFinalText` 里那一段什么都不起。
   * 现生那一层(`firstVoice.ts`)本身一个字没改,上面那几组用例照旧钉着它。
   */
  it('★ 缓存里没有先应那一句时:什么都不起,交给垫场(不再现生一句)', () => {
    const block = SOURCE.slice(SOURCE.indexOf('const ackSeq = routing.seq'), SOURCE.indexOf('**这一句该不该交回本体**'))
    expect(block).toContain("speech?.cached !== true")
    expect(block).not.toContain('firstVoice.start')
    expect(block).not.toContain('workerFiller.expectFirstVoice()')
  })

  it("★ 开口那一格只有 ack / filler / none 三档(判法只在 turnRoute.ts 的 turnOpening)", () => {
    expect(SOURCE).toContain("turnOpening(decision) === 'none'")
  })
})
