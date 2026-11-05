/**
 * 一台**没有人的手机**:进房、把一段 WAV 当麦克风放出去、听事务官回话、收发文件,
 * 全程打时间戳。
 *
 * 为什么要它:浏览器测试页要人对着麦克风说话,拿不到可复现的数字;这台把同一段录音
 * 一字不差地放进房间,「说完到听见第一个字」就能用两条时间戳相减算出来,不靠感觉。
 * 浏览器测试页仍然留着 —— 那是给人用的,这台是给数字用的。
 *
 * 2026-09-17 扩了三样(工人常驻与房间代理那张卡):
 *   - **真配对**:先向工作台要一个配对码再 claim,拿到设备令牌 —— 这样它的身份才是
 *     `wb-phone-<device_id>`,房间代理才认它(测试页那种 `wb-dev-` 身份一条都代办不了);
 *   - **房间代理**:经 `wb.rpc` 走一遍 `GET /state`、一条**不在白名单**的路(该 403)、一次 `renew`;
 *   - **字幕**:把房里收到的 `caption` 打出来。
 * 不给 `--wav` 就只跑这三样,不放音频(跑 RPC 不需要麦克风,也不需要 DeepSeek key)。
 *
 * 用法:
 *   node dev/fake-phone.ts [--wav 那段话.wav] [--workbench http://127.0.0.1:8795] [--send 要发的文件]
 *
 * 2026-09-18(引导改通话模式)多一样:`--onboarding start|resume` ——
 * 进房之后在 `wb.rpc` 上说一句「我在做引导」,然后量两个数字:
 *   ① **进房 → 听见开场白第一个字**(Ben 说的「扫码到听见声音十秒」就是这一段,目标 ≤2 秒);
 *   ② 开场白的**字幕**比声音早/晚多少(目标:同一刻,不再「字先出、闪一下、过一阵才有声」)。
 * 带 `--wav` 时再答一句(比如「叫我 Ben」),量一问一答;跑完发一条 `stop`(= 挂断,暂停引导)。
 *
 * 2026-09-20(缓冲语存手机本地)多一样:**它真的跑手机那一份缓冲语逻辑**。
 * 工人的 `{type:'filler'}` 信号一到,就交给 `butler-app/src/call/fillerAudio.ts` 里
 * 那个一模一样的状态机(**不是一份长得像的复制品**),用包里那几句 m4a 的真实时长当「放了多久」,
 * 把「信号 → 本地播放」的延迟、和「被她的真声掐断在第几毫秒」量出来。
 * 关掉它:`--no-filler`(想看「没有缓冲语时那几秒有多安静」时用)。
 * 2026-09-20(引导改协助梳理)再多一样:`--script 本子.txt` ——
 * 一行一句「他说的话」,走引导的**打字备胎**(`onboarding.say`)一句句发出去,
 * 每句之间等她这一轮说完(`--quiet` 毫秒没有新字幕,缺省 3500;一句最多等 `--turn`,缺省 60000),
 * 跑完把整段对话逐字打出来。验「她怎么说话」(复述 / 边界 / 日历 / 排方案 / 称呼确认)用它 ——
 * 那件事一个字都不经过 ASR,拿录音去验等于在验别人那条链路。
 *
 * 2026-09-21(座机响铃 / 主动来电)多一样:`--incoming [auto|wait]`(缺省 auto)——
 * 这台假手机**当座机用**:进房之后就待在房里不动,等工人那条 `{type:'ring'}`。
 *   auto  收到 ring 就自动「接起」(发 `{type:'call',action:'answer',call_id}`),
 *         带 `--wav` 的话接起来之后把那段录音放出去(比如一句「批准」),
 *         然后等她把 `wb_decide_item` 调完,最后 `POST /task/move` 之前之后的状态各打一遍;
 *   wait  只响不接 —— 用来验「60 秒没人接 → 未接来电」那条。
 * `--ring-wait` 秒数:最多等一通电话多久(缺省 120)。
 * 这一模式**不走房间代理那三条用例**,也不发招呼:座机是被打的那一头。
 *
 * 那段 WAV 哪来:用 8792 的 TTS 合成一句再转 16k 单声道即可,例如
 *   curl -s -X POST http://127.0.0.1:8792/api/tts -H 'content-type: application/json' \
 *     -d '{"text":"记一下明天上午十点开会。","scene":"chat"}' -o 话.mp3
 *   ffmpeg -i 话.mp3 -ar 16000 -ac 1 -sample_fmt s16 话.wav
 */
import { randomUUID } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { basename, dirname, resolve as resolvePath } from 'node:path'
import { fileURLToPath } from 'node:url'
import { AudioFrame, AudioSource, AudioStream, LocalAudioTrack, Room, RoomEvent, TrackKind, TrackPublishOptions, TrackSource } from '@livekit/rtc-node'
import { pcmOfWav } from '../src/tts/butlerTts.ts'
import { FILE_TOPIC, RPC_TOPIC, WORKER_IDENTITY } from '../src/rpc.ts'
import { DEV_TOPIC, parseDevResponse } from '../src/files/deviceRpc.ts'

function arg(name: string, fallback?: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`)
  return index >= 0 ? process.argv[index + 1] : fallback
}

function stamp(): string {
  const now = new Date()
  return `${now.toTimeString().slice(0, 8)}.${String(now.getMilliseconds()).padStart(3, '0')}`
}

const marks: { label: string, at: number }[] = []
function log(line: string): void {
  console.log(`${stamp()}  ${line}`)
}
function mark(label: string): void {
  marks.push({ label, at: Date.now() })
  log(`⏱ ${label}`)
}

/**
 * 真走一遍配对:`POST /pair/start`(回环)拿码 → `POST /pair/claim` 换设备令牌。
 * 为什么非得真配对:房间代理**只认 `wb-phone-<device_id>` 这个身份**,而这个身份是 8791
 * 按设备令牌拼的。拿测试页那种 `wb-dev-` 身份去发 wb.rpc,工人一条都不会代办(这也正是要验的)。
 */
async function pair(workbench: string): Promise<{ deviceId: string, token: string }> {
  const started = await fetch(`${workbench}/pair/start`, { method: 'POST' })
  const startBody = await started.json() as { pairing?: { code?: string }, error?: string }
  const code = startBody.pairing?.code
  if (!started.ok || code === undefined) throw new Error(`拿不到配对码:${startBody.error ?? started.status}`)
  const claimed = await fetch(`${workbench}/pair/claim`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code, device_name: '假手机', platform: 'fake' }),
  })
  const claimBody = await claimed.json() as { device_id?: string, token?: string, error?: string }
  if (!claimed.ok || claimBody.token === undefined || claimBody.device_id === undefined) {
    throw new Error(`配对没成:${claimBody.error ?? claimed.status}`)
  }
  return { deviceId: claimBody.device_id, token: claimBody.token }
}

async function main(): Promise<void> {
  const workbench = (arg('workbench') ?? 'http://127.0.0.1:8795').replace(/\/+$/, '')
  const wavPath = arg('wav')
  const sendPath = arg('send')
  /** 只发给这一台(identity)。不给就发给房里所有人(09-17 那版的行为)。 */
  const sendTo = arg('to')
  /** 引导模式(2026-09-18):'start' 第一次 / 'resume' 接着做。 */
  const onboardingAction = arg('onboarding')
  /**
   * **照本子跟她聊一段**(2026-09-20,「引导改协助梳理」那张卡)。
   *
   * 走的是引导的**打字备胎**(`wb.rpc` 的 `onboarding.say`)—— 那条和语音进的是同一个模型、
   * 同一份系统提示、同一批工具,只是不过 ASR。为什么用它而不是放录音:
   * 这张卡改的是**她怎么说话**(复述 / 边界 / 日历 / 排方案 / 称呼确认),
   * 而那件事一个字都不经过 ASR;拿十来句录音去验它,验的是别人那条链路。
   *
   * 本子是一个文本文件,一行一句他说的话;`#` 开头与空行跳过。
   * 每一句都**等她这一轮说完**(连着 `--quiet` 毫秒没有新字幕)再发下一句 —— 和真人一样。
   */
  const scriptPath = arg('script')
  /** 她安静多久算「这一轮说完了」。缺省 3.5 秒(一次工具往返 + 一句合成)。 */
  const quietMs = Number(arg('quiet', '3500'))
  /** 一句最多等多久。缺省 60 秒(她要调工具、要等工作台)。 */
  const turnMs = Number(arg('turn', '60000'))
  /**
   * 座机模式(2026-09-21):当那台装在外壳里的手机用,等电话打进来。
   * `auto` 收到就接,`wait` 只响不接(验未接来电)。
   */
  const incomingMode = process.argv.includes('--incoming') ? (arg('incoming') ?? 'auto') : undefined
  /** 最多等一通电话多久(秒)。 */
  const ringWaitMs = Number(arg('ring-wait', '120')) * 1000

  const paired = await pair(workbench)
  mark(`配对了:设备 ${paired.deviceId}`)

  /**
   * ⚠️ 这台假手机跑在**同一台机器上**,所以对 8791 来说它是回环 —— 而回环来源根本不看
   * Authorization(回环本身就是凭证),于是它会拿到 `wb-dev-page` 那个测试页身份,房间代理一条都不代办。
   * 真手机在局域网/远程那一侧不存在这个问题(它是非回环,只认令牌)。
   * 所以这里**额外**带一条 `X-Workbench-Channel-Device`:那正是工人替手机办事时用的降权头,
   * 带上它,8791 就把这条回环请求当成那台设备 —— 这样假手机才拿得到 `wb-phone-<device_id>` 的身份。
   * 令牌照样带着(真手机只带这一样),两条一起发,哪一侧的门都走过一遍。
   */
  const res = await fetch(`${workbench}/channel/token`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'authorization': `Bearer ${paired.token}`,
      'x-workbench-channel-device': paired.deviceId,
    },
    body: JSON.stringify({ name: '假手机' }),
  })
  const ticket = await res.json() as { url?: string, room?: string, token?: string, identity?: string, expires_at?: number, error?: string }
  if (!res.ok || ticket.token === undefined) throw new Error(`取凭证失败:${ticket.error ?? res.status}`)
  log(`凭证到手:${ticket.url} / ${ticket.room},身份 ${ticket.identity},到期 ${ticket.expires_at}`)

  const room = new Room()

  // ——— 房间代理:一条一条问,按 id 对上答 ———
  const pending = new Map<string, (response: Record<string, unknown>) => void>()
  /** 和真手机一样:一条一条读,否则并发 readAll 会把字幕读成乱序(2026-09-18 实测)。 */
  let textQueue: Promise<void> = Promise.resolve()
  /** 座机收到的那几通(2026-09-21)。 */
  const rings: { callId: string, at: number, reason: string, title: string, silent: boolean, itemId: string }[] = []
  const ringEnds: { callId: string, outcome: string, at: number }[] = []
  /** 有新的 ring / ring_end 就叫一声(等电话那一段靠它)。 */
  let onRing: (() => void) | undefined

  room.registerTextStreamHandler(RPC_TOPIC, (reader, from) => {
    textQueue = textQueue.then(async () => {
      /**
       * **只认工人那个身份的回包**(2026-09-21)。真手机一直是这么做的
       * (butler-app/src/channel/rpc.ts 的第一条规矩),假手机以前没做 ——
       * 于是房里进来第二台电脑时,它那句回答会被当成答复。这条补上,两边才是同一个行为。
       */
      if (from?.identity !== undefined && from.identity !== WORKER_IDENTITY) return
      const text = await reader.readAll()
      let message: Record<string, unknown>
      try { message = JSON.parse(text) as Record<string, unknown> }
      catch { log(`wb.rpc 收到读不懂的一条:${text.slice(0, 120)}`); return }
      if (message.type === 'caption') {
        log(`字幕 [${String(message.role)}${message.final === true ? '' : '…'}] ${String(message.text)}`)
        // 她那条字幕 = 她的真声要来了(工人在「这一句开始出声」那一刻推)。真手机同法。
        if (message.role === 'butler') filler?.butlerSpoke()
        else filler?.userSpoke()
        // 逐字留一份对话记录:交接里那段「她说了什么」直接从这里抄,不靠回忆。
        if (message.final === true) {
          transcript.push({ at: Date.now(), role: String(message.role), text: String(message.text) })
          if (message.role === 'butler') lastButlerAt = Date.now()
        }
        if (message.role === 'butler' && firstCaptionAt === undefined) {
          firstCaptionAt = Date.now()
          mark('看见事务官的第一条字幕')
        }
        return
      }
      if (message.type === 'ring') {
        const line = `${String(message.reason)} · ${String(message.title)}`
        mark(`☎️ 座机响了:${line}(call ${String(message.call_id)}${message.silent === true ? ',夜间静默 —— 只该发通知' : ''})`)
        rings.push({ callId: String(message.call_id), at: Date.now(), reason: String(message.reason), title: String(message.title), silent: message.silent === true, itemId: String(message.item_id) })
        onRing?.()
        return
      }
      if (message.type === 'ring_end') {
        mark(`☎️ 这一通完了:${String(message.outcome)}${message.text === undefined ? '' : `(${String(message.text)})`}`)
        ringEnds.push({ callId: String(message.call_id), outcome: String(message.outcome), at: Date.now() })
        onRing?.()
        return
      }
      if (message.type === 'filler') {
        // 慢工具跑完(2026-09-24 傍晚):手机拿它管球的执行中样子,不垫话 —— 只记一行。
        if (message.kind === 'tool_done') {
          log(`[缓冲语] 收到信号:tool_done(${String(message.tool)})第 ${String(message.round)} 轮`)
          return
        }
        lastSignalAt = Date.now()
        log(`[缓冲语] 收到信号:${String(message.kind)}${message.tool === undefined ? '' : `(${String(message.tool)})`} 第 ${String(message.round)} 轮`)
        fillerRuns.push({ text: '(还没放)', signalAt: lastSignalAt, playedAt: 0, ms: 0 })
        filler?.signal({
          kind: message.kind as 'thinking' | 'tool',
          round: Number(message.round),
          ...(typeof message.tool === 'string' ? { tool: message.tool } : {}),
        })
        return
      }
      const id = typeof message.id === 'string' ? message.id : ''
      const resolve = pending.get(id)
      if (resolve === undefined) { log(`wb.rpc 收到一条没人等的回包:${text.slice(0, 120)}`); return }
      pending.delete(id)
      resolve(message)
    })
  })

  /** 发一条 wb.rpc 并等它的回包(10 秒等不到就算没回)。 */
  async function rpc(request: Record<string, unknown>): Promise<Record<string, unknown>> {
    const id = randomUUID()
    const waited = new Promise<Record<string, unknown>>((resolve, reject) => {
      pending.set(id, resolve)
      setTimeout(() => { if (pending.delete(id)) reject(new Error('10 秒没回')) }, 10_000)
    })
    await room.localParticipant?.sendText(JSON.stringify({ id, ...request }), { topic: RPC_TOPIC })
    return waited
  }

  /**
   * ——— 缓冲语(2026-09-20,Ben:「缓冲语可以存到手机里啊」) ———
   *
   * 跑的是**手机上那一份**状态机(`butler-app/src/call/fillerAudio.ts`),不是复制品 ——
   * 量出来的时序才算数。它是**动态** import 的,两个理由:
   *   ① 那份文件属于另一个包,写成静态 import 会把它拖进 channel-worker 的 tsc
   *      (两边的 lib 与严格选项都不一样,迟早互相绊住);
   *   ② 没有 butler-app 那份源码时这台假手机照样跑得起来 —— 只是不垫。
   *
   * 「放音频」这一头是假的:真手机放 `<audio>`,这里按 `public/filler/manifest.json` 里
   * 那一句**真实的时长**起一根计时器。掐掉时就地记下「放到第几毫秒被掐的」。
   */
  interface FillerLineLite { id: string, kind: string, tool?: string, text: string }
  interface FillerMachine {
    signal: (s: { kind: 'thinking' | 'tool', tool?: string, round: number }) => void
    butlerSpoke: () => void
    setRemoteSpeaking: (speaking: boolean) => void
    userSpoke: () => void
    dispose: () => void
  }
  const fillerOn = !process.argv.includes('--no-filler')
  /** 每一次垫:信号什么时候来的、几毫秒之后放的、放了多久被掐的(没被掐就是 undefined)。 */
  const fillerRuns: { text: string, signalAt: number, playedAt: number, cutAfterMs?: number, ms: number }[] = []
  let lastSignalAt: number | undefined
  let filler: FillerMachine | undefined
  if (fillerOn) {
    const appDir = resolvePath(dirname(fileURLToPath(import.meta.url)), '../../butler-app')
    try {
      const mod = await import(new URL('src/call/fillerAudio.ts', `file://${appDir}/`).href) as {
        createFillerAudio: (deps: Record<string, unknown>) => FillerMachine
        FILLER_WAIT_MS: number
      }
      const manifest = JSON.parse(await readFile(resolvePath(appDir, 'public/filler/manifest.json'), 'utf8')) as {
        lines: { id: string, ms: number }[]
      }
      const msOf = (id: string): number => manifest.lines.find(line => line.id === id)?.ms ?? 1000
      let playing: { at: number, ms: number, timer: ReturnType<typeof setTimeout>, done: () => void } | undefined
      filler = mod.createFillerAudio({
        play: (line: FillerLineLite) => new Promise<void>((done) => {
          const ms = msOf(line.id)
          const at = Date.now()
          const run = fillerRuns[fillerRuns.length - 1]
          if (run !== undefined && run.playedAt === 0) { run.playedAt = at; run.ms = ms; run.text = line.text }
          log(`[缓冲语] 本地放:「${line.text}」(${line.id},${ms}ms;信号到这一下 ${lastSignalAt === undefined ? '?' : at - lastSignalAt}ms)`)
          playing = { at, ms, timer: setTimeout(() => { playing = undefined; log(`[缓冲语] 「${line.text}」放完了`); done() }, ms), done }
        }),
        stop: () => {
          if (playing === undefined) return
          const played = Date.now() - playing.at
          const run = fillerRuns[fillerRuns.length - 1]
          if (run !== undefined) run.cutAfterMs = played
          clearTimeout(playing.timer)
          log(`[缓冲语] **掐掉**:放到第 ${played}ms(整句 ${playing.ms}ms)就让位给她的真声`)
          const finish = playing.done
          playing = undefined
          finish()
        },
        onPlayed: (line: FillerLineLite) => { log(`字幕 [butler·本地] ${line.text}`) },
        onSkipped: (reason: string) => { log(`[缓冲语] 这一条没垫:${reason}`) },
      })
      log(`[缓冲语] 上了手机那一份逻辑(等 ${mod.FILLER_WAIT_MS}ms,${manifest.lines.length} 句在包里)`)
    }
    catch (err) {
      log(`[缓冲语] 没上(${(err as Error).message}) —— 这一遍不垫,别的照跑`)
    }
  }

  /**
   * 「我说完了」那一刻。回复的延迟只算这之后的音频 —— 进房时那句开场白也是音频,
   * 不排除掉的话算出来的是个负数(2026-09-17 第一次跑就是这样)。
   */
  /** 逐字对话记录(final 字幕),跑完整段打出来。 */
  const transcript: { at: number, role: string, text: string }[] = []
  /** 她最后一条字幕的时刻 —— 「这一轮说完了没有」就看它。 */
  let lastButlerAt: number | undefined
  let spokeAt: number | undefined
  let firstAudioAt: number | undefined
  /** 引导那两个数字:她开口的第一帧、第一条字幕(不是回答我的,是她主动说的开场白)。 */
  let firstSeedAudioAt: number | undefined
  let firstCaptionAt: number | undefined
  let joinedAt: number | undefined
  /** 最后一帧「有声音」的回话。打断生不生效就看它在打断之后多久停下来。 */
  let lastReplyFrameAt: number | undefined
  room.on(RoomEvent.TrackSubscribed, (track, _pub, participant) => {
    if (track.kind !== TrackKind.KIND_AUDIO) return
    log(`订到 ${participant.identity} 的音频轨`)
    void (async () => {
      // AudioStream 把远端轨解成一帧帧 PCM。这里只为找「第一帧不是静音的音频」那一刻。
      // 连着几帧都有声才算「她开口了」:单独一帧响可能只是链路上的一个咔哒声,
      // 拿它当「听见第一个字」会把数字报得比真的好看(2026-09-18 实测踩到过)。
      let loudRun = 0
      for await (const frame of new AudioStream(track)) {
        // 全静音的帧不算「她开口了」——房间接通后会先有一串静音。
        const loud = frame.data.some((sample: number) => Math.abs(sample) > 600)
        if (!loud && loudRun >= 5) { log(`[声音] 这一段有声音的音频结束了(${loudRun} 帧)`); filler?.setRemoteSpeaking(false) }
        loudRun = loud ? loudRun + 1 : 0
        if (loudRun === 5) {
          log(`[声音] 一段有声音的音频开始了(峰值 ${Math.max(...[...frame.data].map(v => Math.abs(v)))})`)
          // 真手机那一路是 ActiveSpeakersChanged;这里直接看帧能量,语义一样:她真的在出声。
          filler?.setRemoteSpeaking(true)
        }
        if (loudRun < 5) continue
        if (spokeAt === undefined) {
          // 还没轮到我说话 —— 这是她主动说的(平时是欢迎语,引导里是种子句/开场白)。
          if (firstSeedAudioAt === undefined) {
            firstSeedAudioAt = Date.now()
            mark('听见她开口的第一个字(开场白)')
          }
          continue
        }
        lastReplyFrameAt = Date.now()
        if (firstAudioAt === undefined) {
          firstAudioAt = Date.now()
          mark('听见事务官回话的第一个字')
        }
      }
    })()
  })

  room.on(RoomEvent.ParticipantConnected, p => log(`${p.identity} 进来了`))
  room.on(RoomEvent.Disconnected, () => log('断开了'))

  /**
   * ——— 设备之间那条通道 `wb.dev`(2026-09-21) ———
   * 假手机用它验三样:房里有哪些设备、让某台电脑找文件、让它把找到的发过来。
   */
  const devPending = new Map<string, (value: unknown) => void>()
  room.registerTextStreamHandler(DEV_TOPIC, (reader) => {
    void (async () => {
      const text = await reader.readAll().catch(() => '')
      const parsed = parseDevResponse(text)
      if (parsed === undefined) { log(`wb.dev 上来一条读不懂的:${text.slice(0, 120)}`); return }
      const resolve = devPending.get(parsed.id)
      if (resolve === undefined) { log(`wb.dev 回包没人等:${text.slice(0, 120)}`); return }
      devPending.delete(parsed.id)
      resolve(parsed)
    })()
  })

  /** 往某台设备发一条 wb.dev,等它的回包(最多 20 秒)。 */
  async function dev(to: string, payload: Record<string, unknown>): Promise<Record<string, unknown>> {
    const id = randomUUID()
    const wait = new Promise<Record<string, unknown>>((resolve, reject) => {
      devPending.set(id, value => resolve(value as Record<string, unknown>))
      setTimeout(() => { devPending.delete(id); reject(new Error('wb.dev 等超时了')) }, 20000)
    })
    await room.localParticipant?.sendText(JSON.stringify({ id, ...payload }), {
      topic: DEV_TOPIC,
      destinationIdentities: [to],
    })
    return await wait
  }

  // 收文件:落到当前目录,名字前面加个前缀免得覆盖别人的。
  room.registerByteStreamHandler(FILE_TOPIC, (reader, participant) => {
    void (async () => {
      const chunks = await reader.readAll()
      const data = Buffer.concat(chunks.map(c => Buffer.from(c)))
      const name = `收到-${reader.info.name ?? '文件'}`
      await writeFile(name, data)
      mark(`收到电脑发来的文件:${name}(${data.length} 字节,来自 ${participant.identity})`)
    })()
  })

  await room.connect(ticket.url as string, ticket.token, { autoSubscribe: true, dynacast: true })
  joinedAt = Date.now()
  mark(`进房了。房里:${[...room.remoteParticipants.values()].map(p => p.identity).join('、') || '还没有别人'}`)

  // ——— 引导模式(2026-09-18):进房就说一句「我在做引导」,工人据此换提示并立刻开口 ———
  if (onboardingAction !== undefined) {
    try {
      const begun = await rpc({ type: 'onboarding', action: onboardingAction })
      mark(`引导 ${onboardingAction} → ${begun.ok === true ? `接上了(${String(begun.stage)})` : `没接上:${String(begun.error)}`}`)
    }
    catch (err) { mark(`引导那条没成:${(err as Error).message}`) }
  }
  else if (incomingMode !== undefined) {
    // 座机是**被打**的那一头:不发招呼、不走房间代理,就待在房里等铃(见文件头那一段)。
    mark(`座机模式(${incomingMode}):在房里等电话,最多等 ${Math.round(ringWaitMs / 1000)} 秒`)
  }
  else {
    /**
     * 普通通话的招呼(2026-09-18):工人**不再**一进房就说,改由打电话的这一头点名要。
     * 真手机在 butler-app/src/call/livekitCall.ts 里发的是同一条。
     */
    try {
      const greeted = await rpc({ type: 'call', action: 'start' })
      mark(`招呼 → ${greeted.ok === true ? '她开口了' : `没说成:${String(greeted.error)}`}`)
    }
    catch (err) { mark(`招呼那条没成:${(err as Error).message}`) }
  }

  // ——— 三条房间代理的用例,不需要麦克风也不需要 DeepSeek key ———
  if (onboardingAction === undefined && incomingMode === undefined) {
  mark('开始走房间代理')
  try {
    const state = await rpc({ type: 'http', method: 'GET', path: '/state' })
    const tasks = ((state.body as { tasks?: { tasks?: unknown[] } })?.tasks?.tasks ?? []).length
    mark(`GET /state → ${String(state.status)}(看板上 ${tasks} 条事项)`)
  }
  catch (err) { mark(`GET /state 没成:${(err as Error).message}`) }

  try {
    const denied = await rpc({ type: 'http', method: 'POST', path: '/pair/start' })
    mark(`POST /pair/start(不在白名单)→ ${String(denied.status)}:${JSON.stringify(denied.body)}`)
  }
  catch (err) { mark(`白名单那条没成:${(err as Error).message}`) }

  try {
    const renewed = await rpc({ type: 'renew' })
    const token = typeof renewed.token === 'string' ? renewed.token : ''
    mark(`renew → ${String(renewed.type)},新凭证 ${token === '' ? '没拿到' : `${token.length} 字符`},到期 ${String(renewed.expires_at)}`)
  }
  catch (err) { mark(`renew 没成:${(err as Error).message}`) }
  }

  /**
   * ——— 照本子聊一段(2026-09-20) ———
   *
   * 一句一句发,每一句之前等她这一轮说完(连着 quietMs 没有新字幕),最长等 turnMs。
   * 跑完把整段对话按时间顺序打出来 —— 交接里那张「五条对照表」就照它一条条对。
   */
  async function runScript(file: string): Promise<void> {
    const lines = (await readFile(file, 'utf8')).split('\n')
      .map(line => line.trim())
      .filter(line => line !== '' && !line.startsWith('#'))
    mark(`本子有 ${lines.length} 句`)
    await waitQuiet('开场白')
    for (const [index, line] of lines.entries()) {
      log(`我说(第 ${index + 1} 句):${line}`)
      transcript.push({ at: Date.now(), role: 'me(本子)', text: line })
      try {
        const said = await rpc({ type: 'onboarding', action: 'say', text: line })
        if (said.ok !== true) { mark(`第 ${index + 1} 句没送进去:${String(said.error)}`); break }
      }
      catch (err) { mark(`第 ${index + 1} 句没送进去:${(err as Error).message}`); break }
      await waitQuiet(`第 ${index + 1} 轮`)
    }
  }

  /** 等她这一轮说完:连着 quietMs 没有新字幕就算完;最长等 turnMs。 */
  async function waitQuiet(what: string): Promise<void> {
    const started = Date.now()
    lastButlerAt = undefined
    while (Date.now() - started < turnMs) {
      await new Promise(resolve => setTimeout(resolve, 200))
      if (lastButlerAt !== undefined && Date.now() - lastButlerAt >= quietMs) return
    }
    mark(`${what} 等了 ${turnMs}ms 她还没说完(或者一个字都没说)`)
  }

  /** 整段对话,按时间顺序,一行一句。 */
  function printTranscript(): void {
    if (transcript.length === 0) return
    console.log('\n———— 对话逐字 ————')
    const base = transcript[0]?.at ?? Date.now()
    for (const turn of transcript) {
      console.log(`+${String(turn.at - base).padStart(7)}ms  [${turn.role}] ${turn.text}`)
    }
  }

  /**
   * ——— 座机:等电话、接起、说一句「批准」(2026-09-21) ———
   *
   * 这一段跑的正是卡上那条端到端:模拟一条「等确认」→ 工人发 ring → 假手机接起
   * → 对话里说「批准」→ 事项状态变了。**每一步的时刻都记下来**,交接里那张表照它抄。
   */
  async function runIncoming(): Promise<void> {
    const waitedUntil = Date.now() + ringWaitMs
    // 等第一通电话。onRing 一叫就醒,不靠轮询数数。
    while (rings.length === 0 && Date.now() < waitedUntil) {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, 500)
        onRing = () => { clearTimeout(timer); onRing = undefined; resolve() }
      })
    }
    const call = rings[0]
    if (call === undefined) { mark(`等了 ${Math.round(ringWaitMs / 1000)} 秒,一通电话都没打进来`); return }
    if (call.silent) { mark('这一通带 silent —— 真手机只会发一条通知,不响铃、不弹来电页'); return }
    if (incomingMode === 'wait') {
      // 只响不接:验「60 秒没人接 → 未接来电」。等工人那条 ring_end。
      const until = Date.now() + ringWaitMs
      while (ringEnds.length === 0 && Date.now() < until) await new Promise(r => setTimeout(r, 500))
      return
    }
    const answeredAt = Date.now()
    try {
      const said = await rpc({ type: 'call', action: 'answer', call_id: call.callId })
      mark(`接起 → ${said.ok === true ? '她开口了' : `没接上:${String(said.error)}`}(从响到接 ${answeredAt - call.at}ms)`)
      if (said.ok !== true) return
    }
    catch (err) { mark(`接起那条没成:${(err as Error).message}`); return }

    // 等她把开场那一句说出来(「我打给你是因为…」),最多 20 秒。
    const until = Date.now() + 20_000
    while (firstSeedAudioAt === undefined && Date.now() < until) await new Promise(r => setTimeout(r, 20))
    if (firstSeedAudioAt !== undefined) mark(`接起 → 听见她的第一个字 ${firstSeedAudioAt - answeredAt}ms`)
  }

  if (incomingMode !== undefined) {
    await runIncoming()
    // 有录音就在接起之后放出去(比如一句「批准」),走下面那条正常的放音路径;
    // 没有就到此为止,把时间线打出来。
    if (wavPath === undefined) {
      await new Promise(resolve => setTimeout(resolve, 3000))
      printTranscript()
      report()
      await room.disconnect()
      process.exit(0)
    }
  }

  if (scriptPath !== undefined) {
    await runScript(scriptPath)
    try { await rpc({ type: 'onboarding', action: 'stop' }); mark('挂断(引导暂停)') }
    catch (err) { mark(`挂断那条没成:${(err as Error).message}`) }
    printTranscript()
    report()
    await room.disconnect()
    process.exit(0)
  }

  if (wavPath === undefined) {
    if (onboardingAction !== undefined) {
      // 引导:等她把开场白说出来(最多 20 秒),然后如实报两个数字。
      const until = Date.now() + 20000
      while (firstSeedAudioAt === undefined && Date.now() < until) await new Promise(r => setTimeout(r, 20))
      await new Promise(r => setTimeout(r, 2000))
      try { await rpc({ type: 'onboarding', action: 'stop' }); mark('挂断(引导暂停)') }
      catch (err) { mark(`挂断那条没成:${(err as Error).message}`) }
      report()
      await room.disconnect()
      process.exit(0)
    }
    // 没有音频也把文件那一条走一遍(topic 从原型的 wb-file 改成了 wb.file,得验)。
    if (sendPath !== undefined) {
      mark(`开始发文件:${basename(sendPath)}${sendTo === undefined ? '(发给房里所有人)' : `(只发给 ${sendTo})`}`)
      await room.localParticipant?.sendFile(sendPath, {
        topic: FILE_TOPIC,
        name: basename(sendPath),
        ...(sendTo === undefined ? {} : { destinationIdentities: [sendTo] }),
      })
      mark('文件发完了')
    }

    /**
     * ——— 设备间传文件那三样(2026-09-21)———
     *   --dev-devices <工人 identity>            问一份在线设备表
     *   --dev-search  <工人 identity> <词>       让那台电脑找文件
     *   --dev-send    <工人 identity> <收件 identity>  把上一次搜到的第一个发过去
     */
    const devPeer = arg('dev-peer')
    if (devPeer !== undefined) {
      try {
        const devices = await dev(devPeer, { type: 'devices' })
        mark(`房里的设备表:${JSON.stringify(devices.devices)}`)
      }
      catch (err) { mark(`问设备表没成:${(err as Error).message}`) }
      const query = arg('dev-search')
      let firstPath: string | undefined
      if (query !== undefined) {
        try {
          const found = await dev(devPeer, { type: 'search', query })
          const files = (found.files ?? []) as { path?: string, name?: string }[]
          firstPath = files[0]?.path
          mark(`${devPeer} 找「${query}」:${files.length} 个${found.note === undefined ? '' : `(${String(found.note)})`} ${files.map(f => f.name).join('、')}`)
        }
        catch (err) { mark(`找文件没成:${(err as Error).message}`) }
      }
      // **先验一遍白名单**:一条没搜到过的路径,那台机器该拒。
      try {
        const denied = await dev(devPeer, { type: 'send', path: '/Users/example/.ssh/id_rsa', to: ticket.identity as string })
        mark(`没搜到过的路径去传:${denied.ok === true ? '⚠️ 居然传了' : `被拒了 —— ${String(denied.error)}`}`)
      }
      catch (err) { mark(`白名单那一条没验成:${(err as Error).message}`) }
      if (firstPath !== undefined) {
        const target = arg('dev-send') ?? (ticket.identity as string)
        try {
          const sent = await dev(devPeer, { type: 'send', path: firstPath, to: target })
          mark(`让 ${devPeer} 把「${firstPath}」发给 ${target}:${sent.ok === true ? `发了(${String(sent.name)})` : `没成 —— ${String(sent.error)}`}`)
        }
        catch (err) { mark(`让它发文件没成:${(err as Error).message}`) }
      }
      // 给文件流一点时间落地。
      await new Promise(resolve => setTimeout(resolve, 3000))
    }
    log('没给 --wav,不放音频;再等 5 秒看有没有字幕/文件,然后走。')
    await new Promise(resolve => setTimeout(resolve, 5000))
    console.log('\n———— 时间线 ————')
    const base0 = marks[0]?.at ?? Date.now()
    for (const item of marks) console.log(`+${String(item.at - base0).padStart(6)}ms  ${item.label}`)
    await room.disconnect()
    process.exit(0)
  }

  // ——— 把 WAV 当麦克风放出去 ———
  const { pcm, sampleRate, channels } = pcmOfWav(await readFile(wavPath))
  const source = new AudioSource(sampleRate, channels)
  const track = LocalAudioTrack.createAudioTrack('mic', source)
  const options = new TrackPublishOptions()
  options.source = TrackSource.SOURCE_MICROPHONE
  await room.localParticipant?.publishTrack(track, options)
  log(`麦克风上了:${wavPath}(${sampleRate}Hz × ${channels},${(pcm.length / 2 / channels / sampleRate).toFixed(2)} 秒)`)

  // 进房之后先静一会:工人要先说完那句开场白,不然一开口就把它打断了。
  // 引导模式下等到她真的把开场白说出来再等两秒(否则答话会把开场白打断,量不到一问一答)。
  if (onboardingAction !== undefined) {
    const until = Date.now() + 20000
    while (firstSeedAudioAt === undefined && Date.now() < until) await new Promise(r => setTimeout(r, 20))
    await new Promise(resolve => setTimeout(resolve, 6000))
  }
  else if (incomingMode !== undefined) {
    // 座机:上面 runIncoming 已经等到她开口了,这里只再让她把那一句说完。
    await new Promise(resolve => setTimeout(resolve, 6000))
  }
  else {
    await new Promise(resolve => setTimeout(resolve, 3000))
  }

  const samplesPerFrame = Math.round(sampleRate / 100) // 10ms 一帧
  const bytesPerFrame = samplesPerFrame * 2 * channels
  const silence = new Int16Array(samplesPerFrame * channels)

  /** 把那段 WAV 当麦克风放一遍。`silenceFrames` 是放完之后补多少帧静音(VAD 靠它判「说完了」)。 */
  async function speak(silenceFrames: number): Promise<void> {
    for (let offset = 0; offset < pcm.length; offset += bytesPerFrame) {
      const slice = pcm.subarray(offset, offset + bytesPerFrame)
      const samples = new Int16Array(slice.length / 2)
      for (let i = 0; i < samples.length; i += 1) samples[i] = slice.readInt16LE(i * 2)
      await source.captureFrame(new AudioFrame(samples, sampleRate, channels, samples.length / channels))
    }
    for (let i = 0; i < silenceFrames; i += 1) {
      await source.captureFrame(new AudioFrame(silence, sampleRate, channels, samplesPerFrame))
    }
  }

  mark('开始放这段话')
  await speak(100)
  spokeAt = Date.now()
  mark('这段话放完了(静音开始)')

  if (sendPath !== undefined) {
    mark(`开始发文件:${basename(sendPath)}`)
    // 名字要自己给,rtc-node 不从路径推(不给就叫 unknown)。
    await room.localParticipant?.sendFile(sendPath, { topic: FILE_TOPIC, name: basename(sendPath) })
    mark('文件发完了')
  }

  // ——— 打断:她一开口就抢过去说 ———
  if (arg('interrupt') !== undefined) {
    // 等她真的开口(最多 15 秒)。没开口就没得打断,如实说。
    const until = Date.now() + 15000
    while (firstAudioAt === undefined && Date.now() < until) await new Promise(r => setTimeout(r, 50))
    if (firstAudioAt === undefined) {
      mark('她一直没开口,打断这条没验成')
    }
    else {
      const interruptedAt = Date.now()
      mark('她正在说,我插话')
      // 只放半秒就够:打断靠的是 VAD 听见有人开口,不是听懂说了什么。
      await speak(0)
      // 再等两秒看她停了没有。
      await new Promise(r => setTimeout(r, 2000))
      const stopped = lastReplyFrameAt !== undefined ? lastReplyFrameAt - interruptedAt : undefined
      mark(stopped === undefined ? '插话之后她一帧都没再发' : `插话之后她还说了 ${stopped}ms 就停了`)
    }
  }

  // 留 20 秒听回复与收文件。
  await new Promise(resolve => setTimeout(resolve, 20000))

  if (onboardingAction !== undefined) {
    try { await rpc({ type: 'onboarding', action: 'stop' }); mark('挂断(引导暂停)') }
    catch (err) { mark(`挂断那条没成:${(err as Error).message}`) }
  }

  filler?.dispose()
  report()
  await room.disconnect()
  process.exit(0)

  /** 时间线 + 三个数字。拿不到的那个**就说没有**,不编。 */
  function report(): void {
    console.log('\n———— 时间线 ————')
    const base = marks[0]?.at ?? Date.now()
    for (const item of marks) console.log(`+${String(item.at - base).padStart(6)}ms  ${item.label}`)
    if (joinedAt !== undefined && firstSeedAudioAt !== undefined) {
      console.log(`\n进房 → 听见她开口第一个字:${firstSeedAudioAt - joinedAt}ms`)
    }
    if (firstSeedAudioAt !== undefined && firstCaptionAt !== undefined) {
      const gap = firstCaptionAt - firstSeedAudioAt
      console.log(`字幕比声音${gap >= 0 ? '晚' : '早'} ${Math.abs(gap)}ms`)
    }
    if (spokeAt !== undefined && firstAudioAt !== undefined) {
      console.log(`端到端(说完 → 听见回话第一个字):${firstAudioAt - spokeAt}ms`)
    }
    else if (wavPath !== undefined) {
      console.log('端到端:没听见回复,这个数字**没有**。')
    }
    if (fillerOn) {
      if (fillerRuns.length === 0) console.log('缓冲语:一条信号都没来,这几个数字**没有**。')
      else {
        console.log('\n———— 缓冲语 ————')
        for (const run of fillerRuns) {
          if (run.playedAt === 0) { console.log(`  「${run.text}」信号来了但没放(她在 700ms 之内就出声了,这是好事)`); continue }
          const wait = run.playedAt - run.signalAt
          const cut = run.cutAfterMs === undefined
            ? `放完了(${run.ms}ms)`
            : `放到第 ${run.cutAfterMs}ms 被她的真声掐掉(整句 ${run.ms}ms)`
          console.log(`  「${run.text}」信号 → 本地播放 ${wait}ms;${cut}`)
        }
      }
    }
  }
}

void main().catch((err: unknown) => {
  console.error(`假手机起不来:${(err as Error)?.message ?? String(err)}`)
  process.exit(1)
})
