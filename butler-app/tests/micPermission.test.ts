/**
 * 录音权限(2026-09-18,Ben 真机:「没有去要录音的权限,我说话它听不到」)。
 *
 * 两条实现要各自验到:原生那件小插件(能分清「还问得动」和「别再问了」),
 * 以及退路 getUserMedia(浏览器里调试、插件没登记上时)。
 */
import { describe, expect, it, vi } from 'vitest';
import { ensureMicPermission, openMicSettings, MIC_DENIED_TEXT } from '../src/call/micPermission';

function native(over: Partial<{
  check: () => Promise<{ state?: string; granted?: boolean }>;
  request: () => Promise<{ state?: string; granted?: boolean }>;
  openSettings: () => Promise<void>;
}> = {}) {
  return {
    check: over.check ?? (async () => ({ state: 'prompt', granted: false })),
    request: over.request ?? (async () => ({ state: 'granted', granted: true })),
    openSettings: over.openSettings ?? (async () => {}),
  };
}

describe('ensureMicPermission:原生那条', () => {
  it('已经给过了就不再问一遍(不打扰)', async () => {
    const request = vi.fn(async () => ({ state: 'granted', granted: true }));
    const result = await ensureMicPermission({ native: native({ check: async () => ({ state: 'granted', granted: true }), request }) });
    expect(result).toMatchObject({ granted: true, needsSettings: false, via: 'native' });
    expect(request).not.toHaveBeenCalled();
  });

  it('没问过就问一次;给了就是 granted', async () => {
    const result = await ensureMicPermission({ native: native() });
    expect(result).toMatchObject({ state: 'granted', granted: true, needsSettings: false });
  });

  it('**被永久拒**(denied)才给「去设置里开」那条路', async () => {
    const result = await ensureMicPermission({ native: native({ request: async () => ({ state: 'denied', granted: false }) }) });
    expect(result).toMatchObject({ state: 'denied', granted: false, needsSettings: true });
  });

  it('这一次拒了但还问得动(prompt):不送人去系统设置——那是多此一举', async () => {
    const result = await ensureMicPermission({ native: native({ request: async () => ({ state: 'prompt', granted: false }) }) });
    expect(result).toMatchObject({ state: 'prompt', granted: false, needsSettings: false });
  });

  it('插件没登记上(装的是旧包 / 跑在浏览器里):退回 getUserMedia,不在这儿放弃', async () => {
    const stop = vi.fn();
    const result = await ensureMicPermission({
      native: native({ check: async () => { throw new Error('not implemented'); } }),
      getUserMedia: async () => ({ getTracks: () => [{ stop }] }) as unknown as MediaStream,
    });
    expect(result).toMatchObject({ granted: true, via: 'getUserMedia' });
    // 只为要权限,不为录音:拿到就停,别让红点一直亮着。
    expect(stop).toHaveBeenCalled();
  });
});

describe('ensureMicPermission:退路那条', () => {
  it('人拒了(NotAllowedError)→ denied + 去设置', async () => {
    const error = Object.assign(new Error('Permission denied'), { name: 'NotAllowedError' });
    const result = await ensureMicPermission({ native: null, getUserMedia: async () => { throw error; } });
    expect(result).toMatchObject({ state: 'denied', granted: false, needsSettings: true, via: 'getUserMedia' });
  });

  it('**没有麦克风**不该被说成「去设置里打开」(那条路修不好这件事)', async () => {
    const error = Object.assign(new Error('Requested device not found'), { name: 'NotFoundError' });
    const result = await ensureMicPermission({ native: null, getUserMedia: async () => { throw error; } });
    expect(result).toMatchObject({ state: 'unknown', granted: false, needsSettings: false });
    expect(String(result.error)).toContain('not found');
  });

  it('连 mediaDevices 都没有:如实说一句,**不抛**', async () => {
    const result = await ensureMicPermission({ native: null, getUserMedia: null });
    expect(result).toMatchObject({ granted: false, via: 'none' });
    expect(String(result.error)).toContain('mediaDevices');
  });
});

describe('openMicSettings', () => {
  it('打得开就说好了', async () => {
    await expect(openMicSettings({ native: native() })).resolves.toEqual({ ok: true });
  });

  it('打不开就把原话交出去,不吞', async () => {
    const result = await openMicSettings({ native: native({ openSettings: async () => { throw new Error('没有这个 Activity'); } }) });
    expect(result).toEqual({ ok: false, error: '没有这个 Activity' });
  });

  it('浏览器里压根没有这条路', async () => {
    const result = await openMicSettings({ native: null });
    expect(result).toMatchObject({ ok: false });
  });
});

describe('那句话', () => {
  it('说的是「她听不到你」,不是「静音」——后果必须说清', () => {
    expect(MIC_DENIED_TEXT).toBe('没有录音权限,事务官听不到你');
  });
});
