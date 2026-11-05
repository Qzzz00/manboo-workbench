/**
 * 「添加座机」那一页,用**假座机**走一遍六步(2026-09-22)。
 *
 * 假的只有两样:BLE 那一层(`HandsetBle` 的四个方法)与中转那一个请求。
 * 走的是真的 `provisionMachine` + 真的 `AddHandsetPage` —— 一份抄得像的流程
 * 只能证明抄得对,证明不了真机上那个对(同 phone-bridge/dev 那条老规矩)。
 *
 * **没有真机**:手机没有、派也没有。这一份验的是"界面按状态该显示什么、该发什么命令",
 * 验不了"BLE 到底连不连得上"。手工验证步骤写在 docs/交接-0922-座机配网走App.md 第六节。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen, fireEvent, waitFor } from '@testing-library/react';
import { AddHandsetPage, networkLine } from '../src/handset/AddHandsetPage';
import type { HandsetBle } from '../src/handset/handsetBle';
import type { HandsetNetwork, HandsetStatus } from '../src/handset/provisionProtocol';
import { SessionContext, type Session } from '../src/session';
import type { AccountRecord, AccountStore } from '../src/account/accountStore';

function fakeAccount(record: AccountRecord | null): AccountStore {
  return {
    async load() { return record; },
    async save() {}, async setDeviceToken() {}, async link() {}, async clear() {},
  };
}

const ACCOUNT: AccountRecord = {
  relayUrl: 'https://api.aibooo.cn',
  deviceId: 'phone-1',
  sessionToken: 'wbs_secret',
};

function net(over: Partial<HandsetNetwork> = {}): HandsetNetwork {
  return { ssid: 'VR_GUEST', signal: 70, security: 'WPA2', inUse: false, saved: false, ...over };
}

function status(over: Partial<HandsetStatus> = {}): HandsetStatus {
  return {
    phase: 'waiting', text: '', ssid: '', ip: '', error: '', linked: false,
    deviceId: 'handset-3f2a7c91b04d4e0f', name: '工作台座机-9A4C', ...over,
  };
}

/** 一台假座机。`hand`/`handNetworks` 让用例从外面把状态推进来。 */
function fakeBle() {
  const sent: unknown[] = [];
  let pushStatus: ((one: HandsetStatus) => void) | null = null;
  let pushNetworks: ((list: readonly HandsetNetwork[]) => void) | null = null;
  let onFound: ((devices: readonly { id: string; name: string }[]) => void) | null = null;
  const ble: HandsetBle & { sent: unknown[] } = {
    sent,
    async scan(cb) { onFound = cb; },
    async stopScan() {},
    async connect({ onStatus, onNetworks }) { pushStatus = onStatus; pushNetworks = onNetworks; },
    async send(_id, command) { sent.push(command); },
    async disconnect() {},
  };
  return {
    ble,
    sent,
    found: (devices: { id: string; name: string }[]) => act(() => { onFound?.(devices); }),
    status: (one: HandsetStatus) => act(() => { pushStatus?.(one); }),
    networks: (list: HandsetNetwork[]) => act(() => { pushNetworks?.(list); }),
  };
}

/**
 * `account` 必须显式传 —— **不给默认值**:JS 的默认参数在显式传 `undefined` 时照样生效,
 * 于是"没登录账号"那一条用例会悄悄拿到一个登录着的账号,断言全绿而验的不是那件事。
 */
function mount(ble: HandsetBle, account: AccountStore | undefined, client?: Session['client']) {
  const session = { account, ...(client === undefined ? {} : { client }) } as unknown as Session;
  return render(
    <SessionContext.Provider value={session}>
      <AddHandsetPage ble={ble} onClose={() => {}} phoneSsid="我家" />
    </SessionContext.Provider>,
  );
}

afterEach(() => { vi.unstubAllGlobals(); });

describe('六步走一遍(假座机)', () => {
  it('找到 → 选网 → 输密码 → 连上 → 进房 → 已上线', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ token: 'wb_handset_secret' }), {
      status: 200, headers: { 'content-type': 'application/json' },
    }));
    vi.stubGlobal('fetch', fetchImpl);

    const fake = fakeBle();
    mount(fake.ble, fakeAccount(ACCOUNT));

    expect(screen.getByText(/正在找附近的座机/)).toBeTruthy();
    await fake.found([{ id: 'AA:BB', name: '工作台座机-9A4C' }]);
    fireEvent.click(screen.getByText('工作台座机-9A4C'));

    // 连上之后一次问两样。
    await waitFor(() => expect(fake.sent).toEqual([{ op: 'status' }, { op: 'scan' }]));
    await fake.networks([net(), net({ ssid: '我家', signal: 30 })]);

    // **手机连着的那个排最前**(Ben 的原话)。
    const buttons = screen.getAllByRole('button').map((b) => b.textContent ?? '');
    const wifi = buttons.filter((t) => t.includes('我家') || t.includes('VR_GUEST'));
    expect(wifi[0]).toContain('我家');

    fireEvent.click(screen.getByText(new RegExp('^VR_GUEST')));
    fireEvent.change(screen.getByLabelText('Wi-Fi 密码'), { target: { value: '开门芝麻' } });
    fireEvent.click(screen.getByText('连接'));
    await waitFor(() => expect(fake.sent).toContainEqual({ op: 'connect', ssid: 'VR_GUEST', psk: '开门芝麻' }));

    await fake.status(status({ phase: 'online', ssid: 'VR_GUEST', text: '座机连上 VR_GUEST 了' }));
    // 连上就自动进配对那一步:去中转换一张**给座机的**设备令牌,再经 BLE 交下去。
    await waitFor(() => expect(fetchImpl).toHaveBeenCalled());
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://api.aibooo.cn/register-device');
    expect(JSON.parse(String(init.body))).toEqual({
      device_id: 'handset-3f2a7c91b04d4e0f',
      /**
       * ★ **报 `handset`**(2026-09-23)。中转按注册时这一列签进房凭证的 `wb_kind`
       * (relay/server/channel.cjs 的 `channelKindAttributeOf`),报 `other` 的它一个字不动 ——
       * 于是 BLE 配网出来的那只话筒经中转进房时会被工人当成手机,声音走错端。
       */
      kind: 'handset',
      name: '工作台座机-9A4C',
    });
    await waitFor(() => expect(fake.sent).toContainEqual({
      op: 'link', relay: 'https://api.aibooo.cn', token: 'wb_handset_secret',
      device_id: 'handset-3f2a7c91b04d4e0f', name: '工作台座机-9A4C',
    }));

    await fake.status(status({ phase: 'online', ssid: 'VR_GUEST', linked: true }));
    expect(screen.getByText('座机已上线')).toBeTruthy();
    expect(screen.getByText(/它连着 VR_GUEST/)).toBeTruthy();
  });

  it('密码那一栏默认是遮着的,可以点开看', async () => {
    const fake = fakeBle();
    mount(fake.ble, fakeAccount(ACCOUNT));
    await fake.found([{ id: 'AA:BB', name: '工作台座机-9A4C' }]);
    fireEvent.click(screen.getByText('工作台座机-9A4C'));
    await waitFor(() => expect(fake.sent.length).toBe(2));
    await fake.networks([net()]);
    fireEvent.click(screen.getByText(new RegExp('^VR_GUEST')));

    const input = screen.getByLabelText('Wi-Fi 密码') as HTMLInputElement;
    expect(input.type).toBe('password');
    fireEvent.click(screen.getByText('显示密码'));
    expect((screen.getByLabelText('Wi-Fi 密码') as HTMLInputElement).type).toBe('text');
  });
});

describe('失败分支', () => {
  it('没登录账号时不去发那个请求,并且说清去哪儿登录', async () => {
    const fetchImpl = vi.fn();
    vi.stubGlobal('fetch', fetchImpl);
    const fake = fakeBle();
    mount(fake.ble, undefined);

    await fake.found([{ id: 'AA:BB', name: '工作台座机-9A4C' }]);
    fireEvent.click(screen.getByText('工作台座机-9A4C'));
    await waitFor(() => expect(fake.sent.length).toBe(2));
    await fake.networks([net()]);
    fireEvent.click(screen.getByText(new RegExp('^VR_GUEST')));
    fireEvent.click(screen.getByText('连接'));
    await fake.status(status({ phase: 'online', ssid: 'VR_GUEST' }));

    await waitFor(() => expect(screen.getByText(/先在设置里登录一次/)).toBeTruthy());
    expect(fetchImpl).not.toHaveBeenCalled();
    // ★ 重试那颗键说的是「网不用重配」—— 网已经配好了,不该把人打回第一步。
    expect(screen.getByText(/网不用重配/)).toBeTruthy();
  });

  /**
   * ★ 卡 HS(2026-09-27):**扫码配对的手机没有账号会话,这一步请电脑代办**。
   * 现场是维护者 12:50 走完蓝牙与 Wi-Fi,最后一步死在「这台手机还没登录账号」。
   */
  it('★ 手机没登录账号:请电脑代办,拿回来的令牌照旧经 BLE 交给座机', async () => {
    const fetchImpl = vi.fn();
    vi.stubGlobal('fetch', fetchImpl);
    const asked: { path: string; body: unknown }[] = [];
    const client = {
      json: async (path: string, options?: { body?: unknown }) => {
        asked.push({ path, body: options?.body });
        return {
          ok: true as const, status: 200,
          data: { relay_url: 'https://api.aibooo.cn', token: 'wb_handset_secret', device_id: 'handset-3f2a7c91b04d4e0f' },
        };
      },
    } as unknown as Session['client'];

    const fake = fakeBle();
    mount(fake.ble, undefined, client);
    await fake.found([{ id: 'AA:BB', name: '工作台座机-9A4C' }]);
    fireEvent.click(screen.getByText('工作台座机-9A4C'));
    await waitFor(() => expect(fake.sent.length).toBe(2));
    await fake.networks([net()]);
    fireEvent.click(screen.getByText(new RegExp('^VR_GUEST')));
    fireEvent.click(screen.getByText('连接'));
    await fake.status(status({ phase: 'online', ssid: 'VR_GUEST' }));

    await waitFor(() => expect(asked).toEqual([{
      path: '/channel/relay-handset',
      body: { device_id: 'handset-3f2a7c91b04d4e0f', name: '工作台座机-9A4C' },
    }]));
    // 手机自己**没有**去中转(它没有账号会话,去了也是白跑)。
    expect(fetchImpl).not.toHaveBeenCalled();
    await waitFor(() => expect(fake.sent).toContainEqual({
      op: 'link', relay: 'https://api.aibooo.cn', token: 'wb_handset_secret',
      device_id: 'handset-3f2a7c91b04d4e0f', name: '工作台座机-9A4C',
    }));
    await fake.status(status({ phase: 'online', ssid: 'VR_GUEST', linked: true }));
    expect(screen.getByText('座机已上线')).toBeTruthy();
  });

  it('★ 电脑那头没登录账号:原样说电脑那句话,而且**只退到「重试记账号」**(不回第一步)', async () => {
    const client = {
      json: async () => ({
        ok: false as const, status: 409, kind: 'http' as const,
        error: '这台电脑上还没登录账号,记不了座机。在电脑的工作台里登录一次,再回手机上点「重试记账号」。',
      }),
    } as unknown as Session['client'];
    const fake = fakeBle();
    mount(fake.ble, undefined, client);
    await fake.found([{ id: 'AA:BB', name: '工作台座机-9A4C' }]);
    fireEvent.click(screen.getByText('工作台座机-9A4C'));
    await waitFor(() => expect(fake.sent.length).toBe(2));
    await fake.networks([net()]);
    fireEvent.click(screen.getByText(new RegExp('^VR_GUEST')));
    fireEvent.click(screen.getByText('连接'));
    await fake.status(status({ phase: 'online', ssid: 'VR_GUEST' }));

    await waitFor(() => expect(screen.getByText(/在电脑的工作台里登录一次/)).toBeTruthy());
    // 卡在第 5 步,不是第 1 步;那颗键重试的是「记账号」,选 Wi-Fi 那一步不重做。
    expect(screen.getByText('第 5 步,共 6 步')).toBeTruthy();
    expect(screen.getByRole('button', { name: /重试记账号/ })).toBeTruthy();
    expect(screen.queryByText(/正在找附近的座机/)).toBeNull();
  });

  it('★ 联系不上电脑:说的是「等电脑开着再点重试记账号」', async () => {
    const client = {
      json: async () => ({ ok: false as const, status: 0, kind: 'network' as const, error: '连不上工作台' }),
    } as unknown as Session['client'];
    const fake = fakeBle();
    mount(fake.ble, undefined, client);
    await fake.found([{ id: 'AA:BB', name: '工作台座机-9A4C' }]);
    fireEvent.click(screen.getByText('工作台座机-9A4C'));
    await waitFor(() => expect(fake.sent.length).toBe(2));
    await fake.networks([net()]);
    fireEvent.click(screen.getByText(new RegExp('^VR_GUEST')));
    fireEvent.click(screen.getByText('连接'));
    await fake.status(status({ phase: 'online', ssid: 'VR_GUEST' }));

    await waitFor(() => expect(screen.getByText(/联系不上你的电脑/)).toBeTruthy());
    expect(screen.getByText('第 5 步,共 6 步')).toBeTruthy();
  });

  it('座机说密码不对时,原样显示派写的那句人话', async () => {
    const fake = fakeBle();
    mount(fake.ble, fakeAccount(ACCOUNT));
    await fake.found([{ id: 'AA:BB', name: '工作台座机-9A4C' }]);
    fireEvent.click(screen.getByText('工作台座机-9A4C'));
    await waitFor(() => expect(fake.sent.length).toBe(2));
    await fake.networks([net()]);
    fireEvent.click(screen.getByText(new RegExp('^VR_GUEST')));
    fireEvent.click(screen.getByText('连接'));
    await fake.status(status({ error: 'bad_password', text: '密码不对。重新输一遍试试(注意大小写)' }));

    expect(screen.getByText('密码不对。重新输一遍试试(注意大小写)')).toBeTruthy();
    expect(screen.getByText('换个 Wi-Fi 或重输密码')).toBeTruthy();
  });
});

describe('一行 Wi-Fi 长什么样', () => {
  it('不显示 dBm,也不显示加密算法的名字', () => {
    const line = networkLine(net({ ssid: 'VR_GUEST', signal: 80 }));
    expect(line).toContain('VR_GUEST');
    expect(line).not.toMatch(/dBm|WPA/);
  });

  it('不要密码的网明写出来', () => {
    expect(networkLine(net({ security: '' }))).toContain('不要密码');
  });

  it('座机连着的那个标出来', () => {
    expect(networkLine(net({ inUse: true }))).toContain('座机连着');
  });
});
