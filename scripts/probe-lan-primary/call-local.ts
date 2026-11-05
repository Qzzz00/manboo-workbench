/**
 * 探针②③:**本机房间里打一通来电**(铃 → 接 → 说一句 → 她回一句 → 挂),记时延;`--offline` 再看哪一步要云。
 *
 * 起的东西全是自己的,不碰 ~/.dsh、不碰正在跑的 8791 / 工人 / 云房间:
 *   - 一台「替身 8791」:`/channel/token` 由 **8791 自己那份 channel.ts 的 local 模式**签(createChannelService.issue);
 *     `/pair/*` 发一个探针设备;`/call/claim` 在手机进房后交下一通「等你回答」;`/channel/credentials`
 *     在线时转问真 8791(拿中转下发的火山识别钥匙,只在内存里交给工人,不打印)、离线时回 none;
 *     其余 POST 一律 {ok:true},不往真账里写任何东西。
 *   - 真的工人进程(channel-worker/src/main.ts),HOME 指到临时目录;接话模型用 dev/stub-llm.mjs(模型本在云上,单独记)。
 *   - 一台假手机(channel-worker/dev/fake-phone.ts --incoming auto --wav),走**局域网地址**进房。
 *
 * 用法(仓库根目录,先跑 lk-up.sh):
 *   node scripts/probe-lan-primary/call-local.ts --out <lk-up 的 OUT> [--offline] [--say '下午三点提醒我开会'] [--deps <node_modules>]
 *   --offline:识别钥匙给 none、8792 指到一个没人听的口、模型指到一个不通的地址 —— 模拟「外网断了」,
 *              看铃与进房还在不在、哪一步先断。
 * 输出:OUT/call-<online|offline>.json 与 OUT/call-<...>-{worker,phone}.log
 */
import { spawn, execFileSync, type ChildProcess } from 'node:child_process'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { existsSync, mkdtempSync, readFileSync, writeFileSync, createWriteStream, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = fileURLToPath(new URL('.', import.meta.url))
const repo = resolve(here, '..', '..')
const argv = process.argv
function arg(name: string, fallback?: string): string | undefined {
  const i = argv.indexOf(`--${name}`)
  return i >= 0 ? argv[i + 1] : fallback
}
const OUT = arg('out') ?? join(process.env.TMPDIR ?? '/tmp', 'wb-lan-probe')
const OFFLINE = argv.includes('--offline')
const LABEL = OFFLINE ? 'offline' : 'online'
const SAY = arg('say') ?? '好的,先放着,下午三点再提醒我。'
const REAL_8791 = arg('real-workbench') ?? 'http://127.0.0.1:8791'
const REAL_8792 = arg('real-butler') ?? 'http://127.0.0.1:8792'
const up = JSON.parse(readFileSync(join(OUT, 'up.json'), 'utf8')) as { signal: string }
const keys = Object.fromEntries(readFileSync(join(OUT, 'keys.env'), 'utf8').trim().split('\n').map(l => l.split('=') as [string, string]))
const WORKER_DIR = join(repo, 'channel-worker')
const depsDir = arg('deps')
if (!existsSync(join(WORKER_DIR, 'node_modules')) && depsDir !== undefined) symlinkSync(depsDir, join(WORKER_DIR, 'node_modules'))

const { createChannelService } = await import(pathToFileURL(join(repo, 'workbench-plugin', 'src', 'server', 'channel.ts')).href)
const channel = createChannelService({
  agentsFile: join(OUT, 'no-agents.md'),
  configFile: join(OUT, 'no-channel.json'),
  env: { WORKBENCH_CHANNEL_URL: up.signal, WORKBENCH_CHANNEL_API_KEY: keys.LK_KEY, WORKBENCH_CHANNEL_API_SECRET: keys.LK_SECRET, WORKBENCH_CHANNEL_ROOM: `lan-probe-${process.pid}` },
  rememberTool: 'wb_remember_item',
  doingTool: 'wb_doing',
})

const t0 = Date.now()
const events: { t: number, what: string }[] = []
const mark = (what: string): void => { events.push({ t: Date.now() - t0, what }); console.log(`+${Date.now() - t0}ms ${what}`) }
function body(req: IncomingMessage): Promise<string> {
  return new Promise((ok) => { const c: Buffer[] = []; req.on('data', d => c.push(d)); req.on('end', () => ok(Buffer.concat(c).toString('utf8'))) })
}
function json(res: ServerResponse, status: number, value: unknown): void { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(value)) }

const DEVICE_ID = 'lanprobe'
const DEVICE_TOKEN = `probe-${process.pid}`
let callHandedOut = false
let acks: unknown[] = []
const shim = createServer((req, res) => {
  void (async () => {
    const path = (req.url ?? '').split('?')[0] ?? ''
    const raw = await body(req)
    const input = (() => { try { return JSON.parse(raw === '' ? '{}' : raw) as Record<string, unknown> } catch { return {} } })()
    if (path === '/pair/start') return json(res, 200, { pairing: { code: '000000' } })
    if (path === '/pair/claim') return json(res, 200, { device_id: DEVICE_ID, token: DEVICE_TOKEN })
    if (path === '/channel/token' && req.method === 'POST') {
      const worker = input.worker === true
      const ticket = await channel.issue(worker ? { worker: true, name: '探针工人' } : { deviceId: DEVICE_ID, kind: 'phone', name: '探针手机' })
      mark(`替身 8791 签票:${worker ? '工人' : '手机'} → ${ticket.url} / ${ticket.room}`)
      return json(res, 200, ticket)
    }
    if (path === '/channel/persona') return json(res, 200, { system_message: '你是事务官。说话简短,一两句就够。', welcome: '我在。', addresses: ['老板'] })
    if (path === '/channel/credentials') {
      if (OFFLINE) return json(res, 200, { source: 'none', note: '探针:模拟断外网' })
      try { const r = await fetch(`${REAL_8791}/channel/credentials`, { signal: AbortSignal.timeout(8000) }); return json(res, r.status, await r.json()) }
      catch { return json(res, 200, { source: 'none' }) }
    }
    if (path === '/call/claim') {
      if (callHandedOut) return json(res, 200, { calls: [] })
      callHandedOut = true
      mark('替身 8791 交下一通来电(等你回答)')
      return json(res, 200, { calls: [{ id: `probe-call-${process.pid}`, reason: 'ask', item_id: 'probe-item', title: '探针:要不要现在开会', at: new Date().toISOString(), silent: false }] })
    }
    if (path === '/call/ack') { acks.push(input); mark(`工人报这通结果:${String(input.result)}`); return json(res, 200, { ok: true }) }
    if (req.method === 'POST') return json(res, 200, { ok: true })
    return json(res, 404, { error: '替身 8791 没有这一条' })
  })()
})
const shimPort = await new Promise<number>(ok => shim.listen(0, '127.0.0.1', () => ok((shim.address() as { port: number }).port)))

const children: ChildProcess[] = []
const nodeBin = process.execPath
const llmPort = 18000 + (process.pid % 1000)
children.push(spawn(nodeBin, [join(WORKER_DIR, 'dev', 'stub-llm.mjs'), String(llmPort)], { stdio: 'ignore' }))

// 他说的那句:用系统 say 合成,转 16k 单声道
const wav = join(OUT, 'utterance.wav')
if (!existsSync(wav)) {
  execFileSync('say', ['-v', 'Tingting', '-o', join(OUT, 'utterance.aiff'), SAY])
  execFileSync('afconvert', ['-f', 'WAVE', '-d', 'LEI16@16000', '-c', '1', join(OUT, 'utterance.aiff'), wav])
}

const HOME = mkdtempSync(join(tmpdir(), 'wb-lan-probe-home-'))
const workerLog = createWriteStream(join(OUT, `call-${LABEL}-worker.log`))
const worker = spawn(nodeBin, [join(WORKER_DIR, 'src', 'main.ts')], {
  cwd: WORKER_DIR,
  env: {
    PATH: process.env.PATH ?? '/usr/bin:/bin',
    HOME,
    LANG: 'en_US.UTF-8',
    WORKBENCH_CHANNEL_WORKBENCH_URL: `http://127.0.0.1:${shimPort}`,
    WORKBENCH_CHANNEL_BUTLER_URL: OFFLINE ? 'http://127.0.0.1:9' : REAL_8792,
    WORKBENCH_CHANNEL_LLM_BASE_URL: OFFLINE ? 'http://10.255.255.1/v1' : `http://127.0.0.1:${llmPort}/v1`,
    DEEPSEEK_API_KEY: 'stub-not-a-key',
    WORKBENCH_CHANNEL_INBOX_DIR: join(HOME, 'inbox'),
    WORKBENCH_CHANNEL_OUTBOX_DIR: join(HOME, 'outbox'),
    WORKBENCH_CHANNEL_TRANSFERS_FILE: join(HOME, 'transfers.jsonl'),
    WORKBENCH_CHANNEL_DEVICE_NAME: 'lan-probe',
    WORKBENCH_CHANNEL_WORKER_SUFFIX: 'lanprobe',
    WORKBENCH_CHANNEL_LOAD_GUARD: 'off',
    WORKBENCH_CHANNEL_TURN_ROUTER: 'rules',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
})
children.push(worker)
const workerLines: { t: number, line: string }[] = []
for (const s of [worker.stdout!, worker.stderr!]) {
  s.setEncoding('utf8')
  s.on('data', (chunk: string) => {
    for (const line of chunk.split('\n')) {
      if (line.trim() === '') continue
      workerLines.push({ t: Date.now() - t0, line }); workerLog.write(`${Date.now() - t0}\t${line}\n`)
      if (/进房了|进房:|识别|ASR|TTS|合成|失败|出错|error/i.test(line) && !line.startsWith('{')) mark(`工人:${line.slice(0, 140)}`)
    }
  })
}

// 等工人进房
const deadline = Date.now() + 60_000
while (!workerLines.some(l => l.line.includes('进房了')) && Date.now() < deadline) await new Promise(r => setTimeout(r, 200))
mark('工人在房里了,放假手机进房')

const phoneLog = createWriteStream(join(OUT, `call-${LABEL}-phone.log`))
const phone = spawn(nodeBin, [join(WORKER_DIR, 'dev', 'fake-phone.ts'), '--workbench', `http://127.0.0.1:${shimPort}`, '--incoming', 'auto', '--wav', wav, '--ring-wait', '60'], {
  cwd: WORKER_DIR, env: { ...process.env, HOME }, stdio: ['ignore', 'pipe', 'pipe'],
})
children.push(phone)
const phoneLines: { t: number, line: string }[] = []
for (const s of [phone.stdout!, phone.stderr!]) {
  s.setEncoding('utf8')
  s.on('data', (chunk: string) => {
    for (const line of chunk.split('\n')) {
      if (line.trim() === '' || line.startsWith('{"level"')) continue
      phoneLines.push({ t: Date.now() - t0, line }); phoneLog.write(`${Date.now() - t0}\t${line}\n`)
      mark(`手机:${line.slice(0, 160)}`)
    }
  })
}
const exitCode = await new Promise<number | null>(ok => { phone.on('exit', ok); setTimeout(() => ok(-1), 150_000) })
mark(`假手机退出(${exitCode})`)
await new Promise(r => setTimeout(r, 1500))

writeFileSync(join(OUT, `call-${LABEL}.json`), JSON.stringify({ label: LABEL, url: up.signal, say: SAY, events, acks, phone_exit: exitCode }, null, 2))
for (const c of children) { try { c.kill('SIGTERM') } catch { /* 已退 */ } }
shim.close()
process.exit(0)
