/**
 * 应声 —— **他还说着的时候,这台手机本地插一声「嗯」**
 * (2026-10-02,卡「声音与形象跟着话走」第 5 件)。
 *
 * ## 一句话
 *
 * 工人按阈值(连着说 ≥2.4 秒、没到句尾、距上一声 ≥4.5 秒、一轮 ≤3 次;
 * channel-worker/src/backchannel.ts)广播一条 `{type:'backchannel', round, at, line?}`,
 * 这里**当场**放一声包里预先合成好的「嗯 / 嗯哼 / 对 / 嗯嗯」—— 不再等。
 * 等已经在工人那头等过了,这里再等 700ms 就落在他说完之后,那就成了垫场。
 *
 * ## 四条纪律
 *
 *   ① **他一停就不放**。信号是网络上来的,它到的时候他可能刚停口 —— 所以这一层自己记着
 *      「他这会儿在不在说」({@link AckAudio.userSpeaking}),不在就一声都不放;
 *      正放着的时候他停了,**当场掐**(播放器自带淡出,call/fillerPlayer.ts)。
 *   ② **她一开口就掐**。她的真声和一声「嗯」叠在一起最难听。
 *   ③ **不叠第二声**。上一声还在放就跳过这一条 —— 这几声一个比一个短,叠起来像卡带。
 *   ④ **不进字幕、不进纪要**。垫场那几句进字幕是因为「字幕上写的就是喇叭里放的」;
 *      一声「嗯」写进纪要只会把那份记录弄脏(它不是一句话)。
 *
 * ## 为什么是包里那一份、不按音色现合成
 *
 * 和垫场第一版同一个理由(fillerAudio.ts 的头注释):这几声是**定死的**,
 * 合成在构建时发生一次(scripts/render-filler-audio.mjs),运行时一个字节都不合成、
 * 一次火山并发都不占。而且它们各自只有两三百毫秒 —— 换了音色之后一声「嗯」的嗓子差异
 * 远不如「一句完整的话两个嗓子」那么扎耳朵。**这是明着换来的**:换来的是
 * 「进房时不会有十一条合成一起打出去」(09-20 那次 502 的病根正是并发)。
 *
 * 纯的:不认识 DOM、不认识 LiveKit。播放器与牌堆都注入 —— 和 fillerAudio.ts 同一套路子。
 */
import { FillerBag, FILLER_LINES, type FillerLine } from './fillerAudio';

/** 那几声。源在 fillerLines.json(`kind:'ack'`),id 与工人的 `ACK_LINE_IDS` 逐字相同。 */
export const ACK_LINES: readonly FillerLine[] = FILLER_LINES.filter((line) => line.kind === 'ack');

/** 没放成的原因。**都要能说出口** —— 排查「怎么没有应声」时全靠它。 */
export type AckSkipReason
  = 'he-stopped'   /** 信号到的时候他已经停口了(最常见,而且是对的) */
  | 'she-speaking' /** 她正说着 */
  | 'still-playing'/** 上一声还在放 */
  | 'no-line'      /** 表里没有应声那一类 */
  | 'play-failed'; /** 音频没放出来(文件缺了、解码不了、被系统拦了) */

export interface AckSignalIn {
  round: number;
  /** 工人点名的那一声(认不得就自己挑)。 */
  line?: string;
}

export interface AckAudioDeps {
  /** 放一声。抛了/reject 了就当没放成,**不许把通话带走**。 */
  play: (line: FillerLine) => Promise<void> | void;
  /** 立刻掐掉正在放的那一声(真的那个实现带一小段淡出)。 */
  stop: () => void;
  onPlayed?: (line: FillerLine) => void;
  onSkipped?: (reason: AckSkipReason, signal: AckSignalIn) => void;
  /** 牌堆(测试注入,用来钉住挑了哪一声)。 */
  bag?: FillerBag;
}

export interface AckAudio {
  /** 工人说「该应一声了」。 */
  signal: (signal: AckSignalIn) => void;
  /** 他这会儿在不在说话。**停了就掐、就不放**(纪律 ①)。 */
  userSpeaking: (speaking: boolean) => void;
  /** 她开口了 —— 当场掐(纪律 ②)。 */
  butlerSpoke: () => void;
  /** 挂断 / 拆界面。 */
  dispose: () => void;
}

export function createAckAudio(deps: AckAudioDeps): AckAudio {
  const bag = deps.bag ?? new FillerBag(ACK_LINES);
  let speaking = false;
  let playing = false;
  let disposed = false;

  function cut(): void {
    if (!playing) return;
    playing = false;
    try { deps.stop(); } catch { /* 掐不掉也不该再出一个错 */ }
  }

  function pick(signal: AckSignalIn): FillerLine | undefined {
    const named = signal.line === undefined ? undefined : ACK_LINES.find((line) => line.id === signal.line);
    return named ?? bag.next();
  }

  return {
    signal(signal) {
      if (disposed) return;
      // 纪律 ①:信号在路上的那几十毫秒里他可能已经停了。停了就一声都不放。
      if (!speaking) { deps.onSkipped?.('he-stopped', signal); return; }
      if (playing) { deps.onSkipped?.('still-playing', signal); return; }
      const line = pick(signal);
      if (line === undefined) { deps.onSkipped?.('no-line', signal); return; }
      playing = true;
      // **不进字幕、不进纪要**(纪律 ④):onPlayed 只给日志与量时序用。
      deps.onPlayed?.(line);
      void (async () => {
        try { await deps.play(line); }
        catch { deps.onSkipped?.('play-failed', signal); }
        finally { if (playing) playing = false; }
      })();
    },

    userSpeaking(next) {
      if (disposed) return;
      speaking = next;
      // 他停了:正放着的那一声当场掐 —— 他停下来等答话的时候还在哼最糟。
      if (!next) cut();
    },

    butlerSpoke() {
      if (disposed) return;
      cut();
    },

    dispose() {
      disposed = true;
      speaking = false;
      cut();
    },
  };
}
