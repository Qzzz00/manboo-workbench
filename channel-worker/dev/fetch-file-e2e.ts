/**
 * 「手机从电脑取文件」端到端(2026-09-25,卡 J `feat/phone-fetch-file`)。**一条命令跑完,不碰真机、不碰 ~/.dsh。**
 *
 * 为什么要它:真机由统筹来验(维护者可能把手机带走),这张卡要的是一遍**可复现**的全链:
 * 找 → 复述确认 → 传 → 手机收到并校验 sha256,**局域网直连**与**不在局域网(走房间 `wb.file`)**两种网络各一遍,
 * 文本 / PDF / 图片 / 几十 MB 的大文件各一种,外加反方向(手机 → 电脑收件夹 → 电脑首页那一档)与几种失败。
 *
 * 它自己起一整套**灰度**的东西,全在一个 mkdtemp 目录里(`--dir` 指定父目录,缺省系统临时目录):
 *   - livekit-server(本机回环,随机一对 key/secret —— 那就是「中继房间」);
 *   - 灰度工作台 = workbench-plugin/scripts/channel-dev-server.ts(`--lan`:另起 0.0.0.0 监听,
 *     「局域网手机」从本机的局域网地址进来,8791 看到的是非回环来源,**设备令牌那道门是真的**);
 *   - 假接话模型 dev/stub-llm.mjs(本机没有 DeepSeek 的 key;模型的脑子是假的,**工具那几道闸、房间、字节流、落盘全是真的**);
 *   - 工人 src/main.ts(HOME 指到临时目录,收件 / 发件都在临时目录里;不接 8792:TTS 起不来,她只出字幕)。
 * 两台假手机都用手机 App 的同一套协议(`wb.rpc` / `wb.file`,与 butler-app/src/channel 逐字对齐):
 *   - **局域网手机**:HTTP 直连灰度工作台的局域网地址(带设备令牌);打字那条取文件走 `GET /files/offer/<单号>`;
 *   - **在外面的手机**:除了配对与领凭证,**一条 HTTP 都不直连**,全部经房间让工人代理;打字那条取文件走 `file_pull`。
 *
 * 测试用的文件全是这个脚本现写的(一份 README、一个 PDF、一张 PNG、40MB 的随机字节、一个 210MB 的稀疏文件),
 * **不传维护者的任何真文件**。跑完**不删**那个目录(留着看日志);要清就自己删那一个目录。
 *
 * 用法(在 channel-worker/ 里):
 *   node dev/fetch-file-e2e.ts [--dir <父目录>] [--big-mb 40] [--lk-port 7950] [--wb-port 8841] [--llm-port 8842] [--lan-ip 10.x.x.x]
 * 退出码:全部通过 0,否则 1。最后打一张表(每一行:哪条路、哪种网络、哪个文件、字节、sha256 对没对上、耗时)。
 *
 * `--serve`:**只把这一套灰度起来、不跑用例**,一直开着到 Ctrl-C —— 给人拿浏览器 / 真机对着它点界面用
 * (打印局域网地址与一个 6 位配对码;手机 App 在同一个 Wi-Fi 下扫码或输码就配上这台灰度,不碰真的 8791)。
 */
import { type ChildProcess, execFileSync, spawn } from 'node:child_process'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { closeSync, copyFileSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, truncateSync, unlinkSync, writeFileSync, writeSync, createWriteStream } from 'node:fs'
import { networkInterfaces, tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { deflateSync } from 'node:zlib'
import { Room } from '@livekit/rtc-node'

const HERE = dirname(fileURLToPath(import.meta.url))
const WORKER_DIR = resolve(HERE, '..')
const PLUGIN_DIR = resolve(HERE, '../../workbench-plugin')

function arg(name: string, fallback?: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`)
  return index >= 0 ? (process.argv[index + 1] ?? fallback) : fallback
}

const LK_PORT = Number(arg('lk-port', '7950'))
const WB_PORT = Number(arg('wb-port', '8841'))
const LLM_PORT = Number(arg('llm-port', '8842'))
const BIG_MB = Number(arg('big-mb', '40'))
const WORKER_ID = 'wb-channel-worker'
const RPC_TOPIC = 'wb.rpc'
const FILE_TOPIC = 'wb.file'

function stamp(): string {
  const now = new Date()
  return `${now.toTimeString().slice(0, 8)}.${String(now.getMilliseconds()).padStart(3, '0')}`
}
function log(line: string): void { console.log(`${stamp()}  ${line}`) }
const sleep = (ms: number): Promise<void> => new Promise(done => setTimeout(done, ms))
const sha256 = (bytes: Uint8Array | Buffer): string => createHash('sha256').update(bytes).digest('hex')

function lanIp(): string {
  const given = arg('lan-ip')
  if (given !== undefined) return given
  for (const list of Object.values(networkInterfaces())) {
    for (const one of list ?? []) {
      if (one.family === 'IPv4' && !one.internal && !one.address.startsWith('169.254.')) return one.address
    }
  }
  throw new Error('找不到本机的局域网地址(--lan-ip 指一个)')
}

// ———————————————————————— 测试夹具(全是现写的) ————————————————————————

const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n += 1) {
    let c = n
    for (let k = 0; k < 8; k += 1) c = (c & 1) !== 0 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1
    table[n] = c >>> 0
  }
  return table
})()
function crc32(buf: Buffer): number {
  let c = 0xFFFFFFFF
  for (const byte of buf) c = (CRC_TABLE[(c ^ byte) & 0xFF] as number) ^ (c >>> 8)
  return (c ^ 0xFFFFFFFF) >>> 0
}
/** 一张渐变 PNG(RGB)。 */
function makePng(width: number, height: number): Buffer {
  const chunk = (type: string, data: Buffer): Buffer => {
    const length = Buffer.alloc(4)
    length.writeUInt32BE(data.length)
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
    const crc = Buffer.alloc(4)
    crc.writeUInt32BE(crc32(body))
    return Buffer.concat([length, body, crc])
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0
  const rows: Buffer[] = []
  for (let y = 0; y < height; y += 1) {
    const row = Buffer.alloc(1 + width * 3)
    for (let x = 0; x < width; x += 1) {
      row[1 + x * 3] = Math.round((x / width) * 255)
      row[2 + x * 3] = Math.round((y / height) * 255)
      row[3 + x * 3] = 180
    }
    rows.push(row)
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(Buffer.concat(rows))),
    chunk('IEND', Buffer.alloc(0)),
  ])
}
/** 一页纸的 PDF(交叉引用表的偏移是算出来的,阅读器打得开)。 */
function makePdf(text: string): Buffer {
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 420 300] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    '',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ]
  const stream = `BT /F1 18 Tf 40 200 Td (${text}) Tj ET`
  objects[3] = `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`
  let out = '%PDF-1.4\n'
  const offsets: number[] = []
  objects.forEach((body, i) => {
    offsets.push(Buffer.byteLength(out))
    out += `${i + 1} 0 obj\n${body}\nendobj\n`
  })
  const xref = Buffer.byteLength(out)
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`
  for (const offset of offsets) out += `${String(offset).padStart(10, '0')} 00000 n \n`
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`
  return Buffer.from(out, 'latin1')
}
function writeRandom(path: string, mb: number): void {
  const fd = openSync(path, 'w')
  try { for (let i = 0; i < mb; i += 1) writeSync(fd, randomBytes(1024 * 1024)) }
  finally { closeSync(fd) }
}

// ———————————————————————— 起那几个进程 ————————————————————————

const children: { name: string, child: ChildProcess }[] = []
function start(name: string, cmd: string, args: string[], options: { cwd: string, env: Record<string, string>, logFile: string }): ChildProcess {
  const out = createWriteStream(options.logFile)
  const child = spawn(cmd, args, { cwd: options.cwd, env: { ...process.env, ...options.env }, stdio: ['ignore', 'pipe', 'pipe'] })
  child.stdout?.pipe(out)
  child.stderr?.pipe(out)
  children.push({ name, child })
  log(`起了 ${name}(pid ${child.pid ?? '?'},日志 ${options.logFile})`)
  return child
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
  let last: unknown
  while (Date.now() < deadline) {
    try {
      const got = await fn()
      if (got !== undefined && got !== false) return got as T
    }
    catch (err) { last = err }
    await sleep(everyMs)
  }
  throw new Error(`等「${label}」等了 ${Math.round(timeoutMs / 1000)} 秒没等到${last === undefined ? '' : `(${(last as Error).message})`}`)
}

// ———————————————————————— 假手机(与 butler-app 同一套协议) ————————————————————————

interface Received { name: string, bytes: Buffer, from: string, at: number, attributes?: Record<string, string>, progress: number[], total?: number }

class FakePhone {
  readonly room = new Room()
  token = ''
  deviceId = ''
  identity = ''
  readonly received: Received[] = []
  readonly captions: { role: string, text: string, at: number }[] = []
  readonly statuses: { name: string, ok: boolean, error?: string, at: number }[] = []
  private readonly pending = new Map<string, (message: Record<string, unknown>) => void>()
  private textQueue: Promise<void> = Promise.resolve()

  readonly label: string
  readonly network: 'lan' | 'remote'
  readonly urls: { loopback: string, lan: string }

  constructor(label: string, network: 'lan' | 'remote', urls: { loopback: string, lan: string }) {
    this.label = label
    this.network = network
    this.urls = urls
  }

  /** 这台手机「直连」时用的地址:局域网手机走局域网地址(非回环,令牌那道门是真的)。 */
  private get base(): string { return this.network === 'lan' ? this.urls.lan : this.urls.loopback }

  async pair(): Promise<void> {
    const started = await fetch(`${this.urls.loopback}/pair/start`, { method: 'POST' })
    const code = ((await started.json()) as { pairing?: { code?: string } }).pairing?.code
    if (code === undefined) throw new Error('拿不到配对码')
    const claimed = await fetch(`${this.base}/pair/claim`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code, device_name: this.label, platform: 'android' }),
    })
    const body = await claimed.json() as { device_id?: string, token?: string, error?: string }
    if (body.token === undefined || body.device_id === undefined) throw new Error(`配对没成:${body.error ?? claimed.status}`)
    this.token = body.token
    this.deviceId = body.device_id
  }

  async join(): Promise<void> {
    /**
     * 凭证:局域网手机自己从局域网地址要(带令牌,非回环);在外面的手机真机上是从中转领的,
     * 这里从回环要、带降权头(fake-phone.ts 同法)—— 两条拿到的凭证形状一模一样。
     */
    const res = await fetch(`${this.base}/channel/token`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${this.token}`,
        ...(this.network === 'remote' ? { 'x-workbench-channel-device': this.deviceId } : {}),
      },
      body: JSON.stringify({ name: this.label }),
    })
    const ticket = await res.json() as { url?: string, token?: string, identity?: string, error?: string }
    if (ticket.url === undefined || ticket.token === undefined) throw new Error(`领不到进房凭证:${ticket.error ?? res.status}`)
    this.identity = ticket.identity ?? ''
    this.room.registerTextStreamHandler(RPC_TOPIC, (reader, from) => {
      this.textQueue = this.textQueue.then(async () => {
        const text = await reader.readAll()
        if (from.identity !== WORKER_ID) return
        let message: Record<string, unknown>
        try { message = JSON.parse(text) as Record<string, unknown> }
        catch { return }
        if (message.type === 'caption') {
          if (message.final === true) this.captions.push({ role: String(message.role), text: String(message.text), at: Date.now() })
          return
        }
        if (message.type === 'file_status') {
          this.statuses.push({ name: String(message.name), ok: message.ok === true, ...(typeof message.error === 'string' ? { error: message.error } : {}), at: Date.now() })
          return
        }
        const resolveIt = this.pending.get(String(message.id ?? ''))
        if (resolveIt !== undefined) { this.pending.delete(String(message.id)); resolveIt(message) }
      })
    })
    this.room.registerByteStreamHandler(FILE_TOPIC, (reader, from) => {
      void (async () => {
        const info = reader.info as { name?: string, totalSize?: number, attributes?: Record<string, string> }
        const progress: number[] = []
        const chunks: Buffer[] = []
        let got = 0
        let last = 0
        try {
          for await (const chunk of reader) {
            chunks.push(Buffer.from(chunk))
            got += chunk.byteLength
            if (got - last >= 1024 * 1024) { last = got; progress.push(got) }
          }
        }
        catch (err) {
          this.statuses.push({ name: info.name ?? '?', ok: false, error: `收到一半断了:${(err as Error).message}`, at: Date.now() })
          return
        }
        const declared = info.totalSize ?? (info.attributes?.bytes === undefined ? undefined : Number(info.attributes.bytes))
        this.received.push({
          name: info.name ?? '未命名',
          bytes: Buffer.concat(chunks),
          from: from.identity,
          at: Date.now(),
          ...(info.attributes === undefined ? {} : { attributes: info.attributes }),
          progress,
          ...(declared === undefined ? {} : { total: declared }),
        })
      })()
    })
    await this.room.connect(ticket.url, ticket.token, { autoSubscribe: false, dynacast: false })
  }

  /** 发一条 wb.rpc,等同 id 的回包。 */
  async rpc(request: Record<string, unknown>, timeoutMs = 20_000): Promise<Record<string, unknown>> {
    const id = randomUUID()
    const answer = new Promise<Record<string, unknown>>((done, fail) => {
      this.pending.set(id, done)
      setTimeout(() => { if (this.pending.delete(id)) fail(new Error(`wb.rpc ${String(request.type)} ${timeoutMs}ms 没回`)) }, timeoutMs)
    })
    await this.room.localParticipant?.sendText(JSON.stringify({ id, ...request }), { topic: RPC_TOPIC, destinationIdentities: [WORKER_ID] })
    return await answer
  }

  /** 调 8791:局域网手机直连(带令牌);在外面的手机**只能**经房间让工人代理。 */
  async http(method: string, path: string, body?: unknown): Promise<{ status: number, body: Record<string, unknown> }> {
    if (this.network === 'remote') {
      const answer = await this.rpc({ type: 'http', method, path, ...(body === undefined ? {} : { body }) })
      return { status: Number(answer.status), body: (answer.body ?? {}) as Record<string, unknown> }
    }
    const res = await fetch(`${this.base}${path}`, {
      method,
      headers: { authorization: `Bearer ${this.token}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
    const text = await res.text()
    return { status: res.status, body: (text === '' ? {} : JSON.parse(text)) as Record<string, unknown> }
  }

  /** 局域网手机:直接下载一张取件单。 */
  async download(offer: string): Promise<{ status: number, bytes: Buffer, sha?: string, error?: string }> {
    const res = await fetch(`${this.base}/files/offer/${encodeURIComponent(offer)}`, { headers: { authorization: `Bearer ${this.token}` } })
    const bytes = Buffer.from(await res.arrayBuffer())
    if (!res.ok) {
      let error: string | undefined
      try { error = (JSON.parse(bytes.toString('utf8')) as { error?: string }).error } catch { error = undefined }
      return { status: res.status, bytes, ...(error === undefined ? {} : { error }) }
    }
    return { status: res.status, bytes, ...(res.headers.get('x-wb-sha256') === null ? {} : { sha: res.headers.get('x-wb-sha256') as string }) }
  }

  /** 等一个名字对得上的文件收完。 */
  async waitFile(name: string, sinceIndex: number, timeoutMs = 120_000): Promise<Received> {
    return await waitFor(`收到「${name}」`, () => this.received.slice(sinceIndex).find(one => one.name === name), timeoutMs, 100)
  }

  /** 等她说一句(final 字幕)里带某几个字。 */
  async waitCaption(match: (text: string) => boolean, sinceIndex: number, timeoutMs = 30_000): Promise<{ text: string, at: number }> {
    return await waitFor('她那一句', () => this.captions.slice(sinceIndex).find(one => one.role === 'butler' && match(one.text)), timeoutMs, 100)
  }

  async say(text: string): Promise<void> {
    const answer = await this.rpc({ type: 'onboarding', action: 'say', text })
    if (answer.ok !== true) throw new Error(`说不进去:${String(answer.error)}`)
  }

  async sendFile(path: string, name: string): Promise<void> {
    await this.room.localParticipant?.sendFile(path, { topic: FILE_TOPIC, name, destinationIdentities: [WORKER_ID] })
  }

  async leave(): Promise<void> { await this.room.disconnect().catch(() => {}) }
}

// ———————————————————————— 跑 ————————————————————————

interface Row { path: string, network: string, file: string, bytes: number | string, ok: boolean, sha: string, ms: number | string, note: string }
const rows: Row[] = []
function row(entry: Row): void {
  rows.push(entry)
  log(`${entry.ok ? '✅' : '❌'} ${entry.path} · ${entry.network} · ${entry.file} · ${entry.bytes} · sha ${entry.sha} · ${entry.ms}ms${entry.note === '' ? '' : ` · ${entry.note}`}`)
}

async function main(): Promise<void> {
  const parent = arg('dir') ?? tmpdir()
  mkdirSync(parent, { recursive: true })
  const base = mkdtempSync(join(parent, 'fetch-file-e2e-'))
  log(`工作目录:${base}(跑完不删,要清自己删这一个目录)`)
  const home = join(base, 'home')
  const scan = join(base, 'scan')
  const repo = join(scan, 'desktop-workbench')
  const material = join(scan, '素材')
  const workDir = join(base, 'mac', '事务官')
  const inbox = join(workDir, '收件')
  const outbox = join(workDir, '发件')
  const wbDir = join(base, 'wb')
  for (const dir of [home, join(repo, 'docs'), join(repo, 'assets'), material, inbox, outbox, join(wbDir, 'repo', 'docs', '记忆')]) mkdirSync(dir, { recursive: true })

  // 夹具:README(文本)、PDF、PNG、大文件、超上限的稀疏文件,外加两个不该被找到的陷阱。
  const readme = Buffer.from('# 工作台\n\n卡 J 端到端测试用的 README(这个脚本现写的,不是维护者的文件)。\n', 'utf8')
  writeFileSync(join(repo, 'README.md'), readme)
  writeFileSync(join(repo, 'docs', 'README.md'), Buffer.from('# docs\n', 'utf8'))
  writeFileSync(join(repo, 'docs', '产品说明.pdf'), makePdf('card J e2e fixture pdf'))
  writeFileSync(join(repo, 'assets', '首页截图.png'), makePng(320, 200))
  writeFileSync(join(repo, '.env'), 'NOT_A_REAL_SECRET=1\n')
  writeFileSync(join(repo, 'id_rsa'), 'not a key\n')
  execFileSync('git', ['init', '-q'], { cwd: repo })
  execFileSync('git', ['-c', 'user.email=e2e@local', '-c', 'user.name=e2e', 'add', '-A'], { cwd: repo })
  execFileSync('git', ['-c', 'user.email=e2e@local', '-c', 'user.name=e2e', 'commit', '-qm', 'fixture'], { cwd: repo })
  log(`写 ${BIG_MB}MB 的随机字节当大文件……`)
  writeRandom(join(material, '录屏-大文件.mov'), BIG_MB)
  writeFileSync(join(material, '超大-录屏.mov'), '')
  truncateSync(join(material, '超大-录屏.mov'), 210 * 1024 * 1024)
  writeFileSync(join(wbDir, 'repo', 'docs', '记忆', '授权.md'), [
    '| 项 | 说明 | 授权 | 日期 |', '|---|---|---|---|',
    '| `read_scan_roots` | 读扫描根 | 可以 | 2026-09-25 |',
    '| `write_api` | 写接口 | 可以 | 2026-09-25 |', '',
  ].join('\n'))
  const sourceSha = (path: string): string => sha256(readFileSync(path))

  // livekit(中继房间)
  const lkKey = 'cardj-e2e'
  const lkSecret = randomBytes(24).toString('hex')
  writeFileSync(join(base, 'livekit.yaml'), [
    `port: ${LK_PORT}`, 'bind_addresses: ["127.0.0.1"]', 'rtc:', `  tcp_port: ${LK_PORT + 1}`, `  udp_port: ${LK_PORT + 2}`, '  use_external_ip: false',
    'keys:', `  ${lkKey}: ${lkSecret}`, 'logging:', '  level: warn', '',
  ].join('\n'), { mode: 0o600 })
  start('livekit-server', 'livekit-server', ['--config', join(base, 'livekit.yaml'), '--node-ip', '127.0.0.1'], { cwd: base, env: {}, logFile: join(base, 'livekit.log') })

  const ip = lanIp()
  const urls = { loopback: `http://127.0.0.1:${WB_PORT}`, lan: `http://${ip}:${WB_PORT}` }
  start('灰度工作台', process.execPath, [
    join(PLUGIN_DIR, 'scripts/channel-dev-server.ts'),
    '--port', String(WB_PORT), '--dir', wbDir, '--scan-root', scan, '--work-dir', workDir, '--computer', '书房 Mac', '--lan',
    '--start-script', join(base, '没有这个启动脚本'), '--agents', join(home, 'AGENTS.md'),
  ], {
    cwd: PLUGIN_DIR,
    env: {
      HOME: home,
      WORKBENCH_CHANNEL_URL: `ws://127.0.0.1:${LK_PORT}`,
      WORKBENCH_CHANNEL_ROOM: 'cardj-e2e',
      WORKBENCH_CHANNEL_API_KEY: lkKey,
      WORKBENCH_CHANNEL_API_SECRET: lkSecret,
    },
    logFile: join(base, 'workbench.log'),
  })
  start('假接话模型', process.execPath, [join(WORKER_DIR, 'dev/stub-llm.mjs'), String(LLM_PORT)], { cwd: WORKER_DIR, env: {}, logFile: join(base, 'stub-llm.log') })
  await waitFor('灰度工作台起来', async () => (await fetch(`${urls.loopback}/channel/status`).then(r => r.ok, () => false)) || undefined, 60_000)
  await waitFor('局域网那台监听起来', async () => (await fetch(`${urls.lan}/state`).then(r => r.status === 401, () => false)) || undefined, 20_000)
  start('工人', process.execPath, [join(WORKER_DIR, 'src/main.ts')], {
    cwd: WORKER_DIR,
    env: {
      HOME: home,
      WORKBENCH_CHANNEL_WORKBENCH_URL: urls.loopback,
      WORKBENCH_CHANNEL_BUTLER_URL: 'http://127.0.0.1:9',
      WORKBENCH_CHANNEL_LLM_BASE_URL: `http://127.0.0.1:${LLM_PORT}/v1`,
      DEEPSEEK_API_KEY: 'stub-not-a-real-key',
      WORKBENCH_CHANNEL_INBOX_DIR: inbox,
      WORKBENCH_CHANNEL_OUTBOX_DIR: outbox,
      WORKBENCH_CHANNEL_DEVICE_NAME: '书房 Mac',
      // 本机回环上 40MB 也就一两秒:把「先回话」的门槛压到 0.3 秒,好让大文件走到「开始传了、电话不陪着等」那一支。
      WORKBENCH_CHANNEL_SEND_QUICK_MS: '300',
      WORKBENCH_CHANNEL_LOG_LEVEL: 'warn',
    },
    logFile: join(base, 'worker.log'),
  })
  await waitFor('工人进房', async () => {
    const status = await fetch(`${urls.loopback}/channel/status`).then(r => r.json() as Promise<{ worker?: boolean }>, () => ({ worker: false }))
    return status.worker === true || undefined
  }, 90_000, 500)
  log('工人在房里了')

  if (process.argv.includes('--serve')) {
    const started = await fetch(`${urls.loopback}/pair/start`, { method: 'POST' })
    const code = ((await started.json()) as { pairing?: { code?: string } }).pairing?.code ?? '?'
    log(`灰度开着:局域网 ${urls.lan},配对码 ${code}(5 分钟有效;要新的:curl -X POST ${urls.loopback}/pair/start)`)
    log(`测试文件在 ${scan};电脑收件夹 ${inbox}。Ctrl-C 停。`)
    await new Promise<void>((done) => { process.once('SIGINT', () => done()); process.once('SIGTERM', () => done()) })
    return
  }

  const lanPhone = new FakePhone('Ben 的手机', 'lan', urls)
  const remotePhone = new FakePhone('Ben 的平板', 'remote', urls)
  for (const phone of [lanPhone, remotePhone]) {
    await phone.pair()
    await phone.join()
    log(`${phone.label}(${phone.network === 'lan' ? '局域网' : '在外面'})进房了:${phone.identity}`)
  }
  await sleep(1500)

  const cases = [
    { ask: '把工作台仓库的 README 发到我手机上', name: 'README.md', path: join(repo, 'README.md') },
    { ask: '把产品说明.pdf 发我', name: '产品说明.pdf', path: join(repo, 'docs', '产品说明.pdf') },
    { ask: '把首页截图.png 发到手机上', name: '首页截图.png', path: join(repo, 'assets', '首页截图.png') },
    { ask: '把录屏-大文件.mov 发我', name: '录屏-大文件.mov', path: join(material, '录屏-大文件.mov') },
  ]

  // ① 打字那条(首页输入框):局域网直接下载;在外面经房间推。
  for (const phone of [lanPhone, remotePhone]) {
    const network = phone.network === 'lan' ? '局域网' : '在外面'
    for (const one of cases) {
      const asked = await phone.http('POST', '/butler/item', { text: one.ask, can_file_ask: true })
      const ask = asked.body.file_ask as { hits?: { offer: string, name: string, where: string, bytes: number }[], note?: string } | undefined
      const hit = ask?.hits?.[0]
      const expectSha = sourceSha(one.path)
      if (asked.status !== 200 || hit === undefined || hit.name !== one.name) {
        row({ path: '打字', network, file: one.name, bytes: '-', ok: false, sha: '-', ms: '-', note: `没找到对的那一个:${JSON.stringify(asked.body).slice(0, 200)}` })
        continue
      }
      if (JSON.stringify(asked.body).includes(scan)) {
        row({ path: '打字', network, file: one.name, bytes: hit.bytes, ok: false, sha: '-', ms: '-', note: '回给手机的卡里带了电脑上的路径' })
        continue
      }
      const t0 = Date.now()
      if (phone.network === 'lan') {
        const got = await phone.download(hit.offer)
        const ok = got.status === 200 && sha256(got.bytes) === expectSha && got.sha === expectSha
        row({ path: '打字', network, file: one.name, bytes: got.bytes.length, ok, sha: sha256(got.bytes) === expectSha ? '对上' : '对不上', ms: Date.now() - t0, note: `GET /files/offer(非回环 ${ip},带令牌);卡上「${hit.where}」` })
        continue
      }
      const before = phone.received.length
      const ack = await phone.rpc({ type: 'file_pull', offer: hit.offer })
      if (ack.ok !== true) {
        row({ path: '打字', network, file: one.name, bytes: '-', ok: false, sha: '-', ms: Date.now() - t0, note: `file_pull 没推:${String(ack.error)}` })
        continue
      }
      const got = await phone.waitFile(one.name, before, 180_000)
      const ok = sha256(got.bytes) === expectSha && got.attributes?.sha256 === expectSha
      row({ path: '打字', network, file: one.name, bytes: got.bytes.length, ok, sha: ok ? '对上' : '对不上', ms: got.at - t0, note: `file_pull → wb.file;进度回调 ${got.progress.length} 次;流上声明 ${got.total ?? '?'} 字节` })
    }
  }

  // ② 电话里说(同一套工具,两台手机各一遍)。模型是假的(stub-llm),工具那几道闸、房间、字节流是真的。
  for (const phone of [lanPhone, remotePhone]) {
    const network = phone.network === 'lan' ? '局域网' : '在外面'
    const begun = await phone.rpc({ type: 'onboarding', action: 'resume' })
    if (begun.ok !== true) { row({ path: '电话', network, file: '-', bytes: '-', ok: false, sha: '-', ms: '-', note: `引导那一通没接上:${String(begun.error)}` }); continue }
    await sleep(1500)
    for (const one of phone.network === 'lan' ? cases : [cases[0], cases[3]].filter((c): c is typeof cases[number] => c !== undefined)) {
      const since = phone.captions.length
      await phone.say(one.ask)
      const confirm = await phone.waitCaption(text => text.includes('对吗'), since, 30_000).catch(() => undefined)
      if (confirm === undefined) { row({ path: '电话', network, file: one.name, bytes: '-', ok: false, sha: '-', ms: '-', note: '她没复述' }); continue }
      const leaked = confirm.text.includes('/') || confirm.text.includes(scan)
      const before = phone.received.length
      const t0 = Date.now()
      const after = phone.captions.length
      await phone.say('对')
      let midCallMs: number | string = '-'
      if (one.name === '录屏-大文件.mov') {
        // 大文件:工具先回「开始传了」,**电话不陪着等** —— 这时候再问一句,她应该马上能答。
        await phone.waitCaption(text => text.includes('在传了'), after, 30_000).catch(() => undefined)
        const askAt = Date.now()
        const probe = phone.captions.length
        await phone.say('顺便问一下,现在电脑上在办什么')
        const replied = await phone.waitCaption(() => true, probe, 30_000).catch(() => undefined)
        midCallMs = replied === undefined ? '没答' : replied.at - askAt
      }
      const got = await phone.waitFile(one.name, before, 180_000).catch(() => undefined)
      if (got === undefined) { row({ path: '电话', network, file: one.name, bytes: '-', ok: false, sha: '-', ms: Date.now() - t0, note: `没收到;file_status:${JSON.stringify(phone.statuses.slice(-1))}` }); continue }
      const expectSha = sourceSha(one.path)
      const ok = sha256(got.bytes) === expectSha && got.attributes?.sha256 === expectSha && !leaked
      row({
        path: '电话',
        network,
        file: one.name,
        bytes: got.bytes.length,
        ok,
        sha: sha256(got.bytes) === expectSha ? '对上' : '对不上',
        ms: got.at - t0,
        note: `复述「${confirm.text}」${leaked ? '(念了路径!)' : ''}${midCallMs === '-' ? '' : `;传的时候再问一句,她 ${midCallMs}ms 就答了`}`,
      })
    }
    await phone.rpc({ type: 'onboarding', action: 'stop' }).catch(() => undefined)
  }

  // ③ 反方向:在外面的手机发一张照片 → 电脑收件夹 → 电脑首页那一档(butler_inbox 的 file)。
  {
    const photo = join(base, '照片-手机拍的.png')
    copyFileSync(join(repo, 'assets', '首页截图.png'), photo)
    const t0 = Date.now()
    await remotePhone.sendFile(photo, '照片-手机拍的.png')
    const landed = await waitFor('照片落进电脑收件夹', () => readdirSync(inbox).find(name => name === '照片-手机拍的.png'), 60_000, 200).catch(() => undefined)
    const ok = landed !== undefined && sourceSha(join(inbox, landed)) === sourceSha(photo)
    const state = await remotePhone.http('GET', '/state')
    const inboxItems = ((state.body.butler_inbox as { items?: { kind: string, title: string, note?: string }[] } | undefined)?.items ?? [])
    const shown = inboxItems.find(item => item.kind === 'file' && item.title.includes('照片-手机拍的.png'))
    row({ path: '反方向', network: '在外面', file: '照片-手机拍的.png', bytes: readFileSync(photo).length, ok: ok && shown !== undefined, sha: ok ? '对上' : '对不上', ms: Date.now() - t0, note: shown === undefined ? '电脑首页那一档没看见' : `电脑首页:「${shown.title}」${shown.note ?? ''}` })
  }

  // ④ 几种失败:要说清楚为什么,不能让人干等。
  {
    // 超上限(210MB 稀疏文件):局域网 413、在外面 file_pull 当场说。
    for (const phone of [lanPhone, remotePhone]) {
      const network = phone.network === 'lan' ? '局域网' : '在外面'
      const asked = await phone.http('POST', '/butler/item', { text: '把超大-录屏.mov 发我', can_file_ask: true })
      const hit = (asked.body.file_ask as { hits?: { offer: string, name: string }[] } | undefined)?.hits?.[0]
      if (hit === undefined) { row({ path: '失败·超上限', network, file: '超大-录屏.mov', bytes: '210MB', ok: false, sha: '-', ms: '-', note: '没找到' }); continue }
      const said = phone.network === 'lan'
        ? (await phone.download(hit.offer)).error ?? ''
        : String((await phone.rpc({ type: 'file_pull', offer: hit.offer })).error ?? '')
      row({ path: '失败·超上限', network, file: '超大-录屏.mov', bytes: '210MB', ok: said.includes('200MB'), sha: '-', ms: '-', note: `说的是「${said}」` })
    }
    // 开单之后文件被挪走:410 / 当场说「不在了」。
    for (const phone of [lanPhone, remotePhone]) {
      const network = phone.network === 'lan' ? '局域网' : '在外面'
      const temp = join(material, `临时-${phone.network}.txt`)
      writeFileSync(temp, '一会儿就删')
      const asked = await phone.http('POST', '/butler/item', { text: `把临时-${phone.network}.txt 发我`, can_file_ask: true })
      const hit = (asked.body.file_ask as { hits?: { offer: string }[] } | undefined)?.hits?.[0]
      unlinkSync(temp)
      if (hit === undefined) { row({ path: '失败·文件没了', network, file: `临时-${phone.network}.txt`, bytes: '-', ok: false, sha: '-', ms: '-', note: '没找到' }); continue }
      const said = phone.network === 'lan'
        ? (await phone.download(hit.offer)).error ?? ''
        : String((await phone.rpc({ type: 'file_pull', offer: hit.offer })).error ?? '')
      row({ path: '失败·文件没了', network, file: `临时-${phone.network}.txt`, bytes: '-', ok: said.includes('不在了'), sha: '-', ms: '-', note: `说的是「${said}」` })
    }
    // 别的手机拿同一张单:取不到(单子只开给问的那一台)。
    {
      const asked = await lanPhone.http('POST', '/butler/item', { text: '把工作台仓库的 README 发到我手机上', can_file_ask: true })
      const hit = (asked.body.file_ask as { hits?: { offer: string }[] } | undefined)?.hits?.[0]
      const stolen = hit === undefined ? undefined : await remotePhone.rpc({ type: 'file_pull', offer: hit.offer })
      row({ path: '失败·别人的单', network: '在外面', file: 'README.md', bytes: '-', ok: stolen !== undefined && stolen.ok !== true, sha: '-', ms: '-', note: `说的是「${String(stolen?.error ?? '')}」` })
    }
    // 陷阱:.env、id_rsa、.git 一个都不该出现在任何一张卡上。
    {
      const asked = await lanPhone.http('POST', '/butler/item', { text: '把 id_rsa 发我', can_file_ask: true })
      const hits = (asked.body.file_ask as { hits?: { name: string }[] } | undefined)?.hits ?? []
      row({ path: '边界·密钥', network: '局域网', file: 'id_rsa', bytes: '-', ok: hits.length === 0, sha: '-', ms: '-', note: hits.length === 0 ? '没找出来(对)' : `找出来了:${hits.map(h => h.name).join('、')}` })
    }
  }

  await lanPhone.leave()
  await remotePhone.leave()

  console.log('\n———— 结果 ————')
  console.log('| 路 | 网络 | 文件 | 字节 | sha256 | 耗时(ms) | 说明 |')
  console.log('|---|---|---|---|---|---|---|')
  for (const one of rows) console.log(`| ${one.ok ? '✅' : '❌'} ${one.path} | ${one.network} | ${one.file} | ${one.bytes} | ${one.sha} | ${one.ms} | ${one.note.replace(/\|/g, '/')} |`)
  const failed = rows.filter(one => !one.ok).length
  console.log(`\n${rows.length - failed}/${rows.length} 通过。日志在 ${base}(workbench.log / worker.log / stub-llm.log / livekit.log)`)
  process.exitCode = failed === 0 ? 0 : 1
}

main()
  .catch((err) => { console.error(`跑不下去了:${(err as Error).stack ?? String(err)}`); process.exitCode = 1 })
  .finally(async () => { await stopAll(); setTimeout(() => process.exit(process.exitCode ?? 0), 500) })
