/**
 * 提机那一刻先问一句(2026-09-23,Ben 12:xx:
 * 「我拿起电话到说话中间可能间隔有一两秒吧,所以最好事务官能先问一句:
 * 『老板,有什么吩咐?』还蛮重要的。」)。
 *
 * 这一组钉五件:
 *   ① **那句话是定死的**,称呼走 address.ts 那张轮换表(今天「老板」,明天「Ben」);
 *   ② **缓存命中直接发帧**:提机那一下一个字节都不向 8792 要,拿到的就是预合成好的音频;
 *   ③ **换音色整张作废、重合成**:不然他刚换完嗓子、下一通提机听见的还是旧的那个人;
 *   ④ **开场只说一次**:说过之后提示词里写明「别重复」,而且同一份底子拼两次不叠两行;
 *   ⑤ **没命中照样有这一句**(8792 那会儿不在 / 还没合完):退回现合成,一个字都不少。
 */
import { describe, expect, it, vi } from 'vitest'
import { localDay, nextAddress } from '../src/address.ts'
import {
  DEFAULT_GREETING_DELAY_MS,
  GreetingCache,
  OFFHOOK_GREETING_TAIL,
  OpeningDelay,
  audioStreamOf,
  createGreetingSynthesizer,
  greetedNote,
  greetingFrames,
  offhookGreeting,
  openerSpeech,
  withGreetedNote,
} from '../src/tts/greeting.ts'

/** 一段能听出长短的假 PCM(16 位小端,`seed` 用来分辨新旧两个嗓子)。 */
function fakePcm(samples: number, seed: number): Buffer {
  const out = Buffer.alloc(samples * 2)
  for (let i = 0; i < samples; i += 1) out.writeInt16LE(((i + seed) % 1000) - 500, i * 2)
  return out
}

/** 把一条 ReadableStream<AudioFrame> 读干净。 */
async function drain<T>(stream: ReadableStream<T>): Promise<T[]> {
  const out: T[] = []
  const reader = stream.getReader()
  for (;;) {
    const got = await reader.read()
    if (got.done) return out
    out.push(got.value)
  }
}

describe('① 提机那一句本身', () => {
  /*
   * ★★ 2026-10-02(卡「电话里像个活人」):后半截从「,有什么吩咐?」改成「,我在。」。
   *
   * Air 那几通里「{称呼},有什么吩咐?」22 次,而且那阵子称呼表里存的是她整句话
   * (「以后叫小笨蛋」)—— 每次接起来都是一模一样的「以后叫小笨蛋,有什么吩咐?」。
   * 两处病:接起来先被**问**一句,和**每次一模一样**。「我在」把问话换成应答。
   */
  it('是定死的一句,称呼放在前面;后半截是应答不是问话', () => {
    expect(offhookGreeting('老板')).toBe('老板,我在。')
    expect(offhookGreeting('姚总')).toBe(`姚总${OFFHOOK_GREETING_TAIL}`)
    expect(OFFHOOK_GREETING_TAIL).not.toContain('吩咐')
    expect(OFFHOOK_GREETING_TAIL).not.toContain('?')
  })

  it('称呼走 address.ts 那张轮换表:同一天不重复,隔天从头来', () => {
    const list = ['老板', '姚总']
    const first = nextAddress(list, undefined, '2026-09-23')
    const second = nextAddress(list, first.state, '2026-09-23')
    const tomorrow = nextAddress(list, second.state, '2026-09-24')
    expect(offhookGreeting(first.address)).toBe('老板,我在。')
    expect(offhookGreeting(second.address)).toBe('姚总,我在。')
    expect(offhookGreeting(tomorrow.address)).toBe('老板,我在。')
    // localDay 就是这张表认的「今天」,不另起一套日期。
    expect(localDay(new Date(2026, 8, 23))).toBe('2026-09-23')
  })

  it('称呼空了也有主语:退回「老板」,不说一句没有主语的话', () => {
    expect(offhookGreeting('   ')).toBe('老板,我在。')
  })
})

describe('② 缓存命中:提机那一下不向 8792 要一个字节', () => {
  it('预热一次,之后每次取都是现成的;第二次预热不重合成', async () => {
    const synthesize = vi.fn(async (text: string) => ({ pcm: fakePcm(2400, text.length), sampleRate: 24000 }))
    const cache = new GreetingCache({ synthesize, lines: () => ['老板,有什么吩咐?', 'Ben,有什么吩咐?'] })

    expect(await cache.warm()).toBe(2)
    expect(synthesize).toHaveBeenCalledTimes(2)

    // 再预热一遍:已经有的那两句**不重合**(省的正是钱与火山那一条并发配额)。
    expect(await cache.warm()).toBe(2)
    expect(synthesize).toHaveBeenCalledTimes(2)

    const got = cache.get('老板,有什么吩咐?')
    expect(got?.pcm.length).toBe(4800)
    expect(got?.sampleRate).toBe(24000)
  })

  it('命中就连音频一起给:那串帧就是预合成的那一段,say() 看见它整条跳过 TTS', async () => {
    const synthesize = vi.fn(async () => ({ pcm: fakePcm(24000, 1), sampleRate: 24000 })) // 1 秒
    const cache = new GreetingCache({ synthesize, lines: () => ['老板,有什么吩咐?'] })
    await cache.warm()

    // 这一条只看「命中就发帧」,所以**不垫前导静音**(垫的那一条在 opener-clipped-0927.test.ts)。
    const speech = openerSpeech(cache, '老板,有什么吩咐?', { leadSilenceMs: 0 })
    expect(speech.cached).toBe(true)
    expect(speech.audio).toBeDefined()

    const frames = await drain(speech.audio as ReadableStream<{ samplesPerChannel: number }>)
    // 20ms 一帧、24k:1 秒 = 50 帧,而且一帧都不能是整段(整段塞一帧 LiveKit 直接 InvalidState)。
    expect(frames.length).toBe(50)
    expect(frames[0]?.samplesPerChannel).toBe(480)
  })

  it('两句话互不串味:各取各的那一段', async () => {
    const cache = new GreetingCache({
      synthesize: async text => ({ pcm: fakePcm(text.length * 100, text.length), sampleRate: 24000 }),
      lines: () => ['老板,有什么吩咐?', 'Ben,有什么吩咐?'],
    })
    await cache.warm()
    expect(cache.get('老板,有什么吩咐?')?.pcm.equals(cache.get('Ben,有什么吩咐?')?.pcm as Buffer)).toBe(false)
  })

  it('帧切得对:不满一帧的尾巴由 flush 单出一帧,一个采样都不丢', () => {
    // 24k、20ms 一帧 = 480 样本;这里给 500 样本 → 一整帧 + 一帧 20 样本的尾巴。
    // **尾巴不补零**(AudioByteStream.flush 出的就是短帧):补零会在句末多一声。
    const frames = greetingFrames({ text: 'x', pcm: fakePcm(500, 0), sampleRate: 24000 })
    expect(frames.length).toBe(2)
    expect(frames[0]?.samplesPerChannel).toBe(480)
    expect(frames[1]?.samplesPerChannel).toBe(20)
  })

  it('audioStreamOf 把那串帧原样交出去,顺序不变', async () => {
    const frames = greetingFrames({ text: 'x', pcm: fakePcm(1440, 0), sampleRate: 24000 })
    const read = await drain(audioStreamOf(frames))
    expect(read.length).toBe(3)
    expect(read[0]).toBe(frames[0])
    expect(read[2]).toBe(frames[2])
  })
})

describe('③ 换音色:整张作废,重合成', () => {
  it('revoice 之后拿到的是新嗓子那一段,不是旧的', async () => {
    let seed = 1
    const synthesize = vi.fn(async () => ({ pcm: fakePcm(2400, seed), sampleRate: 24000 }))
    const cache = new GreetingCache({ synthesize, lines: () => ['老板,有什么吩咐?'] })
    await cache.warm()
    const before = cache.get('老板,有什么吩咐?')?.pcm as Buffer

    seed = 2
    expect(await cache.revoice('灿灿')).toBe(1)
    expect(synthesize).toHaveBeenCalledTimes(2)
    const after = cache.get('老板,有什么吩咐?')?.pcm as Buffer
    expect(after.equals(before)).toBe(false)
  })

  it('★ 换音色时在飞的那趟旧预热一个字节都写不回来(维护者 14:20「音色和最开始听到的不一致」)', async () => {
    /**
     * 病根:`warm()` 原先看见有一趟在飞就把那一趟原样返回,而 `revoice()` 正是
     * 「清空 + 再 warm 一次」—— 于是清空之后,还在飞的那趟把**旧嗓子**写了回来。
     * 这一条钉的就是「旧的那一段进不来」。
     */
    const gates: ((value: { pcm: Buffer, sampleRate: number }) => void)[] = []
    const synthesize = vi.fn(() => new Promise<{ pcm: Buffer, sampleRate: number }>((resolve) => {
      gates.push(resolve)
    }))
    const cache = new GreetingCache({ synthesize, lines: () => ['老板,有什么吩咐?'] })
    const first = cache.warm()
    // 启动那趟还卡在 8792 那里,他这会儿在电话里换了音色。
    const again = cache.revoice('灿灿')
    expect(cache.generation).toBe(1)
    expect(cache.voice).toBe('灿灿')
    // 旧嗓子那一段这才回来 —— 它属于第 0 茬。
    gates[0]?.({ pcm: fakePcm(2400, 1), sampleRate: 24000 })
    expect(await first).toBe(0)
    expect(cache.get('老板,有什么吩咐?')).toBeUndefined()
    // 新嗓子那一段回来才进缓存。
    gates[1]?.({ pcm: fakePcm(2400, 2), sampleRate: 24000 })
    expect(await again).toBe(1)
    const got = cache.get('老板,有什么吩咐?')?.pcm as Buffer
    expect(got.equals(fakePcm(2400, 2))).toBe(true)
    expect(synthesize).toHaveBeenCalledTimes(2)
  })

  it('试听那种「只作废不重合成」:缓存空着(退回现合成),一次都不去 8792', async () => {
    const synthesize = vi.fn(async () => ({ pcm: fakePcm(2400, 1), sampleRate: 24000 }))
    const cache = new GreetingCache({ synthesize, lines: () => ['老板,有什么吩咐?'] })
    await cache.warm()
    expect(synthesize).toHaveBeenCalledTimes(1)
    cache.invalidate('试听 S_x')
    expect(cache.size).toBe(0)
    expect(cache.generation).toBe(1)
    expect(synthesize).toHaveBeenCalledTimes(1)
    expect(openerSpeech(cache, '老板,有什么吩咐?').cached).toBe(false)
  })

  it('重合成失败也不留旧嗓子:宁可这几秒现合成,也不让他听见换掉的那个人', async () => {
    let ok = true
    const cache = new GreetingCache({
      synthesize: async () => (ok ? { pcm: fakePcm(2400, 1), sampleRate: 24000 } : undefined),
      lines: () => ['老板,有什么吩咐?'],
    })
    await cache.warm()
    ok = false
    expect(await cache.revoice('灿灿')).toBe(0)
    expect(cache.get('老板,有什么吩咐?')).toBeUndefined()
  })
})

describe('⑥ 晚一点再说(维护者 2026-09-23 14:20:「很明显说的太早了」)', () => {
  /** 一个能手动拨到点的假定时器。回「排了几次」与「拨一下」。 */
  function fakeTimer() {
    const queued: { fn: () => void, ms: number, canceled: boolean }[] = []
    const setTimer = (fn: () => void, ms: number): (() => void) => {
      const one = { fn, ms, canceled: false }
      queued.push(one)
      return () => { one.canceled = true }
    }
    const fire = (): void => {
      for (const one of [...queued]) { if (!one.canceled) one.fn() }
    }
    return { queued, setTimer, fire }
  }

  it('缺省 700ms:提机到贴耳那一段,排着的时候一个字都还没说', () => {
    expect(DEFAULT_GREETING_DELAY_MS).toBe(700)
    const timer = fakeTimer()
    const said: string[] = []
    const opening = new OpeningDelay({ delayMs: DEFAULT_GREETING_DELAY_MS, setTimer: timer.setTimer })
    opening.schedule(() => said.push('老板,有什么吩咐?'))
    expect(said).toEqual([])
    expect(opening.pending).toBe(true)
    expect(timer.queued[0]?.ms).toBe(700)
    timer.fire()
    expect(said).toEqual(['老板,有什么吩咐?'])
    expect(opening.pending).toBe(false)
  })

  it('★ 700ms 内放下听筒 = 这一句掐掉,不在空听筒里响、更不串进下一通', () => {
    const timer = fakeTimer()
    const said: string[] = []
    const opening = new OpeningDelay({ delayMs: 700, setTimer: timer.setTimer })
    opening.schedule(() => said.push('老板,有什么吩咐?'))
    opening.cancel()
    timer.fire()
    expect(said).toEqual([])
    expect(opening.pending).toBe(false)
    // 再取消一次不出事(挂断那条路会走两遍:takeOffRing 与 restoreAfterRing)
    opening.cancel()
  })

  it('一通电话只有一句开场白:排第二次会把第一次取消掉', () => {
    const timer = fakeTimer()
    const said: string[] = []
    const opening = new OpeningDelay({ delayMs: 700, setTimer: timer.setTimer })
    opening.schedule(() => said.push('第一句'))
    opening.schedule(() => said.push('第二句'))
    timer.fire()
    expect(said).toEqual(['第二句'])
  })

  it('设成 0 = 逐字回到 09-23 下午那一版:当场说,连定时器都不排', () => {
    const timer = fakeTimer()
    const said: string[] = []
    const opening = new OpeningDelay({ delayMs: 0, setTimer: timer.setTimer })
    opening.schedule(() => said.push('老板,有什么吩咐?'))
    expect(said).toEqual(['老板,有什么吩咐?'])
    expect(timer.queued).toHaveLength(0)
    expect(opening.pending).toBe(false)
  })

  it('说出口那一下抛了也不许把电话带走', () => {
    const timer = fakeTimer()
    const opening = new OpeningDelay({ delayMs: 700, setTimer: timer.setTimer })
    opening.schedule(() => { throw new Error('房间没了') })
    expect(() => timer.fire()).not.toThrow()
  })
})

describe('④ 开场只说一次', () => {
  it('说过之后提示词里写明别重复,而且明着点了「有什么吩咐」这几个字', () => {
    const note = greetedNote('老板,有什么吩咐?')
    expect(note).toContain('已经由系统念给他了')
    expect(note).toContain('不要再问一次「有什么吩咐」')
    expect(note).toContain('老板,有什么吩咐?')
  })

  it('没开口就一个字都不加(平时那套提示词不该凭空多一句)', () => {
    expect(withGreetedNote('人设', undefined)).toBe('人设')
    expect(withGreetedNote('人设', '   ')).toBe('人设')
  })

  it('同一份底子拼两次还是一句:提示词一通电话里会换好几回', () => {
    const once = withGreetedNote('人设', '老板,有什么吩咐?')
    expect(once).toContain('人设')
    expect(withGreetedNote(once, '老板,有什么吩咐?')).toBe(once)
  })
})

describe('⑤ 没命中:照样说这一句,只是慢回从前那个样子', () => {
  it('缓存里没有 → 只给字,不给音频(退回现合成)', () => {
    const cache = new GreetingCache({ synthesize: async () => undefined, lines: () => [] })
    const speech = openerSpeech(cache, '老板,有什么吩咐?')
    expect(speech.text).toBe('老板,有什么吩咐?')
    expect(speech.cached).toBe(false)
    expect(speech.audio).toBeUndefined()
  })

  it('压根没有这份缓存(没有接话模型的那几台)也不炸', () => {
    expect(openerSpeech(undefined, '老板,有什么吩咐?')).toEqual({ text: '老板,有什么吩咐?', cached: false, leadSilenceMs: 0 })
  })

  it('8792 不在时预热不抛,只是缓存空着', async () => {
    const lines: string[] = []
    const cache = new GreetingCache({
      synthesize: async () => { throw new Error('connect ECONNREFUSED 127.0.0.1:8792') },
      lines: () => ['老板,有什么吩咐?'],
      log: one => lines.push(one),
    })
    expect(await cache.warm()).toBe(0)
    expect(lines.join('\n')).toContain('提机时现合成')
  })

  it('空串与空表都当作「这一句不用备」', async () => {
    const synthesize = vi.fn(async () => ({ pcm: fakePcm(10, 1), sampleRate: 24000 }))
    const cache = new GreetingCache({ synthesize, lines: () => ['', '   '] })
    expect(await cache.warm()).toBe(0)
    expect(synthesize).not.toHaveBeenCalled()
  })
})

describe('向 8792 要那一句(createGreetingSynthesizer)', () => {
  it('走老的 /api/tts、要 wav、只传 scene —— 音色不由工人挑', async () => {
    const fetchImpl = vi.fn(async () => new Response(Buffer.from(fakePcm(480, 1)), {
      status: 200,
      headers: { 'content-type': 'audio/wav' },
    })) as unknown as typeof fetch
    const synthesize = createGreetingSynthesizer({ butlerUrl: 'http://127.0.0.1:8792', scene: 'chat', fetchImpl })
    const got = await synthesize('老板,有什么吩咐?')
    expect(got?.pcm.length).toBe(960)

    const call = (fetchImpl as unknown as { mock: { calls: [string, { body: string }][] } }).mock.calls[0]
    expect(call?.[0]).toBe('http://127.0.0.1:8792/api/tts')
    const body = JSON.parse(call?.[1].body as string) as Record<string, unknown>
    expect(body).toMatchObject({ text: '老板,有什么吩咐?', scene: 'chat', encoding: 'wav' })
    expect(body.voiceId).toBeUndefined()
  })

  it('8792 回了错误码:回 undefined 并记一行,不抛', async () => {
    const lines: string[] = []
    const fetchImpl = (async () => new Response('{"error":"no key"}', { status: 503 })) as unknown as typeof fetch
    const synthesize = createGreetingSynthesizer({ butlerUrl: 'http://127.0.0.1:8792', scene: 'chat', fetchImpl, log: one => lines.push(one) })
    expect(await synthesize('老板,有什么吩咐?')).toBeUndefined()
    expect(lines.join('\n')).toContain('503')
  })

  it('连不上也只是回 undefined(8792 缺席是一种正常状态)', async () => {
    const fetchImpl = (async () => { throw new Error('connect ECONNREFUSED') }) as unknown as typeof fetch
    const synthesize = createGreetingSynthesizer({ butlerUrl: 'http://127.0.0.1:8792', scene: 'chat', fetchImpl })
    expect(await synthesize('老板,有什么吩咐?')).toBeUndefined()
  })
})
