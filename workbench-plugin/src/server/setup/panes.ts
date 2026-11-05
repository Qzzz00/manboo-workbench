/**
 * 「去授权」按钮背后那一下(2026-09-17)。
 *
 * 登录台**不能替 Ben 授权** —— macOS 的 TCC 授权只有人能点(这也是规矩:授权只能他做)。
 * 能做的只有一件事:把他直接送到对的那一页,免得他在系统设置里翻。
 * 所以这个文件只有一张 URL 表和一条 `open`。
 */
import type { SetupIo } from './io.ts'
import type { SetupPane } from './types.ts'

const PREFIX = 'x-apple.systempreferences:com.apple.preference.security'

/**
 * 每一页在「隐私与安全性」里的锚点。macOS 13 起就是这套 anchor 名。
 *
 * `node_binary` 不在这张表里:它不是一页(见下面 `openSetupPane`)。
 */
export const PANE_URLS: Record<Exclude<SetupPane, 'node_binary'>, string> = {
  accessibility: `${PREFIX}?Privacy_Accessibility`,
  files: `${PREFIX}?Privacy_FilesAndFolders`,
  calendar: `${PREFIX}?Privacy_Calendars`,
  automation: `${PREFIX}?Privacy_Automation`,
  all_files: `${PREFIX}?Privacy_AllFiles`,
}

/** 每一页要给谁授权,一句人话(界面在按钮旁边显示)。 */
export const PANE_HINTS: Record<SetupPane, string> = {
  accessibility: '把「工作台」打开。只要签名身份不变,以后更新不用再点;ad-hoc 签名的壳重建过要关一次再开。',
  files: '给 ~/.dsh/node/bin/node 勾上「文稿文件夹」——授权认二进制,不是认应用名。',
  calendar: '允许 DSH 宿主进程读日历。',
  automation: '允许 DSH 宿主进程控制别的应用(自定义应用加进窗位要它)。',
  all_files: '按 + 把 ~/.dsh/node/bin/node 加进「完全磁盘访问」(用旁边那颗「在访达里显示」把它拖进去)。加完当场生效,一般不用重启。',
  node_binary: '访达会弹出来并选中那条 node。把它拖进「完全磁盘访问」那张表,或者在那张表里按 + 之后用 ⌘⇧G 粘这个路径。',
}

/**
 * 把她送到对的地方。两种:
 *
 * - 一页系统设置:`open <url>`;
 * - `node_binary`:`open -R <那条 node>` —— 访达弹出来、并且**选中**那个文件。
 *   `~/.dsh` 是隐藏目录,系统设置的选文件框里翻不到它,所以这一下是必需的一步,
 *   而不是顺手给的方便。路径由调用方(service.ts,从 `paths.nodeBin` 来)给,
 *   **客户端传不进任何路径** —— 这条和 server/reveal.ts 的边界是同一条口径。
 */
export async function openSetupPane(io: SetupIo, pane: SetupPane, nodeBin?: string): Promise<{ ok: boolean, error?: string }> {
  if (pane === 'node_binary') {
    if (nodeBin === undefined || nodeBin === '') {
      return { ok: false, error: '说不出那条 node 在哪(这台服务没接登录台的路径表)。手动去:~/.dsh/node/bin/node。' }
    }
    const revealed = await io.exec(['open', '-R', nodeBin])
    if (revealed.ok) return { ok: true }
    return { ok: false, error: `在访达里打不开那个文件(退出码 ${revealed.code})。手动去:~/.dsh/node/bin/node(在访达里按 ⌘⇧G 粘这个路径)。` }
  }
  const result = await io.exec(['open', PANE_URLS[pane]])
  if (result.ok) return { ok: true }
  return { ok: false, error: `打不开系统设置那一页(退出码 ${result.code})。手动去:系统设置 → 隐私与安全性。` }
}
