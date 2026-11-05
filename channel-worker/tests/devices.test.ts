/**
 * 设备目录、设备之间那条通道、按文件名找文件、传输记录(2026-09-21 那张卡)。
 * 全是不需要房间、不需要密钥就能验到底的部分,所以验得细。
 */
import { describe, expect, it } from 'vitest'
import {
  createDeviceDirectory,
  deviceKindOfIdentity,
  deviceOfParticipant,
  encodeDeviceMetadata,
  parseDeviceMetadata,
  pickDevice,
  reportedDevices,
  spokenDeviceList,
  type DeviceInfo,
} from '../src/files/devices.ts'
import { encodeDevResponse, parseDevRequest, parseDevResponse } from '../src/files/deviceRpc.ts'
import {
  confirmText,
  pathAllowed,
  pathDeniedText,
  rememberFound,
  spokenSearchResults,
  type FoundPaths,
} from '../src/files/deviceTools.ts'
import {
  fileMatches,
  searchFiles,
  searchTerms,
  skipEntry,
  transferBlockReason,
  withinRoots,
} from '../src/files/search.ts'
import { createTransferLog, parseTransferLine, transferLine } from '../src/files/transfers.ts'

const mac: DeviceInfo = { identity: 'wb-channel-worker', device_id: 'mac-a', name: '书房 Mac', kind: 'mac' }
const macB: DeviceInfo = { identity: 'wb-channel-worker-b', device_id: 'mac-b', name: '客厅 Mac', kind: 'mac' }
const phone: DeviceInfo = { identity: 'wb-phone-d1', device_id: 'd1', name: 'Ben 的手机', kind: 'phone' }

describe('设备目录', () => {
  it('身份前缀决定是不是设备:测试页不是设备', () => {
    expect(deviceKindOfIdentity('wb-phone-d1')).toBe('phone')
    expect(deviceKindOfIdentity('wb-channel-worker')).toBe('mac')
    expect(deviceKindOfIdentity('wb-channel-worker-b')).toBe('mac')
    expect(deviceKindOfIdentity('wb-dev-page')).toBeUndefined()
    expect(deviceOfParticipant({ identity: 'wb-dev-page' })).toBeUndefined()
  })

  it('metadata 里的名字与 id 优先(凭证签的,持证人改不了)', () => {
    const device = deviceOfParticipant({
      identity: 'wb-phone-d1',
      metadata: encodeDeviceMetadata({ device_id: 'd1', name: 'Ben 的手机', kind: 'phone' }),
      attributes: { wb_device_id: 'd1' },
    })
    expect(device).toEqual(phone)
  })

  it('没有 metadata 时退回属性与 identity,名字**不编**', () => {
    const device = deviceOfParticipant({ identity: 'wb-phone-d1', attributes: { wb_device_id: 'dev-1' } })
    expect(device?.device_id).toBe('dev-1')
    expect(device?.name).toBe('wb-phone-d1')
    expect(device?.kind).toBe('phone')
  })

  it('坏 metadata 不把这条参与者带走', () => {
    expect(parseDeviceMetadata('{不是 json')).toBeUndefined()
    expect(parseDeviceMetadata('"一个字符串"')).toBeUndefined()
    expect(parseDeviceMetadata(JSON.stringify({ kind: '冰箱' }))?.kind).toBeUndefined()
    const device = deviceOfParticipant({ identity: 'wb-phone-d1', metadata: '{坏的' })
    expect(device?.kind).toBe('phone')
  })

  it('identity 前缀说了算:metadata 说自己是电脑也没用', () => {
    const device = deviceOfParticipant({
      identity: 'wb-phone-d1',
      metadata: encodeDeviceMetadata({ device_id: 'd1', name: '假装是电脑', kind: 'mac' }),
    })
    expect(device?.kind).toBe('phone')
  })

  it('表里永远有自己;进出房跟着改;不是设备的不收', () => {
    const directory = createDeviceDirectory(mac)
    expect(directory.list()).toEqual([mac])
    directory.upsert({ identity: 'wb-phone-d1', metadata: encodeDeviceMetadata(phone) })
    directory.upsert({ identity: 'wb-dev-page' })
    expect(directory.list().map(d => d.identity)).toEqual(['wb-channel-worker', 'wb-phone-d1'])
    directory.remove('wb-phone-d1')
    expect(directory.others()).toEqual([])
  })

  it('reset 按房里现有的人重铺,自己不会进 online 两次', () => {
    const directory = createDeviceDirectory(mac)
    directory.reset([
      { identity: 'wb-channel-worker' },
      { identity: 'wb-phone-d1', metadata: encodeDeviceMetadata(phone) },
      { identity: 'wb-channel-worker-b', metadata: encodeDeviceMetadata(macB) },
    ])
    expect(directory.list().map(d => d.name)).toEqual(['书房 Mac', 'Ben 的手机', '客厅 Mac'])
  })

  it('按名字挑设备;**说不准就不挑**(传错机器比传不过去糟)', () => {
    const all = [mac, macB, phone]
    expect(pickDevice(all, 'Ben 的手机')?.identity).toBe('wb-phone-d1')
    expect(pickDevice(all, '书房')?.identity).toBe('wb-channel-worker')
    expect(pickDevice(all, 'wb-phone-d1')?.identity).toBe('wb-phone-d1')
    expect(pickDevice(all, 'd1')?.identity).toBe('wb-phone-d1')
    // 「Mac」两台都沾边 —— 不挑。
    expect(pickDevice(all, 'Mac')).toBeUndefined()
    expect(pickDevice(all, '')).toBeUndefined()
  })

  it('念得出来的设备清单不出现 identity', () => {
    const text = spokenDeviceList([mac, phone])
    expect(text).toContain('书房 Mac(电脑)')
    expect(text).toContain('Ben 的手机(手机)')
    expect(text).not.toContain('wb-')
  })
})

describe('设备之间那条通道 wb.dev', () => {
  it('认得出四种请求', () => {
    expect(parseDevRequest(JSON.stringify({ id: '1', type: 'devices' }))).toEqual({ ok: true, request: { id: '1', type: 'devices' } })
    const search = parseDevRequest(JSON.stringify({ id: '2', type: 'search', query: ' README ' }))
    expect(search).toEqual({ ok: true, request: { id: '2', type: 'search', query: 'README' } })
    const send = parseDevRequest(JSON.stringify({ id: '3', type: 'send', path: '/a/b', to: 'wb-phone-d1' }))
    expect(send).toEqual({ ok: true, request: { id: '3', type: 'send', path: '/a/b', to: 'wb-phone-d1' } })
  })

  it('缺 id 连回都不回;缺字段如实说', () => {
    expect(parseDevRequest('{}')).toEqual({ ok: false, error: '缺 id' })
    expect(parseDevRequest('不是 json').ok).toBe(false)
    expect(parseDevRequest(JSON.stringify({ id: '1', type: 'search' }))).toMatchObject({ ok: false, id: '1' })
    expect(parseDevRequest(JSON.stringify({ id: '1', type: 'send', path: '/a' }))).toMatchObject({ ok: false, id: '1' })
    expect(parseDevRequest(JSON.stringify({ id: '1', type: '踢人' }))).toMatchObject({ ok: false, id: '1' })
  })

  it('回包太大就换成一条如实的 error,不发半截 JSON', () => {
    const huge = Array.from({ length: 40000 }, (_, i) => ({ path: `/很长的路径/${i}`.repeat(4), name: 'x', size: 1 }))
    const text = encodeDevResponse({ id: '9', type: 'search', device: mac, files: huge, total: huge.length, truncated: false })
    const parsed = parseDevResponse(text)
    expect(parsed?.type).toBe('error')
  })
})

describe('按文件名找文件', () => {
  const tree: Record<string, { name: string, isDirectory: boolean, isFile: boolean }[]> = {
    '/roots/GitHub': [
      { name: 'workbench', isDirectory: true, isFile: false },
      { name: '.env', isDirectory: false, isFile: true },
      { name: '.git', isDirectory: true, isFile: false },
      { name: 'node_modules', isDirectory: true, isFile: false },
    ],
    '/roots/GitHub/workbench': [
      { name: 'README.md', isDirectory: false, isFile: true },
      { name: '说明.md', isDirectory: false, isFile: true },
      { name: '.git', isDirectory: true, isFile: false },
    ],
    '/roots/GitHub/.git': [{ name: 'config', isDirectory: false, isFile: true }],
    '/roots/GitHub/workbench/.git': [{ name: 'README.md', isDirectory: false, isFile: true }],
    '/roots/GitHub/node_modules': [{ name: 'README.md', isDirectory: false, isFile: true }],
    '/别处': [{ name: 'README.md', isDirectory: false, isFile: true }],
  }
  const deps = {
    readdirImpl: async (dir: string) => {
      const entries = tree[dir]
      if (entries === undefined) throw new Error('读不到')
      return entries
    },
    statImpl: async () => ({ size: 1234, mtimeMs: 0 }),
  }

  it('每个词都要命中(词之间是「而且」)', () => {
    expect(searchTerms(' 工作台  README ')).toEqual(['工作台', 'readme'])
    expect(fileMatches('/a/workbench/README.md', ['workbench', 'readme'])).toBe(true)
    expect(fileMatches('/a/别的/README.md', ['workbench', 'readme'])).toBe(false)
    expect(fileMatches('/a/README.md', [])).toBe(false)
  })

  it('隐藏文件、.git、node_modules 一概不进结果', async () => {
    expect(skipEntry('.env')).toBe(true)
    expect(skipEntry('.git')).toBe(true)
    expect(skipEntry('node_modules')).toBe(true)
    const found = await searchFiles({ roots: [{ path: '/roots/GitHub' }], query: 'README' }, deps)
    expect(found.files.map(f => f.path)).toEqual(['/roots/GitHub/workbench/README.md'])
  })

  it('只在给的根底下找;根外的一个都不碰', async () => {
    const found = await searchFiles({ roots: [{ path: '/roots/GitHub' }], query: 'README' }, deps)
    expect(found.files.every(f => withinRoots(f.path, ['/roots/GitHub']))).toBe(true)
    expect(withinRoots('/roots/GitHub-别的/x', ['/roots/GitHub'])).toBe(false)
    expect(withinRoots('/roots/GitHub/x', ['/roots/GitHub'])).toBe(true)
    expect(withinRoots('/roots/GitHub', ['/roots/GitHub'])).toBe(true)
  })

  it('一个根读不到只记一条,不把整次搜索变成失败', async () => {
    const found = await searchFiles({ roots: [{ path: '/没有这个根' }, { path: '/roots/GitHub' }], query: 'README' }, deps)
    expect(found.errors).toHaveLength(1)
    expect(found.files).toHaveLength(1)
  })

  it('到了上限就如实说截断了', async () => {
    const found = await searchFiles({ roots: [{ path: '/roots/GitHub' }], query: '.md' }, { ...deps, resultLimit: 1 })
    expect(found.files).toHaveLength(1)
    expect(found.total).toBe(2)
    expect(found.truncated).toBe(true)
  })

  it('空 query 什么都不回(不许「搜个空的把全部列出来」)', async () => {
    const found = await searchFiles({ roots: [{ path: '/roots/GitHub' }], query: '   ' }, deps)
    expect(found.files).toEqual([])
  })

  it('发的那一刻再拦一次隐藏文件与 .git', () => {
    expect(transferBlockReason('/Users/example/.ssh/id_rsa')).toBeDefined()
    expect(transferBlockReason('/Users/example/repo/.git/config')).toBeDefined()
    expect(transferBlockReason('/Users/example/repo/README.md')).toBeUndefined()
  })
})

describe('两件工具的两道闸', () => {
  it('没搜到过的路径传不出去', () => {
    const table: FoundPaths = new Map()
    rememberFound(table, [{ device: mac, files: [{ path: '/a/README.md', name: 'README.md', size: 1 }], total: 1, truncated: false }])
    expect(pathAllowed(table, mac.identity, '/a/README.md')).toBe(true)
    expect(pathAllowed(table, mac.identity, '/Users/example/.ssh/id_rsa')).toBe(false)
    // 在这台机器上搜到的路径,不能拿去让另一台发。
    expect(pathAllowed(table, macB.identity, '/a/README.md')).toBe(false)
    expect(pathDeniedText('/x')).toContain('没有在任何一台设备上搜到过')
  })

  it('复述那一句把三样都说全:哪台、哪个文件、发到哪', () => {
    expect(confirmText({ from: mac, fileName: 'README.md', to: phone }))
      .toBe('把书房 Mac上的「README.md」发到Ben 的手机,对吗?')
  })

  it('搜索结果给模型看得见路径,但明写「不要念」', () => {
    const text = spokenSearchResults([
      { device: mac, files: [{ path: '/a/README.md', name: 'README.md', size: 2048 }], total: 1, truncated: false },
      { device: macB, files: [], total: 0, truncated: false, note: '那台电脑这会儿没回话' },
    ])
    expect(text).toContain('/a/README.md')
    expect(text).toContain('不要念给他听')
    expect(text).toContain('那台电脑这会儿没回话')
  })
})

describe('传输记录', () => {
  it('一条记录念出来是人话,而且**不含内容**', () => {
    const line = transferLine({
      at: '2026-09-21T10:11:12.000Z',
      direction: 'out',
      peer: 'Ben 的手机',
      name: 'README.md',
      bytes: 2048,
      ok: true,
    })
    expect(line).toContain('发给 Ben 的手机')
    expect(line).toContain('README.md')
    expect(line).toContain('2.0 KB')
  })

  it('失败的也记,而且写清没成', () => {
    expect(transferLine({ at: '2026-09-21T10:11:12.000Z', direction: 'out', peer: 'X', name: 'a', bytes: 0, ok: false, error: '太大了' }))
      .toContain('没成 —— 太大了')
  })

  it('坏行跳过,不把整份记录带走', () => {
    expect(parseTransferLine('{不是 json')).toBeUndefined()
    expect(parseTransferLine(JSON.stringify({ at: 'x', name: 'y', direction: '斜着' }))).toBeUndefined()
  })

  it('写不进去不抛;读不到就是空', async () => {
    const log = createTransferLog({
      file: '/写不进去/记录.jsonl',
      appendImpl: async () => { throw new Error('只读盘') },
      readImpl: async () => { throw new Error('没有这个文件') },
    })
    await expect(log.append({ direction: 'in', peer: 'X', name: 'a', bytes: 1, ok: true })).resolves.toMatchObject({ ok: true })
    await expect(log.recent()).resolves.toEqual([])
  })

  it('最近几条按时间倒着给', async () => {
    const lines: string[] = []
    const log = createTransferLog({
      file: '/tmp/记录.jsonl',
      appendImpl: async (_file, line) => { lines.push(line) },
      readImpl: async () => lines.join(''),
    })
    await log.append({ direction: 'out', peer: 'A', name: '一', bytes: 1, ok: true })
    await log.append({ direction: 'in', peer: 'B', name: '二', bytes: 2, ok: true })
    const recent = await log.recent()
    expect(recent.map(r => r.name)).toEqual(['二', '一'])
  })
})

/**
 * ★ 在线表心跳(2026-09-23 晚,维护者真机:话筒在线,App 却说「话筒不在线」)。
 * 8791 超过 5 分钟(300_000ms)没新报就标 stale —— 心跳必须比它的一半还短。
 */
describe('在线表心跳', () => {
  it('★ 缺省 60 秒一拍,小于 8791 陈旧阈值(5 分钟)的一半', async () => {
    const { DEVICES_HEARTBEAT_MS } = await import('../src/files/devices.ts')
    expect(DEVICES_HEARTBEAT_MS).toBe(60_000)
    expect(DEVICES_HEARTBEAT_MS).toBeLessThan(300_000 / 2)
  })

  it('★ 每一拍都把当下那张表再报一遍;停掉之后不再报', async () => {
    const { startDevicesHeartbeat } = await import('../src/files/devices.ts')
    let tick: () => void = () => {}
    let cleared = 0
    let reports = 0
    const stop = startDevicesHeartbeat({
      report: () => { reports += 1 },
      everyMs: 10,
      setInterval: (fn) => { tick = fn; return 1 },
      clearInterval: () => { cleared += 1 },
    })
    tick(); tick(); tick()
    expect(reports).toBe(3)
    stop(); stop()
    expect(cleared).toBe(1)
  })

  it('报不上去(抛 / 拒)不带走工人,下一拍照报', async () => {
    const { startDevicesHeartbeat } = await import('../src/files/devices.ts')
    let tick: () => void = () => {}
    let calls = 0
    startDevicesHeartbeat({
      report: () => { calls += 1; if (calls === 1) throw new Error('8791 没起'); return Promise.reject(new Error('拒了')) },
      setInterval: (fn) => { tick = fn; return 1 },
      clearInterval: () => {},
    })
    expect(() => tick()).not.toThrow()
    expect(() => tick()).not.toThrow()
    expect(calls).toBe(2)
  })
})

/**
 * 2026-09-28 真机:座机经中转记在账号下、没进那台电脑的配对表;通话照样通(挑接话对象看凭证里的
 * `wb_kind`),可报给 8791 的在线表把它写成「手机」—— 手机「给座机换网络」只找话筒,说「座机不在线」。
 */
describe('报给 8791 的在线表', () => {
  const mac: DeviceInfo = { identity: 'wb-channel-worker', device_id: 'wb-channel-worker', name: 'Air', kind: 'mac' }
  const phone: DeviceInfo = { identity: 'wb-phone-p1', device_id: 'p1', name: '小米', kind: 'phone' }
  const handset: DeviceInfo = { identity: 'wb-phone-handset-ab12', device_id: 'handset-ab12', name: '客厅话筒', kind: 'phone' }
  const kindOf = (identity: string) => (identity === handset.identity ? 'handset' as const : 'phone' as const)

  it('凭证里签了 handset 的那一台报成 handset', () => {
    expect(reportedDevices([mac, phone, handset], kindOf).map(device => device.kind)).toEqual(['mac', 'phone', 'handset'])
  })

  it('电脑不看凭证属性,永远是 mac', () => {
    expect(reportedDevices([mac], () => 'handset')[0]?.kind).toBe('mac')
  })

  it('别的字段原样', () => {
    expect(reportedDevices([handset], kindOf)[0]).toEqual({ ...handset, kind: 'handset' })
  })
})
