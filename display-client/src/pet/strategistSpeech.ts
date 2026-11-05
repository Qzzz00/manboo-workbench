// 军师答案的语音播报：攒成段 → 提前合成 → 顺序播放 → 播放期间喂合成音量包络驱动口型。
//
// ★播放走**原生**（AibooStrategistAudio 桥）而不是 WebView 的 <audio>：
// <audio> 永远是 STREAM_MUSIC，和游戏同一条媒体音量，玩家没法分开调（Ben 实报）。
// 原生侧走 USAGE_ALARM（这台掌机唯一「有独立滑块 + 不被勿扰静音」的流）并申请
// ducking（说话时游戏自动压低），细节见 StrategistAudio.kt。浏览器预览下回落 <audio>。
//
// ★口型为什么用合成包络而不是真实音量：Web Audio 的 AnalyserNode 能拿真实包络，但要为
// 每一小段音频建一整条 AudioContext 图；底条上同时还跑着原生 GL 渲染，越省越好。
// 合成包络在 240px 高的底条上完全看不出区别（吧唧项目上用过同一招）。
//
// ★★2026-08-01 Ben 真机：「播放过程可能 TTF 是两段，声音播放不全，而且上一句和
// 下一句的语气差很多」。三个根因，都在这个文件里：
//  ① 合成与播放**串在同一条 queue 上**（`await synth` → `await play`），所以旧注释里
//    那句「把 TTS 往返藏在下一句里」**从来没成立过**——每两段之间都插着一整个往返的静音。
//    现在合成在 enqueue 那一刻就起跑，播放队列只等一个**已经在飞**的 promise。
//  ② 段太碎。每段独立合成 = 语调各起各的，段越多跳得越频。放宽到 240 字之后
//    6-8 段是常态。现在只有第一句单独成段（保住首字延迟），之后攒到 MERGE_MIN_CHARS
//    才成一段——240 字约 3 段，且每个空档都被前一段的播放盖住。
//  ③ 合成失败 `catch {}` 静默跳过 = 「文字有、声音没有、也没人知道」。现在重试一次，
//    仍失败就 warn 进 logcat（掌机上这是唯一诊断手段）。
//
// 另有一条在原生侧：音频焦点原来**每段**申请/释放一次，游戏音量一段一抽。
// 现在整篇只 begin/end 一次，见 beginUtterance/endUtterance 与 StrategistAudio.kt。

import { stripMarkdown } from '../lib/strategist/markdown.ts';
import { takeCompleteSentences } from '../lib/strategist/sentences.ts';
import { tts, type AibooEndpoint } from '../lib/strategist/strategistClient.ts';

/** 口型抖动周期（ms）。100ms ≈ 说话时嘴的开合节奏。 */
const LEVEL_TICK_MS = 100;

/**
 * 第一句之后，攒到多少字才合成一段。
 *
 * ★不是「越大越好」：段越大语调越连贯，但**最后一段要等流结束才发得出去**，
 * 太大就会在流末尾露出一个真空档。80 字是按实测时序估的——240 字答案约 3 段
 * （首句 + 80 + 尾巴），每一段的合成都发生在前一段播放期间，听感上一口气念完。
 * 第一句仍单独成段：它决定「按完多久出声」，不能为了连贯牺牲它。
 */
const MERGE_MIN_CHARS = 80;

/** 单段合成失败的重试次数。一次就够——真挂了重试十次也是挂，只会让后面的段一起等。 */
const SYNTH_RETRIES = 1;

export type Speaker = {
  /** 喂入新的流式文本片段（内部自己攒够一段再合成）。 */
  push(text: string): void;
  /** 流结束：把缓冲区剩下的半句也念掉。 */
  flush(): void;
  /** 立刻停：清队列、停播放、口型归零。 */
  stop(): void;
};

export type SpeakerDeps = {
  /** Aiboo 后台（阿里云）——TTS 走它。 */
  endpoint: () => AibooEndpoint;
  /** 底条那只角色：/ai/tts 据它查音色绑定，说话才是她自己的声音。 */
  avatarId?: string;
  /** 0-1 的口型驱动量，转给 petCall stage 的 onBotAudioLevel。 */
  onLevel?: (level: number) => void;
  /**
   * 「已经念到第几个字了」——喂给面板做同步滚动（见 StrategistPanel）。
   *
   * ★这个数是**累计已念段落的字数和**，不是流里的精确字符偏移：
   * takeCompleteSentences 会丢掉纯标点片段、并把换行摘掉，所以两者可能差几个字。
   * 面板只拿它决定「滚到哪」（`scrollIntoView({block:'nearest'})`），差几个字肉眼看不出，
   * 不值得为此改动那个已经有测试的纯函数。
   */
  onSpokenChars?: (chars: number) => void;
  /** 注入用（测试）。 */
  ttsImpl?: typeof tts;
  /** 播一段音频，播完 resolve。默认走原生桥，回落 <audio>。 */
  playImpl?: (audioBase64: string, mime: string) => Promise<void>;
};

type NativeAudio = {
  play: (reqId: string, base64: string) => void;
  stop: () => void;
  /** 整篇播报开始/结束（音频焦点只在这一对之间持有）。老 APK 上可能没有，故可选。 */
  beginUtterance?: () => void;
  endUtterance?: () => void;
};

function nativeAudio(): NativeAudio | undefined {
  // typeof 守卫：vitest 环境是 node，裸碰 window 会 ReferenceError（stop() 会走到这里）。
  if (typeof window === 'undefined') return undefined;
  return (window as unknown as { AibooStrategistAudio?: NativeAudio }).AibooStrategistAudio;
}

// 原生播完的回调表。★模块级：window.__strategistAudioDone 是全局的。
const pendingAudio: Record<string, () => void> = {};
if (typeof window !== 'undefined') {
  (window as unknown as { __strategistAudioDone?: (id: string) => void }).__strategistAudioDone = (
    id,
  ) => {
    pendingAudio[id]?.();
  };
}

/** 默认播放：有原生桥走原生（独立音量 + ducking），否则回落 <audio>（浏览器预览）。 */
export function defaultPlay(audioBase64: string, mime: string): Promise<void> {
  const native = nativeAudio();
  if (native) {
    return new Promise<void>((resolve) => {
      const id = `a${Date.now()}${Math.random().toString(36).slice(2, 8)}`;
      // 兜底超时：原生若因意外没回调，整条播报队列会永久卡死。
      const timer = setTimeout(() => {
        delete pendingAudio[id];
        resolve();
      }, 30_000);
      pendingAudio[id] = () => {
        clearTimeout(timer);
        delete pendingAudio[id];
        resolve();
      };
      native.play(id, audioBase64);
    });
  }
  return new Promise<void>((resolve) => {
    const el = new Audio(`data:${mime};base64,${audioBase64}`);
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      resolve();
    };
    el.onended = finish;
    el.onerror = finish;
    void el.play?.()?.catch?.(finish);
  });
}

export function createSpeaker(deps: SpeakerDeps): Speaker {
  const synth = deps.ttsImpl ?? tts;
  const playAudio = deps.playImpl ?? defaultPlay;

  let buffer = '';
  /** 第一句之后的攒段缓冲（见 MERGE_MIN_CHARS）。 */
  let pending = '';
  let firstSegmentSent = false;
  /** 已经念完的字数，喂给面板同步滚动。 */
  let spokenChars = 0;
  /** 整篇是否已经 beginUtterance 过（音频焦点整篇只申请一次）。 */
  let utteranceOpen = false;
  let queue: Promise<void> = Promise.resolve();
  let stopped = false;
  // ★用裸 setInterval 而不是 window.setInterval：vitest 环境是 node（vitest.config.ts），
  // 库代码为了一个定时器就依赖 window，测试里直接 ReferenceError。
  let levelTimer: ReturnType<typeof setInterval> | null = null;

  function startLevels() {
    if (!deps.onLevel || levelTimer) return;
    let t = 0;
    levelTimer = setInterval(() => {
      t += 1;
      // 0.25-0.85 之间抖，像在说话。
      deps.onLevel?.(0.55 + 0.3 * Math.sin(t * 0.9));
    }, LEVEL_TICK_MS);
  }

  function stopLevels() {
    if (levelTimer) clearInterval(levelTimer);
    levelTimer = null;
    deps.onLevel?.(0);
  }

  type Clip = { audioBase64: string; mime: string };

  /** 合成一段，失败重试一次；仍失败返回 null（★不再静默——logcat 里要看得见）。 */
  async function synthOne(text: string): Promise<Clip | null> {
    for (let attempt = 0; attempt <= SYNTH_RETRIES; attempt += 1) {
      if (stopped) return null;
      try {
        return await synth(deps.endpoint(), { text, avatarId: deps.avatarId });
      } catch (e) {
        if (attempt === SYNTH_RETRIES) {
          console.warn('[strategist] TTS 合成失败，这一段不会有声音：', text.slice(0, 20), e);
          return null;
        }
      }
    }
    return null;
  }

  /**
   * 排一段进播放队列。
   *
   * ★合成**在这一刻就起跑**，不等前面的段播完——这就是旧实现缺的那一半：
   * 原来是 `queue.then(() => { await synth; await play })`，于是第 N+1 段的往返
   * 完整地暴露在第 N 段播完之后，段间静音 ≈ 一次 TTS 往返。
   */
  function enqueue(text: string) {
    const clipPromise = synthOne(text);
    queue = queue.then(async () => {
      const clip = await clipPromise;
      // 合成失败的段仍要推进「念到第几个字」，否则面板会卡在这一段不再往下滚。
      if (stopped || !clip) {
        spokenChars += text.length;
        deps.onSpokenChars?.(spokenChars);
        return;
      }
      openUtterance();
      try {
        await playAudio(clip.audioBase64, clip.mime);
      } finally {
        spokenChars += text.length;
        deps.onSpokenChars?.(spokenChars);
      }
    });
  }

  /**
   * 整篇播报开始。★音频焦点与口型都是**整篇**的作用域，不是每段：
   *  · 焦点每段申请/释放一次 → 游戏音量一段一抽（Ben 听到的「语气差很多」有它一份）；
   *  · 口型每段起停一次 → 段间嘴闭一下再张开，预取之后段间只剩几十毫秒，成了抽搐。
   */
  function openUtterance() {
    if (utteranceOpen) return;
    utteranceOpen = true;
    nativeAudio()?.beginUtterance?.();
    startLevels();
  }

  /** 整篇念完（或被打断）：把音频焦点还给游戏，嘴归位。 */
  function closeUtterance() {
    stopLevels();
    if (!utteranceOpen) return;
    utteranceOpen = false;
    nativeAudio()?.endUtterance?.();
  }

  return {
    push(text: string) {
      if (stopped) return;
      buffer += text;
      const { sentences: rawSentences, rest } = takeCompleteSentences(buffer);
      buffer = rest;
      // ★念之前剥 markdown：模型偶尔漏出 **加粗**，TTS 会把星号念成「星星」（Ben 实报）。
      const sentences = rawSentences.map((t) => stripMarkdown(t)).filter((t) => t.trim());
      for (const s of sentences) {
        if (!firstSegmentSent) {
          // 第一句单独发：它决定「按完多久出声」，不能为了连贯牺牲。
          firstSegmentSent = true;
          enqueue(s);
          continue;
        }
        pending += s;
        if (pending.length >= MERGE_MIN_CHARS) {
          enqueue(pending);
          pending = '';
        }
      }
    },
    flush() {
      if (stopped) return;
      // ★尾巴要和攒着的那段**合成一段**发，别单独发一个两三字的碎片
      // （碎片自己起一次调，正是「语气差很多」最刺耳的那一下）。
      const tail = stripMarkdown(pending + buffer).trim();
      pending = '';
      buffer = '';
      if (tail) enqueue(tail);
      queue = queue.then(closeUtterance);
    },
    stop() {
      stopped = true;
      buffer = '';
      pending = '';
      nativeAudio()?.stop();
      closeUtterance();
      stopLevels();
    },
  };
}

/** 播一段现成的音频（开场白/垫词用，不经 TTS）。走与答案播报同一条原生通路。 */
export const playClip = defaultPlay;
