/**
 * 只读事件流的内存环(阶段 1,v3 §5.2.7)。
 *
 * - seq 是这一次进程生命里的本机序号,从 1 起严格 +1;不落盘,重启归零 —— 所以另带一个 epoch,
 *   终端拿旧 epoch 来续就回 410、让它重取快照(v3 §5.2.4「since 早于保留窗回 410」的同一条路)。
 * - 只留最近 keep 条、总字节不超过 keepBytes(可丢)。最新一条无论多大都留着,否则续流会凭空缺一号。
 * - 每条事件追加时就序列化一次,SSE 直接发这串字,不重复 stringify 几十万字节的 /state 键。
 */
import { randomUUID } from 'node:crypto'

export interface CoreEvent {
  seq: number
  ts: number
  topic: string
  kind: string
  payload: unknown
}

export type SinceResult =
  | { ok: true, events: CoreEvent[] }
  | { ok: false, reason: 'too_old' | 'ahead' | 'bad', oldest_seq: number, last_seq: number }

interface Stored { event: CoreEvent, line: string }

export interface EventLogOptions {
  keep: number
  keepBytes?: number
  now?: () => number
  epoch?: string
}

export class EventLog {
  readonly epoch: string
  private readonly keep: number
  private readonly keepBytes: number
  private readonly now: () => number
  private readonly ring: Stored[] = []
  private bytes = 0
  private seq = 0
  private readonly listeners = new Set<(event: CoreEvent, line: string) => void>()

  constructor(options: EventLogOptions) {
    this.keep = Math.max(1, options.keep)
    this.keepBytes = options.keepBytes ?? Number.POSITIVE_INFINITY
    this.now = options.now ?? Date.now
    this.epoch = options.epoch ?? randomUUID()
  }

  get lastSeq(): number { return this.seq }
  /** 缓冲里最老那一条的 seq;空的时候是 lastSeq + 1(没有任何可回放的)。 */
  get oldestSeq(): number { return this.ring[0]?.event.seq ?? this.seq + 1 }
  size(): number { return this.ring.length }

  append(topic: string, kind: string, payload: unknown): CoreEvent {
    this.seq += 1
    const event: CoreEvent = { seq: this.seq, ts: this.now(), topic, kind, payload }
    const line = JSON.stringify(event)
    this.ring.push({ event, line })
    this.bytes += line.length
    while (this.ring.length > 1 && (this.ring.length > this.keep || this.bytes > this.keepBytes)) {
      const dropped = this.ring.shift()!
      this.bytes -= dropped.line.length
    }
    for (const listener of this.listeners) listener(event, line)
    return event
  }

  /** seq 大于 since 的全部事件。缺了任何一条就说缺,不给一段有洞的流。 */
  since(since: number): SinceResult {
    const meta = { oldest_seq: this.oldestSeq, last_seq: this.seq }
    if (!Number.isInteger(since) || since < 0) return { ok: false, reason: 'bad', ...meta }
    if (since > this.seq) return { ok: false, reason: 'ahead', ...meta }
    if (since + 1 < this.oldestSeq) return { ok: false, reason: 'too_old', ...meta }
    return { ok: true, events: this.ring.filter(s => s.event.seq > since).map(s => s.event) }
  }

  /** 与 since 一样,给 SSE 用的预序列化版本。 */
  linesSince(since: number): Array<{ seq: number, line: string }> {
    return this.ring.filter(s => s.event.seq > since).map(s => ({ seq: s.event.seq, line: s.line }))
  }

  subscribe(listener: (event: CoreEvent, line: string) => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }
}
