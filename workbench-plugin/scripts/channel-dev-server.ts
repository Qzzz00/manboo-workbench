/**
 * 只为「在本机把通道层跑通一遍」而存在的一台小工作台。
 *
 * 为什么需要它:Ben 常跑的那台 8791 是**已经装进 ~/.dsh 运行时的 0.2.33**,里头没有
 * /channel/*(那是这张卡刚加的)。这张卡不许碰 ~/.dsh、不许部署、不许重启运行时,
 * 所以要真跑一遍,只能在旁边起一台**同一份源码**的服务:
 *
 *   - 路由是真的(startWorkbenchServer,和 0.2.33 升级后跑的是同一段代码);
 *   - 看板是真的(createTasksService),只是数据目录换成临时的 —— 不往他的真看板里扔测试卡;
 *   - DSH 会话通道**没有**(这台不是 DSH 插件,拿不到 sessionController)。所以建事项会
 *     如实回 `note: '会话未开'` —— 那正是 D13 要的那条降级路径,顺带也验到了。
 *   - 工人的常驻那一层是真的(createChannelWorkerService),只是启动脚本用 --start-script 指到
 *     仓库里那份,不去动 ~/.dsh/bin。
 *   - **引导的阶段机也是真的**(2026-09-18,引导改通话模式):`--repo` 指一个**临时 git 仓库**,
 *     记忆与 onboarding.json 都落在临时目录里,不碰他真的记忆仓库、不碰 ~/.dsh/workbench/onboarding.json。
 *
 * 用法:
 *   WORKBENCH_CHANNEL_API_KEY=devkey WORKBENCH_CHANNEL_API_SECRET=secret \
 *   node scripts/channel-dev-server.ts --port 8795 --dir /tmp/channel-dev
 *
 * **不要**把它当成生产入口:没有额度、没有窗位、没有哨兵,只有看板 + 配对 + 通道层。
 */
import { execFile } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { CHANNEL_INBOX_NAME, createChannelService } from '../src/server/channel.ts'
import { createChannelWorkerService } from '../src/server/channelWorker.ts'
import { CALL_TOOL_DOING, CALL_TOOL_REMEMBER } from '../src/server/rtcCall.ts'
import { startWorkbenchServer } from '../src/server/http.ts'
import { nodeBriefIo } from '../src/server/projectBrief.ts'
import { createWorkbenchService } from '../src/server/service.ts'
import { createTasksService } from '../src/server/tasks.ts'
import { createPairingService } from '../src/server/devices.ts'
import { createAuthorizationService } from '../src/server/authorization.ts'
import { createOnboardingService, defaultAuthorizationFile } from '../src/server/onboarding.ts'
import { createProjectsService } from '../src/server/projectsService.ts'
import { createCallOutService } from '../src/server/callOut.ts'
import { createAppConfig } from '../src/server/appConfig.ts'
import { createDeviceDirectoryService } from '../src/server/deviceDirectory.ts'
import { createButlerService } from '../src/server/butler.ts'

function arg(name: string, fallback: string): string {
  const index = process.argv.indexOf(`--${name}`)
  return index >= 0 ? (process.argv[index + 1] ?? fallback) : fallback
}

const port = Number(arg('port', '8795'))
const dir = arg('dir', '/tmp/channel-dev')
// 工人的启动脚本。本机跑一遍时指到仓库里那份 deploy/channel-start(**不碰 ~/.dsh/bin**)。
const startScript = arg('start-script', `${process.env.HOME ?? ''}/.dsh/bin/channel-start`)
const workerLog = arg('worker-log', join(dir, 'channel-worker.log'))
// AGENTS.md 只读:人设从他真写过的那一份取,和通话模式同源。
const agentsFile = arg('agents', `${process.env.HOME ?? ''}/.dsh/AGENTS.md`)
/**
 * 引导的记忆仓库(2026-09-18)。**缺省就在数据目录底下**,绝不默认指到他真的仓库:
 * 引导会往 docs/记忆 里写文件、会 commit,跑一遍本机验证不该在他的仓库里留下东西。
 */
const repoRoot = arg('repo', join(dir, 'repo'))
/**
 * 引导里「真去扫一遍仓库」要扫的那个根(2026-09-20,Ben:「授权扫仓库,但是没去扫」)。
 *
 * **缺省是临时目录底下的 `scan-root`**,不默认指到他真的 `~/Documents/GitHub`:
 * 本机跑一遍验证不该去读他那 100 多个仓库(慢,而且没必要)。
 * 要拿真目录验就 `--scan-root ~/Documents/GitHub` —— 那条路只读。
 */
const scanRoot = arg('scan-root', join(dir, 'scan-root'))
/** AGENTS.md 引导会改(首行名字 + 说话方式那一段),所以**用一份拷贝**,不动他真的那份。 */
const agentsWriteFile = arg('agents-write', join(dir, 'AGENTS.md'))
/**
 * 手机从电脑取文件(2026-09-25,卡 J):事务官自己的文件夹(收件 / 发件的上一级)。
 * **缺省在数据目录底下**,绝不默认指到他真的 `~/Documents/事务官`。工人那边的
 * `WORKBENCH_CHANNEL_INBOX_DIR` 要指到它底下的 `收件`,两边才是同一个文件夹。
 */
const workDir = arg('work-dir', join(dir, '事务官'))
/** 取文件那张卡上写的电脑名(「在书房 Mac上找到了」)。 */
const computerName = arg('computer', '书房 Mac')
/**
 * `--lan`:另起一台监听 0.0.0.0(与「允许手机在局域网访问」同一段代码),
 * 让本机上的假手机从局域网地址进来 —— 那样 8791 看到的是**非回环**来源,令牌那道门是真的。
 */
const lanOn = process.argv.includes('--lan')
/**
 * `--butler-port`(2026-09-25,卡 S「出了局域网也能按住说话」):把 `/butler/proxy/*` 接到这个端口上的本机后端
 * (通常是 channel-worker/dev/fake-butler.ts)。缺省不接,与原来一样。
 * butler.json 写在数据目录里,**不碰** ~/.dsh/workbench/butler.json;不带令牌(假后端不认它)。
 */
const butlerPort = arg('butler-port', '')

mkdirSync(dir, { recursive: true })

mkdirSync(repoRoot, { recursive: true })

mkdirSync(scanRoot, { recursive: true })

const execFileAsync = promisify(execFile)

/** git 执行器。失败一律 `{ ok:false }`,不抛 —— 与 src/index.ts 那份同一条纪律。 */
async function gitExec(args: readonly string[], cwd: string): Promise<{ ok: boolean, stdout: string }> {
  try {
    const { stdout } = await execFileAsync('git', args as string[], { cwd })
    return { ok: true, stdout }
  }
  catch {
    return { ok: false, stdout: '' }
  }
}

async function listDir(target: string): Promise<string[]> {
  const entries = await readdir(target, { withFileTypes: true })
  return entries.filter(entry => entry.isDirectory()).map(entry => join(target, entry.name))
}

async function isRepo(target: string): Promise<boolean> {
  try { await stat(join(target, '.git')); return true }
  catch { return false }
}

const tasks = createTasksService({ file: join(dir, 'tasks.json') })
/**
 * 项目区(2026-09-20)。`POST /onboarding/scan` 复用的就是它 —— 电话里听到的
 * 「你有 N 个仓库」和电脑上项目区看到的必须是同一个 N,所以这里也不另起一套。
 * codexHome 指到临时目录:本机验证不该去读他真的 Codex 会话。
 */
const projects = createProjectsService({
  file: join(dir, 'projects.json'),
  exec: gitExec,
  listDir,
  isRepo,
  codexHome: join(dir, 'codex'),
  codexDeps: { listFiles: async () => [], readFile: async () => '' },
  home: dir,
  scanRoots: [{ path: scanRoot, depth: 1 }],
  scanMinIntervalSec: 0,
})
const authorization = createAuthorizationService({ file: defaultAuthorizationFile(repoRoot) })
const onboarding = createOnboardingService({
  file: join(dir, 'onboarding.json'),
  repoRoot,
  agentsFile: agentsWriteFile,
  authorization,
  tasks,
  // 引导技能:开发时在仓库里那一份(装机后是 ~/.dsh/skills/引导/SKILL.md)。
  skillFiles: [
    join(repoRoot, '.dsh', 'skills', '引导', 'SKILL.md'),
    new URL('../../.dsh/skills/引导/SKILL.md', import.meta.url).pathname,
  ],
})
await onboarding.load()
const pairing = createPairingService({ file: join(dir, 'devices.json') })
const channel = createChannelService({
  agentsFile,
  tasks,
  inboxName: CHANNEL_INBOX_NAME,
  rememberTool: CALL_TOOL_REMEMBER,
  doingTool: CALL_TOOL_DOING,
})

/**
 * 座机主动来电(2026-09-21)。台账落**临时目录**,不碰 ~/.dsh/workbench/call-out.json ——
 * 本机跑一遍不该让 Ben 真的那台座机记下几通测试电话。
 * 合并窗可以调小(`--merge-window` 秒),不然验「完成合并」要等五分钟。
 */
const callOut = createCallOutService({
  file: join(dir, 'call-out.json'),
  tasks: { list: () => tasks.list() },
  mergeWindowMs: Number(arg('merge-window', '300')) * 1000,
})
await callOut.load()

/**
 * 设备间传文件(2026-09-21)。两样:
 *   - `appConfig` 里写上扫描根 —— `GET /channel/search-roots` 回的就是它(门在授权表);
 *   - `deviceDirectory` 存工人报上来的在线设备表与传输流水。
 */
const appConfig = createAppConfig({ file: join(dir, 'app.json') })
await appConfig.set({ scan_roots: [{ path: scanRoot, depth: 3 }], ...(lanOn ? { lan_access: true } : {}) })
mkdirSync(workDir, { recursive: true })
const deviceDirectory = createDeviceDirectoryService()

const channelWorker = createChannelWorkerService({
  script: startScript,
  logFile: workerLog,
  env: { WORKBENCH_CHANNEL_WORKBENCH_URL: `http://127.0.0.1:${port}` },
  log: line => console.log(line),
})

const butler = butlerPort === ''
  ? undefined
  : (() => {
      const configFile = join(dir, 'butler.json')
      writeFileSync(configFile, `${JSON.stringify({ version: 1, port: Number(butlerPort) })}\n`)
      return createButlerService({ configFile, runCommand: async () => ({ ok: false, stdout: '' }) })
    })()

const server = await startWorkbenchServer({
  port,
  service: createWorkbenchService(),
  ...(butler === undefined ? {} : { butler }),
  // 2026-09-21:主动来电那一拍挂在 tick 上,所以这台夹层的 tick 要真的跑起来(缺省 1 秒)。
  tickIntervalMs: Number(arg('tick', '1000')),
  heartbeatMs: 0,
  usageIntervalMs: 0,
  tasks,
  pairing,
  channel,
  channelWorker,
  onboarding,
  authorization,
  projects,
  // 读项目(2026-09-24,已有项目拉齐):只读扫描根下的临时仓库,门同 /onboarding/scan。
  projectBrief: { io: nodeBriefIo(), home: dir },
  callOut,
  deviceDirectory,
  paths: { home: dir, config: appConfig },
  fileWorkDir: workDir,
  computerName,
  ...(lanOn ? { lan: { config: appConfig } } : {}),
})

const status = await channel.status()
console.log(`[channel-dev] 起来了:${server.url}(数据目录 ${dir},人设读 ${agentsFile})`)
console.log('[channel-dev] 通道层状态:', status)
console.log('[channel-dev] 注意:这台没有 DSH 会话通道,建出来的事项会如实标「会话未开」。')

console.log(`[channel-dev] 工人启动脚本 ${startScript},日志 ${workerLog}(POST /channel/start 拉起)`)
console.log(`[channel-dev] 引导:记忆仓库 ${repoRoot},AGENTS.md 拷贝 ${agentsWriteFile},onboarding.json ${join(dir, 'onboarding.json')}`)
console.log(`[channel-dev] 座机来电台账 ${join(dir, 'call-out.json')},合并窗 ${arg('merge-window', '300')} 秒`)
console.log(`[channel-dev] 引导扫描根 ${scanRoot}(POST /onboarding/scan;要授权表里 read_scan_roots = 可以)`)
console.log(`[channel-dev] 设备间传文件:GET /devices/online、/devices/transfers;找文件的根也是 ${scanRoot}`)
console.log(`[channel-dev] 取文件(卡 J):事务官文件夹 ${workDir},电脑名「${computerName}」${lanOn ? ',局域网监听开着(0.0.0.0)' : ''}`)

const stop = (): void => {
  void channelWorker.dispose().then(() => server.close()).then(() => process.exit(0))
}
process.on('SIGINT', stop)
process.on('SIGTERM', stop)
