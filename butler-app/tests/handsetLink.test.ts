/**
 * 「添加座机」最后一步的两条路(2026-09-27,卡 HS)。
 *
 * 现场:维护者 12:50 走完蓝牙、选了 Wi-Fi、输了密码,最后一步失败 ——
 * 「这台手机还没登录账号,没法把座机记到账号下」。根因不是他漏了一步:
 * **扫码配对的手机按设计就没有账号会话**(密码只在电脑上)。于是这一份盯:
 *
 *   1. 手机自己登录过 → 自己去中转领,报 kind=handset(老路一个字没改);
 *   2. 没登录 → **请电脑代办**(`POST /channel/relay-handset`),令牌从电脑回来;
 *   3. 三种失败三句不同的话:电脑没登录(电脑那句原样带上来)/ 联系不上电脑 / 回来的内容缺字段;
 *   4. 每一句失败的话里都说「网不用重配」—— 那一步已经做完了,不该把人打回第一步。
 */
import { describe, expect, it, vi } from 'vitest';
import { issueHandsetToken } from '../src/handset/handsetLink';
import { TEXT } from '../src/handset/provisionProtocol';
import type { AccountRecord, AccountStore } from '../src/account/accountStore';
import type { ApiResult } from '../src/api/client';

const HANDSET = 'handset-3f2a7c91b04d4e0f';

function fakeStore(record: AccountRecord | null): AccountStore {
  return {
    async load() { return record; },
    async save() {}, async setDeviceToken() {}, async link() {}, async clear() {},
  };
}

/** 一个只回一条结果的假 8791 客户端。`calls` 让用例看得见发了什么(**没有令牌**)。 */
function fakeClient(result: ApiResult<unknown>) {
  const calls: { path: string; body: unknown }[] = [];
  return {
    calls,
    client: {
      json: async (path: string, options?: { body?: unknown }) => {
        calls.push({ path, body: options?.body });
        return result as ApiResult<never>;
      },
    },
  };
}

describe('手机自己登录过账号', () => {
  it('自己去中转领,报的种类是 handset', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ token: 'wb_handset_secret' }), {
      status: 200, headers: { 'content-type': 'application/json' },
    })) as unknown as typeof fetch;
    const asked = fakeClient({ ok: true, status: 200, data: {} });
    const issued = await issueHandsetToken({
      store: fakeStore({ relayUrl: 'https://api.aibooo.cn', deviceId: 'phone-1', sessionToken: 'wbs_secret' }),
      client: asked.client,
      deviceId: HANDSET,
      name: '工作台座机-9A4C',
      fetchImpl,
    });
    expect(issued).toEqual({ ok: true, relayUrl: 'https://api.aibooo.cn', token: 'wb_handset_secret' });
    const [url, init] = (fetchImpl as unknown as { mock: { calls: [string, RequestInit][] } }).mock.calls[0]!;
    expect(url).toBe('https://api.aibooo.cn/register-device');
    expect(JSON.parse(String(init.body))).toMatchObject({ device_id: HANDSET, kind: 'handset' });
    // 有会话就**不去麻烦电脑**。
    expect(asked.calls).toHaveLength(0);
  });
});

describe('手机没登录账号(扫码配对进来的那种)', () => {
  it('★ 请电脑代办,令牌与中转地址从电脑回来', async () => {
    const asked = fakeClient({
      ok: true, status: 200,
      data: { relay_url: 'https://api.aibooo.cn', token: 'wb_handset_secret', device_id: HANDSET },
    });
    const issued = await issueHandsetToken({
      store: fakeStore(null), client: asked.client, deviceId: HANDSET, name: '工作台座机-9A4C',
    });
    expect(issued).toEqual({ ok: true, relayUrl: 'https://api.aibooo.cn', token: 'wb_handset_secret' });
    expect(asked.calls).toEqual([{
      path: '/channel/relay-handset',
      body: { device_id: HANDSET, name: '工作台座机-9A4C' },
    }]);
  });

  it('电脑上也没登录账号(409):**电脑那句话原样带上来**,并补一句网不用重配', async () => {
    const asked = fakeClient({
      ok: false, status: 409, kind: 'http',
      error: '这台电脑上还没登录账号,记不了座机。在电脑的工作台里登录一次,再回手机上点「重试记账号」。',
    });
    const issued = await issueHandsetToken({ store: fakeStore(null), client: asked.client, deviceId: HANDSET, name: '座机' });
    expect(issued.ok).toBe(false);
    if (issued.ok) return;
    expect(issued.error).toContain('在电脑的工作台里登录一次');
    expect(issued.error).toContain('不用重配');
  });

  it('联系不上电脑:说的是「等电脑开着再重试」,不是「去登录」', async () => {
    const asked = fakeClient({ ok: false, status: 0, kind: 'network', error: '连不上工作台' });
    const issued = await issueHandsetToken({ store: fakeStore(null), client: asked.client, deviceId: HANDSET, name: '座机' });
    expect(issued).toEqual({ ok: false, error: TEXT.linkNoComputer });
    expect(TEXT.linkNoComputer).toContain('重试记账号');
    expect(TEXT.linkNoComputer).toContain('不用重配');
  });

  it('电脑不认这台手机了(401):说的是重新扫码配对', async () => {
    const asked = fakeClient({ ok: false, status: 401, kind: 'unauthorized', error: '令牌失效' });
    const issued = await issueHandsetToken({ store: fakeStore(null), client: asked.client, deviceId: HANDSET, name: '座机' });
    expect(issued).toEqual({ ok: false, error: TEXT.linkNotPaired });
    expect(TEXT.linkNotPaired).toContain('配对');
  });

  it('电脑回来的内容缺字段:**不把半把钥匙交给座机**', async () => {
    const asked = fakeClient({ ok: true, status: 200, data: { relay_url: 'https://api.aibooo.cn' } });
    const issued = await issueHandsetToken({ store: fakeStore(null), client: asked.client, deviceId: HANDSET, name: '座机' });
    expect(issued).toEqual({ ok: false, error: TEXT.linkRelayBad });
  });

  it('连 8791 的客户端都没有(老的假 Session):退回那句「先在设置里登录」', async () => {
    const issued = await issueHandsetToken({ store: fakeStore(null), deviceId: HANDSET, name: '座机' });
    expect(issued).toEqual({ ok: false, error: TEXT.needAccount });
  });
});
