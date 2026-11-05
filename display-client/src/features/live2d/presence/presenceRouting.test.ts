import { describe, it, expect } from 'vitest';
import { classifyPresenceLayer } from './presenceRouting.ts';
import type { UnifiedAction } from '../types.ts';

function action(partial: Partial<UnifiedAction> & Pick<UnifiedAction, 'id' | 'kind'>): UnifiedAction {
  return {
    id: partial.id,
    label: partial.label ?? partial.id,
    source: partial.source ?? 'expression',
    ref: partial.ref ?? partial.id,
    kind: partial.kind,
    prompt: partial.prompt ?? '',
    aliases: partial.aliases ?? [],
  };
}

describe('classifyPresenceLayer (action -> 四层归层)', () => {
  it('emotion kind -> ① emotion layer', () => {
    expect(classifyPresenceLayer(action({ id: 'happy', kind: 'emotion' }))).toBe('emotion');
  });

  it('a size/form costume (get_smaller) -> ③ morph layer, persistent', () => {
    expect(classifyPresenceLayer(action({ id: 'get_smaller', kind: 'costume' }))).toBe('morph');
    expect(classifyPresenceLayer(action({ id: 'chibi', kind: 'costume' }))).toBe('morph');
    expect(classifyPresenceLayer(action({ id: 'become_giant', kind: 'costume' }))).toBe('morph');
    expect(classifyPresenceLayer(action({ id: 'tiny_mode', kind: 'costume' }))).toBe('morph');
  });

  it('a wearable costume (cat_ears / glasses) -> ② apparel layer', () => {
    expect(classifyPresenceLayer(action({ id: 'cat_ears', kind: 'costume' }))).toBe('apparel');
    expect(classifyPresenceLayer(action({ id: 'put_on_glasses', kind: 'costume' }))).toBe('apparel');
  });

  it('a one-shot motion action -> ④ gesture layer', () => {
    expect(classifyPresenceLayer(action({ id: 'wave', kind: 'action', source: 'motion' }))).toBe('gesture');
  });

  it('other kind -> ④ gesture (one-shot fallback)', () => {
    expect(classifyPresenceLayer(action({ id: 'sparkle', kind: 'other' }))).toBe('gesture');
  });
});
