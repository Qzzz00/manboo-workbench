/**
 * ★ **工作台日志每行带时间**(2026-10-02,维护者拍板「诊断包加两样」第二样)。
 *
 * ## 为什么
 *
 * 10-02 Air 那位运营同学撞上「网易云音乐每隔 10s 自行打开」。统筹排到最后只能写「**没查实**」,
 * 两个原因:壳那一头没有「谁让哪个包到了台前」的记录(那一半是 `appOpenLog.ts` + 壳的 `AppOpenLog.swift`),
 * 以及 **`web.stdout.log` 里绝大多数行没有时间** —— 日志里有一条「已完成。网易云音乐已经开始播放音乐了」,
 * 却没法回答它是几点几分写的、和哪一拍对得上。
 *
 * ## 怎么做
 *
 * 一处包住 `console`(`installLogStamp`),**每一行**都盖一个时间。不是在几百处 `console.log`
 * 旁边各加一个时间:那样必漏,而且下一个人写新日志时也必漏。
 *
 * ## 两件要紧的
 *
 * ① **不盖第二个时间**:`[dispatch]` / `[answer]` / `[relay]` / `[approval]` 那几行 2026-10-01
 *    起已经自己带了 `[HH:MM:SS]`({@link logStampOf})。所以认出行首已经有时间的就原样放过 ——
 *    格式也**只用这一份**,两套时间格式会让"按时间窗取日志"这件事多一道解析分支。
 * ② **空行还是空行**:给一个空行盖时间等于给排障的人多一行要跳过的噪音。
 *
 * 时间只到秒、不带日期:日志**按天轮转**(`diagnostics/rotate.ts`),一份文件里就是那一天,
 * 日期在文件名上(`web.stdout.log.2026-10-02`)。
 */

/** 行首那个时间的形状。认它用来**不盖第二个** —— 判据只在这一处。 */
export const LOG_STAMP_RE = /^\[\d{2}:\d{2}:\d{2}\] /

/**
 * 日志行前面那个时间(2026-10-01,卡 AX 起)。
 *
 * 本地时区、只到秒:维护者与她看的都是本地时间,UTC 要在脑子里换一遍。
 * 从前它住在 `sessionAnswer.ts`,2026-10-02 搬到这里 —— 盖时间这件事从「那几条路自己盖」
 * 变成「一处替所有行盖」,格式得和原来**逐字相同**,所以只有一份(`sessionAnswer.ts` 原样 re-export)。
 */
export function logStampOf(at: Date): string {
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${pad(at.getHours())}:${pad(at.getMinutes())}:${pad(at.getSeconds())}`
}

/**
 * 给一段输出的**每一行**盖时间。已经带时间的行、空行原样放过。
 */
export function stampLogText(text: string, at: Date): string {
  const stamp = `[${logStampOf(at)}] `
  return text
    .split('\n')
    .map(line => (line.trim() === '' || LOG_STAMP_RE.test(line) ? line : `${stamp}${line}`))
    .join('\n')
}

/** 被包住的那几个方法。`console.trace` / `console.table` 不在里面(它们自己有格式,盖上去会错位)。 */
export const STAMPED_METHODS = ['log', 'info', 'warn', 'error', 'debug'] as const

export type StampedMethod = typeof STAMPED_METHODS[number]

export type ConsoleLike = Record<StampedMethod, (...args: unknown[]) => void>

/** 装过了的记号:装两遍会盖两个时间(第二层看到的行首已经有时间,其实会被放过,但别指望这个)。 */
const INSTALLED = Symbol.for('workbench.logStamp.installed')

/**
 * 包住 `console`,每行盖一个时间。**回一个撤销函数**(用例里装完就撤,不污染别的用例)。
 *
 * 已经装过就什么都不做、回一个空撤销 —— 起服务那条路要是被走了两遍(热更新重载),
 * 不该把日志变成两个时间。
 */
export function installLogStamp(options: {
  console: ConsoleLike
  now?: () => Date
  /** 把参数拼成一行字(默认 `util.format`:`console.log('a %s', 'b')` 要和原来一样)。 */
  format: (...args: unknown[]) => string
}): () => void {
  const target = options.console as ConsoleLike & { [INSTALLED]?: true }
  if (target[INSTALLED] === true) return () => undefined
  const now = options.now ?? (() => new Date())
  const original = {} as Record<StampedMethod, (...args: unknown[]) => void>
  for (const method of STAMPED_METHODS) {
    const previous = target[method].bind(target)
    original[method] = previous
    target[method] = (...args: unknown[]): void => {
      previous(stampLogText(options.format(...args), now()))
    }
  }
  target[INSTALLED] = true
  return () => {
    for (const method of STAMPED_METHODS) target[method] = original[method]
    delete target[INSTALLED]
  }
}
