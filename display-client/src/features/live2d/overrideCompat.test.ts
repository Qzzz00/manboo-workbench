import { describe, expect, it, vi } from 'vitest';

vi.mock('./paramFlatten.ts', () => ({
  fetchExpressionFileParams: async (url: string) =>
    url.includes('baowawa') ? [{ id: 'Param66', value: 1, blend: 'Overwrite' }] : [{ id: 'Param1', value: 1, blend: 'Overwrite' }],
}));

import { checkOverrideParamCompat, cdi3PathForModelEntry } from './overrideCompat.ts';
import type { AvatarExpression } from './types.ts';

const expr = (id: string): AvatarExpression => ({
  id,
  label: id,
  kind: 'pose',
  prompt: '',
  binding: { mode: 'file', file: `/live2D/x/${id}.exp3.json` },
});

const cdi3With = (ids: string[]) => JSON.stringify({ Parameters: ids.map((Id) => ({ Id })) });

describe('checkOverrideParamCompat', () => {
  it('覆盖模型缺换装参数 → 拒绝（v3 轻量包事故回归）', async () => {
    const result = await checkOverrideParamCompat([expr('baowawa')], async () => cdi3With(['Param1']));
    expect(result).toEqual({ ok: false, missing: ['Param66'] });
  });

  it('参数齐全 → 放行', async () => {
    const result = await checkOverrideParamCompat([expr('baowawa')], async () => cdi3With(['Param1', 'Param66']));
    expect(result.ok).toBe(true);
  });

  it('包内无 cdi3 → 无法校验 → 放行', async () => {
    const result = await checkOverrideParamCompat([expr('baowawa')], async () => null);
    expect(result.ok).toBe(true);
  });

  it('内置角色无声明表情 → 无要求 → 放行', async () => {
    const result = await checkOverrideParamCompat(undefined, async () => cdi3With([]));
    expect(result.ok).toBe(true);
  });

  it('cdi3PathForModelEntry 推导', () => {
    expect(cdi3PathForModelEntry('shuangsheng03.model3.json')).toBe('shuangsheng03.cdi3.json');
    expect(cdi3PathForModelEntry('dir/MODEL.MODEL3.JSON')).toBe('dir/MODEL.cdi3.json');
  });
});
