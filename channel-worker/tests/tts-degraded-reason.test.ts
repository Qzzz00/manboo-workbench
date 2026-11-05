/**
 * 合成失败时**说真原因**(2026-09-27,卡 VO 第 ③ 件)。
 *
 * 在这之前不管什么原因,字幕里都只有那一句「语音后端这会儿有点问题」。
 * 可这几件事该做的完全不一样:
 *   · 这一档没开通 → 去火山控制台开一档(2026-09-26 卡了一整天的就是这个,见决策记录 18:20);
 *   · 额度用完     → 去续费;
 *   · 太挤         → 等一会儿就好。
 *
 * 原因由 8792 **分好格**送来(`cause.human`,见 butler-server/server/routes/api/tts.cjs)。
 * 工人这头不解析火山原话 —— 那张表只许有一份,抄两份迟早对不上。
 */
import { describe, expect, it } from 'vitest'
import {
  ButlerTts,
  TTS_DEGRADE_AFTER,
  TTS_DEGRADED_TEXT,
  degradedTextOf,
  upstreamFailureOf,
} from '../src/tts/butlerTts.ts'

/** 这一版 butler-server 的 502 回包:error / cause / detail 三格。 */
function failing502WithCause(human: string): typeof fetch {
  return (async () => new Response(
    JSON.stringify({
      code: 'tts_failed',
      error: `${human} —— 去火山引擎控制台开通`,
      cause: { kind: 'not_granted', human, action: '去火山引擎控制台开通' },
      detail: 'volcengine TTS HTTP 403 requested resource not granted',
    }),
    { status: 502, headers: { 'content-type': 'application/json' } },
  )) as unknown as typeof fetch
}

/** 老的 8792:只有 error / detail,没有 cause。 */
function failing502Old(): typeof fetch {
  return (async () => new Response(
    JSON.stringify({ code: 'tts_failed', error: '语音合成失败,请稍后再试', detail: 'HTTP 429 concurrency' }),
    { status: 502, headers: { 'content-type': 'application/json' } },
  )) as unknown as typeof fetch
}

async function drain(stream: AsyncIterable<unknown>): Promise<void> {
  for await (const _ of stream) { /* 这一组不关心帧 */ }
}

describe('upstreamFailureOf 把「说给人听的」和「进日志的」分开', () => {
  it('新版 8792:human 是那句短话,joined 还是原来那一长串', async () => {
    const body = JSON.stringify({
      error: '这个音色没开通 —— 去开通',
      cause: { kind: 'not_granted', human: '这个音色没开通' },
      detail: 'HTTP 403 not granted',
    })
    const out = await upstreamFailureOf(new Response(body, { status: 502 }))
    expect(out.human).toBe('这个音色没开通')
    expect(out.joined).toBe('这个音色没开通 —— 去开通;HTTP 403 not granted')
  })

  it('老版 8792(没有 cause)与读不懂的身子,都只是 human 为空,**不抛**', async () => {
    expect((await upstreamFailureOf(new Response('{"error":"x","detail":"y"}', { status: 502 }))).human).toBe('')
    expect((await upstreamFailureOf(new Response('<html>502</html>', { status: 502 })))).toEqual({
      human: '', joined: '<html>502</html>',
    })
    expect(await upstreamFailureOf(new Response('', { status: 502 }))).toEqual({ human: '', joined: '' })
  })
})

describe('degradedTextOf', () => {
  it('不知道原因 → 还是那句兜底', () => {
    expect(degradedTextOf(undefined)).toBe(TTS_DEGRADED_TEXT)
    expect(degradedTextOf('   ')).toBe(TTS_DEGRADED_TEXT)
  })

  it('知道原因 → 把原因说出来', () => {
    const said = degradedTextOf('这个音色这个火山账号没开通')
    expect(said).toContain('这个音色这个火山账号没开通')
    expect(said).toContain('我先用字幕跟你说')
  })
})

describe('连着哑够三句时,字幕里说的是真原因', () => {
  it('新版 8792:说「没开通」,不再说「有点问题」', async () => {
    const degraded: string[] = []
    const tts = new ButlerTts({
      butlerUrl: 'http://127.0.0.1:8792',
      scene: 'chat',
      fetchImpl: failing502WithCause('这个音色这个火山账号没开通'),
      onDegraded: text => degraded.push(text),
      stream: false,
    })
    for (let i = 0; i < TTS_DEGRADE_AFTER; i += 1) await drain(tts.synthesize(`第${i}句`))
    expect(degraded).toHaveLength(1)
    expect(degraded[0]).toContain('这个音色这个火山账号没开通')
    expect(degraded[0]).not.toBe(TTS_DEGRADED_TEXT)
  })

  it('老版 8792:没有 cause 就还是那句兜底(不编一个原因)', async () => {
    const degraded: string[] = []
    const tts = new ButlerTts({
      butlerUrl: 'http://127.0.0.1:8792',
      scene: 'chat',
      fetchImpl: failing502Old(),
      onDegraded: text => degraded.push(text),
      stream: false,
    })
    for (let i = 0; i < TTS_DEGRADE_AFTER; i += 1) await drain(tts.synthesize(`第${i}句`))
    expect(degraded).toEqual([TTS_DEGRADED_TEXT])
  })

  it('中间出了一句声音:上一次的原因清掉,不拿它解释下一次的沉默', async () => {
    let ok = false
    const degraded: string[] = []
    const tts = new ButlerTts({
      butlerUrl: 'http://127.0.0.1:8792',
      scene: 'chat',
      stream: false,
      fetchImpl: (async () => (ok
        ? new Response(Buffer.alloc(4800), { status: 200, headers: { 'content-type': 'audio/wav' } })
        : new Response(
          JSON.stringify({ error: 'x', cause: { kind: 'quota', human: '额度用完了' }, detail: 'd' }),
          { status: 502, headers: { 'content-type': 'application/json' } },
        ))) as unknown as typeof fetch,
      onDegraded: text => degraded.push(text),
    })
    await drain(tts.synthesize('一'))
    expect(tts.lastReason).toBe('额度用完了')
    ok = true
    await drain(tts.synthesize('二'))
    expect(tts.lastReason).toBeUndefined()
  })
})
