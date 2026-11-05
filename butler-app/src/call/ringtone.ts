/**
 * 铃声(2026-09-21)。`public/ring/ringtone.m4a` 循环放。
 *
 * **那段音频是 ffmpeg 现合成的正弦波,不是任何现成录音**(来源与参数在
 * `public/ring/manifest.json`,生成脚本 `scripts/render-ringtone.mjs`)——
 * 所以它没有版权可讲,也不用去找一段「免费」铃声再查一遍授权。
 *
 * 和缓冲语那一套(fillerPlayer.ts)分成两个文件、两条路:
 *   - 缓冲语是**七个**短音、要洗牌、要淡出,铃声只有一段、循环、说停就停;
 *   - 缓冲语走 `<audio>` 的媒体音量是**对的**(她说话的音量);铃声也走同一路
 *     —— 他把系统音量关小,铃声就该跟着小。真要「静音也响」那是原生插件的事
 *     (STREAM_RING),不是网页这一层能决定的,做不到的写在 deskPhone.ts 里。
 *
 * 和 fillerPlayer 同一条纪律:**`<audio>` 在进这一屏时就建好**(`preload='auto'`),
 * 不在响的那一刻现去读文件 —— 铃声迟半秒出来,座机就不像座机了。
 */

/** 音频在包里的位置。与 scripts/render-ringtone.mjs 的输出**逐字相同**。 */
export const RINGTONE_URL = 'ring/ringtone.m4a';

export interface Ringtone {
  /** 开始响(循环)。放不出来**不抛** —— 震动与界面那两半照样在。 */
  start: () => Promise<{ ok: boolean; error?: string }>;
  stop: () => void;
  dispose: () => void;
}

export interface RingtoneDeps {
  /** 造那个 `<audio>`。测试注入假的(jsdom 里 HTMLMediaElement.play 没实现)。 */
  makeAudio?: (url: string) => HTMLAudioElement;
}

export function createRingtone(deps: RingtoneDeps = {}): Ringtone {
  const makeAudio = deps.makeAudio ?? ((url: string) => {
    const audio = new Audio(url);
    audio.preload = 'auto';
    audio.loop = true;
    return audio;
  });
  let audio: HTMLAudioElement | null = null;

  function ensure(): HTMLAudioElement {
    if (audio === null) {
      audio = makeAudio(RINGTONE_URL);
      audio.loop = true;
    }
    return audio;
  }

  return {
    async start() {
      const element = ensure();
      try { element.currentTime = 0; }
      catch { /* 还没 loadedmetadata:从头开始本来就是默认 */ }
      try {
        const started = element.play();
        if (started !== undefined && typeof started.then === 'function') await started;
        return { ok: true };
      } catch (error) {
        /**
         * 自动播放被拦(WebView 要求先有一次用户手势)是**最可能**的失败。
         * 这不该把来电弄没:震动、全屏来电页、原生那条通知照样在。如实回一句就够了。
         */
        return { ok: false, error: error instanceof Error && error.message !== '' ? error.message : '铃声放不出来' };
      }
    },

    stop() {
      if (audio === null) return;
      try { audio.pause(); audio.currentTime = 0; }
      catch { /* 拆的时候什么都可能抛 */ }
    },

    dispose() {
      if (audio === null) return;
      try { audio.pause(); audio.src = ''; }
      catch { /* 同上 */ }
      audio = null;
    },
  };
}
