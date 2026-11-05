/**
 * **Antigravity 的额度:直接问它自己在本机的语言服务**(2026-09-27,卡 AN)。
 *
 * 依据 `docs/调研-0927-各家额度原生来源.md` 第 2.1 节与 `docs/交接-0927-Antigravity额度四行.md` 第七节。
 * 维护者 2026-09-27 11:15 已拍板(原话「可以的」)。
 *
 * ## 这条路是什么
 *
 * Antigravity(`com.google.antigravity`)启动时自己拉起一个 Go 写的语言服务
 * (`/Applications/Antigravity.app/Contents/Resources/bin/language_server --standalone …`),
 * 监听 **127.0.0.1** 上两个端口(启动参数写的是 `--https_server_port 0`,所以**每次都是随机的**)。
 * 它设置页「Models & Usage」那一页的数,就是打自己这个口拿的:
 * `POST /exa.language_server_pb.LanguageServerService/RetrieveUserQuotaSummary`。
 *
 * 我们打的就是这一个口:**不出本机、不碰 Google 账号、不多花一分额度、不绕过任何计费。**
 *
 * ## 令牌那件事(纪律,一个字都不许松)
 *
 * 这个口要一个 CSRF 令牌,请求头名 `x-codeium-csrf-token`。
 * **它的令牌是它自己放在命令行与日志里的**(`--csrf_token=…` 明明白白写在进程参数里,
 * 也明文写在 `~/Library/Logs/Antigravity/` 下它自己的日志里)——**这不是我们造成的**;
 * 我们只是**现取现用、用完就丢**:
 *
 * - 只从 `ps` 的进程参数里现取,**每次读都重新取**(它每次启动都换一个,记住的那个必然是错的);
 * - 取出来**只进变量、只进请求头**;
 * - **不进** `credentials.json`、不进日志、不进 `note`、不进 `source`、不进任何错误信息、
 *   不进用例夹具、不进提交、不进交接文档(同 `credentials.ts` / `claudeHeaders.ts` 那一套);
 * - 往外抛的每一句话都先过一遍 `scrub()`,把令牌换成 `***` 再抛
 *   —— 上游回的原文里也可能带着它(它自己会把令牌回显在错误里)。
 *
 * ## 读不到的时候
 *
 * **一律抛错,绝不编一个数(D13)。** 每一步各说各的话,好让他知道下一步该干嘛:
 * 它没在跑 / 进程参数里没有那个令牌(它换版本了)/ 一个口都没监听 /
 * 令牌不对 / 真的没登录 / 它回的形状不认识。
 * `agentQuota.ts` 接到这几种一律退回**窗口读法**那条兜底,并在「说明」里写清走的是哪一条。
 *
 * ## 实测的那几个数(2026-09-27 11:2x,本机,连跑五次)
 *
 * | 一段 | 实测 |
 * |---|---|
 * | `ps`(现取令牌) | 44ms |
 * | `lsof`(现查端口) | 19ms |
 * | **整趟(给 `forceRefresh`,回源)** | **399 / 607 / 651 / 893 / 914 / 968ms** |
 * | 整趟(不给 `forceRefresh`,吃它自己的缓存) | 54 / 55 / 58ms |
 *
 * 所以「从他用完一轮到工作台上数字变」= 事件触发那 1.2 秒防抖 + 这一趟 ≈ **1.6 ~ 2.2 秒**
 * (对照:窗口读法那条实测约 2.4 秒,卡 AG 第四节;10 分钟那一轮是兜底)。
 *
 * **为什么明知慢十几倍还是要 `forceRefresh`**:不给它的时候拿的是语言服务自己内存里的缓存
 * —— 实测同一刻两种打法回的 5h 那条**重置时刻不一样**(缓存那份是旧的),
 * 而这条路的全部意义就是「他刚用完就能看见新数」。多花的那半秒是**它自己去回源**,
 * 不多花他一分额度(这是一次查用量,不是一次推理)。
 */

/** 它的包标识 —— 兜底那条(窗口读法)走的是同一家。 */
export const ANTIGRAVITY_BUNDLE_ID = 'com.google.antigravity'

/** 实测过的那个方法(Connect-RPC,JSON 编码)。 */
export const ANTIGRAVITY_QUOTA_PATH = '/exa.language_server_pb.LanguageServerService/RetrieveUserQuotaSummary'

/** 请求头名(调研 2.1 查实、2026-09-27 实测确认)。 */
const CSRF_HEADER = 'x-codeium-csrf-token'

/** 一条限额。`leftPct` 是**剩余**(它自己给的就是 `remainingFraction`,不用换算、不会读反)。 */
export interface AntigravityBucket {
  id: string
  label: string
  window?: string
  leftPct: number
  resetAt?: string
  disabled?: boolean
}

/** 一组(「Gemini Models」「Claude and GPT models」)。组名是它自己给的 `displayName`,不是我们起的。 */
export interface AntigravityGroup {
  name: string
  buckets: AntigravityBucket[]
}

/** 把令牌从任何一段要往外抛的字里抹掉。 */
function scrub(text: string, token: string): string {
  return token === '' ? text : text.split(token).join('***')
}

/**
 * 从 `ps -Ao pid,command` 的输出里找它的语言服务:**pid + 令牌**。
 *
 * 找不到进程、或者进程在但参数里没有 `--csrf_token`(它换了版本 / 它不再这么放),一律回 `undefined`
 * —— **不拿别的参数凑数**(`--host_bridge_token` 是另一件东西,不是这个口要的)。
 */
export function antigravityProcess(psOutput: string): { pid: number, token: string } | undefined {
  for (const line of psOutput.split('\n')) {
    if (!line.includes('Antigravity.app/Contents/Resources/bin/language_server')) continue
    const pid = /^\s*(\d+)\s/.exec(line)
    // 只认 `--csrf_token`(`=` 或空格分隔)。前面那个 `-` 要挡住 `--host_bridge_token` 这类别的令牌。
    const token = /(?:^|\s)--csrf_token[=\s]([^\s]+)/.exec(line)
    if (pid === null || token === null) continue
    return { pid: Number(pid[1]), token: token[1] ?? '' }
  }
  return undefined
}

/**
 * 从 `lsof -nP -p <pid>` 的输出里找它在 **127.0.0.1** 上监听的那几个口。
 * 只认 `(LISTEN)`;连出去的那几条(`->`)不算。
 */
export function antigravityPorts(lsofOutput: string): number[] {
  const ports: number[] = []
  for (const line of lsofOutput.split('\n')) {
    if (!line.includes('(LISTEN)')) continue
    const hit = /\s127\.0\.0\.1:(\d+)\s+\(LISTEN\)/.exec(line)
    if (hit === null) continue
    const port = Number(hit[1])
    if (!ports.includes(port)) ports.push(port)
  }
  return ports
}

/** 顶层有哪些字段(只记**字段名**、不记值)—— 形状变了时靠这一行查是不是接口改了。 */
function fieldsOf(value: unknown): string {
  if (typeof value !== 'object' || value === null) return typeof value
  return Object.keys(value as Record<string, unknown>).join(' / ')
}

/**
 * 实测回来的那一份 → `groups[].buckets[]`。
 *
 * **形状照 2026-09-27 实测**(不是照 protobuf 描述猜的):
 * `{ "response": { "groups": [ { "displayName", "description", "buckets": [
 *    { "bucketId", "displayName", "window", "remainingFraction", "resetTime" } ] } ] } }`
 * (Connect 的 JSON 编码是驼峰;有的调用方式不带 `response` 那层包装,两种都认。)
 *
 * 两条纪律:
 * - **顶层那个 `buckets` 一个字都不读** —— 它自己的描述里标着 deprecated,读它就是读错帐;
 * - `remainingFraction` / `disabled` **缺席 = 默认值**(proto3 的 JSON 不发默认值,
 *   所以「剩 0%」回来就是**没有这一格**)。这不算猜:同一条里 `bucketId` 与 `displayName`
 *   还在,就说明字段名没漂;真要是接口改了名,那两格会一起没,下面直接抛错。
 */
export function parseAntigravityQuota(raw: unknown): AntigravityGroup[] {
  const top = raw as { response?: unknown } | null
  const body = (typeof top === 'object' && top !== null && 'response' in top ? top.response : raw) as
    { groups?: unknown } | null
  if (typeof body !== 'object' || body === null || !Array.isArray(body.groups)) {
    throw new Error(`Antigravity 的语言服务回的形状不认识(它给的是:${fieldsOf(body)})`)
  }
  const out: AntigravityGroup[] = []
  for (const one of body.groups) {
    const group = one as { displayName?: unknown, buckets?: unknown }
    if (typeof group?.displayName !== 'string' || !Array.isArray(group.buckets)) {
      throw new Error(`Antigravity 的语言服务回的形状不认识:这一组里没有 displayName / buckets(它给的是:${fieldsOf(group)})`)
    }
    const buckets: AntigravityBucket[] = []
    for (const item of group.buckets) {
      const bucket = item as {
        bucketId?: unknown, displayName?: unknown, window?: unknown,
        remainingFraction?: unknown, resetTime?: unknown, disabled?: unknown,
      }
      if (typeof bucket?.bucketId !== 'string' || typeof bucket.displayName !== 'string') {
        throw new Error(`Antigravity 的语言服务回的形状不认识:这一条限额里没有 bucketId / displayName(它给的是:${fieldsOf(bucket)})`)
      }
      // 缺席 = 0(proto3 JSON 不发默认值)。0..1 → 0..100,四舍五入。
      const fraction = typeof bucket.remainingFraction === 'number' ? bucket.remainingFraction : 0
      buckets.push({
        id: bucket.bucketId,
        label: bucket.displayName,
        ...(typeof bucket.window === 'string' && bucket.window !== '' ? { window: bucket.window } : {}),
        leftPct: Math.max(0, Math.min(100, Math.round(fraction * 100))),
        ...(typeof bucket.resetTime === 'string' && bucket.resetTime !== '' ? { resetAt: bucket.resetTime } : {}),
        ...(bucket.disabled === true ? { disabled: true } : {}),
      })
    }
    out.push({ name: group.displayName, buckets })
  }
  return out
}

/** 打一次那个口回来的原样(状态码 + 正文)。注入用。 */
export interface AntigravityPostResult { status: number, text: string }

export interface AntigravityNativeDeps {
  /** `ps -Ao pid,command` 的输出。 */
  ps: () => Promise<string>
  /** `lsof -nP -p <pid>` 的输出。 */
  lsof: (pid: number) => Promise<string>
  /** 打一次(url、请求头、正文)。**令牌就在请求头里,这一层不许把它记到任何地方。** */
  post: (url: string, headers: Record<string, string>, body: string) => Promise<AntigravityPostResult>
}

/** 它回这句话的意思是「这个口是 HTTPS,你用 HTTP 打的」—— 换个前缀再试一次就好。 */
function wantsTls(result: AntigravityPostResult): boolean {
  return result.status === 400 && /HTTP request to an HTTPS server/i.test(result.text)
}

/**
 * 读一次。成功回 `groups`;**每一种读不到都抛一句说清卡在哪一步的话**(绝不回一个编的数,D13)。
 *
 * 两个口哪个是 HTTP、哪个是 HTTPS **每次启动都不一定**,所以每个口都先用 HTTP 打;
 * 它说「这是 HTTPS 口」或者干脆连不上,就换成 HTTPS 再试同一个口(它的证书是自签的,
 * 所以默认那一层实现关掉了证书校验 —— **只对 127.0.0.1 这一个地址**)。
 */
export async function readAntigravityNative(deps: AntigravityNativeDeps): Promise<AntigravityGroup[]> {
  const found = antigravityProcess(await deps.ps())
  if (found === undefined) {
    throw new Error('Antigravity 没在跑(找不到它自己的语言服务,或者它换了版本、不再把那个令牌放在进程参数里)')
  }
  const { pid, token } = found
  const ports = antigravityPorts(await deps.lsof(pid))
  if (ports.length === 0) throw new Error('Antigravity 的语言服务没在本机监听端口(它可能刚起来,等一会儿再读)')

  const headers = { 'content-type': 'application/json', [CSRF_HEADER]: token }
  // 不给 `forceRefresh` 拿的是它自己内存里的缓存(实测:5h 那条的重置时刻会是旧的),所以要回源。
  const body = JSON.stringify({ forceRefresh: true })
  let last: Error | undefined

  for (const port of ports) {
    for (const scheme of ['http', 'https'] as const) {
      const url = `${scheme}://127.0.0.1:${port}${ANTIGRAVITY_QUOTA_PATH}`
      let result: AntigravityPostResult
      try { result = await deps.post(url, headers, body) }
      catch (error) {
        // 连不上这个口(另一个口、或者换成 HTTPS 再试)。
        last = new Error(scrub(`打不开 Antigravity 在本机的那个口:${error instanceof Error ? error.message : String(error)}`, token))
        continue
      }
      if (scheme === 'http' && wantsTls(result)) continue
      // ★ 401 必须分清两件事,**不许悄悄降级成「没数」**(同 `claudeScoped.ts` 那条 403 的规矩):
      //   令牌不对(我们取错了 / 它刚换过)≠ 他真的没登录 Antigravity。
      if (result.status === 401 || result.status === 403) {
        const said = scrub(result.text, token)
        if (/unauthenticated|not logged in|logged out|sign in/i.test(said)) {
          throw new Error('Antigravity 说这台机器上没登录 —— 去它里面登一次')
        }
        throw new Error('Antigravity 的语言服务不认这个令牌(它多半刚重启过、换了一个)—— 下次读会重新取')
      }
      if (result.status !== 200) {
        throw new Error(scrub(`Antigravity 的语言服务回了 ${result.status}:${result.text.slice(0, 80)}`, token))
      }
      let raw: unknown
      try { raw = JSON.parse(result.text) }
      catch { throw new Error('Antigravity 的语言服务回的不是 JSON') }
      return parseAntigravityQuota(raw)
    }
  }
  throw last ?? new Error('Antigravity 在本机的那几个口都没应答')
}

/**
 * 默认那一层实现:`ps` / `lsof` / 打一次。
 *
 * **证书校验只对 `127.0.0.1` 这一个地址关掉** —— 它的 HTTPS 口是自签的,而这条链路**根本不出本机**。
 */
export function antigravityNativeDeps(): AntigravityNativeDeps {
  return {
    ps: async () => await run('ps', ['-Ao', 'pid,command']),
    lsof: async (pid) => await run('lsof', ['-nP', '-p', String(pid)]),
    post: async (url, headers, body) => await post(url, headers, body),
  }
}

async function run(file: string, args: readonly string[]): Promise<string> {
  const { execFile } = await import('node:child_process')
  return await new Promise<string>((resolve, reject) => {
    execFile(file, [...args], { maxBuffer: 8 * 1024 * 1024, timeout: 5_000 }, (error, stdout) => {
      // `lsof` 有东西可回的时候也可能带非零退出码(有些 fd 它看不了),有输出就当成了。
      if (error !== null && (stdout ?? '') === '') reject(error)
      else resolve(stdout ?? '')
    })
  })
}

async function post(url: string, headers: Record<string, string>, body: string): Promise<AntigravityPostResult> {
  const tls = url.startsWith('https://')
  const mod = tls ? await import('node:https') : await import('node:http')
  return await new Promise<AntigravityPostResult>((resolve, reject) => {
    const req = mod.request(url, {
      method: 'POST',
      headers: { ...headers, 'content-length': String(Buffer.byteLength(body)) },
      timeout: 5_000,
      // 只对 127.0.0.1 的自签证书;这条链路不出本机。
      ...(tls ? { rejectUnauthorized: false } : {}),
    }, (res) => {
      let text = ''
      res.setEncoding('utf8')
      res.on('data', (chunk: string) => { text += chunk })
      res.on('end', () => { resolve({ status: res.statusCode ?? 0, text }) })
    })
    req.on('timeout', () => { req.destroy(new Error('超时')) })
    req.on('error', reject)
    req.end(body)
  })
}
