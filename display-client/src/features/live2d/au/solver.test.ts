import { describe, it, expect } from 'vitest';
import { ExpressionSolver } from './solver';
import { ExpressionHistory } from './history';
import type {
  ExpressionUnit,
  ExpressionRule,
  NativeExpressionUnit,
  SemanticExpressionUnit,
} from './types';

// ── 确定性 RNG（Mulberry32），固定种子可复现 ───────────────────────────────────
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function native(
  id: string,
  emotions: NativeExpressionUnit['emotions'],
  regions: NativeExpressionUnit['regions'] = ['mouth'],
  extra: Partial<NativeExpressionUnit> = {},
): NativeExpressionUnit {
  return { type: 'native', id, nativeRef: `${id}.exp3.json`, regions, emotions, ...extra };
}

function semantic(
  id: string,
  action: SemanticExpressionUnit['targets'][number]['action'],
  emotions: SemanticExpressionUnit['emotions'],
): SemanticExpressionUnit {
  return {
    type: 'semantic',
    id,
    targets: [{ action, min: -1, max: 1 }],
    emotions,
  };
}

function makeSolver(
  units: ExpressionUnit[],
  rules: ExpressionRule[] = [],
  seed = 1,
  history = new ExpressionHistory(20),
) {
  return new ExpressionSolver({ units, rules, history, rng: mulberry32(seed) });
}

describe('ExpressionSolver — core selection', () => {
  it('returns empty when no unit is correlated to the emotion', () => {
    const solver = makeSolver([native('a', { happy: 0.8 })]);
    const res = solver.solve({ emotion: 'sad' });
    expect(res.units).toHaveLength(0);
    expect(res.nativeTriggers).toHaveLength(0);
    expect(res.score).toBe(0);
  });

  it('deterministic when randomness=0 (no jitter, no probabilistic select)', () => {
    const units = [native('joy', { happy: 0.9 }), native('grin', { happy: 0.7 }, ['eye'])];
    const a = makeSolver(units, [], 1).solve({ emotion: 'happy', randomness: 0, diversity: 0.6 });
    const b = makeSolver(units, [], 999).solve({ emotion: 'happy', randomness: 0, diversity: 0.6 });
    expect(a.units.map((u) => u.id).sort()).toEqual(b.units.map((u) => u.id).sort());
  });

  it('same seed reproduces the same selection', () => {
    const units = [
      native('a', { happy: 0.5 }, ['mouth']),
      native('b', { happy: 0.4 }, ['eye']),
      native('c', { happy: 0.3 }, ['brow']),
    ];
    const r1 = makeSolver(units, [], 42).solve({ emotion: 'happy' });
    const r2 = makeSolver(units, [], 42).solve({ emotion: 'happy' });
    expect(r1.units.map((u) => u.id)).toEqual(r2.units.map((u) => u.id));
  });
});

describe('ExpressionSolver — noisy-OR fulfillment', () => {
  it('a single strong AU nearly maxes fulfillment (not carried by AU count)', () => {
    // One strong unit; correlation 0.95 → fulfillment ≈ 0.95, region variety small.
    const solver = makeSolver([native('strong', { happy: 0.95 }, ['mouth'])]);
    const res = solver.solve({ emotion: 'happy', randomness: 0 });
    expect(res.units).toHaveLength(1);
    // score = fulfillment(0.95) + variety(1/4*0.10) - size(0) ≈ 0.975
    expect(res.score).toBeGreaterThan(0.9);
  });

  it('fulfillment stays within [0,1] even with many AUs (sum would exceed 1)', () => {
    const units = [
      native('a', { excited: 0.8 }, ['mouth']),
      native('b', { excited: 0.8 }, ['eye']),
      native('c', { excited: 0.8 }, ['brow']),
      native('d', { excited: 0.8 }, ['head']),
    ];
    const res = makeSolver(units, [], 7).solve({ emotion: 'excited', randomness: 0 });
    // fulfillment = 1 - 0.2^n ≤ 1; full region coverage variety = 0.10; minus size penalty.
    // Whatever the combo, fulfillment portion can never push score above ~1.1.
    expect(res.score).toBeLessThanOrEqual(1.1);
  });
});

describe('ExpressionSolver — mutual exclusion', () => {
  it('explicit mutual_exclusion rule prevents two units co-occurring', () => {
    const units = [native('smile', { happy: 0.9 }, ['mouth']), native('frown', { happy: 0.85 }, ['mouth'])];
    const rules: ExpressionRule[] = [
      { kind: 'mutual_exclusion', id: 'mx', unitIds: ['smile', 'frown'] },
    ];
    for (let seed = 0; seed < 20; seed += 1) {
      const res = makeSolver(units, rules, seed).solve({ emotion: 'happy' });
      const ids = res.units.map((u) => u.id);
      expect(ids.includes('smile') && ids.includes('frown')).toBe(false);
    }
  });

  it('implicit action conflict: two semantic units on same action never co-occupy', () => {
    const units = [
      semantic('mouthA', 'mouth.smile', { happy: 0.9 }),
      semantic('mouthB', 'mouth.smile', { happy: 0.85 }),
      semantic('eye', 'eye.open', { happy: 0.6 }),
    ];
    for (let seed = 0; seed < 20; seed += 1) {
      const res = makeSolver(units, [], seed).solve({ emotion: 'happy' });
      const actions = res.semanticTargets.map((t) => t.action);
      const mouthSmiles = actions.filter((a) => a === 'mouth.smile').length;
      expect(mouthSmiles).toBeLessThanOrEqual(1);
    }
  });
});

describe('ExpressionSolver — binding', () => {
  it('forced binding (penalty Infinity) is never half-selected', () => {
    // brows must appear together. Give one a much higher correlation so it would
    // otherwise be picked alone.
    const units = [
      semantic('browL', 'brow.height.left', { angry: 0.9 }),
      semantic('browR', 'brow.height.right', { angry: 0.4 }),
      semantic('mouth', 'mouth.open', { angry: 0.8 }),
    ];
    const rules: ExpressionRule[] = [
      { kind: 'binding', id: 'brows', unitIds: ['browL', 'browR'], penalty: Infinity },
    ];
    for (let seed = 0; seed < 25; seed += 1) {
      const res = makeSolver(units, rules, seed).solve({ emotion: 'angry' });
      const ids = new Set(res.units.map((u) => u.id));
      const hasL = ids.has('browL');
      const hasR = ids.has('browR');
      // either both or neither — never exactly one
      expect(hasL).toBe(hasR);
    }
  });
});

describe('ExpressionSolver — bonus / penalty rules', () => {
  it('bonus rule raises combo score when the pair is present', () => {
    const units = [native('a', { happy: 0.9 }, ['mouth']), native('b', { happy: 0.9 }, ['eye'])];
    const withBonus = makeSolver(units, [{ kind: 'bonus', id: 'bn', unitIds: ['a', 'b'], value: 0.5 }], 0)
      .solve({ emotion: 'happy', randomness: 0 });
    const without = makeSolver(units, [], 0).solve({ emotion: 'happy', randomness: 0 });
    if (withBonus.units.length === 2 && without.units.length === 2) {
      expect(withBonus.score).toBeGreaterThan(without.score);
    }
  });
});

describe('ExpressionSolver — history / novelty', () => {
  it('same emotion repeated yields different faces over time (history avoidance + novelty)', () => {
    const units = [
      native('a', { happy: 0.6 }, ['mouth']),
      native('b', { happy: 0.6 }, ['eye']),
      native('c', { happy: 0.6 }, ['brow']),
      native('d', { happy: 0.6 }, ['head']),
      native('e', { happy: 0.6 }, ['mouth']),
    ];
    const solver = makeSolver(units, [], 3);
    const faces = new Set<string>();
    for (let i = 0; i < 8; i += 1) {
      const res = solver.solve({ emotion: 'happy', historyAvoidance: 0.9, diversity: 0.8, randomness: 0.8 });
      faces.add(res.units.map((u) => u.id).sort().join('+'));
    }
    // With novelty + history avoidance, we should see more than one distinct face.
    expect(faces.size).toBeGreaterThan(1);
  });

  it('preview does not record history; solve does', () => {
    const units = [native('a', { happy: 0.9 }, ['mouth'])];
    const history = new ExpressionHistory(20);
    const solver = makeSolver(units, [], 1, history);
    solver.preview({ emotion: 'happy' });
    expect(history.length).toBe(0);
    solver.solve({ emotion: 'happy' });
    expect(history.length).toBe(1);
  });
});

describe('ExpressionSolver — result assembly', () => {
  it('semantic targets are sampled within range and clamped to action spec', () => {
    // eye.open range is [0,1]; target min/max [-1,1] but clamp should keep [0,1].
    const units = [semantic('eo', 'eye.open', { happy: 0.9 })];
    for (let seed = 0; seed < 30; seed += 1) {
      const res = makeSolver(units, [], seed).solve({ emotion: 'happy', randomness: 0 });
      for (const t of res.semanticTargets) {
        expect(t.value).toBeGreaterThanOrEqual(0);
        expect(t.value).toBeLessThanOrEqual(1);
      }
    }
  });

  it('native units produce nativeTriggers with nativeRef and platform', () => {
    const res = makeSolver([native('wink', { happy: 0.9 })]).solve({ emotion: 'happy', randomness: 0 });
    expect(res.nativeTriggers).toHaveLength(1);
    expect(res.nativeTriggers[0].nativeRef).toBe('wink.exp3.json');
    expect(res.nativeTriggers[0].platform).toBe('live2d');
  });

  it('disabled units are excluded', () => {
    const units = [native('on', { happy: 0.9 }), native('off', { happy: 0.95 }, ['mouth'], { enabled: false })];
    const res = makeSolver(units, [], 1).solve({ emotion: 'happy', randomness: 0 });
    expect(res.units.map((u) => u.id)).not.toContain('off');
  });

  it('respects maxUnits cap', () => {
    const units = Array.from({ length: 8 }, (_, i) =>
      native(`u${i}`, { excited: 0.6 }, [(['brow', 'eye', 'mouth', 'head'] as const)[i % 4]]),
    );
    const res = makeSolver(units, [], 5).solve({ emotion: 'excited', maxUnits: 3, randomness: 0.5 });
    expect(res.units.length).toBeLessThanOrEqual(3);
  });
});
