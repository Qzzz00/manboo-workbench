// @vitest-environment node
/**
 * 热更新把新的 dsh-start 送到老用户机器上,重启之后就用上(2026-09-25,卡 R 补,统筹拍板)。
 *
 * 起因:`dsh-start` 里那行 `export ANTHROPIC_BASE_URL="http://127.0.0.1:8787"`(维护者本机的一个代理)
 * 随安装包与热更新发给了所有人,DSH 起的 `claude` 命令行全都连不上。这一行删了;要回答的是
 * **已经装了旧版的人怎么换上**。这里从发版到下次开机整条路真走一遍:
 *
 *   1. **真跑 `deploy/publish-update.sh`**(`--no-upload`):仓库那份脚本原样拷进一个临时"仓库",
 *      启动脚本与 plist 用仓库里**真的那几份**(清单照 publish-update.sh 里那条 tar 读,同守门用例),
 *      只有插件换成一个几百字节的假包(真构建插件要一分钟,而且会跟装机形态用例抢 lib/);
 *   2. 本地起一个静态服务器当更新服务器;
 *   3. 一台"老用户"的临时 HOME:`~/.dsh/bin/dsh-start` 还是带那行代理的旧版,上一版的脚本包记在 installed.json 里;
 *   4. 客户端真走一遍「检查更新 → 立即更新」(`createUpdateService`,同设置 → 更新那颗按钮);
 *   5. 断言新的 dsh-start 换进了 `~/.dsh/bin/`、更新最后发了 `launchctl kickstart -k …/ai.deepseek.dsh`;
 *   6. **像 launchd 那样**按装好的 plist 里 ProgramArguments 把 dsh-start 跑一遍(自有 node 换成一个只把
 *      环境变量记下来的假 node):DSH 这次起来的环境里没有那个代理。
 *
 * 另一条:发版时点名别的几样(`--with apk`),启动脚本照样带上 —— 原来 `--with` 会把默认清单整个换掉,
 * 启动脚本就悄悄不带了。
 *
 * 2026-09-26(卡 U4 合并)补:升 0.1.7 之后 `runtime` 是**必带**的一样,这条路上多了两处 ——
 * 发版那一头这个"仓库"里要有真的锁定清单与 `paths.ts`(脚本会把两处的 dsh 版本对一次),
 * 客户端那一头假 npm 要把关键包摆出来(那道版本守门是真在核的)。两处的理由写在各自旁边。
 *
 * 被换成假的只有会去动真实机器的那几类命令(npm / launchctl / rsync / codesign / 往 profile 里装插件)。
 * 发版脚本那一趟 HOME 也指到临时目录(npm 的缓存与日志落在那里)。临时目录跑完收拾掉,只删自己 mkdtemp 的那一棵。
 */
import { createServer, type Server } from 'node:http'
import { execFileSync, spawn, spawnSync } from 'node:child_process'
import { chmodSync, copyFileSync, createReadStream, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { seedInstalledPnpm } from './setup/pnpmFake.ts'
import { createUpdateService } from '../src/server/update/service.ts'
import { downloadBytesOf, parseManifest } from '../src/server/update/manifest.ts'
import { RUNTIME_LOCK_PAYLOAD_DIR } from '../src/server/update/apply.ts'
import { nodeSetupIo, type SetupExecOptions, type SetupIo } from '../src/server/setup/io.ts'
import { setupPaths } from '../src/server/setup/paths.ts'
import type { UpdateJobView } from '../src/server/update/types.ts'
import { REPO_ROOT, updateScriptFiles } from './helpers/shippedScripts.ts'
import { isNpmCi, seedLockedRuntime } from './setup/dshRuntimeFake.ts'

const PREFIX = join(tmpdir(), 'wb-update-dsh-start-')
const boxes: string[] = []
const servers: Server[] = []
afterAll(async () => {
  while (servers.length) await new Promise<void>((resolve) => { servers.pop()?.close(() => resolve()) })
  while (boxes.length) {
    const box = boxes.pop() as string
    // 只删自己 mkdtemp 出来的那一棵(0904 家目录事故铁律)。
    if (!box.startsWith(PREFIX) || box.slice(PREFIX.length).includes('/')) throw new Error(`拒绝删除:${box}`)
    rmSync(box, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
  }
})

function newBox(): string {
  const box = mkdtempSync(PREFIX)
  boxes.push(box)
  return box
}

/** 把一个目录当静态根发出去(只读、只 GET)。回 origin。 */
async function serveDir(root: string): Promise<string> {
  const server = createServer((req, res) => {
    const name = decodeURIComponent((req.url ?? '/').split('?')[0] as string).replace(/^\/+/, '')
    const file = join(root, name)
    if (!file.startsWith(root) || !existsSync(file) || !statSync(file).isFile()) { res.writeHead(404); res.end('no'); return }
    res.writeHead(200, { 'content-length': String(statSync(file).size) })
    createReadStream(file).pipe(res)
  })
  servers.push(server)
  await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', () => resolve()) })
  const address = server.address()
  return `http://127.0.0.1:${typeof address === 'object' && address !== null ? address.port : 0}`
}

const VERSION = '9.9.9'
/** 「再发一版」用的两个版本号(卡 U8:没重打的那几样照上一版带上)。 */
const NEXT_VERSION = '9.9.10'
const THIRD_VERSION = '9.9.11'
/** 老用户机器上那份 dsh-start:就是现在这份,外加被删掉的那一行代理。 */
const OLD_PROXY_LINE = 'export ANTHROPIC_BASE_URL="http://127.0.0.1:8787"'

/** 假的电脑安装包(卡 SM:`--with installer` 那一条)。名字与线上那一份逐字相同。 */
const FAKE_DMG = '假的安装包'

/**
 * 摆一个"仓库":publish-update.sh 原样、scripts.tgz 要带的那几份真文件、一个假插件。
 *
 * `apk` 为真时再放一个手机包(给 `--with apk` 那几条)。**那是个真 zip**:2026-10-03 起
 * 发版脚本要核「这份包是不是这会儿这份源码打出来的」(0928 连发四版旧包的那条),
 * 所以这个"仓库"也是个**真 git 仓库**,包里真有一份 `assets/public/build.json`。
 * `apk: 'stale'` 把那行指纹写成别人的 —— 那正是 0928 那四版的样子(反例用);
 * `apk: 'dirty'` 指纹是对的、但记着「打包那会儿还有没提交的改动」(另一条反例);
 * `apk: 'oldversion'` 指纹对得上、树也干净,只是包里记的版本号是上一版的
 * (2026-10-03,卡 claude/phone-in-app-update:butler-app 两版之间没改动时这种包前三道全过,
 * 而手机装上去版本号没变 → 永远显示「有新版」的死循环)。
 *
 * `installer` 为真时再放一份假的 `dist/工作台安装器-<版本>.dmg`(给 `--with installer` 那一条)。
 */
function stageRepo(box: string, apk: boolean | 'stale' | 'dirty' | 'oldversion' = false, installer = false): string {
  const repo = join(box, 'repo')
  const put = (rel: string, text: string, mode?: number): void => {
    mkdirSync(dirname(join(repo, rel)), { recursive: true })
    writeFileSync(join(repo, rel), text)
    if (mode !== undefined) chmodSync(join(repo, rel), mode)
  }
  mkdirSync(join(repo, 'deploy'), { recursive: true })
  copyFileSync(join(REPO_ROOT, 'deploy', 'publish-update.sh'), join(repo, 'deploy', 'publish-update.sh'))
  // 签名身份那一问换成固定回答「没有长期证书」:这里不发壳,也不去碰这台机器的钥匙串。
  put('deploy/codesign-identity.sh', '#!/usr/bin/env bash\necho -\n', 0o755)
  for (const rel of updateScriptFiles()) {
    mkdirSync(dirname(join(repo, rel)), { recursive: true })
    copyFileSync(join(REPO_ROOT, rel), join(repo, rel))
  }
  // 假插件:版本号比老用户那份新,构建是空操作,打出来几百字节。
  // `type: module` 是真的要有:发版脚本用 `node -p "import('…/paths.ts')"` 读 LOCKED_DSH_VERSION,
  // 而 .ts 算不算 ESM 看的是最近那个 package.json 的 type,少了这一行那句 import 直接报错。
  put('workbench-plugin/package.json', `${JSON.stringify({
    name: '@ben/dsh-workbench',
    version: VERSION,
    type: 'module',
    scripts: { build: 'node -e ""' },
    files: ['index.js'],
  }, null, 2)}\n`)
  put('workbench-plugin/index.js', 'export {}\n')
  put('workbench-plugin/node_modules/.bin/tsdown', '#!/bin/sh\nexit 0\n', 0o755)
  // 构建注入那一步(2026-10-21,局域网 M7):发版脚本打完要核产物里编进去的中转地址。用真的那份核对脚本;
  // 假仓库里没有构建档 = 开源档,假产物里一个地址都不带。
  mkdirSync(join(repo, 'workbench-plugin', 'scripts'), { recursive: true })
  copyFileSync(join(REPO_ROOT, 'workbench-plugin', 'scripts', 'build-endpoints.mjs'), join(repo, 'workbench-plugin', 'scripts', 'build-endpoints.mjs'))
  put('workbench-plugin/lib/index.js', 'export {}\n')
  /**
   * 2026-09-25 升 0.1.7(卡 U1)之后 `runtime` 成了**必带**的一样:发版脚本要读仓库里那两份
   * DSH 锁定清单,并把清单锁的 dsh 版本跟 `paths.ts` 的 `LOCKED_DSH_VERSION` 对一次,
   * 对不上就停下不发。所以这个"仓库"里也得有它们 —— 用**仓库里真的那三份**,不造假:
   * 造一份假清单等于把「常量与清单必须同一版」那道守门在这条路上关掉。
   * 路径从 `RUNTIME_LOCK_PAYLOAD_DIR` 来(发版脚本与 apply.ts 认同一个常量,两边各有用例钉着)。
   */
  for (const rel of [
    `${RUNTIME_LOCK_PAYLOAD_DIR}/runtime.package.json`,
    `${RUNTIME_LOCK_PAYLOAD_DIR}/runtime.package-lock.json`,
    'workbench-plugin/src/server/setup/paths.ts',
  ]) {
    mkdirSync(dirname(join(repo, rel)), { recursive: true })
    copyFileSync(join(REPO_ROOT, rel), join(repo, rel))
  }
  if (apk !== false) {
    // 手机包那一条(2026-10-03,审计 C 条):发版脚本从包里读 `assets/public/build.json`
    // 里那行 `butler_app_tree`,跟 `git rev-parse HEAD:butler-app` 比。所以这里要三样真东西:
    // ① 一个真 git 仓库;② butler-app 下真有点东西(那棵树才有 id);③ 一个真 zip。
    put('butler-app/package.json', `${JSON.stringify({ name: 'ai.ben.butler', version: VERSION }, null, 2)}\n`)
    put('butler-app/src/main.tsx', 'export {}\n')
    // apk 本身落在 butler-app 里面 —— 不挡住的话它自己的字节会改掉那棵树的 id
    // (真仓库里 `android/app/build/` 本来就在 .gitignore 里)。
    put('.gitignore', 'butler-app/android/app/build/\ndist/\n')
    const git = (...args: readonly string[]): string => execFileSync(
      'git', ['-C', repo, '-c', 'user.email=t@example.invalid', '-c', 'user.name=用例', ...args],
      { encoding: 'utf8' },
    )
    git('init', '-q')
    git('add', '-A')
    git('commit', '-q', '-m', '假仓库第一版')
    const tree = git('rev-parse', 'HEAD:butler-app').trim()
    const stage = join(box, 'apk-stage')
    mkdirSync(join(stage, 'assets', 'public'), { recursive: true })
    // 形状是 `butler-app/scripts/write-build-stamp.mjs` 那一处定的(docs/交接-1003-手机包指纹.md)。
    writeFileSync(join(stage, 'assets', 'public', 'build.json'), `${JSON.stringify({
      // 'stale' = 这份包是别的源码打的(0928 那四版)。
      butler_app_tree: apk === 'stale' ? 'f'.repeat(40) : tree,
      built_at: '2026-10-03T02:00:00Z',
      // 'dirty' = 指纹对得上,但打包那会儿那棵树还有没提交的改动。
      dirty: apk === 'dirty',
      // 包里自己记的版本号(= APK 的 versionName,2026-10-03)。
      // 'oldversion' = 上一版打的那份包,前三道全过、版本号没跟上。
      version: apk === 'oldversion' ? '9.9.8' : VERSION,
      version_code: 1,
    }, null, 2)}\n`)
    const out = join(repo, 'butler-app/android/app/build/outputs/apk/debug/app-debug.apk')
    mkdirSync(dirname(out), { recursive: true })
    execFileSync('zip', ['-q', '-r', out, 'assets'], { cwd: stage })
  }
  // 安装包不由发版脚本打(build-installer.sh 打,几分钟)—— 它只把打好的那一份带上,
  // 所以这里摆的位置就是脚本的默认位置。
  if (installer) put(`dist/工作台安装器-${VERSION}.dmg`, FAKE_DMG)
  return repo
}

/**
 * 那个"仓库"里插件的版本号改一下(再发一版用)。发版脚本会核「打出来的包名里带这个版本号」,
 * 所以只改 `--version` 不改 package.json 是过不去的 —— 这里就照真发版那样 bump 一次。
 */
function bumpRepo(repo: string, version: string): void {
  const file = join(repo, 'workbench-plugin', 'package.json')
  const pkg = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>
  writeFileSync(file, `${JSON.stringify({ ...pkg, version }, null, 2)}\n`)
}

/**
 * 真跑一遍发版脚本(不上传)。产物与 latest.json 落进 `<srv>/updates/`。
 *
 * **异步起子进程**:发版脚本开头会 curl 一下更新服务器上现在是哪一版,而那台"服务器"就跑在这个进程里 ——
 * 同步等(spawnSync)会把事件循环堵住,它回不了话,curl 就一直挂着。
 */
async function publish(box: string, repo: string, origin: string, extra: readonly string[] = []): Promise<{ manifest: { version: string, assets: Record<string, { url: string, sha256: string, size: number, from_version?: string }> } }> {
  const home = join(box, 'publisher-home')
  mkdirSync(home, { recursive: true })
  const child = spawn('bash', [
    join(repo, 'deploy', 'publish-update.sh'),
    '--no-upload', '--out', join(box, 'srv', 'updates'), '--base-url', `${origin}/updates`,
    // 这一份验的是「收稳定版的老用户拿得到新的 dsh-start」:发稳定版,写的就是客户端缺省去读的 latest.json
    // (2026-10-21 起发版脚本缺省是热修、只写 beta.json)。新机器演练要真的安装包,这里的插件是假的,跳过并写明理由。
    '--channel', 'stable', '--skip-rehearse', '用例里的插件包是假的,装不了',
    '--notes', '这一版去掉了启动脚本里一台机器自己的代理设置。',
    ...extra,
  ], {
    cwd: box,
    env: {
      PATH: process.env.PATH ?? '/usr/bin:/bin',
      HOME: home,
      TMPDIR: box,
      npm_config_update_notifier: 'false',
      npm_config_fund: 'false',
      npm_config_audit: 'false',
    },
  })
  let output = ''
  child.stdout.on('data', (chunk) => { output += String(chunk) })
  child.stderr.on('data', (chunk) => { output += String(chunk) })
  const status = await new Promise<number | null>((resolve) => {
    const timer = setTimeout(() => child.kill('SIGKILL'), 120_000)
    child.on('close', (code) => { clearTimeout(timer); resolve(code) })
  })
  if (status !== 0) throw new Error(`发版脚本没跑通(退出码 ${status}):\n${output}`)
  return { manifest: JSON.parse(readFileSync(join(box, 'srv', 'updates', 'latest.json'), 'utf8')) }
}

/**
 * 会去动真实机器的那几类命令,换成假的;别的原样放行(curl、shasum、tar 都是真跑的)。
 *
 * **launchctl 按整条 argv 认**(2026-10-13):重启那一下从 `spawn('launchctl', …)` 换成了
 * `/bin/sh -c '… exec launchctl kickstart -k …'`(update/apply.ts 的 `scheduleRestart`)——
 * 只看 `cmd[0]` 的话这道硬线当场失效,这条用例会把真服务重启掉。
 */
function isFaked(cmd: readonly string[]): boolean {
  const bin = cmd[0] ?? ''
  if (cmd.some(arg => arg.includes('launchctl'))) return true
  if (bin === 'npm' || bin === 'rsync' || bin === 'codesign' || bin === 'osascript') return true
  return cmd.includes('plugin') && cmd.includes('--profile')
}

describe('热更新:新的 dsh-start 到得了老用户那边,重启之后就用上', () => {
  it('★老用户点「立即更新」:dsh-start 换成新的、更新最后发重启;launchd 下次起 DSH,环境里没有那个代理', async () => {
    const box = newBox()
    const repo = stageRepo(box)
    const origin = await serveDir(join(box, 'srv'))
    const { manifest } = await publish(box, repo, origin)
    expect(manifest.version).toBe(VERSION)
    // `runtime_tgz` 从 2026-09-25(升 0.1.7,卡 U1)起也是必带的一样:已装机器换 DSH 版本只有这条路。
    expect(Object.keys(manifest.assets).sort()).toEqual(['plugin_tgz', 'runtime_tgz', 'scripts_tgz'])

    // 老用户:旧的 dsh-start(带那行代理)在 ~/.dsh/bin 里,上一版的脚本包记在 installed.json 里。
    const home = join(box, 'home')
    const fresh = readFileSync(join(REPO_ROOT, 'workbench-plugin', 'bin', 'dsh-start'), 'utf8')
    expect(fresh).not.toContain('ANTHROPIC_BASE_URL')
    const old = fresh.replace('cd "$DSH_HOME/runtime"', `${OLD_PROXY_LINE}\n\ncd "$DSH_HOME/runtime"`)
    expect(old).toContain(OLD_PROXY_LINE)
    mkdirSync(join(home, '.dsh', 'bin'), { recursive: true })
    writeFileSync(join(home, '.dsh', 'bin', 'dsh-start'), old, { mode: 0o755 })
    mkdirSync(join(home, '.dsh', 'updates'), { recursive: true })
    writeFileSync(join(home, '.dsh', 'updates', 'installed.json'), `${JSON.stringify({
      version: '0.2.99',
      assets: { scripts_tgz: { sha256: 'a'.repeat(64), version: '0.2.99', at: '2026-09-24T00:00:00.000Z' } },
    }, null, 2)}\n`)

    const faked: string[][] = []
    const real = nodeSetupIo()
    const io: SetupIo = {
      ...real,
      exec: async (cmd: readonly string[], options?: SetupExecOptions) => {
        if (isFaked(cmd)) {
          faked.push([...cmd])
          /**
           * 假 npm 也得把「装出来的样子」摆出来:升 0.1.7 之后热更新最后一步会照锁定清单
           * `npm ci` 装进 `runtime-next`,**装完真去核关键包版本**,核不过就整步失败、
           * 在用的那份一个字节不动。真装是五百多个包,所以照 U1 那套用 `seedLockedRuntime`
           * 在 cwd 里摆好关键包 —— 那道版本守门于是是真在核,只是包是摆出来的。
           * 运行时那一步本身怎么走由 `install-shape-runtime.test.ts` 按真形态钉着,这里只要它别把整条路拦住。
           */
          if (isNpmCi(cmd) && options?.cwd !== undefined) seedLockedRuntime(options.cwd)
          return { ok: true, code: 0, out: '(用例拦下来的)' }
        }
        return await real.exec(cmd, options)
      },
      uid: () => 501,
    }
    // 这台机器上自带的 pnpm 已经装好了(装插件那一步判「已经在了,不用装」,不去联网下)。
    seedInstalledPnpm(setupPaths({ home, applicationsDir: join(home, 'Applications') }))
    const update = createUpdateService({
      io,
      paths: setupPaths({ home, applicationsDir: join(home, 'Applications') }),
      now: () => Date.now(),
      newId: (() => { let n = 0; return () => `dsh-start-${++n}` })(),
      currentVersion: '0.2.99',
      manifestUrl: `${origin}/updates/latest.json`,
      checkIntervalMs: 0,
      applyTuning: { subPollMs: 0, restartDelayMs: 0 },
    })

    // 设置 → 更新:「检查更新」看得到新版,「立即更新」跑完。
    const checked = await update.check()
    expect(checked.available).toBe(true)
    expect(checked.latest).toBe(VERSION)
    const started = update.apply() as UpdateJobView
    expect('error' in started).toBe(false)
    await update.waitJob(started.id)
    const job = update.job(started.id) as UpdateJobView
    expect(job.error).toBeUndefined()
    expect(job.state).toBe('done')
    expect(job.restarting).toBe(true)

    // ~/.dsh/bin/dsh-start 换成了仓库里现在这份:一字不差、能执行、没有那行代理。
    const installed = join(home, '.dsh', 'bin', 'dsh-start')
    expect(readFileSync(installed, 'utf8')).toBe(fresh)
    expect(statSync(installed).mode & 0o111).not.toBe(0)
    // installed.json 记下了这一版的脚本包(下一版脚本没变就不重装)。
    const record = JSON.parse(readFileSync(join(home, '.dsh', 'updates', 'installed.json'), 'utf8')) as { assets: Record<string, { sha256: string }> }
    expect(record.assets.scripts_tgz?.sha256).toBe(manifest.assets.scripts_tgz?.sha256)
    // 更新最后那一下:重启 DSH(launchd 会重新跑 ~/.dsh/bin/dsh-start)。
    // 2026-10-13 起它交给一个 detach 出去的 sh 发(不依赖发它的进程还活着)。
    expect(faked.some(cmd => cmd.join(' ').includes('launchctl kickstart -k gui/501/ai.deepseek.dsh'))).toBe(true)

    // ── 像 launchd 那样把它跑一遍 ──
    // ProgramArguments 取自更新那一趟写下的 plist(`{{HOME}}` 渲染成这台临时 HOME)。
    const plist = readFileSync(join(home, 'Library', 'LaunchAgents', 'ai.deepseek.dsh.plist'), 'utf8')
    const program = /<key>ProgramArguments<\/key>\s*<array>\s*<string>([^<]+)<\/string>/.exec(plist)?.[1]
    expect(program).toBe(installed)
    // 自有 node 换成一个只把环境变量与参数记下来的假 node;DSH 运行时只摆一个空的 bin.js。
    const envDump = join(home, '.dsh', 'dsh-起来时的环境.txt')
    mkdirSync(join(home, '.dsh', 'node', 'bin'), { recursive: true })
    writeFileSync(join(home, '.dsh', 'node', 'bin', 'node'), `#!/bin/sh\nenv > "${envDump}"\necho "ARGS: $*" >> "${envDump}"\n`, { mode: 0o755 })
    mkdirSync(join(home, '.dsh', 'runtime', 'node_modules', '@deepseek-ai', 'dsh', 'lib'), { recursive: true })
    writeFileSync(join(home, '.dsh', 'runtime', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'), '')
    // launchd 起用户进程时给的环境就这么几样(HOME、系统 PATH);这台机器上没有别处塞进来的变量。
    const started2 = spawnSync(program as string, [], { encoding: 'utf8', env: { HOME: home, PATH: '/usr/bin:/bin:/usr/sbin:/sbin' }, timeout: 30_000 })
    expect(started2.status).toBe(0)
    const dumped = readFileSync(envDump, 'utf8')
    expect(dumped).not.toContain('ANTHROPIC_BASE_URL')
    expect(dumped).toContain(`DSH_HOME=${home}/.dsh`)
    expect(dumped).toContain('ARGS: ')
    expect(dumped).toContain('web --host 127.0.0.1 --port 3080 --no-open')

    // 说清楚一件事:dsh-start **不替他改**他自己的环境。launchd 会话里要是本来就有人设了这个变量
    // (`launchctl setenv`,比如装了某个代理工具),DSH 照样继承 —— 那是他机器上的设置,不是我们发的脚本带的。
    // 维护者那台就是这样,见交接「维护者那台还要做的一步」。
    const inherited = spawnSync(program as string, [], {
      encoding: 'utf8',
      env: { HOME: home, PATH: '/usr/bin:/bin:/usr/sbin:/sbin', ANTHROPIC_BASE_URL: 'http://127.0.0.1:8787' },
      timeout: 30_000,
    })
    expect(inherited.status).toBe(0)
    expect(readFileSync(envDump, 'utf8')).toContain('ANTHROPIC_BASE_URL=http://127.0.0.1:8787')
  }, 180_000)

  /**
   * 0.4.1 用 `--with shell` 发,清单里就没了 apk —— 那台 Mac 的「手机包」那一格当场变空,Pixel 下不了
   * (决策记录 2026-09-26「发版清单要带上上一版的手机包 / 通话组件」)。守门照上面那两条的做法:
   * **真跑发版脚本两趟**,第二趟不打手机包,断言清单里那一格是从上一版原样继承来的。
   */
  it('★再发一版没打手机包:清单里 apk 那一格照上一版原样继承(同一个 url 与 sha),并记下出自哪一版', async () => {
    const box = newBox()
    const repo = stageRepo(box, true)
    const origin = await serveDir(join(box, 'srv'))

    // ① 第一版:带手机包。
    const first = await publish(box, repo, origin, ['--with', 'apk'])
    expect(Object.keys(first.manifest.assets).sort()).toEqual(['apk', 'plugin_tgz', 'runtime_tgz', 'scripts_tgz'])
    const apk = first.manifest.assets.apk as { url: string, sha256: string, size: number }

    // ② 第二版:只发默认那三样(0.4.1 那次就是这么发的)。apk 那一格照上一版原样带上。
    bumpRepo(repo, NEXT_VERSION)
    const second = await publish(box, repo, origin)
    expect(second.manifest.version).toBe(NEXT_VERSION)
    expect(Object.keys(second.manifest.assets).sort()).toEqual(['apk', 'plugin_tgz', 'runtime_tgz', 'scripts_tgz'])
    // 同一个 url、同一个 sha、同一个 size,外加一句「出自哪一版」。
    expect(second.manifest.assets.apk).toEqual({ ...apk, from_version: VERSION })
    expect(second.manifest.assets.apk?.url).toContain(`/updates/${VERSION}/app.apk`)
    // 那个地址**真的还下得到**(旧版本的目录从不删 —— 继承过来的 url 靠这一条成立)。
    const got = await fetch(second.manifest.assets.apk?.url as string)
    expect(got.status).toBe(200)
    // 逐字节就是第一版带上去的那一份(它现在是个真 zip —— 里面有那行构建指纹)。
    const staged = readFileSync(join(repo, 'butler-app/android/app/build/outputs/apk/debug/app-debug.apk'))
    expect(Buffer.from(await got.arrayBuffer()).equals(staged)).toBe(true)
    // 这一趟真打的那几样不带 from_version(它们就是这一版的),插件也真换了字节。
    expect(second.manifest.assets.plugin_tgz?.from_version).toBeUndefined()
    expect(second.manifest.assets.plugin_tgz?.sha256).not.toBe(first.manifest.assets.plugin_tgz?.sha256)
    // 客户端读得懂这份清单(同源、sha256 形状那几道校验真在跑),并认得那一格出自上一版。
    const parsed = parseManifest(readFileSync(join(box, 'srv', 'updates', 'latest.json'), 'utf8'), `${origin}/updates/latest.json`)
    expect(parsed.assets.apk?.from_version).toBe(VERSION)

    // ③ `--no-carry`:某件产物不再发了,那一格就该真的消失(不是没法丢掉)。
    bumpRepo(repo, THIRD_VERSION)
    const third = await publish(box, repo, origin, ['--no-carry'])
    expect(Object.keys(third.manifest.assets).sort()).toEqual(['plugin_tgz', 'runtime_tgz', 'scripts_tgz'])
  }, 300_000)

  /**
   * 电脑安装包进清单(2026-09-26,卡 SM)。安装包原来只有一个**手工拷来的、带版本号的地址**
   * (交接-0924 末尾),网页上的「下载地址」每发一版都要有人改一行。守门照上面那一条的做法:
   * **真跑发版脚本两趟**,断言那一格真在清单里、那个地址真下得到、下一版没打也照上一版原样继承。
   */
  it('★发版带上电脑安装包(--with installer):清单里那一格真下得到;这台机器不下载它;下一版没打照上一版原样继承', async () => {
    const box = newBox()
    const repo = stageRepo(box, false, true)
    const origin = await serveDir(join(box, 'srv'))

    // ① 带安装包发一版。`all` 里不含它,所以要点名。
    const first = await publish(box, repo, origin, ['--with', 'installer'])
    expect(Object.keys(first.manifest.assets).sort()).toEqual(['installer_dmg', 'plugin_tgz', 'runtime_tgz', 'scripts_tgz'])
    const dmg = first.manifest.assets.installer_dmg as { url: string, sha256: string, size: number }
    // 文件名带版本号(2026-09-27 起;新 Air 上打开旧包还以为是新的),地址指着这一版的目录。
    expect(dmg.url).toBe(`${origin}/updates/${VERSION}/工作台安装器-${VERSION}.dmg`)
    expect(dmg.size).toBe(Buffer.byteLength(FAKE_DMG))
    // 那个地址**真的下得到**(这一格的全部价值就在这儿:latest.json 是找安装包的稳定入口)。
    const got = await fetch(dmg.url)
    expect(got.status).toBe(200)
    expect(await got.text()).toBe(FAKE_DMG)

    // 客户端读得懂这一格,而且**不把它算进要下的字节**(这台机器永远不下载它)。
    const parsedFirst = parseManifest(readFileSync(join(box, 'srv', 'updates', 'latest.json'), 'utf8'), `${origin}/updates/latest.json`)
    expect(parsedFirst.assets.installer_dmg?.url).toBe(dmg.url)
    expect(downloadBytesOf(parsedFirst)).toBe(
      (parsedFirst.assets.plugin_tgz?.size ?? 0) + (parsedFirst.assets.scripts_tgz?.size ?? 0) + (parsedFirst.assets.runtime_tgz?.size ?? 0),
    )

    // ② 下一版只发默认那三样(安装包几分钟才打一次,绝大多数版本不重打它):
    // 那一格照上一版原样带上,并记下出自哪一版 —— 每一版的清单都答得出「安装包在哪」。
    bumpRepo(repo, NEXT_VERSION)
    const second = await publish(box, repo, origin)
    expect(second.manifest.version).toBe(NEXT_VERSION)
    expect(second.manifest.assets.installer_dmg).toEqual({ ...dmg, from_version: VERSION })
    const parsedSecond = parseManifest(readFileSync(join(box, 'srv', 'updates', 'latest.json'), 'utf8'), `${origin}/updates/latest.json`)
    expect(parsedSecond.assets.installer_dmg?.from_version).toBe(VERSION)
  }, 300_000)

  it('★发版时点名别的几样(--with apk),启动脚本照样带上', async () => {
    const box = newBox()
    const repo = stageRepo(box, true)
    const origin = await serveDir(join(box, 'srv'))
    const { manifest } = await publish(box, repo, origin, ['--with', 'apk'])
    expect(Object.keys(manifest.assets).sort()).toEqual(['apk', 'plugin_tgz', 'runtime_tgz', 'scripts_tgz'])
    // 带的就是仓库里那几份:解开 scripts.tgz,dsh-start 与仓库里这份一字不差。
    const out = join(box, 'unpacked')
    mkdirSync(out, { recursive: true })
    const untar = spawnSync('tar', ['-xzf', join(box, 'srv', 'updates', VERSION, 'scripts.tgz'), '-C', out])
    expect(untar.status).toBe(0)
    for (const rel of updateScriptFiles()) {
      expect(readFileSync(join(out, rel), 'utf8')).toBe(readFileSync(join(REPO_ROOT, rel), 'utf8'))
    }
  }, 180_000)

  /**
   * 手机包指纹那道核对,真跑一遍(2026-10-03,审计 C 条)。
   *
   * **0928 连发四版,手机包每次都是同一份旧的** —— 发版脚本原来只看"文件在不在"。
   * 现在它从包里读那行 `butler_app_tree` 跟 `git rev-parse HEAD:butler-app` 比:
   * 上面那一条走的是**对得上**那一支(没带 `--skip-apk-check` 也过了),这里四条是不对的四种样子:
   * 指纹是别人的 / 指纹对得上但打包时那棵树是脏的 / 包里记的版本号是上一版的 / 包里压根没有那一份。
   */
  it('★手机包不是这份源码打的 → 整趟发版停下,一件产物都不写出来', async () => {
    const box = newBox()
    const repo = stageRepo(box, 'stale')
    const origin = await serveDir(join(box, 'srv'))
    await expect(publish(box, repo, origin, ['--with', 'apk'])).rejects.toThrow(/手机包不是这会儿这份源码打出来的/)
    // 停在构建那一段 —— 清单压根没写出来(更谈不上推)。
    expect(existsSync(join(box, 'srv', 'updates', 'latest.json'))).toBe(false)
  }, 180_000)

  it('★指纹对得上、但那棵树当时是脏的(dirty:true)→ 也拒', async () => {
    // tree id 与 HEAD 一致,所以上面那一道过得去 —— 而包里的字节并不是那个 tree 的字节。
    const box = newBox()
    const repo = stageRepo(box, 'dirty')
    const origin = await serveDir(join(box, 'srv'))
    await expect(publish(box, repo, origin, ['--with', 'apk'])).rejects.toThrow(/有没提交改动/)
    expect(existsSync(join(box, 'srv', 'updates', 'latest.json'))).toBe(false)
  }, 180_000)

  /**
   * 第四道(2026-10-03,卡 claude/phone-in-app-update)。
   *
   * 手机端的「有没有新版」就是拿包里那个 `versionName`(= build.json 的 `version`)
   * 跟清单里 apk 那一格的版本比。`butler-app` 两版之间一个字没改时那棵树的 id 是一样的,
   * 于是拿上一版打的包发这一版,前三道全过 —— 清单说这份包是 9.9.9,装上去还是 9.9.8,
   * 手机于是**永远显示「有新版 9.9.9」**,按下去下的还是同一份。
   */
  it('★指纹与干净都对、只是包里记的版本号是上一版的 → 也拒(不然手机永远显示有新版)', async () => {
    const box = newBox()
    const repo = stageRepo(box, 'oldversion')
    const origin = await serveDir(join(box, 'srv'))
    await expect(publish(box, repo, origin, ['--with', 'apk'])).rejects.toThrow(/版本号与这一版对不上/)
    expect(existsSync(join(box, 'srv', 'updates', 'latest.json'))).toBe(false)
  }, 180_000)

  it('★包里压根没有那一份 build.json(10-03 之前打的旧包)→ 也拒,不是"算了就这样吧"', async () => {
    const box = newBox()
    const repo = stageRepo(box, true)
    // 把那份真 zip 换成一个没有 build.json 的 zip(旧包的样子)。
    const stage = join(box, 'old-apk-stage')
    mkdirSync(join(stage, 'assets', 'public'), { recursive: true })
    writeFileSync(join(stage, 'assets', 'public', '别的东西.txt'), '旧包里没有那一份\n')
    const out = join(repo, 'butler-app/android/app/build/outputs/apk/debug/app-debug.apk')
    rmSync(out, { force: true })
    execFileSync('zip', ['-q', '-r', out, 'assets'], { cwd: stage })
    const origin = await serveDir(join(box, 'srv'))
    await expect(publish(box, repo, origin, ['--with', 'apk'])).rejects.toThrow(/没有构建指纹/)
    expect(existsSync(join(box, 'srv', 'updates', 'latest.json'))).toBe(false)
  }, 180_000)

  it('`--skip-apk-check "<理由>"` 放行,并把理由记进清单(公网上看得见这一版没核过)', async () => {
    const box = newBox()
    const repo = stageRepo(box, 'stale')
    const origin = await serveDir(join(box, 'srv'))
    const { manifest } = await publish(box, repo, origin, [
      '--with', 'apk', '--skip-apk-check', '手机那半边(build.json)还没合进来',
    ])
    expect(Object.keys(manifest.assets).sort()).toEqual(['apk', 'plugin_tgz', 'runtime_tgz', 'scripts_tgz'])
    const raw = JSON.parse(readFileSync(join(box, 'srv', 'updates', 'latest.json'), 'utf8')) as { apk_check_skipped?: string }
    expect(raw.apk_check_skipped).toBe('手机那半边(build.json)还没合进来')
    // 客户端对认不出来的顶层字段一律忽略 —— 这一格不会把谁的升级挡住。
    const parsed = parseManifest(readFileSync(join(box, 'srv', 'updates', 'latest.json'), 'utf8'), `${origin}/updates/latest.json`)
    expect(parsed.assets.apk?.size).toBeGreaterThan(0)
  }, 180_000)
})
