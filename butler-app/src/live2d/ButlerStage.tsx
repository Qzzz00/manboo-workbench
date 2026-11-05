/**
 * 竖屏上半那块 Live2D 舞台:薄薄一层 React 壳包着 Aiboo 的 live2dEngine(原样搬来的)。
 * 口型:调用方把 0~1 的口型值写进 mouthRef,这里每帧喂给 setMouthSyncOverrides。
 *
 * 表情跟着语气走(2026-10-02,卡「声音与形象跟着话走」第 4 件):同一套路子 ——
 * 调用方把这一句的语气写进 {@link Props.toneRef},这里每帧看一眼,变了就换表情、
 * 到点({@link TONE_HOLD_MS})回中性。
 *
 * 为什么也走 ref 而不是 props:字幕一句一条,一通电话几十条 —— 每条都让这一层重渲染
 * 等于每句话重建一次 Live2D 的 effect(deps 里只有 avatar 正是为了这个)。ref 不触发渲染。
 */
import { useEffect, useRef, useState } from 'react';
import type { AvatarManifest } from './types.ts';
import {
  applyExpressionMix, createLive2DRuntime, destroyRuntime, resizeRuntime, setFramingTarget,
  setMouthSyncOverrides, updateStageTransform, type RuntimeState,
} from './live2dEngine.ts';
import { resolveNeutralExpression, resolveToneExpression, TONE_HOLD_MS } from './tone.ts';
import { installLive2DUrlPatch } from './urlPatch';

interface Props {
  avatar: AvatarManifest;
  mouthRef: React.MutableRefObject<number>;
  /**
   * **这一句的语气**(通话里才有;短列表的主人是 channel-worker/src/tts/tone.ts)。
   * 写进来就换表情,写 null 就回中性。**这个形象没有对应的表情就不动** ——
   * 随便挑一张「最像的」比不动更糟(tone.ts 的纪律 ②)。
   */
  toneRef?: React.MutableRefObject<string | null>;
  onStatus?(status: 'loading' | 'ready' | 'failed'): void;
}

export function ButlerStage({ avatar, mouthRef, toneRef, onStatus }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const runtimeRef = useRef<RuntimeState | null>(null);
  const [failed, setFailed] = useState<string | null>(null);

  useEffect(() => {
    const container = containerRef.current;
    if (container === null) return;
    let cancelled = false;
    setFailed(null);
    onStatus?.('loading');
    installLive2DUrlPatch();

    void createLive2DRuntime(container, avatar)
      .then(async (runtime) => {
        if (cancelled) { destroyRuntime(runtime); return; }
        runtimeRef.current = runtime;
        await applyExpressionMix(runtime, avatar, [{ key: 'neutral', weight: 1 }]);
        setFramingTarget(runtime, 'home');
        updateStageTransform(runtime, container, avatar.transformDefaults);
        onStatus?.('ready');
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        setFailed(error instanceof Error ? error.message : String(error));
        onStatus?.('failed');
      });

    const observer = new ResizeObserver(() => {
      if (runtimeRef.current !== null && containerRef.current !== null) resizeRuntime(runtimeRef.current, containerRef.current);
    });
    observer.observe(container);

    let raf = 0;
    let last = -1;
    /** 上一帧看到的语气。`undefined` = 还没看过(第一帧不算「变了」)。 */
    let lastTone: string | null | undefined;
    let toneTimer: ReturnType<typeof setTimeout> | undefined;
    /** 回中性。形象里压根没有中性那一张就**把情绪层清空**,不去点一张不存在的表情。 */
    const toNeutral = (runtime: RuntimeState) => {
      const neutral = resolveNeutralExpression(avatar);
      void applyExpressionMix(runtime, avatar, neutral === undefined ? [] : [{ key: neutral, weight: 1 }]);
    };
    const tick = () => {
      const runtime = runtimeRef.current;
      const level = mouthRef.current;
      if (runtime !== null && level !== last) {
        last = level;
        setMouthSyncOverrides(runtime, level <= 0 ? [] : [{ id: 'ParamMouthOpenY', value: level }]);
      }
      const tone = toneRef?.current ?? null;
      if (runtime !== null && tone !== lastTone) {
        lastTone = tone;
        if (toneTimer !== undefined) clearTimeout(toneTimer);
        toneTimer = undefined;
        const expression = resolveToneExpression(avatar, tone ?? undefined);
        if (expression !== undefined) {
          void applyExpressionMix(runtime, avatar, [{ key: expression, weight: 1 }]);
          // **说完回中性**:一句话大致这么长,到点自己落回去(她不会一直挂着一张脸)。
          toneTimer = setTimeout(() => { toneTimer = undefined; toNeutral(runtime); }, TONE_HOLD_MS);
        }
        else if (tone === null) toNeutral(runtime);
        // 有语气却没有对应的表情:**一个参数都不写**,脸原样不动。
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);

    return () => {
      cancelled = true;
      cancelAnimationFrame(raf);
      if (toneTimer !== undefined) clearTimeout(toneTimer);
      observer.disconnect();
      if (runtimeRef.current !== null) {
        destroyRuntime(runtimeRef.current);
        runtimeRef.current = null;
      }
    };
  // avatar 换了才重建;mouthRef / toneRef / onStatus 是稳定引用。
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [avatar]);

  return (
    <div className="ba-stage">
      <div ref={containerRef} className="ba-stage__canvas" />
      {failed !== null && <p className="ba-stage__note">形象加载失败:{failed}</p>}
    </div>
  );
}
