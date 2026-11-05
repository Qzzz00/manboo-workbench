/**
 * 全息屏麦克风采集 + 能量 VAD（雏形）。屏幕不可点，交互靠语音，所以持续听：
 * getUserMedia → Web Audio AnalyserMode 时域 RMS 判说话起止 → 一段话结束就用
 * MediaRecorder 出 blob → transcribeBlob(/ai/asr) → onUtterance(text)。
 *
 * 唤醒词是第二步；本雏形靠 `muted`（我们自己 TTS 说话/回合进行中）门控收音，
 * 避免自问自答与回合重叠。真机用瘦终端自带麦克风，音乐走扬声器不太进麦。
 *
 * 仅 holo 面(App)挂载；移动端主客户端从不 enabled，不占麦克风。
 */
import { useEffect, useRef, useState } from 'react';
import { pickRecorderMimeType, transcribeBlob } from '../lib/asr';
import { resolveVadConfig } from './vadConfig';

export interface HoloVoiceState {
  /** 麦克风已就绪（授权+流已起）。 */
  micReady: boolean;
  /** 当前正在采集一段话（用户在说）。可驱动一个「聆听中」有色指示点。 */
  listening: boolean;
}

export interface UseHoloVoiceArgs {
  /** 主开关：holo 面登录后为 true，才获取麦克风。false 时彻底释放麦克风。 */
  enabled: boolean;
  /** 瞬时门控：我们自己 TTS 说话 / 回合进行中时为 true，暂停检测（不释放流）。 */
  muted: boolean;
  /** 识别出一整句话（非空）时回调——App 喂给 handleSubmit 当聊天输入。 */
  onUtterance: (text: string) => void;
  /** 采集/识别出错回调（授权拒绝、ASR 失败等）。 */
  onError?: (err: unknown) => void;
}

export function useHoloVoice({ enabled, muted, onUtterance, onError }: UseHoloVoiceArgs): HoloVoiceState {
  const [micReady, setMicReady] = useState(false);
  const [listening, setListening] = useState(false);

  // 最新回调/门控放 ref，避免重建整条音频管线（enabled 变化才重建）。
  const mutedRef = useRef(muted);
  mutedRef.current = muted;
  const onUtteranceRef = useRef(onUtterance);
  onUtteranceRef.current = onUtterance;
  const onErrorRef = useRef(onError);
  onErrorRef.current = onError;

  useEffect(() => {
    if (!enabled) return;

    // VAD 阈值：默认 + URL 覆盖（真机现场调，不用重打包）。开麦时打印一次便于对照。
    const cfg = resolveVadConfig(typeof window !== 'undefined' ? window.location.search : '');
    console.info('[holo-voice] VAD config', cfg);

    let alive = true;
    let stream: MediaStream | null = null;
    let audioCtx: AudioContext | null = null;
    let analyser: AnalyserNode | null = null;
    let raf = 0;

    // VAD 状态机
    let recorder: MediaRecorder | null = null;
    let chunks: Blob[] = [];
    let speaking = false; // 段内（正在录）
    let overThreshold = 0; // 连续过阈帧计数
    let silenceStart = 0; // 静音起点(ms)
    let segStart = 0; // 段起点(ms)
    let asrBusy = false; // 一段 ASR 在飞时不开新段，避免重叠
    const mime = pickRecorderMimeType();

    const now = () => performance.now();

    const startSegment = () => {
      if (!stream || asrBusy) return;
      chunks = [];
      try {
        recorder = mime ? new MediaRecorder(stream, { mimeType: mime }) : new MediaRecorder(stream);
      } catch (err) {
        onErrorRef.current?.(err);
        return;
      }
      recorder.ondataavailable = (e) => {
        if (e.data && e.data.size > 0) chunks.push(e.data);
      };
      recorder.onstop = () => {
        const dur = now() - segStart;
        const blob = new Blob(chunks, { type: mime || 'audio/webm' });
        chunks = [];
        // 太短或空 → 丢弃，不打 ASR
        if (dur < cfg.minUtterMs || blob.size < 1200) return;
        asrBusy = true;
        transcribeBlob(blob)
          .then((text) => {
            if (!alive) return;
            const t = text.trim();
            if (t) onUtteranceRef.current(t);
          })
          .catch((err) => onErrorRef.current?.(err))
          .finally(() => {
            asrBusy = false;
          });
      };
      recorder.start();
      speaking = true;
      segStart = now();
      if (alive) setListening(true);
    };

    const endSegment = () => {
      if (recorder && recorder.state !== 'inactive') recorder.stop();
      recorder = null;
      speaking = false;
      if (alive) setListening(false);
    };

    const buf = () => new Uint8Array(analyser!.fftSize);

    const tick = () => {
      raf = requestAnimationFrame(tick);
      if (!analyser) return;

      // 门控：被 muted（我们在说话/回合中）→ 若正在录就收尾丢弃，不检测。
      if (mutedRef.current) {
        if (speaking) {
          // 直接丢弃这段（可能混入了我们自己的声音），不送 ASR
          if (recorder && recorder.state !== 'inactive') {
            recorder.onstop = null;
            recorder.stop();
          }
          recorder = null;
          speaking = false;
          setListening(false);
        }
        return;
      }

      const data = buf();
      analyser.getByteTimeDomainData(data);
      // 时域 RMS：样本以 128 为中心，归一到 0..1
      let sum = 0;
      for (let i = 0; i < data.length; i++) {
        const v = (data[i] - 128) / 128;
        sum += v * v;
      }
      const rms = Math.sqrt(sum / data.length);

      const t = now();
      if (!speaking) {
        if (rms >= cfg.startRms) {
          overThreshold += 1;
          if (overThreshold >= cfg.startFrames) {
            overThreshold = 0;
            startSegment();
            silenceStart = 0;
          }
        } else {
          overThreshold = 0;
        }
      } else {
        // 段内：追踪静音 & 上限
        if (rms < cfg.stopRms) {
          if (silenceStart === 0) silenceStart = t;
          else if (t - silenceStart >= cfg.silenceMs) {
            endSegment();
            silenceStart = 0;
          }
        } else {
          silenceStart = 0;
        }
        if (t - segStart >= cfg.maxUtterMs) {
          endSegment();
          silenceStart = 0;
        }
      }
    };

    (async () => {
      try {
        // ★回声消除：设备(U3/瘦终端)喇叭+麦同体，角色 TTS 会串进麦→自听/盖住指令。开 AEC 让系统把
        // 扬声器输出从麦输入里抵消，配降噪+自动增益提升人声信噪比。设备不支持则被忽略(不报错)。
        stream = await navigator.mediaDevices.getUserMedia({
          audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
        });
        if (!alive) {
          stream.getTracks().forEach((tr) => tr.stop());
          return;
        }
        const Ctx = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
        audioCtx = new Ctx();
        const src = audioCtx.createMediaStreamSource(stream);
        analyser = audioCtx.createAnalyser();
        analyser.fftSize = 1024;
        analyser.smoothingTimeConstant = 0.2;
        src.connect(analyser);
        setMicReady(true);
        raf = requestAnimationFrame(tick);
      } catch (err) {
        onErrorRef.current?.(err);
      }
    })();

    return () => {
      alive = false;
      cancelAnimationFrame(raf);
      if (recorder && recorder.state !== 'inactive') {
        recorder.onstop = null;
        recorder.stop();
      }
      recorder = null;
      stream?.getTracks().forEach((tr) => tr.stop());
      audioCtx?.close().catch(() => {});
      setMicReady(false);
      setListening(false);
    };
    // enabled 变化才重建整条管线；muted/回调走 ref。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled]);

  return { micReady, listening };
}
