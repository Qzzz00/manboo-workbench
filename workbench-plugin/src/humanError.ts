/**
 * 英文报错说人话(2026-09-25,卡 V)。
 *
 * 09-25 晚维护者屏上那张卡写的是「Not logged in · Please run」—— 一句英文、还带半条命令行指令。
 * 维护者的规矩第 3 条:**不露内部的东西**(英文键名、路径、命令行);另一条:**出错有人话 + 下一步**。
 *
 * 这个文件只做一件事:**一段原文 → 一句人话 + 一个一键入口**。
 *
 * - 翻得出的:一句话说清是什么、要他做什么(「Claude 命令行还没登录」+ 一颗「登录 Claude」);
 * - **翻不出的一律归成「出错了(看原始)」**,原文收进 `raw` 让他点「看原始」自己看 ——
 *   不猜、不扩写、不把一句不认识的英文原样摆在他眼前(D13)。
 *
 * 放在 `src/` 根上(不在 server/ 也不在 client/ 里):服务端拼 `/state` 时翻好,电脑与手机都只读这一份 ——
 * 同 `waiting.ts` / `protocol.ts` 的理由,两边各写一份迟早会漂。**体检那一格(卡 O 的 agentCaps)
 * 与会话卡说的是同一句** —— 两处都调这里,不各写一句。
 */

/** 一键入口是哪一颗。界面按它决定摆哪颗按钮;`undefined` = 没有下一步可点(只能等 / 只能看原始)。 */
export type HumanErrorAction = 'login_claude' | 'login_codex' | 'login_kimi' | 'quota' | 'model' | 'install_client' | 'credentials'

/** 每颗按钮上的字。服务端与两端共用一份。 */
export const HUMAN_ERROR_ACTION_LABELS: Record<HumanErrorAction, string> = {
  login_claude: '登录 Claude',
  login_codex: '登录 Codex',
  login_kimi: '登录 Kimi',
  quota: '去看额度',
  model: '去挑模型',
  install_client: '去装这家',
  credentials: '去填密钥',
}

export interface HumanError {
  /** 给他看的那一句。永远有值。 */
  line: string
  /** 一键入口(界面摆按钮用);没有下一步可点时缺席。 */
  action?: HumanErrorAction
  /** 原文(英文原样,截过)。点「看原始」看的就是它;认不出的那些全靠它。 */
  raw?: string
}

/** 翻不出来时说这一句。**不把英文原文当人话摆上去。** */
export const HUMAN_ERROR_UNKNOWN = '出错了(看原始)'

/** 原文最长留多少(与 sessionDigest.FAILURE_RAW_MAX 同刻度)。 */
export const HUMAN_ERROR_RAW_MAX = 200

/**
 * 逐条对照表。**按顺序试,先中先用** —— 前面的比后面的具体(「额度用完」要排在「请求被拒」前面)。
 *
 * `match` 同时试**错误码**(那家自己的 `error` 字段)与**原文**,都是不分大小写的子串 / 正则。
 * 新撞到一条就往这张表里加一行,别在别处再翻一次。
 */
interface Rule {
  match: RegExp
  line: string
  action?: HumanErrorAction
}

const RULES: readonly Rule[] = [
  // —— 登录与身份 ——
  { match: /not logged in|please run \/login|\bauthentication_failed\b|\boauth\b.*(expired|revoked)/i, line: 'Claude 命令行还没登录', action: 'login_claude' },
  { match: /\bcodex\b.*(not logged in|login required)|please run `?codex login/i, line: 'Codex 命令行还没登录', action: 'login_codex' },
  { match: /\bkimi\b.*(not logged in|login required|unauthorized)/i, line: 'Kimi 还没登录', action: 'login_kimi' },
  { match: /invalid api[- ]?key|incorrect api key|\bauthentication_error\b|\binvalid_api_key\b|api key not (found|valid)/i, line: '这家的密钥不对', action: 'credentials' },
  { match: /\bmissing\b.*api[- ]?key|no api key|api key (is )?required/i, line: '这家还没填密钥', action: 'credentials' },
  { match: /\b(401|403)\b|\bunauthorized\b|\bforbidden\b|\bpermission_error\b/i, line: '这家不让用(登录或密钥过期了)', action: 'credentials' },

  // —— 额度与限流 ——
  { match: /credit balance is too low|\binsufficient_quota\b|quota exceeded|out of credits|billing/i, line: '这家的额度用完了', action: 'quota' },
  { match: /\brate_limit\b|rate limit|too many requests|\b429\b/i, line: '这家一会儿才能再用(刚才用得太快)' },
  { match: /\busage limit\b|limit will reset/i, line: '这家今天的用量到顶了', action: 'quota' },

  // —— 上游忙 / 不通 ——
  { match: /\boverloaded_error\b|overloaded|\b503\b|service unavailable|\b502\b|bad gateway/i, line: '这家现在太忙,过一会儿再试' },
  { match: /\b5\d\d\b|\bapi_error\b|internal server error/i, line: '这家自己出错了,过一会儿再试' },

  // —— 网络 ——
  { match: /\bECONNREFUSED\b|connection refused/i, line: '连不上这家的服务' },
  { match: /\bENOTFOUND\b|\bEAI_AGAIN\b|getaddrinfo|dns/i, line: '网络不通(域名解析不了)' },
  { match: /\bETIMEDOUT\b|\bESOCKETTIMEDOUT\b|timed? ?out|deadline exceeded/i, line: '等太久了,没等到回话' },
  { match: /\bECONNRESET\b|socket hang up|premature close|stream (error|closed)/i, line: '连接中途断了' },
  { match: /fetch failed|network (error|request failed)|offline/i, line: '连不上网' },

  // —— 这台机器上的东西 ——
  { match: /command not found|\bENOENT\b.*(spawn|command)|spawn .* ENOENT|is not recognized as/i, line: '这家的命令行没装', action: 'install_client' },
  { match: /\bEACCES\b|permission denied|operation not permitted/i, line: '没有权限读这个位置' },
  { match: /\bENOSPC\b|no space left/i, line: '这台机器磁盘满了' },
  { match: /\bENOENT\b|no such file or directory/i, line: '要读的东西不在了' },

  // —— 这一轮本身 ——
  { match: /\bmax_tokens\b|\bcontext[_ ]length\b|prompt is too long|too many tokens|maximum context/i, line: '这一轮的内容太长了' },
  { match: /model.*(not found|does not exist|unavailable)|\bmodel_not_found\b|unknown model/i, line: '这个模型用不了', action: 'model' },
  { match: /\brefus(al|ed)\b|content (policy|filter)|safety/i, line: '这一句它不肯答' },
  { match: /\baborted\b|\binterrupted\b|\bSIGINT\b|\bcancell?ed\b|user (stopped|canceled)/i, line: '中途停了' },
  { match: /\binvalid_request_error\b|\b400\b|bad request/i, line: '这一次的请求它不认' },
]

/**
 * 翻一段报错。`code` 是那家自己的错误码(Claude `error` 字段这类),`raw` 是那条记录里的原话。
 * 两个都可缺;两个都没有 → `undefined`(没有错误就不要造一个)。
 */
export function humanError(input: { code?: string, raw?: string }): HumanError | undefined {
  const code = input.code?.trim() ?? ''
  const raw = input.raw?.replace(/\s+/g, ' ').trim() ?? ''
  if (code === '' && raw === '') return undefined
  const kept = raw === '' ? code : raw.length <= HUMAN_ERROR_RAW_MAX ? raw : `${raw.slice(0, HUMAN_ERROR_RAW_MAX)}…`
  // 码比原文可信(原文里可能夹着别的句子),所以先拿码试一遍,再拿原文试。
  for (const probe of [code, raw]) {
    if (probe === '') continue
    for (const rule of RULES) {
      if (!rule.match.test(probe)) continue
      return { line: rule.line, ...(rule.action === undefined ? {} : { action: rule.action }), ...(kept === '' ? {} : { raw: kept }) }
    }
  }
  return { line: HUMAN_ERROR_UNKNOWN, ...(kept === '' ? {} : { raw: kept }) }
}

/** 翻得出来吗(体检那一格要分「说得清」与「只能看原始」两种写法)。 */
export function isKnownError(input: { code?: string, raw?: string }): boolean {
  return humanError(input)?.line !== undefined && humanError(input)?.line !== HUMAN_ERROR_UNKNOWN
}
