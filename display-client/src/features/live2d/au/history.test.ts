import { describe, it, expect } from 'vitest';
import { ExpressionHistory } from './history';
import type { Emotion, ExpressionSignature } from './types';

function sig(ids: string[], emotion: Emotion = 'happy'): ExpressionSignature {
  return { unitIds: new Set(ids), emotion };
}

describe('ExpressionHistory', () => {
  it('empty history yields zero penalty', () => {
    const h = new ExpressionHistory(20);
    expect(h.penalty(sig(['a']), 0.7)).toBe(0);
  });

  it('historyAvoidance <= 0 yields zero penalty even with matches', () => {
    const h = new ExpressionHistory(20);
    h.record(sig(['a', 'b']));
    expect(h.penalty(sig(['a', 'b']), 0)).toBe(0);
  });

  it('identical signature at head gives max penalty = avoidance (jaccard1, emotion match, recency1)', () => {
    const h = new ExpressionHistory(20);
    h.record(sig(['a', 'b'], 'happy'));
    // similarity = 1*0.65 + 1*0.35 = 1; recency = 1 - 0/20 = 1 → weighted 1 → *0.7
    expect(h.penalty(sig(['a', 'b'], 'happy'), 0.7)).toBeCloseTo(0.7, 6);
  });

  it('emotion mismatch drops the 0.35 emotion component', () => {
    const h = new ExpressionHistory(20);
    h.record(sig(['a', 'b'], 'happy'));
    // jaccard 1 * 0.65 + 0 = 0.65; recency 1 → 0.65 * 0.7
    expect(h.penalty(sig(['a', 'b'], 'sad'), 0.7)).toBeCloseTo(0.65 * 0.7, 6);
  });

  it('partial unit overlap reduces jaccard', () => {
    const h = new ExpressionHistory(20);
    h.record(sig(['a', 'b'], 'happy'));
    // candidate {a,c}: inter {a}=1, union {a,b,c}=3 → jaccard 1/3
    // sim = (1/3)*0.65 + 1*0.35 ; recency 1
    const expected = ((1 / 3) * 0.65 + 0.35) * 0.7;
    expect(h.penalty(sig(['a', 'c'], 'happy'), 0.7)).toBeCloseTo(expected, 6);
  });

  it('recency weight decays with queue position; newest in front', () => {
    // Use distinct emotions so only the targeted entry can match (isolates recency).
    const h = new ExpressionHistory(4);
    h.record(sig(['x'], 'sad')); // oldest → index 3 after 3 more pushes
    h.record(sig(['y'], 'angry'));
    h.record(sig(['z'], 'surprised'));
    h.record(sig(['a', 'b'], 'happy')); // head, index 0
    // exact match at head → recency 1
    expect(h.penalty(sig(['a', 'b'], 'happy'), 1)).toBeCloseTo(1, 6);
    // match the oldest {x}/'sad' at index 3, capacity 4 → recency 1 - 3/4 = 0.25
    expect(h.penalty(sig(['x'], 'sad'), 1)).toBeCloseTo(1 * 0.25, 6);
  });

  it('record drops oldest beyond capacity', () => {
    const h = new ExpressionHistory(2);
    h.record(sig(['a'], 'sad'));
    h.record(sig(['b'], 'angry'));
    h.record(sig(['c'], 'surprised'));
    expect(h.length).toBe(2);
    // 'a'/'sad' should be fully gone → no entry matches it at all
    expect(h.penalty(sig(['a'], 'sad'), 1)).toBe(0);
    expect(h.recentUnitIds.has('a')).toBe(false);
    expect(h.recentUnitIds.has('b')).toBe(true);
    expect(h.recentUnitIds.has('c')).toBe(true);
  });

  it('snapshot/restore round-trips state', () => {
    const h = new ExpressionHistory(20);
    h.record(sig(['a', 'b']));
    h.record(sig(['c']));
    const snap = h.snapshot();
    h.record(sig(['d']));
    expect(h.recentUnitIds.has('d')).toBe(true);
    h.restore(snap);
    expect(h.recentUnitIds.has('d')).toBe(false);
    expect(h.length).toBe(2);
  });

  it('recentUnitIds is the union of all queued unit ids', () => {
    const h = new ExpressionHistory(20);
    h.record(sig(['a', 'b']));
    h.record(sig(['b', 'c']));
    expect([...h.recentUnitIds].sort()).toEqual(['a', 'b', 'c']);
  });
});
