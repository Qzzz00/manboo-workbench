import { describe, it, expect, vi } from 'vitest';
import { acceptFullscreenCall } from './fullscreenAccept.ts';

function deps() {
  return {
    startCall: vi.fn(),
    armPendingCall: vi.fn(),
    switchAvatar: vi.fn(),
  };
}

describe('acceptFullscreenCall', () => {
  it('目标=当前角色：直接 startCall，不 arm pending 不切角色（handleAvatarChange 会早退，pending 会永久悬挂）', () => {
    const d = deps();
    acceptFullscreenCall('estella', 'estella', d);
    expect(d.startCall).toHaveBeenCalledTimes(1);
    expect(d.armPendingCall).not.toHaveBeenCalled();
    expect(d.switchAvatar).not.toHaveBeenCalled();
  });

  it('目标≠当前角色：先 arm pending 再切角色，不直接 startCall（等 switching 结束由 effect 拉起）', () => {
    const d = deps();
    acceptFullscreenCall('yumi', 'estella', d);
    expect(d.armPendingCall).toHaveBeenCalledTimes(1);
    expect(d.switchAvatar).toHaveBeenCalledWith('yumi');
    expect(d.startCall).not.toHaveBeenCalled();
    // arm 必须先于 switch：切换极快完成时 effect 才能看到已 arm 的 pending
    expect(d.armPendingCall.mock.invocationCallOrder[0]).toBeLessThan(d.switchAvatar.mock.invocationCallOrder[0]);
  });
});
