/**
 * 手机直接跟中转说话(2026-09-21)。这一层的全部意义是:**出门在外不依赖局域网的 8791**。
 *
 * 以前手机要进房,得先在局域网里向电脑上的 8791 要一张进房凭证(`POST /channel/token`)。
 * 那意味着「第一次出门之前必须回过一次家」,而且 7 天到期时人在外面就续不上了 ——
 * 功能盘点里「手机出门随时进房」那条写的就是这件事。
 *
 * 现在这条路是:
 *
 * ```
 *   账号密码 ──▶ POST /v1/account/login        → 会话令牌 wbs_…(长期,可吊销)
 *                     │
 *                     ├──▶ POST /register-device  → 这台手机的设备令牌 wb_…
 *                     │        (记在账号名下;电脑那台也在同一个账号下)
 *                     ▼
 *              GET  /v1/channel-credentials     → 服务器地址 + 房间名(房间由账号 id 算)
 *              POST /v1/channel-token           → 进房凭证(7 天,只够进自己那一间)
 * ```
 *
 * 两把令牌都只进安全存储(accountStore.ts → Capacitor Preferences),
 * **不打日志、不进 URL、不进任何界面文案**。密码只在登录那一次请求里存在过,不存。
 */

export type RelayResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: string; status?: number; code?: string };

export interface RelayAccount {
  id: string;
  email_or_phone: string;
  created_at: string;
}

export interface RelayChannelCredentials {
  url: string;
  room: string;
  /** 服务器上没配 LiveKit 时为假 —— 这时候不是"手机错了",是"服务器还没配好"。 */
  configured: boolean;
}

export interface RelayRoomToken {
  url: string;
  room: string;
  identity: string;
  token: string;
  expires_at: number;
}

function trimSlash(value: string): string {
  return value.replace(/\/+$/, '');
}

/** 中转的错误形状是 OpenAI 的 `{ error: { message, code } }`。 */
async function failureOf(res: Response): Promise<{ error: string; status: number; code?: string }> {
  let message: string | undefined;
  let code: string | undefined;
  try {
    const body = (await res.json()) as { error?: { message?: unknown; code?: unknown } };
    if (typeof body.error?.message === 'string') message = body.error.message;
    if (typeof body.error?.code === 'string') code = body.error.code;
  } catch { /* 回的不是 JSON 就用状态码那句 */ }
  return {
    error: message ?? `账号服务拒绝了这次请求(HTTP ${res.status})`,
    status: res.status,
    ...(code === undefined ? {} : { code }),
  };
}

async function call<T>(input: {
  relayUrl: string;
  path: string;
  method?: 'GET' | 'POST';
  body?: unknown;
  token?: string;
  fetchImpl?: typeof fetch;
}): Promise<RelayResult<T>> {
  const doFetch = input.fetchImpl ?? fetch;
  let res: Response;
  try {
    res = await doFetch(`${trimSlash(input.relayUrl)}${input.path}`, {
      method: input.method ?? 'GET',
      headers: {
        ...(input.body === undefined ? {} : { 'content-type': 'application/json' }),
        ...(input.token === undefined ? {} : { authorization: `Bearer ${input.token}` }),
      },
      ...(input.body === undefined ? {} : { body: JSON.stringify(input.body) }),
    });
  } catch {
    // 底层那句话可能把地址抖出来,一律换成自己的措辞。
    return { ok: false, error: '连不上账号服务(手机这会儿没网,或者服务器还没部署好)' };
  }
  if (!res.ok) return { ok: false, ...(await failureOf(res)) };
  try {
    return { ok: true, value: (await res.json()) as T };
  } catch {
    return { ok: false, error: '账号服务回的内容看不懂' };
  }
}

export interface RelaySession {
  session_token: string;
  account: RelayAccount;
}

function isSession(value: unknown): value is RelaySession {
  if (typeof value !== 'object' || value === null) return false;
  const raw = value as Record<string, unknown>;
  const account = raw.account as Record<string, unknown> | undefined;
  return typeof raw.session_token === 'string' && raw.session_token !== ''
    && typeof account?.id === 'string' && typeof account.email_or_phone === 'string';
}

/** 回包缺字段就当没登录成:把一个缺字段的东西当成登录成功,后面每一步都会错得更离谱。 */
function requireSession(result: RelayResult<unknown>): RelayResult<RelaySession> {
  if (!result.ok) return result;
  if (!isSession(result.value)) return { ok: false, error: '账号服务回的登录结果缺字段' };
  return { ok: true, value: result.value };
}

export async function relayLogin(input: {
  relayUrl: string; identifier: string; password: string; fetchImpl?: typeof fetch;
}): Promise<RelayResult<RelaySession>> {
  return requireSession(await call({
    relayUrl: input.relayUrl,
    path: '/v1/account/login',
    method: 'POST',
    body: { email_or_phone: input.identifier, password: input.password },
    ...(input.fetchImpl === undefined ? {} : { fetchImpl: input.fetchImpl }),
  }));
}

export async function relayRegister(input: {
  relayUrl: string; identifier: string; password: string; fetchImpl?: typeof fetch;
}): Promise<RelayResult<RelaySession>> {
  return requireSession(await call({
    relayUrl: input.relayUrl,
    path: '/v1/account/register',
    method: 'POST',
    body: { email_or_phone: input.identifier, password: input.password },
    ...(input.fetchImpl === undefined ? {} : { fetchImpl: input.fetchImpl }),
  }));
}

export async function relayLogout(input: {
  relayUrl: string; session: string; fetchImpl?: typeof fetch;
}): Promise<void> {
  await call({
    relayUrl: input.relayUrl,
    path: '/v1/account/logout',
    method: 'POST',
    body: {},
    token: input.session,
    ...(input.fetchImpl === undefined ? {} : { fetchImpl: input.fetchImpl }),
  }).catch(() => undefined);
}

/**
 * 中转认得的设备类型(relay/server/accounts.cjs 的 `DEVICE_KINDS`,**逐字相同**)。
 *
 * 2026-09-23 多了 `handset`。上一版这里写着「中转没有话筒这一类」,那句话从
 * `fix/handset-kind-via-relay` 起就不成立了(交接-0922-铃由手机出话筒对话 第九节):
 * 中转现在**按注册时那一列签 `wb_kind`**。座机再报 `other` 的话,它经中转进房时
 * 凭证属性里就没有 `wb_kind` —— 工人 `participantKindOf` 缺省当手机,于是声音走手机、
 * `GET /devices/online` 说它是 phone、这台手机的 `useHandsetOnline` 判「座机不在线」。
 *
 * ⚠️ **中转要先部署**:老中转收到 `handset` 会 400 顶回来(`设备类型只能是 …`),
 * 那一步领不到令牌,BLE 配网就停在「配对进房」。部署顺序见那一节的「部署顺序(要紧)」。
 */
export type RelayDeviceKind = 'phone' | 'mac' | 'windows' | 'other' | 'handset';

/**
 * 把一台设备挂到账号下,换一把设备令牌。
 * `device_id` 用配对时那一份(同一台重领只是换钥匙,不算新设备)。
 *
 * 2026-09-22 多了 `kind`:这条路现在也替**座机**领令牌(设置 → 座机 → 添加座机)。
 * 缺省仍是 `phone`,所以原来那几处调用一个字都不用改。
 */
export async function relayRegisterDevice(input: {
  relayUrl: string; session: string; deviceId: string; name?: string;
  kind?: RelayDeviceKind; fetchImpl?: typeof fetch;
}): Promise<RelayResult<{ token: string }>> {
  const result = await call<{ token?: unknown }>({
    relayUrl: input.relayUrl,
    path: '/register-device',
    method: 'POST',
    body: {
      device_id: input.deviceId,
      kind: input.kind ?? 'phone',
      ...(input.name === undefined ? {} : { name: input.name }),
    },
    token: input.session,
    ...(input.fetchImpl === undefined ? {} : { fetchImpl: input.fetchImpl }),
  });
  if (!result.ok) return result;
  if (typeof result.value.token !== 'string' || result.value.token === '') {
    return { ok: false, error: '账号服务回的内容里没有设备令牌' };
  }
  return { ok: true, value: { token: result.value.token } };
}

/** 通道怎么连。**回包里没有 LiveKit 的 secret**(中转那边就不发),这里只取要用的三样。 */
export async function relayChannelCredentials(input: {
  relayUrl: string; deviceToken: string; fetchImpl?: typeof fetch;
}): Promise<RelayResult<RelayChannelCredentials>> {
  const result = await call<{ livekit?: { configured?: unknown; url?: unknown; room?: unknown }; notes?: unknown }>({
    relayUrl: input.relayUrl,
    path: '/v1/channel-credentials',
    token: input.deviceToken,
    ...(input.fetchImpl === undefined ? {} : { fetchImpl: input.fetchImpl }),
  });
  if (!result.ok) return result;
  const livekit = result.value.livekit;
  if (livekit?.configured !== true || typeof livekit.url !== 'string' || typeof livekit.room !== 'string') {
    const notes = Array.isArray(result.value.notes) ? result.value.notes.filter(n => typeof n === 'string') : [];
    return { ok: false, error: notes[0] ?? '服务器上还没配好通话服务' };
  }
  return { ok: true, value: { url: livekit.url, room: livekit.room, configured: true } };
}

/**
 * 领一张进房凭证。`room` 报上去**只是核对**:对不上中转会拒(400 room_not_yours),
 * 而不是照着签 —— 房间归谁由中转按账号算,手机说了不算。
 */
export async function relayChannelToken(input: {
  relayUrl: string;
  deviceToken: string;
  identity: string;
  room?: string;
  name?: string;
  /** 会被原样签进凭证的参与者属性。工人靠 `wb_device_id` 那一条决定用谁的权限去调 8791。 */
  attributes?: Record<string, string>;
  fetchImpl?: typeof fetch;
}): Promise<RelayResult<RelayRoomToken>> {
  const result = await call<Record<string, unknown>>({
    relayUrl: input.relayUrl,
    path: '/v1/channel-token',
    method: 'POST',
    body: {
      identity: input.identity,
      ...(input.room === undefined ? {} : { room: input.room }),
      ...(input.name === undefined ? {} : { name: input.name }),
      ...(input.attributes === undefined ? {} : { attributes: input.attributes }),
    },
    token: input.deviceToken,
    ...(input.fetchImpl === undefined ? {} : { fetchImpl: input.fetchImpl }),
  });
  if (!result.ok) return result;
  const raw = result.value;
  const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() !== '' ? v.trim() : undefined);
  const url = str(raw.url);
  const room = str(raw.room);
  const identity = str(raw.identity);
  const token = str(raw.token);
  const expiresAt = raw.expires_at;
  if (url === undefined || room === undefined || identity === undefined || token === undefined
    || typeof expiresAt !== 'number' || !Number.isFinite(expiresAt)) {
    // 缺字段一律当没领到:地址猜错了会连到别人的服务器上去(同 credentialStore 的口径)。
    return { ok: false, error: '账号服务回的进房凭证缺字段' };
  }
  return { ok: true, value: { url, room, identity, token, expires_at: expiresAt } };
}
