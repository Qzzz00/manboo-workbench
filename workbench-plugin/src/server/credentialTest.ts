/**
 * 「一键测试连接」:首次引导里用户刚贴进来的那把 DeepSeek 密钥,到底能不能用。
 *
 * 为什么单独一个文件(2026-11-12):
 * - 判断全在这里,是**纯函数**(credentialTestWords),单测不需要起服务、不需要真的联网;
 * - HTTP 那一层(http.ts)只负责收 key、调一下、把结果送回去,不夹带任何判定。
 *
 * 纪律(AGENTS.md「不展示或写入 API Key」/ credentials.ts「只往外送,不往回取」):
 * - Key 只用于**这一次外发请求**,不落盘、不回显、不写进任何日志或错误信息;
 * - 回包只有「成没成 + 一句人话」,连上游回应的正文都不带(那里面可能有别的东西);
 * - 服务地址与模型名用 modelConfig.ts 的缺省 —— 与工作台真正会用的那一份是同一个常量,
 *   不另抄一份,免得「测的时候是这家、用的时候是那家」;
 * - 只认回环来源(http.ts 里守),毕竟这一下花的是用户自己 Key 的钱。
 *
 * ## 为什么打 chat/completions 而不是 /user/balance
 *
 * balance 不花钱,但它只回答「这把 Key 认不认」;用户要的那两个错 —— 401(Key 不对)、
 * 402(余额不足) —— 后者只有真正发起一次对话才会回。所以打一次 max_tokens=1 的最小对话,
 * 花的钱可以忽略,却能把两种失败分开说清楚。
 */
import { OWN_DEFAULT_BASE_URL, OWN_DEFAULT_MODEL } from './modelConfig.ts'

/** 测试连接的结论。message 是给人看的,status 只给程序/单测判。 */
export interface CredentialTestResult {
  ok: boolean
  message: string
  /** 上游状态码;'network' = 连不上 / 超时。都不给界面显示原始数字。 */
  status?: number | 'network'
}

/** 一句话说人话,不出现状态码、不出现 Key、不出现上游正文。 */
export const CREDENTIAL_TEST_COPY = {
  ok: '接上了,这把 Key 能用。',
  invalidKey: '这把 Key 不对,或者没复制全 —— 回开放平台重新复制一遍完整的那串。',
  noBalance: 'Key 是对的,但账户余额不足 —— 去 DeepSeek 开放平台充值后就能用了。',
  forbidden: '这把 Key 没有调用权限,去开放平台看看是不是被停用了。',
  badRequest: '请求没被接受,多半是模型名对不上 —— 检查一下预置的模型名。',
  tooMany: '调用太频繁了,稍等几秒再试一次。',
  upstreamBusy: 'DeepSeek 服务这会儿有点忙,稍后再试。',
  network: '连不上 DeepSeek,检查一下这台电脑能不能上网。',
  unknown: 'DeepSeek 没接成,稍后再试,或者换一把 Key 试试。',
  emptyKey: '先把 Key 贴进来再试。',
} as const

/**
 * 状态码 → 人话。纯函数,是本文件唯一被单测盯住的那条接缝。
 *
 * 2xx 一律算成功(上游有时回 201),其余按用户真正会遇到的那几种分开说:
 * 401 与 402 是这次需求点名的两个,不能混成一句「失败了」。
 */
export function credentialTestWords(status: number | 'network'): CredentialTestResult {
  if (status === 'network') return { ok: false, message: CREDENTIAL_TEST_COPY.network, status }
  if (status >= 200 && status < 300) return { ok: true, message: CREDENTIAL_TEST_COPY.ok, status }
  const words: Record<number, string> = {
    400: CREDENTIAL_TEST_COPY.badRequest,
    401: CREDENTIAL_TEST_COPY.invalidKey,
    402: CREDENTIAL_TEST_COPY.noBalance,
    403: CREDENTIAL_TEST_COPY.forbidden,
    404: CREDENTIAL_TEST_COPY.badRequest,
    422: CREDENTIAL_TEST_COPY.badRequest,
    429: CREDENTIAL_TEST_COPY.tooMany,
    500: CREDENTIAL_TEST_COPY.upstreamBusy,
    502: CREDENTIAL_TEST_COPY.upstreamBusy,
    503: CREDENTIAL_TEST_COPY.upstreamBusy,
    504: CREDENTIAL_TEST_COPY.upstreamBusy,
  }
  const message = words[status] ?? CREDENTIAL_TEST_COPY.unknown
  return { ok: false, message, status }
}

export interface TestDeepSeekKeyArgs {
  /** 用户草稿里的那把 Key。只在内存里,不写盘。 */
  key: string
  fetchImpl?: typeof fetch
  /** 单测要改地址/模型名时用;生产一律走 modelConfig 的缺省。 */
  baseUrl?: string
  model?: string
}

/** 打一次最小对话,把上游状态码翻成人话。任何异常都收敛成「连不上」,绝不把底层错误带出去。 */
export async function testDeepSeekKey({
  key,
  fetchImpl = fetch,
  baseUrl = OWN_DEFAULT_BASE_URL,
  model = OWN_DEFAULT_MODEL,
}: TestDeepSeekKeyArgs): Promise<CredentialTestResult> {
  const trimmed = key.trim()
  if (trimmed === '') return { ok: false, message: CREDENTIAL_TEST_COPY.emptyKey }
  try {
    const res = await fetchImpl(`${baseUrl.replace(/\/+$/, '')}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${trimmed}` },
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content: 'hi' }],
        max_tokens: 1,
        stream: false,
      }),
      signal: AbortSignal.timeout(15_000),
    })
    // 只取状态码。上游正文里可能带账户信息,一律不读、不回显。
    return credentialTestWords(res.status)
  }
  catch {
    return credentialTestWords('network')
  }
}
