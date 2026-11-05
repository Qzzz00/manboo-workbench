/**
 * 桌面安装包内核的命令行外壳(2026-09-18)。**逻辑一行都不在这儿** ——
 * 全在 `src/server/setup/installer.ts`(那里有用例,这里没有,所以这里越薄越好)。
 * 同 `scripts/bootstrap.ts` 的分法。
 *
 * 谁调它:`安装工作台.app` 里的 Swift 界面,经 `Resources/stage0.sh`(那一段负责
 * 先弄到一条能跑 TypeScript 的 node —— 这个文件本身就是 TypeScript,没有 node 跑不了)。
 *
 *     node install-from-bundle.ts --resources <.app/Contents/Resources> [--home <家>] [--json]
 *
 * 退出码:0 装完;1 参数不对;2 某一步装失败。
 */
import { randomUUID } from 'node:crypto'
import { access, readFile } from 'node:fs/promises'
import {
  bundleOf, encodeInstallerEvent, findBundledTarball, humanInstallerEvent, INSTALLER_STEPS,
  parseInstallerArgs, runInstaller, withInstallLog,
} from '../src/server/setup/installer.ts'
import { withSkippedCommands } from '../src/server/setup/bootstrap.ts'
import { nodeSetupIo } from '../src/server/setup/io.ts'
import { setupPaths } from '../src/server/setup/paths.ts'
import { checkEventsOf, liveSelfCheck, offlineSelfCheck, readOfflineFacts } from '../src/server/setup/installSelfCheck.ts'

const parsed = parseInstallerArgs(process.argv.slice(2), process.env)
if (!parsed.ok) {
  console.error(parsed.error)
  process.exit(1)
}
const args = parsed.args

if (args.plan) {
  for (const [index, step] of INSTALLER_STEPS.entries()) {
    console.log(`${index + 1}. ${step.key}\t${step.title}${step.optional === true ? '(可选)' : ''}`)
  }
  process.exit(0)
}

// `--no-launch`:一条 launchctl 都不跑。做成 io 包装而不是给安装步骤加参数 ——
// 那是**调用方的处境**,不是安装步骤的属性(同 bootstrap.ts 里那段注释)。
const io = args.noLaunch
  ? withSkippedCommands(nodeSetupIo(), cmd => (cmd[0] === 'launchctl' ? `跳过(--no-launch):${cmd.join(' ')}` : undefined))
  : nodeSetupIo()
const tarball = await findBundledTarball(io, args.resources)
if (tarball === undefined) {
  console.error(`${args.resources}/payload/plugin 里没有插件的 .tgz —— 这个安装包是坏的或者没打全,重新下一份。`)
  process.exit(1)
}

const appsDir = args.applicationsDir
const paths = setupPaths({ home: args.home, dshHome: args.dshHome, ...(appsDir === undefined ? {} : { applicationsDir: appsDir }) })
const toScreen = args.json
  ? (event: Parameters<typeof encodeInstallerEvent>[0]): void => { console.log(encodeInstallerEvent(event)) }
  : (event: Parameters<typeof encodeInstallerEvent>[0]): void => {
      const line = humanInstallerEvent(event)
      if (line !== undefined) console.log(line)
    }
// 每条事件先落一份到磁盘(2026-09-27,卡 PN):窗口一关界面里那块日志就没了,
// 而出错时我们真正需要的是她把日志发过来。写失败不挡安装(见 withInstallLog)。
const emit = withInstallLog(io, args.logFile, toScreen)
emit({ t: 'logfile', path: args.logFile })

const outcome = await runInstaller({
  io,
  paths,
  bundle: bundleOf(args.resources, tarball),
  now: () => Date.now(),
  newId: () => randomUUID(),
  emit,
  // 装不进 /Applications 时退到家目录下那个(有些机器上 /Applications 是管起来的)。
  fallbackApplicationsDir: `${args.home}/Applications`,
  withApplicationsDir: dir => setupPaths({ home: args.home, dshHome: args.dshHome, applicationsDir: dir }),
  ...(args.only === undefined ? {} : { only: args.only }),
})

/**
 * 装完之后自检三件(2026-10-21,卡「引导三件事」):早报、交代、电话各一行「成 / 没成 + 缺哪道门」。
 * 服务起来了就打 8791 真跑一遍;`--no-launch`(隔离环境)或等不到服务就只看本机文件,如实说没真跑。
 * **不影响退出码**:自检没成是「缺哪道门」,不是装失败。只装几步(`--steps`)时不跑。
 */
if (outcome.ok && args.only === undefined) {
  emit({ t: 'note', text: '装完了,先把三件事各试一遍:早报、交代一件事、打个电话。' })
  const base = 'http://127.0.0.1:8791'
  let up = false
  if (!args.noLaunch) {
    for (let i = 0; i < 45 && !up; i++) {
      up = await fetch(`${base}/state`).then(res => res.ok, () => false)
      if (!up) await new Promise(resolve => setTimeout(resolve, 2000))
    }
  }
  const live = up ? await liveSelfCheck({ baseUrl: base }) : undefined
  const rows = live ?? offlineSelfCheck(await readOfflineFacts({
    dshHome: args.dshHome,
    home: args.home,
    readFile: file => readFile(file, 'utf8'),
    exists: file => access(file).then(() => true, () => false),
    why: args.noLaunch ? '这一遍没起服务(--no-launch)' : up ? '工作台服务三分钟内没跑完自检' : '等了一分半,工作台服务还没起来',
  }))
  for (const event of checkEventsOf(rows)) emit(event)
}

process.exit(outcome.ok ? 0 : 2)
