// @vitest-environment node
/**
 * 局域网主路 M2:8791 按来路签票(2026-10-21;docs/设计-局域网主路-2026-10-21.md 第二节)。
 *
 * 一台 Mac 上同一份 channel.json(`url: ws://127.0.0.1:7880`),给谁签出什么地址:
 *   - 工人(回环)→ `ws://127.0.0.1:7880`;
 *   - 局域网里的设备 → `ws://<这条请求进来的那块网卡>:7880`(设备能连上 8791 的那个地址,就一定连得上 7880);
 *   - 工人替房里的设备转来的(续期)→ 工人报它在哪间房:本机房间按这台 Mac 的局域网地址,云房间让中转签;
 *   - 外网来的设备(来路不是局域网网段)→ 才让中转签;中转签不出来再退回本机。
 * 在家签票一下都不碰中转 —— 中转不通不影响在家。
 */
import { describe, expect, it } from 'vitest'
import type { ChannelCredentialStore } from '../src/server/channelCredentials.ts'
import {
  CHANNEL_DEFAULT_ROOM,
  CHANNEL_DEFAULT_TOKEN_TTL_SECONDS,
  CHANNEL_LOCAL_TOKEN_TTL_SECONDS,
  advertisedUrlOf,
  channelConfigOf,
  channelModeOf,
  channelPlanOf,
  createChannelService,
  isPrivateAddress,
} from '../src/server/channel.ts'
import { CALL_TOOL_DOING, CALL_TOOL_REMEMBER } from '../src/server/rtcCall.ts'

const NOW = Math.floor(Date.parse('2026-10-21T09:00:00Z') / 1000)
const KEYS = { WORKBENCH_CHANNEL_API_KEY: 'devkey', WORKBENCH_CHANNEL_API_SECRET: 'secret' }
const MAC_ID = '3f9c0a1b22223333444455556666777a'

function payloadOf(token: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(token.split('.')[1] as string, 'base64url').toString()) as Record<string, unknown>
}

describe('channelModeOf:多一档 lan', () => {
  it('回环与 0.0.0.0 是 local', () => {
    for (const url of ['ws://127.0.0.1:7880', 'ws://localhost:7880', 'ws://[::1]:7880', 'ws://0.0.0.0:7880']) {
      expect(channelModeOf(url)).toBe('local')
    }
  })
  it('私网段、链路本地、Tailscale 那一段、.local 主机名是 lan(探针①里局域网地址被报成 remote 的那一处)', () => {
    for (const url of [
      'ws://10.86.37.27:7880', 'ws://192.168.1.5:7880', 'ws://172.16.0.9:7880', 'ws://172.31.255.1:7880',
      'ws://169.254.10.1:7880', 'ws://100.101.102.103:7880', 'ws://[fd00::5]:7880', 'ws://[fe80::1]:7880',
      'ws://bens-air.local:7880',
    ]) {
      expect(channelModeOf(url), url).toBe('lan')
    }
  })
  it('公网地址与域名仍是 remote', () => {
    for (const url of ['wss://lk.aibooo.cn', 'ws://your-aiboo-host:7880', 'ws://172.32.0.1:7880', 'ws://100.128.0.1:7880']) {
      expect(channelModeOf(url), url).toBe('remote')
    }
  })
  it('isPrivateAddress 认 IPv6 映射的 IPv4', () => {
    expect(isPrivateAddress('::ffff:192.168.1.5')).toBe(true)
    expect(isPrivateAddress('::ffff:8.8.8.8')).toBe(false)
    expect(isPrivateAddress(undefined)).toBe(false)
  })
})

describe('advertisedUrlOf:配置指向本机时把主机换成来路那块网卡', () => {
  it('回环 / 0.0.0.0 换成给定地址,端口与协议照旧', () => {
    expect(advertisedUrlOf('ws://127.0.0.1:7880', '10.86.37.27')).toBe('ws://10.86.37.27:7880')
    expect(advertisedUrlOf('ws://0.0.0.0:7890/', '192.168.1.5')).toBe('ws://192.168.1.5:7890/')
  })
  it('IPv6 映射的 IPv4 剥掉前缀;IPv6 加方括号', () => {
    expect(advertisedUrlOf('ws://127.0.0.1:7880', '::ffff:10.0.0.2')).toBe('ws://10.0.0.2:7880')
    expect(advertisedUrlOf('ws://127.0.0.1:7880', 'fd00::5')).toBe('ws://[fd00::5]:7880')
  })
  it('配置写的不是本机(云上那台、或已经写了局域网地址)就原样 —— 那是她自己定的地址', () => {
    expect(advertisedUrlOf('wss://lk.aibooo.cn', '10.86.37.27')).toBe('wss://lk.aibooo.cn')
    expect(advertisedUrlOf('ws://10.86.37.27:7880', '192.168.1.5')).toBe('ws://10.86.37.27:7880')
  })
  it('给的地址本身是回环或缺席:原样', () => {
    expect(advertisedUrlOf('ws://127.0.0.1:7880', '127.0.0.1')).toBe('ws://127.0.0.1:7880')
    expect(advertisedUrlOf('ws://127.0.0.1:7880', undefined)).toBe('ws://127.0.0.1:7880')
  })
})

describe('channelConfigOf:本机房间的房间名与有效期', () => {
  it('url 指向本机、没写 room:房间名用本机房间名;票缺省 24 小时', () => {
    const config = channelConfigOf(KEYS, undefined, { localRoom: 'wb-local-3f9c0a1b' })
    expect(config?.room).toBe('wb-local-3f9c0a1b')
    expect(config?.tokenTtlSeconds).toBe(CHANNEL_LOCAL_TOKEN_TTL_SECONDS)
    expect(CHANNEL_LOCAL_TOKEN_TTL_SECONDS).toBe(24 * 60 * 60)
  })
  it('channel.json 写了 room 就用它(装时定的那个)', () => {
    expect(channelConfigOf(KEYS, { room: 'wb-local-aaaabbbb' }, { localRoom: 'wb-local-3f9c0a1b' })?.room).toBe('wb-local-aaaabbbb')
  })
  it('拿不到机器 id 时退回老缺省 workbench(不编一个)', () => {
    expect(channelConfigOf(KEYS)?.room).toBe(CHANNEL_DEFAULT_ROOM)
  })
  it('url 指向别处(拷来的云上那份):房间名与 7 天有效期照旧', () => {
    const config = channelConfigOf({ ...KEYS, WORKBENCH_CHANNEL_URL: 'wss://lk.aibooo.cn' }, undefined, { localRoom: 'wb-local-3f9c0a1b' })
    expect(config?.room).toBe(CHANNEL_DEFAULT_ROOM)
    expect(config?.tokenTtlSeconds).toBe(CHANNEL_DEFAULT_TOKEN_TTL_SECONDS)
  })
  it('明写的有效期压过缺省', () => {
    expect(channelConfigOf({ ...KEYS, WORKBENCH_CHANNEL_TOKEN_TTL: '3600' }, undefined, { localRoom: 'wb-local-x' })?.tokenTtlSeconds).toBe(3600)
  })
})

describe('channelPlanOf:按来路选路线与地址', () => {
  const local = 'ws://127.0.0.1:7880'
  const lanAddresses = ['10.86.37.27', '192.168.64.1']

  it('没有来路(老调用方 / 探针直调):本机有钥匙签本机、地址原样,没有才中转', () => {
    expect(channelPlanOf({ localUrl: local, relay: true })).toEqual({ route: 'lan', url: local })
    expect(channelPlanOf({ relay: true })).toEqual({ route: 'relay' })
    expect(channelPlanOf({ relay: false })).toBeUndefined()
  })

  it('回环来的(工人、Mac 上的页面、ADB 反向的手机):本机签、回环地址', () => {
    expect(channelPlanOf({ localUrl: local, relay: true, lanAddresses, caller: { localAddress: '127.0.0.1', remoteAddress: '127.0.0.1' } }))
      .toEqual({ route: 'lan', url: local })
  })

  it('局域网里的设备:本机签、地址是它进来的那块网卡', () => {
    expect(channelPlanOf({ localUrl: local, relay: true, lanAddresses, caller: { localAddress: '192.168.64.1', remoteAddress: '192.168.64.3' } }))
      .toEqual({ route: 'lan', url: 'ws://192.168.64.1:7880' })
    expect(channelPlanOf({ localUrl: local, relay: true, lanAddresses, caller: { localAddress: '::ffff:10.86.37.27', remoteAddress: '::ffff:10.86.37.40' } }))
      .toEqual({ route: 'lan', url: 'ws://10.86.37.27:7880' })
  })

  it('局域网里的设备、本机没有钥匙:照今天让中转签', () => {
    expect(channelPlanOf({ relay: true, lanAddresses, caller: { localAddress: '10.86.37.27', remoteAddress: '10.86.37.40' } }))
      .toEqual({ route: 'relay' })
  })

  it('外网来的设备(来路不是局域网网段):中转签,中转签不出再退回本机', () => {
    expect(channelPlanOf({ localUrl: local, relay: true, lanAddresses, caller: { localAddress: '10.86.37.27', remoteAddress: '203.0.113.9' } }))
      .toEqual({ route: 'relay', fallback: { route: 'lan', url: 'ws://10.86.37.27:7880' } })
    // 零服务器档(没接中转):只能本机签。
    expect(channelPlanOf({ localUrl: local, relay: false, lanAddresses, caller: { localAddress: '10.86.37.27', remoteAddress: '203.0.113.9' } }))
      .toEqual({ route: 'lan', url: 'ws://10.86.37.27:7880' })
  })

  it('工人转来的:工人在云房间就让中转签,在本机房间就按这台 Mac 的第一个局域网地址', () => {
    expect(channelPlanOf({ localUrl: local, relay: true, lanAddresses, caller: { proxied: { route: 'relay' } } })).toEqual({ route: 'relay' })
    expect(channelPlanOf({ localUrl: local, relay: true, lanAddresses, caller: { proxied: { route: 'lan' } } }))
      .toEqual({ route: 'lan', url: 'ws://10.86.37.27:7880' })
    // 老工人不报房间:与今天一样(本机有钥匙签本机,没有就中转)。
    expect(channelPlanOf({ localUrl: local, relay: true, lanAddresses, caller: { proxied: {} } }))
      .toEqual({ route: 'lan', url: 'ws://10.86.37.27:7880' })
    expect(channelPlanOf({ relay: true, lanAddresses, caller: { proxied: {} } })).toEqual({ route: 'relay' })
    // 云房间的工人、但这台没接中转:签不出(不拿本机票糊弄一台在外面的手机)。
    expect(channelPlanOf({ localUrl: local, relay: false, lanAddresses, caller: { proxied: { route: 'relay' } } })).toBeUndefined()
  })

  it('本机点名要哪条(第二条工人进云房间):要 relay 就只走中转', () => {
    expect(channelPlanOf({ localUrl: local, relay: true, caller: { localAddress: '127.0.0.1', remoteAddress: '127.0.0.1', want: 'relay' } })).toEqual({ route: 'relay' })
    expect(channelPlanOf({ localUrl: local, relay: false, caller: { localAddress: '127.0.0.1', remoteAddress: '127.0.0.1', want: 'relay' } })).toBeUndefined()
    expect(channelPlanOf({ relay: true, caller: { localAddress: '127.0.0.1', remoteAddress: '127.0.0.1', want: 'lan' } })).toBeUndefined()
  })
})

/** 一份假的中转:记下被叫了几次;`fail` 时签不出。 */
function fakeRelay(options: { fail?: boolean } = {}): ChannelCredentialStore & { calls: string[] } {
  const calls: string[] = []
  return {
    calls,
    async get() {
      calls.push('get')
      if (options.fail === true) return { ok: false, reason: 'network', error: '中转连不上' }
      return { ok: true, credentials: { livekit: { configured: true, url: 'wss://lk.example.cn', room: 'wb-acc0123456789abc', token_ttl_seconds: 604800 } } }
    },
    async issueToken(input) {
      calls.push(`issue:${input.kind ?? 'join'}`)
      if (options.fail === true) return { ok: false, reason: 'network', error: '中转连不上' }
      return { ok: true, ticket: { url: 'wss://lk.example.cn', room: 'wb-acc0123456789abc', identity: input.identity, token: 'relay-signed', expires_at: NOW + 604800 } }
    },
    view() { return { cached: options.fail !== true, ...(options.fail === true ? {} : { livekit_configured: true }) } },
    forget() {},
  }
}

function service(options: { remote?: ChannelCredentialStore, fetchImpl?: typeof fetch, machineId?: string | 'fail', env?: Record<string, string> } = {}) {
  return createChannelService({
    agentsFile: '/不存在/AGENTS.md',
    env: options.env ?? KEYS,
    configFile: '/不存在/channel.json',
    nowSeconds: () => NOW,
    rememberTool: CALL_TOOL_REMEMBER,
    doingTool: CALL_TOOL_DOING,
    probeTimeoutMs: 200,
    lanAddresses: () => ['10.86.37.27'],
    machineId: async () => {
      if (options.machineId === 'fail') throw new Error('落不了盘')
      return options.machineId ?? MAC_ID
    },
    ...(options.remote === undefined ? {} : { remote: options.remote }),
    ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
  })
}

const LAN_PHONE = { localAddress: '10.86.37.27', remoteAddress: '10.86.37.40' }
const LOOPBACK = { localAddress: '127.0.0.1', remoteAddress: '127.0.0.1' }

describe('issue:同一台 Mac,工人票回环、设备票局域网地址', () => {
  it('工人那张:回环地址、本机房间、24 小时,路线 lan', async () => {
    const issued = await service().issue({ worker: true }, LOOPBACK)
    expect(issued).toMatchObject({ url: 'ws://127.0.0.1:7880', room: 'wb-local-3f9c0a1b', route: 'lan', expires_at: NOW + 24 * 3600 })
    expect(payloadOf(issued?.token ?? '').video).toMatchObject({ room: 'wb-local-3f9c0a1b', roomJoin: true })
  })

  it('局域网里的手机那张:地址是它进来的那块网卡,设备属性照旧签在票里', async () => {
    const issued = await service().issue({ deviceId: 'd1', kind: 'phone', name: '小米' }, LAN_PHONE)
    expect(issued).toMatchObject({ url: 'ws://10.86.37.27:7880', room: 'wb-local-3f9c0a1b', identity: 'wb-phone-d1', route: 'lan' })
    expect(payloadOf(issued?.token ?? '').attributes).toEqual({ wb_device_id: 'd1', wb_kind: 'phone' })
  })

  it('在家签票一下都不碰中转 —— 中转不通也签得出', async () => {
    const relay = fakeRelay({ fail: true })
    const issued = await service({ remote: relay }).issue({ deviceId: 'd1' }, LAN_PHONE)
    expect(issued?.url).toBe('ws://10.86.37.27:7880')
    expect(relay.calls).toEqual([])
  })

  it('外网来的手机:中转签(云房间);中转签不出就退回本机票', async () => {
    const outside = { localAddress: '10.86.37.27', remoteAddress: '203.0.113.9' }
    const ok = fakeRelay()
    expect(await service({ remote: ok }).issue({ deviceId: 'd1' }, outside)).toMatchObject({ url: 'wss://lk.example.cn', token: 'relay-signed', route: 'relay' })
    const down = fakeRelay({ fail: true })
    expect(await service({ remote: down }).issue({ deviceId: 'd1' }, outside)).toMatchObject({ url: 'ws://10.86.37.27:7880', route: 'lan' })
  })

  it('云房间里的工人替手机续期:中转签,地址是云房间', async () => {
    const relay = fakeRelay()
    const issued = await service({ remote: relay }).issue({ deviceId: 'd1' }, { proxied: { route: 'relay' } })
    expect(issued).toMatchObject({ url: 'wss://lk.example.cn', room: 'wb-acc0123456789abc', route: 'relay' })
  })

  it('本机房间里的工人替手机续期:本机签,地址是这台 Mac 的局域网地址(不是回环)', async () => {
    const issued = await service().issue({ deviceId: 'd1' }, { proxied: { route: 'lan' } })
    expect(issued).toMatchObject({ url: 'ws://10.86.37.27:7880', route: 'lan' })
  })

  it('机器 id 取不到:房间名退回 workbench,票照签', async () => {
    const issued = await service({ machineId: 'fail' }).issue({ worker: true }, LOOPBACK)
    expect(issued?.room).toBe(CHANNEL_DEFAULT_ROOM)
  })

  it('不带来路(老调用方):与改之前一字不差(地址原样)', async () => {
    const issued = await service().issue({ deviceId: 'd1' })
    expect(issued?.url).toBe('ws://127.0.0.1:7880')
    expect(issued?.route).toBe('lan')
  })
})

function listing(participants: readonly string[]): typeof fetch {
  return (async () => new Response(
    JSON.stringify({ participants: participants.map(identity => ({ identity })) }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  )) as unknown as typeof fetch
}

describe('status:地址与票同一条规矩', () => {
  it('局域网里的设备问:报局域网地址、mode lan;探房走本机回环', async () => {
    const seen: string[] = []
    const fetchImpl = (async (url: string) => {
      seen.push(String(url))
      return listing(['wb-channel-worker'])(url as never)
    }) as unknown as typeof fetch
    const status = await service({ fetchImpl }).status(LAN_PHONE)
    expect(status).toMatchObject({ configured: true, url: 'ws://10.86.37.27:7880', mode: 'lan', room: 'wb-local-3f9c0a1b', source: 'local', route: 'lan', server: true, worker: true, token_ttl_seconds: 24 * 3600 })
    expect(seen[0]).toBe('http://127.0.0.1:7880/twirp/livekit.RoomService/ListParticipants')
  })

  it('本机问:回环地址、mode local', async () => {
    const status = await service({ fetchImpl: listing([]) }).status(LOOPBACK)
    expect(status).toMatchObject({ url: 'ws://127.0.0.1:7880', mode: 'local', route: 'lan' })
  })

  it('本机房间没起:note 说的是「本机的 livekit-server」,哪怕问的是局域网里的设备', async () => {
    const status = await service({ fetchImpl: (async () => { throw new Error('ECONNREFUSED') }) as unknown as typeof fetch }).status(LAN_PHONE)
    expect(status.server).toBe(false)
    expect(status.note).toContain('先在本机把 livekit-server 起起来')
  })

  it('云房间里的工人替手机问:报云房间那一间(与续期同一间)', async () => {
    const status = await service({ remote: fakeRelay(), fetchImpl: listing(['wb-channel-worker']) }).status({ proxied: { route: 'relay' } })
    expect(status).toMatchObject({ url: 'wss://lk.example.cn', room: 'wb-acc0123456789abc', source: 'server', route: 'relay', mode: 'remote' })
  })
})

describe('route:给设备找回这台 Mac 的那张小表', () => {
  it('机器 id、本机房间名、给这位来者的本机房间地址、局域网地址列表、模式、中转在不在', async () => {
    const view = await service({ remote: fakeRelay() }).route(LAN_PHONE)
    expect(view).toEqual({
      mac_id: MAC_ID,
      room: 'wb-local-3f9c0a1b',
      lan_url: 'ws://10.86.37.27:7880',
      mode: 'lan',
      lan_addresses: ['10.86.37.27'],
      relay: { configured: true },
    })
  })

  it('不签票、不问中转、不探房(1 秒内答得出)', async () => {
    const relay = fakeRelay()
    let fetched = 0
    const fetchImpl = (async () => { fetched += 1; throw new Error('不该探') }) as unknown as typeof fetch
    await service({ remote: relay, fetchImpl }).route(LAN_PHONE)
    expect(relay.calls).toEqual([])
    expect(fetched).toBe(0)
  })

  it('本机没有钥匙:房间与地址缺席(说不出就不编),机器 id 照给', async () => {
    const view = await service({ env: {} }).route(LAN_PHONE)
    expect(view).toEqual({ mac_id: MAC_ID, lan_addresses: ['10.86.37.27'] })
  })

  it('机器 id 取不到:mac_id 缺席(手机据此判不到在家,不拿一个会变的数糊弄)', async () => {
    const view = await service({ machineId: 'fail' }).route(LAN_PHONE)
    expect(view.mac_id).toBeUndefined()
    expect(view.room).toBe(CHANNEL_DEFAULT_ROOM)
  })

  it('secret 一个字节都不在表里', async () => {
    expect(JSON.stringify(await service().route(LAN_PHONE))).not.toContain('secret')
  })
})
