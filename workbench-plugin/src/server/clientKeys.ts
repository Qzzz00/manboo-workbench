/**
 * ★ **请求号台账**(2026-10-12,卡「手机交代只执行一次」;交接 `docs/交接-1012-手机交代只执行一次.md`)。
 *
 * 手机发「会改东西」的请求时在 body 里带一个自己编的 `client_key`。断线重发、直连失败改走房间、
 * App 被杀重开后补发 —— 同一句话再来的时候带的还是那个号。8791 按「哪台设备 · 哪条路 · 哪个号」认:
 *   - 第一次:照常办,办完把回包(状态 + 原文)记下;
 *   - 办完之后再来:**不再办**,原样回第一次的回包;
 *   - 第一次还在办时又来一条(直连与房间同时到):等第一次办完,回同一个回包;
 *   - 第一次没办成(5xx、或者没回包连接就断了):不记,下一次照常办。4xx 记 —— 换个时候再问还是这一句。
 *
 * 落盘(`~/.dsh/workbench/client-keys.json`):电脑那头重启之后手机补发,也认得。只留最近 {@link CLIENT_KEY_KEEP} 条、
 * {@link CLIENT_KEY_KEEP_MS} 之内的 —— 手机那头待发箱补发的窗口比这短,够用。
 */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

export const CLIENT_KEY_KEEP = 500
/** 记多久。手机待发箱 24 小时内的才补发(butler-app/src/outbox/outbox.ts),这里多留一天。 */
export const CLIENT_KEY_KEEP_MS = 48 * 60 * 60 * 1000
/** 回包原文最多记多大。交代、捎话那几条的回执都是几百字节;超了就不记(截断的回包读不懂,不如下一次照常办)。 */
const MAX_BODY_CHARS = 64 * 1024

/**
 * 认请求号的那几条(手机发、会改东西、再来一次会**再办一次**的)。逐条为什么在交接的盘点表里。
 * 手机那头同一张表在 `butler-app/src/channel/clientKey.ts`,两边对照测试钉着(butler-app/tests/clientKey.test.ts)。
 * 加一条:这里与手机那张一起加。
 */
export const CLIENT_KEY_PATHS: ReadonlySet<string> = new Set([
  // 交代、补一句、捎话:再来一次就再建一张卡 / 再送一句进会话
  '/butler/item',
  '/butler/item/say',
  '/butler/say',
  '/butler/item/continue',
  '/sessions/relay',
  '/onboarding/say',
  // 派活:再来一次就再派一次
  '/item/drive',
  '/dispatch/run',
  '/butler/item/budget',
  '/feature/run',
  '/feature/review',
  '/feature/ship',
  // 替她答别家:再来一次就再送一遍字 / 再按一次键
  '/sessions/answer',
  '/asks/answer',
  // 本身按 id 幂等,可第二次回 409「已经答过」—— 手机会把一件办成了的事说成没办成;带号就回第一次那份
  '/questions/answer',
  '/approvals/answer',
  // 其余会多一份的
  '/progress/said',
  '/call/out',
  '/meeting/plan',
  // 手机挂断后交的通话纪要:手机那份不带 call_id,重发会再落一张
  '/butler/call/record',
  // 协作留言和手机待发箱共用同一请求号账;响应丢失后不能多落一条留言。
  '/task/comment',
  // 事务官核验后标四类拍板请求:按 task id 覆盖写(再标 = 改方案),本身幂等。
  '/task/owner-ask',
  '/collab/note/message',
  '/collab/goal/create',
  '/collab/goal/condition/save',
  '/collab/goal/condition/verify',
  '/collab/goal/condition/deliver',
  '/collab/relation/save',
  '/collab/lan/channel/send',
])

export function defaultClientKeysFile(home = process.env.HOME ?? ''): string {
  return `${home}/.dsh/workbench/client-keys.json`
}

/** body 里的 `client_key`。读不出来(不是 JSON、没有、空的)就是没带。 */
export function clientKeyOf(bodyText: string): string | undefined {
  if (bodyText === '') return undefined
  try {
    const raw = JSON.parse(bodyText) as { client_key?: unknown } | null
    const key = raw?.client_key
    return typeof key === 'string' && key.trim() !== '' ? key.trim().slice(0, 100) : undefined
  }
  catch {
    return undefined
  }
}

export type ClientKeyBegin =
  | { kind: 'fresh', finish: (status: number, body: string) => void, abort: () => void }
  | { kind: 'replay', status: number, body: string }

export interface ClientKeyLedger {
  /** `scope` = 「设备 路径」;同一个 scope + key 才算同一条。 */
  begin: (scope: string, key: string) => Promise<ClientKeyBegin>
  /** 等落盘写完(测试与退出时用)。 */
  flush: () => Promise<void>
}

interface Stored { status: number, body: string, at: number }

/**
 * `file` 缺席 = 只记在内存里(用例、没接落盘的机器):电脑重启就忘,别的一样。
 * `abortReleaseMs`(2026-10-24,运输去重):客户端断开 ≠ 没办——handler 往往在断线后照办到底
 * (1b 电话 3 秒超时重送因此曾双执行)。abort 后把 running **保留**到 handler 办完(finish 照记,
 * 同号重送自然等原执行完、拿同一回放);真没办成的(handler 没回包),宽限到期才释放给重送,
 * 等待有界、不永不清账。缺省 60s;用例注入小值。
 */
export function createClientKeyLedger(deps: { file?: string, now?: () => number, keepMs?: number, abortReleaseMs?: number } = {}): ClientKeyLedger {
  const ABORT_RELEASE_MS = deps.abortReleaseMs ?? 60_000
  const now = deps.now ?? (() => Date.now())
  const keepMs = deps.keepMs ?? CLIENT_KEY_KEEP_MS
  const done = new Map<string, Stored>()
  /** 正在办的那几条:后来的等它。 */
  const running = new Map<string, Promise<boolean>>()
  let loaded: Promise<void> | undefined
  let writing: Promise<void> = Promise.resolve()

  function load(): Promise<void> {
    loaded ??= (async () => {
      if (deps.file === undefined) return
      try {
        const raw = JSON.parse(await readFile(deps.file, 'utf8')) as { entries?: unknown }
        if (!Array.isArray(raw.entries)) return
        for (const one of raw.entries as unknown[]) {
          const e = one as { id?: unknown, status?: unknown, body?: unknown, at?: unknown }
          if (typeof e.id === 'string' && typeof e.status === 'number' && typeof e.body === 'string' && typeof e.at === 'number') {
            done.set(e.id, { status: e.status, body: e.body, at: e.at })
          }
        }
      }
      catch { /* 没有这份、读不懂:从空的开始 —— 最坏是重启前那一条再办一次,和没有台账时一样 */ }
    })()
    return loaded
  }

  function prune(): void {
    const cutoff = now() - keepMs
    for (const [id, e] of done) if (e.at < cutoff) done.delete(id)
    while (done.size > CLIENT_KEY_KEEP) {
      const oldest = done.keys().next()
      if (oldest.done === true) break
      done.delete(oldest.value)
    }
  }

  function persist(): void {
    const file = deps.file
    if (file === undefined) return
    const entries = [...done].map(([id, e]) => ({ id, ...e }))
    writing = writing.then(async () => {
      try {
        await mkdir(dirname(file), { recursive: true })
        const tmp = `${file}.tmp`
        await writeFile(tmp, JSON.stringify({ entries }), 'utf8')
        await rename(tmp, file)
      }
      catch { /* 写不下:内存里那份照样管用,只是重启后忘了 */ }
    })
  }

  async function begin(scope: string, key: string): Promise<ClientKeyBegin> {
    await load()
    const id = `${scope} ${key}`
    for (;;) {
      prune()
      const stored = done.get(id)
      if (stored !== undefined) return { kind: 'replay', status: stored.status, body: stored.body }
      const inFlight = running.get(id)
      if (inFlight === undefined) break
      await inFlight
    }
    let settle: (recorded: boolean) => void = () => {}
    running.set(id, new Promise<boolean>((resolve) => { settle = resolve }))
    let over = false
    return {
      kind: 'fresh',
      finish(status, body) {
        if (over) return
        over = true
        running.delete(id)
        if (status < 500 && body.length <= MAX_BODY_CHARS) {
          done.delete(id)
          done.set(id, { status, body, at: now() })
          prune()
          persist()
        }
        settle(true)
      },
      abort() {
        if (over) return
        // 宽限:不断言「零副作用」(服务端不知道办到哪了),running 留到 finish;
        // 宽限到了原 handler 仍未完结(生产里 dispatch 真回执可等数分钟,63s 它多半还活着):
        // ★不放 fresh 赌它死了(那是确定的双执行,V2)——记一条**只在内存**的 409「还在办/结果未知」,
        // 同号重送拿这一句,人去板上核对;进程重启即失(那才=handler 真死了,可重办)。
        setTimeout(() => {
          if (over) return
          over = true
          running.delete(id)
          done.set(id, { status: 409, body: JSON.stringify({ error: '这句还在办,结果未知;请稍候重试或到看板上核对,不会重复执行。', code: 'still_running' }), at: now() })
          settle(true)
        }, ABORT_RELEASE_MS)
      },
    }
  }

  return { begin, flush: async () => { await writing } }
}
