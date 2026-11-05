import type { ExpressionLayer, ParameterOverride } from '../types.ts';

/**
 * 形象状态合成器（PresenceStore）—— 模型的**唯一权威写入口**。
 *
 * 落地四层各自独立的生命周期，再由 compose() 合成出引擎可直接消费的一组输出。
 * 四层：
 *  ① emotion  临时情绪：带淡回 timer，到点回落（compose 时不再贡献）。
 *  ② apparel  持久服饰/换装：仅显式 set/remove（含 DJ Param67 → costumeParamOverrides）。
 *  ③ morph    持久形态：变小/变大/chibi/giant，单一状态，仅显式 set/clear。
 *  ④ gesture  一次性动作：播完即回，产出 nativeTriggers（motion 类由消费侧 playAction/startMotion）。
 *
 * 关键不变量：②③ 持久，**绝不被 ① 的淡回 / 切会话 / 下一条回复覆盖**。
 * compose() 合并次序：apparel → morph → emotion（情绪叠加在最上层），参数层 ②③ 优先于 ①。
 */

export type PresenceLayerInput = {
  expressionMix?: ExpressionLayer[];
  parameterOverrides?: ParameterOverride[];
  /** 持久参数（如 DJ 换装 Param67=1）：直写 costumeParamOverrides，不经平滑/口型。 */
  costumeParamOverrides?: ParameterOverride[];
};

export type EmotionInput = PresenceLayerInput & {
  /** 情绪保持时长，到点淡回。缺省不自动淡回（由外部下一次 applyEmotion / resetEmotion 替换）。 */
  holdMs?: number;
};

export type ApparelInput = PresenceLayerInput & { id: string };
export type MorphInput = PresenceLayerInput & { id: string };

export type NativeTrigger = { id: string; nonce: number };

export type ComposedPresence = {
  expressionMix: ExpressionLayer[];
  parameterOverrides: ParameterOverride[];
  costumeParamOverrides: ParameterOverride[];
  nativeTriggers: NativeTrigger[];
};

type ApparelState = { id: string } & PresenceLayerInput;
type MorphState = { id: string } & PresenceLayerInput;
type EmotionState = PresenceLayerInput;

export type PresenceStore = {
  applyEmotion(input: EmotionInput): void;
  resetEmotion(): void;
  setApparel(input: ApparelInput): void;
  removeApparel(id: string): void;
  setMorph(input: MorphInput): void;
  clearMorph(): void;
  playGesture(id: string): void;
  compose(): ComposedPresence;
  subscribe(listener: () => void): () => void;
  /** 切角色时调用：清掉所有四层（新角色重新建立形象），由调用方随后按身份恢复 ②③。 */
  resetAll(): void;
  /** 切角色时更新 neutral 兜底（不同角色 neutral id 可能不同）。 */
  setNeutralExpressionId(id: string): void;
};

export function createPresenceStore(opts: { neutralExpressionId: string }): PresenceStore {
  let neutralId = opts.neutralExpressionId;

  // ① 情绪（临时）
  let emotion: EmotionState | null = null;
  let emotionTimer: ReturnType<typeof setTimeout> | null = null;

  // ② 服饰（持久，按 id 去重叠加）
  const apparel = new Map<string, ApparelState>();

  // ③ 形态（持久，单一状态）
  let morph: MorphState | null = null;

  // ④ 一次性动作
  let gestureTrigger: NativeTrigger | null = null;
  let gestureNonce = 0;

  const listeners = new Set<() => void>();
  function emit() {
    for (const l of listeners) l();
  }

  function clearEmotionTimer() {
    if (emotionTimer !== null) {
      clearTimeout(emotionTimer);
      emotionTimer = null;
    }
  }

  function applyEmotion(input: EmotionInput): void {
    clearEmotionTimer();
    emotion = {
      expressionMix: input.expressionMix,
      parameterOverrides: input.parameterOverrides,
      costumeParamOverrides: input.costumeParamOverrides,
    };
    if (typeof input.holdMs === 'number' && input.holdMs >= 0) {
      emotionTimer = setTimeout(() => {
        emotionTimer = null;
        emotion = null;
        emit();
      }, input.holdMs);
    }
    emit();
  }

  function resetEmotion(): void {
    clearEmotionTimer();
    emotion = null;
    emit();
  }

  function setApparel(input: ApparelInput): void {
    apparel.set(input.id, {
      id: input.id,
      expressionMix: input.expressionMix,
      parameterOverrides: input.parameterOverrides,
      costumeParamOverrides: input.costumeParamOverrides,
    });
    emit();
  }

  function removeApparel(id: string): void {
    if (apparel.delete(id)) emit();
  }

  function setMorph(input: MorphInput): void {
    morph = {
      id: input.id,
      expressionMix: input.expressionMix,
      parameterOverrides: input.parameterOverrides,
      costumeParamOverrides: input.costumeParamOverrides,
    };
    emit();
  }

  function clearMorph(): void {
    if (morph === null) return;
    morph = null;
    emit();
  }

  function playGesture(id: string): void {
    gestureNonce += 1;
    gestureTrigger = { id, nonce: gestureNonce };
    emit();
  }

  function compose(): ComposedPresence {
    // 表情层：apparel → morph → emotion（情绪叠加在最上）。全空回落 neutral。
    const expressionMix: ExpressionLayer[] = [];
    for (const item of apparel.values()) {
      if (item.expressionMix) expressionMix.push(...item.expressionMix);
    }
    if (morph?.expressionMix) expressionMix.push(...morph.expressionMix);
    if (emotion?.expressionMix) expressionMix.push(...emotion.expressionMix);

    // 参数层：先放 ① 情绪，再用 ②③ 持久层覆盖同 key —— 保证持久层永不被情绪冲掉。
    const paramByKey = new Map<string, ParameterOverride>();
    for (const po of emotion?.parameterOverrides ?? []) paramByKey.set(po.id, po);
    for (const item of apparel.values()) {
      for (const po of item.parameterOverrides ?? []) paramByKey.set(po.id, po);
    }
    for (const po of morph?.parameterOverrides ?? []) paramByKey.set(po.id, po);

    // costumeParamOverrides：纯持久（②③）。情绪不写这一层。
    const costumeByKey = new Map<string, ParameterOverride>();
    for (const item of apparel.values()) {
      for (const po of item.costumeParamOverrides ?? []) costumeByKey.set(po.id, po);
    }
    for (const po of morph?.costumeParamOverrides ?? []) costumeByKey.set(po.id, po);

    return {
      expressionMix: expressionMix.length > 0 ? expressionMix : [{ key: neutralId, weight: 1 }],
      parameterOverrides: [...paramByKey.values()],
      costumeParamOverrides: [...costumeByKey.values()],
      nativeTriggers: gestureTrigger ? [gestureTrigger] : [],
    };
  }

  function subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  }

  function resetAll(): void {
    clearEmotionTimer();
    emotion = null;
    apparel.clear();
    morph = null;
    gestureTrigger = null;
    emit();
  }

  function setNeutralExpressionId(id: string): void {
    neutralId = id;
  }

  return {
    applyEmotion,
    resetEmotion,
    setApparel,
    removeApparel,
    setMorph,
    clearMorph,
    playGesture,
    compose,
    subscribe,
    resetAll,
    setNeutralExpressionId,
  };
}
