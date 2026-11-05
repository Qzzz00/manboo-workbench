import { useCallback, useEffect, useRef, useState } from 'react';
import { pickRecorderMimeType } from '../lib/asr';

const MAX_DURATION_MS = 20000;
const ASR_SAMPLE_RATE = 16000;

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
  const permissionDeniedRef = useRef(false);
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

    setState({ status: 'requesting' });

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
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
      const isPermission = err instanceof Error && (err.name === 'NotAllowedError' || err.name === 'PermissionDeniedError');
      if (isPermission) {
        if (!permissionDeniedRef.current) {
          permissionDeniedRef.current = true;
          setState({ status: 'error', message: '需要麦克风权限，请在浏览器设置中开启' });
        } else {
          setState({ status: 'idle' });
        }
      } else {
        setState({ status: 'error', message: '无法启动录音' });
      }
    }
  }, [state.status, stopTimer, startMeter, stopMeter]);

  const cancelRecording = useCallback(() => {
    cancelledRef.current = true;
    cleanup();
    setState({ status: 'cancelled' });
    setTimeout(() => setState({ status: 'idle' }), 300);
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
