/**
 * 首次流程(引导入口)跟服务端说的那几句(2026-09-17)。
 *
 * 这里**一条新接口都没造**:手机的包走登录台的 `/setup/apk.json`,配对走 `/lan` + `/pair/start`
 * (跟设置里「手机与设备」那一节同一条路),引导走 09-15/09-16 就有的 `/onboarding/*`。
 * 新的只有一面旗子 `/first-run` —— 「注册完之后那三屏给他看过了没有」。
 *
 * 纪律同 setupApi:**失败不静默**。这一页上每一步后面都跟着一个人在等,吞掉错误等于"点了没反应";
 * 完成旗子保存失败也交给界面重试。
 */

import { ONBOARDING_RESTART_TIMEOUT_TEXT, ONBOARDING_RESTARTING_NOTE } from '../../protocol.ts'

export interface FirstRunView { done_at?: string }

/**
 * 服务端说「DSH 正在重启、好认下刚领到的模型凭证」(503 + restarting:true)。这不是失败,是预料之中的一步:
 * 界面见到它换成一行灰字「稍等,正在准备…」+ 球的等待态,等新进程回话后自己接着开会话(2026-09-24)。
 */
export class OnboardingRestartingError extends Error {
  constructor(message: string = ONBOARDING_RESTARTING_NOTE) { super(message); this.name = 'OnboardingRestartingError' }
}

export interface OnboardingDetailView {
  stage: string
  done: boolean
  mode?: string
  nickname?: string
  session_id?: string
  next?: { label: string, seed: string, goals: readonly string[], keys: string[] }
}

export interface OnboardingTurnView {
  seq: number
  role: string
  text: string
  at?: string
  kind?: string
}

export interface OnboardingTurnsView {
  turns: readonly OnboardingTurnView[]
  busy: boolean
  ended: boolean
  stage: string
  done: boolean
  seed?: string
  /** 最近一轮以错误结束(2026-09-23,fix/onboarding-stale-session 在补;旧服务端缺席)。 */
  failed?: boolean
  /**
   * 扫描进度(2026-09-23,与 `GET /onboarding/scan/status` 同一份,server/projectsService.ts ScanProgress)。
   * 旧服务端缺席 = 没给信号。界面按 onboardingStage.ts scanProgressOf 读。
   */
  scan?: {
    scanning: boolean
    phase?: 'list' | 'repos'
    done?: number
    total?: number
    current?: string
    started_at?: string
    finished_at?: string
  }
}

async function parse<T>(res: Response, what: string): Promise<T> {
  let body: unknown
  try { body = await res.json() }
  catch { throw new Error(`${what}:服务端回的不是 JSON(HTTP ${res.status})`) }
  if (!res.ok) {
    const error = (body as { error?: unknown } | null)?.error
    if (res.status === 503 && (body as { restarting?: unknown } | null)?.restarting === true) {
      throw new OnboardingRestartingError(typeof error === 'string' && error !== '' ? error : undefined)
    }
    throw Object.assign(new Error(typeof error === 'string' ? error : `${what}失败(HTTP ${res.status})`), { status: res.status })
  }
  return body as T
}

async function postJson<T>(baseUrl: string, path: string, body: unknown, what: string, fetchImpl: typeof fetch): Promise<T> {
  const res = await fetchImpl(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify(body),
  })
  return await parse<T>(res, what)
}

/**
 * 首次流程走完没有。**认不出就当"走完了"**(回 undefined):这一整套是个整屏拦路的东西,
 * 问不到服务端时把人按在引导里,比少走一次引导糟得多。
 */
export async function fetchFirstRun(baseUrl: string, fetchImpl: typeof fetch = fetch): Promise<FirstRunView | undefined> {
  let res: Response
  try { res = await fetchImpl(`${baseUrl}/first-run`, { credentials: 'include' }) }
  catch { return undefined }
  if (!res.ok) return undefined
  try {
    const body = await res.json() as FirstRunView | null
    if (typeof body !== 'object' || body === null) return undefined
    return typeof body.done_at === 'string' ? { done_at: body.done_at } : {}
  }
  catch {
    return undefined
  }
}

/** 保存失败交给界面重试，避免下次刷新又出现首次流程。 */
export async function markFirstRunDone(baseUrl: string, done: boolean, fetchImpl: typeof fetch = fetch): Promise<void> {
  try {
    await postJson(baseUrl, '/first-run', { done }, '记下首次流程', fetchImpl)
  } catch (err) {
    if (done) throw err
    // 设置中的旧重看入口仍兼容没有 first-run 接口的工作台。
  }
}

export async function fetchOnboardingDetail(baseUrl: string, fetchImpl: typeof fetch = fetch): Promise<OnboardingDetailView> {
  return await parse<OnboardingDetailView>(await fetchImpl(`${baseUrl}/onboarding`, { credentials: 'include' }), '读引导进度')
}

/** 开一条引导会话(事务官在 DSH 里开口)。没接会话通道时服务端回 409 + 一句人话,原样抛给界面。 */
export async function startOnboardingSession(baseUrl: string, fetchImpl: typeof fetch = fetch): Promise<{
  stage: string, session_id?: string, first_message: string, seed: string, resumed: boolean, note?: string
}> {
  return await postJson(baseUrl, '/onboarding/session', {}, '开始引导', fetchImpl)
}

/** 重启那一下最多等多久(之后才算真失败、用红字)。DSH 冷启动实测十几秒,留足余量。 */
export const RESTART_WAIT_MS = 90_000
/** 等重启时隔多久再敲一次门。 */
export const RESTART_POLL_MS = 2_000

/**
 * 开引导会话,**跨过那一下重启**(2026-09-24):
 * 回「正在重启」→ 调 onRestarting()(界面换灰字)→ 隔 RESTART_POLL_MS 再开一次;重启期间连不上(网络错)也照等;
 * 新进程回话了就把结果交回去。等超过 RESTART_WAIT_MS 才抛 —— 那时才是真失败。
 * 没遇到过重启时的网络错 / 别的错照旧原样抛(纪律同上:失败不静默)。
 */
export async function startOnboardingSessionThroughRestart(
  baseUrl: string,
  fetchImpl: typeof fetch = fetch,
  options: { onRestarting?: () => void, sleep?: (ms: number) => Promise<void>, now?: () => number, waitMs?: number, pollMs?: number } = {},
): ReturnType<typeof startOnboardingSession> {
  const sleep = options.sleep ?? (ms => new Promise<void>(resolve => setTimeout(resolve, ms)))
  const now = options.now ?? Date.now
  const waitMs = options.waitMs ?? RESTART_WAIT_MS, pollMs = options.pollMs ?? RESTART_POLL_MS
  let since: number | undefined
  for (;;) {
    try {
      return await startOnboardingSession(baseUrl, fetchImpl)
    }
    catch (err) {
      const restarting = err instanceof OnboardingRestartingError
      // 重启途中连不上(fetch 抛)、回的不是 JSON、5xx 都算「还没回来」;4xx 是新进程给的真答复,照旧报。
      // 没见过重启就出错,一律照旧报。
      const status = (err as { status?: unknown }).status
      const down = since !== undefined && !(typeof status === 'number' && status < 500)
      if (!restarting && !down) throw err
      if (since === undefined) { since = now(); options.onRestarting?.() }
      if (now() - since >= waitMs) throw new Error(ONBOARDING_RESTART_TIMEOUT_TEXT)
      await sleep(pollMs)
    }
  }
}

/** 交一项答案(称呼、分岔……)。阶段机校验 key 白名单,不对就 400 带人话。 */
export async function answerOnboarding(
  baseUrl: string,
  input: { stage: string, key: string, value: unknown },
  fetchImpl: typeof fetch = fetch,
): Promise<{ ok: true, stage: string, advanced: boolean, done: boolean, next?: { seed: string } }> {
  return await postJson(baseUrl, '/onboarding/answer', input, '交引导答案', fetchImpl)
}

export async function fetchOnboardingTurns(
  baseUrl: string,
  after: number,
  fetchImpl: typeof fetch = fetch,
): Promise<OnboardingTurnsView> {
  const res = await fetchImpl(`${baseUrl}/onboarding/turns?after=${Math.max(0, Math.floor(after))}`, { credentials: 'include' })
  return await parse<OnboardingTurnsView>(res, '读引导对话')
}

export async function sayOnboarding(baseUrl: string, text: string, fetchImpl: typeof fetch = fetch): Promise<void> {
  await postJson(baseUrl, '/onboarding/say', { text }, '说这句话', fetchImpl)
}

/**
 * 换一个主导方(2026-09-18):电脑上那颗「改在电脑上做」按它。
 * **只改界面归属**,阶段与答案一个字不动 —— 两端照旧共用同一份 onboarding.json。
 */
export async function setOnboardingLeader(
  baseUrl: string,
  leader: 'phone' | 'desktop',
  fetchImpl: typeof fetch = fetch,
): Promise<{ ok: true, leader: string }> {
  return await postJson(baseUrl, '/onboarding/leader', { leader }, '改引导的主导方', fetchImpl)
}

/**
 * ——— 三件主路(2026-10-21,卡「引导三件事」;口径在 `src/mainPaths.ts`) ———
 *
 * 「想先试哪一件」那一问、第一次有用那一屏上的「试一下」、在电脑上对她说一句、登录 Claude / Codex 那颗键。
 * 失败照本文件的纪律**不静默**:那一句人话原样抛给界面。
 */
export interface FirstUseTryResult {
  ok: boolean
  note?: string
  door?: string
  id?: string
  family?: string
}

/** 她答的那一问:`morning` / `delegate` / `call`,或「都行」(= 不选)。 */
export async function setFirstTry(baseUrl: string, path: string, fetchImpl: typeof fetch = fetch): Promise<void> {
  await postJson(baseUrl, '/first-use/prefer', { path }, '记下想先试哪一件', fetchImpl)
}

export async function tryFirstUse(baseUrl: string, path: string, text: string | undefined, fetchImpl: typeof fetch = fetch): Promise<FirstUseTryResult> {
  return await postJson(baseUrl, '/first-use/try', text === undefined ? { path } : { path, text }, '试这一件', fetchImpl)
}

/** 在电脑上对事务官说一句(与收件箱那个输入框同一条 `/butler/item`)。 */
export async function sayToButler(baseUrl: string, text: string, fetchImpl: typeof fetch = fetch): Promise<{ ok?: boolean, id?: string, note?: string }> {
  return await postJson(baseUrl, '/butler/item', { text }, '记下这一句', fetchImpl)
}

/** 「登录 Claude / Codex」那颗键:在这台电脑上开它自己的登录窗口(账号密码工作台不经手)。 */
export async function loginAgent(baseUrl: string, family: string, fetchImpl: typeof fetch = fetch): Promise<{ ok?: boolean, note?: string }> {
  return await postJson(baseUrl, '/agents/login', { family }, '打开登录窗口', fetchImpl)
}
