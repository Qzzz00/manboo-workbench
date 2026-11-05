/**
 * 「出了局域网也能按住说话」端到端(2026-09-25,卡 S `fix/phone-voice-anywhere`)。
 * **一条命令跑完,不碰真机、不碰 ~/.dsh、不发任何真的识别请求。**
 *
 * 它自己起一整套灰度的东西(全在一个 mkdtemp 目录里,`--dir` 指定父目录,缺省系统临时目录):
 *   - livekit-server(本机回环,随机一对 key/secret —— 那就是「中继房间」);
 *   - 灰度工作台 = workbench-plugin/scripts/channel-dev-server.ts `--butler-port`:`/butler/proxy/*` 接到下面那台假 8792,
 *     设备令牌、降权(X-Workbench-Channel-Device)那几道门都是真的;
 *   - 假 8792 = dev/fake-butler.ts:`/api/asr` 回一句定死的话,记下收到的字节数与类型(`--asr-delay-ms` 模拟识别本身的耗时);
 *   - 假接话模型 dev/stub-llm.mjs(工人起来要它,这里用不上);
 *   - 工人 src/main.ts(HOME 指到临时目录)—— 识别代转那一段(asrRelay.ts、rpc.ts 的分发、agent.ts 的接线)全是真的。
 * 两台假手机,用手机 App 的同一套协议(与 butler-app/src/channel 逐字对齐):
 *   - **在家的手机**:HTTP 直连灰度工作台(带设备令牌),`POST /butler/proxy/api/asr` 裸 WAV —— 局域网那条的基线;
 *   - **在外面的手机**:除了配对与领凭证,一条 HTTP 都不直连 —— `wb.rpc` 上 `{id, type:'asr'}`,同时 `wb.asr` 字节流
 *     (只发工人,属性 `wb_asr_id = id`),等那条 `type:'http'` 回来。
 * 量的是「开始发」到「字回来」。1 秒 / 5 秒 / 20 秒的录音各几遍,外加:21 秒被拒(413)、没配对的设备被拒、
 * 录音不到(只发宣告不发字节流 → 408,等的是工人那边的上限)。
 *
 * 用法(在 channel-worker/ 里):
 *   node dev/asr-relay-e2e.ts [--dir <父目录>] [--rounds 5] [--asr-delay-ms 0] [--lk-port 7960] [--wb-port 8851] [--llm-port 8852] [--butler-port 8853]
 * 退出码:全部通过 0,否则 1。跑完不删那个目录(留着看日志);要清就自己把那一个目录挪进废纸篓。
 */
import { type ChildProcess, spawn } from 'node:child_process'
import { randomBytes, randomUUID } from 'node:crypto'
import { createWriteStream, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { performance } from 'node:perf_hooks'
import { fileURLToPath } from 'node:url'
import { Room } from '@livekit/rtc-node'

const HERE = dirname(fileURLToPath(import.meta.url))
const WORKER_DIR = resolve(HERE, '..')
const PLUGIN_DIR = resolve(HERE, '../../workbench-plugin')

function arg(name: string, fallback: string): string {
  const index = process.argv.indexOf(`--${name}`)
  return index >= 0 ? (process.argv[index + 1] ?? fallback) : fallback
}

const LK_PORT = Number(arg('lk-port', '7960'))
const WB_PORT = Number(arg('wb-port', '8851'))
const LLM_PORT = Number(arg('llm-port', '8852'))
const BUTLER_PORT = Number(arg('butler-port', '8853'))
const ROUNDS = Number(arg('rounds', '5'))
const ASR_DELAY_MS = Number(arg('asr-delay-ms', '0'))
const WORKER_ID = 'wb-channel-worker'

const sleep = (ms: number): Promise<void> => new Promise(done => setTimeout(done, ms))
function stamp(): string { const now = new Date(); return `${now.toTimeString().slice(0, 8)}.${String(now.getMilliseconds()).padStart(3, '0')}` }
function log(line: string): void { console.log(`${stamp()}  ${line}`) }

/** 一段 16k / 16 位 / 单声道的 WAV(轻正弦,不是静音:更像一段真录音的字节)。 */
function wav(seconds: number): Buffer {
  const samples = Math.round(16000 * seconds)
  const buf = Buffer.alloc(44 + samples * 2)
  buf.write('RIFF', 0, 'ascii'); buf.writeUInt32LE(36 + samples * 2, 4); buf.write('WAVE', 8, 'ascii')
  buf.write('fmt ', 12, 'ascii'); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(1, 22)
  buf.writeUInt32LE(16000, 24); buf.writeUInt32LE(32000, 28); buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34)
  buf.write('data', 36, 'ascii'); buf.writeUInt32LE(samples * 2, 40)
  for (let i = 0; i < samples; i += 1) buf.writeInt16LE(Math.round(Math.sin((2 * Math.PI * 220 * i) / 16000) * 3000 + (Math.random() - 0.5) * 800), 44 + i * 2)
  return buf
}

const children: { name: string, child: ChildProcess }[] = []
function start(name: string, cmd: string, args: string[], options: { cwd: string, env: Record<string, string>, logFile: string }): void {
  const out = createWriteStream(options.logFile)
  const child = spawn(cmd, args, { cwd: options.cwd, env: { ...process.env, ...options.env }, stdio: ['ignore', 'pipe', 'pipe'] })
  child.stdout?.pipe(out)
  child.stderr?.pipe(out)
  children.push({ name, child })
  log(`起了 ${name}(pid ${child.pid ?? '?'},日志 ${options.logFile})`)
}
async function stopAll(): Promise<void> {
  for (const { name, child } of children.reverse()) {
    if (child.exitCode !== null || child.pid === undefined) continue
    child.kill('SIGTERM')
    const died = await Promise.race([new Promise<boolean>(done => child.once('exit', () => done(true))), sleep(4000).then(() => false)])
    if (!died) child.kill('SIGKILL')
    log(`停了 ${name}`)
  }
}
async function waitFor<T>(label: string, fn: () => Promise<T | undefined> | T | undefined, timeoutMs = 30_000, everyMs = 250): Promise<T> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try { const got = await fn(); if (got !== undefined && got !== false) return got as T }
    catch { /* 再等 */ }
    await sleep(everyMs)
  }
  throw new Error(`等「${label}」等了 ${Math.round(timeoutMs / 1000)} 秒没等到`)
}

class Phone {
  readonly room = new Room()
  token = ''
  deviceId = ''
  private readonly pending = new Map<string, (message: Record<string, unknown>) => void>()
  readonly label: string
  readonly base: string
  constructor(label: string, base: string) { this.label = label; this.base = base }

  async pair(): Promise<void> {
    const started = await fetch(`${this.base}/pair/start`, { method: 'POST' })
    const code = ((await started.json()) as { pairing?: { code?: string } }).pairing?.code ?? ''
    const claimed = await fetch(`${this.base}/pair/claim`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code, device_name: this.label, platform: 'android' }) })
    const body = await claimed.json() as { device_id?: string, token?: string, error?: string }
    if (body.token === undefined || body.device_id === undefined) throw new Error(`配对没成:${body.error ?? claimed.status}`)
    this.token = body.token
    this.deviceId = body.device_id
  }

  /** 在家:HTTP 直连,与手机 App 的 api/voice.ts 同一个样子(裸 WAV + 设备令牌)。 */
  async asrDirect(bytes: Buffer): Promise<{ ms: number, status: number, body: Record<string, unknown> }> {
    const t0 = performance.now()
    const res = await fetch(`${this.base}/butler/proxy/api/asr`, { method: 'POST', headers: { authorization: `Bearer ${this.token}`, 'content-type': 'audio/wav' }, body: new Uint8Array(bytes) })
    const body = await res.json() as Record<string, unknown>
    return { ms: performance.now() - t0, status: res.status, body }
  }

  /** 在外面:进房(凭证从回环要、带降权头 —— 真机上是从中转领的,两条拿到的凭证一个形状)。 */
  async join(identitySuffix?: string): Promise<void> {
    const res = await fetch(`${this.base}/channel/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${this.token}`, 'x-workbench-channel-device': this.deviceId },
      body: JSON.stringify({ name: this.label, ...(identitySuffix === undefined ? {} : { suffix: identitySuffix }) }),
    })
    const ticket = await res.json() as { url?: string, token?: string, error?: string }
    if (ticket.url === undefined || ticket.token === undefined) throw new Error(`领不到进房凭证:${ticket.error ?? res.status}`)
    this.room.registerTextStreamHandler('wb.rpc', (reader, from) => {
      void reader.readAll().then((text) => {
        if (from.identity !== WORKER_ID) return
        let message: Record<string, unknown>
        try { message = JSON.parse(text) as Record<string, unknown> } catch { return }
        const resolveIt = this.pending.get(String(message.id ?? ''))
        if (resolveIt !== undefined) { this.pending.delete(String(message.id)); resolveIt(message) }
      })
    })
    await this.room.connect(ticket.url, ticket.token, { autoSubscribe: false, dynacast: false })
  }

  private answer(id: string, timeoutMs: number): Promise<Record<string, unknown>> {
    return new Promise((done, fail) => {
      this.pending.set(id, done)
      setTimeout(() => { if (this.pending.delete(id)) fail(new Error(`识别那一条 ${timeoutMs}ms 没回`)) }, timeoutMs)
    })
  }

  /** 在外面按住说话:`{id, type:'asr'}` 与 `wb.asr` 字节流一起发(与 butler-app 的 rpc.asr 一样),等那条 `type:'http'`。 */
  async asrRoom(bytes: Buffer, options: { skipBytes?: boolean } = {}): Promise<{ ms: number, status: number, body: Record<string, unknown> }> {
    const id = randomUUID()
    const local = this.room.localParticipant
    if (local === undefined) throw new Error('还没进房')
    const t0 = performance.now()
    const answer = this.answer(id, 40_000)
    const announce = local.sendText(JSON.stringify({ id, type: 'asr' }), { topic: 'wb.rpc', destinationIdentities: [WORKER_ID] })
    if (options.skipBytes !== true) {
      const writer = await local.streamBytes({ topic: 'wb.asr', name: 'asr.wav', mimeType: 'audio/wav', totalSize: bytes.length, attributes: { wb_asr_id: id }, destinationIdentities: [WORKER_ID] })
      for (let at = 0; at < bytes.length; at += 15_000) await writer.write(new Uint8Array(bytes.subarray(at, at + 15_000)))
      await writer.close()
    }
    await announce
    const message = await answer
    return { ms: performance.now() - t0, status: Number(message.status), body: (message.body ?? {}) as Record<string, unknown> }
  }

  async leave(): Promise<void> { await this.room.disconnect().catch(() => {}) }
}

interface Row { what: string, ok: boolean, detail: string }
const rows: Row[] = []
function row(entry: Row): void { rows.push(entry); log(`${entry.ok ? '✅' : '❌'} ${entry.what} · ${entry.detail}`) }
function stats(values: number[]): string {
  const sorted = [...values].sort((a, b) => a - b)
  const pick = (q: number) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] ?? 0
  return `中位 ${Math.round(pick(0.5))}ms · 最慢 ${Math.round(sorted[sorted.length - 1] ?? 0)}ms · 最快 ${Math.round(sorted[0] ?? 0)}ms(${values.length} 遍)`
}

async function main(): Promise<void> {
  const parent = arg('dir', tmpdir())
  mkdirSync(parent, { recursive: true })
  const base = mkdtempSync(join(parent, 'asr-relay-e2e-'))
  log(`工作目录:${base}(跑完不删,要清自己把这一个目录挪进废纸篓)`)
  const home = join(base, 'home')
  const wbDir = join(base, 'wb')
  mkdirSync(home, { recursive: true })
  mkdirSync(join(wbDir, 'repo'), { recursive: true })

  const lkKey = 'cards-e2e'
  const lkSecret = randomBytes(24).toString('hex')
  writeFileSync(join(base, 'livekit.yaml'), [
    `port: ${LK_PORT}`, 'bind_addresses: ["127.0.0.1"]', 'rtc:', `  tcp_port: ${LK_PORT + 1}`, `  udp_port: ${LK_PORT + 2}`, '  use_external_ip: false',
    'keys:', `  ${lkKey}: ${lkSecret}`, 'logging:', '  level: warn', '',
  ].join('\n'), { mode: 0o600 })
  start('livekit-server', 'livekit-server', ['--config', join(base, 'livekit.yaml'), '--node-ip', '127.0.0.1'], { cwd: base, env: {}, logFile: join(base, 'livekit.log') })
  start('假 8792', process.execPath, [join(WORKER_DIR, 'dev/fake-butler.ts'), '--port', String(BUTLER_PORT), '--asr', '把首页的时钟调大一号', '--asr-delay-ms', String(ASR_DELAY_MS)], { cwd: WORKER_DIR, env: {}, logFile: join(base, 'fake-butler.log') })
  const wb = `http://127.0.0.1:${WB_PORT}`
  start('灰度工作台', process.execPath, [
    join(PLUGIN_DIR, 'scripts/channel-dev-server.ts'),
    '--port', String(WB_PORT), '--dir', wbDir, '--butler-port', String(BUTLER_PORT),
    '--start-script', join(base, '没有这个启动脚本'), '--agents', join(home, 'AGENTS.md'),
  ], {
    cwd: PLUGIN_DIR,
    env: {
      HOME: home,
      WORKBENCH_CHANNEL_URL: `ws://127.0.0.1:${LK_PORT}`,
      WORKBENCH_CHANNEL_ROOM: 'cards-e2e',
      WORKBENCH_CHANNEL_API_KEY: lkKey,
      WORKBENCH_CHANNEL_API_SECRET: lkSecret,
    },
    logFile: join(base, 'workbench.log'),
  })
  start('假接话模型', process.execPath, [join(WORKER_DIR, 'dev/stub-llm.mjs'), String(LLM_PORT)], { cwd: WORKER_DIR, env: {}, logFile: join(base, 'stub-llm.log') })
  await waitFor('灰度工作台起来', async () => (await fetch(`${wb}/channel/status`).then(r => r.ok, () => false)) || undefined, 60_000)
  start('工人', process.execPath, [join(WORKER_DIR, 'src/main.ts')], {
    cwd: WORKER_DIR,
    env: {
      HOME: home,
      WORKBENCH_CHANNEL_WORKBENCH_URL: wb,
      WORKBENCH_CHANNEL_BUTLER_URL: `http://127.0.0.1:${BUTLER_PORT}`,
      WORKBENCH_CHANNEL_LLM_BASE_URL: `http://127.0.0.1:${LLM_PORT}/v1`,
      DEEPSEEK_API_KEY: 'stub-not-a-real-key',
      WORKBENCH_CHANNEL_INBOX_DIR: join(base, 'inbox'),
      WORKBENCH_CHANNEL_OUTBOX_DIR: join(base, 'outbox'),
      WORKBENCH_CHANNEL_DEVICE_NAME: '书房 Mac',
      WORKBENCH_CHANNEL_LOG_LEVEL: 'warn',
    },
    logFile: join(base, 'worker.log'),
  })
  await waitFor('工人进房', async () => {
    const status = await fetch(`${wb}/channel/status`).then(r => r.json() as Promise<{ worker?: boolean }>, () => ({ worker: false }))
    return status.worker === true || undefined
  }, 90_000, 500)
  log('工人在房里了')

  const home1 = new Phone('Ben 的手机(在家)', wb)
  const away = new Phone('Ben 的手机(在外面)', wb)
  await home1.pair()
  await away.pair()
  await away.join()
  await sleep(1500)
  log(`在外面那台进房了(设备 ${away.deviceId})`)

  const clips = [1, 5, 20].map(seconds => ({ seconds, bytes: wav(seconds) }))
  // 热身一遍(第一次建连接、JIT),不计入。
  await away.asrRoom(clips[0]!.bytes)
  await home1.asrDirect(clips[0]!.bytes)

  for (const clip of clips) {
    const direct: number[] = []
    const room: number[] = []
    let allOk = true
    for (let i = 0; i < ROUNDS; i += 1) {
      const d = await home1.asrDirect(clip.bytes)
      const r = await away.asrRoom(clip.bytes)
      direct.push(d.ms)
      room.push(r.ms)
      if (d.status !== 200 || r.status !== 200 || r.body.text !== '把首页的时钟调大一号') allOk = false
    }
    row({ what: `${clip.seconds} 秒 · 在家直连`, ok: allOk, detail: `${Math.round(clip.bytes.length / 1024)}KB · ${stats(direct)}` })
    row({ what: `${clip.seconds} 秒 · 在外面经房间`, ok: allOk, detail: `${Math.round(clip.bytes.length / 1024)}KB · ${stats(room)}(识别本身假装 ${ASR_DELAY_MS}ms)` })
  }

  // 录音原样到了假 8792:裸 WAV、字节数对得上、是那台手机的身份。
  const seen = await fetch(`http://127.0.0.1:${BUTLER_PORT}/__stats`).then(r => r.json() as Promise<{ asr?: { bytes: number, type: string, device: string }[] }>)
  const fromRoom = (seen.asr ?? []).filter(one => one.device === away.deviceId)
  const sizesOk = fromRoom.length > 0 && fromRoom.every(one => one.type === 'audio/wav' && clips.some(clip => clip.bytes.length === one.bytes))
  row({ what: '录音原样到了电脑上的识别', ok: sizesOk, detail: `经房间那 ${fromRoom.length} 段:content-type ${[...new Set(fromRoom.map(one => one.type))].join('/')},字节数都对得上一段原始录音` })

  // 超过 20 秒:工人当场拒(413),一个字节都不交给识别。
  const before = (seen.asr ?? []).length
  const tooLong = await away.asrRoom(wav(22))
  const after = ((await fetch(`http://127.0.0.1:${BUTLER_PORT}/__stats`).then(r => r.json() as Promise<{ asr?: unknown[] }>)).asr ?? []).length
  row({ what: '22 秒的录音', ok: tooLong.status === 413 && after === before, detail: `回 ${tooLong.status}(${String(tooLong.body.error ?? '')});交给识别的次数 ${before} → ${after}` })

  // 录音没到(只发宣告):工人等到它的上限(12 秒)回 408。
  const missing = await away.asrRoom(Buffer.alloc(0), { skipBytes: true })
  row({ what: '录音没到', ok: missing.status === 408, detail: `回 ${missing.status}(${String(missing.body.error ?? '')}),等了 ${Math.round(missing.ms)}ms` })

  // 没配对的设备(房里的另一样东西,比如测试页):一条都不代办。
  const stranger = new Room()
  const strangerTicket = await fetch(`${wb}/channel/token`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ worker: true, suffix: 'intruder' }) }).then(r => r.json() as Promise<{ url?: string, token?: string }>)
  if (strangerTicket.url !== undefined && strangerTicket.token !== undefined) {
    const got = new Promise<Record<string, unknown>>((done) => {
      stranger.registerTextStreamHandler('wb.rpc', (reader, from) => { void reader.readAll().then((text) => { if (from.identity === WORKER_ID) done(JSON.parse(text) as Record<string, unknown>) }) })
    })
    await stranger.connect(strangerTicket.url, strangerTicket.token, { autoSubscribe: false, dynacast: false })
    await sleep(800)
    const id = randomUUID()
    await stranger.localParticipant?.sendText(JSON.stringify({ id, type: 'asr' }), { topic: 'wb.rpc', destinationIdentities: [WORKER_ID] })
    const answer: Record<string, unknown> = await Promise.race([got, sleep(8000).then(() => ({ status: 'no-answer' }))])
    row({ what: '不是配对过的手机', ok: answer.status === 403, detail: `回 ${String(answer.status)}(${String((answer.body as { error?: string } | undefined)?.error ?? '')})` })
    await stranger.disconnect().catch(() => {})
  }
  else {
    row({ what: '不是配对过的手机', ok: false, detail: '没领到一张非手机的进房凭证,这一条没法验' })
  }

  await away.leave()
}

main()
  .catch((err: unknown) => { row({ what: '跑到一半', ok: false, detail: (err as Error)?.stack ?? String(err) }) })
  .finally(async () => {
    await stopAll()
    console.log('\n| 哪一条 | 过没过 | 细节 |\n|---|---|---|')
    for (const one of rows) console.log(`| ${one.what} | ${one.ok ? '过' : '没过'} | ${one.detail} |`)
    process.exit(rows.every(one => one.ok) ? 0 : 1)
  })
