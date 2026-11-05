import { describe, it, expect } from 'vitest';

// 模拟 runOverlayFrame 的写入顺序：收集每个参数"最后一次写入值"
function simulateWriteOrder(layers: Array<Map<string, number>>): Map<string, number> {
  const out = new Map<string, number>();
  for (const layer of layers) for (const [id, v] of layer) out.set(id, v);
  return out;
}

describe('情绪层写入顺序', () => {
  it('口型层最后写,永远赢过情绪层(即便撞参数)', () => {
    const emotion = new Map([['ParamAngleX', 10], ['ParamMouthOpenY', 0.2]]); // 假想越界值
    const mouth = new Map([['ParamMouthOpenY', 0.9]]);
    // 顺序: costume -> emotion -> mouth
    const final = simulateWriteOrder([new Map([['Param67', 1]]), emotion, mouth]);
    expect(final.get('ParamMouthOpenY')).toBe(0.9); // 口型赢
    expect(final.get('ParamAngleX')).toBe(10);
    expect(final.get('Param67')).toBe(1);
  });
});
