/**
 * 中转账号那几条路的客户端(2026-09-21)。只管说话,不管存;存在 serverAccount.ts。
 *
 * 一条纪律压过其他所有:**「服务器上没有账号这回事」与「密码不对」是两件完全不同的事**。
 *
 * - 没有账号这回事(404、连不上、回的不是 JSON)→ `unsupported` → 上层退回本机账号。
 *   这正是任务卡那句「不能把现在能用的登录搞坏」:中转还没部署这一版时,Ben 那台照样登得进去。
 * - 密码不对(401 `bad_credentials`)→ `rejected` → 上层要么报错,要么走迁移那一支。
 *
 * 把这两件事混成一个 `catch`,结果会是"服务器一抖动就把人踢回本机账号,而本机那份密码
 * 已经在迁移时删掉了" —— 那是这条链路上最糟的一种失败。
 *
 * 令牌纪律:会话令牌只出现在请求头与 serverAccount 那个 0600 文件里,
 * **不进日志、不进任何回包、不进 URL**。
 */

/** 服务器那边的账号长什么样(`/v1/account/me` 的回包)。**没有哈希、没有盐**。 */
export interface RelayAccount {
  id: string
  email_or_phone: string
  created_at: string
  devices?: number
}

/** 「我的设备」里一行。**没有令牌** —— 令牌明文这辈子只在领的那一刻出现过一次。 */
export interface RelayDevice {
  device_id: string
  name?: string
  kind: string
  created_at: string
  last_seen_at?: string
}

/**
 * 每条路的回答。三支,对应三种完全不同的下一步:
 * - `ok`:成了;
 * - `unsupported`:这台中转没有账号这回事(或者压根连不上)→ 退回本机;
 * - `rejected`:服务器认真地拒绝了,`error` 是**服务器自己的那句人话**,原样显示给用户。
 */
export type RelayCall<T> =
  | { ok: true, value: T }
  | { ok: false, unsupported: true, error: string }
  | { ok: false, unsupported: false, status: number, code?: string, error: string }

function trimSlash(value: string): string {
  return value.replace(/\/+$/, '')
}

/** 中转的错误形状是 OpenAI 的 `{ error: { message, code } }`。 */
async function readError(res: Response): Promise<{ message?: string, code?: string }> {
  try {
    const body = await res.json() as { error?: { message?: unknown, code?: unknown } }
    return {
      ...(typeof body.error?.message === 'string' ? { message: body.error.message } : {}),
      ...(typeof body.error?.code === 'string' ? { code: body.error.code } : {}),
    }
  }
  catch {
    return {}
  }
}

async function call<T>(
  input: {
    relayUrl: string
    path: string
    method?: 'GET' | 'POST'
    body?: unknown
    session?: string
    fetchImpl?: typeof fetch
  },
): Promise<RelayCall<T>> {
  // 没接中转(零服务器档):不发,按「这台中转没有账号这回事」退回本机账号。
  if (trimSlash(input.relayUrl) === '') return { ok: false, unsupported: true, error: '这台没接中转,账号只在这台电脑上。' }
  const fetchImpl = input.fetchImpl ?? fetch
  let res: Response
  try {
    res = await fetchImpl(`${trimSlash(input.relayUrl)}${input.path}`, {
      method: input.method ?? 'GET',
      headers: {
        ...(input.body === undefined ? {} : { 'content-type': 'application/json' }),
        ...(input.session === undefined ? {} : { authorization: `Bearer ${input.session}` }),
      },
      ...(input.body === undefined ? {} : { body: JSON.stringify(input.body) }),
    })
  }
  catch {
    // 底层那句话可能把地址、代理细节抖出来,一律换成自己的措辞。
    return { ok: false, unsupported: true, error: '连不上账号服务(网络不通,或者服务器还没部署这一版)。' }
  }
  if (res.status === 404 || res.status === 501) {
    return { ok: false, unsupported: true, error: '这台服务器上还没有账号服务。' }
  }
  if (!res.ok) {
    const { message, code } = await readError(res)
    return {
      ok: false,
      unsupported: false,
      status: res.status,
      ...(code === undefined ? {} : { code }),
      error: message ?? `账号服务拒绝了这次请求(HTTP ${res.status})。`,
    }
  }
  let body: unknown
  try { body = await res.json() }
  catch {
    // 200 但回的不是 JSON:多半前面横着一个反代或者门户页面,当成"没有账号服务"。
    return { ok: false, unsupported: true, error: '账号服务回的内容看不懂。' }
  }
  return { ok: true, value: body as T }
}

export interface RelaySessionResult {
  session_token: string
  account: RelayAccount
}

function isSessionResult(value: unknown): value is RelaySessionResult {
  if (typeof value !== 'object' || value === null) return false
  const raw = value as Record<string, unknown>
  const account = raw.account as Record<string, unknown> | undefined
  return typeof raw.session_token === 'string' && raw.session_token !== ''
    && typeof account?.id === 'string' && typeof account.email_or_phone === 'string'
}

/** 回包认不出时当成「没有账号服务」——比把一个缺字段的东西当成登录成功安全得多。 */
function requireSession(result: RelayCall<unknown>): RelayCall<RelaySessionResult> {
  if (!result.ok) return result
  if (!isSessionResult(result.value)) {
    return { ok: false, unsupported: true, error: '账号服务回的登录结果缺字段。' }
  }
  return { ok: true, value: result.value }
}

export interface RelayAccountApiOptions {
  relayUrl: string
  fetchImpl?: typeof fetch
}

export async function relayRegister(
  options: RelayAccountApiOptions & { identifier: string, password: string },
): Promise<RelayCall<RelaySessionResult>> {
  return requireSession(await call({
    relayUrl: options.relayUrl,
    path: '/v1/account/register',
    method: 'POST',
    body: { email_or_phone: options.identifier, password: options.password },
    ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
  }))
}

export async function relayLogin(
  options: RelayAccountApiOptions & { identifier: string, password: string },
): Promise<RelayCall<RelaySessionResult>> {
  return requireSession(await call({
    relayUrl: options.relayUrl,
    path: '/v1/account/login',
    method: 'POST',
    body: { email_or_phone: options.identifier, password: options.password },
    ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
  }))
}

export async function relayLogout(
  options: RelayAccountApiOptions & { session: string },
): Promise<RelayCall<{ ok: boolean }>> {
  return call({
    relayUrl: options.relayUrl,
    path: '/v1/account/logout',
    method: 'POST',
    body: {},
    session: options.session,
    ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
  })
}

export async function relayMe(
  options: RelayAccountApiOptions & { session: string },
): Promise<RelayCall<RelayAccount>> {
  return call({
    relayUrl: options.relayUrl,
    path: '/v1/account/me',
    session: options.session,
    ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
  })
}

export async function relayChangePassword(
  options: RelayAccountApiOptions & { session: string, currentPassword: string, password: string },
): Promise<RelayCall<{ ok: boolean }>> {
  return call({
    relayUrl: options.relayUrl,
    path: '/v1/account/password',
    method: 'POST',
    body: { current_password: options.currentPassword, password: options.password },
    session: options.session,
    ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
  })
}

export async function relayDevices(
  options: RelayAccountApiOptions & { session: string },
): Promise<RelayCall<{ devices: RelayDevice[] }>> {
  return call({
    relayUrl: options.relayUrl,
    path: '/v1/account/devices',
    session: options.session,
    ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
  })
}

export async function relayRevokeDevice(
  options: RelayAccountApiOptions & { session: string, deviceId: string },
): Promise<RelayCall<{ removed: number, devices: RelayDevice[] }>> {
  return call({
    relayUrl: options.relayUrl,
    path: '/v1/account/devices/revoke',
    method: 'POST',
    body: { device_id: options.deviceId },
    session: options.session,
    ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
  })
}

/**
 * 凭账号会话给一台设备领令牌。与 modelConfig.ts 的 `registerRelayDevice` 是同一条路,
 * 区别只在**带不带账号会话**:带了,设备就记在账号名下、房间由账号 id 算;
 * 不带,走的是老路(服务器那边由 RELAY_ALLOW_LEGACY_REGISTER 决定还认不认)。
 */
export async function relayRegisterDevice(
  options: RelayAccountApiOptions & {
    session: string
    deviceId: string
    name?: string
    kind?: 'mac' | 'phone' | 'windows' | 'other' | 'handset'
  },
): Promise<RelayCall<{ token: string }>> {
  const result = await call<{ token?: unknown }>({
    relayUrl: options.relayUrl,
    path: '/register-device',
    method: 'POST',
    body: {
      device_id: options.deviceId,
      ...(options.name === undefined ? {} : { name: options.name }),
      ...(options.kind === undefined ? {} : { kind: options.kind }),
    },
    session: options.session,
    ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
  })
  if (!result.ok) return result
  const token = result.value.token
  if (typeof token !== 'string' || token === '') {
    return { ok: false, unsupported: true, error: '账号服务回的内容里没有设备令牌。' }
  }
  return { ok: true, value: { token } }
}
