/**
 * 串联(黑洞 → 粒子球)真机打点的收口(2026-09-24 第五轮,维护者 0.2.79 真机「还是卡」)。
 *
 * 两端(电脑壳 WKWebView、手机 Android WebView)每次串联记 3 秒帧间隔 / 长任务,登录后 `POST /perf/handoff`。
 * 这里**只收数字与几个固定枚举**(白名单字段),写一行进 8791 日志(`[性能] 串联 …`),并留最近每端一份给 `GET /perf/handoff`。
 * 没有任何对话内容、路径、账号;字段不认识的一律丢掉。
 */
const NUMBER_FIELDS = ['count', 'paintMs', 'syncMs', 'gateMs', 'firstFrameMs', 'frames', 'maxGapMs', 'p95GapMs', 'medianGapMs', 'over50', 'over100', 'longtasks', 'longtaskMaxMs', 'longtaskTotalMs'] as const
const SIDES = new Set(['desk', 'phone'])
const MODES = new Set(['fly', 'fade', 'degraded'])
const REASONS = new Set(['', 'first-frame', 'gate-timeout', 'slow-frame'])

export interface HandoffPerfRecord {
  side: 'desk' | 'phone'
  mode: 'fly' | 'fade' | 'degraded'
  degradeReason: string
  viewport: string
  received_at: string
  [key: string]: number | null | string
}

export function parseHandoffPerf(body: unknown, now: Date = new Date()): HandoffPerfRecord | { error: string } {
  if (typeof body !== 'object' || body === null) return { error: 'body 必须是对象' }
  const raw = body as Record<string, unknown>
  if (typeof raw.side !== 'string' || !SIDES.has(raw.side)) return { error: 'side 必须是 desk 或 phone' }
  if (typeof raw.mode !== 'string' || !MODES.has(raw.mode)) return { error: 'mode 不认识' }
  const out: HandoffPerfRecord = {
    side: raw.side as 'desk' | 'phone',
    mode: raw.mode as 'fly' | 'fade' | 'degraded',
    degradeReason: typeof raw.degradeReason === 'string' && REASONS.has(raw.degradeReason) ? raw.degradeReason : '',
    viewport: typeof raw.viewport === 'string' && /^\d{1,5}x\d{1,5}@[\d.]{1,5}$/.test(raw.viewport) ? raw.viewport : '',
    received_at: now.toISOString(),
  }
  for (const key of NUMBER_FIELDS) {
    const v = raw[key]
    out[key] = typeof v === 'number' && Number.isFinite(v) ? Math.round(Math.max(-1, Math.min(v, 1e6)) * 10) / 10 : null
  }
  return out
}

/** 8791 日志里那一行。 */
export function handoffPerfLine(r: HandoffPerfRecord): string {
  const lt = r.longtasks === null ? '不支持' : `${r.longtasks} 个 / 最长 ${r.longtaskMaxMs}ms / 共 ${r.longtaskTotalMs}ms`
  return `[性能] 串联 ${r.side} ${r.mode}${r.degradeReason ? `(${r.degradeReason})` : ''} 飞 ${r.count} 颗;`
    + `点下到首帧 ${r.firstFrameMs}ms,同步 ${r.syncMs}ms,闸门 ${r.gateMs}ms,黑洞一帧 ${r.paintMs}ms;`
    + `3 秒 ${r.frames} 帧,最长间隔 ${r.maxGapMs}ms,p95 ${r.p95GapMs}ms,>50ms ${r.over50} 次,>100ms ${r.over100} 次;长任务 ${lt};${r.viewport}`
}

export function createHandoffPerfLog(log: (line: string) => void = line => console.log(line)) {
  const last: Partial<Record<'desk' | 'phone', HandoffPerfRecord>> = {}
  return {
    record(r: HandoffPerfRecord): void { last[r.side] = r; log(handoffPerfLine(r)) },
    view(): Partial<Record<'desk' | 'phone', HandoffPerfRecord>> { return { ...last } },
  }
}
