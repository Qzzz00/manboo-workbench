import { useEffect, useMemo, useRef, useState } from 'react';

import { analyzeAudioLevel, envelopeFromPcm, envelopeLevelAt, smoothMouthLevel } from '../../features/live2d/mouthSync';
import type { Live2DController } from './live2dController';
import { getServerBaseUrl, resolveDeviceCity } from './serverConfig';
import {
  hasNativeCommute,
  commuteStartNative,
  commutePauseNative,
  commuteResumeNative,
  commuteStopNative,
  commuteSeekIndexNative,
  commuteStateNative,
  musicStartNative,
  musicSetArtworkNative,
  audioDuckNative,
  audioSpeakNative,
  audioSpeakStopNative,
  audioUnduckNative,
} from '../../lib/djModeBridge';
import {
  resolveCurrentDaypart,
  splitDaypart,
  msSinceLocalMidnight,
  type DayProgram,
  type Daypart,
  type ProgramItem,
} from './programTimeline';

// ---- DJ 数据类型（对齐 docs/dj-v1/api-pwa.md） ----

export type DjKind = 'track' | 'tts';

export interface DjItem {
  kind: DjKind;
  queue_item_id: string;
  ncm_id?: string;
  title?: string;
  artist?: string;
  pic_url?: string; // kind=track：网易云专辑封面
  song_url?: string; // kind=track
  audio_url?: string; // kind=tts
  role?: string;
  text?: string;
  started_at?: string;
  duration_ms: number;
  position_ms_at_started?: number;
  position_ms_at_event?: number;
  expires_at?: string;
}

export interface DjSegment {
  segment_id: string;
  emotion?: string | null;
  title?: string;
  started_at?: string;
}

export type DjStatus = 'idle' | 'connecting' | 'connected' | 'error';

export interface DjState {
  status: DjStatus;
  playing: DjItem | null;
  queue: DjItem[];
  segment: DjSegment | null;
  emotion: string | null;
  /** 当前是否处于暂停态（用户按了暂停）。 */
  paused: boolean;
  /** 当前曲目的喜欢/不喜欢态（用于按钮高亮）；切歌后重置。 */
  feedback: 'like' | 'dislike' | null;
  /** 通勤播客：当前说话的主播 key；非通勤为空。 */
  speaker?: string | null;
  /** 通勤播客：话题卡片列表（渲染卡片用）。 */
  topics?: CommuteTopic[];
  /** 通勤播客：当前口播对应的话题卡片 id（联动滚动到正中）。 */
  currentTopicId?: string | null;
}

/** 通勤播客的一段口播（来自 /api/dj/commute/today）。 */
export interface CommuteSegment {
  id: string;
  speaker: string;
  text: string;
  audio_url: string;
  duration_ms: number;
  /** 这段口播在讲哪张话题卡片（联动滚动用）。 */
  topicId?: string | null;
}

/** 通勤话题卡片（来自 aihot 资讯）。 */
export interface CommuteTopic {
  id: string;
  title: string;
  summary: string;
  url: string;
  source: string;
}

/** 播放器命令（音乐播放器交互 + 蓝牙媒体键）。 */
export interface DjControls {
  /** 播放/暂停切换。 */
  playPause: () => void;
  /** 下一首（用户主动切歌，记一条 skip 反馈）。 */
  next: () => void;
  /** 上一首。 */
  prev: () => void;
  like: () => void;
  dislike: () => void;
  /** 当前曲目已播毫秒（驱动进度条，含暂停/seek 后的真实位置）。 */
  getPositionMs: () => number;
  /** 当前曲目总毫秒。 */
  getDurationMs: () => number;
  /** 通勤深挖：就某话题提问，即时生成插播口播。返回是否成功。非通勤模式为 no-op。 */
  dig: (topic: string) => Promise<boolean>;
  /** 用户总音量 0..1（音乐/口播统一缩放，持久化；Stackchan 隔空挥手用）。 */
  setVolume: (v: number) => void;
  getVolume: () => number;
}

/** useDj 返回：播放状态 + 控制方法 + 音乐床频谱（仅 holo 有值，波形据此出真频谱）。 */
export type DjView = DjState & { controls: DjControls; musicAnalyser: AnalyserNode | null };

// ---- 播放地址 ----

export function playableUrl(item: DjItem): string | undefined {
  return item.kind === 'track' ? item.song_url : item.audio_url;
}

/**
 * 实际播放用的地址：所有 DJ 音频都经后端取，保证与屏保同源 + 带 CORS 头，
 * 这样 AnalyserNode 才能读到真实波形驱动口型（直连网易云 CDN 会被污染成静音）。
 * - track：走后端代理 /api/track/stream（按 queue_item_id，后端负责续签，前端地址永不过期）
 * - tts：相对路径(/uploads/...)补上 base；已是绝对地址则原样用
 */
/**
 * 诊断轨迹：写进页面内的环形缓冲（不落 logcat）。故障后用 devtools 读 `window.__djTrace`
 * 即可回溯「起播 → 口播 → 恢复 → 推进」整条链停在哪一跳。
 * ★为什么不打 logcat：capacitor.config 的 `loggingBehavior:'none'` 是刻意的安全决定
 * （不让 bridge 的 methodData/认证上下文进系统日志），不要为了看日志去改它。
 */
export function djTrace(msg: string): void {
  try {
    const w = window as unknown as { __djTrace?: string[] };
    if (!w.__djTrace) w.__djTrace = [];
    w.__djTrace.push(new Date().toISOString().slice(11, 23) + ' ' + msg);
    if (w.__djTrace.length > 200) w.__djTrace.shift();
    // 展示台宿主注入的原生桥：环形缓冲只有 devtools 读得到，而那台机器上 CDP 不可靠。
    // 有桥就直送 logcat（`adb logcat -s DJTRACE`），没有就当没这回事。
    (w as unknown as { AibooTrace?: { log(m: string): void } }).AibooTrace?.log(msg);
  } catch {
    /* 无 window（测试环境）：忽略 */
  }
}

export function streamUrl(base: string, item: DjItem): string | undefined {
  if (item.kind === 'track') {
    return `${base}/api/track/stream?id=${encodeURIComponent(item.queue_item_id)}`;
  }
  const u = item.audio_url;
  if (!u) return undefined;
  if (/^https?:\/\//i.test(u)) return u;
  return `${base}${u.startsWith('/') ? '' : '/'}${u}`;
}

/** URL 是否已过期或临近过期（<60s）。 */
export function isUrlStale(item: DjItem, nowMs: number): boolean {
  if (!item.expires_at) return false;
  const exp = Date.parse(item.expires_at);
  if (Number.isNaN(exp)) return false;
  return exp - nowMs < 60_000;
}

// ---- 双路音频播放器：音乐床 + 口播叠放(ducking) ----
//
// music：纯 <audio>，自带输出；口播时把音量压低，口播完平滑恢复。
// voice：经 AudioContext 接 AnalyserNode → 驱动 Live2D 口型（口型只跟口播，不跟音乐）。

const DUCK_VOLUME = 0.18; // 口播时音乐压到的音量
const UNDUCK_MS = 600; // 口播结束后音乐恢复正常的渐变时长

// 导出仅供单测(卡死看门狗等);运行时唯一使用方是本文件的 connectDj。
export class DjPlayer {
  private music: HTMLAudioElement;
  private voice: HTMLAudioElement;
  // 通勤口播专用：不接入 AudioContext 的「直连」元素。
  // 锁屏/切后台时浏览器会挂起 AudioContext → 经它路由的 voice 会静音卡死（onended 不触发），
  // 而像音乐床那样的纯 <audio> 元素能继续播。通勤无 Live2D，不需要口型分析，故直连播放。
  private voiceDirect: HTMLAudioElement;
  private ctx: AudioContext | null = null;
  private analyser: AnalyserNode | null = null;
  private voiceSrc: MediaElementAudioSourceNode | null = null;
  // 音乐床频谱（仅 holo 启用）：把 music 元素重路由过 AudioContext 出真频谱喂波形。
  private musicSrc: MediaElementAudioSourceNode | null = null;
  private musicAnalyser: AnalyserNode | null = null;
  private raf = 0;
  private level = 0;
  private rampTimer: ReturnType<typeof setInterval> | null = null;
  // 音乐卡死看门狗：流中途断时 <audio> 既无 ended 也无 error(缓冲耗尽静默停),
  // 唯一外因兜底是整首标称时长的 advanceTimer——断得早会静默几分钟。这里主动检测:
  // 非暂停且 currentTime>0 却连续 ~10s 无进展 → 视同播完(onMusicEnded 切下一首)。
  private stallTimer: ReturnType<typeof setInterval> | null = null;
  /** 当前这首是否已经重试过一次（每首在 playTrack 里复位）。 */
  private musicRetried = false;
  private stallLastTime = -1;
  private stallStrikes = 0;
  // 用户总音量（0..1，localStorage 持久化）：与场景基准音量（playTrack=1 / playBed=0.22 / duck）
  // 相乘后落到元素上。这样 Stackchan 挥手调的是「总闸」，不打架现有的音乐床 duck 逻辑。
  private userVolume = DjPlayer.loadUserVolume();
  private baseMusicVol = 1;

  private static loadUserVolume(): number {
    try {
      const v = Number(localStorage.getItem('aiboo:holo-volume'));
      return Number.isFinite(v) && v > 0 && v <= 1 ? v : 1;
    } catch {
      return 1;
    }
  }

  /** 设置用户总音量（0..1）：立即作用于正在播的音乐，持久化；口播下一段生效。 */
  setUserVolume(v: number) {
    this.userVolume = Math.min(1, Math.max(0, v));
    try {
      localStorage.setItem('aiboo:holo-volume', String(this.userVolume));
    } catch {
      /* ignore */
    }
    this.music.volume = Math.min(1, Math.max(0, this.baseMusicVol * this.userVolume));
  }

  getUserVolume(): number {
    return this.userVolume;
  }

  constructor(
    private onLevel: (v: number) => void,
    private onMusicEnded: () => void,
    // 仅 holo 传 true：启用音乐床频谱重路由（移动端不传，music 保持纯 <audio> 直连，零回归）。
    private enableMusicAnalyser = false,
  ) {
    this.music = new Audio();
    this.music.crossOrigin = 'anonymous';
    this.music.preload = 'auto';
    this.music.onended = () => {
      this.clearStallWatch();
      this.onMusicEnded();
    };
    // ★music 原先是唯一没有 onerror 兜底的元素（voice/voiceDirect/一次性 audio 都有）。
    // 网络抖一下 → 加载失败 → currentTime 永远停在 0 → 停顿看门狗按设计放过 t===0 →
    // 没有任何人收这个错误 → **永久静音**，UI 还显示节目单给的时长（进度冻在 00:00/x:xx）。
    // 真机症状：播一阵后没声音，重启 App 才恢复（ThinkSmart View 挂热点，实测网络会断）。
    this.music.onerror = () => this.handleMusicFailure('error');

    this.voice = new Audio();
    this.voice.crossOrigin = 'anonymous';
    this.voice.preload = 'auto';

    this.voiceDirect = new Audio();
    this.voiceDirect.crossOrigin = 'anonymous';
    this.voiceDirect.preload = 'auto';
  }

  private ensureGraph() {
    if (this.ctx) return;
    const Ctor =
      window.AudioContext ||
      (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) return;
    this.ctx = new Ctor();
    try {
      this.voiceSrc = this.ctx.createMediaElementSource(this.voice);
      this.analyser = this.ctx.createAnalyser();
      this.analyser.fftSize = 256;
      this.voiceSrc.connect(this.analyser);
      this.analyser.connect(this.ctx.destination);
    } catch {
      // createMediaElementSource 对同一 element 只能调一次；失败则不做频谱分析
    }
  }

  /**
   * 音乐床频谱图（仅 holo，enableMusicAnalyser=true 时）：把 music 元素重路由过 ctx →
   * analyser → destination。★重路由后 music 只经 ctx 出声，ctx 挂起会静音★，所以只在
   * ctx 能 running(有手势) 时接；holo 登录点击=手势，ctx 可 resume。移动端不启用=纯直连。
   */
  private ensureMusicGraph() {
    if (!this.enableMusicAnalyser || this.musicSrc) return;
    this.ensureGraph();
    if (!this.ctx) return;
    if (this.ctx.state === 'suspended') this.ctx.resume().catch(() => {});
    djTrace('ensureMusicGraph ctx=' + this.ctx.state);
    try {
      this.musicSrc = this.ctx.createMediaElementSource(this.music);
      this.musicAnalyser = this.ctx.createAnalyser();
      this.musicAnalyser.fftSize = 256; // 128 频段，够 40 根波形条
      this.musicSrc.connect(this.musicAnalyser);
      this.musicAnalyser.connect(this.ctx.destination);
    } catch {
      // 重路由失败（元素已被接过）：放弃频谱，music 仍走原输出
      this.musicSrc = null;
      this.musicAnalyser = null;
    }
  }

  /** 音乐床频谱分析器（未启用/未建立时为 null）。holo 波形据此出真频谱。 */
  getMusicAnalyser(): AnalyserNode | null {
    return this.musicAnalyser;
  }

  private clearStallWatch() {
    if (this.stallTimer) {
      clearInterval(this.stallTimer);
      this.stallTimer = null;
    }
    this.stallLastTime = -1;
    this.stallStrikes = 0;
  }

  /**
   * 音乐床**显式 error 事件**的兜底：原地重试一次；仍失败就交给整首时长的 advanceTimer。
   * ★这里刻意**不强跳下一首**：真机实测过一次「后端整批取不到流 → 每首都 error → 一路空切」，
   *   2 秒内烧掉 5 首（resource timing 里连着 5 次 feedback+lyric）。与看门狗放行 t===0 同一初衷。
   * ★只处理 error 事件，不碰停顿看门狗对 t===0 的放行策略（那条是刻意设计、有测试锁定，
   * 目的是避免后端全挂时 10s 一首连环空切）。error 是明确失败，与「还在加载」语义不同。
   */
  private handleMusicFailure(reason: string): void {
    const err = this.music.error;
    djTrace('music ' + reason + ' code=' + (err ? err.code : '?') + ' retried=' + this.musicRetried
      + ' src=' + (this.music.src || '').slice(-46));
    if (this.musicRetried) return; // 已重试过：交给整首时长的 advanceTimer，不在此强跳
    this.musicRetried = true;
    const url = this.music.src;
    if (!url) return;
    setTimeout(() => {
      if (this.music.src !== url) return; // 期间已换歌
      try {
        this.music.load();
        void this.music.play().catch(() => { /* 仍失败：留给 advanceTimer */ });
      } catch { /* ignore */ }
    }, 2000);
  }

  private startStallWatch() {
    this.clearStallWatch();
    this.stallTimer = setInterval(() => {
      const t = this.music.currentTime;
      if (this.music.paused || this.music.ended) {
        this.stallLastTime = t;
        this.stallStrikes = 0;
        return;
      }
      // t===0 = 还没起播成功(加载失败等),不在此切——那类场景交给整首时长的 advanceTimer,
      // 避免后端全挂时 10s 一首连环空切。（此策略有测试锁定，勿改。显式 error 事件是另一回事，
      // 走 music.onerror → handleMusicFailure。）
      if (t > 0 && t === this.stallLastTime) {
        this.stallStrikes += 1;
        if (this.stallStrikes >= 2) {
          this.clearStallWatch();
          this.onMusicEnded();
          return;
        }
      } else {
        this.stallStrikes = 0;
      }
      this.stallLastTime = t;
    }, 5000);
  }

  /** 起播音乐（默认从头，正常音量）；seekMs>0 时从该位置续播（智能续播用）。 */
  async playTrack(url: string, seekMs = 0) {
    djTrace('playTrack seek=' + seekMs + ' ' + url.slice(-46));
    this.clearRamp();
    this.musicRetried = false; // 新一首：重试额度复位
    this.startStallWatch();
    this.ensureMusicGraph();
    this.music.src = url;
    this.baseMusicVol = 1;
    this.music.volume = this.userVolume;
    const seek = () => {
      try {
        this.music.currentTime = Math.max(0, seekMs) / 1000;
      } catch {
        /* 元数据未就绪：忽略，从头放 */
      }
    };
    if (seekMs > 0) {
      // currentTime 要等可定位后才生效
      this.music.addEventListener('loadedmetadata', seek, { once: true });
    } else {
      seek();
    }
    try {
      await this.music.play();
      djTrace('play() ok ctx=' + (this.ctx ? this.ctx.state : 'none')
        + ' paused=' + this.music.paused + ' rs=' + this.music.readyState);
    } catch (e) {
      // 自动播放被拦截（浏览器无手势）；真机 WebView 已关闭手势限制
      djTrace('play() 被拒 ' + ((e as Error)?.name || '?')
        + ' ctx=' + (this.ctx ? this.ctx.state : 'none'));
    }
    // 起播后再看一眼：ctx 仍 suspended 时元素会卡在 0 不前进（静音且进度不走）。
    setTimeout(() => {
      djTrace('play+3s ctx=' + (this.ctx ? this.ctx.state : 'none')
        + ' t=' + this.music.currentTime.toFixed(2)
        + ' paused=' + this.music.paused
        + ' err=' + (this.music.error ? this.music.error.code : 'none'));
    }, 3000);
  }

  /** 暂停（音乐+口播，不拆图，供 playPause 用）。 */
  pauseAll() {
    try {
      this.music.pause();
    } catch {
      /* ignore */
    }
    try {
      this.voice.pause();
    } catch {
      /* ignore */
    }
    try {
      this.voiceDirect.pause();
    } catch {
      /* ignore */
    }
    this.stopAnalysis();
  }

  /** 当前音乐已播毫秒。 */
  getMusicPositionMs(): number {
    return Number.isFinite(this.music.currentTime) ? this.music.currentTime * 1000 : 0;
  }

  /** 当前音乐总毫秒（元数据未就绪时为 0）。 */
  getMusicDurationMs(): number {
    return Number.isFinite(this.music.duration) ? this.music.duration * 1000 : 0;
  }

  /** 音乐是否处于暂停态。 */
  isMusicPaused(): boolean {
    return this.music.paused;
  }

  // ---- 通勤播客：低音量循环「音乐床」+ 顺序播放双主播口播 ----

  /** 起播背景音乐床：循环、低音量垫底（口播是主角）。 */
  async playBed(url: string, volume = 0.22) {
    this.clearRamp();
    this.clearStallWatch(); // 床是 loop,「切下一首」语义不适用
    this.ensureMusicGraph();
    this.music.loop = true;
    this.music.src = url;
    this.baseMusicVol = volume;
    this.music.volume = Math.min(1, Math.max(0, volume * this.userVolume));
    try {
      await this.music.play();
    } catch {
      /* 自动播放被拦截：真机 WebView 已放开 */
    }
  }

  /** 设置音乐床基准音量（深挖时临时抬升/恢复用；实际输出再乘用户总音量）。 */
  setMusicVolume(v: number) {
    this.clearRamp();
    this.baseMusicVol = Math.min(1, Math.max(0, v));
    this.music.volume = Math.min(1, Math.max(0, this.baseMusicVol * this.userVolume));
  }

  /**
   * 播放一段口播音频，驱动口型；播完(或失败)后 resolve。
   * 用于通勤播客「逐段对话」与深挖插播——音乐床保持原音量，不做 duck。
   *
   * 后台/锁屏兜底：Android WebView 冻结后 onended 可能不触发，
   * 用 timeupdate + setInterval 双重检测确保 Promise 一定会 resolve。
   */
  /**
   * 展示台口播：**声音交原生播，嘴形用离线包络驱动**。
   *
   * 为什么不用 speakClip：那条走 WebView 的 <audio>，在展示台这台 ROM 上根本走不动
   *（play() 成功、readyState=4、无报错，而 currentTime 卡在 0 —— 当初把音乐搬到原生
   * 就是因为它）。真机实测：口播一直触发、TTS 也一直生成成功，但从来没有播完过
   * （日志里只有 `play(native-duck) start`，永远等不到 end），而它抢走的音频焦点
   * 又把音乐播放器打成暂停——「听不到口播 + 音乐自己停住」两个现象是同一件事。
   *
   * 改法：同一段 mp3 取回来先解码算出整条口型包络，再让原生播；
   * 播放期间按时间轴把包络喂给 setMouth。嘴形的平滑仍是 smoothMouthLevel，没重写。
   *
   * @param startNative 真正让原生出声的回调，返回 false 表示当前不是原生环境。
   */
  async speakViaNative(url: string, startNative: (u: string) => boolean): Promise<void> {
    this.ensureGraph();
    let envelope: Float32Array | null = null;
    let durationMs = 0;
    try {
      const bytes = await (await fetch(url)).arrayBuffer();
      const decoded = await this.ctx!.decodeAudioData(bytes);
      envelope = envelopeFromPcm(decoded.getChannelData(0), decoded.sampleRate);
      durationMs = decoded.duration * 1000;
    } catch {
      // 解码失败就只出声、不动嘴。有声音比"既没声音又卡着"强得多。
    }

    if (!startNative(url)) return;

    // 没解出时长时给个上限，别让调用方的 speaking 标志一直挂着——
    // 旧实现正是卡在这里：兜底要 20 次 ×3 秒 = 60 秒才肯放弃。
    const totalMs = durationMs > 0 ? durationMs : 8000;
    await new Promise<void>((resolve) => {
      const started = performance.now();
      const step = () => {
        const elapsed = performance.now() - started;
        if (elapsed >= totalMs) {
          this.level = 0;
          this.onLevel(0);
          resolve();
          return;
        }
        if (envelope) {
          this.level = smoothMouthLevel(this.level, envelopeLevelAt(envelope, elapsed));
          this.onLevel(this.level);
        }
        this.raf = requestAnimationFrame(step);
      };
      cancelAnimationFrame(this.raf);
      this.raf = requestAnimationFrame(step);
    });
  }

  speakClip(url: string): Promise<void> {
    return new Promise((resolve) => {
      this.ensureGraph();
      if (this.ctx?.state === 'suspended') this.ctx.resume().catch(() => {});
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        this.stopAnalysis();
        resolve();
      };
      this.voice.src = url;
      this.voice.volume = this.userVolume;
      this.voice.onended = finish;
      this.voice.onerror = finish;

      // 兜底 1：timeupdate 检测接近结束
      const onTimeUpdate = () => {
        if (this.voice.currentTime > 0 && this.voice.duration > 0 && this.voice.currentTime >= this.voice.duration - 1) {
          this.voice.removeEventListener('timeupdate', onTimeUpdate);
          finish();
        }
      };
      this.voice.addEventListener('timeupdate', onTimeUpdate);

      // 兜底 2：轮询（后台 setInterval 会被减速，但一般不会完全掐掉）
      let pollCount = 0;
      const poll = setInterval(() => {
        pollCount++;
        if (this.voice.ended || this.voice.paused || this.voice.currentTime === 0 && pollCount > 20) {
          clearInterval(poll);
          this.voice.removeEventListener('timeupdate', onTimeUpdate);
          finish();
          return;
        }
        if (this.voice.currentTime > 0 && this.voice.duration > 0 && this.voice.currentTime >= this.voice.duration - 0.5) {
          clearInterval(poll);
          this.voice.removeEventListener('timeupdate', onTimeUpdate);
          finish();
        }
      }, 3000);

      try {
        this.voice.currentTime = 0;
        const p = this.voice.play();
        if (p && typeof p.then === 'function') p.then(() => this.startAnalysis()).catch(finish);
        else this.startAnalysis();
      } catch {
        finish();
      }
    });
  }

  /**
   * 通勤播客专用：直连播放一段口播（不经 AudioContext、不做口型分析）。
   * 这样锁屏/切后台时浏览器挂起 AudioContext 也不影响——口播能像音乐床一样继续走完整集。
   *
   * 后台/锁屏兜底：Android WebView 冻结后 onended 可能不触发，
   * 用 timeupdate + setInterval 双重检测确保 Promise 一定会 resolve。
   */
  speakClipDirect(url: string): Promise<void> {
    return new Promise((resolve) => {
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        resolve();
      };
      this.voiceDirect.src = url;
      this.voiceDirect.volume = this.userVolume;
      this.voiceDirect.onended = finish;
      this.voiceDirect.onerror = finish;

      // 兜底 1：timeupdate 检测接近结束
      const onTimeUpdate = () => {
        if (this.voiceDirect.currentTime > 0 && this.voiceDirect.duration > 0 && this.voiceDirect.currentTime >= this.voiceDirect.duration - 1) {
          this.voiceDirect.removeEventListener('timeupdate', onTimeUpdate);
          finish();
        }
      };
      this.voiceDirect.addEventListener('timeupdate', onTimeUpdate);

      // 兜底 2：轮询（后台 setInterval 会被减速，但一般不会完全掐掉）
      let pollCount = 0;
      const poll = setInterval(() => {
        pollCount++;
        if (this.voiceDirect.ended || this.voiceDirect.paused || (this.voiceDirect.currentTime === 0 && pollCount > 20)) {
          clearInterval(poll);
          this.voiceDirect.removeEventListener('timeupdate', onTimeUpdate);
          finish();
          return;
        }
        if (this.voiceDirect.currentTime > 0 && this.voiceDirect.duration > 0 && this.voiceDirect.currentTime >= this.voiceDirect.duration - 0.5) {
          clearInterval(poll);
          this.voiceDirect.removeEventListener('timeupdate', onTimeUpdate);
          finish();
        }
      }, 3000);

      try {
        this.voiceDirect.currentTime = 0;
        const p = this.voiceDirect.play();
        if (p && typeof p.then === 'function') p.catch(finish);
      } catch {
        finish();
      }
    });
  }

  /** 口播叠在当前音乐上：压低音乐 → 放口播 → 口播完恢复音乐音量。
   *  锁屏/切后台时走 voiceDirect（不经 AudioContext），避免浏览器挂起 AudioContext 导致口播中断。
   *  亮屏时仍走 voice（接入 AudioContext），保留 Live2D 口型分析。
   *
   *  后台/锁屏兜底：onended 可能不触发，用 timeupdate + setInterval 双重检测。 */
  async duckSpeak(url: string) {
    // 面包屑：Ben 真机复现「口播结束后音乐停住、再不播放」。这条链跨 duckSpeak → unduck →
    // 上层节目单推进，日志把断点定位到具体一跳，避免再靠猜。
    djTrace('duckSpeak start; musicPaused=' + this.music.paused + ' ended=' + this.music.ended
      + ' t=' + this.music.currentTime.toFixed(1));
    this.clearRamp();
    this.music.volume = DUCK_VOLUME;

    const useDirect = document.hidden || !this.ctx || this.ctx.state === 'suspended';
    const audio = useDirect ? this.voiceDirect : this.voice;
    audio.src = url;

    const setupFallback = (onDone: () => void) => {
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        onDone();
      };
      audio.onended = finish;
      audio.onerror = finish;

      const onTimeUpdate = () => {
        if (audio.currentTime > 0 && audio.duration > 0 && audio.currentTime >= audio.duration - 1) {
          audio.removeEventListener('timeupdate', onTimeUpdate);
          finish();
        }
      };
      audio.addEventListener('timeupdate', onTimeUpdate);

      let pollCount = 0;
      const poll = setInterval(() => {
        pollCount++;
        if (audio.ended || audio.paused || (audio.currentTime === 0 && pollCount > 20)) {
          clearInterval(poll);
          audio.removeEventListener('timeupdate', onTimeUpdate);
          finish();
          return;
        }
        if (audio.currentTime > 0 && audio.duration > 0 && audio.currentTime >= audio.duration - 0.5) {
          clearInterval(poll);
          audio.removeEventListener('timeupdate', onTimeUpdate);
          finish();
        }
      }, 3000);
    };

    if (useDirect) {
      setupFallback(() => this.unduck());
      try {
        audio.currentTime = 0;
        await audio.play();
      } catch {
        this.unduck();
      }
    } else {
      this.ensureGraph();
      if (this.ctx?.state === 'suspended') {
        await this.ctx.resume().catch(() => {});
      }
      setupFallback(() => {
        this.stopAnalysis();
        this.unduck();
      });
      try {
        audio.currentTime = 0;
        await audio.play();
      } catch {
        this.unduck();
        return;
      }
      this.startAnalysis();
    }
  }

  private unduck() {
    djTrace('unduck; musicPaused=' + this.music.paused + ' ended=' + this.music.ended
      + ' t=' + this.music.currentTime.toFixed(1)
      + ' vol->' + (this.baseMusicVol * this.userVolume).toFixed(2));
    this.stopAnalysis();
    this.clearRamp();
    const start = this.music.volume;
    // ★恢复目标必须是「场景基准 × 用户总音量」，不是写死的 1：
    // 原实现固定拉到 1，会把 playBed(0.22) 的背景床和用户调低的总音量一起顶到满音量。
    const target = Math.min(1, Math.max(0, this.baseMusicVol * this.userVolume));
    const steps = 12;
    let i = 0;
    this.rampTimer = setInterval(() => {
      i += 1;
      this.music.volume = Math.min(1, Math.max(0, start + (target - start) * (i / steps)));
      if (i >= steps) this.clearRamp();
    }, UNDUCK_MS / 12);
  }

  private clearRamp() {
    if (this.rampTimer) {
      clearInterval(this.rampTimer);
      this.rampTimer = null;
    }
  }

  private startAnalysis() {
    if (!this.analyser) return;
    const buf = new Uint8Array(this.analyser.frequencyBinCount);
    const loop = () => {
      if (!this.analyser) return;
      this.analyser.getByteFrequencyData(buf);
      const raw = analyzeAudioLevel(buf);
      this.level = smoothMouthLevel(this.level, raw);
      this.onLevel(this.level);
      this.raf = requestAnimationFrame(loop);
    };
    cancelAnimationFrame(this.raf);
    this.raf = requestAnimationFrame(loop);
  }

  private stopAnalysis() {
    cancelAnimationFrame(this.raf);
    this.raf = 0;
    this.level = 0;
    this.onLevel(0);
  }

  /** 用户手势内调用：恢复被自动播放策略挂起的 AudioContext / 音频。 */
  async resume() {
    if (this.ctx?.state === 'suspended') {
      await this.ctx.resume().catch(() => {});
    }
    if (this.music.src && this.music.paused) {
      try {
        await this.music.play();
      } catch {
        /* 仍被拦截：等下次手势 */
      }
    }
    if (this.voice.src && this.voice.paused && this.voice.currentTime < this.voice.duration) {
      try {
        await this.voice.play();
        this.startAnalysis();
      } catch {
        /* ignore */
      }
    }
    // 通勤直连口播：被暂停且未播完则继续。
    if (this.voiceDirect.src && this.voiceDirect.paused && this.voiceDirect.currentTime < this.voiceDirect.duration) {
      try {
        await this.voiceDirect.play();
      } catch {
        /* ignore */
      }
    }
  }

  stop() {
    this.clearRamp();
    this.stopAnalysis();
    try {
      this.music.pause();
    } catch {
      /* ignore */
    }
    try {
      this.voice.pause();
    } catch {
      /* ignore */
    }
    try {
      this.voiceDirect.pause();
    } catch {
      /* ignore */
    }
  }

  dispose() {
    this.stop();
    this.clearStallWatch();
    this.music.onended = null;
    this.voice.onended = null;
    this.voiceDirect.onended = null;
    try {
      this.ctx?.close();
    } catch {
      /* ignore */
    }
    this.ctx = null;
    this.analyser = null;
    this.voiceSrc = null;
    this.musicSrc = null;
    this.musicAnalyser = null;
  }
}

// ---- 播放进度持久化（按「日期+模式+时段」，只留当天 → 每天自动重置） ----
// 每个模式各有自己的「开场口播一次 + 续播进度」，互不影响。

const PROGRESS_KEY = 'aiboo:dj-progress';

function progressField(mode: string, daypartKey: string): string {
  return `${mode}:${daypartKey}`;
}

/** 读某模式某时段下一首要播的歌索引；null = 当天该(模式,时段)还没开过（应播开场口播 + 从第 0 首起）。 */
function loadDaypartProgress(date: string, mode: string, daypartKey: string): number | null {
  try {
    const all = JSON.parse(localStorage.getItem(PROGRESS_KEY) || '{}');
    if (!all || all.date !== date || !all.parts) return null;
    const v = all.parts[progressField(mode, daypartKey)];
    return typeof v === 'number' ? v : null;
  } catch {
    return null;
  }
}

/** 写某模式某时段下一首索引；换天则整体重置（只保留当天）。 */
function saveDaypartProgress(date: string, mode: string, daypartKey: string, nextIdx: number) {
  try {
    let all = JSON.parse(localStorage.getItem(PROGRESS_KEY) || '{}');
    if (!all || all.date !== date || !all.parts) all = { date, parts: {} };
    all.parts[progressField(mode, daypartKey)] = nextIdx;
    localStorage.setItem(PROGRESS_KEY, JSON.stringify(all));
  } catch {
    /* ignore */
  }
}

// ---- 智能续播快照（退出时存当前歌+进度+时刻，再进 30min 内同时段精确续播） ----

const RESUME_KEY = 'aiboo:dj-resume';
const RESUME_WINDOW_MS = 30 * 60_000; // 退出超过 30min → 不续播，按时刻对齐

interface ResumeSnapshot {
  date: string;
  mode: string;
  daypartKey: string;
  idx: number;
  positionMs: number;
  leftAt: number;
}

function saveResume(s: ResumeSnapshot) {
  try {
    localStorage.setItem(RESUME_KEY, JSON.stringify(s));
  } catch {
    /* ignore */
  }
}

function loadResume(): ResumeSnapshot | null {
  try {
    const s = JSON.parse(localStorage.getItem(RESUME_KEY) || 'null');
    if (s && typeof s.idx === 'number' && typeof s.leftAt === 'number') return s as ResumeSnapshot;
  } catch {
    /* ignore */
  }
  return null;
}

function clearResume() {
  try {
    localStorage.removeItem(RESUME_KEY);
  } catch {
    /* ignore */
  }
}

// ---- 行为反馈上报（喂给后端按天聚合 → 次日节目迭代） ----

export type DjFeedbackAction = 'enter' | 'play_start' | 'finish' | 'skip' | 'prev' | 'like' | 'dislike';

/** 上报一条行为日志；后端无该端点/离线时静默失败，不影响播放。 */
function postFeedback(
  base: string,
  payload: {
    action: DjFeedbackAction;
    mode: string;
    daypart?: string;
    ncm_id?: string;
    title?: string;
    artist?: string;
    position_ms?: number;
  },
) {
  try {
    fetch(`${base}/api/dj/feedback`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...payload, ts: Date.now() }),
      keepalive: true,
    }).catch(() => {});
  } catch {
    /* ignore */
  }
}

// ---- 蓝牙/系统媒体键（MediaSession）：耳机上/下一首键 → 切歌 ----

function updateMediaSession(item: DjItem | null, paused: boolean) {
  const nav = navigator as Navigator & { mediaSession?: MediaSession };
  if (!nav.mediaSession) return;
  if (item && typeof MediaMetadata !== 'undefined') {
    nav.mediaSession.metadata = new MediaMetadata({
      title: item.title || 'AI 电台',
      artist: item.artist || '主播',
      album: 'AI DJ',
      artwork: item.pic_url ? [{ src: item.pic_url, sizes: '300x300', type: 'image/jpeg' }] : [],
    });
  }
  try {
    nav.mediaSession.playbackState = paused ? 'paused' : 'playing';
  } catch {
    /* ignore */
  }
}

// ---- React hook ----

const PROGRAM_REFRESH_MS = 30 * 60_000; // 每 30min 静默刷新节目单（拾取重生成/新一天），不打断播放
const RETRY_MS = 15_000; // 未就绪（生成中/网络错）时的重试间隔
const IDLE_RECHECK_MS = 60_000; // 当前时段无内容：1min 后重算

/**
 * 进入电台（DJ 模式）：拉「当日节目单」(/api/program/today)，按当前时段**顺序点播**。
 * - 当天某时段**首次打开**：从第 0 首起播，并叠一段开场口播（口播时压低音乐，口播完恢复）。
 * - 当天该时段**再次打开**：跳过口播，从「还没播的下一首」接着放；放完一轮循环。
 * - 跨到新时段：按「首次打开」处理（口播 + 从头）。
 * - 退出（卸载）即停（杀双路播放器、清定时器、关 AudioContext）。
 * controller 为空（Live2D 未就绪）时仍播放，只是暂不驱动口型。
 */
export function useDj(
  controller: Live2DController | null,
  enabled = true,
  mode = 'focus',
  // 仅 holo 传 true：启用音乐床频谱重路由。移动端缺省 false=纯 <audio> 直连(零回归)。
  enableMusicAnalyser = false,
  /**
   * ★强制走 WebView <audio> 播放，跳过原生前台服务那条路。
   * ThinkSmart View 实测：原生 musicStart 报成功、UI 照常显示歌名，但系统里
   * 根本没有活跃 MediaSession（音量键日志 "Adjusting null"），结果是永久静音。
   * 常驻展示设备宁可用确定能出声的 <audio>，不赌原生服务在这台 ROM 上的行为。
   */
  preferWebAudio = false,
): DjView {
  const [state, setState] = useState<DjState>({
    status: 'idle',
    playing: null,
    queue: [],
    segment: null,
    emotion: null,
    paused: false,
    feedback: null,
  });

  // 音乐床频谱分析器（仅 holo 启用；播放建立后填入，退出置空）。喂给波形出真频谱。
  const [musicAnalyser, setMusicAnalyser] = useState<AnalyserNode | null>(null);

  const controllerRef = useRef<Live2DController | null>(controller);
  controllerRef.current = controller;

  // 播放器命令桥：effect 内部填充最新实现，hook 暴露稳定包装（身份不变，始终调当前实现）。
  const implRef = useRef<DjControls | null>(null);
  const controls = useMemo<DjControls>(
    () => ({
      playPause: () => implRef.current?.playPause(),
      next: () => implRef.current?.next(),
      prev: () => implRef.current?.prev(),
      like: () => implRef.current?.like(),
      dislike: () => implRef.current?.dislike(),
      getPositionMs: () => implRef.current?.getPositionMs() ?? 0,
      getDurationMs: () => implRef.current?.getDurationMs() ?? 0,
      dig: (topic: string) => implRef.current?.dig?.(topic) ?? Promise.resolve(false),
      setVolume: (v: number) => implRef.current?.setVolume(v),
      getVolume: () => implRef.current?.getVolume() ?? 1,
    }),
    [],
  );

  useEffect(() => {
    // 未处于 DJ 模式：不拉节目单、不放音乐（屏保此时只显示未换装形象）。
    if (!enabled) {
      setState((s) => ({ ...s, status: 'idle' }));
      return;
    }
    const base = getServerBaseUrl();
    if (!base) {
      setState((s) => ({ ...s, status: 'idle' }));
      return;
    }

    let closed = false;
    let program: DayProgram | null = null;
    // 当前时段的歌曲列表 + 正在播的索引
    let cur: { daypartKey: string; daypartName: string; tracks: ProgramItem[]; idx: number } | null = null;
    let curItem: DjItem | null = null; // 当前播放项（媒体会话/反馈用）
    // 按需口播：进场口播 + 每隔 3~5 首随机串场（实时生成，关联城市/天气/歌曲/歌手）。
    let speaking = false;
    let sinceSpeak = 0;
    let speakThreshold = 3 + Math.floor(Math.random() * 3); // 3/4/5
    let advanceTimer: ReturnType<typeof setTimeout> | null = null;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    let refreshTimer: ReturnType<typeof setInterval> | null = null;

    // 原生前台 Service 播放音乐（锁屏后台续播 + 锁屏控制）：非通勤模式在真机上整段歌单交原生循环。
    // 灭屏后 WebView 冻结、JS 轮询停摆，但音频在原生侧继续——这是锁屏续播的关键。亮屏时轮询同步 UI。
    const wantNativeMusic = !preferWebAudio && mode !== 'commute' && hasNativeCommute();
    let useNativeMusic = false;
    let musicPollTimer: ReturnType<typeof setInterval> | null = null;
    /** 原生起播「按结果验收」的一次性定时器；见 startNativeMusic。 */
    let nativeVerifyTimer: ReturnType<typeof setTimeout> | null = null;
    let lastMusicIdx = -1;
    let lastMusicPlaying = false;
    let nativeMusicPositionMs = 0;
    let musicPollTicks = 0;
    let musicPaused = false;
    let musicPollInFlight = false;

    const player = new DjPlayer(
      (level) => controllerRef.current?.setMouth(level),
      () => advanceTrack(), // 音乐自然播完 → 下一首
      enableMusicAnalyser,
    );

    function clearAdvance() {
      if (advanceTimer) {
        clearTimeout(advanceTimer);
        advanceTimer = null;
      }
    }

    function trackToDjItem(item: ProgramItem): DjItem {
      return {
        kind: 'track',
        queue_item_id: item.id,
        duration_ms: item.duration_ms,
        ncm_id: item.ncm_id,
        title: item.title,
        artist: item.artist,
        pic_url: item.pic_url,
        started_at: new Date().toISOString(),
      };
    }
    function ttsToDjItem(item: ProgramItem): DjItem {
      return {
        kind: 'tts',
        queue_item_id: item.id,
        duration_ms: item.duration_ms,
        audio_url: item.audio_url,
        role: item.role,
        text: item.text,
      };
    }

    // 播第 idx 首；seekMs>0 续播；intro 非空则叠开场口播。排一个兜底定时器防 'ended' 不触发。
    // 当前是否暂停（JS 路径看音乐元素，原生路径看本地暂停态）。
    function isPaused(): boolean {
      return useNativeMusic ? musicPaused : player.isMusicPaused();
    }

    // 把一首曲子呈现到 UI（状态/媒体会话/封面懒取/play_start 反馈）。JS 与原生两条播放路径共用。
    // nativeIndex：原生路径下该曲在歌单中的下标，封面懒取到后回填给原生 MediaSession（锁屏显示封面）。
    function presentTrack(item: DjItem, nativeIndex?: number) {
      curItem = item;
      setState({
        status: 'connected',
        playing: item,
        queue: [],
        segment: cur ? { segment_id: cur.daypartKey, title: cur.daypartName } : null,
        emotion: null,
        // 必须取真实暂停态，不能硬编码 false：本函数除了「切歌」还会被 startMusicPoll 的
        // 700ms 轮询经 applyNativeIndex 调到。硬写 false 会在用户点暂停后的一个轮询周期内
        // 把 UI 打回「播放中」——现象是图标闪一下又变回去、音乐明明停了却显示未暂停，
        // 且因内部 musicPaused 与 UI 状态脱节而要点两次才像生效。
        paused: isPaused(),
        feedback: null,
      });
      // holo：音乐床已重路由，把频谱分析器上抛给波形（一次性；ref 稳定后 React 自动 bail）。
      setMusicAnalyser(player.getMusicAnalyser());
      updateMediaSession(item, isPaused());
      // 专辑封面懒取（节目单未存 pic_url 时）：拿到后回填当前曲 + 媒体会话。
      if (!item.pic_url && item.ncm_id) {
        fetch(`${base}/api/track/cover?ncm_id=${encodeURIComponent(item.ncm_id)}`)
          .then((r) => (r.ok ? r.json() : null))
          .then((d) => {
            const pic = d?.pic_url;
            if (pic && curItem === item) {
              item.pic_url = pic;
              setState((s) => (s.playing === item ? { ...s, playing: { ...item } } : s));
              updateMediaSession(item, isPaused());
              // 原生路径：把封面补给该曲的 MediaSession（锁屏卡片显示封面）。
              if (useNativeMusic && nativeIndex != null) musicSetArtworkNative(nativeIndex, pic);
            }
          })
          .catch(() => {});
      }
      postFeedback(base, {
        action: 'play_start',
        mode,
        daypart: cur?.daypartKey,
        ncm_id: item.ncm_id,
        title: item.title,
        artist: item.artist,
      });
    }

    function playTrackAt(idx: number, intro: ProgramItem | null, seekMs = 0) {
      if (!cur) return;
      const track = cur.tracks[idx];
      const item = trackToDjItem(track);
      const turl = streamUrl(base, item);
      if (turl) player.playTrack(turl, seekMs).catch(() => {});
      if (intro) {
        const vurl = streamUrl(base, ttsToDjItem(intro));
        if (vurl) player.duckSpeak(vurl).catch(() => {});
      }
      presentTrack(item);
      clearAdvance();
      const remaining = Math.max(1000, track.duration_ms - Math.max(0, seekMs));
      advanceTimer = setTimeout(advanceTrack, remaining + 1500);
    }

    // ---- 原生前台 Service 播放音乐（锁屏续播 + 锁屏控制）----

    // 原生上报/手动切到第 idx 首：仅刷新 UI（音频已在原生侧播放/切换）。
    function applyNativeIndex(idx: number) {
      if (!cur) return;
      const track = cur.tracks[idx];
      if (!track) return;
      cur.idx = idx;
      saveDaypartProgress(program?.date || '', mode, cur.daypartKey, idx);
      presentTrack(trackToDjItem(track), idx);
    }

    // 起播：把当前时段整段歌单直链交原生循环播放，并开始亮屏轮询同步 UI。
    /** 原生起播验收窗口：够 ExoPlayer 连上后端流并推进，又不至于让用户干等太久。 */
    const NATIVE_VERIFY_MS = 6000;
    /**
     * 原生起播失败时的重试次数。
     * ★为什么不直接回落：真机实测，回落目标（WebView <audio>）在这台 ROM 上根本走不动——
     * play() 成功、paused=false、readyState=4、err=none、ctx=running，而 currentTime
     * 卡在 0.00~0.08 一秒都不走；停顿看门狗随即每 ~15 秒切一首，正是「一首接一首跳曲、
     * 进度永远 00:00」。而原生路只要真起来就是 speed=1.0 的实时播放（media_session 实证）。
     * 所以原生起播不稳时应当**再试原生**，而不是降级到一条已证明是死路的路。
     * 次数从 3 提到 12：Ben 又撞到「三次用尽 → 永久静音」。实测第 1~2 次重试通常就成，
     * 12 次是给偶发的慢启动留足余量（最坏约 72 秒），总好过直接静音一整天。
     * （holo 能用 WebView 那条路，是因为它常开麦克风、有活跃 WebRTC 会话把音频拉起来；
     * 展示台没有麦克风会话，这个前提不成立。）
     */
    const NATIVE_START_RETRIES = 12;
    let nativeStartAttempts = 0;

    /** 原生播放不可用时回落到 WebView <audio>，保证有声音（原生侧问题不该等于没音乐）。 */
    function fallbackToWebAudio(reason: string, idx: number, posMs: number) {
      djTrace('回落 WebView 播放器：' + reason);
      useNativeMusic = false;
      stopMusicPoll();
      playTrackAt(idx, null, posMs);
    }

    /** 原生起播没成：还有预算就重开一次原生（先停掉上一轮），预算用尽才回落。 */
    function retryOrFallback(reason: string, idx: number, posMs: number, withIntro: boolean) {
      if (closed) return;
      if (nativeStartAttempts < NATIVE_START_RETRIES) {
        djTrace('原生起播重试 #' + nativeStartAttempts + '：' + reason);
        stopMusicPoll();
        // ★重试前**不要**调 commuteStopNative()。它是 fire-and-forget（返回 void、
        // 内部把 promise 吞掉），没法等它停完；实测那条迟到的 stop 会落在新播放器
        // 起来之后，把刚 Init 的 ExoPlayer/MediaSession 当场打死 —— logcat 里就是
        // `Init … 161ms … Release` 反复循环，重试越多踩得越狠，12 次全废。
        // 直接重发 start 即可：musicStartNative 带的是新 sessionId + 整段歌单。
        startNativeMusic(idx, posMs, withIntro);
        return;
      }
      fallbackToWebAudio(reason + '（原生已重试 ' + NATIVE_START_RETRIES + ' 次）', idx, posMs);
    }

    function startNativeMusic(startIdx: number, startPositionMs: number, withIntro: boolean) {
      if (!cur || !program) return;
      // 直链 + 逐曲元数据位置对齐（歌名/歌手/封面 → 锁屏系统媒体控件显示）。
      const playable = cur.tracks
        .map((t) => trackToDjItem(t))
        .map((item) => ({ url: streamUrl(base, item), item }))
        .filter((x): x is { url: string; item: DjItem } => !!x.url);
      if (playable.length === 0) {
        enterIdle();
        return;
      }
      useNativeMusic = true;
      musicPaused = false;
      nativeStartAttempts += 1;
      const sessionId = `${program.date}|${mode}|${cur.daypartKey}`;
      applyNativeIndex(startIdx); // 立刻呈现首曲，避免轮询回来前空白
      djTrace('startNativeMusic idx=' + startIdx + ' n=' + playable.length + ' pos=' + startPositionMs);
      // ★原来这里对返回值不做任何处理，而桥接层 musicStartNative 会把异常吞掉返回 false：
      // 原生起播一旦失败就**既不回落、也不报错**——UI 照常显示歌名（applyNativeIndex 已跑过）、
      // 轮询照常空转，结果是永久静音而界面看起来完全正常。真机实测到的就是这个状态。
      // 现在接住结果：失败即回落 WebView <audio> 播放器，保证有声音。
      void musicStartNative({
        sessionId,
        urls: playable.map((x) => x.url),
        titles: playable.map((x) => x.item.title || ''),
        artists: playable.map((x) => x.item.artist || ''),
        artworks: playable.map((x) => x.item.pic_url || ''),
        startIndex: startIdx,
        startPositionMs: Math.max(0, startPositionMs),
        title: 'AI 电台',
      }).then((ok) => {
        djTrace('musicStartNative -> ' + ok);
        if (ok || closed) return;
        retryOrFallback('原生下发失败', startIdx, startPositionMs, withIntro);
      });
      startMusicPoll();

      // ★按结果验收，不信「指令已下发」：插件的 musicStart 是 startForegroundService，
      // intent 一送出就 resolve，返回 true **不代表真的出声**。真机实测过这个组合——
      // musicStartNative -> true，但服务在 3ms 后就被销毁（MediaSession/ExoPlayer Release），
      // 2 秒后播放器重建却无人补发指令 → 永久静音，且 UI 一切正常（歌名/时长照常显示）。
      // 所以这里等几秒看原生进度是否真的在走，不走就回落 WebView 播放器，保证一定有声音。
      if (nativeVerifyTimer) clearTimeout(nativeVerifyTimer);
      nativeVerifyTimer = setTimeout(() => {
        nativeVerifyTimer = null;
        // ★不要把 musicPaused 当作跳过条件：轮询发现原生「没在播」时正是把它置 true，
        // 那恰恰是故障特征本身（第一版守卫写成 `|| musicPaused` 直接把验收静默跳过了）。
        // 判据只看一条：原生进度有没有真的推进。
        if (closed || !useNativeMusic) { djTrace('验收跳过 closed=' + closed + ' native=' + useNativeMusic); return; }
        if (nativeMusicPositionMs > 0) { djTrace('原生起播已确认在走 pos=' + nativeMusicPositionMs); return; }
        retryOrFallback('原生起播 ' + NATIVE_VERIFY_MS + 'ms 无进展', startIdx, startPositionMs, withIntro);
      }, NATIVE_VERIFY_MS);
      if (withIntro) requestSpeak('intro');
    }

    function stopMusicPoll() {
      if (nativeVerifyTimer) { clearTimeout(nativeVerifyTimer); nativeVerifyTimer = null; }
      if (musicPollTimer) {
        clearInterval(musicPollTimer);
        musicPollTimer = null;
      }
    }

    // 亮屏轮询原生播放状态：同步当前曲/进度/暂停态；原生自动切歌时跟随并触发串场口播节奏；
    // wall-clock 跨时段则切到新时段。灭屏后随 WebView 冻结而停，音频在原生侧不受影响。
    function startMusicPoll() {
      stopMusicPoll();
      lastMusicIdx = -1;
      lastMusicPlaying = false;
      musicPollTicks = 0;
      const tick = async () => {
        if (closed || !useNativeMusic || musicPollInFlight) return;
        musicPollInFlight = true;
        let st;
        try {
          st = await commuteStateNative();
        } finally {
          musicPollInFlight = false;
        }
        if (closed || !useNativeMusic || !st || !cur) return;
        musicPaused = !st.playing;
        nativeMusicPositionMs = st.positionMs || 0;
        // 诊断心跳：UI 进度与原生脱节时，靠这条分清是「轮询根本没跑」还是
        // 「跑了但原生回报的 position 本身就是旧的」。t 用来量 tick 实际间隔。
        if (++musicPollTicks % 20 === 0) {
          djTrace('poll#' + musicPollTicks + ' t=' + (Date.now() % 1000000)
            + ' native=' + useNativeMusic + ' idx=' + st.index
            + ' pos=' + Math.round(nativeMusicPositionMs) + ' playing=' + st.playing);
        }
        // 跨时段 → 切新时段（重新把新歌单交给原生）。
        const dpNow = program ? resolveCurrentDaypart(program, msSinceLocalMidnight(new Date()), { fallbackToNearest: true }) : null;
        if (dpNow && dpNow.key !== cur.daypartKey) {
          startDaypart(dpNow);
          return;
        }
        const len = cur.tracks.length;
        if (len === 0) return;
        const idx = ((st.index % len) + len) % len;
        if (idx === lastMusicIdx && st.playing === lastMusicPlaying) return;
        const advanced = lastMusicIdx !== -1 && idx !== lastMusicIdx; // 原生自动切到下一首
        lastMusicIdx = idx;
        lastMusicPlaying = st.playing;
        applyNativeIndex(idx);
        if (advanced) tickSpeakCadence();
      };
      tick();
      musicPollTimer = setInterval(tick, 700);
    }

    // 口播音频地址：相对 /uploads/... 补 base；已是绝对地址原样用。
    function speakUrl(audioUrl: string | undefined): string | undefined {
      if (!audioUrl) return undefined;
      if (/^https?:\/\//i.test(audioUrl)) return audioUrl;
      return `${base}${audioUrl.startsWith('/') ? '' : '/'}${audioUrl}`;
    }

    // 实时生成一段口播并 duck 插播（kind: intro 进场 / interlude 串场）。生成慢没关系，音乐照常播。
    async function requestSpeak(kind: 'intro' | 'interlude') {
      if (closed || speaking || !cur) {
        console.log('[dj-intro] skip', { kind, closed, speaking, hasCur: !!cur });
        return;
      }
      speaking = true;
      const ctxItem = curItem;
      try {
        const params = new URLSearchParams({ mode, daypart: cur.daypartKey, kind });
        if (ctxItem?.ncm_id) params.set('ncm_id', ctxItem.ncm_id);
        if (ctxItem?.title) params.set('title', ctxItem.title);
        if (ctxItem?.artist) params.set('artist', ctxItem.artist);
        // 关联设备所在城市天气（与屏保同一套定位）
        const city = await resolveDeviceCity().catch(() => '');
        if (city) params.set('city', city);
        if (closed) return;
        const reqUrl = `${base}/api/dj/intro?${params.toString()}`;
        console.log('[dj-intro] fetch', { kind, reqUrl });
        const res = await fetch(reqUrl);
        console.log('[dj-intro] resp', { status: res.status, ok: res.ok });
        if (closed || !res.ok) return;
        const data = await res.json();
        const url = speakUrl(data?.audio_url);
        // SoulLink 情绪源(P1)：把这段口播文本喂给情绪引擎（best-effort，仅提供该回调的消费方接收）。
        // 口型仍由 setMouth 驱动，不受影响；未提供 onSpeakText 的消费方(屏保/holo)零影响。
        if (typeof data?.text === 'string' && data.text.trim()) {
          controllerRef.current?.onSpeakText?.(data.text);
        }
        console.log('[dj-intro] audio', { audio_url: data?.audio_url, url, paused: isPaused(), useNativeMusic });
        // 仍在播放（未暂停/未退出）才插播，避免迟到的口播打断已暂停的电台。
        if (url && !closed && !isPaused()) {
          if (useNativeMusic) {
            // 原生音乐在播：压低音乐音量，口播**也交给原生播**，播完恢复。
            // ★口播曾经走 player.speakClip（WebView <audio>），那条路在展示台那台 ROM 上
            // 放不出声，而且抢焦点会把音乐打成暂停——"听不到口播"和"音乐自己停住"
            // 都是它。现在声音走原生，嘴形用离线包络驱动（见 speakViaNative）。
            audioDuckNative();
            try {
              console.log('[dj-intro] play(native-speak) start');
              await player.speakViaNative(url, audioSpeakNative);
              console.log('[dj-intro] play(native-speak) end');
            } finally {
              audioSpeakStopNative();
              audioUnduckNative();
            }
          } else {
            console.log('[dj-intro] play(duckSpeak) start');
            await player.duckSpeak(url).catch((e) => console.log('[dj-intro] duckSpeak err', String(e)));
            console.log('[dj-intro] play(duckSpeak) end');
          }
        } else {
          console.log('[dj-intro] not played', { hasUrl: !!url, closed, paused: isPaused() });
        }
      } catch (e) {
        console.log('[dj-intro] error', String(e));
      } finally {
        speaking = false;
      }
    }

    // 一首新曲开始后记一拍；攒够随机阈值则触发一段串场口播。
    function tickSpeakCadence() {
      sinceSpeak += 1;
      if (sinceSpeak >= speakThreshold) {
        sinceSpeak = 0;
        speakThreshold = 3 + Math.floor(Math.random() * 3);
        requestSpeak('interlude');
      }
    }

    function enterIdle() {
      cur = null;
      player.stop();
      if (useNativeMusic) {
        stopMusicPoll();
        commuteStopNative();
        useNativeMusic = false;
      }
      setState((s) => ({ ...s, status: 'connected', playing: null, segment: null }));
      clearAdvance();
      advanceTimer = setTimeout(tickFromClock, IDLE_RECHECK_MS);
    }

    // 按当前时刻确定时段并起播（进入 / 待机恢复 / 跨时段时用）。
    function tickFromClock() {
      if (closed || !program) return;
      const dp = resolveCurrentDaypart(program, msSinceLocalMidnight(new Date()), { fallbackToNearest: true });
      if (!dp) {
        djTrace('resolveCurrentDaypart 落空(墙钟不在任何时段) -> idle');
        enterIdle();
        return;
      }
      startDaypart(dp);
    }

    function startDaypart(dp: Daypart) {
      if (!program) { djTrace('startDaypart 无 program'); return; }
      const { intro, tracks } = splitDaypart(dp);
      djTrace('startDaypart ' + dp.key + ' tracks=' + tracks.length);
      if (tracks.length === 0) {
        djTrace('startDaypart 该时段 0 首 -> idle');
        enterIdle();
        return;
      }
      cur = { daypartKey: dp.key, daypartName: dp.name, tracks, idx: 0 };

      // 起播一首：真机走原生前台 Service（整段歌单循环、锁屏续播+控制）；其余走 WebView JS 播放。
      const begin = (idx: number, posMs: number, withIntro: boolean) => {
        djTrace('begin idx=' + idx + ' pos=' + posMs + ' intro=' + withIntro
          + ' native=' + wantNativeMusic);
        if (wantNativeMusic) {
          startNativeMusic(idx, posMs, withIntro);
        } else {
          playTrackAt(idx, null, posMs);
          if (withIntro) requestSpeak('intro');
        }
      };

      // 智能续播：30min 内同(日期/模式/时段)退出 → 从原歌原进度精确续播（不放开场口播）。
      const resume = loadResume();
      if (
        resume &&
        resume.date === program.date &&
        resume.mode === mode &&
        resume.daypartKey === dp.key &&
        Date.now() - resume.leftAt <= RESUME_WINDOW_MS &&
        resume.idx < tracks.length
      ) {
        clearResume();
        cur.idx = resume.idx;
        begin(cur.idx, resume.positionMs, false);
        return;
      }
      clearResume();

      void intro; // 口播不再来自节目单（预生成已移除），改下方按需实时生成
      sinceSpeak = 0;
      speakThreshold = 3 + Math.floor(Math.random() * 3);
      const saved = loadDaypartProgress(program.date, mode, dp.key);
      if (saved == null) {
        // 当天该(模式,时段)首次打开：从第 0 首起播，并实时生成开场口播（音乐先响，口播好了再插播）
        cur.idx = 0;
        saveDaypartProgress(program.date, mode, dp.key, 0);
        begin(0, 0, true);
      } else {
        // 再次打开：从存的下一首续（越界回绕循环），不放开场口播
        cur.idx = saved % tracks.length;
        begin(cur.idx, 0, false);
      }
    }

    // 给当前曲打一条行为日志（喂后端按天聚合）。
    function logCurrent(action: DjFeedbackAction) {
      if (!curItem) return;
      postFeedback(base, {
        action,
        mode,
        daypart: cur?.daypartKey,
        ncm_id: curItem.ncm_id,
        title: curItem.title,
        artist: curItem.artist,
        position_ms: Math.round(useNativeMusic ? nativeMusicPositionMs : player.getMusicPositionMs()),
      });
    }

    // 相对推进/回退；reason 记录触发原因（finish 自然播完 / skip 切歌 / prev 上一首）。
    // wall-clock 已跨到别的时段则改切新时段（含智能续播判断）。
    function go(delta: number, reason: DjFeedbackAction) {
      if (closed || !program || !cur) return;
      const dp = resolveCurrentDaypart(program, msSinceLocalMidnight(new Date()), { fallbackToNearest: true });
      if (!dp) {
        enterIdle();
        return;
      }
      logCurrent(reason);
      if (dp.key !== cur.daypartKey) {
        startDaypart(dp);
        return;
      }
      const len = cur.tracks.length;
      const nextIdx = (((cur.idx + delta) % len) + len) % len;
      cur.idx = nextIdx;
      saveDaypartProgress(program.date, mode, dp.key, nextIdx);
      if (useNativeMusic) {
        commuteSeekIndexNative(nextIdx); // 原生跳到该首
        lastMusicIdx = nextIdx; // 避免轮询把这次手动切当成"自动切歌"再触发串场
        applyNativeIndex(nextIdx); // 立刻刷新 UI
      } else {
        playTrackAt(nextIdx, null);
      }
      tickSpeakCadence();
    }

    // 一首自然播完 → 下一首。
    function advanceTrack() {
      go(1, 'finish');
    }

    // ---- 通勤播客编排：低音量音乐床 + 双主播口播逐段顺播 ----
    const isCommute = mode === 'commute';
    let commuteSegs: CommuteSegment[] = [];
    let commuteIdx = 0;
    let commutePaused = false;
    let commuteToken = 0; // 每次(重)起播 +1；旧 speakClip 续播回调凭此失效，避免跳段时重复前进。

    // 原生前台 Service 播放（锁屏后台续播）：本期是否走原生 + index→段映射 + 位置轮询。
    // WebView 仅亮屏时轮询原生位置驱动卡片滚动；灭屏后 JS 冻结无妨，音频在原生侧继续。
    let useNativeCommute = false;
    let nativeSegs: CommuteSegment[] = [];
    let nativePollTimer: ReturnType<typeof setInterval> | null = null;
    let lastNativeIdx = -1;
    let lastNativePlaying = false;
    let nativePaused = false; // 本地暂停态（播放控制凭此切换，避免每次异步查询）
    let nativePollInFlight = false; // 防止上一次状态查询未回来又发起

    function playCommuteSegment() {
      if (closed || commutePaused || !isCommute) return;
      commuteToken += 1;
      const myToken = commuteToken;
      if (commuteIdx >= commuteSegs.length) {
        // 本期播完：保留音乐床，状态标记已播完。
        setState((s) => ({ ...s, segment: { segment_id: 'commute', title: '本期已播完' }, playing: null, speaker: null }));
        return;
      }
      const seg = commuteSegs[commuteIdx];
      const item: DjItem = {
        kind: 'tts',
        queue_item_id: seg.id,
        duration_ms: seg.duration_ms,
        audio_url: seg.audio_url,
        role: seg.speaker,
        text: seg.text,
      };
      curItem = item;
      setState((s) => ({
        ...s,
        status: 'connected',
        playing: item,
        queue: [],
        segment: { segment_id: 'commute', title: '通勤播客' },
        emotion: null,
        paused: false,
        feedback: null,
        speaker: seg.speaker,
        currentTopicId: seg.topicId ?? null, // 联动：当前讲到的话题卡片滚到正中
      }));
      const url = speakUrl(seg.audio_url);
      if (!url) {
        // 该段无音频（TTS 未配好）：按文字长度估时停留，让卡片仍能联动滚动走过。
        const dwell = Math.max(2600, seg.text.length * 170);
        advanceTimer = setTimeout(() => {
          if (closed || commutePaused || myToken !== commuteToken) return;
          commuteIdx += 1;
          playCommuteSegment();
        }, dwell);
        return;
      }
      // 直连播放（不经 AudioContext）：锁屏/切后台口播仍能像音乐床一样走完整集。
      player.speakClipDirect(url).then(() => {
        if (closed || commutePaused || myToken !== commuteToken) return;
        commuteIdx += 1;
        playCommuteSegment();
      });
    }

    function stopNativePoll() {
      if (nativePollTimer) {
        clearInterval(nativePollTimer);
        nativePollTimer = null;
      }
    }

    // 轮询原生播放状态，驱动话题卡片滚动 / 主播名 / 播完态。仅在亮屏(WebView 活)时跑；
    // 灭屏后该轮询随 WebView 冻结而停，但音频在原生 Service 继续——这正是锁屏续播的关键。
    function startNativePoll() {
      stopNativePoll();
      lastNativeIdx = -1;
      lastNativePlaying = false;
      const tick = async () => {
        if (closed || !useNativeCommute || nativePollInFlight) return;
        nativePollInFlight = true;
        let st;
        try {
          st = await commuteStateNative();
        } finally {
          nativePollInFlight = false;
        }
        if (closed || !useNativeCommute || !st) return;
        nativePaused = !st.playing;
        if (st.ended) {
          stopNativePoll();
          setState((s) => ({
            ...s,
            segment: { segment_id: 'commute', title: '本期已播完' },
            playing: null,
            speaker: null,
          }));
          return;
        }
        const idx = Math.min(nativeSegs.length - 1, Math.max(0, st.index));
        // 段号与播放态都没变 → 不触发 React 重渲染。
        if (idx === lastNativeIdx && st.playing === lastNativePlaying) return;
        lastNativeIdx = idx;
        lastNativePlaying = st.playing;
        commuteIdx = idx;
        const seg = nativeSegs[idx];
        if (!seg) return;
        const item: DjItem = {
          kind: 'tts',
          queue_item_id: seg.id,
          duration_ms: seg.duration_ms,
          audio_url: seg.audio_url,
          role: seg.speaker,
          text: seg.text,
        };
        curItem = item;
        setState((s) => ({
          ...s,
          status: 'connected',
          playing: item,
          queue: [],
          segment: { segment_id: 'commute', title: '通勤播客' },
          emotion: null,
          paused: !st.playing,
          feedback: null,
          speaker: seg.speaker,
          currentTopicId: seg.topicId ?? null,
        }));
      };
      tick();
      nativePollTimer = setInterval(tick, 600);
    }

    async function runCommute() {
      setState((s) => ({ ...s, status: 'connecting' }));
      try {
        const res = await fetch(`${base}/api/dj/commute/today`);
        if (closed) return;
        const data = await res.json();
        const segs: CommuteSegment[] = Array.isArray(data?.segments) ? data.segments : [];
        const topics: CommuteTopic[] = Array.isArray(data?.topics) ? data.topics : [];
        if (data?.status !== 'ready' || segs.length === 0) {
          // 尚未生成（07:00 预生成）：仍把已有话题卡片显示出来，置空闲并稍后重试。
          setState((s) => ({
            ...s,
            status: 'connected',
            playing: null,
            topics,
            currentTopicId: null,
            segment: { segment_id: 'commute', title: '通勤播客准备中…' },
          }));
          retryTimer = setTimeout(runCommute, RETRY_MS);
          return;
        }
        commuteSegs = segs;
        commuteIdx = 0;
        setState((s) => ({ ...s, topics })); // 先把卡片铺出来

        // 原生前台 Service 播放（锁屏后台续播）：把口播列表 + 床直链交给原生，WebView 只轮询位置。
        const playable = segs.filter((s) => !!speakUrl(s.audio_url));
        if (hasNativeCommute() && playable.length > 0) {
          const episodeId = String(data?.date || '');
          const voiceUrls = playable
            .map((s) => speakUrl(s.audio_url))
            .filter((u): u is string => !!u);
          let bedUrl = '';
          if (data.bed && data.bed.id) {
            bedUrl =
              streamUrl(base, {
                kind: 'track',
                queue_item_id: data.bed.id,
                ncm_id: data.bed.ncm_id,
                duration_ms: 0,
              }) || '';
          }
          // 幂等附着：App 切后台回来/重进 DJ 时原生仍在播同一期 → 接着当前段，不从头重播。
          const st = await commuteStateNative();
          if (closed) return;
          let ok = true;
          if (st && st.episodeId === episodeId && (st.active || st.ended)) {
            // 已在播该期：直接附着轮询。
          } else {
            ok = await commuteStartNative(episodeId, voiceUrls, 0, bedUrl);
          }
          if (closed) return;
          if (ok) {
            useNativeCommute = true;
            nativeSegs = playable;
            nativePaused = false;
            startNativePoll();
            return;
          }
          // 原生起播失败 → 落到下方 WebView JS 播放。
        }

        // —— 回落：无原生能力（旧包 / dev 浏览器）走 WebView 内 JS 串播 ——
        // 背景音乐床（低音量循环）；床存在 dj_queue_items，可走 /api/track/stream。
        if (data.bed && data.bed.id) {
          const bedUrl = streamUrl(base, {
            kind: 'track',
            queue_item_id: data.bed.id,
            ncm_id: data.bed.ncm_id,
            duration_ms: 0,
          });
          if (bedUrl) await player.playBed(bedUrl, 0.22);
          // holo 通勤：床已重路由，把频谱上抛给波形。
          setMusicAnalyser(player.getMusicAnalyser());
        }
        if (closed) return;
        playCommuteSegment();
      } catch {
        retryTimer = setTimeout(runCommute, RETRY_MS);
      }
    }

    function commutePlayPause() {
      if (useNativeCommute) {
        if (nativePaused) {
          commuteResumeNative();
          nativePaused = false;
          setState((s) => ({ ...s, paused: false }));
        } else {
          commutePauseNative();
          nativePaused = true;
          setState((s) => ({ ...s, paused: true }));
        }
        return;
      }
      if (commutePaused) {
        commutePaused = false;
        player.resume().catch(() => {});
        setState((s) => ({ ...s, paused: false }));
        playCommuteSegment(); // 从当前段续播
      } else {
        commutePaused = true;
        player.pauseAll();
        setState((s) => ({ ...s, paused: true }));
      }
    }

    // 深挖：用户就某话题提问 → 抬升音乐填空 → 即时生成插播口播 → 调回床音量插播 → 恢复常规口播。
    async function commuteDig(topic: string): Promise<boolean> {
      if (closed || !isCommute) return false;
      const t = String(topic || '').trim();
      if (t.length < 2) return false;

      // 原生播放：深挖只在亮屏可用——暂停原生口播，WebView 内播插播，完后恢复原生。
      if (useNativeCommute) {
        commutePauseNative();
        setState((s) => ({ ...s, segment: { segment_id: 'commute', title: '正在深挖这个话题…' } }));
        try {
          const res = await fetch(`${base}/api/dj/commute/dig`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ topic: t }),
          });
          if (closed) return false;
          if (!res.ok) {
            commuteResumeNative();
            return false;
          }
          const data = await res.json();
          const url = speakUrl(data?.audio_url);
          if (url && !closed) {
            setState((s) => ({
              ...s,
              speaker: data.speaker ?? null,
              playing: {
                kind: 'tts',
                queue_item_id: 'dig',
                duration_ms: data.duration_ms ?? 0,
                audio_url: data.audio_url,
                role: data.speaker,
                text: data.text,
              },
              segment: { segment_id: 'commute', title: '深挖插播' },
            }));
            await player.speakClipDirect(url);
          }
          commuteResumeNative();
          return true;
        } catch {
          commuteResumeNative();
          return false;
        }
      }

      commuteToken += 1; // 失效当前段的续播回调
      const myToken = commuteToken;
      const savedIdx = commuteIdx;
      commutePaused = true; // 暂停常规口播推进（生成期间）
      player.setMusicVolume(0.5); // 抬升音乐填空
      setState((s) => ({ ...s, segment: { segment_id: 'commute', title: '正在深挖这个话题…' } }));

      const resume = () => {
        if (closed || myToken !== commuteToken) return;
        commutePaused = false;
        commuteIdx = savedIdx;
        playCommuteSegment();
      };

      try {
        const res = await fetch(`${base}/api/dj/commute/dig`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ topic: t }),
        });
        player.setMusicVolume(0.22); // 调回床音量
        if (closed) return false;
        if (!res.ok) {
          resume();
          return false;
        }
        const data = await res.json();
        const url = speakUrl(data?.audio_url);
        if (url && !closed && myToken === commuteToken) {
          setState((s) => ({
            ...s,
            speaker: data.speaker ?? null,
            playing: {
              kind: 'tts',
              queue_item_id: 'dig',
              duration_ms: data.duration_ms ?? 0,
              audio_url: data.audio_url,
              role: data.speaker,
              text: data.text,
            },
            segment: { segment_id: 'commute', title: '深挖插播' },
          }));
          await player.speakClipDirect(url);
        }
        resume();
        return true;
      } catch {
        player.setMusicVolume(0.22);
        resume();
        return false;
      }
    }

    // ---- 用户控制 ----
    function playPause() {
      // 原生音乐路径：播放/暂停交给原生 Service（锁屏控制也走它）。
      if (useNativeMusic) {
        if (musicPaused) {
          commuteResumeNative();
          musicPaused = false;
          setState((s) => ({ ...s, paused: false }));
          updateMediaSession(curItem, false);
        } else {
          commutePauseNative();
          musicPaused = true;
          setState((s) => ({ ...s, paused: true }));
          updateMediaSession(curItem, true);
        }
        return;
      }
      if (player.isMusicPaused()) {
        player.resume().catch(() => {});
        setState((s) => ({ ...s, paused: false }));
        updateMediaSession(curItem, false);
        clearAdvance();
        const remaining = Math.max(1000, (curItem?.duration_ms || 0) - player.getMusicPositionMs());
        advanceTimer = setTimeout(advanceTrack, remaining + 1500);
      } else {
        player.pauseAll();
        clearAdvance();
        setState((s) => ({ ...s, paused: true }));
        updateMediaSession(curItem, true);
      }
    }

    function setFeedback(kind: 'like' | 'dislike') {
      logCurrent(kind);
      setState((s) => ({ ...s, feedback: kind }));
    }

    function applyProgram(data: unknown): boolean {
      const d = data as DayProgram & { dayparts?: unknown[] };
      return !!d && Array.isArray(d.dayparts) && d.dayparts.length > 0;
    }

    const programUrl = `${base}/api/program/today?mode=${encodeURIComponent(mode)}`;

    async function loadProgram() {
      try {
        setState((s) => ({ ...s, status: 'connecting' }));
        const res = await fetch(programUrl);
        if (closed) return;
        if (!res.ok) {
          scheduleRetry();
          return;
        }
        const data = await res.json();
        if (closed) return;
        if (applyProgram(data)) {
          program = data as DayProgram;
          tickFromClock();
        } else {
          // generating / empty / no_active_dj：待机，稍后重试（等服务端生成）
          program = null;
          setState((s) => ({ ...s, status: 'connected', playing: null, segment: null }));
          scheduleRetry();
        }
      } catch {
        scheduleRetry();
      }
    }

    function scheduleRetry() {
      if (closed) return;
      if (retryTimer) clearTimeout(retryTimer);
      retryTimer = setTimeout(loadProgram, RETRY_MS);
    }

    // 静默刷新：拾取重生成/新一天的节目单，不打断当前播放（下次 advance 自然用新数据）。
    async function refreshSilently() {
      try {
        const res = await fetch(programUrl);
        if (closed || !res.ok) return;
        const data = await res.json();
        if (!closed && applyProgram(data)) program = data as DayProgram;
      } catch {
        /* ignore */
      }
    }

    // 自动播放解锁：首次用户手势恢复被拦截的 AudioContext/audio
    function unlockAudio() {
      player.resume().catch(() => {});
    }
    window.addEventListener('pointerdown', unlockAudio, { once: true });
    window.addEventListener('keydown', unlockAudio, { once: true });

    // 暴露控制实现给 hook 的稳定包装。
    implRef.current = {
      setVolume: (v: number) => player.setUserVolume(v),
      getVolume: () => player.getUserVolume(),
      playPause: isCommute ? commutePlayPause : playPause,
      // 通勤：next/prev 跳到上/下一段口播；其它模式切歌。
      next: isCommute
        ? () => {
            if (useNativeCommute) {
              commuteSeekIndexNative(Math.min(nativeSegs.length - 1, commuteIdx + 1));
              return;
            }
            commuteIdx = Math.min(commuteSegs.length, commuteIdx + 1);
            playCommuteSegment();
          }
        : () => go(1, 'skip'),
      prev: isCommute
        ? () => {
            if (useNativeCommute) {
              commuteSeekIndexNative(Math.max(0, commuteIdx - 1));
              return;
            }
            commuteIdx = Math.max(0, commuteIdx - 1);
            playCommuteSegment();
          }
        : () => go(-1, 'prev'),
      like: () => setFeedback('like'),
      dislike: () => setFeedback('dislike'),
      getPositionMs: () => (useNativeMusic ? nativeMusicPositionMs : player.getMusicPositionMs()),
      getDurationMs: () =>
        useNativeMusic ? curItem?.duration_ms || 0 : player.getMusicDurationMs() || curItem?.duration_ms || 0,
      dig: isCommute ? commuteDig : () => Promise.resolve(false),
    };

    // 蓝牙耳机/系统媒体键 → 切歌/播放暂停。
    const nav = navigator as Navigator & { mediaSession?: MediaSession };
    if (nav.mediaSession) {
      try {
        nav.mediaSession.setActionHandler('play', () => playPause());
        nav.mediaSession.setActionHandler('pause', () => playPause());
        nav.mediaSession.setActionHandler('nexttrack', () => go(1, 'skip'));
        nav.mediaSession.setActionHandler('previoustrack', () => go(-1, 'prev'));
      } catch {
        /* 部分 WebView 不支持某些动作：忽略 */
      }
    }

    // 进场：记一条「这个时段进入电台」行为日志（时段画像用）。
    postFeedback(base, { action: 'enter', mode });

    if (isCommute) {
      // 通勤播客：不走时段音乐节目单，改放双主播口播 + 音乐床。
      runCommute();
    } else {
      // 切到非通勤模式：停掉可能残留的原生通勤 Service（否则它会一直后台播）。
      if (hasNativeCommute()) commuteStopNative();
      refreshTimer = setInterval(refreshSilently, PROGRAM_REFRESH_MS);
      loadProgram();
    }

    return () => {
      closed = true;
      clearAdvance();
      stopNativePoll();
      stopMusicPoll();
      // 退出 DJ / 切模式时停掉原生 Service（通勤口播或 DJ 音乐）。锁屏不会触发本清理——主 App
      // React 不卸载，故灭屏仍续播；只有真正退出/切模式才停。
      if (useNativeCommute || useNativeMusic) commuteStopNative();
      if (retryTimer) clearTimeout(retryTimer);
      if (refreshTimer) clearInterval(refreshTimer);
      window.removeEventListener('pointerdown', unlockAudio);
      window.removeEventListener('keydown', unlockAudio);
      // 退出存续播快照（再进 30min 内同时段精确续播）。
      if (program && cur) {
        saveResume({
          date: program.date,
          mode,
          daypartKey: cur.daypartKey,
          idx: cur.idx,
          positionMs: Math.round(useNativeMusic ? nativeMusicPositionMs : player.getMusicPositionMs()),
          leftAt: Date.now(),
        });
      }
      implRef.current = null;
      if (nav.mediaSession) {
        try {
          nav.mediaSession.setActionHandler('play', null);
          nav.mediaSession.setActionHandler('pause', null);
          nav.mediaSession.setActionHandler('nexttrack', null);
          nav.mediaSession.setActionHandler('previoustrack', null);
        } catch {
          /* ignore */
        }
      }
      player.dispose();
      setMusicAnalyser(null); // ctx 已关，analyser 失效，消费侧回落 idle 波形
    };
  }, [enabled, mode]);

  return { ...state, controls, musicAnalyser };
}
