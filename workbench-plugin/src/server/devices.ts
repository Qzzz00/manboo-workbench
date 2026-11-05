/**
 * 手机配对与设备令牌(2026-09-11,设计-事务官完整材料 §2「配对先于账号」;决策记录 2026-09-11 第 1 条)。
 *
 * 流程:工作台设置里点「生成配对码」→ 6 位数字码,5 分钟有效、一次性 → 手机扫码/输码
 * POST /pair/claim → 这里核对 → 写 devices.json → 把**明文令牌返回一次**。之后手机每次
 * 请求带 `Authorization: Bearer <token>`,这里按哈希认人。
 *
 * 纪律:
 * - **本机只存哈希**(sha256)。devices.json 里没有明文,配对那一刻之后本机自己也拿不回令牌;
 *   手机丢了令牌就重新配对。文件 0600,与 credentials.json 同规格。
 * - 配对码与令牌不进日志、不进 /state 之外的任何出口;配对码在 /state.pairing 只给本机来源(http.ts)。
 * - 错码 5 次锁 10 分钟,锁的同时把当前码作废——Ben 得重新生成一次,不留一个「还在猜」的码。
 * - 账号以后再上时,令牌改由账号签发,这一层的 authenticate/list/revoke 不变。
 *
 * 落盘规格同 notes.ts:原子写、容错读、写队列。时钟注入的是**毫秒**(`Date.now` 同款)。
 */
import { createHash, randomBytes, randomInt, randomUUID, timingSafeEqual } from 'node:crypto'
import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { DeviceView } from '../protocol.ts'

export interface DeviceRecord {
  id: string
  name: string
  platform: string
  /** sha256(令牌) 的十六进制。永远不存明文。 */
  tokenHash: string
  createdAt: string
  lastSeenAt: string
  revokedAt?: string
  /**
   * 这次撤销是**为什么**(2026-10-03,卡 claude/device-revoke-complete)。
   *
   * `account` = 从账号的「我的设备」里移除了这台;`local`(缺省)= 在本机解除了配对。
   * 唯一的用处是**那句 401 说什么**:「从账号里移除了」与「还没配对过」是两件事,
   * 而手机会把这句话原样显示给人看(see {@link PairingService.revokedReasonOf})。
   */
  revokedReason?: 'local' | 'account'
  /**
   * 「这台设备在**哪个账号**的设备表里见过」(2026-10-03,同上)。
   *
   * 值是 `acct:<账号 id>`(serverAccount.ts 的 `relayAccountScopeOf`)。签票那一层据此
   * 分得清两件事:**从前在账号里、现在不在了**(= 被移除,拒),与**从来没挂到账号下**
   * (= 纯局域网配对的手机,照旧放行)。判法全文在 server/deviceAccountGate.ts 的文件头。
   *
   * 它不是秘密:账号 id 在「我的设备」那条回包里本来就露过面,这里也不进任何回包。
   */
  accountScope?: string
}

export interface DevicesFile { version: 1, devices: DeviceRecord[] }

/**
 * 设备种类(2026-09-21,座机形态:手机 + 树莓派话筒)。
 *
 * **不新存一个字段**,由配对时报上来的 `platform` 推出来:树莓派上的 phone-bridge
 * 配对时报 `platform: 'handset'`(phone-bridge/pairing.py 的 `PLATFORM_HANDSET`),
 * 别的一律是手机。这样 devices.json 的格式一个字节没变 —— 已经配过的手机不用重配,
 * 也不必写一段「读到旧文件就补字段」的迁移代码(那种代码只跑一次,却要留一辈子)。
 *
 * 这个值有两个去处:设置里「我的设备」把它显示成「话筒」而不是「手机」;
 * 以及签进进房凭证的属性 `wb_kind`(server/channel.ts),工人据此知道
 * **房里那位是一只听筒**,可以当通话的音频端点(docs/设计-座机信号协议-2026-09-21.md)。
 */
export const DEVICE_KIND_HANDSET = 'handset'

export function deviceKindOf(platform: string): 'phone' | 'handset' {
  return platform.trim().toLowerCase() === DEVICE_KIND_HANDSET ? 'handset' : 'phone'
}

export function defaultDevicesFile(home = process.env.HOME ?? ''): string {
  return `${home}/.dsh/workbench/devices.json`
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex')
}

function emptyDevicesFile(): DevicesFile {
  return { version: 1, devices: [] }
}

function isRecord(value: unknown): value is DeviceRecord {
  if (typeof value !== 'object' || value === null) return false
  const raw = value as Record<string, unknown>
  return typeof raw.id === 'string' && typeof raw.name === 'string' && typeof raw.platform === 'string'
    && typeof raw.tokenHash === 'string' && typeof raw.createdAt === 'string' && typeof raw.lastSeenAt === 'string'
    && (raw.revokedAt === undefined || typeof raw.revokedAt === 'string')
    // 这两样宽着验(只看类型):将来多一种撤销原因时,老版本不该因为一个不认识的字符串
    // 把整条配对记录丢掉 —— 那等于让一台好手机突然要重新配对。
    && (raw.revokedReason === undefined || typeof raw.revokedReason === 'string')
    && (raw.accountScope === undefined || typeof raw.accountScope === 'string')
}

export async function loadDevicesFile(file: string): Promise<DevicesFile> {
  let text: string
  try {
    text = await readFile(file, 'utf8')
  }
  catch {
    return emptyDevicesFile()
  }
  try {
    const parsed = JSON.parse(text) as Partial<DevicesFile> | null
    if (typeof parsed !== 'object' || parsed === null || !Array.isArray(parsed.devices)) return emptyDevicesFile()
    // 看不懂的条目丢掉而不是整份作废:一条坏记录不该让所有手机一起掉线。
    return { version: 1, devices: parsed.devices.filter(isRecord) }
  }
  catch {
    return emptyDevicesFile()
  }
}

export async function saveDevicesFile(file: string, data: DevicesFile): Promise<void> {
  await mkdir(dirname(file), { recursive: true })
  const tmp = `${file}.${randomUUID()}.tmp`
  await writeFile(tmp, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 })
  await rename(tmp, file)
  // rename 保留 tmp 的权限,但 umask 可能已经放宽过,显式收一次(同 credentials.ts)。
  await chmod(file, 0o600)
}

export interface PairingCode { code: string, expires_at: string }

export interface ClaimInput { code: string, device_name: string, platform: string }

export type ClaimResult =
  | { ok: true, device_id: string, token: string }
  | { ok: false, status: 400 | 401 | 429, error: string, locked_until?: string }

export interface PairingService {
  /** 生成新码(旧码作废)。只该由本机来源触发——路由层负责挡。 */
  start(): PairingCode
  /** 当前有效的码;过期、用掉、被锁清掉时为 undefined。 */
  current(): PairingCode | undefined
  claim(input: ClaimInput): Promise<ClaimResult>
  /** 按明文令牌认设备;认不出(错、空、已撤销)回 undefined。顺手更新 lastSeenAt(限频一分钟)。 */
  authenticate(token: string): Promise<DeviceView | undefined>
  /** 未撤销的设备,视图字段,没有哈希。 */
  list(): Promise<readonly DeviceView[]>
  /**
   * 通道工人替手机办事时只带设备 id、没有令牌(那条降权的头)—— 它成功替手机访问也算手机在线
   * (2026-10-12,卡 `claude/ops-patch-1012`;运营同学 10-09 撞到的:出门走中转时手机那一行一直「不在线」)。
   * 与 authenticate 同一个一分钟限频,免得每次 /state 轮询都写盘。认不出(没有 / 已撤销)回 undefined。
   * **可选**:老的假服务、测试替身不必实现,路由那一层没有它就退回在 list() 里找。
   */
  touch?(id: string): Promise<DeviceView | undefined>
  /**
   * 解除一台设备的配对:令牌当场作废、落盘,重启不复活。
   *
   * `reason` 只影响**那句 401 说什么**(2026-10-03,卡 claude/device-revoke-complete):
   * `account` = 这一下是「从账号里移除这台设备」带来的,`local`(缺省)= 在本机解除配对。
   */
  revoke(id: string, reason?: 'local' | 'account'): Promise<boolean>
  /**
   * 这台设备(或这把令牌)是被**怎么**撤的(2026-10-03)。两种问法都行:
   * 手机自己带令牌来时只有 `token`,工人替它办事时只有 `id`(那条降权的头)。
   * 认不出、或者它还好着,都回 undefined。
   *
   * 鉴权那一层据此把 401 那句话说准:「这台设备已经从账号里移除了」与「先在设置里配对」
   * 是两件事,而手机把服务端这句话原样显示给人看。**可选**:老的假配对服务没有它,
   * 那时照旧说老那句话。
   */
  revokedReasonOf?(input: { id?: string, token?: string }): Promise<'local' | 'account' | undefined>
  /**
   * 「这台设备在哪个账号的设备表里见过」—— 读 / 写那一笔记号(2026-10-03)。
   * 判法与它为什么存在见 server/deviceAccountGate.ts 的文件头。**可选**,同上。
   */
  accountScopeOf?(id: string): Promise<string | undefined>
  noteAccountScope?(id: string, scope: string): Promise<void>
  /**
   * 改一台设备的名字(2026-09-25,卡 fix/evening-gaps 第 2 条:设置 → 手机与设备 → 改名)。
   * 名字去掉首尾空白、最长 {@link MAX_NAME_LEN} 字;空名字不改。没有这台(或已解除配对)回 false。
   * **可选**:老的假服务、测试替身不必实现,路由那一层没有它就回 404。
   */
  rename?(id: string, name: string): Promise<boolean>
  /** 被锁到什么时候;没锁就是 undefined。设置里显示用。 */
  lockedUntil(): string | undefined
}

export interface PairingServiceOptions {
  file: string
  /** 毫秒时钟,缺省 Date.now。 */
  now?: () => number
  /** 6 位数字码的来源,缺省 crypto.randomInt。测试注入。 */
  randomCode?: () => string
  /** 令牌来源,缺省 32 字节 base64url。测试注入。 */
  randomToken?: () => string
  codeTtlMs?: number
  maxAttempts?: number
  lockMs?: number
  /** lastSeenAt 落盘限频,缺省 60 秒。 */
  seenThrottleMs?: number
}

const CODE_TTL_MS = 5 * 60_000
const MAX_ATTEMPTS = 5
const LOCK_MS = 10 * 60_000
const SEEN_THROTTLE_MS = 60_000
const MAX_NAME_LEN = 64
const MAX_PLATFORM_LEN = 32

function defaultRandomCode(): string {
  return String(randomInt(0, 1_000_000)).padStart(6, '0')
}

function defaultRandomToken(): string {
  return randomBytes(32).toString('base64url')
}

function toView(record: DeviceRecord): DeviceView {
  return {
    id: record.id,
    name: record.name,
    platform: record.platform,
    kind: deviceKindOf(record.platform),
    created_at: record.createdAt,
    last_seen_at: record.lastSeenAt,
  }
}

function sameHash(a: string, b: string): boolean {
  const ba = Buffer.from(a, 'utf8')
  const bb = Buffer.from(b, 'utf8')
  return ba.length === bb.length && timingSafeEqual(ba, bb)
}

export function createPairingService(opts: PairingServiceOptions): PairingService {
  const now = opts.now ?? Date.now
  const randomCode = opts.randomCode ?? defaultRandomCode
  const randomToken = opts.randomToken ?? defaultRandomToken
  const codeTtlMs = opts.codeTtlMs ?? CODE_TTL_MS
  const maxAttempts = opts.maxAttempts ?? MAX_ATTEMPTS
  const lockMs = opts.lockMs ?? LOCK_MS
  const seenThrottleMs = opts.seenThrottleMs ?? SEEN_THROTTLE_MS

  let active: { code: string, expiresAtMs: number } | undefined
  let attempts = 0
  let lockedUntilMs: number | undefined

  let writeQueue: Promise<void> = Promise.resolve()
  function enqueueWrite<T>(task: () => Promise<T>): Promise<T> {
    const result = writeQueue.then(task)
    writeQueue = result.then(() => undefined, () => undefined)
    return result
  }

  function current(): PairingCode | undefined {
    if (active === undefined) return undefined
    if (active.expiresAtMs <= now()) {
      active = undefined
      return undefined
    }
    return { code: active.code, expires_at: new Date(active.expiresAtMs).toISOString() }
  }

  /** 这台刚露过面:lastSeenAt 限频落盘(authenticate 与 touch 同一条)。改的是传进来的那条记录,所以回去的视图已经是新时刻。 */
  async function noteSeen(found: DeviceRecord): Promise<void> {
    const nowMs = now()
    if (nowMs - Date.parse(found.lastSeenAt) < seenThrottleMs) return
    const seen = new Date(nowMs).toISOString()
    found.lastSeenAt = seen
    await enqueueWrite(async () => {
      const fresh = await loadDevicesFile(opts.file)
      const target = fresh.devices.find(device => device.id === found.id)
      if (target === undefined || target.revokedAt !== undefined) return
      target.lastSeenAt = seen
      await saveDevicesFile(opts.file, fresh)
    })
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

  function noteWrongCode(): ClaimResult {
    attempts += 1
    if (attempts >= maxAttempts) {
      lockedUntilMs = now() + lockMs
      attempts = 0
      active = undefined // 锁的同时作废当前码:不留一个「还在被猜」的码。
      return {
        ok: false, status: 429, error: '配对码连续错 5 次,10 分钟内不再接受配对',
        locked_until: new Date(lockedUntilMs).toISOString(),
      }
    }
    return { ok: false, status: 401, error: '配对码不对或已失效' }
  }

  return {
    start() {
      const code = randomCode()
      active = { code, expiresAtMs: now() + codeTtlMs }
      return { code, expires_at: new Date(active.expiresAtMs).toISOString() }
    },

    current,

    lockedUntil() {
      const until = locked()
      return until === undefined ? undefined : new Date(until).toISOString()
    },

    async claim(input) {
      const name = input.device_name.trim()
      const platform = input.platform.trim()
      if (name === '' || name.length > MAX_NAME_LEN) return { ok: false, status: 400, error: 'device_name 必须是 1–64 个字符' }
      if (platform === '' || platform.length > MAX_PLATFORM_LEN) return { ok: false, status: 400, error: 'platform 必须是 1–32 个字符' }
      if (!/^\d{6}$/.test(input.code)) return { ok: false, status: 400, error: 'code 必须是 6 位数字' }

      const until = locked()
      if (until !== undefined) {
        return {
          ok: false, status: 429, error: '配对码连续错 5 次,10 分钟内不再接受配对',
          locked_until: new Date(until).toISOString(),
        }
      }
      const live = current()
      if (live === undefined || live.code !== input.code) return noteWrongCode()

      // 对了:码一次性,先作废再落盘,落盘失败也不给第二次机会用同一个码。
      active = undefined
      attempts = 0
      const token = randomToken()
      const at = new Date(now()).toISOString()
      const record: DeviceRecord = {
        id: randomUUID(), name, platform, tokenHash: hashToken(token), createdAt: at, lastSeenAt: at,
      }
      await enqueueWrite(async () => {
        const data = await loadDevicesFile(opts.file)
        data.devices.push(record)
        await saveDevicesFile(opts.file, data)
      })
      return { ok: true, device_id: record.id, token }
    },

    async authenticate(token) {
      if (token === '') return undefined
      const hash = hashToken(token)
      const data = await loadDevicesFile(opts.file)
      const found = data.devices.find(device => device.revokedAt === undefined && sameHash(device.tokenHash, hash))
      if (found === undefined) return undefined
      await noteSeen(found)
      return toView(found)
    },

    async touch(id) {
      const data = await loadDevicesFile(opts.file)
      const found = data.devices.find(device => device.id === id && device.revokedAt === undefined)
      if (found === undefined) return undefined
      await noteSeen(found)
      return toView(found)
    },

    async list() {
      const data = await loadDevicesFile(opts.file)
      return data.devices.filter(device => device.revokedAt === undefined).map(toView)
    },

    revoke(id, reason = 'local') {
      return enqueueWrite(async () => {
        const data = await loadDevicesFile(opts.file)
        const target = data.devices.find(device => device.id === id && device.revokedAt === undefined)
        if (target === undefined) return false
        target.revokedAt = new Date(now()).toISOString()
        target.revokedReason = reason
        await saveDevicesFile(opts.file, data)
        return true
      })
    },

    async revokedReasonOf(input) {
      const token = input.token ?? ''
      const id = input.id ?? ''
      if (token === '' && id === '') return undefined
      const hash = token === '' ? '' : hashToken(token)
      const data = await loadDevicesFile(opts.file)
      // 撤销过的记录**留在文件里**(authenticate 只是跳过它们),所以这里认得出这把钥匙
      // 曾经是谁的、是怎么作废的。没有这一步,那句 401 只能说一句含糊的「先去配对」。
      const found = data.devices.find(device => device.revokedAt !== undefined
        && (id !== '' ? device.id === id : sameHash(device.tokenHash, hash)))
      if (found === undefined) return undefined
      return found.revokedReason === 'account' ? 'account' : 'local'
    },

    async accountScopeOf(id) {
      const data = await loadDevicesFile(opts.file)
      return data.devices.find(device => device.id === id)?.accountScope
    },

    noteAccountScope(id, scope) {
      return enqueueWrite(async () => {
        const data = await loadDevicesFile(opts.file)
        const target = data.devices.find(device => device.id === id && device.revokedAt === undefined)
        // 没变就不写:签票那一层每次都会报一遍,没必要每次都落一次盘。
        if (target === undefined || target.accountScope === scope) return
        target.accountScope = scope
        await saveDevicesFile(opts.file, data)
      })
    },

    rename(id, name) {
      const clean = name.trim().slice(0, MAX_NAME_LEN)
      if (clean === '') return Promise.resolve(false)
      return enqueueWrite(async () => {
        const data = await loadDevicesFile(opts.file)
        const target = data.devices.find(device => device.id === id && device.revokedAt === undefined)
        if (target === undefined) return false
        target.name = clean
        await saveDevicesFile(opts.file, data)
        return true
      })
    },
  }
}
