/**
 * 登录第一屏(2026-09-17,Ben:「手机上也需要有登录」)。
 * 没有账号体系,登录 = 确认电脑端就绪 → 配对 → 引导。这里钉住三屏之间怎么走。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { LoginPage } from '../src/login/LoginPage';
import { DESKTOP_DOWNLOAD_URL } from '../src/login/loginModel';
import type { DiscoveryCallbacks, DiscoveryHandle } from '../src/pairing/discovery';
import type { QrScannerProps } from '../src/pairing/QrScanner';

function fakeDiscover(script: (cb: DiscoveryCallbacks) => void) {
  return async (cb: DiscoveryCallbacks): Promise<DiscoveryHandle> => { script(cb); return { stop: async () => {} }; };
}

function fakeScanner(text: string) {
  return function FakeScanner({ onResult, onCancel }: QrScannerProps) {
    return (
      <div data-testid="scanner">
        <button type="button" onClick={() => onResult(text)}>假装扫到</button>
        <button type="button" onClick={onCancel}>取消</button>
      </div>
    );
  };
}

const air = { name: '工作台 · air', host: '10.0.0.2', port: 8791 };

afterEach(() => { vi.useRealTimers(); });

describe('登录 · 欢迎屏', () => {
  it('没配过就是欢迎屏:粒子黑洞(2026-09-23 品牌视觉,不是她的球)+ 一句话 + 「电脑端装好了吗?」两个按钮', () => {
    render(<LoginPage onPaired={() => {}} discover={fakeDiscover(() => {})} />);
    expect(document.querySelector('.ba-login__hero .ba-brand-hero')).toBeTruthy();
    // 她的球不在欢迎屏上:配对 / 登录成功那一下才从黑洞里飞出来
    expect(document.querySelector('.ba-particles, .ba-orb')).toBeNull();
    expect(screen.getByText('电脑端装好了吗?')).toBeTruthy();
    expect(screen.getByRole('button', { name: '装好了,去配对' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '还没有' })).toBeTruthy();
    // 欢迎屏不出扫码页的东西
    expect(screen.queryByRole('button', { name: '扫码登录' })).toBeNull();
  });

  it('回到这一屏的原因(退出登录 / 令牌被撤销)显示在欢迎屏上,是一句人话', () => {
    render(<LoginPage onPaired={() => {}} notice="登录失效了" discover={fakeDiscover(() => {})} />);
    expect(screen.getByText('登录失效了')).toBeTruthy();
  });

  it('每一屏都有那盏灯:没找到电脑时说没找到', async () => {
    vi.useFakeTimers();
    render(<LoginPage onPaired={() => {}} discover={fakeDiscover((cb) => cb.onUnavailable('web'))} />);
    await act(async () => { await vi.advanceTimersByTimeAsync(9000); });
    expect(screen.getByText('电脑:没找到')).toBeTruthy();
  });

  it('局域网里找到了 → 灯变「找到了」', async () => {
    render(<LoginPage onPaired={() => {}} discover={fakeDiscover((cb) => cb.onFound(air))} />);
    expect(await screen.findByText('电脑:找到了')).toBeTruthy();
  });
});

describe('登录 · 「还没有」指引屏', () => {
  it('说清手机要连着电脑上的工作台,并给出电脑端的获取方式(链接 + 二维码)', () => {
    render(<LoginPage onPaired={() => {}} discover={fakeDiscover(() => {})} />);
    fireEvent.click(screen.getByRole('button', { name: '还没有' }));
    expect(screen.getByText(/手机上的事务官,要连着电脑上的工作台才能用/)).toBeTruthy();
    const link = screen.getByRole('link', { name: DESKTOP_DOWNLOAD_URL }) as HTMLAnchorElement;
    expect(link.href).toBe(DESKTOP_DOWNLOAD_URL);
    expect(screen.getByRole('img', { name: '电脑端下载二维码' })).toBeTruthy();
    // 还在找电脑
    expect(screen.getByText('电脑:还在找…')).toBeTruthy();
  });

  it('底部一直在自动找电脑:找到了就说找到了哪一台、下一步去电脑上做什么,并能一键进扫码', async () => {
    render(<LoginPage onPaired={() => {}} discover={fakeDiscover((cb) => cb.onFound(air))} scanner={fakeScanner('workbench://pair?host=10.0.0.2&port=8791&code=123456')} />);
    fireEvent.click(screen.getByRole('button', { name: '还没有' }));
    expect(await screen.findByText('找到「工作台 · air」,去电脑上生成配对码')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '去扫码' }));
    expect(screen.getByTestId('scanner')).toBeTruthy();
  });

  it('可以回欢迎屏', () => {
    render(<LoginPage onPaired={() => {}} discover={fakeDiscover(() => {})} />);
    fireEvent.click(screen.getByRole('button', { name: '还没有' }));
    fireEvent.click(screen.getByRole('button', { name: '返回' }));
    expect(screen.getByText('电脑端装好了吗?')).toBeTruthy();
  });
});

describe('登录 · 「装好了」去配对', () => {
  it('进的是现在那张扫码页,文案是登录语气', () => {
    render(<LoginPage onPaired={() => {}} discover={fakeDiscover(() => {})} />);
    fireEvent.click(screen.getByRole('button', { name: '装好了,去配对' }));
    expect(screen.getByText('扫电脑上的配对码登录')).toBeTruthy();
    expect(screen.getByRole('button', { name: '扫码登录' })).toBeTruthy();
  });

  it('配对成功把工作台的名字一起记下来(以后顶上显示「已登录:工作台 · xxx」)', async () => {
    const onPaired = vi.fn();
    const claim = vi.fn(async () => ({ ok: true as const, pairing: { token: 'T', host: '10.0.0.2', port: 8791, deviceId: 'd' } }));
    render(<LoginPage onPaired={onPaired} claim={claim} discover={fakeDiscover((cb) => cb.onFound(air))}
      scanner={fakeScanner('workbench://pair?host=10.0.0.2&port=8791&code=123456')} />);
    fireEvent.click(screen.getByRole('button', { name: '装好了,去配对' }));
    fireEvent.click(await screen.findByRole('button', { name: '扫码登录' }));
    await act(async () => { fireEvent.click(screen.getByText('假装扫到')); });
    expect(onPaired).toHaveBeenCalledWith({ token: 'T', host: '10.0.0.2', port: 8791, deviceId: 'd', workbenchName: '工作台 · air' });
  });

  it('深链(扫了别处的码 / 冷启动带进来的)直接去配对,不停在欢迎屏', async () => {
    const claim = vi.fn(async () => ({ ok: true as const, pairing: { token: 'T', host: '10.0.0.5', port: 8791, deviceId: 'd' } }));
    const onPaired = vi.fn();
    render(<LoginPage onPaired={onPaired} claim={claim} discover={fakeDiscover(() => {})} incoming={{ host: '10.0.0.5', port: 8791, code: '123456' }} />);
    await act(async () => {});
    expect(screen.queryByText('电脑端装好了吗?')).toBeNull();
    expect(onPaired).toHaveBeenCalled();
  });
});

describe('没接中转的手机包(局域网 M4 / M7:开源构建中转地址缺省为空)', () => {
  const accountStore = {
    load: async () => null, save: async () => {}, setDeviceToken: async () => {}, link: async () => {}, clear: async () => {},
  };

  it('「用账号登录」那条路不出现:没有中转,账号无处可登', () => {
    render(<LoginPage onPaired={() => {}} onAccountLoggedIn={() => {}} accountStore={accountStore} relayUrl="" discover={fakeDiscover(() => {})} />);
    expect(screen.queryByRole('button', { name: '用账号登录' })).toBeNull();
  });

  it('有中转地址时照旧出现', () => {
    render(<LoginPage onPaired={() => {}} onAccountLoggedIn={() => {}} accountStore={accountStore} relayUrl="https://relay.example" discover={fakeDiscover(() => {})} />);
    expect(screen.getByRole('button', { name: '用账号登录' })).toBeTruthy();
  });
});
