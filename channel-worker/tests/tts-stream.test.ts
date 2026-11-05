/**
 * 流式合成(2026-09-23,冲着「合成首包 1.4~1.6 秒」去的)。
 *
 * 真机第一批(Ben 那台,`GET /channel/latency`,毫秒):
 *   round 2: tts_first 1441   round 3: tts_first 1559
 * `tts_first` 量的是「向 8792 发出 POST → 第一句的音频到手」。老路是「整句合完才给」,
 * 所以这一段基本等于整句的合成时间。流式那条改成「边合边发」。
 *
 * 这一组用例钉五件:
 *   ① **分包**:一帧拆成几块、几帧挤在一块,都读得对;半帧留着,不认识的帧跳过;
 *   ② **首包路径**:流还没结束,第一批音频就已经进了队列(这正是这张卡要的那件事);
 *   ③ **回退**:老 8792 没有这条路由(404)、连不上、一包音频都没给 —— 一律回老路,声音不少;
 *   ④ **回退只白试一次**:一个进程里回退过就不再试(每句白试一次会比从前更慢);
 *   ⑤ **出过声再断不回退**:补一条日志,字幕照出,不重播(重播会结巴)。
 *
 * 另有「第一块短一点」的断句那一刀(firstChunkSplitter)。
 */
import { describe, expect, it, vi } from 'vitest'
import {
  createFrameReader, evenSamples, frameOf,
  FRAME_AUDIO, FRAME_END, FRAME_ERROR, MAX_FRAME_BYTES,
} from '../src/tts/streamFrames.ts'
import { ButlerTts } from '../src/tts/butlerTts.ts'
import { firstChunkSplitter, FIRST_SOFT_BREAK_AT, SOFT_BREAK_AT } from '../src/tts/sentences.ts'

describe('读帧', () => {
  it('一帧拆成好几块喂进去,读出来还是那一帧', () => {
    const reader = createFrameReader()
    const whole = frameOf(FRAME_AUDIO, Buffer.from([1, 2, 3, 4, 5, 6]))
    expect(reader.push(whole.subarray(0, 2))).toEqual([])
    expect(reader.push(whole.subarray(2, 7))).toEqual([])
    const out = reader.push(whole.subarray(7))
    expect(out).toHaveLength(1)
    expect(out[0]).toEqual({ kind: 'audio', audio: Buffer.from([1, 2, 3, 4, 5, 6]) })
  })

  it('好几帧挤在一块里,一次全读出来', () => {
    const reader = createFrameReader()
    const out = reader.push(Buffer.concat([
      frameOf(FRAME_AUDIO, Buffer.from([1, 2])),
      frameOf(FRAME_AUDIO, Buffer.from([3, 4])),
      frameOf(FRAME_END),
    ]))
    expect(out.map(f => f.kind)).toEqual(['audio', 'audio', 'end'])
  })

  it('不认识的帧跳过去 —— 帧自带长度,所以跳得准', () => {
    const reader = createFrameReader()
    const out = reader.push(Buffer.concat([
      frameOf(99, Buffer.from('将来的什么东西', 'utf8')),
      frameOf(FRAME_AUDIO, Buffer.from([7])),
    ]))
    expect(out).toEqual([{ kind: 'audio', audio: Buffer.from([7]) }])
  })

  it('空的音频帧不当一回事(它不是「到头了」)', () => {
    const reader = createFrameReader()
    expect(reader.push(frameOf(FRAME_AUDIO))).toEqual([])
  })

  it('断了那一帧带着人话', () => {
    const reader = createFrameReader()
    const out = reader.push(frameOf(FRAME_ERROR, Buffer.from('火山那边断了', 'utf8')))
    expect(out).toEqual([{ kind: 'error', message: '火山那边断了' }])
  })

  it('流断在半帧上:end() 如实说一句,不把半句话当整句', () => {
    const reader = createFrameReader()
    const whole = frameOf(FRAME_AUDIO, Buffer.from([1, 2, 3, 4]))
    reader.push(whole.subarray(0, 6))
    const out = reader.end()
    expect(out).toHaveLength(1)
    expect(out[0]?.kind).toBe('broken')
  })

  it('长度字段坏掉不许让人一路攒到内存爆', () => {
    const reader = createFrameReader()
    const bad = Buffer.alloc(5)
    bad.writeUInt8(FRAME_AUDIO, 0)
    bad.writeUInt32BE(MAX_FRAME_BYTES + 1, 1)
    const out = reader.push(bad)
    expect(out).toHaveLength(1)
    expect(out[0]?.kind).toBe('broken')
    // 死了之后一个字节都不再收
    expect(reader.push(frameOf(FRAME_AUDIO, Buffer.from([1, 2])))).toEqual([])
  })

  it('半个样本留着下一块再拼 —— 直接送进去是听得见的一声咔哒', () => {
    expect(evenSamples(Buffer.from([1, 2, 3, 4]))).toEqual([Buffer.from([1, 2, 3, 4]), Buffer.alloc(0)])
    const [usable, rest] = evenSamples(Buffer.from([1, 2, 3]))
    expect(usable).toEqual(Buffer.from([1, 2]))
    expect(rest).toEqual(Buffer.from([3]))
  })
})

// ── 一台假的 8792,流式那条路 ───────────────────────────────────────────────

/** 手动推帧的 8792:`push()` 推一帧,`finish()` 收尾。 */
function pushableButler(headers: Record<string, string> = {}): {
  fetchImpl: typeof fetch
  push: (bytes: Buffer) => void
  finish: () => void
  calls: string[]
} {
  const calls: string[] = []
  let controller: ReadableStreamDefaultController<Uint8Array> | undefined
  const stream = new ReadableStream<Uint8Array>({ start(c) { controller = c } })
  const fetchImpl = (async (url: string) => {
    calls.push(String(url))
    return new Response(stream, {
      status: 200,
      headers: { 'content-type': 'application/vnd.butler.tts-stream', 'x-tts-sample-rate': '24000', ...headers },
    })
  }) as unknown as typeof fetch
  return {
    fetchImpl,
    calls,
    push: (bytes: Buffer) => controller?.enqueue(new Uint8Array(bytes)),
    finish: () => controller?.close(),
  }
}

/** 一整条流一次给完的 8792。 */
function wholeStream(frames: Buffer[], calls: string[] = []): typeof fetch {
  return (async (url: string) => {
    calls.push(String(url))
    return new Response(Buffer.concat(frames), {
      status: 200,
      headers: { 'content-type': 'application/vnd.butler.tts-stream', 'x-tts-sample-rate': '24000' },
    })
  }) as unknown as typeof fetch
}

/** 24k/16 位/单声道:`ms` 毫秒的静音。 */
function pcm(ms: number): Buffer {
  return Buffer.alloc(Math.round(24000 * 2 * ms / 1000))
}

describe('首包路径', () => {
  it('流还没结束,第一批音频就已经进了队列 —— 这正是这张卡要的那件事', async () => {
    const butler = pushableButler()
    const marks: string[] = []
    const tts = new ButlerTts({
      butlerUrl: 'http://127.0.0.1:8792', scene: 'chat', stream: true,
      fetchImpl: butler.fetchImpl, onMark: name => marks.push(name),
    })
    const chunked = tts.synthesize('你好,我是事务官。')
    const iterator = chunked[Symbol.asyncIterator]()

    // 先推一帧 100ms 的音频,**不收尾**。
    setTimeout(() => butler.push(frameOf(FRAME_AUDIO, pcm(100))), 0)
    const first = await iterator.next()
    expect(first.done).toBe(false)
    expect(marks).toContain('tts_request')
    expect(marks).toContain('tts_first_audio')
    // 这会儿这条流还开着 —— 首包就是在「整句还没合完」的时候到手的。
    expect(marks).not.toContain('tts_done')

    butler.push(frameOf(FRAME_END))
    butler.finish()
    let count = 1
    for (;;) {
      const next = await iterator.next()
      if (next.done === true) break
      count += 1
    }
    // 100ms 音频 = 5 帧(20ms 一帧),一帧都不少。
    expect(count).toBe(5)
    expect(marks).toContain('tts_done')
    expect(butler.calls[0]).toContain('/api/tts/stream')
  })

  it('最后一帧带 final,前面的不带', async () => {
    const tts = new ButlerTts({
      butlerUrl: 'http://127.0.0.1:8792', scene: 'chat', stream: true,
      fetchImpl: wholeStream([frameOf(FRAME_AUDIO, pcm(60)), frameOf(FRAME_END)]),
    })
    const finals: boolean[] = []
    for await (const audio of tts.synthesize('你好。')) finals.push(audio.final)
    expect(finals).toEqual([false, false, true])
  })

  it('半个样本跨块也拼得回来(字节数一个不差)', async () => {
    const half = pcm(40) // 1920 字节
    const tts = new ButlerTts({
      butlerUrl: 'http://127.0.0.1:8792', scene: 'chat', stream: true,
      fetchImpl: wholeStream([
        frameOf(FRAME_AUDIO, half.subarray(0, 961)), // 奇数,尾巴上半个样本
        frameOf(FRAME_AUDIO, half.subarray(961)),
        frameOf(FRAME_END),
      ]),
    })
    let samples = 0
    for await (const audio of tts.synthesize('你好。')) samples += audio.frame.samplesPerChannel
    expect(samples).toBe(half.length / 2)
  })

  it('字幕在第一批音频进队列那一刻放行,不是等整句合完', async () => {
    const butler = pushableButler()
    const spoken: string[] = []
    const tts = new ButlerTts({
      butlerUrl: 'http://127.0.0.1:8792', scene: 'chat', stream: true,
      fetchImpl: butler.fetchImpl, onSpeech: text => spoken.push(text),
    })
    const iterator = tts.synthesize('你好。')[Symbol.asyncIterator]()
    setTimeout(() => butler.push(frameOf(FRAME_AUDIO, pcm(100))), 0)
    await iterator.next()
    expect(spoken).toEqual(['你好。'])
  })
})

describe('回退', () => {
  it('老 8792 没有这条路由(404)→ 回老的 /api/tts,声音一句不少', async () => {
    const calls: string[] = []
    const fetchImpl = (async (url: string) => {
      calls.push(String(url))
      if (String(url).endsWith('/api/tts/stream')) return new Response('not found', { status: 404 })
      return new Response(pcm(60), { status: 200, headers: { 'content-type': 'audio/wav' } })
    }) as unknown as typeof fetch
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const tts = new ButlerTts({ butlerUrl: 'http://127.0.0.1:8792', scene: 'chat', stream: true, fetchImpl })
      let frames = 0
      for await (const _ of tts.synthesize('你好。')) frames += 1
      expect(frames).toBe(3)
      expect(calls).toEqual(['http://127.0.0.1:8792/api/tts/stream', 'http://127.0.0.1:8792/api/tts'])
      expect(tts.streamOff).toBe(true)
      expect(warn.mock.calls.flat().join('\n')).toContain('流式合成走不通')
    }
    finally { warn.mockRestore() }
  })

  it('回退过一次就不再试 —— 每句白试一次会比从前更慢', async () => {
    const calls: string[] = []
    const fetchImpl = (async (url: string) => {
      calls.push(String(url))
      if (String(url).endsWith('/api/tts/stream')) return new Response('not found', { status: 404 })
      return new Response(pcm(20), { status: 200, headers: { 'content-type': 'audio/wav' } })
    }) as unknown as typeof fetch
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const tts = new ButlerTts({ butlerUrl: 'http://127.0.0.1:8792', scene: 'chat', stream: true, fetchImpl })
      for (const line of ['你好。', '再说一句。', '第三句。']) {
        for await (const _ of tts.synthesize(line)) { /* 放干 */ }
      }
      expect(calls.filter(u => u.endsWith('/api/tts/stream'))).toHaveLength(1)
      expect(calls.filter(u => u.endsWith('/api/tts'))).toHaveLength(3)
      // 那一行只说一次
      expect(warn.mock.calls.flat().join('\n').match(/流式合成走不通/g)).toHaveLength(1)
    }
    finally { warn.mockRestore() }
  })

  it('一包音频都没给(只回了个「断了」帧)→ 照样回老路', async () => {
    const calls: string[] = []
    const fetchImpl = (async (url: string) => {
      calls.push(String(url))
      if (String(url).endsWith('/api/tts/stream')) {
        return new Response(Buffer.concat([frameOf(FRAME_ERROR, Buffer.from('火山没理我', 'utf8'))]), {
          status: 200, headers: { 'content-type': 'application/vnd.butler.tts-stream' },
        })
      }
      return new Response(pcm(40), { status: 200, headers: { 'content-type': 'audio/wav' } })
    }) as unknown as typeof fetch
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const tts = new ButlerTts({ butlerUrl: 'http://127.0.0.1:8792', scene: 'chat', stream: true, fetchImpl })
      let frames = 0
      for await (const _ of tts.synthesize('你好。')) frames += 1
      expect(frames).toBe(2)
      expect(calls).toHaveLength(2)
    }
    finally { warn.mockRestore() }
  })

  it('已经出过声再断 → **不**回退,只记一行(重播会结巴)', async () => {
    const calls: string[] = []
    const fetchImpl = (async (url: string) => {
      calls.push(String(url))
      return new Response(Buffer.concat([
        frameOf(FRAME_AUDIO, pcm(60)),
        frameOf(FRAME_ERROR, Buffer.from('火山中途断了', 'utf8')),
      ]), { status: 200, headers: { 'content-type': 'application/vnd.butler.tts-stream', 'x-tts-sample-rate': '24000' } })
    }) as unknown as typeof fetch
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const tts = new ButlerTts({ butlerUrl: 'http://127.0.0.1:8792', scene: 'chat', stream: true, fetchImpl })
      let frames = 0
      for await (const _ of tts.synthesize('你好。')) frames += 1
      expect(frames).toBe(3)
      expect(calls).toHaveLength(1) // 没有第二次请求
      expect(tts.streamOff).toBe(false)
      expect(warn.mock.calls.flat().join('\n')).toContain('只合了一半')
    }
    finally { warn.mockRestore() }
  })

  it('开关关掉就一次都不试', async () => {
    const calls: string[] = []
    const fetchImpl = (async (url: string) => {
      calls.push(String(url))
      return new Response(pcm(20), { status: 200, headers: { 'content-type': 'audio/wav' } })
    }) as unknown as typeof fetch
    const tts = new ButlerTts({ butlerUrl: 'http://127.0.0.1:8792', scene: 'chat', fetchImpl })
    for await (const _ of tts.synthesize('你好。')) { /* 放干 */ }
    expect(calls).toEqual(['http://127.0.0.1:8792/api/tts'])
  })
})

describe('第一块短一点', () => {
  it('第一块在 10 字的逗号上就断,后面几块还是 18 字', () => {
    const split = firstChunkSplitter(SOFT_BREAK_AT, FIRST_SOFT_BREAK_AT)
    // 「你今天上午说的那件事,」正好越过 10 字的门槛 → 第一刀落在这个逗号上。
    const first = split('你今天上午说的那件事,我已经替你记下来了,明天上午九点提醒你。')
    expect(first[0]).toBe('你今天上午说的那件事,')

    // 换挡之后:同一段文字,10~18 字之间的逗号不再断。
    const later = split('我已经替你记,下来了,明天上午九点提醒你。')
    expect(later[0]).not.toBe('我已经替你记,')
  })

  it('门槛设成和平时一样 = 逐字回到从前', () => {
    const same = firstChunkSplitter(SOFT_BREAK_AT, SOFT_BREAK_AT)
    const plain = (text: string): string[] => firstChunkSplitter(SOFT_BREAK_AT, SOFT_BREAK_AT)(text)
    const text = '你今天上午说的那件事,我已经替你记下来了。'
    expect(same(text)).toEqual(plain(text))
  })

  it('句末标点照样随时断 —— 这一刀只管软断点', () => {
    const split = firstChunkSplitter(SOFT_BREAK_AT, FIRST_SOFT_BREAK_AT)
    // 七个字的第一句,句号后面直接断(与 FIRST_SOFT_BREAK_AT 无关)。
    expect(split('今天就到这里。我这就去办,顺便把那份文件也带上。')[0]).toBe('今天就到这里。')
    // 比 MIN_PIECE 还短的头一句照旧并进后面那块 —— 这条老规矩没被这一刀改掉。
    expect(firstChunkSplitter(SOFT_BREAK_AT, FIRST_SOFT_BREAK_AT)('好的。我这就去办。')[0]).toBe('好的。我这就去办。')
  })
})
