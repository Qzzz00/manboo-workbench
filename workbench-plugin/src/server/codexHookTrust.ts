/**
 * Codex 放没放行工作台的钩子(2026-10-21,卡「Codex 钩子信任」)。
 *
 * ## 为什么要有这一份
 *
 * 新版 Codex(ChatGPT 桌面版自带的 codex-cli 0.162)对钩子多了一道「信任」:新加的、改过的钩子
 * 要她在 Codex 里点一次放行,**没放行之前一律静悄悄跳过** —— 桌面 App 与 `codex exec` 都一样,
 * 不报错、不提示。我们那三条(Stop / UserPromptSubmit / SessionEnd)写进 `~/.codex/hooks.json`
 * 之后从来没被放行过,所以一直没跑(10-21 本机实测,经过见 `docs/交接-1021-Codex钩子信任.md`)。
 * 「钩子写进去了」(clientScan 的判据)≠「Codex 在跑它」—— 这一份回答的是后一件事。
 *
 * ## 判据只认 Codex 自己的回答
 *
 * 问的是 app-server 的 `hooks/list`:每条钩子带 `trustStatus`(trusted / untrusted / modified / managed)
 * 与 `enabled`。**不自己复刻它的指纹算法**(它按「事件 + matcher + 命令 + 钳过的超时」算 sha256、
 * 按「文件:事件:第几组:第几条」记在 config.toml):那是它的内部细节,升级一次就可能对不上,
 * 我们会把「已放行」说成「没放行」,叫她去点一个早就点过的东西。
 *
 * ## 只在该问的时候问
 *
 * 起一次 `codex app-server` 要一秒多,体检一分钟跑一次。放行与否只会随两个文件变:
 * `hooks.json`(钩子本身)与 `config.toml`(她点的信任记在这里)。两份都没变就用上次的结论;
 * 配置里根本没有工作台的钩子就**一个进程都不起**(没接过 Codex 的人不该被问到)。
 * 问不到时隔一阵再问,不每拍都起进程。
 */
import { createHash } from 'node:crypto'
import { wbHookCommands } from './clientScan.ts'
import { wbHooksMentionsOurScript } from './hooksConfig.ts'

/** 问的那一句。 */
export const CODEX_HOOK_TRUST_METHOD = 'hooks/list'

/** 去哪儿点、点哪颗(定义在 hooksConfig.ts,手工贴的那段说明也要用;这里转一手,体检页从这儿拿)。 */
export { CODEX_TRUST_HOW } from './hooksConfig.ts'

/** 问不到之后隔多久再问。 */
export const CODEX_HOOK_TRUST_RETRY_MS = 5 * 60 * 1000

/**
 * 放没放行。`count` 是 Codex 列出来的、工作台自己的那几条(新旧两种位置都认,与代写、撤回同一个判据)。
 *
 * - `trusted`      都放行了(管理员统一下发的 `managed` 也算);
 * - `needs_review` 有没放行的(`untrusted`)或放行之后变过的(`modified`:命令改过、或前面多插了一组把它挤了位置);
 * - `disabled`     放行过,但她在 Codex 里把它关了 —— 再点「信任」没用,要打开;
 * - `not_wired`    配置里压根没有工作台的钩子(那是「接上」那颗按钮的事,这里不催);
 * - `not_loaded`   配置里有,Codex 一条都没列出来(钩子功能被关了、或者它读不了那份文件);
 * - `unknown`      问不到(Codex 没装、起不来、老版本不认这一问)。**不猜成任何一边**。
 */
export type CodexHookTrust =
  | { state: 'trusted', count: number }
  | { state: 'needs_review', count: number, pending: number, modified: number }
  | { state: 'disabled', count: number, disabled: number }
  | { state: 'not_wired' }
  | { state: 'not_loaded' }
  | { state: 'unknown' }

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}

/** 把 `hooks/list` 的回包翻成上面那几种。纯函数。 */
export function codexHookTrustFromList(raw: unknown): CodexHookTrust {
  const data = asRecord(raw)?.data
  if (!Array.isArray(data)) return { state: 'unknown' }
  const ours = new Map<string, { trust: unknown, enabled: unknown }>()
  for (const entry of data) {
    const hooks = asRecord(entry)?.hooks
    if (!Array.isArray(hooks)) return { state: 'unknown' }
    for (const item of hooks) {
      const hook = asRecord(item)
      if (hook === undefined || typeof hook.command !== 'string' || !wbHooksMentionsOurScript(hook.command)) continue
      // 同一条在几个 cwd 下各列一次:按 Codex 自己的 key 去重。
      const key = typeof hook.key === 'string' ? hook.key : `${String(hook.eventName)}:${hook.command}`
      ours.set(key, { trust: hook.trustStatus, enabled: hook.enabled })
    }
  }
  if (ours.size === 0) return { state: 'not_loaded' }

  const all = [...ours.values()]
  const untrusted = all.filter(one => one.trust === 'untrusted').length
  const modified = all.filter(one => one.trust === 'modified').length
  if (untrusted + modified > 0) return { state: 'needs_review', count: all.length, pending: untrusted + modified, modified }
  const off = all.filter(one => one.enabled === false).length
  if (off > 0) return { state: 'disabled', count: all.length, disabled: off }
  // 剩下的应当全是 trusted / managed;认不出的状态不算放行。
  if (all.every(one => one.trust === 'trusted' || one.trust === 'managed')) return { state: 'trusted', count: all.length }
  return { state: 'unknown' }
}

export interface CodexHookTrustProbeDeps {
  readFile: (path: string) => Promise<string | undefined>
  /** 问 app-server 一句(生产是 `askCodexAppServerOnce`,开一条、问一句、关掉)。 */
  ask: (method: string, params: unknown) => Promise<unknown>
  /** `~/.codex/hooks.json`。 */
  hooksFile: string
  /** `~/.codex/config.toml` —— 她点的信任记在这里。 */
  configFile: string
  /** 问的时候报给它的工作目录。用家目录:用户那一层的钩子与 cwd 无关,家目录底下也没有项目那一层。 */
  cwd: string
  now: () => number
  retryMs?: number
}

export interface CodexHookTrustProbe {
  check: () => Promise<CodexHookTrust>
}

/** 只留摘要,不把 config.toml 原文挂在内存里(那里可能有别的工具的令牌)。 */
function digest(text: string | undefined): string {
  return createHash('sha256').update(text ?? '').digest('hex')
}

export function createCodexHookTrustProbe(deps: CodexHookTrustProbeDeps): CodexHookTrustProbe {
  const retryMs = deps.retryMs ?? CODEX_HOOK_TRUST_RETRY_MS
  let last: { key: string, at: number, result: CodexHookTrust } | undefined
  let inflight: Promise<CodexHookTrust> | undefined

  async function run(): Promise<CodexHookTrust> {
    const hooksText = await deps.readFile(deps.hooksFile)
    if (hooksText === undefined || wbHookCommands(hooksText).length === 0) return { state: 'not_wired' }
    const key = `${digest(hooksText)}:${digest(await deps.readFile(deps.configFile))}`
    if (last !== undefined && last.key === key && (last.result.state !== 'unknown' || deps.now() - last.at < retryMs)) {
      return last.result
    }
    let result: CodexHookTrust
    try { result = codexHookTrustFromList(await deps.ask(CODEX_HOOK_TRUST_METHOD, { cwds: [deps.cwd] })) }
    catch { result = { state: 'unknown' } }
    last = { key, at: deps.now(), result }
    return result
  }

  return {
    check: () => {
      // 体检与别处同一拍一起问时只起一个进程。
      inflight ??= run().finally(() => { inflight = undefined })
      return inflight
    },
  }
}
