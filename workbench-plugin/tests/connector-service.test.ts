// @vitest-environment node
/**
 * 连接器默认装上、后台自己装(卡 OC2,2026-09-27)。
 *
 * 一条命令都不真跑(exec 是注入的假的),文件真写但全部在 mktemp 的临时 HOME 里。
 * 钉的是卡上那四条:**后台装不挡启动**、**装失败下次再试**、**状态行的字**、**卸掉**。
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { nodeSetupIo, type SetupExecOptions, type SetupExecResult, type SetupIo } from '../src/server/setup/io.ts'
import { CONNECTOR_PACKAGE, CONNECTOR_VERSION, connectorPaths } from '../src/server/connector/manifest.ts'
import { connectorFailureNote, createConnectorService } from '../src/server/connector/service.ts'
import { connectorRowText } from '../src/connectorText.ts'
import type { ConnectorView } from '../src/protocol.ts'

const dirs: string[] = []
afterEach(() => { while (dirs.length) rmSync(dirs.pop() as string, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }) })

function harness(options: { npmOk?: boolean, npmOut?: string, healthy?: boolean } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'wb-oc2-'))
  dirs.push(home)
  const p = connectorPaths(home)
  const calls: string[][] = []
  const real = nodeSetupIo()
  const io: SetupIo = {
    ...real,
    uid: () => 501,
    exec: async (cmd: readonly string[], _o?: SetupExecOptions): Promise<SetupExecResult> => {
      calls.push([...cmd])
      if (cmd[0] === p.nodeBin && cmd[1] === '-v') return { ok: true, code: 0, out: 'v24.19.0\n' }
      if (cmd[1] === 'install') {
        if (options.npmOk === false) return { ok: false, code: 1, out: options.npmOut ?? 'npm ERR! boom\n' }
        mkdirSync(`${p.catalogDir}`, { recursive: true })
        for (const name of ['zhihu', 'bilibili']) {
          writeFileSync(`${p.catalogDir}/${name}.json`, JSON.stringify({ service: name, actions: [] }))
        }
        writeFileSync(`${p.packageDir}/package.json`, JSON.stringify({ name: CONNECTOR_PACKAGE, version: CONNECTOR_VERSION }))
        return { ok: true, code: 0, out: 'added 315 packages\n' }
      }
      return { ok: true, code: 0, out: '' }
    },
  }
  let seq = 0
  const fetchImpl = (async () => {
    if (options.healthy === false || options.healthy === undefined) throw new Error('refused')
    return new Response(JSON.stringify({ ok: true, name: 'open-connector' }), { headers: { 'content-type': 'application/json' } })
  }) as unknown as typeof fetch
  const service = createConnectorService({
    home, io, fetchImpl, cacheMs: 0, randomToken: () => `t-${++seq}`,
    // 探「答上话了没有」在用例里不等:真机是 16 × 500ms。
    probeAttempts: 1, probeGapMs: 0,
  })
  return { home, p, calls, service }
}

describe('后台自己装', () => {
  it('还没装时状态是「还没装」,而且那一行说得出要下多大', async () => {
    const h = harness()
    const view = await h.service.view()
    expect(view.installed).toBe(false)
    expect(view.phase).toBe('missing')
    expect(view.running).toBe(false)
    expect(view.connected).toBeUndefined()   // 没装时不写 0
    expect(view.bytes).toBeUndefined()
    expect(connectorRowText(view)).toBe('连接器:还没装(开机后自己装,第一次要下载约 230MB)')
  })

  it('ensure() 立刻返回(不挡启动),装完状态变「已装好」', async () => {
    const h = harness({ healthy: true })
    const t0 = Date.now()
    h.service.ensure()
    expect(Date.now() - t0).toBeLessThan(50)
    await h.service.install()          // 等同一趟装完(单飞)
    const view = await h.service.view()
    expect(view.installed).toBe(true)
    expect(view.phase).toBe('ready')
    expect(view.apps).toBe(2)
    expect(view.connected).toBe(0)
    expect(connectorRowText(view)).toBe('连接器:已装好 · 可用 2 家 · 接了 0 家')
  })

  it('单飞:两次 ensure 只装一趟', async () => {
    const h = harness({ healthy: true })
    h.service.ensure()
    h.service.ensure()
    await h.service.install()
    expect(h.calls.filter((c) => c[1] === 'install')).toHaveLength(1)
  })

  it('连接器还没答上话时,先不接事务官(不拖慢 DSH 启动),另外两家照接', async () => {
    const h = harness({ healthy: false })
    await h.service.install()
    const view = await h.service.view()
    // MCP_HOSTS 的顺序是 dsh / claude-code / codex
    expect(view.hosts.map((x) => `${x.id}:${x.connected}`)).toEqual(['dsh:false', 'claude-code:true', 'codex:true'])
  })

  it('装好之后自动起、自动把三家的 MCP 配置写上', async () => {
    const h = harness({ healthy: true })
    await h.service.install()
    expect(h.calls.some((c) => c[0] === 'launchctl' && c[1] === 'bootstrap')).toBe(true)
    expect(h.calls.some((c) => c[0] === 'launchctl' && c[1] === 'kickstart')).toBe(true)
    const view = await h.service.view()
    expect(view.hosts.map((x) => x.connected)).toEqual([true, true, true])
    expect(view.running).toBe(true)
  })

  it('装不上就记一句人话,状态是 failed,而且**没自己重试**', async () => {
    const h = harness({ npmOk: false, npmOut: 'npm ERR! getaddrinfo ENOTFOUND registry.npmjs.org\n' })
    h.service.ensure()
    const r = await h.service.install()
    expect(r.ok).toBe(false)
    const view = await h.service.view()
    expect(view.phase).toBe('failed')
    expect(view.installed).toBe(false)
    expect(connectorRowText(view)).toBe('连接器:没装上 —— 这会儿下载不了(网络不通),等有网了下次开机自己接着装。')
    expect(h.calls.filter((c) => c[1] === 'install')).toHaveLength(1)
  })

  it('失败之后「再试一次」是真的再来一趟', async () => {
    const h = harness({ npmOk: false })
    await h.service.install()
    await h.service.install()
    expect(h.calls.filter((c) => c[1] === 'install')).toHaveLength(2)
  })

  it('原话归成人话,归不了就照原话的尾巴说,不编', () => {
    expect(connectorFailureNote('npm ERR! ETIMEDOUT')).toContain('网络不通')
    expect(connectorFailureNote('ENOSPC: no space left on device')).toContain('磁盘快满了')
    expect(connectorFailureNote('EACCES: permission denied')).toContain('没有写入权限')
    expect(connectorFailureNote('npm ERR! 说不清的怪事\n')).toBe('这次没装上:npm ERR! 说不清的怪事')
    expect(connectorFailureNote('')).toBe('这次没装上。')
  })
})

describe('卸掉', () => {
  it('卸完状态回到「还没装」,并且把「凭据一起删了」说出来', async () => {
    const h = harness({ healthy: true })
    await h.service.install()
    const r = await h.service.uninstall()
    expect(r.ok).toBe(true)
    const view = await h.service.view()
    expect(view.installed).toBe(false)
    expect(view.note).toContain('凭据')
    expect(view.hosts.map((x) => x.connected)).toEqual([false, false, false])
    expect(h.calls.some((c) => c[0] === 'launchctl' && c[1] === 'bootout')).toBe(true)
  })
})

describe('状态行那句话', () => {
  const base: ConnectorView = {
    phase: 'ready', installed: true, running: true, port: 8796, version: CONNECTOR_VERSION,
    downloadBytes: 229 * 1024 * 1024, hosts: [],
  }
  it('正在装', () => {
    expect(connectorRowText({ ...base, phase: 'installing', installed: false, running: false }))
      .toBe('连接器:正在装(第一次要下载约 230MB)')
  })
  it('数不到的不写 0', () => {
    expect(connectorRowText(base)).toBe('连接器:已装好')
    expect(connectorRowText({ ...base, apps: 1554, connected: 0 })).toBe('连接器:已装好 · 可用 1554 家 · 接了 0 家')
  })
  it('装着但没在跑要说出来', () => {
    expect(connectorRowText({ ...base, running: false, apps: 1554 })).toBe('连接器:已装好 · 可用 1554 家 · 这会儿没在跑')
  })
})
