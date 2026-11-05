import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createPresenceStore } from './presenceStore.ts';

const NEUTRAL = 'neutral';

function makeStore() {
  return createPresenceStore({ neutralExpressionId: NEUTRAL });
}

describe('PresenceStore.compose', () => {
  it('falls back to neutral expression when every layer is empty', () => {
    const store = makeStore();
    const { expressionMix, parameterOverrides, costumeParamOverrides } = store.compose();
    expect(expressionMix).toEqual([{ key: NEUTRAL, weight: 1 }]);
    expect(parameterOverrides).toEqual([]);
    expect(costumeParamOverrides).toEqual([]);
  });

  it('emotion expression replaces neutral while active', () => {
    const store = makeStore();
    store.applyEmotion({ expressionMix: [{ key: 'happy', weight: 1 }] });
    expect(store.compose().expressionMix).toEqual([{ key: 'happy', weight: 1 }]);
  });

  it('merges apparel + morph + emotion into one expression mix (emotion layered last)', () => {
    const store = makeStore();
    store.setApparel({ id: 'cat_ears', expressionMix: [{ key: 'cat_ears', weight: 1 }] });
    store.setMorph({ id: 'get_smaller', expressionMix: [{ key: 'small', weight: 1 }] });
    store.applyEmotion({ expressionMix: [{ key: 'happy', weight: 1 }] });
    expect(store.compose().expressionMix).toEqual([
      { key: 'cat_ears', weight: 1 },
      { key: 'small', weight: 1 },
      { key: 'happy', weight: 1 },
    ]);
  });

  it('apparel writes costumeParamOverrides (DJ Param67 path)', () => {
    const store = makeStore();
    store.setApparel({ id: 'dj', costumeParamOverrides: [{ id: 'Param67', value: 1 }] });
    expect(store.compose().costumeParamOverrides).toEqual([{ id: 'Param67', value: 1 }]);
  });
});

// === INVARIANT 1: ②③ persistent layers are NEVER overwritten by ① emotion ===
describe('INVARIANT: apparel/morph survive emotion fade-back and next emotion', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('emotion fade timer does not clear apparel or morph', () => {
    const store = makeStore();
    store.setApparel({ id: 'cat_ears', expressionMix: [{ key: 'cat_ears', weight: 1 }] });
    store.setMorph({ id: 'get_smaller', expressionMix: [{ key: 'small', weight: 1 }] });
    store.applyEmotion({ expressionMix: [{ key: 'happy', weight: 1 }], holdMs: 6000 });

    vi.advanceTimersByTime(6000); // emotion fades back

    expect(store.compose().expressionMix).toEqual([
      { key: 'cat_ears', weight: 1 },
      { key: 'small', weight: 1 },
    ]);
  });

  it('a new emotion does not blast away apparel/morph layers', () => {
    const store = makeStore();
    store.setApparel({ id: 'cat_ears', expressionMix: [{ key: 'cat_ears', weight: 1 }] });
    store.setMorph({ id: 'small', parameterOverrides: [{ id: 'ParamScale', value: 0.5 }] });
    store.applyEmotion({ expressionMix: [{ key: 'happy', weight: 1 }] });
    store.applyEmotion({ expressionMix: [{ key: 'sad', weight: 1 }] });

    const out = store.compose();
    expect(out.expressionMix).toEqual([
      { key: 'cat_ears', weight: 1 },
      { key: 'sad', weight: 1 },
    ]);
    // morph parameter override persists through emotion churn
    expect(out.parameterOverrides).toEqual([{ id: 'ParamScale', value: 0.5 }]);
  });

  it('emotion parameter overrides never clobber persistent morph/apparel param keys', () => {
    const store = makeStore();
    store.setMorph({ id: 'small', parameterOverrides: [{ id: 'ParamScale', value: 0.5 }] });
    // emotion tries to set the same param key -> persistent layer wins
    store.applyEmotion({
      expressionMix: [{ key: 'happy', weight: 1 }],
      parameterOverrides: [{ id: 'ParamScale', value: 1 }, { id: 'ParamCheek', value: 0.8 }],
    });
    const params = store.compose().parameterOverrides;
    expect(params).toContainEqual({ id: 'ParamScale', value: 0.5 }); // morph wins
    expect(params).toContainEqual({ id: 'ParamCheek', value: 0.8 }); // emotion-only key kept
  });
});

// === INVARIANT 2: switching session keeps morph (变小) ===
describe('INVARIANT: resetEmotion (切会话) keeps 变小/换装', () => {
  it('resetEmotion only clears emotion, morph + apparel survive', () => {
    const store = makeStore();
    store.setApparel({ id: 'cat_ears', expressionMix: [{ key: 'cat_ears', weight: 1 }] });
    store.setMorph({ id: 'get_smaller', expressionMix: [{ key: 'small', weight: 1 }] });
    store.applyEmotion({ expressionMix: [{ key: 'happy', weight: 1 }] });

    store.resetEmotion(); // what character-switch / next-reply triggers

    expect(store.compose().expressionMix).toEqual([
      { key: 'cat_ears', weight: 1 },
      { key: 'small', weight: 1 },
    ]);
  });
});

// === Layer lifecycle: explicit removal ===
describe('apparel/morph explicit removal', () => {
  it('removeApparel drops only that apparel id', () => {
    const store = makeStore();
    store.setApparel({ id: 'cat_ears', expressionMix: [{ key: 'cat_ears', weight: 1 }] });
    store.setApparel({ id: 'glasses', expressionMix: [{ key: 'glasses', weight: 1 }] });
    store.removeApparel('cat_ears');
    expect(store.compose().expressionMix).toEqual([{ key: 'glasses', weight: 1 }]);
  });

  it('clearMorph removes the morph layer', () => {
    const store = makeStore();
    store.setMorph({ id: 'small', expressionMix: [{ key: 'small', weight: 1 }] });
    store.clearMorph();
    expect(store.compose().expressionMix).toEqual([{ key: NEUTRAL, weight: 1 }]);
  });

  it('setMorph replaces previous morph (single morph state)', () => {
    const store = makeStore();
    store.setMorph({ id: 'small', expressionMix: [{ key: 'small', weight: 1 }] });
    store.setMorph({ id: 'giant', expressionMix: [{ key: 'giant', weight: 1 }] });
    expect(store.compose().expressionMix).toEqual([{ key: 'giant', weight: 1 }]);
  });
});

// === Layer ④: one-shot gestures via nativeTriggers ===
describe('playGesture emits a one-shot native trigger', () => {
  it('records the gesture id with an incrementing nonce', () => {
    const store = makeStore();
    store.playGesture('wave');
    const t1 = store.compose().nativeTriggers;
    expect(t1).toHaveLength(1);
    expect(t1[0].id).toBe('wave');

    store.playGesture('wave'); // same id again must still re-trigger -> new nonce
    const t2 = store.compose().nativeTriggers;
    expect(t2[0].nonce).not.toBe(t1[0].nonce);
  });

  it('gesture does not appear in expressionMix (it is a motion, not a face)', () => {
    const store = makeStore();
    store.playGesture('wave');
    expect(store.compose().expressionMix).toEqual([{ key: NEUTRAL, weight: 1 }]);
  });
});

// === Subscription ===
describe('subscribe', () => {
  it('notifies subscribers on any mutation and stops after unsubscribe', () => {
    const store = makeStore();
    const seen: number[] = [];
    const unsub = store.subscribe(() => seen.push(1));
    store.applyEmotion({ expressionMix: [{ key: 'happy', weight: 1 }] });
    store.setApparel({ id: 'x', expressionMix: [{ key: 'x', weight: 1 }] });
    unsub();
    store.applyEmotion({ expressionMix: [{ key: 'sad', weight: 1 }] });
    expect(seen).toHaveLength(2);
  });
});
