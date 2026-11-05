/**
 * 隔离实例的起与停(三入口验收用;配方同 `docs/交接-1021-引导三件事.md` 第三节,端口与目录全换掉)。
 *
 * - 临时 HOME:`<root>/iso/home`;`~/.dsh/node`、`~/.dsh/runtime` 用 APFS 克隆(`cp -c`,不占盘、一个字节不写回);
 *   插件是**这份检出现打的包**(`pnpm build` + `npm pack`),经安装内核 `install-from-bundle.ts` 装进临时 profile。
 * - 端口:DSH 3093、工作台 8893、模块 8894、语音后端 8892、连接器 8896、工人文字回合测试口 8897。真机那一套
 *   (3080 / 8791 / 8792 / 8796)一个都不碰。
 * - PATH 最前面一个假 `launchctl` / `osascript` / `open`(只记一行、退 1):同一个用户下 launchd 的服务名是共用的,
 *   不拦的话隔离实例会去重启真机的 `ai.deepseek.dsh` / `connector` / `butler`。
 * - 语音后端:起一台**自己的** butler-server(仓库源码,HOME 指临时目录),音色库从真机克隆一份 ——
 *   「换个女声」只改克隆;不起它的话插件与工人缺省连 8792,会改到维护者真机的音色。
 * - 连接器:克隆依赖目录(不带 `data/`,那里是各家账号的凭据),开机那一趟就不去下 230MB;端口指 8896。
 * - 中转:线上中转,一个**测试账号**(名字带 test)。账号与密码落在本机 `~/Library/Application Support/workbench-acceptance/`
 *   (600),不进仓库、不进交接;第一次跑注册,之后都是登录。房间按账号分,与维护者真机那间不是一间。
 * - 通话工人:跑**这份检出**的 `channel-worker`(`CHANNEL_WORKER_DIR`),文字回合测试口开在 8897,口令文件在临时目录。
 */
import { execFile, spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { chmodSync, cpSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

import { resolvePhoneAcceptancePorts, resolvePhoneAcceptanceWorkerDir, phoneRoomReplayEnvironment, type PhoneAcceptancePorts } from './phonePorts.ts'
import { verifyS4SourceProof, verifyS4PackedBundle, verifyS4InstalledBundle, type S4VerifiedSourceProof } from './s4SourceProof.ts'
import { normalS4WindowQaEnvironment, prepareNormalS4WindowQaProject, verifyNormalS4WindowQaBootstrap, prepareNormalS4Runtime } from './s4WindowQa.ts'
import { parseS4WindowQaConfig } from '../../src/server/s4WindowQaRules.ts'
import { parseModelConfig, saveModelConfig } from '../../src/server/modelConfig.ts'
export const PORTS = resolvePhoneAcceptancePorts(process.env.PHONE_ACCEPTANCE_PORTS)

export interface Instance {
  base: string
  butlerBase?: string
  /** s4 之前先换回这个男声,才看得出「换个女声」换没换。拿不到就缺席(音色那一项判不了)。 */
  maleVoice?: string
  phoneToken: string
  /** 手机那一列是怎么打的(adb 还是设备令牌直打)。 */
  phoneNote: string
  notes: string[]
  textTurn?: { port: number, token: string }
  /** 电话那一列能不能打:能就回 undefined,不能回一句原因。 */
  waitWorker: (mode: 'audio' | 'text') => Promise<string | undefined>
  workerLogMark: () => number
  toolsSince: (mark: number) => string[]
  stop: () => Promise<void>
}

const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms))

function sh(cmd: string, args: string[], opts: { cwd?: string, env?: NodeJS.ProcessEnv, timeoutMs?: number } = {}): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { cwd: opts.cwd, env: opts.env ?? process.env, maxBuffer: 1 << 26, timeout: opts.timeoutMs ?? 0 }, (err, stdout, stderr) => {
      if (err !== null) reject(new Error(`${cmd} ${args.join(' ')} 失败:${(stderr || stdout || err.message).toString().trim().split('\n').slice(-6).join(' / ')}`))
      else resolve(stdout.toString())
    })
  })
}

async function listening(port: number): Promise<boolean> {
  try { return (await sh('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN'])).trim() !== '' }
  catch { return false }
}

async function waitHttp(url: string, ms: number, ok: (status: number, body: string) => boolean = s => s === 200): Promise<string | undefined> {
  const end = Date.now() + ms
  while (Date.now() < end) {
    try {
      const res = await fetch(url)
      const body = await res.text()
      if (ok(res.status, body)) return body
    }
    catch { /* 还没起来 */ }
    await sleep(1000)
  }
  return undefined
}

const STATE_DIR = join(homedir(), 'Library', 'Application Support', 'workbench-acceptance')
const ACCOUNT_FILE = process.env.PHONE_ACCEPTANCE_ACCOUNT_FILE ?? join(STATE_DIR, 'relay-account.json')

/** 中转测试账号:第一次现编一个(名字带 test),之后复用。只落本机,600。 */
function testAccount(): { username: string, password: string, registered: boolean } {
  try {
    const saved = JSON.parse(readFileSync(ACCOUNT_FILE, 'utf8')) as { username?: string, password?: string, registered?: boolean }
    if (typeof saved.username === 'string' && typeof saved.password === 'string') return { username: saved.username, password: saved.password, registered: saved.registered === true }
  }
  catch { /* 第一次 */ }
  const fresh = { username: `wb-accept-test-${randomBytes(3).toString('hex')}`, password: randomBytes(18).toString('base64url'), registered: false }
  mkdirSync(join(ACCOUNT_FILE, '..'), { recursive: true })
  writeFileSync(ACCOUNT_FILE, JSON.stringify(fresh), { mode: 0o600 })
  return fresh
}

function saveAccount(account: { username: string, password: string, registered: boolean }): void {
  writeFileSync(ACCOUNT_FILE, JSON.stringify(account), { mode: 0o600 })
  chmodSync(ACCOUNT_FILE, 0o600)
}

export async function startInstance(input: { root: string, repo: string, build: boolean, textTurn: boolean, sourceProof?: S4VerifiedSourceProof, log: (line: string) => void }): Promise<Instance> {
  const { root, repo, log } = input
  const realDsh = join(homedir(), '.dsh')
  const iso = join(root, 'iso')
  const home = join(iso, 'home')
  const dsh = join(home, '.dsh')
  const res = join(root, 'res')
  const fake = join(root, 'fakebin')
  const plugin = join(repo, 'workbench-plugin')
  const notes: string[] = []
  const s4QaEnvironment = normalS4WindowQaEnvironment(root, home, process.env.WORKBENCH_S4_WINDOW_QA)
  const s4QaConfig = parseS4WindowQaConfig({ HOME: home, DSH_HOME: dsh, ...s4QaEnvironment })
  const s4AssemblyOnly = process.env.PHONE_ACCEPTANCE_S4_ASSEMBLY_ONLY === '1'
  if (s4AssemblyOnly && s4QaConfig === undefined) throw new Error('s4 assembly requires explicit scoped config')
  if (s4QaConfig !== undefined && !s4AssemblyOnly && input.sourceProof === undefined) throw new Error('S4 source proof required before normal instance preparation')
  const sourceProof = input.sourceProof === undefined ? undefined : await verifyS4SourceProof(repo, input.sourceProof.expectedFixedSHA, input.sourceProof.proofRoot, process.env.PHONE_ACCEPTANCE_WORKER_DIR)
  const s4RuntimeCache = s4QaConfig === undefined ? undefined : process.env.PHONE_ACCEPTANCE_S4_DSH_CACHE
  if (s4QaConfig !== undefined && !s4RuntimeCache) throw new Error('s4 QA requires explicit pinned public DSH cache, no personal runtime')

  for (const [name, port] of Object.entries(PORTS)) {
    if (await listening(port)) throw new Error(`端口 ${port}(${name})有人在听 —— 上一次没停干净?先 node dev/acceptance-three-entrances/stop.ts`)
  }
  if (existsSync(iso)) throw new Error(`${iso} 已经在了(上一次 --keep 留下的?)`)

  // 1 插件现打的包
  mkdirSync(join(res, 'payload', 'plugin'), { recursive: true })
  if (s4QaConfig !== undefined) writeFileSync(join(root, 'empty-global-npmrc'), '', { mode: 0o600, flag: 'wx' })
  if (input.build) {
    // 不经 pnpm run:工作树的 node_modules 是软链到主检出的,pnpm 跑脚本前那道依赖自检过不去。直接跑 package.json 里那一行。
    const script = (JSON.parse(readFileSync(join(plugin, 'package.json'), 'utf8')) as { scripts: { build: string } }).scripts.build
    log(`打插件(${script})…`)
    await sh('/bin/sh', ['-c', script], { cwd: plugin, env: { ...process.env, PATH: `${join(plugin, 'node_modules', '.bin')}:${process.env.PATH ?? ''}` }, timeoutMs: 600_000 })
    const regenerated = await sh('git', ['-C', repo, 'status', '--porcelain', '--', 'workbench-plugin/src/server/bundledSkills.generated.ts'])
    if (regenerated.trim() !== '') notes.push('构建时 `bundledSkills.generated.ts` 重新生成后与仓库里那份不一样(技能文本改过没重生成),装进实例的是新生成的那份')
  }
  await sh('npm', ['pack', '--pack-destination', join(res, 'payload', 'plugin')], { cwd: plugin, ...(s4QaConfig === undefined ? {} : { env: { ...process.env, HOME: home, NPM_CONFIG_USERCONFIG: '/dev/null', NPM_CONFIG_GLOBALCONFIG: join(root, 'empty-global-npmrc') } }), timeoutMs: 300_000 })
  if (sourceProof !== undefined) {
    const packed = readdirSync(join(res, 'payload/plugin')).filter(name => name.endsWith('.tgz'))
    if (packed.length !== 1) throw new Error('S4 source proof: ambiguous packed bundle')
    await verifyS4PackedBundle(sourceProof, join(res, 'payload/plugin', packed[0]!))
  }
  mkdirSync(join(res, 'payload', 'workbench-plugin', 'bin'), { recursive: true })
  mkdirSync(join(res, 'payload', 'deploy'), { recursive: true })
  mkdirSync(join(res, 'payload', 'pnpm'), { recursive: true })
  for (const one of ['dsh-start', 'butler-start']) cpSync(join(plugin, 'bin', one), join(res, 'payload', 'workbench-plugin', 'bin', one))
  cpSync(join(repo, 'deploy', 'channel-start'), join(res, 'payload', 'deploy', 'channel-start'))
  const pnpmCache = [join(repo, 'dist', '.cache', 'pnpm-11.16.0.tgz'), join(homedir(), 'Documents', 'GitHub', 'desktop-workbench', 'dist', '.cache', 'pnpm-11.16.0.tgz')].find(existsSync)
  if (pnpmCache !== undefined) cpSync(pnpmCache, join(res, 'payload', 'pnpm', 'pnpm-11.16.0.tgz'))

  // 2 临时 HOME:克隆 node / runtime / 连接器依赖 / 音色库
  mkdirSync(join(dsh, 'logs'), { recursive: true })
  mkdirSync(join(dsh, 'workbench'), { recursive: true })
  log('克隆 node / runtime(APFS,不占盘)…')
  if (s4QaConfig === undefined) {
    await sh('cp', ['-Rc', join(realDsh, 'node'), join(dsh, 'node')])
    await sh('cp', ['-Rc', join(realDsh, 'runtime'), join(dsh, 'runtime')])
  } else await prepareNormalS4Runtime(s4QaConfig, s4RuntimeCache!)
  const connectorSrc = join(realDsh, 'open-connector')
  if (s4QaConfig === undefined && existsSync(join(connectorSrc, 'node_modules'))) {
    mkdirSync(join(dsh, 'open-connector'), { recursive: true })
    await sh('cp', ['-Rc', join(connectorSrc, 'node_modules'), join(dsh, 'open-connector', 'node_modules')])
    cpSync(join(connectorSrc, 'package.json'), join(dsh, 'open-connector', 'package.json'))
  }
  const token = (): string => randomBytes(24).toString('hex')
  writeFileSync(join(dsh, 'workbench', 'butler.json'), JSON.stringify({ version: 1, port: PORTS.butler, token: token() }))
  writeFileSync(join(dsh, 'workbench', 'connector.json'), JSON.stringify({ version: 1, port: PORTS.connector, runtimeToken: token(), adminToken: token(), encryptionKey: token(), services: [] }))
  if (s4AssemblyOnly) await saveModelConfig(join(dsh, 'workbench', 'model.json'), parseModelConfig(JSON.stringify({ mode: 'own', own: { base_url: 'http://127.0.0.1:29693/v1', model: 'fixture-selected' } })))
  else writeFileSync(join(dsh, 'workbench', 'model.json'), JSON.stringify({ mode: 'relay' }))
  if (s4AssemblyOnly) writeFileSync(join(dsh, 'workbench', 'credentials.json'), JSON.stringify({ keys: { deepseek: 'local-fixture-no-personal-key' } }), { mode: 0o600 })
  // 三条例程都关:开机露面就跑的开工汇报办完了会在通话里插一句(「「开工汇报」办完了」),搅进她的回话。
  writeFileSync(join(dsh, 'workbench', 'routines.json'), JSON.stringify({ morning: { enabled: false }, evening: { enabled: false }, lint: { enabled: false } }))

  // 3 假 launchctl / osascript / open
  mkdirSync(fake, { recursive: true })
  for (const cmd of ['launchctl', 'osascript', 'open']) {
    writeFileSync(join(fake, cmd), `#!/bin/sh\necho "$(date '+%F %T') ${cmd} $*" >> "${join(root, 'blocked.log')}"\nexit 1\n`, { mode: 0o755 })
  }
  const basePath = `${fake}:${join(dsh, 'node', 'bin')}:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin`
  const isoEnv = (extra: Record<string, string> = {}): NodeJS.ProcessEnv => ({
    HOME: home,
    USER: process.env.USER ?? '',
    SHELL: '/bin/zsh',
    LANG: 'zh_CN.UTF-8',
    TMPDIR: process.env.TMPDIR ?? '/tmp',
    DSH_HOME: dsh,
    PATH: basePath,
    WORKBENCH_PORT: String(PORTS.workbench),
    WORKBENCH_HOST: '127.0.0.1',
    WORKBENCH_MODULE_PORT: String(PORTS.module),
    ...(s4QaConfig === undefined ? {} : { NPM_CONFIG_USERCONFIG: '/dev/null', NPM_CONFIG_GLOBALCONFIG: join(root, 'empty-global-npmrc'), GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_COUNT: '0' }),
    ...extra,
  })

  // 4 安装内核:profile / plugin / work_repo / scripts 四步
  log('安装内核四步(profile、plugin、work_repo、scripts)…')
  // pnpm 的包仓库用这台机器上共享的那一份(按内容寻址、只增不改;真机装插件时用的就是它):临时 HOME 里那份是空的,
  // 每次都要从 npm 下几十 MB,这台机器上慢到十几 KB/s。没有就退到一个跨次复用的缓存目录。
  const shared = join(homedir(), 'Library', 'pnpm', 'store')
  const store = existsSync(shared) ? shared : join(homedir(), 'Library', 'Caches', 'workbench-acceptance', 'pnpm-store')
  mkdirSync(store, { recursive: true })
  await sh(join(dsh, 'node', 'bin', 'node'), [join(plugin, 'scripts', 'install-from-bundle.ts'), '--resources', res, '--home', home, '--dsh-home', dsh,
    '--no-launch', '--steps', s4QaConfig === undefined ? 'profile,plugin,work_repo,scripts' : 'profile,plugin,scripts', '--human', '--log-file', join(root, 'install.log')], { env: isoEnv({ npm_config_store_dir: store }), timeoutMs: 1_200_000 })
  if (sourceProof !== undefined) {
    await verifyS4SourceProof(repo, sourceProof.expectedFixedSHA, sourceProof.proofRoot, process.env.PHONE_ACCEPTANCE_WORKER_DIR)
    await verifyS4InstalledBundle(sourceProof, home)
  }
  const appFile = join(dsh, 'workbench', 'app.json')
  try {
    const app = JSON.parse(readFileSync(appFile, 'utf8')) as Record<string, unknown>
    writeFileSync(appFile, JSON.stringify({ ...app, audience: 'internal' }))
  }
  catch { /* work_repo 那步写的;没有就按外部 */ }

  await prepareNormalS4WindowQaProject(s4QaConfig)

  // 5 自己的语音后端
  const butlerLog = openSync(join(root, 'butler.log'), 'a')
  // 语音钥匙它会回环去问工作台要(`workbenchVoiceCreds.cjs`):指到隔离实例的 8893,不去问真机 8791。
  const butler = spawn(join(dsh, 'node', 'bin', 'node'), [join(repo, 'butler-server', 'server', 'index.cjs')], { cwd: join(repo, 'butler-server'), env: isoEnv({ BUTLER_WORKBENCH_URL: `http://127.0.0.1:${PORTS.workbench}` }), stdio: ['ignore', butlerLog, butlerLog] })
  butler.unref()
  const butlerBase = `http://127.0.0.1:${PORTS.butler}`
  const butlerUp = await waitHttp(`${butlerBase}/health`, 30_000)
  if (butlerUp === undefined) notes.push('隔离实例自己的语音后端(8892)没起来:电话那一列没有声音,音色那一项判不了')

  // 6 DSH(工作台在它进程里)
  const ttToken = join(iso, 'text-turn.token')
  const dshLog = openSync(join(dsh, 'logs', 'web.stdout.log'), 'a')
  log(`起 DSH ${PORTS.dsh} / 工作台 ${PORTS.workbench}…`)
  const dshProc = spawn(join(dsh, 'node', 'bin', 'node'), [join(dsh, 'runtime', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'), 'web', '--host', '127.0.0.1', '--port', String(PORTS.dsh), '--no-open'], {
    cwd: join(dsh, 'runtime'),
    env: isoEnv({
      DSH_TELEMETRY_DISABLED: '1',
      DSH_PERMISSION_MODE: 'workspace-write',
      ...s4QaEnvironment,
      WORKBENCH_AUDIENCE: 'internal',
      CHANNEL_WORKER_DIR: sourceProof?.worker.directory ?? resolvePhoneAcceptanceWorkerDir(repo, process.env.PHONE_ACCEPTANCE_WORKER_DIR),
      // 通话护栏关着:开着的话通话期间会把这台 Mac 上别的卡的 vite / tsc 调到后台档(挂断还原),验收不碰别人的进程。
      WORKBENCH_CHANNEL_LOAD_GUARD: 'off',
      ...phoneRoomReplayEnvironment(root, input.textTurn === true, process.env.PHONE_ACCEPTANCE_ROOM_REPLAY_QA),
      WORKBENCH_CHANNEL_BUTLER_URL: butlerBase,
      ...(input.textTurn ? { WORKBENCH_CHANNEL_TEXT_TURN: '1', WORKBENCH_CHANNEL_TEXT_TURN_PORT: String(PORTS.textTurn), WORKBENCH_CHANNEL_TEXT_TURN_TOKEN_FILE: ttToken } : {}),
    }),
    stdio: ['ignore', dshLog, dshLog],
  })
  dshProc.unref()
  const base = `http://127.0.0.1:${PORTS.workbench}`
  if (await waitHttp(`${base}/state`, 180_000) === undefined) {
    if (s4QaConfig !== undefined) { dshProc.kill('SIGTERM'); butler.kill('SIGTERM') }
    throw new Error(`工作台 8893 三分钟没起来(日志 ${join(dsh, 'logs', 'web.stdout.log')})`)
  }
  try {
    await verifyNormalS4WindowQaBootstrap(s4QaConfig)
    if (sourceProof !== undefined) {
      await verifyS4SourceProof(repo, sourceProof.expectedFixedSHA, sourceProof.proofRoot, process.env.PHONE_ACCEPTANCE_WORKER_DIR)
      await verifyS4InstalledBundle(sourceProof, home)
    }
  }
  catch (error) {
    // Only children started by this invocation; a normal HTTP response is not a QA safety receipt.
    dshProc.kill('SIGTERM'); butler.kill('SIGTERM')
    throw error
  }
  log('工作台起来了')

  if (s4AssemblyOnly) {
    return {
      base, phoneToken: '', phoneNote: 's4 assembly only: no phone/account/room paired', notes,
      waitWorker: async () => 's4 assembly only: worker not requested', workerLogMark: () => 0, toolsSince: () => [],
      stop: async () => {
        dshProc.kill('SIGTERM'); butler.kill('SIGTERM')
        await sleep(3000)
        for (const [name, port] of Object.entries(PORTS)) if (await listening(port)) log(`注意:${port}(${name})仍在监听，未终止任何外部进程`)
      },
    }
  }

  const page = { 'content-type': 'application/json', origin: `http://127.0.0.1:${PORTS.dsh}` }
  const post = async (path: string, body: unknown, headers: Record<string, string> = page): Promise<{ status: number, json: Record<string, unknown> }> => {
    const r = await fetch(`${base}${path}`, { method: 'POST', headers, body: JSON.stringify(body) })
    let json: Record<string, unknown> = {}
    try { json = await r.json() as Record<string, unknown> } catch { /* 空回包 */ }
    return { status: r.status, json }
  }
  const local = { 'content-type': 'application/json' }

  // 7 中转测试账号(注册一次,之后登录)→ 设备令牌绑到账号上,工人才拿得到房间
  const account = testAccount()
  const signedIn = account.registered
    ? await post('/account/login', { username: account.username, password: account.password }, local)
    : await post('/account/register', { username: account.username, password: account.password, confirm: account.password }, local)
  if (signedIn.status >= 300) throw new Error(`中转测试账号${account.registered ? '登录' : '注册'}没成(${signedIn.status}):${String(signedIn.json.error ?? '')}`)
  if (!account.registered) saveAccount({ ...account, registered: true })
  log(`中转测试账号${account.registered ? '登录' : '注册'}了`)

  // 8 引导跳过(五问按缺省),好让 /butler/item 走平常那条路
  await post('/onboarding/skip-rest', { reason: '三入口验收' })
  await post('/first-run', { done: true }, local)

  // 9 配一台假手机(与手机 App 同一条配对路:/pair/start → /pair/claim)
  const started = await post('/pair/start', {}, local)
  const code = (started.json.pairing as { code?: string } | undefined)?.code
  if (code === undefined) throw new Error(`配对码没生成(${started.status}):${String(started.json.error ?? '')}`)
  const claimed = await post('/pair/claim', { code, device_name: '验收假手机', platform: 'android' }, local)
  const phoneToken = claimed.json.token
  const phoneId = claimed.json.device_id
  if (typeof phoneToken !== 'string' || typeof phoneId !== 'string') throw new Error(`假手机配对没成(${claimed.status}):${String(claimed.json.error ?? '')}`)

  // 10 男声(s4 之前换回它)。语音钥匙是登上中转之后才由工作台转给语音后端的:音色单回 200 之前先等着(最多一分半),
  //    不然第一列(电脑对话框)跑到第 4 句时音色单还拿不到,前后都是缺省的女声,判不了换没换。
  let maleVoice: string | undefined
  if (butlerUp !== undefined) {
    const voices = await waitHttp(`${butlerBase}/api/voices`, 90_000)
    if (voices === undefined) notes.push('语音后端一分半拿不到音色单(语音钥匙没从中转取回):第 4 句的音色那一项判不了,电话那一列可能没声音')
    else {
      try {
        const list = JSON.parse(voices) as { voices?: { id?: string, gender?: string, speaks_chinese?: boolean, ok?: boolean }[] }
        maleVoice = (list.voices ?? []).find(v => v.gender === '男' && v.speaks_chinese === true && v.ok !== false)?.id
      }
      catch { /* 判不了音色 */ }
    }
  }

  const saved: SavedInstance = {
    ports: PORTS,
    root,
    base,
    ...(butlerUp === undefined ? {} : { butlerBase }),
    ...(maleVoice === undefined ? {} : { maleVoice }),
    phoneToken,
    phoneId,
    ...(input.textTurn ? { textTurnTokenFile: ttToken } : {}),
    workerLog: join(dsh, 'workbench', 'logs', 'channel-worker.log'),
    workerPidFile: join(dsh, 'workbench', 'channel-worker.pid'),
  }
  // 给 `--attach` 与 stop.ts 用;里面有假手机的设备令牌(只对这台隔离实例有效),600。
  writeFileSync(join(root, 'instance.json'), JSON.stringify(saved), { mode: 0o600 })
  return instanceOf(saved, log, notes)
}

/** 起好的实例记下的几样(`<root>/instance.json`)。 */
interface SavedInstance {
  ports?: PhoneAcceptancePorts
  root: string
  base: string
  butlerBase?: string
  maleVoice?: string
  phoneToken: string
  phoneId: string
  textTurnTokenFile?: string
  workerLog: string
  workerPidFile: string
}

/** 接上 `run.ts --keep` 留下的那台(省掉三分钟起实例;调脚本时用)。 */
export function attachInstance(root: string, log: (line: string) => void): Instance {
  const saved = JSON.parse(readFileSync(join(root, 'instance.json'), 'utf8')) as SavedInstance
  return instanceOf(saved, log, [`接的是之前 --keep 留下的那台实例(${root})`])
}

function instanceOf(saved: SavedInstance, log: (line: string) => void, notes: string[]): Instance {
  const { base, workerLog } = saved
  const ports = saved.ports ?? PORTS
  const ttToken = (): string => { try { return readFileSync(saved.textTurnTokenFile ?? '', 'utf8').trim() } catch { return '' } }
  const sizeOf = (file: string): number => { try { return statSync(file).size } catch { return 0 } }
  return {
    base,
    ...(saved.butlerBase === undefined ? {} : { butlerBase: saved.butlerBase }),
    ...(saved.maleVoice === undefined ? {} : { maleVoice: saved.maleVoice }),
    phoneToken: saved.phoneToken,
    phoneNote: 'Pixel 没接在这台 Mac 上(adb devices 空),手机文字按设备令牌直打 /butler/item,请求体与手机 App 待发箱相同;气泡按手机自己的 chatModel.ts 算',
    notes,
    ...(saved.textTurnTokenFile === undefined ? {} : { textTurn: { port: ports.textTurn, get token() { return ttToken() } } }),
    async waitWorker(mode) {
      const end = Date.now() + 150_000
      let last = ''
      while (Date.now() < end) {
        try {
          if (mode === 'text') {
            const r = await fetch(`http://127.0.0.1:${ports.textTurn}/health`, { headers: { 'x-workbench-text-turn': ttToken() } })
            const body = await r.json() as { ready?: boolean }
            if (body.ready === true) return undefined
            last = '测试口在,工人还没进房 / 没有接话模型'
          }
          else {
            const r = await fetch(`${base}/channel/status`)
            const body = await r.json() as { participants?: string[] }
            last = JSON.stringify(body).slice(0, 300)
            if ((body.participants ?? []).includes('wb-channel-worker')) return undefined
          }
        }
        catch (err) { last = (err as Error).message }
        await sleep(3000)
      }
      const tail = (() => { try { return readFileSync(workerLog, 'utf8').split('\n').filter(l => l.trim() !== '').slice(-3).join(' / ') } catch { return '工人日志还没有' } })()
      return `两分半没等到工人进房(${last.slice(0, 160)};工人日志末尾:${tail.slice(0, 240)})`
    },
    workerLogMark: () => sizeOf(workerLog),
    toolsSince(mark) {
      let text = ''
      try { text = readFileSync(workerLog, 'utf8').slice(mark) } catch { return [] }
      return [...text.matchAll(/她调了工具:(.+)/g)].flatMap(m => m[1]!.trim().split('、'))
    },
    stop: () => stopRoot(saved.root, log, saved),
  }
}

/**
 * 收掉一台隔离实例:撤中转上这台的设备、撤假手机、退出测试账号,停 DSH / 语音后端 / 工人,删临时 HOME。
 * 进程按两样认:工人的 pid 文件;命令行里带着这个临时目录的(DSH 与语音后端都是用临时 HOME 里那份 node 起的)。
 */
export async function stopRoot(root: string, log: (line: string) => void, saved?: Pick<SavedInstance, 'phoneId' | 'workerPidFile' | 'ports'>): Promise<void> {
  log('停实例…')
  const ports = saved?.ports ?? PORTS
  const base = `http://127.0.0.1:${ports.workbench}`
  const post = (path: string, body: unknown): Promise<unknown> => fetch(`${base}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).catch(() => undefined)
  try {
    const devices = await (await fetch(`${base}/account/devices`)).json() as { devices?: { id?: string, device_id?: string }[] }
    for (const d of devices.devices ?? []) {
      const id = d.device_id ?? d.id
      if (id !== undefined) await post('/account/devices/revoke', { device_id: id })
    }
    if (saved?.phoneId !== undefined) await post('/pair/revoke', { id: saved.phoneId })
    await post('/account/logout', {})
  }
  catch { log('工作台已经不在了,中转上的设备没撤(下次登录同一个测试账号照样能用)') }
  const pids = new Set<number>()
  try {
    const pid = Number.parseInt(readFileSync(saved?.workerPidFile ?? join(root, 'iso', 'home', '.dsh', 'workbench', 'channel-worker.pid'), 'utf8'), 10)
    if (Number.isInteger(pid) && pid > 1) pids.add(pid)
  }
  catch { /* 没起过 */ }
  try {
    for (const line of (await sh('ps', ['-axo', 'pid=,command='])).split('\n')) {
      if (!line.includes(join(root, 'iso'))) continue
      const pid = Number.parseInt(line.trim(), 10)
      if (Number.isInteger(pid) && pid !== process.pid) pids.add(pid)
    }
  }
  catch { /* ps 不在 */ }
  for (const pid of pids) { try { process.kill(pid, 'SIGTERM') } catch { /* 已走 */ } }
  await sleep(4000)
  for (const pid of pids) { try { process.kill(pid, 'SIGKILL') } catch { /* 已走 */ } }
  for (const [name, port] of Object.entries(ports)) {
    if (await listening(port)) log(`注意:${port}(${name})停完还有人在听`)
  }
  // 工人日志与 DSH 日志拷出来再删(报告里的识别结果、工具名都从这两份来,事后要对得上)
  mkdirSync(join(root, 'logs'), { recursive: true })
  for (const [from, name] of [['workbench/logs/channel-worker.log', 'channel-worker.log'], ['logs/web.stdout.log', 'web.stdout.log']] as const) {
    try { cpSync(join(root, 'iso', 'home', '.dsh', from), join(root, 'logs', name)) } catch { /* 没有就算了 */ }
  }
  rmSync(join(root, 'iso'), { recursive: true, force: true })
  log(`实例停了(收了 ${pids.size} 个进程),临时 HOME 删了`)
}
