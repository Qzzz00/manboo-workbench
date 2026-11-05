/**
 * 压测:**这台 Mac 忙的时候,电话还接不接得住**(2026-09-25,卡 fix/call-under-load-and-name)。
 *
 * 为什么要它:维护者 09-24 晚用手机走引导,统筹同时在这台 Mac 上跑两份插件全量 vitest、tsc、
 * pnpm install、pnpm build。工人日志里 VAD 落后 31 秒、火山回 45000081(等包超时),
 * 她半分钟不接话(「我如果不说话他也不说话」)。中秋起他要**边打电话边派活**,
 * 活就在这台 Mac 上构建、测试 —— 「忙的时候接不接得住」必须是一个能反复量的数。
 *
 * 它起的东西**全是自己的**,一样都不碰维护者那一套(~/.dsh、真 8791、真房间一个都不碰):
 *   ① 自己的 livekit-server(7990/7991/7992,不是 7880),开发用的一对假钥匙;
 *   ② 假 8791(签进房凭证、给人设、其余空答)、假 8792(合成回一段正弦,150ms)、
 *      假接话模型(流式回一句话,首字固定晚 300ms)、假火山流式识别(按能量判停;
 *      超过 N 秒没收到包就回 45000081 —— 与真火山同一个码、同一种帧);
 *   ③ 真的工人进程(这份仓库的 src/main.ts),HOME 指到一个临时目录,
 *      外加一只听诊器(dev/load-diag-preload.mjs,**不改工人一行代码**);
 *   ④ 一台假手机:进房、打一通电话(call.start)、按真时间把一段 `say` 合成的话当麦克风放出去,
 *      量「他说完 → 她开口」;
 *   ⑤ 可选的负载:`--load 2` = 他打电话的同时跑两份插件全量 vitest(nice 0,故意压满 CPU),
 *      跑完一份就再起一份,直到这通电话打完。
 *
 * 量什么(写进 --out 那份 JSON,并打一张表):
 *   - 每一回合「他说完 → 她开口」(假手机这一头的墙钟);
 *   - 工人日志里 VAD 落后多少(框架那行 `VAD inference is slower than realtime` 的 delay,
 *     以及这张卡新加的「VAD 落后」那一行);
 *   - 假火山那头**两包音频之间最长隔了多久**(推流断没断)、回了几次 45000081;
 *   - 听诊器:工人事件循环最长卡多久、每秒吃到多少 CPU、换页多少;
 *   - 系统负载、swap、内存压力档。
 *
 * 用法(在 channel-worker/ 下):
 *   node dev/load-call.ts --turns 10 --out /tmp/x.json                  # 不加负载(基线)
 *   node dev/load-call.ts --turns 10 --load 2 --out /tmp/y.json         # 两份全量 vitest 压着
 * 选项:
 *   --label 名字            结果里的标签(「改前·压测」之类)
 *   --home 目录             工人的临时 HOME(缺省 mktemp)
 *   --node 路径             工人用哪个 node(缺省 ~/.dsh/node/bin/node,没有就用当前这个)
 *   --volc-timeout 毫秒     假火山多久收不到包就回 45000081(缺省 8000;真火山的阈值官方没公布)
 *   --load N                并行几份负载(缺省 0)
 *   --load-policy P         负载本身用什么档跑:none(缺省,nice 0)| nice(nice -n 15)| utility | background
 *                           ——量「派出去的活降一档」那一半用
 *   --load-cmd '命令'        缺省 `npx vitest run --reporter=dot`,在 ../workbench-plugin 里跑
 *   --warmup 毫秒           负载起来之后等多久再开始说话(缺省 20000,让负载先爬到满)
 *   --worker-env K=V        多给工人一个环境变量(可重复)
 *   --worker-main 路径      跑哪一份工人入口(缺省这份仓库的 src/main.ts)。量「改前」时把 origin/main 的
 *                           src 解到 channel-worker/.base-src/ 再指过去(依赖照样从 channel-worker/node_modules 解析)
 *   --linger 秒             挂断之后手机**留在房里**再待多久(缺省 0 = 挂断就走,与以前一样)。
 *                           2026-09-25(卡 fix/evening-gaps 第 1 条):量「挂断之后工人还在不在听、火山连接关没关」——
 *                           手机从 09-22 起常驻房间,挂断之后并不离房
 *   --phone-hangup 做法     挂断那一下手机对麦克风做什么:
 *                           keep(缺省)= 09-25 以前的手机包:轨道留在房里、一直推(静音)帧;
 *                           unpublish  = 这一版的手机包:撤掉轨道、停止录音
 *   --call normal|onboarding  打普通电话(缺省)还是引导那一通(假 8791 给一份「习惯」阶段的简报,不念开场白)
 *   --mic-after-start       麦克风等接通那一条回话之后才发布(这一版手机包的顺序);缺省是进房就发布(老顺序)
 *   --phone app             手机换成**真 App 的通话代码**(2026-09-25 返工):无头 Chrome 开 butler-app/dev/app-call,
 *                           通道层、房间连接、通话状态机都是 butler-app/src 原样那几份;冷启动常驻房间 → 点「通话」→
 *                           普通电话由假麦克风说那句话、引导那一通打字问一句(`--typed '…'`)→ 挂断 → 留房看识别连接。
 *                           没接通就把那一页记下的每一步、同一段的工人日志摆出来(卡在哪一步一眼看得见)
 *     --gum fake|silent-suspended  假麦克风:放录好的话(缺省)| 统筹真机那一招(没有手势建的 AudioContext 静音轨道)
 *     --stall-mic             那一页里「发布麦克风」永远不回(模拟网络慢时 livekit 的协商重试拖一分多钟)
 *     --app-src 目录          那一页引哪一份 App 代码(缺省 butler-app/src;量「改前」:
 *                             git archive <提交> butler-app/src | tar -x -C butler-app/dev/app-call/.base --strip-components=1,
 *                             再 --app-src ../butler-app/dev/app-call/.base/src)
 *     --chrome 路径           无头 Chrome(缺省 Playwright 装的 Chrome for Testing)
 *   结果里 `after_hangup` 那一段:挂断之后火山收到几包、最后一包隔多久、连接多久关;
 *   工人每秒跑几次 VAD 推理(听诊器在 onnxruntime 上数的,不经工人日志)、每秒吃多少 CPU;工人的「收音开了 / 关了」那几行
 *
 * **跑之前先看维护者是不是在打电话**(`tail -n 30 ~/.dsh/workbench/logs/channel-worker.log`
 * 最近两分钟有没有「他说 / 她说」);在打就别跑 —— 负载是真的会拖慢这台 Mac。
 */
import { execFile, spawn, type ChildProcess } from 'node:child_process'
import { createHmac, randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync, createWriteStream } from 'node:fs'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { homedir, loadavg, tmpdir } from 'node:os'
import { join, resolve as resolvePath } from 'node:path'
import { gunzipSync, gzipSync } from 'node:zlib'
import { WebSocketServer, WebSocket as WsClient, type WebSocket } from 'ws'
import { AudioFrame, AudioSource, AudioStream, LocalAudioTrack, Room, RoomEvent, TrackKind, TrackPublishOptions, TrackSource } from '@livekit/rtc-node'
import { COMP_GZIP, FLAG_POS_SEQUENCE, MSG_FULL_SERVER, MSG_SERVER_ERROR, SER_JSON, buildFrame } from '../src/asr/volcProtocol.ts'
import { RPC_TOPIC, WORKER_IDENTITY } from '../src/rpc.ts'
import { pcmOfWav } from '../src/tts/butlerTts.ts'

// ———————————————————————— 参数 ————————————————————————

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`)
  return index >= 0 ? process.argv[index + 1] : undefined
}
function args(name: string): string[] {
  const out: string[] = []
  process.argv.forEach((value, index) => { if (value === `--${name}`) { const next = process.argv[index + 1]; if (next !== undefined) out.push(next) } })
  return out
}

const WORKER_DIR = resolvePath(import.meta.dirname, '..')
const PLUGIN_DIR = resolvePath(WORKER_DIR, '..', 'workbench-plugin')
const TURNS = Number(arg('turns') ?? 8)
const LABEL = arg('label') ?? (Number(arg('load') ?? 0) > 0 ? '压测' : '基线')
const OUT = arg('out')
const VOLC_TIMEOUT_MS = Number(arg('volc-timeout') ?? 8000)
const LOAD_COUNT = Number(arg('load') ?? 0)
const LOAD_POLICY = (arg('load-policy') ?? 'none') as 'none' | 'nice' | 'utility' | 'background'
const LOAD_CMD = arg('load-cmd') ?? 'npx vitest run --reporter=dot'
const WARMUP_MS = Number(arg('warmup') ?? (LOAD_COUNT > 0 ? 20000 : 3000))
const HOME = arg('home') ?? mkdtempSync(join(tmpdir(), 'wb-load-call-'))
const DSH_NODE = join(homedir(), '.dsh', 'node', 'bin', 'node')
const NODE_BIN = arg('node') ?? (existsSync(DSH_NODE) ? DSH_NODE : process.execPath)
const WORKER_MAIN = resolvePath(arg('worker-main') ?? join(WORKER_DIR, 'src', 'main.ts'))
const LINGER_MS = Math.max(0, Number(arg('linger') ?? 0)) * 1000
const PHONE_HANGUP = (arg('phone-hangup') ?? 'keep') as 'keep' | 'unpublish'
/** 打哪一种电话:普通通话(call.start / call.hangup)还是引导那一通(onboarding.start / onboarding.stop)。 */
const CALL_KIND = (arg('call') ?? 'normal') as 'normal' | 'onboarding'
/**
 * `--mic-after-start`:麦克风等「接通」那一条回话之后才发布(这一版手机包的顺序,2026-09-25)。
 * 缺省是老顺序:进房就发布、再发 call.start / onboarding。两种都要接得上 —— 工人按「房里新发了一条轨道」补订。
 */
const MIC_AFTER_START = process.argv.includes('--mic-after-start')
/**
 * `--phone app`(2026-09-25 返工):手机那一头换成**真 App 的通话代码** —— 无头 Chrome 开 butler-app/dev/app-call,
 * 通道层、房间连接、通话状态机都是 butler-app/src 里原样那几份(见那一页的文件头)。缺省 `rtc` = 原来那台 rtc-node 假手机。
 */
const PHONE_MODE = (arg('phone') ?? 'rtc') as 'rtc' | 'app'
/** `--phone app` 时麦克风怎么假:`fake`(缺省,放那段录好的话)| `silent-suspended`(统筹真机那一招,见那一页)。 */
const APP_GUM = (arg('gum') ?? 'fake') as 'fake' | 'silent-suspended'
/** `--phone app` 时引导那一通「打字问一句」的那句话(普通电话没有输入框,问的那句由假麦克风说)。 */
const TYPED = arg('typed') ?? '你好,你是谁?'
const CHROME_DEFAULT = join(homedir(), 'Library', 'Caches', 'ms-playwright', 'chromium-1223', 'chrome-mac-arm64', 'Google Chrome for Testing.app', 'Contents', 'MacOS', 'Google Chrome for Testing')
/** `--chrome 路径`:无头 Chrome 用哪个(缺省 Playwright 装的 Chrome for Testing)。 */
const CHROME = arg('chrome') ?? CHROME_DEFAULT
const APP_DIR = resolvePath(WORKER_DIR, '..', 'butler-app')
/**
 * `--app-src 目录`:那一页引哪一份 App 代码(缺省 butler-app/src)。量「改前」时把某个提交的 butler-app/src
 * 解到 butler-app/dev/app-call/.base/ 再指过去(依赖照样从 butler-app/node_modules 解析)。
 */
const APP_SRC = arg('app-src') === undefined ? undefined : resolvePath(arg('app-src') as string)
/** `--stall-mic`:那一页里「发布麦克风」永远不回(模拟网络慢时 livekit 的协商重试拖一分多钟)。 */
const STALL_MIC = process.argv.includes('--stall-mic')

/** 他说的那句话(假火山照这一句回;声音由 `say` 合成)。选一句闲聊:不带工具、不垫场,只量链路本身。 */
const UTTERANCE = '你好，你是谁？听得见我说话吗？'
/** 她回的那句话(假接话模型流式吐出来)。 */
const REPLY = '在的,我是你的事务官,听得很清楚。今天有什么要我办的?'

const LK_PORT = 7990
const LK_KEY = 'loadcallkey'
/** 只给这台自己起的 livekit-server 用的一串假钥匙,不是任何人的密钥。 */
const LK_SECRET = 'load-call-secret-not-a-real-key-0925'
const ROOM = `load-call-${process.pid}`
const PHONE_IDENTITY = 'wb-phone-loadtest'
/** 那段录好的话(`--phone app` 时那一页从假 8791 取)。 */
let utteranceWav: string | undefined

// ———————————————————————— 小工具 ————————————————————————

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
function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => chunks.push(chunk))
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
  })
}
/** 假 8791 的回包都带上跨域头:`--phone app` 那一页在另一个端口上(真 8791 对手机那一页也是这样放行的)。 */
const CORS = { 'access-control-allow-origin': '*', 'access-control-allow-headers': 'authorization, content-type', 'access-control-allow-methods': 'GET, POST, OPTIONS' }
function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json', ...CORS })
  res.end(JSON.stringify(body))
}
async function listen(server: Server): Promise<number> {
  return await new Promise<number>((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve((server.address() as { port: number }).port))
  })
}
function execText(file: string, argv: readonly string[]): Promise<string> {
  return new Promise((resolve) => {
    execFile(file, [...argv], { timeout: 3000 }, (err, stdout) => resolve(err === null ? stdout.trim() : ''))
  })
}
function stats(values: readonly number[]): { n: number, p50?: number, p90?: number, max?: number, mean?: number } {
  if (values.length === 0) return { n: 0 }
  const sorted = [...values].sort((a, b) => a - b)
  const at = (q: number): number => sorted[Math.min(sorted.length - 1, Math.floor(q * (sorted.length - 1) + 0.5))] as number
  return { n: sorted.length, p50: at(0.5), p90: at(0.9), max: sorted[sorted.length - 1] as number, mean: Math.round(sorted.reduce((a, b) => a + b, 0) / sorted.length) }
}

const children: ChildProcess[] = []
const servers: Server[] = []

// ———————————————————————— LiveKit 凭证(HS256 JWT,本机自签) ————————————————————————

function signToken(identity: string, name: string): string {
  const b64 = (value: string): string => Buffer.from(value).toString('base64url')
  const now = Math.floor(Date.now() / 1000)
  const payload = {
    iss: LK_KEY,
    sub: identity,
    nbf: now - 10,
    exp: now + 6 * 3600,
    name,
    video: { room: ROOM, roomJoin: true, canPublish: true, canSubscribe: true, canPublishData: true },
  }
  const data = `${b64(JSON.stringify({ alg: 'HS256', typ: 'JWT' }))}.${b64(JSON.stringify(payload))}`
  return `${data}.${createHmac('sha256', LK_SECRET).update(data).digest('base64url')}`
}

// ———————————————————————— 记下来的数 ————————————————————————

interface TurnResult { turn: number, spokeEndAt: number, replyAt?: number, latencyMs?: number, note?: string }
const turns: TurnResult[] = []
const vadDelays: { at: number, ms: number }[] = []
const vadGuardLines: { at: number, text: string }[] = []
const guardLines: { at: number, text: string }[] = []
const asrErrors: { at: number, text: string }[] = []
const diag: { at: number, gap_ms: number, lag_max_ms: number, lag_p99_ms: number, cpu_ms: number, majflt: number, ivcsw: number, rss_mb: number, vad_runs?: number }[] = []
/** 假火山每收到一包**音频**的时刻(开场帧不算)。挂断之后还有没有包,看它。 */
const volcPackets: number[] = []
/** 工人的「收音开了 / 收音关了」那几行(改后才有)。 */
const gateLines: { at: number, text: string }[] = []
/** 工人日志的每一行(听诊器那几行除外)。`--phone app` 时按「点下去」对齐摆一段出来。 */
const workerLines: { at: number, text: string }[] = []
/** 挂断那一刻(假手机发出 hangup 的时刻)。 */
let hungUpAt: number | undefined
const turnTimings: Record<string, unknown>[] = []
const sysSamples: { at: number, load1: number, swapUsedMb?: number, pressure?: number }[] = []
const loadRuns: { index: number, startedAt: number, endedAt?: number, code?: number | null }[] = []
const volcSessions: { openedAt: number, closedAt?: number, packets: number, maxGapMs: number, timeouts: number, definites: number, context?: string }[] = []

// ———————————————————————— ① livekit-server ————————————————————————

async function startLivekit(): Promise<void> {
  const config = join(HOME, 'livekit.yaml')
  writeFileSync(config, [
    `port: ${LK_PORT}`,
    'bind_addresses: ["127.0.0.1"]',
    'rtc:',
    `  tcp_port: ${LK_PORT + 1}`,
    `  udp_port: ${LK_PORT + 2}`,
    '  use_external_ip: false',
    'keys:',
    `  ${LK_KEY}: ${LK_SECRET}`,
    'logging:',
    '  level: warn',
    '',
  ].join('\n'))
  const lk = spawn('livekit-server', ['--config', config, '--node-ip', '127.0.0.1'], { stdio: ['ignore', 'ignore', 'pipe'] })
  children.push(lk)
  const lkLog = createWriteStream(join(HOME, 'livekit.log'))
  lk.stderr?.pipe(lkLog)
  await waitFor('livekit-server', async () => (await fetch(`http://127.0.0.1:${LK_PORT}`)).status < 500, 20_000)
  log(`① livekit-server 起来了:ws://127.0.0.1:${LK_PORT}(房间 ${ROOM})`)
}

// ———————————————————————— ② 假 8791 / 假 8792 / 假接话模型 / 假火山 ————————————————————————

async function startFakeWorkbench(): Promise<number> {
  const server = createServer((req, res) => {
    void (async () => {
      const path = (req.url ?? '').split('?')[0] ?? ''
      const body = await readBody(req)
      if (req.method === 'OPTIONS') { res.writeHead(204, CORS); res.end(); return }
      if (path === '/channel/token' && req.method === 'POST') {
        let worker = false
        try { worker = (JSON.parse(body === '' ? '{}' : body) as { worker?: unknown }).worker === true } catch { /* 不是 JSON:当手机 */ }
        // 工人带 `worker: true`;不带的是手机(`--phone app` 那一页走的就是 App 的 fetchFromWorkbench)。
        if (worker) json(res, 200, { url: `ws://127.0.0.1:${LK_PORT}`, room: ROOM, identity: WORKER_IDENTITY, token: signToken(WORKER_IDENTITY, 'load-call'), expires_at: Date.now() + 6 * 3600_000 })
        else json(res, 200, { url: `ws://127.0.0.1:${LK_PORT}`, room: ROOM, identity: PHONE_IDENTITY, token: signToken(PHONE_IDENTITY, '压测手机'), expires_at: Math.floor(Date.now() / 1000) + 6 * 3600 })
        return
      }
      if (path === '/__utterance.wav' && utteranceWav !== undefined) {
        res.writeHead(200, { 'content-type': 'audio/wav', ...CORS })
        res.end(readFileSync(utteranceWav))
        return
      }
      if (path === '/onboarding/brief') {
        // `--call onboarding` 用:一份「接着做」的简报(不念开场白,换完提示词她接着问没答的那一题)。
        json(res, 200, { stage: 'habits', label: '习惯', done: false, speak_seed: false, goals: ['他平时几点开工'], keys: [], answered: {} })
        return
      }
      if (path === '/channel/persona') {
        json(res, 200, { system_message: '你是事务官。说话简短,一两句就够。', welcome: '我在。', addresses: ['老板'] })
        return
      }
      if (path === '/channel/credentials') { json(res, 200, { source: 'none' }); return }
      if (path === '/call/claim') { json(res, 200, { calls: [] }); return }
      if (path === '/channel/latency' && body !== '') {
        try { turnTimings.push((JSON.parse(body) as { turn?: Record<string, unknown> }).turn ?? {}) } catch { /* 不是 JSON 就不记 */ }
        json(res, 200, { ok: true })
        return
      }
      if (req.method === 'POST') { json(res, 200, { ok: true }); return }
      json(res, 404, { error: '假 8791 没有这一条' })
    })()
  })
  servers.push(server)
  return await listen(server)
}

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
      const body = await readBody(req)
      if (path === '/health') { json(res, 200, { ok: true }); return }
      if (path === '/api/tts') {
        let text = ''
        try { text = String((JSON.parse(body) as { text?: unknown }).text ?? '') } catch { /* 空的也照答 */ }
        await sleep(150) // 与真火山同一个量级
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
      await sleep(300) // 首字固定晚 300ms:模型那一段不是这次要量的,钉死它
      res.write(chunk({ role: 'assistant', content: '' }, null))
      const pieces = REPLY.match(/.{1,6}/gu) ?? [REPLY]
      for (const piece of pieces) { res.write(chunk({ content: piece }, null)); await sleep(40) }
      res.write(chunk({}, 'stop'))
      res.end('data: [DONE]\n\n')
    })()
  })
  servers.push(server)
  return await listen(server)
}

/** 解一帧**客户端**发来的(开场请求 / 音频包)。坏帧回 undefined。 */
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

function errorFrame(code: number, message: string): Buffer {
  const payload = Buffer.from(JSON.stringify({ error: message }))
  const out = Buffer.alloc(12 + payload.length)
  out[0] = 0x11; out[1] = (MSG_SERVER_ERROR << 4); out[2] = (SER_JSON << 4); out[3] = 0
  out.writeUInt32BE(code, 4)
  out.writeUInt32BE(payload.length, 8)
  payload.copy(out, 12)
  return out
}

/**
 * 假火山:**只模仿我们关心的那两件事**。
 *   · 判停:按收到的音频能量算「他停了多久」,够 end_window_size 就回一条 `definite`(与真火山同一种帧);
 *   · 等包超时:这条连接超过 --volc-timeout 毫秒没收到一包 → 回 45000081 并断开(真火山同一个码)。
 * 另外记下每条连接**两包之间最长隔了多久** —— 那就是「推流断没断」。
 */
async function startFakeVolc(): Promise<number> {
  const server = createServer()
  const wss = new WebSocketServer({ server })
  wss.on('connection', (ws: WebSocket) => {
    const session: (typeof volcSessions)[number] = { openedAt: Date.now(), packets: 0, maxGapMs: 0, timeouts: 0, definites: 0 }
    volcSessions.push(session)
    let lastPacketAt = Date.now()
    let endWindowMs = 800
    let speaking = false
    let speechMs = 0
    let silenceMs = 0
    let seq = 1
    let interimAt = 0
    const send = (result: Record<string, unknown>): void => {
      seq += 1
      try { ws.send(buildFrame({ messageType: MSG_FULL_SERVER, flags: FLAG_POS_SEQUENCE, serialization: SER_JSON, compression: COMP_GZIP, sequence: seq, payload: gzipSync(Buffer.from(JSON.stringify({ result }))) })) }
      catch { /* 断了就断了 */ }
    }
    const watchdog = setInterval(() => {
      if (Date.now() - lastPacketAt <= VOLC_TIMEOUT_MS) return
      session.timeouts += 1
      try { ws.send(errorFrame(45000081, 'wait packet timeout')) } catch { /* 已经断了 */ }
      clearInterval(watchdog)
      try { ws.close() } catch { /* 已经断了 */ }
    }, 250)
    ws.on('close', () => { clearInterval(watchdog); session.closedAt = Date.now() })
    ws.on('message', (data: Buffer) => {
      const now = Date.now()
      const frame = parseClientFrame(Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer))
      if (frame === undefined) return
      if (session.packets > 0) session.maxGapMs = Math.max(session.maxGapMs, now - lastPacketAt)
      lastPacketAt = now
      session.packets += 1
      if (frame.type === 0b0001) {
        try {
          const request = (JSON.parse(frame.payload.toString('utf8')) as { request?: { end_window_size?: number, corpus?: { context?: string } } }).request
          if (typeof request?.end_window_size === 'number') endWindowMs = request.end_window_size
          if (typeof request?.corpus?.context === 'string') session.context = request.corpus.context
        }
        catch { /* 开场帧读不懂就按缺省 */ }
        return
      }
      const pcm = frame.payload
      volcPackets.push(now)
      const samples = Math.floor(pcm.length / 2)
      if (samples === 0) return
      let sum = 0
      for (let i = 0; i < samples; i += 1) { const v = pcm.readInt16LE(i * 2); sum += v * v }
      const rms = Math.sqrt(sum / samples)
      const ms = (samples / 16000) * 1000
      if (rms > 300) {
        speaking = true
        speechMs += ms
        silenceMs = 0
        if (speechMs - interimAt >= 400) {
          interimAt = speechMs
          const chars = Math.max(1, Math.min([...UTTERANCE].length, Math.round(speechMs / 200)))
          const partial = [...UTTERANCE].slice(0, chars).join('')
          send({ text: partial, utterances: [{ text: partial, definite: false }] })
        }
        return
      }
      if (!speaking) return
      silenceMs += ms
      if (silenceMs >= endWindowMs) {
        speaking = false
        speechMs = 0
        interimAt = 0
        session.definites += 1
        send({ text: UTTERANCE, utterances: [{ text: UTTERANCE, definite: true }, { text: '', definite: false }] })
      }
    })
  })
  servers.push(server)
  return await listen(server)
}

// ———————————————————————— ③ 工人 ————————————————————————

let workerJoined = false
async function startWorker(ports: { wb: number, butler: number, llm: number, volc: number }): Promise<ChildProcess> {
  const extra: Record<string, string> = {}
  for (const pair of args('worker-env')) {
    const at = pair.indexOf('=')
    if (at > 0) extra[pair.slice(0, at)] = pair.slice(at + 1)
  }
  const worker = spawn(NODE_BIN, ['--import', join(WORKER_DIR, 'dev', 'load-diag-preload.mjs'), WORKER_MAIN], {
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
      WORKBENCH_CHANNEL_DEVICE_NAME: 'load-call',
      WORKBENCH_CHANNEL_LOG_LEVEL: 'warn',
      WORKBENCH_CHANNEL_TURN_ROUTER: 'rules',
      // 护栏(改后才有)只许动**这台压测自己起的**负载进程,别的会话的测试一概不碰。
      WORKBENCH_CHANNEL_LOAD_GUARD_ONLY_UNDER: String(process.pid),
      ...extra,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  children.push(worker)
  const file = createWriteStream(join(HOME, 'worker.log'))
  let pendingVadAt: number | undefined
  const onLine = (raw: string): void => {
    // eslint-disable-next-line no-control-regex
    const line = raw.replace(/\x1b\[[0-9;]*m/g, '')
    const now = Date.now()
    file.write(`${now - t0}\t${line}\n`)
    if (line.startsWith('[load-diag] ')) {
      try { diag.push(JSON.parse(line.slice('[load-diag] '.length)) as (typeof diag)[number]) } catch { /* 半行 */ }
      return
    }
    if (line.includes('VAD inference is slower than realtime')) { pendingVadAt = now; return }
    const delay = /^\s+delay: (\d+)/.exec(line)
    if (delay !== null && pendingVadAt !== undefined) { vadDelays.push({ at: pendingVadAt, ms: Number(delay[1]) }); pendingVadAt = undefined; return }
    pendingVadAt = undefined
    if (line.includes('VAD 落后')) vadGuardLines.push({ at: now, text: line })
    if (line.includes('通话护栏')) guardLines.push({ at: now, text: line })
    if (line.includes('收音开了') || line.includes('收音关了')) gateLines.push({ at: now, text: line })
    if (line.includes('火山 ASR 错误') || line.includes('火山 ASR 连接失败')) asrErrors.push({ at: now, text: line })
    if (line.includes('[channel-worker] 进房了')) workerJoined = true
    if (line.trim() !== '') workerLines.push({ at: now, text: line })
  }
  for (const stream of [worker.stdout, worker.stderr]) {
    let buffer = ''
    stream?.on('data', (chunk: Buffer) => {
      buffer += chunk.toString('utf8')
      let at = buffer.indexOf('\n')
      while (at >= 0) { onLine(buffer.slice(0, at)); buffer = buffer.slice(at + 1); at = buffer.indexOf('\n') }
    })
  }
  worker.on('exit', code => log(`工人退出了(${code ?? '信号'})`))
  await waitFor('工人进房', () => workerJoined, 60_000)
  log(`③ 工人进房了(${NODE_BIN.includes('.dsh') ? '~/.dsh 那份 node(只读借用)' : NODE_BIN})`)
  return worker
}

// ———————————————————————— ④ 假手机 ————————————————————————

interface Phone {
  room: Room
  rpc: (request: Record<string, unknown>) => Promise<Record<string, unknown>>
  speak: () => Promise<number>
  /** 她此刻在出声吗(连着 5 帧有声 = 开口;连着 80 帧静 = 说完)。 */
  herVoice: () => { speaking: boolean, lastLoudAt: number, firstLoudSince: (at: number) => number | undefined }
  /** 这一版手机包挂断时做的事:撤掉麦克风轨道、不再推帧(`--phone-hangup unpublish`)。 */
  stopMic: () => Promise<void>
  /** 发布麦克风(`--mic-after-start` 时由主流程在接通之后调;老顺序进房就发布,这一下什么都不做)。 */
  publishMic: () => Promise<void>
  stop: () => Promise<void>
}

async function startPhone(wavPath: string): Promise<Phone> {
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
    }).catch(() => { /* 一条读坏了不影响下一条 */ })
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
        const loud = peak > 600
        if (loud) { loudRun += 1; quietRun = 0; lastLoudAt = Date.now() }
        else { quietRun += 1; loudRun = 0 }
        if (!speaking && loudRun === 5) { speaking = true; loudStarts.push(Date.now() - 40) }
        if (speaking && quietRun >= 80) speaking = false
      }
    })()
  })
  await room.connect(`ws://127.0.0.1:${LK_PORT}`, signToken(PHONE_IDENTITY, '压测手机'), { autoSubscribe: true, dynacast: true })

  // 麦克风:一直在推(真手机通话中也是一直推),没在说话时推静音。
  const { pcm, sampleRate, channels } = pcmOfWav(readFileSync(wavPath))
  const source = new AudioSource(sampleRate, channels, 200)
  const track = LocalAudioTrack.createAudioTrack('mic', source)
  const options = new TrackPublishOptions()
  options.source = TrackSource.SOURCE_MICROPHONE
  let micPublication: Awaited<ReturnType<NonNullable<typeof room.localParticipant>['publishTrack']>> | undefined
  const publishMic = async (): Promise<void> => {
    if (micPublication !== undefined) return
    micPublication = await room.localParticipant?.publishTrack(track, options)
  }
  if (!MIC_AFTER_START) await publishMic()
  const samplesPerFrame = Math.round(sampleRate / 100)
  const silence = new Int16Array(samplesPerFrame * channels)
  const utterFrames: Int16Array[] = []
  for (let offset = 0; offset + samplesPerFrame * 2 * channels <= pcm.length; offset += samplesPerFrame * 2 * channels) {
    const samples = new Int16Array(samplesPerFrame * channels)
    for (let i = 0; i < samples.length; i += 1) samples[i] = pcm.readInt16LE(offset + i * 2)
    utterFrames.push(samples)
  }
  let queue: Int16Array[] = []
  let onDrained: ((at: number) => void) | undefined
  let running = true
  const pump = (async () => {
    while (running) {
      const next = queue.shift()
      try { await source.captureFrame(new AudioFrame(next ?? silence, sampleRate, channels, samplesPerFrame)) }
      catch { if (!running) break }
      if (next !== undefined && queue.length === 0 && onDrained !== undefined) {
        // 最后一帧交出去了;它真正放完还要等队列里那一截(≤200ms)。
        const done = onDrained
        onDrained = undefined
        done(Date.now() + source.queuedDuration)
      }
    }
  })()

  return {
    room,
    async rpc(request) {
      const id = randomUUID()
      const waited = new Promise<Record<string, unknown>>((resolve, reject) => {
        pending.set(id, resolve)
        setTimeout(() => { if (pending.delete(id)) reject(new Error('10 秒没回')) }, 10_000)
      })
      await room.localParticipant?.sendText(JSON.stringify({ id, ...request }), { topic: RPC_TOPIC })
      return await waited
    },
    speak: () => new Promise<number>((resolve) => {
      onDrained = resolve
      queue = [...utterFrames]
    }),
    herVoice: () => ({
      speaking,
      lastLoudAt,
      firstLoudSince: (at: number) => loudStarts.find(start => start >= at),
    }),
    publishMic,
    async stopMic() {
      running = false
      await pump.catch(() => {})
      const sid = micPublication?.sid
      if (sid !== undefined) await room.localParticipant?.unpublishTrack(sid).catch(() => {})
    },
    async stop() {
      running = false
      await pump.catch(() => {})
      await room.disconnect()
    },
  }
}

// ———————————————————————— ④' 真 App 的通话代码(`--phone app`) ————————————————————————

interface AppPhone {
  /** 在那一页里求一个表达式的值(可以是 promise)。 */
  eval: <T = unknown>(expression: string) => Promise<T>
  state: () => Promise<{ phase: string, error: string | null, connectedAt: number | null, lines: { who: string, text: string }[], mic_tracks: string[], mic_notice: string | null, voice: { speaking: boolean, lastLoudAt: number, loudStarts: number[] } }>
  /** 那一页记下的每一步(相对 t0 的毫秒 + 那一步)。 */
  trace: () => Promise<{ at: number, what: string }[]>
  consoleLines: string[]
  stop: () => Promise<void>
}

/** 找一个空端口(给 vite 用:它要事先知道端口)。 */
async function freePort(): Promise<number> {
  const probe = createServer()
  const port = await listen(probe)
  await new Promise<void>(resolve => probe.close(() => resolve()))
  return port
}

async function startAppPhone(wbPort: number): Promise<AppPhone> {
  if (!existsSync(CHROME)) throw new Error(`没找到无头 Chrome:${CHROME}(用 --chrome 指一个)`)
  // ① vite 起那一页(butler-app/dev/app-call),依赖从 butler-app/node_modules 解析。
  const vitePort = await freePort()
  const vite = spawn(NODE_BIN, [join(APP_DIR, 'node_modules', 'vite', 'bin', 'vite.js'), '--config', join(APP_DIR, 'dev', 'app-call', 'vite.config.mjs'), '--port', String(vitePort), '--strictPort'], {
    cwd: APP_DIR,
    env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: process.env.HOME ?? homedir(), ...(APP_SRC === undefined ? {} : { APP_CALL_SRC: APP_SRC }) },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  children.push(vite)
  const viteLog = createWriteStream(join(HOME, 'vite.log'))
  vite.stdout?.pipe(viteLog)
  vite.stderr?.pipe(viteLog)
  await waitFor('vite', async () => (await fetch(`http://127.0.0.1:${vitePort}/`)).ok, 30_000)
  // ② 无头 Chrome。`silent-suspended` 那一种不给自动播放开关:没有手势建的 AudioContext 就是 suspended(同 WebView)。
  const chromeArgs = [
    '--headless=new',
    '--remote-debugging-port=0',
    `--user-data-dir=${join(HOME, 'chrome-profile')}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-background-timer-throttling',
    '--disable-renderer-backgrounding',
    '--disable-backgrounding-occluded-windows',
    // 不给这两个,Chrome 报给 livekit-server 的候选地址是混淆过的 `*.local`,连本机那台 livekit-server 都连不上
    // (「could not establish pc connection」)。麦克风本身由那一页换掉,这两个只管放行。
    '--use-fake-ui-for-media-stream',
    '--use-fake-device-for-media-stream',
    ...(APP_GUM === 'fake' ? ['--autoplay-policy=no-user-gesture-required'] : []),
    'about:blank',
  ]
  const chrome = spawn(CHROME, chromeArgs, { stdio: ['ignore', 'ignore', 'pipe'] })
  children.push(chrome)
  const chromeLog = createWriteStream(join(HOME, 'chrome.log'))
  let devtools: string | undefined
  chrome.stderr?.on('data', (chunk: Buffer) => {
    const text = chunk.toString('utf8')
    chromeLog.write(text)
    const found = /DevTools listening on (ws:\/\/\S+)/.exec(text)
    if (found !== null) devtools = found[1]
  })
  await waitFor('无头 Chrome', () => devtools !== undefined, 30_000)
  const debugPort = new URL(devtools as string).port
  // 刚起来那一下页面还没登记上:等一会儿;还没有就开一个。
  let page: { type: string, webSocketDebuggerUrl: string } | undefined
  const pageUntil = Date.now() + 10_000
  while (page === undefined && Date.now() < pageUntil) {
    const targets = await (await fetch(`http://127.0.0.1:${debugPort}/json/list`)).json() as { type: string, webSocketDebuggerUrl: string }[]
    page = targets.find(one => one.type === 'page')
    if (page === undefined) await sleep(200)
  }
  page = page ?? await (await fetch(`http://127.0.0.1:${debugPort}/json/new?about:blank`, { method: 'PUT' })).json() as { type: string, webSocketDebuggerUrl: string }
  const socket = new WsClient(page.webSocketDebuggerUrl)
  await new Promise<void>((resolve, reject) => { socket.once('open', () => resolve()); socket.once('error', reject) })
  let nextId = 0
  const pending = new Map<number, (message: Record<string, unknown>) => void>()
  const consoleLines: string[] = []
  const consoleFile = createWriteStream(join(HOME, 'phone-console.log'))
  socket.on('message', (raw: Buffer) => {
    const message = JSON.parse(raw.toString('utf8')) as { id?: number, method?: string, params?: Record<string, unknown> }
    if (message.id !== undefined) { pending.get(message.id)?.(message as Record<string, unknown>); pending.delete(message.id); return }
    if (message.method === 'Runtime.consoleAPICalled') {
      const params = message.params as { type: string, args: { value?: unknown, description?: string }[] }
      const line = `${Date.now() - t0}\t${params.type}\t${params.args.map(one => (one.value !== undefined ? (typeof one.value === 'string' ? one.value : JSON.stringify(one.value)) : one.description ?? '')).join(' ')}`
      consoleLines.push(line)
      consoleFile.write(`${line}\n`)
    }
    if (message.method === 'Runtime.exceptionThrown') {
      const line = `${Date.now() - t0}\texception\t${JSON.stringify((message.params as { exceptionDetails?: unknown }).exceptionDetails)}`
      consoleLines.push(line)
      consoleFile.write(`${line}\n`)
    }
  })
  const send = (method: string, params: Record<string, unknown> = {}): Promise<Record<string, unknown>> => new Promise((resolve) => {
    nextId += 1
    pending.set(nextId, resolve)
    socket.send(JSON.stringify({ id: nextId, method, params }))
  })
  const evaluate = async <T = unknown>(expression: string): Promise<T> => {
    const reply = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
    const result = reply.result as { result?: { value?: unknown }, exceptionDetails?: { exception?: { description?: string }, text?: string } } | undefined
    if (result?.exceptionDetails !== undefined) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text ?? '那一页抛了')
    return result?.result?.value as T
  }
  await send('Runtime.enable')
  const config = { wb: { host: '127.0.0.1', port: wbPort }, deviceToken: 'load-call-device-token', deviceId: PHONE_IDENTITY.replace(/^wb-phone-/, ''), gum: APP_GUM, stallMic: STALL_MIC }
  await send('Page.navigate', { url: `http://127.0.0.1:${vitePort}/#${encodeURIComponent(JSON.stringify(config))}` })
  await waitFor('那一页加载完', async () => (await evaluate<boolean | undefined>('window.__app?.ready').catch(() => undefined)) === true, 60_000)
  return {
    eval: evaluate,
    state: () => evaluate('window.__app.state()'),
    trace: () => evaluate('window.__app.trace()'),
    consoleLines,
    async stop() {
      try { await evaluate('true') } catch { /* 已经关了 */ }
      socket.close()
    },
  }
}

// ———————————————————————— ⑤ 负载 ————————————————————————

const loadChildren = new Set<ChildProcess>()
let loadOn = false
function startLoad(): void {
  if (LOAD_COUNT <= 0) return
  loadOn = true
  const prefix = LOAD_POLICY === 'utility' ? 'taskpolicy -c utility ' : LOAD_POLICY === 'background' ? 'taskpolicy -b ' : LOAD_POLICY === 'nice' ? 'nice -n 15 ' : ''
  const launch = (index: number): void => {
    if (!loadOn) return
    const run: (typeof loadRuns)[number] = { index, startedAt: Date.now() }
    loadRuns.push(run)
    // detached:自成一个进程组,收尾时整组一起停 —— 只停**这里起的**这几组,别的一个不碰。
    const child = spawn('/bin/sh', ['-c', `${prefix}${LOAD_CMD}`], { cwd: PLUGIN_DIR, detached: true, stdio: ['ignore', 'ignore', 'ignore'] })
    loadChildren.add(child)
    child.on('exit', (code) => {
      loadChildren.delete(child)
      run.endedAt = Date.now()
      run.code = code
      log(`负载 #${index} 跑完一遍(${Math.round((run.endedAt - run.startedAt) / 1000)} 秒,退出码 ${code ?? '信号'})${loadOn ? ',再起一遍' : ''}`)
      launch(index)
    })
  }
  for (let i = 1; i <= LOAD_COUNT; i += 1) launch(i)
  log(`⑤ 负载起来了:${LOAD_COUNT} 份「${prefix}${LOAD_CMD}」(在 workbench-plugin/,nice 0)`)
}
function stopLoad(): void {
  loadOn = false
  for (const child of loadChildren) {
    if (child.pid === undefined) continue
    try { process.kill(-child.pid, 'SIGTERM') } catch { /* 已经走了 */ }
  }
}

// ———————————————————————— 系统采样 ————————————————————————

let sampling = true
async function sampleSystem(): Promise<void> {
  while (sampling) {
    const [swap, pressure] = await Promise.all([
      execText('/usr/sbin/sysctl', ['-n', 'vm.swapusage']),
      execText('/usr/sbin/sysctl', ['-n', 'kern.memorystatus_vm_pressure_level']),
    ])
    const used = /used = ([\d.]+)M/.exec(swap)
    sysSamples.push({
      at: Date.now(),
      load1: Math.round((loadavg()[0] ?? 0) * 10) / 10,
      ...(used === null ? {} : { swapUsedMb: Math.round(Number(used[1])) }),
      ...(pressure === '' ? {} : { pressure: Number(pressure) }),
    })
    await sleep(3000)
  }
}

// ———————————————————————— 主流程 ————————————————————————

async function makeUtteranceWav(): Promise<string> {
  const wav = join(HOME, 'utterance.wav')
  if (existsSync(wav)) return wav
  const aiff = join(HOME, 'utterance.aiff')
  await new Promise<void>((resolve, reject) => {
    execFile('/usr/bin/say', ['-v', 'Tingting', '-o', aiff, UTTERANCE], err => (err === null ? resolve() : reject(err)))
  })
  await new Promise<void>((resolve, reject) => {
    execFile('/usr/bin/afconvert', ['-f', 'WAVE', '-d', 'LEI16@48000', '-c', '1', aiff, wav], err => (err === null ? resolve() : reject(err)))
  })
  return wav
}

async function main(): Promise<void> {
  mkdirSync(HOME, { recursive: true })
  log(`压测「${LABEL}」:${TURNS} 回合,负载 ${LOAD_COUNT} 份(${LOAD_POLICY}),临时 HOME ${HOME}`)
  const wav = await makeUtteranceWav()
  await startLivekit()
  const ports = { wb: await startFakeWorkbench(), butler: await startFakeButler(), llm: await startStubLlm(), volc: await startFakeVolc() }
  log(`② 假 8791 :${ports.wb} · 假 8792 :${ports.butler} · 假模型 :${ports.llm} · 假火山 :${ports.volc}(等包超时 ${VOLC_TIMEOUT_MS}ms)`)
  void sampleSystem()
  await startWorker(ports)
  const phone = await startPhone(wav)
  log('④ 假手机进房了,打一通电话(call.start)')
  const greeted = await phone.rpc(CALL_KIND === 'onboarding' ? { type: 'onboarding', action: 'resume' } : { type: 'call', action: 'start' }).catch((err: unknown) => ({ ok: false, error: (err as Error).message }))
  if (MIC_AFTER_START) {
    await phone.publishMic()
    log('接通了才发布麦克风(这一版手机包的顺序)')
  }
  log(`招呼 → ${greeted.ok === true ? '她开口了' : `没说成:${String(greeted.error)}`}`)
  // 等开场那一句说完。
  await waitFor('开场白说完', () => { const v = phone.herVoice(); return !v.speaking && v.lastLoudAt > 0 && Date.now() - v.lastLoudAt > 1200 }, 30_000).catch(() => log('开场白没等到(照样往下走)'))
  startLoad()
  if (WARMUP_MS > 0) { log(`等 ${Math.round(WARMUP_MS / 1000)} 秒让负载爬上去`); await sleep(WARMUP_MS) }

  for (let turn = 1; turn <= TURNS; turn += 1) {
    // 她还在说就等她说完(最多 60 秒),别把她打断。
    await waitFor('她说完', () => { const v = phone.herVoice(); return !v.speaking && Date.now() - v.lastLoudAt > 1500 }, 60_000).catch(() => {})
    const spokeEndAt = await phone.speak()
    const result: TurnResult = { turn, spokeEndAt }
    turns.push(result)
    try {
      await waitFor('她开口', () => phone.herVoice().firstLoudSince(spokeEndAt) !== undefined, 45_000)
      result.replyAt = phone.herVoice().firstLoudSince(spokeEndAt) as number
      result.latencyMs = result.replyAt - spokeEndAt
      log(`回合 ${turn}:他说完 → 她开口 ${result.latencyMs}ms`)
    }
    catch {
      result.note = '45 秒没开口'
      log(`回合 ${turn}:45 秒她都没开口`)
    }
    await sleep(1500)
  }

  hungUpAt = Date.now()
  try { await phone.rpc(CALL_KIND === 'onboarding' ? { type: 'onboarding', action: 'stop' } : { type: 'call', action: 'hangup' }) } catch { /* 挂不上也收场 */ }
  if (PHONE_HANGUP === 'unpublish') {
    await phone.stopMic()
    log('挂断了:手机撤掉了麦克风轨道(这一版的手机包)')
  }
  else if (LINGER_MS > 0) log('挂断了:手机的麦克风轨道留在房里、照推静音帧(09-25 以前的手机包)')
  if (LINGER_MS > 0) {
    log(`手机留在房里再待 ${Math.round(LINGER_MS / 1000)} 秒(常驻房间),看工人还听不听、火山连接关没关`)
    await sleep(LINGER_MS)
  }
  // 挂断之后负载先别停:等护栏那一拍(2 秒)把压着的还原回去,日志里看得见「还原了 N 个」。
  if (LOAD_COUNT > 0) await sleep(4000)
  stopLoad()
  sampling = false
  await phone.stop()
  await sleep(500)
  report()
}

/**
 * `--phone app`:**真 App 的通话代码**打一通(2026-09-25 返工,统筹 0.2.95 真机「普通电话接不通」)。
 *
 * 顺序照真 App:冷启动常驻房间(holdForRing)→ 点「通话」→ 等接通(最多 70 秒;没接通就把那一页记下的
 * 每一步摆出来 —— 卡在哪一步一眼看得见)→ 普通电话:假麦克风说那句话;引导那一通:打字问一句
 * (普通电话的通话页没有输入框)→ 等她答 → 挂断 → 手机照旧常驻、留在房里 → 看识别连接关没关。
 */
async function mainApp(): Promise<void> {
  mkdirSync(HOME, { recursive: true })
  log(`真 App 的通话代码(${APP_SRC ?? 'butler-app/src'}):${CALL_KIND === 'onboarding' ? '引导那一通' : '普通电话'},${TURNS} 回合,麦克风 ${APP_GUM}${STALL_MIC ? '(发布卡住)' : ''},临时 HOME ${HOME}`)
  utteranceWav = await makeUtteranceWav()
  await startLivekit()
  const ports = { wb: await startFakeWorkbench(), butler: await startFakeButler(), llm: await startStubLlm(), volc: await startFakeVolc() }
  log(`② 假 8791 :${ports.wb} · 假 8792 :${ports.butler} · 假模型 :${ports.llm} · 假火山 :${ports.volc}`)
  void sampleSystem()
  await startWorker(ports)
  const app = await startAppPhone(ports.wb)
  const held = await app.eval<{ ok: boolean, error?: string }>('window.__app.hold()')
  log(`④ 那一页(butler-app/dev/app-call)好了;冷启动常驻房间 → ${held.ok ? '进房了' : `没进去:${held.error ?? ''}`}`)
  await sleep(2000)
  const tapAt = Date.now()
  await app.eval(`window.__app.start(${JSON.stringify(CALL_KIND)})`)
  log(`⑤ 点「${CALL_KIND === 'onboarding' ? '引导' : '通话'}」`)
  const printTrace = async (): Promise<void> => {
    for (const row of await app.trace()) log(`   手机 ${row.at - tapAt >= 0 ? '+' : ''}${row.at - tapAt}ms  ${row.what}`)
  }
  const printWorker = (): void => {
    const keep = /收音|他说|她说|普通通话|引导|火山|挂|接话对象|房里|通话|代办/
    for (const row of workerLines) {
      if (row.at < tapAt - 3000 || !keep.test(row.text)) continue
      log(`   工人 ${row.at - tapAt >= 0 ? '+' : ''}${row.at - tapAt}ms  ${row.text.replace(/^\[channel-worker\] /, '')}`)
    }
  }
  let state = await app.state()
  const deadline = Date.now() + 70_000
  while ((state.phase === 'connecting' || state.phase === 'idle') && Date.now() < deadline) {
    await sleep(200)
    state = await app.state()
  }
  if (state.phase !== 'connected' || state.connectedAt === null) {
    log(state.phase === 'error' ? `✗ 接不通:「${state.error ?? ''}」(点下去之后 ${Date.now() - tapAt}ms)` : '✗ 70 秒了还是「正在接通…」')
    log('—— 那一页记下的每一步 ——')
    await printTrace()
    log('—— 同一段时间的工人日志 ——')
    printWorker()
    const errors = app.consoleLines.filter(line => /\terror\t|\twarn(ing)?\t|exception/.test(line)).slice(-15)
    if (errors.length > 0) { log('—— 那一页控制台的错误 / 警告 ——'); for (const line of errors) log(`   ${line}`) }
    process.exitCode = 2
    await app.stop()
    return
  }
  log(`✓ 接通了:点下去 → 接通 ${state.connectedAt - tapAt}ms`)
  if (STALL_MIC) {
    // 发布卡住:麦克风开不了,说话也没用 —— 看她招呼说没说、通话页上那一行什么时候出来,然后挂断。
    await waitFor('麦克风那一行', async () => (await app.state()).mic_notice !== null, 30_000).catch(() => {})
    const notice = (await app.state()).mic_notice
    log(notice === null ? '30 秒了通话页上还没有「麦克风没打开」那一行' : `通话页上那一行(点下去之后 ${Date.now() - tapAt}ms):「${notice}」`)
  }
  // 等开场白说完(普通电话她先招呼一句;引导那一通按简报不念开场白)。
  await waitFor('开场白说完', async () => { const now = await app.state(); return !now.voice.speaking && now.voice.lastLoudAt > 0 && Date.now() - now.voice.lastLoudAt > 1200 }, CALL_KIND === 'onboarding' ? 4000 : 30_000)
    .catch(() => log(CALL_KIND === 'onboarding' ? '(引导那一通不念开场白)' : '开场白没等到(照样往下走)'))

  for (let turn = 1; turn <= (STALL_MIC ? 0 : TURNS); turn += 1) {
    await waitFor('她说完', async () => { const now = await app.state(); return !now.voice.speaking && Date.now() - now.voice.lastLoudAt > 1500 }, 60_000).catch(() => {})
    let spokeEndAt: number
    if (CALL_KIND === 'onboarding') {
      const sent = await app.eval<{ ok: boolean, error?: string }>(`window.__app.say(${JSON.stringify(TYPED)})`)
      spokeEndAt = Date.now()
      log(`回合 ${turn}:他打字问「${TYPED}」→ ${sent.ok ? '送出去了' : `没送出去:${sent.error ?? ''}`}`)
    }
    else {
      spokeEndAt = await app.eval<number>('window.__app.speak()')
      log(`回合 ${turn}:他说完了(假麦克风放「${UTTERANCE}」)`)
    }
    const result: TurnResult = { turn, spokeEndAt }
    turns.push(result)
    try {
      await waitFor('她开口', async () => (await app.state()).voice.loudStarts.some(at => at >= spokeEndAt), 45_000)
      result.replyAt = (await app.state()).voice.loudStarts.find(at => at >= spokeEndAt) as number
      result.latencyMs = result.replyAt - spokeEndAt
      log(`回合 ${turn}:→ 她开口 ${result.latencyMs}ms`)
    }
    catch {
      result.note = '45 秒没开口'
      log(`回合 ${turn}:45 秒她都没开口`)
    }
    await sleep(1500)
  }

  await waitFor('她说完', async () => { const now = await app.state(); return !now.voice.speaking && Date.now() - now.voice.lastLoudAt > 1500 }, 60_000).catch(() => {})
  const lines = (await app.state()).lines
  for (const line of lines) log(`   字幕(${line.who === 'me' ? '他' : '她'}):${line.text}`)
  hungUpAt = Date.now()
  await app.eval('window.__app.hangup()')
  const after = await app.state()
  log(`⑥ 挂断了(真 App 的 hangup);手机上的麦克风轨道:${after.mic_tracks.join(' / ') || '一条都没开过'}`)
  if (LINGER_MS > 0) {
    log(`手机照旧常驻、留在房里 ${Math.round(LINGER_MS / 1000)} 秒,看工人还听不听、火山连接关没关`)
    await sleep(LINGER_MS)
  }
  sampling = false
  log('—— 那一页记下的每一步 ——')
  await printTrace()
  log('—— 同一段时间的工人日志 ——')
  printWorker()
  report()
  await app.stop()
}

/**
 * 挂断之后(2026-09-25,卡 fix/evening-gaps 第 1 条):工人还在不在听、火山连接关没关。
 * 全是外面量的:火山那头收到的包、听诊器在 onnxruntime 上数的 VAD 推理、工人进程的 CPU。
 */
function afterHangup(at: number): Record<string, unknown> {
  const packets = volcPackets.filter(t => t > at)
  const openAtHangup = volcSessions.filter(one => one.openedAt <= at && (one.closedAt === undefined || one.closedAt > at))
  const rows = diag.filter(row => row.at > at)
  const settled = rows.filter(row => row.at > at + 2000)
  const vadKnown = rows.some(row => row.vad_runs !== undefined)
  return {
    phone_mic: PHONE_MODE === 'app' ? '真 App 的挂断(butler-app/src 原样)' : PHONE_HANGUP === 'unpublish' ? '撤轨道、停录音(这一版的手机包)' : '轨道留在房里、推静音帧(09-25 以前的手机包)',
    linger_s: Math.round(LINGER_MS / 1000),
    volc_packets_after_hangup: packets.length,
    volc_packets_after_2s: packets.filter(t => t > at + 2000).length,
    volc_last_packet_after_hangup_ms: packets.length === 0 ? null : (packets[packets.length - 1] as number) - at,
    volc_sessions_open_at_hangup: openAtHangup.length,
    volc_close_after_hangup_ms: openAtHangup.map(one => (one.closedAt === undefined ? '到结束都开着' : one.closedAt - at)),
    volc_sessions_opened_after_hangup: volcSessions.filter(one => one.openedAt > at).length,
    volc_still_open_at_end: volcSessions.filter(one => one.closedAt === undefined).length,
    ...(vadKnown
      ? {
          vad_runs_per_s_after_hangup: rows.map(row => row.vad_runs ?? 0),
          vad_runs_total_after_2s: settled.reduce((sum, row) => sum + (row.vad_runs ?? 0), 0),
        }
      : { vad_runs_per_s_after_hangup: '听诊器没数到(找不到 onnxruntime)' }),
    worker_cpu_ms_per_s_after_2s: stats(settled.map(row => row.cpu_ms)),
    gate_lines: gateLines.map(row => `${row.at - at >= 0 ? '+' : ''}${row.at - at}ms ${row.text.replace(/^\[channel-worker\] /, '')}`),
  }
}

function report(): void {
  const latencies = turns.flatMap(one => (one.latencyMs === undefined ? [] : [one.latencyMs]))
  const missed = turns.filter(one => one.latencyMs === undefined).length
  const callStart = turns[0]?.spokeEndAt ?? t0
  const inCall = <T extends { at: number }>(rows: readonly T[]): T[] => rows.filter(row => row.at >= callStart - 5000)
  const vad = inCall(vadDelays).map(row => row.ms)
  const diagInCall = inCall(diag)
  const summary = {
    label: LABEL,
    turns: TURNS,
    load: { count: LOAD_COUNT, policy: LOAD_POLICY, cmd: LOAD_CMD, runs: loadRuns.map(run => ({ ...run, seconds: run.endedAt === undefined ? undefined : Math.round((run.endedAt - run.startedAt) / 1000) })) },
    latency_ms: stats(latencies),
    missed_turns: missed,
    vad_delay_ms: { warnings: vad.length, max: vad.length === 0 ? 0 : Math.max(...vad), over_1s: vad.filter(ms => ms > 1000).length },
    vad_guard_lines: vadGuardLines.length,
    load_guard_lines: guardLines.map(row => row.text),
    asr_errors: asrErrors.length,
    asr_error_samples: asrErrors.slice(0, 5).map(row => row.text),
    volc: {
      sessions: volcSessions.length,
      max_packet_gap_ms: volcSessions.reduce((max, one) => Math.max(max, one.maxGapMs), 0),
      timeouts_45000081: volcSessions.reduce((sum, one) => sum + one.timeouts, 0),
      definites: volcSessions.reduce((sum, one) => sum + one.definites, 0),
    },
    worker_diag: {
      loop_lag_max_ms: diagInCall.reduce((max, row) => Math.max(max, row.lag_max_ms), 0),
      loop_lag_p99_max_ms: diagInCall.reduce((max, row) => Math.max(max, row.lag_p99_ms), 0),
      tick_gap_max_ms: diagInCall.reduce((max, row) => Math.max(max, row.gap_ms), 0),
      cpu_ms_per_s: stats(diagInCall.map(row => row.cpu_ms)),
      majflt_total: diagInCall.reduce((sum, row) => sum + row.majflt, 0),
      ivcsw_per_s: stats(diagInCall.map(row => row.ivcsw)),
      rss_mb_max: diagInCall.reduce((max, row) => Math.max(max, row.rss_mb), 0),
    },
    system: {
      load1: stats(inCall(sysSamples).map(row => row.load1)),
      swap_used_mb: stats(inCall(sysSamples).flatMap(row => (row.swapUsedMb === undefined ? [] : [row.swapUsedMb]))),
      pressure_max: inCall(sysSamples).reduce((max, row) => Math.max(max, row.pressure ?? 0), 0),
    },
    per_turn: turns.map(one => ({ turn: one.turn, latency_ms: one.latencyMs ?? null, ...(one.note === undefined ? {} : { note: one.note }) })),
    ...(hungUpAt === undefined ? {} : { after_hangup: afterHangup(hungUpAt) }),
    worker_turn_timings: turnTimings,
    home: HOME,
  }
  console.log('\n———— 结果 ————')
  console.log(JSON.stringify({ ...summary, worker_turn_timings: `${turnTimings.length} 条(见 --out)` }, null, 2))
  if (OUT !== undefined) {
    writeFileSync(OUT, `${JSON.stringify({ ...summary, raw: { vadDelays, diag, sysSamples, volcSessions, turns, vadGuardLines, guardLines, asrErrors } }, null, 2)}\n`)
    log(`结果写进了 ${OUT}`)
  }
}

async function teardown(): Promise<void> {
  stopLoad()
  sampling = false
  for (const child of [...children].reverse()) {
    try { child.kill('SIGTERM') } catch { /* 已经走了 */ }
  }
  for (const server of servers) server.close()
}

process.on('SIGINT', () => { void teardown().then(() => process.exit(130)) })
void (PHONE_MODE === 'app' ? mainApp() : main())
  .catch((err: unknown) => { console.error(`压测没跑完:${(err as Error)?.stack ?? String(err)}`); process.exitCode = 1 })
  .finally(() => { void teardown().then(() => setTimeout(() => process.exit(process.exitCode ?? 0), 1500)) })
