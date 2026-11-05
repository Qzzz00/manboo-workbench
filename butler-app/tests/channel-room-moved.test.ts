// 「电脑换房了,手机跟着搬」的那一道比对(2026-09-27,卡 RM ③)。
//
// 电脑登录之后会把自己挂到账号下,那一刻房间名从「名字那一间」换成「账号那一间」;
// 手机手上那张进房凭证是 7 天级的,还守着旧房间 —— 它进得去,只是里头没人:
// 电话打不进来,而屏上什么都不说。所以要比一比。
//
// 这一条要钉住的取舍只有一个:**缺一样就不判**。凭空判一次「搬房」会把一台好好的连接踢掉重连。
import { describe, expect, it } from 'vitest';
import { channelCallReadiness, channelRoomMoved } from '../src/api/call';

describe('channelRoomMoved', () => {
  it('两边都有、而且不一样 → 搬', () => {
    expect(channelRoomMoved('wb-66d1f29951443b3e', 'wb-ecbfc505ff978401')).toBe(true);
  });

  it('一样 → 不动', () => {
    expect(channelRoomMoved('wb-66d1f29951443b3e', 'wb-66d1f29951443b3e')).toBe(false);
  });

  it('电脑没报房间(老工作台 / 火山那条路)→ 不动', () => {
    expect(channelRoomMoved(undefined, 'wb-ecbfc505ff978401')).toBe(false);
    expect(channelRoomMoved('', 'wb-ecbfc505ff978401')).toBe(false);
    expect(channelRoomMoved(42, 'wb-ecbfc505ff978401')).toBe(false);
  });

  it('手机还没有凭证 → 不动(下一次要凭证时自然现取一张新的)', () => {
    expect(channelRoomMoved('wb-66d1f29951443b3e', undefined)).toBe(false);
    expect(channelRoomMoved('wb-66d1f29951443b3e', '')).toBe(false);
  });
});

describe('channelCallReadiness 把电脑报的房间原样带上来', () => {
  it('三样齐:能打,而且带着房间名', () => {
    expect(channelCallReadiness({ configured: true, server: true, worker: true, room: 'wb-66d1' }))
      .toEqual({ configured: true, checked: true, room: 'wb-66d1' });
  });

  /**
   * **打不了的时候更要带**:0927 那件事的现象正是「电脑说工人没在房」,
   * 而真相是手机在另一间房。缺了这一格,搬房那一下永远等不到时机。
   */
  it('工人不在房:照样带着房间名(那正是要比对的时候)', () => {
    const status = channelCallReadiness({ configured: true, server: true, worker: false, room: 'wb-66d1' });
    expect(status.configured).toBe(false);
    expect(status.room).toBe('wb-66d1');
  });

  it('老工作台不回房间:那一格缺席,不编', () => {
    expect(channelCallReadiness({ configured: true, server: true, worker: true }).room).toBeUndefined();
  });
});
