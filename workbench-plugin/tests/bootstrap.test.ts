// @vitest-environment node
/**
 * 裸机引导(2026-09-17,`deploy/bootstrap.sh` 背后那半边)。
 *
 * 这块代码的全部价值就是**别把卡 A 的十一步重写一遍**:它只挑出「到登录台能打开」为止
 * 的六步,按顺序喂给同一个 `createSetupInstaller`,再把进度翻成人话。所以用例断言的是
 * 「挑了哪六步、顺序对不对、挡掉了哪条命令、失败时说了什么」,而不是安装本身 ——
 * 安装那部分已经被 `tests/setup-install.test.ts` 钉死了。
 *
 * **一条命令都不会真跑**:exec 是注入的假的。文件会真写,但全落在 mktemp 的临时 HOME 里
 * (所有路径由 `setupPaths({ home })` 算出,没有一处 process.env.HOME)。
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  BOOTSTRAP_STEPS,
  bootstrapPreflight,
  bootstrapSetupUrl,
  bootstrapSkip,
  checkNodeVersion,
  parseBootstrapArgs,
  runBootstrap,
  withSetupFlag,
  withSkippedCommands,
} from '../src/server/setup/bootstrap.ts'
import { nodeSetupIo, type SetupExecOptions, type SetupIo } from '../src/server/setup/io.ts'
import { setupPaths } from '../src/server/setup/paths.ts'
import { renderDshStart } from '../src/server/setup/install.ts'
import { isNpmCi, seedLockedRuntime } from './setup/dshRuntimeFake.ts'
import { fakePnpmExec, seedOwnNpm } from './setup/pnpmFake.ts'

const dirs: string[] = []
afterEach(() => { while (dirs.length) rmSync(dirs.pop() as string, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }) })

function temp(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  dirs.push(dir)
  return dir
}

function put(path: string, text = 'x'): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, text)
}

/** 一个「仓库里该有的东西都有」的假仓库。preflight 该一条都挑不出毛病。 */
function fullRepo(): string {
  const repo = temp('wb-boot-repo-')
  put(`${repo}/workbench-plugin/package.json`, '{"name":"@ben/dsh-workbench","version":"0.2.36"}')
  put(`${repo}/workbench-plugin/bin/dsh-start`, '#!/usr/bin/env bash\nexport DSH_HOME="$HOME/.dsh"\nexport WORKBENCH_BUTLER_CWD="$HOME/x"\n')
  put(`${repo}/workbench-plugin/bin/butler-start`, '#!/usr/bin/env bash\n')
  put(`${repo}/workbench-plugin/node_modules/.bin/tsdown`, '#!/bin/sh\n')
  put(`${repo}/deploy/channel-start`, '#!/usr/bin/env bash\n')
  put(`${repo}/deploy/ai.deepseek.dsh.plist`, '<plist><key>Label</key><string>ai.deepseek.dsh</string><string>{{HOME}}/.dsh/bin/dsh-start</string></plist>')
  put(`${repo}/butler-server/launchd/ai.deepseek.butler.plist`, '<plist><string>/Users/谁/.dsh/bin/butler-start</string></plist>')
  return repo
}

interface Harness {
  home: string
  repo: string
  calls: { cmd: readonly string[], cwd?: string }[]
  lines: string[]
  io: SetupIo
}

/** 假 io:命令按 `argv[0] argv[1]` 查表定成败,其余真写文件(在临时 HOME 里)。 */
function harness(options: {
  exec?: Record<string, { ok?: boolean, code?: number, out?: string }>
  repo?: string
} = {}): Harness {
  const home = temp('wb-boot-home-')
  const repo = options.repo ?? fullRepo()
  const calls: Harness['calls'] = []
  const lines: string[] = []
  const nodeSource = join(temp('wb-boot-node-'), 'node')
  writeFileSync(nodeSource, '#!/bin/sh\n')
  const paths = setupPaths({ home, repoRoot: repo })
  // 这台开发机的 `~/.dsh/node` 里 node 与 npm 都在(node 那步会判"已经有一份,不用换")
  // —— 2026-09-27 起只有一条 node 二进制、没有 npm 的话,那一步会改下官方独立包。
  seedOwnNpm(paths)
  const io: SetupIo = {
    ...nodeSetupIo(),
    exec: async (cmd: readonly string[], opts?: SetupExecOptions) => {
      calls.push({ cmd, ...(opts?.cwd === undefined ? {} : { cwd: opts.cwd }) })
      const key = [cmd[0], cmd[1]].filter(Boolean).join(' ')
      const hit = options.exec?.[key] ?? options.exec?.[cmd[0] ?? '']
      opts?.onLine?.(`(假的)${cmd.join(' ')}`)
      if (isNpmCi(cmd) && opts?.cwd !== undefined && (hit?.ok ?? true)) seedLockedRuntime(opts.cwd)
      if (options.exec?.[key] === undefined && options.exec?.[cmd[0] ?? ''] === undefined) {
        const pnpm = fakePnpmExec(paths, cmd)
        if (pnpm !== undefined) return pnpm
      }
      return { ok: hit?.ok ?? true, code: hit?.code ?? 0, out: hit?.out ?? '' }
    },
    uid: () => 501,
    currentNodeBinary: () => nodeSource,
  }
  return { home, repo, calls, lines, io }
}

function run(h: Harness, over: { steps?: readonly typeof BOOTSTRAP_STEPS[number][], skip?: (cmd: readonly string[]) => string | undefined } = {}): ReturnType<typeof runBootstrap> {
  const io = over.skip === undefined ? h.io : withSkippedCommands(h.io, over.skip)
  return runBootstrap({
    io,
    paths: setupPaths({ home: h.home, repoRoot: h.repo }),
    repoRoot: h.repo,
    steps: over.steps ?? BOOTSTRAP_STEPS,
    now: () => Date.parse('2026-09-17T10:00:00Z'),
    newId: (() => { let n = 0; return () => `job-${++n}` })(),
    report: line => h.lines.push(line),
    pollMs: 2,
  })
}

// ───────────────────────────── 挑哪几步 ─────────────────────────────

describe('裸机引导挑出来的六步', () => {
  it('就是 node → runtime → profile → plugin → scripts → launchd,一步不多', () => {
    expect(BOOTSTRAP_STEPS).toEqual(['node', 'runtime', 'profile', 'plugin', 'scripts', 'launchd'])
  })

  it('不含 shell —— 壳要重新授权辅助功能,留给人自己在初始化页里点', () => {
    expect(BOOTSTRAP_STEPS).not.toContain('shell')
  })

  it('也不含 butler / worker / web_login / restart', () => {
    for (const step of ['butler', 'worker', 'web_login', 'restart']) {
      expect(BOOTSTRAP_STEPS).not.toContain(step)
    }
  })
})

// ───────────────────────────── 命令行 ─────────────────────────────

describe('parseBootstrapArgs', () => {
  it('HOME 可覆盖:--home 压过 env.HOME', () => {
    const got = parseBootstrapArgs(['--home', '/tmp/h', '--repo', '/tmp/r'], { HOME: '/Users/example' })
    expect(got.ok).toBe(true)
    if (!got.ok) return
    expect(got.args.home).toBe('/tmp/h')
  })

  it('DSH_HOME 可覆盖;不给就是 <home>/.dsh', () => {
    const plain = parseBootstrapArgs(['--repo', '/tmp/r'], { HOME: '/tmp/h' })
    expect(plain.ok && plain.args.dshHome).toBe('/tmp/h/.dsh')
    const env = parseBootstrapArgs(['--repo', '/tmp/r'], { HOME: '/tmp/h', DSH_HOME: '/tmp/d' })
    expect(env.ok && env.args.dshHome).toBe('/tmp/d')
    const flag = parseBootstrapArgs(['--repo', '/tmp/r', '--dsh-home', '/tmp/f'], { HOME: '/tmp/h', DSH_HOME: '/tmp/d' })
    expect(flag.ok && flag.args.dshHome).toBe('/tmp/f')
  })

  it('--no-launch 与 --print-url 是开关', () => {
    const got = parseBootstrapArgs(['--repo', '/tmp/r', '--no-launch', '--print-url'], { HOME: '/tmp/h' })
    expect(got.ok && got.args.noLaunch).toBe(true)
    expect(got.ok && got.args.printUrl).toBe(true)
  })

  it('--steps 只认六步里的名字,认不出来的照原样报出来', () => {
    const good = parseBootstrapArgs(['--repo', '/tmp/r', '--steps', 'profile,scripts'], { HOME: '/tmp/h' })
    expect(good.ok && good.args.steps).toEqual(['profile', 'scripts'])
    const bad = parseBootstrapArgs(['--repo', '/tmp/r', '--steps', 'shell'], { HOME: '/tmp/h' })
    expect(bad.ok).toBe(false)
    if (bad.ok) return
    expect(bad.error).toContain('shell')
  })

  it('没有家目录 / 没有仓库路径,都在动手之前就停下并说清楚', () => {
    const noHome = parseBootstrapArgs(['--repo', '/tmp/r'], {})
    expect(noHome.ok).toBe(false)
    if (!noHome.ok) expect(noHome.error).toContain('家目录')
    const noRepo = parseBootstrapArgs([], { HOME: '/tmp/h' })
    expect(noRepo.ok).toBe(false)
    if (!noRepo.ok) expect(noRepo.error).toContain('仓库')
  })

  it('仓库路径也能从 WORKBENCH_BUTLER_CWD 来', () => {
    const got = parseBootstrapArgs([], { HOME: '/tmp/h', WORKBENCH_BUTLER_CWD: '/tmp/r' })
    expect(got.ok && got.args.repoRoot).toBe('/tmp/r')
  })

  it('不认识的参数直接停,不猜', () => {
    const got = parseBootstrapArgs(['--repo', '/tmp/r', '--装个壳'], { HOME: '/tmp/h' })
    expect(got.ok).toBe(false)
    if (!got.ok) expect(got.error).toContain('--装个壳')
  })
})

describe('checkNodeVersion', () => {
  it('24 及以上放行', () => {
    expect(checkNodeVersion('v24.19.0')).toEqual({ ok: true, major: 24 })
    expect(checkNodeVersion('25.0.0')).toEqual({ ok: true, major: 25 })
  })

  it('低于 24 停下,并且把 Homebrew 那条命令摆出来', () => {
    const got = checkNodeVersion('v20.11.0')
    expect(got.ok).toBe(false)
    if (got.ok) return
    expect(got.message).toContain('brew install node@24')
    expect(got.message).toContain('20')
  })

  it('认不出版本号就说认不出来,不当成通过', () => {
    const got = checkNodeVersion('不是版本号')
    expect(got.ok).toBe(false)
  })
})

// ───────────────────────────── 挡掉哪条命令 ─────────────────────────────

describe('bootstrapSkip', () => {
  it('--no-launch 时所有 launchctl 都不真跑', () => {
    const skip = bootstrapSkip({ noLaunch: true })
    expect(skip(['launchctl', 'bootstrap', 'gui/501', '/x/ai.deepseek.dsh.plist'])).toContain('--no-launch')
    expect(skip(['launchctl', 'kickstart', '-k', 'gui/501/ai.deepseek.dsh'])).toContain('--no-launch')
  })

  it('正常跑时 DSH 那条照跑,事务官那条不装载', () => {
    const skip = bootstrapSkip({ noLaunch: false })
    expect(skip(['launchctl', 'bootstrap', 'gui/501', '/x/ai.deepseek.dsh.plist'])).toBeUndefined()
    const butler = skip(['launchctl', 'bootstrap', 'gui/501', '/x/ai.deepseek.butler.plist'])
    expect(butler).toBeDefined()
    // 理由要写在人话里:装载它只会让 launchd 每 10 秒重启一次。
    expect(butler).toContain('事务官')
  })

  it('别的命令一律放行', () => {
    const skip = bootstrapSkip({ noLaunch: true })
    expect(skip(['npm', 'i'])).toBeUndefined()
    expect(skip(['rsync', '-a'])).toBeUndefined()
  })
})

describe('withSkippedCommands', () => {
  it('挡下来的命令算成功,并把理由喂进进度', async () => {
    const h = harness()
    const io = withSkippedCommands(h.io, cmd => (cmd[0] === 'launchctl' ? '跳过了' : undefined))
    const seen: string[] = []
    const got = await io.exec(['launchctl', 'bootstrap'], { onLine: line => seen.push(line) })
    expect(got.ok).toBe(true)
    expect(seen.join('\n')).toContain('跳过了')
    // 真的没发出去。
    expect(h.calls).toHaveLength(0)
  })

  it('没挡的命令原样透传', async () => {
    const h = harness()
    const io = withSkippedCommands(h.io, () => undefined)
    await io.exec(['npm', 'i'])
    expect(h.calls.map(c => c.cmd[0])).toEqual(['npm'])
  })
})

// ───────────────────────────── 动手之前先看一眼 ─────────────────────────────

describe('bootstrapPreflight', () => {
  it('该有的都有时,一条毛病都挑不出来', async () => {
    const h = harness()
    const got = await bootstrapPreflight({ io: h.io, paths: setupPaths({ home: h.home, repoRoot: h.repo }), repoRoot: h.repo })
    expect(got).toEqual([])
  })

  it('仓库路径不对时说的是「仓库」,不是一串 ENOENT', async () => {
    const h = harness({ repo: temp('wb-boot-empty-') })
    const got = await bootstrapPreflight({ io: h.io, paths: setupPaths({ home: h.home, repoRoot: h.repo }), repoRoot: h.repo })
    expect(got.join('\n')).toContain('workbench-plugin/package.json')
  })

  it('插件还没装依赖时,点名要跑 pnpm install,并且提到隔壁的 deepseek-harness', async () => {
    const repo = fullRepo()
    rmSync(`${repo}/workbench-plugin/node_modules`, { recursive: true, force: true })
    const h = harness({ repo })
    const got = await bootstrapPreflight({ io: h.io, paths: setupPaths({ home: h.home, repoRoot: repo }), repoRoot: repo })
    expect(got.join('\n')).toContain('pnpm install')
    expect(got.join('\n')).toContain('deepseek-harness')
  })

  it('plist 模板缺席时点名说哪一份', async () => {
    const repo = fullRepo()
    rmSync(`${repo}/deploy/ai.deepseek.dsh.plist`, { force: true })
    const h = harness({ repo })
    const got = await bootstrapPreflight({ io: h.io, paths: setupPaths({ home: h.home, repoRoot: repo }), repoRoot: repo })
    expect(got.join('\n')).toContain('ai.deepseek.dsh.plist')
  })
})

// ───────────────────────────── 六步真按顺序跑 ─────────────────────────────

describe('runBootstrap', () => {
  it('六步按顺序跑完,落盘的东西都在临时 HOME 里', async () => {
    const h = harness({ exec: { 'npm pack': { out: 'ben-dsh-workbench-0.2.36.tgz\n' } } })
    const got = await run(h, { skip: bootstrapSkip({ noLaunch: true }) })
    expect(got.ok).toBe(true)
    expect(got.done).toEqual(['node', 'runtime', 'profile', 'plugin', 'scripts', 'launchd'])

    const paths = setupPaths({ home: h.home, repoRoot: h.repo })
    for (const path of [paths.nodeBin, paths.profilePackageJson, paths.profilePatchYml, paths.dshStart, paths.butlerStart, paths.channelStart, paths.dshPlist]) {
      expect(readFileSync(path, 'utf8').length).toBeGreaterThan(0)
    }
    // 真实的家目录一个字都没碰:每条路径都在临时 HOME 下。
    expect(paths.dshPlist.startsWith(h.home)).toBe(true)
  })

  it('--no-launch 时一条 launchctl 都没真发出去,plist 照样写出来', async () => {
    const h = harness({ exec: { 'npm pack': { out: 'x.tgz\n' } } })
    await run(h, { skip: bootstrapSkip({ noLaunch: true }) })
    expect(h.calls.filter(c => c.cmd[0] === 'launchctl')).toHaveLength(0)
    expect(readFileSync(setupPaths({ home: h.home }).dshPlist, 'utf8')).toContain('ai.deepseek.dsh')
  })

  it('正常跑时只装载 DSH 那一项,事务官那一项写了 plist 但不装载', async () => {
    const h = harness({ exec: { 'npm pack': { out: 'x.tgz\n' } } })
    await run(h, { skip: bootstrapSkip({ noLaunch: false }) })
    const loaded = h.calls.filter(c => c.cmd[0] === 'launchctl').map(c => c.cmd.join(' '))
    expect(loaded).toHaveLength(1)
    expect(loaded[0]).toContain('ai.deepseek.dsh.plist')
    expect(loaded.join('\n')).not.toContain('butler')
  })

  it('写进 plist 的是临时 HOME,没有任何别人的私有值', async () => {
    const h = harness({ exec: { 'npm pack': { out: 'x.tgz\n' } } })
    await run(h, { steps: ['launchd'], skip: bootstrapSkip({ noLaunch: true }) })
    const paths = setupPaths({ home: h.home })
    expect(readFileSync(paths.dshPlist, 'utf8')).toContain(`${h.home}/.dsh/bin/dsh-start`)
    expect(readFileSync(paths.dshPlist, 'utf8')).not.toContain('{{HOME}}')
    // 事务官那份模板里写死着别人的家目录,渲染之后必须换掉。
    expect(readFileSync(paths.butlerPlist, 'utf8')).not.toContain('/Users/谁')
  })

  it('一步失败就停下,后面的步骤不跑,并且带着尾巴', async () => {
    const h = harness({ exec: { 'npm ci': { ok: false, code: 1, out: 'npm ERR! 网络超时\n' } } })
    const got = await run(h, { skip: bootstrapSkip({ noLaunch: true }) })
    expect(got.ok).toBe(false)
    expect(got.failed).toBe('runtime')
    expect(got.done).toEqual(['node'])
    // 「运行环境」是升 0.1.7(卡 U1)之后统一的说法 —— 给人看的字里不出现「运行时」。
    expect(got.error).toContain('DSH 运行环境')
    expect((got.tail ?? []).join('\n')).toContain('npm')
    // scripts 没轮到,所以 dsh-start 不该存在。
    await expect(h.io.stat(setupPaths({ home: h.home }).dshStart)).resolves.toBeUndefined()
  })

  it('兜底:node 那步自称成功、但装出来的 node 还是跑不起来时,当场停下(不让 npm 去报怪错)', async () => {
    const h = harness()
    const home = h.home
    const paths = setupPaths({ home, repoRoot: h.repo })
    // 先摆一份 node 在那儿,让安装那步走「已经有了」的近路(它自己探一次,回 24.19.0)。
    mkdirSync(dirname(paths.nodeBin), { recursive: true })
    writeFileSync(paths.nodeBin, '#!/bin/sh\n')
    let probes = 0
    const io: SetupIo = {
      ...h.io,
      exec: async (cmd, opts) => {
        if (cmd[0] !== paths.nodeBin) return h.io.exec(cmd, opts)
        probes += 1
        // 第一次是安装那步自己探的;第二次是引导的兜底 —— 让它在兜底这儿露馅。
        return probes === 1
          ? { ok: true, code: 0, out: '24.19.0\n' }
          : { ok: false, code: 1, out: 'dyld[9]: Library not loaded: @rpath/libnode.147.dylib\n' }
      },
    }
    const got = await runBootstrap({
      io,
      paths,
      repoRoot: h.repo,
      steps: ['node'],
      now: () => 0,
      newId: () => 'job-1',
      report: line => h.lines.push(line),
      pollMs: 2,
    })
    expect(got.ok).toBe(false)
    expect(got.failed).toBe('node')
    expect(got.done).toEqual([])
    expect(got.error).toContain('跑不起来')
    expect((got.tail ?? []).join('\n')).toContain('dyld')
  })

  it('每步都报一行人话进度', async () => {
    const h = harness({ exec: { 'npm pack': { out: 'x.tgz\n' } } })
    await run(h, { steps: ['profile', 'scripts'], skip: bootstrapSkip({ noLaunch: true }) })
    expect(h.lines.some(line => line.includes('profile') || line.includes('profile web'))).toBe(true)
    expect(h.lines.join('\n')).toContain('启动脚本')
  })

  it('可重复执行:同样的六步连跑两遍,第二遍照样成功', async () => {
    const h = harness({ exec: { 'npm pack': { out: 'x.tgz\n' } } })
    const first = await run(h, { skip: bootstrapSkip({ noLaunch: true }) })
    const before = readFileSync(setupPaths({ home: h.home }).profilePatchYml, 'utf8')
    const second = await run(h, { skip: bootstrapSkip({ noLaunch: true }) })
    expect(first.ok && second.ok).toBe(true)
    // 补丁层不该被追加第二遍。
    expect(readFileSync(setupPaths({ home: h.home }).profilePatchYml, 'utf8')).toBe(before)
  })
})

// ───────────────────────────── DSH_HOME 覆盖 ─────────────────────────────

describe('DSH_HOME 覆盖', () => {
  it('setupPaths 认它,~/.dsh 底下那一串跟着走', () => {
    const paths = setupPaths({ home: '/tmp/h', dshHome: '/tmp/d' })
    expect(paths.dshHome).toBe('/tmp/d')
    expect(paths.nodeBin).toBe('/tmp/d/node/bin/node')
    expect(paths.webStdoutLog).toBe('/tmp/d/logs/web.stdout.log')
    // 家目录那一串不跟着走:plist 只能装在 ~/Library/LaunchAgents。
    expect(paths.dshPlist).toBe('/tmp/h/Library/LaunchAgents/ai.deepseek.dsh.plist')
  })

  it('不传时还是 <home>/.dsh', () => {
    expect(setupPaths({ home: '/tmp/h' }).dshHome).toBe('/tmp/h/.dsh')
  })

  it('装出来的 dsh-start 里那一行也跟着改 —— 否则脚本一跑又回到 $HOME/.dsh', async () => {
    const h = harness()
    const paths = setupPaths({ home: h.home, dshHome: join(h.home, 'dsh-alt'), repoRoot: h.repo })
    const got = await runBootstrap({
      io: withSkippedCommands(h.io, bootstrapSkip({ noLaunch: true })),
      paths,
      repoRoot: h.repo,
      steps: ['scripts'],
      now: () => 0,
      newId: () => 'job-1',
      report: () => {},
      pollMs: 2,
    })
    expect(got.ok).toBe(true)
    expect(readFileSync(paths.dshStart, 'utf8')).toContain(`export DSH_HOME="${join(h.home, 'dsh-alt')}"`)
  })

  it('renderDshStart 不给 dshHome 时一个字不动那一行', () => {
    const text = 'export DSH_HOME="$HOME/.dsh"\nexport WORKBENCH_BUTLER_CWD="$HOME/x"\n'
    expect(renderDshStart(text, '/repo')).toContain('export DSH_HOME="$HOME/.dsh"')
    expect(renderDshStart(text, '/repo', '/tmp/d')).toContain('export DSH_HOME="/tmp/d"')
  })
})

// ───────────────────────────── 取那条带 token 的地址 ─────────────────────────────

describe('bootstrapSetupUrl', () => {
  it('从日志里捞最新那条,并补上 setup=1', async () => {
    const h = harness()
    const paths = setupPaths({ home: h.home })
    put(paths.webStdoutLog, [
      'listening: http://127.0.0.1:3080/?token=旧的',
      'restart',
      'listening: http://127.0.0.1:3080/?token=新的',
    ].join('\n'))
    const got = await bootstrapSetupUrl(h.io, paths)
    expect(got.ok).toBe(true)
    if (!got.ok) return
    expect(got.url).toBe('http://127.0.0.1:3080/?token=新的&setup=1')
  })

  it('日志还没有时说清楚该怎么办,而不是回一个空串', async () => {
    const h = harness()
    const got = await bootstrapSetupUrl(h.io, setupPaths({ home: h.home }))
    expect(got.ok).toBe(false)
    if (got.ok) return
    expect(got.error).toContain('web.stdout.log')
  })

  it('日志里没有 token 时另说一句(日志被轮转过)', async () => {
    const h = harness()
    const paths = setupPaths({ home: h.home })
    put(paths.webStdoutLog, '起来了,但这段日志里没有地址\n')
    const got = await bootstrapSetupUrl(h.io, paths)
    expect(got.ok).toBe(false)
    if (got.ok) return
    expect(got.error).toContain('token')
  })

  it('withSetupFlag 认已经有问号的地址,也不会加两遍', () => {
    expect(withSetupFlag('http://127.0.0.1:3080/?token=x')).toBe('http://127.0.0.1:3080/?token=x&setup=1')
    expect(withSetupFlag('http://127.0.0.1:3080/?token=x&setup=1')).toBe('http://127.0.0.1:3080/?token=x&setup=1')
    expect(withSetupFlag('http://127.0.0.1:3080/')).toBe('http://127.0.0.1:3080/?setup=1')
  })
})
