/**
 * 在家 / 出门那两句给她看的(局域网 M4):问「这是你常用的网络吗」、断了一通后「点一下回拨」;设置页那一节。
 */
import { describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { RouteBanner, RouteSectionBody } from '../src/channel/RouteBanner';
import type { RouteView } from '../src/channel/routeDriver';

function view(patch: Partial<RouteView> = {}): RouteView {
  return {
    route: 'cloud', deciding: false, joined: 'cloud', http: null, notice: null,
    network: { kind: 'wifi', id: 'lan:192.168.9.1/24', label: '网关 192.168.9.1' }, trusted: false,
    asking: null, localNetwork: 'granted', hasRelay: true, relayConfigured: true, macName: null, revoked: false,
    ...patch,
  };
}

function fakeRoute(initial: RouteView) {
  let current = initial;
  const listeners = new Set<() => void>();
  const dropped = new Set<(id: string | null) => void>();
  const answers: boolean[] = [];
  return {
    answers,
    set(next: RouteView) { current = next; for (const l of [...listeners]) l(); },
    drop() { for (const l of [...dropped]) l('c1'); },
    route: {
      driver: {
        view: () => current,
        subscribe: (l: () => void) => { listeners.add(l); return () => listeners.delete(l); },
        answerHomeNetwork: (yes: boolean) => { answers.push(yes); },
      } as never,
      onCallDropped: (l: (id: string | null) => void) => { dropped.add(l); return () => dropped.delete(l); },
    },
  };
}

describe('首页顶上那条', () => {
  it('平时什么都不出', () => {
    const f = fakeRoute(view());
    const { container } = render(<RouteBanner route={f.route} onCallBack={() => {}} />);
    expect(container.textContent).toBe('');
  });

  it('看到配对过的那台:问一句,答了交给驱动', () => {
    const f = fakeRoute(view({ asking: { network_id: 'lan:192.168.9.1/24', label: '网关 192.168.9.1', mac_name: '工作台 · Air' } }));
    render(<RouteBanner route={f.route} onCallBack={() => {}} />);
    expect(screen.getByRole('dialog').textContent).toContain('「工作台 · Air」');
    fireEvent.click(screen.getByRole('button', { name: '是,常用网络' }));
    expect(f.answers).toEqual([true]);
  });

  it('通话中换了网络:说这一通断了,点「回拨」就回首页开一通', () => {
    const f = fakeRoute(view());
    const callBack = vi.fn();
    render(<RouteBanner route={f.route} onCallBack={callBack} />);
    act(() => { f.drop(); });
    expect(screen.getByRole('status').textContent).toContain('换了网络,这一通断了');
    fireEvent.click(screen.getByRole('button', { name: '回拨' }));
    expect(callBack).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('status')).toBeNull();
  });
});

describe('设置 → 在家 / 出门', () => {
  it('在家:标题 + 原因', () => {
    render(<RouteSectionBody view={view({ route: 'lan', joined: 'lan', trusted: true, macName: '工作台 · Air' })} onMark={() => {}} />);
    expect(screen.getByText('此刻:在家(本机房间)')).toBeTruthy();
    expect(screen.getByText(/本机房间,来电和说话都不经云/)).toBeTruthy();
    expect(screen.getByRole('button', { name: '这个网络不再算常用' })).toBeTruthy();
  });

  it('没确认的 Wi-Fi:出门(云),原因一行,能自己点「这是我常用的网络」', () => {
    const marks: boolean[] = [];
    render(<RouteSectionBody view={view()} onMark={(yes) => marks.push(yes)} />);
    expect(screen.getByText('此刻:出门(云)')).toBeTruthy();
    expect(screen.getByText(/还没确认是你常用的网络/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '这是我常用的网络' }));
    expect(marks).toEqual([true]);
  });

  it('本地网络权限被拒:说去哪儿打开', () => {
    render(<RouteSectionBody view={view({ localNetwork: 'denied', network: { kind: 'wifi', id: null } })} onMark={() => {}} />);
    expect(screen.getByText(/打开「附近的设备」/)).toBeTruthy();
  });

  it('零服务器档出了门:没连上,这台没接中转', () => {
    render(<RouteSectionBody view={view({ route: 'none', joined: null, notice: 'no_way_out', hasRelay: false, relayConfigured: false, network: { kind: 'cellular', id: null } })} onMark={() => {}} />);
    expect(screen.getByText('此刻:没连上')).toBeTruthy();
    expect(screen.getByText(/这台没接中转/)).toBeTruthy();
  });
});
