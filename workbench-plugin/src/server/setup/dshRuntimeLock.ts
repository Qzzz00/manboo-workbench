/**
 * DSH 运行时的**整棵依赖树**锁定清单(2026-09-23,从零重装验收白屏之后)。
 *
 * ## 为什么光锁 `@deepseek-ai/dsh@0.1.2-rc.1` 不够
 *
 * 以前运行时那步是 `npm i @deepseek-ai/dsh@<锁定版本>`:顶层锁住了,**传递依赖照 ^ 范围拉最新**。
 * 09-23 上游新发了 cordis 一家(cordis 4.0.2→4.0.4、cordis-plugin-hmr 1.0.17→1.0.19、
 * loader / include / group / timer、cosmokit、schemastery),跟 dsh 0.1.2-rc.1 不兼容 ——
 * 新装的机器 dsh 一启动就崩(`user patch-layer watching requires the Cordis HMR service`),
 * App 白屏。09-20 装的旧机器没事,只因为那时上游还没发。
 *
 * ## 怎么锁
 *
 * `dsh-runtime/runtime.package.json` 与 `runtime.package-lock.json` 是 09-20 那台能用的机器上
 * `~/.dsh/runtime` 里的**原样**两份(sha256 与备份逐字节相同)。装运行时那步先把它们写进
 * 运行时目录,再 `npm ci` —— npm ci 只照锁文件装,不解析范围,装出来的每一个包都与那台机器相同。
 * 三个 client 包(`EXTRA_DSH_PACKAGES`)已经是这份清单的顶层依赖,不用再单独补。
 *
 * ## 换 DSH 版本时(C3:升级是独立任务)
 *
 * 改 `LOCKED_DSH_VERSION` **必须同时重生成这两份文件**:在一个空目录里
 * `npm i @deepseek-ai/dsh@<新版本> <三个 client 包>@<新版本>`,真起一次 DSH 确认能用,
 * 再把那里的 package.json / package-lock.json 拷回来。`tests/dsh-runtime-lock.test.ts`
 * 会核对锁文件里 dsh 与三个 client 包的版本等于 `LOCKED_DSH_VERSION`,忘了重生成会红。
 *
 * **别带 `--prefer-offline`**(2026-09-25 实测):本机 npm 缓存里那份 packument 是上一版留下的,
 * prefer-offline 不回源刷新,于是刚发的版本被判成"不存在"
 * (`ETARGET No matching version found for @deepseek-ai/dsh-acp-app@0.1.7-rc.2`)。
 * 用 `--prefer-online`:元数据回源,tarball 仍然走 `~/.npm` 缓存。
 * 09-25 那一轮:生成清单 2 分 19 秒(521 个包),照它 `npm ci` 装第二遍 13 秒(全在缓存里)。
 *
 * JSON 用 import 带进来(而不是运行时从仓库读文件):插件、裸机引导(`scripts/bootstrap.ts`)、
 * 桌面安装包的内核(tsdown 打成单文件)三条路都跑这一段,import 能保证三条路上都带着它,
 * 不用各自再收一份资源。
 */
import runtimePackage from './dsh-runtime/runtime.package.json' with { type: 'json' }
import runtimeLock from './dsh-runtime/runtime.package-lock.json' with { type: 'json' }
import type { SetupIo } from './io.ts'
import { EXTRA_DSH_PACKAGES } from './paths.ts'

interface LockEntry { version?: string }
interface LockFile { packages: Record<string, LockEntry | undefined> }

export const DSH_RUNTIME_PACKAGE: unknown = runtimePackage
export const DSH_RUNTIME_LOCK: unknown = runtimeLock

/**
 * 一对锁定清单(2026-09-25 升 0.1.7)。
 *
 * **为什么要让它可传**:热更新要能换 DSH 版本,而跑更新作业的是**旧那份插件的进程** ——
 * 它 `import` 进来的这一对永远是旧版本的。所以 `runtime_tgz` 下下来之后,新的一对由
 * `readRuntimeLockPair` 从解包目录里读出来,一路传到运行时那一步(写清单、判幂等、核版本
 * 三处都得用**同一对**,用混了就会出现"照新清单装完、拿旧清单核版本"这种假红/假绿)。
 */
export interface DshRuntimeLockPair {
  packageJson: unknown
  lock: unknown
}

/** 插件里编进来的那一对(安装器、裸机引导、体检都用它)。 */
export const BUNDLED_RUNTIME_LOCK: DshRuntimeLockPair = { packageJson: runtimePackage, lock: runtimeLock }

/** 写进运行时目录的文本(npm 自己写出来的就是两空格缩进 + 结尾换行)。 */
export function runtimePackageJsonText(pair: DshRuntimeLockPair = BUNDLED_RUNTIME_LOCK): string {
  return `${JSON.stringify(pair.packageJson, null, 2)}\n`
}
export function runtimeLockText(pair: DshRuntimeLockPair = BUNDLED_RUNTIME_LOCK): string {
  return `${JSON.stringify(pair.lock, null, 2)}\n`
}

/** 锁文件里某个顶层包(`node_modules/<name>`)的版本。 */
export function lockedRuntimeVersion(name: string, pair: DshRuntimeLockPair = BUNDLED_RUNTIME_LOCK): string | undefined {
  return (pair.lock as LockFile).packages[`node_modules/${name}`]?.version
}

/** 这一对清单锁的是哪一版 DSH。给界面那句人话与守门用例用;读不出来回 undefined,不猜。 */
export function lockedDshVersion(pair: DshRuntimeLockPair = BUNDLED_RUNTIME_LOCK): string | undefined {
  return lockedRuntimeVersion('@deepseek-ai/dsh', pair)
}

/** 热更新解包目录里那一对清单的文件名(与 publish-update.sh 打包时用的名字逐字相同)。 */
export const RUNTIME_LOCK_FILENAMES = {
  packageJson: 'runtime.package.json',
  lock: 'runtime.package-lock.json',
} as const

/**
 * 从一个目录里读出那一对清单(2026-09-25)。
 *
 * **读不到 / 不是 JSON / 形状不对就回一句人话**,绝不退回插件里那份旧的 —— 悄悄用旧清单
 * 会让一次"升级"变成"看着升了其实没换 DSH",而界面会说成功。宁可这一步失败让人再点一次。
 *
 * 形状只校验到"锁文件里有 packages、而且里面有 @deepseek-ai/dsh":再深就是重写一遍 npm 的
 * 校验;而这一条已经能挡住"下到一半的文件""发版时打错了目录"这两类真实错误
 * (字节级的把关在 sha256 那一层,下载时已经做过)。
 */
export function readRuntimeLockPair(files: { packageJson: string | undefined, lock: string | undefined }): { ok: true, pair: DshRuntimeLockPair } | { ok: false, error: string } {
  if (files.packageJson === undefined || files.lock === undefined) {
    return { ok: false, error: `更新包里的运行环境清单不全(缺 ${files.packageJson === undefined ? RUNTIME_LOCK_FILENAMES.packageJson : RUNTIME_LOCK_FILENAMES.lock})` }
  }
  let packageJson: unknown
  let lock: unknown
  try { packageJson = JSON.parse(files.packageJson) }
  catch { return { ok: false, error: `更新包里的 ${RUNTIME_LOCK_FILENAMES.packageJson} 不是合法 JSON` } }
  try { lock = JSON.parse(files.lock) }
  catch { return { ok: false, error: `更新包里的 ${RUNTIME_LOCK_FILENAMES.lock} 不是合法 JSON` } }
  const packages = (lock as { packages?: unknown } | null)?.packages
  if (typeof packages !== 'object' || packages === null) {
    return { ok: false, error: `更新包里的 ${RUNTIME_LOCK_FILENAMES.lock} 里没有 packages 那一段` }
  }
  const pair: DshRuntimeLockPair = { packageJson, lock }
  if (lockedDshVersion(pair) === undefined) {
    return { ok: false, error: `更新包里的 ${RUNTIME_LOCK_FILENAMES.lock} 里找不到 @deepseek-ai/dsh 的版本` }
  }
  return { ok: true, pair }
}

/**
 * 装完要核对的关键包。**cordis 一家就是 09-23 漂掉的那一串**,dsh 主包与三个 client 包是
 * 少了就白屏的那几个。全列而不是抽查:都是一次读一个小 package.json,几十毫秒。
 *
 * 2026-09-25(升 0.1.7-rc.2):`@deepseek-ai/cordis-plugin-hmr` 在 0.1.7 的依赖树里**没有了**,
 * 热重载改由 `@deepseek-ai/dsh-hmr` 管(profile 的 `patchReload` 一并成了死字段,见 install.ts)。
 * 名字换了要一起换 —— 留着一个 0.1.7 装不出来的名字,`lockedRuntimeVersion` 回 undefined,
 * `runtimeDrift` 会把它整条 `continue` 掉,那一项就等于**静默不核**。
 */
export const DSH_RUNTIME_GUARD_PACKAGES: readonly string[] = [
  '@deepseek-ai/dsh',
  ...EXTRA_DSH_PACKAGES,
  '@deepseek-ai/dsh-app-boot',
  '@deepseek-ai/dsh-hmr',
  '@deepseek-ai/cordis',
  '@deepseek-ai/cordis-plugin-loader',
  '@deepseek-ai/cordis-plugin-include',
  '@deepseek-ai/cordis-plugin-group',
  '@deepseek-ai/cordis-plugin-timer',
  '@deepseek-ai/cosmokit',
  '@deepseek-ai/schemastery',
]

export interface RuntimeDrift {
  name: string
  want: string
  /** 缺席 = 这个包根本没装上。 */
  got?: string
}

/**
 * 运行时目录里关键包的实际版本与锁文件逐个比。空数组 = 全对。
 * `pair` 缺省是插件里编进来的那一对;热更新换 DSH 版本时传下下来的那一对。
 */
export async function runtimeDrift(io: SetupIo, runtimeDir: string, pair: DshRuntimeLockPair = BUNDLED_RUNTIME_LOCK): Promise<RuntimeDrift[]> {
  const out: RuntimeDrift[] = []
  for (const name of DSH_RUNTIME_GUARD_PACKAGES) {
    const want = lockedRuntimeVersion(name, pair)
    if (want === undefined) continue
    const text = await io.readFile(`${runtimeDir}/node_modules/${name}/package.json`)
    let got: string | undefined
    if (text !== undefined) {
      try { got = String((JSON.parse(text) as { version?: unknown }).version ?? '') || undefined }
      catch { got = undefined }
    }
    if (got !== want) out.push(got === undefined ? { name, want } : { name, want, got })
  }
  return out
}

/**
 * 「运行环境换到这一版了没有」的**唯一判据**(2026-09-26,卡 U6)。
 *
 * ## 为什么要把它收成一处
 *
 * 09-26 生产切换那天:0.3.6 的客户端执行 0.4.0 的热更新,**它的步骤表里没有 `runtime`**,
 * 于是运行环境一个字没换;换上 0.4.0 之后再点「检查更新」,那条路只比插件版本号
 * (`isNewerVersion(manifest.version, current)`)→ `available:false` → **运行环境永远装不上**。
 * 同一台机器上体检却认得出来(「装的是 0.1.2-rc.1,锁定版本是 0.1.7-rc.2」)——
 * 一件事两个地方各判一次,其中一处漏了。
 *
 * 所以从这一版起:体检那一项、「检查更新」、`/state.update`、启动时那条提示,
 * **全读这一个函数**。判据只有一句话:`DSH_RUNTIME_GUARD_PACKAGES` 里每一个包的实际版本
 * 与锁定清单逐个对得上。顶层 `@deepseek-ai/dsh` 就在那张表的第一行,所以"换没换版本"与
 * "传递依赖漂没漂"是同一个判断,不再分两套。
 *
 * **整个运行时目录都不在**也算漂 —— 那台机器要做的事(装一次运行环境)跟"装了个旧的"一样。
 */
export interface RuntimeDriftState {
  /** 对不上 = 要装一次运行环境。 */
  drifted: boolean
  /** 锁定清单锁的是哪一版 DSH(读不出来时是空串 —— 清单坏了,别拿它当判据)。 */
  locked: string
  /** 这会儿装着的是哪一版 DSH。读不出来缺席(没装 / package.json 坏了),**不猜**。 */
  installed?: string
  /** 逐项差异。给日志与体检那一行用。 */
  items: readonly RuntimeDrift[]
  /** 内部话:「@deepseek-ai/cordis 应是 4.0.4,装成了 4.0.2」。不漂时是空串。 */
  detail: string
  /** 给不懂代码的人看的一句(界面、系统通知原样用)。不漂时缺席。 */
  says?: string
}

/**
 * 现读一次「运行环境换到这一版了没有」。
 * `pair` 缺省是插件里编进来的那一对(体检、启动提示、一键装都用它);
 * 热更新解包下来那一对由调用方传进来。
 */
export async function readRuntimeDrift(
  io: SetupIo,
  runtimeDir: string,
  pair: DshRuntimeLockPair = BUNDLED_RUNTIME_LOCK,
): Promise<RuntimeDriftState> {
  const locked = lockedDshVersion(pair) ?? ''
  const items = await runtimeDrift(io, runtimeDir, pair)
  const dshRow = items.find(item => item.name === '@deepseek-ai/dsh')
  /**
   * 装着的是哪一版:`@deepseek-ai/dsh` 那一行对得上(不在差异表里)就是锁定的那一版;
   * 对不上就是它报的 `got`;`got` 也没有(整个包不在)就缺席 —— 不猜(D13)。
   */
  const installed = dshRow === undefined ? (locked === '' ? undefined : locked) : dshRow.got
  const drifted = items.length > 0
  return {
    drifted,
    locked,
    ...(installed === undefined ? {} : { installed }),
    items,
    detail: drifted ? describeDrift(items) : '',
    ...(drifted ? { says: humaneDrift(locked, installed) } : {}),
  }
}

/**
 * 那一句人话。**不出现 npm / 锁文件 / 依赖树**这些词(占位盘查盯着的内部词),
 * 但版本号照说 —— 它是他转述给维护者时唯一有用的东西。
 */
export function humaneDrift(locked: string, installed: string | undefined): string {
  const want = locked === '' ? '这一版要的那一版' : locked
  return installed === undefined
    ? `DSH 运行环境还没换到这一版(这一版要 ${want},这台电脑上还没装上)。`
    : `DSH 运行环境还没换到这一版(装着的是 ${installed},这一版要 ${want})。`
}

/** 给人看的一行:「@deepseek-ai/cordis 应是 4.0.4,装成了 4.0.2」。 */
export function describeDrift(drift: readonly RuntimeDrift[]): string {
  return drift.map(item => item.got === undefined
    ? `${item.name} 没装上(应是 ${item.want})`
    : `${item.name} 应是 ${item.want},装成了 ${item.got}`).join(';')
}

/**
 * 运行时目录里那份 package-lock.json 是不是就是这份锁定清单(比内容,不比缩进)。
 * `pair` 缺省是插件里编进来的那一对;热更新换 DSH 版本时传下下来的那一对 ——
 * 拿旧清单判"装过了没有"会把一台该升级的机器判成"已经装好了,不用装"。
 */
export function isLockedRuntimeLock(text: string | undefined, pair: DshRuntimeLockPair = BUNDLED_RUNTIME_LOCK): boolean {
  if (text === undefined) return false
  try { return JSON.stringify(JSON.parse(text)) === JSON.stringify(pair.lock) }
  catch { return false }
}
