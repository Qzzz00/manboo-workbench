import { describe, expect, it } from 'vitest';
import {
  HOLO_BASE_FACE,
  HOLO_DEFAULT_HEAD,
  pickHoloAvatarId,
  resolveHoloAvatarId,
  resolveHoloFraming,
  resolveHoloNativeTargetFps,
} from './holoStage';

describe('resolveHoloFraming', () => {
  it('returns defaults for empty / irrelevant params', () => {
    expect(resolveHoloFraming('')).toEqual({ faceScreenFrac: HOLO_BASE_FACE, headScreenY: HOLO_DEFAULT_HEAD });
    expect(resolveHoloFraming('?server=http://x&vad=0.05')).toEqual({ faceScreenFrac: HOLO_BASE_FACE, headScreenY: HOLO_DEFAULT_HEAD });
  });

  it('scale multiplies the base face fraction (size), independent of head', () => {
    expect(resolveHoloFraming('?scale=0.5').faceScreenFrac).toBeCloseTo(HOLO_BASE_FACE * 0.5);
    expect(resolveHoloFraming('?scale=0.5').headScreenY).toBe(HOLO_DEFAULT_HEAD); // head untouched
    expect(resolveHoloFraming('?scale=2').faceScreenFrac).toBeCloseTo(HOLO_BASE_FACE * 2);
  });

  it('head sets vertical position, independent of scale', () => {
    expect(resolveHoloFraming('?head=0.35').headScreenY).toBe(0.35);
    expect(resolveHoloFraming('?head=0.35').faceScreenFrac).toBe(HOLO_BASE_FACE); // size untouched
  });

  it('maps both at once', () => {
    const f = resolveHoloFraming('?scale=0.8&head=0.28');
    expect(f.faceScreenFrac).toBeCloseTo(HOLO_BASE_FACE * 0.8);
    expect(f.headScreenY).toBe(0.28);
  });

  it('tolerates leading "?" or none', () => {
    expect(resolveHoloFraming('head=0.3').headScreenY).toBe(0.3);
  });

  it('rejects non-numeric / out-of-range per field', () => {
    expect(resolveHoloFraming('?scale=abc').faceScreenFrac).toBe(HOLO_BASE_FACE);
    expect(resolveHoloFraming('?scale=0').faceScreenFrac).toBe(HOLO_BASE_FACE); // >0 required (min 0.2)
    expect(resolveHoloFraming('?scale=9').faceScreenFrac).toBe(HOLO_BASE_FACE); // too big
    expect(resolveHoloFraming('?head=5').headScreenY).toBe(HOLO_DEFAULT_HEAD); // out of range
    expect(resolveHoloFraming('?head=-1').headScreenY).toBe(HOLO_DEFAULT_HEAD);
  });
});

describe('resolveHoloAvatarId', () => {
  it('returns null when no avatar param', () => {
    expect(resolveHoloAvatarId('')).toBeNull();
    expect(resolveHoloAvatarId('?scale=0.8&head=0.3')).toBeNull();
  });

  it('reads the id, with or without leading "?"', () => {
    expect(resolveHoloAvatarId('?avatar=shuangsheng-lite')).toBe('shuangsheng-lite');
    expect(resolveHoloAvatarId('avatar=ghostie')).toBe('ghostie');
  });

  it('coexists with the framing params (tsv 入口两者同时带)', () => {
    expect(resolveHoloAvatarId('?avatar=shuangsheng-lite&scale=0.9')).toBe('shuangsheng-lite');
    expect(resolveHoloFraming('?avatar=shuangsheng-lite&scale=0.5').faceScreenFrac)
      .toBeCloseTo(HOLO_BASE_FACE * 0.5);
  });

  it('treats blank/whitespace as absent (别把空串当角色 id 传下去)', () => {
    expect(resolveHoloAvatarId('?avatar=')).toBeNull();
    expect(resolveHoloAvatarId('?avatar=%20%20')).toBeNull();
  });
});

describe('resolveHoloNativeTargetFps', () => {
  it('lets the dedicated display entry cap native rendering at 24fps', () => {
    expect(resolveHoloNativeTargetFps('?avatar=shuangsheng-p20&fps=24')).toBe(24);
  });

  it('keeps the existing 60fps ceiling when fps is absent or invalid', () => {
    expect(resolveHoloNativeTargetFps('?avatar=shuangsheng-p20')).toBe(60);
    expect(resolveHoloNativeTargetFps('?fps=0')).toBe(60);
    expect(resolveHoloNativeTargetFps('?fps=abc')).toBe(60);
  });
});

describe('pickHoloAvatarId(10-21:仓库不带模型,可能一个形象都没有)', () => {
  const known = (id: string) => id === 'a' || id === 'b';
  it('指名且有 → 它;指名的没有 → 上次那个;上次那个也没了 → 列表第一个', () => {
    expect(pickHoloAvatarId({ forced: 'b', last: 'a', known, first: 'a' })).toBe('b');
    expect(pickHoloAvatarId({ forced: 'shuangsheng-p30', last: 'a', known, first: 'b' })).toBe('a');
    expect(pickHoloAvatarId({ forced: null, last: 'gone', known, first: 'b' })).toBe('b');
  });
  it('★一个形象都没有 → null(全息屏画粒子球,不白屏)', () => {
    expect(pickHoloAvatarId({ forced: 'shuangsheng-p30', last: 'shuangsheng', known: () => false, first: undefined })).toBeNull();
  });
});
