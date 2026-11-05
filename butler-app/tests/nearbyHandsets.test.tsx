// 「附近有没有座机」(2026-09-30,维护者:「最好变成手机只要打开座机配置那个页面,就显示附近有没有座机」)。
//
// 现场:座机连着一个进不了房的网,房间那条路断了;手机要自己去点「添加座机」才开始扫,
// 他根本不知道座机其实就在旁边开着蓝牙等人。现在一打开「座机」那一页就扫一遍、把附近的列出来,
// 点一下就进添加那一页。扫不了(没权限 / 蓝牙关 / 定位关)就如实说哪个开关,不说「附近没有」。
import { act, render, screen, fireEvent } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { NearbyHandsets, NEARBY_SCAN_MS, NEARBY_NONE_TEXT } from '../src/handset/NearbyHandsets';
import { HandsetBleError, type HandsetBle } from '../src/handset/handsetBle';
import type { FoundHandset } from '../src/handset/provisionMachine';

function fakeBle(opts: { found?: FoundHandset[], fail?: string } = {}) {
  const stopScan = vi.fn(async () => {});
  const ble: HandsetBle = {
    scan: vi.fn(async (onFound: (devices: readonly FoundHandset[]) => void) => {
      if (opts.fail !== undefined) throw new HandsetBleError(opts.fail);
      if (opts.found !== undefined) onFound(opts.found);
    }),
    stopScan,
    connect: vi.fn(async () => {}),
    send: vi.fn(async () => {}),
    disconnect: vi.fn(async () => {}),
  };
  return { ble, stopScan };
}

describe('打开座机那一页就扫附近', () => {
  it('★扫到一台:写出它的名字,点一下就去添加', async () => {
    vi.useFakeTimers()
    const onAdd = vi.fn();
    const { ble } = fakeBle({ found: [{ id: 'AA', name: '工作台座机-4b4a', rssi: -52 }] });
    render(<NearbyHandsets ble={ble} onAdd={onAdd} />);
    await act(async () => { await Promise.resolve(); });
    expect(screen.getByText(/工作台座机-4b4a/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /配这台/ }));
    expect(onAdd).toHaveBeenCalled();
    vi.useRealTimers()
  });

  it('★扫满时限一台都没有:说附近没有,并且停扫(不一直开着耗电)', async () => {
    vi.useFakeTimers()
    const { ble, stopScan } = fakeBle({ found: [] });
    render(<NearbyHandsets ble={ble} onAdd={() => {}} />);
    await act(async () => { await Promise.resolve(); });
    await act(async () => { vi.advanceTimersByTime(NEARBY_SCAN_MS); });
    expect(screen.getByText(NEARBY_NONE_TEXT)).toBeTruthy();
    expect(stopScan).toHaveBeenCalled();
    vi.useRealTimers()
  });

  it('扫不了(定位关着):原样说是哪个开关,不说「附近没有」', async () => {
    const { ble } = fakeBle({ fail: '这台手机的系统「位置信息」关着' });
    render(<NearbyHandsets ble={ble} onAdd={() => {}} />);
    await act(async () => { await Promise.resolve(); });
    expect(screen.getByText(/位置信息/)).toBeTruthy();
    expect(screen.queryByText(NEARBY_NONE_TEXT)).toBeNull();
  });

  it('离开这一页就停扫', async () => {
    const { ble, stopScan } = fakeBle({ found: [] });
    const view = render(<NearbyHandsets ble={ble} onAdd={() => {}} />);
    await act(async () => { await Promise.resolve(); });
    view.unmount();
    expect(stopScan).toHaveBeenCalled();
  });
});
