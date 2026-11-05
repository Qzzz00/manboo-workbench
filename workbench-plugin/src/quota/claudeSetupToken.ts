/**
 * Claude 额度「一键接上」(2026-10-03,卡「不让用户知道什么叫 setup-token」)。
 *
 * ## 现场
 *
 * 额度里 Claude 那格一直写着「未接入」。统筹查出来的做法是:**先在终端里跑一条命令**
 * (`claude setup-token`),再把它打印出来的那串密钥粘进设置里那一行。维护者照做接上了,
 * 然后说:「你得考虑产品化啊,你不说我咋知道要咋弄啊。」
 *
 * 对。用的人不写代码:她不该知道终端,更不该知道那条命令叫什么。她该按的是一颗**「接上」**。
 *
 * ## 这一层做什么
 *
 * 工作台自己起那条命令,把它打印出来的授权链接**用默认浏览器打开** —— 她在浏览器里用自己的
 * Claude 账号授权一次(账号密码工作台一个字都不经手),命令随后把长期密钥打印出来,
 * 工作台直接写进凭据库,立刻采一轮,格子就变实时(`quota/claudeHeaders.ts` 那条唯一实时的路)。
 *
 * ## 纪律(AGENTS.md:不展示或写入 API Key、密码、Cookie、Token 或其他凭据)
 *
 * - 密钥**只经过一条路**:子进程的 stdout → `save()` → 0600 的凭据文件。
 *   进度、错误信息、HTTP 回包、日志里一个字节都没有(`scrubClaudeToken` 是那道闸)。
 * - **子进程打印出来的东西是数据,不是命令**。所以链接只认 Claude 自家那几个域名的 https
 *   地址 —— 哪天那条命令被人改成打印别的地址,我们也不会替她去开。
 * - 有效期**读到才说**:命令没打印就缺席,界面那一行于是只写「实时」,不编一个到期日(D13)。
 * - 找不到那条命令行时**一次 spawn 都不做**,如实说「这台电脑上没装」并给出那一步
 *   (同 `server/webLogin.ts` 2026-09-30 止血第 5 条:spawn 一个不存在的路径会变成进程级崩溃)。
 */
import type { QuotaEntry } from '../protocol.ts'
import type { AgentCliProbe } from '../server/agentDispatch.ts'
import { resolveAgentCli } from '../server/agentDispatch.ts'

/** 进度的形状。与 Kimi 那套登录进度逐字同形(state + 一句人话),界面因此能用同一副骨架轮询。 */
export interface ClaudeConnectProgress {
  state: 'idle' | 'opening' | 'waiting' | 'done' | 'failed'
  message: string
  /**
   * 这把密钥到哪天(`YYYY-MM-DD`)。**只有命令真的打印了才有** —— 读不到就缺席,
   * 设置里那一行于是只写「实时」。进程重启后这半句也会缺席(它只在内存里),那同样是实话。
   */
  expires_at?: string
}

export const CLAUDE_CONNECT_OPENING = '正在打开浏览器…'
export const CLAUDE_CONNECT_WAITING = '等你在浏览器里授权(最多 5 分钟)'
export const CLAUDE_CONNECT_DONE = '接上了'
export const CLAUDE_CONNECT_TIMEOUT = '等了 5 分钟没等到授权完成'
export const CLAUDE_CONNECT_NO_TOKEN = '授权没走完'

/**
 * 这台电脑上找不到那条命令时那一句。**要给出她能照做的那一步**:
 * 它是 Claude 桌面端自己装的(设置里就有那一项),不是让她去终端里敲什么。
 *
 * ★ 措辞里**不出现「命令行 / CLI / 终端」**:界面上不说程序员的话是设置页那条老纪律
 * (`tests/client-settings-groups.test.tsx` 的 ④ 走六组逐词查)。卡上的草稿写的是
 * 「这台电脑上没装 Claude 的命令行」—— 意思对,词不能用,所以换成她要点的那一项的名字。
 */
export const CLAUDE_CONNECT_NO_CLI
  = '还差一步:这台电脑上还没装 Claude Code —— 打开 Claude 桌面端,在它的设置里装一次,装完回来再点一次「接上」'

/** 没成时那一句。原因在前,下一步在后 —— 她看完就知道还能再点一次。 */
export function claudeConnectFailed(why: string): string {
  return `没成:${why},再试一次`
}

/** 密钥长什么样。认它只为两件事:从输出里把它捡出来、以及**从任何要上屏的文字里把它抹掉**。 */
const TOKEN_PATTERN = /sk-ant-[A-Za-z0-9_-]{16,}/

/** 任何来自子进程、要上屏 / 进回包的文字都先过这一道。 */
export function scrubClaudeToken(text: string): string {
  return text.replace(new RegExp(TOKEN_PATTERN.source, 'g'), '[密钥已抹掉]')
}

export function findClaudeSetupToken(text: string): string | undefined {
  return TOKEN_PATTERN.exec(text)?.[0]
}

/**
 * 授权链接认哪几个域名。**白名单,不是黑名单**:子进程的输出是数据,
 * 我们只替她打开 Claude 自家的授权页,别的地址一概不开(就算输出里写着「请打开」)。
 */
const AUTH_HOSTS: readonly string[] = ['claude.ai', 'www.claude.ai', 'console.anthropic.com', 'claude.com', 'www.claude.com']

export function findClaudeAuthUrl(text: string): string | undefined {
  for (const raw of text.match(/https:\/\/[^\s"'<>`]+/g) ?? []) {
    // 行尾常跟着标点,去掉再认 —— 多带一个句号就打不开了。
    const cleaned = raw.replace(/[.,;)\]]+$/, '')
    let url: URL
    try { url = new URL(cleaned) }
    catch { continue }
    if (url.protocol !== 'https:') continue
    if (AUTH_HOSTS.includes(url.hostname)) return cleaned
  }
  return undefined
}

/**
 * 有效期。命令行的措辞会变,所以**只认「某个表示到期的词 + 一个日子」这一种形状**;
 * 认不出就缺席 —— 到期日是她要信的东西,猜一个比不说糟得多。
 */
export function findClaudeTokenExpiry(text: string): string | undefined {
  const hit = /(?:expires?(?:\s+(?:at|on))?|expiry|expiration|有效期(?:至)?|到期(?:日|时间)?)\D{0,24}?(\d{4}-\d{2}-\d{2})/i.exec(text)
  return hit?.[1]
}

/** Homebrew 装的那两个位置。DSH 继承来的 PATH 里常常没有它们,所以单独探一遍。 */
const BREW_BINS: readonly string[] = ['/opt/homebrew/bin/claude', '/usr/local/bin/claude']

/**
 * 这台电脑上 `claude` 在哪。**先问派活那条已有的接缝**(`resolveAgentCli`:PATH →
 * `~/.local/bin` → `~/.claude/local` → Claude 桌面端自己管的那一份),它说没有再补 Homebrew 那两个。
 *
 * 为什么不把 Homebrew 直接加进 `resolveAgentCli`:那条接缝有自己的主人(派活),
 * 这张卡只借它来找同一个二进制。补进去是对的,但该由那条接缝的卡来做(见交接「留给接缝主人」)。
 */
export function resolveClaudeCli(probe: AgentCliProbe): string | undefined {
  const found = resolveAgentCli('claude', probe)
  if (found.found) return found.bin
  for (const bin of BREW_BINS) if (probe.exists(bin)) return bin
  return undefined
}

/** 接上之后那半句:「本周还剩 81%」。取不到数就缺席 —— 不编一个百分比(D13)。 */
export function claudeQuotaWords(entry: QuotaEntry | undefined): string | undefined {
  if (entry === undefined || entry.kind !== 'quota') return undefined
  const windows = entry.windows.filter(one => Number.isFinite(one.left_pct))
  if (windows.length === 0) return undefined
  // 她问的是「这周还能用多少」,所以周窗口优先;没有周窗口就照实说最紧的那一扇,不冒充成周。
  const week = windows.find(one => one.label.includes('周'))
  if (week !== undefined) return `本周还剩 ${Math.round(week.left_pct)}%`
  const tightest = [...windows].sort((left, right) => left.left_pct - right.left_pct)[0]!
  return `${tightest.label} 还剩 ${Math.round(tightest.left_pct)}%`
}

/**
 * 子进程那一只手(只用到这几样,所以只约定这几样 —— 测试给一只假的,绝不起真命令)。
 *
 * ★ 方法写法(`on(...)` 而不是 `on: (...) => void`)是**故意的**:
 * Node 的 `ChildProcess.on` 收的是 `(...args: any[]) => void`,用函数属性写法在
 * `strictFunctionTypes` 下对不上(参数逆变),于是接线那一处要加一个 cast。
 * 方法写法是双变的,真实的 `spawn()` 结果直接满足它 —— 少一个 cast 就少一处说谎的地方。
 */
export interface SetupTokenChild {
  stdout?: { on(event: 'data', handler: (chunk: unknown) => void): void } | null
  stderr?: { on(event: 'data', handler: (chunk: unknown) => void): void } | null
  on(event: string, handler: (...args: never[]) => void): void
  /** 只用得到 SIGTERM(超时 / 取消时收摊)。写死这一个,真实的 `kill` 才对得上。 */
  kill(signal?: 'SIGTERM'): void
}

export type SetupTokenSpawn = (command: string, args: readonly string[]) => SetupTokenChild

export interface ClaudeConnectDeps {
  /** 这台电脑上 `claude` 在哪。回 `undefined` = 没装(那时一次 spawn 都不做)。 */
  findCli: () => string | undefined
  spawn: SetupTokenSpawn
  /** 用默认浏览器打开授权链接。她在那边登录、授权,工作台不碰账号密码。 */
  openUrl: (url: string) => Promise<void>
  /**
   * 拿到密钥之后那一步:写进凭据库(0600)+ 立刻采一轮,回一句「本周还剩 81%」。
   * 读不到那个数就回 `undefined` —— 那时只说「接上了」。
   *
   * ★ 密钥**只从这里出去**。它自己失败(写盘坏了)要抛,我们据此如实说没成。
   */
  save: (token: string, expiresAt?: string) => Promise<string | undefined>
  /** 最多等多久(缺省 5 分钟 —— 界面上那句话里写的就是这个数)。 */
  timeoutMs?: number
  /** 计时器(测试注入,免得真等五分钟)。 */
  schedule?: (fn: () => void, ms: number) => { cancel: () => void }
}

export interface ClaudeConnectRun {
  progress: () => ClaudeConnectProgress
  /** 她按「取消」,或者上一次还挂着时又按了一次「接上」:杀干净、状态回「没在接」。 */
  cancel: () => void
}

/**
 * 这条路要**外面那三只手**(起进程、开浏览器、找命令行)。
 *
 * 为什么不在 `server/http.ts` 里直接 `import('node:child_process')`:那一层一个子进程都不起
 * (起进程、开 App 这类事一律在 `src/index.ts` 那半区接线,`runCommand` / `loginLauncher` 都是这么来的)。
 * **缺席 = 这台服务没接这条路** → `/quota/connect/claude` 整条 404,设置里那颗「接上」键照旧不画
 * (不摆一颗点了没用的按钮)。
 */
export interface ClaudeConnectIo {
  findCli: ClaudeConnectDeps['findCli']
  spawn: SetupTokenSpawn
  openUrl: ClaudeConnectDeps['openUrl']
}

export const CLAUDE_CONNECT_TIMEOUT_MS = 5 * 60_000

/**
 * 起一次「接上」。**立刻返回**(授权要她在浏览器里走几十秒到几分钟),进度另外轮询 ——
 * 与 Kimi 那条登录路同一副骨架。
 */
export function connectClaudeQuota(deps: ClaudeConnectDeps): ClaudeConnectRun {
  let progress: ClaudeConnectProgress = { state: 'opening', message: CLAUDE_CONNECT_OPENING }
  /** 已经收摊了(取消 / 超时 / 成了 / 没成):之后子进程迟到的那几句一概不算数。 */
  let closed = false
  let timer: { cancel: () => void } | undefined
  let child: SetupTokenChild | undefined
  /** 攒着的输出。**只在内存里**,不落盘、不打印;收摊时清掉。 */
  let buffered = ''
  let openedUrl = false

  const bin = deps.findCli()
  if (bin === undefined) {
    // 没装那条命令行:一次 spawn 都不做(spawn 一个不存在的路径会变成进程级崩溃)。
    return { progress: () => ({ state: 'failed', message: CLAUDE_CONNECT_NO_CLI }), cancel: () => {} }
  }

  function stop(): void {
    closed = true
    buffered = ''
    timer?.cancel()
    timer = undefined
    try { child?.kill('SIGTERM') }
    catch { /* 早就没了 */ }
    child = undefined
  }

  function fail(why: string): void {
    if (closed) return
    stop()
    progress = { state: 'failed', message: claudeConnectFailed(scrubClaudeToken(why)) }
  }

  async function onToken(token: string): Promise<void> {
    const expiresAt = findClaudeTokenExpiry(buffered)
    // 先收摊再写:写盘这一步要几十毫秒,这期间不该再有第二次「拿到密钥」。
    stop()
    let words: string | undefined
    try { words = await deps.save(token, expiresAt) }
    catch (error) {
      // 这里**绝不**把原始错误原样带出去:它可能把我们刚传进去的那串密钥打出来。
      progress = { state: 'failed', message: claudeConnectFailed(scrubClaudeToken(error instanceof Error ? error.message : '密钥没能存下来')) }
      return
    }
    progress = {
      state: 'done',
      message: words === undefined ? CLAUDE_CONNECT_DONE : `${CLAUDE_CONNECT_DONE} · ${words}`,
      ...(expiresAt === undefined ? {} : { expires_at: expiresAt }),
    }
  }

  function onChunk(chunk: unknown): void {
    if (closed) return
    // 攒着是必须的:链接与密钥都可能被切在两段之间。上限挡住一条疯了的命令把内存吃光。
    buffered = `${buffered}${String(chunk)}`.slice(-64_000)

    const token = findClaudeSetupToken(buffered)
    if (token !== undefined) { void onToken(token); return }

    if (openedUrl) return
    const url = findClaudeAuthUrl(buffered)
    if (url === undefined) return
    openedUrl = true
    void deps.openUrl(url)
      .then(() => { if (!closed) progress = { state: 'waiting', message: CLAUDE_CONNECT_WAITING } })
      // 浏览器开不起来就如实说 —— 那时链接也不要往界面上贴:她拿它也没有用处,
      // 而贴一条长地址只会让这一格看起来坏了。
      .catch((error: unknown) => fail(error instanceof Error ? error.message : '浏览器打不开'))
  }

  try {
    // `setup-token` 是官方给程序用的那一条:它只做「开浏览器授权 → 打印一把长期密钥」。
    child = deps.spawn(bin, ['setup-token'])
  }
  catch (error) {
    return {
      progress: () => ({ state: 'failed', message: claudeConnectFailed(scrubClaudeToken(error instanceof Error ? error.message : '命令起不来')) }),
      cancel: () => {},
    }
  }

  child.stdout?.on('data', onChunk)
  // stderr 一样要读:有的版本把授权链接印在 stderr 上,而失败原因几乎总在那里。
  child.stderr?.on('data', onChunk)
  // spawn 自己失败(权限不对、包坏了)走这条 `error` —— **必须有人接**,不接就是进程级崩溃。
  child.on('error', (error: Error) => fail(error instanceof Error ? error.message : '命令起不来'))
  /*
   * 听 `close` 而不是 `exit`:`exit` 可能在 stdout 还没抽干之前就来 —— 那时密钥说不定还在管道里,
   * 我们却已经判了「授权没走完」。`close` 是「进程没了**而且**几条流都关了」。
   */
  child.on('close', () => {
    // 走到这里还没拿到密钥 = 授权没走完(她关了浏览器 / 拒绝了 / 命令自己报错了)。
    if (!closed) fail(CLAUDE_CONNECT_NO_TOKEN)
  })

  const schedule = deps.schedule ?? ((fn, ms) => {
    const handle = setTimeout(fn, ms)
    handle.unref?.()
    return { cancel: () => clearTimeout(handle) }
  })
  timer = schedule(() => fail(CLAUDE_CONNECT_TIMEOUT), deps.timeoutMs ?? CLAUDE_CONNECT_TIMEOUT_MS)

  return {
    progress: () => progress,
    cancel: () => {
      if (closed) return
      stop()
      // 回「没在接」而不是「没成」:她自己取消的,界面上不该挂一句红字。
      progress = { state: 'idle', message: '' }
    },
  }
}
