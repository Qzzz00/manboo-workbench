import { describe, it, expect } from 'vitest';
import { facsKeys } from '@soullink-emotion/engine';
import type { ModelProfile } from '@soullink-emotion/engine';
import { createSoullinkBridge } from './soullinkBridge.ts';

// 最小可用 profile：把第一个 FACS key 映射到情绪域参数 ParamAngleX
function minimalProfile(): ModelProfile {
  return {
    modelId: 'test',
    displayName: 'Test',
    version: '1',
    modelPath: 'test.model3.json',
    parameterMap: { [facsKeys[0]]: { target: 'ParamAngleX', mode: 'set', scale: 30, min: -30, max: 30 } },
    idleConfig: {},
  } as ModelProfile;
}

describe('createSoullinkBridge', () => {
  it('tick 返回 Map，且只含情绪域参数', () => {
    const bridge = createSoullinkBridge({ profile: minimalProfile(), reserved: { costumeIds: ['Param67'], mouthIds: ['ParamMouthOpenY'] } });
    bridge.feedText('我今天超级开心！', 0);
    let out = new Map<string, number>();
    // 推进若干帧让 VAD 趋近
    for (let i = 1; i <= 30; i++) out = bridge.tick(i / 60, 1 / 60);
    for (const id of out.keys()) {
      expect(id).not.toBe('Param67');
      expect(id).not.toBe('ParamMouthOpenY');
    }
    expect(out.size).toBeGreaterThanOrEqual(0); // 不崩即可(具体参数取决于 profile)
  });

  it('情绪随文本变化：开心与难过的 VAD 输出不同', () => {
    const bridge = createSoullinkBridge({ profile: minimalProfile(), reserved: { costumeIds: [], mouthIds: [] } });
    bridge.feedText('太好了我好高兴', 0);
    let happy = 0;
    for (let i = 1; i <= 60; i++) happy = bridge.tick(i / 60, 1 / 60).get('ParamAngleX') ?? 0;
    bridge.feedText('好难过我想哭', 2);
    let sad = 0;
    for (let i = 121; i <= 180; i++) sad = bridge.tick(i / 60, 1 / 60).get('ParamAngleX') ?? 0;
    expect(happy).not.toBeCloseTo(sad, 3); // 两种情绪产生不同参数
  });

  it('tick 抛错：情绪参数入侵保留域', () => {
    // profile 映射 facsKeys[0] → ParamAngleX，但同时把 ParamAngleX 声明为保留(costume)
    // 这样 filterEmotionParams 就会报冲突，tick 应抛错
    const bridge = createSoullinkBridge({ profile: minimalProfile(), reserved: { costumeIds: ['ParamAngleX'], mouthIds: [] } });
    bridge.feedText('这是情绪文本', 0);
    expect(() => {
      for (let i = 1; i <= 30; i++) bridge.tick(i / 60, 1 / 60);
    }).toThrow(/ParamAngleX/);
  });
});
