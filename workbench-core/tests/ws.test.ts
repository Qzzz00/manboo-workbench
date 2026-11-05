import { createServer, type AddressInfo, type Socket } from 'node:net'
import { networkInterfaces } from 'node:os'
import { afterEach, describe, expect, it } from 'vitest'
import WebSocket from 'ws'
import { startCore, type Core } from '../src/server.ts'
import { freePort, startFakeUpstream, until, type FakeUpstream } from './fakeUpstream.ts'

const lanAddress = Object.values(networkInterfaces()).flat().find(i => i !== undefined && i.family === 'IPv4' && !i.internal)?.address

let core: Core | undefined
let upstream: FakeUpstream | undefined
afterEach(async () => {
  await core?.close(); core = undefined
  await upstream?.stop(); upstream = undefined
})

function open(url: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url)
    ws.once('open', () => resolve(ws))
    ws.once('error', reject)
  })
}

function upgradeStatus(url: string): Promise<number | 'closed'> {
  return new Promise((resolve) => {
    const ws = new WebSocket(url)
    ws.once('unexpected-response', (_req, res) => { resolve(res.statusCode ?? 0); ws.terminate() })
    ws.once('open', () => { resolve(101); ws.close() })
    ws.once('error', () => resolve('closed'))
  })
}

describe('WS 透传', () => {
  it('/helper 两个方向原样透传,文本与二进制都不改', async () => {
    upstream = await startFakeUpstream()
    core = await startCore({ port: 0, upstream: upstream.url })
    const ws = await open(`ws://127.0.0.1:${core.port}/helper`)
    const got: Array<{ data: string, binary: boolean }> = []
    ws.on('message', (data, isBinary) => got.push({ data: Buffer.from(data as Buffer).toString('hex'), binary: isBinary }))
    ws.send(JSON.stringify({ kind: 'hello', role: 'helper' }))
    ws.send(Buffer.from([0, 1, 2, 255]))
    await until(() => got.length === 2, '两条回声')
    expect(got[0]).toEqual({ data: Buffer.from(JSON.stringify({ kind: 'hello', role: 'helper' })).toString('hex'), binary: false })
    expect(got[1]).toEqual({ data: '000102ff', binary: true })
    ws.close()
  })

  it('/live 透传:先收到插件推的那帧快照,之后的广播照收;查询串(?token=)原样带到上游', async () => {
    upstream = await startFakeUpstream({ n: 1 })
    core = await startCore({ port: 0, upstream: upstream.url })
    const messages: unknown[] = []
    const ws = new WebSocket(`ws://127.0.0.1:${core.port}/live?token=test-only`)
    ws.on('message', data => messages.push(JSON.parse(String(data))))
    await until(() => messages.length >= 1, '首帧快照')
    expect(messages[0]).toEqual({ kind: 'snapshot', state: { n: 1 } })
    upstream.setState({ n: 2 })
    await until(() => messages.length >= 2, '第二帧')
    expect(messages[1]).toEqual({ kind: 'snapshot', state: { n: 2 } })
    ws.close()
  })

  it('上游拒绝升级(插件对未知路径 socket.destroy())时客户端照样被断开', async () => {
    upstream = await startFakeUpstream()
    core = await startCore({ port: 0, upstream: upstream.url })
    expect(await upgradeStatus(`ws://127.0.0.1:${core.port}/nope`)).toBe('closed')
  })

  it('上游不在时升级回 502(不是连接被拒);上游回来后再连就通', async () => {
    const port = await freePort()
    core = await startCore({ port: 0, upstream: `http://127.0.0.1:${port}` })
    expect(await upgradeStatus(`ws://127.0.0.1:${core.port}/live`)).toBe(502)
    upstream = await startFakeUpstream({ back: true }, port)
    expect(await upgradeStatus(`ws://127.0.0.1:${core.port}/live`)).toBe(101)
  })

  it('上游接了 TCP 却不回升级(DSH 卡死):到期回 502,不挂着', async () => {
    const accepted = new Set<Socket>()
    const mute = createServer((s) => { accepted.add(s) /* 接了连接,一个字节都不回 */ })
    await new Promise<void>(resolve => mute.listen(0, '127.0.0.1', () => resolve()))
    try {
      core = await startCore({ port: 0, upstream: `http://127.0.0.1:${(mute.address() as AddressInfo).port}`, upstreamHeadersTimeoutMs: 100 })
      expect(await upgradeStatus(`ws://127.0.0.1:${core.port}/helper`)).toBe(502)
    }
    finally {
      await core?.close(); core = undefined
      for (const s of accepted) s.destroy()
      await new Promise<void>(resolve => mute.close(() => resolve()))
    }
  })

  it('期限只管回 101 之前:连上之后静默多久都不断', async () => {
    upstream = await startFakeUpstream()
    core = await startCore({ port: 0, upstream: upstream.url, upstreamHeadersTimeoutMs: 100 })
    const ws = await open(`ws://127.0.0.1:${core.port}/helper`)
    await new Promise(resolve => setTimeout(resolve, 300))
    const echoed = new Promise<string>(resolve => ws.once('message', data => resolve(String(data))))
    ws.send('还在')
    expect(await echoed).toBe('还在')
    ws.close()
  })

  it('上游断开时已连着的 WS 被关掉,客户端看得见 close(重连由它自己来)', async () => {
    upstream = await startFakeUpstream()
    core = await startCore({ port: 0, upstream: upstream.url })
    const ws = await open(`ws://127.0.0.1:${core.port}/helper`)
    const closed = new Promise<void>(resolve => ws.once('close', () => resolve()))
    await upstream.stop()
    await closed
  })

  it('非本机来源的升级在没配 CORE_UPSTREAM_REMOTE 时回 403', async () => {
    upstream = await startFakeUpstream()
    core = await startCore({ port: 0, upstream: upstream.url, isLoopback: () => false })
    expect(await upgradeStatus(`ws://127.0.0.1:${core.port}/helper`)).toBe(403)
  })

  it.skipIf(lanAddress === undefined)('CORE_UPSTREAM_REMOTE=interface:从局域网地址进来的升级经同一块网卡透传,回声照通', async () => {
    upstream = await startFakeUpstream({}, 0, '0.0.0.0')
    core = await startCore({ port: 0, host: '0.0.0.0', upstream: upstream.url, upstreamRemote: 'interface' })
    const ws = await open(`ws://${lanAddress}:${core.port}/helper`)
    const got = new Promise<string>(resolve => ws.once('message', data => resolve(String(data))))
    ws.send('hi')
    expect(await got).toBe('hi')
    ws.close()
  })
})
