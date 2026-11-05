/**
 * 脱敏(2026-09-22)。诊断包与自动上报**共用这一份规则** —— 两套规则迟早会漂,
 * 而漂掉的那一次就是一把钥匙被发出去的那一次。
 *
 * ## 三层,不是一层
 *
 * 1. **不进包**:凭据文件整份排除(pack.ts 的 `EXCLUDED_NAMES`)。这一层是结构性的 ——
 *    不读就不可能漏,而不是"读进来再擦干净"。
 * 2. **擦文本**(`redactText`):日志、栈、命令输出里出现的令牌形状。
 * 3. **擦对象**(`redactJson`):`/state`、`/channel/status` 这些快照里,
 *    **按键名**把敏感格整格换掉 —— 它们的值可能不是字符串(对象、数组),
 *    光靠正则扫字符串扫不到。
 *
 * ## 路径里的用户名为什么只换名字、不换整条路径
 *
 * 卡上写的是「去掉路径里的用户名之外的敏感项」。反过来说就是:**路径本身要留着**。
 * 排障十有八九要看"它在找哪个文件",把 `/Users/<用户>/.dsh/workbench/app.json`
 * 整条抹掉等于把病历撕了。所以只换掉 `/Users/` 后面那一段。
 *
 * ## 为什么不做「看着像随机串就擦」
 *
 * 试过这个念头,不做:sha256、session id、房间名、UUID 全是随机串,而它们正是排障时
 * 最要看的东西。宁可规则窄一点、逐条列明(下面每一条都写了它擦的是谁),
 * 也不要一个"擦得很干净但什么也看不出来"的包。
 *
 * ## 这一份与中转那一份的关系
 *
 * 中转 `relay/server/diag.cjs` 里有一份**更窄**的 `scrubDiagText`,是第二张网:
 * 设备上跑的可能是三个月前那一版插件,它的规则表比服务器旧。两头都擦,谁也不指望对方。
 */

/** 家目录里那一段用户名的占位。中转那边用的是同一个串(对得上才好 grep)。 */
export const USER_PLACEHOLDER = '<用户>'

/** 值被整格换掉时写的那句话。写成人话而不是 `***`:看包的人要知道"这里本来有东西"。 */
export const REDACTED = '<已脱敏>'

/**
 * 按**键名**判定的敏感格。命中就把值整格换成 `REDACTED`,不管它是字符串、对象还是数组。
 *
 * 逐条理由:
 * - `token` / `access_token` / `refresh_token` —— 设备令牌、DSH 网页 token、LiveKit 进房凭证;
 * - `secret` / `password` / `passwd` —— 不用解释;
 * - `api_key` / `apikey` / `key`(整词)—— DeepSeek / 火山 / LiveKit 的 key;
 * - `cookie` / `set-cookie` —— Kimi 网页登录那条路;
 * - `authorization` —— 请求头;
 * - `pairing` —— **整格换掉**。配对码就是钥匙(http.ts:「配对码只给本机来源:它就是钥匙」),
 *   而它在 `/state` 里是 `pairing.code`。这里换掉的是整个 `pairing` 那一格,而不是
 *   把 `code` 加进这张表 —— 因为 `code` 这个名字在诊断里另有其人(界面报错的那个短编号),
 *   把它列进敏感键会把最该看见的那样东西擦掉;
 * - `credentials` —— 整块。
 *
 * **`key` 用整词匹配**:不然 `keyboard`、`hotkey`、`monkey` 都会被误伤,
 * 而 `dock.keys` 这种结构正是要看的。
 */
export const SENSITIVE_KEY_RE = /^(token|access_token|refresh_token|id_token|relay_token|secret|api_?secret|password|passwd|api_?key|key|cookie|set_?cookie|authorization|auth|credential|credentials|pairing|pair_code|pairing_code|session_key|private_key)$/i

/**
 * 一段文本里的密钥形状。**顺序有讲究**:先擦带标签的(`token=`、`Bearer`),
 * 再擦按前缀认得出的(`wb_`、`sk-`),最后擦路径里的用户名 ——
 * 反过来的话 `/Users/example/` 里那一段会先被别的规则吃掉半截,留下更难读的残骸。
 */
export function redactText(text: string): string {
  if (typeof text !== 'string' || text === '') return ''
  return text
    // Authorization: Bearer <随便什么>
    .replace(/(Bearer\s+)\S+/gi, `$1${REDACTED}`)
    // ?token=… / &access_token=… / "api_key": "…" / secret=… / password=…
    // (DSH 的网页地址 `http://127.0.0.1:3080/?token=…` 正是被这一条擦掉的,
    //  而那一行就躺在 ~/.dsh/logs/web.stdout.log 的第一行)
    .replace(
      /((?:access_|refresh_)?token|api[_-]?key|secret|password|passwd|cookie|auth)(["']?\s*[:=]\s*["']?)[A-Za-z0-9._~+/=-]{8,}/gi,
      `$1$2${REDACTED}`,
    )
    // 我们自己那把设备令牌(relay/server/tokens.cjs 的 `wb_` 前缀)
    .replace(/\bwb_[A-Za-z0-9_-]{8,}/g, `wb_${REDACTED}`)
    // OpenAI / DeepSeek / Moonshot 形状的 Key
    .replace(/\bsk-[A-Za-z0-9_-]{8,}/g, `sk-${REDACTED}`)
    // JWT(LiveKit 的进房凭证、各家的会话令牌)
    .replace(/\beyJ[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}/g, `eyJ${REDACTED}`)
    // 家目录里的用户名。**路径本身留着** —— 理由见文件头。
    .replace(/\/Users\/[^/\s"'`,;)\]]+/g, `/Users/${USER_PLACEHOLDER}`)
    .replace(/\/home\/[^/\s"'`,;)\]]+/g, `/home/${USER_PLACEHOLDER}`)
}

/** 一条路径:只换用户名,别的一律不动(文件清单里用它,免得连目录结构都看不出来)。 */
export function redactPath(path: string): string {
  if (typeof path !== 'string') return ''
  return path
    .replace(/\/Users\/[^/]+/g, `/Users/${USER_PLACEHOLDER}`)
    .replace(/\/home\/[^/]+/g, `/home/${USER_PLACEHOLDER}`)
}

/**
 * 一整棵 JSON:字符串过 `redactText`,敏感键整格换掉,别的原样。
 *
 * 深度封顶 12 层:`/state` 是一棵挺深的树,而无限递归遇上循环引用会当场把服务转死。
 * 超过深度的那一支写成一句话,而不是悄悄丢掉(D13:「没查出来」不能显示成「没有」)。
 */
export function redactJson(value: unknown, depth = 0): unknown {
  if (depth > 12) return '<太深,略>'
  if (typeof value === 'string') return redactText(value)
  if (value === null || typeof value === 'number' || typeof value === 'boolean') return value
  if (Array.isArray(value)) {
    // 数组封顶 500 条:recent_switches 那种环是 10 条,但会话列表可以很长,
    // 而一份诊断包不该因为某一格有三千条而变成几十兆。
    const kept = value.slice(0, 500).map(item => redactJson(item, depth + 1))
    return value.length > 500 ? [...kept, `<还有 ${value.length - 500} 条,略>`] : kept
  }
  if (typeof value !== 'object') return undefined
  const out: Record<string, unknown> = {}
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (SENSITIVE_KEY_RE.test(key)) { out[key] = REDACTED; continue }
    const next = redactJson(item, depth + 1)
    if (next !== undefined) out[key] = next
  }
  return out
}

/** 一段多行文本整段脱敏(按行做,免得一条超长的行把正则拖慢)。 */
export function redactLines(lines: readonly string[]): readonly string[] {
  return lines.map(line => redactText(line))
}
