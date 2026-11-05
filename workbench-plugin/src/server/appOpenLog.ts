/**
 * ★ **插件这一头每让系统开一个 App,记一行带时间**(2026-10-02,维护者拍板「诊断包加两样」第一样)。
 *
 * ## 为什么
 *
 * 10-02 Air 那位运营同学:「我让他打开网易云音乐……完成后每隔 10s 又自行打开网易云。。不断弹窗」。
 * 统筹排到最后只能写「**没查实**」—— 工作台到底有没有、在什么时候 `open -b` 过那个包,
 * **没有任何地方说得出**。维护者:「不要拿着打补丁的心态……要有机制上的调整」。
 *
 * ## 记在哪一处
 *
 * 记在 **`runCommand` 那一个口上**(`index.ts`),不在十几个「返回一条 open 命令」的地方各记一行。
 * 理由是现场数出来的:`open -b` / `open -a` 的命令不只那两处手写的 ——
 * `apps.ts`(微信 / 企微 / 终端 / 日历)、`agentSources.ts`(Claude / ChatGPT / Kimi / 豆包 / Muse / Manus)、
 * `appsRegistry.ts`、`finderPin.ts`、`reveal.ts`、`butler.ts`、`setup/panes.ts`、`update/apply.ts`
 * 各有一份,**而且以后还会加**。逐处记必漏;记在执行器上,新加一处自动跟着记。
 *
 * ## 「哪条管线」在哪
 *
 * 这一行**只说哪个包、用哪样开的**,不说是派活还是捎话:执行器那一层不知道上游是谁,
 * 把管线名一路传下来要改十几个签名。管线靠**时间**对上 —— 这正是同一张卡的第二样
 * (`logStamp.ts`:工作台日志每行带时间)要治的事,两样合起来才回答得了「谁在反复打开某个 App」。
 *
 * 壳那一头(`workbench-app/Sources/AppOpenLog.swift`)另记一行:凡是经过壳去激活 / 放出来 /
 * 叫到台前的(`raise_window` / `unhide_app` / `send_text` / `agent_*`)记在壳的腰眼上。
 * 两头**不互相重复**:壳那边的动作不走 `open`,这边的 `open` 不经过壳。
 *
 * ## 不记什么
 *
 * 地址只记**协议头**(`claude://` 的 `claude`),不记整条 URL:深链里带会话 id,
 * URL 里可能带 token(同 `diagnostics/redact.ts` 那条纪律)。窗口里的字一个都不进来。
 */
import { logStampOf } from './logStamp.ts'

/** 行首那个记号(排障时 `grep 开App`)。界面、用例、壳那一份都引常量,不逐字抄。 */
export const APP_OPEN_TAG = '开App'

/** 这一下是用哪样开的。 */
export type AppOpenWay =
  /** `open -b <包标识>`:工作台最常用的那一下(窗关了、只剩菜单栏图标时把窗开回来)。 */
  | 'bundle'
  /** `open -a <名字>`:按 App 名开(登记表里只知道名字的那几家)。 */
  | 'name'
  /** `open -n <路径>`:再开一个实例(热更新换完壳之后拉起自己)。 */
  | 'new'
  /** `open -R <路径>`:在访达里选中(这一下会把访达叫到台前)。 */
  | 'reveal'
  /** `open <地址>`:深链 / 网址(交给系统选默认 App)。 */
  | 'url'
  /** `open <路径>`:交给系统用默认 App 打开一个文件。 */
  | 'file'

const WAY_TEXT: Readonly<Record<AppOpenWay, string>> = {
  bundle: 'open -b',
  name: 'open -a',
  new: 'open -n',
  reveal: 'open -R',
  url: 'open 地址',
  file: 'open 文件',
}

export interface AppOpenTarget {
  way: AppOpenWay
  /** 开的是谁:包标识 / App 名 / 路径 / 协议头。认不出就缺席(不编一个)。 */
  who?: string
}

/**
 * 这条命令是不是「让系统开一个 App」。不是就回 `undefined`(`df` / `top` / `pgrep` / `launchctl`
 * 那些一行都不记 —— 记进来只会把真正那几行埋掉)。
 *
 * **只认 `open`**:它是 macOS 上"交给系统开"的唯一入口。`execFile` 直接拉起一个可执行文件
 * 不走它,那种在这个仓库里只有 `node` 自己(起工人 / 跑测试),不是"打开一个 App"。
 */
export function openTargetOf(cmd: readonly string[]): AppOpenTarget | undefined {
  const [bin, ...rest] = cmd
  if (bin !== 'open' && bin !== '/usr/bin/open') return undefined
  const flagged = (flag: string, way: AppOpenWay): AppOpenTarget | undefined => {
    const at = rest.indexOf(flag)
    if (at < 0) return undefined
    const who = rest[at + 1]
    return { way, ...(who === undefined || who === '' ? {} : { who }) }
  }
  const byFlag = flagged('-b', 'bundle') ?? flagged('-a', 'name') ?? flagged('-R', 'reveal') ?? flagged('-n', 'new')
  if (byFlag !== undefined) return byFlag
  const first = rest.find(one => !one.startsWith('-'))
  if (first === undefined) return { way: 'file' }
  // 地址:只留协议头(深链里带会话 id、网址里可能带 token)。
  const scheme = /^([a-z][a-z0-9+.-]*):\/\//i.exec(first)
  return scheme === null ? { way: 'file', who: first } : { way: 'url', who: scheme[1] as string }
}

/**
 * 那一行。时间用 {@link logStampOf} 那一份 —— 与 `[dispatch]` / `[answer]` 那几行同一个形状,
 * 所以 `logStamp.ts` 那一层**不会给它盖第二个时间**。
 */
export function appOpenLogLine(input: { at: Date, target: AppOpenTarget, ok?: boolean }): string {
  const parts = [
    `[${logStampOf(input.at)}]`,
    `[${APP_OPEN_TAG}]`,
    input.target.who ?? '(认不出开的是谁)',
    `← ${WAY_TEXT[input.target.way]}`,
  ]
  if (input.ok === false) parts.push('没开成')
  return parts.join(' ')
}

/**
 * 包住一个命令执行器:凡是 `open …` 就记一行。别的命令原样跑过去,一个字不记。
 *
 * 记在**跑完之后**并带上成败:「开没开成」本身就是线索(10-02 那件事里,
 * 「工作台压根没开过它」与「开了但失败」是两个完全不同的结论)。
 */
export function withOpenCommandLog<R extends { ok: boolean }>(
  run: (cmd: readonly string[]) => Promise<R>,
  options?: { now?: () => Date, write?: (line: string) => void },
): (cmd: readonly string[]) => Promise<R> {
  const now = options?.now ?? (() => new Date())
  const write = options?.write ?? ((line: string) => { console.log(line) })
  return async (cmd) => {
    const target = openTargetOf(cmd)
    const result = await run(cmd)
    // 记日志绝不能把这条命令本身弄坏(同 `recordNotify` 那条纪律)。
    if (target !== undefined) {
      try { write(appOpenLogLine({ at: now(), target, ok: result.ok })) }
      catch { /* 记不下就算了,命令照常回 */ }
    }
    return result
  }
}
