// 来源:Aiboo origin/main 7c55ce12 src/hooks/useVoiceRecorder.ts —— 原样,只改了 pickRecorderMimeType 的 import 路径。
//
// 2026-09-24(卡 feat/phone-composer-call-slot)改了三处,其余一行没动(改动处都标了日期):
//   1. **起录那段空档**:getUserMedia 要几十到几百毫秒,头一次还要弹权限框。以前这段时间里松手 / 取消,
//      停不下来(还没有 MediaRecorder),等 getUserMedia 回来照样开录 —— 手已经松了,浮层却一直挂着,
//      一直录到 20 秒上限。首页的麦克风键改成「一按下就录」之后,快点一下就会撞上这一条。
//      现在每次起录编一个号,取消就作废这一号;作废的那一路回来的流当场关掉。
//   2. 取消后 300ms 回 idle 那一下,只在还是「已取消」时才回,别把紧接着的下一次起录冲掉。
//   3. 麦克风权限被拒**每次**都说一句(以前第二次起静默回 idle:按了没反应,也不说为什么),措辞换成 App 的(不是「浏览器设置」)。
import { useCallback, useEffect, useRef, useState } from 'react';
import { pickRecorderMimeType } from './recorderMime';

const MAX_DURATION_MS = 20000;
const ASR_SAMPLE_RATE = 16000;

/** 录音权限被拒时那句话(2026-09-24:原来是「请在浏览器设置中开启」,手机 App 里没有浏览器设置)。 */
export const MIC_PERMISSION_TEXT = '没有录音权限:到手机设置里给这个 App 打开麦克风,再按住说';

/** 把多段 Float32 PCM 合并并线性降采样到 16k 单声道 Int16，封成 WAV Blob。 */
function buildWavBlob(chunks: Float32Array[], srcRate: number): Blob {
  let total = 0;
  for (const c of chunks) total += c.length;
  const merged = new Float32Array(total);
  let o = 0;
  for (const c of chunks) { merged.set(c, o); o += c.length; }

  const ratio = srcRate / ASR_SAMPLE_RATE;
  const outLen = Math.floor(merged.length / ratio);
  const pcm = new Int16Array(outLen);
  for (let i = 0; i < outLen; i++) {
    const s = Math.max(-1, Math.min(1, merged[Math.floor(i * ratio)]));
    pcm[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
  }

  const buffer = new ArrayBuffer(44 + pcm.length * 2);
  const view = new DataView(buffer);
  const writeStr = (off: number, str: string) => { for (let i = 0; i < str.length; i++) view.setUint8(off + i, str.charCodeAt(i)); };
  writeStr(0, 'RIFF');
  view.setUint32(4, 36 + pcm.length * 2, true);
  writeStr(8, 'WAVE');
  writeStr(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, ASR_SAMPLE_RATE, true);
  view.setUint32(28, ASR_SAMPLE_RATE * 2, true); // byteRate
  view.setUint16(32, 2, true); // blockAlign
  view.setUint16(34, 16, true); // bitsPerSample
  writeStr(36, 'data');
  view.setUint32(40, pcm.length * 2, true);
  for (let i = 0; i < pcm.length; i++) view.setInt16(44 + i * 2, pcm[i], true);
  return new Blob([buffer], { type: 'audio/wav' });
}

export type RecorderState =
  | { status: 'idle' }
  | { status: 'requesting' }
  | { status: 'recording'; elapsedMs: number }
  | { status: 'cancelled' }
  | { status: 'error'; message: string };

export function useVoiceRecorder() {
  const [state, setState] = useState<RecorderState>({ status: 'idle' });
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const startTimeRef = useRef<number>(0);
  const cancelledRef = useRef(false);
  // 每次起录编一个号;取消 / 再起一次就作废前一号(2026-09-24,见文件头第 1 条)。
  const startSeqRef = useRef(0);
  // 实时音量(0~1)，用 ref 暴露给 UI 轮询，避免高频 setState 影响其它使用方。
  const audioLevelRef = useRef(0);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const rafRef = useRef<number | null>(null);
  // 原始 PCM 采集(用于 ASR：降采样到 16k 出 WAV)
  const pcmChunksRef = useRef<Float32Array[]>([]);
  const srcRateRef = useRef<number>(48000);
  const processorRef = useRef<ScriptProcessorNode | null>(null);

  const stopMeter = useCallback(() => {
    if (rafRef.current != null) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
    if (processorRef.current) {
      try { processorRef.current.onaudioprocess = null; processorRef.current.disconnect(); } catch { /* ignore */ }
      processorRef.current = null;
    }
    if (audioCtxRef.current) {
      try { audioCtxRef.current.close(); } catch { /* ignore */ }
      audioCtxRef.current = null;
    }
    audioLevelRef.current = 0;
  }, []);

  const startMeter = useCallback((stream: MediaStream) => {
    try {
      const Ctx = window.AudioContext || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!Ctx) return;
      const ctx = new Ctx();
      audioCtxRef.current = ctx;
      srcRateRef.current = ctx.sampleRate;
      const source = ctx.createMediaStreamSource(stream);

      // 音量分析(驱动声波)
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 512;
      source.connect(analyser);
      const buf = new Uint8Array(analyser.frequencyBinCount);
      const tick = () => {
        analyser.getByteTimeDomainData(buf);
        let sum = 0;
        for (let i = 0; i < buf.length; i++) {
          const v = (buf[i] - 128) / 128;
          sum += v * v;
        }
        const rms = Math.sqrt(sum / buf.length);
        audioLevelRef.current = Math.min(1, rms * 3);
        rafRef.current = requestAnimationFrame(tick);
      };
      rafRef.current = requestAnimationFrame(tick);

      // 原始 PCM 采集(供 ASR)：不写 output → 静音无回授
      const processor = ctx.createScriptProcessor(4096, 1, 1);
      processorRef.current = processor;
      processor.onaudioprocess = (e) => {
        const input = e.inputBuffer.getChannelData(0);
        pcmChunksRef.current.push(new Float32Array(input));
      };
      source.connect(processor);
      processor.connect(ctx.destination);
    } catch { /* 音频分析失败不影响录音 */ }
  }, []);

  const stopTimer = useCallback(() => {
    if (timerRef.current) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  const cleanup = useCallback(() => {
    stopTimer();
    stopMeter();
    const recorder = mediaRecorderRef.current;
    if (recorder && recorder.state !== 'inactive') {
      try {
        recorder.stop();
      } catch { /* ignore */ }
    }
    mediaRecorderRef.current = null;
    chunksRef.current = [];
  }, [stopTimer, stopMeter]);

  const startRecording = useCallback(async () => {
    if (state.status === 'recording' || state.status === 'requesting') return;
    cancelledRef.current = false;
    const seq = ++startSeqRef.current;

    setState({ status: 'requesting' });

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      // 2026-09-24:等麦克风的这段时间里已经松手 / 取消 / 又起了一次 —— 这一路作废,流当场关掉(不然麦克风一直开着)。
      if (seq !== startSeqRef.current || cancelledRef.current) {
        stream.getTracks().forEach((t) => t.stop());
        return;
      }
      const mimeType = pickRecorderMimeType();

      const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
      mediaRecorderRef.current = recorder;
      chunksRef.current = [];
      pcmChunksRef.current = [];

      recorder.ondataavailable = (event) => {
        if (event.data.size > 0) chunksRef.current.push(event.data);
      };

      recorder.onstop = () => {
        stream.getTracks().forEach((t) => t.stop());
        stopMeter();
        if (cancelledRef.current) {
          setState({ status: 'cancelled' });
          return;
        }
        // Blob will be picked up by stopRecording caller via ref
      };

      recorder.onerror = () => {
        stream.getTracks().forEach((t) => t.stop());
        stopMeter();
        setState({ status: 'error', message: '录音出错，请重试' });
      };

      recorder.start(200);
      startMeter(stream);
      startTimeRef.current = Date.now();
      setState({ status: 'recording', elapsedMs: 0 });

      timerRef.current = setInterval(() => {
        const elapsed = Date.now() - startTimeRef.current;
        if (elapsed >= MAX_DURATION_MS) {
          stopTimer();
          if (mediaRecorderRef.current && mediaRecorderRef.current.state !== 'inactive') {
            try {
              mediaRecorderRef.current.stop();
            } catch { /* ignore */ }
          }
          setState({ status: 'error', message: '已到上限（20秒）' });
        } else {
          setState({ status: 'recording', elapsedMs: elapsed });
        }
      }, 200);
    } catch (err) {
      // 作废了的那一路报错不再说话(人已经松手了,这一路本来就不算数)。
      if (seq !== startSeqRef.current) return;
      const isPermission = err instanceof Error && (err.name === 'NotAllowedError' || err.name === 'PermissionDeniedError');
      // 2026-09-24:被拒每次都说一句 —— 以前第二次起静默回 idle,按了没反应也不说为什么。
      setState({ status: 'error', message: isPermission ? MIC_PERMISSION_TEXT : '无法启动录音' });
    }
  }, [state.status, stopTimer, startMeter, stopMeter]);

  const cancelRecording = useCallback(() => {
    cancelledRef.current = true;
    startSeqRef.current += 1; // 2026-09-24:还在等 getUserMedia 的那一路一并作废
    cleanup();
    setState({ status: 'cancelled' });
    // 2026-09-24:只在还是「已取消」时回 idle,别把紧接着的下一次起录冲掉。
    setTimeout(() => setState((s) => (s.status === 'cancelled' ? { status: 'idle' } : s)), 300);
  }, [cleanup]);

  const stopRecording = useCallback((): { blob: Blob; wavBlob: Blob; mimeType: string; durationMs: number } | null => {
    const recorder = mediaRecorderRef.current;
    if (!recorder || recorder.state === 'inactive') return null;

    stopTimer();
    const durationMs = Math.min(Date.now() - startTimeRef.current, MAX_DURATION_MS);

    // 在 stopMeter 清理前，用已采集的 PCM 合成 16k WAV（供 ASR）
    const wavBlob = buildWavBlob(pcmChunksRef.current, srcRateRef.current);

    try {
      recorder.stop();
    } catch {
      return null;
    }

    const blob = new Blob(chunksRef.current, { type: recorder.mimeType || 'audio/webm' });
    mediaRecorderRef.current = null;
    chunksRef.current = [];
    setState({ status: 'idle' });
    return { blob, wavBlob, mimeType: recorder.mimeType || 'audio/webm', durationMs };
  }, [stopTimer]);

  useEffect(() => {
    return () => {
      startSeqRef.current += 1; // 2026-09-24:卸掉时还在等麦克风的那一路也作废,回来就关
      cleanup();
    };
  }, [cleanup]);

  return {
    state,
    startRecording,
    stopRecording,
    cancelRecording,
    audioLevelRef,
  };
}
