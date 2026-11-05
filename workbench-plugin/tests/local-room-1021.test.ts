// @vitest-environment node
/**
 * 本机房间(局域网主路卡 M1,2026-10-21;设计稿第一节):钥匙、两份配置、8791 的看管。
 *
 * 文件真写,全落在 mktemp 出来的临时 HOME 里(路径一律由 `setupPaths({ home })` 算);
 * `launchctl` 与探 7880 都是注入的假的。
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  createLocalRoomService, ensureLocalRoomConfig, generateLocalRoomKeys, planLocalRoomConfig, portsOfUrl,
  readLivekitPort, renderLivekitYaml,
} from '../src/server/localRoom.ts'
import { localRoomOf } from '../src/server/machineId.ts'
import { nodeSetupIo, type SetupExecOptions, type SetupIo } from '../src/server/setup/io.ts'
import { LIVEKIT_ALT_PORTS, LIVEKIT_LAUNCHD_LABEL, LIVEKIT_PORTS, setupPaths } from '../src/server/setup/paths.ts'

const MACHINE = '3f9c0a1b22223333444455556666777a'
const ROOM = localRoomOf(MACHINE)
const KEYS = { apiKey: 'APIfixedkey0001', apiSecret: 'S'.repeat(40) }

const dirs: string[] = []
afterEach(() => { while (dirs.length) rmSync(dirs.pop() as string, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }) })

function home(): string {
  const dir = mkdtempSync(join(tmpdir(), 'wb-local-room-'))
  dirs.push(dir)
  return dir
}

function put(path: string, text: string, mode?: number): void {
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, text, mode === undefined ? 'utf8' : { encoding: 'utf8', mode })
}

describe('钥匙', () => {
  it('api key 是 API + 12 位字母数字,secret 至少 32 位字母数字;两次不同', () => {
    const one = generateLocalRoomKeys()
    const two = generateLocalRoomKeys()
    expect(one.apiKey).toMatch(/^API[A-Za-z0-9]{12}$/)
    expect(one.apiSecret).toMatch(/^[A-Za-z0-9]{43}$/)
    expect(one.apiKey).not.toBe(two.apiKey)
    expect(one.apiSecret).not.toBe(two.apiSecret)
  })
})

describe('livekit.yaml', () => {
  it('三个口、绑所有网卡、不问公网 IP、单个 UDP 口;钥匙用引号包着', () => {
    const yaml = renderLivekitYaml({ keys: KEYS, ports: LIVEKIT_PORTS })
    expect(yaml).toMatch(/^port: 7880$/m)
    expect(yaml).toContain('bind_addresses:\n  - "0.0.0.0"')
    expect(yaml).toMatch(/^ {2}tcp_port: 7881$/m)
    expect(yaml).toMatch(/^ {2}udp_port: 7882$/m)
    expect(yaml).toMatch(/^ {2}use_external_ip: false$/m)
    expect(yaml).toContain(`  "${KEYS.apiKey}": "${KEYS.apiSecret}"`)
    // 不写 node_ip(换了 Wi-Fi 也不必改它),不开 50000-60000 那一段。
    expect(yaml).not.toContain('node_ip')
    expect(yaml).not.toContain('port_range')
    expect(readLivekitPort(yaml)).toBe(7880)
  })

  it('信令口换到 7890 时,另两个口跟着整组换', () => {
    expect(portsOfUrl('ws://127.0.0.1:7890')).toEqual(LIVEKIT_ALT_PORTS)
    expect(portsOfUrl('ws://127.0.0.1:7880')).toEqual(LIVEKIT_PORTS)
    expect(portsOfUrl('ws://127.0.0.1')).toEqual(LIVEKIT_PORTS)
    const yaml = renderLivekitYaml({ keys: KEYS, ports: LIVEKIT_ALT_PORTS })
    expect(yaml).toMatch(/^port: 7890$/m)
    expect(yaml).toMatch(/^ {2}udp_port: 7892$/m)
  })
})

describe('两份配置怎么定(纯函数)', () => {
  const newKeys = (): typeof KEYS => KEYS

  it('没有 channel.json:现生成一对,地址回环 7880,房间 wb-local-<机器 id 前 8 位>', () => {
    const plan = planLocalRoomConfig({ newKeys, room: ROOM })
    expect(plan.state).toBe('written')
    expect(plan.generated).toBe(true)
    const channel = JSON.parse(plan.channelText as string) as Record<string, unknown>
    expect(channel).toEqual({ url: 'ws://127.0.0.1:7880', api_key: KEYS.apiKey, api_secret: KEYS.apiSecret, room: ROOM })
    expect(plan.yamlText).toBe(renderLivekitYaml({ keys: KEYS, ports: LIVEKIT_PORTS }))
  })

  it('channel.json 里只有识别钥匙那几格:原样留着,补上 LiveKit 那四格', () => {
    const plan = planLocalRoomConfig({ channelText: JSON.stringify({ volc_asr_app_id: 'a', volc_asr_access_token: 'b' }), newKeys, room: ROOM })
    const channel = JSON.parse(plan.channelText as string) as Record<string, unknown>
    expect(channel.volc_asr_app_id).toBe('a')
    expect(channel.volc_asr_access_token).toBe('b')
    expect(channel.api_key).toBe(KEYS.apiKey)
    expect(channel.url).toBe('ws://127.0.0.1:7880')
  })

  it('已经有一对指向本机的钥匙:沿用那一对(不换钥匙),livekit.yaml 照它写', () => {
    const had = { url: 'ws://127.0.0.1:7880', api_key: 'APIold', api_secret: 'o'.repeat(40), room: ROOM }
    const plan = planLocalRoomConfig({ channelText: JSON.stringify(had), newKeys, room: ROOM })
    expect(plan.generated).toBe(false)
    expect(plan.channelText).toBeUndefined()
    expect(plan.yamlText).toBe(renderLivekitYaml({ keys: { apiKey: 'APIold', apiSecret: 'o'.repeat(40) }, ports: LIVEKIT_PORTS }))
    expect(plan.state).toBe('written')
    // 两份都已经是这个样子:一个字都不写。
    const again = planLocalRoomConfig({ channelText: JSON.stringify(had), yamlText: plan.yamlText as string, newKeys, room: ROOM })
    expect(again.state).toBe('unchanged')
    expect(again.yamlText).toBeUndefined()
  })

  it('有钥匙、没写房间名:补上 wb-local-…;写了别的房间名(她自己定的)不改', () => {
    const plan = planLocalRoomConfig({ channelText: JSON.stringify({ api_key: 'APIold', api_secret: 'o'.repeat(40) }), newKeys, room: ROOM })
    expect(JSON.parse(plan.channelText as string)).toMatchObject({ url: 'ws://127.0.0.1:7880', room: ROOM })
    const own = planLocalRoomConfig({ channelText: JSON.stringify({ api_key: 'APIold', api_secret: 'o'.repeat(40), url: 'ws://127.0.0.1:7880', room: 'workbench' }), newKeys, room: ROOM })
    expect(own.channelText).toBeUndefined()
  })

  it('信令口已经换到 7890(livekit-start 写回过):yaml 照 7890 那一组写', () => {
    const had = { url: 'ws://127.0.0.1:7890', api_key: 'APIold', api_secret: 'o'.repeat(40), room: ROOM }
    const plan = planLocalRoomConfig({ channelText: JSON.stringify(had), newKeys, room: ROOM })
    expect(readLivekitPort(plan.yamlText as string)).toBe(7890)
  })

  it('拷来的云上那份(有钥匙、地址指向别处):不替她改,也不起本机房间', () => {
    const had = { url: 'wss://lk.example.cn', api_key: 'APIcloud', api_secret: 'c'.repeat(40) }
    const plan = planLocalRoomConfig({ channelText: JSON.stringify(had), newKeys, room: ROOM })
    expect(plan.state).toBe('foreign')
    expect(plan.channelText).toBeUndefined()
    expect(plan.yamlText).toBeUndefined()
    expect(plan.note).toContain('lk.example.cn')
    expect(plan.note).not.toContain('c'.repeat(40))
  })

  it('channel.json 写坏了:先留一份备份,再写新的(坏文件不该让本机房间永远起不来)', () => {
    const plan = planLocalRoomConfig({ channelText: '{这不是 JSON', newKeys, room: ROOM })
    expect(plan.state).toBe('written')
    expect(plan.backup).toBe(true)
    expect(JSON.parse(plan.channelText as string)).toMatchObject({ api_key: KEYS.apiKey })
  })

  it('取不到机器 id:房间名不写(8791 读不到 room 时自己按机器 id 补,取不到就是老缺省)', () => {
    const plan = planLocalRoomConfig({ newKeys })
    expect(JSON.parse(plan.channelText as string)).not.toHaveProperty('room')
  })
})

describe('真落盘(临时 HOME)', () => {
  it('两份都是 0600;再跑一次一个字都不动;回的那句话里没有 secret', async () => {
    const h = home()
    const paths = setupPaths({ home: h })
    const first = await ensureLocalRoomConfig({ io: nodeSetupIo(), paths, machineId: async () => MACHINE })
    expect(first.state).toBe('written')
    expect(first.generated).toBe(true)
    expect(statSync(paths.channelJson).mode & 0o777).toBe(0o600)
    expect(statSync(paths.livekitYaml).mode & 0o777).toBe(0o600)
    const channel = JSON.parse(readFileSync(paths.channelJson, 'utf8')) as { api_key: string, api_secret: string, room: string }
    expect(channel.room).toBe(ROOM)
    expect(readFileSync(paths.livekitYaml, 'utf8')).toContain(`"${channel.api_key}": "${channel.api_secret}"`)
    expect(first.note).not.toContain(channel.api_secret)

    const second = await ensureLocalRoomConfig({ io: nodeSetupIo(), paths, machineId: async () => MACHINE })
    expect(second.state).toBe('unchanged')
    expect(JSON.parse(readFileSync(paths.channelJson, 'utf8'))).toEqual(channel)
  })

  it('原来 0644 的 channel.json 改完也收成 0600;坏文件留了备份(也是 0600)', async () => {
    const h = home()
    const paths = setupPaths({ home: h })
    put(paths.channelJson, '{坏的', 0o644)
    const result = await ensureLocalRoomConfig({ io: nodeSetupIo(), paths, machineId: async () => MACHINE })
    expect(result.state).toBe('written')
    expect(statSync(paths.channelJson).mode & 0o777).toBe(0o600)
    const backups = (await nodeSetupIo().readdir(join(h, '.dsh/workbench')))
    const names = backups.ok ? backups.names.filter(name => name.startsWith('channel.json.bak-')) : []
    expect(names).toHaveLength(1)
    expect(readFileSync(join(h, '.dsh/workbench', names[0] as string), 'utf8')).toBe('{坏的')
    expect(statSync(join(h, '.dsh/workbench', names[0] as string)).mode & 0o777).toBe(0o600)
  })
})

// ───────────────────────── 8791 的看管 ─────────────────────────

interface Rig {
  paths: ReturnType<typeof setupPaths>
  calls: (readonly string[])[]
  io: SetupIo
  lan: string[]
  probes: string[]
  logs: string[]
  service: ReturnType<typeof createLocalRoomService>
  now: { at: number }
}

function rig(options: { installed?: boolean, probeOk?: boolean, kickOk?: boolean } = {}): Rig {
  const h = home()
  const paths = setupPaths({ home: h })
  if (options.installed !== false) {
    put(paths.livekitBin, '#!/bin/sh\n', 0o755)
    put(paths.livekitPlist, '<plist/>\n')
  }
  const calls: (readonly string[])[] = []
  const real = nodeSetupIo()
  const io: SetupIo = {
    ...real,
    exec: async (cmd: readonly string[], _opts?: SetupExecOptions) => {
      calls.push(cmd)
      return options.kickOk === false ? { ok: false, code: 113, out: 'Could not find service' } : { ok: true, code: 0, out: '' }
    },
    uid: () => 501,
  }
  const lan = ['10.0.0.5']
  const probes: string[] = []
  const logs: string[] = []
  const now = { at: Date.parse('2026-10-21T12:00:00Z') }
  const service = createLocalRoomService({
    io,
    paths,
    lanAddresses: () => lan,
    machineId: async () => MACHINE,
    fetchImpl: (async (url: string | URL) => {
      probes.push(String(url))
      if (options.probeOk === false) throw new Error('ECONNREFUSED')
      return new Response('OK', { status: 200 })
    }) as unknown as typeof fetch,
    now: () => now.at,
    log: line => logs.push(line),
  })
  return { paths, calls, io, lan, probes, logs, service, now }
}

const KICK = ['launchctl', 'kickstart', '-k', `gui/501/${LIVEKIT_LAUNCHD_LABEL}`]

describe('8791 看管本机房间', () => {
  it('第一次起来:装了二进制、没钥匙 → 补上两份配置并让 launchd 重起它(读到新配置)', async () => {
    const r = rig()
    await r.service.ensure()
    expect(existsSync(r.paths.channelJson)).toBe(true)
    expect(existsSync(r.paths.livekitYaml)).toBe(true)
    expect(r.calls).toContainEqual(KICK)
    // 再来一次:配置都在、一个字不改,不再重起。
    r.calls.length = 0
    await r.service.ensure()
    expect(r.calls).toEqual([])
  })

  it('没装二进制:一份配置都不写(写了钥匙 8791 就会给局域网里的设备签一间没人开的房)', async () => {
    const r = rig({ installed: false })
    await r.service.ensure()
    expect(existsSync(r.paths.channelJson)).toBe(false)
    expect(r.calls).toEqual([])
    const view = await r.service.view()
    expect(view.installed).toBe(false)
    expect(view.running).toBe(false)
    expect(view.note).toContain('没装')
  })

  it('局域网地址变了才重起:第一拍只记下,同样的地址不动,换了就 kickstart -k 并记下时刻与原因', async () => {
    const r = rig()
    await r.service.tick()
    expect(r.calls).toEqual([])
    await r.service.tick()
    expect(r.calls).toEqual([])
    r.lan.splice(0, r.lan.length, '192.168.31.8')
    r.now.at += 30_000
    await r.service.tick()
    expect(r.calls).toEqual([KICK])
    const view = await r.service.view()
    expect(view.restarted_at).toBe(new Date(r.now.at).toISOString())
    expect(view.restart_reason).toContain('192.168.31.8')
  })

  it('没装的机器上地址怎么变都不去 kickstart 一个不存在的项', async () => {
    const r = rig({ installed: false })
    await r.service.tick()
    r.lan.splice(0, r.lan.length, '192.168.31.8')
    await r.service.tick()
    expect(r.calls).toEqual([])
  })

  it('kickstart 没成:不记成「重起过」,日志里说一句', async () => {
    const r = rig({ kickOk: false })
    await r.service.tick()
    r.lan.splice(0, r.lan.length, '192.168.31.8')
    await r.service.tick()
    expect((await r.service.view()).restarted_at).toBeUndefined()
    expect(r.logs.join('\n')).toContain('113')
  })

  it('/channel/status 那一格:在不在(探 127.0.0.1:<yaml 里的口>)、地址、没有 secret', async () => {
    const r = rig()
    await r.service.ensure()
    const view = await r.service.view()
    expect(r.probes.at(-1)).toBe('http://127.0.0.1:7880/')
    expect(view).toMatchObject({ installed: true, running: true, url: 'ws://127.0.0.1:7880', lan_urls: ['ws://10.0.0.5:7880'] })
    const secret = (JSON.parse(readFileSync(r.paths.channelJson, 'utf8')) as { api_secret: string }).api_secret
    expect(JSON.stringify(view)).not.toContain(secret)
    expect(r.logs.join('\n')).not.toContain(secret)
  })

  it('探不到:running false,并说一句能照着做的话', async () => {
    const r = rig({ probeOk: false })
    await r.service.ensure()
    const view = await r.service.view()
    expect(view.running).toBe(false)
    expect(view.note).toContain('7880')
  })

  it('拷来的云上那份 channel.json:不写、不起,状态里说清楚是这个原因', async () => {
    const r = rig()
    put(r.paths.channelJson, JSON.stringify({ url: 'wss://lk.example.cn', api_key: 'APIcloud', api_secret: 'c'.repeat(40) }))
    await r.service.ensure()
    expect(existsSync(r.paths.livekitYaml)).toBe(false)
    expect(r.calls).toEqual([])
    const view = await r.service.view()
    expect(view.note).toContain('lk.example.cn')
    expect(JSON.stringify(view)).not.toContain('c'.repeat(40))
  })
})
