/**
 * **往一条会话里送话,这一下该怎么送**(2026-09-28,卡 WR)。全是纯函数,一只手都不碰。
 *
 * 维护者 09-27 夜里点的三个场景:「一个是新建会话发信息,一个是在停下的已有会话发信息,
 * 一个是给工作中的会话发信息,并且打断发送新信息」。前两个是同一下(切到那条对话、打字、发出去);
 * 第三个分成**两种意图**,而这两种意图差得远,不能混:
 *
 * | 他的意思 | `intent` | 它此刻 | 这一下 |
 * |---|---|---|---|
 * | 「跟它说一句」「问问它到哪了」 | `append` | 停着 | {@link RelayMove} `send` —— 直接送 |
 * | 同上 | `append` | 在跑 | `queue`(框还能打字 = 排进去)/ `wait`(打不进字,如实说) |
 * | 「打断它」「先停下」「别做了,改成…」 | `interrupt` | 在跑 | `stop_then_send` —— **先按那家的停止键**,停下了才送 |
 * | 同上,可认不出停止键 | `interrupt` | 在跑 | `refuse` —— **不许假装打断** |
 * | 同上,可这是文件型那几家(Codex / Claude / Kimi) | `interrupt` | 在跑 | `refuse` —— 维护者明说不许动正在工作中的它们 |
 * | 「打断它」 | `interrupt` | 已经停了 | `send` —— 没有什么要打断的,直接送 |
 *
 * 两条纪律写在这里,别处不再判:
 * - **打断只在窗口那一路**。文件型会话(Codex / Claude / Kimi 的会话记录那一路)正在跑时,
 *   维护者 09-27 明说不许去动它们 —— 这里只做「补一句」,永不按停止键。
 * - **认不出停止键就不打断**。停止键认不认得出是壳**当场**读出来的事实(`SendTextPolicy.looksLikeStopButton`,
 *   卡 GB / BB2 那套),不是写死的一张各家支持表;认不出就如实说,不许送一句「打断了」上去。
 */

/** 他这一句是「补一句」还是「打断再发」。 */
export type RelayIntent = 'append' | 'interrupt'

/** 这条会话的来路:各家自己的会话记录(文件型),还是读它的窗口读出来的一条对话(窗口型)。 */
export type RelayKind = 'file' | 'window'

export type RelayMove =
  /** 直接送(它停着 —— 场景一、场景二)。 */
  | { kind: 'send' }
  /** 它在跑,框还能打字:话排进去,它跑完自己会看到。 */
  | { kind: 'queue' }
  /** 它在跑,而这一家在跑的时候打不进字 —— 如实说,不假装排上了。 */
  | { kind: 'wait', why: string }
  /** 先按那家的停止键,确认停下了再送。 */
  | { kind: 'stop_then_send' }
  /** 这一下不做,如实说为什么。 */
  | { kind: 'refuse', why: string }

export interface RelayMoveInput {
  /** 它此刻在跑没(`/state` 里那条会话的状态,不是猜的)。 */
  running: boolean
  intent: RelayIntent
  kind: RelayKind
  /**
   * 在跑的时候那个框还能不能打字(壳上一次读那扇窗时输入框在不在)。
   * **不知道就当能**(缺省 true):卡 BR 起「往在跑的那条会话里问一句到哪了」一直是这么送的,
   * 这一版不许把它变严。
   */
  queues?: boolean
  /** 这一路按不按得到停止键(壳会不会这个动作)。认不出那颗键是壳当场的事,见本文件开头那两条纪律。 */
  canStop: boolean
}

/** 见本文件开头那张表。 */
export function relayMoveOf(input: RelayMoveInput): RelayMove {
  const interrupt = input.intent === 'interrupt'
  // 已经停了:没有什么要打断的 —— 他说「打断它改成…」也只是直接送(不去按一颗此刻没有的键)。
  if (!input.running) return { kind: 'send' }
  if (!interrupt) {
    return input.queues === false
      ? { kind: 'wait', why: '它正在跑,而这一家在跑的时候输入框打不进字 —— 等它停下你再说一次,或者让我先打断它' }
      : { kind: 'queue' }
  }
  if (input.kind === 'file') {
    return { kind: 'refuse', why: '它正在干活,而这一家(它自己的会话记录那一路)我不去打断 —— 要停得你自己去那个窗口里停' }
  }
  if (!input.canStop) {
    return { kind: 'refuse', why: '认不出它的停止键,没敢替你按 —— 打断这一下得你自己来' }
  }
  return { kind: 'stop_then_send' }
}

/**
 * **他电话里那一句是「打断再发」还是「补一句」**(2026-09-28,卡 WR)。纯认字,不经模型。
 *
 * 维护者的口径:他说「打断它 / 先停下 / 别做了改成…」才走打断;别的一律是补一句
 * (「跟它说一句」「问问它到哪了」)。**认不准就按补一句** —— 多送一句话比无端按停止键轻得多。
 */
export const RELAY_INTERRUPT_WORDS: readonly string[] = [
  '打断', '中断', '先停', '停下', '停一下', '先别做', '别做了', '不要做了', '不用做了',
  '停止', '叫停', '喊停', '终止', '别弄了', '取消掉', '先取消',
]

export function looksLikeInterrupt(said: string): boolean {
  const flat = said.replace(/[\s　]+/g, '')
  if (flat === '') return false
  /*
   * **「改成 / 推翻」这类词不在名单里**:「把标题改成蓝色」是要它做的事,不是要停它。
   * 他真要打断时一定会说出一个「停」的意思(「别做了,改成先出提纲」里的「别做了」)——
   * 认那一半就够,多认「改成」只会把一堆正常的活当成打断。
   */
  return RELAY_INTERRUPT_WORDS.some(word => flat.includes(word))
}
