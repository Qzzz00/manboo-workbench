// @vitest-environment node
/**
 * 代写钩子的 HTTP 层(2026-09-17):`POST /config/hooks/apply` 与 `POST /config/hooks/revert`。
 *
 * 这里钉的是**那道门**与**那份回执**:只认回环、没接线就 404、写完要说"得重开会话"、
 * 备份路径原样回给界面(界面要把它显示出来,不然"备份了"等于没说)。
 *
 * 写入一律落在 `mkdtemp` 出来的临时 HOME 里 —— 真实的 `~/.claude`、`~/.codex` 一个字节都不碰。
 */
import { mkdtempSync, mkdirSync, readFileSync, statSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createAppConfig } from '../src/server/appConfig.ts'
import type { WorkbenchServer } from '../src/server/http.ts'
import { startWorkbenchServer } from '../src/server/http.ts'
import { createWorkbenchService } from '../src/server/service.ts'
import { createHookScripts, HOOK_SCRIPTS_ERRORS } from '../src/server/hookScripts.ts'

const LOOPBACK = '127.0.0.1'
const PHONE = '192.168.1.20'

const started: WorkbenchServer[] = []
afterEach(async () => { while (started.length) await started.pop()?.close() })

/**
 * 起一台真服务。钩子脚本走**真的**那一套(这份 checkout 里插件包的 bin/ → 临时 HOME 下的
 * `.dsh/workbench/hooks/`);`noScripts` 时给一份找不到来源的(模拟装得不完整的包)。
 */
async function serve(over: { noScripts?: boolean, wire?: boolean } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'wb-hooks-http-'))
  const home = join(dir, 'home')
  mkdirSync(join(home, '.claude'), { recursive: true })
  const claudeFile = join(home, '.claude', 'settings.json')
  const codexFile = join(home, '.codex', 'hooks.json')
  const hookScript = join(home, '.dsh', 'workbench', 'hooks', 'agent-hook.sh')
  const remote = { address: LOOPBACK }

  const server = await startWorkbenchServer({
    port: 0,
    service: createWorkbenchService({ now: () => 0 }),
    tickIntervalMs: 0,
    heartbeatMs: 0,
    remoteAddress: () => remote.address,
    paths: {
      config: createAppConfig({ file: join(dir, 'app.json') }),
      home,
      ...(over.noScripts === true ? { hookScripts: createHookScripts({ home, moduleDir: join(dir, '不是插件包') }) } : {}),
      ...(over.wire === false
        ? {}
        : { applyHooks: { files: { claude: claudeFile, codex: codexFile }, now: () => new Date(2026, 8, 17, 21, 42, 33) } }),
    },
  })
  started.push(server)

  const post = async (path: string, body: unknown, from?: string) => {
    remote.address = from ?? LOOPBACK
    const res = await fetch(`${server.url}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
    const text = await res.text()
    remote.address = LOOPBACK
    return { status: res.status, body: (text === '' ? {} : JSON.parse(text)) as Record<string, any> }
  }
  return { post, claudeFile, codexFile, home, hookScript }
}

describe('POST /config/hooks/apply', () => {
  it('空机器:直接生成四条 + statusLine,没有备份,并且说"要重开会话才生效"', async () => {
    const { post, claudeFile, hookScript } = await serve()
    const { status, body } = await post('/config/hooks/apply', { agent: 'claude' })
    expect(status).toBe(200)
    expect(body.ok).toBe(true)
    expect(body.added).toBe(4)
    expect(body.replaced).toBe(0)
    expect(body.backup_path).toBeUndefined()
    expect(body.file).toBe(claudeFile)
    expect(String(body.restart_hint)).toContain('重新开一个')
    const written = JSON.parse(readFileSync(claudeFile, 'utf8'))
    // ★命令指着钩子脚本的固定位置(卡 R),而且写之前脚本已经放好、能执行。
    expect(written.hooks.Stop[0].hooks[0].command).toBe(`${hookScript} claude`)
    expect(statSync(hookScript).mode & 0o111).not.toBe(0)
  })

  it('★文件已经在:先备份,回执里带着备份路径(界面要把它显示出来)', async () => {
    const { post, claudeFile } = await serve()
    const before = JSON.stringify({ model: 'opus' }, null, 2) + '\n'
    writeFileSync(claudeFile, before)
    const { body } = await post('/config/hooks/apply', { agent: 'claude' })
    expect(String(body.backup_path)).toContain('bak-工作台-20260917-214233')
    expect(readFileSync(String(body.backup_path), 'utf8')).toBe(before)
    expect(JSON.parse(readFileSync(claudeFile, 'utf8')).model).toBe('opus')
  })

  it('Codex:父目录 ~/.codex 还不存在也能写(只装了 Claude 的机器就是这样)', async () => {
    const { post, codexFile } = await serve()
    expect(existsSync(codexFile)).toBe(false)
    const { status, body } = await post('/config/hooks/apply', { agent: 'codex' })
    expect(status).toBe(200)
    expect(body.added).toBe(3)
    expect(Object.keys(JSON.parse(readFileSync(codexFile, 'utf8')).hooks)).toEqual(['Stop', 'UserPromptSubmit', 'SessionEnd'])
  })

  it('★重复点两次是幂等的(第二次 replaced=4,总数还是四条)', async () => {
    const { post, claudeFile } = await serve()
    await post('/config/hooks/apply', { agent: 'claude' })
    const { body } = await post('/config/hooks/apply', { agent: 'claude' })
    expect(body.replaced).toBe(4)
    const hooks = JSON.parse(readFileSync(claudeFile, 'utf8')).hooks
    expect(Object.values(hooks).flatMap((groups: any) => groups.flatMap((group: any) => group.hooks))).toHaveLength(4)
  })

  it('★手机(带令牌也一样)碰不到:403 —— 它写的是这台机器家目录里的文件', async () => {
    const { post, claudeFile } = await serve()
    const { status, body } = await post('/config/hooks/apply', { agent: 'claude' }, PHONE)
    expect(status).toBe(403)
    // 局域网没开时连来源门都过不去(「此来源不允许访问」);开了也还有这条路自己的回环门。
    expect(String(body.error)).toMatch(/本机|不允许访问/)
    expect(existsSync(claudeFile)).toBe(false)
  })

  it('agent 写错 → 400,不写', async () => {
    const { post, claudeFile } = await serve()
    expect((await post('/config/hooks/apply', { agent: 'kimi' })).status).toBe(400)
    expect((await post('/config/hooks/apply', {})).status).toBe(400)
    expect(existsSync(claudeFile)).toBe(false)
  })

  it('★钩子脚本放不好 → 503 一句人话(不提仓库、插件、路径),而且一个字都不写', async () => {
    const { post, claudeFile } = await serve({ noScripts: true })
    const { status, body } = await post('/config/hooks/apply', { agent: 'claude' })
    expect(status).toBe(503)
    expect(body.error).toBe(HOOK_SCRIPTS_ERRORS.no_source)
    expect(String(body.error)).not.toMatch(/仓库|插件|\/|[A-Za-z]/)
    expect(existsSync(claudeFile)).toBe(false)
  })

  it('★原文件是坏 JSON → 400 一句人话,原文一个字不动', async () => {
    const { post, claudeFile } = await serve()
    writeFileSync(claudeFile, '{ 这不是 json')
    const { status, body } = await post('/config/hooks/apply', { agent: 'claude' })
    expect(status).toBe(400)
    expect(String(body.error)).toContain('JSON')
    expect(readFileSync(claudeFile, 'utf8')).toBe('{ 这不是 json')
  })
})

describe('POST /config/hooks/revert', () => {
  it('★只摘工作台自己的那几条,别人的(headroom)一条不少', async () => {
    const { post, codexFile } = await serve()
    await post('/config/hooks/apply', { agent: 'codex' })
    const withOther = JSON.parse(readFileSync(codexFile, 'utf8'))
    withOther.hooks.Stop.unshift({ hooks: [{ type: 'command', command: '/opt/headroom/bin/headroom-hook.sh' }] })
    writeFileSync(codexFile, JSON.stringify(withOther, null, 2))

    const { status, body } = await post('/config/hooks/revert', { agent: 'codex' })
    expect(status).toBe(200)
    expect(body.removed).toBe(3)
    expect(String(body.backup_path)).toContain('bak-工作台-')
    const after = JSON.parse(readFileSync(codexFile, 'utf8'))
    expect(after.hooks.Stop).toEqual([{ hooks: [{ type: 'command', command: '/opt/headroom/bin/headroom-hook.sh' }] }])
  })

  it('★撤回不需要知道脚本在哪(脚本放不好、条目还指着别的位置也撤得干净)', async () => {
    const { post, claudeFile } = await serve()
    await post('/config/hooks/apply', { agent: 'claude' })
    // 换一台"钩子脚本放不好"的服务来撤 —— 靠的是条目上那个标记,不是路径。
    const moved = await serve({ noScripts: true })
    const text = readFileSync(claudeFile, 'utf8')
    writeFileSync(moved.claudeFile, text)
    const { status, body } = await moved.post('/config/hooks/revert', { agent: 'claude' })
    expect(status).toBe(200)
    expect(body.removed).toBe(4)
    expect(JSON.parse(readFileSync(moved.claudeFile, 'utf8')).statusLine).toBeUndefined()
  })

  it('本来就没接过:如实回 removed:0,不留备份、不造文件', async () => {
    const { post, claudeFile } = await serve()
    const { status, body } = await post('/config/hooks/revert', { agent: 'claude' })
    expect(status).toBe(200)
    expect(body.removed).toBe(0)
    expect(String(body.note)).toContain('本来就没有')
    expect(existsSync(claudeFile)).toBe(false)
  })

  it('手机碰不到:403', async () => {
    const { post } = await serve()
    expect((await post('/config/hooks/revert', { agent: 'claude' }, PHONE)).status).toBe(403)
  })
})

describe('没接代写时', () => {
  it('★两条路由 404,只读的 GET /config/hooks 照常 —— 既有用例一个字不用改', async () => {
    const { post } = await serve({ wire: false })
    expect((await post('/config/hooks/apply', { agent: 'claude' })).status).toBe(404)
    expect((await post('/config/hooks/revert', { agent: 'claude' })).status).toBe(404)
  })

  it('连 paths 都没接时同样 404', async () => {
    const server = await startWorkbenchServer({
      port: 0,
      service: createWorkbenchService({ now: () => 0 }),
      tickIntervalMs: 0,
      heartbeatMs: 0,
    })
    started.push(server)
    const res = await fetch(`${server.url}/config/hooks/apply`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"agent":"claude"}',
    })
    expect(res.status).toBe(404)
  })
})
