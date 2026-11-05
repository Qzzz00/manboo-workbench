/**
 * 本机账号(2026-09-17,决策记录「登录就是账号密码」)。Ben 原话:
 * 「登录为什么是输入 API Key?登录就是登录自己的账号密码啊,现在可以随便注册,自己记得住就行。」
 *
 * 落盘 `~/.dsh/workbench/account.json`:**只有加盐哈希**(scrypt),没有明文、也没有可逆的东西;
 * 会话的签名密钥单独一份 `~/.dsh/workbench/account-session.key`(32 字节随机,删了等于把所有
 * cookie 一起作废)。两份都是 0600,与 devices.json / credentials.json 同规格。
 *
 * 纪律(与 devices.ts 同源):
 * - **只存哈希**。注册那一刻之后,本机自己也拿不回密码;忘了就只能删 account.json 重注册。
 * - 密码、cookie、签名密钥**一个字都不进日志**,也不进 /state、不进任何回包(view 里只有用户名)。
 * - 错密码 5 次锁 10 分钟(与配对码同一档),锁着的时候登录/注册/登出三条路一律 429。
 * - **登录只决定界面**:这一层不是鉴权。回环来源照旧放行工作台的一切(壳、本机浏览器、
 *   DSH 会话、例程都靠它),前端看 `/account` 的 logged_in 决定显示登录屏还是工作台。
 *   以后账号搬到自家服务器时,这道门才真的变成鉴权 —— 那一天要改的是 http.ts 的来源门,
 *   不是这个文件。
 *
 * 会话令牌的形状:`<用户名 base64url>.<到期毫秒>.<sid>.<HMAC-SHA256>`,签的是前三段。
 * `sid` 是当前口令哈希的前 16 个十六进制字符 —— 改了密码,旧 cookie 当场失效
 * (不用另存一张会话表,也不怕漏撤)。
 */
import { createHash, createHmac, randomBytes, scrypt as scryptCb, timingSafeEqual } from 'node:crypto'
import { chmod, mkdir, readFile, rename, writeFile, rm } from 'node:fs/promises'
import { dirname } from 'node:path'
import { promisify } from 'node:util'

const scrypt = promisify(scryptCb) as (
  password: string, salt: string, keylen: number, options: { N: number, r: number, p: number, maxmem: number },
) => Promise<Buffer>

/** cookie 名。前缀独有,不跟 DSH 自己的 cookie 撞。 */
export const ACCOUNT_COOKIE = 'ben_wb_account'
/** 30 天(Ben 的机器,一个月登录一次已经够烦了)。 */
export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000
const MAX_ATTEMPTS = 5
const LOCK_MS = 10 * 60_000
/** scrypt 参数。N 记进记录里 —— 以后调大了,老账号仍然验得动。 */
const SCRYPT_N = 16_384
const SCRYPT_R = 8
const SCRYPT_P = 1
const KEYLEN = 64

export const USERNAME_MAX = 32
export const PASSWORD_MIN = 4
export const PASSWORD_MAX = 200

export interface AccountRecord {
  username: string
  /** 十六进制,16 字节。 */
  salt: string
  /** 十六进制,scrypt(password, salt)。**永远不出这个文件**。 */
  hash: string
  /** 算这份哈希时用的 N。缺席按 16384 读(第一版就是它)。 */
  n?: number
  created_at: string
  updated_at?: string
}

export interface AccountFile { version: 1, account?: AccountRecord }

/** `GET /account` 的回包。**没有哈希、没有 salt**。 */
export interface AccountView {
  registered: boolean
  logged_in: boolean
  /** 注册过就有(本机自己的用户名,不是秘密);没注册过缺席。 */
  username?: string
  /** 被锁时才有:到这一刻之前不再接受登录。 */
  locked_until?: string
  /**
   * 这个账号在自家服务器上(2026-09-21),不只在这台机器上。界面据此:
   * ① 「账号」那一节不再写"只在这台机器上";② 多出「我的设备」一列。
   * **缺席 = 还是本机账号**(老服务端、退回本机的那条路都不会带这一格)。
   */
  on_server?: boolean
  /**
   * `false` = 这台没接中转(2026-10-21,零服务器档):账号只能在这台电脑上,登录台不说「存在服务器上」。
   * 缺席 = 接了中转(或老服务端)。
   */
  relay_configured?: false
}

export type AccountResult =
  | { ok: true, username: string, token: string, expires_at: string }
  | { ok: false, status: 400 | 401 | 403 | 409 | 429, error: string, locked_until?: string }

export interface AccountService {
  /** 当前状态。token 给 cookie 里那一段,认不出就是没登录。 */
  view: (token?: string) => Promise<AccountView>
  /** 没账号时注册;已登录时改密(要当前密码)。两种都回一张新 cookie。 */
  register: (input: {
    username?: unknown, password?: unknown, confirm?: unknown, current_password?: unknown, token?: string,
  }) => Promise<AccountResult>
  login: (input: { username?: unknown, password?: unknown }) => Promise<AccountResult>
  /** 认 cookie 里那一段;认不出(错、过期、改过密码)回 undefined。 */
  verify: (token?: string) => Promise<{ username: string } | undefined>
  /** 被锁到什么时候;没锁就是 undefined。 */
  lockedUntil: () => string | undefined
  /**
   * 重置账号(2026-09-17 Ben:「忘了密码没有找回」对半专业用户不可接受):删掉账号记录、换掉会话签名密钥,
   * 之后可以重新注册。只在本机能点(回环门在 http.ts),数据(记忆/事项)一个字不动。
   */
  reset: () => Promise<void>
}

/**
 * 会话 cookie 的签名器(2026-09-21 从 createAccountService 里抽出来)。
 *
 * 抽它的理由只有一个:账号搬到服务器之后,**登录态判在服务器,cookie 仍然要在本机签** ——
 * 浏览器认的是 cookie,而服务器那张会话令牌一个字节都不该进浏览器。于是本机账号
 * (createAccountService)与服务器账号(serverAccount.ts)要用同一套签名,
 * 不然两条路发出去的 cookie 互相不认,切换那一下人就被踢下线了。
 *
 * 形状没变:`<主体 base64url>.<到期毫秒>.<sid>.<HMAC-SHA256>`,签的是前三段。
 * `sid` 由调用方给:本机那份用当前口令哈希的前 16 位(改了密码旧 cookie 当场失效),
 * 服务器那份用服务器会话令牌哈希的前 16 位(在别处登出了,这台的 cookie 也就断了)。
 */
export interface SessionSigner {
  issue: (subject: string, sid: string) => Promise<{ token: string, expires_at: string }>
  /** 验签 + 验期。**不查账号** —— 主体是谁、还算不算数,由调用方自己判。 */
  open: (token?: string) => Promise<{ subject: string, sid: string } | undefined>
  /** 换一把签名密钥:所有已发出去的 cookie 当场作废。 */
  reset: () => Promise<void>
}

export interface SessionSignerOptions {
  /** ~/.dsh/workbench/account-session.key */
  keyFile: string
  now?: () => number
  randomHex?: (bytes: number) => string
  sessionTtlMs?: number
}

export function createSessionSigner(options: SessionSignerOptions): SessionSigner {
  const now = options.now ?? Date.now
  const randomHex = options.randomHex ?? ((bytes: number) => randomBytes(bytes).toString('hex'))
  const ttlMs = options.sessionTtlMs ?? SESSION_TTL_MS
  let cachedKey: Buffer | undefined
  let writeQueue: Promise<void> = Promise.resolve()

  /** 签名密钥:有就读,没有就生成一份 0600 的。丢了 = 所有 cookie 立刻作废(不是错误)。 */
  async function sessionKey(): Promise<Buffer> {
    if (cachedKey !== undefined) return cachedKey
    try {
      const text = (await readFile(options.keyFile, 'utf8')).trim()
      if (/^[0-9a-f]{64}$/.test(text)) {
        cachedKey = Buffer.from(text, 'hex')
        return cachedKey
      }
    }
    catch {
      // 没有就往下走,生成一份。
    }
    const hex = randomHex(32)
    const task = writeQueue.then(async () => {
      await mkdir(dirname(options.keyFile), { recursive: true })
      const tmp = `${options.keyFile}.${randomHex(8)}.tmp`
      await writeFile(tmp, `${hex}\n`, { mode: 0o600 })
      await rename(tmp, options.keyFile)
      await chmod(options.keyFile, 0o600)
    })
    writeQueue = task.then(() => undefined, () => undefined)
    await task
    cachedKey = Buffer.from(hex, 'hex')
    return cachedKey
  }

  async function sign(payload: string): Promise<string> {
    return createHmac('sha256', await sessionKey()).update(payload, 'utf8').digest('hex')
  }

  return {
    async issue(subject, sid) {
      const expiresAtMs = now() + ttlMs
      const payload = `${b64url(subject)}.${expiresAtMs}.${sid}`
      return { token: `${payload}.${await sign(payload)}`, expires_at: new Date(expiresAtMs).toISOString() }
    },

    async open(token) {
      if (typeof token !== 'string' || token === '') return undefined
      const parts = token.split('.')
      if (parts.length !== 4) return undefined
      const [subjectB64, expText, sid, mac] = parts as [string, string, string, string]
      const payload = `${subjectB64}.${expText}.${sid}`
      if (!sameString(await sign(payload), mac)) return undefined
      const expiresAtMs = Number(expText)
      if (!Number.isFinite(expiresAtMs) || expiresAtMs <= now()) return undefined
      const subject = unb64url(subjectB64)
      if (subject === undefined || subject === '') return undefined
      return { subject, sid }
    },

    async reset() {
      cachedKey = undefined
      try { await rm(options.keyFile, { force: true }) } catch { /* 没有就没有 */ }
    },
  }
}

export interface AccountServiceOptions {
  /** ~/.dsh/workbench/account.json */
  file: string
  /** ~/.dsh/workbench/account-session.key */
  keyFile: string
  /** 毫秒时钟,缺省 Date.now。 */
  now?: () => number
  /** 随机源(salt / 签名密钥),测试注入。回十六进制。 */
  randomHex?: (bytes: number) => string
  /** scrypt 的 N。**只影响新写的哈希**,验旧的按记录里那个。测试调小它,不然每条用例 100ms。 */
  scryptN?: number
  maxAttempts?: number
  lockMs?: number
  sessionTtlMs?: number
}

export function defaultAccountFile(home = process.env.HOME ?? ''): string {
  return `${home}/.dsh/workbench/account.json`
}

export function defaultAccountSessionKeyFile(home = process.env.HOME ?? ''): string {
  return `${home}/.dsh/workbench/account-session.key`
}

function emptyFile(): AccountFile {
  return { version: 1 }
}

function isRecord(value: unknown): value is AccountRecord {
  if (typeof value !== 'object' || value === null) return false
  const raw = value as Record<string, unknown>
  return typeof raw.username === 'string' && raw.username !== ''
    && typeof raw.salt === 'string' && raw.salt !== ''
    && typeof raw.hash === 'string' && raw.hash !== ''
    && typeof raw.created_at === 'string'
}

export async function loadAccountFile(file: string): Promise<AccountFile> {
  let text: string
  try {
    text = await readFile(file, 'utf8')
  }
  catch {
    return emptyFile()
  }
  try {
    const parsed = JSON.parse(text) as Partial<AccountFile> | null
    if (typeof parsed !== 'object' || parsed === null) return emptyFile()
    // 看不懂的记录当成"没注册过"而不是抛:文件坏了要能重新注册,不能把人锁在门外。
    return isRecord(parsed.account) ? { version: 1, account: parsed.account } : emptyFile()
  }
  catch {
    return emptyFile()
  }
}

export async function saveAccountFile(file: string, data: AccountFile, randomHex: (bytes: number) => string): Promise<void> {
  await mkdir(dirname(file), { recursive: true })
  const tmp = `${file}.${randomHex(8)}.tmp`
  await writeFile(tmp, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 })
  await rename(tmp, file)
  // rename 保留 tmp 的权限,但 umask 可能已经放宽过,显式收一次(同 devices.ts)。
  await chmod(file, 0o600)
}

/** 用户名:去空白、1–32 字符、不含控制字符与空白。中文可以 —— 这是他自己记的名字。 */
export function normalizeUsername(raw: unknown): { ok: true, value: string } | { ok: false, error: string } {
  if (typeof raw !== 'string') return { ok: false, error: '用户名必须是字符串' }
  const value = raw.trim()
  if (value === '') return { ok: false, error: '用户名不能是空的' }
  if (value.length > USERNAME_MAX) return { ok: false, error: `用户名最多 ${USERNAME_MAX} 个字符` }
  if (/\s/.test(value)) return { ok: false, error: '用户名里不能有空格' }
  for (const ch of value) {
    const code = ch.codePointAt(0) ?? 0
    if (code < 0x20 || code === 0x7F) return { ok: false, error: '用户名里不能有控制字符' }
  }
  return { ok: true, value }
}

export function checkPassword(raw: unknown): { ok: true, value: string } | { ok: false, error: string } {
  if (typeof raw !== 'string') return { ok: false, error: '密码必须是字符串' }
  if (raw.length < PASSWORD_MIN) return { ok: false, error: `密码至少 ${PASSWORD_MIN} 位` }
  if (raw.length > PASSWORD_MAX) return { ok: false, error: `密码最多 ${PASSWORD_MAX} 位` }
  return { ok: true, value: raw }
}

function b64url(text: string): string {
  return Buffer.from(text, 'utf8').toString('base64url')
}

function unb64url(text: string): string | undefined {
  try {
    return Buffer.from(text, 'base64url').toString('utf8')
  }
  catch {
    return undefined
  }
}

function sameString(a: string, b: string): boolean {
  const ba = Buffer.from(a, 'utf8')
  const bb = Buffer.from(b, 'utf8')
  return ba.length === bb.length && timingSafeEqual(ba, bb)
}

/**
 * `Cookie:` 头里挑出我们那一段。没有就 undefined。
 * 只认完全相等的名字 —— 前缀撞名(`ben_wb_account_x`)不该被当成我们的。
 */
export function tokenFromCookieHeader(header: string | string[] | undefined): string | undefined {
  const text = Array.isArray(header) ? header.join('; ') : header
  if (typeof text !== 'string' || text === '') return undefined
  for (const part of text.split(';')) {
    const eq = part.indexOf('=')
    if (eq < 0) continue
    if (part.slice(0, eq).trim() !== ACCOUNT_COOKIE) continue
    const value = part.slice(eq + 1).trim()
    return value === '' ? undefined : value
  }
  return undefined
}

/**
 * 种 cookie 的那一行。
 *
 * - `HttpOnly`:页面脚本读不到它 —— 这是它比 localStorage 强的地方。
 * - `SameSite=Lax`:工作台页面在 127.0.0.1:3080,服务在 127.0.0.1:8791 —— **同站不同源**
 *   (SameSite 看的是站点,端口不算),所以 Lax 照样带得上;跨源那一半由 CORS 的
 *   `Access-Control-Allow-Credentials` 负责。用 `localhost:3080` 打开就变成跨站了,
 *   cookie 带不上 —— 界面会说一句"换 127.0.0.1 打开",不做无声失败。
 * - 没有 `Secure`:这是一条 http 的本机服务,加了反而种不上。
 */
export function accountCookieHeader(token: string, maxAgeSec: number): string {
  return `${ACCOUNT_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${Math.max(0, Math.floor(maxAgeSec))}`
}

export function clearedAccountCookieHeader(): string {
  return `${ACCOUNT_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`
}

export function createAccountService(options: AccountServiceOptions): AccountService {
  const now = options.now ?? Date.now
  const randomHex = options.randomHex ?? ((bytes: number) => randomBytes(bytes).toString('hex'))
  const scryptN = options.scryptN ?? SCRYPT_N
  const maxAttempts = options.maxAttempts ?? MAX_ATTEMPTS
  const lockMs = options.lockMs ?? LOCK_MS

  let attempts = 0
  let lockedUntilMs: number | undefined
  // cookie 的签名与本机账号是两件事(2026-09-21 抽出来的那个),服务器账号那条路用同一把。
  const signer = createSessionSigner({
    keyFile: options.keyFile,
    ...(options.now === undefined ? {} : { now: options.now }),
    ...(options.randomHex === undefined ? {} : { randomHex: options.randomHex }),
    ...(options.sessionTtlMs === undefined ? {} : { sessionTtlMs: options.sessionTtlMs }),
  })

  let writeQueue: Promise<void> = Promise.resolve()
  function enqueueWrite<T>(task: () => Promise<T>): Promise<T> {
    const result = writeQueue.then(task)
    writeQueue = result.then(() => undefined, () => undefined)
    return result
  }

  function locked(): number | undefined {
    if (lockedUntilMs === undefined) return undefined
    if (lockedUntilMs <= now()) {
      lockedUntilMs = undefined
      attempts = 0
      return undefined
    }
    return lockedUntilMs
  }

  function lockedResult(until: number): AccountResult {
    return {
      ok: false, status: 429, error: '密码连续错 5 次,10 分钟内不再接受登录',
      locked_until: new Date(until).toISOString(),
    }
  }

  /** 错一次。到了上限就上锁(锁的同时把计数归零,同 devices.ts)。 */
  function noteWrong(message: string): AccountResult {
    attempts += 1
    if (attempts >= maxAttempts) {
      lockedUntilMs = now() + lockMs
      attempts = 0
      return lockedResult(lockedUntilMs)
    }
    return { ok: false, status: 401, error: message }
  }

  async function derive(password: string, salt: string, n: number): Promise<string> {
    const buf = await scrypt(password, salt, KEYLEN, {
      N: n, r: SCRYPT_R, p: SCRYPT_P, maxmem: 256 * n * SCRYPT_R,
    })
    return buf.toString('hex')
  }

  function sidOf(record: AccountRecord): string {
    return createHash('sha256').update(record.hash, 'utf8').digest('hex').slice(0, 16)
  }

  async function issue(record: AccountRecord): Promise<{ token: string, expires_at: string }> {
    return signer.issue(record.username, sidOf(record))
  }

  async function verify(token?: string): Promise<{ username: string } | undefined> {
    const opened = await signer.open(token)
    if (opened === undefined) return undefined
    const { account } = await loadAccountFile(options.file)
    if (account === undefined || account.username !== opened.subject) return undefined
    // 改过密码的旧 cookie 在这里断掉:sid 绑的是当前口令哈希。
    if (sidOf(account) !== opened.sid) return undefined
    return { username: opened.subject }
  }

  return {
    lockedUntil() {
      const until = locked()
      return until === undefined ? undefined : new Date(until).toISOString()
    },

    async reset() {
      await saveAccountFile(options.file, { version: 1 }, randomHex)
      // 旧 cookie 全部作废:签名密钥换一把(下次要用时重新生成)。
      await signer.reset()
      attempts = 0
      lockedUntilMs = undefined
    },

    async view(token) {
      const { account } = await loadAccountFile(options.file)
      const who = await verify(token)
      const until = locked()
      return {
        registered: account !== undefined,
        logged_in: who !== undefined,
        ...(account === undefined ? {} : { username: account.username }),
        ...(until === undefined ? {} : { locked_until: new Date(until).toISOString() }),
      }
    },

    verify,

    async login(input) {
      const until = locked()
      if (until !== undefined) return lockedResult(until)
      const { account } = await loadAccountFile(options.file)
      if (account === undefined) return { ok: false, status: 409, error: '这台机器还没有账号,先注册一个' }
      const name = normalizeUsername(input.username)
      if (!name.ok) return { ok: false, status: 400, error: name.error }
      if (typeof input.password !== 'string' || input.password === '') {
        return { ok: false, status: 400, error: '密码不能是空的' }
      }
      const hash = await derive(input.password, account.salt, account.n ?? SCRYPT_N)
      // 用户名错与密码错回同一句 —— 分开说等于告诉人"用户名猜对了"。
      if (name.value !== account.username || !sameString(hash, account.hash)) {
        return noteWrong('用户名或密码不对')
      }
      attempts = 0
      const issued = await issue(account)
      return { ok: true, username: account.username, ...issued }
    },

    async register(input) {
      const until = locked()
      if (until !== undefined) return lockedResult(until)
      const { account } = await loadAccountFile(options.file)
      const password = checkPassword(input.password)
      if (!password.ok) return { ok: false, status: 400, error: password.error }
      if (input.confirm !== undefined && input.confirm !== input.password) {
        return { ok: false, status: 400, error: '两次输入的密码不一样' }
      }

      // ① 还没有账号:随便注册,注册完直接算登录(Ben:「自己记得住就行」)。
      if (account === undefined) {
        const name = normalizeUsername(input.username)
        if (!name.ok) return { ok: false, status: 400, error: name.error }
        const salt = randomHex(16)
        const record: AccountRecord = {
          username: name.value,
          salt,
          hash: await derive(password.value, salt, scryptN),
          n: scryptN,
          created_at: new Date(now()).toISOString(),
        }
        await enqueueWrite(() => saveAccountFile(options.file, { version: 1, account: record }, randomHex))
        const issued = await issue(record)
        return { ok: true, username: record.username, ...issued }
      }

      // ② 已经有账号:只有登录着的人能改密码,且要说得出当前密码。
      const who = await verify(input.token)
      if (who === undefined) {
        return { ok: false, status: 403, error: '这台电脑已经有账号了,请登录;忘了密码就在登录页点「重置账号,重新注册」' }
      }
      if (typeof input.current_password !== 'string' || input.current_password === '') {
        return { ok: false, status: 400, error: '改密码要先输入当前密码' }
      }
      const currentHash = await derive(input.current_password, account.salt, account.n ?? SCRYPT_N)
      if (!sameString(currentHash, account.hash)) return noteWrong('当前密码不对')
      attempts = 0
      const salt = randomHex(16)
      const next: AccountRecord = {
        ...account,
        salt,
        hash: await derive(password.value, salt, scryptN),
        n: scryptN,
        updated_at: new Date(now()).toISOString(),
      }
      await enqueueWrite(() => saveAccountFile(options.file, { version: 1, account: next }, randomHex))
      // 改完重发一张:旧 cookie 的 sid 已经对不上了,不重发等于把自己踢下线。
      const issued = await issue(next)
      return { ok: true, username: next.username, ...issued }
    },
  }
}
