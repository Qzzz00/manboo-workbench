/**
 * 一次额度采集：四家来源各出一条 QuotaEntry（PRD §8.2）。
 *
 * 四家的取数方式各不相同：
 * - DeepSeek：官方 `GET /user/balance`，余额型，今日消耗由两次读数推。
 * - Codex：两条路按新鲜度排队——`codex app-server` 的 `account/rateLimits/read`（**唯一实时的**，
 *   走 Codex 自己的登录态，我们不经手凭据）→ 本机 `~/.codex/sessions/**\/*.jsonl` 里的
 *   rate_limits（兜底，只在他真的用 Codex 时才更新）。取舍见下面的 collectCodex。
 * - Kimi：网页端计费接口，需要网页登录态 Cookie。不用 `sk-kimi-` 那个 Coding Plan Key——
 *   它只覆盖 Code 部分的窗口，拿不到「Kimi + Code 合并」的总使用量。
 * - Claude：三条路按新鲜度排队——自发 1 token 请求读响应头（**唯一实时的**，需要
 *   `claude setup-token`）→ 桌面端的本地用量记录（不需凭据，慢一个采样间隔）→
 *   statusLine 推来的值（兜底）。取舍见下面的 collectClaude。
 *
 * 纪律：
 * - 四家都要出现在结果里。接不上的产出 UnknownQuota 并写明原因，界面据此标"未接入"，
 *   而不是显示 0——显示 0 会被误读成"额度耗尽"。
 * - 任何一家失败都不能拖垮其余三家。
 * - API Key 只从环境变量读，不落进返回值、note 或日志。
 */
import type { AgentId, QuotaEntry, QuotaWindow } from '../protocol.ts'
import type { Credentials } from '../server/credentials.ts'
import { AGENT_IDS } from '../protocol.ts'
import type { DailySpendState } from './dailySpend.ts'
import { localDay, trackDailySpend } from './dailySpend.ts'
import type { CodexIo } from './codex.ts'
import { collectCodexQuota } from './codex.ts'
import type { CodexAppServerIo } from './codexAppServer.ts'
import { collectCodexAppServerQuota, defaultCodexAppServerIo } from './codexAppServer.ts'
import type { PeakSchedule } from './peakHours.ts'
import { peakPhase } from './peakHours.ts'
import type { FetchLike } from './deepseek.ts'
import { fetchDeepSeekBalance } from './deepseek.ts'
import type { RelayView } from './relay.ts'
import { relayQuotaEntry } from './relay.ts'
import { fetchKimiWebUsageWithRefresh } from './kimiWeb.ts'
import type { ClaudeDesktopIo } from './claudeDesktop.ts'
import { readClaudeDesktopUsage } from './claudeDesktop.ts'
import { claudeKeyRejected, fetchClaudeHeaderQuota } from './claudeHeaders.ts'
// 过线那一格该说什么(卡 QK):一家一条,声明在那一处;这里只把它盖到 entry 上。
// 2026-10-03:那把密钥被拒时改说的那一句也在那一处(CLAUDE_KEY_REJECTED_WHY)。
import { CLAUDE_KEY_REJECTED_WHY, quotaStaleHintFor } from './liveSources.ts'
import type { ClaudeScopedGate } from './claudeScopedGate.ts'
import type { ClaudeRenewGate } from './claudeRenewGate.ts'
import {
  mergeRefreshedCredential,
  pickOauthRefreshToken,
  refreshClaudeOauth,
} from './claudeOauth.ts'
import {
  claudeCodeUserAgent,
  fetchClaudeScopedWeekly,
  oauthTokenExpiry,
  pickOauthAccessToken,
  RELOGIN_HINT,
} from './claudeScoped.ts'

/** 切天与峰谷判定共用的时区。采集循环恢复账本时也要用同一个,所以导出。 */
export const DEFAULT_TIME_ZONE = 'Asia/Shanghai'

export interface CollectQuotaOptions {
  /** 环境变量表。API Key 只从这里来，默认取 process.env。 */
  env?: Record<string, string | undefined>
  /** 可注入的 fetch，测试用桩，绝不打真实网络。 */
  fetch?: FetchLike
  /** 采集时刻，用于按本地时区切"今天"。 */
  now?: Date
  /**
   * 上一次采集留下的今日消耗账本；不传则本次只建基线。
   * 显式写出 `| undefined`：调用方通常直接把上一轮结果的 spend 传回来，那个字段本来就可能是 undefined。
   */
  spend?: DailySpendState | undefined
  /**
   * 峰谷时间表(2026-09-09)。传了才给今日消耗分账,不传就只记总数——
   * 分不了账时如实缺席,不硬把消耗塞进某一边(dailySpend.ts 的口径注释)。
   */
  peakSchedule?: PeakSchedule
  timeZone?: string
  preferredCurrency?: string
  /** Codex 会话目录，默认 `$CODEX_HOME` 或 `~/.codex`。 */
  codexHome?: string
  /** 可注入的文件读取，测试用桩，绝不碰真实磁盘。 */
  codexIo?: CodexIo
  /** 可注入的 Codex 实时取数，测试用桩，绝不 spawn 真的 `codex app-server`。 */
  codexAppServerIo?: CodexAppServerIo
  /** Claude 桌面端用量记录的位置，缺省按 $HOME 推。 */
  claudeDesktopFile?: string
  /** 可注入的文件读取，测试用桩，绝不碰真实磁盘。 */
  claudeDesktopIo?: ClaudeDesktopIo
  /**
   * 按模型周窗口（Fable / Opus …）那条路要的两样外部输入，见 claudeScoped.ts。
   * 不传就按本机真实位置读；测试一律注入，绝不碰真实 keychain 与磁盘。
   */
  claudeScopedIo?: ClaudeScopedIo
  /**
   * 按模型周窗口那条路的限频闸门(claudeScopedGate.ts)。**不传就退回原来的无状态行为**
   * ——这一层是「取一次数」,跨轮次的记忆属于采集循环,由 collector.ts 建好按轮传进来。
   */
  claudeScopedGate?: ClaudeScopedGate
  /**
   * OAuth 续期的失败退避闸门(claudeRenewGate.ts,2026-09-02)。同款纪律:不传就退回
   * 原来的无状态行为(每轮都试),跨轮次的记忆由 collector.ts 建好按轮传进来。
   */
  claudeRenewGate?: ClaudeRenewGate
  /**
   * 只采这几家。不传＝四家全采。
   *
   * 给 60 秒那条快路用:它的本意一直是「只重采 Claude 一家」(collectClaudeOnce 的
   * 注释就是这么写的),但实现一直在跑整轮采集——另外三家的上游都是慢变量,
   * 每分钟陪跑一次纯属白打接口,Kimi 那家还会被每分钟换发一个新的 refresh token
   * 然后丢掉(那条路没接存盘回调)。这个开关让承诺和实现对上。
   */
  only?: readonly AgentId[]
  /**
   * Claude 最后一次由 statusLine 推上来的额度；没收到过就不传。
   *
   * 只当兜底：桌面端的用量记录读得到时以它为准（那是每 15 分钟刷新的现值），
   * 读不到才回退到这个推送值——推送值可能是几小时前落盘的，但**有总比没有强**，
   * 至少不会把一个已知数字降级成"未接入"。
   */
  claude?: QuotaEntry | undefined
  /**
   * 上一轮 DeepSeek 那一格是什么(2026-09-18)。**只用来判"旧数还能不能代表现在"**:
   * 走中转时这一轮取不到用量,上一轮若也是中转的数(窗口型)就交给宽限,
   * 上一轮若是官方余额(balance)就当场作废 —— 那是另一个账户的钱,留一轮都是假话。
   */
  dsh?: QuotaEntry | undefined
  /**
   * Ben 在工作台里填的 Key（`~/.dsh/workbench/credentials.json`）。
   * 环境变量优先——那是显式覆盖，调试时不必去改文件。
   */
  credentials?: Credentials
  /**
   * 此刻走不走工作台中转(2026-09-18,quota/relay.ts)。采集循环每轮现读一次 model.json 注入。
   *
   * 缺席 = 这台服务没接中转(展示台、老用例、灰度实例),照官方余额那条老路走。
   */
  relay?: RelayView
  /**
   * Kimi 续期换发了新的 refresh token 时回调，用来落盘。
   * 不接这个回调也能跑，但下一轮就会拿着已经被换掉的旧值去续期——等于自己把自己踢下线。
   */
  onKimiRefreshed?: (refreshToken: string) => void | Promise<void>
}

export interface CollectQuotaResult {
  quota: Record<AgentId, QuotaEntry>
  /** 更新后的今日消耗账本，调用方存下来下次传回。 */
  spend?: DailySpendState
}

const defaultFetch: FetchLike = (url, init) => globalThis.fetch(url, init)

function unknownOf(error: unknown): QuotaEntry {
  // 错误信息在各来源模块里已抹过 key，这里不再拼接任何凭据。
  return { kind: 'unknown', note: error instanceof Error ? error.message : String(error) }
}

/**
 * DeepSeek 那一格：余额 + 今日消耗。返回新账本供下次传回。
 *
 * 2026-09-18 起分三条路，顺序不能换（Ben 真机「清空凭据后还显示 ¥2.26」那张卡）：
 *
 * 1. **走中转** → 报中转的今日用量，**一次都不去问官方余额**。他此刻花的是工作台的额度，
 *    把私人账户那笔钱画在同一格里，是关于钱的假话（而且那把 Key 可能只是 `.env` 里
 *    忘了删的一行）。
 * 2. **没走中转、也没有 Key** → `no_stale` 的 unknown：这不是"这一轮没取到"，是"根本没接"，
 *    上一轮那个数字是用一把已经不在的 Key 取的，一轮都不许再留。
 * 3. 其余 → 照旧问官方余额。
 */
async function collectDeepSeek(
  options: CollectQuotaOptions,
  fetchImpl: FetchLike,
  day: string,
  now: Date,
): Promise<{ entry: QuotaEntry, spend?: DailySpendState }> {
  // 账本原样传下去：这两条路都不产生新的余额读数，今日消耗保持上一次的结论（不清零、也不推进）。
  const keepSpend = options.spend === undefined ? {} : { spend: options.spend }

  if (options.relay?.ready === true) {
    const result = options.relay.usage === undefined
      ? { ok: false as const, error: '这台机器上还没接中转的计量' }
      : await options.relay.usage().catch(error => ({
          ok: false as const,
          error: error instanceof Error ? error.message : String(error),
        }))
    const entry = relayQuotaEntry(result)
    if (entry.kind !== 'unknown') return { entry, ...keepSpend }
    // 取不到用量时，上一轮那一格能不能顶一会儿，取决于它是不是同一条源:
    // 窗口型 = 上一轮也是中转的数 → 交给宽限（一次抖动而已）;
    // 余额型 = 上一轮是官方账户的钱 → 当场作废（这正是 Ben 看到的那 ¥2.26）。
    const sameSource = options.dsh?.kind === 'quota'
    return { entry: sameSource ? entry : { ...entry, no_stale: true }, ...keepSpend }
  }

  const apiKey = (options.env ?? process.env).DEEPSEEK_API_KEY ?? options.credentials?.deepseek
  if (!apiKey) {
    return {
      entry: {
        kind: 'unknown',
        note: '还没接 DeepSeek(去设置里填自己的 API Key,或用工作台提供的服务)',
        no_stale: true,
      },
      ...keepSpend,
    }
  }

  try {
    const balance = await fetchDeepSeekBalance({
      apiKey,
      fetch: fetchImpl,
      ...(options.preferredCurrency === undefined ? {} : { preferredCurrency: options.preferredCurrency }),
    })
    // 峰谷分账:时间表没配(或没传)就只记总数。时区与切天用同一个,免得
    // "算到昨天"和"算成高峰"两处各按各的时区走。
    const phase = options.peakSchedule === undefined
      ? undefined
      : peakPhase(now, options.peakSchedule, options.timeZone ?? DEFAULT_TIME_ZONE).phase
    const spend = trackDailySpend(options.spend, balance.total, day, phase)
    // 当天第一次读数没有前值，报不出今日消耗，这一项就整个不给——不编 0。
    return {
      entry: spend.spent === undefined ? balance : { ...balance, today_spent: spend.spent },
      spend,
    }
  }
  catch (error) {
    return {
      entry: unknownOf(error),
      ...(options.spend === undefined ? {} : { spend: options.spend }),
    }
  }
}

/** Kimi：网页端计费接口，拿得到合并总量。 */
async function collectKimi(
  env: Record<string, string | undefined>,
  fetchImpl: FetchLike,
  credentials: Credentials | undefined,
  onKimiRefreshed: ((refreshToken: string) => void | Promise<void>) | undefined,
): Promise<QuotaEntry> {
  const stored = env.KIMI_WEB_AUTH ?? credentials?.kimi_web
  // 没登录是**确定的结论**,不是这一轮没取到:上一次那几条百分比是用一份已经删掉的
  // 登录态取的,宽限不该把它们留下来(2026-09-18,同 DeepSeek 那条)。
  if (!stored) return { kind: 'unknown', note: '未登录 Kimi（在工作台点登录）', no_stale: true }

  // 旧版存的是 `Bearer <access token>`——那玩意只活 15 分钟，拿它当 refresh token 用必然 401。
  // 与其让人看见一句摸不着头脑的"登录态已失效"，不如直说是存法变了、重登一次即可。
  if (/^Bearer\s/i.test(stored)) {
    return { kind: 'unknown', note: 'Kimi 登录方式已更新（改存长期凭据），在工作台重新登录一次' }
  }

  try {
    return await fetchKimiWebUsageWithRefresh({
      refreshToken: stored,
      fetch: fetchImpl,
      ...(onKimiRefreshed === undefined ? {} : { onRefreshed: onKimiRefreshed }),
    })
  }
  catch (error) {
    return unknownOf(error)
  }
}

/**
 * 按模型周窗口那条路要的外部输入。抽成接口是为了能在测试里注入——
 * 真实实现一个读 keychain、一个列已装版本目录，都不该在单测里发生。
 */
export interface ClaudeScopedIo {
  /** keychain 里 `Claude Code-credentials` 那份 JSON 原文；没有就返回空串。 */
  readKeychain: () => Promise<string>
  /** 已装的 Claude Code 版本目录名，用来拼 UA。 */
  readVersions: () => Promise<readonly string[]>
  /**
   * 把续期换来的新凭据写回 keychain(2026-08-26)。**不提供就不续期**——
   * 换了不写回等于把 Claude Code 的 refresh token 作废(它是轮换的),
   * 那比不续期糟得多,所以这两件事必须成对出现,缺一不做。
   */
  writeKeychain?: (raw: string) => Promise<void>
  /**
   * 首次写回前把原值备份到一个可恢复的地方,返回备份落点(写进 alert 供回滚)。
   * 不提供就不备份,但**写回仍会做读回自检**(见 collectClaudeScoped)。
   */
  backupKeychain?: (raw: string) => Promise<string | undefined>
}

/** keychain 里那条的 service 名。读、写、查 account 必须用同一个。 */
const KEYCHAIN_SERVICE = 'Claude Code-credentials'

/** 本机真实位置：keychain 条目 + Claude Code 版本目录。 */
function defaultScopedIo(): ClaudeScopedIo {
  return {
    async readKeychain() {
      const { execFile } = await import('node:child_process')
      const { promisify } = await import('node:util')
      try {
        const { stdout } = await promisify(execFile)(
          'security',
          ['find-generic-password', '-s', KEYCHAIN_SERVICE, '-w'],
        )
        return stdout.trim()
      }
      catch {
        // 条目不存在（没登录过）就是空串，由 pickOauthAccessToken 当「没有」处理。
        return ''
      }
    },
    async readVersions() {
      const { readdir } = await import('node:fs/promises')
      try {
        return await readdir(`${process.env.HOME ?? ''}/Library/Application Support/Claude/claude-code`)
      }
      catch {
        return []
      }
    },

    /**
     * 把续期换来的新凭据写回 keychain(2026-08-26)。
     *
     * `-U` 是「已存在就更新」;不加它,条目已存在时会直接失败。
     *
     * account **必须沿用条目原来那个,不能猜**:同一个 service 下 account 不同就是两条
     * 不同的条目,猜错等于新建了一条,Claude Code 仍读它原来那条——而那条里的
     * refresh token 已经被我们用掉作废了,等于把它踢下线。所以先把原条目的 `acct`
     * 读出来,读不到就**什么都不写**。
     *
     * 凭据从 stdin 喂进去(`-w` 后不带值),不进命令行参数——命令行同机任何进程都看得见。
     *
     * **两条都带 10 秒超时**:这条路在开发机上验证不了(写 keychain 本身就是那件敏感
     * 操作,分类器也拦着),所以必须假设它可能不按预期走——`-w` 不带值时 security 是
     * "从 stdin 读密码",万一在某些环境下它改去要 TTY,进程就会一直挂着。超时到点
     * 直接 kill,变成一次干净的失败(上层降级成"要重新登录"),而不是把整轮采集拖死。
     */
    async writeKeychain(raw: string) {
      const { execFile } = await import('node:child_process')
      const { promisify } = await import('node:util')

      const { stdout } = await promisify(execFile)(
        'security',
        ['find-generic-password', '-s', KEYCHAIN_SERVICE],
        { timeout: 10_000 },
      )
      const account = /"acct"<blob>="([^"]*)"/.exec(stdout)?.[1]
      if (account === undefined || account === '') {
        throw new Error('读不到 keychain 条目的 account，没敢写')
      }

      await new Promise<void>((resolve, reject) => {
        const child = execFile(
          'security',
          ['add-generic-password', '-U', '-s', KEYCHAIN_SERVICE, '-a', account, '-w'],
          { timeout: 10_000 },
          error => (error === null ? resolve() : reject(new Error('security 写入失败'))),
        )
        child.stdin?.end(raw)
      })
    },

    /**
     * 写回前把原值备份下来。落在 `~/.dsh/workbench/`、权限 0600,
     * 与其它凭据同一套保管规矩;返回路径供 alert 里写明回滚位置。
     */
    async backupKeychain(raw: string) {
      const { mkdir, writeFile } = await import('node:fs/promises')
      const dir = `${process.env.HOME ?? ''}/.dsh/workbench`
      const file = `${dir}/claude-credentials.backup.json`
      await mkdir(dir, { recursive: true })
      await writeFile(file, raw, { mode: 0o600 })
      return file
    },
  }
}

/**
 * 取按模型的周窗口，接在统一窗口后面。
 *
 * 拿不到就返回空——这一栏是**加分项**，它没了不该把已经取到的 5h/周 一起拖下水。
 * 唯一要出声的是 403（缺 user:profile）：那说明该重新 `claude auth login` 了，
 * 闷声少一栏的话，界面会长期停在两栏而没人知道为什么。
 */
/**
 * access token 过期时自己续一次(2026-08-26)。成功返回新的 access token。
 *
 * 做法照抄已上线同类工具的共识(pi-claude-auth / opencode-claude-auth /
 * claude-oauth-refresher,见 claudeOauth.ts 文件头),四道保险缺一不可:
 *
 * 1. **没有写回能力就不续期**。refresh token 是轮换的:换了不写回,Claude Code
 *    下次拿着已作废的旧值去续,会被踢去重新登录——那比不续期糟得多。
 * 2. **续期前重读一次**。这中间 CLI 很可能已经自己续过了;它续过就用它的,
 *    我们连碰都不碰,少一次续期就少一次撞车。
 * 3. **CAS 写回护栏**。续期返回后再读一次:存储里的 access token 若已不是我们
 *    出发时那份,说明 CLI 的续期抢先落了地——**认它的、丢我们的,绝不覆盖**。
 *    (opencode-claude-auth 的原话:"用发起续期时那份 access token 守住写回"。)
 * 4. **备份 + 写后读回自检**。写完立刻读回比对,对不上就把备份还原回去。
 *    这条是因为这段代码没法在开发机上验证(写 keychain 本身就是那件敏感操作),
 *    所以让它在真机上第一次运行时自己验自己。
 */
async function renewClaudeOauth(
  io: ClaudeScopedIo,
  options: CollectQuotaOptions,
  nowMs: number,
): Promise<{ token?: string, detail?: string }> {
  // 保险 1:写不回去就不换。
  if (io.writeKeychain === undefined) return {}

  // 保险 5(2026-09-02):上一次续期失败还在退避窗口里 → 这一轮根本不发请求。
  // 429 的意思是"你敲太快了",60 秒后接着敲只会把惩罚续上(claudeRenewGate.ts 顶部
  // 有完整理由)。如实复述上次的失败原因,不假装什么都没发生。
  const renewGate = options.claudeRenewGate
  if (renewGate !== undefined && !renewGate.shouldTry(nowMs)) {
    const waiting = renewGate.waitingNote()
    return { detail: waiting === undefined ? '（自动续期在退避中）' : `（自动续期在退避中：${waiting}）` }
  }

  let before: string
  try {
    before = await io.readKeychain() // 保险 2:续期前重读
  }
  catch {
    return {}
  }

  // CLI 抢先续过了 → 直接用它的,不发起自己的续期。
  const freshExpiry = oauthTokenExpiry(before)
  const freshToken = pickOauthAccessToken(before)
  if (freshToken !== undefined && freshExpiry !== undefined && freshExpiry > nowMs) {
    renewGate?.onSuccess(nowMs) // 有活 token 了,退避该清零(人重新登录后要能立刻恢复)
    return { token: freshToken }
  }

  const refreshToken = pickOauthRefreshToken(before)
  if (refreshToken === undefined) return { detail: '（keychain 里没有可用的 refresh token）' }

  // 保险 4(上半):先备份。备份落点写进 alert,回滚时有据可查。
  let backupAt: string | undefined
  try {
    backupAt = await io.backupKeychain?.(before)
  }
  catch {
    // 备份失败不阻断:下面写完还有读回自检兜着。
  }

  let tokens
  try {
    tokens = await refreshClaudeOauth({
      refreshToken,
      ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
      now: () => nowMs,
    })
  }
  catch (error) {
    // 400 invalid_grant 多半是 CLI 抢先换过了(我们手上这张已作废)。
    // 不重试、不换地址,如实降级成"要重新登录";并进退避,别每分钟再撞一次(2026-09-02)。
    renewGate?.onFailure(nowMs, error instanceof Error ? error.message : String(error))
    return { detail: `（自动续期没成功：${error instanceof Error ? error.message : String(error)}）` }
  }

  // 保险 3:CAS —— 出发时那份还在不在?
  let current: string
  try {
    current = await io.readKeychain()
  }
  catch {
    current = before
  }
  if (pickOauthAccessToken(current) !== pickOauthAccessToken(before)) {
    // CLI 的续期抢先落地了。认它的,不写我们这份。
    const theirs = pickOauthAccessToken(current)
    return theirs === undefined ? { detail: '（续期撞车，且对方凭据读不出来）' } : { token: theirs }
  }

  const merged = mergeRefreshedCredential(before, tokens)
  if (merged === undefined) return { detail: '（凭据形状不认识，没敢写回）' }

  try {
    await io.writeKeychain(merged)
  }
  catch {
    return { detail: '（写回 keychain 失败，凭据未被改动）' }
  }

  // 保险 4(下半):读回自检,对不上就还原备份。
  let readBack: string
  try {
    readBack = await io.readKeychain()
  }
  catch {
    readBack = ''
  }
  if (pickOauthAccessToken(readBack) !== tokens.accessToken) {
    if (backupAt !== undefined) {
      try {
        await io.writeKeychain(before)
      }
      catch {
        // 还原也失败:必须让人看见,并告诉他备份在哪。
        return { detail: `（写回自检失败且还原未成功，原凭据备份在 ${backupAt}）` }
      }
    }
    return { detail: '（写回自检没通过，已还原原凭据）' }
  }

  renewGate?.onSuccess(nowMs) // 换成了,退避清零
  return { token: tokens.accessToken }
}

async function collectClaudeScoped(
  options: CollectQuotaOptions,
): Promise<{ windows: QuotaWindow[], note?: string }> {
  const gate = options.claudeScopedGate
  const nowMs = gate === undefined ? 0 : gate.nowMs()

  // 限频期内不打端点,直接交出上次取到的窗口(和当前的诊断话术)。
  // 缓存这一步不能省:采集器仍是每分钟一轮,不给缓存那一栏会每分钟闪断一次。
  if (gate !== undefined && !gate.shouldFetch(nowMs)) return gate.cached()

  const io = options.claudeScopedIo ?? defaultScopedIo()

  let token: string | undefined
  let userAgent: string | undefined
  let expiresAtMs: number | undefined
  try {
    const keychain = await io.readKeychain()
    token = pickOauthAccessToken(keychain)
    expiresAtMs = oauthTokenExpiry(keychain)
    userAgent = claudeCodeUserAgent(await io.readVersions())
  }
  catch {
    return gate?.cached() ?? { windows: [] }
  }

  // token 已经过期:先试着自己续期,续不成才降级成"要重新登录"(2026-08-26)。
  // 不在这里硬撞过期 token —— 撞回来的 401 界面上看不出、也永远不会自己好,
  // 每 60 秒撞一次撞了 17 小时,最后把自己撞进限流,429 又反过来把 401 盖住。
  // expiresAtMs 读不出来时当"不知道",照常去打——不猜它已死。
  if (token !== undefined && expiresAtMs !== undefined && nowMs > 0 && expiresAtMs <= nowMs) {
    const renewed = await renewClaudeOauth(io, options, nowMs)
    if (renewed.token === undefined) {
      const note = `Claude 登录已过期，${RELOGIN_HINT}（Fable 等按模型窗口取不到）${renewed.detail ?? ''}`
      return gate === undefined ? { windows: [], note } : gate.onFailure(nowMs, { note })
    }
    token = renewed.token
  }
  // 没登录过（本机就是空串）或认不出版本：干脆别发这个请求。
  // 不报错也不留话术——"还没接这条源"是个正常状态，不是故障。
  // 也不进闸门:压根没打过端点,没有什么可退避的。
  if (token === undefined || userAgent === undefined) return gate?.cached() ?? { windows: [] }

  try {
    const windows = await fetchClaudeScopedWeekly({
      token,
      userAgent,
      ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
    })
    return gate === undefined ? { windows } : gate.onSuccess(nowMs, windows)
  }
  catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    // "要重新登录"这一种当场顶到界面上——它不会自己好。
    const needsLogin = message.includes('claude auth login')
    if (gate === undefined) {
      // 没装闸门时保持老行为一个字节不变(既有测试与非采集器调用方都靠它)。
      return needsLogin ? { windows: [], note: message } : { windows: [] }
    }
    const retryAfterSec = (error as { retryAfterSec?: number }).retryAfterSec
    return gate.onFailure(nowMs, {
      ...(retryAfterSec === undefined ? {} : { retryAfterSec }),
      ...(needsLogin ? { note: message } : {}),
    })
  }
}

/**
 * 把按模型窗口并进已有的那一格。只对 kind==='quota' 生效，别的原样返回。
 *
 * 诊断话术进 `alert` 而不是 `note`(2026-08-26):note 按 protocol.ts 的约定是
 * 给 /state 看的调试字段,界面那层会用重置时间整个覆盖掉它——话写在 note 里
 * 等于没写,Fable 那栏消失整天屏幕上没有痕迹,根子就在这儿。
 */
function withScopedWindows(
  base: QuotaEntry,
  scoped: { windows: QuotaWindow[], note?: string },
): QuotaEntry {
  if (base.kind !== 'quota') return base
  if (scoped.windows.length === 0 && scoped.note === undefined) return base
  return {
    ...base,
    windows: [...base.windows, ...scoped.windows],
    ...(scoped.note === undefined
      ? {}
      : { alert: base.alert === undefined ? scoped.note : `${base.alert}；${scoped.note}` }),
  }
}

/**
 * Claude：三条路按**新鲜度**排队，前一条不成才走后一条；按模型的周窗口另算一条，是补丁不是替代。
 *
 * | 顺位 | 来源 | 新鲜度 | 需要凭据 |
 * |---|---|---|---|
 * | 1 | 自发 1 token 请求的响应头（claudeHeaders.ts） | **实时** | setup-token |
 * | 2 | 桌面端的本地用量记录（claudeDesktop.ts） | 桌面端采样间隔（当前 15 分钟） | 不要 |
 * | 3 | statusLine 推上来的值 | 不定，可能是几小时前的 | 不要 |
 * | + | 按模型周窗口（claudeScoped.ts） | 周窗口，粒度够 | `claude auth login` 的 token |
 *
 * 顺序不能乱：
 * - 响应头在最前，因为只有它是实时的（详见 claudeHeaders.ts 文件头）。
 * - 推送值在最后，因为它会被 last-quota.json 持久化、重启后仍在，可能已经很旧了；
 *   让它盖住前两条，界面就会长期停在一个陈旧数字上。
 *
 * 第 4 条是**并列不是替代**：前三条谁都给不出按模型的窗口（Fable/Opus 那栏），
 * 而它也给不出实时的 5h。所以它只往已有那格后面追加，取不到就少一栏，绝不拖累前三条。
 *
 * **没填 setup-token 不是错误**，是"还没接实时源"这个真实状态——那时第 2 条照常工作，
 * 界面显示的仍是准确数字，只是慢一点。所以这里不为缺凭据报错，静静走下一条。
 */
/**
 * Codex 两条路按新鲜度排队。
 *
 * 1. `codex app-server` 的 `account/rateLimits/read`——**唯一实时的**，走 Codex 自己的
 *    登录态，我们不经手凭据，也不发模型请求。
 * 2. 本机会话文件（`~/.codex/sessions`）——兜底。它只在他真的用 Codex 时才更新，
 *    2026-08-24 就是因为只有这一条，屏上挂着三天前的读数（周 40%）当现值，
 *    而真实窗口早已重置（100%）。详见 codexAppServer.ts 开头。
 *
 * 实时路不通时**故意不记原因**：兜底那条大概率能给出数字，把一句网络话术顶到界面上
 * 只会让人以为额度坏了（跟 collectClaude 同样的取舍）。
 */
async function collectCodex(
  options: CollectQuotaOptions,
  env: Record<string, string | undefined>,
  now: Date,
): Promise<QuotaEntry> {
  try {
    return await collectCodexAppServerQuota(options.codexAppServerIo ?? defaultCodexAppServerIo)
  }
  catch {
    // 往下走，读本机会话文件。
  }

  return await collectCodexQuota({
    codexHome: options.codexHome ?? env.CODEX_HOME ?? `${env.HOME ?? ''}/.codex`,
    now,
    ...(options.codexIo === undefined ? {} : { io: options.codexIo }),
  })
}

/**
 * Claude 那一格。
 *
 * ★ 2026-10-03(卡「一键接上」第 3 条):多回一个 `keyRejected` ——
 * 那把密钥**被上游拒了**(401/403)这件事,上面那一层要知道:它决定那一格说「点一下接上就实时」
 * 还是什么都不说。过期的 token 永远不会自己好,闷声退回桌面端那份旧文件 = 那一格挂着一个
 * 越来越旧的数、一句提示都没有(这正是卡 QK 现场的另一半)。
 */
async function collectClaude(
  options: CollectQuotaOptions,
  now: Date,
): Promise<{ entry: QuotaEntry, keyRejected?: true }> {
  const env = options.env ?? process.env
  const token = env.CLAUDE_SETUP_TOKEN ?? options.credentials?.claude_api
  let keyRejected: true | undefined
  if (token !== undefined && token !== '') {
    try {
      const unified = await fetchClaudeHeaderQuota({
        token,
        ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
      })
      // 按模型窗口只有 usage 端点给得出，补在统一窗口后面（与官方 Usage 页面同序）。
      // 这条路是**实时的**(自发一个 1 token 的请求,读它回的限流头),所以截至时刻就是这一刻。
      return { entry: stampAsOf(withScopedWindows(unified, await collectClaudeScoped(options)), now, CLAUDE_HEADERS_SOURCE) }
    }
    catch (error) {
      // 实时源不通就往下走。这里**故意不记原因**：下面两条大概率能给出好数字，
      // 把一条网络抖动的错误话术顶到界面上，只会让人以为额度坏了。
      // **只有「被拒」是例外**:它不会自己好,所以记一笔(话术仍然不在这里拼,见 liveSources.ts)。
      if (claudeKeyRejected(error)) keyRejected = true
    }
  }

  try {
    return { entry: await readClaudeDesktopUsage({
      now,
      ...(options.claudeDesktopFile === undefined ? {} : { file: options.claudeDesktopFile }),
      ...(options.claudeDesktopIo === undefined ? {} : { io: options.claudeDesktopIo }),
    }), ...(keyRejected === undefined ? {} : { keyRejected }) }
  }
  catch (error) {
    // 拉不到就用推送值兜底，但只认真的额度——推送来的 unknown 没有兜底价值，
    // 那种情况下把拉取失败的原因说出来更有用。
    if (options.claude?.kind === 'quota') return { entry: options.claude, ...(keyRejected === undefined ? {} : { keyRejected }) }
    /*
     * 一个数都没有、而且那把密钥被拒了:**这一格要说得出下一步**(卡里第 4 条
     * 「凡是没接上都必须有一颗能按的键或一句能照做的话」)。`unknown` 这一档界面上写的是
     * 「未接入 + 原因」,而原因就在这句话里 —— 它没有按钮,但有一句她能照做的话。
     */
    if (keyRejected === true) return { entry: { kind: 'unknown', note: CLAUDE_KEY_REJECTED_WHY }, keyRejected }
    return { entry: unknownOf(error) }
  }
}

export async function collectQuota(options: CollectQuotaOptions = {}): Promise<CollectQuotaResult> {
  const env = options.env ?? process.env
  const fetchImpl = options.fetch ?? defaultFetch
  const now = options.now ?? new Date()
  const day = localDay(now, options.timeZone ?? DEFAULT_TIME_ZONE)

  // 先把四家都填成"未接入"，再把能接通的覆盖掉——保证结果永远是完整的四条。
  const quota = Object.fromEntries(
    AGENT_IDS.map(agent => [agent, { kind: 'unknown', note: '取数方式待实测' } satisfies QuotaEntry]),
  ) as Record<AgentId, QuotaEntry>

  // only 缺省＝四家全采。指定了就只跑那几家:没被点名的那几家**连接口都不打**,
  // 保持上面填好的"未接入"占位——调用方(60 秒快路)本来也只读它点名的那格。
  const wanted = (agent: AgentId): boolean => options.only === undefined || options.only.includes(agent)

  // 四家彼此独立，一家挂掉不影响其余三家，所以并发取、各自兜底。
  const [deepseek, codex, kimi, claude] = await Promise.all([
    wanted('dsh') ? collectDeepSeek(options, fetchImpl, day, now) : undefined,
    wanted('codex') ? collectCodex(options, env, now) : undefined,
    wanted('kimi') ? collectKimi(env, fetchImpl, options.credentials, options.onKimiRefreshed) : undefined,
    wanted('claude') ? collectClaude(options, now) : undefined,
  ])

  if (deepseek !== undefined) quota.dsh = stampAsOf(deepseek.entry, now)
  if (codex !== undefined) quota.codex = stampAsOf(codex, now)
  if (kimi !== undefined) quota.kimi = stampAsOf(kimi, now)
  // claude **不在这里盖**:那条路取不到数时会原样退回上一轮那个 entry,盖一下就把它说新了。
  // 它那几条活着的来源各自填好了 `as_of`(见 collectClaude)。
  if (claude !== undefined) quota.claude = claude.entry

  // 过线那一格该说什么(卡 QK):**每一轮都现盖** —— 见下面 `stampStaleHint`。
  const has = (name: string): boolean =>
    hasText(env[name]) || hasText((options.credentials as Record<string, string | undefined> | undefined)?.[name])
  /**
   * 这一轮哪几家的密钥**被上游拒了**(2026-10-03)。今天只有 Claude 查得出这件事(401/403),
   * 但这一格是通用的:哪家将来也查得出,在它自己的 collect 里回一个 `keyRejected` 即可 ——
   * 这一层不写家名,也不替没查出来的家猜一个「配了但不管用」(D13)。
   */
  const rejected = new Set<AgentId>()
  if (claude?.keyRejected === true) rejected.add('claude')
  for (const agent of AGENT_IDS) quota[agent] = stampStaleHint(quota[agent], agent, has, rejected.has(agent))

  return { ...(deepseek?.spend === undefined ? {} : { spend: deepseek.spend }), quota }
}

function hasText(value: string | undefined): boolean {
  return typeof value === 'string' && value !== ''
}

/**
 * **过线那一格该说什么,每一轮都现盖**(2026-10-02,卡 QK)。
 *
 * 为什么不像 `as_of` 那样「只盖这一轮真读到的那一份」:`as_of` 说的是**这个数**多大年纪,
 * 盖错就把旧数说新了;这一格说的是**这台机器此刻缺什么**(那把密钥配了没有),
 * 跟数是哪一轮读到的无关 —— 她刚在设置里配上,下一轮这一格就该闭嘴,所以退回上一轮的那份也要盖。
 *
 * `unknown` 不盖:那一格没有数、也就没有「读不到最新」这一档(界面写的是「未接入 / 没接上:原因」),
 * 往上挂一句「配一把就能实时」会和那句原因打架。
 *
 * 声明在 `quota/liveSources.ts` 一处(一家一条),这里只负责把它盖到老四家的 entry 上。
 */
function stampStaleHint(
  entry: QuotaEntry | undefined,
  agent: AgentId,
  has: (name: string) => boolean,
  /** 这一家那把密钥这一轮被上游拒了(2026-10-03):**当成缺那一样**,不然那一格会闷声不响。 */
  rejected = false,
): QuotaEntry {
  const base = entry ?? { kind: 'unknown', note: '取数方式待实测' }
  if (base.kind === 'unknown') return base
  const hint = quotaStaleHintFor(agent, has, rejected)
  if (hint === undefined) {
    if (base.stale_hint === undefined) return base
    const { stale_hint: _dropped, ...rest } = base
    return rest
  }
  return { ...base, stale_hint: hint }
}

/**
 * **这一轮真读到的数带上「截至什么时候」**(2026-10-02,卡 QA。「举例 = 一整类」:现场是 Claude,
 * 规矩是每一家)。
 *
 * 两条:
 * - **来源自己知道得更准就用它的**(`entry.as_of` 已经有了就不动):Claude 桌面端读的是十几分钟前
 *   落下的样本、Codex 读的是会话文件上次写过的时刻 —— 那才是截至时刻,不是我们读它的这一刻。
 * - **只盖这一轮真读到的那一份**。退回上一轮的那种(`collectClaude` 的兜底)绝不能盖:
 *   盖一下,那份 04:27 的数就又变成「刚读到的」—— 现场那一幕(17 小时的 100%)的根子正是如此。
 *
 * `unknown` 不盖:它没有数,盖一个时刻等于说「这一刻读到了没有数」,是句废话。
 */
function stampAsOf(entry: QuotaEntry, at: Date, source?: string): QuotaEntry {
  if (entry.kind === 'unknown' || entry.as_of !== undefined) return entry
  return { ...entry, as_of: at.toISOString(), ...(source === undefined ? {} : { source }) }
}

/** Claude 实时那条路的出处(界面上「截至 21:30」旁边那半句)。 */
export const CLAUDE_HEADERS_SOURCE = 'Claude 自己回的限流头(实时)'
