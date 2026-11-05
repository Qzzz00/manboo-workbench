/**
 * 「**座机在不在线**」那一行(2026-09-27,卡 RM ①)。
 *
 * 为什么要它:维护者 09-27 在小米上走完「添加座机」六步,屏上写着「座机已上线 /
 * 已经记到你的账号下」;回到设置页却只剩一颗「添加座机」—— 那颗键是常驻入口、不看
 * 座机在不在,页面上没有任何一行说「已添加」。他当成白配了
 * (docs/交接-0927-座机进错房间.md 第一节第 3 条)。
 *
 * 判断在这里、是纯函数,因为它的取舍只有一条但很容易写糊:
 * **问不到 ≠ 不在线**。问不到时这一行整句不出 —— 写「座机不在线」是假的,
 * 而那句假话会让他把已经配好的再配一遍。
 */
import { useEffect, useState } from 'react';
import { useSession } from '../session';
import { fetchWbchDevices, type WbchDevice } from '../channel/devices';

/** 多久问一次。与 SwitchNetworkPage 那一处同一个数量级(设置页不必更勤)。 */
export const HANDSET_PRESENCE_POLL_MS = 15_000;

export interface HandsetPresence {
  /** 屏上那一行。**问不到就是 null**(整行不出)。 */
  line: string | null;
  /** 此刻有一只座机在线。「添加座机」那颗键据此退成次要样式。 */
  hasHandset: boolean;
}

/** 问不到时的那一份。**什么都不说**。 */
export const HANDSET_PRESENCE_UNKNOWN: HandsetPresence = { line: null, hasHandset: false };

/**
 * 在线设备表里的座机 → 那一行。
 *
 * - 有一只:`座机「客厅话筒」在线`(名字原样,它是他自己起的);
 * - 一只都没有、**而且这一问是成功的**:`座机不在线(通上电、连上 Wi-Fi 之后这里会变)`;
 * - 这一问没成(`note` 有话):整行不出。
 */
export function handsetPresenceOf(input: { devices: readonly WbchDevice[]; note?: string }): HandsetPresence {
  const one = input.devices.find(device => device.kind === 'handset');
  if (one !== undefined) return { line: `座机「${one.name}」在线`, hasHandset: true };
  // 问不到(工人掉线 / 连不上电脑)。**不说「不在线」**,那是假话。
  if (input.note !== undefined && input.note !== '') return HANDSET_PRESENCE_UNKNOWN;
  return { line: '座机不在线(通上电、连上 Wi-Fi 之后这里会变)', hasHandset: false };
}

/** 设置页那一节用的那一份。**永不抛**:问不到就什么都不说。 */
export function useHandsetPresence(): HandsetPresence {
  const session = useSession();
  const [presence, setPresence] = useState<HandsetPresence>(HANDSET_PRESENCE_UNKNOWN);

  useEffect(() => {
    let alive = true;
    const look = async () => {
      try {
        const self = session.channel.credential()?.identity ?? null;
        const got = await fetchWbchDevices(session.client, self, { kinds: ['handset'] });
        if (alive) setPresence(handsetPresenceOf(got));
      }
      catch { if (alive) setPresence(HANDSET_PRESENCE_UNKNOWN); }
    };
    void look();
    const timer = setInterval(() => { void look(); }, HANDSET_PRESENCE_POLL_MS);
    return () => { alive = false; clearInterval(timer); };
  }, [session]);

  return presence;
}
