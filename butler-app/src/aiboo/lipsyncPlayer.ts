// 来源:Aiboo origin/main 7c55ce12 src/lib/tts.ts —— 裁剪版:只留 playAudioElement / stopSpeaking 这条
// 「<audio> 接 AnalyserNode,逐帧驱动口型」的已验证路径。原文件的合成(Qwen/火山/浏览器 TTS)、
// 设置存储、voiceChannel 抢占、全局 ttsState 广播都不要——合成在本机后端,这里只放音频。
import { analyzeAudioLevel, createTalkingMouth } from '../live2d/mouthSync.ts';

let activeAudio: HTMLAudioElement | null = null;
let activeObjectUrl: string | null = null;
let activeAnimationFrame = 0;
let activeAudioContext: AudioContext | null = null;
let activeOnMouthChange: ((value: number) => void) | null = null;
let activeOnEnded: (() => void) | null = null;
/** 每次播放一个代号;迟到的旧回调(src='' 触发的 onerror 等)按它判定,不误清新会话。 */
let playToken = 0;

export function isSpeaking(): boolean {
  return activeAudio !== null;
}

export function stopSpeaking(): void {
  playToken += 1;
  if (activeAnimationFrame) {
    cancelAnimationFrame(activeAnimationFrame);
    activeAnimationFrame = 0;
  }
  if (activeAudio) {
    activeAudio.pause();
    activeAudio.src = '';
    activeAudio = null;
  }
  if (activeObjectUrl) {
    URL.revokeObjectURL(activeObjectUrl);
    activeObjectUrl = null;
  }
  if (activeAudioContext) {
    void activeAudioContext.close();
    activeAudioContext = null;
  }
  if (activeOnMouthChange) {
    activeOnMouthChange(0);
    activeOnMouthChange = null;
  }
  if (activeOnEnded) {
    const onEnded = activeOnEnded;
    activeOnEnded = null;
    onEnded();
  }
}

function stopMouthLoop(onMouthChange: (value: number) => void, token: number) {
  if (token !== playToken) return;
  if (activeAnimationFrame) {
    cancelAnimationFrame(activeAnimationFrame);
    activeAnimationFrame = 0;
  }
  onMouthChange(0);
  activeOnMouthChange = null;
}

function playAudioElement(
  audio: HTMLAudioElement,
  onMouthChange: (value: number) => void,
  options: { objectUrl?: string | null; onEnded?: () => void } = {},
): Promise<void> {
  return new Promise((resolve, reject) => {
    // 抢占:先停掉正在放的(它会把旧状态清干净),再登记新的。
    stopSpeaking();
    const token = playToken;
    activeOnMouthChange = onMouthChange;
    activeObjectUrl = options.objectUrl ?? null;
    activeAudio = audio;
    activeOnEnded = options.onEnded ?? null;

    let analyser: AnalyserNode | null = null;
    try {
      activeAudioContext = new AudioContext();
      analyser = activeAudioContext.createAnalyser();
      analyser.fftSize = 512;
      const source = activeAudioContext.createMediaElementSource(audio);
      source.connect(analyser);
      analyser.connect(activeAudioContext.destination);
    } catch {
      // 没有 Web Audio(极老 WebView):照样出声,只是没口型。
      analyser = null;
    }

    const samples = analyser === null ? null : new Uint8Array(analyser.frequencyBinCount);
    const mouth = createTalkingMouth({ gateNorm: 0.45 });

    function tick() {
      if (analyser !== null && samples !== null) {
        analyser.getByteFrequencyData(samples);
        const rawLevel = analyzeAudioLevel(samples, { bandStart: 1, bandEnd: 22, threshold: 0.05, divisor: 260 });
        onMouthChange(mouth(rawLevel));
      }
      activeAnimationFrame = requestAnimationFrame(tick);
    }

    const finish = () => {
      stopMouthLoop(onMouthChange, token);
      if (token !== playToken) return;
      const onEnded = activeOnEnded;
      activeOnEnded = null;
      activeAudio = null;
      if (activeObjectUrl) { URL.revokeObjectURL(activeObjectUrl); activeObjectUrl = null; }
      onEnded?.();
    };

    audio.onplay = () => {
      if (token !== playToken) return;
      activeAnimationFrame = requestAnimationFrame(tick);
    };
    audio.onended = () => { finish(); resolve(); };
    audio.onerror = () => {
      if (token !== playToken) return;
      finish();
      reject(new Error('音频播放失败'));
    };

    const start = () => audio.play().catch((e: unknown) => { finish(); reject(e); });
    if (activeAudioContext) {
      void activeAudioContext.resume().then(start).catch(start);
    } else {
      void start();
    }
  });
}

/** 播一段合成好的音频,逐帧把口型值喂给 onMouthChange(0~1)。 */
export function playAudioBlob(blob: Blob, onMouthChange: (value: number) => void, onEnded?: () => void): Promise<void> {
  const objectUrl = URL.createObjectURL(blob);
  return playAudioElement(new Audio(objectUrl), onMouthChange, { objectUrl, ...(onEnded === undefined ? {} : { onEnded }) });
}
