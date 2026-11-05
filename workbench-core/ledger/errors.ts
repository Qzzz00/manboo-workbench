/**
 * 请求被拒。处理函数抛它:这次处理里写的事件全部回滚,拒绝结果照样进请求表(重发回同一个拒绝)。
 * 别的异常(程序错)整笔回滚、不进请求表,同一 request_id 可以重来。
 */
export class Reject extends Error {
  readonly code: string
  readonly detail: unknown
  constructor(code: string, detail?: unknown) {
    super(code)
    this.name = 'Reject'
    this.code = code
    this.detail = detail
  }
}

/** since 早于保留窗(或超前于本账)—— 调用方回 410,终端重新取快照。 */
export class Gone extends Error {
  readonly status = 410
  readonly reason: 'expired' | 'ahead'
  readonly since: number
  readonly max_seq: number
  constructor(reason: 'expired' | 'ahead', since: number, max_seq: number) {
    super(reason === 'expired' ? `since=${since} 早于保留窗,请重新取快照` : `since=${since} 超前于本账(最大 ${max_seq}),请重新取快照`)
    this.name = 'Gone'
    this.reason = reason
    this.since = since
    this.max_seq = max_seq
  }
}

/** 库文件读不懂 / 校验不过。绝不当空账接着写。 */
export class LedgerCorrupt extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = 'LedgerCorrupt'
  }
}
