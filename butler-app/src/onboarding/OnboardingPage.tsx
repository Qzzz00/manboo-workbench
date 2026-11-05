/**
 * 引导对话页(2026-09-16,docs/设计-引导流程.md v2 的手机入口):和事项对话分开的专用页。
 * 上半粒子球(聆听 / 说话态随对话切),下半对话流;文字输入必有;语音键有密钥就能用,没密钥灰掉并说明;
 * 事务官每句回复有密钥就 TTS 朗读,没密钥只显示。八段小点显示当前阶段;做完显示复述卡与「以后我先开口」。
 * 开场体验(2026-09-16):开会话成功那一刻种子句就是事务官的第一句(显示 + 朗读),不等模型;
 * 事务官在想时球进说话准备态、气泡三点,不显示「事务官来了」这种系统句;等太久提示「反应慢了」+ 重试。
 */
import { PhoneComposer } from '../composer/PhoneComposer';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useSession } from '../session';
import { useSettings } from '../settings/SettingsContext';
import { useAppearance } from '../hooks';
import { VoiceButton } from '../chat/VoiceButton';
import { VOICE_UNAVAILABLE_TEXT, reduceVoiceAvailability, shouldTryVoice, type VoiceAvailability } from '../api/voice';
import { playAudioBlob, stopSpeaking } from '../aiboo/lipsyncPlayer';
import { ParticleStage } from '../swarm/ParticleStage';
import { stageModeOf } from '../swarm/orbState';
import { useOnboarding, type OnboardingHandle } from './useOnboarding';
import { AFTERWARDS_TEXT, progressOf, SLOW_TEXT, stageTitle, threadOf } from './onboardingModel';
import type { OnboardingApi } from './onboardingApi';
import { scanLineOf, useReplyWindow, withScanMode } from './scanHold';

export interface OnboardingPageProps {
  onClose(): void;
  /**
   * 退回文字引导时的一句说明(2026-09-18):引导本来是通话模式,通话打不了才回到这一页。
   * 说清为什么,别让人以为这就是设计。
   */
  note?: string;
  api?: OnboardingApi;
  pollMs?: number;
  /** 等这么久没有新回合就提示「反应慢了」(缺省 30 秒)。 */
  slowMs?: number;
}

export function OnboardingPage(props: OnboardingPageProps) {
  const session = useSession();
  const { settings, update } = useSettings();
  const appearance = useAppearance(session.appearance);
  const handle = useOnboarding(session, {
    ...(props.api === undefined ? {} : { api: props.api }),
    ...(props.pollMs === undefined ? {} : { pollMs: props.pollMs }),
    ...(props.slowMs === undefined ? {} : { slowMs: props.slowMs }),
  });
  const { model } = handle;
  const [draft, setDraft] = useState('');
  const [micLevel, setMicLevel] = useState(0);
  const [toast, setToast] = useState<string | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const speech = useOnboardingSpeech(session, settings.voiceEnabled, handle);

  const thread = threadOf(model);
  useEffect(() => { const el = listRef.current; if (el !== null && typeof el.scrollTo === 'function') el.scrollTo({ top: el.scrollHeight }); }, [thread.length, model.phase, handle.waiting, handle.slow]);
  useEffect(() => {
    if (toast === null) return;
    const t = setTimeout(() => setToast(null), 3500);
    return () => clearTimeout(t);
  }, [toast]);
  useEffect(() => { if (model.error !== undefined) setToast(model.error); }, [model.error]);
  // 做完了:主页顶部那张「第一次见面」卡从此不再显示。
  useEffect(() => { if (model.phase === 'done' && settings.onboarding !== 'done') void update({ onboarding: 'done' }); }, [model.phase, settings.onboarding, update]);

  const submit = useCallback((text: string) => { void handle.say(text); }, [handle]);
  const transcribe = useCallback(async (wav: Blob) => {
    const r = await session.voice.asr(wav);
    if (!r.ok && r.kind === 'unavailable') speech.setAvailability({ available: false, note: VOICE_UNAVAILABLE_TEXT, since: Date.now() });
    return r;
  }, [session, speech]);

  const voiceOff = !settings.voiceEnabled || (speech.availability !== 'unknown' && !speech.availability.available);
  const voiceNote = !settings.voiceEnabled ? '语音已关(设置里打开)' : speech.availability !== 'unknown' && !speech.availability.available ? speech.availability.note : undefined;
  const progress = progressOf(model);
  const base = stageModeOf({ speaking: speech.speaking, listening: micLevel > 0 || draft.trim() !== '', working: false, thinking: handle.waiting, attention: false });
  /**
   * 她在找你的项目(2026-09-24;傍晚改成「整段等待」,卡 fix/scan-orb-working-whole-wait):工作台那边一动手找,
   * 球就是执行中 + 输入框上方一行进度,一直到**她的下一句**出来、朗读开了口才回去(不朗读就是那一句出来那一刻)。
   */
  const herLast = [...thread].reverse().find((line) => line.role === 'assistant')?.key;
  const scanWindow = useReplyWindow({ scan: handle.scan, her: herLast, busy: model.busy, speaking: speech.speaking, voice: !voiceOff });
  const scanning = scanWindow.open;
  const stage = { ...base, mode: withScanMode(base.mode, scanning) };

  return (
    // data-ba-kb-page / data-ba-kb-stick:弹键盘时球那一行不缩、输入行贴键盘、对话流贴底(viewport/keyboardViewport.ts,2026-09-24)。
    <div className="ba-chat ba-onboarding" data-phase={model.phase} data-ba-kb-page="onboarding">
      <div className="ba-chat__stage">
        <ParticleStage mode={stage.mode} notice={stage.notice} settings={appearance.preset.settings} scene="onboarding" />
        <button type="button" className="ba-onboarding__close" onClick={props.onClose} aria-label="回主页">‹ 主页</button>
        <ol className="ba-onboarding__dots" aria-label={`引导进度:${model.done ? '完成' : stageTitle(model.stage)}`}>
          {progress.steps.map((s, i) => <li key={s} data-state={i < progress.index ? 'done' : i === progress.index ? 'current' : 'todo'} title={stageTitle(s)} />)}
        </ol>
        <p className="ba-onboarding__stage">{model.done ? '引导完成' : model.phase === 'loading' ? '正在问工作台…' : stageTitle(model.stage)}</p>
      </div>

      <div className="ba-chat__thread" ref={listRef} data-ba-kb-stick="bottom">
        {props.note !== undefined && <p className="ba-onboard__note" role="status">{props.note}</p>}
        {model.phase === 'unavailable' && <p className="ba-onboard__note" role="alert">{model.error}</p>}
        {model.phase === 'resume' && (
          <div className="ba-onboard">
            <p className="ba-onboard__title">引导还没做完</p>
            <p className="ba-onboard__text">{model.resumeLine}</p>
            <div className="ba-row">
              <button type="button" className="ba-btn" onClick={() => { void handle.start(); }}>接着聊</button>
              <button type="button" className="ba-btn ba-btn--ghost" onClick={() => { void handle.restart(); }}>从头来</button>
            </div>
          </div>
        )}
        {model.phase === 'starting' && model.error !== undefined && (
          <div className="ba-onboard">
            <p className="ba-onboard__text">{model.error}</p>
            <button type="button" className="ba-btn" onClick={() => { void handle.start(); }}>再试一次</button>
          </div>
        )}
        {thread.map((line) => (
          <div className={`ba-msg ba-msg--${line.role}`} key={line.key}>
            <div className={`ba-bubble ${line.role === 'user' ? 'ba-bubble--me' : 'ba-bubble--butler ba-bubble--reply'}`} data-pending={line.pending === true} data-kind={line.kind}>
              <p>{line.text}</p>
              {line.pending && <span className="ba-bubble__time">发送中…</span>}
              {line.role === 'assistant' && !voiceOff && (
                <button type="button" className="ba-bubble__replay" onClick={() => { void speech.speak(line.key, line.text); }} aria-label="重听">🔊</button>
              )}
            </div>
          </div>
        ))}
        {handle.waiting && (
          <div className="ba-msg ba-msg--assistant">
            <div className="ba-bubble ba-bubble--butler ba-bubble--typing" role="status" aria-label="事务官在想"><i /><i /><i /></div>
          </div>
        )}
        {handle.slow && (
          <div className="ba-onboard ba-onboard--slow" role="alert">
            <p className="ba-onboard__text">{SLOW_TEXT}</p>
            <button type="button" className="ba-btn" onClick={() => { void handle.retry(); }}>重试</button>
          </div>
        )}
        {model.phase === 'done' && (
          <div className="ba-onboard ba-onboard--done">
            <p className="ba-onboard__title">{model.nickname === undefined ? '记下了' : `${model.nickname},记下了`}</p>
            {model.recap !== undefined && <pre className="ba-onboard__recap">{model.recap}</pre>}
            <p className="ba-onboard__text">{AFTERWARDS_TEXT}</p>
            <button type="button" className="ba-btn" onClick={props.onClose}>回主页</button>
          </div>
        )}
      </div>

      {scanning && <p className="ba-onboarding__scan" role="status">{scanLineOf(scanWindow.shown)}</p>}
      {voiceNote !== undefined && <p className="ba-chat__voicenote">{voiceNote}</p>}
      {toast !== null && <p className="ba-toast" role="alert">{toast}</p>}

      {(model.phase === 'chatting' || model.phase === 'starting') && (
        <div className="ba-composer">
          <VoiceButton disabled={voiceOff} disabledNote={voiceNote} transcribe={transcribe} onText={submit} onError={(t) => setToast(t)} onLevel={setMicLevel} />
          {/* 统一输入框的「引导」裁剪(2026-09-24):只有文字与发送。 */}
          <PhoneComposer
            trim="onboarding"
            placeholder="打字回答…"
            ariaLabel="回答事务官"
            onTextChange={setDraft}
            onSubmit={(d) => { const text = d.text.trim(); if (text === '') return false; setDraft(''); submit(text); return true; }}
          />
          {speech.speaking && <button type="button" className="ba-btn ba-btn--ghost" onClick={speech.stop}>停</button>}
        </div>
      )}
    </div>
  );
}

/**
 * 朗读事务官在引导里说的每句新话(种子句一摆出来就念;被种子句吸收的那条不念):有密钥就念,503/404 之后不再试。
 * 进页面时已有的那些(seq ≤ spokenBaseline)不念。
 */
function useOnboardingSpeech(session: ReturnType<typeof useSession>, enabled: boolean, handle: OnboardingHandle) {
  const [availability, setAvailability] = useState<VoiceAvailability>('unknown');
  const [speaking, setSpeaking] = useState(false);
  const baselineRef = useRef(handle.spokenBaseline);
  const spokenKeys = useRef(new Set<string>());
  const queueRef = useRef<Promise<void>>(Promise.resolve());
  const mouth = useRef(0);

  const speak = useCallback(async (_key: string, text: string) => {
    // 「没配」之后过 60 秒再探一次(与对话页同一条规矩),不用重装 App。
    if (!shouldTryVoice(availability)) return;
    const result = await session.voice.tts(text);
    setAvailability((cur) => reduceVoiceAvailability(cur, result));
    if (!result.ok) return;
    setSpeaking(true);
    try {
      await playAudioBlob(result.data, (v) => { mouth.current = v; }, () => { mouth.current = 0; setSpeaking(false); });
    } catch {
      setSpeaking(false);
    }
  }, [availability, session]);

  useEffect(() => { if (handle.spokenBaseline > baselineRef.current) baselineRef.current = handle.spokenBaseline; }, [handle.spokenBaseline]);
  // 「从头来」:回合与种子句重新编号,朗读记录清零(否则新的 seed:opening:0 / t1 会被当成念过)。
  const epochRef = useRef(handle.epoch);
  useEffect(() => { if (handle.epoch !== epochRef.current) { epochRef.current = handle.epoch; baselineRef.current = 0; spokenKeys.current.clear(); } }, [handle.epoch]);

  useEffect(() => {
    const fresh = threadOf(handle.model).filter((line) => {
      if (line.role !== 'assistant' || line.pending === true || spokenKeys.current.has(line.key)) return false;
      const seq = line.key.startsWith('t') ? Number(line.key.slice(1)) : Number.NaN;
      return !(Number.isFinite(seq) && seq <= baselineRef.current);
    });
    if (fresh.length === 0) return;
    for (const line of fresh) spokenKeys.current.add(line.key);
    if (!enabled) return;
    for (const line of fresh) queueRef.current = queueRef.current.then(() => speak(line.key, line.text));
  }, [handle.model, enabled, speak]);

  const stop = useCallback(() => { stopSpeaking(); mouth.current = 0; setSpeaking(false); }, []);
  useEffect(() => () => { stopSpeaking(); }, []);

  return { availability, setAvailability, speaking, speak, stop };
}
