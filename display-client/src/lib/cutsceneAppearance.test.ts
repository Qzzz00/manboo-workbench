import { describe, expect, it } from 'vitest';
import { resolveAppearanceApparel } from './cutsceneAppearance.ts';

describe('resolveAppearanceApparel', () => {
  it('空/无 costume_id → null', () => {
    expect(resolveAppearanceApparel(null)).toBeNull();
    expect(resolveAppearanceApparel(undefined)).toBeNull();
    expect(resolveAppearanceApparel({})).toBeNull();
    expect(resolveAppearanceApparel({ hairstyle_id: 'x' })).toBeNull();
  });

  it('未知 costume_id（M1 桩目录为空）→ null，不崩', () => {
    expect(resolveAppearanceApparel({ costume_id: 'cs_b1' })).toBeNull();
  });
});
