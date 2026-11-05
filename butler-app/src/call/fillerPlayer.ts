/**
 * 缓冲语的**播放器**:把 `public/filler/` 里那几句 m4a 放出来(2026-09-20)。
 *
 * 和 call/fillerAudio.ts 分开的理由很实在:那一份是**纯的**(本机那台假手机直接 import 它,
 * 在真的 LiveKit 房间里量时序),而这一份非碰 `<audio>` 不可。搅在一个文件里,
 * 假手机就得连 DOM 一起假装。
 */
import { fillerAssetUrl, type FillerLine, type FillerTimerHandle } from './fillerAudio';

function defaultTimer(fn: () => void, ms: number): FillerTimerHandle {
  const handle = setTimeout(fn, ms);
  return { cancel: () => clearTimeout(handle) };
}

/** 掐掉时淡出多久。60ms:掐得听不出接缝,又赶在她的真声之前结束
 *  —— 她那条字幕比声音早 56–130ms(交接-0920 第三节 E),这 60ms 正好藏在那个空隙里。 */
export const FILLER_FADE_MS = 60;

export interface HtmlFillerPlayerDeps {
  /** 造一个 `<audio>`。测试注入假的(jsdom 里 HTMLMediaElement.play 是没实现的)。 */
  makeAudio?: (url: string) => HTMLAudioElement;
  /**
   * 这一句的地址(2026-09-22)。缺省是包里那一份;接上运行期缓存之后它回的是
   * 「按当前音色合成好的那一份」的 blob 地址(call/fillerVoiceCache.ts)。
   *
   * 每次要放都问一遍,而不是进房时一次性算好:音色对齐是**异步**的,
   * 第一句可能在它对齐之前就要放了 —— 那时给包里那一份是对的,之后自动就是新的。
   */
  resolveUrl?: (id: string) => string;
  fadeMs?: number;
  /** 淡出那几步的节拍器。测试注入。 */
  setTimer?: (fn: () => void, ms: number) => FillerTimerHandle;
}

export interface HtmlFillerPlayer {
  play: (line: FillerLine) => Promise<void>;
  stop: () => void;
  /** 挂断时把 `<audio>` 都放掉。 */
  dispose: () => void;
}

/**
 * 包里那几句的播放器。
 *
 * 三件事值得写下来:
 *   - **进房那一下就把七个 `<audio>` 建好**(`preload='auto'`):它们加起来 66KB,
 *     而「到点那一刻现去读文件」会把 700ms 变成 700ms + 一次磁盘/解码。
 *   - **用普通的 `<audio>`**,不接 WebAudio:Android 上它走的是媒体音量那一路 ——
 *     他把系统音量关小,这几句就跟着小,**这是对的**。麦克风那颗静音键管的是上行,和它无关。
 *   - **掐的时候淡出 {@link FILLER_FADE_MS}**,不是啪一下停:硬切会「咔」一声,
 *     而那一声正好落在她开口之前,听起来像出了故障。
 */
export function createHtmlFillerPlayer(deps: HtmlFillerPlayerDeps = {}): HtmlFillerPlayer {
  const resolveUrl = deps.resolveUrl ?? fillerAssetUrl;
  const makeAudio = deps.makeAudio ?? ((url: string) => {
    const audio = new Audio(url);
    audio.preload = 'auto';
    return audio;
  });
  const fadeMs = deps.fadeMs ?? FILLER_FADE_MS;
  const setTimer = deps.setTimer ?? defaultTimer;
  const pool = new Map<string, HTMLAudioElement>();
  /** 池子里那一个是按哪个地址建的。地址变了(换音色)就得换一个,不能接着用旧嗓子。 */
  const madeFrom = new Map<string, string>();
  let current: HTMLAudioElement | null = null;
  let fade: FillerTimerHandle | undefined;

  /**
   * 这一句的 `<audio>`。**地址变了就换一个**(换了音色之后 resolveUrl 回的是新的那一份)——
   * 池子里留着旧嗓子那一个,等于换完音色第一通电话还是旧声音。
   */
  function audioFor(id: string): HTMLAudioElement {
    const url = resolveUrl(id);
    const existing = pool.get(id);
    if (existing !== undefined && madeFrom.get(id) === url) return existing;
    if (existing !== undefined) { try { existing.pause(); existing.src = ''; } catch { /* 拆的时候什么都可能抛 */ } }
    const created = makeAudio(url);
    pool.set(id, created);
    madeFrom.set(id, url);
    return created;
  }

  function clearFade(): void {
    fade?.cancel();
    fade = undefined;
  }

  return {
    async play(line) {
      clearFade();
      if (current !== null) { try { current.pause(); } catch { /* 上一句已经停了 */ } }
      const audio = audioFor(line.id);
      current = audio;
      try { audio.currentTime = 0; } catch { /* 还没 loadedmetadata:从头开始本来就是默认 */ }
      audio.volume = 1;
      await new Promise<void>((resolve, reject) => {
        const done = () => { audio.onended = null; audio.onerror = null; resolve(); };
        audio.onended = done;
        audio.onerror = () => { audio.onended = null; audio.onerror = null; reject(new Error('缓冲语放不出来')); };
        const started = audio.play();
        // 老 WebView 的 play() 不回 promise;回了的话自动播放被拦会走到这里。
        if (started !== undefined && typeof started.catch === 'function') {
          void started.catch((error: unknown) => { audio.onended = null; audio.onerror = null; reject(error); });
        }
      });
      if (current === audio) current = null;
    },

    stop() {
      clearFade();
      const audio = current;
      if (audio === null) return;
      current = null;
      // 淡出:每 ~15ms 降一档,降完暂停。中途被新的一句抢走(clearFade)就不再管它。
      const steps = Math.max(1, Math.round(fadeMs / 15));
      let left = steps;
      const step = (): void => {
        left -= 1;
        try { audio.volume = Math.max(0, left / steps); } catch { /* volume 设不了就直接停 */ }
        if (left <= 0) {
          try { audio.pause(); audio.volume = 1; } catch { /* 拆的时候什么都可能抛 */ }
          fade = undefined;
          return;
        }
        fade = setTimer(step, Math.round(fadeMs / steps));
      };
      fade = setTimer(step, Math.round(fadeMs / steps));
    },

    dispose() {
      clearFade();
      if (current !== null) { try { current.pause(); } catch { /* 同上 */ } }
      current = null;
      for (const audio of pool.values()) {
        try { audio.pause(); audio.src = ''; } catch { /* 同上 */ }
      }
      pool.clear();
      madeFrom.clear();
    },
  };
}
