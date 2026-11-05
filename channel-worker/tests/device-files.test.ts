/**
 * 设备间传文件的**行为**那一层(2026-09-21):
 *   - `wb.dev` 的路由(A 让 B 找、A 让 B 发);
 *   - 两件工具的复述确认与路径白名单;
 *   - 发件目录按设备分文件夹。
 *
 * 这里不起房间:`handleDevRequest` 与 `createChannelTools` 都只认接口,房间那一层在 agent.ts。
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { handleDevRequest, type DevPort } from '../src/files/deviceRpc.ts'
import type { DeviceInfo } from '../src/files/devices.ts'
import type { DeviceSearchSlice } from '../src/files/deviceTools.ts'
import { ensureOutboxDirs, markSent, outboxDirNameOf, scanOutbox, scanOutboxTargets } from '../src/files/outbox.ts'
import { TOOL_SEARCH_FILES, TOOL_SEND_FILE, createChannelTools, type DeviceFilesPort } from '../src/tools.ts'
import type { WorkbenchClient } from '../src/workbench.ts'

/** 工具表里那几件的最小形状。`createChannelTools` 在没接房间时不给那两件,所以取用前收一下窄。 */
interface FakeTool { execute: (args: Record<string, unknown>, ctx: never) => Promise<unknown> }
type ToolTable = { [TOOL_SEARCH_FILES]: FakeTool, [TOOL_SEND_FILE]: FakeTool }
function toolsOf(value: unknown): ToolTable {
  return value as ToolTable
}

const macA: DeviceInfo = { identity: 'wb-channel-worker', device_id: 'mac-a', name: '书房 Mac', kind: 'mac' }
const macB: DeviceInfo = { identity: 'wb-channel-worker-b', device_id: 'mac-b', name: '客厅 Mac', kind: 'mac' }
const phone: DeviceInfo = { identity: 'wb-phone-d1', device_id: 'd1', name: 'Ben 的手机', kind: 'phone' }

const dirs: string[] = []
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop() as string, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
})
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'device-files-'))
  dirs.push(dir)
  return dir
}

/** 一台假的 B 机器:它自己有一份「搜得到的文件」,和一本「发出去了什么」的账。 */
function fakeMachine(self: DeviceInfo, files: readonly string[]) {
  const sent: { path: string, to: string }[] = []
  const found = new Set<string>()
  const port: DevPort = {
    self,
    devices: () => [self, macA, phone],
    searchHere: async (query: string): Promise<DeviceSearchSlice> => {
      const hits = files.filter(path => path.toLowerCase().includes(query.toLowerCase()))
      return { device: self, files: hits.map(path => ({ path, name: path.split('/').at(-1) as string, size: 10 })), total: hits.length, truncated: false }
    },
    sendLocal: async ({ path, to }) => {
      sent.push({ path, to: to.identity })
      return { ok: true, name: path.split('/').at(-1) as string, bytes: 10 }
    },
    recentTransfers: async () => [],
    found,
  }
  return { port, sent, found }
}

describe('wb.dev:A 让 B 找、A 让 B 发', () => {
  it('B 找到了就回结果,并把路径记进自己那张白名单', async () => {
    const machine = fakeMachine(macB, ['/repo/README.md', '/repo/别的.txt'])
    const answer = await handleDevRequest({ id: '1', type: 'search', query: 'README' }, { ...machine.port, asker: macA })
    expect(answer).toMatchObject({ id: '1', type: 'search', total: 1 })
    expect(machine.found.has('/repo/README.md')).toBe(true)
  })

  it('没搜过的路径,B **不传** —— 白名单在执行的那一头', async () => {
    const machine = fakeMachine(macB, ['/repo/README.md'])
    const answer = await handleDevRequest(
      { id: '2', type: 'send', path: '/Users/example/.ssh/id_rsa', to: phone.identity },
      { ...machine.port, asker: macA },
    )
    expect(answer).toMatchObject({ type: 'send', ok: false })
    expect(machine.sent).toEqual([])
  })

  it('搜过的路径才传得出去,收件人是指定的那一台', async () => {
    const machine = fakeMachine(macB, ['/repo/README.md'])
    await handleDevRequest({ id: '1', type: 'search', query: 'README' }, { ...machine.port, asker: macA })
    const answer = await handleDevRequest(
      { id: '2', type: 'send', path: '/repo/README.md', to: phone.identity },
      { ...machine.port, asker: macA },
    )
    expect(answer).toMatchObject({ type: 'send', ok: true, name: 'README.md' })
    expect(machine.sent).toEqual([{ path: '/repo/README.md', to: 'wb-phone-d1' }])
  })

  it('收件人不在房里就不传,并如实说', async () => {
    const machine = fakeMachine(macB, ['/repo/README.md'])
    await handleDevRequest({ id: '1', type: 'search', query: 'README' }, { ...machine.port, asker: macA })
    const answer = await handleDevRequest(
      { id: '2', type: 'send', path: '/repo/README.md', to: 'wb-phone-走了' },
      { ...machine.port, asker: macA },
    )
    expect(answer).toMatchObject({ type: 'send', ok: false, error: '那台设备此刻不在房里' })
    expect(machine.sent).toEqual([])
  })

  it('B 那边抛了也只变成一条 error,不把房间带走', async () => {
    const machine = fakeMachine(macB, [])
    const port: DevPort = { ...machine.port, searchHere: async () => { throw new Error('磁盘坏了') } }
    const answer = await handleDevRequest({ id: '3', type: 'search', query: 'x' }, { ...port, asker: macA })
    expect(answer).toEqual({ id: '3', type: 'error', error: '磁盘坏了' })
  })
})

describe('两件工具', () => {
  const workbench = {} as unknown as WorkbenchClient

  function fakePort(overrides: Partial<DeviceFilesPort> = {}) {
    const sends: { from: string, path: string, to: string }[] = []
    const port: DeviceFilesPort = {
      devices: () => [macA, macB, phone],
      self: () => macA,
      search: async () => [
        { device: macB, files: [{ path: '/repo/README.md', name: 'README.md', size: 10 }], total: 1, truncated: false },
      ],
      send: async ({ from, path, to }) => {
        sends.push({ from: from.identity, path, to: to.identity })
        return { ok: true, name: 'README.md', bytes: 10 }
      },
      ...overrides,
    }
    return { port, sends }
  }

  it('第一次调用传文件**一定不传**,只给一句复述', async () => {
    const { port, sends } = fakePort()
    const tools = toolsOf(createChannelTools({ workbench, deviceFiles: port }))
    await tools[TOOL_SEARCH_FILES].execute({ query: 'README' }, {} as never)
    const text = String(await tools[TOOL_SEND_FILE].execute(
      { device: '客厅 Mac', path: '/repo/README.md', to: 'Ben 的手机' },
      {} as never,
    ))
    expect(text).toContain('把客厅 Mac上的「README.md」发到Ben 的手机,对吗?')
    expect(sends).toEqual([])
  })

  it('他点头之后(confirmed)才真传', async () => {
    const { port, sends } = fakePort()
    const tools = toolsOf(createChannelTools({ workbench, deviceFiles: port }))
    await tools[TOOL_SEARCH_FILES].execute({ query: 'README' }, {} as never)
    const text = String(await tools[TOOL_SEND_FILE].execute(
      { device: '客厅 Mac', path: '/repo/README.md', to: 'Ben 的手机', confirmed: true },
      {} as never,
    ))
    expect(text).toContain('发过去了')
    expect(sends).toEqual([{ from: macB.identity, path: '/repo/README.md', to: phone.identity }])
  })

  it('没搜过就直接说传文件:一律拒,连复述都不给', async () => {
    const { port, sends } = fakePort()
    const tools = toolsOf(createChannelTools({ workbench, deviceFiles: port }))
    const text = String(await tools[TOOL_SEND_FILE].execute(
      { device: '客厅 Mac', path: '/Users/example/.ssh/id_rsa', to: 'Ben 的手机', confirmed: true },
      {} as never,
    ))
    expect(text).toContain('没有在任何一台设备上搜到过这条路径')
    expect(sends).toEqual([])
  })

  it('在这台上搜到的路径,不能拿去让另一台发', async () => {
    const { port, sends } = fakePort()
    const tools = toolsOf(createChannelTools({ workbench, deviceFiles: port }))
    await tools[TOOL_SEARCH_FILES].execute({ query: 'README' }, {} as never)
    const text = String(await tools[TOOL_SEND_FILE].execute(
      { device: '书房 Mac', path: '/repo/README.md', to: 'Ben 的手机', confirmed: true },
      {} as never,
    ))
    expect(text).toContain('没有在任何一台设备上搜到过')
    expect(sends).toEqual([])
  })

  it('设备名说不上来时把在线的都报出来,让她去问', async () => {
    const { port } = fakePort()
    const tools = toolsOf(createChannelTools({ workbench, deviceFiles: port }))
    await tools[TOOL_SEARCH_FILES].execute({ query: 'README' }, {} as never)
    const text = String(await tools[TOOL_SEND_FILE].execute(
      { device: '楼下那台', path: '/repo/README.md', to: 'Ben 的手机', confirmed: true },
      {} as never,
    ))
    expect(text).toContain('此刻在线的是')
    expect(text).toContain('客厅 Mac')
  })

  it('没成就说没成,不许让她以为办好了', async () => {
    const { port } = fakePort({ send: async () => ({ ok: false, error: '那台电脑这会儿没回话' }) })
    const tools = toolsOf(createChannelTools({ workbench, deviceFiles: port }))
    await tools[TOOL_SEARCH_FILES].execute({ query: 'README' }, {} as never)
    const text = String(await tools[TOOL_SEND_FILE].execute(
      { device: '客厅 Mac', path: '/repo/README.md', to: 'Ben 的手机', confirmed: true },
      {} as never,
    ))
    expect(text).toContain('没发过去')
    expect(text).toContain('跟他如实说一声')
  })

  it('没接上房间就一件设备工具都不给模型', () => {
    const tools = createChannelTools({ workbench })
    expect(tools[TOOL_SEARCH_FILES]).toBeUndefined()
    expect(tools[TOOL_SEND_FILE]).toBeUndefined()
  })
})

describe('发件目录按设备分文件夹', () => {
  it('每台在线设备一个「发给-XXX」,外加一份说明', async () => {
    const dir = tempDir()
    await ensureOutboxDirs(dir, [phone, macB])
    const picks = await scanOutboxTargets({ dir, devices: [phone, macB] })
    expect(picks).toEqual([])
    writeFileSync(join(dir, outboxDirNameOf(phone), '给手机的.txt'), 'x')
    writeFileSync(join(dir, '给所有人的.txt'), 'y')
    const next = await scanOutboxTargets({ dir, devices: [phone, macB] })
    expect(next.map(p => [p.name, p.to?.name])).toEqual([
      ['给所有人的.txt', undefined],
      ['给手机的.txt', 'Ben 的手机'],
    ])
  })

  it('子目录与说明本身不会被当成要发的文件', async () => {
    const dir = tempDir()
    await ensureOutboxDirs(dir, [phone])
    writeFileSync(join(dir, '.DS_Store'), 'x')
    writeFileSync(join(dir, '空的.txt'), '')
    expect(await scanOutbox({ dir })).toEqual([])
  })

  it('点名发的文件发完也挪进**根下**的「已发送」', async () => {
    const dir = tempDir()
    await ensureOutboxDirs(dir, [phone])
    const path = join(dir, outboxDirNameOf(phone), '一个.txt')
    writeFileSync(path, 'x')
    expect(await markSent(path)).toBe(true)
    expect(await scanOutboxTargets({ dir, devices: [phone] })).toEqual([])
    const sent = await scanOutbox({ dir: join(dir, '已发送') })
    expect(sent).toEqual(['一个.txt'])
  })

  it('某台设备不在线时它那个文件夹里的东西先不发(不当成错误)', async () => {
    const dir = tempDir()
    mkdirSync(join(dir, outboxDirNameOf(macB)), { recursive: true })
    writeFileSync(join(dir, outboxDirNameOf(macB), '等它上线.txt'), 'x')
    expect(await scanOutboxTargets({ dir, devices: [phone] })).toEqual([])
    expect((await scanOutboxTargets({ dir, devices: [phone, macB] })).map(p => p.name)).toEqual(['等它上线.txt'])
  })
})
