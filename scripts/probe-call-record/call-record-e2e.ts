/**
 * **通话落成记录,真打两通**(2026-10-22,决策记录同日「通电话是记录不是事项」)。
 *
 * 三通:手机拨的闲聊一通、手机拨的「帮我记一下 X」一通、听筒拨的「帮我记一下 Y」一通。验:
 *   ① 闲聊那一通:看板上**一张卡都不多**,通话记录目录多一份 md、`/state.calls` 多一条;
 *   ② 「记一下」那两通:X / Y 各成为一张卡(工人在通话里用 `wb_remember_item` 建的),记录上挂着它,卡指回那一通
 *      (`from.ref = call:<id>`);
 *   ③ 手机拨的那两通由手机报(这里照 App 那条路 POST 一份,带拨号时编的 call_id),工人不报;
 *      听筒拨的那一通由工人报(听筒不带 call_id,工人自己编号)。同一通报两次并成一份。
 *
 * 它起的东西**全是自己的**,一样都不碰维护者那一套(~/.dsh、真 8791、真房间一个都不碰),骨架抄 `dev/load-call.ts`:
 *   - 自己的 livekit-server(7993/7994/7995,开发用的一对假钥匙);
 *   - **真的工作台**:这份仓库 `workbench-plugin/src/server/http.ts` 的 `startWorkbenchServer`,看板 / 通话记录 /
 *     行为账都落在临时目录;前面挡一层假 8791,只答进房凭证、人设那几条(真工作台那几条要真 LiveKit 配置),
 *     其余原样转给真工作台;
 *   - 假 8792(合成回一段正弦)、假火山流式识别(按能量判停,判停时回这一通事先定好的那句话)、
 *     假接话模型(听见「记一下」就调 `wb_remember_item`,别的回一句短话);
 *   - **真的工人进程**(这份仓库的 src/main.ts),HOME 指到临时目录;
 *   - 一台假手机(rtc-node):进房、`call.start` 带上 call_id、把一段 `say` 合成的话当麦克风放出去、挂断。
 *
 * 用法(仓库根目录):node scripts/probe-call-record/call-record-e2e.ts [--home 临时目录] [--keep] [--deps <channel-worker 的 node_modules>]
 * 放在仓库根的 scripts/ 而不是哪个包里:它同时起工人与工作台两个包的源码(顶层子目录互不 import,同 scripts/probe-lan-primary)。
 * 跑完打一张表,结果写进 <HOME>/result.json;三件都对退出码 0。`--keep` 跑完不删临时目录。
 *
 * **跑之前先看维护者是不是在打电话**(同 load-call.ts):这一份会起一个工人进程,吃一点 CPU。
 */
import { execFile, spawn, type ChildProcess } from 'node:child_process'
import { createHmac, randomUUID } from 'node:crypto'
import { createWriteStream, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { homedir, tmpdir } from 'node:os'
import { join, resolve as resolvePath } from 'node:path'
import { pathToFileURL } from 'node:url'
import { gunzipSync, gzipSync } from 'node:zlib'

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`)
  return index >= 0 ? process.argv[index + 1] : undefined
}

const REPO = resolvePath(import.meta.dirname, '..', '..')
const WORKER_DIR = join(REPO, 'channel-worker')
const PLUGIN_DIR = join(REPO, 'workbench-plugin')
// 工作树里没装依赖就借一份(同 scripts/probe-lan-primary)。
const depsDir = arg('deps')
if (!existsSync(join(WORKER_DIR, 'node_modules')) && depsDir !== undefined) symlinkSync(depsDir, join(WORKER_DIR, 'node_modules'))
const requireFromWorker = createRequire(join(WORKER_DIR, 'package.json'))
const { WebSocketServer } = requireFromWorker('ws') as typeof import('ws')
type WebSocket = import('ws').WebSocket
const { AudioFrame, AudioSource, AudioStream, LocalAudioTrack, Room, RoomEvent, TrackKind, TrackPublishOptions, TrackSource } = requireFromWorker('@livekit/rtc-node') as typeof import('@livekit/rtc-node')
type Room = import('@livekit/rtc-node').Room
const source = async <T>(dir: string, path: string): Promise<T> => await import(pathToFileURL(join(dir, path)).href) as T
const { COMP_GZIP, FLAG_POS_SEQUENCE, MSG_FULL_SERVER, SER_JSON, buildFrame } = await source<typeof import('../../channel-worker/src/asr/volcProtocol.ts')>(WORKER_DIR, 'src/asr/volcProtocol.ts')
const { RPC_TOPIC, WORKER_IDENTITY } = await source<typeof import('../../channel-worker/src/rpc.ts')>(WORKER_DIR, 'src/rpc.ts')
const { pcmOfWav } = await source<typeof import('../../channel-worker/src/tts/butlerTts.ts')>(WORKER_DIR, 'src/tts/butlerTts.ts')
const { startWorkbenchServer } = await source<typeof import('../../workbench-plugin/src/server/http.ts')>(PLUGIN_DIR, 'src/server/http.ts')
const { createWorkbenchService } = await source<typeof import('../../workbench-plugin/src/server/service.ts')>(PLUGIN_DIR, 'src/server/service.ts')
const { createTasksService } = await source<typeof import('../../workbench-plugin/src/server/tasks.ts')>(PLUGIN_DIR, 'src/server/tasks.ts')
const { CALL_RECORDS_DIR_NAME, createCallRecordsService } = await source<typeof import('../../workbench-plugin/src/server/callRecords.ts')>(PLUGIN_DIR, 'src/server/callRecords.ts')
const { createBehaviorLog } = await source<typeof import('../../workbench-plugin/src/server/behaviorLog.ts')>(PLUGIN_DIR, 'src/server/behaviorLog.ts')

const HOME = arg('home') ?? mkdtempSync(join(tmpdir(), 'wb-call-record-e2e-'))
const KEEP = process.argv.includes('--keep')
const DSH_NODE = join(homedir(), '.dsh', 'node', 'bin', 'node')
const NODE_BIN = existsSync(DSH_NODE) ? DSH_NODE : process.execPath
const LK_PORT = 7993
const LK_KEY = 'callrece2ekey'
/** 只给这台自己起的 livekit-server 用的一串假钥匙,不是任何人的密钥。 */
const LK_SECRET = 'call-record-e2e-secret-not-a-real-key'
const ROOM = `call-record-e2e-${process.pid}`
const PHONE_IDENTITY = 'wb-phone-e2e'
/** 工人带的那把令牌(真工作台据此认出「电话」那一端)。只在这次跑的进程之间用。 */
const WORKER_TOKEN = `e2e-worker-${randomUUID()}`

/** 三通电话:手机拨的闲聊、手机拨的「记一下」、听筒拨的「记一下」(听筒的 `start` 不带 call_id,同真听筒)。 */
const CALLS = [
  { key: 'chat', on: 'phone', call_id: `ph-e2echat${process.pid}`, said: '今天天气不错啊。', expect: undefined },
  { key: 'remember', on: 'phone', call_id: `ph-e2ememo${process.pid}`, said: '帮我记一下明天下午三点给客户回电话。', expect: '明天下午三点给客户回电话' },
  { key: 'handset', on: 'handset', call_id: undefined, said: '帮我记一下周五之前把报销交了。', expect: '周五之前把报销交了' },
] as const
const HANDSET_IDENTITY = 'wb-phone-e2e-handset'
/** 假火山判停时回的那一句(换一通就换一句)。 */
let utterance: string = CALLS[0].said

const t0 = Date.now()
function stamp(): string {
  const now = new Date()
  return `${now.toTimeString().slice(0, 8)}.${String(now.getMilliseconds()).padStart(3, '0')}`
}
function log(line: string): void { console.log(`${stamp()}  ${line}`) }
function sleep(ms: number): Promise<void> { return new Promise(resolve => setTimeout(resolve, ms)) }
async function waitFor(what: string, probe: () => boolean | Promise<boolean>, timeoutMs = 30_000): Promise<void> {
  const until = Date.now() + timeoutMs
  while (Date.now() < until) {
    if (await Promise.resolve().then(probe).catch(() => false)) return
    await sleep(100)
  }
  throw new Error(`等「${what}」超时(${timeoutMs}ms)`)
}
function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => chunks.push(chunk))
    req.on('end', () => resolve(Buffer.concat(chunks)))
  })
}
function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(JSON.stringify(body))
}
async function listen(server: Server): Promise<number> {
  return await new Promise<number>((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve((server.address() as { port: number }).port))
  })
}

const children: ChildProcess[] = []
const servers: Server[] = []

function signToken(identity: string, name: string, attributes?: Record<string, string>): string {
  const b64 = (value: string): string => Buffer.from(value).toString('base64url')
  const now = Math.floor(Date.now() / 1000)
  const payload = {
    iss: LK_KEY, sub: identity, nbf: now - 10, exp: now + 6 * 3600, name,
    video: { room: ROOM, roomJoin: true, canPublish: true, canSubscribe: true, canPublishData: true },
    ...(attributes === undefined ? {} : { attributes }),
  }
  const data = `${b64(JSON.stringify({ alg: 'HS256', typ: 'JWT' }))}.${b64(JSON.stringify(payload))}`
  return `${data}.${createHmac('sha256', LK_SECRET).update(data).digest('base64url')}`
}

// ———————————————————————— livekit-server ————————————————————————

async function startLivekit(): Promise<void> {
  const config = join(HOME, 'livekit.yaml')
  writeFileSync(config, [
    `port: ${LK_PORT}`, 'bind_addresses: ["127.0.0.1"]', 'rtc:', `  tcp_port: ${LK_PORT + 1}`, `  udp_port: ${LK_PORT + 2}`,
    '  use_external_ip: false', 'keys:', `  ${LK_KEY}: ${LK_SECRET}`, 'logging:', '  level: warn', '',
  ].join('\n'))
  const lk = spawn('livekit-server', ['--config', config, '--node-ip', '127.0.0.1'], { stdio: ['ignore', 'ignore', 'pipe'] })
  children.push(lk)
  lk.stderr?.pipe(createWriteStream(join(HOME, 'livekit.log')))
  await waitFor('livekit-server', async () => (await fetch(`http://127.0.0.1:${LK_PORT}`)).status < 500, 20_000)
  log(`livekit-server 起来了:ws://127.0.0.1:${LK_PORT}(房间 ${ROOM})`)
}

// ———————————————————————— 真工作台 + 前面那层假 8791 ————————————————————————

const DATA = join(HOME, 'workbench')
const WORKDIR = join(HOME, '工作目录')
const tasks = createTasksService({ file: join(DATA, 'tasks.json') })
const callRecords = createCallRecordsService({ file: join(DATA, 'calls.json'), workdir: () => WORKDIR, fallbackDir: join(DATA, CALL_RECORDS_DIR_NAME) })
const behaviorLog = createBehaviorLog({ dir: join(DATA, '行为账') })

async function startRealWorkbench(): Promise<string> {
  const server = await startWorkbenchServer({
    port: 0,
    service: createWorkbenchService(),
    tickIntervalMs: 0,
    heartbeatMs: 0,
    tasks,
    callRecords,
    behaviorLog,
    actorTokens: { butler: `e2e-butler-${randomUUID()}`, worker: WORKER_TOKEN },
  })
  log(`真工作台(这份仓库的 workbench-plugin)起来了:${server.url},数据在 ${DATA}`)
  return server.url
}

async function startFront(real: string): Promise<number> {
  const server = createServer((req, res) => {
    void (async () => {
      const path = (req.url ?? '').split('?')[0] ?? ''
      const body = await readBody(req)
      if (path === '/channel/token' && req.method === 'POST') {
        let worker = false
        try { worker = (JSON.parse(body.toString('utf8') || '{}') as { worker?: unknown }).worker === true } catch { /* 当手机 */ }
        const identity = worker ? WORKER_IDENTITY : PHONE_IDENTITY
        json(res, 200, { url: `ws://127.0.0.1:${LK_PORT}`, room: ROOM, identity, token: signToken(identity, 'e2e'), expires_at: Date.now() + 6 * 3600_000 })
        return
      }
      if (path === '/channel/persona') { json(res, 200, { system_message: '你是事务官。说话简短,一两句就够。', welcome: '我在。', addresses: ['老板'] }); return }
      if (path === '/channel/credentials') { json(res, 200, { source: 'none' }); return }
      if (path === '/call/claim') { json(res, 200, { calls: [] }); return }
      if (path === '/onboarding/brief') { json(res, 404, { error: '这一跑不做引导' }); return }
      // 其余原样转给真工作台(头只带这几样:令牌那一格是「电话」那一端的凭证)。
      const headers: Record<string, string> = {}
      for (const name of ['content-type', 'x-workbench-actor', 'accept']) {
        const value = req.headers[name]
        if (typeof value === 'string') headers[name] = value
      }
      const forwarded = await fetch(`${real}${req.url ?? ''}`, {
        method: req.method ?? 'GET',
        headers,
        ...(req.method === 'GET' || req.method === 'HEAD' ? {} : { body }),
      }).catch((err: unknown) => new Response(JSON.stringify({ error: String(err) }), { status: 502 }))
      res.writeHead(forwarded.status, { 'content-type': forwarded.headers.get('content-type') ?? 'application/json' })
      res.end(Buffer.from(await forwarded.arrayBuffer()))
    })()
  })
  servers.push(server)
  return await listen(server)
}

// ———————————————————————— 假 8792 / 假接话模型 / 假火山 ————————————————————————

function wavOfSine(seconds: number, sampleRate = 24000): Buffer {
  const samples = Math.round(sampleRate * seconds)
  const pcm = Buffer.alloc(samples * 2)
  for (let i = 0; i < samples; i += 1) pcm.writeInt16LE(Math.round(Math.sin((2 * Math.PI * 220 * i) / sampleRate) * 3000), i * 2)
  const header = Buffer.alloc(44)
  header.write('RIFF', 0, 'ascii'); header.writeUInt32LE(36 + pcm.length, 4); header.write('WAVE', 8, 'ascii')
  header.write('fmt ', 12, 'ascii'); header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22)
  header.writeUInt32LE(sampleRate, 24); header.writeUInt32LE(sampleRate * 2, 28); header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34)
  header.write('data', 36, 'ascii'); header.writeUInt32LE(pcm.length, 40)
  return Buffer.concat([header, pcm])
}

async function startFakeButler(): Promise<number> {
  const server = createServer((req, res) => {
    void (async () => {
      const path = (req.url ?? '').split('?')[0] ?? ''
      const body = (await readBody(req)).toString('utf8')
      if (path === '/health') { json(res, 200, { ok: true }); return }
      if (path === '/api/tts') {
        let text = ''
        try { text = String((JSON.parse(body) as { text?: unknown }).text ?? '') } catch { /* 空的也照答 */ }
        res.writeHead(200, { 'content-type': 'audio/wav', 'cache-control': 'no-store' })
        res.end(wavOfSine(Math.max(0.4, [...text].length * 0.12)))
        return
      }
      json(res, 404, { error: '假 8792 只认 /health 与 /api/tts' })
    })()
  })
  servers.push(server)
  return await listen(server)
}

/** 假接话模型调过的工具(验「她真用工具建了那张卡」)。 */
const toolCalls: { name: string, args: unknown }[] = []

async function startStubLlm(): Promise<number> {
  const server = createServer((req, res) => {
    void (async () => {
      const raw = (await readBody(req)).toString('utf8')
      if (!(req.url ?? '').includes('/chat/completions')) { json(res, 404, { error: 'stub' }); return }
      let request: { messages?: { role?: string, content?: unknown }[], tools?: { function?: { name?: string } }[] } = {}
      try { request = JSON.parse(raw) as typeof request } catch { /* 空请求照答 */ }
      const messages = request.messages ?? []
      // 这一回合(她最后那一句之后)已经调过工具了 → 照工具回的话收尾,不再调第二次。
      const lastUser = messages.map(m => m.role).lastIndexOf('user')
      const lastIsTool = messages.slice(lastUser + 1).some(m => m.role === 'tool')
      const userText = messages[lastUser]
      const said = typeof userText?.content === 'string' ? userText.content : JSON.stringify(userText?.content ?? '')
      const tools = (request.tools ?? []).map(one => one.function?.name)
      const remember = !lastIsTool && said.includes('记一下') && tools.includes('wb_remember_item')
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' })
      const id = `chatcmpl-${randomUUID()}`
      const created = Math.floor(Date.now() / 1000)
      const chunk = (delta: Record<string, unknown>, finish: string | null): string =>
        `data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created, model: 'deepseek-v4-flash', choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`
      if (remember) {
        const args = { text: utterance.replace(/^帮我记一下/u, '').replace(/[。]$/u, '') }
        toolCalls.push({ name: 'wb_remember_item', args })
        res.write(chunk({ role: 'assistant', tool_calls: [{ index: 0, id: `call_${randomUUID().slice(0, 8)}`, type: 'function', function: { name: 'wb_remember_item', arguments: JSON.stringify(args) } }] }, null))
        res.write(chunk({}, 'tool_calls'))
        res.end('data: [DONE]\n\n')
        return
      }
      const reply = lastIsTool ? '记下了。' : '嗯,是啊。'
      res.write(chunk({ role: 'assistant', content: '' }, null))
      res.write(chunk({ content: reply }, null))
      res.write(chunk({}, 'stop'))
      res.end('data: [DONE]\n\n')
    })()
  })
  servers.push(server)
  return await listen(server)
}

function parseClientFrame(buf: Buffer): { type: number, payload: Buffer } | undefined {
  if (buf.length < 8) return undefined
  const headerSize = ((buf[0] ?? 0) & 0x0f) * 4
  const type = ((buf[1] ?? 0) >> 4) & 0x0f
  const flags = (buf[1] ?? 0) & 0x0f
  const compression = (buf[2] ?? 0) & 0x0f
  let offset = headerSize
  if (flags === 0b0001 || flags === 0b0011) offset += 4
  const size = buf.readUInt32BE(offset)
  let payload = buf.subarray(offset + 4, offset + 4 + size)
  if (compression === COMP_GZIP && payload.length > 0) {
    try { payload = gunzipSync(payload) } catch { return undefined }
  }
  return { type, payload }
}

/** 假火山:按能量判停,判停时回这一通事先定好的那句话(同 load-call.ts 那一台,去掉了压测那几样)。 */
async function startFakeVolc(): Promise<number> {
  const server = createServer()
  const wss = new WebSocketServer({ server })
  wss.on('connection', (ws: WebSocket) => {
    let endWindowMs = 800
    let speaking = false
    let silenceMs = 0
    let seq = 1
    const send = (result: Record<string, unknown>): void => {
      seq += 1
      try { ws.send(buildFrame({ messageType: MSG_FULL_SERVER, flags: FLAG_POS_SEQUENCE, serialization: SER_JSON, compression: COMP_GZIP, sequence: seq, payload: gzipSync(Buffer.from(JSON.stringify({ result }))) })) }
      catch { /* 断了就断了 */ }
    }
    ws.on('message', (data: Buffer) => {
      const frame = parseClientFrame(Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer))
      if (frame === undefined) return
      if (frame.type === 0b0001) {
        try {
          const request = (JSON.parse(frame.payload.toString('utf8')) as { request?: { end_window_size?: number } }).request
          if (typeof request?.end_window_size === 'number') endWindowMs = request.end_window_size
        }
        catch { /* 按缺省 */ }
        return
      }
      const pcm = frame.payload
      const samples = Math.floor(pcm.length / 2)
      if (samples === 0) return
      let sum = 0
      for (let i = 0; i < samples; i += 1) { const v = pcm.readInt16LE(i * 2); sum += v * v }
      const rms = Math.sqrt(sum / samples)
      const ms = (samples / 16000) * 1000
      if (rms > 300) { speaking = true; silenceMs = 0; return }
      if (!speaking) return
      silenceMs += ms
      if (silenceMs >= endWindowMs) {
        speaking = false
        send({ text: utterance, utterances: [{ text: utterance, definite: true }, { text: '', definite: false }] })
      }
    })
  })
  servers.push(server)
  return await listen(server)
}

// ———————————————————————— 工人 ————————————————————————

const workerLines: string[] = []
async function startWorker(ports: { wb: number, butler: number, llm: number, volc: number }): Promise<void> {
  let joined = false
  const worker = spawn(NODE_BIN, [join(WORKER_DIR, 'src', 'main.ts')], {
    cwd: WORKER_DIR,
    env: {
      PATH: process.env.PATH ?? '/usr/bin:/bin:/usr/sbin:/sbin',
      HOME,
      LANG: 'en_US.UTF-8',
      WORKBENCH_CHANNEL_WORKBENCH_URL: `http://127.0.0.1:${ports.wb}`,
      WORKBENCH_CHANNEL_BUTLER_URL: `http://127.0.0.1:${ports.butler}`,
      WORKBENCH_CHANNEL_LLM_BASE_URL: `http://127.0.0.1:${ports.llm}/v1`,
      DEEPSEEK_API_KEY: 'stub-not-a-key',
      WORKBENCH_CHANNEL_ASR: 'volc-streaming',
      WORKBENCH_CHANNEL_VOLC_ASR_URL: `ws://127.0.0.1:${ports.volc}`,
      WORKBENCH_CHANNEL_VOLC_ASR_APP_ID: 'fake-app',
      WORKBENCH_CHANNEL_VOLC_ASR_ACCESS_TOKEN: 'fake-token',
      WORKBENCH_CHANNEL_INBOX_DIR: join(HOME, 'inbox'),
      WORKBENCH_CHANNEL_OUTBOX_DIR: join(HOME, 'outbox'),
      WORKBENCH_CHANNEL_TRANSFERS_FILE: join(HOME, 'transfers.jsonl'),
      WORKBENCH_CHANNEL_DEVICE_NAME: 'call-record-e2e',
      WORKBENCH_CHANNEL_LOG_LEVEL: 'warn',
      WORKBENCH_CHANNEL_FIRST_VOICE: 'off',
      WORKBENCH_WORKER_ACTOR: WORKER_TOKEN,
      WORKBENCH_CHANNEL_LOAD_GUARD_ONLY_UNDER: String(process.pid),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  children.push(worker)
  const file = createWriteStream(join(HOME, 'worker.log'))
  for (const stream of [worker.stdout, worker.stderr]) {
    let buffer = ''
    stream?.on('data', (chunk: Buffer) => {
      buffer += chunk.toString('utf8')
      let at = buffer.indexOf('\n')
      while (at >= 0) {
        // eslint-disable-next-line no-control-regex
        const line = buffer.slice(0, at).replace(/\x1b\[[0-9;]*m/g, '')
        buffer = buffer.slice(at + 1)
        at = buffer.indexOf('\n')
        file.write(`${Date.now() - t0}\t${line}\n`)
        if (line.trim() !== '') workerLines.push(line)
        if (line.includes('[channel-worker] 进房了')) joined = true
      }
    })
  }
  worker.on('exit', code => log(`工人退出了(${code ?? '信号'})`))
  await waitFor('工人进房', () => joined, 60_000)
  log('工人进房了(这份仓库的 channel-worker)')
}

// ———————————————————————— 假手机 ————————————————————————

interface Phone {
  rpc: (request: Record<string, unknown>) => Promise<Record<string, unknown>>
  speak: (wav: string) => Promise<number>
  herVoice: () => { speaking: boolean, lastLoudAt: number, firstLoudSince: (at: number) => number | undefined }
  stop: () => Promise<void>
}

async function startPhone(identity: string, attributes?: Record<string, string>): Promise<Phone> {
  const room = new Room()
  const pending = new Map<string, (message: Record<string, unknown>) => void>()
  let textQueue: Promise<void> = Promise.resolve()
  room.registerTextStreamHandler(RPC_TOPIC, (reader, from) => {
    textQueue = textQueue.then(async () => {
      if (from?.identity !== WORKER_IDENTITY) return
      const text = await reader.readAll()
      let message: Record<string, unknown>
      try { message = JSON.parse(text) as Record<string, unknown> } catch { return }
      const id = typeof message.id === 'string' ? message.id : ''
      const resolve = pending.get(id)
      if (resolve !== undefined) { pending.delete(id); resolve(message) }
    }).catch(() => {})
  })
  const loudStarts: number[] = []
  let loudRun = 0
  let quietRun = 0
  let speaking = false
  let lastLoudAt = 0
  room.on(RoomEvent.TrackSubscribed, (track, _pub, participant) => {
    if (track.kind !== TrackKind.KIND_AUDIO || participant.identity !== WORKER_IDENTITY) return
    void (async () => {
      for await (const frame of new AudioStream(track)) {
        let peak = 0
        for (let i = 0; i < frame.data.length; i += 4) { const v = Math.abs(frame.data[i] as number); if (v > peak) peak = v }
        if (peak > 600) { loudRun += 1; quietRun = 0; lastLoudAt = Date.now() }
        else { quietRun += 1; loudRun = 0 }
        if (!speaking && loudRun === 5) { speaking = true; loudStarts.push(Date.now() - 40) }
        if (speaking && quietRun >= 80) speaking = false
      }
    })()
  })
  await room.connect(`ws://127.0.0.1:${LK_PORT}`, signToken(identity, attributes === undefined ? 'e2e 手机' : 'e2e 听筒', attributes), { autoSubscribe: true, dynacast: true })
  const sampleRate = 48000
  const channels = 1
  const source = new AudioSource(sampleRate, channels, 200)
  const track = LocalAudioTrack.createAudioTrack('mic', source)
  const options = new TrackPublishOptions()
  options.source = TrackSource.SOURCE_MICROPHONE
  await room.localParticipant?.publishTrack(track, options)
  const samplesPerFrame = Math.round(sampleRate / 100)
  const silence = new Int16Array(samplesPerFrame * channels)
  let queue: Int16Array[] = []
  let onDrained: ((at: number) => void) | undefined
  let running = true
  const pump = (async () => {
    while (running) {
      const next = queue.shift()
      try { await source.captureFrame(new AudioFrame(next ?? silence, sampleRate, channels, samplesPerFrame)) }
      catch { if (!running) break }
      if (next !== undefined && queue.length === 0 && onDrained !== undefined) {
        const done = onDrained
        onDrained = undefined
        done(Date.now() + source.queuedDuration)
      }
    }
  })()
  const framesOf = (wav: string): Int16Array[] => {
    const { pcm } = pcmOfWav(readFileSync(wav))
    const out: Int16Array[] = []
    for (let offset = 0; offset + samplesPerFrame * 2 <= pcm.length; offset += samplesPerFrame * 2) {
      const samples = new Int16Array(samplesPerFrame)
      for (let i = 0; i < samples.length; i += 1) samples[i] = pcm.readInt16LE(offset + i * 2)
      out.push(samples)
    }
    return out
  }
  return {
    async rpc(request) {
      const id = randomUUID()
      const waited = new Promise<Record<string, unknown>>((resolve, reject) => {
        pending.set(id, resolve)
        setTimeout(() => { if (pending.delete(id)) reject(new Error('10 秒没回')) }, 10_000)
      })
      await room.localParticipant?.sendText(JSON.stringify({ id, ...request }), { topic: RPC_TOPIC })
      return await waited
    },
    speak: wav => new Promise<number>((resolve) => { onDrained = resolve; queue = framesOf(wav) }),
    herVoice: () => ({ speaking, lastLoudAt, firstLoudSince: (at: number) => loudStarts.find(start => start >= at) }),
    async stop() {
      running = false
      await pump.catch(() => {})
      await room.disconnect()
    },
  }
}

async function wavOf(text: string, name: string): Promise<string> {
  const aiff = join(HOME, `${name}.aiff`)
  const wav = join(HOME, `${name}.wav`)
  await new Promise<void>((resolve, reject) => execFile('/usr/bin/say', ['-v', 'Tingting', '-o', aiff, text], err => (err === null ? resolve() : reject(err))))
  await new Promise<void>((resolve, reject) => execFile('/usr/bin/afconvert', ['-f', 'WAVE', '-d', 'LEI16@48000', '-c', '1', aiff, wav], err => (err === null ? resolve() : reject(err))))
  return wav
}

// ———————————————————————— 主流程 ————————————————————————

interface CallOutcome {
  key: string
  on: 'phone' | 'handset'
  call_id?: string
  greeted: boolean
  replied: boolean
  tasks_before: number
  tasks_after: number
  /** 这一通落下的那份记录(手机那两通:手机报过之后;听筒那一通:工人报的)。 */
  record?: { id: string, summary: string, lines: number, items: readonly { task_id: string, did: string }[], maybe_todo?: readonly string[], file?: string, file_exists: boolean }
  /** 工人有没有报(手机那两通应该没有;听筒那一通应该有)。 */
  worker_reported: boolean
  /** 同一通再报一次之后:同一个编号的记录有几份、看板上几张卡。 */
  after_again?: { records_with_id: number, tasks: number }
  made?: { id: string, title: string, from_ref?: string }
}

async function postRecord(wbUrl: string, body: unknown): Promise<{ status: number, body: { id?: string } }> {
  const res = await fetch(`${wbUrl}/butler/call/record`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-workbench-actor': WORKER_TOKEN },
    body: JSON.stringify(body),
  })
  return { status: res.status, body: await res.json() as { id?: string } }
}

async function oneCall(phone: Phone, spec: (typeof CALLS)[number], wbUrl: string): Promise<CallOutcome> {
  utterance = spec.said
  const wav = await wavOf(spec.said, spec.key)
  const before = new Set((await callRecords.view()).recent.map(one => one.id))
  const tasksBefore = (await tasks.list()).tasks.length
  const outcome: CallOutcome = { key: spec.key, on: spec.on, ...(spec.call_id === undefined ? {} : { call_id: spec.call_id }), greeted: false, replied: false, tasks_before: tasksBefore, tasks_after: tasksBefore, worker_reported: false }
  log(`—— 「${spec.key}」那一通(${spec.on === 'phone' ? '手机拨' : '听筒拨'}):call.start${spec.call_id === undefined ? '(不带 call_id)' : `(call_id ${spec.call_id})`}`)
  const greeted = await phone.rpc({ type: 'call', action: 'start', ...(spec.call_id === undefined ? {} : { call_id: spec.call_id }) }).catch((err: unknown) => ({ ok: false, error: (err as Error).message }))
  outcome.greeted = greeted.ok === true
  log(`招呼 → ${outcome.greeted ? '她开口了' : `没说成:${String(greeted.error)}`}`)
  await waitFor('开场白说完', () => { const v = phone.herVoice(); return !v.speaking && v.lastLoudAt > 0 && Date.now() - v.lastLoudAt > 1200 }, 30_000).catch(() => log('开场白没等到(照样往下走)'))
  const spokeEndAt = await phone.speak(wav)
  log(`他说:「${spec.said}」`)
  await waitFor('她回话', () => phone.herVoice().firstLoudSince(spokeEndAt) !== undefined, 45_000)
    .then(() => { outcome.replied = true })
    .catch(() => log('45 秒她都没回话'))
  await waitFor('她说完', () => { const v = phone.herVoice(); return !v.speaking && Date.now() - v.lastLoudAt > 1500 }, 30_000).catch(() => {})
  await phone.rpc({ type: 'call', action: 'hangup' }).catch(() => {})
  log('挂断了')
  // 工人报不报:等 6 秒看有没有新冒出来的那一份(手机那两通应该没有 —— 它们归手机报)。
  const fresh = async () => (await callRecords.view()).recent.find(one => !before.has(one.id))
  await waitFor('工人报的记录', async () => (await fresh()) !== undefined, spec.on === 'handset' ? 20_000 : 6_000).catch(() => {})
  const byWorker = await fresh()
  outcome.worker_reported = byWorker !== undefined
  let id = byWorker?.id
  if (spec.on === 'phone') {
    // 手机拨的那一通:照 App 那条路报一份(useCall 挂断那一段:带拨号时编的 call_id、时长与两边字幕)。
    const posted = await postRecord(wbUrl, { call_id: spec.call_id, durationSeconds: 8, transcript: [{ who: 'butler', text: '老板,我在。' }, { who: 'me', text: spec.said }] })
    id = posted.body.id
  }
  const record = id === undefined ? undefined : await callRecords.get(id)
  if (record !== undefined) {
    outcome.record = {
      id: record.id, summary: record.summary, lines: record.lines, items: record.items.map(item => ({ task_id: item.task_id, did: item.did })),
      ...(record.maybe_todo === undefined ? {} : { maybe_todo: record.maybe_todo }),
      ...(record.file === undefined ? {} : { file: record.file }), file_exists: record.file !== undefined && existsSync(record.file),
    }
    // 同一通再报一次(另一头也报了的样子):并成一份,不建卡。
    await postRecord(wbUrl, { call_id: record.id, durationSeconds: 8, transcript: [{ who: 'me', text: spec.said }] })
  }
  const board = (await tasks.list()).tasks
  outcome.tasks_after = board.length
  outcome.after_again = { records_with_id: (await callRecords.view()).recent.filter(one => one.id === id).length, tasks: board.length }
  const made = spec.expect === undefined ? undefined : board.find(one => one.title.includes(spec.expect))
  if (made !== undefined) outcome.made = { id: made.id, title: made.title, ...(made.from?.ref === undefined ? {} : { from_ref: made.from.ref }) }
  return outcome
}

async function main(): Promise<void> {
  mkdirSync(HOME, { recursive: true })
  log(`临时 HOME ${HOME}`)
  await startLivekit()
  const wbUrl = await startRealWorkbench()
  const ports = { wb: await startFront(wbUrl), butler: await startFakeButler(), llm: await startStubLlm(), volc: await startFakeVolc() }
  log(`假 8791(前挡):${ports.wb} · 假 8792 :${ports.butler} · 假模型 :${ports.llm} · 假火山 :${ports.volc}`)
  await startWorker(ports)
  const outcomes: CallOutcome[] = []
  let phone = await startPhone(PHONE_IDENTITY)
  log('假手机进房了')
  for (const spec of CALLS) {
    if (spec.on === 'handset' && outcomes.every(one => one.on === 'phone')) {
      await phone.stop()
      phone = await startPhone(HANDSET_IDENTITY, { wb_kind: 'handset' })
      log('换成假听筒进房(凭证里签着 wb_kind: handset)')
    }
    outcomes.push(await oneCall(phone, spec, wbUrl))
    await sleep(2000)
  }
  await phone.stop()
  await behaviorLog.flush()
  const board = (await tasks.list()).tasks
  const behavior = await behaviorLog.read({})
  const [chat, memo, hand] = outcomes as [CallOutcome, CallOutcome, CallOutcome]
  const linked = (one: CallOutcome): boolean => one.made !== undefined && one.record !== undefined
    && one.record.items.some(item => item.task_id === one.made!.id && item.did === 'created')
    && one.made.from_ref === `call:${one.record.id}`
  const checks = {
    '闲聊:看板上不多卡': chat.tasks_before === 0 && chat.tasks_after === 0,
    '闲聊:落了一份记录(文件在、没挂卡)': chat.record !== undefined && chat.record.file_exists && chat.record.items.length === 0,
    '手机拨的两通工人不报(归手机报)': !chat.worker_reported && !memo.worker_reported,
    '手机拨「记一下」:多一张卡、挂在记录上、指回那一通': memo.tasks_after === memo.tasks_before + 1 && linked(memo),
    '听筒拨:工人报了(自己编号)': hand.worker_reported && hand.record !== undefined && hand.record.id.startsWith('call-'),
    '听筒拨「记一下」:多一张卡、挂在记录上、指回那一通': hand.tasks_after === hand.tasks_before + 1 && linked(hand),
    '同一通再报一次:并成一份、不建卡': outcomes.every(one => one.after_again?.records_with_id === 1 && one.after_again.tasks === one.tasks_after),
    '行为账:三条「通了电话」': behavior.filter(one => one.事 === '通了电话').length === 3,
  }
  const result = {
    home: HOME,
    records_dir: join(WORKDIR, CALL_RECORDS_DIR_NAME),
    outcomes,
    board: board.map(one => ({ id: one.id, title: one.title, from: one.from, source: one.source })),
    tool_calls: toolCalls,
    checks,
    worker_tail: workerLines.filter(line => line.includes('通话记录') || line.includes('他说') || line.includes('她说') || line.includes('工具')).slice(-30),
  }
  writeFileSync(join(HOME, 'result.json'), `${JSON.stringify(result, null, 2)}\n`)
  console.log('\n—— 结果 ——')
  for (const [name, ok] of Object.entries(checks)) console.log(`${ok ? '✓' : '✗'} ${name}`)
  console.log(`记录目录:${result.records_dir}`)
  console.log(`详情:${join(HOME, 'result.json')}`)
  shutdown(Object.values(checks).every(Boolean) ? 0 : 1)
}

function shutdown(code: number): void {
  for (const child of children) { try { child.kill('SIGTERM') } catch { /* 已经退了 */ } }
  for (const server of servers) { try { server.close() } catch { /* 已经关了 */ } }
  setTimeout(() => {
    if (!KEEP && code === 0) { try { rmSync(HOME, { recursive: true, force: true }) } catch { /* 删不掉就留着 */ } }
    process.exit(code)
  }, 800)
}

process.on('SIGINT', () => shutdown(130))
main().catch((err: unknown) => {
  console.error(`跑挂了:${(err as Error)?.stack ?? String(err)}`)
  shutdown(1)
})
