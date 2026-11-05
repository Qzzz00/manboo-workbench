/**
 * 「在 Finder 里显示」(2026-09-11 图谱交互)。
 *
 * 这是 Wiki 图谱**唯一的写接口**,而且只做一件事:`open -R <路径>` 让 Finder 弹出并选中它。
 * 不打开文件、不删除、不移动、不改名——图谱的能力边界(规格 §2.6)仍然靠"不存在"保证:
 * 这个文件里除了 `open -R` 没有第二条命令,用例逐词断言。
 *
 * ## 路径必须落在扫描根之内
 *
 * 图上的路径来自服务端自己扫出来的树,但接口是公开的 HTTP,谁都能 POST 一个别的路径。
 * 判定用 **realpath**,不用字符串前缀:`..` 会被 realpath 吃掉;符号链接指到根外的,
 * realpath 之后就露出真身;`/root-evil` 这种与 `/root` 同前缀的目录按路径**段**比,不按字符比。
 * 扫描根本身也 realpath 一次(macOS 上 /tmp → /private/tmp 这类别名),两边同一把尺。
 */
import { realpath } from 'node:fs/promises'
import { isAbsolute, sep } from 'node:path'

export type RevealResult = { ok: true, path: string } | { ok: false, reason: string }

/** 把一条路径钉在扫描根之内;根不存在的跳过(比如 ~/WeChatProjects 从没建过)。 */
export async function resolveInsideRoots(path: string, roots: readonly string[]): Promise<RevealResult> {
  if (typeof path !== 'string' || path === '' || !isAbsolute(path)) {
    return { ok: false, reason: '路径必须是绝对路径' }
  }
  let real: string
  try {
    real = await realpath(path)
  }
  catch {
    return { ok: false, reason: '这个路径不存在' }
  }
  for (const root of roots) {
    let realRoot: string
    try {
      realRoot = await realpath(root)
    }
    catch {
      continue
    }
    if (real === realRoot || real.startsWith(realRoot.endsWith(sep) ? realRoot : `${realRoot}${sep}`)) {
      return { ok: true, path: real }
    }
  }
  return { ok: false, reason: '这个路径不在已授权的项目目录之内' }
}

export interface RevealService {
  /** 定位到 Finder。越界的路径一条命令都不跑。 */
  reveal: (path: string) => Promise<{ ok: true } | { ok: false, reason: string }>
}

export interface RevealServiceOptions {
  /** 扫描根(projectsService 的 DEFAULT_SCAN_ROOTS 那几条)。 */
  roots: readonly string[]
  /**
   * ★ 界面上**已经列出来的**那几条确切路径(原件
   * `contrib/air-20261002/patches/index.patch` 的 `index-08` / `index-09`,
   * 2026-10-03 原封不动接入。她的英文注释逐字留在下面那一处)。
   *
   * 她那一格(素材管理)把素材文件夹、素材文件、收件箱里列着的那几条交给 `reveal`,
   * 而工作目录通常不在扫描根里 —— 不开这一条她那几颗按钮全是「不在已授权的项目目录之内」。
   *
   * 边界:**逐字相等**才放行(`listed.includes(path)`,不做前缀、不做包含),
   * 而这份清单里的每一条都是**服务端自己算出来放进 `/state` 的**
   * (`template.view().asset_dirs` / `asset_files`、`inbox.view().items[].path`),
   * 界面上没有一处能输路径、也没有拼路径这回事。放行之后仍然走 `resolveInsideRoots`
   * (realpath + 绝对路径那两道),只是把根换成它自己 —— 符号链接指到别处的照旧露出真身。
   *
   * 不给 = 这条口子不存在(用例里的假服务就不给)。
   */
  listedPaths?: () => Promise<readonly string[]>
  /** 不带 cwd 的命令执行器(index.ts 的 runCommand),测试注入假的。 */
  runCommand: (cmd: readonly string[]) => Promise<{ ok: boolean, stdout: string }>
}

export function createRevealService(options: RevealServiceOptions): RevealService {
  return {
    async reveal(path) {
      let resolved = await resolveInsideRoots(path, options.roots)
      // Only exact entries already displayed in the local material widget are additional reveal targets.
      if (!resolved.ok && typeof path === 'string' && options.listedPaths) {
        const listed = await options.listedPaths()
        if (listed.includes(path)) resolved = await resolveInsideRoots(path, [path])
      }
      if (!resolved.ok) return resolved
      const ran = await options.runCommand(['open', '-R', resolved.path])
      return ran.ok ? { ok: true } : { ok: false, reason: 'Finder 没有响应' }
    },
  }
}
