import { describe, it, expect } from 'vitest';
import { resolveExpression, nativeRefToExpressionKey } from './resolveExpression';
import type { AUProfile, SelectedExpression } from './types';

const profile: AUProfile = {
  version: 1,
  characterId: 'test',
  semanticBindings: {
    'eye.open': { paramId: 'ParamEyeLOpen', curve: 'linear' },
    'mouth.smile': { paramId: 'ParamMouthForm', curve: 'linear' },
    // note: head.yaw intentionally NOT bound
  },
  units: [],
  rules: [],
};

function selected(partial: Partial<SelectedExpression>): SelectedExpression {
  return {
    units: [],
    emotion: 'happy',
    score: 1,
    semanticTargets: [],
    nativeTriggers: [],
    unitsByRegion: {},
    ...partial,
  };
}

describe('nativeRefToExpressionKey', () => {
  it('strips .exp3.json and lowercases, spaces → underscore (matches avatarManifest)', () => {
    expect(nativeRefToExpressionKey('Black Mask.exp3.json')).toBe('black_mask');
    expect(nativeRefToExpressionKey('Wink.exp3.json')).toBe('wink');
  });

  it('strips directory prefix (rattan-style nested refs)', () => {
    expect(nativeRefToExpressionKey('exp/1.exp3.json')).toBe('1');
    expect(nativeRefToExpressionKey('exp/Hairstyle2_bundled hair.exp3.json')).toBe(
      'hairstyle2_bundled_hair',
    );
  });
});

describe('resolveExpression', () => {
  it('maps native triggers to expressionMix keys with weight 1', () => {
    const res = resolveExpression(
      selected({ nativeTriggers: [{ platform: 'live2d', nativeRef: 'cry.exp3.json' }] }),
      profile,
    );
    expect(res.expressionMix).toEqual([{ key: 'cry', weight: 1 }]);
  });

  it('dedupes repeated native keys', () => {
    const res = resolveExpression(
      selected({
        nativeTriggers: [
          { platform: 'live2d', nativeRef: 'wink.exp3.json' },
          { platform: 'live2d', nativeRef: 'Wink.exp3.json' },
        ],
      }),
      profile,
    );
    expect(res.expressionMix).toEqual([{ key: 'wink', weight: 1 }]);
  });

  it('maps semantic targets to parameterOverrides via semanticBindings', () => {
    const res = resolveExpression(
      selected({
        semanticTargets: [
          { action: 'eye.open', value: 0.3, easing: 'linear' },
          { action: 'mouth.smile', value: -0.5, easing: 'linear' },
        ],
      }),
      profile,
    );
    expect(res.parameterOverrides).toEqual([
      { id: 'ParamEyeLOpen', value: 0.3 },
      { id: 'ParamMouthForm', value: -0.5 },
    ]);
  });

  it('skips semantic targets whose action is not bound for this character', () => {
    const res = resolveExpression(
      selected({
        semanticTargets: [
          { action: 'head.yaw', value: 0.9, easing: 'linear' }, // unbound → skipped
          { action: 'eye.open', value: 0.2, easing: 'linear' },
        ],
      }),
      profile,
    );
    expect(res.parameterOverrides).toEqual([{ id: 'ParamEyeLOpen', value: 0.2 }]);
  });

  it('last value wins when two targets resolve to the same paramId', () => {
    const res = resolveExpression(
      selected({
        semanticTargets: [
          { action: 'eye.open', value: 0.1, easing: 'linear' },
          { action: 'eye.open', value: 0.9, easing: 'linear' },
        ],
      }),
      profile,
    );
    expect(res.parameterOverrides).toEqual([{ id: 'ParamEyeLOpen', value: 0.9 }]);
  });

  it('empty selection yields empty layers', () => {
    const res = resolveExpression(selected({}), profile);
    expect(res.expressionMix).toEqual([]);
    expect(res.parameterOverrides).toEqual([]);
  });
});
