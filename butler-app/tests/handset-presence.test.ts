// 「座机在不在线」那一行 + 「记到了谁名下」那一句(2026-09-27,卡 RM ①②)。
//
// 两条判断各有一个很容易写糊的地方,所以都单独钉住:
//   ① **问不到 ≠ 不在线** —— 那一行整句不出,写「不在线」是假话,会让人把配好的再配一遍;
//   ② 电脑没回名字就说老那句话,**不编一个电脑名**。
import { describe, expect, it } from 'vitest';
import { HANDSET_PRESENCE_UNKNOWN, handsetPresenceOf } from '../src/handset/handsetPresence';
import { handsetBoundText } from '../src/handset/handsetLink';
import type { WbchDevice } from '../src/channel/devices';

const handset = (name: string): WbchDevice => ({
  identity: 'wb-phone-handset-4b4a', device_id: 'handset-4b4a', name, kind: 'handset',
});

describe('handsetPresenceOf', () => {
  it('有一只在线:说出它的名字,「添加座机」退成次要', () => {
    const presence = handsetPresenceOf({ devices: [handset('客厅话筒')] });
    expect(presence.hasHandset).toBe(true);
    expect(presence.line).toContain('客厅话筒');
    expect(presence.line).toContain('在线');
  });

  it('问到了、一只都没有:说「不在线」,并说清什么时候会变', () => {
    const presence = handsetPresenceOf({ devices: [] });
    expect(presence.hasHandset).toBe(false);
    expect(presence.line).toContain('不在线');
  });

  it('**问不到**(工人掉线 / 连不上电脑):整行不出 —— 不拿一句假话冒充「不在线」', () => {
    expect(handsetPresenceOf({ devices: [], note: '工人还没报过在线设备' })).toEqual(HANDSET_PRESENCE_UNKNOWN);
  });

  it('电脑与手机在线、座机不在:照样算「座机不在线」(只看 handset 那一类)', () => {
    const others: WbchDevice[] = [
      { identity: 'wb-channel-worker', device_id: 'mac-1', name: 'Ben 的 Mac', kind: 'mac' },
      { identity: 'wb-phone-1', device_id: 'phone-1', name: '小米', kind: 'phone' },
    ];
    expect(handsetPresenceOf({ devices: others }).hasHandset).toBe(false);
  });
});

describe('handsetBoundText', () => {
  it('两样都有:「记到了 <电脑名> · <账号名> 下」', () => {
    expect(handsetBoundText({ computer: 'Ben 的 MacBook', account: 'ben@x.com' }))
      .toBe('记到了 Ben 的 MacBook · ben@x.com 下。');
  });

  it('只有电脑名:也照样说得出(账号那一格不编)', () => {
    expect(handsetBoundText({ computer: 'Ben 的 MacBook' })).toBe('记到了 Ben 的 MacBook 下。');
  });

  it('什么都没有(手机自己领的那条路 / 老电脑):整句不出,由调用方说老那句话', () => {
    expect(handsetBoundText(undefined)).toBeUndefined();
    expect(handsetBoundText({})).toBeUndefined();
    expect(handsetBoundText({ computer: '   ' })).toBeUndefined();
  });
});
