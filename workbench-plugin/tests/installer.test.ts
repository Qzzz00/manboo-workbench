// @vitest-environment node
/**
 * 桌面安装包的内核(2026-09-18)。
 *
 * **这里一条命令都不会真跑**:exec 是注入的假的。文件确实会真写,但每一条路径都由
 * `setupPaths({ home })` 从 mktemp 出来的临时 HOME 算出来 —— 代码里没有一处
 * `process.env.HOME`,所以就算哪里写错,也只会写进临时目录。
 * (2026-09-04 家目录被删事故之后,这条不是洁癖。)
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  bundleOf, encodeInstallerEvent, ensureWorkRepo, findBundledTarball, humanInstallerEvent,
  DESKTOP_TIDY_SUMMARY, desktopTidyPlan, ensureDesktopTidy,
  INSTALLER_STEPS, installerStep, parseInstallerArgs, runInstaller, workRepoFiles,
  type InstallerEvent,
} from '../src/server/setup/installer.ts'
import { writeButlerCwd } from '../src/server/setup/install.ts'
import { nodeSetupIo, type SetupExecOptions, type SetupIo } from '../src/server/setup/io.ts'
import { setupPaths } from '../src/server/setup/paths.ts'
import { isNpmCi, seedLockedRuntime } from './setup/dshRuntimeFake.ts'
import { fakePnpmExec, seedBundledPnpm, seedOwnNpm } from './setup/pnpmFake.ts'

const NOW = Date.parse('2026-09-18T09:00:00Z')
const dirs: string[] = []
afterEach(() => { while (dirs.length) rmSync(dirs.pop() as string, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }) })

function temp(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  dirs.push(dir)
  return dir
}

/** 把 .app 的 Resources 摆出来(payload 摆成仓库的样子)。 */
function resources(options: { tarball?: string } = {}): string {
  const dir = temp('wb-installer-res-')
  const payload = join(dir, 'payload')
  const write = (relative: string, text: string): void => {
    const full = join(payload, relative)
    mkdirSync(join(full, '..'), { recursive: true })
    writeFileSync(full, text)
  }
  write(`plugin/${options.tarball ?? 'ben-dsh-workbench-0.2.40.tgz'}`, 'tgz')
  write('app/工作台.app/Contents/MacOS/workbench', 'mach-o')
  write('workbench-plugin/bin/dsh-start', '#!/usr/bin/env bash\nexport DSH_HOME="$HOME/.dsh"\n')
  write('workbench-plugin/bin/butler-start', '#!/usr/bin/env bash\n')
  write('deploy/channel-start', '#!/usr/bin/env bash\n')
  write('deploy/ai.deepseek.dsh.plist', '<plist><string>{{HOME}}/.dsh/bin/dsh-start</string></plist>')
  // 这一份照抄本机写的,路径里带着别人的家目录 —— renderPlist 要把它换掉(见 install.ts 那段注释)。
  write('butler-server/launchd/ai.deepseek.butler.plist', '<plist><string>/Users/someone/.dsh/bin/butler-start</string></plist>')
  write('butler-server/package.json', '{"name":"@ben/butler-server"}')
  write('butler-server/server/index.cjs', '// server')
  write('butler-server/admin-ui/dist/index.html', '<html></html>')
  write('butler-server/node_modules/express/package.json', '{}')
  write('channel-worker/src/main.ts', '// worker')
  write('channel-worker/node_modules/@livekit/rtc-node/package.json', '{}')
  write('butler-app/android/app/build/outputs/apk/debug/app-debug.apk', 'PK-fake-apk')
  // 本机房间(2026-10-21,卡 M1):二进制、启动脚本、开机自启模板。
  write('livekit/livekit-server', '#!/bin/sh\n')
  write('deploy/livekit-start', '#!/usr/bin/env bash\n')
  write('deploy/ai.deepseek.livekit.plist', '<plist><string>{{HOME}}/.dsh/bin/livekit-start</string></plist>')
  // 自带的 pnpm(卡 PN):装插件那一步从这儿解出来,装的时候不联网。
  seedBundledPnpm(payload)
  return dir
}

interface Harness {
  home: string
  resourcesDir: string
  calls: readonly string[][]
  events: InstallerEvent[]
  io: SetupIo
}

function harness(options: {
  /** 按 `argv[0] argv[1]`(其次 argv[0])查表决定成败;查不到默认成功。 */
  exec?: Record<string, { ok?: boolean, code?: number, out?: string }>
  tarball?: string
} = {}): Harness {
  const home = temp('wb-installer-home-')
  const resourcesDir = resources({ ...(options.tarball === undefined ? {} : { tarball: options.tarball }) })
  const calls: string[][] = []
  const paths = setupPaths({ home })
  // 这台"机器"上 `~/.dsh/node` 是 stage0.sh 解开的官方独立包(node 与 npm 一起) ——
  // 装到这一步时它已经在了,所以 node 那步会判"已经有一份,不用换"。
  seedOwnNpm(paths)
  const io: SetupIo = {
    ...nodeSetupIo(),
    exec: async (cmd: readonly string[], opts?: SetupExecOptions) => {
      calls.push([...cmd])
      const key = [cmd[0], cmd[1]].filter(Boolean).join(' ')
      const hit = options.exec?.[key] ?? options.exec?.[cmd[0] ?? '']
      opts?.onLine?.(`(假的)${cmd.join(' ')}`)
      if (isNpmCi(cmd) && opts?.cwd !== undefined && (hit?.ok ?? true)) seedLockedRuntime(opts.cwd)
      if (hit === undefined && cmd[1] === '--version' && (cmd[0] ?? '').endsWith('/livekit-server')) return { ok: true, code: 0, out: 'livekit-server version 1.13.7\n' }
      if (options.exec?.[key] === undefined && options.exec?.[cmd[0] ?? ''] === undefined) {
        const pnpm = fakePnpmExec(paths, cmd)
        if (pnpm !== undefined) return pnpm
      }
      return { ok: hit?.ok ?? true, code: hit?.code ?? 0, out: hit?.out ?? '24.19.0\n' }
    },
    uid: () => 501,
  }
  return { home, resourcesDir, calls, events: [], io }
}

async function run(h: Harness, only?: readonly string[]): ReturnType<typeof runInstaller> {
  const tarball = await findBundledTarball(h.io, h.resourcesDir)
  const paths = setupPaths({ home: h.home, applicationsDir: join(h.home, 'Applications-系统') })
  return runInstaller({
    io: h.io,
    paths,
    bundle: bundleOf(h.resourcesDir, tarball as string),
    now: () => NOW,
    newId: (() => { let n = 0; return () => `job-${++n}` })(),
    emit: event => h.events.push(event),
    pollMs: 2,
    fallbackApplicationsDir: join(h.home, 'Applications'),
    withApplicationsDir: dir => setupPaths({ home: h.home, applicationsDir: dir }),
    ...(only === undefined ? {} : { only }),
  })
}

// ───────────────────────────── 手机包 ─────────────────────────────

describe('安装包里的手机包', () => {
  it('scripts 那步把 payload 里的手机包放进数据目录(首次流程的二维码从那里发;2026-09-18 真机漏了才补的)', async () => {
    const h = harness()
    const outcome = await run(h, ['work_repo', 'scripts'])
    expect(outcome.ok).toBe(true)
    expect(readFileSync(join(h.home, '.dsh/workbench/apk/app-debug.apk'), 'utf8')).toBe('PK-fake-apk')
  })
})

// ───────────────────────────── 那十步 ─────────────────────────────

describe('那几步的形状', () => {
  it('每一步都有人话标题,而且标题里不带步骤名', () => {
    for (const step of INSTALLER_STEPS) {
      expect(step.title.length).toBeGreaterThan(3)
      expect(step.title).not.toContain(step.key)
    }
  })

  it('launchd 是最后一步「装东西」:DSH 一装载就起来,起来那一刻别的东西都得已经在位', () => {
    // 2026-09-27 起后面还有一步「桌面整理」—— 它改的是她的桌面设置,不装任何东西,
    // 所以排在 launchd 后面不违反上面那条(而且它 optional,不成也不挡)。
    const installing = INSTALLER_STEPS.filter(step => step.local !== 'desktop')
    expect(installing[installing.length - 1]?.key).toBe('launchd')
    expect(INSTALLER_STEPS[INSTALLER_STEPS.length - 1]?.key).toBe('desktop')
  })

  it('壳在 launchd 之前:结尾那颗「打开工作台」要是"点了就开"', () => {
    const keys = INSTALLER_STEPS.map(step => step.key)
    expect(keys.indexOf('shell')).toBeLessThan(keys.indexOf('launchd'))
  })

  it('工作目录在启动脚本之前 —— 否则 scripts 那步会把安装包内部的路径记进 app.json', () => {
    const keys = INSTALLER_STEPS.map(step => step.key)
    expect(keys.indexOf('work_repo')).toBeLessThan(keys.indexOf('scripts'))
  })

  it('依赖顺序:node → runtime → profile → plugin', () => {
    const keys = INSTALLER_STEPS.map(step => step.key)
    expect(keys.indexOf('node')).toBeLessThan(keys.indexOf('runtime'))
    expect(keys.indexOf('runtime')).toBeLessThan(keys.indexOf('profile'))
    expect(keys.indexOf('profile')).toBeLessThan(keys.indexOf('plugin'))
  })

  it('可选的只有事务官、通话组件、本机通话服务、桌面整理(少了它们看板照常开)', () => {
    expect(INSTALLER_STEPS.filter(step => step.optional === true).map(step => step.key)).toEqual(['butler', 'worker', 'livekit', 'desktop'])
  })

  it('本机通话服务排在通话组件之后、壳之前(它独立于 DSH,早起晚起都行;launchd 那一步再核一次)', () => {
    const keys = INSTALLER_STEPS.map(step => step.key)
    expect(keys.indexOf('livekit')).toBeGreaterThan(keys.indexOf('worker'))
    expect(keys.indexOf('livekit')).toBeLessThan(keys.indexOf('shell'))
  })

  it('认得出步骤名,认不出的回 undefined', () => {
    expect(installerStep('plugin')?.setupStep).toBe('plugin')
    expect(installerStep('没这一步')).toBeUndefined()
  })
})

// ───────────────────────────── 事件流 ─────────────────────────────

describe('事件流', () => {
  it('每条都是一行 JSON(界面按行解析,里面不能有换行)', () => {
    const line = encodeInstallerEvent({ t: 'note', text: '第一行\n第二行' })
    expect(line.includes('\n')).toBe(false)
    expect(JSON.parse(line)).toEqual({ t: 'note', text: '第一行\n第二行' })
  })

  it('人话那一路把原始日志吞掉(几千行 npm 输出会把十句人话冲掉)', () => {
    expect(humanInstallerEvent({ t: 'log', text: 'npm warn ...' })).toBeUndefined()
    expect(humanInstallerEvent({ t: 'step', i: 2, n: 10, key: 'runtime', title: '正在下载…' })).toContain('[2/10]')
  })
})

// ───────────────────────────── 打包进来的东西 ─────────────────────────────

describe('从安装包里认东西', () => {
  it('认后缀挑 .tgz —— 文件名带版本号,钉死等于每次发版改两处', async () => {
    const h = harness({ tarball: 'ben-dsh-workbench-9.9.9.tgz' })
    expect(await findBundledTarball(h.io, h.resourcesDir)).toBe('ben-dsh-workbench-9.9.9.tgz')
  })

  it('目录不在就回 undefined(不抛,好让调用方说一句人话)', async () => {
    const h = harness()
    expect(await findBundledTarball(h.io, join(h.home, '没这个目录'))).toBeUndefined()
  })

  it('bundleOf 指向 payload 底下那两样', () => {
    const bundle = bundleOf('/R', 'x.tgz')
    expect(bundle.payloadRoot).toBe('/R/payload')
    expect(bundle.pluginTarball).toBe('/R/payload/plugin/x.tgz')
    expect(bundle.shellApp).toBe('/R/payload/app/工作台.app')
  })
})

// ───────────────────────────── 工作仓库 ─────────────────────────────

describe('工作仓库', () => {
  it('建目录 + 骨架文件,并且落在 ~/Documents/工作台', async () => {
    const h = harness()
    const paths = setupPaths({ home: h.home })
    expect(paths.workRepoDir).toBe(`${h.home}/Documents/工作台`)
    const result = await ensureWorkRepo(h.io, paths)
    expect(result.ok).toBe(true)
    for (const file of workRepoFiles()) {
      expect(existsSync(join(paths.workRepoDir, file.path))).toBe(true)
    }
  })

  it('没有命令行开发者工具时**根本不碰 git**(不在安装器里弹系统框)', async () => {
    const h = harness({ exec: { 'xcode-select': { ok: false, code: 2, out: '' } } })
    const result = await ensureWorkRepo(h.io, setupPaths({ home: h.home }))
    expect(result.ok).toBe(true)
    expect(result.git).toBe(false)
    expect(result.note).toContain('没有版本管理')
    expect(h.calls.some(cmd => cmd[0] === 'git')).toBe(false)
  })

  it('先 add 再 commit —— 骨架文件这会儿还没被跟踪,commit -a 管不着它们', async () => {
    const h = harness()
    await ensureWorkRepo(h.io, setupPaths({ home: h.home }))
    const gits = h.calls.filter(cmd => cmd[0] === 'git')
    const addAt = gits.findIndex(cmd => cmd.includes('add'))
    const commitAt = gits.findIndex(cmd => cmd.includes('commit'))
    expect(addAt).toBeGreaterThanOrEqual(0)
    expect(addAt).toBeLessThan(commitAt)
    // `commit -a` 是那次真跑漏掉文件的原因,别再回去。
    expect(gits.some(cmd => cmd.includes('commit') && cmd.includes('-a'))).toBe(false)
  })

  it('commit 时现给身份,不动他的全局 git 配置', async () => {
    const h = harness()
    await ensureWorkRepo(h.io, setupPaths({ home: h.home }))
    const commit = h.calls.find(cmd => cmd[0] === 'git' && cmd.includes('commit'))
    expect(commit).toBeDefined()
    expect(commit).toContain('-c')
    expect(commit).toContain('user.email=workbench@localhost')
    // `git config --global` 一条都不许有。
    expect(h.calls.some(cmd => cmd.includes('--global'))).toBe(false)
  })

  it('已经有 .git 了就一个字不动(幂等)', async () => {
    const h = harness()
    const paths = setupPaths({ home: h.home })
    mkdirSync(join(paths.workRepoDir, '.git'), { recursive: true })
    const result = await ensureWorkRepo(h.io, paths)
    expect(result.git).toBe(true)
    expect(h.calls.some(cmd => cmd[0] === 'git')).toBe(false)
  })

  it('已经有的骨架文件不覆盖(他改过的 AGENTS.md 不能被抹掉)', async () => {
    const h = harness()
    const paths = setupPaths({ home: h.home })
    mkdirSync(paths.workRepoDir, { recursive: true })
    writeFileSync(join(paths.workRepoDir, 'AGENTS.md'), '我自己写的')
    await ensureWorkRepo(h.io, paths)
    expect(readFileSync(join(paths.workRepoDir, 'AGENTS.md'), 'utf8')).toBe('我自己写的')
  })

  it('那个位置被一个文件占着:停下来说人话,不覆盖', async () => {
    const h = harness()
    const paths = setupPaths({ home: h.home })
    mkdirSync(join(h.home, 'Documents'), { recursive: true })
    writeFileSync(paths.workRepoDir, '这是一个文件')
    const result = await ensureWorkRepo(h.io, paths)
    expect(result.ok).toBe(false)
    expect(result.note).toContain('文件')
  })
})

// ───────────────────────────── app.json ─────────────────────────────

describe('butler_cwd 写进 app.json', () => {
  it('只改这一个键,别人的键原样保留', async () => {
    const h = harness()
    const paths = setupPaths({ home: h.home })
    mkdirSync(join(paths.appJson, '..'), { recursive: true })
    writeFileSync(paths.appJson, JSON.stringify({ version: 1, lan_access: true, 别人的: '不能动' }))
    await writeButlerCwd(h.io, paths, '/w')
    const after = JSON.parse(readFileSync(paths.appJson, 'utf8')) as Record<string, unknown>
    expect(after.butler_cwd).toBe('/w')
    expect(after.lan_access).toBe(true)
    expect(after.别人的).toBe('不能动')
  })

  it('已经配过的不动(他在设置里选过的目录,不能被"再装一次启动脚本"悄悄改掉)', async () => {
    const h = harness()
    const paths = setupPaths({ home: h.home })
    mkdirSync(join(paths.appJson, '..'), { recursive: true })
    writeFileSync(paths.appJson, JSON.stringify({ version: 1, butler_cwd: '/他自己选的' }))
    expect(await writeButlerCwd(h.io, paths, '/别的', { onlyIfAbsent: true })).toBe(false)
    expect((JSON.parse(readFileSync(paths.appJson, 'utf8')) as { butler_cwd: string }).butler_cwd).toBe('/他自己选的')
  })

  it('文件写坏了:从一份干净的默认值重写,不猜、不修', async () => {
    const h = harness()
    const paths = setupPaths({ home: h.home })
    mkdirSync(join(paths.appJson, '..'), { recursive: true })
    writeFileSync(paths.appJson, '{ 这不是 JSON')
    await writeButlerCwd(h.io, paths, '/w')
    expect(JSON.parse(readFileSync(paths.appJson, 'utf8'))).toEqual({ version: 1, lan_access: false, butler_cwd: '/w' })
  })
})

// ───────────────────────────── 十步跑一遍 ─────────────────────────────

describe('跑完那几步', () => {
  it('全绿:每一步都跑到,最后发 done', async () => {
    const h = harness()
    const outcome = await run(h)
    expect(outcome.ok).toBe(true)
    expect(outcome.done).toEqual(INSTALLER_STEPS.map(step => step.key))
    expect(h.events[0]).toEqual({ t: 'begin', total: INSTALLER_STEPS.length })
    expect(h.events[h.events.length - 1]?.t).toBe('done')
  })

  it('插件那步用打包进来的 .tgz —— 不 pnpm build、不 npm pack(那台机器上没有仓库)', async () => {
    const h = harness()
    await run(h, ['plugin'])
    expect(h.calls.some(cmd => cmd[0] === 'pnpm')).toBe(false)
    expect(h.calls.some(cmd => cmd[0] === 'npm' && cmd[1] === 'pack')).toBe(false)
    const add = h.calls.find(cmd => cmd.includes('plugin') && cmd.includes('add'))
    expect(add?.[add.length - 1]).toContain('ben-dsh-workbench-0.2.40.tgz')
    // .tgz 真的落进了 ~/.dsh/packages。
    expect(existsSync(join(h.home, '.dsh/packages/ben-dsh-workbench-0.2.40.tgz'))).toBe(true)
  })

  it('壳那步用打包进来的 工作台.app —— 不跑 build.sh(那台机器上没有 swiftc)', async () => {
    const h = harness()
    await run(h, ['shell'])
    expect(h.calls.some(cmd => (cmd[0] ?? '').endsWith('build.sh'))).toBe(false)
    const ditto = h.calls.find(cmd => cmd[0] === 'ditto')
    expect(ditto?.[1]).toContain('payload/app/工作台.app')
  })

  it('启动脚本与 plist 从 payload 里取,plist 里的家目录换成本机的', async () => {
    const h = harness()
    await run(h, ['scripts', 'launchd'])
    expect(readFileSync(join(h.home, '.dsh/bin/dsh-start'), 'utf8')).toContain('export DSH_HOME')
    const plist = readFileSync(join(h.home, 'Library/LaunchAgents/ai.deepseek.butler.plist'), 'utf8')
    expect(plist).toContain(`${h.home}/.dsh/bin/butler-start`)
    expect(plist).not.toContain('/Users/someone')
  })

  it('装完之后 app.json 里的 butler_cwd 指着工作目录,不是安装包里那个 payload', async () => {
    const h = harness()
    const outcome = await run(h)
    expect(outcome.ok).toBe(true)
    const full = JSON.parse(readFileSync(join(h.home, '.dsh/workbench/app.json'), 'utf8')) as Record<string, unknown>
    expect(full.butler_cwd).toBe(`${h.home}/Documents/工作台`)
    expect(String(full.butler_cwd)).not.toContain('payload')
  })

  it('只跑建工作目录那一步也会写 app.json', async () => {
    const h = harness()
    const outcome = await run(h, ['work_repo'])
    expect(outcome.ok).toBe(true)
    const config = JSON.parse(readFileSync(join(h.home, '.dsh/workbench/app.json'), 'utf8')) as Record<string, unknown>
    expect(config.butler_cwd).toBe(`${h.home}/Documents/工作台`)
  })

  it('可选那两步失败只是跳过,后面照跑', async () => {
    const h = harness({ exec: { rsync: { ok: false, code: 23, out: 'rsync: 权限不够\n' } } })
    const outcome = await run(h)
    expect(outcome.ok).toBe(true)
    expect(outcome.skipped).toEqual(['butler', 'worker'])
    expect(h.events.some(event => event.t === 'skip' && event.key === 'butler')).toBe(true)
  })

  it('必需那步失败就停下:发一条 fail,带人话与原始输出尾巴,后面的步骤不跑', async () => {
    const h = harness({ exec: { 'npm ci': { ok: false, code: 1, out: 'npm ERR! 网络超时\n' } } })
    const outcome = await run(h)
    expect(outcome.ok).toBe(false)
    expect(outcome.failed).toBe('runtime')
    const fail = h.events.find(event => event.t === 'fail')
    expect(fail).toBeDefined()
    // 「运行环境」是升 0.1.7(卡 U1)之后统一的说法 —— 给人看的字里不出现「运行时」。
    expect((fail as { error: string }).error).toContain('DSH 运行环境')
    expect((fail as { tail: readonly string[] }).tail.length).toBeGreaterThan(0)
    // 停在第二步,后面八步一条都没发。
    expect(h.events.filter(event => event.t === 'step').length).toBe(2)
  })

  it('壳装不进 /Applications 就退到 ~/Applications,并且说清楚退到哪了', async () => {
    const h = harness()
    const systemApps = join(h.home, 'Applications-系统')
    const real = h.io.exec
    h.io.exec = async (cmd, opts) => {
      if (cmd[0] === 'ditto' && (cmd[2] ?? '').startsWith(systemApps)) {
        return { ok: false, code: 1, out: 'ditto: 不允许写入\n' }
      }
      return real(cmd, opts)
    }
    const outcome = await run(h, ['shell'])
    expect(outcome.ok).toBe(true)
    expect(outcome.shellApp).toBe(join(h.home, 'Applications/工作台.app'))
    expect(h.events.some(event => event.t === 'note' && event.text.includes('改装到'))).toBe(true)
  })

  it('再跑一遍不出错(幂等:双击两次、装到一半重试都不能把机器弄坏)', async () => {
    const h = harness()
    expect((await run(h)).ok).toBe(true)
    h.events.length = 0
    const again = await run(h)
    expect(again.ok).toBe(true)
    expect(again.done.length).toBe(INSTALLER_STEPS.length)
  })

  it('全程一个字都没写到临时 HOME 外面', async () => {
    const h = harness()
    await run(h)
    // 假 exec 记下的每一条命令里,凡是绝对路径的实参都必须落在临时目录里。
    const outside = h.calls.flat().filter(arg => arg.startsWith('/Users/') || arg.startsWith('/Applications'))
    expect(outside).toEqual([])
  })
})

// ───────────────────────────── 命令行参数 ─────────────────────────────

describe('命令行参数', () => {
  it('认不出来的参数直接停,不忽略(打错一个字就装到别处去是 0904 那类事故的开头)', () => {
    const parsed = parseInstallerArgs(['--resourcess', '/x'], { HOME: '/h' })
    expect(parsed.ok).toBe(false)
  })

  it('没有 --resources 也没有环境变量就停', () => {
    expect(parseInstallerArgs([], { HOME: '/h' }).ok).toBe(false)
  })

  it('dshHome 缺省是 <home>/.dsh,末尾的斜杠去掉', () => {
    const parsed = parseInstallerArgs(['--resources', '/R/', '--home', '/h/'], {})
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(parsed.args.resources).toBe('/R')
    expect(parsed.args.home).toBe('/h')
    expect(parsed.args.dshHome).toBe('/h/.dsh')
  })

  it('--no-launch 与 --applications 认得出(临时 HOME 里验证靠这两个)', () => {
    const parsed = parseInstallerArgs(['--resources', '/R', '--no-launch', '--applications', '/tmp/apps/'], { HOME: '/h' })
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(parsed.args.noLaunch).toBe(true)
    expect(parsed.args.applicationsDir).toBe('/tmp/apps')
  })

  it('不给这两个时:不跳 launchctl、壳装 /Applications(真装机就是这条路)', () => {
    const parsed = parseInstallerArgs(['--resources', '/R'], { HOME: '/h' })
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(parsed.args.noLaunch).toBe(false)
    expect(parsed.args.applicationsDir).toBeUndefined()
  })

  it('--steps 只认那十步的名字', () => {
    expect(parseInstallerArgs(['--resources', '/R', '--steps', 'plugin,shell'], { HOME: '/h' }).ok).toBe(true)
    const bad = parseInstallerArgs(['--resources', '/R', '--steps', '随便写的'], { HOME: '/h' })
    expect(bad.ok).toBe(false)
    if (bad.ok) return
    expect(bad.error).toContain('随便写的')
  })
})

// ───────────────────────────── 桌面整理(2026-09-27,卡 IN) ─────────────────────────────

describe('装的时候把菜单栏与程序坞设成自动隐藏', () => {
  it('★写的就是那三个键:程序坞 autohide、菜单栏 _HIHideMenuBar、26 的 AutoHideMenuBarOption', () => {
    const plan = desktopTidyPlan()
    const lines = plan.commands.map(c => c.argv.join(' '))
    expect(lines).toContain('defaults write com.apple.dock autohide -bool true')
    expect(lines).toContain('defaults write NSGlobalDomain _HIHideMenuBar -bool true')
    expect(lines).toContain('defaults write com.apple.controlcenter AutoHideMenuBarOption -int 0')
  })

  it('★程序坞要重载一次才当场生效,所以最后一条是 killall Dock', () => {
    const plan = desktopTidyPlan()
    const last = plan.commands[plan.commands.length - 1]
    expect(last?.argv).toEqual(['killall', 'Dock'])
    // 写在前、重载在后 —— 反了就重载的是旧设置。
    const reload = plan.commands.findIndex(c => c.argv[0] === 'killall')
    const write = plan.commands.findIndex(c => c.argv.includes('autohide'))
    expect(write).toBeLessThan(reload)
  })

  it('不去 killall SystemUIServer / ControlCenter(26 上会把菜单栏右边那排图标搞坏)', () => {
    for (const command of desktopTidyPlan().commands) {
      expect(command.argv.join(' ')).not.toContain('SystemUIServer')
      expect(command.argv.join(' ')).not.toContain('ControlCenter')
    }
  })

  it('每条都说得出自己在干什么(人话,进日志和 note)', () => {
    for (const command of desktopTidyPlan().commands) {
      expect(command.why.length).toBeGreaterThan(3)
      expect(command.why).not.toContain('defaults')
    }
  })

  it('★菜单栏那一下要注销才生效 —— 这件事不许瞒着,「装好了」那一屏的话里要有', () => {
    expect(desktopTidyPlan().menuBarNeedsLogout).toBe(true)
    expect(DESKTOP_TIDY_SUMMARY).toContain('注销')
    // 改回来去哪儿:两处都要点名(她不是程序员,不许只说"去系统设置")。
    expect(DESKTOP_TIDY_SUMMARY).toContain('桌面与程序坞')
    expect(DESKTOP_TIDY_SUMMARY).toContain('控制中心')
    expect(DESKTOP_TIDY_SUMMARY).not.toContain('defaults')
  })

  it('★真跑那一步:三个键都写了、Dock 重载了,这一步算成', async () => {
    const h = harness()
    const outcome = await run(h, ['desktop'])
    expect(outcome.ok).toBe(true)
    expect(outcome.done).toContain('desktop')
    const lines = h.calls.map(c => c.join(' '))
    expect(lines).toContain('defaults write com.apple.dock autohide -bool true')
    expect(lines).toContain('defaults write NSGlobalDomain _HIHideMenuBar -bool true')
    expect(lines).toContain('killall Dock')
  })

  it('★一条不成不挡后面(程序坞成了、菜单栏没成,也比两条都不做好)', async () => {
    // 只让 killall 失败:三个键照写,这一步照样算成。
    const h = harness({ exec: { killall: { ok: false, code: 1 } } })
    const outcome = await run(h, ['desktop'])
    expect(outcome.ok).toBe(true)
    expect(outcome.done).toContain('desktop')
  })

  it('★一条都不成 → 只跳过,绝不让「桌面没整理成」把整趟安装判成失败', async () => {
    const h = harness({ exec: { defaults: { ok: false, code: 1 }, killall: { ok: false, code: 1 } } })
    const outcome = await run(h, ['desktop'])
    expect(outcome.ok).toBe(true)
    expect(outcome.skipped).toContain('desktop')
    expect(h.events.some(e => e.t === 'skip' && e.key === 'desktop')).toBe(true)
  })

  it('这一步是 optional —— 界面上失败时不出「重试」那一屏', () => {
    expect(installerStep('desktop')?.optional).toBe(true)
  })

  it('ensureDesktopTidy 自己也说得清:全成 / 部分成 / 全不成三种话不一样', async () => {
    const calls: string[][] = []
    const okIo = { ...nodeSetupIo(), exec: async (cmd: readonly string[]) => { calls.push([...cmd]); return { ok: true, code: 0, out: '' } } } as SetupIo
    const allOk = await ensureDesktopTidy(okIo)
    expect(allOk.ok).toBe(true)
    expect(allOk.failed).toEqual([])
    expect(allOk.note).toContain('注销')

    const badIo = { ...nodeSetupIo(), exec: async () => ({ ok: false, code: 1, out: '' }) } as SetupIo
    const allBad = await ensureDesktopTidy(badIo)
    expect(allBad.ok).toBe(false)
    expect(allBad.note).toContain('不影响')
  })
})

// ───────────────────────────── 去掉「来自网络」的标记 ─────────────────────────────

describe('装出来的东西不带「来自网络」的标记(2026-09-27 新 Air 真机)', () => {
  const isStrip = (cmd: readonly string[]): boolean => cmd[0] === 'xattr' && cmd.includes('com.apple.quarantine')

  it('跑插件那一步之前,先把 ~/.dsh 整个去掉标记 —— 否则 pnpm 自带的 reflink.node 一加载就被系统拦下', async () => {
    const h = harness()
    const outcome = await run(h, ['plugin'])
    expect(outcome.ok).toBe(true)
    const firstStrip = h.calls.findIndex(isStrip)
    const firstPnpmOrNode = h.calls.findIndex(cmd => !isStrip(cmd) && /node|pnpm/.test(cmd[0] ?? ''))
    expect(firstStrip).toBeGreaterThanOrEqual(0)
    expect(h.calls[firstStrip]).toEqual(['xattr', '-dr', 'com.apple.quarantine', join(h.home, '.dsh')])
    expect(firstPnpmOrNode === -1 || firstStrip < firstPnpmOrNode).toBe(true)
  })

  it('装完、说「装好了」之前,壳也去掉标记 —— 否则一打开就是「未打开"工作台"」', async () => {
    const h = harness()
    const outcome = await run(h, ['shell'])
    expect(outcome.ok).toBe(true)
    const strips = h.calls.filter(isStrip).map(cmd => cmd[cmd.length - 1])
    expect(strips).toContain(outcome.shellApp)
    const doneAt = h.events.findIndex(event => event.t === 'done')
    expect(doneAt).toBeGreaterThanOrEqual(0)
  })

  it('去标记没成不算安装失败(没有这个标记时 xattr 也可能回非零)', async () => {
    const h = harness({ exec: { xattr: { ok: false, code: 1 } } })
    const outcome = await run(h, ['plugin', 'shell'])
    expect(outcome.ok).toBe(true)
  })
})
