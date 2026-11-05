/**
 * 系统日历采样(spec §R3):macOS 日历"今天+7天"事件的标题与日期,喂给日历面板的
 * 系统日程叠加层(D10:日历只是投影,DDL 本体不在这里)。
 *
 * 取数方式定案(调研 2026-08-20-v5-能力调研.md §R3):走 `osascript`(macOS 自带,免安装)，
 * 不走 icalBuddy(本机未安装,不为这一条能力单独引入 Homebrew 依赖)。三次实测调用
 * (读日历名/按日期范围取事件/按日历统计事件数)全部秒级返回,`every event of cal whose
 * start date >= ... and start date <= ...` 的日期过滤语义已用独立日历的全量数据交叉验证过。
 *
 * 授权弹窗如实记录(§R3 Step 2b):本次调研的宿主进程是 Claude.app,不是生产用的 DSH——
 * TCC 按"宿主进程 bundle id + 服务类型"独立记账，DSH 首次调用 Calendar 时大概率会触发
 * 它自己的一次系统授权弹窗，这是一次性成本，不是"零弹窗"，实现时不能假设跟调研一样静默。
 *
 * 超时保护(R1 教训:AppleScript 可能挂死,不像 df/top/sysctl 那样几乎不会卡住)：
 * 这一层的 `run` 不自己实现轮询超时——按简报"run 的实现层加 timeout 参数或用 execFile
 * timeout"，60 秒上限由调用方(index.ts 用 `execFile` 的 timeout 选项)在实现层保证；
 * 这里只管"给定 run，run 失败就是 { error }"，不关心 run 内部怎么防死。
 *
 * 纪律(D13):命令失败、或输出解析不出任何认得的行，直接 `{ error }`，绝不拿上一次的
 * 数字顶替、绝不编一份"看起来合理"的日程。
 *
 * 请求驱动 + 最短间隔缓存(默认 5 分钟，比 machine.ts 的 60 秒长——日历事件的变化频率
 * 远低于磁盘/内存，没必要每次 GET /state 都真的去跑一次 AppleScript)：不额外起
 * setInterval，只有真的有人来问才会触发一次采样。
 */
import type { WorkbenchState } from '../protocol.ts'
import { createSampleCache } from './sampleCache.ts'

export type RunCommand = (cmd: readonly string[]) => Promise<{ ok: boolean, stdout: string }>

/**
 * "今天到 +7 天"事件查询用的 AppleScript,逐行拆成多个 `-e` 参数传给 osascript
 * (§R3 证据用的是文件形式,这里改成 `-e` 数组同样能跑,不必现写临时文件)。
 *
 * 日期特意不用 `start date of ev as string`——那是本地化文案(如 "Thursday, 27 August
 * 2026")，格式随系统语言/地区设置变,解析起来是个雷。改成直接从 `date` 对象上取
 * year/month/day 三个数字字段拼 `YYYY-M-D`（`month of d` 是月份常量，`as integer`
 * 转成 1–12 的数字），拿到的永远是与地区无关的机读格式。
 */
function calendarAppleScriptLines(): readonly string[] {
  return [
    'set outputText to ""',
    'set startDate to current date',
    'set endDate to startDate + (7 * days)',
    'tell application "Calendar"',
    '    repeat with cal in calendars',
    '        try',
    '            set theEvents to (every event of cal whose start date >= startDate and start date <= endDate)',
    '            repeat with ev in theEvents',
    '                set d to start date of ev',
    '                set y to (year of d) as string',
    '                set m to (month of d) as integer as string',
    '                set dy to (day of d) as string',
    '                set outputText to outputText & (summary of ev) & "|" & y & "-" & m & "-" & dy & linefeed',
    '            end repeat',
    '        end try',
    '    end repeat',
    'end tell',
    'return outputText',
  ]
}

/** 组好完整的 `osascript -e ... -e ...` 命令数组，喂给 RunCommand。 */
export function calendarCommand(): readonly string[] {
  return ['osascript', ...calendarAppleScriptLines().flatMap(line => ['-e', line])]
}

/**
 * 解析 osascript 的输出。每行是 `标题|YYYY-M-D`(月/日不补零,见上面 AppleScript 注释)，
 * 按行拆开逐条转成 `{date,title}`。单行格式不认识就跳过那一行,不是整体报错——
 * Calendar 里偶尔会有奇怪的标题(比如真的含 `|` 的),丢一条比让全部事件消失更合理，
 * 空输出(近 7 天没有任何事件,§R3 实测真实存在这种情况)是合法结果,不是错误。
 */
export function parseCalendarOutput(out: string): readonly { date: string, title: string }[] {
  const trimmed = out.trim()
  if (trimmed === '') return []

  const events: { date: string, title: string }[] = []
  for (const rawLine of trimmed.split('\n')) {
    const line = rawLine.trim()
    if (line === '') continue
    const match = /^(.*)\|(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(line)
    if (match === null) continue
    const [, title, y, m, d] = match as unknown as [string, string, string, string, string]
    const date = `${y}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`
    events.push({ date, title: title.trim() })
  }
  return events
}

async function sampleOnce(run: RunCommand): Promise<WorkbenchState['calendar']> {
  const result = await run(calendarCommand())
  if (!result.ok) return { error: 'osascript 执行失败(可能是超时,或系统日历访问未授权)' }
  return { events: parseCalendarOutput(result.stdout) }
}

/**
 * 造一个"采一次"函数，内置最短间隔缓存(默认 300 秒)。
 * 跟 machine.ts 同一套规矩：不管上次采到的是正常值还是 `{ error }`，缓存都原样重放。
 *
 * single-flight（2026-08-21 真机实测补的,与 machine.ts 同一个根因,这里尤其要紧——
 * `osascript` 是四个 sampler 里最慢的一个,冷启动并发几次几乎必超时）：把"正在进行的
 * 那次采样"存成共享 promise,并发调用者共享它,不各自重开一次 AppleScript。
 *
 * 过期了先回上一份、后台补采,不让碰上的那一拍 `/state` 干等(2026-10-21;三格同一份,见 sampleCache.ts)。
 */
export function createCalendarSampler(
  run: RunCommand,
  now: () => number,
  minIntervalSec = 300,
): () => Promise<WorkbenchState['calendar']> {
  return createSampleCache(() => sampleOnce(run), now, minIntervalSec)
}
