/**
 * 手机这一侧的设备间传文件(2026-09-21):在线设备表、传输记录、点名发。
 */
import { describe, expect, it } from 'vitest';
import {
  fetchWbchDevices,
  fetchWbchTransfers,
  parseWbchDevice,
  wbchKindText,
  wbchSizeText,
  wbchTransferLine,
  wbchLocalWhen,
} from '../src/channel/devices';
import type { ApiClient } from '../src/api/client';
import { createWbchChannel } from '../src/channel/channel';
import { WBCH_FILE_TOPIC } from '../src/channel/channelProtocol';
import { createFakeLink, fakeCredential, memoryStore } from './wbchFakes';
import { createWbchCredentialStore } from '../src/channel/credentialStore';

function fakeClient(answers: Record<string, unknown>, fail?: string): ApiClient {
  return {
    baseUrl: 'http://127.0.0.1:8791',
    async json<T>(path: string) {
      if (fail !== undefined) return { ok: false as const, error: fail, kind: 'network' as const };
      return { ok: true as const, data: (answers[path] ?? {}) as T };
    },
    async blob() { return { ok: false as const, error: '用例不给二进制', kind: 'network' as const }; },
  } as unknown as ApiClient;
}

describe('在线设备表', () => {
  it('**把自己去掉**:发给自己没有意义,工人也只会原样兜回来', async () => {
    const client = fakeClient({
      '/devices/online': {
        devices: [
          { identity: 'wb-phone-dev1', device_id: 'dev1', name: '这台手机', kind: 'phone' },
          { identity: 'wb-channel-worker', device_id: 'mac-a', name: '书房 Mac', kind: 'mac' },
        ],
      },
    });
    const result = await fetchWbchDevices(client, 'wb-phone-dev1');
    expect(result.devices.map((d) => d.name)).toEqual(['书房 Mac']);
  });

  it('认不出来的条目丢掉,不往选单里塞垃圾', () => {
    expect(parseWbchDevice({ identity: 'x' })).toBeNull();
    expect(parseWbchDevice({ kind: 'mac' })).toBeNull();
    expect(parseWbchDevice('一个字符串')).toBeNull();
    expect(parseWbchDevice({ identity: 'wb-phone-1', kind: 'phone' })?.name).toBe('wb-phone-1');
  });

  it('问不到就把那句话带回来,**不拿空列表冒充「没有别的设备」**', async () => {
    const result = await fetchWbchDevices(fakeClient({}, '连不上工作台'), null);
    expect(result.devices).toEqual([]);
    expect(result.note).toBe('连不上工作台');
  });

  it('表旧了那句 note 原样带回来', async () => {
    const client = fakeClient({ '/devices/online': { devices: [], stale: true, note: '工人可能掉线了' } });
    expect((await fetchWbchDevices(client, null)).note).toBe('工人可能掉线了');
  });
});

describe('传输记录', () => {
  it('一条记录念出来是人话;坏行跳过', async () => {
    const client = fakeClient({
      '/devices/transfers': {
        records: [
          { at: '2026-09-21T10:11:12.000Z', direction: 'out', peer: '书房 Mac', name: 'README.md', bytes: 2048, ok: true },
          { name: '缺方向' },
        ],
      },
    });
    const records = await fetchWbchTransfers(client);
    expect(records).toHaveLength(1);
    // 时刻按手机本地时区显示(2026-09-25 卡 J:以前显示的是 UTC)。
    expect(wbchTransferLine(records[0]!)).toBe(`${wbchLocalWhen('2026-09-21T10:11:12.000Z')} 发给 书房 Mac:README.md 2.0 KB`);
  });

  it('大小说成人话', () => {
    expect(wbchSizeText(10)).toBe('10 字节');
    expect(wbchSizeText(2048)).toBe('2.0 KB');
    expect(wbchSizeText(5 * 1024 * 1024)).toBe('5.0 MB');
    expect(wbchSizeText(Number.NaN)).toBe('大小不详');
    expect(wbchKindText('mac')).toBe('电脑');
  });
});

describe('点名发', () => {
  async function channelWith() {
    const link = createFakeLink();
    const store = createWbchCredentialStore(memoryStore({ 'butler.channel': JSON.stringify(fakeCredential()) }));
    const channel = createWbchChannel({
      direct: fakeClient({}),
      store,
      onUnauthorized: () => {},
      link,
    });
    return { channel, link };
  }

  it('给了目标就只发那一台;不给就照旧广播', async () => {
    const { channel, link } = await channelWith();
    await channel.sendFile(new File(['x'], 'a.txt'), 'wb-channel-worker-b');
    await channel.sendFile(new File(['x'], 'b.txt'));
    expect(link.files).toEqual([
      { name: 'a.txt', topic: WBCH_FILE_TOPIC, to: 'wb-channel-worker-b' },
      { name: 'b.txt', topic: WBCH_FILE_TOPIC, to: undefined },
    ]);
  });

  it('发完把房间放掉(不顶掉通话那一份持有)', async () => {
    const { channel, link } = await channelWith();
    await channel.sendFile(new File(['x'], 'a.txt'), 'wb-channel-worker');
    expect([...link.holders]).toEqual([]);
  });
});
