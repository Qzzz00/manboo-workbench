/**
 * 自动上报(2026-09-22)。出了错,脱敏之后 `POST /v1/diag/report` 给中转。
 *
 * ## 报什么时候
 *
 * 四类,与 `src/diag.ts` 的 `DIAG_KINDS` 一一对应:没人接的异常、崩溃后被拉起来、
 * 更新失败、通话异常结束。**不报**别的 —— 尤其不报"用户点了一个按钮失败了"这种
 * 界面层的错:那种事一分钟能有几十次,而且多半是他自己知道原因(没联网)。
 *
 * ## 可以关
 *
 * 设置里「出错自动报告给开发者」,落在 `~/.dsh/workbench/app.json` 的 `diag_report`。
 * **默认开**,但首次进体检页时把那段话显著地摆出来一次(`diag_notice_seen_at`)——
 * 默认开 + 说清楚 + 一颗随时能关的开关,是这一版的选择;它是可推翻的(决策记录里写着)。
 *
 * ## 限频与合并
 *
 * 每台设备每小时 20 条。**崩溃循环一分钟能刷几百条**,没有闸的话第一件被压垮的
 * 就是我们自己的服务器,第二件是 Ben 那台机器的上行带宽。
 *
 * 超了之后不是丢掉,是**合并**:按(组件 + 种类 + 报错头 80 个字)归一类,记个数;
 * 窗口一松就把最新那一条带着 `merged: n` 发出去。于是服务器上看到的是
 * 「同一个错在这一小时里发生了 137 次」,而不是 137 条一模一样的行,也不是一片空白。
 *
 * ## 没登录怎么办
 *
 * 取不到设备令牌就**不发**,而且不重试、不排队落盘。理由:没令牌多半意味着
 * 这台机器还没走完登录,那会儿的报错基本都是"还没配好"这一类,发过去也没用;
 * 而落盘排队意味着要在用户磁盘上攒一堆报错文本,那是另一种风险。
 * 界面上那一格会如实说「还没连上服务器」。
 */
import { diagCode, type DiagComponent, type DiagKind, type DiagReportBody, type DiagSettingsView } from '../../diag.ts'
import { redactLines, redactText } from './redact.ts'

/** 每台设备每小时的条数上限。与中转 `relay/server/diag.cjs` 的 `DIAG_PER_HOUR` 是同一个数。 */
export const DIAG_HOURLY_LIMIT = 20

export const DIAG_WINDOW_MS = 3_600_000

/** 一条报错最多多长。中转那边也会再截一次,这里先截是为了不白发几十 KB。 */
export const MAX_MESSAGE = 500
export const MAX_STACK_LINES = 20
export const MAX_LOG_LINES = 50

export interface DiagEvent {
  component: DiagComponent
  kind: DiagKind
  message: string
  /** 栈。字符串或已经切好的行都行。 */
  stack?: string | readonly string[]
  /** 出事前后的日志。不给就是空 —— **不替它去猜哪份日志相关**。 */
  log?: readonly string[]
  /** 出事时刻(毫秒)。不给用 `now()`。 */
  atMs?: number
}

export interface DiagReportOutcome {
  /** 这一条的编号。**不论发没发出去都有** —— 界面要显示它,日志里也要有它。 */
  code: string
  /** 真发出去了。 */
  sent: boolean
  /** 没发出去的原因,人话。发出去了就缺席。 */
  why?: string
  /** 这一条代表几次(合并过的大于 1)。 */
  merged: number
}

export interface DiagReporterDeps {
  /** 中转地址 + 设备令牌。没登录就回 undefined。 */
  link: () => Promise<{ relayUrl: string, token: string } | undefined>
  /** 开关。读 `app.json` 的 `diag_report`(缺席 = 开)。 */
  enabled: () => Promise<boolean>
  version: string
  now: () => number
  fetchImpl?: typeof fetch
  /** 把一行写进本机日志。编号就是靠这一行跟界面对上的。 */
  log?: (line: string) => void
  hourlyLimit?: number
  timeoutMs?: number
}

export interface DiagReporter {
  /** 报一条。**永远不抛** —— 上报失败不该再引发一次上报。 */
  report: (event: DiagEvent) => Promise<DiagReportOutcome>
  /** 把攒着的合并条目发出去(窗口松了才真发)。composeState 每拍调一次。 */
  pump: () => void
  view: () => Pick<DiagSettingsView, 'sent_this_hour' | 'hourly_limit'> & { pending_merged: number }
}

interface Pending { event: DiagEvent, count: number, code: string }

/** 归类的键。头 80 个字够把两个不同的错分开,又不至于让"第 N 次重试"各成一类。 */
function keyOf(event: DiagEvent): string {
  return `${event.component}|${event.kind}|${event.message.slice(0, 80)}`
}

function linesOf(value: string | readonly string[] | undefined): readonly string[] {
  if (value === undefined) return []
  const all = typeof value === 'string' ? value.split('\n') : value
  return all.map(line => line.replace(/\s+$/, '')).filter(line => line !== '')
}

export function createDiagReporter(deps: DiagReporterDeps): DiagReporter {
  const fetchImpl = deps.fetchImpl ?? fetch
  const limit = deps.hourlyLimit ?? DIAG_HOURLY_LIMIT
  const timeoutMs = deps.timeoutMs ?? 8000
  const log = deps.log ?? (() => {})
  /** 这一小时发出去的时刻。滑动窗口,重启清零(上报是低频动作,不值得为它落盘)。 */
  let sent: number[] = []
  const pending = new Map<string, Pending>()
  let flushing = false

  function room(at: number): number {
    sent = sent.filter(t => at - t < DIAG_WINDOW_MS)
    return Math.max(0, limit - sent.length)
  }

  function bodyOf(event: DiagEvent, code: string, merged: number, at: number): DiagReportBody {
    return {
      version: deps.version,
      component: event.component,
      kind: event.kind,
      code,
      message: redactText(event.message).slice(0, MAX_MESSAGE),
      stack: redactLines(linesOf(event.stack).slice(0, MAX_STACK_LINES)),
      log: redactLines(linesOf(event.log).slice(-MAX_LOG_LINES)),
      at: new Date(event.atMs ?? at).toISOString(),
      merged,
    }
  }

  async function send(body: DiagReportBody): Promise<{ ok: true } | { ok: false, why: string }> {
    const target = await deps.link()
    if (target === undefined) return { ok: false, why: '还没连上服务器(没有设备令牌),这一条只留在本机日志里。' }
    try {
      const res = await fetchImpl(`${target.relayUrl}/v1/diag/report`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${target.token}` },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      })
      if (res.ok) return { ok: true }
      // 中转那边也有同一道闸。它说满了就按满了算 —— 下一拍再合并发。
      if (res.status === 429) return { ok: false, why: '服务器说这一小时已经报满了。' }
      return { ok: false, why: `服务器没收(HTTP ${res.status})。` }
    }
    catch (error) {
      return { ok: false, why: `发不出去:${redactText(error instanceof Error ? error.message : String(error))}` }
    }
  }

  return {
    async report(event) {
      const at = deps.now()
      const code = diagCode(event.component, event.atMs ?? at)
      // **先写本机日志**。这一行是编号与现场之间那根绳子:开关关着、网断了、
      // 中转挂了,它照样在 ~/.dsh/logs 里。
      log(`[诊断] ${code} ${event.component}/${event.kind}:${redactText(event.message).slice(0, MAX_MESSAGE)}`)

      if (!(await deps.enabled())) {
        return { code, sent: false, why: '「出错自动报告给开发者」关着,这一条只留在本机日志里。', merged: 1 }
      }
      if (room(at) === 0) {
        const key = keyOf(event)
        const has = pending.get(key)
        // 合并时**留住最早那个编号**:Ben 念的多半是他第一次看见的那个。
        if (has === undefined) pending.set(key, { event, count: 1, code })
        else { has.count += 1; has.event = event }
        return {
          code: has?.code ?? code,
          sent: false,
          why: `这一小时已经报满 ${limit} 条,先合并计数(第 ${(has?.count ?? 0) + 1} 次)。`,
          merged: (has?.count ?? 0) + 1,
        }
      }
      sent.push(at)
      const out = await send(bodyOf(event, code, 1, at))
      return out.ok ? { code, sent: true, merged: 1 } : { code, sent: false, why: out.why, merged: 1 }
    },

    pump() {
      if (flushing || pending.size === 0) return
      const at = deps.now()
      if (room(at) === 0) return
      flushing = true
      void (async () => {
        try {
          if (!(await deps.enabled())) { pending.clear(); return }
          while (pending.size > 0 && room(deps.now()) > 0) {
            const [key, item] = [...pending.entries()][0] as [string, Pending]
            pending.delete(key)
            const at2 = deps.now()
            sent.push(at2)
            // 合并条目带的是**被合并掉的总次数**(自己那一次也算在里头)。
            const out = await send(bodyOf(item.event, item.code, item.count, at2))
            if (!out.ok) {
              // 发不出去就放回去,下一拍再试。**不无限堆积**:同一个键只有一条。
              pending.set(key, item)
              break
            }
          }
        }
        finally { flushing = false }
      })()
    },

    view() {
      const at = deps.now()
      let merged = 0
      for (const item of pending.values()) merged += item.count
      return { sent_this_hour: limit - room(at), hourly_limit: limit, pending_merged: merged }
    },
  }
}
