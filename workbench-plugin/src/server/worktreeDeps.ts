/**
 * 开出来的工作树软链依赖(2026-10-23,卡「派活给名片的四处」②)。
 *
 * 板子开的工作树(派活的独立工作区)里没有 `node_modules`,以前那家要自己动手装 —— 慢、占盘,
 * 10-21 并行卡死的教训就是各装一份。现在开工作树时:凡**主检出里存在** `<子目录>/node_modules`
 * 的(本仓库这种「顶层子目录各自一套依赖」的布局),工作树里同位置软链过去;软链**不进提交**,
 * 写进 `info/exclude`。
 *
 * 两个实测的事实(2026-10-23,本仓库的真 worktree 上核过):
 *
 * - linked worktree 的 `.git` 是**文件**不是目录,`git rev-parse --git-path info/exclude` 解析到的是
 *   **公共目录**那份(`<主检出>/.git/info/exclude`,所有 worktree 共用)—— 所以写一次,这条仓库的
 *   所有工作树都生效,不往每个 worktree 的 `.git` 文件里瞎写;
 * - 软链用**相对路径**(`workbench-plugin/node_modules -> ../../../../workbench-plugin/node_modules`,
 *   与 README 给外来 Agent 的那条手摆命令同方向),主检出挪位置也不断。
 *
 * I/O 全部走 {@link WorktreeDepsIo} 注入:用例给假件,生产是 {@link nodeWorktreeDepsIo}。
 * 「找不到就不链」是字面意思 —— 主检出里没有一处 `<子目录>/node_modules` 就一件不链、回空表,
 * 调用方照常把活派出去(这不是失败)。
 */
import { execFile } from 'node:child_process'
import { readdir, readFile, stat, symlink, mkdir, writeFile, lstat } from 'node:fs/promises'
import { dirname, join, relative } from 'node:path'
import { promisify } from 'node:util'

const execFileP = promisify(execFile)

export interface WorktreeDepsIo {
  /** 主检出顶层的子目录名(只目录;`.` 开头的跳过)。 */
  topDirs: (projectPath: string) => Promise<string[]>
  /** `<dir>/node_modules` 在不在(目录或软链都算)。 */
  hasNodeModules: (dir: string) => Promise<boolean>
  /** 软链要落的位置是不是已经有了(有了不盖)。 */
  linkExists: (path: string) => Promise<boolean>
  /** 起软链(target → path);父目录不在先补。 */
  symlink: (target: string, path: string) => Promise<void>
  /** 这一处 worktree 的 `info/exclude` 路径(`git rev-parse --git-path`;linked worktree 的 `.git` 是文件)。 */
  infoExcludePath: (worktree: string) => Promise<string>
  /** 往 `info/exclude` 追加几行(已有的不重复追加)。 */
  appendLines: (file: string, lines: readonly string[]) => Promise<void>
}

/** 生产那份:真盘 + 真 git。 */
export function nodeWorktreeDepsIo(): WorktreeDepsIo {
  return {
    async topDirs(projectPath) {
      const entries = await readdir(projectPath, { withFileTypes: true })
      return entries.filter(one => one.isDirectory() && !one.name.startsWith('.')).map(one => one.name)
    },
    async hasNodeModules(dir) {
      try { await stat(join(dir, 'node_modules')); return true }
      catch { return false }
    },
    async linkExists(path) {
      try { await lstat(path); return true }
      catch { return false }
    },
    async symlink(target, path) {
      await mkdir(dirname(path), { recursive: true })
      await symlink(target, path)
    },
    async infoExcludePath(worktree) {
      const { stdout } = await execFileP('git', ['-C', worktree, 'rev-parse', '--git-path', 'info/exclude'], { encoding: 'utf8' })
      return stdout.trim()
    },
    async appendLines(file, lines) {
      let have = ''
      try { have = await readFile(file, 'utf8') }
      catch { /* 还没有这一份:从头写 */ }
      const missing = lines.filter(one => !have.split('\n').includes(one))
      if (missing.length === 0) return
      await mkdir(dirname(file), { recursive: true })
      const base = have === '' || have.endsWith('\n') ? have : `${have}\n`
      await writeFile(file, `${base}${missing.join('\n')}\n`, 'utf8')
    },
  }
}

/**
 * 把工作树缺的 `<子目录>/node_modules` 软链到主检出那一份,并把链过的写进 `info/exclude`。
 * 回链过的子目录名(可能空表 = 主检出里没有可链的,一件不链、照常派活)。
 */
export async function linkWorktreeNodeModules(
  io: WorktreeDepsIo,
  input: { projectPath: string, worktree: string },
): Promise<{ linked: readonly string[] }> {
  const linked: string[] = []
  for (const dir of await io.topDirs(input.projectPath)) {
    const main = join(input.projectPath, dir)
    if (!(await io.hasNodeModules(main))) continue
    const at = join(input.worktree, dir, 'node_modules')
    if (!(await io.linkExists(at))) {
      // 相对路径(与 README 手摆那条同方向):主检出挪位置也不断。
      await io.symlink(relative(join(input.worktree, dir), join(main, 'node_modules')), at)
    }
    linked.push(dir)
  }
  if (linked.length > 0) {
    await io.appendLines(await io.infoExcludePath(input.worktree), linked.map(dir => `${dir}/node_modules`))
  }
  return { linked }
}
