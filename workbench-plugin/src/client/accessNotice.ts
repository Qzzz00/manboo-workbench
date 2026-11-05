/**
 * 「辅助功能还差什么」那一句话 —— 算哪一句的那一半(2026-09-18)。**纯函数**,
 * 不碰 DOM、不发请求(同 emptyState.ts / areaUnlock.ts 的先例)。
 *
 * Ben 09-18 真机原话(截图第三处):
 *
 * > 「实际情况是系统设置里『工作台』开关是开着的,但那条记录对应的是旧签名的壳。」
 *
 * 顶上那条横幅当时照着老口径说「还差一个授权:辅助功能」,而他**已经把开关打开了** ——
 * 照着这句话去做只会再走一遍已经走过的路。所以这一版把两种情形分开说,而且
 * **两处共用这一句**:顶上的横幅、以及窗位槽/系统文件夹里那行红字(任务卡:
 * 「窗位槽红字与『去授权』按钮同一句」)。一句话在两处各写一遍,迟早只改对一处。
 *
 * 判哪一种不在浏览器里做:证据(壳的签名、TCC 里有没有那条记录)只有服务端看得见,
 * 结论由 `/state.setup_alerts.accessibility_kind` 带过来(server/setup/accessibility.ts)。
 * 这里只负责"结论 → 人话",于是三种文案各有一条用例钉着,不必起一个真的服务端。
 */

/** 两种"还差辅助功能"。缺席(老服务端 / 壳没连上、判断不了)按 `unauthorized` 读。 */
export type AccessAlertKind = 'unauthorized' | 'stale_record'

export interface AccessNotice {
  kind: AccessAlertKind
  /** 屏幕上原样显示的那一句。界面不再拼接、不再改写。 */
  line: string
  /** 那颗按钮的字。两种情形去的是同一页(系统设置 → 隐私与安全性 → 辅助功能)。 */
  action: string
}

/**
 * 还没给过这个授权(也是**拿不准时**的那一句,2026-09-23)。
 * 开头半句沿用 09-17 的原话;后面补两件新用户需要知道的事:为什么要它、点下去会发生什么
 * (启动不再弹系统框之后,系统框只在点「去授权」时才出来 —— 先说一声,他才不会被吓到)。
 */
const LINE_UNAUTHORIZED = '还差一个授权:辅助功能 —— 替你摆窗位、拖窗认领、把话送进 Claude/Codex 都要它。点「去授权」会弹系统框,点「打开系统设置」把「工作台」打开就行。'

/**
 * 开关在、壳仍报未授权。这一句是 Ben 自己口述的那段话,**按他给的措辞落**:
 * 先说清系统设置里那条记录是旧的(不是他没开),再给当场能做完的三步,
 * 最后那半句("以后更新不会再要")是要紧的 —— 09-18 那条纠正就是冲着
 * 「每次更新都要重新授权」来的,这一次删了重加之后固定证书会把它了结掉。
 */
const LINE_STALE_RECORD = '系统设置里的『工作台』还是旧版本的记录:把它移除(选中按 −)再重新添加 /Applications/工作台.app,然后点一下工作台窗口。以后更新不会再要。'

/**
 * 这会儿该说哪一句。回 `undefined` 的两种情形在屏幕上后果一样(什么都不画),
 * 语义却不同,所以合成一个函数而不是让三个调用点各判各的:
 *
 * - `alerts` 缺席 = **还没体检过**。「没查过」不是「差着」(同 NeedBar 09-17 那条纪律)。
 * - `accessibility` 为假 = **已授权**。这就是任务卡里第三种文案:一条横幅都不出。
 */
export function accessNotice(alerts?: {
  /** 2026-09-18 起这一格本身也可能缺席(还没体检过)—— 与「体检过了、没缺」一样,一条都不出。 */
  accessibility?: boolean
  accessibility_kind?: AccessAlertKind
}): AccessNotice | undefined {
  if (alerts === undefined) return undefined
  if (alerts.accessibility !== true) return undefined
  const kind = alerts.accessibility_kind ?? 'unauthorized'
  return {
    kind,
    line: kind === 'stale_record' ? LINE_STALE_RECORD : LINE_UNAUTHORIZED,
    action: '去授权',
  }
}

/**
 * 「还差完全磁盘访问」那一句(2026-10-13,卡「手机看文件时电脑弹 node 的文件夹授权」)。
 *
 * 维护者 10-13 早:「我在手机上每次看文件,电脑上似乎都有一个授权弹窗要点,不点我就看不到文件…
 * 我要看文件的场景,说明我不在电脑桌前」。所以这一句要说清两件事:**坏的是哪个功能**、
 * **给一次就不再弹**。
 *
 * **不写"给完要重启"**:2026-10-13 按 TCC 日志量过,给完当场生效(判据见
 * server/setup/fullDiskAccess.ts 文件头)。重启那条退路只写在体检那一格的 `fix` 里 ——
 * 横幅上多一句她多一次白做。
 *
 * 这一句**只有这一处**,与体检那一格的 `fix` 分工:横幅说"是什么、去哪儿",
 * 体检那一格说"具体拖哪个文件"(那里才摆得下路径)。
 */
export const FILE_ACCESS_LINE = '手机现在看不到电脑上的文件:还差一个授权 —— 完全磁盘访问。给工作台的服务一次,以后就不再弹框、你不在电脑前也看得到文件。'

/**
 * 这会儿该不该出那条横幅。回 `undefined` 的三种情形屏幕上后果一样(什么都不画),
 * 语义却不同:**那一格缺席 = 还没体检过 / 判断不了**(server/setup/service.ts 只在
 * 真探到没给时才带这一格),为假 = 给过了。「没查过」不是「差着」。
 */
export function fileAccessNotice(alerts?: { file_access?: boolean }): { line: string, action: string } | undefined {
  if (alerts?.file_access !== true) return undefined
  return { line: FILE_ACCESS_LINE, action: '去给' }
}
