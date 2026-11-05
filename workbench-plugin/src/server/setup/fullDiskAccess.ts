/**
 * 「完全磁盘访问」给没给(2026-10-13)。**纯判断 + 只读探测**,一条写操作都没有 ——
 * 照 accessibility.ts 那条老规矩:去看一眼真实世界,然后如实说。
 *
 * 起因是维护者 10-13 早那一句:
 *
 * > 「现在我在手机上每次看文件,电脑上似乎都有一个授权弹窗要点,不点我就看不到文件,
 * >   我记得是 node,不解决这个问题,那这个功能就废了,因为我要看文件的场景,说明我不在电脑桌前。」
 *
 * 弹的是 macOS「文件和文件夹」那一类框(「node 想要访问您的文稿」):8791 跑在 launchd 项
 * `ai.deepseek.dsh` 里,进程就是 `~/.dsh/node/bin/node`,手机看文件走插件自己的 `fs`
 * (fileFetch.ts 的 readdir、取件那一下的 readFile),每一个受保护目录各弹一次。
 * 而**他不在电脑桌前**,没人点那个框 —— 发一次版重启一次,挂着没点的框随进程消失,
 * TCC 什么都不记,于是下一次照旧弹。根治只有一条:给那条 node 一次「完全磁盘访问」,
 * 此后这一类框整个不再出现。授权只有人点得了,代码能做的是**探得出给没给、说得出怎么给**。
 *
 * ## 为什么用这几条目录当探针(而且探它不会弹框)
 *
 * 要探「完全磁盘访问」,得找一条**只有拿到它才读得动、而且这台 Mac 上一定有**的路。
 * 选的是 `~/Library` 底下那几条:TCC 自己的库目录、Cookies、Safari。它们属于
 * `kTCCServiceSystemPolicyAllFiles` 这一服务,**没有"问人"这一档** —— 没授权时 tccd
 * 直接按服务策略拒掉,`readdir` 当场回 EPERM,屏幕上一个框都不出。
 *
 * 2026-10-13 09:47 在统筹这台机器上量过(`log show --predicate 'subsystem == "com.apple.TCC"'`):
 * 一次探 7 条这类目录,TCC 日志里只有一条
 * `AUTHREQ_CTX … service=kTCCServiceSystemPolicyAllFiles` 跟着
 * `ReqResult(Auth Right: Denied (Service Policy), DB Action:None)` —— 拒了、没问人、没写库。
 *
 * **文稿 / 桌面 / 下载那一类(`kTCCServiceSystemPolicyDocumentsFolder` 等)是会弹框的**,
 * 所以一条都不许进这张探针表(弹框正是这张卡要消掉的东西)。体检里那一格「文稿文件夹授权」
 * (status.ts 的 checkDocuments)探的是扫描根,那是另一回事、也是另一个会弹框的服务。
 *
 * ## 给完要不要重开工作台:**不用**(2026-10-13 在这台机器上量过)
 *
 * 这是这张卡上唯一一处"想当然会错"的地方,所以按日志说话:
 *
 *   - 09:51:12  `TCCDEvent: type=Modify, service=kTCCServiceSystemPolicyAllFiles,
 *                identifier=/Users/example/.dsh/node/bin/node` —— 有人在这一刻给了这条 node;
 *   - 10:09:47 与 10:12:49  **还在跑的那个 8791**(pid 68730,`ps` 说它 10-12 21:17 就起来了,
 *     比那次授权早十二个钟头)两次拿到 `Auth Right: Allowed (System Set)`。
 *
 * 同一个**没有重启过**的进程,给之前是拒、给之后是准 ⇒ 这一项**当场生效**,不用重开工作台
 * (tccd 自己会 `Publishing <TCCDEvent: type=Modify …>`,拿着旧答案的那一侧据此作废缓存)。
 * 所以每一处文案都写「一般不用重启;核了还说没给再重启一次兜底」——**不许写成"必须重启"**:
 * 多一步她多一次白做,而且重启 8791 会打断正在跑的事。
 */
import type { SetupIo } from './io.ts'

/** 这一项此刻是哪一种。`unknown` = 探不着,**不是**「给了」(D13)。 */
export type FullDiskAccessKind = 'ok' | 'denied' | 'unknown'

/**
 * 探针目录,相对 home。按顺序取**第一条能给出结论的**:
 *
 * 1. `Library/Application Support/com.apple.TCC` —— 用户那份 TCC 库所在的目录。
 *    它是授权本身的存放处,不是她的任何内容;而且管这件事的子系统自己建的目录,
 *    这台机器上有没有它跟「有没有用过某个 App」无关,比下面两条更稳。
 * 2. `Library/Cookies`  —— CFNetwork 建的,任何 App 联过一次网就有。
 * 3. `Library/Safari`   —— Safari 开过一次就有。
 *
 * 三条都只**列目录名、而且名字立刻丢掉**:这里一个字节的内容都不读。
 */
export const FULL_DISK_PROBE_RELATIVE: readonly string[] = [
  'Library/Application Support/com.apple.TCC',
  'Library/Cookies',
  'Library/Safari',
]

/** 探针的绝对路径。 */
export function fullDiskProbePaths(home: string): readonly string[] {
  const base = home.replace(/\/+$/, '')
  return FULL_DISK_PROBE_RELATIVE.map(rel => `${base}/${rel}`)
}

/**
 * 一条探针的结果。
 *
 * - `ok`      列得动 ⇒ 这个进程拿到了完全磁盘访问。
 * - `denied`  EPERM / EACCES ⇒ 没给(这一类目录没有"问人"那一档,拒就是拒)。
 * - `absent`  ENOENT ⇒ 这台机器上没这个目录,**说明不了任何事**,往下一条走。
 * - `error`   别的(readdir 自己抛了、怪错误码)⇒ 同样说明不了,往下一条走。
 */
export interface FullDiskProbe {
  path: string
  listed: 'ok' | 'denied' | 'absent' | 'error'
}

/** 这一项为什么要它。体检那一格、顶上那条横幅、引导那一句共用这一份。 */
export const FULL_DISK_WHY = '手机要看电脑上的文件,得给工作台的服务一次「完全磁盘访问」—— 给过之后电脑上不再弹授权框。'

/** 几条探针 → 一个结论。**纯函数**,单测钉着每一支。 */
export function fullDiskAccessKindOf(probes: readonly FullDiskProbe[]): FullDiskAccessKind {
  for (const probe of probes) {
    if (probe.listed === 'ok') return 'ok'
    if (probe.listed === 'denied') return 'denied'
  }
  // 一条都没给出结论(目录都不在 / 都是怪错误):探不着就说探不着,不往"给了"那边说。
  return 'unknown'
}

/**
 * 真去探一眼。**只 readdir,不跑任何子命令**(别的手段要么要 root、要么会弹框),
 * 而且**一拿到结论就停手** —— 这是 8791 自己这个进程里的事实,没必要多列几个目录。
 */
export async function probeFullDiskAccess(
  io: SetupIo,
  home: string,
): Promise<{ kind: FullDiskAccessKind, path?: string }> {
  const probes: FullDiskProbe[] = []
  for (const path of fullDiskProbePaths(home)) {
    probes.push({ path, listed: await probeOne(io, path) })
    const kind = fullDiskAccessKindOf(probes)
    if (kind !== 'unknown') return { kind, path }
  }
  return { kind: 'unknown' }
}

async function probeOne(io: SetupIo, path: string): Promise<FullDiskProbe['listed']> {
  try {
    const listed = await io.readdir(path)
    if (listed.ok) return 'ok'
    if (listed.code === 'EPERM' || listed.code === 'EACCES') return 'denied'
    if (listed.code === 'ENOENT' || listed.code === 'ENOTDIR') return 'absent'
    return 'error'
  }
  catch {
    // readdir 这一层本来就该回结果而不是抛(见 io.ts),抛了也只是"看不到"。
    return 'error'
  }
}
