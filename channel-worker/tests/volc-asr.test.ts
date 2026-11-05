/**
 * 火山流式 ASR:帧编解码逐字段,会话时序对着一个**假 WS 服务端**走四条路。
 *
 * 本机没有火山流式 ASR 的密钥,所以真接火山那一步跑不了(交接文档第三节记着「未跑」)。
 * 能验的是:我们发出去的字节对不对、收到什么样的帧会做什么。这两件对了,拿到密钥那天
 * 剩下的只是「密钥对不对」。
 */
import { gunzipSync, gzipSync } from 'node:zlib'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import { WebSocketServer } from 'ws'
import WebSocket from 'ws'
import { AudioFrame } from '@livekit/rtc-node'
import { stt as sttNs } from '@livekit/agents'
import {
  COMP_GZIP,
  FLAG_NEG_WITH_SEQUENCE,
  FLAG_POS_SEQUENCE,
  MSG_AUDIO_ONLY,
  MSG_FULL_CLIENT,
  MSG_FULL_SERVER,
  MSG_SERVER_ERROR,
  PCM_CHUNK_BYTES,
  SER_JSON,
  SER_RAW,
  buildAudioFrame,
  buildCorpus,
  buildFrame,
  VOLC_END_WINDOW_MS,
  buildStartFrame,
  definiteTranscriptOf,
  errorMessageOf,
  parseFrame,
  transcriptOf,
} from '../src/asr/volcProtocol.ts'
import { openVolcAsrSession } from '../src/asr/volcSession.ts'
import { VolcStreamingStt } from '../src/asr/volcStt.ts'
import { VOLC_ASR_DEFAULT_RESOURCE, chooseAsrKind, readChannelFile, volcAsrCredsOf } from '../src/asr/index.ts'

const CREDS = { appId: 'app', accessToken: 'token', resourceId: VOLC_ASR_DEFAULT_RESOURCE }

describe('帧编解码', () => {
  it('带序号的帧:4 字节头 + 4 字节序号 + 4 字节长度 + payload', () => {
    const frame = buildFrame({
      messageType: MSG_FULL_CLIENT,
      flags: FLAG_POS_SEQUENCE,
      serialization: SER_JSON,
      compression: COMP_GZIP,
      sequence: 1,
      payload: Buffer.from('ab'),
    })
    expect(frame[0]).toBe(0x11) // version=1, headerSize=1
    expect(frame[1]).toBe((MSG_FULL_CLIENT << 4) | FLAG_POS_SEQUENCE)
    expect(frame[2]).toBe((SER_JSON << 4) | COMP_GZIP)
    expect(frame.readInt32BE(4)).toBe(1)
    expect(frame.readUInt32BE(8)).toBe(2)
    expect(frame.subarray(12).toString()).toBe('ab')
  })

  it('最后一包的序号是负数', () => {
    const frame = buildAudioFrame(Buffer.alloc(4), 7, true)
    expect(frame[1]).toBe((MSG_AUDIO_ONLY << 4) | FLAG_NEG_WITH_SEQUENCE)
    expect(frame.readInt32BE(4)).toBe(-7)
  })

  it('开场帧是 gzip 的 JSON,流式要的是 result_type=single', () => {
    const frame = buildStartFrame(['道馆'])
    const payload = gunzipSync(frame.subarray(12))
    const request = JSON.parse(payload.toString()) as {
      audio: { rate: number }
      request: { result_type: string, corpus?: { context: string } }
    }
    expect(request.audio.rate).toBe(16000)
    expect(request.request.result_type).toBe('single')
    expect(JSON.parse(request.request.corpus?.context ?? '{}')).toEqual({ hotwords: [{ word: '道馆' }] })
  })

  it('单字热词不进 corpus,一个都没有时整个字段缺席', () => {
    expect(buildCorpus(['我'])).toBeUndefined()
    expect(buildCorpus([])).toBeUndefined()
  })

  /**
   * 2026-09-18 真机「引导不理我」的根因那一条(交接-0918-引导通话不理人 第一节)。
   *
   * 没有 `end_window_size` 时,火山**只在收到「最后一包」之后**才给一句 `definite` 的话;
   * 而框架从不给流式 STT 发 FLUSH —— 于是我们永远不发最后一包,永远等不到 definite,
   * 永远发不出 FINAL_TRANSCRIPT。框架那边 `audioTranscript` 只认 FINAL,
   * 空着就「skipping EOU detection」:VAD 听见了、回合提交了,可她一个字也没听见。
   */
  it('开场帧要带强制判停(end_window_size),不然一句话永远「没说完」', () => {
    const request = JSON.parse(gunzipSync(buildStartFrame().subarray(12)).toString()) as {
      request: { end_window_size?: number }
    }
    expect(request.request.end_window_size).toBe(VOLC_END_WINDOW_MS)
  })

  it('判停帧里那句话认 utterances 里 definite 的那一条', () => {
    const payload = gzipSync(Buffer.from(JSON.stringify({
      result: {
        text: '你就叫我本吧。',
        utterances: [
          { text: '你就叫我本吧。', definite: true },
          { text: '', definite: false },
        ],
      },
    })))
    const parsed = parseFrame(buildFrame({
      messageType: MSG_FULL_SERVER,
      flags: FLAG_POS_SEQUENCE,
      serialization: SER_JSON,
      compression: COMP_GZIP,
      sequence: 3,
      payload,
    }))
    expect(definiteTranscriptOf(parsed)).toBe('你就叫我本吧。')
  })

  it('还在说的那些(definite 全是 false)不算判停', () => {
    const payload = gzipSync(Buffer.from(JSON.stringify({
      result: { text: '你就叫', utterances: [{ text: '你就叫', definite: false }] },
    })))
    const parsed = parseFrame(buildFrame({
      messageType: MSG_FULL_SERVER,
      flags: FLAG_POS_SEQUENCE,
      serialization: SER_JSON,
      compression: COMP_GZIP,
      sequence: 3,
      payload,
    }))
    expect(definiteTranscriptOf(parsed)).toBeUndefined()
    expect(transcriptOf(parsed)).toBe('你就叫')
  })

  it('解服务端帧:取得出文字', () => {
    const payload = gzipSync(Buffer.from(JSON.stringify({ result: { text: '你好' } })))
    const frame = buildFrame({
      messageType: MSG_FULL_SERVER,
      flags: FLAG_POS_SEQUENCE,
      serialization: SER_JSON,
      compression: COMP_GZIP,
      sequence: 2,
      payload,
    })
    const parsed = parseFrame(frame)
    expect(parsed.messageType).toBe(MSG_FULL_SERVER)
    expect(transcriptOf(parsed)).toBe('你好')
  })

  it('坏字节不抛,回一个什么也不是的空帧', () => {
    expect(parseFrame(Buffer.from([1, 2])).messageType).toBe(0)
    expect(parseFrame(Buffer.alloc(32, 0xff)).json).toBeNull()
  })

  it('错误帧带 code,消息取不到时也不只剩一个数字', () => {
    const frame = Buffer.concat([
      Buffer.from([0x11, (MSG_SERVER_ERROR << 4) | 0, (SER_RAW << 4) | 0, 0]),
      (() => { const b = Buffer.alloc(4); b.writeUInt32BE(45000000); return b })(),
      (() => { const b = Buffer.alloc(4); b.writeUInt32BE(0); return b })(),
    ])
    const parsed = parseFrame(frame)
    expect(parsed.code).toBe(45000000)
    expect(errorMessageOf(parsed)).toBe('火山 ASR 错误(45000000)')
  })
})

describe('凭证', () => {
  it('缺一样就当没配', () => {
    expect(volcAsrCredsOf({ WORKBENCH_CHANNEL_VOLC_ASR_APP_ID: 'a' })).toBeUndefined()
    expect(volcAsrCredsOf({})).toBeUndefined()
  })

  it('两样齐了就成,resource id 有默认值', () => {
    const creds = volcAsrCredsOf({
      WORKBENCH_CHANNEL_VOLC_ASR_APP_ID: 'a',
      WORKBENCH_CHANNEL_VOLC_ASR_ACCESS_TOKEN: 'b',
    })
    expect(creds).toEqual({ appId: 'a', accessToken: 'b', resourceId: VOLC_ASR_DEFAULT_RESOURCE })
  })

  /**
   * 2026-09-21:中间多了一条来源 —— 工作台下发的那一份(钥匙在我们的服务器上)。
   * 顺序是 环境变量 > 工作台下发 > channel.json,理由见 asr/index.ts 的头注释。
   */
  it('工作台下发的那一份能用,而且排在 channel.json 前面', () => {
    const creds = volcAsrCredsOf(
      {},
      { volc_asr_app_id: '老文件里的', volc_asr_access_token: '老文件里的' },
      { app_id: '服务器给的', access_token: '服务器给的' },
    )
    expect(creds).toEqual({ appId: '服务器给的', accessToken: '服务器给的', resourceId: VOLC_ASR_DEFAULT_RESOURCE })
  })

  it('环境变量仍然压过工作台下发的那一份(手工调试时要能压住)', () => {
    const creds = volcAsrCredsOf(
      { WORKBENCH_CHANNEL_VOLC_ASR_APP_ID: '手工的', WORKBENCH_CHANNEL_VOLC_ASR_ACCESS_TOKEN: '手工的' },
      {},
      { app_id: '服务器给的', access_token: '服务器给的' },
    )
    expect(creds?.appId).toBe('手工的')
  })

  it('一个文件都没有、只有服务器那一份,照样成 —— 这正是新用户的样子', () => {
    const creds = volcAsrCredsOf({}, {}, { app_id: 'a', access_token: 'b', resource_id: '自定义' })
    expect(creds).toEqual({ appId: 'a', accessToken: 'b', resourceId: '自定义' })
  })

  it('服务器那一份只给了一半 = 当没给(不拿半把钥匙去连)', () => {
    expect(volcAsrCredsOf({}, {}, { app_id: 'a', access_token: '' })).toBeUndefined()
  })
})

// ———————————————————————— 假服务端 ————————————————————————

interface Fake {
  url: string
  /** 收到的帧,按顺序。 */
  frames: ReturnType<typeof parseFrame>[]
  /** 往回发一帧。 */
  send: (messageType: number, flags: number, body: unknown) => void
  close: () => Promise<void>
}

const fakes: Fake[] = []
afterEach(async () => {
  while (fakes.length) await fakes.pop()?.close()
})

async function startFake(onFrame?: (frame: ReturnType<typeof parseFrame>, fake: Fake) => void): Promise<Fake> {
  const server = new WebSocketServer({ port: 0, host: '127.0.0.1' })
  await new Promise<void>(resolve => server.once('listening', () => resolve()))
  const port = (server.address() as AddressInfo).port
  let socket: WebSocket | undefined
  const fake: Fake = {
    url: `ws://127.0.0.1:${port}`,
    frames: [],
    send(messageType, flags, body) {
      socket?.send(buildFrame({
        messageType,
        flags,
        serialization: SER_JSON,
        compression: COMP_GZIP,
        sequence: 1,
        payload: gzipSync(Buffer.from(JSON.stringify(body))),
      }))
    },
    close: () => new Promise<void>((resolve) => { server.close(() => resolve()) }),
  }
  server.on('connection', (ws) => {
    socket = ws
    ws.on('message', (data: Buffer) => {
      const frame = parseFrame(Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer))
      fake.frames.push(frame)
      onFrame?.(frame, fake)
    })
  })
  fakes.push(fake)
  return fake
}

function waitFor(predicate: () => boolean, label: string, timeoutMs = 3000): Promise<void> {
  return new Promise((resolve, reject) => {
    const started = Date.now()
    const tick = (): void => {
      if (predicate()) { resolve(); return }
      if (Date.now() - started > timeoutMs) { reject(new Error(`等不到:${label}`)); return }
      setTimeout(tick, 10)
    }
    tick()
  })
}

describe('会话时序(假服务端)', () => {
  it('连上先发开场帧,再按 200ms 一包发 PCM,finish 时标最后一包', async () => {
    const fake = await startFake()
    const session = openVolcAsrSession({ url: fake.url, creds: CREDS, handlers: {} })
    session.push(Buffer.alloc(PCM_CHUNK_BYTES * 2))
    session.finish()
    await waitFor(() => fake.frames.some(f => f.flags === FLAG_NEG_WITH_SEQUENCE), '最后一包')
    expect(fake.frames[0]?.messageType).toBe(MSG_FULL_CLIENT)
    const audio = fake.frames.filter(f => f.messageType === MSG_AUDIO_ONLY)
    expect(audio.length).toBeGreaterThanOrEqual(2)
    expect(audio[audio.length - 1]?.flags).toBe(FLAG_NEG_WITH_SEQUENCE)
    session.close()
  })

  it('还没连上就说话也不丢:open 之后一起发出去', async () => {
    const fake = await startFake()
    const session = openVolcAsrSession({ url: fake.url, creds: CREDS, handlers: {} })
    // 同一拍里推完就 finish —— 这时候 WebSocket 还没 open。
    session.push(Buffer.alloc(PCM_CHUNK_BYTES))
    session.finish()
    await waitFor(() => fake.frames.some(f => f.flags === FLAG_NEG_WITH_SEQUENCE), '最后一包')
    expect(fake.frames.filter(f => f.messageType === MSG_AUDIO_ONLY).length).toBeGreaterThanOrEqual(1)
    session.close()
  })

  it('中间结果走 onInterim,最后一包走 onFinal', async () => {
    const interim: string[] = []
    let final: string | undefined
    const fake = await startFake((frame, self) => {
      if (frame.messageType !== MSG_AUDIO_ONLY) return
      if (frame.flags === FLAG_NEG_WITH_SEQUENCE) {
        self.send(MSG_FULL_SERVER, FLAG_NEG_WITH_SEQUENCE, { result: { text: '记一下明天开会' } })
        return
      }
      self.send(MSG_FULL_SERVER, FLAG_POS_SEQUENCE, { result: { text: '记一下' } })
    })
    const session = openVolcAsrSession({
      url: fake.url,
      creds: CREDS,
      handlers: { onInterim: t => interim.push(t), onFinal: (t) => { final = t } },
    })
    // 三包:前两包是普通包(服务端回中间结果),最后一包带负序号(回最终结果)。
    // 只推一包的话,连接还没 open 时 finish 会把它直接当成最后一包发出去——
    // 那是对的行为(见上一条用例),但就验不到中间结果这条路了。
    session.push(Buffer.alloc(PCM_CHUNK_BYTES * 3))
    session.finish()
    await waitFor(() => final !== undefined, '最终结果')
    expect(interim).toContain('记一下')
    expect(final).toBe('记一下明天开会')
  })

  it('服务端回错误帧:一次 onError 一次 onClose,不抛', async () => {
    const messages: string[] = []
    let closes = 0
    const fake = await startFake((frame, self) => {
      if (frame.messageType === MSG_FULL_CLIENT) {
        self.send(MSG_SERVER_ERROR, 0, { message: '鉴权失败' })
      }
    })
    openVolcAsrSession({
      url: fake.url,
      creds: CREDS,
      handlers: { onError: m => messages.push(m), onClose: () => { closes += 1 } },
    })
    await waitFor(() => messages.length > 0, '错误')
    await waitFor(() => closes > 0, '收尾')
    expect(closes).toBe(1)
  })

  /**
   * 判停(`definite: true`)= **这一句说完了**,但连接还要接着用 —— 他还会说下一句。
   * 以前只有「最后一包」那一条路能出 onFinal,而最后一包只在 FLUSH 时发,框架从不 FLUSH。
   */
  it('半路收到 definite 的一句就出 onFinal,连接不关、下一句照旧', async () => {
    const interim: string[] = []
    const finals: string[] = []
    let closes = 0
    let sent = 0
    const fake = await startFake((frame, self) => {
      if (frame.messageType !== MSG_AUDIO_ONLY) return
      sent += 1
      if (sent === 1) self.send(MSG_FULL_SERVER, FLAG_POS_SEQUENCE, { result: { text: '你就叫', utterances: [{ text: '你就叫', definite: false }] } })
      else if (sent === 2) self.send(MSG_FULL_SERVER, FLAG_POS_SEQUENCE, { result: { text: '你就叫我本吧。', utterances: [{ text: '你就叫我本吧。', definite: true }] } })
      else self.send(MSG_FULL_SERVER, FLAG_POS_SEQUENCE, { result: { text: '第二句', utterances: [{ text: '第二句', definite: false }] } })
    })
    const session = openVolcAsrSession({
      url: fake.url,
      creds: CREDS,
      handlers: {
        onInterim: t => interim.push(t),
        onFinal: t => finals.push(t),
        onClose: () => { closes += 1 },
      },
    })
    session.push(Buffer.alloc(PCM_CHUNK_BYTES * 3))
    await waitFor(() => interim.includes('第二句'), '判停之后还收得到下一句')
    expect(finals).toEqual(['你就叫我本吧。'])
    expect(interim[0]).toBe('你就叫')
    // 关键:判停不等于挂电话。
    expect(closes).toBe(0)
    session.close()
  })

  it('连不上也只是一次 onError + 一次 onClose', async () => {
    let errors = 0
    let closes = 0
    openVolcAsrSession({
      // 127.0.0.1:1 上不会有人听。
      url: 'ws://127.0.0.1:1',
      creds: CREDS,
      handlers: { onError: () => { errors += 1 }, onClose: () => { closes += 1 } },
    })
    await waitFor(() => closes > 0, '收尾')
    expect(errors).toBe(1)
    expect(closes).toBe(1)
  })
})

describe('火山凭证也认 channel.json(2026-09-17 Ben 填在那里)', () => {
  it('环境变量没有时从文件字段取,resource 缺省', () => {
    const creds = volcAsrCredsOf({}, { volc_asr_app_id: ' 1838624895 ', volc_asr_access_token: 'tok' })
    expect(creds).toEqual({ appId: '1838624895', accessToken: 'tok', resourceId: VOLC_ASR_DEFAULT_RESOURCE })
  })
  it('环境变量优先于文件', () => {
    const creds = volcAsrCredsOf({ WORKBENCH_CHANNEL_VOLC_ASR_APP_ID: 'env-app' }, { volc_asr_app_id: 'file-app', volc_asr_access_token: 'tok' })
    expect(creds?.appId).toBe('env-app')
    expect(creds?.accessToken).toBe('tok')
  })
  it('文件字段不是字符串或文件缺失 → 当没有', () => {
    expect(volcAsrCredsOf({}, { volc_asr_app_id: 123, volc_asr_access_token: 'tok' })).toBeUndefined()
    expect(readChannelFile({ WORKBENCH_CHANNEL_FILE: '/nonexistent/x.json' })).toEqual({})
    expect(readChannelFile({ WORKBENCH_CHANNEL_FILE: '/x' }, () => 'not json')).toEqual({})
    expect(readChannelFile({ WORKBENCH_CHANNEL_FILE: '/x' }, () => '{"volc_asr_app_id":"a"}')).toEqual({ volc_asr_app_id: 'a' })
  })
  it('没明说 WORKBENCH_CHANNEL_ASR 时,有凭证就走流式;明说了照明说的', () => {
    expect(chooseAsrKind('segmented', undefined, true)).toBe('volc-streaming')
    expect(chooseAsrKind('segmented', undefined, false)).toBe('segmented')
    expect(chooseAsrKind('segmented', 'segmented', true)).toBe('segmented')
    expect(chooseAsrKind('volc-streaming', 'volc-streaming', false)).toBe('volc-streaming')
  })
})

/**
 * ——— 流式 ASR → 框架的事件映射(2026-09-18「引导不理我」那张卡新加) ———
 *
 * 这一组盯的是那条**断在中间的链**:框架的 `AgentActivity` 只把 `FINAL_TRANSCRIPT` 累进
 * `audioTranscript`,而回合提交那一步遇到空的 `audioTranscript` 会直接
 * 「skipping EOU detection」——一行日志都不在 warn 级别上。所以「流式 ASR 必须能在
 * **没有人给它 FLUSH** 的情况下自己给出 FINAL」这件事,要在这里钉死。
 */
describe('流式 ASR 的事件映射', () => {
  /**
   * **整条链一起验**:真的 `openVolcAsrSession` + 假的火山服务端,
   * 音频只 push 不 flush(电话里就是这样),看 FINAL 出不出得来。
   * 这一条要是红了,真机上的样子就是 Ben 那句「不理我」。
   */
  it('没有 FLUSH 也要出 FINAL_TRANSCRIPT(判停就是一句话的结尾)', async () => {
    let audioFrames = 0
    /** 有没有人发过「最后一包」。这条用例的前提就是**没有人 flush**,所以在断言之前它必须是 0。 */
    let lastPackets = 0
    const fake = await startFake((frame, self) => {
      if (frame.messageType !== MSG_AUDIO_ONLY) return
      if (frame.flags === FLAG_NEG_WITH_SEQUENCE) { lastPackets += 1; return }
      audioFrames += 1
      if (audioFrames === 1) self.send(MSG_FULL_SERVER, FLAG_POS_SEQUENCE, { result: { text: '你就叫', utterances: [{ text: '你就叫', definite: false }] } })
      else self.send(MSG_FULL_SERVER, FLAG_POS_SEQUENCE, { result: { text: '你就叫我本吧。', utterances: [{ text: '你就叫我本吧。', definite: true }] } })
    })
    const stt = new VolcStreamingStt({ url: fake.url, creds: CREDS })
    const stream = stt.stream()
    // 两帧 = 两包(PCM_CHUNK_BYTES 是 200ms @16k,一帧给够一包)。
    stream.pushFrame(new AudioFrame(new Int16Array(PCM_CHUNK_BYTES / 2), 16000, 1, PCM_CHUNK_BYTES / 2))
    stream.pushFrame(new AudioFrame(new Int16Array(PCM_CHUNK_BYTES / 2), 16000, 1, PCM_CHUNK_BYTES / 2))

    const kinds: { type: sttNs.SpeechEventType, text?: string }[] = []
    const deadline = Date.now() + 3000
    while (Date.now() < deadline) {
      const next = await Promise.race([
        stream.next(),
        new Promise<{ done: true, value: undefined }>(resolve => setTimeout(() => resolve({ done: true, value: undefined }), 300)),
      ])
      if (next.done === true || next.value === undefined) break
      const event = next.value as unknown as { type: sttNs.SpeechEventType, alternatives?: { text: string }[] }
      kinds.push({ type: event.type, ...(event.alternatives?.[0] === undefined ? {} : { text: event.alternatives[0].text }) })
      if (event.type === sttNs.SpeechEventType.FINAL_TRANSCRIPT) break
    }
    // 先断言再 close:close 会让 run() 的循环收尾、补发一包最后一包,那是对的,但不在这条用例里。
    expect(lastPackets).toBe(0)
    expect(kinds.map(k => k.type)).toContain(sttNs.SpeechEventType.INTERIM_TRANSCRIPT)
    const final = kinds.find(k => k.type === sttNs.SpeechEventType.FINAL_TRANSCRIPT)
    expect(final?.text).toBe('你就叫我本吧。')
    stream.close()
  })

  it('火山出错时不再只往 console 里丢一行:交给注入的那条日志', async () => {
    const lines: string[] = []
    const stt = new VolcStreamingStt({
      url: 'ws://不用连',
      creds: CREDS,
      onError: line => lines.push(line),
      openSession: ({ handlers }) => {
        setTimeout(() => { handlers.onError?.('火山 ASR 错误(45000081)'); handlers.onClose?.() }, 0)
        return { push: () => {}, finish: () => {}, close: () => {} }
      },
    })
    const stream = stt.stream()
    stream.pushFrame(new AudioFrame(new Int16Array(3200), 16000, 1, 3200))
    await waitFor(() => lines.length > 0, '错误进了日志')
    expect(lines[0]).toContain('45000081')
    stream.close()
  })
})

/**
 * ——— 会话不能一开就是一整天(2026-09-18) ———
 *
 * 实测:框架**不会**因为挂断/换人就重建 STT 流 —— 同一条 `VolcSpeechStream` 活到工人退出为止,
 * 帧号从第一通电话一路数到第十通。于是那条火山 WebSocket 也一直开着,
 * 而 `volc.bigasr.sauc.duration` 是**按时长计费**的那个 resource。
 * Ben 机器上与本机都撞到过 `火山 ASR 错误(45000081)`:一条开了十几分钟的会话之后开始每一条都报,
 * 报的那阵子**她一个字也听不见**。这个 code 火山没给消息、还没查清,所以这一条是**保险**不是解药:
 * 没人说话就把连接收掉,下一通重开一条新的(一次握手 ~300ms,躲在开场白后面)。
 */
describe('空闲就把火山会话收掉', () => {
  it('一段时间没有音频进来 → 断开;下一帧重开一条', async () => {
    const opened: { closed: boolean }[] = []
    const stt = new VolcStreamingStt({
      url: 'ws://不用连',
      creds: CREDS,
      idleCloseMs: 30,
      openSession: ({ handlers }) => {
        const entry = { closed: false }
        opened.push(entry)
        return {
          push: () => {},
          finish: () => {},
          close: () => { if (entry.closed) return; entry.closed = true; handlers.onClose?.() },
        }
      },
    })
    const stream = stt.stream()
    const frame = (): AudioFrame => new AudioFrame(new Int16Array(160), 16000, 1, 160)
    stream.pushFrame(frame())
    await waitFor(() => opened.length === 1, '开了一条')
    await waitFor(() => opened[0]?.closed === true, '空闲之后自己收了')
    // 他又说话了 → 重开一条,而不是往一条已经断了的连接里推。
    stream.pushFrame(frame())
    await waitFor(() => opened.length === 2, '重开了一条')
    expect(opened[1]?.closed).toBe(false)
    stream.close()
  })

  it('一直有音频进来就不收(说话中间的停顿不算空闲)', async () => {
    const opened: { closed: boolean }[] = []
    const stt = new VolcStreamingStt({
      url: 'ws://不用连',
      creds: CREDS,
      idleCloseMs: 120,
      openSession: ({ handlers }) => {
        const entry = { closed: false }
        opened.push(entry)
        return { push: () => {}, finish: () => {}, close: () => { entry.closed = true; handlers.onClose?.() } }
      },
    })
    const stream = stt.stream()
    for (let i = 0; i < 8; i += 1) {
      stream.pushFrame(new AudioFrame(new Int16Array(160), 16000, 1, 160))
      await new Promise(resolve => setTimeout(resolve, 20))
    }
    expect(opened.length).toBe(1)
    expect(opened[0]?.closed).toBe(false)
    stream.close()
  })
})
