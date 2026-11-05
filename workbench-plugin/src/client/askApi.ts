/**
 * 她要问的话、要批的事 —— 电脑这一侧的几条请求(2026-09-25,卡 M)。拿不到就回一句人话,**绝不抛**。
 * 手机那边(butler-app)调的是同一组口。
 */
import type { QuestionAnswerItem, SessionApprovalKey, SessionTurn } from '../protocol.ts'

async function postJson(baseUrl: string, fetchImpl: typeof fetch, path: string, body: unknown): Promise<{ ok: true, body: Record<string, unknown> } | { ok: false, error: string }> {
  try {
    const res = await fetchImpl(`${baseUrl}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
    let parsed: Record<string, unknown> = {}
    try { parsed = await res.json() as Record<string, unknown> } catch { /* 空回包 */ }
    if (res.ok) return { ok: true, body: parsed }
    return { ok: false, error: typeof parsed.error === 'string' ? parsed.error : `没成(${res.status})` }
  }
  catch {
    return { ok: false, error: '工作台服务没应答' }
  }
}

/** 答她的一问。回 undefined = 交上去了。 */
export async function answerQuestion(baseUrl: string, fetchImpl: typeof fetch, id: string, answers: readonly QuestionAnswerItem[]): Promise<string | undefined> {
  const res = await postJson(baseUrl, fetchImpl, '/questions/answer', { id, answers })
  return res.ok ? undefined : res.error
}

/**
 * 批一条。`scope: 'kind'` = 「这件事里同类的都允许」:回包里带 `granted`(那一类叫什么)与 `merged`(顺手放行了几条)。
 */
export async function answerApprovalScoped(
  baseUrl: string,
  fetchImpl: typeof fetch,
  id: string,
  allow: boolean,
  scope?: 'kind',
): Promise<{ ok: true, granted?: string, merged?: number } | { ok: false, error: string }> {
  const res = await postJson(baseUrl, fetchImpl, '/approvals/answer', { id, allow, ...(scope === undefined ? {} : { scope }) })
  if (!res.ok) return res
  return {
    ok: true,
    ...(typeof res.body.granted === 'string' ? { granted: res.body.granted } : {}),
    ...(typeof res.body.merged === 'number' ? { merged: res.body.merged } : {}),
  }
}

/** 收回「这件事里同类的都允许」。 */
export async function revokeGrant(baseUrl: string, fetchImpl: typeof fetch, sessionId: string, key: string, taskId?: string): Promise<string | undefined> {
  // 记在事项上的那几条(卡 M 追加:落盘、只对这件事有效)按事项收回;老服务只认会话,两样都带上。
  const res = await postJson(baseUrl, fetchImpl, '/approvals/grant/revoke', { session_id: sessionId, key, ...(taskId === undefined ? {} : { task_id: taskId }) })
  return res.ok ? undefined : res.error
}

/** 这件事底下那条会话最近几个回合(工具调用与代码块服务端已经去掉)。 */
export async function fetchTurns(baseUrl: string, fetchImpl: typeof fetch, itemId: string, limit = 30): Promise<{ ok: true, turns: SessionTurn[] } | { ok: false, error: string }> {
  try {
    const res = await fetchImpl(`${baseUrl}/butler/item/${encodeURIComponent(itemId)}/turns?limit=${limit}`)
    const body = await res.json() as { turns?: SessionTurn[], error?: string }
    if (res.ok && Array.isArray(body.turns)) return { ok: true, turns: body.turns }
    return { ok: false, error: body.error ?? `没拿到(${res.status})` }
  }
  catch {
    return { ok: false, error: '工作台服务没应答' }
  }
}

/**
 * 别家那段会话停着在等他,他在这里答了 —— 送回那段会话(2026-09-25,卡 T)。
 * 送不回去的服务端如实说:`{ ok:false, where:'desk', why }`(界面写那一句 + 「去回答」)。
 */
export async function answerSession(
  baseUrl: string,
  fetchImpl: typeof fetch,
  agent: string,
  sessionId: string,
  text: string,
): Promise<{ ok: true } | { ok: false, where: 'desk', why: string, reveal: boolean, permission?: true } | { ok: false, where?: undefined, error: string }> {
  const res = await postJson(baseUrl, fetchImpl, '/sessions/answer', { agent, session_id: sessionId, text })
  if (!res.ok) return { ok: false, error: res.error }
  if (res.body.ok === true) return { ok: true }
  // `permission`(2026-10-01,卡 AP):撞上的是权限弹窗 —— 卡据此收起输入框、切到「批准 / 拒绝」那几颗键。
  if (res.body.where === 'desk') {
    return { ok: false, where: 'desk', why: typeof res.body.why === 'string' ? res.body.why : '这一问得在电脑上那家的窗口里回答', reveal: res.body.reveal === true, ...(res.body.permission === true ? { permission: true as const } : {}) }
  }
  return { ok: false, error: '没送过去' }
}

/**
 * **「等你」那一堆里的一件,他答了**(2026-09-28,卡 WQ;设计-派活到收回一条链 第 ⑧ 环:一个口 `POST /asks/answer`)。
 *
 * `key` 就是 `/state.waiting` 里那一行的键(电脑、手机、电话同一份、同一个口)。
 * 回包一律带 `confirmed` —— **核实过了才算答上了**:点了没看到它收下时 `confirmed:false` + 一句人话,
 * 界面照它说(「点了「川菜」,但没看到它收下 —— 去电脑上的 Codex 看一眼」),不谎报成功。
 */
export async function answerAsk(
  baseUrl: string,
  fetchImpl: typeof fetch,
  key: string,
  said: { choice: string } | { text: string },
): Promise<
  | { ok: true, confirmed: boolean, note?: string }
  | { ok: false, where: 'desk', why: string, reveal: boolean }
  | { ok: false, where?: undefined, error: string }
> {
  const res = await postJson(baseUrl, fetchImpl, '/asks/answer', { key, ...said })
  if (!res.ok) return { ok: false, error: res.error }
  if (res.body.ok === true) {
    return {
      ok: true,
      confirmed: res.body.confirmed === true,
      ...(typeof res.body.note === 'string' && res.body.note !== '' ? { note: res.body.note } : {}),
    }
  }
  if (res.body.where === 'desk') {
    return { ok: false, where: 'desk', why: typeof res.body.why === 'string' ? res.body.why : '这一问得在电脑上那家的窗口里回答', reveal: res.body.reveal === true }
  }
  return { ok: false, error: '没答上去' }
}

/**
 * **那家停在权限弹窗上:读出弹窗上那几颗键**(2026-10-01,卡 AP;`POST /sessions/approval/read`)。
 * 只回「批准一次 / 拒绝」(键名是壳读到的原字);读不到如实回一句,卡上照它说 + 「再看一次」。
 */
export async function readApprovalKeys(
  baseUrl: string,
  fetchImpl: typeof fetch,
  agent: string,
  sessionId: string,
): Promise<{ ok: true, keys: readonly SessionApprovalKey[] } | { ok: false, why: string }> {
  const res = await postJson(baseUrl, fetchImpl, '/sessions/approval/read', { agent, session_id: sessionId })
  if (!res.ok) return { ok: false, why: res.error }
  if (res.body.ok === true && Array.isArray(res.body.keys)) {
    const keys = (res.body.keys as unknown[]).filter((one): one is SessionApprovalKey =>
      typeof one === 'object' && one !== null && typeof (one as SessionApprovalKey).label === 'string'
      && ((one as SessionApprovalKey).does === 'once' || (one as SessionApprovalKey).does === 'deny'))
    return { ok: true, keys }
  }
  return { ok: false, why: typeof res.body.why === 'string' ? res.body.why : '没读到它弹窗上的键' }
}

/** 「去回答」:把那段对话调到前面(只在这台电脑上)。 */
export async function revealSession(baseUrl: string, fetchImpl: typeof fetch, agent: string, sessionId: string): Promise<{ ok: boolean, why?: string }> {
  const res = await postJson(baseUrl, fetchImpl, '/sessions/reveal', { agent, session_id: sessionId })
  if (!res.ok) return { ok: false, why: res.error }
  return { ok: res.body.ok === true, ...(typeof res.body.why === 'string' ? { why: res.body.why } : {}) }
}

/** 「不用管这条」:按内容判出来的这一问从「等你」里拿掉(那家说了新的一句再重新判)。回 undefined = 拿掉了。 */
export async function dismissSessionAsk(baseUrl: string, fetchImpl: typeof fetch, agent: string, sessionId: string): Promise<string | undefined> {
  const res = await postJson(baseUrl, fetchImpl, '/sessions/ask/dismiss', { agent, session_id: sessionId })
  return res.ok ? undefined : res.error
}
