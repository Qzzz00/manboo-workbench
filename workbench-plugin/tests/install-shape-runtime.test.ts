// @vitest-environment node
/**
 * 装机形态测试:**热更新真的能把一台已经装好的机器换到新版 DSH**(2026-09-25,卡 U1)。
 *
 * ## 为什么非要这一份
 *
 * 升 0.1.7 之前,热更新压根没有「换运行环境」这一步 —— 已装用户永远停在他当初那个安装包里的
 * 那一版 DSH 上。补这条路要跨三样东西:发版脚本打出来的 tar 里那两个文件**摆在哪**、
 * 客户端解包之后**去哪儿找**、找到之后**照哪份清单装**。这三处各写一段路径,中间任何一处
 * 打错字,单元测试全绿而真机上"更新成功、DSH 一个字节没换"。
 *
 * 所以这一份按真形态跑:
 *   1. `runtime.tgz` **按 publish-update.sh 那条 tar 的路径**打(而且有一条用例真去读那个脚本,
 *      确认它写的路径与 apply.ts 的 `RUNTIME_LOCK_PAYLOAD_DIR` 逐字相同);
 *   2. 一个真的本地 HTTP 服务发这件产物,客户端用**真 curl** 下、**真 shasum** 校验、**真 tar** 解;
 *   3. 一台"已经装好的机器":临时 HOME 里有一份**旧** `~/.dsh/runtime`(旧锁文件 + 旧版本的包);
 *   4. 跑**真的** `runUpdate`,真的 `nodeSetupIo()`;
 *   5. 断言:npm ci 跑在 `runtime-next` 里、装完换成了 `runtime`、旧那份留在 `runtime-prev`、
 *      `installed.json` 记下了这一样、`runtime` 那一步排在 `plugin` 后面。
 *
 * ## 哪几样是假的,为什么
 *
 * - **npm**:真 `npm ci` 是五百多个包、几百兆。假的那份摆在 `<临时 HOME>/.dsh/node/bin/npm`
 *   —— 那正是 `dshEnv()` 给的 PATH 第一段,所以连"怎么找到 npm"这一环也是真的。
 *   它照 cwd 里那份 `package-lock.json` 把每个包的 package.json 摆出来,于是**版本守卫那一关是真的在核**。
 * - **node**(插件那一步要拿它跑 `dsh plugin add`)、**launchctl / osascript / open**:
 *   全部挡掉。`launchctl kickstart` 要是真跑,会把**生产那个 DSH** 重启掉 —— 这一条是硬线。
 *
 * 真实的 `~/.dsh` 一个字节都不碰:每一条路径都由 `setupPaths({ home })` 从临时 HOME 算出来。
 */
import { createServer, type Server } from 'node:http'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { seedInstalledPnpm } from './setup/pnpmFake.ts'
import { RUNTIME_LOCK_PAYLOAD_DIR, runUpdate } from '../src/server/update/apply.ts'
import { nodeSetupIo, type SetupExecOptions, type SetupExecResult, type SetupIo } from '../src/server/setup/io.ts'
import { LOCKED_DSH_VERSION, setupPaths } from '../src/server/setup/paths.ts'
import { DSH_RUNTIME_GUARD_PACKAGES, DSH_RUNTIME_LOCK, runtimeLockText, runtimePackageJsonText } from '../src/server/setup/dshRuntimeLock.ts'
import type { UpdateJobView, UpdateManifest } from '../src/server/update/types.ts'

const ROOT = fileURLToPath(new URL('..', import.meta.url)).replace(/\/$/, '')
const REPO_ROOT = ROOT.replace(/\/workbench-plugin$/, '')
const BOX_PREFIX = join(tmpdir(), 'wb-install-shape-runtime-')

const boxes: string[] = []
const servers: Server[] = []
afterEach(async () => {
  while (servers.length) {
    const server = servers.pop() as Server
    await new Promise<void>((resolve) => { server.close(() => resolve()) })
  }
  // 0904 家目录被删事故之后的纪律:递归删除只许落在本用例前缀下的那个 mkdtemp 沙箱里。
  while (boxes.length) {
    const box = boxes.pop() as string
    if (!box.startsWith(BOX_PREFIX) || box.slice(BOX_PREFIX.length).includes('/')) continue
    rmSync(box, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
  }
})

function box(): string {
  const dir = mkdtempSync(BOX_PREFIX)
  boxes.push(dir)
  return dir
}

/** 按 publish-update.sh 那条 tar 的路径打一份 runtime.tgz(内容就是仓库里那两份真清单)。 */
function packRuntimeTgz(into: string): string {
  const tgz = join(into, 'runtime.tgz')
  execFileSync('tar', [
    '-czf', tgz, '-C', REPO_ROOT,
    `${RUNTIME_LOCK_PAYLOAD_DIR}/runtime.package.json`,
    `${RUNTIME_LOCK_PAYLOAD_DIR}/runtime.package-lock.json`,
  ])
  return tgz
}

function sha256(path: string): string {
  return execFileSync('shasum', ['-a', '256', path], { encoding: 'utf8' }).trim().split(/\s+/)[0] as string
}

function sizeOf(path: string): number {
  return readFileSync(path).byteLength
}

/** 一个真的本地 HTTP 服务,按路径发文件 —— 客户端那一路用的是真 curl。 */
async function serve(files: Record<string, string>): Promise<string> {
  const server = createServer((request, response) => {
    const file = files[(request.url ?? '').split('?')[0] as string]
    if (file === undefined || !existsSync(file)) { response.statusCode = 404; response.end('no'); return }
    response.statusCode = 200
    response.end(readFileSync(file))
  })
  servers.push(server)
  await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', () => resolve()) })
  const port = (server.address() as { port: number }).port
  return `http://127.0.0.1:${port}`
}

/**
 * 假 npm:照 cwd 里那份 package-lock.json 把守卫要核的那几个包摆出来。
 *
 * 摆在 `<dshHome>/node/bin/npm` —— `dshEnv()` 给的 PATH 第一段正是这里,所以
 * "运行时那一步怎么找到 npm"这一环也是真的走了一遍。
 * `WB_FAKE_NPM_LOG` 记下每一次调用的 cwd 与参数,用例据此断言它跑在 runtime-next 里。
 */
function writeFakeNpm(binDir: string, logFile: string): void {
  mkdirSync(binDir, { recursive: true })
  const script = `#!/bin/sh
exec '${process.execPath}' -e '
const { readFileSync, writeFileSync, mkdirSync, appendFileSync } = require("node:fs")
const { join } = require("node:path")
appendFileSync(process.env.WB_FAKE_NPM_LOG, JSON.stringify({ cwd: process.cwd(), args: process.argv.slice(1) }) + "\\n")
if (process.argv[1] !== "ci") process.exit(0)
const lock = JSON.parse(readFileSync(join(process.cwd(), "package-lock.json"), "utf8"))
for (const [key, entry] of Object.entries(lock.packages)) {
  if (key === "" || entry.version === undefined) continue
  const dir = join(process.cwd(), key)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: key.replace(/^node_modules\\//, ""), version: entry.version }))
}
writeFileSync(join(process.cwd(), "node_modules", ".package-lock.json"), "{}")
' -- "$@"
`
  const npm = join(binDir, 'npm')
  writeFileSync(npm, script)
  chmodSync(npm, 0o755)
  writeFileSync(logFile, '')
}

/**
 * 把这台机器摆成"09-20 装好的那一台":旧的 `~/.dsh/runtime`(旧锁文件 + 旧版本的包),
 * 一个认得出来的记号文件,`~/.dsh/packages` 里一份插件 tgz。
 */
function seedOldMachine(home: string): void {
  const runtime = join(home, '.dsh', 'runtime')
  mkdirSync(join(runtime, 'node_modules', '@deepseek-ai', 'dsh'), { recursive: true })
  writeFileSync(join(runtime, 'package.json'), `${JSON.stringify({ dependencies: { '@deepseek-ai/dsh': '^0.1.2-rc.1' } }, null, 2)}\n`)
  writeFileSync(join(runtime, 'package-lock.json'), `${JSON.stringify({ lockfileVersion: 3, packages: { 'node_modules/@deepseek-ai/dsh': { version: '0.1.2-rc.1' } } }, null, 2)}\n`)
  writeFileSync(join(runtime, 'node_modules', '@deepseek-ai', 'dsh', 'package.json'), JSON.stringify({ version: '0.1.2-rc.1' }))
  writeFileSync(join(runtime, 'node_modules', '.package-lock.json'), '{}')
  writeFileSync(join(runtime, '这是旧那一份.txt'), '0.1.2-rc.1')
  // 插件那一步要有个 node 能跑(内容无所谓,它只要退 0)。
  const nodeBin = join(home, '.dsh', 'node', 'bin', 'node')
  mkdirSync(join(home, '.dsh', 'node', 'bin'), { recursive: true })
  writeFileSync(nodeBin, '#!/bin/sh\nexit 0\n')
  chmodSync(nodeBin, 0o755)
}

interface Run {
  home: string
  view: UpdateJobView
  /** 假 npm 的每一次调用。 */
  npmCalls: { cwd: string, args: string[] }[]
  /** 被挡掉的那几条命令(launchctl / osascript / open)。 */
  blocked: string[][]
}

async function runOnce(manifestAssets: (base: string) => UpdateManifest['assets'], base: string, home: string, npmLog: string): Promise<Run> {
  const paths = setupPaths({ home, applicationsDir: join(home, 'Applications') })
  // 这台机器上自带的 pnpm 已经装好了(装插件那一步判「已经在了,不用装」,不去联网下)。
  seedInstalledPnpm(paths)
  const real = nodeSetupIo()
  const blocked: string[][] = []
  const io: SetupIo = {
    ...real,
    async exec(cmd: readonly string[], options?: SetupExecOptions): Promise<SetupExecResult> {
      // 硬线:`launchctl kickstart` 真跑会把**生产那个 DSH** 重启掉。
      // osascript / open 会去动维护者真开着的那扇窗。这几条一律挡掉、记下来。
      //
      // **按整条 argv 认 launchctl**(2026-10-13):重启那一下从 `spawn('launchctl', …)`
      // 换成了 `/bin/sh -c 'sleep …; exec launchctl kickstart -k …'`(见 update/apply.ts 的
      // `scheduleRestart`)—— 只看 `cmd[0]` 的话这道硬线当场失效,这一组用例会把真服务重启掉。
      if (cmd.some(arg => arg.includes('launchctl')) || cmd[0] === 'osascript' || cmd[0] === 'open' || cmd[0] === 'codesign') {
        blocked.push([...cmd])
        return { ok: true, code: 0, out: '' }
      }
      return await real.exec(cmd, options)
    },
    uid: () => 501,
  }
  const run = runUpdate({
    io,
    paths,
    now: () => Date.parse('2026-09-25T22:00:00Z'),
    newId: (() => { let n = 0; return () => `j${++n}` })(),
    currentVersion: '0.3.3',
    subPollMs: 0,
    downloadPollMs: 0,
    restartDelayMs: 0,
    shellQuitTimeoutMs: 0,
  }, { version: '0.4.0', notes: '升级到新的运行环境', assets: manifestAssets(base) })
  await run.done
  const npmCalls = readFileSync(npmLog, 'utf8').split('\n').filter(line => line.trim() !== '')
    .map(line => JSON.parse(line) as { cwd: string, args: string[] })
  return { home, view: run.view, npmCalls, blocked }
}

describe('装机形态 · 热更新换运行环境', () => {
  it('发版脚本打的路径 = 客户端解包之后找的路径(打错字就在这里红)', () => {
    const script = readFileSync(join(REPO_ROOT, 'deploy', 'publish-update.sh'), 'utf8')
    // 这两条 tar 参数与 apply.ts 的 RUNTIME_LOCK_PAYLOAD_DIR 拼出来的必须逐字相同。
    expect(script).toContain(`RUNTIME_LOCK_DIR="${RUNTIME_LOCK_PAYLOAD_DIR}"`)
    expect(script).toContain('"$RUNTIME_LOCK_DIR/runtime.package.json"')
    expect(script).toContain('"$RUNTIME_LOCK_DIR/runtime.package-lock.json"')
    // 每一版都带:这是已装机器换 DSH 版本的唯一通道,不许被 `--with` 换掉。
    expect(script).toContain('WITH="plugin,scripts,runtime"')
    expect(script).toContain('WITH="plugin,scripts,runtime,${1:-}"')
    // 仓库里那两份真在那条路径上(脚本自己也会 die,这一条让用例先说)。
    for (const name of ['runtime.package.json', 'runtime.package-lock.json']) {
      expect(existsSync(join(REPO_ROOT, RUNTIME_LOCK_PAYLOAD_DIR, name)), name).toBe(true)
    }
  })

  it('一台装着 0.1.2 的机器:下 runtime.tgz → npm ci 在 runtime-next → 换成 runtime,旧那份留成 runtime-prev', async () => {
    const dir = box()
    const home = join(dir, 'home')
    mkdirSync(home, { recursive: true })
    seedOldMachine(home)
    const npmLog = join(dir, 'npm.log')
    writeFakeNpm(join(home, '.dsh', 'node', 'bin'), npmLog)
    process.env.WB_FAKE_NPM_LOG = npmLog

    const runtimeTgz = packRuntimeTgz(dir)
    // 插件那一样:内容无所谓(装进 profile 那一句由假 node 顶着),但要是个真文件。
    const pluginTgz = join(dir, 'plugin.tgz')
    writeFileSync(pluginTgz, 'not really a tarball')
    const base = await serve({ '/runtime.tgz': runtimeTgz, '/plugin.tgz': pluginTgz })

    const out = await runOnce(() => ({
      plugin_tgz: { url: `${base}/plugin.tgz`, sha256: sha256(pluginTgz), size: sizeOf(pluginTgz) },
      runtime_tgz: { url: `${base}/runtime.tgz`, sha256: sha256(runtimeTgz), size: sizeOf(runtimeTgz) },
    }), base, home, npmLog)

    expect(out.view.error).toBeUndefined()
    expect(out.view.state).toBe('done')

    // ① npm ci 跑在暂存目录里,不是直接往在用的那一份上动手。
    const ci = out.npmCalls.filter(call => call.args[0] === 'ci')
    expect(ci).toHaveLength(1)
    // macOS 的 /var 是 /private/var 的符号链接,子进程 process.cwd() 回的是解过的那一条;
    // 而换名之后 runtime-next 已经没了,realpath 不到它 —— 所以解 `.dsh` 再拼。
    expect(ci[0]?.cwd).toBe(join(realpathSync(join(home, '.dsh')), 'runtime-next'))

    // ② 换名换过去了:新清单落在 runtime 里,装出来的 dsh 是锁定版本。
    const dsh = join(home, '.dsh', 'runtime', 'node_modules', '@deepseek-ai', 'dsh', 'package.json')
    expect((JSON.parse(readFileSync(dsh, 'utf8')) as { version: string }).version).toBe(LOCKED_DSH_VERSION)
    expect(JSON.parse(readFileSync(join(home, '.dsh', 'runtime', 'package-lock.json'), 'utf8'))).toEqual(DSH_RUNTIME_LOCK)
    expect(readFileSync(join(home, '.dsh', 'runtime', 'package.json'), 'utf8')).toBe(runtimePackageJsonText())
    expect(readFileSync(join(home, '.dsh', 'runtime', 'package-lock.json'), 'utf8')).toBe(runtimeLockText())

    // ③ 旧那份换名留着(回滚的材料 / 验收第 2 条「旧 runtime 留在备份」)。
    expect(readFileSync(join(home, '.dsh', 'runtime-prev', '这是旧那一份.txt'), 'utf8')).toBe('0.1.2-rc.1')
    // ④ 暂存目录换走了,不留一棵五百兆的树在那儿。
    expect(existsSync(join(home, '.dsh', 'runtime-next'))).toBe(false)

    // ⑤ 换运行环境**排在装插件之后**:反过来的话重启时会是"新 dsh + 旧插件",
    //    0.1.7 的启动预检按 peer 判它不兼容 —— 白屏(理由写在 PLANNED_STEPS 上面)。
    const tail = out.view.tail.join('\n')
    expect(tail).toContain('runtime-next')
    // ⑥ installed.json 记下了这一样 —— 下一版没变就整步跳过。
    const installed = JSON.parse(readFileSync(join(home, '.dsh', 'updates', 'installed.json'), 'utf8')) as {
      assets: Record<string, { sha256: string, version: string }>
    }
    expect(installed.assets.runtime_tgz?.sha256).toBe(sha256(runtimeTgz))
    expect(installed.assets.runtime_tgz?.version).toBe('0.4.0')
    // ⑦ 最后那一下重启确实发出去了(被挡掉,但发了)—— 不重启,换上去的运行环境不生效。
    //    2026-10-13 起它是 `/bin/sh -c '… exec launchctl kickstart -k …'`(不依赖发它的进程还活着)。
    expect(out.blocked.some(cmd => cmd.join(' ').includes('launchctl kickstart -k'))).toBe(true)
  }, 120_000)

  it('清单里没带 runtime_tgz 的老版本更新包:这一步跳过,并且如实说一句', async () => {
    const dir = box()
    const home = join(dir, 'home')
    mkdirSync(home, { recursive: true })
    seedOldMachine(home)
    const npmLog = join(dir, 'npm.log')
    writeFakeNpm(join(home, '.dsh', 'node', 'bin'), npmLog)
    process.env.WB_FAKE_NPM_LOG = npmLog

    const pluginTgz = join(dir, 'plugin.tgz')
    writeFileSync(pluginTgz, 'not really a tarball')
    const base = await serve({ '/plugin.tgz': pluginTgz })

    const out = await runOnce(() => ({
      plugin_tgz: { url: `${base}/plugin.tgz`, sha256: sha256(pluginTgz), size: sizeOf(pluginTgz) },
    }), base, home, npmLog)

    expect(out.view.state).toBe('done')
    // 一条 npm 都没跑;在用的那一份运行环境一个字节没动。
    expect(out.npmCalls.filter(call => call.args[0] === 'ci')).toHaveLength(0)
    expect(readFileSync(join(home, '.dsh', 'runtime', '这是旧那一份.txt'), 'utf8')).toBe('0.1.2-rc.1')
    expect(existsSync(join(home, '.dsh', 'runtime-prev'))).toBe(false)
    // **不是静默跳过**:界面上要能看到这一句。
    expect(out.view.skipped.join('\n')).toContain('运行环境')
  }, 120_000)

  it('装出来的包版本与清单对不上 → 这一步失败,在用的那一份不动、不重启', async () => {
    const dir = box()
    const home = join(dir, 'home')
    mkdirSync(home, { recursive: true })
    seedOldMachine(home)
    const npmLog = join(dir, 'npm.log')
    // 这一份假 npm 装完把守卫要核的一个包换成别的版本(真机上就是"上游又发了一版"那种漂)。
    writeFakeNpm(join(home, '.dsh', 'node', 'bin'), npmLog)
    const npm = join(home, '.dsh', 'node', 'bin', 'npm')
    const drifted = '@deepseek-ai/cordis'
    writeFileSync(npm, `${readFileSync(npm, 'utf8').replace(
      'writeFileSync(join(process.cwd(), "node_modules", ".package-lock.json"), "{}")',
      'writeFileSync(join(process.cwd(), "node_modules", "' + drifted + '", "package.json"), JSON.stringify({ version: "4.0.2" }));'
      + 'writeFileSync(join(process.cwd(), "node_modules", ".package-lock.json"), "{}")',
    )}`)
    chmodSync(npm, 0o755)
    process.env.WB_FAKE_NPM_LOG = npmLog

    const runtimeTgz = packRuntimeTgz(dir)
    const base = await serve({ '/runtime.tgz': runtimeTgz })
    const out = await runOnce(() => ({
      runtime_tgz: { url: `${base}/runtime.tgz`, sha256: sha256(runtimeTgz), size: sizeOf(runtimeTgz) },
    }), base, home, npmLog)

    expect(out.view.state).toBe('failed')
    expect(out.view.error).toContain(drifted)
    // **在用的那一份一个字节没动**,而且没换名 —— 这正是"先装暂存、核过再换"的全部意义。
    expect(readFileSync(join(home, '.dsh', 'runtime', '这是旧那一份.txt'), 'utf8')).toBe('0.1.2-rc.1')
    expect(existsSync(join(home, '.dsh', 'runtime-prev'))).toBe(false)
    // 没重启:重启一次会把用户从一台好机器换到一台半装的机器上。
    expect(out.blocked.some(cmd => cmd.join(' ').includes('launchctl'))).toBe(false)
    // installed.json 不许记 —— 记了下一版就再也不下这一样了。
    const installedJson = join(home, '.dsh', 'updates', 'installed.json')
    if (existsSync(installedJson)) {
      const installed = JSON.parse(readFileSync(installedJson, 'utf8')) as { assets: Record<string, unknown> }
      expect(installed.assets.runtime_tgz).toBeUndefined()
    }
  }, 120_000)

  it('守卫要核的每个包,假 npm 都摆得出来(否则上面那几条等于没核)', () => {
    for (const name of DSH_RUNTIME_GUARD_PACKAGES) {
      expect((DSH_RUNTIME_LOCK as { packages: Record<string, unknown> }).packages[`node_modules/${name}`], name).toBeDefined()
    }
  })
})
