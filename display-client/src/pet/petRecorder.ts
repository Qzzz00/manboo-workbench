// 底条录音：WebAudio 采集 → 16k 单声道 Int16 PCM → base64。
//
// ★这条路已经在**同一个 WebView** 里被通话功能跑通过：OverlayWindow 的
// WebChromeClient.onPermissionRequest 已放行 RESOURCE_AUDIO_CAPTURE，
// 且 pet.localhost 被 Chromium 判为安全上下文（getUserMedia 的前提）。
// ★RECORD_AUDIO 运行时权限必须已经授予 —— overlay Service 没有 Activity 上下文，
// 弹不了权限窗，所以由主 App 设置页先要一次（StrategistPlugin.requestMicPermission）。
//
// 用 ScriptProcessorNode 而不是 AudioWorklet：掌机是 Chrome 99，两者都支持，但
// AudioWorklet 要单独一个模块文件走 addModule()，在 pet.html 这种单入口打包里徒增
// 构建复杂度；录音是短促的 push-to-talk，性能不是瓶颈。

import { floatToInt16, int16ToBase64, resampleTo16k } from '../lib/strategist/pcm.ts';

const TARGET_RATE = 16000;
const BUFFER_SIZE = 4096;
/** 硬上限，防手指卡住导致无限录（服务端也挡，两边都要有）。 */
const MAX_MS = 60_000;

export type RecordedPcm = { pcmBase64: string; sampleRate: number };

export type Recorder = {
  start(): Promise<void>;
  /** 停止并返回 PCM。没录到东西时 pcmBase64 是空串，调用方据此提示「没听到」。 */
  stop(): Promise<RecordedPcm>;
};

export function createRecorder(): Recorder {
  let ctx: AudioContext | null = null;
  let stream: MediaStream | null = null;
  let node: ScriptProcessorNode | null = null;
  let chunks: Float32Array[] = [];
  let startedAt = 0;

  async function start(): Promise<void> {
    chunks = [];
    startedAt = Date.now();
    stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    // 请求 16k 让浏览器自己重采样；不认这个参数时 pcm.resampleTo16k 兜底。
    const Ctor =
      window.AudioContext ??
      (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    ctx = new Ctor({ sampleRate: TARGET_RATE });
    const src = ctx.createMediaStreamSource(stream);
    node = ctx.createScriptProcessor(BUFFER_SIZE, 1, 1);
    node.onaudioprocess = (e) => {
      if (Date.now() - startedAt > MAX_MS) return;
      // 必须 copy：事件里那块 buffer 会被下一帧复用，直接 push 会拿到一堆同一段音频。
      chunks.push(new Float32Array(e.inputBuffer.getChannelData(0)));
    };
    src.connect(node);
    // ScriptProcessorNode 不接到 destination 就不会被泵；接一个零增益节点，
    // 既让它跑起来又不会把麦克风回放出来（那会直接啸叫）。
    const mute = ctx.createGain();
    mute.gain.value = 0;
    node.connect(mute);
    mute.connect(ctx.destination);
  }

  async function stop(): Promise<RecordedPcm> {
    const rate = ctx?.sampleRate ?? TARGET_RATE;
    try {
      node?.disconnect();
      stream?.getTracks().forEach((t) => t.stop());
      await ctx?.close();
    } catch {
      /* 清理失败不该让整段录音作废 */
    }
    node = null;
    stream = null;
    ctx = null;

    const total = chunks.reduce((n, c) => n + c.length, 0);
    if (total === 0) return { pcmBase64: '', sampleRate: TARGET_RATE };
    const merged = new Float32Array(total);
    let off = 0;
    for (const c of chunks) {
      merged.set(c, off);
      off += c.length;
    }
    chunks = [];
    const resampled = resampleTo16k(merged, rate);
    return { pcmBase64: int16ToBase64(floatToInt16(resampled)), sampleRate: TARGET_RATE };
  }

  return { start, stop };
}
