/**
 * 页面自己报错(2026-09-25,卡 V)。
 *
 * 09-25 晚维护者点「事务官」没反应、页面卡死 —— 而**没有任何地方记录**。统筹只能靠他复述,
 * 第二天再猜是哪一行。页面里出的错原来只落在 WKWebView 的控制台里,那个控制台他打不开、统筹也看不到。
 *
 * 从此:客户端 `window.onerror` / `unhandledrejection` → `POST /client/error` →
 * ① 服务端日志(一行,`[client-error]` 打头,`grep` 得到);② `/state.client_errors`(最近 N 条)。
 * 事务官在设置里看得到,统筹 `curl 127.0.0.1:8791/state` 看得到。手机端同一条路(`where: 'phone'`)。
 *
 * 三条纪律:
 * 1. **一条死循环不许冲掉别的**:同一条错误(message + 栈的第一行)折叠成一行、只加计数,
 *    不占 N 条里的 N 个位置(一个每帧抛一次的 React 错误几秒就能把窗口冲干净);
 * 2. **只留最近 N 条**(默认 20),环形替换,不落盘 —— 它是「此刻这台机器上出了什么」,不是台账;
 * 3. **截过再存**:一句话 240 字、栈只留前 5 行共 800 字。页面能塞多长的字符串没上限,
 *    不截的话一条报错就能把 `/state` 撑大到手机上拉不动。
 */
import type { ClientErrorView } from '../protocol.ts'

export const CLIENT_ERROR_KEEP = 20
export const CLIENT_ERROR_MESSAGE_MAX = 240
export const CLIENT_ERROR_STACK_LINES = 5
export const CLIENT_ERROR_STACK_MAX = 800

/** `POST /client/error` 的请求体。字段全可缺 —— 页面已经出错了,别再指望它填得齐。 */
export interface ClientErrorReport {
  message?: unknown
  stack?: unknown
  view?: unknown
  where?: unknown
}

export interface ClientErrorStore {
  /** 收一条。回 `undefined` = 这一条没记(连一句话都凑不出来)。 */
  record: (report: ClientErrorReport, atIso: string) => ClientErrorView | undefined
  /** 最近的在前。 */
  list: () => readonly ClientErrorView[]
}

function clip(text: string, max: number): string {
  const chars = [...text]
  return chars.length <= max ? text : `${chars.slice(0, max).join('')}…`
}

function textOf(value: unknown, max: number): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.replace(/\r/g, '').trim()
  return trimmed === '' ? undefined : clip(trimmed, max)
}

/** 栈只留前几行(第一行就够定位,整段栈在 WKWebView 里动辄几十行)。 */
function stackOf(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const lines = value.split('\n').map(line => line.trim()).filter(line => line !== '')
  if (lines.length === 0) return undefined
  return clip(lines.slice(0, CLIENT_ERROR_STACK_LINES).join('\n'), CLIENT_ERROR_STACK_MAX)
}

/** 折叠键:同一句话 + 栈的第一行算同一条。 */
function foldKey(entry: ClientErrorView): string {
  return `${entry.where}|${entry.view ?? ''}|${entry.message}|${entry.stack?.split('\n')[0] ?? ''}`
}

/**
 * 造一个「最近出的几个错」的盒子。`log` 是往服务端日志写一行的口子(缺省不写,给测试用)。
 */
export function createClientErrorStore(options: { keep?: number, log?: (line: string) => void } = {}): ClientErrorStore {
  const keep = options.keep ?? CLIENT_ERROR_KEEP
  /** 最近的在前。 */
  let entries: ClientErrorView[] = []

  return {
    record(report, atIso) {
      const message = textOf(report.message, CLIENT_ERROR_MESSAGE_MAX)
      if (message === undefined) return undefined // 连一句话都没有:不记一条空的(D13)
      const stack = stackOf(report.stack)
      const view = textOf(report.view, 40)
      const where = report.where === 'phone' ? 'phone' as const : 'desktop' as const
      const fresh: ClientErrorView = { at: atIso, where, message, ...(stack === undefined ? {} : { stack }), ...(view === undefined ? {} : { view }), count: 1 }
      const key = foldKey(fresh)
      const priorIndex = entries.findIndex(entry => foldKey(entry) === key)
      if (priorIndex >= 0) {
        // 同一条又来了:计数 +1、时刻刷成最新,挪到最前面。不新占一个位置。
        const merged: ClientErrorView = { ...entries[priorIndex]!, at: atIso, count: entries[priorIndex]!.count + 1 }
        entries = [merged, ...entries.filter((_, index) => index !== priorIndex)]
        options.log?.(`[client-error] ${where} ${message} ×${merged.count}`)
        return merged
      }
      entries = [fresh, ...entries].slice(0, keep)
      options.log?.(`[client-error] ${where}${view === undefined ? '' : ` (${view})`} ${message}${stack === undefined ? '' : ` | ${stack.split('\n')[0]}`}`)
      return fresh
    },
    list() {
      return entries
    },
  }
}
