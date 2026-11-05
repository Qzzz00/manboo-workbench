// @vitest-environment node
/**
 * 装机形态测试(2026-09-25,卡 R「接额度用的钩子脚本随插件走」)。**这是机制的证明**。
 *
 * 维护者:「下一个用户是不是会遇到一样的问题,得建立机制」。卡 R 的病根是:所有用例都跑在仓库里,
 * 而用户那台机器上**没有仓库** —— 插件是 `npm pack` 出来的一个包,装在 `~/.dsh/profiles/web` 里,
 * `butler_cwd` 是一个普通的工作目录。用例从来没在那个形态下跑过,于是「包里没带 bin/」一直没人发现。
 *
 * 这里就在那个形态下跑:
 *   1. 构建 → `npm pack` 到临时目录(用的是发版时一模一样的那条路);
 *   2. 解进一个假的 `~/.dsh/profiles/web`(pnpm 的布局:真目录在 `.pnpm/<带版本号的名字>/…`,外面一个符号链接);
 *   3. 起一个**子进程**:HOME 指向临时目录、工作目录在临时目录、环境变量只给最少几样(没有 WORKBENCH_BUTLER_CWD),
 *      `butler_cwd` 指向一个普通空目录,身边没有任何仓库;在里面 import **装好的那份** `lib/index.js` 起服务;
 *   4. 跑找钩子(`GET /config/hooks`)、接额度的预览与写入(`/quota/connect-all/*`),写进临时的假
 *      `~/.claude/settings.json`、假 `~/.codex/hooks.json`;
 *   5. 断言:成功;写进去的命令指着的文件真在、可执行、内容就是包里那一份;**真跑一次那条命令**(像 Claude Code
 *      那样交给 shell),工作台收得到;状态栏那条也真跑一次,额度真的上来了。
 *
 * 第二个场景是维护者那台机器:现有条目指着开发仓库里的 `workbench-plugin/bin/…`,点一次「全部接上」要平滑换成新位置 ——
 * 写前另存一份、他自己的一个字不动、每家能单独撤回。
 *
 * 真实的 `~/.claude`、`~/.codex`、`~/.dsh` 一个字节都碰不到:子进程的 HOME 是临时目录,写的每一个文件都在它下面。
 */
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

const ROOT = fileURLToPath(new URL('..', import.meta.url)).replace(/\/$/, '')
/** 维护者那台机器上现有条目指着的开发仓库。 */
const BEN_REPO = '/Users/example/Documents/GitHub/desktop-workbench'
/** 沙箱的名字前缀。收拾时只认这个前缀下、系统临时目录里的那一个。 */
const BOX_PREFIX = join(tmpdir(), 'wb-install-shape-')

/** 一次构建 + 打包,两个场景共用这一个 tgz。 */
let tgz = ''
let box = ''

/**
 * 收拾这一次 mkdtemp 出来的沙箱(三份解开的包加一个 tgz,几十 MB,不留在临时目录里)。
 * 2026-09-04 家目录被删事故之后的纪律:递归删除只许落在 mkdtemp 沙箱里 —— 路径必须是
 * 本用例前缀下的那一个,别的任何路径一律不动。
 */
afterAll(() => {
  if (box === '' || !box.startsWith(BOX_PREFIX) || box.slice(BOX_PREFIX.length).includes('/')) return
  rmSync(box, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
})

beforeAll(() => {
  box = mkdtempSync(BOX_PREFIX)
  // ① 构建:跟发版一样出 lib/(tsdown;技能生成文件是提交在仓库里的那份)。
  execFileSync(join(ROOT, 'node_modules', '.bin', 'tsdown'), [], { cwd: ROOT, stdio: 'ignore' })
  // ② 打包:发版、安装包、本机装机三条路都是这一句。
  const packages = join(box, 'packages')
  mkdirSync(packages, { recursive: true })
  const out = execFileSync('npm', ['pack', '--pack-destination', packages, '--json', '--ignore-scripts'], {
    cwd: ROOT,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
    env: { ...process.env, npm_config_loglevel: 'silent', npm_config_update_notifier: 'false' },
  })
  const name = (JSON.parse(out) as { filename: string }[])[0]?.filename ?? ''
  tgz = join(packages, name)
  expect(existsSync(tgz)).toBe(true)
}, 180_000)

interface Machine {
  home: string
  /** 装好的插件包的真目录(pnpm 的 .pnpm/… 那一层)。 */
  pkgDir: string
  /** profile 里那个符号链接指向的入口(DSH 就是从这里 import 的)。 */
  entry: string
  /** butler_cwd:一个普通的空目录。 */
  workDir: string
}

/** 摆一台"装好了、身边没有仓库"的机器:假 HOME + 假 profile(pnpm 布局)+ 空工作目录。 */
function installMachine(label: string): Machine {
  const home = join(box, label, 'home')
  const profile = join(home, '.dsh', 'profiles', 'web')
  const tgzName = tgz.slice(tgz.lastIndexOf('/') + 1)
  const pkgDir = join(profile, 'node_modules', '.pnpm', `@ben+dsh-workbench@file+..+..+packages+${tgzName}`, 'node_modules', '@ben', 'dsh-workbench')
  mkdirSync(pkgDir, { recursive: true })
  execFileSync('tar', ['-xzf', tgz, '-C', pkgDir, '--strip-components=1'])
  mkdirSync(join(profile, 'node_modules', '@ben'), { recursive: true })
  const link = join(profile, 'node_modules', '@ben', 'dsh-workbench')
  symlinkSync(relative(dirname(link), pkgDir), link)
  writeFileSync(join(profile, 'package.json'), `${JSON.stringify({ dependencies: { '@ben/dsh-workbench': `file:../../packages/${tgzName}` } }, null, 2)}\n`)
  const workDir = join(home, 'Documents', '工作台')
  mkdirSync(workDir, { recursive: true })
  return { home, pkgDir, entry: join(link, 'lib', 'index.js'), workDir }
}

/**
 * 子进程里跑的那一段:import 装好的那份插件、起服务、走一遍「看 → 写 → 真跑命令 → (可选)撤回」。
 * 只用 node 自带的东西;每一步的结果原样写进一份 JSON(WB_OUT)。
 */
const CHILD = `
import { readFileSync, writeFileSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { pathToFileURL } from 'node:url'

const home = process.env.HOME
const workDir = process.env.WB_WORKDIR
const mod = await import(pathToFileURL(process.env.WB_ENTRY).href)
let config = { lan_access: false, butler_cwd: workDir }
const server = await mod.startWorkbenchServer({
  port: 0,
  service: mod.createWorkbenchService({ now: () => Math.floor(Date.now() / 1000) }),
  tickIntervalMs: 0,
  heartbeatMs: 0,
  paths: {
    config: { get: async () => config, set: async (patch) => (config = { ...config, ...patch }) },
    home,
    applyHooks: { files: { claude: home + '/.claude/settings.json', codex: home + '/.codex/hooks.json' } },
  },
})
async function call(method, path, body) {
  const res = await fetch(server.url + path, method === 'GET' ? {} : { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body ?? {}) })
  const text = await res.text()
  return { status: res.status, body: text === '' ? {} : JSON.parse(text) }
}
/**
 * 像 Claude Code / Codex 那样:把配置里那条命令整条交给 shell,stdin 喂事件。
 * **异步**起子进程 —— 服务就跑在这个进程里,同步等的话它回不了脚本那条 curl。
 */
function runCommand(command, input) {
  return new Promise((resolve) => {
    const child = spawn('/bin/sh', ['-c', command], {
      env: { PATH: process.env.PATH, HOME: home, WORKBENCH_PORT: String(server.port) },
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk) => { stdout += chunk })
    child.stderr.on('data', (chunk) => { stderr += chunk })
    const timer = setTimeout(() => child.kill('SIGKILL'), 15000)
    child.on('close', (status) => { clearTimeout(timer); resolve({ status, stdout, stderr }) })
    child.stdin.end(JSON.stringify(input))
  })
}
/** 读一份配置;没写成(文件不在)就当空的 —— 让外面的断言说清是哪一步没成,而不是这里先崩。 */
const readJson = (file) => { try { return JSON.parse(readFileSync(file, 'utf8')) } catch { return {} } }
const ours = (file) => Object.values(readJson(file).hooks ?? {})
  .flatMap(groups => groups.flatMap(group => (group.hooks ?? []).map(hook => hook.command)))
  .filter(command => command.includes('/.dsh/workbench/hooks/'))

const out = {}
out.hooksClaude = await call('GET', '/config/hooks?agent=claude')
out.hooksCodex = await call('GET', '/config/hooks?agent=codex')
out.preview = await call('GET', '/quota/connect-all/preview')
out.apply = await call('POST', '/quota/connect-all/apply', {})
out.claudeCommands = ours(home + '/.claude/settings.json')
out.codexCommands = ours(home + '/.codex/hooks.json')
out.statusLine = readJson(home + '/.claude/settings.json').statusLine ?? null
if (out.claudeCommands.length > 0) {
  out.hookRun = await runCommand(out.claudeCommands[0], {
    session_id: 'ses-install-shape', cwd: workDir, hook_event_name: 'Notification',
    message: 'Claude needs your permission to use Bash',
  })
}
if (out.statusLine !== null) {
  const soon = Math.floor(Date.now() / 1000) + 3600
  out.statusRun = await runCommand(out.statusLine.command, {
    session_id: 'ses-install-shape', cwd: workDir, model: { display_name: 'Opus' },
    rate_limits: { five_hour: { used_percentage: 23.5, resets_at: soon }, seven_day: { used_percentage: 41.2, resets_at: soon + 86400 } },
  })
}
const state = await call('GET', '/state')
out.sessions = state.body.sessions ?? []
out.claudeQuota = state.body.quota?.claude ?? null
if (process.env.WB_REVERT_CODEX === '1') out.revertCodex = await call('POST', '/config/hooks/revert', { agent: 'codex' })
await server.close()
// 结果写进文件:服务起来时自己会往 stdout 打日志(比如「[技能] …」),不跟它混在一起。
writeFileSync(process.env.WB_OUT, JSON.stringify(out))
`

interface ChildOut {
  hooksClaude: { status: number, body: any }
  hooksCodex: { status: number, body: any }
  preview: { status: number, body: any }
  apply: { status: number, body: any }
  claudeCommands: string[]
  codexCommands: string[]
  statusLine: { command: string } | null
  hookRun?: { status: number | null, stdout: string, stderr: string }
  statusRun?: { status: number | null, stdout: string, stderr: string }
  sessions: { agent: string, session_id: string, status: string }[]
  claudeQuota: any
  revertCodex?: { status: number, body: any }
}

/** 在「装好的机器」上跑一遍子进程。环境变量只给最少几样 —— 尤其没有 WORKBENCH_BUTLER_CWD。 */
function runOn(machine: Machine, extra: Record<string, string> = {}): ChildOut {
  const stamp = Math.random().toString(36).slice(2)
  const script = join(box, `child-${stamp}.mjs`)
  const result = join(box, `child-${stamp}.json`)
  writeFileSync(script, CHILD)
  const run = spawnSync(process.execPath, [script], {
    cwd: box,
    env: {
      PATH: process.env.PATH ?? '/usr/bin:/bin',
      HOME: machine.home,
      TMPDIR: box,
      WB_ENTRY: machine.entry,
      WB_WORKDIR: machine.workDir,
      WB_OUT: result,
      ...extra,
    },
    encoding: 'utf8',
    timeout: 120_000,
  })
  if (run.status !== 0) throw new Error(`子进程没跑通(退出码 ${run.status}):${run.stderr}`)
  return JSON.parse(readFileSync(result, 'utf8')) as ChildOut
}

/** 从一个目录往上找,每一层看有没有某个相对路径。 */
function foundAbove(start: string, rel: string): string | undefined {
  let dir = start
  for (;;) {
    if (existsSync(join(dir, rel))) return dir
    const parent = dirname(dir)
    if (parent === dir) return undefined
    dir = parent
  }
}

function assertRunnableScript(machine: Machine, command: string, name: string): void {
  const script = command.split(' ')[0] ?? ''
  const expected = join(machine.home, '.dsh', 'workbench', 'hooks', name)
  expect(script).toBe(expected)
  const info = statSync(script)
  expect(info.isFile()).toBe(true)
  expect(info.mode & 0o111).not.toBe(0)
  // 内容就是装好的包里那一份(不是什么仓库里的)。
  expect(readFileSync(script, 'utf8')).toBe(readFileSync(join(machine.pkgDir, 'bin', name), 'utf8'))
}

describe('装机形态:npm pack → 装进假 profile → 身边没有仓库、butler_cwd 是空目录', () => {
  it('★包里带着两个钩子脚本(卡 R 之前这里是空的)', () => {
    const machine = installMachine('probe')
    expect(existsSync(join(machine.pkgDir, 'bin', 'agent-hook.sh'))).toBe(true)
    expect(existsSync(join(machine.pkgDir, 'bin', 'claude-statusline.sh'))).toBe(true)
    // 装法跟 DSH 的 profile 一样:外面是符号链接,真目录名里带版本号。
    expect(lstatSync(join(machine.home, '.dsh', 'profiles', 'web', 'node_modules', '@ben', 'dsh-workbench')).isSymbolicLink()).toBe(true)
    expect(realpathSync(machine.entry)).toBe(realpathSync(join(machine.pkgDir, 'lib', 'index.js')))
  })

  it('★干净的机器:找钩子、预览、写入都成;写进去的命令指着的文件真在、能执行;真跑一次,工作台收得到', () => {
    const machine = installMachine('clean')
    // 身边真的没有仓库:从装好的包往上找不到开发仓库的标志文件,butler_cwd 是空目录。
    expect(foundAbove(machine.pkgDir, 'workbench-plugin/bin/agent-hook.sh')).toBeUndefined()
    expect(readdirSync(machine.workDir)).toEqual([])

    const out = runOn(machine)

    // 找钩子(设置里「看一下」那条):200,指固定位置。
    expect(out.hooksClaude.status).toBe(200)
    expect(out.hooksClaude.body.hooks_dir).toBe(join(machine.home, '.dsh', 'workbench', 'hooks'))
    expect(out.hooksCodex.status).toBe(200)
    // 接额度的预览:两家都要写(探测没接 → 都当要写),不提仓库。
    expect(out.preview.status).toBe(200)
    expect(out.preview.body.apply).toEqual(['claude', 'codex'])
    expect(JSON.stringify(out.preview.body)).not.toContain('workbench-plugin')
    // 写入:两家都成。
    expect(out.apply.status).toBe(200)
    expect(out.apply.body.ok).toBe(true)
    expect(out.apply.body.results.map((row: { agent: string, ok: boolean }) => [row.agent, row.ok])).toEqual([['claude', true], ['codex', true]])

    // 写进去的命令:Claude 四条、Codex 三条,全指固定位置上那个脚本 —— 它真在、能执行、内容是包里那份。
    expect(out.claudeCommands).toHaveLength(4)
    expect(out.codexCommands).toHaveLength(3)
    for (const command of [...out.claudeCommands, ...out.codexCommands]) assertRunnableScript(machine, command, 'agent-hook.sh')
    expect(out.statusLine).not.toBeNull()
    assertRunnableScript(machine, out.statusLine?.command ?? '', 'claude-statusline.sh')

    // 真跑一次那条命令(像 Claude Code 那样交给 shell):退出 0,工作台收到了这条「等你确认」。
    expect(out.hookRun?.status).toBe(0)
    expect(out.sessions).toEqual(expect.arrayContaining([
      expect.objectContaining({ agent: 'claude', session_id: 'ses-install-shape', status: 'waiting' }),
    ]))
    // 状态栏那条也真跑一次:打印出额度那一行,工作台的额度真的上来了。
    expect(out.statusRun?.status).toBe(0)
    expect(out.statusRun?.stdout).toContain('76.5%')
    expect(out.claudeQuota?.kind).toBe('quota')
    // 状态栏的调用痕迹记在**这台机器**的 ~/.dsh/workbench/ 下(不是写死的哪台机器)。
    expect(readFileSync(join(machine.home, '.dsh', 'workbench', 'statusline.log'), 'utf8')).toContain('已送达')

    // 钩子这件事用不着 butler_cwd:工作目录还是空的。
    expect(readdirSync(machine.workDir)).toEqual([])
  }, 180_000)

  /**
   * 维护者那台机器:现有条目指着开发仓库(`/Users/example/Documents/GitHub/desktop-workbench/workbench-plugin/bin/…`)。
   * 装上新版后点一次「全部接上」:旧条目平滑换成固定位置,写前另存一份,他自己的一个字不动,每家能单独撤回。
   */
  it('★维护者那台(旧条目指着开发仓库):一次接上就换成新位置,备份是原文,他自己的一个字不动,Codex 能单独撤回', () => {
    const machine = installMachine('ben-like')
    const legacyClaude = `${BEN_REPO}/workbench-plugin/bin/agent-hook.sh claude`
    const legacyCodex = `${BEN_REPO}/workbench-plugin/bin/agent-hook.sh codex`
    const claudeBefore = {
      permissions: { allow: ['Bash(git:*)'] },
      model: 'opus',
      hooks: {
        Notification: [{ hooks: [{ type: 'command', command: legacyClaude, timeout: 5 }] }],
        Stop: [
          { matcher: '*', hooks: [{ type: 'command', command: '/opt/他自己的/notify.sh' }] },
          { hooks: [{ type: 'command', command: legacyClaude, timeout: 5 }] },
        ],
        UserPromptSubmit: [{ hooks: [{ type: 'command', command: legacyClaude, timeout: 5 }] }],
        SessionEnd: [{ hooks: [{ type: 'command', command: legacyClaude, timeout: 5 }] }],
      },
      statusLine: { type: 'command', command: `${BEN_REPO}/workbench-plugin/bin/claude-statusline.sh` },
    }
    const codexBefore = {
      hooks: {
        Stop: [
          { hooks: [{ type: 'command', command: '/opt/headroom/bin/headroom-hook.sh stop' }] },
          { hooks: [{ type: 'command', command: legacyCodex, timeout: 5 }] },
        ],
        UserPromptSubmit: [{ hooks: [{ type: 'command', command: legacyCodex, timeout: 5 }] }],
        SessionEnd: [
          { hooks: [{ type: 'command', command: '/opt/headroom/bin/headroom-hook.sh end' }] },
          { hooks: [{ type: 'command', command: legacyCodex, timeout: 5 }] },
        ],
      },
    }
    const claudeFile = join(machine.home, '.claude', 'settings.json')
    const codexFile = join(machine.home, '.codex', 'hooks.json')
    mkdirSync(dirname(claudeFile), { recursive: true })
    mkdirSync(dirname(codexFile), { recursive: true })
    const claudeText = `${JSON.stringify(claudeBefore, null, 2)}\n`
    const codexText = `${JSON.stringify(codexBefore, null, 2)}\n`
    writeFileSync(claudeFile, claudeText)
    writeFileSync(codexFile, codexText)

    const out = runOn(machine, { WB_REVERT_CODEX: '1' })

    // 预览里就说清:两家都要写,各换掉几条旧的。
    expect(out.preview.status).toBe(200)
    const will = Object.fromEntries(out.preview.body.agents.map((row: { agent: string, will: unknown }) => [row.agent, row.will]))
    expect(will.claude).toEqual({ added: 4, replaced: 4, status_line: 'replaced' })
    expect(will.codex).toEqual({ added: 3, replaced: 3, status_line: 'none' })

    // 写入:两家都成,各自一份备份,备份就是改之前的原文。
    expect(out.apply.status).toBe(200)
    expect(out.apply.body.ok).toBe(true)
    const results = Object.fromEntries(out.apply.body.results.map((row: { agent: string }) => [row.agent, row]))
    expect(results.claude).toMatchObject({ ok: true, replaced: 4, added: 4, status_line: 'replaced' })
    expect(results.codex).toMatchObject({ ok: true, replaced: 3, added: 3 })
    expect(readFileSync(results.claude.backup_path, 'utf8')).toBe(claudeText)
    expect(readFileSync(results.codex.backup_path, 'utf8')).toBe(codexText)

    // Claude:旧位置一条不剩,新位置正好四条;他自己的(权限、模型、Stop 上那条)一个字不动。
    const claudeAfter = JSON.parse(readFileSync(claudeFile, 'utf8'))
    expect(JSON.stringify(claudeAfter)).not.toContain('workbench-plugin/bin')
    expect(out.claudeCommands).toHaveLength(4)
    for (const command of out.claudeCommands) assertRunnableScript(machine, command, 'agent-hook.sh')
    expect(claudeAfter.permissions).toEqual(claudeBefore.permissions)
    expect(claudeAfter.model).toBe('opus')
    expect(claudeAfter.hooks.Stop[0]).toEqual(claudeBefore.hooks.Stop[0])
    assertRunnableScript(machine, claudeAfter.statusLine.command, 'claude-statusline.sh')
    // 换过去之后真跑一次:收得到。
    expect(out.hookRun?.status).toBe(0)
    expect(out.sessions.some(row => row.agent === 'claude' && row.session_id === 'ses-install-shape')).toBe(true)

    // Codex 单独撤回:工作台的三条摘掉,headroom 那两条原样留着;撤回前也另存了一份。
    expect(out.revertCodex?.status).toBe(200)
    expect(out.revertCodex?.body.removed).toBe(3)
    expect(existsSync(out.revertCodex?.body.backup_path)).toBe(true)
    const codexAfter = JSON.parse(readFileSync(codexFile, 'utf8'))
    const left = Object.values(codexAfter.hooks as Record<string, { hooks: { command: string }[] }[]>)
      .flatMap(groups => groups.flatMap(group => group.hooks.map(hook => hook.command)))
    expect(left).toEqual(['/opt/headroom/bin/headroom-hook.sh stop', '/opt/headroom/bin/headroom-hook.sh end'])
    // Claude 那边不受 Codex 撤回的影响。
    expect(JSON.parse(readFileSync(claudeFile, 'utf8')).hooks.Notification.at(-1).hooks[0].command)
      .toBe(`${join(machine.home, '.dsh', 'workbench', 'hooks', 'agent-hook.sh')} claude`)
  }, 180_000)
})
