// @vitest-environment node
/**
 * 「只下变了的」(2026-09-18,Ben 看着 0.2.44 那 128MB 说的那句「好慢」)。
 *
 * 分两截:
 *
 * - **纯函数那一截**(`parseInstalled` / `planAssets`):一条 I/O 都没有。
 *   "记录写歪了会怎样""没有记录时怎么办"这类事一条一条钉住。
 * - **临时 HOME 里真跑那一截**:起一个本地 http 假服务器,先发一版(三样产物全下),
 *   再发一版(只有插件换了字节,脚本与通话组件**逐字不变**),验第二趟**只发一次 curl**。
 *   这一条就是这张卡的验收线。
 *
 * 跟 update-e2e 那组同一套纪律:真 curl、真 shasum、真 tar,只有会去动这台机器上
 * 真实 DSH 运行时与 launchd 的那几类命令(npm / launchctl / rsync / dsh plugin add)被拦下来。
 * 所有落盘都在 mktemp 出来的临时 HOME 下,删之前逐个核对前缀(0904 铁律)。
 */
import { createServer, type Server } from 'node:http'
import { createReadStream, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync, copyFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { seedInstalledPnpm } from './setup/pnpmFake.ts'
import { createUpdateService } from '../src/server/update/service.ts'
import { emptyInstalled, parseInstalled, planAssets, serializeInstalled } from '../src/server/update/installed.ts'
import { nodeSetupIo, type SetupExecOptions, type SetupIo } from '../src/server/setup/io.ts'
import { setupPaths } from '../src/server/setup/paths.ts'
import type { InstalledAssets, UpdateJobView, UpdateManifest } from '../src/server/update/types.ts'

const A = 'a'.repeat(64)
const B = 'b'.repeat(64)

function manifest(over: Partial<UpdateManifest> = {}): UpdateManifest {
  return {
    version: '9.9.9',
    assets: {
      plugin_tgz: { url: 'https://api.aibooo.cn/updates/9.9.9/plugin.tgz', sha256: A, size: 1_000 },
      channel_worker_tgz: { url: 'https://api.aibooo.cn/updates/9.9.9/channel-worker.tgz', sha256: B, size: 100_000 },
    },
    ...over,
  }
}

function installed(over: Partial<InstalledAssets['assets']> = {}): InstalledAssets {
  return { assets: { ...over } }
}

describe('installed.json · 读它(容错)', () => {
  it('文件不在 / 空的 / 不是 JSON / 不是对象:一律退化成「一条记录都没有」,不抛', () => {
    for (const text of [undefined, '', '   ', '不是 json', '[]', '"字符串"', 'null']) {
      expect(parseInstalled(text)).toEqual(emptyInstalled())
    }
  })

  it('sha 的形状不对的那一条**整条丢掉** —— 不能留一个「空校验和于是判成没变」的缝', () => {
    const parsed = parseInstalled(JSON.stringify({
      assets: {
        plugin_tgz: { sha256: '', version: '0.2.44' },
        scripts_tgz: { sha256: 'ZZZ', version: '0.2.44' },
        channel_worker_tgz: { sha256: B.toUpperCase(), version: '0.2.44', at: '昨天' },
        什么鬼: { sha256: A },
      },
    }))
    expect(parsed.assets.plugin_tgz).toBeUndefined()
    expect(parsed.assets.scripts_tgz).toBeUndefined()
    // 大写的十六进制认得(统一小写);认不出来的产物种类直接忽略,不当成错。
    expect(parsed.assets.channel_worker_tgz?.sha256).toBe(B)
    expect(Object.keys(parsed.assets)).toEqual(['channel_worker_tgz'])
  })

  it('写出去再读回来是同一份', () => {
    const record: InstalledAssets = {
      version: '0.2.45',
      updated_at: '2026-09-18T12:00:00.000Z',
      assets: { plugin_tgz: { sha256: A, version: '0.2.45', at: '2026-09-18T12:00:00.000Z' } },
    }
    expect(parseInstalled(serializeInstalled(record))).toEqual(record)
  })
})

describe('planAssets · 这次到底下哪几件', () => {
  it('记录里一样 → 不下;记录里不一样 → 下', () => {
    const plan = planAssets(manifest(), installed({
      plugin_tgz: { sha256: '0'.repeat(64), version: '0.2.44', at: '' },
      channel_worker_tgz: { sha256: B, version: '0.2.40', at: '' },
    }))
    expect(plan.total).toBe(2)
    expect(plan.changed).toBe(1)
    expect(plan.bytes).toBe(1_000)
    expect(plan.all_bytes).toBe(101_000)
    const worker = plan.items.find(item => item.kind === 'channel_worker_tgz')
    expect(worker?.changed).toBe(false)
    expect(worker?.source).toBe('record')
    expect(worker?.why).toContain('一模一样')
  })

  it('没记录、但本机那份现算出来一样 → 也不下(兜底)', () => {
    const plan = planAssets(manifest(), emptyInstalled(), { plugin_tgz: A })
    const plugin = plan.items.find(item => item.kind === 'plugin_tgz')
    expect(plugin?.changed).toBe(false)
    expect(plugin?.source).toBe('local')
    // 工人那件既没记录也算不出来 —— **照下**。
    const worker = plan.items.find(item => item.kind === 'channel_worker_tgz')
    expect(worker?.changed).toBe(true)
    expect(worker?.source).toBe('none')
    expect(plan.bytes).toBe(100_000)
  })

  it('既没记录也算不出来 → 全下。「没查出来」不等于「没变」', () => {
    const plan = planAssets(manifest(), emptyInstalled())
    expect(plan.changed).toBe(2)
    expect(plan.bytes).toBe(plan.all_bytes)
    expect(plan.items.every(item => item.source === 'none')).toBe(true)
  })

  it('清单里没有的产物不进这份账(apk 永远不进 —— 手机自己去下)', () => {
    const plan = planAssets(manifest({
      assets: {
        plugin_tgz: { url: 'https://api.aibooo.cn/u/p.tgz', sha256: A, size: 1_000 },
        apk: { url: 'https://api.aibooo.cn/u/app.apk', sha256: B, size: 32_000_000 },
      },
    }), emptyInstalled())
    expect(plan.items.map(item => item.kind)).toEqual(['plugin_tgz'])
    expect(plan.all_bytes).toBe(1_000)
  })
})

/* ───────────────────────── 临时 HOME 里真跑一遍 ───────────────────────── */

const fakes: Server[] = []
const dirs: string[] = []
afterEach(async () => {
  while (fakes.length) await new Promise<void>((resolve) => { fakes.pop()?.close(() => resolve()) })
  while (dirs.length) {
    const dir = dirs.pop() as string
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

async function serveDir(root: string): Promise<string> {
  const server = createServer((req, res) => {
    const name = decodeURIComponent((req.url ?? '/').split('?')[0] as string).replace(/^\/+/, '')
    const file = join(root, name)
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

/**
 * 造一版:三样产物 + 一份 latest.json。
 *
 * `reuse` 里给的那几样是**上一版那个文件原样复制过来**(逐字相同,sha 当然也相同)——
 * 这正是真实世界里的样子:通话组件一个月也未必动一次,而版本号跟着工作台一起走。
 */
function publish(serverRoot: string, origin: string, version: string, reuse: Partial<Record<'scripts' | 'worker', string>> = {}): void {
  const dir = join(serverRoot, 'updates', version)
  mkdirSync(dir, { recursive: true })

  // 插件:每一版都不一样(package.json 里写着版本号)。
  const pluginStage = join(serverRoot, `plugin-${version}/package`)
  mkdirSync(pluginStage, { recursive: true })
  writeFileSync(join(pluginStage, 'package.json'), JSON.stringify({ name: '@ben/dsh-workbench', version }))
  execFileSync('tar', ['-czf', join(dir, 'plugin.tgz'), '-C', join(serverRoot, `plugin-${version}`), 'package'])

  // 启动脚本与通话组件:要么原样复制上一版那个文件,要么现造一个。
  if (reuse.scripts !== undefined) copyFileSync(reuse.scripts, join(dir, 'scripts.tgz'))
  else {
    const stage = join(serverRoot, 'scripts-stage')
    mkdirSync(join(stage, 'workbench-plugin/bin'), { recursive: true })
    mkdirSync(join(stage, 'deploy'), { recursive: true })
    mkdirSync(join(stage, 'butler-server/launchd'), { recursive: true })
    writeFileSync(join(stage, 'workbench-plugin/bin/dsh-start'), '#!/usr/bin/env bash\necho dsh-start\n')
    writeFileSync(join(stage, 'workbench-plugin/bin/butler-start'), '#!/usr/bin/env bash\necho butler-start\n')
    writeFileSync(join(stage, 'deploy/channel-start'), '#!/usr/bin/env bash\necho channel-start\n')
    writeFileSync(join(stage, 'deploy/ai.deepseek.dsh.plist'), '<plist><dict><key>P</key><string>{{HOME}}/.dsh/bin/dsh-start</string></dict></plist>\n')
    writeFileSync(join(stage, 'butler-server/launchd/ai.deepseek.butler.plist'), '<plist><dict><key>P</key><string>{{HOME}}/.dsh/bin/butler-start</string></dict></plist>\n')
    execFileSync('tar', ['-czf', join(dir, 'scripts.tgz'), '-C', stage, 'workbench-plugin', 'deploy', 'butler-server'])
  }
  if (reuse.worker !== undefined) copyFileSync(reuse.worker, join(dir, 'channel-worker.tgz'))
  else {
    const stage = join(serverRoot, 'worker-stage')
    // 装工人那一步会先看 payload 里有没有 @livekit/rtc-node(原生模块必须跟着走),
    // 所以这个假包也得摆成那个样子。
    mkdirSync(join(stage, 'channel-worker/node_modules/@livekit/rtc-node'), { recursive: true })
    mkdirSync(join(stage, 'channel-worker/src'), { recursive: true })
    writeFileSync(join(stage, 'channel-worker/src/main.ts'), 'console.log("假工人")\n')
    writeFileSync(join(stage, 'channel-worker/node_modules/@livekit/rtc-node/package.json'), '{"name":"@livekit/rtc-node"}\n')
    execFileSync('tar', ['-czf', join(dir, 'channel-worker.tgz'), '-C', stage, 'channel-worker'])
  }

  const asset = (file: string): { url: string, sha256: string, size: number } => ({
    url: `${origin}/updates/${version}/${file}`,
    sha256: sha256(join(dir, file)),
    size: statSync(join(dir, file)).size,
  })
  writeFileSync(join(serverRoot, 'updates/latest.json'), `${JSON.stringify({
    version,
    notes: `这是 ${version}。`,
    assets: {
      plugin_tgz: asset('plugin.tgz'),
      scripts_tgz: asset('scripts.tgz'),
      channel_worker_tgz: asset('channel-worker.tgz'),
    },
  }, null, 2)}\n`)
}

function isFaked(cmd: readonly string[]): boolean {
  const bin = cmd[0] ?? ''
  // launchctl **按整条 argv 认**(2026-10-13):重启那一下是 `/bin/sh -c '… exec launchctl …'`,
  // 只看 cmd[0] 这道硬线就失效了,会把真服务重启掉。
  if (cmd.some(arg => arg.includes('launchctl'))) return true
  if (bin === 'npm' || bin === 'rsync' || bin === 'codesign') return true
  return cmd.includes('plugin') && cmd.includes('--profile')
}

describe('只下变了的 · 临时 HOME 里真走两版', () => {
  it('第一版全下 → 改一样再发一版 → 第二趟只下那一样', async () => {
    const home = temp('wb-upd-inc-home-')
    const serverRoot = temp('wb-upd-inc-srv-')
    const origin = await serveDir(serverRoot)

    const curls: string[][] = []
    const real = nodeSetupIo()
    const io: SetupIo = {
      ...real,
      exec: async (cmd: readonly string[], options?: SetupExecOptions) => {
        if (cmd[0] === 'curl') curls.push([...cmd])
        if (isFaked(cmd)) return { ok: true, code: 0, out: '(用例拦下来的)' }
        return await real.exec(cmd, options)
      },
      uid: () => 501,
    }
    const paths = setupPaths({ home, applicationsDir: join(home, 'Applications') })
    // 这台机器上自带的 pnpm 已经装好了(装插件那一步判「已经在了,不用装」,不去联网下)。
    seedInstalledPnpm(paths)
    const make = (): ReturnType<typeof createUpdateService> => createUpdateService({
      io,
      paths,
      now: () => Date.now(),
      newId: (() => { let n = 0; return () => `inc-${++n}-${Math.random().toString(16).slice(2)}` })(),
      currentVersion: '0.2.41',
      manifestUrl: `${origin}/updates/latest.json`,
      checkIntervalMs: 0,
      applyTuning: { subPollMs: 0, restartDelayMs: 0, downloadPollMs: 0 },
    })

    // ── 第一版:三样都没记过,全下 ──
    publish(serverRoot, origin, '9.9.9')
    const first = make()
    const check1 = await first.check()
    expect(check1.plan?.total).toBe(3)
    expect(check1.plan?.changed).toBe(3)
    expect(check1.size).toBe(check1.plan?.all_bytes)

    const a = first.apply() as UpdateJobView
    await first.waitJob(a.id)
    const job1 = first.job(a.id) as UpdateJobView
    expect(job1.error).toBeUndefined()
    expect(job1.state).toBe('done')
    expect(job1.unchanged).toEqual([])
    expect(curls.length).toBe(3)

    // 记录真写下来了,三样都在。
    const record1 = parseInstalled(readFileSync(paths.installedJson, 'utf8'))
    expect(Object.keys(record1.assets).sort()).toEqual(['channel_worker_tgz', 'plugin_tgz', 'scripts_tgz'])
    expect(record1.version).toBe('9.9.9')

    // ── 第二版:只有插件换了字节,启动脚本与通话组件**原样复制上一版那个文件** ──
    publish(serverRoot, origin, '9.9.10', {
      scripts: join(serverRoot, 'updates/9.9.9/scripts.tgz'),
      worker: join(serverRoot, 'updates/9.9.9/channel-worker.tgz'),
    })
    const second = make()
    const check2 = await second.check()
    expect(check2.plan?.total).toBe(3)
    expect(check2.plan?.changed).toBe(1)
    // 「要下多大」只算变了的那一件。
    const manifest2 = JSON.parse(readFileSync(join(serverRoot, 'updates/latest.json'), 'utf8')) as { assets: Record<string, { size: number }> }
    expect(check2.size).toBe(manifest2.assets.plugin_tgz?.size)
    expect(check2.plan?.all_bytes).toBeGreaterThan(check2.size as number)

    const before = curls.length
    const b = second.apply() as UpdateJobView
    await second.waitJob(b.id)
    const job2 = second.job(b.id) as UpdateJobView
    expect(job2.error).toBeUndefined()
    expect(job2.state).toBe('done')

    // **这一条就是这张卡**:第二趟只发了一次 curl,而且是插件那一件。
    const added = curls.slice(before)
    expect(added.length).toBe(1)
    expect(added[0]?.join(' ')).toContain('/updates/9.9.10/plugin.tgz')

    // 没变的那两样:产物根本没落到 9.9.10 的 assets 目录里,界面上也各有一句话。
    const assets2 = `${home}/.dsh/updates/9.9.10/assets`
    expect(existsSync(`${assets2}/plugin.tgz`)).toBe(true)
    expect(existsSync(`${assets2}/scripts.tgz`)).toBe(false)
    expect(existsSync(`${assets2}/channel-worker.tgz`)).toBe(false)
    expect(job2.unchanged.length).toBe(2)
    expect(job2.unchanged.join('\n')).toContain('通话组件')
    expect(job2.unchanged.join('\n')).toContain('启动脚本')
    // 没变的那两样**不该**被说成「这一版没带」—— 清单里带了,只是跟本机那份一样。
    // (事务官后端与壳那两样确实没进这一版的清单,它们照旧说「这一版没带」。)
    expect(job2.skipped.join('\n')).not.toContain('通话组件')
    expect(job2.skipped.join('\n')).not.toContain('启动脚本')

    // 记录跟着更新:插件换成新 sha,另外两条原样留着(这才是下一版还能跳过的前提)。
    const record2 = parseInstalled(readFileSync(paths.installedJson, 'utf8'))
    expect(record2.assets.plugin_tgz?.sha256).toBe(sha256(join(serverRoot, 'updates/9.9.10/plugin.tgz')))
    expect(record2.assets.plugin_tgz?.version).toBe('9.9.10')
    expect(record2.assets.channel_worker_tgz).toEqual(record1.assets.channel_worker_tgz)

    // 装完照样重启(这一版确实换了插件)。
    expect(job2.restarting).toBe(true)
    expect(`${home}/.dsh`.startsWith(tmpdir())).toBe(true)
  }, 120_000)

  it('一样都没变(发版的人只 bump 了版本号):不下、不装、**也不重启**', async () => {
    const home = temp('wb-upd-noop-home-')
    const serverRoot = temp('wb-upd-noop-srv-')
    const origin = await serveDir(serverRoot)
    publish(serverRoot, origin, '9.9.9')

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
    const paths = setupPaths({ home, applicationsDir: join(home, 'Applications') })
    // 这台机器上自带的 pnpm 已经装好了(装插件那一步判「已经在了,不用装」,不去联网下)。
    seedInstalledPnpm(paths)
    const make = (): ReturnType<typeof createUpdateService> => createUpdateService({
      io,
      paths,
      now: () => Date.now(),
      newId: (() => { let n = 0; return () => `noop-${++n}-${Math.random().toString(16).slice(2)}` })(),
      currentVersion: '0.2.41',
      manifestUrl: `${origin}/updates/latest.json`,
      checkIntervalMs: 0,
      applyTuning: { subPollMs: 0, restartDelayMs: 0, downloadPollMs: 0 },
    })

    const first = make()
    await first.check()
    const a = first.apply() as UpdateJobView
    await first.waitJob(a.id)
    expect((first.job(a.id) as UpdateJobView).state).toBe('done')
    const before = curls.length

    // 同样三个文件,只把版本号换一下 —— 三份产物逐字不变。
    publish(serverRoot, origin, '9.9.11', {
      scripts: join(serverRoot, 'updates/9.9.9/scripts.tgz'),
      worker: join(serverRoot, 'updates/9.9.9/channel-worker.tgz'),
    })
    // 插件那一份也换成上一版那个文件(publish 会按版本号造,所以这里覆盖回去)。
    copyFileSync(join(serverRoot, 'updates/9.9.9/plugin.tgz'), join(serverRoot, 'updates/9.9.11/plugin.tgz'))
    const text = readFileSync(join(serverRoot, 'updates/latest.json'), 'utf8')
      .replace(/"sha256": "[0-9a-f]{64}",\n(\s+)"size": \d+\n(\s+)\},\n(\s+)"scripts_tgz"/,
        `"sha256": "${sha256(join(serverRoot, 'updates/9.9.9/plugin.tgz'))}",\n$1"size": ${statSync(join(serverRoot, 'updates/9.9.9/plugin.tgz')).size}\n$2},\n$3"scripts_tgz"`)
    writeFileSync(join(serverRoot, 'updates/latest.json'), text)

    const second = make()
    const check = await second.check()
    expect(check.plan?.changed).toBe(0)
    expect(check.size).toBe(0)

    const b = second.apply() as UpdateJobView
    await second.waitJob(b.id)
    const job = second.job(b.id) as UpdateJobView
    expect(job.state).toBe('done')
    expect(curls.length).toBe(before)
    // **没有要换的东西就别重启** —— 重启会把正开着的网页踢一下。
    expect(job.restarting).toBeUndefined()
    expect(job.note).toContain('不用重启')
  }, 120_000)
})

describe('下载进度 · 已下 / 总量 / 速度 / 预计剩余', () => {
  it('时钟不动时只有「已下 / 总量」,一个编出来的速度都没有', async () => {
    const home = temp('wb-upd-rate-home-')
    const serverRoot = temp('wb-upd-rate-srv-')
    const origin = await serveDir(serverRoot)
    publish(serverRoot, origin, '9.9.9')

    const real = nodeSetupIo()
    const io: SetupIo = {
      ...real,
      exec: async (cmd: readonly string[], options?: SetupExecOptions) => {
        if (isFaked(cmd)) return { ok: true, code: 0, out: '' }
        return await real.exec(cmd, options)
      },
      uid: () => 501,
    }
    // 这台机器上自带的 pnpm 已经装好了(装插件那一步判「已经在了,不用装」,不去联网下)。
    seedInstalledPnpm(setupPaths({ home, applicationsDir: join(home, 'Applications') }))
    const update = createUpdateService({
      io,
      paths: setupPaths({ home, applicationsDir: join(home, 'Applications') }),
      // **时钟钉死**:算不出速度就一个字都别说(0918 那张卡第 4 条)。
      now: () => Date.parse('2026-09-18T10:00:00Z'),
      newId: (() => { let n = 0; return () => `rate-${++n}` })(),
      currentVersion: '0.2.41',
      manifestUrl: `${origin}/updates/latest.json`,
      checkIntervalMs: 0,
      applyTuning: { subPollMs: 0, restartDelayMs: 0, downloadPollMs: 0 },
    })
    await update.check()
    const job = update.apply() as UpdateJobView
    await update.waitJob(job.id)
    const done = update.job(job.id) as UpdateJobView
    expect(done.state).toBe('done')
    expect(done.download).toBeDefined()
    // 三样全下完,已下 = 总量。
    expect(done.download?.done).toBe(done.download?.total)
    expect(done.download?.total).toBeGreaterThan(0)
    expect(done.download?.bytes_per_sec).toBeUndefined()
    expect(done.download?.eta_seconds).toBeUndefined()
  }, 120_000)
})
