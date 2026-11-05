/**
 * 缓冲语 —— **手机这一侧:她还没开口那几百毫秒里,手机自己放一句**
 * (2026-09-20,Ben:「缓冲语可以存到手机里啊,不能每次都去 TTS 合成吧」)。
 *
 * 放的是哪一份音频见文件末尾「换了音色怎么办」:2026-09-22 起是**按当前音色缓存在本地的那一份**,
 * 包里那七句退成兜底。这个文件本身不关心它 —— 它只管「什么时候垫、垫哪一句、什么时候掐」。
 *
 * ## 一句话
 *
 * 工人在**回合提交 / 开始调一件慢工具**那一刻往房间里广播一条极小的信号
 * (`{type:'filler', kind, tool?, round, at}`,形状见 channel/channelProtocol.ts)。
 * 手机收到就起一根 {@link FILLER_WAIT_MS} 的计时器:到点还没等到**她的真声**,
 * 就从 `public/filler/` 里挑一句放出来,并把同一句话写进字幕;
 * 她的真声一到(或者他自己开口了)就**当场掐掉**。
 *
 * ## 为什么这几件事必须在手机上做
 *
 *   - **声音永远赶在回答前面**。工人那边 `session.say()` 排的是和回答同一条发言队列,
 *     等 700ms 再排注定排在回答后面(交接-0920-引导通话第二轮 第六节第 1 条,实测晚 1.4 秒)。
 *     本地播放**根本不经那条队列**,所以这一条从「尽力而为」变成了「一定」。
 *   - **一分钱合成费都不花**。这几句是定死的,合成在构建时发生一次
 *     (scripts/render-filler-audio.mjs),运行时一个字节都不合成、一次并发都不占。
 *   - **字幕上写的就是喇叭里放的**。说哪一句只有放的这一头知道 —— 所以信号里**没有话**,
 *     字幕由这里发。
 *
 * ## 这个文件里钉住的七条
 *
 *   ① **到点才垫**。她 700ms 之内就出声的那几轮,一个字都不垫。
 *   ② **她一出声就掐**,不重叠。真声的两个信号哪个先到算哪个:
 *      她那条字幕(工人在「这一句开始出声」那一刻推,实测比声音早 56–130ms)、
 *      和远端音轨真的有能量(`ActiveSpeakersChanged`,慢一些但是铁证)。
 *   ③ **他一开口也掐**。他在说话时手机自己还在念叨是最糟的。
 *   ④ **不重复**。洗牌发牌,一副发完才重洗,重洗后的第一张不等于刚发出去的那张。
 *   ⑤ **一轮最多两句**({@link FILLER_MAX_PER_ROUND}),而且**同一类只垫一次**:
 *      平时那句(`thinking`)一轮只有一句,工具那句(`tool`)一轮只有一句。
 *      所以普通的慢回合**只有一句**;调慢工具那种两段的回合才会是
 *      「我想想」+「我看一下你的仓库」—— 第二句说的是**新的事**,不是又清一次嗓子。
 *      2026-09-22 补上「同一类只垫一次」那一半:在这之前,同一次等待里两条 `thinking`
 *      信号会垫出两句一模一样用途的话,那正是他听见的「一次念了好几句」的后半截。
 *   ⑥ **正在放就不叠第二句**,放不出来就只剩字幕 —— 垫一句是好意,坏了不许惊动通话。
 *   ⑦ **没人开过口就还是同一次等待**(2026-09-22 补,见下)。
 *
 * ## 第 ⑦ 条是怎么来的(2026-09-22,Ben 真机:「在生成回复之前,它一次念了好几句」)
 *
 * 原先这里把「轮号变了」直接当成「他刚说完一句话」,于是重新计数、重新允许两句。
 * **那个前提不成立。** 工人的轮号来自框架的 `agent_state_changed`:
 * 一个回合里模型每调一次工具,状态就在 `speaking ↔ thinking` 之间来回一次
 * (`@livekit/agents` 的 `agent_activity.js`:工具有输出就 `updateAgentState(lease,'thinking')`),
 * 每回到一次 `thinking` 工人就开一个新轮号。于是**一次等待里轮号能涨好几次**,
 * 手机每次都以为「他又说了一句话」,一句接一句地垫 —— 那正是他听见的那几句。
 *
 * 根子在工人那一侧已经堵掉(`channel-worker/src/agent.ts`:只有回到 `listening`/`idle`
 * 才算回合结束)。这里**再加一道闸**,因为手机与工人是分开发版的两件东西:
 * **上一句缓冲语之后她和他都没开过口 → 这还是同一次等待**,不重新计数、也不掐正在放的那一句。
 * 「开过口」认的就是第 ② ③ 条那三路信号(她的字幕、远端音轨有能量、他开口)。
 *
 * 这个文件是**纯的**:不认识 DOM、不认识 LiveKit,计时器与播放器都注入。
 * 真的那个播放器在隔壁 call/fillerPlayer.ts(它碰 `<audio>`);接线在 call/livekitCall.ts。
 *
 * **为什么要纯到这个地步**:本机那台假手机(channel-worker/dev/fake-phone.ts)直接 import 它,
 * 拿真的 LiveKit 房间量「信号 → 播放 → 被掐」的时序 —— 量的必须是**发出去的这一份逻辑**,
 * 不是一份长得像的复制品。所以这里连一个 `document` 都不许出现。
 *
 * ## 换了音色怎么办(2026-09-22 改了)
 *
 * **音色不是构建期的东西** —— 它是 8792 按「形象在 chat 场景的绑定」现解析的,人随时能改。
 * 所以从这一版起,那七句在**运行期**按当前音色合成并缓存在手机本地
 * (call/fillerVoiceCache.ts),`public/filler/` 里那七句退成**兜底**:
 * 第一次进房、合成失败、8792 没跑、离线,放的都还是它们。
 *
 * `src/call/fillerLines.json` 仍是**唯一的源**(这里、构建脚本、运行期那条路都读它)。
 * 改了句子要重跑 `node scripts/render-filler-audio.mjs` 把**兜底那一份**更新掉;
 * 只是换音色的话**不必再重跑、也不必重新打包**了 —— 那正是这一版补掉的洞。
 */
import table from './fillerLines.json' with { type: 'json' };

/**
 * 一句缓冲语。`tool` 只有工具专用那几句才有。
 *
 * `ack`(2026-10-02,卡「声音与形象跟着话走」第 5 件)是**他还说着的时候**插的那一声
 * 「嗯 / 嗯哼 / 对」。它不走这个文件里的那七条纪律(那是「她说完之后垫一句」的规矩),
 * 放它的是隔壁 call/ackAudio.ts;这里只是认得这一类,好让那几声也从同一份源里取。
 */
export interface FillerLine {
  id: string;
  kind: 'thinking' | 'tool' | 'ack';
  tool?: string;
  text: string;
}

/** 那几句话。源在 fillerLines.json —— 构建脚本读的是同一份。 */
export const FILLER_LINES: readonly FillerLine[] = (table.lines as unknown as FillerLine[]).map((line) => ({
  id: line.id,
  kind: line.kind,
  ...(line.tool === undefined ? {} : { tool: line.tool }),
  text: line.text,
}));

/**
 * **按音色对齐的是这几句**(2026-10-02)。应声那几声(`ack`)刻意不在内:
 * 它们各自两三百毫秒、换了音色也听不出,而把它们加进来会让进房时一次打出十一条
 * `/api/tts` —— 那正是 09-20 那次 502 的病根。理由全文在 call/ackAudio.ts 的文件头。
 */
export const FILLER_VOICE_LINES: readonly FillerLine[] = FILLER_LINES.filter((line) => line.kind !== 'ack');

/**
 * 这几句用哪个 TTS 场景合成。源同样在 fillerLines.json —— 构建脚本与**运行期那条路**
 * (call/fillerVoiceCache.ts,2026-09-22)读的是同一个字段,不各自写一个 'chat'。
 */
export const FILLER_SCENE: string = typeof table.scene === 'string' && table.scene !== '' ? table.scene : 'chat';

/**
 * 收到信号之后等多久。700ms —— 和第一版同一个数,理由也没变:
 * 再短会把「她答得很快」那几轮也垫上,像一个总要清嗓子的人。
 */
export const FILLER_WAIT_MS = 700;

/** 一轮最多垫几句。见头注释第 ⑤ 条。 */
export const FILLER_MAX_PER_ROUND = 2;

/** 音频在包里的位置。相对路径:Capacitor 从 http://localhost 根路径起服务(与 vite 的 base:'./' 一致)。 */
export function fillerAssetUrl(id: string): string {
  return `filler/${id}.m4a`;
}

/**
 * 一副会洗牌的短语牌(从工人那边原样搬过来的,2026-09-20 第二版)。
 * `next()` 发一张,发完重洗;重洗之后的第一张不等于刚发出去的那张。
 *
 * 为什么不是「随机挑一个,和上次不同就行」:那样在五句里会连着听到 A、B、A、B。
 * 发牌保证的是「五句话都说过一遍,才可能再听到第一句」。
 */
export class FillerBag {
  private readonly pool: readonly FillerLine[];
  private readonly random: () => number;
  private deck: FillerLine[] = [];
  private last: FillerLine | undefined;

  constructor(pool: readonly FillerLine[], random: () => number = Math.random) {
    // 去重:同一个 id 进两次的话那一句会比别的常出现,而那正是「听起来像卡带」的样子。
    const seen = new Set<string>();
    this.pool = pool.filter((line) => {
      if (line.text.trim() === '' || seen.has(line.id)) return false;
      seen.add(line.id);
      return true;
    });
    this.random = random;
  }

  get size(): number { return this.pool.length; }

  /** 发一张。池子是空的就回 undefined(调用方据此什么都不放,而不是放一段空音频)。 */
  next(): FillerLine | undefined {
    if (this.pool.length === 0) return undefined;
    if (this.deck.length === 0) this.reshuffle();
    const card = this.deck.pop();
    this.last = card;
    return card;
  }

  private reshuffle(): void {
    const deck = [...this.pool];
    // Fisher–Yates。注入的 random 让用例能钉住顺序。
    for (let i = deck.length - 1; i > 0; i -= 1) {
      const j = Math.floor(this.random() * (i + 1));
      [deck[i], deck[j]] = [deck[j]!, deck[i]!];
    }
    // pop() 从尾巴取,所以「下一张」是 deck 的最后一个。它和上一张一样就跟头上那张换个位置。
    if (deck.length > 1 && deck[deck.length - 1]!.id === this.last?.id) {
      const last = deck.length - 1;
      [deck[last], deck[0]] = [deck[0]!, deck[last]!];
    }
    this.deck = deck;
  }
}

/** 工人发来的那条信号(手机这一侧认得的形状)。 */
export interface FillerSignalIn {
  kind: 'thinking' | 'tool';
  tool?: string;
  round: number;
}

/** 没垫成的原因。**都要能说出口** —— 排查「怎么有时候没有」时全靠它。 */
export type FillerSkipReason
  = 'she-spoke'        /** 700ms 之内她就出声了(最常见,而且是好事) */
  | 'she-is-speaking'  /** 到点时她正说着(上一句还没完) */
  | 'still-playing'    /** 上一句缓冲语还在放 */
  | 'round-full'       /** 这一轮已经垫够 {@link FILLER_MAX_PER_ROUND} 句(轮号变了但没人开过口时也算同一轮,见第 ⑦ 条) */
  | 'kind-done'        /** 这一轮这一类已经垫过了(平时那句只垫一次,工具那句只垫一次,见第 ⑤ 条) */
  | 'no-line'          /** 表里没有这一类的句子 */
  | 'play-failed';     /** 音频没放出来(文件缺了、解码不了、被系统拦了) */

export interface FillerTimerHandle { cancel: () => void }

export interface FillerAudioDeps {
  /** 放一句。抛了/reject 了就当没放成(只剩字幕),**不许把通话带走**。 */
  play: (line: FillerLine) => Promise<void> | void;
  /** 立刻掐掉正在放的那一句(真的那个实现带一小段淡出,见 call/fillerPlayer.ts)。 */
  stop: () => void;
  /** 真的放出去了。字幕接这里 —— **字幕上写的就是喇叭里放的**。 */
  onPlayed?: (line: FillerLine) => void;
  /** 没垫成。只写日志/量时序,界面上什么都不做。 */
  onSkipped?: (reason: FillerSkipReason, signal: FillerSignalIn) => void;
  waitMs?: number;
  maxPerRound?: number;
  /** 牌堆(测试注入,用来钉住挑了哪一句)。 */
  thinkingBag?: FillerBag;
  toolBag?: FillerBag;
  setTimer?: (fn: () => void, ms: number) => FillerTimerHandle;
}

function defaultTimer(fn: () => void, ms: number): FillerTimerHandle {
  const handle = setTimeout(fn, ms);
  return { cancel: () => clearTimeout(handle) };
}

export interface FillerAudio {
  /** 工人说「她开始想了 / 她开始查东西了」。 */
  signal(signal: FillerSignalIn): void;
  /** **她的真声到了**:她那条字幕,或者远端音轨真的有能量。两个哪个先到算哪个。 */
  butlerSpoke(): void;
  /** 远端在不在出声。到点时她正说着就不垫(见头注释 ②)。 */
  setRemoteSpeaking(speaking: boolean): void;
  /** 他开口了 —— 当场掐。 */
  userSpoke(): void;
  /** 挂断 / 拆界面:撤计时器、掐音频。 */
  dispose(): void;
}

export function createFillerAudio(deps: FillerAudioDeps): FillerAudio {
  const waitMs = deps.waitMs ?? FILLER_WAIT_MS;
  const maxPerRound = deps.maxPerRound ?? FILLER_MAX_PER_ROUND;
  const setTimer = deps.setTimer ?? defaultTimer;
  const thinkingBag = deps.thinkingBag ?? new FillerBag(FILLER_LINES.filter((line) => line.kind === 'thinking'));
  // 工具那一堆里**只有没写 tool 的那几句**进牌堆:写了 tool 的是专用句,按名字直接取,不参与随机。
  const toolBag = deps.toolBag ?? new FillerBag(FILLER_LINES.filter((line) => line.kind === 'tool' && line.tool === undefined));

  let round: number | undefined;
  let playedThisRound = 0;
  /** 这一轮已经垫过哪几类(第 ⑤ 条:平时那句一次、工具那句一次)。 */
  let playedKinds = new Set<FillerSignalIn['kind']>();
  let playing = false;
  let remoteSpeaking = false;
  /**
   * **从这一轮开始起,她或他开过口没有**(第 ⑦ 条)。
   * 轮号变了只有在这面旗子立着的时候才算新的一次等待 —— 工人的轮号在一个回合里
   * 会被工具步打散好几次,而「没人开过口」是分辨「同一次等待」最可靠的那一条。
   */
  let spokeThisRound = false;
  let timer: FillerTimerHandle | undefined;
  /** 计时器上架着的是哪一条信号。没垫成时要如实说出「没垫成的是哪一条」。 */
  let armed: FillerSignalIn | undefined;
  let disposed = false;

  function cancelTimer(): void {
    timer?.cancel();
    timer = undefined;
    armed = undefined;
  }

  function cut(): void {
    cancelTimer();
    if (!playing) return;
    playing = false;
    try { deps.stop(); } catch { /* 掐不掉也不该再出一个错 */ }
  }

  function pick(signal: FillerSignalIn): FillerLine | undefined {
    if (signal.kind === 'tool') {
      const named = signal.tool === undefined
        ? undefined
        : FILLER_LINES.find((line) => line.kind === 'tool' && line.tool === signal.tool);
      return named ?? toolBag.next();
    }
    return thinkingBag.next();
  }

  function fire(signal: FillerSignalIn): void {
    timer = undefined;
    armed = undefined;
    if (disposed) return;
    // 到点了她正说着 —— 上一句还没完,这会儿插进去就是两个人一起说。
    if (remoteSpeaking) { deps.onSkipped?.('she-is-speaking', signal); return; }
    if (playing) { deps.onSkipped?.('still-playing', signal); return; }
    // 架计时器那一刻判过一次;到点了**再判一次** —— 中间可能又垫掉了一句(第 ⑤ ⑦ 条)。
    if (playedThisRound >= maxPerRound) { deps.onSkipped?.('round-full', signal); return; }
    if (playedKinds.has(signal.kind)) { deps.onSkipped?.('kind-done', signal); return; }
    const line = pick(signal);
    if (line === undefined) { deps.onSkipped?.('no-line', signal); return; }
    playedThisRound += 1;
    playedKinds.add(signal.kind);
    playing = true;
    // 字幕先出:它一定到得了,而音频还可能被系统拦下。
    try { deps.onPlayed?.(line); } catch { /* 一个监听者抛不该把这一句带走 */ }
    let started: Promise<void> | void;
    try { started = deps.play(line); }
    catch { playing = false; deps.onSkipped?.('play-failed', signal); return; }
    void Promise.resolve(started).then(
      () => { playing = false; },
      () => { playing = false; deps.onSkipped?.('play-failed', signal); },
    );
  }

  return {
    signal(signal) {
      if (disposed) return;
      /**
       * **轮号变了不等于新的一次等待**(第 ⑦ 条,2026-09-22)。
       * 中间没人开过口的话,工人那边只是走到了同一个回合的下一个工具步 ——
       * 那就不重新计数(不然就是他在真机上听见的那一串),也不掐正在放的那一句
       * (没有人在跟它抢话)。中间有人开过口才是真的新一轮。
       */
      if (signal.round !== round && spokeThisRound) {
        // 上一句缓冲语要是还在放,那是在跟他抢话,掐掉。
        cut();
        playedThisRound = 0;
        playedKinds = new Set();
        spokeThisRound = false;
      }
      round = signal.round;
      cancelTimer();
      if (playedThisRound >= maxPerRound) { deps.onSkipped?.('round-full', signal); return; }
      // 这一类这一轮已经说过了 —— 再说一遍就是又清一次嗓子(第 ⑤ 条)。
      if (playedKinds.has(signal.kind)) { deps.onSkipped?.('kind-done', signal); return; }
      armed = signal;
      timer = setTimer(() => fire(signal), waitMs);
    },

    butlerSpoke() {
      if (disposed) return;
      // 她真的出声了 —— 下一个新轮号才算得上新的一次等待(第 ⑦ 条)。
      spokeThisRound = true;
      // 计时器还架着 = 她在 700ms 之内就出声了:这是好事,如实记一笔。
      const pending = armed;
      cancelTimer();
      if (pending !== undefined) deps.onSkipped?.('she-spoke', pending);
      cut();
    },

    setRemoteSpeaking(speaking) {
      remoteSpeaking = speaking;
      if (speaking) this.butlerSpoke();
    },

    userSpoke() {
      if (disposed) return;
      // 他开口了 —— 同上,这一下之后的新轮号才是真的新一轮。
      spokeThisRound = true;
      cut();
    },

    dispose() {
      disposed = true;
      cut();
      round = undefined;
      playedThisRound = 0;
      playedKinds = new Set();
      spokeThisRound = false;
    },
  };
}
