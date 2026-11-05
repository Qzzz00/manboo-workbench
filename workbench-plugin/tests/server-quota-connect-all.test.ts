// @vitest-environment node
/**
 * 「全部接上」(2026-09-25,卡 fix/quota-and-slot-apps):Claude、Codex 一次看、一次点,每家仍能单独撤回。
 *
 * 维护者 09-24 引导完:「授权要自己点就算了」—— 可以要他点,但只点一次。
 * 这里钉的是:
 * 1. 预览与真写是同一个函数算出来的(看到的 = 写进去的);
 * 2. 只写装了、没接上的那几家;接上了的不写(不白留备份),没装的不写也不提;
 * 3. 一家写坏不连累另一家,也不回滚另一家;每家各自一份备份,撤回仍是一家一颗;
 * 4. 门:预览 trusted、真写只认回环;没接线 404;
 * 5. Kimi 不在里面(它要他本人登录),但那一句要说清「自己登一次就好」。
 *
 * 写入一律落在 `mkdtemp` 出来的临时 HOME 里 —— 真实的 `~/.claude`、`~/.codex` 一个字节都不碰。
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { ClientsView } from '../src/protocol.ts'
import { createAppConfig } from '../src/server/appConfig.ts'
import type { ClientScan } from '../src/server/clientScan.ts'
import { CODEX_TRUST_HOW } from '../src/server/codexHookTrust.ts'
import { wbHooksMentionsOurScript } from '../src/server/hooksConfig.ts'
import { createHookScripts, HOOK_SCRIPTS_ERRORS } from '../src/server/hookScripts.ts'
import type { WorkbenchServer } from '../src/server/http.ts'
import { startWorkbenchServer } from '../src/server/http.ts'
import { connectAllApply, connectAllPreview, quotaConnectStatus, tildePath } from '../src/server/quotaConnect.ts'
import type { ConnectAllDeps } from '../src/server/quotaConnect.ts'
import { createWorkbenchService } from '../src/server/service.ts'
import { nodeSetupIo } from '../src/server/setup/io.ts'

/** 钩子脚本的固定位置(卡 R)。纯函数那几条用例只要一个位置,不真放脚本。 */
const HOOKS = '/Users/someone/.dsh/workbench/hooks'
const LOOPBACK = '127.0.0.1'
const PHONE = '192.168.1.20'

const OFF = { installed: false, connected: false }
const PENDING = { installed: true, connected: false }
const ON = { installed: true, connected: true }
function clientsOf(over: Partial<ClientsView> = {}): ClientsView {
  return { claude: OFF, codex: OFF, kimi: OFF, wechat: OFF, wecom: OFF, ...over }
}

function tmpHome() {
  const dir = mkdtempSync(join(tmpdir(), 'wb-connect-all-'))
  const home = join(dir, 'home')
  mkdirSync(join(home, '.claude'), { recursive: true })
  return { dir, home, claudeFile: join(home, '.claude', 'settings.json'), codexFile: join(home, '.codex', 'hooks.json') }
}

function depsOf(over: { clients?: ClientsView | undefined, scriptsError?: string } = {}) {
  const t = tmpHome()
  const clients = 'clients' in over ? over.clients : clientsOf({ claude: PENDING, codex: PENDING })
  const deps: ConnectAllDeps = {
    files: { claude: t.claudeFile, codex: t.codexFile },
    io: nodeSetupIo(),
    now: () => new Date(2026, 8, 25, 9, 30, 0),
    hooksDir: async () => (over.scriptsError === undefined ? { ok: true as const, dir: HOOKS } : { ok: false as const, error: over.scriptsError }),
    clients: () => clients,
  }
  return { ...t, deps }
}

function ourCommands(file: string): string[] {
  const hooks = JSON.parse(readFileSync(file, 'utf8')).hooks as Record<string, { hooks: { command: string }[] }[]>
  return Object.values(hooks).flatMap(groups => groups.flatMap(group => group.hooks.map(hook => hook.command)))
    .filter(command => wbHooksMentionsOurScript(command))
}

describe('connectAllPreview:先看,一个字不写', () => {
  it('★两家都装了没接:各要写进哪个文件、写什么、会加几条,一句话说清能单独撤回;Kimi 另说一句', async () => {
    const { deps, claudeFile, codexFile } = depsOf({
      clients: clientsOf({ claude: PENDING, codex: PENDING, kimi: { ...PENDING, how: '要你自己登一次:去设置 → 额度凭据。' } }),
    })
    const preview = await connectAllPreview(deps)
    expect(preview.ok).toBe(true)
    if (!preview.ok) return
    expect(preview.apply).toEqual(['claude', 'codex'])
    const [claude, codex] = preview.agents
    expect(claude).toMatchObject({ agent: 'claude', name: 'Claude', state: 'pending', file: claudeFile })
    expect(claude?.will).toEqual({ added: 4, replaced: 0, status_line: 'added' })
    expect(codex?.will).toEqual({ added: 3, replaced: 0, status_line: 'none' })
    // 摆给他看的内容就是要写进去的那几条(命令指向钩子脚本的固定位置,不提任何仓库)。
    expect(JSON.stringify(claude?.content)).toContain(`${HOOKS}/agent-hook.sh claude`)
    expect(JSON.stringify(preview)).not.toContain('workbench-plugin')
    expect(preview.line).toContain('要写 2 家')
    expect(preview.line).toContain('写完每家都能单独撤回')
    expect(preview.kimi).toEqual({ state: 'pending', how: '要你自己登一次:去设置 → 额度凭据。' })
    expect(preview.line).toContain('Kimi 要你自己登一次')
    // 预览不写盘。
    expect(existsSync(claudeFile)).toBe(false)
    expect(existsSync(codexFile)).toBe(false)
  })

  it('接上了的那家不进 apply(不白留一份备份),没装的那家不出现在那句话里', async () => {
    const { deps } = depsOf({ clients: clientsOf({ claude: ON, codex: OFF }) })
    const preview = await connectAllPreview(deps)
    if (!preview.ok) throw new Error('应当 ok')
    expect(preview.apply).toEqual([])
    expect(preview.agents.map(row => row.state)).toEqual(['connected', 'not_installed'])
    expect(preview.line).toContain('Claude 已经接上了')
    expect(preview.line).not.toContain('Codex')
  })

  it('★一家的文件是坏 JSON:预览里就如实说这一家写不了,另一家照常在 apply 里', async () => {
    const { deps, claudeFile } = depsOf()
    writeFileSync(claudeFile, '{ 这不是 json')
    const preview = await connectAllPreview(deps)
    if (!preview.ok) throw new Error('应当 ok')
    expect(preview.apply).toEqual(['codex'])
    expect(preview.agents[0]?.error).toContain('不是合法的 JSON')
    expect(preview.line).toContain('Claude 这次写不了')
  })

  it('探测还没结论 → 两家都当要写(把"还不知道"当成"不用写",他点了却什么都没发生)', async () => {
    const { deps } = depsOf({ clients: undefined })
    const preview = await connectAllPreview(deps)
    if (!preview.ok) throw new Error('应当 ok')
    expect(preview.apply).toEqual(['claude', 'codex'])
    expect(preview.agents.map(row => row.state)).toEqual(['unknown', 'unknown'])
    expect(preview.kimi).toBeUndefined()
  })

  it('★钩子脚本没放好 → 不给预览(摆出一条指着空位置的命令,就是几条静默失败的钩子),那句人话原样回', async () => {
    const { deps } = depsOf({ scriptsError: HOOK_SCRIPTS_ERRORS.write_failed })
    const preview = await connectAllPreview(deps)
    expect(preview.ok).toBe(false)
    expect(preview.ok ? '' : preview.error).toBe(HOOK_SCRIPTS_ERRORS.write_failed)
  })
})

describe('connectAllApply:一次点,逐家写', () => {
  it('★两家一次写好:各自一份备份、各自只有工作台的那几条;他原来的东西一个字不动', async () => {
    const { deps, claudeFile, codexFile } = depsOf()
    const before = `${JSON.stringify({ model: 'opus' }, null, 2)}\n`
    writeFileSync(claudeFile, before)
    const applied = await connectAllApply(deps)
    if (!('results' in applied)) throw new Error('应当写了')
    expect(applied.ok).toBe(true)
    expect(applied.results.map(row => [row.agent, row.ok])).toEqual([['claude', true], ['codex', true]])
    // Claude 原来有文件 → 有备份;Codex 原来没有 → 没有东西可备份。
    const claude = applied.results[0]
    expect(String(claude?.backup_path)).toContain('bak-工作台-20260925-093000')
    expect(readFileSync(String(claude?.backup_path), 'utf8')).toBe(before)
    expect(applied.results[1]?.backup_path).toBeUndefined()
    expect(JSON.parse(readFileSync(claudeFile, 'utf8')).model).toBe('opus')
    expect(ourCommands(claudeFile)).toHaveLength(4)
    expect(ourCommands(codexFile)).toHaveLength(3)
    // 要重开会话那一句两家并一句说。
    expect(applied.restart_hint).toContain('Claude Code 窗口和 Codex 会话')
    // Codex 写进去之后还要她在 Codex 里放行一次(2026-10-21),不说这句她会以为接上了。
    expect(applied.restart_hint).toContain(CODEX_TRUST_HOW)
    expect(applied.line).toContain('Claude、Codex 接上了')
  })

  it('★一家写坏不连累另一家,也不回滚另一家:逐家如实说', async () => {
    const { deps, claudeFile, codexFile } = depsOf()
    mkdirSync(join(codexFile, '..'), { recursive: true })
    writeFileSync(codexFile, '{ 坏的')
    const applied = await connectAllApply(deps, { agents: ['claude', 'codex'] })
    if (!('results' in applied)) throw new Error('应当写了')
    expect(applied.ok).toBe(false)
    expect(applied.results[0]).toMatchObject({ agent: 'claude', ok: true })
    expect(applied.results[1]).toMatchObject({ agent: 'codex', ok: false })
    expect(ourCommands(claudeFile)).toHaveLength(4)
    // 坏文件原样留着,一个字没动。
    expect(readFileSync(codexFile, 'utf8')).toBe('{ 坏的')
    expect(applied.line).toContain('Codex 没写成')
    expect(applied.restart_hint).toContain('Claude Code')
    // 只写成了 Claude:不提 Codex 的放行。
    expect(applied.restart_hint).not.toContain(CODEX_TRUST_HOW)
  })

  it('已经接上的不写;全都接上了就如实说「这次什么都没写」', async () => {
    const { deps, claudeFile } = depsOf({ clients: clientsOf({ claude: ON, codex: ON }) })
    const applied = await connectAllApply(deps)
    if (!('results' in applied)) throw new Error('应当 ok')
    expect(applied.ok).toBe(true)
    expect(applied.results).toEqual([])
    expect(applied.skipped.map(row => row.agent)).toEqual(['claude', 'codex'])
    expect(applied.line).toContain('这次什么都没写')
    expect(applied.restart_hint).toBeUndefined()
    expect(existsSync(claudeFile)).toBe(false)
  })

  it('★钩子脚本没放好 → 一家都不写(不是写一半)', async () => {
    const { deps, claudeFile, codexFile } = depsOf({ scriptsError: HOOK_SCRIPTS_ERRORS.no_source })
    const applied = await connectAllApply(deps)
    expect('results' in applied).toBe(false)
    expect(existsSync(claudeFile)).toBe(false)
    expect(existsSync(codexFile)).toBe(false)
  })

  it('tildePath:给人看的那一句里用短路径', () => {
    expect(tildePath('/Users/example/.claude/settings.json')).toBe('~/.claude/settings.json')
    expect(tildePath('/tmp/x.json')).toBe('/tmp/x.json')
  })
})

// ———————————————————————————— HTTP ————————————————————————————

const started: WorkbenchServer[] = []
afterEach(async () => { while (started.length) await started.pop()?.close() })

function fakeScan(view: ClientsView | undefined) {
  let invalidated = 0
  const scan: ClientScan = {
    view: () => view,
    pump: () => {},
    scan: async () => view,
    invalidate: () => { invalidated += 1 },
    installedKeys: () => undefined,
  }
  return { scan, invalidated: () => invalidated }
}

/**
 * 起一台真服务。钩子脚本走**真的**那一套(这份 checkout 里插件包的 bin/ → 临时 HOME 下的
 * `.dsh/workbench/hooks/`);`noScripts` 时给一份找不到来源的(模拟装得不完整的包)。
 */
async function serve(over: { wire?: boolean, clients?: ClientsView, noScripts?: boolean } = {}) {
  const t = tmpHome()
  const remote = { address: LOOPBACK }
  const scan = fakeScan(over.clients ?? clientsOf({ claude: PENDING, codex: PENDING }))
  const server = await startWorkbenchServer({
    port: 0,
    service: createWorkbenchService({ now: () => 0 }),
    tickIntervalMs: 0,
    heartbeatMs: 0,
    remoteAddress: () => remote.address,
    clientScan: scan.scan,
    paths: {
      config: createAppConfig({ file: join(t.dir, 'app.json') }),
      home: t.home,
      ...(over.noScripts === true ? { hookScripts: createHookScripts({ home: t.home, moduleDir: join(t.dir, '不是插件包') }) } : {}),
      ...(over.wire === false
        ? {}
        : { applyHooks: { files: { claude: t.claudeFile, codex: t.codexFile }, now: () => new Date(2026, 8, 25, 9, 30, 0) } }),
    },
  })
  started.push(server)
  const call = async (method: 'GET' | 'POST', path: string, body?: unknown, from?: string) => {
    remote.address = from ?? LOOPBACK
    const res = await fetch(`${server.url}${path}`, {
      method,
      ...(method === 'POST' ? { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body ?? {}) } : {}),
    })
    const text = await res.text()
    remote.address = LOOPBACK
    return { status: res.status, body: (text === '' ? {} : JSON.parse(text)) as Record<string, any> }
  }
  return { ...t, call, scan }
}

describe('HTTP:/quota/connect-all/*', () => {
  it('★预览 → 一次写 → 每家仍能单独撤回(撤回走原来那条 /config/hooks/revert,一个字没改)', async () => {
    const { call, claudeFile, codexFile, scan, home } = await serve()
    const preview = await call('POST', '/quota/connect-all/preview')
    expect(preview.status).toBe(200)
    expect(preview.body.apply).toEqual(['claude', 'codex'])
    // GET 也认(引导落地那张卡渲染时拿)。
    expect((await call('GET', '/quota/connect-all/preview')).body.apply).toEqual(['claude', 'codex'])

    const applied = await call('POST', '/quota/connect-all/apply')
    expect(applied.status).toBe(200)
    expect(applied.body.ok).toBe(true)
    expect(applied.body.results.map((row: { agent: string }) => row.agent)).toEqual(['claude', 'codex'])
    expect(ourCommands(claudeFile)).toHaveLength(4)
    expect(ourCommands(codexFile)).toHaveLength(3)
    // ★命令指着这台(临时)机器上钩子脚本的固定位置,而且那个脚本真在、能执行。
    const script = join(home, '.dsh', 'workbench', 'hooks', 'agent-hook.sh')
    for (const command of [...ourCommands(claudeFile), ...ourCommands(codexFile)]) {
      expect(command.startsWith(`${script} `)).toBe(true)
    }
    expect(statSync(script).mode & 0o111).not.toBe(0)
    // 钩子刚变:探测作废,下一拍额度面板就说「接上了」。
    expect(scan.invalidated()).toBe(1)

    // 只撤 Codex:Claude 那边一条都不少。
    const reverted = await call('POST', '/config/hooks/revert', { agent: 'codex' })
    expect(reverted.body.removed).toBe(3)
    expect(ourCommands(codexFile)).toHaveLength(0)
    expect(ourCommands(claudeFile)).toHaveLength(4)
  })

  it('★真写只认回环:手机上(带令牌也一样)点不了,一个字没写', async () => {
    const { call, claudeFile } = await serve()
    const res = await call('POST', '/quota/connect-all/apply', {}, PHONE)
    expect(res.status).toBe(403)
    expect(existsSync(claudeFile)).toBe(false)
  })

  it('agents 只认 claude / codex(Kimi 要他自己登)', async () => {
    const { call, claudeFile } = await serve()
    const res = await call('POST', '/quota/connect-all/apply', { agents: ['kimi'] })
    expect(res.status).toBe(400)
    expect(String(res.body.error)).toContain('Kimi')
    expect(existsSync(claudeFile)).toBe(false)
  })

  it('只写 agents 里点名的那家', async () => {
    const { call, claudeFile, codexFile } = await serve()
    const res = await call('POST', '/quota/connect-all/apply', { agents: ['codex'] })
    expect(res.body.results.map((row: { agent: string }) => row.agent)).toEqual(['codex'])
    expect(existsSync(claudeFile)).toBe(false)
    expect(ourCommands(codexFile)).toHaveLength(3)
  })

  it('没接代写 → 两条都 404(既有用例碰不到真实家目录)', async () => {
    const { call } = await serve({ wire: false })
    expect((await call('GET', '/quota/connect-all/preview')).status).toBe(404)
    expect((await call('POST', '/quota/connect-all/apply')).status).toBe(404)
  })

  /**
   * 卡 R 的第 3 条:真接不上时一句人话 + 一键能做的下一步(界面上那颗「再试一次」)。
   * **不许**再出现仓库、插件、路径、英文文件名,也不许叫他去改设置。
   */
  it('★钩子脚本放不好 → 503 + 一句人话(没有仓库、插件、路径、英文文件名),一个字没写', async () => {
    const { call, claudeFile, codexFile } = await serve({ noScripts: true })
    for (const [method, path] of [['GET', '/quota/connect-all/preview'], ['POST', '/quota/connect-all/apply']] as const) {
      const res = await call(method, path)
      expect(res.status).toBe(503)
      const error = String(res.body.error)
      expect(error).toBe(HOOK_SCRIPTS_ERRORS.no_source)
      expect(error).toContain('再试一次')
      expect(error).not.toMatch(/仓库|插件|设置|\/|[A-Za-z]/)
    }
    expect(existsSync(claudeFile)).toBe(false)
    expect(existsSync(codexFile)).toBe(false)
  })
})

describe('quotaConnectStatus:有额度的四家接没接上(给球下面那张卡、引导落地的预览)', () => {
  it('★维护者那台机器:DeepSeek 走中转、三家装了没接、微信企微装着 → 只有四家,一句话照念', () => {
    const status = quotaConnectStatus({
      clients: clientsOf({ claude: PENDING, codex: PENDING, kimi: PENDING, wechat: PENDING, wecom: PENDING }),
      quota: {},
      model_mode: 'relay',
    })
    expect(status?.providers.map(row => [row.agent, row.state])).toEqual([
      ['dsh', 'connected'], ['claude', 'one_click'], ['codex', 'one_click'], ['kimi', 'login'],
    ])
    expect(status?.one_click).toBe(true)
    expect(status?.line).toBe('DeepSeek 已接上;Claude、Codex 要你点一次「全部接上」;Kimi 要你自己登一次')
    expect(JSON.stringify(status)).not.toMatch(/微信|企业微信|wechat|wecom/)
    expect(status?.providers[3]?.note).toContain('要你自己登一次')
  })

  it('DeepSeek 确定没 Key → setup(去设置里二选一);这次没取到 → unknown,不进那句话', () => {
    const none = quotaConnectStatus({
      clients: clientsOf({ claude: ON }),
      quota: { dsh: { kind: 'unknown', note: '还没接 DeepSeek', no_stale: true } },
      model_mode: 'own',
    })
    expect(none?.providers[0]?.state).toBe('setup')
    expect(none?.line).toBe('Claude 已接上;DeepSeek 还没接,去设置里二选一')
    const flaky = quotaConnectStatus({
      clients: clientsOf({ claude: ON }),
      quota: { dsh: { kind: 'unknown', note: '这次没取到(HTTP 503)' } },
      model_mode: 'own',
    })
    expect(flaky?.providers[0]?.state).toBe('unknown')
    expect(flaky?.line).toBe('Claude 已接上')
    expect(flaky?.one_click).toBe(false)
  })

  it('没装的不进那句话;clients 还没扫过 → 整个说不出来(undefined)', () => {
    const status = quotaConnectStatus({ clients: clientsOf({ codex: PENDING }), quota: {} })
    expect(status?.providers.map(row => row.state)).toEqual(['unknown', 'not_installed', 'one_click', 'not_installed'])
    expect(status?.line).toBe('Codex 要你点一次「全部接上」')
    expect(quotaConnectStatus({ clients: undefined, quota: {} })).toBeUndefined()
  })
})

describe('HTTP:GET /quota/connect 与 /state.quota_connect 是同一份', () => {
  it('扫过 → 200;/state 里那一格一样', async () => {
    const { call } = await serve({ clients: clientsOf({ claude: PENDING, codex: ON, kimi: PENDING, wechat: PENDING }) })
    const res = await call('GET', '/quota/connect')
    expect(res.status).toBe(200)
    expect(res.body.one_click).toBe(true)
    expect(res.body.line).toBe('Codex 已接上;Claude 要你点一次「全部接上」;Kimi 要你自己登一次')
    const state = await call('GET', '/state')
    expect(state.body.quota_connect).toEqual(res.body)
  })
})
