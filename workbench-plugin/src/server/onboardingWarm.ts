/**
 * 重启之后,把引导会话先热起来(2026-09-24,维护者真机)。
 *
 * 那一幕:注册 → 首次流程里点「开始」→ DSH 为认刚领到的模型凭证重启一次 → 重启完他在电脑引导对话里
 * 说了一句,页面停在「在想…」很久,他以为卡死了 —— 其实是重启后**第一轮**的冷启动(新进程里第一次开会话、
 * 第一次连模型),全压在他那句话上。
 *
 * 修法:这次重启是**为引导排的**(`POST /onboarding/session` 回 503 之前记一笔),新进程一起来就由工作台
 * 自己把引导会话开出来(第一条消息照旧是阶段机拼的那条,模型照常开口)。等他的页面敲门
 * (`/onboarding/session` 再来一次)时,会话已经在跑、冷启动已经过去了 —— 这一次**不再往里说一遍**
 * (不然她会把「接着上次」念两遍),直接把这条会话交出去。
 *
 * 记号落盘(`~/.dsh/workbench/onboarding-warm.json`),因为写它的进程马上就要被换掉;
 * 只认 5 分钟内的记号 —— 更早的是上一次没走完留下的,不该让某一次普通开机平白开一条会话。
 * 交出去只交一次、只交 2 分钟内热起来的那条、而且必须还是当前那条会话。
 *
 * ——— 热起来之后阶段机变了,就不交(2026-09-24,卡 fix/firstrun-session-after-answers) ———
 *
 * 那条会话的第一条消息是**预热那一刻**按阶段机写的(在哪一段、哪几项答过了、开口问哪一题)。要是在那之后、
 * 页面来领之前有人答了一项(他在手机上答了、或者老页面先开会话后交答案),原样交出去就是把一条按旧阶段写的会话
 * 给了他:她会接着旧阶段问 —— 跟「称呼问了两遍」是同一个坑。所以预热时记一份 {@link progressMark},
 * 页面来领时再算一次;对不上就回 `stale`,由 HTTP 层**另开一条**按现在写的(onboarding.openSession 的 `replace`)。
 *
 * 为什么另开、不往那条里补一句「现在到哪了」:预热那条多半正在答它的第一条消息(冷启动那一轮,正是预热要躲的那一段),
 * 补的话要排在后面,她先把旧阶段那一问说完 —— 那一问会先进回合表、上屏,他还得看一遍。另开一条之后,
 * 回合表只认新的那条,旧会话再说什么都不上屏。代价是 DSH 里多一条没人再续的会话,与「坏会话另开」同一种。
 */
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

/** 记号多久之内算「刚为引导重启过」。 */
export const WARM_MARK_FRESH_MS = 5 * 60_000
/** 热起来的会话多久之内交给来敲门的页面(再往后就当普通的「接着上次」)。 */
export const WARM_CLAIM_MS = 2 * 60_000
/** 新进程起来之后先等一小会儿再开会话(DSH 自己的会话通道也在起)。 */
export const WARM_DELAY_MS = 1_500

export function defaultOnboardingWarmFile(home = process.env.HOME ?? ''): string {
  return `${home}/.dsh/workbench/onboarding-warm.json`
}

/**
 * 阶段机「那一刻的样子」:阶段 + 各阶段答过的 key(顺序无关)。预热那条的第一条消息按它写,页面来领时再比一次。
 * 只看 key 不看值:改一项已答的(`/onboarding/correct`)不推进阶段,也不改「该问哪一题」。
 */
export function progressMark(view: { stage: string, answered: Readonly<Record<string, readonly string[]>> }): string {
  const answered = Object.entries(view.answered)
    .filter(([, keys]) => keys.length > 0)
    .map(([stage, keys]) => `${stage}:${[...keys].sort().join(',')}`)
    .sort()
  return `${view.stage}|${answered.join(';')}`
}

/** 页面来领预热那条的结果。 */
export type WarmClaim =
  /** 还对得上:交出去,不再往里说。 */
  | { kind: 'warm', session_id: string }
  /** 热起来之后阶段机变了,第一条消息过时了:别交,另开一条(见文件头)。 */
  | { kind: 'stale', session_id: string }

export interface OnboardingWarm {
  /** 新进程起来之后等多久再开会话(默认 WARM_DELAY_MS;测试给 0)。 */
  readonly delayMs: number
  /** 重启是为引导排的:记一笔(503 发出去之前)。 */
  mark(): Promise<void>
  /** 新进程起来时调:有新鲜记号就消费掉(删文件)并回 true。 */
  take(): Promise<boolean>
  /**
   * 热起来的那条会话。`mark` = 它第一条消息是按阶段机哪个样子写的({@link progressMark});
   * 不给就不比(老调用方),领的时候照旧交。
   */
  noteWarmed(sessionId: string, mark?: string): void
  /**
   * 页面来开会话了:刚热起来的那条(WARM_CLAIM_MS 内、且就是当前会话),一次性。
   * 阶段机还是预热那一刻的样子 → `warm`(交出去);变了 → `stale`(另开一条)。
   * 回 undefined = 没有可领的,照常开(往会话里说「接着上次」)。
   */
  claim(currentSessionId: string | undefined, currentMark?: string): WarmClaim | undefined
}

export function createOnboardingWarm(deps: {
  file: string
  now?: () => number
  readText?: (file: string) => Promise<string | undefined>
  writeText?: (file: string, text: string) => Promise<void>
  removeFile?: (file: string) => Promise<void>
  delayMs?: number
}): OnboardingWarm {
  const now = deps.now ?? Date.now
  const readText = deps.readText ?? (async file => await readFile(file, 'utf8').catch(() => undefined))
  const writeText = deps.writeText ?? (async (file, text) => { await mkdir(dirname(file), { recursive: true }); await writeFile(file, text, 'utf8') })
  const removeFile = deps.removeFile ?? (async file => { await rm(file, { force: true }) })
  let warmed: { session_id: string, at: number, mark?: string } | undefined
  return {
    delayMs: deps.delayMs ?? WARM_DELAY_MS,
    async mark() {
      try { await writeText(deps.file, JSON.stringify({ at: new Date(now()).toISOString() })) }
      catch { /* 记不下来就只是不预热:页面照样会等到新进程、自己开会话 */ }
    },
    async take() {
      const text = await readText(deps.file)
      if (text === undefined) return false
      await removeFile(deps.file).catch(() => {})
      try {
        const at = Date.parse((JSON.parse(text) as { at?: unknown }).at as string)
        return Number.isFinite(at) && now() - at >= 0 && now() - at <= WARM_MARK_FRESH_MS
      }
      catch { return false }
    },
    noteWarmed(sessionId, mark) { warmed = { session_id: sessionId, at: now(), ...(mark === undefined ? {} : { mark }) } },
    claim(currentSessionId, currentMark) {
      const one = warmed
      if (one === undefined) return undefined
      warmed = undefined
      if (one.session_id !== currentSessionId || now() - one.at > WARM_CLAIM_MS) return undefined
      if (one.mark !== undefined && currentMark !== undefined && one.mark !== currentMark) return { kind: 'stale', session_id: one.session_id }
      return { kind: 'warm', session_id: one.session_id }
    },
  }
}
