// @vitest-environment node
/**
 * 「立即更新」按下去之后那一整串(2026-09-18 热更新)。
 *
 * **这里一条命令都不会真跑**:exec 是注入的假的,用例断言的是「发出了什么命令、
 * 按什么顺序跑了哪几步、跳过的那几步各说了什么话」。文件确实会真写,但全部落在
 * mktemp 出来的临时 HOME 里 —— 路径一律由 `setupPaths({ home })` 算出来。
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { fakePnpmExec, seedInstalledPnpm } from './setup/pnpmFake.ts'
import { SHELL_RELAUNCH_FLAG, progressOf, requirementOf, restartHandoffCommand, restartRescueHint, runUpdate, shellDecision } from '../src/server/update/apply.ts'
import { nodeSetupIo, type SetupExecOptions, type SetupExecResult, type SetupIo } from '../src/server/setup/io.ts'
import { DSH_LAUNCHD_LABEL, SHELL_APP_NAME, setupPaths } from '../src/server/setup/paths.ts'
import type { UpdateJobView, UpdateManifest } from '../src/server/update/types.ts'

const NOW = Date.parse('2026-09-18T10:00:00Z')
const SHA_OK = '1'.repeat(64)
const STABLE_DR = 'identifier "ai.ben.workbench" and certificate leaf = H"a8d72e0e"'
const OTHER_DR = 'cdhash H"3fb3d1b0"'

/** 假的「这是个目录」。 */
const DIR = { isFile: false, isDirectory: true, size: 0, mtimeMs: NOW, executable: false }

const dirs: string[] = []
afterEach(() => { while (dirs.length) rmSync(dirs.pop() as string, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }) })

function temp(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  dirs.push(dir)
  return dir
}

function manifestOf(kinds: readonly string[], over: Partial<UpdateManifest> = {}): UpdateManifest {
  const assets: UpdateManifest['assets'] = {}
  for (const kind of kinds) {
    assets[kind as keyof UpdateManifest['assets']] = {
      url: `http://127.0.0.1:9/updates/0.2.42/${kind}`,
      sha256: SHA_OK,
      size: 100,
    }
  }
  return { version: '0.2.42', assets, ...over }
}

interface Harness {
  home: string
  calls: { cmd: readonly string[], cwd?: string, options?: SetupExecOptions }[]
  io: SetupIo
  run: (manifest: UpdateManifest) => Promise<UpdateJobView>
}

/**
 * @param options.sha        每条 `shasum` 回什么(缺省回正确的 sha,即"下下来的东西是对的")。
 * @param options.dr         `codesign -d -r -` 对某个路径回什么 requirement。
 * @param options.installedShell  /Applications 里已经有一份壳(stat 认得它)。
 * @param options.failStep   哪一步(按 `dsh plugin` 这种 argv 前两段)要失败。
 */
function harness(options: {
  sha?: string | (() => string)
  drInstalled?: string
  drIncoming?: string
  installedShell?: boolean
  fail?: Record<string, true>
  /**
   * 壳这会儿开着没有(2026-09-21「换完壳之后自动重开」)。
   * - `gone`(缺省)—— 没开着:这一段什么都不做,既有那一批用例一条没改;
   * - `running` —— 开着,收到 quit 就真退了;
   * - `stuck` —— 开着,怎么问都还在(quit 没生效);
   * - `unknown` —— osascript 答不上来(探不出来 ≠ 没开着)。
   */
  shell?: 'gone' | 'running' | 'stuck' | 'unknown'
  /**
   * 重启那一下的保险(2026-10-13):`watchdogMs` 到点还活着就调 `hardRestart`。
   * 两样都缺 = 不设这道保险(别的用例一条都不传,所以它们一次都不会走到这里)。
   */
  watchdogMs?: number
  hardRestart?: () => void
} = {}): Harness {
  const home = temp('wb-update-apply-home-')
  const calls: Harness['calls'] = []
  /** 发过 quit 没有 —— `shell: 'running'` 那一档据此在 quit 之后改口说"退了"。 */
  let quitAsked = false
  const real = nodeSetupIo()
  const paths = setupPaths({ home })
  // 这台机器上自带的 pnpm 已经装好了(卡 PN):装插件那一步判「已经在了,不用装」——
  // 不然它会去下一份,而这一组里有用例在数"发过几条 curl"。
  seedInstalledPnpm(paths)
  const io: SetupIo = {
    ...real,
    async stat(path) {
      // 壳装没装过由用例说了算(不真去看 /Applications)。
      if (path === paths.shellApp) return options.installedShell === true ? DIR : undefined
      // tar / ditto 是假的,所以解包产物不会真落盘 —— 这里当成"解出来了"。
      // 下下来的原件是**真文件**(harness 预先写好),走真 stat,`copyFile` 才跑得动。
      if (path.includes('/updates/0.2.42/shell/')) return DIR
      if (path.includes('/updates/0.2.42/payload/')) return DIR
      return await real.stat(path)
    },
    async readFile(path) {
      // scripts / launchd 两步要读 payload 里的脚本与 plist 模板。
      if (path.includes('/payload/')) return `# 假的 ${path}\n`
      return await real.readFile(path)
    },
    async exec(cmd: readonly string[], execOptions?: SetupExecOptions): Promise<SetupExecResult> {
      // options 也记下来:重启那一下必须带 `background: true`(2026-10-13)。
      calls.push({ cmd, ...(execOptions === undefined ? {} : { options: execOptions }) })
      // 壳的「开着没有 / 退出」那两条 osascript(2026-09-21)。
      if (cmd[0] === 'osascript') {
        const script = cmd[2] ?? ''
        if (script.includes('to quit')) { quitAsked = true; return { ok: true, code: 0, out: '' } }
        if (script.includes('is running')) {
          const mode = options.shell ?? 'gone'
          if (mode === 'unknown') return { ok: false, code: 1, out: '' }
          if (mode === 'gone') return { ok: true, code: 0, out: 'false\n' }
          if (mode === 'stuck') return { ok: true, code: 0, out: 'true\n' }
          return { ok: true, code: 0, out: quitAsked ? 'false\n' : 'true\n' }
        }
      }
      const key = [cmd[0], cmd[1]].filter(Boolean).join(' ')
      if (options.fail?.[key] === true || options.fail?.[cmd[0] ?? ''] === true) {
        return { ok: false, code: 1, out: '(假的)这一条被用例设成失败了' }
      }
      // 自带 pnpm 那一段(卡 PN):装插件之前先把它放到位,这里照"装上了"回答。
      const pnpm = fakePnpmExec(paths, cmd)
      if (pnpm !== undefined) return pnpm
      if (cmd[0] === 'shasum') {
        const sha = typeof options.sha === 'function' ? options.sha() : (options.sha ?? SHA_OK)
        return { ok: true, code: 0, out: `${sha}  ${cmd[2]}` }
      }
      if (cmd[0] === 'codesign') {
        const target = cmd[cmd.length - 1] ?? ''
        const dr = target === paths.shellApp ? options.drInstalled : options.drIncoming
        if (dr === undefined) return { ok: false, code: 1, out: '' }
        return { ok: true, code: 0, out: `Executable=...\ndesignated => ${dr}\n` }
      }
      return { ok: true, code: 0, out: '' }
    },
    uid: () => 501,
  }
  return {
    home,
    calls,
    io,
    run: async (manifest) => {
      // 下下来的原件先摆好:走到 downloadAsset 时 sha 对得上就直接用(幂等那一条),
      // 对不上就真发 curl。两条路都要求这几个文件是真的存在的。
      const assetsDir = `${home}/.dsh/updates/${manifest.version}/assets`
      mkdirSync(assetsDir, { recursive: true })
      for (const name of ['plugin.tgz', 'scripts.tgz', 'shell-app.zip', 'butler-server.tgz', 'channel-worker.tgz']) {
        writeFileSync(join(assetsDir, name), '假产物')
      }
      let seq = 0
      const run = runUpdate({
        io,
        paths,
        now: () => NOW,
        newId: () => `job${(seq += 1)}`,
        currentVersion: '0.2.41',
        subPollMs: 0,
        restartDelayMs: 0,
        // 保险那一下缺省关着:别的用例一条都不该有机会真把这个进程结束掉。
        restartWatchdogMs: options.watchdogMs ?? 0,
        ...(options.hardRestart === undefined ? {} : { hardRestart: options.hardRestart }),
        // 等旧壳退出:用例里 now 是个不动的时刻,所以给一轮就够(轮数也封了顶)。
        shellQuitTimeoutMs: 20,
        shellQuitPollMs: 10,
      }, manifest)
      await run.done
      return run.view
    },
  }
}

/**
 * 这条作业真跑过的那几步(按 `dsh plugin` / `rsync` / `ditto` 这类特征认)。
 *
 * 壳那一步要把「解包」(`ditto -x -k <zip> <dir>`)和「安装」(`ditto <app> /Applications/工作台.app`)
 * 分开,**只能按 argv 逐项看,不能把整行拼成字符串再找 `-x`**:argv 里带着 mkdtemp 出来的
 * 临时 HOME,随机后缀首字母是 `x` 时路径里就有 `…home-x…`,整行找 `-x` 会误中,
 * 把安装那条也当成解包丢掉(2026-09-22,1/62 概率的偶发红)。
 */
function stepsOf(calls: readonly { cmd: readonly string[] }[]): string[] {
  const steps: string[] = []
  for (const { cmd } of calls) {
    const line = cmd.join(' ')
    if (line.includes('plugin --profile web add')) steps.push('plugin')
    else if (line.includes('launchctl bootstrap')) steps.push('launchd')
    // 事务官后端那一步换完代码要让 launchd 重起它(2026-09-25,卡 S):那是 butler 这一步的一部分,不是最后那次重启 DSH。
    else if (line.includes('launchctl kickstart') && line.includes('ai.deepseek.butler')) steps.push('butler')
    else if (line.includes('launchctl kickstart')) steps.push('restart')
    else if (cmd[0] === 'ditto' && !cmd.includes('-x') && cmd[cmd.length - 1]?.endsWith(SHELL_APP_NAME) === true) steps.push('shell')
    else if (cmd[0] === 'rsync' && line.includes('butler-server')) steps.push('butler')
    else if (cmd[0] === 'rsync' && line.includes('channel-worker')) steps.push('worker')
  }
  // 同一步里可能发好几条命令(butler 要 rsync 三次),去重但保序。
  return steps.filter((step, index) => steps.indexOf(step) === index)
}

describe('progressOf', () => {
  it('分四段,单调不回头', () => {
    expect(progressOf('download', 0, 100)).toBe(0)
    expect(progressOf('download', 100, 100)).toBe(60)
    expect(progressOf('extract', 1, 1)).toBe(65)
    expect(progressOf('install', 0, 3)).toBe(65)
    expect(progressOf('install', 3, 3)).toBe(95)
    expect(progressOf('restart', 1, 1)).toBe(100)
  })

  it('总量是 0(只有插件、清单里 size 写了 0)也不会算出 NaN', () => {
    expect(progressOf('download', 0, 0)).toBe(60)
  })
})

describe('requirementOf', () => {
  it('从 codesign 的输出里挑出那一行', () => {
    expect(requirementOf(`Executable=/x\ndesignated => ${STABLE_DR}\n`)).toBe(STABLE_DR)
  })
  it('读不出来回 undefined —— 不猜', () => {
    expect(requirementOf('Executable=/x\n')).toBeUndefined()
    expect(requirementOf('designated =>   \n')).toBeUndefined()
  })
})

describe('shellDecision', () => {
  it('没装过就装上', () => {
    expect(shellDecision(undefined, STABLE_DR, false).action).toBe('install')
  })
  it('两边逐字相同才换', () => {
    expect(shellDecision(STABLE_DR, STABLE_DR, true).action).toBe('install')
  })
  it('身份不一样就不换,并说清楚"授权会掉"', () => {
    const decision = shellDecision(STABLE_DR, OTHER_DR, true)
    expect(decision.action).toBe('skip')
    expect(decision.why).toContain('辅助功能授权')
  })
  it('哪一边读不出来都不换(D13:没查出来 ≠ 查过了没问题)', () => {
    expect(shellDecision(STABLE_DR, undefined, true).action).toBe('skip')
    expect(shellDecision(undefined, STABLE_DR, true).action).toBe('skip')
  })
})

describe('runUpdate', () => {
  it('齐全的一版:按 plugin → scripts → butler → worker → shell → launchd → 重启 跑', async () => {
    const h = harness({ drInstalled: STABLE_DR, drIncoming: STABLE_DR, installedShell: true })
    const view = await h.run(manifestOf(['plugin_tgz', 'scripts_tgz', 'shell_app_zip', 'butler_server_tgz', 'channel_worker_tgz']))
    expect(view.state).toBe('done')
    expect(stepsOf(h.calls)).toEqual(['plugin', 'butler', 'worker', 'shell', 'launchd', 'restart'])
    expect(view.restarting).toBe(true)
    expect(view.progress).toBe(100)
  })

  it('只带插件的那种小更新:别的几步各跳过一句人话,不静默', async () => {
    const h = harness()
    const view = await h.run(manifestOf(['plugin_tgz']))
    expect(view.state).toBe('done')
    expect(stepsOf(h.calls)).toEqual(['plugin', 'restart'])
    expect(view.skipped.join('\n')).toContain('启动脚本')
    expect(view.skipped.join('\n')).toContain('事务官本机后端')
  })

  it('壳的签名身份对不上就不换壳,别的照更,并在结尾说清为什么', async () => {
    const h = harness({ drInstalled: STABLE_DR, drIncoming: OTHER_DR, installedShell: true })
    const view = await h.run(manifestOf(['plugin_tgz', 'shell_app_zip']))
    expect(view.state).toBe('done')
    expect(stepsOf(h.calls)).not.toContain('shell')
    expect(view.skipped.join('\n')).toContain('辅助功能授权')
  })

  it('下下来的东西跟 sha256 对不上:删掉重下一趟,还不对就抛人话、不留坏包', async () => {
    const h = harness({ sha: '9'.repeat(64) })
    const view = await h.run(manifestOf(['plugin_tgz']))
    expect(view.state).toBe('failed')
    expect(view.error).toContain('校验和对不上')
    // 两趟 curl(第一趟续传、第二趟从零),而且**没有**往下跑安装。
    expect(h.calls.filter(c => c.cmd[0] === 'curl')).toHaveLength(2)
    expect(stepsOf(h.calls)).toEqual([])
  })

  it('第一趟带 -C -(续传),第二趟不带(接在坏字节后面是最常见的错法)', async () => {
    const h = harness({ sha: '9'.repeat(64) })
    await h.run(manifestOf(['plugin_tgz']))
    const curls = h.calls.filter(c => c.cmd[0] === 'curl').map(c => c.cmd.join(' '))
    expect(curls[0]).toContain('-C -')
    expect(curls[1]).not.toContain('-C -')
  })

  it('某一步装失败:整条作业失败,话里带着那一步的名字,重启不发', async () => {
    const h = harness({ fail: { rsync: true } })
    const view = await h.run(manifestOf(['plugin_tgz', 'butler_server_tgz']))
    expect(view.state).toBe('failed')
    expect(view.error).toContain('事务官本机后端')
    expect(stepsOf(h.calls)).not.toContain('restart')
  })

  /**
   * 2026-10-13(0.4.115 装完没自己起来):这一组钉的是**那一下不许依赖发它的进程还活着**。
   * 机理与那四个读数见 `docs/交接-1013-热更新装完重启没起来.md`。
   */
  describe('重启那一下', () => {
    it('交给一个 detach 出去的 sh,等那一拍等在它的 sleep 里 —— 不在这个进程的定时器里', async () => {
      const h = harness()
      await h.run(manifestOf(['plugin_tgz']))
      const kick = h.calls.find(c => c.cmd.join(' ').includes('kickstart'))
      // 用例里 restartDelayMs=0,所以不带 sleep;生产那 1.5 秒由 restartHandoffCommand 拼。
      expect(kick?.cmd).toEqual(restartHandoffCommand(`gui/501/${DSH_LAUNCHD_LABEL}`, 0))
      expect(kick?.options?.background).toBe(true)
    })

    it('发的还是 kickstart -k gui/<uid>/<label>(跟登录台那颗「重启 DSH」同一条)', async () => {
      const h = harness()
      await h.run(manifestOf(['plugin_tgz']))
      const kick = h.calls.find(c => c.cmd.join(' ').includes('kickstart'))
      expect(kick?.cmd[kick.cmd.length - 1]).toContain(`launchctl kickstart -k gui/501/${DSH_LAUNCHD_LABEL}`)
    })

    it('连发都没发出去:如实说一句 + 给救法,不静默(今天是 void io.exec,一个字都不留)', async () => {
      const h = harness({ fail: { '/bin/sh': true } })
      const view = await h.run(manifestOf(['plugin_tgz']))
      // 装是真装上了,所以这条作业还是 done —— 没成的只有重启那一下。
      expect(view.state).toBe('done')
      expect(view.skipped).toContain(restartRescueHint(`gui/501/${DSH_LAUNCHD_LABEL}`))
      expect(view.note).toContain('launchctl kickstart gui/501/')
      expect(view.tail.join('\n')).toContain('重启那一下没发出去')
    })

    it('保险:到点这个进程还活着就以非 0 退出(让 KeepAlive.SuccessfulExit=false 拉起),并在磁盘上留一行', async () => {
      let hard = 0
      const h = harness({ watchdogMs: 20, hardRestart: () => { hard += 1 } })
      await h.run(manifestOf(['plugin_tgz']))
      expect(hard).toBe(0) // 刚装完那一刻不动手
      await new Promise<void>((resolve) => { setTimeout(resolve, 120) })
      expect(hard).toBe(1)
      // 内存里那份日志跟着进程一起没,所以这一行要落盘。
      expect(readFileSync(`${h.home}/.dsh/updates/restart.log`, 'utf8')).toContain('以非 0 退出')
    })

    it('一样都没要换的那一趟不重启,也不设保险', async () => {
      let hard = 0
      const h = harness({ watchdogMs: 20, hardRestart: () => { hard += 1 } })
      // 本机那份跟清单逐位相同 → 整件跳过 → steps 为空(「已经是最新的了」那一支)。
      mkdirSync(`${h.home}/.dsh/updates`, { recursive: true })
      writeFileSync(`${h.home}/.dsh/updates/installed.json`, JSON.stringify({
        assets: { plugin_tgz: { sha256: SHA_OK, version: '0.2.42', at: new Date(NOW).toISOString() } },
      }))
      const view = await h.run(manifestOf(['plugin_tgz']))
      expect(stepsOf(h.calls)).not.toContain('restart')
      expect(view.note).toContain('不用重启')
      await new Promise<void>((resolve) => { setTimeout(resolve, 120) })
      expect(hard).toBe(0)
    })
  })

  describe('restartHandoffCommand', () => {
    it('那一拍写成 sh 里的 sleep,再 exec 成 launchctl(中间不多挂一个进程)', () => {
      expect(restartHandoffCommand('gui/501/ai.deepseek.dsh', 1500)).toEqual([
        '/bin/sh', '-c', 'sleep 1.5; exec launchctl kickstart -k gui/501/ai.deepseek.dsh',
      ])
    })

    it('不等那一拍就不带 sleep', () => {
      expect(restartHandoffCommand('gui/501/ai.deepseek.dsh', 0)).toEqual([
        '/bin/sh', '-c', 'exec launchctl kickstart -k gui/501/ai.deepseek.dsh',
      ])
    })
  })

  describe('restartRescueHint', () => {
    it('先说窗口会自己拉一次,终端那一句**不带 -k**(对还在跑的项它什么都不做)', () => {
      const hint = restartRescueHint('gui/501/ai.deepseek.dsh')
      expect(hint).toContain('工作台窗口')
      expect(hint).toContain('launchctl kickstart gui/501/ai.deepseek.dsh')
      expect(hint).not.toContain('kickstart -k')
    })
  })

  it('payload 落在 ~/.dsh/updates/<版本>/ 底下,一处都不往别的地方写', async () => {
    const h = harness()
    await h.run(manifestOf(['plugin_tgz', 'scripts_tgz']))
    const paths = h.calls.flatMap(c => c.cmd).filter(arg => arg.includes('/updates/'))
    expect(paths.length).toBeGreaterThan(0)
    for (const path of paths) expect(path.startsWith(`${h.home}/.dsh/updates/0.2.42/`)).toBe(true)
  })

  it('已经下好过就不重下(整条 apply 的幂等靠这一条)', async () => {
    // sha 一直回对的 → downloadAsset 进门那一步就命中,curl 一次都不发。
    const h = harness()
    await h.run(manifestOf(['plugin_tgz']))
    expect(h.calls.filter(c => c.cmd[0] === 'curl')).toHaveLength(0)
    expect(h.calls.filter(c => c.cmd[0] === 'shasum').length).toBeGreaterThan(0)
  })
})

/**
 * 换完壳之后自动重开(2026-09-21)。以前这一步只能在界面上写一句「把工作台窗口关掉重开一次」
 * —— 屏幕上跑着的还是换之前那份二进制。
 *
 * 这里一条命令都不会真跑:断言的是**发了哪几条、什么顺序**。
 */
describe('换完壳:先让旧壳优雅退出,再 open', () => {
  const FULL = ['plugin_tgz', 'shell_app_zip'] as const
  const withShell = (shell: 'gone' | 'running' | 'stuck' | 'unknown') =>
    harness({ drInstalled: STABLE_DR, drIncoming: STABLE_DR, installedShell: true, shell })

  /** 这一条作业里跟壳有关的那几条命令,按发出的顺序。 */
  function shellCalls(calls: readonly { cmd: readonly string[] }[]): string[] {
    const out: string[] = []
    for (const { cmd } of calls) {
      const line = cmd.join(' ')
      if (cmd[0] === 'osascript' && line.includes('is running')) out.push('ask')
      else if (cmd[0] === 'osascript' && line.includes('to quit')) out.push('quit')
      else if (cmd[0] === 'open') out.push('open')
      else if (line.includes('launchctl kickstart')) out.push('restart')
    }
    return out
  }

  it('★壳开着:问 → quit → 等它真退了 → open,最后才 kickstart', async () => {
    const h = withShell('running')
    const view = await h.run(manifestOf([...FULL]))
    expect(view.state).toBe('done')
    const order = shellCalls(h.calls)
    expect(order.indexOf('quit')).toBeGreaterThanOrEqual(0)
    expect(order.indexOf('open')).toBeGreaterThan(order.indexOf('quit'))
    // kickstart 会把跑着这个作业的进程杀掉 —— 它必须排在最后,否则 open 那一行轮不到。
    expect(order.indexOf('restart')).toBeGreaterThan(order.indexOf('open'))
    // 第一条一定是"先问它开着没有",不是上来就 quit。
    expect(order[0]).toBe('ask')
  })

  it('★拉起来时带那个参数(壳据此知道这一趟不是他点的图标)', async () => {
    const h = withShell('running')
    await h.run(manifestOf([...FULL]))
    const opened = h.calls.find(c => c.cmd[0] === 'open')
    // 壳装在 /Applications(setupPaths 里那条绝对路径),不跟着临时 HOME 走。
    expect(opened?.cmd).toEqual(['open', '-n', '/Applications/工作台.app', '--args', SHELL_RELAUNCH_FLAG])
    expect(SHELL_RELAUNCH_FLAG).toBe('--relaunched-by-update')
  })

  it('★壳本来就没开着 → 一条 quit、一条 open 都不发(不替他凭空开一扇窗)', async () => {
    const h = withShell('gone')
    await h.run(manifestOf([...FULL]))
    expect(shellCalls(h.calls)).toEqual(['ask', 'restart'])
  })

  it('★这一版没带壳 → 整段不发生(连问都不问)', async () => {
    const h = harness({ shell: 'running' })
    await h.run(manifestOf(['plugin_tgz']))
    expect(shellCalls(h.calls)).toEqual(['restart'])
  })

  it('★签名对不上、这次根本没换壳 → 也不该去动那扇窗', async () => {
    const h = harness({ drInstalled: STABLE_DR, drIncoming: OTHER_DR, installedShell: true, shell: 'running' })
    const view = await h.run(manifestOf([...FULL]))
    expect(shellCalls(h.calls)).toEqual(['restart'])
    expect(view.skipped.join('')).toContain('辅助功能授权')
  })

  it('★quit 了但它没退 → 不强杀,如实告诉他自己关掉重开一次', async () => {
    const h = withShell('stuck')
    const view = await h.run(manifestOf([...FULL]))
    expect(shellCalls(h.calls)).not.toContain('open')
    // 强杀会把他摆了半天的窗口位置连同进程一起丢掉 —— 省一句话,赔一个位置。
    expect(h.calls.some(c => c.cmd[0] === 'kill' || c.cmd.join(' ').includes('pkill'))).toBe(false)
    expect(view.skipped.join('')).toContain('关掉再打开一次')
    expect(view.state).toBe('done')
  })

  it('★问不出它开着没有 → 既不 quit 也不 open,并且如实说一句(探不出来 ≠ 没开着)', async () => {
    const h = withShell('unknown')
    const view = await h.run(manifestOf([...FULL]))
    expect(shellCalls(h.calls)).toEqual(['ask', 'restart'])
    expect(view.skipped.join('')).toContain('没能确认')
  })

  it('★open 失败 → 作业照样算成了,但界面上要看得见那一句', async () => {
    const h = harness({
      drInstalled: STABLE_DR, drIncoming: STABLE_DR, installedShell: true, shell: 'running',
      fail: { open: true },
    })
    const view = await h.run(manifestOf([...FULL]))
    expect(view.state).toBe('done')
    expect(view.skipped.join('')).toContain('双击')
  })
})
