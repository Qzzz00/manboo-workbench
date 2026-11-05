/**
 * 手机从电脑取文件 · 工人这一侧(2026-09-25,卡 J `feat/phone-fetch-file`)。
 *
 * 路上撞到的几个断点,每个一条用例钉住:
 *   ① 他说「发到我手机上」,模型填 `to:"我"` → 以前回「没有哪台叫『我』」;现在就是他正拿着打电话的那台;
 *   ② 搜索结果不再给模型看路径,只给**编号**;复述只念文件名、在哪台电脑的哪个项目里;
 *   ③ 比的是相对根的路径(绝对路径里的 GitHub / Documents 不算);像密钥的文件不找;文件名命中的排前面;
 *   ④ 大文件不让电话陪着等:先回「开始传了」,后来的结果再说一声;
 *   ⑤ 打字那条在外面取文件:`wb.rpc` 的 `file_pull`;
 *   ⑥ 工作台客户端:search-roots 带 `?q=` 拿 focus;核取件单。
 */
import { describe, expect, it } from 'vitest'
import type { DeviceInfo } from '../src/files/devices.ts'
import type { DeviceSearchSlice, FoundHandles, FoundPaths } from '../src/files/deviceTools.ts'
import { confirmText, handleOf, rememberFound, spokenSearchResults, spokenWhere } from '../src/files/deviceTools.ts'
import { rankFound, searchFiles, transferBlockReason } from '../src/files/search.ts'
import { parseTransferLine } from '../src/files/transfers.ts'
import { TOOL_SEARCH_FILES, TOOL_SEND_FILE, createChannelTools, type DeviceFilesPort } from '../src/tools.ts'
import { handleRpcRequest, parseRpcRequest } from '../src/rpc.ts'
import { createWorkbenchClient, type WorkbenchClient } from '../src/workbench.ts'

interface FakeTool { execute: (args: Record<string, unknown>, ctx: never) => Promise<unknown> }
type ToolTable = { [TOOL_SEARCH_FILES]: FakeTool, [TOOL_SEND_FILE]: FakeTool }
const toolsOf = (value: unknown): ToolTable => value as ToolTable

const mac: DeviceInfo = { identity: 'wb-channel-worker', device_id: 'mac-a', name: '书房 Mac', kind: 'mac' }
const phone: DeviceInfo = { identity: 'wb-phone-d1', device_id: 'd1', name: 'Pixel 10 Pro XL', kind: 'phone' }
const pad: DeviceInfo = { identity: 'wb-phone-d2', device_id: 'd2', name: 'Ben 的平板', kind: 'phone' }

const readme: DeviceSearchSlice = {
  device: mac,
  files: [
    { path: '/Users/example/Documents/GitHub/desktop-workbench/README.md', name: 'README.md', size: 4200, where: 'desktop-workbench' },
    { path: '/Users/example/Documents/GitHub/desktop-workbench/docs/README.md', name: 'README.md', size: 900, where: 'desktop-workbench / docs' },
  ],
  total: 2,
  truncated: false,
}

function fakePort(overrides: Partial<DeviceFilesPort> = {}) {
  const sends: { from: string, path: string, to: string }[] = []
  const port: DeviceFilesPort = {
    devices: () => [mac, phone],
    self: () => mac,
    caller: () => phone,
    search: async () => [readme],
    send: async ({ from, path, to }) => {
      sends.push({ from: from.identity, path, to: to.identity })
      return { ok: true, name: path.split('/').at(-1) as string, bytes: 4200 }
    },
    ...overrides,
  }
  return { port, sends }
}

const workbench = {} as unknown as WorkbenchClient

describe('① 「发到我手机上」就是他正拿着打电话的那台', () => {
  it.each(['我', '我的手机', '手机', '我手机上', '', undefined])('to=%s → 他这台手机,复述里说「你这台手机」', async (to) => {
    const { port, sends } = fakePort()
    const tools = toolsOf(createChannelTools({ workbench, deviceFiles: port }))
    await tools[TOOL_SEARCH_FILES].execute({ query: '工作台 README' }, {} as never)
    const text = String(await tools[TOOL_SEND_FILE].execute({ file: '1', ...(to === undefined ? {} : { to }) }, {} as never))
    expect(text).toContain('把书房 Mac上 desktop-workbench 里的「README.md」发到你这台手机,对吗?')
    expect(sends).toEqual([])
  })

  it('不知道谁在打电话时,房里只有一台手机就是它;两台就问', async () => {
    const one = fakePort({ caller: () => undefined })
    const tools = toolsOf(createChannelTools({ workbench, deviceFiles: one.port }))
    await tools[TOOL_SEARCH_FILES].execute({ query: 'README' }, {} as never)
    expect(String(await tools[TOOL_SEND_FILE].execute({ file: '1', to: '我' }, {} as never))).toContain('发到Pixel 10 Pro XL,对吗?')

    const two = fakePort({ caller: () => undefined, devices: () => [mac, phone, pad] })
    const tools2 = toolsOf(createChannelTools({ workbench, deviceFiles: two.port }))
    await tools2[TOOL_SEARCH_FILES].execute({ query: 'README' }, {} as never)
    expect(String(await tools2[TOOL_SEND_FILE].execute({ file: '1', to: '我' }, {} as never))).toContain('此刻在线的是')
  })

  it('点名别的设备按名字认(宽松到「平板」也认得)', async () => {
    const { port, sends } = fakePort({ devices: () => [mac, phone, pad] })
    const tools = toolsOf(createChannelTools({ workbench, deviceFiles: port }))
    await tools[TOOL_SEARCH_FILES].execute({ query: 'README' }, {} as never)
    await tools[TOOL_SEND_FILE].execute({ file: '1', to: '平板', confirmed: true }, {} as never)
    expect(sends).toEqual([{ from: mac.identity, path: readme.files[0]?.path, to: pad.identity }])
  })

  it('发给文件所在的那台自己:不传,问一句', async () => {
    const { port, sends } = fakePort()
    const tools = toolsOf(createChannelTools({ workbench, deviceFiles: port }))
    await tools[TOOL_SEARCH_FILES].execute({ query: 'README' }, {} as never)
    const text = String(await tools[TOOL_SEND_FILE].execute({ file: '1', to: '书房 Mac', confirmed: true }, {} as never))
    expect(text).toContain('本来就在书房 Mac上')
    expect(sends).toEqual([])
  })
})

describe('② 编号代替路径', () => {
  it('搜索结果给模型的那段话里**没有路径**,有编号、文件名、在哪', async () => {
    const { port } = fakePort()
    const tools = toolsOf(createChannelTools({ workbench, deviceFiles: port }))
    const text = String(await tools[TOOL_SEARCH_FILES].execute({ query: 'README' }, {} as never))
    expect(text).not.toContain('/Users/example')
    expect(text).toContain('编号 1:README.md(4.1 KB,在 desktop-workbench 里)')
    expect(text).toContain('编号 2:README.md(900 字节,在 desktop-workbench / docs 里)')
    expect(text).toContain('编号和路径都不要念')
  })

  it('编号接着往下数,不重号;认「3」「#3」「第3个」', () => {
    const table: FoundPaths = new Map()
    const handles: FoundHandles = new Map()
    expect(rememberFound(table, [readme], handles)).toEqual([['1', '2']])
    expect(rememberFound(table, [readme], handles)).toEqual([['3', '4']])
    expect(handleOf(handles, '#3')?.path).toBe(readme.files[0]?.path)
    expect(handleOf(handles, '第3个')?.path).toBe(readme.files[0]?.path)
    expect(handleOf(handles, 4)?.where).toBe('desktop-workbench / docs')
    expect(handleOf(handles, '9')).toBeUndefined()
  })

  it('没有的编号:不传,让她先去搜', async () => {
    const { port, sends } = fakePort()
    const tools = toolsOf(createChannelTools({ workbench, deviceFiles: port }))
    const text = String(await tools[TOOL_SEND_FILE].execute({ file: '7', confirmed: true }, {} as never))
    expect(text).toContain('没有编号是「7」的搜索结果')
    expect(sends).toEqual([])
  })

  it('点头之后照编号传,传对那一条', async () => {
    const { port, sends } = fakePort()
    const tools = toolsOf(createChannelTools({ workbench, deviceFiles: port }))
    await tools[TOOL_SEARCH_FILES].execute({ query: 'README' }, {} as never)
    const text = String(await tools[TOOL_SEND_FILE].execute({ file: '2', confirmed: true }, {} as never))
    expect(sends).toEqual([{ from: mac.identity, path: readme.files[1]?.path, to: phone.identity }])
    expect(text).toContain('发过去了')
    expect(text).toContain('你这台手机')
    expect(text).not.toContain('/Users')
  })

  it('「在哪」念成人话,不念斜杠', () => {
    expect(spokenWhere('desktop-workbench / docs')).toBe(' desktop-workbench 的 docs 文件夹里')
    expect(spokenWhere(undefined)).toBe('')
    expect(confirmText({ from: mac, fileName: 'README.md', to: phone, where: 'desktop-workbench / docs', toCaller: true }))
      .toBe('把书房 Mac上 desktop-workbench 的 docs 文件夹里的「README.md」发到你这台手机,对吗?')
  })

  it('老的对端没有编号时退回带路径的老格式(不坏)', () => {
    expect(spokenSearchResults([readme])).toContain('路径 /Users/example/Documents/GitHub/desktop-workbench/README.md')
  })
})

describe('③ 按文件名找:比相对路径、不找密钥、名字命中的排前面', () => {
  const tree: Record<string, { name: string, isDirectory: boolean, isFile: boolean }[]> = {
    '/Users/example/Documents/GitHub': [{ name: 'desktop-workbench', isDirectory: true, isFile: false }],
    '/Users/example/Documents/GitHub/desktop-workbench': [
      { name: 'README-旧版备份.md', isDirectory: false, isFile: true },
      { name: 'readme', isDirectory: true, isFile: false },
      { name: 'README.md', isDirectory: false, isFile: true },
      { name: 'id_rsa', isDirectory: false, isFile: true },
      { name: 'server.pem', isDirectory: false, isFile: true },
    ],
    '/Users/example/Documents/GitHub/desktop-workbench/readme': [{ name: '截图.png', isDirectory: false, isFile: true }],
  }
  const deps = {
    readdirImpl: async (dir: string) => {
      const entries = tree[dir]
      if (entries === undefined) throw new Error('读不到')
      return entries
    },
    statImpl: async () => ({ size: 10, mtimeMs: 0 }),
  }

  it('根的绝对路径里的词(documents / github / ben)一个都不算', async () => {
    const found = await searchFiles({ roots: [{ path: '/Users/example/Documents/GitHub', label: 'GitHub' }], query: 'documents' }, deps)
    expect(found.files).toEqual([])
  })

  it('README.md 排第一,README-旧版备份.md 第二,只是路径里带 readme 的最后;密钥不进结果;「在哪」是仓库名加目录', async () => {
    const found = await searchFiles({ roots: [{ path: '/Users/example/Documents/GitHub', label: 'GitHub' }], query: 'readme' }, deps)
    expect(found.files.map(file => file.name)).toEqual(['README.md', 'README-旧版备份.md', '截图.png'])
    // 扫描根的名字(GitHub)不念 —— 他认的是仓库名。
    expect(found.files[0]?.where).toBe('desktop-workbench')
    expect(found.files[2]?.where).toBe('desktop-workbench / readme')
    // 事务官文件夹要带上自己的名字(「事务官文件夹 / 收件」)。
    const work = await searchFiles({ roots: [{ path: '/Users/example/Documents/GitHub', label: '事务官文件夹', labelPrefix: true }], query: 'readme' }, deps)
    expect(work.files[0]?.where).toBe('事务官文件夹 / desktop-workbench')
  })

  it('在项目里找时「在哪」写项目名;给了 terms 就不再拆 query', async () => {
    const found = await searchFiles({
      roots: [{ path: '/Users/example/Documents/GitHub/desktop-workbench' }],
      query: '工作台 README',
      terms: ['README'],
      whereLabel: 'desktop-workbench',
    }, deps)
    expect(found.files[0]).toMatchObject({ name: 'README.md', where: 'desktop-workbench' })
  })

  it('发的那一刻再拦一遍:node_modules、像密钥的名字', () => {
    expect(transferBlockReason('/a/node_modules/x/README.md')).toContain('node_modules')
    expect(transferBlockReason('/a/credentials.json')).toContain('密钥')
    expect(transferBlockReason('/a/cert.p12')).toContain('密钥')
    expect(transferBlockReason('/a/README.md')).toBeUndefined()
  })

  it('rankFound 保持其余的先后(广度优先)', () => {
    const files = [
      { path: '/r/a/x.md', name: 'x.md', size: 1 },
      { path: '/r/readme/y.md', name: 'y.md', size: 1 },
      { path: '/r/README.md', name: 'README.md', size: 1 },
    ]
    expect(rankFound(files, ['readme']).map(file => file.name)).toEqual(['README.md', 'x.md', 'y.md'])
  })
})

describe('④ 大文件不让电话陪着等', () => {
  it('超过 sendQuickMs 先回「开始传了」,传完再由 onLateSend 说一声', async () => {
    let finish: (value: { ok: true, name: string, bytes: number }) => void = () => {}
    const { port } = fakePort({ send: () => new Promise((resolve) => { finish = resolve }) })
    const late: { text: string, ok: boolean }[] = []
    const tools = toolsOf(createChannelTools({ workbench, deviceFiles: port, sendQuickMs: 20, onLateSend: (text, ok) => late.push({ text, ok }) }))
    await tools[TOOL_SEARCH_FILES].execute({ query: 'README' }, {} as never)
    const text = String(await tools[TOOL_SEND_FILE].execute({ file: '1', confirmed: true }, {} as never))
    expect(text).toContain('开始传了')
    expect(text).toContain('不用等着')
    expect(late).toEqual([])
    finish({ ok: true, name: 'README.md', bytes: 4200 })
    await new Promise(resolve => setTimeout(resolve, 5))
    expect(late).toEqual([{ text: '那个「README.md」传完了,已经在手机上。', ok: true }])
  })

  it('后来没传过去:如实说原因', async () => {
    let finish: (value: { ok: false, error: string }) => void = () => {}
    const { port } = fakePort({ send: () => new Promise((resolve) => { finish = resolve }) })
    const late: { text: string, ok: boolean }[] = []
    const tools = toolsOf(createChannelTools({ workbench, deviceFiles: port, sendQuickMs: 20, onLateSend: (text, ok) => late.push({ text, ok }) }))
    await tools[TOOL_SEARCH_FILES].execute({ query: 'README' }, {} as never)
    await tools[TOOL_SEND_FILE].execute({ file: '1', confirmed: true }, {} as never)
    finish({ ok: false, error: 'Pixel 10 Pro XL这会儿不在房里(App 没开着,或者没网)' })
    await new Promise(resolve => setTimeout(resolve, 5))
    expect(late[0]?.ok).toBe(false)
    expect(late[0]?.text).toContain('没传过去:Pixel 10 Pro XL这会儿不在房里')
  })
})

describe('⑤ 打字那条在外面取文件:wb.rpc 的 file_pull', () => {
  const port = { callAsDevice: async () => ({ status: 200, body: {} }), renewTicket: async () => ({ status: 500, error: 'x' }) }

  it('读得出来;没带单号就说', () => {
    expect(parseRpcRequest(JSON.stringify({ id: 'p1', type: 'file_pull', offer: 'abc' }))).toEqual({ ok: true, request: { id: 'p1', type: 'file_pull', offer: 'abc' } })
    expect(parseRpcRequest(JSON.stringify({ id: 'p2', type: 'file_pull' }))).toMatchObject({ ok: false, id: 'p2' })
  })

  it('交给取文件那一头,带上是哪台设备、哪个身份;回「开始推了」', async () => {
    const calls: unknown[] = []
    const answer = await handleRpcRequest({ id: 'p1', type: 'file_pull', offer: 'abc' }, {
      deviceId: 'd1',
      identity: 'wb-phone-d1',
      workbench: port,
      files: { pull: async (input) => { calls.push(input); return { ok: true, name: 'README.md', bytes: 4200 } } },
    })
    expect(calls).toEqual([{ offer: 'abc', deviceId: 'd1', identity: 'wb-phone-d1' }])
    expect(answer).toEqual({ id: 'p1', type: 'file_pull', ok: true, name: 'README.md', bytes: 4200 })
  })

  it('没接取文件那一头(第二台电脑 / 老接线):如实回', async () => {
    const answer = await handleRpcRequest({ id: 'p1', type: 'file_pull', offer: 'abc' }, { deviceId: 'd1', identity: 'wb-phone-d1', workbench: port })
    expect(answer).toMatchObject({ type: 'file_pull', ok: false })
  })
})

describe('⑥ 工作台客户端', () => {
  function stubFetch(routes: Record<string, { status: number, body: unknown } | 'network'>) {
    const seen: { url: string, headers: Record<string, string> }[] = []
    const impl = (async (url: string, init?: RequestInit) => {
      seen.push({ url: String(url), headers: (init?.headers ?? {}) as Record<string, string> })
      const path = String(url).replace('http://127.0.0.1:8791', '')
      const hit = routes[path]
      if (hit === undefined || hit === 'network') throw new Error('连不上')
      return new Response(JSON.stringify(hit.body), { status: hit.status })
    }) as unknown as typeof fetch
    return { impl, seen }
  }

  it('searchRoots 带 ?q=,读出 focus', async () => {
    const stub = stubFetch({
      [`/channel/search-roots?q=${encodeURIComponent('工作台 README')}`]: { status: 200, body: { allowed: true, roots: [{ path: '/g', depth: 6 }], focus: { name: 'desktop-workbench', path: '/g/desktop-workbench', terms: ['readme'] } } },
    })
    const client = createWorkbenchClient({ baseUrl: 'http://127.0.0.1:8791', fetchImpl: stub.impl })
    const roots = await client.searchRoots('工作台 README')
    expect(roots.focus).toEqual({ name: 'desktop-workbench', path: '/g/desktop-workbench', terms: ['readme'] })
  })

  it('fileOffer 带降权头;404 带话就原样转,连不上说连不上', async () => {
    const stub = stubFetch({
      '/channel/file-offer/ok1': { status: 200, body: { path: '/g/README.md', name: 'README.md', bytes: 12 } },
      '/channel/file-offer/gone': { status: 404, body: { error: '这张取件单不在了' } },
    })
    const client = createWorkbenchClient({ baseUrl: 'http://127.0.0.1:8791', fetchImpl: stub.impl })
    expect(await client.fileOffer('ok1', 'd1')).toEqual({ ok: true, path: '/g/README.md', name: 'README.md', bytes: 12 })
    expect(stub.seen[0]?.headers['x-workbench-channel-device']).toBe('d1')
    expect(await client.fileOffer('gone', 'd1')).toEqual({ ok: false, error: '这张取件单不在了' })
    expect(await client.fileOffer('net', 'd1')).toMatchObject({ ok: false, error: expect.stringContaining('连不上') })
  })
})

describe('传输记录认新的两种来路', () => {
  it('typed / attachment 读得回来', () => {
    expect(parseTransferLine(JSON.stringify({ at: 'x', direction: 'in', name: 'a', by: 'attachment' }))?.by).toBe('attachment')
    expect(parseTransferLine(JSON.stringify({ at: 'x', direction: 'out', name: 'a', by: 'typed' }))?.by).toBe('typed')
  })
})
