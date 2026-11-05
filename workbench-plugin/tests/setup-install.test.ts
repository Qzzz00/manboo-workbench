// @vitest-environment node
/**
 * 一键装(2026-09-17 登录台卡 A)。
 *
 * **这里一条命令都不会真跑**:exec 是注入的假的,用例断言的是「发出了什么命令、
 * 写了哪些文件、写进去的内容对不对」。文件确实会真写,但全部落在 mktemp 出来的临时
 * HOME 里 —— 所有路径都由 `setupPaths({ home })` 算出来,代码里没有一处 process.env.HOME。
 */
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createSetupInstaller, packedTarball, profilePackageJson, renderDshSettingsSeed, renderDshStart, renderPlist, renderProfilePatch, renderWelcomeNoticeAck, type SetupPrebuilt } from '../src/server/setup/install.ts'
import { readAgentDefaultModel, RELAY_STANDARD_MODELS, settingsForRelay } from '../src/server/dshModelSettings.ts'
import { nodeSetupIo, type SetupExecOptions, type SetupIo } from '../src/server/setup/io.ts'
import { setupPaths, DSH_UPSTREAM_DEFAULT_MODEL, DSH_WELCOME_NOTICE_VERSION, LOCKED_DSH_VERSION, NODE_TARBALL_SHA256, NODE_TARBALL_URL, NODE_TARBALL_URLS, SEEDED_DEFAULT_MODEL } from '../src/server/setup/paths.ts'
import type { SetupInstallStep, SetupJobView } from '../src/server/setup/types.ts'
import { DSH_RUNTIME_GUARD_PACKAGES, DSH_RUNTIME_LOCK, DSH_RUNTIME_PACKAGE } from '../src/server/setup/dshRuntimeLock.ts'
import { ROWS_OFF_FOR_USERS } from '../src/upstreamEntries.ts'
import { isNpmCi, seedLockedRuntime } from './setup/dshRuntimeFake.ts'
import { fakePnpmExec, seedOwnNpm } from './setup/pnpmFake.ts'

const NOW = Date.parse('2026-09-17T10:00:00Z')

/** 固定证书签出来的 requirement(认证书,重建不变);与 ad-hoc 那条(认 cdhash)对照。 */
const STABLE_SHELL_REQUIREMENT = 'designated => identifier "ai.ben.workbench" and certificate leaf = H"a8d72e0e41c85afb3c6d9aa79a3c06e70307583f"\n'
const ADHOC_SHELL_REQUIREMENT = '# designated => cdhash H"3fb3d1b090291e9422abc719a9145d1ba71a78e2"\n'
const dirs: string[] = []
afterEach(() => { while (dirs.length) rmSync(dirs.pop() as string, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }) })

function temp(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  dirs.push(dir)
  return dir
}

interface Harness {
  home: string
  repo: string
  /** 这台"机器"的那套路径(seedOwnNpm / 自带 pnpm 那几条断言要用)。 */
  paths: ReturnType<typeof setupPaths>
  /** 每一条发出去的命令(含 cwd),按顺序。 */
  calls: { cmd: readonly string[], cwd?: string, env?: Record<string, string> }[]
  run: (step: SetupInstallStep) => Promise<SetupJobView>
  io: SetupIo
  /** 假 `npm ci` 摆完文件之后再动一手(造"缺了一个包")。 */
  afterNpmCi?: (runtimeDir: string) => void
}

function harness(options: {
  /** 按 `argv[0] argv[1]` 查表决定成败;查不到默认成功。 */
  exec?: Record<string, { ok?: boolean, code?: number, out?: string }>
  repoRoot?: string | null
  currentNode?: string
  /** 假 `npm ci` 装出来的版本与锁文件不同的那几个包(造漂移)。 */
  runtimeOverrides?: Record<string, string>
  /** 预构建产物。运行时那一步用它里面的 `runtimeLockDir`(热更新那条路)。 */
  prebuilt?: SetupPrebuilt
} = {}): Harness {
  const home = temp('wb-setup-install-home-')
  const repo = temp('wb-setup-install-repo-')
  const calls: Harness['calls'] = []
  const pnpmPaths = setupPaths({ home })
  const io: SetupIo = {
    ...nodeSetupIo(),
    exec: async (cmd: readonly string[], opts?: SetupExecOptions) => {
      calls.push({
        cmd,
        ...(opts?.cwd === undefined ? {} : { cwd: opts.cwd }),
        ...(opts?.env === undefined ? {} : { env: opts.env }),
      })
      const key = [cmd[0], cmd[1]].filter(Boolean).join(' ')
      const hit = options.exec?.[key] ?? options.exec?.[cmd[0] ?? '']
      opts?.onLine?.(`(假的)${cmd.join(' ')}`)
      if (isNpmCi(cmd) && opts?.cwd !== undefined && (hit?.ok ?? true)) {
        seedLockedRuntime(opts.cwd, options.runtimeOverrides)
        self.afterNpmCi?.(opts.cwd)
      }
      // 自带 pnpm 那一段(卡 PN):查表里没点名的话,按"装上了"回答(见 tests/setup/pnpmFake.ts)。
      if (hit === undefined) {
        const pnpm = fakePnpmExec(pnpmPaths, cmd)
        if (pnpm !== undefined) return pnpm
      }
      return { ok: hit?.ok ?? true, code: hit?.code ?? 0, out: hit?.out ?? '' }
    },
    uid: () => 501,
    currentNodeBinary: () => options.currentNode ?? defaultNodeBinary(),
  }
  const repoRoot = options.repoRoot === null ? undefined : (options.repoRoot ?? repo)
  const installer = createSetupInstaller({
    io,
    paths: setupPaths({ home, ...(repoRoot === undefined ? {} : { repoRoot }), applicationsDir: join(home, 'Applications') }),
    ...(repoRoot === undefined ? {} : { repoRoot }),
    ...(options.prebuilt === undefined ? {} : { prebuilt: options.prebuilt }),
    now: () => NOW,
    newId: (() => { let n = 0; return () => `job-${++n}` })(),
  })
  const self: Harness = {
    home,
    repo,
    paths: pnpmPaths,
    calls,
    io,
    run: async (step) => {
      const job = installer.start(step)
      await installer.wait(job.id)
      return installer.job(job.id) as SetupJobView
    },
  }
  return self
}

/** 「这会儿跑着的那条 node」的替身:真建一个文件,不然 copyFile 无从复制。 */
let cachedNode: string | undefined
function defaultNodeBinary(): string {
  if (cachedNode === undefined) {
    cachedNode = join(temp('wb-setup-node-'), 'node')
    writeFileSync(cachedNode, '#!/bin/sh\n')
  }
  return cachedNode
}
afterEach(() => { cachedNode = undefined })

function seedRepo(repo: string): void {
  const write = (rel: string, text: string): void => {
    mkdirSync(join(repo, rel, '..'), { recursive: true })
    writeFileSync(join(repo, rel), text, 'utf8')
  }
  write('workbench-plugin/bin/dsh-start', '#!/usr/bin/env bash\nexport WORKBENCH_BUTLER_CWD="$HOME/Documents/GitHub/desktop-workbench"\n')
  write('workbench-plugin/bin/butler-start', '#!/usr/bin/env bash\n# butler\n')
  write('deploy/channel-start', '#!/usr/bin/env bash\n# channel\n')
  write('deploy/ai.deepseek.dsh.plist', '<plist><string>{{HOME}}/.dsh/bin/dsh-start</string></plist>')
  write('butler-server/launchd/ai.deepseek.butler.plist', '<plist><string>/Users/somebody/.dsh/bin/butler-start</string></plist>')
  write('butler-server/package.json', '{"name":"butler-server"}')
  write('butler-server/server/index.cjs', '// butler')
  write('butler-server/node_modules/x/index.js', '// dep')
  write('channel-worker/src/main.ts', '// worker')
  write('channel-worker/node_modules/@livekit/rtc-node/index.js', '// native')
  write('workbench-app/build.sh', '#!/bin/sh\n')
}

describe('一键装 · 作业机制', () => {
  it('start 立刻回一条 running 的作业,跑完变 done', async () => {
    const h = harness()
    seedOwnNpm(h.paths)
    const job = await h.run('node')
    expect(job.id).toBe('job-1')
    expect(job.step).toBe('node')
    expect(job.state).toBe('done')
    expect(job.started_at).toBe(new Date(NOW).toISOString())
    expect(job.finished_at).toBe(new Date(NOW).toISOString())
  })

  it('失败回人话 + 原始输出尾 20 行', async () => {
    const h = harness({ exec: { 'npm ci': { ok: false, code: 1, out: '' } } })
    const job = await h.run('runtime')
    expect(job.state).toBe('failed')
    expect(job.error).toContain('装 DSH 运行环境失败')
    expect(job.error).toContain('退出码 1')
    expect(job.tail.length).toBeGreaterThan(0)
    expect(job.tail.length).toBeLessThanOrEqual(20)
  })

  it('要仓库那几步在没配仓库时回一句能照做的话,而不是崩', async () => {
    const h = harness({ repoRoot: null })
    for (const step of ['plugin', 'scripts', 'launchd', 'shell', 'butler', 'worker'] as const) {
      const job = await h.run(step)
      expect(job.state, step).toBe('failed')
      expect(job.error, step).toContain('第 2 步')
    }
  })
})

describe('一键装 · 逐步', () => {
  it('node:把这会儿跑着的那条复制到 ~/.dsh/node/bin/node 并给执行位', async () => {
    const source = join(temp('wb-setup-src-'), 'node')
    writeFileSync(source, '#!/bin/sh\n')
    const h = harness({ currentNode: source })
    // npm 已经在那个目录里(stage0.sh 解开的官方独立包就是这样):复制那条路才走得通。
    seedOwnNpm(h.paths)
    const job = await h.run('node')
    expect(job.state).toBe('done')
    const target = join(h.home, '.dsh/node/bin/node')
    expect(readFileSync(target, 'utf8')).toBe('#!/bin/sh\n')
    expect(statSync(target).mode & 0o111).toBeTruthy()
  })

  /**
   * 2026-09-27(卡 PN 顺带修的第二个坑):只复制一条 node 二进制**不带 npm**,
   * 而下一步 `npm ci` 就是靠 `~/.dsh/node/bin` 里那条 npm(dshEnv 的 PATH 第一段)。
   * 一台没有 Homebrew 的机器上,这一步"成功"的结果是下一步死在「命令 `npm` 退出码 -1」。
   */
  it('node:复制过来跑得起来、但那个目录里没有 npm 时,改下官方独立包', async () => {
    const source = join(temp('wb-setup-src-'), 'node')
    writeFileSync(source, '#!/bin/sh\n')
    const h = harness({
      currentNode: source,
      exec: { shasum: { out: `${NODE_TARBALL_SHA256}  x.tar.gz\n` } },
    })
    const real = h.io.exec
    // 解包之后那次探测要能报出版本(假 tar 不会真摆出一棵 node 来)。
    h.io.exec = async (cmd, opts) => {
      const result = await real(cmd, opts)
      if (cmd[0] === join(h.home, '.dsh/node/bin/node')) return { ok: true, code: 0, out: '24.19.0\n' }
      if (cmd[0] === 'tar') seedOwnNpm(h.paths)
      return result
    }
    const job = await h.run('node')
    expect(job.state).toBe('done')
    // 真去下了官方独立包(curl + shasum + tar),而不是拿一棵缺 npm 的树交差。
    expect(h.calls.some(call => call.cmd[0] === 'curl')).toBe(true)
    expect(h.calls.some(call => call.cmd[0] === 'tar')).toBe(true)
    expect(job.tail.join('\n')).toContain('npm')
  })

  it('node:复制过来跑不起来时,改下官方独立包(核对 sha256 再解包)', async () => {
    const source = join(temp('wb-setup-src-'), 'node')
    writeFileSync(source, '#!/bin/sh\n')
    // 这就是裸机上的常态:Homebrew 的 node 单拎一个二进制出来,一跑就是 dyld 报错。
    const h = harness({
      currentNode: source,
      exec: {
        // 假 io 按 `argv[0] argv[1]` 查表;探测那条是 `<nodeBin> -p`。
        shasum: { out: `${NODE_TARBALL_SHA256}  x.tar.gz\n` },
      },
    })
    const nodeBin = join(h.home, '.dsh/node/bin/node')
    const real = h.io.exec
    let probes = 0
    h.io.exec = async (cmd, opts) => {
      if (cmd[0] === nodeBin) {
        probes += 1
        // 头一次(复制之后)跑不起来;解包之后那次跑得起来。
        return probes === 1
          ? { ok: false, code: 1, out: 'dyld[1]: Library not loaded: @rpath/libnode.147.dylib\n' }
          : { ok: true, code: 0, out: '24.19.0\n' }
      }
      return real(cmd, opts)
    }
    const job = await h.run('node')
    expect(job.state).toBe('done')
    const cmds = h.calls.map(call => call.cmd)
    // 第一条源就是国内镜像(NODE_TARBALL_URLS[0]);它成了就不会去试官方那条。
    expect(cmds.some(cmd => cmd[0] === 'curl' && cmd.includes(NODE_TARBALL_URLS[0] as string))).toBe(true)
    expect(cmds.some(cmd => cmd[0] === 'curl' && cmd.includes(NODE_TARBALL_URL))).toBe(false)
    expect(cmds.some(cmd => cmd[0] === 'shasum')).toBe(true)
    expect(cmds.some(cmd => cmd[0] === 'tar' && cmd.includes('--strip-components=1'))).toBe(true)
    expect(job.note).toContain('24.19.0')
  })

  it('node:镜像下不动就换下一条,最后落到官方那条', async () => {
    const source = join(temp('wb-setup-src-'), 'node')
    writeFileSync(source, '#!/bin/sh\n')
    const h = harness({ currentNode: source, exec: { shasum: { out: `${NODE_TARBALL_SHA256}  x.tar.gz\n` } } })
    const nodeBin = join(h.home, '.dsh/node/bin/node')
    const real = h.io.exec
    const curls: string[] = []
    let probes = 0
    h.io.exec = async (cmd, opts) => {
      if (cmd[0] === nodeBin) {
        probes += 1
        return probes === 1 ? { ok: false, code: 1, out: 'dyld: Library not loaded\n' } : { ok: true, code: 0, out: '24.19.0\n' }
      }
      if (cmd[0] === 'curl') {
        curls.push(cmd[cmd.length - 1] as string)
        // 除官方那条以外的源一律下不动。
        if (!cmd.includes(NODE_TARBALL_URL)) return { ok: false, code: 6, out: 'could not resolve host\n' }
      }
      return real(cmd, opts)
    }
    const job = await h.run('node')
    expect(job.state).toBe('done')
    expect(curls).toEqual([...NODE_TARBALL_URLS])
  })

  it('node:一条源都下不动时回一句人话,并且不解包', async () => {
    const source = join(temp('wb-setup-src-'), 'node')
    writeFileSync(source, '#!/bin/sh\n')
    const h = harness({ currentNode: source })
    const nodeBin = join(h.home, '.dsh/node/bin/node')
    const real = h.io.exec
    h.io.exec = async (cmd, opts) => {
      if (cmd[0] === nodeBin) return { ok: false, code: 1, out: 'dyld: Library not loaded\n' }
      if (cmd[0] === 'curl') return { ok: false, code: 6, out: 'could not resolve host\n' }
      return real(cmd, opts)
    }
    const job = await h.run('node')
    expect(job.state).toBe('failed')
    expect(job.error).toContain('没网')
    expect(h.calls.some(call => call.cmd[0] === 'tar')).toBe(false)
  })

  it('node:下下来的包对不上仓库里锁着的 sha256 就不解包,并且把坏包删掉', async () => {
    const source = join(temp('wb-setup-src-'), 'node')
    writeFileSync(source, '#!/bin/sh\n')
    const h = harness({ currentNode: source, exec: { shasum: { out: '假的哈希  x.tar.gz\n' } } })
    const nodeBin = join(h.home, '.dsh/node/bin/node')
    const real = h.io.exec
    h.io.exec = async (cmd, opts) => (cmd[0] === nodeBin
      ? { ok: false, code: 1, out: 'dyld: Library not loaded\n' }
      : real(cmd, opts))
    const job = await h.run('node')
    expect(job.state).toBe('failed')
    expect(job.error).toContain('sha256')
    expect(h.calls.some(call => call.cmd[0] === 'tar')).toBe(false)
    expect(existsSync(join(h.home, '.dsh/node.download'))).toBe(false)
  })

  it('node:已经有一份够新的就不重复复制(幂等)', async () => {
    const h = harness()
    const target = join(h.home, '.dsh/node/bin/node')
    mkdirSync(join(h.home, '.dsh/node/bin'), { recursive: true })
    writeFileSync(target, 'old')
    seedOwnNpm(h.paths)
    h.io.exec = async () => ({ ok: true, code: 0, out: '24.19.0\n' })
    const job = await h.run('node')
    expect(job.state).toBe('done')
    expect(job.note).toContain('不用换')
    expect(readFileSync(target, 'utf8')).toBe('old')
  })

  it('runtime:npm ci 跑在 runtime-next 里,装完换名成 runtime(不再 npm i 按 ^ 范围现解析)', async () => {
    const h = harness()
    const job = await h.run('runtime')
    expect(job.state).toBe('done')
    const npm = h.calls.filter(call => call.cmd[0] === 'npm')
    // 只有一条 npm:三个 client 包已经在锁文件里,第二条 `npm i` 会把漂移再解析一次。
    expect(npm).toHaveLength(1)
    expect(npm[0]?.cmd[1]).toBe('ci')
    expect(npm[0]?.cmd.join(' ')).not.toContain('@deepseek-ai/dsh@')
    // 网络慢要能续:这两个参数是 0907 实测加上的。
    expect(npm[0]?.cmd).toContain('--fetch-timeout=300000')
    expect(npm[0]?.cmd).toContain('--fetch-retries=5')
    // **装在暂存目录里**(2026-09-25):npm ci 的第一件事是清 node_modules,断在半路不许
    // 弄坏这会儿在用的那一份。
    expect(npm[0]?.cwd).toBe(join(h.home, '.dsh/runtime-next'))
    expect(npm[0]?.env?.DSH_HOME).toBe(join(h.home, '.dsh'))
    // 换名之后:清单落在 runtime 里,暂存目录没了。
    const lock = JSON.parse(readFileSync(join(h.home, '.dsh/runtime/package-lock.json'), 'utf8'))
    expect(lock).toEqual(DSH_RUNTIME_LOCK)
    expect(lock.packages['node_modules/@deepseek-ai/dsh'].version).toBe(LOCKED_DSH_VERSION)
    const pkg = JSON.parse(readFileSync(join(h.home, '.dsh/runtime/package.json'), 'utf8'))
    expect(pkg).toEqual(DSH_RUNTIME_PACKAGE)
    expect(existsSync(join(h.home, '.dsh/runtime-next'))).toBe(false)
    // 新机器上本来没有旧 runtime,所以不会凭空多出一个 runtime-prev。
    expect(existsSync(join(h.home, '.dsh/runtime-prev'))).toBe(false)
  })

  it('runtime:已经在用的机器上,旧那份换名留成 runtime-prev(回滚的材料)', async () => {
    const h = harness()
    const old = join(h.home, '.dsh/runtime')
    mkdirSync(old, { recursive: true })
    writeFileSync(join(old, '认得出来这是旧那份.txt'), '0.1.2 那一份')
    const job = await h.run('runtime')
    expect(job.state).toBe('done')
    expect(readFileSync(join(h.home, '.dsh/runtime-prev/认得出来这是旧那份.txt'), 'utf8')).toBe('0.1.2 那一份')
    // 新那份换上去了,旧那份的文件不会跟着过来。
    expect(existsSync(join(old, '认得出来这是旧那份.txt'))).toBe(false)
    expect(JSON.parse(readFileSync(join(old, 'package-lock.json'), 'utf8'))).toEqual(DSH_RUNTIME_LOCK)
    expect(job.tail.join('\n')).toContain('runtime-prev')
  })

  it('runtime:上一次升级留下的 runtime-prev 会让位,不会越堆越多', async () => {
    const h = harness()
    mkdirSync(join(h.home, '.dsh/runtime'), { recursive: true })
    mkdirSync(join(h.home, '.dsh/runtime-prev'), { recursive: true })
    writeFileSync(join(h.home, '.dsh/runtime-prev/上上一版.txt'), '更早那一份')
    expect((await h.run('runtime')).state).toBe('done')
    expect(existsSync(join(h.home, '.dsh/runtime-prev/上上一版.txt'))).toBe(false)
  })

  it('runtime:npm ci 装出来的关键包跟锁文件对不上 → 失败、说清哪个包,而且不换名', async () => {
    const h = harness({ runtimeOverrides: { '@deepseek-ai/dsh-hmr': '0.1.2-rc.1', '@deepseek-ai/cordis': '4.0.2' } })
    const old = join(h.home, '.dsh/runtime')
    mkdirSync(old, { recursive: true })
    writeFileSync(join(old, '还在用的那一份.txt'), '别动我')
    const job = await h.run('runtime')
    expect(job.state).toBe('failed')
    expect(job.error).toContain('@deepseek-ai/dsh-hmr')
    expect(job.error).toContain(LOCKED_DSH_VERSION)
    expect(job.error).toContain('0.1.2-rc.1')
    expect(job.error).toContain('@deepseek-ai/cordis ')
    // **核版本在换名之前**:这会儿在用的那一份一个字节没动。
    expect(readFileSync(join(old, '还在用的那一份.txt'), 'utf8')).toBe('别动我')
    expect(existsSync(join(h.home, '.dsh/runtime-prev'))).toBe(false)
  })

  it('runtime:关键包缺了一个也算没装好', async () => {
    const h = harness()
    h.afterNpmCi = dir => rmSync(join(dir, 'node_modules/@deepseek-ai/dsh-hmr'), { recursive: true, force: true })
    const job = await h.run('runtime')
    expect(job.state).toBe('failed')
    expect(job.error).toContain('@deepseek-ai/dsh-hmr')
    expect(job.error).toContain('没装上')
  })

  /**
   * 热更新换 DSH 版本靠的就是这一条。
   *
   * 跑更新作业的是**旧那份插件的进程**,它 `import` 进来的锁定清单永远是旧版本的 ——
   * 所以新清单必须从下下来的 `runtime_tgz` 里解出来、由 `prebuilt.runtimeLockDir` 交进来。
   * 这一条要是退化成"还是用编进来那份",界面会说升级成功,而 DSH 一个字节没换。
   */
  it('runtime:热更新带来的新清单压过插件里编着的那份旧清单', async () => {
    const FAKE = '9.9.9-来自更新包'
    const dir = temp('wb-update-runtime-lock-')
    const nextLock = JSON.parse(JSON.stringify(DSH_RUNTIME_LOCK)) as { packages: Record<string, { version?: string }> }
    const overrides: Record<string, string> = {}
    for (const name of DSH_RUNTIME_GUARD_PACKAGES) {
      const entry = nextLock.packages[`node_modules/${name}`]
      if (entry !== undefined) entry.version = FAKE
      overrides[name] = FAKE
    }
    writeFileSync(join(dir, 'runtime.package.json'), JSON.stringify({ dependencies: { '@deepseek-ai/dsh': `^${FAKE}` } }))
    writeFileSync(join(dir, 'runtime.package-lock.json'), JSON.stringify(nextLock))

    // runtimeOverrides:假 npm ci 照"新清单"装出来那几个版本(不然守卫会判它漂了)。
    const h = harness({ prebuilt: { runtimeLockDir: dir }, runtimeOverrides: overrides })
    const job = await h.run('runtime')
    expect(job.state).toBe('done')
    expect(job.note).toContain(FAKE)
    // 写进去的是**更新包那一份**,不是插件里编着的那一份。
    const written = JSON.parse(readFileSync(join(h.home, '.dsh/runtime/package-lock.json'), 'utf8'))
    expect(written.packages['node_modules/@deepseek-ai/dsh'].version).toBe(FAKE)
    expect(written).not.toEqual(DSH_RUNTIME_LOCK)
  })

  it('runtime:更新包里的清单读不通 → 这一步失败,绝不悄悄退回旧清单', async () => {
    const dir = temp('wb-bad-runtime-lock-')
    writeFileSync(join(dir, 'runtime.package.json'), '{}')
    writeFileSync(join(dir, 'runtime.package-lock.json'), '这不是 JSON')
    const h = harness({ prebuilt: { runtimeLockDir: dir } })
    const job = await h.run('runtime')
    expect(job.state).toBe('failed')
    expect(job.error).toContain('runtime.package-lock.json')
    expect(job.error).toContain('更新包')
    // 一条 npm 都没跑过:清单读不通就该停在动手之前。
    expect(h.calls.filter(call => call.cmd[0] === 'npm')).toHaveLength(0)
  })

  it('runtime:更新包里少了一份清单 → 同样失败(不拿另一份凑)', async () => {
    const dir = temp('wb-half-runtime-lock-')
    writeFileSync(join(dir, 'runtime.package.json'), JSON.stringify({ dependencies: {} }))
    const h = harness({ prebuilt: { runtimeLockDir: dir } })
    const job = await h.run('runtime')
    expect(job.state).toBe('failed')
    expect(job.error).toContain('runtime.package-lock.json')
    expect(h.calls.filter(call => call.cmd[0] === 'npm')).toHaveLength(0)
  })

  it('runtime:已经按这份锁定清单装好、版本都对 → 不再跑 npm(幂等)', async () => {
    const h = harness()
    expect((await h.run('runtime')).state).toBe('done')
    const before = h.calls.length
    const again = await h.run('runtime')
    expect(again.state).toBe('done')
    expect(again.note).toContain('不用装')
    expect(h.calls.length).toBe(before)
  })

  it('runtime:目录里是一份漂移过的旧装(锁文件不一样)→ 覆盖清单重装', async () => {
    const h = harness()
    const dir = join(h.home, '.dsh/runtime')
    seedLockedRuntime(dir, { '@deepseek-ai/cordis-plugin-hmr': '1.0.19' })
    writeFileSync(join(dir, 'package-lock.json'), '{"lockfileVersion":3,"packages":{}}')
    const job = await h.run('runtime')
    expect(job.state).toBe('done')
    expect(h.calls.filter(call => call.cmd[0] === 'npm' && call.cmd[1] === 'ci')).toHaveLength(1)
    expect(JSON.parse(readFileSync(join(dir, 'package-lock.json'), 'utf8'))).toEqual(DSH_RUNTIME_LOCK)
  })

  it('profile:建目录 + 写 package.json + 补丁层带 insert 与 cookie 寿命', async () => {
    const h = harness()
    await h.run('profile')
    const patch = readFileSync(join(h.home, '.dsh/profiles/web/cordis.patch.yml'), 'utf8')
    expect(patch).toContain('ben-workbench')
    expect(patch).toContain('cookieMaxAgeDays')
    expect(JSON.parse(readFileSync(join(h.home, '.dsh/profiles/web/package.json'), 'utf8')).name).toBe('dsh-profile-web')
  })

  it('profile:已有的补丁层只补缺的那块,别人的补丁一字不动', async () => {
    const h = harness()
    const file = join(h.home, '.dsh/profiles/web/cordis.patch.yml')
    mkdirSync(join(h.home, '.dsh/profiles/web'), { recursive: true })
    writeFileSync(file, '- id: dsh-context\n  config:\n    x: 1\n')
    await h.run('profile')
    const patch = readFileSync(file, 'utf8')
    expect(patch).toContain('dsh-context')
    expect(patch).toContain('ben-workbench')
    // 第二次跑不该再改动它(幂等)。
    const job = await h.run('profile')
    expect(job.note).toContain('不用改')
    expect(readFileSync(file, 'utf8')).toBe(patch)
  })

  it('plugin:build → pack → plugin add,全在仓库里执行', async () => {
    const h = harness({ exec: { 'npm pack': { ok: true, out: 'npm notice\nben-dsh-workbench-0.2.35.tgz\n' } } })
    const job = await h.run('plugin')
    expect(job.state).toBe('done')
    expect(h.calls[0]?.cmd).toEqual(['pnpm', 'build'])
    expect(h.calls[0]?.cwd).toBe(join(h.repo, 'workbench-plugin'))
    expect(h.calls[1]?.cmd).toEqual(['npm', 'pack', '--pack-destination', join(h.home, '.dsh/packages')])
    // `plugin add` 前面还有自带 pnpm 那几条命令(卡 PN),所以按内容找那一条,不按下标。
    const addCall = h.calls.find(call => call.cmd.includes('plugin') && call.cmd.includes('add'))
    const add = addCall?.cmd.join(' ') ?? ''
    expect(add).toContain('plugin --profile web add')
    expect(add).toContain('ben-dsh-workbench-0.2.35.tgz')
    expect(addCall?.cwd).toBe(join(h.repo, 'workbench-plugin'))
  })

  it('plugin:pack 的输出里认不出 tgz 就如实失败,不硬拼一个名字', async () => {
    const h = harness({ exec: { 'npm pack': { ok: true, out: 'npm notice 什么都没有\n' } } })
    const job = await h.run('plugin')
    expect(job.state).toBe('failed')
    expect(job.error).toContain('.tgz')
  })

  it('scripts:三个脚本 755,dsh-start 里的仓库路径换成本机的', async () => {
    const h = harness()
    seedRepo(h.repo)
    const job = await h.run('scripts')
    expect(job.state).toBe('done')
    const dshStart = readFileSync(join(h.home, '.dsh/bin/dsh-start'), 'utf8')
    expect(dshStart).toContain(`export WORKBENCH_BUTLER_CWD="${h.repo}"`)
    expect(dshStart).not.toContain('$HOME/Documents/GitHub/desktop-workbench')
    for (const name of ['dsh-start', 'butler-start', 'channel-start']) {
      expect(statSync(join(h.home, '.dsh/bin', name)).mode & 0o111, name).toBeTruthy()
    }
  })

  it('scripts:仓库(或安装器 payload)里有手机包就带到数据目录,没有不算失败(2026-09-18)', async () => {
    const h = harness()
    seedRepo(h.repo)
    const without = await h.run('scripts')
    expect(without.state).toBe('done')
    expect(existsSync(join(h.home, '.dsh/workbench/apk/app-debug.apk'))).toBe(false)

    mkdirSync(join(h.repo, 'butler-app/android/app/build/outputs/apk/debug'), { recursive: true })
    writeFileSync(join(h.repo, 'butler-app/android/app/build/outputs/apk/debug/app-debug.apk'), 'PK-fake-apk', 'utf8')
    const withApk = await h.run('scripts')
    expect(withApk.state).toBe('done')
    expect(readFileSync(join(h.home, '.dsh/workbench/apk/app-debug.apk'), 'utf8')).toBe('PK-fake-apk')
  })

  it('launchd:两份 plist 渲染成本机路径并 bootstrap;已装载过不算失败', async () => {
    const h = harness({ exec: { 'launchctl bootstrap': { ok: false, code: 5, out: 'service already loaded' } } })
    seedRepo(h.repo)
    const job = await h.run('launchd')
    expect(job.state).toBe('done')
    const dsh = readFileSync(join(h.home, 'Library/LaunchAgents/ai.deepseek.dsh.plist'), 'utf8')
    expect(dsh).toContain(`${h.home}/.dsh/bin/dsh-start`)
    expect(dsh).not.toContain('{{HOME}}')
    const butler = readFileSync(join(h.home, 'Library/LaunchAgents/ai.deepseek.butler.plist'), 'utf8')
    // 仓库里那份是照本机写死的(带着别人的家目录),渲染时要把家目录前缀换掉。
    expect(butler).toContain(`${h.home}/.dsh/bin/butler-start`)
    expect(butler).not.toContain('/Users/somebody')
  })

  it('launchd:bootstrap 真失败(不是"已装载")就报错', async () => {
    const h = harness({ exec: { 'launchctl bootstrap': { ok: false, code: 112, out: 'Operation not permitted' } } })
    seedRepo(h.repo)
    const job = await h.run('launchd')
    expect(job.state).toBe('failed')
    expect(job.error).toContain('ai.deepseek.dsh')
  })

  it('shell:build.sh 之后 ditto 到 /Applications', async () => {
    const h = harness({ exec: { 'codesign -d': { out: STABLE_SHELL_REQUIREMENT } } })
    seedRepo(h.repo)
    const job = await h.run('shell')
    expect(job.state).toBe('done')
    expect(h.calls[0]?.cmd).toEqual([join(h.repo, 'workbench-app/build.sh')])
    expect(h.calls[1]?.cmd).toEqual(['ditto', join(h.repo, 'workbench-app/build/工作台.app'), join(h.home, 'Applications/工作台.app')])
  })

  // 下面三条盯的是同一件事:装完那句话要**问装出来的那份壳自己**,而不是照本宣科。
  // 判据是 `codesign -d -r -` 给的 designated requirement —— TCC 认的就是它。
  it('shell:签名认证书 → 说"这次更新不会掉授权"', async () => {
    const h = harness({ exec: { 'codesign -d': { out: STABLE_SHELL_REQUIREMENT } } })
    seedRepo(h.repo)
    const job = await h.run('shell')
    expect(h.calls.some(call => call.cmd[0] === 'codesign' && call.cmd.includes('-r'))).toBe(true)
    expect(job.note).toContain('不会因为这次更新失效')
    expect(job.note).not.toContain('关一次再开')
  })

  it('shell:签名是 cdhash(ad-hoc) → 照直说要去系统设置里关一次再开', async () => {
    const h = harness({ exec: { 'codesign -d': { out: ADHOC_SHELL_REQUIREMENT } } })
    seedRepo(h.repo)
    const job = await h.run('shell')
    expect(job.note).toContain('关一次再开')
    expect(job.note).toContain('codesign-identity.sh')
  })

  it('shell:codesign 读不出来 → 不猜,说读不出来', async () => {
    const h = harness({ exec: { 'codesign -d': { ok: false, code: 1, out: 'code object is not signed at all' } } })
    seedRepo(h.repo)
    const job = await h.run('shell')
    expect(job.state).toBe('done')
    expect(job.note).toContain('读不出')
  })

  it('butler:三块 rsync 过去 + package.json,启动脚本读的结构对得上', async () => {
    const h = harness()
    seedRepo(h.repo)
    const job = await h.run('butler')
    expect(job.state).toBe('done')
    const rsynced = h.calls.filter(call => call.cmd[0] === 'rsync').map(call => call.cmd[3])
    expect(rsynced).toContain(join(h.repo, 'butler-server/server/'))
    expect(rsynced).toContain(join(h.repo, 'butler-server/node_modules/'))
    expect(readFileSync(join(h.home, '.dsh/butler-server/package.json'), 'utf8')).toContain('butler-server')
    // 2026-09-25(卡 S):换完代码当场让 launchd 重起它 —— 不然正在跑的还是老代码,要等下次开机。
    const last = h.calls[h.calls.length - 1]?.cmd
    expect(last).toEqual(['launchctl', 'kickstart', '-k', 'gui/501/ai.deepseek.butler'])
    expect(job.note).toContain('已按新代码重启')
  })

  it('butler:新机器上 launchd 项还没装,重启不了不算失败(装开机自启那一步会把它起来)', async () => {
    const h = harness({ exec: { 'launchctl kickstart': { ok: false, code: 113, out: 'Could not find service' } } })
    seedRepo(h.repo)
    const job = await h.run('butler')
    expect(job.state).toBe('done')
    expect(job.note).toContain('开机自启那一步会把事务官后端起来')
  })

  it('worker:仓库里没装原生依赖就不给同步,回一句照着做的话', async () => {
    const h = harness()
    seedRepo(h.repo)
    rmSync(join(h.repo, 'channel-worker/node_modules'), { recursive: true, force: true })
    const job = await h.run('worker')
    expect(job.state).toBe('failed')
    expect(job.error).toContain('pnpm install')
    expect(h.calls.filter(call => call.cmd[0] === 'rsync')).toHaveLength(0)
  })

  it('worker:依赖在就整目录同步(带 node_modules)', async () => {
    const h = harness()
    seedRepo(h.repo)
    const job = await h.run('worker')
    expect(job.state).toBe('done')
    expect(h.calls[0]?.cmd).toEqual(['rsync', '-a', '--delete', join(h.repo, 'channel-worker/'), join(h.home, '.dsh/channel-worker/')])
  })

  it('web_login:从日志读最新 token 回地址,而且 token 不进日志尾巴', async () => {
    const h = harness()
    mkdirSync(join(h.home, '.dsh/logs'), { recursive: true })
    writeFileSync(join(h.home, '.dsh/logs/web.stdout.log'), 'dsh web: http://127.0.0.1:3080/?token=old\ndsh web: http://127.0.0.1:3080/?token=新的\n')
    const job = await h.run('web_login')
    expect(job.state).toBe('done')
    expect(job.url).toBe('http://127.0.0.1:3080/?token=新的')
    expect(job.tail.join('\n')).not.toContain('token=')
  })

  it('web_login:日志里没有 token 就如实说,并告诉他去点重启', async () => {
    const h = harness()
    mkdirSync(join(h.home, '.dsh/logs'), { recursive: true })
    writeFileSync(join(h.home, '.dsh/logs/web.stdout.log'), '什么都没有\n')
    const job = await h.run('web_login')
    expect(job.state).toBe('failed')
    expect(job.error).toContain('重启')
  })

  it('restart:kickstart 那条命令,uid 用注入的', async () => {
    const h = harness()
    const job = await h.run('restart')
    expect(job.state).toBe('done')
    expect(h.calls[0]?.cmd).toEqual(['launchctl', 'kickstart', '-k', 'gui/501/ai.deepseek.dsh'])
  })
})

describe('一键装 · 那几个纯函数', () => {
  it('renderDshStart 只换那一行', () => {
    const text = 'a\nexport WORKBENCH_BUTLER_CWD="$HOME/x"\nb\n'
    expect(renderDshStart(text, '/repo')).toBe('a\nexport WORKBENCH_BUTLER_CWD="/repo"\nb\n')
    expect(renderDshStart('没有这一行\n', '/repo')).toBe('没有这一行\n')
  })

  it('renderPlist 认 {{HOME}} 占位,也认写死的家目录前缀', () => {
    expect(renderPlist('<string>{{HOME}}/.dsh/x</string>', '/tmp/h')).toBe('<string>/tmp/h/.dsh/x</string>')
    expect(renderPlist('<string>/Users/谁/.dsh/x</string>', '/tmp/h')).toBe('<string>/tmp/h/.dsh/x</string>')
    // 不是路径的 <string> 一个字不动。
    expect(renderPlist('<string>ai.deepseek.dsh</string>', '/tmp/h')).toBe('<string>ai.deepseek.dsh</string>')
  })

  it('renderProfilePatch 缺什么补什么,补齐之后再跑一次不变', () => {
    const once = renderProfilePatch(undefined)
    expect(once).toContain('ben-workbench')
    expect(once).toContain('cookieMaxAgeDays')
    expect(renderProfilePatch(once)).toBe(once)
  })

  /**
   * 升 0.1.7 时对用户关掉的五条上游新入口(决策记录 2026-09-26 凌晨「关闭清单再定」;
   * 卡 U4 合并时把 U1 那四条与 U2 的 `ui-shortcuts` 并成一份,清单本体在 `src/upstreamEntries.ts`)。
   *
   * 逐条钉住 **id + `disabled: true`、而且不带 `name` / `config`**:补丁层会**整体替换该行的
   * config**,多写一个 `config:` 就等于把上游那一行的配置抹掉;写了 `name` 又变成"新插一行",
   * 不是"关掉下层那一行"。这几行的形状本身就是机制。
   */
  it('renderProfilePatch 把五条上游新入口关掉(id + disabled,不带 name / config)', () => {
    const patch = renderProfilePatch(undefined)
    for (const id of ['ui-sidebar-terminal', 'terminal-controller', 'ui-shortcuts', 'ui-plugin-manager', 'ui-settings-account']) {
      expect(patch, id).toContain(`- id: ${id}\n  disabled: true\n`)
      expect(patch, id).not.toContain(`- id: ${id}\n  name:`)
      expect(patch, id).not.toContain(`- id: ${id}\n  config:`)
    }
    // 有意留着的:文档预览、文件、改动那几样一行都不加(评估第四节)。
    expect(patch).not.toContain('ui-sidebar-documentpreview')
    expect(patch).not.toContain('ui-sidebar-files')
    expect(patch).not.toContain('ui-deliverables')
    // 定时任务与时间上下文**保持上游默认**(上游自己就写着 disabled: true),我们不重复一遍。
    expect(patch).not.toContain('- id: schedule')
    expect(patch).not.toContain('- id: ui-schedule')
    expect(patch).not.toContain('- id: time-context')
    // 侧边栏浏览器上游在非 desktop profile 上本来就关。
    expect(patch).not.toContain('ui-sidebar-browser')
    // ★ 命令注册表 `shortcuts` 不许被顺手关掉:它与要关的 `ui-shortcuts` 差三个字,
    // 关了 `ui-settings-general` 就注册不上「打开设置」,设置入口一起坏。
    expect(patch).not.toContain('- id: shortcuts\n')
    // 只读的插件清单页留着(插件管理页关了,「我这台装了什么」仍看得到)。
    expect(patch).not.toContain('ui-settings-plugin-inventory')
  })

  /**
   * ★ 清单只有一份:patch 里关掉的那几行,与带守门的那张表(`src/upstreamEntries.ts`,
   * 守门 `tests/client-upstream-seats.test.ts` 把每个 id 拿去跟上游真组合对过)必须逐字一致。
   *
   * 为什么要这一条:U1 与 U2 各自列过一份清单(四条 / 三条,内容不一样),两份并成一份之后
   * 最容易复发的错就是「有人在 install.ts 里手写一行」—— 那一行绕过了守门,id 打错字也没人拦,
   * 结果是终端照样开着而界面上一切正常。
   */
  it('★关掉的行就是 upstreamEntries 那张表里的 ROWS_OFF_FOR_USERS,一个不多一个不少', () => {
    const patch = renderProfilePatch(undefined)
    const inPatch = [...patch.matchAll(/^- id: (\S+)\n {2}disabled: true$/gm)].map(m => m[1]!)
    expect(inPatch).toEqual([...ROWS_OFF_FOR_USERS])
  })

  it('renderProfilePatch:维护者删掉某一行(他要用终端)之后,不会被下一次一键装塞回去', () => {
    const once = renderProfilePatch(undefined)
    // 他自己把终端那两行删了。
    const edited = once.replace('- id: ui-sidebar-terminal\n  disabled: true\n', '')
    const again = renderProfilePatch(edited)
    expect(again).toBe(edited)
    expect(again).not.toContain('- id: ui-sidebar-terminal')
    // 别的三条还在(他删的只是那一条)。
    expect(again).toContain('- id: ui-plugin-manager')
  })

  it('renderProfilePatch:别人写的补丁一个字不动(只往后追加)', () => {
    const mine = '# 我自己的补丁\n- id: dsh-context\n  config:\n    a: 1\n'
    const out = renderProfilePatch(mine)
    expect(out.startsWith(mine)).toBe(true)
    expect(out).toContain('ben-workbench')
    expect(out).toContain('- id: ui-settings-account')
  })

  it('packedTarball 从 npm pack 的一堆废话里挑出 tgz', () => {
    expect(packedTarball('npm notice\nnpm notice name: x\nben-dsh-workbench-0.2.35.tgz\n')).toBe('ben-dsh-workbench-0.2.35.tgz')
    expect(packedTarball('什么都没有')).toBeUndefined()
  })

  it('profilePackageJson 是 dsh-profile-web 且带两个 bundle;不再写 0.1.7 已经不读的 patchReload', () => {
    const parsed = JSON.parse(profilePackageJson()) as { dsh: { profile: { bundles: string[], patchReload?: string } } }
    expect(parsed.dsh.profile.bundles).toEqual(['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'])
    // 0.1.7 一处都不读它(热重载改由组合里的 dsh-hmr 决定)。留着不报错,但会骗人。
    expect(parsed.dsh.profile.patchReload).toBeUndefined()
  })

  /**
   * 播给新机器的默认模型必须是**我们中转认的那个 id**。
   *
   * 0.1.2 那会儿上游缺省恰好也叫 `deepseek-v4-flash`,于是"照上游播"与"播一个中转认的"是同一件事;
   * 0.1.7 上游改叫 `deepseek-flash`,照抄上游就会给新机器播一个中转不认的名字 ——
   * 他第一次说话就 UNKNOWN_MODEL。这一条把两者的区别钉住。
   */
  it('播种的默认模型在中转的模型表里;上游缺省那个常量只是"上游是什么"这句事实', () => {
    expect(RELAY_STANDARD_MODELS).toContain(SEEDED_DEFAULT_MODEL)
    expect(DSH_UPSTREAM_DEFAULT_MODEL.model).toBe('deepseek-flash')
    expect(RELAY_STANDARD_MODELS).not.toContain(DSH_UPSTREAM_DEFAULT_MODEL.model)
    expect(readAgentDefaultModel(renderDshSettingsSeed(undefined, 'https://api.aibooo.cn').text)?.model).toBe(SEEDED_DEFAULT_MODEL)
  })
})

describe('DSH settings.yaml 播种(2026-09-23 从零重装验收)', () => {
  const ACK = `  welcomeNoticeVersion: ${DSH_WELCOME_NOTICE_VERSION}`

  it('内测声明:文件不在就建一段', () => {
    expect(renderWelcomeNoticeAck(undefined)).toBe(`ui-onboarding:\n${ACK}\n`)
    expect(DSH_WELCOME_NOTICE_VERSION).toBe('2026-08-13.1')
  })

  it('内测声明:没有这段就插在文件头,别的段一个字不动', () => {
    const before = 'agent-default-model:\n  provider: x\n  model: y\n'
    expect(renderWelcomeNoticeAck(before)).toBe(`ui-onboarding:\n${ACK}\n${before}`)
  })

  it('内测声明:有段没这个键就补一行;值旧了就改;已经对了原样返回', () => {
    const other = 'ui-onboarding:\n  somethingElse: 1\nllm-pi-ai:\n  providers: {}\n'
    expect(renderWelcomeNoticeAck(other)).toBe(`ui-onboarding:\n${ACK}\n  somethingElse: 1\nllm-pi-ai:\n  providers: {}\n`)
    const old = 'x: 1\nui-onboarding:\n  welcomeNoticeVersion: 2026-01-01.1\n'
    expect(renderWelcomeNoticeAck(old)).toBe(`x: 1\nui-onboarding:\n${ACK}\n`)
    const done = `ui-onboarding:\n${ACK}\n`
    expect(renderWelcomeNoticeAck(done)).toBe(done)
  })

  it('内测声明:行内写法不去碰(宁可多弹一次框,不弄坏别人的设置)', () => {
    const inline = 'ui-onboarding: {other: 1}\n'
    expect(renderWelcomeNoticeAck(inline)).toBe(inline)
  })

  it('零服务器档(构建不带中转、model.json 也没填):只补声明,模型那段留给 DSH 自己问(用自己的 Key)', () => {
    const out = renderDshSettingsSeed(undefined)
    expect(out.text).toBe(`ui-onboarding:\n${ACK}\n`)
    expect(readAgentDefaultModel(out.text)).toBeUndefined()
    expect(out.text).not.toContain('llm-pi-ai')
    expect(out.changes).toHaveLength(1)
  })

  it('新装(我们的构建,带着中转):声明确认 + 默认走中转,与模型面板那条 settingsForRelay 逐字一致', () => {
    const out = renderDshSettingsSeed(undefined, 'https://api.aibooo.cn')
    expect(out.text).toContain(ACK)
    expect(readAgentDefaultModel(out.text)).toEqual({ provider: 'workbench-relay', model: 'deepseek-v4-flash' })
    expect(out.text).toContain('apiKeyEnv: WORKBENCH_RELAY_TOKEN')
    expect(out.text).toContain('baseURL: https://api.aibooo.cn/v1')
    expect(out.text).toContain('# managed-by: workbench-model-panel')
    // 登录之后模型面板再跑一次同一个函数:一个字都不用改(changed=false),不会触发备份与改写。
    const again = settingsForRelay(out.text, { baseUrl: 'https://api.aibooo.cn/v1' })
    expect(again).toMatchObject({ ok: true, changed: false })
    expect(out.changes).toHaveLength(2)
    // 幂等:再播一次什么都不变。
    expect(renderDshSettingsSeed(out.text, 'https://api.aibooo.cn')).toEqual({ text: out.text, changes: [] })
  })

  it('自建中转(model.json 里另填了 relay_url):播种指向那一台,不写死官方地址(2026-10-21)', () => {
    const out = renderDshSettingsSeed(undefined, 'https://relay.example.test')
    expect(out.text).toContain('baseURL: https://relay.example.test/v1')
    expect(out.text).not.toContain('api.aibooo.cn')
  })

  it('已经选过模型(有 agent-default-model 段)→ 模型那段不动,只补声明', () => {
    const mine = 'agent-default-model:\n  provider: deepseek-official\n  model: deepseek-v4-pro\n'
    const out = renderDshSettingsSeed(mine)
    expect(out.text).toBe(`ui-onboarding:\n${ACK}\n${mine}`)
    expect(out.text).not.toContain('llm-pi-ai')
  })

  it('他自己配了一段 llm-pi-ai → 中转那件整个不做(settingsForRelay 拒绝),只补声明', () => {
    const mine = 'llm-pi-ai:\n  providers:\n    my-gw:\n      api: openai-completions\n'
    const out = renderDshSettingsSeed(mine)
    expect(out.text).toBe(`ui-onboarding:\n${ACK}\n${mine}`)
    expect(readAgentDefaultModel(out.text)).toBeUndefined()
  })

  it('profile 那步真把 settings.yaml 写进 ~/.dsh;第二次跑不再改', async () => {
    const h = harness()
    // 接了中转的那一档(我们的构建编着地址;用例跑的是开源缺省,所以写进 model.json)。
    mkdirSync(join(h.home, '.dsh/workbench'), { recursive: true })
    writeFileSync(join(h.home, '.dsh/workbench/model.json'), JSON.stringify({ relay_url: 'https://relay.test' }))
    await h.run('profile')
    const file = join(h.home, '.dsh/settings.yaml')
    const text = readFileSync(file, 'utf8')
    expect(text).toContain(ACK)
    expect(readAgentDefaultModel(text)?.provider).toBe('workbench-relay')
    expect(text).toContain('baseURL: https://relay.test/v1')
    await h.run('profile')
    expect(readFileSync(file, 'utf8')).toBe(text)
  })

  it('零服务器档:profile 那步只写声明确认,不把 DSH 指到中转', async () => {
    const h = harness()
    await h.run('profile')
    const text = readFileSync(join(h.home, '.dsh/settings.yaml'), 'utf8')
    expect(text).toContain(ACK)
    expect(readAgentDefaultModel(text)).toBeUndefined()
  })
})
