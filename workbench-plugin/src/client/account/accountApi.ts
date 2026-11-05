/**
 * 账号那四条路(2026-09-17)。跟登录台 setupApi 同一条纪律:**失败不静默** ——
 * Ben 正盯着一颗「登录」按钮等结果,吞掉错误等于"点了没反应"。
 *
 * 两处容易踩的坑,都在这里解决掉:
 * ① **每一条都要 `credentials: 'include'`**。工作台页面在 127.0.0.1:3080、服务在 :8791,
 *    跨源;不带这一句,浏览器既不会把服务端种的 cookie 收下,也不会在下一条请求里带上它 ——
 *    表现就是"登录成功了,刷新又回到登录屏"。
 * ② **服务端没接账号(404)不是错误**,是"这台服务还没有账号这回事"。界面据此照旧直接显示
 *    工作台(既有的一大批用例、展示台、手机都走这一支)。
 */

/** `GET /account` 的形状。回包里**永远没有**哈希、salt、令牌。 */
export interface AccountView {
  registered: boolean
  logged_in: boolean
  username?: string
  locked_until?: string
  /**
   * 账号在自家服务器上(2026-09-21),不只在这台机器上。界面据此:
   * ① 「账号」那一节不再写"只在这台机器上";② 多出「我的设备」一列。
   * **缺席 = 还是本机账号**(老服务端、退回本机那条路都不带这一格,`=== true` 判)。
   */
  on_server?: boolean
  /** `false` = 这台没接中转(零服务器档),账号只在这台电脑上。缺席 = 接了中转。 */
  relay_configured?: false
}

/** 「我的设备」里一行。**永远没有令牌** —— 令牌明文这辈子只在领的那一刻出现过一次。 */
export interface DeviceRow {
  device_id: string
  name?: string
  kind: string
  created_at: string
  last_seen_at?: string
  /** 这一台就是你正对着的这台电脑。 */
  current?: boolean
}

/** 设备类型 → 界面上那个词。认不出的一律「设备」,不把英文原样甩给用户。 */
export const DEVICE_KIND_TEXT: Record<string, string> = {
  mac: 'Mac',
  phone: '手机',
  windows: 'Windows',
  other: '设备',
}

export function deviceKindText(kind: string): string {
  return DEVICE_KIND_TEXT[kind] ?? '设备'
}

/**
 * 「上次在线」那一句。刚才 / 几分钟前 / 几小时前 / 几天前 / 日期。
 * **纯函数**,时间从参数进来(测试不靠真时钟)。
 */
export function lastSeenText(lastSeenAt: string | undefined, nowMs: number): string {
  if (lastSeenAt === undefined) return '还没上线过'
  const at = Date.parse(lastSeenAt)
  if (!Number.isFinite(at)) return '还没上线过'
  const minutes = Math.floor((nowMs - at) / 60_000)
  if (minutes < 2) return '刚刚在线'
  if (minutes < 60) return `${minutes} 分钟前`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours} 小时前`
  const days = Math.floor(hours / 24)
  if (days <= 30) return `${days} 天前`
  return new Date(at).toLocaleDateString('zh-CN')
}

/** 列设备。服务端拿不到(没登录 / 服务器不可达)时把它那句人话原样抛出来。 */
export async function fetchDevices(baseUrl: string, fetchImpl: typeof fetch = fetch): Promise<DeviceRow[]> {
  const res = await fetchImpl(`${baseUrl}/account/devices`, { credentials: 'include' })
  const body = await parse<{ devices?: DeviceRow[] }>(res, '读设备列表')
  return Array.isArray(body.devices) ? body.devices : []
}

export async function revokeDevice(baseUrl: string, deviceId: string, fetchImpl: typeof fetch = fetch): Promise<DeviceRow[]> {
  const res = await fetchImpl(`${baseUrl}/account/devices/revoke`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify({ device_id: deviceId }),
  })
  const body = await parse<{ devices?: DeviceRow[] }>(res, '移除设备')
  return Array.isArray(body.devices) ? body.devices : []
}

/** 拿不到就是"这台服务没接账号",不是错误(同 setupApi 的 MaybePending)。 */
export type AccountProbe = { enabled: false } | { enabled: true, view: AccountView }

async function parse<T>(res: Response, what: string): Promise<T> {
  let body: unknown
  try { body = await res.json() }
  catch { throw new Error(`${what}:服务端回的不是 JSON(HTTP ${res.status})`) }
  if (!res.ok) {
    const error = (body as { error?: unknown } | null)?.error
    throw new Error(typeof error === 'string' ? error : `${what}失败(HTTP ${res.status})`)
  }
  return body as T
}

function isView(value: unknown): value is AccountView {
  if (typeof value !== 'object' || value === null) return false
  const raw = value as Record<string, unknown>
  return typeof raw.registered === 'boolean' && typeof raw.logged_in === 'boolean'
}

/**
 * 问一次"这台机器有没有账号、我登录了没有"。
 *
 * 认不出的回包(404、乱七八糟的 JSON、网络不通)一律当成 `{ enabled: false }` ——
 * **登录屏是个整屏拦路的东西,只有在确知"服务说要登录"时才该出现**;
 * 因为一次网络抖动把 Ben 挡在工作台外面,是这一页能犯的最糟的错。
 */
export async function probeAccount(baseUrl: string, fetchImpl: typeof fetch = fetch): Promise<AccountProbe> {
  let res: Response
  try {
    res = await fetchImpl(`${baseUrl}/account`, { credentials: 'include' })
  }
  catch {
    return { enabled: false }
  }
  if (!res.ok) return { enabled: false }
  let body: unknown
  try { body = await res.json() }
  catch { return { enabled: false } }
  return isView(body) ? { enabled: true, view: body } : { enabled: false }
}

async function post(baseUrl: string, path: string, body: unknown, what: string, fetchImpl: typeof fetch): Promise<{ username?: string }> {
  const res = await fetchImpl(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify(body),
  })
  return await parse<{ username?: string }>(res, what)
}

export async function registerAccount(
  baseUrl: string,
  input: { username: string, password: string, confirm: string },
  fetchImpl: typeof fetch = fetch,
): Promise<{ username?: string }> {
  return await post(baseUrl, '/account/register', input, '注册', fetchImpl)
}

export async function loginAccount(
  baseUrl: string,
  input: { username: string, password: string },
  fetchImpl: typeof fetch = fetch,
): Promise<{ username?: string }> {
  return await post(baseUrl, '/account/login', input, '登录', fetchImpl)
}

/** 改密码走的是同一条 register —— 服务端按"有没有账号 + 登录了没有"分岔(见 http.ts 那段注释)。 */
export async function changePassword(
  baseUrl: string,
  input: { current_password: string, password: string, confirm: string },
  fetchImpl: typeof fetch = fetch,
): Promise<{ username?: string }> {
  return await post(baseUrl, '/account/register', input, '改密码', fetchImpl)
}

/** 重置账号:删掉这台机器上的账号记录,之后重新注册。数据不动。 */
export async function resetAccount(baseUrl: string, fetchImpl: typeof fetch = fetch): Promise<void> {
  const res = await fetchImpl(`${baseUrl}/account/reset`, { method: 'POST', credentials: 'include' })
  if (!res.ok) throw new Error('重置账号没成功,再试一次')
}

export async function logoutAccount(baseUrl: string, fetchImpl: typeof fetch = fetch): Promise<void> {
  await post(baseUrl, '/account/logout', {}, '退出登录', fetchImpl)
}

/** 浏览器没把 cookie 收下时说的那句话(见 AccountScreen 里为什么要专门说它)。 */
export const COOKIE_BLOCKED_HINT
  = '登录是成功的,但浏览器没有把登录 cookie 存下来。请用 http://127.0.0.1:3080 打开工作台(不要用 localhost 或别的地址),再登录一次。'
