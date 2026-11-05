import { describe, it, expect } from 'vitest';
import { makeEngine } from './auChatEngine';
import type { AUProfile } from './types';

const profile: AUProfile = {
  version: 1,
  characterId: 'estella',
  semanticBindings: {
    'eye.open': { paramId: 'ParamEyeLOpen', curve: 'linear' },
  },
  units: [
    { type: 'native', id: 'native:angry', nativeRef: 'angry.exp3.json', regions: ['mouth'], emotions: { angry: 0.8 } },
    { type: 'native', id: 'native:cry', nativeRef: 'cry.exp3.json', regions: ['mouth'], emotions: { sad: 0.8 } },
    { type: 'native', id: 'native:wink', nativeRef: 'Wink.exp3.json', regions: ['mouth'], emotions: { happy: 0.6 } },
    // apparel/morph have empty emotions → never selected by emotion solver
    { type: 'native', id: 'native:get smaller', nativeRef: 'Get smaller.exp3.json', regions: [], emotions: {}, category: 'morph' },
    { type: 'native', id: 'native:hat1', nativeRef: 'Hat1.exp3.json', regions: [], emotions: {}, category: 'apparel' },
  ],
  rules: [],
};

describe('auChatEngine', () => {
  it('ready() false when no profile → caller falls back to bridge', () => {
    const engine = makeEngine(null);
    expect(engine.ready()).toBe(false);
    expect(engine.solveEmotion('happy', 0.6)).toBeNull();
  });

  it('ready() true with profile and resolves angry to the angry expression key', () => {
    const engine = makeEngine(profile);
    expect(engine.ready()).toBe(true);
    const res = engine.solveEmotion('angry', 0.9);
    expect(res).not.toBeNull();
    expect(res!.expressionMix.map((m) => m.key)).toContain('angry');
  });

  it('NEVER drives apparel/morph units from emotion (the "乱点 get_smaller" root fix)', () => {
    const engine = makeEngine(profile);
    // hammer many emotions / intensities — morph & apparel have empty emotions,
    // so they must never surface as an expression key.
    for (const emotion of ['happy', 'sad', 'angry', 'surprised', 'excited', 'neutral'] as const) {
      for (let i = 0; i <= 10; i += 1) {
        const res = engine.solveEmotion(emotion, i / 10);
        const keys = res?.expressionMix.map((m) => m.key) ?? [];
        expect(keys).not.toContain('get_smaller');
        expect(keys).not.toContain('hat1');
      }
    }
  });

  it('produces empty mix for an emotion with no correlated units', () => {
    const engine = makeEngine(profile);
    const res = engine.solveEmotion('gentle', 0.5); // nothing bound to gentle
    expect(res!.expressionMix).toEqual([]);
  });

  it('NEVER drives a prop unit even when it was seeded neutral:0.3 (rattan「向下移动消失」根因修复)', () => {
    // rattan 式：自定义参数开关 exp3 曾被误种 {neutral:0.3}，现已标 category:'prop'。
    // solver 必须把它排除，否则 neutral 情绪会挑中它 → 触发非面部参数 → 模型移动消失。
    const propProfile: AUProfile = {
      version: 1,
      characterId: 'rattan',
      semanticBindings: {},
      units: [
        { type: 'native', id: 'native:5', nativeRef: '5.exp3.json', regions: [], emotions: { neutral: 0.3 }, category: 'prop' },
        { type: 'native', id: 'native:loli', nativeRef: 'loli.exp3.json', regions: [], emotions: { neutral: 0.3 }, category: 'prop' },
      ],
      rules: [],
    };
    const engine = makeEngine(propProfile);
    for (const emotion of ['neutral', 'happy', 'sad'] as const) {
      for (let i = 0; i <= 10; i += 1) {
        const keys = engine.solveEmotion(emotion, i / 10)?.expressionMix.map((m) => m.key) ?? [];
        expect(keys).not.toContain('5');
        expect(keys).not.toContain('loli');
      }
    }
  });
});
