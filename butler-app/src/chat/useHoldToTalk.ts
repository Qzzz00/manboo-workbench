/**
 * 「按住说话」那一套动作(2026-09-17 从 VoiceButton 里原样抽出来)。
 *
 * 为什么抽:两处要的是同一套判读——按下开录、上滑丢掉、松手转文字、太短说一句——
 * 与其抄一遍,不如把动作抽成这个 hook,两边共用:改一处两边一起改,行为不会长歪。
 * 现在用它的是引导页那颗 VoiceButton 与首页输入框左边那颗麦克风键(2026-09-24 起,见 composer/PhoneComposer.tsx)。
 *
 * 录音本体(getUserMedia → 16k WAV)还是 Aiboo 那份 useVoiceRecorder,这里只接线。
 *
 * 2026-09-24(卡 feat/phone-composer-call-slot)补了两条:
 *   - **麦克风还没真打开就松手**(还在等 getUserMedia / 权限框):当「太短」说一句,并作废那一路。
 *     以前这里什么都不做,等麦克风回来照样开录 —— 没人按着的一段录音,浮层挂到 20 秒上限。
 *   - **同一个错只说一次**:以前外面每重画一次就换一个 onError,这边的 effect 跟着再跑、把那句话再弹一遍
 *     (toast 消失后又冒出来)。现在按「这一个错误状态」记,报过的不再报。
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { useVoiceRecorder } from '../aiboo/useVoiceRecorder';
import type { AsrResult } from '../api/voice';

/** 上滑超过这么多像素松手 = 不想发了。 */
export const CANCEL_SLIDE_PX = 80;
/** 短于这个时长的按住当手滑处理:宁可让他再按一次,也不要发一条空事项。 */
export const TOO_SHORT_MS = 500;
export const TOO_SHORT_TEXT = '太短了,按住再说';

export interface HoldToTalkInput {
  transcribe(wav: Blob): Promise<AsrResult>;
  /** 识别出来的那句话。和打字发出去的走同一条路径。 */
  onText(text: string): void;
  onError(text: string): void;
  /** 实时音量(0~1),给球的「聆听」态用。 */
  onLevel?(level: number): void;
}

export interface HoldToTalk {
  /** 在录(含「还在要麦克风」那一小段:按下那一刻就算,界面据此当场给反应)。 */
  recording: boolean;
  transcribing: boolean;
  /** 手指已经滑到「松开就取消」的位置。 */
  cancelHint: boolean;
  level: number;
  elapsedMs: number;
  /** 按下:记下起点、开录。 */
  begin(clientY: number): void;
  /** 移动:判断是不是要取消。 */
  move(clientY: number): void;
  /** 松手:转文字发出去,或者丢掉。 */
  end(): Promise<void>;
  /** 指针被系统抢走(来电、手势):当取消处理。 */
  abort(): void;
}

export function useHoldToTalk({ transcribe, onText, onError, onLevel }: HoldToTalkInput): HoldToTalk {
  const recorder = useVoiceRecorder();
  const [cancelHint, setCancelHint] = useState(false);
  const [transcribing, setTranscribing] = useState(false);
  const [level, setLevel] = useState(0);
  const startYRef = useRef(0);
  const rafRef = useRef(0);
  const onErrorRef = useRef(onError);
  onErrorRef.current = onError;
  const reportedRef = useRef<unknown>(null);
  const recording = recorder.state.status === 'recording' || recorder.state.status === 'requesting';
  const elapsedMs = recorder.state.status === 'recording' ? recorder.state.elapsedMs : 0;

  useEffect(() => {
    if (!recording) { setLevel(0); onLevel?.(0); return; }
    const tick = () => {
      setLevel(recorder.audioLevelRef.current);
      onLevel?.(recorder.audioLevelRef.current);
      rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafRef.current);
  }, [recording, recorder.audioLevelRef, onLevel]);

  // 同一个错误状态只报一次(外面换了 onError 也不重报)。
  useEffect(() => {
    if (recorder.state.status !== 'error' || reportedRef.current === recorder.state) return;
    reportedRef.current = recorder.state;
    onErrorRef.current(recorder.state.message);
  }, [recorder.state]);

  const begin = useCallback((clientY: number) => {
    startYRef.current = clientY;
    setCancelHint(false);
    void recorder.startRecording();
  }, [recorder]);

  const move = useCallback((clientY: number) => {
    if (!recording) return;
    setCancelHint(startYRef.current - clientY > CANCEL_SLIDE_PX);
  }, [recording]);

  const end = useCallback(async () => {
    if (!recording) return;
    if (cancelHint) { recorder.cancelRecording(); setCancelHint(false); return; }
    // 麦克风还没真打开就松手了:这一路作废(回来的麦克风当场关掉),当太短说一句。
    if (recorder.state.status === 'requesting') { recorder.cancelRecording(); onError(TOO_SHORT_TEXT); return; }
    const result = recorder.stopRecording();
    if (result === null) return;
    if (result.durationMs < TOO_SHORT_MS) { onError(TOO_SHORT_TEXT); return; }
    setTranscribing(true);
    const asr = await transcribe(result.wavBlob);
    setTranscribing(false);
    if (asr.ok) onText(asr.text);
    else onError(asr.error);
  }, [recording, cancelHint, recorder, transcribe, onText, onError]);

  const abort = useCallback(() => {
    recorder.cancelRecording();
    setCancelHint(false);
  }, [recorder]);

  return { recording, transcribing, cancelHint, level, elapsedMs, begin, move, end, abort };
}
