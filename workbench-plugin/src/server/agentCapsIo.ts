/**
 * 能力体检真去碰这台电脑的那几下(2026-09-25,卡 O)。判断全在 `agentCaps.ts`(纯函数),这里只做 I/O,
 * 而且**每一样都是注入的**(执行器、写文件、壳的通道)—— 用例接假的,一次也不会真跑命令行、真开窗口。
 *
 * 纪律:
 * - 问「登没登」只跑那家**自己的** status 命令,输出只取一个布尔,**一个字都不记、不打印**(里面可能有账号名);
 * - 「登录 X」只开一扇终端窗口跑那家**自己的**登录命令,账号密码在它自己的登录页上填,工作台不经手;
 * - 看窗口只用 `focus_input`(只找输入框、不送字、不抢焦点)。
 */
import type { AgentDispatchFamily, CapFamily } from '../protocol.ts'
import { dispatchFamilyTitle } from '../protocol.ts'
import type { CapWindowFact, CliRunResult } from './agentCaps.ts'
import { cliLoginOf, loginScript, windowFactOf } from './agentCaps.ts'
import { appBundleNameOf, bundleForEntry, openCommandFor } from './agentSources.ts'
import type { HelperRequest } from './helperChannel.ts'

/**
 * 那家的 app 在「应用程序」里叫什么(Codex 就是 ChatGPT.app,同一个 bundle)。
 *
 * ★ 2026-09-25(卡 Z):原来从写死的 `CLIENT_DISPATCH_OPEN_COMMANDS` 里取。
 * 2026-09-28:拉起命令已一律按包标识(`open -b`),名字改从知识表那条 `open -a <名字>` 取
 * (`appBundleNameOf`)—— 只给「stat 一下 `.app` 在不在」这条退路用,不再当拉起命令;
 * 运行时新接上的那一家只有包标识、没有 App 名 —— 那时回 undefined,不猜一个名字去 stat。
 */
export function appNameOf(family: AgentDispatchFamily): string | undefined {
  return appBundleNameOf(family)
}

/** 那家的 app 装没装:`/Applications` 或 `~/Applications` 下那个 .app 在不在(一次 stat,不起进程)。 */
export function appInstalledWith(home: string, exists: (path: string) => boolean): (family: AgentDispatchFamily) => boolean {
  return (family) => {
    const name = appNameOf(family)
    if (name === undefined) return false
    return exists(`/Applications/${name}.app`) || (home !== '' && exists(`${home}/Applications/${name}.app`))
  }
}

/** 跑一条命令拿退出码与输出(生产:execFile + 超时,stdin 关着 —— `codex` 在 stdin 是开着的管道时会一直等)。 */
export type CliExec = (bin: string, args: readonly string[]) => Promise<CliRunResult>

/** 问那家命令行登没登。**绝不抛**;输出只进 `cliLoginOf` 取一个布尔。 */
export function createCliLoginProbe(deps: { exec: CliExec, binOf: (family: 'claude' | 'codex' | 'kimi') => string | undefined }) {
  return async (family: 'claude' | 'codex' | 'kimi'): Promise<{ login: 'yes' | 'no' | 'unknown', note?: string }> => {
    // Kimi 没有只本地的 status 命令:不跑猜的命令(D13),如实说没查(真派出去它自己会说登没登)。
    if (family === 'kimi') return cliLoginOf(family, { code: null, stdout: '', stderr: '' })
    const bin = deps.binOf(family)
    if (bin === undefined) return { login: 'unknown', note: `这台电脑上还没有 ${dispatchFamilyTitle(family)} 改文件要用的那一份` }
    const args = family === 'claude' ? ['auth', 'status', '--json'] : ['login', 'status']
    try { return cliLoginOf(family, await deps.exec(bin, args)) }
    catch { return { login: 'unknown', note: `这次没问出 ${dispatchFamilyTitle(family)} 登没登` } }
  }
}

export interface LoginLauncherDeps {
  /** 登录脚本放哪(生产:`~/.dsh/workbench/login`)。 */
  dir: string
  binOf: (family: 'claude' | 'codex') => string | undefined
  writeScript: (file: string, text: string) => Promise<void>
  /** `open -a Terminal <file>`。 */
  openTerminal: (file: string) => Promise<boolean>
}

/**
 * 「登录 X」:写一份只跑那家自己登录命令的 `.command` 脚本,用「终端」打开它。
 * 为什么是终端窗口而不是后台跑:那家的登录要在浏览器里点「授权」,有时还要把一串码贴回来 ——
 * 一扇看得见的窗口,他知道现在在登哪一家、登好没有;工作台只在旁边等「登没登」变成是。
 */
export function createLoginLauncher(deps: LoginLauncherDeps) {
  return async (family: 'claude' | 'codex'): Promise<{ ok: boolean, note: string }> => {
    const who = dispatchFamilyTitle(family)
    const bin = deps.binOf(family)
    // Codex 那一份跟着 ChatGPT 走(没有就是 ChatGPT 太旧);Claude 缺那一份就在窗口里先用它官方的安装程序装。
    if (bin === undefined && family === 'codex') return { ok: false, note: '要让 Codex 直接改你电脑上的文件,先把 ChatGPT 更新到最新版' }
    const file = `${deps.dir}/login-${family}.command`
    try {
      await deps.writeScript(file, loginScript(family, bin))
      const opened = await deps.openTerminal(file)
      if (!opened) return { ok: false, note: `没能打开那个窗口(「终端」没起来)` }
      return {
        ok: true,
        note: bin === undefined
          ? `开了一个窗口:先装好 ${who} 要用的那一份,再打开 ${who} 自己的登录页(账号密码工作台不经手)。好了这里会自己变`
          : `开了一个窗口,打开了 ${family === 'claude' ? 'Claude' : 'ChatGPT'} 自己的登录页:登一次就好(账号密码工作台不经手),登好了这里会自己变`,
      }
    }
    catch (error) {
      return { ok: false, note: `没能打开登录窗口:${error instanceof Error ? error.message : String(error)}` }
    }
  }
}

/**
 * 看一眼那家的窗口:`focus_input`(focus:false),只找输入框、不送字、不抢焦点。
 *
 * ★ **「一扇窗都没有」要再问一句是不是藏着**(2026-10-01)。窗口槽把不在台前那一格的 App 藏起来,
 * 藏着的 App 辅助功能一扇窗都列不出 —— 这一眼与「它真的没有窗口」长得一模一样,结论却差得远:
 * 前者派活时工作台自己会把它切到台前,后者要她去点一下。所以这一支再问壳一句 `app_info`
 * (只回 running / hidden / 窗口数,不读任何内容),藏着就改说藏着。
 * 问不到(老壳、这一下出错)一个字不改,照旧按原来那句说。
 */
export function createWindowProbe(deps: { request: (req: HelperRequest, timeoutMs?: number) => Promise<Record<string, unknown>>, now: () => Date }) {
  return async (family: CapFamily): Promise<CapWindowFact> => {
    const at = deps.now().toISOString()
    const bundleId = bundleForEntry(family) ?? family
    try {
      await deps.request({ op: 'focus_input', bundle_id: bundleId, index: 0, focus: false }, 10_000)
      return { state: 'ok', at }
    }
    catch (error) {
      const fact = windowFactOf(error instanceof Error ? error.message : String(error), at)
      if (fact.state !== 'no_window') return fact
      try {
        const info = await deps.request({ op: 'app_info', bundle_id: bundleId }, 4000)
        const result = (typeof info.result === 'object' && info.result !== null ? info.result : info) as Record<string, unknown>
        if (result.hidden === true) return { state: 'hidden', at }
      }
      catch { /* 问不到就按原来那句说(老壳没有这一问) */ }
      return fact
    }
  }
}
