// @vitest-environment node
/**
 * 装机形态测试:**出错那一步的原始输出,一行都不许丢**(2026-09-27,卡 PN 第二件)。
 *
 * ## 现场
 *
 * 9/27 维护者在新 MacBook Air 上看到「装进 profile 失败(退出码 127)」,展开「详细日志」
 * **整块是空的** —— 连 `$ …/node …/bin.js plugin add …` 那一行都没有,更没有 DSH 印的
 * "pnpm was not found"。没有那两行,这个失败从界面上完全无法诊断。
 *
 * ## 根因(这一份用例钉的就是它)
 *
 * `SetupJobView` 上只有两样东西能看:`tail`(**20 行的滑动窗口**)与 `note`(只留最后一条)。
 * 安装器原来按轮询从 `tail` 里取增量:`view.tail.slice(seenTail)`,而 `seenTail` 记的是
 * "看过几条" —— 窗口一满(20 条)`seenTail` 就永远是 20,`slice(20)` 永远是空数组,
 * **从此再也发不出一行日志**。npm ci 那一步几千行输出把窗口撑满之后,后面每一步都是哑的。
 *
 * 改法:作业每冒出一行就当场交出去(`SetupInstallDeps.onLine`),轮询只负责等它跑完。
 *
 * ## 顺带钉住的第二件:日志落盘
 *
 * 界面里那块日志窗口一关就没了,而排障真正要的是她**把日志发过来**。所以同一趟事件流
 * 还写一份到 `~/Library/Logs/工作台/安装-<时刻>.log`,脱敏用诊断包那一份规则。
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  installLogLine, installLogPath, parseInstallerArgs, runInstaller, withInstallLog, type InstallerEvent,
} from '../src/server/setup/installer.ts'
import { nodeSetupIo, type SetupExecOptions, type SetupIo } from '../src/server/setup/io.ts'
import { setupPaths } from '../src/server/setup/paths.ts'
import { REDACTED } from '../src/server/diagnostics/redact.ts'
import { fakePnpmExec } from './setup/pnpmFake.ts'

const dirs: string[] = []
afterEach(() => { while (dirs.length) rmSync(dirs.pop() as string, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }) })

function temp(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  dirs.push(dir)
  return dir
}

/** 失败那条命令印的东西:**50 行**(比 tail 那个 20 行的窗口长,这正是要测的)。 */
const NOISY = Array.from({ length: 48 }, (_, index) => `npm warn 第 ${index + 1} 行噪音`)
  .concat(['dsh: pnpm was not found; install pnpm and make it available on PATH.', 'dsh: plugin command failed'])

describe('安装器的事件流与日志', () => {
  it('子进程失败时,它印的每一行都进了事件流(不是只剩最后 20 行,也不是一行都没有)', async () => {
    const home = temp('wb-installer-log-home-')
    const resourcesDir = temp('wb-installer-log-res-')
    const events: InstallerEvent[] = []
    const paths = setupPaths({ home, applicationsDir: join(home, 'Applications') })
    const io: SetupIo = {
      ...nodeSetupIo(),
      // 什么文件都"在"(这一份只关心事件流,不关心安装包全不全)。
      stat: async () => ({ isFile: true, isDirectory: false, size: 1, mtimeMs: 0, executable: true }),
      copyFile: async () => {},
      mkdirp: async () => {},
      exec: async (cmd: readonly string[], opts?: SetupExecOptions) => {
        // 装插件那一步最后那条 `dsh plugin add`:印一堆,然后 127。
        if (cmd.includes('plugin') && cmd.includes('add')) {
          for (const line of NOISY) opts?.onLine?.(line)
          return { ok: false, code: 127, out: NOISY.join('\n') }
        }
        // 自带 pnpm 那一段照"装上了"回答(见 tests/setup/pnpmFake.ts)。
        const pnpm = fakePnpmExec(paths, cmd)
        if (pnpm !== undefined) return pnpm
        opts?.onLine?.('(假的)' + cmd.join(' '))
        return { ok: true, code: 0, out: '' }
      },
      uid: () => 501,
    }

    const outcome = await runInstaller({
      io,
      paths,
      bundle: {
        payloadRoot: join(resourcesDir, 'payload'),
        pluginTarball: join(resourcesDir, 'payload/plugin/x.tgz'),
        shellApp: join(resourcesDir, 'payload/app/工作台.app'),
        pnpmTarball: join(resourcesDir, 'payload/pnpm/pnpm.tgz'),
      },
      now: () => 0,
      newId: (() => { let n = 0; return () => `job-${++n}` })(),
      emit: event => events.push(event),
      pollMs: 2,
      only: ['plugin'],
    })

    expect(outcome.ok).toBe(false)
    console.log(JSON.stringify(events).slice(0, 2000))
    const logs = events.filter(event => event.t === 'log').map(event => (event as { text: string }).text)
    // ① 那条命令本身在日志里(没有它,谁也不知道是哪一步在跑什么)。
    expect(logs.some(line => line.includes('plugin') && line.includes('add'))).toBe(true)
    // ② 子进程印的**每一行**都在 —— 包括第 1 行(老实现里它早被窗口挤掉了)。
    for (const line of NOISY) expect(logs).toContain(line)
    // ③ DSH 那句原话在(这正是 9/27 那次最需要看见的一行)。
    expect(logs.some(line => line.includes('pnpm was not found'))).toBe(true)
    // ④ 失败事件照旧带着人话与尾巴。
    const failed = events.find(event => event.t === 'fail') as { error: string, tail: readonly string[] } | undefined
    expect(failed?.error).toContain('127')
    expect(failed?.tail.length).toBeGreaterThan(0)
  })

  it('日志文件:一趟一个、在 ~/Library/Logs/工作台 下、名字里带时刻', () => {
    const path = installLogPath('/Users/她', new Date(2026, 8, 27, 16, 5, 9))
    expect(path).toBe('/Users/她/Library/Logs/工作台/安装-20260927-160509.log')
  })

  it('日志文件里:命令与原文都在,凭据被擦掉,百分比不写', () => {
    expect(installLogLine({ t: 'progress', pct: 0.4 })).toBeUndefined()
    expect(installLogLine({ t: 'log', text: '$ curl http://127.0.0.1:3080/?token=abcdefgh1234' }))
      .toBe(`$ curl http://127.0.0.1:3080/?token=${REDACTED}`)
    const failLine = installLogLine({
      t: 'fail', key: 'plugin', title: '正在安装工作台…', error: '装进 profile 失败(退出码 127)',
      tail: ['dsh: pnpm was not found'], optional: false,
    })
    expect(failLine).toContain('装进 profile 失败')
    expect(failLine).toContain('pnpm was not found')
  })

  it('withInstallLog 把每条事件追加到磁盘,而且写不成也不挡安装', async () => {
    const home = temp('wb-installer-logfile-')
    const file = join(home, 'Library/Logs/工作台/安装-测试.log')
    const seen: InstallerEvent[] = []
    const emit = withInstallLog(nodeSetupIo(), file, event => seen.push(event))
    emit({ t: 'begin', total: 1 })
    emit({ t: 'log', text: 'dsh: pnpm was not found' })
    emit({ t: 'progress', pct: 0.5 })
    // 追加是串行的,等一拍让队列跑完。
    await new Promise((resolve) => { setTimeout(resolve, 50) })
    const text = readFileSync(file, 'utf8')
    expect(text).toContain('开始安装')
    expect(text).toContain('pnpm was not found')
    expect(text).not.toContain('50%')
    // 事件照常还是发给界面了(日志只是搭一程顺风车)。
    expect(seen).toHaveLength(3)

    // 写不出去(路径是个目录)也不许抛 —— 磁盘满 / 没权限不能让安装失败。
    const broken = withInstallLog(nodeSetupIo(), home, event => seen.push(event))
    expect(() => { broken({ t: 'log', text: '写不进去' }) }).not.toThrow()
  })

  it('日志路径:--log-file > WORKBENCH_INSTALL_LOG(stage0.sh 传的)> 现算一个', () => {
    const at = new Date(2026, 8, 27, 9, 0, 0)
    const base = ['--resources', '/r', '--home', '/Users/她']
    const parsed = (argv: readonly string[], env: Record<string, string | undefined> = {}): string => {
      const result = parseInstallerArgs([...base, ...argv], env, at)
      if (!result.ok) throw new Error(result.error)
      return result.args.logFile
    }
    expect(parsed(['--log-file', '/tmp/a.log'], { WORKBENCH_INSTALL_LOG: '/tmp/b.log' })).toBe('/tmp/a.log')
    expect(parsed([], { WORKBENCH_INSTALL_LOG: '/tmp/b.log' })).toBe('/tmp/b.log')
    expect(parsed([])).toBe(installLogPath('/Users/她', at))
  })
})
