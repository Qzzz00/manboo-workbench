// @vitest-environment node
/**
 * **装机形态测试:语音后端随安装走**(2026-09-25,卡 S「手机在哪都能用」第 4 件)。
 *
 * 在外面按住说话,录音最后落在电脑上的事务官本机后端(butler-server 的 `/api/asr`)——
 * 与在家里直连是同一个后端(channel-worker/src/asrRelay.ts 经 8791 的 `/butler/proxy/api/asr` 交给它)。
 * 所以它必须**随安装走**:装好的机器上身边没有开发仓库,它得由 launchd 从 `~/.dsh` 里起来、8791 找得到它。
 * 维护者那台恰好有开发仓库,在它上面通了不算数(验收清单第零节「装好的机器、身边没有开发仓库」)。
 *
 * 这里就在那个形态下跑一遍:
 *   1. 摆一份与安装包一样的 payload —— 只放 deploy/build-installer.sh 打进去的那几样(butler-server 的
 *      server / node_modules / package.json、plist 模板、三个启动脚本);
 *   2. 从它装:真跑 install.ts 的 scripts / butler / launchd 三步(rsync 是真的),HOME 是临时目录,
 *      launchctl 是假的(只记下来,不碰这台机器的 launchd);
 *   3. 像 launchd 那样起:读**装好的** plist,照它写的 ProgramArguments / WorkingDirectory 起子进程
 *      (HOME 是临时目录、PATH 只有 node 所在那一格与系统目录、不给任何仓库路径、不去 8791 拉钥匙);
 *   4. 断言:/health 通;`/api/asr` 答话(这台临时机器没有识别钥匙 → 503 + 一句人话;**不发任何真的识别**);
 *      进程的入口与工作目录都在临时 HOME 的 `~/.dsh/butler-server` 里,一个字不指向仓库;
 *      8791 的代理(真的 http.ts + butler.ts)按临时 HOME 里的 butler.json 找到它 —— 工人替配对过的手机转录音
 *      的那一下(回环 + `X-Workbench-Channel-Device` + 裸 WAV)拿到的就是它那句 503;解除配对的手机 401;
 *   5. butler 那一步装完就让 launchd 重起它(热更新换了代码要当场生效,见 install.ts)。
 *
 * 这台机器真的 `~/.dsh`、launchd、8791 / 8792 一个都碰不到:子进程的 HOME 是临时目录、端口是临时挑的。
 */
import { type ChildProcess, execFileSync, spawn, spawnSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { closeSync, copyFileSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createButlerService } from '../src/server/butler.ts'
import { createPairingService } from '../src/server/devices.ts'
import { startWorkbenchServer, type WorkbenchServer } from '../src/server/http.ts'
import { createWorkbenchService } from '../src/server/service.ts'
import { createSetupInstaller } from '../src/server/setup/install.ts'
import { nodeSetupIo, type SetupExecOptions, type SetupIo } from '../src/server/setup/io.ts'
import { setupPaths } from '../src/server/setup/paths.ts'
import type { SetupInstallStep, SetupJobView } from '../src/server/setup/types.ts'

const PLUGIN = fileURLToPath(new URL('..', import.meta.url)).replace(/\/$/, '')
const REPO = dirname(PLUGIN)
const BOX_PREFIX = join(tmpdir(), 'wb-install-shape-voice-')

let box = ''
let home = ''
let payload = ''
let child: ChildProcess | undefined
let workbench: WorkbenchServer | undefined
let port = 0
/** 在装好的这台临时机器上再跑一步安装(热更新走的就是这几步)。 */
let run: (step: SetupInstallStep) => Promise<SetupJobView> = async () => { throw new Error('还没装') }
/** 假 launchctl 收到的每一条(不执行)。 */
const launchctl: string[][] = []
/** launchd 项「装没装」:bootstrap 之前 kickstart 找不到它(新机器),之后找得到(热更新)。 */
let loaded = false

/** 2026-09-04 事故之后的纪律:递归删除只许落在本用例 mkdtemp 出来的那一个沙箱里。 */
afterAll(async () => {
  await workbench?.close().catch(() => {})
  if (child !== undefined && child.exitCode === null) {
    child.kill('SIGTERM')
    await new Promise(done => setTimeout(done, 300))
    if (child.exitCode === null) child.kill('SIGKILL')
  }
  if (box === '' || !box.startsWith(BOX_PREFIX) || box.slice(BOX_PREFIX.length).includes('/')) return
  rmSync(box, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
})

async function freePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const server = createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const got = (server.address() as { port: number }).port
      server.close(() => resolve(got))
    })
  })
}

/** 一段很短的 16k WAV(静音)。 */
function wav(seconds = 0.2): Buffer {
  const samples = Math.round(16000 * seconds)
  const buf = Buffer.alloc(44 + samples * 2)
  buf.write('RIFF', 0, 'ascii'); buf.writeUInt32LE(36 + samples * 2, 4); buf.write('WAVE', 8, 'ascii')
  buf.write('fmt ', 12, 'ascii'); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(1, 22)
  buf.writeUInt32LE(16000, 24); buf.writeUInt32LE(32000, 28); buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34)
  buf.write('data', 36, 'ascii'); buf.writeUInt32LE(samples * 2, 40)
  return buf
}

function stringsOf(plist: string, key: string): string[] {
  const at = plist.indexOf(`<key>${key}</key>`)
  if (at < 0) return []
  const rest = plist.slice(at + key.length + 11)
  const block = rest.trimStart().startsWith('<array>') ? rest.slice(0, rest.indexOf('</array>')) : rest.slice(0, rest.indexOf('</string>') + 9)
  return [...block.matchAll(/<string>([^<]*)<\/string>/g)].map(m => m[1] ?? '')
}

async function waitHealthy(url: string, timeoutMs: number): Promise<Record<string, unknown>> {
  const deadline = Date.now() + timeoutMs
  let last = ''
  while (Date.now() < deadline) {
    if (child?.exitCode !== null && child?.exitCode !== undefined) throw new Error(`后端退出了(退出码 ${child.exitCode}),日志见 ${box}/logs`)
    try {
      const res = await fetch(`${url}/health`, { signal: AbortSignal.timeout(1000) })
      if (res.ok) return await res.json() as Record<string, unknown>
      last = `HTTP ${res.status}`
    }
    catch (err) { last = (err as Error).message }
    await new Promise(done => setTimeout(done, 200))
  }
  throw new Error(`等 ${url}/health 等了 ${timeoutMs}ms 没通(${last}),日志见 ${box}/logs`)
}

beforeAll(async () => {
  box = mkdtempSync(BOX_PREFIX)
  home = join(box, 'home')
  payload = join(box, 'payload')
  mkdirSync(home, { recursive: true })
  mkdirSync(join(box, 'logs'), { recursive: true })

  // ① payload:照 deploy/build-installer.sh 第 4 节收的那几样(最后一个用例核对两边对得上)。
  for (const rel of ['workbench-plugin/bin', 'deploy', 'butler-server/launchd']) mkdirSync(join(payload, rel), { recursive: true })
  for (const rel of ['workbench-plugin/bin/dsh-start', 'workbench-plugin/bin/butler-start', 'deploy/channel-start', 'deploy/ai.deepseek.dsh.plist', 'butler-server/launchd/ai.deepseek.butler.plist', 'butler-server/package.json']) {
    copyFileSync(join(REPO, rel), join(payload, rel))
  }
  for (const part of ['server', 'node_modules']) {
    mkdirSync(join(payload, 'butler-server', part), { recursive: true })
    execFileSync('rsync', ['-a', `${join(REPO, 'butler-server', part)}/`, `${join(payload, 'butler-server', part)}/`])
  }

  // ② 从 payload 装:scripts / butler / launchd 三步,rsync 真跑,launchctl 只记下来。
  const io: SetupIo = {
    ...nodeSetupIo(),
    exec: async (cmd: readonly string[], options?: SetupExecOptions) => {
      if (cmd[0] === 'launchctl') {
        launchctl.push([...cmd])
        if (cmd[1] === 'bootstrap') { loaded = true; return { ok: true, code: 0, out: '' } }
        if (cmd[1] === 'kickstart') return loaded ? { ok: true, code: 0, out: '' } : { ok: false, code: 113, out: 'Could not find service' }
        return { ok: true, code: 0, out: '' }
      }
      if (cmd[0] !== 'rsync') throw new Error(`这份用例没料到要跑 ${cmd.join(' ')}`)
      const done = spawnSync(cmd[0], cmd.slice(1), { encoding: 'utf8', ...(options?.cwd === undefined ? {} : { cwd: options.cwd }) })
      return { ok: done.status === 0, code: done.status ?? -1, out: `${done.stdout ?? ''}${done.stderr ?? ''}` }
    },
  }
  const installer = createSetupInstaller({
    io,
    paths: setupPaths({ home, repoRoot: payload, applicationsDir: join(home, 'Applications') }),
    repoRoot: payload,
    recordButlerCwd: false,
    now: () => Math.floor(Date.now() / 1000),
    newId: (() => { let n = 0; return () => `job-${++n}` })(),
  })
  run = async (step: SetupInstallStep): Promise<SetupJobView> => {
    const job = installer.start(step)
    await installer.wait(job.id)
    return installer.job(job.id) as SetupJobView
  }
  for (const step of ['scripts', 'butler', 'launchd'] as const) {
    const job = await run(step)
    if (job.state !== 'done') throw new Error(`装 ${step} 没成:${job.error ?? ''}\n${job.tail.join('\n')}`)
  }

  // 这台临时机器上「用过一次」的配置(端口是临时挑的:这台 Mac 的 8792 上正跑着真的那一份)。
  port = await freePort()
  mkdirSync(join(home, '.dsh', 'workbench'), { recursive: true })
  writeFileSync(join(home, '.dsh', 'workbench', 'butler.json'), `${JSON.stringify({ version: 1, port, token: randomBytes(32).toString('hex') }, null, 2)}\n`, { mode: 0o600 })

  // ③ 像 launchd 那样起:读装好的 plist。
  const plist = readFileSync(join(home, 'Library', 'LaunchAgents', 'ai.deepseek.butler.plist'), 'utf8')
  const program = stringsOf(plist, 'ProgramArguments')
  const workDir = stringsOf(plist, 'WorkingDirectory')[0] ?? ''
  const out = openSync(join(box, 'logs', 'butler.log'), 'a')
  child = spawn(program[0] ?? '', program.slice(1), {
    cwd: workDir,
    env: {
      HOME: home,
      // 只给 node 所在那一格与系统目录:butler-start 找不到 ~/.dsh/node 时退回 PATH 里的 node(新机器装 node 那一步不在这份用例里)。
      PATH: `${dirname(process.execPath)}:/usr/bin:/bin`,
      // 不去这台 Mac 真的 8791 拉语音钥匙:临时机器就该是「没有钥匙」。
      BUTLER_WORKBENCH_URL: 'off',
    },
    stdio: ['ignore', out, out],
  })
  closeSync(out)
  await waitHealthy(`http://127.0.0.1:${port}`, 20_000)
}, 180_000)

describe('装好的机器上,语音后端由 launchd 从 ~/.dsh 起来', () => {
  it('装好的 plist 指着这台机器自己的 ~/.dsh(没有别人的家目录、没有仓库)', () => {
    const plist = readFileSync(join(home, 'Library', 'LaunchAgents', 'ai.deepseek.butler.plist'), 'utf8')
    expect(stringsOf(plist, 'ProgramArguments')).toEqual([join(home, '.dsh', 'bin', 'butler-start')])
    expect(stringsOf(plist, 'WorkingDirectory')).toEqual([join(home, '.dsh')])
    expect(plist).not.toContain('/Users/')
    expect(plist).not.toContain(REPO)
  })

  it('起来的进程:入口与工作目录都在 ~/.dsh/butler-server 里,一个字不指向仓库', () => {
    const pid = child?.pid ?? 0
    const command = execFileSync('ps', ['-o', 'command=', '-p', String(pid)], { encoding: 'utf8' }).trim()
    expect(command).toContain(join(home, '.dsh', 'butler-server', 'server', 'index.cjs'))
    expect(command).not.toContain(REPO)
    const cwd = execFileSync('lsof', ['-a', '-p', String(pid), '-d', 'cwd', '-Fn'], { encoding: 'utf8' }).split('\n').find(line => line.startsWith('n'))?.slice(1) ?? ''
    expect(cwd.replace(/^\/private/, '')).toBe(join(home, '.dsh', 'butler-server').replace(/^\/private/, ''))
  })

  it('/api/asr 答话:这台机器没有识别钥匙 → 503 + 一句人话(说清楚怎么恢复,不编一段转写)', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/asr`, { method: 'POST', headers: { 'content-type': 'audio/wav' }, body: new Uint8Array(wav()) })
    const body = await res.json() as { code?: string, error?: string }
    expect(res.status).toBe(503)
    expect(body.code).toBe('voice_not_configured')
    expect(body.error).toMatch(/[一-鿿]/)
    expect(body.error).not.toContain('undefined')
  })

  it('8791 按这台机器的 butler.json 找到它:工人替配对过的手机转录音那一下,拿到的就是它那句;解除配对的 401', async () => {
    const pairing = createPairingService({ file: join(box, 'devices.json'), now: () => Math.floor(Date.now() / 1000) })
    workbench = await startWorkbenchServer({
      port: 0,
      service: createWorkbenchService({ now: () => Math.floor(Date.now() / 1000) }),
      tickIntervalMs: 0,
      heartbeatMs: 0,
      pairing,
      butler: createButlerService({ configFile: join(home, '.dsh', 'workbench', 'butler.json'), runCommand: async () => ({ ok: false, stdout: '' }) }),
    })
    pairing.start()
    const claimed = await pairing.claim({ code: pairing.current()?.code ?? '', device_name: '手机', platform: 'android' })
    if (!claimed.ok) throw new Error('测试装置:配对没成')
    // 与 channel-worker/src/asrRelay.ts 的 workbenchAsrPoster 同一个样子:回环 + 设备头 + 裸 WAV。
    const relay = async (deviceId: string) => {
      const res = await fetch(`${workbench!.url}/butler/proxy/api/asr`, {
        method: 'POST',
        headers: { 'x-workbench-channel-device': deviceId, 'content-type': 'audio/wav' },
        body: new Uint8Array(wav()),
      })
      return { status: res.status, body: await res.json() as { code?: string, error?: string } }
    }
    const ok = await relay(claimed.device_id)
    expect(ok.status).toBe(503)
    expect(ok.body.code).toBe('voice_not_configured')
    const revoked = await relay('never-paired-device')
    expect(revoked.status).toBe(401)
    // /state.butler 也看得见它(设置页、通道层判「本机后端在不在」读的就是这一格)。
    const state = await (await fetch(`${workbench.url}/state`)).json() as { butler?: { running?: boolean, port?: number } }
    expect(state.butler).toMatchObject({ running: true, port })
  })

  it('butler 那一步装完就让 launchd 重起它:新机器上那时还没装(不算失败),热更新时当场重起', async () => {
    const kick = ['launchctl', 'kickstart', '-k', `gui/${process.getuid?.() ?? 0}/ai.deepseek.butler`]
    const first = launchctl.findIndex(cmd => cmd.join(' ') === kick.join(' '))
    const bootstrap = launchctl.findIndex(cmd => cmd[1] === 'bootstrap' && (cmd[3] ?? '').endsWith('ai.deepseek.butler.plist'))
    // 装机顺序:butler(重起它 → 还没装,找不到)→ launchd(bootstrap,这才起来)。
    expect(first).toBeGreaterThanOrEqual(0)
    expect(bootstrap).toBeGreaterThan(first)
    // 之后的热更新(launchd 项已经在了):butler 那一步换完代码,当场重起。
    const before = launchctl.length
    const again = await run('butler')
    expect(again.state).toBe('done')
    expect(launchctl.slice(before)).toEqual([kick])
    expect(again.note).toContain('已按新代码重启')
  }, 120_000)

  it('打包那两条路(安装包、热更新)带的就是这几样:与 install.ts 的 butler 那一步、这份用例摆的 payload 对得上', () => {
    const installer = readFileSync(join(REPO, 'deploy', 'build-installer.sh'), 'utf8')
    const update = readFileSync(join(REPO, 'deploy', 'publish-update.sh'), 'utf8')
    const install = readFileSync(join(PLUGIN, 'src', 'server', 'setup', 'install.ts'), 'utf8')
    expect(installer).toContain('for part in server admin-ui/dist node_modules')
    expect(installer).toContain('workbench-plugin/bin/butler-start')
    expect(installer).toContain('butler-server/launchd/ai.deepseek.butler.plist')
    expect(installer).toContain('butler-server/package.json')
    expect(update).toMatch(/butler-server\/server butler-server\/package\.json/)
    expect(update).toContain('butler-server/node_modules')
    expect(update).toContain('workbench-plugin/bin/butler-start')
    expect(install).toContain("for (const part of ['server', 'admin-ui/dist', 'node_modules'])")
  })
})
