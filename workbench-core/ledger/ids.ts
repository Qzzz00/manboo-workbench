import { createHash, randomBytes } from 'node:crypto'

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'

let lastTime = -1
let lastRandom: number[] = []

/** ULID:48 位毫秒 + 80 位随机,同一毫秒内随机部分递增(同进程单调)。 */
export function ulid(now: number): string {
  if (!Number.isSafeInteger(now) || now < 0) throw new RangeError(`ulid: bad time ${now}`)
  if (now === lastTime) {
    let i = lastRandom.length - 1
    while (i >= 0 && lastRandom[i] === 31) {
      lastRandom[i] = 0
      i -= 1
    }
    if (i < 0) throw new Error('ulid: random part overflow within one millisecond')
    lastRandom[i] = (lastRandom[i] as number) + 1
  } else {
    lastTime = now
    lastRandom = Array.from(randomBytes(16), (b) => b & 31)
  }
  let time = ''
  let t = now
  for (let i = 0; i < 10; i++) {
    time = CROCKFORD[t % 32] + time
    t = Math.floor(t / 32)
  }
  return time + lastRandom.map((d) => CROCKFORD[d]).join('')
}

const ORIGIN_RE = /^[a-z0-9][a-z0-9-]{0,62}$/

/** 来源座机服务前缀:小写字母、数字、连字符。它进每一个 object_id / ask_id。 */
export function assertOrigin(origin: string): void {
  if (!ORIGIN_RE.test(origin)) throw new Error(`ledger origin 只能是小写字母、数字、连字符(1–63 位),收到 ${JSON.stringify(origin)}`)
}

/** 键排序后的 JSON,用来算内容哈希。 */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null'
  if (Array.isArray(value)) return `[${value.map((v) => (v === undefined ? 'null' : stableStringify(v))).join(',')}]`
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(',')}}`
}

/** ask 的操作内容哈希:与键顺序无关。 */
export function contentHash(value: unknown): string {
  return `sha256:${createHash('sha256').update(stableStringify(value)).digest('hex')}`
}
