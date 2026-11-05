/**
 * 收音闸(2026-09-25,卡 fix/evening-gaps 第 1 条:隐私 + 计费)。**不在通话里,工人一个字都不听。**
 *
 * ## 为什么要它
 *
 * 维护者 09-24 18:52 挂断引导电话之后,工人日志 18:53–19:19 还有上万行 VAD、
 * 108 次「火山 ASR 错误(45000081)」、两次火山连接失败 —— 一句「他说」都没有。
 * 原因是三件事叠在一起:
 *
 *   1. 手机从 09-22 起**常驻房间**(不常驻就收不到来电),挂断时只把麦克风**静音**
 *      (livekit-client 的 `setMicrophoneEnabled(false)` 对已发布的轨道只做 mute,不停录音、不撤轨道),
 *      于是那条轨道一直挂在房里,Android 的录音一直开着;
 *   2. 工人进房用的是 `autoSubscribe: true`,**房里谁发了音轨就订谁**,订上了框架就一直往
 *      VAD 与识别里送帧 —— 静音的轨道也照样出帧(接收端按实时补静音);
 *   3. 火山那条连接只在「10 秒没有音频进来」时才收(volcStt.ts 的 VOLC_IDLE_CLOSE_MS),
 *      而帧一直在来,所以它**一直开着** —— 火山这个 resource 按时长计费。
 *
 * 手机那一头这次改成挂断即撤轨道、停录音(butler-app livekitCall.ts / roomLink.ts);
 * 这一头是**另一道闸**:手机是旧包、别的设备、测试页,只要不在通话里,工人就不订、不送、不连火山。
 *
 * ## 闸怎么开关
 *
 * 由 agent.ts 算「这会儿该不该听」(`inCall && !mutedAfterBye`,与通话护栏同一个 `inCall` 口径)
 * 和「听谁」(接话对象),每次状态变了就 `sync` 一次。闸只做三件事:
 *
 *   - **订阅**:只订「接话对象」的麦克风轨道,而且只在该听的时候订;其余一律退订
 *     (工人进房改成 `autoSubscribe: false`,不订 = SFU 不往这台 Mac 发、本机也不解码);
 *   - **框架那一路收音**(`session.input.setAudioEnabled`):关着时帧在进 VAD / 识别之前就丢掉 ——
 *     万一某条轨道漏在订阅里(SDK 的时序、老版本),VAD 与识别也拿不到一帧;
 *   - **火山连接当场收掉**(`quietAsr`):不等 10 秒空闲,挂断那一下就断,不多计一秒费。
 *
 * 这个文件**不认识 LiveKit**:参与者与轨道只看 `identity` / `trackPublications` / `setSubscribed`,
 * 用例里塞假的就能把每条路走一遍。
 */

/** 一条远端轨道。只用得上这两样:认它(sid)、订不订它。 */
export interface GatePublication {
  readonly sid?: string | undefined
  setSubscribed: (subscribed: boolean) => void
}

/** 房里的一位。 */
export interface GateParticipant {
  readonly identity: string
  readonly trackPublications: ReadonlyMap<string, GatePublication>
}

export interface ListenGateDeps {
  /** 房里此刻的每一位(工人自己不在里面)。 */
  participants: () => Iterable<GateParticipant>
  /** 这一条是不是麦克风那种音轨(别的轨道一律不订:工人用不上)。 */
  isMic: (publication: GatePublication) => boolean
  /** 框架那一路收音的开关(`session.input.setAudioEnabled`)。 */
  setAudioEnabled: (on: boolean) => void
  /** 把识别那条连接当场收掉(火山按时长计费),回收掉了几条。分段兜底那一路没有这一格。 */
  quietAsr?: () => number
  log: (line: string) => void
}

/** 这会儿该不该听、听谁。`speaker` 缺席 = 房里没有能听的人。 */
export interface ListenWant {
  listen: boolean
  speaker?: string | undefined
}

export class ListenGate {
  readonly #deps: ListenGateDeps
  /** undefined = 还没定过(第一次 sync 一定落地并记一行)。 */
  #listen: boolean | undefined
  #speaker: string | undefined
  /** 每条轨道上一次要的是订还是不订(key 是 sid)。同样的话不重复说给 SDK。 */
  readonly #asked = new Map<string, boolean>()

  constructor(deps: ListenGateDeps) {
    this.#deps = deps
  }

  /** 闸此刻开着吗。 */
  get listening(): boolean { return this.#listen === true }
  /** 开着时听的是谁。 */
  get speaker(): string | undefined { return this.#listen === true ? this.#speaker : undefined }

  /**
   * 按此刻的状态落一次。开关变了才动框架那一路、才收火山、才记一行;
   * 订阅每次都对一遍(接话对象可能换了、房里可能多了一条轨道)。**绝不抛**。
   */
  sync(want: ListenWant, why: string): void {
    const listen = want.listen
    const speaker = want.speaker === undefined || want.speaker === '' ? undefined : want.speaker
    const flipped = listen !== this.#listen
    const moved = listen && speaker !== this.#speaker
    this.#listen = listen
    this.#speaker = speaker
    if (flipped) {
      try { this.#deps.setAudioEnabled(listen) }
      catch (err) { this.#deps.log(`[channel-worker] 收音${listen ? '没打开' : '没关上'}:${(err as Error)?.message ?? '没说原因'}`) }
    }
    if (flipped && !listen) {
      let quieted = 0
      try { quieted = this.#deps.quietAsr?.() ?? 0 }
      catch { /* 收不掉也有 10 秒空闲那一道 */ }
      this.#deps.log(`[channel-worker] 收音关了(${why}):不在通话里 —— 不订麦克风、不跑 VAD 与识别${quieted > 0 ? `,识别连接当场收掉 ${quieted} 条` : ''}`)
    }
    else if (listen && (flipped || moved)) {
      this.#deps.log(`[channel-worker] 收音开了(${why}):只听 ${speaker ?? '(房里还没有能听的人)'}`)
    }
    this.reconcile()
  }

  /**
   * 订阅对一遍:该听时只订接话对象的麦克风,其余(以及不该听时的全部)退订。
   * 房里新发了一条轨道、有人进出时也调它。**绝不抛**。
   */
  reconcile(): void {
    const seen = new Set<string>()
    let participants: Iterable<GateParticipant>
    try { participants = this.#deps.participants() }
    catch { return }
    for (const participant of participants) {
      for (const [key, publication] of participant.trackPublications) {
        let mic = false
        try { mic = this.#deps.isMic(publication) }
        catch { mic = false }
        if (!mic) continue
        const sid = publication.sid ?? key
        seen.add(sid)
        const want = this.#listen === true && this.#speaker !== undefined && participant.identity === this.#speaker
        if (this.#asked.get(sid) === want) continue
        this.#asked.set(sid, want)
        try { publication.setSubscribed(want) }
        catch (err) {
          // 下一次对账再试:把记下的那一笔抹掉,别让它以为已经说过了。
          this.#asked.delete(sid)
          this.#deps.log(`[channel-worker] ${want ? '订' : '退订'} ${participant.identity} 的麦克风没成:${(err as Error)?.message ?? '没说原因'}`)
        }
      }
    }
    // 走了的轨道不再记着(房间一整天不断,这张表不该只长不缩)。
    for (const sid of [...this.#asked.keys()]) if (!seen.has(sid)) this.#asked.delete(sid)
  }
}
