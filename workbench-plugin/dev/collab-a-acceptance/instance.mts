/**
 * 协作A验收:隔离实例的起与停(配方派生自统筹已验的 key-final 验收架;端口全换、不改冻结件)。
 * 端口组:DSH 3193 / 工作台 8993 / 模块 8994 / 语音 8992 / 连接器 8996 / 工人文字口 8997;假模型 19893;本地 LiveKit 19994-19996。
 * 临时 HOME:克隆 ~/.dsh 的 node/runtime 与 Kimi CLI 的 ~/.kimi(既有登录态,APFS 克隆不改真机那份);
 * 假 launchctl/osascript/open 拦住,不碰真机服务;真 DSH + 本树现打的插件包。
 */
import { execFile, execFileSync, spawn } from 'node:child_process'
import { cpSync, existsSync, lstatSync, mkdirSync, openSync, readdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs'
import type { Dirent } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { instanceServicePorts, resolveQaPorts } from './qa-ports.mts'

export const PORTS = resolveQaPorts(process.env.COLLAB_A_ACCEPTANCE_PORTS)
const INSTANCE_PORTS = instanceServicePorts(PORTS)

const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms))
const dirnameOf = (p: string): string => p.slice(0, Math.max(p.lastIndexOf('/'), 0))

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

async function waitHttp(url: string, ms: number): Promise<string | undefined> {
  const end = Date.now() + ms
  while (Date.now() < end) {
    try { const res = await fetch(url); if (res.ok) return await res.text() } catch { /* 还没起来 */ }
    await sleep(1000)
  }
  return undefined
}

export interface AInstance {
  root: string
  home: string
  dsh: string
  base: string
  dshLog: string
  workerLog: string
  stop: () => Promise<void>
}

export async function startAInstance(input: { root: string, repo: string, log: (line: string) => void }): Promise<AInstance> {
  const { root, repo, log } = input
  const realDsh = join(homedir(), '.dsh')
  const iso = join(root, 'iso')
  const home = join(iso, 'home')
  const dsh = join(home, '.dsh')
  const res = join(root, 'res')
  const fake = join(root, 'fakebin')
  const plugin = join(repo, 'workbench-plugin')

  for (const [name, port] of Object.entries(INSTANCE_PORTS)) {
    if (await listening(port)) throw new Error(`端口 ${port}(${name})有人在听`)
  }
  if (existsSync(iso)) throw new Error(`${iso} 已存在`)

  // 1 插件现打的包
  mkdirSync(join(res, 'payload', 'plugin'), { recursive: true })
  const script = (JSON.parse(readFileSync(join(plugin, 'package.json'), 'utf8')) as { scripts: { build: string } }).scripts.build
  log('打插件…')
  await sh('/bin/sh', ['-c', script], { cwd: plugin, env: { ...process.env, PATH: `${join(plugin, 'node_modules', '.bin')}:${process.env.PATH ?? ''}` }, timeoutMs: 600_000 })
  await sh('npm', ['pack', '--pack-destination', join(res, 'payload', 'plugin')], { cwd: plugin, timeoutMs: 300_000 })
  mkdirSync(join(res, 'payload', 'workbench-plugin', 'bin'), { recursive: true })
  mkdirSync(join(res, 'payload', 'deploy'), { recursive: true })
  mkdirSync(join(res, 'payload', 'pnpm'), { recursive: true })
  for (const one of ['dsh-start', 'butler-start']) cpSync(join(plugin, 'bin', one), join(res, 'payload', 'workbench-plugin', 'bin', one))
  cpSync(join(repo, 'deploy', 'channel-start'), join(res, 'payload', 'deploy', 'channel-start'))
  const pnpmCache = [join(repo, 'dist', '.cache', 'pnpm-11.16.0.tgz'), join(homedir(), 'Documents', 'GitHub', 'desktop-workbench', 'dist', '.cache', 'pnpm-11.16.0.tgz')].find(existsSync)
  if (pnpmCache !== undefined) cpSync(pnpmCache, join(res, 'payload', 'pnpm', 'pnpm-11.16.0.tgz'))

  // 2 临时 HOME:克隆 node / runtime / 连接器依赖 / Kimi CLI 登录态
  mkdirSync(join(dsh, 'logs'), { recursive: true })
  mkdirSync(join(dsh, 'workbench'), { recursive: true })
  log('克隆 node / runtime(APFS;Kimi 登录态不克隆 —— KIMI_CODE_HOME 直用现成)')
  await sh('cp', ['-Rc', join(realDsh, 'node'), join(dsh, 'node')])
  await sh('cp', ['-Rc', join(realDsh, 'runtime'), join(dsh, 'runtime')])
  // ★ 不复制登录凭据(2026-10-23 深夜,独立审指出后改):Kimi CLI 认 KIMI_CODE_HOME 环境变量,
  //    直接指到真机现成的 ~/.kimi-code(既有授权的正常调用,不拷目录、不读内容、不展示);
  //    缓存目录指到隔离 home,少往真机写。见 DSH 启动 env 的 KIMI_CODE_HOME。
  const connectorSrc = join(realDsh, 'open-connector')
  if (existsSync(join(connectorSrc, 'node_modules'))) {
    mkdirSync(join(dsh, 'open-connector'), { recursive: true })
    await sh('cp', ['-Rc', join(connectorSrc, 'node_modules'), join(dsh, 'open-connector', 'node_modules')])
    cpSync(join(connectorSrc, 'package.json'), join(dsh, 'open-connector', 'package.json'))
  }
  const token = (): string => Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2)
  writeFileSync(join(dsh, 'workbench', 'butler.json'), JSON.stringify({ version: 1, port: PORTS.butler, token: token() }))
  writeFileSync(join(dsh, 'workbench', 'connector.json'), JSON.stringify({ version: 1, port: PORTS.connector, runtimeToken: token(), adminToken: token(), encryptionKey: token(), services: [] }))
  writeFileSync(join(dsh, 'workbench', 'model.json'), JSON.stringify({ mode: 'own', own_base_url: `http://127.0.0.1:${PORTS.model}/v1`, own_model: 'collab-a-brain' }))
  writeFileSync(join(dsh, 'workbench', 'credentials.json'), JSON.stringify({ providers: { deepseek: { key: 'collab-a-fake-own-key-not-personal' } } }))
  writeFileSync(join(dsh, 'workbench', 'channel.json'), JSON.stringify({ url: `ws://127.0.0.1:${PORTS.livekit}`, api_key: 'collab-a-local', api_secret: 'collab-a-only-local-secret', room: 'collab-a-qa' }), { mode: 0o600 })
  writeFileSync(join(dsh, 'workbench', 'routines.json'), JSON.stringify({ morning: { enabled: false }, evening: { enabled: false }, lint: { enabled: false } }))

  // 2.5 造一个带路径的项目(Documents 下的真 git 仓,扫描根认它;CLI 派活要项目目录)
  const qaRepo = join(home, 'Documents', 'GitHub', 'collab-a-qa')  // 默认扫描根是 ~/Documents/GitHub(深1)
  mkdirSync(qaRepo, { recursive: true })
  writeFileSync(join(qaRepo, 'README.md'), '# collab-a 验收\n')
  await sh('git', ['init', '-q'], { cwd: qaRepo })
  await sh('git', ['-c', 'user.email=collab-a@qa.local', '-c', 'user.name=collab-a', 'add', 'README.md'], { cwd: qaRepo })
  await sh('git', ['-c', 'user.email=collab-a@qa.local', '-c', 'user.name=collab-a', 'commit', '-qm', 'init'], { cwd: qaRepo })
  // 归属按 remote 认项目(无 remote 的本地仓会被判成素材,不进项目表):挂一个假 origin,不取。
  await sh('git', ['remote', 'add', 'origin', 'https://github.com/collab-a-qa/placeholder.git'], { cwd: qaRepo })
  // Kimi 命令行的默认 agent file 按 cwd 解析(docs/卡/agents/kimi-coder.md):把这份产品配置带进 qa 仓(不是凭据)。
  mkdirSync(join(qaRepo, 'docs', '卡', 'agents'), { recursive: true })
  cpSync(join(repo, 'docs', '卡', 'agents', 'kimi-coder.md'), join(qaRepo, 'docs', '卡', 'agents', 'kimi-coder.md'))
  // 派活的独立工作区从 HEAD 建 —— 这份配置要落进提交,否则 worktree 里没有它。
  await sh('git', ['add', 'docs'], { cwd: qaRepo })
  await sh('git', ['-c', 'user.email=collab-a@qa.local', '-c', 'user.name=collab-a', 'commit', '-qm', 'kimi agent file'], { cwd: qaRepo })

  // 3 假 launchctl / osascript / open(不碰真机服务)
  mkdirSync(fake, { recursive: true })
  for (const cmd of ['launchctl', 'osascript', 'open']) {
    writeFileSync(join(fake, cmd), `#!/bin/sh\necho "$(date '+%F %T') ${cmd} $*" >> "${join(root, 'blocked.log')}"\nexit 1\n`, { mode: 0o755 })
  }
  const basePath = `${fake}:${join(dsh, 'node', 'bin')}:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin`
  const isoEnv = (extra: Record<string, string> = {}): NodeJS.ProcessEnv => ({
    HOME: home, USER: process.env.USER ?? '', SHELL: '/bin/zsh', LANG: 'zh_CN.UTF-8',
    TMPDIR: process.env.TMPDIR ?? '/tmp', DSH_HOME: dsh, PATH: basePath,
    WORKBENCH_PORT: String(PORTS.workbench), WORKBENCH_HOST: '127.0.0.1', WORKBENCH_MODULE_PORT: String(PORTS.module),
    ...extra,
  })

  // 4 安装内核四步(pnpm store 链,2026-10-24 两趟定案):
  //   安装内核会把**真机的 profile(含 node_modules,.modules.yaml 里 storeDir=真机 store)拷进
  //   临时 HOME 再跑 pnpm**;pnpm 认 $HOME/.npmrc 的 store-dir(实测 env npm_config_store_dir
  //   到不了它)。所以正解 = 把 .npmrc 的 store-dir 钉到**真机共享 store**,字符串与拷来的
  //   .modules.yaml 一致,一个包都不用重下。早先「改写 .modules.yaml + 符号链」那手对
  //   安装中途才落盘的拷贝来不及,walk 留作兜底(只处理安装前已存在的链)。
  log('安装内核(profile、plugin、work_repo、scripts)…')
  const shared = join(homedir(), 'Library', 'pnpm', 'store')
  const store = existsSync(shared) ? shared : join(homedir(), 'Library', 'Caches', 'workbench-acceptance', 'pnpm-store')
  mkdirSync(store, { recursive: true })
  // ★ pnpm store 两链对齐(2026-10-24 三趟定案,root 热修 148 后 dsh 会把真机 profile 连
  //   node_modules 拷进临时 HOME 再跑 pnpm):
  //   1) pnpm 的用户配置/os.homedir() 都不认临时 HOME,`iso/.npmrc` 无效;env 只认 PNPM_HOME
  //      → 钉 PNPM_HOME=真机共享 store 的上级,pnpm 算出的 store = <它>/store/v11,
  //      与拷来的 .modules.yaml 的 storeDir 字符串一致(内容寻址,一个包不用重下)。
  //   2) virtual-store-dir 没有 env 通道:pnpm 要「profile 目录下的 node_modules/.pnpm」,
  //      拷来的记着真机那边的 —— 安装一跑起来就派看门狗,每 100ms 扫临时 HOME 里落盘的
  //      .modules.yaml,把 storeDir/virtualStoreDir 两行就地改成 pnpm 将要算出的路径。
  //      第一趟若竞不过 pnpm,失败会留下这份拷贝,第二趟先补改再装(幂等)。
  const realStoreV11 = join(store, 'v11')
  const worktreeVirtualStore = join(plugin, 'node_modules', '.pnpm')
  // 安装内核(dsh plugin add)每次都会把真机 profile 重新拷进 $HOME/profiles 再跑 pnpm;
  // 拷来的 .modules.yaml 记着真机那边的 store/virtualStore 字符串,pnpm 这边要的是
  // 「真机 store + 本树 workbench-plugin/node_modules/.pnpm」——看门狗只看 $HOME/profiles
  // 这一小棵(全 home 扫太慢,来不及),把落盘的 .modules.yaml 两行就地改成 pnpm 将要
  // 算出的串;YAML(`storeDir: …`)与 pnpm v11 的 JSON(`"storeDir": "…"`)两种格式都认。
  const patchModulesYaml = (): void => {
    // 2026-10-24 四趟定案:dsh 种子把 **node_modules 本身做成指向真机 profile 的符号链**,
    // pnpm 经链读到的是真机那份 .modules.yaml(不能写真机),看门狗的一切改写都落空。
    // 所以:① 见到 profiles/*/node_modules 是符号链就摘掉(让 pnpm 在临时 HOME 里全新装);
    //   ★ profile 实际在 <DSH_HOME>/profiles(dsh 解析),不是 $HOME/profiles——早几轮改错地方。
    // ② 每个 profile 目录里补 pnpm-workspace.yaml(virtualStoreDir 钉本树虚拟仓——pnpm v11
    //   只认这个,env/.npmrc 都到不了);③ 落到真文件的 .modules.yaml 两行就地改 pnpm 将要
    //   算出的串。三手都是幂等,每 50ms 一轮。
    const profilesRoot = join(dsh, 'profiles')
    let profiles: string[] = []
    try { profiles = readdirSync(profilesRoot, { withFileTypes: true }).filter(e => e.isDirectory()).map(e => e.name) } catch { return }
    for (const name of profiles) {
      const dir = join(profilesRoot, name)
      const nm = join(dir, 'node_modules')
      try {
        const st = lstatSync(nm)
        if (st.isSymbolicLink()) rmSync(nm, { recursive: true, force: true })
      } catch { /* 还不存在 */ }
      try { writeFileSync(join(dir, 'pnpm-workspace.yaml'), `virtualStoreDir: ${join(nm, '.pnpm')}\n`) } catch { /* 写不动就交给重试 */ }
    }
    const scan = (dir: string, depth: number): void => {
      if (depth > 6) return
      let entries: Dirent<string>[]
      try { entries = readdirSync(dir, { withFileTypes: true }) } catch { return }
      for (const entry of entries) {
        const at = join(dir, entry.name)
        if (entry.isDirectory()) {
          if (entry.name === '.pnpm' || entry.name === '.git') continue
          scan(at, depth + 1)
        }
        else if (entry.name === '.modules.yaml') {
          try {
            const raw = readFileSync(at, 'utf8') as string
            const patched = raw
              .replace(/("?storeDir"?:\s*")[^"]*(")/u, `$1${realStoreV11}$2`)
              .replace(/("?virtualStoreDir"?:\s*")[^"]*(")/u, `$1${worktreeVirtualStore}$2`)
            if (patched !== raw) writeFileSync(at, patched)
          } catch { /* 读不懂/写不动就交给失败重试那一趟 */ }
        }
      }
    }
    scan(profilesRoot, 0)
  }
  const installSteps = async (): Promise<void> => {
    await sh(join(dsh, 'node', 'bin', 'node'), [join(plugin, 'scripts', 'install-from-bundle.ts'), '--resources', res, '--home', home, '--dsh-home', dsh,
      '--no-launch', '--steps', 'profile,plugin,work_repo,scripts', '--human', '--log-file', join(root, 'install.log')],
      { env: isoEnv({ npm_config_store_dir: store, PNPM_HOME: join(homedir(), 'Library', 'pnpm') }), timeoutMs: 1_200_000 })
  }
  const watcher = setInterval(patchModulesYaml, 50)
  try {
    try {
      await installSteps()
    } catch (first) {
      log(`第一趟安装没成(profile store 链,${String(first).slice(0, 100)}),补改 .modules.yaml 后再试一次…`)
      patchModulesYaml()
      await installSteps()
    }
  } finally {
    clearInterval(watcher)
  }
  const appFile = join(dsh, 'workbench', 'app.json')
  try {
    const app = JSON.parse(readFileSync(appFile, 'utf8')) as Record<string, unknown>
    writeFileSync(appFile, JSON.stringify({ ...app, audience: 'internal' }))
  } catch { /* 按外部 */ }

  // 5 DSH(工作台在它进程里)
  const dshLogPath = join(dsh, 'logs', 'web.stdout.log')
  const dshLog = openSync(dshLogPath, 'a')
  log(`起 DSH ${PORTS.dsh} / 工作台 ${PORTS.workbench}…`)
  const dshProc = spawn(join(dsh, 'node', 'bin', 'node'), [join(dsh, 'runtime', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'), 'web', '--host', '127.0.0.1', '--port', String(PORTS.dsh), '--no-open'], {
    cwd: join(dsh, 'runtime'),
    env: isoEnv({
        DSH_TELEMETRY_DISABLED: '1', DSH_PERMISSION_MODE: 'workspace-write', WORKBENCH_AUDIENCE: 'internal',
      CHANNEL_WORKER_DIR: join(repo, 'channel-worker'),
      WORKBENCH_CHANNEL_LOAD_GUARD: 'off',
      WORKBENCH_CHANNEL_BUTLER_URL: `http://127.0.0.1:${PORTS.butler}`,
      // Kimi CLI:现成登录态直用(KIMI_CODE_HOME),不复制凭据;缓存落隔离 home;不许自动更新真机那一份。
      ...(existsSync(join(homedir(), '.kimi-code')) ? { KIMI_CODE_HOME: join(homedir(), '.kimi-code') } : {}),
      KIMI_CODE_CACHE_DIR: join(dsh, 'kimi-code-cache'),
      KIMI_CLI_NO_AUTO_UPDATE: '1',
    }),
    stdio: ['ignore', dshLog, dshLog],
  })
  dshProc.unref()
  const base = `http://127.0.0.1:${PORTS.workbench}`
  if (await waitHttp(`${base}/state`, 180_000) === undefined) throw new Error(`工作台 ${PORTS.workbench} 三分钟没起来(日志 ${dshLogPath})`)
  log('工作台起来了')

  return {
    root, home, dsh, base, dshLog: dshLogPath, workerLog: join(dsh, 'workbench', 'logs', 'channel-worker.log'),
    stop: async () => {
      try { dshProc.kill('SIGTERM') } catch { /* 已退 */ }
      const end = Date.now() + 15_000
      while (Date.now() < end) {
        try { execFileSync('lsof', ['-t', '-nP', `-iTCP:${PORTS.dsh}`, '-sTCP:LISTEN'], { stdio: 'ignore' }); await sleep(500) } catch { break }
      }
    },
  }
}
