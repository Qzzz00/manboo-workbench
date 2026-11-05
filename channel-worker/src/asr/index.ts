/**
 * ASR 的可插拔口。选哪一个由配置 `WORKBENCH_CHANNEL_ASR` 决定,别处一行都不用改 ——
 * 上层(agent.ts)只看见一个 `STT`。
 *
 *   `segmented`(默认)  VAD 分段 → 8792 /api/asr。**本机能真跑**,理由见 segmentedStt.ts 顶部。
 *   `volc-streaming`    火山流式。要三样环境变量的密钥;缺一样就**退回 segmented 并说一句**,
 *                       不静默降级 —— 静默降级会让人以为流式在跑,而延迟数字对不上却找不到原因。
 */
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { stt } from '@livekit/agents'
import type { VAD } from '@livekit/agents'
import type { ChannelWorkerConfig } from '../config.ts'
import { SegmentedStt } from './segmentedStt.ts'
import type { VolcAsrCreds } from './volcSession.ts'
import { VolcStreamingStt } from './volcStt.ts'

/** 火山流式 ASR 的默认 resource id(与 butler-server 那份一致)。 */
export const VOLC_ASR_DEFAULT_RESOURCE = 'volc.bigasr.sauc.duration'

/** 工作台下发的那一份火山识别凭据(workbench.ts 的 ChannelCredentials.volc_asr)。 */
export interface IssuedVolcAsrCreds {
  app_id: string
  access_token: string
  resource_id?: string
}

/**
 * 三条来源 → 火山流式 ASR 的凭证。**只回凭证本身,绝不打印**。
 *
 * 顺序(2026-09-21 起中间多了一条):
 *
 *   ① **环境变量** `WORKBENCH_CHANNEL_VOLC_ASR_*` —— 手工压过一切,调试时用。
 *      名字带 `WORKBENCH_CHANNEL_` 前缀,和 butler-server 用的 `VOLC_ASR_*` 分开:
 *      那一套是 8792 的,两边各配各的,不共用一个名字免得改一处影响另一处。
 *   ② **工作台下发**(`GET /channel/credentials`)—— 这是**真机与新用户的常态**。
 *      钥匙在我们自己的服务器上,工作台登录后取回来,工人向 8791 问它,只存内存。
 *   ③ **`~/.dsh/workbench/channel.json`** —— 老机器上 Ben 手工拷过去的那一份。
 *      留着只为不把已经在用的机器弄坏;从零装的机器上没有这个文件,也不该有。
 */
export function volcAsrCredsOf(
  env: Record<string, string | undefined>,
  file: Record<string, unknown> = {},
  issued?: IssuedVolcAsrCreds,
): VolcAsrCreds | undefined {
  const pick = (envKey: string, fromServer: string | undefined, fileKey: string): string => {
    const fromEnv = (env[envKey] ?? '').trim()
    if (fromEnv !== '') return fromEnv
    const issuedValue = (fromServer ?? '').trim()
    if (issuedValue !== '') return issuedValue
    const fromFile = file[fileKey]
    return typeof fromFile === 'string' ? fromFile.trim() : ''
  }
  const appId = pick('WORKBENCH_CHANNEL_VOLC_ASR_APP_ID', issued?.app_id, 'volc_asr_app_id')
  const accessToken = pick('WORKBENCH_CHANNEL_VOLC_ASR_ACCESS_TOKEN', issued?.access_token, 'volc_asr_access_token')
  if (appId === '' || accessToken === '') return undefined
  const resourceId = pick('WORKBENCH_CHANNEL_VOLC_ASR_RESOURCE_ID', issued?.resource_id, 'volc_asr_resource_id')
  return { appId, accessToken, resourceId: resourceId === '' ? VOLC_ASR_DEFAULT_RESOURCE : resourceId }
}

/**
 * 2026-09-17 Ben 把火山流式识别的 appid / access token 写进了 `~/.dsh/workbench/channel.json`
 * (字段 `volc_asr_app_id` / `volc_asr_access_token`,可选 `volc_asr_resource_id`)——和 LiveKit 那对密钥同一个文件,
 * 他只用管一处。环境变量仍然优先。读不到、不是 JSON 都当空对象,**不抛**:这只是兜底来源。
 */
export function readChannelFile(env: Record<string, string | undefined>, readFile: (p: string) => string = (p) => readFileSync(p, 'utf8')): Record<string, unknown> {
  const home = env.HOME ?? homedir()
  const path = (env.WORKBENCH_CHANNEL_FILE ?? '').trim() || join(home, '.dsh', 'workbench', 'channel.json')
  try {
    const parsed: unknown = JSON.parse(readFile(path))
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}

/**
 * 选哪一路 ASR。`WORKBENCH_CHANNEL_ASR` 明说了就照它;没说的话,**有火山凭证就走流式**——
 * Ben 把密钥填好了却还在跑分段兜底、每句多等一秒多,这种"配了等于没配"最伤人。
 */
export function chooseAsrKind(configured: ChannelWorkerConfig['asr'], asrRaw: string | undefined, hasVolcCreds: boolean): 'volc-streaming' | 'segmented' {
  if ((asrRaw ?? '').trim() !== '') return configured
  return hasVolcCreds ? 'volc-streaming' : 'segmented'
}

export interface CreateAsrResult {
  stt: stt.STT
  /** 实际用上的是哪一个。main.ts 把它打出来 —— 配错了看一眼日志就知道。 */
  kind: 'volc-streaming' | 'segmented'
  /** 退回默认时的那句话。没退回就缺席。 */
  note?: string
  /**
   * 换识别的对话上下文(2026-09-25,问称呼那一轮带上问话)。**只有火山流式有**;
   * 分段兜底那一路没有这一格 —— 调用方用 `?.` 调,缺了就是不支持,不假装支持。
   */
  setDialogContext?: (dialog: readonly string[] | undefined) => boolean
  /**
   * 换识别热词(2026-10-02,卡「电话里像个活人」):每通电话现取人设时把这台机器上的词表交进来
   * (家名、事务官的名字、称呼、账号名、小组件名、她最近说过的专有词)。
   * **两条路都有**:火山流式换一条带新热词的连接,分段兜底下一句就算数。
   * 回 true = 真换了(该记一行日志)。
   */
  setHotwords: (words: readonly string[] | undefined) => boolean
  /**
   * 挂断了:识别那条连接当场收掉(2026-09-25,卡 fix/evening-gaps;火山按时长计费),回收掉了几条。
   * **只有火山流式有**;分段兜底那一路一句一条 HTTP,没有常开的连接。
   */
  quiet?: () => number
}

export interface CreateAsrDeps {
  config: ChannelWorkerConfig
  vad: VAD
  env?: Record<string, string | undefined>
  fetchImpl?: typeof fetch
  hotwords?: readonly string[]
  /**
   * ASR 出事时往哪儿说(2026-09-18)。流式那条**出错就聋**:一条 WS 断了下一帧会重开一条,
   * 但要是原因在密钥/额度那一侧(例如火山的 45000081),那就是整通电话都听不见 ——
   * 而这件事以前只在 `console.warn` 里露一行、不带 `[channel-worker]` 前缀,
   * 混在框架日志里几乎看不见。工人把自己的 `log` 传进来。
   */
  onError?: (message: string) => void
  /** 不是错、但该进日志的那几句(断了重连补发、换了带上下文的连接)。 */
  onNote?: (message: string) => void
  /** 测试用:代替读 ~/.dsh/workbench/channel.json。 */
  channelFile?: Record<string, unknown>
  /**
   * 工作台下发的那一份(2026-09-21)。由 main.ts 在每轮进房前向 8791 取,
   * **只在内存里传一路**,不落盘、不进日志。没有就退回环境变量与 channel.json。
   */
  issued?: IssuedVolcAsrCreds
}

export function createAsr(deps: CreateAsrDeps): CreateAsrResult {
  const env = deps.env ?? process.env
  const creds = volcAsrCredsOf(env, deps.channelFile ?? readChannelFile(env), deps.issued)
  if (chooseAsrKind(deps.config.asr, env.WORKBENCH_CHANNEL_ASR, creds !== undefined) === 'volc-streaming') {
    if (creds !== undefined) {
      const volc = new VolcStreamingStt({
        url: deps.config.volcAsrUrl,
        creds,
        ...(deps.hotwords === undefined ? {} : { hotwords: deps.hotwords }),
        ...(deps.onError === undefined ? {} : { onError: deps.onError }),
        ...(deps.onNote === undefined ? {} : { onNote: deps.onNote }),
      })
      return {
        kind: 'volc-streaming',
        stt: volc,
        setDialogContext: dialog => volc.setDialogContext(dialog),
        setHotwords: words => volc.setHotwords(words),
        quiet: () => volc.quiet(),
      }
    }
    return {
      ...segmented(deps),
      note: '配的是 volc-streaming,但火山 appid / access token 没齐'
        + '(三条来源都空:环境变量 WORKBENCH_CHANNEL_VOLC_ASR_*、工作台下发的那一份、channel.json),退回 segmented',
    }
  }
  return segmented(deps)
}

function segmented(deps: CreateAsrDeps): CreateAsrResult {
  const inner = new SegmentedStt({
    butlerUrl: deps.config.butlerUrl,
    ...(deps.fetchImpl === undefined ? {} : { fetchImpl: deps.fetchImpl }),
    ...(deps.hotwords === undefined ? {} : { hotwords: deps.hotwords }),
  })
  // VAD 分段交给框架:自己再写一遍静音判定只会多一处会错的地方。
  return {
    kind: 'segmented',
    stt: new stt.StreamAdapter(inner, deps.vad),
    setHotwords: words => inner.setHotwords(words),
  }
}
