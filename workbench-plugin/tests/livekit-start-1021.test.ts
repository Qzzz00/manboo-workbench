// @vitest-environment node
/**
 * `deploy/livekit-start` 与 `deploy/ai.deepseek.livekit.plist`(局域网主路卡 M1,2026-10-21)。
 *
 * 脚本**真跑**:一个 mktemp 出来的沙箱当 `~/.dsh`(`DSH_HOME` 指过去),`livekit-server` 是一个只把参数记一行的假脚本,
 * `sw_vers` 也是假的(PATH 最前面)。端口用 `WORKBENCH_LIVEKIT_PRIMARY_PORT` / `_ALT_PORT` 指到这次现找的空口,
 * 「被占」由这个进程自己 listen 一个口造出来 —— 真 7880 一次不碰,真 launchctl 一次不发。
 */
import { spawn } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { renderLivekitYaml } from '../src/server/localRoom.ts'
import { renderPlist } from '../src/server/setup/install.ts'
import { LIVEKIT_ALT_PORTS, LIVEKIT_LAUNCHD_LABEL, LIVEKIT_MIN_MACOS_MAJOR, LIVEKIT_PORTS } from '../src/server/setup/paths.ts'
import { REPO_ROOT } from './helpers/shippedScripts.ts'

const START = join(REPO_ROOT, 'deploy', 'livekit-start')
const PLIST = join(REPO_ROOT, 'deploy', `${LIVEKIT_LAUNCHD_LABEL}.plist`)
const KEYS = { apiKey: 'APItestkey00001', apiSecret: 'T'.repeat(43) }
const PREFIX = join(tmpdir(), 'wb-livekit-start-')

const boxes: string[] = []
const servers: Server[] = []
afterEach(async () => {
  while (servers.length) await new Promise<void>((resolve) => { servers.pop()?.close(() => resolve()) })
  while (boxes.length) {
    const box = boxes.pop() as string
    if (!box.startsWith(PREFIX) || box.slice(PREFIX.length).includes('/')) throw new Error(`拒绝删除:${box}`)
    rmSync(box, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
  }
})

function put(path: string, text: string, mode?: number): void {
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, text)
  if (mode !== undefined) chmodSync(path, mode)
}

/** 占一个口(或者只为找一个空口:listen 0 再关掉)。 */
async function listen(port = 0, keep = true): Promise<number> {
  const server = createServer()
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', () => resolve()) })
  const got = (server.address() as { port: number }).port
  if (keep) servers.push(server)
  else await new Promise<void>((resolve) => { server.close(() => resolve()) })
  return got
}

/** 一组连着三个都空着的口(信令、+1、+2),从高端随便找。 */
async function freeSet(): Promise<number> {
  for (let i = 0; i < 50; i += 1) {
    const base = 20_000 + Math.floor(Math.random() * 30_000) * 1
    try {
      await listen(base, false)
      await listen(base + 1, false)
      return base
    }
    catch { /* 撞上了,换一组 */ }
  }
  throw new Error('找不到空口')
}

interface Box { home: string, dsh: string, out: string }

function box(options: { binary?: boolean, conf?: number, channel?: Record<string, unknown>, macos?: string } = {}): Box {
  const home = mkdtempSync(PREFIX)
  boxes.push(home)
  const dsh = join(home, '.dsh')
  const out = join(home, 'exec.log')
  if (options.binary !== false) put(join(dsh, 'livekit', 'livekit-server'), `#!/bin/sh\necho "$@" >> "${out}"\nexit 0\n`, 0o755)
  if (options.conf !== undefined) {
    put(join(dsh, 'livekit', 'livekit.yaml'), renderLivekitYaml({ keys: KEYS, ports: { signal: options.conf, tcp: options.conf + 1, udp: options.conf + 2 } }), 0o600)
  }
  if (options.channel !== undefined) put(join(dsh, 'workbench', 'channel.json'), JSON.stringify(options.channel), 0o600)
  put(join(home, 'fakebin', 'sw_vers'), `#!/bin/sh\necho "${options.macos ?? '26.6.2'}"\n`, 0o755)
  return { home, dsh, out }
}

async function runStart(b: Box, ports: { primary: number, alt: number }): Promise<{ status: number | null, out: string }> {
  const child = spawn('bash', [START], {
    env: {
      HOME: b.home,
      DSH_HOME: b.dsh,
      PATH: `${join(b.home, 'fakebin')}:${process.env.PATH ?? '/usr/bin:/bin'}`,
      WORKBENCH_LIVEKIT_PRIMARY_PORT: String(ports.primary),
      WORKBENCH_LIVEKIT_ALT_PORT: String(ports.alt),
    },
  })
  let out = ''
  child.stdout.on('data', (chunk) => { out += String(chunk) })
  child.stderr.on('data', (chunk) => { out += String(chunk) })
  const status = await new Promise<number | null>((resolve) => {
    const timer = setTimeout(() => child.kill('SIGKILL'), 30_000)
    child.on('close', (code) => { clearTimeout(timer); resolve(code) })
  })
  return { status, out }
}

const execed = (b: Box): string => (existsSync(b.out) ? readFileSync(b.out, 'utf8') : '')

describe('livekit-start:没准备好就以 0 退出(launchd 不会每 10 秒拉一次)', () => {
  it('没装二进制', async () => {
    const b = box({ binary: false, conf: 7880 })
    const got = await runStart(b, { primary: 7880, alt: 7890 })
    expect(got.status).toBe(0)
    expect(got.out).toContain('没装')
    expect(execed(b)).toBe('')
  })

  it('没有配置', async () => {
    const b = box()
    const got = await runStart(b, { primary: 7880, alt: 7890 })
    expect(got.status).toBe(0)
    expect(got.out).toContain('没有配置')
    expect(execed(b)).toBe('')
  })

  it('macOS 14', async () => {
    const primary = await freeSet()
    const b = box({ conf: primary, macos: '14.6.1' })
    const got = await runStart(b, { primary, alt: primary + 10 })
    expect(got.status).toBe(0)
    expect(got.out).toContain('14.6.1')
    expect(execed(b)).toBe('')
  })
})

describe('livekit-start:端口', () => {
  it('★口都空着:原样 exec livekit-server --config <yaml>,一个字都不改', async () => {
    const primary = await freeSet()
    const b = box({ conf: primary, channel: { url: `ws://127.0.0.1:${primary}`, api_key: KEYS.apiKey, api_secret: KEYS.apiSecret } })
    const before = readFileSync(join(b.dsh, 'livekit', 'livekit.yaml'), 'utf8')
    const got = await runStart(b, { primary, alt: primary + 10 })
    expect(got.status, got.out).toBe(0)
    expect(execed(b).trim()).toBe(`--config ${join(b.dsh, 'livekit', 'livekit.yaml')}`)
    expect(readFileSync(join(b.dsh, 'livekit', 'livekit.yaml'), 'utf8')).toBe(before)
    // 不打印钥匙。
    expect(got.out).not.toContain(KEYS.apiSecret)
  })

  it('★信令口被占:整组换到另一组,写回 livekit.yaml 三行与 channel.json 的地址(都还是 0600),再 exec', async () => {
    const primary = await freeSet()
    const alt = await freeSet()
    await listen(primary)
    const b = box({ conf: primary, channel: { url: `ws://127.0.0.1:${primary}`, api_key: KEYS.apiKey, api_secret: KEYS.apiSecret, volc_asr_app_id: 'x' } })
    const got = await runStart(b, { primary, alt })
    expect(got.status, got.out).toBe(0)
    const yaml = readFileSync(join(b.dsh, 'livekit', 'livekit.yaml'), 'utf8')
    expect(yaml).toContain(`port: ${alt}\n`)
    expect(yaml).toContain(`  tcp_port: ${alt + 1}\n`)
    expect(yaml).toContain(`  udp_port: ${alt + 2}\n`)
    expect(yaml).toContain(`"${KEYS.apiKey}": "${KEYS.apiSecret}"`)
    const channel = JSON.parse(readFileSync(join(b.dsh, 'workbench', 'channel.json'), 'utf8')) as Record<string, unknown>
    expect(channel).toMatchObject({ url: `ws://127.0.0.1:${alt}`, api_key: KEYS.apiKey, volc_asr_app_id: 'x' })
    expect(statSync(join(b.dsh, 'livekit', 'livekit.yaml')).mode & 0o777).toBe(0o600)
    expect(statSync(join(b.dsh, 'workbench', 'channel.json')).mode & 0o777).toBe(0o600)
    expect(execed(b)).toContain('--config')
    expect(got.out).toContain('换到')
    expect(got.out).not.toContain(KEYS.apiSecret)
  })

  it('兜底那个口(信令 +1)被占也换', async () => {
    const primary = await freeSet()
    const alt = await freeSet()
    await listen(primary + 1)
    const b = box({ conf: primary })
    const got = await runStart(b, { primary, alt })
    expect(got.status, got.out).toBe(0)
    expect(readFileSync(join(b.dsh, 'livekit', 'livekit.yaml'), 'utf8')).toContain(`port: ${alt}\n`)
  })

  it('两组都被占:说一句、以 0 退出,不 exec', async () => {
    const primary = await freeSet()
    const alt = await freeSet()
    await listen(primary)
    await listen(alt)
    const b = box({ conf: primary })
    const got = await runStart(b, { primary, alt })
    expect(got.status).toBe(0)
    expect(got.out).toContain('都被别的程序占着')
    expect(execed(b)).toBe('')
  })

  it('channel.json 指着别处:只改 livekit.yaml,channel.json 一个字不动', async () => {
    const primary = await freeSet()
    const alt = await freeSet()
    await listen(primary)
    const cloud = { url: 'wss://lk.example.cn', api_key: 'APIcloud', api_secret: 'c'.repeat(40) }
    const b = box({ conf: primary, channel: cloud })
    const got = await runStart(b, { primary, alt })
    expect(got.status, got.out).toBe(0)
    expect(JSON.parse(readFileSync(join(b.dsh, 'workbench', 'channel.json'), 'utf8'))).toEqual(cloud)
  })
})

describe('与 paths.ts 同一组数;plist 与另两项同一个模板', () => {
  const script = readFileSync(START, 'utf8')

  it('最低系统、两组口与 paths.ts 一致', () => {
    expect(script).toContain(`MIN_MACOS=${LIVEKIT_MIN_MACOS_MAJOR}\n`)
    expect(script).toContain(`WORKBENCH_LIVEKIT_PRIMARY_PORT:-${LIVEKIT_PORTS.signal}}`)
    expect(script).toContain(`WORKBENCH_LIVEKIT_ALT_PORT:-${LIVEKIT_ALT_PORTS.signal}}`)
    expect(LIVEKIT_ALT_PORTS.tcp).toBe(LIVEKIT_ALT_PORTS.signal + 1)
    expect(LIVEKIT_PORTS.udp).toBe(LIVEKIT_PORTS.signal + 2)
  })

  it('plist:Label、跑 livekit-start、RunAtLoad、崩了才拉、10 秒、日志在 ~/.dsh/logs;渲染后 plutil 过', async () => {
    const text = readFileSync(PLIST, 'utf8')
    expect(text).toContain(`<string>${LIVEKIT_LAUNCHD_LABEL}</string>`)
    expect(text).toContain('<string>{{HOME}}/.dsh/bin/livekit-start</string>')
    expect(text).toMatch(/<key>RunAtLoad<\/key>\s*<true\/>/)
    expect(text).toMatch(/<key>SuccessfulExit<\/key>\s*<false\/>/)
    expect(text).toMatch(/<key>ThrottleInterval<\/key>\s*<integer>10<\/integer>/)
    expect(text).toContain('{{HOME}}/.dsh/logs/livekit.stderr.log')
    const b = box()
    const rendered = join(b.home, 'rendered.plist')
    writeFileSync(rendered, renderPlist(text, b.home))
    const lint = spawn('plutil', ['-lint', rendered])
    const code = await new Promise<number | null>((resolve) => { lint.on('close', resolve) })
    expect(code).toBe(0)
  })
})
