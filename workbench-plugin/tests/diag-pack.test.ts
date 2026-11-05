// @vitest-environment node
/**
 * 诊断包的打包器(2026-09-22)。
 *
 * **这一组里第一条用例是硬门**:在一个临时 HOME 里把该有的凭据文件全摆出来
 * (credentials.json、account*.json、channel.json、model.json、login-profile-*、.env…),
 * 打出来的包里**一个都不许有**,而且包里的字节里也不许出现那些文件的内容。
 * 它挡的是以后有人往 CONFIG_FILES 里手一滑加错一行。
 *
 * 除此之外还钉着:脱敏规则、体积与截断、清单里"没收进来的"要如实写、
 * 以及一次**真的压包**(ditto + unzip 逐条列出来看)。
 */
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, mkdirSync, statSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { nodeSetupIo } from '../src/server/setup/io.ts'
import { setupPaths, type SetupPaths } from '../src/server/setup/paths.ts'
import { nodeDiagIo, type DiagIo } from '../src/server/diagnostics/io.ts'
import { CONFIG_FILES, EXCLUDED_NAMES, SHELL_LOG_LINES, SHELL_LOG_WINDOW_HOURS, isExcludedName, packNameOf, stageDiagPackage, stampOf } from '../src/server/diagnostics/pack.ts'
import { APP_OPEN_TAG } from '../src/server/appOpenLog.ts'
import { createDiagService } from '../src/server/diagnostics/service.ts'

const AT = Date.parse('2026-09-22T02:15:30.000Z')
/** 东八区。stampOf 收的是分钟偏移(`-getTimezoneOffset()`)。 */
const TZ = 8 * 60

const dirs: string[] = []
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop() as string, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
})

function temp(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  dirs.push(dir)
  return dir
}

/** 一棵树里所有文件的绝对路径。 */
function walk(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...walk(full))
    else out.push(full)
  }
  return out
}

/** 一台"什么都有"的假机器:凭据、配置、日志各摆一份。 */
function fakeMachine(): { home: string, paths: SetupPaths, io: DiagIo } {
  const home = temp('wb-diag-home-')
  const paths = setupPaths({ home, applicationsDir: join(home, 'Applications') })
  const wb = `${paths.dshHome}/workbench`
  mkdirSync(wb, { recursive: true })
  mkdirSync(`${wb}/logs`, { recursive: true })
  mkdirSync(paths.logsDir, { recursive: true })

  // ── 凭据:一个都不许进包 ──────────────────────────────────────────────
  writeFileSync(`${wb}/credentials.json`, JSON.stringify({ deepseek: { api_key: 'sk-绝密绝密绝密绝密绝密' } }))
  writeFileSync(`${wb}/account.json`, JSON.stringify({ name: 'ben', secret: '本机账号口令' }))
  writeFileSync(`${wb}/account-server.json`, JSON.stringify({ session: 'wb_会话令牌不许出现' }))
  writeFileSync(`${wb}/account-session.key`, '这是一把会话钥匙')
  writeFileSync(`${wb}/channel.json`, JSON.stringify({ livekit: { api_secret: 'LIVEKIT密钥不许出现' } }))
  writeFileSync(`${wb}/model.json`, JSON.stringify({ relay_token: 'wb_设备令牌不许出现' }))
  writeFileSync(`${wb}/butler.json`, JSON.stringify({ token: '语音后端令牌不许出现' }))
  writeFileSync(`${wb}/devices.json`, JSON.stringify({ devices: [{ token: '手机令牌不许出现' }] }))
  writeFileSync(`${paths.dshHome}/.env`, 'WORKBENCH_RELAY_TOKEN=wb_环境变量里的令牌\n')
  writeFileSync(`${paths.dshHome}/.credentials.yaml`, 'deepseek: sk-yaml里的绝密\n')
  mkdirSync(`${wb}/login-profile-kimi_web`, { recursive: true })
  writeFileSync(`${wb}/login-profile-kimi_web/Cookies`, '浏览器档案里的 cookie')

  // ── 配置:白名单里那几份 ──────────────────────────────────────────────
  // butler_cwd 故意写成一条**真的家目录路径**:临时 HOME 在 macOS 上是 /var/folders/…,
  // 用它验不到「/Users/<名字>/ 里那一段被换掉」这条规则。
  writeFileSync(`${wb}/app.json`, JSON.stringify({ version: 1, lan_access: true, butler_cwd: '/Users/example/Documents/工作台' }))
  writeFileSync(`${wb}/template.json`, JSON.stringify({ id: '运营' }))
  writeFileSync(`${wb}/dock.json`, JSON.stringify({ version: 1, slots: [{ app: '微信' }] }))

  // ── 日志 ────────────────────────────────────────────────────────────
  writeFileSync(
    `${paths.logsDir}/web.stdout.log`,
    // 夹具:假值,DSH 启动令牌截短后的形状,不是真令牌。
    `dsh web: http://127.0.0.1:3080/?token=fakeDshLaunchTokenTestFixture0\n[channel-worker] 起了,日志在 ${home}/.dsh/workbench/logs/channel-worker.log\n`,
  )
  writeFileSync(`${wb}/logs/channel-worker.log`, '[channel-worker] 房里没人了,先不接话。\n')
  // 轮转出来的兄弟文件也该被收进去。
  writeFileSync(`${wb}/logs/channel-worker.log.2026-09-21`, '[channel-worker] 昨天那一份\n')

  /**
   * 真 I/O,但把两条**慢的 / 有副作用的**命令换成假的:
   * - `log show` 要翻系统统一日志库,7 天在这台机器上要几十秒,而且它的内容跟本组用例无关;
   * - `open -R` 会真的把访达弹到前台 —— 跑一次用例弹一次窗,没人受得了。
   * 别的(`ditto`、`sw_vers`、`uname`)照跑真的:压包那一条要的就是"真的压得出来"。
   */
  const real = nodeDiagIo(nodeSetupIo())
  const io: DiagIo = {
    ...real,
    exec: async (cmd, options) => {
      if (cmd[0] === 'log') return { ok: true, code: 0, out: 'Aug 22 10:00:00 mac workbench[1]: (默认级别)一行假的\n' }
      if (cmd[0] === 'open') return { ok: true, code: 0, out: '' }
      return await real.exec(cmd, options)
    },
  }
  return { home, paths, io }
}

function deps(machine: ReturnType<typeof fakeMachine>, patch: Record<string, unknown> = {}) {
  return {
    io: machine.io,
    paths: machine.paths,
    now: () => AT,
    pluginVersion: '0.2.54',
    snapshots: [
      {
        name: 'state.json',
        title: '/state 快照',
        load: async () => ({ pairing: { code: '882131' }, dock: { recent_switches: [{ app: '微信', ts: AT, ok: true, total_ms: 40, raise_ms: 20, hidden: 0 }] } }),
      },
    ],
    // 日志用例里塞的东西都很小,这里把上限压到很小以便验截断。
    ...patch,
  }
}

describe('硬门:凭据一个字节都不进包', () => {
  it('临时 HOME 里摆满凭据文件,打出来的包里没有它们', async () => {
    const machine = fakeMachine()
    const stage = temp('wb-diag-stage-')
    const out = await stageDiagPackage(deps(machine), stage)

    // ① 包内路径里没有任何一个凭据文件名
    const names = out.entries.map(entry => entry.path.split('/').pop() ?? '')
    for (const banned of EXCLUDED_NAMES) expect(names).not.toContain(banned)
    expect(out.entries.some(entry => entry.path.includes('login-profile'))).toBe(false)

    // ② 包里所有字节里,没有任何一份凭据的内容
    const all = out.entries
      .map(entry => readFileSync(join(stage, entry.path), 'utf8'))
      .join('\n')
    for (const secret of [
      'sk-绝密绝密绝密绝密绝密', '本机账号口令', 'wb_会话令牌不许出现', '这是一把会话钥匙',
      'LIVEKIT密钥不许出现', 'wb_设备令牌不许出现', '语音后端令牌不许出现', '手机令牌不许出现',
      'wb_环境变量里的令牌', 'sk-yaml里的绝密', '浏览器档案里的 cookie',
    ]) {
      expect(all).not.toContain(secret)
    }
  })

  it('有人往 CONFIG_FILES 里加错了凭据文件,也会被第二道门挡下', () => {
    // 这一条不跑打包,只钉住那张表本身:白名单里不许出现黑名单上的名字。
    for (const file of CONFIG_FILES) expect(isExcludedName(file.name)).toBe(false)
    expect(isExcludedName('credentials.json')).toBe(true)
    expect(isExcludedName('login-profile-kimi_web')).toBe(true)
    expect(isExcludedName('app.json')).toBe(false)
  })

  it('清单里把"不进包的是哪些"逐条写出来了', async () => {
    const machine = fakeMachine()
    const stage = temp('wb-diag-stage-')
    await stageDiagPackage(deps(machine), stage)
    const manifest = readFileSync(join(stage, '包内清单.md'), 'utf8')
    for (const banned of EXCLUDED_NAMES) expect(manifest).toContain(banned)
    expect(manifest).toContain('login-profile-')
    expect(manifest).toContain('白名单')
  })
})

describe('包里该有的东西', () => {
  it('概要里有各组件版本,取不到的写「取不到」而不是猜一个', async () => {
    const machine = fakeMachine()
    const stage = temp('wb-diag-stage-')
    await stageDiagPackage(deps(machine), stage)
    const summary = JSON.parse(readFileSync(join(stage, '概要.json'), 'utf8')) as { plugin_version: string, components: Record<string, string> }
    expect(summary.plugin_version).toBe('0.2.54')
    // 这台假机器上没装 DSH 运行时
    expect(summary.components['DSH 运行时']).toContain('取不到')
    expect(summary.components['壳 App']).toBe('没装')
  })

  it('白名单里的配置进来了,值脱敏过', async () => {
    const machine = fakeMachine()
    const stage = temp('wb-diag-stage-')
    const out = await stageDiagPackage(deps(machine), stage)
    expect(out.entries.map(e => e.path)).toContain('配置/app.json')
    const app = readFileSync(join(stage, '配置/app.json'), 'utf8')
    expect(app).toContain('/Users/<用户>/Documents')
    expect(app).not.toContain('/Users/example')
  })

  it('快照进来了,而且配对码那一格被整格换掉(它就是钥匙)', async () => {
    const machine = fakeMachine()
    const stage = temp('wb-diag-stage-')
    await stageDiagPackage(deps(machine), stage)
    const state = readFileSync(join(stage, '快照/state.json'), 'utf8')
    expect(state).not.toContain('882131')
    // 窗位切换那一环照样在,它是排"点标签卡住"的主要证据
    expect(state).toContain('recent_switches')
  })

  it('日志进来了(含轮转出来的兄弟),DSH 那个网页 token 被擦掉', async () => {
    const machine = fakeMachine()
    const stage = temp('wb-diag-stage-')
    const out = await stageDiagPackage(deps(machine), stage)
    const paths = out.entries.map(e => e.path)
    expect(paths).toContain('日志/web.stdout.log')
    expect(paths).toContain('日志/channel-worker.log')
    expect(paths).toContain('日志/channel-worker.log.2026-09-21')
    const web = readFileSync(join(stage, '日志/web.stdout.log'), 'utf8')
    expect(web).not.toContain('fakeDshLaunchTok')
    // 地址本身留着 —— 排障要看它起在哪个端口
    expect(web).toContain('127.0.0.1:3080')
  })

  it('这台机器上没有的日志,在清单第四节里如实说「没有」', async () => {
    const machine = fakeMachine()
    const stage = temp('wb-diag-stage-')
    const out = await stageDiagPackage(deps(machine), stage)
    expect(out.skipped.some(item => item.what.includes('butler.stdout.log'))).toBe(true)
    const manifest = readFileSync(join(stage, '包内清单.md'), 'utf8')
    expect(manifest).toContain('没收进来的')
  })
})

describe('体积与截断', () => {
  it('单份日志只取尾巴,截断了要在条目上标出来', async () => {
    const machine = fakeMachine()
    writeFileSync(`${machine.paths.logsDir}/web.stdout.log`, `${'一'.repeat(20_000)}\n最后这一行要留下\n`)
    const stage = temp('wb-diag-stage-')
    const out = await stageDiagPackage(deps(machine, { perLogBytes: 1024 }), stage)
    const entry = out.entries.find(e => e.path === '日志/web.stdout.log')
    expect(entry?.truncated).toBe(true)
    expect(readFileSync(join(stage, '日志/web.stdout.log'), 'utf8')).toContain('最后这一行要留下')
  })

  it('整包超上限时不再往里塞,而且每一条都记在"没收进来的"里', async () => {
    const machine = fakeMachine()
    const stage = temp('wb-diag-stage-')
    const out = await stageDiagPackage(deps(machine, { totalBytes: 600 }), stage)
    expect(out.skipped.some(item => item.why.includes('上限'))).toBe(true)
    expect(out.bytes).toBeLessThan(600 + 8000) // 清单本身是最后写的,不受上限管
  })
})

describe('文件名', () => {
  it('按本地时间戳,不是 UTC', () => {
    // 2026-09-22T02:15:30Z 在东八区是当天 10:15:30
    expect(stampOf(AT, TZ)).toBe('20260922-101530')
    expect(packNameOf(AT, TZ)).toBe('工作台诊断包-20260922-101530')
  })
})

describe('真跑一次:压成 zip 并逐条列出来', () => {
  it('ditto 压得出来,unzip 列出来的条目里没有凭据', async () => {
    const machine = fakeMachine()
    const outDir = temp('wb-diag-out-')
    const stageRoot = temp('wb-diag-stageroot-')
    const service = createDiagService({
      ...deps(machine),
      outDir,
      stageRoot,
      tzOffsetMinutes: TZ,
      link: async () => undefined,
    })
    const result = await service.export()
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.file).toBe(join(outDir, '工作台诊断包-20260922-101530.zip'))
    expect(statSync(result.file).size).toBeGreaterThan(0)
    // 暂存树用完就删(它是整份包的明文副本)
    expect(() => statSync(join(stageRoot, '工作台诊断包-20260922-101530'))).toThrow()

    // **解出来逐个文件看**,而不是 `unzip -Z1` 列名字:ditto 存的中文名没有 UTF-8 标志位,
    // unzip 列出来会把中文转成一串 `?`,那样断言"包里没有 credentials.json"是假的绿。
    // 解开之后走真文件系统,名字是什么就是什么。
    const back = temp('wb-diag-unzip-')
    execFileSync('ditto', ['-x', '-k', result.file, back])
    const names = walk(back)
    expect(names.some(name => name.endsWith('包内清单.md'))).toBe(true)
    for (const banned of EXCLUDED_NAMES) expect(names.some(name => name.endsWith(`/${banned}`))).toBe(false)
    expect(names.some(name => name.includes('login-profile'))).toBe(false)
  }, 60_000)
})

/**
 * 壳的统一日志**按时间窗取**(2026-10-02,维护者拍板「诊断包加两样」里一并要的第三件)。
 *
 * 10-02 排「网易云每隔 10s 自行打开」时,壳那一段只覆盖到 10:36—11:27 ——
 * 因为它是 `--last 7d` 再留最后 2000 行,真机上 2000 行只有 50 分钟。
 * 要查的那一段早被挤掉,所以那件事最后只能写「没查实」。
 */
describe('壳的统一日志:面包屑那一段按时间窗取', () => {
  /** 记下 `log show` 到底是怎么调的,并让它吐出一堆行。 */
  function machineWithLogShow(lineCount: number) {
    const machine = fakeMachine()
    const calls: string[][] = []
    const out = `${Array.from({ length: lineCount }, (_, index) => `Oct 02 11:27:03 mac workbench[1]: 第 ${String(index)} 行`).join('\n')}\n`
    const io: DiagIo = {
      ...machine.io,
      exec: async (cmd, options) => {
        if (cmd[0] === 'log') {
          calls.push([...cmd])
          return { ok: true, code: 0, out }
        }
        return await machine.io.exec(cmd, options)
      },
    }
    return { machine: { ...machine, io }, calls }
  }

  it('★面包屑那一段要的是最近 24 小时,不是 7 天;error / fault 照旧按天', async () => {
    const { machine, calls } = machineWithLogShow(3)
    await stageDiagPackage(deps(machine), temp('wb-diag-stage-'))
    expect(calls).toHaveLength(2)
    const errorsOnly = calls.find(cmd => cmd.some(one => one.includes('messageType')))
    const breadcrumbs = calls.find(cmd => !cmd.some(one => one.includes('messageType')))
    expect(errorsOnly?.join(' ')).toContain('--last 7d')
    expect(breadcrumbs?.join(' ')).toContain(`--last ${String(SHELL_LOG_WINDOW_HOURS)}h`)
    expect(SHELL_LOG_WINDOW_HOURS).toBeGreaterThanOrEqual(24)
  })

  it('那一段里指出「开 App 那一行」在这儿(下次查得到)', async () => {
    const { machine } = machineWithLogShow(3)
    const stage = temp('wb-diag-stage-')
    await stageDiagPackage(deps(machine), stage)
    const text = readFileSync(join(stage, '日志/壳-统一日志.txt'), 'utf8')
    expect(text).toContain(APP_OPEN_TAG)
    expect(text).toContain(`最近 ${String(SHELL_LOG_WINDOW_HOURS)} 小时`)
  })

  it('没到上限 → 说「一行都没落下」;真截了 → 说清一共多少行(不静悄悄地丢)', async () => {
    const small = machineWithLogShow(3)
    const smallStage = temp('wb-diag-stage-')
    await stageDiagPackage(deps(small.machine), smallStage)
    expect(readFileSync(join(smallStage, '日志/壳-统一日志.txt'), 'utf8')).toContain('一行都没落下')

    const big = machineWithLogShow(SHELL_LOG_LINES + 5)
    const bigStage = temp('wb-diag-stage-')
    await stageDiagPackage(deps(big.machine), bigStage)
    const text = readFileSync(join(bigStage, '日志/壳-统一日志.txt'), 'utf8')
    expect(text).toContain(`一共 ${String(SHELL_LOG_LINES + 5)} 行`)
    expect(text).toContain('5 行没进包')
    // 留的是**尾巴**:最后那一行在,最前面那一行不在。
    expect(text).toContain(`第 ${String(SHELL_LOG_LINES + 4)} 行`)
    expect(text).not.toContain('第 0 行')
  })
})
