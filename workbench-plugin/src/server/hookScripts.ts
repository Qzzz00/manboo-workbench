/**
 * 钩子脚本放到固定位置(2026-09-25,卡 R「接额度用的钩子脚本随插件走」)。
 *
 * ## 为什么要有这个模块
 *
 * 各家(Claude Code、Codex)的 hook 配置里写的是一条**绝对路径**的命令。这条路径指到哪,
 * 决定了插件升级、换装法之后钩子还灵不灵:
 *
 * - 指开发仓库(09-17 的做法):普通用户机器上没有仓库 → 永远接不上(卡 R 的起因)。
 * - 指插件包里的 `bin/`:DSH 的 profile 是 pnpm 装的,包的真实目录名里带版本号
 *   (`node_modules/.pnpm/@ben+dsh-workbench@file+…-0.2.99.tgz/…`),升一次级旧目录就没了;
 *   升级那几秒、以及插件被卸掉之后,他每开一次会话 Claude Code 都要报一次「钩子跑不起来」。
 * - **指 `~/.dsh/workbench/hooks/`(这里的做法)**:插件每次起服务把包里那两个脚本同步过去,
 *   **内容有变才覆盖**、先写临时文件再改名(正在跑的那一次钩子读到的永远是整份)。位置永远不变,
 *   插件卸掉了脚本也还在,工作台不在时它照样安静地退出 0(agent-hook.sh 的铁律)。
 *
 * ## 脚本从哪来(按顺序,取第一个两样都齐的)
 *
 * 1. **这份代码自己所在的包**:从模块目录往上,`package.json` 名字是 `@ben/dsh-workbench` 的那一层的 `bin/`。
 *    装好的机器上是 profile 里那份包;开发机上就是正在跑的这份 checkout 的 `workbench-plugin/`。
 * 2. **开发仓库**(开发时的兜底,排最后):往上找 `workbench-plugin/bin/agent-hook.sh`。
 *
 * **不看 `butler_cwd`**:那是事务官的工作目录(`~/Documents/工作台`),不是仓库。
 * 两处都找不到、而固定位置上已经有一份能跑的 → 就用那一份(不删、不改);连那一份都没有才算接不上。
 *
 * ## 这里的纪律
 *
 * - 只写 `~/.dsh/workbench/hooks/` 这一个目录里的这两个文件(加上改名前那一个临时文件)。
 *   **一个字都不认 `process.env.HOME`**:家目录由调用方给(2026-09-04 家目录被删事故之后的纪律)。
 * - 放不成**不拦起服务**:起服务时只记一行日志;「接上」那一步会再试一次,还不成就回一句人话。
 */
import { chmod as fsChmod, mkdir as fsMkdir, readFile as fsReadFile, rename as fsRename, stat as fsStat, unlink as fsUnlink, writeFile as fsWriteFile } from 'node:fs/promises'
import { WB_HOOK_SCRIPT, WB_HOOK_SCRIPTS, WB_HOOKS_REPO_MARKER, wbHooksDir } from './hooksConfig.ts'

/** 插件包的名字(package.json 的 name)。认「这一层是插件包的根」靠它。 */
export const WB_PLUGIN_PACKAGE_NAME = '@ben/dsh-workbench'

/**
 * **运行时要从插件包里读的文件**(相对包根)。只有这张表里的能读;每一项都必须进包
 * (package.json 的 `files`)—— tests/package-files-guard.test.ts 拿 `npm pack` 的真实清单逐项对,
 * 以后谁加了一个运行时要读的包内文件却忘了进包,那条用例当场红。
 */
export const PACKAGE_RUNTIME_FILES: readonly string[] = WB_HOOK_SCRIPTS.map(name => `bin/${name}`)

/** 同步过去的脚本的权限:rwxr-xr-x(各家是直接 exec 这个文件的)。 */
const SCRIPT_MODE = 0o755

export interface WbHookScriptsIo {
  readFile: (path: string) => Promise<string | undefined>
  stat: (path: string) => Promise<{ isFile: boolean, executable: boolean } | undefined>
  mkdirp: (path: string) => Promise<void>
  /** 原子地换上一份新内容(同目录临时文件 + 改名),并给执行权限。 */
  replaceFile: (path: string, content: string, mode: number) => Promise<void>
  chmod: (path: string, mode: number) => Promise<void>
}

/** 真实文件系统那一份。 */
export function nodeHookScriptsIo(): WbHookScriptsIo {
  return {
    async readFile(path) {
      try { return await fsReadFile(path, 'utf8') }
      catch { return undefined }
    },
    async stat(path) {
      try {
        const info = await fsStat(path)
        return { isFile: info.isFile(), executable: (info.mode & 0o111) !== 0 }
      }
      catch { return undefined }
    },
    async mkdirp(path) { await fsMkdir(path, { recursive: true }) },
    async replaceFile(path, content, mode) {
      // 临时文件与目标同目录:rename 只有在同一个文件系统里才是原子的。
      const temp = `${path}.tmp-${process.pid}-${Date.now()}`
      try {
        await fsWriteFile(temp, content, { encoding: 'utf8', mode })
        await fsChmod(temp, mode)
        await fsRename(temp, path)
      }
      catch (error) {
        // 只收拾自己刚造的那一个临时文件(它的名字是这一次现起的,不会是别人的东西)。
        try { await fsUnlink(temp) } catch { /* 本来就没造出来 */ }
        throw error
      }
    },
    async chmod(path, mode) { await fsChmod(path, mode) },
  }
}

/** 上一层目录;已经到根(或不是绝对路径)就 undefined。 */
function parentOf(dir: string): string | undefined {
  if (dir === '/' || !dir.startsWith('/')) return undefined
  const cut = dir.lastIndexOf('/')
  return cut === 0 ? '/' : dir.slice(0, cut)
}

/** 去掉末尾斜杠。 */
function trimDir(dir: string): string {
  let out = dir.trim()
  while (out.length > 1 && out.endsWith('/')) out = out.slice(0, -1)
  return out
}

/** 从 `moduleDir` 往上逐层走到根,每一层回调一次;回调给出结果就停。 */
async function walkUp<T>(moduleDir: string, visit: (dir: string) => Promise<T | undefined>): Promise<T | undefined> {
  let dir: string | undefined = trimDir(moduleDir)
  while (dir !== undefined && dir !== '') {
    const found = await visit(dir)
    if (found !== undefined) return found
    dir = parentOf(dir)
  }
  return undefined
}

/**
 * 这份代码所在的插件包的根:从模块目录往上,第一个 `package.json` 名字对得上的那一层。
 * 读不到、名字对不上的一律跳过继续往上 —— 不拿别的包的 `bin/` 顶替。
 */
export async function wbPluginPackageRoot(moduleDir: string, io: Pick<WbHookScriptsIo, 'readFile'>): Promise<string | undefined> {
  return await walkUp(moduleDir, async (dir) => {
    const text = await io.readFile(`${dir === '/' ? '' : dir}/package.json`)
    if (text === undefined) return undefined
    try {
      const name = (JSON.parse(text) as { name?: unknown } | null)?.name
      return name === WB_PLUGIN_PACKAGE_NAME ? dir : undefined
    }
    catch { return undefined }
  })
}

export interface WbHookScriptsSource {
  /** 两个脚本所在的目录。 */
  dir: string
  /** `package` = 插件包自己的 bin/;`dev_repo` = 开发仓库(开发时的兜底)。 */
  from: 'package' | 'dev_repo'
}

/** 一个目录里这两个脚本是不是都读得到。 */
async function hasAllScripts(dir: string, io: Pick<WbHookScriptsIo, 'readFile'>): Promise<boolean> {
  for (const name of WB_HOOK_SCRIPTS) {
    const text = await io.readFile(`${dir}/${name}`)
    if (text === undefined || text.trim() === '') return false
  }
  return true
}

/**
 * 脚本从哪来:① 插件包自己的 `bin/`;② 开发仓库的 `workbench-plugin/bin/`(兜底,排最后)。
 * **不看 butler_cwd。** 两处都不齐就 undefined。
 */
export async function wbHookScriptsSource(opts: {
  moduleDir: string
  io: Pick<WbHookScriptsIo, 'readFile'>
}): Promise<WbHookScriptsSource | undefined> {
  const root = await wbPluginPackageRoot(opts.moduleDir, opts.io)
  if (root !== undefined) {
    const dir = `${root === '/' ? '' : root}/bin`
    if (await hasAllScripts(dir, opts.io)) return { dir, from: 'package' }
  }
  const repoBin = await walkUp(opts.moduleDir, async (dir) => {
    const base = dir === '/' ? '' : dir
    const marker = await opts.io.readFile(`${base}/${WB_HOOKS_REPO_MARKER}`)
    if (marker === undefined) return undefined
    const bin = `${base}/workbench-plugin/bin`
    return (await hasAllScripts(bin, opts.io)) ? bin : undefined
  })
  return repoBin === undefined ? undefined : { dir: repoBin, from: 'dev_repo' }
}

export interface WbHookScriptsReady {
  ok: true
  /** 固定位置。写进各家配置的命令只指这里。 */
  dir: string
  /** 这一次的脚本是从哪同步来的;`kept` = 来源找不到,用的是固定位置上原有的那一份。 */
  from: WbHookScriptsSource['from'] | 'kept'
  /** 这一次真换了内容的脚本(内容一样就不写,所以平常是空的)。 */
  changed: string[]
  /**
   * 新内容没换上、先接着用原有那一份的脚本(磁盘满之类;转发脚本各版之间兼容)。
   * 只进日志 —— 钩子照样灵,不值得打断他。
   */
  stale: string[]
}

export interface WbHookScriptsFail {
  ok: false
  /** `no_home` 不知道家目录在哪;`no_source` 包里、开发仓库里都没有这两个脚本;`write_failed` 放不进固定位置。 */
  reason: 'no_home' | 'no_source' | 'write_failed'
  /** **给人看的那一句**:为什么接不上 + 下一步点什么。不出现仓库、插件、路径、英文文件名。 */
  error: string
  /** 给日志的技术细节(路径、系统报错)。**不上界面。** */
  detail: string
}

export type WbHookScriptsResult = WbHookScriptsReady | WbHookScriptsFail

/**
 * 三种接不上各一句人话。**都以同一颗按钮收尾**:界面上出错时那一屏有「再试一次」
 * (ConnectAllDialog / HooksApplyDialog)。不叫他去改任何设置 —— 能自己修的这里已经修过了
 * (来源找不到就用原有那份、权限不对就补上),走到这里的是真修不了的。
 */
export const HOOK_SCRIPTS_ERRORS: Readonly<Record<WbHookScriptsFail['reason'], string>> = {
  no_home: '这次没接上:工作台找不到你的用户文件夹,没地方放接额度要用的两个小文件。你的配置一个字都没动。重启一次工作台后点「再试一次」。',
  no_source: '这次没接上:这一版工作台少了接额度要用的两个小文件(安装不完整)。你的配置一个字都没动。点「再试一次」;还不行就重新装一次工作台。',
  write_failed: '这次没接上:工作台没能在自己的文件夹里放下接额度要用的两个小文件(多半是电脑存储空间满了)。你的配置一个字都没动。腾出一点空间后点「再试一次」。',
}

function fail(reason: WbHookScriptsFail['reason'], detail: string): WbHookScriptsFail {
  return { ok: false, reason, error: HOOK_SCRIPTS_ERRORS[reason], detail }
}

/**
 * 把来源目录里的两个脚本同步到固定位置:内容一样就不写;不一样(升级了)就原子替换;
 * 内容一样但没执行权限就补上。**不删任何东西。**
 *
 * `source` 缺席(包里、开发仓库里都没找到)时不写,只看固定位置上原有的那一份能不能用。
 */
export async function wbHookScriptsSync(opts: {
  source: WbHookScriptsSource | undefined
  targetDir: string
  io: WbHookScriptsIo
}): Promise<WbHookScriptsResult> {
  const { io, source, targetDir } = opts
  const changed: string[] = []
  const stale: string[] = []
  for (const name of WB_HOOK_SCRIPTS) {
    const target = `${targetDir}/${name}`
    const want = source === undefined ? undefined : await io.readFile(`${source.dir}/${name}`)
    const have = await io.readFile(target)
    let problem: string | undefined
    try {
      if (want !== undefined && want !== have) {
        await io.mkdirp(targetDir)
        await io.replaceFile(target, want, SCRIPT_MODE)
        changed.push(name)
      }
      else if (have !== undefined && (await io.stat(target))?.executable !== true) {
        await io.chmod(target, SCRIPT_MODE)
      }
    }
    catch (error) {
      problem = error instanceof Error ? error.message : String(error)
    }
    const after = await io.stat(target)
    if (after?.isFile !== true || !after.executable) {
      if (source === undefined) return fail('no_source', `包里与开发仓库里都没有 ${name},固定位置 ${targetDir} 上也没有能用的一份`)
      return fail('write_failed', `${target} 没放成${problem === undefined ? '' : `:${problem}`}`)
    }
    // 换新内容失败(磁盘满之类)但原有那一份还能跑:先接着用它 —— 转发脚本各版之间是兼容的。
    if (problem !== undefined) stale.push(name)
  }
  return { ok: true, dir: targetDir, from: source?.from ?? 'kept', changed, stale }
}

export interface WbHookScripts {
  /** 固定位置(`~/.dsh/workbench/hooks`)。家目录不知道时 undefined。 */
  dir: string | undefined
  /** 各家 hook 配置里该指的那个脚本(`<dir>/agent-hook.sh`)。「接上没有」按它判。 */
  hookScript: string | undefined
  /**
   * 确保两个脚本在固定位置、内容是这一版的、能执行。**排队执行**(起服务那一下与「接上」撞在一起时
   * 不会两边同时写),幂等(内容一样就一个字不写)。
   */
  ensure: () => Promise<WbHookScriptsResult>
}

export function createHookScripts(opts: {
  /** 家目录(生产是 HOME,用例是临时目录)。 */
  home: string
  /** 这份代码所在的目录(生产用 import.meta.url 换算)。脚本来源从这里往上找。 */
  moduleDir: string
  io?: WbHookScriptsIo
}): WbHookScripts {
  const io = opts.io ?? nodeHookScriptsIo()
  const dir = wbHooksDir(opts.home)
  let chain: Promise<unknown> = Promise.resolve()

  async function run(): Promise<WbHookScriptsResult> {
    if (dir === undefined) return fail('no_home', '不知道家目录在哪(HOME 是空的)')
    const source = await wbHookScriptsSource({ moduleDir: opts.moduleDir, io })
    return await wbHookScriptsSync({ source, targetDir: dir, io })
  }

  return {
    dir,
    hookScript: dir === undefined ? undefined : `${dir}/${WB_HOOK_SCRIPT}`,
    ensure: () => {
      const next = chain.then(run)
      // 链条本身不许因为某一次失败就断掉。
      chain = next.catch(() => undefined)
      return next
    },
  }
}
