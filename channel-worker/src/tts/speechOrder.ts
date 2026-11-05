/**
 * 字幕按**播放顺序**出(2026-09-18)。
 *
 * 为什么需要这么一层:一段话按句切开之后,框架把几小块**并发**地送去合成,谁先合完谁先回来。
 * 本机实测:开场白拆成四小块,最短那句「首先,你希望我怎么称呼你?」最先合完 ——
 * 于是字幕先出现的是**最后一句**。声音没这个问题(它按顺序播),乱的只有字幕。
 *
 * 所以这里排一条队:`slot()` 在**创建合成**的那一刻按顺序占位(那就是播放顺序),
 * 音频好了 `ready()`,被打断/取消了 `drop()`;队头好了才放行,一路放到下一个还没好的为止。
 *
 * **队头卡住不许把字幕全扣下**(2026-09-18 本机实测踩到):框架有时会造出一块从来不跑、
 * 也不发 abort 的合成,队头就永远是 pending —— 那一次的现象是「她说了话,屏幕上一个字都没有」。
 * 所以有一条看门狗:队头压着别人超过 `STALL_MS` 就把它扔掉,后面的照出。
 * 宁可漏一句字幕,也不能整段没有字幕。
 *
 * 纯数据结构,不认识 LiveKit 也不认识 TTS —— 单测里直接跑(定时器可注入)。
 *
 * 2026-10-02 多带一格 `tone`(卡「声音与形象跟着话走」):这一句的语气跟着字幕一起出去
 * (手机拿它驱动表情)。**它不是字幕的一部分**,只是同一条通道上的另一格。
 */
import type { Tone } from './tone.ts'

interface Slot {
  text: string
  state: 'pending' | 'ready' | 'dropped'
  ok: boolean
  tone?: Tone
}

/** 队头压着后面的人最多压这么久。超过就认定它不会来了,扔掉往下走。 */
export const STALL_MS = 2500

export interface SpeechOrderOptions {
  stallMs?: number
  /** 定时器(测试注入)。默认 setTimeout,并 unref —— 它不该拖着进程不退出。 */
  setTimer?: (fn: () => void, ms: number) => { cancel: () => void }
}

function defaultTimer(fn: () => void, ms: number): { cancel: () => void } {
  const handle = setTimeout(fn, ms)
  handle.unref?.()
  return { cancel: () => clearTimeout(handle) }
}

export class SpeechOrder {
  readonly #emit: (text: string, ok: boolean, tone?: Tone) => void
  readonly #slots = new Map<number, Slot>()
  readonly #stallMs: number
  readonly #setTimer: (fn: () => void, ms: number) => { cancel: () => void }
  #timer: { cancel: () => void } | undefined
  #next = 0
  #head = 0

  constructor(emit: (text: string, ok: boolean, tone?: Tone) => void, options: SpeechOrderOptions = {}) {
    this.#emit = emit
    this.#stallMs = options.stallMs ?? STALL_MS
    this.#setTimer = options.setTimer ?? defaultTimer
  }

  /** 占一个位置。**在创建合成的那一刻调**——那时候的顺序就是将来播放的顺序。 */
  slot(text: string, tone?: Tone): number {
    const id = this.#next
    this.#next += 1
    this.#slots.set(id, { text, state: 'pending', ok: true, ...(tone === undefined ? {} : { tone }) })
    return id
  }

  /** 这一块的音频好了(`ok:false` = 合成失败,没声音但字幕照出,好过屏幕上什么都不发生)。 */
  ready(id: number, ok: boolean): void {
    const slot = this.#slots.get(id)
    if (slot === undefined || slot.state !== 'pending') return
    slot.state = 'ready'
    slot.ok = ok
    this.#flush()
    this.#arm()
  }

  /** 这一块不会播了(被打断、被取消)。**必须调**:不然队头卡住,后面的字幕一条都出不去。 */
  drop(id: number): void {
    const slot = this.#slots.get(id)
    if (slot === undefined || slot.state !== 'pending') return
    slot.state = 'dropped'
    this.#flush()
    this.#arm()
  }

  #flush(): void {
    for (;;) {
      const slot = this.#slots.get(this.#head)
      if (slot === undefined || slot.state === 'pending') return
      this.#slots.delete(this.#head)
      this.#head += 1
      // 没有语气就**只传两个参数**:多传一个 undefined 会让「这一句有没有语气」在调用方那边
      // 变成「传了个空的」,而那两件事在日志与用例里是分得清的。
      if (slot.state === 'ready') {
        if (slot.tone === undefined) this.#emit(slot.text, slot.ok)
        else this.#emit(slot.text, slot.ok, slot.tone)
      }
    }
  }

  /** 有人好了却被队头压着 → 起一只看门狗;到点还压着就把队头扔了。 */
  #arm(): void {
    if (this.#timer !== undefined) return
    const blocked = [...this.#slots.values()].some(slot => slot.state !== 'pending')
    if (!blocked) return
    this.#timer = this.#setTimer(() => {
      this.#timer = undefined
      const head = this.#slots.get(this.#head)
      if (head !== undefined && head.state === 'pending') head.state = 'dropped'
      this.#flush()
      this.#arm()
    }, this.#stallMs)
  }
}
