/**
 * **个人访问令牌**(2026-10-21 协作区;待拍板 12 已定;视觉需求第 14 屏)。
 *
 * 给工程师的脚本与别家 agent 用:`workbench` 命令行带着它打本机 8791,写接口就按「她本人在点」放行
 * (授权表 `write_api` 那一道只拦**没带令牌的程序**)。普通用户的入口仍是设置页,命令行不是使用入口。
 *
 * 规矩:
 * - **只显示一次**:发的那一下把明文回给设置页,盘上只存 SHA-256 哈希(`~/.dsh/workbench/personal-token.json`);
 * - **可以发好几枚,每枚写用途**(先填用途再发);列表只给用途、开头几个字、发的时间、上次用的时间;撤一枚 = 那枚谁都用不了;
 * - **只在本机认**(HTTP 层只对回环来源查它):阶段一不跨机。
 * 老文件(只有一枚、没写用途)读成一枚「(没写用途)」。
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { PersonalTokenView } from '../protocol.ts'

/** 令牌的前缀(HTTP 层靠它把这把令牌与设备令牌、模块令牌分开)。 */
export const PERSONAL_TOKEN_PREFIX = 'wbp_'
/** 老文件那一枚没写用途时显示的字。 */
export const PERSONAL_TOKEN_NO_PURPOSE = '(没写用途)'
/** 「上次用的时间」多久才落一次盘(每一条请求都写盘太碎)。 */
const LAST_USED_WRITE_MS = 60_000

export function defaultPersonalTokenFile(home = process.env.HOME ?? ''): string {
  return `${home}/.dsh/workbench/personal-token.json`
}

export interface PersonalTokenStatus {
  issued: boolean
  /** 最近那一枚明文的头几个字(设置页上让他认得出是哪一枚;不够拿来用)。 */
  hint?: string
  created_at?: string
}

export interface PersonalTokens {
  /** 发一枚新的。**回的明文只有这一次**。用途缺席 = 「(没写用途)」(老调用方)。 */
  issue: (purpose?: string) => Promise<string>
  /** 发一枚新的,连同它在列表里的样子一起回。用途必填。 */
  issueWith: (purpose: string) => Promise<{ token: string, view: PersonalTokenView }>
  verify: (token: string) => Promise<boolean>
  list: () => Promise<PersonalTokenView[]>
  status: () => Promise<PersonalTokenStatus>
  /** 撤一枚;不给 id = 全撤(老调用方)。 */
  revoke: (id?: string) => Promise<boolean>
}

interface StoredToken { id: string, purpose: string, hash: string, hint: string, created_at: string, last_used_at?: string }

function hashOf(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex')
}

function viewOf(one: StoredToken): PersonalTokenView {
  return { id: one.id, purpose: one.purpose, hint: one.hint, created_at: one.created_at, ...(one.last_used_at === undefined ? {} : { last_used_at: one.last_used_at }) }
}

export function createPersonalTokens(opts: { file: string, now?: () => Date }): PersonalTokens {
  const now = opts.now ?? (() => new Date())
  const lastWrite = new Map<string, number>()

  async function read(): Promise<StoredToken[]> {
    let raw: Record<string, unknown>
    try { raw = JSON.parse(await readFile(opts.file, 'utf8')) as Record<string, unknown> }
    catch { return [] }
    const good = (one: Record<string, unknown>): boolean => typeof one.hash === 'string' && /^[0-9a-f]{64}$/.test(one.hash)
    if (Array.isArray(raw.tokens)) {
      return (raw.tokens as Record<string, unknown>[]).filter(one => typeof one === 'object' && one !== null && good(one) && typeof one.id === 'string').map(one => ({
        id: one.id as string,
        purpose: typeof one.purpose === 'string' && one.purpose !== '' ? one.purpose : PERSONAL_TOKEN_NO_PURPOSE,
        hash: one.hash as string,
        hint: typeof one.hint === 'string' ? one.hint : '',
        created_at: typeof one.created_at === 'string' ? one.created_at : '',
        ...(typeof one.last_used_at === 'string' ? { last_used_at: one.last_used_at } : {}),
      }))
    }
    // 老文件:只有一枚。
    return good(raw)
      ? [{ id: 'pat-legacy', purpose: PERSONAL_TOKEN_NO_PURPOSE, hash: raw.hash as string, hint: typeof raw.hint === 'string' ? raw.hint : '', created_at: typeof raw.created_at === 'string' ? raw.created_at : '' }]
      : []
  }

  async function write(tokens: StoredToken[]): Promise<void> {
    if (tokens.length === 0) { await rm(opts.file, { force: true }); return }
    await mkdir(dirname(opts.file), { recursive: true })
    const tmp = `${opts.file}.${randomBytes(4).toString('hex')}.tmp`
    await writeFile(tmp, `${JSON.stringify({ tokens }, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
    await rename(tmp, opts.file)
  }

  async function issueWith(purpose: string): Promise<{ token: string, view: PersonalTokenView }> {
    const token = `${PERSONAL_TOKEN_PREFIX}${randomBytes(24).toString('base64url')}`
    const stored: StoredToken = {
      id: `pat-${randomBytes(4).toString('hex')}`,
      purpose: purpose.trim() === '' ? PERSONAL_TOKEN_NO_PURPOSE : purpose.trim().slice(0, 60),
      hash: hashOf(token),
      hint: token.slice(0, PERSONAL_TOKEN_PREFIX.length + 4),
      created_at: now().toISOString(),
    }
    await write([...(await read()), stored])
    return { token, view: viewOf(stored) }
  }

  return {
    async issue(purpose) { return (await issueWith(purpose ?? '')).token },
    issueWith,
    async verify(token) {
      if (!token.startsWith(PERSONAL_TOKEN_PREFIX)) return false
      const tokens = await read()
      const a = Buffer.from(hashOf(token), 'hex')
      const hit = tokens.find((one) => {
        const b = Buffer.from(one.hash, 'hex')
        return a.length === b.length && timingSafeEqual(a, b)
      })
      if (hit === undefined) return false
      const at = now()
      if ((lastWrite.get(hit.id) ?? 0) + LAST_USED_WRITE_MS <= at.getTime()) {
        lastWrite.set(hit.id, at.getTime())
        hit.last_used_at = at.toISOString()
        await write(tokens).catch(() => undefined)
      }
      return true
    },
    async list() { return (await read()).map(viewOf) },
    async status() {
      const tokens = await read()
      const latest = tokens.at(-1)
      return latest === undefined ? { issued: false } : { issued: true, hint: latest.hint, created_at: latest.created_at }
    },
    async revoke(id) {
      const tokens = await read()
      const kept = id === undefined ? [] : tokens.filter(one => one.id !== id)
      if (kept.length === tokens.length) return false
      await write(kept)
      return true
    },
  }
}
