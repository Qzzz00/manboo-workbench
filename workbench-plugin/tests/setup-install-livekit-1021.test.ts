// @vitest-environment node
/**
 * 一键装 / 安装器 / 热更新共用的那一步:**装本机房间**(局域网主路卡 M1,2026-10-21)。
 *
 * 一条命令都不真跑(exec 是假的);文件真写,全落在 mktemp 出来的临时 HOME 与「仓库」(payload 的样子)里。
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createSetupInstaller } from '../src/server/setup/install.ts'
import { nodeSetupIo, type SetupExecOptions, type SetupIo } from '../src/server/setup/io.ts'
import { LIVEKIT_LAUNCHD_LABEL, LIVEKIT_SERVER_VERSION, setupPaths } from '../src/server/setup/paths.ts'
import { SETUP_INSTALL_STEPS, type SetupInstallStep, type SetupJobView } from '../src/server/setup/types.ts'

const MACHINE = '3f9c0a1b22223333444455556666777a'
const dirs: string[] = []
afterEach(() => { while (dirs.length) rmSync(dirs.pop() as string, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }) })

function temp(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  dirs.push(dir)
  return dir
}

function put(path: string, text: string, mode?: number): void {
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, text, mode === undefined ? 'utf8' : { encoding: 'utf8', mode })
}

/** payload / 仓库里本机房间那几样。 */
function seedLivekit(repo: string, options: { binary?: boolean, start?: boolean, plist?: boolean } = {}): void {
  if (options.binary !== false) {
    put(join(repo, 'livekit/livekit-server'), '#!/bin/sh\n# 假的 livekit-server\n', 0o755)
    put(join(repo, 'livekit/LICENSE'), 'Apache License 2.0\n')
    put(join(repo, 'livekit/NOTICE'), 'LiveKit NOTICE\n')
  }
  if (options.start !== false) put(join(repo, 'deploy/livekit-start'), '#!/usr/bin/env bash\n# livekit-start\n')
  if (options.plist !== false) put(join(repo, `deploy/${LIVEKIT_LAUNCHD_LABEL}.plist`), '<plist><string>{{HOME}}/.dsh/bin/livekit-start</string></plist>')
}

interface Harness {
  home: string
  repo: string
  paths: ReturnType<typeof setupPaths>
  calls: (readonly string[])[]
  lines: string[]
  run: (step: SetupInstallStep) => Promise<SetupJobView>
}

function harness(options: {
  macos?: string
  version?: string
  /** `shasum` 对两份(源、已装)各回什么。缺省两份不同。 */
  sameSha?: boolean
  bootstrap?: { ok: boolean, code: number, out: string }
} = {}): Harness {
  const home = temp('wb-lk-install-home-')
  const repo = temp('wb-lk-install-repo-')
  const paths = setupPaths({ home })
  const calls: (readonly string[])[] = []
  const lines: string[] = []
  const io: SetupIo = {
    ...nodeSetupIo(),
    exec: async (cmd: readonly string[], opts?: SetupExecOptions) => {
      calls.push(cmd)
      opts?.onLine?.(`(假的)${cmd.join(' ')}`)
      if (cmd[0] === 'sw_vers') return { ok: true, code: 0, out: `${options.macos ?? '26.6.2'}\n` }
      if (cmd[0] === 'shasum') {
        const file = cmd[cmd.length - 1] ?? ''
        const sha = options.sameSha === true || file.startsWith(repo) ? 'a'.repeat(64) : 'b'.repeat(64)
        return { ok: true, code: 0, out: `${sha}  ${file}\n` }
      }
      if (cmd[1] === '--version') return { ok: true, code: 0, out: `livekit-server version ${options.version ?? LIVEKIT_SERVER_VERSION}\n` }
      if (cmd[0] === 'launchctl' && cmd[1] === 'bootstrap' && options.bootstrap !== undefined) return options.bootstrap
      return { ok: true, code: 0, out: '' }
    },
    uid: () => 501,
  }
  const installer = createSetupInstaller({
    io,
    paths,
    repoRoot: repo,
    now: () => Date.parse('2026-10-21T12:00:00Z'),
    newId: (() => { let n = 0; return () => `job-${++n}` })(),
    machineId: async () => MACHINE,
    onLine: (_step, _kind, text) => { lines.push(text) },
  })
  return {
    home,
    repo,
    paths,
    calls,
    lines,
    run: async (step) => {
      const job = installer.start(step)
      await installer.wait(job.id)
      return installer.job(job.id) as SetupJobView
    },
  }
}

describe('装本机房间(livekit 那一步)', () => {
  it('在步骤表里,排在通话组件后面、壳与开机自启前面', () => {
    const steps = [...SETUP_INSTALL_STEPS]
    expect(steps).toContain('livekit')
    expect(steps.indexOf('livekit')).toBeGreaterThan(steps.indexOf('worker'))
    expect(steps.indexOf('livekit')).toBeLessThan(steps.indexOf('web_login'))
  })

  it('★装上:先放 .new 再换名、755、去「来自网络」标记、核版本、写两份配置、装启动脚本与 launchd 项', async () => {
    const h = harness()
    seedLivekit(h.repo)
    const job = await h.run('livekit')
    expect(job.state, job.error).toBe('done')

    expect(readFileSync(h.paths.livekitBin, 'utf8')).toContain('假的 livekit-server')
    expect(statSync(h.paths.livekitBin).mode & 0o777).toBe(0o755)
    expect(existsSync(`${h.paths.livekitBin}.new`)).toBe(false)
    expect(readFileSync(join(h.paths.livekitDir, 'NOTICE'), 'utf8')).toContain('LiveKit')
    expect(h.calls).toContainEqual(['xattr', '-dr', 'com.apple.quarantine', h.paths.livekitDir])
    expect(h.calls).toContainEqual([h.paths.livekitBin, '--version'])

    // 两份配置:0600、钥匙同一对、房间名按机器 id。
    expect(statSync(h.paths.channelJson).mode & 0o777).toBe(0o600)
    expect(statSync(h.paths.livekitYaml).mode & 0o777).toBe(0o600)
    const channel = JSON.parse(readFileSync(h.paths.channelJson, 'utf8')) as { url: string, room: string, api_key: string, api_secret: string }
    expect(channel.url).toBe('ws://127.0.0.1:7880')
    expect(channel.room).toBe('wb-local-3f9c0a1b')
    expect(readFileSync(h.paths.livekitYaml, 'utf8')).toContain(`"${channel.api_key}": "${channel.api_secret}"`)

    // 启动脚本与 launchd 项:渲染成本机路径、bootstrap。
    expect(statSync(h.paths.livekitStart).mode & 0o111).toBeTruthy()
    const plist = readFileSync(h.paths.livekitPlist, 'utf8')
    expect(plist).toContain(`${h.home}/.dsh/bin/livekit-start`)
    expect(h.calls).toContainEqual(['launchctl', 'bootstrap', 'gui/501', h.paths.livekitPlist])

    // secret 不进作业的任何一行(tail、note、逐行推出去的那些)。
    const everything = [...job.tail, job.note ?? '', ...h.lines].join('\n')
    expect(everything).not.toContain(channel.api_secret)
    expect(job.note).toContain('防火墙')
  })

  it('已经装过(launchd 里已有这一项):不报错,改成 kickstart -k 让它换上新的二进制与配置', async () => {
    const h = harness({ bootstrap: { ok: false, code: 5, out: 'service already loaded' } })
    seedLivekit(h.repo)
    const job = await h.run('livekit')
    expect(job.state, job.error).toBe('done')
    expect(h.calls).toContainEqual(['launchctl', 'kickstart', '-k', `gui/501/${LIVEKIT_LAUNCHD_LABEL}`])
  })

  it('二进制跟装着的那份一模一样:不重拷(重签过的那份换一次,系统防火墙就要再问一次)', async () => {
    const h = harness({ sameSha: true })
    seedLivekit(h.repo)
    put(h.paths.livekitBin, '装着的那一份', 0o755)
    const job = await h.run('livekit')
    expect(job.state, job.error).toBe('done')
    expect(readFileSync(h.paths.livekitBin, 'utf8')).toBe('装着的那一份')
  })

  it('macOS 14:如实跳过(不算失败),一样都不装', async () => {
    const h = harness({ macos: '14.6.1' })
    seedLivekit(h.repo)
    const job = await h.run('livekit')
    expect(job.state).toBe('done')
    expect(job.note).toContain('14.6.1')
    expect(existsSync(h.paths.livekitBin)).toBe(false)
    expect(existsSync(h.paths.channelJson)).toBe(false)
  })

  it('安装包里没有二进制:失败,回一句人话', async () => {
    const h = harness()
    seedLivekit(h.repo, { binary: false })
    const job = await h.run('livekit')
    expect(job.state).toBe('failed')
    expect(job.error).toContain('本机通话服务')
  })

  it('跑出来的版本不对:失败(不把一份认不出的东西当成装好了)', async () => {
    const h = harness({ version: '1.9.0' })
    seedLivekit(h.repo)
    const job = await h.run('livekit')
    expect(job.state).toBe('failed')
    expect(job.error).toContain(LIVEKIT_SERVER_VERSION)
  })

  it('拷来的云上那份 channel.json:二进制照装,配置不碰,作业说清楚', async () => {
    const h = harness()
    seedLivekit(h.repo)
    const cloud = JSON.stringify({ url: 'wss://lk.example.cn', api_key: 'APIcloud', api_secret: 'c'.repeat(40) })
    put(h.paths.channelJson, cloud)
    const job = await h.run('livekit')
    expect(job.state, job.error).toBe('done')
    expect(readFileSync(h.paths.channelJson, 'utf8')).toBe(cloud)
    expect(existsSync(h.paths.livekitYaml)).toBe(false)
    expect(job.note).toContain('lk.example.cn')
  })
})

describe('启动脚本与开机自启那两步多一项', () => {
  function seedCore(repo: string): void {
    put(join(repo, 'workbench-plugin/bin/dsh-start'), '#!/usr/bin/env bash\nexport WORKBENCH_BUTLER_CWD="$HOME/x"\n')
    put(join(repo, 'workbench-plugin/bin/butler-start'), '#!/usr/bin/env bash\n')
    put(join(repo, 'deploy/channel-start'), '#!/usr/bin/env bash\n')
    put(join(repo, 'deploy/ai.deepseek.dsh.plist'), '<plist><string>{{HOME}}/.dsh/bin/dsh-start</string></plist>')
    put(join(repo, 'butler-server/launchd/ai.deepseek.butler.plist'), '<plist><string>/Users/somebody/.dsh/bin/butler-start</string></plist>')
  }

  it('scripts:仓库里有 livekit-start 就装成 755', async () => {
    const h = harness()
    seedCore(h.repo)
    seedLivekit(h.repo, { binary: false })
    const job = await h.run('scripts')
    expect(job.state, job.error).toBe('done')
    expect(statSync(h.paths.livekitStart).mode & 0o111).toBeTruthy()
  })

  it('launchd:三份 plist 都渲染、都 bootstrap', async () => {
    const h = harness()
    seedCore(h.repo)
    seedLivekit(h.repo, { binary: false })
    const job = await h.run('launchd')
    expect(job.state, job.error).toBe('done')
    const boots = h.calls.filter(cmd => cmd[0] === 'launchctl' && cmd[1] === 'bootstrap').map(cmd => cmd[3])
    expect(boots).toEqual([h.paths.dshPlist, h.paths.butlerPlist, h.paths.livekitPlist])
    expect(readFileSync(h.paths.livekitPlist, 'utf8')).toContain(`${h.home}/.dsh/bin/livekit-start`)
  })

  it('老的 payload 里没有本机房间那两份:那两步照旧做完另外几样,并说一句', async () => {
    const h = harness()
    seedCore(h.repo)
    expect((await h.run('scripts')).state).toBe('done')
    const job = await h.run('launchd')
    expect(job.state).toBe('done')
    expect(existsSync(h.paths.livekitPlist)).toBe(false)
    expect(job.tail.join('\n')).toContain('livekit')
  })
})
