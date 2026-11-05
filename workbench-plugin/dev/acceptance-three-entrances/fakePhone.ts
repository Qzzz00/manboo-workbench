/**
 * 电话那一列的「假手机」:一个 LiveKit 参与者,照手机 App 那条路进房、拨号、把 TTS 合成的话当麦克风放出去,
 * 录下工人回来的字幕(她识别出的那句 `me`、她说的每一段 `butler`)。骨架照 `scripts/probe-call-record/call-record-e2e.ts`
 * 与 `channel-worker/dev/fake-phone.ts`;拨号次序照 `butler-app/src/call/livekitCall.ts`(进房 → playing → 等工人 → call.start → 开麦)。
 *
 * 进房凭证用配对出来的设备令牌从本机取(`POST /channel/token`),与工人同一个调用形状,所以落在同一间房 ——
 * 工人走中转那条路时,这台也走中转。工具调用房间里不广播,由 run.ts 从工人日志「她调了工具」那一行读。
 */
import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { capturedRoomTextHandler } from './roomCapture.ts'

const WORKER_DIR = join(import.meta.dirname, '..', '..', '..', 'channel-worker')
const requireFromWorker = createRequire(join(WORKER_DIR, 'package.json'))
// rtc-node 的日志不在生产模式就是 debug 级,每帧数据流都打一行:载它之前切到生产模式,只留 info 以上。
process.env.NODE_ENV ??= 'production'
const rtc = requireFromWorker('@livekit/rtc-node') as typeof import('@livekit/rtc-node')
const { AudioFrame, AudioSource, AudioStream, LocalAudioTrack, Room, RoomEvent, TrackKind, TrackPublishOptions, TrackSource } = rtc

/** 与 `channel-worker/src/rpc.ts` 的 RPC_TOPIC / WORKER_IDENTITY 同值(run.ts 启动时读源头核一遍)。 */
export const RPC_TOPIC = 'wb.rpc'
export const WORKER_IDENTITY = 'wb-channel-worker'

const RATE = 48000
const FRAME = RATE / 100

export interface Caption { role: 'me' | 'butler', text: string, at: number }

export interface HeardTurn {
  /** 工人识别出的她那句(`me` 的定稿,可能几段)。 */
  heard: string[]
  /** 她回的每一段(`butler`)。 */
  said: string[]
  /** 这一回合里她垫场 / 调慢工具的那几条。 */
  fillers: string[]
  ms: number
  /** 等到超时都没收住。 */
  timedOut?: boolean
}

export interface FakeCall {
  identity: string
  /** 放一段 wav,等她这一回合说完。 */
  speak: (wav: string, opts?: { maxMs?: number }) => Promise<HeardTurn>
  /** 她自己挂了(道别)没有。 */
  hungUpByHer: () => boolean
  hangup: () => Promise<void>
}

/** 读 16 位单声道 wav 的 data 段(afconvert 出的那种)。 */
function pcmOf(wav: string): Int16Array {
  const buf = readFileSync(wav)
  let at = 12
  while (at + 8 <= buf.length) {
    const id = buf.toString('ascii', at, at + 4)
    const size = buf.readUInt32LE(at + 4)
    if (id === 'data') {
      const out = new Int16Array(Math.floor(size / 2))
      for (let i = 0; i < out.length; i += 1) out[i] = buf.readInt16LE(at + 8 + i * 2)
      return out
    }
    at += 8 + size + (size % 2)
  }
  throw new Error(`${wav} 里没有 data 段`)
}

const run = (cmd: string, args: string[]): Promise<void> => new Promise((resolve, reject) => {
  execFile(cmd, args, { maxBuffer: 1 << 24 }, err => (err === null ? resolve() : reject(err)))
})

/** 她说话用婷婷(女声),旁人用 Reed(男声)。出 48k 单声道 16 位 wav。 */
export async function synthWav(text: string, out: string, voice = 'Tingting'): Promise<string> {
  const aiff = `${out}.aiff`
  await run('/usr/bin/say', ['-v', voice, '-o', aiff, text])
  await run('/usr/bin/afconvert', ['-f', 'WAVE', '-d', `LEI16@${RATE}`, '-c', '1', aiff, out])
  return out
}

/**
 * 旁人插话:同一支麦克风先后收到两个人 —— 她说半句、旁人插一句、她接着说完,中间只隔 150ms
 * (短于断句的静音,识别会当成一句)。10-22 那通就是这样被拼成一句的;整段叠在她声音底下时
 * 识别只收主声,验不到这件事。
 */
export async function spliceWav(parts: string[], out: string): Promise<string> {
  const inputs = parts.flatMap(one => ['-i', one])
  const gap = 'aevalsrc=0:d=0.15:s=' + String(RATE)
  const chain = parts.map((_, i) => `[${i}]aresample=${RATE}[p${i}]`).join(';')
  const order = parts.map((_, i) => (i === 0 ? `[p${i}]` : `[g${i}][p${i}]`)).join('')
  const gaps = parts.slice(1).map((_, i) => `${gap}[g${i + 1}]`).join(';')
  await run('ffmpeg', ['-y', '-loglevel', 'error', ...inputs, '-filter_complex',
    `${chain};${gaps};${order}concat=n=${parts.length * 2 - 1}:v=0:a=1[out]`, '-map', '[out]', '-ar', String(RATE), '-ac', '1', '-c:a', 'pcm_s16le', out])
  return out
}

/** 嘈杂那一遍:底下垫一层粉噪(像开着空调的屋子)。 */
export async function noisyWav(main: string, out: string): Promise<string> {
  await run('ffmpeg', ['-y', '-loglevel', 'error', '-i', main, '-f', 'lavfi', '-i', `anoisesrc=color=pink:amplitude=0.04:sample_rate=${RATE}`,
    '-filter_complex', '[0][1]amix=inputs=2:duration=first:normalize=0', '-ar', String(RATE), '-ac', '1', '-c:a', 'pcm_s16le', out])
  return out
}

export async function startFakeCall(input: {
  base: string
  deviceToken: string
  log: (line: string) => void
}): Promise<FakeCall> {
  const got = await fetch(`${input.base}/channel/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${input.deviceToken}` },
    body: '{}',
  })
  const ticket = await got.json() as { url?: string, token?: string, identity?: string, room?: string, route?: string, error?: string }
  if (!got.ok || ticket.url === undefined || ticket.token === undefined) throw new Error(`取进房凭证没成(${got.status}):${ticket.error ?? '没说原因'}`)
  input.log(`假手机进房:${ticket.identity}(${ticket.route ?? '?'} 路,房间 ${ticket.room ?? '?'})`)

  const room = new Room()
  const pending = new Map<string, (m: Record<string, unknown>) => void>()
  const captions: Caption[] = []
  const fillers: { line: string, at: number }[] = []
  let lastActivity = Date.now()
  let herLoudAt = 0
  let herHungUp = false
  let queue = Promise.resolve()
  room.registerTextStreamHandler(RPC_TOPIC, (reader, from) => {
    queue = queue.then(async () => {
      if (from?.identity !== WORKER_IDENTITY) return
      let m: Record<string, unknown>
      try { m = JSON.parse(await reader.readAll()) as Record<string, unknown> } catch { return }
      const id = typeof m.id === 'string' ? m.id : ''
      const waiter = pending.get(id)
      if (waiter !== undefined) { pending.delete(id); waiter(m); return }
      if (m.type === 'caption' && m.final === true && typeof m.text === 'string' && (m.role === 'me' || m.role === 'butler')) {
        captions.push({ role: m.role, text: m.text, at: Date.now() })
        lastActivity = Date.now()
      }
      if (m.type === 'filler') {
        fillers.push({ line: `${String(m.kind)}${typeof m.tool === 'string' ? `:${m.tool}` : ''}${typeof m.line === 'string' ? ` ${m.line}` : ''}`, at: Date.now() })
        lastActivity = Date.now()
      }
      if (m.type === 'call_state' && m.state === 'idle' && m.by !== 'phone') herHungUp = true
    }).catch(() => {})
  })
  room.on(RoomEvent.TrackSubscribed, (track, _pub, participant) => {
    if (track.kind !== TrackKind.KIND_AUDIO || participant.identity !== WORKER_IDENTITY) return
    void (async () => {
      for await (const frame of new AudioStream(track)) {
        let peak = 0
        for (let i = 0; i < frame.data.length; i += 4) { const v = Math.abs(frame.data[i] as number); if (v > peak) peak = v }
        if (peak > 600) { herLoudAt = Date.now(); lastActivity = herLoudAt }
      }
    })()
  })
  await room.connect(ticket.url, ticket.token, { autoSubscribe: true, dynacast: true })

  const rpc = async (request: Record<string, unknown>): Promise<Record<string, unknown>> => {
    const id = randomUUID()
    const waited = new Promise<Record<string, unknown>>((resolve, reject) => {
      pending.set(id, resolve)
      setTimeout(() => { if (pending.delete(id)) reject(new Error(`${String(request.action)} 10 秒没回`)) }, 10_000)
    })
    await room.localParticipant?.sendText(JSON.stringify({ id, ...request }), { topic: RPC_TOPIC })
    return await waited
  }
  const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms))

  // 等工人在房里(手机 App 也是先等它)。
  const until = Date.now() + 30_000
  while (![...room.remoteParticipants.keys()].includes(WORKER_IDENTITY)) {
    if (Date.now() > until) { await room.disconnect(); throw new Error('30 秒房里没有工人(wb-channel-worker)') }
    await sleep(300)
  }
  await room.localParticipant?.sendText(JSON.stringify({ id: randomUUID(), type: 'call', action: 'playing', warm_ms: 0 }), { topic: RPC_TOPIC })
  const callId = `ph-${randomUUID().replace(/-/g, '').slice(0, 12)}`
  const started = await rpc({ type: 'call', action: 'start', call_id: callId, reports_playing: true })
  if (started.ok !== true) { await room.disconnect(); throw new Error(`拨号没接:${String(started.error ?? '没说原因')}`) }

  const source = new AudioSource(RATE, 1, 200)
  const track = LocalAudioTrack.createAudioTrack('mic', source)
  const options = new TrackPublishOptions()
  options.source = TrackSource.SOURCE_MICROPHONE
  await room.localParticipant?.publishTrack(track, options)
  const silence = new Int16Array(FRAME)
  let frames: Int16Array[] = []
  let drained: (() => void) | undefined
  let pumping = true
  const pump = (async () => {
    while (pumping) {
      const next = frames.shift()
      try { await source.captureFrame(new AudioFrame(next ?? silence, RATE, 1, FRAME)) }
      catch { if (!pumping) break }
      if (next !== undefined && frames.length === 0 && drained !== undefined) { const d = drained; drained = undefined; d() }
    }
  })()

  // 开场白:等她那一句出完声、再静 1.2 秒(开场白走缓存,不一定有字幕)。
  const quietFor = async (ms: number, max: number): Promise<void> => {
    const end = Date.now() + max
    while (Date.now() < end) {
      if (Date.now() - Math.max(lastActivity, herLoudAt) >= ms) return
      await sleep(200)
    }
  }
  await sleep(1500)
  await quietFor(1200, 15_000)
  input.log(`接通了(${callId}),开场白收住`)

  return {
    identity: ticket.identity ?? '',
    hungUpByHer: () => herHungUp,
    async speak(wav, opts) {
      const maxMs = opts?.maxMs ?? 90_000
      const pcm = pcmOf(wav)
      const chunks: Int16Array[] = []
      for (let at = 0; at + FRAME <= pcm.length; at += FRAME) chunks.push(pcm.slice(at, at + FRAME))
      const from = captions.length
      const fillFrom = fillers.length
      const t0 = Date.now()
      await new Promise<void>((resolve) => { drained = resolve; frames = chunks })
      const spokeAt = Date.now()
      lastActivity = spokeAt
      // 收住:识别出她那句之后,她说过至少一段、而且 4 秒没有新字幕 / 没出声 / 没垫场;没识别出来 12 秒就算这一句丢了。
      let timedOut = true
      while (Date.now() - t0 < maxMs) {
        await sleep(250)
        const mine = captions.slice(from)
        const heard = mine.some(c => c.role === 'me')
        const answered = mine.some(c => c.role === 'butler')
        const idle = Date.now() - Math.max(lastActivity, herLoudAt)
        if (herHungUp && idle >= 1500) { timedOut = false; break }
        if (answered && idle >= 4000) { timedOut = false; break }
        if (!heard && !answered && Date.now() - spokeAt >= 12_000 && idle >= 4000) { timedOut = false; break }
      }
      const mine = captions.slice(from)
      return {
        heard: mine.filter(c => c.role === 'me').map(c => c.text),
        said: mine.filter(c => c.role === 'butler').map(c => c.text),
        fillers: fillers.slice(fillFrom).map(f => f.line),
        ms: Date.now() - t0,
        ...(timedOut ? { timedOut: true } : {}),
      }
    },
    async hangup() {
      try { if (!herHungUp) await rpc({ type: 'call', action: 'hangup' }) } catch { /* 她那头已经挂了 */ }
      pumping = false
      await pump.catch(() => {})
      await room.disconnect()
    },
  }
}

/** Real rtc-node data transport for the production App's RoomLink under jsdom. No audio is captured. */
export function nativePhoneRoomSdk(capture: (direction: 'in' | 'out', text: string, from?: string) => void, onRoom?: (room: { disconnect(): Promise<void> }) => void) {
  class NativePhoneRoom extends Room {
    constructor() { super(); onRoom?.(this) }
    override registerTextStreamHandler(topic: string, handler: Parameters<InstanceType<typeof Room>['registerTextStreamHandler']>[1]): void {
      super.registerTextStreamHandler(topic, capturedRoomTextHandler(handler, (text, participant) => capture('in', text, participant?.identity)))
    }
    override async connect(url: string, token: string): Promise<void> {
      await super.connect(url, token, { autoSubscribe: false, dynacast: true })
      const participant = this.localParticipant
      if (participant === undefined) throw new Error('LiveKit did not create the local participant')
      const send = participant.sendText.bind(participant)
      participant.sendText = async (text, options) => {
        try { capture('out', text, participant.identity) } catch { /* capture does not gate delivery */ }
        return await send(text, options)
      }
      // No browser microphone exists in this data-path test; do not claim one was published.
      Object.assign(participant, { setMicrophoneEnabled: async () => undefined })
    }
  }
  return { Room: NativePhoneRoom, RoomEvent }
}
