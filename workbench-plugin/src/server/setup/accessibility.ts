/**
 * 「辅助功能授权」到底是哪一种没授权(2026-09-18)。**纯判断 + 一次只读探测**,
 * 没有别的副作用 —— 同 status.ts 那条老规矩:去看一眼真实世界,然后如实说。
 *
 * 起因是 Ben 09-18 真机上那一幕:系统设置里「工作台」那个开关**是开着的**,
 * 壳却报「辅助功能未授权」,顶上横幅照着说「还差一个授权」—— 话说错了,他照着做
 * (再去把开关打开)一点用都没有。
 *
 * 真相在 `docs/交接-0918-壳稳定签名.md` 里:macOS 的 TCC 认的不是 App 的路径,是签名里
 * 那条 designated requirement。壳从 ad-hoc 签名换成固定证书之后 DR 变了一次,系统眼里
 * 这是**另一个 App**,而设置里那条亮着的开关记的是**旧签名那一份**。于是:
 *
 *   开关在 + 壳报未授权  ⇒  那条记录是旧的,要删掉重加一次(此后不会再要)。
 *
 * 「开关在不在」最好是去 TCC 库里数一眼。实际上数不着:辅助功能那张表在**系统那份**
 * TCC.db 里(`/Library/Application Support/com.apple.TCC/TCC.db`),只有 root 读得动,
 * 而工作台不是 root 跑的。所以 `probeTccRecord` 绝大多数时候回 `'unknown'` ——
 * 这是**预期内的结果,不是故障**,于是判断退回一条间接但站得住的证据:
 *
 *   壳是**证书签名**的(DR 里是 `certificate leaf`)而且报未授权
 *   ⇒ 多半就是上面那一幕(ad-hoc 那一版留下的旧记录还在)。
 *
 * 反过来,壳要是 ad-hoc 签名的,那"每次重建都掉授权"本来就是它的常态,说「旧记录」
 * 就是猜 —— 那一支照旧说「还差一个授权」。真探到了 TCC 里**没有**这条记录,
 * 同样照旧说「还差一个授权」:探得到的时候以探到的为准,不让间接证据压过直接证据。
 *
 * ## 2026-09-23 修正:「证书签名 + 未授权」不够说「旧记录」
 *
 * 09-23 从零重装自跑:新机器上从没授权过,横幅却让他「把旧记录移除再重新添加」——
 * 列表里根本没有那一条(启动不再弹框之后,他点「去授权」之前连「工作台」这一行都没有)。
 * 「证书签名 + 未授权」只说明**现在没授权**,说明不了**以前授权过另一个签名**。
 *
 * 所以补一样直接证据:每次体检看到**已授权**,就把壳此刻的 designated requirement 记进
 * `~/.dsh/workbench/accessibility-grant.json`(`grantHistoryOf` 比对)。之后再报未授权时:
 *
 *   - 从没记过(新机器)                    ⇒ `unauthorized`「还没给辅助功能授权」;
 *   - 记过、而且就是现在这个签名           ⇒ `unauthorized`(是他自己关了/删了,不是旧记录);
 *   - 记过、但签名换了(且现在是证书签名) ⇒ `stale_record`,这才是 09-18 那一幕。
 *
 * 拿不准一律按「还没授权」说 —— 说错成「还没授权」,他照做点「去授权」也不吃亏;
 * 说错成「旧记录」,新用户会被支去删一条不存在的东西。
 */
import type { SetupIo } from './io.ts'

/** 壳的 bundle id(workbench-app/Info.plist)。TCC 那张表里 client 一栏就是它。 */
export const SHELL_BUNDLE_ID = 'ai.ben.workbench'

/**
 * 辅助功能那张表所在的 TCC 库。**是系统那份,不是用户那份** ——
 * `~/Library/Application Support/com.apple.TCC/TCC.db` 里没有 kTCCServiceAccessibility。
 */
export const SYSTEM_TCC_DB = '/Library/Application Support/com.apple.TCC/TCC.db'

/** 装着的那份壳是怎么签的。判据是 `codesign -d -r -` 给的 designated requirement。 */
export type ShellSignatureKind = 'certificate' | 'adhoc' | 'unknown'

/** TCC 里有没有「工作台」这条辅助功能记录。读不动(常态)就是 unknown。 */
export type TccRecord = 'present' | 'absent' | 'unknown'

/**
 * 辅助功能这一项此刻是哪一种。
 *
 * - `ok`           连上了、也授权了。
 * - `unreachable`  壳没接线 / 没连上 —— 这不是"没授权",是"看不到"(沿用 status.ts 的口径)。
 * - `unauthorized` 真的还没给过这个授权。
 * - `stale_record` 开关在、但那条记录对应的是旧签名的壳。
 */
export type AccessibilityKind = 'ok' | 'unreachable' | 'unauthorized' | 'stale_record'

/** 横幅/红字要分的两种"没授权"。`ok` 与 `unreachable` 都不进这一格(见 alertKindOf)。 */
export type AccessibilityAlertKind = 'unauthorized' | 'stale_record'

/**
 * `codesign -d -r -` 的输出 → 签名种类。
 *
 * `certificate leaf = H"…"` ⇒ 认的是 bundle id + 证书,重建不换;
 * `cdhash H"…"`             ⇒ 认的是这一份二进制的哈希,每次构建都换(ad-hoc)。
 * 读不出来就说读不出来,不猜(D13)。
 */
export function parseShellSignature(output: string): ShellSignatureKind {
  const requirement = parseDesignatedRequirement(output)
  if (requirement === undefined) return 'unknown'
  if (requirement.includes('certificate leaf')) return 'certificate'
  return 'adhoc'
}

/** `codesign -d -r -` 输出里 `designated =>` 后面那一整条。读不出来回 undefined。 */
export function parseDesignatedRequirement(output: string): string | undefined {
  const requirement = /designated =>(.*)/.exec(output)?.[1]?.trim()
  return requirement === undefined || requirement === '' ? undefined : requirement
}

/**
 * 这台机器上辅助功能授权的"来历"(2026-09-23)。
 *
 * - `never`   从没见过已授权(没有那份记录文件)—— 新机器的常态。
 * - `same`    见过,而且就是现在这个签名。
 * - `changed` 见过,但当时是另一个签名 —— 系统设置里那条开关记的是旧壳。
 * - `unknown` 现在的签名读不出来,比不了。
 */
export type GrantHistory = 'never' | 'same' | 'changed' | 'unknown'

/** 记录文件的内容 → 上次授权时的签名要求。坏文件当没有(= never,往「还没授权」那边说)。 */
export function parseGrantRecord(text: string | undefined): string | undefined {
  if (text === undefined) return undefined
  try {
    const parsed = JSON.parse(text) as { requirement?: unknown }
    return typeof parsed.requirement === 'string' && parsed.requirement !== '' ? parsed.requirement : undefined
  }
  catch { return undefined }
}

/** 纯函数:上次授权时的签名要求 vs 现在的。 */
export function grantHistoryOf(recorded: string | undefined, current: string | undefined): GrantHistory {
  if (recorded === undefined) return 'never'
  if (current === undefined) return 'unknown'
  return recorded === current ? 'same' : 'changed'
}

/**
 * `sqlite3 … "select count(*) …"` 的输出 → 有没有这条记录。
 *
 * 只认**干干净净的一个整数**。sqlite3 读不动的时候会把错误打在 stdout/stderr 上
 * (`Error: unable to open database file` / `authorization denied`),那一律是 unknown ——
 * 把一句错误当成 0 就等于"探到了、没有记录",而那是**编出来的结论**。
 */
export function parseTccCount(out: string): TccRecord {
  const line = out.trim().split('\n').map(row => row.trim()).filter(row => row !== '').pop()
  if (line === undefined || !/^\d+$/.test(line)) return 'unknown'
  return Number(line) > 0 ? 'present' : 'absent'
}

/**
 * 去 TCC 库里数一眼「工作台」的辅助功能记录。**只读,不写**;失败一律 `'unknown'`。
 *
 * 这条路在 Ben 这台机器上几乎必然探不到(见文件头):sqlite3 打不开那份系统库。
 * 留着它是因为"探得到的时候以探到的为准"比"永远靠签名猜"要诚实一档,而它的代价
 * 只是一次会失败的子进程 —— 而且**只在体检里跑**(一分钟一次的节流),不挂在 /state 上。
 */
export async function probeTccRecord(io: SetupIo, dbPath: string = SYSTEM_TCC_DB): Promise<TccRecord> {
  const sql = `select count(*) from access where service='kTCCServiceAccessibility' and client='${SHELL_BUNDLE_ID}'`
  try {
    const result = await io.exec(['sqlite3', '-readonly', dbPath, sql])
    if (!result.ok) return 'unknown'
    return parseTccCount(result.out)
  }
  catch {
    // sqlite3 压根不在、或者 spawn 失败。同样是"看不到",不是"没有"。
    return 'unknown'
  }
}

/**
 * 三样证据 → 一个结论。**纯函数**,单测钉着每一支。
 *
 * 顺序是有讲究的:先看壳连没连上(看不到就别往下猜)、再看授权本身、
 * 最后才在"没授权"这一支里分「真没给过」还是「给过但记录旧了」。
 */
export function accessibilityKindOf(input: {
  helper: { connected: boolean, authorized: boolean } | undefined
  signature: ShellSignatureKind
  record: TccRecord
  /** 缺席按 `never` 读:没有"以前授权过另一个签名"的证据,就不说「旧记录」。 */
  grant?: GrantHistory
}): AccessibilityKind {
  const { helper, signature, record } = input
  const grant = input.grant ?? 'never'
  if (helper === undefined || !helper.connected) return 'unreachable'
  if (helper.authorized) return 'ok'
  // 直接证据压过间接证据:真数到了那条记录就是"旧记录",真数到没有就是"没授权"。
  if (record === 'present') return 'stale_record'
  if (record === 'absent') return 'unauthorized'
  // 探不到(常态)。要**两样都成立**才敢说"旧记录":这台机器上见过另一个签名被授权过,
  // 而且现在是证书签名(ad-hoc 的壳掉授权是它的常态,那一支的话术是「关一次再开」)。
  // 其余一律老实说「还没授权」(2026-09-23:新机器从没授权过也被说成旧记录)。
  return grant === 'changed' && signature === 'certificate' ? 'stale_record' : 'unauthorized'
}

/** 结论 → 要不要出横幅、出哪一种。`ok` 与 `unreachable` 都不分种类(前者没话说,后者不是"没授权")。 */
export function alertKindOf(kind: AccessibilityKind): AccessibilityAlertKind | undefined {
  if (kind === 'stale_record') return 'stale_record'
  if (kind === 'unauthorized') return 'unauthorized'
  return undefined
}
