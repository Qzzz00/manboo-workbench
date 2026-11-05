// @vitest-environment node
/**
 * `/quota/connect/claude` 那三条(2026-10-03,卡「不让用户知道什么叫 setup-token」)。
 *
 * 这一组钉的是两件事:
 * - **她按一颗键就接上**:起一次 → 进度看得见 → 密钥自己落进 0600 的凭据文件 → 立刻重采一轮;
 * - **密钥一个字节都不出去**:`/state`、`/credentials`、`/agents/quota`、进度回包里 grep 那串,
 *   一处都不许有(AGENTS.md:不展示或写入 API Key、密码、Cookie、Token 或其他凭据)。
 *
 * 子进程一律是假的 —— 这一组**绝不**在真机上跑 `claude setup-token`。
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { WorkbenchServer } from '../src/server/http.ts'
import { startWorkbenchServer } from '../src/server/http.ts'
import { createWorkbenchService } from '../src/server/service.ts'
import { loadCredentials } from '../src/server/credentials.ts'
import { CLAUDE_CONNECT_NO_CLI, CLAUDE_CONNECT_OPENING } from '../src/quota/claudeSetupToken.ts'

const started: WorkbenchServer[] = []
const dirs: string[] = []

afterEach(async () => {
  while (started.length) await started.pop()?.close()
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
})

function tempFile(): string {
  const dir = mkdtempSync(join(tmpdir(), 'wb-claude-connect-'))
  dirs.push(dir)
  return join(dir, 'credentials.json')
}

const FAKE_TOKEN = 'sk-ant-oat01-0000000000000000000000000000-fake-for-tests'
const AUTH_URL = 'https://claude.ai/oauth/authorize?code=1'

/** 一只假 `claude setup-token`:起来就吐链接,用例叫一声再吐密钥。 */
function fakeCli() {
  const outs: ((chunk: unknown) => void)[] = []
  const opened: string[] = []
  const killed: string[] = []
  const io = {
    findCli: () => '/fake/bin/claude',
    spawn: () => ({
      stdout: { on: (_e: 'data', handler: (chunk: unknown) => void) => { outs.push(handler); handler(Buffer.from(`Open ${AUTH_URL}\n`)) } },
      stderr: { on: () => {} },
      on: () => {},
      kill: (signal?: string) => { killed.push(signal ?? 'SIGTERM') },
    }),
    openUrl: async (url: string) => { opened.push(url) },
  }
  return { io, opened, killed, giveToken: () => { for (const handler of outs) handler(Buffer.from(`${FAKE_TOKEN}\n`)) } }
}

async function serve(options: Parameters<typeof startWorkbenchServer>[0] extends infer _ ? Record<string, unknown> : never) {
  const server = await startWorkbenchServer({
    port: 0,
    service: createWorkbenchService({ now: () => 1_755_500_000 }),
    tickIntervalMs: 0,
    ...options,
  } as Parameters<typeof startWorkbenchServer>[0])
  started.push(server)
  return server
}

const settled = () => new Promise(resolve => setTimeout(resolve, 30))

/**
 * 等到某件事成了(最多 5 秒)。**不是** `setTimeout(30)` 就断言:
 * 存密钥那一步后面挂着「重采一轮 + 组一份完整快照 + 推给展示台」,这台机器忙起来会超过 30 毫秒
 * ——那样的红是假红(vitest.config.ts 头上那条老账)。
 */
async function until(ok: () => Promise<boolean> | boolean): Promise<void> {
  const deadline = Date.now() + 5_000
  while (Date.now() < deadline) {
    if (await ok()) return
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  throw new Error('等了 5 秒还没成')
}

describe('POST /quota/connect/claude', () => {
  it('★ 按一下就起:进度说「正在打开浏览器」,链接用默认浏览器打开', async () => {
    const fake = fakeCli()
    const server = await serve({ credentialFile: tempFile(), claudeConnect: fake.io })

    const res = await fetch(`${server.url}/quota/connect/claude`, { method: 'POST' })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ state: 'opening', message: CLAUDE_CONNECT_OPENING })

    await until(() => fake.opened.length > 0)
    expect(fake.opened).toEqual([AUTH_URL])
    await until(async () => (await (await fetch(`${server.url}/quota/connect/claude`)).json() as { state: string }).state === 'waiting')
  })

  it('★ 拿到密钥 → 自己落进凭据文件 + 重采一轮;进度与各处回包里都没有那串', async () => {
    const file = tempFile()
    const fake = fakeCli()
    let collected = 0
    const server = await serve({
      credentialFile: file,
      claudeConnect: fake.io,
      onCredentialsChanged: async () => { collected += 1 },
    })

    await fetch(`${server.url}/quota/connect/claude`, { method: 'POST' })
    await settled()
    fake.giveToken()
    await until(async () => (await loadCredentials(file)).claude_api !== undefined)

    // 密钥真的存下来了(0600 那一份由 saveCredential 保证,credentials.test.ts 钉着)。
    expect((await loadCredentials(file)).claude_api).toBe(FAKE_TOKEN)
    // 「填完立刻重采」那一步照走(与粘一串密钥那条路同一只手)。
    expect(collected).toBe(1)

    await until(async () => (await (await fetch(`${server.url}/quota/connect/claude`)).text()).includes('接上了'))
    const progress = await (await fetch(`${server.url}/quota/connect/claude`)).text()
    expect(progress).toContain('接上了')
    expect(progress).not.toContain(FAKE_TOKEN)
    expect(progress).not.toContain('sk-ant-')

    // ★ 一个字节都不许漏出去:这几处回包逐个 grep。
    for (const path of ['/state', '/credentials', '/agents/quota', '/quota/connect/claude']) {
      const body = await (await fetch(`${server.url}${path}`)).text()
      expect(body).not.toContain(FAKE_TOKEN)
      expect(body).not.toContain('sk-ant-')
    }
    // 而「配了没有」照说(界面据此把那一行写成「实时」)。
    expect(await (await fetch(`${server.url}/credentials`)).json()).toMatchObject({ claude_api: { configured: true } })
  })

  it('取消:子进程杀干净,状态回「没在接」', async () => {
    const fake = fakeCli()
    const server = await serve({ credentialFile: tempFile(), claudeConnect: fake.io })

    await fetch(`${server.url}/quota/connect/claude`, { method: 'POST' })
    await settled()
    const res = await fetch(`${server.url}/quota/connect/claude/cancel`, { method: 'POST' })

    expect(res.status).toBe(200)
    expect(fake.killed.length).toBeGreaterThan(0)
    expect(await (await fetch(`${server.url}/quota/connect/claude`)).json()).toEqual({ state: 'idle', message: '' })
  })

  it('再按一次顶掉上一次 —— 上一个浏览器窗口她可能已经关了,不该把人锁死', async () => {
    const fake = fakeCli()
    const server = await serve({ credentialFile: tempFile(), claudeConnect: fake.io })

    await fetch(`${server.url}/quota/connect/claude`, { method: 'POST' })
    await settled()
    const again = await fetch(`${server.url}/quota/connect/claude`, { method: 'POST' })

    expect(again.status).toBe(200)
    expect(fake.killed.length).toBeGreaterThan(0)
  })

  it('这台电脑上没装那条命令行:如实说那一步,一次 spawn 都不做', async () => {
    let spawned = 0
    const server = await serve({
      credentialFile: tempFile(),
      claudeConnect: {
        findCli: () => undefined,
        spawn: () => { spawned += 1; throw new Error('不该走到这里') },
        openUrl: async () => {},
      },
    })

    const got = await (await fetch(`${server.url}/quota/connect/claude`, { method: 'POST' })).json()
    expect(got).toEqual({ state: 'failed', message: CLAUDE_CONNECT_NO_CLI })
    expect(spawned).toBe(0)
  })

  it('没接这条路的服务:整条 404,并说清照旧能粘一串密钥', async () => {
    const server = await serve({ credentialFile: tempFile() })
    const res = await fetch(`${server.url}/quota/connect/claude`, { method: 'POST' })
    expect(res.status).toBe(404)
    expect((await res.json() as { error: string }).error).toContain('粘进设置')
  })

  it('★ 真起进程、真写密钥只认回环 —— 同一个热点下谁都不能远程把它点起来', async () => {
    const fake = fakeCli()
    const server = await startWorkbenchServer({
      port: 0,
      service: createWorkbenchService({ now: () => 1_755_500_000 }),
      tickIntervalMs: 0,
      credentialFile: tempFile(),
      claudeConnect: fake.io,
      isLoopback: () => false,
    })
    started.push(server)

    const res = await fetch(`${server.url}/quota/connect/claude`, { method: 'POST' })
    expect(res.status).toBe(403)
    // 读进度也只给这台电脑与配对过的设备(里面没有秘密,但「这台机器此刻在接什么」不必外传)。
    expect((await fetch(`${server.url}/quota/connect/claude`)).status).toBe(403)
  })
})
