import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { PairPage } from '../src/pairing/PairPage';
import type { DiscoveryCallbacks, DiscoveryHandle } from '../src/pairing/discovery';
import type { QrScannerProps } from '../src/pairing/QrScanner';

function fakeDiscover(script: (cb: DiscoveryCallbacks) => void) {
  return async (cb: DiscoveryCallbacks): Promise<DiscoveryHandle> => { script(cb); return { stop: async () => {} }; };
}

/** 假相机:一个按钮,点了就当扫到了给定文本。 */
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

const okClaim = () => vi.fn(async () => ({ ok: true as const, pairing: { token: 'T', host: '10.0.0.2', port: 8791, deviceId: 'd' } }));

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('配对页(扫码为主)', () => {
  it('首屏第一眼就是「扫码登录」大按钮,不等发现结束;没找到工作台时不显示列表、不弹说明', () => {
    render(<PairPage onPaired={() => {}} discover={fakeDiscover(() => {})} />);
    const btn = screen.getByRole('button', { name: '扫码登录' });
    expect(btn.className).toContain('ba-btn--big');
    expect(screen.queryByText('局域网里找到的工作台')).toBeNull();
    expect(screen.queryByText(/没找到/)).toBeNull();
    expect(screen.queryByText(/正在局域网里找/)).toBeNull();
  });

  it('点「扫码登录」直接开相机;扫到 workbench://pair?…&code 立刻 claim、进主页,全程不输一个字', async () => {
    const claim = okClaim();
    const onPaired = vi.fn();
    render(<PairPage onPaired={onPaired} claim={claim} discover={fakeDiscover(() => {})}
      scanner={fakeScanner('workbench://pair?host=10.0.0.2&port=8791&code=123456')} />);
    fireEvent.click(screen.getByRole('button', { name: '扫码登录' }));
    expect(screen.getByTestId('scanner')).toBeTruthy();
    await act(async () => { fireEvent.click(screen.getByText('假装扫到')); });
    expect(claim).toHaveBeenCalledWith(expect.objectContaining({ code: '123456', target: { host: '10.0.0.2', port: 8791 } }));
    expect(onPaired).toHaveBeenCalledWith({ token: 'T', host: '10.0.0.2', port: 8791, deviceId: 'd' });
  });

  it('扫码后 claim 失败 → 同屏显示服务端原话,可以重新扫码', async () => {
    const claim = vi.fn(async () => ({ ok: false as const, error: '配对码不对或已失效' }));
    render(<PairPage onPaired={() => {}} claim={claim} discover={fakeDiscover(() => {})}
      scanner={fakeScanner('workbench://pair?host=10.0.0.2&port=8791&code=111111')} />);
    fireEvent.click(screen.getByRole('button', { name: '扫码登录' }));
    await act(async () => { fireEvent.click(screen.getByText('假装扫到')); });
    expect(screen.getByRole('alert').textContent).toBe('配对码不对或已失效');
    expect(screen.getByText('工作台 10.0.0.2:8791')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '重新扫码' }));
    expect(screen.getByTestId('scanner')).toBeTruthy();
  });

  it('相机权限被拒 → 同屏给「手输 6 位码」:先选局域网里找到的工作台 → 输码 → claim', async () => {
    vi.stubGlobal('navigator', {
      ...navigator,
      mediaDevices: { getUserMedia: async () => { throw Object.assign(new Error('denied'), { name: 'NotAllowedError' }); } },
    });
    const claim = okClaim();
    const onPaired = vi.fn();
    render(<PairPage onPaired={onPaired} claim={claim} discover={fakeDiscover((cb) => cb.onFound({ name: '工作台 · Mac', host: '10.0.0.2', port: 8791 }))} />);
    fireEvent.click(await screen.findByRole('button', { name: '扫码登录' }));
    expect(await screen.findByText(/需要相机权限/)).toBeTruthy();
    expect(screen.getByText(/扫不了才用这个/)).toBeTruthy();
    fireEvent.click(screen.getByText('工作台 · Mac'));
    expect(screen.getByText('工作台 10.0.0.2:8791')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('配对码'), { target: { value: '123456' } });
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '配对' })); });
    expect(claim).toHaveBeenCalledWith(expect.objectContaining({ code: '123456', target: { host: '10.0.0.2', port: 8791 } }));
    expect(onPaired).toHaveBeenCalled();
  });

  it('相机打不开且局域网没找到 → 同屏「手输地址」→ 输码页', async () => {
    vi.stubGlobal('navigator', { ...navigator, mediaDevices: undefined });
    render(<PairPage onPaired={() => {}} discover={fakeDiscover(() => {})} />);
    fireEvent.click(screen.getByRole('button', { name: '扫码登录' }));
    expect(await screen.findByText(/打不开相机/)).toBeTruthy();
    expect(screen.queryByText('局域网里找到的工作台')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '手输地址' }));
    fireEvent.click(screen.getByText('下一步'));
    expect(screen.getByRole('alert').textContent).toContain('局域网地址');
    fireEvent.change(screen.getByLabelText('工作台地址'), { target: { value: '192.168.1.8' } });
    fireEvent.click(screen.getByText('下一步'));
    expect(screen.getByText('工作台 192.168.1.8:8791')).toBeTruthy();
  });

  it('扫到的不是工作台二维码 → 留在扫码屏说明,并给手输路径', async () => {
    render(<PairPage onPaired={() => {}} discover={fakeDiscover(() => {})} scanner={fakeScanner('https://example.com')} />);
    fireEvent.click(screen.getByRole('button', { name: '扫码登录' }));
    await act(async () => { fireEvent.click(screen.getByText('假装扫到')); });
    expect(screen.getByText(/不是工作台的配对二维码/)).toBeTruthy();
    expect(screen.getByRole('button', { name: '手输地址' })).toBeTruthy();
  });

  it('局域网里找到的工作台以小列表放在扫码按钮下方;点它进输码页(这条路必须要码)', async () => {
    render(<PairPage onPaired={() => {}} discover={fakeDiscover((cb) => cb.onFound({ name: '工作台 · Mac', host: '10.0.0.2', port: 8791 }))} />);
    expect(await screen.findByText('局域网里找到的工作台')).toBeTruthy();
    const page = screen.getByRole('button', { name: '扫码登录' }).parentElement!.parentElement!;
    const order = page.textContent!;
    expect(order.indexOf('扫码登录')).toBeLessThan(order.indexOf('局域网里找到的工作台'));
    fireEvent.click(screen.getByText('工作台 · Mac'));
    expect(screen.getByLabelText('配对码')).toBeTruthy();
  });

  it('深链带 code 直接 claim;失败 → 服务端那句话显示出来,还留在输码页', async () => {
    const claim = vi.fn(async () => ({ ok: false as const, error: '配对码不对或已失效' }));
    render(<PairPage onPaired={() => {}} claim={claim} incoming={{ host: '1.2.3.4', port: 8791, code: '111111' }} discover={fakeDiscover(() => {})} />);
    expect(await screen.findByText('配对码不对或已失效')).toBeTruthy();
    expect(screen.getByLabelText('配对码')).toBeTruthy();
  });

  it('顶部说明(令牌失效)原样显示', () => {
    render(<PairPage onPaired={() => {}} notice="设备令牌已失效:请重新配对" discover={fakeDiscover(() => {})} />);
    expect(screen.getByRole('status').textContent).toBe('设备令牌已失效:请重新配对');
  });
});

/** 2026-09-17「手机上也需要有登录」:这一页成了登录流程的第三屏,多了四件小事。 */
describe('配对页 · 登录流程要的几件事', () => {
  it('文案是登录语气', () => {
    render(<PairPage onPaired={() => {}} discover={fakeDiscover(() => {})} />);
    expect(screen.getByText('扫电脑上的配对码登录')).toBeTruthy();
  });

  it('autoScan:从指引屏一键进来时直接开相机,不用再点一次', () => {
    render(<PairPage onPaired={() => {}} autoScan discover={fakeDiscover(() => {})} scanner={fakeScanner('workbench://pair?host=10.0.0.2&port=8791&code=123456')} />);
    expect(screen.getByTestId('scanner')).toBeTruthy();
  });

  it('onBack:首屏多一颗「返回」,回欢迎屏', () => {
    const onBack = vi.fn();
    render(<PairPage onPaired={() => {}} onBack={onBack} discover={fakeDiscover(() => {})} />);
    fireEvent.click(screen.getByRole('button', { name: '返回' }));
    expect(onBack).toHaveBeenCalled();
  });

  it('局域网里发现过这台工作台的话,配对成功时把它的名字一起交出去', async () => {
    const claim = okClaim();
    const onPaired = vi.fn();
    render(<PairPage onPaired={onPaired} claim={claim} discover={fakeDiscover((cb) => cb.onFound({ name: '工作台 · Mac', host: '10.0.0.2', port: 8791 }))}
      scanner={fakeScanner('workbench://pair?host=10.0.0.2&port=8791&code=123456')} />);
    fireEvent.click(await screen.findByRole('button', { name: '扫码登录' }));
    await act(async () => { fireEvent.click(screen.getByText('假装扫到')); });
    expect(onPaired).toHaveBeenCalledWith({ token: 'T', host: '10.0.0.2', port: 8791, deviceId: 'd', workbenchName: '工作台 · Mac' });
  });
});
