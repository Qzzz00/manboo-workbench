// @vitest-environment node
/**
 * 连接器**真装真起**的端到端(卡 OC,2026-09-27)。
 *
 * 默认**跳过**:它要连 npm registry 下 229MB、要真起一个进程。
 * 跑法(维护者 / 统筹核卡时):
 *
 * ```sh
 * cd workbench-plugin && CONNECTOR_E2E=1 npx vitest run tests/connector-e2e.test.ts
 * ```
 *
 * 纪律:
 * - **整个 HOME 是 mktemp 出来的**,跑完删干净;不碰 `~/.dsh`、不碰维护者的任何配置。
 * - **launchctl 是假的**。真装一个 LaunchAgent 到维护者机器上是另一回事,由统筹装机时做。
 *   这里直接用自带 node 跑宿主脚本,验的是「脚本对不对、端口对不对、/mcp 通不通」。
 * - 端口用 8896(8796 + 100),免得跟她机器上真跑着的那一份撞。
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { nodeSetupIo, type SetupExecOptions, type SetupExecResult, type SetupIo } from '../src/server/setup/io.ts'
import { connectorOwnedPaths, connectorPaths } from '../src/server/connector/manifest.ts'
import { installConnector, loadConnectorCatalog, connectorPolicyFile, parseConnectorConfig, uninstallConnector } from '../src/server/connector/install.ts'
import { MCP_HOSTS } from '../src/server/connector/mcpConfig.ts'
import { createConnectorService } from '../src/server/connector/service.ts'
import { connectorRowText } from '../src/connectorText.ts'

const RUN = process.env['CONNECTOR_E2E'] === '1'
const PORT = 8896
const suite = RUN ? describe : describe.skip

let child: ChildProcess | undefined
let home: string | undefined
afterAll(() => {
  child?.kill('SIGTERM')
  if (home) rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
})

suite('连接器端到端(真装真起)', () => {
  it('从零装上 → 起来 → /mcp 列得出工具 → 卸干净', { timeout: 15 * 60 * 1000 }, async () => {
    home = mkdtempSync(join(tmpdir(), 'wb-connector-e2e-'))
    const p = connectorPaths(home)
    const real = nodeSetupIo()
    const launchctl: string[][] = []
    const io: SetupIo = {
      ...real,
      // launchctl 一律假的:不往维护者机器上装 LaunchAgent。
      exec: async (cmd: readonly string[], opts?: SetupExecOptions): Promise<SetupExecResult> => {
        if (cmd[0] === 'launchctl') { launchctl.push([...cmd]); return { ok: true, code: 0, out: '' } }
        return real.exec(cmd, opts)
      },
    }

    // 自带 node 借用真机那一份(临时 HOME 里没有 ~/.dsh/node)。
    const realHomeNode = `${process.env['HOME']}/.dsh/node`
    expect(existsSync(`${realHomeNode}/bin/node`), '这台机器上要有工作台自带的 node').toBe(true)
    await real.mkdirp(`${home}/.dsh`)
    await real.exec(['ln', '-s', realHomeNode, `${home}/.dsh/node`])

    const t0 = Date.now()
    const installed = await installConnector({ io, home, randomToken: () => cryptoHex() })
    const installMs = Date.now() - t0
    expect(installed.steps.filter((s) => !s.ok)).toEqual([])
    expect(installed.ok).toBe(true)
    console.log(`[e2e] 装完用了 ${(installMs / 1000).toFixed(1)}s`)

    // 三家的配置都写了
    expect(installed.mcp.map((m) => m.reason)).toEqual(['written', 'written', 'written'])
    for (const host of MCP_HOSTS) {
      expect(existsSync(host.file(home)), host.file(home)).toBe(true)
    }

    // 接上三家(只读),重算策略 —— 这就是她在设置里勾一家之后发生的事。
    const config = parseConnectorConfig(readFileSync(p.configFile, 'utf8'))!
    const services = ['weixin_official_account', 'bilibili', 'zhihu']
    writeFileSync(p.configFile, `${JSON.stringify({ ...config, port: PORT, services }, null, 2)}\n`, { mode: 0o600 })
    const catalog = await loadConnectorCatalog(io, p, services)
    const policyText = connectorPolicyFile(services, catalog)
    writeFileSync(`${p.dir}/policy.json`, policyText)
    const policy = JSON.parse(policyText) as { allowedActions: string[] }
    console.log(`[e2e] 放行只读 ${policy.allowedActions.length} 项`)
    expect(policy.allowedActions).toContain('weixin_official_account.get_draft_count')
    expect(policy.allowedActions).not.toContain('weixin_official_account.add_draft')

    // 起宿主(直接跑,不经 launchd)
    const started = Date.now()
    child = spawn(`${realHomeNode}/bin/node`, [p.entry], {
      cwd: p.dir,
      env: { ...process.env, HOME: home, CONNECTOR_CONFIG_FILE: p.configFile },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let log = ''
    child.stdout?.on('data', (d: Buffer) => { log += d.toString() })
    child.stderr?.on('data', (d: Buffer) => { log += d.toString() })
    await waitFor(async () => (await health(PORT)) !== undefined, 60_000)
    console.log(`[e2e] 起来用了 ${Date.now() - started}ms;${log.trim()}`)

    // 只听回环:外网口连不上
    const lan = await fetch(`http://${await lanIp()}:${PORT}/healthz`, { signal: AbortSignal.timeout(2000) }).then(() => 'reachable').catch(() => 'refused')
    expect(lan).toBe('refused')

    // 没令牌 → 401
    const noToken = await fetch(`http://127.0.0.1:${PORT}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
    expect(noToken.status).toBe(401)

    // /mcp 列得出工具
    const tools = await mcpToolNames(PORT, config.runtimeToken)
    console.log(`[e2e] /mcp 工具:${tools.join(', ')}`)
    expect(tools).toContain('list_apps')
    expect(tools).toContain('execute_action')

    // ---- 走一遍「工作台起来之后自己装」那条路(卡 OC2)----------------------
    // 这一趟 npm 会跳过(已经装着),验的是:状态行的字、三家配置的自愈、探活那一道。
    const service = createConnectorService({ home, io, cacheMs: 0, randomToken: () => cryptoHex(), probeAttempts: 4, probeGapMs: 250 })
    const again = await service.install()
    expect(again.ok).toBe(true)
    const view = await service.view()
    expect(view.installed).toBe(true)
    expect(view.running).toBe(true)
    expect(view.apps).toBe(1554)
    expect(view.connected).toBe(3)
    // 连接器此刻真答得上话,所以事务官那一条也该接上了
    expect(view.hosts.map((x) => `${x.id}:${x.connected}`)).toEqual(['dsh:true', 'claude-code:true', 'codex:true'])
    console.log(`[e2e] 状态行:${connectorRowText(view)}`)

    // 默认只读真的拦得住
    const blocked = await mcpCall(PORT, config.runtimeToken, 'execute_action', { actionId: 'weixin_official_account.add_draft', input: {} })
    expect(JSON.stringify(blocked)).toContain('action_not_allowed')

    // 常驻内存:刚起来那一下是峰值(catalog 读进来又放掉),空转几秒才是稳态。
    const rssPeak = await rssOf(child.pid!)
    await new Promise((r) => setTimeout(r, 5000))
    const rssIdle = await rssOf(child.pid!)
    console.log(`[e2e] 常驻内存 峰值 ${rssPeak} MB / 空转 5 秒后 ${rssIdle} MB`)

    child.kill('SIGTERM')
    await waitFor(async () => (await health(PORT)) === undefined, 15_000)
    child = undefined

    // 卸干净
    const gone = await uninstallConnector({ io, home })
    expect(gone.ok).toBe(true)
    for (const path of connectorOwnedPaths(home)) expect(existsSync(path), path).toBe(false)
    expect(gone.mcp.map((m) => m.reason)).toEqual(['written', 'written', 'written'])
    for (const host of MCP_HOSTS) {
      const text = readFileSync(host.file(home), 'utf8')
      expect(text).not.toContain('open-connector')
    }
    expect(launchctl.some((c) => c[1] === 'bootout')).toBe(true)
  })
})

/* ---------------------------------------------------------------- */

function cryptoHex(): string {
  const bytes = new Uint8Array(32)
  globalThis.crypto.getRandomValues(bytes)
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('')
}

async function waitFor(check: () => Promise<boolean>, timeoutMs: number): Promise<void> {
  const until = Date.now() + timeoutMs
  for (;;) {
    if (await check()) return
    if (Date.now() > until) throw new Error('等超时了')
    await new Promise((r) => setTimeout(r, 200))
  }
}

async function health(port: number): Promise<unknown> {
  try {
    const r = await fetch(`http://127.0.0.1:${port}/healthz`, { signal: AbortSignal.timeout(1500) })
    return await r.json()
  } catch {
    return undefined
  }
}

async function mcpCall(port: number, token: string, method: string, params: unknown): Promise<unknown> {
  const body = method === 'tools/list'
    ? { jsonrpc: '2.0', id: 1, method, params }
    : { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: method, arguments: params } }
  const r = await fetch(`http://127.0.0.1:${port}/mcp`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    body: JSON.stringify(body),
  })
  const text = await r.text()
  const line = text.split('\n').find((l) => l.startsWith('data: '))
  return JSON.parse((line ?? text).replace(/^data: /, ''))
}

async function mcpToolNames(port: number, token: string): Promise<string[]> {
  const out = await mcpCall(port, token, 'tools/list', {}) as { result?: { tools?: { name: string }[] } }
  return (out.result?.tools ?? []).map((t) => t.name)
}

async function lanIp(): Promise<string> {
  const { networkInterfaces } = await import('node:os')
  for (const list of Object.values(networkInterfaces())) {
    for (const nic of list ?? []) {
      if (nic.family === 'IPv4' && !nic.internal) return nic.address
    }
  }
  return '127.0.0.2'
}

async function rssOf(pid: number): Promise<number> {
  const { execFile } = await import('node:child_process')
  return new Promise((resolve) => {
    execFile('ps', ['-o', 'rss=', '-p', String(pid)], (_e, out) => resolve(Math.round(Number(out.trim() || 0) / 1024)))
  })
}
