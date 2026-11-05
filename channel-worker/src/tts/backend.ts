/**
 * 「8792 在不在」这一件事(2026-09-18,Ben 真机:引导通话接不上)。
 *
 * 根因:工人一启动就 `session.say(开场招呼)`,那一句要向 8792 要音频;8792 没起来时
 * `fetch` 直接 reject,而框架起 ChunkedStream 的 mainTask 时没有接住拒绝 ——
 * 于是变成一条**未处理的 Promise 拒绝**,整个工人进程被掀翻,插件再把它拉起来,
 * 一秒一轮地崩(Ben 那台机器上 `restarts` 一直在涨,日志里全是 `connect ECONNREFUSED 127.0.0.1:8792`)。
 *
 * 从此的规矩:**8792 缺席是一种正常状态,不是崩溃的理由**。
 *   - 启动时探一次,只为日志里有一句人话(探不到照样进房);
 *   - 每一句合成失败都退回「字幕照推、声音没有」(butlerTts.ts 里的 failed());
 *   - 8792 回来了不用重启工人 —— 下一句合成自己就成了(这条路上没有任何缓存的「坏了」状态)。
 *
 * 探的是 `/health`:与工作台插件 `src/server/butler.ts` 判断「本机后端在不在」用的是同一条路,
 * 两处的结论不会打架。
 */

/** 8792 此刻在不在。**只有这两种**,「不知道」一律算 down —— 说不准的时候要说「可能没声音」。 */
export type TtsBackendState = 'ok' | 'down'

export interface ProbeTtsBackendInput {
  /** 例如 http://127.0.0.1:8792。 */
  butlerUrl: string
  fetchImpl?: typeof fetch
  /** 探测超时。默认 2 秒:它在本机,连不上是立刻的事,慢于此就当它没起来。 */
  timeoutMs?: number
}

export interface TtsBackendProbe {
  state: TtsBackendState
  /** 一句能直接打进日志的话。**不含任何密钥**。 */
  note: string
}

export const TTS_PROBE_TIMEOUT_MS = 2000

/**
 * 探一次。**绝不抛** —— 这是一条诊断路径,它自己把工人带走就太讽刺了。
 */
export async function probeTtsBackend(input: ProbeTtsBackendInput): Promise<TtsBackendProbe> {
  const doFetch = input.fetchImpl ?? fetch
  const timeoutMs = input.timeoutMs ?? TTS_PROBE_TIMEOUT_MS
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const res = await doFetch(`${input.butlerUrl}/health`, { signal: controller.signal })
    if (!res.ok) {
      return { state: 'down', note: `本机后端(${input.butlerUrl})回了 ${res.status},这一轮说不了话:字幕照出,声音没有。` }
    }
    return { state: 'ok', note: `本机后端(${input.butlerUrl})在,TTS 可用。` }
  }
  catch (err) {
    return {
      state: 'down',
      note: `本机后端(${input.butlerUrl})连不上(${(err as Error)?.message ?? '没说原因'}):`
        + '这一轮说不了话 —— 照常进房、字幕照出,8792 起来之后下一句自己就有声音了。',
    }
  }
  finally {
    clearTimeout(timer)
  }
}
