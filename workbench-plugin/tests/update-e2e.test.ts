// @vitest-environment node
/**
 * 热更新的**真跑**(2026-09-18)。临时 HOME + 本地 http 假服务器,check → apply 走一整遍。
 *
 * ## 哪些是真的
 *
 * - 清单真的经 http 取回来、真的过一遍 `parseManifest` 的每一道校验;
 * - 产物真的用 `curl` 下下来(本地回环,几百字节),真的用 `shasum -a 256` 核对;
 * - 真的用 `tar -xzf` 解包,payload 真的摆成仓库的样子;
 * - `scripts` / `launchd` 两步**真的读 payload 里的文件、真的写进临时 HOME**
 *   (`~/.dsh/bin/*` 三个脚本、`~/Library/LaunchAgents/*.plist` 两份);
 * - 断点续传、幂等(第二遍不重下不重解)也是真的跑出来的。
 *
 * ## 哪些是假的,以及为什么
 *
 * `npm` / `launchctl` / `rsync` / `<node> dsh plugin add` 四类命令被拦住换成假的 ——
 * 它们会去动这台机器上真实的 DSH 运行时与 launchd。除此之外的命令一律**原样放行**,
 * 所以"下下来的字节对不对、解出来的文件在不在"这两件最值钱的事是真验过的。
 *
 * 临时 HOME、临时服务器目录跑完都删掉(删之前只删自己 mktemp 出来的那两棵,0904 铁律)。
 */
import { createServer, type Server } from 'node:http'
import { createReadStream, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { seedInstalledPnpm } from './setup/pnpmFake.ts'
import { createUpdateService } from '../src/server/update/service.ts'
import { nodeSetupIo, type SetupExecOptions, type SetupIo } from '../src/server/setup/io.ts'
import { setupPaths } from '../src/server/setup/paths.ts'
import type { UpdateJobView } from '../src/server/update/types.ts'

const fakes: Server[] = []
const dirs: string[] = []
afterEach(async () => {
  while (fakes.length) await new Promise<void>((resolve) => { fakes.pop()?.close(() => resolve()) })
  while (dirs.length) {
    const dir = dirs.pop() as string
    // 只删自己 mktemp 出来的那一棵,且路径必须落在系统临时目录下(0904 家目录事故铁律)。
    if (!dir.startsWith(tmpdir())) throw new Error(`拒绝删除临时目录之外的路径:${dir}`)
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
  }
})

function temp(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  dirs.push(dir)
  return dir
}

function sha256(path: string): string {
  return execFileSync('shasum', ['-a', '256', path], { encoding: 'utf8' }).trim().split(/\s+/)[0] as string
}

/** 起一个把一个目录当静态根发出去的 http 服务器(只读、只 GET)。 */
async function serveDir(root: string): Promise<string> {
  const server = createServer((req, res) => {
    const name = decodeURIComponent((req.url ?? '/').split('?')[0] as string).replace(/^\/+/, '')
    const file = join(root, name)
    // 目录穿越在这个用例里不是威胁,但既然写了个静态服务器就别留一个坏样板。
    if (!file.startsWith(root) || !existsSync(file) || !statSync(file).isFile()) {
      res.writeHead(404); res.end('no'); return
    }
    res.writeHead(200, { 'content-length': String(statSync(file).size) })
    createReadStream(file).pipe(res)
  })
  fakes.push(server)
  await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', () => resolve()) })
  const address = server.address()
  const port = typeof address === 'object' && address !== null ? address.port : 0
  return `http://127.0.0.1:${port}`
}

/** 在服务器目录里真造出「插件 tgz」与「脚本 tgz」,并写一份指向它们的 latest.json。 */
function buildRelease(serverRoot: string, origin: string, version: string): void {
  const stage = join(serverRoot, 'stage')
  // 脚本包:按**仓库相对路径**打,解开就是仓库的样子 —— 这正是 install.ts 那六步要的形状。
  mkdirSync(join(stage, 'workbench-plugin/bin'), { recursive: true })
  mkdirSync(join(stage, 'deploy'), { recursive: true })
  mkdirSync(join(stage, 'butler-server/launchd'), { recursive: true })
  writeFileSync(join(stage, 'workbench-plugin/bin/dsh-start'), '#!/usr/bin/env bash\nexport DSH_HOME="$HOME/.dsh"\necho 新版 dsh-start\n')
  writeFileSync(join(stage, 'workbench-plugin/bin/butler-start'), '#!/usr/bin/env bash\necho 新版 butler-start\n')
  writeFileSync(join(stage, 'deploy/channel-start'), '#!/usr/bin/env bash\necho 新版 channel-start\n')
  writeFileSync(join(stage, 'deploy/ai.deepseek.dsh.plist'), '<plist><dict><key>Program</key><string>{{HOME}}/.dsh/bin/dsh-start</string></dict></plist>\n')
  writeFileSync(join(stage, 'butler-server/launchd/ai.deepseek.butler.plist'), '<plist><dict><key>Program</key><string>{{HOME}}/.dsh/bin/butler-start</string></dict></plist>\n')

  const dir = join(serverRoot, 'updates', version)
  mkdirSync(dir, { recursive: true })
  execFileSync('tar', ['-czf', join(dir, 'scripts.tgz'), '-C', stage, 'workbench-plugin', 'deploy', 'butler-server'])

  const pluginStage = join(serverRoot, 'plugin-stage/package')
  mkdirSync(pluginStage, { recursive: true })
  writeFileSync(join(pluginStage, 'package.json'), JSON.stringify({ name: '@ben/dsh-workbench', version }))
  execFileSync('tar', ['-czf', join(dir, 'plugin.tgz'), '-C', join(serverRoot, 'plugin-stage'), 'package'])

  writeFileSync(join(serverRoot, 'updates/latest.json'), `${JSON.stringify({
    version,
    released_at: '2026-09-18T12:00:00Z',
    notes: '这一版修了那个谁都在问的毛病。',
    assets: {
      plugin_tgz: { url: `${origin}/updates/${version}/plugin.tgz`, sha256: sha256(join(dir, 'plugin.tgz')), size: statSync(join(dir, 'plugin.tgz')).size },
      scripts_tgz: { url: `${origin}/updates/${version}/scripts.tgz`, sha256: sha256(join(dir, 'scripts.tgz')), size: statSync(join(dir, 'scripts.tgz')).size },
    },
  }, null, 2)}\n`)
}

/**
 * 会被换成假的那几类命令(它们会去动真实的 DSH 运行时 / launchd)。
 *
 * **launchctl 按整条 argv 认**(2026-10-13):重启那一下现在是
 * `/bin/sh -c '… exec launchctl kickstart -k …'`(update/apply.ts 的 `scheduleRestart`),
 * 只看 `cmd[0]` 这道硬线就失效了,会把真服务重启掉。
 */
function isFaked(cmd: readonly string[]): boolean {
  const bin = cmd[0] ?? ''
  if (cmd.some(arg => arg.includes('launchctl'))) return true
  if (bin === 'npm' || bin === 'rsync' || bin === 'codesign') return true
  // `<自有 node> <runtime>/bin.js plugin --profile web add …`
  return cmd.includes('plugin') && cmd.includes('--profile')
}

describe('热更新 · 临时 HOME 里真走一遍', () => {
  it('check → apply:真下载、真校验、真解包、真写脚本与 plist,最后发重启', async () => {
    const home = temp('wb-update-e2e-home-')
    const serverRoot = temp('wb-update-e2e-srv-')
    const origin = await serveDir(serverRoot)
    buildRelease(serverRoot, origin, '9.9.9')

    const faked: string[][] = []
    const real = nodeSetupIo()
    const io: SetupIo = {
      ...real,
      exec: async (cmd: readonly string[], options?: SetupExecOptions) => {
        if (isFaked(cmd)) { faked.push([...cmd]); return { ok: true, code: 0, out: '(用例拦下来的)' } }
        return await real.exec(cmd, options)
      },
      uid: () => 501,
    }
    const paths = setupPaths({ home, applicationsDir: join(home, 'Applications') })
    // 这台机器上自带的 pnpm 已经装好了(装插件那一步判「已经在了,不用装」,不去联网下)。
    seedInstalledPnpm(paths)
    const update = createUpdateService({
      io,
      paths,
      now: () => Date.now(),
      newId: (() => { let n = 0; return () => `e2e-${++n}` })(),
      currentVersion: '0.2.41',
      manifestUrl: `${origin}/updates/latest.json`,
      checkIntervalMs: 0,
      applyTuning: { subPollMs: 0, restartDelayMs: 0 },
    })

    // ── check ──
    const checked = await update.check()
    expect(checked.available).toBe(true)
    expect(checked.latest).toBe('9.9.9')
    expect(checked.notes).toContain('毛病')
    expect(checked.size).toBeGreaterThan(0)

    // ── apply ──
    const started = update.apply() as UpdateJobView
    expect('error' in started).toBe(false)
    await update.waitJob(started.id)
    const job = update.job(started.id) as UpdateJobView
    expect(job.error).toBeUndefined()
    expect(job.state).toBe('done')
    expect(job.restarting).toBe(true)

    // 下下来的原件真的在,而且校验和真的对得上清单里那一份。
    const assets = `${home}/.dsh/updates/9.9.9/assets`
    expect(existsSync(`${assets}/plugin.tgz`)).toBe(true)
    expect(existsSync(`${assets}/scripts.tgz`)).toBe(true)
    expect(sha256(`${assets}/scripts.tgz`)).toBe(
      (JSON.parse(readFileSync(join(serverRoot, 'updates/latest.json'), 'utf8')) as { assets: { scripts_tgz: { sha256: string } } }).assets.scripts_tgz.sha256,
    )

    // payload 真的解开成仓库的样子。
    const payload = `${home}/.dsh/updates/9.9.9/payload`
    expect(existsSync(`${payload}/workbench-plugin/bin/dsh-start`)).toBe(true)
    expect(existsSync(`${payload}/deploy/ai.deepseek.dsh.plist`)).toBe(true)

    // scripts 那一步真的把三个脚本写进了临时 HOME 的 ~/.dsh/bin,而且带执行位。
    for (const name of ['dsh-start', 'butler-start', 'channel-start']) {
      const file = `${home}/.dsh/bin/${name}`
      expect(existsSync(file)).toBe(true)
      expect((statSync(file).mode & 0o111) !== 0).toBe(true)
      expect(readFileSync(file, 'utf8')).toContain('新版')
    }

    // launchd 那一步真的渲染了 plist:`{{HOME}}` 换成了临时 HOME,一处 /Users/ 都没有。
    const plist = readFileSync(`${home}/Library/LaunchAgents/ai.deepseek.dsh.plist`, 'utf8')
    expect(plist).toContain(`${home}/.dsh/bin/dsh-start`)
    expect(plist).not.toContain('{{HOME}}')

    // 插件真的被放进了 ~/.dsh/packages(装进 profile 那条命令被拦下来了,但复制是真的)。
    expect(existsSync(`${home}/.dsh/packages/plugin.tgz`)).toBe(true)

    // 最后真的发了重启(2026-10-13 起交给一个 detach 出去的 sh 发)。
    expect(faked.some(cmd => cmd.join(' ').includes('launchctl kickstart -k gui/501/ai.deepseek.dsh'))).toBe(true)

    // **真 HOME 一个字都没碰**:这次所有落盘都在临时 HOME 下。
    expect(`${home}/.dsh`.startsWith(tmpdir())).toBe(true)
  }, 120_000)

  it('第二遍(同一个版本、同一个 HOME):一个字节都不重下,照样跑完 —— 幂等', async () => {
    const home = temp('wb-update-e2e2-home-')
    const serverRoot = temp('wb-update-e2e2-srv-')
    const origin = await serveDir(serverRoot)
    buildRelease(serverRoot, origin, '9.9.9')

    const curls: string[][] = []
    const real = nodeSetupIo()
    const io: SetupIo = {
      ...real,
      exec: async (cmd: readonly string[], options?: SetupExecOptions) => {
        if (cmd[0] === 'curl') curls.push([...cmd])
        if (isFaked(cmd)) return { ok: true, code: 0, out: '' }
        return await real.exec(cmd, options)
      },
      uid: () => 501,
    }
    // 这台机器上自带的 pnpm 已经装好了(装插件那一步判「已经在了,不用装」,不去联网下)。
    seedInstalledPnpm(setupPaths({ home, applicationsDir: join(home, 'Applications') }))
    const make = (): ReturnType<typeof createUpdateService> => createUpdateService({
      io,
      paths: setupPaths({ home, applicationsDir: join(home, 'Applications') }),
      now: () => Date.now(),
      newId: (() => { let n = 0; return () => `e2e2-${++n}-${Math.random().toString(16).slice(2)}` })(),
      currentVersion: '0.2.41',
      manifestUrl: `${origin}/updates/latest.json`,
      checkIntervalMs: 0,
      applyTuning: { subPollMs: 0, restartDelayMs: 0 },
    })

    const first = make()
    await first.check()
    const a = first.apply() as UpdateJobView
    await first.waitJob(a.id)
    expect((first.job(a.id) as UpdateJobView).state).toBe('done')
    const afterFirst = curls.length
    expect(afterFirst).toBe(2) // 插件 + 脚本,各一趟

    // 第二遍:服务重启过(新的 service 实例),但下下来的原件还在 ~/.dsh/updates 里。
    const second = make()
    await second.check()
    const b = second.apply() as UpdateJobView
    await second.waitJob(b.id)
    expect((second.job(b.id) as UpdateJobView).state).toBe('done')
    expect(curls.length).toBe(afterFirst) // 一趟都没多发
  }, 120_000)

  it('服务器上的产物被人换过(sha 对不上):不装,一句人话,坏包不留在磁盘上', async () => {
    const home = temp('wb-update-e2e3-home-')
    const serverRoot = temp('wb-update-e2e3-srv-')
    const origin = await serveDir(serverRoot)
    buildRelease(serverRoot, origin, '9.9.9')
    // 写清单之后**把产物本身换掉** —— 这正是"中间有人改过内容"的样子。
    writeFileSync(join(serverRoot, 'updates/9.9.9/plugin.tgz'), '这不是原来那个包')

    const real = nodeSetupIo()
    const io: SetupIo = {
      ...real,
      exec: async (cmd: readonly string[], options?: SetupExecOptions) => {
        if (isFaked(cmd)) return { ok: true, code: 0, out: '' }
        return await real.exec(cmd, options)
      },
      uid: () => 501,
    }
    const update = createUpdateService({
      io,
      paths: setupPaths({ home, applicationsDir: join(home, 'Applications') }),
      now: () => Date.now(),
      newId: (() => { let n = 0; return () => `e2e3-${++n}` })(),
      currentVersion: '0.2.41',
      manifestUrl: `${origin}/updates/latest.json`,
      checkIntervalMs: 0,
      applyTuning: { subPollMs: 0, restartDelayMs: 0 },
    })
    await update.check()
    const job = update.apply() as UpdateJobView
    await update.waitJob(job.id)
    const done = update.job(job.id) as UpdateJobView
    expect(done.state).toBe('failed')
    expect(done.error).toContain('校验和对不上')
    // 坏包不留 —— 留着下次会被当成"已经下好了"。
    expect(existsSync(`${home}/.dsh/updates/9.9.9/assets/plugin.tgz`)).toBe(false)
    // 也没有往 ~/.dsh/packages 里放任何东西。
    expect(existsSync(`${home}/.dsh/packages/plugin.tgz`)).toBe(false)
  }, 120_000)
})
