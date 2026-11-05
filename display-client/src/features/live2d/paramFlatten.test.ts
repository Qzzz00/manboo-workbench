import { describe, expect, it } from 'vitest';
import { flattenExpressionState, clearExpressionFileCache } from './paramFlatten.ts';
import type { AvatarManifest } from './avatarManifest.ts';

// 语义基准 = live2dEngine.buildMixedParameters（WebView 渲染的表情拍平），
// 原生路径必须逐值一致：preset=mixOverwrite、file 按 Blend 三态、override 最后直写。

function makeAvatar(overrides: Partial<AvatarManifest> = {}): AvatarManifest {
  return {
    id: 'test',
    name: 'Test',
    summary: '',
    persona: { tone: '', traits: [], styleRules: [] },
    modelJson: '/live2D/test/test.model3.json',
    scaleMultiplier: 1,
    verticalOffset: 0,
    modelTransform: { scale: 1, offsetX: 0, offsetY: 0 },
    expressions: [
      { id: 'smile', label: '笑', kind: 'emotion', prompt: '', binding: { mode: 'preset', params: { ParamMouthForm: 1, ParamCheek: 0.8 } } },
      { id: 'blush', label: '脸红', kind: 'emotion', prompt: '', binding: { mode: 'file', file: '/live2D/test/blush.exp3.json' } },
    ],
    parameterControls: [],
    transformDefaults: { scale: 1, offsetX: 0, offsetY: 0 },
    ...overrides,
  } as AvatarManifest;
}

const files: Record<string, { Parameters: Array<{ Id: string; Value: number; Blend?: string }> }> = {
  '/live2D/test/blush.exp3.json': {
    Parameters: [
      { Id: 'ParamCheek', Value: 1, Blend: 'Overwrite' },
      { Id: 'ParamAngleZ', Value: 10, Blend: 'Add' },
      { Id: 'ParamBodyAngleX', Value: 2, Blend: 'Multiply' },
    ],
  },
  '/live2D/test/mark.exp3.json': {
    Parameters: [{ Id: 'ParamMark', Value: 1, Blend: 'Overwrite' }],
  },
};

const fetchFile = async (url: string) => {
  const hit = files[url];
  if (!hit) throw new Error(`no fixture: ${url}`);
  return hit;
};

const zeroBaseline = () => 0;

describe('flattenExpressionState', () => {
  it('preset 表情按权重从 baseline 插值（mixOverwrite 语义）', async () => {
    clearExpressionFileCache();
    const result = await flattenExpressionState({
      avatar: makeAvatar(),
      expressionMix: [{ key: 'smile', weight: 0.5 }],
      parameterOverrides: [],
      watermarkVisible: false,
      baseline: zeroBaseline,
      fetchExpressionFile: fetchFile,
    });
    expect(result.ParamMouthForm).toBeCloseTo(0.5);
    expect(result.ParamCheek).toBeCloseTo(0.4);
  });

  it('file 表情按 Blend 三态混合：Overwrite 插值 / Add 加权叠加 / Multiply 加权乘', async () => {
    clearExpressionFileCache();
    const result = await flattenExpressionState({
      avatar: makeAvatar(),
      expressionMix: [{ key: 'blush', weight: 1 }],
      parameterOverrides: [],
      watermarkVisible: false,
      baseline: (id) => (id === 'ParamBodyAngleX' ? 3 : 0),
      fetchExpressionFile: fetchFile,
    });
    expect(result.ParamCheek).toBeCloseTo(1); // Overwrite w=1 → 目标值
    expect(result.ParamAngleZ).toBeCloseTo(10); // Add: 0 + 10*1
    expect(result.ParamBodyAngleX).toBeCloseTo(6); // Multiply: 3 * (1+(2-1)*1)
  });

  it('多层顺序合成：后层在前层结果上继续混合', async () => {
    clearExpressionFileCache();
    const result = await flattenExpressionState({
      avatar: makeAvatar(),
      expressionMix: [
        { key: 'smile', weight: 1 }, // ParamCheek → 0.8
        { key: 'blush', weight: 0.5 }, // Overwrite 0.8 → 0.8 + (1-0.8)*0.5 = 0.9
      ],
      parameterOverrides: [],
      watermarkVisible: false,
      baseline: zeroBaseline,
      fetchExpressionFile: fetchFile,
    });
    expect(result.ParamCheek).toBeCloseTo(0.9);
  });

  it('parameterOverrides 直写覆盖混合结果，权重越界被夹紧', async () => {
    clearExpressionFileCache();
    const result = await flattenExpressionState({
      avatar: makeAvatar(),
      expressionMix: [{ key: 'smile', weight: 5 }], // clamp 到 1
      parameterOverrides: [{ id: 'ParamMouthForm', value: -0.2 }],
      watermarkVisible: false,
      baseline: zeroBaseline,
      fetchExpressionFile: fetchFile,
    });
    expect(result.ParamMouthForm).toBeCloseTo(-0.2); // override 赢
    expect(result.ParamCheek).toBeCloseTo(0.8); // weight clamp 后 =1
  });

  it('watermark 可见时以权重 1 合入；清单外表情 id 静默跳过', async () => {
    clearExpressionFileCache();
    const avatar = makeAvatar({
      watermark: {
        enabledByDefault: true,
        bindings: [{ mode: 'file', file: '/live2D/test/mark.exp3.json' }],
      },
    } as Partial<AvatarManifest>);
    const result = await flattenExpressionState({
      avatar,
      expressionMix: [{ key: 'not-exist', weight: 1 }],
      parameterOverrides: [],
      watermarkVisible: true,
      baseline: zeroBaseline,
      fetchExpressionFile: fetchFile,
    });
    expect(result.ParamMark).toBeCloseTo(1);
    expect(Object.keys(result)).toEqual(['ParamMark']);
  });

  it('全空输入返回空 map（原生端清 overlay 回基线）', async () => {
    clearExpressionFileCache();
    const result = await flattenExpressionState({
      avatar: makeAvatar(),
      expressionMix: [],
      parameterOverrides: [],
      watermarkVisible: false,
      baseline: zeroBaseline,
      fetchExpressionFile: fetchFile,
    });
    expect(Object.keys(result)).toHaveLength(0);
  });
});
