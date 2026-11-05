// @vitest-environment node
/**
 * 装机形态:**0.3.x 升到 0.4.0 → 重启 → 发现漂移 → 自动补上运行环境**整条(2026-09-26,卡 U6)。
 *
 * ## 为什么非要这一份
 *
 * 09-26 生产切换那天真发生的事:执行热更新的是**旧的 0.3.6 客户端**,它的步骤表里没有
 * `runtime` —— 插件换成了 0.4.0,运行环境一个字没换;换上新插件之后再点「检查更新」只比
 * 插件版本号 → 没有新版 → 运行环境从此再也装不上。单元测试各自都是绿的:漏的是**接缝**。
 *
 * 所以这一份按真形态、在一个假 HOME 上把那三幕连起来跑:
 *
 *   ① 老客户端那一趟(用 `intent.steps` 摆出 0.3.6 那张步骤表:没有 `runtime`)
 *      —— 跑完之后插件装上了,而 `~/.dsh/runtime` 还是 0.1.2-rc.1;
 *   ② 换上 0.4.0 的那个进程一起来就探到漂移(`readRuntimeDrift`),
 *      「检查更新」也认它(`available` + `runtime_only`);
 *   ③ 自动补那一趟走**真的**一键装(`createSetupInstaller` 的 profile / runtime / restart),
 *      跑完 `~/.dsh/runtime` 真换成了锁定版本,旧那份留在 `runtime-prev`。
 *
 * ## 哪几样是假的,为什么
 *
 * - **npm**:真 `npm ci` 是五百多个包、几百兆。假的那份摆在 `<临时 HOME>/.dsh/node/bin/npm`
 *   —— 那正是 `dshEnv()` 给的 PATH 第一段,所以连"怎么找到 npm"这一环也是真的;
 *   它照 cwd 里那份 package-lock.json 把每个包摆出来,于是**版本守卫那一关是真的在核**。
 * - **launchctl / osascript / open / codesign**:全部挡掉。`launchctl kickstart` 要是真跑,
 *   会把**生产那个 DSH** 重启掉 —— 这一条是硬线。
 *
 * 真实的 `~/.dsh` 一个字节都不碰:每一条路径都由 `setupPaths({ home })` 从临时 HOME 算出来。
 */
import { createServer, type Server } from 'node:http'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { seedInstalledPnpm } from './setup/pnpmFake.ts'
import { RUNTIME_LOCK_PAYLOAD_DIR, runUpdate } from '../src/server/update/apply.ts'
import { createSetupInstaller } from '../src/server/setup/install.ts'
import { createRuntimeRepair, RUNTIME_REPAIR_STEPS } from '../src/server/setup/runtimeRepair.ts'
import { readRuntimeDrift } from '../src/server/setup/dshRuntimeLock.ts'
import { createUpdateService } from '../src/server/update/service.ts'
import { nodeSetupIo, type SetupExecOptions, type SetupExecResult, type SetupIo } from '../src/server/setup/io.ts'
import { LOCKED_DSH_VERSION, setupPaths } from '../src/server/setup/paths.ts'
import type { UpdateManifest } from '../src/server/update/types.ts'

const ROOT = fileURLToPath(new URL('..', import.meta.url)).replace(/\/$/, '')
const REPO_ROOT = ROOT.replace(/\/workbench-plugin$/, '')
const BOX_PREFIX = join(tmpdir(), 'wb-install-shape-drift-')
const NOW = Date.parse('2026-09-26T04:00:00Z')

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

/** 假 npm:照 cwd 里那份 package-lock.json 把每个包摆出来(照抄 install-shape-runtime 那一份)。 */
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

/** 把这台机器摆成"09-20 装好、跑着 0.3.6 的那一台"。 */
function seedOldMachine(home: string): void {
  const runtime = join(home, '.dsh', 'runtime')
  mkdirSync(join(runtime, 'node_modules', '@deepseek-ai', 'dsh'), { recursive: true })
  writeFileSync(join(runtime, 'package.json'), `${JSON.stringify({ dependencies: { '@deepseek-ai/dsh': '^0.1.2-rc.1' } }, null, 2)}\n`)
  writeFileSync(join(runtime, 'package-lock.json'), `${JSON.stringify({ lockfileVersion: 3, packages: { 'node_modules/@deepseek-ai/dsh': { version: '0.1.2-rc.1' } } }, null, 2)}\n`)
  writeFileSync(join(runtime, 'node_modules', '@deepseek-ai', 'dsh', 'package.json'), JSON.stringify({ version: '0.1.2-rc.1' }))
  writeFileSync(join(runtime, 'node_modules', '.package-lock.json'), '{}')
  writeFileSync(join(runtime, '这是旧那一份.txt'), '0.1.2-rc.1')
  const nodeBin = join(home, '.dsh', 'node', 'bin', 'node')
  mkdirSync(join(home, '.dsh', 'node', 'bin'), { recursive: true })
  writeFileSync(nodeBin, '#!/bin/sh\nexit 0\n')
  chmodSync(nodeBin, 0o755)
}

/**
 * 一律挡掉会去动这台真机的那几条命令(硬线:`launchctl kickstart` 会重启生产那个 DSH)。
 *
 * **按整条 argv 认 launchctl**(2026-10-13):重启那一下从 `spawn('launchctl', …)` 换成了
 * `/bin/sh -c 'sleep …; exec launchctl kickstart -k …'`(见 update/apply.ts 的 `scheduleRestart`)
 * —— 只看 `cmd[0]` 的话这道硬线当场失效,这一组用例会把真服务重启掉。
 */
function shieldedIo(blocked: string[][]): SetupIo {
  const real = nodeSetupIo()
  return {
    ...real,
    async exec(cmd: readonly string[], options?: SetupExecOptions): Promise<SetupExecResult> {
      if (cmd.some(arg => arg.includes('launchctl')) || cmd[0] === 'osascript' || cmd[0] === 'open' || cmd[0] === 'codesign') {
        blocked.push([...cmd])
        return { ok: true, code: 0, out: '' }
      }
      return await real.exec(cmd, options)
    },
    uid: () => 501,
  }
}

describe('装机形态 · 0.3.x 升上来之后补运行环境', () => {
  it('★老客户端那一趟跳过运行环境 → 新进程一起来就认出来 → 自动补上,旧那份留在 runtime-prev', async () => {
    const dir = box()
    const home = join(dir, 'home')
    mkdirSync(home, { recursive: true })
    seedOldMachine(home)
    const npmLog = join(dir, 'npm.log')
    writeFakeNpm(join(home, '.dsh', 'node', 'bin'), npmLog)
    process.env.WB_FAKE_NPM_LOG = npmLog

    const paths = setupPaths({ home, applicationsDir: join(home, 'Applications') })
    // 这台机器上自带的 pnpm 已经装好了(装插件那一步判「已经在了,不用装」,不去联网下)。
    seedInstalledPnpm(paths)
    const runtimeTgz = packRuntimeTgz(dir)
    const pluginTgz = join(dir, 'plugin.tgz')
    writeFileSync(pluginTgz, 'not really a tarball')
    const base = await serve({ '/runtime.tgz': runtimeTgz, '/plugin.tgz': pluginTgz })
    const manifest: UpdateManifest = {
      version: '0.4.0',
      notes: '升级到新的运行环境',
      assets: {
        plugin_tgz: { url: `${base}/plugin.tgz`, sha256: sha256(pluginTgz), size: sizeOf(pluginTgz) },
        runtime_tgz: { url: `${base}/runtime.tgz`, sha256: sha256(runtimeTgz), size: sizeOf(runtimeTgz) },
      },
    }

    /* ── 第一幕:0.3.6 的客户端执行 0.4.0 的热更新 ──
     *
     * 它的步骤表里**没有 `runtime`**(也没有 `profile` —— 那一步是这一版才进热更新的)。
     * 这里用 `intent.steps` 把那张旧表摆出来:这是对那一天真实发生过的事的复刻,
     * 不是对新代码的将就。 */
    const blocked: string[][] = []
    const io = shieldedIo(blocked)
    const oldClient = runUpdate({
      io,
      paths,
      now: () => NOW,
      newId: (() => { let n = 0; return () => `old${++n}` })(),
      currentVersion: '0.3.6',
      subPollMs: 0,
      downloadPollMs: 0,
      restartDelayMs: 0,
      shellQuitTimeoutMs: 0,
    }, manifest, { steps: ['plugin', 'scripts', 'butler', 'worker', 'shell', 'launchd'], says: '0.3.6 的客户端在跑这一趟' })
    await oldClient.done
    expect(oldClient.view.state).toBe('done')
    // 插件那一步跑过了;而运行环境**一个字没换** —— 这就是那天早上那台机器。
    const dshPackageJson = join(paths.runtimeDir, 'node_modules', '@deepseek-ai', 'dsh', 'package.json')
    expect((JSON.parse(readFileSync(dshPackageJson, 'utf8')) as { version: string }).version).toBe('0.1.2-rc.1')
    expect(existsSync(paths.runtimeNextDir)).toBe(false)

    /* ── 第二幕:重启成 0.4.0,新进程一起来就探到漂移 ── */
    const drift = await readRuntimeDrift(io, paths.runtimeDir)
    expect(drift.drifted).toBe(true)
    expect(drift.installed).toBe('0.1.2-rc.1')
    expect(drift.locked).toBe(LOCKED_DSH_VERSION)

    // 「检查更新」这条路也认它:插件版本号一模一样(0.4.0 vs 0.4.0),照旧只比版本号的话
    // 这里会是 false —— 那正是 09-26 那台机器卡住的地方。
    const update = createUpdateService({
      io: { ...io, fetch: (async () => new Response(JSON.stringify(manifest), { status: 200 })) as typeof fetch },
      paths,
      now: () => NOW,
      newId: () => 'chk1',
      currentVersion: '0.4.0',
      manifestUrl: `${base}/updates/latest.json`,
      runtimeDrift: async () => await readRuntimeDrift(io, paths.runtimeDir),
    })
    const checked = await update.check()
    expect(checked.available).toBe(true)
    expect(checked.runtime_only).toBe(true)
    // 这一趟的账里只有运行环境那几十 KB,不重下插件那一份。
    expect(checked.plan?.items.map(item => item.kind)).toEqual(['runtime_tgz'])

    /* ── 第三幕:自动补那一趟,走真的一键装(profile / runtime / restart)── */
    const steps: string[] = []
    const installer = createSetupInstaller({ io, paths, now: () => NOW, newId: (() => { let n = 0; return () => `sub${++n}` })() })
    let seq = 0
    const repair = createRuntimeRepair({
      io,
      paths,
      now: () => NOW,
      newId: () => `repair${(seq += 1)}`,
      install: (step) => { steps.push(step); return installer.start(step) },
      waitJob: id => installer.wait(id),
      probeMs: 0,
      subPollMs: 0,
    })
    await repair.refresh()
    const job = repair.start()
    expect('error' in job).toBe(false)
    await repair.waitJob('repair1')

    // 三步都跑了,顺序是 profile → runtime → restart(重启永远最后:那一下会杀掉这个进程)。
    expect(steps).toEqual([...RUNTIME_REPAIR_STEPS])
    const view = repair.job('repair1')
    expect(view?.state).toBe('done')
    expect(view?.note).toContain('正在重启')

    // ① 运行环境真换过来了:锁定版本 + 那两份清单逐字就是仓库里的。
    expect((JSON.parse(readFileSync(dshPackageJson, 'utf8')) as { version: string }).version).toBe(LOCKED_DSH_VERSION)
    // ② 旧那份留着(回滚的材料)。
    expect(readFileSync(join(paths.runtimePrevDir, '这是旧那一份.txt'), 'utf8')).toBe('0.1.2-rc.1')
    // ③ 暂存目录换走了,不留一棵树在那儿。
    expect(existsSync(paths.runtimeNextDir)).toBe(false)
    // ④ npm ci 跑在暂存目录里,不是直接往在用的那一份上动手。
    const npmCalls = readFileSync(npmLog, 'utf8').split('\n').filter(line => line.trim() !== '')
      .map(line => JSON.parse(line) as { cwd: string, args: string[] })
    expect(npmCalls.filter(call => call.args[0] === 'ci')).toHaveLength(1)
    // ⑤ 重启是发出去了的(被挡下来的那条命令记着),而且是 kickstart 那一条。
    //    2026-10-13 起它是 `/bin/sh -c '… exec launchctl kickstart -k …'`(不依赖发它的进程还活着)。
    expect(blocked.some(cmd => cmd.join(' ').includes('launchctl kickstart'))).toBe(true)

    /* ── 收尾:补完之后那一格自己收掉,「检查更新」也回到「已经是最新的了」── */
    expect((await repair.refresh())?.drifted).toBe(false)
    expect(repair.view()).toBeUndefined()
    const after = await update.check()
    expect(after.available).toBe(false)
    expect(after.runtime_only).toBeUndefined()
  }, 120_000)
})
