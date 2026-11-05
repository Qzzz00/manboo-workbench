import { describe, it, expect } from 'vitest';
import {
  normalizeSettings,
  defaultHandheldSettings,
  stripFramingFor,
  withStripFraming,
  HEAD_SCREEN_Y_RANGE,
  FACE_SCREEN_FRAC_RANGE,
} from './handheldSettingsStore.ts';
import { DEFAULT_STRIP_FRAMING } from './handheldAvatars.ts';

describe('normalizeSettings', () => {
  it('原样放行合法值', () => {
    const ok = {
      avatarId: 'ghostpuppy',
      stripFraming: { ghostpuppy: { headScreenY: 0.5, faceScreenFrac: 0.4 } },
    };
    expect(normalizeSettings(ok)).toEqual(ok);
  });

  it('null / 空对象回落默认', () => {
    expect(normalizeSettings(null)).toEqual(defaultHandheldSettings());
    expect(normalizeSettings({})).toEqual(defaultHandheldSettings());
  });

  // ★v1 存的是 {stripHeadSizeNorm, stripHeadAnchorY}，语义与 v2 完全不同（模型度量 vs 取景目标），
  // 换算过去毫无意义。直接丢弃回落默认——新默认与双生改造前的成像等价，用户看不出变化。
  it('v1 旧结构整个丢弃，不做换算', () => {
    // 双重断言：v1 与 v2 的字段集完全不交，TS 会挡住直接传参——这本身就是"换了语义"的证据
    const v1 = { stripHeadSizeNorm: 0.19, stripHeadAnchorY: 0.05 } as unknown as Partial<
      ReturnType<typeof defaultHandheldSettings>
    >;
    expect(normalizeSettings(v1)).toEqual(defaultHandheldSettings());
  });

  it('未知 avatarId 回落默认那只', () => {
    expect(normalizeSettings({ avatarId: 'nope' }).avatarId).toBe(defaultHandheldSettings().avatarId);
  });

  // 超范围会让构图散架，UI 层夹一次、存取两侧再夹一次，坏值进不来也出不去
  it('越界的取景值夹回区间', () => {
    const out = normalizeSettings({
      avatarId: 'tororo',
      stripFraming: { tororo: { headScreenY: 99, faceScreenFrac: 99 } },
    });
    expect(out.stripFraming.tororo).toEqual({
      headScreenY: HEAD_SCREEN_Y_RANGE.max,
      faceScreenFrac: FACE_SCREEN_FRAC_RANGE.max,
    });

    const low = normalizeSettings({
      avatarId: 'tororo',
      stripFraming: { tororo: { headScreenY: -99, faceScreenFrac: -99 } },
    });
    expect(low.stripFraming.tororo).toEqual({
      headScreenY: HEAD_SCREEN_Y_RANGE.min,
      faceScreenFrac: FACE_SCREEN_FRAC_RANGE.min,
    });
  });

  // NaN 不能当 0 用：faceScreenFrac=0 会让角色缩成一个点
  it('NaN / 非数字的那一项整条丢弃', () => {
    const out = normalizeSettings({
      avatarId: 'tororo',
      stripFraming: {
        tororo: { headScreenY: Number.NaN, faceScreenFrac: 0.4 },
        ghostpuppy: { headScreenY: 0.4, faceScreenFrac: 'x' as unknown as number },
      },
    });
    expect(out.stripFraming).toEqual({});
  });

  it('不认识的 avatarId 键被剔掉（别把下架角色的值永久留在存档里）', () => {
    const out = normalizeSettings({
      avatarId: 'tororo',
      stripFraming: { nope: { headScreenY: 0.4, faceScreenFrac: 0.4 } },
    });
    expect(out.stripFraming).toEqual({});
  });
});

describe('stripFramingFor', () => {
  it('存过就用存的', () => {
    const s = withStripFraming(defaultHandheldSettings(), 'tororo', {
      headScreenY: 0.6,
      faceScreenFrac: 0.5,
    });
    expect(stripFramingFor(s, 'tororo')).toEqual({ headScreenY: 0.6, faceScreenFrac: 0.5 });
  });

  it('没存过回落注册表默认', () => {
    expect(stripFramingFor(defaultHandheldSettings(), 'ghostpuppy')).toEqual(DEFAULT_STRIP_FRAMING);
  });

  // 每只各记各的：调完双生再调幽灵狗，不该互相覆盖
  it('两只互不干扰', () => {
    let s = withStripFraming(defaultHandheldSettings(), 'tororo', {
      headScreenY: 0.6,
      faceScreenFrac: 0.5,
    });
    s = withStripFraming(s, 'ghostpuppy', { headScreenY: 0.2, faceScreenFrac: 0.2 });
    expect(stripFramingFor(s, 'tororo')).toEqual({ headScreenY: 0.6, faceScreenFrac: 0.5 });
    expect(stripFramingFor(s, 'ghostpuppy')).toEqual({ headScreenY: 0.2, faceScreenFrac: 0.2 });
  });

  it('withStripFraming 也夹区间', () => {
    const s = withStripFraming(defaultHandheldSettings(), 'tororo', {
      headScreenY: 99,
      faceScreenFrac: 99,
    });
    expect(stripFramingFor(s, 'tororo')).toEqual({
      headScreenY: HEAD_SCREEN_Y_RANGE.max,
      faceScreenFrac: FACE_SCREEN_FRAC_RANGE.max,
    });
  });
});
