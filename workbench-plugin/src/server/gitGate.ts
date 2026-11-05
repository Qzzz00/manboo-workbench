/**
 * 「调 git 之前先看一眼」(2026-09-30,止血第 5 条;`docs/排查-写死的地方-2026-09-30.md` §五-1)。
 *
 * 一台**刚买的 Mac** 上没有命令行开发者工具:任何一次 `git`(哪怕只是 `git status`)都会
 * 弹出系统那个「要安装命令行开发者工具吗?」的对话框。引导每推进一个阶段提交一次、
 * 下班例程每晚提交一次 —— 于是她每天被问好几遍,而且点「不装」之后那一步只是静默失败。
 *
 * 这个模块就是那道门,两问:
 * 1. **这个文件夹是不是 git 仓库**(有没有 `.git`)。不是就别调 —— 跟 `butlerSkills.ts`
 *    早就在做的那一问逐字同一个判据(那边是对的,这里是把它推广到别处)。
 * 2. **装没装开发者工具**(`xcode-select -p` 成不成)。这一问自己不会弹框(`xcode-select -p`
 *    在没装时只是退出码非 0),而且**答案缓存在进程里** —— 不缓存的话「先看一眼」就成了
 *    每次多一个子进程。装上开发者工具是重启级别的事,一个进程里问一次够了。
 *
 * 过不去就如实回一句人话给调用方写进汇报(**不编一个「已提交」**,AGENTS.md:取不到就缺席)。
 */
import { execFile } from 'node:child_process'
import { access } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

/** 没装开发者工具时那一句。界面、汇报、交接里都照抄这一句。 */
export const DEV_TOOLS_MISSING_NOTE = '没装开发者工具,这一步没存版本'

/** 这个文件夹不是 git 仓库时那一句。 */
export function notAGitRepoNote(dir: string): string {
  return `${dir} 不是 git 仓库,这一步没存版本`
}

export interface GitGateResult {
  ok: boolean
  /** 过不去时的那一句人话(过得去就缺席)。 */
  note?: string
}

export interface GitGateDeps {
  /** 这个路径在不在。缺省 fs.access。 */
  exists?: (path: string) => Promise<boolean>
  /** 装没装命令行开发者工具。缺省 `xcode-select -p`。 */
  developerTools?: () => Promise<boolean>
}

/** 「装没装开发者工具」的答案,整个进程问一次。undefined = 还没问过。 */
let developerToolsCache: Promise<boolean> | undefined

/** 用例之间清缓存。生产代码不调。 */
export function forgetDeveloperTools(): void {
  developerToolsCache = undefined
}

async function defaultExists(path: string): Promise<boolean> {
  try {
    await access(path)
    return true
  }
  catch {
    return false
  }
}

/**
 * `xcode-select -p`:装了就打印路径、退出 0;没装退出非 0(**不弹框** —— 弹框的是 `git` 自己)。
 * 5 秒超时:这一问卡住不该把下班例程一起拖住。
 */
async function defaultDeveloperTools(): Promise<boolean> {
  try {
    const { stdout } = await execFileAsync('xcode-select', ['-p'], { timeout: 5_000 })
    return stdout.trim() !== ''
  }
  catch {
    return false
  }
}

/**
 * 给一个工作目录做一道门:调一次问一次(开发者工具那一问走缓存)。
 *
 * @param dir 要在里头调 git 的文件夹
 */
export function createGitGate(dir: string, deps: GitGateDeps = {}): () => Promise<GitGateResult> {
  const exists = deps.exists ?? defaultExists
  const developerTools = deps.developerTools ?? defaultDeveloperTools
  return async () => {
    if (!await exists(join(dir, '.git'))) return { ok: false, note: notAGitRepoNote(dir) }
    developerToolsCache ??= developerTools()
    if (!await developerToolsCache) return { ok: false, note: DEV_TOOLS_MISSING_NOTE }
    return { ok: true }
  }
}
