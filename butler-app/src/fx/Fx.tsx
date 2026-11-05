/**
 * 动效配角的小组件(手机端,2026-09-23)。库是 libraries.dev 的 MIT 包,原样用、版本钉死:
 *   - `border-beam` 1.4.1:光沿边流动 / 呼吸;
 *   - `voice-glow` 0.2.1:通话页底边随声音升起的光。
 * 外面统一包一层 `.ba-fx`(`display: contents`,不占版面),挂 `data-fx` / `data-fx-active`,用例认这一层。
 * App 是深色的,主题一律 `dark`。
 *
 * 没有 `matchMedia` 的环境(极老的 WebView)border-beam 一挂就抛错:挂载那一刻判一次,整个生命周期不变
 * —— 中途换结构会让里面的输入框重挂、丢焦点。
 */
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { BorderBeam } from 'border-beam';
import { VoiceBeam } from 'voice-glow';
import {
  beamSize, beamTuneCss, stepVoiceFloor, VOICE_BAND_COLORS, voiceBeamPaused, voiceFloorOpacity, voiceFloorSettled, voiceFloorTarget,
  type BeamSpec, type CallVoice, type VoiceFloorShown,
} from './fxModel';
import './fx.css';

export function fxSupported(): boolean {
  return typeof window !== 'undefined' && typeof window.matchMedia === 'function';
}

function useFxSupported(): boolean {
  const [supported] = useState(fxSupported);
  return supported;
}

export function FxBeam({ name, spec, active, children }: { name: string; spec: BeamSpec; active: boolean; children: ReactNode }) {
  const supported = useFxSupported();
  const tuneCss = beamTuneCss(spec.tune);
  return (
    <div className="ba-fx" data-fx={name} data-fx-kind={spec.kind} data-fx-active={active}>
      {supported
        ? (
          <BorderBeam
            className="ba-fx__beam"
            size={beamSize(spec.kind)}
            colorVariant={spec.tone}
            theme="dark"
            strength={spec.strength}
            active={active}
            {...(spec.duration === undefined ? {} : { duration: spec.duration })}
            {...(spec.staticColors === true ? { staticColors: true } : {})}
            {...(tuneCss === undefined ? {} : { css: tuneCss })}
          >
            {children}
          </BorderBeam>
        )
        : children}
    </div>
  );
}

/**
 * 页面藏起来了没有(切到后台、锁屏、切走标签)。藏起来时声音光停住,不空转。
 */
export function usePageHidden(): boolean {
  const [hidden, setHidden] = useState(() => typeof document !== 'undefined' && document.visibilityState === 'hidden');
  useEffect(() => {
    if (typeof document === 'undefined') return undefined;
    const update = () => setHidden(document.visibilityState === 'hidden');
    document.addEventListener('visibilitychange', update);
    return () => document.removeEventListener('visibilitychange', update);
  }, []);
  return hidden;
}

/** 屏幕上的值变多少才值得重画一次 React(每一帧都记账,只是不每一帧都重画)。 */
const VISIBLE_STEP = 0.004;

/**
 * 声音光屏幕上的值:按帧追目标(上升快、下降慢、扫光淡出,见 fxModel.stepVoiceFloor)。
 *
 * **每一帧都记账**(2026-09-24):以前只在一帧的变化超过 0.004 时才把新值记下,可下降到后段每帧只动一点点,
 * 于是光落到 0.16 上下就再也落不下去(底板照样全亮、rAF 一直空转)—— 她说话时底边还留着光,就是这个。
 * 现在每帧都往前走,只在看得出的变化(或者追到)时重画 React;追到就停。没有 rAF 的环境直接跳到目标。
 * `current` 是此刻真正的值(库每帧自己来取高度,不为每一帧重渲染整个库)。
 */
export function useVoiceFloorMotion(voice: CallVoice): { shown: VoiceFloorShown; current: { readonly current: VoiceFloorShown } } {
  const [shown, setShown] = useState<VoiceFloorShown>(() => voiceFloorTarget(voice));
  const current = useRef<VoiceFloorShown>(shown);
  const published = useRef<VoiceFloorShown>(shown);
  const { on, level, processing, hers } = voice;
  useEffect(() => {
    const target: CallVoice = { on, level, processing, hers };
    if (voiceFloorSettled(current.current, target)) return undefined;
    const publish = (next: VoiceFloorShown, force: boolean) => {
      const prev = published.current;
      if (!force && Math.abs(next.level - prev.level) <= VISIBLE_STEP && Math.abs(next.sweep - prev.sweep) <= VISIBLE_STEP) return;
      published.current = next;
      setShown(next);
    };
    if (typeof requestAnimationFrame !== 'function') {
      current.current = voiceFloorTarget(target);
      publish(current.current, true);
      return undefined;
    }
    let raf = 0;
    let last: number | undefined;
    const step = (now: number) => {
      // 第一帧按一帧算;页面藏起来又回来那一大步封顶 100ms(不越过目标,见 smoothVoiceLevel)。
      const dt = last === undefined ? 16 : Math.min(Math.max(0, now - last), 100);
      last = now;
      const next = stepVoiceFloor(current.current, target, dt);
      current.current = next;
      const done = voiceFloorSettled(next, target);
      publish(next, done);
      if (!done) raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [on, level, processing, hers]);
  return { shown, current };
}

/**
 * 通话页底边那道光。**一层独立的底板**(绝对定位、不接点击),不去包舞台:
 * 包舞台会让粒子球的画布在进出通话时重挂。`voice.on=false`(没在通话)时整个不画。
 * 2026-09-24:只在「你说话」时升起(见 fxModel.callVoice);屏幕上的值平滑追目标,底板跟着淡入淡出。
 *
 * 2026-09-24 下午(卡 `fix/onboarding-call-same-as-call`,维护者:「不是很稳定,并且会闪烁」):
 *   - 库在通话里**一直挂着**:以前光落到 0 就卸掉、他再开口再装上 —— 每一句都重建画布、重放 0.6 秒淡入,那就是闪。
 *     现在没人说时底板透明、库**停住**(`paused`:不写样式、不画,不卸、不重建),开口就接着走;
 *   - 接通前那道扫光淡出(sweep),不是一帧切掉;
 *   - 扭曲层关掉(`distortion={0}`):库只在 Safari 大面积时关它,安卓 WebView 上一直开着 —— 每帧改裁剪、
 *     叠一层 SVG 置换滤镜,与满屏粒子球抢帧,抢输了库自己降半帧率,看着就「不流动」;
 *   - 线上沿那一圈色散换成灰阶(`VOICE_BAND_COLORS`),`mono` 不再残留红蓝;库的待机呼吸关掉(`idle={0}`),没人说就是 0;
 *   - 页面藏起来也停住。
 */
export function FxVoiceFloor({ voice }: { voice: CallVoice }) {
  const supported = useFxSupported();
  const hidden = usePageHidden();
  const { shown, current } = useVoiceFloorMotion(voice);
  const readLevel = useCallback(() => current.current.level, [current]);
  const paused = voiceBeamPaused(shown, hidden);
  // 库那一层只在「接通前 / 停住」变的时候重渲染;高度由它每帧从 readLevel 取。
  const beam = useMemo(() => (supported
    ? (
      // reach 压到 1.6(mobile 预设是 3):满格时也只升到三颗键上面一点,不去够球。
      // 2026-09-24 全局去蓝:与 border-beam 那几处同一套,黑白灰(mono),关色相漂移。
      <VoiceBeam
        className="ba-fx__voice"
        type="mobile"
        theme="dark"
        colorVariant="mono"
        staticColors
        reach={1.6}
        idle={0}
        distortion={0}
        bandColors={VOICE_BAND_COLORS}
        level={readLevel}
        processing={voice.processing}
        paused={paused}
      >
        <div className="ba-fx__voicebox" />
      </VoiceBeam>
    )
    : null), [supported, readLevel, voice.processing, paused]);
  if (!voice.on) return null;
  return (
    <div
      className="ba-fx ba-fx__voicefloor"
      data-fx="voice"
      data-fx-level={voice.level}
      data-fx-shown={shown.level.toFixed(3)}
      data-fx-sweep={shown.sweep.toFixed(3)}
      data-fx-processing={voice.processing}
      data-fx-paused={paused}
      style={{ opacity: voiceFloorOpacity(shown.level, shown.sweep) }}
      aria-hidden="true"
    >
      {beam}
    </div>
  );
}
