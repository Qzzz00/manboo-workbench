import { describe, expect, it } from 'vitest';
import {
  absoluteFramingFor,
  resolveDjFraming,
  resolveHomeFraming,
  resolveLoginFraming,
  IDENTITY_DELTA,
} from './mobileTransform.ts';

describe('resolveHomeFraming / resolveLoginFraming / resolveDjFraming 回落链（方案 B 语义）', () => {
  const full = { scale: 0.7, offsetX: 0.1, offsetY: -0.98 };
  const loginOnly = { scale: 0.9, offsetX: -0.2, offsetY: -0.7 };
  const djOnly = { scale: 0.6, offsetX: 0, offsetY: -1.15 };

  it('homeFraming 三项齐全 → 返回该绝对构图（带 absolute 标志）', () => {
    const out = resolveHomeFraming({ homeFraming: full });
    expect(out.scale).toBe(0.7);
    expect(out.offsetX).toBe(0.1);
    expect(out.offsetY).toBe(-0.98);
    expect(out.absolute).toBe(true);
  });

  it('homeFraming 缺失 → 回落 IDENTITY_DELTA（无 absolute 标志）', () => {
    const out = resolveHomeFraming({});
    expect(out).toBe(IDENTITY_DELTA);
    expect(out.absolute).toBeUndefined();
  });

  it('loginFraming 优先于 homeFraming', () => {
    const out = resolveLoginFraming({ loginFraming: loginOnly, homeFraming: full });
    expect(out.scale).toBe(0.9);
    expect(out.offsetX).toBe(-0.2);
    expect(out.offsetY).toBe(-0.7);
    expect(out.absolute).toBe(true);
  });

  it('loginFraming 缺失 → 逐级回落 homeFraming', () => {
    const out = resolveLoginFraming({ homeFraming: full });
    expect(out.scale).toBe(0.7);
    expect(out.offsetX).toBe(0.1);
    expect(out.offsetY).toBe(-0.98);
    expect(out.absolute).toBe(true);
  });

  it('loginFraming 与 homeFraming 都缺失 → 回落 IDENTITY_DELTA', () => {
    const out = resolveLoginFraming({});
    expect(out).toBe(IDENTITY_DELTA);
    expect(out.absolute).toBeUndefined();
  });

  it('djFraming 三项齐全 → 返回该绝对构图；缺失 → IDENTITY_DELTA', () => {
    const configured = resolveDjFraming({ djFraming: djOnly });
    expect(configured.scale).toBe(0.6);
    expect(configured.offsetY).toBe(-1.15);
    expect(configured.absolute).toBe(true);

    const missing = resolveDjFraming({});
    expect(missing).toBe(IDENTITY_DELTA);
    expect(missing.absolute).toBeUndefined();
  });

  it('absoluteFramingFor 同一 framing 对象缓存同一引用（避免 React 重渲染反复 refit）', () => {
    const framing = { scale: 0.7, offsetX: 0, offsetY: -0.98 };
    expect(absoluteFramingFor(framing)).toBe(absoluteFramingFor(framing));
    expect(absoluteFramingFor(undefined)).toBeUndefined();
  });
});
