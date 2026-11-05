/**
 * 账号搬到服务器(2026-09-21)。这个文件是**同一个 `AccountService` 接口的第二种实现**:
 * 登录态判在中转,cookie 仍然在本机签。http.ts 那一段路由一个字都不用改。
 *
 * ## 钥匙与令牌往哪儿走
 *
 * ```
 *   浏览器  ──(用户名 + 密码,只在这一次请求里)──▶  8791 工作台
 *      ▲                                              │
 *      │  ben_wb_account cookie(HttpOnly,本机签)      │  email_or_phone + password
 *      │  —— 服务器那张会话令牌永远不进浏览器            ▼
 *      └──────────────────────────────────  中转 /v1/account/login
 *                                                     │
 *                             会话令牌 wbs_…(长期、可吊销)
 *                                                     ▼
 *                        ~/.dsh/workbench/account-server.json(0600)
 *                                                     │
 *                             凭它领设备令牌 ──▶ 凭设备令牌签进房凭证
 * ```
 *
 * cookie 的 `sid` 绑的是**服务器会话令牌的哈希前 16 位**:在别处点了「移除这台设备」
 * 或者改了密码,服务器那张一失效,这台的 cookie 下一次验就断 —— 不用另存一张表。
 *
 * ## 三条不能破的规矩
 *
 * 1. **密码不落本机**。迁移完之后 account.json 里那份哈希被抹掉,只留一个"这台迁过了"的记号。
 * 2. **服务器不可达 ≠ 登出**。手上有会话令牌就照样算登录着(`/v1/account/me` 只在后台顺带问);
 *    只有服务器**明确说** 401 才下线。把网络抖动翻译成"你被登出了"是最伤人的一种错。
 * 3. **服务器没有账号服务时,一个字都不改地退回本机账号**(local)。任务卡原话:
 *    「不能把现在能用的登录搞坏」。
 *
 * ## 无痛迁移(Ben 那台)
 *
 * 他那台上已经有一份本机账号(account.json 里是 scrypt 哈希,密码本人记得)。
 * 登录时:
 *   ① 先拿这对用户名密码去中转登录 →
 *   ② 中转说"没这个账号/密码不对",而**本机那份恰好验得过** →
 *   ③ 就用这一对去中转注册一次,然后把本机那份密码哈希抹掉。
 * 于是他什么都不用做,照旧输一次自己的用户名密码,账号就在服务器上了。
 *
 * ②③ 之间那个"本机验得过"是关键:没有它,任何人在任何一台机器上输一对新密码
 * 都会被当成迁移,等于把注册伪装成登录。
 */
import { chmod, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { createHash, randomBytes } from 'node:crypto'
import { dirname } from 'node:path'
import {
  SESSION_TTL_MS, checkPassword, createSessionSigner, loadAccountFile, normalizeUsername, saveAccountFile,
  type AccountResult, type AccountService, type AccountView, type SessionSigner,
} from './account.ts'
import {
  relayChangePassword, relayDevices, relayLogin, relayLogout, relayMe, relayRegister, relayRegisterDevice,
  relayRevokeDevice, type RelayCall, type RelayDevice,
} from './relayAccountApi.ts'

/** 服务器登录态落在哪。`~/.dsh/workbench/account-server.json`,0600,与 credentials.json 同规格。 */
export function defaultServerAccountFile(home = process.env.HOME ?? ''): string {
  return `${home}/.dsh/workbench/account-server.json`
}

/**
 * 存着的那一份。**只有这一个文件里有服务器会话令牌**,而且它 0600、不进任何回包、不进日志。
 */
export interface ServerSessionFile {
  version: 1
  /**
   * 上一次在这台机器上登录的是谁。**登出之后仍然留着** —— 登录页拿它当"这台注册过了"的依据,
   * 于是退出登录之后回到的是**登录**页而不是注册页(那是两件完全不同的事)。
   * 它不是秘密:用户名本来就要显示在登录框里。
   */
  last_identifier?: string
  session?: {
    /** 登录用的邮箱/手机号(或者迁过来的那个用户名)。不是秘密,界面要显示它。 */
    identifier: string
    account_id: string
    /** 会话令牌。**永远不出这个文件**。 */
    token: string
    saved_at: string
  }
}

/** 「我的设备」那一节要的东西。`current` 是这台电脑自己。 */
export interface DeviceListView {
  devices: (RelayDevice & { current?: boolean })[]
}

/** 服务器账号比本机账号多出来的几件事。http.ts 按 `undefined` 判断要不要开那几条路由。 */
export interface ServerAccountExtras {
  /** 我名下有哪几台设备。没登录 / 服务器不可达时回一句人话。 */
  devices: () => Promise<{ ok: true, view: DeviceListView } | { ok: false, error: string }>
  /** 移除一台设备(它的设备令牌当场失效)。 */
  revokeDevice: (deviceId: string) => Promise<{ ok: true, view: DeviceListView } | { ok: false, error: string }>
  /** 登出:把服务器那张会话吊销,本机那份记录删掉。「重置账号」走的也是它。 */
  logout: () => Promise<void>
  /**
   * 此刻这台机器手上那张会话令牌。**只给 modelService 用**(它要凭它去领设备令牌);
   * 不进任何 HTTP 回包。没登录就是 undefined。
   */
  sessionToken: () => Promise<string | undefined>
  /**
   * 此刻登录的这个账号在中转设备表里的那个 scope:`acct:<账号 id>`(2026-09-27,卡 RM)。
   *
   * **房间名就是由这一串算的**(relay/server/channel.cjs 的 `channelRoomOf`),所以
   * modelService 拿它比对「这台机器手上那把令牌是不是这个账号的」。没登录就是 undefined。
   * 它不是秘密(账号 id 已经在「我的设备」那一条里露过面),但也不进任何回包 —— 没人要看它。
   */
  accountScope: () => Promise<string | undefined>
}

/**
 * 账号 id → 中转设备表里的那个 scope。**必须与 relay/server/accounts.cjs 的
 * `accountScopeOf` 拼出来的一样**(那边同名同形)。
 */
export function relayAccountScopeOf(accountId: string): string {
  return `acct:${accountId}`
}

export type ServerAccountService = AccountService & ServerAccountExtras

export interface ServerAccountOptions {
  /** 退路:这台服务器没有账号服务时用的本机账号(现有那一份,一个字没改)。 */
  local: AccountService
  /** ~/.dsh/workbench/account.json —— 迁移时读它、迁完抹掉里面的密码。 */
  localFile: string
  /** ~/.dsh/workbench/account-server.json */
  sessionFile: string
  /** ~/.dsh/workbench/account-session.key —— cookie 的签名密钥,与本机那份**共用**。 */
  keyFile: string
  /** 中转地址。从 model.json 读(用户可以改),所以是个函数不是常量。 */
  relayUrl: () => Promise<string>
  /** 这台电脑叫什么(显示在「我的设备」里)。 */
  deviceName?: () => Promise<string | undefined>
  /** 登录成功之后顺手把这台设备也挂到账号下。失败不影响登录(与 0918 那条同一口径)。 */
  onLoggedIn?: () => void
  fetchImpl?: typeof fetch
  now?: () => number
  randomHex?: (bytes: number) => string
  sessionTtlMs?: number
}

async function loadSessionFile(file: string): Promise<ServerSessionFile> {
  let text: string
  try { text = await readFile(file, 'utf8') }
  catch { return { version: 1 } }
  try {
    const parsed = JSON.parse(text) as Partial<ServerSessionFile> | null
    const last = typeof parsed?.last_identifier === 'string' && parsed.last_identifier !== ''
      ? { last_identifier: parsed.last_identifier }
      : {}
    const session = parsed?.session
    if (typeof session?.identifier !== 'string' || session.identifier === '') return { version: 1, ...last }
    if (typeof session.token !== 'string' || session.token === '') return { version: 1, ...last }
    return {
      version: 1,
      ...last,
      session: {
        identifier: session.identifier,
        account_id: typeof session.account_id === 'string' ? session.account_id : '',
        token: session.token,
        saved_at: typeof session.saved_at === 'string' ? session.saved_at : '',
      },
    }
  }
  catch {
    // 文件坏了当成"没登录",而不是抛:坏文件不该把人锁在门外(同 loadAccountFile)。
    return { version: 1 }
  }
}

async function saveSessionFile(file: string, data: ServerSessionFile, randomHex: (bytes: number) => string): Promise<void> {
  await mkdir(dirname(file), { recursive: true })
  const tmp = `${file}.${randomHex(8)}.tmp`
  await writeFile(tmp, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 })
  await rename(tmp, file)
  // rename 保留 tmp 的权限,但 umask 可能已经放宽过,显式收一次(同 account.ts)。
  await chmod(file, 0o600)
}

/** cookie 的 sid:服务器会话令牌的哈希前 16 位。服务器那张一失效,这张 cookie 下一次验就断。 */
function sidOfSession(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex').slice(0, 16)
}

/** 中转拒绝时的状态码 → AccountResult 的那几档。认不出的一律 400。 */
function statusOf(status: number): 400 | 401 | 403 | 409 | 429 {
  if (status === 401 || status === 403 || status === 409 || status === 429) return status
  return 400
}

function rejected<T>(result: Extract<RelayCall<T>, { ok: false, unsupported: false }>): AccountResult {
  return { ok: false, status: statusOf(result.status), error: result.error }
}

export function createServerAccountService(options: ServerAccountOptions): ServerAccountService {
  const fetchImpl = options.fetchImpl ?? fetch
  const randomHex = options.randomHex ?? ((bytes: number) => randomBytes(bytes).toString('hex'))
  const signer: SessionSigner = createSessionSigner({
    keyFile: options.keyFile,
    ...(options.now === undefined ? {} : { now: options.now }),
    ...(options.randomHex === undefined ? {} : { randomHex: options.randomHex }),
    ...(options.sessionTtlMs === undefined ? {} : { sessionTtlMs: options.sessionTtlMs }),
  })

  /** 中转那边明确说过的"锁到什么时候"。只给界面看一眼,判断仍然在服务器那边。 */
  let lockedUntilText: string | undefined

  async function session(): Promise<ServerSessionFile['session']> {
    return (await loadSessionFile(options.sessionFile)).session
  }

  /** 上一次在这台登录的是谁(登出之后仍然记得)。 */
  async function lastIdentifier(): Promise<string | undefined> {
    return (await loadSessionFile(options.sessionFile)).last_identifier
  }

  async function relay(): Promise<string> {
    return options.relayUrl()
  }

  async function store(identifier: string, accountId: string, token: string): Promise<{ token: string, expires_at: string }> {
    await saveSessionFile(options.sessionFile, {
      version: 1,
      last_identifier: identifier,
      session: { identifier, account_id: accountId, token, saved_at: new Date(options.now?.() ?? Date.now()).toISOString() },
    }, randomHex)
    return signer.issue(identifier, sidOfSession(token))
  }

  /**
   * 迁移那一刀:把本机 account.json 里的密码哈希抹掉,只留一个记号。
   *
   * **留着用户名**:登录页要拿它当"注册过了"的依据,而它本来就不是秘密。
   * 抹掉的是 salt 与 hash —— 从这一刻起,这台机器上没有任何能验密码的东西。
   */
  async function clearLocalSecret(): Promise<void> {
    const { account } = await loadAccountFile(options.localFile)
    if (account === undefined) return
    await saveAccountFile(options.localFile, { version: 1 }, randomHex)
  }

  /**
   * 服务器那边已经没有这张会话了:删掉令牌 + 换签名密钥(所有 cookie 当场作废)。
   * **只留「上一次是谁」那一行**,理由见 ServerSessionFile.last_identifier。
   */
  async function forget(): Promise<void> {
    const remembered = await lastIdentifier()
    if (remembered === undefined) {
      try { await rm(options.sessionFile, { force: true }) } catch { /* 没有就没有 */ }
    }
    else {
      await saveSessionFile(options.sessionFile, { version: 1, last_identifier: remembered }, randomHex)
    }
    await signer.reset()
  }

  async function whoAmI(token?: string): Promise<{ identifier: string, accountId: string, session: string } | undefined> {
    const current = await session()
    if (current === undefined) return undefined
    const opened = await signer.open(token)
    if (opened === undefined) return undefined
    if (opened.subject !== current.identifier) return undefined
    if (opened.sid !== sidOfSession(current.token)) return undefined
    return { identifier: current.identifier, accountId: current.account_id, session: current.token }
  }

  /** 「我的设备」两条路共用的那一段:要登录、要服务器在。 */
  async function withSession<T>(
    run: (input: { relayUrl: string, session: string }) => Promise<RelayCall<T>>,
  ): Promise<{ ok: true, value: T } | { ok: false, error: string }> {
    const current = await session()
    if (current === undefined) return { ok: false, error: '还没登录账号,先登录再看设备列表。' }
    const result = await run({ relayUrl: await relay(), session: current.token })
    if (result.ok) return { ok: true, value: result.value }
    if (!result.unsupported && result.status === 401) {
      // 服务器**明确说**这张不认了(在别处移除了这台设备 / 改了密码)。这时候才真下线。
      await forget()
      return { ok: false, error: '登录已经失效了(可能是在别的设备上把这台移除了)。重新登录一次就好。' }
    }
    return { ok: false, error: result.error }
  }

  function toListView(devices: RelayDevice[], selfId?: string): DeviceListView {
    return {
      devices: devices.map(device => ({
        ...device,
        ...(selfId !== undefined && device.device_id === selfId ? { current: true } : {}),
      })),
    }
  }

  /** 这台电脑自己的 device_id(model.json 里那个)。拿不到就算了,只影响「这一台」标记。 */
  let selfDeviceId: string | undefined
  function noteSelfDeviceId(id: string | undefined): void { selfDeviceId = id }

  const service: ServerAccountService = {
    lockedUntil() {
      return lockedUntilText
    },

    async view(token) {
      const current = await session()
      if (current === undefined) {
        const remembered = await lastIdentifier()
        if (remembered !== undefined) {
          // 登出过,但这台记得上一次是谁 —— 回登录页,不是注册页。
          return {
            registered: true,
            logged_in: false,
            username: remembered,
            on_server: true,
            ...(lockedUntilText === undefined ? {} : { locked_until: lockedUntilText }),
          } as AccountView
        }
        // 还没在服务器上登录过:本机那份说了算(它可能正好是一台还没迁移的老机器)。
        const local = await options.local.view(token)
        const noRelay = (await relay()).trim() === ''
        return { ...local, on_server: false, ...(noRelay ? { relay_configured: false } : {}) } as AccountView
      }
      const who = await whoAmI(token)
      return {
        registered: true,
        logged_in: who !== undefined,
        username: current.identifier,
        on_server: true,
        ...(lockedUntilText === undefined ? {} : { locked_until: lockedUntilText }),
      } as AccountView
    },

    async verify(token) {
      const who = await whoAmI(token)
      if (who !== undefined) return { username: who.identifier }
      // 服务器那份不认,再问本机那份 —— 还没迁移的机器走这条。
      if ((await session()) !== undefined) return undefined
      return options.local.verify(token)
    },

    async login(input) {
      const name = normalizeUsername(input.username)
      if (!name.ok) return { ok: false, status: 400, error: name.error }
      if (typeof input.password !== 'string' || input.password === '') {
        return { ok: false, status: 400, error: '密码不能是空的' }
      }
      const relayUrl = await relay()
      const attempt = await relayLogin({ relayUrl, identifier: name.value, password: input.password, fetchImpl })

      if (attempt.ok) {
        lockedUntilText = undefined
        const issued = await store(attempt.value.account.email_or_phone, attempt.value.account.id, attempt.value.session_token)
        // 迁过来的机器上,本机那份密码从此没有存在的理由。
        await clearLocalSecret()
        options.onLoggedIn?.()
        return { ok: true, username: attempt.value.account.email_or_phone, ...issued }
      }

      if (attempt.unsupported) {
        // 这台服务器没有账号服务 / 连不上 → 退回本机账号,一个字都不改。
        return options.local.login(input)
      }

      if (attempt.status === 429) {
        lockedUntilText = new Date((options.now?.() ?? Date.now()) + 10 * 60_000).toISOString()
        return { ok: false, status: 429, error: attempt.error, locked_until: lockedUntilText }
      }

      // 服务器说"没这个账号 / 密码不对"。**只有本机那份恰好验得过**,才当成迁移。
      if (attempt.status === 401) {
        const migrated = await migrate(name.value, input.password, relayUrl)
        if (migrated !== undefined) return migrated
      }
      return rejected(attempt)
    },

    async register(input) {
      const password = checkPassword(input.password)
      if (!password.ok) return { ok: false, status: 400, error: password.error }
      if (input.confirm !== undefined && input.confirm !== input.password) {
        return { ok: false, status: 400, error: '两次输入的密码不一样' }
      }

      const current = await session()
      const relayUrl = await relay()

      // ② 已经登录着 = 改密码(AccountPanel 那颗按钮走的就是这条,与本机那份同一个分岔)。
      if (current !== undefined) {
        const who = await whoAmI(input.token)
        if (who === undefined) {
          return { ok: false, status: 403, error: '这台电脑已经有账号了,请登录;忘了密码就在登录页点「重置账号,重新注册」' }
        }
        if (typeof input.current_password !== 'string' || input.current_password === '') {
          return { ok: false, status: 400, error: '改密码要先输入当前密码' }
        }
        const changed = await relayChangePassword({
          relayUrl, session: who.session, currentPassword: input.current_password, password: password.value, fetchImpl,
        })
        if (!changed.ok) {
          if (changed.unsupported) return { ok: false, status: 400, error: changed.error }
          return rejected(changed)
        }
        // 改完那张会话还是好的(服务器只撤了别处的),cookie 也不用换 —— sid 绑的是令牌不是密码。
        const issued = await signer.issue(who.identifier, sidOfSession(who.session))
        return { ok: true, username: who.identifier, ...issued }
      }

      // ① 还没有账号:去服务器注册一个。
      const name = normalizeUsername(input.username)
      if (!name.ok) return { ok: false, status: 400, error: name.error }
      const created = await relayRegister({ relayUrl, identifier: name.value, password: password.value, fetchImpl })
      if (created.ok) {
        const issued = await store(created.value.account.email_or_phone, created.value.account.id, created.value.session_token)
        await clearLocalSecret()
        options.onLoggedIn?.()
        return { ok: true, username: created.value.account.email_or_phone, ...issued }
      }
      if (created.unsupported) return options.local.register(input)
      return rejected(created)
    },

    /**
     * 「重置账号」在服务器时代 = **本机登出**(任务卡原话)。
     *
     * 为什么不是"把服务器上那个账号删掉":那个账号可能还连着别的设备、别的数据;
     * 一颗写着「重置」的按钮不该有这种后果。它现在的意思很干净:**这台电脑不登了**。
     */
    async reset() {
      await service.logout()
      await options.local.reset()
    },

    /* ── 服务器账号多出来的几条 ── */

    async logout() {
      const current = await session()
      if (current !== undefined) {
        // 吊销失败也照样本地下线:人要的是"我下线了",不是一次成功的 HTTP 请求。
        await relayLogout({ relayUrl: await relay(), session: current.token, fetchImpl }).catch(() => undefined)
      }
      lockedUntilText = undefined
      await forget()
    },

    async sessionToken() {
      return (await session())?.token
    },

    async accountScope() {
      const current = await session()
      return current === undefined ? undefined : relayAccountScopeOf(current.account_id)
    },

    async devices() {
      const result = await withSession(async ({ relayUrl, session: token }) =>
        relayDevices({ relayUrl, session: token, fetchImpl }))
      if (!result.ok) return result
      return { ok: true, view: toListView(result.value.devices, selfDeviceId) }
    },

    async revokeDevice(deviceId) {
      const result = await withSession(async ({ relayUrl, session: token }) =>
        relayRevokeDevice({ relayUrl, session: token, deviceId, fetchImpl }))
      if (!result.ok) return result
      return { ok: true, view: toListView(result.value.devices, selfDeviceId) }
    },
  }

  /**
   * 迁移。只有**本机那份密码验得过**才算数 —— 没有这道门,任何人在任何一台机器上
   * 随便输一对新密码都会被当成"迁移",等于把注册伪装成登录。
   *
   * 验法:调本机那份 `login`。它自己带着"错 5 次锁 10 分钟",所以这一步也是有闸的。
   * 验过了就去服务器注册同一对;注册成功后本机那份密码当场抹掉。
   */
  async function migrate(identifier: string, password: string, relayUrl: string): Promise<AccountResult | undefined> {
    const { account } = await loadAccountFile(options.localFile)
    if (account === undefined) return undefined
    const localOk = await options.local.login({ username: identifier, password })
    if (!localOk.ok) return undefined

    const created = await relayRegister({ relayUrl, identifier, password, fetchImpl })
    if (!created.ok) {
      if (created.unsupported) {
        // 服务器这会儿不行了,但本机那份刚刚验过 —— 那就按本机登录算,别把人挡在外面。
        return localOk
      }
      return rejected(created)
    }
    const issued = await store(created.value.account.email_or_phone, created.value.account.id, created.value.session_token)
    await clearLocalSecret()
    options.onLoggedIn?.()
    return { ok: true, username: created.value.account.email_or_phone, ...issued }
  }

  // modelService 会在领设备令牌时把这台的 device_id 告诉我们(用来在列表里标「这一台」)。
  ;(service as ServerAccountService & { noteSelfDeviceId?: (id: string | undefined) => void })
    .noteSelfDeviceId = noteSelfDeviceId

  return service
}

/** 会话 cookie 活多久,与本机那份同一个数(30 天)。 */
export { SESSION_TTL_MS }

/**
 * 登录成功之后把这台设备挂到账号下。**失败不影响登录**(同 0918「领令牌不挡登录」那一条)。
 * 放在这里而不是 serverAccount 内部,是因为 device_id 归 modelService 管,
 * 而 modelService 不该知道账号这回事 —— 两边由 index.ts 接。
 */
export async function attachDeviceToAccount(input: {
  relayUrl: string
  session: string
  deviceId: string
  name?: string
  kind?: 'mac' | 'phone' | 'windows' | 'other' | 'handset'
  fetchImpl?: typeof fetch
}): Promise<{ ok: true, token: string } | { ok: false, error: string }> {
  const result = await relayRegisterDevice({
    relayUrl: input.relayUrl,
    session: input.session,
    deviceId: input.deviceId,
    ...(input.name === undefined ? {} : { name: input.name }),
    ...(input.kind === undefined ? {} : { kind: input.kind }),
    ...(input.fetchImpl === undefined ? {} : { fetchImpl: input.fetchImpl }),
  })
  if (!result.ok) return { ok: false, error: result.error }
  return { ok: true, token: result.value.token }
}

/** 给 http.ts 用:这是个服务器账号吗(决定要不要开「我的设备」那两条路由)。 */
export function isServerAccount(value: AccountService | undefined): value is ServerAccountService {
  return value !== undefined && typeof (value as ServerAccountService).devices === 'function'
}

export async function relayMeOf(relayUrl: string, sessionToken: string, fetchImpl?: typeof fetch) {
  return relayMe({ relayUrl, session: sessionToken, ...(fetchImpl === undefined ? {} : { fetchImpl }) })
}
