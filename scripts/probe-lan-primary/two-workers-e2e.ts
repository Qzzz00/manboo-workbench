/**
 * **两条工人一通来电,真打**(2026-10-22,局域网主路 M6;docs/交接-1022-局域网M6.md 第五节)。
 *
 * 起的东西**全是自己的**,一样都不碰维护者那一套(~/.dsh 只借 node 二进制、真 8791、真房间、真中转一个都不碰):
 *   - **本机房间**:探针 `scripts/probe-lan-primary/lk-up.sh` 起的那台 livekit-server(7880,0.0.0.0,node_ip 是这台的局域网地址),
 *     钥匙写进临时 HOME 的 `channel.json`(`ws://127.0.0.1:7880`,房间 `wb-local-<机器 id 前 8 位>`,同 M1 装的样子);
 *   - **云房间的替身**:第二台 livekit-server(7993,只听回环),一个假中转(`ChannelCredentialStore`)替它签票 ——
 *     真的云房间要真账号与真中转,留给 M8 真机;
 *   - **真的 8791**:这份仓库的 `startWorkbenchServer` + 真的 `channel` / 来电台账 / 通话记录 / 行为账,
 *     以及**真的两条工人看管**(`createChannelWorkerFleet` + `channelWorkerForRoute`):它按路线拉起 `deploy/channel-start`
 *     (HOME 指到临时目录、CHANNEL_WORKER_DIR 指到这份仓库),两条真工人进程(这份仓库的 channel-worker);
 *   - 假 8792(合成回一段正弦)、假火山流式识别、假接话模型(同 scripts/probe-call-record/call-record-e2e.ts);
 *   - 两台假设备(rtc-node,`channel-worker/dev/fake-phone.ts --incoming` 那一套):听筒进本机房间、手机进云房间。
 *
 * 验:
 *   ① 两条工人都进房,`/channel/status.workers` 看得见两条;
 *   ② 一通来电两边都响(同一个 call_id);手机先接 → 云房间那条出声,本机房间收铃(`ring_end{canceled}`),听筒一声都听不到;
 *      听筒随后再按接起被拒;手机挂断后照 App 那条路报记录 → 通话记录一份;台账一条「接了」、收场只记一次;
 *   ③ 反过来听筒先接 → 本机房间那条出声、云房间收铃;听筒挂断由工人报记录 → 一份(云房间那条不报);
 *   ④ 两边同时按接起:只有一边接上;
 *   ⑤ 中转说「没登录」(或没接中转):云房间那条停掉,只剩本机那条;
 *   另量两条工人与一条的内存 / CPU,和「房里没设备」那条的空转。
 *
 * 用法(仓库根目录):node scripts/probe-lan-primary/two-workers-e2e.ts [--home 临时目录] [--keep] [--idle-seconds 30]
 * 跑完打一张表,结果写进 <HOME>/result.json;全对退出码 0。**跑之前先看维护者是不是在打电话**:这一份起两个工人进程。
 */
import { execFile, spawn, type ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { chmodSync, createWriteStream, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
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
const requireFromWorker = createRequire(join(WORKER_DIR, 'package.json'))
const { WebSocketServer } = requireFromWorker('ws') as typeof import('ws')
type WebSocket = import('ws').WebSocket
const { AudioFrame, AudioSource, AudioStream, LocalAudioTrack, Room, RoomEvent, TrackKind, TrackPublishOptions, TrackSource } = requireFromWorker('@livekit/rtc-node') as typeof import('@livekit/rtc-node')
const source = async <T>(dir: string, path: string): Promise<T> => await import(pathToFileURL(join(dir, path)).href) as T
const { COMP_GZIP, FLAG_POS_SEQUENCE, MSG_FULL_SERVER, SER_JSON, buildFrame } = await source<typeof import('../../channel-worker/src/asr/volcProtocol.ts')>(WORKER_DIR, 'src/asr/volcProtocol.ts')
const { RPC_TOPIC, WORKER_IDENTITY } = await source<typeof import('../../channel-worker/src/rpc.ts')>(WORKER_DIR, 'src/rpc.ts')
const { pcmOfWav } = await source<typeof import('../../channel-worker/src/tts/butlerTts.ts')>(WORKER_DIR, 'src/tts/butlerTts.ts')
const { startWorkbenchServer } = await source<typeof import('../../workbench-plugin/src/server/http.ts')>(PLUGIN_DIR, 'src/server/http.ts')
const { createWorkbenchService } = await source<typeof import('../../workbench-plugin/src/server/service.ts')>(PLUGIN_DIR, 'src/server/service.ts')
const { createTasksService } = await source<typeof import('../../workbench-plugin/src/server/tasks.ts')>(PLUGIN_DIR, 'src/server/tasks.ts')
const { CALL_RECORDS_DIR_NAME, createCallRecordsService } = await source<typeof import('../../workbench-plugin/src/server/callRecords.ts')>(PLUGIN_DIR, 'src/server/callRecords.ts')
const { createBehaviorLog } = await source<typeof import('../../workbench-plugin/src/server/behaviorLog.ts')>(PLUGIN_DIR, 'src/server/behaviorLog.ts')
const { adminGrant, createChannelService, joinGrant, signAccessToken } = await source<typeof import('../../workbench-plugin/src/server/channel.ts')>(PLUGIN_DIR, 'src/server/channel.ts')
const { createCallOutService } = await source<typeof import('../../workbench-plugin/src/server/callOut.ts')>(PLUGIN_DIR, 'src/server/callOut.ts')
const { createDeviceDirectoryService } = await source<typeof import('../../workbench-plugin/src/server/deviceDirectory.ts')>(PLUGIN_DIR, 'src/server/deviceDirectory.ts')
const { createCallState } = await source<typeof import('../../workbench-plugin/src/server/callState.ts')>(PLUGIN_DIR, 'src/server/callState.ts')
const { channelWorkerForRoute, createChannelWorkerFleet } = await source<typeof import('../../workbench-plugin/src/server/channelWorkerFleet.ts')>(PLUGIN_DIR, 'src/server/channelWorkerFleet.ts')
const { CALL_TOOL_DOING, CALL_TOOL_REMEMBER } = await source<typeof import('../../workbench-plugin/src/server/rtcCall.ts')>(PLUGIN_DIR, 'src/server/rtcCall.ts')
type ChannelCredentialStore = import('../../workbench-plugin/src/server/channelCredentials.ts').ChannelCredentialStore
type SpawnedWorker = import('../../workbench-plugin/src/server/channelWorker.ts').SpawnedWorker

const HOME = arg('home') ?? mkdtempSync(join(tmpdir(), 'wb-two-workers-e2e-'))
const KEEP = process.argv.includes('--keep')
const IDLE_SECONDS = Number(arg('idle-seconds') ?? '30')
const LK_OUT = join(HOME, 'lan-room')
const MAC_ID = '6d6a1f0e9b8c47a5a1c2d3e4f5a6b7c8'
const LAN_ROOM = `wb-local-${MAC_ID.slice(0, 8)}`
const CLOUD_PORT = 7993
const CLOUD_URL = `ws://127.0.0.1:${CLOUD_PORT}`
const CLOUD_ROOM = 'wb-acce2e0000000001'
const CLOUD_KEY = 'twoworkerscloudkey'
/** 只给这台自己起的「云房间」替身用的一串假钥匙,不是任何人的密钥。 */
const CLOUD_SECRET = 'two-workers-e2e-cloud-secret-not-a-real-key'
const WORKER_TOKEN = `e2e-worker-${randomUUID()}`
const HANDSET = { identity: 'wb-phone-e2e-handset', device: 'e2e-handset', kind: 'handset' as const }
const PHONE = { identity: 'wb-phone-e2e-phone', device: 'e2e-phone', kind: 'phone' as const }

function stamp(): string {
  const now = new Date()
  return `${now.toTimeString().slice(0, 8)}.${String(now.getMilliseconds()).padStart(3, '0')}`
}
function log(line: string): void { console.log(`${stamp()}  ${line}`) }
function sleep(ms: number): Promise<void> { return new Promise(resolve => setTimeout(resolve, ms)) }
async function waitFor(what: string, probe: () => boolean | Promise<boolean>, timeoutMs = 30_000): Promise<number> {
  const started = Date.now()
  const until = started + timeoutMs
  while (Date.now() < until) {
    if (await Promise.resolve().then(probe).catch(() => false)) return Date.now() - started
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
function run(file: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => execFile(file, args, { maxBuffer: 8 * 1024 * 1024 }, (err, stdout) => (err === null ? resolve(stdout) : reject(err))))
}

const children: ChildProcess[] = []
const servers: Server[] = []

// ———————————————————————— 两间房 ————————————————————————

async function startLanRoom(): Promise<{ key: string, secret: string, lanIp: string }> {
  await run('/bin/zsh', [join(REPO, 'scripts', 'probe-lan-primary', 'lk-up.sh'), LK_OUT])
  const keys = Object.fromEntries(readFileSync(join(LK_OUT, 'keys.env'), 'utf8').trim().split('\n').map(line => line.split('=') as [string, string]))
  const up = JSON.parse(readFileSync(join(LK_OUT, 'up.json'), 'utf8')) as { lan_ip: string }
  log(`本机房间(lk-up.sh)起来了:ws://127.0.0.1:7880(node_ip ${up.lan_ip},房间 ${LAN_ROOM})`)
  return { key: keys.LK_KEY as string, secret: keys.LK_SECRET as string, lanIp: up.lan_ip }
}

async function startCloudRoom(): Promise<void> {
  const config = join(HOME, 'cloud-livekit.yaml')
  writeFileSync(config, [
    `port: ${CLOUD_PORT}`, 'bind_addresses: ["127.0.0.1"]', 'rtc:', `  tcp_port: ${CLOUD_PORT + 1}`, `  udp_port: ${CLOUD_PORT + 2}`,
    '  use_external_ip: false', 'keys:', `  ${CLOUD_KEY}: ${CLOUD_SECRET}`, 'logging:', '  level: warn', '',
  ].join('\n'))
  const lk = spawn('livekit-server', ['--config', config, '--node-ip', '127.0.0.1'], { stdio: ['ignore', 'ignore', 'pipe'] })
  children.push(lk)
  lk.stderr?.pipe(createWriteStream(join(HOME, 'cloud-livekit.log')))
  await waitFor('云房间替身', async () => (await fetch(`http://127.0.0.1:${CLOUD_PORT}`)).status < 500, 20_000)
  log(`云房间替身起来了:${CLOUD_URL}(房间 ${CLOUD_ROOM})`)
}

function sign(room: string, key: string, secret: string, who: { identity: string, device: string, kind: 'phone' | 'handset' }): string {
  return signAccessToken({
    apiKey: key, apiSecret: secret, identity: who.identity, grant: joinGrant(room), name: who.kind === 'handset' ? 'e2e 听筒' : 'e2e 手机',
    attributes: { wb_device_id: who.device, wb_kind: who.kind },
    metadata: JSON.stringify({ device_id: who.device, name: who.kind === 'handset' ? 'e2e 听筒' : 'e2e 手机', kind: 'phone' }),
    ttlSeconds: 6 * 3600, nowSeconds: Math.floor(Date.now() / 1000),
  })
}

/** 假中转:替云房间替身签票;`mode` 切成 not_linked 就是「没登录」。 */
let relayMode: 'ok' | 'not_linked' = 'ok'
const NOT_LINKED = '通道密钥由服务器在登录后下发。这台机器还没领到服务器凭证。'
const relay: ChannelCredentialStore = {
  async get() {
    return relayMode === 'ok'
      ? { ok: true, credentials: { livekit: { configured: true, url: CLOUD_URL, room: CLOUD_ROOM, token_ttl_seconds: 6 * 3600 } } }
      : { ok: false, reason: 'not_linked', error: NOT_LINKED }
  },
  async issueToken(input) {
    if (relayMode !== 'ok') return { ok: false, reason: 'not_linked', error: NOT_LINKED }
    const nowSeconds = Math.floor(Date.now() / 1000)
    const token = signAccessToken({
      apiKey: CLOUD_KEY, apiSecret: CLOUD_SECRET, identity: input.identity,
      grant: input.kind === 'admin' ? adminGrant(CLOUD_ROOM) : joinGrant(CLOUD_ROOM),
      ...(input.name === undefined ? {} : { name: input.name }),
      ...(input.attributes === undefined ? {} : { attributes: input.attributes }),
      ...(input.metadata === undefined ? {} : { metadata: input.metadata }),
      ttlSeconds: 6 * 3600, nowSeconds,
    })
    return { ok: true, ticket: { url: CLOUD_URL, room: CLOUD_ROOM, identity: input.identity, token, expires_at: nowSeconds + 6 * 3600 } }
  },
  view() { return { cached: relayMode === 'ok', livekit_configured: relayMode === 'ok' } },
  forget() {},
}

// ———————————————————————— 假 8792 / 假接话模型 / 假火山(同 call-record-e2e.ts) ————————————————————————

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

let ttsCalls = 0
async function startFakeButler(): Promise<number> {
  const server = createServer((req, res) => {
    void (async () => {
      const path = (req.url ?? '').split('?')[0] ?? ''
      const body = (await readBody(req)).toString('utf8')
      if (path === '/health') { json(res, 200, { ok: true }); return }
      if (path === '/api/tts') {
        ttsCalls += 1
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

async function startStubLlm(): Promise<number> {
  const server = createServer((req, res) => {
    void (async () => {
      await readBody(req)
      if (!(req.url ?? '').includes('/chat/completions')) { json(res, 404, { error: 'stub' }); return }
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' })
      const id = `chatcmpl-${randomUUID()}`
      const created = Math.floor(Date.now() / 1000)
      const chunk = (delta: Record<string, unknown>, finish: string | null): string =>
        `data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created, model: 'deepseek-v4-flash', choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`
      res.write(chunk({ role: 'assistant', content: '' }, null))
      res.write(chunk({ content: '好的,知道了。' }, null))
      res.write(chunk({}, 'stop'))
      res.end('data: [DONE]\n\n')
    })()
  })
  servers.push(server)
  return await listen(server)
}

const UTTERANCE = '好的,合同我下午看。'
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
      if (rms > 300) { speaking = true; silenceMs = 0; return }
      if (!speaking) return
      silenceMs += (samples / 16000) * 1000
      if (silenceMs >= endWindowMs) {
        speaking = false
        send({ text: UTTERANCE, utterances: [{ text: UTTERANCE, definite: true }, { text: '', definite: false }] })
      }
    })
  })
  servers.push(server)
  return await listen(server)
}

// ———————————————————————— 真 8791 + 真的两条工人看管 ————————————————————————

const DATA = join(HOME, '.dsh', 'workbench')
const WORKDIR = join(HOME, '工作目录')
const tasks = createTasksService({ file: join(DATA, 'tasks.json') })
const callRecords = createCallRecordsService({ file: join(DATA, 'calls.json'), workdir: () => WORKDIR, fallbackDir: join(DATA, CALL_RECORDS_DIR_NAME) })
const behaviorLog = createBehaviorLog({ dir: join(DATA, '行为账') })
/** 台账每一通收场了几次(onSettled)。 */
const settledCount = new Map<string, string[]>()
const callOut = createCallOutService({
  file: join(DATA, 'call-out.json'),
  // 免打扰时段挪开:这一跑要的是响铃那一种,几点跑都一样。
  onSettled: entry => settledCount.set(entry.id, [...(settledCount.get(entry.id) ?? []), entry.state]),
})

let wbUrl = ''
const workerPids = new Map<string, number>()

function workerEnv(ports: { butler: number, llm: number, volc: number }): Record<string, string> {
  return {
    PATH: '/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin',
    HOME,
    LANG: 'en_US.UTF-8',
    CHANNEL_WORKER_DIR: WORKER_DIR,
    WORKBENCH_CHANNEL_WORKBENCH_URL: wbUrl,
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
    WORKBENCH_CHANNEL_DEVICE_NAME: 'two-workers-e2e',
    WORKBENCH_CHANNEL_LOG_LEVEL: 'warn',
    WORKBENCH_CHANNEL_FIRST_VOICE: 'off',
    WORKBENCH_WORKER_ACTOR: WORKER_TOKEN,
    WORKBENCH_CHANNEL_LOAD_GUARD_ONLY_UNDER: String(process.pid),
  }
}

/** spawn 只带给它的那几格环境(不漏这个进程自己的环境)。 */
function cleanSpawn(input: { script: string, env: Record<string, string>, logFd?: number }): SpawnedWorker {
  const out = input.logFd ?? 'ignore'
  const child = spawn(input.script, [], { detached: false, stdio: ['ignore', out, out], env: input.env })
  children.push(child)
  if (child.pid !== undefined) workerPids.set(input.env.WORKBENCH_CHANNEL_WORKER_ROUTE ?? '?', child.pid)
  return {
    ...(child.pid === undefined ? {} : { pid: child.pid }),
    kill: (signal) => { try { child.kill(signal) } catch { /* 已经没了 */ } },
    onExit: handler => child.on('exit', (code, signal) => handler({ code, signal })),
    onError: handler => child.on('error', handler),
  }
}

async function startWorkbench(lan: { key: string, secret: string, lanIp: string }, ports: { butler: number, llm: number, volc: number }) {
  mkdirSync(join(HOME, '.dsh', 'bin'), { recursive: true })
  mkdirSync(DATA, { recursive: true })
  // 借维护者那份 node(只读;deploy/channel-start 先找 $HOME/.dsh/node/bin/node)。
  if (existsSync(join(homedir(), '.dsh', 'node')) && !existsSync(join(HOME, '.dsh', 'node'))) symlinkSync(join(homedir(), '.dsh', 'node'), join(HOME, '.dsh', 'node'))
  const script = join(HOME, '.dsh', 'bin', 'channel-start')
  writeFileSync(script, readFileSync(join(REPO, 'deploy', 'channel-start')))
  chmodSync(script, 0o755)
  writeFileSync(join(DATA, 'channel.json'), `${JSON.stringify({ url: 'ws://127.0.0.1:7880', api_key: lan.key, api_secret: lan.secret }, null, 2)}\n`, { mode: 0o600 })
  const agentsFile = join(HOME, '.dsh', 'AGENTS.md')
  writeFileSync(agentsFile, '我叫 周到。\n')
  const channel = createChannelService({
    agentsFile,
    env: {},
    configFile: join(DATA, 'channel.json'),
    rememberTool: CALL_TOOL_REMEMBER,
    doingTool: CALL_TOOL_DOING,
    machineId: async () => MAC_ID,
    lanAddresses: () => [lan.lanIp],
    remote: relay,
  })
  const channelWorker = createChannelWorkerFleet({
    routes: options => channel.workerRoutes(options),
    make: route => channelWorkerForRoute(route, { env: workerEnv(ports), home: HOME, dshEnv: { HOME }, log }, { script, spawnImpl: cleanSpawn }),
    log,
  })
  await callOut.load()
  // 白天的规矩:免打扰时段挪到一个跑不到的空档,来电照响。
  await callOut.setConfig({ quiet_from: '04:00', quiet_to: '04:01' })
  const server = await startWorkbenchServer({
    port: 0,
    service: createWorkbenchService(),
    tickIntervalMs: 0,
    heartbeatMs: 0,
    tasks,
    callRecords,
    behaviorLog,
    channel,
    channelWorker,
    callOut,
    deviceDirectory: createDeviceDirectoryService(),
    callState: createCallState(),
    machineId: async () => MAC_ID,
    actorTokens: { butler: `e2e-butler-${randomUUID()}`, worker: WORKER_TOKEN },
  })
  servers.push(server as unknown as Server)
  wbUrl = server.url
  log(`真 8791(这份仓库的 workbench-plugin)起来了:${server.url},数据在 ${DATA}`)
  return { channel, channelWorker, server }
}

async function get(path: string): Promise<Record<string, unknown>> {
  return await (await fetch(`${wbUrl}${path}`)).json() as Record<string, unknown>
}

// ———————————————————————— 假设备(同 dev/fake-phone.ts --incoming) ————————————————————————

interface Device {
  who: string
  rings: { call_id: string, at: number }[]
  ringEnds: { call_id: string, outcome: string, text?: string, at: number }[]
  rpc: (request: Record<string, unknown>) => Promise<Record<string, unknown>>
  speak: (wav: string) => Promise<number>
  herVoice: () => { speaking: boolean, lastLoudAt: number, firstLoudSince: (at: number) => number | undefined, loudFrames: number }
  stop: () => Promise<void>
}

async function startDevice(url: string, token: string, who: string): Promise<Device> {
  const room = new Room()
  const pending = new Map<string, (message: Record<string, unknown>) => void>()
  const rings: Device['rings'] = []
  const ringEnds: Device['ringEnds'] = []
  let textQueue: Promise<void> = Promise.resolve()
  room.registerTextStreamHandler(RPC_TOPIC, (reader, from) => {
    textQueue = textQueue.then(async () => {
      if (from?.identity !== WORKER_IDENTITY) return
      const text = await reader.readAll()
      let message: Record<string, unknown>
      try { message = JSON.parse(text) as Record<string, unknown> } catch { return }
      if (message.type === 'ring' && typeof message.call_id === 'string') { rings.push({ call_id: message.call_id, at: Date.now() }); return }
      if (message.type === 'ring_end' && typeof message.call_id === 'string') {
        ringEnds.push({ call_id: message.call_id, outcome: String(message.outcome), ...(typeof message.text === 'string' ? { text: message.text } : {}), at: Date.now() })
        return
      }
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
  let loudFrames = 0
  room.on(RoomEvent.TrackSubscribed, (track, _pub, participant) => {
    if (track.kind !== TrackKind.KIND_AUDIO || participant.identity !== WORKER_IDENTITY) return
    void (async () => {
      for await (const frame of new AudioStream(track)) {
        let peak = 0
        for (let i = 0; i < frame.data.length; i += 4) { const v = Math.abs(frame.data[i] as number); if (v > peak) peak = v }
        if (peak > 600) { loudRun += 1; quietRun = 0; lastLoudAt = Date.now(); loudFrames += 1 }
        else { quietRun += 1; loudRun = 0 }
        if (!speaking && loudRun === 5) { speaking = true; loudStarts.push(Date.now() - 40) }
        if (speaking && quietRun >= 80) speaking = false
      }
    })()
  })
  await room.connect(url, token, { autoSubscribe: true, dynacast: true })
  const sampleRate = 48000
  const sourceTrack = new AudioSource(sampleRate, 1, 200)
  const track = LocalAudioTrack.createAudioTrack('mic', sourceTrack)
  const options = new TrackPublishOptions()
  options.source = TrackSource.SOURCE_MICROPHONE
  await room.localParticipant?.publishTrack(track, options)
  const samplesPerFrame = Math.round(sampleRate / 100)
  const silence = new Int16Array(samplesPerFrame)
  let queue: Int16Array[] = []
  let onDrained: ((at: number) => void) | undefined
  let running = true
  const pump = (async () => {
    while (running) {
      const next = queue.shift()
      try { await sourceTrack.captureFrame(new AudioFrame(next ?? silence, sampleRate, 1, samplesPerFrame)) }
      catch { if (!running) break }
      if (next !== undefined && queue.length === 0 && onDrained !== undefined) {
        const done = onDrained
        onDrained = undefined
        done(Date.now() + sourceTrack.queuedDuration)
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
    who,
    rings,
    ringEnds,
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
    herVoice: () => ({ speaking, lastLoudAt, loudFrames, firstLoudSince: (at: number) => loudStarts.find(start => start >= at) }),
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
  await run('/usr/bin/say', ['-v', 'Tingting', '-o', aiff, text])
  await run('/usr/bin/afconvert', ['-f', 'WAVE', '-d', 'LEI16@48000', '-c', '1', aiff, wav])
  return wav
}

// ———————————————————————— 量 ————————————————————————

/** `ps` 的 TIME 列(`M:SS.ss` 或 `H:MM:SS`)→ 秒。 */
function secondsOf(time: string): number {
  const parts = time.trim().split(':').map(Number)
  return parts.reduce((total, part) => total * 60 + part, 0)
}
async function sampleOf(pid: number): Promise<{ rss_mb: number, cpu_s: number } | undefined> {
  const out = await run('/bin/ps', ['-o', 'rss=,time=', '-p', String(pid)]).catch(() => '')
  const match = /^\s*(\d+)\s+(\S+)/.exec(out)
  if (match === null) return undefined
  return { rss_mb: Math.round(Number(match[1]) / 1024), cpu_s: secondsOf(match[2] as string) }
}
async function measure(label: string, routes: readonly string[], seconds: number): Promise<Record<string, { rss_mb: number, cpu_pct: number }>> {
  const before = new Map<string, { rss_mb: number, cpu_s: number }>()
  for (const route of routes) { const s = await sampleOf(workerPids.get(route) ?? -1); if (s !== undefined) before.set(route, s) }
  const loadBefore = (await run('/usr/sbin/sysctl', ['-n', 'vm.loadavg']).catch(() => '')).trim()
  await sleep(seconds * 1000)
  const out: Record<string, { rss_mb: number, cpu_pct: number }> = {}
  for (const route of routes) {
    const after = await sampleOf(workerPids.get(route) ?? -1)
    const first = before.get(route)
    if (after === undefined || first === undefined) continue
    out[route] = { rss_mb: after.rss_mb, cpu_pct: Math.round(((after.cpu_s - first.cpu_s) / seconds) * 1000) / 10 }
  }
  log(`量「${label}」${seconds} 秒(负载 ${loadBefore}):${JSON.stringify(out)}`)
  return out
}

// ———————————————————————— 一通来电 ————————————————————————

interface CallRun {
  id: string
  rang: { lan: boolean, cloud: boolean, gap_ms?: number }
  answered_by: string
  answer_ok: boolean
  /** 接起 → 先接那一边听见开场白第一个字。 */
  opener_ms?: number
  /** 接起 → 另一间房收到 ring_end。 */
  other_ring_end_ms?: number
  other_ring_end?: { outcome: string, text?: string }
  /** 另一间房那台随后再按接起的回话。 */
  other_answer?: Record<string, unknown>
  other_heard_frames: number
  replied: boolean
  ledger: Record<string, unknown> | undefined
  settled: string[]
  /** 这一通新落下的通话记录里,是这一通的几份、别的几份(另一条工人多报一份就是这一格)。 */
  records: { this_call: number, others: number }
}

async function oneCall(label: string, title: string, devices: { lan: Device, cloud: Device }, first: 'lan' | 'cloud', wav: string): Promise<CallRun> {
  log(`—— ${label}:排一通「${title}」,两间房都该响;${first === 'cloud' ? '手机(云房间)' : '听筒(本机房间)'}先接`)
  const before = new Set((await callRecords.view()).recent.map(one => one.id))
  const queued = await callOut.request({ reason: 'confirm', item_id: `t-${label}`, title })
  const id = queued.entry?.id ?? ''
  const rang = { lan: false, cloud: false } as CallRun['rang']
  await waitFor('两间房都响', () => devices.lan.rings.some(one => one.call_id === id) && devices.cloud.rings.some(one => one.call_id === id), 20_000)
    .catch(() => log('20 秒内没有两间房都响'))
  const lanRing = devices.lan.rings.find(one => one.call_id === id)
  const cloudRing = devices.cloud.rings.find(one => one.call_id === id)
  rang.lan = lanRing !== undefined
  rang.cloud = cloudRing !== undefined
  if (lanRing !== undefined && cloudRing !== undefined) rang.gap_ms = Math.abs(lanRing.at - cloudRing.at)
  log(`响了:本机房间 ${rang.lan ? '✓' : '✗'} · 云房间 ${rang.cloud ? '✓' : '✗'}(两边相差 ${rang.gap_ms ?? '?'} ms)`)
  const winner = devices[first]
  const loser = devices[first === 'cloud' ? 'lan' : 'cloud']
  const loserFramesBefore = loser.herVoice().loudFrames
  const answeredAt = Date.now()
  const answer = await winner.rpc({ type: 'call', action: 'answer', call_id: id }).catch((err: unknown) => ({ ok: false, error: (err as Error).message }))
  log(`${winner.who} 按接起 → ${answer.ok === true ? '接上了' : `没接上:${String(answer.error)}`}`)
  let openerMs: number | undefined
  await waitFor('开场白', () => winner.herVoice().firstLoudSince(answeredAt) !== undefined, 20_000)
    .then(() => { openerMs = (winner.herVoice().firstLoudSince(answeredAt) as number) - answeredAt })
    .catch(() => log('20 秒没听见开场白'))
  let otherEndMs: number | undefined
  await waitFor('另一间房收铃', () => loser.ringEnds.some(one => one.call_id === id), 10_000)
    .then(() => { otherEndMs = (loser.ringEnds.find(one => one.call_id === id)?.at ?? answeredAt) - answeredAt })
    .catch(() => log('10 秒内另一间房没收到 ring_end'))
  const otherEnd = loser.ringEnds.find(one => one.call_id === id)
  const otherAnswer = await loser.rpc({ type: 'call', action: 'answer', call_id: id }).catch((err: unknown) => ({ ok: false, error: (err as Error).message }))
  log(`${loser.who} 随后按接起 → ${otherAnswer.ok === true ? '接上了(不该)' : `被拒:${String(otherAnswer.error)}`}`)
  // 先接那一边说一句、听她回
  await waitFor('开场白说完', () => { const v = winner.herVoice(); return !v.speaking && v.lastLoudAt > 0 && Date.now() - v.lastLoudAt > 1200 }, 30_000).catch(() => {})
  const spokeEnd = await winner.speak(wav)
  let replied = false
  await waitFor('她回话', () => winner.herVoice().firstLoudSince(spokeEnd) !== undefined, 45_000).then(() => { replied = true }).catch(() => log('45 秒她没回话'))
  await waitFor('她说完', () => { const v = winner.herVoice(); return !v.speaking && Date.now() - v.lastLoudAt > 1500 }, 30_000).catch(() => {})
  await winner.rpc({ type: 'call', action: 'hangup' }).catch(() => {})
  log(`${winner.who} 挂了`)
  if (first === 'cloud') {
    // 手机接的那一通由手机报(照 App 那条路:带台账那一通的 id)。
    await fetch(`${wbUrl}/butler/call/record`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-workbench-actor': WORKER_TOKEN },
      body: JSON.stringify({ call_id: id, durationSeconds: 8, transcript: [{ who: 'butler', text: '有件事要你确认。' }, { who: 'me', text: UTTERANCE }] }),
    })
  }
  // 等工人那边(听筒那一通由工人报)落下,再多等几秒看另一条工人会不会也报。
  await waitFor('通话记录', async () => (await callRecords.view()).recent.some(one => one.id === id), 20_000).catch(() => log('20 秒没等到这一通的记录'))
  await sleep(4000)
  const fresh = (await callRecords.view()).recent.filter(one => !before.has(one.id))
  // 两边的工人都回过话(另一间房那条下一拍回「在别处接了」)。
  await waitFor('两间房都回过话', () => (callOut.view().entries.find(one => one.id === id)?.rooms_done ?? []).length >= 2, 10_000).catch(() => {})
  const ledger = callOut.view().entries.find(one => one.id === id)
  return {
    id,
    rang,
    answered_by: winner.who,
    answer_ok: answer.ok === true,
    ...(openerMs === undefined ? {} : { opener_ms: openerMs }),
    ...(otherEndMs === undefined ? {} : { other_ring_end_ms: otherEndMs }),
    ...(otherEnd === undefined ? {} : { other_ring_end: { outcome: otherEnd.outcome, ...(otherEnd.text === undefined ? {} : { text: otherEnd.text }) } }),
    other_answer: otherAnswer,
    other_heard_frames: loser.herVoice().loudFrames - loserFramesBefore,
    replied,
    ledger: ledger === undefined ? undefined : { state: ledger.state, rooms: ledger.rooms, rooms_done: ledger.rooms_done, answered_room: ledger.answered_room, answered_device: ledger.answered_device },
    settled: settledCount.get(id) ?? [],
    records: { this_call: fresh.filter(one => one.id === id).length, others: fresh.filter(one => one.id !== id).length },
  }
}

async function race(devices: { lan: Device, cloud: Device }): Promise<{ id: string, ok: boolean[], ledger?: Record<string, unknown> }> {
  log('—— 同时按接起:排一通,两边一起按')
  const queued = await callOut.request({ reason: 'confirm', item_id: 't-race', title: '回王总消息' })
  const id = queued.entry?.id ?? ''
  await waitFor('两间房都响', () => devices.lan.rings.some(one => one.call_id === id) && devices.cloud.rings.some(one => one.call_id === id), 20_000).catch(() => {})
  const answers = await Promise.all([devices.lan, devices.cloud].map(one => one.rpc({ type: 'call', action: 'answer', call_id: id }).catch(() => ({ ok: false }))))
  const ok = answers.map(one => one.ok === true)
  log(`同时按:本机房间 ${ok[0] ? '接上' : '被拒'} · 云房间 ${ok[1] ? '接上' : '被拒'}`)
  await sleep(3000)
  for (const [i, one] of [devices.lan, devices.cloud].entries()) if (ok[i]) await one.rpc({ type: 'call', action: 'hangup' }).catch(() => {})
  await sleep(3000)
  const ledger = callOut.view().entries.find(one => one.id === id)
  return { id, ok, ...(ledger === undefined ? {} : { ledger: { state: ledger.state, answered_room: ledger.answered_room, rooms: ledger.rooms, rooms_done: ledger.rooms_done } }) }
}

// ———————————————————————— 主流程 ————————————————————————

async function main(): Promise<void> {
  mkdirSync(HOME, { recursive: true })
  log(`临时 HOME ${HOME}`)
  const lan = await startLanRoom()
  await startCloudRoom()
  const ports = { butler: await startFakeButler(), llm: await startStubLlm(), volc: await startFakeVolc() }
  log(`假 8792 :${ports.butler} · 假模型 :${ports.llm} · 假火山 :${ports.volc}`)
  const wb = await startWorkbench(lan, ports)
  const startedAt = Date.now()
  await wb.channelWorker.reconcile()
  log(`看管对了一遍路线:${JSON.stringify(wb.channelWorker.view().routes?.map(one => [one.route, one.room, one.running]))}`)
  const workersIn = async (): Promise<{ route: string, in_room: boolean }[]> => (await get('/channel/status')).workers as { route: string, in_room: boolean }[] ?? []
  const joinMs = await waitFor('两条工人都进房', async () => (await workersIn()).length === 2 && (await workersIn()).every(one => one.in_room), 120_000)
  const statusTwo = await get('/channel/status')
  log(`两条工人都进房了(${joinMs} ms):${JSON.stringify(statusTwo.workers)}`)
  const ttsAfterWarm = await waitFor('两条工人的预合成跑完', () => ttsCalls >= 2, 30_000).then(async () => { await sleep(5000); return ttsCalls }).catch(() => ttsCalls)

  const idleEmpty = await measure('两条工人,两间房都没设备', ['lan', 'relay'], IDLE_SECONDS)
  const handset = await startDevice('ws://127.0.0.1:7880', sign(LAN_ROOM, lan.key, lan.secret, HANDSET), '听筒(本机房间)')
  log('假听筒进本机房间了')
  const idleOne = await measure('本机房间有听筒,云房间空着', ['lan', 'relay'], IDLE_SECONDS)
  const phone = await startDevice(CLOUD_URL, sign(CLOUD_ROOM, CLOUD_KEY, CLOUD_SECRET, PHONE), '手机(云房间)')
  log('假手机进云房间了')
  await sleep(3000)
  const online = ((await get('/devices/online')).devices as { identity: string }[] | undefined ?? []).map(one => one.identity).sort()
  const idleBoth = await measure('两间房各有一台设备', ['lan', 'relay'], IDLE_SECONDS)
  const devices = { lan: handset, cloud: phone }
  const wav = await wavOf(UTTERANCE, 'reply')
  const callA = await oneCall('A', '看合同', devices, 'cloud', wav)
  await sleep(2000)
  const callB = await oneCall('B', '报销单', devices, 'lan', wav)
  await sleep(2000)
  const raced = await race(devices)

  // ⑤ 没登录:云房间那条停掉
  relayMode = 'not_linked'
  await wb.channelWorker.reconcile({ force: true })
  await waitFor('云房间那条停了', () => wb.channelWorker.view().routes?.find(one => one.route === 'relay')?.running !== true, 15_000).catch(() => {})
  const statusOne = await get('/channel/status')
  const routesOne = wb.channelWorker.view().routes?.map(one => ({ route: one.route, running: one.running }))
  log(`中转说没登录之后:${JSON.stringify(statusOne.workers)}`)
  const idleSingle = await measure('只剩本机房间一条(听筒在房里)', ['lan'], IDLE_SECONDS)

  await handset.stop()
  await phone.stop()
  await behaviorLog.flush()
  const okRecords = (one: CallRun): boolean => one.records.this_call === 1 && one.records.others === 0
  const checks = {
    '两条工人都进房,/channel/status 看得见两条': Array.isArray(statusTwo.workers) && (statusTwo.workers as { in_room: boolean }[]).length === 2 && (statusTwo.workers as { in_room: boolean }[]).every(one => one.in_room),
    '在线设备表两间房合起来(听筒 + 手机)': online.includes(HANDSET.identity) && online.includes(PHONE.identity),
    'A:两间房都响': callA.rang.lan && callA.rang.cloud,
    'A:手机先接、出声;本机房间收铃(canceled)、听筒没听见声音、再按被拒': callA.answer_ok && callA.opener_ms !== undefined && callA.other_ring_end?.outcome === 'canceled' && callA.other_heard_frames === 0 && callA.other_answer?.ok !== true,
    'A:台账一条接了(云房间)、收场只记一次、两间房都回过话': callA.ledger?.state === 'answered' && callA.ledger.answered_room === CLOUD_ROOM && callA.settled.length === 1 && (callA.ledger.rooms_done as string[] | undefined ?? []).length === 2,
    'A:通话记录一份': okRecords(callA),
    'B:两间房都响': callB.rang.lan && callB.rang.cloud,
    'B:听筒先接、出声;云房间收铃、手机没听见声音、再按被拒': callB.answer_ok && callB.opener_ms !== undefined && callB.other_ring_end?.outcome === 'canceled' && callB.other_heard_frames === 0 && callB.other_answer?.ok !== true,
    'B:台账一条接了(本机房间)、收场只记一次': callB.ledger?.state === 'answered' && callB.ledger.answered_room === LAN_ROOM && callB.settled.length === 1,
    'B:通话记录一份(本机房间那条工人报的)': okRecords(callB),
    '同时按接起:只有一边接上': raced.ok.filter(Boolean).length === 1 && raced.ledger?.state === 'answered',
    '没登录之后只剩本机那条': (statusOne.workers as unknown[] | undefined)?.length === 1 && routesOne?.find(one => one.route === 'relay')?.running !== true,
  }
  const result = {
    home: HOME,
    lan_room: LAN_ROOM,
    cloud_room: CLOUD_ROOM,
    workers_join_ms: joinMs,
    since_start_ms: Date.now() - startedAt,
    tts_calls_after_warm: ttsAfterWarm,
    status_two: statusTwo.workers,
    process_two: (statusTwo.process as { routes?: unknown } | undefined)?.routes,
    status_one: statusOne.workers,
    online,
    calls: [callA, callB],
    race: raced,
    resources: { idle_both_empty: idleEmpty, idle_lan_device_only: idleOne, idle_both_devices: idleBoth, single_worker: idleSingle },
    checks,
  }
  writeFileSync(join(HOME, 'result.json'), `${JSON.stringify(result, null, 2)}\n`)
  console.log('\n—— 结果 ——')
  for (const [name, ok] of Object.entries(checks)) console.log(`${ok ? '✓' : '✗'} ${name}`)
  console.log(`详情:${join(HOME, 'result.json')}`)
  shutdown(Object.values(checks).every(Boolean) ? 0 : 1, wb.channelWorker)
}

let stopping = false
function shutdown(code: number, fleet?: { dispose: () => Promise<void> }): void {
  if (stopping) return
  stopping = true
  void (async () => {
    try { await fleet?.dispose() } catch { /* 已经停了 */ }
    for (const child of children) { try { child.kill('SIGTERM') } catch { /* 已经退了 */ } }
    try { process.kill(Number(readFileSync(join(LK_OUT, 'lk.pid'), 'utf8').trim()), 'SIGTERM') } catch { /* 没起来 / 已经退了 */ }
    for (const server of servers) { try { server.close() } catch { /* 已经关了 */ } }
    setTimeout(() => {
      if (!KEEP && code === 0) { try { rmSync(HOME, { recursive: true, force: true }) } catch { /* 删不掉就留着 */ } }
      process.exit(code)
    }, 1500)
  })()
}

process.on('SIGINT', () => shutdown(130))
main().catch((err: unknown) => {
  console.error(`跑挂了:${(err as Error)?.stack ?? String(err)}`)
  shutdown(1)
})
