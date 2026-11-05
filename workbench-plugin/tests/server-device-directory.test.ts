// @vitest-environment node
/**
 * 设备间传文件在 8791 这一侧的那几条(2026-09-21,docs/交接-0921-设备间传文件与找文件.md):
 *
 *   GET  /channel/search-roots  工人问「能在哪些目录里找」——门是授权表的 read_scan_roots。
 *   POST /channel/devices       工人报在线设备表(**只认回环**)。
 *   POST /channel/transfer      工人报一条传输记录(**只认回环**)。
 *   GET  /devices/online        电脑端与手机的记录面板读这张表。
 *   GET  /devices/transfers     最近的传输记录。
 *
 * 外加凭证里那行设备 metadata(在线设备表的全部可信度都在它上面)与第二台电脑的身份。
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { IncomingMessage } from 'node:http'
import { afterEach, describe, expect, it } from 'vitest'
import type { WorkbenchServer } from '../src/server/http.ts'
import { startWorkbenchServer } from '../src/server/http.ts'
import { CHANNEL_WORKER_IDENTITY, channelDeviceMetadata, channelIdentityOf, signAccessToken, joinGrant } from '../src/server/channel.ts'
import { createDeviceDirectoryService } from '../src/server/deviceDirectory.ts'
import { createAuthorizationService } from '../src/server/authorization.ts'
import { createAppConfig } from '../src/server/appConfig.ts'
import { createWorkbenchService } from '../src/server/service.ts'
import { createPairingService } from '../src/server/devices.ts'
import { lanOn } from './helpers/lanOn.ts'

const NOW_SEC = Math.floor(Date.parse('2026-09-21T09:00:00Z') / 1000)

const started: WorkbenchServer[] = []
const dirs: string[] = []
afterEach(async () => {
  while (started.length) await started.pop()?.close()
  while (dirs.length) rmSync(dirs.pop() as string, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
})

async function serve(options: { scanAuth?: '可以' | '不可以' } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'wb-devices-'))
  dirs.push(dir)
  const authFile = join(dir, '授权.md')
  writeFileSync(authFile, [
    '| 项 | 说明 | 授权 | 日期 |',
    '|---|---|---|---|',
    `| \`read_scan_roots\` | 读扫描根 | ${options.scanAuth ?? '不可以'} | 2026-09-21 |`,
    '',
  ].join('\n'), 'utf8')
  const authorization = createAuthorizationService({ file: authFile })
  const appConfig = createAppConfig({ file: join(dir, 'app.json') })
  await appConfig.set({ scan_roots: [{ path: `${dir}/GitHub`, depth: 1 }] })
  const deviceDirectory = createDeviceDirectoryService({ now: () => Date.parse('2026-09-21T09:00:00Z') })
  const pairing = createPairingService({ file: join(dir, 'devices.json'), now: () => NOW_SEC })

  let actor: 'local' | 'phone' = 'local'
  const server = await startWorkbenchServer({
    port: 0,
    service: createWorkbenchService({ now: () => NOW_SEC }),
    tickIntervalMs: 0,
    heartbeatMs: 0,
    pairing,
    authorization,
    deviceDirectory,
    paths: { home: dir, config: appConfig },
    remoteAddress: (_req: IncomingMessage) => (actor === 'local' ? '127.0.0.1' : '172.20.10.7'),
    // 2026-10-01:手机热点网段那条来源门例外撤掉了,扮演手机的用例照真机的样子把
    // 「允许手机在局域网访问」开着;验的还是设备令牌那道门(见 helpers/lanOn.ts)。
    lan: lanOn(),
  })
  started.push(server)
  pairing.start()
  const code = pairing.current()?.code ?? ''
  const claimed = await pairing.claim({ code, device_name: 'Ben 的手机', platform: 'android' })
  if (!claimed.ok) throw new Error('测试装置:配对没成')
  // 再配一台树莓派话筒(platform: handset)——「经中转进房的种类」那几条要用它。
  pairing.start()
  const handsetClaim = await pairing.claim({
    code: pairing.current()?.code ?? '', device_name: '客厅话筒', platform: 'handset',
  })
  if (!handsetClaim.ok) throw new Error('测试装置:话筒配对没成')

  const call = async (method: string, path: string, body?: unknown, withToken = false) => {
    const res = await fetch(`${server.url}${path}`, {
      method,
      headers: {
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        ...(withToken ? { authorization: `Bearer ${claimed.token}` } : {}),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
    const text = await res.text()
    return { status: res.status, body: (text === '' ? {} : JSON.parse(text)) as Record<string, unknown> }
  }
  return {
    server, call, who: (value: 'local' | 'phone') => { actor = value }, dir, deviceDirectory,
    phoneId: claimed.device_id, handsetId: handsetClaim.device_id,
  }
}

const mac = { identity: 'wb-channel-worker', device_id: 'mac-a', name: '书房 Mac', kind: 'mac' }
const phone = { identity: 'wb-phone-d1', device_id: 'd1', name: 'Ben 的手机', kind: 'phone' }

describe('凭证里那行设备 metadata', () => {
  it('工人是 mac、已配对的设备是 phone、测试页压根不给', () => {
    expect(JSON.parse(channelDeviceMetadata({ identity: 'wb-channel-worker', name: '书房 Mac', worker: true }) as string))
      .toEqual({ device_id: 'wb-channel-worker', name: '书房 Mac', kind: 'mac' })
    expect(JSON.parse(channelDeviceMetadata({ identity: 'wb-phone-d1', deviceId: 'd1', name: 'Ben 的手机' }) as string))
      .toEqual({ device_id: 'd1', name: 'Ben 的手机', kind: 'phone' })
    expect(channelDeviceMetadata({ identity: 'wb-dev-page' })).toBeUndefined()
  })

  it('没给名字就用 identity,**不编一个好看的名字**', () => {
    expect(JSON.parse(channelDeviceMetadata({ identity: 'wb-phone-d1', deviceId: 'd1' }) as string).name).toBe('wb-phone-d1')
  })

  it('metadata 真的签进了 JWT(持证人改不了的那一层)', () => {
    const token = signAccessToken({
      apiKey: 'k',
      apiSecret: 's',
      identity: 'wb-phone-d1',
      grant: joinGrant('workbench'),
      metadata: JSON.stringify(phone),
      ttlSeconds: 60,
      nowSeconds: NOW_SEC,
    })
    const payload = JSON.parse(Buffer.from(token.split('.')[1] as string, 'base64url').toString('utf8'))
    expect(JSON.parse(payload.metadata)).toEqual(phone)
    // 进房授权里**没有** canUpdateOwnMetadata —— 这正是这张表可信的全部理由。
    expect(payload.video.canUpdateOwnMetadata).toBeUndefined()
  })
})

describe('第二台电脑的身份', () => {
  it('第一台固定 wb-channel-worker(手机只认它);带后缀的才是第二台', () => {
    expect(channelIdentityOf({ worker: true })).toBe(CHANNEL_WORKER_IDENTITY)
    // 中文后缀会被清洗成连字符(身份要进 JWT 与房间列表,不给它带奇怪字节)——所以后缀该写英文。
    expect(channelIdentityOf({ worker: true, suffix: '客厅' })).toBe(`${CHANNEL_WORKER_IDENTITY}---`)
    expect(channelIdentityOf({ worker: true, suffix: 'macB' })).toBe(`${CHANNEL_WORKER_IDENTITY}-macB`)
  })
})

describe('在线设备表', () => {
  it('工人报一份,电脑端与手机都读得到', async () => {
    const h = await serve()
    expect((await h.call('POST', '/channel/devices', { devices: [mac, phone] })).status).toBe(200)
    const local = await h.call('GET', '/devices/online')
    expect(local.status).toBe(200)
    expect((local.body.devices as unknown[]).length).toBe(2)
    expect(local.body.stale).toBe(false)
    h.who('phone')
    const fromPhone = await h.call('GET', '/devices/online', undefined, true)
    expect(fromPhone.status).toBe(200)
    expect((fromPhone.body.devices as { name: string }[]).map(d => d.name)).toEqual(['书房 Mac', 'Ben 的手机'])
  })

  it('**手机改不了这张表**:写那一条只认回环', async () => {
    const h = await serve()
    h.who('phone')
    const res = await h.call('POST', '/channel/devices', { devices: [] }, true)
    expect(res.status).toBe(403)
  })

  it('没人报过时如实说「工人还没报过」,不假装房里没人', async () => {
    const h = await serve()
    const res = await h.call('GET', '/devices/online')
    expect(res.body.devices).toEqual([])
    expect(res.body.stale).toBe(true)
    expect(String(res.body.note)).toContain('还没报过')
  })

  /**
   * 2026-09-23:话筒经**中转**进房时凭证里没有 `wb_kind`(中转的设备种类一度只有
   * phone/other,派注册成了 other),工人只好把它报成 phone。这张表以配对记录为准,
   * 于是手机的座机页(只认 handset)不再说「座机不在线」。
   */
  describe('种类以配对记录为准', () => {
    it('配对记录里是 handset 的,哪怕工人报的是 phone,这张表也说 handset', async () => {
      const h = await serve()
      await h.call('POST', '/channel/devices', {
        devices: [
          mac,
          { identity: `wb-phone-${h.phoneId}`, device_id: h.phoneId, name: 'Ben 的手机', kind: 'phone' },
          { identity: `wb-phone-${h.handsetId}`, device_id: h.handsetId, name: '客厅话筒', kind: 'phone' },
        ],
      })
      const res = await h.call('GET', '/devices/online')
      const devices = res.body.devices as { device_id: string, kind: string }[]
      expect(devices.find(d => d.device_id === h.handsetId)?.kind).toBe('handset')
      // 手机还是手机、电脑还是电脑:只校正对得上配对记录的那几台。
      expect(devices.find(d => d.device_id === h.phoneId)?.kind).toBe('phone')
      expect(devices.find(d => d.device_id === 'mac-a')?.kind).toBe('mac')
    })

    it('配对表里没有的设备原样保留(另一台电脑、工人自己)', async () => {
      const h = await serve()
      await h.call('POST', '/channel/devices', { devices: [mac, phone] })
      const res = await h.call('GET', '/devices/online')
      expect((res.body.devices as { kind: string }[]).map(d => d.kind)).toEqual(['mac', 'phone'])
    })

    it('工人直接报 handset 也收得下(不再当成读不懂丢掉)', async () => {
      const h = await serve()
      await h.call('POST', '/channel/devices', {
        devices: [{ identity: 'wb-phone-x', device_id: 'x', name: '别人家的话筒', kind: 'handset' }],
      })
      const res = await h.call('GET', '/devices/online')
      expect((res.body.devices as { kind: string }[]).map(d => d.kind)).toEqual(['handset'])
    })
  })

  it('认不出来的上报一律丢掉(kind 不对、缺 identity)', async () => {
    const h = await serve()
    await h.call('POST', '/channel/devices', { devices: [mac, { identity: 'x' }, { kind: 'mac' }, '一个字符串'] })
    const res = await h.call('GET', '/devices/online')
    expect((res.body.devices as unknown[]).length).toBe(1)
  })
})

describe('传输记录', () => {
  it('工人报一条,读得到;新的在前;**里头没有文件内容**', async () => {
    const h = await serve()
    await h.call('POST', '/channel/transfer', { record: { at: '2026-09-21T09:00:00.000Z', direction: 'out', peer: 'Ben 的手机', name: 'README.md', bytes: 12, ok: true, by: 'butler' } })
    await h.call('POST', '/channel/transfer', { record: { at: '2026-09-21T09:01:00.000Z', direction: 'in', peer: 'Ben 的手机', name: '图.png', bytes: 40, ok: true } })
    const res = await h.call('GET', '/devices/transfers')
    const records = res.body.records as { name: string }[]
    expect(records.map(r => r.name)).toEqual(['图.png', 'README.md'])
    expect(JSON.stringify(records)).not.toContain('content')
  })

  it('看不懂的记录回 400,不往表里塞垃圾', async () => {
    const h = await serve()
    expect((await h.call('POST', '/channel/transfer', { record: { name: 'a' } })).status).toBe(400)
  })

  it('手机报不了传输记录(只认回环)', async () => {
    const h = await serve()
    h.who('phone')
    expect((await h.call('POST', '/channel/transfer', { record: {} }, true)).status).toBe(403)
  })
})

describe('能在哪些目录里找文件', () => {
  it('没授权就一个目录都不给,并且**把那句话原样带回去**(不是 403)', async () => {
    const h = await serve({ scanAuth: '不可以' })
    const res = await h.call('GET', '/channel/search-roots')
    expect(res.status).toBe(200)
    expect(res.body.allowed).toBe(false)
    expect(res.body.roots).toEqual([])
    expect(String(res.body.note)).toContain('read_scan_roots')
  })

  it('授权了就给扫描根(和项目区看的是同一份)', async () => {
    const h = await serve({ scanAuth: '可以' })
    const res = await h.call('GET', '/channel/search-roots')
    expect(res.body.allowed).toBe(true)
    expect((res.body.roots as { path: string }[]).map(r => r.path)).toEqual([`${h.dir}/GitHub`])
  })

  it('这条只给本机的工人问', async () => {
    const h = await serve({ scanAuth: '可以' })
    h.who('phone')
    expect((await h.call('GET', '/channel/search-roots', undefined, true)).status).toBe(403)
  })
})
