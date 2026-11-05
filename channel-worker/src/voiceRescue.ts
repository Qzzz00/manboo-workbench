/**
 * **当前音色念不了中文时的兜底**(2026-09-28,卡 VC 第 ③ 件)。
 *
 * ## 为什么要这一层
 *
 * 真机那一晚(维护者本机 19:2x–19:4x):电话里一路「换」下去,换到英文女声
 * `en_female_dacey_uranus_bigtts`,后来又到 `en_female_stokie_uranus_bigtts`。
 * 从那一刻起每一句中文都是
 *
 *     volcengine TTS HTTP 400 code=3011 TTSInvalidText: unsupported language
 *
 * 开场白预合成 10 趟全失败,他打过去**一直没声音**,以为 TTS 坏了 ——
 * 统筹后来手动 `PUT 127.0.0.1:8792/api/voices/current {voice_id:'zh_female_vv_uranus_bigtts'}` 才恢复。
 *
 * 前两道关(候选只给会念中文的、换之前先试一句中文)拦的是「换成它」这件事。
 * 这一层拦的是**已经换上去了**:嗓子已经是那个念不了中文的,他正拿着听筒等一句话。
 * 这时候只有一件事可做 —— **自己换回一个会念中文的,然后开口说清楚**。
 *
 * ## 纪律
 *
 *   · **攒够 {@link RESCUE_AFTER} 句才动手**:偶尔一句没出声不值得当场换嗓子
 *     (与 butlerTts 的 `TTS_DEGRADE_AFTER` 同一条思路,只是这一件更急,所以只攒两句);
 *   · **一轮只救一次**:救完归零,不会每一句都去 PUT 一遍;
 *   · **退回上一个真出过声的**(`noteSpoken` 记下的那一个),没有就默认 vivi;
 *   · **绝不抛**:兜底失手只记一行日志 —— 它本来就是在收拾别人的失手,不该再掀翻通话;
 *   · **换成了才开口**:先换,再说那一句(嗓子还是坏的时候说话等于没说)。
 */
import { speaksChinese, voiceLabel } from './voice.ts'
import type { VoiceClient, VoiceList, VoiceOption } from './voice.ts'

/**
 * 默认那个中文女声(与 butler-server 的 `ttsVoices.DEFAULT_VOLC_VOICE` 同一个 id)。
 * 什么都不知道时退回它 —— 统筹那一晚手动恢复用的就是这一个。
 */
export const DEFAULT_VOICE_ID = 'zh_female_vv_uranus_bigtts'

/** 连着这么多句「念不了这段字」才动手。**2**:一整段话常被切成三四小块,两小块全哑就够了。 */
export const RESCUE_AFTER = 2

/**
 * 退回哪一个。**只在会念中文的里面挑**,而且不能是现在这个(现在这个正是哑掉的那个)。
 *
 * 顺序:`prefer`(上一个真出过声的)→ {@link DEFAULT_VOICE_ID} → 单子上第一个验过的。
 * 一个都没有 → `undefined`,由调用方如实记一行 —— **不硬塞一个**。
 */
export function pickRescueVoice(list: VoiceList, prefer?: string): VoiceOption | undefined {
  const current = list.current?.id
  const usable = list.voices.filter(one => one.id !== current && speaksChinese(one) !== false)
  const wanted = prefer === undefined ? undefined : usable.find(one => one.id === prefer)
  if (wanted !== undefined) return wanted
  return usable.find(one => one.id === DEFAULT_VOICE_ID)
    ?? usable.find(one => one.verified !== false)
    ?? usable[0]
}

export interface VoiceRescue {
  /** 音色换了(试听也算)。用来记住「上一个真出过声的是哪一个」。 */
  noteSwitched: (voiceId: string) => void
  /** 这一句真出声了:攒下的那一笔归零,现在这个音色算「能用」。 */
  noteSpoken: () => void
  /** 这一句是「这个嗓子念不了这段字」那一类哑的。攒够了就自己动手。**不抛**。 */
  languageMismatch: () => Promise<void>
}

export interface VoiceRescueDeps {
  voice: VoiceClient
  /** 换回来之后在电话里说的那一句。缺席就只记日志。 */
  say?: (text: string) => void
  log?: (text: string) => void
  /** 连着几句才动手。缺省 {@link RESCUE_AFTER}。 */
  after?: number
}

/** 换回来之后说的那一句。**说清两件事**:刚才为什么没声音、现在换成了谁。 */
export function rescuedLine(voice: VoiceOption): string {
  return `刚才那个嗓子念不了中文,我这几句都没出声,已经换回「${voiceLabel(voice)}」了。你接着说。`
}

export function createVoiceRescue(deps: VoiceRescueDeps): VoiceRescue {
  const after = deps.after ?? RESCUE_AFTER
  const log = (text: string): void => { try { deps.log?.(text) } catch { /* 记不上不该再出一个错 */ } }

  /** 这会儿是哪个音色(工人这头知道的那一份,只有换过才知道)。 */
  let current: string | undefined
  /** 上一个**真出过声**的音色。救的时候优先退回它。 */
  let good: string | undefined
  let streak = 0
  /** 正在救(救一次要跑两趟回环,别让第二句话又发一遍)。 */
  let rescuing = false
  /**
   * **已经救过一次了**,在真出一句声音之前不再救第二次。
   * 没有这一格就会变成:换回去还是哑 → 再攒两句 → 再换一个 → 一路把音色单翻完,
   * 而他那头只听见一串换嗓子的沉默。救不回来是另一件事,那件事由降级字幕去说。
   */
  let rescued = false

  return {
    noteSwitched(voiceId) {
      const want = voiceId.trim()
      if (want === '' || want === current) return
      current = want
    },

    noteSpoken() {
      streak = 0
      rescued = false
      if (current !== undefined) good = current
    },

    async languageMismatch() {
      streak += 1
      if (rescuing || rescued || streak < after) return
      rescuing = true
      try {
        const listed = await deps.voice.list()
        if (!listed.ok) {
          log(`[channel-worker] 当前音色念不了中文,没换回去:${listed.text}`)
          return
        }
        const target = pickRescueVoice(listed.list, good)
        if (target === undefined) {
          log('[channel-worker] 当前音色念不了中文,没换回去:这张音色单上找不出一个会念中文的。')
          return
        }
        const done = await deps.voice.set(target.id)
        if (!done.ok) {
          log(`[channel-worker] 当前音色念不了中文,没换回「${voiceLabel(target)}」:${done.text}`)
          return
        }
        current = done.voice.id
        good = done.voice.id
        streak = 0
        rescued = true
        log(
          `[channel-worker] 当前音色念不了中文(连着 ${after} 句 3011),已自动换回「${voiceLabel(done.voice)}」`
          + `(${done.voice.id})—— 通话不会整通没声音。`,
        )
        try { deps.say?.(rescuedLine(done.voice)) }
        catch { /* 说不出来也已经换回去了,下一句他自己听得见 */ }
      }
      finally {
        rescuing = false
      }
    },
  }
}
