// @vitest-environment node
/**
 * 连接器(open-connector)装 / 卸与策略(卡 OC,2026-09-27)。
 *
 * **这里一条命令都不会真跑**:exec 是注入的假的。文件真写,但全部落在 mktemp 出来的
 * 临时 HOME 里 —— 所有路径都由 `connectorPaths(home)` 算出来,代码里没有一处 process.env.HOME。
 *
 * 用例覆盖卡上点名的五件事:
 *   ① 清单与版本钉   ② 配置写入幂等、手改不覆盖   ③ 只听回环
 *   ④ 默认只读策略(含「一家都没接 = 什么都不许」这个坑)   ⑤ 卸载干净
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { nodeSetupIo, type SetupExecOptions, type SetupExecResult, type SetupIo } from '../src/server/setup/io.ts'
import {
  CONNECTOR_DEFAULT_PORT, CONNECTOR_HOST_SERVER_VERSION, CONNECTOR_LAUNCHD_LABEL, CONNECTOR_MIN_NODE_MAJOR,
  CONNECTOR_PACKAGE, CONNECTOR_TARBALL_INTEGRITY, CONNECTOR_VERSION, connectorOwnedPaths, connectorPaths,
} from '../src/server/connector/manifest.ts'
import { installConnector, parseConnectorConfig, uninstallConnector, connectorPolicyFile } from '../src/server/connector/install.ts'
import { buildConnectorPolicy, CONNECTOR_POLICY_SENTINEL, describeConnectorPolicy, type ConnectorCatalogApp } from '../src/server/connector/policy.ts'
import {
  CONNECTOR_TOKEN_PLACEHOLDER, MCP_HOSTS, parseMcpWritten,
  patchClaudeCode, patchCodex, patchDsh, unpatchClaudeCode, unpatchCodex, unpatchDsh,
} from '../src/server/connector/mcpConfig.ts'
import { CONNECTOR_HOST_SCRIPT, connectorPlist, connectorStartScript } from '../src/server/connector/hostScript.ts'

const dirs: string[] = []
afterEach(() => { while (dirs.length) rmSync(dirs.pop() as string, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }) })

function temp(): string {
  const dir = mkdtempSync(join(tmpdir(), 'wb-connector-'))
  dirs.push(dir)
  return dir
}

interface Harness {
  home: string
  calls: { cmd: readonly string[], cwd?: string }[]
  io: SetupIo
}

function harness(options: { nodeVersion?: string, npmOk?: boolean } = {}): Harness {
  const home = temp()
  const calls: Harness['calls'] = []
  const real = nodeSetupIo()
  const p = connectorPaths(home)
  const io: SetupIo = {
    ...real,
    uid: () => 501,
    exec: async (cmd: readonly string[], opts?: SetupExecOptions): Promise<SetupExecResult> => {
      calls.push({ cmd, ...(opts?.cwd ? { cwd: opts.cwd } : {}) })
      if (cmd[0] === p.nodeBin && cmd[1] === '-v') {
        return { ok: true, code: 0, out: `${options.nodeVersion ?? 'v24.19.0'}\n` }
      }
      if (cmd[1] === 'install') {
        if (options.npmOk === false) return { ok: false, code: 1, out: 'npm ERR! 网络断了\n' }
        // 假装装好了:摆出包的样子,让「本来就装着就跳过」那一条有东西可看。
        mkdirSync(`${p.packageDir}/assets/open-connector/catalog/apps`, { recursive: true })
        writeFileSync(`${p.packageDir}/package.json`, JSON.stringify({ name: CONNECTOR_PACKAGE, version: CONNECTOR_VERSION }))
        return { ok: true, code: 0, out: 'added 315 packages\n' }
      }
      return { ok: true, code: 0, out: '' }
    },
  }
  return { home, calls, io }
}

let seq = 0
const randomToken = () => `token-${++seq}`

/* ---------------------------------------------------------------- */
/* ① 清单与版本钉                                                    */
/* ---------------------------------------------------------------- */

describe('清单与版本钉(C4)', () => {
  it('版本逐字钉死,不是 ^ / ~ / latest', () => {
    expect(CONNECTOR_VERSION).toBe('1.6.5')
    expect(CONNECTOR_HOST_SERVER_VERSION).toMatch(/^\d+\.\d+\.\d+$/)
    for (const v of [CONNECTOR_VERSION, CONNECTOR_HOST_SERVER_VERSION]) {
      expect(v).not.toMatch(/[\^~*]|latest/)
    }
    expect(CONNECTOR_TARBALL_INTEGRITY).toMatch(/^sha512-[A-Za-z0-9+/=]+$/)
  })

  it('装出来的 package.json 里两条依赖都是定值', async () => {
    const h = harness()
    await installConnector({ io: h.io, home: h.home, randomToken })
    const pkg = JSON.parse(readFileSync(`${connectorPaths(h.home).dir}/package.json`, 'utf8')) as { dependencies: Record<string, string> }
    expect(pkg.dependencies[CONNECTOR_PACKAGE]).toBe(CONNECTOR_VERSION)
    expect(Object.values(pkg.dependencies).every((v) => /^\d+\.\d+\.\d+$/.test(v))).toBe(true)
  })

  it('自带 node 太旧就不装,而且说人话', async () => {
    const h = harness({ nodeVersion: 'v20.11.0' })
    const r = await installConnector({ io: h.io, home: h.home, randomToken })
    expect(r.ok).toBe(false)
    expect(r.steps.at(-1)?.message).toContain(String(CONNECTOR_MIN_NODE_MAJOR))
    expect(h.calls.some((c) => c.cmd[1] === 'install')).toBe(false)
  })

  it('端口不撞 8791 / 8792 / 8794 / 3080', () => {
    expect([3080, 8791, 8792, 8794]).not.toContain(CONNECTOR_DEFAULT_PORT)
  })
})

/* ---------------------------------------------------------------- */
/* ③ 只听回环                                                        */
/* ---------------------------------------------------------------- */

describe('只听回环', () => {
  it('宿主脚本里绑的是 127.0.0.1,而且 publicOrigin 也是本机', () => {
    expect(CONNECTOR_HOST_SCRIPT).toContain("const host = '127.0.0.1'")
    expect(CONNECTOR_HOST_SCRIPT).toContain('hostname: host')
    expect(CONNECTOR_HOST_SCRIPT).not.toMatch(/0\.0\.0\.0/)
  })

  it('写给各家 Agent 的地址一律是 127.0.0.1', () => {
    for (const host of MCP_HOSTS) {
      const out = host.patch('', { port: CONNECTOR_DEFAULT_PORT })
      expect(out.reason).toBe('written')
      expect(out.text).toContain(`http://127.0.0.1:${CONNECTOR_DEFAULT_PORT}/mcp`)
      expect(out.text).not.toMatch(/0\.0\.0\.0|localhost/)
    }
  })

  it('plist 用 {{HOME}} 占位,不写死某个人的家目录', () => {
    expect(connectorPlist()).toContain('{{HOME}}/.dsh/bin/connector-start')
    expect(connectorPlist()).not.toContain('/Users/')
    expect(connectorStartScript()).not.toContain('/Users/')
  })
})

/* ---------------------------------------------------------------- */
/* ② MCP 配置:幂等 + 手改不覆盖 + 不写令牌                           */
/* ---------------------------------------------------------------- */

describe('MCP 配置写入', () => {
  const endpoint = { port: CONNECTOR_DEFAULT_PORT }

  it('三家都不写令牌原文,只写占位符', () => {
    for (const host of MCP_HOSTS) {
      const out = host.patch('', endpoint)
      expect(out.reason).toBe('written')
      expect(out.text).toContain('OPEN_CONNECTOR_TOKEN')
      expect(out.text).not.toMatch(/Bearer\s+[0-9a-f]{16,}/)
    }
    expect(CONNECTOR_TOKEN_PLACEHOLDER).toBe('${OPEN_CONNECTOR_TOKEN}')
  })

  it('不往各家配置里塞我们自己的字段(Claude Code / Codex 对未知字段会报错)', () => {
    const claude = patchClaudeCode('', endpoint)
    const entry = (JSON.parse(claude.text) as { mcpServers: Record<string, Record<string, unknown>> }).mcpServers['open-connector']!
    expect(Object.keys(entry).sort()).toEqual(['headers', 'type', 'url'])
    expect(patchCodex('', endpoint).text).not.toContain('x-workbench')
    expect(patchDsh('', endpoint).text).not.toContain('x-workbench')
  })

  it('写第二遍一字不改(幂等),而且靠记账认得出是自己写的', () => {
    for (const host of MCP_HOSTS) {
      const first = host.patch('', endpoint)
      expect(first.changed).toBe(true)
      expect(first.wrote).toBeTruthy()
      const second = host.patch(first.text, { ...endpoint, recorded: first.wrote })
      expect(second.reason).toBe('already')
      expect(second.changed).toBe(false)
      expect(second.text).toBe(first.text)
    }
  })

  it('她手改过的一律不覆盖(没有记账、或记账对不上)', () => {
    // 没记过账:那一格在,但我们不知道是谁写的 → 不动
    const claude = patchClaudeCode(`${JSON.stringify({ mcpServers: { 'open-connector': { command: '她自己配的' } } }, null, 2)}\n`, endpoint)
    expect(claude.reason).toBe('user-edited')
    expect(claude.changed).toBe(false)
    expect(claude.text).toContain('她自己配的')

    expect(patchCodex('[mcp_servers.open-connector]\nurl = "http://example.test/mcp"\n', endpoint).reason).toBe('user-edited')
    expect(patchDsh('- id: mcp-open-connector\n  name: 她自己配的\n', endpoint).reason).toBe('user-edited')

    // 记过账,但她后来改了那一格 → 也不动
    const mine = patchClaudeCode('', endpoint)
    const edited = mine.text.replace('127.0.0.1', '127.0.0.9')
    expect(patchClaudeCode(edited, { ...endpoint, recorded: mine.wrote }).reason).toBe('user-edited')
  })

  it('端口变了、而且那一格还是我们上次写的 → 换掉', () => {
    const first = patchClaudeCode('', endpoint)
    const moved = patchClaudeCode(first.text, { port: 8899, recorded: first.wrote })
    expect(moved.reason).toBe('written')
    expect(moved.text).toContain('127.0.0.1:8899/mcp')
  })

  it('别人的配置一个字节不动', () => {
    const before = `${JSON.stringify({ theme: 'dark', mcpServers: { serena: { command: 'uvx' } } }, null, 2)}\n`
    const out = patchClaudeCode(before, endpoint)
    const after = JSON.parse(out.text) as { theme: string, mcpServers: Record<string, unknown> }
    expect(after.theme).toBe('dark')
    expect(after.mcpServers['serena']).toEqual({ command: 'uvx' })

    const toml = '[model]\nname = "gpt-5"\n\n[mcp_servers.serena]\nurl = "http://127.0.0.1:24282/mcp"\n'
    const codex = patchCodex(toml, endpoint)
    expect(codex.text.startsWith(toml)).toBe(true)
  })

  it('认不得的文件不写,而且说人话', () => {
    for (const patch of [
      patchClaudeCode('{ 这不是 JSON', endpoint),
      patchClaudeCode(`${JSON.stringify({ mcpServers: 'ん' })}`, endpoint),
      patchDsh('foo: bar\n', endpoint),
      patchDsh('- id: a\n\tname: x\n', endpoint),
    ]) {
      expect(patch.ok).toBe(false)
      expect(patch.reason).toBe('bad')
      expect(patch.changed).toBe(false)
      expect(patch.say).toMatch(/认不得/)
    }
  })

  it('摘只摘我们记过账的那一格,而且摘完不留空壳', () => {
    const before = patchClaudeCode(`${JSON.stringify({ mcpServers: { serena: { command: 'uvx' } } }, null, 2)}\n`, endpoint)
    const after = unpatchClaudeCode(before.text, { port: 0, recorded: before.wrote })
    expect(after.reason).toBe('written')
    const json = JSON.parse(after.text) as { mcpServers: Record<string, unknown> }
    expect(json.mcpServers['open-connector']).toBeUndefined()
    expect(json.mcpServers['serena']).toEqual({ command: 'uvx' })

    // 只有我们那一格时,`mcpServers` 这个键也去掉 —— 回到没写过时那样
    const only = patchClaudeCode('', endpoint)
    const bare = unpatchClaudeCode(only.text, { port: 0, recorded: only.wrote })
    expect(JSON.parse(bare.text)).toEqual({})

    // 没记过账的不许摘
    expect(unpatchCodex('[mcp_servers.open-connector]\nurl = "别人的"\n', { port: 0 }).reason).toBe('user-edited')
    expect(unpatchDsh('', { port: 0 }).reason).toBe('absent')
  })

  it('written.json 读坏了就当没记过账(于是一格都不敢覆盖)', () => {
    expect(parseMcpWritten(undefined)).toEqual({})
    expect(parseMcpWritten('{ 坏的')).toEqual({})
    expect(parseMcpWritten(JSON.stringify({ 'claude-code': 'x', 别的: 1 }))).toEqual({ 'claude-code': 'x' })
  })
})

/* ---------------------------------------------------------------- */
/* ④ 默认只读                                                        */
/* ---------------------------------------------------------------- */

describe('默认只读策略', () => {
  const app = (service: string, actions: [string, string][]): ConnectorCatalogApp => ({
    service,
    actions: actions.map(([name, operationType]) => ({ id: `${service}.${name}`, name, operationType })),
  })
  const catalog = (...apps: ConnectorCatalogApp[]) => (s: string) => apps.find((a) => a.service === s)

  it('只放 read,write 与 destructive 一律不进单子', () => {
    const policy = buildConnectorPolicy({
      services: ['weixin_official_account'],
      catalog: catalog(app('weixin_official_account', [
        ['get_draft_count', 'read'], ['add_draft', 'write'], ['delete_draft', 'destructive'],
      ])),
    })
    expect(policy.allowedActions).toEqual(['weixin_official_account.get_draft_count'])
    expect(policy.perService[0]).toEqual({ service: 'weixin_official_account', read: 1, withheld: 2, missing: false })
  })

  it('没标 operationType 的当写处理(往严的那边错)', () => {
    const policy = buildConnectorPolicy({
      services: ['x'],
      catalog: catalog({ service: 'x', actions: [{ id: 'x.mystery' }] }),
    })
    expect(policy.allowedActions).toEqual([CONNECTOR_POLICY_SENTINEL])
  })

  it('一家都没接 = 什么都不许(空白名单会被它当成全放行,所以要哨兵)', () => {
    const policy = buildConnectorPolicy({ services: [], catalog: () => undefined })
    expect(policy.allowedActions).toEqual([CONNECTOR_POLICY_SENTINEL])
    expect(policy.allowedActions.length).toBeGreaterThan(0)
    expect(policy.allowedActions).not.toContain('*')
  })

  it('catalog 里没有这一家 = 一条都不放行', () => {
    const policy = buildConnectorPolicy({ services: ['没这一家'], catalog: () => undefined })
    expect(policy.perService[0]?.missing).toBe(true)
    expect(policy.allowedActions).toEqual([CONNECTOR_POLICY_SENTINEL])
  })

  it('审批批过的写动作能临时放行,但只限已启用的那几家', () => {
    const c = catalog(app('bilibili', [['get_archive', 'read'], ['upload_video', 'write']]))
    const policy = buildConnectorPolicy({
      services: ['bilibili'],
      catalog: c,
      approvedWrites: ['bilibili.upload_video', 'notion.create_page'],
    })
    expect(policy.allowedActions).toContain('bilibili.upload_video')
    expect(policy.allowedActions).not.toContain('notion.create_page')
  })

  it('装完落盘的 policy.json 就是这一份,而且默认是「什么都不许」', async () => {
    const h = harness()
    await installConnector({ io: h.io, home: h.home, randomToken })
    const text = readFileSync(`${connectorPaths(h.home).dir}/policy.json`, 'utf8')
    expect(JSON.parse(text)).toEqual({ allowedActions: [CONNECTOR_POLICY_SENTINEL] })
    expect(text).toBe(connectorPolicyFile([], () => undefined))
  })

  it('一行人话:取不到就整句不显示,不写 0', () => {
    expect(describeConnectorPolicy(buildConnectorPolicy({ services: [], catalog: () => undefined }))).toBeUndefined()
    const one = buildConnectorPolicy({ services: ['zhihu'], catalog: catalog(app('zhihu', [['hot_list', 'read'], ['zhida', 'write']])) })
    expect(describeConnectorPolicy(one)).toBe('接了 1 家 · 放行只读 1 项 · 写和发布 1 项要先问你')
  })
})

/* ---------------------------------------------------------------- */
/* 装:幂等 + 0600 + 令牌不重开                                       */
/* ---------------------------------------------------------------- */

describe('装', () => {
  it('从零装一遍:文件都在,配置 0600,令牌不落进任何别的文件', async () => {
    const h = harness()
    const r = await installConnector({ io: h.io, home: h.home, randomToken })
    expect(r.ok).toBe(true)
    const p = connectorPaths(h.home)
    for (const f of [p.entry, p.configFile, p.startScript, p.plist, `${p.dir}/policy.json`, `${h.home}/.dsh/bin/connector-env`]) {
      expect(existsSync(f), f).toBe(true)
    }
    const config = parseConnectorConfig(readFileSync(p.configFile, 'utf8'))
    expect(config?.port).toBe(CONNECTOR_DEFAULT_PORT)
    expect(config?.runtimeToken).toBeTruthy()
    // 令牌只住在这一个 0600 的文件里
    expect(statSync(p.configFile).mode & 0o777).toBe(0o600)
    for (const f of [p.entry, p.plist, p.startScript, MCP_HOSTS[1]!.file(h.home)]) {
      expect(readFileSync(f, 'utf8')).not.toContain(config!.runtimeToken)
    }
    expect(h.calls.some((c) => c.cmd[0] === 'launchctl' && c.cmd[1] === 'bootstrap' && c.cmd[3] === p.plist)).toBe(true)
  })

  it('再装一遍:不重跑 npm、不重开令牌', async () => {
    const h = harness()
    await installConnector({ io: h.io, home: h.home, randomToken })
    const config1 = readFileSync(connectorPaths(h.home).configFile, 'utf8')
    const before = h.calls.length
    const r = await installConnector({ io: h.io, home: h.home, randomToken })
    expect(r.ok).toBe(true)
    expect(r.steps.find((s) => s.step === 'deps')?.message).toContain('跳过')
    expect(h.calls.slice(before).some((c) => c.cmd[1] === 'install')).toBe(false)
    expect(readFileSync(connectorPaths(h.home).configFile, 'utf8')).toBe(config1)
  })

  it('npm 挂了就停在那一步,不去动 launchd 与各家配置', async () => {
    const h = harness({ npmOk: false })
    const r = await installConnector({ io: h.io, home: h.home, randomToken })
    expect(r.ok).toBe(false)
    expect(r.mcp).toEqual([])
    expect(h.calls.some((c) => c.cmd[0] === 'launchctl')).toBe(false)
    expect(existsSync(MCP_HOSTS[1]!.file(h.home))).toBe(false)
  })
})

/* ---------------------------------------------------------------- */
/* ⑤ 卸干净                                                          */
/* ---------------------------------------------------------------- */

describe('卸', () => {
  it('装了再卸:自己那几处全没了,别人的配置原样留着', async () => {
    const h = harness()
    const claudeFile = MCP_HOSTS[1]!.file(h.home)
    mkdirSync(join(h.home, '.codex'), { recursive: true })
    writeFileSync(claudeFile, `${JSON.stringify({ mcpServers: { serena: { command: 'uvx' } } }, null, 2)}\n`)
    await installConnector({ io: h.io, home: h.home, randomToken })
    const r = await uninstallConnector({ io: h.io, home: h.home })
    expect(r.ok).toBe(true)
    for (const path of connectorOwnedPaths(h.home)) {
      expect(existsSync(path), path).toBe(false)
    }
    expect(existsSync(`${h.home}/.dsh/bin/connector-env`)).toBe(false)
    const json = JSON.parse(readFileSync(claudeFile, 'utf8')) as { mcpServers: Record<string, unknown> }
    expect(json.mcpServers['open-connector']).toBeUndefined()
    expect(json.mcpServers['serena']).toEqual({ command: 'uvx' })
    expect(h.calls.some((c) => c.cmd[0] === 'launchctl' && c.cmd[1] === 'bootout' && c.cmd[2] === `gui/501/${CONNECTOR_LAUNCHD_LABEL}`)).toBe(true)
  })

  it('没装过也能卸(幂等),而且说得出「本来就没装」', async () => {
    const h = harness()
    const r = await uninstallConnector({ io: h.io, home: h.home })
    expect(r.ok).toBe(true)
    expect(r.removed).toEqual([])
    expect(r.steps.find((s) => s.step === 'files')?.message).toBe('本来就没装')
  })

  it('卸载把数据目录(里头是各家账号的凭据)一起删', async () => {
    const h = harness()
    await installConnector({ io: h.io, home: h.home, randomToken })
    const p = connectorPaths(h.home)
    writeFileSync(`${p.dataDir}/connect.sqlite`, 'x')
    await uninstallConnector({ io: h.io, home: h.home })
    expect(existsSync(p.dataDir)).toBe(false)
  })
})
