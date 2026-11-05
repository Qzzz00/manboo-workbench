/**
 * 新机器演练的命令行外壳(2026-10-21,内测发版底座)。**判法与报告都在 `src/server/setup/rehearsal.ts`**,
 * 这里只做五件事:找安装包(没有就临时打一份)→ 挂上 → 在隔离 home 里跑安装器内核 → 跑体检 → 落报告。
 *
 *     cd workbench-plugin && pnpm rehearse [--version 0.4.143] [--dmg <安装包> | --resources <Resources 目录>]
 *                                          [--report <报告.md>] [--keep] [--no-build]
 *
 * 安装包缺省用 `dist/工作台安装器-<版本>.dmg`(`deploy/build-installer.sh` 打在那儿,`--with installer` 发的也是它);
 * 没有就跑一遍 build-installer.sh 打到隔离目录里(不落 dist/,免得被当成要发的那一份)。`--no-build` 时直接报没有。
 * 报告缺省落 `dist/rehearsals/演练-<版本>-<时刻>.md`。
 *
 * 退出码:0 成;2 没成(报告里写着哪几行);1 参数不对 / 连演练都没起来。
 */
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmodSync, createReadStream, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadAppConfigFile } from '../src/server/appConfig.ts'
import type { InstallerEvent } from '../src/server/setup/installer.ts'
import { nodeSetupIo } from '../src/server/setup/io.ts'
import { setupPaths } from '../src/server/setup/paths.ts'
import {
  checkRowsFromSelfChecks, checkRowsFromSetup, installStepsOf, parseRehearseArgs, rehearsalVerdict, REHEARSAL_SHIMMED_COMMANDS,
  REHEARSAL_SKIPPED_STEPS, renderRehearsalReport, type RehearsalCheckRow, type RehearsalResult, type RehearsalStepRow, type TimedInstallerEvent,
} from '../src/server/setup/rehearsal.ts'
import { createSetupStatus } from '../src/server/setup/status.ts'
import { offlineSelfCheck, readOfflineFacts, rehearseRowsOf } from '../src/server/setup/installSelfCheck.ts'
import { execFileSync } from 'node:child_process'
import { checkClientBundle } from './clientLoadCheck.ts'

const PLUGIN_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const REPO_ROOT = resolve(PLUGIN_DIR, '..')
const BOX_PREFIX = join(tmpdir(), 'wb-rehearse-')
/** 装一遍最多给多久。运行时那一步要从 npm 装几百个包,慢网上十几分钟不奇怪。 */
const INSTALL_TIMEOUT_MS = 25 * 60_000
/** 透传给安装器内核的环境变量:代理与 npm 源(装运行时要联网)。别的一律不带 —— 尤其 DSH_HOME / WORKBENCH_*。 */
const PASS_ENV = ['TMPDIR', 'LANG', 'USER', 'LOGNAME', 'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'no_proxy', 'npm_config_registry']

function say(line: string): void { process.stderr.write(`${line}\n`) }

/** 连演练都没起来(参数、安装包、挂盘)。抛出去,由最外层收拾干净再退 1 —— 不能在这里 exit,挂着的盘会留下。 */
class RehearseStop extends Error {}

function fail(message: string): never {
  throw new RehearseStop(message)
}

interface RunOutcome { code: number | null, out: string, timedOut: boolean, error?: string }

function run(cmd: string, args: readonly string[], options: {
  env?: NodeJS.ProcessEnv
  timeoutMs?: number
  onLine?: (line: string) => void
  echo?: boolean
} = {}): Promise<RunOutcome> {
  return new Promise((done) => {
    const child = spawn(cmd, [...args], { env: options.env ?? process.env, stdio: ['ignore', 'pipe', 'pipe'] })
    let out = ''
    let buffer = ''
    let timedOut = false
    const timer = options.timeoutMs === undefined
      ? undefined
      : setTimeout(() => { timedOut = true; child.kill('SIGKILL') }, options.timeoutMs)
    child.stdout.on('data', (chunk: Buffer) => {
      const text = chunk.toString('utf8')
      out += text
      if (options.echo === true) process.stderr.write(text)
      buffer += text
      let cut = buffer.indexOf('\n')
      while (cut >= 0) {
        options.onLine?.(buffer.slice(0, cut))
        buffer = buffer.slice(cut + 1)
        cut = buffer.indexOf('\n')
      }
    })
    child.stderr.on('data', (chunk: Buffer) => {
      const text = chunk.toString('utf8')
      out += text
      if (options.echo === true) process.stderr.write(text)
    })
    child.on('error', (error) => {
      if (timer !== undefined) clearTimeout(timer)
      done({ code: null, out, timedOut, error: error.message })
    })
    child.on('close', (code) => {
      if (timer !== undefined) clearTimeout(timer)
      if (buffer !== '') options.onLine?.(buffer)
      done({ code, out, timedOut })
    })
  })
}

async function sha256Of(file: string): Promise<string> {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(file)) hash.update(chunk as Buffer)
  return hash.digest('hex')
}

/** 0904 事故之后的纪律:递归删除只许落在本脚本 mktemp 出来的那个目录里。 */
function removeBox(box: string): void {
  if (!box.startsWith(BOX_PREFIX) || box.slice(BOX_PREFIX.length).includes('/')) return
  rmSync(box, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
}

/** 挂上的盘里那个安装器的 Resources(里面有 kernel/ 与 payload/)。 */
function resourcesIn(mount: string): string | undefined {
  for (const name of readdirSync(mount)) {
    if (!name.endsWith('.app')) continue
    const candidate = join(mount, name, 'Contents', 'Resources')
    if (existsSync(join(candidate, 'kernel', 'install-from-bundle.mjs'))) return candidate
  }
  return undefined
}

const parsed = parseRehearseArgs(process.argv.slice(2))
if (!parsed.ok) {
  say(`×  ${parsed.error}`)
  process.exit(1)
}
const args = parsed.args
const version = args.version ?? (JSON.parse(readFileSync(join(PLUGIN_DIR, 'package.json'), 'utf8')) as { version: string }).version
const startedAt = Date.now()
const box = mkdtempSync(BOX_PREFIX)
// 不叫 home:报告里的路径要脱敏,`/home/<名字>` 那条规则会把它当成用户名换掉。
const home = join(box, '新机器')
const mount = join(box, 'mnt')
let mounted = false

try {
  // ── 一、安装包 ──
  let pkg: RehearsalResult['pkg']
  let resources: string
  if (args.resources !== undefined) {
    resources = resolve(args.resources)
    if (!existsSync(join(resources, 'kernel', 'install-from-bundle.mjs'))) fail(`${resources} 里没有 kernel/install-from-bundle.mjs —— 它不是安装器的 Resources 目录。`)
    pkg = { kind: 'resources', path: resources }
  }
  else {
    let dmg = resolve(args.dmg ?? join(REPO_ROOT, 'dist', `工作台安装器-${version}.dmg`))
    let built = false
    if (!existsSync(dmg)) {
      if (args.dmg !== undefined || !args.build) fail(`没有安装包:${dmg}。先 bash deploy/build-installer.sh,或者去掉 --no-build 让演练临时打一份。`)
      say(`▸ dist/ 里没有 ${version} 的安装包,临时打一份(deploy/build-installer.sh,几分钟)`)
      dmg = join(box, `工作台安装器-${version}.dmg`)
      const builtOut = await run('bash', [join(REPO_ROOT, 'deploy', 'build-installer.sh'), '--out', dmg], { echo: true })
      if (builtOut.code !== 0 || !existsSync(dmg)) fail('安装包没打出来(上面是 build-installer.sh 的输出)。')
      built = true
    }
    pkg = { kind: 'dmg', path: dmg, sha256: await sha256Of(dmg), built }
    mkdirSync(mount)
    const attached = await run('hdiutil', ['attach', '-nobrowse', '-readonly', '-noautoopen', '-mountpoint', mount, dmg])
    if (attached.code !== 0) fail(`安装包挂不上:${attached.out.trim().split('\n').slice(-1)[0] ?? ''}`)
    mounted = true
    const found = resourcesIn(mount)
    if (found === undefined) fail('安装包里没找到安装器(.app/Contents/Resources/kernel/install-from-bundle.mjs)。')
    resources = found
  }
  const kernel = join(resources, 'kernel', 'install-from-bundle.mjs')

  // 网页端能加载(2026-10-22):安装包里那份插件的 client.js 放进没有 process 的页面里执行,主界面那一格要注册上。
  const pluginDir = join(resources, 'payload', 'plugin')
  const pluginTgz = existsSync(pluginDir) ? readdirSync(pluginDir).find(name => name.endsWith('.tgz')) : undefined
  let webRow: RehearsalCheckRow
  if (pluginTgz === undefined) {
    webRow = { key: 'web_client', title: '网页端能加载', state: 'red', detail: '安装包里没有插件的 .tgz' }
  }
  else {
    let code: string | undefined
    try { code = execFileSync('tar', ['-xzOf', join(pluginDir, pluginTgz), 'package/lib/client.js'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }) }
    catch { code = undefined }
    const loaded = code === undefined ? { ok: false, slots: [], error: `${pluginTgz} 里读不出 package/lib/client.js` } : checkClientBundle(code)
    webRow = loaded.ok
      ? { key: 'web_client', title: '网页端能加载', state: 'ok', detail: `注册上了 ${loaded.slots.join('、')}` }
      : { key: 'web_client', title: '网页端能加载', state: 'red', detail: loaded.error ?? '加载不了' }
  }
  say(`▸ 网页端:${webRow.state === 'ok' ? '能加载' : `加载不了 —— ${webRow.detail}`}`)

  // ── 二、隔离 home 与挡住会改真机的那几条命令 ──
  mkdirSync(join(home, 'Applications'), { recursive: true })
  const shims = join(box, 'shim-bin')
  mkdirSync(shims)
  for (const cmd of REHEARSAL_SHIMMED_COMMANDS) {
    const file = join(shims, cmd)
    writeFileSync(file, `#!/bin/sh\necho "演练里不跑:${cmd} $*" >> "${join(box, 'shimmed.log')}"\nexit 1\n`)
    chmodSync(file, 0o755)
  }
  const env: NodeJS.ProcessEnv = {
    PATH: [shims, dirname(process.execPath), '/usr/bin', '/bin', '/usr/sbin', '/sbin'].join(':'),
    HOME: home,
  }
  for (const key of PASS_ENV) if (process.env[key] !== undefined) env[key] = process.env[key]

  // ── 三、装一遍 ──
  const plan = await run(process.execPath, [kernel, '--resources', resources, '--plan'], { env })
  const planned = plan.out.split('\n')
    .map(line => /^\d+\.\s+(\S+)\t(.+?)(?:(可选))?$/.exec(line))
    .filter((match): match is RegExpExecArray => match !== null)
    .map(match => ({ key: match[1] as string, title: match[2] as string }))
  if (planned.length === 0) fail(`安装器列不出要装哪几步:${plan.out.trim().slice(0, 200)}`)
  const skipped: readonly string[] = REHEARSAL_SKIPPED_STEPS
  const steps = planned.filter(step => !skipped.includes(step.key))
  say(`▸ 隔离 home 里装 ${version}(${steps.length} 步;不跑:${planned.filter(step => skipped.includes(step.key)).map(step => step.key).join('、') || '无'})`)
  const events: TimedInstallerEvent[] = []
  const logLines: string[] = []
  const installed = await run(process.execPath, [
    kernel, '--resources', resources, '--home', home, '--applications', join(home, 'Applications'),
    '--no-launch', '--json', '--log-file', join(box, 'install.log'), '--steps', steps.map(step => step.key).join(','),
  ], {
    env,
    timeoutMs: INSTALL_TIMEOUT_MS,
    onLine: (line) => {
      let event: InstallerEvent
      try { event = JSON.parse(line) as InstallerEvent }
      catch { logLines.push(line); return }
      events.push({ at: Date.now(), event })
      if (event.t === 'step') say(`  [${event.i}/${event.n}] ${event.title}`)
      if (event.t === 'fail') say(`  × ${event.title}:${event.error}`)
      if (event.t === 'log' || event.t === 'note') logLines.push(event.text)
      if (event.t === 'fail') logLines.push(...event.tail)
    },
  })
  const installedAt = Date.now()
  const stepRows: RehearsalStepRow[] = [
    ...installStepsOf(events, steps, installedAt),
    ...planned.filter(step => skipped.includes(step.key))
      .map(step => ({ key: step.key, title: step.title, state: 'skip' as const, detail: '演练里不跑:它改的是这台真机的程序坞与菜单栏,不跟 HOME 走' })),
  ]

  // ── 四、体检(五步体检;引导卡的三件自检接上之后换成 checkRowsFromSelfChecks)──
  say('▸ 体检')
  const paths = setupPaths({ home, applicationsDir: join(home, 'Applications') })
  const status = await createSetupStatus({
    io: nodeSetupIo(),
    paths,
    pluginVersion: version,
    scanRoots: async () => [],
    butlerCwd: async () => (await loadAppConfigFile(paths.appJson)).butler_cwd,
    now: () => Date.now(),
  }).check()

  const result: RehearsalResult = {
    version,
    startedAt,
    finishedAt: Date.now(),
    pkg,
    box,
    kept: args.keep,
    installerExit: installed.timedOut ? null : installed.code,
    ...(installed.timedOut ? { installerError: `装了 ${Math.round(INSTALL_TIMEOUT_MS / 60_000)} 分钟还没装完,掐掉了` } : {}),
    ...(installed.error === undefined ? {} : { installerError: installed.error }),
    steps: stepRows,
    checkSource: 'five_step',
    checks: [webRow, ...checkRowsFromSetup(status.items)],
    selfChecks: checkRowsFromSelfChecks(rehearseRowsOf(offlineSelfCheck(await readOfflineFacts({
      dshHome: paths.dshHome,
      home,
      readFile: async file => readFileSync(file, 'utf8'),
      exists: async file => existsSync(file),
      why: '演练不起服务',
    })))),
    logTail: [],
  }
  const verdict = rehearsalVerdict(result)
  if (!verdict.ok) result.logTail = logLines.slice(-40)

  // ── 五、报告 ──
  const stamp = new Date(startedAt).toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15)
  const report = resolve(args.report ?? join(REPO_ROOT, 'dist', 'rehearsals', `演练-${version}-${stamp}.md`))
  mkdirSync(dirname(report), { recursive: true })
  writeFileSync(report, renderRehearsalReport(result))
  const gates = result.checks.filter(row => row.state === 'gate').length
  say(verdict.ok
    ? `✓  演练成了(${version}):装得上,缺的门 ${gates} 道。报告:${report}`
    : `×  演练没成(${version}):\n${verdict.reds.map(red => `   - ${red}`).join('\n')}\n   报告:${report}`)
  process.exitCode = verdict.ok ? 0 : 2
}
catch (error) {
  if (!(error instanceof RehearseStop)) throw error
  say(`×  ${error.message}`)
  process.exitCode = 1
}
finally {
  if (mounted) await run('hdiutil', ['detach', mount, '-force'])
  if (args.keep) say(`   隔离 home 留着:${box}`)
  else removeBox(box)
}
