/**
 * 「十分钟断线、她不理我」(2026-09-20,Ben 真机从零验收第二轮)。
 *
 * 铁证(他那台机器,只读):
 *   `~/.dsh/workbench/logs/channel-worker.log`
 *     AgentSession is closing due to an unrecoverable error … type tts_error
 *     Error: 合成失败(502):8792 的 /api/tts 没给音频
 *   `~/.dsh/logs/butler.stderr.log`(同一段时间,连着七条)
 *     [butler-server] tts 合成失败 { provider:'volcengine',
 *       message:'volcengine TTS HTTP 429 code=3001 quota exceeded for types: concurrency' }
 *
 * 两句话:**502 是我们自己把火山的并发配额挤爆了**;而框架攒够 3 条 `tts_error`
 * 就把整条会话关掉 —— 一段话切成四小块,一次回答就够了。
 *
 * 这一组用例钉三件:
 *   ① 合成失败发出去的事件 `recoverable: true`,照框架那段判断逐字跑一遍,会话**不关**;
 *   ② 合成排成队(同一时刻只有一条),不再自己挤自己;
 *   ③ 连着哑够三句才在字幕里说一次实话,出一句声音就重新计数;上游原话进得了日志。
 */
import { describe, expect, it, vi } from 'vitest'
import { Gate } from '../src/tts/gate.ts'
import {
  ButlerTts,
  TTS_DEGRADE_AFTER,
  TTS_DEGRADED_TEXT,
  upstreamDetailOf,
} from '../src/tts/butlerTts.ts'

/** 一个总是回 502 的 8792,body 与这一版 butler-server 回的一模一样。 */
function failing502(detail = 'volcengine TTS HTTP 429 code=3001 quota exceeded for types: concurrency'): typeof fetch {
  return (async () => new Response(
    JSON.stringify({ code: 'tts_failed', error: '语音合成失败,请稍后再试', detail }),
    { status: 502, headers: { 'content-type': 'application/json' } },
  )) as unknown as typeof fetch
}

/** 一个会出声的 8792:24k 单声道、一帧静音也算音频。 */
function working(bytes = 4800): typeof fetch {
  return (async () => new Response(Buffer.alloc(bytes), {
    status: 200,
    headers: { 'content-type': 'audio/wav' },
  })) as unknown as typeof fetch
}

async function drain(stream: AsyncIterable<unknown>): Promise<number> {
  let n = 0
  for await (const _ of stream) n += 1
  return n
}

describe('TTS 失败不许关会话', () => {
  it('合成失败发出去的是 recoverable:true —— 这一个字就是解药', async () => {
    const events: { type: string, recoverable: boolean }[] = []
    const tts = new ButlerTts({ butlerUrl: 'http://127.0.0.1:8792', scene: 'chat', fetchImpl: failing502() })
    tts.on('error', (event: { type: string, recoverable: boolean }) => events.push(event))
    await drain(tts.synthesize('你好。'))
    expect(events).toHaveLength(1)
    expect(events[0]?.type).toBe('tts_error')
    expect(events[0]?.recoverable).toBe(true)
  })

  it('照框架 agent_session._onError 那段逐字跑:四小块全 502,会话一次都没关', async () => {
    /**
     * 这是 `node_modules/@livekit/agents/dist/voice/agent_session.js` 里 `_onError` 的原样:
     *   if (this.closingTask || error.recoverable) return
     *   … ttsErrorCounts += 1; if (ttsErrorCounts <= maxUnrecoverableErrors) return   // 缺省 3
     *   → 否则关会话
     * 计数器只在 `_updateAgentState('speaking')` 里归零 —— 合成一直失败就永远到不了 speaking。
     */
    let ttsErrorCounts = 0
    let closed = false
    const maxUnrecoverableErrors = 3
    const onError = (error: { type: string, recoverable: boolean }): void => {
      if (closed || error.recoverable) return
      if (error.type === 'tts_error') {
        ttsErrorCounts += 1
        if (ttsErrorCounts <= maxUnrecoverableErrors) return
      }
      closed = true
    }

    const tts = new ButlerTts({ butlerUrl: 'http://127.0.0.1:8792', scene: 'chat', fetchImpl: failing502() })
    tts.on('error', onError)
    // 中文断句器把开场白切成四小块,一次回答就是四条 —— 正是 Ben 那一通的形状。
    for (const line of ['你好,', '很高兴认识你。', '我是你的专属事务官。', '你希望我怎么称呼你?']) {
      await drain(tts.synthesize(line))
    }
    expect(ttsErrorCounts).toBe(0)
    expect(closed).toBe(false)
  })

  it('上游那句 429 原话进得了字幕/日志那条错误信息', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const tts = new ButlerTts({ butlerUrl: 'http://127.0.0.1:8792', scene: 'chat', fetchImpl: failing502() })
      await drain(tts.synthesize('你好。'))
      const said = warn.mock.calls.map(call => String(call[0])).join('\n')
      expect(said).toContain('合成失败(502)')
      expect(said).toContain('quota exceeded for types: concurrency')
    }
    finally { warn.mockRestore() }
  })

  it('upstreamDetailOf 读不懂也不抛', async () => {
    expect(await upstreamDetailOf(new Response('', { status: 502 }))).toBe('')
    expect(await upstreamDetailOf(new Response('<html>502 Bad Gateway</html>', { status: 502 })))
      .toContain('502 Bad Gateway')
    expect(await upstreamDetailOf(new Response('{"error":"语音合成失败","detail":"HTTP 429"}', { status: 502 })))
      .toBe('语音合成失败;HTTP 429')
  })
})

describe('连着哑掉才说一句实话', () => {
  it(`第 ${TTS_DEGRADE_AFTER} 句才说,而且只说一次`, async () => {
    const degraded: string[] = []
    const tts = new ButlerTts({
      butlerUrl: 'http://127.0.0.1:8792',
      scene: 'chat',
      fetchImpl: failing502(),
      onDegraded: text => degraded.push(text),
    })
    await drain(tts.synthesize('一'))
    await drain(tts.synthesize('二'))
    expect(degraded).toEqual([])
    await drain(tts.synthesize('三'))
    expect(degraded).toEqual([TTS_DEGRADED_TEXT])
    await drain(tts.synthesize('四'))
    await drain(tts.synthesize('五'))
    expect(degraded).toEqual([TTS_DEGRADED_TEXT])
  })

  it('中间真出了一句声音就重新计数(8792 回来了不该还挂着那句话)', async () => {
    const degraded: string[] = []
    let ok = false
    const tts = new ButlerTts({
      butlerUrl: 'http://127.0.0.1:8792',
      scene: 'chat',
      fetchImpl: (async () => (ok
        ? new Response(Buffer.alloc(4800), { status: 200, headers: { 'content-type': 'audio/wav' } })
        : new Response('{"detail":"x"}', { status: 502 }))) as unknown as typeof fetch,
      onDegraded: text => degraded.push(text),
    })
    await drain(tts.synthesize('一'))
    await drain(tts.synthesize('二'))
    ok = true
    await drain(tts.synthesize('三'))
    expect(tts.failureStreak).toBe(0)
    ok = false
    await drain(tts.synthesize('四'))
    await drain(tts.synthesize('五'))
    expect(degraded).toEqual([])
    await drain(tts.synthesize('六'))
    expect(degraded).toEqual([TTS_DEGRADED_TEXT])
  })
})

describe('合成排成队(429 concurrency 的正解)', () => {
  it('四小块同时来,8792 同一时刻只被打一条', async () => {
    let now = 0
    let peak = 0
    const fetchImpl = (async () => {
      now += 1
      peak = Math.max(peak, now)
      await new Promise(resolve => setTimeout(resolve, 5))
      now -= 1
      return new Response(Buffer.alloc(4800), { status: 200, headers: { 'content-type': 'audio/wav' } })
    }) as unknown as typeof fetch
    const tts = new ButlerTts({ butlerUrl: 'http://127.0.0.1:8792', scene: 'chat', fetchImpl })
    await Promise.all(['一', '二', '三', '四'].map(async text => drain(tts.synthesize(text))))
    expect(peak).toBe(1)
  })

  it('放宽到 2 就真能并到 2(闸是真的在管事,不是摆设)', async () => {
    let now = 0
    let peak = 0
    const fetchImpl = (async () => {
      now += 1
      peak = Math.max(peak, now)
      await new Promise(resolve => setTimeout(resolve, 5))
      now -= 1
      return new Response(Buffer.alloc(4800), { status: 200, headers: { 'content-type': 'audio/wav' } })
    }) as unknown as typeof fetch
    const tts = new ButlerTts({ butlerUrl: 'http://127.0.0.1:8792', scene: 'chat', fetchImpl, maxConcurrent: 2 })
    await Promise.all(['一', '二', '三', '四'].map(async text => drain(tts.synthesize(text))))
    expect(peak).toBe(2)
  })

  it('空句子不占名额(它一个字节都不发出去)', async () => {
    const tts = new ButlerTts({ butlerUrl: 'http://127.0.0.1:8792', scene: 'chat', fetchImpl: working() })
    await drain(tts.synthesize('   '))
    expect(tts.gate.active).toBe(0)
    expect(tts.gate.waiting).toBe(0)
  })
})

describe('Gate', () => {
  it('先到先得,名额直接转手不经过「空出来」那一瞬间', async () => {
    const gate = new Gate(1)
    const order: number[] = []
    const first = await gate.acquire()
    const rest = [2, 3, 4].map(async (n) => {
      const release = await gate.acquire()
      order.push(n)
      release()
    })
    expect(order).toEqual([])
    first()
    await Promise.all(rest)
    expect(order).toEqual([2, 3, 4])
    expect(gate.active).toBe(0)
  })

  it('release 调两次不会多放一个人进来', async () => {
    const gate = new Gate(1)
    const release = await gate.acquire()
    release()
    release()
    expect(gate.active).toBe(0)
  })

  it('配了 0 或者负数按 1 处理,不把整条嘴锁死', () => {
    expect(new Gate(0).max).toBe(1)
    expect(new Gate(-3).max).toBe(1)
    expect(new Gate(Number.NaN).max).toBe(1)
  })
})

/**
 * ——— 计时打点(2026-09-23,通话延迟那张卡) ———
 *
 * 嘴这一侧只打三个点,而且**打点失败不许把这一句话弄哑**。
 * 「一回合只留第一句那一下」不是这里的规矩(那在 latency.ts 的 TurnTimeline),
 * 所以这里每一句都照打 —— 用例钉的正是这一点,免得将来有人把去重挪进来。
 */
describe('TTS 计时打点', () => {
  it('合成成功:tts_request → tts_first_audio → tts_done,顺序就是这样', async () => {
    const marks: string[] = []
    const tts = new ButlerTts({
      butlerUrl: 'http://127.0.0.1:8792',
      scene: 'chat',
      fetchImpl: working(),
      onMark: name => marks.push(name),
    })
    await drain(tts.synthesize('你好。'))
    expect(marks).toEqual(['tts_request', 'tts_first_audio', 'tts_done'])
  })

  it('合成失败:只有 tts_request,后面两个一个都不打(没测到就是没测到)', async () => {
    const marks: string[] = []
    const tts = new ButlerTts({
      butlerUrl: 'http://127.0.0.1:8792',
      scene: 'chat',
      fetchImpl: failing502(),
      onMark: name => marks.push(name),
    })
    await drain(tts.synthesize('你好。'))
    expect(marks).toEqual(['tts_request'])
  })

  it('打点函数自己抛,这一句照样出声', async () => {
    const tts = new ButlerTts({
      butlerUrl: 'http://127.0.0.1:8792',
      scene: 'chat',
      fetchImpl: working(),
      onMark: () => { throw new Error('炸了') },
    })
    expect(await drain(tts.synthesize('你好。'))).toBeGreaterThan(0)
  })
})
