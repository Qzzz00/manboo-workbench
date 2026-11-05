/**
 * **能真跑的那个 ASR**:VAD 切一句 → 这一句转成 WAV → POST 8792 `/api/asr` → 拿文字。
 *
 * ——— 为什么兜底选它,不选 sherpa-onnx ———
 *
 * 1. **密钥齐,今天就能出字**。8792 的 `/api/asr` 走的是火山「大模型流式识别」的一句话转写,
 *    凭证经 voiceCredentials.resolveAsrCreds 退回到火山 TTS 那对 appid/accessToken —— 那对在本机
 *    已经配好了(TTS 能出声就是证据)。2026-09-17 实测:一段 4.9 秒的中文 WAV POST 过去回
 *    `{"text":"记下，明天上午10点开会。"}`。sherpa-onnx 要另下一个 100MB+ 的中文流式模型,
 *    这台机器网络慢(记忆:仓库地图),而且要再多一个原生依赖(onnxruntime 已经为 VAD 装了一份)。
 * 2. **和将来的流式实现同一家**。兜底与 volcStt.ts 用的是同一个供应商、同一套 ITN 与标点规则,
 *    真拿到流式密钥换上去时,识别结果不会突变;换成 sherpa-onnx 则是换了一个口音模型。
 * 3. **代价说清楚**:它不是流式。要等他**说完这一句**、VAD 判定静音、再走一次 HTTP 往返,
 *    首字延迟比流式差一个静音窗(框架默认几百毫秒)加一次网络往返。这是原型阶段接受的代价,
 *    交接文档第三节记着。
 *
 * 实现上只写非流式的 `_recognize`,流式那一面交给框架的 `stt.StreamAdapter(this, vad)` ——
 * VAD 分段是框架已经做好的事,自己再写一遍只会多一处会错的地方。
 */
import { type AudioBuffer, asLanguageCode, mergeFrames, stt } from '@livekit/agents'
import { ASR_SAMPLE_RATE, encodeWav, pcmOfInt16, pcmSeconds } from '../audio/wav.ts'

/** 短于这个的段不送去识别:那是咳嗽、桌子响、一个「嗯」。送过去只会拿回空串。 */
export const MIN_SEGMENT_SECONDS = 0.35

export interface SegmentedSttOptions {
  /** butler-server 的地址,例如 http://127.0.0.1:8792。 */
  butlerUrl: string
  fetchImpl?: typeof fetch
  /** 热词(项目名、人名)。8792 那条接口收 `hotwords`。 */
  hotwords?: readonly string[]
}

/** 8792 回包 → 文字。形状不对就当作没听清,**绝不抛**。 */
export function transcriptOfAsrBody(body: unknown): string {
  const text = (body as { text?: unknown } | null)?.text
  return typeof text === 'string' ? text.trim() : ''
}

export class SegmentedStt extends stt.STT {
  label = 'butler.SegmentedStt'

  readonly #options: SegmentedSttOptions
  readonly #fetch: typeof fetch
  /** 热词(2026-10-02):每通电话现取人设时能换 —— 构造时那一份只是起点。 */
  #hotwords: readonly string[] | undefined

  constructor(options: SegmentedSttOptions) {
    // interimResults: false —— 它天生出不了中间结果,如实声明;框架据此决定要不要等。
    super({ streaming: false, interimResults: false })
    this.#options = options
    this.#fetch = options.fetchImpl ?? fetch
    this.#hotwords = options.hotwords === undefined || options.hotwords.length === 0 ? undefined : [...options.hotwords]
  }

  /**
   * 换热词(2026-10-02,与 VolcStreamingStt 的 `setHotwords` 同一个口)。
   * 这一路一句一条 HTTP,所以换了下一句就算数。回 true = 真换了(该记一行日志)。
   */
  setHotwords(words: readonly string[] | undefined): boolean {
    const next = words === undefined || words.length === 0 ? undefined : [...words]
    if ((this.#hotwords ?? []).join('\n') === (next ?? []).join('\n')) return false
    this.#hotwords = next
    return true
  }

  override get model(): string { return 'volc-bigasr-oneshot' }
  override get provider(): string { return 'butler-server' }

  protected async _recognize(frame: AudioBuffer): Promise<stt.SpeechEvent> {
    const merged = mergeFrames(frame)
    const pcm = pcmOfInt16(merged.data)
    const seconds = pcmSeconds(pcm, merged.sampleRate, merged.channels)
    if (seconds < MIN_SEGMENT_SECONDS) return emptyEvent()

    const wav = encodeWav(pcm, merged.sampleRate, merged.channels)
    const hotwords = this.#hotwords ?? []
    let res: Response
    try {
      res = await this.#fetch(`${this.#options.butlerUrl}/api/asr`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          audio: wav.toString('base64'),
          ...(hotwords.length === 0 ? {} : { hotwords: [...hotwords] }),
        }),
      })
    }
    catch {
      // 8792 没起 / 连不上:这一句就是没听清。不抛 —— 抛了会把整条通话带走。
      return emptyEvent()
    }
    if (!res.ok) return emptyEvent()
    let body: unknown
    try { body = await res.json() }
    catch { return emptyEvent() }
    const text = transcriptOfAsrBody(body)
    if (text === '') return emptyEvent()
    return {
      type: stt.SpeechEventType.FINAL_TRANSCRIPT,
      alternatives: [{
        language: asLanguageCode('zh-CN'),
        text,
        startTime: 0,
        endTime: seconds,
        confidence: 1,
      }],
    }
  }

  /**
   * 这个 STT 没有流式面。**故意抛**而不是假装支持:装出一个永远不出中间结果的流,
   * 上层会以为它在听,其实一个字都不会来。用法是 `new stt.StreamAdapter(segmented, vad)`。
   */
  stream(): stt.SpeechStream {
    throw new Error('SegmentedStt 不能直接 stream():用 stt.StreamAdapter(它, vad) 包一层')
  }
}

/** 「这一段什么也没听出来」。框架认的是**整个 alternatives 字段缺席**的 FINAL_TRANSCRIPT。 */
function emptyEvent(): stt.SpeechEvent {
  return { type: stt.SpeechEventType.FINAL_TRANSCRIPT }
}
