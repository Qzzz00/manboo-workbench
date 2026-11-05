// @vitest-environment node
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import WebSocket from 'ws'
import type { LiveMessage } from '../src/protocol.ts'
import type { WorkbenchServer } from '../src/server/http.ts'
import { startWorkbenchServer } from '../src/server/http.ts'
import { createWorkbenchService } from '../src/server/service.ts'
import { loadCredentials } from '../src/server/credentials.ts'

const started: WorkbenchServer[] = []
const dirs: string[] = []

afterEach(async () => {
  while (started.length) await started.pop()?.close()
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
})

function tempFile(): string {
  const dir = mkdtempSync(join(tmpdir(), 'wb-credroute-'))
  dirs.push(dir)
  return join(dir, 'credentials.json')
}

async function serve(options: {
  credentialFile: string
  onCredentialsChanged?: (change: { provider: string, cleared: boolean }) => Promise<void>
}) {
  const server = await startWorkbenchServer({
    port: 0,
    service: createWorkbenchService({ now: () => 1_755_500_000 }),
    tickIntervalMs: 0,
    ...options,
  })
  started.push(server)
  return server
}

const KEY = 'sk-not-a-real-key-0123456789'

describe('凭据接口', () => {
  it('GET /credentials 只说配没配，绝不回显 Key', async () => {
    const file = tempFile()
    const server = await serve({ credentialFile: file })

    await fetch(`${server.url}/credentials`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ provider: 'deepseek', key: KEY }),
    })

    const res = await fetch(`${server.url}/credentials`)
    const body = await res.text()

    expect(JSON.parse(body)).toEqual({
      deepseek: { configured: true },
      kimi_web: { configured: false },
      claude_api: { configured: false },
      bocha: { configured: false },
      volc_asr_app_id: { configured: false },
      volc_asr_access_token: { configured: false },
    })
    expect(body).not.toContain(KEY)
  })

  it('POST 存下来了，且回包里同样不带 Key', async () => {
    const file = tempFile()
    const server = await serve({ credentialFile: file })

    const res = await fetch(`${server.url}/credentials`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ provider: 'deepseek', key: KEY }),
    })
    const body = await res.text()

    expect(res.status).toBe(200)
    expect(body).not.toContain(KEY)
    expect((await loadCredentials(file)).deepseek).toBe(KEY)
  })

  it('填完立刻重采一轮——这是"填完展示台马上更新"的前半程', async () => {
    const file = tempFile()
    let refreshed = 0
    const server = await serve({ credentialFile: file, onCredentialsChanged: async () => { refreshed += 1 } })

    await fetch(`${server.url}/credentials`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ provider: 'kimi_web', key: 'sk-kimi-x' }),
    })

    expect(refreshed).toBe(1)
  })

  it('填完把整份快照推给展示台——这是后半程，展示台不必等下一次轮询', async () => {
    const file = tempFile()
    const server = await serve({ credentialFile: file })

    const ws = new WebSocket(`${server.url.replace('http://', 'ws://')}/live`)
    const got: LiveMessage[] = []
    ws.on('message', raw => got.push(JSON.parse(String(raw)) as LiveMessage))
    await new Promise<void>(resolve => ws.on('open', () => resolve()))
    await new Promise<void>(resolve => setTimeout(resolve, 50))
    const before = got.length

    await fetch(`${server.url}/credentials`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ provider: 'deepseek', key: KEY }),
    })
    await new Promise<void>(resolve => setTimeout(resolve, 80))
    ws.close()

    const pushed = got.slice(before)
    expect(pushed.some(m => m.kind === 'snapshot')).toBe(true)
    expect(JSON.stringify(pushed)).not.toContain(KEY)
  })

  it('认不出的 provider 挡在门外', async () => {
    const server = await serve({ credentialFile: tempFile() })

    const res = await fetch(`${server.url}/credentials`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ provider: 'openai', key: 'x' }),
    })

    expect(res.status).toBe(400)
  })

  it('空字符串＝清除这一家，不是存个空 Key', async () => {
    const file = tempFile()
    const server = await serve({ credentialFile: file })
    const post = (key: string) => fetch(`${server.url}/credentials`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ provider: 'deepseek', key }),
    })

    await post(KEY)
    await post('')

    expect((await loadCredentials(file)).deepseek).toBeUndefined()
  })

  /**
   * 清空那一刻要把"是哪一家、是不是清空"一起告诉采集侧(2026-09-18)。
   *
   * 只说一句"凭据变了"是不够的:重采一轮要打好几家的接口,而清空这一家的上次采样
   * 必须**当场**作废 —— 中间那几秒里界面上还挂着用已经删掉的 Key 取来的余额。
   */
  it('★清空时告知采集侧:哪一家、是不是清空', async () => {
    const file = tempFile()
    const changes: { provider: string, cleared: boolean }[] = []
    const server = await serve({ credentialFile: file, onCredentialsChanged: async (change) => { changes.push(change) } })
    const post = (key: string) => fetch(`${server.url}/credentials`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ provider: 'deepseek', key }),
    })

    await post(KEY)
    await post('   ')

    expect(changes).toEqual([
      { provider: 'deepseek', cleared: false },
      // 只打了几个空格也算清空 —— saveCredential 收到的就是 trim 过的空串。
      { provider: 'deepseek', cleared: true },
    ])
  })
})

describe('凭据写入只认回环', () => {
  it('非回环来源一律 403——服务对外 bind 后，展示台可以读状态，但谁都不能远程写 Key', async () => {
    const file = tempFile()
    const server = await startWorkbenchServer({
      port: 0,
      service: createWorkbenchService({ now: () => 1_755_500_000 }),
      tickIntervalMs: 0,
      credentialFile: file,
      // 测试里把"这条请求算不算回环"直接注入，不必真的起一张网卡。
      isLoopback: () => false,
    })
    started.push(server)

    const res = await fetch(`${server.url}/credentials`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ provider: 'deepseek', key: KEY }),
    })

    expect(res.status).toBe(403)
    expect((await loadCredentials(file)).deepseek).toBeUndefined()
  })

  it('读状态不受限制——展示台在另一台机器上也要能显示"配了没有"', async () => {
    const server = await startWorkbenchServer({
      port: 0,
      service: createWorkbenchService({ now: () => 1_755_500_000 }),
      tickIntervalMs: 0,
      credentialFile: tempFile(),
      isLoopback: () => false,
    })
    started.push(server)

    expect((await fetch(`${server.url}/credentials`)).status).toBe(200)
  })
})
